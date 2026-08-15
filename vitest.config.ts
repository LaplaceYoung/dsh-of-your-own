import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Resolve the DSH protocol package against the published `@deepseek-ai/cordis`
// package so tests resolve the same code the DSH runtime loads.
const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/cordis': resolve(root, 'node_modules/@deepseek-ai/cordis'),
    },
  },
})
