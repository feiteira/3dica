/// <reference lib="webworker" />
// §5.4 worker shell: a thin wrapper around eval/engine.ts. Created by src/main.ts with
//   new Worker(new URL('./eval/worker.ts', import.meta.url), { type: 'module' })
// Requests are processed one at a time (the client never sends a second before the first answers).
// The OpenSCAD interpreter is a separate chunk, loaded the first time a job needs it, so projects without OpenSCAD
// objects start the worker as fast as before.
import { createEngine, FLAT_NAMES, toEvalError, usesScad } from './engine'
import type { DefSpec } from '../core/evalspec'
import type { FromWorker, ToWorker } from './protocol'

const scope = self as unknown as DedicatedWorkerGlobalScope
const engine = createEngine()

const elapsed = (t0: number) => Math.round((performance.now() - t0) * 10) / 10

function post(msg: FromWorker, transfer: ArrayBuffer[] = []): void {
  scope.postMessage(msg, [...new Set(transfer)])
}

/** Load the OpenSCAD runtime when one of `specs` needs it (once; a failed load is retried with the next job). */
async function ensureScad(specs: DefSpec[]): Promise<void> {
  if (engine.hasScad() || !specs.some((s) => usesScad(s))) return
  let m: typeof import('../openscad/index')
  try {
    m = await import('../openscad/index')
  } catch (x) {
    throw new Error(`Could not load the OpenSCAD interpreter (${String((x as Error)?.message ?? x)}) — reload the page`, { cause: x })
  }
  engine.setScad(m.runScad)
}

scope.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data
  if (!msg || typeof msg !== 'object') return
  const t0 = performance.now()
  if (msg.type === 'eval') {
    const { job } = msg
    let reply: FromWorker
    let transfer: ArrayBuffer[] = []
    try {
      await ensureScad([job.spec])
      const r = engine.run(job)
      reply = { type: 'result', id: msg.id, resultKey: job.resultKey, ok: true, meshes: r.meshes, tris: r.tris, ms: elapsed(t0), warnings: r.warnings }
      if (r.console) reply.console = r.console
      transfer = r.meshes.flatMap((m) => [m.positions.buffer as ArrayBuffer, m.normals.buffer as ArrayBuffer])
    } catch (x) {
      reply = { type: 'result', id: msg.id, resultKey: job.resultKey, ok: false, error: toEvalError(x, job.spec), ms: elapsed(t0) }
    }
    try {
      post(reply, transfer)
    } catch (x) {
      post({ type: 'result', id: msg.id, resultKey: job.resultKey, ok: false, ms: elapsed(t0),
        error: { ...toEvalError(x, job.spec), message: 'Could not send the result: ' + String((x as Error)?.message ?? x) } })
    }
  } else if (msg.type === 'stl') {
    const root = msg.items[0]?.job.spec ?? { def: '', name: 'STL' }
    try {
      await ensureScad(msg.items.map((it) => it.job.spec))
      const r = engine.stl(msg.items)
      post({ type: 'stl', id: msg.id, ok: true, parts: r.parts, tris: r.tris }, r.parts)
    } catch (x) {
      post({ type: 'stl', id: msg.id, ok: false, error: toEvalError(x, root) })
    }
  }
}

post({ type: 'ready', lineOffset: engine.lineOffset, flatNames: FLAT_NAMES.length })
