// §9.3 end-to-end scenarios (Playwright's Chromium). Each test boots /?fresh, waits for __3dica.ready and idle(),
// and fails if the page logged any error (pageerror or console.error; the "GPU stall due to ReadPixels" warning is ignored).
import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'

// window.__3dica (§9.1) — typed loosely: the e2e files are not type-checked (§8.3)
type Api = {
  ready: boolean
  idle(): Promise<void>
  project(): any
  ui(): any
  stats(): { occurrences: number; meshes: number; geometries: number; triangles: number; pending: number; failed: number }
  occurrencesOf(name: string): number
  defStatus(name: string): 'idle' | 'pending' | 'ok' | 'error'
  defError(name: string): any
  objectPixels(): number
  gizmoAxisScreen(axis: 'X' | 'Y' | 'Z', along: number): { x: number; y: number }
  history(): { past: string[]; future: string[] }
}

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

async function boot(page: Page, query = '?fresh'): Promise<void> {
  await page.goto('/' + query)
  await page.waitForFunction(() => (window as any).__3dica?.ready === true)
  await idle(page)
}
const idle = (page: Page) => page.evaluate(() => (window as any).__3dica.idle() as Promise<void>)
const stats = (page: Page) => page.evaluate(() => (window as any).__3dica.stats() as ReturnType<Api['stats']>)
const occurrencesOf = (page: Page, name: string) => page.evaluate((n) => (window as any).__3dica.occurrencesOf(n) as number, name)
const defStatus = (page: Page, name: string) => page.evaluate((n) => (window as any).__3dica.defStatus(n) as string, name)
const defError = (page: Page, name: string) => page.evaluate((n) => (window as any).__3dica.defError(n), name)
const objectPixels = (page: Page) => page.evaluate(() => (window as any).__3dica.objectPixels() as number)
const ui = (page: Page) => page.evaluate(() => (window as any).__3dica.ui())
const project = (page: Page) => page.evaluate(() => (window as any).__3dica.project())
const row = (page: Page, path: string) => page.locator(`[data-testid="tree-row"][data-path="${path}"]`)
const libRow = (page: Page, name: string) =>
  page.locator('[data-testid="lib-row"]').filter({ has: page.locator('.lib-name', { hasText: new RegExp(`^${name}$`) }) })

/** Replace the whole code editor document with `text` (as a user would: select all, then type). */
async function setEditorCode(page: Page, text: string): Promise<void> {
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(text)
}

const rootChild = (p: any, id: string) => p.defs[p.root].children.find((c: any) => c.id === id)

test('1. boot renders the sample', async ({ page }) => {
  await boot(page)
  for (const p of ['i_fx1', 'i_fx2', 'i_bs']) await expect(row(page, p)).toHaveCount(1)
  for (const name of ['Bolt', 'Plate', 'Washer', 'Disc', 'Hole', 'Fixture', 'Bolt sizes']) await expect(libRow(page, name)).toHaveCount(1)
  expect(await objectPixels(page)).toBeGreaterThan(5000)
  for (const name of ['Bolt', 'Plate', 'Washer', 'Bolt sizes']) expect(await defStatus(page, name), name).toBe('ok')
  for (const name of ['Disc', 'Hole', 'Fixture']) expect(await defStatus(page, name), name).toBe('idle')
  const all = await page.evaluate(() => Object.values((window as any).__3dica.project().defs).map((d: any) => d.name))
  for (const name of all) {
    if (name === 'Scene') continue
    expect(['error', 'pending'], name).not.toContain(await defStatus(page, name))
  }
  expect((await stats(page)).geometries).toBe(4)
})

test('2. click selects and isolates', async ({ page }) => {
  await boot(page)
  await row(page, 'i_fx1/i_plate').click()
  expect((await ui(page)).selection).toEqual({ kind: 'occ', path: ['i_fx1', 'i_plate'] })
  await expect(page.getByTestId('inspector-title')).toContainText('Plate')
  await expect(page.locator('.cm-content')).toContainText('roundedCuboid')

  await page.keyboard.press('i')
  expect((await ui(page)).viewMode).toBe('isolate')
  await idle(page)
  expect(await objectPixels(page)).toBeGreaterThan(2000)

  await page.keyboard.press('Escape')
  expect((await ui(page)).viewMode).toBe('context')

  await libRow(page, 'Bolt').click()
  expect((await ui(page)).viewMode).toBe('isolate')
  await expect(page.locator('.cm-content')).toContainText('extrudeLinear')
})

test('3. linked instance, unique duplicate, copy and paste', async ({ page }) => {
  await boot(page)
  await row(page, 'i_fx1').click()
  await page.keyboard.press('Control+D')
  await idle(page)
  expect(await occurrencesOf(page, 'Fixture')).toBe(3)
  expect(await occurrencesOf(page, 'Bolt')).toBe(12)
  expect((await stats(page)).geometries).toBe(4)

  await page.keyboard.press('Control+Shift+D')
  await idle(page)
  await expect(libRow(page, 'Fixture 2')).toHaveCount(1)
  expect(await occurrencesOf(page, 'Bolt')).toBe(16)

  await row(page, 'i_bs').click()
  await page.keyboard.press('Control+C')
  await page.keyboard.press('Control+V')
  await idle(page)
  expect(await occurrencesOf(page, 'Bolt sizes')).toBe(2)

  await page.keyboard.press('Control+Z')
  await idle(page)
  expect(await occurrencesOf(page, 'Bolt sizes')).toBe(1)
})

