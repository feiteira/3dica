// The chat's safe Markdown parser (src/ui/chat-markdown.ts): model text → a small tree that the panel builds with
// textContent. Only the pure parser is tested here (vitest runs in node, without a DOM).
import { describe, expect, it } from 'vitest'
import { firstChange, parseInline, parseMarkdown, safeHref, type Inline } from '../../src/ui/chat-markdown'

const text = (v: string): Inline => ({ t: 'text', v })

describe('inline', () => {
  it('bold, italic, strike, code, line breaks', () => {
    expect(parseInline('a **b** *c* ~~d~~ `e` f')).toEqual([
      text('a '), { t: 'strong', c: [text('b')] }, text(' '), { t: 'em', c: [text('c')] }, text(' '),
      { t: 'del', c: [text('d')] }, text(' '), { t: 'code', v: 'e' }, text(' f'),
    ])
    expect(parseInline('one\ntwo')).toEqual([text('one'), { t: 'br' }, text('two')])
    expect(parseInline('__bold__ and _it_')).toEqual([{ t: 'strong', c: [text('bold')] }, text(' and '), { t: 'em', c: [{ t: 'text', v: 'it' }] }])
  })

  it('leaves snake_case, lone stars and unclosed marks alone (a reply that is still streaming)', () => {
    expect(parseInline('make_unique and get_scene')).toEqual([text('make_unique and get_scene')])
    expect(parseInline('2 * 3 * 4')).toEqual([text('2 * 3 * 4')])
    expect(parseInline('**bold so far')).toEqual([text('**bold so far')])
    expect(parseInline('`code so far')).toEqual([text('`code so far')])
  })

  it('code spans are literal: no marks or links inside', () => {
    expect(parseInline('`a *b* [c](https://x.y)`')).toEqual([{ t: 'code', v: 'a *b* [c](https://x.y)' }])
    expect(parseInline('``a ` b``')).toEqual([{ t: 'code', v: 'a ` b' }])
    expect(parseInline('**use `a*b`**')).toEqual([{ t: 'strong', c: [text('use '), { t: 'code', v: 'a*b' }] }])
  })

  it('links: http(s) only; anything else keeps just its text', () => {
    expect(parseInline('see [the docs](https://example.com/a_(b)) now')).toEqual([
      text('see '), { t: 'link', href: 'https://example.com/a_(b)', c: [text('the docs')] }, text(' now'),
    ])
    expect(parseInline('[click](javascript:alert(1))')).toEqual([text('click')])
    expect(parseInline('[x](data:text/html,<b>hi</b>)')).toEqual([text('x')])
    expect(parseInline('[x](/relative)')).toEqual([text('x')])
    expect(parseInline('go to https://example.com/path.')).toEqual([
      text('go to '), { t: 'link', href: 'https://example.com/path', c: [text('https://example.com/path')] }, text('.'),
    ])
    expect(parseInline('(https://example.com)')).toEqual([text('('), { t: 'link', href: 'https://example.com/', c: [text('https://example.com')] }, text(')')])
    expect(parseInline('<https://example.com/x>')).toEqual([{ t: 'link', href: 'https://example.com/x', c: [text('https://example.com/x')] }])
  })

  it('backslash escapes', () => {
    expect(parseInline('\\*not em\\*')).toEqual([text('*not em*')])
  })
})

describe('blocks', () => {
  it('paragraphs and headings', () => {
    expect(parseMarkdown('# Title\n\nfirst\nsecond\n\nthird')).toEqual([
      { t: 'h', level: 1, c: [text('Title')] },
      { t: 'p', c: [text('first'), { t: 'br' }, text('second')] },
      { t: 'p', c: [text('third')] },
    ])
  })

  it('fenced code keeps its text, and an unclosed fence runs to the end', () => {
    expect(parseMarkdown('```js\nconst a = 1 < 2\n**no**\n```\nafter')).toEqual([
      { t: 'code', lang: 'js', v: 'const a = 1 < 2\n**no**' },
      { t: 'p', c: [text('after')] },
    ])
    expect(parseMarkdown('text\n```\nreturn cube()')).toEqual([
      { t: 'p', c: [text('text')] },
      { t: 'code', lang: '', v: 'return cube()' },
    ])
  })

  it('bullet and numbered lists, nested by indentation, interrupting a paragraph', () => {
    expect(parseMarkdown('Did:\n- one\n- two\n  - deeper\n- three')).toEqual([
      { t: 'p', c: [text('Did:')] },
      {
        t: 'list', ordered: false, start: 1, items: [
          [{ t: 'p', c: [text('one')] }],
          [{ t: 'p', c: [text('two')] }, { t: 'list', ordered: false, start: 1, items: [[{ t: 'p', c: [text('deeper')] }]] }],
          [{ t: 'p', c: [text('three')] }],
        ],
      },
    ])
    expect(parseMarkdown('3. c\n4. d')).toEqual([
      { t: 'list', ordered: true, start: 3, items: [[{ t: 'p', c: [text('c')] }], [{ t: 'p', c: [text('d')] }]] },
    ])
    // a number inside a sentence is not a list
    expect(parseMarkdown('3.5 mm thick')).toEqual([{ t: 'p', c: [text('3.5 mm thick')] }])
  })

  it('quotes, rules and tables', () => {
    expect(parseMarkdown('> quoted\n\n---')).toEqual([{ t: 'quote', c: [{ t: 'p', c: [text('quoted')] }] }, { t: 'hr' }])
    expect(parseMarkdown('| Part | Size |\n|:--|--:|\n| Plate | **40** mm |\n| Bolt |')).toEqual([{
      t: 'table', align: ['left', 'right'],
      head: [[text('Part')], [text('Size')]],
      rows: [[[text('Plate')], [{ t: 'strong', c: [text('40')] }, text(' mm')]], [[text('Bolt')], []]],
    }])
  })

  it('never produces raw HTML: tags are plain text', () => {
    const tree = parseMarkdown('<img src=x onerror=alert(1)> <script>alert(1)</script>')
    expect(tree).toEqual([{ t: 'p', c: [text('<img src=x onerror=alert(1)> <script>alert(1)</script>')] }])
  })
})

describe('incremental rendering', () => {
  it('while a reply streams, the blocks before the last one keep their signature (their DOM nodes are kept)', () => {
    const sigs = (s: string) => parseMarkdown(s).map((b) => JSON.stringify(b))
    const a = sigs('Intro.\n\n```js\nreturn cube()\n```\n\nThen')
    const b = sigs('Intro.\n\n```js\nreturn cube()\n```\n\nThen more text')
    expect(firstChange(a, b)).toBe(2) // the intro and the finished code block stay
    expect(firstChange(b, b)).toBe(3)
    expect(firstChange([], b)).toBe(0)
    // an unclosed fence that grows changes from that block on
    expect(firstChange(sigs('x\n\n```\nab'), sigs('x\n\n```\nabc'))).toBe(1)
  })
})

describe('safeHref', () => {
  it('accepts http(s) only', () => {
    expect(safeHref('https://a.b/c')).toBe('https://a.b/c')
    expect(safeHref('HTTP://a.b')).toBe('http://a.b/')
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('mailto:a@b.c')).toBeNull()
    expect(safeHref('//evil.example')).toBeNull()
  })
})
