// Safe, minimal Markdown for the chat transcript. Model text is parsed into a small tree (pure: no DOM, unit-tested)
// and built as DOM nodes with textContent — never innerHTML — so nothing a model writes can become markup, scripts or
// styles. Covered: paragraphs (a single newline stays a line break), headings, **bold**, *italic*, ~~strike~~, `code`,
// fenced code blocks, bullet / numbered lists (nested by indentation), quotes, rules, pipe tables, and links — http(s)
// only, opened in a new tab with rel=noopener. Everything else stays plain text. Unclosed inline marks (common while a
// reply streams) stay literal; an unclosed code fence runs to the end, so streaming code shows as code at once.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong' | 'em' | 'del'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'br' }

export type Align = 'left' | 'right' | 'center' | null

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { t: 'quote'; c: Block[] }
  | { t: 'hr' }
  | { t: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }

// ───────────────────────────── blocks ─────────────────────────────

const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const QUOTE = /^ {0,3}>\s?(.*)$/
const MARKER = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)(.*)$/
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

interface Marker { indent: number; ordered: boolean; num: number; content: number; text: string }

const indentOf = (line: string): number => /^\s*/.exec(line.replace(/\t/g, '    '))![0].length

function marker(line: string): Marker | null {
  const m = MARKER.exec(line.replace(/\t/g, '    '))
  if (!m) return null
  const ordered = /\d/.test(m[2][0])
  const indent = m[1].length
  return { indent, ordered, num: ordered ? parseInt(m[2], 10) : 1, content: indent + m[2].length + Math.max(1, Math.min(m[3].length, 4)), text: m[4] }
}

/** Drop up to `n` leading spaces (tabs count as 4). */
function dedent(line: string, n: number): string {
  const l = line.replace(/\t/g, '    ')
  return l.slice(Math.min(n, indentOf(l)))
}

function splitCells(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

function isTableStart(lines: string[], i: number): boolean {
  const head = lines[i]
  const sep = lines[i + 1]
  if (sep === undefined || !head.includes('|') || !TABLE_SEP.test(sep) || !sep.includes('-')) return false
  return splitCells(head).length === splitCells(sep).length
}

/** Does this line start a block other than a paragraph (so it ends a paragraph or a lazy list continuation)? */
function startsBlock(lines: string[], i: number): boolean {
  const l = lines[i]
  return FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || marker(l) !== null || isTableStart(lines, i)
}

export function parseMarkdown(src: string): Block[] {
  return blocks(src.replace(/\r\n?/g, '\n').split('\n'))
}

function blocks(lines: string[]): Block[] {
  const out: Block[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push({ t: 'p', c: parseInline(para.join('\n')) })
    para = []
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { flush(); i++; continue }
    let m: RegExpExecArray | null
    if ((m = FENCE.exec(line))) {
      flush()
      const [, indent, fence, lang] = m
      const body: string[] = []
      i++
      while (i < lines.length && !new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(lines[i])) body.push(dedent(lines[i++], indent.length))
      i++ // the closing fence (or past the end while it streams)
      out.push({ t: 'code', lang, v: body.join('\n') })
      continue
    }
    if ((m = HEADING.exec(line))) { flush(); out.push({ t: 'h', level: m[1].length, c: parseInline(m[2]) }); i++; continue }
    if (HR.test(line)) { flush(); out.push({ t: 'hr' }); i++; continue }
    if (QUOTE.test(line)) {
      flush()
      const body: string[] = []
      while (i < lines.length && (m = QUOTE.exec(lines[i]))) { body.push(m[1]); i++ }
      out.push({ t: 'quote', c: blocks(body) })
      continue
    }
    if (marker(line)) { flush(); i = list(lines, i, out); continue }
    if (isTableStart(lines, i)) { flush(); i = table(lines, i, out); continue }
    para.push(line.trim())
    i++
  }
  flush()
  return out
}

function list(lines: string[], start: number, out: Block[]): number {
  const first = marker(lines[start])!
  const items: Block[][] = []
  let cur: string[] = []
  let content = first.content
  let i = start
  const sibling = (mk: Marker | null): mk is Marker => !!mk && mk.indent <= first.indent + 1 && mk.ordered === first.ordered
  while (i < lines.length) {
    const line = lines[i]
    const mk = marker(line)
    if (sibling(mk)) {
      if (i > start) items.push(blocks(cur))
      cur = [mk.text]
      content = mk.content
      i++
      continue
    }
    if (!line.trim()) {
      // a blank line ends the list unless the next text is indented under the item or is the next item
      let j = i + 1
      while (j < lines.length && !lines[j].trim()) j++
      if (j < lines.length && (indentOf(lines[j]) > first.indent || sibling(marker(lines[j])))) { cur.push(''); i++; continue }
      break
    }
    if (indentOf(line) > first.indent) { cur.push(dedent(line, content)); i++; continue }
    if (startsBlock(lines, i)) break
    cur.push(line.trim()) // lazy continuation of the item's paragraph
    i++
  }
  items.push(blocks(cur))
  out.push({ t: 'list', ordered: first.ordered, start: first.num, items })
  return i
}

function table(lines: string[], start: number, out: Block[]): number {
  const head = splitCells(lines[start])
  const align: Align[] = splitCells(lines[start + 1]).map((c) => {
    const l = c.startsWith(':'), r = c.endsWith(':')
    return l && r ? 'center' : r ? 'right' : l ? 'left' : null
  })
  const rows: Inline[][][] = []
  let i = start + 2
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
    const cells = splitCells(lines[i])
    rows.push(head.map((_, k) => parseInline(cells[k] ?? '')))
    i++
  }
  out.push({ t: 'table', align, head: head.map((c) => parseInline(c)), rows })
  return i
}

