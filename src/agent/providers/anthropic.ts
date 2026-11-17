// Anthropic Messages API adapter, on the official @anthropic-ai/sdk, called straight from the browser tab
// (dangerouslyAllowBrowser: the key is the user's own and goes only to api.anthropic.com).
// Request shape, per Anthropic's current guidance:
//   - streamed (max_tokens 64000, clamped to the model's output cap from the Models API), finalMessage() for the result
//   - adaptive thinking with summarized display + output_config.effort, only on models that take them (Claude 4.6+)
//   - server-side refusal fallbacks (beta) on the models that have them; the model that actually answered is reported
//   - prompt caching: top-level cache_control, system as one text block, tools sorted by name, history append-only
//   - tools stream their input eagerly (eager_input_streaming), so the server no longer validates it: the adapter
//     parses each input strictly itself and checks max_tokens / refusal before any call counts as runnable
//   - never temperature / top_p / top_k, never a thinking budget or disabled thinking, never a forced tool_choice
import Anthropic, {
  AnthropicError, APIConnectionError, APIError, APIUserAbortError, AuthenticationError, BadRequestError,
  InternalServerError, NotFoundError, PermissionDeniedError, RateLimitError,
} from '@anthropic-ai/sdk'
import type {
  BetaContentBlock, BetaContentBlockParam, BetaMessage, BetaMessageParam, BetaMessageStreamParams, BetaTool,
  BetaToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import {
  ProviderError, type AgentTool, type ChatSession, type Effort, type ProviderAdapter, type ProviderConfig, type ToolCall,
  type ToolOutput, type TurnEvent, type TurnResult, type TurnUsage,
} from '../types'
import { abortedError, networkError, NOT_RUN_TEXT, parseToolInput, redact, resolveKey, resultText, trimBaseUrl } from './common'

const MAX_TOKENS = 64000
const DEFAULT_EFFORT: Effort = 'medium'
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'
/** models with server-side refusal fallbacks (`fallbacks: 'default'` routes by refusal category) */
// (platform.claude.com refusals-and-fallback; Haiku 5.5 has none, Mythos is not confirmed there)
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-2', 'claude-fable-5-1', 'claude-fable-5', 'claude-sonnet-5-5'])
const PREFERRED_MODEL = 'claude-opus-5-5'
const LIST_CAP = 200

/** Family and version of a Claude model id ('claude-opus-4-6', 'claude-opus-5', 'claude-haiku-4-5-20251001'). */
export function parseClaudeModel(id: string): { family: string; version: number } | null {
  const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?=-|$)/.exec(id)
  if (!m) return null
  return { family: m[1], version: Number(m[2]) + Number(m[3] ?? 0) / 100 }
}

/** Adaptive thinking and output_config.effort: Claude 4.6+ Opus / Sonnet, Haiku 5+, Fable and Mythos 5+. Older or
 *  unknown ids (claude-haiku-4-5, claude-3-*) get a plain request. */
export function supportsAdaptive(model: string): boolean {
  const p = parseClaudeModel(model)
  if (!p) return false
  if (p.family === 'opus' || p.family === 'sonnet') return p.version >= 4.06
  return p.version >= 5
}

export function usesFallbacks(model: string): boolean {
  return FALLBACK_MODELS.has(model)
}

/** The effort to send: 'xhigh' arrived with Claude 4.7, so 4.6 models get 'high' instead. */
export function effortFor(model: string, effort: Effort | undefined): Effort {
  const e = effort ?? DEFAULT_EFFORT
  const p = parseClaudeModel(model)
  return e === 'xhigh' && p && p.version < 4.07 ? 'high' : e
}

/** The request body of one turn (exported for the tests). */
export function buildParams(config: ProviderConfig, req: { system: string; tools: AgentTool[] }, history: BetaMessageParam[], maxTokens: number): BetaMessageStreamParams {
  const model = config.model
  const tools: BetaTool[] = [...req.tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as BetaTool.InputSchema, eager_input_streaming: true }))
  return {
    model,
    max_tokens: maxTokens,
    messages: [...history],
    cache_control: { type: 'ephemeral' },
    ...(req.system ? { system: [{ type: 'text' as const, text: req.system }] } : {}),
    ...(tools.length ? { tools } : {}),
    ...(supportsAdaptive(model)
      ? { thinking: { type: 'adaptive' as const, display: 'summarized' as const }, output_config: { effort: effortFor(model, config.effort) } }
      : {}),
    ...(usesFallbacks(model) ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
  }
}

