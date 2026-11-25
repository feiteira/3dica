// OpenSCAD values and operators. undef is JS undefined, vectors are plain arrays that are never mutated once built.
// Operator results follow OpenSCAD 2021.01 as observed with the binary (see tests/unit/scad-lang*.test.ts):
// a type mismatch gives undef plus a warning at the top level, but silently undef inside element-wise vector math.
import type { Expr, Param } from './ast'

export class ScadRange {
  readonly begin: number
  readonly step: number
  readonly end: number
  constructor(begin: number, step: number, end: number) {
    this.begin = begin
    this.step = step
    this.end = end
  }
}

/** A function value: a function literal (or a named function passed around) with the scope it closes over. */
export class ScadFunc {
  readonly params: Param[]
  readonly body: Expr
  /** the interpreter's scope object; opaque here */
  readonly closure: unknown
  /** the name it was defined with, for traces ('' for literals) */
  readonly name: string
  /** for a function of a used file: that file's scope, which then also leads the $-variable lookup */
  readonly dyn: unknown
  constructor(params: Param[], body: Expr, closure: unknown, name = '', dyn: unknown = null) {
    this.params = params
    this.body = body
    this.closure = closure
    this.name = name
    this.dyn = dyn
  }
}

export type Value = undefined | boolean | number | string | Value[] | ScadRange | ScadFunc

export type TypeName = 'undefined' | 'bool' | 'number' | 'string' | 'vector' | 'range' | 'function'

export function typeName(v: Value): TypeName {
  if (v === undefined) return 'undefined'
  switch (typeof v) {
    case 'boolean': return 'bool'
    case 'number': return 'number'
    case 'string': return 'string'
  }
  if (Array.isArray(v)) return 'vector'
  return v instanceof ScadRange ? 'range' : 'function'
}

const SURROGATE = /[\uD800-\uDFFF]/

/** the characters of a string as OpenSCAD counts them (Unicode code points) */
export function chars(s: string): string[] {
  return SURROGATE.test(s) ? Array.from(s) : s.split('')
}
export function strLength(s: string): number {
  if (!SURROGATE.test(s)) return s.length
  let n = 0
  for (const _ of s) n++
  return n
}

export function truthy(v: Value): boolean {
  if (v === undefined) return false
  switch (typeof v) {
    case 'boolean': return v
    case 'number': return v !== 0
    case 'string': return v.length > 0
  }
  if (Array.isArray(v)) return v.length > 0
  return true
}

export function equal(a: Value, b: Value): boolean {
  if (a === b) return typeof a !== 'number' || !Number.isNaN(a)
  if (typeof a === 'number' || typeof b === 'number') return false   // NaN, or different types
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!equal(a[i], b[i])) return false
    return true
  }
  if (a instanceof ScadRange) return b instanceof ScadRange && a.begin === b.begin && a.step === b.step && a.end === b.end
  return false
}

export type Warn = (msg: string) => void

const undefOp = (warn: Warn | null, a: Value, op: string, b: Value): undefined => {
  if (warn) {
    const ta = typeName(a), tb = typeName(b)
    // OpenSCAD words it differently when both sides are undef or both are functions
    warn(ta === tb && (ta === 'undefined' || ta === 'function') ? `operation undefined (${ta} ${op} ${tb})` : `undefined operation (${ta} ${op} ${tb})`)
  }
  return undefined
}

/** string comparison in code-point order (OpenSCAD compares UTF-8 bytes) */
function cmpStr(a: string, b: string): number {
  if (!SURROGATE.test(a) && !SURROGATE.test(b)) return a < b ? -1 : a > b ? 1 : 0
  const x = Array.from(a, (c) => c.codePointAt(0)!)
  const y = Array.from(b, (c) => c.codePointAt(0)!)
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i]
  return x.length - y.length
}

type Cmp = '<' | '<=' | '>' | '>='
const cmpResult = (c: number, op: Cmp) => op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0

