// The MCP tools of the 3Dica server. Names, descriptions and input schemas come from shared/tool-catalog.mjs (the
// in-app chat uses the same list); this file adds what only the server does: each tool forwards to the connected
// 3Dica tab over the bridge (the handlers in src/mcp/handlers.ts do the work there), except help (local), status
// (bridge info too) and the file parts of save_project / load_project / export_stl (the server reads and writes the
// files, so they land on the user's disk, not in a browser download).
import fs from 'node:fs/promises'
import path from 'node:path'
import { BridgeError } from './bridge.mjs'
import { codeApiCheatSheet } from './docs.mjs'
import { toolCatalog } from '../../shared/tool-catalog.mjs'

export { paramDefSchema, pathSchema, transformSchema } from '../../shared/tool-catalog.mjs'

// ───────────────────────────── result helpers ─────────────────────────────

const text = (t) => ({ content: [{ type: 'text', text: t }] })
const json = (v) => text(JSON.stringify(v, null, 2))
const fail = (message) => ({ content: [{ type: 'text', text: `Error: ${message}` }], isError: true })

/** Resolve a file path given by the model: absolute, ~/…, or relative to the server's working directory. */
export function resolveUserPath(p, cwd = process.cwd(), home = process.env.HOME || process.env.USERPROFILE || '') {
  if (typeof p !== 'string' || !p.trim()) throw new Error('path must be a file path')
  let s = p.trim()
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = path.join(home, s.slice(1))
  return path.resolve(cwd, s)
}

async function writeFileChecked(abs, data) {
  let existed = false
  try {
    const st = await fs.stat(abs)
    if (st.isDirectory()) throw new Error(`${abs} is a directory — give a file name`)
    existed = true
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e
  }
  try {
    await fs.writeFile(abs, data)
  } catch (e) {
    if (e && e.code === 'ENOENT') throw new Error(`The folder ${path.dirname(abs)} does not exist`)
    throw e
  }
  return existed
}

/**
 * Register every tool on `server` (an McpServer).
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {{ request: (method: string, params?: object, opts?: object) => Promise<any>, info: () => object, connectHint: () => string }} bridge
 * @param {{ cwd?: string, log?: (m: string) => void }} [opts]
 */
export function registerTools(server, bridge, opts = {}) {
  const cwd = opts.cwd ?? process.cwd()
  const log = opts.log ?? (() => {})

  /** forward a tool call to the app; app/bridge errors become tool errors (isError) the model can read */
  const forward = (method, timeoutMs) => async (args) => {
    try {
      return json(await bridge.request(method, args ?? {}, { timeoutMs }))
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
  }

  /** the tools that do more than forward their arguments to the tab */
  const own = {
    async status() {
      const out = { server: bridge.info() }
      try {
        out.app = await bridge.request('status', {}, { timeoutMs: 15_000 })
        out.connected = true
      } catch (e) {
        out.connected = false
        out.hint = e instanceof BridgeError && e.code !== 'no-tab' ? e.message : bridge.connectHint()
      }
      return json(out)
    },

    async help() {
      return text(codeApiCheatSheet())
    },

    async save_project({ path: p }) {
      try {
        const abs = resolveUserPath(p, cwd)
        const r = await bridge.request('save_project', {}, { timeoutMs: 30_000 })
        const existed = await writeFileChecked(abs, r.text)
        return json({ ok: true, path: abs, project: r.name, bytes: Buffer.byteLength(r.text), overwritten: existed })
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    },

    async load_project({ path: p }) {
      try {
        const abs = resolveUserPath(p, cwd)
        let textIn
        try { textIn = await fs.readFile(abs, 'utf8') } catch (e) { throw new Error(e && e.code === 'ENOENT' ? `No file at ${abs}` : `Can't read ${abs}: ${e?.message ?? e}`) }
        const r = await bridge.request('load_project', { text: textIn, fileName: path.basename(abs) }, { timeoutMs: 90_000 })
        return json({ path: abs, ...r })
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    },

    async export_stl({ path: p, target }) {
      try {
        const abs = resolveUserPath(p, cwd)
        const r = await bridge.request('export_stl', target === undefined ? {} : { target }, { timeoutMs: 150_000 })
        const data = Buffer.from(r.base64, 'base64')
        const existed = await writeFileChecked(abs, data)
        const out = { ok: true, path: abs, bytes: data.length, triangles: r.triangles, exported: r.label, overwritten: existed }
        if (r.skipped?.length) out.skipped = r.skipped
        return json(out)
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    },

    async screenshot(args) {
      try {
        const r = await bridge.request('screenshot', args ?? {}, { timeoutMs: 90_000 })
        return { content: [{ type: 'image', data: r.image, mimeType: r.mimeType ?? 'image/png' }, { type: 'text', text: r.text }] }
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e))
      }
    },
  }

  for (const t of toolCatalog('mcp')) {
    const cb = Object.hasOwn(own, t.name) ? own[t.name] : forward(t.name)
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.input, annotations: t.annotations }, cb)
  }

  // ── resource ──
  server.registerResource('code-api', 'threedica://docs/code-api', {
    title: '3Dica code API',
    description: 'Cheat sheet for writing 3Dica code objects (JSCAD 2.13): contract, params, part(), functions in scope, conventions, limits.',
    mimeType: 'text/markdown',
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: codeApiCheatSheet() }] }))

  log('tools registered')
}

/** Tool names, in registration order (docs and tests). */
export const TOOL_NAMES = [
  'status', 'get_scene', 'list_definitions', 'get_definition', 'get_errors', 'help',
  'create_object', 'update_definition', 'add_instance', 'update_instance', 'move_instance', 'duplicate', 'make_unique', 'wrap', 'ungroup', 'delete',
  'undo', 'redo', 'select', 'set_view', 'new_project', 'load_sample', 'save_project', 'load_project', 'export_stl', 'screenshot',
]
