'use strict';
// Acceptance tests for the #119 resilience ladder + the #118 realtime client.
// Includes the two criteria from the original bug reporter:
//   1. ?wait= behind a proxy with a short response-timeout must not leave the
//      CLI deaf — it degrades to plain GETs and keeps the channel alive;
//   2. an hours-long `listen` must survive a server deploy/restart (the WS
//      reconnects; messages sent while offline are drained over HTTP).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createMock } = require('./mock-server');

const CLI = path.join(__dirname, '..', 'bin', 'pidge.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runCli(args, port, env = {}, cwd = undefined) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd, // #274 F4: setup's skill fuse writes .claude/skills/pidge into cwd — point it at a tmp dir
    env: {
      ...process.env,
      PIDGE_URL: `http://127.0.0.1:${port}`,
      PIDGE_TOKEN: 'hld_test',
      PIDGE_DEGRADED_INTERVAL: '1', // keep the degraded pace test-fast
      ...env,
    },
  });
  const result = new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
  return { child, result };
}

test('Javier #1 — wait= dying behind the edge (502): degrade to plain GETs, stay alive, deliver', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.waitMode = '502'; // every HELD poll dies; plain GETs are fine
  mock.state.messages = [{ id: 7, channel_id: 1, body: 'oi agente', created_at: 'x', consumed_at: null }];

  const { result } = runCli(['listen', '--no-realtime', '--timeout', '30', '--interval', '1'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `expected delivery, got ${code}; stderr: ${stderr}`);
  assert.match(stdout, /oi agente/);
  assert.match(stderr, /degraded to plain GETs/);
});

test('Javier #1b — a proxy DESTROYING held sockets degrades the same way (wait command)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.waitMode = 'destroy';
  mock.state.notifications['cid-9'] = {
    responded: true,
    chosen_action: { kind: 'acted', action_id: 'yes', label: 'Sim', text: null },
  };

  const { result } = runCli(['wait', 'cid-9', '--no-realtime', '--timeout', '30', '--interval', '1'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stdout, /"action_id": "yes"/);
  assert.match(stderr, /degraded to plain GETs/);
});

test('exit 4 — zero healthy round-trips all session must exit LOUD, with aggregated stderr', async () => {
  const mock = createMock();
  const port = await mock.start();
  await mock.stop(); // nothing listening — every request is a network error

  const { result } = runCli(['listen', '--no-realtime', '--timeout', '4', '--interval', '1'], port);
  const { code, stderr } = await result;

  assert.equal(code, 4, `stderr: ${stderr}`);
  assert.match(stderr, /NOT ONE healthy round-trip/);
  // Aggregation (#119): one deafness note + one degrade note — never a line per attempt.
  const deafLines = stderr.split('\n').filter((l) => /deaf for/.test(l));
  assert.ok(deafLines.length <= 2, `expected aggregated stderr, got:\n${stderr}`);
});

test('exit 3 — a healthy but silent session is still just "no answer yet"', async () => {
  const mock = createMock();
  const port = await mock.start();

  const { result } = runCli(['listen', '--no-realtime', '--timeout', '2', '--interval', '1'], port);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 3, `stderr: ${stderr}`);
  assert.match(stderr, /not a failure/);
});

test('Javier #2 — soak: a realtime listen SURVIVES a server restart and still delivers', async (t) => {
  if (typeof WebSocket !== 'function') return t.skip('needs Node ≥22');
  const mock = createMock();
  const port = await mock.start();

  let subscribed = 0;
  mock.state.onSubscribe = () => { subscribed++; };

  const { result } = runCli(['listen', '--ack-on-read', '--realtime', '--timeout', '60'], port);

  // wait until the client is subscribed, then "deploy" (kill + restart)
  while (subscribed === 0) await sleep(50);
  await mock.stop();
  await sleep(2500); // the client is reconnecting with backoff meanwhile
  await mock.start(port);
  while (subscribed < 2) await sleep(50); // re-subscribed after the restart

  // the human types — the frame wakes the client; the backlog GET serves it
  mock.state.messages = [{ id: 12, channel_id: 1, body: 'sobreviveu ao deploy?', created_at: 'x', consumed_at: null }];
  mock.broadcast('ConversationChannel', { type: 'message', message: mock.state.messages[0] });

  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stdout, /sobreviveu ao deploy/);
  assert.match(stderr, /reconnecting/);
  assert.ok(mock.state.acks.length >= 1, 'must ack what it printed');
});

test('ask over the realtime socket resolves from the InboxChannel frame', async (t) => {
  if (typeof WebSocket !== 'function') return t.skip('needs Node ≥22');
  const mock = createMock();
  const port = await mock.start();

  mock.state.onSubscribe = (channel) => {
    if (channel !== 'InboxChannel') return;
    const cid = mock.state.notifies[0].correlation_id;
    // The answer EXISTS only when the frame fires — the WS wake-up, not the
    // connect-time HTTP check, must be what resolves this ask.
    setTimeout(() => {
      mock.state.notifications[cid] = {
        responded: true,
        chosen_action: { kind: 'acted', action_id: 'approve', label: 'Aprovar', text: null },
      };
      mock.broadcast('InboxChannel', {
        type: 'event', kind: 'acted', action_id: 'approve', responded: true, correlation_id: cid,
      });
    }, 500);
  };

  // #246: ask now requires a way to answer (--actions/--custom-action/--template).
  const { result } = runCli(['ask', '--realtime', '--title', 'Aprovar?', '--actions', 'yes,no', '--timeout', '30'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stdout, /"action_id": "approve"/);
});

test('a wedged ack does NOT hang the process forever — it times out, exits (messages were printed)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.hangAck = true; // the ack POST never responds
  mock.state.messages = [{ id: 5, channel_id: 1, body: 'msg + ack travado', created_at: 'x', consumed_at: null }];

  // PIDGE_FETCH_TIMEOUT keeps the test fast; default in prod is 30 s.
  // --ack-on-read: the wedged-ack resilience lives on the ack path (0.9 default doesn't ack on read).
  const { result } = runCli(['listen', '--ack-on-read', '--no-realtime', '--timeout', '20'], port, { PIDGE_FETCH_TIMEOUT: '1500' });
  const started = Date.now();
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `must still exit 0 after printing; stderr: ${stderr}`);
  assert.match(stdout, /ack travado/, 'the messages are printed before the ack');
  assert.match(stderr, /ack failed/);
  assert.ok(Date.now() - started < 10000, 'must not hang to the 20s deadline waiting on a dead ack');
});

test('listen without a WebSocket-capable runtime quietly uses polling (no crash)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 3, channel_id: 1, body: 'polling puro', created_at: 'x', consumed_at: null }];

  const { result } = runCli(['listen', '--no-realtime', '--timeout', '10'], port);
  const { code, stdout } = await result;
  await mock.stop();

  assert.equal(code, 0);
  assert.match(stdout, /polling puro/);
});

// --- Onboarding v2 (#110): setup --claim / doctor / whoami ------------------

const fs = require('node:fs');
const os = require('node:os');

test('setup --claim exchanges the code, writes the env file (600) and runs doctor — secret never printed', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-setup-'));

  const { result } = runCli(
    ['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`],
    port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home },
  );
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const file = path.join(home, 'pidge', 'env');
  const written = fs.readFileSync(file, 'utf8');
  assert.match(written, /PIDGE_TOKEN=hld_minted_by_claim/);
  assert.match(written, new RegExp(`PIDGE_URL=http://127.0.0.1:${port}`));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'env file must be chmod 600');
  // the key must NEVER hit the terminal — only the file
  assert.ok(!stdout.includes('hld_minted_by_claim'), 'key leaked to stdout');
  assert.ok(!stderr.includes('hld_minted_by_claim'), 'key leaked to stderr');
  assert.match(stderr, /canal "mock"/);
  assert.match(stderr, /doctor: all good/);
});

test('setup with a used/expired code fails LOUD with the re-mint recipe', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.claimCode = null; // already claimed

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-setup-'));
  const { result } = runCli(
    ['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`],
    port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home },
  );
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 2);
  assert.match(stderr, /EXPIRED|already used/);
  assert.match(stderr, /copiar prompt de setup/, 'must tell the agent how the human re-mints');
});

test('doctor narrates source + channel + devices and exits 0', async () => {
  const mock = createMock();
  const port = await mock.start();

  const { result } = runCli(['doctor'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stderr, /canal "mock" · 1 device/);
  assert.ok(!stderr.includes('hld_test'), 'doctor must not display the key');
  assert.deepEqual(JSON.parse(stdout).ok, true);
});

test('doctor warns LOUD on 0 devices (sends reach nobody)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.devices = 0;

  const { result } = runCli(['doctor'], port);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0);
  assert.match(stderr, /0 devices.*NOBODY/);
});

test('#171 doctor probes the realtime path: reports ok when the socket confirms', async (t) => {
  if (typeof WebSocket !== 'function') return t.skip('needs Node ≥22');
  const mock = createMock();
  const port = await mock.start();

  const { result } = runCli(['doctor'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stderr, /realtime: ok/);
  assert.equal(JSON.parse(stdout).realtime, 'ok');
  assert.match(stderr, /pidge hello/, 'the hint now leads with the first-contact WOW (#229)');
});

test('#171 doctor: realtime INDISPONÍVEL but the doctor STILL exits 0 (degrade is the contract)', async (t) => {
  if (typeof WebSocket !== 'function') return t.skip('needs Node ≥22');
  const mock = createMock();
  const port = await mock.start();
  mock.state.wsMode = '1006'; // a proxy/edge refusing the upgrade (#119)

  const { result } = runCli(['doctor'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, 'an unavailable WS must NOT fail the doctor — listen just polls');
  assert.match(stderr, /realtime: INDISPON/);
  assert.match(stderr, /--no-realtime/);
  assert.equal(JSON.parse(stdout).realtime, 'unavailable');
});

test('whoami prints the channel identity JSON', async () => {
  const mock = createMock();
  const port = await mock.start();

  const { result } = runCli(['whoami'], port);
  const { code, stdout } = await result;
  await mock.stop();

  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).channel.name, 'mock');
});

