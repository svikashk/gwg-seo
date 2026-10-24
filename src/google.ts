import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { GoogleAuth, OAuth2Client } from 'google-auth-library'
import { GwgError, integer, report } from './model.js'
import { LocalStore } from './store.js'

const scopes = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
]
type GoogleLogin = {
  clientId: string
  clientSecret: string
  refreshToken: string
}
export type GoogleContext = {
  store?: LocalStore
  accessToken?: string
  fetch?: typeof globalThis.fetch
}
async function token(context: GoogleContext) {
  const provided = context.accessToken ?? process.env.GWG_GOOGLE_ACCESS_TOKEN
  if (provided) return provided
  const saved = await (context.store ?? new LocalStore()).read<GoogleLogin>(
    'google-auth',
  )
  try {
    if (saved) {
      const client = new OAuth2Client({
        clientId: saved.clientId,
        clientSecret: saved.clientSecret,
        transporterOptions: { timeout: 30000, retry: false },
      })
      client.setCredentials({ refresh_token: saved.refreshToken })
      const result = await client.getAccessToken()
      if (result.token) return result.token
    }
    const file = process.env.GOOGLE_APPLICATION_CREDENTIALS
    if (file) {
      if ((await stat(file)).size > 64000) throw new Error('size')
      const credentials = JSON.parse(await readFile(file, 'utf8'))
      if (credentials.type !== 'service_account')
        throw new GwgError(
          'CREDENTIAL_TYPE',
          'GOOGLE_APPLICATION_CREDENTIALS must point to a service-account JSON file.',
        )
      const auth = new GoogleAuth({
        credentials,
        scopes,
        clientOptions: { transporterOptions: { timeout: 30000, retry: false } },
      })
      const result = await auth.getAccessToken()
      if (result) return result
    }
  } catch (error) {
    if (error instanceof GwgError) throw error
    throw new GwgError(
      'GOOGLE_AUTH',
      'Google authentication failed. Reconnect or check service-account access.',
    )
  }
  throw new GwgError(
    'GOOGLE_AUTH',
    'Run gwg-seo auth login with your Google Desktop OAuth client, set GOOGLE_APPLICATION_CREDENTIALS, or supply GWG_GOOGLE_ACCESS_TOKEN.',
  )
}
async function googleJson(
  url: string,
  body: unknown,
  context: GoogleContext,
): Promise<Record<string, unknown>> {
  const accessToken = await token(context)
  const response = await (context.fetch ?? globalThis.fetch)(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new GwgError(
      'GOOGLE_API',
      `Google returned HTTP ${response.status}. Check API enablement, property access, quotas, and date ranges.`,
    )
  }
  if (!response.body)
    throw new GwgError('GOOGLE_RESPONSE', 'Google returned an empty response.')
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > 4_000_000) {
        await reader.cancel()
        throw new GwgError(
          'GOOGLE_LIMIT',
          'Google response exceeded 4 MB. Request fewer rows.',
        )
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new Error()
    return data as Record<string, unknown>
  } catch {
    throw new GwgError('GOOGLE_RESPONSE', 'Google returned invalid JSON.')
  }
}
export async function loginGoogle(options: {
  clientId: string
  clientSecret: string
  store?: LocalStore
  onUrl: (url: string) => void
  timeoutMs?: number
}) {
  if (
    !options.clientId.endsWith('.apps.googleusercontent.com') ||
    !options.clientSecret
  )
    throw new GwgError(
      'OAUTH_CLIENT',
      'Provide a Google Desktop OAuth client ID and secret.',
    )
  const state = randomBytes(32).toString('hex'),
    verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  let callback: (code: string) => void = () => {},
    rejectCallback: (error: Error) => void = () => {}
  const server = createServer((req, res) => {
    let incoming: URL
    try {
      incoming = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      res.writeHead(400).end()
      return
    }
    if (incoming.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    const returned = incoming.searchParams.get('state') ?? ''
    if (
      !/^[a-f0-9]{64}$/.test(returned) ||
      !timingSafeEqual(Buffer.from(returned), Buffer.from(state))
    ) {
      res.writeHead(400).end('Invalid state.')
      return
    }
    const code = incoming.searchParams.get('code')
    if (!code) {
      res.writeHead(400).end('Authorization was not completed.')
      rejectCallback(
        new GwgError('OAUTH_DENIED', 'Google authorization was not completed.'),
      )
      return
    }
    res
      .writeHead(200, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store',
      })
      .end('Authorization received. Return to the terminal.')
    callback(code)
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new GwgError(
        'OAUTH_LISTENER',
        'Could not start the loopback listener.',
      )
    const redirectUri = `http://127.0.0.1:${address.port}/callback`
    const client = new OAuth2Client({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      redirectUri,
      transporterOptions: { timeout: 30000, retry: false },
    })
    const waiting = new Promise<string>((resolve, reject) => {
      callback = resolve
      rejectCallback = reject
      timer = setTimeout(
        () => reject(new GwgError('OAUTH_TIMEOUT', 'Google login timed out.')),
        options.timeoutMs ?? 180000,
      )
    })
    options.onUrl(
      client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: scopes,
        state,
        code_challenge: challenge,
        code_challenge_method:
          'S256' as import('google-auth-library').CodeChallengeMethod,
      }),
    )
    const code = await waiting
    const { tokens } = await client.getToken({
      code,
      codeVerifier: verifier,
      redirect_uri: redirectUri,
    })
    if (!tokens.refresh_token)
      throw new GwgError(
        'OAUTH_REFRESH',
        'Google did not return a refresh token. Revoke prior app access and reconnect.',
      )
    await (options.store ?? new LocalStore()).write('google-auth', {
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      refreshToken: tokens.refresh_token,
    })
    return {
      connected: true,
      requestedScopes: scopes,
      grantedScopes: tokens.scope?.split(' ') ?? [],
    }
  } catch (error) {
    if (error instanceof GwgError) throw error
    throw new GwgError(
      'OAUTH_FAILED',
      'Unable to complete Google login. Check the Desktop client configuration.',
    )
  } finally {
    clearTimeout(timer)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
export function dateRange(startDate: string, endDate: string) {
  for (const day of [startDate, endDate])
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      !Number.isFinite(Date.parse(day)) ||
      new Date(day).toISOString().slice(0, 10) !== day
    )
      throw new GwgError(
        'INVALID_DATE',
        'Use real calendar dates in YYYY-MM-DD format.',
      )
  if (startDate > endDate)
    throw new GwgError(
      'INVALID_DATE',
      'startDate must be on or before endDate.',
    )
  return { startDate, endDate }
}
export type SearchRow = {
  keys: string[]
  clicks: number
  impressions: number
  ctr: number
  position: number
}
export type SearchOptions = {
  site: string
  startDate: string
  endDate: string
  dimensions?: ('query' | 'page' | 'date' | 'country' | 'device')[]
  maxRows?: number
  searchType?: 'web' | 'image' | 'video' | 'news'
}
export async function searchConsole(
  options: SearchOptions,
  context: GoogleContext = {},
) {
  dateRange(options.startDate, options.endDate)
  if (
    !options.site.startsWith('sc-domain:') &&
    !/^https?:\/\//.test(options.site)
  )
    throw new GwgError(
      'INVALID_PROPERTY',
      'Use a Search Console URL-prefix property or sc-domain:example.com.',
    )
  const maxRows = integer(options.maxRows, 1000, 10000, 'maxRows'),
    dimensions = options.dimensions ?? ['query', 'page']
  if (
    dimensions.length < 1 ||
    dimensions.length > 5 ||
    new Set(dimensions).size !== dimensions.length ||
    dimensions.some(
      (d) => !['query', 'page', 'date', 'country', 'device'].includes(d),
    )
  )
    throw new GwgError(
      'INVALID_DIMENSIONS',
      'Choose unique query, page, date, country, or device dimensions.',
    )
  const rows: SearchRow[] = [],
    reasons = [
      'Search Console returns top rows and can omit anonymized queries. This is not an exhaustive search log.',
      'Dates use the Search Console reporting calendar; recent dates can be incomplete.',
    ]
  let requests = 0
  while (rows.length < maxRows) {
    const requested = Math.min(1000, maxRows - rows.length)
    const data = await googleJson(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(options.site)}/searchAnalytics/query`,
      {
        startDate: options.startDate,
        endDate: options.endDate,
        dimensions,
        type: options.searchType ?? 'web',
        dataState: 'final',
        rowLimit: requested,
        startRow: rows.length,
      },
      context,
    )
    requests++
    if (data.rows !== undefined && !Array.isArray(data.rows))
      throw new GwgError(
        'GOOGLE_RESPONSE',
        'Search Console rows were not an array.',
      )
    const page = (data.rows ?? []) as unknown[]
    if (page.length > requested)
      throw new GwgError(
        'GOOGLE_RESPONSE',
        'Google returned more rows than requested.',
      )
    for (const row of page) {
      const r = row as SearchRow
      if (
        !r ||
        !Array.isArray(r.keys) ||
        r.keys.length !== dimensions.length ||
        r.keys.some((k) => typeof k !== 'string' || k.length > 4096) ||
        ![r.clicks, r.impressions, r.ctr, r.position].every(
          (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0,
        )
      )
        throw new GwgError(
          'GOOGLE_RESPONSE',
          'Search Console returned a malformed row.',
        )
      rows.push({
        keys: r.keys,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      })
    }
    if (page.length < requested) break
  }
  if (rows.length === maxRows)
    reasons.push('Row limit reached; additional rows may exist.')
  return report(
    'google.search',
    {
      site: options.site,
      startDate: options.startDate,
      endDate: options.endDate,
      dimensions,
      searchType: options.searchType ?? 'web',
      requests,
      rows,
    },
    reasons,
  )
}
export async function googleSites(context: GoogleContext = {}) {
  const data = await googleJson(
    'https://www.googleapis.com/webmasters/v3/sites',
    undefined,
    context,
  )
  return report(
    'google.sites',
    {
      sites: Array.isArray(data.siteEntry) ? data.siteEntry.slice(0, 1000) : [],
    },
    Array.isArray(data.siteEntry) && data.siteEntry.length > 1000
      ? ['Site list capped at 1000.']
      : [],
  )
}
export type AnalyticsOptions = {
  property: string
  startDate: string
  endDate: string
  maxRows?: number
}
export async function analytics(
  options: AnalyticsOptions,
  context: GoogleContext = {},
) {
  dateRange(options.startDate, options.endDate)
  if (!/^\d{1,20}$/.test(options.property))
    throw new GwgError('INVALID_PROPERTY', 'Use the numeric GA4 property ID.')
  const maxRows = integer(options.maxRows, 1000, 10000, 'maxRows')
  const data = await googleJson(
    `https://analyticsdata.googleapis.com/v1beta/properties/${options.property}:runReport`,
    {
      dateRanges: [dateRange(options.startDate, options.endDate)],
      dimensions: [{ name: 'landingPagePlusQueryString' }],
      metrics: [
        { name: 'sessions' },
        { name: 'engagedSessions' },
        { name: 'keyEvents' },
      ],
      dimensionFilter: {
        filter: {
          fieldName: 'sessionDefaultChannelGroup',
          stringFilter: { matchType: 'EXACT', value: 'Organic Search' },
        },
      },
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: maxRows,
    },
    context,
  )
  if (data.rows !== undefined && !Array.isArray(data.rows))
    throw new GwgError('GOOGLE_RESPONSE', 'Analytics rows were not an array.')
  const rows = Array.isArray(data.rows) ? data.rows : []
  if (rows.length > maxRows)
    throw new GwgError(
      'GOOGLE_RESPONSE',
      'Google returned more rows than requested.',
    )
  const reasons = [
    'Organic Search landing pages only. Analytics attribution and Search Console clicks measure different events.',
  ]
  if (typeof data.rowCount === 'number' && data.rowCount > rows.length)
    reasons.push('More rows exist than were retrieved.')
  return report(
    'google.analytics',
    {
      property: options.property,
      ...dateRange(options.startDate, options.endDate),
      dimensionHeaders: data.dimensionHeaders,
      metricHeaders: data.metricHeaders,
      rows,
      totalRows: data.rowCount,
      metadata: data.metadata,
    },
    reasons,
  )
}
export function searchOpportunities(
  input: Awaited<ReturnType<typeof searchConsole>>,
  minImpressions = 100,
) {
  integer(minImpressions, 100, 1000000000, 'minImpressions')
  const rows = input.data.rows
    .filter(
      (r) =>
        r.impressions >= minImpressions && r.position >= 4 && r.position <= 20,
    )
    .sort((a, b) => b.impressions - a.impressions)
  return report(
    'search.opportunities',
    {
      site: input.data.site,
      startDate: input.data.startDate,
      endDate: input.data.endDate,
      dimensions: input.data.dimensions,
      criteria: { minImpressions, averagePosition: [4, 20] },
      rows,
    },
    [
      ...input.coverage.reasons,
      'This is a prioritization heuristic, not a forecast. Average position can hide variation across queries, countries, and devices.',
    ],
  )
}
