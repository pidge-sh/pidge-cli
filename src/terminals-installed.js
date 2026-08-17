'use strict';
// "Does this computer have Terminals installed?" — asked ONCE, answered here.
//
// The rule this module exists to enforce: the CLI only ANNOUNCES Terminals to a
// machine that installed it. On a computer with no daemon, `pidge --help`, the
// `pidge update` narration and the generated agent skill say nothing about
// panes, mirrors or Agent Sessions — a person who never asked for the feature
// never learns it exists from us. The COMMANDS stay exactly where they were:
// `pidge terminal …` typed on purpose still runs, and everything it prints is
// addressed to someone who already knows.
//
// Two functions, one fact:
//   daemonSlotPresent() — the FACT. The config the service reads, or the
//     vendored tree the service runs; either half is enough. Anything that
//     INSTALLS, copies or restarts must ask this one.
//   announceTerminals() — the fact, plus a deliberate override for development
//     and tests (PIDGE_TERMINAL_HELP=1 forces the full text on a machine with
//     no daemon). It moves TEXT only — never a side effect.

const fs = require('fs');
const path = require('path');

// The env var that forces the full text. Named after what it does — it turns
// the terminal help back on — and read nowhere but here.
const HELP_OVERRIDE_ENV = 'PIDGE_TERMINAL_HELP';

// Required lazily: every caller here runs on machines where the terminal module
// is never touched (the help renderer, the version nag, `pidge update`), and a
// broken/absent terminal tree must read as "not installed", never as a crash.
function terminalPaths() {
  const core = require('./terminal/core');
  const dir = path.join(core.terminalDir(), 'cli');
  return { dir, entry: path.join(dir, 'bin', 'pidge.js'), daemonFile: core.DAEMON_FILE() };
}

function daemonSlotPresent() {
  try {
    const p = terminalPaths();
    return fs.existsSync(p.daemonFile) || fs.existsSync(p.entry);
  } catch { return false; }
}

function announceTerminals() {
  if (process.env[HELP_OVERRIDE_ENV] === '1') return true;
  return daemonSlotPresent();
}

module.exports = { terminalPaths, daemonSlotPresent, announceTerminals, HELP_OVERRIDE_ENV };
