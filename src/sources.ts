/**
 * Source adapters — where the user's other agents keep their stuff.
 *
 * Two kinds of evidence:
 *
 *   1. Transcripts (behavior): Claude Code, Codex, pi/omp session JSONLs,
 *      plus Claude Code's global history.jsonl (slash-command gold mine).
 *   2. Native memory files (explicit preferences): CLAUDE.md, Codex
 *      AGENTS.md, GEMINI.md, Cursor `.mdc` rules and agent markdown.
 *
 * Every parser is schema-tolerant: unknown line shapes are skipped, never
 * fatal. All parsing functions are pure so unit tests feed them fixtures.
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

/** A native memory file found in another harness's home. */
export interface MemoryFile {
  /** Which harness owns it: 'claude-code' | 'codex' | 'gemini-cli' | 'cursor'. */
  source: string
  /** Human-readable name: 'CLAUDE.md', 'rules/cursor.mdc', … */
  name: string
  /** Absolute path it was read from. */
  path: string
  /** Full content (bounded by scanMemoryFiles). */
  content: string
}

/** Raw behavioral evidence extracted from one harness's transcripts. */
export interface SourceEvidence {
  /** Adapter id: 'claude-code' | 'codex' | 'pi' | 'omp' | 'claude-history'. */
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

/**
 * Resolve the default transcript roots for a home directory. Only
 * transcript-producing sources appear here; memory-file sources are
 * discovered separately by scanMemoryFiles.
 */
export function resolveDefaultRoots(home: string): Record<string, string> {
  return {
    'claude-code': join(home, '.claude', 'projects'),
    codex: join(home, '.codex', 'sessions'),
    pi: join(home, '.pi', 'agent', 'sessions'),
    omp: join(home, '.omp', 'agent', 'sessions'),
    'claude-history': join(home, '.claude', 'history.jsonl'),
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

/**
 * Evidence parsed from one pi/omp session JSONL line (pure). pi and omp
 * share the same engine and format: `{"type":"session",cwd}`,
 * `{"type":"message","message":{"role":"user","content":[{"type":"text"}]}}`,
 * assistant `toolCall` blocks.
 */
export function parsePiLine(line: string): { prompts: string[]; tools: string[]; cwd?: string } {
  let entry: Record<string, unknown>
  try {
    entry = JSON.parse(line) as Record<string, unknown>
  } catch {
    return { prompts: [], tools: [] }
  }
  const out = { prompts: [] as string[], tools: [] as string[], cwd: undefined as string | undefined }

  if (entry.type === 'session' && typeof entry.cwd === 'string') {
    out.cwd = entry.cwd
  }

  if (entry.type === 'message') {
    const msg = entry.message as { role?: string; content?: unknown } | undefined
    if (!msg) return out
    const content = msg.content
    const items = Array.isArray(content)
      ? content
      : typeof content === 'string'
        ? [{ type: 'text', text: content }]
        : []
    if (msg.role === 'user') {
      for (const item of items) {
        const c = item as { type?: string; text?: string }
        if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
          out.prompts.push(c.text)
        }
      }
    } else if (msg.role === 'assistant') {
      for (const item of items) {
        const c = item as { type?: string; name?: string }
        if (c?.type === 'toolCall' && typeof c.name === 'string') out.tools.push(c.name)
      }
    }
  }
  return out
}

/**
 * Evidence parsed from one Claude Code history.jsonl line (pure). This is
 * the global prompt log: `{"display": "/model", "project": "/path"}`.
 */
export function parseClaudeHistoryLine(line: string): { prompts: string[]; tools: string[]; cwd?: string } {
  let entry: Record<string, unknown>
  try {
    entry = JSON.parse(line) as Record<string, unknown>
  } catch {
    return { prompts: [], tools: [] }
  }
  const out = { prompts: [] as string[], tools: [] as string[], cwd: undefined as string | undefined }
  if (typeof entry.project === 'string') out.cwd = entry.project
  if (typeof entry.display === 'string' && entry.display.trim()) out.prompts.push(entry.display)
  return out
}

/** The shipped parser table: adapter id → line parser. */
export const defaultParsers: Record<string, (line: string) => { prompts: string[]; tools: string[]; cwd?: string }> = {
  'claude-code': parseClaudeLine,
  codex: parseCodexLine,
  pi: parsePiLine,
  omp: parsePiLine,
  'claude-history': parseClaudeHistoryLine,
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
 * Scan all configured transcript sources in parallel — across sources and
 * across files within each source. A root that resolves to a single file
 * (claude-history) is scanned directly instead of walked.
 */
export async function scanSources(
  fs: FsLike,
  roots: Record<string, string>,
  parsers: Record<string, (line: string) => { prompts: string[]; tools: string[]; cwd?: string }>,
  limits: ScanLimits = defaultLimits,
): Promise<SourceEvidence[]> {
  const names = Object.keys(roots).filter(n => parsers[n])
  const results = await Promise.all(names.map(async (source): Promise<SourceEvidence> => {
    const root = roots[source]
    const isFile = root.endsWith('.jsonl')
    const files = isFile
      ? (await fs.exists(root) ? [root] : [])
      : (await collectTranscriptFiles(fs, root)).slice(0, limits.maxFilesPerSource)
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

/** Strip markdown/frontmatter fences a rule file wraps its body in. */
export function cleanMemoryContent(content: string): string {
  let text = content.trim()
  // Cursor .mdc frontmatter
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3)
    if (end > 0) text = text.slice(end + 4).trim()
  }
  return text
}

/** One well-known memory file location. */
export interface MemoryLocation {
  source: string
  path: string
  name: string
}

/** The shipped memory-file discovery table (home → locations). */
export function resolveMemoryLocations(home: string): MemoryLocation[] {
  return [
    { source: 'claude-code', path: join(home, '.claude', 'CLAUDE.md'), name: 'CLAUDE.md' },
    { source: 'codex', path: join(home, '.codex', 'AGENTS.md'), name: 'AGENTS.md' },
    { source: 'gemini-cli', path: join(home, '.gemini', 'GEMINI.md'), name: 'GEMINI.md' },
  ]
}

/**
 * Discover native memory files: the per-harness instruction files plus
 * Cursor's global `.mdc` rules and agent markdown. Each content is bounded
 * by maxMemoryChars. Missing files are silently skipped.
 */
export async function scanMemoryFiles(
  fs: FsLike,
  home: string,
  maxMemoryChars = 8192,
): Promise<MemoryFile[]> {
  const found: MemoryFile[] = []
  const candidates: MemoryLocation[] = [...resolveMemoryLocations(home)]

  // Cursor global rules + agents (directory-based, optional)
  const cursorDirs: { dir: string; source: string; prefix: string; ext: string }[] = [
    { dir: join(home, '.cursor', 'rules'), source: 'cursor', prefix: 'rules/', ext: '.mdc' },
    { dir: join(home, '.cursor', 'agents'), source: 'cursor', prefix: 'agents/', ext: '.md' },
  ]
  for (const { dir, source, prefix, ext } of cursorDirs) {
    let entries: { name: string; isDirectory: boolean }[] = []
    try {
      entries = await fs.listDir(dir)
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isDirectory || !e.name.endsWith(ext)) continue
      candidates.push({ source, path: join(dir, e.name), name: `${prefix}${e.name}` })
    }
  }

  await Promise.all(candidates.map(async (loc) => {
    try {
      if (!(await fs.exists(loc.path))) return
      let content = await fs.readText(loc.path)
      if (content.length > maxMemoryChars) content = `${content.slice(0, maxMemoryChars)}…`
      const cleaned = cleanMemoryContent(content)
      if (cleaned) found.push({ source: loc.source, name: loc.name, path: loc.path, content: cleaned })
    } catch { /* unreadable → skip */ }
  }))
  return found.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name))
}
