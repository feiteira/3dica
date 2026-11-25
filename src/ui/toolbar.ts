// §4.1 toolbar: [Cube][Sphere][Cyl][Torus][Code][OpenSCAD][Group] │ [∪][−][∩] │ [W][E][R] [World/Local] [Snap] │
// [Ghost][Isolate][Frame] │ [↶][↷] │ [New][Sample][Open][Import][Save][STL] │ [Run code]* (only while evalPaused).
// Also wires files dropped on the window: .scad files are imported, a project file is opened.
import type { AppContext, MountPanel, RenderState } from '../app/context'
import type { TemplateKind } from '../core/templates'
import { h, setAttrIfChanged, setText } from './dom'
import { icon, type IconName } from './icons'

interface BtnSpec {
  id: string
  icon: IconName
  label?: string
  tip: string
  run: () => void
  cls?: string
}

function button(spec: BtnSpec): HTMLButtonElement {
  const b = h('button', {
    type: 'button', class: `tb-btn ${spec.label ? '' : 'tb-icon-only'} ${spec.cls ?? ''}`.trim(),
    'data-testid': spec.id, title: spec.tip, 'aria-label': spec.label ?? spec.tip,
  }, icon(spec.icon), spec.label ? h('span', { class: 'tb-label' }, spec.label) : null)
  b.addEventListener('click', () => {
    spec.run()
    // give the keyboard back to the app shortcuts (Enter / Space would otherwise re-press the button)
    b.blur()
  })
  return b
}

const sep = () => h('span', { class: 'tb-sep', role: 'separator' })

export const MANUAL_URL = 'https://feiteira.github.io/3dica/manual/'

