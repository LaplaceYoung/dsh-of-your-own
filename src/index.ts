/**
 * dsh-of-your-own — make DSH remember the user the other harnesses taught.
 *
 * One slash command, `/fuck`, scans the user's other agents in parallel —
 * Claude Code, Codex, pi/omp transcripts, Claude Code's global history, plus
 * the native memory files (CLAUDE.md, Codex AGENTS.md, GEMINI.md, Cursor
 * rules) — analyzes preferences and tool/command habits, then migrates them
 * **natively**:
 *
 *   1. Writes a managed block into `$DSH_HOME/AGENTS.md` — the file DSH's
 *      workspace-context auto-loads on every session, plugin or not.
 *   2. Persists the full profile to `~/.dsh/of-your-own/profile.json`.
 *   3. Injects the learned preferences into `ctx.systemPrompt.context()`.
 *
 * Re-runs upsert the managed block; user-authored content outside the block
 * is never touched.
 *
 * Seams used (all documented DSH extension points, no skeleton edits):
 *   - `ctx.commands`   — registers `/fuck`
 *   - `ctx.tools`      — `my_profile` / `my_commands` inspection tools
 *   - `ctx.systemPrompt.context()` — learned-preferences section (optional)
 *   - `ctx.llm`        — prose synthesis (optional; template fallback)
 *   - `ctx.fs`         — persistence (optional; node:fs fallback)
 *
 * @module @dsh-external/dsh-of-your-own
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  defaultLimits,
  defaultParsers,
  resolveDefaultRoots,
  scanMemoryFiles,
  scanSources,
  type FsLike as SourcesFs,
  type MemoryFile,
  type ScanLimits,
} from './sources.js'
import {
  analyzeSource,
  buildProfile,
  renderProfileSection,
  renderStatsDigest,
  synthesizePreferences,
  type LlmLike,
  type SourceStats,
  type UserProfile,
} from './analyze.js'
import {
  buildCommandStub,
  loadProfile,
  nodeFsFallback,
  saveProfile,
  writeNativeAgentsMd,
  type FsLike as StoreFs,
  type MigratedCommand,
} from './store.js'

export const name = 'dsh-of-your-own'

/** Services required before this plugin can register. */
export const inject = ['commands', 'tools']

/** Plugin configuration (all knobs are cordis.yml-configurable). */
export interface Config {
  /** Where the profile and migrated commands persist. */
  storeDir?: string
  /** DSH's native user-global instruction file (auto-loaded every session). */
  agentsMdPath?: string
  /** Transcript roots per source id; defaults cover claude/codex/pi/omp. */
  roots?: Record<string, string>
  /** Home dir for memory-file discovery (defaults to homedir()). */
  home?: string
  /** Sources disabled by name (e.g. ['omp']). */
  disabledSources?: string[]
  /** LLM provider/model for preference synthesis; unset = deterministic fallback. */
  provider?: string
  model?: string
  /** Scan limits. */
  maxFilesPerSource?: number
  maxBytesPerFile?: number
  maxPrompts?: number
  /** Per-memory-file content cap. */
  maxMemoryChars?: number
  /** Order of the learned-preferences section in the system prompt. */
  sectionOrder?: number
}

/** Structural mirror of the DSH command service. */
export interface CommandsService {
  register(def: {
    name: string
    description: string
    handler: (invocation: { rawInput: string }) => Promise<{ kind: string; text: string }>
  }): () => void
}

/** Structural mirror of the DSH tools registration contract. */
export interface ToolsService {
  register(def: { name: string } & Record<string, unknown>): () => void
}

/** Structural mirror of the DSH system-prompt context seam. */
export interface SystemPromptLike {
  context?(entry: { name: string; order: number; text: string }): () => void
}

/** Combined fs contract: sources and store use the same seam shape. */
export type FS = SourcesFs & StoreFs

/** Full run result, exposed for tests and `/fuck` reporting. */
export interface MigrationResult {
  profile: UserProfile
  profilePath: string
  commandPaths: string[]
  agentsMdPath: string
  memoryFiles: MemoryFile[]
  stats: SourceStats[]
}

/**
 * Run one full migration: parallel transcript + memory-file scan → stats →
 * optional LLM prose → native AGENTS.md block + persisted profile + command
 * stubs. Pure orchestration over the seams.
 */
