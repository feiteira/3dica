// Inspector parts for OpenSCAD objects (§4.10 for code defs, OpenSCAD variant):
// - scadParamTable: the parameters read from the code. Their structure is read-only (the code is the source of
//   truth); a default edited here rewrites the literal in the code (commands.setScadParamDefault, "Change width").
//   Customizer descriptions become tooltips, Customizer tabs become headers.
// - scadFilesSection: the files the code uses / includes — attached or missing — with attach / replace / remove /
//   download, plus "Attach files…" and "Export .scad".
import type { AppContext } from '../app/context'
import type { CodeDef, Id, ParamDef, ParamValue } from '../core/types'
import { isScad, scadDepList, scadParamInfo, scadStorePath, type ScadParamInfo } from '../core/scad'
import { extractParams } from '../openscad/customizer'
import { fmtNum, h, plural, setChildren, setText } from './dom'
import { icon } from './icons'
import { onCommit, type Bind } from './param-editor'

export const SCAD_PARAMS_NOTE = 'Read from the code: top-level numbers, true/false and drop-downs (// [a, b]). Edit the code to add, remove or rename them; a default changed here is written into the code.'

/** Why a top-level literal OpenSCAD's Customizer would show is not a 3Dica parameter (computed values and the
 *  Hidden tab are not parameters in OpenSCAD either, so they are not listed). */
const NOT_PARAM_REASONS = new Map([
  ['a string without options', 'text without options'],
  ['a vector', 'a vector'],
  ['a reserved word in 3Dica', 'a reserved word in 3Dica'],
  ['not a name 3Dica parameters can use', 'a name 3Dica parameters can\'t use'],
])
const MAX_NOT_PARAMS = 8

/** "Not parameters here: label (text without options), size (a vector) — edit them in the code", or ''. */
export function notParamsText(code: string): string {
  const items = extractParams(code).skipped.filter((x) => NOT_PARAM_REASONS.has(x.reason))
  if (!items.length) return ''
  const shown = items.slice(0, MAX_NOT_PARAMS).map((x) => `${x.name} (${NOT_PARAM_REASONS.get(x.reason)})`)
  const more = items.length > MAX_NOT_PARAMS ? ` and ${items.length - MAX_NOT_PARAMS} more` : ''
  return `Not parameters here: ${shown.join(', ')}${more} — edit them in the code.`
}

/** Range / options text of a parameter ("10 … 100, step 5"). */
function rangeText(p: ParamDef): string {
  if (p.type === 'choice') return (p.options ?? []).join(' · ')
  if (p.type !== 'number') return ''
  const bits: string[] = []
  if (p.min !== undefined || p.max !== undefined) bits.push(`${p.min !== undefined ? fmtNum(p.min) : '…'} … ${p.max !== undefined ? fmtNum(p.max) : '…'}`)
  if (p.step !== undefined) bits.push(`step ${fmtNum(p.step)}`)
  return bits.join(', ')
}

/** Tooltip of a parameter name: its Customizer description and where it is in the code. */
export function scadParamTitle(name: string, info: ScadParamInfo | undefined): string {
  if (!info) return name
  return `${info.description ? `${info.description}\n` : ''}${name} — line ${info.line} of the code`
}

/**
 * The parameter table of an OpenSCAD def. Rebuilt by the inspector whenever the params change; `focusLater` asks for
 * the edited control to get the focus back after that rebuild.
 */
export function scadParamTable(ctx: AppContext, def: CodeDef, focusLater: (k: string) => void): HTMLElement {
  const errorEl = h('div', { class: 'field-error', 'data-testid': 'param-table-error', role: 'alert' })
  const info = scadParamInfo(def.code)
  const commit = (name: string, v: ParamValue, k: string) => {
    focusLater(k)
    const err = ctx.commands.setScadParamDefault(def.id, name, v)
    errorEl.textContent = err ?? ''
    errorEl.classList.toggle('show', !!err)
    return !err
  }
  const body = h('div', { class: 'pt-rows scad-rows' })
  let group: string | undefined
  def.params.forEach((p, i) => {
    const pi = info.get(p.name)
    if (pi?.group && pi.group !== group) body.appendChild(h('div', { class: 'scad-group', 'data-testid': 'scad-param-group' }, pi.group))
    group = pi?.group ?? group
    const k = `pdef-default-${i}`
    let ctl: HTMLElement
    if (p.type === 'number') {
      // the literal at full precision: the code is the source of truth, and Enter in an unchanged field must not
      // write a rounded value back into it
      const shown = String(p.default)
      const input = h('input', { type: 'number', class: 'num', step: p.step ?? 'any', min: p.min, max: p.max, value: shown, 'data-testid': k, 'data-k': k, 'aria-label': `Default of ${p.name}` })
      onCommit(input, () => {
        const raw = input.value.trim()
        if (raw === shown) return
        const v = Number(raw)
        if (raw === '' || !Number.isFinite(v)) { input.value = shown; return }
        if (v === p.default) return
        return commit(p.name, v, k)
      })
      ctl = input
    } else if (p.type === 'boolean') {
      const cb = h('input', { type: 'checkbox', checked: p.default === true, 'data-testid': k, 'data-k': k, 'aria-label': `Default of ${p.name}` })
      cb.addEventListener('change', () => { commit(p.name, cb.checked, k) })
      ctl = cb
    } else {
      const sel = h('select', { 'data-testid': k, 'data-k': k, 'aria-label': `Default of ${p.name}` },
        (p.options ?? []).map((o) => h('option', { value: o, selected: o === p.default }, o)))
      sel.addEventListener('change', () => { commit(p.name, sel.value, k) })
      ctl = sel
    }
    const range = rangeText(p)
    body.appendChild(h('div', { class: 'pt-row scad-row', 'data-testid': 'scad-param-row' },
      h('div', { class: 'scad-main' },
        h('span', { class: 'pt-name scad-name', title: scadParamTitle(p.name, pi), 'data-testid': `pdef-name-${i}` }, p.name),
        h('span', { class: 'scad-type muted small' }, p.type),
        h('span', { class: 'pt-def' }, ctl)),
      pi?.description || range ? h('div', { class: 'scad-extra muted small' },
        pi?.description ? h('span', { class: 'scad-desc' }, pi.description) : null,
        range ? h('span', { class: 'scad-range' }, range) : null) : null))
  })
  if (!def.params.length) body.appendChild(h('div', { class: 'muted small' }, 'No parameters. Top-level assignments like width = 40; become parameters.'))
  const skipped = notParamsText(def.code)
  return h('div', { class: 'ptable scad-ptable' },
    h('div', { class: 'scad-note muted small', 'data-testid': 'scad-params-note' }, icon('info'), h('span', null, SCAD_PARAMS_NOTE)),
    body,
    skipped ? h('div', { class: 'scad-skipped muted small', 'data-testid': 'scad-params-skipped' }, skipped) : null,
    errorEl)
}

