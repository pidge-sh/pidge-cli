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

function runCli(args, port, env = {}) {
  const child = spawn(process.execPath, [CLI, ...args], {
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

  const { result } = runCli(['listen', '--realtime', '--timeout', '60'], port);

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

  const { result } = runCli(['ask', '--realtime', '--title', 'Aprovar?', '--timeout', '30'], port);
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
  const { result } = runCli(['listen', '--no-realtime', '--timeout', '20'], port, { PIDGE_FETCH_TIMEOUT: '1500' });
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
  assert.match(skill, /template decision/);
  assert.match(skill, /manifest v16/);
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
