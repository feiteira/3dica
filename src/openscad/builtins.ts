// The built-in functions of OpenSCAD 2021.01. Trigonometry is in degrees with exact results at the special angles
// (sin(30) = 0.5, cos(90) = 0), as in OpenSCAD. Wrong argument counts or types give undef and OpenSCAD's warning.
import type { Arg, Expr } from './ast'
import { limitedString, shortValue } from './format'
import { Mt19937 } from './rng'
import type { ScadError, SourcePos } from './types'
import { chars, compare, cpow, equal, rangeCount, ScadFunc, ScadRange, strLength, type Value } from './values'

export interface BuiltinCtx {
  name: string
  args: Arg[]
  pos: SourcePos
  eval(e: Expr): Value
  warn(text: string): void
  error(kind: ScadError['kind'], msg: string): ScadError
  /** register a new list (length limit + budget) */
  list(v: Value[]): Value[]
  /** register a new string (length limit + budget) */
  str(s: string): string
  checkList(n: number): void
  /** the string length limit */
  maxString(): number
  /** count work done in one go (n comparisons) against the evaluation's step limit */
  steps(n: number): void
  /** the evaluation's unseeded random source, a double in [0, 1) */
  random(): number
  parentModule(n: number): Value
  /** whether a variable is undefined or unknown, without the unknown-variable warning (is_undef) */
  isUndefVar(name: string): boolean
}

export type BuiltinFn = (ctx: BuiltinCtx) => Value

const values = (c: BuiltinCtx) => c.args.map((a) => c.eval(a.expr))
const countWarn = (c: BuiltinCtx) => { c.warn(`${c.name}() number of parameters does not match`); return undefined }
const convWarn = (c: BuiltinCtx) => { c.warn(`${c.name}() parameter could not be converted`); return undefined }

// ───── degrees ─────

const RAD = Math.PI / 180
/** OpenSCAD's degree functions give nan from about here on (observed: 1e18 works, 2e18 does not) */
const MAX_ANGLE = 360 * 2 ** 52
const badAngle = (x: number) => !(Math.abs(x) < MAX_ANGLE)

/** sin in degrees, exact at multiples of 30° where the result is 0, ±0.5 or ±1 */
export function sinDeg(x: number): number {
  if (badAngle(x)) return NaN
  let a = x % 360
  if (a < 0) a += 360
  const neg = a >= 180
  if (neg) a -= 180
  if (a > 90) a = 180 - a
  const s = a === 0 ? 0 : a === 30 ? 0.5 : a === 90 ? 1 : Math.sin(a * RAD)
  return neg ? -s : s
}

/** cos in degrees, exact at multiples of 60° and 90° */
export function cosDeg(x: number): number {
  if (badAngle(x)) return NaN
  let a = x % 360
  if (a < 0) a += 360
  let neg = false
  if (a > 180) a = 360 - a
  if (a > 90) { a = 180 - a; neg = true }
  const c = a === 0 ? 1 : a === 60 ? 0.5 : a === 90 ? 0 : Math.cos(a * RAD)
  return neg ? -c : c
}

/** tan in degrees, exact at multiples of 45° (tan(90) = inf, tan(270) = -inf) */
export function tanDeg(x: number): number {
  if (badAngle(x)) return NaN
  let full = x % 360
  if (full < 0) full += 360
  if (full === 90) return Infinity
  if (full === 270) return -Infinity
  let a = full % 180
  const neg = a > 90
  if (neg) a = 180 - a
  const t = a === 0 ? 0 : a === 45 ? 1 : Math.tan(a * RAD)
  return neg ? -t : t
}

/** a one-number function: f(x) for a number, otherwise undef with a warning */
const num1 = (f: (x: number) => number): BuiltinFn => (c) => {
  if (c.args.length !== 1) return countWarn(c)
  const v = c.eval(c.args[0].expr)
  return typeof v === 'number' ? f(v) : convWarn(c)
}

const num2 = (f: (x: number, y: number) => number): BuiltinFn => (c) => {
  if (c.args.length !== 2) return countWarn(c)
  const [x, y] = values(c)
  return typeof x === 'number' && typeof y === 'number' ? f(x, y) : convWarn(c)
}

/** C round(): halves away from zero */
const cround = (x: number) => (x < 0 ? -Math.round(-x) : Math.round(x))

