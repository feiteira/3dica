// The MCP server (mcp/*.mjs, plain Node ESM): the WebSocket bridge's request plumbing with fake sockets, the
// origin check on a real socket, CLI parsing, the code-API cheat sheet (same names as the engine), and the tools over
// an in-memory MCP transport with a fake bridge. The .mjs modules are loaded with dynamic import (no types).
import { afterEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { WebSocket } from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { FLAT_NAMES } from '../../src/eval/engine'

const root = path.resolve(import.meta.dirname, '../..')
const load = async (rel: string): Promise<any> => import(/* @vite-ignore */ pathToFileURL(path.join(root, rel)).href)
const B = await load('mcp/lib/bridge.mjs')
const D = await load('mcp/lib/docs.mjs')
const T = await load('mcp/lib/tools.mjs')
const S = await load('mcp/server.mjs')
const L = await load('mcp/lib/launch.mjs')

/** A ws-like socket: records what the server sends; `deliver` plays a message from the tab. */
class FakeSocket extends EventEmitter {
  sent: Record<string, unknown>[] = []
  closed = false
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close() { this.closed = true; this.emit('close') }
  deliver(msg: unknown) { this.emit('message', Buffer.from(typeof msg === 'string' ? msg : JSON.stringify(msg)), false) }
  types() { return this.sent.map((m) => m.type) }
  lastRequest() { return [...this.sent].reverse().find((m) => m.type === 'request') as { id: number; method: string; params: unknown } | undefined }
}

function tab(bridge: { attach(s: FakeSocket): void }, url = 'http://localhost:5173/?mcp') {
  const s = new FakeSocket()
  bridge.attach(s)
  s.deliver({ type: 'hello', protocol: 1, app: '3dica 0.1.0', url, title: '3Dica' })
  return s
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const c of cleanups.splice(0)) await c() })

describe('mcp server: origin check', () => {
  it('allows pages served from this machine only', () => {
    for (const o of ['http://localhost:5173', 'https://localhost', 'http://127.0.0.1:4173', 'http://[::1]:5173', 'HTTP://LOCALHOST:1']) expect(B.originAllowed(o), o).toBe(true)
    for (const o of [undefined, null, '', 'null', 'http://evil.example', 'http://localhost.evil.example', 'http://127.0.0.1.evil:80', 'file://', 'https://feiteira.github.io', 'http://localhost:5173/path', 'ws://localhost:5173']) {
      expect(B.originAllowed(o), String(o)).toBe(false)
    }
  })
})

