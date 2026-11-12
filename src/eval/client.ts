// §5.5 EvalClient (main thread). Owns the worker, the job queue, the failure memo and the mesh cache.
//
// Queue: FIFO de-duplicated by resultKey; priority keys move to the front; keys no longer wanted are dropped; ready
// and failed keys are never re-queued (until retry() or a new key). One request (eval or stl) is in flight at a time.
//
// Worker lifecycle:
//   spawn ──ready──▶ alive ──(timeout | abandoned > 1 s | crash)──▶ terminate + respawn (cache and failures survive)
//   an error / no 'ready' before ready → retry the spawn up to 3 times with a 500 ms back-off, then stop (fatal)
//   3 crashes within 10 s → stop (fatal 'Evaluator keeps crashing — reload the page')
import type { EvalClientApi, EvalClientOptions, EvalClientStats, EvalStatus, MeshEntry, ResultState } from '../app/context'
import type { Job } from '../core/evalspec'
import type { Mat4 } from '../core/types'
import type { EvalError, FromWorker, ToWorker } from './protocol'
import { MeshCache, toMeshEntry } from './mesh-cache'

export const ABANDON_MS = 1000
export const READY_TIMEOUT_MS = 30_000
export const SPAWN_RETRIES = 3
export const SPAWN_BACKOFF_MS = 500
export const CRASH_LIMIT = 3
export const CRASH_WINDOW_MS = 10_000
export const STATUS_TICK_MS = 250
export const DEFAULT_STL_TIMEOUT_MS = 60_000
export const FATAL_CRASHING = 'Evaluator keeps crashing — reload the page'
export const FATAL_START = 'Evaluator failed to start — reload the page'

type StlItems = { job: Job; matrix: Mat4 }[]
type StlResult = { parts: ArrayBuffer[]; tris: number }
interface StlRequest { items: StlItems; resolve: (r: StlResult) => void; reject: (e: Error) => void }

type InFlight =
  | { kind: 'eval'; id: number; key: string; job: Job; start: number }
  | { kind: 'stl'; id: number; req: StlRequest; start: number }

type Timer = ReturnType<typeof setTimeout>
type Interval = ReturnType<typeof setInterval>

/** "20" for 20000 ms, "1.5" for 1500 ms. */
function seconds(ms: number): string { return String(Math.round(ms / 100) / 10) }

/** Report a listener exception without breaking the client's state machine. */
function rethrowLater(e: unknown): void { queueMicrotask(() => { throw e }) }

export class EvalClient implements EvalClientApi {
  private readonly timeoutMs: number
  private readonly stlTimeoutMs: number
  private readonly spawnFn: () => Worker

  private worker: Worker | null = null
  private ready = false
  private disposed = false
  private fatal: string | undefined
  private startFailures = 0
  private crashTimes: number[] = []
  private crashCount = 0
  private spawnCount = 0
  private nextId = 1

  /** the current wanted set, in want() order */
  private wanted = new Map<string, Job>()
  private priority = new Set<string>()
  private queue: string[] = []
  private queued = new Set<string>()
  private inFlight: InFlight | null = null
  private readonly failures = new Map<string, EvalError>()
  private readonly cache: MeshCache
  private inUse = new Set<string>()
  private stlQueue: StlRequest[] = []
  private last: { defName: string; ms: number } | undefined

  private jobTimer: Timer | undefined
  private abandonTimer: Timer | undefined
  private readyTimer: Timer | undefined
  private respawnTimer: Timer | undefined
  private tickTimer: Interval | undefined

  private readonly changeCbs = new Set<(keys: string[]) => void>()
  private readonly statusCbs = new Set<(s: EvalStatus) => void>()
  private idleWaiters: (() => void)[] = []
  private lastStatusJson = ''
  private readonly reportError: (e: unknown) => void

  /**
   * Beyond EvalClientOptions (tests / tuning only): cacheMax = mesh cache size (default 300), cacheMaxBytes = its
   * vertex-data budget (default 256 MB);
   * onListenerError = where exceptions thrown by onChange / onStatus listeners go (default: rethrown on a microtask).
   */
  constructor(opts: EvalClientOptions & { cacheMax?: number; cacheMaxBytes?: number; onListenerError?: (e: unknown) => void }) {
    this.timeoutMs = opts.timeoutMs
    this.stlTimeoutMs = opts.stlTimeoutMs ?? DEFAULT_STL_TIMEOUT_MS
    this.spawnFn = opts.spawn
    this.cache = new MeshCache(opts.cacheMax, opts.cacheMaxBytes)
    this.reportError = opts.onListenerError ?? rethrowLater
    this.spawnWorker()
  }

  // ───────────────────────────── public API ─────────────────────────────

