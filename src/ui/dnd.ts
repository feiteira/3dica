// §4.8 shared drag state. dataTransfer.getData() is unreadable during dragover, so the payload of the drag in
// progress is kept here (set on dragstart by tree / library rows, cleared on dragend / drop).
import type { DragPayload } from '../app/context'

export const DND_TYPE = 'application/x-3dica'

let current: DragPayload | null = null

export function startDrag(e: DragEvent, payload: DragPayload, effect: DataTransfer['effectAllowed']): void {
  current = payload
  if (e.dataTransfer) {
    e.dataTransfer.setData(DND_TYPE, JSON.stringify(payload))
    e.dataTransfer.effectAllowed = effect
  }
}

/** The payload of the tree / library drag in progress (null for files or foreign drags). */
export function currentDrag(e?: DragEvent): DragPayload | null {
  if (current) return current
  if (e?.dataTransfer) {
    try {
      const raw = e.dataTransfer.getData(DND_TYPE)
      if (raw) return JSON.parse(raw) as DragPayload
    } catch { /* not ours */ }
  }
  return null
}

export function endDrag(): void { current = null }
