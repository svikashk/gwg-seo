import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { gunzipSync } from 'node:zlib'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const exec = promisify(execFile),
  root = dirname(dirname(fileURLToPath(import.meta.url)))
const fromRegistry = process.argv.includes('--registry')
assert(
  process.argv.slice(2).every((arg) => arg === '--registry'),
  'Unknown option',
)
const temp = await mkdtemp(join(tmpdir(), 'gwg-install-')),
  consumer = join(temp, 'consumer')
const env = {
  ...process.env,
  GWG_SEO_HOME: join(temp, 'data'),
  GWG_GOOGLE_ACCESS_TOKEN: '',
  GOOGLE_APPLICATION_CREDENTIALS: '',
}
const run = (command, args, cwd = root) =>
  exec(command, args, { cwd, env, maxBuffer: 4_000_000, timeout: 180000 })
try {
  await run('npm', ['run', 'build'])
  const packed = JSON.parse(
    (
      await run('npm', [
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        temp,
      ])
    ).stdout,
  )[0]
  const registrySpec = `${packed.name}@${packed.version}`
  if (fromRegistry) {
    const integrity = JSON.parse(
      (
        await run('npm', [
          'view',
          registrySpec,
          'dist.integrity',
          '--json',
          '--registry=https://registry.npmjs.org',
        ])
      ).stdout,
    )
    const registryDirectory = join(temp, 'registry')
    await mkdir(registryDirectory)
    const downloaded = JSON.parse(
      (
        await run('npm', [
          'pack',
          registrySpec,
          '--ignore-scripts',
          '--json',
          '--pack-destination',
          registryDirectory,
          '--registry=https://registry.npmjs.org',
        ])
      ).stdout,
    )[0]
    assert.equal(
      downloaded.integrity,
      integrity,
      'Downloaded registry integrity mismatch',
    )
    // Node versions can produce different gzip bytes for the same tar contents.
    assert(
      gunzipSync(
        await readFile(join(registryDirectory, downloaded.filename)),
      ).equals(gunzipSync(await readFile(join(temp, packed.filename)))),
      'Published files differ from this checkout',
    )
    try {
      const manifest = JSON.parse(
        await readFile(join(root, 'release', `${packed.version}.json`), 'utf8'),
      )
      assert.equal(
        integrity,
        manifest.integrity,
        'Published archive differs from the prepared release',
      )
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const names = packed.files.map((f) => f.path)
  for (const path of names)
    assert(
      /^(dist\/|skills\/gwg-seo\/SKILL\.md$|package\.json$|README\.md$|PRIVACY\.md$|RELEASING\.md$|LICENSE$)/.test(
        path,
      ),
      `Unexpected package file: ${path}`,
    )
  for (const path of [
    'dist/index.js',
    'dist/index.d.ts',
    'dist/cli.js',
    'dist/mcp.js',
    'skills/gwg-seo/SKILL.md',
    'LICENSE',
    'README.md',
    'PRIVACY.md',
  ])
    assert(names.includes(path), `Missing package file: ${path}`)
  await mkdir(consumer)
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({
      name: 'gwg-install-consumer',
      private: true,
      type: 'module',
    }),
  )
  await run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      fromRegistry ? registrySpec : join(temp, packed.filename),
      '--registry=https://registry.npmjs.org',
    ],
    consumer,
  )
  const cli = join(
    consumer,
    'node_modules',
    '@getwickedgrowth',
    'seo',
    'dist',
    'cli.js',
  )
  const version = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  ).version
  assert.equal(
    (await run(process.execPath, [cli, '--version'], consumer)).stdout.trim(),
    version,
  )
  for (const bin of ['gwg-seo', 'seo'])
    assert.equal(
      (
        await run('npm', ['exec', '--no', '--', bin, '--version'], consumer)
      ).stdout.trim(),
      version,
    )
  assert.match(
    (await run(process.execPath, [cli, '--help'], consumer)).stdout,
    /reports list/,
  )
  const config = JSON.parse(
    (await run(process.execPath, [cli, 'mcp', 'config'], consumer)).stdout,
  )
  assert.equal(
    await realpath(config.mcpServers['gwg-seo'].args[0]),
    await realpath(cli),
  )
  await run(
    process.execPath,
    [cli, 'skill', 'install', '--to', join(temp, 'agent-skills')],
    consumer,
  )
  await run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "const m=await import('@getwickedgrowth/seo'); if(m.listReports().length !== 8) throw Error('catalog'); const s=await import('@getwickedgrowth/seo/mcp'); await s.createMcpServer().close();",
    ],
    consumer,
  )
  await writeFile(
    join(consumer, 'consumer.ts'),
    "import { runReport, type Report } from '@getwickedgrowth/seo'; import { createMcpServer } from '@getwickedgrowth/seo/mcp'; const result: Promise<Report> = runReport('page.audit', {url:'https://example.com/'}); void result; void createMcpServer;\n",
  )
  await run(
    process.execPath,
    [
      join(root, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--module',
      'NodeNext',
      '--target',
      'ES2023',
      join(consumer, 'consumer.ts'),
    ],
    consumer,
  )
  const client = new Client({
    name: 'packaged-install-check',
    version: '1.0.0',
  })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'mcp', 'serve'],
    cwd: consumer,
    env,
    stderr: 'pipe',
  })
  try {
    await client.connect(transport)
    assert.equal((await client.listTools()).tools.length, 3)
  } finally {
    await client.close()
  }
  console.log(
    `${fromRegistry ? 'Registry' : 'Packed'} install verified: ${packed.filename}; CLI, library, TypeScript, MCP, and skill work outside the checkout.`,
  )
} finally {
  await rm(temp, { recursive: true, force: true })
}
