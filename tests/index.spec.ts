import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.ts'
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

/** Seed realistic transcripts into the MemFs. */
function seedTranscripts(mem: MemFs): void {
  mem.seed('/home/.claude/projects/proj/s1.jsonl', [
    JSON.stringify({ type: 'user', message: { role: 'user', content: '/review 这个改动' }, cwd: '/p1' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: '帮我修一下这个 bug' }, cwd: '/p1' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Bash' }] } }),
  ].join('\n'))
  mem.seed('/home/.codex/sessions/2026/01/01/rollout-1.jsonl', [
    JSON.stringify({ type: 'session_meta', payload: { cwd: '/p2' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '重构这段代码' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'apply_patch' } }),
  ].join('\n'))
}

const roots = { 'claude-code': '/home/.claude/projects', codex: '/home/.codex/sessions' }

async function boot(withSystemPrompt = true): Promise<{ ctx: Context; fs: FsStub }> {
  const ctx = new Context()
  await ctx.plugin(CommandsStub)
  await ctx.plugin(ToolsStub)
  if (withSystemPrompt) await ctx.plugin(SystemPromptStub)
  await ctx.plugin(FsStub)
  const fs = ctx.get('fs') as unknown as FsStub
  seedTranscripts(fs.mem)
  return { ctx, fs }
}

describe('@dsh-external/dsh-of-your-own plugin', () => {
  it('registers /fuck and both inspection tools', async () => {
    const { ctx } = await boot()
    await ctx.plugin(plugin, { storeDir: '/home/.dsh/of-your-own', roots })
    const commands = ctx.get('commands') as unknown as CommandsStub
    const tools = ctx.get('tools') as unknown as ToolsStub
    expect(commands.registry.has('fuck')).toBe(true)
    expect(tools.registry.has('my_profile')).toBe(true)
    expect(tools.registry.has('my_commands')).toBe(true)
  })

  it('/fuck scans in parallel, persists a profile, and injects preferences', async () => {
    const { ctx, fs } = await boot()
    await ctx.plugin(plugin, { storeDir: '/home/.dsh/of-your-own', roots })
    const commands = ctx.get('commands') as unknown as CommandsStub
    const sp = ctx.get('systemPrompt') as unknown as SystemPromptStub

    const result = await commands.registry.get('fuck')!.handler({ rawInput: '/fuck' })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('迁移完成')
    expect(result.text).toContain('claude-code')
    expect(result.text).toContain('codex')

    // Profile persisted to disk.
    const stored = await fs.mem.readText('/home/.dsh/of-your-own/profile.json')
    expect(JSON.parse(stored).version).toBe(1)

    // Command stubs migrated.
    const stub = await fs.mem.readText('/home/.dsh/of-your-own/commands/review.md')
    expect(stub).toContain('# /review')

    // Preferences injected into the system prompt.
    expect(sp.injected.some(e => e.name === 'user-preferences')).toBe(true)
  })

  it('/fuck degrades gracefully when no history exists', async () => {
    const { ctx, fs } = await boot()
    await fs.mem.remove('/home/.claude/projects/proj/s1.jsonl')
    await fs.mem.remove('/home/.codex/sessions/2026/01/01/rollout-1.jsonl')
    await ctx.plugin(plugin, { storeDir: '/home/.dsh/of-your-own', roots: { 'claude-code': '/home/.claude/projects' } })
    const commands = ctx.get('commands') as unknown as CommandsStub
    const result = await commands.registry.get('fuck')!.handler({ rawInput: '/fuck' })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('No transcript history found')
  })

  it('my_profile reads the stored profile; refresh re-scans', async () => {
    const { ctx } = await boot()
    await ctx.plugin(plugin, { storeDir: '/home/.dsh/of-your-own', roots })
    const tools = ctx.get('tools') as unknown as ToolsStub
    const commands = ctx.get('commands') as unknown as CommandsStub

    // No profile yet.
    expect(await tools.registry.get('my_profile')!.execute({})).toContain('no profile yet')

    // Build one via /fuck, then read it back.
    await commands.registry.get('fuck')!.handler({ rawInput: '/fuck' })
    const section = await tools.registry.get('my_profile')!.execute({})
    expect(section).toContain('# User Preferences')
    expect(section).toContain('Read×2')

    // Refresh re-scans and re-injects.
    const refreshed = await tools.registry.get('my_profile')!.execute({ refresh: true })
    expect(refreshed).toContain('# User Preferences')
  })

  it('my_commands lists migrated commands after /fuck', async () => {
    const { ctx } = await boot()
    await ctx.plugin(plugin, { storeDir: '/home/.dsh/of-your-own', roots })
    const tools = ctx.get('tools') as unknown as ToolsStub
    const commands = ctx.get('commands') as unknown as CommandsStub

    expect(await tools.registry.get('my_commands')!.execute({})).toContain('no migrated commands')
    await commands.registry.get('fuck')!.handler({ rawInput: '/fuck' })
    expect(await tools.registry.get('my_commands')!.execute({})).toContain('/review')
  })

  it('re-injects a persisted profile at registration (boot-time recall)', async () => {
    const { ctx, fs } = await boot()
    await ctx.plugin(plugin, { storeDir: '/home/.dsh/of-your-own', roots })
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
    await ctx2.plugin(plugin, { storeDir: '/home/.dsh/of-your-own', roots })
    await tick()
    const sp2 = ctx2.get('systemPrompt') as unknown as SystemPromptStub
    expect(sp2.injected.some(e => e.name === 'user-preferences')).toBe(true)
  })

  it('uses the LLM seam for preferences when configured', async () => {
    const { ctx } = await boot()
    await ctx.plugin(LlmStub)
    await ctx.plugin(plugin, { storeDir: '/home/.dsh/of-your-own', roots, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    const commands = ctx.get('commands') as unknown as CommandsStub
    const llm = ctx.get('llm') as unknown as LlmStub

    const result = await commands.registry.get('fuck')!.handler({ rawInput: '/fuck' })
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0]).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    expect(result.text).toContain('偏好中文简洁回复')
  })

  it('disposes cleanly', async () => {
    const { ctx } = await boot()
    const fiber = await ctx.plugin(plugin, { storeDir: '/home/.dsh/of-your-own', roots })
    const commands = ctx.get('commands') as unknown as CommandsStub
    expect(commands.registry.has('fuck')).toBe(true)
    await fiber.dispose()
    expect(commands.registry.has('fuck')).toBe(false)
  })
})
