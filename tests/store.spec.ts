import { describe, expect, it } from 'vitest'
import {
  buildCommandStub,
  deserializeProfile,
  loadProfile,
  saveProfile,
  serializeProfile,
  upsertAgentsBlock,
  writeNativeAgentsMd,
  AGENTS_MANAGED_BEGIN,
  AGENTS_MANAGED_END,
} from '../src/store.ts'
import { buildProfile } from '../src/analyze.ts'
import { MemFs } from './memfs.ts'

const profile = () => buildProfile([], '喜欢简洁', [], '2026-08-14T00:00:00Z')

describe('store: command stubs', () => {
  it('builds a stub that names the command and its provenance', () => {
    const stub = buildCommandStub('/review', 'claude-code', 4)
    expect(stub).toContain('# /review')
    expect(stub).toContain('observed 4× in claude-code history')
  })
})

describe('store: serialization', () => {
  it('round-trips a profile', () => {
    const text = serializeProfile(profile())
    expect(deserializeProfile(text)).toMatchObject({ version: 1, preferences: '喜欢简洁' })
  })

  it('rejects corrupt or wrong-version payloads', () => {
    expect(deserializeProfile('{nope')).toBeUndefined()
    expect(deserializeProfile(JSON.stringify({ version: 2, sources: [], preferences: '' }))).toBeUndefined()
    expect(deserializeProfile(JSON.stringify({ version: 1, sources: [] }))).toBeUndefined()
  })
})

describe('store: persistence', () => {
  it('saves profile + command stubs and loads them back', async () => {
    const fs = new MemFs()
    const p = profile()
    const result = await saveProfile(fs as never, '/store', p, [
      { name: '/review', source: 'claude-code', observed: 2, body: buildCommandStub('/review', 'claude-code', 2) },
      { name: '/../../etc', source: 'codex', observed: 1, body: 'evil' }, // sanitized → 'etc' (traversal stripped, safe)
      { name: '///', source: 'codex', observed: 1, body: 'dropped' }, // sanitizes to empty → skipped
    ])
    expect(result.profilePath).toBe('/store/profile.json')
    expect(result.commandPaths).toEqual(['/store/commands/review.md', '/store/commands/etc.md'])

    const stored = await loadProfile(fs as never, '/store')
    expect(stored).toMatchObject({ version: 1, preferences: '喜欢简洁' })
    expect(await fs.readText('/store/commands/review.md')).toContain('# /review')
  })

  it('returns undefined for a missing store', async () => {
    const fs = new MemFs()
    expect(await loadProfile(fs as never, '/absent')).toBeUndefined()
  })

  it('overwrites a previous profile on re-save', async () => {
    const fs = new MemFs()
    await saveProfile(fs as never, '/store', profile(), [])
    const next = buildProfile([], '更新后的偏好', [], '2026-08-15T00:00:00Z')
    await saveProfile(fs as never, '/store', next, [])
    const stored = await loadProfile(fs as never, '/store')
    expect(stored?.preferences).toBe('更新后的偏好')
  })
})


describe('store: native AGENTS.md managed block', () => {
  it('appends the block to an existing user file without touching it', () => {
    const existing = '# My own notes\n\nDo not reformat.\n'
    const out = upsertAgentsBlock(existing, 'Learned: terse answers')
    expect(out.startsWith(existing)).toBe(true)
    expect(out).toContain(AGENTS_MANAGED_BEGIN)
    expect(out).toContain('Learned: terse answers')
    expect(out).toContain(AGENTS_MANAGED_END)
  })

  it('replaces the block in place on re-run (idempotent, no dup)', () => {
    const once = upsertAgentsBlock('', 'v1 preferences')
    const twice = upsertAgentsBlock(once, 'v2 preferences')
    expect(twice).toContain('v2 preferences')
    expect(twice).not.toContain('v1 preferences')
    expect((twice.match(/dsh-of-your-own:begin/g) ?? []).length).toBe(1)
  })

  it('preserves content written after the block', () => {
    const once = upsertAgentsBlock('', 'learned')
    const withTrailer = `${once}\n## user edits after migration\nkeep me\n`
    const out = upsertAgentsBlock(withTrailer, 'learned v2')
    expect(out).toContain('## user edits after migration')
    expect(out).toContain('keep me')
    expect(out).toContain('learned v2')
  })

  it('writeNativeAgentsMd creates the file and updates it on re-run', async () => {
    const fs = new MemFs()
    await writeNativeAgentsMd(fs as never, '/home/.dsh/AGENTS.md', 'first run')
    expect(await fs.readText('/home/.dsh/AGENTS.md')).toContain('first run')
    await writeNativeAgentsMd(fs as never, '/home/.dsh/AGENTS.md', 'second run')
    const text = await fs.readText('/home/.dsh/AGENTS.md')
    expect(text).toContain('second run')
    expect(text).not.toContain('first run')
  })
})