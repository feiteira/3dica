// §5.2 hashing — shared by main thread (keys) and worker (memo keys, seeded Math.random).

/**
 * Deterministic JSON-like string: object keys sorted, `undefined` members omitted, -0 → 0,
 * and every array of exactly 16 numbers (a Mat4) has its entries rounded to 1e-9.
 * Non-finite numbers serialize as null (like JSON).
 */
export function stableStringify(x: unknown): string {
  return ser(x)
}

function num(n: number): string {
  if (!Number.isFinite(n)) return 'null'
  if (n === 0) return '0' // also -0
  return JSON.stringify(n)
}

function round9(n: number): number {
  if (!Number.isFinite(n)) return n
  const r = Math.round(n * 1e9) / 1e9
  return r === 0 ? 0 : r
}

function ser(x: unknown): string {
  if (x === null) return 'null'
  switch (typeof x) {
    case 'number': return num(x)
    case 'string': return JSON.stringify(x)
    case 'boolean': return x ? 'true' : 'false'
    case 'undefined': return 'null' // only reachable for top-level / array members
    case 'bigint': return JSON.stringify(x.toString())
    case 'function': case 'symbol': return 'null'
  }
  if (Array.isArray(x)) {
    const isMat = x.length === 16 && x.every((v) => typeof v === 'number')
    return '[' + x.map((v) => (isMat ? num(round9(v as number)) : ser(v))).join(',') + ']'
  }
  if (ArrayBuffer.isView(x)) return ser(Array.from(x as unknown as ArrayLike<number>))
  const o = x as Record<string, unknown>
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + ser(o[k])).join(',') + '}'
}

/** cyrb53 (public domain): a fast 53-bit string hash. */
export function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/** hash(x) = 'k' + cyrb53(s, 1).toString(16) + cyrb53(s, 2).toString(16), s = stableStringify(x). */
export function hash(x: unknown): string {
  const s = stableStringify(x)
  return 'k' + cyrb53(s, 1).toString(16) + cyrb53(s, 2).toString(16)
}

/** 32-bit seed derived from a cache key (for the worker's seeded Math.random, §3.1). */
export function seedFromKey(key: string): number {
  return cyrb53(key, 3) >>> 0
}

/** mulberry32 PRNG: returns a function producing floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
