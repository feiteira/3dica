// MCP end to end: spawn `node mcp/server.mjs --port <free port>` with the SDK client over stdio, open the app with
// ?fresh&mcp&mcpPort=<port>, and drive and see it through the tools. Every test fails on page errors (pageerror or
// console.error; the "GPU stall due to ReadPixels" warning is ignored), like the other e2e files.
//
// MCP_DOC_SHOTS=1 also writes the manual's images docs/public/shots/mcp-multiview.png and mcp-status.png:
//   MCP_DOC_SHOTS=1 PW_PORT=<port> npx playwright test tests/e2e/mcp.spec.ts
import { test, expect, type Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SHOTS = path.join(ROOT, 'docs/public/shots')
const BG = [0x1f, 0x23, 0x29]

let errors: string[] = []

test.beforeEach(async ({ page }) => {
  errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('GPU stall due to ReadPixels')) errors.push(`console.error: ${m.text()}`)
  })
})

test.afterEach(() => {
  expect(errors, 'page errors').toEqual([])
})

const isFree = (p: number) => new Promise<boolean>((resolve) => {
  const s = net.createServer()
  s.once('error', () => resolve(false))
  s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)))
})

/** A free port in the MCP test range 6811–6819 (never the default 6173, which a real MCP server may be using). */
async function freePort(): Promise<number> {
  for (let p = 6811; p <= 6819; p++) if (await isFree(p)) return p
  throw new Error('no free port in 6811–6819')
}

async function startServer(port?: number): Promise<{ client: Client; port: number; log: string[] }> {
  port ??= await freePort()
  const transport = new StdioClientTransport({ command: process.execPath, args: ['mcp/server.mjs', '--port', String(port)], cwd: ROOT, stderr: 'pipe' })
  const log: string[] = []
  transport.stderr?.on('data', (d: Buffer) => log.push(String(d)))
  const client = new Client({ name: '3dica-e2e', version: '0' })
  await client.connect(transport)
  return { client, port, log }
}

async function boot(page: Page, query: string): Promise<void> {
  await page.goto('/' + query)
  await page.waitForFunction(() => (window as any).__3dica?.ready === true)
  await page.evaluate(() => (window as any).__3dica.idle())
}

type ToolResult = { content: any[]; isError?: boolean }
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult
const json = (r: ToolResult) => JSON.parse(r.content[0].text)

