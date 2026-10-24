# Release procedure

The current package has `private: true`, and the repository is private. There is
no publishing workflow. Preparing an archive does not make it public.

1. Review the replacement's implementation, evidence limits, license, README,
   privacy policy, and packed files. Run a live Google account and property smoke
   test if Google reports will be part of the release promise. Automated tests
   cover fixtures, pagination, errors, and real MCP transport, not live Google
   account permissions. Verify the CI matrix on the account's enabled runners.
2. Obtain the owner's approval of the completed replacement before changing
   repository visibility or removing the package's `private` flag. Never publish
   an unreviewed development archive.
3. Confirm the npm account owns or can publish under `getwickedgrowth`. Run
   `npm login --registry=https://registry.npmjs.org` interactively and complete
   the browser authentication. Do not save npm credentials in the repository.
4. Update the version with `npm version <version> --no-git-tag-version`. Remove
   `private: true` only in the reviewed release change. Update the README's install
   status and tarball example. Commit the release change.
5. Run `npm run release:prepare` on that exact committed checkout. Inspect the
   manifest in `release/`, compare its commit to `git rev-parse HEAD`, and retain
   the archive checksum. Verify its name and version are the intended release.
6. If the approved release includes public source, change the visibility of
   `svikashk/gwg-seo` and verify it. Then publish the exact prepared archive with
   `npm publish ./release/<archive>.tgz --access public --registry=https://registry.npmjs.org`.
   Complete any account authentication or 2FA prompts locally. Do not publish a
   directory that may have changed after validation.
7. Fetch `npm view @getwickedgrowth/seo@<version> dist.integrity` and compare it
   with the prepared manifest. Install that exact registry version into a fresh
   directory and check the CLI, library imports, MCP handshake, and skill files.
   Create the matching Git tag and GitHub release only after registry verification.
8. Restore the public installation page only with commands that work against the
   verified registry release. A GitHub source release alone is not an npm release.

Subsequent automated releases can use npm trusted publishing after it is
configured for the repository, workflow, and npm package. Follow the current
[npm trusted-publisher documentation](https://docs.npmjs.com/trusted-publishers/).
This repository currently prepares and verifies packages without storing a
publishing token or configuring an automated public release.
