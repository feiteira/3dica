// Helpers shared by the two provider adapters: key handling, base URLs, error text that is safe to show, and strict
// parsing of streamed tool input. Nothing here imports an SDK, so it stays out of the SDK chunks' way.
// ProviderError messages carry the provider's own (redacted) text, not a sentence of ours: describeError in
// src/agent/loop.ts writes the one sentence the user reads around it, so nothing is said twice.
import { ProviderError, type ProviderConfig, type ToolOutput } from '../types'

/** Answer for a tool call that was never run because the conversation moved on (Stop, or a new user message). */
export const NOT_RUN_TEXT = 'Not run: the user stopped the turn or sent a new message before this tool call ran.'

/** Strip trailing slashes so the SDKs never build '//chat/completions'. */
export function trimBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/** The key to send, or a ProviderError the settings form can explain. Keyless presets get a placeholder the local
 *  servers ignore (both SDKs insist on some credential). */
export function resolveKey(config: Pick<ProviderConfig, 'preset' | 'apiKey'>): string {
  const key = config.apiKey.trim()
  if (key) return key
  if (config.preset.needsKey) throw new ProviderError('auth', `Add your ${config.preset.label} API key in the chat settings.`, { retryable: false })
  return 'local'
}

// Provider messages sometimes quote part of the key ("Incorrect API key provided: sk-pro********abcd"). Anything that
// looks like a key, masked or not, is cut out before a message reaches the UI.
const KEYISH = /\b(?:sk|gsk|xai)[-_][A-Za-z0-9_\-*]{4,}|\bAIza[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]*\*{3,}[A-Za-z0-9_-]*/g

/** Remove the key (and anything key-like) from a message; also caps its length. */
export function redact(message: string, key: string): string {
  let out = message
  const k = key.trim()
  if (k.length >= 4) out = out.split(k).join('[key]')
  out = out.replace(KEYISH, '[key]')
  return out.length > 400 ? out.slice(0, 400) + '…' : out
}

/** The host of a base URL, for "could not reach …" messages (URL.host never includes a user name or password). */
export function hostOf(url: string): string {
  try { return new URL(url).host } catch { return url || 'the server' }
}

/** A base URL that is safe to show: no user name, password, query or fragment (any of them may hold a secret). */
export function cleanUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname === '/' ? '' : u.pathname}`
  } catch { return 'its address' }
}

/** Does the URL point at this computer (localhost, *.localhost, 127.0.0.0/8, [::1])? */
export function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase()
    return h === 'localhost' || h.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(h) || h === '[::1]'
  } catch { return false }
}

/** The message only names the host; the chat's notice (src/agent/loop.ts describeError) says what to do. */
export function networkError(baseUrl: string): ProviderError {
  return new ProviderError('network', `Could not reach ${hostOf(baseUrl)}.`)
}

export function abortedError(): ProviderError {
  return new ProviderError('aborted', 'Stopped.', { retryable: false })
}

/** Strictly parse a streamed tool input. '' means no arguments. Non-objects are refused (every tool takes an object). */
export function parseToolInput(raw: string): { input: unknown; inputError?: string } {
  const text = raw.trim()
  if (!text) return { input: {} }
  try {
    const value: unknown = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { input: undefined, inputError: 'the tool input must be a JSON object' }
    }
    return { input: value }
  } catch {
    const snippet = text.length > 200 ? text.slice(0, 200) + '…' : text
    return { input: undefined, inputError: `the tool input was not valid JSON: ${snippet}` }
  }
}

/** Text for a tool result; providers reject empty text blocks. */
export function resultText(output: ToolOutput): string {
  return output.text.trim() ? output.text : '(no output)'
}
