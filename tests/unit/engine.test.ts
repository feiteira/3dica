// §9.2 engine.test.ts — real jscad in Node.
import { describe, expect, test } from 'vitest'
import jscad from '@jscad/modeling'
import type { CodeDef, ParamDef, ParamValue, Project } from '../../src/core/types'
import { sampleProject } from '../../src/core/sample'
import { expand } from '../../src/core/graph'
import { buildSpecs, computeWantedJobs, makeJob, type CodeSpec, type DefSpec, type GroupSpec, type Job } from '../../src/core/evalspec'
import { shownOperandBools } from '../../src/core/selection'
import { defaultUi } from '../../src/state/store'
import { hash } from '../../src/core/hash'
import { toMatrix } from '../../src/core/transform'
import { createEngine, EvalFailure, FLAT_NAMES, MAX_DEPTH, stlTriangleCount, toEvalError } from '../../src/eval/engine'
import type { EvalError } from '../../src/eval/protocol'

// ───────────────────────────── helpers ─────────────────────────────

let seq = 0
/** A hand-built CodeSpec (defKey from its content, like buildSpecs would). */
function codeSpec(name: string, code: string, opts: { paramDefs?: ParamDef[]; deps?: Record<string, DefSpec>; def?: string } = {}): CodeSpec {
  const paramDefs = opts.paramDefs ?? []
  const deps = opts.deps ?? {}
  const defKey = hash(['code', 'test', code, paramDefs.map((p) => [p.name, p.type, p.default]), Object.keys(deps).sort().map((n) => [n, deps[n].defKey])])
  return { kind: 'code', defKey, def: opts.def ?? `d_t${++seq}`, name, code, paramDefs, deps }
}
function groupSpec(name: string, op: GroupSpec['op'], children: { spec: DefSpec; params?: Record<string, ParamValue>; t?: [number, number, number] }[]): GroupSpec {
  const ch = children.map((c) => ({ spec: c.spec, params: c.params ?? {}, matrix: toMatrix({ t: c.t ?? [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }) }))
  const defKey = hash(['group', 'test', op, ch.map((c) => [c.spec.defKey, c.params, c.matrix])])
  return { kind: 'group', defKey, def: `d_g${++seq}`, name, op, children: ch }
}
const num = (name: string, d: number): ParamDef => ({ name, type: 'number', default: d })

/** Run a job expecting failure; returns the EvalError. */
function failOf(f: () => unknown): EvalError {
  try { f() } catch (x) {
    expect(x).toBeInstanceOf(EvalFailure)
    return (x as EvalFailure).error
  }
  throw new Error('expected an EvalFailure')
}

function bboxOf(meshes: { bbox: [number[], number[]] }[]) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (const m of meshes) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], m.bbox[0][k]); max[k] = Math.max(max[k], m.bbox[1][k]) }
  return { min, max }
}

function sampleJobs(p: Project = sampleProject()): Job[] {
  const specs = buildSpecs(p)
  const occs = expand(p)
  const ui = defaultUi()
  return computeWantedJobs(p, specs, occs, ui, shownOperandBools(occs, ui)).jobs
}

// ───────────────────────────── scope + calibration ─────────────────────────────

describe('scope', () => {
  test('lineOffset is calibrated (3 in V8) and 93 jscad names are flattened', () => {
    const e = createEngine()
    expect(e.lineOffset).toBe(3)
    expect(FLAT_NAMES.length).toBe(93)
    for (const n of ['cuboid', 'roundedCuboid', 'sphere', 'cylinder', 'torus', 'union', 'subtract', 'translateZ', 'extrudeLinear', 'hull', 'colorize', 'measureBoundingBox', 'vectorText', 'degToRad', 'bezier']) {
      expect(FLAT_NAMES).toContain(n)
    }
    // jscad 2.13 has booleans.minkowski, so Object.entries flattening includes it; minkowskiSum stays under jscad.minkowski
    expect(FLAT_NAMES).not.toContain('minkowskiSum')
    expect(new Set(FLAT_NAMES).size).toBe(FLAT_NAMES.length)
  })

  test('shadows are undefined, jscad and the flattened names are in scope, params is frozen', () => {
    const e = createEngine()
    const probe = codeSpec('Probe', `
      if (typeof self !== 'undefined' || typeof globalThis !== 'undefined' || typeof fetch !== 'undefined') throw new Error('leak')
      if (typeof postMessage !== 'undefined' || typeof importScripts !== 'undefined' || typeof XMLHttpRequest !== 'undefined' || typeof WebSocket !== 'undefined') throw new Error('leak')
      if (typeof jscad.minkowski !== 'object' || typeof cuboid !== 'function' || typeof bezier !== 'object') throw new Error('scope')
      if (!Object.isFrozen(params) || params.size !== 3) throw new Error('params')
      return cuboid({ size: [params.size, 1, 1] })`, { paramDefs: [num('size', 3)] })
    const r = e.run(makeJob(probe))
    expect(r.tris).toBe(12)
    expect(r.warnings).toEqual([])
  })

  test('redeclaring a flattened name is a syntax error with a hint', () => {
    const e = createEngine()
    const err = failOf(() => e.run(makeJob(codeSpec('Dup', 'const center = 1\nreturn cuboid()'))))
    expect(err.kind).toBe('syntax')
    expect(err.message).toMatch(/center/)
    expect(err.message).toMatch(/built-in/)
  })
})

