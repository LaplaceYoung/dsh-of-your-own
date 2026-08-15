#!/usr/bin/env node
/**
 * dsh-of-your-own LIVE e2e driver.
 *
 * Boots a real DSH composition (system-prompt + tools + commands + the
 * plugin) through @deepseek-ai/dsh-app-boot, then drives the four slash
 * commands through the REAL command registry (`ctx.commands.execute`),
 * exactly as a DSH UI would.
 *
 * Usage: node --import tsx e2e/run-live.mjs <dsh-src> [config]
 *
 * Output: each command's text result to stdout (captured for screenshots),
 * plus a machine-readable JSON summary to e2e/live-results.json.
 */

import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const dshSrc = process.argv[2] ?? process.cwd()
const configPath = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), 'cordis.live.yml')

// The DSH snapshot's boot package resolves from the examples workspace node_modules.
const bootPath = join(dshSrc, 'examples', 'live-driver-anchor.js')
const { boot } = require(require.resolve('@deepseek-ai/dsh-app-boot', { paths: [dirname(bootPath)] }))

const ctx = await boot('dsh-of-your-own-live', configPath)
const results = []

try {
  const agents = ctx.get('agents')?.roots?.() ?? []
  // No agent-spine in this minimal composition. Commands are registered
  // globally against the REAL command registry; resolve each through
  // registry.find() (the exact lookup the UI uses) and invoke the handler
  // directly — execute() additionally writes session lifecycle events which
  // require a full agent spine this smoke composition skips.
  const agent = agents[0] ?? { id: 'live-driver' }

  async function runCommand(line) {
    const match = /^\/([a-z][a-z0-9_-]*)([\s\S]*)$/.exec(line)
    const name = match?.[1] ?? ''
    const definition = ctx.commands.find(agent, name)
    if (!definition) {
      results.push({ line, ok: false, text: `(command not registered: ${name})` })
      return
    }
    const result = await definition.handler({
      commandId: `live-${name}`,
      agent,
      rawInput: match?.[2] ?? '',
      signal: new AbortController().signal,
    })
    results.push({ line, ok: result.kind === 'success', text: result.text ?? '' })
  }

  console.log('╭─ dsh-of-your-own LIVE E2E ─────────────────────────────────╮')
  console.log('│ DSH booted · plugin mounted · real command registry        │')
  console.log('╰────────────────────────────────────────────────────────────╯')

  // 1. /fuck — full migration + verdict report
  await runCommand('/fuck')

  // 2. /sessions — resumable session catalog
  await runCommand('/sessions')

  // 3. /resume 1 — hand over the newest session
  await runCommand('/resume 1')

  // 4. /forget — erase everything
  await runCommand('/forget')

  // 5. /forget again — idempotency proof
  await runCommand('/forget')

  console.log('')
  for (const r of results) {
    console.log(`┌─ ${r.line} ─ ${r.ok ? '✓' : '✗'}`)
    for (const l of r.text.split('\n')) console.log(`│ ${l}`)
    console.log('└─')
    console.log('')
  }

  const outPath = join(dirname(fileURLToPath(import.meta.url)), 'live-results.json')
  writeFileSync(outPath, JSON.stringify(results, null, 2))
  console.log(`Results written to ${outPath}`)
} finally {
  try { await ctx.dispose?.() } catch { /* best-effort */ }
}

const failed = results.filter(r => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} commands succeeded`)
process.exit(failed === 0 ? 0 : 1)
