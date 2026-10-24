import { createRequire } from 'node:module'
import { setTimeout as pause } from 'node:timers/promises'

const robotsParser: typeof import('robots-parser').default = createRequire(
  import.meta.url,
)('robots-parser')

import { SaxesParser } from 'saxes'
import { inspectHtml, type Page } from './html.js'
import { failure, GwgError, integer, report, webUrl } from './model.js'
import { Network, type NetworkOptions } from './network.js'

export type CrawlOptions = NetworkOptions & {
  url: string
  maxPages?: number
  maxDepth?: number
}
export class CrawlSession {
  readonly network: Network
  private nextRequestAt = new Map<string, number>()
  private policies = new Map<string, Promise<ReturnType<typeof robotsParser>>>()
  constructor(options: NetworkOptions = {}) {
    this.network = new Network(options)
  }
  async policy(url: string) {
    const origin = new URL(url).origin
    let pending = this.policies.get(origin)
    if (!pending) {
      pending = (async () => {
        const endpoint = `${origin}/robots.txt`
        const response = await this.network.get(
          endpoint,
          512_000,
          async (target) => new URL(target).origin === origin,
        )
        if (response.status === 404 || response.status === 410)
          return robotsParser(endpoint, '')
        if (response.status !== 200)
          throw new GwgError(
            'ROBOTS_UNAVAILABLE',
            `Robots policy returned HTTP ${response.status}; crawling paused for this origin.`,
          )
        return robotsParser(endpoint, response.body)
      })()
      this.policies.set(origin, pending)
    }
    return pending
  }
  async allowed(url: string) {
    return (await this.policy(url)).isAllowed(url, 'GWG-SEO') !== false
  }
  private async beforePage(url: string) {
    const policy = await this.policy(url)
    if (policy.isAllowed(url, 'GWG-SEO') === false)
      throw new GwgError(
        'ROBOTS_DISALLOWED',
        'The URL is disallowed for GWG-SEO in robots.txt.',
      )
    const delay = Math.max(200, (policy.getCrawlDelay('GWG-SEO') ?? 0) * 1000)
    if (!Number.isFinite(delay) || delay > 60000)
      throw new GwgError(
        'CRAWL_DELAY',
        'The declared crawl delay exceeds this session’s 60-second waiting limit.',
      )
    const origin = new URL(url).origin
    await pause(Math.max(0, (this.nextRequestAt.get(origin) ?? 0) - Date.now()))
    this.nextRequestAt.set(origin, Date.now() + delay)
  }
  async page(url: string, origin: string) {
    await this.beforePage(url)
    const response = await this.network.get(url, 2_000_000, async (target) => {
      if (new URL(target).origin !== origin) return false
      try {
        await this.beforePage(target)
        return true
      } catch (error) {
        if (error instanceof GwgError && error.code === 'ROBOTS_DISALLOWED')
          return false
        throw error
      }
    })
    if (
      !/^(text\/html|application\/xhtml\+xml)(;|$)/i.test(
        response.headers['content-type'] ?? '',
      )
    )
      throw new GwgError('NOT_HTML', 'Response was not served as HTML.')
    return inspectHtml(response)
  }
}
export async function auditPage(options: CrawlOptions) {
  const url = webUrl(options.url)
  const session = new CrawlSession(options)
  const page = await session.page(url, new URL(url).origin)
  return report(
    'page.audit',
    page,
    ['Fetched HTML only; JavaScript was not executed.', ...page.truncated],
    page.findings,
  )
}
export async function crawlSite(options: CrawlOptions) {
  const start = webUrl(options.url),
    origin = new URL(start).origin
  const maxPages = integer(options.maxPages, 20, 200, 'maxPages')
  const maxDepth = options.maxDepth ?? 3
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 10)
    throw new GwgError(
      'INVALID_INPUT',
      'maxDepth must be an integer from 0 to 10.',
    )
  const session = new CrawlSession(options)
  const queue = [{ url: start, depth: 0 }],
    discovered = new Set([start]),
    completed = new Set<string>()
  const pages: Page[] = [],
    failures: { url: string; code: string; message: string }[] = []
  const reasons = [
    'Discovery uses fetched HTML links only; JavaScript, external URLs, and unlinked pages are excluded.',
  ]
  let attempted = 0,
    depthExcluded = 0,
    discoveryCapped = false
  while (queue.length && attempted < maxPages) {
    const item = queue.shift()
    if (!item) break
    if (completed.has(item.url)) continue
    attempted++
    try {
      const page = await session.page(item.url, origin)
      completed.add(item.url)
      if (completed.has(page.url) && item.url !== page.url) continue
      completed.add(page.url)
      pages.push(page)
      if (page.truncated.length)
        reasons.push('Some page evidence was truncated.')
      for (const link of page.links) {
        if (
          new URL(link.url).origin !== origin ||
          discovered.has(link.url) ||
          link.nofollow
        )
          continue
        if (item.depth >= maxDepth) {
          depthExcluded++
          continue
        }
        if (discovered.size >= 2000) {
          discoveryCapped = true
          continue
        }
        discovered.add(link.url)
        queue.push({ url: link.url, depth: item.depth + 1 })
      }
    } catch (error) {
      failures.push({ url: item.url, ...failure(error) })
      if (
        error instanceof GwgError &&
        ['ACQUISITION_LIMIT', 'BODY_LIMIT'].includes(error.code)
      ) {
        reasons.push('Network budget reached.')
        break
      }
    }
  }
  if (queue.length)
    reasons.push('Page limit or network budget left URLs unvisited.')
  if (depthExcluded) reasons.push('Depth limit excluded links.')
  if (discoveryCapped) reasons.push('Discovery stopped at 2000 URLs.')
  if (failures.length)
    reasons.push('Some URLs could not be inspected; see failures.')
  const findings = pages.flatMap((p) => p.findings)
  const byTitle = new Map<string, string[]>()
  for (const p of pages)
    if (p.title) byTitle.set(p.title, [...(byTitle.get(p.title) ?? []), p.url])
  for (const [title, urls] of byTitle)
    if (urls.length > 1)
      for (const url of urls)
        findings.push({
          code: 'duplicate-title',
          severity: 'review',
          url,
          observation: `Title shared by ${urls.length} fetched pages: ${title}`,
          verify:
            'Review intent and canonical relationships before changing titles.',
        })
  const result = report(
    'site.crawl',
    {
      start,
      limits: { maxPages, maxDepth },
      attempted,
      discovered: discovered.size,
      remaining: queue.length,
      requests: session.network.requests,
      bytes: session.network.bytes,
      pages,
      failures,
    },
    reasons,
    findings,
  )
  if (!pages.length) result.coverage.status = 'unavailable'
  return result
}
export async function inspectRobots(options: CrawlOptions) {
  const url = webUrl(options.url)
  const session = new CrawlSession(options),
    policy = await session.policy(url)
  return report(
    'site.robots',
    {
      url,
      userAgent: 'GWG-SEO',
      allowed: policy.isAllowed(url, 'GWG-SEO') !== false,
      sitemaps: policy.getSitemaps().slice(0, 50),
    },
    [
      'Rules were evaluated for GWG-SEO; other crawlers can receive different rules.',
    ],
  )
}
export async function inspectSitemap(
  options: CrawlOptions & { maxUrls?: number },
) {
  const url = webUrl(options.url),
    maxUrls = integer(options.maxUrls, 1000, 10000, 'maxUrls')
  const network = new Network(options),
    response = await network.get(url, 4_000_000)
  if (response.status !== 200)
    throw new GwgError(
      'SITEMAP_HTTP',
      `Sitemap returned HTTP ${response.status}.`,
    )
  const entries: { url: string; kind: 'page' | 'sitemap' }[] = [],
    reasons: string[] = []
  const parser = new SaxesParser({ xmlns: true }),
    stack: string[] = []
  let value = '',
    root = '',
    collecting = false,
    total = 0
  parser.on('doctype', () => {
    throw new GwgError(
      'XML_DOCTYPE',
      'Sitemap DOCTYPE declarations are not accepted.',
    )
  })
  parser.on('opentag', (tag) => {
    stack.push(tag.local)
    if (stack.length === 1) root = tag.local
    collecting = tag.local === 'loc'
    if (collecting) value = ''
  })
  parser.on('text', (text) => {
    if (collecting) value += text
  })
  parser.on('cdata', (text) => {
    if (collecting) value += text
  })
  parser.on('closetag', (tag) => {
    if (
      tag.local === 'loc' &&
      stack.length === 3 &&
      ['url', 'sitemap'].includes(stack[1] ?? '')
    ) {
      total++
      if (entries.length < maxUrls) {
        try {
          entries.push({
            url: webUrl(value.trim()),
            kind: root === 'sitemapindex' ? 'sitemap' : 'page',
          })
        } catch {
          reasons.push('Invalid URL entries were omitted.')
        }
      }
    }
    collecting = false
    stack.pop()
  })
  try {
    parser.write(response.body).close()
  } catch (error) {
    if (error instanceof GwgError) throw error
    throw new GwgError('XML_INVALID', 'The sitemap could not be parsed as XML.')
  }
  if (!['urlset', 'sitemapindex'].includes(root))
    throw new GwgError(
      'SITEMAP_FORMAT',
      'Expected a urlset or sitemapindex root element.',
    )
  if (total > maxUrls)
    reasons.push(`Retained at most ${maxUrls} of ${total} entries.`)
  if (root === 'sitemapindex')
    reasons.push('Child sitemaps are listed, not recursively fetched.')
  reasons.push('Listed URLs were not fetched or checked for indexing.')
  return report(
    'site.sitemap',
    { url: response.url, type: root, total, entries },
    reasons,
  )
}
