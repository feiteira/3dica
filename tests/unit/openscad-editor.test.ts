// The code editor's OpenSCAD mode (src/ui/scad-lang.ts): token styles of the stream language and completion.
import { describe, expect, test } from 'vitest'
import { EditorState } from '@codemirror/state'
import { highlightTree, tagHighlighter, tags as t } from '@lezer/highlight'
import { ensureSyntaxTree } from '@codemirror/language'
import { inCommentOrString, openscad, scadCompletions } from '../../src/ui/scad-lang'

/** [text, class] pairs of the highlighted document */
function tokens(doc: string): [string, string][] {
  const state = EditorState.create({ doc, extensions: openscad() })
  const tree = ensureSyntaxTree(state, doc.length, 5000)!
  const hl = tagHighlighter([
    { tag: t.keyword, class: 'kw' }, { tag: t.string, class: 'str' }, { tag: t.number, class: 'num' }, { tag: t.comment, class: 'com' },
    { tag: t.atom, class: 'atom' }, { tag: t.standard(t.variableName), class: 'builtin' }, { tag: t.special(t.variableName), class: 'dollar' },
    { tag: t.definition(t.variableName), class: 'def' }, { tag: t.variableName, class: 'var' },
  ])
  const out: [string, string][] = []
  highlightTree(tree, hl, (from, to, cls) => out.push([doc.slice(from, to), cls]))
  return out
}

function complete(doc: string, pos = doc.length, explicit = false) {
  const state = EditorState.create({ doc, extensions: openscad() })
  return scadCompletions({
    state, pos, explicit,
    matchBefore(re: RegExp) {
      const line = state.doc.lineAt(pos)
      const text = line.text.slice(0, pos - line.from)
      const m = new RegExp(`(?:${re.source})$`).exec(text)
      return m ? { from: pos - m[0].length, to: pos, text: m[0] } : null
    },
  })
}

describe('OpenSCAD highlighting', () => {
  test('keywords, built-ins, $variables, numbers, strings, comments, definitions and include paths', () => {
    const tk = tokens('include <lib/gear.scad>\nmodule plate(w = 2) cube([w, 1e3, .5], center = true); // c\n$fn = 32; echo("a // b");\n/* x */')
    expect(tk).toEqual(expect.arrayContaining([
      ['include', 'kw'], ['<lib/gear.scad>', 'str'], ['module', 'kw'], ['plate', 'def'], ['w', 'var'], ['2', 'num'], ['cube', 'builtin'],
      ['1e3', 'num'], ['.5', 'num'], ['true', 'atom'], ['// c', 'com'], ['$fn', 'dollar'], ['32', 'num'], ['echo', 'kw'],
      ['"a // b"', 'str'], ['/* x */', 'com'],
    ]))
  })
})

describe('OpenSCAD completion', () => {
  test('built-in modules and functions, special variables and the code\'s own names', () => {
    const r = complete('module bracket() {}\nfunction area(r) = r * r;\nwidth = 3;\ncyl')
    const labels = r!.options.map((o) => o.label)
    expect(labels).toEqual(expect.arrayContaining(['cylinder', 'cube', 'linear_extrude', 'part', 'sqrt', '$fn', 'bracket', 'area', 'width']))
    expect(r!.from).toBe(r!.options.length ? 'module bracket() {}\nfunction area(r) = r * r;\nwidth = 3;\n'.length : 0)
    expect(complete('$f')!.from).toBe(0)
  })

  test('nothing inside comments, strings and include paths', () => {
    expect(complete('// cyl')).toBeNull()
    expect(complete('echo("cyl')).toBeNull()
    expect(complete('/* a\ncyl')).toBeNull()
    expect(complete('include <cy')).toBeNull()
    expect(complete('12')).toBeNull()
    expect(inCommentOrString('echo("a") cy', 12)).toBe(false)
    expect(inCommentOrString('/* x */ cy', 10)).toBe(false)
  })
})
