// §2.3 project file `.3dica.json`: serialize, parseProject (migrate → validate), validateProject (§2.2).
import type { CodeDef, Definition, GroupDef, GroupOp, Id, Instance, ParamDef, ParamValue, Project, Transform, Vec3 } from './types'
import { isDefId, isInstanceId, MAX_NAME } from './ids'
import { findCycle } from './graph'
import { paramDefProblems } from './params'
import { normalizeColor } from './ops'
import { normalizeScadFiles, scadParams } from './scad'

export const APP_ID = '3dica 0.1.0'
export const CURRENT_VERSION = 1

export type ParseResult = { ok: true; project: Project } | { ok: false; problems: string[] }

type Raw = Record<string, unknown>

/** MIGRATIONS[v] upgrades a raw v-file in place of the next step; for v1 it is the identity (the table exists for v0.2). */
export const MIGRATIONS: Record<number, (raw: Raw) => Raw> = {
  1: (raw) => raw,
}

/** A project with only the root group, named 'Untitled' by default (toolbar New, §6). */
export function emptyProject(name = 'Untitled'): Project {
  return {
    format: '3dica', version: 1, name, root: 'd_root',
    defs: { d_root: { id: 'd_root', name: 'Scene', kind: 'group', op: 'none', children: [] } },
  }
}

/** True if any code def exists (Open shows "This file contains code that runs on your computer. Run it?"). */
export function hasCode(project: Project): boolean {
  return Object.values(project.defs).some((d) => d.kind === 'code')
}

// ───────────────────────────── serialize ─────────────────────────────

function orderedParamDef(p: ParamDef): ParamDef {
  const o: ParamDef = { name: p.name, type: p.type, default: p.default }
  if (p.min !== undefined) o.min = p.min
  if (p.max !== undefined) o.max = p.max
  if (p.step !== undefined) o.step = p.step
  if (p.options !== undefined) o.options = [...p.options]
  return o
}

function orderedInstance(c: Instance): Instance {
  const out: Record<string, unknown> = { id: c.id, def: c.def }
  if (c.name !== undefined) out.name = c.name
  out.xf = { t: c.xf.t, r: c.xf.r, s: c.xf.s }
  if (c.color !== undefined) out.color = c.color
  if (c.params !== undefined) out.params = c.params
  if (c.hidden) out.hidden = true
  return out as unknown as Instance
}

function orderedDef(d: Definition): Record<string, unknown> {
  const o: Record<string, unknown> = { id: d.id, name: d.name, kind: d.kind }
  if (d.color !== undefined) o.color = d.color
  if (d.kind === 'group') { o.op = d.op; o.children = d.children.map(orderedInstance) }
  else {
    if (d.lang) o.lang = d.lang
    o.params = d.params.map(orderedParamDef)
    o.code = d.code
    if (d.files) {
      const files: Record<string, string> = {}
      for (const k of Object.keys(d.files).sort()) files[k] = d.files[k]
      o.files = files
    }
  }
  return o
}

/**
 * The file text: 2-space JSON, keys `format, version, app, name, savedAt, root, camera, defs`; defs sorted by id;
 * inside each def `id, name, kind, color, op|lang, params, code, files|children`; instances `id, def, name, xf, color, params, hidden`.
 * Arrays of plain numbers are written on one line ("t": [0, 0, 0]).
 */
export function serialize(project: Project, savedAt: Date = new Date()): string {
  const out: Record<string, unknown> = {
    format: '3dica', version: project.version, app: APP_ID, name: project.name, savedAt: savedAt.toISOString(), root: project.root,
  }
  if (project.camera) out.camera = { position: project.camera.position, target: project.camera.target }
  const defs: Record<string, unknown> = {}
  for (const id of Object.keys(project.defs).sort()) defs[id] = orderedDef(project.defs[id])
  out.defs = defs
  return JSON.stringify(out, null, 2).replace(/\[\n\s*(-?[\d.eE+-]+(?:,\n\s*-?[\d.eE+-]+)*)\n\s*\]/g,
    (_m, inner: string) => '[' + inner.split(/,\n\s*/).join(', ') + ']') + '\n'
}

