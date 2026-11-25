// A hand-written recursive-descent parser for the OpenSCAD 2021.01 language. Precedence, from loosest to tightest:
//   function-literal / let / assert / echo expressions, ?:, ||, &&, == !=, < <= > >=, + -, * / %, unary ! - +, ^,
//   postfix call / index / member. `^` is right-associative and its right operand may be unary (2^-1).
// Grammar quirks kept from OpenSCAD: call arguments may be separated by several commas but not end with one;
// parameter and list literals may end with commas; unary + disappears from the tree (+x is x).
import type { Arg, BinOp, Elem, Expr, Param, ScadFile, Stmt } from './ast'
import { MAX_TOKENS, tokenize, type Token } from './lexer'
import { ScadError, type SourcePos } from './types'

/** Statements and expressions nested deeper than this are refused (a ScadError instead of a JS stack overflow). */
export const MAX_NESTING = 600

const describe = (t: Token): string =>
  t.type === 'eof' ? 'end of file' : t.type === 'str' ? 'a string' : t.type === 'use' || t.type === 'include' ? `'${t.type}'` : `'${t.text}'`

const EXPR_START_KW = new Set(['true', 'false', 'undef', 'function', 'let', 'assert', 'echo'])

/** binary operators, loosest first; all left-associative (^ is handled with the unary operators) */
const PRECEDENCE = new Map<string, number>([
  ['||', 1], ['&&', 2], ['==', 3], ['!=', 3], ['<', 4], ['<=', 4], ['>', 4], ['>=', 4], ['+', 5], ['-', 5], ['*', 6], ['/', 6], ['%', 6],
])

