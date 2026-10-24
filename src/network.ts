import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import ipaddr from 'ipaddr.js'
import { GwgError, integer, webUrl } from './model.js'

export type NetworkOptions = {
  allowPrivate?: boolean
  timeoutMs?: number
  maxBytes?: number
  maxRequests?: number
}
export type ResponseData = {
  url: string
  status: number
  headers: Record<string, string>
  body: string
  bytes: number
  redirects: { url: string; status: number; location: string }[]
}
export class Network {
  bytes = 0
  requests = 0
  readonly byteLimit: number
  readonly requestLimit: number
  readonly timeout: number
  constructor(readonly options: NetworkOptions = {}) {
    this.byteLimit = integer(
      options.maxBytes,
      32_000_000,
      200_000_000,
      'maxBytes',
    )
    this.requestLimit = integer(options.maxRequests, 250, 5000, 'maxRequests')
    this.timeout = integer(options.timeoutMs, 15000, 120000, 'timeoutMs')
  }
  async get(
    input: string,
    maxBody = 2_000_000,
    redirectGuard?: (url: string) => Promise<boolean>,
  ): Promise<ResponseData> {
    let url = webUrl(input)
    const redirects: ResponseData['redirects'] = []
    for (let hop = 0; hop <= 5; hop++) {
      const response = await this.once(
        url,
        Math.min(maxBody, this.byteLimit - this.bytes),
      )
      if (
        [301, 302, 303, 307, 308].includes(response.status) &&
        response.headers.location
      ) {
        if (hop === 5)
          throw new GwgError('REDIRECT_LIMIT', 'More than five redirects.')
        const next = webUrl(response.headers.location, url)
        if (redirectGuard && !(await redirectGuard(next)))
          throw new GwgError(
            'REDIRECT_BLOCKED',
            'Redirect destination is outside the allowed crawl scope or disallowed by robots.',
          )
        redirects.push({ url, status: response.status, location: next })
        url = next
      } else return { ...response, redirects }
    }
    throw new GwgError('REDIRECT_LIMIT', 'Redirect limit reached.')
  }
  private async once(
    url: string,
    limit: number,
  ): Promise<Omit<ResponseData, 'redirects'>> {
    if (this.requests >= this.requestLimit || limit <= 0)
      throw new GwgError(
        'ACQUISITION_LIMIT',
        'Network request or byte budget reached.',
      )
    this.requests++
    const u = new URL(url)
    const host = u.hostname.replace(/^\[|\]$/g, '')
    const start = Date.now()
    let dnsTimer: ReturnType<typeof setTimeout> | undefined
    const addresses = await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        dnsTimer = setTimeout(
          () =>
            reject(
              new GwgError(
                'TIMEOUT',
                'DNS resolution exceeded its time limit.',
              ),
            ),
          this.timeout,
        )
      }),
    ]).finally(() => clearTimeout(dnsTimer))
    const firstAddress = addresses[0]
    if (!firstAddress)
      throw new GwgError('DNS_FAILED', 'Host returned no addresses.')
    if (
      !this.options.allowPrivate &&
      addresses.some(
        ({ address }) => ipaddr.process(address).range() !== 'unicast',
      )
    )
      throw new GwgError(
        'PRIVATE_ADDRESS',
        'Private and special-use network destinations require allowPrivate=true.',
      )
    return new Promise((resolve, reject) => {
      const transport = u.protocol === 'https:' ? https : http
      let settled = false
      const finish = (
        error?: Error,
        value?: Omit<ResponseData, 'redirects'>,
      ) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve(value as Omit<ResponseData, 'redirects'>)
      }
      const req = transport.request(
        u,
        {
          method: 'GET',
          headers: {
            'User-Agent': 'GWG-SEO/0.1',
            Accept: 'text/html,application/xml,text/plain,application/json',
            'Accept-Encoding': 'identity',
          },
          lookup: (_hostname, opts, callback) => {
            if (opts.all) callback(null, addresses)
            else callback(null, firstAddress.address, firstAddress.family)
          },
        },
        (res) => {
          const headers: Record<string, string> = {}
          for (const [key, value] of Object.entries(res.headers))
            if (value !== undefined)
              headers[key] = Array.isArray(value) ? value.join(', ') : value
          if (
            headers['content-encoding'] &&
            headers['content-encoding'] !== 'identity'
          ) {
            finish(
              new GwgError(
                'ENCODING',
                'Server ignored identity encoding; response was not read.',
              ),
            )
            res.destroy()
            return
          }
          const chunks: Buffer[] = []
          let bytes = 0
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length
            this.bytes += chunk.length
            if (bytes > limit || this.bytes > this.byteLimit) {
              finish(
                new GwgError(
                  'BODY_LIMIT',
                  'Response exceeded the byte budget.',
                ),
              )
              res.destroy()
              req.destroy()
              return
            }
            chunks.push(chunk)
          })
          res.on('end', () =>
            finish(undefined, {
              url,
              status: res.statusCode ?? 0,
              headers,
              body: Buffer.concat(chunks).toString('utf8'),
              bytes,
            }),
          )
          res.on('error', () =>
            finish(
              new GwgError('NETWORK', 'Response ended before completion.'),
            ),
          )
          res.on('aborted', () =>
            finish(new GwgError('NETWORK', 'Response was aborted.')),
          )
        },
      )
      const timer = setTimeout(
        () => {
          finish(new GwgError('TIMEOUT', 'Request exceeded its time limit.'))
          req.destroy()
        },
        Math.max(1, this.timeout - (Date.now() - start)),
      )
      req.on('error', () =>
        finish(new GwgError('NETWORK', 'Unable to fetch the requested URL.')),
      )
      req.end()
    })
  }
}
