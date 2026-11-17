// The chat loop (no DOM): user message → model turn → run the tool calls → send the results → … until the model ends
// its turn, the user presses Stop, or the step limit is reached. Provider-agnostic: it talks to a ChatSession
// (./types.ts) and leaves the native history to the adapter, which only ever appends to it.
//
// History rules the loop keeps:
//   - every tool call of an assistant turn that the adapter appended gets a result, in one addToolResults — also when
//     the user pressed Stop ("Cancelled by the user") or the call could not run (bad input, unknown tool);
//   - a turn aborted mid-stream is not in the history (the adapter guarantees that), so it needs no results;
//   - user messages carry an <app_state> block (src/agent/prompt.ts) in front of what the user typed.
//
// Bundle: this module and its static imports are small. The tool layer (zod, the shared catalog) and the system prompt
// (the code-API cheat sheet reads @jscad/modeling) are loaded on the first message, the provider SDKs when a session
// starts (./adapters.ts). The UI should import loop.ts and settings.ts only.
//
// UI contract: read `entries`, `state`, `usage`, `canContinue`, `canRetry`, `lastEnd`, `lastError`; subscribe(fn) is called after every
// change (many times per second while text streams — coalesce renders with requestAnimationFrame). Entries are
// replaced, never mutated: an entry object that is === the previous one did not change.
import type { AppContext } from '../app/context'
import {
  ProviderError,
  type AgentTool, type ApiFamily, type ChatEntry, type ChatSession, type LoopState, type ProviderAdapter, type ProviderConfig,
  type StopReason, type ToolCall, type ToolOutput, type TurnEvent, type TurnResult, type TurnUsage,
} from './types'
import { abortError, isAbortError } from './abort'
import { summarizeCall, summarizeResult } from './summary'
import { getAdapter as defaultGetAdapter } from './adapters'
import { cleanUrl, isLoopbackUrl } from './providers/common'
import { HISTORY_CAP } from '../state/history'

export const DEFAULT_MAX_STEPS = 25
/** Project changes per message before the loop pauses (Continue goes on): half the undo history, so every change of
 *  one message — and the user's steps before it — can still be undone. */
export const DEFAULT_MAX_CHANGES = Math.floor(HISTORY_CAP / 2)

export interface ChatUsage {
  /** input tokens of the last model turn, cache reads and writes included: about how full the context is */
  contextTokens: number
  /** output tokens of every turn since the chat started (thinking included) */
  outputTokens: number
  /** model turns since the chat started */
  turns: number
}

/** How the last run ended: 'limit' = maxSteps or maxChanges reached (continue() goes on), 'stopped' = Stop. */
export type RunEnd = 'end' | 'limit' | 'stopped' | 'error' | 'max_tokens' | 'refusal'

/** What the last failed run ran into ('setup': the chat settings were incomplete). */
export interface LastError {
  kind: ProviderError['kind'] | 'setup'
  /** sending the same request again may work (rate limit, network, a server error, an unexpected failure) */
  retryable: boolean
}

export interface ChatControllerOptions {
  /** the app: the tools act on it and every user message gets its <app_state>; optional when the loaders below are given */
  ctx?: AppContext | null
  /** model turns per user message before the loop pauses (default 25; settings.maxSteps) */
  maxSteps?: number
  /** project changes per user message before the loop pauses (default DEFAULT_MAX_CHANGES; counted by the default tools) */
  maxChanges?: number
  /** default: ./adapters.ts (dynamic imports of the provider modules) */
  getAdapter?: (family: ApiFamily) => Promise<ProviderAdapter>
  /** default: createChatTools(ctx) from ./tools.ts, loaded on the first message */
  loadTools?: () => Promise<AgentTool[]>
  /** default: systemPrompt() from ./prompt.ts */
  systemPrompt?: () => Promise<string>
  /** the <app_state> block for a user message; default: appStatePreamble(ctx) from ./prompt.ts */
  appState?: () => string | Promise<string>
}

type ToolStatus = Extract<ChatEntry, { kind: 'tool' }>['status']
type EntryOf<K extends ChatEntry['kind']> = Extract<ChatEntry, { kind: K }>

