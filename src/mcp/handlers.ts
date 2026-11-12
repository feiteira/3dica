// The app side of the MCP tools: one handler per bridge method (the MCP server in mcp/server.mjs forwards tool calls
// here over a local WebSocket). Handlers use the same core ops as the UI, and every change is ONE store.update with a
// history label "MCP: …", so the user can undo the assistant's work with Ctrl+Z. After a change they wait until the
// evaluator is idle (no animation frames involved: the tab may be in the background) and report per-definition
// status, size and errors, so the model learns about failures immediately.
import type { AppContext, Box, CaptureOptions, RenderState } from '../app/context'
import type { Definition, GroupOp, Id, Instance, InstancePath, ParamDef, ParamValue, Project, Transform, UiState, Vec3 } from '../core/types'
import { IDENTITY_XF } from '../core/types'
import * as ops from '../core/ops'
import { linkedOffset, OpError } from '../core/ops'
import {
  defAtPath, expand, instanceAtPath, instancesOf, linkedChangeMessage, occurrenceCounts, pathKey, referrers, staticRefs,
  type Occurrence,
} from '../core/graph'
import { computeStlItems, computeWantedJobs, type Job } from '../core/evalspec'
import type { EvalError } from '../eval/protocol'
import { createTemplateDef, placementFor, type TemplateKind } from '../core/templates'
import { APP_ID, emptyProject, parseProject, serialize } from '../core/project-io'
import { sampleProject, SAMPLE_EXPANDED } from '../core/sample'
import { paramDefProblems } from '../core/params'
import { cloneXf, unionBoxes } from '../core/transform'
import { newId } from '../core/ids'
import { librarySelectPatch, treeSelectPatch } from '../core/selection'
import { describeCapture, drawOverlays, layoutViews, toPngBase64, type ScreenshotView } from './screenshot'

/** A refusal or bad input, reported to the model as a tool error. */
export class McpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpError'
  }
}

export type Handler = (params: Record<string, unknown>) => Promise<unknown>

export interface HandlerOptions {
  /** max time a handler waits for the evaluator after a change (default: eval timeout + 5 s, at most 45 s) */
  settleMs?: number
  /** called with the history label after every request that changed the project */
  onAction?: (label: string) => void
}

const TEMPLATE_KINDS: TemplateKind[] = ['cube', 'sphere', 'cylinder', 'torus', 'code', 'group']
const OPS: GroupOp[] = ['none', 'union', 'subtract', 'intersect']
const WRAP_NAME: Record<GroupOp, string> = { none: 'Group', union: 'Union', subtract: 'Subtract', intersect: 'Intersect' }
const MAX_ERRORS = 20

// ───────────────────────────── small pure helpers (exported for tests) ─────────────────────────────

/** Round away float noise: 1e-4 by default; -0 → 0. */
export function rnd(n: number, step = 1e-4): number {
  if (!Number.isFinite(n)) return n
  return Number((Math.round(n / step) * step).toFixed(6)) + 0
}
const rv = (v: readonly number[], step = 1e-4): Vec3 => [rnd(v[0], step), rnd(v[1], step), rnd(v[2], step)]

export function boxOut(b: Box | null | undefined): { min: Vec3; max: Vec3; size: Vec3 } | null {
  if (!b) return null
  return { min: rv(b.min, 1e-3), max: rv(b.max, 1e-3), size: rv([b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]], 1e-3) }
}

/** An instance path from ["i_a","i_b"] or "i_a/i_b" ([] / "" = the scene root). */
export function toPath(p: unknown, what = 'path'): InstancePath {
  if (Array.isArray(p) && p.every((x) => typeof x === 'string')) return p.filter((x) => x !== '')
  if (typeof p === 'string') return p.split('/').map((s) => s.trim()).filter((s) => s !== '')
  throw new McpError(`${what} must be a list of instance ids like ["i_fx1", "i_b1"] (or "i_fx1/i_b1")`)
}

function vec3(v: unknown, what: string): Vec3 {
  if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) return [v[0], v[1], v[2]]
  throw new McpError(`${what} must be three finite numbers [x, y, z]`)
}

/** Merge a partial {t, r, s} onto `base` (t in mm, r in degrees applied X then Y then Z like OpenSCAD rotate([x,y,z]), s factors). */
export function mergeXf(base: Transform, p: unknown): Transform {
  if (p === undefined || p === null) return cloneXf(base)
  if (typeof p !== 'object' || Array.isArray(p)) throw new McpError('transform must be an object { t?, r?, s? }')
  const o = p as Record<string, unknown>
  for (const k of Object.keys(o)) if (!['t', 'r', 's'].includes(k)) throw new McpError(`transform has no field '${k}' (use t, r, s)`)
  const xf = cloneXf(base)
  if (o.t !== undefined) xf.t = vec3(o.t, 'transform.t')
  if (o.r !== undefined) xf.r = vec3(o.r, 'transform.r')
  if (o.s !== undefined) {
    xf.s = vec3(o.s, 'transform.s')
    if (xf.s.some((x) => x === 0)) throw new McpError("transform.s can't contain 0")
  }
  return xf
}

function errorOut(e: EvalError, ownerId?: Id): Record<string, unknown> {
  const o: Record<string, unknown> = { kind: e.kind, message: e.message }
  if (e.line !== undefined) o.line = e.line
  if (e.col !== undefined) o.col = e.col
  if (ownerId !== undefined && e.def !== ownerId) o.in = e.defName
  if (e.trace.length > 1) o.trace = e.trace
  return o
}

function paramValue(v: unknown, what: string): ParamValue {
  if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || typeof v === 'string') return v
  throw new McpError(`${what} must be a number, true/false or text`)
}

