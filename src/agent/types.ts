// The contract of the in-app AI chat (src/agent/*, src/ui/chat*.ts). Three parts meet here:
//   1. tools     — the 3Dica tools a model can call (shared catalog with the MCP server; run by src/mcp/handlers.ts)
//   2. providers — one adapter per API family (Anthropic Messages via @anthropic-ai/sdk; OpenAI-compatible Chat
//                  Completions for OpenAI, OpenRouter, Ollama, LM Studio, Groq, …). An adapter owns the conversation
//                  history in its NATIVE format and only ever appends to it (Anthropic thinking blocks must be sent
//                  back unchanged; editing history breaks prompt caching and preserved thinking).
//   3. the loop  — provider-agnostic: user message → model turn → run tool calls → send results → … until the model
//                  ends its turn, the user presses Stop, or the step limit is reached.
// Everything runs in the browser: the user's API key goes from this tab straight to the chosen provider.

// ───────────────────────────── tools ─────────────────────────────

/** A JSON Schema object (draft 2020-12 subset that every provider accepts: type/properties/required/items/enum/…). */
export type JsonSchema = Record<string, unknown>

export type ToolValidation = { ok: true; value: Record<string, unknown> } | { ok: false; error: string }

export interface AgentTool {
  name: string
  description: string
  /** root must be { type: 'object', properties, required?, additionalProperties: false } */
  inputSchema: JsonSchema
  /** parse + validate a model-supplied input (also guards truncated / partial inputs from eager streaming) */
  validate(input: unknown): ToolValidation
  /** true for tools that only read (no project change, no download) */
  readOnly: boolean
  /** true when the action cannot be undone (new_project, load_sample): the loop asks the user first */
  needsConfirm: boolean
  run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolOutput>
}

export interface ToolRunContext {
  signal: AbortSignal
  /** ask the user to approve an action that cannot be undone; resolves false when they decline or press Stop */
  confirm(title: string, message: string): Promise<boolean>
}

export interface ToolImage {
  mediaType: 'image/png'
  /** base64 without a data: prefix */
  base64: string
}

export interface ToolOutput {
  /** what the model reads (JSON text for most tools) */
  text: string
  /** screenshots; providers that cannot put images in a tool result send them in a follow-up user message */
  images?: ToolImage[]
  isError?: boolean
}

// ───────────────────────────── providers ─────────────────────────────

/** Which adapter talks to the API. */
export type ApiFamily = 'anthropic' | 'openai-compatible'

export interface ProviderPreset {
  /** stable id saved in settings: 'anthropic', 'openai', 'openrouter', 'ollama', 'lmstudio', …, 'custom' */
  id: string
  label: string
  family: ApiFamily
  /** default base URL ('' = the SDK default). The user can change it for 'custom' (and local servers). */
  baseUrl: string
  baseUrlEditable: boolean
  /** false for local servers (Ollama, LM Studio) */
  needsKey: boolean
  /** suggested model when the list cannot be fetched */
  defaultModel: string
  /** where to get a key (shown as a link in the settings) */
  keyUrl?: string
  /** one short line for the settings form, e.g. CORS hints for local servers */
  note?: string
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ProviderConfig {
  preset: ProviderPreset
  baseUrl: string
  apiKey: string
  model: string
  /** Anthropic: output_config.effort (models that support it). OpenAI-compatible: reasoning_effort when set. */
  effort?: Effort
  /** send screenshots to the model as images (turn off for text-only models) */
  vision: boolean
}

/** Streamed while a model turn runs (for the live transcript). */
export type TurnEvent =
  | { type: 'text'; delta: string }
  /** a readable reasoning summary (Anthropic display: "summarized"); may never arrive */
  | { type: 'thinking'; delta: string }
  | { type: 'tool_start'; id: string; name: string }
  /** the tool input as it streams (raw JSON text so far) */
  | { type: 'tool_input'; id: string; partialJson: string }
  | { type: 'usage'; usage: TurnUsage }

export interface TurnUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface ToolCall {
  id: string
  name: string
  /** parsed input; undefined when the JSON could not be parsed (then `inputError` says why) */
  input: unknown
  inputError?: string
}

export type StopReason =
  /** the model finished its answer */
  | 'end'
  /** the model wants tool results (toolCalls is non-empty) */
  | 'tool_use'
  /** output cut at max_tokens */
  | 'max_tokens'
  /** the provider declined (Anthropic stop_reason "refusal"); `refusal` explains */
  | 'refusal'
  /** Anthropic pause_turn: call runTurn again with no new input */
  | 'pause'

export interface TurnResult {
  stop: StopReason
  /** the visible text of this turn */
  text: string
  toolCalls: ToolCall[]
  usage?: TurnUsage
  refusal?: string
  /** the model that actually answered (a server-side fallback may differ from the configured one) */
  model?: string
  /** a short explanation for the user when the stop needs one (e.g. the conversation no longer fits the context window) */
  notice?: string
}

/** A provider error the UI can explain (bad key, no credit, rate limit, CORS/network, unknown model, …). */
export class ProviderError extends Error {
  readonly kind: 'auth' | 'permission' | 'not_found' | 'rate_limit' | 'overloaded' | 'bad_request' | 'network' | 'server' | 'aborted' | 'other'
  readonly status?: number
  /** may be retried as is */
  readonly retryable: boolean
  constructor(kind: ProviderError['kind'], message: string, opts: { status?: number; retryable?: boolean } = {}) {
    super(message)
    this.name = 'ProviderError'
    this.kind = kind
    this.status = opts.status
    this.retryable = opts.retryable ?? (kind === 'rate_limit' || kind === 'overloaded' || kind === 'network' || kind === 'server')
  }
}

/**
 * One conversation with one provider + model. The adapter keeps the history in its native format and ONLY appends:
 * addUser / addToolResults / the assistant turn that runTurn produced. A turn aborted mid-stream is NOT appended.
 */
export interface ChatSession {
  readonly config: ProviderConfig
  addUser(text: string): void
  /** results for EVERY tool call of the last turn, in one go (as one message where the API allows it) */
  addToolResults(results: { call: ToolCall; output: ToolOutput }[]): void
  /** one model turn over the current history; throws ProviderError (kind 'aborted' when signal fires) */
  runTurn(req: { system: string; tools: AgentTool[]; signal: AbortSignal; onEvent: (e: TurnEvent) => void }): Promise<TurnResult>
}

export interface ProviderAdapter {
  family: ApiFamily
  createSession(config: ProviderConfig): ChatSession
  /** model ids the key can use, newest / most relevant first; throws ProviderError */
  listModels(config: Omit<ProviderConfig, 'model'>, signal?: AbortSignal): Promise<string[]>
}

// ───────────────────────────── the loop ─────────────────────────────

/** What the chat panel shows; the loop emits these. */
export type ChatEntry =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; thinking?: string; streaming: boolean; model?: string }
  | {
      kind: 'tool'; id: string; name: string; inputJson: string; status: 'streaming' | 'running' | 'ok' | 'error' | 'declined' | 'cancelled'
      /** short one-line summary of the input / result for the collapsed card */
      summary?: string; resultText?: string; images?: ToolImage[]
    }
  | { kind: 'notice'; id: string; level: 'info' | 'warn' | 'error'; text: string }
  | { kind: 'confirm'; id: string; title: string; message: string; state: 'pending' | 'approved' | 'declined' }

export type LoopState = 'idle' | 'running' | 'stopping'
