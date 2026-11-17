// The in-app AI chat end to end: the [Inspector] [Chat] tabs, the settings, and whole conversations against MOCKED
// providers (page.route answers https://api.anthropic.com and an OpenAI-compatible https://mock.example/v1 with
// recorded-shape SSE streams). No request leaves the machine and no real key is used. The model's tool calls run
// through the real loop and tools on the real app. Every test fails on page errors, like the other e2e files (a test
// that expects an HTTP error lists the browser's "Failed to load resource" line it allows).
import { test, expect, type Page, type Route } from '@playwright/test'
import fs from 'node:fs'

const KEY = 'sk-ant-e2e-FAKE-not-a-real-key-0123456789'
const OAI_BASE = 'https://mock.example/v1'

let errors: string[] = []
let consoleText: string[] = []
let allowed: RegExp[] = []

test.beforeEach(async ({ page }) => {
  errors = []
  consoleText = []
  allowed = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    consoleText.push(m.text())
    if (m.type() === 'error' && !m.text().includes('GPU stall due to ReadPixels')) errors.push(`console.error: ${m.text()}`)
  })
})

test.afterEach(() => {
  expect(errors.filter((e) => !allowed.some((re) => re.test(e))), 'page errors').toEqual([])
  expect(consoleText.filter((t) => t.includes(KEY)), 'the key in a console message').toEqual([])
})

async function boot(page: Page, query = '?fresh'): Promise<void> {
  await page.goto('/' + query)
  await page.waitForFunction(() => (window as any).__3dica?.ready === true)
  await page.evaluate(() => (window as any).__3dica.idle())
}

const history = (page: Page) => page.evaluate(() => (window as any).__3dica.history() as { past: string[]; future: string[] })
const projectName = (page: Page) => page.evaluate(() => (window as any).__3dica.project().name as string)
const chat = (page: Page) => page.locator('#chat')
const input = (page: Page) => page.getByTestId('chat-input')
const idleChat = (page: Page) => expect(chat(page)).toHaveAttribute('data-state', 'idle')

// ───────────────────────────── mock providers ─────────────────────────────

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-expose-headers': '*' }

/** Answer a CORS preflight (if the browser sends one through the route). */
async function preflight(route: Route): Promise<boolean> {
  const req = route.request()
  if (req.method() !== 'OPTIONS') return false
  await fulfill(route, { status: 204, headers: { ...CORS, 'access-control-allow-headers': req.headers()['access-control-request-headers'] ?? '*', 'access-control-max-age': '600' } })
  return true
}

/** route.fulfill that tolerates a request the page already gave up on (Save aborts a model-list fetch in flight). */
const fulfill = (route: Route, r: Parameters<Route['fulfill']>[0]) => route.fulfill(r).catch(() => {})

const json = (body: unknown, status = 200) => ({ status, headers: { ...CORS, 'content-type': 'application/json', 'x-should-retry': 'false' }, body: JSON.stringify(body) })
const stream = (body: string) => ({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body })

// Anthropic Messages SSE
type Ev = Record<string, unknown>
const sseA = (events: Ev[]) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
const aStart = (n: number): Ev => ({
  type: 'message_start',
  message: {
    id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, stop_details: null,
    usage: { input_tokens: 400 * n, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 7000 },
  },
})
const aText = (index: number, ...parts: string[]): Ev[] => [
  { type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: null } },
  ...parts.map((text) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })),
  { type: 'content_block_stop', index },
]
const aThinking = (index: number, text: string): Ev[] => [
  { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: text } },
  { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'sig-e2e' } },
  { type: 'content_block_stop', index },
]
const aTool = (index: number, id: string, name: string, input: unknown): Ev[] => {
  const s = JSON.stringify(input)
  const cut = Math.floor(s.length / 2)
  return [
    { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
    { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: s.slice(0, cut) } },
    { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: s.slice(cut) } },
    { type: 'content_block_stop', index },
  ]
}
const aEnd = (stop: string): Ev[] => [
  { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null, stop_details: null }, usage: { output_tokens: 120 } },
  { type: 'message_stop' },
]
const aTurn = (n: number, blocks: Ev[], stop: string) => sseA([aStart(n), ...blocks, ...aEnd(stop)])

const MODEL_INFO = { type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-09-01T00:00:00Z', max_tokens: 64000 }

/**
 * Mock api.anthropic.com: the models endpoints answer with one model; every POST /v1/messages is recorded and
 * answered by `turn(n)` (n = 1, 2, …): an SSE body, or a { status, body } error.
 */
async function mockAnthropic(page: Page, turn: (n: number, body: any) => string | { status: number; body: unknown }) {
  const requests: any[] = []
  await page.route('https://api.anthropic.com/**', async (route) => {
    if (await preflight(route)) return
    const req = route.request()
    const url = new URL(req.url())
    if (url.pathname === '/v1/models') return fulfill(route, json({ data: [MODEL_INFO], has_more: false, first_id: MODEL_INFO.id, last_id: MODEL_INFO.id }))
    if (url.pathname.startsWith('/v1/models/')) return fulfill(route, json(MODEL_INFO))
    if (url.pathname === '/v1/messages' && req.method() === 'POST') {
      const body = req.postDataJSON()
      requests.push(body)
      const r = turn(requests.length, body)
      return fulfill(route, typeof r === 'string' ? stream(r) : json(r.body, r.status))
    }
    return fulfill(route, json({ type: 'error', error: { type: 'not_found_error', message: 'not here' } }, 404))
  })
  return requests
}

// OpenAI Chat Completions SSE
const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) =>
  ({ id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created: 1_790_000_000, model: 'mock-model', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })
