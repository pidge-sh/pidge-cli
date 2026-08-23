'use strict';
// `pidge update` — the CLI keeping ITSELF current, on a machine where "itself"
// is two installs: the global copy on PATH and the vendored copy under the
// config slot that the Agent Sessions service actually runs. A global install
// alone leaves the daemon on whatever it was born with, which is how a
// published daemon fix can be invisible to the very person who just updated.
//
// Every collaborator is injected, so nothing here reaches the network, a
// package manager, or the machine's real config slot.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

const REAL_HOME = os.homedir();
process.env.HOME = tmp('pidge-update-home-');
process.env.XDG_CONFIG_HOME = tmp('pidge-update-xdg-');
if (os.homedir() !== process.env.HOME || os.homedir() === REAL_HOME) {
  throw new Error('refusing to run: os.homedir() does not honor HOME on this platform');
}

const update = require('../src/update');

// A run of `pidge update` with everything scripted: what npm does, whether a
// daemon exists, and what version the slot holds before/after the re-vendorize.
function scenario({
  current = '0.41.0', latest = '9.9.9', manager = 'npm',
  daemon = true, slotBefore = '0.41.0', slotAfter = null, entry = '/usr/local/lib/node_modules/pidge-cli/bin/pidge.js',
  // what the copy on disk reads back AFTER the install — the update verifies
  // it now instead of trusting the manager's exit code (see the readback tests).
  installedAfter = null,
  installThrows = null, revendorThrows = null,
} = {}) {
  const runs = [];
  const said = [];
  const warned = [];
  let slot = slotBefore;
  const opts = {
    run: (cmd, args) => {
      runs.push([cmd, ...args].join(' '));
      if (cmd !== process.execPath) {
        if (installThrows) throw new Error(installThrows);
        return;
      }
      if (revendorThrows) throw new Error(revendorThrows);
      slot = slotAfter === null ? latest : slotAfter; // connect copied the new CLI into the slot
    },
    capture: (cmd, args) => { runs.push(`capture: ${[cmd, ...args].join(' ')}`); return '/usr/local/lib/node_modules\n'; },
    fetchLatest: async () => latest,
    current,
    manager,
    hasDaemon: () => daemon,
    readSlotVersion: () => slot,
    resolveGlobalEntry: () => entry,
    readInstalledVersion: () => (installedAfter === null ? latest : installedAfter),
    say: (m) => said.push(m),
    warn: (m) => warned.push(m),
  };
  return { opts, runs, said, warned, slotNow: () => slot };
}

// --- the global install itself (no daemon in the picture) -------------------

test('update: it INVOKES the package manager and reports the version it READ BACK', async () => {
  const runs = [];
  const said = [];
  const r = await update.runUpdate({
    run: (cmd, args) => runs.push([cmd, ...args].join(' ')),
    fetchLatest: async () => '9.9.9',
    current: '0.41.0',
    manager: 'npm',
    hasDaemon: () => false,
    resolveGlobalEntry: () => '/usr/local/lib/node_modules/pidge-cli/bin/pidge.js',
    readInstalledVersion: () => '9.9.9',
    say: (m) => said.push(m),
    warn: (m) => said.push(m),
  });

  assert.deepEqual(runs, ['npm i -g pidge-cli@latest'], 'the whole point is that it actually installs');
  assert.equal(r.ok, true);
  assert.equal(r.ran, true);
  assert.match(said.join('\n'), /installed pidge-cli@9\.9\.9 \(was 0\.41\.0\)/);
});

// The plain path used to claim "installed X" from the exit code alone, while
// the alias path read the copy back. Same standard for both now: a manager
// exiting 0 over an unmoved copy is the lie this closes.
test('update: a plain install that did NOT move the copy on disk is not reported as installed', async () => {
  const warns = [];
  const said = [];
  const r = await update.runUpdate({
    run: () => {}, fetchLatest: async () => '9.9.9', current: '0.41.0', manager: 'npm',
    hasDaemon: () => false,
    resolveGlobalEntry: () => '/usr/local/lib/node_modules/pidge-cli/bin/pidge.js',
    readInstalledVersion: () => '0.41.0', // npm exited 0; nothing moved
    say: (m) => said.push(m), warn: (m) => warns.push(m),
  });
  assert.equal(r.ok, false, 'exit code 0 is not a version on disk');
  assert.ok(!/installed pidge-cli@9\.9\.9/.test(said.join('\n')), 'it must never say "installed" over the old copy');
  assert.match(warns.join('\n'), /still reads 0\.41\.0 — not 9\.9\.9/);
  assert.match(warns.join('\n'), /Install it yourself/, 'and hands back the manual line');
});

