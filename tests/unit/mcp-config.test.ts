// MCP bridge opt-in (src/mcp/config.ts), the screenshot layout (src/mcp/screenshot.ts) and the pure capture
// helpers of the viewport (src/view/viewport.ts).
import { describe, expect, it } from 'vitest'
import { backoffMs, DEFAULT_MCP_PORT, forgetMcp, isLocalHost, MCP_STORAGE_KEY, resolveMcpConfig, type StorageLike } from '../../src/mcp/config'
import { layoutViews, niceLength } from '../../src/mcp/screenshot'
import { captureDistance, capturePresetDirection, orthoHalfHeight } from '../../src/view/viewport'

class MemStorage implements StorageLike {
  m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, v) }
  removeItem(k: string) { this.m.delete(k) }
}
const throwing: StorageLike = {
  getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() { throw new Error('denied') },
}

describe('mcp config: opt-in', () => {
  it('is off without ?mcp and without a remembered opt-in', () => {
    const s = new MemStorage()
    expect(resolveMcpConfig('', 'localhost', s)).toMatchObject({ enabled: false, reason: 'not-enabled' })
    expect(resolveMcpConfig('?fresh', '127.0.0.1', s).enabled).toBe(false)
  })

  it('?mcp enables on localhost and is remembered; the port defaults to 6173', () => {
    const s = new MemStorage()
    expect(resolveMcpConfig('?fresh&mcp', 'localhost', s)).toEqual({ enabled: true, port: DEFAULT_MCP_PORT })
    expect(s.getItem(MCP_STORAGE_KEY)).toBe('{}')
    expect(resolveMcpConfig('', 'localhost', s)).toEqual({ enabled: true, port: 6173 })
  })

  it('?mcpPort overrides and is remembered with the opt-in', () => {
    const s = new MemStorage()
    expect(resolveMcpConfig('?mcp&mcpPort=6811', 'localhost', s)).toEqual({ enabled: true, port: 6811 })
    expect(resolveMcpConfig('', 'localhost', s)).toEqual({ enabled: true, port: 6811 })
    // a later ?mcp without a port goes back to the default
    expect(resolveMcpConfig('?mcp', 'localhost', s).port).toBe(6173)
    expect(resolveMcpConfig('', 'localhost', s).port).toBe(6173)
    // a bad port is ignored
    expect(resolveMcpConfig('?mcp&mcpPort=99999', 'localhost', new MemStorage()).port).toBe(6173)
    expect(resolveMcpConfig('?mcp&mcpPort=abc', 'localhost', new MemStorage()).port).toBe(6173)
  })

  it('?mcp=0 disables and forgets', () => {
    const s = new MemStorage()
    resolveMcpConfig('?mcp', 'localhost', s)
    expect(resolveMcpConfig('?mcp=0', 'localhost', s)).toMatchObject({ enabled: false, reason: 'disabled' })
    expect(s.getItem(MCP_STORAGE_KEY)).toBeNull()
    expect(resolveMcpConfig('', 'localhost', s).enabled).toBe(false)
    for (const v of ['false', 'off', 'no', 'OFF']) {
      resolveMcpConfig('?mcp', 'localhost', s)
      expect(resolveMcpConfig(`?mcp=${v}`, 'localhost', s).enabled, v).toBe(false)
    }
  })

  it('never on a non-local host (GitHub Pages), even with ?mcp or a remembered opt-in', () => {
    const s = new MemStorage()
    s.setItem(MCP_STORAGE_KEY, '{}')
    expect(resolveMcpConfig('?mcp', 'feiteira.github.io', s)).toMatchObject({ enabled: false, reason: 'not-local' })
    expect(resolveMcpConfig('', '192.168.1.20', s).enabled).toBe(false)
    expect(resolveMcpConfig('?mcp', 'localhost.example.com', s).enabled).toBe(false)
    for (const h of ['localhost', '127.0.0.1', '[::1]', 'LOCALHOST']) expect(isLocalHost(h), h).toBe(true)
  })

  it('works without storage (private windows): the URL still decides', () => {
    expect(resolveMcpConfig('?mcp&mcpPort=6200', 'localhost', throwing)).toEqual({ enabled: true, port: 6200 })
    expect(resolveMcpConfig('', 'localhost', throwing).enabled).toBe(false)
    expect(resolveMcpConfig('?mcp', 'localhost', null).enabled).toBe(true)
    expect(() => forgetMcp(throwing)).not.toThrow()
  })

  it('an unreadable stored value still counts as enabled on the default port', () => {
    const s = new MemStorage()
    s.setItem(MCP_STORAGE_KEY, 'yes please')
    expect(resolveMcpConfig('', 'localhost', s)).toEqual({ enabled: true, port: 6173 })
  })

  it('reconnects with a capped exponential back-off', () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(backoffMs)).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000])
  })
})