const sseO = (chunks: unknown[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'

async function mockOpenAI(page: Page, turn: (n: number, body: any) => string) {
  const requests: any[] = []
  await page.route('https://mock.example/**', async (route) => {
    if (await preflight(route)) return
    const req = route.request()
    const url = new URL(req.url())
    if (url.pathname === '/v1/models') return fulfill(route, json({ object: 'list', data: [{ id: 'mock-model', object: 'model', created: 1_780_000_000, owned_by: 'e2e' }] }))
    if (url.pathname === '/v1/chat/completions' && req.method() === 'POST') {
      const body = req.postDataJSON()
      requests.push(body)
      return fulfill(route, stream(turn(requests.length, body)))
    }
    return fulfill(route, json({ error: { message: 'not here' } }, 404))
  })
  return requests
}

// ───────────────────────────── UI helpers ─────────────────────────────

/** Open the chat settings (from the header), fill them, Save. */
async function configure(page: Page, opts: { preset?: string; key?: string; baseUrl?: string; model?: string; remember?: boolean; refresh?: boolean }) {
  if (!(await chat(page).isVisible())) await page.getByTestId('tab-chat').click()
  await page.getByTestId('chat-provider').click()
  await expect(page.getByTestId('ai-settings')).toBeVisible()
  if (opts.preset) await page.getByTestId('ai-preset').selectOption(opts.preset)
  if (opts.baseUrl !== undefined) await page.getByTestId('ai-base-url').fill(opts.baseUrl)
  if (opts.key !== undefined) await page.getByTestId('ai-key').fill(opts.key)
  if (opts.remember !== undefined) await page.getByTestId('ai-remember').setChecked(opts.remember)
  if (opts.refresh) await page.getByTestId('ai-models-refresh').click()
  if (opts.model !== undefined) await page.getByTestId('ai-model').fill(opts.model)
  await page.getByTestId('ai-save').click()
  await expect(page.getByTestId('ai-settings')).toBeHidden()
}

async function sendMessage(page: Page, text: string) {
  await input(page).fill(text)
  await input(page).press('Enter')
}

const toolCards = (page: Page) => page.getByTestId('chat-tool')
const lastUser = (body: any) => body.messages[body.messages.length - 1]

// ───────────────────────────── tests ─────────────────────────────

test('chat: tabs and Ctrl+L, Anthropic setup, a tool-using turn that changes the model, screenshot sent back', async ({ page }) => {
  const requests = await mockAnthropic(page, (n) => {
    if (n === 1) {
      return aTurn(1, [
        ...aThinking(0, 'A code object for the bracket, placed to the right.'),
        ...aText(1, 'I will create the ', 'bracket.'),
        ...aTool(2, 'toolu_c1', 'create_object', { kind: 'code', name: 'Bracket', code: 'return cuboid({ size: [40, 30, 5], center: [0, 0, 2.5] })', transform: { t: [120, 0, 0] } }),
      ], 'tool_use')
    }
    if (n === 2) return aTurn(2, aTool(0, 'toolu_c2', 'screenshot', { view: 'multi' }), 'tool_use')
    return aTurn(3, aText(0, 'Done: a 40 × 30 × 5 mm **Bracket** at x = 120.\n\n- one `code` object\n- checked in a [screenshot](https://example.com/shot)'), 'end_turn')
  })
  await boot(page)

  // the tabs: Inspector first; the Chat tab; Ctrl+L goes back and forth
  await expect(page.locator('#inspector')).toBeVisible()
  await expect(chat(page)).toBeHidden()
  await expect(page.getByTestId('tab-inspector')).toHaveAttribute('aria-selected', 'true')
  await page.getByTestId('tab-chat').click()
  await expect(chat(page)).toBeVisible()
  await expect(page.locator('#inspector')).toBeHidden()
  await page.keyboard.press('Control+l')
  await expect(page.locator('#inspector')).toBeVisible()
  await page.keyboard.press('Control+l')
  await expect(chat(page)).toBeVisible()
  // not set up yet: the empty state offers the setup, the composer is off, and Ctrl+L focused the setup button
  await expect(page.getByTestId('chat-setup')).toBeFocused()
  await expect(input(page)).toBeDisabled()
  await expect(page.getByTestId('chat-example').first()).toBeHidden()
  // arrow keys move between the tabs
  await page.getByTestId('tab-chat').focus()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('tab-inspector')).toBeFocused()
  await expect(page.locator('#inspector')).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(chat(page)).toBeVisible()

  // set up Anthropic: a key; the model list loads from the (mocked) Models API when the key field is left
  await page.getByTestId('chat-setup').click()
  await expect(page.getByTestId('ai-privacy')).toHaveText('Your key is sent only to api.anthropic.com. 3Dica has no server.')
  // remembering is the user's choice: off at first, and the hint names who else can read a remembered key
  await expect(page.getByTestId('ai-remember')).not.toBeChecked()
  await expect(page.getByTestId('ai-remember-hint')).toHaveText(`On: kept in this browser's local storage, which every page on ${new URL(page.url()).host} can read. Off: kept only until this tab closes.`)
  await page.getByTestId('ai-save').click()
  await expect(page.getByTestId('ai-key-error')).toContainText('Paste your Anthropic API key')
  await page.getByTestId('ai-key').fill(KEY)
  await page.getByTestId('ai-model').focus()
  await expect(page.getByTestId('ai-models-msg')).toContainText('1 model')
  await page.getByTestId('ai-save').click()
  await expect(page.getByTestId('chat-provider')).toHaveText('Anthropic · claude-opus-5-5')
  await expect(page.getByTestId('chat-provider')).toHaveAttribute('title', 'Anthropic · claude-opus-5-5 — chat settings') // a cut id can be read in full
  await expect(page.getByTestId('chat-example')).toHaveCount(4)
  await expect(page.getByTestId('chat-example').first()).toBeVisible()

  // Ctrl+L from the app: back to the Inspector, then the Chat with the message box focused
  await page.keyboard.press('Control+l')
  await expect(page.locator('#inspector')).toBeVisible()
  await page.keyboard.press('Control+l')
  await expect(input(page)).toBeFocused()

  // the message box grows with its text up to 8 lines, then scrolls
  const boxHeight = () => input(page).evaluate((el) => el.getBoundingClientRect().height)
  const one = await boxHeight()
  await input(page).fill('a\nb\nc')
  const three = await boxHeight()
  expect(three).toBeGreaterThan(one + 30)
  await input(page).fill(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'))
  expect(await boxHeight()).toBeLessThan(8 * 18 + 20)
  await input(page).press('Escape')
  await expect(input(page)).not.toBeFocused()
  await input(page).fill('')
  expect(await boxHeight()).toBeLessThan(one + 2)

  // Ctrl+Enter sends from the message box and never reaches the app's "Run code" shortcut
  await page.evaluate(() => window.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'Enter') (window as any).__ctrlEnterReachedApp = true }))
  await input(page).fill('Make a bracket next to the fixtures and check it')
  await input(page).press('Control+Enter')
  await expect(input(page)).toHaveValue('')
  await expect(page.locator('.chat-user')).toHaveText('Make a bracket next to the fixtures and check it')

  await expect(toolCards(page)).toHaveCount(2)
  await idleChat(page)
  expect(await page.evaluate(() => (window as any).__ctrlEnterReachedApp ?? false)).toBe(false)
  await expect(toolCards(page).nth(0)).toHaveAttribute('data-status', 'ok')
  await expect(toolCards(page).nth(1)).toHaveAttribute('data-status', 'ok')
  await expect(toolCards(page).nth(0).locator('.tool-name')).toHaveText('Create object')
  await expect(toolCards(page).nth(0).locator('.tool-sum')).toContainText("code 'Bracket'")
  await expect(toolCards(page).nth(0).locator('.tool-sum')).toContainText('40 × 30 × 5 mm')
  await expect(toolCards(page).nth(1).locator('.tool-name')).toHaveText('Screenshot')

  // the model changed: a new object in the Scene tree and the Library, one undo step "AI: …"
  await expect(page.locator('[data-testid="tree-row"] .row-name', { hasText: /^Bracket$/ })).toHaveCount(1)
  await expect(page.locator('[data-testid="lib-row"] .lib-name', { hasText: /^Bracket$/ })).toHaveCount(1)
  const past = (await history(page)).past
  expect(past[past.length - 1]).toMatch(/^AI: /)
  expect(past.filter((l) => l.startsWith('AI: '))).toHaveLength(1)

  // the transcript: thinking (collapsed), Markdown, a screenshot thumbnail that enlarges
  await expect(page.getByTestId('chat-thinking').first()).toBeVisible()
  await expect(page.getByTestId('chat-thinking').first()).not.toHaveAttribute('open', '')
  const final = page.locator('.chat-assistant').last()
  await expect(final.locator('strong')).toHaveText('Bracket')
  await expect(final.locator('li')).toHaveCount(2)
  await expect(final.locator('li code')).toHaveText('code')
  await expect(final.locator('a')).toHaveAttribute('href', 'https://example.com/shot')
  await expect(final.locator('a')).toHaveAttribute('rel', 'noopener noreferrer')
  await expect(final.locator('a')).toHaveAttribute('target', '_blank')
  const thumb = page.getByTestId('chat-thumb')
  await expect(thumb).toHaveCount(1)
  expect(await thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(768)
  await thumb.click()
  await expect(page.getByTestId('chat-shot-dialog')).toBeVisible()
  await page.getByTestId('chat-shot-close').click()
  await expect(page.getByTestId('chat-shot-dialog')).toHaveCount(0)
  await expect(page.getByTestId('chat-usage')).toHaveText(/context$/)

  // the details of a card; its select button selects the new object without leaving the Chat
  await toolCards(page).nth(0).locator('.tool-head').click()
  await expect(toolCards(page).nth(0).locator('.tool-details')).toContainText('"kind": "code"')
  await toolCards(page).nth(0).getByTestId('chat-tool-select').click()
  const sel = await page.evaluate(() => (window as any).__3dica.ui().selection)
  expect(sel.kind).toBe('occ')
  await expect(chat(page)).toBeVisible()

  // what went over the wire: three requests, append-only, tool results paired with their calls, the image sent back
  expect(requests).toHaveLength(3)
  const [r1, r2, r3] = requests
  expect(r1.messages).toHaveLength(1)
  expect(r1.messages[0].content[0].text).toContain('<app_state>')
  expect(r1.messages[0].content[0].text).toContain('Make a bracket next to the fixtures and check it')
  expect(r2.messages.slice(0, r1.messages.length)).toEqual(r1.messages)
  expect(r3.messages.slice(0, r2.messages.length)).toEqual(r2.messages)
  expect(r2.messages[1].role).toBe('assistant')
  expect(r2.messages[1].content.map((b: any) => b.type)).toEqual(['thinking', 'text', 'tool_use'])
  const res1 = lastUser(r2).content[0]
  expect(res1).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_c1', is_error: false })
  expect(JSON.parse(res1.content[0].text)).toMatchObject({ ok: true, definition: 'Bracket' })
  const res2 = lastUser(r3).content[0]
  expect(res2).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_c2' })
  expect(res2.content.some((b: any) => b.type === 'image' && b.source.media_type === 'image/png' && b.source.data.length > 1000)).toBe(true)
  // the request never carries the key in its body
  expect(JSON.stringify(requests)).not.toContain(KEY)
})

