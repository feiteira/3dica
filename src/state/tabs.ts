// Another 3Dica tab of the same origin shares the single autosave slot (§6): the last tab to save wins. Detect it and
// let the app warn once, instead of silently overwriting each other's work.
// - BroadcastChannel: a new tab says 'hello', the tabs already open answer 'here' (both sides learn about each other)
// - the 'storage' event: another tab wrote `current` (fallback where BroadcastChannel is missing)
import { KEY_CURRENT } from './autosave'

export const TABS_CHANNEL = '3dica:v1:tabs'

type Msg = { type: 'hello' | 'here'; id: string }

export interface TabsEnv {
  BroadcastChannel?: typeof BroadcastChannel
  addEventListener?: (type: 'storage', cb: (e: StorageEvent) => void) => void
  removeEventListener?: (type: 'storage', cb: (e: StorageEvent) => void) => void
}

/** Calls `onOther` once, the first time another tab is seen. Returns a stop function. */
export function watchOtherTabs(onOther: () => void, env: TabsEnv = globalThis as unknown as TabsEnv): () => void {
  let seen = false
  const other = () => { if (!seen) { seen = true; onOther() } }
  const id = Math.random().toString(36).slice(2)
  let channel: BroadcastChannel | null = null
  try {
    if (env.BroadcastChannel) {
      channel = new env.BroadcastChannel(TABS_CHANNEL)
      channel.onmessage = (e: MessageEvent<Msg>) => {
        const m = e.data
        if (!m || typeof m !== 'object' || m.id === id) return
        if (m.type === 'hello') channel?.postMessage({ type: 'here', id } satisfies Msg)
        if (m.type === 'hello' || m.type === 'here') other()
      }
      channel.postMessage({ type: 'hello', id } satisfies Msg)
    }
  } catch { channel = null }
  const onStorage = (e: StorageEvent) => { if (e.key === KEY_CURRENT && e.newValue !== null) other() }
  try { env.addEventListener?.('storage', onStorage) } catch { /* ignore */ }
  return () => {
    try { channel?.close() } catch { /* ignore */ }
    try { env.removeEventListener?.('storage', onStorage) } catch { /* ignore */ }
  }
}
