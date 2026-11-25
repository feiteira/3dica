// rands(): the Mersenne Twister (MT19937, the published reference algorithm) with C++'s canonical 53-bit doubles
// (two 32-bit draws per number), which reproduces OpenSCAD's seeded sequences for integer seeds from -2^31 to 2^32
// (rands(0, 1, 4, 42) gives OpenSCAD's numbers). Other seeds (1.5, 1e20) give other numbers than OpenSCAD's.

export class Mt19937 {
  private readonly mt = new Uint32Array(624)
  private i = 624

  constructor(seed: number) {
    this.seed(seed)
  }

  seed(seed: number) {
    const mt = this.mt
    mt[0] = seed >>> 0
    for (let i = 1; i < 624; i++) {
      const p = mt[i - 1] ^ (mt[i - 1] >>> 30)
      // 1812433253 * p + i, in 32-bit arithmetic
      mt[i] = (((((p & 0xffff0000) >>> 16) * 1812433253) << 16) + (p & 0x0000ffff) * 1812433253 + i) >>> 0
    }
    this.i = 624
  }

  private next(): number {
    const mt = this.mt
    if (this.i >= 624) {
      for (let k = 0; k < 624; k++) {
        const y = (mt[k] & 0x80000000) | (mt[(k + 1) % 624] & 0x7fffffff)
        mt[k] = mt[(k + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0)
      }
      this.i = 0
    }
    let y = mt[this.i++]
    y ^= y >>> 11
    y ^= (y << 7) & 0x9d2c5680
    y ^= (y << 15) & 0xefc60000
    y ^= y >>> 18
    return y >>> 0
  }

  /** a double in [0, 1) */
  real(): number {
    const lo = this.next()
    const hi = this.next()
    const r = (lo + hi * 4294967296) / 18446744073709551616
    return r >= 1 ? 1 - Number.EPSILON / 2 : r
  }
}
