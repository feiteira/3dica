// AI chat settings. The choices (provider, per-provider model and base URL, effort, images, step limit, remember key)
// live in localStorage '3dica:v1:ai'. API keys are kept apart, under '3dica:v1:ai-keys' ({ [presetId]: key }):
// in localStorage when the user ticks "remember", otherwise in sessionStorage only (gone when the tab closes), and
// in memory when the browser allows neither. Nothing else in the app reads these two keys: the autosave writes its
// own keys (src/state/autosave.ts) and project files contain only the project (src/core/project-io.ts serialize).
// Every storage access is wrapped: a private window or blocked storage never breaks the chat.
import type { Effort, ProviderConfig, ProviderPreset } from './types'
import { presetById } from './providers/presets'
import { DEFAULT_MAX_STEPS } from './loop'

export const AI_SETTINGS_KEY = '3dica:v1:ai'
export const AI_KEYS_KEY = '3dica:v1:ai-keys'
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const MAX_STEPS_LIMIT = 200
export const DEFAULT_PRESET_ID = 'anthropic'

export interface PresetSettings {
  /** '' = the preset's default model */
  model: string
  /** '' = the preset's base URL (only used for presets whose base URL can be edited) */
  baseUrl: string
}

export interface AiSettings {
  presetId: string
  perPreset: Record<string, PresetSettings>
  /** undefined = the provider's default */
  effort?: Effort
  /** send screenshots to the model as images */
  vision: boolean
  /** model turns per user message before the chat pauses */
  maxSteps: number
  /** keep API keys in localStorage (true) or only for this tab (false) */
  rememberKey: boolean
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Where settings and keys go; default: the page's localStorage and sessionStorage. null = not available. */
export interface SettingsStorage {
  local?: StorageLike | null
  session?: StorageLike | null
}

export function defaultSettings(): AiSettings {
  return { presetId: DEFAULT_PRESET_ID, perPreset: {}, vision: true, maxSteps: DEFAULT_MAX_STEPS, rememberKey: false }
}

function storages(env?: SettingsStorage): { local: StorageLike | null; session: StorageLike | null } {
  const get = (name: 'localStorage' | 'sessionStorage'): StorageLike | null => {
    try { return (globalThis as Record<string, unknown>)[name] as StorageLike ?? null } catch { return null }
  }
  return {
    local: env && 'local' in env ? env.local ?? null : get('localStorage'),
    session: env && 'session' in env ? env.session ?? null : get('sessionStorage'),
  }
}

function read(s: StorageLike | null, key: string): string | null {
  if (!s) return null
  try { return s.getItem(key) } catch { return null }
}

function write(s: StorageLike | null, key: string, value: string): boolean {
  if (!s) return false
  try { s.setItem(key, value); return true } catch { return false }
}

function remove(s: StorageLike | null, key: string): void {
  if (!s) return
  try { s.removeItem(key) } catch { /* ignore */ }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** An http(s) base URL without a user name or password ('' otherwise): credentials in a URL would be stored here in
 *  plain text whatever "remember" says, and shown in messages. The key belongs in the key field. */
export function safeBaseUrl(url: string): string {
  if (!/^https?:\/\//i.test(url)) return ''
  try {
    const u = new URL(url)
    return u.username || u.password ? '' : url
  } catch { return '' }
}

/** A stored settings value, made safe: unknown fields dropped, every field checked, defaults where missing. */
export function parseSettings(raw: unknown): AiSettings {
  const d = defaultSettings()
  if (!isObj(raw)) return d
  const presetId = typeof raw.presetId === 'string' && presetById(raw.presetId) ? raw.presetId : d.presetId
  const perPreset: Record<string, PresetSettings> = {}
  if (isObj(raw.perPreset)) {
    for (const [id, v] of Object.entries(raw.perPreset)) {
      if (!presetById(id) || !isObj(v)) continue
      perPreset[id] = { model: text(v.model, 200), baseUrl: safeBaseUrl(text(v.baseUrl, 500)) }
    }
  }
  const out: AiSettings = {
    presetId,
    perPreset,
    vision: typeof raw.vision === 'boolean' ? raw.vision : d.vision,
    maxSteps: typeof raw.maxSteps === 'number' && Number.isInteger(raw.maxSteps) && raw.maxSteps >= 1 && raw.maxSteps <= MAX_STEPS_LIMIT ? raw.maxSteps : d.maxSteps,
    rememberKey: raw.rememberKey === true,
  }
  if (typeof raw.effort === 'string' && (EFFORTS as readonly string[]).includes(raw.effort)) out.effort = raw.effort as Effort
  return out
}

export function loadSettings(env?: SettingsStorage): AiSettings {
  const raw = read(storages(env).local, AI_SETTINGS_KEY)
  if (!raw) return defaultSettings()
  try { return parseSettings(JSON.parse(raw)) } catch { return defaultSettings() }
}

/** Write the settings (never a key: only the fields of AiSettings are written). false when storage is unavailable. */
export function saveSettings(settings: AiSettings, env?: SettingsStorage): boolean {
  const s = parseSettings(settings)
  const out: Record<string, unknown> = { presetId: s.presetId, perPreset: s.perPreset, vision: s.vision, maxSteps: s.maxSteps, rememberKey: s.rememberKey }
  if (s.effort) out.effort = s.effort
  return write(storages(env).local, AI_SETTINGS_KEY, JSON.stringify(out))
}

/** The model and base URL for one preset ('' = the preset's own). */
export function presetSettings(settings: AiSettings, presetId: string): PresetSettings {
  const p = settings.perPreset[presetId]
  return { model: p?.model ?? '', baseUrl: p?.baseUrl ?? '' }
}

/** A copy of `settings` with one preset's model / base URL changed. */
export function withPresetSettings(settings: AiSettings, presetId: string, patch: Partial<PresetSettings>): AiSettings {
  return { ...settings, perPreset: { ...settings.perPreset, [presetId]: { ...presetSettings(settings, presetId), ...patch } } }
}

// ───────────────────────────── keys ─────────────────────────────

/** keys of this page when neither storage works */
const memoryKeys = new Map<string, string>()

function readKeys(s: StorageLike | null): Record<string, string> {
  const raw = read(s, AI_KEYS_KEY)
  if (!raw) return {}
  try {
    const o = JSON.parse(raw) as unknown
    if (!isObj(o)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(o)) if (typeof v === 'string' && v) out[k] = v
    return out
  } catch { return {} }
}

function writeKeys(s: StorageLike | null, keys: Record<string, string>): boolean {
  if (!s) return false
  if (Object.keys(keys).length === 0) { remove(s, AI_KEYS_KEY); return true }
  return write(s, AI_KEYS_KEY, JSON.stringify(keys))
}

/** The stored key of a preset ('' = none): this tab's first, then the remembered one. */
export function loadKey(presetId: string, env?: SettingsStorage): string {
  const { local, session } = storages(env)
  return readKeys(session)[presetId] ?? readKeys(local)[presetId] ?? memoryKeys.get(presetId) ?? ''
}

/**
 * Store a key: remember → localStorage, else sessionStorage (and the other copy is removed). An empty key forgets it.
 * Returns where it went ('memory' when the browser blocks both storages: it lasts until the page closes).
 */
export function saveKey(presetId: string, key: string, remember: boolean, env?: SettingsStorage): 'local' | 'session' | 'memory' | 'none' {
  const k = key.trim()
  if (!k) { forgetKey(presetId, env); return 'none' }
  const { local, session } = storages(env)
  const [to, other] = remember ? [local, session] : [session, local]
  const otherKeys = readKeys(other)
  if (presetId in otherKeys) { delete otherKeys[presetId]; writeKeys(other, otherKeys) }
  memoryKeys.delete(presetId)
  if (writeKeys(to, { ...readKeys(to), [presetId]: k })) return remember ? 'local' : 'session'
  memoryKeys.set(presetId, k)
  return 'memory'
}

export function forgetKey(presetId: string, env?: SettingsStorage): void {
  const { local, session } = storages(env)
  for (const s of [local, session]) {
    const keys = readKeys(s)
    if (presetId in keys) { delete keys[presetId]; writeKeys(s, keys) }
  }
  memoryKeys.delete(presetId)
}

/** Forget every stored key (both storages and memory). */
export function forgetAllKeys(env?: SettingsStorage): void {
  const { local, session } = storages(env)
  remove(local, AI_KEYS_KEY)
  remove(session, AI_KEYS_KEY)
  memoryKeys.clear()
}

/** Forget every key and the chat settings. */
export function forgetAll(env?: SettingsStorage): void {
  forgetAllKeys(env)
  remove(storages(env).local, AI_SETTINGS_KEY)
}

/** Turn "remember keys" on or off: the stored keys move to the other storage; the settings are saved. */
export function setRememberKey(settings: AiSettings, remember: boolean, env?: SettingsStorage): AiSettings {
  const { local, session } = storages(env)
  const [from, to] = remember ? [session, local] : [local, session]
  const moving = readKeys(from)
  if (Object.keys(moving).length) {
    if (writeKeys(to, { ...readKeys(to), ...moving })) remove(from, AI_KEYS_KEY)
    else if (!remember) {
      // no sessionStorage: keep the keys for this page only rather than leaving them remembered
      for (const [id, k] of Object.entries(moving)) memoryKeys.set(id, k)
      remove(from, AI_KEYS_KEY)
    }
  }
  const next = { ...settings, rememberKey: remember }
  saveSettings(next, env)
  return next
}

// ───────────────────────────── provider config ─────────────────────────────

/** The ProviderConfig for the chosen preset with this key; null when the preset is unknown. */
export function toProviderConfig(settings: AiSettings, apiKey: string, preset: ProviderPreset | undefined = presetById(settings.presetId)): ProviderConfig | null {
  if (!preset) return null
  const p = presetSettings(settings, preset.id)
  const config: ProviderConfig = {
    preset,
    baseUrl: preset.baseUrlEditable ? (safeBaseUrl(p.baseUrl.trim()) || preset.baseUrl) : preset.baseUrl,
    apiKey: apiKey.trim(),
    model: p.model.trim() || preset.defaultModel,
    vision: settings.vision,
  }
  if (settings.effort) config.effort = settings.effort
  return config
}
