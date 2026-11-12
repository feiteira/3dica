// app/controller.ts: one pass = specs → expansion → isolate → operands → wanted → client.want (only on change) →
// def states → viewport.reconcile + 'render'. Runs in node with a fake client and viewport.
import { describe, expect, test } from 'vitest'
import type {
  AppContext, Commands, EvalClientApi, EvalClientStats, EvalStatus, MeshEntry, RenderState, ResultState, ViewportApi,
} from '../../src/app/context'
import { createEvents, readUrlParams } from '../../src/app/context'
import { createController } from '../../src/app/controller'
import type { Job } from '../../src/core/evalspec'
import { ISOLATE_INSTANCE_ID } from '../../src/core/graph'
import { sampleProject, SAMPLE_EXPANDED } from '../../src/core/sample'
import { Store } from '../../src/state/store'
import { Clipboard } from '../../src/state/clipboard'

class FakeClient implements EvalClientApi {
  wants: { keys: string[]; priority: string[] }[] = []
  wanted = new Set<string>()
  results = new Map<string, ResultState>()
  private changeCbs: ((keys: string[]) => void)[] = []
  want(jobs: Job[], priorityKeys: Set<string>): void {
    this.wants.push({ keys: jobs.map((j) => j.resultKey), priority: [...priorityKeys] })
    this.wanted = new Set(jobs.map((j) => j.resultKey))
  }
  get(k: string): ResultState | undefined { return this.results.get(k) ?? (this.wanted.has(k) ? { state: 'pending' } : undefined) }
  retry(): void {}
  exportStl(): Promise<{ parts: ArrayBuffer[]; tris: number }> { return Promise.reject(new Error('no')) }
  onChange(cb: (keys: string[]) => void): () => void { this.changeCbs.push(cb); return () => {} }
  onStatus(): () => void { return () => {} }
  status(): EvalStatus { return { queued: 0, alive: true } }
  idle(): Promise<void> { return Promise.resolve() }
  setInUse(): void {}
  stats(): EvalClientStats { return { cacheEntries: 0, entriesInUse: 0, queued: 0, inFlight: 0, failed: 0, spawns: 1, crashes: 0 } }
  dispose(): void {}
  /** resolve every wanted key as ready (or failed via `fail`) and notify */
  settle(fail: Record<string, ResultState> = {}): void {
    for (const k of this.wanted) this.results.set(k, fail[k] ?? { state: 'ready', entry: {} as MeshEntry })
    for (const cb of this.changeCbs) cb([...this.wanted])
  }
}

function setup() {
  const store = new Store(sampleProject(), { expanded: { ...SAMPLE_EXPANDED } })
  const client = new FakeClient()
  const reconciled: RenderState[] = []
  const viewport = { reconcile: (s: RenderState) => { reconciled.push(s) } } as unknown as ViewportApi
  const events = createEvents()
  const rendered: RenderState[] = []
  events.on('render', (s) => rendered.push(s))
  const toasts: string[] = []
  const ctx: AppContext = {
    store, client, viewport, commands: {} as Commands, controller: null as never, clipboard: new Clipboard(),
    files: { downloadBlob() {}, pickFile: async () => null, onWindowDrop: () => () => {} },
    toast: (m) => { toasts.push(m) }, confirm: async () => true, problems() {},
    on: events.on, emit: events.emit, params: readUrlParams('?fresh'),
  }
  const controller = createController(ctx)
  ctx.controller = controller
  return { store, client, controller, reconciled, rendered, toasts, on: events.on }
}

const tick = () => new Promise<void>((r) => queueMicrotask(r))