/** Apply { name: value } to the defaults of `params` (a new list). */
export function applyDefaults(params: ParamDef[], defaults: unknown, defName: string): ParamDef[] {
  if (defaults === undefined || defaults === null) return params
  if (typeof defaults !== 'object' || Array.isArray(defaults)) throw new McpError('defaults must be an object like { width: 40 }')
  const out = params.map((p) => ({ ...p }))
  for (const [k, v] of Object.entries(defaults as Record<string, unknown>)) {
    const pd = out.find((p) => p.name === k)
    if (!pd) throw new McpError(`'${defName}' has no parameter '${k}' (it has ${out.map((p) => p.name).join(', ') || 'none'})`)
    pd.default = paramValue(v, `defaults.${k}`)
  }
  const problems = paramDefProblems(out)
  if (problems.length) throw new McpError(problems[0])
  return out
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// ───────────────────────────── handlers ─────────────────────────────

export function createHandlers(ctx: AppContext, opts: HandlerOptions = {}): Record<string, Handler> {
  const settleMs = opts.settleMs ?? Math.min(45_000, (ctx.params?.evalTimeoutMs ?? 20_000) + 5_000)
  const P = (): Project => ctx.store.project
  const U = (): UiState => ctx.store.ui

  const fresh = (): RenderState => {
    const rs = ctx.controller.current()
    return rs.project === P() && rs.ui === U() ? rs : ctx.controller.run()
  }

  /** One undoable step labelled "MCP: <label>". Refusals (OpError) become McpErrors; nothing changes then. */
  const mutate = <T>(label: string, recipe: (d: Project) => T): { value: T; changed: boolean } => {
    ctx.emit('flushCode', undefined) // a half-typed edit of the user is committed first, so it is not lost
    const store = ctx.store
    const prevOnError = store.onError
    store.onError = () => {} // the model gets the message; no error toast for a refused assistant request
    try {
      const r = store.update(`MCP: ${label}`, recipe)
      if (!r.ok) throw new McpError(r.error)
      if (r.changed) opts.onAction?.(`MCP: ${label}`)
      return { value: r.value, changed: r.changed }
    } finally {
      store.onError = prevOnError
    }
  }

  // ── lookups ──

  const defNamed = (name: unknown, what = 'definition'): Definition => {
    if (typeof name !== 'string' || !name) throw new McpError(`${what} must be a definition name`)
    const p = P()
    const d = Object.values(p.defs).find((x) => x.name === name && x.id !== p.root)
    if (d) return d
    const names = Object.values(p.defs).filter((x) => x.id !== p.root).map((x) => x.name)
    throw new McpError(`No definition named '${name}'. Definitions: ${names.slice(0, 40).join(', ') || '(none)'}`)
  }

  const occAt = (rs: RenderState, path: InstancePath): Occurrence => {
    if (path.length === 0) throw new McpError('path is empty (the scene root is not an object)')
    const o = rs.byKey.get(pathKey(path))
    if (!o || o.path[0] === '~iso') throw new McpError(`No object at path ${JSON.stringify(path)}. Call get_scene for the current paths.`)
    return o
  }

  /** Where a new instance goes: { defId of the group, scene path of one occurrence of it (null if none) }. */
  const parentOf = (rs: RenderState, parent: unknown): { defId: Id; path: InstancePath | null } => {
    const p = P()
    if (parent === undefined || parent === null) return { defId: p.root, path: [] }
    if (typeof parent === 'string') {
      const byName = Object.values(p.defs).find((x) => x.name === parent && x.id !== p.root)
      if (byName) {
        if (byName.kind !== 'group') throw new McpError(`'${byName.name}' is not a group`)
        const occ = rs.occurrences.find((o) => o.def.id === byName.id)
        return { defId: byName.id, path: occ ? occ.path : null }
      }
      if (parent === 'Scene') return { defId: p.root, path: [] }
    }
    const path = toPath(parent, 'parent')
    if (path.length === 0) return { defId: p.root, path: [] }
    const o = occAt(rs, path)
    if (o.def.kind !== 'group') throw new McpError(`The object at ${JSON.stringify(path)} ('${o.def.name}') is not a group`)
    return { defId: o.def.id, path }
  }

  const pathOfInstance = (instanceId: Id, under: InstancePath | null): InstancePath | null => {
    const rs = fresh()
    if (under) {
      const o = rs.byKey.get(pathKey([...under, instanceId]))
      if (o) return o.path
    }
    return rs.occurrences.find((o) => o.instance.id === instanceId)?.path ?? null
  }

  // ── evaluation ──

  const busy = (): boolean => {
    const s = ctx.client.stats()
    return !ctx.client.status().fatal && (s.queued > 0 || s.inFlight > 0)
  }

  /** Wait until the evaluator is idle (or `ms` passed). Never uses animation frames. */
  const settle = async (ms = settleMs): Promise<'done' | 'timeout' | 'paused' | 'fatal'> => {
    const deadline = Date.now() + ms
    for (;;) {
      fresh()
      if (U().evalPaused) return 'paused'
      if (ctx.client.status().fatal) return 'fatal'
      if (!busy()) {
        await Promise.resolve() // results may have scheduled a pass that wants more
        fresh()
        if (!busy()) return 'done'
      }
      const left = deadline - Date.now()
      if (left <= 0) return 'timeout'
      await Promise.race([ctx.client.idle(), sleep(Math.min(left, 500))])
    }
  }

  /**
   * Make sure `jobs` are evaluated even if the view does not want them (an isolate screenshot, a definition that is
   * not placed). They are added to the client's wanted set next to the controller's own jobs; release() hands the
   * wanted set back to the controller. Nothing runs while the user paused code ("Open without running").
   */
  const evaluateJobs = async (jobs: Job[], ms = settleMs): Promise<{ release: () => void }> => {
    let added = false
    const release = () => {
      if (!added) return
      added = false
      const rs = fresh()
      ctx.client.want(rs.wanted.jobs, rs.wanted.priorityKeys)
    }
    if (U().evalPaused || jobs.length === 0) return { release }
    const keys = new Set(jobs.map((j) => j.resultKey))
    const deadline = Date.now() + ms
    for (;;) {
      const missing = jobs.filter((j) => { const r = ctx.client.get(j.resultKey); return !r || r.state === 'pending' })
      if (missing.length === 0 || Date.now() > deadline || ctx.client.status().fatal) return { release }
      if (missing.some((j) => ctx.client.get(j.resultKey) === undefined)) {
        const rs = fresh()
        ctx.client.want([...jobs, ...rs.wanted.jobs.filter((j) => !keys.has(j.resultKey))], new Set([...keys, ...rs.wanted.priorityKeys]))
        added = true
      }
      await Promise.race([ctx.client.idle(), sleep(250)])
    }
  }

  const allErrors = (rs: RenderState): Record<string, unknown>[] => {
    const out: Record<string, unknown>[] = []
    for (const [id, st] of rs.defStates) {
      if (st.status !== 'error' || !st.error) continue
      out.push({ definition: rs.project.defs[id]?.name ?? id, ...errorOut(st.error, id) })
    }
    return out
  }

  /** Status, size and problems of `defIds` after a change, plus every error in the project. */
  const report = async (defIds: Id[], settled?: Awaited<ReturnType<typeof settle>>): Promise<Record<string, unknown>> => {
    const state = settled ?? await settle()
    let rs = fresh()
    // a definition nothing draws (not placed, or only inside a group definition with no copies): evaluate it once with
    // its defaults so its errors still show up
    const extra: Job[] = []
    for (const id of defIds) {
      if (!rs.project.defs[id] || rs.wanted.jobsOfDef.has(id) || rs.specs.specErrors.has(id)) continue
      const job = rs.specs.jobFor(id)
      if (job) extra.push(job)
    }
    const hold = state === 'done' ? await evaluateJobs(extra) : { release: () => {} }
    try {
      rs = fresh()
      const counts = rs.counts
      const objects = defIds.filter((id) => rs.project.defs[id]).map((id) => {
        const def = rs.project.defs[id]
        const st = rs.defStates.get(id)
        const o: Record<string, unknown> = { definition: def.name, kind: def.kind === 'group' ? `group (${def.op})` : 'code', status: st?.status ?? 'idle' }
        const keys = [...(rs.wanted.jobsOfDef.get(id) ?? [])]
        const own = extra.find((j) => j.spec.def === id)
        if (own) keys.push(own.resultKey)
        for (const k of keys) {
          const r = ctx.client.get(k)
          if (r?.state === 'ready') {
            if (o.status === 'idle') o.status = 'ok'
            o.triangles = r.entry.tris
            const b = r.entry.bbox
            if (!b.isEmpty()) o.size = rv([b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z], 1e-3)
            if (r.entry.warnings.length) o.warnings = r.entry.warnings
            break
          }
          if (r?.state === 'failed' && !st?.error) { o.status = 'error'; o.error = errorOut(r.error, id) }
        }
        if (st?.error) o.error = errorOut(st.error, id)
        o.copies = counts.get(id) ?? 0
        if (own || o.status === 'idle') {
          const why = (counts.get(id) ?? 0) === 0 ? 'not placed in the scene' : 'not drawn on its own (a plain group, hidden, or an operand of a boolean)'
          o.note = own ? `${why}; evaluated once with its default parameters` : why
        }
        return o
      })
      const errors = allErrors(rs)
      const out: Record<string, unknown> = { evaluation: state }
      if (state === 'paused') out.note = 'Code is paused in the app (the user opened a file without running it). Nothing is evaluated until they click Run code.'
      if (state === 'timeout') out.note = 'Still evaluating; call get_errors or screenshot later to see the result.'
      if (state === 'fatal') out.note = ctx.client.status().fatal
      if (objects.length) out.objects = objects
      out.errors = errors.slice(0, MAX_ERRORS)
      if (errors.length > MAX_ERRORS) out.moreErrors = errors.length - MAX_ERRORS
      return out
    } finally {
      hold.release()
    }
  }

  const linkedNote = (defId: Id | undefined): string | undefined => {
    if (!defId) return undefined
    const p = P()
    if (defId === p.root) return undefined
    return linkedChangeMessage(p, defId) ?? undefined
  }

  const parentDefId = (project: Project, path: InstancePath): Id | undefined =>
    path.length <= 1 ? project.root : defAtPath(project, path.slice(0, -1))?.id

  const defSummary = (rs: RenderState, d: Definition): Record<string, unknown> => {
    const st = rs.defStates.get(d.id)
    const o: Record<string, unknown> = { name: d.name, id: d.id, kind: d.kind }
    if (d.kind === 'group') { o.op = d.op; o.children = d.children.length }
    else o.params = d.params
    if (d.color) o.color = d.color
    o.copies = rs.counts.get(d.id) ?? 0
    o.instances = instancesOf(rs.project, d.id).length
    const used = referrers(rs.project, d.id).map((id) => rs.project.defs[id].name)
    if (used.length) o.usedByCode = used
    if (d.kind === 'code') { const refs = staticRefs(d.code); if (refs.length) o.uses = refs }
    o.status = st?.status ?? 'idle'
    if (st?.error) o.error = errorOut(st.error, d.id)
    return o
  }

  const selectionOut = (ui: UiState): unknown => {
    const s = ui.selection
    if (s.kind === 'occ') return { path: s.path }
    if (s.kind === 'def') return { definition: P().defs[s.def]?.name ?? s.def }
    return null
  }

  /** maxX of the visible children of a group occurrence (toolbar placement, §4.2). */
  const placementX = (path: InstancePath | null, defId: Id): number | null => {
    const def = P().defs[defId]
    if (!path || !def || def.kind !== 'group') return null
    let maxX: number | null = null
    for (const c of def.children) {
      if (c.hidden) continue
      let b: Box | null = null
      try { b = ctx.viewport.occurrenceBox([...path, c.id], 'parent') } catch { b = null }
      if (b && Number.isFinite(b.max[0])) maxX = maxX === null ? b.max[0] : Math.max(maxX, b.max[0])
    }
    return maxX
  }

  const freshUi = (extra: Partial<UiState> = {}): Partial<UiState> => ({
    selection: { kind: 'none' }, context: [], viewMode: 'context', evalPaused: false, autoIsolatedFrom: undefined, expanded: {}, ...extra,
  })

  const frameAllSoon = () => {
    void settle().then(() => { try { ctx.viewport.frameAll() } catch { /* not mounted */ } }).catch(() => {})
  }

  const sceneBoxOf = (occs: Occurrence[]): Box | null => {
    const boxes: (Box | null)[] = []
    for (const o of occs) {
      try { boxes.push(ctx.viewport.occurrenceBox(o.path, 'world')) } catch { boxes.push(null) }
    }
    return unionBoxes(boxes)
  }

  const handlers: Record<string, Handler> = {
    // ───────────── read ─────────────
    async status() {
      const rs = fresh()
      const s = ctx.client.status()
      const h = ctx.store.history.labels()
      let camera: unknown = null
      try { camera = ctx.viewport.getCamera() } catch { camera = null }
      const out: Record<string, unknown> = {
        app: APP_ID,
        url: typeof location !== 'undefined' ? location.href : undefined,
        tabVisible: typeof document !== 'undefined' ? document.visibilityState === 'visible' : undefined,
        project: rs.project.name,
        definitions: Object.keys(rs.project.defs).length - 1,
        occurrences: rs.occurrences.length,
        selection: selectionOut(rs.ui),
        context: rs.ui.context,
        viewMode: rs.ui.viewMode,
        ghostOthers: rs.ui.ghostOthers,
        evalPaused: rs.ui.evalPaused,
        evaluator: { alive: s.alive, queued: s.queued, running: s.running?.defName ?? null, fatal: s.fatal ?? null },
        errors: allErrors(rs).length,
        undo: h.past.slice(-5).reverse(),
        redo: h.future.slice(-5).reverse(),
        camera,
      }
      return out
    },

    async get_scene(p) {
      await settle()
      const rs = fresh()
      const rootPath = p.path === undefined || p.path === null ? [] : toPath(p.path)
      const maxDepth = typeof p.depth === 'number' && p.depth >= 1 ? Math.floor(p.depth) : Infinity
      const maxNodes = typeof p.maxNodes === 'number' && p.maxNodes >= 1 ? Math.floor(p.maxNodes) : 500
      const withBox = p.bbox !== false
      if (rootPath.length) occAt(rs, rootPath)
      const rootKey = pathKey(rootPath)
      let n = 0
      let truncated = false
      const nodes = new Map<string, Record<string, unknown>>()
      const top: Record<string, unknown>[] = []
      for (const o of rs.occurrences) {
        if (rootPath.length && !(o.key === rootKey || o.key.startsWith(rootKey + '/'))) continue
        const depth = o.path.length - rootPath.length + (rootPath.length ? 1 : 0)
        if (depth > maxDepth) continue
        if (n >= maxNodes) { truncated = true; continue }
        n++
        const node: Record<string, unknown> = {
          path: o.path,
          label: o.instance.name ?? o.def.name,
          definition: o.def.name,
          kind: o.def.kind,
        }
        if (o.def.kind === 'group') node.op = o.def.op
        if (o.operandRole) node.operand = o.operandRole
        node.transform = { t: rv(o.instance.xf.t), r: rv(o.instance.xf.r), s: rv(o.instance.xf.s) }
        if (o.instance.color) node.color = o.instance.color
        if (o.instance.params && Object.keys(o.instance.params).length) node.overrides = o.instance.params
        if (o.hidden) node.hidden = true
        node.status = rs.rowStatus.get(o.key) ?? 'idle'
        if (withBox) {
          let b: Box | null = null
          try { b = ctx.viewport.occurrenceBox(o.path, 'world') } catch { b = null }
          node.bbox = boxOut(b)
        }
        nodes.set(o.key, node)
        const parent = nodes.get(o.parentKey)
        if (parent && o.key !== rootKey) ((parent.children ??= []) as Record<string, unknown>[]).push(node)
        else top.push(node)
      }
      const out: Record<string, unknown> = {
        project: rs.project.name,
        units: 'mm, Z up',
        occurrences: rs.occurrences.length,
        selection: selectionOut(rs.ui),
        tree: top,
      }
      if (truncated) out.truncated = `Only the first ${maxNodes} objects are listed — pass path (a subtree), depth or maxNodes`
      return out
    },

    async list_definitions() {
      await settle()
      const rs = fresh()
      const defs = Object.values(rs.project.defs).filter((d) => d.id !== rs.project.root).sort((a, b) => a.name.localeCompare(b.name))
      return { definitions: defs.map((d) => defSummary(rs, d)) }
    },

    async get_definition(p) {
      await settle()
      const rs = fresh()
      const d = defNamed(p.name, 'name')
      const o = defSummary(rs, d)
      if (d.kind === 'code') o.code = d.code
      else {
        o.children = d.children.map((c) => {
          const x: Record<string, unknown> = { id: c.id, definition: rs.project.defs[c.def]?.name ?? c.def }
          if (c.name) x.label = c.name
          x.transform = { t: rv(c.xf.t), r: rv(c.xf.r), s: rv(c.xf.s) }
          if (c.params && Object.keys(c.params).length) x.overrides = c.params
          if (c.color) x.color = c.color
          if (c.hidden) x.hidden = true
          return x
        })
      }
      return o
    },

    async get_errors() {
      await settle()
      const rs = fresh()
      const s = ctx.client.status()
      const out: Record<string, unknown> = { errors: allErrors(rs) }
      if (rs.ui.evalPaused) out.note = 'Code is paused in the app (opened without running); nothing is evaluated.'
      if (s.fatal) out.evaluator = s.fatal
      return out
    },

    // ───────────── create / edit ─────────────
    async create_object(p) {
      const kind = p.kind as TemplateKind
      if (!TEMPLATE_KINDS.includes(kind)) throw new McpError(`kind must be one of ${TEMPLATE_KINDS.join(', ')}`)
      const rs = fresh()
      const project = P()
      const parent = parentOf(rs, p.parent)
      const codeDefs = Object.values(project.defs).filter((d) => d.kind === 'code').length
      const def = createTemplateDef(kind, project, codeDefs)
      if (p.name !== undefined) {
        if (typeof p.name !== 'string') throw new McpError('name must be text')
        def.name = p.name.trim()
      }
      if (def.kind === 'code') {
        if (p.code !== undefined) {
          if (typeof p.code !== 'string') throw new McpError('code must be text')
          def.code = p.code
        }
        if (p.params !== undefined) {
          const problems = paramDefProblems(p.params)
          if (problems.length) throw new McpError(problems[0])
          def.params = structuredClone(p.params as ParamDef[])
        }
        def.params = applyDefaults(def.params, p.defaults, def.name)
        if (p.op !== undefined) throw new McpError('op is only for kind "group"')
      } else {
        if (p.code !== undefined || p.params !== undefined || p.defaults !== undefined) throw new McpError('A group has no code or parameters — add children with add_instance (parent: the group name)')
        if (p.op !== undefined) {
          if (!OPS.includes(p.op as GroupOp)) throw new McpError(`op must be one of ${OPS.join(', ')}`)
          def.op = p.op as GroupOp
        }
      }
      if (p.color !== undefined && p.color !== null) {
        const c = ops.normalizeColor(p.color)
        if (!c) throw new McpError('color must look like #rrggbb')
        def.color = c
      } else if (p.color === null) delete def.color
      const t = p.transform === undefined ? { ...IDENTITY_XF, t: placementFor(kind, placementX(parent.path, parent.defId)) } : IDENTITY_XF
      const inst: Instance = { id: newId('i'), def: def.id, xf: mergeXf(t, p.transform) }
      mutate(`Add ${def.name}`, (d) => {
        ops.addDef(d, def)
        ops.addInstance(d, parent.defId, -1, inst)
      })
      const path = pathOfInstance(inst.id, parent.path)
      const out: Record<string, unknown> = { ok: true, definition: def.name, instanceId: inst.id, path, transform: inst.xf }
      const ln = linkedNote(parent.defId)
      if (ln) out.linked = ln
      if (!path) out.note = `Added inside group '${P().defs[parent.defId]?.name}', which has no copy in the scene yet`
      Object.assign(out, await report([def.id]))
      return out
    },

    async update_definition(p) {
      const def = defNamed(p.name, 'name')
      const fields = ['code', 'params', 'defaults', 'op', 'color', 'rename']
      if (!fields.some((k) => p[k] !== undefined)) throw new McpError(`Nothing to change: pass one of ${fields.join(', ')}`)
      let codeChanged: Id[] = []
      const r = mutate(`Edit ${def.name}`, (d) => {
        const x = d.defs[def.id]
        if (p.code !== undefined) {
          if (typeof p.code !== 'string') throw new OpError('code must be text')
          ops.setCode(d, def.id, p.code)
          codeChanged.push(def.id)
        }
        if (p.params !== undefined) ops.setParamDefs(d, def.id, p.params as ParamDef[])
        if (p.defaults !== undefined) {
          if (x.kind !== 'code') throw new OpError('Groups have no parameters')
          ops.setParamDefs(d, def.id, applyDefaults(x.params, p.defaults, x.name))
        }
        if (p.op !== undefined) {
          if (!OPS.includes(p.op as GroupOp)) throw new OpError(`op must be one of ${OPS.join(', ')}`)
          ops.setGroupOp(d, def.id, p.op as GroupOp)
        }
        if (p.color !== undefined) ops.setColor(d, { def: def.id }, p.color === null ? undefined : String(p.color))
        if (p.rename !== undefined) {
          if (typeof p.rename !== 'string') throw new OpError('rename must be text')
          codeChanged = [...codeChanged, ...ops.renameDef(d, def.id, p.rename)]
        }
      })
      if (codeChanged.length) ctx.emit('codeChanged', { defIds: codeChanged })
      const out: Record<string, unknown> = { ok: true, changed: r.changed, definition: P().defs[def.id]?.name ?? def.name }
      const ln = linkedNote(def.id)
      if (ln) out.linked = ln
      Object.assign(out, await report([def.id]))
      return out
    },

    async add_instance(p) {
      const def = defNamed(p.definition)
      const rs = fresh()
      const parent = parentOf(rs, p.parent)
      const inst: Instance = { id: newId('i'), def: def.id, xf: mergeXf(IDENTITY_XF, p.transform) }
      if (p.label !== undefined && p.label !== null) inst.name = String(p.label).trim().slice(0, 200) || undefined
      if (inst.name === undefined) delete inst.name
      if (p.color !== undefined && p.color !== null) {
        const c = ops.normalizeColor(p.color)
        if (!c) throw new McpError('color must look like #rrggbb')
        inst.color = c
      }
      const index = typeof p.index === 'number' ? Math.floor(p.index) : -1
      mutate(`Add ${def.name}`, (d) => {
        ops.addInstance(d, parent.defId, index, inst)
        if (p.params !== undefined && p.params !== null) {
          if (typeof p.params !== 'object' || Array.isArray(p.params)) throw new OpError('params must be an object like { length: 20 }')
          for (const [k, v] of Object.entries(p.params as Record<string, unknown>)) ops.setOverride(d, inst.id, k, paramValue(v, `params.${k}`))
        }
      })
      const path = pathOfInstance(inst.id, parent.path)
      const out: Record<string, unknown> = { ok: true, instanceId: inst.id, path, definition: def.name }
      const ln = linkedNote(parent.defId)
      if (ln) out.linked = ln
      Object.assign(out, await report([def.id]))
      return out
    },

    async update_instance(p) {
      const rs = fresh()
      const path = toPath(p.path)
      const occ = occAt(rs, path)
      const id = occ.instance.id
      const fields = ['transform', 'params', 'label', 'color', 'hidden']
      if (!fields.some((k) => p[k] !== undefined)) throw new McpError(`Nothing to change: pass one of ${fields.join(', ')}`)
      const name = occ.instance.name ?? occ.def.name
      const r = mutate(`Edit ${name}`, (d) => {
        if (p.transform !== undefined) ops.setTransform(d, id, mergeXf(occ.instance.xf, p.transform))
        if (p.params !== undefined && p.params !== null) {
          if (typeof p.params !== 'object' || Array.isArray(p.params)) throw new OpError('params must be an object like { length: 20 } (null clears one)')
          for (const [k, v] of Object.entries(p.params as Record<string, unknown>)) {
            ops.setOverride(d, id, k, v === null ? undefined : paramValue(v, `params.${k}`))
          }
        }
        if (p.label !== undefined) ops.setInstanceLabel(d, id, p.label === null ? undefined : String(p.label))
        if (p.color !== undefined) ops.setColor(d, { instance: id }, p.color === null ? undefined : String(p.color))
        if (p.hidden !== undefined) ops.setHidden(d, id, !!p.hidden)
      })
      const after = instanceAtPath(P(), path)
      const out: Record<string, unknown> = { ok: true, changed: r.changed, path }
      if (after) {
        out.transform = after.xf
        if (after.params) out.overrides = after.params
      }
      const ln = linkedNote(parentDefId(P(), path))
      if (ln) out.linked = ln
      Object.assign(out, await report([occ.def.id]))
      return out
    },

    async move_instance(p) {
      const rs = fresh()
      const path = toPath(p.path)
      const occ = occAt(rs, path)
      const to = toPath(p.toParent ?? [], 'toParent')
      if (to.length) { const t = occAt(rs, to); if (t.def.kind !== 'group') throw new McpError(`The object at ${JSON.stringify(to)} ('${t.def.name}') is not a group`) }
      const index = typeof p.index === 'number' ? Math.floor(p.index) : -1
      const r = mutate(`Move ${occ.instance.name ?? occ.def.name}`, (d) => ops.moveInstance(d, path, to, index))
      const out: Record<string, unknown> = { ok: true, path: r.value.path, transform: instanceAtPath(P(), r.value.path)?.xf }
      if (r.value.keptLocal) out.note = 'The world position could not be kept (shear); the local transform was kept'
      const ln = linkedNote(defAtPath(P(), to)?.id)
      if (ln) out.linked = ln
      Object.assign(out, await report([occ.def.id]))
      return out
    },

    async duplicate(p) {
      const rs = fresh()
      const path = toPath(p.path)
      const occ = occAt(rs, path)
      const mode = p.mode ?? 'linked'
      if (mode !== 'linked' && mode !== 'unique') throw new McpError('mode must be linked or unique')
      let dx: number
      if (typeof p.offset === 'number' && Number.isFinite(p.offset)) dx = p.offset
      else {
        let b: Box | null = null
        try { b = ctx.viewport.occurrenceBox(path, 'parent') } catch { b = null }
        dx = linkedOffset(b ? b.max[0] - b.min[0] : null)
      }
      const name = occ.instance.name ?? occ.def.name
      const r = mutate(`${mode === 'unique' ? 'Duplicate unique' : 'Duplicate'} ${name}`,
        (d) => (mode === 'unique' ? ops.duplicateUnique(d, path, dx) : ops.duplicateLinked(d, path, dx)))
      const inst = instanceAtPath(P(), r.value)
      const out: Record<string, unknown> = { ok: true, path: r.value, definition: inst ? P().defs[inst.def]?.name : undefined, transform: inst?.xf }
      const ln = linkedNote(parentDefId(P(), r.value))
      if (ln) out.linked = ln
      Object.assign(out, await report(inst ? [inst.def] : []))
      return out
    },

    async make_unique(p) {
      const rs = fresh()
      const path = toPath(p.path)
      const occ = occAt(rs, path)
      const r = mutate(`Make unique ${occ.instance.name ?? occ.def.name}`, (d) => ops.makeUnique(d, path))
      const out: Record<string, unknown> = { ok: true, path, from: occ.def.name, definition: P().defs[r.value]?.name }
      Object.assign(out, await report([r.value]))
      return out
    },

    async wrap(p) {
      const rs = fresh()
      const path = toPath(p.path)
      const occ = occAt(rs, path)
      const op = (p.op ?? 'none') as GroupOp
      if (!OPS.includes(op)) throw new McpError(`op must be one of ${OPS.join(', ')}`)
      if (p.name !== undefined && typeof p.name !== 'string') throw new McpError('name must be text')
      const r = mutate(`Wrap in ${WRAP_NAME[op]}`, (d) => {
        const gp = ops.wrapInGroup(d, path, op)
        if (typeof p.name === 'string' && p.name.trim()) {
          const gi = instanceAtPath(d, gp)!
          ops.renameDef(d, gi.def, p.name)
        }
        return gp
      })
      const gi = instanceAtPath(P(), r.value)
      const out: Record<string, unknown> = { ok: true, path: r.value, group: gi ? P().defs[gi.def]?.name : undefined, child: [...r.value, occ.instance.id] }
      Object.assign(out, await report(gi ? [gi.def] : []))
      return out
    },

    async ungroup(p) {
      const rs = fresh()
      const path = toPath(p.path)
      const occ = occAt(rs, path)
      if (occ.def.kind !== 'group') throw new McpError(`'${occ.def.name}' is not a group`)
      const r = mutate(`Ungroup ${occ.instance.name ?? occ.def.name}`, (d) => ops.ungroup(d, path))
      const out: Record<string, unknown> = { ok: true, paths: r.value }
      Object.assign(out, await report([]))
      return out
    },

    async delete(p) {
      if ((p.path === undefined) === (p.definition === undefined)) throw new McpError('Pass either path (one placed object) or definition (a Library definition)')
      if (p.path !== undefined) {
        const rs = fresh()
        const path = toPath(p.path)
        const occ = occAt(rs, path)
        const name = occ.instance.name ?? occ.def.name
        mutate(`Delete ${name}`, (d) => { ops.removeInstance(d, path) })
        const out: Record<string, unknown> = { ok: true, deleted: name, path }
        const ln = linkedNote(parentDefId(P(), path))
        if (ln) out.linked = ln
        Object.assign(out, await report([]))
        return out
      }
      const def = defNamed(p.definition)
      const project = P()
      const refs = referrers(project, def.id)
      if (refs.length) throw new McpError(`Can't delete '${def.name}': used by code in ${refs.map((r) => `'${project.defs[r].name}'`).join(', ')}`)
      const n = instancesOf(project, def.id).length
      if (n > 0 && p.cascade !== true) {
        const copies = occurrenceCounts(project).get(def.id) ?? 0
        throw new McpError(`'${def.name}' has ${n} ${n === 1 ? 'instance' : 'instances'} (${copies} ${copies === 1 ? 'copy' : 'copies'} in the scene). Pass cascade: true to delete them too.`)
      }
      const r = mutate(`Delete definition ${def.name}`, (d) => ops.deleteDefinition(d, def.id))
      const out: Record<string, unknown> = { ok: true, deleted: def.name, removedInstances: r.value.removedInstances }
      Object.assign(out, await report([]))
      return out
    },

    // ───────────── history ─────────────
    async undo(p) {
      const steps = Math.max(1, Math.min(50, typeof p.steps === 'number' ? Math.floor(p.steps) : 1))
      ctx.emit('flushCode', undefined)
      const done: string[] = []
      for (let i = 0; i < steps; i++) {
        const label = ctx.store.history.undoLabel()
        if (!label || !ctx.store.undo()) break
        done.push(label)
      }
      if (done.length) opts.onAction?.(`MCP: Undo ${done[0].replace(/^MCP: /, '')}`)
      const out: Record<string, unknown> = { ok: done.length > 0, undone: done, canUndo: ctx.store.canUndo(), canRedo: ctx.store.canRedo() }
      if (!done.length) out.note = 'Nothing to undo'
      Object.assign(out, await report([]))
      return out
    },

    async redo(p) {
      const steps = Math.max(1, Math.min(50, typeof p.steps === 'number' ? Math.floor(p.steps) : 1))
      ctx.emit('flushCode', undefined)
      const done: string[] = []
      for (let i = 0; i < steps; i++) {
        const label = ctx.store.history.redoLabel()
        if (!label || !ctx.store.redo()) break
        done.push(label)
      }
      if (done.length) opts.onAction?.(`MCP: Redo ${done[0].replace(/^MCP: /, '')}`)
      const out: Record<string, unknown> = { ok: done.length > 0, redone: done, canUndo: ctx.store.canUndo(), canRedo: ctx.store.canRedo() }
      if (!done.length) out.note = 'Nothing to redo'
      Object.assign(out, await report([]))
      return out
    },

    // ───────────── selection & view (ui only, not in history) ─────────────
    async select(p) {
      if (p.path !== undefined && p.definition !== undefined) throw new McpError('Pass path or definition, not both')
      if (p.path !== undefined) {
        const path = toPath(p.path)
        occAt(fresh(), path)
        ctx.store.setUi((ui) => treeSelectPatch(ui, path))
        try { ctx.viewport.frameIfNeeded(path) } catch { /* not mounted */ }
      } else if (p.definition !== undefined) {
        const def = defNamed(p.definition)
        ctx.store.setUi((ui) => librarySelectPatch(ui, def.id))
      } else {
        ctx.store.setUi({ selection: { kind: 'none' } })
      }
      const ui = U()
      return { ok: true, selection: selectionOut(ui), viewMode: ui.viewMode, context: ui.context }
    },

    async set_view(p) {
      if (p.mode !== undefined) {
        if (p.mode !== 'context' && p.mode !== 'isolate') throw new McpError('mode must be context or isolate')
        if (p.mode === 'isolate' && U().selection.kind === 'none') throw new McpError('Select something first (select tool) — isolate shows the selected object alone')
        ctx.store.setUi({ viewMode: p.mode, autoIsolatedFrom: undefined })
      }
      if (p.ghost !== undefined) ctx.store.setUi({ ghostOthers: !!p.ghost })
      if (p.preset !== undefined) {
        const preset = p.preset
        if (!['front', 'right', 'top', 'iso', 'all', 'selection'].includes(String(preset))) throw new McpError('preset must be one of front, right, top, iso, all, selection')
        try {
          if (preset === 'front' || preset === 'right' || preset === 'top') ctx.viewport.viewPreset(preset)
          else if (preset === 'all') ctx.viewport.frameAll()
          else if (preset === 'selection') ctx.viewport.frameSelection()
          else {
            // iso: keep the target and the distance, look from +X −Y +Z (a jump, like opening a file with a camera)
            const c = ctx.viewport.getCamera()
            const d = Math.hypot(c.position[0] - c.target[0], c.position[1] - c.target[1], c.position[2] - c.target[2]) || 200
            const k = d / Math.sqrt(3)
            ctx.viewport.setCamera({ target: c.target, position: [c.target[0] + k, c.target[1] - k, c.target[2] + k] })
          }
        } catch { /* the view is not mounted */ }
      }
      const ui = U()
      return { ok: true, viewMode: ui.viewMode, ghostOthers: ui.ghostOthers, selection: selectionOut(ui) }
    },

    // ───────────── files ─────────────
    async new_project(p) {
      const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 200) : 'Untitled'
      ctx.emit('flushCode', undefined)
      ctx.store.reset(emptyProject(name), freshUi())
      opts.onAction?.('MCP: New project')
      ctx.toast(`MCP: new empty project '${name}'`)
      return { ok: true, project: name }
    },

    async load_sample() {
      ctx.emit('flushCode', undefined)
      ctx.store.reset(sampleProject(), freshUi({ expanded: { ...SAMPLE_EXPANDED } }))
      opts.onAction?.('MCP: Load sample')
      ctx.toast("MCP: loaded the sample 'Bracket kit'")
      frameAllSoon()
      const out: Record<string, unknown> = { ok: true, project: P().name }
      Object.assign(out, await report([]))
      return out
    },

    async save_project() {
      ctx.emit('flushCode', undefined)
      const project = P()
      let camera: Project['camera']
      try { camera = ctx.viewport.getCamera() } catch { camera = project.camera }
      return { name: project.name, text: serialize(camera ? { ...project, camera } : project) }
    },

    async load_project(p) {
      if (typeof p.text !== 'string') throw new McpError('No file text')
      const parsed = parseProject(p.text)
      if (!parsed.ok) throw new McpError(`Can't open ${typeof p.fileName === 'string' ? p.fileName : 'the file'}:\n- ${parsed.problems.slice(0, 30).join('\n- ')}`)
      const project = parsed.project
      ctx.emit('flushCode', undefined)
      // runs the file's code without the "Run it?" prompt: the request comes from the user's own assistant
      ctx.store.reset(project, freshUi())
      opts.onAction?.(`MCP: Open ${project.name}`)
      ctx.toast(`MCP: opened '${project.name}'`)
      if (project.camera) {
        try { ctx.viewport.setCamera(project.camera) } catch { /* not mounted */ }
      } else frameAllSoon()
      const out: Record<string, unknown> = { ok: true, project: project.name, definitions: Object.keys(project.defs).length - 1 }
      Object.assign(out, await report([]))
      return out
    },

    async export_stl(p) {
      if (U().evalPaused) throw new McpError('Code is paused in the app (opened without running) — the user has to click Run code first')
      ctx.emit('flushCode', undefined)
      await settle()
      const rs = fresh()
      let items: { job: Job; matrix: number[] }[]
      let label: string
      let skipped: string[] = []
      const failed = (o: Occurrence) => {
        const k = rs.wanted.resultKeyOf.get(o.key)
        return k !== undefined && ctx.client.get(k)?.state === 'failed'
      }
      const t = p.target
      const byName = typeof t === 'string' ? Object.values(rs.project.defs).find((d) => d.name === t && d.id !== rs.project.root) : undefined
      if (t === undefined || t === null) {
        const plan = computeStlItems(rs.specs, rs.occurrences, { ...rs.ui, selection: { kind: 'none' } }, failed)
        items = plan.items; label = plan.label; skipped = plan.skipped
      } else if (byName) {
        const job = rs.specs.jobFor(byName.id)
        if (!job) throw new McpError(`'${byName.name}' has an error: ${rs.specs.specErrors.get(byName.id)?.message ?? 'unknown'}`)
        items = [{ job, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }]
        label = byName.name
      } else {
        const path = toPath(t, 'target')
        const occ = occAt(rs, path)
        if (occ.hidden) throw new McpError(`'${occ.instance.name ?? occ.def.name}' is hidden`)
        const plan = computeStlItems(rs.specs, rs.occurrences, { ...rs.ui, selection: { kind: 'occ', path } }, failed)
        items = plan.items; label = plan.label; skipped = plan.skipped
      }
      if (items.length === 0) throw new McpError(skipped.length ? `Nothing to export (${skipped.join(', ')} ${skipped.length === 1 ? 'has' : 'have'} errors)` : 'Nothing to export')
      let res: { parts: ArrayBuffer[]; tris: number }
      try { res = await ctx.client.exportStl(items) } catch (e) { throw new McpError(`STL export failed: ${e instanceof Error ? e.message : String(e)}`) }
      const total = res.parts.reduce((n, b) => n + b.byteLength, 0)
      const bytes = new Uint8Array(total)
      let off = 0
      for (const b of res.parts) { bytes.set(new Uint8Array(b), off); off += b.byteLength }
      return { base64: bytesToBase64(bytes), triangles: res.tris, label, project: rs.project.name, skipped }
    },

    // ───────────── screenshot ─────────────
    async screenshot(p) {
      const width = clampInt(p.width, 800, 16, 2048)
      const height = clampInt(p.height, 600, 16, 2048)
      const view = (p.view ?? 'multi') as ScreenshotView
      if (!['current', 'front', 'right', 'top', 'iso', 'multi'].includes(view)) throw new McpError('view must be one of current, front, right, top, iso, multi')
      const style = p.style ?? 'clean'
      if (style !== 'clean' && style !== 'as-seen') throw new McpError('style must be clean or as-seen')
      const grid = p.grid === undefined ? true : !!p.grid
      const settled = await settle()
      let rs = fresh()
      let root: CaptureOptions['root'] = style === 'as-seen' ? { kind: 'screen' } : { kind: 'scene' }
      let frame: Box | null | undefined
      let shows: string
      const notes: string[] = []
      let hold: { release: () => void } | null = null
      if (p.target !== undefined && p.target !== null) {
        const t = p.target
        const byName = typeof t === 'string' ? Object.values(rs.project.defs).find((d) => d.name === t && d.id !== rs.project.root) : undefined
        let defId: Id
        let params: Record<string, ParamValue> | undefined
        let sceneOccs: Occurrence[]
        let label: string
        if (byName) {
          defId = byName.id
          sceneOccs = rs.occurrences.filter((o) => o.def.id === byName.id && !o.hidden)
          label = `definition '${byName.name}'`
        } else {
          const path = toPath(t, 'target')
          const occ = occAt(rs, path)
          defId = occ.def.id
          params = occ.instance.params
          sceneOccs = [occ]
          label = `'${occ.instance.name ?? occ.def.name}' (path ${pathKey(path)}, definition '${occ.def.name}')`
        }
        frame = p.isolate ? null : sceneBoxOf(sceneOccs)
        if (p.isolate || !frame) {
          if (!p.isolate) notes.push(`${label} is not drawn on its own in the scene (hidden, an operand of a boolean, or not placed), so it is shown isolated`)
          const occs = expand(rs.project, { rootDef: defId, rootParams: params })
          const wanted = computeWantedJobs(rs.project, rs.specs, [], { ...rs.ui, selection: { kind: 'none' }, evalPaused: false }, new Set(), occs)
          hold = await evaluateJobs(wanted.jobs)
          rs = fresh()
          root = { kind: 'isolate', occurrences: occs, resultKeyOf: wanted.resultKeyOf }
          frame = undefined
          shows = `${label} alone at the origin${byName ? ' with its default parameters' : params ? ' with this copy\'s parameter overrides' : ''}`
        } else {
          if (root.kind === 'screen') root = { kind: 'scene' }
          shows = `${label}, framed in the scene${sceneOccs.length > 1 ? ` (${sceneOccs.length} copies)` : ''}`
        }
      } else if (style === 'as-seen') {
        shows = rs.isolate ? `what the user sees: isolate view of '${rs.project.defs[rs.isolate.defId]?.name}'` : 'what the user sees (the scene)'
      } else {
        const tops = rs.occurrences.filter((o) => o.parentKey === '' && !o.hidden).length
        shows = `the whole scene (${tops} visible top-level ${tops === 1 ? 'object' : 'objects'})`
      }
      try {
        const views = layoutViews(view, width, height)
        let cap
        try {
          cap = ctx.viewport.capture({ width, height, views, root, clean: style === 'clean', grid, gizmo: style === 'as-seen' && view === 'current', frame })
        } catch (e) {
          throw new McpError(e instanceof Error ? e.message : String(e))
        }
        drawOverlays(cap.canvas, cap.views, { labels: view === 'multi' || style === 'clean', scale: style === 'clean' || view === 'multi' })
        const image = toPngBase64(cap.canvas)
        const errors = allErrors(fresh())
        const text = describeCapture({ cap, view, style, grid, width, height, shows, notes, errors, evaluation: settled, paused: U().evalPaused })
        return { image, mimeType: 'image/png', text }
      } finally {
        hold?.release()
      }
    },
  }
  return handlers
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : dflt
  return Math.max(min, Math.min(max, n))
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(s)
}
