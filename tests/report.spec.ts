import { describe, expect, it } from 'vitest'
import { buildProfile, analyzeSource } from '../src/analyze.ts'
import type { SourceEvidence } from '../src/sources.ts'
import { buildVerdictReport, hashString, isNightOwl, rankUser, TSUNDERE_ZH, TSUNDERE_EN } from '../src/report.ts'

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
