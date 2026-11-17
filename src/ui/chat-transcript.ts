// The chat transcript: one view per ChatEntry, keyed by entry id. The loop replaces an entry object whenever it changes
// (src/agent/loop.ts), so an update only touches entries whose object is new: while a reply streams, that is the one
// assistant message (only its changed Markdown blocks are rebuilt) or the one tool card. Model text goes through the safe Markdown
// renderer (./chat-markdown.ts); everything else is set with textContent.
import type { AppContext } from '../app/context'
import type { ChatEntry, ToolImage } from '../agent/types'
import type { InstancePath } from '../core/types'
import { instanceAtPath } from '../core/graph'
import { h, setText } from './dom'
import { icon } from './icons'
import { renderMarkdown } from './chat-markdown'

type Kind = ChatEntry['kind']
type EntryOf<K extends Kind> = Extract<ChatEntry, { kind: K }>
type ToolEntry = EntryOf<'tool'>

export type NoticeAction = 'settings' | 'continue' | 'retry' | 'new'

export interface TranscriptHooks {
  ctx: AppContext
  approve(id: string): void
  decline(id: string): void
  openSettings(): void
  continueRun(): void
  newChat(): void
  /** the model configured now (an answer from another model — a server-side fallback — is labelled) */
  configuredModel(): string | undefined
}

/** Friendly names and icons of the tools (shared/tool-catalog.mjs). */
const TOOLS: Record<string, [string, string]> = {
  status: ['Check the app', 'info'],
  get_scene: ['Read the scene', 'search'],
  list_definitions: ['List definitions', 'book'],
  get_definition: ['Read definition', 'code'],
  get_errors: ['Check errors', 'warn'],
  create_object: ['Create object', 'plus'],
  update_definition: ['Edit definition', 'edit'],
  add_instance: ['Place a copy', 'plus'],
  update_instance: ['Edit instance', 'edit'],
  move_instance: ['Move instance', 'move'],
  duplicate: ['Duplicate', 'copy'],
  make_unique: ['Make unique', 'unlink'],
  wrap: ['Wrap in group', 'group'],
  ungroup: ['Ungroup', 'group'],
  delete: ['Delete', 'trash'],
  undo: ['Undo', 'undo'],
  redo: ['Redo', 'redo'],
  select: ['Select', 'target'],
  set_view: ['Set view', 'frame'],
  new_project: ['New project', 'new'],
  load_sample: ['Load sample', 'sample'],
  save_project: ['Save project', 'save'],
  export_stl: ['Export STL', 'stl'],
  screenshot: ['Screenshot', 'camera'],
}

/** The name and icon of a tool. Own properties only: the name comes from the model, and 'constructor' or '__proto__'
 *  would otherwise find Object's own members. */
function toolInfo(name: string): [string, string] | undefined {
  return Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined
}

export function toolLabel(name: string): string {
  return toolInfo(name)?.[0] ?? name.replace(/_/g, ' ')
}

let uid = 0

const STATUS_TEXT: Record<ToolEntry['status'], string> = {
  streaming: 'writing…', running: 'running…', ok: 'done', error: 'failed', declined: 'declined', cancelled: 'cancelled',
}

/** Details panes show at most this much of a long input or result. */
const DETAIL_MAX = 20000

