// OpenSCAD objects end to end: Import (button and drop), the OpenSCAD editor (highlighting mode, gutter errors, the
// Output panel), parameters (per-instance overrides, defaults written back into the code), part() both ways,
// attached files, save / open / autosave round trips, undo, STL, linked copies and the geometry limit.
// Each test boots /?fresh (the sample) and fails if the page logged an error.
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
const stats = (page: Page) => page.evaluate(() => (window as any).__3dica.stats() as { meshes: number; geometries: number; triangles: number; failed: number })
const defStatus = (page: Page, name: string) => page.evaluate((n) => (window as any).__3dica.defStatus(n) as string, name)
const defError = (page: Page, name: string) => page.evaluate((n) => (window as any).__3dica.defError(n), name)
const project = (page: Page) => page.evaluate(() => (window as any).__3dica.project())
const history = (page: Page) => page.evaluate(() => (window as any).__3dica.history() as { past: string[]; future: string[] })
const defNamed = async (page: Page, name: string) => Object.values((await project(page)).defs).find((d: any) => d.name === name) as any
const libRow = (page: Page, name: string) =>
  page.locator('[data-testid="lib-row"]').filter({ has: page.locator('.lib-name', { hasText: new RegExp(`^${name}$`) }) })
/** triangles of the selected object's result, from the inspector status line ("✓ 12 ms · 48 triangles") */
async function selectedTriangles(page: Page): Promise<number> {
  const t = await page.getByTestId('code-status').textContent()
  const m = /([\d,]+) triangles/.exec(t ?? '')
  if (!m) throw new Error(`no triangle count in "${t}"`)
  return Number(m[1].replace(/,/g, ''))
}
const file = (name: string, text: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) })

/** Replace the whole code editor document with `text` (select all, then type), and let it commit and evaluate. */
async function setEditorCode(page: Page, text: string): Promise<void> {
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(text)
  await idle(page)
}

/** Wait until the undo history has `n` more steps than `before` (an import reads its files asynchronously first). */
async function steps(page: Page, before: number, n = 1): Promise<void> {
  await page.waitForFunction((want) => (window as any).__3dica.history().past.length >= want, before + n)
  await idle(page)
}

async function importFiles(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]): Promise<void> {
  const before = (await history(page)).past.length
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('import').click()
  await (await chooser).setFiles(files)
  await steps(page, before)
}

/** Drop files on the window like a file manager does. */
async function dropFiles(page: Page, files: { name: string; text: string }[]): Promise<void> {
  const before = (await history(page)).past.length
  await page.evaluate((list) => {
    const dt = new DataTransfer()
    for (const f of list) dt.items.add(new File([f.text], f.name, { type: 'text/plain' }))
    const fire = (type: string) => document.body.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }))
    fire('dragenter'); fire('dragover'); fire('drop')
  }, files)
  await steps(page, before)
}

const PEG = `// Number of sides
n = 6; // [3:24]
h = 10;
cylinder(r = 5, h = h, $fn = n);
`

test('import: two files → one object with the included file attached; badge, files list, undo / redo', async ({ page }) => {
  await boot(page)
  await importFiles(page, [
    file('bracket.scad', 'include <gear.scad>\nw = 30; // [10:80]\ngear(w);\n'),
    file('gear.scad', 'module gear(w) difference() { cube([w, 10, 4]); translate([w / 2, 5, -1]) cylinder(d = 4, h = 6, $fn = 16); }\n'),
  ])
  const d = await defNamed(page, 'bracket')
  expect(d).toMatchObject({ lang: 'openscad', files: { 'gear.scad': expect.stringContaining('module gear') } })
  expect(await defNamed(page, 'gear')).toBeUndefined()
  expect(await defStatus(page, 'bracket')).toBe('ok')
  expect((await history(page)).past.at(-1)).toBe('Import bracket.scad')
  // selected, with the OpenSCAD badge, editor mode and the attached file listed
  await expect(page.getByTestId('inspector-title')).toHaveText('bracket')
  await expect(page.getByTestId('scad-badge')).toBeVisible()
  await expect(page.getByTestId('code-title')).toHaveText('OpenSCAD')
  await expect(page.locator('[data-testid="scad-file"][data-state="attached"]')).toHaveAttribute('data-path', 'gear.scad')
  await expect(page.getByTestId('param-w')).toHaveValue('30')
  // the editor is in OpenSCAD mode: `include` is a keyword, `<gear.scad>` one string-like token
  await expect(page.locator('.cm-content[aria-label="OpenSCAD code"]')).toHaveCount(1)
  const line1 = page.locator('.cm-line').first()
  await expect(line1.locator('span', { hasText: /^include$/ })).toHaveCount(1)
  await expect(line1.locator('span', { hasText: /^<gear\.scad>$/ })).toHaveCount(1)
  const colors = await line1.locator('span').evaluateAll((els) => els.map((e) => getComputedStyle(e).color))
  expect(new Set(colors).size).toBe(2)
  // undo removes the whole import, redo brings it back
  await page.getByTestId('undo').click()
  await idle(page)
  expect(await defNamed(page, 'bracket')).toBeUndefined()
  await page.getByTestId('redo').click()
  await idle(page)
  expect(await defStatus(page, 'bracket')).toBe('ok')
})

