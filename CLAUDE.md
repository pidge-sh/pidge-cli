# pidge-cli — notes for agents working in this repo

## Releasing

Publishing is tag-driven. A `v*` tag runs `.github/workflows/publish.yml`, which
builds and tests, then hands the tarball to npm as a *staged* publish; the
maintainer approves it on npmjs.com with their passkey. That approval is the
human gate. Nothing is published by a push to `main`, and no workflow creates
tags.

**The agent cuts the tag.** A change that should ship goes out as one PR that
bumps `version` in `package.json` and adds the CHANGELOG entry (pick the bump:
patch for fixes, minor for features). Once that PR is merged, the agent runs it
from any checkout (it tags `origin/main`):

```sh
script/release-tag   # refuses unless the version is untagged and unpublished; tags origin/main; pushes
```

and then tells the maintainer the package is staged and waiting for their
approval under "Staged Packages" on npmjs.com. If the `npm-publish` Environment
still requires a reviewer, say so too — that click happens in the GitHub UI.

Then verify and report: `npm view pidge-cli version` and
`npm view pidge-cli@X.Y.Z dist.attestations`.

Never move or delete a `v*` tag; if a release run fails before publishing, the
fix ships as the next patch version with a new tag.

## A release PR

- bump `version` in `package.json` and add the CHANGELOG entry
- `npm test` — includes the hygiene, update and alias suites
- the tarball must stay reproducible: `npm pack --ignore-scripts` at the tag
  matches the registry shasum (SECURITY.md documents the check)

## Public repo

Everything here is public (GitHub and npm). No internal tracker references,
infrastructure, providers or people in code, comments, commit messages or PR
text — `test/hygiene.test.js` enforces it for the published files.

## Alias package

`alias/scoped` is `@pidge/cli`, a wrapper published by hand and almost never
re-published. See `alias/README.md`.