test('chat: OpenAI-compatible (Custom) — two interleaved tool calls both run; the screenshot follows as a user image', async ({ page }) => {
  const requests = await mockOpenAI(page, (n) => {
    if (n === 1) {
      return sseO([
        chunk({ role: 'assistant', content: 'Placing a block and looking from the top.' }),
        chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'create_object', arguments: '' } }] }),
        chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'screenshot', arguments: '' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"kind":"cube","name":"Block",' } }] }),
        chunk({ tool_calls: [{ index: 1, function: { arguments: '{"view":' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"transform":{"t":[0,90,0]}}' } }] }),
        chunk({ tool_calls: [{ index: 1, function: { arguments: '"top"}' } }] }),
        chunk({}, 'tool_calls'),
      ])
    }
    return sseO([chunk({ role: 'assistant', content: 'Both done: **Block** is in the scene.' }), chunk({}, 'stop')])
  })
  await boot(page)
  await page.getByTestId('tab-chat').click()
  await page.getByTestId('chat-setup').click()
  await page.getByTestId('ai-preset').selectOption('custom')
  await expect(page.getByTestId('ai-base-url')).toBeVisible()
  await page.getByTestId('ai-save').click()
  await expect(page.getByTestId('ai-base-url-error')).toContainText('base URL')
  await page.getByTestId('ai-base-url').fill('not a url')
  await page.getByTestId('ai-save').click()
  await expect(page.getByTestId('ai-base-url-error')).toContainText('full URL')
  await page.getByTestId('ai-base-url').fill(OAI_BASE)
  await expect(page.getByTestId('ai-privacy')).toHaveText('Requests go only to mock.example. 3Dica has no server.')
  await page.getByTestId('ai-models-refresh').click()
  await expect(page.getByTestId('ai-models-msg')).toContainText('1 model')
  await expect(page.getByTestId('ai-model')).toHaveValue('mock-model') // the first listed model, as the field was empty
  await expect(page.locator('datalist option')).toHaveCount(1)
  await page.getByTestId('ai-save').click()
  await expect(page.getByTestId('chat-provider')).toHaveText('Custom · mock-model')

  await sendMessage(page, 'Add a block and show me the top view')
  await expect(toolCards(page)).toHaveCount(2)
  await idleChat(page)
  await expect(toolCards(page).nth(0)).toHaveAttribute('data-status', 'ok')
  await expect(toolCards(page).nth(1)).toHaveAttribute('data-status', 'ok')
  await expect(page.locator('[data-testid="tree-row"] .row-name', { hasText: /^Block$/ })).toHaveCount(1)
  await expect(page.getByTestId('chat-thumb')).toHaveCount(1)
  await expect(page.locator('.chat-assistant').last().locator('strong')).toHaveText('Block')

  expect(requests).toHaveLength(2)
  const msgs = requests[1].messages
  const roles = msgs.map((m: any) => m.role)
  expect(roles).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'user'])
  expect(msgs[2].tool_calls.map((c: any) => [c.id, c.function.name])).toEqual([['call_a', 'create_object'], ['call_b', 'screenshot']])
  expect(JSON.parse(msgs[2].tool_calls[0].function.arguments)).toEqual({ kind: 'cube', name: 'Block', transform: { t: [0, 90, 0] } })
  expect(msgs[3].tool_call_id).toBe('call_a')
  expect(msgs[4].tool_call_id).toBe('call_b')
  expect(msgs[5].content.some((p: any) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,'))).toBe(true)
  expect(requests[1].messages.slice(0, requests[0].messages.length)).toEqual(requests[0].messages)
})

