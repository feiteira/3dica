// Shared by the agent-*.test.ts files: a real Store + controller + core ops on the sample project, with a fake
// evaluator (results are ready at once; chosen definitions fail) and a fake viewport (no DOM, no WebGL) that records
// screenshot captures. Same approach as tests/unit/mcp-handlers.test.ts.
import type {
  AppContext, CaptureOptions, Commands, EvalClientApi, EvalClientStats, EvalStatus, MeshEntry, ResultState, ViewportApi,
} from '../../src/app/context'
import { createEvents, readUrlParams } from '../../src/app/context'
import { createController } from '../../src/app/controller'
import type { Job } from '../../src/core/evalspec'
import type { EvalError } from '../../src/eval/protocol'
import { sampleProject, SAMPLE_EXPANDED } from '../../src/core/sample'
import { Store } from '../../src/state/store'
import { Clipboard } from '../../src/state/clipboard'

/** Every wanted job is ready at once (a 10 × 20 × 30 mm box, 12 triangles) unless its def name is in `failing`. */
export class FakeClient implements EvalClientApi {
  jobs = new Map<string, Job>()
  failing = new Map<string, EvalError>()
  exported: { job: Job; matrix: number[] }[][] = []
  private changeCbs: ((keys: string[]) => void)[] = []
  want(jobs: Job[]): void {
    for (const j of jobs) this.jobs.set(j.resultKey, j)
    const keys = jobs.map((j) => j.resultKey)
    queueMicrotask(() => { for (const cb of this.changeCbs) cb(keys) })
  }
  get(k: string): ResultState | undefined {
    const j = this.jobs.get(k)
    if (!j) return undefined
    const e = this.failing.get(j.spec.name)
    if (e) return { state: 'failed', error: { ...e, def: j.spec.def, defName: j.spec.name, trace: [j.spec.name] } }
    const bbox = { isEmpty: () => false, min: { x: -5, y: -10, z: 0 }, max: { x: 5, y: 10, z: 30 } }
    return { state: 'ready', entry: { geometries: [], baked: [], tris: 12, bbox, ms: 1, warnings: [] } as unknown as MeshEntry }
  }
  retry(): void {}
  async exportStl(items: { job: Job; matrix: number[] }[]): Promise<{ parts: ArrayBuffer[]; tris: number }> {
    this.exported.push(items)
    const head = new ArrayBuffer(84)
    new DataView(head).setUint32(80, 1, true)
    return { parts: [head, new ArrayBuffer(50)], tris: 1 }
  }
  onChange(cb: (keys: string[]) => void): () => void { this.changeCbs.push(cb); return () => {} }
  onStatus(): () => void { return () => {} }
  status(): EvalStatus { return { queued: 0, alive: true } }
  idle(): Promise<void> { return Promise.resolve() }
  setInUse(): void {}
  stats(): EvalClientStats { return { cacheEntries: 0, entriesInUse: 0, queued: 0, inFlight: 0, failed: 0, spawns: 1, crashes: 0 } }
  dispose(): void {}
}

export function setupApp() {
  const store = new Store(sampleProject(), { expanded: { ...SAMPLE_EXPANDED } })
  const client = new FakeClient()
  const events = createEvents()
  const toasts: string[] = []
  const downloads: { name: string; blob: Blob }[] = []
  const captures: CaptureOptions[] = []
  const camera = { position: [100, -100, 100] as [number, number, number], target: [0, 0, 0] as [number, number, number] }
  const viewport = {
    reconcile: () => {},
    occurrenceBox: () => null,
    getCamera: () => camera,
    setCamera: (c: typeof camera) => { camera.position = c.position; camera.target = c.target },
    frameAll: () => {}, frameIfNeeded: () => {}, frameSelection: () => {}, viewPreset: () => {},
    capture: (o: CaptureOptions) => {
      captures.push(o)
      const canvas = { width: o.width, height: o.height, getContext: () => null, toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=' }
      return { canvas, views: [], box: null, meshes: 0, triangles: 0 }
    },
  } as unknown as ViewportApi
  const ctx: AppContext = {
    store, client, viewport, commands: {} as Commands, controller: null as never, clipboard: new Clipboard(),
    files: { downloadBlob: (blob, name) => { downloads.push({ name, blob }) }, pickFile: async () => null, onWindowDrop: () => () => {} },
    toast: (m) => { toasts.push(m) }, confirm: async () => true, problems() {},
    on: events.on, emit: events.emit, params: readUrlParams('?fresh'),
  }
  ctx.controller = createController(ctx)
  const defNamed = (name: string) => Object.values(store.project.defs).find((d) => d.name === name)!
  return { store, client, ctx, toasts, downloads, captures, defNamed, past: () => store.history.labels().past }
}
