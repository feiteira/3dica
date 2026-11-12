// MCP screenshot composition: view layout (single or 2×2 multi view), overlays drawn on the captured canvas (view
// labels, an axis triad, a scale bar on orthographic views), PNG encoding and the text that goes with the image.
// The pixels themselves come from ViewportApi.capture (src/view/viewport.ts).
import type { CaptureOptions, CapturePreset, CaptureResult, CaptureViewInfo } from '../app/context'

export type ScreenshotView = CapturePreset | 'multi'

/** Multi view order: front, right / top, iso (reading order). */
export const MULTI: CapturePreset[] = ['front', 'right', 'top', 'iso']

/** One rectangle per view. A multi view splits the image into 2×2 (odd sizes: the left / top halves are 1 px smaller). */
export function layoutViews(view: ScreenshotView, width: number, height: number): CaptureOptions['views'] {
  if (view !== 'multi') return [{ preset: view, x: 0, y: 0, width, height }]
  const w0 = Math.floor(width / 2), h0 = Math.floor(height / 2)
  const cells = [[0, 0, w0, h0], [w0, 0, width - w0, h0], [0, h0, w0, height - h0], [w0, h0, width - w0, height - h0]]
  return MULTI.map((preset, i) => {
    const [x, y, w, h] = cells[i]
    return { preset, x, y, width: w, height: h }
  })
}

export const VIEW_LABEL: Record<CapturePreset, string> = {
  front: 'FRONT · looking +Y',
  right: 'RIGHT · looking −X',
  top: 'TOP · looking −Z',
  iso: 'ISO · from +X −Y +Z',
  current: 'CURRENT VIEW',
}

/** The largest 1 / 2 / 5 × 10^k not above `mm` (scale bar length). */
export function niceLength(mm: number): number {
  if (!(mm > 0)) return 1
  const p = 10 ** Math.floor(Math.log10(mm))
  for (const m of [5, 2, 1]) if (m * p <= mm) return m * p
  return p
}

const AXIS_COLOR = { X: '#ff6b6b', Y: '#69db7c', Z: '#4dabf7' } as const

/** Labels, axis triad and scale bar per view, plus separators between the cells of a multi view. */
export function drawOverlays(canvas: HTMLCanvasElement, views: CaptureViewInfo[], opts: { labels: boolean; scale: boolean }): void {
  const g = canvas.getContext('2d')
  if (!g) return
  const font = (px: number) => `600 ${px}px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif`
  for (const v of views) {
    g.save()
    g.beginPath()
    g.rect(v.x, v.y, v.width, v.height)
    g.clip()
    const small = Math.min(v.width, v.height) < 220
    const fs = small ? 10 : 12
    if (opts.labels) {
      const text = VIEW_LABEL[v.preset]
      g.font = font(fs)
      const tw = g.measureText(text).width
      g.fillStyle = 'rgba(10, 12, 15, 0.72)'
      g.fillRect(v.x + 6, v.y + 6, tw + 12, fs + 9)
      g.fillStyle = '#e6eaef'
      g.textBaseline = 'middle'
      g.fillText(text, v.x + 12, v.y + 6 + (fs + 9) / 2)
    }
    if (opts.labels) {
      // axis triad, bottom-left: each world axis as it points on screen
      const len = small ? 16 : 22
      const ox = v.x + (small ? 22 : 30), oy = v.y + v.height - (small ? 22 : 30)
      g.lineWidth = 2
      g.font = font(fs - 1)
      g.textBaseline = 'middle'
      g.textAlign = 'center'
      for (const a of ['X', 'Y', 'Z'] as const) {
        const [dx, dy] = v.axes[a]
        const l = Math.hypot(dx, dy)
        g.strokeStyle = AXIS_COLOR[a]
        g.fillStyle = AXIS_COLOR[a]
        if (l < 0.15) {
          // pointing at (or away from) the viewer
          g.beginPath(); g.arc(ox, oy, 3, 0, Math.PI * 2); g.fill()
          continue
        }
        const ex = ox + dx * len, ey = oy + dy * len
        g.beginPath(); g.moveTo(ox, oy); g.lineTo(ex, ey); g.stroke()
        g.fillText(a, ex + (dx / l) * 8, ey + (dy / l) * 8)
      }
      g.textAlign = 'start'
    }
    if (opts.scale && v.mmPerPx && v.mmPerPx > 0) {
      const mm = niceLength(v.mmPerPx * v.width * 0.2)
      const px = mm / v.mmPerPx
      const x1 = v.x + v.width - 14, x0 = x1 - px, y = v.y + v.height - 16
      g.strokeStyle = '#e6eaef'
      g.lineWidth = 2
      g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.moveTo(x0, y - 4); g.lineTo(x0, y + 4); g.moveTo(x1, y - 4); g.lineTo(x1, y + 4); g.stroke()
      g.font = font(fs - 1)
      g.fillStyle = '#e6eaef'
      g.textAlign = 'center'
      g.textBaseline = 'bottom'
      g.fillText(`${mm} mm`, (x0 + x1) / 2, y - 5)
      g.textAlign = 'start'
    }
    g.restore()
  }
  if (views.length > 1) {
    g.fillStyle = '#0b0d10'
    for (const v of views) {
      if (v.x > 0) g.fillRect(v.x - 1, v.y, 2, v.height)
      if (v.y > 0) g.fillRect(v.x, v.y - 1, v.width, 2)
    }
  }
}

