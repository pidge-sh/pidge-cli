'use strict';
// The alias package under alias/ (`@pidge/cli`): a manifest whose only
// dependency is pidge-cli and a bin that spawns the real entry point. What is
// checked here is the contract a consumer of `npm i -g @pidge/cli` relies on — the
// same CLI, the same exit codes, the real version — against THIS tree, by
// standing the alias up in a scratch prefix with pidge-cli linked where npm
// would have nested it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ALIASES = [
  { dir: 'scoped', name: '@pidge/cli' },
];
const pkg = require(path.join(ROOT, 'package.json'));

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
const HOME = tmp('pidge-alias-home-');
const env = { ...process.env, HOME, XDG_CONFIG_HOME: tmp('pidge-alias-xdg-'), PIDGE_URL: 'http://127.0.0.1:9' };

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

test('alias: the manifest points the `pidge` bin at a bin that depends only on pidge-cli', () => {
  for (const a of ALIASES) {
    const m = readJson(path.join(ROOT, 'alias', a.dir, 'package.json'));
    assert.strictEqual(m.name, a.name);
    assert.deepStrictEqual(m.bin, { pidge: 'bin/pidge.js' });
    assert.deepStrictEqual(Object.keys(m.dependencies), ['pidge-cli']);
    // The floor is the first CLI that understands an alias install in `pidge update`.
    assert.strictEqual(m.dependencies['pidge-cli'], '>=0.48.0');
    assert.ok(!m.scripts, `${a.name}: an alias has no lifecycle scripts`);
    assert.deepStrictEqual(m.files.sort(), ['LICENSE', 'README.md', 'bin']);
    if (a.name.startsWith('@')) assert.deepStrictEqual(m.publishConfig, { access: 'public' });
  }
});

test('alias: the bin is a plain node script that never routes argv through a shell', () => {
  const src = fs.readFileSync(path.join(ROOT, 'alias', 'scoped', 'bin', 'pidge.js'), 'utf8');
  assert.match(src, /^#!\/usr\/bin\/env node\n/);
  assert.doesNotMatch(src, /shell:\s*true/);
});

test('alias: nothing under alias/ ships in the pidge-cli tarball', () => {
  assert.ok(!pkg.files.some((f) => f === 'alias' || f.startsWith('alias/')));
});

// Stand each alias up the way a global install lays it out:
//   <prefix>/<alias>/bin/pidge.js  +  <prefix>/<alias>/node_modules/pidge-cli -> this tree
for (const a of ALIASES) {
  test(`alias ${a.name}: spawns the real CLI, forwards argv, propagates the exit code`, () => {
    const prefix = tmp('pidge-alias-prefix-');
    const home = path.join(prefix, ...a.name.split('/'));
    fs.mkdirSync(path.join(home, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(home, 'bin'));
    fs.copyFileSync(path.join(ROOT, 'alias', a.dir, 'bin', 'pidge.js'), path.join(home, 'bin', 'pidge.js'));
    fs.symlinkSync(ROOT, path.join(home, 'node_modules', 'pidge-cli'), 'dir');
    const bin = path.join(home, 'bin', 'pidge.js');

    const version = spawnSync(process.execPath, [bin, '--version'], { env, encoding: 'utf8' });
    assert.strictEqual(version.status, 0, version.stderr);
    assert.strictEqual(version.stdout.trim(), pkg.version, 'the version is pidge-cli\'s, never the alias\'s');

    const unknown = spawnSync(process.execPath, [bin, 'no-such-command', 'with space'], { env, encoding: 'utf8' });
    assert.strictEqual(unknown.status, 1, 'the CLI\'s exit code comes through unchanged');

    const help = spawnSync(process.execPath, [bin, '--help'], { env, encoding: 'utf8' });
    assert.strictEqual(help.status, 0);
    assert.match(help.stdout, /pidge/);
  });
}
