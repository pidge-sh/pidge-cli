'use strict';
// ============================================================================
// THE RATCHET on what an AI agent reads with its context window every session.
//
// NEVER DELETE A FACT TO MAKE A NUMBER. If a number and the truth conflict, the
// number moves and the commit says why. Dense prose is the target; information
// never is. A fact with no other home stays where it is — write that down here
// and stop.
//
// The two costs are not the same cost. The manifest is ACUTE: paid once, when an
// agent fetches it. This tree is RECURRING: SKILL.md is paid IN FULL every
// session the skill triggers, by every agent on the machine. That is why the
// core has the tightest ceiling and the references — which the harness loads
// only when their trigger fires — have looser ones.
//
// THE CEILINGS ONLY GO DOWN. Raising one is not a fix, it is the bug. The gate
// also fails when a file SHRANK well past its number without the number coming
// down (a diet nobody ratcheted is a diet that grows back) and when a budgeted
// file DISAPPEARS (moving content out of the tree is not a saving if the fact
// went with it — that is what the generator tests are for).
//
// Measured against a RECORDED manifest body (test/manifest_fixtures.json), so
// the numbers are reproducible and do not drift with a live server's channel
// state. The generated blocks are real: the whole `notes` array, the whole
// `cli.output` string, the whole `profiles.decision_table`.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: rawSpawn } = require('node:child_process');
const { track } = require('./spawn-tracker');
const spawn = (cmd, args, opts = {}) => track(rawSpawn(cmd, args, { ...opts, detached: true }));
const { createMock } = require('./mock-server');

const CLI = path.join(__dirname, '..', 'bin', 'pidge.js');
const FIXTURES = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest_fixtures.json'), 'utf8'));

// The core's ceiling is the one number in this file that was chosen rather than
// measured: everything on the shortest path from "the skill just triggered" to
// "a correct send, and the answer read back", and nothing else, fits 6 KiB.
const CORE_MAX = 6144;

// Per reference file. Each is loaded ONLY when its trigger fires, so these buy
// depth — but "move it to a reference" must never become "write twice as much",
// which is what TOTAL_MAX is for.
const REFERENCE_MAX = {
  answers: 5000,
  approvals: 3200,
  contract: 6000,
  identity: 1500,
  live: 1700,
  loop: 6400,
  'multi-runtime': 5100,
  runs: 1300,
  send: 3400,
  typing: 1300,
};

// The whole `pidge` skill: core + every reference.
//
// WHY NOT 30 KB. That was the target, and it is not reachable without deleting
// facts, so by the rule at the top of this file the number moved and here is the
// why. The predecessor was ONE 38 KB file. Folding its writing doctrine into the
// `pidge-report` companion was checked line by line, and most of it did not
// belong there: banner-vs-detail mechanics, attachment rules and full runnable
// commands are TRANSPORT facts, not "how to word a report". They stayed, in
// `references/send.md`. Splitting also has a fixed price — a title, a spec
// pointer and a trailer per file. The recurring cost, which is the one an agent
// actually pays every session, fell from 38 159 B to under 6 144 B.
// Measured 39 975 B; the ceiling carries a little slack because the generated
// base URL rides the core twice and every reference footer once, so the tree
// breathes a few dozen bytes with the host it was generated against.
const TOTAL_MAX = 40500;

// The companion writing skill has its own trigger and its own recurring cost.
const REPORT_MAX = 7100;

// A file more than this far UNDER its ceiling means the ceiling is stale: bring
// it down in the same commit that made the file smaller.
const SLACK = 700;

function installOnce() {
  return new Promise((resolve) => {
    const mock = createMock();
    mock.start().then((port) => {
      mock.state.manifestBody = FIXTURES.v123;
      mock.state.manifestVersion = FIXTURES.v123.manifest_version;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-budget-'));
      const child = spawn(process.execPath, [CLI, 'skill', 'install'], {
        cwd: dir,
        env: {
          ...process.env,
          PIDGE_URL: `http://127.0.0.1:${port}`,
          PIDGE_TOKEN: 'hld_test',
          XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'skill-budget-xdg-')),
          HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'skill-budget-home-')),
        },
      });
      let stderr = '';
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('exit', async (code) => { await mock.stop(); resolve({ code, stderr, dir }); });
    });
  });
}

const bytes = (p) => Buffer.byteLength(fs.readFileSync(p, 'utf8'), 'utf8');