/** What one model turn put on screen (entries created while it streamed). */
interface Live {
  /** the assistant entry text deltas go to; null after a tool call started (later text gets a new entry) */
  assistant: string | null
  assistants: string[]
  /** provider tool call id → entry id (ids may repeat across turns with some local servers) */
  tools: Map<string, string>
  streamedText: boolean
}

const CANCELLED: ToolOutput = { text: 'Cancelled by the user', isError: true }
const CANCELLED_RUNNING: ToolOutput = { text: 'Cancelled by the user while it was running. A change it made may already be applied (it is in the undo history).', isError: true }
const CUT_OFF = 'Not run: your reply hit the output token limit while writing this call, so its input is incomplete. Send it again with a smaller input (for example shorter code, or split the change into steps).'
const NO_VISION = '\n\n(The image is not shown to you: images are turned off in the chat settings. Use the text above, get_scene and get_errors.)'

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Remove an API key (and anything shaped like one) from text that is shown or logged. */
export function redactKey(text: string, apiKey?: string): string {
  let s = text
  if (apiKey && apiKey.trim().length >= 4) s = s.split(apiKey.trim()).join('[key]')
  return s
    .replace(/\b(sk|gsk|xai|key|AIza)[-_A-Za-z0-9]*[-_][-_A-Za-z0-9*]{8,}/g, '[key]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [key]')
}

/** The conversation no longer fits the model (a retry sends the same history and fails the same way). */
export function isTooLong(e: unknown): boolean {
  return e instanceof ProviderError && (e.status === 413 || (e.kind === 'bad_request'
    && /prompt is too long|too many (input )?tokens|context (length|window)|maximum context|reduce the length/i.test(e.message)))
}

/** An OpenAI-compatible server refused the screenshots (the adapter sends a turn again without them once; this is
 *  for a refusal it could not recognise as such). Not a size or count limit. */
function refusedImages(e: ProviderError, config: ProviderConfig | null): boolean {
  return config?.preset.family === 'openai-compatible' && (e.kind === 'bad_request' || e.kind === 'not_found')
    && /image/i.test(e.message) && !/too many|too large|exceed|maximum|size/i.test(e.message)
}

/** A model that Chat Completions does not serve (OpenAI's Responses-only models). */
const notAChatModel = (e: ProviderError): boolean => /v1\/responses|not a chat model|not supported in the v1\/chat\/completions/i.test(e.message)

/**
 * The notice text for a failed request: what happened and what the user can do, in one sentence of ours around the
 * provider's own (redacted) text. Never contains the API key, nor a base URL's user name, password or query.
 */
export function describeError(e: unknown, config: ProviderConfig | null): string {
  const who = config?.preset.label ?? 'The provider'
  const clean = (m: string): string => clip(redactKey(m, config?.apiKey).replace(/\s+/g, ' ').trim(), 300)
  const detail = (m: string): string => {
    const d = clean(m)
    return d ? ` (${d})` : ''
  }
  if (e instanceof ProviderError) {
    if (isTooLong(e)) return 'The conversation is too long for this model. Start a new chat.'
    if (refusedImages(e, config)) return 'This model does not take images. Turn off \'Send screenshots as images\' in the chat settings.'
    if ((e.kind === 'not_found' || e.kind === 'bad_request') && notAChatModel(e)) {
      return `The model '${config?.model ?? '?'}' does not work with this chat (it needs the Chat Completions API). Pick another model in the chat settings.`
    }
    switch (e.kind) {
      // the provider's own text is left out: some echo a masked key back
      case 'auth': return `${who} did not accept the API key. Check the key in the chat settings.`
      case 'permission': return `${who} refused the request${detail(e.message)}. The key may not be allowed to use this model, or the account may need credit.`
      case 'not_found': return `${who} does not know the model '${config?.model ?? '?'}'${detail(e.message)}. Pick another model in the chat settings${config?.preset.baseUrlEditable ? ', or check the base URL' : ''}.`
      case 'rate_limit': return `${who} rate limit reached${detail(e.message)}. Wait a moment, then try again.`
      case 'overloaded': return `${who} is overloaded right now. Try again in a minute.`
      case 'bad_request': return `${who} refused the request${detail(e.message)}.`
      case 'network': {
        // the browser's own text ("Failed to fetch") says nothing more, and is left out
        if (config?.preset.baseUrlEditable) {
          const url = config.baseUrl || config.preset.baseUrl
          const where = url ? cleanUrl(url) : 'its default address'
          return `Could not reach ${isLoopbackUrl(url) ? 'the local server' : 'the server'} at ${where}. Make sure it is running and allows requests from this page (CORS).`
        }
        return `Could not reach ${who}. Check your connection. A provider that does not allow requests from web pages (CORS) fails this way too.`
      }
      case 'server': {
        const inner = [e.status, clean(e.message)].filter(Boolean).join(': ')
        return `${who} had a server error${inner ? ` (${inner})` : ''}. Try again in a moment.`
      }
      case 'aborted': return 'The request was cancelled before it finished.'
      default: return `${who}: ${clean(e.message) || 'unknown error'}`
    }
  }
  return `Something went wrong: ${clip(redactKey(errorText(e), config?.apiKey), 300)}`
}

