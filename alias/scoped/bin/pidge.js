#!/usr/bin/env node
'use strict';
// `pidge` is a thin alias for the `pidge-cli` package: the same CLI under the
// shorter name. Flags, behavior and `--version` all come from pidge-cli itself,
// so there is nothing to keep in sync here.
//
// It has to spawn rather than require: pidge-cli's entrypoint gates its work on
// `require.main === module`, so requiring it in-process loads the file and exits
// without running anything.
const { spawnSync } = require('node:child_process');

const entry = require.resolve('pidge-cli/bin/pidge.js');
const result = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
});

if (result.error) {
  console.error(`pidge: could not run pidge-cli (${result.error.message})`);
  process.exit(1);
}
// Died on a signal: report it the way a shell would, so Ctrl-C stays Ctrl-C.
process.exit(result.signal ? 128 + (require('node:os').constants.signals[result.signal] || 0) : result.status);
