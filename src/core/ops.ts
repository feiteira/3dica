// §7 core/ops.ts — draft-mutating project operations. Each is (draft: Project, …) => result and throws OpError(message)
// with a user-facing message when refused; on throw the store discards the draft (§4.12), so partial mutation is harmless.
// Every op that adds a child calls wouldCycle first.
import type { CodeDef, Definition, GroupDef, GroupOp, Id, Instance, InstancePath, ParamDef, ParamValue, Project, Transform } from './types'
import { IDENTITY_XF } from './types'
import { newId, uniqueName, MAX_NAME } from './ids'
import { cloneXf, fromMatrix, invert, isIdentityXf, isValidXf, matricesClose, mul, roundOpXf, toMatrix } from './transform'
import { defAtPath, defRefs, findInstance, instancesOf, isPrefix, referrers, resolvePath, wouldCycle, worldMatrix, type PathStep } from './graph'
import { isValidParamValue, paramDefProblems } from './params'
import { checkScadPath, isScad, normalizeScadFiles, SCAD_PARAMS_HINT, scadChoiceOption, scadDefinesPart, scadFileProblem, scadParams, setScadDefault } from './scad'

export class OpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpError'
  }
}

/** What Ctrl+C stores (§4.5): the selected instance's def, xf, params, color and label. */
export interface ClipboardEntry {
  def: Id
  xf: Transform
  params?: Record<string, ParamValue>
  color?: string
  name?: string
}

// ───────────────────────────── validation helpers ─────────────────────────────

/**
 * Problem with a def name (§2.2), or null when valid. `name` is checked as given (callers trim user input first).
 * `selfId` is the def being renamed (its current name does not count as taken).
 */
