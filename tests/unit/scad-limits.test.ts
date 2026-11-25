// Hostile and huge inputs fail fast with a ScadError ('limit' or 'runtime') instead of hanging the worker or running
// it out of memory. Where the default limit takes seconds to reach, a lower limit shows the same mechanism.
import { describe, expect, test } from 'vitest'
import { runScad, interpret, extractParams, ScadError, type InterpretOptions, type RunScadOptions } from '../../src/openscad'
import { DEFAULT_LIMITS, MAX_MESSAGES } from '../../src/openscad/interp'
import { MAX_TOKENS, tokenize } from '../../src/openscad/lexer'

/** the engine's geometry budget (src/eval/engine.ts): 2 000 000 polygons per call and per evaluation */
function engineLike(): RunScadOptions {
  let total = 0
  return {
    resolvePart: () => { throw new Error('no parts') },
    charge: (n, what, pos) => {
      if (!(n <= 2_000_000)) throw new ScadError('limit', `Too much geometry: ${what}`, pos)
      total += n
      if (total > 2_000_000) throw new ScadError('limit', 'Too much geometry: more than 2,000,000 polygons', pos)
    },
  }
}

function failure(run: () => unknown): ScadError {
  try { run() } catch (e) { if (e instanceof ScadError) return e; throw e }
  throw new Error('expected a ScadError')
}

const interpFails = (src: string, opts?: InterpretOptions) => failure(() => interpret(src, opts))
const runFails = (src: string) => failure(() => runScad(src, engineLike()))

