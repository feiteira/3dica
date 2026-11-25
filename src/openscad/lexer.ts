// The OpenSCAD tokenizer. Shared by the parser (worker) and the Customizer reader (main thread), so it stays small
// and imports nothing heavy. Rules follow OpenSCAD 2021.01 as observed with the binary:
//   - identifiers are `$?[A-Za-z0-9_]+`; when a word could be a number or an identifier the longer match wins and a
//     tie is a number, so `2D` and `1e5x` are identifiers while `1e5` and `12` are numbers
//   - numbers: `12`, `1.5`, `.5`, `5.`, `1e-3`; no hex
//   - strings: \n \t \r \" \\ \' escapes, \xHH (first digit 0-7), \uHHHH, \UHHHHHH; any other `\c` gives `c`;
//     a raw line break inside a string is dropped
//   - `use <path>` / `include <path>` are single tokens (the path may contain spaces and /)
import { ScadError } from './types'

export type TokType = 'num' | 'str' | 'id' | 'kw' | 'op' | 'use' | 'include' | 'comment' | 'eof'

export interface Token {
  type: TokType
  /** identifier/keyword/operator text, string contents, use/include path, comment text (without the markers) */
  text: string
  /** the number, for 'num' */
  num: number
  line: number
  col: number
  /** UTF-16 offsets into the source: [start, end) */
  start: number
  end: number
  /** for comments: true for `/* … *\/` */
  block?: boolean
}

export const KEYWORDS = new Set(['module', 'function', 'if', 'else', 'for', 'let', 'assert', 'echo', 'each', 'true', 'false', 'undef'])

// two-character operators win over their first character ('<=' over '<')
const TWO_OPS = new Set(['<=', '>=', '==', '!=', '&&', '||'])

const NUM_RE = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y
const ID_RE = /\$?[A-Za-z0-9_]+/y
const FILE_RE = /[ \t\r\n]*<([^>\n]*)>/y
const HEX = /^[0-9a-fA-F]+$/

export interface TokenizeOptions {
  /** keep comment tokens (the Customizer reads them); the parser does not want them */
  comments?: boolean
  /** the file name for error positions ('' = the object's own code) */
  file?: string
  /** more tokens than this is a ScadError('limit'): the syntax tree of a huge file would not fit in memory */
  maxTokens?: number
  /** stop at the first `{` (it is the last token returned, then eof): the Customizer reads no further */
  untilBrace?: boolean
}

/** The parser's token limit: about 6 MB of dense code (a 4 MB polyhedron exported from another program fits). */
export const MAX_TOKENS = 2_000_000

const SINGLE_OPS = new Set('()[]{};,=?:.+-*/%^!#<>')