export function checkDefName(project: Project, name: string, selfId?: Id): string | null {
  if (typeof name !== 'string' || name.length === 0) return "Name can't be empty"
  if (name !== name.trim()) return "Name can't start or end with a space"
  if (name.length > MAX_NAME) return `Name can't be longer than ${MAX_NAME} characters`
  if (/['"`\\\n\r]/.test(name)) return "Name can't contain quotes, backticks, backslashes or line breaks"
  if (name === 'Scene') return "'Scene' is reserved"
  for (const d of Object.values(project.defs)) if (d.id !== selfId && d.name === name) return `'${name}' is already used`
  return null
}

/** '#RRGGBB' / '#rrggbb' → lowercase '#rrggbb'; anything else → null. */
export function normalizeColor(c: unknown): string | null {
  return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : null
}

/** Ctrl+D / paste offset (§4.5): dx = ceil(bboxWidthX + 5), bboxWidthX defaulting to 10 when not evaluated. */
export function linkedOffset(bboxWidthX?: number | null): number {
  const w = typeof bboxWidthX === 'number' && Number.isFinite(bboxWidthX) ? bboxWidthX : 10
  return Math.ceil(w + 5)
}

// ───────────────────────────── internal lookups ─────────────────────────────

function getDef(d: Project, id: Id): Definition {
  const def = d.defs[id]
  if (!def) throw new OpError('That definition no longer exists')
  return def
}

function getScad(d: Project, id: Id): CodeDef {
  const def = getDef(d, id)
  if (!isScad(def)) throw new OpError(`'${def.name}' is not an OpenSCAD object`)
  return def
}

function getGroup(d: Project, id: Id): GroupDef {
  const def = getDef(d, id)
  if (def.kind !== 'group') throw new OpError(`'${def.name}' is not a group`)
  return def
}

function getSteps(d: Project, path: InstancePath): PathStep[] {
  const steps = path.length ? resolvePath(d, path) : null
  if (!steps) throw new OpError('That object no longer exists')
  return steps
}

function getInstance(d: Project, instanceId: Id): { parent: GroupDef; index: number; instance: Instance } {
  const f = findInstance(d, instanceId)
  if (!f) throw new OpError('That object no longer exists')
  return f
}

function groupAtPath(d: Project, path: InstancePath): GroupDef {
  const def = defAtPath(d, path)
  if (!def) throw new OpError('That group no longer exists')
  if (def.kind !== 'group') throw new OpError(`'${def.name}' is not a group`)
  return def
}

function offsetXf(xf: Transform, dx: number): Transform {
  const o = cloneXf(xf)
  o.t[0] += dx
  return o
}

/** Copy the placement fields of an instance (name, params, color) under a new id; hidden is not copied. */
function copyInstance(src: Instance, def: Id, xf: Transform): Instance {
  const out: Instance = { id: newId('i'), def, xf }
  if (src.name !== undefined) out.name = src.name
  if (src.params) out.params = structuredClone(src.params)
  if (src.color !== undefined) out.color = src.color
  return out
}

function clampIndex(index: number, length: number): number {
  return Number.isInteger(index) && index >= 0 && index <= length ? index : length
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

// ───────────────────────────── ops ─────────────────────────────

/**
 * Add a definition (id must be new, name valid and unique, params valid). Returns its id. An OpenSCAD def gets its
 * params derived from its code (whatever it brought) and its attached files checked.
 */
export function addDef(d: Project, def: Definition): Id {
  if (d.defs[def.id]) throw new OpError('Duplicate definition id')
  const problem = checkDefName(d, def.name)
  if (problem) throw new OpError(problem)
  if (def.kind === 'code') {
    if (def.lang !== undefined && def.lang !== 'openscad') throw new OpError('Unknown code language')
    if (def.lang === 'openscad') {
      if (def.files !== undefined) {
        const f = normalizeScadFiles(def.files)
        if (f.problems.length) throw new OpError(f.problems[0])
        if (f.files) def.files = f.files
        else delete def.files
      }
      def.params = scadParams(def.code)
    } else if (def.files !== undefined) throw new OpError('Only OpenSCAD objects have attached files')
    const p = paramDefProblems(def.params)
    if (p.length) throw new OpError(p[0])
  } else {
    for (const c of def.children) if (!d.defs[c.def]) throw new OpError('Unknown child definition')
  }
  d.defs[def.id] = def
  return def.id
}

/**
 * Insert `inst` into group `parentDefId` at `index` (out of range / -1 → append). Refused on a cycle
 * ("Can't put 'Fixture' inside itself"), a duplicate instance id, a missing def or an invalid transform.
 * Returns the index it was inserted at.
 */
export function addInstance(d: Project, parentDefId: Id, index: number, inst: Instance): number {
  const parent = getGroup(d, parentDefId)
  const child = getDef(d, inst.def)
  if (wouldCycle(d, parentDefId, inst.def)) throw new OpError(`Can't put '${child.name}' inside itself`)
  if (findInstance(d, inst.id)) throw new OpError('Duplicate instance id')
  if (!isValidXf(inst.xf)) throw new OpError('Invalid transform')
  const i = clampIndex(index, parent.children.length)
  parent.children.splice(i, 0, inst)
  return i
}

/**
 * Ctrl+D (§4.5): a new instance of the same def (same name, params, color; not hidden) right after the original,
 * offset by +dx along the parent's X. Returns the new occurrence path (same parent path).
 */
export function duplicateLinked(d: Project, path: InstancePath, dx: number): InstancePath {
  const steps = getSteps(d, path)
  const { parent, index, instance } = steps[steps.length - 1]
  const copy = copyInstance(instance, instance.def, offsetXf(instance.xf, dx))
  parent.children.splice(index + 1, 0, copy)
  return [...path.slice(0, -1), copy.id]
}

/** Ctrl+Shift+D (§4.5): cloneDef (shallow) then insert an instance of the clone exactly like duplicateLinked. */
export function duplicateUnique(d: Project, path: InstancePath, dx: number): InstancePath {
  const steps = getSteps(d, path)
  const { parent, index, instance } = steps[steps.length - 1]
  const defId = cloneDef(d, instance.def)
  const copy = copyInstance(instance, defId, offsetXf(instance.xf, dx))
  parent.children.splice(index + 1, 0, copy)
  return [...path.slice(0, -1), copy.id]
}

/**
 * Shallow clone (§4.5): new id, uniqueName ("Fixture 2"), same code, params and color. A group clone copies its
 * children with NEW instance ids and the SAME child defs (children stay linked). Returns the new def id.
 */
export function cloneDef(d: Project, defId: Id): Id {
  const src = getDef(d, defId)
  if (defId === d.root) throw new OpError("The scene can't be copied")
  const id = newId('d')
  const name = uniqueName(src.name, Object.values(d.defs).map((x) => x.name))
  let clone: Definition
  if (src.kind === 'code') {
    const c: CodeDef = { id, name, kind: 'code', code: src.code, params: structuredClone(src.params) }
    if (src.lang) c.lang = src.lang
    if (src.files) c.files = { ...src.files }
    clone = c
  } else {
    clone = { id, name, kind: 'group', op: src.op, children: src.children.map((c) => ({ ...structuredClone(c), id: newId('i') })) }
  }
  if (src.color !== undefined) clone.color = src.color
  d.defs[id] = clone
  return id
}

/**
 * Make unique (§4.5): point this instance at cloneDef(def). Refused unless the def has two or more instance records.
 * Returns the new def id.
 */
export function makeUnique(d: Project, path: InstancePath): Id {
  const steps = getSteps(d, path)
  const { instance, def } = steps[steps.length - 1]
  if (instancesOf(d, instance.def).length < 2) {
    throw new OpError(`Only instance of '${def.name}'. To diverge a copy of a linked group's child, Make Unique the group first.`)
  }
  const id = cloneDef(d, instance.def)
  instance.def = id
  return id
}

/**
 * Ctrl+V / Ctrl+Shift+V (§4.5): append an instance of clip.def (or of cloneDef(clip.def) when `unique`) to the
 * group at `contextPath` ([] = root), with xf = clip.xf offset by +dx in X. Refused if the def is gone or on a cycle
 * ("Can't paste 'Fixture' inside itself"). Returns the new occurrence path.
 */
export function pasteInstance(d: Project, contextPath: InstancePath, clip: ClipboardEntry, unique: boolean, dx: number): InstancePath {
  const target = groupAtPath(d, contextPath)
  const src = d.defs[clip.def]
  if (!src) throw new OpError('The copied object no longer exists')
  if (wouldCycle(d, target.id, clip.def)) throw new OpError(`Can't paste '${src.name}' inside itself`)
  const defId = unique ? cloneDef(d, clip.def) : clip.def
  const inst: Instance = { id: newId('i'), def: defId, xf: offsetXf(clip.xf, dx) }
  if (clip.name !== undefined) inst.name = clip.name
  if (clip.params) inst.params = structuredClone(clip.params)
  if (clip.color !== undefined) inst.color = clip.color
  target.children.push(inst)
  return [...contextPath, inst.id]
}

export interface MoveResult {
  /** the moved (or copied) instance's new occurrence path */
  path: InstancePath
  /** true when fromMatrix returned null (shear) and the local xf was kept → toast "Kept local transform" (§4.8) */
  keptLocal: boolean
}

/**
 * Tree drag and drop (§4.8). Moves (or with `copy`, links a copy of) the instance at `fromPath` into the group at
 * `toParentPath`, inserting at `index` — an index into the target's children as they are BEFORE the removal
 * (out of range / -1 → append); removal before insertion in the same parent is accounted for.
 * World position is preserved: xf = fromMatrix(inv(world(toParentPath)) · world(fromPath)), rounded by roundOpXf
 * (t, r to 1e-6; s to 10 significant digits, so a small scale never becomes 0);
 * when both parents have the same world matrix the xf is kept verbatim. Moving keeps the instance id.
 * Refused when toParentPath is fromPath or inside it, or on a cycle.
 */
export function moveInstance(d: Project, fromPath: InstancePath, toParentPath: InstancePath, index: number, opts: { copy?: boolean } = {}): MoveResult {
  const steps = getSteps(d, fromPath)
  const { parent, index: fromIndex, instance, def } = steps[steps.length - 1]
  const target = groupAtPath(d, toParentPath)
  if (isPrefix(fromPath, toParentPath)) throw new OpError(`Can't move '${instance.name ?? def.name}' into itself`)
  if (wouldCycle(d, target.id, instance.def)) throw new OpError(`Can't move '${def.name}' inside itself`)

  let xf = cloneXf(instance.xf)
  let keptLocal = false
  const srcParentW = worldMatrix(d, fromPath.slice(0, -1))!
  const dstW = worldMatrix(d, toParentPath)!
  if (!matricesClose(srcParentW, dstW)) {
    const inv = invert(dstW)
    const r = inv ? fromMatrix(mul(inv, mul(srcParentW, toMatrix(instance.xf)))) : null
    if (r) xf = roundOpXf(r)
    else keptLocal = true
  }
  if (!isValidXf(xf)) throw new OpError(`Can't move '${instance.name ?? def.name}' there: its transform would become invalid`)

  if (opts.copy) {
    const copy = copyInstance(instance, instance.def, xf)
    target.children.splice(clampIndex(index, target.children.length), 0, copy)
    return { path: [...toParentPath, copy.id], keptLocal }
  }
  let i = clampIndex(index, target.children.length)
  parent.children.splice(fromIndex, 1)
  if (parent === target && fromIndex < i) i -= 1
  instance.xf = xf
  target.children.splice(i, 0, instance)
  return { path: [...toParentPath, instance.id], keptLocal }
}

/** Del on an occurrence (§4.6): remove that instance record from its parent def. The def stays. Returns the record. */
export function removeInstance(d: Project, path: InstancePath): Instance {
  const steps = getSteps(d, path)
  const { parent, index } = steps[steps.length - 1]
  return parent.children.splice(index, 1)[0]
}

/**
 * Del on a Library def (§4.6). Refused for the root, and when code references it:
 * "Can't delete 'Bolt': used by code in 'Bolt sizes'". Otherwise removes the def and every instance with
 * def === id in every group (emptied groups remain). The confirm dialog is the caller's job.
 */
export function deleteDefinition(d: Project, defId: Id): { removedInstances: number } {
  const def = getDef(d, defId)
  if (defId === d.root) throw new OpError("The scene can't be deleted")
  const refs = referrers(d, defId)
  if (refs.length) throw new OpError(`Can't delete '${def.name}': used by code in ${refs.map((r) => `'${d.defs[r].name}'`).join(', ')}`)
  let removed = 0
  for (const g of Object.values(d.defs)) {
    if (g.kind !== 'group') continue
    const before = g.children.length
    g.children = g.children.filter((c) => c.def !== defId)
    removed += before - g.children.length
  }
  delete d.defs[defId]
  return { removedInstances: removed }
}

/** Purge unused (§4.6): repeatedly remove non-root defs with 0 instance records and 0 referrers. Returns the count. */
export function purgeUnused(d: Project): number {
  let total = 0
  for (;;) {
    const used = new Set<Id>()
    for (const g of Object.values(d.defs)) if (g.kind === 'group') for (const c of g.children) used.add(c.def)
    const names = new Set<string>()
    for (const c of Object.values(d.defs)) if (c.kind === 'code') for (const n of defRefs(c)) names.add(n)
    const doomed = Object.values(d.defs).filter((x) => x.id !== d.root && !used.has(x.id) && !referencedByOthers(d, x, names))
    if (doomed.length === 0) return total
    for (const x of doomed) delete d.defs[x.id]
    total += doomed.length
  }
}

function referencedByOthers(d: Project, def: Definition, names: Set<string>): boolean {
  if (!names.has(def.name)) return false
  return referrers(d, def.id).length > 0
}

/**
 * Rename a def (§4.7): trims, validates (§2.2), then rewrites part('Old' / part("Old" in every code def to the new
 * name — in OpenSCAD code also in its attached files, and not at all where the code defines its own `module part`
 * (those calls are not 3Dica references). Returns the ids of code defs whose code (or files) changed (the editor
 * reloads if it shows one). No-op if unchanged.
 */
export function renameDef(d: Project, defId: Id, newName: string): Id[] {
  const def = getDef(d, defId)
  if (defId === d.root) throw new OpError("The scene can't be renamed")
  const name = newName.trim()
  if (name === def.name) return []
  const problem = checkDefName(d, name, defId)
  if (problem) throw new OpError(problem)
  const old = def.name
  def.name = name
  const re = new RegExp(`\\bpart\\(\\s*(['"])${escapeRe(old)}\\1`, 'g')
  // OpenSCAD's scan reads tokens, so it also finds part ("Old" with a space before the parenthesis
  const reScad = new RegExp(`\\bpart(\\s*)\\(\\s*(["'])${escapeRe(old)}\\2`, 'g')
  const changed: Id[] = []
  const rewrite = (text: string) => text.replace(re, (_m, q: string) => `part(${q}${name}${q}`)
  const rewriteScad = (text: string) => text.replace(reScad, (_m, sp: string, q: string) => `part${sp}(${q}${name}${q}`)
  for (const c of Object.values(d.defs)) {
    if (c.kind !== 'code') continue
    let touched = false
    if (isScad(c)) {
      if (scadDefinesPart(c.code, c.files)) continue
      if (c.files) {
        // a new map, never an in-place change: specs and scans cache by the map object
        let files: Record<string, string> | null = null
        for (const [path, text] of Object.entries(c.files)) {
          const next = rewriteScad(text)
          if (next !== text) { (files ??= { ...c.files })[path] = next; touched = true }
        }
        if (files) c.files = files
      }
    }
    const next = isScad(c) ? rewriteScad(c.code) : rewrite(c.code)
    if (next !== c.code) { c.code = next; touched = true }
    if (touched) {
      if (isScad(c)) c.params = scadParams(c.code)
      changed.push(c.id)
    }
  }
  return changed
}

/** Instance label (§4.7): trimmed; empty or undefined clears it (the tree then shows the def name). */
export function setInstanceLabel(d: Project, instanceId: Id, label: string | undefined): void {
  const { instance } = getInstance(d, instanceId)
  const v = (label ?? '').trim()
  if (v) instance.name = v.slice(0, 200)
  else delete instance.name
}

/** Set an instance's local transform (gizmo commit, inspector fields). Rejects non-finite values and zero scale. */
export function setTransform(d: Project, instanceId: Id, xf: Transform): void {
  const { instance } = getInstance(d, instanceId)
  if (!xf || !Array.isArray(xf.s) || xf.s.some((v) => v === 0)) throw new OpError("Scale can't be 0")
  if (!isValidXf(xf)) throw new OpError('Transform values must be finite numbers')
  instance.xf = cloneXf(xf)
}

/** "Invalid value for 'holes': it must be one of "0", "1", "2"" (the part() error says the same). */
function invalidValue(pd: ParamDef): string {
  const what = pd.type === 'number' ? 'a finite number' : pd.type === 'boolean' ? 'true or false' : 'one of ' + (pd.options ?? []).map((o) => JSON.stringify(o)).join(', ')
  return `Invalid value for '${pd.name}': it must be ${what}`
}

/**
 * Set (or with undefined, remove) a parameter override on an instance of a code def (§4.10).
 * The value must suit the ParamDef. Removing a stale (undeclared) key is allowed; setting one is not.
 */
export function setOverride(d: Project, instanceId: Id, name: string, value: ParamValue | undefined): void {
  const { instance } = getInstance(d, instanceId)
  const def = getDef(d, instance.def)
  if (value === undefined) {
    if (instance.params) {
      delete instance.params[name]
      if (Object.keys(instance.params).length === 0) delete instance.params
    }
    return
  }
  if (def.kind !== 'code') throw new OpError('Groups have no parameters')
  const pd = def.params.find((p) => p.name === name)
  if (!pd) throw new OpError(`'${def.name}' has no parameter '${name}'`)
  // an OpenSCAD dropdown also takes its item's value (holes = 3 for // [0, 1, 2, 3]; 30 for // [10:Small, 30:Large])
  if (pd.type === 'choice' && isScad(def) && !isValidParamValue(pd, value)) value = scadChoiceOption(def.code, name, value) ?? value
  if (!isValidParamValue(pd, value)) throw new OpError(invalidValue(pd))
  instance.params = { ...(instance.params ?? {}), [name]: value }
}

/** Instance or def color (§4.10): '#rrggbb' (normalized to lowercase) or undefined to clear. */
export function setColor(d: Project, target: { instance: Id } | { def: Id }, color: string | undefined): void {
  let c: string | null = null
  if (color !== undefined) {
    c = normalizeColor(color)
    if (!c) throw new OpError('Colors must look like #rrggbb')
  }
  const holder: { color?: string } = 'instance' in target ? getInstance(d, target.instance).instance : getDef(d, target.def)
  if (c) holder.color = c
  else delete holder.color
}

/** H / eye icon (§4.11). */
export function setHidden(d: Project, instanceId: Id, hidden: boolean): void {
  const { instance } = getInstance(d, instanceId)
  if (hidden) instance.hidden = true
  else delete instance.hidden
}

/** Alt+H (§4.11): clear every hidden flag. Returns how many were cleared. */
export function unhideAll(d: Project): number {
  let n = 0
  for (const g of Object.values(d.defs)) {
    if (g.kind !== 'group') continue
    for (const c of g.children) if (c.hidden) { delete c.hidden; n++ }
  }
  return n
}

/**
 * Replace a code def's code (§4.10). Never refused for content: a part() cycle or unknown name introduced by
 * typing is reported at evaluation (specErrors), so the user's text is never lost.
 */
export function setCode(d: Project, defId: Id, code: string): void {
  const def = getDef(d, defId)
  if (def.kind !== 'code') throw new OpError(`'${def.name}' is a group and has no code`)
  def.code = String(code)
  // OpenSCAD: the code is the single source of truth for the parameters (Customizer style)
  if (isScad(def)) def.params = scadParams(def.code)
}

/**
 * Replace a code def's ParamDef list (the defaults table, §4.10). Refused with the first problem when invalid, and
 * for OpenSCAD objects, whose parameters come from their code (SCAD_PARAMS_HINT).
 */
export function setParamDefs(d: Project, defId: Id, params: ParamDef[]): void {
  const def = getDef(d, defId)
  if (def.kind !== 'code') throw new OpError('Groups have no parameters')
  if (def.lang === 'openscad') throw new OpError(SCAD_PARAMS_HINT)
  const problems = paramDefProblems(params)
  if (problems.length) throw new OpError(problems[0])
  def.params = structuredClone(params)
}

/**
 * The default of an OpenSCAD object's parameter: rewrites the literal of its top-level assignment in the code
 * (only the literal changes) and derives the params again. The value must suit the ParamDef.
 */
export function setScadParamDefault(d: Project, defId: Id, name: string, value: ParamValue): void {
  const def = getScad(d, defId)
  const pd = def.params.find((p) => p.name === name)
  if (!pd) throw new OpError(`'${def.name}' has no parameter '${name}'`)
  if (pd.type === 'choice' && !isValidParamValue(pd, value)) value = scadChoiceOption(def.code, name, value) ?? value
  if (!isValidParamValue(pd, value)) throw new OpError(invalidValue(pd))
  const next = setScadDefault(def.code, name, value)
  if (next === null) throw new OpError(`Can't change '${name}' in the code of '${def.name}'`)
  def.code = next
  def.params = scadParams(next)
}

/** Attach (or replace) a file of an OpenSCAD object, named by its relative path ('lib/gear.scad'). Returns the stored path. */
export function attachScadFile(d: Project, defId: Id, path: string, text: string): string {
  const def = getScad(d, defId)
  const c = checkScadPath(path)
  if ('problem' in c) throw new OpError(c.problem[0].toUpperCase() + c.problem.slice(1))
  const problem = scadFileProblem(def.files, c.path, text)
  if (problem) throw new OpError(problem)
  def.files = { ...(def.files ?? {}), [c.path]: text }
  def.params = scadParams(def.code)
  return c.path
}

/** Remove an attached file of an OpenSCAD object. */
export function removeScadFile(d: Project, defId: Id, path: string): void {
  const def = getScad(d, defId)
  if (!def.files || !Object.hasOwn(def.files, path)) throw new OpError(`'${def.name}' has no attached file '${path}'`)
  const files = { ...def.files }
  delete files[path]
  if (Object.keys(files).length) def.files = files
  else delete def.files
}

/** Group op selector (§4.10). The root must stay 'none'. */
export function setGroupOp(d: Project, defId: Id, op: GroupOp): void {
  const def = getGroup(d, defId)
  if (defId === d.root && op !== 'none') throw new OpError("The scene can't be a boolean")
  if (!['none', 'union', 'subtract', 'intersect'].includes(op)) throw new OpError('Unknown operation')
  def.op = op
}

const WRAP_NAME: Record<GroupOp, string> = { none: 'Group', union: 'Union', subtract: 'Subtract', intersect: 'Intersect' }

/**
 * Ctrl+G / [∪][−][∩] (§4.2): new GroupDef named Group/Union/Subtract/Intersect (uniqueName) with `op`; the selected
 * instance record (with its xf) becomes its only child; an IDENTITY_XF instance of the group takes its place at the
 * same index. Returns the new group occurrence path (the wrapped child is at [...result, oldInstanceId]).
 */
export function wrapInGroup(d: Project, path: InstancePath, op: GroupOp): InstancePath {
  const steps = getSteps(d, path)
  const { parent, index, instance } = steps[steps.length - 1]
  const gid = newId('d')
  const group: GroupDef = { id: gid, name: uniqueName(WRAP_NAME[op] ?? 'Group', Object.values(d.defs).map((x) => x.name)), kind: 'group', op, children: [instance] }
  d.defs[gid] = group
  const gi: Instance = { id: newId('i'), def: gid, xf: cloneXf(IDENTITY_XF) }
  parent.children.splice(index, 1, gi)
  return [...path.slice(0, -1), gi.id]
}

/**
 * Ctrl+Shift+G (§4.2): replace a group instance by copies of its children (new ids), each with
 * xf = fromMatrix(toMatrix(groupXf) · toMatrix(childXf)) (rounded by roundOpXf). The group instance's color wins over
 * the children's (outermost wins), and a hidden group gives hidden children. The group def stays in the Library.
 * Refused for non-groups and when any child would be sheared. Returns the new occurrence paths in order.
 */
export function ungroup(d: Project, path: InstancePath): InstancePath[] {
  const steps = getSteps(d, path)
  const { parent, index, instance, def } = steps[steps.length - 1]
  if (def.kind !== 'group') throw new OpError(`'${def.name}' is not a group`)
  const gm = toMatrix(instance.xf)
  const identityGroup = isIdentityXf(instance.xf)
  const copies: Instance[] = []
  for (const c of def.children) {
    let xf: Transform
    if (identityGroup) xf = cloneXf(c.xf)
    else {
      const r = fromMatrix(mul(gm, toMatrix(c.xf)))
      if (!r) throw new OpError(`Can't ungroup '${def.name}': a child would be sheared (non-uniform scale with rotation)`)
      xf = roundOpXf(r)
      if (!isValidXf(xf)) throw new OpError(`Can't ungroup '${def.name}': a child's transform would become invalid`)
    }
    const copy = copyInstance(c, c.def, xf)
    const color = instance.color ?? c.color
    if (color !== undefined) copy.color = color
    if (instance.hidden || c.hidden) copy.hidden = true
    copies.push(copy)
  }
  parent.children.splice(index, 1, ...copies)
  const base = path.slice(0, -1)
  return copies.map((c) => [...base, c.id])
}
