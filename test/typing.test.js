'use strict';
// `pidge typing` — the three dots on the human's phone while an agent works on
// a reply. The signal is ephemeral, advisory and DISPLAY-ONLY, so the whole
// contract this file guards is small and blunt:
//   · what lands on the wire is exactly one number (`ttl_seconds`) — bare = 60,
//     an explicit number verbatim (the CLAMP is the server's rule, not ours),
//     `off`/`0` = a clear;
//   · a rejected key is a WALL, not a shrug (exit 2, the re-onboard line), and a
//     server that predates the endpoint says so instead of pretending it worked;
//   · a bad argument dies BEFORE any HTTP (`pidge typing 2m` must never become
//     two seconds of dots);
//   · the AUTOMATIC half — `listen --exec` raising the dots when it hands a
//     batch to a handler — is fire-and-forget: it happens, it is opt-outable,
//     and a /typing that 500s or hangs can never cost the round its ack.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn: rawSpawn } = require('node:child_process');
const { track } = require('./spawn-tracker');
const spawn = (cmd, args, opts = {}) => track(rawSpawn(cmd, args, { ...opts, detached: true }));
const { createMock } = require('./mock-server');

const CLI = path.join(__dirname, '..', 'bin', 'pidge.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function runCli(args, port, env = {}) {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      PIDGE_URL: `http://127.0.0.1:${port}`,
      PIDGE_TOKEN: 'hld_test',
      // Isolate the config + HOME so no test touches the developer's real
      // ~/.config/pidge or regenerates their real ~/.claude/skills/pidge.
      XDG_CONFIG_HOME: tmpDir('pidge-typing-'),
      HOME: tmpDir('pidge-typing-home-'),
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

async function waitFor(fn, ms = 8000, step = 50) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(step); }
  return false;
}

test('typing — bare sends the 60 s default and says when the dots go away', async () => {
  const mock = createMock();
  const port = await mock.start();

  const { result } = runCli(['typing'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.deepEqual(mock.state.typingWrites, [{ ttl_seconds: 60 }], 'the default rides the wire explicitly');
  // stdout stays the machine-readable server body.
  assert.match(stdout, /"typing":\s*true/);
  assert.match(stdout, /"typing_until"/);
  // …and the narration names BOTH ways it ends: the TTL and the next send.
  assert.match(stderr, /typing on/);
  assert.match(stderr, /clears at \d{2}:\d{2}:\d{2}/);
  assert.match(stderr, /on your next send/);
});

test('typing <seconds> — the number goes to the server verbatim (the clamp is the server\'s rule)', async () => {
  const mock = createMock();
  const port = await mock.start();

  const { result } = runCli(['typing', '120'], port);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.deepEqual(mock.state.typingWrites, [{ ttl_seconds: 120 }]);
  assert.doesNotMatch(stderr, /CLAMP/, 'an in-range value gets no warning');
});

test('typing — an out-of-range window is WARNED, never rewritten or refused', async () => {
  const mock = createMock();
  const port = await mock.start();

  const { result } = runCli(['typing', '900'], port);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.deepEqual(mock.state.typingWrites, [{ ttl_seconds: 900 }], 'the CLI does not second-guess the server');
  assert.match(stderr, /outside the server's range \(3–300s\)/);
  assert.match(stderr, /CLAMP/);
  // The server clamped to 300 — the "clears at" line must come from ITS answer,
  // not from our 900.
  assert.match(stderr, /typing on/);
});

test('typing off — and its numeric twin `0` — clear the indicator', async () => {
  const mock = createMock();
  const port = await mock.start();

  const off = await runCli(['typing', 'off'], port).result;
  assert.equal(off.code, 0, `stderr: ${off.stderr}`);
  assert.match(off.stdout, /"typing":\s*false/);
  assert.match(off.stderr, /typing off — the indicator is cleared/);

  const zero = await runCli(['typing', '0'], port).result;
  assert.equal(zero.code, 0, `stderr: ${zero.stderr}`);
  assert.match(zero.stderr, /typing off/);

  await mock.stop();
  assert.deepEqual(mock.state.typingWrites, [{ ttl_seconds: 0 }, { ttl_seconds: 0 }]);
});

test('typing — a rejected key is a WALL (exit 2 + the re-onboard line), never a silent shrug', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.typingStatus = 401;

  const { result } = runCli(['typing'], port);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 2, `stderr: ${stderr}`);
  assert.match(stderr, /REJECTED this channel key \(401\)/);
  assert.match(stderr, /pidge setup --claim/, 'it names the fix: a human must re-onboard');
});

test('typing — a server that predates the indicator says so instead of claiming success', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.typingStatus = 404;

  const { result } = runCli(['typing'], port);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 2, `stderr: ${stderr}`);
  assert.match(stderr, /predates the typing indicator/);
  assert.match(stderr, /display-only/, 'and that nothing broke because of it');
});

