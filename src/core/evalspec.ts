// §5.2 specs and keys, plus the pure "what to evaluate / what is its status" helpers used by the app controller.
// Shared by both threads (the worker only needs the types and ENGINE).
import type { Definition, GroupOp, Id, Mat4, ParamDef, ParamValue, Project, UiState } from './types'
import type { EvalError } from '../eval/protocol'
import { hash } from './hash'
import { resolveParamDefs, resolveParams } from './params'
import { toMatrix } from './transform'
import { defRefSites, defRefs, indexOccurrences, isPrefix, nameIndex, type Occurrence } from './graph'

export const ENGINE = 'jscad-2.13.0/e2'

export interface CodeSpec  {
  kind: 'code';  defKey: string; def: Id; name: string; code: string; paramDefs: ParamDef[]; deps: Record<string /*literal name*/, DefSpec>
  /** OpenSCAD code (absent = JSCAD) and the files its use / include name */
  lang?: 'openscad'; files?: Record<string, string>
}
export interface GroupSpec { kind: 'group'; defKey: string; def: Id; name: string; op: GroupOp; children: ChildSpec[] }  // visible children only
export interface ChildSpec { spec: DefSpec; params: Record<string, ParamValue>; matrix: Mat4 }
export type DefSpec = CodeSpec | GroupSpec
export interface Job { resultKey: string; spec: DefSpec; params: Record<string, ParamValue> }

/** Thrown (internally, by the build DFS) when a def is reached while already on the stack. */
export class CycleError extends Error {
  /** def ids, first === last, e.g. [d_bolt, d_boltsizes, d_bolt] */
  readonly cycle: Id[]
  readonly names: string[]
  constructor(cycle: Id[], names: string[]) {
    super('Cycle: ' + names.join(' → '))
    this.name = 'CycleError'
    this.cycle = cycle
    this.names = names
  }
}

export interface SpecSet {
  /** The self-contained DefSpec of a def, or undefined when it (or anything it depends on) has a spec error. */
  specOf(defId: Id): DefSpec | undefined
  /**
   * The job that evaluates `defId` with `params` (overrides OR already-resolved params — resolution is idempotent;
   * unknown keys are dropped). Groups always get params {}. undefined when specOf(defId) is undefined.
   */
  jobFor(defId: Id, params?: Record<string, ParamValue>): Job | undefined
  /**
   * Build-time failures by def id (never the root):
   * - cycle members: { kind: 'cycle', message: 'Cycle: Bolt → Bolt sizes → Bolt', def: <member>, line?: the part() call }
   * - unknown part name: { kind: 'dependency', def: <the def whose code names it>, message: 'Unknown part "Nut" — no definition with that name', line, col }
   * - every def depending on one of those: { kind: 'dependency', def: <itself>, message: 'depends on "X" (failed)' }
   * trace = def names from that def down to the innermost failing def.
   */
  specErrors: Map<Id, EvalError>
}

class SpecFail {
  readonly error: EvalError
  constructor(error: EvalError) { this.error = error }
}

/**
 * What of a ParamDef goes into a CodeSpec key: name, type and default (§5.2) — plus a choice's options, because
 * part() overrides are validated against them in the worker (adding an option can turn a failure into a result).
 * min / max / step are UI hints only and stay out.
 */
function paramKeyPart(p: ParamDef): unknown[] {
  return p.type === 'choice' ? [p.name, p.type, p.default, p.options ?? []] : [p.name, p.type, p.default]
}

/**
 * Build the DefSpec of every non-root def (the root is built lazily on request), memoized per def id within this
 * build so a DAG is expanded once. Keys (§5.2):
 *   CodeSpec  defKey = hash(['code', ENGINE, code, paramDefs.map(p => [p.name, p.type, p.default(, p.options)]), sortedDeps.map(([n, s]) => [n, s.defKey])
 *                            (, 'openscad', hash(sortedFiles.map(([path, text]) => [path, text])) for OpenSCAD code)])
 *   GroupSpec defKey = hash(['group', ENGINE, op, children.map(c => [c.spec.defKey, c.params, c.matrix])])
 *   resultKey = hash([defKey, resolvedParams])
 * Names and colors are never part of a key.
 */
