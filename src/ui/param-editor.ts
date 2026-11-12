// §4.10 parameter UI:
// - overrideControls: one control per ParamDef of an occurrence's code def (number input + slider when min & max are
//   set, checkbox, select), showing the effective value; editing sets the override (● marks it, ↺ removes it);
//   stale override keys are listed as "stale override 'len' ✕".
// - paramTable: the definition's ParamDef table (name, type, default, min, max, step, options, ✕, "+ Add parameter").
//   Invalid edits show inline and are not committed.
import type { AppContext, RenderState } from '../app/context'
import type { CodeDef, InstancePath, ParamDef, ParamValue } from '../core/types'
import { instanceAtPath } from '../core/graph'
import { resolveParamDefs, staleOverrideKeys } from '../core/params'
import { fmtNum, h } from './dom'
import { icon } from './icons'

export type Bind = (rs: RenderState) => void

const isFocused = (el: Element | null) => !!el && document.activeElement === el
const hasOwn = (o: object | undefined, k: string) => !!o && Object.prototype.hasOwnProperty.call(o, k)

/**
 * Commit a field on 'change' and on Enter (once per distinct value); Esc restores the value shown before editing.
 * Enter also gives the focus back (blur) unless `commit` returns false (a refused value stays open for fixing): with
 * the focus left in the field, Ctrl+Z would be the browser's text undo of the field — showing a value the project
 * does not have — instead of the app's undo of the edit just committed (§4.13 ignores shortcuts in inputs).
 */
export function onCommit(input: HTMLInputElement | HTMLSelectElement, commit: () => void | boolean): void {
  let before = ''
  input.addEventListener('focus', () => { before = input.value })
  input.addEventListener('change', () => { commit() })
  input.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent
    if (ke.key === 'Enter' && input instanceof HTMLInputElement) {
      ke.preventDefault()
      if (commit() !== false) input.blur()
    } else if (ke.key === 'Escape' && input instanceof HTMLInputElement) input.value = before
  })
}

// ───────────────────────────── overrides (occurrence) ─────────────────────────────

export function overrideControls(ctx: AppContext, path: InstancePath, def: CodeDef, binds: Bind[]): HTMLElement {
  const list = h('div', { class: 'prm-list' })
  const inst0 = instanceAtPath(ctx.store.project, path)

  for (const pd of def.params) {
    const name = pd.name
    const current = (): { has: boolean; eff: ParamValue; pd: ParamDef } | null => {
      const project = ctx.store.project
      const inst = instanceAtPath(project, path)
      const d = inst ? project.defs[inst.def] : undefined
      const p = d?.kind === 'code' ? d.params.find((x) => x.name === name) : undefined
      if (!inst || !p) return null
      return { has: hasOwn(inst.params, name), eff: resolveParamDefs([p], inst.params)[name], pd: p }
    }
    const commit = (v: ParamValue) => {
      const c = current()
      // unchanged value: nothing to do (an inherited default stays inherited)
      if (!c || v === c.eff) return
      ctx.commands.setOverride(path, name, v)
    }
    const dot = h('span', { class: 'ovr-dot', title: 'Overridden on this instance' }, '●')
    const reset = h('button', { type: 'button', class: 'icon-btn prm-reset', 'data-testid': `param-reset-${name}`, title: `Reset to the default (${String(pd.default)})`, tabIndex: -1 }, '↺')
    reset.addEventListener('click', () => { ctx.commands.setOverride(path, name, undefined); reset.blur() })
    const label = h('label', { class: 'prm-name', title: name, for: `prm-${name}` }, h('span', { class: 'prm-name-text' }, name), dot)
    let ctl: HTMLElement
    let patch: (v: ParamValue) => void

    if (pd.type === 'number') {
      const num = h('input', {
        type: 'number', class: 'num', id: `prm-${name}`, 'data-testid': `param-${name}`, 'data-k': `param-${name}`,
        step: pd.step ?? 'any', min: pd.min, max: pd.max,
      })
      const range = pd.min !== undefined && pd.max !== undefined
        ? h('input', { type: 'range', class: 'range', min: pd.min, max: pd.max, step: pd.step ?? 'any', 'data-k': `range-${name}`, tabIndex: -1, 'aria-label': `${name} slider` })
        : null
      const show = () => { const c = current(); if (c && typeof c.eff === 'number') num.value = fmtNum(c.eff) }
      const commitNum = () => {
        const raw = num.value.trim()
        const v = Number(raw)
        if (raw !== '' && Number.isFinite(v)) commit(v)
        show()
      }
      onCommit(num, commitNum)
      if (range) {
        range.addEventListener('input', () => { const v = Number(range.value); num.value = fmtNum(v); commit(v) })
        range.addEventListener('change', () => range.blur())
      }
      ctl = h('div', { class: 'prm-ctl' }, range, num)
      patch = (v) => {
        if (typeof v !== 'number') return
        if (!isFocused(num)) num.value = fmtNum(v)
        if (range && !isFocused(range)) range.value = String(v)
      }
    } else if (pd.type === 'boolean') {
      const cb = h('input', { type: 'checkbox', id: `prm-${name}`, 'data-testid': `param-${name}`, 'data-k': `param-${name}` })
      cb.addEventListener('change', () => commit(cb.checked))
      ctl = h('div', { class: 'prm-ctl' }, h('label', { class: 'check' }, cb, h('span', { class: 'muted' }, 'on')))
      patch = (v) => { cb.checked = v === true }
    } else {
      const sel = h('select', { id: `prm-${name}`, 'data-testid': `param-${name}`, 'data-k': `param-${name}` },
        (pd.options ?? []).map((o) => h('option', { value: o }, o)))
      sel.addEventListener('change', () => commit(sel.value))
      ctl = h('div', { class: 'prm-ctl' }, sel)
      patch = (v) => { if (!isFocused(sel)) sel.value = String(v) }
    }
    const row = h('div', { class: 'prm' }, label, ctl, reset)
    list.appendChild(row)
    binds.push(() => {
      const c = current()
      if (!c) return
      row.classList.toggle('overridden', c.has)
      reset.title = `Reset to the default (${String(c.pd.default)})`
      patch(c.eff)
    })
  }

  // unknown override keys (§4.10): "stale override 'len' ✕"
  const stale = inst0 ? staleOverrideKeys(def, inst0.params) : []
  for (const key of stale) {
    const x = h('button', { type: 'button', class: 'icon-btn', 'data-testid': `param-stale-${key}`, title: 'Remove this override' }, '✕')
    x.addEventListener('click', () => ctx.commands.setOverride(path, key, undefined))
    list.appendChild(h('div', { class: 'prm-stale' }, h('span', null, `stale override '${key}'`), x))
  }
  if (def.params.length === 0 && stale.length === 0) list.appendChild(h('div', { class: 'muted small' }, 'This object has no parameters.'))
  return list
}