/** The note that goes into the next message's <app_state> after messages that got no reply. */
const UNANSWERED_NOTE = 'note: the user\'s previous message(s) got no reply because the request failed. Answer this newest message; the earlier ones only if it asks for that.'

/** Put one more line at the end of an <app_state> block (or after the state, when it is not one). */
function withStateLine(state: string, line: string): string {
  const close = '</app_state>'
  return state.endsWith(close) ? `${state.slice(0, -close.length)}${line}\n${close}` : [state, line].filter(Boolean).join('\n\n')
}

/** Same session = same provider, model, base URL, key and effort (vision is applied without a new session). */
function sameSession(a: ProviderConfig | null, b: ProviderConfig | null): boolean {
  if (!a || !b) return a === b
  return a.preset.id === b.preset.id && a.model === b.model && a.baseUrl === b.baseUrl && a.apiKey === b.apiKey && a.effort === b.effort
}

function sameTarget(a: ProviderConfig, b: ProviderConfig): boolean {
  return a.preset.id === b.preset.id && a.model === b.model && a.baseUrl === b.baseUrl
}

export class ChatController {
  /** the transcript, oldest first */
  entries: readonly ChatEntry[] = []
  state: LoopState = 'idle'
  usage: ChatUsage = { contextTokens: 0, outputTokens: 0, turns: 0 }
  /** how the last run ended (null before the first one) */
  lastEnd: RunEnd | null = null
  /** what the last failed run ran into; null after a run that did not fail, or once the settings changed since */
  lastError: LastError | null = null
  maxSteps: number
  maxChanges: number

  private cfg: ProviderConfig | null = null
  /** configure() during a run takes effect when the run ends */
  private pendingConfig: { value: ProviderConfig | null } | null = null
  private session: ChatSession | null = null
  /** our copy of the config the session was made with (vision is updated in place) */
  private sessionConfig: ProviderConfig | null = null
  private sessionTurns = 0
  /** user messages (with app state) added to the session since its last completed turn */
  private unanswered: string[] = []
  /** user messages no session has seen yet (the provider changed, or sending failed before a session existed) */
  private carry: string[] = []
  /** the history ends waiting for the model (step limit, Stop, error): continue() may run it */
  private resumable = false
  private abort: AbortController | null = null
  private running: Promise<void> | null = null
  private readonly confirms = new Map<string, (ok: boolean) => void>()
  private readonly listeners = new Set<(c: ChatController) => void>()
  private seq = 0
  private loaded: Promise<{ tools: AgentTool[]; system: string }> | null = null
  /** usage of the turn in flight; `banked` = output tokens of the finished turns */
  private turnUsage: TurnUsage = {}
  private banked = 0
  /** project changes in the current run (the default tools report them) */
  private changes = 0
  private readonly opts: Required<Omit<ChatControllerOptions, 'ctx' | 'maxSteps' | 'maxChanges'>>

