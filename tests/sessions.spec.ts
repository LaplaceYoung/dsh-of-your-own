import { describe, expect, it } from 'vitest'
import {
  buildHandoffBrief,
  cleanTitle,
  defaultSessionLimits,
  extractClaudeHistorySessions,
  extractClaudeSession,
  extractCodexSession,
  extractPiSession,
  homeRelative,
  listSessions,
  relativeTime,
  renderResumeReport,
  renderSessionList,
  snippet,
  toEpochMs,
} from '../src/sessions.ts'
import { MemFs } from './memfs.ts'

const NOW = Date.parse('2026-08-14T12:00:00Z')

describe('sessions: primitives', () => {
  it('toEpochMs handles ISO strings, ms, and seconds', () => {
    expect(toEpochMs('2026-08-14T12:00:00Z')).toBe(NOW)
    expect(toEpochMs(NOW)).toBe(NOW)
    expect(toEpochMs(NOW / 1000)).toBe(NOW) // seconds → ms
    expect(toEpochMs('not a date')).toBeUndefined()
    expect(toEpochMs(undefined)).toBeUndefined()
  })

  it('snippet flattens and truncates', () => {
    expect(snippet('a\n\nb', 10)).toBe('a b')
    expect(snippet('x'.repeat(50), 10)).toBe('xxxxxxxxxx…')
  })

  it('relativeTime renders compact durations', () => {
    expect(relativeTime(NOW, NOW)).toBe('just now')
    expect(relativeTime(NOW, NOW - 5 * 60_000)).toBe('5m ago')
    expect(relativeTime(NOW, NOW - 3 * 3_600_000)).toBe('3h ago')
    expect(relativeTime(NOW, NOW - 10 * 86_400_000)).toBe('10d ago')
    expect(relativeTime(NOW, undefined)).toBe('—')
  })

  it('homeRelative collapses the home prefix', () => {
    expect(homeRelative('/home/x/proj', '/home/x')).toBe('~/proj')
    expect(homeRelative('/elsewhere', '/home/x')).toBe('/elsewhere')
    expect(homeRelative('', '/home/x')).toBe('')
  })
})

describe('sessions: extractors', () => {
  it('cleanTitle strips wrapper tags and rejects empty results', () => {
    expect(cleanTitle('<teammate-message teammate_id="lead">帮我改这个</teammate-message>')).toBeUndefined()
    expect(cleanTitle('<local-command-caveat>text only')).toBeUndefined()
    expect(cleanTitle('<truncated-tag-no-close')).toBeUndefined()
    expect(cleanTitle('')).toBeUndefined()
  })

  it('extractClaudeSession falls past wrapper-tagged titles to the first clean prompt', () => {
    const text = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '<teammate-message teammate_id="lead">内部协调消息' }, sessionId: 'x' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '真正的人类任务' }, sessionId: 'x' }),
    ].join('\n')
    const rec = extractClaudeSession(text, '/x/s.jsonl', defaultSessionLimits)!
    expect(rec.title).toBe('真正的人类任务')
  })

  it('extracts a Claude Code session (title = first prompt, tools, cwd, timestamps)', () => {
    const text = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '修登录 bug' }, cwd: '/p1', sessionId: 'abc', timestamp: '2026-08-13T09:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }, { type: 'text', text: '我来看一下 auth 模块' }] }, timestamp: '2026-08-13T09:01:00Z' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '顺便加个测试' }, timestamp: '2026-08-13T09:02:00Z' }),
    ].join('\n')
    const rec = extractClaudeSession(text, '/x/s1.jsonl', defaultSessionLimits)!
    expect(rec.id).toBe('abc')
    expect(rec.cwd).toBe('/p1')
    expect(rec.title).toBe('修登录 bug')
    expect(rec.userMessages).toBe(2)
    expect(rec.assistantMessages).toBe(1)
    expect(rec.toolNames).toEqual(['Read'])
    expect(rec.recentUserPrompts).toEqual(['修登录 bug', '顺便加个测试'])
    expect(rec.lastAssistantText).toBe('我来看一下 auth 模块')
    expect(rec.lastMs).toBe(Date.parse('2026-08-13T09:02:00Z'))
  })

  it('returns undefined for empty Claude transcripts', () => {
    expect(extractClaudeSession('{"type":"mode"}\n', '/x/s.jsonl', defaultSessionLimits)).toBeUndefined()
  })

  it('extracts a Codex rollout (session_id, cwd, output_text tail)', () => {
    const text = [
      JSON.stringify({ type: 'session_meta', payload: { session_id: 's-42', cwd: '/p2', timestamp: '2026-08-12T00:00:00Z' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '重构支付模块' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'apply_patch' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '重构完成，待验证' }] } }),
    ].join('\n')
    const rec = extractCodexSession(text, '/x/r.jsonl', defaultSessionLimits)
    expect(rec.id).toBe('s-42')
    expect(rec.title).toBe('重构支付模块')
    expect(rec.toolNames).toEqual(['apply_patch'])
    expect(rec.lastAssistantText).toBe('重构完成，待验证')
  })

  it('extracts a pi session and prefers explicit omp title lines', () => {
    const text = [
      JSON.stringify({ type: 'session', id: 'pi-1', cwd: '/p3', timestamp: '2026-08-11T00:00:00Z' }),
      JSON.stringify({ type: 'title', title: '重构 Moss 3.0 本地应用' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: '继续上次的工作' }] } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'bash' }] } }),
    ].join('\n')
    const rec = extractPiSession(text, '/x/o.jsonl', defaultSessionLimits, 'omp')!
    expect(rec.id).toBe('pi-1')
    expect(rec.source).toBe('omp')
    expect(rec.title).toBe('重构 Moss 3.0 本地应用') // title line wins over first prompt
    expect(rec.toolNames).toEqual(['bash'])
  })

  it('groups claude history.jsonl into per-session records', () => {
    const text = [
      JSON.stringify({ display: '/model', sessionId: 's1', project: '/proj', timestamp: 1785726600458 }),
      JSON.stringify({ display: '开发 video agent', sessionId: 's1', project: '/proj', timestamp: 1785726869809 }),
      JSON.stringify({ display: '另一个任务', sessionId: 's2', project: '/other', timestamp: 1785727000000 }),
    ].join('\n')
    const records = extractClaudeHistorySessions(text, '/x/history.jsonl', defaultSessionLimits)
    expect(records).toHaveLength(2)
    const s1 = records.find(r => r.id === 's1')!
    expect(s1.userMessages).toBe(2)
    expect(s1.cwd).toBe('/proj')
    expect(s1.title).toBe('/model')
  })
})

