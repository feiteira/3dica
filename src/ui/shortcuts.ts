// §4.13 keyboard shortcuts. Ignored while focus is in an input / textarea / select / CodeMirror, except Ctrl+Enter,
// Ctrl+S and Esc (Esc blurs the field). Every handled key calls preventDefault() (overrides Chrome's Ctrl+D/S/O).
import type { InstallShortcuts } from '../app/context'
import { isEditable } from './dom'

export const install: InstallShortcuts = (ctx) => {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return
    // a modal <dialog> owns the keyboard
    if (document.querySelector('dialog[open]')) return
    const t = e.target
    const editable = isEditable(t) || isEditable(document.activeElement)
    const ctrl = e.ctrlKey || e.metaKey
    const shift = e.shiftKey
    const alt = e.altKey
    const key = e.key
    const k = key.length === 1 ? key.toLowerCase() : key
    const c = ctx.commands
    const handled = () => { e.preventDefault() }

    // ── active everywhere (also inside fields and the code editor)
    if (ctrl && !alt && key === 'Enter') { handled(); c.runCode(); return }
    if (ctrl && !alt && !shift && k === 's') { handled(); c.save(); return }
    if (key === 'Escape' && editable) {
      handled()
      const a = document.activeElement
      if (a instanceof HTMLElement) a.blur()
      return
    }
    if (editable) return
    // let a focused button react to Enter / Space natively
    if (t instanceof HTMLElement && t.tagName === 'BUTTON' && (key === 'Enter' || key === ' ')) return

    // ── Ctrl combos
    if (ctrl && !alt) {
      switch (k) {
        case 'z': handled(); if (shift) c.redo(); else c.undo(); return
        case 'y': handled(); c.redo(); return
        case 'd': handled(); if (shift) c.duplicateUnique(); else c.duplicateLinked(); return
        case 'c':
          // keep native copy of selected page text when no object is selected
          if (ctx.store.ui.selection.kind !== 'occ') return
          handled(); c.copy(); return
        case 'v':
          if (!ctx.clipboard.has()) return
          handled(); c.paste(shift); return
        case 'g': handled(); if (shift) c.ungroup(); else c.wrap('none'); return
        case 'o': handled(); void c.open(); return
      }
      return
    }

    // ── Alt+H
    if (alt && !ctrl && !shift && e.code === 'KeyH') { handled(); c.unhideAll(); return }
    if (alt) return

    // ── numpad / digit views (code first: Numpad7 without NumLock reports key 'Home')
    const view = e.code === 'Numpad1' || (key === '1' && !shift) ? 'front'
      : e.code === 'Numpad3' || (key === '3' && !shift) ? 'right'
        : e.code === 'Numpad7' || (key === '7' && !shift) ? 'top' : null
    if (view) { handled(); c.viewPreset(view); return }

    switch (key) {
      case 'Delete':
      case 'Backspace': handled(); void c.deleteSelection(); return
      case 'F2': handled(); c.startRename(); return
      case 'Home': handled(); c.frameAll(); return
      case 'Enter': handled(); c.enterGroup(); return
      case 'Escape': handled(); c.escape(); return
    }
    if (shift) return
    switch (k) {
      case 'h': handled(); c.hideToggle(); return
      case 'u': handled(); c.makeUnique(); return
      case 'w': handled(); c.setGizmoMode('translate'); return
      case 'e': handled(); c.setGizmoMode('rotate'); return
      case 'r': handled(); c.setGizmoMode('scale'); return
      case 'q': handled(); c.toggleSpace(); return
      case 'x': handled(); c.toggleSnap(); return
      case 'g': handled(); c.toggleGhost(); return
      case 'i': handled(); c.toggleIsolate(); return
      case 'f': handled(); c.frame(); return
    }
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}