  constructor(opts: ChatControllerOptions = {}) {
    const ctx = opts.ctx ?? null
    const needCtx = (): AppContext => {
      if (!ctx) throw new Error('The chat is not connected to the app')
      return ctx
    }
    this.maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS
    this.maxChanges = opts.maxChanges ?? DEFAULT_MAX_CHANGES
    this.opts = {
      getAdapter: opts.getAdapter ?? defaultGetAdapter,
      loadTools: opts.loadTools ?? (async () => (await import('./tools')).createChatTools(needCtx(), { onAction: () => { this.changes++ } })),
      systemPrompt: opts.systemPrompt ?? (async () => (await import('./prompt')).systemPrompt()),
      appState: opts.appState ?? (async () => (await import('./prompt')).appStatePreamble(needCtx())),
    }
  }

  /** The provider settings in effect (null = not set up). */
  get config(): ProviderConfig | null {
    return this.pendingConfig ? this.pendingConfig.value : this.cfg
  }

  /** continue() can run: the last run stopped before the model finished (step limit, Stop, an error). */
  get canContinue(): boolean {
    if (this.state !== 'idle' || !this.cfg) return false
    return this.carry.length > 0 || (this.session !== null && this.resumable)
  }

  /** After an error: is a Retry (continue()) worth offering? Yes when the error may pass (rate limit, network, a server
   *  error, …) or the settings changed since; not for a bad key, an unknown model or a refused request as they stand. */
  get canRetry(): boolean {
    return this.lastEnd === 'error' && this.canContinue && (!this.lastError || this.lastError.retryable)
  }

