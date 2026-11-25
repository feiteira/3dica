// §3.1 + §5.4 — the evaluation engine. PURE: no DOM, no Worker, no three. Runs inside eval/worker.ts and in Node (vitest).
//
// User code is a function body compiled as
//   new Function('params', 'part', 'jscad', 'Math', ...SHADOWED, ...FLAT_NAMES, '"use strict";\n' + code)
// Every exception is wrapped ONCE, at the innermost def being evaluated, into an EvalFailure and then rethrown unchanged
// through the outer part() calls, so error.def is the def whose code actually failed and error.trace lists the def
// names from the job root down to it.
// OpenSCAD code (CodeSpec.lang 'openscad') is never compiled: src/openscad interprets it (runScad, handed in with
// setScad), with part() and the geometry budget wired to the same memo and limits.
import jscad from '@jscad/modeling'
import stlSerializer from '@jscad/stl-serializer'
import type { Geom3 } from '@jscad/modeling/src/geometries/types'
import type { Id, Mat4, ParamDef, ParamValue } from '../core/types'
import type { CodeSpec, DefSpec, GroupSpec, Job } from '../core/evalspec'
import type { ConsoleLine, EvalError, MeshData } from './protocol'
import type { RunScad, ScadMessage, SourcePos } from '../openscad/types'
// the error class only (types.ts has no other runtime code); the interpreter itself is handed in with setScad()
import { ScadError } from '../openscad/types'
import { hash, mulberry32, seedFromKey } from '../core/hash'
import { isValidParamValue, resolveParamDefs, unknownParamKeys } from '../core/params'
import { choiceOption } from '../openscad/customizer'
import { identity, matricesClose } from '../core/transform'

// ───────────────────────────── scope (§3.1) ─────────────────────────────

/** Namespaces flattened into the code scope, in this order (93 names, no collisions [verified]). */
export const FLAT_NAMESPACES = ['primitives', 'booleans', 'transforms', 'extrusions', 'hulls', 'expansions', 'colors', 'measurements', 'text', 'utils', 'curves'] as const
/** Shadowed as `undefined` in user code. Hygiene, not a sandbox. */
export const SHADOWED = ['self', 'globalThis', 'postMessage', 'importScripts', 'fetch', 'XMLHttpRequest', 'WebSocket'] as const
const FIXED_PARAMS = ['params', 'part', 'jscad', 'Math'] as const

export const MAX_DEPTH = 64
export const MAX_TRIANGLES = 2_000_000
export const COMPILE_CACHE_MAX = 100
export const MEMO_MAX = 200
/**
 * The memo is also bounded by size: the sum of polygon vertices of the memoized results (a 512-segment sphere is
 * about 520k). Without it, editing a detailed object keeps ~80 MB per result alive and the worker eventually runs
 * the whole tab out of memory.
 */
export const MEMO_MAX_VERTICES = 2_000_000
/**
 * Geometry a single evaluation may CREATE (primitives, extrusions, hulls, expansions), in polygons. A worker that
 * runs out of memory takes the whole tab down before the timeout or the triangle cap can act, so a runaway loop
 * (`for (…; i--) out.push(sphere())`) has to be stopped while it is still allocating.
 */
export const MAX_SOURCE_POLYGONS = 2_000_000

// ───────────────────────────── geometry guards (out-of-memory protection) ─────────────────────────────

/** Namespaces whose functions allocate new polygons; their results count towards MAX_SOURCE_POLYGONS. */
const CREATING_NAMESPACES = new Set(['primitives', 'extrusions', 'hulls', 'expansions'])

type Opts = Record<string, unknown>
const num = (o: Opts, k: string, dflt: number): number => {
  const v = o[k]
  return typeof v === 'number' && Number.isFinite(v) ? Math.abs(v) : dflt
}
/** sides / points of a 2D argument (extrusions), 0 when unknown */
const outlineSize = (g: unknown): number => {
  if (!g || typeof g !== 'object') return 0
  const o = g as { sides?: unknown[]; points?: unknown[]; outlines?: unknown[][] }
  return Array.isArray(o.sides) ? o.sides.length : Array.isArray(o.points) ? o.points.length : 0
}
const segs = (s: number, what = 'segments') => `${what} ${thousands(Math.round(s))}`

/**
 * A lower estimate of the polygons (points for 2D shapes) a creating call will make, from its arguments alone — so a
 * huge `segments` is refused before jscad allocates it. null when the call is not estimated.
 * Calibrated on jscad 2.13: sphere/ellipsoid/roundedCuboid/roundedCylinder ≈ s²/2, cylinder 3s, torus 2·i·o,
 * geodesicSphere 20·(f/6)², circle/ellipse/arc s points.
 */
