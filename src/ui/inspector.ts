// §4.10 inspector: Occurrence section (label, def, ◆N, Make unique, transform xf-t0…xf-s2, color, hidden, parameter
// overrides ● ↺, stale overrides), shared-definition banner, Definition section (name, color, op selector | parameter
// table) and the CodeMirror editor with its status line. The form is REBUILT when the selection (or the def's
// parameter structure) changes and PATCHED otherwise, so a focused input keeps focus.
import type { AppContext, EvalError, MountPanel, RenderState } from '../app/context'
import type { Definition, GroupOp, Id, Instance, InstancePath, Transform } from '../core/types'
import { instanceAtPath, instancesOf, ISOLATE_INSTANCE_ID, pathKey, referrers, resolvePath } from '../core/graph'
import { staleOverrideKeys } from '../core/params'
import { errorForDef } from '../core/evalspec'
import { DEFAULT_COLOR } from '../core/colors'
import { cloneXf } from '../core/transform'
import { fmtInt, fmtNum, h, plural, setAttrIfChanged, setChildren, setText } from './dom'
import { defIconName, icon } from './icons'
import { onCommit, overrideControls, paramTable, type Bind } from './param-editor'
import { CodeEditor, type CodeStatus } from './code-editor'

type View =
  | { kind: 'none' }
  | { kind: 'occ'; path: InstancePath; key: string; inst: Instance; def: Definition }
  | { kind: 'def'; def: Definition }

function describe(rs: RenderState): View {
  const s = rs.ui.selection
  if (s.kind === 'occ') {
    const steps = resolvePath(rs.project, s.path)
    if (steps && steps.length) {
      const last = steps[steps.length - 1]
      return { kind: 'occ', path: s.path, key: pathKey(s.path), inst: last.instance, def: last.def }
    }
  } else if (s.kind === 'def') {
    const def = rs.project.defs[s.def]
    if (def && def.id !== rs.project.root) return { kind: 'def', def }
  }
  return { kind: 'none' }
}

/** Things whose change needs a rebuild (everything else is patched in place). */
function signature(v: View): string {
  if (v.kind === 'none') return 'none'
  const d = v.def
  const struct = d.kind === 'code' ? JSON.stringify(d.params) : 'group'
  if (v.kind === 'def') return JSON.stringify(['def', d.id, d.kind, struct])
  return JSON.stringify(['occ', v.key, v.inst.id, d.id, d.kind, struct, staleOverrideKeys(d, v.inst.params)])
}

function errText(e: EvalError, defId: Id): string {
  const where = e.line ? ` (line ${e.line}${e.col ? `:${e.col}` : ''})` : ''
  if (e.def !== defId) return `✕ depends on "${e.defName}" (failed): ${e.message}${where}`
  return `✕ ${e.message}${where}`
}

/** The status line for the selection (§4.10): "✓ 18 ms · 4,382 triangles", the error, or what is going on. */
function statusFor(ctx: AppContext, rs: RenderState, v: View): CodeStatus {
  if (v.kind === 'none') return { kind: 'idle', text: '' }
  if (rs.ui.evalPaused) return { kind: 'paused', text: 'Code is paused — click Run code to evaluate this project' }
  const def = v.def
  let key: string | undefined
  if (v.kind === 'occ') key = rs.wanted.resultKeyOf.get(v.key)
  else if (rs.isolate?.defId === def.id) key = rs.wanted.resultKeyOf.get(ISOLATE_INSTANCE_ID)
  if (!key) {
    const ks = rs.wanted.jobsOfDef.get(def.id)
    if (ks && ks.size) key = ks.values().next().value
  }
  const st = rs.defStates.get(def.id)
  const r = key ? ctx.client.get(key) : undefined
  // a key shared with an identical def carries that def's id: its own-code failure is this def's own failure too
  if (r?.state === 'failed') return { kind: 'error', text: errText(r.error.trace.length <= 1 ? errorForDef(r.error, def.id, def.name) : r.error, def.id) }
  if (st?.status === 'error' && st.error && r?.state !== 'ready') return { kind: 'error', text: errText(st.error, def.id) }
  if (r?.state === 'ready') {
    const e = r.entry
    let text = `✓ ${Math.round(e.ms)} ms · ${fmtInt(e.tris)} triangles`
    if (e.warnings.length) text += ` · ⚠ ${e.warnings.join('; ')}`
    return { kind: e.warnings.length ? 'warn' : 'ok', text }
  }
  if (key) return { kind: 'pending', text: 'Evaluating…' }
  if (v.kind === 'occ' && rs.byKey.get(v.key)?.hidden) return { kind: 'idle', text: 'Hidden — not evaluated' }
  if (def.kind === 'group' && def.op === 'none') return { kind: 'idle', text: 'Assembly — its children are evaluated one by one' }
  if (v.kind === 'occ' && rs.byKey.get(v.key)?.operandOf) return { kind: 'idle', text: 'Operand of a boolean — shown when the boolean is selected' }
  return { kind: 'idle', text: 'Not evaluated in this view' }
}

