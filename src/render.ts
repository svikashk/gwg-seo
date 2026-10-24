import { encoded, type Report } from './model.js'
export function renderReport(
  value: Report,
  format: 'json' | 'html' | 'markdown' = 'json',
) {
  if (format === 'json') return encoded(value)
  const escapeHtml = (input: string) =>
    input.replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[c] ?? c,
    )
  if (format === 'markdown')
    return `# ${value.id}\n\nGenerated: ${value.generatedAt}\n\nCoverage: ${value.coverage.status}\n\n${value.coverage.reasons.map((r) => `- ${r}`).join('\n')}\n\n${'`'.repeat(6)}json\n${encoded(value).replace(/`/g, '\\u0060')}\n${'`'.repeat(6)}\n`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(value.id)} | GWG SEO</title><style>body{margin:3rem auto;padding:0 1rem;max-width:72rem;background:#f5f3ed;color:#1b1d19;font:17px/1.6 system-ui}h1{letter-spacing:-.04em}small,pre{font-family:monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere;border-top:1px solid;padding-top:1rem}li{margin:.7rem 0}a{color:#20753c}</style></head><body><small>GET WICKED GROWTH / SEO REPORT</small><h1>${escapeHtml(value.id)}</h1><p>${escapeHtml(value.generatedAt)} · Coverage: ${escapeHtml(value.coverage.status)}</p><ul>${value.coverage.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul><h2>Observations</h2><ol>${value.findings.map((f) => `<li><strong>${escapeHtml(f.code)}</strong>: ${escapeHtml(f.observation)}<br><small>${escapeHtml(f.url)}</small><br>${escapeHtml(f.verify)}</li>`).join('')}</ol><h2>Acquired evidence</h2><pre>${escapeHtml(encoded(value.data))}</pre></body></html>`
}
