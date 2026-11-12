// EvalClient driven by a fake Worker (no real worker): handshake, queue order, de-dup, priority, failure memo,
// timeout → terminate → respawn, abandon-kill, crashes, STL, idle(), plus the mesh cache.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import * as THREE from 'three'
import type { Job } from '../../src/core/evalspec'
import type { EvalError, FromWorker, MeshData, ToWorker } from '../../src/eval/protocol'
import type { EvalStatus } from '../../src/app/context'
import {
  ABANDON_MS, CRASH_LIMIT, EvalClient, FATAL_CRASHING, FATAL_START, READY_TIMEOUT_MS, SPAWN_BACKOFF_MS, STATUS_TICK_MS,
} from '../../src/eval/client'
import { MeshCache, ensureEdges, toMeshEntry } from '../../src/eval/mesh-cache'

// ───────────────────────────── fake worker ─────────────────────────────

class FakeWorker {
  static all: FakeWorker[] = []
  onmessage: ((ev: { data: FromWorker }) => void) | null = null
  onerror: ((ev: { message: string; preventDefault(): void }) => void) | null = null
  onmessageerror: ((ev: unknown) => void) | null = null
  sent: ToWorker[] = []
  terminated = false
  constructor() { FakeWorker.all.push(this) }
  postMessage(msg: ToWorker): void {
    if (this.terminated) throw new Error('postMessage after terminate')
    this.sent.push(structuredClone(msg))
  }
  terminate(): void { this.terminated = true }
  // ── test drivers (no-ops once terminated, like a real dead worker) ──
  emit(data: FromWorker): void { if (!this.terminated) this.onmessage?.({ data }) }
  ready(): void { this.emit({ type: 'ready', lineOffset: 3, flatNames: 93 }) }
  crash(message = 'boom'): void { if (!this.terminated) this.onerror?.({ message, preventDefault() {} }) }
  /** the last 'eval' request */
  lastEval(): Extract<ToWorker, { type: 'eval' }> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) { const m = this.sent[i]; if (m.type === 'eval') return m }
    return undefined
  }
  evalKeys(): string[] { return this.sent.flatMap((m) => (m.type === 'eval' ? [m.job.resultKey] : [])) }
  /** answer the last eval request successfully with one triangle */
  ok(ms = 5): void {
    const m = this.lastEval()!
    this.emit({ type: 'result', id: m.id, resultKey: m.job.resultKey, ok: true, meshes: [tri()], tris: 1, ms, warnings: [] })
  }
  fail(error: Partial<EvalError> = {}): void {
    const m = this.lastEval()!
    this.emit({ type: 'result', id: m.id, resultKey: m.job.resultKey, ok: false, ms: 1,
      error: { kind: 'runtime', def: m.job.spec.def, defName: m.job.spec.name, message: 'bad', trace: [m.job.spec.name], ...error } })
  }
}

function tri(): MeshData {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    bbox: [[0, 0, 0], [1, 1, 0]],
  }
}

function job(key: string, name = key.toUpperCase()): Job {
  return { resultKey: key, params: {}, spec: { kind: 'code', defKey: 'dk_' + key, def: 'd_' + key, name, code: 'return cuboid()', paramDefs: [], deps: {} } }
}

const cur = () => FakeWorker.all[FakeWorker.all.length - 1]
const make = (opts: { timeoutMs?: number; stlTimeoutMs?: number; cacheMax?: number } = {}) =>
  new EvalClient({ timeoutMs: opts.timeoutMs ?? 20_000, stlTimeoutMs: opts.stlTimeoutMs, cacheMax: opts.cacheMax, spawn: () => new FakeWorker() as unknown as Worker })