// ───────────────────────────── ParamDef table (definition) ─────────────────────────────

interface TableRow { read(): ParamDef }

const numOrUndef = (s: string): number | undefined => {
  const t = s.trim()
  if (t === '') return undefined
  return Number(t)
}

function freeName(params: ParamDef[]): string {
  const taken = new Set(params.map((p) => p.name))
  if (!taken.has('param')) return 'param'
  for (let i = 2; ; i++) if (!taken.has(`param${i}`)) return `param${i}`
}

/** Convert a ParamDef to another type with a sensible default. */
function retype(p: ParamDef, type: ParamDef['type']): ParamDef {
  const out: ParamDef = { name: p.name, type, default: 0 }
  if (type === 'number') {
    const n = Number(p.default)
    out.default = typeof p.default === 'number' ? p.default : Number.isFinite(n) ? n : 0
    if (p.min !== undefined) out.min = p.min
    if (p.max !== undefined) out.max = p.max
    if (p.step !== undefined) out.step = p.step
  } else if (type === 'boolean') {
    out.default = p.default === true
  } else {
    const opts = p.options && p.options.length ? [...p.options] : typeof p.default === 'string' && p.default ? [p.default] : ['a', 'b']
    out.options = opts
    out.default = typeof p.default === 'string' && opts.includes(p.default) ? p.default : opts[0]
  }
  return out
}

/**
 * The ParamDef table. Rebuilt by the inspector whenever def.params changes (committed edits); a refused edit leaves
 * the user's input in place with the problem shown in `errorEl`. `focusLater(k)` asks the inspector to focus the
 * element with data-k = k after its next rebuild.
 */
