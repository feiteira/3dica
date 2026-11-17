// The OpenAI-compatible adapter (src/agent/providers/openai-compatible.ts), driven through the real `openai` SDK by a
// mock fetch that answers with recorded-shape Chat Completions SSE streams. No request ever leaves the process.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildRequest, createOpenAICompatibleAdapter, isOpenAIReasoningModel, pickModels, reasoningEffortFor,
} from '../../src/agent/providers/openai-compatible'
import { presetById } from '../../src/agent/providers/presets'
import { ProviderError, type AgentTool, type ProviderConfig, type TurnEvent } from '../../src/agent/types'
import { ChatController, describeError } from '../../src/agent/loop'

const KEY = 'sk-proj-TESTKEY-not-real-0123456789abcdef'
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
  return { fetch: fn as typeof fetch, calls, chats: () => calls.filter((c) => c.url.endsWith('/chat/completions')) }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-should-retry': 'false' } })
const encode = (chunks: unknown[], done = true) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '')
const sse = (chunks: unknown[]) => new Response(encode(chunks), { status: 200, headers: { 'content-type': 'text/event-stream' } })

/** Answers each chat request with the next stream, in order. */
function server(...streams: unknown[][]) {
  let n = 0
  return mockFetch(() => {
    const s = streams[n++]
    if (!s) throw new Error('no more streams')
    return sse(s)
  })
}

// ── recorded-shape chunks ───────────────────────────────────────────────────────────────────────────────────────

const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null, model = 'test-model') => ({
  id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1790000000, model, choices: [{ index: 0, delta, finish_reason, logprobs: null }],
})
const say = (...parts: string[]) => [chunk({ role: 'assistant', content: '' }), ...parts.map((t) => chunk({ content: t }))]
const callStart = (index: number, id: string, name: string) => chunk({ tool_calls: [{ index, id, type: 'function', function: { name, arguments: '' } }] })
const callArgs = (index: number, args: string) => chunk({ tool_calls: [{ index, function: { arguments: args } }] })
const finish = (reason: string) => chunk({}, reason)
const usage = { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1790000000, model: 'test-model', choices: [], usage: { prompt_tokens: 300, completion_tokens: 25, total_tokens: 325, prompt_tokens_details: { cached_tokens: 256 } } }

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────

const config = (presetId = 'openai', over: Partial<ProviderConfig> = {}): ProviderConfig => {
  const preset = presetById(presetId)!
  return { preset, baseUrl: preset.baseUrl, apiKey: KEY, model: 'test-model', vision: true, ...over }
}
const fakeTool = (name: string): AgentTool => ({
  name, description: `${name} tool`, readOnly: true, needsConfirm: false,
  inputSchema: { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false },
  validate: (input) => ({ ok: true, value: input as Record<string, unknown> }),
  run: async () => ({ text: 'ok' }),
})
const TOOLS = [fakeTool('get_scene'), fakeTool('create_object')]

type Session = ReturnType<ReturnType<typeof createOpenAICompatibleAdapter>['createSession']>
async function turn(session: Session, signal = new AbortController().signal) {
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
  for (const v of ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'OPENAI_ADMIN_KEY']) vi.stubEnv(v, '')
})
afterEach(() => vi.unstubAllEnvs())