test('typing — a non-numeric window dies BEFORE any HTTP (never 2 seconds of dots)', async () => {
  const mock = createMock();
  const port = await mock.start();

  const { result } = runCli(['typing', '2m'], port);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 1, `stderr: ${stderr}`);
  assert.match(stderr, /usage: pidge typing/);
  assert.deepEqual(mock.state.typingWrites, [], 'nothing reached the server');
});

test('typing --help — the focused help, and it teaches the habit', async () => {
  const mock = createMock();
  const port = await mock.start();

  const { result } = runCli(['typing', '--help'], port);
  const { code, stdout } = await result;
  await mock.stop();

  assert.equal(code, 0);
  assert.match(stdout, /pidge typing \[SECONDS\|off\]/);
  assert.match(stdout, /more than ~15 seconds/, 'the rule of thumb is IN the help');
  assert.match(stdout, /PIDGE_NO_AUTO_TYPING=1/);
});

// ── the nudge, where an INTERACTIVE agent actually needs it ──────────────────
// The dots matter in the seconds right after a human's message reaches an agent
// that is about to go think. That instant has exactly two doors for an agent
// that is NOT under --exec (which raises them by itself): a `wait` that woke on
// the composer, and a `listen` round that printed messages for it to read.

test('a wait that wakes on a composer message teaches `pidge typing` in its own note', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 71, channel_id: 1, body: 'na verdade, faz outra coisa antes', consumed_at: null }];

  const { result } = runCli(['wait', 'cid-1', '--no-realtime', '--timeout', '10', '--interval', '1'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stdout, /"kind": "human_message"/);
  // The note keeps everything it already said…
  assert.match(stdout, /is STILL unanswered/);
  assert.match(stdout, /pidge wait cid-1/);
  // …and gains the one sentence that belongs at this exact moment.
  assert.match(stdout, /more than ~15 s before you answer\? Run `pidge typing` first/);
});

test('an interactive listen round nudges once when a HUMAN message lands', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 72, channel_id: 1, kind: 'message', body: 'consegue olhar isso?' }];

  const { result } = runCli(['listen', '--timeout', '10', '--interval', '1', '--no-realtime'], port);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const hits = stderr.split('\n').filter((l) => /Run `pidge typing` first/.test(l));
  assert.equal(hits.length, 1, `exactly one nudge, got ${hits.length}:\n${stderr}`);
  assert.match(stderr, /self-expires/, 'it says why forgetting it is not a failure mode');
});

test('an answer to your OWN question is not a message you are about to reply to — no nudge', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{
    id: 73, channel_id: 1, kind: 'notification_reply', action_id: 'yes',
    ref: { correlation_id: 'cid-9', title: 'Migrar o schema?', event_kind: 'acted' },
  }];

  const { result } = runCli(['listen', '--all', '--timeout', '10', '--interval', '1', '--no-realtime'], port);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stderr, /reply to your notification cid-9/, 'the round did deliver the answer');
  assert.doesNotMatch(stderr, /Run `pidge typing` first/, 'nothing to type back to');
});

test('under --exec the nudge is silent — that path raises the dots itself', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 74, channel_id: 1, kind: 'message', body: 'trabalha' }];

  const { result } = runCli(['listen', '--all', '--exec', OK_HANDLER, '--timeout', '20', '--no-realtime'], port);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.doesNotMatch(stderr, /Run `pidge typing` first/, 'no advice to a loop that already did it');
  assert.deepEqual(mock.state.typingWrites, [{ ttl_seconds: 120 }, { ttl_seconds: 0 }],
    'the loop raised them for the handler and put them out after it');
});

// ── the automatic half ──────────────────────────────────────────────────────
// A handler being handed a batch IS "the agent is working on your message", so
// `bridge`/`listen --exec` raise the dots at that one point — and PUT THEM OUT
// when it stops, which is what keeps the signal honest (the dots mean a handler
// is running, never "a message arrived"). It must never be
// anything but fire-and-forget: the round's verdict is the handler's exit code
// and nothing else.
const OK_HANDLER = `${process.execPath} -e "console.log('pidge-summary: fiz o trabalho')"`;

test('listen --exec raises the dots when it hands the batch to the handler', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 61, channel_id: 1, kind: 'message', body: 'oi, pode olhar isso?' }];

  const { result } = runCli(['listen', '--all', '--exec', OK_HANDLER, '--timeout', '20', '--no-realtime'], port);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.deepEqual(
    mock.state.typingWrites,
    [{ ttl_seconds: 120 }, { ttl_seconds: 0 }],
    'raised when the batch reached the handler, and PUT OUT when the handler was done',
  );
  assert.ok(mock.state.acks.length > 0, 'the round still acked normally');
});

test('PIDGE_NO_AUTO_TYPING=1 turns the automatic signal off and changes nothing else', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 62, channel_id: 1, kind: 'message', body: 'e agora?' }];

  const { result } = runCli(
    ['listen', '--all', '--exec', OK_HANDLER, '--timeout', '20', '--no-realtime'],
    port, { PIDGE_NO_AUTO_TYPING: '1' },
  );
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.deepEqual(mock.state.typingWrites, [], 'not one call');
  assert.ok(mock.state.acks.length > 0, 'the round is untouched');
});

