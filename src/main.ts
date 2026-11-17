// Boot (§6, §7): load project → Store → EvalClient → Viewport → Commands → Controller → panels → shortcuts →
// autosave subscription → window.__3dica (§9.1).
import './styles.css'
import type { AppContext, Commands, ControllerApi, TestApi } from './app/context'
import { createEvents, readUrlParams } from './app/context'
import type { Project } from './core/types'
import { Store } from './state/store'
import { Clipboard } from './state/clipboard'
import { Autosave, uiPrefsFrom, type UiPrefs } from './state/autosave'
import { watchOtherTabs } from './state/tabs'
import { EvalClient } from './eval/client'
import { createViewport } from './view/viewport'
import { createCommands } from './app/commands'
import { createController } from './app/controller'
import { confirmDialog, problemsDialog, toast } from './ui/dom'
import { files } from './io/files'
import { mount as mountToolbar } from './ui/toolbar'
import { mount as mountTree } from './ui/tree'
import { mount as mountLibrary } from './ui/library'
import { mount as mountInspector } from './ui/inspector'
import { mount as mountBreadcrumb } from './ui/breadcrumb'
import { mount as mountStatusbar } from './ui/statusbar'
import { mount as mountRightTabs } from './ui/right-tabs'
import { mount as mountChat } from './ui/chat'
import { install as installShortcuts } from './ui/shortcuts'
import { startMcpBridge } from './mcp/bridge'

declare global {
  interface Window { __3dica?: TestApi }
}

/** A job running at least this long sets the autosave crash marker (see Autosave.markEvaluating). */
const CRASH_MARK_MS = 500

const byId = (id: string): HTMLElement => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`#${id} is missing from index.html`)
  return el
}

function boot(): void {
  const params = readUrlParams(location.search)
  const events = createEvents()

  // §6 boot: ?fresh → sample; else current → backups (newest first) → sample
  const autosave = new Autosave({
    onUnavailable: () => toast('Autosave unavailable', 'warn'),
    onSaved: (at) => events.emit('saved', at),
  })
  const restored = autosave.boot(location.search)

  const store = new Store(restored.project, restored.ui, { onError: (m) => toast(m, 'error') })
  const client = new EvalClient({
    timeoutMs: params.evalTimeoutMs,
    spawn: () => new Worker(new URL('./eval/worker.ts', import.meta.url), { type: 'module' }),
  })
  const viewport = createViewport()

  const ctx: AppContext = {
    store, client, viewport,
    commands: null as unknown as Commands,
    controller: null as unknown as ControllerApi,
    clipboard: new Clipboard(),
    files,
    toast, confirm: confirmDialog, problems: problemsDialog,
    on: events.on, emit: events.emit,
    params,
  }
  ctx.commands = createCommands(ctx)
  ctx.controller = createController(ctx)
  client.onStatus((s) => {
    // crash marker: a job that runs this long may be the one that takes the tab down (a worker out-of-memory kills
    // the whole page). If the page dies with the marker set, the next boot restores the project with its code paused.
    const r = s.running
    autosave.markEvaluating(r && r.ms >= CRASH_MARK_MS ? r.defName : null)
    ctx.emit('evalStatus', s)
  })

  // view first, then the overlay panel on the same element (§4.1, context.ts MountPanel)
  const view = byId('view')
  viewport.mount(view, ctx)
  if (restored.prefs?.camera) viewport.setCamera(restored.prefs.camera)
  mountBreadcrumb(view, ctx)
  mountToolbar(byId('toolbar'), ctx)
  mountTree(byId('tree'), ctx)
  mountLibrary(byId('library'), ctx)
  mountInspector(byId('inspector'), ctx)
  // the right column's tabs: [Inspector] [Chat] (Ctrl+L); the chat acts on the project through the same tools as MCP
  const rightTabs = mountRightTabs(byId('right-tabs'), { inspector: byId('inspector'), chat: byId('chat') })
  mountChat(byId('chat'), ctx, rightTabs)
  // local MCP bridge for AI assistants: opt-in with ?mcp, localhost only (src/mcp/config.ts); its pill lives in the status bar
  ctx.mcp = startMcpBridge(ctx)
  mountStatusbar(byId('status'), ctx)
  installShortcuts(ctx)

  // §6 autosave: project 1 s after the last commit; ui prefs (expanded rows, gizmo, snap, ghost, camera) debounced
  let lastPrefs = JSON.stringify(uiPrefsFrom(store.ui, viewport.getCamera()))
  const savePrefs = (prefs: UiPrefs) => {
    const s = JSON.stringify(prefs)
    if (s === lastPrefs) return
    lastPrefs = s
    autosave.scheduleUi(prefs)
  }
  // evalPaused ("Open without running") is saved WITH the project: a reload must not run untrusted code (§0.2)
  let savedPaused = store.ui.evalPaused
  store.subscribe((ch) => {
    const paused = store.ui.evalPaused
    if (ch.project || paused !== savedPaused) {
      savedPaused = paused
      autosave.schedule(store.project, { paused })
    }
    if (ch.ui) savePrefs(uiPrefsFrom(store.ui, viewport.getCamera()))
  })
  viewport.onCameraChange((camera) => savePrefs(uiPrefsFrom(store.ui, camera)))
  const leaving = () => {
    ctx.emit('flushCode', undefined) // the code editor's 400 ms debounce: an edit typed just before F5 is kept
    autosave.flush()
    autosave.markEvaluating(null) // a normal close / reload while evaluating is not a crash
  }
  window.addEventListener('pagehide', leaving)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { ctx.emit('flushCode', undefined); autosave.flush() }
  })
  watchOtherTabs(() => toast('3Dica is also open in another tab. Both tabs autosave to the same slot and the last one to save wins — close one of them, or Save to keep a copy.', 'warn'))

  // §9.1 test API (always installed)
  const fresh = () => {
    const rs = ctx.controller.current()
    return rs.project === store.project && rs.ui === store.ui ? rs : ctx.controller.run()
  }
  const defByName = (name: string) => Object.values(store.project.defs).find((d) => d.name === name)
  const api: TestApi = {
    ready: false,
    async idle() {
      ctx.emit('flushCode', undefined) // a debounced editor edit is part of "the app settling"
      await ctx.controller.idle()
    },
    project: (): Project => structuredClone(store.project),
    ui: () => {
      const u = store.ui
      return structuredClone({ selection: u.selection, context: u.context, viewMode: u.viewMode, ghostOthers: u.ghostOthers, gizmoMode: u.gizmoMode, snap: u.snap })
    },
    stats: () => {
      const rs = fresh()
      const v = viewport.stats()
      const c = client.stats()
      return { occurrences: rs.occurrences.length, meshes: v.meshes, geometries: c.entriesInUse, triangles: v.triangles, pending: c.queued + c.inFlight, failed: c.failed }
    },
    occurrencesOf: (name) => {
      const d = defByName(name)
      return d ? fresh().counts.get(d.id) ?? 0 : 0
    },
    defStatus: (name) => {
      const d = defByName(name)
      return (d && fresh().defStates.get(d.id)?.status) || 'idle'
    },
    defError: (name) => {
      const d = defByName(name)
      const e = d ? fresh().defStates.get(d.id)?.error : undefined
      return e ? structuredClone(e) : undefined
    },
    objectPixels: () => viewport.objectPixels(),
    gizmoAxisScreen: (axis, along) => viewport.gizmoAxisScreen(axis, along),
    history: () => store.history.labels(),
    view: () => viewport.debugView(),
  }
  window.__3dica = api

  ctx.controller.run()
  if (restored.message) toast(restored.message)
  api.ready = true
}

boot()
