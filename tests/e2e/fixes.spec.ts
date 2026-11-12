// Regression scenarios for the v0.1 review fixes (Playwright's Chromium). Same conventions as app.spec.ts: boot
// /?fresh, wait for __3dica.ready and idle(), and fail on any pageerror / console.error.
import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'

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
const api = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as any).__3dica[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>
const ui = (page: Page) => api<any>(page, 'ui')
const project = (page: Page) => api<any>(page, 'project')
const stats = (page: Page) => api<{ meshes: number }>(page, 'stats')
const view = (page: Page) => api<{ gizmoAttached: string | null; dragging: boolean; ndc: { minX: number; maxX: number; minY: number; maxY: number } | null }>(page, 'view')
const gizmoAt = (page: Page, axis: 'X' | 'Y' | 'Z', along: number) => api<{ x: number; y: number }>(page, 'gizmoAxisScreen', axis, along)
const row = (page: Page, path: string) => page.locator(`[data-testid="tree-row"][data-path="${path}"]`)
const libRow = (page: Page, name: string) =>
  page.locator('[data-testid="lib-row"]').filter({ has: page.locator('.lib-name', { hasText: new RegExp(`^${name}$`) }) })
const toasts = (page: Page) => page.locator('[data-testid="toast"]')
const rootChild = (p: any, id: string) => p.defs[p.root].children.find((c: any) => c.id === id)

async function setEditorCode(page: Page, text: string): Promise<void> {
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(text)
}

test("'Open without running' is remembered across a reload: the code still waits for Run code", async ({ page }, info) => {
  const file = info.outputPath('untrusted.3dica.json')
  fs.mkdirSync(info.outputDir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify({
    format: '3dica', version: 1, name: 'Untrusted', root: 'd_root',
    defs: {
      d_root: { id: 'd_root', name: 'Scene', kind: 'group', op: 'none', children: [{ id: 'i_x', def: 'd_x', xf: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] } }] },
      d_x: { id: 'd_x', name: 'Payload', kind: 'code', params: [], code: "console.log('UNTRUSTED CODE RAN')\nreturn cuboid({ size: [10, 10, 10] })" },
    },
  }))
  let ran = 0
  page.context().on('console', (m) => { if (m.text().includes('UNTRUSTED CODE RAN')) ran++ })
  page.on('console', (m) => { if (m.text().includes('UNTRUSTED CODE RAN')) ran++ })
  await boot(page)
  page.once('filechooser', (fc) => fc.setFiles(file))
  await page.getByTestId('open').click()
  await page.getByTestId('confirm-cancel').click() // "Open without running"
  await expect(page.getByTestId('run-code')).toBeVisible()
  await page.waitForTimeout(1500) // autosave: 1 s after the change

  await page.goto('/') // reload, restoring the autosave
  await page.waitForFunction(() => (window as any).__3dica?.ready === true)
  await idle(page)
  expect((await project(page)).name).toBe('Untrusted')
  await expect(page.getByTestId('run-code')).toBeVisible()
  expect((await stats(page)).meshes).toBe(0)
  await page.waitForTimeout(300)
  expect(ran).toBe(0)

  // an explicit Run code runs it, and from then on the project is trusted (also after the next reload)
  await page.getByTestId('run-code').click()
  await idle(page)
  expect((await stats(page)).meshes).toBe(1)
  await page.waitForTimeout(1500)
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__3dica?.ready === true)
  await idle(page)
  await expect(page.getByTestId('run-code')).toBeHidden()
  expect((await stats(page)).meshes).toBe(1)
})

test('a tab that died while evaluating reopens with its code paused (no crash loop)', async ({ page }) => {
  await boot(page)
  const p = await project(page)
  // what the dead tab left behind: its autosave and the "evaluating" marker (written once, on the next load only)
  await page.addInitScript((proj) => {
    if (sessionStorage.getItem('crash-sim')) return
    sessionStorage.setItem('crash-sim', '1')
    localStorage.setItem('3dica:v1:current', JSON.stringify({ savedAt: new Date().toISOString(), project: proj }))
    localStorage.setItem('3dica:v1:evaluating', JSON.stringify({ defName: 'Bolt sizes', at: new Date().toISOString() }))
  }, p)
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__3dica?.ready === true)
  await idle(page)
  await expect(page.getByTestId('run-code')).toBeVisible()
  expect((await stats(page)).meshes).toBe(0)
  await expect(toasts(page).filter({ hasText: "stopped while evaluating 'Bolt sizes'" })).toHaveCount(1)
  // reopening again without Run code: still paused
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__3dica?.ready === true)
  await idle(page)
  await expect(page.getByTestId('run-code')).toBeVisible()
  await page.getByTestId('run-code').click()
  await idle(page)
  expect((await stats(page)).meshes).toBeGreaterThan(10)
})

