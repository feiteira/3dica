// §4.10 code editor: CodeMirror 6 (basicSetup + javascript() + lintGutter()) with a dark theme; OpenSCAD objects get
// the OpenSCAD mode (ui/scad-lang.ts) instead of javascript() and an Output panel (their ECHO / WARNING lines).
// - switching defs: view.setState(EditorState.create(...)) → fresh history
// - commit: updateListener debounces 400 ms, then commands.setCode (coalesce 'code:' + defId, window 2000)
// - Ctrl+Enter commits now and re-runs (commands.runCode(defId))
// - external changes (undo, rename): reload when the store's code differs and no debounce is pending
// - diagnostics from the def's EvalError (line → doc.line(n); syntax errors → first lezer error node)
// - status line "✓ 18 ms · 4,382 triangles" or the error message
import { basicSetup, EditorView } from 'codemirror'
import { EditorState, Prec, type Extension } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { javascript } from '@codemirror/lang-javascript'
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint'
import { ensureSyntaxTree, HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import type { AppContext, ConsoleLine, EvalError, RenderState } from '../app/context'
import type { CodeDef, Id } from '../core/types'
import { defRefSites } from '../core/graph'
import { scadIncludeLine } from '../core/scad'
import { h, setChildren, setText } from './dom'
import { icon } from './icons'
import { openscad } from './scad-lang'

export const CODE_DEBOUNCE_MS = 400

export interface CodeStatus {
  kind: 'ok' | 'warn' | 'pending' | 'error' | 'idle' | 'paused'
  text: string
}

const darkTheme = EditorView.theme({
  '&': { height: '100%', color: '#d6dbe1', backgroundColor: 'var(--code-bg, #15181c)', fontSize: '12.5px' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: '#e6edf3', padding: '6px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#e6edf3' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: '#264f78' },
  '.cm-gutters': { backgroundColor: 'var(--code-gutter, #181b20)', color: '#58616b', border: 'none', borderRight: '1px solid #262b31' },
  '.cm-activeLineGutter': { backgroundColor: '#1f252c', color: '#9aa4b2' },
  '.cm-activeLine': { backgroundColor: '#1b2027' },
  '.cm-matchingBracket, .cm-nonmatchingBracket': { backgroundColor: '#2c3a4a', outline: '1px solid #43546a' },
  '.cm-searchMatch': { backgroundColor: '#5a4a1a', outline: '1px solid #8a6d1f' },
  '.cm-selectionMatch': { backgroundColor: '#2a3542' },
  '.cm-foldPlaceholder': { backgroundColor: '#2a3038', border: 'none', color: '#9aa4b2' },
  '.cm-tooltip': { backgroundColor: '#22272e', border: '1px solid #3a424d', color: '#d6dbe1' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: '#264f78', color: '#fff' },
  '.cm-panels': { backgroundColor: '#1b1f24', color: '#d6dbe1' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid #2d333b' },
  '.cm-textfield': { backgroundColor: '#111418', border: '1px solid #3a424d', color: '#d6dbe1' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: '#2a3038', border: '1px solid #3a424d', color: '#d6dbe1' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy #f85149', textUnderlineOffset: '3px' },
  '.cm-diagnostic-error': { borderLeft: '4px solid #f85149' },
  '.cm-tooltip-lint': { maxWidth: '360px' },
}, { dark: true })

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.operatorKeyword], color: '#ff7b72' },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: '#d6dbe1' },
  { tag: [t.propertyName], color: '#79c0ff' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: '#d2a8ff' },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: '#ffa657' },
  { tag: [t.definition(t.name), t.separator], color: '#e6edf3' },
  { tag: [t.typeName, t.className, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: '#ffa657' },
  { tag: [t.number, t.bool, t.atom, t.null, t.special(t.variableName)], color: '#79c0ff' },
  { tag: [t.operator, t.url, t.escape, t.regexp, t.special(t.string)], color: '#ff9b8f' },
  { tag: [t.meta, t.comment, t.lineComment, t.blockComment], color: '#7d8590', fontStyle: 'italic' },
  { tag: [t.string, t.processingInstruction, t.inserted], color: '#a5d6ff' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.invalid, color: '#f85149' },
])

