// Screenshots of the AI chat for the manual (docs/guide/ai-chat.md): the first-run empty state, the settings, a short
// conversation that builds a part, and the approval card. The provider is MOCKED (./mock-anthropic.ts): the replies
// are fixed, so the shots are the same on every run, and no request leaves the machine. The tool calls in those
// replies run through the real chat loop on the real app.
import { test, expect, type Page } from '@playwright/test'
import { boot, failOnPageErrors, newProject, parkPointer, settle, shot, wheelZoom } from './helpers'
import { FAKE_KEY, mockAnthropic, text, thinking, toolUse, turn } from './mock-anthropic'

failOnPageErrors()

const right = (page: Page) => page.locator('#right')
const chatIdle = (page: Page) => expect(page.locator('#chat')).toHaveAttribute('data-state', 'idle')

/** The right column from its top down to `bottom` (plus a margin), as a clip in page coordinates. */
async function columnDownTo(page: Page, bottom: ReturnType<Page['locator']>, margin = 16) {
  const col = await right(page).boundingBox()
  const b = await bottom.boundingBox()
  if (!col || !b) throw new Error('columnDownTo: not visible')
  const y1 = Math.min(col.y + col.height, Math.ceil(b.y + b.height + margin))
  return { x: Math.floor(col.x), y: Math.floor(col.y), width: Math.ceil(col.width), height: y1 - Math.floor(col.y) }
}

/** Chat tab → settings: Anthropic, the fake key, the model; Save. */
async function setUpAnthropic(page: Page): Promise<void> {
  await page.getByTestId('tab-chat').click()
  await page.getByTestId('chat-setup').click()
  await expect(page.getByTestId('ai-preset')).toHaveValue('anthropic')
  await page.getByTestId('ai-key').fill(FAKE_KEY)
  await page.getByTestId('ai-model').focus() // leaving the key field loads the model list
  await expect(page.getByTestId('ai-models-msg')).toContainText('4 models')
  await page.getByTestId('ai-model').fill('claude-opus-5-5')
  await page.getByTestId('ai-save').click()
  await expect(page.getByTestId('ai-settings')).toBeHidden()
  await expect(page.getByTestId('chat-provider')).toHaveText('Anthropic · claude-opus-5-5')
}

async function send(page: Page, message: string): Promise<void> {
  await page.getByTestId('chat-input').fill(message)
  await page.getByTestId('chat-input').press('Enter')
  await expect(page.locator('.chat-user').last()).toHaveText(message)
}

test('chat-empty', async ({ page }) => {
  await boot(page)
  await page.getByTestId('tab-chat').click()
  await expect(page.getByTestId('chat-empty')).toBeVisible()
  await expect(page.getByTestId('chat-setup')).toBeVisible()
  await expect(page.getByTestId('chat-input')).toBeDisabled()
  await page.getByTestId('chat-setup').blur()
  await parkPointer(page)
  await shot(page, 'chat-empty', right(page))
})

test('chat-settings', async ({ page }) => {
  await mockAnthropic(page, () => { throw new Error('no message is sent in this test') })
  await boot(page)
  await setUpAnthropic(page)
  // open them again, as a returning user does: the stored key (dots), the model, Forget key
  await page.getByTestId('chat-provider').click()
  await expect(page.getByTestId('ai-settings')).toBeVisible()
  await expect(page.getByTestId('ai-key')).toHaveAttribute('type', 'password')
  await expect(page.getByTestId('ai-key')).not.toHaveValue('')
  await expect(page.getByTestId('ai-model')).toHaveValue('claude-opus-5-5')
  await expect(page.getByTestId('ai-forget-key')).toBeVisible()
  await expect(page.getByTestId('ai-privacy')).toHaveText('Your key is sent only to api.anthropic.com. 3Dica has no server.')
  await expect(page.getByTestId('ai-remember')).not.toBeChecked() // off until the user chooses it
  // the hint names the site the page runs on; the manual shows the hosted app's, not this run's localhost port
  const hint = page.getByTestId('ai-remember-hint')
  await expect(hint).toContainText(new URL(page.url()).host)
  await hint.evaluate((el) => { el.textContent = el.textContent!.replace(location.host, 'feiteira.github.io') })
  await page.locator('.ai-title').click() // nothing focused: no focus ring in the shot
  await parkPointer(page)
  await shot(page, 'chat-settings', await columnDownTo(page, page.locator('.ai-actions')))
})

const PLATE_CODE = [
  'const { width, depth, thickness, hole } = params',
  'const plate = cuboid({ size: [width, depth, thickness], center: [0, 0, thickness / 2] })',
  'const bore = cylinder({ radius: hole / 2, height: thickness + 2, center: [0, 0, thickness / 2], segments: 48 })',
  'return subtract(plate, bore)',
].join('\n')

