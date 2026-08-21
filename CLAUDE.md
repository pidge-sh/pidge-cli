# pidge-cli — notes for agents working in this repo

## Releasing

Publishing is tag-driven. A `v*` tag runs `.github/workflows/publish.yml`, which
builds and tests, then hands the tarball to npm as a *staged* publish; the
maintainer approves it on npmjs.com. Nothing is published by a push to `main`.

The tag is created by the maintainer, from their own terminal, on purpose: it is
the deliberate act that starts a release, and no workflow creates tags. So when a
PR that bumps `version` in `package.json` merges, **remind the maintainer that
the release is not out until they tag**, and point them at the helper:

```sh
script/release-tag   # checks main is clean and current and the version is unreleased; tags; pushes
```

After the push: approve the `npm-publish` Environment in Actions if it still
requires a reviewer, then approve the package under "Staged Packages" on
npmjs.com. Then verify: `npm view pidge-cli version` and
`npm view pidge-cli@X.Y.Z dist.attestations`.

Never create, move or delete a `v*` tag yourself.

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
