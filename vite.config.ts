import { defineConfig } from 'vitest/config'
export default defineConfig({
  base: './',
  optimizeDeps: { include: ['@jscad/modeling', '@jscad/stl-serializer'] }, // worker-only deps found late on a cold start; this fixes the hung first request [verified]
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 1500 }, // three + CodeMirror are expected to be > 500 kB
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' },
})
