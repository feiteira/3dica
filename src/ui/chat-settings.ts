// The chat's settings, shown inside the Chat panel in place of the transcript: provider, base URL, API key (with
// "remember in this browser"), model (a free-text field with the provider's model list as suggestions), effort, images,
// step limit. Save stores them (src/agent/settings.ts: the key apart from the other settings) and applies them at once.
// The key lives only in the password field's value property and in storage — never in an attribute, a log or a message.
// "Remember the key" starts off: remembered keys sit in localStorage, which every page of the site can read (on the
// hosted app, every GitHub Pages site of the account), so remembering is the user's choice. A key is never sent over
// plain http to another machine, and never put in a base URL.
import { ProviderError, type Effort, type ProviderPreset } from '../agent/types'
import { PRESETS, presetById } from '../agent/providers/presets'
import { getAdapter } from '../agent/adapters'
import { redactKey } from '../agent/loop'
import { isLoopbackUrl } from '../agent/providers/common'
import {
  AI_SETTINGS_KEY, MAX_STEPS_LIMIT, forgetKey, loadKey, loadSettings, presetSettings, saveKey, saveSettings, setRememberKey,
  withPresetSettings, type AiSettings,
} from '../agent/settings'
import { h, setText } from './dom'
import { icon } from './icons'

export interface SettingsView {
  el: HTMLElement
  /** fill the form from what is stored and show it */
  open(): void
  focusFirst(): void
}

export interface SettingsViewOptions {
  /** settings were saved (or a key forgotten): apply them */
  onApply(settings: AiSettings): void
  /** Cancel / Save: back to the transcript */
  onClose(): void
}

interface Draft { key: string; model: string; baseUrl: string }

