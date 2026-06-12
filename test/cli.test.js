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
