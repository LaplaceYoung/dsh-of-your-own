/**
 * Persistence — the profile and migrated artifacts on disk.
 *
 * Everything lives under one store dir (default `~/.dsh/of-your-own/`):
 *
 *   profile.json   — the learned UserProfile (see analyze.ts)
 *   commands/      — migrated slash-command stubs, one `.md` per command
 *
 * Writes go through the `ctx.fs` seam when present (node:fs fallback
 * otherwise), so the plugin keeps working in sandboxed compositions.
 *
 * @module dsh-of-your-own/store
 */

import { dirname, join } from 'node:path'
import type { UserProfile } from './analyze.js'

/** Same fs seam as sources.ts (redeclared to keep modules standalone). */
export interface FsLike {
  readText(path: string): Promise<string>
  writeText(path: string, content: string): Promise<void>
  listDir(path: string): Promise<{ name: string; isDirectory: boolean; mtimeMs?: number }[]>
  exists(path: string): Promise<boolean>
  remove(path: string): Promise<void>
}

/** One migrated command artifact. */
export interface MigratedCommand {
  /** Slash name, e.g. `/review`. */
  name: string
  /** Where it came from: 'claude-code' | 'codex' | … */
  source: string
  /** Times observed across scanned transcripts. */
  observed: number
  /** The generated stub body (markdown). */
  body: string
}

/** Build a stub body for a migrated slash command (pure). */
export function buildCommandStub(name: string, source: string, observed: number): string {
  return [
    `# ${name}`,
    '',
    `> Migrated by dsh-of-your-own: observed ${observed}× in ${source} history.`,
    `> Adapt this stub into a real DSH command when you have time — for now it`,
    '> reminds the agent of the workflow you used elsewhere.',
    '',
    `When the user invokes ${name}, acknowledge it as a migrated habit and ask`,
    'what they want to accomplish, instead of failing with an unknown command.',
    '',
  ].join('\n')
}

/** Markers delimiting the plugin-managed block inside ~/.dsh/AGENTS.md. */
export const AGENTS_MANAGED_BEGIN = '<!-- dsh-of-your-own:begin -->'
export const AGENTS_MANAGED_END = '<!-- dsh-of-your-own:end -->'

/** Wrap a section in the managed markers (pure). */
export function buildAgentsBlock(section: string): string {
  return `${AGENTS_MANAGED_BEGIN}\n${section}\n${AGENTS_MANAGED_END}`
}

/**
 * Replace the managed block in existing AGENTS.md content, or append it
 * when absent. User-authored content outside the block is never touched,
 * and re-runs never duplicate the block (pure).
 */
export function upsertAgentsBlock(existing: string, section: string): string {
  const block = buildAgentsBlock(section)
  const begin = existing.indexOf(AGENTS_MANAGED_BEGIN)
  const end = existing.indexOf(AGENTS_MANAGED_END)
  if (begin >= 0 && end > begin) {
    return existing.slice(0, begin) + block + existing.slice(end + AGENTS_MANAGED_END.length)
  }
  const sep = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  return existing + sep + block + '\n'
}

/**
 * Write (or update) the managed block inside DSH's native user-global
 * instruction file. DSH's workspace-context loads $DSH_HOME/AGENTS.md on
 * every session — so the migrated preferences survive even without this
 * plugin mounted.
 */
export async function writeNativeAgentsMd(
  fs: FsLike,
  agentsPath: string,
  section: string,
): Promise<string> {
  let existing = ''
  try {
    existing = await fs.readText(agentsPath)
  } catch { /* no file yet */ }
  await fs.writeText(agentsPath, upsertAgentsBlock(existing, section))
  return agentsPath
}

/**
 * Remove the managed block from existing AGENTS.md content, preserving
 * everything outside it (pure). Returns the content unchanged when no
 * complete block is present.
 */
