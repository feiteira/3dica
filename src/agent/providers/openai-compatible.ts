// OpenAI-compatible Chat Completions adapter (OpenAI, OpenRouter, Gemini, Groq, Mistral, DeepSeek, Ollama, LM Studio,
// any custom server), on the official `openai` SDK, called straight from the browser tab.
//   - streamed; tool calls are put together by index (id and name come first, the arguments in fragments, several
//     calls can interleave), and every input is parsed strictly before a call counts as runnable
//   - the SDK's x-stainless-* telemetry headers are removed: Mistral's and Gemini's CORS preflights reject them, and
//     a custom or local server is more likely to accept a request with only authorization + content-type
//   - tool results: one role:'tool' message per call; screenshots follow in ONE user message (most servers do not take
//     images inside a tool message)
//   - history is append-only; a stream that was stopped or refused is not appended. One exception, made per request
//     and never stored: the screenshot messages go out as text when images are off in the settings, when OpenRouter's
//     model list says the model reads no images, or after the server refused them once in this session (the turn is
//     then sent again without them). A text-only model would otherwise refuse every later request of the chat.
//   - echoed back as the server sent them: Gemini's thought signatures (tool_calls[].extra_content; Gemini 3 answers
//     400 without them) and DeepSeek's reasoning_content (required back in thinking mode with tools)
import OpenAI, {
  APIConnectionError, APIError, APIUserAbortError, AuthenticationError, BadRequestError, InternalServerError,
  NotFoundError, PermissionDeniedError, RateLimitError, UnprocessableEntityError,
} from 'openai'
import type {
  ChatCompletionAssistantMessageParam, ChatCompletionChunk, ChatCompletionContentPart,
  ChatCompletionCreateParamsStreaming, ChatCompletionFunctionTool, ChatCompletionMessageParam,
} from 'openai/resources/chat/completions'
import {
  ProviderError, type AgentTool, type ChatSession, type ProviderAdapter, type ProviderConfig, type ToolCall,
  type ToolOutput, type TurnEvent, type TurnResult, type TurnUsage,
} from '../types'
import { abortedError, networkError, NOT_RUN_TEXT, parseToolInput, redact, resolveKey, resultText, trimBaseUrl } from './common'

const LIST_CAP = 200
const SCREENSHOT_NOTE = 'Screenshots returned by the tool calls above (in order).'
const TEXT_ONLY_NOTICE = 'This model does not take images, so screenshots reach it as text only from now on.'
/** presets known to accept stream_options.include_usage (others may reject the field) */
const USAGE_PRESETS = new Set(['openai', 'openrouter'])
/** local servers: list whatever they serve */
const LOCAL_PRESETS = new Set(['ollama', 'lmstudio', 'custom'])
const STAINLESS_HEADERS = [
  'X-Stainless-Lang', 'X-Stainless-Package-Version', 'X-Stainless-OS', 'X-Stainless-Arch', 'X-Stainless-Runtime',
  'X-Stainless-Runtime-Version', 'X-Stainless-Retry-Count', 'X-Stainless-Timeout', 'X-Stainless-Helper-Method',
]
/** OpenRouter app attribution (both headers are in its CORS allow-list) */
const OPENROUTER_HEADERS = { 'HTTP-Referer': 'https://feiteira.github.io/3dica/', 'X-Title': '3Dica' }
/** model families listed first on OpenRouter (then everything else, newest first) */
const FEATURED_VENDORS = ['anthropic/', 'openai/', 'google/', 'x-ai/', 'deepseek/', 'mistralai/', 'qwen/', 'moonshotai/', 'z-ai/', 'meta-llama/']

/** OpenAI's reasoning models (o-series, gpt-5 and later) take reasoning_effort; chat/image/audio variants do not. */
export function isOpenAIReasoningModel(model: string): boolean {
  return /^(o\d|gpt-([5-9]|\d\d))/.test(model) && !/(chat|image|audio|search|realtime|transcribe|tts)/.test(model)
}

