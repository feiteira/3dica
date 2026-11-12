// §4.3 / §4.4 viewport overlays, mounted on #view after the viewport: the breadcrumb (top-left,
// "Scene › Fixture A ◆2 › Washer ◆8"), the isolate banner (top-center, isolate only), a "code paused" notice and a
// small interaction hint (bottom-left). The overlay layer ignores the pointer except on its buttons.
import type { AppContext, MountPanel, RenderState } from '../app/context'
import { resolvePath } from '../core/graph'
import { breadcrumbPath, breadcrumbTitle } from '../core/selection'
import { h, setText } from './dom'
import { icon } from './icons'

export const mount: MountPanel = (el: HTMLElement, ctx: AppContext) => {
  const crumbs = h('nav', { class: 'crumbs', 'data-testid': 'breadcrumb', 'aria-label': 'Selection path' })
  const bannerText = h('span', { class: 'iso-text' })
  const exitIso = h('button', { type: 'button', class: 'iso-exit', 'data-testid': 'isolate-exit', title: 'Back to the scene (I or Esc)' }, icon('close'))
  exitIso.addEventListener('click', () => { ctx.commands.toggleIsolate(); exitIso.blur() })
  const banner = h('div', { class: 'iso-banner', 'data-testid': 'isolate-banner', role: 'status' }, icon('isolate'), bannerText, exitIso)
  const runBtn = h('button', { type: 'button', class: 'btn btn-sm btn-primary', 'data-testid': 'paused-run' }, icon('play'), 'Run code')
  runBtn.addEventListener('click', () => { ctx.commands.runCode(); runBtn.blur() })
  const paused = h('div', { class: 'paused-banner', 'data-testid': 'paused-banner', role: 'status' },
    icon('warn'), h('span', null, "This project's code has not run. Run it only if you trust the file."), runBtn)
  const hint = h('div', { class: 'view-hint' })
  const layer = h('div', { class: 'view-overlay' }, crumbs, banner, paused, hint)
  el.appendChild(layer)

  let crumbSig = ''
  const render = (rs: RenderState) => {
    const ui = rs.ui
    const path = breadcrumbPath(ui)
    const steps = path.length ? resolvePath(rs.project, path) ?? [] : []
    const segs = steps.map((s) => ({ name: s.instance.name ?? s.def.name, n: rs.counts.get(s.def.id) ?? 0 }))
    const selected = ui.selection.kind === 'occ' && ui.selection.path.length === path.length && path.length > 0
    const sig = JSON.stringify([segs, ui.context.length, selected])
    if (sig !== crumbSig) {
      crumbSig = sig
      const items: Node[] = []
      const labels = segs.map((s) => s.name)
      const mk = (j: number, label: string, n: number, cls: string) => {
        const b = h('button', { type: 'button', class: `crumb ${cls}`, 'data-testid': `crumb-${j}`, 'data-index': j,
          title: breadcrumbTitle(labels, j) }, label, n > 1 ? h('span', { class: 'badge' }, `◆${n}`) : null)
        b.addEventListener('click', () => { ctx.commands.selectBreadcrumb(j); b.blur() })
        return b
      }
      items.push(mk(0, 'Scene', 0, ui.context.length === 0 ? 'in-ctx' : ''))
      segs.forEach((s, i) => {
        const j = i + 1
        items.push(h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '›'))
        const isLast = j === segs.length
        const cls = isLast && selected ? 'sel' : j <= ui.context.length ? 'ctx' : ''
        items.push(mk(j, s.name, s.n, cls))
      })
      crumbs.replaceChildren(...items)
    }
    crumbs.hidden = ui.viewMode === 'isolate'

    banner.hidden = !rs.isolate
    if (rs.isolate) setText(bannerText, rs.isolate.banner)

    paused.hidden = !ui.evalPaused
    hint.hidden = ui.evalPaused

    const text = ui.viewMode === 'isolate'
      ? 'Isolated: the definition alone at the origin · I or Esc to return'
      : ui.context.length
        ? 'Inside a group · click outside to leave · Esc steps out'
        : 'Click to select · Ctrl+click: deepest part · double-click: enter group · F: frame'
    setText(hint, text)
  }
  ctx.on('render', render)
  render(ctx.controller.current())
}
