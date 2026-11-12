// --serve / --headless / --open: bring up a 3Dica tab for the MCP server.
//   serve:    if nothing answers at the app URL, start a Vite dev server in this process (its log goes to stderr);
//             if the port already serves 3Dica, reuse it.
//   headless: launch headless Chromium through playwright-core (installed with @playwright/test) with a fresh profile.
//   open:     open the user's default browser.
import { spawn } from 'node:child_process'
import path from 'node:path'

/** What answers at `url`: '3dica', 'other' (something else) or 'none' (nothing listening). */
export async function probeApp(url, timeoutMs = 2500) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow' })
    const body = await res.text()
    return /<title>3Dica\b/.test(body) && /id="toolbar"/.test(body) ? '3dica' : 'other'
  } catch {
    return 'none'
  } finally {
    clearTimeout(timer)
  }
}

/** The URL a tab opens to connect: appUrl with ?mcp (and &mcpPort= when the bridge is not on the default port). */
export function connectUrl(appUrl, bridgePort, extra = {}) {
  const u = new URL(appUrl)
  u.searchParams.set('mcp', '')
  if (bridgePort !== 6173) u.searchParams.set('mcpPort', String(bridgePort))
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v)
  // "?mcp=" → "?mcp"
  return u.href.replace(/([?&]mcp)=(&|$)/, '$1$2')
}

function stderrLogger(prefix) {
  const out = (msg) => process.stderr.write(`${prefix}${String(msg).replace(/\x1b\[[0-9;]*m/g, '')}\n`)
  const warned = new Set()
  return {
    info: out,
    warn: out,
    warnOnce: (m) => { if (!warned.has(m)) { warned.add(m); out(m) } },
    error: out,
    clearScreen: () => {},
    hasErrorLogged: () => false,
    hasWarned: false,
  }
}

/**
 * Make sure a 3Dica dev server answers at http://localhost:<appPort>/. Returns { url, server|null, reused }.
 * @param {{ root: string, appPort: number, strictPort: boolean, log: (m: string) => void }} o
 */
export async function serveApp(o) {
  const url = `http://localhost:${o.appPort}/`
  const found = await probeApp(url)
  if (found === '3dica') { o.log(`reusing the 3Dica dev server already running at ${url}`); return { url, server: null, reused: true } }
  if (found === 'other' && o.strictPort) throw new Error(`${url} serves something that is not 3Dica — pick another --app-port`)
  const { createServer } = await import('vite')
  const server = await createServer({
    root: o.root,
    configFile: path.join(o.root, 'vite.config.ts'),
    logLevel: 'warn',
    clearScreen: false,
    customLogger: stderrLogger('[vite] '),
    server: { port: o.appPort, strictPort: o.strictPort, host: 'localhost' },
  })
  await server.listen()
  const resolved = server.resolvedUrls?.local?.[0] ?? url
  o.log(`started a Vite dev server at ${resolved}`)
  return { url: resolved, server, reused: false }
}

/**
 * Headless Chromium with a fresh profile (playwright-core from the installed @playwright/test).
 * @param {{ url: string, log: (m: string) => void, width?: number, height?: number }} o
 */
export async function launchHeadless(o) {
  let chromium
  try {
    ({ chromium } = await import('playwright-core'))
  } catch {
    throw new Error('--headless needs playwright-core (it comes with the dev dependency @playwright/test: npm install in the 3Dica folder)')
  }
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: o.width ?? 1280, height: o.height ?? 800 } })
  const page = await context.newPage()
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') o.log(`[page ${m.type()}] ${m.text()}`) })
  page.on('pageerror', (e) => o.log(`[page error] ${e.message}`))
  await page.goto(o.url, { waitUntil: 'load' })
  o.log(`headless browser opened ${o.url}`)
  return { browser, page }
}

/** Open `url` in the default browser (detached). */
export function openBrowser(url, log) {
  const cmd = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] // no cmd.exe: '&' in the URL stays literal
      : ['xdg-open', [url]]
  try {
    const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', (e) => log(`could not open a browser (${e.message}) — open ${url} yourself`))
    child.unref()
    log(`opening ${url} in the default browser`)
  } catch (e) {
    log(`could not open a browser (${e?.message ?? e}) — open ${url} yourself`)
  }
}