// ───────────────────────────── the sample ─────────────────────────────

describe('sample', () => {
  test('every sample job evaluates to more than 0 triangles', () => {
    const jobs = sampleJobs()
    expect(jobs.map((j) => j.spec.name).sort()).toEqual(['Bolt', 'Bolt sizes', 'Plate', 'Washer'])
    const e = createEngine()
    const report: string[] = []
    for (const job of jobs) {
      const t0 = performance.now()
      const r = e.run(job)
      const ms = performance.now() - t0
      report.push(`${job.spec.name}: ${ms.toFixed(1)} ms, ${r.tris} triangles, ${r.meshes.length} meshes${r.warnings.length ? ', warnings ' + r.warnings.join('; ') : ''}`)
      expect(r.tris).toBeGreaterThan(0)
      expect(r.warnings).toEqual([])
      for (const m of r.meshes) {
        expect(m.positions.length).toBe(m.normals.length)
        expect(m.positions.length % 9).toBe(0)
        expect(m.positions.every(Number.isFinite)).toBe(true)
      }
      expect(r.meshes.reduce((a, m) => a + m.positions.length / 9, 0)).toBe(r.tris)
    }
    console.log('[engine] sample jobs (cold engine, Node):\n  ' + report.join('\n  '))
  })

  test('sample bboxes: Plate ±30 × ±20 × 0..4, Bolt head on z=0 with a 12 mm shank, Washer disc 0..1', () => {
    const p = sampleProject()
    const specs = buildSpecs(p)
    const e = createEngine()
    const plate = bboxOf(e.run(specs.jobFor('d_plate')!).meshes)
    expect(plate.min[0]).toBeCloseTo(-30, 5); expect(plate.max[0]).toBeCloseTo(30, 5)
    expect(plate.min[1]).toBeCloseTo(-20, 5); expect(plate.max[1]).toBeCloseTo(20, 5)
    expect(plate.min[2]).toBeCloseTo(0, 5); expect(plate.max[2]).toBeCloseTo(4, 5)
    const bolt = bboxOf(e.run(specs.jobFor('d_bolt')!).meshes)
    expect(bolt.min[2]).toBeCloseTo(-12, 4)
    expect(bolt.max[2]).toBeCloseTo(3.5, 4)
    const washer = e.run(specs.jobFor('d_washer')!)
    expect(washer.meshes.length).toBe(1) // a boolean gives one solid
    expect(washer.meshes[0].color).toBeUndefined() // booleans drop colors
    const wb = bboxOf(washer.meshes)
    expect(wb.min[2]).toBeCloseTo(0, 5); expect(wb.max[2]).toBeCloseTo(1, 5)
    expect(wb.max[0]).toBeCloseTo(5, 3)
  })

  test("part('Bolt', { length: 20 }) gives a shank 20 long (bbox z min = −20)", () => {
    const bolt = buildSpecs(sampleProject()).specOf('d_bolt')!
    const e = createEngine()
    const spec = codeSpec('Long bolt', "return part('Bolt', { length: 20 })", { deps: { Bolt: bolt } })
    const r = e.run(makeJob(spec))
    const bb = bboxOf(r.meshes)
    expect(bb.min[2]).toBeCloseTo(-20, 4)
    expect(bb.max[2]).toBeCloseTo(3.5, 4)
  })

  test('"Bolt sizes" has 10 geoms (5 bolts × head + shank), placed along +X', () => {
    const specs = buildSpecs(sampleProject())
    const e = createEngine()
    const geoms = e.evaluate(specs.specOf('d_boltsizes')!, {})
    expect(geoms.length).toBe(10)
    const bb = jscad.measurements.measureAggregateBoundingBox(geoms)
    expect(bb[1][0]).toBeGreaterThan(4 * 12)
  })
})