/** reasoning_effort for this request, or undefined to leave it out. OpenRouter: when its model list says the model
 *  takes it (or the list was not fetched: OpenRouter drops parameters a model does not support). */
export function reasoningEffortFor(config: ProviderConfig, openRouterParams?: string[]): 'low' | 'medium' | 'high' | undefined {
  const e = config.effort
  if (!e) return undefined
  const ok = config.preset.id === 'openai' ? isOpenAIReasoningModel(config.model)
    : config.preset.id === 'openrouter' ? (openRouterParams ? openRouterParams.includes('reasoning_effort') : true)
    : false
  if (!ok) return undefined
  return e === 'xhigh' || e === 'max' ? 'high' : e
}

/** The request body of one turn (exported for the tests). */
export function buildRequest(
  config: ProviderConfig, req: { system: string; tools: AgentTool[] }, history: ChatCompletionMessageParam[], openRouterParams?: string[],
): ChatCompletionCreateParamsStreaming {
  const tools: ChatCompletionFunctionTool[] = [...req.tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }))
  const effort = reasoningEffortFor(config, openRouterParams)
  return {
    model: config.model,
    stream: true,
    messages: [...(req.system ? [{ role: 'system' as const, content: req.system }] : []), ...history],
    ...(tools.length ? { tools } : {}),
    ...(USAGE_PRESETS.has(config.preset.id) ? { stream_options: { include_usage: true } } : {}),
    ...(effort ? { reasoning_effort: effort } : {}),
  }
}

function usageOf(u: NonNullable<ChatCompletionChunk['usage']>): TurnUsage {
  return {
    inputTokens: u.prompt_tokens ?? undefined,
    outputTokens: u.completion_tokens ?? undefined,
    cacheReadTokens: u.prompt_tokens_details?.cached_tokens ?? undefined,
  }
}

function apiMessage(err: APIError): string {
  const e = err.error as { message?: unknown } | undefined
  return typeof e?.message === 'string' && e.message ? e.message : err.message
}

/** SDK error → ProviderError, most specific first. Errors sent inside the stream carry no HTTP status, only a code.
 *  The message is the API's own text (see ./common.ts); the key never reaches it. */
export function toProviderError(err: unknown, config: Pick<ProviderConfig, 'apiKey' | 'baseUrl' | 'preset'>): ProviderError {
  if (err instanceof ProviderError) return err
  if (err instanceof APIUserAbortError) return abortedError()
  const base = config.baseUrl || config.preset.baseUrl
  if (err instanceof APIConnectionError) return networkError(base) // also how a CORS block shows up
  const label = config.preset.label
  if (err instanceof APIError) {
    const code = Number((err.error as { code?: unknown } | undefined)?.code)
    const status = err.status ?? (code >= 400 && code < 600 ? code : undefined)
    const msg = redact(apiMessage(err), config.apiKey)
    if (err instanceof AuthenticationError || status === 401) {
      return new ProviderError('auth', config.preset.needsKey
        ? `${label} did not accept the API key. Check it in the chat settings.`
        : 'The server asked for an API key. Add one in the chat settings.', { status })
    }
    if (err instanceof PermissionDeniedError || status === 403 || status === 402) return new ProviderError('permission', msg, { status })
    if (err instanceof NotFoundError || status === 404) return new ProviderError('not_found', msg, { status })
    if (err instanceof RateLimitError || status === 429) return new ProviderError('rate_limit', msg, { status })
    if (status === 529) return new ProviderError('overloaded', msg, { status })
    if (err instanceof BadRequestError || err instanceof UnprocessableEntityError || status === 400 || status === 413 || status === 422) {
      return new ProviderError('bad_request', msg, { status })
    }
    if (err instanceof InternalServerError || (status !== undefined && status >= 500)) return new ProviderError('server', msg, { status })
    return new ProviderError('other', `${status ? `HTTP ${status}: ` : ''}${msg}`, { status })
  }
  if (err instanceof Error && err.name === 'AbortError') return abortedError()
  return new ProviderError('other', redact(err instanceof Error ? err.message : String(err), config.apiKey))
}