// ───────────────────────────── parse ─────────────────────────────

const OPS: GroupOp[] = ['none', 'union', 'subtract', 'intersect']
const isObj = (x: unknown): x is Raw => !!x && typeof x === 'object' && !Array.isArray(x)
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x))

/**
 * Parse a file (text or an already-parsed object):
 * 1. format !== '3dica' → error; 2. version > 1 → "made by a newer 3Dica"; 3. MIGRATIONS[version] in sequence;
 * 4. shape checks + validateProject (§2.2). Every problem is listed; unknown fields (app, savedAt, …) are dropped.
 */
export function parseProject(input: unknown): ParseResult {
  let raw: unknown = input
  if (typeof input === 'string') {
    try { raw = JSON.parse(input) } catch (e) { return { ok: false, problems: [`Not valid JSON: ${(e as Error).message}`] } }
  }
  if (!isObj(raw)) return { ok: false, problems: ['Not a 3Dica project (the file is not a JSON object)'] }
  if (raw.format !== '3dica') return { ok: false, problems: [`Not a 3Dica project (format is ${JSON.stringify(raw.format ?? null)}, expected "3dica")`] }
  const version = raw.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, problems: [`Unknown project version ${JSON.stringify(version ?? null)}`] }
  }
  if (version > CURRENT_VERSION) return { ok: false, problems: [`This file was made by a newer 3Dica (file version ${version}, this app reads version ${CURRENT_VERSION})`] }
  for (let v = version; v <= CURRENT_VERSION; v++) raw = MIGRATIONS[v](raw as Raw)

  const found: string[] = []
  const project = normalize(raw as Raw, found)
  if (project) found.push(...validateProject(project))
  const problems = [...new Set(found)]
  if (problems.length || !project) return { ok: false, problems: problems.length ? problems : ['Invalid project'] }
  return { ok: true, project }
}

function normalize(raw: Raw, problems: string[]): Project | null {
  if (typeof raw.name !== 'string') problems.push('Project name is missing')
  if (typeof raw.root !== 'string') problems.push('Project root is missing')
  if (!isObj(raw.defs)) { problems.push('Project has no definitions'); return null }
  const defs: Record<Id, Definition> = {}
  for (const [key, rd] of Object.entries(raw.defs)) {
    const def = normalizeDef(key, rd, problems)
    if (def) defs[key] = def
  }
  const p: Project = { format: '3dica', version: 1, name: typeof raw.name === 'string' ? raw.name : 'Untitled', root: typeof raw.root === 'string' ? raw.root : '', defs }
  if (isObj(raw.camera) && isVec3(raw.camera.position) && isVec3(raw.camera.target)) {
    p.camera = { position: [...raw.camera.position] as Vec3, target: [...raw.camera.target] as Vec3 }
  }
  return p
}

/**
 * A best-effort Definition from raw JSON. Every problem found here is pushed to `problems`; the def is still returned
 * (with placeholders for the broken parts) unless it is unusable (not an object, unknown kind), so that
 * validateProject can check the cross references of a broken file too — dropping a whole group because one child is
 * malformed would report its instances' definitions, or the root itself, as "missing" and hide the real problems.
 * (Any problem fails parseProject, so placeholders never reach the app.)
 */
