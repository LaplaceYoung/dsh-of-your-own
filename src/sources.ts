/**
 * Transcript source adapters — where the user's other agents keep their logs.
 *
 * Two adapters ship: Claude Code (`~/.claude/projects/<cwd>/<session>.jsonl`)
 * and Codex (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`). Each adapter is
 * schema-tolerant: unknown line shapes are skipped, never fatal. All parsing
 * functions are pure so unit tests feed them fixture lines directly.
 *
 * @module dsh-of-your-own/sources
 */

import { join } from 'node:path'

/** Minimal fs seam with a node:fs fallback (see store.nodeFsFallback). */
export interface FsLike {
  readText(path: string): Promise<string>
  writeText(path: string, content: string): Promise<void>
  listDir(path: string): Promise<{ name: string; isDirectory: boolean; mtimeMs?: number }[]>
  exists(path: string): Promise<boolean>
  remove(path: string): Promise<void>
}

/** Raw behavioral evidence extracted from one harness's transcripts. */
export interface SourceEvidence {
  /** Adapter id: 'claude-code' | 'codex' | custom. */
  source: string
  /** User prompts, oldest first (bounded by maxPrompts). */
  prompts: string[]
  /** Tool invocations, one entry per call (order preserved). */
  toolCalls: string[]
  /** Slash commands the user typed in that harness, one entry per use. */
  slashCommands: string[]
  /** Working directories the sessions ran in, one entry per session. */
  cwds: string[]
  /** Number of transcript files actually scanned. */
  filesScanned: number
}

/** Per-source scan limits (all cordis.yml-configurable upstream). */
export interface ScanLimits {
  /** Newest-first transcript files to scan per source. */
  maxFilesPerSource: number
  /** Per-file byte cap; content beyond it is ignored. */
  maxBytesPerFile: number
  /** Total prompts kept per source. */
  maxPrompts: number
}

export const defaultLimits: ScanLimits = {
  maxFilesPerSource: 50,
  maxBytesPerFile: 512 * 1024,
  maxPrompts: 500,
}

/** Resolve the default transcript roots for a home directory. */
export function resolveDefaultRoots(home: string): Record<string, string> {
  return {
    'claude-code': join(home, '.claude', 'projects'),
    codex: join(home, '.codex', 'sessions'),
  }
}

/**
 * Extract slash-command tokens from a prompt. Only a first token of the
 * shape `/name` (letters, digits, `_`, `-`; no further `/`) counts — this
 * rejects absolute paths like `/Users/x` and prose mentioning commands.
 */
export function extractSlashCommand(prompt: string): string | undefined {
  const first = prompt.split(/\s/, 1)[0]
  if (!first || !first.startsWith('/')) return undefined
  const m = /^\/([A-Za-z][A-Za-z0-9_-]{0,31})$/.exec(first)
  return m ? `/${m[1]}` : undefined
}

/** Detect whether a prompt is predominantly CJK (zh/ja/ko) or latin. */
export function detectLanguage(prompt: string): 'zh' | 'en' {
  const cjk = (prompt.match(/[\u3000-\u303f\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/g) ?? []).length
  const latin = (prompt.match(/[A-Za-z]/g) ?? []).length
  return cjk > latin ? 'zh' : 'en'
}

/** Evidence parsed from one Claude Code JSONL line (pure). */
export function parseClaudeLine(line: string): { prompts: string[]; tools: string[]; cwd?: string } {
  let entry: Record<string, unknown>
  try {
    entry = JSON.parse(line) as Record<string, unknown>
  } catch {
    return { prompts: [], tools: [] }
  }
  const out = { prompts: [] as string[], tools: [] as string[], cwd: undefined as string | undefined }
  if (typeof entry.cwd === 'string') out.cwd = entry.cwd

  if (entry.type === 'user') {
    const msg = entry.message as { role?: string; content?: unknown } | undefined
    if (msg?.role === 'user' && typeof msg.content === 'string' && msg.content.trim()) {
      out.prompts.push(msg.content)
    }
  } else if (entry.type === 'assistant') {
    const msg = entry.message as { content?: unknown } | undefined
    const content = msg?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as { type?: string; name?: string }
        if (b?.type === 'tool_use' && typeof b.name === 'string') out.tools.push(b.name)
      }
    }
  }
  return out
}