/** Did the server refuse the request because of the screenshots in it? (DeepSeek: "unknown variant `image_url`";
 *  OpenRouter: "No endpoints found that support image input"; servers that want string content.) Not a size limit. */
export function refusesImages(e: ProviderError): boolean {
  if (e.kind !== 'bad_request' && e.kind !== 'not_found' && e.kind !== 'other') return false
  return /image|vision|multimodal|modalit|must be a string|expected a string/i.test(e.message) && !/too many|too large|exceed|maximum|size/i.test(e.message)
}

type ImagesOff = 'settings' | 'model' | null

/** The history as one request sends it: each screenshot message becomes one line of text when images are off. */
export function requestHistory(history: ChatCompletionMessageParam[], off: ImagesOff): ChatCompletionMessageParam[] {
  if (!off) return history
  return history.map((m) => {
    if (m.role !== 'user' || !Array.isArray(m.content)) return m
    const n = m.content.filter((p) => p.type === 'image_url').length
    if (!n) return m
    const why = off === 'settings' ? 'images are turned off in the chat settings' : 'this model does not take images'
    return { role: 'user', content: `(${n === 1 ? 'The screenshot' : `${n} screenshots`} of the tool calls above ${n === 1 ? 'is' : 'are'} not shown to you: ${why}. Use the text of the tool results, get_scene and get_errors.)` }
  })
}

const hasImages = (history: ChatCompletionMessageParam[]): boolean =>
  history.some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'))

interface Slot { id: string; name: string; args: string; started: boolean; extra?: unknown }

/** What one streamed request produced. */
interface Streamed {
  slots: Map<number, Slot>
  text: string
  reasoningContent: string
  refusal: string
  finish: string | null
  usage?: TurnUsage
  model?: string
}

interface AdapterOptions {
  /** a fetch implementation for the SDK (tests) */
  fetch?: typeof fetch
}

