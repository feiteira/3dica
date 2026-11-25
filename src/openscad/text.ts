// text(): an approximation. OpenSCAD renders system fonts (Liberation Sans by default); 3Dica has no font files, so
// it strokes JSCAD's built-in single-stroke (Hershey) font into filled outlines. For the printable ASCII characters
// each glyph is fitted into the box Liberation Sans' glyph fills in OpenSCAD 2021.01, and the pen advances and the
// halign / valign offsets use that font's metrics and kerning, and each glyph's stroke is as thick as gives it that
// font's area, so a label has OpenSCAD's size, position and about its volume (only the letter shapes differ). The metrics were measured from the openscad binary's output (size 10, default font). Other characters
// use the stroke font's own proportions.
import jscad from '@jscad/modeling'
import type { Fragments, Vec2 } from './types'
import { union2, type Region } from './build-2d'
import { strokePaths } from './build-offset'
import { fragments } from './tess'

export const TEXT_WARNING = "text() draws a built-in single-stroke font, sized and spaced like OpenSCAD's default font (Liberation Sans); the letter shapes differ"

/** Hershey units: capitals are 21 tall. */
const CAP = 21
const CAP_RATIO = 0.955
const STROKE_RATIO = 0.13
const LINE_RATIO = 1.27 // vertical advance of ttb / btt text, × size

/**
 * Liberation Sans in OpenSCAD 2021.01, per character from ' ' (32) to '~' (126), in units of size:
 * [advance, ink left, ink right, ink bottom, ink top, ascent and descent as valign top / bottom move it, and the
 * stroke width that gives the glyph Liberation Sans' area].
 */
