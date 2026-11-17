// The Anthropic adapter (src/agent/providers/anthropic.ts), driven through the real @anthropic-ai/sdk by a mock fetch
// that answers with recorded-shape SSE streams. No request ever leaves the process.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildParams, createAnthropicAdapter, effortFor, echoContent, supportsAdaptive, usesFallbacks,
} from '../../src/agent/providers/anthropic'
import { presetById } from '../../src/agent/providers/presets'
import { ProviderError, type AgentTool, type ProviderConfig, type TurnEvent } from '../../src/agent/types'
import { describeError } from '../../src/agent/loop'

const KEY = 'sk-ant-api03-TESTKEY-not-real-0123456789abcdef'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk'

// ── mock fetch ──────────────────────────────────────────────────────────────────────────────────────────────────

interface Call { url: string; method: string; headers: Record<string, string>; body: any; raw: string }
type Reply = (call: Call, signal: AbortSignal | undefined) => Response | Promise<Response>

function mockFetch(reply: Reply) {
  const calls: Call[] = []
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v })
    const raw = typeof init?.body === 'string' ? init.body : ''
    const call = { url, method: init?.method ?? 'GET', headers, body: raw ? JSON.parse(raw) : undefined, raw }
    calls.push(call)
    return reply(call, init?.signal ?? undefined)
  }
  return { fetch: fn as typeof fetch, calls, messages: () => calls.filter((c) => c.url.includes('/v1/messages')) }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-should-retry': 'false', ...headers } })

const encode = (events: any[]) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
const sse = (events: any[]) => new Response(encode(events), { status: 200, headers: { 'content-type': 'text/event-stream' } })

// ── recorded-shape events ───────────────────────────────────────────────────────────────────────────────────────

const start = (model = 'claude-opus-5-5') => ({
  type: 'message_start',
  message: {
    id: 'msg_01', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, stop_details: null,
    usage: { input_tokens: 120, output_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 0 },
  },
})
const text = (index: number, ...parts: string[]) => [
  { type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: null } },
  ...parts.map((t) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } })),
  { type: 'content_block_stop', index },
]
const thinking = (index: number, parts: string[], signature = 'sig-abc') => [
  { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } },
  ...parts.map((t) => ({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: t } })),
  { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } },
  { type: 'content_block_stop', index },
]
const toolStart = (index: number, id: string, name: string) => ({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } })
const toolDelta = (index: number, partial_json: string) => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } })
const blockStop = (index: number) => ({ type: 'content_block_stop', index })
const tool = (index: number, id: string, name: string, ...fragments: string[]) => [toolStart(index, id, name), ...fragments.map((f) => toolDelta(index, f)), blockStop(index)]
const end = (stop_reason: string, stop_details: unknown = null) => [
  { type: 'message_delta', delta: { stop_reason, stop_sequence: null, stop_details }, usage: { output_tokens: 42 } },
  { type: 'message_stop' },
]

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────

const preset = presetById('anthropic')!
const config = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  preset, baseUrl: preset.baseUrl, apiKey: KEY, model: 'claude-opus-5-5', vision: true, ...over,
})
const fakeTool = (name: string): AgentTool => ({
  name, description: `${name} tool`, readOnly: true, needsConfirm: false,
  inputSchema: { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false },
  validate: (input) => ({ ok: true, value: input as Record<string, unknown> }),
  run: async () => ({ text: 'ok' }),
})
const TOOLS = [fakeTool('get_scene'), fakeTool('create_object')]

/** Answers the Models API lookup (max output 128000) and the given SSE streams for /v1/messages, in order. */
function server(...streams: any[][]) {
  let n = 0
  return mockFetch((call) => {
    if (call.url.includes('/v1/models/')) return json(200, { type: 'model', id: decodeURIComponent(call.url.split('/v1/models/')[1].split('?')[0]), max_tokens: 128000, created_at: '2026-01-01T00:00:00Z' })
    const s = streams[n++]
    if (!s) throw new Error('no more streams')
    return sse(s)
  })
}