export async function runMigration(
  fs: FS,
  options: {
    roots: Record<string, string>
    limits: ScanLimits
    provider?: string
    model?: string
    storeDir: string
    agentsMdPath: string
    home: string
    maxMemoryChars?: number
    llm?: LlmLike
  },
): Promise<MigrationResult> {
  // Parallel: transcript sources + native memory files.
  const [evidence, memoryFiles] = await Promise.all([
    scanSources(fs as unknown as SourcesFs, options.roots, defaultParsers, options.limits),
    scanMemoryFiles(fs as unknown as SourcesFs, options.home, options.maxMemoryChars ?? 8192),
  ])
  const stats = evidence.map(e => analyzeSource(e))
  const digest = renderStatsDigest(stats, memoryFiles)
  const zh = stats.filter(s => s.language === 'zh').reduce((n, s) => n + s.promptCount, 0)
  const total = Math.max(1, stats.reduce((n, s) => n + s.promptCount, 0))
  const language = zh * 2 > total ? 'zh' : 'en'
  let preferences = ''
  if (options.llm && (stats.length > 0 || memoryFiles.length > 0)) {
    try {
      preferences = await synthesizePreferences(options.llm, digest, language, {
        provider: options.provider,
        model: options.model,
      })
    } catch {
      preferences = '' // fall back to the deterministic template
    }
  }
  const profile = buildProfile(stats, preferences, memoryFiles)

  // Migrate observed slash commands as stub artifacts (top 20, deduped).
  const seen = new Set<string>()
  const commands: MigratedCommand[] = []
  for (const s of stats) {
    for (const c of s.topSlashCommands) {
      if (seen.has(c.name) || commands.length >= 20) continue
      seen.add(c.name)
      commands.push({ name: c.name, source: s.source, observed: c.count, body: buildCommandStub(c.name, s.source, c.count) })
    }
  }
  const { profilePath, commandPaths } = await saveProfile(fs as unknown as StoreFs, options.storeDir, profile, commands)

  // The native landing zone: DSH auto-loads $DSH_HOME/AGENTS.md every
  // session, so the user's preferences survive even without this plugin.
  const agentsMdPath = await writeNativeAgentsMd(fs as unknown as StoreFs, options.agentsMdPath, renderProfileSection(profile))

  return { profile, profilePath, commandPaths, agentsMdPath, memoryFiles, stats }
}

/** Render the `/fuck` outcome as user-facing text. */
export function renderMigrationReport(result: MigrationResult, language: 'zh' | 'en'): string {
  const { profile } = result
  const lines: string[] = []
  const sourcesLine = profile.sources.map(s => `${s.source}(${s.filesScanned} 个会话)`).join('、')
  const msgCount = profile.sources.reduce((n, s) => n + s.promptCount, 0)
  if (language === 'zh') {
    lines.push('## 迁移完成', '')
    lines.push(`扫描了 ${sourcesLine}，共 ${msgCount} 条用户消息。`)
    if (result.memoryFiles.length) {
      lines.push(`读取了 ${result.memoryFiles.length} 份原生记忆文件：${result.memoryFiles.map(m => `${m.source}/${m.name}`).join('、')}`)
    }
    lines.push('')
    lines.push('**学到的偏好**', '', profile.preferences, '')
    if (profile.toolHabits.length) lines.push(`工具习惯: ${profile.toolHabits.slice(0, 8).map(t => `${t.name}×${t.count}`).join(', ')}`)
    if (profile.migratedCommands.length) lines.push(`已迁移命令: ${profile.migratedCommands.join(', ')}`)
    lines.push('', `档案: ${result.profilePath}`, `原生注入: ${result.agentsMdPath}（DSH 每次会话自动加载）`, '之后的每次会话都会记得你。')
  } else {
    lines.push('## Migration complete', '')
    lines.push(`Scanned ${profile.sources.map(s => `${s.source} (${s.filesScanned} sessions)`).join(', ')} — ${msgCount} user messages.`)
    if (result.memoryFiles.length) {
      lines.push(`Read ${result.memoryFiles.length} native memory file(s): ${result.memoryFiles.map(m => `${m.source}/${m.name}`).join(', ')}`)
    }
    lines.push('')
    lines.push('**Learned preferences**', '', profile.preferences, '')
    if (profile.toolHabits.length) lines.push(`Tool habits: ${profile.toolHabits.slice(0, 8).map(t => `${t.name}×${t.count}`).join(', ')}`)
    if (profile.migratedCommands.length) lines.push(`Migrated commands: ${profile.migratedCommands.join(', ')}`)
    lines.push('', `Profile: ${result.profilePath}`, `Native: ${result.agentsMdPath} (DSH auto-loads this every session)`, 'Future sessions will remember you.')
  }
  return lines.join('\n')
}

