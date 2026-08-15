/**
 * Analysis — turn transcript evidence into a user profile.
 *
 * Two layers: a deterministic frequency/statistics layer (always runs, never
 * needs a key) and an optional LLM synthesis layer (`ctx.llm`) that writes
 * the prose preference summary. The profile is the persisted artifact —
 * plain JSON, readable by humans and grep-able by other plugins.
 *
 * @module dsh-of-your-own/analyze
 */

import type { MemoryFile, SourceEvidence } from './sources.js'
/** One frequency entry. */
export interface FreqEntry {
  name: string
  count: number
}

/** Count occurrences, most-frequent first (stable by name on ties). */
export function frequency(items: readonly string[]): FreqEntry[] {
  const counts = new Map<string, number>()
  for (const item of items) {
    if (!item) continue
    counts.set(item, (counts.get(item) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/** Dominant language across the sampled prompts (per-prompt majority vote). */
export function dominantLanguage(samples: readonly { language: 'zh' | 'en' }[]): 'zh' | 'en' {
  const zh = samples.filter(s => s.language === 'zh').length
  return zh * 2 > samples.length ? 'zh' : 'en'
}

/**
 * Dominant language across a set of prompts, counted globally over all
 * characters. Leading `/slash-command` tokens are excluded so command
 * names (`/review`) never skew the verdict toward English.
 */
export function dominantLanguageOfPrompts(prompts: readonly string[]): 'zh' | 'en' {
  let cjk = 0
  let latin = 0
  for (const p of prompts) {
    const text = p.replace(/^\/[A-Za-z][A-Za-z0-9_-]*\s+/, '')
    cjk += (text.match(/[\u3000-\u303f\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/g) ?? []).length
    latin += (text.match(/[A-Za-z]/g) ?? []).length
  }
  return cjk > latin ? 'zh' : 'en'
}

/** Per-source deterministic statistics. */
export interface SourceStats {
  source: string
  filesScanned: number
  promptCount: number
  topTools: FreqEntry[]
  topSlashCommands: FreqEntry[]
  topCwds: FreqEntry[]
  language: 'zh' | 'en'
  /** Shortest-first prompt samples (bounded) for the LLM to read. */
  samples: string[]
}

export interface AnalyzeOptions {
  /** Frequency entries kept per category. */
  topN?: number
  /** Prompt samples kept per source (shortest first — cheap tokens). */
  maxSamplesPerSource?: number
  /** Max chars per sample. */
  maxSampleChars?: number
}

/** Compute deterministic statistics for one source (pure). */
export function analyzeSource(evidence: SourceEvidence, opts: AnalyzeOptions = {}): SourceStats {
  const topN = opts.topN ?? 15
  const maxSamples = opts.maxSamplesPerSource ?? 8
  const maxChars = opts.maxSampleChars ?? 240
  const samples = evidence.prompts
    .filter(p => p.trim().length > 0)
    .map(p => p.trim())
    .sort((a, b) => a.length - b.length)
    .slice(0, maxSamples)
    .map(p => (p.length > maxChars ? `${p.slice(0, maxChars)}…` : p))
  return {
    source: evidence.source,
    filesScanned: evidence.filesScanned,
    promptCount: evidence.prompts.length,
    topTools: frequency(evidence.toolCalls.map(t => t.toLowerCase())).slice(0, topN),
    topSlashCommands: frequency(evidence.slashCommands).slice(0, topN),
    topCwds: frequency(evidence.cwds).slice(0, 5),
    language: dominantLanguageOfPrompts(evidence.prompts),
    samples,
  }
}

/** The persisted user profile. */
export interface UserProfile {
  version: 1
  generatedAt: string
  /** Sources scanned and how many transcript files each contributed. */
  sources: { source: string; filesScanned: number; promptCount: number }[]
  /** Aggregated tool habits across all sources. */
  toolHabits: FreqEntry[]
  /** Aggregated slash-command habits across all sources. */
  slashHabits: FreqEntry[]
  /** Dominant prompt language. */
  language: 'zh' | 'en'
  /** Prose preference summary (LLM-synthesized or template fallback). */
  preferences: string
  /** Commands the user actually used elsewhere — candidates for migration. */
  migratedCommands: string[]
  /** Native memory files found in other harness homes (source + name). */
  memoryFiles: { source: string; name: string }[]
  /** Tool calls aggregated into canonical families (shell/read/edit/…). */
  toolFamilies: FreqEntry[]
  /** Top working directories across all sources. */
  topProjects: FreqEntry[]
}

/**
 * Canonical tool families. Harnesses name the same capability differently
 * (`Bash` vs `exec_command` vs `shell`); the family table merges them so
 * the profile speaks one language.
 */
export const TOOL_FAMILIES: Record<string, string> = {
  // shell
  bash: 'shell', exec_command: 'shell', shell: 'shell', run_command: 'shell',
  write_stdin: 'shell', powershell: 'shell', terminal: 'shell',
  // read
  read: 'read', view: 'read', cat: 'read', file_read: 'read', view_image: 'read',
  // search
  grep: 'search', search: 'search', glob: 'search', find: 'search', rg: 'search',
  ast_grep: 'search', grep_app: 'search',
  // edit
  edit: 'edit', write: 'edit', apply_patch: 'edit', patch: 'edit', str_replace: 'edit',
  file_edit: 'edit', file_write: 'edit', apply_diff: 'edit',
  // web
  webfetch: 'web', websearch: 'web', fetch: 'web', browser: 'web',
  web_search: 'web', web_fetch: 'web',
  // agent
  agent: 'agent', task: 'agent', spawn: 'agent', subagent: 'agent',
  // plan
  todo: 'plan', todowrite: 'plan', todoread: 'plan', update_plan: 'plan', plan: 'plan',
}

/** Merge tool habits into family counts, most-used family first. */
export function classifyToolFamilies(toolHabits: readonly FreqEntry[]): FreqEntry[] {
  const counts = new Map<string, number>()
  for (const t of toolHabits) {
    const family = TOOL_FAMILIES[t.name] ?? 'other'
    counts.set(family, (counts.get(family) ?? 0) + t.count)
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/** Render a deterministic digest of the stats (no LLM needed). */
export function renderStatsDigest(stats: readonly SourceStats[], memoryFiles: readonly MemoryFile[] = []): string {
  const lines: string[] = []
  for (const s of stats) {
    lines.push(`## ${s.source} (${s.filesScanned} files, ${s.promptCount} prompts, lang=${s.language})`)
    if (s.topTools.length) {
      lines.push(`tools: ${s.topTools.map(t => `${t.name}×${t.count}`).join(', ')}`)
    }
    if (s.topSlashCommands.length) {
      lines.push(`slash: ${s.topSlashCommands.map(c => `${c.name}×${c.count}`).join(', ')}`)
    }
    if (s.samples.length) {
      lines.push('samples:', ...s.samples.map(p => `  - ${p}`))
    }
    lines.push('')
  }
  if (memoryFiles.length) {
    lines.push('## native memory files', '')
    for (const m of memoryFiles) {
      lines.push(`### ${m.source}/${m.name}`, '', m.content, '')
    }
  }
  return lines.join('\n')
}

/** Template fallback when no LLM is configured — still a usable profile. */
export function buildPreferenceFallback(stats: readonly SourceStats[]): string {
  const parts: string[] = []
  for (const s of stats) {
    const tools = s.topTools.slice(0, 5).map(t => t.name).join(', ')
    const cmds = s.topSlashCommands.slice(0, 5).map(c => c.name).join(', ')
    parts.push(
      s.language === 'zh'
        ? `在 ${s.source} 中：偏好工具 ${tools || '(无记录)'}；常用命令 ${cmds || '(无记录)'}；回复请保持中文、简洁直接。`
        : `In ${s.source}: favors ${tools || '(none recorded)'}; frequently uses ${cmds || '(no commands)'}; keep replies concise.`,
    )
  }
  return parts.join('\n')
}

/** Structural mirror of the DSH llm streaming seam. */
export interface LlmLike {
  stream?(options: {
    provider?: string
    model?: string
    system?: string
    messages?: unknown[]
    signal?: unknown
  }): AsyncIterable<{ type?: string; delta?: string }>
}

/** Collect `text-delta`-style chunks into a single string. */
export async function collectText(chunks: AsyncIterable<{ type?: string; delta?: string }>): Promise<string> {
  let text = ''
  for await (const chunk of chunks) {
    if (chunk.type === 'text-delta' || chunk.type === undefined) text += chunk.delta ?? ''
  }
  return text
}

/** Ask the LLM to synthesize a prose preference summary from the digest. */
export async function synthesizePreferences(
  llm: LlmLike,
  digest: string,
  language: 'zh' | 'en',
  config: { provider?: string; model?: string },
): Promise<string> {
  const chunks = llm.stream?.({
    provider: config.provider,
    model: config.model,
    system: language === 'zh'
      ? '你是用户行为分析器。根据用户与其他 AI 编程助手的真实对话统计，总结该用户的偏好与习惯：语言与语气、常用工具、工作流、命令习惯。输出 3-8 条要点，每条一行，不要复述统计数据。'
      : 'You analyze developer behavior. From the statistics of a user\'s conversations with other AI coding agents, summarize their preferences and habits: language and tone, favorite tools, workflows, command habits. Output 3-8 bullet lines, no restating raw stats.',
    messages: [{ role: 'user', content: digest }],
  })
  if (!chunks) return ''
  return (await collectText(chunks)).trim()
}

/** Assemble the final persisted profile from stats (+ optional LLM prose). */
export function buildProfile(
  stats: readonly SourceStats[],
  preferences: string,
  memoryFiles: readonly MemoryFile[] = [],
  generatedAt: string = new Date().toISOString(),
): UserProfile {
  const toolHabits = frequency(stats.flatMap(s => s.topTools.flatMap(t => Array(t.count).fill(t.name) as string[])))
  const slashHabits = frequency(stats.flatMap(s => s.topSlashCommands.flatMap(c => Array(c.count).fill(c.name) as string[])))
  const topProjects = frequency(stats.flatMap(s => s.topCwds.flatMap(c => Array(c.count).fill(c.name) as string[]))).slice(0, 5)
  const zhVotes = stats.filter(s => s.language === 'zh').reduce((n, s) => n + s.promptCount, 0)
  const total = Math.max(1, stats.reduce((n, s) => n + s.promptCount, 0))
  return {
    version: 1,
    generatedAt,
    sources: stats.map(s => ({ source: s.source, filesScanned: s.filesScanned, promptCount: s.promptCount })),
    toolHabits,
    slashHabits,
    language: zhVotes * 2 > total ? 'zh' : 'en',
    preferences: preferences || buildPreferenceFallback(stats),
    migratedCommands: slashHabits.map(s => s.name),
    memoryFiles: memoryFiles.map(m => ({ source: m.source, name: m.name })),
    toolFamilies: classifyToolFamilies(toolHabits),
    topProjects,
  }
}

/** Render a profile as a system-prompt section body (markdown). */
export function renderProfileSection(profile: UserProfile): string {
  const lines: string[] = [
    '# User Preferences (learned from prior agent history)',
    '',
    profile.preferences,
    '',
  ]
  if (profile.toolHabits.length) {
    lines.push(`Tool habits: ${profile.toolHabits.slice(0, 10).map(t => `${t.name}×${t.count}`).join(', ')}`)
  }
  if (profile.slashHabits.length) {
    lines.push(`Command habits: ${profile.slashHabits.slice(0, 10).map(c => `${c.name}×${c.count}`).join(', ')}`)
  }
  lines.push(`Reply language: ${profile.language === 'zh' ? 'Chinese (中文)' : 'English'}`)
  return lines.join('\n')
}