export function removeManagedBlock(existing: string): string {
  const begin = existing.indexOf(AGENTS_MANAGED_BEGIN)
  const end = existing.indexOf(AGENTS_MANAGED_END)
  if (begin < 0 || end <= begin) return existing
  let before = existing.slice(0, begin)
  let after = existing.slice(end + AGENTS_MANAGED_END.length)
  // Trim the seam so removal doesn't leave a gap of blank lines.
  before = before.replace(/\n+$/, '\n')
  after = after.replace(/^\n+/, '')
  if (before === '\n' && !after) return ''
  return before + after
}

/**
 * Forget everything this plugin wrote: strip the managed block from the
 * native AGENTS.md and delete the store dir. Idempotent — safe when
 * nothing was ever migrated.
 */
export async function eraseAll(
  fs: FsLike,
  agentsPath: string,
  storeDir: string,
): Promise<{ agentsStripped: boolean; storeRemoved: boolean }> {
  let agentsStripped = false
  try {
    const existing = await fs.readText(agentsPath)
    const cleaned = removeManagedBlock(existing)
    if (cleaned !== existing) {
      agentsStripped = true
      if (cleaned === '') await fs.remove(agentsPath)
      else await fs.writeText(agentsPath, cleaned)
    }
  } catch { /* no AGENTS.md */ }

  let storeRemoved = false
  if (await fs.exists(storeDir)) {
    await fs.remove(storeDir)
    storeRemoved = true
  }
  return { agentsStripped, storeRemoved }
}

/** Serialize the profile (stable key order for diff-friendly files). */
export function serializeProfile(profile: UserProfile): string {
  return `${JSON.stringify(profile, null, 2)}\n`
}

/** Deserialize + validate a stored profile; undefined on any corruption. */
export function deserializeProfile(text: string): UserProfile | undefined {
  try {
    const raw = JSON.parse(text) as Partial<UserProfile>
    if (raw?.version !== 1) return undefined
    if (!Array.isArray(raw.sources) || typeof raw.preferences !== 'string') return undefined
    return raw as UserProfile
  } catch {
    return undefined
  }
}

/** Persist the profile + migrated command stubs under the store dir. */
export async function saveProfile(
  fs: FsLike,
  storeDir: string,
  profile: UserProfile,
  commands: readonly MigratedCommand[],
): Promise<{ profilePath: string; commandPaths: string[] }> {
  const profilePath = join(storeDir, 'profile.json')
  await fs.writeText(profilePath, serializeProfile(profile))
  const commandPaths: string[] = []
  for (const cmd of commands) {
    const safe = cmd.name.replace(/[^A-Za-z0-9_-]/g, '')
    if (!safe) continue
    const p = join(storeDir, 'commands', `${safe}.md`)
    await fs.writeText(p, cmd.body)
    commandPaths.push(p)
  }
  return { profilePath, commandPaths }
}

/** Load a previously saved profile (undefined when absent or corrupt). */
export async function loadProfile(fs: FsLike, storeDir: string): Promise<UserProfile | undefined> {
  try {
    return deserializeProfile(await fs.readText(join(storeDir, 'profile.json')))
  } catch {
    return undefined
  }
}

/** node:fs/promises fallback used when `ctx.fs` is absent. */
export function nodeFsFallback(): FsLike {
  return {
    async readText(path) { return (await import('node:fs/promises')).readFile(path, 'utf8') },
    async writeText(path, content) {
      const fsp = await import('node:fs/promises')
      await fsp.mkdir(dirname(path), { recursive: true })
      await fsp.writeFile(path, content, 'utf8')
    },
    async listDir(path) {
      const fsp = await import('node:fs/promises')
      const entries = await fsp.readdir(path, { withFileTypes: true })
      return Promise.all(entries.map(async (e) => {
        let mtimeMs: number | undefined
        try { mtimeMs = (await fsp.stat(join(path, e.name))).mtimeMs } catch { /* raced */ }
        return { name: e.name, isDirectory: e.isDirectory(), mtimeMs }
      }))
    },
    async exists(path) {
      try {
        await (await import('node:fs/promises')).stat(path)
        return true
      } catch {
        return false
      }
    },
    async remove(path) {
      await (await import('node:fs/promises')).rm(path, { recursive: true, force: true })
    },
  }
}
