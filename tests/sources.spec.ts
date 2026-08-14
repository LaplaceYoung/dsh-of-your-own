import { describe, expect, it } from 'vitest'
import {
  collectTranscriptFiles,
  detectLanguage,
  extractSlashCommand,
  parseClaudeLine,
  parseCodexLine,
  resolveDefaultRoots,
  scanSources,
  defaultParsers,
  defaultLimits,
} from '../src/sources.ts'
import { MemFs } from './memfs.ts'

describe('sources: line parsers', () => {
  it('parses Claude Code user prompts and cwd', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '帮我修一下这个 bug' },
      cwd: '/Users/x/proj',
      sessionId: 'abc',
    })
    expect(parseClaudeLine(line)).toEqual({ prompts: ['帮我修一下这个 bug'], tools: [], cwd: '/Users/x/proj' })
  })

  it('parses Claude Code tool_use blocks from assistant messages', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Bash' }] },
    })
    expect(parseClaudeLine(line).tools).toEqual(['Read', 'Bash'])
  })

  it('skips malformed Claude lines without throwing', () => {
    expect(parseClaudeLine('{not json')).toEqual({ prompts: [], tools: [] })
    expect(parseClaudeLine('')).toEqual({ prompts: [], tools: [] })
  })

  it('parses Codex session_meta cwd', () => {
    const line = JSON.stringify({ type: 'session_meta', payload: { cwd: '/Users/x/app' } })
    expect(parseCodexLine(line).cwd).toBe('/Users/x/app')
  })

  it('parses Codex function_call and local_shell_call', () => {
    const fc = JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'apply_patch' } })
    const shell = JSON.stringify({ type: 'response_item', payload: { type: 'local_shell_call' } })
    expect(parseCodexLine(fc).tools).toEqual(['apply_patch'])
    expect(parseCodexLine(shell).tools).toEqual(['shell'])
  })

  it('parses Codex user message content shapes', () => {
    const arrayContent = JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '重构这段' }] },
    })
    const stringContent = JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: 'plain prompt' },
    })
    const eventMsg = JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'event prompt' } })
    expect(parseCodexLine(arrayContent).prompts).toEqual(['重构这段'])
    expect(parseCodexLine(stringContent).prompts).toEqual(['plain prompt'])
    expect(parseCodexLine(eventMsg).prompts).toEqual(['event prompt'])
  })
})

describe('sources: prompt heuristics', () => {
  it('extracts slash commands and rejects paths', () => {
    expect(extractSlashCommand('/review the diff')).toBe('/review')
    expect(extractSlashCommand('/memory 记住这个')).toBe('/memory')
    expect(extractSlashCommand('/Users/x/file')).toBeUndefined()
    expect(extractSlashCommand('please run /review')).toBeUndefined()
    expect(extractSlashCommand('')).toBeUndefined()
  })

  it('detects zh vs en prompts', () => {
    expect(detectLanguage('帮我写一个函数')).toBe('zh')
    expect(detectLanguage('write me a function')).toBe('en')
  })
})

describe('sources: scanning', () => {
  it('collects jsonl files recursively, newest first', async () => {
    const fs = new MemFs()
    await fs.seed('/root/a/one.jsonl', '{}')
    await fs.seed('/root/b/two.jsonl', '{}')
    await fs.seed('/root/readme.txt', 'skip me')
    const files = await collectTranscriptFiles(fs as never, '/root')
    expect(files).toHaveLength(2)
    expect(files.every(f => f.endsWith('.jsonl'))).toBe(true)
  })

  it('scans both sources in parallel and aggregates evidence', async () => {
    const fs = new MemFs()
    await fs.seed('/home/.claude/projects/proj/s1.jsonl', [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '/review 这个改动' }, cwd: '/p1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Bash' }] } }),
    ].join('\n'))
    await fs.seed('/home/.codex/sessions/2026/01/01/rollout-1.jsonl', [
      JSON.stringify({ type: 'session_meta', payload: { cwd: '/p2' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '修 bug' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'apply_patch' } }),
    ].join('\n'))

    const roots = resolveDefaultRoots('/home')
    const evidence = await scanSources(fs as never, roots, defaultParsers, defaultLimits)
    expect(evidence.map(e => e.source).sort()).toEqual(['claude-code', 'codex'])

    const cc = evidence.find(e => e.source === 'claude-code')!
    expect(cc.toolCalls).toEqual(['Read', 'Read', 'Bash'])
    expect(cc.slashCommands).toEqual(['/review'])
    expect(cc.cwds).toEqual(['/p1'])

    const cx = evidence.find(e => e.source === 'codex')!
    expect(cx.toolCalls).toEqual(['apply_patch'])
    expect(cx.cwds).toEqual(['/p2'])
    expect(cx.prompts).toEqual(['修 bug'])
  })

  it('honors maxFilesPerSource and maxPrompts limits', async () => {
    const fs = new MemFs()
    for (let i = 0; i < 5; i++) {
      await fs.seed(`/home/.claude/projects/p/s${i}.jsonl`, JSON.stringify({ type: 'user', message: { role: 'user', content: `prompt ${i}` } }))
    }
    const roots = { 'claude-code': '/home/.claude/projects' }
    const evidence = await scanSources(fs as never, roots, defaultParsers, { maxFilesPerSource: 2, maxBytesPerFile: 4096, maxPrompts: 1 })
    expect(evidence[0].filesScanned).toBe(2)
    expect(evidence[0].prompts).toHaveLength(1)
  })

  it('drops empty sources', async () => {
    const fs = new MemFs()
    const evidence = await scanSources(fs as never, { 'claude-code': '/nope' }, defaultParsers, defaultLimits)
    expect(evidence).toEqual([])
  })
})