const NO_FILES: Record<string, string> = Object.freeze({})
/** The hash of an attached-files map, once per map object: the store keeps an unchanged map the same object across
 *  snapshots, so an unrelated change does not hash up to 16 MB of library text again. */
const filesKeys = new WeakMap<Record<string, string>, string>()
function filesKey(files: Record<string, string>): string {
  let k = filesKeys.get(files)
  if (k === undefined) {
    k = hash(Object.keys(files).sort().map((p) => [p, files[p]]))
    filesKeys.set(files, k)
  }
  return k
}

export function buildSpecs(project: Project): SpecSet {
  const memo = new Map<Id, DefSpec>()
  const errors = new Map<Id, EvalError>()
  const names = nameIndex(project)
  const stack: Id[] = []
  const onStack = new Set<Id>()
  const nameOf = (id: Id) => project.defs[id]?.name ?? id
  const record = (id: Id, e: EvalError) => { if (id !== project.root && !errors.has(id)) errors.set(id, e) }

  const visit = (id: Id): DefSpec => {
    const hit = memo.get(id)
    if (hit) return hit
    const known = errors.get(id)
    if (known) throw new SpecFail(known)
    const def = project.defs[id]
    if (!def) {
      throw new SpecFail({ kind: 'dependency', def: id, defName: id, message: `Missing definition "${id}"`, trace: [id] })
    }
    if (onStack.has(id)) {
      const cycle = [...stack.slice(stack.indexOf(id)), id]
      const cycleNames = cycle.map(nameOf)
      const err = new CycleError(cycle, cycleNames)
      for (let i = 0; i < cycle.length - 1; i++) {
        const m = cycle[i]
        const md = project.defs[m]
        const e: EvalError = { kind: 'cycle', def: m, defName: nameOf(m), message: err.message, trace: cycleNames }
        if (md?.kind === 'code') {
          const site = defRefSites(md).find((s) => s.name === nameOf(cycle[i + 1]))
          if (site) { e.line = site.line; e.col = site.col }
        }
        record(m, e)
      }
      throw err
    }
    stack.push(id)
    onStack.add(id)
    let spec: DefSpec
    try {
      spec = def.kind === 'code' ? buildCode(def) : buildGroup(def)
    } catch (x) {
      if (x instanceof SpecFail || x instanceof CycleError) {
        let own = errors.get(id)
        if (!own) {
          const child: EvalError = x instanceof SpecFail ? x.error
            : errors.get(x.cycle[0]) ?? { kind: 'cycle', def: x.cycle[0], defName: nameOf(x.cycle[0]), message: x.message, trace: x.names }
          const innermost = child.trace[child.trace.length - 1] ?? child.defName
          own = { kind: 'dependency', def: id, defName: def.name, message: `depends on "${innermost}" (failed)`, trace: [def.name, ...child.trace] }
          record(id, own)
        }
        throw new SpecFail(own)
      }
      throw x
    } finally {
      stack.pop()
      onStack.delete(id)
    }
    memo.set(id, spec)
    return spec
  }

  const buildCode = (def: Definition & { kind: 'code' }): CodeSpec => {
    const deps: Record<string, DefSpec> = {}
    const sites = defRefSites(def)
    for (const ref of defRefs(def)) {
      const target = names.get(ref)
      if (!target) {
        const site = sites.find((s) => s.name === ref)
        const e: EvalError = { kind: 'dependency', def: def.id, defName: def.name, message: `Unknown part "${ref}" — no definition with that name`, trace: [def.name] }
        if (site) { e.line = site.line; e.col = site.col }
        record(def.id, e)
        throw new SpecFail(e)
      }
      deps[ref] = visit(target.id)
    }
    const sortedDeps = Object.keys(deps).sort().map((n) => [n, deps[n].defKey])
    const key: unknown[] = ['code', ENGINE, def.code, def.params.map(paramKeyPart), sortedDeps]
    const spec: CodeSpec = { kind: 'code', defKey: '', def: def.id, name: def.name, code: def.code, paramDefs: def.params, deps }
    if (def.lang === 'openscad') {
      key.push('openscad', filesKey(def.files ?? NO_FILES))
      spec.lang = 'openscad'
      if (def.files) spec.files = def.files
    }
    spec.defKey = hash(key)
    return spec
  }

  const buildGroup = (def: Definition & { kind: 'group' }): GroupSpec => {
    const children: ChildSpec[] = []
    for (const c of def.children) {
      if (c.hidden) continue
      const spec = visit(c.def)
      children.push({ spec, params: resolveParams(project.defs[c.def], c.params), matrix: toMatrix(c.xf) })
    }
    const defKey = hash(['group', ENGINE, def.op, children.map((c) => [c.spec.defKey, c.params, c.matrix])])
    return { kind: 'group', defKey, def: def.id, name: def.name, op: def.op, children }
  }

  const tryVisit = (id: Id): DefSpec | undefined => {
    try { return visit(id) } catch (x) { if (x instanceof SpecFail || x instanceof CycleError) return undefined; throw x }
  }
  for (const id of Object.keys(project.defs).sort()) if (id !== project.root) tryVisit(id)

  return {
    specOf: (defId) => (project.defs[defId] ? tryVisit(defId) : undefined),
    jobFor: (defId, params) => {
      const spec = project.defs[defId] ? tryVisit(defId) : undefined
      if (!spec) return undefined
      return makeJob(spec, params)
    },
    specErrors: errors,
  }
}