test('skill install writes .claude/skills/pidge/SKILL.md from the manifest', async () => {
  const mock = createMock();
  const port = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-skill-'));

  const child = spawn(process.execPath, [CLI, 'skill', 'install'], {
    cwd: dir,
    env: { ...process.env, PIDGE_URL: `http://127.0.0.1:${port}`, PIDGE_TOKEN: 'hld_test' },
  });
  const out = await new Promise((resolve) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
  await mock.stop();

  assert.equal(out.code, 0, `stderr: ${out.stderr}`);
  const skill = fs.readFileSync(path.join(dir, '.claude', 'skills', 'pidge', 'SKILL.md'), 'utf8');
  assert.match(skill, /name: pidge/);
  // #274 F3 INVERTED: the dead content_template MENU is gone. The mock STILL serves
  // templates.decision_table (row text "template decision") — proof the generator now
  // IGNORES it — and the old "Pick the right send" menu heading is absent. (--template
  // now appears ONLY inside the skill's "it's gone, don't use it" warnings — that's the
  // point, so we assert the dead ROW + heading are absent, not the literal word.)
  assert.ok(!/template decision/.test(skill), 'mock templates.decision_table row must NOT be pulled');
  assert.ok(!/Pick the right send/.test(skill), 'the dead content_template menu heading is gone');
  assert.match(skill, /manifest v16/);
});

// --- #280 + #33 fix: the local skill self-heals (any pidge command refreshes a stale skill) ---
// The installed SKILL.md carries the marker `# pidge-skill rev=R manifest=N` as a YAML COMMENT
// INSIDE the frontmatter (0.15.3+). It must NOT precede the opening `---`: a first line that
// isn't `---` fails the YAML frontmatter parse, so Claude Code loads the skill with a garbage
// description (proven on a live headless run) — the 0.15.2 marker-first format was exactly that
// bug. On EVERY networked command, checkManifestNews → ensureSkillFresh reads the marker (from
// the new position, and tolerating the OLD line-1 `<!-- … -->` so a 0.15.2 install still heals),
// compares it against the CLI's SKILL_REVISION and the server's x-pidge-manifest-version header,
// and silently regenerates a stale skill so the agent's NEXT session is current. Only EXISTING
// skills refresh.

// Simulates a 0.15.2 install: the marker sits on line 1, ABOVE the `---` (the broken format).
function seedOldSkill(marker, body = 'OLD SKILL BODY') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-heal-'));
  const file = path.join(dir, '.claude', 'skills', 'pidge', 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${marker}\n---\nname: pidge\n---\n\n# Pidge\n\n${body}\n`);
  return { dir, file };
}

// The corrected 0.15.3+ format: `---` on line 1, the marker a `#` comment inside the
// frontmatter. #38 adds the end-of-file trailer (the cheap integrity check) — seed it
// too so a "fresh" seed reads as INTACT, not as a torn write.
function seedNewSkill(rev, manifest, body = 'OLD SKILL BODY') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-heal-'));
  const file = path.join(dir, '.claude', 'skills', 'pidge', 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nname: pidge\ndescription: Send rich stuff.\n# pidge-skill rev=${rev} manifest=${manifest}\n---\n\n# Pidge\n\n${body}\n\n<!-- pidge-skill-end -->\n`);
  return { dir, file };
}

test('#33 — a 0.15.2 marker-first install self-heals into the fixed in-frontmatter format', async () => {
  const mock = createMock();
  const port = await mock.start();
  // The real-world broken install: marker ABOVE the `---`, rev=1 (0.15.2's SKILL_REVISION).
  // manifest is current (16) but the spine bumped (5 > 1), so the heal fires and REPAIRS format.
  const { dir, file } = seedOldSkill('<!-- pidge-skill rev=1 manifest=16 -->', 'BROKEN 0.15.2 SKILL');

  const { result } = runCli(['whoami'], port, { XDG_CONFIG_HOME: dir }, dir);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const healed = fs.readFileSync(file, 'utf8');
  // THE regression guard: the frontmatter must open on line 1, or the YAML parse fails.
  assert.equal(healed.split('\n', 1)[0], '---', 'first line must be `---` (valid frontmatter)');
  assert.ok(!/<!-- pidge-skill rev=/.test(healed), 'the old HTML-comment marker is gone (the #38 end trailer is not it)');
  assert.match(healed, /\n# pidge-skill rev=5 manifest=16\n/, 'marker now a YAML comment inside the frontmatter');
  assert.match(healed, /^---\nname: pidge\ndescription: Send rich/, 'real name + description survive the frontmatter');
  assert.ok(!/BROKEN 0\.15\.2 SKILL/.test(healed), 'the broken skill was replaced by a real regeneration');
  assert.match(stderr, /refreshed your local Pidge skill \(rev 5, manifest v16\)/, 'one stderr note');
});

test('#280 — a SPINE bump (SKILL_REVISION > installed) self-heals the local skill', async () => {
  const mock = createMock();
  const port = await mock.start();
  // New-format skill, manifest current (16), spine stale (rev=0 < current 5) — reads the
  // marker from its new in-frontmatter position and heals on the spine trigger.
  const { dir, file } = seedNewSkill(0, 16, 'STALE SPINE');

  const { result } = runCli(['whoami'], port, { XDG_CONFIG_HOME: dir }, dir);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const healed = fs.readFileSync(file, 'utf8');
  assert.equal(healed.split('\n', 1)[0], '---', 'first line stays `---`');
  assert.match(healed, /\n# pidge-skill rev=5 manifest=16\n/, 'marker rewritten to the current rev, in the frontmatter');
  assert.ok(!/STALE SPINE/.test(healed), 'the stale spine was replaced by a real regeneration');
  assert.match(healed, /name: pidge/, 'a genuine skill was written');
  assert.match(stderr, /refreshed your local Pidge skill \(rev 5, manifest v16\)/, 'one stderr note');
});

test('#280 — a MANIFEST bump (server version > installed) self-heals the local skill', async () => {
  const mock = createMock();
  const port = await mock.start();
  // New-format skill, spine current (rev=5) but the baked manifest is stale (15 < the mock's 16).
  const { dir, file } = seedNewSkill(5, 15, 'STALE BY MANIFEST');

  const { result } = runCli(['whoami'], port, { XDG_CONFIG_HOME: dir }, dir);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const healed = fs.readFileSync(file, 'utf8');
  assert.match(healed, /\n# pidge-skill rev=5 manifest=16\n/, 'marker rewritten to the current manifest');
  assert.ok(!/STALE BY MANIFEST/.test(healed), 'the stale skill was regenerated');
  assert.match(stderr, /refreshed your local Pidge skill/, 'one stderr note');
});

test('#280 — a FRESH skill (new-format marker current) is left byte-for-byte, no note', async () => {
  const mock = createMock();
  const port = await mock.start();
  // Proves the reader FINDS the marker in its new in-frontmatter position: if it couldn't,
  // it would read rev=0 and needlessly regenerate, failing the byte-for-byte assertion.
  const { dir, file } = seedNewSkill(5, 16, 'SENTINEL FRESH — keep me');
  const original = fs.readFileSync(file, 'utf8');

  const { result } = runCli(['whoami'], port, { XDG_CONFIG_HOME: dir }, dir);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.equal(fs.readFileSync(file, 'utf8'), original, 'a current skill must NOT be regenerated');
  assert.ok(!/refreshed your local Pidge skill/.test(stderr), 'no refresh note when fresh');
});

test('#280 — NO local skill present: a command runs normally, nothing is auto-created', async () => {
  const mock = createMock();
  const port = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-heal-none-'));

  const { result } = runCli(['whoami'], port, { XDG_CONFIG_HOME: dir }, dir);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'skills', 'pidge', 'SKILL.md')),
    'the self-heal must never create a skill that was not already there');
  assert.ok(!/refreshed your local Pidge skill/.test(stderr), 'no refresh note when there is no skill');
});

// --- #38: atomic self-heal — torn writes, concurrency, read-only, prose marker, .bak ---

test('#38 — a TORN write (marker intact, tail truncated) is detected and re-healed', async () => {
  const mock = createMock();
  const port = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-heal-torn-'));
  const file = path.join(dir, '.claude', 'skills', 'pidge', 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A partial write that died after the frontmatter: rev/manifest read as CURRENT, so
  // pre-#38 this file looked "fresh" forever and never healed (proven in the review).
  fs.writeFileSync(file, '---\nname: pidge\ndescription: Send rich stuff.\n# pidge-skill rev=5 manifest=16\n---\n\n# Pidge\n\nTRUNCATED MID-');

  const { result } = runCli(['whoami'], port, { XDG_CONFIG_HOME: dir }, dir);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const healed = fs.readFileSync(file, 'utf8');
  assert.ok(!/TRUNCATED MID-/.test(healed), 'the torn skill was regenerated');
  assert.match(healed.trimEnd(), /<!-- pidge-skill-end -->$/, 'the regenerated skill closes with the trailer');
  assert.match(stderr, /refreshed your local Pidge skill/, 'the heal narrated itself');
});

test('#38 — "pidge-skill" in body PROSE is not the marker: a marker-less skill still heals', async () => {
  const mock = createMock();
  const port = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-heal-prose-'));
  const file = path.join(dir, '.claude', 'skills', 'pidge', 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // No real marker in the frontmatter — but the body MENTIONS one with a huge rev.
  // Pre-#38 the first-line-containing scan read rev=99 and suppressed the heal forever.
  fs.writeFileSync(file, '---\nname: pidge\ndescription: Send rich stuff.\n---\n\nsee pidge-skill rev=99 manifest=99 for details\n\n<!-- pidge-skill-end -->\n');

  const { result } = runCli(['whoami'], port, { XDG_CONFIG_HOME: dir }, dir);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const healed = fs.readFileSync(file, 'utf8');
  assert.match(healed, /\n# pidge-skill rev=5 manifest=16\n/, 'a real marker was written by the heal');
  assert.ok(!/rev=99/.test(healed), 'the prose decoy is gone with the regeneration');
});

test('#38 — 4 concurrent heals never tear the file (atomic tmp+rename)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const { dir, file } = seedNewSkill(0, 16, 'STALE FOR THE STAMPEDE');

  const outs = await Promise.all(
    Array.from({ length: 4 }, () => runCli(['whoami'], port, { XDG_CONFIG_HOME: dir }, dir).result),
  );
  await mock.stop();

  for (const o of outs) assert.equal(o.code, 0, `stderr: ${o.stderr}`);
  const healed = fs.readFileSync(file, 'utf8');
  assert.equal(healed.split('\n', 1)[0], '---', 'first line stays `---`');
  assert.equal((healed.match(/# pidge-skill rev=/g) || []).length, 1, 'exactly ONE marker — no interleaved halves');
  assert.match(healed, /\n# pidge-skill rev=5 manifest=16\n/, 'a whole, current skill won');
  assert.match(healed.trimEnd(), /<!-- pidge-skill-end -->$/, 'the trailer closes the file — no torn tail');
  const leftovers = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, [], 'no tmp litter after concurrent heals');
});

test('#38 — a read-only skill dir degrades clean: the command succeeds, the file stands', async () => {
  const mock = createMock();
  const port = await mock.start();
  const { dir, file } = seedNewSkill(0, 16, 'STALE BUT UNWRITABLE');
  const skillDir = path.dirname(file);
  const original = fs.readFileSync(file, 'utf8');
  fs.chmodSync(skillDir, 0o555);
  try {
    const { result } = runCli(['whoami'], port, { XDG_CONFIG_HOME: dir }, dir);
    const { code, stderr } = await result;
    assert.equal(code, 0, `the user's command must survive the failed heal; stderr: ${stderr}`);
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'the stale file stands untouched — never half-written');
  } finally {
    fs.chmodSync(skillDir, 0o755);
    await mock.stop();
  }
});

test('#38 — healing over a CUSTOMIZED skill saves SKILL.md.bak + one stderr line', async () => {
  const mock = createMock();
  const port = await mock.start();
  const { dir, file } = seedNewSkill(0, 16, 'MY CUSTOM NOTES — precious');

  const { result } = runCli(['whoami'], port, { XDG_CONFIG_HOME: dir }, dir);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const bak = path.join(path.dirname(file), 'SKILL.md.bak');
  assert.ok(fs.existsSync(bak), 'the previous content was backed up before the clobber');
  assert.match(fs.readFileSync(bak, 'utf8'), /MY CUSTOM NOTES — precious/, 'the .bak holds the clobbered content');
  assert.match(stderr, /SKILL\.md\.bak/, 'one stderr line points at the backup');
  assert.ok(!/MY CUSTOM NOTES/.test(fs.readFileSync(file, 'utf8')), 'the live skill is the regenerated one');
});

// --- #131: listen --all — the single ear --------------------------------------

test('listen --all hears a notification answer and narrates which notification spoke back', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{
    id: 9, channel_id: 1, kind: 'notification_reply',
    body: 'sim, manda', text: 'sim, manda', action_id: 'reply',
    ref: { correlation_id: 'pricing-2', title: 'Aprovar preço?', thread_id: 'pricing', notification_status: 'completed', event_kind: 'replied' },
    created_at: 'x', consumed_at: null,
  }];

  const { result } = runCli(['listen', '--all', '--no-realtime', '--timeout', '10'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stdout, /notification_reply/);
  assert.match(stderr, /reply to your notification pricing-2 \("Aprovar preço\?"\)/);
});

test('listen WITHOUT --all keeps the composer-only contract (answers not served)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{
    id: 9, channel_id: 1, kind: 'notification_reply', body: 'sim',
    ref: { correlation_id: 'x', title: 'y' }, created_at: 'x', consumed_at: null,
  }];

  const { result } = runCli(['listen', '--no-realtime', '--timeout', '6'], port);
  const { code } = await result;
  await mock.stop();

  assert.equal(code, 3, 'composer-only listen must time out — the answer is not its stream');
});

// --- #132: ask obeys the template's suggested timeout -------------------------

test('ask without --timeout obeys the 201 suggested_ask_timeout and narrates it', async () => {
  const mock = createMock();
  const port = await mock.start();
  // answer immediately so the (1h) timeout never actually elapses
  mock.state.notifications['tpl-1'] = {
    responded: true,
    chosen_action: { kind: 'acted', action_id: 'approve', label: 'Aprovar', text: null },
  };

  const { result } = runCli(
    ['ask', '--no-realtime', '--template', 'approval', '--title', 'Aprovar?', '--correlation-id', 'tpl-1'],
    port,
  );
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stderr, /timeout 60 min — suggested by template approval/);
  assert.equal(JSON.parse(stdout).action_id, 'approve');
});

