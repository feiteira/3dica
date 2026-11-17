// The Chat panel (#chat, the right column's second tab): an AI assistant that works on the open project through the
// same tools as the local MCP server (src/agent/tools.ts → src/mcp/handlers.ts). Runs entirely in this tab: the user's
// own API key goes straight to the chosen provider. Parts: a header (provider · model, context size, New chat), the
// transcript (./chat-transcript.ts) or an empty state with example prompts, the composer, and the settings sub-view
// (./chat-settings.ts). The ChatController (src/agent/loop.ts) emits on every streamed delta; renders are coalesced to
// one per animation frame and only patch the entries that changed.
// Bundle: only loop.ts, settings.ts, presets.ts and adapters.ts are imported here; the tool layer, the system prompt and
// the provider SDKs load on the first message.
import type { AppContext } from '../app/context'
import type { ChatEntry, ProviderConfig } from '../agent/types'
import { ChatController } from '../agent/loop'
import { loadKey, loadSettings, toProviderConfig, type AiSettings } from '../agent/settings'
import { h, setText } from './dom'
import { icon } from './icons'
import { Transcript, type NoticeAction } from './chat-transcript'
import { createSettingsView } from './chat-settings'
import type { RightTabs } from './right-tabs'

export interface ChatPanel {
  readonly controller: ChatController
  focusInput(): void
}

const EXAMPLES = [
  'Make a 40 × 30 × 5 mm plate with a 6 mm hole in the middle',
  'Describe the scene and take a multi-view screenshot',
  'Make the second fixture unique and widen only its plate to 80 mm',
  'Find any code errors in the project and fix them',
]

/** the message box grows up to this many lines, then scrolls */
const MAX_LINES = 8
const LINE_PX = 18
const PAD_PX = 14

/** What keeps the chat from working (null = ready); the same checks the loop makes before a turn. */
export function setupProblem(c: ProviderConfig | null): string | null {
  if (!c) return 'Choose a provider in the chat settings to start.'
  if (c.preset.needsKey && !c.apiKey.trim()) return `Add your ${c.preset.label} API key to start.`
  if (!c.model.trim()) return 'Choose a model to start.'
  if (c.preset.baseUrlEditable && !c.baseUrl.trim()) return 'Enter the server address to start.'
  return null
}

/** 850 → "850", 12345 → "12.3k", 123456 → "123k", 1234567 → "1.2M" */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

const shortLabel = (label: string): string => label.replace(/\s*\(.*\)$/, '')

