'use strict';
// Execution attribution (`pidge run`) acceptance tests:
//   · run start prints the two eval-friendly export lines and POSTs the right
//     mode/label/role; --json prints the raw body instead;
//   · run end signs the end with x-pidge-run from the environment;
//   · ANY call (notify) carries x-pidge-run when PIDGE_RUN_TOKEN is in the env;
//   · the bridge mints one run per handler — injects PIDGE_RUN_TOKEN/SEAL into
//     the handler env, signs the batch ack, and ends the run afterwards;
//   · a live interactive run makes the bridge DEFER (not consume); --no-defer
//     consumes anyway;
//   · an old server (/runs 404) degrades silently — the bridge keeps working
//     unsigned.
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
  const xdg = env.XDG_CONFIG_HOME || tmpDir('pidge-runs-test-');
  const child = spawn(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      PIDGE_URL: `http://127.0.0.1:${port}`,
      PIDGE_TOKEN: 'hld_test',
      PIDGE_BRIDGE_ALERT: '0',
      PIDGE_BRIDGE_BACKOFF_BASE: '200',
      PIDGE_BRIDGE_BACKOFF_MAX: '500',
      PIDGE_BRIDGE_BACKOFF_LONG: '600',
      HOME: tmpDir('pidge-runs-home-'),
      ...env,
      XDG_CONFIG_HOME: xdg,
    },
  });
  const out = { code: null, signal: null, stdout: '', stderr: '' };
  child.stdout.on('data', (c) => { out.stdout += c; });
  child.stderr.on('data', (c) => { out.stderr += c; });
  const result = new Promise((resolve) => {
    child.on('exit', (code, signal) => { out.code = code; out.signal = signal; resolve(out); });
  });
  return { child, result, out, xdg };
}

async function waitFor(fn, ms = 8000, step = 50) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(step); }
  return false;
}

test('run start — prints the two export lines and POSTs the right mode/label/role', async () => {
  const mock = createMock();
  const port = await mock.start();

  const { result } = runCli(
    ['run', 'start', '--mode', 'interactive', '--role', 'main', '--label', 'supervisor-eli'],
    port,
  );
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr:\n${stderr}`);
  assert.match(stdout, /^export PIDGE_RUN_TOKEN=run_test_token_1$/m);
  assert.match(stdout, /^export PIDGE_RUN_SEAL=TST1$/m);
  assert.equal(mock.state.runStarts.length, 1);
  assert.equal(mock.state.runStarts[0].body.mode, 'interactive');
  assert.equal(mock.state.runStarts[0].body.role, 'main');
  assert.equal(mock.state.runStarts[0].body.label, 'supervisor-eli');
  // the friendly narration is stderr, never stdout (stdout must stay eval-safe)
  assert.match(stderr, /run TST1 started/);
});

test('run start --json — prints the raw server body, no export lines', async () => {
  const mock = createMock();
  const port = await mock.start();

  const { result } = runCli(['run', 'start', '--mode', 'poll', '--json'], port);
  const { code, stdout } = await result;
  await mock.stop();

  assert.equal(code, 0);
  assert.doesNotMatch(stdout, /export PIDGE_RUN_TOKEN/);
  const body = JSON.parse(stdout);
  assert.equal(body.run_token, 'run_test_token_1');
  assert.equal(body.run.mode, 'poll');
});

test('run start — a bad --mode / --role is rejected locally (exit 1), no POST', async () => {
  const mock = createMock();
  const port = await mock.start();

  const { result } = runCli(['run', 'start', '--mode', 'wat'], port);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 1);
  assert.match(stderr, /--mode must be/);
  assert.equal(mock.state.runStarts.length, 0);
});

test('run start — an old server (/runs 404) fails clearly, exit 1', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.runsSupported = false;

  const { result } = runCli(['run', 'start', '--mode', 'interactive'], port);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 1);
  assert.match(stderr, /predates execution attribution/);
});

test('run end — signs the end with x-pidge-run from the environment', async () => {
  const mock = createMock();
  const port = await mock.start();

  const { result } = runCli(['run', 'end'], port, { PIDGE_RUN_TOKEN: 'run_abc', PIDGE_RUN_SEAL: 'ZZ99' });
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr:\n${stderr}`);
  assert.deepEqual(mock.state.runEnds, ['run_abc']);
});

test('run end — no PIDGE_RUN_TOKEN in the env is a no-op (exit 0), no POST', async () => {
  const mock = createMock();
  const port = await mock.start();

  const { result } = runCli(['run', 'end'], port);
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0);
  assert.match(stderr, /nothing to end/);
  assert.equal(mock.state.runEnds.length, 0);
});

test('run status — lists live runs and marks the OWN run (PIDGE_RUN_SEAL) with *', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.activeRuns = [
    { seal: 'AAA1', mode: 'poll', role: null, label: 'pidge-poll', last_seen_at: '2026-07-14T12:00:00Z' },
    { seal: 'BBB2', mode: 'interactive', role: 'main', label: 'me', last_seen_at: '2026-07-14T12:05:00Z' },
  ];

  const { result } = runCli(['run', 'status'], port, { PIDGE_RUN_SEAL: 'BBB2' });
  const { code, stdout } = await result;
  await mock.stop();

  assert.equal(code, 0);
  assert.match(stdout, /\*BBB2/);   // own run marked
  assert.match(stdout, / AAA1/);    // sibling not marked
});