export function estimatePolygons(name: string, args: unknown[]): { n: number; what: string } | null {
  const o = (args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : {}) as Opts
  switch (name) {
    case 'sphere': case 'ellipsoid': case 'roundedCuboid': case 'roundedCylinder': {
      const s = num(o, 'segments', 32)
      return { n: (s * s) / 2, what: segs(s) }
    }
    case 'cylinder': case 'cylinderElliptic': {
      const s = num(o, 'segments', 32)
      return { n: 3 * s, what: segs(s) }
    }
    case 'torus': {
      const i = num(o, 'innerSegments', 32), x = num(o, 'outerSegments', 32)
      return { n: 2 * i * x, what: `innerSegments ${thousands(Math.round(i))} × outerSegments ${thousands(Math.round(x))}` }
    }
    case 'geodesicSphere': {
      const f = num(o, 'frequency', 6)
      return { n: 20 * (f / 6) * (f / 6), what: segs(f, 'frequency') }
    }
    case 'circle': case 'ellipse': case 'arc': case 'roundedRectangle': {
      const s = num(o, 'segments', 32)
      return { n: s, what: segs(s) }
    }
    case 'extrudeLinear': {
      const steps = num(o, 'twistSteps', 1)
      return { n: steps * Math.max(1, ...args.slice(1).map(outlineSize)), what: segs(steps, 'twistSteps') }
    }
    case 'extrudeRotate': {
      const s = num(o, 'segments', 12)
      return { n: s * Math.max(1, ...args.slice(1).map(outlineSize)), what: segs(s) }
    }
    case 'extrudeHelical': {
      const per = num(o, 'segmentsPerRotation', 32), turns = num(o, 'angle', 4 * Math.PI) / (2 * Math.PI)
      return { n: per * turns * Math.max(1, ...args.slice(1).map(outlineSize)), what: segs(per, 'segmentsPerRotation') }
    }
  }
  return null
}

/** Polygons of 3D results (sides of 2D ones) in a returned value. */
function polygonCount(r: unknown, depth = 0): number {
  if (!r || typeof r !== 'object' || depth > 4) return 0
  if (Array.isArray(r)) { let n = 0; for (const x of r) n += polygonCount(x, depth + 1); return n }
  const o = r as { polygons?: unknown[]; sides?: unknown[] }
  return Array.isArray(o.polygons) ? o.polygons.length : Array.isArray(o.sides) ? o.sides.length : 0
}

/** Per evaluation (reset by the engine for every job / STL item): polygons created so far. */
const budget = { created: 0 }

function guarded(name: string, fn: (...a: unknown[]) => unknown): (...a: unknown[]) => unknown {
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    const est = estimatePolygons(name, args)
    if (est && est.n > MAX_TRIANGLES) {
      const param = /frequency|twistSteps|segmentsPerRotation/.exec(est.what)?.[0] ?? 'segments'
      throw new Error(`Too much geometry: ${name} with ${est.what} makes about ${thousands(Math.round(est.n))} polygons (the limit is ${thousands(MAX_TRIANGLES)} triangles) — lower the ${param}`)
    }
    const r = fn.apply(this, args)
    budget.created += polygonCount(r)
    if (budget.created > MAX_SOURCE_POLYGONS) {
      throw new Error(`Too much geometry: this code made more than ${thousands(MAX_SOURCE_POLYGONS)} polygons (a loop that never ends?) — stopped before the page runs out of memory`)
    }
    return r
  }
  Object.defineProperty(wrapped, 'name', { value: name })
  return wrapped
}

/** The library handed to user code: creating functions are guarded (also when reached as jscad.primitives.x). */
const LIB: Record<string, Record<string, unknown>> = (() => {
  const src = jscad as unknown as Record<string, Record<string, unknown>>
  const out: Record<string, Record<string, unknown>> = { ...src }
  for (const ns of CREATING_NAMESPACES) {
    const copy: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(src[ns] ?? {})) copy[k] = typeof v === 'function' ? guarded(k, v as (...a: unknown[]) => unknown) : v
    out[ns] = copy
  }
  return out
})()

const flatEntries: [string, unknown][] = []
{
  const taken = new Set<string>([...FIXED_PARAMS, ...SHADOWED])
  for (const ns of FLAT_NAMESPACES) {
    for (const [k, v] of Object.entries(LIB[ns] ?? {})) {
      if (taken.has(k)) continue // never happens with jscad 2.13; a duplicate parameter would be a SyntaxError
      taken.add(k)
      flatEntries.push([k, v])
    }
  }
}
/** Every flattened jscad name, computed once at module (= worker) start. */
export const FLAT_NAMES: readonly string[] = flatEntries.map(([k]) => k)
const FLAT_VALUES: readonly unknown[] = flatEntries.map(([, v]) => v)
const PARAM_LIST: readonly string[] = [...FIXED_PARAMS, ...SHADOWED, ...FLAT_NAMES]
const SCOPE_NAMES = new Set(PARAM_LIST)
/** Arguments after (params, part, jscad, Math): the shadows, then the flattened values. */
const TAIL_ARGS: readonly unknown[] = [...SHADOWED.map(() => undefined), ...FLAT_VALUES]
const PRELUDE = '"use strict";\n'