test('update: a copy that cannot be read back is UNCONFIRMED, never an invented version', async () => {
  const said = [];
  const r = await update.runUpdate({
    run: () => {}, fetchLatest: async () => '9.9.9', current: '0.41.0', manager: 'bun',
    hasDaemon: () => false,
    resolveGlobalEntry: () => null, // bun has no "print the global root" verb
    readInstalledVersion: () => null,
    say: (m) => said.push(m), warn: (m) => said.push(m),
  });
  assert.equal(r.ok, true, 'unverifiable is not the same as failed — the install may well be fine');
  assert.match(said.join('\n'), /UNCONFIRMED/);
  assert.match(said.join('\n'), /pidge --version/, 'it says how to check');
  assert.ok(!/installed pidge-cli@9\.9\.9/.test(said.join('\n')), 'no version is announced that nobody read');
});

test('update: already current ⇒ no manager runs; a failed install is non-ok + the manual line', async () => {
  const runs = [];
  const current = await update.runUpdate({
    run: (cmd, args) => runs.push(cmd + args.join(' ')), fetchLatest: async () => '0.41.0',
    current: '0.41.0', manager: 'npm', hasDaemon: () => false, say: () => {}, warn: () => {},
  });
  assert.deepEqual(runs, [], 'no reinstall when there is nothing to gain');
  assert.equal(current.ran, false);
  assert.equal(current.ok, true);

  const warns = [];
  const failed = await update.runUpdate({
    run: () => { throw new Error('EACCES'); }, fetchLatest: async () => '9.9.9',
    current: '0.41.0', manager: 'npm', hasDaemon: () => false, say: () => {}, warn: (m) => warns.push(m),
  });
  assert.equal(failed.ok, false);
  assert.match(warns.join('\n'), /npm i -g pidge-cli@latest failed \(EACCES\)/);
  assert.match(warns.join('\n'), /Install it yourself/, 'a failure always hands back the manual line');
});

test('update: an unreachable registry warns and installs anyway (never blocks)', async () => {
  const runs = [];
  const warns = [];
  const r = await update.runUpdate({
    run: (cmd, args) => runs.push([cmd, ...args].join(' ')), fetchLatest: async () => null,
    current: '0.41.0', manager: 'pnpm', hasDaemon: () => false, say: () => {}, warn: (m) => warns.push(m),
  });
  assert.deepEqual(runs, ['pnpm add -g pidge-cli@latest'], 'each manager gets its own verb');
  assert.equal(r.ok, true);
  assert.match(warns.join('\n'), /could not reach the npm registry/);
});

test('update: the manager is inferred from where THIS copy lives; semver compares numerically', () => {
  assert.equal(update.detectManager('/Users/x/.npm/_npx/abc/node_modules/.bin/pidge'), 'npm');
  assert.equal(update.detectManager('/Users/x/Library/pnpm/global/5/node_modules/pidge-cli/bin/pidge.js'), 'pnpm');
  assert.equal(update.detectManager('/Users/x/.yarn/bin/pidge'), 'yarn');
  assert.equal(update.detectManager('/Users/x/.bun/install/global/node_modules/pidge-cli/bin/pidge.js'), 'bun');

  assert.equal(update.isOlder('0.28.0', '0.41.0'), true, 'the exact gap the installed base sat in');
  assert.equal(update.isOlder('0.9.0', '0.10.0'), true, 'numeric, not lexicographic');
  assert.equal(update.isOlder('0.41.0', '0.41.0'), false);
  assert.equal(update.isOlder('1.0.0', '0.41.0'), false);
  assert.equal(update.currentVersion(), require('../package.json').version);
});