test('drop a .scad file on the window; edit its code → the mesh changes; gutter error at the right line; Output shows echo', async ({ page }) => {
  await boot(page)
  await dropFiles(page, [{ name: 'peg.scad', text: PEG }])
  expect(await defStatus(page, 'peg')).toBe('ok')
  await expect(page.getByTestId('inspector-title')).toHaveText('peg')
  // a cylinder with k sides has 4k - 4 triangles
  expect(await selectedTriangles(page)).toBe(20)
  await setEditorCode(page, PEG.replace('$fn = n', '$fn = n * 2'))
  expect(await selectedTriangles(page)).toBe(44)

  // a syntax error on line 3: the error names the line and the gutter marks it
  await setEditorCode(page, 'n = 6;\ncube(n);\ncube(n;\n')
  expect(await defStatus(page, 'peg')).toBe('error')
  expect(await defError(page, 'peg')).toMatchObject({ kind: 'syntax', line: 3 })
  await expect(page.locator('.cm-gutter-lint .cm-lint-marker-error')).toHaveCount(1)
  await expect(page.locator('.cm-line').nth(2).locator('.cm-lintRange-error')).toHaveCount(1)
  await expect(page.locator('[data-testid="scad-output-line"][data-level="error"]')).toContainText('line 3')

  // echo goes to the Output panel; its line link puts the cursor on that line
  await setEditorCode(page, 'n = 6;\n\necho("sides", n);\ncube(n);\n')
  expect(await defStatus(page, 'peg')).toBe('ok')
  const echo = page.locator('[data-testid="scad-output-line"][data-level="echo"]')
  await expect(echo).toHaveCount(1)
  await expect(echo).toContainText('ECHO: "sides", 6')
  await echo.getByRole('button', { name: 'line 3' }).click()
  await expect(page.locator('.cm-activeLine')).toHaveText('echo("sides", n);')
})

test('parameters: a per-instance override changes the mesh, linked copies share one mesh, a default edit rewrites the code', async ({ page }) => {
  await boot(page)
  await dropFiles(page, [{ name: 'peg.scad', text: PEG }])
  const g0 = (await stats(page)).geometries
  // a linked copy shares the result
  await page.keyboard.press('Escape')
  await page.locator('[data-testid="tree-row"]').filter({ hasText: 'peg' }).first().click()
  await page.keyboard.press('Control+d')
  await idle(page)
  expect((await stats(page)).geometries).toBe(g0)
  expect(await selectedTriangles(page)).toBe(20)
  // override on this copy only: a second result (a cylinder with k sides has 4k - 4 triangles)
  const n = page.getByTestId('param-n')
  await n.fill('12')
  await n.press('Enter')
  await idle(page)
  expect(await selectedTriangles(page)).toBe(44)
  expect((await stats(page)).geometries).toBe(g0 + 1)
  expect((await defNamed(page, 'peg')).code).toBe(PEG)

  // the definition default: rewrites the literal in the code, one undo step "Change n"
  await libRow(page, 'peg').click()
  await idle(page)
  await expect(page.getByTestId('scad-params-note')).toBeVisible()
  await expect(page.getByTestId('param-add')).toHaveCount(0)
  const def0 = page.getByTestId('pdef-default-0')
  await def0.fill('8')
  await def0.press('Enter')
  await idle(page)
  expect((await defNamed(page, 'peg')).code).toBe(PEG.replace('n = 6;', 'n = 8;'))
  expect((await history(page)).past.at(-1)).toBe('Change n')
  await expect(page.locator('.cm-content')).toContainText('n = 8; // [3:24]')
  await page.getByTestId('undo').click()
  await idle(page)
  expect((await defNamed(page, 'peg')).code).toBe(PEG)
})

