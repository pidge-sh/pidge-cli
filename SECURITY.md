# Security

`pidge-cli` is published to npm as [`pidge-cli`](https://www.npmjs.com/package/pidge-cli).

## What the package contains

- **Zero runtime dependencies.** `package.json` declares no `dependencies`; the only
  `devDependency` (`ws`) is used by the test suite and is never installed by consumers.
- **Zero install scripts.** There is no `preinstall`, `install`, `postinstall` or
  `prepare` script — `npm install -g pidge-cli` writes files and runs nothing.

## How releases are published

Releases are cut by pushing a `v*` git tag, which runs
[`.github/workflows/publish.yml`](.github/workflows/publish.yml). That workflow
authenticates to npm with OIDC trusted publishing — there is no npm token stored in the
repository or in GitHub secrets. Building and publishing are separate jobs: the build job
holds no credentials and produces the tarball; the publish job is gated behind a GitHub
Environment with a required reviewer, and uploads that same tarball without rebuilding it.

## Verifying a release

### 1. Provenance

Trusted publishing attaches a signed provenance attestation linking the published tarball
to the repository, commit and workflow that produced it. To check it:

```sh
npm install pidge-cli
npm audit signatures
```

The npm package page also shows a provenance badge for releases that carry one.

Provenance covers releases published through the workflow above. Versions published before
that workflow landed have no attestation — for those, use the reproducible-build check.

### 2. Reproducible build

The published tarball is produced by a plain `npm pack` of the tagged tree, with no build
step, no code generation and no bundling. That makes it byte-for-byte reproducible: pack
the tag yourself and compare checksums with the registry.

```sh
git clone https://github.com/pidge-sh/pidge-cli
cd pidge-cli
git checkout vX.Y.Z
npm pack --ignore-scripts

# what you just built
shasum -a 1 pidge-cli-X.Y.Z.tgz

# what the registry serves
npm view pidge-cli@X.Y.Z dist.shasum
```

The two SHA-1 values must be identical. SHA-1 is simply what the registry records as
`dist.shasum`; the same tarball is also covered by a SHA-512, if you would rather compare
that:

```sh
echo "sha512-$(openssl dgst -sha512 -binary pidge-cli-X.Y.Z.tgz | openssl base64 -A)"
npm view pidge-cli@X.Y.Z dist.integrity
```

If the checksums differ, the tarball on the registry is not the tagged source. Please
report it through the channel below rather than opening a public issue.

### 3. Reading the code

The package ships only `bin/`, `src/`, and the three documents listed in the `files` field
of `package.json`. Everything in the tarball is readable JavaScript:

```sh
npm pack pidge-cli
tar -tzf pidge-cli-X.Y.Z.tgz
```

## Reporting a vulnerability

Report privately through GitHub Security Advisories:

**<https://github.com/pidge-sh/pidge-cli/security/advisories/new>**

Please do not open a public issue for a suspected vulnerability. Include the version, the
platform, and a reproduction if you have one. You will get an acknowledgement, and a fix
or an explanation of why it is not one.