test('an explicit --timeout always beats the template suggestion', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['tpl-2'] = {
    responded: true,
    chosen_action: { kind: 'acted', action_id: 'approve', label: 'Aprovar', text: null },
  };

  const { result } = runCli(
    ['ask', '--no-realtime', '--template', 'approval', '--title', 'Aprovar?', '--correlation-id', 'tpl-2', '--timeout', '30'],
    port,
  );
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0);
  assert.doesNotMatch(stderr, /suggested by template/);
});

// --- #217: hello = the first-contact WOW (template onboarding, send + wait) ----

test('hello sends template=onboarding with default copy, narrates the WOW, returns the answer', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['wow-1'] = {
    responded: true,
    chosen_action: { kind: 'completed', action_id: 'done', label: 'Feito ✓', text: null },
  };

  const { result } = runCli(['hello', '--no-realtime', '--correlation-id', 'wow-1'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stderr, /WOW sent/);
  assert.equal(JSON.parse(stdout).action_id, 'done');
  const sent = mock.state.notifies.at(-1);
  assert.equal(sent.template, 'onboarding', 'hello must pin the onboarding template (the WOW trigger)');
  assert.ok(sent.title && sent.title.length > 0, 'hello supplies a default title');
});

test('hello --profile tracking is refused locally (the handshake needs an answer)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const { result } = runCli(['hello', '--no-realtime', '--profile', 'tracking'], port);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 1);
  assert.match(stderr, /tracking/);
});

// --- #157 P2 tails: --follow + local custom-action id validation --------------

test('listen --follow prints+acks a batch and KEEPS listening, exit 0 at the window end', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 11, channel_id: 1, body: 'primeiro lote', created_at: 'x', consumed_at: null }];

  // --ack-on-read: a --follow supervisor that consumes inline (so the mock clears
  // between batches; without it the server lease would gate re-serve, unmodeled here).
  const { result } = runCli(['listen', '--follow', '--ack-on-read', '--no-realtime', '--timeout', '6', '--interval', '1'], port);
  await sleep(2500);
  // a second batch lands mid-window — a one-shot listen would have exited already
  mock.state.messages = [{ id: 12, channel_id: 1, body: 'segundo lote', created_at: 'x', consumed_at: null }];
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stdout, /primeiro lote/);
  assert.match(stdout, /segundo lote/, 'the follow window must deliver BOTH batches');
  assert.match(stderr, /--follow — still listening/);
  assert.match(stderr, /--follow window ended/);
  // §2.6: the LOUD supervisor-only warning at startup (a turn-based agent traps its turn).
  assert.match(stderr, /supervisor mode/);
  assert.match(stderr, /must NOT use --follow/);
});

test('an invalid --custom-action id fails fast locally with the spelled-out rule', async () => {
  const mock = createMock();
  const port = await mock.start();

  const { result } = runCli(
    ['notify', '--title', 'x', '--custom-action', 'Não-Válido:Rótulo'],
    port,
  );
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 1);
  assert.match(stderr, /lowercase letters, digits and underscore only/);
  assert.equal(mock.state.notifies.length, 0, 'must not reach the server');
});

// --- shared-config guard (incidente 2026-06-13: cron do Javier sequestrado) ---

test('setup REFUSES to overwrite a config owned by another live channel — and does not burn the claim code', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-guard-'));
  fs.mkdirSync(path.join(home, 'pidge'), { recursive: true });
  fs.writeFileSync(path.join(home, 'pidge', 'env'),
    `PIDGE_URL=http://127.0.0.1:${port}\nPIDGE_TOKEN=hld_existing_live\n`);

  const { result } = runCli(
    ['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`],
    port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home },
  );
  const { code, stderr } = await result;

  assert.equal(code, 2);
  assert.match(stderr, /já guarda a chave de "mock"/);
  assert.match(stderr, /--force/);
  assert.equal(mock.state.claimCode, 'claim-ok', 'the single-use code must SURVIVE the refusal');
  const kept = fs.readFileSync(path.join(home, 'pidge', 'env'), 'utf8');
  assert.match(kept, /hld_existing_live/, 'the existing config must be untouched');
  await mock.stop();
});

test('setup --force overwrites; a REVOKED stored key needs no --force', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-guard-'));
  fs.mkdirSync(path.join(home, 'pidge'), { recursive: true });
  fs.writeFileSync(path.join(home, 'pidge', 'env'),
    `PIDGE_URL=http://127.0.0.1:${port}\nPIDGE_TOKEN=hld_revoked\n`);

  // dead key in the file ⇒ proceeds without --force
  const { result } = runCli(
    ['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`],
    port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home },
  );
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const written = fs.readFileSync(path.join(home, 'pidge', 'env'), 'utf8');
  assert.match(written, /hld_minted_by_claim/);
});

// --- per-agent isolation: PIDGE_AGENT + setup --print (incident follow-up) ----

test('PIDGE_AGENT namespaces the config file so two agents never share an identity', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-agent-'));

  // agent "javier" claims
  let r = runCli(['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`], port,
    { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home, PIDGE_AGENT: 'javier' });
  let out = await r.result;
  assert.equal(out.code, 0, `javier setup: ${out.stderr}`);
  const javierEnv = path.join(home, 'pidge', 'agents', 'javier', 'env');
  assert.ok(fs.existsSync(javierEnv), 'javier gets his own file');

  // a SECOND agent "mkt" claims — must NOT trip the guard (different file), no --force
  mock.state.claimCode = 'claim-mkt';
  r = runCli(['setup', '--claim', 'claim-mkt', '--url', `http://127.0.0.1:${port}`], port,
    { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home, PIDGE_AGENT: 'mkt' });
  out = await r.result;
  await mock.stop();
  assert.equal(out.code, 0, `mkt setup must not collide: ${out.stderr}`);
  assert.ok(fs.existsSync(path.join(home, 'pidge', 'agents', 'mkt', 'env')), 'mkt gets a separate file');
  assert.ok(fs.existsSync(javierEnv), "javier's file is untouched");
});

test('setup --print emits export lines and writes NO file (per-agent, human-run)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-print-'));

  const { result } = runCli(['setup', '--claim', 'claim-ok', '--print', '--url', `http://127.0.0.1:${port}`], port,
    { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home });
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stdout, /export PIDGE_TOKEN=hld_minted_by_claim/);
  assert.match(stdout, /export PIDGE_URL=/);
  assert.ok(!fs.existsSync(path.join(home, 'pidge', 'env')), '--print must not write the file');
  assert.match(stderr, /NÃO rode --print de dentro de um agente/);
  // 0.8.1: the post-setup doctor must NOT claim a config file it never wrote.
  assert.match(stderr, /not stored on disk/);
  assert.doesNotMatch(stderr, /token found \(.*pidge.*env\)/);
});

// --- #274 F4: setup → skill → hello fuse (graceful-degrade) -------------------

test('#274 F4 — setup fuses the skill install + a `pidge hello` hint, exit 0', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-fuse-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-fuse-cwd-'));

  const { result } = runCli(['setup', '--claim', 'claim-ok', '--print', '--url', `http://127.0.0.1:${port}`], port,
    { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home }, cwd);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stderr, /skill written/, 'the skill install ran as part of setup');
  assert.match(stderr, /pidge hello/, 'setup hints the first-contact handshake');
  // the skill was actually written into cwd, generated from the (mock) manifest
  const skill = fs.readFileSync(path.join(cwd, '.claude', 'skills', 'pidge', 'SKILL.md'), 'utf8');
  assert.match(skill, /Approval has two paths/);
});

test('#274 F4 — a manifest failure DEGRADES (one-line skip + hello hint), setup STILL exits 0, no USAGE dump', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.manifestStatus = 500; // the skill install can't read the manifest
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-fuse-fail-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-fuse-fail-cwd-'));

  const { result } = runCli(['setup', '--claim', 'claim-ok', '--print', '--url', `http://127.0.0.1:${port}`], port,
    { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home }, cwd);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `setup must survive a skill-install failure; stderr: ${stderr}`);
  assert.match(stderr, /skill install skipped/, 'the failure is ONE stderr line');
  assert.match(stderr, /pidge hello/, 'the hello hint still prints');
  assert.ok(!fs.existsSync(path.join(cwd, '.claude', 'skills', 'pidge', 'SKILL.md')), 'no SKILL.md when the manifest read fails');
  // graceful-degrade invariant: never fall through to the global USAGE dump.
  assert.doesNotMatch(stderr, /send an iPhone notification to a human and block until they answer/);
});