/** What goes back into the history: the content verbatim, except after a mid-output server-side fallback, where the
 *  documented echo rule applies: before the last `fallback` block keep only text and the fallback blocks themselves
 *  (thinking and tool_use from the declined attempt are dropped; the fallback block stays where it was). */
export function echoContent(content: BetaContentBlock[]): BetaContentBlock[] {
  let boundary = -1
  content.forEach((b, i) => { if (b.type === 'fallback') boundary = i })
  if (boundary < 0) return content
  return content.filter((b, i) => i >= boundary || b.type === 'text' || b.type === 'fallback')
}

function usageOf(msg: BetaMessage): TurnUsage {
  const u = msg.usage
  return {
    inputTokens: u.input_tokens ?? undefined,
    outputTokens: u.output_tokens ?? undefined,
    cacheReadTokens: u.cache_read_input_tokens ?? undefined,
    cacheWriteTokens: u.cache_creation_input_tokens ?? undefined,
  }
}

function refusalText(msg: BetaMessage): string {
  const d = msg.stop_details // informational only, and may be null even on a refusal
  return [
    `The model declined this request${d?.category ? ` (${d.category})` : ''}.`,
    d?.explanation ?? '',
    d?.recommended_model ? `You could try ${d.recommended_model}.` : '',
  ].filter(Boolean).join(' ')
}

function apiMessage(err: APIError): string {
  const body = err.error as { error?: { message?: unknown } } | undefined
  const m = body?.error?.message
  return typeof m === 'string' && m ? m : err.message
}

/** SDK error → ProviderError, most specific class first. The message is the API's own text (see ./common.ts); the key
 *  never reaches it. */
export function toProviderError(err: unknown, key: string, baseUrl: string): ProviderError {
  if (err instanceof ProviderError) return err
  if (err instanceof APIUserAbortError) return abortedError()
  if (err instanceof APIConnectionError) return networkError(baseUrl || 'https://api.anthropic.com') // also how a CORS block shows up
  if (err instanceof APIError) {
    const status = err.status
    const type = err.type
    const msg = redact(apiMessage(err), key)
    if (err instanceof AuthenticationError || type === 'authentication_error') {
      return new ProviderError('auth', 'Anthropic did not accept the API key. Check it in the chat settings.', { status })
    }
    if (err instanceof PermissionDeniedError || type === 'permission_error' || type === 'billing_error' || status === 402) {
      return new ProviderError('permission', msg, { status })
    }
    if (err instanceof NotFoundError || type === 'not_found_error') return new ProviderError('not_found', msg, { status })
    if (err instanceof RateLimitError || type === 'rate_limit_error') return new ProviderError('rate_limit', msg, { status })
    if (status === 529 || type === 'overloaded_error') return new ProviderError('overloaded', msg, { status })
    if (err instanceof BadRequestError || type === 'invalid_request_error' || status === 413) return new ProviderError('bad_request', msg, { status })
    if (err instanceof InternalServerError || type === 'api_error' || type === 'timeout_error') return new ProviderError('server', msg, { status })
    return new ProviderError('other', `${status ? `HTTP ${status}: ` : ''}${msg}`, { status })
  }
  if (err instanceof Error && err.name === 'AbortError') return abortedError()
  return new ProviderError('other', redact(err instanceof Error ? err.message : String(err), key))
}

interface AdapterOptions {
  /** a fetch implementation for the SDK (tests) */
  fetch?: typeof fetch
}