function normalizeDef(key: string, rd: unknown, problems: string[]): Definition | null {
  if (!isObj(rd)) { problems.push(`Definition "${key}" is not an object`); return null }
  const label = typeof rd.name === 'string' ? `'${rd.name}'` : `"${key}"`
  const bad = (msg: string) => { problems.push(`Definition ${label}: ${msg}`) }
  if (!isDefId(key)) bad(`invalid id "${key}"`)
  if (rd.id !== key) bad(`id ${JSON.stringify(rd.id ?? null)} does not match its key "${key}"`)
  if (typeof rd.name !== 'string') bad('name is missing')
  let color: string | undefined
  if (rd.color !== undefined) {
    const c = normalizeColor(rd.color)
    if (c) color = c
    else bad(`color ${JSON.stringify(rd.color)} is not #rrggbb`)
  }
  const name = typeof rd.name === 'string' ? rd.name : key
  if (rd.kind === 'code') {
    if (typeof rd.code !== 'string') bad('code is missing')
    const code = typeof rd.code === 'string' ? rd.code : ''
    if (rd.lang !== undefined && rd.lang !== 'openscad') bad(`lang ${JSON.stringify(rd.lang)} must be "openscad" (or absent for JSCAD code)`)
    if (rd.lang === 'openscad') {
      // the code is the single source of truth: the stored params are derived again, whatever the file says
      const def: CodeDef = { id: key, name, kind: 'code', code, params: scadParams(code), lang: 'openscad' }
      if (rd.files !== undefined) {
        const f = normalizeScadFiles(rd.files)
        for (const x of f.problems) bad(x)
        if (f.files) def.files = f.files
      }
      if (color) def.color = color
      return def
    }
    if (rd.files !== undefined) bad('files are only for OpenSCAD code (lang "openscad")')
    const pp = paramDefProblems(rd.params)
    for (const x of pp) bad(x)
    const params = pp.length ? [] : (rd.params as ParamDef[]).map((p) => orderedParamDef(p))
    const def: CodeDef = { id: key, name, kind: 'code', code, params }
    if (color) def.color = color
    return def
  }
  if (rd.kind === 'group') {
    const opOk = OPS.includes(rd.op as GroupOp)
    if (!opOk) bad(`op ${JSON.stringify(rd.op ?? null)} must be none, union, subtract or intersect`)
    const children: Instance[] = []
    if (!Array.isArray(rd.children)) bad('children must be a list')
    else {
      for (const rc of rd.children) {
        const c = normalizeInstance(label, rc, problems)
        if (c) children.push(c)
      }
    }
    const def: GroupDef = { id: key, name, kind: 'group', op: opOk ? rd.op as GroupOp : 'none', children }
    if (color) def.color = color
    return def
  }
  bad(`kind ${JSON.stringify(rd.kind ?? null)} must be "code" or "group"`)
  return null
}

/**
 * A best-effort Instance (problems pushed; broken fields dropped or replaced by identity), or null when it has no
 * usable id / def to check further. A zero scale is left for validateProject to report (once).
 */
function normalizeInstance(parentLabel: string, rc: unknown, problems: string[]): Instance | null {
  if (!isObj(rc)) { problems.push(`An instance in ${parentLabel} is not an object`); return null }
  const label = `Instance ${typeof rc.id === 'string' ? `"${rc.id}"` : '(no id)'} in ${parentLabel}`
  const bad = (msg: string) => { problems.push(`${label}: ${msg}`) }
  if (!isInstanceId(rc.id)) bad('invalid id')
  if (typeof rc.def !== 'string') bad('def is missing')
  if (rc.name !== undefined && typeof rc.name !== 'string') bad('label must be text')
  const xf = rc.xf
  const xfOk = isObj(xf) && isVec3(xf.t) && isVec3(xf.r) && isVec3(xf.s)
  if (!xfOk) bad('transform must have t, r and s as three finite numbers')
  let color: string | undefined
  if (rc.color !== undefined) {
    const c = normalizeColor(rc.color)
    if (c) color = c
    else bad(`color ${JSON.stringify(rc.color)} is not #rrggbb`)
  }
  let params: Record<string, ParamValue> | undefined
  if (rc.params !== undefined) {
    if (!isObj(rc.params)) bad('params must be an object')
    else {
      params = {}
      for (const [k, v] of Object.entries(rc.params)) {
        if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || typeof v === 'string') params[k] = v
        else bad(`override '${k}' must be a number, true/false or text`)
      }
    }
  }
  if (rc.hidden !== undefined && typeof rc.hidden !== 'boolean') bad('hidden must be true or false')
  if (typeof rc.id !== 'string' || typeof rc.def !== 'string') return null
  const x = xfOk ? xf as { t: Vec3; r: Vec3; s: Vec3 } : { t: [0, 0, 0] as Vec3, r: [0, 0, 0] as Vec3, s: [1, 1, 1] as Vec3 }
  const inst: Instance = { id: rc.id as Id, def: rc.def as Id, xf: { t: [...x.t] as Vec3, r: [...x.r] as Vec3, s: [...x.s] as Vec3 } as Transform }
  if (typeof rc.name === 'string') inst.name = rc.name
  if (color) inst.color = color
  if (params) inst.params = params
  if (rc.hidden === true) inst.hidden = true
  return inst
}

