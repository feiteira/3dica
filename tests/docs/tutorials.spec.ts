// The manual's three tutorials, performed step by step through the real UI (clicks, keys, drags), with a screenshot
// after each step: docs/public/shots/tut1-*.png, tut2-*.png, tut3-*.png. If a step stops working, this file fails, so
// the tutorials in docs/tutorials/*.md stay true. Camera-only actions (F / Home to frame, a mouse-wheel zoom) are added
// before some captures; tutorial 2 also labels and moves the new copy, which otherwise lands on top of Fixture B.
import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import {
  blurField, boot, commitField, defStatus, failOnPageErrors, frameSelection, idle, libRow, newProject, occurrencesOf, project, row,
  rowNamed, replaceCode, settle, shot, ui, wheelZoom,
} from './helpers'

failOnPageErrors()

/** Frame everything (Home) and wait for the tween. */
async function frameAll(page: Page): Promise<void> {
  await page.keyboard.press('Home')
  await page.waitForTimeout(350)
  await settle(page)
}

/** Drag a tree row onto another row at `fy` (0 = top edge, 0.5 = middle, 1 = bottom edge), with real mouse input. */
async function dragRow(page: Page, from: ReturnType<typeof row>, to: ReturnType<typeof row>, fy: number): Promise<void> {
  const a = await from.boundingBox()
  const b = await to.boundingBox()
  if (!a || !b) throw new Error('dragRow: rows not visible')
  const x = a.x + 90
  const y0 = a.y + a.height / 2
  const y1 = b.y + b.height * fy
  await page.mouse.move(x, y0)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(x, y0 + (y1 - y0) * (i / 8))
  await page.mouse.move(x + 2, y1)
  await page.mouse.up()
}

/** In the definition's parameter table: remove every parameter, then add `params` (name → default) one by one. */
async function setParamTable(page: Page, params: [string, number][]): Promise<void> {
  const details = page.locator('details.pt-details')
  if (!(await details.evaluate((d) => (d as HTMLDetailsElement).open))) await details.locator('summary').click()
  while (await page.getByTestId('pdef-del-0').count()) {
    const n = await page.locator('.pt-row').count()
    await page.getByTestId('pdef-del-0').click()
    await expect(page.locator('.pt-row')).toHaveCount(n - 1)
  }
  for (let i = 0; i < params.length; i++) {
    const [name, value] = params[i]
    await page.getByTestId('param-add').click()
    const nameIn = page.getByTestId(`pdef-name-${i}`)
    await expect(nameIn).toBeFocused()
    await nameIn.fill(name)
    await nameIn.press('Enter')
    await expect(page.getByTestId(`pdef-name-${i}`)).toHaveValue(name)
    await commitField(page.getByTestId(`pdef-default-${i}`), String(value))
    await expect(page.getByTestId(`pdef-default-${i}`)).toHaveValue(String(value))
  }
  await blurField(page)
}

/** F2 on the selection, type the new name, Enter. */
async function rename(page: Page, name: string): Promise<void> {
  await page.keyboard.press('F2')
  const input = page.getByTestId('rename-input')
  await expect(input).toBeVisible()
  await input.fill(name)
  await input.press('Enter')
  await expect(input).toHaveCount(0)
}

// ───────────────────────────── Tutorial 1: Your first part ─────────────────────────────