  want(jobs: Job[], priorityKeys: Set<string>): void {
    if (this.disposed) return
    const wanted = new Map<string, Job>()
    for (const j of jobs) if (!wanted.has(j.resultKey)) wanted.set(j.resultKey, j)
    this.wanted = wanted
    this.priority = new Set(priorityKeys)
    // keep the FIFO order of keys still wanted, then append new ones in want() order
    const queue = this.queue.filter((k) => wanted.has(k) && this.needsRun(k))
    const inQueue = new Set(queue)
    for (const k of wanted.keys()) if (!inQueue.has(k) && this.needsRun(k)) { queue.push(k); inQueue.add(k) }
    this.setQueue(queue)
    this.checkAbandon()
    this.evict()
    this.pump()
  }

  get(resultKey: string): ResultState | undefined {
    const entry = this.cache.get(resultKey)
    if (entry) return { state: 'ready', entry }
    const error = this.failures.get(resultKey)
    if (error) return { state: 'failed', error }
    if (this.queued.has(resultKey) || this.inFlightKey() === resultKey) return { state: 'pending' }
    return undefined
  }

  retry(resultKeys: string[]): void {
    if (this.disposed) return
    const changed: string[] = []
    const queue = [...this.queue]
    for (const k of resultKeys) {
      if (this.failures.delete(k)) changed.push(k)
      if (this.wanted.has(k) && this.needsRun(k) && !this.queued.has(k) && !queue.includes(k)) queue.push(k)
    }
    this.setQueue(queue)
    if (changed.length) this.emitChange(changed)
    this.pump()
  }

  exportStl(items: StlItems): Promise<StlResult> {
    if (this.disposed) return Promise.reject(new Error('The evaluator was shut down'))
    if (this.fatal) return Promise.reject(new Error(this.fatal))
    return new Promise<StlResult>((resolve, reject) => {
      this.stlQueue.push({ items, resolve, reject })
      this.pump()
    })
  }

  onChange(cb: (keys: string[]) => void): () => void {
    this.changeCbs.add(cb)
    return () => { this.changeCbs.delete(cb) }
  }

  onStatus(cb: (s: EvalStatus) => void): () => void {
    this.statusCbs.add(cb)
    return () => { this.statusCbs.delete(cb) }
  }