async function turn(session: ReturnType<ReturnType<typeof createAnthropicAdapter>['createSession']>, signal = new AbortController().signal) {
  const events: TurnEvent[] = []
  const result = await session.runTurn({ system: 'You are the 3Dica assistant.', tools: TOOLS, signal, onEvent: (e) => events.push(e) })
  return { result, events }
}

async function rejection(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError)
    return err as ProviderError
  }
  throw new Error('expected a rejection')
}

beforeEach(() => {
  // the SDK reads these in Node (never in the browser); keep the tests independent of the shell
  vi.stubEnv('ANTHROPIC_BASE_URL', '')
  vi.stubEnv('ANTHROPIC_API_KEY', '')
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '')
})
afterEach(() => vi.unstubAllEnvs())

// ── tests ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe('anthropic: request shape', () => {
  it('a text-only turn: streamed text, usage, and the documented request for claude-opus-5-5', async () => {
    const srv = server([start(), ...text(0, 'Hello', ' world'), ...end('end_turn')])
    const s = createAnthropicAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('Hi')
    const { result, events } = await turn(s)
    expect(result).toMatchObject({ stop: 'end', text: 'Hello world', toolCalls: [], model: 'claude-opus-5-5' })
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 42, cacheReadTokens: 0, cacheWriteTokens: 100 })
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta)).toEqual(['Hello', ' world'])
    expect(events.at(-1)).toMatchObject({ type: 'usage' })

    const [lookup, req] = srv.calls
    expect(lookup.url).toBe('https://api.anthropic.com/v1/models/claude-opus-5-5')
    expect(req.url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages/)
    expect(req.method).toBe('POST')
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`) // SDK 1.x sends the API key as a bearer token
    expect(req.headers['anthropic-dangerous-direct-browser-access']).toBe('true')
    expect(req.headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01')
    const b = req.body
    expect(b.model).toBe('claude-opus-5-5')
    expect(b.stream).toBe(true)
    expect(b.max_tokens).toBe(64000)
    expect(b.cache_control).toEqual({ type: 'ephemeral' })
    expect(b.system).toEqual([{ type: 'text', text: 'You are the 3Dica assistant.' }])
    expect(b.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(b.output_config).toEqual({ effort: 'medium' })
    expect(b.fallbacks).toBe('default')
    expect(b.tool_choice).toBeUndefined()
    // tools sorted by name (a stable prefix for the cache), eager input streaming on
    expect(b.tools.map((t: any) => t.name)).toEqual(['create_object', 'get_scene'])
    expect(b.tools[0]).toEqual({ name: 'create_object', description: 'create_object tool', input_schema: TOOLS[1].inputSchema, eager_input_streaming: true })
    expect(b.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }])
  })

  it('claude-haiku-4-5 gets a plain request: no thinking, effort, fallbacks or beta header', async () => {
    const srv = server([start('claude-haiku-4-5'), ...text(0, 'ok'), ...end('end_turn')])
    const s = createAnthropicAdapter({ fetch: srv.fetch }).createSession(config({ model: 'claude-haiku-4-5', effort: 'high' }))
    s.addUser('Hi')
    await turn(s)
    const req = srv.messages()[0]
    expect(req.body.thinking).toBeUndefined()
    expect(req.body.output_config).toBeUndefined()
    expect(req.body.fallbacks).toBeUndefined()
    expect(req.headers['anthropic-beta']).toBeUndefined()
    expect(req.body.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('max_tokens is clamped to the output cap from the Models API, looked up once', async () => {
    let lookups = 0
    let n = 0
    const streams = [[start('claude-3-haiku'), ...text(0, 'a'), ...end('end_turn')], [start('claude-3-haiku'), ...text(0, 'b'), ...end('end_turn')]]
    const srv = mockFetch((call) => {
      if (call.url.includes('/v1/models/')) { lookups++; return json(200, { id: 'claude-3-haiku', max_tokens: 4096 }) }
      return sse(streams[n++])
    })
    const s = createAnthropicAdapter({ fetch: srv.fetch }).createSession(config({ model: 'claude-3-haiku' }))
    s.addUser('a')
    await turn(s)
    s.addUser('b')
    await turn(s)
    expect(lookups).toBe(1)
    expect(srv.messages().map((c) => c.body.max_tokens)).toEqual([4096, 4096])
  })

  it('model rules: adaptive thinking + effort on 4.6+, fallbacks only on the listed models', () => {
    for (const m of ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-5-5', 'claude-fable-5-2', 'claude-fable-5', 'claude-mythos-5-2']) {
      expect(supportsAdaptive(m), m).toBe(true)
    }
    for (const m of ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929', 'claude-opus-4-1-20250805', 'claude-opus-4-20250514', 'claude-3-7-sonnet-20250219', 'claude-3-haiku-20240307', 'my-proxy-model']) {
      expect(supportsAdaptive(m), m).toBe(false)
    }
    // platform.claude.com refusals-and-fallback: every Fable model, Opus 5 / 5.5 and Sonnet 5.5; not Haiku 5.5
    expect(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-2', 'claude-fable-5-1', 'claude-fable-5', 'claude-sonnet-5-5'].every(usesFallbacks)).toBe(true)
    expect(buildParams(config({ model: 'claude-fable-5' }), { system: '', tools: [] }, [], 64000)).toMatchObject({ betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    expect(['claude-opus-4-8', 'claude-haiku-5-5', 'claude-sonnet-5', 'claude-haiku-4-5'].some(usesFallbacks)).toBe(false)
    expect(effortFor('claude-opus-5-5', undefined)).toBe('medium')
    expect(effortFor('claude-opus-5-5', 'max')).toBe('max')
    expect(effortFor('claude-opus-4-6', 'xhigh')).toBe('high') // xhigh arrived with 4.7
    expect(effortFor('claude-opus-4-7', 'xhigh')).toBe('xhigh')
    const p = buildParams(config({ model: 'claude-sonnet-4-6', effort: 'low' }), { system: '', tools: [] }, [], 64000)
    expect(p).toMatchObject({ thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'low' } })
    expect(p).not.toHaveProperty('fallbacks')
    expect(p).not.toHaveProperty('betas')
    expect(p).not.toHaveProperty('system')
    expect(p).not.toHaveProperty('tools')
  })

  it('never sends sampling parameters, a thinking budget, disabled thinking or a forced tool_choice', async () => {
    for (const model of ['claude-opus-5-5', 'claude-haiku-4-5']) {
      for (const effort of [undefined, 'low', 'max'] as const) {
        const srv = server(
          [start(model), ...tool(0, 'toolu_1', 'get_scene', '{}'), ...end('tool_use')],
          [start(model), ...text(0, 'done'), ...end('end_turn')],
        )
        const s = createAnthropicAdapter({ fetch: srv.fetch }).createSession(config({ model, effort }))
        s.addUser('go')
        const { result } = await turn(s)
        s.addToolResults(result.toolCalls.map((call) => ({ call, output: { text: '{}' } })))
        await turn(s)
        expect(srv.messages()).toHaveLength(2)
        for (const c of srv.messages()) {
          for (const banned of ['"temperature"', '"top_p"', '"top_k"', '"budget_tokens"', '"disabled"', '"tool_choice"']) expect(c.raw).not.toContain(banned)
        }
      }
    }
  })
})

describe('anthropic: streaming and tool calls', () => {
  it('one tool call: start + partial JSON events, the input parsed strictly', async () => {
    const srv = server([start(), ...text(0, 'Let me look.'), ...tool(1, 'toolu_1', 'get_scene', '{"na', 'me": "Bo', 'x"}'), ...end('tool_use')])
    const s = createAnthropicAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('What is in the scene?')
    const { result, events } = await turn(s)
    expect(result.stop).toBe('tool_use')
    expect(result.text).toBe('Let me look.')
    expect(result.toolCalls).toEqual([{ id: 'toolu_1', name: 'get_scene', input: { name: 'Box' } }])
    expect(events.filter((e) => e.type === 'tool_start' || e.type === 'tool_input')).toEqual([
      { type: 'tool_start', id: 'toolu_1', name: 'get_scene' },
      { type: 'tool_input', id: 'toolu_1', partialJson: '{"na' },
      { type: 'tool_input', id: 'toolu_1', partialJson: '{"name": "Bo' },
      { type: 'tool_input', id: 'toolu_1', partialJson: '{"name": "Box"}' },
    ])
  })

  it('two parallel tool calls, in call order', async () => {
    const srv = server([start(), ...tool(0, 'toolu_a', 'get_scene', '{}'), ...tool(1, 'toolu_b', 'create_object', '{"name":', '"Cup"}'), ...end('tool_use')])
    const s = createAnthropicAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('go')
    const { result } = await turn(s)
    expect(result.toolCalls).toEqual([
      { id: 'toolu_a', name: 'get_scene', input: {} },
      { id: 'toolu_b', name: 'create_object', input: { name: 'Cup' } },
    ])
  })

  it('thinking deltas stream as thinking events; the thinking block goes back verbatim with its signature', async () => {
    const srv = server(
      [start(), ...thinking(0, ['Planning', ' the cube.']), ...text(1, 'Done.'), ...end('end_turn')],
      [start(), ...text(0, 'Next.'), ...end('end_turn')],
    )
    const s = createAnthropicAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('a')
    const { events } = await turn(s)
    expect(events.filter((e) => e.type === 'thinking')).toEqual([{ type: 'thinking', delta: 'Planning' }, { type: 'thinking', delta: ' the cube.' }])
    s.addUser('b')
    await turn(s)
    const assistant = srv.messages()[1].body.messages[1]
    expect(assistant.role).toBe('assistant')
    expect(assistant.content[0]).toEqual({ type: 'thinking', thinking: 'Planning the cube.', signature: 'sig-abc' })
    expect(assistant.content[1]).toMatchObject({ type: 'text', text: 'Done.' })
  })

  it('tool results with a screenshot: ONE user message, call order, text + image blocks, is_error', async () => {
    const srv = server(
      [start(), ...tool(0, 'toolu_a', 'screenshot', '{}'), ...tool(1, 'toolu_b', 'get_scene', '{}'), ...end('tool_use')],
      [start(), ...text(0, 'I see it.'), ...end('end_turn')],
    )
    const s = createAnthropicAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('look')
    const { result } = await turn(s)
    // given out of order on purpose: the adapter sends them in call order
    s.addToolResults([
      { call: result.toolCalls[1], output: { text: '{"error":"nope"}', isError: true } },
      { call: result.toolCalls[0], output: { text: '{"views":1}', images: [{ mediaType: 'image/png', base64: PNG }] } },
    ])
    await turn(s)
    const msgs = srv.messages()[1].body.messages
    expect(msgs).toHaveLength(3)
    expect(msgs[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result', tool_use_id: 'toolu_a',
          content: [{ type: 'text', text: '{"views":1}' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }],
          is_error: false,
        },
        { type: 'tool_result', tool_use_id: 'toolu_b', content: [{ type: 'text', text: '{"error":"nope"}' }], is_error: true },
      ],
    })
  })

  it('with vision off, screenshots stay out of the request', async () => {
    const srv = server([start(), ...tool(0, 'toolu_a', 'screenshot', '{}'), ...end('tool_use')], [start(), ...text(0, 'ok'), ...end('end_turn')])
    const s = createAnthropicAdapter({ fetch: srv.fetch }).createSession(config({ vision: false }))
    s.addUser('look')
    const { result } = await turn(s)
    s.addToolResults([{ call: result.toolCalls[0], output: { text: 'shot', images: [{ mediaType: 'image/png', base64: PNG }] } }])
    await turn(s)
    expect(srv.messages()[1].body.messages[2].content[0].content).toEqual([{ type: 'text', text: 'shot' }])
  })

  it('history is append-only: every request starts with the previous request\'s messages, byte for byte', async () => {
    const srv = server(
      [start(), ...thinking(0, ['hmm']), ...text(1, 'Looking.'), ...tool(2, 'toolu_1', 'get_scene', '{"a":', '1}'), ...end('tool_use')],
      [start(), ...text(0, 'A cube.'), ...end('end_turn')],
      [start(), ...text(0, 'Sure.'), ...end('end_turn')],
    )
    const s = createAnthropicAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('scene?')
    const { result } = await turn(s)
    s.addToolResults([{ call: result.toolCalls[0], output: { text: '{"objects":["Cube"]}' } }])
    await turn(s)
    s.addUser('thanks')
    await turn(s)
    const reqs = srv.messages().map((c) => c.body.messages as unknown[])
    expect(reqs.map((m) => m.length)).toEqual([1, 3, 5])
    for (let i = 1; i < reqs.length; i++) {
      expect(JSON.stringify(reqs[i].slice(0, reqs[i - 1].length))).toBe(JSON.stringify(reqs[i - 1]))
    }
    // the system prompt and the tools are identical in every request (cache prefix)
    const prefixes = srv.messages().map((c) => JSON.stringify([c.body.system, c.body.tools]))
    expect(new Set(prefixes).size).toBe(1)
  })

  it('a turn stopped mid-stream rejects with "aborted" and is not appended', async () => {
    const ctl = new AbortController()
    let n = 0
    const srv = mockFetch((call, signal) => {
      if (call.url.includes('/v1/models/')) return json(200, { id: 'claude-opus-5-5', max_tokens: 128000 })
      if (n++ > 0) return sse([start(), ...text(0, 'again'), ...end('end_turn')])
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(encode([start(), { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Part' } }])))
          signal?.addEventListener('abort', () => c.error(new DOMException('The operation was aborted.', 'AbortError')))
        },
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const s = createAnthropicAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('hi')
    const err = await rejection(s.runTurn({
      system: 'S', tools: TOOLS, signal: ctl.signal,
      onEvent: (e) => { if (e.type === 'text') ctl.abort() },
    }))
    expect(err.kind).toBe('aborted')
    s.addUser('hello?')
    await turn(s)
    const msgs = srv.messages()[1].body.messages
    expect(msgs.map((m: any) => m.role)).toEqual(['user', 'user'])
  })

  it('max_tokens with a truncated tool input: the call is marked truncated, never runnable', async () => {
    const srv = server([start(), ...tool(0, 'toolu_1', 'create_object', '{"code": "cube({size: '), ...end('max_tokens')])
    const s = createAnthropicAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('make a cube')
    const { result } = await turn(s)
    expect(result.stop).toBe('max_tokens')
    expect(result.toolCalls).toEqual([{ id: 'toolu_1', name: 'create_object', input: undefined, inputError: 'truncated' }])
  })

  it('max_tokens after complete tool calls: only the call the reply ended in is truncated; the closed ones run', async () => {
    const srv = server([
      start(),
      ...tool(0, 'toolu_a', 'create_object', '{"kind":', '"cube"}'),
      ...tool(1, 'toolu_b', 'get_scene', '{}'),
      toolStart(2, 'toolu_c', 'create_object'), toolDelta(2, '{"code": "return cub'),
      ...end('max_tokens'),
    ])
    const s = createAnthropicAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('go')
    const { result } = await turn(s)
    expect(result.stop).toBe('max_tokens')
    expect(result.toolCalls).toEqual([
      { id: 'toolu_a', name: 'create_object', input: { kind: 'cube' } },
      { id: 'toolu_b', name: 'get_scene', input: {} },
      { id: 'toolu_c', name: 'create_object', input: undefined, inputError: 'truncated' },
    ])
    // a cut right after the block started: no input yet, which must not count as {} (it would run with defaults)
    const srv2 = server([start(), ...text(0, 'Sure.'), toolStart(1, 'toolu_d', 'undo'), ...end('max_tokens')])
    const s2 = createAnthropicAdapter({ fetch: srv2.fetch }).createSession(config())
    s2.addUser('go')
    expect((await turn(s2)).result.toolCalls).toEqual([{ id: 'toolu_d', name: 'undo', input: undefined, inputError: 'truncated' }])
  })

  it('invalid tool JSON: an inputError when the SDK could read it, a retryable error when it could not', async () => {
    const srv = server(
      [start(), ...tool(0, 'toolu_1', 'get_scene', '{"a": 1} trailing'), ...end('tool_use')],
      [start(), ...tool(0, 'toolu_2', 'get_scene', '{"a": 1,}'), ...end('tool_use')],
    )
    const s = createAnthropicAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('go')
    const { result } = await turn(s)
    expect(result.toolCalls[0]).toMatchObject({ id: 'toolu_1', input: undefined })
    expect(result.toolCalls[0].inputError).toMatch(/not valid JSON/)
    s.addToolResults([{ call: result.toolCalls[0], output: { text: 'Error: bad input', isError: true } }])
    const err = await rejection(turn(s))
    expect(err).toMatchObject({ kind: 'other', retryable: true })
  })

  it('refusal: stop "refusal" with the category and explanation; nothing is appended', async () => {
    const srv = server(
      [start(), ...text(0, 'Partial'), ...end('refusal', { type: 'refusal', category: 'cyber', explanation: 'This looks like malware.', fallback_credit_token: null, recommended_model: null })],
      [start(), ...text(0, 'ok'), ...end('end_turn')],
    )
    const s = createAnthropicAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('bad')
    const { result } = await turn(s)
    expect(result.stop).toBe('refusal')
    expect(result.toolCalls).toEqual([])
    expect(result.refusal).toBe('The model declined this request (cyber). This looks like malware.')
    s.addUser('something else')
    await turn(s)
    expect(srv.messages()[1].body.messages.map((m: any) => m.role)).toEqual(['user', 'user'])
  })

  it('pause_turn: stop "pause"; the next turn sends the history as is', async () => {
    const srv = server([start(), ...text(0, 'Working'), ...end('pause_turn')], [start(), ...text(0, ' on it.'), ...end('end_turn')])
    const s = createAnthropicAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('long job')
    const { result } = await turn(s)
    expect(result.stop).toBe('pause')
    const second = await turn(s)
    expect(second.result.stop).toBe('end')
    const msgs = srv.messages()[1].body.messages
    expect(msgs.map((m: any) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1].content[0]).toMatchObject({ type: 'text', text: 'Working' })
  })

  it('model_context_window_exceeded: stop "max_tokens" with a notice', async () => {
    const srv = server([start(), ...text(0, 'and so'), ...end('model_context_window_exceeded')])
    const s = createAnthropicAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('go')
    const { result } = await turn(s)
    expect(result.stop).toBe('max_tokens')
    expect(result.notice).toMatch(/context window/)
  })

  it('a server-side fallback: the answering model is reported and the declined attempt\'s thinking/tool_use are not echoed', async () => {
    const fallback = { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' }, trigger: { type: 'refusal', category: 'cyber' } }
    const srv = server(
      [
        start(),
        ...thinking(0, ['first try']),
        ...text(1, 'Partial answer'),
        ...tool(2, 'toolu_old', 'get_scene', '{}'),
        { type: 'content_block_start', index: 3, content_block: fallback }, blockStop(3),
        ...text(4, ' continued.'),
        ...tool(5, 'toolu_new', 'get_scene', '{"x":1}'),
        ...end('tool_use'),
      ],
      [start('claude-opus-4-8'), ...text(0, 'ok'), ...end('end_turn')],
    )
    const s = createAnthropicAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('go')
    const { result } = await turn(s)
    expect(result.model).toBe('claude-opus-4-8')
    expect(result.text).toBe('Partial answer continued.')
    expect(result.toolCalls).toEqual([{ id: 'toolu_new', name: 'get_scene', input: { x: 1 } }])
    s.addToolResults([{ call: result.toolCalls[0], output: { text: 'done' } }])
    await turn(s)
    const assistant = srv.messages()[1].body.messages[1]
    expect(assistant.content.map((b: any) => b.type)).toEqual(['text', 'fallback', 'text', 'tool_use'])
    expect(assistant.content[1]).toEqual(fallback)
    expect(srv.messages()[1].body.messages[2].content.map((b: any) => b.tool_use_id)).toEqual(['toolu_new'])
  })

  it('echoContent leaves content without a fallback block untouched', () => {
    const content = [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'text', text: 'x', citations: null }] as any
    expect(echoContent(content)).toBe(content)
  })

  it('tool calls the loop never answered get "not run" results before the next user message', async () => {
    const srv = server([start(), ...tool(0, 'toolu_1', 'get_scene', '{}'), ...end('tool_use')], [start(), ...text(0, 'ok'), ...end('end_turn')])
    const s = createAnthropicAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('go')
    await turn(s)
    s.addUser('never mind')
    await turn(s)
    const last = srv.messages()[1].body.messages[2]
    expect(last.role).toBe('user')
    expect(last.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true })
    expect(last.content[1]).toEqual({ type: 'text', text: 'never mind' })
  })
})

describe('anthropic: errors', () => {
  const errorBody = (type: string, message: string) => ({ type: 'error', error: { type, message }, request_id: 'req_1' })
  const failing = (status: number, body: unknown) => mockFetch((call) => (call.url.includes('/v1/models/') ? json(200, { id: 'm', max_tokens: 1000 }) : json(status, body)))

  it.each([
    [401, 'authentication_error', 'auth'],
    [403, 'permission_error', 'permission'],
    [404, 'not_found_error', 'not_found'],
    [429, 'rate_limit_error', 'rate_limit'],
    [500, 'api_error', 'server'],
    [529, 'overloaded_error', 'overloaded'],
    [400, 'invalid_request_error', 'bad_request'],
  ])('HTTP %i → %s → kind %s, without the key', async (status, type, kind) => {
    const srv = failing(status, errorBody(type, `something about ${KEY} went wrong`))
    const s = createAnthropicAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('hi')
    const err = await rejection(turn(s))
    expect(err.kind).toBe(kind)
    expect(err.status).toBe(status)
    expect(err.message).not.toContain(KEY)
    expect(err.message).not.toContain('TESTKEY')
  })

  it('the notice says it once: the error carries only the API\'s text, the loop writes the sentence around it', async () => {
    const cases: [number, string, string, string][] = [
      [429, 'rate_limit_error', 'Number of request tokens has exceeded your per-minute rate limit', 'Anthropic rate limit reached (Number of request tokens has exceeded your per-minute rate limit). Wait a moment, then try again.'],
      [500, 'api_error', 'Internal server error', 'Anthropic had a server error (500: Internal server error). Try again in a moment.'],
      [404, 'not_found_error', 'model: claude-opus-5-5', "Anthropic does not know the model 'claude-opus-5-5' (model: claude-opus-5-5). Pick another model in the chat settings."],
      [400, 'invalid_request_error', 'prompt is too long: 210000 tokens > 200000 maximum', 'The conversation is too long for this model. Start a new chat.'],
      [403, 'permission_error', 'Your API key does not have permission to use the specified resource.', 'Anthropic refused the request (Your API key does not have permission to use the specified resource.). The key may not be allowed to use this model, or the account may need credit.'],
    ]
    for (const [status, type, message, notice] of cases) {
      const srv = failing(status, errorBody(type, message))
      const s = createAnthropicAdapter({ fetch: srv.fetch }).createSession(config())
      s.addUser('hi')
      const err = await rejection(turn(s))
      expect(err.message).toBe(message)
      expect(describeError(err, config())).toBe(notice)
    }
  })

  it('a bad request explains itself with the API message', async () => {
    const srv = failing(400, errorBody('invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'))
    const s = createAnthropicAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('hi')
    const err = await rejection(turn(s))
    expect(err.kind).toBe('bad_request')
    expect(err.retryable).toBe(false)
    expect(err.message).toContain('credit balance is too low')
  })

  it('a network failure (how a CORS block looks) → network, retryable', async () => {
    const srv = mockFetch(() => { throw new TypeError('Failed to fetch') })
    const s = createAnthropicAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('hi')
    const err = await rejection(turn(s))
    expect(err).toMatchObject({ kind: 'network', retryable: true })
    expect(err.message).toContain('api.anthropic.com')
  }, 20000)

  it('an error event inside the stream (overloaded) → overloaded', async () => {
    const srv = server([start(), ...text(0, 'Hel'), { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])
    const s = createAnthropicAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('hi')
    const err = await rejection(turn(s))
    expect(err.kind).toBe('overloaded')
  })

  it('no key: a clear auth error before any request', async () => {
    const srv = server()
    const s = createAnthropicAdapter({ fetch: srv.fetch }).createSession(config({ apiKey: '  ' }))
    s.addUser('hi')
    const err = await rejection(turn(s))
    expect(err.kind).toBe('auth')
    expect(srv.calls).toHaveLength(0)
  })

  it('an already-aborted signal rejects at once', async () => {
    const srv = server()
    const s = createAnthropicAdapter({ fetch: srv.fetch }).createSession(config())
    const ctl = new AbortController()
    ctl.abort()
    const err = await rejection(turn(s, ctl.signal))
    expect(err.kind).toBe('aborted')
    expect(srv.calls).toHaveLength(0)
  })
})

describe('anthropic: listModels', () => {
  it('pages through the Models API, newest first, claude-opus-5-5 on top, and remembers each output cap', async () => {
    const page1 = { data: [
      { type: 'model', id: 'claude-haiku-4-5', created_at: '2025-10-01T00:00:00Z', max_tokens: 64000 },
      { type: 'model', id: 'claude-fable-5-2', created_at: '2026-10-01T00:00:00Z', max_tokens: 128000 },
    ], has_more: true, first_id: 'claude-haiku-4-5', last_id: 'claude-fable-5-2' }
    const page2 = { data: [
      { type: 'model', id: 'claude-opus-5-5', created_at: '2026-09-01T00:00:00Z', max_tokens: 2000 },
      { type: 'model', id: 'claude-sonnet-5-5', created_at: '2026-09-15T00:00:00Z', max_tokens: 128000 },
    ], has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-sonnet-5-5' }
    let lookups = 0
    const srv = mockFetch((call) => {
      if (/\/v1\/models\/[^?]/.test(call.url)) { lookups++; return json(200, { id: 'x', max_tokens: 1 }) }
      if (call.url.includes('/v1/models')) return json(200, call.url.includes('after_id') ? page2 : page1)
      return sse([start(), ...text(0, 'ok'), ...end('end_turn')])
    })
    const adapter = createAnthropicAdapter({ fetch: srv.fetch })
    const { model: _model, ...rest } = config()
    const ids = await adapter.listModels(rest)
    expect(ids).toEqual(['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-4-5'])
    expect(srv.calls[0].url).toContain('limit=100')
    expect(srv.calls[1].url).toContain('after_id=claude-fable-5-2')
    expect(srv.calls[0].headers.authorization).toBe(`Bearer ${KEY}`)
    // the cap from the list is used without another lookup
    const s = adapter.createSession(config())
    s.addUser('hi')
    await turn(s)
    expect(lookups).toBe(0)
    expect(srv.messages()[0].body.max_tokens).toBe(2000)
  })

  it('a bad key → auth, without the key in the message', async () => {
    const srv = mockFetch(() => json(401, { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` } }))
    const { model: _model, ...rest } = config()
    const err = await rejection(createAnthropicAdapter({ fetch: srv.fetch }).listModels(rest))
    expect(err.kind).toBe('auth')
    expect(err.message).not.toContain(KEY)
  })
})