const XF_ROWS: { k: 't' | 'r' | 's'; label: string; unit: string; step: number }[] = [
  { k: 't', label: 'Position', unit: 'mm', step: 1 },
  { k: 'r', label: 'Rotation', unit: '°', step: 15 },
  { k: 's', label: 'Scale', unit: '×', step: 0.1 },
]
const AXES = ['X', 'Y', 'Z']
const OPS: { op: GroupOp; label: string }[] = [
  { op: 'none', label: 'none — plain assembly' },
  { op: 'union', label: 'union (∪)' },
  { op: 'subtract', label: 'subtract (−) — child 0 minus the rest' },
  { op: 'intersect', label: 'intersect (∩)' },
]

const SHORTCUTS: [string, string][] = [
  ['Click / Ctrl+click', 'select / deepest part'], ['Double-click, Enter', 'enter a group'], ['Esc', 'exit · deselect'],
  ['Ctrl+D', 'linked copy'], ['Ctrl+Shift+D', 'unique copy'], ['Ctrl+C / V', 'copy / paste'],
  ['W E R', 'move · rotate · scale'], ['Q / X', 'world-local / snap'], ['I', 'isolate'], ['F / Home', 'frame'],
  ['H / Alt+H', 'hide / unhide all'], ['F2', 'rename'], ['Ctrl+G', 'wrap in group'], ['Del', 'delete'],
]

const focused = (el: Element) => document.activeElement === el
const isFocusIn = (root: Element) => !!document.activeElement && root.contains(document.activeElement)