/** A Job for `spec` (params resolved against spec.paramDefs for code; {} for groups). */
export function makeJob(spec: DefSpec, params?: Record<string, ParamValue>): Job {
  const resolved = spec.kind === 'code' ? resolveParamDefs(spec.paramDefs, params) : {}
  return { resultKey: hash([spec.defKey, resolved]), spec, params: resolved }
}

// ───────────────────────────── wanted jobs (§5.2 "Wanted jobs", §5.5 queue priority) ─────────────────────────────

export interface WantedJobs {
  /** De-duplicated by resultKey. Isolate jobs first, then scene jobs in expansion order. Pass to client.want(). */
  jobs: Job[]
  /** Jobs of the selected def / selected subtree / the isolate target; pass to client.want(). */
  priorityKeys: Set<string>
  /** occurrence key → resultKey, for every occurrence (scene and isolate) that is rendered from its own job. */
  resultKeyOf: Map<string, string>
  /** def id (the job's root def) → resultKeys wanted for it. */
  jobsOfDef: Map<Id, Set<string>>
}

/**
 * Should `occ` be drawn (and evaluated) in the current view? Not hidden, and — if it is an operand — the operands of
 * its nearest boolean ancestor are shown (`shownOperandKeys`, see core/selection.ts shownOperandBools) and that
 * boolean is itself drawn.
 */
export function isOccurrenceShown(occ: Occurrence, byKey: Map<string, Occurrence>, shownOperandKeys: ReadonlySet<string>): boolean {
  let o: Occurrence | undefined = occ
  if (o.hidden) return false
  while (o && o.operandOf !== undefined) {
    if (!shownOperandKeys.has(o.operandOf)) return false
    o = byKey.get(o.operandOf)
    if (o?.hidden) return false
  }
  return true
}

/**
 * The jobs the app wants evaluated right now (§5.2):
 * - each non-hidden `code` or `bool` occurrence not under a boolean,
 * - operand occurrences (code / bool) only while shown (`shownOperandKeys`, §4.4),
 * - the isolate target: pass the result of expand(project, { rootDef, rootParams }) as `isolateOccurrences`
 *   (one job for a code/bool target; a 'none' group target contributes its contents by the same rules).
 * 'none' groups never get jobs (three composes them). Defs with spec errors get no job.
 * Priority: occurrences inside the selected occurrence's subtree, every occurrence of the selected def
 * (occurrence or Library selection), and all isolate jobs.
 * While ui.evalPaused everything is empty (§5.5 "skipped entirely while evalPaused").
 */
