// The built-in modules of OpenSCAD 2021.01 as GeomNodes. Argument handling (defaults, which arguments win,
// fallbacks and warning texts) follows the binary, checked with its CSG export. Degenerate primitives (a size or
// radius that is not a positive finite number) produce nothing in OpenSCAD, so they become empty groups here.
import { formatNumber, shortText, shortValue } from './format'
import { cosDeg, sinDeg } from './builtins'
import { SVG_COLORS } from './colors'
import type { Fragments, GeomNode, Mat4, Rgba, ScadError, SourcePos, Vec2, Vec3 } from './types'
import type { Value } from './values'

export interface ModuleCtx {
  /** the evaluated arguments, by parameter name (positional ones already mapped) */
  args: Map<string, Value>
  pos: SourcePos
  /** a $-variable in effect at the instantiation ($fn, $fa, $fs) */
  special(name: string): Value
  /** a warning at the instantiation; `noPos` for the few OpenSCAD prints without a location */
  warn(text: string, noPos?: boolean): void
  /** a deprecation notice, printed once per evaluation like OpenSCAD does, without a location */
  deprecated(text: string): void
  error(kind: ScadError['kind'], msg: string): ScadError
  /** evaluate the instantiation's children */
  children(): GeomNode[]
}

export interface BuiltinModule {
  /** parameters in positional order */
  params: string[]
  /** parameters only accepted by name */
  named?: string[]
  /** a primitive: its children are not run, with OpenSCAD's warning ('warn') or silently ('quiet', text()) */
  leaf?: 'warn' | 'quiet'
  run(c: ModuleCtx): GeomNode | null
}

const isNum = (v: Value): v is number => typeof v === 'number'
const finitePos = (v: number) => Number.isFinite(v) && v > 0
const num = (v: Value, d: number) => (typeof v === 'number' ? v : d)
const bool = (v: Value, d: boolean) => (typeof v === 'boolean' ? v : d)
const empty = (c: ModuleCtx): GeomNode => ({ kind: 'group', children: [], pos: c.pos })

function frag(c: ModuleCtx): Fragments {
  const n = (name: string, d: number) => { const v = c.special(name); return typeof v === 'number' && !Number.isNaN(v) ? v : d }
  return { fn: n('$fn', 0), fa: n('$fa', 12), fs: n('$fs', 2) }
}

/**
 * A vector argument of length 2 or 3 (padded with `pad`), checked the way OpenSCAD 2021.01 does: a vec2 holding
 * something that is not a number is quietly ignored ('quiet'), any other bad value is ignored with a warning ('bad').
 * `finite` refuses nan / inf (translate, mirror; scale accepts them).
 */
function vecArg(v: Value, pad: number, finite = true): Vec3 | 'quiet' | 'bad' {
  if (!Array.isArray(v) || (v.length !== 2 && v.length !== 3)) return 'bad'
  if (v.length === 2 && !v.every(isNum)) return 'quiet'
  if (!v.every((x) => isNum(x) && (!finite || Number.isFinite(x)))) return 'bad'
  return [v[0] as number, v[1] as number, v.length === 3 ? v[2] as number : pad]
}


/** r or d (d wins, with OpenSCAD's warning); undefined when neither is a number */
function radius(c: ModuleCtx, r: string, d: string): number | undefined {
  const rv = c.args.get(r)
  const dv = c.args.get(d)
  if (isNum(dv)) {
    if (isNum(rv)) c.warn(`Ignoring radius variable '${r}' as diameter '${d}' is defined too.`)
    return dv / 2
  }
  return isNum(rv) ? rv : undefined
}

// ───── matrices (column-major, like JSCAD and 3Dica) ─────

const identity = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** rows[i][j] → column-major */
function fromRows(r: number[][]): Mat4 {
  const m = new Array(16).fill(0)
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) m[j * 4 + i] = r[i][j]
  return m
}

function mul(a: Mat4, b: Mat4): Mat4 {
  const m = new Array(16).fill(0)
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    let s = 0
    for (let k = 0; k < 4; k++) s += a[k * 4 + i] * b[j * 4 + k]
    m[j * 4 + i] = s
  }
  return m
}