test('code typed just before a reload is kept (pagehide flushes the editor debounce)', async ({ page }) => {
  await boot(page)
  await row(page, 'i_fx1/i_b1').click()
  const code: string = (await project(page)).defs.d_bolt.code
  await setEditorCode(page, code + '\n// typed right before F5')
  await page.goto('/') // at once: well inside the 400 ms debounce
  await page.waitForFunction(() => (window as any).__3dica?.ready === true)
  expect((await project(page)).defs.d_bolt.code).toContain('// typed right before F5')
})

test("the 'Nothing selected' panel follows New, Sample and Purge", async ({ page }) => {
  await boot(page)
  await expect(page.getByTestId('inspector-counts')).toHaveText('7 definitions · 37 objects in the scene')
  await page.getByTestId('new').click()
  await page.getByTestId('confirm-ok').click()
  await expect(page.getByTestId('inspector-project')).toHaveText('Untitled')
  await expect(page.getByTestId('inspector-counts')).toHaveText('0 definitions · 0 objects in the scene')
  await page.getByTestId('sample').click()
  await page.getByTestId('confirm-ok').click()
  await expect(page.getByTestId('inspector-project')).toHaveText('Bracket kit')
  await expect(page.getByTestId('inspector-counts')).toHaveText('7 definitions · 37 objects in the scene')
  // delete Bolt sizes' only instance, then purge it: 6 definitions
  await row(page, 'i_bs').click()
  await page.keyboard.press('Delete')
  await page.keyboard.press('Escape')
  await page.getByTestId('purge').click()
  await expect(page.getByTestId('inspector-counts')).toHaveText('6 definitions · 36 objects in the scene')
})

test('breadcrumb tooltips describe the click', async ({ page }) => {
  await boot(page)
  await row(page, 'i_fx1/i_w1').click()
  const crumb = page.getByTestId('crumb-1')
  await expect(crumb).toHaveAttribute('title', /^Enter 'Fixture A' and select 'Washer'/)
  await expect(page.getByTestId('crumb-2')).toHaveAttribute('title', "Select 'Washer'")
  await crumb.click()
  expect((await ui(page)).selection).toEqual({ kind: 'occ', path: ['i_fx1', 'i_w1'] })
  expect((await ui(page)).context).toEqual(['i_fx1'])
})

test('Ctrl+Z right after Enter in an inspector field undoes the edit (the field never shows a value the model does not have)', async ({ page }) => {
  await boot(page)
  await row(page, 'i_bs').click()
  const x = page.getByTestId('xf-t0')
  await x.fill('10')
  await x.press('Enter')
  await idle(page)
  expect(rootChild(await project(page), 'i_bs').xf.t[0]).toBe(10)
  await page.keyboard.press('Control+Z')
  await idle(page)
  expect(rootChild(await project(page), 'i_bs').xf.t[0]).toBe(-24)
  await expect(x).toHaveValue('-24')
  // a refused value keeps the focus so it can be fixed
  await page.getByTestId('xf-s0').fill('0')
  await page.getByTestId('xf-s0').press('Enter')
  expect(rootChild(await project(page), 'i_bs').xf.s[0]).toBe(1)
})

test("double-clicking a selected group enters it even when its gizmo is under the pointer", async ({ page }) => {
  await boot(page)
  await row(page, 'i_fx1').click()
  await idle(page)
  const o = await gizmoAt(page, 'X', 0)
  const P = { x: o.x + 4, y: o.y + 6 } // on the plate, on the gizmo's centre handle
  await page.mouse.move(P.x, P.y)
  await page.mouse.dblclick(P.x, P.y)
  await expect.poll(async () => (await ui(page)).context).toEqual(['i_fx1'])
})

test('when the isolated object disappears (undo), the view returns to the scene and stays pickable', async ({ page }) => {
  await boot(page)
  await row(page, 'i_bs').click()
  await page.keyboard.press('Control+D')
  await idle(page)
  await page.keyboard.press('i')
  await idle(page)
  expect((await ui(page)).viewMode).toBe('isolate')
  await page.keyboard.press('Control+Z') // undo the duplicate: the isolated copy is gone
  await idle(page)
  expect((await ui(page)).selection).toEqual({ kind: 'none' })
  expect((await ui(page)).viewMode).toBe('context')
  await expect(page.getByTestId('isolate-banner')).toBeHidden()
  await page.waitForTimeout(600) // the camera tweens back
  const origin = await gizmoAt(page, 'X', 0) // nothing attached: the world origin, the middle of Fixture A's plate
  await page.mouse.click(origin.x, origin.y)
  expect((await ui(page)).selection).toEqual({ kind: 'occ', path: ['i_fx1'] })
})