const ANON_FRAME = /<anonymous>:(\d+):(\d+)/

type UserFn = (...args: unknown[]) => unknown
type JMat4 = Parameters<typeof jscad.transforms.transform>[0]

const { geom2, geom3, path2, poly3 } = jscad.geometries
const { union, subtract, intersect } = jscad.booleans
const IDENTITY = identity()

function compileRaw(code: string): UserFn {
  return new Function(...PARAM_LIST, PRELUDE + code) as UserFn
}

// ───────────────────────────── errors ─────────────────────────────

/** An evaluation failure that already names the innermost failing def. Rethrown unchanged through outer part() calls. */
export class EvalFailure extends Error {
  readonly error: EvalError
  constructor(error: EvalError) {
    super(error.message)
    this.name = 'EvalFailure'
    this.error = error
  }
}

/** Any thrown value → EvalError (EvalFailure as is; anything else is a runtime error of `root`, without a line). */
export function toEvalError(x: unknown, root: { def: Id; name: string }): EvalError {
  if (x instanceof EvalFailure) return x.error
  return { kind: 'runtime', def: root.def, defName: root.name, message: clip(errorMessage(x)), trace: [root.name] }
}

function errorMessage(x: unknown): string {
  if (x instanceof Error) {
    const name = x.name && x.name !== 'Error' ? x.name + ': ' : ''
    return name + (x.message || String(x))
  }
  try { return String(x) } catch { return 'Unknown error' }
}

function stackOf(x: unknown): string {
  try { return x instanceof Error ? String(x.stack ?? '') : '' } catch { return '' }
}

const stackLimitHost = Error as unknown as { stackTraceLimit?: number }