describe('mcp screenshot layout', () => {
  it('a single view fills the image', () => {
    expect(layoutViews('top', 800, 600)).toEqual([{ preset: 'top', x: 0, y: 0, width: 800, height: 600 }])
  })

  it('multi is 2×2 front | right / top | iso and covers every pixel once (odd sizes too)', () => {
    for (const [w, h] of [[800, 600], [801, 601], [17, 16]]) {
      const v = layoutViews('multi', w, h)
      expect(v.map((x) => x.preset)).toEqual(['front', 'right', 'top', 'iso'])
      expect(v.reduce((n, x) => n + x.width * x.height, 0)).toBe(w * h)
      expect(v[1].x).toBe(v[0].width)
      expect(v[2].y).toBe(v[0].height)
      expect(v[3].x + v[3].width).toBe(w)
      expect(v[3].y + v[3].height).toBe(h)
    }
  })

  it('scale bars use 1 / 2 / 5 × 10^k lengths', () => {
    expect([0.7, 1, 3, 7.5, 12, 49, 99, 250].map(niceLength)).toEqual([0.5, 1, 2, 5, 10, 20, 50, 200])
  })
})

describe('viewport capture helpers', () => {
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

  it('preset directions: front from −Y, right from +X, top from +Z with +Y up, iso from +X −Y +Z', () => {
    expect(capturePresetDirection('front')).toEqual({ dir: [0, -1, 0], up: [0, 0, 1] })
    expect(capturePresetDirection('right')).toEqual({ dir: [1, 0, 0], up: [0, 0, 1] })
    expect(capturePresetDirection('top')).toEqual({ dir: [0, 0, 1], up: [0, 1, 0] })
    const iso = capturePresetDirection('iso').dir
    expect(iso[0]).toBeGreaterThan(0)
    expect(iso[1]).toBeLessThan(0)
    expect(iso[2]).toBeGreaterThan(0)
    expect(dot(iso, iso)).toBeCloseTo(1, 9)
  })

  it('orthographic framing fits the box in both directions, with a margin', () => {
    const box = { min: [-20, -15, 0] as [number, number, number], max: [20, 15, 5] as [number, number, number] }
    // front: right = +X, up = +Z → width 40 decides at aspect 4:3 (half height 20 / 1.333 = 15)
    expect(orthoHalfHeight(box, [1, 0, 0], [0, 0, 1], 4 / 3, 1)).toBeCloseTo(15, 9)
    // a tall aspect: the height decides
    expect(orthoHalfHeight(box, [1, 0, 0], [0, 0, 1], 100, 1)).toBeCloseTo(2.5, 9)
    expect(orthoHalfHeight(box, [1, 0, 0], [0, 0, 1], 4 / 3)).toBeCloseTo(15 * 1.08, 9)
    // never below 1 mm
    expect(orthoHalfHeight({ min: [0, 0, 0], max: [0, 0, 0] }, [1, 0, 0], [0, 0, 1], 1)).toBe(1)
  })

  it('perspective framing uses the narrower of the vertical and horizontal fields of view', () => {
    const wide = captureDistance(10, 45, 2)
    const tall = captureDistance(10, 45, 0.5)
    expect(tall).toBeGreaterThan(wide)
    expect(wide).toBeCloseTo((1.15 * 10) / Math.sin((22.5 * Math.PI) / 180), 6)
  })
})