function minMax(c: BuiltinCtx, isMin: boolean): Value {
  if (c.args.length === 0) return countWarn(c)
  const vals = values(c)
  const better = (a: Value, b: Value) => compare(a, b, isMin ? '<' : '>', null) === true
  if (vals.length === 1) {
    const v = vals[0]
    if (Array.isArray(v)) {
      if (!v.length) return convWarn(c)
      let best = v[0]
      for (let i = 1; i < v.length; i++) if (better(v[i], best)) best = v[i]
      return best
    }
    return typeof v === 'number' ? v : convWarn(c)
  }
  if (!vals.every((v) => typeof v === 'number')) return convWarn(c)
  let best = vals[0] as number
  for (let i = 1; i < vals.length; i++) if (better(vals[i], best)) best = vals[i] as number
  return best
}

function norm(c: BuiltinCtx): Value {
  if (c.args.length !== 1) return countWarn(c)
  const v = c.eval(c.args[0].expr)
  if (!Array.isArray(v)) return undefined
  let s = 0
  for (const x of v) {
    if (typeof x !== 'number') { c.warn('Incorrect arguments to norm()'); return undefined }
    s += x * x
  }
  return Math.sqrt(s)
}

function cross(c: BuiltinCtx): Value {
  if (c.args.length !== 2) { c.warn('Invalid number of parameters for cross()'); return undefined }
  const [a, b] = values(c)
  if (!Array.isArray(a) || !Array.isArray(b)) { c.warn('Invalid type of parameters for cross()'); return undefined }
  if (a.length !== b.length || (a.length !== 2 && a.length !== 3)) { c.warn('Invalid vector size of parameter for cross()'); return undefined }
  if (![...a, ...b].every((x) => typeof x === 'number' && Number.isFinite(x))) { c.warn('Invalid value in parameter vector for cross()'); return undefined }
  const [x1, y1, z1 = 0] = a as number[]
  const [x2, y2, z2 = 0] = b as number[]
  if (a.length === 2) return x1 * y2 - y1 * x2
  return c.list([y1 * z2 - z1 * y2, z1 * x2 - x1 * z2, x1 * y2 - y1 * x2])
}

function len(c: BuiltinCtx): Value {
  if (c.args.length !== 1) return countWarn(c)
  const v = c.eval(c.args[0].expr)
  if (Array.isArray(v)) return v.length
  if (typeof v === 'string') return strLength(v)
  return convWarn(c)
}

function concat(c: BuiltinCtx): Value {
  const vals = values(c)
  let n = 0
  for (const v of vals) n += Array.isArray(v) ? v.length : 1
  c.checkList(n)
  const out: Value[] = []
  for (const v of vals) if (Array.isArray(v)) { for (const x of v) out.push(x) } else out.push(v)
  return c.list(out)
}

function lookup(c: BuiltinCtx): Value {
  if (c.args.length !== 2) return countWarn(c)
  const [k, table] = values(c)
  if (typeof k !== 'number') { c.warn(`lookup(${shortValue(k)}, ...) first argument is not a number`); return undefined }
  if (!Array.isArray(table)) return convWarn(c)
  // entries that are not [number, number] are skipped
  let lowK = -Infinity, lowV = 0, highK = Infinity, highV = 0
  let haveLow = false, haveHigh = false
  let minK = Infinity, minV: number | undefined, maxK = -Infinity, maxV: number | undefined
  for (const e of table) {
    if (!Array.isArray(e) || e.length < 2 || typeof e[0] !== 'number' || typeof e[1] !== 'number') continue
    const [ek, ev] = e as number[]
    if (ek < minK) { minK = ek; minV = ev }
    if (ek > maxK) { maxK = ek; maxV = ev }
    // on equal keys the first entry wins
    if (ek <= k && (!haveLow || ek > lowK)) { lowK = ek; lowV = ev; haveLow = true }
    if (ek >= k && (!haveHigh || ek < highK)) { highK = ek; highV = ev; haveHigh = true }
  }
  if (minV === undefined) return undefined
  if (k <= minK) return minV
  if (k >= maxK) return maxV
  if (!haveLow || !haveHigh) return undefined
  if (highK === lowK) return lowV
  return lowV + ((k - lowK) / (highK - lowK)) * (highV - lowV)
}

function str(c: BuiltinCtx): Value {
  // written with a cap, so str() of a huge list fails fast instead of building a giant string first
  const max = c.maxString()
  let s = ''
  for (const a of c.args) {
    s += limitedString(c.eval(a.expr), false, max - s.length + 1).text
    if (s.length > max) break
  }
  return c.str(s)
}