describe('loops and recursion that never end', () => {
  test('the default step limit', () => {
    expect(DEFAULT_LIMITS.maxSteps).toBe(10_000_000)
  })
  test('tail recursion (a loop, not a stack overflow) stops at the step limit', () => {
    for (const src of [
      'function f(x) = f(x + 1); echo(f(0));',
      'function f(x) = x < 0 ? 0 : f(x + 1); echo(f(0));',
      'function f(x) = g(x + 1); function g(x) = f(x + 1); echo(f(0));',
    ]) {
      const e = interpFails(src, { limits: { maxSteps: 100_000 } })
      expect([e.kind, e.message], src).toEqual(['limit', 'The code ran too long (more than 100,000 function calls and loop rounds) — a loop or recursion that never ends?'])
    }
  })
  test('loops that allocate nothing stop at the step limit', () => {
    for (const src of [
      'x = [for (i = 0; true; i = i + 1) if (false) i];',
      'x = [for (a = [0 : 999]) for (b = [0 : 999]) for (c = [0 : 999]) if (false) 1];',
      'for (a = [0 : 999], b = [0 : 999], c = [0 : 999]) if (a + b + c < 0) cube(1);',
    ]) expect(interpFails(src, { limits: { maxSteps: 100_000 } }).kind, src).toBe('limit')
  })
  test('with the default limits an endless loop stops within seconds', () => {
    const t0 = performance.now()
    expect(interpFails('x = [for (i = 0; true; i = i + 1) if (false) i];').kind).toBe('limit')
    expect(performance.now() - t0).toBeLessThan(15_000)
  }, 20_000)
  test('a huge search() and a huge matrix product count as work', () => {
    expect(interpFails('v = [for (i = [0 : 99999]) i]; echo(len(search(v, v, 0)));', { limits: { maxSteps: 1_000_000 } }).kind).toBe('limit')
    expect(interpFails('m = [for (i = [0 : 299]) [for (j = [0 : 299]) 1]]; x = m * m * m * m;', { limits: { maxSteps: 1_000_000 } }).kind).toBe('limit')
  })
  test('non-tail recursion, of functions and modules, is reported as recursion', () => {
    expect(interpFails('function f(x) = f(x + 1) + 1; echo(f(0));').message).toMatch(/^Recursion too deep calling function 'f' \(/)
    expect(interpFails('module m() m(); m();').message).toMatch(/^Recursion too deep calling module 'm' \(/)
    expect(interpFails('module m() { cube(1); translate([1, 0, 0]) m(); } m();').message).toMatch(/^Recursion too deep calling module 'm' \(/)
  })
})

describe('data that grows without bounds', () => {
  test('exponential lists and strings hit the size limits', () => {
    expect(interpFails('function g(n) = n == 0 ? [1] : concat(g(n - 1), g(n - 1)); echo(len(g(40)));', { limits: { maxTotalElements: 1_000_000 } }).kind).toBe('limit')
    expect(interpFails('function g(n) = n == 0 ? 1 : [g(n - 1), g(n - 1)]; echo(len(g(40)));', { limits: { maxTotalElements: 1_000_000 } }).kind).toBe('limit')
    expect(interpFails('function s(n) = n == 0 ? "x" : str(s(n - 1), s(n - 1)); echo(len(s(40)));', { limits: { maxStringLength: 10_000 } }).message).toBe('String too long (more than 10,000 characters)')
    expect(interpFails('function s(n, a = "x") = n == 0 ? a : s(n - 1, str(a, a)); echo(len(s(60)));').message).toBe('String too long (more than 1,000,000 characters)')
  })
  test('small lists count their overhead: a million pairs is not "two million values"', () => {
    // 600 000 pairs = 1.2 M elements; with the per-list overhead it is past a 3 M budget
    expect(interpFails('x = [for (i = [0 : 599999]) [i, i]];', { limits: { maxTotalElements: 3_000_000 } }).kind).toBe('limit')
  })
  test('geometry nodes count as well: a loop of 900 000 transformed cubes is refused before the build', () => {
    expect(interpFails('for (i = [0 : 900000]) translate([i, 0, 0]) cube(1);').message).toMatch(/^Too much geometry: this code made 1,\d\d\d,\d\d\d shapes and transforms — stopped before/)
  })
  test('a polyhedron with more than a million faces is refused', () => {
    expect(interpFails('f = concat([for (i = [0 : 999998]) [0, 1, 2]], [[0, 1, 3], [1, 2, 3]]); polyhedron([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], f);').message).toBe('List too long (more than 1,000,000 elements)')
  })
  test('a flood of echo() keeps the first lines and says how many more there were', () => {
    const { messages } = interpret('for (i = [0 : 19999]) echo(i);')
    expect(messages).toHaveLength(MAX_MESSAGES + 1)
    expect(messages[0].text).toBe('0')
    expect(messages[MAX_MESSAGES].text).toBe('10,000 more console lines were not kept (the limit is 10,000)')
  })
})

describe('geometry that would not fit', () => {
  test('$fn = 1e7 is refused before anything is allocated', () => {
    for (const src of ['sphere(10, $fn = 1e7);', 'circle(10, $fn = 1e7);', 'cylinder(r = 10, h = 1, $fn = 1e7);', 'rotate_extrude($fn = 1e7) translate([5, 0]) square(1);', 'sphere(1000, $fa = 0.01, $fs = 0.01);', 'linear_extrude(10, twist = 10, slices = 1e9) square(1);']) {
      const t0 = performance.now()
      const e = runFails(src)
      expect(e.kind, src).toBe('limit')
      expect(e.message, src).toMatch(/^Too much geometry/)
      expect(performance.now() - t0, src).toBeLessThan(1000)
    }
  })
  test('many copies of a fine sphere stop at the budget', () => {
    expect(runFails('for (i = [0 : 999]) translate([i, 0, 0]) sphere(1, $fn = 200);').message).toMatch(/^Too much geometry/)
  })
  test('minkowski() of two fine spheres is refused', () => {
    expect(runFails('minkowski() { sphere(10, $fn = 200); sphere(10, $fn = 200); }').kind).toBe('limit')
  })
})

describe('source that is too big or too deep', () => {
  test('deep nesting is a syntax error, not a stack overflow', () => {
    const nest = (o: string, c: string, n: number, inner = '1') => o.repeat(n) + inner + c.repeat(n)
    for (const src of ['x = ' + nest('[', ']', 100000) + ';', 'x = ' + nest('(', ')', 100000) + ';', nest('{', '}', 100000, 'cube(1);'), 'x = ' + '-'.repeat(100000) + '1;', 'translate([1, 0, 0]) '.repeat(20000) + 'cube(1);']) {
      const e = interpFails(src)
      expect([e.kind, e.message]).toEqual(['syntax', 'Parser error: the code is nested too deeply (more than 600 levels)'])
    }
  })
  test('a very long chain of operators is a limit, not a crash', () => {
    expect(interpFails('x = ' + Array(200000).fill('1').join(' + ') + '; echo(x);').message).toMatch(/^Values or expressions nested too deeply/)
  })
  test('more than two million tokens is refused (about 6 MB of dense code)', () => {
    expect(MAX_TOKENS).toBe(2_000_000)
    expect(failure(() => tokenize('cube(1); cube(2);', { maxTokens: 8 })).message).toBe('The code is too long (more than 8 words, numbers and symbols)')
    const e = interpFails('x = [' + '0,'.repeat(1_000_000) + '];')
    expect([e.kind, e.message]).toEqual(['limit', 'The code is too long (more than 2,000,000 words, numbers and symbols)'])
  })
  test('10 MB of comment or of string literal is fine and quick', () => {
    const t0 = performance.now()
    expect(runScad('/*' + 'x'.repeat(10e6) + '*/ cube(1);', engineLike()).geoms).toHaveLength(1)
    expect(interpret('x = "' + 'x'.repeat(10e6) + '"; echo(len(x));').messages.map((m) => m.text)).toEqual(['1e+7'])
    expect(performance.now() - t0).toBeLessThan(5000)
  })
  test('the Customizer reads only up to the first {, so a huge body costs nothing on the main thread', () => {
    const body = 'module m() {\n' + 'cube(1);\n'.repeat(1_000_000) + '}\n@@@ not even valid'
    const t0 = performance.now()
    const r = extractParams('width = 10; // [1:100]\n' + body)
    expect(r.params.map((p) => p.name)).toEqual(['width'])
    expect(performance.now() - t0).toBeLessThan(500)
  })
})
