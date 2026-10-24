import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  analytics,
  dateRange,
  searchConsole,
  searchOpportunities,
} from '../dist/index.js'

const opts = {
  site: 'sc-domain:example.com',
  startDate: '2026-09-01',
  endDate: '2026-09-30',
}
const row = (i) => ({
  keys: [`query ${i}`, 'https://example.com/'],
  clicks: 10,
  impressions: 1000,
  ctr: 0.01,
  position: 8,
})
test('Search Console pagination uses bounded requests and preserves non-exhaustive coverage', async () => {
  const calls = []
  const context = {
    accessToken: 'test-only-token',
    fetch: async (url, options) => {
      const body = JSON.parse(options.body)
      calls.push({ url, body })
      assert.equal(options.headers.Authorization, 'Bearer test-only-token')
      assert.equal(options.redirect, 'error')
      return Response.json({
        rows: Array.from({ length: body.rowLimit }, (_, i) =>
          row(i + body.startRow),
        ),
      })
    },
  }
  const result = await searchConsole({ ...opts, maxRows: 1500 }, context)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].body.startRow, 1000)
  assert.equal(calls[1].body.rowLimit, 500)
  assert(calls[0].url.includes('sc-domain%3Aexample.com'))
  assert.equal(result.data.rows.length, 1500)
  assert.equal(result.coverage.status, 'partial')
  assert(result.coverage.reasons.some((r) => r.includes('Row limit')))
  const opportunities = searchOpportunities(result, 500)
  assert.equal(opportunities.data.rows.length, 1500)
})
test('missing data stays empty, API errors do not become zero traffic, and dates are real', async () => {
  const empty = await searchConsole(opts, {
    accessToken: 'test-only',
    fetch: async () => Response.json({}),
  })
  assert.deepEqual(empty.data.rows, [])
  assert.equal(empty.coverage.status, 'partial')
  await assert.rejects(
    searchConsole(opts, {
      accessToken: 'test-secret',
      fetch: async () =>
        new Response('test-secret raw upstream error', { status: 403 }),
    }),
    (error) =>
      error.code === 'GOOGLE_API' && !error.message.includes('test-secret'),
  )
  assert.throws(() => dateRange('2026-02-30', '2026-03-01'), {
    code: 'INVALID_DATE',
  })
  await assert.rejects(
    searchConsole(
      { ...opts, dimensions: ['query', 'query'] },
      { accessToken: 'x' },
    ),
    { code: 'INVALID_DIMENSIONS' },
  )
})
test('Analytics request limits organic landing-page rows and retains privacy metadata', async () => {
  let request
  const r = await analytics(
    {
      property: '123456',
      startDate: opts.startDate,
      endDate: opts.endDate,
      maxRows: 10,
    },
    {
      accessToken: 'test-only',
      fetch: async (url, options) => {
        request = { url, body: JSON.parse(options.body) }
        return Response.json({
          rows: [],
          rowCount: 22,
          metadata: { subjectToThresholding: true, dataLossFromOtherRow: true },
        })
      },
    },
  )
  assert.match(request.url, /properties\/123456:runReport$/)
  assert.equal(
    request.body.dimensionFilter.filter.stringFilter.value,
    'Organic Search',
  )
  assert.equal(request.body.limit, 10)
  assert.equal(r.data.metadata.subjectToThresholding, true)
  assert(r.coverage.reasons.some((r) => r.includes('More rows')))
})

test('OAuth loopback rejects invalid state and cleans up on denied consent', async () => {
  const { loginGoogle } = await import('../dist/index.js')
  let callbackChecks
  const login = loginGoogle({
    clientId: 'test.apps.googleusercontent.com',
    clientSecret: 'test-only-secret',
    timeoutMs: 2000,
    onUrl: (value) => {
      callbackChecks = (async () => {
        const url = new URL(value)
        assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
        const endpoint = new URL(url.searchParams.get('redirect_uri'))
        assert.equal(endpoint.hostname, '127.0.0.1')
        endpoint.searchParams.set('state', 'é'.repeat(64))
        const invalid = await fetch(endpoint)
        assert.equal(invalid.status, 400)
        await invalid.text()
        endpoint.searchParams.set('state', url.searchParams.get('state'))
        endpoint.searchParams.set('error', 'access_denied')
        const denied = await fetch(endpoint)
        assert.equal(denied.status, 400)
        await denied.text()
      })()
    },
  })
  await assert.rejects(login, { code: 'OAUTH_DENIED' })
  await callbackChecks
})
