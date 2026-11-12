// MCP bridge opt-in (src/mcp/bridge.ts). Pure: decides from the URL, the host name and one localStorage key whether
// this tab connects to a local 3Dica MCP server, and on which port. Normal users never see a WebSocket attempt:
//   ?mcp            enable and remember (key 3dica:v1:mcp); ?mcp&mcpPort=6200 also remembers the port
//   ?mcp=0          disable and forget
//   (no parameter)  whatever was remembered
// Only on localhost / 127.0.0.1 / [::1] — never on a published copy such as GitHub Pages.

export const MCP_STORAGE_KEY = '3dica:v1:mcp'
export const DEFAULT_MCP_PORT = 6173

export interface McpConfig {
  enabled: boolean
  port: number
  /** why it is off (for debugging); undefined when enabled */
  reason?: 'not-local' | 'not-enabled' | 'disabled'
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname.toLowerCase())
}

function validPort(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,5}$/.test(v.trim()) ? Number(v) : NaN
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null
}

/** Stored value: '{"port":6173}' (port optional). Anything unreadable counts as "enabled, default port". */
function readStored(storage: StorageLike | null): { port: number | null } | null {
  let raw: string | null = null
  try { raw = storage?.getItem(MCP_STORAGE_KEY) ?? null } catch { return null }
  if (raw === null) return null
  try {
    const v = JSON.parse(raw) as { port?: unknown }
    return { port: validPort(v?.port) }
  } catch {
    return { port: null }
  }
}

/**
 * Decide and persist. `search` is location.search, `hostname` location.hostname. Storage failures are ignored
 * (private windows): the URL still decides for this page.
 */
export function resolveMcpConfig(search: string, hostname: string, storage: StorageLike | null): McpConfig {
  const p = new URLSearchParams(search)
  const urlPort = validPort(p.get('mcpPort'))
  const param = p.get('mcp')
  if (param !== null && /^(0|false|off|no)$/i.test(param.trim())) {
    try { storage?.removeItem(MCP_STORAGE_KEY) } catch { /* ignore */ }
    return { enabled: false, port: urlPort ?? DEFAULT_MCP_PORT, reason: 'disabled' }
  }
  if (!isLocalHost(hostname)) return { enabled: false, port: urlPort ?? DEFAULT_MCP_PORT, reason: 'not-local' }
  if (param !== null) {
    try { storage?.setItem(MCP_STORAGE_KEY, JSON.stringify(urlPort ? { port: urlPort } : {})) } catch { /* ignore */ }
    return { enabled: true, port: urlPort ?? DEFAULT_MCP_PORT }
  }
  const stored = readStored(storage)
  if (!stored) return { enabled: false, port: urlPort ?? DEFAULT_MCP_PORT, reason: 'not-enabled' }
  return { enabled: true, port: urlPort ?? stored.port ?? DEFAULT_MCP_PORT }
}

/** The pill's "Disconnect and disable": forget the opt-in. */
export function forgetMcp(storage: StorageLike | null): void {
  try { storage?.removeItem(MCP_STORAGE_KEY) } catch { /* ignore */ }
}

/** Reconnect delay after `failures` consecutive failed attempts: 0.5 s, 1 s, 2 s, 4 s, 8 s, then 10 s. */
export function backoffMs(failures: number): number {
  return Math.min(10_000, 500 * 2 ** Math.max(0, failures))
}
