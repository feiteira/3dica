// Text output exactly as OpenSCAD 2021.01 prints it: numbers with 6 significant digits (1e+6, 0.00001, 1e-6,
// -0 → 0, inf, nan), strings quoted (without escaping) inside lists and in echo, ranges as [b : s : e], and
// function values re-printed from their syntax tree with every binary operation in parentheses.
import type { Arg, Elem, Expr, Param } from './ast'
import { ScadFunc, ScadRange, type Value } from './values'

export function formatNumber(x: number): string {
  if (Number.isNaN(x)) return 'nan'
  if (x === Infinity) return 'inf'
  if (x === -Infinity) return '-inf'
  if (x === 0) return '0'
  const [m, e] = x.toExponential(5).split('e')
  const exp = Number(e)
  if (exp < -5 || exp >= 6) {
    const mant = m.includes('.') ? m.replace(/0+$/, '').replace(/\.$/, '') : m
    return `${mant}e${exp < 0 ? '-' : '+'}${Math.abs(exp)}`
  }
  // fixed notation with the same 6 significant digits
  const neg = m.startsWith('-')
  const digits = m.replace('-', '').replace('.', '')
  let s: string
  if (exp >= 0) {
    const int = digits.slice(0, exp + 1)
    const frac = digits.slice(exp + 1).replace(/0+$/, '')
    s = frac ? `${int}.${frac}` : int
  } else {
    s = `0.${'0'.repeat(-exp - 1)}${digits.replace(/0+$/, '')}`
  }
  return neg ? `-${s}` : s
}

/** A value as str() prints it (strings bare at the top level, quoted inside lists). */
export function valueToString(v: Value, quoteStrings = false): string {
  return limitedString(v, quoteStrings, Infinity).text
}

/** A value as echo() prints it: strings quoted. */
export const echoValue = (v: Value): string => valueToString(v, true)

/** Longest value or source text quoted in a warning or error. A list that holds one long string many times is cheap
 *  for the interpreter's budget but megabytes as text, and warnings go to the page, the Output panel and the AI chat. */
export const MAX_QUOTED = 1000

/** A value for a warning or error text: as echo() prints it, but at most about `max` characters. */
export function shortValue(v: Value, max = MAX_QUOTED): string {
  const r = limitedString(v, true, max)
  return r.cut ? r.text + ' …' : r.text
}

/** Source text (an expression printed back) for a warning or error text, at most about `max` characters. */
export const shortText = (s: string, max = MAX_QUOTED): string => (s.length > max ? s.slice(0, max) + ' …' : s)

class TooLong { }

/**
 * The text of a value, but at most about `max` characters: a huge list stops being written as soon as it is too
 * long (`cut` tells), so a debug echo of a large value cannot exhaust memory.
 */
export function limitedString(v: Value, quoteStrings: boolean, max: number): { text: string; cut: boolean } {
  const parts: string[] = []
  let len = 0
  const add = (s: string) => {
    parts.push(s)
    len += s.length
    if (len > max) throw new TooLong()
  }
  const write = (x: Value, quote: boolean) => {
    if (x === undefined) return add('undef')
    switch (typeof x) {
      case 'boolean': return add(x ? 'true' : 'false')
      case 'number': return add(formatNumber(x))
      case 'string': return add(quote ? `"${x}"` : x)
    }
    if (Array.isArray(x)) {
      add('[')
      for (let i = 0; i < x.length; i++) {
        if (i) add(', ')
        write(x[i], true)
      }
      return add(']')
    }
    if (x instanceof ScadRange) return add(`[${formatNumber(x.begin)} : ${formatNumber(x.step)} : ${formatNumber(x.end)}]`)
    add(funcToString(x as ScadFunc))
  }
  try {
    write(v, quoteStrings)
    return { text: parts.join(''), cut: false }
  } catch (e) {
    if (!(e instanceof TooLong)) throw e
    return { text: parts.join('').slice(0, max), cut: true }
  }
}

// ───── the syntax-tree printer (function values and assert messages) ─────

const escapeStr = (s: string) => '"' + s.replace(/[\\"\n\t\r]/g, (c) => c === '\n' ? '\\n' : c === '\t' ? '\\t' : c === '\r' ? '\\r' : '\\' + c) + '"'

function argsToString(args: Arg[]): string {
  return args.map((a) => a.name ? `${a.name} = ${exprToString(a.expr)}` : exprToString(a.expr)).join(', ')
}

export function paramsToString(params: Param[]): string {
  return params.map((p) => p.def ? `${p.name} = ${exprToString(p.def)}` : p.name).join(', ')
}

export function funcToString(f: ScadFunc): string {
  return `function(${paramsToString(f.params)}) ${exprToString(f.body)}`
}

/** Comprehension parts as OpenSCAD prints them: for / if / each bodies in parentheses, let and C-style for bodies bare. */
function elemToString(e: Elem): string {
  switch (e.t) {
    case 'lc-for': {
      // several loop variables are nested loops
      const [first, ...rest] = e.args
      const body: Elem = rest.length ? { t: 'lc-for', args: rest, body: e.body, pos: e.pos } : e.body
      return `for(${first ? argsToString([first]) : ''}) (${elemToString(body)})`
    }
    case 'lc-cfor':
      return `for(${argsToString(e.init)};${exprToString(e.cond)};${argsToString(e.update)}) ${elemToString(e.body)}`
    case 'lc-if':
      return `if(${exprToString(e.cond)}) (${elemToString(e.then)})${e.else ? ` else (${elemToString(e.else)})` : ''}`
    case 'lc-let':
      return `let(${argsToString(e.args)}) ${elemToString(e.body)}`
    case 'lc-each':
      return `each (${elemToString(e.body)})`
    default:
      return exprToString(e)
  }
}

export function exprToString(e: Expr): string {
  switch (e.t) {
    case 'num': return formatNumber(e.v)
    case 'str': return escapeStr(e.v)
    case 'bool': return e.v ? 'true' : 'false'
    case 'undef': return 'undef'
    case 'var': return e.name
    case 'list': return `[${e.items.map((i) => elemToString(i)).join(', ')}]`
    case 'range': return e.step ? `[${exprToString(e.begin)} : ${exprToString(e.step)} : ${exprToString(e.end)}]` : `[${exprToString(e.begin)} : ${exprToString(e.end)}]`
    case 'unary': return `${e.op}${exprToString(e.e)}`
    case 'binary': return `(${exprToString(e.l)} ${e.op} ${exprToString(e.r)})`
    case 'ternary': return `(${exprToString(e.c)} ? ${exprToString(e.a)} : ${exprToString(e.b)})`
    case 'index': return `${exprToString(e.e)}[${exprToString(e.i)}]`
    case 'member': return `${exprToString(e.e)}.${e.name}`
    case 'call': {
      const callee = exprToString(e.callee)
      return `${e.callee.t === 'var' ? callee : `(${callee})`}(${argsToString(e.args)})`
    }
    case 'func': return `function(${paramsToString(e.params)}) ${exprToString(e.body)}`
    case 'let': return `let(${argsToString(e.args)}) ${exprToString(e.body)}`
    case 'assert':
    case 'echo': return `${e.t}(${argsToString(e.args)})${e.body ? ` ${exprToString(e.body)}` : ''}`
  }
}
