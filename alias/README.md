# Alias packages

Two npm packages install this CLI under another name. Each is a thin wrapper —
a `package.json` whose only dependency is `pidge-cli`, and a `bin/pidge.js` that
spawns the real entry point — so the command, flags and `--version` are always
pidge-cli's own.

| Directory | npm name     | Install                     |
|-----------|--------------|-----------------------------|
| `pidge/`  | `pidge`      | `npm install -g pidge`      |
| `scoped/` | `@pidge/cli` | `npm install -g @pidge/cli` |

They are published by hand, once: the dependency range is open-ended, so a new
CLI release never needs an alias release. `pidge update` knows when it is
running under an alias and refreshes the nested copy in place (see
`src/update.js`). The two `bin/pidge.js` files must stay byte-identical;
`test/alias.test.js` checks that, and runs each alias against the tree.

None of this ships in the `pidge-cli` tarball — `files` in the root
`package.json` does not list this directory.
