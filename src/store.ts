import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { encoded, GwgError, type Report, webUrl } from './model.js'

export type Project = {
  name: string
  url: string
  searchConsoleSite?: string
  analyticsProperty?: string
}
export class LocalStore {
  readonly root: string
  constructor(root = process.env.GWG_SEO_HOME ?? join(homedir(), '.gwg-seo')) {
    this.root = resolve(root)
  }
  private filename(id: string) {
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(id))
      throw new GwgError(
        'INVALID_ID',
        'Use an identifier of 1-80 letters, numbers, underscores, or hyphens.',
      )
    return join(this.root, `${id}.json`)
  }
  private async ready() {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const stat = await lstat(this.root)
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new GwgError(
        'UNSAFE_STORE',
        'The storage directory must be a real directory, not a symbolic link.',
      )
    await chmod(this.root, 0o700)
  }
  async read<T>(id: string): Promise<T | undefined> {
    const path = this.filename(id)
    await this.ready()
    let file: Awaited<ReturnType<typeof open>>
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new GwgError('STORE_READ', 'Cannot safely read the local record.')
    }
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 2_000_000)
        throw new GwgError(
          'STORE_LIMIT',
          'Local record is not a regular file under 2 MB.',
        )
      return JSON.parse(await file.readFile('utf8')) as T
    } catch (error) {
      if (error instanceof GwgError) throw error
      throw new GwgError('STORE_FORMAT', 'The local record is not valid JSON.')
    } finally {
      await file.close()
    }
  }
  async write(id: string, value: unknown) {
    const target = this.filename(id),
      text = encoded(value)
    await this.ready()
    const temp = join(this.root, `.${randomUUID()}.tmp`)
    const file = await open(temp, 'wx', 0o600)
    try {
      await file.writeFile(text)
      await file.sync()
      await file.close()
      await rename(temp, target)
    } finally {
      await file.close()
      await rm(temp, { force: true })
    }
    return target
  }
  async remove(id: string) {
    await this.ready()
    await rm(this.filename(id), { force: true })
  }
  async ids(prefix: string) {
    await this.ready()
    return (await readdir(this.root))
      .filter((x) => x.startsWith(prefix) && x.endsWith('.json'))
      .map((x) => x.slice(0, -5))
      .sort()
  }
  async projects() {
    const ids = await this.ids('project-')
    const projects: Project[] = []
    for (const id of ids) {
      const p = await this.read<Project>(id)
      if (p) projects.push(p)
    }
    return projects
  }
  async putProject(project: Project) {
    const p = { ...project, url: webUrl(project.url) }
    if (p.analyticsProperty && !/^\d+$/.test(p.analyticsProperty))
      throw new GwgError(
        'INVALID_PROPERTY',
        'Analytics property must be a numeric ID.',
      )
    await this.write(`project-${p.name}`, p)
    return p
  }
  async project(name: string) {
    const p = await this.read<Project>(`project-${name}`)
    if (!p) throw new GwgError('PROJECT_MISSING', 'Project was not found.')
    return p
  }
  async save(value: Report) {
    const id = `snapshot-${Date.now()}-${randomUUID().slice(0, 8)}`
    await this.write(id, value)
    return id
  }
}
export function compareReports(before: Report, after: Report) {
  if (before.id !== after.id)
    throw new GwgError(
      'REPORT_MISMATCH',
      'Compare snapshots of the same report type.',
    )
  const scope = (r: Report) => {
    const d = r.data as Record<string, unknown>
    return d.start ?? d.url ?? d.site ?? d.property
  }
  if (scope(before) !== scope(after))
    throw new GwgError(
      'SCOPE_MISMATCH',
      'Compare reports for the same URL or property.',
    )
  const key = (f: Report['findings'][number]) =>
    JSON.stringify([f.code, f.url, f.observation])
  const old = new Set(before.findings.map(key)),
    next = new Set(after.findings.map(key))
  return {
    before: before.generatedAt,
    after: after.generatedAt,
    added: after.findings.filter((f) => !old.has(key(f))),
    absent: before.findings.filter((f) => !next.has(key(f))),
    coverage: { before: before.coverage, after: after.coverage },
    note: 'Absent findings are not proof of a fix. Compare acquired pages and coverage before drawing conclusions.',
  }
}
