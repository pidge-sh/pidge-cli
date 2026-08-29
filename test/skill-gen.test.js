'use strict';
// The SKILL.md GENERATOR, against recorded manifest bodies — and the conditional
// GET that keeps re-reading the contract free.
//
// WHY A RECORDED BODY. The contract this generator consumes lives in ANOTHER
// repo. Two green suites on two sides of a wire have proved nothing before: a
// field the client branches on stopped being served, both suites stayed green,
// and the client read the absence as "feature off" rather than as an error. So
// the fixtures here are the real thing — `test/manifest_fixtures.json` carries a
// sectioned body (a CORE plus `?sections=` on demand, with the `sections` index)
// and a pre-sectioned one (everything inlined at the top level), and every test
// below asserts the generated TREE, not the generator's intentions.

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
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function run(args, port, { cwd, env = {} } = {}) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd,
    env: {
      ...process.env,
      PIDGE_URL: `http://127.0.0.1:${port}`,
      PIDGE_TOKEN: 'hld_test',
      // Isolate BOTH: the config dir (where state.json and the manifest cache
      // live) and HOME (the second self-heal candidate).
      XDG_CONFIG_HOME: tmp('skillgen-xdg-'),
      HOME: tmp('skillgen-home-'),
      ...env,
    },
  });
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

// Everything the install left on disk, keyed the way an agent would reach it.
function tree(dir) {
  const skillDir = path.join(dir, '.claude', 'skills', 'pidge');
  const core = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  const refs = {};
  const refDir = path.join(skillDir, 'references');
  if (fs.existsSync(refDir)) {
    for (const f of fs.readdirSync(refDir).sort()) refs[f.replace(/\.md$/, '')] = fs.readFileSync(path.join(refDir, f), 'utf8');
  }
  return { core, refs, all: [core, ...Object.values(refs)].join('\n') };
}

async function mockOn(fixture, mutate) {
  const mock = createMock();
  const port = await mock.start();
  mock.state.manifestBody = JSON.parse(JSON.stringify(FIXTURES[fixture]));
  mock.state.manifestVersion = FIXTURES[fixture].manifest_version;
  if (mutate) mutate(mock.state);
  return { mock, port };
}

// --- the partition ---------------------------------------------------------