export function computeWantedJobs(
  _project: Project,
  specs: SpecSet,
  occurrences: Occurrence[],
  ui: UiState,
  shownOperandKeys: ReadonlySet<string>,
  isolateOccurrences: Occurrence[] = [],
): WantedJobs {
  const out: WantedJobs = { jobs: [], priorityKeys: new Set(), resultKeyOf: new Map(), jobsOfDef: new Map() }
  if (ui.evalPaused) return out
  const seen = new Set<string>()
  const add = (o: Occurrence, byKey: Map<string, Occurrence>, shown: ReadonlySet<string>): string | undefined => {
    if (o.role === 'group') return undefined
    if (!isOccurrenceShown(o, byKey, shown)) return undefined
    const job = specs.jobFor(o.def.id, o.params)
    if (!job) return undefined
    if (!seen.has(job.resultKey)) { seen.add(job.resultKey); out.jobs.push(job) }
    out.resultKeyOf.set(o.key, job.resultKey)
    let s = out.jobsOfDef.get(o.def.id)
    if (!s) out.jobsOfDef.set(o.def.id, (s = new Set()))
    s.add(job.resultKey)
    return job.resultKey
  }
  const isoByKey = indexOccurrences(isolateOccurrences)
  for (const o of isolateOccurrences) {
    // in isolate, boolean operands are never shown (selection paths never point into the isolate tree)
    const k = add(o, isoByKey, new Set())
    if (k) out.priorityKeys.add(k)
  }
  const byKey = indexOccurrences(occurrences)
  for (const o of occurrences) add(o, byKey, shownOperandKeys)

  const sel = ui.selection
  let selDef: Id | undefined
  if (sel.kind === 'def') selDef = sel.def
  if (sel.kind === 'occ') selDef = byKey.get(sel.path.join('/'))?.def.id
  for (const o of occurrences) {
    const k = out.resultKeyOf.get(o.key)
    if (!k) continue
    if ((sel.kind === 'occ' && isPrefix(sel.path, o.path)) || (selDef !== undefined && o.def.id === selDef)) out.priorityKeys.add(k)
  }
  return out
}

// ───────────────────────────── def status (§5.5 "Def status") ─────────────────────────────

/** Tree dot / data-status. idle = no job wanted for it and no error (hidden operands, 'none' groups, unused defs). */
export type DefStatus = 'idle' | 'pending' | 'ok' | 'error'

/** Structural subset of EvalClientApi.get()'s return value. */
export type ResultLookup = { state: 'ready' } | { state: 'pending' } | { state: 'failed'; error: EvalError }

export interface DefEvalState {
  status: DefStatus
  /** The error to show for this def (editor diagnostics when error.def === this def and error.line is set). */
  error?: EvalError
}

const RANK: Record<DefStatus, number> = { idle: 0, ok: 1, pending: 2, error: 3 }
export function worstStatus(a: DefStatus, b: DefStatus): DefStatus { return RANK[a] >= RANK[b] ? a : b }

/**
 * The failure of a result key as seen from def `defId`, whose job has that key. Two defs with identical content
 * (a fresh Ctrl+Shift+D clone, two Cubes from the same template) share one key and ONE job, built from whichever def
 * came first; the error names that def. When the failure is in the job root's own code (its trace has a single
 * entry: timeouts, crashes, runtime / result errors of the root), equal keys mean equal code, so it is this def's own
 * failure too — same message, same line — and is re-attributed to `defId` (its editor gets the diagnostic). A failure
 * deeper down (e.def is a dependency) becomes { kind: 'dependency', message: 'depends on "Bolt" (failed)' }.
 */
export function errorForDef(e: EvalError, defId: Id, defName: string): EvalError {
  if (e.def === defId) return e
  if (e.trace.length <= 1) return { ...e, def: defId, defName, trace: [defName] }
  return { kind: 'dependency', def: defId, defName, message: `depends on "${e.defName}" (failed)`, trace: [defName, ...e.trace.slice(1)] }
}

/**
 * Status and error for every non-root def:
 * - error if any wanted job of the def failed, or any wanted job's failure names it as error.def, or specErrors has it;
 * - otherwise pending if any of its wanted jobs is queued / in flight / not yet known to the client (lookup → undefined);
 * - otherwise ok if it has wanted jobs; otherwise idle.
 * Error choice: specErrors entry, else its own failed job's error (a failure whose error.def is another def becomes
 * { kind: 'dependency', def: <this def>, message: 'depends on "Bolt" (failed)' }), else a failure naming it as error.def.
 */
