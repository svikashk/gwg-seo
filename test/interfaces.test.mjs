import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const exec = promisify(execFile)
const cli = new URL('../dist/cli.js', import.meta.url).pathname

test('CLI catalog, projects, and errors work outside the checkout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gwg-cli-'))
  const env = {
    ...process.env,
    GWG_SEO_HOME: join(dir, 'data'),
    GWG_GOOGLE_ACCESS_TOKEN: '',
    GOOGLE_APPLICATION_CREDENTIALS: '',
  }
  const run = (args) =>
    exec(process.execPath, [cli, ...args], { cwd: dir, env })
  try {
    const list = JSON.parse((await run(['reports', 'list'])).stdout)
    assert.equal(list.length, 8)
    await run([
      'project',
      'add',
      'demo',
      '--url',
      'https://example.com',
      '--site',
      'sc-domain:example.com',
    ])
    const p = JSON.parse((await run(['project', 'show', 'demo'])).stdout)
    assert.equal(p.url, 'https://example.com/')
    const config = JSON.parse((await run(['mcp', 'config'])).stdout)
    assert.equal(config.mcpServers['gwg-seo'].command, process.execPath)
    await assert.rejects(
      run(['snapshots', 'show', 'google-auth']),
      (e) => JSON.parse(e.stderr).error.code === 'SNAPSHOT_ID',
    )
    await assert.rejects(
      run([
        'reports',
        'run',
        'page.audit',
        '--params',
        '{"url":"http://127.0.0.1/","allowPrivate":true}',
      ]),
      (e) => JSON.parse(e.stderr).error.code === 'INVALID_INPUT',
    )
    await assert.rejects(
      run(['reports', 'run', 'unknown']),
      (e) =>
        e.stdout === '' && JSON.parse(e.stderr).error.code === 'REPORT_UNKNOWN',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test('real MCP stdio handshake, discovery, schemas, and errors are clean JSON-RPC', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gwg-mcp-'))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'mcp', 'serve'],
    cwd: dir,
    env: { ...process.env, GWG_SEO_HOME: join(dir, 'data') },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'gwg-integration-test', version: '1.0.0' })
  let stderr = ''
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map((t) => t.name).sort(), [
      'seo_describe',
      'seo_reports',
      'seo_run',
    ])
    const catalog = await client.callTool({
      name: 'seo_reports',
      arguments: {},
    })
    assert.equal(JSON.parse(catalog.content[0].text).length, 8)
    const schema = await client.callTool({
      name: 'seo_describe',
      arguments: { id: 'site.crawl' },
    })
    assert.equal(
      JSON.parse(schema.content[0].text).inputSchema.properties.maxPages
        .maximum,
      200,
    )
    const bad = await client.callTool({
      name: 'seo_run',
      arguments: {
        id: 'page.audit',
        params: { url: 'http://127.0.0.1/', allowPrivate: true },
      },
    })
    assert.equal(bad.isError, true)
    assert.equal(JSON.parse(bad.content[0].text).error.code, 'INVALID_INPUT')
    assert.equal(stderr, '')
  } finally {
    await client.close()
    await rm(dir, { recursive: true, force: true })
  }
})
