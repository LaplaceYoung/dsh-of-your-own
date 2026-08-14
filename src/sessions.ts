/**
 * Session takeover — list and resume sessions from other harnesses.
 *
 * A transcript file *is* a session. This module turns each one into a
 * `SessionRecord` (title, cwd, last activity, message and tool counts) so
 * `/sessions` can render a catalog and `/resume` can rebuild the session
 * into a handoff brief that DSH injects to continue the task.
 *
 * Everything is schema-tolerant and pure over its input text; tests feed
 * fixtures directly.
 *
 * @module dsh-of-your-own/sessions
 */

import { join } from 'node:path'
import type { FsLike } from './sources.js'

/** One resumable session discovered in another harness. */
export interface SessionRecord {
  /** Which harness owns it. */
  source: string
  /** Short session id. */
  id: string
  /** Transcript path (history.jsonl for grouped claude-history records). */
  file: string
  cwd?: string
  /** Session title: explicit title line, else the first user prompt. */
  title?: string
  /** Epoch ms of the last observed activity. */
  lastMs?: number
  userMessages: number
  assistantMessages: number
  /** Ordered tool-call names (bounded). */
  toolNames: string[]
  /** Last few user prompts, oldest first within the window (bounded). */
  recentUserPrompts: string[]
  /** Truncated final assistant text — where the session stopped. */
  lastAssistantText?: string
}

/** Caps applied while building session records. */
export interface SessionScanLimits {
  maxFilesPerSource: number
  maxBytesPerFile: number
  /** Recent user prompts retained per session. */
  maxRecentPrompts: number
  /** Tool names retained per session. */
  maxToolNames: number
  /** Char cap for titles / last-assistant snippets. */
  maxSnippetChars: number
}

export const defaultSessionLimits: SessionScanLimits = {
  maxFilesPerSource: 50,
  maxBytesPerFile: 512 * 1024,
  maxRecentPrompts: 6,
  maxToolNames: 40,
  maxSnippetChars: 280,
}

/** Coerce a timestamp (ISO string or epoch ms) into epoch ms, or undefined. */
export function toEpochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: seconds → ms.
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === 'string') {
    const t = Date.parse(value)
    return Number.isNaN(t) ? undefined : t
  }
  return undefined
}