export function parse(src: string, file = ''): ScadFile {
  const toks = tokenize(src, { file, maxTokens: MAX_TOKENS })
  let p = 0
  let depth = 0
  const peek = (k = 0) => toks[Math.min(p + k, toks.length - 1)]
  const pos = (t: Token): SourcePos => ({ file, line: t.line, col: t.col })
  const is = (text: string, k = 0) => { const t = peek(k); return (t.type === 'op' || t.type === 'kw') && t.text === text }
  const fail = (t: Token, msg?: string): never => {
    throw new ScadError('syntax', `Parser error: ${msg ?? `syntax error, unexpected ${describe(t)}`}`, pos(t))
  }
  const expect = (text: string, what?: string): Token => {
    const t = peek()
    if ((t.type === 'op' || t.type === 'kw') && t.text === text) { p++; return t }
    return fail(t, `syntax error, expected '${text}'${what ? ` ${what}` : ''}, found ${describe(t)}`)
  }
  const enter = () => {
    if (++depth > MAX_NESTING) fail(peek(), `the code is nested too deeply (more than ${MAX_NESTING} levels)`)
  }
  const ident = (): Token => {
    const t = peek()
    if (t.type !== 'id') fail(t)
    p++
    return t
  }

  // ───── statements ─────
  function statements(top: boolean, endOp: string | null): Stmt[] {
    const out: Stmt[] = []
    for (;;) {
      const t = peek()
      if (t.type === 'eof') { if (endOp) fail(t, `syntax error, missing '${endOp}'`); return out }
      if (endOp && is(endOp)) return out
      const s = statement(top)
      if (s) out.push(s)
    }
  }

  function statement(top: boolean): Stmt | null {
    const t = peek()
    if (t.type === 'use') {
      if (!top) fail(t, '`use` is only allowed at the top level of a file')
      p++
      return { t: 'use', path: t.text, pos: pos(t) }
    }
    if (t.type === 'include') { p++; return { t: 'include', path: t.text, pos: pos(t) } }
    if (is(';')) { p++; return null }
    if (is('{')) {
      p++
      enter()
      const body = statements(false, '}')
      depth--
      expect('}')
      return { t: 'block', body, pos: pos(t) }
    }
    if (t.type === 'kw' && t.text === 'module') {
      p++
      const name = ident()
      expect('(')
      const params = paramList()
      expect(')')
      enter()
      const body = childStatement(true)
      depth--
      return { t: 'module', name: name.text, params, body, pos: pos(name) }
    }
    if (t.type === 'kw' && t.text === 'function') {
      p++
      const name = ident()
      expect('(')
      const params = paramList()
      expect(')')
      expect('=')
      const body = expr()
      expect(';')
      return { t: 'function', name: name.text, params, body, pos: pos(name) }
    }
    if (t.type === 'id' && is('=', 1)) {
      p += 2
      const e = expr()
      expect(';')
      return { t: 'assign', name: t.text, expr: e, pos: pos(t) }
    }
    return instantiation()
  }

  /** the statement after a module instantiation, if, else or module header: `;`, `{ … }` or one instantiation */
  function childStatement(defs = false): Stmt[] {
    if (is(';')) { p++; return [] }
    if (is('{')) {
      p++
      const body = statements(false, '}')
      expect('}')
      if (!defs) for (const s of body) if (s.t === 'module' || s.t === 'function') fail(toks[p - 1], `syntax error, a ${s.t} cannot be defined here`)
      return body
    }
    const t = peek()
    if (defs && t.type === 'kw' && (t.text === 'module' || t.text === 'function')) { const s = statement(false); return s ? [s] : [] }
    if (t.type === 'include') { p++; return [{ t: 'include', path: t.text, pos: pos(t) }] }
    return [instantiation()]
  }

  function instantiation(): Stmt {
    let mods = ''
    while (is('!') || is('#') || is('%') || is('*')) { mods += peek().text; p++ }
    const t = peek()
    enter()
    let s: Stmt
    if (t.type === 'kw' && t.text === 'if') {
      p++
      expect('(')
      const cond = expr()
      expect(')')
      const then = childStatement()
      let els: Stmt[] | undefined
      if (is('else')) { p++; els = childStatement() }
      s = { t: 'if', cond, then, else: els, mods, pos: pos(t) }
    } else {
      const named = t.type === 'id' || (t.type === 'kw' && (t.text === 'for' || t.text === 'let' || t.text === 'echo' || t.text === 'assert' || t.text === 'each'))
      if (!named || t.text === 'each') fail(t)
      p++
      expect('(', `after '${t.text}'`)
      const args = argList()
      expect(')')
      const children = childStatement()
      s = { t: 'inst', name: t.text, args, children, mods, pos: pos(t) }
    }
    depth--
    return s
  }

  function paramList(): Param[] {
    const out: Param[] = []
    while (!is(')')) {
      const name = ident()
      let def: Expr | undefined
      if (is('=')) { p++; def = expr() }
      out.push({ name: name.text, def, pos: pos(name) })
      if (!is(',')) break
      while (is(',')) p++
    }
    return out
  }

  function argList(): Arg[] {
    const out: Arg[] = []
    if (is(')')) return out
    for (;;) {
      const t = peek()
      if (t.type === 'id' && is('=', 1)) {
        p += 2
        out.push({ name: t.text, expr: expr(), pos: pos(t) })
      } else out.push({ expr: expr(), pos: pos(t) })
      if (!is(',')) return out
      while (is(',')) p++
    }
  }

  // ───── expressions ─────
  function startsExpr(t: Token): boolean {
    if (t.type === 'num' || t.type === 'str' || t.type === 'id') return true
    if (t.type === 'kw') return EXPR_START_KW.has(t.text)
    return t.type === 'op' && (t.text === '(' || t.text === '[' || t.text === '-' || t.text === '+' || t.text === '!')
  }

  function expr(): Expr {
    enter()
    const t = peek()
    let e: Expr
    if (t.type === 'kw' && t.text === 'function' && is('(', 1)) {
      p += 2
      const params = paramList()
      expect(')')
      e = { t: 'func', params, body: expr(), pos: pos(t) }
    } else if (t.type === 'kw' && t.text === 'let') {
      p++
      expect('(', "after 'let'")
      const args = argList()
      expect(')')
      e = { t: 'let', args, body: expr(), pos: pos(t) }
    } else if (t.type === 'kw' && (t.text === 'assert' || t.text === 'echo')) {
      p++
      expect('(', `after '${t.text}'`)
      const args = argList()
      expect(')')
      const body = startsExpr(peek()) ? expr() : undefined
      e = { t: t.text as 'assert' | 'echo', args, body, pos: pos(t) }
    } else {
      e = binary(1)
      if (is('?')) {
        const q = peek()
        p++
        const a = expr()
        expect(':')
        e = { t: 'ternary', c: e, a, b: expr(), pos: pos(q) }
      }
    }
    depth--
    return e
  }

  /** binary operators by precedence climbing: one JS frame per operand, whatever the number of levels */
  function binary(min: number): Expr {
    let l = unary()
    for (;;) {
      const t = peek()
      const prec = t.type === 'op' ? PRECEDENCE.get(t.text) : undefined
      if (prec === undefined || prec < min) return l
      p++
      l = { t: 'binary', op: t.text as BinOp, l, r: binary(prec + 1), pos: pos(t) }
    }
  }

  function unary(): Expr {
    const t = peek()
    if (t.type === 'op' && (t.text === '-' || t.text === '!' || t.text === '+')) {
      p++
      enter()
      const e = unary()
      depth--
      return t.text === '+' ? e : { t: 'unary', op: t.text as '-' | '!', e, pos: pos(t) }
    }
    const base = postfix()
    if (is('^')) {
      const c = peek()
      p++
      enter()
      const r = unary()
      depth--
      return { t: 'binary', op: '^', l: base, r, pos: pos(c) }
    }
    return base
  }

  function postfix(): Expr {
    let e = primary()
    for (;;) {
      const t = peek()
      if (is('(')) {
        p++
        const args = argList()
        expect(')')
        e = { t: 'call', callee: e, args, pos: e.t === 'var' ? e.pos : pos(t) }
      } else if (is('[')) {
        p++
        const i = expr()
        expect(']')
        e = { t: 'index', e, i, pos: pos(t) }
      } else if (is('.')) {
        p++
        e = { t: 'member', e, name: ident().text, pos: pos(t) }
      } else return e
    }
  }

  function primary(): Expr {
    const t = peek()
    switch (t.type) {
      case 'num': p++; return { t: 'num', v: t.num, pos: pos(t) }
      case 'str': p++; return { t: 'str', v: t.text, pos: pos(t) }
      case 'id': p++; return { t: 'var', name: t.text, pos: pos(t) }
      case 'kw':
        if (t.text === 'true' || t.text === 'false') { p++; return { t: 'bool', v: t.text === 'true', pos: pos(t) } }
        if (t.text === 'undef') { p++; return { t: 'undef', pos: pos(t) } }
        break
      case 'op':
        if (t.text === '(') {
          p++
          const e = expr()
          expect(')')
          return e
        }
        if (t.text === '[') return list()
    }
    return fail(t)
  }

  function list(): Expr {
    const open = peek()
    p++
    enter()
    const items: Elem[] = []
    // [] and [ , , ] are empty lists
    let k = 0
    while (is(',', k)) k++
    if (is(']', k)) { p += k + 1; depth--; return { t: 'list', items, pos: pos(open) } }
    const first = element(false)
    if (is(':')) {
      // a range [begin : end] or [begin : step : end]
      if (first.t.startsWith('lc-')) fail(peek())
      p++
      const second = expr()
      let e: Expr
      if (is(':')) { p++; e = { t: 'range', begin: first as Expr, step: second, end: expr(), pos: pos(open) } }
      else e = { t: 'range', begin: first as Expr, end: second, pos: pos(open) }
      expect(']')
      depth--
      return e
    }
    items.push(first)
    while (is(',')) {
      while (is(',')) p++
      if (is(']')) break
      items.push(element(false))
    }
    expect(']', 'to close the list')
    depth--
    return { t: 'list', items, pos: pos(open) }
  }

  /** a list element: an expression, or for / if / let / each comprehension parts; inside a comprehension the parts
   *  may be in parentheses (OpenSCAD refuses that for a list's own elements) */
  function element(inner = true): Elem {
    const t = peek()
    if (inner && t.type === 'op' && t.text === '(') {
      const n = peek(1)
      if (n.type === 'kw' && (n.text === 'for' || n.text === 'if' || n.text === 'each')) {
        p++
        const e = element()
        expect(')')
        return e
      }
    }
    if (t.type !== 'kw') return expr()
    enter()
    let e: Elem
    switch (t.text) {
      case 'for': {
        p++
        expect('(', "after 'for'")
        const init = argList()
        if (is(';')) {
          p++
          const cond = expr()
          expect(';')
          const update = argList()
          expect(')')
          e = { t: 'lc-cfor', init, cond, update, body: element(), pos: pos(t) }
        } else {
          expect(')')
          e = { t: 'lc-for', args: init, body: element(), pos: pos(t) }
        }
        break
      }
      case 'if': {
        p++
        expect('(', "after 'if'")
        const cond = expr()
        expect(')')
        const then = element()
        let els: Elem | undefined
        if (is('else')) { p++; els = element() }
        e = { t: 'lc-if', cond, then, else: els, pos: pos(t) }
        break
      }
      case 'let': {
        p++
        expect('(', "after 'let'")
        const args = argList()
        expect(')')
        e = { t: 'lc-let', args, body: element(), pos: pos(t) }
        break
      }
      case 'each':
        p++
        e = { t: 'lc-each', body: element(), pos: pos(t) }
        break
      default:
        e = expr()
    }
    depth--
    return e
  }

  const body = statements(true, null)
  return { path: file, body }
}
