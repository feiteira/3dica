// §4.1 status bar (bottom, 24 px): "Evaluating 2 · last 60 ms (Plate) · 14 meshes · 61,234 tris · saved 12:01:33".
import type { AppContext, EvalStatus, McpBridgeApi, McpState, MountPanel, RenderState } from '../app/context'
import { fmtInt, h, plural, setText } from './dom'

const two = (n: number) => String(n).padStart(2, '0')
const clock = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`

export const mount: MountPanel = (el: HTMLElement, ctx: AppContext) => {
  el.classList.add('statusbar')
  const dot = h('span', { class: 'sb-dot' })
  const evalText = h('span', { class: 'sb-eval-text' })
  const evalEl = h('span', { class: 'sb-item sb-eval', 'data-testid': 'status-eval' }, dot, evalText)
  const failedEl = h('span', { class: 'sb-item sb-failed', 'data-testid': 'status-failed' })
  const selEl = h('span', { class: 'sb-item sb-sel muted', 'data-testid': 'status-selection' })
  const sceneEl = h('span', { class: 'sb-item sb-scene', 'data-testid': 'status-scene' })
  const savedEl = h('span', { class: 'sb-item sb-saved muted', 'data-testid': 'status-saved' })
  el.append(evalEl, failedEl, selEl, h('span', { class: 'spacer' }), sceneEl, savedEl)
  if (ctx.mcp) el.append(mcpPill(ctx.mcp))

  let status: EvalStatus = (() => { try { return ctx.client.status() } catch { return { queued: 0, alive: false } } })()
  let paused = false

  const showEval = () => {
    let state: string
    let text: string
    if (status.fatal) { state = 'error'; text = status.fatal }
    else if (paused) { state = 'paused'; text = 'Paused — code not run' }
    else {
      const n = status.queued + (status.running ? 1 : 0)
      const parts: string[] = []
      if (n > 0) {
        state = 'busy'
        parts.push(`Evaluating ${n}`)
        if (status.running && status.running.ms >= 1000) parts.push(`${status.running.defName} ${(status.running.ms / 1000).toFixed(1)} s`)
      } else if (!status.alive) {
        state = 'busy'
        parts.push('Starting evaluator…')
      } else {
        state = 'ok'
        parts.push('Ready')
      }
      if (status.last) parts.push(`last ${Math.round(status.last.ms)} ms (${status.last.defName})`)
      text = parts.join(' · ')
    }
    evalEl.dataset.state = state
    setText(evalText, text)
  }

  const render = (rs: RenderState) => {
    paused = rs.ui.evalPaused
    showEval()
    let failed = 0
    try { failed = ctx.client.stats().failed } catch { failed = 0 }
    failedEl.hidden = failed === 0
    setText(failedEl, failed ? `${plural(failed, 'error')}` : '')
    let meshes = 0, tris = 0
    try { const s = ctx.viewport.stats(); meshes = s.meshes; tris = s.triangles } catch { /* not mounted */ }
    setText(sceneEl, `${plural(meshes, 'mesh', 'meshes')} · ${fmtInt(tris)} tris`)
    const ui = rs.ui
    let sel = ''
    if (ui.viewMode === 'isolate' && rs.isolate) sel = 'Isolate'
    else if (ui.context.length) sel = `Inside ${rs.byKey.get(ui.context.join('/'))?.instance.name ?? rs.byKey.get(ui.context.join('/'))?.def.name ?? 'group'}`
    setText(selEl, sel)
    selEl.hidden = !sel
  }

  ctx.on('evalStatus', (s) => { status = s; showEval() })
  ctx.on('saved', (d) => setText(savedEl, `saved ${clock(d)}`))
  ctx.on('render', render)
  render(ctx.controller.current())
}

// ───────────────────────────── MCP pill (only while the bridge is enabled, src/mcp/bridge.ts) ─────────────────────────────

const MCP_TEXT: Record<McpState, string> = {
  off: '', connecting: 'MCP · connecting…', connected: 'MCP · connected', superseded: 'MCP · superseded',
}

function mcpInfo(mcp: McpBridgeApi): string {
  const s = mcp.state()
  if (s === 'connected') return `An AI assistant can use this tab through the 3Dica MCP server (port ${mcp.port}). Its changes are in Undo as "MCP: …".`
  if (s === 'superseded') return 'A newer 3Dica tab is connected to the MCP server, so this tab is idle.'
  return `Waiting for the 3Dica MCP server on port ${mcp.port} (node mcp/server.mjs) — it retries on its own.`
}

function mcpPill(mcp: McpBridgeApi): HTMLElement {
  const text = h('span', { class: 'sb-mcp-text' })
  const btn = h('button', {
    type: 'button', class: 'sb-mcp', 'data-testid': 'mcp-pill', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
  }, h('span', { class: 'sb-mcp-dot' }), text)
  let menu: HTMLElement | null = null
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); btn.focus() } }
  const onDown = (e: PointerEvent) => { if (menu && !menu.contains(e.target as Node) && !btn.contains(e.target as Node)) close() }
  const close = () => {
    if (!menu) return
    menu.remove()
    menu = null
    btn.setAttribute('aria-expanded', 'false')
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('pointerdown', onDown, true)
  }
  const open = () => {
    const last = mcp.lastAction()
    const two = (n: number) => String(n).padStart(2, '0')
    const item = (label: string, testid: string, run: () => void) =>
      h('button', { type: 'button', role: 'menuitem', class: 'sb-mcp-item', 'data-testid': testid, onclick: () => { close(); run() } }, label)
    menu = h('div', { class: 'sb-mcp-menu', role: 'menu', 'data-testid': 'mcp-menu', 'aria-label': 'MCP connection' },
      h('div', { class: 'sb-mcp-info' }, mcpInfo(mcp)),
      last ? h('div', { class: 'sb-mcp-last' }, `Last change: ${last.label} · ${two(last.at.getHours())}:${two(last.at.getMinutes())}:${two(last.at.getSeconds())}`) : null,
      mcp.state() === 'superseded' ? item('Use this tab', 'mcp-claim', () => mcp.claim()) : null,
      item('Disconnect and disable', 'mcp-disable', () => mcp.disable()))
    document.body.append(menu)
    const r = btn.getBoundingClientRect()
    Object.assign(menu.style, { right: `${Math.max(8, window.innerWidth - r.right)}px`, bottom: `${window.innerHeight - r.top + 6}px` })
    btn.setAttribute('aria-expanded', 'true')
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown, true)
    ;(menu.querySelector('button') as HTMLButtonElement | null)?.focus()
  }
  btn.addEventListener('click', () => (menu ? close() : open()))
  const render = () => {
    const s = mcp.state()
    btn.dataset.state = s
    setText(text, MCP_TEXT[s])
    btn.hidden = s === 'off'
    btn.title = mcpInfo(mcp)
    if (s === 'off') close()
  }
  mcp.onChange(render)
  render()
  return btn
}