// --- and the copy the daemon actually runs ----------------------------------

test('update: with a daemon installed, the global install is followed by a re-vendorize through the sanctioned path', async () => {
  const s = scenario();
  const r = await update.runUpdate(s.opts);

  assert.equal(r.ok, true);
  assert.equal(r.ran, true);
  assert.equal(r.reVendored, true);
  assert.deepEqual(s.runs, [
    'npm i -g pidge-cli@latest',
    `${process.execPath} /usr/local/lib/node_modules/pidge-cli/bin/pidge.js terminal connect --yes`,
  ], 'the copy the SERVICE runs is refreshed by the freshly installed entry point — never by a second, drifting implementation of the install');
  assert.equal(s.slotNow(), '9.9.9', 'the daemon ends on the version that was just published');
});

test('update: the success line names BOTH versions — one number has already hidden a stale daemon', async () => {
  const s = scenario();
  await update.runUpdate(s.opts);
  assert.match(s.said.join('\n'), /npm global 9\.9\.9 · daemon slot 9\.9\.9/);
  assert.equal(s.warned.length, 0, 'lined up ⇒ nothing to warn about');
});

test('update: a re-vendorize that leaves the slot BEHIND says so instead of reporting success', async () => {
  const s = scenario({ slotAfter: '0.41.0' }); // connect ran but the slot did not move
  await update.runUpdate(s.opts);
  assert.match(s.said.join('\n'), /npm global 9\.9\.9 · daemon slot 0\.41\.0/);
  assert.match(s.warned.join('\n'), /the daemon still runs 0\.41\.0 while the CLI is 9\.9\.9/);
  assert.match(s.warned.join('\n'), /pidge terminal connect --yes/, 'a warning always carries the way out');
});

test('update: NO daemon on this computer ⇒ no re-vendorize, and NOT ONE WORD about a daemon', async () => {
  const s = scenario({ daemon: false });
  const r = await update.runUpdate(s.opts);
  assert.deepEqual(s.runs, ['npm i -g pidge-cli@latest'], 'nothing is installed for a service that does not exist');
  assert.equal(r.reVendored, false);
  assert.equal(r.slot, null);
  // The update reports what it did — the global copy moved — and stops there.
  // A computer that never installed Terminals must not learn the feature exists
  // from a line explaining which half of it was skipped.
  const output = [...s.said, ...s.warned].join('\n');
  assert.match(output, /installed pidge-cli@9\.9\.9 \(was 0\.41\.0\)/, 'it still says exactly what moved');
  for (const word of [/daemon/i, /Agent Sessions/i, /slot/i, /terminal/i, /mirror/i]) {
    assert.ok(!word.test(output), `a machine without Terminals hears nothing about it (${word})`);
  }
});

test('update: a global copy that cannot be located leaves the daemon honest — non-ok, with the manual line', async () => {
  const s = scenario({ entry: null });
  const r = await update.runUpdate(s.opts);
  assert.equal(r.ok, false, 'the global moved but the daemon did not — reporting success is the lie this closes');
  assert.equal(r.reVendored, false);
  assert.deepEqual(s.runs, ['npm i -g pidge-cli@latest']);
  assert.match(s.warned.join('\n'), /still runs its old vendored copy \(0\.41\.0\)/);
  assert.match(s.warned.join('\n'), /pidge terminal connect --yes/);
});

test('update: a re-vendorize that FAILS is non-ok and names which version each side is on', async () => {
  const s = scenario({ revendorThrows: 'launchctl load failed' });
  const r = await update.runUpdate(s.opts);
  assert.equal(r.ok, false);
  assert.match(s.warned.join('\n'), /daemon re-install failed \(launchctl load failed\)/);
  assert.match(s.warned.join('\n'), /the service still runs 0\.41\.0/);
});

test('update: already current still reports the pair — a fresh CLI over a months-old daemon is the whole failure', async () => {
  const s = scenario({ current: '9.9.9', slotBefore: '0.41.0' });
  const r = await update.runUpdate(s.opts);
  assert.deepEqual(s.runs, [], 'nothing to install');
  assert.equal(r.ran, false);
  assert.equal(r.slot, '0.41.0');
  assert.match(s.said.join('\n'), /npm global 9\.9\.9 · daemon slot 0\.41\.0/);
  assert.match(s.warned.join('\n'), /the daemon still runs 0\.41\.0/);
});