export function createAnthropicAdapter(opts: AdapterOptions = {}): ProviderAdapter {
  // max output tokens per base URL + model, from the Models API; lives as long as the page
  const limits = new Map<string, number | null>()

  function customBase(config: Pick<ProviderConfig, 'baseUrl' | 'preset'>): string | undefined {
    const base = trimBaseUrl(config.baseUrl)
    return base && base !== trimBaseUrl(config.preset.baseUrl) ? base : undefined
  }

  function makeClient(config: Omit<ProviderConfig, 'model'>): Anthropic {
    return new Anthropic({
      apiKey: resolveKey(config),
      baseURL: customBase(config),
      dangerouslyAllowBrowser: true,
      maxRetries: 2,
      logLevel: 'off', // SDK debug logs could carry request details
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    })
  }

  const limitKey = (config: Pick<ProviderConfig, 'baseUrl' | 'preset'>, model: string) => `${customBase(config) ?? ''}|${model}`

  class AnthropicSession implements ChatSession {
    readonly config: ProviderConfig
    private readonly history: BetaMessageParam[] = []
    /** tool_use ids of the last appended turn that still need a tool_result */
    private pending: string[] = []
    private client: Anthropic | null = null

    constructor(config: ProviderConfig) {
      this.config = config
    }

    addUser(text: string): void {
      const content: BetaContentBlockParam[] = this.takePending()
      content.push({ type: 'text', text: text.trim() ? text : '(empty message)' })
      this.history.push({ role: 'user', content })
    }

    addToolResults(results: { call: ToolCall; output: ToolOutput }[]): void {
      if (!results.length) return
      const byId = new Map(results.map((r) => [r.call.id, r.output]))
      const blocks: BetaToolResultBlockParam[] = []
      // in call order; a call the loop left out gets a "not run" answer, or the API refuses the next request
      for (const id of this.pending) {
        const output = byId.get(id)
        blocks.push(output ? this.resultBlock(id, output) : notRun(id))
        byId.delete(id)
      }
      for (const [id, output] of byId) blocks.push(this.resultBlock(id, output))
      this.pending = []
      this.history.push({ role: 'user', content: blocks })
    }

    async runTurn(req: { system: string; tools: AgentTool[]; signal: AbortSignal; onEvent: (e: TurnEvent) => void }): Promise<TurnResult> {
      const { signal, onEvent } = req
      const key = this.config.apiKey
      if (signal.aborted) throw abortedError()
      if (this.pending.length) this.history.push({ role: 'user', content: this.takePending() })
      const client = this.getClient()
      const maxTokens = await this.maxTokens(client, signal)
      const params = buildParams(this.config, req, this.history, maxTokens)

      // our own copy of each tool input as it streams, parsed strictly at the end (the SDK's parser is tolerant)
      const raw = new Map<number, { id: string; json: string }>()
      let msg: BetaMessage
      try {
        const stream = client.beta.messages.stream(params, { signal })
        for await (const ev of stream) {
          if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
            raw.set(ev.index, { id: ev.content_block.id, json: '' })
            onEvent({ type: 'tool_start', id: ev.content_block.id, name: ev.content_block.name })
          } else if (ev.type === 'content_block_delta') {
            const d = ev.delta
            if (d.type === 'text_delta') onEvent({ type: 'text', delta: d.text })
            else if (d.type === 'thinking_delta') onEvent({ type: 'thinking', delta: d.thinking })
            else if (d.type === 'input_json_delta') {
              const r = raw.get(ev.index)
              if (r) {
                r.json += d.partial_json
                onEvent({ type: 'tool_input', id: r.id, partialJson: r.json })
              }
            }
          }
        }
        msg = await stream.finalMessage()
      } catch (err) {
        if (signal.aborted) throw abortedError()
        // the SDK gives up on tool JSON it cannot parse at all: then the turn never completed and there is no
        // tool_use to answer, so it is retried as a whole (nothing was appended)
        if (err instanceof AnthropicError && !(err instanceof APIError) && [...raw.values()].some((r) => parseToolInput(r.json).inputError)) {
          throw new ProviderError('other', 'The model sent a tool call that could not be read. Try again.', { retryable: true })
        }
        throw toProviderError(err, key, this.config.baseUrl)
      }
      if (signal.aborted) throw abortedError()

      const usage = usageOf(msg)
      onEvent({ type: 'usage', usage })
      const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
      const base = { text, usage, model: msg.model }

      // a refusal's partial output is discarded (not appended), and its tool calls never run
      if (msg.stop_reason === 'refusal') return { ...base, stop: 'refusal', toolCalls: [], refusal: refusalText(msg) }

      const echoed = echoContent(msg.content)
      // an assistant turn with no content cannot be sent back, so it is simply not appended
      if (echoed.length) this.history.push({ role: 'assistant', content: echoed as BetaContentBlockParam[] })

      // a reply cut at the output limit ended inside its LAST block: a tool_use there may be incomplete (even an empty
      // input, which would parse as {}), so it never runs. The tool_use blocks before it were closed and run as usual.
      const cut = msg.stop_reason === 'max_tokens' || msg.stop_reason === 'model_context_window_exceeded'
      const lastBlock = msg.content.length - 1
      const toolCalls: ToolCall[] = []
      msg.content.forEach((b, i) => {
        if (b.type !== 'tool_use' || !echoed.includes(b)) return
        const r = raw.get(i)
        const parsed = r ? parseToolInput(r.json) : parseToolInput(JSON.stringify(b.input ?? {}))
        if (cut && (i === lastBlock || parsed.inputError !== undefined)) {
          toolCalls.push({ id: b.id, name: b.name, input: undefined, inputError: 'truncated' })
          return
        }
        toolCalls.push({ id: b.id, name: b.name, ...parsed })
      })
      this.pending = toolCalls.map((c) => c.id)

      switch (msg.stop_reason) {
        case 'tool_use': return { ...base, stop: toolCalls.length ? 'tool_use' : 'end', toolCalls }
        case 'max_tokens': return { ...base, stop: 'max_tokens', toolCalls }
        case 'model_context_window_exceeded':
          return { ...base, stop: 'max_tokens', toolCalls, notice: 'The conversation no longer fits in the model\'s context window. Start a new chat.' }
        case 'pause_turn': return { ...base, stop: 'pause', toolCalls }
        default: return { ...base, stop: toolCalls.length ? 'tool_use' : 'end', toolCalls }
      }
    }

    private takePending(): BetaContentBlockParam[] {
      const blocks = this.pending.map(notRun)
      this.pending = []
      return blocks
    }

    private resultBlock(id: string, output: ToolOutput): BetaToolResultBlockParam {
      const images = this.config.vision ? output.images ?? [] : []
      return {
        type: 'tool_result',
        tool_use_id: id,
        content: [
          { type: 'text', text: resultText(output) },
          ...images.map((img) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mediaType, data: img.base64 } })),
        ],
        is_error: !!output.isError,
      }
    }

    private getClient(): Anthropic {
      try {
        return (this.client ??= makeClient(this.config))
      } catch (err) {
        throw toProviderError(err, this.config.apiKey, this.config.baseUrl)
      }
    }

    private async maxTokens(client: Anthropic, signal: AbortSignal): Promise<number> {
      const k = limitKey(this.config, this.config.model)
      if (!limits.has(k)) {
        try {
          const info = await client.models.retrieve(this.config.model, null, { signal, maxRetries: 0 })
          limits.set(k, info.max_tokens ?? null)
        } catch (err) {
          if (signal.aborted) throw abortedError()
          // unknown to the Models API: send the default (the turn itself reports a real problem); other failures are
          // not cached, the next turn asks again
          if (err instanceof NotFoundError) limits.set(k, null)
        }
      }
      const cap = limits.get(k)
      return cap ? Math.min(MAX_TOKENS, cap) : MAX_TOKENS
    }
  }

  return {
    family: 'anthropic',
    createSession: (config) => new AnthropicSession(config),
    async listModels(config, signal) {
      let client: Anthropic
      try {
        client = makeClient(config)
      } catch (err) {
        throw toProviderError(err, config.apiKey, config.baseUrl)
      }
      const models: { id: string; created: string }[] = []
      try {
        for await (const m of client.models.list({ limit: 100 }, { signal })) {
          models.push({ id: m.id, created: m.created_at })
          if (m.max_tokens) limits.set(limitKey(config, m.id), m.max_tokens)
          if (models.length >= LIST_CAP) break
        }
      } catch (err) {
        if (signal?.aborted) throw abortedError()
        throw toProviderError(err, config.apiKey, config.baseUrl)
      }
      models.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0))
      const ids = models.map((m) => m.id)
      const i = ids.indexOf(PREFERRED_MODEL)
      if (i > 0) ids.unshift(...ids.splice(i, 1))
      return ids
    },
  }
}

function notRun(id: string): BetaToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: NOT_RUN_TEXT }], is_error: true }
}

export const adapter: ProviderAdapter = createAnthropicAdapter()