describe('mcp server: bridge plumbing (fake sockets)', () => {
  it('a tab becomes active after hello; requests and responses match by id', async () => {
    const bridge = new B.Bridge({ port: 6173 })
    const s = tab(bridge)
    expect(s.types()).toEqual(['welcome', 'active'])
    expect(bridge.info()).toMatchObject({ tabs: 1, activeTab: { url: 'http://localhost:5173/?mcp' } })
    const p = bridge.request('get_scene', { depth: 1 })
    await tick()
    const req = s.lastRequest()!
    expect(req).toMatchObject({ method: 'get_scene', params: { depth: 1 } })
    s.deliver({ type: 'response', id: 999, ok: true, result: 'not mine' })
    s.deliver({ type: 'response', id: req.id, ok: true, result: { tree: [] } })
    await expect(p).resolves.toEqual({ tree: [] })
  })

  it('an app error becomes a BridgeError with the app message', async () => {
    const bridge = new B.Bridge()
    const s = tab(bridge)
    const p = bridge.request('delete', {})
    await tick()
    s.deliver({ type: 'response', id: s.lastRequest()!.id, ok: false, error: { message: "Can't delete 'Bolt'" } })
    await expect(p).rejects.toMatchObject({ name: 'BridgeError', code: 'app', message: "Can't delete 'Bolt'" })
  })

  it('times out with a clear message', async () => {
    const bridge = new B.Bridge()
    tab(bridge)
    await expect(bridge.request('screenshot', {}, { timeoutMs: 20 })).rejects.toMatchObject({ code: 'timeout', message: expect.stringMatching(/did not answer 'screenshot'/) })
    expect(bridge.pending.size).toBe(0)
  })

  it('without a tab: waits briefly, then explains how to connect (with the port)', async () => {
    const bridge = new B.Bridge({ port: 6811, appUrl: 'http://localhost:5711/' })
    const t0 = Date.now()
    await expect(bridge.request('status', {}, { waitMs: 30 })).rejects.toMatchObject({ code: 'no-tab', message: expect.stringContaining('http://localhost:5711/?mcp&mcpPort=6811') })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25)
    expect(new B.Bridge().connectHint()).toContain('http://localhost:5173/?mcp ')
  })

  it('a request waits for a tab that connects in the meantime', async () => {
    const bridge = new B.Bridge()
    const p = bridge.request('status', {}, { waitMs: 1000 })
    await tick()
    const s = tab(bridge)
    await tick()
    s.deliver({ type: 'response', id: s.lastRequest()!.id, ok: true, result: 'ok' })
    await expect(p).resolves.toBe('ok')
  })

  it('the newest tab is active; the older one is superseded; closing the active one promotes the previous; claim', async () => {
    const bridge = new B.Bridge()
    const a = tab(bridge, 'http://localhost:5173/?mcp#a')
    const b = tab(bridge, 'http://localhost:5173/?mcp#b')
    expect(a.types()).toEqual(['welcome', 'active', 'superseded'])
    expect(b.types()).toEqual(['welcome', 'active'])
    const p = bridge.request('status')
    await tick()
    expect(a.lastRequest()).toBeUndefined()
    expect(b.lastRequest()!.method).toBe('status')
    b.close()
    await expect(p).rejects.toMatchObject({ code: 'closed' })
    expect(a.types().at(-1)).toBe('active')
    expect(bridge.info().activeTab.url).toContain('#a')
    // claim: a superseded tab takes over again
    const c = tab(bridge, 'http://localhost:5173/?mcp#c')
    expect(a.types().at(-1)).toBe('superseded')
    a.deliver({ type: 'claim' })
    expect(c.types().at(-1)).toBe('superseded')
    expect(a.types().at(-1)).toBe('active')
  })

  it('ignores sockets that never said hello, binary frames and junk', async () => {
    const bridge = new B.Bridge()
    const silent = new FakeSocket()
    bridge.attach(silent)
    silent.emit('message', Buffer.from('{"type":"hello"}'), true)
    silent.deliver('not json')
    silent.deliver('42')
    silent.deliver({ type: 'claim' })
    expect(bridge.active()).toBeNull()
    expect(silent.sent).toEqual([])
  })
})

describe('mcp server: real WebSocket', () => {
  it('accepts a localhost origin, rejects others, and reports a busy port', async () => {
    const bridge = new B.Bridge({ port: 6815 })
    await bridge.start()
    cleanups.push(() => bridge.close())
    const open = (origin: string) => new Promise<string>((resolve) => {
      const ws = new WebSocket('ws://127.0.0.1:6815', { origin })
      ws.on('open', () => { ws.send(JSON.stringify({ type: 'hello', protocol: 1, url: 'test' })) })
      ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.type === 'active') { ws.close(); resolve('active') } })
      ws.on('unexpected-response', (_req, res) => resolve(`http ${res.statusCode}`))
      ws.on('error', () => resolve('error'))
    })
    expect(await open('http://localhost:5711')).toBe('active')
    expect(await open('http://evil.example')).toBe('http 403')
    const second = new B.Bridge({ port: 6815 })
    await expect(second.start()).rejects.toMatchObject({ code: 'busy-port', message: expect.stringMatching(/already in use/) })
    await expect(second.request('status')).rejects.toMatchObject({ code: 'busy-port' })
  })
})

