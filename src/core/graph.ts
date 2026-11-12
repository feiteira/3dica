// §7 graph.ts + §5.1 expansion. Pure queries over a Project; nothing here mutates.
import type { Definition, GroupDef, Id, Instance, InstancePath, Mat4, ParamValue, Project } from './types'
import { IDENTITY_XF } from './types'
import { identity, mul, toMatrix } from './transform'
import { resolveParams } from './params'

// ───────────────────────────── paths ─────────────────────────────

/** path.join('/') — the occurrence key, tree row data-path and UiState.expanded key. */
export function pathKey(path: InstancePath): string { return path.join('/') }
/** Inverse of pathKey ('' → []). */
export function parsePathKey(key: string): InstancePath { return key === '' ? [] : key.split('/') }
/** True when `prefix` is a (non-strict) prefix of `path`. */
export function isPrefix(prefix: InstancePath, path: InstancePath): boolean {
  if (prefix.length > path.length) return false
  for (let i = 0; i < prefix.length; i++) if (prefix[i] !== path[i]) return false
  return true
}
export function samePath(a: InstancePath, b: InstancePath): boolean { return a.length === b.length && isPrefix(a, b) }

export interface PathStep {
  parent: GroupDef        // the group def that holds the instance
  index: number           // index of the instance in parent.children
  instance: Instance
  def: Definition         // the def the instance places
}

/** Walk `path` from `rootDef` (default project.root). null if any step does not resolve. [] → []. */
export function resolvePath(project: Project, path: InstancePath, rootDef: Id = project.root): PathStep[] | null {
  const steps: PathStep[] = []
  let cur = project.defs[rootDef]
  for (const id of path) {
    if (!cur || cur.kind !== 'group') return null
    const index = cur.children.findIndex((c) => c.id === id)
    if (index < 0) return null
    const instance = cur.children[index]
    const def = project.defs[instance.def]
    if (!def) return null
    steps.push({ parent: cur, index, instance, def })
    cur = def
  }
  return steps
}

/** Longest prefix of `path` that resolves (§4.12 fixSelection). */
export function validPrefix(project: Project, path: InstancePath): InstancePath {
  let cur = project.defs[project.root]
  const out: InstancePath = []
  for (const id of path) {
    if (!cur || cur.kind !== 'group') break
    const inst = cur.children.find((c) => c.id === id)
    if (!inst || !project.defs[inst.def]) break
    out.push(id)
    cur = project.defs[inst.def]
  }
  return out
}

/** The def an occurrence path places; [] → the root def. undefined if the path does not resolve. */
export function defAtPath(project: Project, path: InstancePath): Definition | undefined {
  if (path.length === 0) return project.defs[project.root]
  const steps = resolvePath(project, path)
  return steps ? steps[steps.length - 1].def : undefined
}

/** The instance at the end of `path`, or undefined. */
export function instanceAtPath(project: Project, path: InstancePath): Instance | undefined {
  if (path.length === 0) return undefined
  const steps = resolvePath(project, path)
  return steps ? steps[steps.length - 1].instance : undefined
}

/** Instance ids are unique across the project: find the record anywhere. */
export function findInstance(project: Project, instanceId: Id): { parent: GroupDef; index: number; instance: Instance } | null {
  for (const d of Object.values(project.defs)) {
    if (d.kind !== 'group') continue
    const index = d.children.findIndex((c) => c.id === instanceId)
    if (index >= 0) return { parent: d, index, instance: d.children[index] }
  }
  return null
}

/** parentWorld product of toMatrix(xf) along `path` ([] → identity). null if the path does not resolve. */
export function worldMatrix(project: Project, path: InstancePath): Mat4 | null {
  const steps = resolvePath(project, path)
  if (!steps) return null
  let m = identity()
  for (const s of steps) m = mul(m, toMatrix(s.instance.xf))
  return m
}

// ───────────────────────────── names and refs ─────────────────────────────

