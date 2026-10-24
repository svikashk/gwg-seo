import { z } from 'zod'
import { auditPage, crawlSite, inspectRobots, inspectSitemap } from './crawl.js'
import {
  analytics,
  type GoogleContext,
  googleSites,
  searchConsole,
  searchOpportunities,
} from './google.js'
import { encoded, GwgError, type Report } from './model.js'
import type { NetworkOptions } from './network.js'

const url = z.string().url().max(4096),
  day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const siteInput = z.strictObject({ url })
const searchInput = z.strictObject({
  site: z.string().min(1).max(4096),
  startDate: day,
  endDate: day,
  dimensions: z
    .array(z.enum(['query', 'page', 'date', 'country', 'device']))
    .min(1)
    .max(5)
    .optional(),
  maxRows: z.number().int().min(1).max(10000).optional(),
  searchType: z.enum(['web', 'image', 'video', 'news']).optional(),
})
const definitions = {
  'page.audit': {
    description:
      'Inspect fetched HTML for titles, headings, canonicals, directives, links, images, and JSON-LD. Does not render JavaScript.',
    schema: siteInput,
  },
  'site.crawl': {
    description:
      'Crawl same-origin HTML links under page, depth, robots, request, and byte limits. Includes duplicate-title observations.',
    schema: siteInput.extend({
      maxPages: z.number().int().min(1).max(200).optional(),
      maxDepth: z.number().int().min(0).max(10).optional(),
    }),
  },
  'site.robots': {
    description:
      'Evaluate a URL against robots.txt for GWG-SEO and list declared sitemaps.',
    schema: siteInput,
  },
  'site.sitemap': {
    description:
      'Parse a single XML sitemap or index with bounded entries. Does not fetch listed URLs.',
    schema: siteInput.extend({
      maxUrls: z.number().int().min(1).max(10000).optional(),
    }),
  },
  'google.sites': {
    description:
      'List Search Console properties accessible to the configured Google identity.',
    schema: z.strictObject({}),
  },
  'google.search': {
    description:
      'Read bounded Search Console rows for explicit dates and dimensions.',
    schema: searchInput,
  },
  'google.analytics': {
    description:
      'Read GA4 organic-search landing pages with sessions, engaged sessions, and key events.',
    schema: z.strictObject({
      property: z.string().regex(/^\d{1,20}$/),
      startDate: day,
      endDate: day,
      maxRows: z.number().int().min(1).max(10000).optional(),
    }),
  },
  'search.opportunities': {
    description:
      'Prioritize Search Console rows with average positions 4-20 and a minimum impression threshold. No traffic forecasts.',
    schema: searchInput.extend({
      minImpressions: z.number().int().min(1).max(1000000000).optional(),
    }),
  },
} as const
export type ReportId = keyof typeof definitions
export type RunContext = { network?: NetworkOptions; google?: GoogleContext }
export function listReports() {
  return Object.entries(definitions).map(([id, d]) => ({
    id,
    description: d.description,
  }))
}
export function describeReport(id: string) {
  if (!Object.hasOwn(definitions, id))
    throw new GwgError('REPORT_UNKNOWN', 'Unknown report. Use reports list.')
  const d = definitions[id as ReportId]
  return {
    id,
    description: d.description,
    inputSchema: z.toJSONSchema(d.schema),
  }
}
export async function runReport(
  id: string,
  params: unknown = {},
  context: RunContext = {},
): Promise<Report> {
  if (!Object.hasOwn(definitions, id))
    throw new GwgError('REPORT_UNKNOWN', 'Unknown report. Use reports list.')
  const parsed = definitions[id as ReportId].schema.safeParse(params)
  if (!parsed.success)
    throw new GwgError(
      'INVALID_INPUT',
      parsed.error.issues
        .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
        .join('; '),
    )
  const validate = <T extends z.ZodType>(schema: T) => schema.parse(parsed.data)
  let result: Report
  switch (id as ReportId) {
    case 'page.audit':
      result = await auditPage({
        ...validate(definitions['page.audit'].schema),
        ...context.network,
      })
      break
    case 'site.crawl':
      result = await crawlSite({
        ...validate(definitions['site.crawl'].schema),
        ...context.network,
      })
      break
    case 'site.robots':
      result = await inspectRobots({
        ...validate(definitions['site.robots'].schema),
        ...context.network,
      })
      break
    case 'site.sitemap':
      result = await inspectSitemap({
        ...validate(definitions['site.sitemap'].schema),
        ...context.network,
      })
      break
    case 'google.sites':
      result = await googleSites(context.google)
      break
    case 'google.search':
      result = await searchConsole(validate(searchInput), context.google)
      break
    case 'google.analytics':
      result = await analytics(
        validate(definitions['google.analytics'].schema),
        context.google,
      )
      break
    case 'search.opportunities': {
      const { minImpressions, ...input } = validate(
        definitions['search.opportunities'].schema,
      )
      result = searchOpportunities(
        await searchConsole(input, context.google),
        minImpressions,
      )
      break
    }
  }
  encoded(result)
  return result
}
