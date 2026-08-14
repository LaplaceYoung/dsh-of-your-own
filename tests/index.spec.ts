import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.ts'
import { AGENTS_MANAGED_BEGIN } from '../src/store.ts'
import { MemFs } from './memfs.ts'

/** Minimal `ctx.commands` stub modeled on DSH's command registry. */
class CommandsStub extends Service {
  static inject: string[] = []
  registry = new Map<string, { description: string; handler: (inv: { rawInput: string }) => Promise<{ kind: string; text: string }> }>()
  constructor(ctx: Context) { super(ctx, 'commands') }
  register(def: { name: string; description: string; handler: (inv: { rawInput: string }) => Promise<{ kind: string; text: string }> }): () => void {
    this.registry.set(def.name, def)
    return () => { this.registry.delete(def.name) }
  }
}

/** Minimal `ctx.tools` stub modeled on DSH's tools registry. */
class ToolsStub extends Service {
  static inject: string[] = []
  registry = new Map<string, { execute(args: unknown): Promise<unknown> }>()
  constructor(ctx: Context) { super(ctx, 'tools') }
  register(def: { name: string } & Record<string, unknown>): () => void {
    this.registry.set(def.name, def as never)
    return () => { this.registry.delete(def.name) }
  }
}

/** Minimal `ctx.systemPrompt` stub capturing context() sections. */
class SystemPromptStub extends Service {
  static inject: string[] = []
  injected: { name: string; order: number; text: string }[] = []
  constructor(ctx: Context) { super(ctx, 'systemPrompt') }
  context(entry: { name: string; order: number; text: string }): () => void {
    this.injected.push(entry)
    return () => {}
  }
}

/** Minimal `ctx.fs` service backed by MemFs (arrow props keep `this` safe). */
class FsStub extends Service {
  static inject: string[] = []
  mem = new MemFs()
  constructor(ctx: Context) { super(ctx, 'fs') }
  readText = (p: string): Promise<string> => this.mem.readText(p)
  writeText = (p: string, c: string): Promise<void> => this.mem.writeText(p, c)
  listDir = (p: string): Promise<{ name: string; isDirectory: boolean; mtimeMs?: number }[]> => this.mem.listDir(p)
  exists = (p: string): Promise<boolean> => this.mem.exists(p)
  remove = (p: string): Promise<void> => this.mem.remove(p)
}

/** Minimal `ctx.llm` service recording stream options. */
class LlmStub extends Service {
  static inject: string[] = []
  calls: { provider?: string; model?: string }[] = []
  constructor(ctx: Context) { super(ctx, 'llm') }
  stream(options: { provider?: string; model?: string }): AsyncIterable<{ type?: string; delta?: string }> {
    this.calls.push(options)
    return (async function* () { yield { type: 'text-delta', delta: '- 偏好中文简洁回复' } })()
  }
}

/** Wait for the fire-and-forget boot recall to settle. */
async function tick(ms = 5): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

const config = {
  home: '/home',
  storeDir: '/home/.dsh/of-your-own',
  agentsMdPath: '/home/.dsh/AGENTS.md',
  roots: { 'claude-code': '/home/.claude/projects', codex: '/home/.codex/sessions' },
}

/** Seed transcripts + native memory files into the MemFs. */
function seedWorld(mem: MemFs): void {
  mem.seed('/home/.claude/projects/proj/s1.jsonl', [
    JSON.stringify({ type: 'user', message: { role: 'user', content: '/review 这个改动' }, cwd: '/p1', sessionId: 'cc-1', timestamp: '2026-08-13T09:00:00Z' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: '帮我修一下这个 bug' }, cwd: '/p1', sessionId: 'cc-1', timestamp: '2026-08-13T09:01:00Z' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Bash' }, { type: 'text', text: '已定位到问题所在' }] }, sessionId: 'cc-1', timestamp: '2026-08-13T09:02:00Z' }),
  ].join('\n'))
  mem.seed('/home/.codex/sessions/2026/01/01/rollout-1.jsonl', [
    JSON.stringify({ type: 'session_meta', payload: { session_id: 'cx-1', cwd: '/p2', timestamp: '2026-08-12T00:00:00Z' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '重构这段代码' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'apply_patch' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '重构完毕' }] } }),
  ].join('\n'))
  mem.seed('/home/.claude/CLAUDE.md', '我喜欢简洁的中文回复。')
  mem.seed('/home/.cursor/rules/style.mdc', '---\ndescription: style\n---\nUse pnpm, never npm.')
}

