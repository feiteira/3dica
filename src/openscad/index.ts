// OpenSCAD support: interpret (source → CSG tree) + build (CSG tree → JSCAD geometry). No DOM: runs in the eval
// worker. See types.ts for the contract between the parts.
import { ScadError, type RunScad } from './types'
import { interpret } from './interp'
import { buildScad } from './build'

/** Interpreter messages (echo, warnings) first, then the build's warnings, as OpenSCAD prints them. */
export const runScad: RunScad = (source, opts) => {
  const { nodes, messages } = interpret(source, opts)
  try {
    const built = buildScad(nodes, opts)
    return { geoms: built.geoms, messages: [...messages, ...built.messages] }
  } catch (e) {
    // a build error still shows the console output that came before it (resolvePart's errors pass unchanged)
    if (e instanceof ScadError) e.messages = [...messages, ...(e.messages ?? [])]
    throw e
  }
}

export { interpret } from './interp'
export { build } from './build'
export { extractParams, setParamDefault } from './customizer'
export * from './types'
