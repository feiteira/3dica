// The app side of the local MCP bridge. Opt-in (src/mcp/config.ts): with ?mcp on localhost this tab connects to the
// MCP server's WebSocket (ws://127.0.0.1:6173 by default, ?mcpPort=<n> to change) and answers its requests with the
// handlers in ./handlers.ts. Requests run one at a time. The most recently connected tab is the active one; an
// older tab is told it was superseded and stays passive (it does not reconnect) until the user picks "Use this tab".
//
// Wire format (JSON text frames):
//   tab → server  { type: 'hello', protocol: 1, app, url, title }
//                 { type: 'response', id, ok: true, result } | { type: 'response', id, ok: false, error: { message } }
//                 { type: 'claim' }
//   server → tab  { type: 'welcome', protocol, server } | { type: 'active' } | { type: 'superseded' }
//                 { type: 'request', id, method, params }
import type { AppContext, McpBridgeApi, McpState } from '../app/context'
import { APP_ID } from '../core/project-io'
import { backoffMs, forgetMcp, resolveMcpConfig, type StorageLike } from './config'
import { createHandlers, type Handler } from './handlers'

export const MCP_PROTOCOL = 1

interface Request { type: 'request'; id: number | string; method: string; params?: Record<string, unknown> }

function storage(): StorageLike | null {
  try { return globalThis.localStorage ?? null } catch { return null }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Start the bridge if this page opted in; null otherwise (then no WebSocket is ever created). */
export function startMcpBridge(ctx: AppContext): McpBridgeApi | null {
  const cfg = resolveMcpConfig(location.search, location.hostname, storage())
  if (!cfg.enabled) return null
  return new Bridge(ctx, cfg.port)
}

class Bridge implements McpBridgeApi {
  readonly port: number
  private readonly ctx: AppContext
  private readonly handlers: Record<string, Handler>
  private ws: WebSocket | null = null
  private st: McpState = 'connecting'
  private failures = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  /** false after disable(), and while superseded with the socket closed */
  private reconnect = true
  private queue: Promise<void> = Promise.resolve()
  private last: { label: string; at: Date } | null = null
  private readonly listeners = new Set<() => void>()

  constructor(ctx: AppContext, port: number) {
    this.ctx = ctx
    this.port = port
    this.handlers = createHandlers(ctx, { onAction: (label) => { this.last = { label, at: new Date() }; this.notify() } })
    document.addEventListener('visibilitychange', () => {
      // a tab brought back to the front retries at once instead of waiting for its back-off
      if (document.visibilityState === 'visible' && !this.ws && this.reconnect && this.st === 'connecting') this.connectNow()
    })
    this.connect()
  }

  state(): McpState { return this.st }
  lastAction(): { label: string; at: Date } | null { return this.last }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  claim(): void {
    if (this.st === 'off') return
    this.reconnect = true
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.send({ type: 'claim' })
    else { this.setState('connecting'); this.connectNow() }
  }

  disable(): void {
    this.reconnect = false
    forgetMcp(storage())
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    const ws = this.ws
    this.ws = null
    if (ws) { ws.onclose = null; ws.close() }
    this.setState('off')
    this.ctx.toast('MCP disconnected and disabled for this browser — add ?mcp to the address to turn it on again')
  }

  private notify(): void { for (const cb of [...this.listeners]) cb() }

  private setState(s: McpState): void {
    if (this.st === s) return
    this.st = s
    this.notify()
  }

  private connectNow(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.failures = 0
    this.connect()
  }

  private connect(): void {
    if (!this.reconnect || this.ws || this.st === 'off') return
    let ws: WebSocket
    try {
      ws = new WebSocket(`ws://127.0.0.1:${this.port}`)
    } catch {
      this.retryLater()
      return
    }
    this.ws = ws
    let opened = false
    ws.onopen = () => {
      opened = true
      this.failures = 0
      this.send({ type: 'hello', protocol: MCP_PROTOCOL, app: APP_ID, url: location.href, title: document.title })
    }
    ws.onmessage = (ev) => this.onMessage(ev.data)
    ws.onerror = () => { /* a close event follows */ }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      if (!opened) this.failures++
      if (this.st === 'superseded') { this.reconnect = false; this.notify(); return }
      this.setState('connecting')
      this.retryLater()
    }
  }

  private retryLater(): void {
    if (!this.reconnect || this.timer) return
    this.timer = setTimeout(() => { this.timer = null; this.connect() }, backoffMs(this.failures))
  }

  private send(msg: unknown): void {
    const ws = this.ws
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  private onMessage(data: unknown): void {
    if (typeof data !== 'string') return
    let msg: { type?: string }
    try { msg = JSON.parse(data) as { type?: string } } catch { return }
    if (msg.type === 'active') this.setState('connected')
    else if (msg.type === 'superseded') this.setState('superseded')
    else if (msg.type === 'request') {
      const req = msg as Request
      this.queue = this.queue.then(() => this.handle(req))
    }
  }

  private async handle(req: Request): Promise<void> {
    const fn = Object.hasOwn(this.handlers, req.method) ? this.handlers[req.method] : undefined
    if (!fn) {
      this.send({ type: 'response', id: req.id, ok: false, error: { message: `Unknown method '${req.method}' — the MCP server and the app are different versions; reload the tab` } })
      return
    }
    try {
      const result = await fn(req.params && typeof req.params === 'object' ? req.params : {})
      this.send({ type: 'response', id: req.id, ok: true, result })
    } catch (e) {
      this.send({ type: 'response', id: req.id, ok: false, error: { message: errorText(e) } })
    }
    this.notify()
  }
}