async function boot(): Promise<{ ctx: Context; fs: FsStub }> {
  const ctx = new Context()
  await ctx.plugin(CommandsStub)
  await ctx.plugin(ToolsStub)
  await ctx.plugin(SystemPromptStub)
  await ctx.plugin(FsStub)
  const fs = ctx.get('fs') as unknown as FsStub
  seedWorld(fs.mem)
  return { ctx, fs }
}

describe('@dsh-external/dsh-of-your-own plugin', () => {
  it('registers /fuck and both inspection tools', async () => {
    const { ctx } = await boot()
    await ctx.plugin(plugin, config)
    const commands = ctx.get('commands') as unknown as CommandsStub
    const tools = ctx.get('tools') as unknown as ToolsStub
    expect(commands.registry.has('fuck')).toBe(true)
    expect(tools.registry.has('my_profile')).toBe(true)
    expect(tools.registry.has('my_commands')).toBe(true)
  })

  it('/fuck scans transcripts + memory files, writes native AGENTS.md, injects preferences', async () => {
    const { ctx, fs } = await boot()
    await ctx.plugin(plugin, config)
    const commands = ctx.get('commands') as unknown as CommandsStub
    const sp = ctx.get('systemPrompt') as unknown as SystemPromptStub

    const result = await commands.registry.get('fuck')!.handler({ rawInput: '/fuck' })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('迁移完成')
    expect(result.text).toContain('claude-code')
    expect(result.text).toContain('codex')
    expect(result.text).toContain('原生注入')
    expect(result.text).toContain('claude-code/CLAUDE.md')

    // Profile persisted to disk.
    const stored = JSON.parse(await fs.mem.readText('/home/.dsh/of-your-own/profile.json'))
    expect(stored.version).toBe(1)
    expect(stored.memoryFiles).toEqual([
      { source: 'claude-code', name: 'CLAUDE.md' },
      { source: 'cursor', name: 'rules/style.mdc' },
    ])

    // Native AGENTS.md carries the managed block (DSH auto-loads it).
    const agentsMd = await fs.mem.readText('/home/.dsh/AGENTS.md')
    expect(agentsMd).toContain(AGENTS_MANAGED_BEGIN)
    expect(agentsMd).toContain('# User Preferences')

    // Command stubs migrated.
    expect(await fs.mem.readText('/home/.dsh/of-your-own/commands/review.md')).toContain('# /review')

    // Preferences injected into the system prompt.
    expect(sp.injected.some(e => e.name === 'user-preferences')).toBe(true)
  })

  it('re-running /fuck upserts the managed block without duplication', async () => {
    const { ctx, fs } = await boot()
    await ctx.plugin(plugin, config)
    const commands = ctx.get('commands') as unknown as CommandsStub
    await commands.registry.get('fuck')!.handler({ rawInput: '/fuck' })
    await commands.registry.get('fuck')!.handler({ rawInput: '/fuck' })
    const agentsMd = await fs.mem.readText('/home/.dsh/AGENTS.md')
    expect((agentsMd.match(/dsh-of-your-own:begin/g) ?? []).length).toBe(1)
  })

  it('preserves user-authored content in AGENTS.md outside the block', async () => {
    const { ctx, fs } = await boot()
    await fs.mem.writeText('/home/.dsh/AGENTS.md', '# My rules\n\nKeep this.\n')
    await ctx.plugin(plugin, config)
    const commands = ctx.get('commands') as unknown as CommandsStub
    await commands.registry.get('fuck')!.handler({ rawInput: '/fuck' })
    const agentsMd = await fs.mem.readText('/home/.dsh/AGENTS.md')
    expect(agentsMd).toContain('# My rules')
    expect(agentsMd).toContain('Keep this.')
    expect(agentsMd).toContain(AGENTS_MANAGED_BEGIN)
  })

  it('/fuck succeeds on memory files alone when no transcripts exist', async () => {
    const { ctx, fs } = await boot()
    await fs.mem.remove('/home/.claude/projects/proj/s1.jsonl')
    await fs.mem.remove('/home/.codex/sessions/2026/01/01/rollout-1.jsonl')
    await ctx.plugin(plugin, config)
    const commands = ctx.get('commands') as unknown as CommandsStub
    const result = await commands.registry.get('fuck')!.handler({ rawInput: '/fuck' })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('claude-code/CLAUDE.md')
  })

  it('/fuck reports nothing found when neither transcripts nor memory files exist', async () => {
    const { ctx, fs } = await boot()
    await fs.mem.remove('/home/.claude/projects/proj/s1.jsonl')
    await fs.mem.remove('/home/.codex/sessions/2026/01/01/rollout-1.jsonl')
    await fs.mem.remove('/home/.claude/CLAUDE.md')
    await fs.mem.remove('/home/.cursor/rules/style.mdc')
    await ctx.plugin(plugin, config)
    const commands = ctx.get('commands') as unknown as CommandsStub
    const result = await commands.registry.get('fuck')!.handler({ rawInput: '/fuck' })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('No transcript history')
  })

  it('my_profile reads the stored profile; refresh re-scans', async () => {
    const { ctx } = await boot()
    await ctx.plugin(plugin, config)
    const tools = ctx.get('tools') as unknown as ToolsStub
    const commands = ctx.get('commands') as unknown as CommandsStub

    expect(await tools.registry.get('my_profile')!.execute({})).toContain('no profile yet')

    await commands.registry.get('fuck')!.handler({ rawInput: '/fuck' })
    const section = await tools.registry.get('my_profile')!.execute({})
    expect(section).toContain('# User Preferences')
    expect(section).toContain('read×2')

    const refreshed = await tools.registry.get('my_profile')!.execute({ refresh: true })
    expect(refreshed).toContain('# User Preferences')
  })

  it('my_commands lists migrated commands after /fuck', async () => {
    const { ctx } = await boot()
    await ctx.plugin(plugin, config)
    const tools = ctx.get('tools') as unknown as ToolsStub
    const commands = ctx.get('commands') as unknown as CommandsStub

    expect(await tools.registry.get('my_commands')!.execute({})).toContain('no migrated commands')
    await commands.registry.get('fuck')!.handler({ rawInput: '/fuck' })
    expect(await tools.registry.get('my_commands')!.execute({})).toContain('/review')
  })

  it('re-injects a persisted profile at registration (boot-time recall)', async () => {
    const { ctx, fs } = await boot()
    await ctx.plugin(plugin, config)
    const commands = ctx.get('commands') as unknown as CommandsStub
    await commands.registry.get('fuck')!.handler({ rawInput: '/fuck' })

    // A fresh composition sharing the same store recalls the profile on boot.
    const ctx2 = new Context()
    await ctx2.plugin(CommandsStub)
    await ctx2.plugin(ToolsStub)
    await ctx2.plugin(SystemPromptStub)
    await ctx2.plugin(FsStub)
    const fs2 = ctx2.get('fs') as unknown as FsStub
    fs2.mem = fs.mem // share the persisted store
    await ctx2.plugin(plugin, config)
    await tick()
    const sp2 = ctx2.get('systemPrompt') as unknown as SystemPromptStub
    expect(sp2.injected.some(e => e.name === 'user-preferences')).toBe(true)
  })

  it('uses the LLM seam for preferences when configured', async () => {
    const { ctx } = await boot()
    await ctx.plugin(LlmStub)
    await ctx.plugin(plugin, { ...config, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    const commands = ctx.get('commands') as unknown as CommandsStub
    const llm = ctx.get('llm') as unknown as LlmStub

    const result = await commands.registry.get('fuck')!.handler({ rawInput: '/fuck' })
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0]).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    expect(result.text).toContain('偏好中文简洁回复')
  })

  it('disposes cleanly', async () => {
    const { ctx } = await boot()
    const fiber = await ctx.plugin(plugin, config)
    const commands = ctx.get('commands') as unknown as CommandsStub
    expect(commands.registry.has('fuck')).toBe(true)
    await fiber.dispose()
    expect(commands.registry.has('fuck')).toBe(false)
  })

  it('registers /sessions and /resume', async () => {
    const { ctx } = await boot()
    await ctx.plugin(plugin, config)
    const commands = ctx.get('commands') as unknown as CommandsStub
    expect(commands.registry.has('sessions')).toBe(true)
    expect(commands.registry.has('resume')).toBe(true)
  })

  it('/sessions lists sessions newest first with titles', async () => {
    const { ctx } = await boot()
    await ctx.plugin(plugin, config)
    const commands = ctx.get('commands') as unknown as CommandsStub
    const result = await commands.registry.get('sessions')!.handler({ rawInput: '/sessions' })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('## Resumable sessions')
    expect(result.text).toContain('claude-code')
    expect(result.text).toContain('codex')
    // Newest first: cc-1 (Aug 13) before cx-1 (Aug 12).
    const ccIdx = result.text.indexOf('/review 这个改动')
    const cxIdx = result.text.indexOf('重构这段代码')
    expect(ccIdx).toBeLessThan(cxIdx)
    expect(ccIdx).toBeGreaterThan(-1)
  })

  it('/resume by number injects the handoff brief and reports identity', async () => {
    const { ctx } = await boot()
    await ctx.plugin(plugin, config)
    const commands = ctx.get('commands') as unknown as CommandsStub
    const sp = ctx.get('systemPrompt') as unknown as SystemPromptStub

    const result = await commands.registry.get('resume')!.handler({ rawInput: '/resume 1' })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('## Resuming claude-code session')
    expect(result.text).toContain('# Resumed task (from claude-code)')

    // Brief injected so the agent continues the task this session.
    const resumed = sp.injected.find(e => e.name.startsWith('resumed-task-'))
    expect(resumed).toBeDefined()
    expect(resumed!.text).toContain('Original task: /review 这个改动')
    expect(resumed!.text).toContain('已定位到问题所在')
    expect(resumed!.text).toContain('Read×2')
  })

  it('/resume matches by id prefix and title fragment', async () => {
    const { ctx } = await boot()
    await ctx.plugin(plugin, config)
    const commands = ctx.get('commands') as unknown as CommandsStub

    const byId = await commands.registry.get('resume')!.handler({ rawInput: '/resume cx-1' })
    expect(byId.kind).toBe('success')
    expect(byId.text).toContain('codex session `cx-1`')

    const byTitle = await commands.registry.get('resume')!.handler({ rawInput: '/resume 重构' })
    expect(byTitle.kind).toBe('success')
    expect(byTitle.text).toContain('codex session `cx-1`')
  })

  it('/resume rejects missing args and unknown matches', async () => {
    const { ctx } = await boot()
    await ctx.plugin(plugin, config)
    const commands = ctx.get('commands') as unknown as CommandsStub

    const noArg = await commands.registry.get('resume')!.handler({ rawInput: '/resume' })
    expect(noArg.kind).toBe('error')
    expect(noArg.text).toContain('/sessions first')

    const miss = await commands.registry.get('resume')!.handler({ rawInput: '/resume 不存在的任务xyz' })
    expect(miss.kind).toBe('error')
    expect(miss.text).toContain('No session matches')
  })
})