export const mount: MountPanel = (el: HTMLElement, ctx: AppContext) => {
  const c = ctx.commands
  el.classList.add('toolbar')
  el.setAttribute('role', 'toolbar')
  el.setAttribute('aria-label', '3Dica tools')

  const add = (kind: TemplateKind, ic: IconName, label: string, what: string) =>
    button({ id: `add-${kind}`, icon: ic, label, tip: `Add ${what} to the current group`, run: () => c.addTemplate(kind) })

  const wrapUnion = button({ id: 'wrap-union', icon: 'union', tip: 'Wrap the selection in a Union (∪)', run: () => c.wrap('union') })
  const wrapSub = button({ id: 'wrap-subtract', icon: 'subtract', tip: 'Wrap the selection in a Subtract (−): child 0 minus the others', run: () => c.wrap('subtract') })
  const wrapInt = button({ id: 'wrap-intersect', icon: 'intersect', tip: 'Wrap the selection in an Intersect (∩)', run: () => c.wrap('intersect') })

  const modeT = button({ id: 'mode-translate', icon: 'move', tip: 'Move (W)', run: () => c.setGizmoMode('translate') })
  const modeR = button({ id: 'mode-rotate', icon: 'rotate', tip: 'Rotate (E)', run: () => c.setGizmoMode('rotate') })
  const modeS = button({ id: 'mode-scale', icon: 'scale', tip: 'Scale (R)', run: () => c.setGizmoMode('scale') })
  const space = button({ id: 'space', icon: 'world', label: 'World', tip: 'Gizmo space: world / local (Q)', run: () => c.toggleSpace(), cls: 'tb-space' })
  const snap = button({ id: 'snap', icon: 'snap', label: 'Snap', tip: 'Snap 1 mm / 15° / 0.1 (X) — hold Ctrl while dragging to suspend', run: () => c.toggleSnap() })

  const ghost = button({ id: 'ghost', icon: 'ghost', label: 'Ghost', tip: 'Ghost everything outside the selection (G)', run: () => c.toggleGhost() })
  const isolate = button({ id: 'isolate', icon: 'isolate', label: 'Isolate', tip: 'Show the selected definition alone at the origin (I)', run: () => c.toggleIsolate() })
  const frame = button({ id: 'frame', icon: 'frame', label: 'Frame', tip: 'Frame the selection (F) · everything (Home)', run: () => c.frame() })

  const undo = button({ id: 'undo', icon: 'undo', tip: 'Undo (Ctrl+Z)', run: () => c.undo() })
  const redo = button({ id: 'redo', icon: 'redo', tip: 'Redo (Ctrl+Shift+Z)', run: () => c.redo() })

  const newBtn = button({ id: 'new', icon: 'new', label: 'New', tip: 'New empty project', run: () => { void c.newProject() } })
  const sample = button({ id: 'sample', icon: 'sample', label: 'Sample', tip: "Load the sample project 'Bracket kit'", run: () => { void c.loadSample() } })
  const open = button({ id: 'open', icon: 'open', label: 'Open', tip: 'Open a .3dica.json file (Ctrl+O) — or drop one on the window', run: () => { void c.open() } })
  const importBtn = button({ id: 'import', icon: 'import', label: 'Import', tip: 'Add OpenSCAD .scad files to the project as objects — several at once, or drop them on the window', run: () => { void c.importScad() } })
  const save = button({ id: 'save', icon: 'save', label: 'Save', tip: 'Download the project as .3dica.json (Ctrl+S)', run: () => c.save() })
  const stl = button({ id: 'export-stl', icon: 'stl', label: 'STL', tip: 'Export the selection (or the whole scene) as binary STL', run: () => { void c.exportStl() } })
  const run = button({ id: 'run-code', icon: 'play', label: 'Run code', tip: "This project's code has not run yet — run it now (Ctrl+Enter)", run: () => c.runCode(), cls: 'tb-run' })

  // The manual is published next to the app on GitHub Pages (<site>/manual/). A dev server has no built manual, so link the published one.
  const manual = h('a', {
    class: 'tb-btn tb-manual', href: import.meta.env.DEV ? MANUAL_URL : './manual/', target: '_blank', rel: 'noopener',
    'data-testid': 'manual', title: 'Open the 3Dica manual in a new tab', 'aria-label': 'Manual',
  }, icon('book'), h('span', { class: 'tb-label' }, 'Manual'))

  const brand = h('div', { class: 'brand', title: '3Dica — a JSCAD workbench with linked components' },
    h('span', { class: 'brand-mark' }, '3D'), h('span', { class: 'brand-name' }, 'ica'))

  el.append(
    brand,
    h('div', { class: 'tb-group' }, add('cube', 'cube', 'Cube', 'a cube'), add('sphere', 'sphere', 'Sphere', 'a sphere'),
      add('cylinder', 'cylinder', 'Cyl', 'a cylinder'), add('torus', 'torus', 'Torus', 'a torus'),
      add('code', 'code', 'Code', 'a blank code object'), add('openscad', 'scad', 'OpenSCAD', 'a blank OpenSCAD object'),
      add('group', 'group', 'Group', 'an empty group')),
    sep(),
    h('div', { class: 'tb-group' }, wrapUnion, wrapSub, wrapInt),
    sep(),
    h('div', { class: 'tb-group' }, modeT, modeR, modeS, space, snap),
    sep(),
    h('div', { class: 'tb-group tb-view' }, ghost, isolate, frame),
    sep(),
    h('div', { class: 'tb-group' }, undo, redo),
    sep(),
    h('div', { class: 'tb-group tb-file' }, newBtn, sample, open, importBtn, save, stl),
    h('div', { class: 'tb-group tb-run-group' }, run),
    h('div', { class: 'tb-group tb-help' }, manual),
  )

  const pressed = (b: HTMLButtonElement, on: boolean) => {
    setAttrIfChanged(b, 'aria-pressed', on ? 'true' : 'false')
    b.classList.toggle('on', on)
  }
  let lastSpace = ''
  const render = (rs: RenderState) => {
    const ui = rs.ui
    pressed(modeT, ui.gizmoMode === 'translate')
    pressed(modeR, ui.gizmoMode === 'rotate')
    pressed(modeS, ui.gizmoMode === 'scale')
    if (lastSpace !== ui.gizmoSpace) {
      lastSpace = ui.gizmoSpace
      const local = ui.gizmoSpace === 'local'
      space.replaceChildren(icon(local ? 'local' : 'world'), h('span', { class: 'tb-label' }, local ? 'Local' : 'World'))
      space.classList.toggle('on', local)
    }
    pressed(snap, ui.snap)
    pressed(ghost, ui.ghostOthers)
    pressed(isolate, ui.viewMode === 'isolate')
    const occ = ui.selection.kind === 'occ'
    for (const b of [wrapUnion, wrapSub, wrapInt]) b.disabled = !occ

    const h0 = ctx.store.history
    const ul = h0.undoLabel()
    const rl = h0.redoLabel()
    undo.disabled = !ul
    redo.disabled = !rl
    setAttrIfChanged(undo, 'title', ul ? `Undo ${ul} (Ctrl+Z)` : 'Nothing to undo (Ctrl+Z)')
    setAttrIfChanged(redo, 'title', rl ? `Redo ${rl} (Ctrl+Shift+Z)` : 'Nothing to redo (Ctrl+Shift+Z)')
    setAttrIfChanged(undo, 'aria-label', ul ? `Undo ${ul}` : 'Undo')
    setAttrIfChanged(redo, 'aria-label', rl ? `Redo ${rl}` : 'Redo')

    run.hidden = !ui.evalPaused
    el.classList.toggle('has-run', ui.evalPaused)
    setText(run.querySelector('.tb-label')!, 'Run code')
  }
  ctx.on('render', render)
  render(ctx.controller.current())

  // §6: a project file dropped anywhere on the window opens it; .scad files are imported into the project
  ctx.files.onWindowDrop((_file, all) => { void c.dropFiles(all) })
}
