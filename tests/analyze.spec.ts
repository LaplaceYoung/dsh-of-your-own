import { describe, expect, it } from 'vitest'
import {
  analyzeSource,
  buildPreferenceFallback,
  buildProfile,
  collectText,
  dominantLanguage,
  frequency,
  renderProfileSection,
  renderStatsDigest,
  synthesizePreferences,
  type LlmLike,
} from '../src/analyze.ts'
import type { SourceEvidence } from '../src/sources.ts'

const evidence = (overrides: Partial<SourceEvidence> = {}): SourceEvidence => ({
  source: 'claude-code',
  prompts: ['修 bug', '重构一下', '/review diff', '/review 另一处', '写测试'],
  toolCalls: ['Read', 'Read', 'Read', 'Bash', 'Edit'],
  slashCommands: ['/review', '/review', '/memory'],
  cwds: ['/p1', '/p1', '/p2'],
  filesScanned: 3,
  ...overrides,
})

describe('analyze: frequency and language', () => {
  it('counts and sorts by count, then name', () => {
    expect(frequency(['a', 'b', 'a', 'c', 'b', 'a'])).toEqual([
      { name: 'a', count: 3 },
      { name: 'b', count: 2 },
      { name: 'c', count: 1 },
    ])
  })

  it('ignores empty items', () => {
    expect(frequency(['', 'x', ''])).toEqual([{ name: 'x', count: 1 }])
  })

  it('picks the dominant language with majority', () => {
    expect(dominantLanguage([{ language: 'zh' }, { language: 'zh' }, { language: 'en' }])).toBe('zh')
    expect(dominantLanguage([{ language: 'en' }, { language: 'en' }, { language: 'zh' }])).toBe('en')
  })
})

describe('analyze: analyzeSource', () => {
  it('computes top tools, slash commands, cwds and zh language', () => {
    const stats = analyzeSource(evidence())
    expect(stats.source).toBe('claude-code')
    expect(stats.filesScanned).toBe(3)
    expect(stats.promptCount).toBe(5)
    expect(stats.topTools[0]).toEqual({ name: 'Read', count: 3 })
    expect(stats.topSlashCommands[0]).toEqual({ name: '/review', count: 2 })
    expect(stats.topCwds[0]).toEqual({ name: '/p1', count: 2 })
    expect(stats.language).toBe('zh')
  })

  it('bounds samples by maxSamplesPerSource and truncates long ones', () => {
    const stats = analyzeSource(evidence({
      prompts: Array.from({ length: 20 }, (_, i) => `prompt number ${i}`),
    }), { maxSamplesPerSource: 3, maxSampleChars: 10 })
    expect(stats.samples).toHaveLength(3)
    expect(stats.samples.every(s => s.length <= 11)).toBe(true) // 10 chars + ellipsis
  })

  it('renders a digest containing tools and slash lines', () => {
    const digest = renderStatsDigest([analyzeSource(evidence())])
    expect(digest).toContain('## claude-code (3 files, 5 prompts, lang=zh)')
    expect(digest).toContain('Read×3')
    expect(digest).toContain('/review×2')
  })
})

describe('analyze: LLM synthesis', () => {
  const llm = (chunks: { type?: string; delta?: string }[]): LlmLike => ({
    stream: () => (async function* () { for (const c of chunks) yield c })(),
  })

  it('collects text-delta chunks only', async () => {
    const text = await collectText((async function* () {
      yield { type: 'text-delta', delta: 'hello ' }
      yield { type: 'reasoning', delta: 'hidden' }
      yield { type: 'text-delta', delta: 'world' }
    })())
    expect(text).toBe('hello world')
  })

  it('synthesizes preferences via the llm seam with provider/model', async () => {
    let captured: { provider?: string; model?: string; messages?: unknown[] } | undefined
    const stub: LlmLike = {
      stream(options) {
        captured = options as { provider?: string; model?: string; messages?: unknown[] }
        return (async function* () { yield { type: 'text-delta', delta: '- 偏好简洁中文回复\n- 常用 Read' } })()
      },
    }
    const out = await synthesizePreferences(stub, 'digest', 'zh', { provider: 'p', model: 'm' })
    expect(out).toContain('偏好简洁中文回复')
    expect(captured?.provider).toBe('p')
    expect(captured?.model).toBe('m')
  })

  it('returns empty string when stream is unavailable', async () => {
    expect(await synthesizePreferences({}, 'digest', 'en', {})).toBe('')
  })
})

describe('analyze: profile assembly', () => {
  it('aggregates habits across sources and picks zh language', () => {
    const a = analyzeSource(evidence())
    const b = analyzeSource(evidence({
      source: 'codex',
      prompts: ['再改改'],
      toolCalls: ['apply_patch'],
      slashCommands: [],
      cwds: ['/p3'],
      filesScanned: 1,
    }))
    const profile = buildProfile([a, b], '用户喜欢简洁回复', '2026-08-14T00:00:00Z')
    expect(profile.version).toBe(1)
    expect(profile.sources).toHaveLength(2)
    expect(profile.toolHabits[0]).toEqual({ name: 'Read', count: 3 })
    expect(profile.migratedCommands).toEqual(['/review', '/memory'])
    expect(profile.preferences).toBe('用户喜欢简洁回复')
  })

  it('falls back to a deterministic preference when LLM returns nothing', () => {
    const stats = analyzeSource(evidence())
    const fallback = buildPreferenceFallback([stats])
    expect(fallback).toContain('claude-code')
    expect(fallback).toContain('Read')
    const profile = buildProfile([stats], '')
    expect(profile.preferences).toBe(fallback)
  })

  it('renders the system-prompt section with habits and language', () => {
    const profile = buildProfile([analyzeSource(evidence())], '喜欢中文')
    const section = renderProfileSection(profile)
    expect(section).toContain('# User Preferences')
    expect(section).toContain('喜欢中文')
    expect(section).toContain('Read×3')
    expect(section).toContain('/review×2')
    expect(section).toContain('Chinese (中文)')
  })
})