test('any call (notify) carries x-pidge-run when PIDGE_RUN_TOKEN is set', async () => {
  const mock = createMock();
  const port = await mock.start();

  const { result } = runCli(['notify', '--title', 'oi', '--body', 'tudo certo'], port, { PIDGE_RUN_TOKEN: 'run_xyz' });
  const { code } = await result;
  await mock.stop();

  assert.equal(code, 0);
  const notifyReq = mock.state.reqLog.find((r) => r.method === 'POST' && r.pathname === '/api/v1/notify');
  assert.ok(notifyReq, 'a notify POST was made');
  assert.equal(notifyReq.run, 'run_xyz', 'the send is signed with the run');
});

test('a call WITHOUT a run token sends no x-pidge-run (unsigned, unchanged)', async () => {
  const mock = createMock();
  const port = await mock.start();

  const { result } = runCli(['notify', '--title', 'oi', '--body', 'sem run'], port);
  const { code } = await result;
  await mock.stop();

  assert.equal(code, 0);
  const notifyReq = mock.state.reqLog.find((r) => r.method === 'POST' && r.pathname === '/api/v1/notify');
  assert.equal(notifyReq.run, null);
});

test('bridge — mints one run per handler: injects PIDGE_RUN_TOKEN/SEAL, signs the ack, ends the run', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 21, kind: 'message', body: 'faz isso', created_at: 'x' }];
  const outFile = path.join(tmpDir('pidge-runenv-'), 'seal.txt');
  // the handler records the run seal + token it was handed, then exits 0
  const handler = `${process.execPath} -e "require('fs').writeFileSync(process.env.OUT, (process.env.PIDGE_RUN_SEAL||'')+':'+(process.env.PIDGE_RUN_TOKEN||''))"`;

  const { child, result, out } = runCli(
    ['bridge', '--exec', handler, '--no-realtime', '--interval', '1'],
    port, { OUT: outFile },
  );

  assert.ok(await waitFor(() => mock.state.ackBodies.length >= 1), `expected an ack; stderr:\n${out.stderr}`);
  const injected = fs.readFileSync(outFile, 'utf8');
  assert.equal(injected, 'TST1:run_test_token_1', 'the handler saw the minted run seal + token in its env');
  // the batch ack was signed with THIS run
  const ackReq = mock.state.reqLog.find((r) => r.method === 'POST' && r.pathname === '/api/v1/messages/ack' && r.run === 'run_test_token_1');
  assert.ok(ackReq, 'the ack is signed with the batch run');
  // the run is ended afterwards, with its own token
  assert.ok(await waitFor(() => mock.state.runEnds.includes('run_test_token_1')), 'the run is ended best-effort');

  child.kill('SIGTERM');
  await result;
  await mock.stop();
});

test('bridge — a live interactive run makes it DEFER (no consume); --no-defer consumes anyway', async () => {
  // defer path
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 31, kind: 'message', body: 'turno do humano', created_at: 'x' }];
  mock.state.activeRuns = [
    { seal: 'INT9', mode: 'interactive', label: 'human-session', last_seen_at: new Date().toISOString() },
  ];

  const a = runCli(['bridge', '--exec', 'true', '--no-realtime', '--interval', '1'], port);
  assert.ok(await waitFor(() => /deferring to interactive run INT9/.test(a.out.stderr)), `stderr:\n${a.out.stderr}`);
  await sleep(400); // give a wrongful consume a chance to land
  assert.equal(mock.state.ackBodies.length, 0, 'a deferring bridge must NOT consume');
  a.child.kill('SIGTERM');
  await a.result;
  await mock.stop();

  // --no-defer path: same live interactive run, but the courtesy is off
  const mock2 = createMock();
  const port2 = await mock2.start();
  mock2.state.messages = [{ id: 33, kind: 'message', body: 'consome', created_at: 'x' }];
  mock2.state.activeRuns = [
    { seal: 'INT9', mode: 'interactive', label: 'human-session', last_seen_at: new Date().toISOString() },
  ];
  const b = runCli(['bridge', '--exec', 'true', '--no-defer', '--no-realtime', '--interval', '1'], port2);
  assert.ok(await waitFor(() => mock2.state.ackBodies.length >= 1), `--no-defer must consume; stderr:\n${b.out.stderr}`);
  assert.doesNotMatch(b.out.stderr, /deferring/);
  b.child.kill('SIGTERM');
  await b.result;
  await mock2.stop();
});

test('bridge — an old server (/runs 404) degrades silently: keeps consuming, unsigned, no env vars', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.runsSupported = false; // /runs, /runs/end, /runs/active all 404
  mock.state.messages = [{ id: 41, kind: 'message', body: 'sem runs', created_at: 'x' }];
  const outFile = path.join(tmpDir('pidge-norun-'), 'seal.txt');
  const handler = `${process.execPath} -e "require('fs').writeFileSync(process.env.OUT, (process.env.PIDGE_RUN_SEAL||'NONE'))"`;

  const { child, result, out } = runCli(
    ['bridge', '--exec', handler, '--no-realtime', '--interval', '1'],
    port, { OUT: outFile },
  );

  assert.ok(await waitFor(() => mock.state.ackBodies.length >= 1), `bridge must keep working; stderr:\n${out.stderr}`);
  assert.equal(fs.readFileSync(outFile, 'utf8'), 'NONE', 'no run env injected on an old server');
  assert.equal(mock.state.runStarts.length, 0);
  assert.equal(mock.state.runEnds.length, 0);
  // the ack still happened, just unsigned
  const ackReq = mock.state.reqLog.find((r) => r.method === 'POST' && r.pathname === '/api/v1/messages/ack');
  assert.ok(ackReq && ackReq.run === null, 'the ack is unsigned on an old server');

  child.kill('SIGTERM');
  await result;
  await mock.stop();
});