function chr(c: BuiltinCtx): Value {
  let s = ''
  const add = (v: Value) => {
    if (typeof v === 'number') {
      const n = Math.trunc(v)
      if (n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)) s += String.fromCodePoint(n)
    } else if (Array.isArray(v)) v.forEach(add)
    else if (v instanceof ScadRange) {
      const n = Math.min(rangeCount(v), 1_000_000)
      for (let i = 0; i < n; i++) add(v.begin + i * v.step)
    }
  }
  for (const v of values(c)) add(v)
  return c.str(s)
}

function ord(c: BuiltinCtx): Value {
  if (c.args.length !== 1) return undefined
  const v = c.eval(c.args[0].expr)
  if (typeof v !== 'string') { c.warn(`ord() argument ${shortValue(v)} is not of type string`); return undefined }
  if (!v.length) return undefined
  return v.codePointAt(0)
}

// ───── search ─────

function search(c: BuiltinCtx): Value {
  const vals = values(c)
  if (vals.length < 2 || vals.length > 4) return countWarn(c)
  const [match, hay, nr = 1, col = 0] = vals
  const numReturns = typeof nr === 'number' ? Math.trunc(nr) : 1
  const colNum = typeof col === 'number' ? Math.trunc(col) : 0
  const limit = numReturns <= 0 ? Infinity : numReturns
  const all = numReturns !== 1
  // nothing to search in: no hits, one empty list per term of a vector (search([1], 1) is [[]])
  if (typeof hay !== 'string' && !Array.isArray(hay)) return c.list(Array.isArray(match) ? match.map(() => c.list([])) : [])
  const key = (e: Value): Value | typeof NONE => (Array.isArray(e) ? (colNum < e.length ? e[colNum] : NONE) : colNum === 0 ? e : NONE)

  if (typeof match === 'number') {
    if (!Array.isArray(hay)) return c.list([])
    const out: number[] = []
    c.steps(hay.length / 16)
    for (let i = 0; i < hay.length && out.length < limit; i++) { const k = key(hay[i]); if (k !== NONE && equal(k, match)) out.push(i) }
    return c.list(out)
  }
  if (typeof match === 'string') {
    const needle = chars(match)
    const out: Value[] = []
    if (typeof hay === 'string') {
      const h = chars(hay)
      for (const ch of needle) {
        c.steps(h.length / 16)
        const hits: number[] = []
        for (let i = 0; i < h.length && hits.length < limit; i++) if (h[i] === ch) hits.push(i)
        if (all) out.push(c.list(hits))
        else if (hits.length) out.push(hits[0])
      }
      return c.list(out)
    }
    for (let i = 0; i < hay.length; i++) {
      const e = hay[i]
      if (!Array.isArray(e) || e.length <= colNum) {
        c.warn(`Invalid entry in search vector at index ${i}, required number of values in the entry: ${colNum + 1}. Invalid entry: ${shortValue(e)}`)
        return c.list([])
      }
    }
    // each character is compared with the first character of str(row[col]), as OpenSCAD 2021.01 does: "M4" finds
    // the row of "M3" for its M, and "1" finds the row whose key is the number 1
    const firsts = hay.map((e) => firstChar((e as Value[])[colNum]))
    for (const ch of needle) {
      c.steps(hay.length / 16)
      const hits: number[] = []
      for (let i = 0; i < hay.length && hits.length < limit; i++) if (firsts[i] === ch) hits.push(i)
      if (!hits.length) c.warn(`search term not found: ${shortValue(ch)}`)
      if (all) out.push(c.list(hits))
      else if (hits.length) out.push(hits[0])
    }
    return c.list(out)
  }
  if (Array.isArray(match)) {
    const out: Value[] = []
    for (const m of match) {
      const hits: number[] = []
      if (Array.isArray(hay)) {
        c.steps(hay.length / 16)
        for (let i = 0; i < hay.length && hits.length < limit; i++) {
          const e = hay[i]
          // the key column matches, or (at column 0) a vector term matches the whole row
          const k = key(e)
          if ((k !== NONE && equal(k as Value, m)) || (colNum === 0 && Array.isArray(m) && equal(e, m))) hits.push(i)
        }
      }
      if (all) out.push(c.list(hits))
      else out.push(hits.length ? hits[0] : c.list([]))
    }
    return c.list(out)
  }
  return undefined
}
const NONE = Symbol('none')

/** the first character of str(v) ('' for an empty string) */
function firstChar(v: Value): string {
  const t = limitedString(v, false, 8).text
  return t ? String.fromCodePoint(t.codePointAt(0)!) : ''
}