test('part() both ways: JSCAD uses an OpenSCAD object, OpenSCAD uses a JSCAD object (with an override)', async ({ page }) => {
  await boot(page)
  await dropFiles(page, [{ name: 'peg.scad', text: PEG }])
  // JSCAD → OpenSCAD
  await page.getByTestId('add-code').click()
  await idle(page)
  await setEditorCode(page, "return [part('peg'), translateX(20, part('peg', { n: 12 }))]")
  const jsName = (await page.getByTestId('inspector-title').textContent())!
  expect(await defStatus(page, jsName)).toBe('ok')
  // OpenSCAD → JSCAD: the sample's Bolt, with an override; the reference is a real dependency (delete is refused)
  await page.getByTestId('add-openscad').click()
  await idle(page)
  await setEditorCode(page, 'part("Bolt", length = 30);\ntranslate([20, 0, 0]) part("peg");\n')
  const scadName = (await page.getByTestId('inspector-title').textContent())!
  expect(await defStatus(page, scadName)).toBe('ok')
  await libRow(page, 'peg').click()
  await page.getByTestId('def-delete').click()
  await expect(page.getByTestId('toast').filter({ hasText: "Can't delete 'peg'" })).toBeVisible()
  // an unknown parameter is an error at the part() line
  await page.locator('[data-testid="tree-row"]').filter({ hasText: scadName }).first().click()
  await setEditorCode(page, 'cube(1);\npart("Bolt", lenght = 30);\n')
  expect(await defError(page, scadName)).toMatchObject({ line: 2, message: expect.stringContaining('unknown parameter "lenght"') })
})

test('a missing include is an error naming the file; attaching it fixes the object', async ({ page }) => {
  await boot(page)
  await importFiles(page, [file('main.scad', 'include <lib/gear.scad>\ngear(12);\n')])
  await expect(page.getByTestId('toast').filter({ hasText: "'main' needs 'lib/gear.scad'" })).toBeVisible()
  expect(await defStatus(page, 'main')).toBe('error')
  expect((await defError(page, 'main')).message).toContain('lib/gear.scad')
  const missing = page.locator('[data-testid="scad-file"][data-state="missing"]')
  await expect(missing).toHaveAttribute('data-path', 'lib/gear.scad')
  const before = (await history(page)).past.length
  const chooser = page.waitForEvent('filechooser')
  await missing.getByTestId('scad-file-attach').click()
  await (await chooser).setFiles([file('gear.scad', 'module gear(s) cube(s);\n')])
  await steps(page, before)
  expect(await defStatus(page, 'main')).toBe('ok')
  expect((await defNamed(page, 'main')).files).toEqual({ 'lib/gear.scad': 'module gear(s) cube(s);\n' })
  expect((await history(page)).past.at(-1)).toBe('Attach gear.scad')
  await expect(page.locator('[data-testid="scad-file"][data-state="attached"]')).toHaveAttribute('data-path', 'lib/gear.scad')
  // remove: the error comes back
  await page.getByTestId('scad-file-remove').click()
  await idle(page)
  expect(await defStatus(page, 'main')).toBe('error')
  expect((await history(page)).past.at(-1)).toBe('Remove gear.scad')
})