  subscribe(fn: (c: ChatController) => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  /**
   * Use these provider settings from the next model turn on. A different provider, model, base URL, key or effort
   * starts a fresh session (the transcript stays on screen; an info notice says the model no longer sees it).
   */
  configure(config: ProviderConfig | null): void {
    if (this.state !== 'idle') {
      this.pendingConfig = { value: config }
      this.emit()
      return
    }
    this.applyConfig(config)
    this.emit()
  }

  /**
   * Send a user message and run the loop until the model is done (resolves when the chat is idle again). The same text
   * again right after it failed is a Retry: the model would otherwise get the instruction twice and might apply it
   * twice. A different text after a failure tells the model (in its <app_state>) that the earlier message got no reply.
   */
  send(text: string): Promise<void> {
    const t = text.trim()
    if (!t || this.state !== 'idle') return Promise.resolve()
    if (this.lastEnd === 'error' && this.canContinue && this.lastUserText() === t) return this.start(null)
    const unanswered = this.lastEnd === 'error' && (this.carry.length > 0 || this.unanswered.length > 0)
    this.push({ kind: 'user', id: this.newId(), text: t })
    return this.start(t, unanswered)
  }

  /** After the step limit, Stop or an error: let the model go on from where it was. */
  continue(): Promise<void> {
    if (!this.canContinue) return Promise.resolve()
    return this.start(null)
  }

  /** Abort the request in flight and the running tool's wait; pending approvals are declined. */
  stop(): void {
    if (this.state !== 'running') return
    this.state = 'stopping'
    this.abort?.abort()
    for (const done of [...this.confirms.values()]) done(false)
    this.emit()
  }

  /** Approve / decline a confirm entry (an action that cannot be undone). */
  approve(id: string): void { this.confirms.get(id)?.(true) }
  decline(id: string): void { this.confirms.get(id)?.(false) }

  /** Clear the transcript and start a fresh session (stops a running loop first). */
  async newChat(): Promise<void> {
    if (this.running) { this.stop(); await this.running }
    this.entries = []
    this.session = null
    this.sessionConfig = null
    this.sessionTurns = 0
    this.unanswered = []
    this.carry = []
    this.resumable = false
    this.lastEnd = null
    this.lastError = null
    this.usage = { contextTokens: 0, outputTokens: 0, turns: 0 }
    this.emit()
  }

  /** Stop and forget the listeners (the panel is gone). */
  dispose(): void {
    this.stop()
    this.listeners.clear()
  }

  // ───────────────────────────── the run ─────────────────────────────

  private start(userText: string | null, afterUnanswered = false): Promise<void> {
    const run = this.run(userText, afterUnanswered).finally(() => { if (this.running === run) this.running = null })
    this.running = run
    return run
  }

  private async run(userText: string | null, afterUnanswered: boolean): Promise<void> {
    this.state = 'running'
    this.resumable = false
    this.lastError = null
    this.changes = 0
    const abort = new AbortController()
    this.abort = abort
    const signal = abort.signal
    this.emit()
    let end: RunEnd = 'end'
    let message: string | null = null
    try {
      if (userText !== null) {
        let state = await this.opts.appState()
        if (afterUnanswered) state = withStateLine(state, UNANSWERED_NOTE)
        message = state ? `${state}\n\n${userText}` : userText
      }
      const problem = this.configProblem()
      if (problem) {
        end = 'error'
        this.lastError = { kind: 'setup', retryable: false }
        this.notice('error', problem)
        return
      }
      const { tools, system } = await this.ready()
      const session = await this.ensureSession()
      for (const m of this.carry) { session.addUser(m); this.unanswered.push(m) }
      this.carry = []
      if (message !== null) {
        session.addUser(message)
        this.unanswered.push(message)
        message = null
      }
      let steps = 0
      for (;;) {
        if (signal.aborted) throw abortError()
        if (steps >= this.maxSteps) {
          end = 'limit'
          this.resumable = true
          this.notice('warn', `Paused after ${plural(steps, 'step')} (the limit for one message). Press Continue to let it keep going.`)
          break
        }
        if (this.changes >= this.maxChanges) {
          // the undo history keeps HISTORY_CAP steps: more changes would push this message's first ones out of reach
          end = 'limit'
          this.resumable = true
          this.notice('warn', `Paused after ${plural(this.changes, 'change')} in one message, so all of them can still be undone. Press Continue to let it keep going.`)
          break
        }
        steps++
        const { result: r, entryOf, shown } = await this.turn(session, system, tools, signal)
        this.sessionTurns++
        this.unanswered = []
        // max_tokens with a notice: the conversation no longer fits the context window, so nothing more can run
        const full = r.stop === 'max_tokens' && !!r.notice
        if (r.notice && !full) this.notice('info', r.notice)
        if (r.toolCalls.length) {
          await this.runCalls(session, tools, r, entryOf, signal, full)
          if (signal.aborted) throw abortError()
          if (r.stop !== 'refusal' && !full) continue // tool_use, and max_tokens / end with calls: the model reads the results next
        }
        if (r.stop === 'pause') continue
        if (r.stop === 'max_tokens') {
          end = 'max_tokens'
          this.notice('warn', r.notice ?? 'The reply was cut off at the model\'s output limit. Ask it to continue, or to answer in shorter steps.')
        } else if (r.stop === 'refusal') {
          end = 'refusal'
          this.notice('warn', r.refusal ? `The model declined: ${clip(r.refusal, 400)}` : 'The model declined to answer this.')
        } else if (!shown) {
          this.notice('info', 'The model sent an empty reply.')
        }
        break
      }
    } catch (e) {
      if (signal.aborted) {
        end = 'stopped'
        this.resumable = true
        this.notice('info', 'Stopped.')
      } else {
        end = 'error'
        // a history that is too long fails the same way every time: only a new chat helps
        this.resumable = !isTooLong(e)
        this.lastError = e instanceof ProviderError
          ? { kind: e.kind, retryable: e.retryable && this.resumable }
          : { kind: 'other', retryable: true } // e.g. a part of the app that failed to load
        this.notice('error', describeError(e, this.cfg))
      }
    } finally {
      // a message no session got (settings missing, the adapter failed to load) is sent with the next run
      if (message !== null) this.carry.push(message)
      this.abort = null
      for (const done of [...this.confirms.values()]) done(false)
      this.lastEnd = end
      this.state = 'idle'
      if (this.pendingConfig) {
        const { value } = this.pendingConfig
        this.pendingConfig = null
        this.applyConfig(value)
      }
      this.emit()
    }
  }

  /** One model turn, streamed into the transcript. `shown`: it put text, thinking or a tool call on screen. */
  private async turn(session: ChatSession, system: string, tools: AgentTool[], signal: AbortSignal): Promise<{ result: TurnResult; entryOf: (call: ToolCall) => string; shown: boolean }> {
    const live: Live = { assistant: null, assistants: [], tools: new Map(), streamedText: false }
    this.turnUsage = {}
    const onEvent = (e: TurnEvent) => {
      if (signal.aborted) return
      switch (e.type) {
        case 'text':
          if (!e.delta) return
          live.streamedText = true
          this.appendAssistant(live, 'text', e.delta)
          break
        case 'thinking':
          if (e.delta) this.appendAssistant(live, 'thinking', e.delta)
          break
        case 'tool_start': {
          live.assistant = null
          const id = this.newId()
          live.tools.set(e.id, id)
          this.push({ kind: 'tool', id, name: e.name, inputJson: '', status: 'streaming' })
          break
        }
        case 'tool_input': {
          const id = live.tools.get(e.id)
          if (id) this.patch(id, 'tool', { inputJson: e.partialJson })
          break
        }
        case 'usage':
          this.applyUsage(e.usage)
          break
      }
    }
    let r: TurnResult
    try {
      r = await session.runTurn({ system, tools, signal, onEvent })
      if (r.usage) this.applyUsage(r.usage)
    } catch (e) {
      // the turn is not in the history: close what it showed
      for (const id of live.assistants) this.patch(id, 'assistant', { streaming: false })
      for (const id of live.tools.values()) this.patch(id, 'tool', { status: 'cancelled' })
      throw e
    } finally {
      this.bankUsage()
    }
    const model = r.model ?? session.config.model
    for (const id of live.assistants) this.patch(id, 'assistant', { streaming: false, model })
    if (!live.streamedText && r.text.trim()) {
      // an adapter that did not stream the text: show it now, before this turn's tool cards
      const id = this.newId()
      const at = Math.min(...[...live.tools.values()].map((t) => this.entries.findIndex((x) => x.id === t)).filter((i) => i >= 0), this.entries.length)
      const next = this.entries.slice()
      next.splice(at, 0, { kind: 'assistant', id, text: r.text, streaming: false, model })
      this.entries = next
      this.emit()
    }
    const used = new Set<string>()
    const entryIds = new Map<ToolCall, string>()
    for (const call of r.toolCalls) {
      let id = live.tools.get(call.id)
      if (!id || used.has(id)) {
        id = this.newId()
        this.push({ kind: 'tool', id, name: call.name, inputJson: '', status: 'streaming' })
      }
      used.add(id)
      entryIds.set(call, id)
      const inputJson = call.input !== undefined ? JSON.stringify(call.input) : (this.find(id, 'tool')?.inputJson ?? '')
      this.patch(id, 'tool', { name: call.name, inputJson, summary: summarizeCall(call.name, call.input) || undefined })
    }
    for (const id of live.tools.values()) if (!used.has(id)) this.patch(id, 'tool', { status: 'cancelled' })
    const shown = live.assistants.length > 0 || !!r.text.trim() || r.toolCalls.length > 0
    return { result: r, entryOf: (call) => entryIds.get(call)!, shown }
  }

  /** Run every call of a turn in order (they change the project), then send all results at once. */
  private async runCalls(session: ChatSession, tools: AgentTool[], r: TurnResult, entryOf: (call: ToolCall) => string, signal: AbortSignal, full = false): Promise<void> {
    const byName = new Map(tools.map((t) => [t.name, t]))
    const results = new Map<ToolCall, ToolOutput>()
    const skip = r.stop === 'refusal' ? 'Not run: the turn ended with a refusal.'
      : full ? 'Not run: the conversation no longer fits in the context window.' : null
    try {
      for (const call of r.toolCalls) {
        const id = entryOf(call)
        let out: { output: ToolOutput; status: ToolStatus }
        if (signal.aborted) out = { output: CANCELLED, status: 'cancelled' }
        else if (skip) out = { output: { text: skip, isError: true }, status: 'cancelled' }
        else out = await this.runCall(call, byName, r.stop, signal, id)
        results.set(call, out.output)
        const summary = [summarizeCall(call.name, call.input), summarizeResult(out.output)].filter(Boolean).join(' — ')
        this.patch(id, 'tool', { status: out.status, resultText: out.output.text, images: out.output.images, summary: summary || undefined })
      }
    } finally {
      // a call without a result (an unexpected error above) still gets one: the history must stay valid
      const all = r.toolCalls.map((call) => ({ call, output: this.forModel(results.get(call) ?? { text: 'Not run (an error in the chat).', isError: true }) }))
      session.addToolResults(all)
    }
  }

  private async runCall(call: ToolCall, byName: Map<string, AgentTool>, stop: StopReason, signal: AbortSignal, entryId: string): Promise<{ output: ToolOutput; status: ToolStatus }> {
    const fail = (text: string) => ({ output: { text, isError: true }, status: 'error' as const })
    const tool = byName.get(call.name)
    if (!tool) return fail(`Unknown tool '${call.name}'. The tools are: ${[...byName.keys()].join(', ')}.`)
    if (call.inputError !== undefined) {
      return fail(stop === 'max_tokens' ? CUT_OFF : `Not run: the input is not valid JSON (${call.inputError}). Send the arguments as one JSON object.`)
    }
    const v = tool.validate(call.input)
    if (!v.ok) return fail(v.error)
    this.patch(entryId, 'tool', { status: 'running' })
    let declined = false
    const confirm = async (title: string, message: string): Promise<boolean> => {
      const ok = await this.askConfirm(title, message, signal)
      if (!ok) declined = true
      return ok
    }
    try {
      const output = await tool.run(v.value, { signal, confirm })
      if (declined && signal.aborted) return { output: CANCELLED, status: 'cancelled' }
      return { output, status: output.isError ? 'error' : declined ? 'declined' : 'ok' }
    } catch (e) {
      if (signal.aborted || isAbortError(e)) return { output: declined ? CANCELLED : CANCELLED_RUNNING, status: 'cancelled' }
      return fail(`Error: ${errorText(e)}`)
    }
  }

  private askConfirm(title: string, message: string, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      if (signal.aborted) { resolve(false); return }
      const id = this.newId()
      const onAbort = () => done(false)
      const done = (ok: boolean) => {
        if (!this.confirms.delete(id)) return
        signal.removeEventListener('abort', onAbort)
        this.patch(id, 'confirm', { state: ok ? 'approved' : 'declined' })
        resolve(ok)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.confirms.set(id, done)
      this.push({ kind: 'confirm', id, title, message, state: 'pending' })
    })
  }