const ANTHROPIC_EFFORTS: [Effort, string][] = [['low', 'Low'], ['medium', 'Medium (default)'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']]
const OPENAI_EFFORTS: [Effort | '', string][] = [['', 'Default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]

/** model lists per preset + base URL, for this page */
const modelCache = new Map<string, string[]>()

let seq = 0

/** The host a request goes to, for the privacy line ('' when the URL is not usable yet). */
export function hostOf(url: string): string {
  try { return new URL(url).host } catch { return '' }
}

/** The effort the form shows for a stored value (OpenAI-compatible APIs take low / medium / high only). */
function shownEffort(e: Effort | undefined, family: ProviderPreset['family']): string {
  if (family === 'anthropic') return e ?? 'medium'
  return e === 'xhigh' || e === 'max' ? 'high' : e ?? ''
}

/** Has the user saved chat settings in this browser before? (the first Save also stores the "remember" choice) */
function hasStoredSettings(): boolean {
  try { return localStorage.getItem(AI_SETTINGS_KEY) !== null } catch { return false }
}

/** What is wrong with a base URL the user typed (null: usable). */
export function baseUrlProblem(s: string): string | null {
  let u: URL
  try { u = new URL(s) } catch { return 'Enter a full URL starting with https:// (or http:// for a server on this computer).' }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.host) return 'Enter a full URL starting with https:// (or http:// for a server on this computer).'
  if (u.username || u.password) return 'Put the key in the API key field, not in the URL.'
  return null
}

/** A key would cross the network unencrypted: plain http to anything but this computer. */
export function keyOverPlainHttp(base: string, key: string): boolean {
  if (!key.trim()) return false
  try { return new URL(base).protocol === 'http:' && !isLoopbackUrl(base) } catch { return false }
}

const PLAIN_HTTP = 'Your key would be sent unencrypted. Use https://, or leave the key empty for a server on your network.'

/** Where "remember" keeps the key, for the hint (storage belongs to the whole origin). */
function siteName(): string {
  try { return location.host || 'this site' } catch { return 'this site' }
}

export function createSettingsView(opts: SettingsViewOptions): SettingsView {
  const uid = `ai${++seq}`
  let stored: AiSettings = loadSettings()
  let presetId = stored.presetId
  const drafts = new Map<string, Draft>()
  let modelsAbort: AbortController | null = null

  const draftOf = (id: string): Draft => {
    let d = drafts.get(id)
    if (!d) {
      const p = presetSettings(stored, id)
      drafts.set(id, (d = { key: loadKey(id), model: p.model, baseUrl: p.baseUrl }))
    }
    return d
  }
  const preset = (): ProviderPreset => presetById(presetId) ?? PRESETS[0]

  // ── fields
  const presetSel = h('select', { id: `${uid}-preset`, 'data-testid': 'ai-preset' }, PRESETS.map((p) => h('option', { value: p.id }, p.label)))
  const note = h('p', { class: 'ai-note muted small', 'data-testid': 'ai-note' })

  const baseUrlIn = h('input', { type: 'url', class: 'txt', id: `${uid}-base`, 'data-testid': 'ai-base-url', spellcheck: false, autocomplete: 'off', placeholder: 'https://example.com/v1' })
  const baseUrlErr = h('div', { class: 'field-error', role: 'alert', 'data-testid': 'ai-base-url-error' })
  const baseRow = h('div', { class: 'ai-field' }, h('label', { for: baseUrlIn.id }, 'Base URL'), baseUrlIn, baseUrlErr)

  const keyIn = h('input', {
    type: 'password', class: 'txt', id: `${uid}-key`, 'data-testid': 'ai-key', spellcheck: false, autocomplete: 'off',
    'data-1p-ignore': true, 'data-lpignore': 'true',
  })
  const keyToggle = h('button', { type: 'button', class: 'icon-btn ai-eye', 'data-testid': 'ai-key-toggle', title: 'Show the key', 'aria-label': 'Show the key', 'aria-pressed': 'false' }, icon('eye'))
  keyToggle.addEventListener('click', () => {
    const show = keyIn.type === 'password'
    keyIn.type = show ? 'text' : 'password'
    keyToggle.replaceChildren(icon(show ? 'eyeOff' : 'eye'))
    keyToggle.title = show ? 'Hide the key' : 'Show the key'
    keyToggle.setAttribute('aria-label', keyToggle.title)
    keyToggle.setAttribute('aria-pressed', String(show))
  })
  const keyLabel = h('label', { for: keyIn.id }, 'API key')
  const keyLink = h('a', { class: 'ai-link', target: '_blank', rel: 'noopener noreferrer', 'data-testid': 'ai-key-link' }, 'Get a key', icon('external'))
  const keyErr = h('div', { class: 'field-error', role: 'alert', 'data-testid': 'ai-key-error' })
  const rememberCb = h('input', { type: 'checkbox', id: `${uid}-remember`, 'data-testid': 'ai-remember' })
  const forgetBtn = h('button', { type: 'button', class: 'link ai-forget', 'data-testid': 'ai-forget-key' }, 'Forget key')
  const keyStatus = h('span', { class: 'muted small', 'data-testid': 'ai-key-status', 'aria-live': 'polite' })
  const keyRow = h('div', { class: 'ai-field' },
    h('div', { class: 'ai-label-row' }, keyLabel, h('span', { class: 'spacer' }), keyLink),
    h('div', { class: 'ai-key-wrap' }, keyIn, keyToggle),
    keyErr,
    h('label', { class: 'check ai-check' }, rememberCb, h('span', null, 'Remember the key in this browser')),
    h('p', { class: 'muted small ai-hint', 'data-testid': 'ai-remember-hint' },
      `On: kept in this browser's local storage, which every page on ${siteName()} can read. Off: kept only until this tab closes.`),
    h('div', { class: 'ai-key-actions' }, forgetBtn, keyStatus))

  const listId = `${uid}-models`
  const datalist = h('datalist', { id: listId })
  const modelIn = h('input', { type: 'text', class: 'txt', id: `${uid}-model`, 'data-testid': 'ai-model', list: listId, spellcheck: false, autocomplete: 'off' })
  const refreshBtn = h('button', { type: 'button', class: 'btn btn-sm ai-refresh', 'data-testid': 'ai-models-refresh', title: 'Load the models this key can use' }, icon('refresh'), 'Refresh')
  const modelsMsg = h('div', { class: 'ai-models-msg small', 'data-testid': 'ai-models-msg', 'aria-live': 'polite' })
  const modelErr = h('div', { class: 'field-error', role: 'alert', 'data-testid': 'ai-model-error' })
  const modelRow = h('div', { class: 'ai-field' },
    h('label', { for: modelIn.id }, 'Model'),
    h('div', { class: 'ai-model-wrap' }, modelIn, refreshBtn), datalist, modelsMsg, modelErr)

  const effortSel = h('select', { id: `${uid}-effort`, 'data-testid': 'ai-effort' })
  const effortNote = h('p', { class: 'muted small ai-hint' })
  const visionCb = h('input', { type: 'checkbox', 'data-testid': 'ai-vision' })
  const stepsIn = h('input', { type: 'number', class: 'num ai-steps', id: `${uid}-steps`, 'data-testid': 'ai-max-steps', min: 1, max: MAX_STEPS_LIMIT, step: 1 })
  const stepsErr = h('div', { class: 'field-error', role: 'alert', 'data-testid': 'ai-max-steps-error' })
  const privacy = h('p', { class: 'ai-privacy small', 'data-testid': 'ai-privacy' })

  const cancelBtn = h('button', { type: 'button', class: 'btn', 'data-testid': 'ai-cancel' }, 'Cancel')
  const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary', 'data-testid': 'ai-save' }, 'Save')

  const form = h('form', { class: 'ai-form', 'data-testid': 'ai-settings', novalidate: true, autocomplete: 'off' },
    h('div', { class: 'ai-head' }, h('h3', { class: 'ai-title' }, 'Chat settings'),
      h('p', { class: 'muted small' }, 'Bring your own API key. The chat talks to the provider straight from this tab.')),
    h('div', { class: 'ai-field' }, h('label', { for: presetSel.id }, 'Provider'), presetSel, note),
    baseRow, keyRow, modelRow,
    h('div', { class: 'ai-field' }, h('label', { for: effortSel.id }, 'Effort'), effortSel, effortNote),
    h('div', { class: 'ai-field' },
      h('label', { class: 'check ai-check' }, visionCb, h('span', null, 'Send screenshots as images')),
      h('p', { class: 'muted small ai-hint' }, 'Off: the model gets only the text that comes with each screenshot. Models that can\'t read images get only the text anyway.')),
    h('div', { class: 'ai-field ai-inline' }, h('label', { for: stepsIn.id }, 'Max steps per message'), stepsIn),
    stepsErr,
    privacy,
    h('div', { class: 'ai-actions' }, cancelBtn, saveBtn))
  const el = h('div', { class: 'chat-settings', 'data-testid': 'chat-settings' }, form)

  // ── behaviour

  /** the base URL requests go to with the form as it is */
  const effectiveBase = (): string => {
    const p = preset()
    return p.baseUrlEditable ? baseUrlIn.value.trim() || p.baseUrl : p.baseUrl
  }
  const cacheKey = (): string => `${presetId}|${effectiveBase()}`

  const showPrivacy = () => {
    const p = preset()
    const host = hostOf(effectiveBase())
    const where = host || 'the server you enter above'
    setText(privacy, p.needsKey || keyIn.value.trim()
      ? `Your key is sent only to ${where}. 3Dica has no server.`
      : `Requests go only to ${where}. 3Dica has no server.`)
  }

  const fillModels = (ids: string[]) => {
    datalist.replaceChildren(...ids.map((id) => h('option', { value: id })))
  }

  const setModelsMsg = (text: string, kind: 'info' | 'error' | 'busy' = 'info') => {
    setText(modelsMsg, text)
    modelsMsg.dataset.kind = kind
  }

  const refreshModels = async (auto: boolean) => {
    modelsAbort?.abort()
    const p = preset()
    const key = keyIn.value.trim()
    if (p.needsKey && !key) {
      if (!auto) setModelsMsg(`Paste your ${p.label} API key first.`, 'error')
      return
    }
    const base = effectiveBase()
    if (p.baseUrlEditable && baseUrlProblem(base)) {
      if (!auto) setModelsMsg(base ? baseUrlProblem(base)! : 'Enter the base URL first.', 'error')
      return
    }
    if (keyOverPlainHttp(base, key)) {
      if (!auto) setModelsMsg(PLAIN_HTTP, 'error')
      return
    }
    const abort = new AbortController()
    modelsAbort = abort
    const forKey = cacheKey()
    const forPreset = presetId
    setModelsMsg('Loading models…', 'busy')
    refreshBtn.disabled = true
    try {
      const adapter = await getAdapter(p.family)
      const ids = await adapter.listModels({ preset: p, baseUrl: base, apiKey: key, vision: visionCb.checked }, abort.signal)
      if (abort.signal.aborted || forPreset !== presetId) return
      modelCache.set(forKey, ids)
      fillModels(ids)
      setModelsMsg(ids.length ? `${ids.length} ${ids.length === 1 ? 'model' : 'models'} — type to filter, or pick from the list.` : 'The provider listed no models that can use tools. You can still type a model id.')
      if (!modelIn.value.trim() && !p.defaultModel && ids.length) modelIn.value = ids[0]
    } catch (e) {
      if (abort.signal.aborted) return
      setModelsMsg(modelsError(e, p, base, key), 'error')
    } finally {
      if (modelsAbort === abort) { modelsAbort = null; refreshBtn.disabled = false }
    }
  }

  const clearErrors = () => {
    for (const [input, err] of [[baseUrlIn, baseUrlErr], [keyIn, keyErr], [modelIn, modelErr], [stepsIn, stepsErr]] as const) {
      input.classList.remove('invalid')
      err.classList.remove('show')
      setText(err, '')
    }
  }
  const fieldError = (input: HTMLInputElement, err: HTMLElement, text: string) => {
    input.classList.add('invalid')
    setText(err, text)
    err.classList.add('show')
  }

  /** keep what was typed for the preset being left */
  const stash = () => {
    const d = draftOf(presetId)
    d.key = keyIn.value
    d.model = modelIn.value.trim()
    const p = preset()
    if (p.baseUrlEditable) d.baseUrl = baseUrlIn.value.trim() === p.baseUrl ? '' : baseUrlIn.value.trim()
  }

  const showPreset = (auto: boolean) => {
    const p = preset()
    const d = draftOf(presetId)
    presetSel.value = p.id
    note.hidden = !p.note
    setText(note, p.note ?? '')
    baseRow.hidden = !p.baseUrlEditable
    baseUrlIn.value = p.baseUrlEditable ? d.baseUrl || p.baseUrl : ''
    baseUrlIn.placeholder = p.baseUrl || 'https://example.com/v1'
    keyIn.value = d.key
    keyIn.type = 'password'
    keyToggle.replaceChildren(icon('eye'))
    keyToggle.setAttribute('aria-pressed', 'false')
    setText(keyLabel, p.needsKey ? `${p.label.replace(/\s*\(.*\)$/, '')} API key` : 'API key (optional)')
    keyIn.placeholder = p.needsKey ? 'Paste your key' : 'Not needed for most local servers'
    keyLink.hidden = !p.keyUrl
    if (p.keyUrl) keyLink.href = p.keyUrl
    setText(keyStatus, '')
    forgetBtn.hidden = !loadKey(p.id)
    modelIn.value = d.model
    modelIn.placeholder = p.defaultModel ? `${p.defaultModel} (default)` : 'Model id, e.g. from the list'
    const cached = modelCache.get(cacheKey())
    fillModels(cached ?? [])
    setModelsMsg(cached ? `${cached.length} ${cached.length === 1 ? 'model' : 'models'}.` : p.needsKey && !d.key.trim() ? '' : 'Press Refresh to load the model list.')
    // effort options depend on the API family
    const shown = shownEffort(stored.effort, p.family)
    const opts = p.family === 'anthropic' ? ANTHROPIC_EFFORTS : OPENAI_EFFORTS
    effortSel.replaceChildren(...opts.map(([v, label]) => h('option', { value: v }, label)))
    effortSel.value = opts.some(([v]) => v === shown) ? shown : opts[0][0]
    setText(effortNote, p.family === 'anthropic'
      ? 'How hard Claude thinks before it answers. Used by Claude 4.6 and later.'
      : 'Sent only to models that take it (OpenAI reasoning models, OpenRouter).')
    clearErrors()
    showPrivacy()
    if (auto && !cached && p.needsKey && d.key.trim()) void refreshModels(true)
  }

  presetSel.addEventListener('change', () => {
    stash()
    presetId = presetSel.value
    showPreset(true)
  })
  baseUrlIn.addEventListener('input', () => { showPrivacy(); baseUrlIn.classList.remove('invalid'); baseUrlErr.classList.remove('show') })
  keyIn.addEventListener('input', () => { showPrivacy(); keyIn.classList.remove('invalid'); keyErr.classList.remove('show'); setText(keyStatus, '') })
  // a pasted key loads the model list once the field is left (not on every keystroke) — but not when the user is
  // leaving it for Save or Cancel: the list is not needed then, and its status line must not move the button mid-click.
  // Keyless presets (local and custom servers) load it only through Refresh: their address may not be final yet, and
  // the key must not go there before Save
  let keyAtFocus = ''
  keyIn.addEventListener('focus', () => { keyAtFocus = keyIn.value })
  keyIn.addEventListener('focusout', (e) => {
    const to = e.relatedTarget
    if (!preset().needsKey || to === saveBtn || to === cancelBtn || keyIn.value === keyAtFocus) return
    if (keyIn.value.trim() && !modelCache.has(cacheKey())) void refreshModels(true)
  })
  modelIn.addEventListener('input', () => { modelIn.classList.remove('invalid'); modelErr.classList.remove('show') })
  stepsIn.addEventListener('input', () => { stepsIn.classList.remove('invalid'); stepsErr.classList.remove('show') })
  refreshBtn.addEventListener('click', () => void refreshModels(false))

  forgetBtn.addEventListener('click', () => {
    forgetKey(presetId)
    draftOf(presetId).key = ''
    keyIn.value = ''
    setText(keyStatus, 'Key forgotten.')
    forgetBtn.hidden = true
    showPrivacy()
    stored = loadSettings()
    opts.onApply(stored)
  })

  cancelBtn.addEventListener('click', () => {
    modelsAbort?.abort()
    opts.onClose()
  })
  // Esc anywhere in the form is Cancel (and never reaches the app's own Esc, which would change the 3D selection)
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.isComposing) return
    e.preventDefault()
    e.stopPropagation()
    cancelBtn.click()
  })

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    clearErrors()
    const p = preset()
    const key = keyIn.value.trim()
    const base = baseUrlIn.value.trim()
    const model = modelIn.value.trim()
    const steps = Number(stepsIn.value)
    let first: HTMLInputElement | null = null
    const bad = (input: HTMLInputElement, err: HTMLElement, text: string) => { fieldError(input, err, text); first ??= input }
    if (p.baseUrlEditable) {
      const problem = base ? baseUrlProblem(base) : null
      if (!base && !p.baseUrl) bad(baseUrlIn, baseUrlErr, 'Enter the server\'s base URL, e.g. https://example.com/v1')
      else if (problem) bad(baseUrlIn, baseUrlErr, problem)
      else if (keyOverPlainHttp(effectiveBase(), key)) bad(baseUrlIn, baseUrlErr, PLAIN_HTTP)
    }
    if (p.needsKey && !key) bad(keyIn, keyErr, `Paste your ${p.label} API key, or press Cancel.`)
    if (!model && !p.defaultModel) bad(modelIn, modelErr, 'Enter a model id, or press Refresh to load the list.')
    if (!Number.isInteger(steps) || steps < 1 || steps > MAX_STEPS_LIMIT) bad(stepsIn, stepsErr, `A whole number from 1 to ${MAX_STEPS_LIMIT}.`)
    if (first) { (first as HTMLInputElement).focus(); return }

    stash()
    const remember = rememberCb.checked
    let next: AiSettings = stored
    for (const [id, d] of drafts) next = withPresetSettings(next, id, { model: d.model, baseUrl: d.baseUrl })
    // keep the stored effort when the form shows it unchanged, so saving untouched settings never resets the conversation
    const chosen = effortSel.value as Effort | ''
    const effort = chosen === shownEffort(stored.effort, p.family) ? stored.effort : chosen || undefined
    next = { ...next, presetId, vision: visionCb.checked, maxSteps: steps }
    if (effort) next.effort = effort
    else delete next.effort
    if (remember !== stored.rememberKey || !hasStoredSettings()) next = setRememberKey(next, remember)
    saveSettings(next)
    for (const [id, d] of drafts) {
      if (d.key.trim() !== loadKey(id)) saveKey(id, d.key, remember)
    }
    stored = loadSettings()
    modelsAbort?.abort()
    opts.onApply(stored)
    opts.onClose()
  })

  return {
    el,
    open() {
      stored = loadSettings()
      drafts.clear()
      presetId = stored.presetId
      rememberCb.checked = stored.rememberKey // off until the user chooses it (see the header)
      visionCb.checked = stored.vision
      stepsIn.value = String(stored.maxSteps)
      showPreset(true)
      form.scrollTop = 0
    },
    focusFirst() {
      const p = preset()
      const target = p.needsKey && !keyIn.value.trim() ? keyIn : presetSel
      target.focus()
    },
  }
}

