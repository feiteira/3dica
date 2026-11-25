// The Customizer reader: OpenSCAD's parameter conventions (User Manual, "Customizer") as 3Dica ParamDefs.
// Main-thread code, so it only uses the tokenizer — no parser, interpreter or geometry.
//
//   // Description of the next parameter       ← a `//` comment at column 1 on the line above
//   width = 40;        // [10:100]              ← slider: [max], [min:max], [min:step:max]
//   wall = 2;          // .5                    ← spinbox step
//   holes = 2;         // [0, 1, 2, 3]          ← dropdown of values
//   size = 20;         // [10:Small, 20:Large]  ← labelled dropdown (value:label)
//   /* [Hidden] */                              ← tabs: /* [Name] */; nothing in [Hidden] is a parameter
//
// Only top-level assignments of a literal (number, string, true/false) before the first `{` of the main file
// count, as in OpenSCAD. 3Dica maps numbers to 'number' (sliders and spinboxes keep min/max/step), booleans to
// 'boolean', and dropdowns to 'choice', whose options are display strings: the values of a plain dropdown, the
// labels of a labelled one. A value that is not among the dropdown's items is added as the first option.
import { isValidIdentifier } from '../core/params'
import type { ParamValue } from '../core/types'
import { MAX_TOKENS, tokenize, type Token } from './lexer'
import type { ExtractParams, ExtractResult, ScadParam, SetParamDefault } from './types'

interface Entry {
  name: string
  line: number
  /** source offsets of the value literal */
  start: number
  end: number
  param?: ScadParam
  /** for a 'choice': the OpenSCAD value of each option */
  values?: (number | string)[]
  skip?: string
}

const RESERVED_HINT = 'a reserved word in 3Dica'

// parameters end at the first {, so the rest of the file is not even read (it may be megabytes of polyhedron data)
const OPTS = { comments: true, untilBrace: true, maxTokens: MAX_TOKENS }

function tokens(source: string): Token[] {
  try {
    return tokenize(source, OPTS)
  } catch (e) {
    // read what comes before the bad token (an unterminated string or comment at the end, typically)
    const pos = (e as { pos?: { line: number; col: number } }).pos
    if (!pos) return []
    let off = 0
    for (let l = 1; l < pos.line; l++) off = source.indexOf('\n', off) + 1
    off += pos.col - 1
    try { return off > 0 && off < source.length ? tokenize(source.slice(0, off), OPTS) : [] } catch { return [] }
  }
}

const NUM = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

/** `[a:b]`, `[a:s:b]`, `[max]` → slider bounds; `[x, y:label, …]` → dropdown items; `.5` → step */
function readWidget(comment: string): { slider?: number[]; items?: { value: string; label?: string }[]; step?: number } {
  const c = comment.trim()
  const m = /^\[(.*)\]$/.exec(c)
  if (!m) return NUM.test(c) ? { step: Number(c) } : {}
  const inner = m[1].trim()
  if (!inner) return {}
  if (!inner.includes(',')) {
    const parts = inner.split(':').map((s) => s.trim())
    if (parts.length <= 3 && parts.every((p) => NUM.test(p))) return { slider: parts.map(Number) }
  }
  const items = inner.split(',').map((s) => s.trim()).filter((s) => s.length).map((s) => {
    const i = s.indexOf(':')
    return i < 0 ? { value: s } : { value: s.slice(0, i).trim(), label: s.slice(i + 1).trim() }
  })
  return { items }
}