  status(): EvalStatus {
    const s: EvalStatus = { queued: this.queue.length, alive: this.ready && this.worker !== null }
    const f = this.inFlight
    if (f) s.running = { defName: f.kind === 'eval' ? f.job.spec.name : 'STL export', ms: Math.max(0, Date.now() - f.start) }
    if (this.last) s.last = { ...this.last }
    if (this.fatal) s.fatal = this.fatal
    return s
  }

  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve()
    return new Promise<void>((resolve) => { this.idleWaiters.push(resolve) })
  }

  setInUse(keys: Iterable<string>): void {
    this.inUse = new Set(keys)
    this.evict()
  }

  stats(): EvalClientStats {
    let entriesInUse = 0
    let failed = 0
    for (const k of this.wanted.keys()) {
      if (this.cache.has(k)) entriesInUse++
      else if (this.failures.has(k)) failed++
    }
    return {
      cacheEntries: this.cache.size, entriesInUse, queued: this.queue.length, inFlight: this.inFlight ? 1 : 0,
      failed, spawns: this.spawnCount, crashes: this.crashCount,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const f = this.inFlight
    this.finishInFlight()
    this.killWorker()
    clearTimeout(this.respawnTimer)
    this.respawnTimer = undefined
    const err = new Error('The evaluator was shut down')
    if (f?.kind === 'stl') f.req.reject(err)
    for (const r of this.stlQueue.splice(0)) r.reject(err)
    this.setQueue([])
    this.changeCbs.clear()
    this.statusCbs.clear()
    this.resolveIdle()
  }

  // ───────────────────────────── extras (debugging / view helpers) ─────────────────────────────

  /** The cached entry for a key without touching LRU recency (undefined if not ready). */
  peekEntry(resultKey: string): MeshEntry | undefined { return this.cache.peek(resultKey) }

  // ───────────────────────────── queue ─────────────────────────────

  private needsRun(key: string): boolean {
    return !this.cache.has(key) && !this.failures.has(key) && this.inFlightKey() !== key
  }

  private inFlightKey(): string | undefined {
    return this.inFlight?.kind === 'eval' ? this.inFlight.key : undefined
  }

  /** Install a new queue (kept in arrival = FIFO order; priority is applied when picking the next key). */
  private setQueue(queue: string[]): void {
    this.queue = queue
    this.queued = new Set(queue)
  }

  /** Remove and return the next key to send: the first priority key in FIFO order, else the head of the queue. */
  private takeNext(): string | undefined {
    if (this.queue.length === 0) return undefined
    let i = this.priority.size ? this.queue.findIndex((k) => this.priority.has(k)) : -1
    if (i < 0) i = 0
    const [key] = this.queue.splice(i, 1)
    this.queued.delete(key)
    return key
  }

  private isIdle(): boolean {
    return this.disposed || this.fatal !== undefined || (this.queue.length === 0 && this.inFlight === null && this.stlQueue.length === 0)
  }

  /** Send the next request if the worker is ready and nothing is in flight; then notify status / idle waiters. */
  private pump(): void {
    if (this.disposed) return
    while (!this.fatal && this.ready && this.worker && !this.inFlight) {
      const stl = this.stlQueue.shift()
      if (stl) { this.sendStl(stl); continue }
      const key = this.takeNext()
      if (key === undefined) break
      const job = this.wanted.get(key) // queued keys that are no longer wanted are dropped here
      if (job && this.needsRun(key)) this.sendEval(job)
    }
    this.emitStatus()
    if (this.isIdle()) this.resolveIdle()
  }

  private sendEval(job: Job): void {
    const id = this.nextId++
    const f: InFlight = { kind: 'eval', id, key: job.resultKey, job, start: Date.now() }
    this.inFlight = f
    try {
      this.worker!.postMessage({ type: 'eval', id, job } satisfies ToWorker)
    } catch (x) {
      // e.g. DataCloneError: nothing was sent; record it like a crash of this job and move on
      this.finishInFlight()
      this.failures.set(f.key, this.jobError(job, 'crash', 'Could not send the job to the evaluator: ' + String((x as Error)?.message ?? x)))
      this.emitChange([f.key])
      return
    }
    this.armInFlightTimers(id, this.timeoutMs)
    this.checkAbandon()
  }

  private sendStl(req: StlRequest): void {
    const id = this.nextId++
    this.inFlight = { kind: 'stl', id, req, start: Date.now() }
    try {
      this.worker!.postMessage({ type: 'stl', id, items: req.items } satisfies ToWorker)
    } catch (x) {
      this.finishInFlight()
      req.reject(new Error('STL export failed: ' + String((x as Error)?.message ?? x)))
      return
    }
    this.armInFlightTimers(id, this.stlTimeoutMs)
  }

  private armInFlightTimers(id: number, timeout: number): void {
    this.jobTimer = setTimeout(() => this.onTimeout(id), timeout)
    this.tickTimer = setInterval(() => this.emitStatus(), STATUS_TICK_MS)
  }

  private finishInFlight(): void {
    clearTimeout(this.jobTimer)
    clearTimeout(this.abandonTimer)
    clearInterval(this.tickTimer)
    this.jobTimer = this.abandonTimer = this.tickTimer = undefined
    this.inFlight = null
  }

  /** In-flight eval whose key is no longer wanted: kill it once it has run for ABANDON_MS (no failure recorded). */
  private checkAbandon(): void {
    clearTimeout(this.abandonTimer)
    this.abandonTimer = undefined
    const f = this.inFlight
    if (!f || f.kind !== 'eval' || this.wanted.has(f.key)) return
    const left = f.start + ABANDON_MS - Date.now()
    if (left > 0) { this.abandonTimer = setTimeout(() => this.checkAbandon(), left); return }
    this.finishInFlight()
    this.restartWorker()
    this.pump()
  }

  private onTimeout(id: number): void {
    const f = this.inFlight
    if (!f || f.id !== id) return
    this.finishInFlight()
    this.restartWorker()
    if (f.kind === 'eval') {
      this.failures.set(f.key, this.jobError(f.job, 'timeout', `Timed out after ${seconds(this.timeoutMs)} s (infinite loop or very slow boolean?)`))
      this.last = { defName: f.job.spec.name, ms: this.timeoutMs }
      this.emitChange([f.key])
    } else {
      f.req.reject(new Error(`STL export timed out after ${seconds(this.stlTimeoutMs)} s`))
    }
    this.pump()
  }

  private jobError(job: Job, kind: EvalError['kind'], message: string): EvalError {
    return { kind, def: job.spec.def, defName: job.spec.name, message, trace: [job.spec.name] }
  }

  // ───────────────────────────── worker lifecycle ─────────────────────────────

  private spawnWorker(): void {
    if (this.disposed || this.fatal || this.worker) return
    clearTimeout(this.respawnTimer)
    this.respawnTimer = undefined
    this.spawnCount++
    let w: Worker
    try {
      w = this.spawnFn()
    } catch {
      this.startFailed()
      return
    }
    this.worker = w
    this.ready = false
    w.onmessage = (ev: MessageEvent<FromWorker>) => { if (this.worker === w) this.onMessage(ev.data) }
    w.onerror = (ev: ErrorEvent) => {
      ev.preventDefault?.()
      if (this.worker === w) this.onWorkerError(ev.message || 'worker error')
    }
    w.onmessageerror = () => { if (this.worker === w) this.onWorkerError('a message could not be read') }
    this.readyTimer = setTimeout(() => { if (this.worker === w && !this.ready) this.startFailed() }, READY_TIMEOUT_MS)
    this.emitStatus()
  }

  private killWorker(): void {
    clearTimeout(this.readyTimer)
    this.readyTimer = undefined
    const w = this.worker
    this.worker = null
    this.ready = false
    if (!w) return
    w.onmessage = null
    w.onerror = null
    w.onmessageerror = null
    try { w.terminate() } catch { /* already gone */ }
  }

  private restartWorker(): void {
    this.killWorker()
    this.spawnWorker()
  }

  /** The worker errored or never said 'ready': retry with back-off, then give up. */
  private startFailed(): void {
    this.killWorker()
    this.startFailures++
    if (this.startFailures > SPAWN_RETRIES) { this.setFatal(FATAL_START); return }
    clearTimeout(this.respawnTimer)
    this.respawnTimer = setTimeout(() => { this.respawnTimer = undefined; this.spawnWorker() }, SPAWN_BACKOFF_MS * this.startFailures)
    this.emitStatus()
  }

  private onWorkerError(message: string): void {
    if (!this.ready) { this.startFailed(); return }
    const f = this.inFlight
    this.finishInFlight()
    this.killWorker()
    this.crashCount++
    const now = Date.now()
    this.crashTimes = this.crashTimes.filter((t) => now - t < CRASH_WINDOW_MS)
    this.crashTimes.push(now)
    const changed: string[] = []
    if (f?.kind === 'eval') {
      this.failures.set(f.key, this.jobError(f.job, 'crash', `The evaluator crashed (${message})`))
      changed.push(f.key)
    } else if (f?.kind === 'stl') {
      f.req.reject(new Error(`STL export failed: the evaluator crashed (${message})`))
    }
    if (this.crashTimes.length >= CRASH_LIMIT) this.setFatal(FATAL_CRASHING)
    else this.spawnWorker()
    if (changed.length) this.emitChange(changed)
    this.pump()
  }

  private setFatal(message: string): void {
    this.fatal = message
    const f = this.inFlight
    this.finishInFlight()
    this.killWorker()
    clearTimeout(this.respawnTimer)
    this.respawnTimer = undefined
    const err = new Error(message)
    if (f?.kind === 'stl') f.req.reject(err)
    for (const r of this.stlQueue.splice(0)) r.reject(err)
    this.emitStatus()
    this.resolveIdle()
  }

  private onMessage(msg: FromWorker): void {
    if (!msg || typeof msg !== 'object') return
    switch (msg.type) {
      case 'ready': {
        if (this.ready) return
        this.ready = true
        this.startFailures = 0
        clearTimeout(this.readyTimer)
        this.readyTimer = undefined
        this.pump()
        return
      }
      case 'result': {
        const f = this.inFlight
        if (!f || f.kind !== 'eval' || f.id !== msg.id) return // stale
        this.finishInFlight()
        if (msg.ok) {
          this.failures.delete(f.key)
          this.cache.set(f.key, toMeshEntry(msg.meshes, msg.tris, msg.ms, msg.warnings))
        } else {
          this.failures.set(f.key, msg.error)
        }
        this.last = { defName: f.job.spec.name, ms: msg.ms }
        this.evict()
        this.emitChange([f.key])
        this.pump()
        return
      }
      case 'stl': {
        const f = this.inFlight
        if (!f || f.kind !== 'stl' || f.id !== msg.id) return
        this.finishInFlight()
        if (msg.ok) f.req.resolve({ parts: msg.parts, tris: msg.tris })
        else f.req.reject(new Error(msg.error.message))
        this.pump()
        return
      }
    }
  }

  // ───────────────────────────── cache / notifications ─────────────────────────────

  private evict(): void {
    this.cache.evict((k) => this.wanted.has(k) || this.inUse.has(k))
  }

  private emitChange(keys: string[]): void {
    for (const cb of [...this.changeCbs]) {
      try { cb(keys) } catch (e) { this.reportError(e) }
    }
  }

  private emitStatus(): void {
    if (this.statusCbs.size === 0) return
    const s = this.status()
    const json = JSON.stringify(s)
    if (json === this.lastStatusJson) return
    this.lastStatusJson = json
    for (const cb of [...this.statusCbs]) {
      try { cb(s) } catch (e) { this.reportError(e) }
    }
  }

  private resolveIdle(): void {
    const ws = this.idleWaiters
    this.idleWaiters = []
    for (const r of ws) r()
  }
}

export const createEvalClient = (opts: EvalClientOptions): EvalClientApi => new EvalClient(opts)
