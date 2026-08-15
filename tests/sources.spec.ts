import { describe, expect, it } from 'vitest'
import {
  cleanMemoryContent,
  collectTranscriptFiles,
  extractSlashCommand,
  parseClaudeHistoryLine,
  parseClaudeLine,
  parseCodexLine,
  parsePiLine,
  resolveDefaultRoots,
  scanMemoryFiles,
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

  it('parses pi/omp session cwd, user text blocks, and assistant toolCalls', () => {
    const session = JSON.stringify({ type: 'session', version: 3, cwd: '/Users/x/pi-proj' })
    const user = JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: '修 bug' }] } })
    const assistant = JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '...' }, { type: 'toolCall', name: 'directorx_preflight' }] } })
    expect(parsePiLine(session).cwd).toBe('/Users/x/pi-proj')
    expect(parsePiLine(user).prompts).toEqual(['修 bug'])
    expect(parsePiLine(assistant).tools).toEqual(['directorx_preflight'])
  })

  it('parses pi user messages with plain-string content', () => {
    const user = JSON.stringify({ type: 'message', message: { role: 'user', content: '字符串内容' } })
    expect(parsePiLine(user).prompts).toEqual(['字符串内容'])
  })

  it('parses Claude Code history.jsonl display+project lines and captures the hour', () => {
    const line = JSON.stringify({ display: '/model', project: '/Users/x/proj', timestamp: '2026-08-13T14:05:00Z' })
    const parsed = parseClaudeHistoryLine(line)
    expect(parsed.prompts).toEqual(['/model'])
    expect(parsed.tools).toEqual([])
    expect(parsed.cwd).toBe('/Users/x/proj')
    expect(parsed.hour).toBe(new Date('2026-08-13T14:05:00Z').getHours())
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

  it('scans claude + codex + pi sources in parallel', async () => {
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
    await fs.seed('/home/.pi/agent/sessions/proj/s1.jsonl', [
      JSON.stringify({ type: 'session', cwd: '/p3' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'pi 里的提问' }] } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'bash' }] } }),
    ].join('\n'))

    const roots = resolveDefaultRoots('/home')
    delete roots.omp
    delete roots['claude-history']
    const evidence = await scanSources(fs as never, roots, defaultParsers, defaultLimits)
    expect(evidence.map(e => e.source).sort()).toEqual(['claude-code', 'codex', 'pi'])

    const cc = evidence.find(e => e.source === 'claude-code')!
    expect(cc.toolCalls).toEqual(['Read', 'Read', 'Bash'])
    expect(cc.slashCommands).toEqual(['/review'])

    const pi = evidence.find(e => e.source === 'pi')!
    expect(pi.toolCalls).toEqual(['bash'])
    expect(pi.cwds).toEqual(['/p3'])
    expect(pi.prompts).toEqual(['pi 里的提问'])
  })

  it('scans a single-file root (claude-history) directly', async () => {
    const fs = new MemFs()
    await fs.seed('/home/.claude/history.jsonl', [
      JSON.stringify({ display: '/model', project: '/p1' }),
      JSON.stringify({ display: '/init 一下', project: '/p1' }),
    ].join('\n'))
    const evidence = await scanSources(fs as never, { 'claude-history': '/home/.claude/history.jsonl' }, defaultParsers, defaultLimits)
    expect(evidence).toHaveLength(1)
    expect(evidence[0].filesScanned).toBe(1)
    expect(evidence[0].slashCommands).toEqual(['/model', '/init'])
    expect(evidence[0].cwds).toEqual(['/p1'])
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

describe('sources: memory files', () => {
  it('strips cursor .mdc frontmatter', () => {
    const raw = '---\ndescription: rule\n---\nAlways use pnpm.'
    expect(cleanMemoryContent(raw)).toBe('Always use pnpm.')
    expect(cleanMemoryContent('plain')).toBe('plain')
  })

  it('discovers CLAUDE.md, Codex AGENTS.md, GEMINI.md, and cursor rules/agents', async () => {
    const fs = new MemFs()
    await fs.seed('/home/.claude/CLAUDE.md', 'I prefer terse answers.')
    await fs.seed('/home/.codex/AGENTS.md', '# Codex manual')
    await fs.seed('/home/.gemini/GEMINI.md', 'Gemini context.')
    await fs.seed('/home/.cursor/rules/style.mdc', '---\ndescription: style\n---\nUse 2-space indent.')
    await fs.seed('/home/.cursor/agents/reviewer.md', 'You review code.')

    const found = await scanMemoryFiles(fs as never, '/home')
    const keys = found.map(f => `${f.source}/${f.name}`)
    expect(keys).toEqual([
      'claude-code/CLAUDE.md',
      'codex/AGENTS.md',
      'cursor/agents/reviewer.md',
      'cursor/rules/style.mdc',
      'gemini-cli/GEMINI.md',
    ])
    const mdc = found.find(f => f.name === 'rules/style.mdc')!
    expect(mdc.content).toBe('Use 2-space indent.') // frontmatter stripped
  })

  it('bounds memory content and skips empty/missing files', async () => {
    const fs = new MemFs()
    await fs.seed('/home/.claude/CLAUDE.md', 'x'.repeat(50))
    await fs.seed('/home/.codex/AGENTS.md', '   ') // empty after trim → skipped
    const found = await scanMemoryFiles(fs as never, '/home', 10)
    expect(found).toHaveLength(1)
    expect(found[0].content).toHaveLength(11) // 10 chars + ellipsis
  })
})