// --- 0.9.0: Fix 2 (ack-after-work) + Fix 3 (degrade) + #181/#182 -------------

test('--version prints the CLI version and exits 0 (was "Unknown option")', async () => {
  const mock = createMock();
  const port = await mock.start();
  const { result } = runCli(['--version'], port);
  const { code, stdout } = await result;
  await mock.stop();

  assert.equal(code, 0);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('listen (0.9 default) DELIVERS without consuming + shows the ack-after-work notice', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 8, channel_id: 1, body: 'trabalho pendente', created_at: 'x' }];

  // Isolate the config dir so the once-per-install ack-notice stamp (Fix 2/#170)
  // doesn't leak across runs — a fresh install must SEE the notice.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-ack-'));
  const { result } = runCli(['listen', '--no-realtime', '--timeout', '10'], port, { XDG_CONFIG_HOME: home });
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stdout, /trabalho pendente/);
  assert.equal(mock.state.acks.length, 0, 'the 0.9 default must NOT ack on read');
  assert.match(stderr, /DELIVERED \(gray/);
  assert.match(stderr, /pidge ack --up-to 8/);
});

test('the ack-after-work notice shows ONCE PER INSTALL — a second listen is silent (stamp)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-ack2-'));

  mock.state.messages = [{ id: 9, channel_id: 1, body: 'um', created_at: 'x' }];
  let out = await runCli(['listen', '--no-realtime', '--timeout', '10'], port, { XDG_CONFIG_HOME: home }).result;
  assert.match(out.stderr, /DELIVERED \(gray/, 'first run shows the notice');

  // a SECOND fresh process, same install (same XDG_CONFIG_HOME) → notice suppressed
  mock.state.messages = [{ id: 10, channel_id: 1, body: 'dois', created_at: 'x' }];
  out = await runCli(['listen', '--no-realtime', '--timeout', '10'], port, { XDG_CONFIG_HOME: home }).result;
  await mock.stop();
  assert.match(out.stdout, /dois/, 'second run still delivers');
  assert.doesNotMatch(out.stderr, /DELIVERED \(gray/, 'the notice is once-per-install, not every run');
});

test('ack --up-to processes (green); ack --renew heartbeats the lease', async () => {
  const mock = createMock();
  const port = await mock.start();

  let r = runCli(['ack', '--up-to', '8'], port);
  let out = await r.result;
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /processed 1 message/);

  r = runCli(['ack', '--up-to', '8', '--renew'], port);
  out = await r.result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /lease renewed on 1 message/);
});

test('contract set declares operating_contract; contract show reads it back', async () => {
  const mock = createMock();
  const port = await mock.start();

  let r = runCli(['contract', 'set', 'listen_mode=turn_based'], port);
  let out = await r.result;
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /declared listen_mode="turn_based"/);
  assert.equal(mock.state.operatingContract.listen_mode.value, 'turn_based');

  r = runCli(['contract', 'show'], port);
  out = await r.result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /listen_mode/);
});

test('contract set NEVER prints the channel key to stdout (0.9.2 key-leak fix)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['contract', 'set', 'listen_mode=turn_based'], port).result;
  assert.equal(out.code, 0, out.stderr);
  // the PATCH response echoes the key; stdout must carry ONLY the operating_contract
  assert.doesNotMatch(out.stdout, /hld_/, 'the agent key must never land in stdout');
  assert.doesNotMatch(out.stderr, /hld_/, 'nor in stderr');
  const parsed = JSON.parse(out.stdout);
  assert.ok(parsed.operating_contract, 'stdout is clean JSON with operating_contract');
  await mock.stop();
});

test('contract set rejects an unknown key / bad value LOCALLY (exit 1, no round-trip)', async () => {
  const mock = createMock();
  const port = await mock.start();

  let out = await runCli(['contract', 'set', 'bogus_key=1'], port).result;
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, /unknown operating_contract key/);

  // a wrong-typed enum value is also caught locally
  out = await runCli(['contract', 'set', 'listen_mode=sideways'], port).result;
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, /must be one of: turn_based, persistent, external_daemon, always_on/);
  assert.equal(Object.keys(mock.state.operatingContract).length, 0, 'a bad key never reaches the server');

  // §3c: external_daemon is now ACCEPTED (reaches the server, exit 0)
  out = await runCli(['contract', 'set', 'listen_mode=external_daemon'], port).result;
  assert.equal(out.code, 0, out.stderr);

  await mock.stop();
});

test('setup DECLARES operating_contract (#182 step 5) — default turn_based, --listen-mode overrides', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-setup-oc-'));

  // default (non-interactive) → turn_based
  let out = await runCli(['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`], port,
    { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home, PIDGE_AGENT: 'oc' }).result;
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /declared listen_mode=turn_based/);
  assert.equal(mock.state.operatingContract.listen_mode.value, 'turn_based');
  assert.equal(mock.state.operatingContract.keep_connection_alive.value, false);

  // --listen-mode always_on → the supervisor declaration
  mock.state.claimCode = 'claim-2';
  mock.state.operatingContract = {};
  out = await runCli(['setup', '--claim', 'claim-2', '--force', '--listen-mode', 'always_on', '--url', `http://127.0.0.1:${port}`], port,
    { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home, PIDGE_AGENT: 'oc2' }).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /declared listen_mode=always_on/);
  assert.equal(mock.state.operatingContract.listen_mode.value, 'always_on');
  assert.equal(mock.state.operatingContract.keep_connection_alive.value, true);
});

test('whoami reports HONEST reach AND SHOUTS on a claim swap (not just doctor) (§5.2/§4.6)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-whoami-'));

  // agent "a" claims (gen 1), a DIFFERENT agent "b" claims (gen 2)
  await runCli(['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`], port,
    { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home, PIDGE_AGENT: 'a' }).result;
  mock.state.claimCode = 'claim-b';
  await runCli(['setup', '--claim', 'claim-b', '--url', `http://127.0.0.1:${port}`], port,
    { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home, PIDGE_AGENT: 'b' }).result;

  mock.state.deviceReach = { total: 3, pushable: 2, deliverable: 1, apns_environment: 'production', by_environment: { production: 1, sandbox: 1 } };
  const out = await runCli(['whoami'], port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home, PIDGE_AGENT: 'a' }).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /will actually receive a push/, 'whoami reports deliverable reach');
  assert.match(out.stderr, /UNREACHABLE/);
  assert.match(out.stderr, /ANOTHER AGENT CLAIMED THIS CHANNEL/, 'whoami SHOUTS on a claim swap');
});

test('doctor EXITS 2 when devices exist but 0 are deliverable (a send reaches nobody)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.devices = 2;
  mock.state.deviceReach = { total: 2, pushable: 2, deliverable: 0, apns_environment: 'production', by_environment: { sandbox: 2 } };

  const out = await runCli(['doctor'], port).result;
  await mock.stop();
  assert.equal(out.code, 2, out.stderr);
  assert.match(out.stderr, /reaches nobody|BROKEN/);
});

test('ack rejects mixing --up-to and --ids (usage error, exit 1)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['ack', '--up-to', '8', '--ids', '1,2'], port).result;
  await mock.stop();
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, /not both/);
});

test('a server newer than KNOWN_MANIFEST_VERSION nudges ONCE on stderr (KNOWN=36 baseline)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.manifestVersion = 99; // server advertises news the CLI doesn't know
  // #241: isolate the per-install state cache so the 24h throttle can't leak
  // across suite runs (a re-run would otherwise suppress the nag and false-fail).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-nag-'));
  const out = await runCli(['doctor'], port, { XDG_CONFIG_HOME: home }).result;
  await mock.stop();
  assert.match(out.stderr, /manifest v99/, 'the version nudge fires when the server is ahead');
  // #26: the nudge reframes as "new capabilities you can use NOW via --param" — a
  // thin-pipe CLI rarely needs a release on a server bump — NOT "your CLI is stale,
  // UPDATE it" as the headline action.
  assert.match(out.stderr, /thin pipe/, 'reframed as new capabilities, not a stale-CLI scold');
  assert.match(out.stderr, /--param/, 'tells the agent how to use the new field today');
  assert.doesNotMatch(out.stderr, /UPDATE the CLI/, 'updating is no longer the headline action');
  // #249-A: the manifest is PUBLIC — the curl reads without a key; the Bearer is
  // shown only as the OPTIONAL way to also see the channel's own config.
  assert.match(out.stderr, /Authorization: Bearer \$PIDGE_TOKEN/);
});

test('doctor reports HONEST device reach and warns when pushable > deliverable (gotcha #9)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.deviceReach = { total: 3, pushable: 2, deliverable: 1, apns_environment: 'production', by_environment: { production: 1, sandbox: 1 } };

  const { result } = runCli(['doctor'], port);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0);
  assert.match(stderr, /will actually receive a push/);
  assert.match(stderr, /UNREACHABLE/);
});

test('#181 claim ownership: doctor SHOUTS when another agent took the channel (generation bumped)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-claim-'));

  // agent "a" sets up + claims (generation 1, fingerprint Fa)
  let r = runCli(['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`], port,
    { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home, PIDGE_AGENT: 'a' });
  let out = await r.result;
  assert.equal(out.code, 0, `a setup: ${out.stderr}`);
  assert.match(out.stderr, /ownership claimed as "a" \(generation 1\)/);

  // a DIFFERENT agent "b" claims the SAME channel (different fingerprint) → generation 2
  mock.state.claimCode = 'claim-b';
  r = runCli(['setup', '--claim', 'claim-b', '--url', `http://127.0.0.1:${port}`], port,
    { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home, PIDGE_AGENT: 'b' });
  out = await r.result;
  assert.equal(out.code, 0, `b setup: ${out.stderr}`);
  assert.match(out.stderr, /generation 2/);

  // agent "a" runs doctor → must SHOUT (stored gen 1 < server gen 2, different fingerprint)
  r = runCli(['doctor'], port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home, PIDGE_AGENT: 'a' });
  out = await r.result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /ANOTHER AGENT CLAIMED THIS CHANNEL/);
});

test('Fix 3 — repeated WS close 1006 DEGRADES to polling and still delivers (never deaf, #119)', async (t) => {
  if (typeof WebSocket !== 'function') return t.skip('needs Node ≥22');
  const mock = createMock();
  const port = await mock.start();
  mock.state.wsMode = '1006'; // every WS connection drops abruptly, repeatedly
  mock.state.messages = [{ id: 14, channel_id: 1, body: 'sobrevive ao 1006', created_at: 'x' }];

  const { result } = runCli(['listen', '--realtime', '--timeout', '30'], port, { PIDGE_WS_BACKOFF_MS: '100' });
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stdout, /sobrevive ao 1006/);
  assert.match(stderr, /realtime unavailable|reconnecting/);
});