export function mount(el: HTMLElement, ctx: AppContext, tabs: RightTabs): ChatPanel {
  el.classList.add('panel', 'chat')
  const chat = new ChatController({ ctx, maxSteps: loadSettings().maxSteps })
  const apply = (s: AiSettings) => {
    chat.maxSteps = s.maxSteps
    chat.configure(toProviderConfig(s, loadKey(s.presetId)))
  }
  apply(loadSettings())

  // ── header
  const providerText = h('span', { class: 'chat-provider-text' })
  const providerBtn = h('button', { type: 'button', class: 'chat-provider', 'data-testid': 'chat-provider', title: 'Chat settings: provider, key and model' },
    providerText, icon('chevron', 'icon chat-provider-caret'))
  const usageEl = h('span', { class: 'chat-usage', 'data-testid': 'chat-usage' })
  const newBtn = h('button', { type: 'button', class: 'mini-btn', 'data-testid': 'chat-new', title: 'Start a new conversation' }, icon('plus'), 'New chat')
  const head = h('div', { class: 'chat-head' }, providerBtn, h('span', { class: 'spacer' }), usageEl, newBtn)

  // ── empty state
  const examples = h('div', { class: 'chat-examples' }, EXAMPLES.map((text) => {
    const b = h('button', { type: 'button', class: 'chat-example', 'data-testid': 'chat-example', title: 'Put this in the message box' }, text)
    b.addEventListener('click', () => {
      input.value = text
      autosize()
      input.focus()
      input.setSelectionRange(text.length, text.length)
      render()
    })
    return b
  }))
  const setupBtn = h('button', { type: 'button', class: 'btn btn-primary', 'data-testid': 'chat-setup' }, icon('sliders'), 'Set up a provider')
  const empty = h('div', { class: 'chat-empty', 'data-testid': 'chat-empty' },
    h('div', { class: 'chat-empty-mark' }, icon('spark')),
    h('p', { class: 'chat-empty-text' }, 'Ask the assistant to build or change the model. It reads the scene, writes code, places copies and takes screenshots to check its work. Every change is one undo step.'),
    examples, setupBtn,
    h('p', { class: 'chat-empty-foot muted small' }, 'Bring your own API key: the chat talks to the provider straight from this tab.'))

  // ── transcript
  // after Approve / Decline the card's buttons disappear: the keyboard goes back to the message box, never to <body>
  // (where Backspace would delete the selected object)
  const afterConfirm = () => { if (!input.disabled) input.focus() }
  const transcript = new Transcript({
    ctx,
    approve: (id) => { chat.approve(id); afterConfirm() },
    decline: (id) => { chat.decline(id); afterConfirm() },
    openSettings: () => showView('settings'),
    continueRun: () => { stick = true; void chat.continue() },
    newChat: () => { void chat.newChat().then(() => focusInput()) },
    configuredModel: () => chat.config?.model,
  })
  const body = h('div', { class: 'chat-body', 'data-testid': 'chat-body' }, empty, transcript.el)

  // ── composer
  const input = h('textarea', { class: 'chat-input', rows: 1, 'data-testid': 'chat-input', 'aria-label': 'Message to the AI', spellcheck: true })
  const sendIcon = h('span', { class: 'chat-send-icon' })
  const sendBtn = h('button', { type: 'button', class: 'chat-send', 'data-testid': 'chat-send' }, sendIcon)
  const hintText = h('span', null)
  const hintBtn = h('button', { type: 'button', class: 'link', 'data-testid': 'chat-hint-setup' }, 'Set up')
  const hint = h('div', { class: 'chat-hint small', 'data-testid': 'chat-hint' }, hintText, hintBtn)
  const composer = h('div', { class: 'chat-composer' }, h('div', { class: 'chat-box' }, input, sendBtn), hint)

  // screen readers: an approval the run waits for is said at once, not after the polite log's queue
  const announcer = h('div', { class: 'sr-only', 'aria-live': 'assertive', 'data-testid': 'chat-announce' })
  let announced = ''

  const main = h('div', { class: 'chat-main' }, head, body, composer, announcer)
  const settings = createSettingsView({ onApply: apply, onClose: () => showView('chat') })
  settings.el.hidden = true
  el.append(main, settings.el)

  // ── behaviour
  let view: 'chat' | 'settings' = 'chat'
  const showView = (v: 'chat' | 'settings') => {
    view = v
    if (v === 'settings') settings.open()
    main.hidden = v !== 'chat'
    settings.el.hidden = v !== 'settings'
    if (v === 'settings') settings.focusFirst()
    else { stick = true; autosize(); render(); focusInput() }
  }
  providerBtn.addEventListener('click', () => showView('settings'))
  setupBtn.addEventListener('click', () => showView('settings'))
  hintBtn.addEventListener('click', () => showView('settings'))
  newBtn.addEventListener('click', () => {
    void chat.newChat().then(() => input.focus())
  })

  const autosize = () => {
    if (input.offsetParent === null) return // hidden: measured when the panel shows
    const max = MAX_LINES * LINE_PX + PAD_PX
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, max)}px`
    input.style.overflowY = input.scrollHeight > max ? 'auto' : 'hidden'
  }

  const send = () => {
    const text = input.value.trim()
    if (!text || chat.state !== 'idle' || setupProblem(chat.config)) return
    input.value = ''
    autosize()
    stick = true
    void chat.send(text)
  }

  input.addEventListener('input', () => { autosize(); render() })
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    // Enter and Ctrl+Enter send; the app's own Ctrl+Enter ("Run code") must not fire from here, so the event stops
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      e.stopPropagation()
      send()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      input.blur()
    }
  })
  sendBtn.addEventListener('click', () => {
    if (chat.state === 'running') chat.stop()
    else { send(); input.focus() }
  })

  // auto-scroll while the user is at the bottom; scrolling up to read stops it until they come back down
  let stick = true
  body.addEventListener('scroll', () => {
    stick = body.scrollHeight - body.scrollTop - body.clientHeight < 40
  }, { passive: true })

  const actionsFor = (e: Extract<ChatEntry, { kind: 'notice' }>, last: boolean): NoticeAction[] => {
    const out: NoticeAction[] = []
    if (/chat settings/i.test(e.text)) out.push('settings')
    if (/start a new chat/i.test(e.text)) out.push('new')
    // Retry only where sending the same request again may work (or the settings changed since the error)
    if (last && chat.canContinue && (chat.lastEnd !== 'error' || chat.canRetry)) out.push(chat.lastEnd === 'error' ? 'retry' : 'continue')
    return out
  }

  /** set an attribute only when it changes (a write of the same value is still a DOM mutation screen readers see) */
  const setAttr = (node: Element, name: string, value: string) => { if (node.getAttribute(name) !== value) node.setAttribute(name, value) }

  let lastSend = ''
  const render = () => {
    const entries = chat.entries
    const state = chat.state
    const config = chat.config
    const problem = setupProblem(config)
    if (el.dataset.state !== state) el.dataset.state = state
    setText(providerText, config && !problem ? `${shortLabel(config.preset.label)} · ${config.model}` : config ? `${shortLabel(config.preset.label)} · set up` : 'Set up a provider')
    // the header cuts a long model id; the tooltip has all of it
    setAttr(providerBtn, 'title', config && !problem ? `${shortLabel(config.preset.label)} · ${config.model} — chat settings` : 'Chat settings: provider, key and model')
    const u = chat.usage
    setText(usageEl, u.contextTokens ? `${fmtTokens(u.contextTokens)} context` : '')
    setAttr(usageEl, 'title', u.contextTokens
      ? `About ${u.contextTokens.toLocaleString('en-US')} tokens in the model's context after the last turn · ${u.outputTokens.toLocaleString('en-US')} output tokens in this chat`
      : '')
    newBtn.disabled = entries.length === 0

    const hasEntries = entries.length > 0
    empty.hidden = hasEntries
    transcript.el.hidden = !hasEntries
    examples.hidden = !!problem
    setupBtn.hidden = !problem
    const pending = entries.find((e): e is Extract<ChatEntry, { kind: 'confirm' }> => e.kind === 'confirm' && e.state === 'pending')
    const waiting = !!pending
    if (pending && pending.id !== announced) {
      announced = pending.id
      setText(announcer, `Approval needed: ${pending.title}. ${pending.message}`)
    } else if (!pending) setText(announcer, '')
    transcript.update(entries, actionsFor, waiting)
    // screen readers: announce a reply once it is complete, not every streamed fragment — but only while text streams,
    // so an approval card (which the run waits for) is announced at once
    setAttr(transcript.el, 'aria-busy', String(entries.some((e) => e.kind === 'assistant' && e.streaming)))

    input.disabled = !!problem
    input.placeholder = problem ? 'Set up a provider to start' : 'Ask to build or change the model…'
    const running = state !== 'idle'
    const sendState = state === 'running' ? 'stop' : state === 'stopping' ? 'stopping' : 'send'
    if (sendState !== lastSend) {
      lastSend = sendState
      sendIcon.replaceChildren(icon(sendState === 'send' ? 'send' : 'stop'))
      sendBtn.dataset.mode = sendState
      const label = sendState === 'send' ? 'Send (Enter)' : sendState === 'stop' ? 'Stop' : 'Stopping…'
      sendBtn.title = label
      sendBtn.setAttribute('aria-label', label)
    }
    sendBtn.disabled = state === 'stopping' || (!running && (!!problem || !input.value.trim()))
    hintBtn.hidden = !problem
    setText(hintText, problem ? `${problem} `
      : waiting ? 'Waiting for your approval above.'
        : running ? 'Working… Stop interrupts it.' : 'Enter to send · Shift+Enter for a new line')

    tabs.setChatActivity(waiting ? 'attention' : running ? 'busy' : 'idle')
    if (stick && view === 'chat') body.scrollTop = body.scrollHeight
  }

  let frame = 0
  const schedule = () => {
    if (frame) return
    frame = requestAnimationFrame(() => { frame = 0; render() })
  }
  chat.subscribe(schedule)

  const focusInput = () => {
    if (view === 'settings') { settings.focusFirst(); return }
    if (input.disabled) setupBtn.hidden ? hintBtn.focus() : setupBtn.focus()
    else input.focus()
  }
  tabs.onChange((tab, opts) => {
    if (tab !== 'chat') return
    autosize()
    render() // the panel was hidden: catch up and scroll to the end now that it has a size
    if (opts.focus) focusInput()
  })

  autosize()
  render()
  return { controller: chat, focusInput }
}
