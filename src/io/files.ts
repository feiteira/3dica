// §6 file I/O helpers: Blob download, hidden file picker, files dropped on the window.
import type { FilesApi } from '../app/context'

/** URL.createObjectURL + hidden <a download> click; the URL is revoked shortly after (immediate revoke can cancel downloads). */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  setTimeout(() => { URL.revokeObjectURL(url); a.remove() }, 1500)
}

/** Hidden <input type=file accept=…> (multiple: several files); resolves with the chosen files, [] when cancelled. */
function pick(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.style.display = 'none'
    input.setAttribute('data-testid', 'file-input')
    let done = false
    const finish = (f: File[]) => {
      if (done) return
      done = true
      input.remove()
      resolve(f)
    }
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])))
    input.addEventListener('cancel', () => finish([]))
    document.body.appendChild(input)
    input.click()
  })
}

/** Hidden <input type=file accept=…>; resolves with the chosen file, or null when the picker is cancelled. */
export function pickFile(accept: string): Promise<File | null> {
  return pick(accept, false).then((f) => f[0] ?? null)
}

/** Like pickFile, choosing several files at once; [] when cancelled. */
export function pickFiles(accept: string): Promise<File[]> {
  return pick(accept, true)
}

const TREE_TYPE = 'application/x-3dica'

function isFileDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types
  if (!types) return false
  const list = Array.from(types)
  return list.includes('Files') && !list.includes(TREE_TYPE)
}

/**
 * Calls `cb` with the files dropped anywhere on the window (the first one, and all of them). Tree drags
 * (application/x-3dica) are ignored. While a file is dragged over the window, <body> gets the class `drop-file`
 * (styles.css shows an overlay). Returns unsubscribe.
 */
export function onWindowDrop(cb: (file: File, all: File[]) => void): () => void {
  let depth = 0
  const clear = () => { depth = 0; document.body.classList.remove('drop-file') }
  const enter = (e: DragEvent) => {
    if (!isFileDrag(e)) return
    depth++
    document.body.classList.add('drop-file')
  }
  const over = (e: DragEvent) => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }
  const leave = (e: DragEvent) => {
    if (!isFileDrag(e)) return
    depth = Math.max(0, depth - 1)
    if (depth === 0) document.body.classList.remove('drop-file')
  }
  const drop = (e: DragEvent) => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    clear()
    const all = Array.from(e.dataTransfer?.files ?? [])
    if (all.length) cb(all[0], all)
  }
  window.addEventListener('dragenter', enter)
  window.addEventListener('dragover', over)
  window.addEventListener('dragleave', leave)
  window.addEventListener('drop', drop)
  window.addEventListener('dragend', clear)
  return () => {
    window.removeEventListener('dragenter', enter)
    window.removeEventListener('dragover', over)
    window.removeEventListener('dragleave', leave)
    window.removeEventListener('drop', drop)
    window.removeEventListener('dragend', clear)
    clear()
  }
}

/** The FilesApi object for AppContext.files. */
export const files: FilesApi = { downloadBlob, pickFile, pickFiles, onWindowDrop }