const PLATE_PARAMS = [
  { name: 'width', type: 'number', default: 40, min: 5, max: 200, step: 1 },
  { name: 'depth', type: 'number', default: 30, min: 5, max: 200, step: 1 },
  { name: 'thickness', type: 'number', default: 5, min: 1, max: 20, step: 0.5 },
  { name: 'hole', type: 'number', default: 6, min: 1, max: 20, step: 0.5 },
]

test('chat-conversation', async ({ page }) => {
  await mockAnthropic(page, (n) => {
    if (n === 1) {
      return turn(1, [
        ...thinking(0, 'One code object with width, depth, thickness and hole parameters: a cuboid minus a cylinder. Then a screenshot to check it.'),
        ...text(1, "I'll make it as one code object with parameters, then check it."),
        ...toolUse(2, 'toolu_docs_1', 'create_object', { kind: 'code', name: 'Plate with hole', params: PLATE_PARAMS, code: PLATE_CODE }),
      ], 'tool_use', { input: 160, cacheWrite: 7240, cacheRead: 0, output: 410 })
    }
    if (n === 2) return turn(2, toolUse(0, 'toolu_docs_2', 'screenshot', { view: 'multi' }), 'tool_use', { input: 12, cacheWrite: 520, cacheRead: 7240, output: 60 })
    return turn(3, text(0,
      'Done. **Plate with hole** is 40 × 30 × 5 mm with a 6 mm hole through the middle, and the screenshot matches.\n\n',
      '- parameters `width`, `depth`, `thickness` and `hole`, so you can resize it in the inspector\n',
      '- one undo step: *AI: Add Plate with hole*\n\n',
      'Want the corners rounded too?'), 'end_turn', { input: 10, cacheWrite: 690, cacheRead: 7760, output: 140 })
  })
  await boot(page)
  await newProject(page)
  await setUpAnthropic(page)
  await send(page, 'Make a 40 × 30 × 5 mm plate with a 6 mm hole in the middle')

  const cards = page.getByTestId('chat-tool')
  await expect(cards).toHaveCount(2)
  await chatIdle(page)
  await expect(cards.nth(0)).toHaveAttribute('data-status', 'ok')
  await expect(cards.nth(0).locator('.tool-sum')).toContainText('40 × 30 × 5 mm')
  await expect(cards.nth(1)).toHaveAttribute('data-status', 'ok')
  await expect(page.getByTestId('chat-thumb')).toHaveCount(1)
  await expect(page.locator('.chat-assistant').last()).toContainText('Want the corners rounded too?')
  const past = await page.evaluate(() => (window as any).__3dica.history().past as string[])
  expect(past[past.length - 1]).toBe('AI: Add Plate with hole')

  // keyboard back to the app (Esc leaves the message box), then Home frames the new part; step back so it sits on the grid
  await page.getByTestId('chat-input').press('Escape')
  await page.keyboard.press('Home')
  await page.waitForTimeout(350)
  await settle(page)
  await wheelZoom(page, 700)
  await shot(page, 'chat-conversation')
  await shot(page, 'chat-panel', right(page)) // the same conversation, just the column (interface reference)
})

test('chat-confirm', async ({ page }) => {
  await mockAnthropic(page, (n) => n === 1
    ? turn(1, [
        ...text(0, 'A new project replaces this one, so the app asks you first.'),
        ...toolUse(1, 'toolu_docs_3', 'new_project', { name: 'Bracket v2' }),
      ], 'tool_use', { input: 140, cacheWrite: 7240, cacheRead: 0, output: 70 })
    : turn(2, text(0, 'OK, I left the project as it is.'), 'end_turn', { input: 12, cacheWrite: 60, cacheRead: 7240, output: 12 }))
  await boot(page)
  await setUpAnthropic(page)
  await send(page, 'Start over with an empty project called Bracket v2')
  const card = page.getByTestId('chat-confirm')
  await expect(card).toBeVisible()
  await expect(card).toContainText('This can\'t be undone: the AI wants to replace the current project with an empty one (name: "Bracket v2")')
  await page.getByTestId('chat-approve').blur()
  await parkPointer(page)
  await shot(page, 'chat-confirm', await columnDownTo(page, card))
  // decline: the project stays
  await page.getByTestId('chat-decline').click()
  await chatIdle(page)
  await expect(page.locator('.chat-assistant').last()).toContainText('I left the project as it is')
  expect(await page.evaluate(() => (window as any).__3dica.project().name)).toBe('Bracket kit')
})
