// src/app/commands.ts — one method per user action (§4.2–§4.13, §6). Shortcuts, toolbar, tree, library, inspector
// and the viewport all call these. Every project edit is ONE store.update (one undo step); OpErrors become error
// toasts through store.onError. Selection / view changes go through store.setUi and never enter history.
import type { AppContext, Commands, DragPayload, DropTarget, RenameTarget, RenderState, ViewPreset } from './context'
import type { GroupOp, Id, Instance, InstancePath, ParamDef, ParamValue, Project, Transform, UiState } from '../core/types'
import { IDENTITY_XF } from '../core/types'
import * as ops from '../core/ops'
import { checkDefName, linkedOffset } from '../core/ops'
import {
  defAtPath, instanceAtPath, instancesOf, isPrefix, linkedChangeMessage, occurrenceCount, pathKey, referrers, resolvePath, samePath,
  wouldCycle,
} from '../core/graph'
import { createTemplateDef, placementFor, TEMPLATES, type TemplateKind } from '../core/templates'
import { breadcrumbPatch, enterPatch, escapePatch, librarySelectPatch, pickPatch, treeSelectPatch, type PickMods } from '../core/selection'
import { emptyProject, hasCode, parseProject, serialize } from '../core/project-io'
import { sampleProject, SAMPLE_EXPANDED } from '../core/sample'
import { computeStlItems, stlFileName } from '../core/evalspec'
import { paramDefProblems } from '../core/params'
import { cloneXf } from '../core/transform'
import { newId } from '../core/ids'
import { clipFromPath } from '../state/clipboard'

const MODE_VERB: Record<UiState['gizmoMode'], string> = { translate: 'Move', rotate: 'Rotate', scale: 'Scale' }
const WRAP_LABEL: Record<GroupOp, string> = { none: 'Group', union: 'Union', subtract: 'Subtract', intersect: 'Intersect' }