// ───────────────────────────── inline ─────────────────────────────

const PUNCT = /[!-/:-@[-`{-~]/
const WORD = /[\p{L}\p{N}]/u
const SPACE = /\s/

/** An http(s) URL that is safe to open, or null. */
export function safeHref(raw: string): string | null {
  const s = raw.trim().replace(/^<|>$/g, '')
  if (!/^https?:\/\//i.test(s)) return null
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch { return null }
}

/** Index of a closing `delim` at or after `from` that can close an emphasis (not after a space; `_` not inside a word). */
function findClose(s: string, from: number, delim: string): number {
  const single = delim.length === 1
  for (let j = from; j <= s.length - delim.length; j++) {
    if (s[j] === '\\') { j++; continue }
    if (s[j] === '`') {
      // skip a code span: marks inside it do not count
      const run = /^`+/.exec(s.slice(j))![0]
      const end = s.indexOf(run, j + run.length)
      if (end > 0) { j = end + run.length - 1; continue }
    }
    if (s.startsWith(delim, j)) {
      if (single && s[j + 1] === delim) { j++; continue } // part of a double mark
      if (j === from || SPACE.test(s[j - 1])) continue
      if (delim[0] === '_' && WORD.test(s[j + delim.length] ?? '')) continue
      return j
    }
  }
  return -1
}

/** "[text](url)" at i: the end index, text and url; null when it is not one. */
function linkAt(s: string, i: number): { end: number; text: string; url: string } | null {
  let depth = 0
  let j = i
  for (; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue }
    if (s[j] === '[') depth++
    else if (s[j] === ']' && --depth === 0) break
  }
  if (j >= s.length || s[j + 1] !== '(') return null
  let k = j + 2
  let parens = 1
  for (; k < s.length; k++) {
    if (s[k] === '(') parens++
    else if (s[k] === ')' && --parens === 0) break
    else if (s[k] === '\n') return null
  }
  if (k >= s.length) return null
  const target = s.slice(j + 2, k).trim().replace(/\s+("[^"]*"|'[^']*')$/, '')
  return { end: k + 1, text: s.slice(i + 1, j), url: target }
}

export function parseInline(s: string): Inline[] {
  const out: Inline[] = []
  let text = ''
  const pushText = () => { if (text) out.push({ t: 'text', v: text }); text = '' }
  const push = (node: Inline) => { pushText(); out.push(node) }
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    const prev = i > 0 ? s[i - 1] : ' '
    if (ch === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1])) { text += s[i + 1]; i += 2; continue }
    if (ch === '\n') { push({ t: 'br' }); i++; continue }
    if (ch === '`') {
      const run = /^`+/.exec(s.slice(i))![0]
      let end = s.indexOf(run, i + run.length)
      while (end > 0 && s[end + run.length] === '`') end = s.indexOf(run, end + run.length + 1)
      if (end > 0) {
        let v = s.slice(i + run.length, end).replace(/\n/g, ' ')
        if (v.length > 2 && v.startsWith(' ') && v.endsWith(' ') && v.trim()) v = v.slice(1, -1)
        push({ t: 'code', v })
        i = end + run.length
        continue
      }
      text += run
      i += run.length
      continue
    }
    const two = s.slice(i, i + 2)
    if (two === '**' || two === '__' || two === '~~') {
      const opens = !SPACE.test(s[i + 2] ?? ' ') && !(ch === '_' && WORD.test(prev))
      const close = opens ? findClose(s, i + 2, two) : -1
      if (close > 0) {
        push({ t: two === '~~' ? 'del' : 'strong', c: parseInline(s.slice(i + 2, close)) })
        i = close + 2
        continue
      }
      text += two
      i += 2
      continue
    }
    if (ch === '*' || ch === '_') {
      const opens = !SPACE.test(s[i + 1] ?? ' ') && !(ch === '_' && WORD.test(prev))
      const close = opens ? findClose(s, i + 1, ch) : -1
      if (close > 0) {
        push({ t: 'em', c: parseInline(s.slice(i + 1, close)) })
        i = close + 1
        continue
      }
      text += ch
      i++
      continue
    }
    if (ch === '[') {
      const l = linkAt(s, i)
      if (l) {
        const href = safeHref(l.url)
        const label = parseInline(l.text)
        if (href) push({ t: 'link', href, c: label.length ? label : [{ t: 'text', v: href }] })
        else { pushText(); out.push(...label) } // not http(s): the text only
        i = l.end
        continue
      }
    }
    if (ch === '<' && /^<https?:\/\/[^\s<>]+>/i.test(s.slice(i))) {
      const end = s.indexOf('>', i)
      const href = safeHref(s.slice(i + 1, end))
      if (href) { push({ t: 'link', href, c: [{ t: 'text', v: s.slice(i + 1, end) }] }); i = end + 1; continue }
    }
    if ((ch === 'h' || ch === 'H') && !WORD.test(prev) && /^https?:\/\//i.test(s.slice(i, i + 8))) {
      let url = /^[^\s<>`]+/.exec(s.slice(i))![0]
      // trailing punctuation belongs to the sentence; a ')' only when it has no '(' partner in the URL
      for (;;) {
        const last = url[url.length - 1]
        if (/[.,;:!?'"*_~]/.test(last)) url = url.slice(0, -1)
        else if (last === ')' && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1)
        else break
      }
      const href = safeHref(url)
      if (href) { push({ t: 'link', href, c: [{ t: 'text', v: url }] }); i += url.length; continue }
    }
    text += ch
    i++
  }
  pushText()
  return out
}

// ───────────────────────────── DOM ─────────────────────────────

function inlineNodes(nodes: Inline[]): Node[] {
  return nodes.map((n): Node => {
    switch (n.t) {
      case 'text': return document.createTextNode(n.v)
      case 'br': return document.createElement('br')
      case 'code': {
        const c = document.createElement('code')
        c.textContent = n.v
        return c
      }
      case 'link': {
        const a = document.createElement('a')
        a.href = n.href
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
        a.append(...inlineNodes(n.c))
        return a
      }
      default: {
        const el = document.createElement(n.t === 'strong' ? 'strong' : n.t === 'em' ? 'em' : 'del')
        el.append(...inlineNodes(n.c))
        return el
      }
    }
  })
}

function codeBlock(b: Extract<Block, { t: 'code' }>): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'md-code'
  const head = document.createElement('div')
  head.className = 'md-code-head'
  const lang = document.createElement('span')
  lang.textContent = b.lang || 'code'
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'md-copy'
  copy.textContent = 'Copy'
  copy.addEventListener('click', () => {
    void navigator.clipboard?.writeText(b.v).then(() => {
      copy.textContent = 'Copied'
      setTimeout(() => { copy.textContent = 'Copy' }, 1200)
    }, () => { /* no clipboard permission: nothing to do */ })
  })
  head.append(lang, copy)
  const pre = document.createElement('pre')
  const code = document.createElement('code')
  code.textContent = b.v
  pre.append(code)
  wrap.append(head, pre)
  return wrap
}

function blockNode(b: Block): HTMLElement {
  switch (b.t) {
    case 'p': {
      const p = document.createElement('p')
      p.append(...inlineNodes(b.c))
      return p
    }
    case 'h': {
      const el = document.createElement('p')
      el.className = `md-h md-h${Math.min(b.level, 3)}`
      el.append(...inlineNodes(b.c))
      return el
    }
    case 'code': return codeBlock(b)
    case 'list': {
      const el = document.createElement(b.ordered ? 'ol' : 'ul')
      if (b.ordered && b.start !== 1) (el as HTMLOListElement).start = b.start
      for (const item of b.items) {
        const li = document.createElement('li')
        li.append(...item.map(blockNode))
        el.append(li)
      }
      return el
    }
    case 'quote': {
      const q = document.createElement('blockquote')
      q.append(...b.c.map(blockNode))
      return q
    }
    case 'hr': return document.createElement('hr')
    case 'table': {
      const wrap = document.createElement('div')
      wrap.className = 'md-table'
      const t = document.createElement('table')
      const row = (cells: Inline[][], tag: 'th' | 'td') => {
        const tr = document.createElement('tr')
        cells.forEach((c, k) => {
          const cell = document.createElement(tag)
          if (b.align[k]) cell.style.textAlign = b.align[k]!
          cell.append(...inlineNodes(c))
          tr.append(cell)
        })
        return tr
      }
      const thead = document.createElement('thead')
      thead.append(row(b.head, 'th'))
      const tbody = document.createElement('tbody')
      tbody.append(...b.rows.map((r) => row(r, 'td')))
      t.append(thead, tbody)
      wrap.append(t)
      return wrap
    }
  }
}

/** What each element's children were last rendered from: one signature per top-level block. */
const rendered = new WeakMap<HTMLElement, string[]>()

/** The index of the first block that differs (the blocks before it can keep their nodes). */
export function firstChange(prev: readonly string[], next: readonly string[]): number {
  let i = 0
  while (i < prev.length && i < next.length && prev[i] === next[i]) i++
  return i
}

/**
 * Render the Markdown of `src` into `el`. Incremental: while a reply streams, usually only its last block changes, so
 * the blocks before the first change keep their DOM nodes. A finished code block's Copy button, a link or a paragraph
 * the user is selecting is then not replaced between mousedown and mouseup.
 */
export function renderMarkdown(el: HTMLElement, src: string): void {
  const blocks = parseMarkdown(src)
  const sigs = blocks.map((b) => JSON.stringify(b))
  const prev = rendered.get(el)
  // the element's children must still be ours, one per block; otherwise start over
  const keep = prev && el.childElementCount === prev.length && el.childNodes.length === prev.length ? firstChange(prev, sigs) : 0
  while (el.childNodes.length > keep) el.lastChild!.remove()
  el.append(...blocks.slice(keep).map(blockNode))
  rendered.set(el, sigs)
}