// --- resolving the freshly installed copy (never a hardcoded prefix) --------

test('update: the new global entry point is resolved by ASKING the manager, and refused when it is not there', () => {
  const root = tmp('pidge-update-root-');
  const entry = path.join(root, 'pidge-cli', 'bin', 'pidge.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '#!/usr/bin/env node\n');

  const asked = [];
  const capture = (cmd, args) => { asked.push([cmd, ...args].join(' ')); return `${root}\n`; };
  assert.equal(update.globalEntryPath('npm', capture), entry);
  assert.deepEqual(asked, ['npm root -g'], 'the prefix layout differs per platform and per version manager — ask, never assemble');

  assert.equal(update.globalEntryPath('pnpm', () => `${root}\n`), entry);
  // yarn prints the folder ABOVE node_modules.
  const yarnRoot = tmp('pidge-update-yarn-');
  const yarnEntry = path.join(yarnRoot, 'node_modules', 'pidge-cli', 'bin', 'pidge.js');
  fs.mkdirSync(path.dirname(yarnEntry), { recursive: true });
  fs.writeFileSync(yarnEntry, '');
  assert.equal(update.globalEntryPath('yarn', () => yarnRoot), yarnEntry);

  assert.equal(update.globalEntryPath('npm', () => tmp('pidge-update-empty-')), null, 'a root without the package resolves to nothing');
  assert.equal(update.globalEntryPath('npm', () => { throw new Error('npm not on PATH'); }), null);
  assert.equal(update.globalEntryPath('npm', () => ''), null);
});

// --- reading the slot the service runs --------------------------------------

test('update: the slot version is read from the vendored copy, and its absence is not an error', () => {
  process.env.XDG_CONFIG_HOME = tmp('pidge-update-slot-');
  assert.equal(update.slotVersion(), null, 'no vendored copy ⇒ no version, not a throw');
  assert.equal(update.daemonSlotPresent(), false);

  const dir = path.join(process.env.XDG_CONFIG_HOME, 'pidge', 'terminal', 'cli');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'pidge.js'), '');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'pidge-cli', version: '0.44.1' }));
  assert.equal(update.daemonSlotPresent(), true, 'the vendored tree alone proves a daemon lives here');
  assert.equal(update.slotVersion(), '0.44.1');

  fs.writeFileSync(path.join(dir, 'package.json'), 'not json');
  assert.equal(update.slotVersion(), null, 'a mangled slot reads as unknown — the doctor prints that, it does not crash');
});

// --- installed under an alias (`npm i -g @pidge/cli`) ----------------------

const ALIAS = { name: '@pidge/cli', dir: '/usr/local/lib/node_modules/@pidge/cli' };

test('alias: detected ONLY at <root>/<alias>/node_modules/pidge-cli, for the alias name', () => {
  assert.deepStrictEqual(update.aliasInstall('/usr/local/lib/node_modules/@pidge/cli/node_modules/pidge-cli'), ALIAS);
  assert.deepStrictEqual(update.aliasInstall('/opt/nm/node_modules/@pidge/cli/node_modules/pidge-cli'),
    { name: '@pidge/cli', dir: '/opt/nm/node_modules/@pidge/cli' });
  // plain global install, a project's own dependency, a stranger's dependency: none is an alias
  assert.strictEqual(update.aliasInstall('/usr/local/lib/node_modules/pidge-cli'), null);
  assert.strictEqual(update.aliasInstall('/home/me/project/node_modules/pidge-cli'), null);
  assert.strictEqual(update.aliasInstall('/usr/local/lib/node_modules/some-tool/node_modules/pidge-cli'), null);
  assert.strictEqual(update.aliasInstall('/usr/local/lib/node_modules/@pidge/cli/node_modules/not-pidge-cli'), null);
  // a bare `pidge` is not an alias name: the registry does not grant it
  assert.strictEqual(update.aliasInstall('/usr/local/lib/node_modules/pidge/node_modules/pidge-cli'), null);
  // this checkout is not installed under anything
  assert.strictEqual(update.aliasInstall(), null);
});