test('chat: Stop during a streaming reply — idle again, the partial reply is never sent, the transcript says so', async ({ page }) => {
  // the first /v1/messages reply streams some text and then hangs until the request is aborted (route.fulfill
  // cannot hold a stream open, so this one comes from a fetch wrapper; everything else goes through page.route)
  await page.addInitScript(() => {
    const real = window.fetch.bind(window)
    let n = 0
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('api.anthropic.com/v1/messages') && n++ === 0) {
        const enc = new TextEncoder()
        const ev = (o: Record<string, unknown>) => enc.encode(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`)
        const signal = init?.signal
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(ev({ type: 'message_start', message: { id: 'msg_s', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }))
            c.enqueue(ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
            c.enqueue(ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A partial answer that must never be sent' } }))
            signal?.addEventListener('abort', () => c.error(new DOMException('The user aborted a request.', 'AbortError')))
          },
        })
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      return real(input, init)
    }
  })
  const requests = await mockAnthropic(page, (n) => aTurn(n, aText(0, 'Fine, starting over.'), 'end_turn'))
  await boot(page)
  await configure(page, { key: KEY })
  await sendMessage(page, 'Write a long story')
  await expect(page.locator('.chat-assistant')).toContainText('A partial answer')
  await expect(chat(page)).toHaveAttribute('data-state', 'running')
  await expect(page.getByTestId('chat-send')).toHaveAttribute('data-mode', 'stop')
  await expect(page.getByTestId('tab-chat').locator('.rtab-dot')).toHaveAttribute('data-state', 'busy')
  await page.getByTestId('chat-send').click()
  await idleChat(page)
  await expect(page.getByTestId('chat-send')).toHaveAttribute('data-mode', 'send')
  await expect(page.getByTestId('chat-notice').last()).toHaveText(/Stopped\./)
  await expect(page.getByTestId('chat-notice').last().getByTestId('chat-notice-action')).toHaveText('Continue')
  await expect(page.locator('.chat-assistant').first()).toHaveAttribute('data-streaming', 'false')
  await expect(page.getByTestId('tab-chat').locator('.rtab-dot')).toHaveAttribute('data-state', 'idle')

  await sendMessage(page, 'Never mind, say hi')
  await expect(page.locator('.chat-assistant .md').last()).toHaveText('Fine, starting over.')
  await idleChat(page)
  expect(requests).toHaveLength(1) // the hung request went to the fetch wrapper
  const sent = requests[0]
  expect(sent.messages.map((m: any) => m.role)).toEqual(['user', 'user'])
  expect(JSON.stringify(sent)).not.toContain('A partial answer')
  expect(JSON.stringify(sent)).toContain('Never mind, say hi')
})

test('chat: a rejected key shows an error notice with "Open settings"', async ({ page }) => {
  allowed = [/Failed to load resource: the server responded with a status of 401/]
  await mockAnthropic(page, () => ({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }))
  await boot(page)
  await configure(page, { key: KEY })
  await sendMessage(page, 'Hello')
  const notice = page.getByTestId('chat-notice').last()
  await expect(notice).toHaveAttribute('data-level', 'error')
  await expect(notice).toContainText('did not accept the API key')
  await expect(notice).not.toContainText(KEY)
  await idleChat(page)
  await expect(notice.locator('[data-action="retry"]')).toHaveCount(0) // the same key would fail the same way
  await notice.locator('[data-action="settings"]').click()
  await expect(page.getByTestId('ai-settings')).toBeVisible()
  await expect(page.getByTestId('ai-key')).toHaveValue(KEY)
  await page.getByTestId('ai-cancel').click()
  await expect(page.getByTestId('chat-log')).toBeVisible()
})

test('chat: an action that cannot be undone asks first — Decline tells the model, Approve runs it', async ({ page }) => {
  const requests = await mockAnthropic(page, (n) => {
    if (n === 1) return aTurn(1, aTool(0, 'toolu_n1', 'new_project', { name: 'Scratch' }), 'tool_use')
    if (n === 2) return aTurn(2, [...aText(0, 'Understood. Asking once more.'), ...aTool(1, 'toolu_n2', 'new_project', { name: 'Scratch' })], 'tool_use')
    return aTurn(3, aText(0, 'A fresh project named Scratch is open.'), 'end_turn')
  })
  await boot(page)
  await configure(page, { key: KEY })
  await sendMessage(page, 'Start a new project called Scratch')

  const confirm = page.getByTestId('chat-confirm')
  await expect(confirm).toHaveCount(1)
  await expect(confirm).toContainText("can't be undone")
  await expect(page.getByTestId('tab-chat').locator('.rtab-dot')).toHaveAttribute('data-state', 'attention')
  await confirm.and(page.locator('[data-state="pending"]')).getByTestId('chat-decline').click()
  await expect(confirm.first()).toHaveAttribute('data-state', 'declined')
  await expect(toolCards(page).first()).toHaveAttribute('data-status', 'declined')

  await expect(confirm).toHaveCount(2)
  expect(await projectName(page)).toBe('Bracket kit')
  const told = lastUser(requests[1]).content[0]
  expect(told).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_n1' })
  expect(told.content[0].text).toContain('declined')

  await confirm.and(page.locator('[data-state="pending"]')).getByTestId('chat-approve').click()
  await expect(confirm.last()).toHaveAttribute('data-state', 'approved')
  await idleChat(page)
  await expect(toolCards(page).last()).toHaveAttribute('data-status', 'ok')
  expect(await projectName(page)).toBe('Scratch')
  const ran = lastUser(requests[2]).content[0]
  expect(ran).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_n2', is_error: false })
  expect(ran.content[0].text).not.toContain('declined')
})

test('chat: the key stays in the key store — remembered or for this tab only — never in the project, autosave, files or the DOM', async ({ page }) => {
  await mockAnthropic(page, () => aTurn(1, aText(0, 'hi'), 'end_turn'))
  await boot(page)
  // remember off: sessionStorage only, survives a reload of this tab
  await configure(page, { key: KEY, remember: false })
  const stores = () => page.evaluate(() => {
    const dump = (s: Storage) => Object.fromEntries(Array.from({ length: s.length }, (_, i) => s.key(i)!).map((k) => [k, s.getItem(k)]))
    return { local: dump(localStorage), session: dump(sessionStorage) }
  })
  let s = await stores()
  expect(s.local['3dica:v1:ai-keys']).toBeUndefined()
  expect(Object.values(s.local).join('\n')).not.toContain(KEY)
  expect(s.session['3dica:v1:ai-keys']).toContain(KEY)
  await page.reload()
  await page.waitForFunction(() => (window as any).__3dica?.ready === true)
  await expect(chat(page)).toBeVisible() // the active tab is remembered
  await expect(page.getByTestId('chat-provider')).toHaveText('Anthropic · claude-opus-5-5')
  s = await stores()
  expect(Object.values(s.local).join('\n')).not.toContain(KEY)

  // remember on: moved to localStorage
  await configure(page, { remember: true })
  s = await stores()
  expect(s.local['3dica:v1:ai-keys']).toContain(KEY)
  expect(s.session['3dica:v1:ai-keys']).toBeUndefined()

  // an edit is autosaved, a chat turn runs, the project is saved: the key is in none of it
  await page.getByTestId('add-cube').click()
  await sendMessage(page, 'Say hi')
  await idleChat(page)
  await expect.poll(async () => (await stores()).local['3dica:v1:current'] ?? '', { timeout: 5000 }).toContain('Cube')
  s = await stores()
  for (const [k, v] of Object.entries(s.local)) if (k !== '3dica:v1:ai-keys') expect(v, k).not.toContain(KEY)
  expect(Object.values(s.session).join('\n')).not.toContain(KEY)
  const download = page.waitForEvent('download')
  await page.getByTestId('save').click()
  const file = await (await download).path()
  expect(fs.readFileSync(file, 'utf8')).not.toContain(KEY)

  // the settings form shows the key in its field, but never as an attribute
  await page.getByTestId('chat-provider').click()
  await expect(page.getByTestId('ai-key')).toHaveValue(KEY)
  await page.getByTestId('ai-key-toggle').click()
  await expect(page.getByTestId('ai-key')).toHaveAttribute('type', 'text')
  expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(KEY)
  expect(page.url()).not.toContain(KEY)

  // Forget key: gone from both storages; the chat asks for a key again
  await page.getByTestId('ai-forget-key').click()
  await expect(page.getByTestId('ai-key')).toHaveValue('')
  s = await stores()
  expect(JSON.stringify(s)).not.toContain(KEY)
  await page.getByTestId('ai-cancel').click()
  await expect(input(page)).toBeDisabled()
  await expect(page.getByTestId('chat-hint')).toContainText('Add your Anthropic API key')
})

test('chat: the Inspector works as before after switching tabs (fields, code editor sized); selecting keeps the tab', async ({ page }) => {
  await boot(page)
  await page.locator('[data-testid="tree-row"][data-path="i_fx1/i_plate"]').click()
  await expect(page.getByTestId('inspector-title')).toHaveText('Plate')
  await page.getByTestId('tab-chat').click()
  // selecting in the tree while the Chat shows does not switch tabs
  await page.locator('[data-testid="tree-row"][data-path="i_fx2"]').click()
  await expect(chat(page)).toBeVisible()
  await page.locator('[data-testid="tree-row"][data-path="i_fx1/i_plate"]').click()
  await expect(chat(page)).toBeVisible()
  await page.getByTestId('tab-inspector').click()
  await expect(page.getByTestId('inspector-title')).toHaveText('Plate')

  // the code editor re-measured: it fills its box and shows lines
  const host = await page.getByTestId('code-editor').boundingBox()
  const cm = await page.locator('.cm-editor').boundingBox()
  expect(host!.height).toBeGreaterThan(150)
  expect(cm!.height).toBeCloseTo(host!.height, 0)
  expect(cm!.width).toBeGreaterThan(300)
  expect(await page.locator('.cm-line').count()).toBeGreaterThan(2)
  await expect(page.locator('.cm-line').first()).toBeVisible()

  // a field still commits, and typing into the code editor still edits the code
  await page.getByTestId('inst-label').fill('Left plate')
  await page.getByTestId('inst-label').press('Enter')
  await expect(page.locator('[data-testid="tree-row"][data-path="i_fx1/i_plate"] .row-name')).toHaveText('Left plate')
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\n// edited after the tab switch')
  await page.evaluate(() => (window as any).__3dica.idle())
  const plate = await page.evaluate(() => Object.values((window as any).__3dica.project().defs).find((d: any) => d.name === 'Plate') as any)
  expect(plate.code).toContain('// edited after the tab switch')
  // Ctrl+L also works from inside the code editor
  await page.keyboard.press('Control+l')
  await expect(chat(page)).toBeVisible()
  await page.keyboard.press('Control+l')
  await expect(page.locator('#inspector')).toBeVisible()
})

// ───────────────────────────── review fixes ─────────────────────────────

test('chat: a tool call named like an Object member ("constructor") does not freeze the panel', async ({ page }) => {
  const requests = await mockAnthropic(page, (n) => (n === 1
    ? aTurn(1, aTool(0, 'toolu_x', 'constructor', {}), 'tool_use')
    : aTurn(2, aText(0, 'SECOND REPLY SHOULD BE VISIBLE'), 'end_turn')))
  await boot(page)
  await configure(page, { key: KEY })
  await sendMessage(page, 'Hello')
  await expect(page.locator('.chat-assistant').last()).toContainText('SECOND REPLY SHOULD BE VISIBLE')
  await idleChat(page)
  await expect(toolCards(page)).toHaveCount(1)
  await expect(toolCards(page).first()).toHaveAttribute('data-status', 'error')
  await expect(toolCards(page).first().locator('.tool-name')).toHaveText('constructor')
  expect(lastUser(requests[1]).content[0].content[0].text).toMatch(/^Unknown tool 'constructor'/)
  // the panel still renders: the send button is back
  await expect(page.getByTestId('chat-send')).toHaveAttribute('data-mode', 'send')
})

test('chat: Ctrl+L there and back returns the keyboard where it was, never to the page (Backspace must not delete)', async ({ page }) => {
  await boot(page)
  await page.locator('[data-testid="tree-row"][data-path="i_fx1/i_plate"]').click()
  await expect(page.getByTestId('inspector-title')).toHaveText('Plate')
  // from the code editor
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Control+l')
  await expect(chat(page)).toBeVisible()
  await page.keyboard.press('Control+l')
  await expect(page.locator('#inspector')).toBeVisible()
  await expect(page.locator('.cm-content')).toBeFocused()
  const before = (await history(page)).past.length
  await page.keyboard.type('\n// back in the editor')
  await page.keyboard.press('Backspace')
  await page.evaluate(() => (window as any).__3dica.idle())
  const plate = await page.evaluate(() => Object.values((window as any).__3dica.project().defs).find((d: any) => d.name === 'Plate') as any)
  expect(plate.code).toContain('// back in the edito')
  expect((await history(page)).past.slice(before).some((l) => /^Delete/.test(l))).toBe(false)
  await expect(page.locator('[data-testid="tree-row"][data-path="i_fx1/i_plate"]')).toHaveCount(1)
  // from an Inspector field
  await page.getByTestId('inst-label').focus()
  await page.keyboard.press('Control+l')
  await page.keyboard.press('Control+l')
  await expect(page.getByTestId('inst-label')).toBeFocused()
  // nothing to return to: the Inspector tab gets the keyboard
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Control+l')
  await page.keyboard.press('Control+l')
  await expect(page.getByTestId('tab-inspector')).toBeFocused()
})

test('chat: while a reply streams, its finished blocks keep their nodes — Copy and text selection work mid-stream', async ({ page }) => {
  await page.addInitScript(() => {
    const real = window.fetch.bind(window)
    let n = 0
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('api.anthropic.com/v1/messages') && n++ === 0) {
        const enc = new TextEncoder()
        const ev = (o: Record<string, unknown>) => enc.encode(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`)
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(ev({ type: 'message_start', message: { id: 'msg_s', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }))
            c.enqueue(ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
            c.enqueue(ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A first paragraph that the user wants to select.\n\n```js\nreturn cube()\n```\n\nThen ' } }))
            let i = 0
            const t = setInterval(() => {
              if ((window as any).__finishStream) {
                clearInterval(t)
                c.enqueue(ev({ type: 'content_block_stop', index: 0 }))
                c.enqueue(ev({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 50 } }))
                c.enqueue(ev({ type: 'message_stop' }))
                c.close()
                return
              }
              c.enqueue(ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `word${i++} ` } }))
            }, 15)
          },
        })
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      return real(input, init)
    }
  })
  await mockAnthropic(page, (n) => aTurn(n, aText(0, 'unused'), 'end_turn'))
  await boot(page)
  await configure(page, { key: KEY })
  await sendMessage(page, 'Show me some code')
  const reply = page.locator('.chat-assistant').first()
  await expect(reply.locator('.md-code')).toHaveCount(1)
  await expect(reply).toContainText('word3')
  await expect(reply).toHaveAttribute('data-streaming', 'true')
  // mark the nodes and count clicks on the button as it is now: a replaced node would lose both
  await page.evaluate(() => {
    const w = window as any
    w.__copyClicks = 0
    const code = document.querySelector('.chat-assistant .md-code') as HTMLElement
    code.dataset.mark = 'kept'
    code.querySelector('.md-copy')!.addEventListener('click', () => { w.__copyClicks++ })
    const p = document.querySelector('.chat-assistant .md p')!
    const r = document.createRange()
    r.selectNodeContents(p)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(r)
    w.__para = p
  })
  const box = (await reply.locator('.md-copy').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(150) // several deltas arrive between mousedown and mouseup
  await page.mouse.up()
  await expect(reply).toContainText('word12')
  const after = await page.evaluate(() => ({
    clicks: (window as any).__copyClicks,
    mark: (document.querySelector('.chat-assistant .md-code') as HTMLElement | null)?.dataset.mark,
    paraKept: (window as any).__para.isConnected,
    streaming: document.querySelector('.chat-assistant')?.getAttribute('data-streaming'),
  }))
  expect(after).toEqual({ clicks: 1, mark: 'kept', paraKept: true, streaming: 'true' })
  await page.evaluate(() => { (window as any).__finishStream = true })
  await idleChat(page)
  await expect(reply).toHaveAttribute('data-streaming', 'false')
})

