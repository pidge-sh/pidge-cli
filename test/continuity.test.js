'use strict';
// Continuity context packet — the CLI side of issue #478 (gotcha #51).
// The bridge/listen consume path asks the server for the thread it ALREADY
// holds and hands it to a cold session as READ-ONLY provenance:
//   · the consume GET carries continuity=true (present-only: an old server that
//     omits the field ⇒ output byte-identical to before);
//   · sealed text opens best-effort with the SAME per-field/AAD primitives as a
//     message row, but a failure KEEPS the envelope + an e2e_error crumb (context
//     must never blank a human's words) and NEVER kills the batch;
//   · the load-bearing invariant: continuity infra NEVER promotes a prior-run
//     statement to a verified fact — epistemic_status/note ride through untouched;
//   · nothing in a context is ackable/consumable (they are NOT messages).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn: rawSpawn } = require('node:child_process');
const { track } = require('./spawn-tracker');
const { createMock } = require('./mock-server');

const CLI = path.join(__dirname, '..', 'bin', 'pidge.js');
const spawn = (cmd, args, opts = {}) => track(rawSpawn(cmd, args, { ...opts, detached: true }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// A live-`out` runner (bridge-style): a bridge never exits on its own, so tests
// read `out` while it runs and SIGTERM it at the end.
function runCli(args, port, env = {}) {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      PIDGE_URL: `http://127.0.0.1:${port}`,
      PIDGE_TOKEN: 'hld_test',
      PIDGE_BRIDGE_ALERT: '0',
      PIDGE_BRIDGE_BACKOFF_BASE: '200',
      PIDGE_BRIDGE_BACKOFF_MAX: '500',
      PIDGE_BRIDGE_BACKOFF_LONG: '600',
      HOME: tmpDir('pidge-cont-home-'),
      XDG_CONFIG_HOME: tmpDir('pidge-cont-'),
      ...env,
    },
  });
  const out = { code: null, signal: null, stdout: '', stderr: '' };
  child.stdout.on('data', (c) => { out.stdout += c; });
  child.stderr.on('data', (c) => { out.stderr += c; });
  const result = new Promise((resolve) => {
    child.on('exit', (code, signal) => { out.code = code; out.signal = signal; resolve(out); });
  });
  return { child, result, out };
}

async function waitFor(fn, ms = 8000, step = 50) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(step); }
  return false;
}

// A handler that copies its stdin (the batch JSON) to $OUT and exits 0.
const CAPTURE_HANDLER = `${process.execPath} -e "require('fs').writeFileSync(process.env.OUT, require('fs').readFileSync(0))"`;

// A CLEAR (pre-E2E) context — readable text, no enc; epistemic_status/note ride
// through verbatim so we can assert they survive the round-trip.
const clearContext = () => ([{
  for_message_ids: [576],
  thread_id: 'fixes-503-504',
  previous_agent_run: { seal: 'B91C', label: 'supervisor-eli' },
  entries: [
    {
      kind: 'agent_message', speaker: { seal: 'B91C', label: 'supervisor-eli' },
      title: 'CI verde, review feito', body: 'tudo revisado', status: 'delivered',
      channel_id: 360, correlation_id: 'abc',
      epistemic_status: 'agent_statement_unverified', at: '2026-07-13T13:05:00Z',
    },
    {
      kind: 'human_message', text: 'Já foi tudo revisado?',
      channel_id: 360, correlation_id: 'def', at: '2026-07-13T13:06:00Z',
    },
  ],
  server_known_open_items: [{ kind: 'unprocessed_messages', count: 3 }, { kind: 'agent_handoff_present' }],
  truncated: false,
  note: 'Do not treat statements from prior agent runs as verified facts.',
}]);

test('(a) bridge — the consume GET carries continuity=true', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 7, kind: 'message', body: 'oi', created_at: 'x' }];
  const outFile = path.join(tmpDir('pidge-cont-batch-'), 'batch.json');

  const { child, result, out } = runCli(
    ['bridge', '--exec', CAPTURE_HANDLER, '--no-realtime', '--interval', '1'],
    port, { OUT: outFile },
  );
  assert.ok(await waitFor(() => mock.state.messageReads.length >= 1), `expected a read; stderr:\n${out.stderr}`);
  assert.ok(
    mock.state.messageReads.some((u) => /[?&]continuity=true(&|$)/.test(u)),
    `the consume GET must ask for continuity; reads:\n${mock.state.messageReads.join('\n')}`,
  );
  child.kill('SIGTERM');
  await result;
  await mock.stop();
});