function pngSize(b64: string): { width: number; height: number } {
  const b = Buffer.from(b64, 'base64')
  expect(b.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect(b.subarray(12, 16).toString('ascii')).toBe('IHDR')
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

/** Fraction of pixels of a PNG (decoded in the page) that differ from the view background by more than 12. */
const objectFraction = (page: Page, b64: string) => page.evaluate(async ({ b64, bg }) => {
  const img = new Image()
  img.src = 'data:image/png;base64,' + b64
  await img.decode()
  const c = document.createElement('canvas')
  c.width = img.width; c.height = img.height
  const g = c.getContext('2d')!
  g.drawImage(img, 0, 0)
  const px = g.getImageData(0, 0, c.width, c.height).data
  let n = 0
  for (let i = 0; i < px.length; i += 4) if (Math.abs(px[i] - bg[0]) > 12 || Math.abs(px[i + 1] - bg[1]) > 12 || Math.abs(px[i + 2] - bg[2]) > 12) n++
  return n / (c.width * c.height)
}, { b64, bg: BG })

test('MCP: status, edit, see, fail, undo, export — through a real server and tab', async ({ page }) => {
  const { client, port } = await startServer()
  try {
    await boot(page, `?fresh&mcp&mcpPort=${port}`)
    await expect(page.getByTestId('mcp-pill')).toHaveText('MCP · connected')

    const status = json(await call(client, 'status'))
    expect(status.connected).toBe(true)
    expect(status.app).toMatchObject({ project: 'Bracket kit', evalPaused: false, errors: 0 })

    const defs = json(await call(client, 'list_definitions')).definitions
    expect(defs.map((d: any) => d.name)).toContain('Bolt')

    const created = json(await call(client, 'create_object', {
      kind: 'code', name: 'Block', code: 'return cuboid({ size: [20, 10, 6], center: [0, 0, 3] })', transform: { t: [0, 70, 0] },
    }))
    expect(created).toMatchObject({ ok: true, definition: 'Block', evaluation: 'done', errors: [] })
    expect(created.objects[0]).toMatchObject({ status: 'ok', size: [20, 10, 6] })
    expect(await page.evaluate(() => (window as any).__3dica.history().past)).toEqual(['MCP: Add Block'])

    // the screenshot: a valid PNG of the requested size, mostly model, plus a text block
    const shot = await call(client, 'screenshot', { view: 'multi', width: 640, height: 480 })
    expect(shot.isError).toBeFalsy()
    const [image, text] = shot.content
    expect(image).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect(pngSize(image.data)).toEqual({ width: 640, height: 480 })
    expect(await objectFraction(page, image.data)).toBeGreaterThan(0.05)
    expect(text.type).toBe('text')
    expect(text.text).toMatch(/view multi/)
    expect(text.text).toMatch(/Framed box: [\d.]+ × [\d.]+ × [\d.]+ mm/)
    // it did not disturb the user's view state
    expect(await page.evaluate(() => (window as any).__3dica.ui().selection)).toEqual({ kind: 'none' })

    // a throwing edit reports the error and its line at once
    const bad = json(await call(client, 'update_definition', { name: 'Block', code: 'const a = 1\nthrow new Error("boom: thread pitch too small")' }))
    expect(bad.objects[0]).toMatchObject({ definition: 'Block', status: 'error', error: { kind: 'runtime', line: 2 } })
    expect(bad.objects[0].error.message).toContain('boom: thread pitch too small')
    expect(await page.evaluate(() => (window as any).__3dica.defError('Block')?.line)).toBe(2)

    const undone = json(await call(client, 'undo'))
    expect(undone.undone).toEqual(['MCP: Edit Block'])
    expect(undone.errors).toEqual([])
    expect(await page.evaluate(() => (window as any).__3dica.defStatus('Block'))).toBe('ok')

    // STL written by the server: 84 + 50 · triangles bytes
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '3dica-e2e-'))
    try {
      const file = path.join(dir, 'block.stl')
      const ex = json(await call(client, 'export_stl', { path: file, target: 'Block' }))
      expect(ex).toMatchObject({ ok: true, triangles: 12 })
      expect(fs.statSync(file).size).toBe(84 + 50 * ex.triangles)
      const scene = json(await call(client, 'export_stl', { path: path.join(dir, 'scene.stl') }))
      expect(fs.statSync(path.join(dir, 'scene.stl')).size).toBe(84 + 50 * scene.triangles)
      expect(scene.triangles).toBeGreaterThan(1000)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  } finally {
    await client.close()
  }
})

test('MCP: an as-seen screenshot has the same colours as the on-screen view', async ({ page }) => {
  const { client, port } = await startServer()
  try {
    await boot(page, `?fresh&mcp&mcpPort=${port}`)
    await expect(page.getByTestId('mcp-pill')).toHaveText('MCP · connected')
    const size = await page.evaluate(() => { const c = document.querySelector('[data-testid="viewport-canvas"]') as HTMLCanvasElement; return { width: c.width, height: c.height } })
    const before = await page.evaluate(() => (window as any).__3dica.view())
    const shot = await call(client, 'screenshot', { view: 'current', style: 'as-seen', ...size })
    const b64 = shot.content[0].data
    expect(pngSize(b64)).toEqual(size)
    const diff = await page.evaluate(async (b64) => {
      const canvas = document.querySelector('[data-testid="viewport-canvas"]') as HTMLCanvasElement
      const read = (src: CanvasImageSource) => {
        const c = document.createElement('canvas')
        c.width = canvas.width; c.height = canvas.height
        const g = c.getContext('2d')!
        g.drawImage(src, 0, 0)
        return g.getImageData(0, 0, c.width, c.height).data
      }
      const img = new Image()
      img.src = 'data:image/png;base64,' + b64
      await img.decode()
      const a = read(img), b = read(canvas)
      let sum = 0, big = 0
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]))
        sum += d
        if (d > 24) big++
      }
      return { mean: sum / (a.length / 4), big: big / (a.length / 4) }
    }, b64)
    expect(diff.mean).toBeLessThan(1.5)
    expect(diff.big).toBeLessThan(0.01)
    // the user's camera did not move (OrbitControls re-derives the pose every frame: float noise only)
    const after = await page.evaluate(() => (window as any).__3dica.view())
    expect(after.gizmoAttached).toBe(before.gizmoAttached)
    for (const k of ['minX', 'maxX', 'minY', 'maxY']) expect(after.ndc[k], k).toBeCloseTo(before.ndc[k], 6)
  } finally {
    await client.close()
  }
})

