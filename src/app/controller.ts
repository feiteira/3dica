// src/app/controller.ts — the render loop between the store, the evaluator and the view (contract: ControllerApi).
// One pass (§5.1, §5.2, §5.5, §4.4):
//  1. project changed → specs = buildSpecs, occurrences = expand (cap → one toast per session), counts
//  2. isolate target → its own expansion + banner
//  3. shown boolean operands
//  4. wanted jobs (scene + shown operands + isolate target; priority = selection subtree / selected def / isolate)
//  5. client.want(...) when the wanted keys or the priority changed (empty while evalPaused)
//  6. def states (§5.5 "Def status") and tree row statuses
//  7. viewport.reconcile(state); emit 'render'
// Passes are scheduled on a microtask after any store change and after client.onChange; calls coalesce.
import type { AppContext, ControllerApi, IsolateView, RenderState } from './context'
import type { Id, Project } from '../core/types'
import { expand, indexOccurrences, occurrenceCounts, type Occurrence } from '../core/graph'
import { buildSpecs, computeDefStates, computeRowStatuses, computeWantedJobs, type SpecSet } from '../core/evalspec'
import { isolateBanner, isolateTarget, shownOperandBools } from '../core/selection'

const CAP_MESSAGE = {
  depth: 'The scene is nested deeper than 32 levels — deeper objects are not shown',
  count: 'The scene has more than 5,000 occurrences — the rest are not shown',
} as const

const nextFrame = (): Promise<void> => new Promise((resolve) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
  else setTimeout(resolve, 16)
})

export function createController(ctx: AppContext): ControllerApi {
  let state: RenderState | null = null
  let version = 0
  let scheduled = false
  let running = false
  let again = false

  // per-project caches (step 1)
  let lastProject: Project | null = null
  let specs: SpecSet | null = null
  let occurrences: Occurrence[] = []
  let sceneByKey = new Map<string, Occurrence>()
  let counts = new Map<Id, number>()
  const capsToasted = new Set<'depth' | 'count'>()
  const onCap = (cap: 'depth' | 'count') => {
    if (capsToasted.has(cap)) return
    capsToasted.add(cap)
    // never toast from inside a pass synchronously (a toast is DOM work, but keep passes side-effect free)
    queueMicrotask(() => ctx.toast(CAP_MESSAGE[cap], 'warn'))
  }

  // isolate cache (step 2): same project + same target → reuse the expansion
  let isoSig = ''
  let isolate: IsolateView | null = null

  // step 5: what the client was last told
  let wantSig: string | null = null

  const pass = (): RenderState => {
    const project = ctx.store.project
    const ui = ctx.store.ui

    // 1
    if (project !== lastProject || !specs) {
      specs = buildSpecs(project)
      occurrences = expand(project, { onCap })
      sceneByKey = indexOccurrences(occurrences)
      counts = occurrenceCounts(project)
      lastProject = project
      isoSig = ''
    }

    // 2
    const t = isolateTarget(project, ui)
    const sig = t ? t.defId + '|' + JSON.stringify(t.params ?? null) : ''
    if (!t) { isolate = null; isoSig = '' }
    else if (sig !== isoSig || !isolate) {
      const def = project.defs[t.defId]
      const isoOccs = expand(project, { rootDef: t.defId, rootParams: t.params, onCap })
      isolate = { defId: t.defId, occurrences: isoOccs, banner: isolateBanner(def, t.params) }
      if (t.params) isolate.params = t.params
      isoSig = sig
    }

    // 3
    const shownOperands = shownOperandBools(occurrences, ui)

    // 4
    const wanted = computeWantedJobs(project, specs, occurrences, ui, shownOperands, isolate?.occurrences ?? [])

    // 5
    const ws = wanted.jobs.map((j) => j.resultKey).join(',') + '|' + [...wanted.priorityKeys].sort().join(',')
    if (ws !== wantSig) {
      wantSig = ws
      ctx.client.want(wanted.jobs, wanted.priorityKeys)
    }

    // 6
    const defStates = computeDefStates(project, wanted, specs.specErrors, (k) => ctx.client.get(k))
    const rowStatus = computeRowStatuses(occurrences, defStates)

    let byKey = sceneByKey
    if (isolate) {
      byKey = new Map(sceneByKey)
      for (const o of isolate.occurrences) byKey.set(o.key, o)
    }

    const next: RenderState = {
      version: ++version, project, ui, occurrences, byKey, isolate, shownOperands, specs, wanted, defStates, rowStatus, counts,
    }
    state = next

    // 7
    ctx.viewport.reconcile(next)
    ctx.emit('render', next)
    return next
  }

  const run = (): RenderState => {
    if (running) {
      // a render listener asked for a pass: finish this one first, then run again
      again = true
      return state ?? pass()
    }
    running = true
    scheduled = false
    let rs: RenderState
    let more = false
    try {
      rs = pass()
      // a listener changed the store during the pass: run once more so nobody keeps a stale state
      for (let i = 0; i < 3 && again; i++) {
        again = false
        rs = pass()
      }
      // still changing after 4 passes: continue on a microtask (schedule() must run AFTER running = false, or it
      // would only set `again` and queue nothing)
      more = again
      again = false
    } finally {
      running = false
    }
    if (more) schedule()
    return rs
  }

  const schedule = (): void => {
    if (running) { again = true; return }
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      if (!scheduled) return
      run()
    })
  }

  ctx.store.subscribe(() => schedule())
  ctx.client.onChange(() => schedule())

  const isBusy = (): boolean => {
    const s = ctx.client.stats()
    const st = ctx.client.status()
    return !st.fatal && (s.queued > 0 || s.inFlight > 0)
  }

  return {
    current: () => state ?? run(),
    schedule,
    run,
    async idle() {
      run()
      for (let i = 0; i < 50; i++) {
        await ctx.client.idle()
        run()
        if (!isBusy()) break
      }
      await nextFrame()
      await nextFrame()
    },
  }
}