/** Resolves to true if `p` settled within the currently queued microtasks. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false
  p.then(() => { done = true }, () => { done = true })
  await Promise.resolve(); await Promise.resolve()
  return done
}

let client: EvalClient | undefined
beforeEach(() => {
  vi.useFakeTimers()
  FakeWorker.all = []
})
afterEach(() => {
  client?.dispose()
  client = undefined
  vi.useRealTimers()
})

// ───────────────────────────── handshake ─────────────────────────────

describe('ready handshake', () => {
  test('spawns at construction and sends nothing before ready', () => {
    client = make()
    expect(FakeWorker.all.length).toBe(1)
    client.want([job('a')], new Set())
    expect(cur().sent).toEqual([])
    expect(client.get('a')).toEqual({ state: 'pending' })
    expect(client.status()).toMatchObject({ alive: false, queued: 1 })
    cur().ready()
    expect(cur().evalKeys()).toEqual(['a'])
    expect(client.status()).toMatchObject({ alive: true, queued: 0, running: { defName: 'A' } })
  })

  test('an error before ready retries the spawn with a 500 ms back-off, up to 3 times, then stops', async () => {
    client = make()
    const statuses: EvalStatus[] = []
    client.onStatus((s) => statuses.push(s))
    client.want([job('a')], new Set())
    cur().crash('module failed')
    expect(FakeWorker.all[0].terminated).toBe(true)
    expect(FakeWorker.all.length).toBe(1)
    await vi.advanceTimersByTimeAsync(SPAWN_BACKOFF_MS)
    expect(FakeWorker.all.length).toBe(2)
    cur().crash()
    await vi.advanceTimersByTimeAsync(2 * SPAWN_BACKOFF_MS)
    expect(FakeWorker.all.length).toBe(3)
    cur().crash()
    await vi.advanceTimersByTimeAsync(3 * SPAWN_BACKOFF_MS)
    expect(FakeWorker.all.length).toBe(4)
    cur().crash()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeWorker.all.length).toBe(4) // 1 + 3 retries
    expect(client.status().fatal).toBe(FATAL_START)
    expect(statuses.at(-1)?.fatal).toBe(FATAL_START)
    expect(await settled(client.idle())).toBe(true) // evaluation stopped: idle() does not hang
    await expect(client.exportStl([])).rejects.toThrow(FATAL_START)
  })

  test('a worker that never says ready is replaced; a successful ready resets the retry budget', async () => {
    client = make()
    client.want([job('a')], new Set())
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS + SPAWN_BACKOFF_MS)
    expect(FakeWorker.all.length).toBe(2)
    expect(FakeWorker.all[0].terminated).toBe(true)
    cur().ready()
    expect(cur().evalKeys()).toEqual(['a'])
    expect(client.status().fatal).toBeUndefined()
  })

  test('a spawn() that throws counts as a start failure', async () => {
    let n = 0
    client = new EvalClient({ timeoutMs: 1000, spawn: () => { if (n++ === 0) throw new Error('no workers'); return new FakeWorker() as unknown as Worker } })
    expect(FakeWorker.all.length).toBe(0)
    await vi.advanceTimersByTimeAsync(SPAWN_BACKOFF_MS)
    expect(FakeWorker.all.length).toBe(1)
    expect(client.stats().spawns).toBe(2)
  })
})

// ───────────────────────────── queue ─────────────────────────────

describe('queue', () => {
  test('FIFO, de-duplicated by resultKey, one in flight at a time', () => {
    client = make()
    cur().ready()
    client.want([job('a'), job('b'), job('a'), job('c')], new Set())
    const w = cur()
    expect(w.evalKeys()).toEqual(['a'])
    expect(client.stats()).toMatchObject({ queued: 2, inFlight: 1 })
    w.ok()
    expect(w.evalKeys()).toEqual(['a', 'b'])
    w.ok()
    w.ok()
    expect(w.evalKeys()).toEqual(['a', 'b', 'c'])
    expect(client.stats()).toMatchObject({ queued: 0, inFlight: 0, entriesInUse: 3, cacheEntries: 3, spawns: 1 })
    // ready keys are not re-queued
    client.want([job('a'), job('b'), job('c')], new Set())
    expect(w.evalKeys()).toEqual(['a', 'b', 'c'])
  })

  test('a re-want keeps FIFO order of queued keys and appends new ones', () => {
    client = make()
    cur().ready()
    client.want([job('a'), job('b'), job('c')], new Set())
    client.want([job('d'), job('c'), job('b'), job('a')], new Set())
    const w = cur()
    w.ok() // a
    w.ok() // b (was queued before c)
    w.ok() // c
    expect(w.evalKeys()).toEqual(['a', 'b', 'c', 'd'])
  })

  test('priority keys move to the front (stable), re-ordered on every want()', () => {
    client = make()
    cur().ready()
    const w = cur()
    client.want([job('a'), job('b'), job('c'), job('d'), job('e')], new Set(['d', 'c']))
    expect(w.evalKeys()).toEqual(['c']) // c before d: priority keys keep their relative FIFO order
    client.want([job('a'), job('b'), job('c'), job('d'), job('e')], new Set(['e']))
    w.ok() // c
    w.ok() // e
    w.ok() // a
    w.ok() // b
    w.ok() // d
    expect(w.evalKeys()).toEqual(['c', 'e', 'a', 'b', 'd'])
  })

  test('queued keys no longer wanted are dropped before the next send', () => {
    client = make()
    cur().ready()
    const w = cur()
    client.want([job('a'), job('b'), job('c')], new Set())
    client.want([job('a'), job('c')], new Set())
    expect(client.get('b')).toBeUndefined()
    w.ok()
    w.ok()
    expect(w.evalKeys()).toEqual(['a', 'c'])
    client.want([], new Set())
    expect(client.stats().queued).toBe(0)
  })

  test('results of a key that stopped being wanted while in flight (< 1 s) are still cached', async () => {
    client = make()
    cur().ready()
    client.want([job('a')], new Set())
    client.want([job('b')], new Set())
    await vi.advanceTimersByTimeAsync(ABANDON_MS / 2)
    cur().ok()
    expect(client.get('a')?.state).toBe('ready')
    expect(cur().evalKeys()).toEqual(['a', 'b'])
    expect(client.stats().spawns).toBe(1)
  })
})

// ───────────────────────────── failure memo ─────────────────────────────

describe('failure memo', () => {
  test('a failed key is never retried until retry() (or a new key)', () => {
    client = make()
    cur().ready()
    const changes: string[][] = []
    client.onChange((k) => changes.push(k))
    const w = cur()
    client.want([job('a')], new Set())
    w.fail({ message: 'nope', line: 2 })
    expect(client.get('a')).toEqual({ state: 'failed', error: expect.objectContaining({ kind: 'runtime', message: 'nope', line: 2 }) })
    expect(changes).toEqual([['a']])
    expect(client.stats().failed).toBe(1)
    client.want([job('a')], new Set())
    client.want([job('a'), job('a2')], new Set())
    expect(w.evalKeys()).toEqual(['a', 'a2']) // 'a' not re-sent; the edited code (new key) is
    w.ok()
    client.retry(['a'])
    expect(changes.at(-1)).toEqual(['a'])
    expect(w.evalKeys()).toEqual(['a', 'a2', 'a'])
    w.ok()
    expect(client.get('a')?.state).toBe('ready')
    expect(client.stats().failed).toBe(0)
  })

  test('retry() of a key that is not wanted only forgets the failure', () => {
    client = make()
    cur().ready()
    client.want([job('a')], new Set())
    cur().fail()
    client.want([], new Set())
    client.retry(['a'])
    expect(client.get('a')).toBeUndefined()
    expect(cur().evalKeys()).toEqual(['a'])
  })
})

// ───────────────────────────── timeout / abandon / crash ─────────────────────────────

describe('timeouts, kills and respawn', () => {
  test('timeout → terminate, record a timeout failure, respawn, continue the queue', async () => {
    client = make({ timeoutMs: 1500 })
    cur().ready()
    const changes: string[][] = []
    client.onChange((k) => changes.push(k))
    client.want([job('loop', 'Object'), job('b')], new Set())
    const w1 = cur()
    expect(w1.evalKeys()).toEqual(['loop'])
    await vi.advanceTimersByTimeAsync(1499)
    expect(w1.terminated).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(w1.terminated).toBe(true)
    expect(client.get('loop')).toEqual({ state: 'failed', error: {
      kind: 'timeout', def: 'd_loop', defName: 'Object', message: 'Timed out after 1.5 s (infinite loop or very slow boolean?)', trace: ['Object'],
    } })
    expect(changes).toEqual([['loop']])
    expect(FakeWorker.all.length).toBe(2)
    expect(client.stats()).toMatchObject({ spawns: 2, crashes: 0, queued: 1, inFlight: 0 })
    const w2 = cur()
    w2.ready()
    expect(w2.evalKeys()).toEqual(['b'])
    w2.ok()
    expect(client.get('b')?.state).toBe('ready')
    // the failed key is not retried by the new worker
    client.want([job('loop', 'Object'), job('b')], new Set())
    expect(w2.evalKeys()).toEqual(['b'])
  })

  test('the default 20 s message', async () => {
    client = make()
    cur().ready()
    client.want([job('a')], new Set())
    await vi.advanceTimersByTimeAsync(20_000)
    expect(client.get('a')).toMatchObject({ state: 'failed', error: { kind: 'timeout', message: 'Timed out after 20 s (infinite loop or very slow boolean?)' } })
  })

  test('a late result from a terminated worker is ignored', async () => {
    client = make({ timeoutMs: 1000 })
    cur().ready()
    client.want([job('a')], new Set())
    const w1 = cur()
    const req = w1.lastEval()!
    const onmessage = w1.onmessage
    await vi.advanceTimersByTimeAsync(1000)
    expect(w1.onmessage).toBeNull() // handlers detached
    onmessage?.({ data: { type: 'result', id: req.id, resultKey: 'a', ok: true, meshes: [tri()], tris: 1, ms: 1, warnings: [] } })
    expect(client.get('a')?.state).toBe('failed')
  })

  test('an abandoned in-flight job (no longer wanted) is killed after 1 s without recording a failure', async () => {
    client = make()
    cur().ready()
    client.want([job('loop')], new Set())
    const w1 = cur()
    await vi.advanceTimersByTimeAsync(300)
    client.want([job('fixed')], new Set()) // the user fixed the code: a new key
    expect(w1.terminated).toBe(false)
    await vi.advanceTimersByTimeAsync(ABANDON_MS - 300 - 1)
    expect(w1.terminated).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(w1.terminated).toBe(true)
    expect(client.get('loop')).toBeUndefined() // no failure recorded
    expect(client.stats()).toMatchObject({ spawns: 2, failed: 0, crashes: 0 })
    cur().ready()
    expect(cur().evalKeys()).toEqual(['fixed'])
  })

  test('an in-flight job unwanted after running > 1 s is killed immediately', async () => {
    client = make()
    cur().ready()
    client.want([job('slow')], new Set())
    const w1 = cur()
    await vi.advanceTimersByTimeAsync(5000)
    client.want([job('other')], new Set())
    expect(w1.terminated).toBe(true)
    expect(FakeWorker.all.length).toBe(2)
  })

  test('wanted again before 1 s → not killed', async () => {
    client = make()
    cur().ready()
    client.want([job('a')], new Set())
    client.want([], new Set())
    await vi.advanceTimersByTimeAsync(500)
    client.want([job('a')], new Set())
    await vi.advanceTimersByTimeAsync(2000)
    expect(cur().terminated).toBe(false)
    cur().ok()
    expect(client.get('a')?.state).toBe('ready')
  })

  test('onerror → mark the in-flight key as crash, respawn; 3 crashes within 10 s → stop', async () => {
    client = make()
    cur().ready()
    client.want([job('a'), job('b'), job('c'), job('d')], new Set())
    cur().crash('out of memory')
    expect(client.get('a')).toMatchObject({ state: 'failed', error: { kind: 'crash', def: 'd_a', defName: 'A' } })
    expect((client.get('a') as { error: EvalError }).error.message).toContain('out of memory')
    expect(FakeWorker.all.length).toBe(2)
    cur().ready()
    expect(cur().evalKeys()).toEqual(['b'])
    await vi.advanceTimersByTimeAsync(1000)
    cur().crash()
    cur().ready()
    expect(client.stats().crashes).toBe(2)
    expect(client.status().fatal).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1000)
    cur().onmessageerror?.({})
    expect(client.stats().crashes).toBe(CRASH_LIMIT)
    expect(client.status()).toMatchObject({ fatal: FATAL_CRASHING, alive: false })
    expect(FakeWorker.all.length).toBe(3)
    expect(cur().terminated).toBe(true)
    expect(await settled(client.idle())).toBe(true)
  })

  test('crashes spread over more than 10 s do not stop the evaluator', async () => {
    client = make()
    cur().ready()
    client.want([job('a'), job('b'), job('c'), job('d')], new Set())
    for (let i = 0; i < 3; i++) {
      cur().crash()
      cur().ready()
      await vi.advanceTimersByTimeAsync(6000)
    }
    expect(client.stats().crashes).toBe(3)
    expect(client.status().fatal).toBeUndefined()
    expect(cur().evalKeys()).toEqual(['d'])
  })
})

// ───────────────────────────── idle / status ─────────────────────────────

describe('idle() and status', () => {
  test('idle() resolves immediately when idle, otherwise when the queue drains', async () => {
    client = make()
    expect(await settled(client.idle())).toBe(true)
    client.want([job('a'), job('b')], new Set())
    const p = client.idle()
    expect(await settled(p)).toBe(false)
    cur().ready()
    cur().ok()
    expect(await settled(p)).toBe(false)
    cur().ok()
    expect(await settled(p)).toBe(true)
  })

  test('idle() waits through a timeout and respawn', async () => {
    client = make({ timeoutMs: 1000 })
    cur().ready()
    client.want([job('a'), job('b')], new Set())
    const p = client.idle()
    await vi.advanceTimersByTimeAsync(1000)
    expect(await settled(p)).toBe(false)
    cur().ready()
    cur().ok()
    expect(await settled(p)).toBe(true)
  })

  test('onStatus fires while a job runs (every 250 ms) and reports last', async () => {
    client = make()
    cur().ready()
    const seen: EvalStatus[] = []
    const off = client.onStatus((s) => seen.push(s))
    client.want([job('a', 'Plate')], new Set())
    await vi.advanceTimersByTimeAsync(STATUS_TICK_MS * 4)
    const running = seen.filter((s) => s.running?.defName === 'Plate')
    expect(running.length).toBeGreaterThanOrEqual(4)
    expect(running.at(-1)!.running!.ms).toBeGreaterThanOrEqual(STATUS_TICK_MS * 3)
    cur().ok(60)
    expect(seen.at(-1)).toEqual({ queued: 0, alive: true, last: { defName: 'Plate', ms: 60 } })
    const n = seen.length
    off()
    client.want([job('b')], new Set())
    expect(seen.length).toBe(n)
  })

  test('a throwing listener does not break the client', () => {
    const errors: unknown[] = []
    client = new EvalClient({ timeoutMs: 1000, spawn: () => new FakeWorker() as unknown as Worker, onListenerError: (e) => errors.push(e) })
    cur().ready()
    client.onChange(() => { throw new Error('listener bug') })
    client.onStatus(() => { throw new Error('status bug') })
    client.want([job('a'), job('b')], new Set())
    cur().ok()
    expect(cur().evalKeys()).toEqual(['a', 'b'])
    expect(client.get('a')?.state).toBe('ready')
    expect(errors.map((e) => (e as Error).message)).toContain('listener bug')
    expect(errors.map((e) => (e as Error).message)).toContain('status bug')
  })
})

// ───────────────────────────── STL ─────────────────────────────

describe('exportStl', () => {
  const items = () => [{ job: job('s'), matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }]

  test('waits for the in-flight job, then jumps the queue', async () => {
    client = make()
    cur().ready()
    const w = cur()
    client.want([job('a'), job('b')], new Set())
    const p = client.exportStl(items())
    expect(w.sent.map((m) => m.type)).toEqual(['eval'])
    w.ok()
    expect(w.sent.map((m) => m.type)).toEqual(['eval', 'stl'])
    const req = w.sent[1] as Extract<ToWorker, { type: 'stl' }>
    const buf = new ArrayBuffer(84 + 50)
    w.emit({ type: 'stl', id: req.id, ok: true, parts: [buf], tris: 1 })
    await expect(p).resolves.toEqual({ parts: [buf], tris: 1 })
    expect(w.evalKeys()).toEqual(['a', 'b'])
  })

  test('rejects with the error message on failure', async () => {
    client = make()
    cur().ready()
    const p = client.exportStl(items())
    const req = cur().sent[0] as Extract<ToWorker, { type: 'stl' }>
    cur().emit({ type: 'stl', id: req.id, ok: false, error: { kind: 'runtime', def: 'd_s', defName: 'S', message: 'Nothing to export', trace: [] } })
    await expect(p).rejects.toThrow('Nothing to export')
  })

  test('times out after 60 s by default, terminating and respawning the worker', async () => {
    client = make()
    cur().ready()
    const p = client.exportStl(items())
    const caught = p.catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(cur().terminated).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect((await caught as Error).message).toBe('STL export timed out after 60 s')
    expect(FakeWorker.all.length).toBe(2)
  })

  test('the stl timeout is not the eval timeout', async () => {
    client = make({ timeoutMs: 1000, stlTimeoutMs: 5000 })
    cur().ready()
    const p = client.exportStl(items())
    const caught = p.catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(4000)
    expect(cur().terminated).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect((await caught as Error).message).toBe('STL export timed out after 5 s')
  })

  test('a crash during STL rejects', async () => {
    client = make()
    cur().ready()
    const p = client.exportStl(items())
    cur().crash('oom')
    await expect(p).rejects.toThrow(/crashed/)
  })
})

// ───────────────────────────── mesh cache ─────────────────────────────

describe('mesh cache', () => {
  test('MeshData → BufferGeometry with position + normal, bounding sphere, baked sRGB color and bbox', () => {
    const red: MeshData = { ...tri(), color: [1, 0.5, 0, 1] }
    const e = toMeshEntry([tri(), red], 2, 18, ['w'])
    expect(e.geometries.length).toBe(2)
    expect(e.geometries[0].getAttribute('position').count).toBe(3)
    expect(e.geometries[0].getAttribute('normal').count).toBe(3)
    expect(e.geometries[0].boundingSphere).not.toBeNull()
    expect(e.baked[0]).toBeNull()
    const expected = new THREE.Color().setRGB(1, 0.5, 0, THREE.SRGBColorSpace)
    expect(e.baked[1]!.equals(expected)).toBe(true)
    expect(e.bbox.max.toArray()).toEqual([1, 1, 0])
    expect(e).toMatchObject({ tris: 2, ms: 18, warnings: ['w'] })
    expect(toMeshEntry([], 0, 1, []).bbox.isEmpty()).toBe(true)
    const edges = ensureEdges(e)
    expect(edges.length).toBe(2)
    expect(ensureEdges(e)).toBe(edges)
  })

  test('LRU eviction beyond max skips protected keys and disposes geometries and edges', () => {
    const c = new MeshCache(3)
    const entries = ['a', 'b', 'c', 'd', 'e'].map((k) => {
      const e = toMeshEntry([tri()], 1, 1, [])
      c.set(k, e)
      return e
    })
    ensureEdges(entries[1])
    const disposed = vi.spyOn(entries[1].geometries[0], 'dispose')
    const edgeDisposed = vi.spyOn(entries[1].edges![0], 'dispose')
    c.get('a') // touch: a becomes most recent
    expect(c.evict((k) => k === 'c')).toEqual(['b', 'd'])
    expect([...c.keys()]).toEqual(['c', 'e', 'a'])
    expect(disposed).toHaveBeenCalled()
    expect(edgeDisposed).toHaveBeenCalled()
    expect(c.evict(() => false)).toEqual([]) // at max: nothing to do
  })

  test('the client never evicts wanted or in-use keys; others go LRU beyond the cap', () => {
    client = make({ cacheMax: 2 })
    cur().ready()
    const w = cur()
    for (const k of ['a', 'b', 'c']) { client.want([job(k)], new Set()); w.ok() }
    // a, b no longer wanted and not in use: the cache holds max 2 → 'a' evicted
    expect(client.stats().cacheEntries).toBe(2)
    expect(client.get('a')).toBeUndefined()
    client.setInUse(['b']) // the view still shows b (last good)
    client.want([job('d')], new Set())
    w.ok()
    expect(client.get('b')?.state).toBe('ready')
    expect(client.get('c')).toBeUndefined()
    expect(client.get('d')?.state).toBe('ready')
    // survives a respawn
    client.want([job('d'), job('x')], new Set())
    cur().crash()
    expect(client.get('d')?.state).toBe('ready')
    expect(client.stats().entriesInUse).toBe(1)
  })
})

describe('mesh cache memory', () => {
  /** a MeshData with `tris` triangles (positions + normals: 72 bytes per triangle) */
  const big = (tris: number): MeshData => ({ positions: new Float32Array(tris * 9), normals: new Float32Array(tris * 9), bbox: [[0, 0, 0], [1, 1, 1]] })

  test('unprotected entries are evicted by bytes too, not only beyond 300 entries', () => {
    const c = new MeshCache(300, 10 * 72_000) // room for ten 1000-triangle entries
    for (let i = 0; i < 30; i++) {
      c.set('k' + i, toMeshEntry([big(1000)], 1000, 1, []))
      c.evict((k) => k === 'k' + i) // only the newest is shown
    }
    expect(c.size).toBeLessThanOrEqual(10)
    expect(c.bytes()).toBeLessThanOrEqual(10 * 72_000)
    expect(c.has('k29')).toBe(true)
    // protected entries are never evicted, even above the budget
    const p = new MeshCache(300, 1000)
    p.set('a', toMeshEntry([big(1000)], 1000, 1, []))
    p.set('b', toMeshEntry([big(1000)], 1000, 1, []))
    expect(p.evict(() => true)).toEqual([])
    expect(p.evict((k) => k === 'b')).toEqual(['a'])
  })

  test('an entry that stops being shown or wanted gives its WebGL buffers back at once (CPU data kept)', () => {
    const c = new MeshCache()
    const e = toMeshEntry([tri()], 1, 1, [])
    c.set('old', e)
    const gpuFree = vi.fn()
    e.geometries[0].addEventListener('dispose', gpuFree) // three's WebGLGeometries frees the buffers on 'dispose'
    c.evict((k) => k === 'old') // shown
    expect(gpuFree).not.toHaveBeenCalled()
    c.set('new', toMeshEntry([tri()], 1, 1, []))
    c.evict((k) => k === 'new') // an edit superseded it: no longer shown or wanted
    expect(gpuFree).toHaveBeenCalledTimes(1)
    expect(c.has('old')).toBe(true) // still cached for a cheap undo…
    expect(e.geometries[0].getAttribute('position').array.length).toBe(9) // …with its arrays
    c.evict((k) => k === 'new')
    expect(gpuFree).toHaveBeenCalledTimes(1) // released once
  })

  test('the client applies the byte budget to superseded results', () => {
    client = new EvalClient({ timeoutMs: 20_000, cacheMaxBytes: 3 * 72_000, spawn: () => new FakeWorker() as unknown as Worker })
    const w = cur()
    w.ready()
    for (let i = 0; i < 12; i++) { // e.g. a slider drag: every value is a new result of the selected object
      client.want([job('e' + i)], new Set())
      const m = w.lastEval()!
      w.emit({ type: 'result', id: m.id, resultKey: m.job.resultKey, ok: true, meshes: [big(1000)], tris: 1000, ms: 1, warnings: [] })
      client.setInUse(['e' + i])
    }
    expect(client.stats().cacheEntries).toBeLessThanOrEqual(3)
    expect(client.get('e11')?.state).toBe('ready')
  })
})