// ───────────────────────────── errors ─────────────────────────────

describe('errors', () => {
  test("part('Nope') → runtime error naming the def", () => {
    const e = createEngine()
    const err = failOf(() => e.run(makeJob(codeSpec('Holder', "const x = 1\nreturn part('Nope')", { def: 'd_holder' }))))
    expect(err.kind).toBe('runtime')
    expect(err.def).toBe('d_holder')
    expect(err.defName).toBe('Holder')
    expect(err.message).toContain('part("Nope"): not a dependency of "Holder"')
    expect(err.message).toContain("part('Bolt')")
    expect(err.line).toBe(2)
    expect(err.trace).toEqual(['Holder'])
  })

  test('a non-literal name → error (even when the name exists)', () => {
    const bolt = buildSpecs(sampleProject()).specOf('d_bolt')!
    const e = createEngine()
    // the code has no static ref, so 'Bolt' is not a dependency
    const err = failOf(() => e.run(makeJob(codeSpec('Dyn', "const n = 'Bolt'\nreturn part(n)", { deps: {} }))))
    expect(err.kind).toBe('runtime')
    expect(err.message).toMatch(/not a dependency of "Dyn" — call part with a string literal/)
    // with the literal present elsewhere it is a dependency and works
    const ok = e.run(makeJob(codeSpec('Dyn2', "const n = 'Bolt'\nif (false) part('Bolt')\nreturn part(n)", { deps: { Bolt: bolt } })))
    expect(ok.tris).toBeGreaterThan(0)
  })

  test('null.x on user line 3 → line 3, kind runtime', () => {
    const e = createEngine()
    const err = failOf(() => e.run(makeJob(codeSpec('Oops', 'const a = 1\n\n  null.x\nreturn cuboid()', { def: 'd_oops' }))))
    expect(err.kind).toBe('runtime')
    expect(err.line).toBe(3)
    expect(err.col).toBeGreaterThan(2)
    expect(err.def).toBe('d_oops')
    expect(err.message).toMatch(/^TypeError: /)
  })

  test('an error thrown inside jscad maps to the calling line', () => {
    const e = createEngine()
    const err = failOf(() => e.run(makeJob(codeSpec('Round', 'const x = 1\nreturn roundedCuboid({ size: [4, 4, 4], roundRadius: 3 })'))))
    expect(err.kind).toBe('runtime')
    expect(err.line).toBe(2)
    expect(err.message).toMatch(/roundRadius/)
  })

  test("throw new Error('boom') on line 1 → line 1", () => {
    const e = createEngine()
    const err = failOf(() => e.run(makeJob(codeSpec('Boom', 'throw new Error("boom")'))))
    expect(err).toMatchObject({ kind: 'runtime', message: 'boom', line: 1 })
  })

  test('return ( → kind syntax, no line', () => {
    const e = createEngine()
    const err = failOf(() => e.run(makeJob(codeSpec('Syn', 'return (', { def: 'd_syn' }))))
    expect(err.kind).toBe('syntax')
    expect(err.def).toBe('d_syn')
    expect(err.line).toBeUndefined()
  })

  test('returning circle() → the 2D error', () => {
    const e = createEngine()
    const err = failOf(() => e.run(makeJob(codeSpec('Flat', 'return circle()'))))
    expect(err.kind).toBe('result')
    expect(err.message).toBe('Returned 2D geometry — extrude it first (e.g. extrudeLinear)')
    const err2 = failOf(() => e.run(makeJob(codeSpec('Path', 'return [cuboid(), line([[0, 0], [1, 1]])]'))))
    expect(err2.message).toMatch(/^Returned 2D geometry/)
  })

  test('returning a non-geometry → error naming its type', () => {
    const e = createEngine()
    expect(failOf(() => e.run(makeJob(codeSpec('N', 'return 42')))).message).toBe('Return a 3D geometry or an array of them; got number')
    expect(failOf(() => e.run(makeJob(codeSpec('O', 'return [cuboid(), { a: 1 }]')))).message).toBe('Return a 3D geometry or an array of them; got object')
    expect(failOf(() => e.run(makeJob(codeSpec('M', 'return new Map()')))).message).toBe('Return a 3D geometry or an array of them; got Map')
  })

  test('returning [] (or nothing) → ok with the warning "Returned nothing"; nested arrays are flattened', () => {
    const e = createEngine()
    expect(e.run(makeJob(codeSpec('Empty', 'return []')))).toEqual({ meshes: [], tris: 0, warnings: ['Returned nothing'] })
    expect(e.run(makeJob(codeSpec('Void', 'const a = 1')))).toEqual({ meshes: [], tris: 0, warnings: ['Returned nothing'] })
    const nested = e.run(makeJob(codeSpec('Nested', 'return [[cuboid()], [[], [sphere({ segments: 8 })]]]')))
    expect(nested.meshes.length).toBe(2)
    expect(nested.warnings).toEqual([])
  })

  test('a NaN position → result error', () => {
    const e = createEngine()
    const err = failOf(() => e.run(makeJob(codeSpec('Nan', 'return translate([NaN, 0, 0], cuboid())'))))
    expect(err.kind).toBe('result')
    expect(err.message).toMatch(/NaN/)
  })

  test('more than 2,000,000 triangles → result error', () => {
    const e = createEngine()
    // ~2.1M triangles of plain (non-boolean) geometry: 33 spheres × 64,512 triangles
    const err = failOf(() => e.run(makeJob(codeSpec('Huge', 'const s = sphere({ segments: 256 })\nconst out = []\nfor (let i = 0; i < 33; i++) out.push(s)\nreturn out'))))
    expect(err.kind).toBe('result')
    expect(err.message).toMatch(/^Too many triangles: 2,\d{3},\d{3}/)
  })

  test('part() overrides: unknown keys throw, wrong types throw, groups take no parameters', () => {
    const specs = buildSpecs(sampleProject())
    const bolt = specs.specOf('d_bolt')!, washer = specs.specOf('d_washer')!
    const e = createEngine()
    const unknown = failOf(() => e.run(makeJob(codeSpec('U', "return part('Bolt', { len: 3 })", { deps: { Bolt: bolt } }))))
    expect(unknown.kind).toBe('runtime')
    expect(unknown.message).toMatch(/part\("Bolt"\): unknown parameter "len"/)
    const typed = failOf(() => e.run(makeJob(codeSpec('T', "return part('Bolt', { length: 'x' })", { deps: { Bolt: bolt } }))))
    expect(typed.message).toMatch(/length must be a finite number/)
    const grp = failOf(() => e.run(makeJob(codeSpec('G', "return part('Washer', { radius: 3 })", { deps: { Washer: washer } }))))
    expect(grp.message).toMatch(/groups have no parameters/)
    // a group target applies its child transforms; booleans give one solid in the group's local coordinates
    const ok = e.run(makeJob(codeSpec('W', "return part('Washer', {})", { deps: { Washer: washer } })))
    expect(ok.meshes.length).toBe(1)
  })

  test('nested failure: Bolt throws → "Bolt sizes" fails with error.def d_bolt and trace [Bolt sizes, Bolt]', () => {
    const p = sampleProject()
    ;(p.defs.d_bolt as CodeDef).code = 'const a = 1\nthrow new Error("bad bolt")'
    const specs = buildSpecs(p)
    const e = createEngine()
    const err = failOf(() => e.run(specs.jobFor('d_boltsizes')!))
    expect(err.def).toBe('d_bolt')
    expect(err.defName).toBe('Bolt')
    expect(err.kind).toBe('runtime')
    expect(err.message).toBe('bad bolt')
    expect(err.line).toBe(2) // Bolt's own line, not the part() call in "Bolt sizes"
    expect(err.trace).toEqual(['Bolt sizes', 'Bolt'])
    // through a group: Washer ⊃ Disc
    ;(p.defs.d_disc as CodeDef).code = 'return circle()'
    const err2 = failOf(() => e.run(buildSpecs(p).jobFor('d_washer')!))
    expect(err2).toMatchObject({ kind: 'result', def: 'd_disc', trace: ['Washer', 'Disc'] })
  })

  test('toEvalError wraps foreign exceptions as runtime errors of the root', () => {
    expect(toEvalError(new RangeError('x'), { def: 'd_a', name: 'A' })).toEqual({ kind: 'runtime', def: 'd_a', defName: 'A', message: 'RangeError: x', trace: ['A'] })
  })
})