export function apply(ctx: Context, config: Config = {}) {
  ctx.effect(() => {
    const commands = ctx.get('commands') as CommandsService
    const tools = ctx.get('tools') as ToolsService
    const systemPrompt = ctx.get('systemPrompt') as SystemPromptLike | undefined
    const home = config.home ?? homedir()
    const dshHome = process.env.DSH_HOME ?? join(home, '.dsh')
    const storeDir = config.storeDir ?? join(dshHome, 'of-your-own')
    const agentsMdPath = config.agentsMdPath ?? join(dshHome, 'AGENTS.md')
    const limits: ScanLimits = {
      maxFilesPerSource: config.maxFilesPerSource ?? defaultLimits.maxFilesPerSource,
      maxBytesPerFile: config.maxBytesPerFile ?? defaultLimits.maxBytesPerFile,
      maxPrompts: config.maxPrompts ?? defaultLimits.maxPrompts,
    }
    const roots = config.roots ?? resolveDefaultRoots(home)
    const enabled: Record<string, string> = {}
    for (const [id, root] of Object.entries(roots)) {
      if (!(config.disabledSources ?? []).includes(id)) enabled[id] = root
    }
    const disposers: (() => void)[] = []
    const fs = (): FS => ((ctx.get('fs') as FS | undefined) ?? nodeFsFallback() as FS)

    // --- remember on demand: inject the profile into the prompt ------------
    let injectProfile = (profile: UserProfile): void => {
      void profile
    }
    if (systemPrompt && typeof systemPrompt.context === 'function') {
      injectProfile = (profile) => {
        disposers.push(systemPrompt.context!({
          name: 'user-preferences',
          order: config.sectionOrder ?? 10,
          text: renderProfileSection(profile),
        }))
      }
    }

    // --- one in-flight migration at a time ---------------------------------
    let running: Promise<MigrationResult> | undefined

    const run = (): Promise<MigrationResult> => {
      running ??= runMigration(fs(), {
        roots: enabled,
        limits,
        provider: config.provider,
        model: config.model,
        storeDir,
        agentsMdPath,
        home,
        maxMemoryChars: config.maxMemoryChars,
        llm: ctx.get('llm') as LlmLike | undefined,
      }).finally(() => { running = undefined })
      return running
    }

    disposers.push(commands.register({
      name: 'fuck',
      description: 'Read your Claude Code, Codex, pi/omp history and native memory files in parallel, analyze your habits, and migrate them natively into DSH so it remembers you.',
      handler: async () => {
        try {
          const result = await run()
          if (result.profile.sources.length === 0 && result.memoryFiles.length === 0) {
            return { kind: 'success', text: `No transcript history or memory files found under ${Object.values(enabled).join(', ')} or ${home}. Run other agents first, then retry.` }
          }
          injectProfile(result.profile)
          return { kind: 'success', text: renderMigrationReport(result, result.profile.language) }
        } catch (err) {
          return { kind: 'error', text: `Migration failed: ${err instanceof Error ? err.message : String(err)}` }
        }
      },
    }))

    disposers.push(tools.register({
      name: 'my_profile',
      description: 'Show (or refresh with { refresh: true }) the user preference profile learned from other agent histories.',
      parameters: {
        type: 'object',
        properties: { refresh: { type: 'boolean', description: 'Re-scan transcripts and rebuild the profile.' } },
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
      },
      async execute(args: unknown) {
        const { refresh } = (args ?? {}) as { refresh?: boolean }
        if (refresh) {
          const result = await run()
          injectProfile(result.profile)
          return renderProfileSection(result.profile)
        }
        const stored = await loadProfile(fs() as StoreFs, storeDir)
        return stored ? renderProfileSection(stored) : '(no profile yet — run /fuck to build one)'
      },
    }))

    disposers.push(tools.register({
      name: 'my_commands',
      description: 'List slash commands migrated from other agent histories (with observation counts).',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
      },
      async execute() {
        const stored = await loadProfile(fs() as StoreFs, storeDir)
        if (!stored || stored.migratedCommands.length === 0) return '(no migrated commands yet — run /fuck)'
        return stored.migratedCommands.join('\n')
      },
    }))

    // --- boot-time recall: load a previously saved profile now -------------
    let recalled = false
    void loadProfile(fs() as StoreFs, storeDir).then((stored) => {
      if (stored && !recalled) {
        recalled = true
        injectProfile(stored)
      }
    }).catch(() => { /* no profile yet */ })

    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  })
}