  /** What the model gets: without images when vision is off in the settings. */
  private forModel(output: ToolOutput): ToolOutput {
    const vision = this.cfg?.vision ?? true
    if (vision || !output.images?.length) return output
    return { text: output.text + NO_VISION, ...(output.isError ? { isError: true } : {}) }
  }

  // ───────────────────────────── sessions & settings ─────────────────────────────

  private ready(): Promise<{ tools: AgentTool[]; system: string }> {
    if (!this.loaded) {
      const p = Promise.all([this.opts.loadTools(), this.opts.systemPrompt()]).then(([tools, system]) => ({ tools, system }))
      this.loaded = p
      p.catch(() => { if (this.loaded === p) this.loaded = null }) // try again on the next message
    }
    return this.loaded
  }

  private configProblem(): string | null {
    const c = this.cfg
    if (!c) return 'Choose a provider and a model in the chat settings first.'
    if (c.preset.needsKey && !c.apiKey.trim()) return `Add your ${c.preset.label} API key in the chat settings.`
    if (!c.model.trim()) return 'Choose a model in the chat settings.'
    if (c.preset.baseUrlEditable && !c.preset.baseUrl && !c.baseUrl.trim()) return 'Enter the server\'s base URL in the chat settings.'
    return null
  }

  private async ensureSession(): Promise<ChatSession> {
    if (this.session) return this.session
    const config = this.cfg!
    const adapter = await this.opts.getAdapter(config.preset.family)
    const own: ProviderConfig = { ...config }
    const session = adapter.createSession(own)
    this.session = session
    this.sessionConfig = own
    this.sessionTurns = 0
    return session
  }