const clipDetail = (s: string): string =>
  s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX)}\n… (${(s.length - DETAIL_MAX).toLocaleString('en-US')} more characters)` : s

/** Indented JSON with short arrays of numbers / strings on one line ("t": [120, 0, 0]). */
export function prettyJson(v: unknown): string {
  return JSON.stringify(v, null, 2).replace(/\[\n\s+([^[\]{}\n]+(?:,\n\s+[^[\]{}\n]+)*)\n\s*\]/g, (m, inner: string) => {
    const one = `[${inner.split(/,\n\s+/).join(', ')}]`
    return one.length <= 80 ? one : m
  })
}

/** A tool input or result for the details pane: the JSON, with a `code` text pulled out so it reads as code. */
function detailParts(raw: string): { json: string; code: string | null } {
  if (!raw) return { json: '', code: null }
  let v: unknown
  try { v = JSON.parse(raw) } catch { return { json: clipDetail(raw), code: null } } // still streaming, or plain text
  if (isObj(v) && typeof v.code === 'string') {
    const { code, ...rest } = v
    return { json: clipDetail(prettyJson(rest)), code: clipDetail(code as string) }
  }
  return { json: clipDetail(prettyJson(v)), code: null }
}

const kb = (n: number): string => (n < 1000 ? `${n} B` : `${(n / 1000).toFixed(1)} kB`)

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Something in a finished tool call that the user can select: an instance path from the result, or a definition. */
function selectable(ctx: AppContext, e: ToolEntry): { label: string; run: () => void } | null {
  if (e.status !== 'ok') return null
  let result: unknown
  let input: unknown
  try { result = JSON.parse(e.resultText ?? '') } catch { result = null }
  try { input = JSON.parse(e.inputJson) } catch { input = null }
  const project = ctx.store.project
  const path = isObj(result) && Array.isArray(result.path) && result.path.every((s) => typeof s === 'string') ? result.path as InstancePath : null
  if (path?.length && instanceAtPath(project, path)) {
    const inst = instanceAtPath(project, path)!
    const name = inst.name ?? project.defs[inst.def]?.name ?? 'it'
    return { label: name, run: () => ctx.commands.selectFromTree(path) }
  }
  const defName = isObj(result) && typeof result.definition === 'string' ? result.definition
    : isObj(input) && typeof input.name === 'string' && ['update_definition', 'get_definition'].includes(e.name) ? input.name : null
  if (defName) {
    const def = Object.values(project.defs).find((d) => d.name === defName && d.id !== project.root)
    if (def) return { label: def.name, run: () => ctx.commands.selectDef(def.id) }
  }
  return null
}

interface View {
  entry: ChatEntry
  el: HTMLElement
  patch(e: ChatEntry): void
  /** notices only: which action buttons to show */
  setActions?(a: NoticeAction[]): void
  /** tool cards only: an approval card is waiting for the user (a running call then waits for them) */
  setWaiting?(waiting: boolean): void
}

export class Transcript {
  readonly el: HTMLElement
  private readonly hooks: TranscriptHooks
  private readonly views = new Map<string, View>()
  private dialog: HTMLDialogElement | null = null

  constructor(hooks: TranscriptHooks) {
    this.hooks = hooks
    this.el = h('div', { class: 'chat-log', 'data-testid': 'chat-log', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions' })
  }

  /** Bring the DOM in line with `entries`; `actionsFor` decides each notice's buttons; `waiting`: an approval is pending. */
  update(entries: readonly ChatEntry[], actionsFor: (e: EntryOf<'notice'>, last: boolean) => NoticeAction[], waiting = false): void {
    const seen = new Set<string>()
    let prev: Element | null = null
    entries.forEach((e, i) => {
      seen.add(e.id)
      let v = this.views.get(e.id)
      // one entry that fails to render (whatever a model sent) becomes a plain line; it must not stop the others
      try {
        if (!v || v.entry.kind !== e.kind) {
          v?.el.remove()
          v = this.build(e)
          this.views.set(e.id, v)
        } else if (v.entry !== e) {
          v.patch(e)
          v.entry = e
        }
      } catch (err) {
        v?.el.remove()
        v = this.broken(e)
        this.views.set(e.id, v)
        queueMicrotask(() => { throw err }) // still reported, like the loop's listener errors
      }
      if (e.kind === 'notice') v.setActions?.(actionsFor(e, i === entries.length - 1))
      if (e.kind === 'tool') v.setWaiting?.(waiting && e.status === 'running')
      // keep DOM order = entry order (the loop may insert a message before a turn's tool cards)
      const want: Element | null = prev ? prev.nextElementSibling : this.el.firstElementChild
      if (want !== v.el) this.el.insertBefore(v.el, want)
      prev = v.el
    })
    for (const [id, v] of this.views) {
      if (!seen.has(id)) { v.el.remove(); this.views.delete(id) }
    }
  }

  private build(e: ChatEntry): View {
    switch (e.kind) {
      case 'user': return this.user(e)
      case 'assistant': return this.assistant(e)
      case 'tool': return this.tool(e)
      case 'notice': return this.notice(e)
      case 'confirm': return this.confirm(e)
    }
  }

  // ───────────────────────────── entries ─────────────────────────────

  /** The stand-in for an entry that could not be rendered. */
  private broken(e: ChatEntry): View {
    const el = h('div', { class: 'chat-entry chat-notice', 'data-testid': 'chat-entry', 'data-kind': 'broken', 'data-level': 'warn' },
      h('div', { class: 'notice-main' }, h('div', { class: 'notice-text' }, `(This ${e.kind === 'tool' ? 'tool call' : 'part of the chat'} could not be shown.)`)))
    return { entry: e, el, patch: () => {} }
  }

  private user(e: EntryOf<'user'>): View {
    const text = h('div', { class: 'chat-user-text' }, e.text)
    const el = h('div', { class: 'chat-entry chat-user', 'data-testid': 'chat-entry', 'data-kind': 'user' }, text)
    return { entry: e, el, patch: (n) => setText(text, (n as EntryOf<'user'>).text) }
  }

  private assistant(e: EntryOf<'assistant'>): View {
    const body = h('div', { class: 'md' })
    const thinkBody = h('div', { class: 'chat-think-body' })
    const thinkLabel = h('span', null, 'Thinking')
    const think = h('details', { class: 'chat-think', 'data-testid': 'chat-thinking' },
      h('summary', null, h('span', { class: 'spin', 'aria-hidden': 'true' }), thinkLabel), thinkBody)
    const by = h('div', { class: 'chat-by muted small' })
    const el = h('div', { class: 'chat-entry chat-assistant', 'data-testid': 'chat-entry', 'data-kind': 'assistant' }, think, body, by)
    let text: string | null = null
    let thinking: string | null = null
    const patch = (n: ChatEntry) => {
      const a = n as EntryOf<'assistant'>
      if (a.text !== text) { text = a.text; renderMarkdown(body, a.text) }
      body.hidden = !a.text
      if ((a.thinking ?? '') !== thinking) { thinking = a.thinking ?? ''; setText(thinkBody, thinking) }
      think.hidden = !a.thinking
      const thinkingNow = a.streaming && !!a.thinking && !a.text
      think.classList.toggle('live', thinkingNow)
      setText(thinkLabel, thinkingNow ? 'Thinking…' : 'Thinking')
      el.classList.toggle('streaming', a.streaming)
      el.dataset.streaming = String(a.streaming)
      const other = a.model && !a.streaming && a.model !== this.hooks.configuredModel() ? a.model : ''
      by.hidden = !other
      setText(by, other ? `Answered by ${other}` : '')
    }
    patch(e)
    return { entry: e, el, patch }
  }

  private tool(e: ToolEntry): View {
    const [, iconName] = toolInfo(e.name) ?? ['', 'spark']
    const nameEl = h('span', { class: 'tool-name' })
    const sum = h('span', { class: 'tool-sum' })
    const statusEl = h('span', { class: 'tool-status', 'data-testid': 'chat-tool-status' })
    const head = h('button', { type: 'button', class: 'tool-head', 'aria-expanded': 'false' },
      h('span', { class: 'tool-icon' }, icon(iconName)), nameEl, sum)
    const selectBtn = h('button', { type: 'button', class: 'icon-btn tool-select', 'data-testid': 'chat-tool-select' }, icon('target'))
    const shots = h('div', { class: 'tool-shots' })
    const details = h('div', { class: 'tool-details' })
    details.hidden = true
    const el = h('div', { class: 'chat-entry chat-tool', 'data-testid': 'chat-tool', 'data-kind': 'tool' },
      h('div', { class: 'tool-row' }, head, selectBtn, statusEl), shots, details)
    let cur = e
    let images: ToolImage[] | undefined
    const section = (title: string, raw: string): HTMLElement[] => {
      const { json, code } = detailParts(raw)
      const out: HTMLElement[] = [h('div', { class: 'tool-sec' }, title), h('pre', { class: 'tool-pre' }, json || '(none)')]
      if (code !== null) out.push(h('div', { class: 'tool-sec' }, `${title} · code`), h('pre', { class: 'tool-pre tool-code' }, code))
      return out
    }
    const fillDetails = () => {
      details.replaceChildren(...section('Input', cur.inputJson), ...(cur.resultText !== undefined ? section('Result', cur.resultText) : []))
    }
    head.addEventListener('click', () => {
      details.hidden = !details.hidden
      head.setAttribute('aria-expanded', String(!details.hidden))
      el.classList.toggle('open', !details.hidden)
      if (!details.hidden) fillDetails()
    })
    // looked up again on click: the object may have been renamed or deleted since
    selectBtn.addEventListener('click', () => selectable(this.hooks.ctx, cur)?.run())
    let waiting = false
    let shownStatus = ''
    const renderStatus = () => {
      const key = `${cur.status}|${waiting}`
      if (key === shownStatus) return
      shownStatus = key
      el.dataset.waiting = String(waiting)
      statusEl.replaceChildren(
        waiting ? icon('warn') : cur.status === 'streaming' || cur.status === 'running' ? h('span', { class: 'spin', 'aria-hidden': 'true' })
          : cur.status === 'ok' ? icon('check') : cur.status === 'error' ? icon('close') : '',
        h('span', { class: cur.status === 'ok' || cur.status === 'error' ? 'sr-only' : 'tool-status-text' }, waiting ? 'waiting for you' : STATUS_TEXT[cur.status]))
    }
    const setWaiting = (w: boolean) => {
      waiting = w
      renderStatus()
    }
    const patch = (n: ChatEntry) => {
      cur = n as ToolEntry
      el.dataset.status = cur.status
      setText(nameEl, toolLabel(cur.name))
      let s = cur.summary ?? ''
      if (cur.status === 'streaming' && cur.inputJson.length > 400) s = `${s ? `${s} · ` : ''}${kb(cur.inputJson.length)}`
      setText(sum, s)
      sum.title = s
      if (cur.status !== 'running') waiting = false
      renderStatus()
      if (cur.images !== images) {
        images = cur.images
        shots.replaceChildren(...(images ?? []).map((img, i) => {
          const src = `data:${img.mediaType};base64,${img.base64}`
          const im = h('img', { class: 'tool-thumb', alt: `Screenshot ${i + 1}`, 'data-testid': 'chat-thumb' })
          im.src = src
          const btn = h('button', { type: 'button', class: 'tool-thumb-btn', title: 'Enlarge' }, im)
          btn.addEventListener('click', () => this.enlarge(src))
          return btn
        }))
        shots.hidden = !images?.length
      }
      const target = selectable(this.hooks.ctx, cur)
      selectBtn.hidden = !target
      if (target) {
        selectBtn.title = `Select ${target.label}`
        selectBtn.setAttribute('aria-label', `Select ${target.label}`)
      }
      if (!details.hidden) fillDetails()
    }
    patch(e)
    return { entry: e, el, patch, setWaiting }
  }

  private notice(e: EntryOf<'notice'>): View {
    const text = h('div', { class: 'notice-text' }, e.text)
    const actions = h('div', { class: 'notice-actions' })
    const el = h('div', { class: 'chat-entry chat-notice', 'data-testid': 'chat-notice', 'data-kind': 'notice', 'data-level': e.level, role: e.level === 'error' ? 'alert' : null },
      icon(e.level === 'error' ? 'error' : e.level === 'warn' ? 'warn' : 'info', 'icon notice-icon'), h('div', { class: 'notice-main' }, text, actions))
    let shown: string | undefined
    const setActions = (list: NoticeAction[]) => {
      const sig = list.join()
      if (sig === shown) return
      shown = sig
      actions.hidden = !list.length
      actions.replaceChildren(...list.map((a) => {
        const label = a === 'settings' ? 'Open settings' : a === 'retry' ? 'Retry' : a === 'new' ? 'New chat' : 'Continue'
        const btn = h('button', { type: 'button', class: 'btn btn-sm', 'data-testid': 'chat-notice-action', 'data-action': a },
          icon(a === 'settings' ? 'sliders' : a === 'retry' ? 'refresh' : a === 'new' ? 'plus' : 'play'), label)
        btn.addEventListener('click', () => (a === 'settings' ? this.hooks.openSettings() : a === 'new' ? this.hooks.newChat() : this.hooks.continueRun()))
        return btn
      }))
    }
    return {
      entry: e, el, setActions,
      patch: (n) => {
        const x = n as EntryOf<'notice'>
        setText(text, x.text)
        el.dataset.level = x.level
      },
    }
  }

  private confirm(e: EntryOf<'confirm'>): View {
    // a labelled group (the panel also announces it at once through its assertive status line, src/ui/chat.ts); focus
    // stays where it is, so keys meant for the code editor or the message box can never answer it by accident
    const ids = `chat-confirm-${++uid}`
    const title = h('div', { class: 'confirm-title', id: `${ids}-title` }, icon('warn'), h('span', null, e.title))
    const msg = h('p', { class: 'confirm-msg', id: `${ids}-msg` }, e.message)
    const approve = h('button', { type: 'button', class: 'btn btn-sm btn-danger', 'data-testid': 'chat-approve' }, 'Approve')
    const decline = h('button', { type: 'button', class: 'btn btn-sm', 'data-testid': 'chat-decline' }, 'Decline')
    const actions = h('div', { class: 'confirm-actions' }, decline, approve)
    const result = h('div', { class: 'confirm-result small', 'data-testid': 'chat-confirm-result' })
    const el = h('div', {
      class: 'chat-entry chat-confirm', 'data-testid': 'chat-confirm', 'data-kind': 'confirm',
      role: 'group', 'aria-labelledby': title.id, 'aria-describedby': msg.id,
    }, title, msg, actions, result)
    let id = e.id
    approve.addEventListener('click', () => this.hooks.approve(id))
    decline.addEventListener('click', () => this.hooks.decline(id))
    const patch = (n: ChatEntry) => {
      const c = n as EntryOf<'confirm'>
      id = c.id
      el.dataset.state = c.state
      setText(title.lastChild!, c.title)
      setText(msg, c.message)
      actions.hidden = c.state !== 'pending'
      result.hidden = c.state === 'pending'
      setText(result, c.state === 'approved' ? 'Approved' : c.state === 'declined' ? 'Declined' : '')
    }
    patch(e)
    return { entry: e, el, patch }
  }

  // ───────────────────────────── screenshots ─────────────────────────────

  private enlarge(src: string): void {
    this.dialog?.close()
    const img = h('img', { class: 'shot-full', alt: 'Screenshot', 'data-testid': 'chat-shot-full' })
    img.src = src
    const close = h('button', { type: 'submit', class: 'btn', 'data-testid': 'chat-shot-close' }, 'Close')
    const dlg = h('dialog', { class: 'dlg dlg-shot', 'data-testid': 'chat-shot-dialog', 'aria-label': 'Screenshot' },
      h('form', { method: 'dialog' }, img, h('div', { class: 'dlg-actions' }, close)))
    // a click on the backdrop closes it too
    dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close() })
    dlg.addEventListener('close', () => { dlg.remove(); if (this.dialog === dlg) this.dialog = null }, { once: true })
    document.body.append(dlg)
    this.dialog = dlg
    dlg.showModal()
    close.focus()
  }
}