describe('mcp server: CLI and helpers', () => {
  it('parses options', () => {
    expect(S.parseArgs([], {})).toMatchObject({ port: 6173, appPort: 5173, appUrl: 'http://localhost:5173/', serve: false, headless: false, open: false })
    expect(S.parseArgs(['--port', '6811', '--serve', '--headless', '--app-port=5712'], {})).toMatchObject({ port: 6811, serve: true, headless: true, appPort: 5712, appUrl: 'http://localhost:5712/', strictAppPort: true })
    expect(S.parseArgs([], { THREEDICA_MCP_PORT: '6900' }).port).toBe(6900)
    expect(S.parseArgs(['--port', '6812'], { THREEDICA_MCP_PORT: '6900' }).port).toBe(6812)
    expect(S.parseArgs(['--app-url', 'http://127.0.0.1:4000']).appUrl).toBe('http://127.0.0.1:4000/')
    expect(() => S.parseArgs(['--port'], {})).toThrow(/needs a value/)
    expect(() => S.parseArgs(['--port', 'x'], {})).toThrow(/port number/)
    expect(() => S.parseArgs(['--nope'], {})).toThrow(/Unknown option/)
    expect(() => S.parseArgs(['--open', '--headless'], {})).toThrow(/not both/)
  })

  it('builds the connect URL', () => {
    expect(L.connectUrl('http://localhost:5173/', 6173)).toBe('http://localhost:5173/?mcp')
    expect(L.connectUrl('http://localhost:5712/', 6811)).toBe('http://localhost:5712/?mcp&mcpPort=6811')
  })

  it('resolves file paths against the working directory and ~', () => {
    expect(T.resolveUserPath('out/a.stl', '/work', '/profile')).toBe(path.resolve('/work', 'out/a.stl'))
    expect(T.resolveUserPath('~/a.stl', '/work', '/profile')).toBe(path.join('/profile', 'a.stl'))
    expect(T.resolveUserPath('/abs/a.stl', '/work', '/profile')).toBe(path.resolve('/abs/a.stl'))
    expect(() => T.resolveUserPath('  ', '/work')).toThrow(/file path/)
  })

  it('the cheat sheet lists exactly the engine\'s in-scope names', () => {
    expect(D.flatNames()).toEqual([...FLAT_NAMES])
    const sheet: string = D.codeApiCheatSheet()
    expect(sheet).toContain(`${FLAT_NAMES.length} functions by plain name`)
    for (const n of ['cuboid', 'extrudeLinear', 'degToRad', 'measureBoundingBox']) expect(sheet).toContain(n)
    expect(D.INSTRUCTIONS).toMatch(/millimetres/)
    expect(D.INSTRUCTIONS).toMatch(/Z is up/)
    expect(D.INSTRUCTIONS).toMatch(/screenshot/)
  })
})

