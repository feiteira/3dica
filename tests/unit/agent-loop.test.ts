// src/agent/loop.ts — the chat loop against a FAKE provider: each model turn is scripted, the session records the
// history the way an adapter would (append only; an aborted turn is not appended), and the tools are fakes.
import { describe, expect, it } from 'vitest'
import { ChatController, describeError, redactKey, type ChatControllerOptions } from '../../src/agent/loop'
import {
  ProviderError,
  type AgentTool, type ChatEntry, type ChatSession, type ProviderAdapter, type ProviderConfig, type ProviderPreset, type ToolCall,
  type ToolOutput, type ToolRunContext, type TurnResult,
} from '../../src/agent/types'

const PRESET: ProviderPreset = { id: 'anthropic', label: 'Anthropic', family: 'anthropic', baseUrl: 'https://api.anthropic.com', baseUrlEditable: false, needsKey: true, defaultModel: 'm1' }
const LOCAL: ProviderPreset = { id: 'ollama', label: 'Ollama (local)', family: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', baseUrlEditable: true, needsKey: false, defaultModel: '' }
const KEY = 'sk-ant-api03-SECRETSECRETSECRET-1234'
const config = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({ preset: PRESET, baseUrl: PRESET.baseUrl, apiKey: KEY, model: 'm1', vision: true, ...over })

type Req = Parameters<ChatSession['runTurn']>[0]
type Step = (req: Req) => Promise<TurnResult> | TurnResult
type Item = { role: 'user'; text: string } | { role: 'assistant'; result: TurnResult } | { role: 'tools'; results: { id: string; output: ToolOutput }[] }

class FakeSession implements ChatSession {
  history: Item[] = []
  turns = 0
  readonly config: ProviderConfig
  private readonly script: Step[]
  constructor(config: ProviderConfig, script: Step[]) { this.config = config; this.script = script }
  addUser(text: string): void { this.history.push({ role: 'user', text }) }
  addToolResults(results: { call: ToolCall; output: ToolOutput }[]): void {
    this.history.push({ role: 'tools', results: results.map((r) => ({ id: r.call.id, output: r.output })) })
  }
  async runTurn(req: Req): Promise<TurnResult> {
    this.turns++
    const step = this.script.shift()
    if (!step) throw new Error('the script has no more turns')
    const r = await step(req) // throws → not appended, like a real adapter
    this.history.push({ role: 'assistant', result: r })
    return r
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

// ── scripted turns ──
const say = (text: string, usage?: TurnResult['usage']): Step => (req) => {
  for (const part of text.match(/.{1,4}/g) ?? []) req.onEvent({ type: 'text', delta: part })
  return { stop: 'end', text, toolCalls: [], usage, model: 'm1-actual' }
}
const calls = (...cs: { id: string; name: string; input?: unknown; inputError?: string }[]): Step => (req) => {
  for (const c of cs) {
    req.onEvent({ type: 'tool_start', id: c.id, name: c.name })
    req.onEvent({ type: 'tool_input', id: c.id, partialJson: JSON.stringify(c.input ?? {}).slice(0, 5) })
  }
  return { stop: 'tool_use', text: '', toolCalls: cs.map((c) => ({ id: c.id, name: c.name, input: c.inputError ? undefined : c.input ?? {}, ...(c.inputError ? { inputError: c.inputError } : {}) })) }
}
/** streams a little, then waits until Stop (rejects like an adapter: ProviderError 'aborted') */
const hang: Step = (req) => new Promise((_, reject) => {
  req.onEvent({ type: 'text', delta: 'Let me' })
  req.signal.addEventListener('abort', () => reject(new ProviderError('aborted', 'aborted')), { once: true })
})
const fails = (e: unknown): Step => () => { throw e }

// ── fake tools ──
function fakeTool(name: string, run: (input: Record<string, unknown>, rc: ToolRunContext) => Promise<ToolOutput> | ToolOutput, over: Partial<AgentTool> = {}): AgentTool {
  return {
    name, description: `${name} tool`, inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    validate: (input) => (typeof input === 'object' && input !== null && !Array.isArray(input) ? { ok: true, value: input as Record<string, unknown> } : { ok: false, error: `Invalid input for ${name}` }),
    readOnly: false, needsConfirm: false, run: async (i, rc) => run(i, rc), ...over,
  }
}

function setup(scripts: Step[][], opts: Partial<ChatControllerOptions> & { tools?: AgentTool[] } = {}) {
  const sessions: FakeSession[] = []
  const ran: { name: string; input: Record<string, unknown> }[] = []
  const adapter: ProviderAdapter = {
    family: 'anthropic',
    createSession: (c) => { const s = new FakeSession(c, scripts[sessions.length] ?? []); sessions.push(s); return s },
    listModels: async () => ['m1'],
  }
  const tools = opts.tools ?? [
    fakeTool('get_scene', (i) => { ran.push({ name: 'get_scene', input: i }); return { text: '{"tree":[]}' } }, { readOnly: true }),
    fakeTool('create_object', (i) => { ran.push({ name: 'create_object', input: i }); return { text: '{"ok":true,"objects":[{"definition":"Cube","status":"ok","size":[10,10,10]}],"errors":[]}' } }),
    fakeTool('screenshot', () => ({ text: 'Shows the scene.', images: [{ mediaType: 'image/png', base64: 'iVBOR' }] }), { readOnly: true }),
    fakeTool('bad', () => { throw new Error('boom') }),
  ]
  const chat = new ChatController({
    getAdapter: async () => adapter,
    loadTools: async () => tools,
    systemPrompt: async () => 'SYSTEM',
    appState: () => '<app_state>\nselection: nothing\n</app_state>',
    ...opts,
  })
  chat.configure(config())
  const kinds = () => chat.entries.map((e) => (e.kind === 'tool' ? `tool:${e.name}:${e.status}` : e.kind === 'notice' ? `notice:${e.level}` : e.kind))
  const notices = () => chat.entries.filter((e): e is Extract<ChatEntry, { kind: 'notice' }> => e.kind === 'notice').map((e) => e.text)
  const tool = (name: string) => chat.entries.find((e): e is Extract<ChatEntry, { kind: 'tool' }> => e.kind === 'tool' && e.name === name)!
  return { chat, sessions, ran, kinds, notices, tool }
}

describe('chat loop: turns and tools', () => {
  it('user → tool call → result → answer; the model gets the app state, the transcript shows what the user typed', async () => {
    const { chat, sessions, ran, kinds, tool } = setup([[calls({ id: 't1', name: 'create_object', input: { kind: 'cube' } }), say('Added a 10 mm cube.')]])
    const seen: number[] = []
    chat.subscribe((c) => seen.push(c.entries.length))
    await chat.send('  add a cube  ')
    expect(kinds()).toEqual(['user', 'tool:create_object:ok', 'assistant'])
    expect(chat.entries[0]).toMatchObject({ kind: 'user', text: 'add a cube' })
    expect(chat.entries[2]).toMatchObject({ kind: 'assistant', text: 'Added a 10 mm cube.', streaming: false, model: 'm1-actual' })
    expect(tool('create_object')).toMatchObject({ inputJson: '{"kind":"cube"}', summary: 'cube — 10 × 10 × 10 mm', resultText: expect.stringContaining('"ok":true') })
    expect(ran).toEqual([{ name: 'create_object', input: { kind: 'cube' } }])
    const h = sessions[0].history
    expect(h.map((x) => x.role)).toEqual(['user', 'assistant', 'tools', 'assistant'])
    expect((h[0] as { text: string }).text).toBe('<app_state>\nselection: nothing\n</app_state>\n\nadd a cube')
    expect((h[2] as { results: unknown[] }).results).toEqual([{ id: 't1', output: { text: expect.stringContaining('"ok":true') } }])
    expect(chat.state).toBe('idle')
    expect(chat.lastEnd).toBe('end')
    expect(chat.canContinue).toBe(false)
    expect(seen.length).toBeGreaterThan(5)
  })

  it('runs every call of a turn in order and sends all results at once', async () => {
    const { chat, sessions, ran } = setup([[calls({ id: 'a', name: 'get_scene' }, { id: 'b', name: 'create_object', input: { kind: 'sphere' } }, { id: 'c', name: 'screenshot' }), say('Done.')]])
    await chat.send('go')
    expect(ran.map((r) => r.name)).toEqual(['get_scene', 'create_object'])
    const results = (sessions[0].history[2] as { results: { id: string; output: ToolOutput }[] }).results
    expect(results.map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(results[2].output.images).toEqual([{ mediaType: 'image/png', base64: 'iVBOR' }])
  })

  it('bad input, unparsable JSON, an unknown tool and a throwing tool become error results the model reads', async () => {
    const { chat, sessions, kinds } = setup([[
      calls({ id: 'a', name: 'get_scene', input: [1] }, { id: 'b', name: 'create_object', inputError: 'Unexpected end of JSON' }, { id: 'c', name: 'teleport' }, { id: 'd', name: 'bad' }),
      say('Sorry.'),
    ]])
    await chat.send('go')
    expect(kinds()).toEqual(['user', 'tool:get_scene:error', 'tool:create_object:error', 'tool:teleport:error', 'tool:bad:error', 'assistant'])
    const out = (sessions[0].history[2] as { results: { output: ToolOutput }[] }).results.map((r) => r.output)
    expect(out[0]).toEqual({ text: 'Invalid input for get_scene', isError: true })
    expect(out[1]).toEqual({ text: 'Not run: the input is not valid JSON (Unexpected end of JSON). Send the arguments as one JSON object.', isError: true })
    expect(out[2].text).toBe("Unknown tool 'teleport'. The tools are: get_scene, create_object, screenshot, bad.")
    expect(out[3]).toEqual({ text: 'Error: boom', isError: true })
    expect(chat.lastEnd).toBe('end')
  })

  it('a reply cut off at max_tokens: complete calls run, the truncated one gets a "send it smaller" error, and the loop goes on', async () => {
    const cut: Step = () => ({ stop: 'max_tokens', text: '', toolCalls: [{ id: 'a', name: 'get_scene', input: {} }, { id: 'b', name: 'create_object', input: undefined, inputError: 'Unterminated string' }] })
    const { chat, sessions, ran, notices } = setup([[cut, say('Retrying smaller.')]])
    await chat.send('go')
    expect(ran.map((r) => r.name)).toEqual(['get_scene'])
    const out = (sessions[0].history[2] as { results: { output: ToolOutput }[] }).results.map((r) => r.output)
    expect(out[1].text).toMatch(/^Not run: your reply hit the output token limit/)
    expect(sessions[0].turns).toBe(2)
    expect(notices()).toEqual([])
  })

  it('max_tokens without calls, refusal, an empty reply: notices', async () => {
    const { chat, notices } = setup([[() => ({ stop: 'max_tokens', text: 'Long…', toolCalls: [] })], []])
    await chat.send('go')
    expect(chat.lastEnd).toBe('max_tokens')
    expect(notices()).toEqual(["The reply was cut off at the model's output limit. Ask it to continue, or to answer in shorter steps."])
    const r = setup([[() => ({ stop: 'refusal', text: '', toolCalls: [], refusal: 'Not allowed.' })]])
    await r.chat.send('go')
    expect(r.notices()).toEqual(['The model declined: Not allowed.'])
    const e = setup([[() => ({ stop: 'end', text: '', toolCalls: [] })]])
    await e.chat.send('go')
    expect(e.notices()).toEqual(['The model sent an empty reply.'])
  })

  it('pause: runs the turn again with no new input', async () => {
    const { chat, sessions } = setup([[() => ({ stop: 'pause', text: '', toolCalls: [] }), say('Here.')]])
    await chat.send('go')
    expect(sessions[0].turns).toBe(2)
    expect(sessions[0].history.map((x) => x.role)).toEqual(['user', 'assistant', 'assistant'])
  })

  it('text after a tool call starts a new assistant entry; a non-streaming adapter\'s text shows before its tool cards', async () => {
    const mixed: Step = (req) => {
      req.onEvent({ type: 'thinking', delta: 'Plan: look.' })
      req.onEvent({ type: 'text', delta: 'Looking.' })
      req.onEvent({ type: 'tool_start', id: 'a', name: 'get_scene' })
      req.onEvent({ type: 'text', delta: 'Then this.' })
      return { stop: 'tool_use', text: 'Looking.Then this.', toolCalls: [{ id: 'a', name: 'get_scene', input: {} }] }
    }
    const quiet: Step = () => ({ stop: 'tool_use', text: 'Silent text.', toolCalls: [{ id: 'b', name: 'get_scene', input: {} }] })
    const { chat, kinds } = setup([[mixed, quiet, () => ({ stop: 'end', text: 'Bye.', toolCalls: [] })]])
    await chat.send('go')
    expect(kinds()).toEqual(['user', 'assistant', 'tool:get_scene:ok', 'assistant', 'assistant', 'tool:get_scene:ok', 'assistant'])
    expect(chat.entries[1]).toMatchObject({ text: 'Looking.', thinking: 'Plan: look.', streaming: false })
    expect(chat.entries[3]).toMatchObject({ text: 'Then this.' })
    expect(chat.entries[4]).toMatchObject({ text: 'Silent text.', streaming: false })
    expect(chat.entries[6]).toMatchObject({ text: 'Bye.' })
  })

  it('entries are replaced, never mutated', async () => {
    const { chat } = setup([[say('Hello there.')]])
    let first: ChatEntry | undefined
    chat.subscribe((c) => { if (!first && c.entries[1]) first = c.entries[1] })
    await chat.send('hi')
    expect(first).toMatchObject({ kind: 'assistant', streaming: true })
    expect(first).not.toBe(chat.entries[1])
    expect(chat.entries[1]).toMatchObject({ text: 'Hello there.', streaming: false })
  })
})

describe('chat loop: approvals', () => {
  const confirming = (log: string[]) => fakeTool('new_project', async (_i, rc) => {
    const ok = await rc.confirm('New project', 'Replace it?')
    log.push(ok ? 'ran' : 'declined')
    return ok ? { text: '{"ok":true}' } : { text: 'The user declined the new project. Nothing changed.' }
  }, { needsConfirm: true })

  it('approve: the confirm card turns approved and the tool runs', async () => {
    const log: string[] = []
    const { chat, kinds, tool } = setup([[calls({ id: 'a', name: 'new_project' }), say('New project ready.')]], { tools: [confirming(log)] })
    const done = chat.send('start over')
    await tick(); await tick()
    const card = chat.entries.find((e) => e.kind === 'confirm')!
    expect(card).toMatchObject({ title: 'New project', message: 'Replace it?', state: 'pending' })
    expect(tool('new_project').status).toBe('running')
    chat.approve(card.id)
    await done
    expect(log).toEqual(['ran'])
    expect(kinds()).toEqual(['user', 'tool:new_project:ok', 'confirm', 'assistant'])
    expect(chat.entries.find((e) => e.kind === 'confirm')).toMatchObject({ state: 'approved' })
  })

  it('decline: the tool reports the decline (not an error) and the model goes on', async () => {
    const log: string[] = []
    const { chat, sessions, tool } = setup([[calls({ id: 'a', name: 'new_project' }), say('OK, kept it.')]], { tools: [confirming(log)] })
    const done = chat.send('start over')
    await tick(); await tick()
    chat.decline(chat.entries.find((e) => e.kind === 'confirm')!.id)
    await done
    expect(log).toEqual(['declined'])
    expect(tool('new_project').status).toBe('declined')
    expect((sessions[0].history[2] as { results: { output: ToolOutput }[] }).results[0].output).toEqual({ text: 'The user declined the new project. Nothing changed.' })
    expect(chat.entries.find((e) => e.kind === 'confirm')).toMatchObject({ state: 'declined' })
  })

  it('Stop while the user is asked: declined card, "Cancelled by the user" for the model', async () => {
    const log: string[] = []
    const { chat, sessions, tool } = setup([[calls({ id: 'a', name: 'new_project' })]], { tools: [confirming(log)] })
    const done = chat.send('start over')
    await tick(); await tick()
    chat.stop()
    await done
    expect(tool('new_project').status).toBe('cancelled')
    expect((sessions[0].history[2] as { results: { output: ToolOutput }[] }).results[0].output).toEqual({ text: 'Cancelled by the user', isError: true })
    expect(chat.entries.find((e) => e.kind === 'confirm')).toMatchObject({ state: 'declined' })
    expect(chat.lastEnd).toBe('stopped')
  })
})

describe('chat loop: Stop, limits, errors', () => {
  it('Stop during a tool run: the running call and the queued ones still get results, so the history stays valid', async () => {
    let started!: () => void
    const isRunning = new Promise<void>((r) => { started = r })
    const slow = fakeTool('slow', (_i, rc) => new Promise((_, reject) => {
      started()
      rc.signal.addEventListener('abort', () => reject(new DOMException('Cancelled by the user', 'AbortError')), { once: true })
    }))
    const { chat, sessions, kinds, notices } = setup([[calls({ id: 'a', name: 'slow' }, { id: 'b', name: 'get_scene' })], [say('After a stop.')]], { tools: [slow, fakeTool('get_scene', () => ({ text: '{}' }))] })
    const done = chat.send('go')
    await isRunning
    expect(chat.state).toBe('running')
    chat.stop()
    expect(chat.state).toBe('stopping')
    await done
    expect(kinds()).toEqual(['user', 'tool:slow:cancelled', 'tool:get_scene:cancelled', 'notice:info'])
    expect(notices()).toEqual(['Stopped.'])
    const results = (sessions[0].history[2] as { results: { id: string; output: ToolOutput }[] }).results
    expect(results).toEqual([
      { id: 'a', output: { text: 'Cancelled by the user while it was running. A change it made may already be applied (it is in the undo history).', isError: true } },
      { id: 'b', output: { text: 'Cancelled by the user', isError: true } },
    ])
    expect(chat.state).toBe('idle')
    expect(chat.lastEnd).toBe('stopped')
    // the model can pick up from there
    expect(chat.canContinue).toBe(true)
    sessions[0]['script'].push(say('Continuing.'))
    await chat.continue()
    expect(sessions[0].history.map((x) => x.role)).toEqual(['user', 'assistant', 'tools', 'assistant'])
  })

  it('Stop mid-stream: the turn is not in the history, nothing needs results, the partial text stays', async () => {
    const { chat, sessions, kinds } = setup([[hang]])
    const done = chat.send('go')
    await tick()
    chat.stop()
    await done
    expect(sessions[0].history.map((x) => x.role)).toEqual(['user'])
    expect(kinds()).toEqual(['user', 'assistant', 'notice:info'])
    expect(chat.entries[1]).toMatchObject({ text: 'Let me', streaming: false })
    expect(chat.canContinue).toBe(true)
  })

  it('a tool card that was still streaming when Stop came is marked cancelled', async () => {
    const half: Step = (req) => new Promise((_, reject) => {
      req.onEvent({ type: 'tool_start', id: 'a', name: 'create_object' })
      req.signal.addEventListener('abort', () => reject(new ProviderError('aborted', 'aborted')), { once: true })
    })
    const { chat, kinds } = setup([[half]])
    const done = chat.send('go')
    await tick()
    chat.stop()
    await done
    expect(kinds()).toEqual(['user', 'tool:create_object:cancelled', 'notice:info'])
  })

  it('maxSteps: pauses with a warning; continue() goes on', async () => {
    const loop = (id: string) => calls({ id, name: 'get_scene' })
    const { chat, sessions, notices } = setup([[loop('1'), loop('2'), loop('3'), say('Finally.')]], { maxSteps: 2 })
    await chat.send('go')
    expect(sessions[0].turns).toBe(2)
    expect(chat.lastEnd).toBe('limit')
    expect(notices()).toEqual(['Paused after 2 steps (the limit for one message). Press Continue to let it keep going.'])
    expect(chat.canContinue).toBe(true)
    await chat.continue()
    expect(sessions[0].turns).toBe(4)
    expect(chat.lastEnd).toBe('end')
    expect(chat.canContinue).toBe(false)
    // a new message gets a fresh step budget
    chat.maxSteps = 1
    sessions[0]['script'].push(say('One.'))
    await chat.send('again')
    expect(chat.lastEnd).toBe('end')
  })

  it('provider errors become notices with a human message, never with the key', async () => {
    const cases: [ProviderError, RegExp][] = [
      [new ProviderError('auth', `invalid x-api-key ${KEY}`, { status: 401 }), /^Anthropic did not accept the API key\. Check the key in the chat settings\.$/],
      [new ProviderError('network', 'Could not reach api.anthropic.com.'), /^Could not reach Anthropic\. Check your connection\. .*CORS/],
      [new ProviderError('rate_limit', 'Too many requests', { status: 429 }), /rate limit reached \(Too many requests\)\. Wait a moment, then try again\./],
      [new ProviderError('overloaded', 'Overloaded', { status: 529 }), /is overloaded right now/],
      [new ProviderError('not_found', 'model: m1', { status: 404 }), /does not know the model 'm1'.*Pick another model/],
      [new ProviderError('server', `boom ${KEY}`, { status: 500 }), /^Anthropic had a server error \(500: boom \[key\]\)\. Try again in a moment\.$/],
    ]
    for (const [err, re] of cases) {
      const { chat, notices } = setup([[fails(err)]])
      await chat.send('go')
      expect(chat.lastEnd).toBe('error')
      expect(notices()[0]).toMatch(re)
      expect(JSON.stringify(chat.entries)).not.toContain('SECRET')
    }
  })

  it('an error after tool results: the history ends with the results; continue() retries the turn', async () => {
    const { chat, sessions } = setup([[calls({ id: 'a', name: 'get_scene' }), fails(new ProviderError('overloaded', 'Overloaded')), say('Back.')]])
    await chat.send('go')
    expect(sessions[0].history.map((x) => x.role)).toEqual(['user', 'assistant', 'tools'])
    expect(chat.canContinue).toBe(true)
    await chat.continue()
    expect(sessions[0].history.map((x) => x.role)).toEqual(['user', 'assistant', 'tools', 'assistant'])
    expect(chat.entries.at(-1)).toMatchObject({ kind: 'assistant', text: 'Back.' })
  })

  it('local servers get the CORS hint; generic errors are redacted too', () => {
    const local = config({ preset: LOCAL, baseUrl: 'http://localhost:11434/v1', apiKey: '' })
    expect(describeError(new ProviderError('network', 'Could not reach localhost:11434.'), local)).toBe('Could not reach the local server at http://localhost:11434/v1. Make sure it is running and allows requests from this page (CORS).')
    expect(describeError(new Error(`bad ${KEY}`), config())).toBe('Something went wrong: bad [key]')
    expect(redactKey('Incorrect API key provided: sk-proj-********************************1234.')).toBe('Incorrect API key provided: [key].')
    expect(redactKey('Authorization: Bearer abc.def')).toBe('Authorization: Bearer [key]')
  })
})

describe('chat loop: review fixes', () => {
  it('the context window is full (adapter notice): its text is shown, no call runs, nothing goes on', async () => {
    const full: Step = () => ({ stop: 'max_tokens', text: '', toolCalls: [{ id: 'a', name: 'create_object', input: { kind: 'cube' } }], notice: 'The conversation no longer fits in the model\'s context window. Start a new chat.' })
    const { chat, sessions, ran, notices, kinds } = setup([[full, say('never')]])
    await chat.send('go')
    expect(notices()).toEqual(['The conversation no longer fits in the model\'s context window. Start a new chat.'])
    expect(ran).toEqual([])
    expect(kinds()).toEqual(['user', 'tool:create_object:cancelled', 'notice:warn'])
    expect((sessions[0].history[2] as { results: { output: ToolOutput }[] }).results[0].output).toEqual({ text: 'Not run: the conversation no longer fits in the context window.', isError: true })
    expect(sessions[0].turns).toBe(1)
    expect(chat.lastEnd).toBe('max_tokens')
    expect(chat.canContinue).toBe(false)
  })

  it('any other adapter notice is shown as info, and the turn goes on as usual', async () => {
    const noted: Step = (req) => ({ ...(say('Looked.')(req) as TurnResult), notice: 'This model does not take images, so screenshots reach it as text only from now on.' })
    const { chat, notices, kinds } = setup([[noted]])
    await chat.send('look')
    expect(notices()).toEqual(['This model does not take images, so screenshots reach it as text only from now on.'])
    expect(kinds()).toEqual(['user', 'assistant', 'notice:info'])
  })

  it('error notices say things once, in one sentence around the provider\'s own text', () => {
    const c = config()
    const cases: [ProviderError, string][] = [
      [new ProviderError('rate_limit', 'Number of request tokens has exceeded your per-minute rate limit', { status: 429 }), 'Anthropic rate limit reached (Number of request tokens has exceeded your per-minute rate limit). Wait a moment, then try again.'],
      [new ProviderError('not_found', 'model: claude-opus-9', { status: 404 }), "Anthropic does not know the model 'm1' (model: claude-opus-9). Pick another model in the chat settings."],
      [new ProviderError('server', 'Internal server error', { status: 500 }), 'Anthropic had a server error (500: Internal server error). Try again in a moment.'],
      [new ProviderError('network', 'Could not reach api.anthropic.com.'), 'Could not reach Anthropic. Check your connection. A provider that does not allow requests from web pages (CORS) fails this way too.'],
      [new ProviderError('bad_request', 'prompt is too long: 210000 tokens > 200000 maximum', { status: 400 }), 'The conversation is too long for this model. Start a new chat.'],
      [new ProviderError('bad_request', 'tools.0.custom.input_schema: bad', { status: 400 }), 'Anthropic refused the request (tools.0.custom.input_schema: bad).'],
      [new ProviderError('other', 'HTTP 418: teapot', { status: 418 }), 'Anthropic: HTTP 418: teapot'],
    ]
    for (const [e, text] of cases) expect(describeError(e, c)).toBe(text)
    // OpenAI-compatible: a refusal of the screenshots, and a Responses-only model
    const oai = config({ preset: { ...LOCAL, id: 'openai', label: 'OpenAI', baseUrlEditable: false, needsKey: true }, model: 'gpt-5-pro' })
    expect(describeError(new ProviderError('bad_request', 'unknown variant `image_url`, expected `text`', { status: 400 }), oai)).toBe("This model does not take images. Turn off 'Send screenshots as images' in the chat settings.")
    expect(describeError(new ProviderError('not_found', 'This model is only supported in v1/responses and not in v1/chat/completions.', { status: 404 }), oai))
      .toBe("The model 'gpt-5-pro' does not work with this chat (it needs the Chat Completions API). Pick another model in the chat settings.")
  })

  it('a base URL\'s user name, password and query never reach a notice; a remote custom server is not called local', () => {
    const custom: ProviderPreset = { id: 'custom', label: 'Custom (OpenAI-compatible)', family: 'openai-compatible', baseUrl: '', baseUrlEditable: true, needsKey: false, defaultModel: '' }
    const net = new ProviderError('network', 'Could not reach mock.example.')
    const remote = describeError(net, config({ preset: custom, baseUrl: 'https://user:s3cret-pass@mock.example/v1?token=abc', apiKey: '' }))
    expect(remote).toBe('Could not reach the server at https://mock.example/v1. Make sure it is running and allows requests from this page (CORS).')
    const local = describeError(net, config({ preset: LOCAL, baseUrl: 'http://admin:hunter2@localhost:11434/v1', apiKey: '' }))
    expect(local).toBe('Could not reach the local server at http://localhost:11434/v1. Make sure it is running and allows requests from this page (CORS).')
  })

  it('the same message again after a failure is a Retry: the model never gets it twice', async () => {
    const { chat, sessions } = setup([[fails(new ProviderError('rate_limit', 'slow down', { status: 429 })), say('Wider now.')]])
    await chat.send('Make the plate 10 mm wider')
    expect(chat.lastEnd).toBe('error')
    await chat.send('  Make the plate 10 mm wider ')
    expect(chat.entries.filter((e) => e.kind === 'user')).toHaveLength(1)
    expect(sessions[0].history.filter((x) => x.role === 'user')).toHaveLength(1)
    expect(chat.entries.at(-1)).toMatchObject({ kind: 'assistant', text: 'Wider now.' })
  })

  it('a different message after a failure tells the model, in its app state, that the earlier one got no reply', async () => {
    const { chat, sessions } = setup([[fails(new ProviderError('network', 'Could not reach api.anthropic.com.')), say('Done.')]])
    await chat.send('first')
    await chat.send('second')
    const users = sessions[0].history.filter((x): x is { role: 'user'; text: string } => x.role === 'user').map((x) => x.text)
    expect(users[0]).toBe('<app_state>\nselection: nothing\n</app_state>\n\nfirst')
    expect(users[1]).toBe('<app_state>\nselection: nothing\nnote: the user\'s previous message(s) got no reply because the request failed. Answer this newest message; the earlier ones only if it asks for that.\n</app_state>\n\nsecond')
    // a message after a reply that worked: no note
    sessions[0]['script'].push(say('Third.'))
    await chat.send('third')
    expect((sessions[0].history.filter((x) => x.role === 'user').at(-1) as { text: string }).text).not.toContain('note:')
  })

  it('canRetry: only for errors that may pass, or once the settings changed since', async () => {
    const auth = setup([[fails(new ProviderError('auth', 'bad key', { status: 401 }))], [say('Hi.')]])
    await auth.chat.send('hello')
    expect(auth.chat.canContinue).toBe(true)
    expect(auth.chat.canRetry).toBe(false)
    expect(auth.chat.lastError).toEqual({ kind: 'auth', retryable: false })
    auth.chat.configure(config()) // the same settings: still no
    expect(auth.chat.canRetry).toBe(false)
    auth.chat.configure(config({ apiKey: 'sk-ant-api03-OTHEROTHEROTHER-9999' }))
    expect(auth.chat.canRetry).toBe(true)
    await auth.chat.continue()
    expect(auth.chat.entries.at(-1)).toMatchObject({ kind: 'assistant', text: 'Hi.' })

    const busy = setup([[fails(new ProviderError('rate_limit', 'slow down', { status: 429 }))]])
    await busy.chat.send('go')
    expect(busy.chat.canRetry).toBe(true)

    const long = setup([[fails(new ProviderError('bad_request', 'prompt is too long: 1012345 tokens > 1000000 maximum', { status: 400 }))]])
    await long.chat.send('go')
    expect(long.notices()).toEqual(['The conversation is too long for this model. Start a new chat.'])
    expect(long.chat.canContinue).toBe(false)
    expect(long.chat.canRetry).toBe(false)

    const setupErr = setup([[say('Hi!')]])
    setupErr.chat.configure(config({ apiKey: '' }))
    await setupErr.chat.send('hello')
    expect(setupErr.chat.canRetry).toBe(false)
    setupErr.chat.configure(config())
    expect(setupErr.chat.canRetry).toBe(true)
  })

  it('pauses after maxChanges project changes in one message (counted by the real tools), so all of them stay undoable', async () => {
    const { setupApp } = await import('./agent-fixtures')
    const app = setupApp()
    const cube = (id: string, name: string) => ({ id, name: 'create_object', input: { kind: 'cube', name } })
    const sessions: FakeSession[] = []
    const script = [calls(cube('a', 'C1'), cube('b', 'C2')), calls(cube('c', 'C3'), cube('d', 'C4')), say('Four cubes.')]
    const chat = new ChatController({
      ctx: app.ctx,
      maxChanges: 3,
      getAdapter: async () => ({ family: 'anthropic', createSession: (c) => { const s = new FakeSession(c, script); sessions.push(s); return s }, listModels: async () => [] }),
      systemPrompt: async () => 'SYSTEM',
      appState: () => '',
    })
    chat.configure(config())
    await chat.send('make four cubes')
    expect(app.past()).toEqual(['AI: Add C1', 'AI: Add C2', 'AI: Add C3', 'AI: Add C4'])
    expect(chat.lastEnd).toBe('limit')
    expect(chat.entries.filter((e) => e.kind === 'notice').map((e) => (e as { text: string }).text))
      .toEqual(['Paused after 4 changes in one message, so all of them can still be undone. Press Continue to let it keep going.'])
    expect(chat.canContinue).toBe(true)
    await chat.continue()
    expect(chat.lastEnd).toBe('end')
    expect(chat.entries.at(-1)).toMatchObject({ kind: 'assistant', text: 'Four cubes.' })
  })
})

describe('chat loop: settings and sessions', () => {
  it('no provider, no key, no model: an error notice; the message waits and continue() sends it once the settings are fixed', async () => {
    const { chat, sessions, notices } = setup([[say('Hi!')]])
    chat.configure(config({ apiKey: '' }))
    await chat.send('hello')
    expect(notices()).toEqual(['Add your Anthropic API key in the chat settings.'])
    expect(sessions).toHaveLength(0)
    chat.configure(config())
    expect(chat.canContinue).toBe(true)
    await chat.continue()
    expect(sessions[0].history[0]).toMatchObject({ role: 'user', text: expect.stringMatching(/hello$/) })
    expect(chat.entries.at(-1)).toMatchObject({ kind: 'assistant', text: 'Hi!' })
    const none = setup([[]])
    none.chat.configure(null)
    await none.chat.send('x')
    expect(none.notices()).toEqual(['Choose a provider and a model in the chat settings first.'])
    none.chat.configure(config({ model: ' ' }))
    await none.chat.send('y')
    expect(none.notices().at(-1)).toBe('Choose a model in the chat settings.')
  })

  it('a different model starts a fresh session with an info notice; the same settings keep the session', async () => {
    const { chat, sessions, notices } = setup([[say('One.'), say('Two.')], [say('Three.')]])
    await chat.send('a')
    chat.configure(config()) // equal: nothing happens
    await chat.send('b')
    expect(sessions).toHaveLength(1)
    chat.configure(config({ model: 'm2' }))
    expect(notices()).toEqual(['Now using Anthropic · m2. This starts a fresh conversation: the model does not see the messages above.'])
    await chat.send('c')
    expect(sessions).toHaveLength(2)
    expect(sessions[1].config.model).toBe('m2')
    expect(sessions[1].history[0]).toMatchObject({ role: 'user', text: expect.stringMatching(/c$/) })
    chat.configure(config({ model: 'm2', apiKey: 'sk-other-key-000000000' }))
    expect(notices().at(-1)).toBe('The chat settings changed. This starts a fresh conversation: the model does not see the messages above.')
  })

  it('vision off: images stay in the transcript but the model gets a note instead; no new session', async () => {
    const { chat, sessions, tool } = setup([[calls({ id: 'a', name: 'screenshot' }), say('Looks fine.'), calls({ id: 'b', name: 'screenshot' }), say('Still fine.')]])
    await chat.send('look')
    expect((sessions[0].history[2] as { results: { output: ToolOutput }[] }).results[0].output.images).toHaveLength(1)
    chat.configure(config({ vision: false }))
    expect(sessions[0].config.vision).toBe(false) // the adapter reads it from its session config
    await chat.send('look again')
    expect(sessions).toHaveLength(1)
    const out = (sessions[0].history[6] as { results: { output: ToolOutput }[] }).results[0].output
    expect(out.images).toBeUndefined()
    expect(out.text).toMatch(/^Shows the scene\.\n\n\(The image is not shown to you: images are turned off/)
    expect(tool('screenshot').images).toEqual([{ mediaType: 'image/png', base64: 'iVBOR' }])
  })

  it('configure() during a run takes effect when the run ends', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { chat, sessions } = setup([[async (req) => { await gate; return say('Done.')(req) }], [say('New model.')]])
    const done = chat.send('go')
    await tick()
    chat.configure(config({ model: 'm2' }))
    expect(chat.config?.model).toBe('m2')
    release()
    await done
    expect(sessions).toHaveLength(1)
    await chat.send('next')
    expect(sessions[1].config.model).toBe('m2')
  })

  it('usage: context size from the last turn (Anthropic: cache included), output tokens summed', async () => {
    const { chat } = setup([[
      calls({ id: 'a', name: 'get_scene' }),
      (req) => { req.onEvent({ type: 'usage', usage: { inputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 10 } }); return say('Ok.', { outputTokens: 7 })(req) },
    ]])
    await chat.send('go')
    expect(chat.usage).toEqual({ contextTokens: 1060, outputTokens: 7, turns: 2 })
  })

  it('newChat stops a run and clears the transcript and the session', async () => {
    const { chat, sessions } = setup([[hang], [say('Fresh.')]])
    const done = chat.send('go')
    await tick()
    await chat.newChat()
    await done
    expect(chat.entries).toEqual([])
    expect(chat.state).toBe('idle')
    await chat.send('hi')
    expect(sessions).toHaveLength(2)
    expect(sessions[1].history.map((x) => x.role)).toEqual(['user', 'assistant'])
    expect(chat.usage.turns).toBe(1)
  })

  it('send while running is ignored; an empty message too', async () => {
    const { chat, sessions } = setup([[hang]])
    const done = chat.send('go')
    await tick()
    await chat.send('again')
    await chat.send('   ')
    chat.stop()
    await done
    expect(chat.entries.filter((e) => e.kind === 'user')).toHaveLength(1)
    expect(sessions[0].history.filter((x) => x.role === 'user')).toHaveLength(1)
  })

  it('the tools and the system prompt load once; a failed load is retried and the message is not lost', async () => {
    let loads = 0
    const tools = [fakeTool('get_scene', () => ({ text: '{}' }))]
    const { chat, sessions, notices } = setup([[say('One.'), say('Two.')]], {
      loadTools: async () => { loads++; if (loads === 1) throw new Error('Failed to fetch dynamically imported module'); return tools },
    })
    await chat.send('first')
    expect(notices()).toEqual(['Something went wrong: Failed to fetch dynamically imported module'])
    expect(chat.canContinue).toBe(true)
    await chat.continue()
    expect(sessions[0].history[0]).toMatchObject({ role: 'user', text: expect.stringMatching(/first$/) })
    await chat.send('second')
    expect(loads).toBe(2)
  })

  it('a listener that throws does not break the loop', async () => {
    const { chat } = setup([[say('Fine.')]])
    chat.subscribe(() => { throw new Error('render bug') })
    const errors: unknown[] = []
    const onErr = (e: unknown) => { errors.push(e) }
    process.on('uncaughtException', onErr)
    try {
      await chat.send('go')
      await tick()
    } finally {
      process.off('uncaughtException', onErr)
    }
    expect(chat.entries.at(-1)).toMatchObject({ kind: 'assistant', text: 'Fine.' })
    expect(errors.length).toBeGreaterThan(0)
  })
})
