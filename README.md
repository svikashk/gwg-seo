# GWG SEO

Local website audits and search reports for the terminal, Node.js applications,
and agents with an MCP client. Reports separate observations from recommendations
and include the limits of the acquired evidence.

Requires Node.js 22.19 or newer. Website reports need no account or API key.

## Install

Install in the project where you want to use the CLI, library, or MCP server:

```sh
npm install @getwickedgrowth/seo@0.1.0
npx --no-install gwg-seo --help
npx --no-install gwg-seo audit https://www.example.com/
```

For an MCP client, run `npx --no-install gwg-seo mcp config` from that project.
It prints the configuration for this installed copy. The package is local stdio
MCP, not a hosted URL. See the MCP section below for tools and agent setup.

For a global terminal command, use `npm install --global @getwickedgrowth/seo@0.1.0`.
The package supplies `gwg-seo` and `seo`. If another package owns either command,
use the project-local installation. Do not force an overwrite. Nothing in the
package automatically edits your agent configuration or installs a global link.

## Build from source

From this repository:

```sh
npm ci
npm run check
npm run test:install
npm pack
```

Install the resulting archive in another project:

```sh
npm install /absolute/path/to/getwickedgrowth-seo-0.1.0.tgz
npx --no-install gwg-seo --help
npx --no-install gwg-seo audit https://www.example.com/
```

## Terminal use

```sh
gwg-seo start
gwg-seo audit https://www.example.com/
gwg-seo crawl https://www.example.com/ --max-pages 20 --max-depth 3
gwg-seo reports list
gwg-seo reports describe site.sitemap
gwg-seo reports run site.sitemap --url https://www.example.com/sitemap.xml
```

`start` prompts for a URL in an interactive terminal. In automation it prints
help instead of waiting for input. Commands print JSON by default. Operational
errors go to stderr as JSON with exit code 1. Observed website defects are report
findings, so a completed audit still exits 0.
Bulk crawls retain per-URL failures in a partial or unavailable report. Exit 0
means a report was produced; inspect its coverage before treating acquisition
as successful.

Save a reusable project and a baseline:

```sh
gwg-seo project add example --url https://www.example.com/ \
  --site sc-domain:example.com --property 123456789
gwg-seo crawl --project example --save
gwg-seo snapshots list
gwg-seo snapshots show <snapshot-id>
gwg-seo snapshots diff <before-id> <after-id>
gwg-seo audit --project example --format html --output ./audit.html
```

Output files are created exclusively and will not overwrite existing files.
Snapshots remain until you remove them from the local storage directory. A
snapshot comparison identifies added and absent observations; an absent finding
is not proof of a fix when the set of acquired pages changed.

## Implemented reports

| ID | Evidence |
| --- | --- |
| `page.audit` | HTTP status, title, description, H1 headings, canonical links, robots directives, links, image alt attributes, JSON-LD syntax and types |
| `site.crawl` | Same-origin HTML link discovery, per-page observations, duplicate titles, failures and acquisition limits |
| `site.robots` | Rules for GWG-SEO on the supplied URL and declared sitemaps |
| `site.sitemap` | One XML sitemap or index, with bounded URL entries |
| `google.sites` | Accessible Search Console properties |
| `google.search` | Search Console rows for explicit dates, dimensions and search type |
| `google.analytics` | GA4 organic-search landing pages, sessions, engaged sessions and key events |
| `search.opportunities` | Search rows with average position 4-20 and an impression threshold |

Use `reports describe <id>` for the exact input schema. `reports run <id>
--params '<json>'` supports every declared input. Unknown properties are rejected.

## Google data

Google integrations are a preview in 0.1.0. Automated fixtures verify requests,
pagination, errors, and OAuth callback handling; a live Google-account smoke test
has not been completed for this release. Verify access against your own property
before relying on these reports.

Bring your own Google identity. There is no shared application credential or
hosted callback service.

For browser authorization, enable the Search Console API and Google Analytics
Data API in your Google Cloud project, configure its consent screen and test
users where applicable, and download a **Desktop app** OAuth client JSON file.
Then run:

```sh
gwg-seo auth login --client /absolute/path/to/desktop-client.json
gwg-seo auth status
gwg-seo reports run google.sites
gwg-seo reports run google.search --project example \
  --start-date 2026-09-01 --end-date 2026-09-30 --max-rows 1000
gwg-seo reports run google.analytics --project example \
  --start-date 2026-09-01 --end-date 2026-09-30
```