describe('mcp server: tools over MCP (fake bridge)', () => {
  async function connect(answers: Record<string, (params: Record<string, unknown>) => unknown>) {
    const calls: { method: string; params: unknown }[] = []
    const bridge = {
      info: () => ({ bridge: 'ws://127.0.0.1:6173', tabs: 1, activeTab: null }),
      connectHint: () => 'No 3Dica tab is connected.',
      async request(method: string, params: Record<string, unknown>) {
        calls.push({ method, params })
        const a = answers[method]
        if (!a) throw new B.BridgeError('No 3Dica tab is connected.', 'no-tab')
        return a(params)
      },
    }
    const server = S.createMcpServer(bridge, { cwd: os.tmpdir() })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(ct)
    cleanups.push(async () => { await client.close(); await server.close() })
    return { client, calls }
  }

  it('lists every tool with a description and input schema, and gives instructions', async () => {
    const { client } = await connect({})
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(T.TOOL_NAMES)
    for (const t of tools) {
      expect(t.description!.length, t.name).toBeGreaterThan(40)
      expect(t.inputSchema.type).toBe('object')
    }
    expect(client.getInstructions()).toMatch(/Recommended loop/)
    const res = await client.readResource({ uri: 'threedica://docs/code-api' })
    expect((res.contents[0] as { text: string }).text).toContain('part(name, overrides?)')
  })

  it('screenshot returns MCP image content plus the text', async () => {
    const { client, calls } = await connect({ screenshot: () => ({ image: 'iVBORw0KGgo=', mimeType: 'image/png', text: 'Shows the whole scene.' }) })
    const r = await client.callTool({ name: 'screenshot', arguments: { view: 'multi', width: 640 } })
    expect(r.isError).toBeFalsy()
    expect(r.content).toEqual([{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }, { type: 'text', text: 'Shows the whole scene.' }])
    expect(calls[0]).toEqual({ method: 'screenshot', params: { view: 'multi', width: 640 } })
    const bad = await client.callTool({ name: 'screenshot', arguments: { width: 4096 } })
    expect(bad.isError).toBe(true)
  })

  it('status works without a tab; other tools return readable errors', async () => {
    const { client } = await connect({})
    const s = await client.callTool({ name: 'status', arguments: {} })
    const st = JSON.parse((s.content as { text: string }[])[0].text)
    expect(st).toMatchObject({ connected: false, hint: 'No 3Dica tab is connected.' })
    const g = await client.callTool({ name: 'get_scene', arguments: {} })
    expect(g.isError).toBe(true)
    expect((g.content as { text: string }[])[0].text).toBe('Error: No 3Dica tab is connected.')
  })

  it('save_project and export_stl write files on the server side; load_project reads one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '3dica-mcp-'))
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
    const stl = Buffer.alloc(84 + 50 * 2)
    stl.writeUInt32LE(2, 80)
    const { client, calls } = await connect({
      save_project: () => ({ name: 'Kit', text: '{"format":"3dica"}\n' }),
      export_stl: () => ({ base64: stl.toString('base64'), triangles: 2, label: 'scene', skipped: [] }),
      load_project: (p) => ({ ok: true, project: 'Kit', got: p.text, fileName: p.fileName }),
    })
    const out = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content)[0].text)
    const saved = out(await client.callTool({ name: 'save_project', arguments: { path: path.join(dir, 'kit.3dica.json') } }))
    expect(saved).toMatchObject({ ok: true, project: 'Kit', overwritten: false })
    expect(fs.readFileSync(path.join(dir, 'kit.3dica.json'), 'utf8')).toBe('{"format":"3dica"}\n')
    const again = out(await client.callTool({ name: 'save_project', arguments: { path: path.join(dir, 'kit.3dica.json') } }))
    expect(again.overwritten).toBe(true)
    const ex = out(await client.callTool({ name: 'export_stl', arguments: { path: path.join(dir, 'scene.stl') } }))
    expect(ex).toMatchObject({ ok: true, bytes: 184, triangles: 2 })
    expect(fs.statSync(path.join(dir, 'scene.stl')).size).toBe(84 + 50 * 2)
    const loaded = out(await client.callTool({ name: 'load_project', arguments: { path: path.join(dir, 'kit.3dica.json') } }))
    expect(loaded).toMatchObject({ ok: true, got: '{"format":"3dica"}\n', fileName: 'kit.3dica.json' })
    const missing = await client.callTool({ name: 'load_project', arguments: { path: path.join(dir, 'nope.json') } })
    expect(missing.isError).toBe(true)
    const noDir = await client.callTool({ name: 'save_project', arguments: { path: path.join(dir, 'no', 'such', 'x.json') } })
    expect((noDir.content as { text: string }[])[0].text).toMatch(/does not exist/)
    expect(calls.map((c) => c.method)).toEqual(['save_project', 'save_project', 'export_stl', 'load_project', 'save_project'])
  })
})