  private applyConfig(config: ProviderConfig | null): void {
    const prev = this.cfg
    this.cfg = config
    // settings that changed since a failure may fix it: Retry is worth offering again
    if (!sameSession(prev, config) || prev?.vision !== config?.vision) this.lastError = null
    if (sameSession(prev, config)) {
      if (config && this.sessionConfig) this.sessionConfig.vision = config.vision
      return
    }
    if (!this.session) return
    if (this.sessionTurns > 0 && prev && config) {
      const what = sameTarget(prev, config) ? 'The chat settings changed' : `Now using ${config.preset.label} · ${config.model}`
      this.notice('info', `${what}. This starts a fresh conversation: the model does not see the messages above.`)
    }
    // messages the old session never answered go to the new one
    this.carry = [...this.carry, ...this.unanswered]
    this.unanswered = []
    this.session = null
    this.sessionConfig = null
    this.sessionTurns = 0
    this.resumable = false
  }

  // ───────────────────────────── usage ─────────────────────────────

  private applyUsage(u: TurnUsage): void {
    const t = this.turnUsage
    for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) if (typeof u[k] === 'number') t[k] = u[k]
    // Anthropic's input_tokens leaves out cache reads and writes; OpenAI's prompt_tokens already counts cached tokens
    const cached = this.sessionConfig?.preset.family === 'anthropic' ? (t.cacheReadTokens ?? 0) + (t.cacheWriteTokens ?? 0) : 0
    const contextTokens = t.inputTokens !== undefined ? t.inputTokens + cached : this.usage.contextTokens
    this.usage = { ...this.usage, contextTokens, outputTokens: this.banked + (t.outputTokens ?? 0) }
    this.emit()
  }

  /** a turn is over (done, failed or stopped): its output tokens count for good */
  private bankUsage(): void {
    this.banked += this.turnUsage.outputTokens ?? 0
    this.turnUsage = {}
    this.usage = { ...this.usage, outputTokens: this.banked, turns: this.usage.turns + 1 }
  }

  // ───────────────────────────── entries ─────────────────────────────

  private newId(): string {
    return `c${++this.seq}`
  }

  private lastUserText(): string | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]
      if (e.kind === 'user') return e.text
    }
    return undefined
  }

  private emit(): void {
    for (const fn of [...this.listeners]) {
      try { fn(this) } catch (e) { queueMicrotask(() => { throw e }) } // a broken listener must not break the loop
    }
  }

  private push(e: ChatEntry): void {
    this.entries = [...this.entries, e]
    this.emit()
  }

  private notice(level: EntryOf<'notice'>['level'], text: string): void {
    this.push({ kind: 'notice', id: this.newId(), level, text })
  }

  private find<K extends ChatEntry['kind']>(id: string, kind: K): EntryOf<K> | undefined {
    const e = this.entries.find((x) => x.id === id)
    return e && e.kind === kind ? (e as EntryOf<K>) : undefined
  }

  private patch<K extends ChatEntry['kind']>(id: string, kind: K, p: Partial<Omit<EntryOf<K>, 'kind' | 'id'>>): void {
    const i = this.entries.findIndex((x) => x.id === id)
    if (i < 0 || this.entries[i].kind !== kind) return
    const next = this.entries.slice()
    next[i] = { ...this.entries[i], ...p } as ChatEntry
    this.entries = next
    this.emit()
  }

  private appendAssistant(live: Live, field: 'text' | 'thinking', delta: string): void {
    if (!live.assistant) {
      const id = this.newId()
      live.assistant = id
      live.assistants.push(id)
      this.push({ kind: 'assistant', id, text: '', streaming: true })
    }
    const cur = this.find(live.assistant, 'assistant')
    if (!cur) return
    this.patch(live.assistant, 'assistant', field === 'text' ? { text: cur.text + delta } : { thinking: (cur.thinking ?? '') + delta })
  }
}