function plural(n: number, one: string, many = one + 's'): string { return n === 1 ? one : many }
function thousands(n: number): string { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') }

function describeValue(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  const t = typeof v
  if (t !== 'object') return t
  const ctor = (Object.getPrototypeOf(v) as { constructor?: { name?: string } } | null)?.constructor?.name
  return ctor && ctor !== 'Object' ? ctor : 'object'
}

function typeDescription(pd: ParamDef): string {
  if (pd.type === 'number') return 'a finite number'
  if (pd.type === 'boolean') return 'true or false'
  return 'one of ' + (pd.options ?? []).map((o) => JSON.stringify(o)).join(', ')
}

function unique(list: string[]): string[] { return [...new Set(list)] }

// ───────────────────────────── OpenSCAD console ─────────────────────────────

/** Lines kept per result (the interpreter already shortens a huge echo). */
export const MAX_CONSOLE_LINES = 1000
/** Longest echo line passed on, and longest warning, error or other message: texts built from the model's data can
 *  be huge (a 3-line file made a 50 MB assert message), and they end up in the page, the Output panel and MCP. */
const MAX_ECHO_CHARS = 100_000
export const MAX_MESSAGE_CHARS = 10_000
const clip = (s: string, max = MAX_MESSAGE_CHARS): string => (s.length > max ? s.slice(0, max) + ' … (cut)' : s)
/** The interpreter's note about the console lines it did not keep (src/openscad/interp.ts, noteDropped). */
const DROPPED_NOTE = /^([\d,]+) more console lines were not kept\b/
const droppedBy = (m: ScadMessage): number => {
  const n = m.level === 'warning' && !m.pos ? DROPPED_NOTE.exec(m.text) : null
  return n ? Number(n[1].replace(/,/g, '')) : -1
}
/** OpenSCAD warnings repeated in the result's warnings (the status line, MCP reports); all of them are in the console. */
const MAX_SCAD_WARNINGS = 20

/** A thrown ScadError, also one from another copy of the class (the interpreter is loaded separately). */
function isScadError(x: unknown): x is ScadError {
  return x instanceof Error && x.name === 'ScadError' && typeof (x as { kind?: unknown }).kind === 'string'
}

function posFields(pos?: SourcePos): Pick<ConsoleLine, 'line' | 'col' | 'file'> {
  if (!pos) return {}
  const o: Pick<ConsoleLine, 'line' | 'col' | 'file'> = { line: pos.line, col: pos.col }
  if (pos.file) o.file = pos.file
  return o
}

function consoleLines(messages: readonly ScadMessage[] | undefined): ConsoleLine[] {
  const out: ConsoleLine[] = []
  // one count of what was left out: the lines past MAX_CONSOLE_LINES plus those the interpreter did not keep
  let hidden = 0
  for (const m of messages ?? []) {
    const dropped = droppedBy(m)
    if (dropped >= 0) { hidden += dropped; continue }
    if (out.length >= MAX_CONSOLE_LINES) { hidden++; continue }
    const echo = m.level === 'echo'
    out.push({ level: echo ? 'echo' : 'warning', text: clip(String(m.text), echo ? MAX_ECHO_CHARS : MAX_MESSAGE_CHARS), ...posFields(m.pos) })
  }
  if (hidden) out.push({ level: 'warning', text: `… ${thousands(hidden)} more lines not shown (the limit is ${thousands(MAX_CONSOLE_LINES)})` })
  return out
}

/** "text (line 4)" / "text (lib/gear.scad:4)" */
function located(text: string, pos?: SourcePos): string {
  if (!pos) return text
  return `${text} (${pos.file ? `${pos.file}:${pos.line}` : `line ${pos.line}`})`
}

function scadHint(what: string): string {
  return what.includes('$fn') ? ' — lower $fn' : what.includes('$fa') || what.includes('$fs') ? ' — raise $fa / $fs' : ''
}

// ───────────────────────────── geometry → arrays (verified geom3ToArrays + bbox) ─────────────────────────────

type Poly = ReturnType<typeof geom3.toPolygons>[number]

function countTriangles(polys: Poly[]): number {
  let n = 0
  for (const p of polys) if (p.vertices.length >= 3) n += p.vertices.length - 2
  return n
}

/** Fan-triangulates `polys` (already transformed by toPolygons) into non-indexed arrays; throws on a non-finite position. */
function polysToMesh(polys: Poly[], color: unknown, fail: (message: string) => EvalFailure): MeshData | null {
  const tri = countTriangles(polys)
  if (tri === 0) return null
  const positions = new Float32Array(tri * 9)
  const normals = new Float32Array(tri * 9)
  let o = 0
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
  const put = (q: readonly number[], nx: number, ny: number, nz: number) => {
    const x = q[0], y = q[1], z = q[2]
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw fail('Result has invalid vertex positions (NaN or Infinity)')
    positions[o] = x; positions[o + 1] = y; positions[o + 2] = z
    normals[o] = nx; normals[o + 1] = ny; normals[o + 2] = nz
    // bbox of the float32 values actually sent, so it always contains the geometry
    const fx = positions[o], fy = positions[o + 1], fz = positions[o + 2]
    if (fx < x0) x0 = fx; if (fx > x1) x1 = fx
    if (fy < y0) y0 = fy; if (fy > y1) y1 = fy
    if (fz < z0) z0 = fz; if (fz > z1) z1 = fz
    o += 3
  }
  for (const p of polys) {
    const v = p.vertices
    if (v.length < 3) continue
    const pl = poly3.plane(p) // [nx, ny, nz, w], unit normal
    let nx = pl[0], ny = pl[1], nz = pl[2]
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) { nx = 0; ny = 0; nz = 1 } // degenerate polygon
    for (let i = 1; i < v.length - 1; i++) {
      put(v[0], nx, ny, nz)
      put(v[i], nx, ny, nz)
      put(v[i + 1], nx, ny, nz)
    }
  }
  const mesh: MeshData = { positions, normals, bbox: [[x0, y0, z0], [x1, y1, z1]] }
  if (Array.isArray(color) && color.length >= 3 && color.every((c) => typeof c === 'number')) {
    mesh.color = [color[0], color[1], color[2], color.length > 3 ? color[3] : 1]
  }
  return mesh
}

/** Triangle count of a binary STL given as its 'blobable' parts (header 80 bytes, then uint32 LE count). */
export function stlTriangleCount(parts: ArrayBuffer[]): number {
  const head = new Uint8Array(84)
  let off = 0
  for (const p of parts) {
    if (off >= 84) break
    const b = new Uint8Array(p, 0, Math.min(p.byteLength, 84 - off))
    head.set(b, off)
    off += b.length
  }
  return off < 84 ? 0 : new DataView(head.buffer).getUint32(80, true)
}

// ───────────────────────────── the engine (§5.4) ─────────────────────────────

interface MemoEntry {
  geoms: Geom3[]; warnings: string[]; /** polygon vertices (memo size budget) */ cost: number
  /** OpenSCAD code: its console output (echo, warnings) */
  console?: ConsoleLine[]
}

/** Sum of polygon vertices of `geoms` (an estimate of their memory; transformed copies count again). */
function vertexCost(geoms: Geom3[]): number {
  let n = 0
  for (const g of geoms) for (const p of (g as unknown as { polygons?: { vertices: unknown[] }[] }).polygons ?? []) n += p.vertices.length
  return n
}

export interface EngineOptions {
  /** memo size budget in polygon vertices (default MEMO_MAX_VERTICES) */
  memoMaxVertices?: number
  /** the OpenSCAD runtime (src/openscad runScad); the worker loads it on first use and hands it in with setScad */
  scad?: RunScad
}

