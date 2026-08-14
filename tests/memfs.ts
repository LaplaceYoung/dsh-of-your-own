/**
 * In-memory FsLike for tests — arrow-function properties so instances can be
 * Object.assign'ed onto cordis Service stubs without losing `this`.
 */
export interface MemEntry {
  content?: string
  dir?: Record<string, MemEntry>
  mtimeMs?: number
}

export class MemFs {
  root: Record<string, MemEntry> = {}

  private resolve(path: string): string[] {
    return path.split('/').filter(Boolean)
  }

  private lookup(path: string): MemEntry | undefined {
    let node: MemEntry | undefined = { dir: this.root }
    for (const seg of this.resolve(path)) {
      node = node?.dir?.[seg]
    }
    return node
  }

  private ensureParent(path: string): Record<string, MemEntry> {
    const segs = this.resolve(path)
    const name = segs.pop()!
    let dir = this.root
    for (const seg of segs) {
      let entry = dir[seg]
      if (!entry) {
        entry = { dir: {}, mtimeMs: 0 }
        dir[seg] = entry
      }
      dir = entry.dir ?? (entry.dir = {})
    }
    return dir
  }

  readText = async (path: string): Promise<string> => {
    const entry = this.lookup(path)
    if (entry?.content === undefined) throw new Error(`ENOENT: ${path}`)
    return entry.content
  }

  writeText = async (path: string, content: string): Promise<void> => {
    const dir = this.ensureParent(path)
    const name = this.resolve(path).pop()!
    dir[name] = { content, mtimeMs: Date.now() }
  }

  listDir = async (path: string): Promise<{ name: string; isDirectory: boolean; mtimeMs?: number }[]> => {
    const entry = this.lookup(path)
    if (!entry?.dir) throw new Error(`ENOTDIR: ${path}`)
    return Object.entries(entry.dir).map(([name, e]) => ({
      name,
      isDirectory: e.dir !== undefined,
      mtimeMs: e.mtimeMs ?? 0,
    }))
  }

  exists = async (path: string): Promise<boolean> => {
    return this.lookup(path) !== undefined
  }

  remove = async (path: string): Promise<void> => {
    const segs = this.resolve(path)
    const name = segs.pop()!
    let dir = this.root
    for (const seg of segs) {
      const entry = dir[seg]
      if (!entry?.dir) return
      dir = entry.dir
    }
    delete dir[name]
  }

  /** Test helper: write a file, auto-creating parents. */
  async seed(path: string, content: string): Promise<void> {
    await this.writeText(path, content)
  }
}