Open the printed URL in your browser. Login uses PKCE, a random state, and an
HTTP callback bound only to `127.0.0.1` on an ephemeral port. It requests only
Search Console read access and Analytics read access. The Google identity must
have access to each requested property. See Google's
[Desktop OAuth documentation](https://developers.google.com/identity/protocols/oauth2/native-app).

For unattended use, `GOOGLE_APPLICATION_CREDENTIALS` may point to a service-account
JSON file. Grant that account access in Search Console and Analytics. A temporary
`GWG_GOOGLE_ACCESS_TOKEN` environment variable is also supported. Credential
precedence is: explicit library token, environment token, saved OAuth, then the
service-account file. No cloud metadata credentials are discovered automatically.

`auth status` reports configuration presence, not verified access. `auth logout`
removes locally saved OAuth credentials; it does not revoke Google account grants
or change environment variables. A live account authorization and property smoke
test are required before relying on a deployment's Google integration. Automated
tests use fixtures and do not prove access to your real properties.

Search Console returns top rows and may omit anonymized queries. Recent dates
may be incomplete. Analytics retains Google metadata about thresholding and other
data limitations. Do not equate Search Console clicks with Analytics sessions.
Official API references:
[Search Console](https://developers.google.com/webmaster-tools/v1/searchanalytics/query),
[Analytics](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport).

## CSV imports

```sh
gwg-seo import ./search.csv --site sc-domain:example.com \
  --start-date 2026-09-01 --end-date 2026-09-30 --save
```

Accepts UTF-8 Search Console CSV files with Clicks, Impressions, CTR, Position,
and at least one Query, Page, Date, Country, or Device column. Plural export
headers such as Top queries are accepted. CTR can be a fraction or a percent.
Imports carry a SHA-256 fingerprint. Property and dates are caller-supplied and
are not independently verified. Limits: 10 MB per file, 64 KB per CSV record,
and at most 10,000 retained rows. Spreadsheet formulas are treated as text.

## Node.js library

```js
import { auditPage, runReport, LocalStore } from '@getwickedgrowth/seo'

const audit = await auditPage({ url: 'https://www.example.com/' })
console.log(audit.coverage, audit.findings)

const crawl = await runReport('site.crawl', {
  url: 'https://www.example.com/',
  maxPages: 10,
})
const id = await new LocalStore().save(crawl)
```

The package exports TypeScript declarations and ESM entry points. CommonJS apps
can use dynamic `import()`. The library performs no CLI work on import. Google
functions accept a `GoogleContext` with an optional `LocalStore`, explicit access
token, or injected fetch implementation for integration testing. Keep tokens in
server-side code. This is a Node runtime package, not a browser bundle.

## MCP and agent skill

```sh
gwg-seo mcp config
gwg-seo mcp serve
gwg-seo skill install --to /absolute/path/to/your/agent/skills
```

`mcp config` prints a JSON `mcpServers` entry using the installed Node executable
and package path. Copy that entry into a client that supports local stdio MCP.
It does not edit the client. Clients with other configuration formats must adapt
the `command` and `args` values. Regenerate the entry if you move the installation.

`mcp serve` reserves stdout for JSON-RPC. Its three tools are `seo_reports`,
`seo_describe`, and `seo_run`. Calls share the same engine and schemas as the CLI.
The server runs one report at a time and rejects overlapping calls as busy. The
packaged skill explains evidence interpretation and tool use. Its installer
refuses to replace an existing `gwg-seo` skill directory.

## Acquisition limits and interpretation

- Default crawl: 20 attempted pages, depth 3, 250 requests, and 32 MB total.
  Maximum page count: 200; maximum depth: 10; discovery queue: 2,000 URLs.
- Each page is capped at 2 MB, each request including DNS at 15 seconds, and
  redirects at five. Library `NetworkOptions` can set bounded budgets.
- Private, loopback, link-local and special-use addresses are blocked by default.
  DNS results are checked and pinned for each request, including redirect hops.
  Use `--allow-private` only when explicitly inspecting local or private sites.
  MCP report parameters cannot grant this access; the server operator must enable it.
- Crawling respects robots rules for GWG-SEO and remains on the starting origin.
  It stops when robots policy cannot be established. `nofollow` discovery links
  are skipped. Page starts are paced at least 200 ms apart; declared crawl delays
  up to 60 seconds are honored, and longer delays stop the fetch. Sitemap reads
  list entries without crawling them.
- HTML is parsed without executing JavaScript. Page arrays and structured-data
  traversal are bounded. Noindex and canonical differences are review observations.
  H1 counts are not presented as ranking rules. JSON-LD syntax is not rich-result
  eligibility validation.
- Serialized report output is capped at 2 MB. Request fewer pages or rows when
  evidence exceeds that cap. Complete status applies only to the stated report
  scope, never to a claim that all SEO conditions have been checked.

Browser rendering, backlink databases, keyword-volume providers, automated site
edits, rank tracking, and scheduled monitoring are not implemented. No report
claims to simulate a search engine's index or ranking algorithm.

## Development and release

```sh
npm ci
npm run check
npm run test:install
npm run release:prepare
```

`release:prepare` requires a clean committed checkout, reruns checks, and writes
a tarball plus a commit-bound SHA-256 manifest under `release/`. It never publishes.
See [RELEASING.md](RELEASING.md) for the public-release procedure and
[PRIVACY.md](PRIVACY.md) for storage and network behavior.

Licensed under Apache-2.0. Dependencies retain their own licenses.