const METRICS: number[][] = [
  [0.3768, 0, 0, 0, 0, 0, 0, 0.13], [0.3768, 0.1254, 0.2597, 0, 0.9555, 0.9331, 0, 0.1192],
  [0.4815, 0.059, 0.434, 0.6551, 0.9555, 0.9331, 0, 0.1229], [0.7543, 0.0061, 0.7656, 0, 0.95, 0.9281, 0, 0.0744],
  [0.7543, 0.0149, 0.75, -0.0963, 1.028, 1.0044, 0.0944, 0.0774],
  [1.206, 0.0495, 1.1854, -0.0081, 0.9636, 0.9413, 0.0081, 0.0836],
  [0.9047, 0.0488, 0.9046, -0.0136, 0.9609, 0.9387, 0.0137, 0.0954],
  [0.2589, 0.0705, 0.1953, 0.6551, 0.9555, 0.9331, 0, 0.1222],
  [0.4517, 0.0861, 0.4543, -0.2875, 1.0063, 0.9831, 0.2813, 0.1119],
  [0.4517, 0.0081, 0.3764, -0.2875, 1.0063, 0.9831, 0.2813, 0.1119],
  [0.5278, 0.0224, 0.5188, 0.4679, 0.9555, 0.9331, 0, 0.0689],
  [0.7921, 0.0678, 0.7425, 0.1221, 0.8015, 0.7831, 0, 0.1041],
  [0.3768, 0.1248, 0.2611, -0.1777, 0.1485, 0.1456, 0.1737, 0.0981],
  [0.4517, 0.0617, 0.4008, 0.3146, 0.4231, 0.4138, 0, 0.4], [0.3768, 0.1268, 0.259, 0, 0.1485, 0.1456, 0, 0.4],
  [0.3768, 0, 0.3858, -0.0136, 1.0063, 0.9831, 0.0137, 0.1069],
  [0.7543, 0.0542, 0.7181, -0.0136, 0.9697, 0.9475, 0.0137, 0.1142],
  [0.7543, 0.1058, 0.7046, 0, 0.9555, 0.9331, 0, 0.1372], [0.7543, 0.0698, 0.7025, 0, 0.9697, 0.9475, 0, 0.1111],
  [0.7543, 0.0529, 0.7113, -0.0136, 0.9697, 0.9475, 0.0137, 0.1195],
  [0.7543, 0.0319, 0.7317, 0, 0.9555, 0.9331, 0, 0.117],
  [0.7543, 0.0556, 0.7141, -0.0136, 0.9555, 0.9331, 0.0137, 0.1135],
  [0.7543, 0.0705, 0.7113, -0.0136, 0.9697, 0.9475, 0.0137, 0.1067],
  [0.7543, 0.0712, 0.7025, 0, 0.9555, 0.9331, 0, 0.1111],
  [0.7543, 0.0603, 0.712, -0.0136, 0.9697, 0.9475, 0.0137, 0.1032],
  [0.7543, 0.0651, 0.7066, -0.0136, 0.9697, 0.9475, 0.0137, 0.1092],
  [0.3768, 0.1268, 0.259, 0, 0.7337, 0.7169, 0, 0.1002],
  [0.3768, 0.1248, 0.2611, -0.1777, 0.7337, 0.7169, 0.1737, 0.0845],
  [0.7921, 0.0685, 0.7432, 0.1044, 0.8097, 0.7912, 0, 0.1042],
  [0.7921, 0.0678, 0.7425, 0.2333, 0.6808, 0.665, 0, 0.1044],
  [0.7921, 0.0685, 0.7432, 0.1044, 0.8097, 0.7912, 0, 0.1042], [0.7543, 0.057, 0.7208, 0, 0.9697, 0.9475, 0, 0.1051],
  [1.3769, 0.1092, 1.2898, -0.1919, 1.0063, 0.9831, 0.1875, 0.0819],
  [0.9047, 0.0027, 0.9236, 0, 0.9555, 0.9331, 0, 0.1187], [0.9047, 0.1139, 0.8531, 0, 0.9555, 0.9331, 0, 0.1097],
  [0.9795, 0.0705, 0.95, -0.0136, 0.9697, 0.9475, 0.0137, 0.1143],
  [0.9795, 0.1139, 0.9365, 0, 0.9555, 0.9331, 0, 0.12], [0.9047, 0.1139, 0.8666, 0, 0.9555, 0.9331, 0, 0.1221],
  [0.8285, 0.1139, 0.7927, 0, 0.9555, 0.9331, 0, 0.1346],
  [1.055, 0.0698, 0.9765, -0.0136, 0.9697, 0.9475, 0.0137, 0.1187],
  [0.9795, 0.1139, 0.8897, 0, 0.9555, 0.9331, 0, 0.1283], [0.3768, 0.1282, 0.2577, 0, 0.9555, 0.9331, 0, 0.4],
  [0.6782, 0.0217, 0.5913, -0.0136, 0.9555, 0.9331, 0.0137, 0.1285],
  [0.9047, 0.1139, 0.9107, 0, 0.9555, 0.9331, 0, 0.1161], [0.7543, 0.1139, 0.7263, 0, 0.9555, 0.9331, 0, 0.1245],
  [1.1298, 0.1139, 1.043, 0, 0.9555, 0.9331, 0, 0.1216], [0.9795, 0.1139, 0.8897, 0, 0.9555, 0.9331, 0, 0.1226],
  [1.055, 0.0658, 1.0138, -0.0136, 0.9697, 0.9475, 0.0137, 0.1204],
  [0.9047, 0.1139, 0.8531, 0, 0.9555, 0.9331, 0, 0.1205],
  [1.055, 0.0658, 1.0138, -0.2624, 0.9697, 0.9475, 0.2569, 0.1104],
  [0.9795, 0.1139, 0.9385, 0, 0.9555, 0.9331, 0, 0.1142],
  [0.9047, 0.0631, 0.8626, -0.0136, 0.9697, 0.9475, 0.0137, 0.1097],
  [0.8285, 0.0312, 0.8165, 0, 0.9555, 0.9331, 0, 0.1225],
  [0.9795, 0.1071, 0.8958, -0.0136, 0.9555, 0.9331, 0.0137, 0.1265],
  [0.9047, 0.0061, 0.9202, 0, 0.9555, 0.9331, 0, 0.1247], [1.2802, 0.0061, 1.3061, 0, 0.9555, 0.9331, 0, 0.1259],
  [0.9047, 0.0312, 0.8972, 0, 0.9555, 0.9331, 0, 0.1084], [0.9047, 0.0305, 0.8958, 0, 0.9555, 0.9331, 0, 0.1229],
  [0.8285, 0.0441, 0.8049, 0, 0.9555, 0.9331, 0, 0.1062],
  [0.3768, 0.099, 0.375, -0.2882, 1.0063, 0.9831, 0.2819, 0.0932],
  [0.3768, 0, 0.3858, -0.0136, 1.0063, 0.9831, 0.0137, 0.1069],
  [0.3768, 0.0108, 0.2868, -0.2882, 1.0063, 0.9831, 0.2819, 0.0932],
  [0.6364, 0.0068, 0.6449, 0.4564, 0.9555, 0.9331, 0, 0.1001],
  [0.7543, -0.021, 0.788, -0.276, -0.1878, 0, 0.27, 0.4],
  [0.4517, 0.0719, 0.3594, 0.8144, 1.0226, 0.9987, 0, 0.0342],
  [0.7543, 0.059, 0.7724, -0.0136, 0.7473, 0.73, 0.0137, 0.1074],
  [0.7543, 0.0895, 0.7141, -0.0136, 1.0063, 0.9831, 0.0137, 0.1181],
  [0.6782, 0.059, 0.6578, -0.0136, 0.7473, 0.73, 0.0137, 0.1112],
  [0.7543, 0.0583, 0.6829, -0.0136, 1.0063, 0.9831, 0.0137, 0.1181],
  [0.7543, 0.059, 0.7107, -0.0136, 0.7473, 0.73, 0.0137, 0.1015],
  [0.3768, 0.0197, 0.3879, 0, 1.005, 0.9819, 0, 0.123],
  [0.7543, 0.0583, 0.6829, -0.2882, 0.7453, 0.7281, 0.2819, 0.1187],
  [0.7543, 0.0963, 0.6822, 0, 1.0063, 0.9831, 0, 0.1213], [0.3013, 0.0929, 0.215, 0, 1.0063, 0.9831, 0, 0.4],
  [0.3013, -0.0339, 0.215, -0.2882, 1.0063, 0.9831, 0.2819, 0.123],
  [0.6782, 0.0936, 0.6964, 0, 1.0063, 0.9831, 0, 0.1165], [0.3013, 0.0936, 0.2156, 0, 1.0063, 0.9831, 0, 0.4],
  [1.1298, 0.0922, 1.0653, 0, 0.7473, 0.73, 0, 0.1134], [0.7543, 0.0922, 0.6822, 0, 0.7473, 0.73, 0, 0.1163],
  [0.7543, 0.0583, 0.7141, -0.0136, 0.7473, 0.73, 0.0137, 0.1149],
  [0.7543, 0.0895, 0.7141, -0.2882, 0.7466, 0.7294, 0.2819, 0.1172],
  [0.7543, 0.0583, 0.6835, -0.2882, 0.7473, 0.73, 0.2819, 0.1183],
  [0.4517, 0.0922, 0.4394, 0, 0.7473, 0.73, 0, 0.1159],
  [0.6782, 0.0386, 0.6442, -0.0136, 0.7453, 0.7281, 0.0137, 0.0968],
  [0.3768, 0.021, 0.3757, -0.0108, 0.8978, 0.8769, 0.0106, 0.1196],
  [0.7543, 0.0902, 0.6802, -0.0136, 0.7337, 0.7169, 0.0137, 0.1163],
  [0.6782, 0.0047, 0.6896, 0, 0.7337, 0.7169, 0, 0.1223], [0.9795, -0.002, 1.0063, 0, 0.7337, 0.7169, 0, 0.113],
  [0.6782, 0.0156, 0.6795, 0, 0.7337, 0.7169, 0, 0.102],
  [0.6782, 0.0034, 0.6917, -0.2882, 0.7337, 0.7169, 0.2819, 0.1158],
  [0.6782, 0.0563, 0.6252, 0, 0.7337, 0.7169, 0, 0.1043],
  [0.453, 0.0231, 0.4394, -0.2882, 1.0063, 0.9831, 0.2819, 0.0516],
  [0.3523, 0.1241, 0.2367, -0.2943, 1.0063, 0.9831, 0.2875, 0.4],
  [0.453, 0.0231, 0.4388, -0.2882, 1.0063, 0.9831, 0.2819, 0.0511],
  [0.7921, 0.0624, 0.7487, 0.375, 0.5472, 0.535, 0, 0.0717]
]

