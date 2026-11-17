// Stop button plumbing shared by the loop and the tools (no dependencies, so the loop can import it without loading
// the tool layer).

/** An abort of the running request or tool (Stop): the one thing AgentTool.run() may throw. */
export function abortError(): Error {
  return new DOMException('Cancelled by the user', 'AbortError')
}

export function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError'
}

/** Resolve with `p`, or reject with an AbortError when `signal` fires first (`p` keeps running; its result is dropped). */
export function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { p.catch(() => {}); return Promise.reject(abortError()) }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v) },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e) },
    )
  })
}