const PART_RE = /\bpart\(\s*(['"])((?:(?!\1).)+)\1/g

/**
 * `code` with the text of every // and /* *\/ comment replaced by spaces (newlines kept, so offsets, lines and
 * columns are unchanged). String and template literals are copied verbatim. Used by the static part() scan so that
 * a commented-out call — or the blank Code template's own header, "part('Name', { param: value }) returns …" —
 * is not a dependency. Regular-expression literals are copied verbatim too, so a `//` or a quote inside one
 * (`/\/\//`, `/"/g`) neither starts a comment nor a string. A `/` starts a regex where an expression may begin:
 * after an operator or punctuation (not `)`, `]`, a postfix `++` / `--` or a number's `.`), at the start, or after a
 * keyword such as `return`.
 */
export function blankComments(code: string): string {
  let out = ''
  let i = 0
  const n = code.length
  /** index of the last significant (non-space, non-comment) character copied, -1 at the start */
  let last = -1
  const regexAllowed = (): boolean => {
    if (last < 0) return true
    const p = code[last]
    if (/[A-Za-z0-9_$]/.test(p)) {
      let s = last
      while (s > 0 && /[A-Za-z0-9_$]/.test(code[s - 1])) s--
      return REGEX_KEYWORDS.has(code.slice(s, last + 1))
    }
    // `k++ / 2`, `k-- / 2` (postfix: an operand ends there) and `2. / 3` (a number) are divisions
    if ((p === '+' || p === '-') && code[last - 1] === p) return false
    if (p === '.' && last > 0 && /[0-9]/.test(code[last - 1])) return false
    return p !== ')' && p !== ']' && p !== '"' && p !== "'" && p !== '`'
  }
  while (i < n) {
    const c = code[i]
    const next = code[i + 1]
    if (c === '/' && next === '/') {
      while (i < n && code[i] !== '\n') { out += ' '; i++ }
    } else if (c === '/' && next === '*') {
      out += '  '
      i += 2
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) { out += code[i] === '\n' ? '\n' : ' '; i++ }
      if (i < n) { out += '  '; i += 2 }
    } else if (c === '"' || c === "'" || c === '`') {
      out += c
      i++
      while (i < n && code[i] !== c) {
        if (c !== '`' && code[i] === '\n') break // unterminated '…' / "…": stop at the line end
        if (code[i] === '\\' && i + 1 < n) { out += code[i] + code[i + 1]; i += 2; continue }
        out += code[i]
        i++
      }
      if (i < n && code[i] === c) { out += c; i++ }
      last = i - 1
    } else if (c === '/' && regexAllowed()) {
      // a regex literal: up to the closing / outside a [...] class, never past the line end
      out += c
      i++
      let inClass = false
      while (i < n && code[i] !== '\n') {
        const d = code[i]
        if (d === '\\' && i + 1 < n && code[i + 1] !== '\n') { out += d + code[i + 1]; i += 2; continue }
        out += d
        i++
        if (d === '[') inClass = true
        else if (d === ']') inClass = false
        else if (d === '/' && !inClass) break
      }
      last = i - 1
    } else {
      out += c
      if (!/\s/.test(c)) last = i
      i++
    }
  }
  return out
}

/** Keywords after which a `/` starts a regular expression rather than a division. */
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await'])

/** Def names referenced by `part('Name'` / `part("Name"` string literals outside comments, unique, in order of first appearance (§3.1). */
export function staticRefs(code: string): string[] {
  const out: string[] = []
  for (const m of blankComments(code).matchAll(PART_RE)) if (!out.includes(m[2])) out.push(m[2])
  return out
}

/** Every static ref (outside comments) with its 1-based line/col of the `part(` call (for diagnostics on unknown names). */
export function staticRefSites(code: string): { name: string; line: number; col: number }[] {
  const out: { name: string; line: number; col: number }[] = []
  code = blankComments(code)
  for (const m of code.matchAll(PART_RE)) {
    const before = code.slice(0, m.index)
    const line = before.split('\n').length
    const col = m.index - before.lastIndexOf('\n')
    out.push({ name: m[2], line, col })
  }
  return out
}

/** name → def (all defs, including the root "Scene"). */
export function nameIndex(project: Project): Map<string, Definition> {
  const m = new Map<string, Definition>()
  for (const d of Object.values(project.defs)) m.set(d.name, d)
  return m
}

export function defByName(project: Project, name: string): Definition | undefined {
  for (const d of Object.values(project.defs)) if (d.name === name) return d
  return undefined
}

/** Ids of code defs (other than `defId` itself) whose code has part('<name of defId>'). §4.6 delete guard. */
export function referrers(project: Project, defId: Id): Id[] {
  const def = project.defs[defId]
  if (!def) return []
  const out: Id[] = []
  for (const d of Object.values(project.defs)) {
    if (d.id !== defId && d.kind === 'code' && staticRefs(d.code).includes(def.name)) out.push(d.id)
  }
  return out.sort()
}

/** Every instance record placing `defId`, across all groups. */
export function instancesOf(project: Project, defId: Id): { parent: Id; index: number; instance: Instance }[] {
  const out: { parent: Id; index: number; instance: Instance }[] = []
  for (const d of Object.values(project.defs)) {
    if (d.kind !== 'group') continue
    d.children.forEach((c, index) => { if (c.def === defId) out.push({ parent: d.id, index, instance: c }) })
  }
  return out
}

/**
 * Number of occurrences of every def in the scene expansion (root = 1; hidden instances count; unused = 0).
 * Computed by DP over the DAG, so it is cheap even when the expansion is huge. part() uses do not count.
 */
export function occurrenceCounts(project: Project): Map<Id, number> {
  const parents = new Map<Id, Map<Id, number>>() // child def → (parent def → multiplicity)
  for (const d of Object.values(project.defs)) {
    if (d.kind !== 'group') continue
    for (const c of d.children) {
      let m = parents.get(c.def)
      if (!m) parents.set(c.def, (m = new Map()))
      m.set(d.id, (m.get(d.id) ?? 0) + 1)
    }
  }
  const memo = new Map<Id, number>()
  const busy = new Set<Id>()
  const count = (id: Id): number => {
    if (id === project.root) return 1
    const hit = memo.get(id)
    if (hit !== undefined) return hit
    if (busy.has(id)) return 0 // cycle guard (invalid projects only)
    busy.add(id)
    let n = 0
    for (const [p, mult] of parents.get(id) ?? []) n += mult * count(p)
    busy.delete(id)
    memo.set(id, n)
    return n
  }
  const out = new Map<Id, number>()
  for (const id of Object.keys(project.defs)) out.set(id, count(id))
  return out
}

export function occurrenceCount(project: Project, defId: Id): number {
  return occurrenceCounts(project).get(defId) ?? 0
}

/**
 * Outgoing edges of the def graph (§2.2): group → each child def (hidden too), code → each def named by staticRefs.
 * Unknown names are skipped. `codeEdges: false` gives the structural (group-only) graph.
 */
export function defEdges(project: Project, defId: Id, opts: { codeEdges?: boolean; names?: Map<string, Definition> } = {}): Id[] {
  const d = project.defs[defId]
  if (!d) return []
  if (d.kind === 'group') return [...new Set(d.children.map((c) => c.def))]
  if (opts.codeEdges === false) return []
  const names = opts.names ?? nameIndex(project)
  const out: Id[] = []
  for (const n of staticRefs(d.code)) { const t = names.get(n); if (t && !out.includes(t.id)) out.push(t.id) }
  return out
}

/** True if `to` is reachable from `from` (from === to counts). */
function reachable(project: Project, from: Id, to: Id, codeEdges: boolean): boolean {
  const names = nameIndex(project)
  const seen = new Set<Id>()
  const stack = [from]
  while (stack.length) {
    const id = stack.pop()!
    if (id === to) return true
    if (seen.has(id)) continue
    seen.add(id)
    for (const e of defEdges(project, id, { codeEdges, names })) stack.push(e)
  }
  return false
}

/**
 * Would placing an instance of `childDefId` inside group `parentDefId` create a cycle (including part() edges)?
 * Also true when the child is the root (the root is never instanced).
 */
export function wouldCycle(project: Project, parentDefId: Id, childDefId: Id): boolean {
  if (childDefId === project.root) return true
  return reachable(project, childDefId, parentDefId, true)
}

/**
 * A cycle as a def id list that starts and ends with the same id (e.g. [a, b, a]), or null.
 * `codeEdges` (default true) includes part() edges; parseProject uses `false` (see project-io.ts).
 */
export function findCycle(project: Project, opts: { codeEdges?: boolean } = {}): Id[] | null {
  const codeEdges = opts.codeEdges !== false
  const names = nameIndex(project)
  const state = new Map<Id, 1 | 2>() // 1 = on stack, 2 = done
  const stack: Id[] = []
  const visit = (id: Id): Id[] | null => {
    state.set(id, 1)
    stack.push(id)
    for (const e of defEdges(project, id, { codeEdges, names })) {
      const s = state.get(e)
      if (s === 1) return [...stack.slice(stack.indexOf(e)), e]
      if (s === undefined && project.defs[e]) { const c = visit(e); if (c) return c }
    }
    stack.pop()
    state.set(id, 2)
    return null
  }
  for (const id of Object.keys(project.defs).sort()) {
    if (!state.has(id)) { const c = visit(id); if (c) return c }
  }
  return null
}

/** §4.2 / §4.5 linked toast: "Changed 'Fixture' — 2 copies updated" when a non-root def has > 1 occurrence, else null. */
export function linkedChangeMessage(project: Project, defId: Id, verb: 'Changed' | 'Added to' = 'Changed'): string | null {
  if (defId === project.root) return null
  const def = project.defs[defId]
  if (!def) return null
  const n = occurrenceCount(project, defId)
  return n > 1 ? `${verb} '${def.name}' — ${n} copies updated` : null
}

// ───────────────────────────── expansion (§5.1) ─────────────────────────────

/** How an operand occurrence is drawn while its boolean's operands are shown (§4.4, view/materials states). */
export type OperandRole = 'base' | 'cut' | 'other'

export interface Occurrence {
  key: string                 // path.join('/')
  path: InstancePath; parentKey: string   // '' = top level
  instance: Instance; def: Definition
  role: 'code' | 'group' | 'bool'         // group = op 'none'; bool = union/subtract/intersect
  hidden: boolean             // effective: true if it or any ancestor is hidden
  operandOf?: string          // key of the nearest boolean ancestor
  world: Mat4                 // parentWorld · toMatrix(xf)
  params: Record<string, ParamValue>   // resolveParams(def, instance.params); {} for groups
  colorFromInstance?: string  // outermost instance color on the path
  // ── additions beyond the §5.1 listing ──
  parentDef: Id               // def id of the group holding `instance`; '' for the synthetic isolate occurrence
  index: number               // index of `instance` in the parent's children
  /** Only when operandOf is set: 'base' = under the first visible child of the nearest boolean, 'cut' = under another child of a
   *  subtract, 'other' = under a later child of a union / intersect. */
  operandRole?: OperandRole
}

/** Path id of the synthetic identity instance used by isolate expansion. Not a valid instance id, so it never collides. */
export const ISOLATE_INSTANCE_ID = '~iso'
export const MAX_DEPTH = 32
export const MAX_OCCURRENCES = 5000

export interface ExpandOptions {
  /** Isolate mode: expand a synthetic identity instance of this def (path [ISOLATE_INSTANCE_ID]) instead of the root's children. */
  rootDef?: Id
  /** Overrides for the synthetic instance (an occurrence's instance.params, or undefined for def defaults). */
  rootParams?: Record<string, ParamValue>
  /** Called at most once per kind per call when a cap (depth 32 / 5,000 occurrences) truncates the expansion. */
  onCap?: (cap: 'depth' | 'count') => void
}

/**
 * Depth-first pre-order walk (parent before children, children in order) starting at the root's children,
 * or at a synthetic identity instance of `opts.rootDef`. Descends into boolean groups too (their occurrences
 * carry operandOf). Past depth 32 a branch is cut; past 5,000 occurrences expansion stops.
 */
export function expand(project: Project, opts: ExpandOptions = {}): Occurrence[] {
  const out: Occurrence[] = []
  const capped = new Set<'depth' | 'count'>()
  const cap = (k: 'depth' | 'count') => { if (!capped.has(k)) { capped.add(k); opts.onCap?.(k) } }
  let stopped = false

  interface BoolCtx { key: string; role?: OperandRole; op: 'union' | 'subtract' | 'intersect' }

  const visit = (inst: Instance, parentDef: Id, index: number, parentPath: InstancePath, parentKey: string, parentWorld: Mat4,
    parentHidden: boolean, bool: BoolCtx | undefined, color: string | undefined): void => {
    if (stopped) return
    const def = project.defs[inst.def]
    if (!def) return
    const path = [...parentPath, inst.id]
    if (path.length > MAX_DEPTH) { cap('depth'); return }
    if (out.length >= MAX_OCCURRENCES) { cap('count'); stopped = true; return }
    const key = pathKey(path)
    const role = def.kind === 'code' ? 'code' : def.op === 'none' ? 'group' : 'bool'
    const world = mul(parentWorld, toMatrix(inst.xf))
    const hidden = parentHidden || !!inst.hidden
    const colorFromInstance = color ?? inst.color
    const occ: Occurrence = {
      key, path, parentKey, instance: inst, def, role, hidden, world,
      params: resolveParams(def, inst.params), parentDef, index,
    }
    if (colorFromInstance !== undefined) occ.colorFromInstance = colorFromInstance
    if (bool) { occ.operandOf = bool.key; occ.operandRole = bool.role }
    out.push(occ)
    if (def.kind !== 'group') return
    // the engine drops hidden children (GroupSpec lists visible ones only), so the base of a subtract is the FIRST
    // VISIBLE child, not child 0 — the operand display must say the same
    const base = def.children.findIndex((c) => !c.hidden)
    def.children.forEach((child, i) => {
      let next: BoolCtx | undefined = bool
      if (def.op !== 'none') next = { key, op: def.op, role: i === base ? 'base' : def.op === 'subtract' ? 'cut' : 'other' }
      visit(child, def.id, i, path, key, world, hidden, next, colorFromInstance)
    })
  }

  if (opts.rootDef !== undefined) {
    if (!project.defs[opts.rootDef]) return out
    const synthetic: Instance = { id: ISOLATE_INSTANCE_ID, def: opts.rootDef, xf: IDENTITY_XF }
    if (opts.rootParams) synthetic.params = opts.rootParams
    visit(synthetic, '', 0, [], '', identity(), false, undefined, undefined)
  } else {
    const root = project.defs[project.root]
    if (root?.kind === 'group') root.children.forEach((c, i) => visit(c, root.id, i, [], '', identity(), false, undefined, undefined))
  }
  return out
}

/** Map occurrences by key. */
export function indexOccurrences(occs: Occurrence[]): Map<string, Occurrence> {
  const m = new Map<string, Occurrence>()
  for (const o of occs) m.set(o.key, o)
  return m
}
