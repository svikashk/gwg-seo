import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { parse } from 'csv-parse'
import { dateRange, type SearchRow } from './google.js'
import { GwgError, integer, report } from './model.js'

export async function importSearchCsv(
  file: string,
  options: {
    site: string
    startDate: string
    endDate: string
    maxRows?: number
  },
) {
  dateRange(options.startDate, options.endDate)
  const maxRows = integer(options.maxRows, 1000, 10000, 'maxRows')
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  let body: Buffer
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 10_000_000)
      throw new GwgError(
        'IMPORT_LIMIT',
        'Import a regular CSV file no larger than 10 MB.',
      )
    body = await handle.readFile()
  } finally {
    await handle.close()
  }
  let dimensions: string[] = []
  const parser = parse({
    bom: true,
    skip_empty_lines: true,
    max_record_size: 64000,
    columns: (headers: string[]) => {
      const names = headers.map((h) =>
        h.trim().toLowerCase().replace(/^top /, ''),
      )
      const normalized = names.map(
        (h) =>
          ({
            queries: 'query',
            pages: 'page',
            countries: 'country',
            devices: 'device',
          })[h] ?? h,
      )
      if (new Set(normalized).size !== normalized.length)
        throw new GwgError(
          'CSV_HEADERS',
          'Duplicate column names are not supported.',
        )
      dimensions = ['query', 'page', 'date', 'country', 'device'].filter((d) =>
        normalized.includes(d),
      )
      if (
        !dimensions.length ||
        ['clicks', 'impressions', 'ctr', 'position'].some(
          (h) => !normalized.includes(h),
        )
      )
        throw new GwgError(
          'CSV_HEADERS',
          'Expected at least one dimension and Clicks, Impressions, CTR, Position columns.',
        )
      return normalized
    },
  })
  const rows: SearchRow[] = []
  let capped = false
  parser.end(body)
  try {
    for await (const record of parser) {
      if (rows.length === maxRows) {
        capped = true
        break
      }
      const number = (name: string) => {
        const raw = String(record[name]).trim(),
          percent = raw.endsWith('%')
        const n = Number(raw.replace(/,/g, '').replace(/%$/, ''))
        if (!raw || !Number.isFinite(n) || n < 0 || (percent && name !== 'ctr'))
          throw new GwgError(
            'CSV_NUMBER',
            `Invalid ${name} value near row ${rows.length + 2}.`,
          )
        return percent ? n / 100 : n
      }
      const row = {
        keys: dimensions.map((d) => String(record[d])),
        clicks: number('clicks'),
        impressions: number('impressions'),
        ctr: number('ctr'),
        position: number('position'),
      }
      if (row.ctr > 1 || row.keys.some((k) => k.length > 4096))
        throw new GwgError(
          'CSV_ROW',
          'CTR must be a fraction or percent, and dimension values must be under 4096 characters.',
        )
      rows.push(row)
    }
  } catch (error) {
    if (error instanceof GwgError) throw error
    throw new GwgError(
      'CSV_FORMAT',
      'The CSV could not be parsed. Use a UTF-8 Search Console export with a header row.',
    )
  } finally {
    parser.destroy()
  }
  const reasons = [
    'Imported data was not verified against Google. Property and dates were supplied by the caller.',
    'Search Console exports can exclude anonymized queries and other rows.',
  ]
  if (capped) reasons.push('Import row limit reached.')
  return report(
    'search.import',
    {
      site: options.site,
      ...dateRange(options.startDate, options.endDate),
      dimensions,
      rows,
      provenance: {
        format: 'csv',
        sha256: createHash('sha256').update(body).digest('hex'),
        bytes: body.length,
      },
    },
    reasons,
  )
}