test('Fix 3 — repeated 1006 with NO message: REAL wall-clock on timeout (never the 28800s lie), runs to the deadline', async (t) => {
  if (typeof WebSocket !== 'function') return t.skip('needs Node ≥22');
  const mock = createMock();
  const port = await mock.start();
  mock.state.wsMode = '1006';

  const { result } = runCli(['listen', '--realtime', '--timeout', '4'], port, { PIDGE_WS_BACKOFF_MS: '100' });
  const started = Date.now();
  const { code, stderr } = await result;
  const elapsedMs = Date.now() - started;
  await mock.stop();

  assert.equal(code, 3, `stderr: ${stderr}`);
  const m = stderr.match(/after (\d+)s/);
  assert.ok(m, `expected a REAL-elapsed timeout line, got: ${stderr}`);
  assert.ok(Number(m[1]) < 30, `elapsed must be the REAL wall-clock, got ${m[1]}s`);
  assert.ok(!stderr.includes('28800'), 'must NEVER print the configured-deadline lie');
  assert.ok(elapsedMs >= 2500, `must run to the ~4s deadline, not bail when WS gave up (~0.6s); ran ${elapsedMs}ms`);
});

test('doctor warns when reading the SHARED legacy file (no PIDGE_AGENT, no env var)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-shared-'));
  fs.mkdirSync(path.join(home, 'pidge'), { recursive: true });
  fs.writeFileSync(path.join(home, 'pidge', 'env'),
    `PIDGE_URL=http://127.0.0.1:${port}\nPIDGE_TOKEN=hld_shared\n`);

  const { result } = runCli(['doctor'], port,
    { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home });
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0);
  assert.match(stderr, /SHARED file/);
  assert.match(stderr, /PIDGE_AGENT/);
});

// #205 — reachability self-test (round-trip over the unified queue + ack).
test('selftest — PASS: fire a nonce, the listener acks it, the server confirms', async () => {
  const mock = createMock();
  const port = await mock.start();
  const { result } = runCli(['selftest', '--window', '10', '--no-realtime'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();
  assert.equal(code, 0, `expected PASS exit 0, got ${code}; stderr: ${stderr}`);
  assert.match(stderr, /SELF-TEST PASSED/);
  assert.match(stdout, /"status":\s*"passed"/);
  // it acked ONLY the nonce by id (ids:[…]), never up_to — so real pending messages aren't eaten
  assert.ok(mock.state.acks.some((u) => /messages\/ack/.test(u)), 'it acked the nonce');
});

test('selftest — FAIL with cause when the listener never receives the nonce', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.dropSelftest = true; // the nonce never reaches the queue (orphan / dead transport)
  const { result } = runCli(['selftest', '--window', '5', '--no-realtime'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();
  assert.equal(code, 2, `expected FAIL exit 2, got ${code}; stderr: ${stderr}`);
  assert.match(stderr, /SELF-TEST FAILED/);
  assert.match(stderr, /never received the nonce/);
  assert.match(stdout, /"saw_nonce":\s*false/);
});

test('selftest — a non-numeric --window falls back to the default, never a false FAIL', async () => {
  const mock = createMock();
  const port = await mock.start();
  const { result } = runCli(['selftest', '--window', '30s', '--no-realtime'], port); // typo'd window
  const { code, stderr } = await result;
  await mock.stop();
  assert.equal(code, 0, `a typo'd window must not masquerade as a dead listener; stderr: ${stderr}`);
  assert.match(stderr, /SELF-TEST PASSED/);
});

// --- 0.12.0 — CLI bugs batch (#240/#241/#242/#243/#244) -----------------------

// #240: `pidge <sub> --help` must show the SUBCOMMAND's own help, not the global
// USAGE dump (help exits before any network — no mock server needed).
test('#240 — `pidge ask --help` shows the subcommand help (own flags), not the global dump', async () => {
  const out = await runCli(['ask', '--help'], 1).result;
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /^pidge ask —/, 'leads with the focused ask header');
  assert.match(out.stdout, /--actions LIST\|JSON/, "lists ask's own --actions flag");
  assert.match(out.stdout, /--timeout SECONDS/, 'and --timeout');
  assert.doesNotMatch(out.stdout, /pidge setup --claim CODE/, 'must NOT be the global command list');
});

test('#240 — other subcommands get their own focused help too (notify / wait / listen / inbox / ack)', async () => {
  const cases = [
    ['notify', /^pidge notify —/, /--body-markdown MD/],
    ['wait', /^pidge wait —/, /pidge wait <correlation_id>/],
    ['listen', /^pidge listen —/, /--follow/],
    ['inbox', /^pidge inbox —/, /--summary/],
    ['ack', /^pidge ack —/, /--up-to ID/],
  ];
  for (const [cmd, header, flag] of cases) {
    const out = await runCli([cmd, '--help'], 1).result;
    assert.equal(out.code, 0, `${cmd} --help: ${out.stderr}`);
    assert.match(out.stdout, header, `${cmd} leads with its focused header`);
    assert.match(out.stdout, flag, `${cmd} lists its own flag`);
    assert.doesNotMatch(out.stdout, /pidge setup --claim CODE/, `${cmd} is not the global dump`);
  }
});

test('#240 — `pidge --help` (no command) keeps the global overview; `pidge help ask` is focused', async () => {
  let out = await runCli(['--help'], 1).result;
  assert.equal(out.code, 0);
  assert.match(out.stdout, /pidge setup --claim CODE/, 'global --help lists all commands');

  out = await runCli(['help', 'ask'], 1).result;
  assert.equal(out.code, 0);
  assert.match(out.stdout, /^pidge ask —/, '`pidge help <cmd>` is the focused form');
});

// #241: the manifest-version nag is throttled to once / 24h (per-install cache).
test('#241 — the version nag fires ONCE then is throttled: 5 runs in a row = 1 nag', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.manifestVersion = 99;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-nag5-'));

  let nags = 0;
  for (let i = 0; i < 5; i++) {
    const out = await runCli(['doctor'], port, { XDG_CONFIG_HOME: home }).result;
    if (/manifest v99/.test(out.stderr)) nags++;
  }
  await mock.stop();
  assert.equal(nags, 1, 'the nag must be throttled to once per 24h, not once per call');
});

test('#241 — --quiet-nag and PIDGE_QUIET_NAG=1 silence the nag entirely', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.manifestVersion = 99;

  // --quiet-nag flag (fresh home so the throttle isn't what's hiding it)
  let home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-quiet-'));
  let out = await runCli(['doctor', '--quiet-nag'], port, { XDG_CONFIG_HOME: home }).result;
  assert.doesNotMatch(out.stderr, /manifest v99/, '--quiet-nag silences the nag');

  // PIDGE_QUIET_NAG=1 env, again a fresh home
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-quiet2-'));
  out = await runCli(['doctor'], port, { XDG_CONFIG_HOME: home, PIDGE_QUIET_NAG: '1' }).result;
  assert.doesNotMatch(out.stderr, /manifest v99/, 'PIDGE_QUIET_NAG=1 silences the nag');
  await mock.stop();
});

// #242: --actions accepts a JSON array of custom {id,label} actions.
test('#242 — --actions accepts a JSON array of custom {id,label} actions', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(
    ['notify', '--title', 'Deploy?', '--actions',
      '[{"id":"approve","label":"Aprovar agora"},{"id":"defer","label":"Deixa pra amanhã"}]'],
    port,
  ).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  const sent = mock.state.notifies.at(-1);
  assert.deepEqual(sent.custom_actions, [
    { id: 'approve', label: 'Aprovar agora' },
    { id: 'defer', label: 'Deixa pra amanhã' },
  ]);
  assert.equal(sent.actions, undefined, 'the JSON form does not also set the short actions list');
});

test('#242 — the short comma form still works (compat retro)', async () => {
  const mock = createMock();
  const port = await mock.start();
  // (yes,no,reply would now be REFUSED by lote-5 #2 — use a decision-only combo.)
  const out = await runCli(['notify', '--title', 'x', '--actions', 'yes,no,later'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  const sent = mock.state.notifies.at(-1);
  assert.deepEqual(sent.actions, ['yes', 'no', 'later']);
  assert.equal(sent.custom_actions, undefined);
});

test('#242 — JSON --actions composes with --custom-action (both appended)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(
    ['notify', '--title', 'x', '--actions', '[{"id":"approve","label":"Aprovar"}]',
      '--custom-action', 'defer:Depois'],
    port,
  ).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  const sent = mock.state.notifies.at(-1);
  assert.deepEqual(sent.custom_actions.map((c) => c.id), ['approve', 'defer']);
});

test('#242 — malformed JSON in --actions fails fast LOCALLY (exit 1, no send)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['notify', '--title', 'x', '--actions', '[{"id":"approve"'], port).result;
  await mock.stop();
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, /looks like JSON but didn't parse/);
  assert.equal(mock.state.notifies.length, 0, 'must not reach the server');
});

test('#242 — a JSON item missing id/label is rejected locally with the spelled-out rule', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['notify', '--title', 'x', '--actions', '[{"label":"no id"}]'], port).result;
  await mock.stop();
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, /is invalid|label is required/);
  assert.equal(mock.state.notifies.length, 0);
});

// #244: the generated skill carries the always-on recipe for turn-based agents.
test('#244 — skill install includes the always-on recipe for turn-based agents', async () => {
  const mock = createMock();
  const port = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-skill244-'));

  const child = spawn(process.execPath, [CLI, 'skill', 'install'], {
    cwd: dir,
    env: { ...process.env, PIDGE_URL: `http://127.0.0.1:${port}`, PIDGE_TOKEN: 'hld_test' },
  });
  const out = await new Promise((resolve) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
  await mock.stop();

  assert.equal(out.code, 0, out.stderr);
  const skill = fs.readFileSync(path.join(dir, '.claude', 'skills', 'pidge', 'SKILL.md'), 'utf8');
  assert.match(skill, /always-on/i, 'the recipe section is present');
  assert.match(skill, /pidge listen --follow/, 'Path 1 — interactive window');
  assert.match(skill, /pidge listen --all --timeout 50/, 'Path 2 — supervisor poll');
});

// --- 0.13.0 — template system (#246): type subcommands + skill --------------

// 1) one spec per typed send — each stamps the right template_kind on /notify.

test('perfis-CLI — pidge message stamps template_kind:message and fire-and-forgets', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['message', '--title', 'Build done', '--body', '2m12s'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  const sent = mock.state.notifies.at(-1);
  assert.equal(sent.template_kind, 'message');
  assert.equal(sent.title, 'Build done');
});

test('perfis-CLI — pidge important (⭐ default) stamps template_kind:important', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['important', '--title', 'Review PR', '--body-markdown', '# Summary'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.equal(mock.state.notifies.at(-1).template_kind, 'important');
});

test('perfis-CLI — pidge ask is the shortcut for important + --wait (template_kind:important)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['ask-1'] = {
    responded: true,
    chosen_action: { kind: 'acted', action_id: 'yes', label: 'Sim', text: null },
  };
  const out = await runCli(
    ['ask', '--no-realtime', '--title', 'Approve deploy?', '--actions', 'yes,no', '--correlation-id', 'ask-1'],
    port,
  ).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).action_id, 'yes');
  const sent = mock.state.notifies.at(-1);
  assert.equal(sent.template_kind, 'important', 'ask now sends the canonical `important` (no `ask` type in the married catalog)');
  assert.deepEqual(sent.actions, ['yes', 'no']);
});