test('save and open again (asks before running), autosave restore, STL and .scad export', async ({ page }, info) => {
  await boot(page)
  await importFiles(page, [file('bracket.scad', 'include <gear.scad>\ngear(20);\n'), file('gear.scad', 'module gear(s) cube([s, 5, 2]);\n')])
  // STL of the selected OpenSCAD object: 12 triangles
  const dl = page.waitForEvent('download')
  await page.getByTestId('export-stl').click()
  const stl = fs.readFileSync(await (await dl).path())
  expect(stl.readUInt32LE(80)).toBe(12)
  expect(stl.length).toBe(84 + 12 * 50)
  // Export .scad
  const dl2 = page.waitForEvent('download')
  await page.getByTestId('scad-export').click()
  const scad = await dl2
  expect(scad.suggestedFilename()).toBe('bracket.scad')
  expect(fs.readFileSync(await scad.path(), 'utf8')).toBe('include <gear.scad>\ngear(20);\n')
  // Save
  const dl3 = page.waitForEvent('download')
  await page.getByTestId('save').click()
  const saved = fs.readFileSync(await (await dl3).path(), 'utf8')
  const json = JSON.parse(saved)
  const def = Object.values(json.defs).find((d: any) => d.name === 'bracket') as any
  expect(def).toMatchObject({ lang: 'openscad', files: { 'gear.scad': 'module gear(s) cube([s, 5, 2]);\n' } })
  // autosave restore (reload without ?fresh)
  await page.waitForTimeout(1500)
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__3dica?.ready === true)
  await idle(page)
  expect(await defNamed(page, 'bracket')).toMatchObject({ lang: 'openscad', files: { 'gear.scad': expect.any(String) } })
  expect(await defStatus(page, 'bracket')).toBe('ok')
  // open the saved file: still asks "Run code?"
  await boot(page)
  const path = info.outputPath('saved.3dica.json')
  fs.writeFileSync(path, saved)
  page.once('filechooser', (fc) => fc.setFiles(path))
  await page.getByTestId('open').click()
  await expect(page.getByTestId('confirm-dialog')).toContainText('This file contains code that runs on your computer. Run it?')
  await page.getByTestId('confirm-ok').click()
  await idle(page)
  expect(await defStatus(page, 'bracket')).toBe('ok')
})

test('autosave keeps a project with a 1 MB attachment', async ({ page }) => {
  await boot(page)
  const big = '// filler\n' + `x = 1; // ${'0123456789'.repeat(9)}\n`.repeat(10_000)
  await importFiles(page, [file('big.scad', 'include <filler.scad>\ncube(x);\n'), file('filler.scad', big)])
  expect(await defStatus(page, 'big')).toBe('ok')
  // a few edits (each autosaves; backups rotate) must keep the current state stored
  for (let i = 0; i < 3; i++) {
    await page.getByTestId('xf-t1').fill(String(10 + i))
    await page.getByTestId('xf-t1').press('Enter')
    await page.waitForTimeout(1300)
  }
  const stored = await page.evaluate(() => {
    const cur = JSON.parse(localStorage.getItem('3dica:v1:current') ?? 'null')
    const def = Object.values(cur.project.defs).find((d: any) => d.name === 'big') as any
    return { chars: def.files['filler.scad'].length }
  })
  expect(stored.chars).toBe(big.length)
  await expect(page.getByTestId('toast').filter({ hasText: 'Autosave unavailable' })).toHaveCount(0)
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__3dica?.ready === true)
  await idle(page)
  expect((await defNamed(page, 'big')).files['filler.scad']).toHaveLength(big.length)
})

test('a huge model stops with the geometry limit instead of hanging', async ({ page }) => {
  await boot(page)
  await page.getByTestId('add-openscad').click()
  await idle(page)
  const name = (await page.getByTestId('inspector-title').textContent())!
  const t0 = Date.now()
  await setEditorCode(page, 'cube(1);\nsphere(10, $fn = 3000);\n')
  expect(await defError(page, name)).toMatchObject({ line: 2, message: expect.stringMatching(/^Too much geometry: .* — lower \$fn$/) })
  await setEditorCode(page, 'for (i = [0 : 999], j = [0 : 999]) translate([i, j, 0]) cube(0.5);\n')
  // the interpreter's shape count or the builder's polygon budget, whichever stops it first
  expect(await defError(page, name)).toMatchObject({ message: expect.stringMatching(/^Too much geometry: this code made (more than 2,000,000 polygons|[\d,]+ shapes and transforms)/) })
  expect(Date.now() - t0).toBeLessThan(20_000)
  // the app still works afterwards
  await setEditorCode(page, 'cube(3);\n')
  expect(await defStatus(page, name)).toBe('ok')
})

