// src/agent/settings.ts — chat settings in localStorage, API keys apart (localStorage only when remembered, else
// sessionStorage), every storage access guarded, and nothing of it reaching the autosave or a project file.
import { describe, expect, it } from 'vitest'
import {
  AI_KEYS_KEY, AI_SETTINGS_KEY, defaultSettings, forgetAll, forgetAllKeys, forgetKey, loadKey, loadSettings, parseSettings,
  presetSettings, safeBaseUrl, saveKey, saveSettings, setRememberKey, toProviderConfig, withPresetSettings, type StorageLike,
} from '../../src/agent/settings'
import { presetById } from '../../src/agent/providers/presets'
import { Autosave, BACKUP_SLOTS, KEY_BACKUP_META, KEY_CURRENT, KEY_EVALUATING, KEY_UI, backupKey } from '../../src/state/autosave'
import { sampleProject } from '../../src/core/sample'
import { serialize } from '../../src/core/project-io'

class Mem implements StorageLike {
  map = new Map<string, string>()
  getItem(k: string) { return this.map.get(k) ?? null }
  setItem(k: string, v: string) { this.map.set(k, v) }
  removeItem(k: string) { this.map.delete(k) }
}
class Broken implements StorageLike {
  getItem(): string | null { throw new Error('SecurityError') }
  setItem(): void { throw new Error('QuotaExceededError') }
  removeItem(): void { throw new Error('SecurityError') }
}

const KEY = 'sk-ant-api03-TESTKEYTESTKEY'
const env = () => ({ local: new Mem(), session: new Mem() })

describe('chat settings', () => {
  it('defaults, then a round trip', () => {
    const e = env()
    expect(loadSettings(e)).toEqual({ presetId: 'anthropic', perPreset: {}, vision: true, maxSteps: 25, rememberKey: false })
    let s = withPresetSettings(defaultSettings(), 'ollama', { model: 'qwen3', baseUrl: 'http://127.0.0.1:11434/v1' })
    s = { ...s, presetId: 'ollama', effort: 'high', vision: false, maxSteps: 40 }
    expect(saveSettings(s, e)).toBe(true)
    expect(loadSettings(e)).toEqual(s)
    expect(presetSettings(s, 'ollama')).toEqual({ model: 'qwen3', baseUrl: 'http://127.0.0.1:11434/v1' })
    expect(presetSettings(s, 'openai')).toEqual({ model: '', baseUrl: '' })
  })

  it('stored junk is cleaned up field by field', () => {
    expect(parseSettings({
      presetId: 'nope', perPreset: { nope: { model: 'x' }, openai: { model: '  gpt-x  ', baseUrl: 'javascript:alert(1)' }, custom: 'bad' },
      effort: 'ultra', vision: 'yes', maxSteps: 1e6, rememberKey: 'true', apiKey: KEY,
    })).toEqual({ presetId: 'anthropic', perPreset: { openai: { model: 'gpt-x', baseUrl: '' } }, vision: true, maxSteps: 25, rememberKey: false })
    const e = env()
    e.local.setItem(AI_SETTINGS_KEY, '{not json')
    expect(loadSettings(e)).toEqual(defaultSettings())
  })

  it('never writes a key into the settings record', () => {
    const e = env()
    saveSettings({ ...defaultSettings(), apiKey: KEY } as never, e)
    expect(e.local.getItem(AI_SETTINGS_KEY)).not.toContain('TESTKEY')
  })
})

describe('chat settings: base URLs with credentials', () => {
  it('a user name or password in a base URL is never stored or used (it would sit in localStorage whatever "remember" says)', () => {
    expect(safeBaseUrl('https://user:s3cret-pass@mock.example/v1')).toBe('')
    expect(safeBaseUrl('http://admin@localhost:11434/v1')).toBe('')
    expect(safeBaseUrl('https://mock.example/v1')).toBe('https://mock.example/v1')
    expect(safeBaseUrl('ftp://mock.example')).toBe('')
    const e = env()
    const s = withPresetSettings(defaultSettings(), 'custom', { model: 'm', baseUrl: 'https://user:s3cret-pass@mock.example/v1' })
    saveSettings({ ...s, presetId: 'custom' }, e)
    expect(e.local.getItem(AI_SETTINGS_KEY)).not.toContain('s3cret')
    expect(presetSettings(loadSettings(e), 'custom').baseUrl).toBe('')
    // and a value stored before this rule is not used either
    expect(toProviderConfig({ ...s, presetId: 'custom' }, '')!.baseUrl).toBe('')
  })
})

