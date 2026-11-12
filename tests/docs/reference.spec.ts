// Reference screenshots for the manual: the interface, selection, isolate, inspector, code editor, gizmo modes,
// groups, ghosting, tree drag and drop, dialogs and the status bar. Each test boots the sample (/?fresh) and reaches its
// state through real UI input. Output: docs/public/shots/<name>.png (see helpers.ts).
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import {
  blurField, boot, commitField, defStatus, failOnPageErrors, frameSelection, gizmoAt, idle, libRow, parkPointer, project, row, settle,
  shot, ui, wheelZoom,
} from './helpers'

failOnPageErrors()

test('overview', async ({ page }) => {
  await boot(page)
  expect((await ui(page)).selection).toEqual({ kind: 'none' })
  await shot(page, 'overview')
})

test('toolbar and status bar', async ({ page }) => {
  await boot(page)
  await shot(page, 'toolbar', page.locator('#toolbar'))
  await shot(page, 'status-bar', page.locator('#status'))
})

test('select-linked', async ({ page }) => {
  await boot(page)
  await row(page, 'i_fx1/i_b1').click()
  await expect(row(page, 'i_fx2/i_b1')).toHaveClass(/linked/)
  await settle(page)
  await shot(page, 'select-linked')
})

test('isolate', async ({ page }) => {
  await boot(page)
  await row(page, 'i_fx1/i_plate').click()
  await page.keyboard.press('i')
  await expect(page.getByTestId('isolate-banner')).toBeVisible()
  await page.waitForTimeout(400)
  await settle(page)
  await shot(page, 'isolate')
})

test('tree-library', async ({ page }) => {
  await boot(page)
  // Fixture A stays expanded, Fixture B is collapsed so the tree fits
  await row(page, 'i_fx2').getByTestId('tree-toggle').click()
  await row(page, 'i_fx1/i_b1').click()
  await settle(page)
  await shot(page, 'tree-library', page.locator('#left'))
})

test('inspector-instance', async ({ page }) => {
  await boot(page)
  await row(page, 'i_fx1/i_b1').click()
  await commitField(page.getByTestId('param-length'), '16')
  await idle(page)
  await expect(page.locator('.prm.overridden')).toHaveCount(1)
  await blurField(page)
  await settle(page)
  await shot(page, 'inspector-instance', page.locator('#inspector'))
})

test('inspector-definition', async ({ page }) => {
  await boot(page)
  await libRow(page, 'Bolt').click()
  await expect(page.getByTestId('pdef-name-0')).toBeVisible()
  await settle(page)
  await shot(page, 'inspector-definition', page.locator('#inspector'))
})

test('code-editor', async ({ page }) => {
  await boot(page)
  await row(page, 'i_fx1/i_plate').click()
  await expect(page.locator('.cm-content')).toContainText('roundedCuboid')
  await settle(page)
  await shot(page, 'code-editor', page.locator('.insp-code'))
})

test('code-error', async ({ page }) => {
  await boot(page)
  await row(page, 'i_fx1/i_b1').click()
  // a new line 2: click the end of line 1, Enter, then type the throw
  await page.locator('.cm-line').first().click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('throw new Error("boom: thread pitch too small")')
  await expect.poll(async () => { await idle(page); return defStatus(page, 'Bolt') }).toBe('error')
  await expect(page.locator('.cm-lint-marker-error').first()).toBeVisible()
  await page.keyboard.press('Control+Home') // caret to the start: no bracket-match highlight on line 2
  await page.keyboard.press('Escape') // leave the editor
  await settle(page)
  await shot(page, 'code-error', page.locator('.insp-code'))
})

for (const [name, key] of [['gizmo-translate', 'w'], ['gizmo-rotate', 'e'], ['gizmo-scale', 'r']] as const) {
  test(name, async ({ page }) => {
    await boot(page)
    await row(page, 'i_bs').click()
    await page.keyboard.press(key)
    await frameSelection(page)
    await shot(page, name, page.locator('#view'))
  })
}

