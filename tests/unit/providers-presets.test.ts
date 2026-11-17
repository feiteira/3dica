// Provider presets (src/agent/providers/presets.ts) and the adapters' shared helpers (src/agent/providers/common.ts).
import { describe, expect, it } from 'vitest'
import { PRESETS, presetById } from '../../src/agent/providers/presets'
import { cleanUrl, isLoopbackUrl, networkError, parseToolInput, redact, resolveKey, resultText, trimBaseUrl } from '../../src/agent/providers/common'
import { adapter as anthropicAdapter } from '../../src/agent/providers/anthropic'
import { adapter as openaiAdapter } from '../../src/agent/providers/openai-compatible'
import { ProviderError } from '../../src/agent/types'

describe('URL helpers', () => {
  it('cleanUrl drops a user name, password, query and fragment; isLoopbackUrl knows this computer', () => {
    expect(cleanUrl('https://user:pw@mock.example/v1?token=abc#x')).toBe('https://mock.example/v1')
    expect(cleanUrl('http://localhost:11434/v1/')).toBe('http://localhost:11434/v1/')
    expect(cleanUrl('https://mock.example')).toBe('https://mock.example')
    expect(cleanUrl('not a url')).toBe('its address')
    for (const u of ['http://localhost:1234/v1', 'http://LOCALHOST', 'http://app.localhost/v1', 'http://127.0.0.1:8080', 'http://127.1.2.3', 'http://[::1]:11434/v1']) expect(isLoopbackUrl(u), u).toBe(true)
    for (const u of ['http://192.168.1.5:11434/v1', 'http://plain.example/v1', 'http://localhost.example.com', 'https://127.0.0.1.nip.io', '']) expect(isLoopbackUrl(u), u).toBe(false)
    expect(networkError('https://user:pw@mock.example/v1').message).toBe('Could not reach mock.example.')
  })
})

describe('presets', () => {
  it('ids are unique and presetById finds each one', () => {
    const ids = PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const p of PRESETS) expect(presetById(p.id)).toBe(p)
    expect(presetById('nope')).toBeUndefined()
  })

  it('offers the verified providers, Anthropic first with claude-opus-5-5', () => {
    expect(PRESETS.map((p) => p.id)).toEqual(['anthropic', 'openai', 'openrouter', 'gemini', 'groq', 'mistral', 'deepseek', 'ollama', 'lmstudio', 'custom'])
    expect(presetById('anthropic')).toMatchObject({ family: 'anthropic', defaultModel: 'claude-opus-5-5', needsKey: true, baseUrlEditable: false })
    expect(PRESETS.filter((p) => p.family === 'anthropic').map((p) => p.id)).toEqual(['anthropic'])
  })

  it('hosted presets: https, fixed URL, need a key; local ones: editable, keyless, with a CORS hint', () => {
    for (const p of PRESETS) {
      if (['ollama', 'lmstudio', 'custom'].includes(p.id)) {
        expect(p.baseUrlEditable, p.id).toBe(true)
        expect(p.needsKey, p.id).toBe(false)
        expect(p.note, p.id).toBeTruthy()
      } else {
        expect(p.baseUrl, p.id).toMatch(/^https:\/\/[^/]+/)
        expect(p.baseUrl.endsWith('/'), p.id).toBe(false)
        expect(p.needsKey, p.id).toBe(true)
        expect(p.keyUrl, p.id).toMatch(/^https:\/\//)
      }
    }
    expect(presetById('ollama')!.note).toContain('OLLAMA_ORIGINS=https://feiteira.github.io')
  })

  it('the exported adapters match their families', () => {
    expect(anthropicAdapter.family).toBe('anthropic')
    expect(openaiAdapter.family).toBe('openai-compatible')
  })
})

describe('provider helpers', () => {
  it('parseToolInput is strict: objects only, "" means {}', () => {
    expect(parseToolInput('{"a":1}')).toEqual({ input: { a: 1 } })
    expect(parseToolInput('  ')).toEqual({ input: {} })
    expect(parseToolInput('[1]')).toMatchObject({ input: undefined, inputError: 'the tool input must be a JSON object' })
    expect(parseToolInput('{"a": 1} trailing').inputError).toMatch(/not valid JSON/)
    expect(parseToolInput('{"code": "cube(').inputError).toMatch(/not valid JSON/)
  })

  it('redact removes the key and key-like strings, and caps the length', () => {
    const key = 'sk-or-v1-abcdef0123456789'
    expect(redact(`bad key ${key} here`, key)).toBe('bad key [key] here')
    expect(redact('Incorrect API key provided: sk-proj-********abcd.', 'other')).toBe('Incorrect API key provided: [key].')
    expect(redact('Use AIzaSyA-abcdefghijk instead', '')).toBe('Use [key] instead')
    expect(redact('x'.repeat(1000), '').length).toBeLessThanOrEqual(401)
    // a plain message stays as it is
    expect(redact('Your credit balance is too low.', key)).toBe('Your credit balance is too low.')
  })

  it('resolveKey: the key, a placeholder for keyless presets, an auth error otherwise', () => {
    expect(resolveKey({ preset: presetById('openai')!, apiKey: ' k1 ' })).toBe('k1')
    expect(resolveKey({ preset: presetById('ollama')!, apiKey: '' })).toBe('local')
    expect(() => resolveKey({ preset: presetById('anthropic')!, apiKey: '' })).toThrow(ProviderError)
  })

  it('small helpers', () => {
    expect(trimBaseUrl(' http://localhost:1234/v1// ')).toBe('http://localhost:1234/v1')
    expect(resultText({ text: '' })).toBe('(no output)')
    expect(resultText({ text: 'ok' })).toBe('ok')
  })
})
