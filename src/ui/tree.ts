// §4.1 / §4.3 / §4.7 / §4.8 / §4.11 scene tree. Rows are keyed by data-path and patched in place (scroll is kept).
// Row: [▸] [kind] label (def name) … ◆N ● 👁   data-testid="tree-row" data-path data-def data-status.
import type { AppContext, DefStatus, DropTarget, MountPanel, Occurrence, RenameTarget, RenderState } from '../app/context'
import type { InstancePath } from '../core/types'
import { parsePathKey, pathKey } from '../core/graph'
import { h, inlineRename, setAttrIfChanged, setChildren, setText, type InlineRename } from './dom'
import { defIconName, icon } from './icons'
import { currentDrag, endDrag, startDrag } from './dnd'

const INDENT = 14
const STATUS_TEXT: Record<DefStatus, string> = { idle: 'Not evaluated', pending: 'Evaluating…', ok: 'Up to date', error: 'Error' }

interface Row { el: HTMLElement; sig: string; occ: Occurrence }
type Zone = 'before' | 'after' | 'into' | 'end'
interface DropAt { target: DropTarget; zone: Zone; row?: HTMLElement }

export const mount: MountPanel = (el: HTMLElement, ctx: AppContext) => {
  el.classList.add('panel', 'tree-panel')
  const projName = h('span', { class: 'panel-sub', 'data-testid': 'project-name' })
  const unhide = h('button', { type: 'button', class: 'mini-btn', 'data-testid': 'unhide-all', title: 'Show every hidden object (Alt+H)' },
    icon('eye'), h('span', null, 'Unhide all'))
  unhide.addEventListener('click', () => { ctx.commands.unhideAll(); unhide.blur() })
  const header = h('div', { class: 'panel-head' }, h('span', { class: 'panel-title' }, 'Scene'), projName, h('span', { class: 'spacer' }), unhide)
  const rowsHost = h('div', { class: 'tree-rows', role: 'tree', 'aria-label': 'Scene tree' })
  const empty = h('div', { class: 'tree-empty' }, 'The scene is empty. Add an object from the toolbar, or drag a definition in from the Library.')
  const tail = h('div', { class: 'tree-tail', title: 'Drop here to move to the top level' })
  const dropLine = h('div', { class: 'drop-line' })
  const body = h('div', { class: 'tree-body' }, rowsHost, empty, tail, dropLine)
  el.append(header, body)

  const rows = new Map<string, Row>()
  let lastSelKey: string | null | undefined
  let lastCtxKey: string | undefined
  let scrollToSel = false
  let renaming: { key: string; r: InlineRename } | null = null
  let pendingRename: { key: string; target: RenameTarget } | null = null

  // ───────────────────────────── rendering ─────────────────────────────

  const buildRow = (row: Row, o: Occurrence, rs: RenderState) => {
    const ui = rs.ui
    const hasKids = o.def.kind === 'group' && o.def.children.length > 0
    const expanded = !!ui.expanded[o.key]
    const label = o.instance.name ?? o.def.name
    const sub = o.instance.name !== undefined && o.instance.name !== o.def.name ? o.def.name : ''
    const count = rs.counts.get(o.def.id) ?? 0
    const hiddenSelf = !!o.instance.hidden
    const tw = hasKids
      ? h('span', { class: `tw${expanded ? ' open' : ''}`, 'data-testid': 'tree-toggle', title: expanded ? 'Collapse' : 'Expand' }, icon('chevron'))
      : h('span', { class: 'tw tw-none' })
    const kindTitle = o.def.kind === 'code' ? (o.def.lang === 'openscad' ? 'OpenSCAD object' : 'Code object') : o.def.op === 'none' ? 'Group' : `Boolean ${o.def.op}`
    setChildren(row.el,
      tw,
      h('span', { class: `kind kind-${o.role}`, title: kindTitle }, icon(defIconName(o.def))),
      h('span', { class: 'row-label', title: sub ? `${label} — instance of ${sub}` : label },
        h('span', { class: 'row-name' }, label), sub ? h('span', { class: 'row-sub' }, sub) : null),
      count > 1 ? h('span', { class: 'badge', title: `'${o.def.name}' occurs ${count} times — copies are linked` }, `◆${count}`) : null,
      h('span', { class: 'dot' }),
      h('button', { type: 'button', class: `eye${hiddenSelf ? ' off' : ''}`, 'data-testid': 'tree-eye', tabIndex: -1, title: hiddenSelf ? 'Show (H)' : 'Hide (H)' },
        icon(hiddenSelf ? 'eyeOff' : 'eye')),
    )
    row.el.style.setProperty('--depth', String(o.path.length - 1))
  }

  const rowSig = (o: Occurrence, rs: RenderState) => {
    const ex = o.def.kind === 'group' && o.def.children.length > 0 ? (rs.ui.expanded[o.key] ? 'v' : '>') : '-'
    return [o.path.length, o.instance.name ?? '', o.def.name, rs.counts.get(o.def.id) ?? 0, ex, o.instance.hidden ? 'H' : '',
      o.role, o.def.kind === 'group' ? o.def.op : o.def.lang ?? ''].join('|')
  }

  const render = (rs: RenderState) => {
    const ui = rs.ui
    setText(projName, rs.project.name)
    const anyHidden = Object.values(rs.project.defs).some((d) => d.kind === 'group' && d.children.some((c) => c.hidden))
    unhide.disabled = !anyHidden

    const selKey = ui.selection.kind === 'occ' ? pathKey(ui.selection.path) : null
    const ctxKey = pathKey(ui.context)
    if (selKey !== lastSelKey || ctxKey !== lastCtxKey) {
      lastSelKey = selKey
      lastCtxKey = ctxKey
      // make a new selection / context visible: expand its collapsed ancestors (and the entered context itself)
      const need = new Map<string, InstancePath>()
      const ancestors = (p: InstancePath) => {
        for (let i = 1; i < p.length; i++) { const a = p.slice(0, i); const k = pathKey(a); if (!ui.expanded[k]) need.set(k, a) }
      }
      if (ui.selection.kind === 'occ') ancestors(ui.selection.path)
      if (ui.context.length) { ancestors(ui.context); if (!ui.expanded[ctxKey]) need.set(ctxKey, ui.context) }
      if (need.size) queueMicrotask(() => { for (const p of need.values()) ctx.commands.toggleExpanded(p, true) })
      scrollToSel = selKey !== null
    }

    const selOcc = selKey !== null ? rs.byKey.get(selKey) : undefined
    const linkedDef = selOcc?.def.id ?? (ui.selection.kind === 'def' ? ui.selection.def : undefined)

    // visible rows: pre-order walk, children only under expanded groups
    const visible: Occurrence[] = []
    const open = new Set<string>([''])
    for (const o of rs.occurrences) {
      if (!open.has(o.parentKey)) continue
      visible.push(o)
      if (o.def.kind === 'group' && ui.expanded[o.key]) open.add(o.key)
    }

    let i = 0
    for (const o of visible) {
      let row = rows.get(o.key)
      if (!row) {
        row = { el: h('div', { class: 'tree-row', 'data-testid': 'tree-row', role: 'treeitem', draggable: true }), sig: '', occ: o }
        row.el.dataset.path = o.key
        rows.set(o.key, row)
      }
      row.occ = o
      const isRenaming = renaming?.key === o.key
      const sig = rowSig(o, rs)
      if (sig !== row.sig && !isRenaming) { buildRow(row, o, rs); row.sig = sig }
      const e = row.el
      setAttrIfChanged(e, 'data-def', o.def.id)
      const status = rs.rowStatus.get(o.key) ?? 'idle'
      setAttrIfChanged(e, 'data-status', status)
      e.classList.toggle('selected', o.key === selKey)
      e.classList.toggle('linked', linkedDef !== undefined && o.def.id === linkedDef && o.key !== selKey)
      e.classList.toggle('is-hidden', o.hidden)
      e.classList.toggle('is-context', ui.context.length > 0 && o.key === ctxKey)
      e.classList.toggle('op-cut', o.operandRole === 'cut')
      setAttrIfChanged(e, 'aria-selected', o.key === selKey ? 'true' : 'false')
      const dot = e.querySelector('.dot')
      if (dot) {
        const err = status === 'error' ? rs.defStates.get(o.def.id)?.error : undefined
        setAttrIfChanged(dot, 'title', err ? `Error: ${err.message}` : status === 'error' ? 'Something inside has an error' : STATUS_TEXT[status])
      }
      const at = rowsHost.children[i]
      if (at !== e) rowsHost.insertBefore(e, at ?? null)
      i++
    }
    const keep = new Set(visible.map((o) => o.key))
    for (const [k, r] of rows) {
      if (keep.has(k)) continue
      if (renaming?.key === k) renaming.r.cancel()
      r.el.remove()
      rows.delete(k)
    }
    empty.hidden = visible.length > 0

    if (scrollToSel && selKey !== null) {
      const r = rows.get(selKey)
      if (r) { scrollToSel = false; r.el.scrollIntoView({ block: 'nearest' }) }
    }
    if (pendingRename && rows.has(pendingRename.key)) {
      const p = pendingRename
      pendingRename = null
      openRename(p.key, p.target)
    }
  }

  // ───────────────────────────── inline rename (§4.7) ─────────────────────────────

  const openRename = (key: string, target: RenameTarget) => {
    const row = rows.get(key)
    if (!row) {
      // not visible yet: expand its ancestors and open on the next render
      pendingRename = { key, target }
      const p = parsePathKey(key)
      for (let i = 1; i < p.length; i++) ctx.commands.toggleExpanded(p.slice(0, i), true)
      return
    }
    renaming?.r.cancel()
    const label = row.el.querySelector<HTMLElement>('.row-label')
    if (!label) return
    row.el.classList.add('renaming')
    row.el.draggable = false
    const r = inlineRename(label, row.occ.instance.name ?? row.occ.def.name,
      (text) => ctx.commands.commitRename(target, text),
      () => {
        if (renaming?.r === r) renaming = null
        row.el.classList.remove('renaming')
        row.el.draggable = true
        row.sig = ''
      },
      (msg) => ctx.toast(msg, 'error'))
    renaming = { key, r }
  }

  ctx.on('rename', (t) => {
    if (t.kind !== 'occ') return
    openRename(pathKey(t.path), t)
  })

  // ───────────────────────────── mouse ─────────────────────────────

  rowsHost.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    const rowEl = t.closest<HTMLElement>('.tree-row')
    if (!rowEl || rowEl.classList.contains('renaming') && t.closest('.rename-wrap')) return
    const path = parsePathKey(rowEl.dataset.path ?? '')
    const eye = t.closest<HTMLElement>('.eye')
    if (eye) { ctx.commands.hideToggle(path); eye.blur(); return }
    if (t.closest('.tw') && !t.closest('.tw-none')) { ctx.commands.toggleExpanded(path); return }
    ctx.commands.selectFromTree(path)
  })

  rowsHost.addEventListener('dblclick', (e) => {
    const t = e.target as HTMLElement
    if (t.closest('.eye, .tw, .rename-wrap')) return
    const rowEl = t.closest<HTMLElement>('.tree-row')
    if (!rowEl) return
    const path = parsePathKey(rowEl.dataset.path ?? '')
    if (t.closest('.row-label')) ctx.commands.startRename({ kind: 'occ', path })
    else if (rows.get(rowEl.dataset.path ?? '')?.occ.def.kind === 'group') ctx.commands.toggleExpanded(path)
  })

  // ───────────────────────────── drag and drop (§4.8) ─────────────────────────────

  const clearIndicator = () => {
    dropLine.style.display = 'none'
    for (const x of rowsHost.querySelectorAll('.drop-into, .drop-into-bad')) x.classList.remove('drop-into', 'drop-into-bad')
  }

  const dropAt = (e: DragEvent): DropAt => {
    const rowEl = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('.tree-row')
    const row = rowEl ? rows.get(rowEl.dataset.path ?? '') : undefined
    if (!rowEl || !row) return { target: { parentPath: [], index: -1 }, zone: 'end' }
    const r = rowEl.getBoundingClientRect()
    const y = (e.clientY - r.top) / Math.max(1, r.height)
    const o = row.occ
    let zone: Zone
    if (y < 1 / 3) zone = 'before'
    else if (y > 2 / 3) zone = 'after'
    else zone = o.def.kind === 'group' ? 'into' : y < 0.5 ? 'before' : 'after'
    if (zone === 'into') return { target: { parentPath: o.path, index: -1 }, zone, row: rowEl }
    return { target: { parentPath: o.path.slice(0, -1), index: o.index + (zone === 'after' ? 1 : 0) }, zone, row: rowEl }
  }

  const showIndicator = (d: DropAt, valid: boolean) => {
    clearIndicator()
    if (d.zone === 'into' && d.row) { d.row.classList.add(valid ? 'drop-into' : 'drop-into-bad'); return }
    let top: number
    let depth: number
    if (d.zone === 'end' || !d.row) {
      const lastRow = rowsHost.lastElementChild as HTMLElement | null
      top = lastRow ? lastRow.offsetTop + lastRow.offsetHeight : rowsHost.offsetTop
      depth = 0
    } else {
      top = d.row.offsetTop + (d.zone === 'after' ? d.row.offsetHeight : 0)
      depth = d.target.parentPath.length
    }
    dropLine.style.top = `${top - 1}px`
    dropLine.style.left = `${8 + depth * INDENT + 16}px`
    dropLine.classList.toggle('bad', !valid)
    dropLine.style.display = 'block'
  }

  rowsHost.addEventListener('dragstart', (e) => {
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>('.tree-row')
    if (!rowEl || renaming) { e.preventDefault(); return }
    startDrag(e, { kind: 'occ', path: parsePathKey(rowEl.dataset.path ?? '') }, 'copyMove')
    rowEl.classList.add('dragging')
  })
  rowsHost.addEventListener('dragend', () => {
    endDrag()
    clearIndicator()
    for (const x of rowsHost.querySelectorAll('.dragging')) x.classList.remove('dragging')
  })
  body.addEventListener('dragover', (e) => {
    const payload = currentDrag(e)
    if (!payload) return // a file: the window handler takes it
    e.preventDefault()
    const d = dropAt(e)
    const valid = ctx.commands.canDrop(payload, d.target)
    if (e.dataTransfer) e.dataTransfer.dropEffect = !valid ? 'none' : payload.kind === 'def' || e.ctrlKey || e.metaKey ? 'copy' : 'move'
    showIndicator(d, valid)
  })
  body.addEventListener('dragleave', (e) => {
    if (!body.contains(e.relatedTarget as Node | null)) clearIndicator()
  })
  body.addEventListener('drop', (e) => {
    const payload = currentDrag(e)
    if (!payload) return
    e.preventDefault()
    const d = dropAt(e)
    clearIndicator()
    endDrag()
    if (!ctx.commands.canDrop(payload, d.target)) return
    ctx.commands.drop(payload, d.target, { copy: payload.kind === 'occ' && (e.ctrlKey || e.metaKey) })
  })

  ctx.on('render', render)
  render(ctx.controller.current())
}