test('context-breadcrumb', async ({ page }) => {
  await boot(page)
  // nothing is selected, so the gizmo helper reports the world origin: the middle of Fixture A's plate
  const o = await gizmoAt(page, 'X', 0)
  await page.mouse.dblclick(o.x + 4, o.y + 6)
  await expect.poll(async () => (await ui(page)).context).toEqual(['i_fx1'])
  // the double-click entered Fixture A and selected the part under the pointer
  expect((await ui(page)).selection).toEqual({ kind: 'occ', path: ['i_fx1', 'i_plate'] })
  // a click on empty space clears the selection and stays inside the group
  const view = await page.locator('#view').boundingBox()
  await page.mouse.click(view!.x + view!.width - 60, view!.y + 70)
  await expect.poll(async () => (await ui(page)).selection).toEqual({ kind: 'none' })
  expect((await ui(page)).context).toEqual(['i_fx1'])
  await expect(page.getByTestId('breadcrumb')).toHaveText(/Scene\s*›\s*Fixture A/)
  await settle(page)
  await shot(page, 'context-breadcrumb', page.locator('#view'))
})

test('operands', async ({ page }) => {
  await boot(page)
  await row(page, 'i_fx1/i_w1').click()
  await frameSelection(page)
  await wheelZoom(page, 1000) // F frames the washer edge to edge; step back to show the plate and bolt around it
  await shot(page, 'operands', page.locator('#view'))
})

test('ghost-off', async ({ page }) => {
  await boot(page)
  await row(page, 'i_fx1/i_b1').click()
  await page.getByTestId('ghost').click()
  expect((await ui(page)).ghostOthers).toBe(false)
  await settle(page)
  await shot(page, 'ghost-off')
})

test('drag-drop', async ({ page }) => {
  await boot(page)
  await row(page, 'i_fx2').getByTestId('tree-toggle').click()
  await settle(page)
  // drag 'Bolt sizes' up to the top edge of 'Fixture B': the blue line shows where it will land
  const src = await row(page, 'i_bs').boundingBox()
  const dst = await row(page, 'i_fx2').boundingBox()
  await page.mouse.move(src!.x + 90, src!.y + src!.height / 2)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(dst!.x + 90, src!.y + src!.height / 2 + ((dst!.y + 4) - (src!.y + src!.height / 2)) * (i / 8))
  }
  await page.mouse.move(dst!.x + 92, dst!.y + 4)
  await expect(page.locator('.drop-line')).toBeVisible()
  await shot(page, 'drag-drop', page.locator('#left'))
  await page.mouse.up()
  await idle(page)
  const root = (await project(page)).defs.d_root.children.map((c: any) => c.id)
  expect(root).toEqual(['i_fx1', 'i_bs', 'i_fx2'])
})

test('dialog-run-code', async ({ page }, info) => {
  await boot(page)
  const file = info.outputPath('bracket-kit.3dica.json')
  fs.mkdirSync(info.outputDir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(await project(page), null, 2))
  page.once('filechooser', (fc) => fc.setFiles(file))
  await page.getByTestId('open').click()
  const dlg = page.getByTestId('confirm-dialog')
  await expect(dlg).toContainText('This file contains code that runs on your computer. Run it?')
  await parkPointer(page)
  await shot(page, 'dialog-run-code', dlg, { pad: 28 })
  await page.getByTestId('confirm-ok').click()
  await expect(dlg).toHaveCount(0)
})

test('dialog-delete', async ({ page }) => {
  await boot(page)
  // Bolt is used by code in 'Bolt sizes' (part('Bolt')): Del is refused with an error toast and no dialog
  await libRow(page, 'Bolt').click()
  await page.keyboard.press('Delete')
  await expect(page.locator('[data-testid="toast"]').filter({ hasText: "Can't delete 'Bolt': used by code in 'Bolt sizes'" })).toHaveCount(1)
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0)
  // Washer is only used by instances: Del asks first
  await libRow(page, 'Washer').click()
  await settle(page)
  await page.keyboard.press('Delete')
  const dlg = page.getByTestId('confirm-dialog')
  await expect(dlg).toContainText("Delete 'Washer' and its 4 instances (8 copies in the scene)?")
  await parkPointer(page)
  await shot(page, 'dialog-delete', dlg, { pad: 28 })
  await page.getByTestId('confirm-cancel').click()
  await expect(dlg).toHaveCount(0)
})