export function createOpenAICompatibleAdapter(opts: AdapterOptions = {}): ProviderAdapter {
  // OpenRouter model id → supported_parameters, from the last model list (decides reasoning_effort)
  const openRouterParams = new Map<string, string[]>()
  // OpenRouter model id → architecture.input_modalities (a model without 'image' gets its screenshots as text)
  const openRouterInputs = new Map<string, string[]>()

  function makeClient(config: Omit<ProviderConfig, 'model'>): OpenAI {
    const baseURL = trimBaseUrl(config.baseUrl || config.preset.baseUrl)
    if (!baseURL) throw new ProviderError('other', 'Enter the base URL of the server in the chat settings.', { retryable: false })
    const headers: Record<string, string | null> = {}
    for (const h of STAINLESS_HEADERS) headers[h] = null
    if (config.preset.id === 'openrouter') Object.assign(headers, OPENROUTER_HEADERS)
    return new OpenAI({
      apiKey: resolveKey(config),
      baseURL,
      organization: null,
      project: null,
      dangerouslyAllowBrowser: true,
      maxRetries: 2,
      logLevel: 'off', // SDK debug logs could carry request details
      defaultHeaders: headers,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    })
  }

  class OpenAICompatibleSession implements ChatSession {
    readonly config: ProviderConfig
    private readonly history: ChatCompletionMessageParam[] = []
    /** tool_call ids of the last appended turn that still need a tool message */
    private pending: string[] = []
    private client: OpenAI | null = null
    private callSeq = 0
    /** the server refused images once in this session: screenshots go as text from then on */
    private textOnly = false
    /** the user was told (TurnResult.notice) that screenshots reach this model as text */
    private toldTextOnly = false

    constructor(config: ProviderConfig) {
      this.config = config
    }

    addUser(text: string): void {
      this.answerPending()
      this.history.push({ role: 'user', content: text.trim() ? text : '(empty message)' })
    }

    addToolResults(results: { call: ToolCall; output: ToolOutput }[]): void {
      if (!results.length) return
      const byId = new Map(results.map((r) => [r.call.id, r.output]))
      const ordered: [string, ToolOutput | null][] = this.pending.map((id) => [id, byId.get(id) ?? null])
      for (const id of this.pending) byId.delete(id)
      for (const [id, output] of byId) ordered.push([id, output])
      this.pending = []
      const images: string[] = []
      for (const [id, output] of ordered) {
        const text = output ? resultText(output) : NOT_RUN_TEXT
        // the chat's error results already start with "Error: " (Chat Completions has no is_error flag)
        this.history.push({ role: 'tool', tool_call_id: id, content: output?.isError && !/^error\b/i.test(text) ? `Error: ${text}` : text })
        if (output && this.config.vision) for (const img of output.images ?? []) images.push(`data:${img.mediaType};base64,${img.base64}`)
      }
      if (images.length) {
        const content: ChatCompletionContentPart[] = [
          { type: 'text', text: SCREENSHOT_NOTE },
          ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
        ]
        this.history.push({ role: 'user', content })
      }
    }

    async runTurn(req: { system: string; tools: AgentTool[]; signal: AbortSignal; onEvent: (e: TurnEvent) => void }): Promise<TurnResult> {
      const { signal, onEvent } = req
      if (signal.aborted) throw abortedError()
      this.answerPending()
      const client = this.getClient()
      let notice: string | undefined
      if (this.imagesOff() === 'model' && !this.toldTextOnly && hasImages(this.history)) {
        this.toldTextOnly = true
        notice = TEXT_ONLY_NOTICE
      }
      let emitted = false
      const send = () => this.stream(client, req, requestHistory(this.history, this.imagesOff()), (e) => { emitted = true; onEvent(e) })
      let s: Streamed
      try {
        s = await send()
      } catch (err) {
        if (signal.aborted) throw abortedError()
        const e = toProviderError(err, this.config)
        // a model that reads no images refused the screenshots: send this turn again without them, and the rest of the
        // session too (only when nothing of the refused attempt reached the transcript)
        if (emitted || this.imagesOff() || !hasImages(this.history) || !refusesImages(e)) throw e
        this.textOnly = true
        this.toldTextOnly = true
        notice = TEXT_ONLY_NOTICE
        try {
          s = await send()
        } catch (err2) {
          if (signal.aborted) throw abortedError()
          throw toProviderError(err2, this.config)
        }
      }
      // the SDK ends the iteration quietly when the request is aborted mid-stream
      if (signal.aborted) throw abortedError()
      const { text, refusal, finish, usage, model } = s
      if (usage) onEvent({ type: 'usage', usage })
      const base = { text, usage, model: model || this.config.model, ...(notice ? { notice } : {}) }

      const calls = [...s.slots].sort((a, b) => a[0] - b[0]).map(([, slot]) => slot).filter((slot) => slot.started)
      if (finish === 'content_filter' || (refusal && !text && !calls.length)) {
        return { ...base, stop: 'refusal', toolCalls: [], refusal: refusal || `${this.config.preset.label} stopped this answer with its content filter.` }
      }

      // cut at the output limit: the call that was streaming last may be incomplete, so it never runs; the calls
      // before it were complete (a cut JSON object never parses strictly, so those are checked as usual)
      const cut = finish === 'length'
      const toolCalls: ToolCall[] = calls.map((slot, i) => (cut && i === calls.length - 1
        ? { id: slot.id, name: slot.name, input: undefined, inputError: 'truncated' }
        : { id: slot.id, name: slot.name, ...parseToolInput(slot.args) }))
      if (text || calls.length) {
        const msg: ChatCompletionAssistantMessageParam = { role: 'assistant', content: text || null }
        if (calls.length) {
          // the arguments as the model sent them; input that is not a JSON object is stored as {} because some servers
          // parse the history's arguments and would refuse the whole request (the tool result explains the error)
          msg.tool_calls = calls.map((slot, i) => ({
            id: slot.id, type: 'function', function: { name: slot.name, arguments: toolCalls[i].inputError ? '{}' : slot.args.trim() || '{}' },
            ...(slot.extra !== undefined ? { extra_content: slot.extra } : {}),
          }))
        }
        if (s.reasoningContent) (msg as ChatCompletionAssistantMessageParam & { reasoning_content?: string }).reasoning_content = s.reasoningContent
        this.history.push(msg)
      }
      this.pending = toolCalls.map((c) => c.id)
      if (cut) return { ...base, stop: 'max_tokens', toolCalls }
      return { ...base, stop: toolCalls.length ? 'tool_use' : 'end', toolCalls }
    }

    /** Why the screenshots are not sent as images in this request (null: they are). */
    private imagesOff(): ImagesOff {
      if (!this.config.vision) return 'settings'
      if (this.textOnly) return 'model'
      const modalities = this.config.preset.id === 'openrouter' ? openRouterInputs.get(this.config.model) : undefined
      return modalities && !modalities.includes('image') ? 'model' : null
    }

    /** One streamed request; tool calls are put together by index. */
    private async stream(client: OpenAI, req: { system: string; tools: AgentTool[]; signal: AbortSignal }, history: ChatCompletionMessageParam[], onEvent: (e: TurnEvent) => void): Promise<Streamed> {
      const params = buildRequest(this.config, req, history, openRouterParams.get(this.config.model))
      const out: Streamed = { slots: new Map(), text: '', reasoningContent: '', refusal: '', finish: null }
      const slots = out.slots
      let lastSlot = -1
      const stream = await client.chat.completions.create(params, { signal: req.signal })
      for await (const chunk of stream) {
        if (chunk.model) out.model = chunk.model
        if (chunk.usage) out.usage = usageOf(chunk.usage)
        const choice = chunk.choices?.[0]
        if (!choice) continue
        const d = choice.delta ?? {}
        if (d.content) {
          out.text += d.content
          onEvent({ type: 'text', delta: d.content })
        }
        // reasoning text, where servers send it (DeepSeek: reasoning_content, which goes back with the turn;
        // OpenRouter: reasoning, shown only)
        const rc = (d as { reasoning_content?: unknown }).reasoning_content
        if (typeof rc === 'string') out.reasoningContent += rc
        const r = rc ?? (d as { reasoning?: unknown }).reasoning
        if (typeof r === 'string' && r) onEvent({ type: 'thinking', delta: r })
        if (d.refusal) out.refusal += d.refusal
        for (const tc of d.tool_calls ?? []) {
          // the index says which call a fragment belongs to; a few servers leave it out and send whole calls
          let idx: number
          if (typeof tc.index === 'number') idx = tc.index
          else {
            const known = tc.id ? [...slots].find(([, s]) => s.id === tc.id)?.[0] : undefined
            const fresh = Math.max(-1, ...slots.keys()) + 1
            if (known !== undefined) idx = known
            else if (tc.id || (tc.function?.name && slots.get(lastSlot)?.name)) idx = fresh // a new whole call
            else idx = lastSlot >= 0 ? lastSlot : fresh // a fragment of the current call
          }
          lastSlot = idx
          let slot = slots.get(idx)
          if (!slot) slots.set(idx, (slot = { id: '', name: '', args: '', started: false }))
          if (tc.id && !slot.id) slot.id = tc.id
          if (tc.function?.name && !slot.name) slot.name = tc.function.name // some servers repeat the name in every fragment
          if (tc.function?.arguments) slot.args += tc.function.arguments
          const extra = (tc as { extra_content?: unknown }).extra_content
          if (extra != null && slot.extra === undefined) slot.extra = extra // Gemini's thought signature
          if (!slot.started && slot.name) {
            slot.id ||= `call_${++this.callSeq}` // a server that sends no id: ours is used for the result too
            slot.started = true
            onEvent({ type: 'tool_start', id: slot.id, name: slot.name })
          }
          if (slot.started && tc.function?.arguments) onEvent({ type: 'tool_input', id: slot.id, partialJson: slot.args })
        }
        if (choice.finish_reason) out.finish = choice.finish_reason
      }
      return out
    }

    /** a tool call the loop never answered (Stop, new message) gets a "not run" result, or the next request fails */
    private answerPending(): void {
      for (const id of this.pending) this.history.push({ role: 'tool', tool_call_id: id, content: NOT_RUN_TEXT })
      this.pending = []
    }

    private getClient(): OpenAI {
      try {
        return (this.client ??= makeClient(this.config))
      } catch (err) {
        throw toProviderError(err, this.config)
      }
    }
  }

  return {
    family: 'openai-compatible',
    createSession: (config) => new OpenAICompatibleSession(config),
    async listModels(config, signal) {
      let client: OpenAI
      try {
        client = makeClient(config)
      } catch (err) {
        throw toProviderError(err, config)
      }
      const raw: Record<string, unknown>[] = []
      try {
        for await (const m of client.models.list({ signal })) {
          raw.push(m as unknown as Record<string, unknown>)
          if (raw.length >= 1000) break
        }
      } catch (err) {
        if (signal?.aborted) throw abortedError()
        throw toProviderError(err, config)
      }
      return pickModels(config.preset.id, config.preset.defaultModel, raw, openRouterParams, openRouterInputs).slice(0, LIST_CAP)
    },
  }
}

