import assert from 'node:assert/strict'
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import {
  auditPage,
  compareReports,
  crawlSite,
  importSearchCsv,
  inspectSitemap,
  installSkill,
  LocalStore,
  Network,
  renderReport,
  report,
  runReport,
} from '../dist/index.js'

let server, base, dir
const requests = []
const html = (title, body = '') =>
  `<!doctype html><html lang="en"><head><title>${title}</title><meta name="description" content="Example description"></head><body><h1>Example</h1>${body}</body></html>`
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gwg-test-'))
  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    requests.push(path)
    if (path === '/robots.txt') {
      res.end(`User-agent: *\nDisallow: /hidden\nSitemap: ${base}/sitemap.xml`)
      return
    }
    if (path === '/redirect') {
      res.writeHead(302, { Location: '/hidden' }).end()
      return
    }
    if (path === '/private-redirect') {
      res.writeHead(302, { Location: 'http://127.0.0.2/' }).end()
      return
    }
    if (path === '/big') {
      res.end('a'.repeat(10000))
      return
    }
    if (path === '/slow') {
      setTimeout(() => res.end('late'), 200)
      return
    }
    if (path === '/sitemap.xml') {
      res.setHeader('Content-Type', 'application/xml')
      res.end(
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${base}/</loc></url><url><loc>${base}/two?a=1&amp;b=2</loc></url></urlset>`,
      )
      return
    }
    if (path === '/xxe.xml') {
      res.end(
        '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><urlset><url><loc>&x;</loc></url></urlset>',
      )
      return
    }
    res.setHeader('Content-Type', 'text/html')
    if (path === '/')
      res.end(
        html(
          'Shared title',
          '<a href="/two">Two</a><a href="/hidden">Private</a><a href="/">Home</a><a href="https://elsewhere.example/">External</a><a rel="nofollow" href="/unfollowed">Skip</a>',
        ),
      )
    else if (path === '/two')
      res.end(
        html(
          'Shared title',
          '<img src="/logo.png"><script type="application/ld+json">{"@type":"Article"}</script><a href="/deep">Deep</a>',
        ),
      )
    else if (path === '/meta')
      res.end(
        html(
          'Metadata',
          '<link rel="canonical" href="/other"><meta name="robots" content="noindex"><script type="application/ld+json">bad</script><a href="javascript:alert(1)">ignore</a>',
        ),
      )
    else res.end(html('Another page'))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await rm(dir, { recursive: true, force: true })
})

test('private address access is explicit; body, redirect, and request limits are enforced', async () => {
  await assert.rejects(new Network().get(base), { code: 'PRIVATE_ADDRESS' })
  await assert.rejects(
    new Network({ allowPrivate: true }).get(`${base}/big`, 100),
    { code: 'BODY_LIMIT' },
  )
  await assert.rejects(
    new Network({ allowPrivate: true, timeoutMs: 30 }).get(`${base}/slow`),
    { code: 'TIMEOUT' },
  )
  const network = new Network({ allowPrivate: true, maxRequests: 1 })
  await network.get(base)
  await assert.rejects(network.get(base), { code: 'ACQUISITION_LIMIT' })
  await assert.rejects(
    new Network({ allowPrivate: true }).get(
      `${base}/private-redirect`,
      20000,
      async () => false,
    ),
    { code: 'REDIRECT_BLOCKED' },
  )
})
test('page observations preserve intentional directives and do not invent validity', async () => {
  const r = await auditPage({ url: `${base}/meta`, allowPrivate: true })
  assert.equal(r.data.title, 'Metadata')
  assert.equal(r.data.structuredData.invalidBlocks, 1)
  assert.equal(r.data.links.length, 0)
  assert.equal(
    r.findings.find((f) => f.code === 'indexing-directive').severity,
    'review',
  )
  assert.equal(
    r.findings.find((f) => f.code === 'canonical-target').severity,
    'review',
  )
  assert.equal(r.coverage.status, 'partial')
})
test('crawl follows bounded same-origin links, respects robots and nofollow, and reports failures', async () => {
  requests.length = 0
  const r = await crawlSite({
    url: base,
    allowPrivate: true,
    maxPages: 10,
    maxDepth: 1,
  })
  assert.equal(r.data.pages.length, 2)
  assert.equal(r.data.failures[0].code, 'ROBOTS_DISALLOWED')
  assert(!requests.includes('/hidden'))
  assert(!requests.includes('/unfollowed'))
  assert(!requests.includes('/deep'))
  assert.equal(r.findings.filter((f) => f.code === 'duplicate-title').length, 2)
  assert(r.coverage.reasons.some((r) => r.includes('Depth limit')))
  const small = await crawlSite({ url: base, allowPrivate: true, maxPages: 1 })
  assert.equal(small.data.pages.length, 1)
  assert(small.data.remaining > 0)
  await assert.rejects(
    auditPage({ url: `${base}/redirect`, allowPrivate: true }),
    { code: 'REDIRECT_BLOCKED' },
  )
})
test('sitemap parser decodes XML, caps entries, and rejects external entities', async () => {
  const r = await inspectSitemap({
    url: `${base}/sitemap.xml`,
    allowPrivate: true,
    maxUrls: 1,
  })
  assert.equal(r.data.total, 2)
  assert.equal(r.data.entries.length, 1)
  const all = await inspectSitemap({
    url: `${base}/sitemap.xml`,
    allowPrivate: true,
  })
  assert.equal(all.data.entries[1].url, `${base}/two?a=1&b=2`)
  await assert.rejects(
    inspectSitemap({ url: `${base}/xxe.xml`, allowPrivate: true }),
    { code: 'XML_DOCTYPE' },
  )
})
test('report parameters cannot enable private networking', async () => {
  await assert.rejects(
    runReport('page.audit', { url: base, allowPrivate: true }),
    { code: 'INVALID_INPUT' },
  )
  await assert.rejects(runReport('constructor', {}), { code: 'REPORT_UNKNOWN' })
  await assert.rejects(runReport('page.audit', { url: base }), {
    code: 'PRIVATE_ADDRESS',
  })
})
test('local records are private, traversal is rejected, and symlinks are not followed', async () => {
  const store = new LocalStore(join(dir, 'store'))
  await store.putProject({ name: 'demo', url: base })
  assert.equal((await store.projects()).length, 1)
  assert.equal(
    (await stat(join(store.root, 'project-demo.json'))).mode & 0o777,
    0o600,
  )
  await assert.rejects(store.write('../escape', {}), { code: 'INVALID_ID' })
  const outside = join(dir, 'outside.json')
  await writeFile(outside, '{"secret":"original"}')
  await symlink(outside, join(store.root, 'linked.json'))
  await assert.rejects(store.read('linked'), { code: 'STORE_READ' })
  await store.write('linked', { safe: true })
  assert.equal(await readFile(outside, 'utf8'), '{"secret":"original"}')
  const a = report(
      'page.audit',
      { url: base },
      ['HTML only'],
      [
        {
          code: 'title',
          url: base,
          severity: 'review',
          observation: 'missing',
          verify: 'check',
        },
      ],
    ),
    b = report('page.audit', { url: base })
  assert.equal(compareReports(a, b).absent.length, 1)
  assert.throws(
    () => compareReports(a, report('page.audit', { url: `${base}/other` })),
    { code: 'SCOPE_MISMATCH' },
  )
  const id = await store.save(a)
  assert.deepEqual(await store.read(id), a)
})
test('CSV import retains provenance, handles percent and quoted cells, and rejects malformed data', async () => {
  const path = join(dir, 'input.csv'),
    options = {
      site: 'sc-domain:example.com',
      startDate: '2026-09-01',
      endDate: '2026-09-30',
      maxRows: 1,
    }
  await writeFile(
    path,
    'Top queries,Clicks,Impressions,CTR,Position\n"example, query",10,100,10%,5.2\nanother,1,50,2%,8\n',
  )
  const r = await importSearchCsv(path, options)
  assert.equal(r.data.rows[0].keys[0], 'example, query')
  assert.equal(r.data.rows[0].ctr, 0.1)
  assert.equal(r.data.provenance.sha256.length, 64)
  assert(r.coverage.reasons.some((x) => x.includes('row limit')))
  await writeFile(
    path,
    'Query,Clicks,Impressions,CTR,Position\nexample,ten,10,10%,5\n',
  )
  await assert.rejects(importSearchCsv(path, options), { code: 'CSV_NUMBER' })
})
test('skill install is standalone and will not overwrite existing content', async () => {
  const parent = join(dir, 'skills')
  const r = await installSkill(parent)
  assert.match(
    await readFile(join(r.installed, 'SKILL.md'), 'utf8'),
    /name: gwg-seo/,
  )
  await assert.rejects(installSkill(parent), { code: 'SKILL_EXISTS' })
})
test('HTML export escapes untrusted text and prohibits external resources', () => {
  const r = report(
    'page.audit',
    { url: base, html: '<script>alert(1)</script>' },
    [],
    [
      {
        code: 'x',
        url: base,
        severity: 'review',
        observation: '<img src=x onerror=alert(1)>',
        verify: 'check',
      },
    ],
  )
  const html = renderReport(r, 'html')
  assert(!html.includes('<img'))
  assert(!html.includes('<script>'))
  assert(html.includes('&lt;script&gt;'))
  assert(html.includes("default-src 'none'"))
})