// ───────────────────────────── determinism, memo, depth ─────────────────────────────

describe('determinism and memo', () => {
  const randomCode = 'return cuboid({ size: [1 + Math.random(), 1 + Math.random(), 1], center: [Math.random() * 10, 0, 0] })'

  test('Math.random is deterministic for the same key (seeded mulberry32), different for another key', () => {
    const a = codeSpec('R', randomCode, { paramDefs: [num('k', 1)], def: 'd_r' })
    const run = (params: Record<string, ParamValue>) => createEngine().run(makeJob(a, params)).meshes[0].bbox
    expect(run({ k: 1 })).toEqual(run({ k: 1 }))
    expect(run({ k: 2 })).not.toEqual(run({ k: 1 }))
    // the real Math is untouched and the seeded one still has the rest of Math
    const r = createEngine().run(makeJob(codeSpec('PI', 'if (Math.PI !== 3.141592653589793 || Math.max(1, 2) !== 2) throw new Error("math")\nreturn cuboid()')))
    expect(r.tris).toBe(12)
  })

  test('the memo hits on a second run (stats().hits increases); code is compiled once', () => {
    const e = createEngine()
    const job = sampleJobs().find((j) => j.spec.name === 'Bolt sizes')!
    e.run(job)
    const s1 = e.stats()
    expect(s1.misses).toBe(6) // Bolt sizes + 5 distinct bolt lengths
    expect(s1.compiled).toBe(2)
    e.run(job)
    const s2 = e.stats()
    expect(s2.hits).toBe(s1.hits + 1)
    expect(s2.misses).toBe(s1.misses)
    expect(s2.memo).toBe(6)
  })

  test('linked part() calls share the memo (Bolt evaluated once for "Bolt sizes" and the Bolt job)', () => {
    const e = createEngine()
    const specs = buildSpecs(sampleProject())
    e.run(specs.jobFor('d_bolt', { length: 8 })!)
    const before = e.stats()
    e.evaluate(specs.specOf('d_boltsizes')!, {})
    expect(e.stats().hits).toBe(before.hits + 1) // part('Bolt', { length: 8 }) is the first bolt in the rack
  })

  test('depth over 64 throws a cycle error; 64 levels are fine', () => {
    const e = createEngine()
    const chain = (n: number): CodeSpec => {
      let s = codeSpec('Leaf', 'return cuboid()')
      for (let i = 1; i < n; i++) s = codeSpec(`L${i}`, `return part('${s.name}')`, { deps: { [s.name]: s } })
      return s
    }
    expect(e.run(makeJob(chain(MAX_DEPTH))).tris).toBe(12)
    const deep = failOf(() => createEngine().run(makeJob(chain(MAX_DEPTH + 1)))) // fresh memo: the inner levels share keys
    expect(deep.kind).toBe('cycle')
    expect(deep.trace.length).toBe(MAX_DEPTH + 1)

    // a self-referencing spec (buildSpecs never makes one, the worker still guards it)
    const self: CodeSpec = { kind: 'code', defKey: 'kself', def: 'd_self', name: 'Self', code: "return part('Self')", paramDefs: [], deps: {} }
    self.deps.Self = self
    const cyc = failOf(() => e.run(makeJob(self)))
    expect(cyc.kind).toBe('cycle')
    expect(cyc.message).toMatch(/^Cycle: Self → Self/)
    expect(cyc.def).toBe('d_self')
    // the engine is still usable afterwards
    expect(e.run(makeJob(codeSpec('After', 'return cuboid()'))).tris).toBe(12)
  })
})