/** <, <=, >, >= */
export function compare(a: Value, b: Value, op: Cmp, warn: Warn | null, ctx = ''): Value {
  if (typeof a === 'number' && typeof b === 'number') return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b
  if (typeof a === 'string' && typeof b === 'string') return cmpResult(cmpStr(a, b), op)
  if (typeof a === 'boolean' && typeof b === 'boolean') return cmpResult(Number(a) - Number(b), op)
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) {
      if (equal(a[i], b[i])) continue
      const r = compare(a[i], b[i], op, null)
      if (r === undefined) {
        if (warn) warn(`undefined operation (${typeName(a[i])} ${op} ${typeName(b[i])})\n\tin vector comparison at index ${i}${ctx}`)
        return undefined
      }
      return r
    }
    return cmpResult(a.length - b.length, op)
  }
  if (a instanceof ScadRange && b instanceof ScadRange) {
    const x = [a.begin, a.step, a.end]
    const y = [b.begin, b.step, b.end]
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return cmpResult(x[i] - y[i], op)
    return cmpResult(0, op)
  }
  return undefOp(warn, a, op, b)
}

/** + and - (element-wise on vectors of equal-or-shorter length) */
export function addSub(a: Value, b: Value, op: '+' | '-', warn: Warn | null): Value {
  if (typeof a === 'number' && typeof b === 'number') return op === '+' ? a + b : a - b
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length)
    const out: Value[] = new Array(n)
    for (let i = 0; i < n; i++) out[i] = addSub(a[i], b[i], op, null)
    return out
  }
  return undefOp(warn, a, op, b)
}

const isNumVec = (v: Value[]) => v.every((x) => typeof x === 'number')
const isMatrix = (v: Value[]) => v.length > 0 && v.every((x) => Array.isArray(x) && x.length > 0)

function scale(v: Value, k: number, left: boolean): Value {
  if (typeof v === 'number') return left ? k * v : v * k
  if (Array.isArray(v)) return v.map((x) => scale(x, k, left))
  return undefined
}

function dot(a: Value[], b: Value[], warn: Warn | null): Value {
  let s = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (typeof x !== 'number' || typeof y !== 'number') return undefOp(warn, x, '*', y)
    s += x * y
  }
  return s
}

export function multiply(a: Value, b: Value, warn: Warn | null): Value {
  if (typeof a === 'number') {
    if (typeof b === 'number') return a * b
    if (Array.isArray(b)) return b.map((x) => scale(x, a, true))
    return undefOp(warn, a, '*', b)
  }
  if (Array.isArray(a)) {
    if (typeof b === 'number') return a.map((x) => scale(x, b, false))
    if (!Array.isArray(b)) return undefOp(warn, a, '*', b)
    if (a.length === 0 || b.length === 0) { if (warn) warn('Multiplication is undefined on empty vectors'); return undefined }
    const aNum = typeof a[0] === 'number'
    const bNum = typeof b[0] === 'number'
    if (aNum && bNum) {
      if (a.length !== b.length) { if (warn) warn(`vector*vector requires matching lengths (${a.length} != ${b.length})`); return undefined }
      return dot(a, b, warn)
    }
    if (aNum && isMatrix(b)) {
      // row vector × matrix
      if (a.length !== b.length) { if (warn) warn(`vector*matrix requires vector length to match matrix row count (${a.length} != ${b.length})`); return undefined }
      const rows = b as Value[][]
      const cols = rows[0].length
      if (!isNumVec(a) || !rows.every((r) => r.length === cols && isNumVec(r))) return undefOp(warn, a, '*', b)
      const out: number[] = new Array(cols).fill(0)
      for (let j = 0; j < cols; j++) for (let i = 0; i < a.length; i++) out[j] += (a[i] as number) * (rows[i][j] as number)
      return out
    }
    if (isMatrix(a) && bNum) {
      // matrix × column vector
      const rows = a as Value[][]
      if (rows[0].length !== b.length) { if (warn) warn(`matrix*vector requires matrix column count to match vector length (${rows[0].length} != ${b.length})`); return undefined }
      const out: Value[] = []
      for (const r of rows) {
        if (r.length !== b.length) return undefOp(warn, a, '*', b)
        const d = dot(r, b, warn)
        if (d === undefined) return undefined
        out.push(d)
      }
      return out
    }
    if (isMatrix(a) && isMatrix(b)) {
      const A = a as Value[][]
      const B = b as Value[][]
      const n = A[0].length
      if (n !== B.length) { if (warn) warn(`matrix*matrix requires left operand column count to match right operand row count (${n} != ${B.length})`); return undefined }
      const cols = B[0].length
      if (!A.every((r) => r.length === n && isNumVec(r)) || !B.every((r) => r.length === cols && isNumVec(r))) return undefOp(warn, a, '*', b)
      return A.map((r) => {
        const out: number[] = new Array(cols).fill(0)
        for (let j = 0; j < cols; j++) for (let k = 0; k < n; k++) out[j] += (r[k] as number) * (B[k][j] as number)
        return out
      })
    }
    return undefOp(warn, a, '*', b)
  }
  return undefOp(warn, a, '*', b)
}