describe('controller', () => {
  test('first pass: 4 sample jobs, statuses, counts, reconcile + render', () => {
    const { client, controller, reconciled, rendered } = setup()
    const rs = controller.current()
    expect(rs.version).toBe(1)
    expect(rs.occurrences.length).toBe(37)
    expect(rs.wanted.jobs.length).toBe(4)
    expect(client.wants).toHaveLength(1)
    expect(client.wants[0].keys).toHaveLength(4)
    expect(rs.counts.get('d_bolt')).toBe(8)
    expect(rs.defStates.get('d_bolt')?.status).toBe('pending')
    expect(rs.defStates.get('d_disc')?.status).toBe('idle')
    expect(rs.rowStatus.get('i_fx1')).toBe('pending')
    expect(reconciled).toEqual([rs])
    expect(rendered).toEqual([rs])
    expect(controller.current()).toBe(rs) // no new pass without a change
  })

  test('results → a new pass on a microtask, without re-sending the wanted set', async () => {
    const { client, controller } = setup()
    controller.current()
    client.settle()
    await tick()
    const rs = controller.current()
    expect(rs.version).toBe(2)
    for (const d of ['d_bolt', 'd_plate', 'd_washer', 'd_boltsizes']) expect(rs.defStates.get(d)?.status, d).toBe('ok')
    for (const d of ['d_disc', 'd_hole', 'd_fixture']) expect(rs.defStates.get(d)?.status, d).toBe('idle')
    expect(rs.rowStatus.get('i_fx1')).toBe('ok')
    expect(client.wants).toHaveLength(1)
  })

  test('store changes coalesce into one pass; a selection change re-sends priority', async () => {
    const { store, client, controller } = setup()
    controller.current()
    store.setUi({ selection: { kind: 'occ', path: ['i_fx1', 'i_b1'] }, context: ['i_fx1'] })
    store.setUi({ ghostOthers: false })
    store.setUi({ ghostOthers: true })
    await tick()
    expect(controller.current().version).toBe(2)
    expect(client.wants).toHaveLength(2)
    const boltKey = controller.current().wanted.resultKeyOf.get('i_fx1/i_b1')!
    expect(client.wants[1].priority).toContain(boltKey)
  })

  test('a failing dependency: Bolt fails → Bolt sizes is a dependency error', async () => {
    const { client, controller } = setup()
    const rs0 = controller.current()
    const bolt = rs0.wanted.resultKeyOf.get('i_fx1/i_b1')!
    const bs = rs0.wanted.resultKeyOf.get('i_bs')!
    const err = { kind: 'runtime' as const, def: 'd_bolt', defName: 'Bolt', message: 'boom', line: 1, trace: ['Bolt'] }
    client.settle({ [bolt]: { state: 'failed', error: err }, [bs]: { state: 'failed', error: { ...err, trace: ['Bolt sizes', 'Bolt'] } } })
    await tick()
    const rs = controller.current()
    expect(rs.defStates.get('d_bolt')).toMatchObject({ status: 'error', error: { line: 1, message: 'boom' } })
    expect(rs.defStates.get('d_boltsizes')).toMatchObject({ status: 'error', error: { kind: 'dependency' } })
    expect(rs.defStates.get('d_plate')?.status).toBe('ok')
  })

  test('evalPaused wants nothing; resuming wants everything again', async () => {
    const { store, client, controller } = setup()
    controller.current()
    store.setUi({ evalPaused: true })
    await tick()
    expect(client.wants.at(-1)).toEqual({ keys: [], priority: [] })
    expect(controller.current().defStates.get('d_bolt')?.status).toBe('idle')
    store.setUi({ evalPaused: false })
    await tick()
    expect(client.wants.at(-1)!.keys).toHaveLength(4)
  })

  test('isolate: a Library selection builds the isolate view with defaults', async () => {
    const { store, controller } = setup()
    controller.current()
    store.setUi({ selection: { kind: 'def', def: 'd_bolt' }, viewMode: 'isolate' })
    await tick()
    const rs = controller.current()
    expect(rs.isolate?.defId).toBe('d_bolt')
    expect(rs.isolate?.banner).toBe('Isolated: Bolt (length 12, diameter 5) — I or Esc to return')
    expect(rs.isolate?.occurrences.map((o) => o.key)).toEqual([ISOLATE_INSTANCE_ID])
    expect(rs.byKey.has(ISOLATE_INSTANCE_ID)).toBe(true)
    // the isolate job is the scene's Bolt job (same def, same params) and has priority
    const k = rs.wanted.resultKeyOf.get(ISOLATE_INSTANCE_ID)!
    expect(k).toBe(rs.wanted.resultKeyOf.get('i_fx1/i_b1'))
    expect(rs.wanted.priorityKeys.has(k)).toBe(true)
    // an occurrence selection with overrides isolates with those params
    store.update('Set length', (d) => {
      const fx = d.defs.d_fixture
      if (fx.kind === 'group') fx.children.find((c) => c.id === 'i_b1')!.params = { length: 30 }
    })
    store.setUi({ selection: { kind: 'occ', path: ['i_fx1', 'i_b1'] } })
    await tick()
    expect(controller.current().isolate?.banner).toBe('Isolated: Bolt (length 30, diameter 5) — I or Esc to return')
  })

  test('a store change made by a render listener is picked up by the same run()', () => {
    const { store, controller, on } = setup()
    controller.current()
    // a panel that reacts to a render by changing ui (like the tree expanding the ancestors of a new selection)
    on('render', (rs) => {
      if (rs.ui.selection.kind === 'occ' && !rs.ui.expanded.x) store.setUi({ expanded: { ...rs.ui.expanded, x: true } })
    })
    store.setUi({ selection: { kind: 'occ', path: ['i_bs'] } })
    const rs = controller.run()
    expect(rs.ui.expanded.x).toBe(true)
    expect(controller.current()).toBe(rs)
  })
})

test('a render listener that keeps changing the store for more than 4 passes still ends with a fresh state', async () => {
  const { store, controller, on } = setup()
  let n = 0
  on('render', () => { if (n++ < 6) store.setUi((u) => ({ ghostOthers: !u.ghostOthers })) })
  controller.run()
  for (let i = 0; i < 20; i++) await tick()
  expect(controller.current().ui).toBe(store.ui) // the 5th+ passes were queued, not lost
})
