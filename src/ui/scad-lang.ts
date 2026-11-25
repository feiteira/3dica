// The code editor's OpenSCAD mode: a CodeMirror stream language (highlighting of keywords, built-in modules and
// functions, $variables, strings, numbers, comments and use / include paths) and completion of the built-in names
// plus the modules, functions and variables the code defines. The names are OpenSCAD 2021.01's documented
// built-ins (User Manual / cheat sheet), plus 3Dica's part().
import { StreamLanguage, LanguageSupport, type StringStream } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'

const KEYWORDS = ['module', 'function', 'if', 'else', 'for', 'let', 'each', 'assert', 'echo', 'intersection_for', 'include', 'use']
const ATOMS = ['true', 'false', 'undef', 'PI']

/** Built-in modules: [name, signature hint] */
const MODULES: [string, string][] = [
  ['cube', 'cube(size, center = false)'], ['sphere', 'sphere(r | d)'], ['cylinder', 'cylinder(h, r | d, r1, r2, center = false)'],
  ['polyhedron', 'polyhedron(points, faces, convexity)'], ['square', 'square(size, center = false)'], ['circle', 'circle(r | d)'],
  ['polygon', 'polygon(points, paths)'], ['text', 'text(t, size, font, halign, valign, spacing, direction)'],
  ['translate', 'translate([x, y, z])'], ['rotate', 'rotate([x, y, z]) | rotate(a, v)'], ['scale', 'scale([x, y, z])'],
  ['resize', 'resize([x, y, z], auto)'], ['mirror', 'mirror([x, y, z])'], ['multmatrix', 'multmatrix(m)'],
  ['color', 'color("name" | [r, g, b, a], alpha)'], ['offset', 'offset(r | delta, chamfer)'], ['hull', 'hull()'],
  ['minkowski', 'minkowski()'], ['union', 'union()'], ['difference', 'difference()'], ['intersection', 'intersection()'],
  ['linear_extrude', 'linear_extrude(height, center, twist, slices, scale)'], ['rotate_extrude', 'rotate_extrude(angle)'],
  ['projection', 'projection(cut = false)'], ['render', 'render(convexity)'], ['children', 'children(index)'],
  ['import', 'import(file) — not supported in 3Dica'], ['surface', 'surface(file) — not supported in 3Dica'],
  ['part', 'part("Name", param = value) — another 3Dica object'],
]
const FUNCTIONS: [string, string][] = [
  ['abs', 'abs(x)'], ['sign', 'sign(x)'], ['sin', 'sin(degrees)'], ['cos', 'cos(degrees)'], ['tan', 'tan(degrees)'],
  ['asin', 'asin(x)'], ['acos', 'acos(x)'], ['atan', 'atan(x)'], ['atan2', 'atan2(y, x)'], ['floor', 'floor(x)'],
  ['round', 'round(x)'], ['ceil', 'ceil(x)'], ['ln', 'ln(x)'], ['log', 'log(x) | log(b, x)'], ['pow', 'pow(base, exp)'],
  ['sqrt', 'sqrt(x)'], ['exp', 'exp(x)'], ['len', 'len(list | string)'], ['min', 'min(…)'], ['max', 'max(…)'],
  ['norm', 'norm(v)'], ['cross', 'cross(a, b)'], ['concat', 'concat(a, b, …)'], ['lookup', 'lookup(key, table)'],
  ['str', 'str(…)'], ['chr', 'chr(code)'], ['ord', 'ord(char)'], ['search', 'search(match, list, num, index)'],
  ['version', 'version()'], ['version_num', 'version_num()'], ['parent_module', 'parent_module(n)'],
  ['rands', 'rands(min, max, count, seed)'], ['is_undef', 'is_undef(x)'], ['is_bool', 'is_bool(x)'], ['is_num', 'is_num(x)'],
  ['is_string', 'is_string(x)'], ['is_list', 'is_list(x)'], ['is_function', 'is_function(x)'],
]
const SPECIAL_VARS = ['$fn', '$fa', '$fs', '$t', '$children', '$preview', '$vpr', '$vpt', '$vpd', '$vpf', '$parent_modules']

const BUILTIN = new Set([...MODULES.map(([n]) => n), ...FUNCTIONS.map(([n]) => n)])
const KEYWORD = new Set(KEYWORDS)
const ATOM = new Set(ATOMS)

interface ScadState { inBlockComment: boolean; afterDef: boolean; afterUse: boolean }