describe('chat API keys', () => {
  it('not remembered: sessionStorage only; remembered: localStorage only', () => {
    const e = env()
    expect(saveKey('anthropic', ` ${KEY} `, false, e)).toBe('session')
    expect(JSON.parse(e.session.getItem(AI_KEYS_KEY)!)).toEqual({ anthropic: KEY })
    expect(e.local.getItem(AI_KEYS_KEY)).toBeNull()
    expect(loadKey('anthropic', e)).toBe(KEY)
    expect(saveKey('anthropic', KEY, true, e)).toBe('local')
    expect(e.session.getItem(AI_KEYS_KEY)).toBeNull()
    expect(JSON.parse(e.local.getItem(AI_KEYS_KEY)!)).toEqual({ anthropic: KEY })
    saveKey('openai', 'sk-proj-other', true, e)
    expect(loadKey('openai', e)).toBe('sk-proj-other')
    expect(loadKey('groq', e)).toBe('')
  })

  it('switching "remember" moves the keys; forget one, forget all', () => {
    const e = env()
    saveKey('anthropic', KEY, false, e)
    saveKey('openrouter', 'sk-or-v1-x', false, e)
    const s = setRememberKey(defaultSettings(), true, e)
    expect(s.rememberKey).toBe(true)
    expect(loadSettings(e).rememberKey).toBe(true)
    expect(e.session.getItem(AI_KEYS_KEY)).toBeNull()
    expect(JSON.parse(e.local.getItem(AI_KEYS_KEY)!)).toEqual({ anthropic: KEY, openrouter: 'sk-or-v1-x' })
    setRememberKey(s, false, e)
    expect(e.local.getItem(AI_KEYS_KEY)).toBeNull()
    expect(loadKey('openrouter', e)).toBe('sk-or-v1-x')
    forgetKey('openrouter', e)
    expect(loadKey('openrouter', e)).toBe('')
    expect(loadKey('anthropic', e)).toBe(KEY)
    saveKey('openai', 'sk-proj-y', true, e)
    forgetAllKeys(e)
    expect(e.local.getItem(AI_KEYS_KEY)).toBeNull()
    expect(e.session.getItem(AI_KEYS_KEY)).toBeNull()
    expect(loadKey('anthropic', e)).toBe('')
    saveKey('anthropic', KEY, true, e)
    saveSettings(defaultSettings(), e)
    forgetAll(e)
    expect([...e.local.map.keys(), ...e.session.map.keys()]).toEqual([])
    expect(saveKey('anthropic', '  ', true, e)).toBe('none')
  })

  it('blocked storage never throws; keys then live in memory for this page only', () => {
    const e = { local: new Broken(), session: new Broken() }
    expect(loadSettings(e)).toEqual(defaultSettings())
    expect(saveSettings(defaultSettings(), e)).toBe(false)
    expect(saveKey('anthropic', KEY, true, e)).toBe('memory')
    expect(loadKey('anthropic', e)).toBe(KEY)
    forgetKey('anthropic', e)
    expect(loadKey('anthropic', e)).toBe('')
    expect(() => forgetAll(e)).not.toThrow()
    const none = { local: null, session: null }
    expect(saveKey('openai', 'k-1', false, none)).toBe('memory')
    forgetAllKeys(none)
    expect(loadKey('openai', none)).toBe('')
  })

  it('the autosave and project files never pick the keys up', () => {
    const local = new Mem()
    const e = { local, session: new Mem() }
    saveKey('anthropic', KEY, true, e)
    saveSettings(defaultSettings(), e)
    const autosave = new Autosave({ storage: local, now: () => 1_000_000 })
    autosave.saveNow(sampleProject())
    autosave.saveUiNow({ expanded: {}, gizmoMode: 'translate', gizmoSpace: 'world', snap: true, ghostOthers: true })
    autosave.markEvaluating('Bolt')
    const appKeys = [KEY_CURRENT, KEY_UI, KEY_BACKUP_META, KEY_EVALUATING, ...Array.from({ length: BACKUP_SLOTS }, (_, i) => backupKey(i))]
    expect(appKeys).not.toContain(AI_KEYS_KEY)
    expect(appKeys).not.toContain(AI_SETTINGS_KEY)
    for (const k of appKeys) expect(local.getItem(k) ?? '', k).not.toContain('TESTKEY')
    const booted = autosave.boot('')
    expect(JSON.stringify(booted)).not.toContain('TESTKEY')
    expect(serialize(booted.project)).not.toContain('TESTKEY')
    expect(loadKey('anthropic', e)).toBe(KEY) // and the autosave left the key alone
  })
})

describe('provider config', () => {
  it('from the settings and a key', () => {
    const s = { ...defaultSettings(), effort: 'medium' as const, vision: false }
    expect(toProviderConfig(s, ` ${KEY} `)).toEqual({ preset: presetById('anthropic'), baseUrl: 'https://api.anthropic.com', apiKey: KEY, model: presetById('anthropic')!.defaultModel, vision: false, effort: 'medium' })
    // a fixed base URL cannot be overridden; an editable one can, and falls back to the preset's
    const o = withPresetSettings(withPresetSettings(defaultSettings(), 'openai', { baseUrl: 'https://evil.example/v1', model: 'gpt-x' }), 'ollama', { model: 'qwen3' })
    expect(toProviderConfig({ ...o, presetId: 'openai' }, 'k')).toMatchObject({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-x' })
    expect(toProviderConfig({ ...o, presetId: 'ollama' }, '')).toMatchObject({ baseUrl: 'http://localhost:11434/v1', model: 'qwen3', apiKey: '' })
    const c = withPresetSettings({ ...defaultSettings(), presetId: 'custom' }, 'custom', { baseUrl: 'https://llm.example/v1', model: 'm' })
    expect(toProviderConfig(c, '')).toMatchObject({ baseUrl: 'https://llm.example/v1', model: 'm' })
    expect('effort' in toProviderConfig(defaultSettings(), 'k')!).toBe(false)
    expect(toProviderConfig({ ...defaultSettings(), presetId: 'gone' }, 'k')).toBeNull()
  })
})