/** A model-list failure for the settings form: what went wrong and what to do, never the key. */
function modelsError(e: unknown, p: ProviderPreset, base: string, key: string): string {
  const label = p.label.replace(/\s*\(.*\)$/, '')
  const host = hostOf(base) || 'the server'
  const text = (m: string) => redactKey(m, key).replace(/\s+/g, ' ').trim()
  if (e instanceof ProviderError) {
    switch (e.kind) {
      case 'auth': return p.needsKey ? `${label} did not accept this key.` : 'The server asked for an API key.'
      case 'permission': return `${label} refused this key${e.status ? ` (${e.status})` : ''}. It may need credit or other permissions.`
      case 'not_found': return `${label} has no model list at ${host}.${p.baseUrlEditable ? ' Check the base URL.' : ''} You can still type a model id.`
      case 'rate_limit': return `${label} rate limit reached. Try again shortly.`
      case 'overloaded': return `${label} is overloaded right now. Try again in a minute.`
      case 'server': return `${label} had a server error${e.status ? ` (${e.status})` : ''}. Try again in a moment.`
      case 'network': return p.baseUrlEditable
        ? `Could not reach ${host}. Check the address, and that the server is running and allows requests from this page (CORS).`
        : `Could not reach ${label}. Check your connection.`
      default: return `Could not load the models: ${text(e.message) || 'unknown error'}`
    }
  }
  return `Could not load the models: ${text(e instanceof Error ? e.message : String(e))}`
}