test('the installed skill tree is within budget — and no ceiling is stale', async () => {
  const { code, stderr, dir } = await installOnce();
  assert.equal(code, 0, `the install itself must succeed: ${stderr}`);
  const skillDir = path.join(dir, '.claude', 'skills', 'pidge');

  const core = bytes(path.join(skillDir, 'SKILL.md'));
  assert.ok(core <= CORE_MAX,
    `SKILL.md is ${core} B, over its ${CORE_MAX} B ceiling by ${core - CORE_MAX}. This file is read IN FULL every session the skill triggers. Move a block into references/<manifest-section>.md and give it a trigger in the index — do NOT raise this number, and do NOT delete the fact.`);

  const refDir = path.join(skillDir, 'references');
  const installed = fs.readdirSync(refDir).map((f) => f.replace(/\.md$/, '')).sort();
  let total = core;
  for (const name of installed) {
    const size = bytes(path.join(refDir, `${name}.md`));
    total += size;
    // A file the ratchet does not know about is a file nobody is watching.
    assert.ok(REFERENCE_MAX[name] !== undefined || name === 'agent-sessions',
      `references/${name}.md has no ceiling. Add one here (measured, then rounded up a little) in the same commit that created the file.`);
    const max = REFERENCE_MAX[name];
    if (max === undefined) continue;
    assert.ok(size <= max, `references/${name}.md is ${size} B, over its ${max} B ceiling by ${size - max}.`);
    assert.ok(size >= max - SLACK,
      `references/${name}.md is ${size} B against a ${max} B ceiling — it SHRANK and the number did not follow. Lower it to about ${size + 100} here.`);
  }
  // A budgeted file that vanished is not a saving until the generator tests
  // prove its facts landed somewhere else.
  for (const name of Object.keys(REFERENCE_MAX)) {
    assert.ok(installed.includes(name), `references/${name}.md is budgeted but was not installed — if it was merged away, delete its ceiling in the same commit.`);
  }

  assert.ok(total <= TOTAL_MAX,
    `the installed pidge skill totals ${total} B, over ${TOTAL_MAX} B by ${total - TOTAL_MAX}. Moving prose into a reference is not a licence to write more of it.`);

  const report = bytes(path.join(dir, '.claude', 'skills', 'pidge-report', 'SKILL.md'));
  assert.ok(report <= REPORT_MAX, `the pidge-report companion is ${report} B, over ${REPORT_MAX} B.`);

  // Printed so a reviewer can read the shape of the diet off the run itself.
  console.log(`skill budget — core ${core}/${CORE_MAX} · references ${total - core} · total ${total}/${TOTAL_MAX} · companion ${report}/${REPORT_MAX}`);
});

test('the core is a CORE — the blocks it must carry, and the ones it must not', async () => {
  const { code, dir, stderr } = await installOnce();
  assert.equal(code, 0, stderr);
  const core = fs.readFileSync(path.join(dir, '.claude', 'skills', 'pidge', 'SKILL.md'), 'utf8');

  // A byte ceiling alone would be satisfied by an empty file. These are the
  // blocks that make the cut safe.
  for (const [what, re] of [
    ['the frontmatter marker, inside the fences', /^---\n[\s\S]*?\n# pidge-skill rev=\d+ manifest=\d+\n---\n/],
    ['the picker', /## THE PICKER/],
    ['the response axis', /## The response axis/],
    ['the profile table, generated', /## How it intrudes/],
    ['the minimum for reading an answer back', /## Getting the answer/],
    ['the version handshake', /## The version handshake[\s\S]*X-Pidge-Manifest-Version/],
    ['the reference index', /## References — `references\/<name>\.md`/],
    ['the pointer at the live contract', /## Full spec[\s\S]*\?sections=/],
    ['the trailer', /<!-- pidge-skill-end -->\n$/],
  ]) {
    assert.match(core, re, `the core lost ${what}`);
  }

  // And the depth belongs in the references, not here.
  for (const [what, re] of [
    ['the gold examples', /Weekly metrics ready/],
    ['the always-on loop recipe', /--exec/],
    ['the bridge', /pidge bridge/],
    ['the approval two-paths essay', /ack_requires_biometric/],
    ['the voice-note rules', /whisper/],
  ]) {
    assert.ok(!re.test(core), `${what} is back in the core — it belongs behind a trigger`);
  }
});
