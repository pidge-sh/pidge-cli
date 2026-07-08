'use strict';
// Repo hygiene guard. Everything in this repo is public (GitHub + npm), so the
// files must stay free of internal-tracker archaeology: issue/PR numbers,
// internal spec/doc names, incident narration, infra/provider details, people.
// Behavior docs ("why" comments, contracts, caveats) are welcome — anchors to
// private context are not. If this test fails, rewrite the line to describe the
// behavior itself instead of pointing at where it came from.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SELF = path.basename(__filename);
const PRIVATE_PATTERNS = '.hygiene-private-patterns.json'; // untracked, never published

function publicFiles() {
  const files = ['bin/pidge.js', 'README.md', 'CHANGELOG.md', 'package.json'];
  for (const f of fs.readdirSync(path.join(ROOT, 'test'))) {
    if (f === SELF) continue; // this file names the forbidden patterns
    if (f === PRIVATE_PATTERNS) continue; // untracked local-only pattern source
    if (/\.(js|json)$/.test(f)) files.push(`test/${f}`);
  }
  for (const f of fs.readdirSync(path.join(ROOT, '.github', 'workflows'))) {
    if (/\.ya?ml$/.test(f)) files.push(`.github/workflows/${f}`);
  }
  return files.map((f) => path.join(ROOT, f));
}

// [label, pattern]. Patterns are line-oriented; keep them precise — fictional
// example content ("Review PR #42", "PO #4471") must NOT trip them.
//
// Only generic, structural patterns live here: this file is itself published, so
// it must not become an index of the very things it hides. Anything whose literal
// value would leak just by being written here (people, codenames, incident dates,
// infra providers) lives in an untracked private file, loaded below.
const FORBIDDEN = [
  ['parenthesized tracker ref', /\(#\d+/],
  ['prefixed tracker ref', /\b(?:pidge|cli|server)#\d+/],
  ['PR tracker ref', /\(PR #\d+\)/],
  ['audit narration', /\bcross-audit\b/i],
  ['internal spec doc', /e2e-spec-v1/],
  ['closed-suite reference', /\bXCTest\b/],
  ['namespaced server class', /\b[A-Z][a-zA-Z]+::[A-Z]/],
  ['server source file', /\b[a-z_]+\.rb\b/],
  ['memory-link syntax', /\[\[[a-z][a-z-]*\]\]/],
  ['dogfooding narration', /\bdogfood/i],
  ['tracker ref in test title', /test\('#\d/],
  ['leading tracker-ref comment', /^\s*\/\/ ?(---+ )?#\d+\b/],
  ['internal batch name', /\blote-\d+ #\d/],
  ['issue/section tracker ref', /#\d+\/[A-Z§]/],
];

// Optional local-only patterns for values that can't be named in a public file.
// Absent on the public CI checkout — the generic guards above still run; the
// maintainer's working copy carries the file and gets the full sweep.
try {
  const raw = fs.readFileSync(path.join(ROOT, 'test', PRIVATE_PATTERNS), 'utf8');
  for (const { label, source, flags } of JSON.parse(raw)) {
    FORBIDDEN.push([label, new RegExp(source, flags || '')]);
  }
} catch { /* no private patterns on this checkout — generic guards still apply */ }

test('public files carry no internal references', () => {
  const offenders = [];
  for (const file of publicFiles()) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const [label, re] of FORBIDDEN) {
      lines.forEach((line, i) => {
        if (re.test(line)) {
          offenders.push(`${path.relative(ROOT, file)}:${i + 1} [${label}] ${line.trim().slice(0, 120)}`);
        }
      });
    }
  }
  assert.equal(offenders.length, 0, `internal references leaked into public files:\n${offenders.join('\n')}`);
});

test('bin/pidge.js parses cleanly (node --check)', () => {
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'bin', 'pidge.js')]);
});

test('--version matches package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const out = execFileSync(process.execPath, [path.join(ROOT, 'bin', 'pidge.js'), '--version'], { encoding: 'utf8' });
  assert.equal(out.trim(), pkg.version);
});
