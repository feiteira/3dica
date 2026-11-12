import { describe, expect, test } from 'vitest'
import { cyrb53, hash, mulberry32, seedFromKey, stableStringify } from '../../src/core/hash'

describe('stableStringify', () => {
  test('sorts keys, omits undefined, maps -0 to 0', () => {
    expect(stableStringify({ b: 1, a: { d: undefined, c: -0 } })).toBe('{"a":{"c":0},"b":1}')
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }))
    expect(stableStringify([1, 'x', true, null])).toBe('[1,"x",true,null]')
  })

  test('rounds 16-number arrays (matrices) to 1e-9, other numbers untouched', () => {
    const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    const noisy = m.map((v, i) => (i === 12 ? v + 1e-12 : i === 1 ? -1e-13 : v))
    expect(stableStringify(noisy)).toBe(stableStringify(m))
    expect(stableStringify([0.1 + 0.2])).toBe('[0.30000000000000004]')
  })

  test('non-finite numbers serialize as null', () => {
    expect(stableStringify([NaN, Infinity])).toBe('[null,null]')
  })
})

describe('hash', () => {
  test('format and stability', () => {
    const h = hash(['code', 'x', { a: 1 }])
    expect(h).toMatch(/^k[0-9a-f]+$/)
    expect(hash(['code', 'x', { a: 1 }])).toBe(h)
    expect(hash(['code', 'x', { a: 2 }])).not.toBe(h)
    expect(hash({ a: 1, b: 2 })).toBe(hash({ b: 2, a: 1 }))
  })

  test('is cyrb53 of the stable string with seeds 1 and 2', () => {
    const s = stableStringify([1, 2])
    expect(hash([1, 2])).toBe('k' + cyrb53(s, 1).toString(16) + cyrb53(s, 2).toString(16))
    expect(cyrb53('a', 1)).not.toBe(cyrb53('a', 2))
  })

  test('mulberry32 seeded by key is deterministic and in [0, 1)', () => {
    const a = mulberry32(seedFromKey('kabc')), b = mulberry32(seedFromKey('kabc')), c = mulberry32(seedFromKey('kabd'))
    const xs = Array.from({ length: 5 }, () => a())
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs)
    expect(Array.from({ length: 5 }, () => c())).not.toEqual(xs)
    for (const x of xs) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1) }
  })
})