test('#246 — pidge event stamps template_kind:event with event_at + lead_minutes', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(
    ['event', '--title', 'Sprint review', '--event-at', '2026-06-26T14:00-03:00', '--lead-minutes', '15'],
    port,
  ).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  const sent = mock.state.notifies.at(-1);
  assert.equal(sent.template_kind, 'event');
  assert.equal(sent.event_at, '2026-06-26T14:00-03:00');
  assert.equal(sent.lead_minutes, 15);
});

test('perfis-CLI — pidge urgent stamps template_kind:urgent; --escalate adds escalate:true', async () => {
  const mock = createMock();
  const port = await mock.start();

  // plain urgent: escalate is NOT set
  let out = await runCli(['urgent', '--title', '503 spike'], port).result;
  assert.equal(out.code, 0, out.stderr);
  let sent = mock.state.notifies.at(-1);
  assert.equal(sent.template_kind, 'urgent');
  assert.equal(sent.escalate, undefined, 'no --escalate ⇒ no escalate flag');

  // urgent --escalate: escalate:true rides the payload
  out = await runCli(['urgent', '--title', 'API down', '--escalate'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  sent = mock.state.notifies.at(-1);
  assert.equal(sent.template_kind, 'urgent');
  assert.equal(sent.escalate, true);
});

test('#246 — pidge live stamps template_kind:live', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['live', '--title', 'Deploy v3.2 — building...'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.equal(mock.state.notifies.at(-1).template_kind, 'live');
});

// --- perfis-CLI: the RESPONSE axis (--wait) composes on ANY type --------------

test('perfis-CLI — --wait on a normal type blocks until the answer and prints chosen_action', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['imp-wait'] = {
    responded: true,
    chosen_action: { kind: 'acted', action_id: 'yes', label: 'Sim', text: null },
  };
  const out = await runCli(
    ['important', '--wait', '--no-realtime', '--title', 'Can I proceed?', '--actions', 'yes,no', '--correlation-id', 'imp-wait'],
    port,
  ).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).action_id, 'yes', '--wait prints chosen_action JSON to stdout');
  assert.equal(mock.state.notifies.at(-1).template_kind, 'important');
});

test('perfis-CLI — WITHOUT --wait a typed send is fire-and-forget (prints the raw 201, exits 0)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['important', '--title', 'fyi-ish', '--actions', 'yes,no'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  // stdout is the raw 201 (has a correlation_id / status), NOT a chosen_action
  const parsed = JSON.parse(out.stdout);
  assert.ok(parsed.status || parsed.correlation_id, 'fire-and-forget prints the 201');
  assert.equal(parsed.action_id, undefined, 'no chosen_action without --wait');
});

test('perfis-CLI — `live --wait` is refused locally (status-only, never answers)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['live', '--wait', '--title', 'Deploy'], port).result;
  await mock.stop();
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, /can't --wait|status-only/);
  assert.equal(mock.state.notifies.length, 0, 'must not reach the server');
});

// --- perfis-CLI: the approval RECIPE (important + Approve/Reject + Face ID + --wait) ---

test('perfis-CLI — pidge approval injects Approve(Face ID)/Reject, waits, prints chosen_action', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['appr-1'] = {
    responded: true,
    chosen_action: { kind: 'acted', action_id: 'grant', label: 'Approve', text: null },
  };
  const out = await runCli(
    ['approval', '--no-realtime', '--title', 'Deploy to production?', '--correlation-id', 'appr-1'],
    port,
  ).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).action_id, 'grant');
  const sent = mock.state.notifies.at(-1);
  assert.equal(sent.template_kind, 'important', 'approval is the important type under the hood');
  // the default pair: Approve gated by Face ID (custom id avoids the built-in collision), Reject destructive
  assert.deepEqual(sent.custom_actions, [
    { id: 'grant', label: 'Approve', biometric: true, terminal: true },
    { id: 'deny', label: 'Reject', style: 'destructive', terminal: true },
  ]);
  assert.equal(sent.actions, undefined, 'approval uses custom_actions, not built-in actions');
});

test('perfis-CLI — pidge approval lets the user OVERRIDE the default pair', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['appr-2'] = {
    responded: true,
    chosen_action: { kind: 'acted', action_id: 'yes', label: 'Sim', text: null },
  };
  const out = await runCli(
    ['approval', '--no-realtime', '--title', 'Go?', '--actions', 'yes,no', '--correlation-id', 'appr-2'],
    port,
  ).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  const sent = mock.state.notifies.at(-1);
  assert.equal(sent.template_kind, 'important');
  assert.deepEqual(sent.actions, ['yes', 'no'], "the user's --actions wins");
  assert.equal(sent.custom_actions, undefined, 'no default pair injected when the user supplies actions');
});

// --- perfis-CLI: compat aliases (old names → new canonical type) --------------

test('perfis-CLI — fyi→message, report→important, alert→urgent (mapped + a rename note)', async () => {
  const mock = createMock();
  const port = await mock.start();

  let out = await runCli(['fyi', '--title', 'x'], port).result;
  assert.equal(out.code, 0, out.stderr);
  assert.equal(mock.state.notifies.at(-1).template_kind, 'message');
  assert.match(out.stderr, /renamed → use `pidge message`/);

  out = await runCli(['report', '--title', 'x'], port).result;
  assert.equal(out.code, 0, out.stderr);
  assert.equal(mock.state.notifies.at(-1).template_kind, 'important');
  assert.match(out.stderr, /renamed → use `pidge important`/);

  out = await runCli(['alert', '--title', 'x', '--escalate'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  const sent = mock.state.notifies.at(-1);
  assert.equal(sent.template_kind, 'urgent');
  assert.equal(sent.escalate, true, 'alert→urgent still honors --escalate');
  assert.match(out.stderr, /renamed → use `pidge urgent`/);
});

test('perfis-CLI — the `ask` alias still requires a way to answer (--actions)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['ask', '--no-realtime', '--title', 'Approve?'], port).result;
  await mock.stop();
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, /--actions required for ask/);
  assert.equal(mock.state.notifies.length, 0, 'must not reach the server');
});

// 2) friendly local errors — fail fast, nothing reaches the server.
// (the `ask`-needs-actions guard is covered above in the alias section.)

test('#246 — pidge event WITHOUT --event-at errors locally with the ISO8601 recipe', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['event', '--title', 'Standup'], port).result;
  await mock.stop();
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, /--event-at required for event/);
  assert.match(out.stderr, /ISO8601/);
  assert.equal(mock.state.notifies.length, 0);
});

test('#246 — pidge event with a non-ISO8601 --event-at errors locally (no send)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['event', '--title', 'Standup', '--event-at', 'amanhã às 14h'], port).result;
  await mock.stop();
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, /not a valid ISO8601/);
  assert.equal(mock.state.notifies.length, 0);
});

test('#246 — an unknown subcommand points at the type catalog (exit 1, no send)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['frobnicate', '--title', 'x'], port).result;
  await mock.stop();
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, /unknown subcommand 'frobnicate'/);
  assert.match(out.stderr, /message · important · urgent · event · live/);
  assert.equal(mock.state.notifies.length, 0);
});

// 3) `pidge notify` is deprecated — warns locally but STILL sends (soft-rollout:
//    no template_kind, the server falls back to fyi). `pidge send` is the same alias.

test('#246 — pidge notify warns DEPRECATED but still sends WITHOUT a template_kind', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['notify', '--title', 'legado'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /deprecated/);
  assert.match(out.stderr, /message · important · urgent · event · live/, 'points at the married catalog');
  const sent = mock.state.notifies.at(-1);
  assert.equal(sent.title, 'legado');
  assert.equal(sent.template_kind, undefined, 'typeless send, server picks the channel default');
});

test('#246 — pidge send is a deprecated alias of notify (warns + sends)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['send', '--title', 'via send'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /`pidge send` is deprecated/);
  assert.equal(mock.state.notifies.at(-1).template_kind, undefined);
});

// 4) the generated skill carries the type catalog table.

