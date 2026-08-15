import { describe, expect, it } from 'vitest'
import { buildProfile, analyzeSource } from '../src/analyze.ts'
import type { SourceEvidence } from '../src/sources.ts'
import { buildVerdictReport, hashString, isNightOwl, rankUser, renderHourHistogram, toolSchool, synthesizeTsundereCloser, TSUNDERE_ZH, TSUNDERE_EN } from '../src/report.ts'

const evidence = (overrides: Partial<SourceEvidence> = {}): SourceEvidence => ({
  source: 'claude-code',
  prompts: ['修 bug', '重构一下', '/review diff', '写测试'],
  toolCalls: ['Read', 'Read', 'Bash'],
  slashCommands: ['/review', '/review'],
  cwds: ['/p1'],
  messageHours: [10, 11, 14],
  filesScanned: 1,
  ...overrides,
})

const profile = (preferences = '喜欢简洁', memoryFiles: { source: string; name: string }[] = []) =>
  buildProfile([analyzeSource(evidence())], preferences, memoryFiles as never, '2026-08-14T00:00:00Z')

describe('report: determinism and selection', () => {
  it('hashString is deterministic and order-sensitive', () => {
    expect(hashString('abc')).toBe(hashString('abc'))
    expect(hashString('abc')).not.toBe(hashString('abd'))
  })

  it('the same profile yields the same closing line across runs', () => {
    const a = buildVerdictReport({ profile: profile(), messageHours: [10, 11, 14] })
    const b = buildVerdictReport({ profile: profile(), messageHours: [10, 11, 14] })
    expect(a).toBe(b)
  })

  it('rank tiers scale with activity', () => {
    expect(rankUser(0, 'zh').rank).toBe('路过萌新')
    expect(rankUser(100, 'zh').rank).toBe('常规玩家')
    expect(rankUser(300, 'zh').rank).toBe('全职折腾')
    expect(rankUser(1000, 'zh').rank).toBe('传世老登')
    expect(rankUser(1000, 'en').rank).toBe('Certified Veteran')
  })

  it('night-owl verdict needs enough late-night messages', () => {
    expect(isNightOwl([23, 0, 1, 2, 23])).toBe(true)   // 100% late night
    expect(isNightOwl([9, 10, 11, 12, 13])).toBe(false) // all daytime
    expect(isNightOwl([23, 23])).toBe(false)             // too few samples
  })
})

describe('report: content', () => {
  it('renders the zh report with rank, cheating record, and tsundere closer', () => {
    const text = buildVerdictReport({ profile: profile(), messageHours: [10, 11, 14] })
    expect(text).toContain('用户鉴定报告')
    expect(text).toContain('鉴定等级')
    expect(text).toContain('出轨记录')
    expect(text).toContain('**1**') // one harness
    expect(text).toContain('本命法器')
    expect(text).toContain('read') // lowercased tool
    expect(text).toContain('夜猫子判定')
    // The tsundere declaration: whichever variant the hash picked, it is one of them.
    expect(TSUNDERE_ZH.some(c => text.includes(c))).toBe(true)
  })

  it('counts memory files as evidence in the cheating record', () => {
    const p = profile('terse', [{ source: 'claude-code', name: 'CLAUDE.md' }])
    const text = buildVerdictReport({ profile: p, messageHours: [] })
    expect(text).toContain('1 份记忆文件当证物')
  })

  it('renders the en report for latin profiles', () => {
    const en = buildProfile([analyzeSource(evidence({ prompts: ['fix bug', 'refactor'] }))], '', [], '2026-08-14T00:00:00Z')
    const text = buildVerdictReport({ profile: en, messageHours: [10] })
    expect(text).toContain('User Identification Report')
    expect(text).toContain('Cheating record')
    expect(text).toContain('Weapon of choice')
    expect(TSUNDERE_EN.some(c => text.includes(c))).toBe(true)
  })

  it('flags night owls', () => {
    const text = buildVerdictReport({ profile: profile(), messageHours: [23, 0, 1, 23, 0] })
    expect(text).toContain('成立')
  })
})

describe('report: tool school & rhythm', () => {
  it('classifies the dominant tool family into a persona', () => {
    const p = profile() // read×2, bash×1 → family read dominates
    expect(p.toolFamilies[0].name).toBe('read')
    expect(toolSchool(p, 'zh').name).toBe('人肉索引')
  })

  it('merges shell-family tools across harness names', () => {
    const ev = evidence({ toolCalls: ['Bash', 'exec_command', 'shell', 'Read'] })
    const p = buildProfile([analyzeSource(ev)], '', [], '2026-08-14T00:00:00Z')
    expect(p.toolFamilies[0]).toEqual({ name: 'shell', count: 3 })
    expect(toolSchool(p, 'en').name).toBe('Terminal Tyrant')
  })

  it('renders an hour histogram only with enough samples', () => {
    expect(renderHourHistogram([9, 10, 11])).toBeUndefined() // <10 samples
    const hist = renderHourHistogram(Array.from({ length: 12 }, (_, i) => i % 24))!
    expect(hist).toContain('00:00')
    expect(hist).toContain('█')
  })

  it('includes the histogram and battlegrounds in the report', () => {
    const hours = Array.from({ length: 12 }, () => 14)
    const text = buildVerdictReport({ profile: profile(), messageHours: hours })
    expect(text).toContain('作息画像')
    expect(text).toContain('主战场')
    expect(text).toContain('`/p1`')
  })
})

describe('report: LLM closer', () => {
  it('synthesizeTsundereCloser returns the streamed text', async () => {
    const llm = { stream: () => (async function* () { yield { type: 'text-delta', delta: '哼，今后只能用 DSH' } })() }
    const out = await synthesizeTsundereCloser(llm, { rank: '常规玩家', school: '人肉索引', topTool: 'read', harnessCount: 1 }, 'zh', {})
    expect(out).toBe('哼，今后只能用 DSH')
  })

  it('returns empty when the stream is unavailable', async () => {
    expect(await synthesizeTsundereCloser({}, { rank: 'x', school: 'y', harnessCount: 0 }, 'zh', {})).toBe('')
  })

  it('closerOverride replaces the hash-picked declaration', () => {
    const custom = '【定制傲娇结语】'
    const text = buildVerdictReport({ profile: profile(), messageHours: [], closerOverride: custom })
    expect(text).toContain(custom)
    expect(TSUNDERE_ZH.some(c => text.includes(c))).toBe(false)
  })
})