/** Tokenize `src`. Throws ScadError('syntax') on an unterminated string or comment or an unknown character. */
export function tokenize(src: string, opts: TokenizeOptions = {}): Token[] {
  const file = opts.file ?? ''
  const out: Token[] = []
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0
  let line = 1
  let lineStart = 0
  const n = src.length
  const fail = (msg: string, at: number, l = line, ls = lineStart) => {
    throw new ScadError('syntax', `Parser error: ${msg}`, { file, line: l, col: at - ls + 1 })
  }
  const maxTokens = opts.maxTokens ?? Infinity
  const push = (type: TokType, text: string, start: number, l: number, ls: number, num = 0, block?: boolean) => {
    if (out.length >= maxTokens) {
      throw new ScadError('limit', `The code is too long (more than ${maxTokens.toLocaleString('en-US')} words, numbers and symbols)`, { file, line: l, col: start - ls + 1 })
    }
    const t: Token = { type, text, num, line: l, col: start - ls + 1, start, end: i }
    if (block) t.block = true
    out.push(t)
  }
  while (i < n) {
    const c = src.charCodeAt(i)
    if (c === 10) { i++; line++; lineStart = i; continue }
    if (c === 32 || c === 9 || c === 13 || c === 12 || c === 11) { i++; continue }
    const start = i
    const l0 = line
    const ls0 = lineStart
    if (c === 47 /* / */ && src.charCodeAt(i + 1) === 47) {
      let e = src.indexOf('\n', i)
      if (e < 0) e = n
      i = e
      if (opts.comments) push('comment', src.slice(start + 2, e).replace(/\r$/, ''), start, l0, ls0)
      continue
    }
    if (c === 47 && src.charCodeAt(i + 1) === 42 /* * */) {
      const e = src.indexOf('*/', i + 2)
      if (e < 0) fail('unterminated comment', start)
      for (let k = i; k < e; k++) if (src.charCodeAt(k) === 10) { line++; lineStart = k + 1 }
      i = e + 2
      if (opts.comments) push('comment', src.slice(start + 2, e), start, l0, ls0, 0, true)
      continue
    }
    if (c === 34 /* " */) {
      i++
      let s = ''
      for (;;) {
        if (i >= n) fail('unterminated string', start, l0, ls0)
        // plain characters are copied in runs (one character at a time makes huge strings slow and memory-hungry)
        let k = i
        for (let ch = src.charCodeAt(k); k < n && ch !== 34 && ch !== 92 && ch !== 10 && ch !== 13; ch = src.charCodeAt(++k));
        if (k > i) { s += src.slice(i, k); i = k; continue }
        const d = src[i]
        if (d === '"') { i++; break }
        if (d === '\n') { i++; line++; lineStart = i; continue }
        if (d === '\r') { i++; continue }
        const e = src[i + 1]
        i += 2
        if (e === undefined) fail('unterminated string', start, l0, ls0)
        else if (e === 'n') s += '\n'
        else if (e === 't') s += '\t'
        else if (e === 'r') s += '\r'
        else if (e === 'x' && /[0-7]/.test(src[i] ?? '') && /[0-9a-fA-F]/.test(src[i + 1] ?? '')) {
          const v = parseInt(src.slice(i, i + 2), 16)
          s += v === 0 ? ' ' : String.fromCharCode(v)   // OpenSCAD prints \x00 as a space
          i += 2
        } else if ((e === 'u' || e === 'U') && i + (e === 'u' ? 4 : 6) <= n && HEX.test(src.slice(i, i + (e === 'u' ? 4 : 6)))) {
          // \uHHHH and \UHHHHHH; an impossible code point becomes U+FFFD
          const len = e === 'u' ? 4 : 6
          const v = parseInt(src.slice(i, i + len), 16)
          s += v > 0 && v <= 0x10ffff && !(v >= 0xd800 && v <= 0xdfff) ? String.fromCodePoint(v) : '\ufffd'
          i += len
        } else if (e === '\n') { line++; lineStart = i }
        else s += e
      }
      push('str', s, start, l0, ls0)
      continue
    }
    const isDigit = c >= 48 && c <= 57
    if (isDigit || c === 46 /* . */ || c === 36 /* $ */ || c === 95 || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      NUM_RE.lastIndex = i
      const nm = c === 36 ? null : NUM_RE.exec(src)
      ID_RE.lastIndex = i
      const im = c === 46 ? null : ID_RE.exec(src)
      const nl = nm ? nm[0].length : 0
      const il = im ? im[0].length : 0
      if (nl > 0 && nl >= il) {
        const v = parseFloat(nm![0])
        if (v === Infinity) fail(`number out of range: ${nm![0]}`, start)
        i += nl
        push('num', nm![0], start, l0, ls0, v)
        continue
      }
      if (il > 0) {
        const word = im![0]
        i += il
        if (word === 'use' || word === 'include') {
          FILE_RE.lastIndex = i
          const fm = FILE_RE.exec(src)
          if (fm) {
            for (let k = i; k < FILE_RE.lastIndex; k++) if (src.charCodeAt(k) === 10) { line++; lineStart = k + 1 }
            i = FILE_RE.lastIndex
            push(word, fm[1], start, l0, ls0)
            continue
          }
        }
        push(KEYWORDS.has(word) ? 'kw' : 'id', word, start, l0, ls0)
        continue
      }
    }
    const two = src.slice(i, i + 2)
    const op = TWO_OPS.has(two) ? two : SINGLE_OPS.has(src[i]) ? src[i] : undefined
    if (!op) fail(`invalid character '${src[i]}'`, start)
    i += op!.length
    push('op', op!, start, l0, ls0)
    if (op === '{' && opts.untilBrace) break
  }
  out.push({ type: 'eof', text: '', num: 0, line, col: i - lineStart + 1, start: i, end: i })
  return out
}