const base = (p: string) => p.split('/').pop() ?? p

/** The attached-files list of an OpenSCAD def (patched on every render through `binds`) and its buttons. */
export function scadFilesSection(ctx: AppContext, defId: Id, binds: Bind[]): HTMLElement {
  const list = h('div', { class: 'scad-files', 'data-testid': 'scad-files' })
  const attach = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'data-testid': 'scad-attach', title: 'Attach .scad files the code uses or includes (several at once)' }, icon('attach'), 'Attach files…')
  attach.addEventListener('click', () => { attach.blur(); void ctx.commands.attachScadFiles(defId) })
  const exp = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'data-testid': 'scad-export', title: 'Download this object\'s OpenSCAD code as a .scad file' }, icon('download'), 'Export .scad')
  exp.addEventListener('click', () => { exp.blur(); ctx.commands.exportScad(defId) })
  const summary = h('span', { class: 'muted small' })
  let sig = ''

  const fileBtn = (label: string, ic: string, testid: string, title: string, run: () => void) => {
    const b = h('button', { type: 'button', class: 'icon-btn', 'data-testid': testid, title, 'aria-label': label }, icon(ic))
    b.addEventListener('click', () => { b.blur(); run() })
    return b
  }

  binds.push((rs) => {
    const def = rs.project.defs[defId]
    if (!isScad(def)) return
    const deps = scadDepList(def.code, def.files)
    const files = def.files ?? {}
    const used = new Set(deps.map((d) => d.resolved).filter((x): x is string => x !== null))
    const unused = Object.keys(files).filter((k) => !used.has(k)).sort()
    const missing = deps.filter((d) => d.resolved === null).length
    const s = JSON.stringify([deps, unused, Object.keys(files).map((k) => [k, files[k].length])])
    setText(summary, `${plural(Object.keys(files).length, 'file')}${missing ? ` · ${missing} missing` : ''}`)
    if (s === sig) return
    sig = s
    const rows: HTMLElement[] = []
    for (const d of deps) {
      if (d.resolved === null) {
        const target = scadStorePath(d.from, d.name) ?? d.name
        rows.push(h('div', { class: 'scad-file missing', 'data-testid': 'scad-file', 'data-path': target, 'data-state': 'missing' },
          icon('warn'), h('span', { class: 'scad-file-name', title: `${d.name} — named in ${d.from || 'the code'}, not attached` }, d.name),
          h('span', { class: 'scad-file-state' }, 'missing'),
          h('button', { type: 'button', class: 'btn btn-sm', 'data-testid': 'scad-file-attach', title: `Attach ${d.name}`, 'aria-label': `Attach ${d.name}` }, 'Attach…')))
        const btn = rows[rows.length - 1].querySelector('button')!
        btn.addEventListener('click', () => { btn.blur(); void ctx.commands.attachScadFiles(defId, target) })
        continue
      }
      rows.push(fileRow(d.resolved, files[d.resolved], d.from ? `used by ${d.from}` : ''))
    }
    for (const k of unused) rows.push(fileRow(k, files[k], 'not used by the code'))
    if (!rows.length) rows.push(h('div', { class: 'muted small' }, 'No use <…> or include <…> files.'))
    setChildren(list, rows)
  })

  function fileRow(path: string, text: string, note: string): HTMLElement {
    return h('div', { class: 'scad-file', 'data-testid': 'scad-file', 'data-path': path, 'data-state': 'attached' },
      icon('file'), h('span', { class: 'scad-file-name', title: `${path} · ${text.length.toLocaleString('en-US')} characters${note ? ` · ${note}` : ''}` }, path),
      note ? h('span', { class: 'scad-file-state muted' }, note) : h('span', { class: 'scad-file-state' }),
      fileBtn(`Replace ${base(path)}`, 'refresh', 'scad-file-replace', `Replace ${path} with another file`, () => { void ctx.commands.attachScadFiles(defId, path) }),
      fileBtn(`Download ${base(path)}`, 'download', 'scad-file-download', `Download ${path}`, () => ctx.commands.downloadScadFile(defId, path)),
      fileBtn(`Remove ${base(path)}`, 'trash', 'scad-file-remove', `Remove ${path}`, () => ctx.commands.removeScadFile(defId, path)))
  }

  return h('div', { class: 'scad-files-sec' },
    h('div', { class: 'sec-title' }, h('span', null, 'Files'), summary),
    list,
    h('div', { class: 'field-row end scad-file-actions' }, attach, exp))
}
