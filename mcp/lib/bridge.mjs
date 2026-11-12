// The server side of the 3Dica MCP bridge: a WebSocket server on 127.0.0.1 that running 3Dica tabs connect to
// (src/mcp/bridge.ts). Requests are JSON with ids and per-request timeouts. The most recently connected tab is the
// active one; older tabs are told they were superseded. Logs go to the `log` callback (stderr) — never to stdout,
// which belongs to the MCP stdio protocol.
import { WebSocketServer } from 'ws'

export const PROTOCOL = 1
export const DEFAULT_TIMEOUT_MS = 60_000

/** A request that could not be answered (no tab, timeout, the tab went away, or the app reported an error). */
export class BridgeError extends Error {
  /** @param {string} message @param {'no-tab' | 'timeout' | 'closed' | 'app' | 'busy-port'} code */
  constructor(message, code) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i

/** Only pages served from this machine may connect: http(s)://localhost:*, 127.0.0.1:* or [::1]:*. */
export function originAllowed(origin) {
  return typeof origin === 'string' && LOCAL_ORIGIN.test(origin.trim())
}

/**
 * @typedef {{ send(data: string): void; close(code?: number, reason?: string): void; on(ev: string, cb: (...a: any[]) => void): void; readyState?: number }} SocketLike
 */

export class Bridge {
  /**
   * @param {{ port?: number, host?: string, log?: (msg: string) => void, appUrl?: string, timeoutMs?: number, serverName?: string }} opts
   */
  constructor(opts = {}) {
    this.port = opts.port ?? 6173
    this.host = opts.host ?? '127.0.0.1'
    this.log = opts.log ?? (() => {})
    this.appUrl = opts.appUrl ?? 'http://localhost:5173/'
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.serverName = opts.serverName ?? '3dica-mcp'
    /** connected tabs that said hello, oldest first; the last one is active */
    this.tabs = []
    this.nextId = 1
    /** id → { resolve, reject, timer, tab, method } */
    this.pending = new Map()
    this.waiters = []
    this.wss = null
    this.listenError = null
    /** set while --serve / --headless / --open is bringing a tab up (tools wait longer for it) */
    this.launching = null
  }