const rotX = (a: number): Mat4 => { const c = cosDeg(a), s = sinDeg(a); return fromRows([[1, 0, 0, 0], [0, c, -s, 0], [0, s, c, 0], [0, 0, 0, 1]]) }
const rotY = (a: number): Mat4 => { const c = cosDeg(a), s = sinDeg(a); return fromRows([[c, 0, s, 0], [0, 1, 0, 0], [-s, 0, c, 0], [0, 0, 0, 1]]) }
const rotZ = (a: number): Mat4 => { const c = cosDeg(a), s = sinDeg(a); return fromRows([[c, -s, 0, 0], [s, c, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) }

/** rotation by `a` degrees about axis `v` (a zero axis is no rotation). The outer product is divided by the
 *  squared length instead of normalizing first, which keeps OpenSCAD's exact zeros (rotate(120, [1, 1, 1])). */
function rotAxis(a: number, v: Vec3): Mat4 {
  const [x, y, z] = v
  const n2 = x * x + y * y + z * z
  if (!(n2 > 0) || !Number.isFinite(n2)) return identity()
  const n = Math.sqrt(n2)
  const c = cosDeg(a), s = sinDeg(a), t = 1 - c
  const [ux, uy, uz] = [x / n, y / n, z / n]
  return fromRows([
    [c + t * x * x / n2, t * x * y / n2 - s * uz, t * x * z / n2 + s * uy, 0],
    [t * x * y / n2 + s * uz, c + t * y * y / n2, t * y * z / n2 - s * ux, 0],
    [t * x * z / n2 - s * uy, t * y * z / n2 + s * ux, c + t * z * z / n2, 0],
    [0, 0, 0, 1],
  ])
}

function transform(c: ModuleCtx, m: Mat4): GeomNode {
  return { kind: 'multmatrix', m, children: c.children(), pos: c.pos }
}

// ───── colors ─────

/** printf("%.1f"): an exact tie rounds to even, unlike toFixed */
function fixed1(x: number): string {
  const s = x.toFixed(1)
  const scaled = x * 10
  if (Math.abs(scaled - Math.trunc(scaled)) === 0.5) {
    const lo = Math.floor(scaled)
    const even = lo % 2 === 0 ? lo : lo + 1
    return (even / 10).toFixed(1)
  }
  return s
}

function parseHex(s: string): Rgba | null {
  if (!/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s)) return null
  const h = s.slice(1)
  const short = h.length <= 4
  const parts = short ? h.split('').map((x) => parseInt(x + x, 16)) : h.match(/../g)!.map((x) => parseInt(x, 16))
  return [parts[0] / 255, parts[1] / 255, parts[2] / 255, parts.length > 3 ? parts[3] / 255 : 1]
}

function colorNode(c: ModuleCtx): GeomNode {
  const cv = c.args.get('c')
  const av = c.args.get('alpha')
  let rgba: Rgba | null = null
  if (typeof cv === 'string') {
    const named = SVG_COLORS.get(cv.toLowerCase())
    rgba = named ? [named[0] / 255, named[1] / 255, named[2] / 255, named[3] ?? 1] : parseHex(cv)
    if (!rgba) c.warn(`Unable to parse color "${shortText(cv)}"`)
  } else if (Array.isArray(cv)) {
    rgba = [1, 1, 1, 1]
    for (let i = 0; i < 4 && i < cv.length; i++) rgba[i] = isNum(cv[i]) ? cv[i] as number : 0
    for (let i = 0; i < 4 && i < cv.length; i++) {
      if (isNum(cv[i]) && ((cv[i] as number) < 0 || (cv[i] as number) > 1)) c.warn(`color() expects numbers between 0.0 and 1.0. Value of ${fixed1(cv[i] as number)} is out of range`)
    }
  }
  if (rgba && isNum(av)) rgba[3] = av
  const children = c.children()
  // no usable color: the children keep whatever color they have
  if (!rgba) return { kind: 'group', children, pos: c.pos }
  const clamp = (x: number) => (Number.isNaN(x) ? 0 : Math.min(1, Math.max(0, x)))
  return { kind: 'color', rgba: [clamp(rgba[0]), clamp(rgba[1]), clamp(rgba[2]), clamp(rgba[3])], children, pos: c.pos }
}

// ───── the table ─────

const csg = (kind: 'union' | 'difference' | 'intersection' | 'hull' | 'minkowski' | 'group', params: string[] = []): BuiltinModule => ({
  params,
  run: (c) => ({ kind, children: c.children(), pos: c.pos }),
})

/** a module that reads files: refused with a clear error. Its parameters are known, so no "variable file not
 *  specified as parameter" warnings come before the error. */
const unsupported = (name: string, what: string, params: string[]): BuiltinModule => ({
  params,
  run: (c) => { throw c.error('runtime', `${name}() is not supported in 3Dica: OpenSCAD objects cannot read ${what}`) },
})

export const BUILTIN_MODULES = new Map<string, BuiltinModule>([
  ['cube', {
    leaf: 'warn',
    params: ['size', 'center'],
    run(c) {
      const s = c.args.get('size')
      let size: Vec3 = [1, 1, 1]
      if (isNum(s)) size = [s, s, s]
      else if (Array.isArray(s) && s.length === 3 && s.every(isNum)) size = s as Vec3
      else if (s !== undefined) c.warn(`Unable to convert cube(size=${shortValue(s)}, ...) parameter to a number or a vec3 of numbers`)
      if (!size.every(finitePos)) return empty(c)
      return { kind: 'cube', size, center: bool(c.args.get('center'), false), pos: c.pos }
    },
  }],
  ['sphere', {
    leaf: 'warn',
    params: ['r'],
    named: ['d'],
    run(c) {
      const r = radius(c, 'r', 'd') ?? 1
      return finitePos(r) ? { kind: 'sphere', r, frag: frag(c), pos: c.pos } : empty(c)
    },
  }],
  ['cylinder', {
    leaf: 'warn',
    params: ['h', 'r1', 'r2', 'center'],
    named: ['r', 'd', 'd1', 'd2'],
    run(c) {
      const h = num(c.args.get('h'), 1)
      const r = radius(c, 'r', 'd')
      const r1 = radius(c, 'r1', 'd1')
      const r2 = radius(c, 'r2', 'd2')
      if (r !== undefined && (r1 !== undefined || r2 !== undefined)) c.warn('Cylinder parameters ambiguous')
      const b = r1 ?? r ?? 1
      const t = r2 ?? r ?? 1
      if (!finitePos(h) || !(b >= 0 && t >= 0) || !Number.isFinite(b) || !Number.isFinite(t) || (b === 0 && t === 0)) return empty(c)
      return { kind: 'cylinder', h, r1: b, r2: t, center: bool(c.args.get('center'), false), frag: frag(c), pos: c.pos }
    },
  }],
  ['polyhedron', {
    leaf: 'warn',
    params: ['points', 'faces', 'convexity'],
    named: ['triangles'],
    run(c) {
      let faces = c.args.get('faces')
      if (faces === undefined && c.args.has('triangles')) {
        c.deprecated('polyhedron(triangles=[]) will be removed in future releases. Use polyhedron(faces=[]) instead.')
        faces = c.args.get('triangles')
      }
      const pts = c.args.get('points')
      if (!Array.isArray(pts) || !Array.isArray(faces)) return empty(c)
      const points: Vec3[] = pts.map((p, i) => {
        if (!Array.isArray(p) || p.length !== 3 || !p.every(isNum)) throw c.error('runtime', `Unable to convert points[${i}] = ${shortValue(p)} to a vec3 of numbers`)
        return p as Vec3
      })
      const out: number[][] = []
      faces.forEach((f, i) => {
        // a face that is not a list, or keeps fewer than 3 points, is still a face: the build reports it as
        // degenerate, as OpenSCAD does
        if (!Array.isArray(f)) { out.push([]); return }
        const face: number[] = []
        f.forEach((x, j) => {
          if (!isNum(x)) return
          const k = Math.trunc(x)
          if (k < 0 || k >= points.length || !Number.isFinite(x)) {
            const shown = k < 0 ? (BigInt(2) ** BigInt(64) + BigInt(k)).toString() : formatNumber(k)
            c.warn(`Point index ${shown} is out of bounds (from faces[${i}][${j}])`)
          } else face.push(k)
        })
        out.push(face)
      })
      return { kind: 'polyhedron', points, faces: out, pos: c.pos }
    },
  }],
  ['square', {
    leaf: 'warn',
    params: ['size', 'center'],
    run(c) {
      const s = c.args.get('size')
      let size: Vec2 = [1, 1]
      if (isNum(s)) size = [s, s]
      else if (Array.isArray(s) && s.length === 2 && s.every(isNum)) size = s as Vec2
      else if (s !== undefined) c.warn(`Unable to convert square(size=${shortValue(s)}, ...) parameter to a number or a vec2 of numbers`)
      if (!size.every(finitePos)) return empty(c)
      return { kind: 'square', size, center: bool(c.args.get('center'), false), pos: c.pos }
    },
  }],
  ['circle', {
    leaf: 'warn',
    params: ['r'],
    named: ['d'],
    run(c) {
      const r = radius(c, 'r', 'd') ?? 1
      return finitePos(r) ? { kind: 'circle', r, frag: frag(c), pos: c.pos } : empty(c)
    },
  }],
  ['polygon', {
    leaf: 'warn',
    params: ['points', 'paths', 'convexity'],
    run(c) {
      const pts = c.args.get('points')
      if (!Array.isArray(pts)) return empty(c)
      const points: Vec2[] = pts.map((p, i) => {
        if (!Array.isArray(p) || p.length !== 2 || !p.every(isNum)) throw c.error('runtime', `Unable to convert points[${i}] = ${shortValue(p)} to a vec2 of numbers`)
        return p as Vec2
      })
      const pv = c.args.get('paths')
      if (!Array.isArray(pv)) return { kind: 'polygon', points, pos: c.pos }
      const paths: number[][] = []
      pv.forEach((path, i) => {
        if (!Array.isArray(path)) return
        const out: number[] = []
        path.forEach((x, j) => {
          if (!isNum(x)) return
          const k = Math.trunc(x)
          if (k < 0 || k >= points.length || !Number.isFinite(x)) c.warn(`Point index ${k < 0 ? (BigInt(2) ** BigInt(64) + BigInt(k)).toString() : formatNumber(k)} is out of bounds (from paths[${i}][${j}])`)
          else out.push(k)
        })
        paths.push(out)
      })
      return { kind: 'polygon', points, paths, pos: c.pos }
    },
  }],
  ['text', {
    leaf: 'quiet',
    params: ['text', 'size', 'font'],
    named: ['direction', 'language', 'script', 'halign', 'valign', 'spacing'],
    run(c) {
      const t = c.args.get('text')
      const s = (k: string, d: string) => { const v = c.args.get(k); return typeof v === 'string' ? v : d }
      const halign = s('halign', 'left')
      const valign = s('valign', 'baseline')
      const direction = s('direction', 'ltr')
      return {
        kind: 'text',
        text: typeof t === 'string' ? t : '',
        size: num(c.args.get('size'), 10),
        font: s('font', ''),
        halign: halign === 'center' || halign === 'right' ? halign : 'left',
        valign: valign === 'top' || valign === 'center' || valign === 'bottom' ? valign : 'baseline',
        spacing: num(c.args.get('spacing'), 1),
        direction: direction === 'rtl' || direction === 'ttb' || direction === 'btt' ? direction : 'ltr',
        frag: frag(c),
        pos: c.pos,
      }
    },
  }],
  ['translate', {
    params: ['v'],
    run(c) {
      const v = c.args.get('v')
      const t = vecArg(v, 0)
      if (t === 'bad') c.warn(`Unable to convert translate(${shortValue(v)}) parameter to a vec3 or vec2 of numbers`)
      const [x, y, z] = Array.isArray(t) ? t : [0, 0, 0]
      return transform(c, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1])
    },
  }],
  ['rotate', {
    params: ['a', 'v'],
    run(c) {
      const a = c.args.get('a')
      const v = c.args.get('v')
      if (Array.isArray(a)) {
        if (v !== undefined) c.warn(`When parameter a is supplied as vector, v is ignored rotate(a=${shortValue(a)}, v=${shortValue(v)})`)
        if (!a.slice(0, 3).every((x) => isNum(x) && Number.isFinite(x))) c.warn(`Problem converting rotate(a=${shortValue(a)}) parameter`)
        const [x, y, z] = [0, 1, 2].map((i) => (isNum(a[i]) && Number.isFinite(a[i]) ? a[i] as number : 0))
        return transform(c, mul(rotZ(z), mul(rotY(y), rotX(x))))
      }
      if (!isNum(a) || !Number.isFinite(a)) {
        c.warn(`Problem converting rotate(a=${shortValue(a)}) parameter`)
        return transform(c, identity())
      }
      if (v === undefined) return transform(c, rotZ(a))
      const axis = vecArg(v, 0)
      if (!Array.isArray(axis)) {
        // an unusable axis: about z, as OpenSCAD does
        c.warn(`Problem converting rotate(..., v=${shortValue(v)}) parameter`)
        return transform(c, rotZ(a))
      }
      return transform(c, rotAxis(a, axis))
    },
  }],
  ['scale', {
    params: ['v'],
    run(c) {
      const v = c.args.get('v')
      const r = isNum(v) ? [v, v, v] as Vec3 : vecArg(v, 1, false)
      if (r === 'bad') c.warn(`Unable to convert scale(${shortValue(v)}) parameter to a number, a vec3 or vec2 of numbers or a number`)
      const s: Vec3 = Array.isArray(r) ? r : [1, 1, 1]
      return transform(c, [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1])
    },
  }],
  ['mirror', {
    params: ['v'],
    run(c) {
      const v = c.args.get('v')
      const r = vecArg(v, 0)
      if (r === 'bad') c.warn(`Unable to convert mirror(${shortValue(v)}) parameter to a vec3 or vec2 of numbers`)
      const n: Vec3 = Array.isArray(r) ? r : [1, 0, 0]
      // I - 2·n·nᵀ / (n·n), without a square root, so mirror([1, 1]) has exact zeros as in OpenSCAD
      const [x, y, z] = n
      const d = x * x + y * y + z * z
      if (!(d > 0) || !Number.isFinite(d)) return transform(c, identity())
      return transform(c, fromRows([
        [1 - 2 * x * x / d, -2 * x * y / d, -2 * x * z / d, 0],
        [-2 * x * y / d, 1 - 2 * y * y / d, -2 * y * z / d, 0],
        [-2 * x * z / d, -2 * y * z / d, 1 - 2 * z * z / d, 0],
        [0, 0, 0, 1],
      ]))
    },
  }],
  ['multmatrix', {
    params: ['m'],
    run(c) {
      const m = c.args.get('m')
      const rows = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
      if (Array.isArray(m)) {
        for (let i = 0; i < 4 && i < m.length; i++) {
          const row = m[i]
          if (!Array.isArray(row)) continue
          for (let j = 0; j < 4 && j < row.length; j++) if (isNum(row[j])) rows[i][j] = row[j] as number
        }
        // a 4×4 matrix is scaled so that its last element is 1, as in OpenSCAD
        const w = rows[3][3]
        if (m.length >= 4 && w !== 1 && w !== 0 && Number.isFinite(w)) for (const r of rows) for (let j = 0; j < 4; j++) r[j] /= w
      }
      return transform(c, fromRows(rows))
    },
  }],
  ['color', { params: ['c', 'alpha'], run: colorNode }],
  ['resize', {
    params: ['newsize', 'auto'],
    named: ['convexity'],
    run(c) {
      const ns = c.args.get('newsize')
      const size: Vec3 = [0, 0, 0]
      if (Array.isArray(ns)) for (let i = 0; i < 3 && i < ns.length; i++) if (isNum(ns[i])) size[i] = ns[i] as number
      const av = c.args.get('auto')
      const auto: [boolean, boolean, boolean] = [false, false, false]
      if (av === true) auto.fill(true)
      else if (Array.isArray(av)) for (let i = 0; i < 3 && i < av.length; i++) auto[i] = av[i] === true || (isNum(av[i]) && av[i] !== 0)
      return { kind: 'resize', size, auto, children: c.children(), pos: c.pos }
    },
  }],
  ['offset', {
    params: ['r', 'delta', 'chamfer'],
    run(c) {
      const r = c.args.get('r')
      const d = c.args.get('delta')
      const f = frag(c)
      const children = c.children()
      if (isNum(r)) return { kind: 'offset', r, chamfer: false, frag: f, children, pos: c.pos }
      if (isNum(d)) return { kind: 'offset', delta: d, chamfer: bool(c.args.get('chamfer'), false), frag: f, children, pos: c.pos }
      return { kind: 'offset', r: 1, chamfer: false, frag: f, children, pos: c.pos }
    },
  }],
  ['union', csg('union')],
  ['difference', csg('difference')],
  ['intersection', csg('intersection')],
  ['hull', csg('hull')],
  ['minkowski', csg('minkowski', ['convexity'])],
  ['render', csg('group', ['convexity'])],
  ['group', csg('group')],
  ['linear_extrude', {
    // OpenSCAD 2021.01's positional order still starts with the DXF file; a number there is the height
    params: ['file', 'layer', 'height', 'origin', 'scale', 'center', 'twist', 'slices'],
    named: ['convexity'],
    run(c) {
      const file = c.args.get('file')
      if (typeof file === 'string') throw c.error('runtime', 'linear_extrude(file = …) is not supported in 3Dica: OpenSCAD objects cannot read DXF files')
      if (isNum(file) && !c.args.has('height')) c.args.set('height', file)
      let height = num(c.args.get('height'), 100)
      if (!(height > 0)) height = 0
      const tw = c.args.get('twist')
      const twist = isNum(tw) && Number.isFinite(tw) ? tw : 0
      const sl = c.args.get('slices')
      const slices = isNum(sl) && Number.isFinite(sl) && Math.trunc(sl) >= 1 ? Math.trunc(sl) : undefined
      const sv = c.args.get('scale')
      let scale: Vec2 = [1, 1]
      if (isNum(sv)) scale = [sv, sv]
      else if (Array.isArray(sv) && sv.length === 2 && sv.every(isNum)) scale = sv as Vec2
      scale = [Math.max(0, scale[0]), Math.max(0, scale[1])]
      const children = c.children()
      if (!(height > 0) || !Number.isFinite(height)) return { kind: 'group', children: [], pos: c.pos }
      return { kind: 'linear_extrude', height, center: bool(c.args.get('center'), false), twist, slices, scale, frag: frag(c), children, pos: c.pos }
    },
  }],
  ['rotate_extrude', {
    params: ['file'],
    named: ['layer', 'origin', 'scale', 'angle', 'convexity'],
    run(c) {
      if (c.args.get('file') !== undefined) {
        c.warn(`rotate_extrude(${shortValue(c.args.get('file'))}) reads a DXF file, which 3Dica does not support: give the angle by name, rotate_extrude(angle = …)`)
        return empty(c)
      }
      const a = c.args.get('angle')
      const angle = isNum(a) && Number.isFinite(a) ? Math.max(-360, Math.min(360, a)) : 360
      return { kind: 'rotate_extrude', angle, frag: frag(c), children: c.children(), pos: c.pos }
    },
  }],
  ['projection', {
    params: ['cut'],
    named: ['convexity'],
    run: (c) => ({ kind: 'projection', cut: bool(c.args.get('cut'), false), children: c.children(), pos: c.pos }),
  }],
  ['import', unsupported('import', 'STL, OFF, DXF or SVG files', ['file', 'layer', 'convexity', 'origin', 'scale', 'width', 'height', 'filename', 'layername', 'center', 'dpi', 'id'])],
  ['surface', unsupported('surface', 'height-map files', ['file', 'center', 'convexity', 'invert'])],
])
