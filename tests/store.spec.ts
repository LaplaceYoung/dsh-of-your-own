import { describe, expect, it } from 'vitest'
import {
  buildCommandStub,
  deserializeProfile,
  loadProfile,
  saveProfile,
  serializeProfile,
} from '../src/store.ts'
import { buildProfile } from '../src/analyze.ts'
import { MemFs } from './memfs.ts'

const profile = () => buildProfile([], '喜欢简洁', '2026-08-14T00:00:00Z')

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
    const next = buildProfile([], '更新后的偏好', '2026-08-15T00:00:00Z')
    await saveProfile(fs as never, '/store', next, [])
    const stored = await loadProfile(fs as never, '/store')
    expect(stored?.preferences).toBe('更新后的偏好')
  })
})