// ───────────────────────────── groups ─────────────────────────────

describe('groups', () => {
  test('subtract of a group whose child 0 has two geoms unions them first', () => {
    const e = createEngine()
    const two = codeSpec('Two', 'return [cuboid({ size: [10, 10, 10], center: [0, 0, 5] }), cuboid({ size: [10, 10, 10], center: [20, 0, 5] })]')
    const cutter = codeSpec('Cut', 'return cylinder({ radius: 2, height: 20, center: [0, 0, 5] })')
    const g = groupSpec('Cut two', 'subtract', [{ spec: two }, { spec: cutter }])
    const r = e.run(makeJob(g))
    expect(r.meshes.length).toBe(1)
    const bb = bboxOf(r.meshes)
    expect(bb.min[0]).toBeCloseTo(-5, 5)
    expect(bb.max[0]).toBeCloseTo(25, 5) // without the union the second cube would have been subtracted away
    const vol = jscad.measurements.measureVolume(e.evaluate(g, {})[0])
    expect(vol).toBeCloseTo(2000 - Math.PI * 4 * 10, -1)
  })

  test('subtract with an empty first child → [] and a warning', () => {
    const e = createEngine()
    const g = groupSpec('Nothing', 'subtract', [{ spec: codeSpec('E', 'return []') }, { spec: codeSpec('C', 'return cuboid()') }])
    const r = e.run(makeJob(g))
    expect(r.tris).toBe(0)
    expect(r.warnings).toContain('subtract: first child is empty')
  })

  test('union / intersect / none, with child matrices applied', () => {
    const e = createEngine()
    const cube = codeSpec('Cube', 'return cuboid({ size: [10, 10, 10], center: [0, 0, 5] })')
    const u = e.run(makeJob(groupSpec('U', 'union', [{ spec: cube }, { spec: cube, t: [5, 0, 0] }])))
    expect(u.meshes.length).toBe(1)
    expect(bboxOf(u.meshes).max[0]).toBeCloseTo(10, 5)
    const i = e.run(makeJob(groupSpec('I', 'intersect', [{ spec: cube }, { spec: cube, t: [5, 0, 0] }])))
    const ib = bboxOf(i.meshes)
    expect(ib.min[0]).toBeCloseTo(0, 5); expect(ib.max[0]).toBeCloseTo(5, 5)
    const n = e.run(makeJob(groupSpec('N', 'none', [{ spec: cube }, { spec: cube, t: [30, 0, 0] }])))
    expect(n.meshes.length).toBe(2)
    expect(bboxOf(n.meshes).max[0]).toBeCloseTo(35, 5)
  })

  test('code colors survive part() / none groups; a mirrored child keeps outward normals', () => {
    const e = createEngine()
    const red = codeSpec('Red', 'return colorize([1, 0, 0], cuboid({ size: [2, 2, 2], center: [5, 0, 0] }))')
    const g: GroupSpec = { kind: 'group', defKey: 'kmirror', def: 'd_m', name: 'Mirror', op: 'none',
      children: [{ spec: red, params: {}, matrix: toMatrix({ t: [0, 0, 0], r: [0, 0, 0], s: [-1, 1, 1] }) }] }
    const r = e.run(makeJob(g))
    expect(r.meshes[0].color).toEqual([1, 0, 0, 1])
    const m = r.meshes[0]
    expect(m.bbox[0][0]).toBeCloseTo(-6, 5)
    // every triangle's normal points away from the cube's center (-5, 0, 0)
    for (let t = 0; t < m.positions.length; t += 9) {
      const cx = (m.positions[t] + m.positions[t + 3] + m.positions[t + 6]) / 3 + 5
      const cy = (m.positions[t + 1] + m.positions[t + 4] + m.positions[t + 7]) / 3
      const cz = (m.positions[t + 2] + m.positions[t + 5] + m.positions[t + 8]) / 3
      expect(m.normals[t] * cx + m.normals[t + 1] * cy + m.normals[t + 2] * cz).toBeGreaterThan(0)
    }
  })
})