export function computeDefStates(
  project: Project,
  wanted: WantedJobs,
  specErrors: Map<Id, EvalError>,
  lookup: (resultKey: string) => ResultLookup | undefined,
): Map<Id, DefEvalState> {
  const out = new Map<Id, DefEvalState>()
  for (const id of Object.keys(project.defs)) if (id !== project.root) out.set(id, { status: 'idle' })
  const bump = (id: Id, s: DefStatus, error?: EvalError, strong = false) => {
    const st = out.get(id)
    if (!st) return
    st.status = worstStatus(st.status, s)
    if (error && (!st.error || (strong && st.error.def !== id))) st.error = error
  }
  for (const [defId, keys] of wanted.jobsOfDef) {
    for (const k of keys) {
      const r = lookup(k)
      if (!r || r.state === 'pending') bump(defId, 'pending')
      else if (r.state === 'ready') bump(defId, 'ok')
      else {
        const e = errorForDef(r.error, defId, project.defs[defId]?.name ?? defId)
        const own = r.error.def === defId || r.error.trace.length <= 1 // see errorForDef
        if (own) bump(defId, 'error', e, true)
        else {
          bump(defId, 'error', e)
          bump(r.error.def, 'error', r.error, true)
        }
      }
    }
  }
  for (const [id, e] of specErrors) {
    const st = out.get(id)
    if (!st) continue
    st.status = 'error'
    st.error = e
  }
  return out
}

/** data-status for each tree row: code/bool rows use their def status; every group row takes the worst status of its subtree. */
export function computeRowStatuses(occurrences: Occurrence[], defStates: Map<Id, DefEvalState>): Map<string, DefStatus> {
  const out = new Map<string, DefStatus>()
  for (const o of occurrences) out.set(o.key, o.role === 'group' ? 'idle' : defStates.get(o.def.id)?.status ?? 'idle')
  for (let i = occurrences.length - 1; i >= 0; i--) {
    const o = occurrences[i]
    if (o.parentKey === '' || !out.has(o.parentKey)) continue
    out.set(o.parentKey, worstStatus(out.get(o.parentKey)!, out.get(o.key)!))
  }
  return out
}

// ───────────────────────────── STL items (§6 "Export STL") ─────────────────────────────

export interface StlPlan {
  items: { job: Job; matrix: Mat4 }[]
  /** '<selection name>' or 'scene' — the file is `${project.name}-${label}.stl` (see stlFileName). */
  label: string
  /** names of defs skipped because they have spec errors, or because their evaluation already failed */
  skipped: string[]
}

/**
 * With an occurrence selected: that occurrence's def job with matrix = occurrence.world (nothing if it is hidden).
 * Otherwise every visible top-level instance with its world matrix. Group defs are flattened through GroupSpec
 * (hidden children are already excluded there). Empty items → the caller toasts "Nothing to export".
 * `failed(o)`: the occurrence's own evaluation is known to have failed (the client's failure memo: timeout, crash,
 * runtime error). An item with such an occurrence anywhere in its visible subtree is skipped and the failing def
 * named — sending it again would re-run a known infinite loop inside the STL request and block the evaluator.
 */
export function computeStlItems(specs: SpecSet, occurrences: Occurrence[], ui: UiState, failed: (o: Occurrence) => boolean = () => false): StlPlan {
  const plan: StlPlan = { items: [], label: 'scene', skipped: [] }
  const skip = (name: string) => { if (!plan.skipped.includes(name)) plan.skipped.push(name) }
  const failing = occurrences.filter((x) => !x.hidden && failed(x))
  const push = (o: Occurrence) => {
    const bad = failing.filter((x) => isPrefix(o.path, x.path))
    if (bad.length) { for (const x of bad) skip(x.def.name); return }
    const job = specs.jobFor(o.def.id, o.params)
    if (job) plan.items.push({ job, matrix: o.world })
    else skip(o.def.name)
  }
  if (ui.selection.kind === 'occ') {
    const key = ui.selection.path.join('/')
    const o = occurrences.find((x) => x.key === key)
    if (o) {
      plan.label = o.instance.name ?? o.def.name
      if (!o.hidden) push(o)
      return plan
    }
  }
  for (const o of occurrences) if (o.parentKey === '' && !o.hidden) push(o)
  return plan
}

/** `<project.name>-<label>.stl`, with path separators replaced. */
export function stlFileName(projectName: string, label: string): string {
  return `${projectName}-${label}.stl`.replace(/[/\\]/g, '_')
}