test('chat: an approval is announced at once, the hint and the card say it waits for you, and focus returns to the box', async ({ page }) => {
  await mockAnthropic(page, (n) => (n === 1
    ? aTurn(1, aTool(0, 'toolu_n1', 'new_project', { name: 'Scratch' }), 'tool_use')
    : aTurn(2, aText(0, 'Kept your project.'), 'end_turn')))
  await boot(page)
  await configure(page, { key: KEY })
  await sendMessage(page, 'Start over')
  const card = page.getByTestId('chat-confirm')
  await expect(card).toHaveAttribute('data-state', 'pending')
  await expect(card).toHaveAttribute('role', 'group')
  await expect(card.locator('.confirm-msg')).toHaveText('This can\'t be undone: the AI wants to replace the current project with an empty one (name: "Scratch"). Save first if you want to keep it.')
  const labelled = await card.evaluate((el) => [document.getElementById(el.getAttribute('aria-labelledby')!)?.textContent, document.getElementById(el.getAttribute('aria-describedby')!)?.textContent])
  expect(labelled[0]).toBe('New project')
  expect(labelled[1]).toMatch(/^This can't be undone/)
  await expect(page.getByTestId('chat-log')).toHaveAttribute('aria-busy', 'false')
  await expect(page.getByTestId('chat-announce')).toHaveText(/^Approval needed: New project\. This can't be undone/)
  await expect(page.getByTestId('chat-hint').locator('span').first()).toHaveText('Waiting for your approval above.')
  await expect(toolCards(page).first().getByTestId('chat-tool-status')).toHaveText('waiting for you')
  // from the keyboard: Decline, and the keyboard is in the message box again (not on the page)
  await card.getByTestId('chat-decline').focus()
  await page.keyboard.press('Enter')
  await expect(card).toHaveAttribute('data-state', 'declined')
  await expect(input(page)).toBeFocused()
  await idleChat(page)
  await expect(page.getByTestId('chat-announce')).toHaveText('')
  expect(await projectName(page)).toBe('Bracket kit')
})

test('chat: the settings form keeps keys to itself — Esc closes it, Backspace on a checkbox deletes nothing', async ({ page }) => {
  await boot(page)
  await page.locator('[data-testid="tree-row"][data-path="i_fx1/i_plate"]').click()
  const sel = () => page.evaluate(() => JSON.stringify((window as any).__3dica.ui().selection))
  const selected = await sel()
  const before = (await history(page)).past.length
  await page.getByTestId('tab-chat').click()
  await page.getByTestId('chat-setup').click()
  await expect(page.getByTestId('ai-settings')).toBeVisible()
  await page.getByTestId('ai-remember').focus()
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Delete')
  await page.getByTestId('ai-vision').focus()
  await page.keyboard.press('h')
  expect((await history(page)).past.length).toBe(before)
  await expect(page.locator('[data-testid="tree-row"][data-path="i_fx1/i_plate"]')).toHaveCount(1)
  // Esc from a field and from a checkbox: Cancel, the 3D selection stays
  await page.getByTestId('ai-model').focus()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('ai-settings')).toBeHidden()
  await page.getByTestId('chat-setup').click()
  await page.getByTestId('ai-remember').focus()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('ai-settings')).toBeHidden()
  expect(await sel()).toBe(selected)
})