// ───────────────────────────── STL ─────────────────────────────

describe('stl', () => {
  test('STL output size equals 84 + 50·n, n read from bytes 80..83', () => {
    const p = sampleProject()
    const specs = buildSpecs(p)
    const occs = expand(p)
    const items = occs.filter((o) => o.parentKey === '' && !o.hidden).map((o) => ({ job: specs.jobFor(o.def.id, o.params)!, matrix: o.world }))
    expect(items.length).toBe(3)
    const e = createEngine()
    const { parts, tris } = e.stl(items)
    const bytes = new Uint8Array(parts.reduce((a, b) => a + b.byteLength, 0))
    let off = 0
    for (const b of parts) { bytes.set(new Uint8Array(b), off); off += b.byteLength }
    const n = new DataView(bytes.buffer).getUint32(80, true)
    expect(bytes.length).toBe(84 + 50 * n)
    expect(n).toBe(tris)
    expect(n).toBeGreaterThan(10000)
    expect(stlTriangleCount(parts)).toBe(n)
  })

  test('STL applies the item matrix', () => {
    const e = createEngine()
    const cube = codeSpec('Cube', 'return cuboid({ size: [2, 2, 2] })')
    const { parts } = e.stl([{ job: makeJob(cube), matrix: toMatrix({ t: [100, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }) }])
    const all = new Uint8Array(parts.reduce((a, b) => a + b.byteLength, 0))
    let off = 0
    for (const b of parts) { all.set(new Uint8Array(b), off); off += b.byteLength }
    const dv = new DataView(all.buffer)
    const x = dv.getFloat32(84 + 12, true) // first vertex x of the first triangle
    expect(x).toBeGreaterThan(98)
    expect(x).toBeLessThan(102)
  })

  test('nothing to export → result error', () => {
    const e = createEngine()
    const err = failOf(() => e.stl([{ job: makeJob(codeSpec('E', 'return []')), matrix: toMatrix({ t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }) }]))
    expect(err.message).toBe('Nothing to export')
  })
})

// ───────────────────────────── memory guards (a worker out-of-memory takes the whole tab down) ─────────────────────────────

describe('out-of-memory guards', () => {
  test('a huge segments value is refused before jscad allocates it (on the user line)', () => {
    const e = createEngine()
    const t0 = Date.now()
    const err = failOf(() => e.run(makeJob(codeSpec('Ball', 'const r = 6\nreturn sphere({ radius: r, segments: 8192 })'))))
    expect(Date.now() - t0).toBeLessThan(2000) // instead of building 33 M polygons (the tab crashed after ~32 s)
    expect(err).toMatchObject({ kind: 'runtime', line: 2 })
    expect(err.message).toMatch(/^Too much geometry: sphere with segments 8,192 makes about 33,554,432 polygons/)
    // also through jscad.primitives, and for other round primitives
    expect(failOf(() => e.run(makeJob(codeSpec('T', 'return jscad.primitives.torus({ innerSegments: 2000, outerSegments: 2000 })')))).message).toMatch(/^Too much geometry: torus/)
    expect(failOf(() => e.run(makeJob(codeSpec('C', 'return extrudeLinear({ height: 1 }, circle({ segments: 3e6 }))')))).message).toMatch(/^Too much geometry: circle/)
    // ordinary values are untouched
    expect(e.run(makeJob(codeSpec('Ok', 'return sphere({ segments: 64 })'))).tris).toBeGreaterThan(0)
  })

  test('a runaway loop of ordinary primitives stops while it is still allocating (not after the timeout)', () => {
    const e = createEngine()
    const t0 = Date.now()
    const err = failOf(() => e.run(makeJob(codeSpec('Object', 'const out = []\nfor (let i = 0; i < 10; i--) out.push(sphere({ radius: 2 }))\nreturn out'))))
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(err).toMatchObject({ kind: 'runtime', line: 2 })
    expect(err.message).toMatch(/^Too much geometry: this code made more than 2,000,000 polygons/)
    // the budget is per evaluation: the next job starts from zero
    expect(e.run(makeJob(codeSpec('Next', 'return [sphere(), sphere({ center: [10, 0, 0] })]'))).tris).toBeGreaterThan(0)
  }, 30_000)

  test('the memo is bounded by size, not only by count', () => {
    const e = createEngine({ memoMaxVertices: 300_000 }) // a 256-segment sphere has ~130k polygon vertices
    for (let r = 1; r <= 8; r++) e.run(makeJob(codeSpec('Ball', 'return sphere({ radius: params.r, segments: 256 })', { paramDefs: [num('r', r)] }), { r }))
    const s = e.stats()
    expect(s.memo).toBeLessThanOrEqual(3)
    expect(s.memo).toBeGreaterThanOrEqual(1) // the newest result always stays
    // the default budget keeps many small results (the sample) memoized
    const d = createEngine()
    for (const j of sampleJobs()) d.run(j)
    expect(d.stats().memo).toBeGreaterThanOrEqual(4)
  })
})
