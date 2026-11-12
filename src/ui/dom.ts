// DOM helpers shared by every panel: h() element builder, toasts (aria-live), <dialog> based confirm / problems
// dialogs (never window.alert / confirm / prompt), an inline-rename input, and small formatting helpers.
import type { ConfirmFn, ConfirmOptions, ProblemsFn, ToastFn, ToastKind } from '../app/context'
import { icon } from './icons'

export type Child = Node | string | number | null | undefined | false | Child[]
export type Attrs = Record<string, unknown>

/** Keys set as DOM properties (after attributes, so e.g. a range's min/max exist before its value). */
const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'indeterminate', 'draggable', 'tabIndex', 'textContent', 'spellcheck', 'open', 'hidden'])

/**
 * h('div', { class: 'row', 'data-testid': 'tree-row', onclick: fn, style: { width: '3px' } }, 'text', childNode)
 * null / undefined / false attribute values are skipped; true becomes an empty attribute.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (attrs) {
    const props: [string, unknown][] = []
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue
      if (PROPS.has(k)) { props.push([k, v]); continue }
      if (k === 'class' || k === 'className') el.className = String(v)
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener)
      else el.setAttribute(k, v === true ? '' : String(v))
    }
    for (const [k, v] of props) (el as unknown as Record<string, unknown>)[k] = v
  }
  append(el, children)
  return el
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue
    if (Array.isArray(c)) append(el, c)
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c)
  }
}

/** Replace all children. */
export function setChildren(el: Node, ...children: Child[]): void {
  while (el.firstChild) el.removeChild(el.firstChild)
  append(el, children)
}

/** Set an attribute only when it changes (keeps MutationObserver / style recalcs quiet). */
export function setAttrIfChanged(el: Element, name: string, value: string | null): void {
  if (value === null) { if (el.hasAttribute(name)) el.removeAttribute(name); return }
  if (el.getAttribute(name) !== value) el.setAttribute(name, value)
}

export function setText(el: Node, text: string): void {
  if (el.textContent !== text) el.textContent = text
}

/** True when keyboard focus is in something that takes text (shortcuts are ignored there, §4.13). */
export function isEditable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable) return true
  const tag = t.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file'].includes(type)
  }
  return !!t.closest('.cm-editor')
}

// ───────────────────────────── formatting ─────────────────────────────

const NF = new Intl.NumberFormat('en-US')
/** 61234 → "61,234" */
export function fmtInt(n: number): string { return NF.format(Math.round(n)) }

/** Number for an input field: at most 4 decimals, no trailing zeros, -0 → 0. */
export function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return ''
  const r = Math.round(v * 1e4) / 1e4
  return String(r === 0 ? 0 : r)
}

export function plural(n: number, one: string, many = one + 's'): string { return `${n} ${n === 1 ? one : many}` }

// ───────────────────────────── toasts ─────────────────────────────

let toastHost: HTMLElement | null = null
const TOAST_MS: Record<ToastKind, number> = { info: 3500, warn: 5000, error: 6500 }
const MAX_TOASTS = 5

function ensureToastHost(): HTMLElement {
  if (toastHost && toastHost.isConnected) return toastHost
  toastHost = h('div', { class: 'toasts', 'aria-live': 'polite', role: 'status', 'data-testid': 'toasts' })
  document.body.appendChild(toastHost)
  return toastHost
}

/** Non-blocking notification (bottom-right). The same message while still visible refreshes instead of stacking. */
export const toast: ToastFn = (message, kind = 'info') => {
  const host = ensureToastHost()
  const existing = [...host.children].find((c) => (c as HTMLElement).dataset.msg === message) as HTMLElement | undefined
  if (existing) {
    existing.classList.remove('bump')
    void existing.offsetWidth
    existing.classList.add('bump')
    restartToastTimer(existing, kind)
    return
  }
  const el = h('div', { class: `toast toast-${kind}`, 'data-testid': 'toast', 'data-kind': kind, role: kind === 'error' ? 'alert' : null },
    icon(kind === 'error' ? 'error' : kind === 'warn' ? 'warn' : 'info', 'icon toast-icon'),
    h('span', { class: 'toast-msg' }, message))
  el.dataset.msg = message
  el.addEventListener('click', () => dismissToast(el))
  host.appendChild(el)
  while (host.children.length > MAX_TOASTS) host.firstElementChild?.remove()
  restartToastTimer(el, kind)
}

const toastTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()
function restartToastTimer(el: HTMLElement, kind: ToastKind) {
  const old = toastTimers.get(el)
  if (old) clearTimeout(old)
  toastTimers.set(el, setTimeout(() => dismissToast(el), TOAST_MS[kind]))
}
function dismissToast(el: HTMLElement) {
  if (el.classList.contains('out')) return
  el.classList.add('out')
  setTimeout(() => el.remove(), 200)
}

