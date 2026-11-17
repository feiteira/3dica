// The right column's tab bar: [Inspector] [Chat] above the two panels (#inspector, #chat). WAI-ARIA tabs: the arrow
// keys, Home and End move between the tabs and activate them; only the active tab is in the Tab order. The active tab
// is remembered per browser (a convenience: storage may be blocked, then it simply starts on the Inspector).
// Ctrl+L (src/ui/shortcuts.ts → toggleChat) switches to the Chat and focuses its input, or back to the Inspector.
// Selecting things never switches tabs.
import { h } from './dom'
import { icon } from './icons'

export type RightTab = 'inspector' | 'chat'

export interface ShowOptions {
  /** move the keyboard into the panel (Ctrl+L): the chat focuses its message box */
  focus?: boolean
}

export interface RightTabs {
  active(): RightTab
  show(tab: RightTab, opts?: ShowOptions): void
  /** called after the active tab changed (or show() asked for focus); returns unsubscribe */
  onChange(cb: (tab: RightTab, opts: ShowOptions) => void): () => void
  /** the Chat tab's activity dot: 'busy' while the AI works, 'attention' when it waits for the user */
  setChatActivity(state: 'idle' | 'busy' | 'attention'): void
}

const STORE_KEY = '3dica:v1:right-tab'
const TABS: { id: RightTab; label: string; icon: string; title: string }[] = [
  { id: 'inspector', label: 'Inspector', icon: 'sliders', title: 'Inspector: edit the selected object' },
  { id: 'chat', label: 'Chat', icon: 'chat', title: 'AI chat (Ctrl+L)' },
]

function readTab(): RightTab {
  try { return localStorage.getItem(STORE_KEY) === 'chat' ? 'chat' : 'inspector' } catch { return 'inspector' }
}

function writeTab(tab: RightTab): void {
  try { localStorage.setItem(STORE_KEY, tab) } catch { /* storage blocked: not remembered */ }
}

let current: RightTabs | null = null
/** where the keyboard was before Ctrl+L went to the Chat (outside it): Ctrl+L back returns there */
let returnTo: HTMLElement | null = null

/** Can focus go back to this element (still in the page, not hidden)? */
function canRefocus(el: HTMLElement | null): el is HTMLElement {
  return !!el && el.isConnected && el !== document.body && el.offsetParent !== null
}

/**
 * Ctrl+L: Chat with its input focused, or back to the Inspector when the Chat is already showing. Back, the keyboard
 * returns to where it was (the code editor, a field) or to the Inspector tab — never to <body>, where typing would
 * run the app's shortcuts (Backspace deletes the selected object).
 */
export function toggleChat(): void {
  if (!current) return
  if (current.active() === 'chat') {
    const back = returnTo
    returnTo = null
    current.show('inspector')
    if (canRefocus(back)) back.focus()
    else document.getElementById('tab-inspector')?.focus()
  } else {
    const a = document.activeElement
    returnTo = a instanceof HTMLElement && !a.closest('#chat') ? a : null
    current.show('chat', { focus: true })
  }
}

export function mount(bar: HTMLElement, panels: Record<RightTab, HTMLElement>): RightTabs {
  bar.classList.add('rtabs')
  bar.setAttribute('role', 'tablist')
  bar.setAttribute('aria-label', 'Right panel')
  const listeners = new Set<(tab: RightTab, opts: ShowOptions) => void>()
  const buttons = new Map<RightTab, HTMLButtonElement>()
  let active: RightTab = readTab()
  const dot = h('span', { class: 'rtab-dot', 'aria-hidden': 'true' })

  for (const t of TABS) {
    const btn = h('button', {
      type: 'button', class: 'rtab', role: 'tab', id: `tab-${t.id}`, 'data-testid': `tab-${t.id}`,
      'aria-controls': panels[t.id].id, title: t.title,
    }, icon(t.icon), h('span', { class: 'rtab-label' }, t.label), t.id === 'chat' ? dot : null)
    btn.addEventListener('click', () => api.show(t.id))
    buttons.set(t.id, btn)
    bar.append(btn)
    const panel = panels[t.id]
    panel.setAttribute('role', 'tabpanel')
    panel.setAttribute('aria-labelledby', btn.id)
  }

  bar.addEventListener('keydown', (e) => {
    const i = TABS.findIndex((t) => t.id === active)
    let next: number | null = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % TABS.length
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + TABS.length) % TABS.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = TABS.length - 1
    if (next === null) return
    e.preventDefault() // the app's own shortcuts must not see it
    const id = TABS[next].id
    api.show(id)
    buttons.get(id)?.focus()
  })

  const apply = () => {
    for (const t of TABS) {
      const on = t.id === active
      const btn = buttons.get(t.id)!
      btn.setAttribute('aria-selected', String(on))
      btn.tabIndex = on ? 0 : -1
      btn.classList.toggle('on', on)
      panels[t.id].hidden = !on
    }
  }

  const api: RightTabs = {
    active: () => active,
    show(tab, opts = {}) {
      const changed = tab !== active
      if (changed) {
        // keep the keyboard out of a panel that is about to be hidden (a focused hidden field would swallow keys): it
        // moves to the new tab, not to <body>
        const a = document.activeElement
        const hiding = a instanceof HTMLElement && panels[active].contains(a)
        active = tab
        apply()
        writeTab(tab)
        if (hiding) buttons.get(tab)?.focus()
      }
      if (changed || opts.focus) for (const cb of [...listeners]) cb(tab, opts)
    },
    onChange(cb) {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
    setChatActivity(state) {
      if (dot.dataset.state !== state) dot.dataset.state = state
      const btn = buttons.get('chat')!
      btn.title = state === 'busy' ? 'AI chat — working… (Ctrl+L)' : state === 'attention' ? 'AI chat — waiting for you (Ctrl+L)' : TABS[1].title
    },
  }
  apply()
  api.setChatActivity('idle')
  current = api
  return api
}
