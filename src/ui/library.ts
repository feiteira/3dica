// §4.1 / §4.3 / §4.6 / §4.7 Library: every def except the root, with its occurrence count ("Bolt ×8"), status dot,
// "unused" for defs without uses. Click selects (and isolates), double-click / F2 renames, drag drops into the tree.
import type { AppContext, MountPanel, RenderState } from '../app/context'
import type { Definition, Id } from '../core/types'
import { referrers } from '../core/graph'
import { h, inlineRename, setAttrIfChanged, setText, type InlineRename } from './dom'
import { defIconName, icon } from './icons'
import { endDrag, startDrag } from './dnd'

interface Row { el: HTMLElement; sig: string; def: Definition }

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

export const mount: MountPanel = (el: HTMLElement, ctx: AppContext) => {
  el.classList.add('panel', 'lib-panel')
  const countEl = h('span', { class: 'panel-sub' })
  const purge = h('button', { type: 'button', class: 'mini-btn', 'data-testid': 'purge', title: 'Remove definitions that have no instances and no part() references' },
    icon('broom'), h('span', null, 'Purge'))
  purge.addEventListener('click', () => { ctx.commands.purgeUnused(); purge.blur() })
  const header = h('div', { class: 'panel-head' }, h('span', { class: 'panel-title' }, 'Library'), countEl, h('span', { class: 'spacer' }), purge)
  const list = h('div', { class: 'lib-rows', role: 'listbox', 'aria-label': 'Definitions' })
  const empty = h('div', { class: 'tree-empty' }, 'No definitions yet.')
  const body = h('div', { class: 'lib-body' }, list, empty)
  el.append(header, body)

  const rows = new Map<Id, Row>()
  let renaming: { def: Id; r: InlineRename } | null = null

  const render = (rs: RenderState) => {
    const project = rs.project
    const defs = Object.values(project.defs).filter((d) => d.id !== project.root).sort((a, b) => collator.compare(a.name, b.name))
    setText(countEl, String(defs.length))
    const ui = rs.ui
    const selDef = ui.selection.kind === 'def' ? ui.selection.def : undefined
    const occDef = ui.selection.kind === 'occ' ? rs.byKey.get(ui.selection.path.join('/'))?.def.id : undefined
    let unusedCount = 0
    let i = 0
    for (const d of defs) {
      const n = rs.counts.get(d.id) ?? 0
      const refs = n === 0 ? referrers(project, d.id).length : 0
      const unused = n === 0 && refs === 0
      if (unused) unusedCount++
      let row = rows.get(d.id)
      if (!row) {
        row = { el: h('div', { class: 'lib-row', 'data-testid': 'lib-row', role: 'option', draggable: true }), sig: '', def: d }
        row.el.dataset.def = d.id
        rows.set(d.id, row)
      }
      row.def = d
      const sig = [d.name, d.kind, d.kind === 'group' ? d.op : '', n, refs].join('|')
      if (sig !== row.sig && renaming?.def !== d.id) {
        row.sig = sig
        const countTitle = n === 0 ? (refs ? `No instances — used by code in ${refs} ${refs === 1 ? 'definition' : 'definitions'}` : 'Not used anywhere')
          : `${n} ${n === 1 ? 'occurrence' : 'occurrences'} in the scene`
        row.el.replaceChildren(
          h('span', { class: `kind kind-${d.kind === 'code' ? 'code' : d.op === 'none' ? 'group' : 'bool'}` }, icon(defIconName(d))),
          h('span', { class: 'lib-name', title: d.name }, d.name),
          n > 0 ? h('span', { class: 'lib-count', title: countTitle }, `×${n}`)
            : h('span', { class: 'lib-unused', title: countTitle }, refs ? 'part()' : 'unused'),
          h('span', { class: 'dot' }),
        )
      }
      const st = rs.defStates.get(d.id)
      setAttrIfChanged(row.el, 'data-status', st?.status ?? 'idle')
      const dot = row.el.querySelector('.dot')
      if (dot) setAttrIfChanged(dot, 'title', st?.status === 'error' && st.error ? `Error: ${st.error.message}` : st?.status === 'pending' ? 'Evaluating…' : st?.status === 'ok' ? 'Up to date' : 'Not evaluated')
      row.el.classList.toggle('selected', d.id === selDef)
      row.el.classList.toggle('current', d.id === occDef)
      row.el.classList.toggle('unused', unused)
      setAttrIfChanged(row.el, 'aria-selected', d.id === selDef ? 'true' : 'false')
      const at = list.children[i]
      if (at !== row.el) list.insertBefore(row.el, at ?? null)
      i++
    }
    const keep = new Set(defs.map((d) => d.id))
    for (const [id, r] of rows) {
      if (keep.has(id)) continue
      if (renaming?.def === id) renaming.r.cancel()
      r.el.remove()
      rows.delete(id)
    }
    empty.hidden = defs.length > 0
    purge.disabled = unusedCount === 0
    if (selDef) {
      const r = rows.get(selDef)
      if (r && r.el.dataset.scrolled !== '1') { r.el.scrollIntoView({ block: 'nearest' }); r.el.dataset.scrolled = '1' }
    }
    for (const r of rows.values()) if (r.def.id !== selDef) delete r.el.dataset.scrolled
  }

  const openRename = (defId: Id) => {
    const row = rows.get(defId)
    if (!row) return
    renaming?.r.cancel()
    const name = row.el.querySelector<HTMLElement>('.lib-name')
    if (!name) return
    row.el.classList.add('renaming')
    row.el.draggable = false
    const r = inlineRename(name, row.def.name,
      (text) => ctx.commands.commitRename({ kind: 'def', def: defId }, text),
      () => {
        if (renaming?.r === r) renaming = null
        row.el.classList.remove('renaming')
        row.el.draggable = true
        row.sig = ''
      },
      (msg) => ctx.toast(msg, 'error'))
    renaming = { def: defId, r }
  }

  ctx.on('rename', (t) => { if (t.kind === 'def') openRename(t.def) })

  list.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t.closest('.rename-wrap')) return
    const rowEl = t.closest<HTMLElement>('.lib-row')
    if (rowEl?.dataset.def) ctx.commands.selectDef(rowEl.dataset.def)
  })
  list.addEventListener('dblclick', (e) => {
    const t = e.target as HTMLElement
    if (t.closest('.rename-wrap')) return
    const rowEl = t.closest<HTMLElement>('.lib-row')
    if (rowEl?.dataset.def) ctx.commands.startRename({ kind: 'def', def: rowEl.dataset.def })
  })
  list.addEventListener('dragstart', (e) => {
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>('.lib-row')
    if (!rowEl?.dataset.def || renaming) { e.preventDefault(); return }
    startDrag(e, { kind: 'def', def: rowEl.dataset.def }, 'copy')
    rowEl.classList.add('dragging')
  })
  list.addEventListener('dragend', () => {
    endDrag()
    for (const x of list.querySelectorAll('.dragging')) x.classList.remove('dragging')
  })

  ctx.on('render', render)
  render(ctx.controller.current())
}