/** Evidence parsed from one Codex rollout JSONL line (pure). */
export function parseCodexLine(line: string): { prompts: string[]; tools: string[]; cwd?: string } {
  let entry: Record<string, unknown>
  try {
    entry = JSON.parse(line) as Record<string, unknown>
  } catch {
    return { prompts: [], tools: [] }
  }
  const out = { prompts: [] as string[], tools: [] as string[], cwd: undefined as string | undefined }
  const payload = entry.payload as Record<string, unknown> | undefined

  if (entry.type === 'session_meta' && payload && typeof payload.cwd === 'string') {
    out.cwd = payload.cwd
  }

  if (entry.type === 'response_item' && payload) {
    const ptype = payload.type
    if (ptype === 'function_call' && typeof payload.name === 'string') {
      out.tools.push(payload.name)
    } else if (ptype === 'local_shell_call') {
      out.tools.push('shell')
    } else if (ptype === 'message' && payload.role === 'user') {
      const content = payload.content
      if (Array.isArray(content)) {
        for (const item of content) {
          const c = item as { type?: string; text?: string }
          if (c?.type === 'input_text' && typeof c.text === 'string' && c.text.trim()) {
            out.prompts.push(c.text)
          }
        }
      } else if (typeof content === 'string' && content.trim()) {
        out.prompts.push(content)
      }
    }
  }

  // event_msg user messages (older / desktop variants)
  if (entry.type === 'event_msg' && payload?.type === 'user_message' && typeof payload.message === 'string') {
    const text = payload.message.trim()
    if (text) out.prompts.push(text)
  }
  return out
}

/** Recursively collect `.jsonl` files under a root (newest-mtime first). */
export async function collectTranscriptFiles(fs: FsLike, root: string): Promise<string[]> {
  const found: { path: string; mtimeMs: number }[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries: { name: string; isDirectory: boolean; mtimeMs?: number }[]
    try {
      entries = await fs.listDir(dir)
    } catch {
      return
    }
    await Promise.all(entries.map(async (e) => {
      const p = join(dir, e.name)
      if (e.isDirectory) return walk(p)
      if (e.name.endsWith('.jsonl')) found.push({ path: p, mtimeMs: e.mtimeMs ?? 0 })
    }))
  }
  await walk(root)
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return found.map(f => f.path)
}

/** Scan one transcript file into evidence (pure over its parser). */
async function scanFile(
  fs: FsLike,
  path: string,
  parse: (line: string) => { prompts: string[]; tools: string[]; cwd?: string },
  limits: ScanLimits,
): Promise<{ prompts: string[]; tools: string[]; slash: string[]; cwd?: string }> {
  let text: string
  try {
    text = await fs.readText(path)
  } catch {
    return { prompts: [], tools: [], slash: [] }
  }
  if (text.length > limits.maxBytesPerFile) text = text.slice(0, limits.maxBytesPerFile)
  const prompts: string[] = []
  const tools: string[] = []
  const slash: string[] = []
  let cwd: string | undefined
  for (const line of text.split('\n')) {
    if (!line) continue
    const parsed = parse(line)
    if (parsed.cwd && !cwd) cwd = parsed.cwd
    for (const t of parsed.tools) tools.push(t)
    for (const p of parsed.prompts) {
      if (prompts.length < limits.maxPrompts) prompts.push(p)
      const cmd = extractSlashCommand(p)
      if (cmd) slash.push(cmd)
    }
  }
  return { prompts, tools, slash, cwd }
}

/**
 * Scan all configured sources. Sources run in parallel (Promise.all), and
 * each source reads its transcript files in parallel — the "并行去读"
 * contract the plugin is named for.
 */
export async function scanSources(
  fs: FsLike,
  roots: Record<string, string>,
  parsers: Record<string, (line: string) => { prompts: string[]; tools: string[]; cwd?: string }>,
  limits: ScanLimits = defaultLimits,
): Promise<SourceEvidence[]> {
  const names = Object.keys(roots).filter(n => parsers[n])
  const results = await Promise.all(names.map(async (source): Promise<SourceEvidence> => {
    const files = (await collectTranscriptFiles(fs, roots[source])).slice(0, limits.maxFilesPerSource)
    const perFile = await Promise.all(files.map(f => scanFile(fs, f, parsers[source], limits)))
    const evidence: SourceEvidence = {
      source,
      prompts: [],
      toolCalls: [],
      slashCommands: [],
      cwds: [],
      filesScanned: files.length,
    }
    for (const r of perFile) {
      if (r.cwd) evidence.cwds.push(r.cwd)
      evidence.toolCalls.push(...r.tools)
      evidence.slashCommands.push(...r.slash)
      evidence.prompts.push(...r.prompts)
    }
    evidence.prompts = evidence.prompts.slice(0, limits.maxPrompts)
    return evidence
  }))
  return results.filter(e => e.filesScanned > 0 || e.prompts.length > 0 || e.toolCalls.length > 0)
}

/** The shipped parser table: adapter id → line parser. */
export const defaultParsers: Record<string, (line: string) => { prompts: string[]; tools: string[]; cwd?: string }> = {
  'claude-code': parseClaudeLine,
  codex: parseCodexLine,
}