test('isolate re-frames once the real result replaces the stale last-good mesh', async ({ page }) => {
  await boot(page)
  // a project whose Bolt sizes instance shows 1 bolt, so the 5-bolt default result has never been evaluated
  const p = await project(page)
  rootChild(p, 'i_bs').params = { count: 1 }
  await page.addInitScript((proj) => {
    if (sessionStorage.getItem('seeded')) return
    sessionStorage.setItem('seeded', '1')
    localStorage.setItem('3dica:v1:current', JSON.stringify({ savedAt: new Date().toISOString(), project: proj }))
  }, p)
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__3dica?.ready === true)
  await idle(page)
  await row(page, 'i_bs').click()
  await page.keyboard.press('i')
  await idle(page)
  await page.waitForTimeout(500)
  await libRow(page, 'Bolt sizes').click() // defaults: 5 bolts, not evaluated yet → the 1-bolt mesh shows first
  await idle(page)
  await page.waitForTimeout(700)
  const v = await view(page)
  expect(v.ndc).not.toBeNull()
  for (const k of ['minX', 'minY'] as const) expect(v.ndc![k]).toBeGreaterThan(-1.05)
  for (const k of ['maxX', 'maxY'] as const) expect(v.ndc![k]).toBeLessThan(1.05)
})

test('undo during a gizmo drag: after the release the gizmo is back on the still-selected parent', async ({ page }) => {
  await boot(page)
  await row(page, 'i_fx1/i_b1').click()
  await page.keyboard.press('Control+D')
  await idle(page)
  await page.keyboard.press('w')
  await idle(page)
  let dragging = false
  for (let d = 4; d <= 14 && !dragging; d += 2) {
    const pt = await gizmoAt(page, 'X', d)
    await page.mouse.move(pt.x, pt.y)
    await page.mouse.down()
    await page.mouse.move(pt.x + 6, pt.y, { steps: 2 })
    dragging = (await view(page)).dragging
    if (!dragging) await page.mouse.up()
  }
  expect(dragging).toBe(true)
  await page.keyboard.press('Control+Z') // removes the dragged copy; the selection falls back to Fixture A
  await page.waitForTimeout(100)
  await page.mouse.move(600, 400, { steps: 3 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  expect((await ui(page)).selection).toEqual({ kind: 'occ', path: ['i_fx1'] })
  expect((await view(page)).gizmoAttached).toBe('i_fx1')
})

test('a second tab is detected and both tabs warn that they share the autosave', async ({ page }) => {
  await boot(page)
  const other = await page.context().newPage()
  await other.goto('/')
  await other.waitForFunction(() => (window as any).__3dica?.ready === true)
  await expect(other.locator('[data-testid="toast"]').filter({ hasText: 'also open in another tab' })).toHaveCount(1)
  await expect(toasts(page).filter({ hasText: 'also open in another tab' })).toHaveCount(1)
  await other.close()
})

test('STL export skips an object whose evaluation already timed out instead of blocking the evaluator', async ({ page }) => {
  await boot(page, '?fresh&evalTimeout=1500')
  await page.getByTestId('add-code').click()
  await idle(page)
  await setEditorCode(page, 'while (true) {}')
  await expect.poll(async () => (await api<any>(page, 'defError', 'Object'))?.kind, { timeout: 8000 }).toBe('timeout')
  await page.keyboard.press('Escape') // leave the editor
  await page.keyboard.press('Escape') // deselect
  expect((await ui(page)).selection).toEqual({ kind: 'none' })
  const dl = page.waitForEvent('download', { timeout: 20_000 })
  const t0 = Date.now()
  await page.getByTestId('export-stl').click()
  const download = await dl
  expect(Date.now() - t0).toBeLessThan(15_000) // was: 60 s STL timeout, then "STL export failed"
  const buf = fs.readFileSync(await download.path())
  expect(buf.length).toBe(84 + 50 * buf.readUInt32LE(80))
  await expect(toasts(page).filter({ hasText: 'Skipped because of errors: Object' })).toHaveCount(1)
  // the evaluator stayed free
  await row(page, 'i_bs').click()
  await page.getByTestId('param-count').fill('3')
  await page.getByTestId('param-count').press('Enter')
  await expect.poll(() => api<string>(page, 'defStatus', 'Bolt sizes'), { timeout: 8000 }).toBe('ok')
})