test('chat: no credentials in a base URL, and no key over plain http to another machine — not even before Save', async ({ page }) => {
  const plain: string[] = []
  await page.route('http://plain.example/**', async (route) => { plain.push(route.request().url()); await fulfill(route, json({ data: [] })) })
  await boot(page)
  await page.getByTestId('tab-chat').click()
  await page.getByTestId('chat-setup').click()
  await page.getByTestId('ai-preset').selectOption('custom')
  await page.getByTestId('ai-base-url').fill('https://user:s3cret-pass@mock.example/v1')
  await page.getByTestId('ai-model').fill('mock-model')
  await page.getByTestId('ai-save').click()
  await expect(page.getByTestId('ai-base-url-error')).toHaveText('Put the key in the API key field, not in the URL.')
  await page.getByTestId('ai-models-refresh').click()
  await expect(page.getByTestId('ai-models-msg')).toHaveText('Put the key in the API key field, not in the URL.')
  // a remote http server with a key: refused on Refresh and Save, and leaving the key field sends nothing
  await page.getByTestId('ai-base-url').fill('http://plain.example/v1')
  await page.getByTestId('ai-key').fill('sk-plain-FAKE-0123456789')
  await page.getByTestId('ai-model').focus()
  await page.getByTestId('ai-models-refresh').click()
  await expect(page.getByTestId('ai-models-msg')).toHaveText('Your key would be sent unencrypted. Use https://, or leave the key empty for a server on your network.')
  await page.getByTestId('ai-save').click()
  await expect(page.getByTestId('ai-base-url-error')).toHaveText('Your key would be sent unencrypted. Use https://, or leave the key empty for a server on your network.')
  expect(plain).toEqual([])
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))
  expect(stored).not.toContain('s3cret')
  expect(stored).not.toContain('sk-plain-FAKE')
  // without a key the same LAN-style server is fine (Refresh only)
  await page.getByTestId('ai-key').fill('')
  await page.getByTestId('ai-models-refresh').click()
  await expect.poll(() => plain.length).toBe(1)
})