/** Its kerning pairs (character codes and the change of advance in units of size × 10 000): HarfBuzz applies them. */
const KERN_PAIRS = [
  32, 65, -748, 32, 84, -245, 32, 89, -245, 49, 49, -1006, 65, 32, -748, 65, 84, -1007, 65, 86, -1007, 65, 87, -504,
  65, 89, -1007, 65, 118, -246, 65, 119, -245, 65, 121, -246, 70, 44, -1503, 70, 46, -1503, 70, 65, -749,
  76, 32, -503, 76, 84, -1006, 76, 86, -1007, 76, 87, -1007, 76, 89, -1007, 76, 121, -503, 80, 32, -245,
  80, 44, -1748, 80, 46, -1748, 80, 65, -1007, 82, 84, -245, 82, 86, -245, 82, 87, -245, 82, 89, -245, 84, 32, -245,
  84, 44, -1503, 84, 45, -749, 84, 46, -1503, 84, 58, -1503, 84, 59, -1503, 84, 65, -1007, 84, 79, -245,
  84, 97, -1503, 84, 99, -1504, 84, 101, -1503, 84, 105, -503, 84, 111, -1503, 84, 114, -504, 84, 115, -1504,
  84, 117, -503, 84, 119, -748, 84, 121, -749, 86, 44, -1245, 86, 45, -749, 86, 46, -1245, 86, 58, -503,
  86, 59, -503, 86, 65, -1007, 86, 97, -1007, 86, 101, -748, 86, 105, -245, 86, 111, -748, 86, 114, -504,
  86, 117, -503, 86, 121, -504, 87, 44, -748, 87, 45, -246, 87, 46, -748, 87, 58, -245, 87, 59, -245, 87, 65, -504,
  87, 97, -503, 87, 101, -245, 87, 111, -245, 87, 114, -246, 87, 117, -245, 87, 121, -120, 89, 32, -245,
  89, 44, -1748, 89, 45, -1246, 89, 46, -1748, 89, 58, -748, 89, 59, -881, 89, 65, -1007, 89, 97, -1007,
  89, 101, -1245, 89, 105, -503, 89, 111, -1245, 89, 112, -1007, 89, 113, -1245, 89, 117, -748, 89, 118, -749,
  102, 102, -244, 114, 44, -748, 114, 46, -748, 118, 44, -1007, 118, 46, -1007, 119, 44, -748, 119, 46, -748,
  121, 44, -1007, 121, 46, -1007
]
const KERN = new Map<number, number>()
for (let i = 0; i < KERN_PAIRS.length; i += 3) KERN.set(KERN_PAIRS[i] * 128 + KERN_PAIRS[i + 1], KERN_PAIRS[i + 2] / 1e4)

