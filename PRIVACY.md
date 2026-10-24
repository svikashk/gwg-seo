# Data and privacy

GWG SEO runs locally. There is no telemetry endpoint, hosted report service,
background scheduler, or automatic upload of reports.

Website reports send GET requests to the selected website, its robots.txt, and
permitted same-origin crawl links. Sitemap inspection fetches the supplied file.
Redirects are bounded and each destination receives network validation. Requests
carry a GWG-SEO user agent but no Google credentials or browser cookies. Servers
and DNS infrastructure can observe ordinary request information, including your
IP address and requested URL.

Google reports send selected property IDs, dates, dimensions, and limits to
Google APIs using your configured identity. OAuth login opens a Google consent
URL and exchanges and refreshes tokens with Google. Google responses may contain
commercially sensitive search and analytics data. Reports sent to an MCP client
may subsequently be processed or retained by that client's model or service.

Local data lives under `~/.gwg-seo`, or the directory specified by `GWG_SEO_HOME`.
Project settings, snapshots, and saved OAuth credentials use separate JSON files.
The directory uses mode 0700 and files use 0600 on systems that enforce POSIX
permissions. Credentials are not encrypted at rest. Protect your user account,
backups, and environment variables. Imported CSVs are read without being copied
into the store; explicitly saved reports contain the imported rows and a source
fingerprint. Files are not automatically expired.

`auth logout` deletes saved OAuth credentials only. Remove individual snapshot
files to delete saved reports, or remove the storage directory to clear all local
state. Google account grants must be revoked through your Google account if you
want to revoke the authorization itself. Project records and reports can contain
URLs with sensitive query strings; review them before sharing.

`skill install` writes only a new skill directory at the explicit destination.
`mcp config` prints configuration without modifying a client. HTML exports are
standalone, escape report content, and block scripts and external resources.
Package installation and updates use npm and its dependency registry according
to your npm configuration.