/** Position of the first lezer error node, or null. */
function firstErrorPos(state: EditorState): number | null {
  const tree = ensureSyntaxTree(state, state.doc.length, 250) ?? syntaxTree(state)
  let pos = -1
  tree.iterate({
    enter: (n) => {
      if (pos >= 0) return false
      if (n.type.isError) { pos = n.from; return false }
      return undefined
    },
  })
  return pos >= 0 ? pos : null
}

/** The line of the innermost call made in the object's own code, from the OpenSCAD trace ('called by foo() at line 3';
 *  a frame in an attached file ends 'of lib/gear.scad'), or null. */
function ownCallLine(lines: ConsoleLine[] | undefined): number | null {
  let found: number | null = null
  for (const l of lines ?? []) {
    const m = l.level === 'trace' ? / at line (\d+)$/.exec(l.text) : null
    if (m) found = Number(m[1])
  }
  return found
}

/** code as the editor holds it: CodeMirror keeps \n line ends whatever the text had (old projects, MCP or AI input) */
const editorText = (code: string): string => (code.includes('\r') ? code.replace(/\r\n?/g, '\n') : code)

type Lang = 'jscad' | 'openscad'
const langOf = (def: CodeDef): Lang => (def.lang === 'openscad' ? 'openscad' : 'jscad')

const OUT_TAG: Record<ConsoleLine['level'], string> = { echo: 'ECHO:', warning: 'WARNING:', error: 'ERROR:', trace: 'TRACE:' }

export class CodeEditor {
  readonly root: HTMLElement
  private readonly ctx: AppContext
  private readonly view: EditorView
  private readonly titleEl: HTMLElement
  private readonly titleText: HTMLElement
  private headIcon: SVGSVGElement
  private readonly statusEl: HTMLElement
  private readonly outEl: HTMLElement
  private readonly outLines: HTMLElement
  private readonly outCount: HTMLElement
  private readonly common: Extension[]
  private readonly perLang: Record<Lang, Extension[]>
  private defId: Id | null = null
  private lang: Lang = 'jscad'
  private timer: ReturnType<typeof setTimeout> | null = null
  private diagSig = ''
  private outSig = ''