function scan(source: string): Entry[] {
  const toks = tokens(source)
  // by name, in order: a Map keeps "a later assignment wins and moves to the end" linear (a generated file can have
  // tens of thousands of assignments, and this runs on the main thread on every edit and load)
  const out = new Map<string, Entry>()
  const lines = source.split('\n')
  let group: string | undefined
  let hidden = false
  let stmtStart = true
  let depth = 0
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.type === 'eof') break
    if (t.type === 'comment') {
      const g = t.block ? /^\s*\[([^\]]*)\]\s*$/.exec(t.text) : null
      if (g) { group = g[1].trim(); hidden = group.toLowerCase() === 'hidden' }
      continue
    }
    if (t.type === 'op' && t.text === '{') break   // parameters end at the first {
    if (t.type === 'op' && (t.text === '(' || t.text === '[')) depth++
    if (t.type === 'op' && (t.text === ')' || t.text === ']')) depth--
    if (t.type === 'use' || t.type === 'include') { stmtStart = true; continue }
    if (t.type === 'op' && t.text === ';' && depth <= 0) { stmtStart = true; depth = 0; continue }
    const wasStart = stmtStart
    stmtStart = false
    if (!wasStart || depth !== 0 || t.type !== 'id') continue
    let j = i + 1
    while (toks[j]?.type === 'comment') j++
    if (!(toks[j]?.type === 'op' && toks[j].text === '=')) continue
    // the value: tokens up to the ';' at depth 0
    const value: Token[] = []
    let d = 0
    let k = j + 1
    for (; k < toks.length; k++) {
      const v = toks[k]
      if (v.type === 'eof' || (v.type === 'op' && v.text === '{')) break
      if (v.type === 'comment') continue
      if (v.type === 'op' && (v.text === '(' || v.text === '[')) d++
      if (v.type === 'op' && (v.text === ')' || v.text === ']')) d--
      if (v.type === 'op' && v.text === ';' && d <= 0) break
      value.push(v)
    }
    const semi = toks[k]
    if (!semi || semi.type !== 'op' || semi.text !== ';' || !value.length) { i = k - 1; continue }
    i = k
    stmtStart = true
    const entry: Entry = { name: t.text, line: t.line, start: value[0].start, end: value[value.length - 1].end }
    // the widget comment: the first comment after the ';' on the same line
    const after = toks[k + 1]
    const widget = after?.type === 'comment' && after.line === semi.line ? after.text : undefined
    // the description: a `//` comment at column 1 on the line just above
    const above = t.line >= 2 ? lines[t.line - 2] : undefined
    const description = above !== undefined && above.startsWith('//') && !/^\/\/\s*\[.*\]\s*$/.test(above) ? above.slice(2).trim() || undefined : undefined
    classify(entry, value, widget, description, group, hidden)
    out.delete(entry.name)   // a later assignment wins (and moves to the end), as at run time
    out.set(entry.name, entry)
  }
  return [...out.values()]
}

function classify(e: Entry, value: Token[], widget: string | undefined, description: string | undefined, group: string | undefined, hidden: boolean) {
  let lit: number | string | boolean | undefined
  const [a, b] = value
  if (value.length === 1 && a.type === 'num') lit = a.num
  else if (value.length === 2 && a.type === 'op' && (a.text === '-' || a.text === '+') && b.type === 'num') lit = a.text === '-' ? -b.num : b.num
  else if (value.length === 1 && a.type === 'str') lit = a.text
  else if (value.length === 1 && a.type === 'kw' && (a.text === 'true' || a.text === 'false')) lit = a.text === 'true'
  if (hidden) { e.skip = 'in the Hidden tab'; return }
  if (lit === undefined) { e.skip = a.type === 'op' && a.text === '[' ? 'a vector' : 'an expression'; return }
  if (!isValidIdentifier(e.name)) { e.skip = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(e.name) ? RESERVED_HINT : 'not a name 3Dica parameters can use'; return }
  const w = widget !== undefined ? readWidget(widget) : {}
  const base = { name: e.name, line: e.line, ...(description ? { description } : {}), ...(group ? { group } : {}) }
  if (typeof lit === 'boolean') { e.param = { ...base, type: 'boolean', default: lit }; return }
  if (w.items) {
    const options: string[] = []
    const values: (number | string)[] = []
    for (const it of w.items) {
      const v = typeof lit === 'number' && NUM.test(it.value) ? Number(it.value) : it.value
      let label = it.label ?? it.value
      // options must be unique: a repeated item is dropped, a repeated label gets its value added ("One (2)")
      const same = options.indexOf(label)
      if (same >= 0 && values[same] === v) continue
      if (same >= 0) label = `${label} (${it.value})`
      if (options.includes(label)) continue
      options.push(label)
      values.push(v)
    }
    let idx = values.findIndex((v) => v === lit)
    if (idx < 0) {
      options.unshift(typeof lit === 'number' ? String(lit) : lit)
      values.unshift(lit)
      idx = 0
    }
    e.param = { ...base, type: 'choice', default: options[idx], options }
    e.values = values
    return
  }
  if (typeof lit === 'string') { e.skip = 'a string without options'; return }
  const p: ScadParam = { ...base, type: 'number', default: lit }
  if (w.slider) {
    const s = w.slider
    if (s.length === 1) { p.min = 0; p.max = s[0] }
    else if (s.length === 2) { p.min = s[0]; p.max = s[1] }
    else { p.min = s[0]; p.step = s[1]; p.max = s[2] }
  } else if (w.step !== undefined && w.step > 0) p.step = w.step
  e.param = p
}

