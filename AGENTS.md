# Development contract

Build a local SEO toolkit from original source. Never copy another SEO
application's source, fixtures, documentation, generated bundles, or Git
objects into this repository. Use public standards and independently licensed
libraries where appropriate, retaining their notices.

Keep network acquisition and output bounded. Validate every redirect target,
respect robots rules, and keep credentials out of site requests. Report
incomplete evidence explicitly. Only claim a capability when it works and has
behavioral verification. Maintain one implementation for CLI, library, and MCP.

The owner approved public release of the completed replacement on 2026-11-16.
Never link this development checkout over a user's global command.
Before committing, run npm run check and npm run test:install.
Use temporary directories and local HTTP fixtures for tests. Do not modify
real client configuration, profiles, or credentials in tests.