/**
 * PNG as base64. toDataURL encodes synchronously (8 ms at 800×600, ~45 ms at 2048²); toBlob's callback can wait
 * more than a second behind the render loop's frames when WebGL runs in software (headless Chromium).
 */
export function toPngBase64(canvas: HTMLCanvasElement): string {
  const url = canvas.toDataURL('image/png')
  return url.slice(url.indexOf(',') + 1)
}

const f1 = (n: number) => (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '')
const f2 = (n: number) => String(Math.round(n * 100) / 100 + 0)
const v3 = (v: readonly number[]) => `[${v.map(f2).join(', ')}]`

export interface DescribeInput {
  cap: CaptureResult
  view: ScreenshotView
  style: 'clean' | 'as-seen'
  grid: boolean
  width: number
  height: number
  shows: string
  notes: string[]
  errors: Record<string, unknown>[]
  evaluation: string
  paused: boolean
}

/** The short text block returned next to the image: what is shown, camera, framed box in mm, triangles, errors. */
export function describeCapture(d: DescribeInput): string {
  const { cap } = d
  const lines: string[] = []
  const viewText = d.view === 'multi'
    ? 'multi (2×2: front | right / top | iso, all orthographic)'
    : d.view === 'current' ? 'current (the user\'s perspective camera)' : `${d.view} (orthographic)`
  lines.push(`3Dica screenshot ${d.width}×${d.height} px · view ${viewText} · style ${d.style}${d.grid ? ' · grid 10 mm cells, 200 mm across, on Z = 0' : ''}`)
  lines.push(`Shows ${d.shows}.`)
  if (cap.box) {
    const b = cap.box
    const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]]
    lines.push(`Framed box: ${size.map(f1).join(' × ')} mm (X × Y × Z), min ${v3(b.min)}, max ${v3(b.max)}.`)
  } else {
    lines.push('Nothing is drawn (empty, hidden or not evaluated yet).')
  }
  lines.push(`Drawn: ${cap.meshes} ${cap.meshes === 1 ? 'mesh' : 'meshes'}, ${cap.triangles.toLocaleString('en-US')} triangles.`)
  const scales = cap.views.filter((v) => v.mmPerPx).map((v) => `${v.preset} ${f2(v.mmPerPx!)}`)
  if (scales.length) lines.push(`Scale (mm per px): ${scales.join(', ')}.`)
  const cur = cap.views.find((v) => v.preset === 'current')
  if (cur) lines.push(`Camera: position ${v3(cur.camera.position)}, looking at ${v3(cur.camera.target)}.`)
  if (cap.views.length > 1 || d.style === 'clean') lines.push('Axes in the corner triad: X red, Y green, Z blue.')
  for (const n of d.notes) lines.push(`Note: ${n}.`)
  if (d.paused) lines.push('Code is paused in the app (opened without running): nothing new is evaluated until the user clicks Run code.')
  else if (d.evaluation === 'timeout') lines.push('Note: evaluation was still running; some objects may be missing or stale (translucent).')
  if (d.errors.length) {
    const shown = d.errors.slice(0, 5).map((e) => `${String(e.definition)}: ${String(e.message)}${e.line !== undefined ? ` (line ${String(e.line)})` : ''}`)
    lines.push(`Errors (${d.errors.length}): ${shown.join('; ')}${d.errors.length > 5 ? '; …' : ''}. A failed object shows its last good shape tinted red, or nothing.`)
  } else {
    lines.push('No evaluation errors.')
  }
  return lines.join('\n')
}