test('4. editing code updates linked copies, and errors keep the mesh', async ({ page }) => {
  await boot(page)
  await row(page, 'i_fx1/i_b1').click()
  await idle(page)
  const tris0 = (await stats(page)).triangles
  const boltCode: string = (await project(page)).defs.d_bolt.code
  expect(boltCode).toContain('segments: 6')

  await setEditorCode(page, boltCode.replace('segments: 6', 'segments: 8'))
  await idle(page)
  expect((await project(page)).defs.d_bolt.code).toContain('segments: 8')
  expect((await stats(page)).triangles).not.toBe(tris0)

  await setEditorCode(page, 'throw new Error("boom")')
  await expect.poll(async () => { await idle(page); return defStatus(page, 'Bolt') }).toBe('error')
  expect((await defError(page, 'Bolt')).line).toBe(1)
  await expect(page.locator('[data-testid="tree-row"][data-def="d_bolt"][data-status="error"]').first()).toBeAttached()
  await expect(page.locator('.cm-lint-marker-error, .cm-diagnostic').first()).toBeVisible()
  expect(await objectPixels(page)).toBeGreaterThan(5000) // the last good mesh is still shown
  expect(await defStatus(page, 'Bolt sizes')).toBe('error') // as a dependency

  // undo with the focus outside the editor (inside it, Ctrl+Z belongs to CodeMirror)
  await row(page, 'i_fx1/i_b1').click()
  await expect(page.locator('.cm-editor.cm-focused')).toHaveCount(0)
  await page.keyboard.press('Control+Z')
  await expect.poll(async () => { await idle(page); return defStatus(page, 'Bolt') }).toBe('ok')
})

test('5. a gizmo drag is one undo step', async ({ page }) => {
  await boot(page)
  await row(page, 'i_bs').click()
  await page.keyboard.press('w')
  await idle(page)
  const tx = async () => rootChild(await project(page), 'i_bs').xf.t[0] as number
  expect(await tx()).toBe(-24)

  let moved = false
  for (let d = 4; d <= 12 && !moved; d++) {
    const p = await page.evaluate((along) => (window as any).__3dica.gizmoAxisScreen('X', along), d)
    await page.mouse.move(p.x, p.y)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) await page.mouse.move(p.x + 8 * i, p.y)
    await page.mouse.up()
    await idle(page)
    moved = (await tx()) !== -24
  }
  expect(moved).toBe(true)
  const t0 = await tx()
  expect(Number.isInteger(t0), `snapped x ${t0}`).toBe(true)
  const past: string[] = (await page.evaluate(() => (window as any).__3dica.history())).past
  expect(past.at(-1)).toMatch(/^Move/)

  await page.keyboard.press('Control+Z')
  await idle(page)
  expect(await tx()).toBe(-24)
})

test('6. a runaway loop is contained', async ({ page }) => {
  await boot(page, '?fresh&evalTimeout=1500')
  await page.getByTestId('add-code').click()
  await idle(page)
  await setEditorCode(page, 'while (true) {}')
  await expect.poll(async () => (await defError(page, 'Object'))?.kind, { timeout: 6000 }).toBe('timeout')

  await row(page, 'i_bs').click()
  await page.getByTestId('param-count').fill('3')
  await page.getByTestId('param-count').press('Enter')
  await idle(page)
  expect(await defStatus(page, 'Bolt sizes')).toBe('ok')
  expect(rootChild(await project(page), 'i_bs').params.count).toBe(3)
})

test('7. STL export', async ({ page }) => {
  await boot(page)
  await page.keyboard.press('Escape')
  expect((await ui(page)).selection).toEqual({ kind: 'none' })
  const dl = page.waitForEvent('download')
  await page.getByTestId('export-stl').click()
  const download = await dl
  expect(download.suggestedFilename()).toMatch(/\.stl$/)
  const buf = fs.readFileSync(await download.path())
  const n = buf.readUInt32LE(80)
  expect(buf.length).toBe(84 + 50 * n)
  expect(n).toBeGreaterThan(10000)
})

test('8. autosave restore', async ({ page }) => {
  await boot(page)
  await row(page, 'i_bs').click()
  await page.keyboard.press('F2')
  const input = page.getByTestId('rename-input')
  await expect(input).toBeVisible()
  await input.fill('Rack')
  await input.press('Enter')
  await expect(libRow(page, 'Rack')).toHaveCount(1)

  await page.waitForTimeout(1500)
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__3dica?.ready === true)
  await idle(page)
  await expect(libRow(page, 'Rack')).toHaveCount(1)
  await expect(libRow(page, 'Bolt sizes')).toHaveCount(0)
})
