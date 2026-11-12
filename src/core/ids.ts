// §7 ids.ts — id generation and unique naming. Pure (uses crypto.getRandomValues, available in browsers and Node ≥ 19).
import type { Id } from './types'

const B36 = '0123456789abcdefghijklmnopqrstuvwxyz'

/** newId('d') → 'd_' + 10 random base36 chars; newId('i') → 'i_' + 10 chars. */
export function newId(prefix: 'd' | 'i'): Id {
  const bytes = new Uint8Array(10)
  globalThis.crypto.getRandomValues(bytes)
  let s = prefix + '_'
  for (const b of bytes) s += B36[b % 36]
  return s
}

export const DEF_ID_RE = /^d_[a-z0-9]{1,32}$/
export const INSTANCE_ID_RE = /^i_[a-z0-9]{1,32}$/

export function isDefId(id: unknown): id is Id { return typeof id === 'string' && DEF_ID_RE.test(id) }
export function isInstanceId(id: unknown): id is Id { return typeof id === 'string' && INSTANCE_ID_RE.test(id) }

/** Max def name length (§2.2). */
export const MAX_NAME = 64

/**
 * A name based on `base` that is not in `taken` (case-sensitive) and is not "Scene".
 * `base` itself if free; otherwise "Base 2", "Base 3", … A base that already ends in " <n>"
 * continues from n + 1 ("Fixture 2" → "Fixture 3") — unless the number is too large to count up from exactly
 * (more than 15 digits: Number('1e20 digits') + 1 is the same number), then " 2" is appended instead.
 * The result is trimmed and at most 64 chars. Always terminates.
 */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const set = taken instanceof Set ? (taken as Set<string>) : new Set(taken)
  const b = base.trim().slice(0, MAX_NAME) || 'Object'
  const free = (n: string) => !set.has(n) && n !== 'Scene'
  if (free(b)) return b
  const m = /^(.*\S) (\d{1,15})$/.exec(b)
  let stem = b
  let n = 2
  if (m) { stem = m[1]; n = Number(m[2]) + 1 }
  // every n gives a different candidate, so at most |taken| + 1 of them can be taken (n stays far below 2^53)
  for (let tries = 0; tries <= set.size + 1; tries++, n++) {
    const suffix = ' ' + n
    const cand = stem.slice(0, MAX_NAME - suffix.length) + suffix
    if (free(cand)) return cand
  }
  // unreachable in practice; a random suffix still always ends the search
  for (;;) {
    const suffix = ' ' + Math.random().toString(36).slice(2, 8)
    const cand = stem.slice(0, MAX_NAME - suffix.length) + suffix
    if (free(cand)) return cand
  }
}
