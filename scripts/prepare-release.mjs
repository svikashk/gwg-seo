import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile),
  root = dirname(dirname(fileURLToPath(import.meta.url)))
const run = (cmd, args) => exec(cmd, args, { cwd: root, maxBuffer: 8_000_000 })
if ((await run('git', ['status', '--porcelain'])).stdout.trim())
  throw new Error('Commit reviewed changes before preparing a release.')
await run('npm', ['run', 'check'])
await run('npm', ['run', 'test:install'])
const directory = join(root, 'release')
await mkdir(directory, { recursive: true })
const pack = JSON.parse(
  (
    await run('npm', [
      'pack',
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      directory,
    ])
  ).stdout,
)[0]
const archive = await readFile(join(directory, pack.filename))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const manifest = {
  name: pkg.name,
  version: pkg.version,
  publicationBlocked: pkg.private === true,
  commit: (await run('git', ['rev-parse', 'HEAD'])).stdout.trim(),
  filename: pack.filename,
  sha256: createHash('sha256').update(archive).digest('hex'),
  integrity: pack.integrity,
  files: pack.files.map((f) => f.path),
}
await writeFile(
  join(directory, `${pkg.version}.json`),
  `${JSON.stringify(manifest, null, 2)}\n`,
)
console.log(
  `Verified archive and manifest prepared in ${directory}. No publication was performed.`,
)