// ───── rands ─────

function rands(c: BuiltinCtx): Value {
  const vals = values(c)
  if (vals.length !== 3 && vals.length !== 4) return countWarn(c)
  const [lo, hi, n, seed] = vals
  if (typeof lo !== 'number' || typeof hi !== 'number' || typeof n !== 'number') return undefined
  if (vals.length === 4 && typeof seed !== 'number') return undefined
  // OpenSCAD takes the count's magnitude: rands(0, 1, -3) gives three numbers
  const count = Math.abs(Math.trunc(n))
  if (!Number.isFinite(count)) return undefined
  c.checkList(count)
  const a = Math.min(lo, hi)
  const b = Math.max(lo, hi)
  // with a seed, a fresh generator per call reproduces OpenSCAD's numbers (for integer seeds)
  const g = typeof seed === 'number' ? new Mt19937(Math.trunc(seed) >>> 0) : null
  const out: number[] = new Array(count)
  for (let i = 0; i < count; i++) out[i] = a + (b - a) * (g ? g.real() : c.random())
  return c.list(out)
}

// ───── type tests and misc ─────

const is = (test: (v: Value) => boolean): BuiltinFn => (c) => {
  if (c.args.length !== 1) return countWarn(c)
  return test(c.eval(c.args[0].expr))
}

export const BUILTIN_FUNCTIONS = new Map<string, BuiltinFn>([
  ['abs', num1(Math.abs)],
  ['sign', num1((x) => (Number.isNaN(x) ? 0 : x > 0 ? 1 : x < 0 ? -1 : 0))],
  ['sin', num1(sinDeg)],
  ['cos', num1(cosDeg)],
  ['tan', num1(tanDeg)],
  ['asin', num1((x) => Math.asin(x) / RAD)],
  ['acos', num1((x) => Math.acos(x) / RAD)],
  ['atan', num1((x) => Math.atan(x) / RAD)],
  ['atan2', num2((y, x) => Math.atan2(y, x) / RAD)],
  ['floor', num1(Math.floor)],
  ['round', num1(cround)],
  ['ceil', num1(Math.ceil)],
  ['ln', num1(Math.log)],
  ['log', (c) => {
    if (c.args.length !== 1 && c.args.length !== 2) return countWarn(c)
    const v = values(c)
    if (!v.every((x) => typeof x === 'number')) return convWarn(c)
    return v.length === 1 ? Math.log10(v[0] as number) : Math.log(v[1] as number) / Math.log(v[0] as number)
  }],
  ['pow', num2(cpow)],
  ['sqrt', num1(Math.sqrt)],
  ['exp', num1(Math.exp)],
  ['min', (c) => minMax(c, true)],
  ['max', (c) => minMax(c, false)],
  ['norm', norm],
  ['cross', cross],
  ['len', len],
  ['concat', concat],
  ['lookup', lookup],
  ['str', str],
  ['chr', chr],
  ['ord', ord],
  ['search', search],
  ['rands', rands],
  ['version', (c) => c.list([2021, 1, 0])],
  ['version_num', () => 20210100],
  ['is_undef', (c) => {
    if (c.args.length !== 1) return countWarn(c)
    const e = c.args[0].expr
    // is_undef(name) of an unknown variable is true without the "unknown variable" warning
    if (e.t === 'var') return c.isUndefVar(e.name)
    return c.eval(e) === undefined
  }],
  ['is_bool', is((v) => typeof v === 'boolean')],
  ['is_num', is((v) => typeof v === 'number' && !Number.isNaN(v))],
  ['is_string', is((v) => typeof v === 'string')],
  ['is_list', is((v) => Array.isArray(v))],
  ['is_function', is((v) => v instanceof ScadFunc)],
  ['parent_module', (c) => {
    // parent_module() is parent_module(1): the module that instantiated the current one
    const v = c.args.length ? c.eval(c.args[0].expr) : 1
    return typeof v === 'number' ? c.parentModule(v) : undefined
  }],
  ['import', (c) => { throw c.error('runtime', 'import() is not supported in 3Dica: OpenSCAD objects cannot read STL, OFF, DXF or SVG files') }],
  ['dxf_dim', (c) => { throw c.error('runtime', 'dxf_dim() is not supported in 3Dica: OpenSCAD objects cannot read DXF files') }],
  ['dxf_cross', (c) => { throw c.error('runtime', 'dxf_cross() is not supported in 3Dica: OpenSCAD objects cannot read DXF files') }],
])
