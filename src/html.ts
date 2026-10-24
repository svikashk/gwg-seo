import { parseHTML } from 'linkedom'
import { type Finding, webUrl } from './model.js'
import type { ResponseData } from './network.js'

export type Page = {
  url: string
  status: number
  title: string
  description: string
  language: string
  headings: string[]
  canonicals: string[]
  robots: string[]
  links: { url: string; text: string; nofollow: boolean }[]
  hreflang: { language: string; url: string }[]
  images: { total: number; missingAlt: number }
  structuredData: { types: string[]; invalidBlocks: number; blocks: number }
  wordCount: number
  bytes: number
  redirects: ResponseData['redirects']
  truncated: string[]
  findings: Finding[]
}
export function inspectHtml(response: ResponseData): Page {
  const { document } = parseHTML(response.body)
  const text = (value: string | null | undefined, max = 500) =>
    (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
  const title = text(document.querySelector('title')?.textContent)
  const description = text(
    document
      .querySelector('meta[name="description" i]')
      ?.getAttribute('content'),
  )
  let base = response.url
  try {
    const b = document.querySelector('base[href]')?.getAttribute('href')
    if (b) base = webUrl(b, base)
  } catch {}
  const truncated: string[] = []
  function collect(selector: string, limit: number) {
    const nodes = document.querySelectorAll(selector)
    if (nodes.length > limit)
      truncated.push(`${selector}: retained ${limit} of ${nodes.length}`)
    return Array.from(nodes).slice(0, limit)
  }
  const absolute = (href: string | null) => {
    try {
      return href ? webUrl(href, base) : undefined
    } catch {
      return undefined
    }
  }
  const links: Page['links'] = []
  for (const a of collect('a[href]', 400)) {
    const url = absolute(a.getAttribute('href'))
    if (url)
      links.push({
        url,
        text: text(a.textContent, 120),
        nofollow: (a.getAttribute('rel') ?? '')
          .toLowerCase()
          .split(/\s+/)
          .includes('nofollow'),
      })
  }
  const canonicals = collect('link[rel~="canonical" i]', 10)
    .map((a) => absolute(a.getAttribute('href')))
    .filter((x): x is string => !!x)
  const hreflang = collect('link[hreflang][href]', 50).flatMap((a) => {
    const url = absolute(a.getAttribute('href'))
    return url ? [{ language: text(a.getAttribute('hreflang'), 40), url }] : []
  })
  const robots = collect(
    'meta[name="robots" i],meta[name="googlebot" i]',
    20,
  ).map((a) => text(a.getAttribute('content')))
  if (response.headers['x-robots-tag'])
    robots.push(text(response.headers['x-robots-tag']))
  const structuredData = { types: [] as string[], invalidBlocks: 0, blocks: 0 }
  for (const script of collect('script[type="application/ld+json"]', 30)) {
    structuredData.blocks++
    try {
      const data: unknown = JSON.parse(script.textContent ?? '')
      const queue: unknown[] = [data]
      let visited = 0
      while (queue.length && visited++ < 1000) {
        const value = queue.shift()
        if (Array.isArray(value)) queue.push(...value.slice(0, 50))
        else if (value && typeof value === 'object') {
          const obj = value as Record<string, unknown>
          const t = obj['@type']
          for (const x of Array.isArray(t) ? t : [t])
            if (typeof x === 'string' && structuredData.types.length < 50)
              structuredData.types.push(x.slice(0, 100))
          if (obj['@graph']) queue.push(obj['@graph'])
        }
      }
      if (queue.length) truncated.push('Structured data traversal capped')
    } catch {
      structuredData.invalidBlocks++
    }
  }
  const images = document.querySelectorAll('img')
  const headings = collect('h1', 25).map((a) => text(a.textContent, 200))
  for (const el of document.querySelectorAll('script,style,noscript'))
    el.remove()
  if ((document.body?.textContent?.length ?? 0) > 200000)
    truncated.push('Body text limited to 200000 characters')
  const body = text(document.body?.textContent, 200000)
  const page: Page = {
    url: response.url,
    status: response.status,
    title,
    description,
    language: text(document.documentElement.lang, 40),
    headings,
    canonicals,
    robots,
    links,
    hreflang,
    images: {
      total: images.length,
      missingAlt: Array.from(images).filter((i) => !i.hasAttribute('alt'))
        .length,
    },
    structuredData: {
      ...structuredData,
      types: [...new Set(structuredData.types)].sort(),
    },
    wordCount: body.split(/\s+/).filter(Boolean).length,
    bytes: response.bytes,
    redirects: response.redirects,
    truncated,
    findings: [],
  }
  const add = (
    code: string,
    observation: string,
    verify: string,
    severity: Finding['severity'] = 'review',
  ) =>
    page.findings.push({ code, severity, url: page.url, observation, verify })
  if (response.status >= 400)
    add(
      'http-error',
      `HTTP ${response.status}`,
      'Request the live URL and inspect server or CDN logs.',
      'error',
    )
  if (!title)
    add(
      'title-missing',
      'No title element text found.',
      'Inspect the rendered page and set a descriptive title if this page should be searchable.',
    )
  if (!description)
    add(
      'description-missing',
      'No meta description found.',
      'Decide whether a page-specific search snippet description would help.',
    )
  if (headings.length !== 1)
    add(
      'heading-review',
      `${headings.length} H1 headings observed.`,
      'Review the heading hierarchy for readers; this count is not a ranking rule.',
    )
  if (canonicals.length > 1)
    add(
      'multiple-canonicals',
      `${canonicals.length} canonical links observed.`,
      'Check which canonical URL is intended and remove conflicting declarations.',
      'error',
    )
  if (canonicals.some((c) => c !== page.url))
    add(
      'canonical-target',
      'Canonical points to a different URL.',
      'Confirm that consolidation is intentional and inspect the destination.',
    )
  if (robots.some((r) => /\b(noindex|none)\b/i.test(r)))
    add(
      'indexing-directive',
      'A noindex or none directive was observed.',
      'Confirm the intended indexing policy before changing it.',
    )
  if (page.images.missingAlt)
    add(
      'image-alt',
      `${page.images.missingAlt} images have no alt attribute.`,
      'Add useful alternatives for meaningful images; decorative images can have empty alt.',
    )
  if (structuredData.invalidBlocks)
    add(
      'jsonld-invalid',
      `${structuredData.invalidBlocks} JSON-LD blocks could not be parsed.`,
      'Validate the JSON syntax, then separately check applicable structured-data requirements.',
      'error',
    )
  return page
}