test('tutorial 1: your first part (a plate with a hole)', async ({ page }) => {
  await boot(page)

  // (1) New → confirm → an empty "Untitled" project
  await newProject(page)
  await expect(page.getByTestId('inspector-counts')).toHaveText('0 definitions · 0 objects in the scene')
  await shot(page, 'tut1-01-new')

  // (2) Cube (auto-selected) → Parameters: width 40, depth 30, height 5
  await page.getByTestId('add-cube').click()
  await expect(page.getByTestId('inspector-title')).toHaveText('Cube')
  await commitField(page.getByTestId('param-width'), '40')
  await commitField(page.getByTestId('param-depth'), '30')
  await commitField(page.getByTestId('param-height'), '5')
  await idle(page)
  await frameAll(page)
  await shot(page, 'tut1-02-cube')

  // (3) Cyl → Parameters: radius 4, height 10 → Transform Position X 0, Y 0, Z -2 (it pokes through the slab)
  await page.getByTestId('add-cylinder').click()
  await expect(page.getByTestId('inspector-title')).toHaveText('Cylinder')
  await commitField(page.getByTestId('param-radius'), '4')
  await commitField(page.getByTestId('param-height'), '10')
  await commitField(page.getByTestId('xf-t0'), '0')
  await commitField(page.getByTestId('xf-t1'), '0')
  await commitField(page.getByTestId('xf-t2'), '-2')
  await idle(page)
  const cyl = (await project(page)).defs[(await project(page)).root].children[1]
  expect(cyl.xf.t).toEqual([0, 0, -2])
  await frameAll(page)
  await shot(page, 'tut1-03-cylinder')

  // (4) click the Cube row → toolbar Subtract (−) → the cube is wrapped in a group named "Subtract"
  await rowNamed(page, 'Cube').click()
  await page.getByTestId('wrap-subtract').click()
  await expect(rowNamed(page, 'Subtract')).toHaveCount(1)
  await expect(page.getByTestId('inspector-title')).toHaveText('Subtract')
  await settle(page)
  await shot(page, 'tut1-04-wrap')

  // (5) drag the Cylinder row onto the MIDDLE of the Subtract row → it becomes the cutter (world position kept)
  await dragRow(page, rowNamed(page, 'Cylinder'), rowNamed(page, 'Subtract'), 0.5)
  await idle(page)
  {
    const p = await project(page)
    const sub = Object.values(p.defs).find((d: any) => d.name === 'Subtract') as any
    expect(sub.children.map((c: any) => p.defs[c.def].name)).toEqual(['Cube', 'Cylinder'])
    expect(sub.children[1].xf.t).toEqual([0, 0, -2])
    expect(p.defs[p.root].children).toHaveLength(1)
  }
  // select the Subtract row to see the red cutter
  await rowNamed(page, 'Subtract').click()
  await expect(rowNamed(page, 'Cylinder')).toHaveClass(/op-cut/)
  await expect.poll(() => defStatus(page, 'Subtract')).toBe('ok')
  await frameSelection(page)
  await wheelZoom(page, -900) // closer: the hole is bigger than the gizmo drawn at its centre
  await shot(page, 'tut1-05-hole')

  // (6) F2 on the Subtract row → "Plate with hole" → Enter → Esc to deselect
  await rename(page, 'Plate with hole')
  await expect(rowNamed(page, 'Plate with hole')).toHaveCount(1)
  await page.keyboard.press('Escape')
  expect((await ui(page)).selection).toEqual({ kind: 'none' })
  await settle(page)
  await shot(page, 'tut1-06-done')

  // then STL exports it (nothing selected → the whole scene)
  const dl = page.waitForEvent('download')
  await page.getByTestId('export-stl').click()
  const download = await dl
  expect(download.suggestedFilename()).toBe('Untitled-scene.stl')
  const buf = fs.readFileSync(await download.path())
  expect(buf.length).toBe(84 + 50 * buf.readUInt32LE(80))
  expect(buf.readUInt32LE(80)).toBeGreaterThan(50)
})

// ───────────────────────────── Tutorial 2: Linked copies ─────────────────────────────