// ── tests ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe('openai-compatible: request shape', () => {
  it('a text-only turn on OpenAI: streamed text, usage, plain headers', async () => {
    const srv = server([...say('Hello', ' world'), finish('stop'), usage])
    const s = createOpenAICompatibleAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('Hi')
    const { result, events } = await turn(s)
    expect(result).toMatchObject({ stop: 'end', text: 'Hello world', toolCalls: [], model: 'test-model' })
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 25, cacheReadTokens: 256 })
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta)).toEqual(['Hello', ' world'])

    const [req] = srv.calls
    expect(req.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`)
    // only authorization + content-type need a CORS preflight; the SDK's telemetry headers are gone
    expect(Object.keys(req.headers).filter((h) => h.startsWith('x-stainless'))).toEqual([])
    expect(req.headers['openai-organization']).toBeUndefined()
    expect(req.body).toEqual({
      model: 'test-model',
      stream: true,
      messages: [{ role: 'system', content: 'You are the 3Dica assistant.' }, { role: 'user', content: 'Hi' }],
      tools: [
        { type: 'function', function: { name: 'create_object', description: 'create_object tool', parameters: TOOLS[1].inputSchema } },
        { type: 'function', function: { name: 'get_scene', description: 'get_scene tool', parameters: TOOLS[0].inputSchema } },
      ],
      stream_options: { include_usage: true },
    })
  })

  it('OpenRouter: attribution headers and usage; Groq: no stream_options; never temperature', async () => {
    const or = server([...say('ok'), finish('stop')])
    const s1 = createOpenAICompatibleAdapter({ fetch: or.fetch }).createSession(config('openrouter', { model: 'anthropic/claude-opus-5.5' }))
    s1.addUser('hi')
    await turn(s1)
    expect(or.calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(or.calls[0].headers['http-referer']).toBe('https://feiteira.github.io/3dica/')
    expect(or.calls[0].headers['x-title']).toBe('3Dica')
    expect(or.calls[0].body.stream_options).toEqual({ include_usage: true })

    const groq = server([...say('ok'), finish('stop')])
    const s2 = createOpenAICompatibleAdapter({ fetch: groq.fetch }).createSession(config('groq'))
    s2.addUser('hi')
    await turn(s2)
    expect(groq.calls[0].url).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(groq.calls[0].body.stream_options).toBeUndefined()
    expect(groq.calls[0].headers['http-referer']).toBeUndefined()
    for (const c of [...or.calls, ...groq.calls]) {
      for (const banned of ['"temperature"', '"top_p"', '"top_k"', '"tool_choice"', '"reasoning_effort"']) expect(c.raw).not.toContain(banned)
    }
  })

  it('reasoning_effort only where the preset/model takes it; xhigh and max map to high', () => {
    const tools = { system: '', tools: [] }
    expect(buildRequest(config('openai', { model: 'gpt-5.5', effort: 'xhigh' }), tools, [])).toMatchObject({ reasoning_effort: 'high' })
    expect(buildRequest(config('openai', { model: 'o3', effort: 'low' }), tools, [])).toMatchObject({ reasoning_effort: 'low' })
    expect(buildRequest(config('openai', { model: 'gpt-4.1', effort: 'high' }), tools, [])).not.toHaveProperty('reasoning_effort')
    expect(buildRequest(config('openai', { model: 'gpt-5.5' }), tools, [])).not.toHaveProperty('reasoning_effort') // effort unset
    expect(buildRequest(config('groq', { model: 'gpt-oss-120b', effort: 'high' }), tools, [])).not.toHaveProperty('reasoning_effort')
    expect(reasoningEffortFor(config('openrouter', { effort: 'max' }))).toBe('high')
    expect(reasoningEffortFor(config('openrouter', { effort: 'medium' }), ['tools', 'reasoning_effort'])).toBe('medium')
    expect(reasoningEffortFor(config('openrouter', { effort: 'medium' }), ['tools'])).toBeUndefined()
    expect(isOpenAIReasoningModel('gpt-5.2-chat')).toBe(false)
    expect(isOpenAIReasoningModel('gpt-4o')).toBe(false)
    expect(isOpenAIReasoningModel('gpt-6.1-sol')).toBe(true)
    expect(buildRequest(config(), { system: '', tools: [] }, [])).toEqual({ model: 'test-model', stream: true, messages: [], stream_options: { include_usage: true } })
  })

  it('local servers: no key needed (a placeholder is sent), the base URL from the settings', async () => {
    const srv = server([...say('ok'), finish('stop')])
    const s = createOpenAICompatibleAdapter({ fetch: srv.fetch }).createSession(config('ollama', { apiKey: '', baseUrl: 'http://localhost:11434/v1/' }))
    s.addUser('hi')
    await turn(s)
    expect(srv.calls[0].url).toBe('http://localhost:11434/v1/chat/completions')
    expect(srv.calls[0].headers.authorization).toBe('Bearer local')
  })

  it('a hosted preset without a key, or Custom without a base URL: a clear error before any request', async () => {
    const srv = server()
    const a = createOpenAICompatibleAdapter({ fetch: srv.fetch })
    const s1 = a.createSession(config('openai', { apiKey: '' }))
    s1.addUser('hi')
    expect((await rejection(turn(s1))).kind).toBe('auth')
    const s2 = a.createSession(config('custom', { baseUrl: '' }))
    s2.addUser('hi')
    const err = await rejection(turn(s2))
    expect(err.kind).toBe('other') // a setting, not a refusal by a server
    expect(err.message).toMatch(/base URL/)
    expect(srv.calls).toHaveLength(0)
  })
})

describe('openai-compatible: streaming and tool calls', () => {
  it('one tool call: id and name first, then argument fragments', async () => {
    const srv = server([chunk({ role: 'assistant', content: null }), callStart(0, 'call_1', 'get_scene'), callArgs(0, '{"na'), callArgs(0, 'me": "Box"}'), finish('tool_calls')])
    const s = createOpenAICompatibleAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('scene?')
    const { result, events } = await turn(s)
    expect(result.stop).toBe('tool_use')
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'get_scene', input: { name: 'Box' } }])
    expect(events.filter((e) => e.type === 'tool_start' || e.type === 'tool_input')).toEqual([
      { type: 'tool_start', id: 'call_1', name: 'get_scene' },
      { type: 'tool_input', id: 'call_1', partialJson: '{"na' },
      { type: 'tool_input', id: 'call_1', partialJson: '{"name": "Box"}' },
    ])
  })

  it('two parallel calls whose fragments interleave by index', async () => {
    const srv = server([
      callStart(0, 'call_a', 'get_scene'), callStart(1, 'call_b', 'create_object'),
      callArgs(1, '{"name"'), callArgs(0, '{'), callArgs(1, ': "Cup"}'), callArgs(0, '}'),
      finish('tool_calls'),
    ])
    const s = createOpenAICompatibleAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('go')
    const { result } = await turn(s)
    expect(result.toolCalls).toEqual([
      { id: 'call_a', name: 'get_scene', input: {} },
      { id: 'call_b', name: 'create_object', input: { name: 'Cup' } },
    ])
  })

  it('tool calls with finish_reason "stop" (some servers) still count as tool use', async () => {
    const srv = server([callStart(0, 'call_1', 'get_scene'), callArgs(0, '{}'), finish('stop')])
    const s = createOpenAICompatibleAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('go')
    expect((await turn(s)).result.stop).toBe('tool_use')
  })

  it('whole calls without index or id (Ollama-style) get their own slots and generated ids', async () => {
    const srv = server([
      chunk({ tool_calls: [{ function: { name: 'get_scene', arguments: '{}' } }, { id: 'x2', function: { name: 'create_object', arguments: '{"name":"A"}' } }] }),
      finish('tool_calls'),
    ])
    const s = createOpenAICompatibleAdapter({ fetch: srv.fetch }).createSession(config('ollama', { apiKey: '' }))
    s.addUser('go')
    const { result, events } = await turn(s)
    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'get_scene', input: {} },
      { id: 'x2', name: 'create_object', input: { name: 'A' } },
    ])
    expect(events.filter((e) => e.type === 'tool_start').map((e) => (e as { id: string }).id)).toEqual(['call_1', 'x2'])
  })

  it('two whole calls with neither index nor id stay two calls', async () => {
    const srv = server([
      chunk({ tool_calls: [{ function: { name: 'get_scene', arguments: '{}' } }, { function: { name: 'create_object', arguments: '{"name":"B"}' } }] }),
      finish('tool_calls'),
    ])
    const s = createOpenAICompatibleAdapter({ fetch: srv.fetch }).createSession(config('lmstudio', { apiKey: '' }))
    s.addUser('go')
    const { result } = await turn(s)
    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'get_scene', input: {} },
      { id: 'call_2', name: 'create_object', input: { name: 'B' } },
    ])
  })

  it('reasoning text (DeepSeek reasoning_content) streams as thinking and goes back with its turn (DeepSeek wants it in thinking mode with tools)', async () => {
    const srv = server(
      [chunk({ role: 'assistant', reasoning_content: 'Let me think' }), chunk({ reasoning_content: ' hard.' }), chunk({ content: 'Answer.' }), finish('stop')],
      [...say('ok'), finish('stop')],
    )
    const s = createOpenAICompatibleAdapter({ fetch: srv.fetch }).createSession(config('deepseek'))
    s.addUser('q')
    const { events } = await turn(s)
    expect(events.filter((e) => e.type === 'thinking')).toEqual([{ type: 'thinking', delta: 'Let me think' }, { type: 'thinking', delta: ' hard.' }])
    s.addUser('q2')
    await turn(s)
    expect(srv.calls[1].body.messages[2]).toEqual({ role: 'assistant', content: 'Answer.', reasoning_content: 'Let me think hard.' })
  })

  it('tool results with a screenshot: one tool message per call in call order, then ONE user message with the images', async () => {
    const srv = server(
      [callStart(0, 'call_a', 'screenshot'), callStart(1, 'call_b', 'get_scene'), callArgs(0, '{}'), callArgs(1, '{}'), finish('tool_calls')],
      [...say('I see it.'), finish('stop')],
    )
    const s = createOpenAICompatibleAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('look')
    const { result } = await turn(s)
    s.addToolResults([
      { call: result.toolCalls[1], output: { text: '{"error":"nope"}', isError: true } },
      { call: result.toolCalls[0], output: { text: '{"views":1}', images: [{ mediaType: 'image/png', base64: PNG }] } },
    ])
    await turn(s)
    const msgs = srv.calls[1].body.messages
    expect(msgs.slice(2)).toEqual([
      {
        role: 'assistant', content: null,
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'screenshot', arguments: '{}' } },
          { id: 'call_b', type: 'function', function: { name: 'get_scene', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_a', content: '{"views":1}' },
      { role: 'tool', tool_call_id: 'call_b', content: 'Error: {"error":"nope"}' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Screenshots returned by the tool calls above (in order).' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
        ],
      },
    ])
  })

  it('with vision off, no image message follows the tool results', async () => {
    const srv = server([callStart(0, 'call_a', 'screenshot'), callArgs(0, '{}'), finish('tool_calls')], [...say('ok'), finish('stop')])
    const s = createOpenAICompatibleAdapter({ fetch: srv.fetch }).createSession(config('openai', { vision: false }))
    s.addUser('look')
    const { result } = await turn(s)
    s.addToolResults([{ call: result.toolCalls[0], output: { text: 'shot', images: [{ mediaType: 'image/png', base64: PNG }] } }])
    await turn(s)
    expect(srv.calls[1].body.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call_a', content: 'shot' })
  })

  it('history is append-only: every request starts with the previous request\'s messages, byte for byte', async () => {
    const srv = server(
      [...say('Looking.'), callStart(0, 'call_1', 'get_scene'), callArgs(0, '{"a":'), callArgs(0, '1}'), finish('tool_calls')],
      [...say('A cube.'), finish('stop')],
      [...say('Sure.'), finish('stop')],
    )
    const s = createOpenAICompatibleAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('scene?')
    const { result } = await turn(s)
    s.addToolResults([{ call: result.toolCalls[0], output: { text: '{"objects":["Cube"]}' } }])
    await turn(s)
    s.addUser('thanks')
    await turn(s)
    const reqs = srv.calls.map((c) => c.body.messages as unknown[])
    expect(reqs.map((m) => m.length)).toEqual([2, 4, 6])
    for (let i = 1; i < reqs.length; i++) {
      expect(JSON.stringify(reqs[i].slice(0, reqs[i - 1].length))).toBe(JSON.stringify(reqs[i - 1]))
    }
    expect(reqs[1][2]).toEqual({
      role: 'assistant', content: 'Looking.',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_scene', arguments: '{"a":1}' } }],
    })
  })

  it('a turn stopped mid-stream rejects with "aborted" and is not appended', async () => {
    const ctl = new AbortController()
    let n = 0
    const srv = mockFetch((_call, signal) => {
      if (n++ > 0) return sse([...say('again'), finish('stop')])
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(encode(say('Part'), false)))
          signal?.addEventListener('abort', () => c.error(new DOMException('The operation was aborted.', 'AbortError')))
        },
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const s = createOpenAICompatibleAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('hi')
    const err = await rejection(s.runTurn({
      system: 'S', tools: TOOLS, signal: ctl.signal,
      onEvent: (e) => { if (e.type === 'text' && e.delta) ctl.abort() },
    }))
    expect(err.kind).toBe('aborted')
    s.addUser('hello?')
    await turn(s)
    expect(srv.calls[1].body.messages.map((m: any) => m.role)).toEqual(['system', 'user', 'user'])
  })

  it('finish_reason "length" with truncated arguments: the call is marked truncated; {} is stored', async () => {
    const srv = server([callStart(0, 'call_1', 'create_object'), callArgs(0, '{"code": "cube({size: '), finish('length')], [...say('ok'), finish('stop')])
    const s = createOpenAICompatibleAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('make a cube')
    const { result } = await turn(s)
    expect(result.stop).toBe('max_tokens')
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'create_object', input: undefined, inputError: 'truncated' }])
    s.addToolResults([{ call: result.toolCalls[0], output: { text: 'Error: truncated', isError: true } }])
    await turn(s)
    expect(srv.calls[1].body.messages[2].tool_calls[0].function.arguments).toBe('{}')
  })

  it('finish_reason "length" after complete calls: only the last call is truncated, the earlier ones run', async () => {
    const srv = server([
      callStart(0, 'call_a', 'get_scene'), callArgs(0, '{}'),
      callStart(1, 'call_b', 'create_object'), callArgs(1, '{"name":"B"}'),
      callStart(2, 'call_c', 'create_object'), callArgs(2, '{"name":"C'),
      finish('length'),
    ])
    const s = createOpenAICompatibleAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('go')
    const { result } = await turn(s)
    expect(result.stop).toBe('max_tokens')
    expect(result.toolCalls.map((c) => c.inputError ?? 'ok')).toEqual(['ok', 'ok', 'truncated'])
    expect(result.toolCalls[1].input).toEqual({ name: 'B' })
  })

  it('an error result that already says "Error: " is not prefixed twice', async () => {
    const srv = server([callStart(0, 'call_a', 'get_scene'), callArgs(0, '{}'), finish('tool_calls')], [...say('ok'), finish('stop')])
    const s = createOpenAICompatibleAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('go')
    const { result } = await turn(s)
    s.addToolResults([{ call: result.toolCalls[0], output: { text: "Error: no definition named 'Foo'", isError: true } }])
    await turn(s)
    expect(srv.calls[1].body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_a', content: "Error: no definition named 'Foo'" })
  })

  it('Gemini thought signatures (tool_calls[].extra_content) go back exactly as sent; nothing is added for other servers', async () => {
    const sig = { google: { thought_signature: 'sig-A==' } }
    const srv = server(
      [chunk({ tool_calls: [{ index: 0, id: 'fc_1', type: 'function', function: { name: 'get_scene', arguments: '{}' }, extra_content: sig }] }), finish('tool_calls')],
      [...say('ok'), finish('stop')],
    )
    const s = createOpenAICompatibleAdapter({ fetch: srv.fetch }).createSession(config('gemini'))
    s.addUser('go')
    const { result } = await turn(s)
    s.addToolResults([{ call: result.toolCalls[0], output: { text: '{}' } }])
    await turn(s)
    expect(srv.calls[1].body.messages[2]).toEqual({
      role: 'assistant', content: null,
      tool_calls: [{ id: 'fc_1', type: 'function', function: { name: 'get_scene', arguments: '{}' }, extra_content: sig }],
    })
    expect(srv.calls[1].raw.match(/extra_content/g)).toHaveLength(1)
  })

  it('invalid JSON arguments: an inputError, never a crash', async () => {
    const srv = server([callStart(0, 'call_1', 'get_scene'), callArgs(0, '{"a": 1,}'), finish('tool_calls')])
    const s = createOpenAICompatibleAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('go')
    const { result } = await turn(s)
    expect(result.toolCalls[0]).toMatchObject({ id: 'call_1', input: undefined })
    expect(result.toolCalls[0].inputError).toMatch(/not valid JSON/)
  })

  it('content_filter: stop "refusal"; nothing is appended', async () => {
    const srv = server([...say('Part'), finish('content_filter')], [...say('ok'), finish('stop')])
    const s = createOpenAICompatibleAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('bad')
    const { result } = await turn(s)
    expect(result.stop).toBe('refusal')
    expect(result.refusal).toMatch(/content filter/)
    s.addUser('else')
    await turn(s)
    expect(srv.calls[1].body.messages.map((m: any) => m.role)).toEqual(['system', 'user', 'user'])
  })

  it('tool calls the loop never answered get "not run" tool messages before the next user message', async () => {
    const srv = server([callStart(0, 'call_1', 'get_scene'), callArgs(0, '{}'), finish('tool_calls')], [...say('ok'), finish('stop')])
    const s = createOpenAICompatibleAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('go')
    await turn(s)
    s.addUser('never mind')
    await turn(s)
    const msgs = srv.calls[1].body.messages
    expect(msgs.slice(3).map((m: any) => m.role)).toEqual(['tool', 'user'])
    expect(msgs[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' })
  })
})

describe('openai-compatible: errors', () => {
  it.each([
    [401, 'auth'],
    [403, 'permission'],
    [402, 'permission'],
    [404, 'not_found'],
    [429, 'rate_limit'],
    [500, 'server'],
    [529, 'overloaded'],
    [400, 'bad_request'],
  ])('HTTP %i → kind %s, without the key', async (status, kind) => {
    // OpenAI quotes part of the key in its 401 message; the adapter must not pass it on
    const srv = mockFetch(() => json(status, { error: { message: `Incorrect API key provided: sk-proj-********cdef (${KEY})`, type: 'invalid_request_error', code: null } }))
    const s = createOpenAICompatibleAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('hi')
    const err = await rejection(turn(s))
    expect(err.kind).toBe(kind)
    expect(err.status).toBe(status)
    expect(err.message).not.toContain(KEY)
    expect(err.message).not.toContain('TESTKEY')
    expect(err.message).not.toContain('cdef')
  })

  it('a bad request explains itself with the API message', async () => {
    const srv = mockFetch(() => json(400, { error: { message: 'Invalid schema for function get_scene.', type: 'invalid_request_error' } }))
    const s = createOpenAICompatibleAdapter({ fetch: srv.fetch }).createSession(config())
    s.addUser('hi')
    const err = await rejection(turn(s))
    expect(err.message).toContain('Invalid schema for function get_scene.')
  })

  it('a network failure (how a CORS block looks) → network, retryable', async () => {
    const srv = mockFetch(() => { throw new TypeError('Failed to fetch') })
    const s = createOpenAICompatibleAdapter({ fetch: srv.fetch }).createSession(config('lmstudio', { apiKey: '' }))
    s.addUser('hi')
    const err = await rejection(turn(s))
    expect(err).toMatchObject({ kind: 'network', retryable: true })
    expect(err.message).toContain('localhost:1234')
  }, 20000)

  it('an error inside the stream (OpenRouter style) maps by its code', async () => {
    const srv = server([...say('Hel'), { error: { code: 429, message: 'Provider rate limit' } }])
    const s = createOpenAICompatibleAdapter({ fetch: srv.fetch }).createSession(config('openrouter'))
    s.addUser('hi')
    const err = await rejection(turn(s))
    expect(err.kind).toBe('rate_limit')
    expect(err.message).toContain('Provider rate limit')
  })

  it('a local server that wants a key says so', async () => {
    const srv = mockFetch(() => json(401, { error: { message: 'unauthorized' } }))
    const s = createOpenAICompatibleAdapter({ fetch: srv.fetch }).createSession(config('lmstudio', { apiKey: '' }))
    s.addUser('hi')
    const err = await rejection(turn(s))
    expect(err.kind).toBe('auth')
    expect(err.message).toMatch(/asked for an API key/)
  })
})

describe('openai-compatible: text-only models and screenshots', () => {
  const shot = { mediaType: 'image/png' as const, base64: PNG }
  const hasImage = (body: any) => JSON.stringify(body.messages).includes('image_url')

  /** a DeepSeek-like server: 400 for any request with an image part, else the next stream */
  function textOnlyServer(...streams: unknown[][]) {
    let n = 0
    return mockFetch((call) => {
      if (!call.url.endsWith('/chat/completions')) return json(404, { error: { message: 'not here' } })
      if (hasImage(call.body)) return json(400, { error: { message: 'Failed to deserialize the JSON body into the target type: messages[3]: unknown variant `image_url`, expected `text`', type: 'invalid_request_error' } })
      const s = streams[n++]
      if (!s) throw new Error('no more streams')
      return sse(s)
    })
  }

  it('a refusal of the screenshots: the turn goes again without them, the user is told once, and every later request is text only', async () => {
    const srv = textOnlyServer(
      [callStart(0, 'call_a', 'screenshot'), callArgs(0, '{}'), finish('tool_calls')],
      [...say('Looks fine.'), finish('stop')],
      [...say('Still fine.'), finish('stop')],
    )
    const s = createOpenAICompatibleAdapter({ fetch: srv.fetch }).createSession(config('deepseek'))
    s.addUser('look')
    const { result } = await turn(s)
    s.addToolResults([{ call: result.toolCalls[0], output: { text: 'Shows the scene.', images: [shot] } }])
    const second = await turn(s)
    expect(second.result).toMatchObject({ stop: 'end', text: 'Looks fine.', notice: 'This model does not take images, so screenshots reach it as text only from now on.' })
    const chats = srv.chats()
    expect(chats.map((c) => hasImage(c.body))).toEqual([false, true, false])
    expect(chats[2].body.messages.at(-1)).toEqual({ role: 'user', content: '(The screenshot of the tool calls above is not shown to you: this model does not take images. Use the text of the tool results, get_scene and get_errors.)' })
    s.addUser('again')
    const third = await turn(s)
    expect(third.result.notice).toBeUndefined()
    expect(hasImage(srv.chats()[3].body)).toBe(false)
  })

  it('the reviewer\'s repro through the real loop: after the refusal the chat keeps working (images on or off)', async () => {
    const srv = textOnlyServer(
      [callStart(0, 'call_a', 'screenshot'), callArgs(0, '{}'), finish('tool_calls')],
      [...say('Seen as text.'), finish('stop')],
      [...say('Fine.'), finish('stop')],
    )
    const adapter = createOpenAICompatibleAdapter({ fetch: srv.fetch })
    const screenshot: AgentTool = { ...fakeTool('screenshot'), run: async () => ({ text: 'Shows the scene.', images: [shot] }) }
    const chat = new ChatController({ getAdapter: async () => adapter, loadTools: async () => [screenshot], systemPrompt: async () => 'S', appState: () => '' })
    chat.configure(config('deepseek'))
    await chat.send('look')
    expect(chat.lastEnd).toBe('end')
    expect(chat.entries.filter((e) => e.kind === 'notice').map((e) => (e as { text: string }).text)).toEqual(['This model does not take images, so screenshots reach it as text only from now on.'])
    chat.configure({ ...config('deepseek'), vision: false })
    await chat.send('try again without images')
    expect(chat.lastEnd).toBe('end')
    const last = srv.chats().at(-1)!.body
    expect(hasImage(last)).toBe(false)
    expect(JSON.stringify(last.messages)).toContain('images are turned off in the chat settings')
  })

  it('images turned off mid-chat: screenshots already in the history are not sent again', async () => {
    const srv = server(
      [callStart(0, 'call_a', 'screenshot'), callArgs(0, '{}'), finish('tool_calls')],
      [...say('I see it.'), finish('stop')],
      [...say('ok'), finish('stop')],
    )
    const c = config('openai')
    const s = createOpenAICompatibleAdapter({ fetch: srv.fetch }).createSession(c)
    s.addUser('look')
    const { result } = await turn(s)
    s.addToolResults([{ call: result.toolCalls[0], output: { text: '{}', images: [shot] } }])
    await turn(s)
    expect(hasImage(srv.chats()[1].body)).toBe(true)
    c.vision = false // the loop updates the session's config in place
    s.addUser('and now?')
    const r = await turn(s)
    expect(r.result.notice).toBeUndefined()
    expect(hasImage(srv.chats()[2].body)).toBe(false)
  })

  it('OpenRouter: a model whose model list says it reads no images gets its screenshots as text from the start', async () => {
    const data = [{ id: 'deepseek/deepseek-v3.2', created: 10, supported_parameters: ['tools'], architecture: { input_modalities: ['text'] } }]
    const streams = [
      [callStart(0, 'call_a', 'screenshot'), callArgs(0, '{}'), finish('tool_calls')],
      [...say('ok'), finish('stop')],
    ]
    let n = 0
    const srv = mockFetch((call) => (call.url.includes('/models') ? json(200, { data }) : sse(streams[n++])))
    const adapter = createOpenAICompatibleAdapter({ fetch: srv.fetch })
    const { model: _m, ...rest } = config('openrouter')
    await adapter.listModels(rest)
    const s = adapter.createSession(config('openrouter', { model: 'deepseek/deepseek-v3.2' }))
    s.addUser('look')
    const { result } = await turn(s)
    s.addToolResults([{ call: result.toolCalls[0], output: { text: '{}', images: [shot] } }])
    const r = await turn(s)
    expect(r.result.notice).toBe('This model does not take images, so screenshots reach it as text only from now on.')
    expect(srv.chats().map((c) => hasImage(c.body))).toEqual([false, false])
  })

  it('a refusal that is not about images, or one after partial output, is not retried', async () => {
    const first = [callStart(0, 'call_a', 'screenshot'), callArgs(0, '{}'), finish('tool_calls')]
    for (const second of ['schema', 'partial'] as const) {
      let n = 0
      const srv = mockFetch(() => {
        if (n++ === 0) return sse(first)
        if (second === 'schema') return json(400, { error: { message: 'Invalid schema for function get_scene.' } })
        // some text, then an error inside the stream that mentions images
        return new Response(encode([...say('Look'), { error: { code: 400, message: 'image input is not supported' } }], false), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      })
      const s = createOpenAICompatibleAdapter({ fetch: srv.fetch }).createSession(config('deepseek'))
      s.addUser('x')
      const { result } = await turn(s)
      s.addToolResults([{ call: result.toolCalls[0], output: { text: '{}', images: [shot] } }])
      const err = await rejection(turn(s))
      expect(err.kind, second).toBe('bad_request')
      expect(srv.chats(), second).toHaveLength(2)
    }
  })
})

describe('openai-compatible: error notices', () => {
  it('the notice says it once: the error carries only the API\'s text, the loop writes the sentence around it', async () => {
    const cases: [number, string, string][] = [
      [429, 'Rate limit reached for gpt-5.2 in organization org-x on tokens per min', 'OpenAI rate limit reached (Rate limit reached for gpt-5.2 in organization org-x on tokens per min). Wait a moment, then try again.'],
      [400, 'Invalid schema for function get_scene.', 'OpenAI refused the request (Invalid schema for function get_scene.).'],
      [400, "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.", 'The conversation is too long for this model. Start a new chat.'],
      [404, 'This model is only supported in v1/responses and not in v1/chat/completions.', "The model 'test-model' does not work with this chat (it needs the Chat Completions API). Pick another model in the chat settings."],
    ]
    for (const [status, message, notice] of cases) {
      const srv = mockFetch(() => json(status, { error: { message, type: 'invalid_request_error' } }))
      const s = createOpenAICompatibleAdapter({ fetch: srv.fetch }).createSession(config())
      s.addUser('hi')
      const err = await rejection(turn(s))
      expect(err.message).toBe(message)
      expect(describeError(err, config())).toBe(notice)
    }
  })
})

describe('openai-compatible: listModels', () => {
  const { model: _m, ...openrouter } = config('openrouter')

  it('OpenRouter: only models with tools and a chat endpoint; major vendors first, newest first, the default on top', async () => {
    const data = [
      { id: 'tiny/no-tools', created: 300, supported_parameters: ['temperature'] },
      { id: 'anthropic/claude-opus-5.5:batch', created: 250, supported_parameters: ['tools'], endpoints: ['/api/v1/batches'] },
      { id: 'someone/new-model', created: 400, supported_parameters: ['tools'] },
      { id: 'openai/gpt-6.1-sol', created: 260, supported_parameters: ['tools', 'reasoning_effort'] },
      { id: 'anthropic/claude-opus-5.5', created: 250, supported_parameters: ['tools', 'reasoning_effort'], endpoints: ['/api/v1/chat/completions', '/api/v1/messages'] },
      { id: 'google/gemini-4-carbon', created: 270, supported_parameters: ['tools'] },
    ]
    const srv = mockFetch(() => json(200, { data }))
    const adapter = createOpenAICompatibleAdapter({ fetch: srv.fetch })
    const ids = await adapter.listModels(openrouter)
    expect(srv.calls[0].url).toBe('https://openrouter.ai/api/v1/models')
    expect(srv.calls[0].headers.authorization).toBe(`Bearer ${KEY}`)
    expect(ids).toEqual(['anthropic/claude-opus-5.5', 'google/gemini-4-carbon', 'openai/gpt-6.1-sol', 'someone/new-model'])
  })

  it('OpenRouter metadata decides reasoning_effort for later requests', async () => {
    const data = [{ id: 'vendor/plain', created: 1, supported_parameters: ['tools'] }]
    let n = 0
    const srv = mockFetch(() => (n++ === 0 ? json(200, { data }) : sse([...say('ok'), finish('stop')])))
    const adapter = createOpenAICompatibleAdapter({ fetch: srv.fetch })
    await adapter.listModels(openrouter)
    const s = adapter.createSession(config('openrouter', { model: 'vendor/plain', effort: 'high' }))
    s.addUser('hi')
    await turn(s)
    expect(srv.calls[1].body.reasoning_effort).toBeUndefined()
  })

  it('OpenAI: no Responses-only models (-pro, codex, deep-research) and no chatgpt-* (no function calling)', () => {
    const ids = ['gpt-5.2', 'gpt-5-pro', 'gpt-5.2-pro-2026-01-01', 'o3-pro', 'o1-pro', 'gpt-5.1-codex', 'gpt-5-codex', 'chatgpt-4o-latest', 'gpt-4o', 'o4-mini-deep-research', 'o4-mini']
    expect(pickModels('openai', '', ids.map((id, i) => ({ id, created: 100 - i })))).toEqual(['gpt-5.2', 'gpt-4o', 'o4-mini'])
  })

  it('OpenAI: chat models only, newest first', async () => {
    const data = [
      { id: 'text-embedding-3-large', created: 5, object: 'model', owned_by: 'openai' },
      { id: 'gpt-4.1', created: 10, object: 'model', owned_by: 'openai' },
      { id: 'gpt-6.1-sol', created: 30, object: 'model', owned_by: 'openai' },
      { id: 'whisper-1', created: 3, object: 'model', owned_by: 'openai' },
      { id: 'o3', created: 20, object: 'model', owned_by: 'openai' },
      { id: 'gpt-image-2', created: 40, object: 'model', owned_by: 'openai' },
    ]
    const srv = mockFetch(() => json(200, { object: 'list', data }))
    const { model: _x, ...openai } = config('openai')
    expect(await createOpenAICompatibleAdapter({ fetch: srv.fetch }).listModels(openai)).toEqual(['gpt-6.1-sol', 'o3', 'gpt-4.1'])
  })

  it('local servers: listed as served', async () => {
    const data = [{ id: 'qwen3:8b', object: 'model' }, { id: 'llama3.2', object: 'model' }, { id: 'nomic-embed-text', object: 'model' }]
    const srv = mockFetch(() => json(200, { object: 'list', data }))
    const { model: _x, ...ollama } = config('ollama', { apiKey: '' })
    expect(await createOpenAICompatibleAdapter({ fetch: srv.fetch }).listModels(ollama)).toEqual(['qwen3:8b', 'llama3.2', 'nomic-embed-text'])
    expect(srv.calls[0].url).toBe('http://localhost:11434/v1/models')
  })

  it('pickModels caps nothing it should not and keeps the default first', () => {
    expect(pickModels('mistral', 'b', [{ id: 'a', created: 2 }, { id: 'b', created: 1 }, { id: 'mistral-embed', created: 3 }])).toEqual(['b', 'a'])
  })

  it('a bad key → auth, without the key in the message', async () => {
    const srv = mockFetch(() => json(401, { error: { message: `Incorrect API key provided: ${KEY}` } }))
    const { model: _x, ...openai } = config('openai')
    const err = await rejection(createOpenAICompatibleAdapter({ fetch: srv.fetch }).listModels(openai))
    expect(err.kind).toBe('auth')
    expect(err.message).not.toContain('TESTKEY')
  })
})