export function paramTable(ctx: AppContext, def: CodeDef, focusLater: (k: string) => void): HTMLElement {
  const errorEl = h('div', { class: 'field-error', 'data-testid': 'param-table-error', role: 'alert' })
  const rows: TableRow[] = []
  const params = def.params
  const commitList = (list: ParamDef[]): boolean => {
    const err = ctx.commands.setParamDefs(def.id, list)
    errorEl.textContent = err ?? ''
    errorEl.classList.toggle('show', !!err)
    return !err
  }
  const commit = () => commitList(rows.map((r) => r.read()))

  const body = h('div', { class: 'pt-rows' })
  params.forEach((p, i) => {
    const k = (f: string) => `pdef-${f}-${i}`
    const nameIn = h('input', { type: 'text', class: 'txt pt-name', value: p.name, spellcheck: false, 'data-testid': k('name'), 'data-k': k('name'), 'aria-label': 'Parameter name' })
    const typeSel = h('select', { class: 'pt-type', 'data-testid': k('type'), 'data-k': k('type'), 'aria-label': 'Type' },
      ['number', 'boolean', 'choice'].map((t) => h('option', { value: t, selected: t === p.type }, t)))
    let defCtl: HTMLInputElement | HTMLSelectElement
    if (p.type === 'number') defCtl = h('input', { type: 'number', class: 'num', step: 'any', value: fmtNum(p.default as number), 'data-testid': k('default'), 'data-k': k('default'), 'aria-label': 'Default' })
    else if (p.type === 'boolean') defCtl = h('input', { type: 'checkbox', checked: p.default === true, 'data-testid': k('default'), 'data-k': k('default'), 'aria-label': 'Default' })
    else defCtl = h('select', { 'data-testid': k('default'), 'data-k': k('default'), 'aria-label': 'Default' }, (p.options ?? []).map((o) => h('option', { value: o, selected: o === p.default }, o)))
    const del = h('button', { type: 'button', class: 'icon-btn pt-del', 'data-testid': k('del'), title: `Remove parameter '${p.name}'` }, icon('close'))

    const minIn = h('input', { type: 'number', class: 'num', step: 'any', placeholder: 'min', value: p.min !== undefined ? fmtNum(p.min) : '', 'data-testid': k('min'), 'data-k': k('min'), 'aria-label': 'Min' })
    const maxIn = h('input', { type: 'number', class: 'num', step: 'any', placeholder: 'max', value: p.max !== undefined ? fmtNum(p.max) : '', 'data-testid': k('max'), 'data-k': k('max'), 'aria-label': 'Max' })
    const stepIn = h('input', { type: 'number', class: 'num', step: 'any', placeholder: 'step', value: p.step !== undefined ? fmtNum(p.step) : '', 'data-testid': k('step'), 'data-k': k('step'), 'aria-label': 'Step' })
    const optIn = h('input', { type: 'text', class: 'txt', spellcheck: false, placeholder: 'options, comma-separated', value: (p.options ?? []).join(', '), 'data-testid': k('options'), 'data-k': k('options'), 'aria-label': 'Options' })

    rows.push({
      read(): ParamDef {
        const out: ParamDef = { name: nameIn.value.trim(), type: p.type, default: p.default }
        if (p.type === 'number') {
          const raw = (defCtl as HTMLInputElement).value.trim()
          out.default = raw === '' ? NaN : Number(raw)
          const mn = numOrUndef(minIn.value), mx = numOrUndef(maxIn.value), st = numOrUndef(stepIn.value)
          if (mn !== undefined) out.min = mn
          if (mx !== undefined) out.max = mx
          if (st !== undefined) out.step = st
        } else if (p.type === 'boolean') {
          out.default = (defCtl as HTMLInputElement).checked
        } else {
          const opts = optIn.value.split(',').map((s) => s.trim()).filter(Boolean)
          out.options = opts
          const v = (defCtl as HTMLSelectElement).value
          out.default = opts.includes(v) ? v : opts[0] ?? ''
        }
        return out
      },
    })

    for (const el of [nameIn, minIn, maxIn, stepIn, optIn]) onCommit(el, commit)
    if (defCtl instanceof HTMLInputElement && defCtl.type === 'number') onCommit(defCtl, commit)
    else defCtl.addEventListener('change', commit)
    typeSel.addEventListener('change', () => {
      const list = rows.map((r) => r.read())
      list[i] = retype(list[i], typeSel.value as ParamDef['type'])
      focusLater(k('type'))
      commitList(list)
    })
    del.addEventListener('click', () => {
      commitList(rows.map((r) => r.read()).filter((_, j) => j !== i))
    })

    const extra = p.type === 'number' ? h('div', { class: 'pt-extra' }, h('span', { class: 'pt-lbl' }, 'range'), minIn, maxIn, stepIn)
      : p.type === 'choice' ? h('div', { class: 'pt-extra' }, h('span', { class: 'pt-lbl' }, 'options'), optIn) : null
    body.appendChild(h('div', { class: 'pt-row' },
      h('div', { class: 'pt-main' }, nameIn, typeSel, h('span', { class: 'pt-def' }, defCtl), del), extra))
  })

  const add = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'data-testid': 'param-add' }, icon('plus'), 'Add parameter')
  add.addEventListener('click', () => {
    const list = rows.map((r) => r.read())
    list.push({ name: freeName(list), type: 'number', default: 0 })
    focusLater(`pdef-name-${list.length - 1}`)
    commitList(list)
  })
  const head = params.length ? h('div', { class: 'pt-head' }, h('span', null, 'name'), h('span', null, 'type'), h('span', null, 'default'), h('span', null, '')) : null
  return h('div', { class: 'ptable' }, head, body, errorEl, h('div', { class: 'pt-actions' }, add))
}