function divEach(v: Value, k: number, numer: boolean): Value {
  if (typeof v === 'number') return numer ? k / v : v / k
  if (Array.isArray(v)) return v.map((x) => divEach(x, k, numer))
  return undefined
}

export function divide(a: Value, b: Value, warn: Warn | null): Value {
  if (typeof a === 'number') {
    if (typeof b === 'number') return a / b
    if (Array.isArray(b)) return b.map((x) => divEach(x, a, true))
  } else if (Array.isArray(a) && typeof b === 'number') return a.map((x) => divEach(x, b, false))
  return undefOp(warn, a, '/', b)
}

export function modulo(a: Value, b: Value, warn: Warn | null): Value {
  if (typeof a === 'number' && typeof b === 'number') return a % b
  return undefOp(warn, a, '%', b)
}

/** C pow(): unlike Math.pow, pow(1, nan) = 1 and pow(-1, ±inf) = 1 */
export function cpow(a: number, b: number): number {
  if (a === 1 || b === 0) return 1
  if (a === -1 && !Number.isFinite(b) && !Number.isNaN(b)) return 1
  return Math.pow(a, b)
}

export function power(a: Value, b: Value, warn: Warn | null): Value {
  if (typeof a === 'number' && typeof b === 'number') return cpow(a, b)
  return undefOp(warn, a, '^', b)
}

function negEach(v: Value): Value {
  if (typeof v === 'number') return -v
  if (Array.isArray(v)) return v.map(negEach)
  return undefined
}

export function negate(a: Value, warn: Warn | null): Value {
  if (typeof a === 'number') return -a
  if (Array.isArray(a)) return a.map(negEach)
  if (warn) warn(`undefined operation (-${typeName(a)})`)
  return undefined
}

const F64 = new Float64Array(1)
const U64 = new BigUint64Array(F64.buffer)
/** the next double above x (x >= 0, finite) */
function nextUp(x: number): number {
  if (x === 0) return Number.MIN_VALUE
  F64[0] = x
  U64[0] += 1n
  return F64[0]
}

/** The number of values of a range, OpenSCAD-style: the quotient (end - begin) / step is moved up by one ulp before
 *  it is truncated, so [0 : 0.1 : 0.3] has 4 values but [1 : 0.05 : 1.4] has 8 (matched against OpenSCAD 2021.01 on
 *  4,023 ranges whose quotient is a hair off a whole number). Infinity when the step is 0 or the count is unbounded. */
export function rangeCount(r: ScadRange): number {
  const { begin, step, end } = r
  if (Number.isNaN(begin) || Number.isNaN(step) || Number.isNaN(end)) return 0
  if (step === 0) return Infinity
  if ((step > 0 && begin > end) || (step < 0 && begin < end)) return 0
  const d = Math.abs((end - begin) / step)
  if (!Number.isFinite(d)) return Infinity
  return Math.trunc(nextUp(d)) + 1
}

export const rangeValue = (r: ScadRange, i: number): number => r.begin + i * r.step