/** Truncate to a bounded single-line snippet. */
export function snippet(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** Render an epoch-ms timestamp as a compact relative string. */
export function relativeTime(nowMs: number, ms?: number): string {
  if (!ms) return '—'
  const diff = Math.max(0, nowMs - ms)
  const min = Math.round(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 48) return `${hr}h ago`
  const day = Math.round(hr / 24)
  if (day < 30) return `${day}d ago`
  return `${Math.round(day / 30)}mo ago`
}

/** Replace a leading home dir with `~` for compact display. */
export function homeRelative(path: string, home: string): string {
  if (!path) return ''
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

function pushBounded<T>(arr: T[], value: T, max: number): void {
  arr.push(value)
  if (arr.length > max) arr.shift()
}

/**
 * Turn a raw user message into a presentable title. Claude Code wraps
 * teammate/subagent/system messages in XML tags (`<teammate-message …>`,
 * `<local-command-caveat>…`); those are plumbing, not the user's task, so
 * any message that opens with `<` is rejected outright.
 */
export function cleanTitle(text: string): string | undefined {
  const t = text.trim()
  if (!t || t.startsWith('<')) return undefined
  return t
}

/** Parse a Claude Code transcript (one file = one session). */
export function extractClaudeSession(text: string, file: string, limits: SessionScanLimits): SessionRecord | undefined {
  const rec: SessionRecord = {
    source: 'claude-code', id: '', file, userMessages: 0, assistantMessages: 0,
    toolNames: [], recentUserPrompts: [],
  }
  for (const line of text.split('\n')) {
    if (!line) continue
    let entry: Record<string, unknown>
    try { entry = JSON.parse(line) as Record<string, unknown> } catch { continue }

    if (typeof entry.sessionId === 'string' && !rec.id) rec.id = entry.sessionId
    if (typeof entry.cwd === 'string' && !rec.cwd) rec.cwd = entry.cwd
    const ts = toEpochMs(entry.timestamp)
    if (ts !== undefined) rec.lastMs = Math.max(rec.lastMs ?? 0, ts)

    if (entry.type === 'user') {
      const msg = entry.message as { role?: string; content?: unknown } | undefined
      if (msg?.role === 'user' && typeof msg.content === 'string' && msg.content.trim()) {
        rec.userMessages += 1
        if (!rec.title) {
          const cleaned = cleanTitle(msg.content)
          if (cleaned) rec.title = snippet(cleaned, limits.maxSnippetChars)
        }
        pushBounded(rec.recentUserPrompts, msg.content.trim(), limits.maxRecentPrompts)
      }
    } else if (entry.type === 'assistant') {
      rec.assistantMessages += 1
      const msg = entry.message as { content?: unknown } | undefined
      if (Array.isArray(msg?.content)) {
        for (const block of msg!.content as unknown[]) {
          const b = block as { type?: string; name?: string; text?: string }
          if (b?.type === 'tool_use' && typeof b.name === 'string') pushBounded(rec.toolNames, b.name, limits.maxToolNames)
          else if (b?.type === 'text' && typeof b.text === 'string') rec.lastAssistantText = snippet(b.text, limits.maxSnippetChars)
        }
      }
    }
  }
  if (rec.userMessages === 0 && rec.assistantMessages === 0) return undefined
  if (!rec.id) rec.id = `claude-${file.split('/').pop() ?? 'session'}`
  return rec
}

/** Parse a Codex rollout (one file = one session / fork). */
export function extractCodexSession(text: string, file: string, limits: SessionScanLimits): SessionRecord {
  const rec: SessionRecord = {
    source: 'codex', id: '', file, userMessages: 0, assistantMessages: 0,
    toolNames: [], recentUserPrompts: [],
  }
  for (const line of text.split('\n')) {
    if (!line) continue
    let entry: Record<string, unknown>
    try { entry = JSON.parse(line) as Record<string, unknown> } catch { continue }
    const payload = entry.payload as Record<string, unknown> | undefined

    if (entry.type === 'session_meta' && payload) {
      if (typeof payload.session_id === 'string') rec.id = payload.session_id
      if (typeof payload.cwd === 'string' && !rec.cwd) rec.cwd = payload.cwd
      const ts = toEpochMs(payload.timestamp)
      if (ts !== undefined) rec.lastMs = Math.max(rec.lastMs ?? 0, ts)
    }

    if (entry.type === 'response_item' && payload) {
      const ptype = payload.type
      if (ptype === 'function_call' && typeof payload.name === 'string') {
        pushBounded(rec.toolNames, payload.name, limits.maxToolNames)
      } else if (ptype === 'local_shell_call') {
        pushBounded(rec.toolNames, 'shell', limits.maxToolNames)
      } else if (ptype === 'message' && payload.role === 'user') {
        rec.userMessages += 1
        const texts: string[] = []
        const content = payload.content
        if (Array.isArray(content)) {
          for (const item of content) {
            const c = item as { type?: string; text?: string }
            if (c?.type === 'input_text' && typeof c.text === 'string') texts.push(c.text)
          }
        } else if (typeof content === 'string') texts.push(content)
        const joined = texts.join(' ').trim()
        if (joined) {
          if (!rec.title) rec.title = snippet(joined, limits.maxSnippetChars)
          pushBounded(rec.recentUserPrompts, joined, limits.maxRecentPrompts)
        }
      } else if (ptype === 'message' && payload.role === 'assistant') {
        rec.assistantMessages += 1
        const content = payload.content
        if (Array.isArray(content)) {
          for (const item of content) {
            const c = item as { type?: string; text?: string }
            if (c?.type === 'output_text' && typeof c.text === 'string') {
              rec.lastAssistantText = snippet(c.text, limits.maxSnippetChars)
            }
          }
        }
      }
    }
  }
  if (!rec.id) rec.id = `codex-${file.split('/').pop() ?? 'session'}`
  return rec
}

/** Parse a pi/omp session (one file = one session; omp carries title lines). */
export function extractPiSession(text: string, file: string, limits: SessionScanLimits, source: 'pi' | 'omp'): SessionRecord | undefined {
  const rec: SessionRecord = {
    source, id: '', file, userMessages: 0, assistantMessages: 0,
    toolNames: [], recentUserPrompts: [],
  }
  for (const line of text.split('\n')) {
    if (!line) continue
    let entry: Record<string, unknown>
    try { entry = JSON.parse(line) as Record<string, unknown> } catch { continue }

    const ts = toEpochMs(entry.timestamp)
    if (ts !== undefined) rec.lastMs = Math.max(rec.lastMs ?? 0, ts)

    if (entry.type === 'session') {
      if (typeof entry.id === 'string') rec.id = entry.id
      if (typeof entry.cwd === 'string' && !rec.cwd) rec.cwd = entry.cwd
    } else if (entry.type === 'title' && typeof entry.title === 'string') {
      rec.title = snippet(entry.title, limits.maxSnippetChars)
    } else if (entry.type === 'message') {
      const msg = entry.message as { role?: string; content?: unknown } | undefined
      if (!msg) continue
      const items = Array.isArray(msg.content)
        ? msg.content as unknown[]
        : typeof msg.content === 'string'
          ? [{ type: 'text', text: msg.content }]
          : []
      if (msg.role === 'user') {
        const text = items
          .map(it => (it as { type?: string; text?: string }).text)
          .filter((t): t is string => typeof t === 'string')
          .join(' ').trim()
        if (text) {
          rec.userMessages += 1
          if (!rec.title) rec.title = snippet(text, limits.maxSnippetChars)
          pushBounded(rec.recentUserPrompts, text, limits.maxRecentPrompts)
        }
      } else if (msg.role === 'assistant') {
        rec.assistantMessages += 1
        for (const it of items) {
          const c = it as { type?: string; name?: string; text?: string }
          if (c?.type === 'toolCall' && typeof c.name === 'string') pushBounded(rec.toolNames, c.name, limits.maxToolNames)
          else if (c?.type === 'text' && typeof c.text === 'string') rec.lastAssistantText = snippet(c.text, limits.maxSnippetChars)
        }
      }
    }
  }
  if (rec.userMessages === 0 && rec.assistantMessages === 0) return undefined
  if (!rec.id) rec.id = `${source}-${file.split('/').pop() ?? 'session'}`
  return rec
}

/** Group a Claude Code history.jsonl into per-session records. */
export function extractClaudeHistorySessions(text: string, file: string, limits: SessionScanLimits): SessionRecord[] {
  const byId = new Map<string, SessionRecord>()
  for (const line of text.split('\n')) {
    if (!line) continue
    let entry: Record<string, unknown>
    try { entry = JSON.parse(line) as Record<string, unknown> } catch { continue }
    if (typeof entry.display !== 'string' || !entry.display.trim()) continue
    const id = typeof entry.sessionId === 'string' ? entry.sessionId : 'unknown'
    let rec = byId.get(id)
    if (!rec) {
      rec = {
        source: 'claude-history', id, file, userMessages: 0, assistantMessages: 0,
        toolNames: [], recentUserPrompts: [],
        cwd: typeof entry.project === 'string' ? entry.project : undefined,
      }
      byId.set(id, rec)
    }
    rec.userMessages += 1
    const ts = toEpochMs(entry.timestamp)
    if (ts !== undefined) rec.lastMs = Math.max(rec.lastMs ?? 0, ts)
    if (!rec.title) rec.title = snippet(entry.display, limits.maxSnippetChars)
    pushBounded(rec.recentUserPrompts, entry.display.trim(), limits.maxRecentPrompts)
  }
  return [...byId.values()]
}

/** Per-source session extractor, keyed by the same roots scanSources uses. */
export const sessionExtractors: Record<string, (text: string, file: string, limits: SessionScanLimits) => SessionRecord[]> = {
  'claude-code': (t, f, l) => { const r = extractClaudeSession(t, f, l); return r ? [r] : [] },
  codex: (t, f, l) => [extractCodexSession(t, f, l)],
  pi: (t, f, l) => { const r = extractPiSession(t, f, l, 'pi'); return r ? [r] : [] },
  omp: (t, f, l) => { const r = extractPiSession(t, f, l, 'omp'); return r ? [r] : [] },
  'claude-history': (t, f, l) => extractClaudeHistorySessions(t, f, l),
}

/** Recursively collect `.jsonl` files under a root (newest first), with mtimes. */
async function collectFiles(fs: FsLike, root: string): Promise<{ path: string; mtimeMs: number }[]> {
  const found: { path: string; mtimeMs: number }[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries: { name: string; isDirectory: boolean; mtimeMs?: number }[]
    try { entries = await fs.listDir(dir) } catch { return }
    await Promise.all(entries.map(async (e) => {
      const p = join(dir, e.name)
      if (e.isDirectory) return walk(p)
      if (e.name.endsWith('.jsonl')) found.push({ path: p, mtimeMs: e.mtimeMs ?? 0 })
    }))
  }
  await walk(root)
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return found
}

/**
 * List every resumable session across all configured roots, newest first.
 * Roots ending in `.jsonl` are read as a single file; others are walked.
 */
export async function listSessions(
  fs: FsLike,
  roots: Record<string, string>,
  limits: SessionScanLimits = defaultSessionLimits,
): Promise<SessionRecord[]> {
  const names = Object.keys(roots).filter(n => sessionExtractors[n])
  const perSource = await Promise.all(names.map(async (source): Promise<SessionRecord[]> => {
    const extract = sessionExtractors[source]
    const root = roots[source]
    const isFile = root.endsWith('.jsonl')
    const files = isFile
      ? (await fs.exists(root) ? [{ path: root, mtimeMs: 0 }] : [])
      : (await collectFiles(fs, root)).slice(0, limits.maxFilesPerSource)
    const records = await Promise.all(files.map(async ({ path }) => {
      let text: string
      try { text = await fs.readText(path) } catch { return [] as SessionRecord[] }
      if (text.length > limits.maxBytesPerFile) text = text.slice(0, limits.maxBytesPerFile)
      return extract(text, path, limits)
    }))
    return records.flat()
  }))
  return perSource.flat()
    .filter(r => r.userMessages > 0 || r.assistantMessages > 0)
    .sort((a, b) => (b.lastMs ?? 0) - (a.lastMs ?? 0))
}

/** Render the numbered catalog shown by `/sessions`. */
export function renderSessionList(records: readonly SessionRecord[], home: string, nowMs: number, max = 20): string {
  if (records.length === 0) return 'No resumable sessions found. Run other agents first, then retry.'
  const lines: string[] = [`## Resumable sessions (${records.length})`, '']
  lines.push('  #  source          title                                            dir            when      msgs')
  records.slice(0, max).forEach((r, i) => {
    const num = String(i + 1).padStart(3)
    const title = (r.title ?? '(untitled)').slice(0, 46).padEnd(47)
    const dir = homeRelative(r.cwd ?? '', home).slice(0, 14).padEnd(15)
    const when = relativeTime(nowMs, r.lastMs).padEnd(9)
    lines.push(`${num}  ${r.source.padEnd(15)} ${title} ${dir} ${when} ${r.userMessages}`)
  })
  if (records.length > max) lines.push(`… ${records.length - max} more`)
  lines.push('', 'Run `/resume <#>` to hand that task to this agent.')
  return lines.join('\n')
}

/** Build the handoff brief injected on `/resume` (markdown). */
export function buildHandoffBrief(record: SessionRecord): string {
  const lines: string[] = [
    `# Resumed task (from ${record.source})`,
    '',
    `You are taking over a session that previously ran in ${record.source}. Continue it.`,
    '',
    `Original task: ${record.title ?? '(unknown)'}`,
  ]
  if (record.cwd) lines.push(`Working directory: ${record.cwd}`)
  if (record.recentUserPrompts.length) {
    lines.push('', 'Most recent user direction:', ...record.recentUserPrompts.map(p => `- ${snippet(p, 200)}`))
  }
  if (record.lastAssistantText) {
    lines.push('', `Where it stopped (last assistant message):`, record.lastAssistantText)
  }
  if (record.toolNames.length) {
    const counts = new Map<string, number>()
    for (const t of record.toolNames) counts.set(t, (counts.get(t) ?? 0) + 1)
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, c]) => `${n}×${c}`).join(', ')
    lines.push('', `Tools used there: ${top}`)
  }
  lines.push('', 'Pick up from where it left off. Confirm the plan, then continue the work.')
  return lines.join('\n')
}

/** Render what `/resume` reports back to the user. */
export function renderResumeReport(record: SessionRecord, brief: string): string {
  const header = [
    `## Resuming ${record.source} session \`${record.id}\``,
    '',
    `Task: ${record.title ?? '(untitled)'}`,
    ...(record.cwd ? [`Directory: ${record.cwd}`] : []),
    `${record.userMessages} user messages · ${record.assistantMessages} assistant messages`,
    '',
  ].join('\n')
  return `${header}${brief}`
}
