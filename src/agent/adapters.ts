// The provider adapters are loaded on demand (dynamic import), so the provider SDKs stay out of the app's first
// bundle and are only fetched once someone uses the chat. Each module exports `adapter: ProviderAdapter`.
import type { ApiFamily, ProviderAdapter } from './types'

export async function getAdapter(family: ApiFamily): Promise<ProviderAdapter> {
  const m = family === 'anthropic' ? await import('./providers/anthropic') : await import('./providers/openai-compatible')
  return m.adapter
}
