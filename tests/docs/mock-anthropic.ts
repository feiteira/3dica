// A mocked Anthropic API for the chat screenshots (chat.spec.ts). page.route answers https://api.anthropic.com with the
// shapes the real API sends: the model list, one model's info, and Messages streams (SSE). Nothing leaves the machine,
// no real key is used, and the shots come out the same on every run. The model's tool calls still run through the
// real chat loop and tools, so the scene, the tool cards and the screenshot thumbnail are the app's own.
import type { Page, Route } from '@playwright/test'

/** A made-up key: it only fills the password field (the mock never checks it). */
export const FAKE_KEY = 'sk-ant-docs-FAKE-not-a-real-key-0000000000'

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-expose-headers': '*' }

const fulfill = (route: Route, r: Parameters<Route['fulfill']>[0]) => route.fulfill(r).catch(() => {}) // the page may have given up on it
const json = (body: unknown) => ({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) })
const stream = (body: string) => ({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body })

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-opus-5'].map((id, i) => ({
  type: 'model', id, display_name: id, created_at: `2026-0${9 - i}-01T00:00:00Z`, max_tokens: 64000,
}))

type Ev = Record<string, unknown>

/** Token counts of one turn, as the API reports them (the chat header shows input + cache reads + cache writes). */
export interface Usage { input: number; cacheRead: number; cacheWrite: number; output: number }

/** Content blocks of one assistant turn. */
export const text = (index: number, ...parts: string[]): Ev[] => [
  { type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: null } },
  ...parts.map((t) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } })),
  { type: 'content_block_stop', index },
]
export const thinking = (index: number, t: string): Ev[] => [
  { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: t } },
  { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'sig-docs' } },
  { type: 'content_block_stop', index },
]
export const toolUse = (index: number, id: string, name: string, input: unknown): Ev[] => [
  { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
  { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
  { type: 'content_block_stop', index },
]

/** One whole streamed turn: message_start, the blocks, the stop reason. */
export function turn(n: number, blocks: Ev[], stop: 'end_turn' | 'tool_use', u: Usage): string {
  const events: Ev[] = [
    {
      type: 'message_start',
      message: {
        id: `msg_docs_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, stop_details: null,
        usage: { input_tokens: u.input, output_tokens: 1, cache_creation_input_tokens: u.cacheWrite, cache_read_input_tokens: u.cacheRead },
      },
    },
    ...blocks,
    { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null, stop_details: null }, usage: { output_tokens: u.output } },
    { type: 'message_stop' },
  ]
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

/** Route api.anthropic.com: the Models API, and POST /v1/messages answered by `reply(n)` for the n-th request (1, 2, …). */
export async function mockAnthropic(page: Page, reply: (n: number) => string): Promise<void> {
  let n = 0
  await page.route('https://api.anthropic.com/**', async (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') {
      return fulfill(route, { status: 204, headers: { ...CORS, 'access-control-allow-headers': req.headers()['access-control-request-headers'] ?? '*' } })
    }
    const path = new URL(req.url()).pathname
    if (path === '/v1/models') return fulfill(route, json({ data: MODELS, has_more: false, first_id: MODELS[0].id, last_id: MODELS[MODELS.length - 1].id }))
    if (path.startsWith('/v1/models/')) return fulfill(route, json(MODELS.find((m) => path.endsWith(`/${m.id}`)) ?? MODELS[0]))
    if (path === '/v1/messages' && req.method() === 'POST') return fulfill(route, stream(reply(++n)))
    return fulfill(route, { status: 404, headers: { ...CORS, 'content-type': 'application/json' }, body: '{"type":"error","error":{"type":"not_found_error","message":"not here"}}' })
  })
}
