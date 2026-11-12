// Two tabs share the one autosave slot (§6): each must notice the other instead of silently overwriting its work.
import { describe, expect, test } from 'vitest'
import { watchOtherTabs, type TabsEnv } from '../../src/state/tabs'
import { KEY_CURRENT } from '../../src/state/autosave'

/** BroadcastChannel stand-in: every channel with the same name in the same "browser" gets the others' messages */
function browser() {
  const channels = new Set<FakeChannel>()
  class FakeChannel {
    onmessage: ((e: { data: unknown }) => void) | null = null
    readonly name: string
    constructor(name: string) { this.name = name; channels.add(this) }
    postMessage(data: unknown) { for (const c of channels) if (c !== this && c.name === this.name) c.onmessage?.({ data: structuredClone(data) }) }
    close() { channels.delete(this) }
  }
  const storageListeners: ((e: StorageEvent) => void)[] = []
  const env = (): TabsEnv => ({
    BroadcastChannel: FakeChannel as unknown as typeof BroadcastChannel,
    addEventListener: (_t, cb) => { storageListeners.push(cb) },
    removeEventListener: () => {},
  })
  return { env, storage: (key: string) => { for (const cb of storageListeners) cb({ key, newValue: '{}' } as StorageEvent) } }
}

describe('another tab', () => {
  test('a second tab warns, and the first one learns about it too (once each)', () => {
    const b = browser()
    let first = 0, second = 0
    watchOtherTabs(() => first++, b.env())
    expect(first).toBe(0) // alone
    watchOtherTabs(() => second++, b.env())
    expect(second).toBe(1)
    expect(first).toBe(1)
    watchOtherTabs(() => {}, b.env()) // a third tab: no repeated warnings
    expect([first, second]).toEqual([1, 1])
  })

  test('without BroadcastChannel, another tab writing the autosave is noticed through the storage event', () => {
    let n = 0
    const listeners: ((e: StorageEvent) => void)[] = []
    watchOtherTabs(() => n++, { addEventListener: (_t, cb) => { listeners.push(cb) } })
    for (const cb of listeners) cb({ key: '3dica:v1:ui', newValue: '{}' } as StorageEvent)
    expect(n).toBe(0)
    for (const cb of listeners) cb({ key: KEY_CURRENT, newValue: '{}' } as StorageEvent)
    expect(n).toBe(1)
  })
})
