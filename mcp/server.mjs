#!/usr/bin/env node
// 3Dica MCP server: lets AI assistants (Claude Code, Claude Desktop, any MCP client) drive a running 3Dica tab and
// see it through screenshots. Speaks MCP over stdio; talks to the tab over a WebSocket on 127.0.0.1 (default port
// 6173) that the app joins when it is opened with ?mcp. See docs/guide/mcp.md.
//
//   node mcp/server.mjs [--port 6173] [--serve [--app-port 5173]] [--headless | --open] [--app-url <url>]
//
// stdout is the MCP protocol: everything else (logs, Vite, the browser) goes to stderr.
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Bridge } from './lib/bridge.mjs'
import { INSTRUCTIONS } from './lib/docs.mjs'
import { registerTools } from './lib/tools.mjs'
import { connectUrl, launchHeadless, openBrowser, serveApp } from './lib/launch.mjs'

export const SERVER_NAME = '3dica'
export const SERVER_VERSION = '0.1.0'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const USAGE = `3Dica MCP server ${SERVER_VERSION}

Usage: node mcp/server.mjs [options]   (an MCP client starts this; it speaks MCP on stdio)

Options:
  --port <n>        WebSocket bridge port on 127.0.0.1 (default 6173, or env THREEDICA_MCP_PORT)
  --app-url <url>   where the 3Dica app runs (default http://localhost:<app-port>/)
  --serve           if nothing answers at the app URL, start a Vite dev server for 3Dica in this process
  --app-port <n>    port for --serve and the default app URL (default 5173)
  --headless        open the app in a headless Chromium (fresh profile) — fully autonomous with --serve
  --open            open the app in your default browser
  -h, --help        this help

The app joins when opened with ?mcp (and &mcpPort=<n> for a non-default port), on localhost only.`

/** Parse argv (without node and the script). Throws on bad input. */
export function parseArgs(argv, env = process.env) {
  const o = { port: 6173, appPort: 5173, appUrl: null, serve: false, headless: false, open: false, help: false, strictAppPort: false }
  const envPort = env.THREEDICA_MCP_PORT
  if (envPort !== undefined && envPort !== '') o.port = portOf(envPort, 'THREEDICA_MCP_PORT')
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined]
    const value = () => {
      if (inline !== undefined) return inline
      const v = argv[++i]
      if (v === undefined) throw new Error(`${flag} needs a value`)
      return v
    }
    switch (flag) {
      case '--port': o.port = portOf(value(), '--port'); break
      case '--app-port': o.appPort = portOf(value(), '--app-port'); o.strictAppPort = true; break
      case '--app-url': o.appUrl = new URL(value()).href; break
      case '--serve': o.serve = true; break
      case '--headless': o.headless = true; break
      case '--open': o.open = true; break
      case '-h': case '--help': o.help = true; break
      default: throw new Error(`Unknown option ${a} (see --help)`)
    }
  }
  if (o.headless && o.open) throw new Error('Use --headless or --open, not both')
  if (!o.appUrl) o.appUrl = `http://localhost:${o.appPort}/`
  return o
}

function portOf(v, what) {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${what} must be a port number`)
  return n
}

/** Create the MCP server with every tool registered (no transport yet). */
export function createMcpServer(bridge, opts = {}) {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS })
  registerTools(server, bridge, opts)
  return server
}

async function main() {
  // nothing but MCP may reach stdout
  console.log = console.info = console.debug = (...a) => console.error(...a)
  const log = (m) => process.stderr.write(`[3dica-mcp] ${m}\n`)

  let o
  try {
    o = parseArgs(process.argv.slice(2))
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${USAGE}\n`)
    process.exit(2)
  }
  if (o.help) { process.stderr.write(`${USAGE}\n`); return }

  const bridge = new Bridge({ port: o.port, log, appUrl: o.appUrl, serverName: `${SERVER_NAME}-mcp ${SERVER_VERSION}` })
  try {
    await bridge.start()
    log(`bridge listening on ws://127.0.0.1:${bridge.port}`)
  } catch (e) {
    // keep serving MCP so the client gets a readable error from every tool instead of a dead server
    log(e.message)
  }

  const server = createMcpServer(bridge, { log })
  const transport = new StdioServerTransport()
  await server.connect(transport)

  let vite = null
  let browser = null
  let stopping = false
  const shutdown = async (why) => {
    if (stopping) return
    stopping = true
    log(`shutting down (${why})`)
    const force = setTimeout(() => process.exit(0), 3000)
    force.unref()
    try { await browser?.close() } catch { /* ignore */ }
    try { await vite?.close() } catch { /* ignore */ }
    try { await bridge.close() } catch { /* ignore */ }
    try { await server.close() } catch { /* ignore */ }
    process.exit(0)
  }
  process.stdin.on('end', () => void shutdown('stdin closed'))
  process.stdin.on('close', () => void shutdown('stdin closed'))
  transport.onclose = () => void shutdown('transport closed')
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => void shutdown(sig))

  if (bridge.listenError) return
  if (o.serve || o.headless || o.open) {
    bridge.launching = o.serve ? 'starting the app' : 'opening a browser'
    ;(async () => {
      let appUrl = o.appUrl
      if (o.serve) {
        const r = await serveApp({ root: ROOT, appPort: o.appPort, strictPort: o.strictAppPort, log })
        vite = r.server
        if (!r.reused) appUrl = r.url
        bridge.appUrl = appUrl
      }
      const url = connectUrl(appUrl, bridge.port)
      if (o.headless) {
        bridge.launching = 'starting a headless browser'
        browser = (await launchHeadless({ url, log })).browser
      } else if (o.open) openBrowser(url, log)
      else log(`open ${url} in a browser to connect a tab`)
      const ok = await bridge.waitForTab(60_000)
      if (!ok) log(`no tab connected yet — open ${url}`)
    })().catch((e) => log(`launch failed: ${e?.message ?? e}`)).finally(() => { bridge.launching = null })
  } else {
    log(`open ${connectUrl(o.appUrl, bridge.port)} in a browser on this machine to connect a tab`)
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main().catch((e) => { process.stderr.write(`[3dica-mcp] fatal: ${e?.stack ?? e}\n`); process.exit(1) })
