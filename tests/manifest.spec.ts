import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { commandArg, contributePrompt } from '../src/index.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  dsh?: { bundle?: { patch?: string }; plugin?: { displayName?: string } }
  dshx?: unknown
  files?: string[]
  engines?: { dsh?: string; node?: string }
  keywords?: string[]
}

describe('DSH 0.1.1+ bundle manifest', () => {
  it('declares dsh.bundle.patch so `dsh plugin add` joins the layer stack', () => {
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(pkg.files).toContain('cordis.patch.yml')
    expect(pkg.dshx).toBeUndefined()
  })

  it('declares an engines.dsh range that includes the current DSH train', () => {
    expect(pkg.engines?.dsh).toBe('>=0.1.1-rc.2')
    expect(pkg.engines?.node).toMatch(/22/)
    expect(pkg.keywords).toContain('dsh-plugin')
    expect(pkg.dsh?.plugin?.displayName).toBe('dsh-of-your-own')
  })

  it('commandArg accepts both official tails and legacy full slash lines', () => {
    expect(commandArg('3', 'resume')).toBe('3')
    expect(commandArg('/resume 3', 'resume')).toBe('3')
    expect(commandArg('/resume', 'resume')).toBe('')
    expect(commandArg(undefined, 'resume')).toBe('')
  })

  it('contributePrompt prefers section() and no-ops when the seam is absent', () => {
    const seen: string[] = []
    const dispose = contributePrompt({
      section: (entry) => {
        seen.push(`section:${entry.name}`)
        return () => { seen.push('disposed') }
      },
      context: (entry) => {
        seen.push(`context:${entry.name}`)
        return () => {}
      },
    }, { name: 'user-preferences', order: 10, text: 'hi' })
    expect(seen).toEqual(['section:user-preferences'])
    dispose?.()
    expect(seen).toEqual(['section:user-preferences', 'disposed'])
    expect(contributePrompt(undefined, { name: 'x', order: 0, text: '' })).toBeUndefined()
  })
})