test('chat: Retry only where it can help, said once; the same message again is a Retry, not a second copy', async ({ page }) => {
  allowed = [/Failed to load resource: the server responded with a status of (429|400)/]
  const requests = await mockAnthropic(page, (n) => {
    if (n === 1) return { status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' } } }
    if (n === 2) return aTurn(2, aText(0, 'Wider now.'), 'end_turn')
    return { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' } } }
  })
  await boot(page)
  await configure(page, { key: KEY })
  await sendMessage(page, 'Make the plate 10 mm wider')
  const notice = page.getByTestId('chat-notice').last()
  await expect(notice).toHaveText('Anthropic rate limit reached (Number of request tokens has exceeded your per-minute rate limit). Wait a moment, then try again.Retry')
  await expect(notice.getByTestId('chat-notice-action')).toHaveText(['Retry'])
  await idleChat(page)
  // the user sends it again instead of pressing Retry: one copy for the model, one on screen
  await sendMessage(page, 'Make the plate 10 mm wider')
  await expect(page.locator('.chat-assistant .md').last()).toHaveText('Wider now.')
  await idleChat(page)
  await expect(page.locator('.chat-user')).toHaveCount(1)
  expect(requests[1].messages).toHaveLength(1)
  expect(JSON.stringify(requests[1].messages).match(/Make the plate 10 mm wider/g)).toHaveLength(1)
  // a history that no longer fits: New chat, not Retry
  await sendMessage(page, 'And now the hole')
  const tooLong = page.getByTestId('chat-notice').last()
  await expect(tooLong).toContainText('The conversation is too long for this model. Start a new chat.')
  await expect(tooLong.getByTestId('chat-notice-action')).toHaveText(['New chat'])
  await tooLong.getByTestId('chat-notice-action').click()
  await expect(page.getByTestId('chat-empty')).toBeVisible()
  await expect(input(page)).toBeFocused()
})