test('generator: a sectioned manifest yields a CORE plus references, one per manifest section', async () => {
  const { mock, port } = await mockOn('v123');
  const dir = tmp('skillgen-');
  const r = await run(['skill', 'install'], port, { cwd: dir });
  await mock.stop();
  assert.equal(r.code, 0, r.stderr);

  const { core, refs } = tree(dir);
  assert.match(core, /# pidge-skill rev=\d+ manifest=123\n/, 'the marker carries the served version');
  assert.match(core, /^---\n/, 'the frontmatter still opens on line 1');
  assert.ok(core.trimEnd().endsWith('<!-- pidge-skill-end -->'), 'and the trailer still closes it');

  // Every reference file is named after the manifest section it mirrors — the
  // one exception is `runs`, which no manifest section documents at all.
  for (const name of ['identity', 'send', 'approvals', 'contract', 'answers', 'loop', 'multi-runtime', 'live', 'typing', 'runs']) {
    assert.ok(refs[name], `references/${name}.md`);
  }
  // The index is the core's half of the deal: one line per file, and the line is
  // a TRIGGER (a condition an agent can check), not a feature name.
  const index = core.split('## References')[1].split('## Full spec')[0];
  for (const name of Object.keys(refs)) {
    assert.match(index, new RegExp(`\\*\\*${name}\\*\\* — \\S`), `the index gives ${name} a trigger`);
  }
  assert.match(index, /pidge-report/, 'and points at the companion writing skill');

  // On a sectioned server the reference footers point at the exact `?sections=`
  // call — and never ask for a section that is already in the core.
  assert.match(refs.live, /\?sections=live_activity/, 'an on-demand mirror is fetched by name');
  assert.match(refs['multi-runtime'], /\?sections=multi_runtime,handoff/, 'two sections ride ONE call');
  assert.ok(!/\?sections=/.test(refs.contract), '`notes` is core — never spend a call on it');
  assert.ok(!/sections=all/.test(tree(dir).all), 'the generator never asks for everything');
});

test('generator: a PRE-SECTIONED server (which inlines everything) takes the single-fetch path', async () => {
  const { mock, port } = await mockOn('v119');
  const dir = tmp('skillgen-old-');
  const r = await run(['skill', 'install'], port, { cwd: dir });
  await mock.stop();
  assert.equal(r.code, 0, r.stderr);

  // ONE call, and no `?sections=` on it: that server would ignore the parameter
  // and hand back the whole document, N times over.
  assert.equal(mock.state.manifestReads.length, 1, 'exactly one manifest read');
  assert.ok(!/sections=/.test(mock.state.manifestReads[0].url), 'and it named no sections');

  const { core, refs } = tree(dir);
  assert.match(core, /manifest=119\n/);
  // It documents its sections at the top level, so the footers point at the
  // plain manifest — never at a `?sections=` the server cannot honour.
  assert.match(refs.live, /curl http:\/\/127\.0\.0\.1:\d+\/api\/v1\/manifest -H/, 'no ?sections= against a server without it');
  assert.match(refs.live, /`live_activity`/, 'but the section is still named');
});

test('generator: a section this server does NOT document produces an honest line, never an empty file', async () => {
  // The legacy mock body knows five keys and nothing else — so most mirrors are
  // simply absent. An agent must be able to tell "nothing to say" apart from
  // "your server is older than this skill".
  const mock = createMock();
  const port = await mock.start();
  const dir = tmp('skillgen-thin-');
  const r = await run(['skill', 'install'], port, { cwd: dir });
  await mock.stop();
  assert.equal(r.code, 0, r.stderr);

  const { refs } = tree(dir);
  assert.match(refs.live, /does not document `live_activity`/, 'the absence is stated out loud');
  assert.match(refs.live, /for what it does document/, 'and the reader is told where to look instead');
  assert.match(refs.live, /pidge live/, 'the CLI doctrine is still there — the file is never empty');
  // `runs` mirrors nothing at all, so it claims nothing at all.
  assert.ok(!/does not document/.test(refs.runs), 'the orphan makes no claim about the server');
});

// --- the four fields the generator reads (and the one it must NOT touch) ----

test('generator: a manifest missing a field it BRANCHES ON refuses to write, and leaves the old skill alone', async () => {
  for (const [drop, expected] of [
    [(m) => { delete m.notes; }, /notes/],
    [(m) => { delete m.cli; }, /cli\.output/],
    [(m) => { delete m.profiles.decision_table; }, /profiles\.decision_table/],
    [(m) => { delete m.manifest_version; }, /manifest_version/],
  ]) {
    const { mock, port } = await mockOn('v123', (st) => drop(st.manifestBody));
    const dir = tmp('skillgen-hole-');
    // A COMPLETE skill already on disk. An old complete one beats a fresh hollow one.
    const file = path.join(dir, '.claude', 'skills', 'pidge', 'SKILL.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'THE SKILL THAT WAS ALREADY HERE\n');

    const r = await run(['skill', 'install'], port, { cwd: dir });
    await mock.stop();
    assert.equal(r.code, 2, `a hole must fail loudly, got ${r.code}: ${r.stderr}`);
    assert.match(r.stderr, expected, 'the missing key is NAMED');
    assert.match(r.stderr, /refusing to write a skill with holes in it/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'THE SKILL THAT WAS ALREADY HERE\n', 'nothing was written');
  }
});

test('generator: the field paths are exactly the ones the server pins — assert them on the source', () => {
  // The other half of the pin lives in the server repo, which names these same
  // literal call sites. If this list changes, that gate changes in the same breath.
  const src = fs.readFileSync(CLI, 'utf8');
  for (const expr of [
    '(m.profiles && m.profiles.decision_table)',
    'm.notes || []',
    '(m.cli && m.cli.output)',
    'm.manifest_version',
  ]) {
    assert.ok(src.includes(expr), `the generator still reads ${expr}`);
  }
  // The FIFTH field is read on a different code path, by `terminal connect`, and
  // it must keep its silent fallback: throwing there would break connect against
  // every server older than the deploy that introduced the key.
  const terminal = fs.readFileSync(path.join(__dirname, '..', 'src', 'terminal', 'commands.js'), 'utf8');
  assert.ok(terminal.includes('manifest.agent_sessions && manifest.agent_sessions.limits'), 'caps are still read from the manifest');
  assert.ok(terminal.includes('DEFAULT_CAPS'), 'and still fall back instead of throwing');
  assert.ok(!/refusing to write a skill/.test(terminal), 'the generator\'s loud failure never leaked onto the caps path');
});

test('generator: an unrecognized section name echoed back FAILS the install instead of losing a file quietly', async () => {
  const { mock, port } = await mockOn('v123', (st) => {
    // The server ignores a name it does not know and echoes it. Silence here is
    // how a generated document quietly loses a section.
    st.manifestBody.sections.not_recognized = ['live_activty'];
  });
  const dir = tmp('skillgen-typo-');
  const r = await run(['skill', 'install'], port, { cwd: dir });
  await mock.stop();
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /did not recognize the manifest section\(s\) live_activty/);
  assert.ok(!fs.existsSync(path.join(dir, '.claude')), 'and nothing was written');
});

test('generator: the self-heal can NEVER throw, even when the manifest is a hole', async () => {
  // installSkill is reachable from a refresh that runs on EVERY command. An
  // exception there would turn a doctrine refresh into a broken CLI.
  const { mock, port } = await mockOn('v123', (st) => { delete st.manifestBody.notes; });
  const dir = tmp('skillgen-heal-');
  const file = path.join(dir, '.claude', 'skills', 'pidge', 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '---\nname: pidge\n# pidge-skill rev=1 manifest=1\n---\n\nSTALE\n\n<!-- pidge-skill-end -->\n');

  const r = await run(['whoami'], port, { cwd: dir, env: { HOME: dir } });
  await mock.stop();
  assert.equal(r.code, 0, `whoami must still work: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).channel.name, 'mock', 'the command the user actually ran produced its answer');
  assert.match(fs.readFileSync(file, 'utf8'), /STALE/, 'and the incomplete regeneration was not written');
});

// --- the conditional GET ---------------------------------------------------

test('etag: the second install revalidates and gets a 304, and the tree is byte-identical', async () => {
  const { mock, port } = await mockOn('v123');
  const cfg = tmp('skillgen-cfg-'); // ONE config dir across both runs — that is the cache
  const dir = tmp('skillgen-etag-');

  const first = await run(['skill', 'install'], port, { cwd: dir, env: { XDG_CONFIG_HOME: cfg } });
  assert.equal(first.code, 0, first.stderr);
  const before = tree(dir);

  const second = await run(['skill', 'install'], port, { cwd: dir, env: { XDG_CONFIG_HOME: cfg } });
  await mock.stop();
  assert.equal(second.code, 0, second.stderr);

  assert.equal(mock.state.manifestReads.length, 2);
  assert.equal(mock.state.manifestReads[0].if_none_match, null, 'nothing to revalidate on a cold cache');
  assert.equal(mock.state.manifestReads[0].status, 200);
  assert.ok(mock.state.manifestReads[1].if_none_match, 'the second read carries If-None-Match');
  assert.equal(mock.state.manifestReads[1].status, 304, 'and the server answers 0 bytes');

  const after = tree(dir);
  assert.equal(after.core, before.core, 'the core rebuilt from the cached body is identical');
  assert.deepEqual(after.refs, before.refs, 'and so is every reference');
});

test('etag: the cache is keyed by CREDENTIAL — a second channel never reuses the first channel\'s validator', async () => {
  const { mock, port } = await mockOn('v123');
  const cfg = tmp('skillgen-cfg2-');
  const dir = tmp('skillgen-etag2-');

  await run(['skill', 'install'], port, { cwd: dir, env: { XDG_CONFIG_HOME: cfg } });
  // Same base URL, same config dir, DIFFERENT key. A keyed manifest body is
  // channel-scoped — that is what `Vary: Authorization` is on the wire for.
  await run(['skill', 'install'], port, { cwd: dir, env: { XDG_CONFIG_HOME: cfg, PIDGE_TOKEN: 'hld_other_channel' } });
  await mock.stop();

  assert.equal(mock.state.manifestReads.length, 2);
  assert.equal(mock.state.manifestReads[1].if_none_match, null, 'the other channel starts cold');
  assert.equal(mock.state.manifestReads[1].status, 200, 'and pays for its own body');

  const cache = JSON.parse(fs.readFileSync(path.join(cfg, 'pidge', 'manifest-cache.json'), 'utf8'));
  assert.equal(Object.keys(cache).length, 2, 'two credentials, two entries');
  for (const key of Object.keys(cache)) {
    assert.ok(!key.includes('hld_'), 'the cache key never carries the key itself');
  }
});

test('etag: a server that sends none is exactly as it was — no header out, no cache, same skill', async () => {
  const { mock, port } = await mockOn('v123', (st) => { st.manifestEtag = false; });
  const cfg = tmp('skillgen-cfg3-');
  const dir = tmp('skillgen-noetag-');

  const first = await run(['skill', 'install'], port, { cwd: dir, env: { XDG_CONFIG_HOME: cfg } });
  const before = tree(dir);
  const second = await run(['skill', 'install'], port, { cwd: dir, env: { XDG_CONFIG_HOME: cfg } });
  await mock.stop();

  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  for (const read of mock.state.manifestReads) {
    assert.equal(read.if_none_match, null, 'nothing to revalidate against');
    assert.equal(read.status, 200);
  }
  assert.ok(!fs.existsSync(path.join(cfg, 'pidge', 'manifest-cache.json')), 'no cache file is created at all');
  assert.equal(tree(dir).core, before.core);
});

test('etag: a 304 does NOT suppress a SPINE-driven regeneration — the two staleness triggers stay independent', async () => {
  const { mock, port } = await mockOn('v123');
  const cfg = tmp('skillgen-cfg4-');
  const dir = tmp('skillgen-spine-');

  // Warm the cache with a real install...
  await run(['skill', 'install'], port, { cwd: dir, env: { XDG_CONFIG_HOME: cfg } });
  const fresh = tree(dir).core;
  // ...then put an OLD-spine skill in its place. The server knows nothing about
  // this CLI's hand-authored spine, so its answer will be a 304 either way.
  const file = path.join(dir, '.claude', 'skills', 'pidge', 'SKILL.md');
  fs.writeFileSync(file, '---\nname: pidge\n# pidge-skill rev=1 manifest=123\n---\n\nOLD SPINE\n\n<!-- pidge-skill-end -->\n');

  const r = await run(['whoami'], port, { cwd: dir, env: { XDG_CONFIG_HOME: cfg, HOME: dir } });
  await mock.stop();

  assert.equal(r.code, 0, r.stderr);
  assert.equal(mock.state.manifestReads.at(-1).status, 304, 'the heal re-read the manifest for free');
  assert.equal(fs.readFileSync(file, 'utf8'), fresh, 'and regenerated the skill anyway');
});