export const mount: MountPanel = (el: HTMLElement, ctx: AppContext) => {
  el.classList.add('panel', 'inspector')
  const form = h('div', { class: 'insp-form' })
  const codeRoot = h('div', { class: 'insp-code' })
  el.append(form, codeRoot)
  const editor = new CodeEditor(codeRoot, ctx)

  let sig = ''
  let binds: Bind[] = []
  let cur: View = { kind: 'none' }
  let pendingFocus: string | null = null
  const focusLater = (k: string) => { pendingFocus = k }
  const ptableOpen = { occ: false, def: true }

  const instNow = (path: InstancePath) => instanceAtPath(ctx.store.project, path)

  // ───────────────────────────── builders ─────────────────────────────

  const header = (v: Exclude<View, { kind: 'none' }>): HTMLElement => {
    const def = v.def
    const kindLabel = def.kind === 'code' ? 'Code object' : def.op === 'none' ? 'Group' : `Boolean ${def.op}`
    const title = h('h2', { class: 'insp-title', 'data-testid': 'inspector-title' })
    const sub = h('div', { class: 'insp-sub' })
    binds.push((rs) => {
      const vv = cur
      if (vv.kind === 'none') return
      setText(title, vv.kind === 'occ' ? vv.inst.name ?? vv.def.name : vv.def.name)
      const n = rs.counts.get(vv.def.id) ?? 0
      const badge = n > 1 ? h('span', { class: 'badge', title: `${n} linked copies in the scene` }, `◆${n}`) : null
      const subSig = `${vv.kind}|${vv.def.name}|${n}|${vv.kind === 'occ' ? vv.inst.name ?? '' : ''}`
      if (sub.dataset.sig !== subSig) {
        sub.dataset.sig = subSig
        if (vv.kind === 'occ') {
          const link = h('button', { type: 'button', class: 'link', 'data-testid': 'inspector-def-link', title: 'Show the definition on its own (Library)' }, vv.def.name)
          const defId = vv.def.id
          link.addEventListener('click', () => ctx.commands.selectDef(defId))
          setChildren(sub, h('span', { class: 'muted' }, 'instance of'), link, badge)
        } else {
          setChildren(sub, h('span', { class: 'muted' }, n === 0 ? 'definition · not used in the scene' : `definition · ${plural(n, 'occurrence')} in the scene`), badge)
        }
      }
    })
    return h('div', { class: 'insp-head' },
      h('div', { class: 'insp-kind' }, icon(defIconName(def)), h('span', null, kindLabel + (v.kind === 'def' ? ' · definition' : ''))),
      title, sub)
  }

  const occSection = (v: Extract<View, { kind: 'occ' }>): HTMLElement => {
    const path = v.path
    const def = v.def
    // label
    const labelIn = h('input', { type: 'text', class: 'txt', 'data-testid': 'inst-label', 'data-k': 'inst-label', spellcheck: false, placeholder: def.name, 'aria-label': 'Instance label' })
    onCommit(labelIn, () => {
      const inst = instNow(path)
      const next = labelIn.value.trim()
      if (inst && next !== (inst.name ?? '')) ctx.commands.setLabel(path, next || undefined)
    })
    // make unique + hidden
    const mu = h('button', { type: 'button', class: 'btn btn-sm', 'data-testid': 'make-unique' }, icon('unlink'), 'Make unique')
    mu.addEventListener('click', () => { ctx.commands.makeUnique(path); mu.blur() })
    const muWrap = h('span', { class: 'tip-wrap' }, mu)
    const hiddenCb = h('input', { type: 'checkbox', 'data-testid': 'inst-hidden', 'data-k': 'inst-hidden' })
    hiddenCb.addEventListener('change', () => {
      const inst = instNow(path)
      if (inst && !!inst.hidden !== hiddenCb.checked) ctx.commands.hideToggle(path)
    })
    binds.push((rs) => {
      const inst = instanceAtPath(rs.project, path)
      if (!inst) return
      const d = rs.project.defs[inst.def]
      if (!focused(labelIn)) labelIn.value = inst.name ?? ''
      labelIn.placeholder = d?.name ?? ''
      const records = d ? instancesOf(rs.project, d.id).length : 0
      mu.disabled = records < 2
      const tip = records < 2
        ? `Only instance of '${d?.name}'. To diverge a copy of a linked group's child, Make Unique the group first.`
        : `Give this instance its own copy of '${d?.name}' (U)`
      setAttrIfChanged(mu, 'title', tip)
      setAttrIfChanged(muWrap, 'title', tip)
      hiddenCb.checked = !!inst.hidden
    })

    // transform
    const grid = h('div', { class: 'xf-grid' })
    for (const row of XF_ROWS) {
      grid.appendChild(h('span', { class: 'xf-lbl' }, row.label, h('span', { class: 'xf-unit' }, row.unit)))
      for (let i = 0; i < 3; i++) {
        const field = `${row.k}${i}`
        const input = h('input', { type: 'number', class: 'num', step: row.step, 'data-testid': `xf-${field}`, 'data-k': `xf-${field}`, 'aria-label': `${row.label} ${AXES[i]}` })
        const show = () => { const inst = instNow(path); if (inst) input.value = fmtNum(inst.xf[row.k][i]) }
        onCommit(input, () => {
          const inst = instNow(path)
          if (!inst) return
          const raw = input.value.trim()
          const val = Number(raw)
          if (raw === '' || !Number.isFinite(val)) { show(); return }
          if (row.k === 's' && val === 0) { ctx.toast("Scale can't be 0", 'error'); show(); return }
          if (inst.xf[row.k][i] === val) return
          const xf: Transform = cloneXf(inst.xf)
          xf[row.k][i] = val
          ctx.commands.setTransform(path, xf, field)
          show()
        })
        grid.appendChild(h('span', { class: `xf-cell axis-${AXES[i].toLowerCase()}` }, h('span', { class: 'xf-axis' }, AXES[i]), input))
        binds.push((rs) => {
          const inst = instanceAtPath(rs.project, path)
          if (inst && !focused(input)) input.value = fmtNum(inst.xf[row.k][i])
        })
      }
    }
    const reset = h('button', { type: 'button', class: 'mini-btn', 'data-testid': 'xf-reset', title: 'Reset to position 0, rotation 0, scale 1' }, icon('reset'), 'Reset')
    reset.addEventListener('click', () => { ctx.commands.resetTransform(path); reset.blur() })

    // color
    const color = h('input', { type: 'color', 'data-testid': 'inst-color', 'data-k': 'inst-color', 'aria-label': 'Instance color' })
    color.addEventListener('input', () => ctx.commands.setColor({ path }, color.value))
    const clear = h('button', { type: 'button', class: 'mini-btn', 'data-testid': 'inst-color-clear', title: 'Use the definition color' }, 'clear')
    clear.addEventListener('click', () => { ctx.commands.setColor({ path }, undefined); clear.blur() })
    const colorNote = h('span', { class: 'muted small' })
    binds.push((rs) => {
      const inst = instanceAtPath(rs.project, path)
      if (!inst) return
      const d = rs.project.defs[inst.def]
      const own = inst.color
      if (!focused(color)) color.value = own ?? d?.color ?? DEFAULT_COLOR
      color.classList.toggle('unset', !own)
      clear.disabled = !own
      setText(colorNote, own ? 'own color' : d?.color ? 'from definition' : 'default')
    })

    const parts: (HTMLElement | null)[] = [
      h('div', { class: 'sec-title' }, h('span', null, 'Instance')),
      h('div', { class: 'field' }, h('label', null, 'Label'), labelIn),
      h('div', { class: 'field-row' }, muWrap, h('label', { class: 'check' }, hiddenCb, h('span', null, 'Hidden'))),
      h('div', { class: 'sec-title' }, h('span', null, 'Transform'), h('span', { class: 'spacer' }), reset),
      grid,
      h('div', { class: 'field' }, h('label', null, 'Color'), h('div', { class: 'color-row' }, color, clear, colorNote)),
    ]
    if (def.kind === 'code') {
      parts.push(h('div', { class: 'sec-title' }, h('span', null, 'Parameters'), h('span', { class: 'muted small' }, 'this instance')))
      parts.push(overrideControls(ctx, path, def, binds))
    }
    return h('section', { class: 'insp-sec occ-sec' }, ...parts)
  }

  const banner = (v: Exclude<View, { kind: 'none' }>): HTMLElement => {
    const text = h('span', { class: 'banner-text' })
    let btn: HTMLButtonElement | null = null
    if (v.kind === 'occ') {
      const path = v.path
      btn = h('button', { type: 'button', class: 'btn btn-sm', 'data-testid': 'banner-make-unique' }, 'Make unique')
      btn.addEventListener('click', () => { ctx.commands.makeUnique(path); btn?.blur() })
    }
    const b = h('div', { class: 'banner', 'data-testid': 'shared-banner', role: 'note' }, icon('info'), text, btn)
    binds.push((rs) => {
      const vv = cur
      if (vv.kind === 'none') return
      const n = rs.counts.get(vv.def.id) ?? 0
      b.hidden = n <= 1
      setText(text, `Definition shared by ${n} copies — edits affect all`)
      if (btn && vv.kind === 'occ') {
        const records = instancesOf(rs.project, vv.def.id).length
        btn.disabled = records < 2
        setAttrIfChanged(btn, 'title', records < 2
          ? `Only instance of '${vv.def.name}'. To diverge a copy of a linked group's child, Make Unique the group first.`
          : `Give this instance its own copy of '${vv.def.name}'`)
      }
    })
    return b
  }

  const defSection = (v: Exclude<View, { kind: 'none' }>): HTMLElement => {
    const def = v.def
    const defId = def.id
    // name
    const nameIn = h('input', { type: 'text', class: 'txt', 'data-testid': 'def-name', 'data-k': 'def-name', spellcheck: false, 'aria-label': 'Definition name' })
    const nameErr = h('div', { class: 'field-error', 'data-testid': 'def-name-error', role: 'alert' })
    let nameBad = false
    onCommit(nameIn, () => {
      const err = ctx.commands.renameDef(defId, nameIn.value)
      nameBad = !!err
      nameErr.textContent = err ?? ''
      nameErr.classList.toggle('show', nameBad)
      nameIn.classList.toggle('invalid', nameBad)
      return !nameBad
    })
    nameIn.addEventListener('input', () => { nameIn.classList.remove('invalid') })
    // color
    const color = h('input', { type: 'color', 'data-testid': 'def-color', 'data-k': 'def-color', 'aria-label': 'Definition color' })
    color.addEventListener('input', () => ctx.commands.setColor({ def: defId }, color.value))
    const clear = h('button', { type: 'button', class: 'mini-btn', 'data-testid': 'def-color-clear', title: 'No definition color' }, 'clear')
    clear.addEventListener('click', () => { ctx.commands.setColor({ def: defId }, undefined); clear.blur() })
    const usage = h('div', { class: 'usage muted small', 'data-testid': 'def-usage' })

    binds.push((rs) => {
      const d = rs.project.defs[defId]
      if (!d) return
      if (!focused(nameIn) && !nameBad) nameIn.value = d.name
      if (!focused(color)) color.value = d.color ?? DEFAULT_COLOR
      color.classList.toggle('unset', !d.color)
      clear.disabled = !d.color
      const records = instancesOf(rs.project, defId).length
      const n = rs.counts.get(defId) ?? 0
      const refs = referrers(rs.project, defId).map((r) => `'${rs.project.defs[r].name}'`)
      const bits = [plural(records, 'instance record'), `${n} in the scene`]
      if (refs.length) bits.push(`used by code in ${refs.join(', ')}`)
      setText(usage, bits.join(' · '))
    })

    const parts: (HTMLElement | null)[] = [
      h('div', { class: 'sec-title' }, h('span', null, 'Definition'), h('span', { class: 'muted small' }, def.kind === 'code' ? 'code' : 'group')),
      h('div', { class: 'field' }, h('label', null, 'Name'), h('div', { class: 'grow' }, nameIn, nameErr)),
      h('div', { class: 'field' }, h('label', null, 'Color'), h('div', { class: 'color-row' }, color, clear)),
    ]
    if (def.kind === 'group') {
      const opSel = h('select', { 'data-testid': 'def-op', 'data-k': 'def-op', 'aria-label': 'Group operation' }, OPS.map((o) => h('option', { value: o.op }, o.label)))
      opSel.addEventListener('change', () => ctx.commands.setGroupOp(defId, opSel.value as GroupOp))
      const kids = h('div', { class: 'muted small' })
      const st = h('div', { class: 'code-status inline', 'data-testid': 'group-status' })
      binds.push((rs) => {
        const d = rs.project.defs[defId]
        if (!d || d.kind !== 'group') return
        if (!focused(opSel)) opSel.value = d.op
        const hidden = d.children.filter((c) => c.hidden).length
        setText(kids, `${plural(d.children.length, 'child', 'children')}${hidden ? ` · ${hidden} hidden` : ''}${d.op === 'subtract' && d.children.length ? ' · the first visible child is the base, the others cut' : ''}`)
        const s = statusFor(ctx, rs, cur)
        setText(st, s.text)
        st.dataset.kind = s.kind
        st.hidden = !s.text
      })
      parts.push(h('div', { class: 'field' }, h('label', null, 'Operation'), opSel), h('div', { class: 'field' }, h('label', null, ''), kids), st)
    } else {
      const which = v.kind === 'def' ? 'def' : 'occ'
      const details = h('details', { class: 'pt-details', open: ptableOpen[which] },
        h('summary', null, h('span', null, 'Parameter defaults'), h('span', { class: 'muted small' }, ` ${plural(def.params.length, 'parameter')}`)),
        paramTable(ctx, def, focusLater))
      details.addEventListener('toggle', () => { ptableOpen[which] = details.open })
      parts.push(details)
    }
    parts.push(usage)
    if (v.kind === 'def') {
      const del = h('button', { type: 'button', class: 'btn btn-sm btn-danger-ghost', 'data-testid': 'def-delete', title: 'Delete this definition and all its instances (Del)' }, icon('trash'), 'Delete definition…')
      del.addEventListener('click', () => { void ctx.commands.deleteDefinition(defId); del.blur() })
      parts.push(h('div', { class: 'field-row end' }, del))
    }
    return h('section', { class: 'insp-sec def-sec' }, ...parts)
  }

  const nothing = (): HTMLElement[] => {
    // built once while nothing is selected, so the project name and counts are patched on every render (New, Open,
    // Sample, Purge… change them without changing the selection)
    const name = h('span', { 'data-testid': 'inspector-project' })
    const counts = h('div', { class: 'insp-sub muted', 'data-testid': 'inspector-counts' })
    binds.push((rs) => {
      setText(name, rs.project.name)
      const defs = Object.keys(rs.project.defs).length - 1
      setText(counts, `${plural(defs, 'definition')} · ${plural(rs.occurrences.length, 'object')} in the scene`)
    })
    return [
      h('div', { class: 'insp-head' },
        h('div', { class: 'insp-kind' }, name),
        h('h2', { class: 'insp-title', 'data-testid': 'inspector-title' }, 'Nothing selected'),
        counts),
      h('section', { class: 'insp-sec' },
        h('p', { class: 'muted' }, 'Click an object in the view or the Scene tree to edit it. Click a Library row to see a definition on its own.'),
        h('div', { class: 'cheats' }, SHORTCUTS.map(([k, d]) => [h('kbd', null, k), h('span', null, d)]))),
    ]
  }

  const build = (v: View): HTMLElement[] => {
    if (v.kind === 'none') return nothing()
    const out: HTMLElement[] = [header(v)]
    if (v.kind === 'occ') out.push(occSection(v))
    out.push(banner(v), defSection(v))
    return out
  }

  // ───────────────────────────── render ─────────────────────────────

  let lastSelKey = ''
  const render = (rs: RenderState) => {
    const v = describe(rs)
    cur = v
    const s = signature(v)
    if (s !== sig) {
      const selKey = v.kind === 'occ' ? `o:${v.key}` : v.kind === 'def' ? `d:${v.def.id}` : 'none'
      const active = document.activeElement as HTMLElement | null
      const k = active && isFocusIn(form) ? active.dataset.k : undefined
      let range: [number | null, number | null] | null = null
      if (active instanceof HTMLInputElement && active.type === 'text') range = [active.selectionStart, active.selectionEnd]
      const scroll = form.scrollTop
      binds = []
      form.replaceChildren(...build(v))
      form.scrollTop = selKey === lastSelKey ? scroll : 0
      lastSelKey = selKey
      sig = s
      const want = pendingFocus ?? k
      pendingFocus = null
      if (want) {
        const target = form.querySelector<HTMLElement>(`[data-k="${CSS.escape(want)}"]`)
        if (target) {
          target.focus()
          if (range && target instanceof HTMLInputElement && target.type === 'text') {
            try { target.setSelectionRange(range[0], range[1]) } catch { /* ignore */ }
          }
        }
      }
    }
    for (const b of binds) b(rs)
    const codeDef = v.kind !== 'none' && v.def.kind === 'code' ? v.def.id : null
    el.classList.toggle('no-code', !codeDef)
    editor.update(rs, codeDef, codeDef ? statusFor(ctx, rs, v) : null)
  }

  ctx.on('render', render)
  render(ctx.controller.current())
}
