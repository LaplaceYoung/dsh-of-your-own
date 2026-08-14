import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Resolve the DSH protocol package against the published upstream `cordis`
// package, matching the tsconfig.json `paths` entry so tests and typecheck
// agree.
const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/cordis': resolve(root, 'node_modules/cordis'),
    },
  },
})