/** the last source scanned and its entries: the Inspector, the store and the worker ask about the same code in a row */
let last: { source: string; entries: Entry[] } | null = null
function entriesOf(source: string): Entry[] {
  if (last?.source === source) return last.entries
  const entries = scan(source)
  last = { source, entries }
  return entries
}

export const extractParams: ExtractParams = (source) => {
  const res: ExtractResult = { params: [], skipped: [] }
  try {
    for (const e of entriesOf(typeof source === 'string' ? source : '')) {
      // copies: callers may change what they get
      if (e.param) res.params.push({ ...e.param, ...(e.param.options ? { options: [...e.param.options] } : {}) })
      else res.skipped.push({ name: e.name, line: e.line, reason: e.skip ?? 'an expression' })
    }
  } catch {
    // never throws: what was read so far stands
  }
  return res
}

/** numbers written the shortest way that reads back to the same value */
const numText = (n: number) => String(n)
const strText = (s: string) => '"' + s.replace(/[\\"\n\t\r]/g, (c) => c === '\n' ? '\\n' : c === '\t' ? '\\t' : c === '\r' ? '\\r' : '\\' + c) + '"'

export const setParamDefault: SetParamDefault = (source, name, value) => {
  try {
    const e = entriesOf(source).find((x) => x.name === name && x.param)
    if (!e || !e.param) return null
    let text: string
    switch (e.param.type) {
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) return null
        text = numText(value)
        break
      case 'boolean':
        if (typeof value !== 'boolean') return null
        text = value ? 'true' : 'false'
        break
      case 'choice': {
        const i = typeof value === 'string' ? e.param.options!.indexOf(value) : -1
        if (i < 0) return null
        const v = e.values![i]
        text = typeof v === 'number' ? numText(v) : strText(v)
        break
      }
    }
    return source.slice(0, e.start) + text + source.slice(e.end)
  } catch {
    return null
  }
}

/**
 * The option of dropdown parameter `name` for `value`: the option itself, or the option whose OpenSCAD item value is
 * `value` (numbers compared as numbers, so 3 and "3" both find the item 3 of // [0, 1, 2, 3], and 30 finds Large in
 * // [10:Small, 30:Large]). null when `name` is not a dropdown of `source` or `value` matches nothing. An OpenSCAD
 * user writes part("plate", holes = 3), and the AI overrides with the value it reads in the code.
 */
export function choiceOption(source: string, name: string, value: ParamValue): string | null {
  let e: Entry | undefined
  try { e = entriesOf(source).find((x) => x.name === name) } catch { return null }
  if (!e?.param || e.param.type !== 'choice' || !e.values) return null
  const options = e.param.options ?? []
  if (typeof value === 'string' && options.includes(value)) return value
  const asNum = (x: unknown) => (typeof x === 'number' ? x : typeof x === 'string' && NUM.test(x.trim()) ? Number(x) : NaN)
  const n = asNum(value)
  for (let i = 0; i < e.values.length; i++) {
    const v = e.values[i]
    if (v === value || (!Number.isNaN(n) && asNum(v) === n)) return options[i] ?? null
  }
  return null
}

/**
 * The OpenSCAD values of 3Dica parameter values, for the interpreter: a choice option becomes the dropdown item's
 * value ("Large" → 20); anything else is used as it is.
 */
export function overrideValues(source: string, overrides: Record<string, ParamValue>): Map<string, ParamValue> {
  const out = new Map<string, ParamValue>()
  const names = Object.keys(overrides)
  if (!names.length) return out
  let entries: Entry[] = []
  try { entries = entriesOf(source) } catch { /* use the raw values */ }
  const byName = new Map(entries.map((e) => [e.name, e]))
  for (const n of names) {
    const v = overrides[n]
    if (typeof v !== 'number' && typeof v !== 'boolean' && typeof v !== 'string') continue
    const e = byName.get(n)
    if (e?.param?.type === 'choice' && typeof v === 'string') {
      const i = e.param.options!.indexOf(v)
      out.set(n, i >= 0 ? e.values![i] : v)
    } else out.set(n, v)
  }
  return out
}