test('a /typing that FAILS never costs the round its handler or its ack', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.typingStatus = 500;
  mock.state.messages = [{ id: 63, channel_id: 1, kind: 'message', body: 'trabalha aí' }];

  const { result } = runCli(['listen', '--all', '--exec', OK_HANDLER, '--timeout', '20', '--no-realtime'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `a display-only signal must never fail a round; stderr: ${stderr}`);
  assert.equal(mock.state.typingWrites.length, 2, 'both halves were attempted');
  assert.ok(mock.state.acks.length > 0, 'and the batch was acked all the same');
  assert.doesNotMatch(stdout, /handler_failed/);
  // The failure is genuinely swallowed — no line of noise in an agent's log.
  assert.doesNotMatch(stderr, /typing/i);
});

test('an empty round spawns no handler, so it raises no dots', async () => {
  const mock = createMock();
  const port = await mock.start();

  const { result } = runCli(['listen', '--all', '--exec', OK_HANDLER, '--timeout', '2', '--interval', '1', '--no-realtime'], port);
  const { code } = await result;
  await mock.stop();

  assert.equal(code, 3, 'empty round');
  assert.deepEqual(mock.state.typingWrites, [], 'nobody is working on anything — no dots');
});

// The OTHER caller of the same shared spawn point. `bridge` is a daemon: start
// it, let it work one batch, then take it down.
test('bridge raises the dots on the batch it hands to its handler', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 65, channel_id: 1, kind: 'message', body: 'olha isso pra mim' }];

  const { child, result } = runCli(
    ['bridge', '--exec', OK_HANDLER],
    port,
    { PIDGE_BRIDGE_ALERT: '0', PIDGE_BRIDGE_BACKOFF_BASE: '200', PIDGE_BRIDGE_BACKOFF_MAX: '500' },
  );
  const raised = await waitFor(() => mock.state.typingWrites.length >= 1);
  const acked = await waitFor(() => mock.state.acks.length >= 1);
  child.kill('SIGTERM');
  await result;
  await mock.stop();

  assert.ok(raised, 'the bridge signalled typing when it spawned the handler');
  assert.deepEqual(mock.state.typingWrites[0], { ttl_seconds: 120 });
  assert.ok(acked, 'and the batch was handled + acked as usual');
});

// Guard the ORDER, not just the fact: the signal is fired BEFORE the spawn and
// never awaited, so a wedged /typing cannot delay the handler. A mock that
// never answers the typing POST must still let the round finish promptly.
test('a HANGING /typing does not delay the handler by a single beat', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.typingHangs = true;
  mock.state.messages = [{ id: 64, channel_id: 1, kind: 'message', body: 'rápido' }];

  const t0 = Date.now();
  const { result } = runCli(['listen', '--all', '--exec', OK_HANDLER, '--timeout', '20', '--no-realtime'], port);
  const { code, stderr } = await result;
  const elapsed = Date.now() - t0;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.ok(elapsed < 8000, `the round waited ${elapsed}ms on a signal it must not await`);
  assert.ok(mock.state.acks.length > 0);
  assert.ok(await waitFor(() => mock.state.typingWrites.length === 2, 1000),
    'both halves were still attempted — a wedged signal is dropped, never awaited');
});

// The honesty half (2026-08-25, found on a real phone): the dots must go out when
// the handler stops, not coast to their TTL. "nao sei se vc esta trabalhando ou
// nao... era pra aparecer somente se o agent estiver de fato trabalhando para mim"
// — measured that day as ~50 s of dots with no consumer alive at all.
test('the dots go OUT when the handler finishes, instead of coasting to the TTL', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 64, channel_id: 1, kind: 'message', body: 'olha isso pra mim' }];

  const { result } = runCli(['listen', '--all', '--exec', OK_HANDLER, '--timeout', '20', '--no-realtime'], port);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const last = mock.state.typingWrites[mock.state.typingWrites.length - 1];
  assert.deepEqual(last, { ttl_seconds: 0 }, 'the LAST thing a finished round says is "not typing"');
});

test('a FAILED handler still puts the dots out — no way out of a batch leaves them on', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 65, channel_id: 1, kind: 'message', body: 'e se quebrar?' }];

  const { result } = runCli(
    ['listen', '--all', '--exec', 'sh -c "cat >/dev/null; exit 3"', '--timeout', '20', '--no-realtime'],
    port,
  );
  const { code, stdout } = await result;
  await mock.stop();

  assert.equal(code, 2, 'a failed handler is still a failed round');
  assert.match(stdout, /handler_failed/, 'and it is reported as one');
  assert.equal(mock.state.acks.length, 0, 'nothing acked — the lease re-serves');
  const last = mock.state.typingWrites[mock.state.typingWrites.length - 1];
  assert.deepEqual(last, { ttl_seconds: 0 }, 'but the human is NOT left staring at dots for a handler that died');
});