  constructor(root: HTMLElement, ctx: AppContext) {
    this.root = root
    this.ctx = ctx
    root.classList.add('insp-code')
    this.titleEl = h('span', { class: 'code-def' })
    this.titleText = h('span', { class: 'code-title', 'data-testid': 'code-title' }, 'Code')
    this.headIcon = icon('code')
    const run = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'data-testid': 'code-run', title: 'Commit and re-run now (Ctrl+Enter). Edits also run automatically 0.4 s after you stop typing.' },
      icon('play'), 'Run')
    run.addEventListener('click', () => { this.runNow(); run.blur() })
    const host = h('div', { class: 'code-host', 'data-testid': 'code-editor' })
    this.statusEl = h('div', { class: 'code-status', 'data-testid': 'code-status', 'aria-live': 'polite' })
    this.outCount = h('span', { class: 'muted small' })
    this.outLines = h('div', { class: 'out-lines', role: 'log', 'aria-label': 'OpenSCAD output' })
    this.outEl = h('div', { class: 'scad-out', 'data-testid': 'scad-output', hidden: true },
      h('div', { class: 'out-head' }, h('span', { class: 'code-title' }, 'Output'), this.outCount), this.outLines)
    this.outLines.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-line]')
      if (b) this.goToLine(Number(b.dataset.line), Number(b.dataset.col || 1))
    })
    root.append(h('div', { class: 'code-head' }, this.headIcon, this.titleText, this.titleEl, h('span', { class: 'spacer' }),
      h('span', { class: 'code-hint' }, 'Ctrl+Enter'), run), host, this.statusEl, this.outEl)

    this.common = [
      Prec.highest(keymap.of([
        { key: 'Mod-Enter', run: () => { this.runNow(); return true }, preventDefault: true },
        // §4.13 Esc blurs the editor (CodeMirror would otherwise swallow the first Esc for its tab-focus mode).
        // An open completion list or search panel still gets the Esc first.
        { key: 'Escape', run: (v) => {
          if (v.dom.querySelector('.cm-tooltip-autocomplete, .cm-search')) return false
          v.contentDOM.blur()
          return true
        } },
      ])),
      basicSetup,
      lintGutter(),
      darkTheme,
      // the inspector is 400 px wide: wrap long lines instead of hiding most of them behind a horizontal scroll
      EditorView.lineWrapping,
      syntaxHighlighting(highlight),
      // files dropped on the editor are imported / opened by the window's drop handler (the event still bubbles up
      // to it), never pasted into the code: CodeMirror's own drop handler would insert their text
      EditorView.domEventHandlers({ drop: (e) => (e.dataTransfer?.files?.length ?? 0) > 0 }),
      EditorView.updateListener.of((u) => { if (u.docChanged) this.schedule() }),
    ]
    this.perLang = {
      jscad: [...this.common, javascript(), EditorView.contentAttributes.of({ 'aria-label': 'Object code' })],
      openscad: [...this.common, openscad(), EditorView.contentAttributes.of({ 'aria-label': 'OpenSCAD code' })],
    }
    this.view = new EditorView({ state: EditorState.create({ doc: '', extensions: this.perLang.jscad }), parent: host })

    ctx.on('flushCode', () => this.flush())
    ctx.on('codeChanged', ({ defIds }) => {
      if (this.defId && defIds.includes(this.defId) && this.timer === null) this.reloadFromStore()
    })
    // a project replaced wholesale (New / Sample / Open): a pending edit belongs to the old project
    ctx.store.subscribe((ch) => { if (ch.source === 'reset') this.cancelPending() })
  }

  /** The def currently shown (null when hidden). */
  get currentDef(): Id | null { return this.defId }

  /**
   * Called on every render with the code def to show (null hides the editor), its status line and, for an OpenSCAD
   * object, the console lines of the result shown (null hides the Output panel).
   */
  update(rs: RenderState, defId: Id | null, status: CodeStatus | null, output: ConsoleLine[] | null = null): void {
    const def = defId ? rs.project.defs[defId] : undefined
    if (!def || def.kind !== 'code') {
      this.flush()
      this.defId = null
      this.root.hidden = true
      return
    }
    this.root.hidden = false
    const lang = langOf(def)
    if (def.id !== this.defId) {
      this.flush() // the previous def's pending text goes to the previous def
      this.defId = def.id
      this.lang = lang
      this.load(def.code, false)
    } else if (lang !== this.lang) {
      this.lang = lang
      this.load(def.code, true)
    } else if (this.timer === null && this.view.state.doc.toString() !== editorText(def.code)) {
      this.load(def.code, true) // external change: undo / redo / rename rewrote part() / a parameter default
    }
    setText(this.titleEl, def.name)
    if (this.titleText.textContent !== (lang === 'openscad' ? 'OpenSCAD' : 'Code')) {
      setText(this.titleText, lang === 'openscad' ? 'OpenSCAD' : 'Code')
      const next = icon(lang === 'openscad' ? 'scad' : 'code')
      this.headIcon.replaceWith(next)
      this.headIcon = next
    }
    if (status) {
      setText(this.statusEl, status.text)
      this.statusEl.dataset.kind = status.kind
    }
    this.root.classList.toggle('is-scad', lang === 'openscad')
    this.updateOutput(lang === 'openscad' ? output ?? [] : null)
    this.updateDiagnostics(rs)
  }

  /** Put the cursor at the start of `line` (1-based; col too) in view, and focus the editor (Output line links). */
  goToLine(line: number, col = 1): void {
    const doc = this.view.state.doc
    if (!Number.isFinite(line) || line < 1) return
    const ln = doc.line(Math.min(Math.floor(line), doc.lines))
    const pos = ln.from + Math.min(Math.max(0, Math.floor(col) - 1), ln.length)
    this.view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
    this.view.focus()
  }

  private updateOutput(lines: ConsoleLine[] | null): void {
    if (lines === null) {
      this.outEl.hidden = true
      this.outSig = ''
      return
    }
    this.outEl.hidden = false
    const sig = JSON.stringify(lines)
    if (sig === this.outSig) return
    this.outSig = sig
    const n = lines.length
    setText(this.outCount, n ? `${n} ${n === 1 ? 'line' : 'lines'}` : '')
    if (!lines.length) {
      setChildren(this.outLines, h('div', { class: 'out-empty muted' }, 'No output. echo() lines and warnings show here.'))
      return
    }
    setChildren(this.outLines, lines.map((l) => {
      const where = l.line === undefined ? null
        : l.file === undefined
          ? h('button', { type: 'button', class: 'out-loc link', 'data-line': l.line, 'data-col': l.col ?? 1, title: `Go to line ${l.line}` }, `line ${l.line}`)
          : h('span', { class: 'out-loc muted', title: 'In an attached file' }, `${l.file}:${l.line}`)
      return h('div', { class: `out-line out-${l.level}`, 'data-testid': 'scad-output-line', 'data-level': l.level },
        h('span', { class: 'out-tag' }, OUT_TAG[l.level]), ' ', h('span', { class: 'out-text' }, l.text), where ? ' ' : null, where)
    }))
    this.outLines.scrollTop = this.outLines.scrollHeight
  }

  /** Commit the pending debounced text now (no-op when nothing is pending). */
  flush(): void {
    if (this.timer !== null) this.commit()
  }

  focus(): void { this.view.focus() }

  private runNow() {
    this.commit()
    if (this.defId) this.ctx.commands.runCode(this.defId)
  }

  private schedule() {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.commit(), CODE_DEBOUNCE_MS)
  }

  private cancelPending() {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private commit() {
    this.cancelPending()
    const id = this.defId
    if (!id) return
    const def = this.ctx.store.project.defs[id]
    const text = this.view.state.doc.toString()
    if (def?.kind === 'code' && editorText(def.code) !== text) this.ctx.commands.setCode(id, text)
  }

  private reloadFromStore() {
    const def = this.defId ? this.ctx.store.project.defs[this.defId] : undefined
    if (def?.kind === 'code' && editorText(def.code) !== this.view.state.doc.toString()) this.load(def.code, true)
  }

  private load(doc: string, keepCursor: boolean) {
    const head = keepCursor ? Math.min(this.view.state.selection.main.head, doc.length) : 0
    const scroll = keepCursor ? this.view.scrollDOM.scrollTop : 0
    this.view.setState(EditorState.create({ doc, extensions: this.perLang[this.lang], selection: { anchor: head } }))
    this.diagSig = ''
    if (scroll) this.view.scrollDOM.scrollTop = scroll
    if (!keepCursor) this.view.scrollDOM.scrollLeft = 0
  }

  private updateDiagnostics(rs: RenderState) {
    const id = this.defId
    if (!id) return
    const st = rs.defStates.get(id)
    const e = st?.status === 'error' ? st.error : undefined
    const sig = e ? JSON.stringify([e.kind, e.def, e.message, e.line ?? 0, e.col ?? 0, e.trace]) : ''
    if (sig === this.diagSig) return
    this.diagSig = sig
    const diags: Diagnostic[] = e ? [this.toDiagnostic(e)] : []
    this.view.dispatch(setDiagnostics(this.view.state, diags))
  }

  private toDiagnostic(e: EvalError): Diagnostic {
    const state = this.view.state
    const doc = state.doc
    const lineNo = (n: number) => doc.line(Math.min(Math.max(1, Math.floor(n)), doc.lines))
    let from: number
    let to: number
    if (e.line) {
      const ln = lineNo(e.line)
      from = ln.from + (e.col ? Math.min(Math.max(0, e.col - 1), ln.length) : 0)
      to = ln.to
      if (from >= to) from = ln.from
    } else if (e.kind === 'syntax') {
      const pos = firstErrorPos(state)
      const ln = doc.lineAt(pos ?? 0)
      from = pos ?? ln.from
      to = Math.max(ln.to, from)
    } else {
      const def = this.defId ? this.ctx.store.project.defs[this.defId] : undefined
      const code = def?.kind === 'code' ? def : undefined
      // OpenSCAD: an error inside an attached file ('lib/gear.scad:12: …') points at the innermost call made in the
      // object's own code (the line to change: foo(3) calling into the library), or at the use / include bringing
      // the file in when it failed while being read
      const inFile = code?.lang === 'openscad' && e.def === code.id ? /^([^:\n]+):\d+: /.exec(e.message) : null
      const incLine = inFile && code ? ownCallLine(e.console) ?? scadIncludeLine(doc.toString(), code.files, inFile[1]) : null
      // a dependency / cycle without a line: point at the part() call naming the next def in the trace
      const next = e.trace[1]
      const sites = code ? defRefSites({ ...code, code: doc.toString() }) : []
      const site = next ? sites.find((s) => s.name === next) : undefined
      const ln = lineNo(incLine ?? site?.line ?? 1)
      from = ln.from
      to = ln.to
    }
    let message = e.message
    if (e.def !== this.defId) message = `in '${e.defName}': ${e.message}`
    return { from, to, severity: 'error', message, source: e.kind }
  }
}