export interface TextOpts {
  text: string; size: number; halign: 'left' | 'center' | 'right'; valign: 'top' | 'center' | 'baseline' | 'bottom'
  spacing: number; direction: 'ltr' | 'rtl' | 'ttb' | 'btt'; frag: Fragments
}

interface Placed { paths: Vec2[][]; advance: number; asc: number; desc: number; width: number }

/** One glyph's stroke centre lines at the origin (scaled to `size`), its advance, ascent / descent and stroke width. */
function glyph(c: string, size: number): Placed {
  const g = jscad.text.vectorChar({ input: c })
  const segs = g.segments as unknown as Vec2[][]
  const m = METRICS[c.charCodeAt(0) - 32]
  if (!m || c.length !== 1) {
    // the stroke font's own proportions
    const width = STROKE_RATIO * size
    const k = (CAP_RATIO * size) / CAP
    const paths = segs.map((seg) => seg.map(([x, y]): Vec2 => [x * k, y * k]))
    let top = 0, bottom = 0
    for (const p of paths) for (const q of p) { top = Math.max(top, q[1] + width / 2); bottom = Math.min(bottom, q[1] - width / 2) }
    return { paths, advance: g.width * k, asc: top * 0.977, desc: -bottom, width }
  }
  const [adv, ix0, ix1, iy0, iy1, asc, desc, w] = m.map((v) => v * size)
  // never wider than the glyph's box (a full stop is a dot that size, a lower-case l a bar that wide)
  const width = Math.min(w, ix1 - ix0, iy1 - iy0)
  let hx0 = Infinity, hx1 = -Infinity, hy0 = Infinity, hy1 = -Infinity
  for (const seg of segs) for (const [x, y] of seg) { hx0 = Math.min(hx0, x); hx1 = Math.max(hx1, x); hy0 = Math.min(hy0, y); hy1 = Math.max(hy1, y) }
  // the stroke's outer edge on the ink box: centre lines inset by half the stroke (or centred when the box is thinner)
  const h = width / 2
  const fit = (v: number, h0: number, h1: number, i0: number, i1: number) => {
    const room = i1 - i0 - 2 * h
    return h1 > h0 && room > 0 ? i0 + h + ((v - h0) / (h1 - h0)) * room : (i0 + i1) / 2
  }
  const paths = segs.map((seg) => seg.map(([x, y]): Vec2 => [fit(x, hx0, hx1, ix0, ix1), fit(y, hy0, hy1, iy0, iy1)]))
  return { paths, advance: adv, asc, desc, width }
}

