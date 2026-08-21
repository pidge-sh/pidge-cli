# @pidge/cli

`@pidge/cli` is an alias for [**`pidge-cli`**](https://www.npmjs.com/package/pidge-cli) — the
same CLI, published under the `@pidge` scope. Installing it installs `pidge-cli` and puts
the `pidge` command on your PATH.

```sh
npm install -g @pidge/cli
pidge --help
```

Everything — commands, flags, docs, changelog, issue tracker — lives with `pidge-cli`:

- **Source and issues:** <https://github.com/pidge-sh/pidge-cli>
- **Security policy:** <https://github.com/pidge-sh/pidge-cli/blob/main/SECURITY.md>

Installing `pidge-cli` directly gives you the identical `pidge` command. Pick whichever
name you prefer; there is no difference in behavior.

## Versioning

The version of this alias package is not the version of the CLI. It exists so the alias
never needs republishing when the CLI releases. To see the CLI version you actually have:

```sh
pidge --version
```