describe('sessions: listSessions', () => {
  it('walks all roots in parallel and sorts newest first', async () => {
    const fs = new MemFs()
    await fs.seed('/home/.claude/projects/a/s1.jsonl', JSON.stringify({ type: 'user', message: { role: 'user', content: '老任务' }, sessionId: 'old', timestamp: '2026-08-01T00:00:00Z' }))
    await fs.seed('/home/.codex/sessions/2026/08/13/r.jsonl', [
      JSON.stringify({ type: 'session_meta', payload: { session_id: 'new', cwd: '/p', timestamp: '2026-08-13T00:00:00Z' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '新任务' }] } }),
    ].join('\n'))
    await fs.seed('/home/.claude/history.jsonl', JSON.stringify({ display: '历史任务', sessionId: 'h1', project: '/p', timestamp: 1785800000000 }))

    const records = await listSessions(fs as never, {
      'claude-code': '/home/.claude/projects',
      codex: '/home/.codex/sessions',
      'claude-history': '/home/.claude/history.jsonl',
    })
    expect(records.map(r => r.id)).toEqual(['new', 'h1', 'old']) // sorted newest first
    expect(records.map(r => r.source)).toContain('claude-history')
  })

  it('honors maxFilesPerSource', async () => {
    const fs = new MemFs()
    for (let i = 0; i < 4; i++) {
      await fs.seed(`/home/.claude/projects/p/s${i}.jsonl`, JSON.stringify({ type: 'user', message: { role: 'user', content: `task ${i}` }, sessionId: `s${i}` }))
    }
    const records = await listSessions(fs as never, { 'claude-code': '/home/.claude/projects' }, { ...defaultSessionLimits, maxFilesPerSource: 2 })
    expect(records).toHaveLength(2)
  })

  it('returns empty for missing roots', async () => {
    const fs = new MemFs()
    expect(await listSessions(fs as never, { codex: '/nope' })).toEqual([])
  })
})

describe('sessions: rendering', () => {
  const record = {
    source: 'claude-code', id: 'abc', file: '/f', cwd: '/home/x/proj',
    title: '修登录 bug', userMessages: 12, assistantMessages: 15,
    toolNames: ['Read', 'Read', 'Bash'],
    recentUserPrompts: ['先修登录', '顺便加测试'],
    lastAssistantText: '已定位到 token 过期问题',
    lastMs: NOW - 3_600_000,
  }

  it('renderSessionList prints numbered rows with dir/when/msgs', () => {
    const text = renderSessionList([record], '/home/x', NOW)
    expect(text).toContain('## Resumable sessions (1)')
    expect(text).toContain('  1  claude-code')
    expect(text).toContain('修登录 bug')
    expect(text).toContain('~/proj')
    expect(text).toContain('1h ago')
    expect(text).toContain('/resume <#>')
  })

  it('renderSessionList handles empty catalogs', () => {
    expect(renderSessionList([], '/home/x', NOW)).toContain('No resumable sessions')
  })

  it('buildHandoffBrief carries task, direction, stopping point, and tools', () => {
    const brief = buildHandoffBrief(record)
    expect(brief).toContain('# Resumed task (from claude-code)')
    expect(brief).toContain('Original task: 修登录 bug')
    expect(brief).toContain('Working directory: /home/x/proj')
    expect(brief).toContain('- 先修登录')
    expect(brief).toContain('已定位到 token 过期问题')
    expect(brief).toContain('Read×2')
  })

  it('renderResumeReport leads with identity and stats', () => {
    const report = renderResumeReport(record, 'BRIEF')
    expect(report).toContain('## Resuming claude-code session `abc`')
    expect(report).toContain('12 user messages · 15 assistant messages')
    expect(report).toContain('BRIEF')
  })
})