/** The laid-out glyphs (stroke centre lines, before stroking), each with its stroke width. */
export function textPaths(o: TextOpts): { paths: Vec2[][]; width: number }[] {
  const size = o.size
  if (!(size > 0) || !Number.isFinite(size)) return []
  const chars = [...o.text].filter((c) => c >= ' ')
  const glyphs = chars.map((c) => glyph(c, size))
  const spacing = Number.isFinite(o.spacing) ? o.spacing : 1
  const out: { paths: Vec2[][]; width: number }[] = []
  const vertical = o.direction === 'ttb' || o.direction === 'btt'
  const reversed = o.direction === 'rtl' || o.direction === 'btt'
  const order = reversed ? [...glyphs].reverse() : glyphs
  let pen = 0, asc = 0, desc = 0
  order.forEach((g, i) => {
    const paths = g.paths.map((seg) => seg.map(([x, y]): Vec2 => (vertical ? [x - g.advance / 2, y - pen] : [x + pen, y])))
    if (paths.length) out.push({ paths, width: g.width })
    // kerning between neighbours as laid out (right to left too) changes the advance; it is spaced like the advance
    const next = reversed ? chars[chars.length - 2 - i] : chars[i + 1]
    const here = reversed ? chars[chars.length - 1 - i] : chars[i]
    const kern = !vertical && next !== undefined ? (KERN.get(here.charCodeAt(0) * 128 + next.charCodeAt(0)) ?? 0) * size : 0
    pen += vertical ? LINE_RATIO * size * spacing : (g.advance + kern) * spacing
    asc = Math.max(asc, g.asc)
    desc = Math.max(desc, g.desc)
  })
  if (out.length === 0) return out
  let dx = 0, dy = 0
  if (vertical) {
    // OpenSCAD hangs vertical text below the baseline and centres each glyph on x = 0
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (const g of out) for (const p of g.paths) for (const [x, y] of p) {
      x0 = Math.min(x0, x - g.width / 2); x1 = Math.max(x1, x + g.width / 2); y0 = Math.min(y0, y - g.width / 2); y1 = Math.max(y1, y + g.width / 2)
    }
    dy = -y1 - 0.15 * size
    if (o.halign === 'center') dx = -(x1 - x0) / 2
    else if (o.halign === 'right') dx = -(x1 - x0)
    if (o.valign === 'center') dy = -(y0 + y1) / 2
  } else {
    // as OpenSCAD: halign on the total advance, valign on the largest ascent and descent of the glyphs
    if (o.halign === 'center') dx = -pen / 2
    else if (o.halign === 'right') dx = -pen
    if (o.valign === 'top') dy = -asc
    else if (o.valign === 'center') dy = (desc - asc) / 2
    else if (o.valign === 'bottom') dy = desc
  }
  if (dx !== 0 || dy !== 0) for (const g of out) for (const p of g.paths) for (const q of p) { q[0] += dx; q[1] += dy }
  return out
}

export function textRegion(o: TextOpts): Region {
  const glyphs = textPaths(o)
  if (glyphs.length === 0) return []
  // strokes get round ends; their arcs follow $fn / $fa / $fs like offset(r), but at least 12 per circle so the
  // thin strokes of the default settings do not end in points
  const regions = glyphs.map(({ paths, width }) => {
    const n = Math.min(Math.max(fragments(width / 2, o.frag), 12), 64)
    return strokePaths(paths, width, { fn: n, fa: o.frag.fa, fs: o.frag.fs })
  })
  return regions.length === 1 ? regions[0] : union2(regions)
}
