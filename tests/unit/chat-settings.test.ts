// The chat settings form's checks (src/ui/chat-settings.ts): base URLs and keys over plain http. The form itself is
// covered end to end in tests/e2e/chat.spec.ts.
import { describe, expect, it } from 'vitest'
import { baseUrlProblem, keyOverPlainHttp } from '../../src/ui/chat-settings'

describe('chat settings checks', () => {
  it('a base URL must be a full http(s) URL, without a user name or password', () => {
    expect(baseUrlProblem('https://llm.example.com/v1')).toBeNull()
    expect(baseUrlProblem('http://localhost:11434/v1')).toBeNull()
    expect(baseUrlProblem('not a url')).toMatch(/^Enter a full URL/)
    expect(baseUrlProblem('ftp://llm.example.com')).toMatch(/^Enter a full URL/)
    expect(baseUrlProblem('https://user:s3cret@llm.example.com/v1')).toBe('Put the key in the API key field, not in the URL.')
    expect(baseUrlProblem('https://user@llm.example.com/v1')).toBe('Put the key in the API key field, not in the URL.')
  })

  it('a key never goes over plain http to another machine; without a key, or to this computer, it is fine', () => {
    expect(keyOverPlainHttp('http://plain.example/v1', 'sk-plain-FAKE-0123456789')).toBe(true)
    expect(keyOverPlainHttp('http://192.168.1.5:1234/v1', 'k')).toBe(true)
    expect(keyOverPlainHttp('http://192.168.1.5:1234/v1', '  ')).toBe(false)
    expect(keyOverPlainHttp('https://plain.example/v1', 'k')).toBe(false)
    for (const local of ['http://localhost:1234/v1', 'http://127.0.0.1:11434/v1', 'http://[::1]:8080/v1', 'http://box.localhost/v1']) {
      expect(keyOverPlainHttp(local, 'k'), local).toBe(false)
    }
  })
})