/** File name without characters that file systems reject. */
function safeFileName(name: string): string {
  return (name.trim() || 'Untitled').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function createCommands(ctx: AppContext): Commands {
  /** palette counter for new code objects (§3.2 PALETTE[n++ % 8]) */
  let colorIndex = 0
  /** Ctrl+C remembers the paste offset (§4.5) */
  let copyDx: number | null = null

  const P = (): Project => ctx.store.project
  const U = (): UiState => ctx.store.ui

  const selectedPath = (): InstancePath | null => {
    const s = U().selection
    return s.kind === 'occ' ? s.path : null
  }
  const needOcc = (hint = 'Select an object first'): InstancePath | null => {
    const p = selectedPath()
    if (!p) ctx.toast(hint)
    return p
  }
  const nameAt = (project: Project, path: InstancePath): string => {
    const steps = resolvePath(project, path)
    if (!steps || steps.length === 0) return 'object'
    const last = steps[steps.length - 1]
    return last.instance.name ?? last.def.name
  }
  /** def id of the group holding the instance at the end of `path` */
  const parentDefOf = (project: Project, path: InstancePath): Id | undefined =>
    path.length <= 1 ? project.root : defAtPath(project, path.slice(0, -1))?.id
  /** §4.5 linked toast after an edit that changed group def `defId` (only non-root groups with > 1 occurrence). */
  const linkedToast = (defId: Id | undefined, verb: 'Changed' | 'Added to' = 'Changed') => {
    if (!defId) return
    const project = P()
    const def = project.defs[defId]
    if (!def || def.kind !== 'group' || defId === project.root) return
    const msg = linkedChangeMessage(project, defId, verb)
    if (msg) ctx.toast(msg)
  }
  const box = (path: InstancePath) => {
    try { return ctx.viewport.occurrenceBox(path, 'parent') } catch { return null }
  }
  const widthX = (path: InstancePath): number | null => {
    const b = box(path)
    return b && Number.isFinite(b.max[0] - b.min[0]) ? b.max[0] - b.min[0] : null
  }
  /** Select a new / moved occurrence in context mode (gizmo attached), like a tree click. */
  const selectNew = (path: InstancePath) => {
    ctx.store.setUi((ui) => ({ ...treeSelectPatch(ui, path), viewMode: 'context', autoIsolatedFrom: undefined }))
  }
  /** Smart-frame `path` once it has been evaluated (its bbox is unknown until then). */
  const frameWhenReady = (path: InstancePath) => {
    const key = pathKey(path)
    void ctx.controller.idle().then(() => {
      const s = U().selection
      if (s.kind === 'occ' && pathKey(s.path) === key && U().viewMode === 'context') ctx.viewport.frameIfNeeded(path)
    }).catch(() => {})
  }
  const frameAllWhenReady = () => {
    void ctx.controller.idle().then(() => ctx.viewport.frameAll()).catch(() => {})
  }
  const renderState = (): RenderState => {
    const rs = ctx.controller.current()
    return rs.project === P() && rs.ui === U() ? rs : ctx.controller.run()
  }
  const selectedDefId = (): Id | undefined => {
    const s = U().selection
    if (s.kind === 'def') return s.def
    if (s.kind === 'occ') return defAtPath(P(), s.path)?.id
    return undefined
  }
  const freshUi = (extra: Partial<UiState> = {}): Partial<UiState> => ({
    selection: { kind: 'none' }, context: [], viewMode: 'context', evalPaused: false, autoIsolatedFrom: undefined, expanded: {}, ...extra,
  })

  const commands: Commands = {
    // ───────────────────────────── create / structure (§4.2) ─────────────────────────────
    addTemplate(kind: TemplateKind) {
      const project = P()
      const ctxPath = U().context
      const target = defAtPath(project, ctxPath)
      const targetDef = target && target.kind === 'group' ? target : project.defs[project.root]
      const basePath = targetDef.id === project.root ? [] : ctxPath
      if (targetDef.kind !== 'group') return
      let maxX: number | null = null
      for (const c of targetDef.children) {
        if (c.hidden) continue
        const b = box([...basePath, c.id])
        if (b && Number.isFinite(b.max[0])) maxX = maxX === null ? b.max[0] : Math.max(maxX, b.max[0])
      }
      const def = createTemplateDef(kind, project, colorIndex)
      if (kind !== 'group') colorIndex++
      const inst: Instance = { id: newId('i'), def: def.id, xf: { t: placementFor(kind, maxX), r: [0, 0, 0], s: [1, 1, 1] } }
      const r = ctx.store.update(`Add ${TEMPLATES[kind].label}`, (d) => {
        ops.addDef(d, def)
        ops.addInstance(d, targetDef.id, -1, inst)
        return [...basePath, inst.id]
      })
      if (!r.ok) return
      linkedToast(targetDef.id, 'Added to')
      selectNew(r.value)
      frameWhenReady(r.value)
    },

    wrap(op: GroupOp) {
      const path = needOcc('Select an object to wrap')
      if (!path) return
      const parent = parentDefOf(P(), path)
      const r = ctx.store.update(`Wrap in ${WRAP_LABEL[op]}`, (d) => ops.wrapInGroup(d, path, op))
      if (!r.ok) return
      linkedToast(parent)
      ctx.store.setUi((ui) => ({
        ...treeSelectPatch(ui, r.value),
        expanded: { ...ui.expanded, [pathKey(r.value)]: true },
      }))
    },

    ungroup() {
      const path = needOcc('Select a group to ungroup')
      if (!path) return
      const project = P()
      const def = defAtPath(project, path)
      if (!def || def.kind !== 'group') { ctx.toast(`'${nameAt(project, path)}' is not a group`); return }
      const parent = parentDefOf(project, path)
      const r = ctx.store.update(`Ungroup ${nameAt(project, path)}`, (d) => ops.ungroup(d, path))
      if (!r.ok) return
      linkedToast(parent)
      if (r.value.length) ctx.store.setUi((ui) => treeSelectPatch(ui, r.value[0]))
      else {
        const up = path.slice(0, -1)
        ctx.store.setUi(up.length ? (ui) => treeSelectPatch(ui, up) : { selection: { kind: 'none' } })
      }
    },

    // ───────────────────────────── duplicate / clipboard (§4.5) ─────────────────────────────
    duplicateLinked() {
      const path = needOcc('Select an object to duplicate')
      if (!path) return
      const project = P()
      const dx = linkedOffset(widthX(path))
      const parent = parentDefOf(project, path)
      const r = ctx.store.update(`Duplicate ${nameAt(project, path)}`, (d) => ops.duplicateLinked(d, path, dx))
      if (!r.ok) return
      linkedToast(parent)
      selectNew(r.value)
    },

    duplicateUnique() {
      const path = needOcc('Select an object to duplicate')
      if (!path) return
      const project = P()
      const dx = linkedOffset(widthX(path))
      const parent = parentDefOf(project, path)
      const r = ctx.store.update(`Duplicate unique ${nameAt(project, path)}`, (d) => ops.duplicateUnique(d, path, dx))
      if (!r.ok) return
      linkedToast(parent)
      selectNew(r.value)
    },

    copy() {
      const path = needOcc('Select an object to copy')
      if (!path) return
      const clip = clipFromPath(P(), path)
      if (!clip) return
      ctx.clipboard.set(clip)
      copyDx = linkedOffset(widthX(path))
      ctx.toast(`Copied '${nameAt(P(), path)}'`)
    },

    paste(unique: boolean) {
      const clip = ctx.clipboard.get()
      if (!clip) { ctx.toast('Nothing to paste — copy an object with Ctrl+C first'); return }
      const project = P()
      const src = project.defs[clip.def]
      if (!src) { ctx.toast('The copied object no longer exists', 'error'); return }
      const ui = U()
      const ctxPath = defAtPath(project, ui.context)?.kind === 'group' ? ui.context : []
      const targetDef = defAtPath(project, ctxPath)?.id
      const dx = copyDx ?? linkedOffset(null)
      const r = ctx.store.update(`${unique ? 'Paste unique' : 'Paste'} ${clip.name ?? src.name}`,
        (d) => ops.pasteInstance(d, ctxPath, clip, unique, dx))
      if (!r.ok) return
      // the next paste lands one more offset further instead of on top of this one
      const placed = instanceAtPath(P(), r.value)
      if (placed) ctx.clipboard.set({ ...clip, xf: cloneXf(placed.xf) })
      linkedToast(targetDef, 'Added to')
      selectNew(r.value)
    },

    makeUnique(path?: InstancePath) {
      const p = path ?? needOcc('Select an object to make unique')
      if (!p) return
      const project = P()
      const before = defAtPath(project, p)
      const parent = parentDefOf(project, p)
      const r = ctx.store.update(`Make unique ${nameAt(project, p)}`, (d) => ops.makeUnique(d, p))
      if (!r.ok) return
      const after = P().defs[r.value]
      if (before && after) ctx.toast(`'${before.name}' → new definition '${after.name}'`)
      linkedToast(parent)
    },

    // ───────────────────────────── delete (§4.6) ─────────────────────────────
    async deleteSelection() {
      const s = U().selection
      if (s.kind === 'def') { await commands.deleteDefinition(s.def); return }
      if (s.kind !== 'occ') return
      const path = s.path
      const project = P()
      const parent = parentDefOf(project, path)
      const r = ctx.store.update(`Delete ${nameAt(project, path)}`, (d) => { ops.removeInstance(d, path) })
      if (!r.ok) return
      linkedToast(parent)
      const up = path.slice(0, -1)
      const ui = U()
      ctx.store.setUi({ selection: up.length && !samePath(up, ui.context) && isPrefix(ui.context, up) ? { kind: 'occ', path: up } : { kind: 'none' } })
    },

    async deleteDefinition(defId: Id) {
      const project = P()
      const def = project.defs[defId]
      if (!def || defId === project.root) return
      const refs = referrers(project, defId)
      if (refs.length) {
        ctx.toast(`Can't delete '${def.name}': used by code in ${refs.map((r) => `'${project.defs[r].name}'`).join(', ')}`, 'error')
        return
      }
      const records = instancesOf(project, defId).length
      if (records > 0) {
        const copies = occurrenceCount(project, defId)
        const ok = await ctx.confirm({
          title: 'Delete definition',
          message: `Delete '${def.name}' and its ${records} ${records === 1 ? 'instance' : 'instances'} (${copies} ${copies === 1 ? 'copy' : 'copies'} in the scene)?`,
          ok: 'Delete', danger: true,
        })
        if (!ok) return
      }
      const ui = U()
      const wasSelected = ui.selection.kind === 'def' && ui.selection.def === defId
      const r = ctx.store.update(`Delete definition ${def.name}`, (d) => ops.deleteDefinition(d, defId))
      if (!r.ok) return
      if (wasSelected) {
        ctx.store.setUi((u) => ({ selection: { kind: 'none' }, viewMode: u.autoIsolatedFrom ?? u.viewMode, autoIsolatedFrom: undefined }))
      }
      ctx.toast(`Deleted '${def.name}'`)
    },

    purgeUnused() {
      const r = ctx.store.update('Purge unused', (d) => ops.purgeUnused(d))
      if (!r.ok) return
      const n = r.value
      ctx.toast(n === 0 ? 'Nothing to purge' : `Removed ${n} unused ${n === 1 ? 'definition' : 'definitions'}`)
    },

    // ───────────────────────────── rename (§4.7) ─────────────────────────────
    startRename(target?: RenameTarget) {
      let t = target
      if (!t) {
        const s = U().selection
        if (s.kind === 'occ') t = { kind: 'occ', path: s.path }
        else if (s.kind === 'def') t = { kind: 'def', def: s.def }
      }
      if (!t) { ctx.toast('Select something to rename'); return }
      ctx.emit('rename', t)
    },

    commitRename(target: RenameTarget, text: string): string | null {
      if (target.kind === 'def') return commands.renameDef(target.def, text)
      const inst = instanceAtPath(P(), target.path)
      if (!inst) return 'That object no longer exists'
      if (inst.name !== undefined) {
        commands.setLabel(target.path, text)
        return null
      }
      return commands.renameDef(inst.def, text)
    },

    renameDef(defId: Id, name: string): string | null {
      const project = P()
      const def = project.defs[defId]
      if (!def) return 'That definition no longer exists'
      if (defId === project.root) return "The scene can't be renamed"
      const next = name.trim()
      if (next === def.name) return null
      const problem = checkDefName(project, next, defId)
      if (problem) return problem
      const r = ctx.store.update(`Rename ${def.name} → ${next}`, (d) => ops.renameDef(d, defId, next))
      if (!r.ok) return r.error
      if (r.value.length) ctx.emit('codeChanged', { defIds: r.value })
      return null
    },

    setLabel(path: InstancePath, label: string | undefined) {
      const project = P()
      const inst = instanceAtPath(project, path)
      if (!inst) return
      const r = ctx.store.update(`Label ${nameAt(project, path)}`, (d) => ops.setInstanceLabel(d, inst.id, label))
      if (r.ok && r.changed) linkedToast(parentDefOf(project, path))
    },

    // ───────────────────────────── hide (§4.11) ─────────────────────────────
    hideToggle(path?: InstancePath) {
      const p = path ?? needOcc('Select an object to hide')
      if (!p) return
      const project = P()
      const inst = instanceAtPath(project, p)
      if (!inst) return
      const hidden = !inst.hidden
      const r = ctx.store.update(`${hidden ? 'Hide' : 'Show'} ${nameAt(project, p)}`, (d) => ops.setHidden(d, inst.id, hidden))
      if (r.ok && r.changed) linkedToast(parentDefOf(project, p))
    },

    unhideAll() {
      const r = ctx.store.update('Unhide all', (d) => ops.unhideAll(d))
      if (r.ok && r.value === 0) ctx.toast('Nothing is hidden')
    },

    // ───────────────────────────── selection & navigation (§4.3) ─────────────────────────────
    selectFromTree(path: InstancePath) {
      ctx.store.setUi((ui) => treeSelectPatch(ui, path))
      if (U().viewMode === 'context') {
        try { ctx.viewport.frameIfNeeded(path) } catch { /* viewport not mounted */ }
      }
    },

    selectDef(defId: Id) {
      ctx.store.setUi((ui) => librarySelectPatch(ui, defId))
    },

    selectBreadcrumb(j: number) {
      ctx.store.setUi((ui) => breadcrumbPatch(ui, j))
    },

    pick(hit: InstancePath | null, mods: PickMods) {
      ctx.store.setUi((ui) => pickPatch(P(), ui, hit, mods))
    },

    enterGroup() {
      const p = enterPatch(P(), U())
      if (p) ctx.store.setUi(p)
    },

    escape() {
      ctx.store.setUi((ui) => escapePatch(ui))
    },

    toggleExpanded(path: InstancePath, expanded?: boolean) {
      const key = pathKey(path)
      const ui = U()
      const cur = !!ui.expanded[key]
      const next = expanded ?? !cur
      if (next === cur) return
      const ex = { ...ui.expanded }
      if (next) ex[key] = true
      else delete ex[key]
      ctx.store.setUi({ expanded: ex })
    },

    // ───────────────────────────── view (§4.4, §4.9) ─────────────────────────────
    setGizmoMode(mode: UiState['gizmoMode']) {
      if (U().gizmoMode !== mode) ctx.store.setUi({ gizmoMode: mode })
    },
    toggleSpace() {
      ctx.store.setUi((ui) => ({ gizmoSpace: ui.gizmoSpace === 'world' ? 'local' : 'world' }))
    },
    toggleSnap() {
      ctx.store.setUi((ui) => ({ snap: !ui.snap }))
    },
    toggleGhost() {
      ctx.store.setUi((ui) => ({ ghostOthers: !ui.ghostOthers }))
    },
    toggleIsolate() {
      const ui = U()
      if (ui.viewMode === 'isolate') { ctx.store.setUi({ viewMode: 'context', autoIsolatedFrom: undefined }); return }
      if (ui.selection.kind === 'none') { ctx.toast('Select something to isolate'); return }
      ctx.store.setUi({ viewMode: 'isolate', autoIsolatedFrom: undefined })
    },
    frame() {
      try { ctx.viewport.frameSelection() } catch { /* not mounted */ }
    },
    frameAll() {
      try { ctx.viewport.frameAll() } catch { /* not mounted */ }
    },
    viewPreset(preset: ViewPreset) {
      try { ctx.viewport.viewPreset(preset) } catch { /* not mounted */ }
    },

    // ───────────────────────────── edits from the gizmo and the inspector ─────────────────────────────
    commitGizmo(path: InstancePath, xf: Transform, mode: UiState['gizmoMode']) {
      const project = P()
      const inst = instanceAtPath(project, path)
      if (!inst) return
      const r = ctx.store.update(`${MODE_VERB[mode]} ${nameAt(project, path)}`, (d) => ops.setTransform(d, inst.id, xf))
      if (r.ok && r.changed) linkedToast(parentDefOf(project, path))
    },

    setTransform(path: InstancePath, xf: Transform, field?: string) {
      const project = P()
      const inst = instanceAtPath(project, path)
      if (!inst) return
      const verb = field?.startsWith('r') ? 'Rotate' : field?.startsWith('s') ? 'Scale' : 'Move'
      const r = ctx.store.update(`${verb} ${nameAt(project, path)}`, (d) => ops.setTransform(d, inst.id, xf),
        field ? { coalesce: `xf:${inst.id}:${field}` } : {})
      if (r.ok && r.changed) linkedToast(parentDefOf(project, path))
    },

    resetTransform(path: InstancePath) {
      const project = P()
      const inst = instanceAtPath(project, path)
      if (!inst) return
      const r = ctx.store.update(`Reset transform ${nameAt(project, path)}`, (d) => ops.setTransform(d, inst.id, cloneXf(IDENTITY_XF)))
      if (r.ok && r.changed) linkedToast(parentDefOf(project, path))
    },

    setOverride(path: InstancePath, name: string, value: ParamValue | undefined) {
      const project = P()
      const inst = instanceAtPath(project, path)
      if (!inst) return
      const r = ctx.store.update(`${value === undefined ? 'Reset' : 'Set'} ${name}`, (d) => ops.setOverride(d, inst.id, name, value),
        { coalesce: `param:${inst.id}:${name}`, window: 500 })
      if (r.ok && r.changed) linkedToast(parentDefOf(project, path))
    },

    setColor(target: { path: InstancePath } | { def: Id }, color: string | undefined) {
      const project = P()
      if ('path' in target) {
        const inst = instanceAtPath(project, target.path)
        if (!inst) return
        const r = ctx.store.update(`Color ${nameAt(project, target.path)}`, (d) => ops.setColor(d, { instance: inst.id }, color),
          { coalesce: `color:${inst.id}`, window: 1000 })
        if (r.ok && r.changed) linkedToast(parentDefOf(project, target.path))
      } else {
        const def = project.defs[target.def]
        if (!def) return
        const r = ctx.store.update(`Color ${def.name}`, (d) => ops.setColor(d, { def: target.def }, color),
          { coalesce: `color:${def.id}`, window: 1000 })
        if (r.ok && r.changed) linkedToast(def.id)
      }
    },

    setCode(defId: Id, code: string) {
      ctx.store.update('Edit code', (d) => ops.setCode(d, defId, code), { coalesce: `code:${defId}`, window: 2000 })
    },

    setParamDefs(defId: Id, params: ParamDef[]): string | null {
      const problems = paramDefProblems(params)
      if (problems.length) return problems[0]
      const r = ctx.store.update('Edit parameters', (d) => ops.setParamDefs(d, defId, params))
      return r.ok ? null : r.error
    },

    setGroupOp(defId: Id, op: GroupOp) {
      const r = ctx.store.update(`Set op ${op}`, (d) => ops.setGroupOp(d, defId, op))
      if (r.ok && r.changed) linkedToast(defId)
    },

    // ───────────────────────────── tree drag and drop (§4.8) ─────────────────────────────
    canDrop(payload: DragPayload, target: DropTarget): boolean {
      const project = P()
      const parent = defAtPath(project, target.parentPath)
      if (!parent || parent.kind !== 'group') return false
      if (payload.kind === 'occ') {
        if (payload.path.length === 0 || isPrefix(payload.path, target.parentPath)) return false
        const inst = instanceAtPath(project, payload.path)
        if (!inst) return false
        return !wouldCycle(project, parent.id, inst.def)
      }
      if (!project.defs[payload.def] || payload.def === project.root) return false
      return !wouldCycle(project, parent.id, payload.def)
    },

    drop(payload: DragPayload, target: DropTarget, opts: { copy: boolean }) {
      const project = P()
      const dst = defAtPath(project, target.parentPath)
      if (!dst || dst.kind !== 'group') return
      if (payload.kind === 'occ') {
        const src = parentDefOf(project, payload.path)
        const copy = !!opts.copy
        const r = ctx.store.update(`${copy ? 'Copy' : 'Move'} ${nameAt(project, payload.path)}`,
          (d) => ops.moveInstance(d, payload.path, target.parentPath, target.index, { copy }))
        if (!r.ok) return
        if (r.changed) {
          if (r.value.keptLocal) ctx.toast('Kept local transform', 'warn')
          if (!copy && src !== dst.id) linkedToast(src)
          linkedToast(dst.id, copy ? 'Added to' : 'Changed')
        }
        selectNew(r.value.path)
        return
      }
      const def = project.defs[payload.def]
      if (!def) return
      const inst: Instance = { id: newId('i'), def: def.id, xf: cloneXf(IDENTITY_XF) }
      const r = ctx.store.update(`Add ${def.name}`, (d) => {
        ops.addInstance(d, dst.id, target.index, inst)
        return [...target.parentPath, inst.id]
      })
      if (!r.ok) return
      linkedToast(dst.id, 'Added to')
      selectNew(r.value)
    },

    // ───────────────────────────── history (§4.12) ─────────────────────────────
    undo() {
      ctx.emit('flushCode', undefined)
      ctx.store.undo()
    },
    redo() {
      ctx.emit('flushCode', undefined)
      ctx.store.redo()
    },

    // ───────────────────────────── files (§6) ─────────────────────────────
    async newProject() {
      const ok = await ctx.confirm({
        title: 'New project',
        message: 'Replace the current project with an empty one? Save it first if you want to keep it.',
        ok: 'New project',
      })
      if (!ok) return
      ctx.emit('flushCode', undefined)
      ctx.store.reset(emptyProject(), freshUi())
      ctx.toast('New empty project')
    },

    async loadSample() {
      const ok = await ctx.confirm({
        title: 'Load sample',
        message: "Replace the current project with the sample 'Bracket kit'? Save it first if you want to keep it.",
        ok: 'Load sample',
      })
      if (!ok) return
      ctx.emit('flushCode', undefined)
      ctx.store.reset(sampleProject(), freshUi({ expanded: { ...SAMPLE_EXPANDED } }))
      frameAllWhenReady()
    },

    async open(file?: File) {
      const f = file ?? (await ctx.files.pickFile('.json,.3dica.json,application/json'))
      if (!f) return
      let text: string
      try {
        text = await f.text()
      } catch (e) {
        ctx.problems(`Can't open ${f.name}`, [errorText(e)])
        return
      }
      const parsed = parseProject(text)
      if (!parsed.ok) { ctx.problems(`Can't open ${f.name}`, parsed.problems); return }
      const project = parsed.project
      let run = true
      if (hasCode(project)) {
        run = await ctx.confirm({
          title: `Open ${f.name}`,
          message: 'This file contains code that runs on your computer. Run it?',
          ok: 'Run code', cancel: 'Open without running',
        })
      }
      ctx.emit('flushCode', undefined)
      ctx.store.reset(project, freshUi({ evalPaused: !run }))
      if (project.camera) {
        try { ctx.viewport.setCamera(project.camera) } catch { /* not mounted */ }
      } else if (run) frameAllWhenReady()
      ctx.toast(run ? `Opened '${project.name}'` : `Opened '${project.name}' without running its code — click Run code when you trust it`, run ? 'info' : 'warn')
    },

    save() {
      ctx.emit('flushCode', undefined)
      const project = P()
      let camera: Project['camera']
      try { camera = ctx.viewport.getCamera() } catch { camera = project.camera }
      const text = serialize(camera ? { ...project, camera } : project)
      const filename = `${safeFileName(project.name)}.3dica.json`
      ctx.files.downloadBlob(new Blob([text], { type: 'application/json' }), filename)
      ctx.toast(`Saved ${filename}`)
    },

    async exportStl() {
      if (U().evalPaused) { ctx.toast('Code is not running — click Run code first', 'warn'); return }
      ctx.emit('flushCode', undefined)
      const rs = renderState()
      // objects whose result already failed (timeout, crash, error) are skipped, not re-run inside the STL request
      const plan = computeStlItems(rs.specs, rs.occurrences, U(), (o) => {
        const k = rs.wanted.resultKeyOf.get(o.key)
        return k !== undefined && ctx.client.get(k)?.state === 'failed'
      })
      if (plan.items.length === 0) {
        ctx.toast(plan.skipped.length ? `Nothing to export (${plan.skipped.map((n) => `'${n}'`).join(', ')} ${plan.skipped.length === 1 ? 'has' : 'have'} errors)` : 'Nothing to export')
        return
      }
      const filename = stlFileName(safeFileName(P().name), plan.label)
      try {
        const { parts, tris } = await ctx.client.exportStl(plan.items)
        ctx.files.downloadBlob(new Blob(parts, { type: 'model/stl' }), filename)
        ctx.toast(`Exported ${filename} · ${tris.toLocaleString('en-US')} triangles`)
        if (plan.skipped.length) ctx.toast(`Skipped because of errors: ${plan.skipped.join(', ')}`, 'warn')
      } catch (e) {
        ctx.toast(`STL export failed: ${errorText(e)}`, 'error')
      }
    },

    runCode(defId?: Id) {
      ctx.emit('flushCode', undefined)
      const wasPaused = U().evalPaused
      if (wasPaused) ctx.store.setUi({ evalPaused: false })
      const rs = renderState()
      const id = defId ?? selectedDefId()
      let keys: string[]
      if (id) keys = [...(rs.wanted.jobsOfDef.get(id) ?? [])]
      else keys = rs.wanted.jobs.map((j) => j.resultKey).filter((k) => ctx.client.get(k)?.state === 'failed')
      if (keys.length) ctx.client.retry(keys)
      if (wasPaused) {
        ctx.toast('Running code')
        frameAllWhenReady()
      }
    },
  }
  return commands
}