test('tutorial 2: linked copies', async ({ page }) => {
  await boot(page)

  // (1) click the "Fixture A" row → Ctrl+D → a third, linked fixture
  await row(page, 'i_fx1').click()
  await page.keyboard.press('Control+D')
  await idle(page)
  expect(await occurrencesOf(page, 'Fixture')).toBe(3)
  const sel = (await ui(page)).selection
  expect(sel.kind).toBe('occ')
  const third: string = sel.path[0]
  // the copy lands one fixture width + 5 mm to the right (X 65), on top of Fixture B: give it its own label and move it
  expect((await project(page)).defs.d_root.children.find((c: any) => c.id === third).xf.t).toEqual([65, 0, 0])
  await commitField(page.getByTestId('inst-label'), 'Fixture C')
  await commitField(page.getByTestId('xf-t1'), '55')
  await expect(row(page, third).locator('.row-name')).toHaveText('Fixture C')
  await idle(page)
  await frameAll(page)
  await shot(page, 'tut2-01-linked')

  // (2) click Library "Bolt" → in the definition's parameter table set the DEFAULT of diameter from 5 to 4
  await libRow(page, 'Bolt').click()
  await expect(page.getByTestId('pdef-name-1')).toHaveValue('diameter')
  await commitField(page.getByTestId('pdef-default-1'), '4')
  await idle(page)
  expect((await project(page)).defs.d_bolt.params[1].default).toBe(4)
  // back to the scene (a Library click isolates the definition): every bolt, in all fixtures and the rack, is thinner
  await blurField(page)
  await page.keyboard.press('Escape')
  expect((await ui(page)).viewMode).toBe('context')
  await idle(page)
  await frameAll(page)
  await shot(page, 'tut2-02-edit-definition')

  // (3) select the third fixture → Make unique (U) → Library gains "Fixture 2"
  await row(page, third).click()
  await page.keyboard.press('u')
  await expect(libRow(page, 'Fixture 2')).toHaveCount(1)
  // expand it, select its Plate row → set the width override to 80: only that fixture's plate widens
  const toggle = row(page, third).getByTestId('tree-toggle')
  if (!(await toggle.evaluate((t) => t.classList.contains('open')))) await toggle.click()
  const plate = page.locator(`[data-testid="tree-row"][data-path^="${third}/"]`).filter({ has: page.locator('.row-name', { hasText: /^Plate$/ }) })
  await plate.click()
  await commitField(page.getByTestId('param-width'), '80')
  await idle(page)
  {
    const p = await project(page)
    const f2 = Object.values(p.defs).find((d: any) => d.name === 'Fixture 2') as any
    expect(f2.children.find((c: any) => c.def === 'd_plate').params).toEqual({ width: 80 })
    expect(p.defs.d_fixture.children.find((c: any) => c.def === 'd_plate').params).toBeUndefined()
  }
  await blurField(page)
  await frameAll(page)
  await shot(page, 'tut2-03-make-unique')
})

// ───────────────────────────── Tutorial 3: Code objects and part() ─────────────────────────────

const BRACKET_CODE = `const { width, height, thickness } = params
const base = cuboid({ size: [width, 20, thickness], center: [0, 0, thickness / 2] })
const wall = cuboid({ size: [width, thickness, height], center: [0, 10 - thickness / 2, height / 2] })
return union(base, wall)`

const ROW_CODE = `const out = []
for (let i = 0; i < params.count; i++) {
  out.push(translateX(i * (params.width + 5), part('Bracket', { width: params.width })))
}
return out`

test('tutorial 3: code objects and part()', async ({ page }) => {
  await boot(page)
  await newProject(page)

  // (1) Code → rename the definition to "Bracket" (F2) → parameters width 30, height 25, thickness 3 → the code
  await page.getByTestId('add-code').click()
  await expect(page.getByTestId('inspector-title')).toHaveText('Object')
  await rename(page, 'Bracket')
  await expect(page.getByTestId('inspector-title')).toHaveText('Bracket')
  await setParamTable(page, [['width', 30], ['height', 25], ['thickness', 3]])
  await replaceCode(page, BRACKET_CODE)
  await idle(page)
  await expect.poll(() => defStatus(page, 'Bracket')).toBe('ok')
  await page.keyboard.press('Control+Home') // caret to the start (no bracket-match highlight)
  await page.keyboard.press('Escape') // leave the editor
  await frameSelection(page)
  await shot(page, 'tut3-01-code')
  await shot(page, 'tut3-02-params', page.locator('details.pt-details'), { pad: 8 })

  // (2) Code again → "Bracket row" with count 4 and width 20 → the part() code
  await page.getByTestId('add-code').click()
  await expect(page.getByTestId('inspector-title')).toHaveText('Object')
  await rename(page, 'Bracket row')
  await setParamTable(page, [['count', 4], ['width', 20]])
  await replaceCode(page, ROW_CODE)
  await idle(page)
  await expect.poll(() => defStatus(page, 'Bracket row')).toBe('ok')
  // select the Bracket instance and press H to hide it, then select the Bracket row again
  await rowNamed(page, 'Bracket').click()
  await page.keyboard.press('h')
  await idle(page)
  expect((await project(page)).defs[(await project(page)).root].children[0].hidden).toBe(true)
  await rowNamed(page, 'Bracket row').click()
  await frameSelection(page)
  await shot(page, 'tut3-03-part')
})