test('MCP: two tabs — the newest is active, the older can take over; the pill disables and forgets', async ({ page }) => {
  const { client, port } = await startServer()
  try {
    await boot(page, `?fresh&mcp&mcpPort=${port}`)
    await expect(page.getByTestId('mcp-pill')).toHaveText('MCP · connected')
    const second = await page.context().newPage()
    second.on('pageerror', (e) => errors.push(`second pageerror: ${e.message}`))
    await second.goto(`/?fresh&mcp&mcpPort=${port}`)
    await second.waitForFunction(() => (window as any).__3dica?.ready === true)
    await expect(second.getByTestId('mcp-pill')).toHaveText('MCP · connected')
    await expect(page.getByTestId('mcp-pill')).toHaveText('MCP · superseded')
    // requests go to the newest tab
    json(await call(client, 'new_project', { name: 'Second tab' }))
    expect(await second.evaluate(() => (window as any).__3dica.project().name)).toBe('Second tab')
    expect(await page.evaluate(() => (window as any).__3dica.project().name)).toBe('Bracket kit')
    // the first tab takes over from its pill menu
    await page.getByTestId('mcp-pill').click()
    await expect(page.getByTestId('mcp-menu')).toBeVisible()
    await page.getByTestId('mcp-claim').click()
    await expect(page.getByTestId('mcp-pill')).toHaveText('MCP · connected')
    await expect(second.getByTestId('mcp-pill')).toHaveText('MCP · superseded')
    expect(json(await call(client, 'status')).app.project).toBe('Bracket kit')
    await second.close()
    // disable: the pill goes away, the opt-in is forgotten, the server sees no tab
    await page.getByTestId('mcp-pill').click()
    await page.getByTestId('mcp-disable').click()
    await expect(page.getByTestId('mcp-pill')).toBeHidden()
    expect(await page.evaluate(() => localStorage.getItem('3dica:v1:mcp'))).toBeNull()
    await expect.poll(async () => json(await call(client, 'status')).server.tabs).toBe(0)
  } finally {
    await client.close()
  }
})

test('MCP: works in a tab that gets no animation frames (a background tab)', async ({ page }) => {
  const { client, port } = await startServer()
  try {
    // a hidden tab gets no requestAnimationFrame callbacks: the bridge must not depend on them
    await page.addInitScript(() => { window.requestAnimationFrame = () => 0 })
    await page.goto(`/?fresh&mcp&mcpPort=${port}`)
    await page.waitForFunction(() => (window as any).__3dica?.ready === true)
    expect(json(await call(client, 'status')).connected).toBe(true)
    const r = json(await call(client, 'create_object', { kind: 'sphere', transform: { t: [0, 70, 0] } }))
    expect(r).toMatchObject({ evaluation: 'done', objects: [{ status: 'ok' }] })
    const shot = await call(client, 'screenshot', { view: 'top', width: 320, height: 240 })
    expect(pngSize(shot.content[0].data)).toEqual({ width: 320, height: 240 })
    expect(await objectFraction(page, shot.content[0].data)).toBeGreaterThan(0.05)
  } finally {
    await client.close()
  }
})

test('without ?mcp the page never tries a WebSocket to the bridge and shows no pill', async ({ page }) => {
  const sockets: string[] = []
  page.on('websocket', (ws) => sockets.push(ws.url()))
  await boot(page, '?fresh')
  await page.waitForTimeout(1500)
  const appOrigin = new URL(page.url()).host
  expect(sockets.filter((u) => !u.includes(appOrigin)), 'WebSockets other than the Vite dev client').toEqual([])
  await expect(page.getByTestId('mcp-pill')).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('3dica:v1:mcp'))).toBeNull()
})

test('MCP doc shots (only with MCP_DOC_SHOTS=1)', async ({ page }) => {
  test.skip(process.env.MCP_DOC_SHOTS !== '1', 'set MCP_DOC_SHOTS=1 to regenerate docs/public/shots/mcp-*.png')
  // the manual shows the default port, so use 6173 when no real MCP server holds it
  const { client, port } = await startServer((await isFree(6173)) ? 6173 : undefined)
  try {
    await boot(page, `?fresh&mcp&mcpPort=${port}`)
    await expect(page.getByTestId('mcp-pill')).toHaveText('MCP · connected')
    fs.mkdirSync(SHOTS, { recursive: true })
    const shot = await call(client, 'screenshot', { view: 'multi', width: 1200, height: 800 })
    fs.writeFileSync(path.join(SHOTS, 'mcp-multiview.png'), Buffer.from(shot.content[0].data, 'base64'))
    // the pill and its menu, after one assistant change so the menu shows "Last change"
    await call(client, 'update_instance', { path: ['i_fx1', 'i_b1'], params: { length: 16 } })
    await page.getByTestId('mcp-pill').click()
    await expect(page.getByTestId('mcp-menu')).toBeVisible()
    const pill = (await page.getByTestId('mcp-pill').boundingBox())!
    const menu = (await page.getByTestId('mcp-menu').boundingBox())!
    const x = Math.floor(Math.min(menu.x, pill.x) - 220), y = Math.floor(menu.y - 12)
    await page.screenshot({
      path: path.join(SHOTS, 'mcp-status.png'),
      clip: { x, y, width: Math.ceil(Math.max(menu.x + menu.width, pill.x + pill.width) + 12 - x), height: Math.ceil(pill.y + pill.height + 4 - y) },
    })
  } finally {
    await client.close()
  }
})