test('#246 — skill install includes the "Choose the right type" catalog table', async () => {
  const mock = createMock();
  const port = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-skill246-'));

  const child = spawn(process.execPath, [CLI, 'skill', 'install'], {
    cwd: dir,
    env: { ...process.env, PIDGE_URL: `http://127.0.0.1:${port}`, PIDGE_TOKEN: 'hld_test' },
  });
  const out = await new Promise((resolve) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
  await mock.stop();

  assert.equal(out.code, 0, out.stderr);
  const skill = fs.readFileSync(path.join(dir, '.claude', 'skills', 'pidge', 'SKILL.md'), 'utf8');
  // #274 F3 (B1): the "Two axes" heading is GONE — the spine now leads with the
  // two-approval-paths distinction (the eval-harness probe that was failing).
  assert.match(skill, /Approval has two paths/, 'the two-approval-paths section is present');
  assert.match(skill, /composes on ANY type/i, 'the response axis is explained');
  // the married catalog of 5
  for (const t of ['message', 'important', 'urgent', 'event', 'live']) {
    assert.match(skill, new RegExp(`pidge ${t}`), `skill mentions pidge ${t}`);
  }
  // the two response shortcuts + send-and-go vs wait
  assert.match(skill, /pidge approval/, 'the approval recipe');
  assert.match(skill, /send-and-go vs wait/i, 'teaches send-and-go vs wait');
  // #274 F3 POSITIVE asserts — the hand-authored spine landed in full:
  assert.match(skill, /THE PICKER/, 'the situation→command picker table');
  assert.match(skill, /pidge important --actions yes,no --wait/, 'the blocking-decision picker row');
  assert.match(skill, /ack_requires_biometric/, 'Path B names the profile knob');
  assert.match(skill, /--gated/, 'the Face-ID flag is documented');
  // #274-D skill polish — catalog-first · write-for-the-lock-screen · good reports:
  assert.match(skill, /Write for the lock screen/, 'the lock-screen guidance section is present');
  assert.match(skill, /catalog action FIRST/, 'the Buttons bullet is catalog-first');
  // every gold example now sets a plain --body alongside the rich --body-markdown:
  assert.match(skill, /--body "Signups 1,204/, 'a gold example sets a plain --body');
  assert.ok(
    /--body "Signups 1,204[\s\S]*?--body-markdown \$'\| Metric/.test(skill),
    'the metrics gold example carries BOTH --body and --body-markdown',
  );
  // and the GENERATED appendix still renders (the mock profiles.decision_table row) —
  // proves the generated half survives the hand-authored rewrite.
  assert.match(skill, /no answer needed → profile omitted/, 'the profiles appendix renders');
});

// --- #274 F1 (CLI redesign) -------------------------------------------------

// EDIT 1 — the input chain: --body-markdown-file reads markdown from a file (or
// stdin via "-"), killing the long-markdown shell-quoting footgun.
test('#274 — --body-markdown-file reads the markdown body from a file', async () => {
  const mock = createMock();
  const port = await mock.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-bmf-'));
  const f = path.join(dir, 'body.md');
  const md = '# Deploy report\n\n- one\n- two\n\n`code` and "quotes" that would wreck a shell flag';
  fs.writeFileSync(f, md);

  const out = await runCli(['important', '--title', 't', '--body-markdown-file', f], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.equal(mock.state.notifies.at(-1).body_markdown, md, 'the POST body_markdown equals the file content');
});

test('#274 — --body-markdown-file - reads the markdown body from stdin', async () => {
  const mock = createMock();
  const port = await mock.start();
  const md = '# From stdin\n\npiped markdown — no shell quoting needed';

  const { child, result } = runCli(['important', '--title', 't', '--body-markdown-file', '-'], port);
  child.stdin.write(md);
  child.stdin.end();
  const out = await result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.equal(mock.state.notifies.at(-1).body_markdown, md, 'the POST body_markdown equals the piped stdin');
});

// EDIT 2 — --gated synthesizes exactly one Face-ID confirm custom action.
test('#274 — --gated synthesizes one Face-ID confirm custom action', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['important', '--title', 't', '--gated'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  const ca = mock.state.notifies.at(-1).custom_actions;
  assert.equal(ca.length, 1, 'exactly one gated action');
  assert.equal(ca[0].id, 'confirm_action');
  assert.equal(ca[0].biometric, true);
  assert.equal(ca[0].confirm, true);
  assert.equal(ca[0].terminal, true);
});

test('#274 — --gated does NOT double-gate when the agent already sent a biometric action', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(
    ['important', '--title', 't', '--gated', '--custom-action', 'wire:Wire $10k:biometric'],
    port,
  ).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  const ca = mock.state.notifies.at(-1).custom_actions;
  assert.equal(ca.length, 1, 'the agent\'s own biometric action stands — no confirm_action added on top');
  assert.equal(ca[0].id, 'wire');
});

// EDIT 4 — --template is off the help menu (still parses as silent input).
test('#274 — --help strips --template from discovery but lists --gated + --body-markdown-file', async () => {
  const out = await runCli(['--help'], 1).result;
  assert.equal(out.code, 0, out.stderr);
  assert.doesNotMatch(out.stdout, /--template ID/, '--template is off the help menu');
  assert.match(out.stdout, /--gated/, '--gated is documented');
  assert.match(out.stdout, /--body-markdown-file/, '--body-markdown-file is documented');
});

test('#274 — --template still PARSES as silent input (back-compat) even though it is undocumented', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['notify', '--title', 't', '--template', 'reminder'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.equal(mock.state.notifies.at(-1).template, 'reminder', 'the template field still rides the wire');
});

// EDIT 3 — `hello` default copy is English (USA-first).
test('#274 — hello default copy is English (no Portuguese)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['hello-en'] = {
    responded: true,
    chosen_action: { kind: 'completed', action_id: 'done', label: 'Done ✓', text: null },
  };
  const out = await runCli(['hello', '--no-realtime', '--correlation-id', 'hello-en'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  const sent = mock.state.notifies.at(-1);
  assert.equal(sent.title, 'Your agent is ready 🐦');
  assert.match(sent.body, /Tap Done . to confirm/);
  assert.doesNotMatch(sent.title, /Seu agente/);
  assert.doesNotMatch(sent.body, /Toque em Feito/);
});

// EDIT 6 — BLOCKER B2: a --wait send with decision buttons defaults to 60 min,
// not 600 s, when the 201 carries no suggested_ask_timeout (requires_action key).
test('#274 B2 — a --wait send WITH decision buttons defaults the timeout to 60 min', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['b2-buttons'] = {
    responded: true,
    chosen_action: { kind: 'acted', action_id: 'yes', label: 'Sim', text: null },
  };
  const out = await runCli(
    ['important', '--no-realtime', '--title', 'Approve?', '--actions', 'yes,no', '--wait', '--correlation-id', 'b2-buttons'],
    port,
  ).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /defaulting --wait to 60 min for a decision/, 'the decision-timeout default fired');
});

test('#274 B2 — a no-buttons --wait send still defaults to 600 s (NOT a decision)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['b2-quiet'] = {
    responded: true,
    chosen_action: { kind: 'completed', action_id: 'done', label: 'Feito ✓', text: null },
  };
  const out = await runCli(
    ['important', '--no-realtime', '--title', 'FYI', '--wait', '--correlation-id', 'b2-quiet'],
    port,
  ).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.doesNotMatch(out.stderr, /60 min for a decision/, 'no buttons ⇒ no decision default');
  assert.doesNotMatch(out.stderr, /suggested by template/, 'and no template suggestion either ⇒ the 600 s else-branch');
});

test('#274 B2 — `pidge approval` (injected Face-ID pair) reads requires_action and gets 60 min', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['b2-approval'] = {
    responded: true,
    chosen_action: { kind: 'acted', action_id: 'grant', label: 'Approve', text: null },
  };
  const out = await runCli(
    ['approval', '--no-realtime', '--title', 'Deploy to prod?', '--correlation-id', 'b2-approval'],
    port,
  ).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  // approval injects APPROVAL_ACTIONS (custom_actions) → the server keys
  // requires_action:true on them even though hasAnswerAffordance() is local-false.
  assert.equal(mock.state.notifies.at(-1).custom_actions.length, 2, 'the Approve/Reject pair was injected');
  assert.match(out.stderr, /defaulting --wait to 60 min for a decision/);
});

// --- #34: `pidge approve` — the hook-shaped, deny-default gate -----------------

test('#34 — approve: human taps allow → exit 0, chosen_action JSON on stdout, gated pair in the payload', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['appr-allow'] = {
    responded: true,
    chosen_action: { kind: 'acted', action_id: 'allow', label: 'Allow', text: null },
  };
  const out = await runCli(
    ['approve', 'Run `rm -rf build/`?', '--no-realtime', '--correlation-id', 'appr-allow'],
    port,
  ).result;
  await mock.stop();

  assert.equal(out.code, 0, `expected exit 0 on allow; stderr: ${out.stderr}`);
  assert.equal(JSON.parse(out.stdout).action_id, 'allow', 'chosen_action JSON on stdout');
  const sent = mock.state.notifies.at(-1);
  assert.equal(sent.title, 'Run `rm -rf build/`?', 'the positional question is the title');
  assert.equal(sent.template_kind, 'important', 'approve rides the important type');
  assert.deepEqual(sent.custom_actions, [
    { id: 'allow', label: 'Allow', confirm: true, biometric: true, terminal: true },
    { id: 'deny', label: 'Deny', style: 'destructive', terminal: true },
  ], 'the gated allow(Face-ID)/deny pair is on the wire');
  assert.equal(sent.actions, undefined, 'approve uses custom_actions, not built-in actions');
});

test('#34 — approve: human taps deny → exit 1 (deny explicit, never a false allow)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['appr-deny'] = {
    responded: true,
    chosen_action: { kind: 'acted', action_id: 'deny', label: 'Deny', text: null },
  };
  const out = await runCli(
    ['approve', 'Wire $10k?', '--no-realtime', '--correlation-id', 'appr-deny'],
    port,
  ).result;
  await mock.stop();

  assert.equal(out.code, 1, `expected exit 1 on deny; stderr: ${out.stderr}`);
  assert.equal(JSON.parse(out.stdout).action_id, 'deny', 'chosen_action still printed');
  assert.match(out.stderr, /DENIED/);
});

test('#34 — approve: no answer before timeout → exit 1 (deny-default, fail closed)', async () => {
  const mock = createMock();
  const port = await mock.start();
  // never responds → the wait runs to the (short) deadline
  const out = await runCli(
    ['approve', 'Deploy to prod?', '--no-realtime', '--timeout', '2', '--interval', '1', '--correlation-id', 'appr-to'],
    port,
  ).result;
  await mock.stop();

  assert.equal(out.code, 1, `expected exit 1 on timeout; stderr: ${out.stderr}`);
  assert.match(out.stderr, /DENIED|deny-default/);
  assert.equal(JSON.parse(out.stdout).decision, 'deny', 'a machine-readable deny on stdout');
});

test('#34 — approve: a send that never lands → non-zero (fail closed on error)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifyStatus = 500; // the notify POST fails
  const out = await runCli(
    ['approve', 'Anything?', '--no-realtime', '--timeout', '2', '--correlation-id', 'appr-err'],
    port,
  ).result;
  await mock.stop();

  assert.notEqual(out.code, 0, `a failed send must NOT be exit 0; stderr: ${out.stderr}`);
  assert.equal(out.code, 1, 'approve maps an HTTP send failure to exit 1 (deny-default)');
});

test('#34 — approve over the realtime socket resolves allow → exit 0 (onAnswer threads through WS)', async (t) => {
  if (typeof WebSocket !== 'function') return t.skip('needs Node ≥22');
  const mock = createMock();
  const port = await mock.start();
  mock.state.onSubscribe = (channel) => {
    if (channel !== 'InboxChannel') return;
    const cid = mock.state.notifies[0].correlation_id;
    setTimeout(() => {
      mock.state.notifications[cid] = {
        responded: true,
        chosen_action: { kind: 'acted', action_id: 'allow', label: 'Allow', text: null },
      };
      mock.broadcast('InboxChannel', {
        type: 'event', kind: 'acted', action_id: 'allow', responded: true, correlation_id: cid,
      });
    }, 400);
  };
  const { result } = runCli(['approve', 'Ship it?', '--realtime', '--timeout', '30'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();
  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stdout, /"action_id": "allow"/);
});

test('#34 — approve: --allow-label / --deny-label rename the buttons', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['appr-lbl'] = {
    responded: true,
    chosen_action: { kind: 'acted', action_id: 'allow', label: 'Ship it', text: null },
  };
  const out = await runCli(
    ['approve', 'Ship?', '--no-realtime', '--allow-label', 'Ship it', '--deny-label', 'Hold', '--correlation-id', 'appr-lbl'],
    port,
  ).result;
  await mock.stop();

  assert.equal(out.code, 0, out.stderr);
  const ca = mock.state.notifies.at(-1).custom_actions;
  assert.equal(ca[0].label, 'Ship it');
  assert.equal(ca[1].label, 'Hold');
});

// --- #39: NaN in --timeout/--interval must fail CLOSED, never hang forever ----
// parseInt('abc') → NaN made doWait's deadline NaN (never reached): wait/ask/
// approve/hello/listen polled FOREVER and approve's deny-default timeout branch
// was unreachable. A typo must die IMMEDIATELY (exit 1), before anything is sent.

test('#39 — wait --timeout abc dies immediately (exit 1), never entering the poll loop', async () => {
  // No server at all (port 1): the strict parse must die BEFORE any network happens.
  const { code, stderr } = await runCli(['wait', 'cid-nan', '--no-realtime', '--timeout', 'abc'], 1).result;
  assert.equal(code, 1, `stderr: ${stderr}`);
  assert.match(stderr, /--timeout "abc" is not a number/);
});

