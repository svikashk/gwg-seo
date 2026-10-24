export class GwgError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'GwgError'
  }
}
export type Finding = {
  code: string
  severity: 'error' | 'review'
  url: string
  observation: string
  verify: string
}
export type Coverage = {
  status: 'complete' | 'partial' | 'unavailable'
  reasons: string[]
}
export type Report<T = unknown> = {
  schemaVersion: 1
  id: string
  generatedAt: string
  coverage: Coverage
  data: T
  findings: Finding[]
}
export function report<T>(
  id: string,
  data: T,
  reasons: string[] = [],
  findings: Finding[] = [],
): Report<T> {
  return {
    schemaVersion: 1,
    id,
    generatedAt: new Date().toISOString(),
    coverage: {
      status: reasons.length ? 'partial' : 'complete',
      reasons: [...new Set(reasons)],
    },
    data,
    findings,
  }
}
export function integer(
  value: number | undefined,
  fallback: number,
  max: number,
  name: string,
): number {
  const n = value ?? fallback
  if (!Number.isInteger(n) || n < 1 || n > max)
    throw new GwgError(
      'INVALID_INPUT',
      `${name} must be an integer from 1 to ${max}.`,
    )
  return n
}
export function webUrl(input: string, base?: string): string {
  let u: URL
  try {
    u = new URL(input, base)
  } catch {
    throw new GwgError('INVALID_URL', 'Provide a valid HTTP or HTTPS URL.')
  }
  if (
    !['http:', 'https:'].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.href.length > 4096
  )
    throw new GwgError(
      'INVALID_URL',
      'URLs must use HTTP(S), contain no credentials, and be at most 4096 characters.',
    )
  u.hash = ''
  return u.href
}
export function encoded(value: unknown): string {
  const text = JSON.stringify(value, null, 2)
  if (Buffer.byteLength(text) > 2_000_000)
    throw new GwgError(
      'OUTPUT_LIMIT',
      'Report exceeds 2 MB. Request a smaller page or row limit.',
    )
  return text
}
export function failure(error: unknown): { code: string; message: string } {
  return error instanceof GwgError
    ? { code: error.code, message: error.message }
    : {
        code: 'FAILED',
        message:
          'The operation failed. Check connectivity, permissions, and input.',
      }
}
