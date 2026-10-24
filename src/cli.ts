#!/usr/bin/env node
import { open, readFile, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { loginGoogle } from './google.js'
import { importSearchCsv } from './import.js'
import { installSkill, mcpConfig, packageVersion } from './install.js'
import { serveMcp } from './mcp.js'
import { encoded, failure, GwgError, type Report } from './model.js'
import { describeReport, listReports, runReport } from './registry.js'
import { renderReport } from './render.js'
import { compareReports, LocalStore } from './store.js'

const help = `GWG SEO: local website audits and search reports

  gwg-seo start                         Interactive page audit
  gwg-seo audit <url>                   Inspect one page
  gwg-seo crawl <url>                   Crawl same-origin pages
  gwg-seo reports list                  Discover implemented reports
  gwg-seo reports describe <id>         Read an input schema
  gwg-seo reports run <id> --params '{}' Run a report
  gwg-seo project add <name> --url <url> Save a local project
  gwg-seo project list|show|remove [name]
  gwg-seo auth login --client <file>    Google Desktop OAuth client JSON
  gwg-seo auth status|logout
  gwg-seo import <csv> --site <property> --start-date <date> --end-date <date>
  gwg-seo snapshots list|show|diff [ids]
  gwg-seo mcp config|serve              MCP stdio integration
  gwg-seo skill install --to <directory>
  gwg-seo doctor                       Inspect local setup without a network call

Report options:
  --project <name>  --params <json>  --url <url>
  --site <Search Console property>  --property <GA4 property ID>
  --start-date YYYY-MM-DD  --end-date YYYY-MM-DD
  --max-pages <1..200>  --max-depth <0..10>  --max-rows <1..10000>
  --max-urls <1..10000>  --dimensions query,page
  --format json|html|markdown  --output <new-file>  --save
  --allow-private  Explicitly permit private/local network addresses

Reports are JSON by default. Errors are JSON on stderr with a nonzero exit.
--save stores a local snapshot. Output files are created without overwriting.
Google calls need configured credentials. Website audits need none.
`
async function main() {
  const { values: flags, positionals: args } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      params: { type: 'string' },
      url: { type: 'string' },
      site: { type: 'string' },
      property: { type: 'string' },
      project: { type: 'string' },
      'start-date': { type: 'string' },
      'end-date': { type: 'string' },
      'max-pages': { type: 'string' },
      'max-depth': { type: 'string' },
      'max-rows': { type: 'string' },
      'max-urls': { type: 'string' },
      dimensions: { type: 'string' },
      format: { type: 'string' },
      output: { type: 'string' },
      save: { type: 'boolean' },
      'allow-private': { type: 'boolean' },
      to: { type: 'string' },
      client: { type: 'string' },
    },
  })
  const [command, action, name, extra] = args,
    store = new LocalStore()
  if (flags.version) {
    process.stdout.write(`${await packageVersion()}\n`)
    return
  }
  if (flags.help || !command) {
    process.stdout.write(help)
    return
  }
  const requireValue = (value: string | undefined, label: string) => {
    if (!value) throw new GwgError('ARGUMENT_REQUIRED', `Provide ${label}.`)
    return value
  }
  const exact = (count: number) => {
    if (args.length !== count)
      throw new GwgError(
        'ARGUMENT_COUNT',
        `Expected ${count} command arguments. Run gwg-seo --help.`,
      )
  }
  const format = flags.format ?? 'json'
  if (!['json', 'html', 'markdown'].includes(format))
    throw new GwgError('FORMAT', 'Use json, html, or markdown.')
  async function emit(value: unknown, isReport = false) {
    let text: string
    if (isReport) {
      const r = value as Report
      if (flags.save) {
        const id = await store.save(r)
        process.stderr.write(`Saved ${id}\n`)
      }
      text = renderReport(r, format as 'json' | 'html' | 'markdown')
    } else text = encoded(value)
    if (flags.output) {
      const file = await open(flags.output, 'wx', 0o600)
      try {
        await file.writeFile(`${text}\n`)
      } finally {
        await file.close()
      }
      process.stderr.write(`Wrote ${flags.output}\n`)
    } else process.stdout.write(`${text}\n`)
  }
  async function run(id: string, url?: string) {
    let params: Record<string, unknown> = {}
    if (flags.params) {
      try {
        const parsed: unknown = JSON.parse(flags.params)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new Error()
        params = parsed as Record<string, unknown>
      } catch {
        throw new GwgError('PARAMS_JSON', '--params must be a JSON object.')
      }
    }
    const schema = describeReport(id).inputSchema,
      properties = schema.properties ?? {}
    if (flags.project) {
      const p = await store.project(flags.project)
      for (const [key, value] of Object.entries({
        url: p.url,
        site: p.searchConsoleSite,
        property: p.analyticsProperty,
      }))
        if (
          Object.hasOwn(properties, key) &&
          !Object.hasOwn(params, key) &&
          value !== undefined
        )
          params[key] = value
    }
    const supplied: Record<string, unknown> = {
      url: url ?? flags.url,
      site: flags.site,
      property: flags.property,
      startDate: flags['start-date'],
      endDate: flags['end-date'],
      dimensions: flags.dimensions?.split(','),
    }
    for (const [cli, key] of [
      ['max-pages', 'maxPages'],
      ['max-depth', 'maxDepth'],
      ['max-rows', 'maxRows'],
      ['max-urls', 'maxUrls'],
    ] as const)
      if (flags[cli] !== undefined) supplied[key] = Number(flags[cli])
    for (const [key, value] of Object.entries(supplied))
      if (value !== undefined) params[key] = value
    await emit(
      await runReport(id, params, {
        network: { allowPrivate: flags['allow-private'] },
        google: { store },
      }),
      true,
    )
  }
  if (command === 'audit' || command === 'crawl') {
    if (args.length > 2) exact(2)
    await run(command === 'audit' ? 'page.audit' : 'site.crawl', action)
    return
  }
  if (command === 'reports') {
    if (action === 'list') {
      exact(2)
      await emit(listReports())
      return
    }
    if (action === 'describe') {
      exact(3)
      await emit(describeReport(requireValue(name, 'report ID')))
      return
    }
    if (action === 'run') {
      exact(3)
      await run(requireValue(name, 'report ID'))
      return
    }
  }
  if (command === 'start') {
    exact(1)
    if (!process.stdin.isTTY) {
      process.stdout.write(help)
      return
    }
    const prompt = createInterface({
      input: process.stdin,
      output: process.stderr,
    })
    let url: string
    try {
      url = await prompt.question('Website URL to inspect: ')
    } finally {
      prompt.close()
    }
    await run('page.audit', url.trim())
    return
  }
  if (command === 'project') {
    if (action === 'list') {
      exact(2)
      await emit(await store.projects())
      return
    }
    if (action === 'show') {
      exact(3)
      await emit(await store.project(requireValue(name, 'project name')))
      return
    }
    if (action === 'add') {
      exact(3)
      await emit(
        await store.putProject({
          name: requireValue(name, 'project name'),
          url: requireValue(flags.url, '--url'),
          searchConsoleSite: flags.site,
          analyticsProperty: flags.property,
        }),
      )
      return
    }
    if (action === 'remove') {
      exact(3)
      await store.remove(`project-${requireValue(name, 'project name')}`)
      await emit({ removed: name })
      return
    }
  }
  if (command === 'auth') {
    exact(2)
    if (action === 'logout') {
      await store.remove('google-auth')
      await emit({
        removed: true,
        note: 'Local OAuth credentials removed. Environment credentials and Google account grants are unchanged.',
      })
      return
    }
    if (action === 'status') {
      await emit({
        savedOAuth: !!(await store.read('google-auth')),
        environmentToken: !!process.env.GWG_GOOGLE_ACCESS_TOKEN,
        serviceAccountFile: !!process.env.GOOGLE_APPLICATION_CREDENTIALS,
        note: 'Configuration presence only. Credentials were not verified.',
      })
      return
    }
    if (action === 'login') {
      const path = requireValue(
        flags.client,
        '--client pointing to a Google Desktop OAuth client JSON file',
      )
      if ((await stat(path)).size > 64000)
        throw new GwgError('CLIENT_FILE', 'Client JSON must be under 64 KB.')
      let data: { installed?: { client_id?: string; client_secret?: string } }
      try {
        data = JSON.parse(await readFile(path, 'utf8'))
      } catch {
        throw new GwgError('CLIENT_FILE', 'Client file must be valid JSON.')
      }
      await emit(
        await loginGoogle({
          clientId: requireValue(
            data.installed?.client_id,
            'installed.client_id',
          ),
          clientSecret: requireValue(
            data.installed?.client_secret,
            'installed.client_secret',
          ),
          store,
          onUrl: (url) =>
            process.stderr.write(
              `Open this Google authorization URL in your browser:\n${url}\n`,
            ),
        }),
      )
      return
    }
  }
  if (command === 'import') {
    exact(2)
    await emit(
      await importSearchCsv(requireValue(action, 'CSV path'), {
        site: requireValue(flags.site, '--site'),
        startDate: requireValue(flags['start-date'], '--start-date'),
        endDate: requireValue(flags['end-date'], '--end-date'),
        maxRows:
          flags['max-rows'] === undefined
            ? undefined
            : Number(flags['max-rows']),
      }),
      true,
    )
    return
  }
  if (command === 'snapshots') {
    const load = async (id: string | undefined) => {
      if (!id?.startsWith('snapshot-'))
        throw new GwgError(
          'SNAPSHOT_ID',
          'Provide a snapshot ID from snapshots list.',
        )
      const value = await store.read<Report>(id)
      if (value?.schemaVersion !== 1 || !Array.isArray(value.findings))
        throw new GwgError(
          'SNAPSHOT_MISSING',
          'Snapshot was not found or has an unsupported format.',
        )
      return value
    }
    if (action === 'list') {
      exact(2)
      await emit(await store.ids('snapshot-'))
      return
    }
    if (action === 'show') {
      exact(3)
      await emit(await load(name), true)
      return
    }
    if (action === 'diff') {
      exact(4)
      await emit(compareReports(await load(name), await load(extra)))
      return
    }
  }
  if (command === 'mcp') {
    exact(2)
    if (action === 'config') {
      await emit(mcpConfig())
      return
    }
    if (action === 'serve') {
      await serveMcp({
        network: { allowPrivate: flags['allow-private'] },
        google: { store },
      })
      return
    }
  }
  if (command === 'skill' && action === 'install') {
    exact(2)
    await emit(
      await installSkill(
        requireValue(flags.to, '--to pointing to a skill parent directory'),
      ),
    )
    return
  }
  if (command === 'doctor') {
    exact(1)
    await emit({
      version: await packageVersion(),
      node: process.versions.node,
      nodeSupported:
        Number(process.versions.node.split('.')[0]) > 22 ||
        (Number(process.versions.node.split('.')[0]) === 22 &&
          Number(process.versions.node.split('.')[1]) >= 19),
      storage: store.root,
      reports: listReports().length,
      google: {
        savedOAuth: !!(await store.read('google-auth')),
        environmentToken: !!process.env.GWG_GOOGLE_ACCESS_TOKEN,
        serviceAccountFile: !!process.env.GOOGLE_APPLICATION_CREDENTIALS,
      },
      network: 'Not contacted',
      mcp: mcpConfig(),
    })
    return
  }
  throw new GwgError('COMMAND_UNKNOWN', 'Unknown command. Run gwg-seo --help.')
}
main().catch((error) => {
  process.stderr.write(`${encoded({ error: failure(error) })}\n`)
  process.exitCode = 1
})
