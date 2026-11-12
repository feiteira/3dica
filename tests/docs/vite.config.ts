// Dev server for the screenshot run (playwright.docs.config.ts): the app's own vite.config.ts, but without HMR and file
// watching, so an edit saved while the shots are being taken cannot reload the page in the middle of a sequence, and
// with its own dependency cache, so it never rewrites the cache of a dev server you are running at the same time.
import { mergeConfig } from 'vite'
import base from '../../vite.config.ts'

export default mergeConfig(base, {
  cacheDir: 'node_modules/.vite-docs-shots',
  server: { hmr: false, watch: null },
})