const parser = {
  name: 'openscad',
  startState: (): ScadState => ({ inBlockComment: false, afterDef: false, afterUse: false }),
  copyState: (s: ScadState): ScadState => ({ ...s }),
  token(stream: StringStream, state: ScadState): string | null {
    if (state.inBlockComment) {
      if (stream.skipTo('*/')) { stream.next(); stream.next(); state.inBlockComment = false } else stream.skipToEnd()
      return 'comment'
    }
    if (stream.eatSpace()) return null
    if (stream.match('//')) { stream.skipToEnd(); return 'comment' }
    if (stream.match('/*')) { state.inBlockComment = true; return 'comment' }
    if (stream.peek() === '"') {
      stream.next()
      let escaped = false
      for (let c = stream.next(); c !== undefined; c = stream.next()) {
        if (c === '"' && !escaped) break
        escaped = !escaped && c === '\\'
      }
      return 'string'
    }
    // use <lib/gear.scad>, include <…>: the keyword, then the path as one string-like token
    if (state.afterUse) {
      state.afterUse = false
      if (stream.match(/^<[^>\n]*>?/)) return 'string'
    }
    if (stream.match(/^(use|include)\b(?=\s*<)/)) { state.afterUse = true; return 'keyword' }
    if (stream.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?![A-Za-z_])/)) return 'number'
    if (stream.match(/^\$[A-Za-z0-9_]+/)) return 'variable-2'
    const w = stream.match(/^[A-Za-z0-9_]+/) as RegExpMatchArray | null
    if (w) {
      const word = w[0]
      if (state.afterDef) { state.afterDef = false; return 'def' }
      if (word === 'module' || word === 'function') { state.afterDef = true; return 'keyword' }
      if (KEYWORD.has(word)) return 'keyword'
      if (ATOM.has(word)) return 'atom'
      if (BUILTIN.has(word)) return 'builtin'
      return 'variable'
    }
    const c = stream.next()
    if (c && '()[]{}'.includes(c)) return 'bracket'
    if (c && ',;'.includes(c)) return 'punctuation'
    return 'operator'
  },
  languageData: {
    commentTokens: { line: '//', block: { open: '/*', close: '*/' } },
    closeBrackets: { brackets: ['(', '[', '{', '"'] },
    indentOnInput: /^\s*[}\]]$/,
  },
}

export const scadLanguage = StreamLanguage.define(parser)

// ───────────────────────────── completion ─────────────────────────────

/** The parts of @codemirror/autocomplete's CompletionContext used here (that package is not a direct dependency). */
interface CompletionContextLike {
  state: EditorState
  pos: number
  explicit: boolean
  matchBefore(re: RegExp): { from: number; to: number; text: string } | null
}
interface Completion { label: string; type: string; detail?: string; boost?: number }

const STATIC_OPTIONS: Completion[] = [
  ...MODULES.map(([label, detail]) => ({ label, type: 'function', detail })),
  ...FUNCTIONS.map(([label, detail]) => ({ label, type: 'function', detail })),
  ...KEYWORDS.map((label) => ({ label, type: 'keyword' })),
  ...ATOMS.map((label) => ({ label, type: 'constant' })),
  ...SPECIAL_VARS.map((label) => ({ label, type: 'variable', detail: 'special variable' })),
]

/** Names the code defines: modules, functions and top-level variables (a light text scan, comments ignored). */
function ownNames(doc: string): Completion[] {
  const text = doc.length > 200_000 ? doc.slice(0, 200_000) : doc
  const clean = text.replace(/\/\*[\s\S]*?(\*\/|$)/g, ' ').replace(/\/\/[^\n]*/g, ' ').replace(/"(?:[^"\\]|\\.)*"/g, '""')
  const out = new Map<string, Completion>()
  for (const m of clean.matchAll(/\bmodule\s+([A-Za-z_][A-Za-z0-9_]*)/g)) out.set(m[1], { label: m[1], type: 'function', detail: 'module', boost: 1 })
  for (const m of clean.matchAll(/\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)/g)) out.set(m[1], { label: m[1], type: 'function', detail: 'function', boost: 1 })
  // blanks only, not \s: with the m flag \s* would run across blank lines from every line start (quadratic on a
  // file with thousands of empty lines, at every typed letter)
  for (const m of clean.matchAll(/^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(?!=)/gm)) if (!out.has(m[1])) out.set(m[1], { label: m[1], type: 'variable', boost: 1 })
  return [...out.values()]
}

/**
 * Is `pos` inside a comment, a string or a use / include path? (Stream-language tokens have no node names to ask, so
 * the text before `pos` is read: the current line, and up to 20,000 characters back for an open block comment.)
 */
export function inCommentOrString(doc: string, pos: number): boolean {
  const back = doc.slice(Math.max(0, pos - 20_000), pos)
  const open = back.lastIndexOf('/*')
  if (open >= 0 && back.indexOf('*/', open + 2) < 0) return true
  const line = back.slice(back.lastIndexOf('\n') + 1)
  let inStr = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue }
    if (c === '"') inStr = true
    else if (c === '/' && line[i + 1] === '/') return true
    else if (c === '<' && /\b(use|include)\s*$/.test(line.slice(0, i)) && !line.includes('>', i)) return true
  }
  return inStr
}

/** The completion source: built-in names and the code's own names, not inside comments or strings. */
export function scadCompletions(context: CompletionContextLike) {
  const word = context.matchBefore(/\$?[A-Za-z_][A-Za-z0-9_]*/)
  if (!word && !context.explicit) return null
  if (word && /^\d/.test(word.text)) return null
  if (inCommentOrString(context.state.doc.toString(), context.pos)) return null
  const own = ownNames(context.state.doc.toString()).filter((o) => !BUILTIN.has(o.label))
  return { from: word ? word.from : context.pos, options: [...own, ...STATIC_OPTIONS], validFor: /^\$?[A-Za-z0-9_]*$/ }
}

/** The editor extension for OpenSCAD code. */
export function openscad(): LanguageSupport {
  return new LanguageSupport(scadLanguage, scadLanguage.data.of({ autocomplete: scadCompletions }))
}