export interface EngineStats { compiled: number; memo: number; hits: number; misses: number }

export interface Engine {
  /** V8 line offset of the compiled wrapper (3): user line = stack line − lineOffset */
  lineOffset: number
  /** Geometry of `spec` with `params` in the def's own local coordinates; throws EvalFailure. Returns a fresh array. */
  evaluate(spec: DefSpec, params: Record<string, ParamValue>): Geom3[]
  /** evaluate + validate + toMeshes (console: an OpenSCAD job's echo / warning output) */
  run(job: Job): { meshes: MeshData[]; tris: number; warnings: string[]; console?: ConsoleLine[] }
  /** Binary STL of every item's geometry transformed by its matrix (solids are not unioned). */
  stl(items: { job: Job; matrix: Mat4 }[]): { parts: ArrayBuffer[]; tris: number }
  stats(): EngineStats
  /** Install the OpenSCAD runtime (OpenSCAD specs fail with a runtime error until then). */
  setScad(run: RunScad): void
  hasScad(): boolean
}

/** Whether evaluating `spec` runs OpenSCAD code anywhere (itself, a part() dependency or a group child). */
export function usesScad(spec: DefSpec, seen = new Set<string>()): boolean {
  if (seen.has(spec.defKey)) return false
  seen.add(spec.defKey)
  if (spec.kind === 'code') return spec.lang === 'openscad' || Object.values(spec.deps).some((d) => usesScad(d, seen))
  return spec.children.some((c) => usesScad(c.spec, seen))
}