test('#39 — wait --interval abc dies the same way', async () => {
  const { code, stderr } = await runCli(['wait', 'cid-nan', '--no-realtime', '--interval', 'abc'], 1).result;
  assert.equal(code, 1, `stderr: ${stderr}`);
  assert.match(stderr, /--interval "abc" is not a number/);
});

test('#39 — approve --timeout abc fails CLOSED (exit 1) BEFORE sending the approval', async () => {
  const mock = createMock();
  const port = await mock.start();
  const { code, stderr } = await runCli(['approve', 'Deploy?', '--no-realtime', '--timeout', 'abc'], port).result;
  await mock.stop();
  assert.equal(code, 1, `stderr: ${stderr}`);
  assert.match(stderr, /is not a number/);
  assert.equal(mock.state.notifies.length, 0, 'nothing was sent — no ghost approval on the phone');
});

test('#39 — ask --timeout abc refuses before the send too', async () => {
  const mock = createMock();
  const port = await mock.start();
  const { code, stderr } = await runCli(
    ['ask', '--title', 'x', '--actions', 'yes,no', '--no-realtime', '--timeout', 'abc'], port,
  ).result;
  await mock.stop();
  assert.equal(code, 1, `stderr: ${stderr}`);
  assert.equal(mock.state.notifies.length, 0, 'nothing was sent');
});

test('#39 — hello --interval abc refuses before the send', async () => {
  const mock = createMock();
  const port = await mock.start();
  const { code, stderr } = await runCli(['hello', '--no-realtime', '--interval', 'abc'], port).result;
  await mock.stop();
  assert.equal(code, 1, `stderr: ${stderr}`);
  assert.equal(mock.state.notifies.length, 0, 'nothing was sent');
});

test('#39 — listen --timeout abc refuses (same eternal-deadline class)', async () => {
  const { code, stderr } = await runCli(['listen', '--no-realtime', '--timeout', 'abc'], 1).result;
  assert.equal(code, 1, `stderr: ${stderr}`);
  assert.match(stderr, /is not a number/);
});

test('#39 — approve on a MALFORMED poll body: deny-default holds, exit 1 on timeout', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.pollGarbage = true;
  const { code, stdout, stderr } = await runCli(
    ['approve', 'Ship?', '--no-realtime', '--timeout', '2', '--interval', '1', '--correlation-id', 'appr-garbage'], port,
  ).result;
  await mock.stop();
  assert.equal(code, 1, `stderr: ${stderr}`);
  assert.match(stdout, /"decision":"deny"/, 'the machine-readable deny lands on stdout');
});

test('#39 — approve when the server is unreachable: exit 2 (the send never left the ground)', async () => {
  const mock = createMock();
  const port = await mock.start();
  await mock.stop(); // nothing listening — the send throws a raw network error
  const { code, stderr } = await runCli(['approve', 'Anything?', '--no-realtime', '--timeout', '2'], port).result;
  assert.equal(code, 2, `stderr: ${stderr}`);
  assert.match(stderr, /send failed \(network\)/);
});

test('#39 — SIGINT mid-wait: approve exits 1 (deny-default), never 0', async () => {
  const mock = createMock();
  const port = await mock.start();
  const { child, result } = runCli(
    ['approve', 'Danger?', '--no-realtime', '--timeout', '30', '--interval', '1', '--correlation-id', 'appr-sigint'], port,
  );
  while (mock.state.notifies.length === 0) await sleep(25); // the approval is in flight
  await sleep(300); // and the wait loop is holding
  child.kill('SIGINT');
  const { code, stderr } = await result;
  await mock.stop();
  assert.equal(code, 1, `stderr: ${stderr}`);
  assert.match(stderr, /interrupted before an answer — DENIED/);
});

// --- #41: docs drift guards ----------------------------------------------------

test('#41 — the README never re-teaches the refused decision+reply combo and documents approve', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.ok(!/--actions yes,no,reply/.test(readme), 'README must not showcase a send the CLI refuses since 0.16.0');
  assert.match(readme, /pidge approve/, 'the approve gate is documented');
  assert.match(readme, /only as trustworthy as/, 'the env trust caveat is spelled out');
});

test('#41 — approve --help tells the true exit-code story (HTTP fail → 1, raw network → 2) + the env caveat', async () => {
  const out = await runCli(['approve', '--help'], 1).result;
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /an HTTP failure on the send → exit 1/);
  assert.match(out.stdout, /ONLY a raw network error \(the send never reached the server at all\) → exit 2/);
  assert.match(out.stdout, /TRUST CAVEAT/);
  assert.ok(!/A send that never left the ground → exit 2/.test(out.stdout), 'the old over-promise is gone');
});

// --- lote-5 #2: refuse a decision button + reply in one send ------------------

test('lote-5 #2 — --actions yes,no,reply is REFUSED locally (exit 1, no send)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['important', '--title', 'x', '--actions', 'yes,no,reply'], port).result;
  await mock.stop();
  assert.equal(out.code, 1, out.stderr);
  assert.match(out.stderr, /can't combine a decision button/);
  assert.equal(mock.state.notifies.length, 0, 'must not reach the server');
});

test('lote-5 #2 — --actions reply ALONE is fine (sends)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['important', '--title', 'x', '--actions', 'reply'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(mock.state.notifies.at(-1).actions, ['reply']);
});

test('lote-5 #2 — done,reply is ALLOWED (done is not a decision; DONE_REPLY is a real category)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const out = await runCli(['important', '--title', 'x', '--actions', 'done,reply'], port).result;
  await mock.stop();
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(mock.state.notifies.at(-1).actions, ['done', 'reply']);
});

// --- lote-5 #3: no stray, description-less `template` line in subcommand help --

test('lote-5 #3 — `pidge important --help` no longer prints a bare `template` line', async () => {
  const out = await runCli(['important', '--help'], 1).result;
  assert.equal(out.code, 0, out.stderr);
  assert.doesNotMatch(out.stdout, /^\s*template\s*$/m, 'no bare description-less template line');
  assert.match(out.stdout, /--subtitle TEXT/, 'the real flags still render');
});

// --- lote-5 #4: --quiet collapses setup to a single status line ---------------

test('lote-5 #4 — setup --quiet collapses onboarding to ONE status line (verbose lines suppressed)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-quiet-'));
  const { result } = runCli(
    ['setup', '--claim', 'claim-ok', '--url', `http://127.0.0.1:${port}`, '--quiet'],
    port, { PIDGE_TOKEN: '', PIDGE_URL: '', XDG_CONFIG_HOME: home }, home,
  );
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stderr, /✓ setup ok — canal "mock"/, 'the single status line');
  assert.doesNotMatch(stderr, /doctor: token found/, 'verbose doctor lines are suppressed');
  assert.doesNotMatch(stderr, /doctor: all good/, 'the verbose all-good line is replaced');
  // the file is still written + the key still never printed
  const written = fs.readFileSync(path.join(home, 'pidge', 'env'), 'utf8');
  assert.match(written, /PIDGE_TOKEN=hld_minted_by_claim/);
  assert.ok(!stderr.includes('hld_minted_by_claim') && !stdout.includes('hld_minted_by_claim'), 'key never leaks');
});

// --- lote-5 #5: listen --all warns on orphaned backlog -------------------------

test('lote-5 #5 — listen --all WARNS that a quick first batch is old backlog, not new arrivals', async () => {
  const mock = createMock();
  const port = await mock.start();
  // pre-existing queue: a composer message + an old notification answer
  mock.state.messages = [
    { id: 20, channel_id: 1, body: 'oi', created_at: 'x', consumed_at: null },
    { id: 21, channel_id: 1, kind: 'notification_reply', body: 'sim', text: 'sim', action_id: 'reply', ref: { correlation_id: 'old-1', title: 'Q antigo', event_kind: 'replied' } },
  ];
  const out = await runCli(['listen', '--all', '--ack-on-read', '--no-realtime', '--timeout', '10', '--interval', '1'], port).result;
  await mock.stop();

  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stderr, /ALREADY queued when this listen started/, 'the orphan-backlog heads-up');
  assert.match(out.stderr, /1 of them are answers to EARLIER notifications/, 'counts the resurfaced notification answers');
  assert.match(out.stderr, /not a cross-channel leak/, 'clarifies it is within-channel, not the #289 leak');
});

test('lote-5 #5 — listen WITHOUT --all does not print the backlog heads-up', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 30, channel_id: 1, body: 'oi', created_at: 'x', consumed_at: null }];
  const out = await runCli(['listen', '--ack-on-read', '--no-realtime', '--timeout', '10', '--interval', '1'], port).result;
  await mock.stop();

  assert.equal(out.code, 0, out.stderr);
  assert.doesNotMatch(out.stderr, /ALREADY queued when this listen started/, 'no --all ⇒ no backlog heads-up');
});


// --- #51: strict message ids on ack (a lazy parseInt acked the WRONG watermark) ---

test('#51: ack --up-to with a correlation_id dies loud BEFORE any HTTP — no wrong watermark', async () => {
  const mock = createMock();
  await mock.start();
  try {
    const { result } = runCli(['ack', '--up-to', '9f2e7c31-ab40-4f11-9e01-77d21c55aa02'], mock.port);
    const { code, stderr } = await result;
    assert.equal(code, 1, 'must exit 1 (fail-closed), not silently ack ids 1..9');
    assert.match(stderr, /numeric message id/i, 'the error must teach the id namespace');
    assert.match(stderr, /correlation_id/i);
    assert.equal(mock.state.acks.length, 0, 'NO ack request may reach the server');
  } finally { await mock.stop(); }
});

test('#51: ack --ids with one bad entry dies loud (no silent drop of the bad id)', async () => {
  const mock = createMock();
  await mock.start();
  try {
    const { result } = runCli(['ack', '--ids', '12,abc,14'], mock.port);
    const { code } = await result;
    assert.equal(code, 1);
    assert.equal(mock.state.acks.length, 0, 'the old .filter() silently acked [12,14]; now nothing goes');
  } finally { await mock.stop(); }
});

test('#51 positive control: a real numeric --up-to still acks normally', async () => {
  const mock = createMock();
  await mock.start();
  try {
    const { result } = runCli(['ack', '--up-to', '103'], mock.port);
    const { code } = await result;
    assert.equal(code, 0);
    assert.equal(mock.state.acks.length, 1);
    assert.equal(mock.state.ackBodies[0].up_to, 103);
  } finally { await mock.stop(); }
});

// --- #52: doctor with a SESSION token must fail loud, not "canal undefined" ---

test('#52: doctor with a ses_ token says SESSION token + exits 2 (server v57 either-track whoami)', async () => {
  const mock = createMock();
  await mock.start();
  try {
    const { result } = runCli(['doctor'], mock.port, { PIDGE_TOKEN: 'ses_abc123' });
    const { code, stderr } = await result;
    assert.equal(code, 2, 'a session token is a misconfig — doctor must not bless it');
    assert.match(stderr, /SESSION token/i);
    assert.doesNotMatch(stderr, /canal "undefined"/, 'the undefined-channel print is the bug');
  } finally { await mock.stop(); }
});