test('a .scad file dropped on the code editor is imported, not pasted into the code', async ({ page }) => {
  await boot(page)
  await dropFiles(page, [{ name: 'peg.scad', text: PEG }])
  await expect(page.getByTestId('inspector-title')).toHaveText('peg')
  const before = (await history(page)).past.length
  await page.evaluate(() => {
    const target = document.querySelector('.cm-content')!
    const r = target.getBoundingClientRect()
    const dt = new DataTransfer()
    dt.items.add(new File(['cube(7); // dropped\n'], 'dropped.scad', { type: 'text/plain' }))
    const at = { clientX: r.left + 40, clientY: r.top + 8 }
    for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, ...at }))
  })
  await steps(page, before)
  expect((await defNamed(page, 'peg')).code).toBe(PEG)
  expect(await defNamed(page, 'dropped')).toMatchObject({ lang: 'openscad', code: 'cube(7); // dropped\n' })
  expect((await history(page)).past.slice(before)).toEqual(['Import dropped.scad'])
})

test('Enter in an unchanged field keeps the code and adds no override (values are shown in full)', async ({ page }) => {
  await boot(page)
  const code = 'phi = 1.61803; // golden ratio\neps = 0.00001;\ncube([10 * phi, 10, 10 + eps]);\n'
  await importFiles(page, [file('prec.scad', code)])
  const before = (await history(page)).past.length
  // an instance field shows the value rounded: Enter must not store the rounded value as an override
  const inst = page.getByTestId('param-phi')
  await inst.focus()
  await inst.press('Enter')
  await idle(page)
  // the definition's defaults show the literals in full; Enter changes nothing
  await libRow(page, 'prec').click()
  await idle(page)
  await expect(page.getByTestId('pdef-default-0')).toHaveValue('1.61803')
  await expect(page.getByTestId('pdef-default-1')).toHaveValue('0.00001')
  for (const k of ['pdef-default-0', 'pdef-default-1']) {
    await page.getByTestId(k).focus()
    await page.getByTestId(k).press('Enter')
    await idle(page)
  }
  expect((await defNamed(page, 'prec')).code).toBe(code)
  expect((await history(page)).past.length).toBe(before)
})

test('a file with Windows line ends: the editor keeps its selection while the app re-renders', async ({ page }) => {
  await boot(page)
  await importFiles(page, [file('win.scad', '// imported from Windows\r\nw = 20; // [10:50]\r\nh = 5;\r\ncube([w, 10, h]);\r\n')])
  expect((await defNamed(page, 'win')).code).toBe('// imported from Windows\nw = 20; // [10:50]\nh = 5;\ncube([w, 10, h]);\n')
  await page.locator('.cm-line').first().click()
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  const sel = () => page.evaluate(() => document.getSelection()?.toString() ?? '')
  const before = await sel()
  expect(before).toContain('imported from Windows')
  // hovering the 3D view re-renders the app (pre-highlight)
  const box = (await page.locator('canvas').first().boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.move(box.x + box.width / 3, box.y + box.height / 3)
  await idle(page)
  expect(await sel()).toBe(before)
})

test('an error inside an attached file is marked where the code calls into it', async ({ page }) => {
  await boot(page)
  await importFiles(page, [
    file('main.scad', 'include <lib.scad>\n\nfoo(3);\n'),
    file('lib.scad', 'module foo(x) {\n  echo(x);\n\n  assert(x > 5, "too small");\n}\n'),
  ])
  expect(await defStatus(page, 'main')).toBe('error')
  expect((await defError(page, 'main')).message).toMatch(/^lib\.scad:4: Assertion/)
  await expect(page.locator('.cm-gutter-lint .cm-lint-marker-error')).toHaveCount(1)
  await expect(page.locator('.cm-line').nth(2).locator('.cm-lintRange-error')).toHaveCount(1)
  await expect(page.locator('.cm-line').nth(0).locator('.cm-lintRange-error')).toHaveCount(0)
})

test('the Inspector names missing files and lists literals that are not parameters', async ({ page }) => {
  await boot(page)
  await importFiles(page, [file('tag.scad', 'use <a.scad>\ninclude <b.scad>\nlabel = "Hi";\nsize = [30, 20, 10];\nw = 2; // [1:5]\ncube(w);\n')])
  await expect(page.getByRole('button', { name: 'Attach a.scad' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Attach b.scad' })).toHaveCount(1)
  await libRow(page, 'tag').click()
  await idle(page)
  await expect(page.getByTestId('scad-params-skipped')).toHaveText('Not parameters here: label (text without options), size (a vector) — edit them in the code.')
  await expect(page.getByTestId('scad-params-note')).toContainText('top-level numbers, true/false and drop-downs')
})
