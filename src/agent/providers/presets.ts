// The providers the chat settings offer. Every hosted preset here was checked from a real browser and with CORS
// preflights from both https://feiteira.github.io and a localhost origin, for the exact method and headers the adapters
// send (POST chat/messages, GET models): the provider must answer the preflight with the origin (or *) and list every
// request header, or the browser blocks the call before it leaves the tab. Left out for that reason: xAI (it answers
// Access-Control-Allow-Headers: *, which by the Fetch spec does not cover Authorization, so Firefox and Safari block
// it; it can still be used as Custom). The OpenAI-compatible adapter strips the SDK's x-stainless-* telemetry headers,
// because Mistral and Gemini reject them in the preflight.
// defaultModel is only filled in where a current model id could be checked without a key (Anthropic: the documented
// default; OpenRouter: its public model list). Elsewhere the user picks from the fetched list or types an id.
import type { ProviderPreset } from '../types'

export const PRESETS: ProviderPreset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    family: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    baseUrlEditable: false,
    needsKey: true,
    defaultModel: 'claude-opus-5-5',
    keyUrl: 'https://platform.claude.com/settings/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    family: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    baseUrlEditable: false,
    needsKey: true,
    defaultModel: '',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    family: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    baseUrlEditable: false,
    needsKey: true,
    defaultModel: 'anthropic/claude-opus-5.5',
    keyUrl: 'https://openrouter.ai/settings/keys',
    note: 'One key for models from many providers.',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    family: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    baseUrlEditable: false,
    needsKey: true,
    defaultModel: '',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'groq',
    label: 'Groq',
    family: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    baseUrlEditable: false,
    needsKey: true,
    defaultModel: '',
    keyUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    family: 'openai-compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    baseUrlEditable: false,
    needsKey: true,
    defaultModel: '',
    keyUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    family: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    baseUrlEditable: false,
    needsKey: true,
    defaultModel: '',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    family: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    baseUrlEditable: true,
    needsKey: false,
    defaultModel: '',
    note: 'On the hosted site, start Ollama with OLLAMA_ORIGINS=https://feiteira.github.io and pick a model that supports tools.',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    family: 'openai-compatible',
    baseUrl: 'http://localhost:1234/v1',
    baseUrlEditable: true,
    needsKey: false,
    defaultModel: '',
    note: 'Turn on CORS in the LM Studio server settings and load a model that supports tools.',
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    family: 'openai-compatible',
    baseUrl: '',
    baseUrlEditable: true,
    needsKey: false,
    defaultModel: '',
    note: 'Any OpenAI-compatible API (base URL ending in /v1) that allows requests from this page (CORS). Key optional.',
  },
]

export function presetById(id: string): ProviderPreset | undefined {
  return PRESETS.find((p) => p.id === id)
}
