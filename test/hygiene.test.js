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

function publicFiles() {
  const files = ['bin/pidge.js', 'README.md', 'CHANGELOG.md', 'package.json'];
  for (const f of fs.readdirSync(path.join(ROOT, 'test'))) {
    if (f === SELF) continue; // this file names the forbidden patterns
    if (/\.(js|json)$/.test(f)) files.push(`test/${f}`);
  }
  for (const f of fs.readdirSync(path.join(ROOT, '.github', 'workflows'))) {
    if (/\.ya?ml$/.test(f)) files.push(`.github/workflows/${f}`);
  }
  return files.map((f) => path.join(ROOT, f));
}

// [label, pattern]. Patterns are line-oriented; keep them precise — fictional
// example content ("Review PR #42", "PO #4471") must NOT trip them.
const FORBIDDEN = [
  ['parenthesized tracker ref', /\(#\d+/],
  ['prefixed tracker ref', /\b(?:pidge|cli|server)#\d+/],
  ['PR tracker ref', /\(PR #\d+\)/],
  ['audit narration', /\bcross-audit\b/i],
  ['internal spec doc', /e2e-spec-v1/],
  ['closed-suite reference', /\bXCTest\b/],
  ['server implementation internals', /Notification::|RESERVED_ACTION_IDS|\bE2EContent\b|OPERATING_CONTRACT_KEYS|notification\.rb/],
  ['person name', /\bJavier\b/i],
  ['pre-launch codename in prose', /\bHerald\b/], // the HERALD_* env aliases stay
  ['incident date', /2026-06-13|2026-06-14/],
  ['memory-link syntax', /\[\[[a-z][a-z-]*\]\]/],
  ['dogfooding narration', /\bdogfood/i],
  ['infra provider', /\bRailway\b/],
  ['tracker ref in test title', /test\('#\d/],
  ['leading tracker-ref comment', /^\s*\/\/ ?(---+ )?#\d+\b/],
  ['internal batch name', /\blote-\d+ #\d/],
  ['issue/section tracker ref', /#\d+\/[A-Z§]/],
];

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