/**
 * §2.2 invariants as readable problems ([] = valid). Checked: the root (exists, group, op none, named 'Scene',
 * never instanced); every Instance.def exists; instance ids unique across the project; def keys = ids; def names
 * unique, trimmed, 1–64 chars, no quotes/backticks/backslashes/newlines, not 'Scene' (except the root); the group
 * graph is acyclic; every xf is finite with no zero scale; ParamDefs valid.
 * Deliberate deviation: cycles that go through part() references are NOT rejected here — setCode cannot refuse what
 * the user types, so such cycles can exist in memory and in autosaves; they are reported at evaluation as CycleError.
 */
export function validateProject(p: Project): string[] {
  const problems: string[] = []
  const nameOf = (id: Id) => (p.defs[id] ? `'${p.defs[id].name}'` : `"${id}"`)
  const root = p.defs[p.root]
  if (!root) problems.push(`The root definition "${p.root}" is missing`)
  else {
    if (root.kind !== 'group') problems.push('The root definition must be a group')
    else if (root.op !== 'none') problems.push("The root group's op must be none")
    if (root.name !== 'Scene') problems.push(`The root definition must be named 'Scene' (it is '${root.name}')`)
  }
  const names = new Map<string, Id>()
  const instIds = new Map<Id, Id>()
  for (const [key, d] of Object.entries(p.defs)) {
    if (d.id !== key) problems.push(`Definition key "${key}" does not match its id "${d.id}"`)
    if (key !== p.root) {
      const n = d.name
      if (typeof n !== 'string' || n.length === 0) problems.push(`Definition "${key}" has an empty name`)
      else {
        if (n !== n.trim()) problems.push(`Definition '${n}': the name can't start or end with a space`)
        if (n.length > MAX_NAME) problems.push(`Definition '${n}': the name is longer than ${MAX_NAME} characters`)
        if (/['"`\\\n\r]/.test(n)) problems.push(`Definition '${n}': the name can't contain quotes, backticks, backslashes or line breaks`)
        if (n === 'Scene') problems.push(`Definition "${key}": the name 'Scene' is reserved for the root`)
      }
    }
    if (names.has(d.name)) problems.push(`Duplicate definition name '${d.name}' ("${names.get(d.name)}" and "${key}")`)
    else names.set(d.name, key)
    if (d.kind === 'code') {
      for (const x of paramDefProblems(d.params)) problems.push(`Definition '${d.name}': ${x}`)
      continue
    }
    for (const c of d.children) {
      const where = `Instance "${c.id}" in '${d.name}'`
      if (!p.defs[c.def]) problems.push(`${where} refers to a missing definition "${c.def}"`)
      if (c.def === p.root) problems.push(`${where} places the root 'Scene', which can't be instanced`)
      const prev = instIds.get(c.id)
      if (prev !== undefined) problems.push(`Duplicate instance id "${c.id}" (in ${nameOf(prev)} and '${d.name}')`)
      else instIds.set(c.id, key)
      const xf = c.xf
      if (!xf || !isVec3(xf.t) || !isVec3(xf.r) || !isVec3(xf.s)) problems.push(`${where}: transform must have t, r and s as three finite numbers`)
      else if (xf.s.some((v) => v === 0)) problems.push(`${where}: scale can't be 0`)
    }
  }
  const cycle = findCycle(p, { codeEdges: false })
  if (cycle) problems.push('Cycle: ' + cycle.map((id) => p.defs[id]?.name ?? id).join(' → '))
  return problems
}