  /** Listen on host:port. Rejects with a BridgeError('busy-port') when the port is taken. */
  start() {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: this.host,
        port: this.port,
        maxPayload: 512 * 1024 * 1024, // STL exports travel as base64
        verifyClient: (info, cb) => {
          const ok = originAllowed(info.origin)
          if (!ok) this.log(`rejected a connection from origin ${JSON.stringify(info.origin ?? null)}`)
          cb(ok, 403, 'Only 3Dica pages served from localhost may connect')
        },
      })
      const onError = (e) => {
        wss.off('listening', onListening)
        const msg = e && e.code === 'EADDRINUSE'
          ? `port ${this.port} is already in use (another 3Dica MCP server?) — start this one with --port <n> and open the app with ?mcp&mcpPort=<n>`
          : `could not listen on ${this.host}:${this.port}: ${e?.message ?? e}`
        this.listenError = msg
        reject(new BridgeError(msg, 'busy-port'))
      }
      const onListening = () => {
        wss.off('error', onError)
        wss.on('error', (e) => this.log(`bridge error: ${e?.message ?? e}`))
        const addr = wss.address()
        if (addr && typeof addr === 'object') this.port = addr.port
        this.wss = wss
        resolve()
      }
      wss.once('error', onError)
      wss.once('listening', onListening)
      wss.on('connection', (ws) => this.attach(ws))
    })
  }

  async close() {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new BridgeError('The MCP server is shutting down', 'closed')) }
    this.pending.clear()
    for (const t of this.tabs) { try { t.socket.close(1001, 'server shutting down') } catch { /* ignore */ } }
    this.tabs = []
    const wss = this.wss
    this.wss = null
    if (wss) await new Promise((resolve) => wss.close(() => resolve()))
  }

  /** The active tab (most recently connected), or null. */
  active() {
    return this.tabs.length ? this.tabs[this.tabs.length - 1] : null
  }

  /**
   * Take over a connected socket (also used by unit tests with a fake socket). The socket becomes a tab once it sends
   * { type: 'hello' }.
   * @param {SocketLike} socket
   */
  attach(socket) {
    const conn = { socket, hello: null, connectedAt: new Date(), id: 0 }
    socket.on('message', (data, isBinary) => {
      if (isBinary) return
      let msg
      try { msg = JSON.parse(String(data)) } catch { this.log('ignored a message that is not JSON'); return }
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'hello') this.onHello(conn, msg)
      else if (msg.type === 'response') this.onResponse(conn, msg)
      else if (msg.type === 'claim') this.makeActive(conn)
    })
    socket.on('close', () => this.onClose(conn))
    socket.on('error', (e) => this.log(`tab socket error: ${e?.message ?? e}`))
  }

  onHello(conn, msg) {
    conn.hello = {
      protocol: typeof msg.protocol === 'number' ? msg.protocol : 0,
      app: typeof msg.app === 'string' ? msg.app : '',
      url: typeof msg.url === 'string' ? msg.url : '',
      title: typeof msg.title === 'string' ? msg.title : '',
    }
    this.sendTo(conn, { type: 'welcome', protocol: PROTOCOL, server: this.serverName })
    if (conn.hello.protocol !== PROTOCOL) this.log(`tab ${conn.hello.url} speaks bridge protocol ${conn.hello.protocol}, this server ${PROTOCOL} — reload the tab`)
    this.makeActive(conn)
    this.log(`tab connected: ${conn.hello.url || '(no url)'}${this.tabs.length > 1 ? ` (${this.tabs.length - 1} older tab${this.tabs.length > 2 ? 's' : ''} superseded)` : ''}`)
  }

  /** Move `conn` to the end (active) and tell the previously active tab it was superseded. */
  makeActive(conn) {
    if (!conn.hello) return
    const prev = this.active()
    this.tabs = this.tabs.filter((t) => t !== conn)
    this.tabs.push(conn)
    if (prev && prev !== conn) this.sendTo(prev, { type: 'superseded' })
    this.sendTo(conn, { type: 'active' })
    const waiters = this.waiters
    this.waiters = []
    for (const w of waiters) w()
  }

  onClose(conn) {
    const wasActive = this.active() === conn
    this.tabs = this.tabs.filter((t) => t !== conn)
    for (const [id, p] of this.pending) {
      if (p.conn !== conn) continue
      clearTimeout(p.timer)
      this.pending.delete(id)
      p.reject(new BridgeError(`The 3Dica tab closed or reloaded while handling '${p.method}' — try again`, 'closed'))
    }
    if (conn.hello) this.log(`tab disconnected: ${conn.hello.url || '(no url)'}`)
    if (wasActive) {
      const next = this.active()
      if (next) { this.sendTo(next, { type: 'active' }); this.log(`active tab is now ${next.hello?.url}`) }
    }
  }

  onResponse(conn, msg) {
    const p = this.pending.get(msg.id)
    if (!p || p.conn !== conn) return
    clearTimeout(p.timer)
    this.pending.delete(msg.id)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new BridgeError(String(msg.error?.message ?? 'The app reported an error'), 'app'))
  }

  sendTo(conn, msg) {
    try { conn.socket.send(JSON.stringify(msg)) } catch (e) { this.log(`send failed: ${e?.message ?? e}`) }
  }

  /** Resolves true once a tab is active (immediately if one is), false after `ms`. */
  waitForTab(ms) {
    if (this.active()) return Promise.resolve(true)
    if (ms <= 0) return Promise.resolve(false)
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); resolve(true) }
      const timer = setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== done); resolve(false) }, ms)
      this.waiters.push(done)
    })
  }

  /** How to get a tab connected (used in error messages and the status tool). */
  connectHint() {
    if (this.listenError) return `The bridge is not running: ${this.listenError}.`
    const url = new URL(this.appUrl)
    url.search = this.port === 6173 ? '?mcp' : `?mcp&mcpPort=${this.port}`
    return `No 3Dica tab is connected. Start the app (npm run dev in the 3Dica folder) and open ${url.href} in a browser on this machine — the status bar then shows "MCP · connected". Or restart this server with --serve --headless to run its own app and browser.`
  }

  /**
   * Send a request to the active tab and wait for its response.
   * @param {string} method @param {Record<string, unknown>} [params] @param {{ timeoutMs?: number, waitMs?: number }} [opts]
   */
  async request(method, params = {}, opts = {}) {
    if (this.listenError) throw new BridgeError(this.connectHint(), 'busy-port')
    const waitMs = opts.waitMs ?? (this.launching ? 90_000 : 3_000)
    if (!this.active()) {
      if (this.launching) this.log(`waiting for the tab that is starting (${method})…`)
      await this.waitForTab(waitMs)
    }
    const conn = this.active()
    if (!conn) throw new BridgeError(this.connectHint(), 'no-tab')
    const id = this.nextId++
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BridgeError(`The 3Dica tab did not answer '${method}' within ${Math.round(timeoutMs / 1000)} s (is the tab frozen by a long evaluation?)`, 'timeout'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, conn, method })
      this.sendTo(conn, { type: 'request', id, method, params })
    })
  }

  /** Bridge status for the status tool. */
  info() {
    const a = this.active()
    return {
      bridge: this.listenError ? `not running: ${this.listenError}` : `ws://${this.host}:${this.port}`,
      tabs: this.tabs.length,
      activeTab: a ? { url: a.hello?.url ?? '', title: a.hello?.title ?? '', connectedAt: a.connectedAt.toISOString() } : null,
      launching: this.launching ?? undefined,
    }
  }
}