/** Filter and order a /models response for the settings list (exported for the tests). */
export function pickModels(
  presetId: string, defaultModel: string, raw: Record<string, unknown>[], openRouterParams?: Map<string, string[]>, openRouterInputs?: Map<string, string[]>,
): string[] {
  const created = (m: Record<string, unknown>) => (typeof m.created === 'number' ? m.created : 0)
  let list = raw.filter((m) => typeof m.id === 'string' && m.id)
  if (presetId === 'openrouter') {
    list = list.filter((m) => {
      const params = Array.isArray(m.supported_parameters) ? (m.supported_parameters as string[]) : undefined
      if (params) openRouterParams?.set(m.id as string, params)
      const inputs = (m.architecture as { input_modalities?: unknown } | undefined)?.input_modalities
      if (Array.isArray(inputs)) openRouterInputs?.set(m.id as string, inputs.map(String))
      const endpoints = Array.isArray(m.endpoints) ? (m.endpoints as string[]) : undefined
      // tool use is what the chat needs; ':batch' variants have no chat endpoint
      return (!params || params.includes('tools')) && (!endpoints || endpoints.some((e) => String(e).endsWith('/chat/completions')))
    })
  } else if (presetId === 'openai') {
    // chat models only: the -pro, codex and deep-research models answer only on the Responses API, and chatgpt-* has
    // no function calling
    list = list.filter((m) => /^(gpt-|o\d)/.test(m.id as string)
      && !/(embed|tts|whisper|dall-e|transcribe|realtime|audio|image|search|moderation|instruct|codex|deep-research|-pro\b)/.test(m.id as string))
  } else if (!LOCAL_PRESETS.has(presetId)) {
    list = list.filter((m) => !/(embed|whisper|tts|moderation|transcri|rerank|imagen|veo|guard)/i.test(m.id as string))
  }
  const featured = (id: string) => (presetId === 'openrouter' && FEATURED_VENDORS.some((v) => id.startsWith(v)) ? 0 : 1)
  if (!LOCAL_PRESETS.has(presetId)) {
    list = [...list].sort((a, b) => featured(a.id as string) - featured(b.id as string) || created(b) - created(a))
  }
  const ids = list.map((m) => m.id as string)
  const i = defaultModel ? ids.indexOf(defaultModel) : -1
  if (i > 0) ids.unshift(...ids.splice(i, 1))
  return ids
}

export const adapter: ProviderAdapter = createOpenAICompatibleAdapter()
