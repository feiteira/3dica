// Shared helpers for the manual's screenshot generator (playwright.docs.config.ts). Every shot starts from a known state
// (/?fresh, or New for the empty-project tutorials), is reached through real UI input (clicks, keys, drags), and is
// taken only once the app has settled: evaluation idle, camera tween finished, toasts dismissed, pointer parked.
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SHOTS_DIR = fileURLToPath(new URL('../../docs/public/shots/', import.meta.url))

/** Fail the test on any page error (same rule as the e2e suite; the SwiftShader ReadPixels warning is ignored). */
export function failOnPageErrors(): void {
  let errors: string[] = []
  test.beforeEach(async ({ page }) => {
    errors = []
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('GPU stall due to ReadPixels')) errors.push(`console.error: ${m.text()}`)
    })
  })
  test.afterEach(() => { expect(errors, 'page errors').toEqual([]) })
}

// ───────────────────────────── test API (window.__3dica, read-only use) ─────────────────────────────

export const idle = (page: Page) => page.evaluate(() => (window as any).__3dica.idle() as Promise<void>)
export const ui = (page: Page) => page.evaluate(() => (window as any).__3dica.ui())
export const project = (page: Page) => page.evaluate(() => (window as any).__3dica.project())
export const defStatus = (page: Page, name: string) => page.evaluate((n) => (window as any).__3dica.defStatus(n) as string, name)
export const occurrencesOf = (page: Page, name: string) => page.evaluate((n) => (window as any).__3dica.occurrencesOf(n) as number, name)
export const gizmoAt = (page: Page, axis: 'X' | 'Y' | 'Z', along: number) =>
  page.evaluate(([a, d]) => (window as any).__3dica.gizmoAxisScreen(a, d) as { x: number; y: number }, [axis, along] as const)

export async function boot(page: Page, query = '?fresh'): Promise<void> {
  await page.goto('/' + query)
  await page.waitForFunction(() => (window as any).__3dica?.ready === true)
  await settle(page)
}

/** New → confirm: an empty "Untitled" project. */
export async function newProject(page: Page): Promise<void> {
  await page.getByTestId('new').click()
  await page.getByTestId('confirm-ok').click()
  await expect(page.getByTestId('inspector-project')).toHaveText('Untitled')
  await settle(page)
}

// ───────────────────────────── locators ─────────────────────────────

export const row = (page: Page, p: string) => page.locator(`[data-testid="tree-row"][data-path="${p}"]`)
/** A tree row by its shown label (instance label or definition name). */
export const rowNamed = (page: Page, label: string) =>
  page.locator('[data-testid="tree-row"]').filter({ has: page.locator('.row-name', { hasText: new RegExp(`^${escapeRe(label)}$`) }) })
export const libRow = (page: Page, name: string) =>
  page.locator('[data-testid="lib-row"]').filter({ has: page.locator('.lib-name', { hasText: new RegExp(`^${escapeRe(name)}$`) }) })
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ───────────────────────────── settling ─────────────────────────────

/** Somewhere without hover styles: the empty middle of the status bar. */
export async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(900, 890)
}

/** Click every visible toast away and wait until none is left. */
export async function dismissToasts(page: Page): Promise<void> {
  const toasts = page.locator('[data-testid="toast"]')
  for (let i = 0; i < 10; i++) {
    const live = page.locator('[data-testid="toast"]:not(.out)')
    const n = await live.count()
    if (n === 0) break
    await live.first().click({ timeout: 2000 }).catch(() => {})
  }
  await expect(toasts).toHaveCount(0, { timeout: 8000 })
}

/**
 * Wait until the camera stops moving (frame / view-preset tweens take 300 ms). The on-screen extent of the scene is
 * compared at 1e-4 (the orbit controls update every frame and drift in the last digits).
 */
export async function cameraStill(page: Page): Promise<void> {
  let last = ''
  let same = 0
  for (let i = 0; i < 60 && same < 2; i++) {
    await page.waitForTimeout(80)
    const v = await page.evaluate(() => {
      const ndc = (window as any).__3dica.view().ndc as Record<string, number> | null
      return ndc ? Object.values(ndc).map((n) => n.toFixed(4)).join(',') : 'none'
    })
    same = v === last ? same + 1 : 0
    last = v
  }
}