// ───────────────────────────── dialogs ─────────────────────────────

/** Modal confirm built on <dialog>. Resolves true for the ok button; false for cancel, Esc or close. */
export const confirmDialog: ConfirmFn = (opts: ConfirmOptions) => new Promise<boolean>((resolve) => {
  const okBtn = h('button', { type: 'submit', value: 'ok', class: `btn ${opts.danger ? 'btn-danger' : 'btn-primary'}`, 'data-testid': 'confirm-ok' }, opts.ok)
  const cancelBtn = h('button', { type: 'submit', value: 'cancel', class: 'btn', 'data-testid': 'confirm-cancel' }, opts.cancel ?? 'Cancel')
  const dlg = h('dialog', { class: 'dlg', 'data-testid': 'confirm-dialog', 'aria-labelledby': 'dlg-title' },
    h('form', { method: 'dialog' },
      opts.title ? h('h3', { class: 'dlg-title', id: 'dlg-title' }, opts.title) : null,
      h('p', { class: 'dlg-msg' }, opts.message),
      h('div', { class: 'dlg-actions' }, cancelBtn, okBtn)))
  document.body.appendChild(dlg)
  dlg.addEventListener('close', () => {
    resolve(dlg.returnValue === 'ok')
    dlg.remove()
  }, { once: true })
  dlg.showModal()
  ;(opts.danger ? cancelBtn : okBtn).focus()
})

/** Modal list of problems (e.g. Open parse errors, §6). */
export const problemsDialog: ProblemsFn = (title, problems) => {
  const shown = problems.slice(0, 60)
  const okBtn = h('button', { type: 'submit', value: 'ok', class: 'btn btn-primary', 'data-testid': 'problems-ok' }, 'OK')
  const dlg = h('dialog', { class: 'dlg dlg-problems', 'data-testid': 'problems-dialog' },
    h('form', { method: 'dialog' },
      h('h3', { class: 'dlg-title' }, icon('error', 'icon dlg-icon'), title),
      h('p', { class: 'dlg-msg' }, problems.length === 1 ? 'The file has a problem:' : `The file has ${problems.length} problems:`),
      h('ul', { class: 'dlg-problems-list' }, shown.map((p) => h('li', null, p)),
        problems.length > shown.length ? h('li', { class: 'muted' }, `… and ${problems.length - shown.length} more`) : null),
      h('p', { class: 'dlg-msg muted' }, 'The current project was not changed.'),
      h('div', { class: 'dlg-actions' }, okBtn)))
  document.body.appendChild(dlg)
  dlg.addEventListener('close', () => dlg.remove(), { once: true })
  dlg.showModal()
  okBtn.focus()
}

// ───────────────────────────── inline rename ─────────────────────────────

export interface InlineRename {
  input: HTMLInputElement
  /** close without committing */
  cancel(): void
  readonly closed: boolean
}

/**
 * Swap `target` for a text input (data-testid="rename-input"). Enter commits (an error keeps it open and shows the
 * message inline); blur commits too (an error there toasts and cancels); Esc cancels. `onClose` runs once.
 */
export function inlineRename(target: HTMLElement, initial: string, commit: (text: string) => string | null,
  onClose: () => void, onBlurError: (msg: string) => void): InlineRename {
  const input = h('input', { class: 'rename-input', 'data-testid': 'rename-input', type: 'text', spellcheck: false, value: initial, 'aria-label': 'New name' })
  const err = h('div', { class: 'rename-error', 'data-testid': 'rename-error', role: 'alert' })
  const wrap = h('span', { class: 'rename-wrap' }, input, err)
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    wrap.replaceWith(target)
    onClose()
  }
  const tryCommit = (): string | null => {
    const problem = commit(input.value)
    if (problem) {
      input.classList.add('invalid')
      err.textContent = problem
      err.classList.add('show')
    }
    return problem
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation()
      if (!tryCommit()) close()
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation()
      close()
    } else {
      e.stopPropagation()
    }
  })
  input.addEventListener('input', () => { input.classList.remove('invalid'); err.classList.remove('show') })
  input.addEventListener('blur', () => {
    if (closed) return
    const problem = commit(input.value)
    if (problem) onBlurError(problem)
    close()
  })
  // keep clicks inside the input from selecting / dragging the row
  for (const t of ['click', 'dblclick', 'mousedown', 'dragstart'] as const) input.addEventListener(t, (e) => e.stopPropagation())
  target.replaceWith(wrap)
  input.focus()
  input.select()
  return { input, cancel: close, get closed() { return closed } }
}