export function createEngine(opts: EngineOptions = {}): Engine {
  const memoMaxVertices = opts.memoMaxVertices ?? MEMO_MAX_VERTICES
  let runScad: RunScad | undefined = opts.scad
  /** code → compiled function, LRU (Map insertion order = recency) */
  const compiled = new Map<string, UserFn>()
  /** hash([defKey, params]) → result, LRU by count (MEMO_MAX) and by size (memoMaxVertices) */
  const results = new Map<string, MemoEntry>()
  let memoCost = 0
  let hits = 0
  let misses = 0
  /** the eval stack: specs from the job root to the one being evaluated */
  const stack: DefSpec[] = []

  const lruGet = <V>(m: Map<string, V>, k: string): V | undefined => {
    const v = m.get(k)
    if (v !== undefined) { m.delete(k); m.set(k, v) }
    return v
  }
  const lruSet = <V>(m: Map<string, V>, k: string, v: V, cap: number) => {
    m.delete(k)
    m.set(k, v)
    while (m.size > cap) m.delete(m.keys().next().value as string)
  }

  /** memo insert; evicts least recently used entries beyond MEMO_MAX or the size budget (the newest one always stays) */
  const memoSet = (k: string, v: MemoEntry) => {
    const old = results.get(k)
    if (old) { memoCost -= old.cost; results.delete(k) }
    results.set(k, v)
    memoCost += v.cost
    while (results.size > MEMO_MAX || (memoCost > memoMaxVertices && results.size > 1)) {
      const [oldest, e] = results.entries().next().value as [string, MemoEntry]
      results.delete(oldest)
      memoCost -= e.cost
    }
  }

  const probeArgs = (): unknown[] => [{}, () => [], LIB, Math, ...TAIL_ARGS]
  const lineOffset = (() => {
    try { compileRaw('throw new Error("__probe")')(...probeArgs()) } catch (e) {
      const m = ANON_FRAME.exec(stackOf(e))
      if (m) return Number(m[1]) - 1
    }
    return 3
  })()

  const failure = (kind: EvalError['kind'], spec: DefSpec, message: string, at?: { line?: number; col?: number }): EvalFailure => {
    const trace = stack.map((s) => s.name)
    if (stack[stack.length - 1] !== spec) trace.push(spec.name) // result checks run after the spec left the stack
    const e: EvalError = { kind, def: spec.def, defName: spec.name, message: clip(message), trace }
    if (at?.line !== undefined && at.line >= 1) { e.line = at.line; if (at.col !== undefined) e.col = at.col }
    return new EvalFailure(e)
  }

  const runtimeFailure = (spec: DefSpec, x: unknown): EvalFailure => {
    const m = ANON_FRAME.exec(stackOf(x))
    const at = m ? { line: Number(m[1]) - lineOffset, col: Number(m[2]) } : undefined
    return failure('runtime', spec, errorMessage(x), at)
  }

  const syntaxMessage = (x: unknown): string => {
    let msg = x instanceof Error ? x.message : String(x)
    const dup = /Identifier '([^']+)' has already been declared/.exec(msg)
    if (dup && SCOPE_NAMES.has(dup[1])) {
      msg += ` — "${dup[1]}" is a built-in name here (a jscad function, params, part or Math); pick another name`
    }
    return msg
  }

  const compile = (code: string): UserFn => {
    const hit = lruGet(compiled, code)
    if (hit) return hit
    const fn = compileRaw(code)
    lruSet(compiled, code, fn, COMPILE_CACHE_MAX)
    return fn
  }

  const transformGeom = (matrix: Mat4, g: Geom3): Geom3 =>
    matricesClose(matrix, IDENTITY, 0) ? g : jscad.transforms.transform(matrix as unknown as JMat4, g)

  const unionIfMany = (list: Geom3[]): Geom3 | null => (list.length === 0 ? null : list.length === 1 ? list[0] : union(list))

  /**
   * part(name, overrides?) bound to one code spec's static dependency set. Nested warnings go into `warnings`.
   * Bad arguments throw plain Errors; the dependency's own failure is an EvalFailure, which passes through unchanged.
   */
  const makePart = (spec: CodeSpec, warnings: string[]) => (name: unknown, overrides?: unknown): Geom3[] => {
    if (typeof name !== 'string' || !Object.hasOwn(spec.deps, name)) {
      const shown = typeof name === 'string' ? JSON.stringify(name) : String(name)
      throw new Error(spec.lang === 'openscad'
        ? `part(${shown}): not a dependency of "${spec.name}" — write the name as a string literal, e.g. part("Bolt"), and check that an object with that name exists`
        : `part(${shown}): not a dependency of "${spec.name}" — call part with a string literal, e.g. part('Bolt')`)
    }
    const dep = spec.deps[name]
    if (overrides !== undefined && overrides !== null && (typeof overrides !== 'object' || Array.isArray(overrides))) {
      throw new Error(`part("${name}", overrides): overrides must be an object, e.g. { length: 20 }`)
    }
    const ov = (overrides ?? {}) as Record<string, unknown>
    let params: Record<string, ParamValue> = {}
    if (dep.kind === 'group') {
      if (Object.keys(ov).length > 0) throw new Error(`part("${name}"): groups have no parameters`)
    } else {
      const unknown = unknownParamKeys(dep.paramDefs, ov)
      if (unknown.length > 0) {
        const known = dep.paramDefs.map((p) => p.name).join(', ')
        throw new Error(`part("${name}"): unknown ${plural(unknown.length, 'parameter')} ${unknown.map((k) => `"${k}"`).join(', ')} — "${name}" has ${known ? 'parameters ' + known : 'no parameters'}`)
      }
      const given: Record<string, unknown> = { ...ov }
      for (const pd of dep.paramDefs) {
        let v = given[pd.name]
        // an OpenSCAD dropdown also takes its item's value: part("plate", holes = 3), part('box', { size: 30 })
        if (v !== undefined && pd.type === 'choice' && dep.kind === 'code' && dep.lang === 'openscad' && !isValidParamValue(pd, v) && (typeof v === 'number' || typeof v === 'string')) {
          const o = choiceOption(dep.code, pd.name, v)
          if (o !== null) given[pd.name] = v = o
        }
        if (v !== undefined && !isValidParamValue(pd, v)) throw new Error(`part("${name}"): ${pd.name} must be ${typeDescription(pd)}`)
      }
      params = resolveParamDefs(dep.paramDefs, given as Record<string, ParamValue>)
    }
    const r = evalEntry(dep, params)
    for (const w of r.warnings) warnings.push(`${dep.name}: ${w}`)
    return [...r.geoms] // a fresh array; the geometries are shared (immutable)
  }

  const validate = (spec: CodeSpec, out: unknown): Geom3[] => {
    const items: unknown[] = out === undefined || out === null ? [] : Array.isArray(out) ? out.flat(Infinity) : [out]
    for (const it of items) {
      if (geom3.isA(it)) continue
      if (geom2.isA(it) || path2.isA(it)) throw failure('result', spec, 'Returned 2D geometry — extrude it first (e.g. extrudeLinear)')
      throw failure('result', spec, `Return a 3D geometry or an array of them; got ${describeValue(it)}`)
    }
    return items as Geom3[]
  }

  /** A thrown OpenSCAD error → EvalFailure: line / col in the object's own code, 'file:line: ' prefix for an attached file. */
  const scadFailure = (spec: CodeSpec, x: unknown): EvalFailure => {
    if (!isScadError(x)) {
      const f = failure('runtime', spec, errorMessage(x))
      f.error.console = [{ level: 'error', text: f.error.message }]
      return f
    }
    const pos = x.pos
    const own = pos !== undefined && pos.file === ''
    const message = (pos && !own ? `${pos.file}:${pos.line}: ` : '') + x.message
    const e = failure(x.kind === 'syntax' ? 'syntax' : 'runtime', spec, message, pos && own ? { line: pos.line, col: pos.col } : undefined).error
    e.console = [
      ...consoleLines(x.messages),
      { level: 'error', text: clip(x.message), ...posFields(pos) },
      ...(x.trace ?? []).map((t): ConsoleLine => ({ level: 'trace', text: clip(`called by ${t}`) })),
    ]
    return new EvalFailure(e)
  }

  /**
   * The OpenSCAD builder's charge(): polygons it is about to create count towards the same per-evaluation budget as
   * JSCAD's creating functions, so a runaway model stops while it is still allocating.
   */
  const chargeScad = (n: number, what: string, pos?: SourcePos): void => {
    if (!(n <= MAX_TRIANGLES)) {
      throw new ScadError('limit', `Too much geometry: ${what} makes about ${thousands(Math.round(n))} polygons (the limit is ${thousands(MAX_TRIANGLES)} triangles)${scadHint(what)}`, pos)
    }
    budget.created += n
    if (budget.created > MAX_SOURCE_POLYGONS) {
      throw new ScadError('limit', `Too much geometry: this code made more than ${thousands(MAX_SOURCE_POLYGONS)} polygons (a loop that never ends?) — stopped before the page runs out of memory`, pos)
    }
  }

  /** OpenSCAD code: interpret + build in src/openscad, with part() and the geometry budget wired to this engine. */
  const evalScad = (spec: CodeSpec, params: Record<string, ParamValue>, key: string): MemoEntry => {
    if (!runScad) throw failure('runtime', spec, 'The OpenSCAD interpreter is not loaded')
    const nested: string[] = []
    const part = makePart(spec, nested)
    let geoms: Geom3[]
    let messages: ScadMessage[]
    try {
      const r = runScad(spec.code, {
        files: spec.files ?? {},
        overrides: params,
        // like Math.random in JSCAD code: seeded per result, so a re-run gives the same shape
        randomSeed: seedFromKey(key),
        preview: true,
        resolvePart: (name, overrides, pos) => {
          try {
            return part(name, overrides)
          } catch (x) {
            if (x instanceof EvalFailure || isScadError(x)) throw x
            throw new ScadError('runtime', errorMessage(x), pos) // bad name / overrides: point at the part() call
          }
        },
        charge: chargeScad,
      })
      geoms = r.geoms
      messages = r.messages
    } catch (x) {
      if (x instanceof EvalFailure) throw x
      throw scadFailure(spec, x)
    }
    const items: unknown[] = geoms
    for (const it of items) if (!geom3.isA(it)) throw failure('result', spec, `The OpenSCAD runtime returned ${describeValue(it)} instead of 3D geometry`)
    // the note about console lines not kept is counted in the Output panel's last line, not repeated as a warning
    const own = messages.filter((m) => m.level === 'warning' && droppedBy(m) < 0).map((m) => located(clip(m.text), m.pos))
    const warns = unique(own)
    const shown = warns.length > MAX_SCAD_WARNINGS ? [...warns.slice(0, MAX_SCAD_WARNINGS), `… and ${warns.length - MAX_SCAD_WARNINGS} more warnings`] : warns
    return {
      geoms,
      warnings: unique([...(geoms.length === 0 ? ['No top-level geometry'] : []), ...shown, ...nested]),
      console: consoleLines(messages),
      cost: vertexCost(geoms),
    }
  }

  const evalCode = (spec: CodeSpec, params: Record<string, ParamValue>, key: string): MemoEntry => {
    if (spec.lang === 'openscad') return evalScad(spec, params, key)
    let fn: UserFn
    try { fn = compile(spec.code) } catch (x) { throw failure('syntax', spec, syntaxMessage(x)) }
    const seededMath = Object.create(Math) as Math
    seededMath.random = mulberry32(seedFromKey(key))
    const nested: string[] = []
    let out: unknown
    try {
      out = fn(Object.freeze({ ...params }), makePart(spec, nested), LIB, seededMath, ...TAIL_ARGS)
    } catch (x) {
      if (x instanceof EvalFailure) throw x
      throw runtimeFailure(spec, x)
    }
    const geoms = validate(spec, out)
    return { geoms, warnings: unique([...(geoms.length === 0 ? ['Returned nothing'] : []), ...nested]), cost: vertexCost(geoms) }
  }

  const evalGroup = (spec: GroupSpec): MemoEntry => {
    const warnings: string[] = []
    const children: Geom3[][] = spec.children.map((c) => {
      const r = evalEntry(c.spec, c.params)
      for (const w of r.warnings) warnings.push(`${c.spec.name}: ${w}`)
      return r.geoms.map((g) => transformGeom(c.matrix, g))
    })
    let geoms: Geom3[]
    try {
      switch (spec.op) {
        case 'none':
          geoms = children.flat()
          break
        case 'union': {
          const u = unionIfMany(children.flat())
          geoms = u ? [u] : []
          break
        }
        case 'subtract': {
          const base = unionIfMany(children[0] ?? [])
          if (!base) { warnings.push('subtract: first child is empty'); geoms = []; break }
          const cutters = children.slice(1).flat()
          geoms = [cutters.length ? subtract(base, ...cutters) : base]
          break
        }
        case 'intersect': {
          const operands = children.map(unionIfMany)
          if (operands.length === 0) { geoms = []; break }
          if (operands.some((g) => g === null)) { warnings.push('intersect: a child is empty'); geoms = []; break }
          const ok = operands as Geom3[]
          geoms = [ok.length === 1 ? ok[0] : intersect(...ok)]
          break
        }
        default:
          throw new Error(`Unknown group op "${String((spec as { op: unknown }).op)}"`)
      }
    } catch (x) {
      if (x instanceof EvalFailure) throw x
      throw failure('runtime', spec, errorMessage(x))
    }
    return { geoms, warnings: unique(warnings), cost: vertexCost(geoms) }
  }

  /** Evaluate with memo (both code and group specs are memoized by hash([defKey, resolvedParams])). */
  const evalEntry = (spec: DefSpec, params: Record<string, ParamValue>): MemoEntry => {
    const resolved = spec.kind === 'code' ? resolveParamDefs(spec.paramDefs, params) : {}
    const key = hash([spec.defKey, resolved])
    const hit = lruGet(results, key)
    if (hit) { hits++; return hit }
    misses++
    stack.push(spec)
    try {
      if (stack.length > MAX_DEPTH) {
        const names = stack.map((s) => s.name)
        const first = stack.findIndex((s) => s.def === spec.def)
        const msg = first < stack.length - 1
          ? `Cycle: ${names.slice(first, Math.min(names.length, first + 8)).join(' → ')}${names.length - first > 8 ? ' → …' : ''}`
          : `Cycle: nesting deeper than ${MAX_DEPTH} levels (${names.slice(0, 4).join(' → ')} → …)`
        throw failure('cycle', spec, msg)
      }
      const entry = spec.kind === 'code' ? evalCode(spec, resolved, key) : evalGroup(spec)
      memoSet(key, entry)
      return entry
    } finally {
      stack.pop()
    }
  }

  /** Top-level entry: clean stack, a deep enough stack trace so the user frame is never cut off. */
  const top = <T>(f: () => T): T => {
    const prev = stackLimitHost.stackTraceLimit
    if (typeof prev === 'number' && prev < 200) stackLimitHost.stackTraceLimit = 200
    stack.length = 0
    budget.created = 0
    try { return f() } finally {
      stack.length = 0
      if (typeof prev === 'number') stackLimitHost.stackTraceLimit = prev
    }
  }

  const toMeshes = (spec: DefSpec, entry: MemoEntry): { meshes: MeshData[]; tris: number; warnings: string[]; console?: ConsoleLine[] } => {
    const polys = entry.geoms.map((g) => geom3.toPolygons(g)) // applies the lazy transforms
    let tris = 0
    for (const ps of polys) tris += countTriangles(ps)
    if (tris > MAX_TRIANGLES) {
      throw failure('result', spec, `Too many triangles: ${thousands(tris)} (the limit is ${thousands(MAX_TRIANGLES)}) — lower the segments`)
    }
    const fail = (message: string) => failure('result', spec, message)
    const meshes: MeshData[] = []
    polys.forEach((ps, i) => {
      const m = polysToMesh(ps, entry.geoms[i].color, fail)
      if (m) meshes.push(m)
    })
    const warnings = [...entry.warnings]
    if (entry.geoms.length > 0 && tris === 0) warnings.push('Result has no triangles')
    return entry.console ? { meshes, tris, warnings, console: entry.console } : { meshes, tris, warnings }
  }

  return {
    lineOffset,
    evaluate: (spec, params) => top(() => [...evalEntry(spec, params).geoms]),
    run: (job) => top(() => toMeshes(job.spec, evalEntry(job.spec, job.params))),
    stl: (items) => top(() => {
      const geoms: Geom3[] = []
      for (const it of items) {
        budget.created = 0 // each item is one object's evaluation, as when it was evaluated on its own
        for (const g of evalEntry(it.job.spec, it.job.params).geoms) geoms.push(transformGeom(it.matrix, g))
      }
      if (geoms.length === 0) {
        const root = items[0]?.job.spec
        throw new EvalFailure({ kind: 'result', def: root?.def ?? '', defName: root?.name ?? '', message: 'Nothing to export', trace: root ? [root.name] : [] })
      }
      const parts = stlSerializer.serialize({ binary: true }, ...geoms) as ArrayBuffer[]
      return { parts, tris: stlTriangleCount(parts) }
    }),
    stats: () => ({ compiled: compiled.size, memo: results.size, hits, misses }),
    setScad: (run) => { runScad = run },
    hasScad: () => runScad !== undefined,
  }
}