/** Evaluation idle, camera still, no toasts, pointer parked, nothing hovered. */
export async function settle(page: Page, opts: { keepToasts?: boolean; keepPointer?: boolean } = {}): Promise<void> {
  await idle(page)
  await cameraStill(page)
  if (!opts.keepToasts) await dismissToasts(page)
  if (!opts.keepPointer) await parkPointer(page)
  await idle(page)
  // two animation frames so the WebGL canvas shows the final state
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
}

/** Frame the selection (F) and wait for the tween. The keyboard must belong to the app (no field focused). */
export async function frameSelection(page: Page): Promise<void> {
  await page.keyboard.press('f')
  await page.waitForTimeout(350)
  await settle(page)
}

/**
 * Zoom the view with the mouse wheel (camera only; negative = closer). The pointer goes to an empty corner of the view
 * first, so it hovers neither an object nor the gizmo; the orbit controls zoom towards their target, not the pointer.
 */
export async function wheelZoom(page: Page, deltaY: number): Promise<void> {
  const v = await page.locator('#view').boundingBox()
  if (!v) throw new Error('wheelZoom: no view')
  await page.mouse.move(v.x + v.width - 30, v.y + 80) // top right: no breadcrumb, banner, hint or toast there
  for (let left = deltaY; Math.abs(left) > 0;) {
    const step = Math.sign(left) * Math.min(Math.abs(left), 200)
    await page.mouse.wheel(0, step)
    left -= step
    await page.waitForTimeout(30)
  }
  await page.waitForTimeout(200)
  await settle(page)
}

/** Give the keyboard back to the app: Esc blurs a focused field or the code editor (§4.13) without other effects. */
export async function blurField(page: Page): Promise<void> {
  const editable = await page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null
    if (!a || a === document.body) return false
    return a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA' || !!a.closest('.cm-editor')
  })
  if (editable) await page.keyboard.press('Escape')
}

// ───────────────────────────── capture ─────────────────────────────

type Clip = { x: number; y: number; width: number; height: number }

/** Save docs/public/shots/<name>.png: the full page, an element, or a clip (page coordinates). */
export async function shot(page: Page, name: string, target?: Locator | Clip, opts: { pad?: number } = {}): Promise<void> {
  fs.mkdirSync(SHOTS_DIR, { recursive: true })
  const file = path.join(SHOTS_DIR, `${name}.png`)
  const common = { path: file, animations: 'disabled' as const, caret: 'hide' as const, scale: 'css' as const }
  if (!target) await page.screenshot(common)
  else if ('screenshot' in target) {
    if (opts.pad) {
      const b = await target.boundingBox()
      if (!b) throw new Error(`${name}: target not visible`)
      await page.screenshot({ ...common, clip: padClip(b, opts.pad) })
    } else await target.screenshot(common)
  } else await page.screenshot({ ...common, clip: target })
  expect(fs.statSync(file).size, `${name}.png written`).toBeGreaterThan(1000)
}

/** Grow a box by `pad` px on every side, kept inside the 1440×900 viewport. */
export function padClip(b: Clip, pad: number): Clip {
  const x = Math.max(0, Math.floor(b.x - pad))
  const y = Math.max(0, Math.floor(b.y - pad))
  const r = Math.min(1440, Math.ceil(b.x + b.width + pad))
  const btm = Math.min(900, Math.ceil(b.y + b.height + pad))
  return { x, y, width: r - x, height: btm - y }
}

/** The union of several element boxes (page coordinates), padded. */
export async function unionClip(locators: Locator[], pad = 0): Promise<Clip> {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const l of locators) {
    const b = await l.boundingBox()
    if (!b) continue
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height)
  }
  if (!Number.isFinite(x0)) throw new Error('unionClip: nothing visible')
  return padClip({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, pad)
}

// ───────────────────────────── editing helpers (real input) ─────────────────────────────

/** Replace the code editor document as a user would: click into it, select all, paste the new text. */
export async function replaceCode(page: Page, text: string): Promise<void> {
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(text)
}

/** Type a value into an inspector field and commit it with Enter (Enter hands the keyboard back to the app). */
export async function commitField(field: Locator, value: string): Promise<void> {
  await field.click()
  await field.fill(value)
  await field.press('Enter')
}