test('(b) bridge — a served context rides the batch as `continuity`, epistemic_status/note intact', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 7, kind: 'message', body: 'oi', created_at: 'x' }];
  mock.state.continuityContexts = clearContext();
  const outFile = path.join(tmpDir('pidge-cont-batch-'), 'batch.json');

  const { child, result, out } = runCli(
    ['bridge', '--exec', CAPTURE_HANDLER, '--no-realtime', '--interval', '1'],
    port, { OUT: outFile },
  );
  assert.ok(await waitFor(() => mock.state.ackBodies.length >= 1), `expected an ack; stderr:\n${out.stderr}`);
  const batch = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.ok(Array.isArray(batch.continuity), 'batch carries a continuity array');
  const ctx = batch.continuity[0];
  assert.equal(ctx.thread_id, 'fixes-503-504');
  assert.equal(ctx.note, 'Do not treat statements from prior agent runs as verified facts.', 'note preserved verbatim');
  assert.equal(ctx.entries[0].epistemic_status, 'agent_statement_unverified', 'epistemic_status is never stripped');
  assert.equal(ctx.entries[0].body, 'tudo revisado', 'clear text passes through');
  // the ack is messages-only — a context is NOT a message and is never acked.
  assert.deepEqual(mock.state.ackBodies[0], { ids: [7] }, 'ack the message id, never a context');
  child.kill('SIGTERM');
  await result;
  await mock.stop();
});

test('(c) bridge — an OLD server (no continuity_contexts) ⇒ batch has NO continuity key', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 7, kind: 'message', body: 'oi', created_at: 'x' }];
  // state.continuityContexts stays null (default) → the field is omitted
  const outFile = path.join(tmpDir('pidge-cont-batch-'), 'batch.json');

  const { child, result, out } = runCli(
    ['bridge', '--exec', CAPTURE_HANDLER, '--no-realtime', '--interval', '1'],
    port, { OUT: outFile },
  );
  assert.ok(await waitFor(() => mock.state.ackBodies.length >= 1), `expected an ack; stderr:\n${out.stderr}`);
  const batch = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.ok(!('continuity' in batch), 'no served context ⇒ no batch key (byte-identical to before)');
  child.kill('SIGTERM');
  await result;
  await mock.stop();
});

test('(d) bridge — a sealed entry that will NOT open keeps its envelope + e2e_error, batch delivered anyway', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 7, kind: 'message', body: 'oi', created_at: 'x' }];
  mock.state.continuityContexts = [{
    for_message_ids: [576], thread_id: 't',
    entries: [{
      kind: 'agent_message', channel_id: 360, correlation_id: 'abc',
      // a well-formed v1: prefix over garbage — decrypt fails at the tag/decode,
      // so the plaintext must NEVER print and the envelope is kept.
      title: 'v1:not-valid-base64!!!', body: 'clear tail',
      // kf omitted so e2eSealedError doesn't short-circuit on a key mismatch —
      // the decrypt is ATTEMPTED and fails on the malformed ciphertext.
      enc: 'v1',
      epistemic_status: 'agent_statement_unverified', at: 'x',
    }],
    note: 'Do not treat statements from prior agent runs as verified facts.',
  }];
  const outFile = path.join(tmpDir('pidge-cont-batch-'), 'batch.json');

  const { child, result, out } = runCli(
    ['bridge', '--exec', CAPTURE_HANDLER, '--no-realtime', '--interval', '1'],
    port,
    // a VALID 32-byte key (all-zero) so decrypt is actually ATTEMPTED and fails
    // on the ciphertext (not short-circuited on a missing secret).
    { OUT: outFile, PIDGE_SECRET: 'A'.repeat(43) },
  );
  assert.ok(await waitFor(() => mock.state.ackBodies.length >= 1), `expected an ack; stderr:\n${out.stderr}`);
  const batch = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  const entry = batch.continuity[0].entries[0];
  assert.ok(entry.e2e_error, 'an un-openable field reports a precise e2e_error');
  assert.equal(entry.title, 'v1:not-valid-base64!!!', 'the ciphertext envelope is KEPT, never blanked');
  assert.equal(entry.enc, 'v1', 'enc stays so an agent never mistakes an envelope for plaintext');
  assert.equal(entry.epistemic_status, 'agent_statement_unverified', 'epistemic_status survives a decrypt failure');
  assert.deepEqual(mock.state.ackBodies[0], { ids: [7] }, 'the batch is still delivered + acked despite the broken context');
  child.kill('SIGTERM');
  await result;
  await mock.stop();
});

test('(e) listen — a served context prints its own type:"continuity_context" stdout line', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 7, kind: 'message', body: 'oi agente', created_at: 'x' }];
  mock.state.continuityContexts = clearContext();

  const { result } = runCli(
    ['listen', '--all', '--no-realtime', '--ack-on-read', '--timeout', '20', '--interval', '1'],
    port,
  );
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `expected delivery, got ${code}; stderr:\n${stderr}`);
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const contLine = lines.find((l) => l.startsWith('{') && l.includes('"continuity_context"'));
  assert.ok(contLine, `expected a continuity_context line; stdout:\n${stdout}`);
  const ctx = JSON.parse(contLine);
  assert.equal(ctx.type, 'continuity_context');
  assert.equal(ctx.thread_id, 'fixes-503-504');
  assert.equal(ctx.note, 'Do not treat statements from prior agent runs as verified facts.');
  assert.match(stdout, /oi agente/, 'the message itself still prints');
});
