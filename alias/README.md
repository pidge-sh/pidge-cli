# Alias package

One npm package installs this CLI under another name. It is a thin wrapper —
a `package.json` whose only dependency is `pidge-cli`, and a `bin/pidge.js` that
spawns the real entry point — so the command, flags and `--version` are always
pidge-cli's own.

| Directory | npm name     | Install                     |
|-----------|--------------|-----------------------------|
| `scoped/` | `@pidge/cli` | `npm install -g @pidge/cli` |

It is published by hand, once: the dependency range is open-ended, so a new
CLI release never needs an alias release. `pidge update` knows when it is
running under the alias and refreshes the nested copy in place (see
`src/update.js`). `test/alias.test.js` runs the alias against the tree.

There is no bare `pidge` package on purpose: the registry refuses that name as
too close to names that already exist, and the refusal applies to anyone — so
there is nothing there to reserve.

None of this ships in the `pidge-cli` tarball — `files` in the root
`package.json` does not list this directory.
