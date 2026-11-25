// Screenshots for the OpenSCAD pages of the manual (docs/guide/openscad.md): an import into the sample, an OpenSCAD
// object in the inspector (Customizer parameters, highlighted code, the Output panel) and the attached-files list.
// The .scad sources are the guide's worked example. Each test boots the sample (/?fresh) and imports through the
// toolbar's Import button and the browser's file chooser, as a user does.
import { test, expect, type Page } from '@playwright/test'
import { boot, failOnPageErrors, idle, libRow, project, settle, shot } from './helpers'

failOnPageErrors()

/** The guide's worked example: an angle bracket that uses a small library of screw holes. */
const BRACKET = `// An angle bracket with a row of screw holes
use <lib/holes.scad>

/* [Size] */
// Length of the base in mm
length = 60; // [30:5:150]
// Width and height in mm
width = 20; // [10:40]
// Wall thickness
wall = 3; // [2:0.5:6]

/* [Holes] */
// Number of screw holes
holes = 3; // [2, 3, 4, 5]
// Screw size
screw = 4; // [3:M3, 4:M4, 5:M5]
countersink = true;

spacing = (length - width) / (holes - 1);
echo(str("Hole spacing: ", spacing, " mm"));

difference() {
  union() {
    cube([length, width, wall]);
    cube([wall, width, width]);
  }
  for (i = [0 : holes - 1])
    translate([width / 2 + i * spacing, width / 2, 0])
      screw_hole(screw, wall, countersink);
}
`

const HOLES = `// A through hole for a screw, with an optional countersink at the top
module screw_hole(d, depth, countersink = true) {
  translate([0, 0, -1]) cylinder(d = d + 0.4, h = depth + 2, $fn = 24);
  if (countersink)
    translate([0, 0, depth - d / 2]) cylinder(d1 = d, d2 = d * 2, h = d / 2 + 0.01, $fn = 24);
}
`

/** A second object for the files list: it uses the same library and includes a file that was not chosen. */
const LID = `use <lib/holes.scad>
include <lib/sizes.scad>

difference() {
  cube([lid_w, lid_d, 2]);
  translate([lid_w / 2, lid_d / 2, 0]) screw_hole(3, 2);
}
`

const file = (name: string, text: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) })
const history = (page: Page) => page.evaluate(() => (window as any).__3dica.history() as { past: string[]; future: string[] })

/** Toolbar Import → choose `files` in the file chooser; wait for the import's undo step and the evaluation. */
async function importFiles(page: Page, files: ReturnType<typeof file>[]): Promise<void> {
  const before = (await history(page)).past.length
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('import').click()
  await (await chooser).setFiles(files)
  await page.waitForFunction((n) => (window as any).__3dica.history().past.length > n, before)
  await idle(page)
}

const defNamed = async (page: Page, name: string) => Object.values((await project(page)).defs).find((d: any) => d.name === name) as any

test('openscad-import', async ({ page }) => {
  await boot(page)
  await importFiles(page, [file('bracket.scad', BRACKET), file('holes.scad', HOLES)])
  expect((await history(page)).past.at(-1)).toBe('Import bracket.scad')
  // holes.scad is attached to the bracket (under the path its use <…> gives) instead of becoming an object
  const def = await defNamed(page, 'bracket')
  expect(def).toMatchObject({ lang: 'openscad', files: { 'lib/holes.scad': HOLES } })
  expect(await defNamed(page, 'holes')).toBeUndefined()
  await expect(page.getByTestId('inspector-title')).toHaveText('bracket')
  await expect(page.getByTestId('scad-badge')).toBeVisible()
  await expect(page.getByTestId('code-status')).toContainText('triangles')
  await settle(page)
  await shot(page, 'openscad-import')
})

test.describe('a taller window', () => {
  // 1440 × 1240, so the inspector shows the whole parameter table above the code editor
  test.use({ viewport: { width: 1440, height: 1240 } })

  test('openscad-editor', async ({ page }) => {
    await boot(page)
    await importFiles(page, [file('bracket.scad', BRACKET), file('holes.scad', HOLES)])
    // the definition from the Library: the parameter table is open
    await libRow(page, 'bracket').click()
    await expect(page.getByTestId('scad-params-note')).toBeVisible()
    await expect(page.getByTestId('scad-param-row')).toHaveCount(6)
    await expect(page.getByTestId('scad-param-group')).toHaveText(['Size', 'Holes'])
    const echo = page.locator('[data-testid="scad-output-line"][data-level="echo"]')
    await expect(echo).toHaveText(/ECHO: "Hole spacing: 20 mm"/)
    await expect(page.locator('.cm-content[aria-label="OpenSCAD code"]')).toHaveCount(1)
    await settle(page)
    // scroll the editor with the wheel to the code below the parameters
    const host = await page.getByTestId('code-editor').boundingBox()
    await page.mouse.move(host!.x + host!.width / 2, host!.y + host!.height / 2)
    await page.mouse.wheel(0, 1000)
    await expect(page.locator('.cm-line', { hasText: 'screw_hole(screw, wall, countersink);' })).toBeInViewport()
    await settle(page)
    await shot(page, 'openscad-editor', page.locator('#right'))
  })
})

test('openscad-files', async ({ page }) => {
  await boot(page)
  await importFiles(page, [file('lid.scad', LID), file('holes.scad', HOLES)])
  // lib/sizes.scad was not chosen: the object fails with OpenSCAD's message and the Inspector lists the file as missing
  await expect.poll(async () => (await page.evaluate(() => (window as any).__3dica.defError('lid')))?.message)
    .toBe("Can't open include file 'lib/sizes.scad'")
  const files = page.getByTestId('scad-files')
  await expect(files.locator('[data-testid="scad-file"][data-state="attached"]')).toHaveAttribute('data-path', 'lib/holes.scad')
  await expect(files.locator('[data-testid="scad-file"][data-state="missing"]')).toHaveAttribute('data-path', 'lib/sizes.scad')
  // the definition from the Library (no instance section), scrolled so the Files section is in view
  await libRow(page, 'lid').click()
  const sec = page.locator('.scad-files-sec')
  await sec.scrollIntoViewIfNeeded()
  await settle(page)
  await shot(page, 'openscad-files', sec, { pad: 10 })
})