test('alias: on npm the refresh is a nested install IN PLACE — never a second global `pidge` bin', () => {
  assert.deepStrictEqual(update.installArgv('npm', ALIAS),
    ['npm', ['--prefix', ALIAS.dir, 'i', '--no-save', '--no-package-lock', 'pidge-cli@latest']]);
  // other managers: re-add the alias; the version is read back afterwards
  assert.deepStrictEqual(update.installArgv('pnpm', ALIAS), ['pnpm', ['add', '-g', '@pidge/cli@latest']]);
  assert.deepStrictEqual(update.installArgv('yarn', ALIAS), ['yarn', ['global', 'add', '@pidge/cli@latest']]);
  // without an alias, nothing changed
  assert.deepStrictEqual(update.installArgv('npm'), ['npm', ['i', '-g', 'pidge-cli@latest']]);
  assert.strictEqual(update.manualLine('npm', ALIAS), 'npm uninstall -g @pidge/cli && npm i -g @pidge/cli');
  assert.strictEqual(update.manualLine('bun', ALIAS), 'bun remove -g @pidge/cli && bun add -g @pidge/cli');
  assert.match(update.manualLine('npm'), /npm i -g pidge-cli@latest/);
});

test('alias: the fresh entry point is the nested copy, found without asking the manager', () => {
  const root = tmp('pidge-alias-root-');
  const dir = path.join(root, '@pidge', 'cli');
  const alias = { name: '@pidge/cli', dir };
  let asked = 0;
  const capture = () => { asked++; return root; };
  assert.strictEqual(update.globalEntryPath('npm', capture, alias), null);
  const entry = path.join(dir, 'node_modules', 'pidge-cli', 'bin', 'pidge.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '');
  fs.writeFileSync(path.join(dir, 'node_modules', 'pidge-cli', 'package.json'), JSON.stringify({ version: '3.0.0' }));
  assert.strictEqual(update.globalEntryPath('npm', capture, alias), entry);
  assert.strictEqual(update.installedVersion(entry), '3.0.0');
  assert.strictEqual(asked, 0);
});

test('alias: a run under the alias refreshes in place, reads the version back, and names the alias', async () => {
  const s = scenario({ daemon: false, entry: path.join(ALIAS.dir, 'node_modules', 'pidge-cli', 'bin', 'pidge.js') });
  const r = await update.runUpdate({ ...s.opts, alias: ALIAS, readInstalledVersion: () => '9.9.9' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(s.runs, [`npm --prefix ${ALIAS.dir} i --no-save --no-package-lock pidge-cli@latest`]);
  assert.match(s.said[0], /installed pidge-cli@9\.9\.9 .* \(under the @pidge\/cli alias\)/);
});

test('alias: a refresh that leaves the nested copy behind is NOT reported as installed', async () => {
  const s = scenario({ daemon: false, manager: 'pnpm', entry: '/x/@pidge/cli/node_modules/pidge-cli/bin/pidge.js' });
  const r = await update.runUpdate({ ...s.opts, alias: ALIAS, readInstalledVersion: () => '0.41.0' });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(s.runs, ['pnpm add -g @pidge/cli@latest']);
  assert.strictEqual(s.said.length, 0, 'no success line');
  assert.match(s.warned[0], /still 0\.41\.0 after the refresh/);
  assert.match(s.warned[0], /pnpm remove -g @pidge\/cli && pnpm add -g @pidge\/cli/);
});

test('alias: a failed refresh points at reinstalling the ALIAS, not at `npm i -g pidge-cli`', async () => {
  const s = scenario({ daemon: false, installThrows: 'boom' });
  const r = await update.runUpdate({ ...s.opts, alias: ALIAS });
  assert.strictEqual(r.ok, false);
  assert.match(s.warned[0], /npm uninstall -g @pidge\/cli && npm i -g @pidge\/cli/);
  assert.doesNotMatch(s.warned[0], /npm i -g pidge-cli@latest/);
});
