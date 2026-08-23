'use strict';
// `pidge bridge` acceptance tests — the hard cases:
//   · ONE handler invocation per batch (batch JSON on stdin, history_hint on
//     the first batch post-restart), exit 0 ⇒ ack --up-to the LAST id;
//   · a failing handler NEVER acks (the server lease is the durability);
//   · the per-channel lock (hash(token)) refuses a second instance, recovers a
//     STALE lock (dead pid — crashed bridge), and `listen` refuses under it;
//   · SIGTERM with a batch in flight: no ack, lock released, exit 0;
//   · 401 = narrate + LOCAL alert + LONG jittered backoff, never a hot loop;
//   · the "channel looks broken" DESKTOP alert is sleep-aware: local/offline
//     failures and sleep/wake gaps never pop it — only a server-shaped streak
//     that persisted awake, once per outage, with a cool-down.
// Plus: stale_from_prior_claim surfaced on listen/catchup/doctor/bridge.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn: rawSpawn } = require('node:child_process');
const { track } = require('./spawn-tracker');
// Own process group per child + group-kill when the file's tests end — a
// straggler (grand)child must never hold this process's event loop open.
const spawn = (cmd, args, opts = {}) => track(rawSpawn(cmd, args, { ...opts, detached: true }));
const { createMock } = require('./mock-server');

const CLI = path.join(__dirname, '..', 'bin', 'pidge.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// The lock lives in the BASE <XDG_CONFIG_HOME>/pidge, keyed by hash(token) —
// mirror bin/pidge.js's derivation so tests can pre-plant / inspect it.
const lockPathFor = (xdg, token = 'hld_test') =>
  path.join(xdg, 'pidge', `bridge-${crypto.createHash('sha256').update(token).digest('hex').slice(0, 16)}.lock`);

function runCli(args, port, env = {}) {
  const xdg = env.XDG_CONFIG_HOME || tmpDir('pidge-bridge-test-');
  const child = spawn(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      PIDGE_URL: `http://127.0.0.1:${port}`,
      PIDGE_TOKEN: 'hld_test',
      PIDGE_BRIDGE_ALERT: '0',           // tests must never pop a desktop notification
      PIDGE_BRIDGE_BACKOFF_BASE: '200',  // test-fast backoff ladder
      PIDGE_BRIDGE_BACKOFF_MAX: '500',
      PIDGE_BRIDGE_BACKOFF_LONG: '600',
      // Isolate HOME so the self-heal never regenerates the developer's REAL
      // ~/.claude/skills/pidge during a test (bridge tests run with cwd = repo).
      HOME: tmpDir('pidge-bridge-home-'),
      ...env,
      XDG_CONFIG_HOME: xdg,
    },
  });
  // `out` is LIVE (a bridge never exits on its own — assertions read it while
  // the process runs); `result` resolves it once the process exits.
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

// A handler that copies its stdin (the batch JSON) to $OUT and exits 0.
const CAPTURE_HANDLER = `${process.execPath} -e "require('fs').writeFileSync(process.env.OUT, require('fs').readFileSync(0))"`;

test('bridge: ONE handler invocation per batch — batch JSON on stdin, exit 0 acks the EXACT ids, history_hint only on the first batch', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [
    { id: 7, kind: 'message', body: 'primeira', created_at: 'x' },
    { id: 9, kind: 'message', body: 'segunda', created_at: 'x' },
  ];
  const outFile = path.join(tmpDir('pidge-batch-'), 'batch.json');

  const { child, result, out } = runCli(
    ['bridge', '--exec', CAPTURE_HANDLER, '--no-realtime', '--interval', '1'],
    port, { OUT: outFile },
  );

  assert.ok(await waitFor(() => mock.state.ackBodies.length >= 1), `expected an ack; stderr:\n${out.stderr}`);
  const batch = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.equal(batch.messages.length, 2, 'the WHOLE tick in one invocation');
  assert.equal(batch.messages[1].body, 'segunda');
  assert.equal(batch.history_hint, true, 'first batch post-restart carries history_hint');
  assert.deepEqual(mock.state.ackBodies[0], { ids: [7, 9] }, 'ack the batch\'s EXACT ids — never an up_to watermark');

  // A second batch is ordinary: no history_hint, its own ack.
  mock.state.messages = [{ id: 12, kind: 'message', body: 'terceira', created_at: 'x' }];
  assert.ok(await waitFor(() => mock.state.ackBodies.length >= 2), `expected a second ack; stderr:\n${out.stderr}`);
  const batch2 = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.equal(batch2.history_hint, undefined, 'history_hint is FIRST-batch-only');
  assert.deepEqual(mock.state.ackBodies[1], { ids: [12] });

  child.kill('SIGTERM');
  const r = await result;
  await mock.stop();
  assert.equal(r.code, 0, `clean SIGTERM must exit 0; stderr:\n${r.stderr}`);
});

test('bridge: a FAILING handler (exit != 0) never acks — the server lease re-serves', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 3, kind: 'message', body: 'oi', created_at: 'x' }];

  const { child, result, out } = runCli(
    ['bridge', '--exec', `${process.execPath} -e "process.exit(1)"`, '--no-realtime', '--interval', '1'],
    port,
  );

  assert.ok(await waitFor(() => /NOT acked/.test(out.stderr)), `stderr:\n${out.stderr}`);
  assert.match(out.stderr, /handler exit 1/);
  await sleep(300); // give a buggy ack a chance to land before asserting
  assert.equal(mock.state.ackBodies.length, 0, 'a failing handler must NEVER ack');

  child.kill('SIGTERM');
  await result;
  await mock.stop();
});

test('bridge: the per-channel lock refuses a SECOND instance (exit 2), and a clean shutdown releases it', async () => {
  const mock = createMock();
  const port = await mock.start();
  const xdg = tmpDir('pidge-lock-');

  const a = runCli(['bridge', '--exec', 'true', '--no-realtime', '--interval', '1'], port, { XDG_CONFIG_HOME: xdg });
  assert.ok(await waitFor(() => fs.existsSync(lockPathFor(xdg))), 'first bridge must take the lock');

  const b = runCli(['bridge', '--exec', 'true', '--no-realtime'], port, { XDG_CONFIG_HOME: xdg });
  const rb = await b.result;
  assert.equal(rb.code, 2, `second instance must refuse; stderr:\n${rb.stderr}`);
  assert.match(rb.stderr, /another consumer already holds this channel/);
  assert.match(rb.stderr, /catchup/); // points at the read-only alternative

  a.child.kill('SIGTERM');
  const ra = await a.result;
  await mock.stop();
  assert.equal(ra.code, 0);
  assert.ok(!fs.existsSync(lockPathFor(xdg)), 'clean shutdown must release the lock');
});

test('bridge: a STALE lock (dead pid — crashed bridge) is recovered, not fatal', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 5, kind: 'message', body: 'oi', created_at: 'x' }];
  const xdg = tmpDir('pidge-stale-');

  // A REAL dead pid: spawn a no-op node, wait for it to exit, reuse its pid.
  const corpse = spawn(process.execPath, ['-e', '']);
  const deadPid = corpse.pid;
  await new Promise((r) => corpse.on('exit', r));
  fs.mkdirSync(path.join(xdg, 'pidge'), { recursive: true });
  fs.writeFileSync(lockPathFor(xdg), JSON.stringify({ pid: deadPid, started_at: 'x', label: 'crashed-bridge' }) + '\n');

  const { child, result, out } = runCli(
    ['bridge', '--exec', 'true', '--no-realtime', '--interval', '1'],
    port, { XDG_CONFIG_HOME: xdg },
  );
  assert.ok(await waitFor(() => mock.state.ackBodies.length >= 1), `a stale lock must not block the takeover; stderr:\n${out.stderr}`);
  assert.match(out.stderr, /STALE lock/);

  child.kill('SIGTERM');
  await result;
  await mock.stop();
});

test('bridge: SIGTERM with a handler IN FLIGHT — batch NOT acked, handler terminated, lock released, exit 0', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 8, kind: 'message', body: 'oi', created_at: 'x' }];
  const marker = path.join(tmpDir('pidge-sig-'), 'started');
  // The handler signals "I started" then hangs far longer than the test.
  const handler = `${process.execPath} -e "require('fs').writeFileSync(process.env.MARK, 'x'); setTimeout(() => {}, 30000)"`;

  const { child, result, xdg } = runCli(
    ['bridge', '--exec', handler, '--no-realtime', '--interval', '1'],
    port, { MARK: marker },
  );
  assert.ok(await waitFor(() => fs.existsSync(marker)), 'the handler must be in flight');

  child.kill('SIGTERM');
  const r = await result;
  await mock.stop();
  assert.equal(r.code, 0, `stderr:\n${r.stderr}`);
  assert.match(r.stderr, /NOT acked/);
  assert.equal(mock.state.ackBodies.length, 0, 'an in-flight batch must NOT be acked on SIGTERM');
  assert.ok(!fs.existsSync(lockPathFor(xdg)), 'the lock must be released on the way out');
});

test('bridge: 401 — narrated LOCAL ALERT + LONG jittered backoff; never a hot loop, never a silent death', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messagesStatus = 401;

  const { child, result, out } = runCli(
    ['bridge', '--exec', 'true', '--no-realtime'],
    port, { PIDGE_BRIDGE_BACKOFF_LONG: '400' },
  );
  assert.ok(await waitFor(() => /LOCAL ALERT/.test(out.stderr)), `stderr:\n${out.stderr}`);
  assert.match(out.stderr, /ROTATED/);

  const readsAtAlert = mock.state.messageReads.length;
  await sleep(900); // ≥2 long-backoff windows (400ms ±25% jitter)
  assert.equal(out.code, null, 'the bridge must stay ALIVE retrying (never die silent)');
  const reads = mock.state.messageReads.length;
  assert.ok(reads > readsAtAlert, 'it must keep RETRYING (backoff, not death)');
  assert.ok(reads - readsAtAlert <= 5, `LONG backoff, not a hot loop — got ${reads - readsAtAlert} reads in 900ms`);

  child.kill('SIGTERM');
  await result;
  await mock.stop();
});

test('regression: a leased row from a FAILED batch is never stamped by a later batch\'s success (ack by exact ids)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.leaseMs = 60000; // model the server visibility lease
  mock.state.messages = [{ id: 3, kind: 'message', body: 'condenada', created_at: 'x' }];
  // The handler FAILS on any batch containing id 3, succeeds otherwise.
  const handler = `${process.execPath} -e "const b=JSON.parse(require('fs').readFileSync(0,'utf8')); process.exit(b.messages.some(m=>m.id===3)?1:0)"`;

  const { child, result, out } = runCli(
    ['bridge', '--exec', handler, '--no-realtime', '--interval', '1'],
    port,
  );
  // Batch [3] served (now under lease), handler exits 1 → not acked.
  assert.ok(await waitFor(() => /handler exit 1/.test(out.stderr)), `stderr:\n${out.stderr}`);
  // A new message arrives; the leased 3 is NOT re-served — the next batch is [5] alone.
  mock.state.messages.push({ id: 5, kind: 'message', body: 'nova', created_at: 'x' });
  assert.ok(await waitFor(() => mock.state.ackBodies.length >= 1), `stderr:\n${out.stderr}`);
  assert.deepEqual(mock.state.ackBodies[0], { ids: [5] }, 'the success acks ONLY what that handler saw');
  assert.ok(mock.state.messages.some((m) => m.id === 3),
    'id 3 (failed, under lease) must STILL be pending — an up_to:5 watermark would have stamped it processed');

  child.kill('SIGTERM');
  await result;
  await mock.stop();
});

test('lock race: two starters racing for the SAME stale lock — exactly ONE wins (atomic rename), the loser exits 2', async () => {
  const mock = createMock();
  const port = await mock.start();
  const xdg = tmpDir('pidge-race-');
  const corpse = spawn(process.execPath, ['-e', '']);
  const deadPid = corpse.pid;
  await new Promise((r) => corpse.on('exit', r));
  fs.mkdirSync(path.join(xdg, 'pidge'), { recursive: true });
  fs.writeFileSync(lockPathFor(xdg), JSON.stringify({ pid: deadPid, started_at: 'x', label: 'crashed' }) + '\n');

  // Both A and B start against the same stale lock. Whichever interleaving the
  // scheduler picks (both read the stale pid, or the slower one already sees
  // the winner's fresh lock), the INVARIANT is: exactly one holds the channel,
  // the other exits 2 — the rename is what makes the both-read-stale case safe.
  const a = runCli(['bridge', '--exec', 'true', '--no-realtime', '--interval', '1'], port, { XDG_CONFIG_HOME: xdg });
  const b = runCli(['bridge', '--exec', 'true', '--no-realtime', '--interval', '1'], port, { XDG_CONFIG_HOME: xdg });

  const loser = await Promise.race([a.result, b.result]);
  assert.equal(loser.code, 2, `the loser must refuse; stderr:\n${loser.stderr}`);
  assert.match(loser.stderr, /REFUSED|lost the/, 'refusal must be narrated');
  const winner = loser === a.out ? b : a;
  await sleep(300); // give a hypothetical double-win a chance to show up
  assert.equal(winner.out.code, null, `the winner must still be running; stderr:\n${winner.out.stderr}`);
  const lock = JSON.parse(fs.readFileSync(lockPathFor(xdg), 'utf8'));
  assert.equal(lock.pid, winner.child.pid, 'the lock must name the winner');

  winner.child.kill('SIGTERM');
  const rw = await winner.result;
  await mock.stop();
  assert.equal(rw.code, 0);
  assert.ok(!fs.existsSync(lockPathFor(xdg)), 'the winner releases on the way out');
});

test('--handler-timeout — a hung handler is SIGTERMed, treated as a FAILED batch (no ack), with periodic narration', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 4, kind: 'message', body: 'trava', created_at: 'x' }];
  const handler = `${process.execPath} -e "setTimeout(() => {}, 30000)"`;

  const { child, result, out } = runCli(
    ['bridge', '--exec', handler, '--no-realtime', '--interval', '1', '--handler-timeout', '2'],
    port, { PIDGE_BRIDGE_NARRATE: '400' }, // heartbeat every 400ms so the test sees it pre-timeout
  );
  assert.ok(await waitFor(() => /handler running for/.test(out.stderr)), `no heartbeat; stderr:\n${out.stderr}`);
  assert.ok(await waitFor(() => /exceeded --handler-timeout/.test(out.stderr)), `no timeout kill; stderr:\n${out.stderr}`);
  assert.ok(await waitFor(() => /NOT acked/.test(out.stderr)), `stderr:\n${out.stderr}`);
  assert.ok(await waitFor(() => /timed out \(--handler-timeout 2s\)/.test(out.stderr)), `stderr:\n${out.stderr}`);
  await sleep(300);
  assert.equal(mock.state.ackBodies.length, 0, 'a timed-out handler must NEVER ack');
  assert.equal(out.code, null, 'the bridge itself stays alive (the failure is the handler\'s)');

  child.kill('SIGTERM');
  const r = await result;
  await mock.stop();
  assert.equal(r.code, 0);
});

test('`listen` REFUSES when a LIVE bridge holds the channel lock (points at catchup)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const xdg = tmpDir('pidge-listen-lock-');
  fs.mkdirSync(path.join(xdg, 'pidge'), { recursive: true });
  // This test process's own pid: guaranteed alive for the duration.
  fs.writeFileSync(lockPathFor(xdg), JSON.stringify({ pid: process.pid, started_at: 'x', label: 'the-bridge' }) + '\n');

  const r = await runCli(['listen', '--no-realtime', '--timeout', '5'], port, { XDG_CONFIG_HOME: xdg }).result;
  await mock.stop();
  assert.equal(r.code, 2, `stderr:\n${r.stderr}`);
  assert.match(r.stderr, /listen REFUSED/);
  assert.match(r.stderr, /pidge catchup/);
});

test('bridge install: launchd template — handler embedded (xml-escaped), Restart=on-failure semantics, NO secret, contract declared', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = tmpDir('pidge-home-');

  const r = await runCli(
    ['bridge', 'install', '--exec', 'claude -p "handle batch"'],
    port, { HOME: home, PIDGE_BRIDGE_PLATFORM: 'darwin' },
  ).result;
  await mock.stop();
  assert.equal(r.code, 0, `stderr:\n${r.stderr}`);
  const info = JSON.parse(r.stdout);
  assert.equal(info.platform, 'launchd');
  assert.ok(info.file.startsWith(path.join(home, 'Library', 'LaunchAgents')), info.file);
  const plist = fs.readFileSync(info.file, 'utf8');
  assert.match(plist, /claude -p &quot;handle batch&quot;/, 'the handler must be xml-escaped');
  assert.match(plist, /SuccessfulExit/, 'KeepAlive.SuccessfulExit=false = Restart=on-failure');
  assert.match(plist, /<key>PATH<\/key>/, 'the daemon needs the current PATH — launchd\'s minimal one 127s a homebrew/nvm handler');
  assert.ok(!plist.includes('hld_test'), 'the template must NEVER embed the key');
  assert.equal(mock.state.operatingContract.listen_mode.value, 'external_daemon', 'install declares the contract');
  assert.equal(info.listen_mode_declared, true);
});

test('bridge install: systemd template — Restart=on-failure, quoted ExecStart, NO secret', async () => {
  const mock = createMock();
  const port = await mock.start();

  const run = runCli(
    ['bridge', 'install', '--exec', 'codex exec "handle batch"'],
    port, { PIDGE_BRIDGE_PLATFORM: 'linux' },
  );
  const r = await run.result;
  await mock.stop();
  assert.equal(r.code, 0, `stderr:\n${r.stderr}`);
  const info = JSON.parse(r.stdout);
  assert.equal(info.platform, 'systemd');
  assert.ok(info.file.startsWith(path.join(run.xdg, 'systemd', 'user')), info.file);
  const unit = fs.readFileSync(info.file, 'utf8');
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /Wants=network-online\.target/, 'After alone only orders — Wants pulls the target in');
  assert.match(unit, /Environment="PATH=/, 'the daemon needs the current PATH');
  assert.match(unit, /bridge --exec "codex exec \\"handle batch\\""/, 'ExecStart must quote+escape the handler');
  assert.ok(!unit.includes('hld_test'), 'the template must NEVER embed the key');
});

test('bridge install without --exec is a usage error (exit 1)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const r = await runCli(['bridge', 'install'], port, { PIDGE_BRIDGE_PLATFORM: 'linux' }).result;
  const r2 = await runCli(['bridge'], port).result;
  await mock.stop();
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--exec/);
  assert.equal(r2.code, 1, 'bare `pidge bridge` without --exec is usage too');
  assert.match(r2.stderr, /--exec/);
});

test('stale_from_prior_claim — warned ONCE on the listen header, on catchup, on doctor, and at bridge boot', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.staleFromPriorClaim = true;

  const listen = await runCli(['listen', '--no-realtime', '--timeout', '2', '--interval', '1'], port).result;
  assert.match(listen.stderr, /PRIOR claim/, `listen stderr:\n${listen.stderr}`);
  assert.equal(listen.stderr.split('\n').filter((l) => /PRIOR claim/.test(l)).length, 1, 'once per session, not once per poll');

  const catchup = await runCli(['catchup'], port).result;
  assert.equal(catchup.code, 0);
  assert.match(catchup.stderr, /PRIOR claim/);

  const doctor = await runCli(['doctor'], port).result;
  assert.match(doctor.stderr, /PRIOR claim/);
  assert.equal(doctor.code, 0, 'the warning is advisory — never exit 2');

  const b = runCli(['bridge', '--exec', 'true', '--no-realtime', '--interval', '1'], port);
  assert.ok(await waitFor(() => /PRIOR claim/.test(b.out.stderr)), `bridge stderr:\n${b.out.stderr}`);
  b.child.kill('SIGTERM');
  await b.result;
  await mock.stop();
});

// Summary marker: the handler tells the next session WHAT it did via a marker line on stdout
// — `pidge-summary: <text>`. The bridge tees stdout to its log AND scans it
// (streamed, never buffered) for the LAST such line, then acks with that summary.
// A helper: a handler that drains stdin, prints the given lines, exits 0. The JS
// uses SINGLE-quoted string literals so it survives the outer `-e "…"` double
// quotes (JSON.stringify would inject double quotes that close the shell arg — a
// `syntax error near '('` on any line with parens). No process.exit() — node
// drains stdout and exits naturally (a force-exit can truncate the pipe write).
// Lines must not contain single quotes (none of the tests below do).
const summaryHandler = (lines) =>
  `${process.execPath} -e "require('fs').readFileSync(0); ${lines.map((l) => `console.log('${l}')`).join('; ')}"`;

test('summary marker: a handler that prints `pidge-summary:` → the ack carries that summary', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 7, kind: 'message', body: 'oi', created_at: 'x' }];
  const handler = summaryHandler(['fiz um trabalho qualquer (log normal)', 'pidge-summary: reiniciei o worker e limpei a fila']);

  const { child, result, out } = runCli(['bridge', '--exec', handler, '--no-realtime', '--interval', '1'], port);
  assert.ok(await waitFor(() => mock.state.ackBodies.length >= 1), `stderr:\n${out.stderr}`);
  assert.deepEqual(mock.state.ackBodies[0].ids, [7], 'the exact batch ids still ack');
  assert.equal(mock.state.ackBodies[0].summary, 'reiniciei o worker e limpei a fila', 'the summary rides the ack');
  assert.match(out.stdout, /log normal/, 'the handler stdout is still teed to the bridge log (not swallowed)');

  child.kill('SIGTERM');
  await result;
  await mock.stop();
});

test('summary marker: NO marker → the ack has no summary field (never invented)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 7, kind: 'message', body: 'oi', created_at: 'x' }];
  const handler = summaryHandler(['just some logs', 'nothing to attribute here']);

  const { child, result, out } = runCli(['bridge', '--exec', handler, '--no-realtime', '--interval', '1'], port);
  assert.ok(await waitFor(() => mock.state.ackBodies.length >= 1), `stderr:\n${out.stderr}`);
  assert.deepEqual(mock.state.ackBodies[0], { ids: [7] }, 'no summary key when the handler prints no marker');

  child.kill('SIGTERM');
  await result;
  await mock.stop();
});

test('summary marker: a marker in the MIDDLE of the output — the LAST one wins', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 7, kind: 'message', body: 'oi', created_at: 'x' }];
  const handler = summaryHandler(['pidge-summary: primeira tentativa', 'mais output no meio', 'pidge-summary: versao final', 'rodape irrelevante']);

  const { child, result, out } = runCli(['bridge', '--exec', handler, '--no-realtime', '--interval', '1'], port);
  assert.ok(await waitFor(() => mock.state.ackBodies.length >= 1), `stderr:\n${out.stderr}`);
  assert.equal(mock.state.ackBodies[0].summary, 'versao final', 'the LAST marker line is the summary');

  child.kill('SIGTERM');
  await result;
  await mock.stop();
});

test('summary marker: a marker longer than 1000 chars is truncated without error', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 7, kind: 'message', body: 'oi', created_at: 'x' }];
  const handler = `${process.execPath} -e "require('fs').readFileSync(0); console.log('pidge-summary: ' + 'y'.repeat(1500)); process.exit(0)"`;

  const { child, result, out } = runCli(['bridge', '--exec', handler, '--no-realtime', '--interval', '1'], port);
  assert.ok(await waitFor(() => mock.state.ackBodies.length >= 1), `stderr:\n${out.stderr}`);
  assert.equal(mock.state.ackBodies[0].summary.length, 1000, 'the summary is capped at 1000 before it leaves the machine');
  assert.ok(/^y+$/.test(mock.state.ackBodies[0].summary), 'the capped value is the marker content');

  child.kill('SIGTERM');
  await result;
  await mock.stop();
});

test('summary marker (adversarial): a handler that dumps MB of output then a trailing marker — no wedge, no OOM, marker still captured', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 7, kind: 'message', body: 'oi', created_at: 'x' }];
  // ~4MB on a SINGLE unterminated line, then a newline, then the marker line.
  // The scanner must bound the unterminated tail (stream, not buffer) and still
  // catch the marker that follows. No process.exit() — let node drain stdout and
  // exit naturally (a force-exit would truncate the async pipe write, which is the
  // handler's bug to avoid, not the bridge's; a real LLM CLI flushes before exit).
  const handler = `${process.execPath} -e "require('fs').readFileSync(0); const big='z'.repeat(200000); for(let i=0;i<20;i++) process.stdout.write(big); process.stdout.write('\\npidge-summary: sobrevivi ao dump\\n')"`;

  const { child, result, out } = runCli(['bridge', '--exec', handler, '--no-realtime', '--interval', '1'], port);
  assert.ok(await waitFor(() => mock.state.ackBodies.length >= 1, 12000), `the loop must not wedge on a big dump; stderr:\n${out.stderr}`);
  assert.equal(mock.state.ackBodies[0].summary, 'sobrevivi ao dump', 'the trailing marker survives a multi-MB stream');

  child.kill('SIGTERM');
  await result;
  await mock.stop();
});

test('stale_from_prior_claim: no warning when the flag is absent/false (the default)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const r = await runCli(['listen', '--no-realtime', '--timeout', '2', '--interval', '1'], port).result;
  await mock.stop();
  assert.ok(!/PRIOR claim/.test(r.stderr), `unexpected warning:\n${r.stderr}`);
});

// 0.26.0 — issue #82: during a long handler run the loop issues no consume GET,
// so (WS down) presence starved and the human saw "offline" while the bridge
// worked. Fix: while the handler thinks, renew the batch's lease every RENEW_MS
// (POST /ack {ids, state:"delivered"}) — the lease can't lapse mid-run, and a
// v79+ server refreshes "listening now" presence on the renew. The heartbeat
// stops the MOMENT the handler exits: a FAILED batch must lapse back to the queue.
test('bridge: renew heartbeat during a handler run — the batch\'s EXACT ids every interval, gone the moment the handler exits', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 7, kind: 'message', body: 'demorada', created_at: 'x' }];
  // thinks for ~1.4s — at PIDGE_BRIDGE_RENEW=300ms that's several pings mid-run
  const handler = `${process.execPath} -e "require('fs').readFileSync(0); setTimeout(() => {}, 1400)"`;

  const { child, result, out } = runCli(
    ['bridge', '--exec', handler, '--no-realtime', '--interval', '1'],
    port, { PIDGE_BRIDGE_RENEW: '300' },
  );
  // pings land WHILE the handler runs — before any terminal ack
  assert.ok(await waitFor(() => mock.state.ackBodies.some((b) => b.state === 'delivered')), `expected a renew ping; stderr:\n${out.stderr}`);
  assert.deepEqual(mock.state.ackBodies.find((b) => b.state === 'delivered'), { ids: [7], state: 'delivered' },
    'the ping renews the batch\'s EXACT ids (state=delivered — never a consume)');
  assert.ok(!mock.state.ackBodies.some((b) => b.state === undefined), 'no terminal ack yet — the handler is still running');

  // the terminal ack still lands when the handler exits 0 — the heartbeat never replaces it
  assert.ok(await waitFor(() => mock.state.ackBodies.some((b) => b.state === undefined)), `expected the terminal ack; stderr:\n${out.stderr}`);
  assert.deepEqual(mock.state.ackBodies.find((b) => b.state === undefined).ids, [7]);

  // after the handler exited, the heartbeat is GONE (>2 renew windows of silence)
  const pingsAtExit = mock.state.ackBodies.filter((b) => b.state === 'delivered').length;
  assert.ok(pingsAtExit >= 1, 'at least one mid-run ping');
  await sleep(800);
  assert.equal(mock.state.ackBodies.filter((b) => b.state === 'delivered').length, pingsAtExit,
    'the heartbeat stops the moment the handler exits — a later batch failure must be able to lapse');

  child.kill('SIGTERM');
  await result;
  await mock.stop();
});

// `pidge online` — sugar for `listen --all`, one word, so a pasted prompt can
// say "stay online: pidge online". Same loop (fallthrough, no duplicated
// implementation); --all forced; exit 3 carries the relaunch nudge.
test('`pidge online` = listen --all: reads the UNIFIED queue, exits 3 empty with the relaunch nudge', async () => {
  const mock = createMock();
  const port = await mock.start();
  const r = await runCli(['online', '--no-realtime', '--timeout', '2', '--interval', '1'], port).result;
  await mock.stop();
  assert.equal(r.code, 3, `stderr:\n${r.stderr}`);
  assert.ok(mock.state.messageReads.some((u) => u.includes('all=true')),
    `online must consume the UNIFIED queue (--all forced); reads:\n${mock.state.messageReads.join('\n')}`);
  assert.match(r.stderr, /Relaunch the listener/);
});

test('`pidge online` delivers like listen --all — a notification_reply row reaches stdout', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 9, kind: 'notification_reply', text: 'yes', created_at: 'x', ref: { correlation_id: 'c1', title: 'Q', event_kind: 'action' } }];
  const r = await runCli(['online', '--no-realtime', '--timeout', '10', '--interval', '1'], port).result;
  await mock.stop();
  assert.equal(r.code, 0, `stderr:\n${r.stderr}`);
  assert.match(r.stdout, /notification_reply/, 'the single ear hears answers, not just composer messages');
});

test('multi-runtime — bridge warns on consumer_conflict at BOOT (whoami), once', async () => {
  const mock = createMock();
  const port = await mock.start();
  // whoami: a live sibling consumer alongside whoever boots this bridge.
  mock.state.consumers = [
    { fingerprint: 'fp_sibling', label: 'claude-interactive', listening: true, live: true },
    { fingerprint: 'fp_other', label: 'another', listening: false, live: true },
  ];
  mock.state.consumerConflict = true;

  const b = runCli(['bridge', '--exec', 'true', '--no-realtime', '--interval', '1'], port);
  assert.ok(await waitFor(() => /consumer_conflict/.test(b.out.stderr)),
    `bridge boot must warn on consumer_conflict; stderr:\n${b.out.stderr}`);
  // let a couple of poll ticks pass — the warning must NOT repeat per tick
  await sleep(1500);
  const hits = b.out.stderr.split('\n').filter((l) => /another consumer is live on this channel/.test(l)).length;
  assert.equal(hits, 1, `once per process, not once per tick; stderr:\n${b.out.stderr}`);
  b.child.kill('SIGTERM');
  await b.result;
  await mock.stop();
});

// Gate hygiene (server >= manifest v83): a notification_reply with ref.gated
// (a Face-ID gate outcome — pidge approve allow / approval grant / --gated
// confirm) is acked by the bridge itself and NEVER handed to a handler: its
// bare label ("Submit") reads like a fresh imperative command to an LLM, and
// the asker already heard the answer on its own wait/webhook. Old servers
// never set ref.gated, so the filter is a no-op there.
test('bridge: a gated reply is acked WITHOUT a handler; the rest of the batch still spawns', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [
    { id: 21, kind: 'notification_reply', body: 'Submit', created_at: 'x',
      ref: { correlation_id: 'gate-1', title: 'Approve: submit?', event_kind: 'acted', gated: true } },
    { id: 22, kind: 'message', body: 'trabalho real', created_at: 'x' },
  ];
  const outFile = path.join(tmpDir('pidge-gated-'), 'batch.json');

  const { child, result, out } = runCli(
    ['bridge', '--exec', CAPTURE_HANDLER, '--no-realtime', '--interval', '1'],
    port, { OUT: outFile },
  );

  // Two acks land: the gated auto-ack (id 21) and the handler batch (id 22).
  assert.ok(await waitFor(() => mock.state.ackBodies.length >= 2), `expected both acks; stderr:\n${out.stderr}`);
  const gatedAck = mock.state.ackBodies.find((b) => Array.isArray(b.ids) && b.ids.includes(21));
  assert.ok(gatedAck, 'the gated row is acked by the bridge itself');
  assert.match(gatedAck.summary || '', /gate answer/i, 'the ack summary says WHY (provenance, not silence)');
  const batchAck = mock.state.ackBodies.find((b) => Array.isArray(b.ids) && b.ids.includes(22));
  assert.ok(batchAck, 'the real work is still handled + acked');
  assert.ok(!(batchAck.ids || []).includes(21), 'the gated id never rides the handler batch ack');

  const batch = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.equal(batch.messages.length, 1, 'the handler sees ONLY the real work');
  assert.equal(batch.messages[0].id, 22);
  assert.ok(!JSON.stringify(batch).includes('Submit'), 'no gate body ever reaches an LLM handler');
  assert.match(out.stderr, /gate answer\(s\) acked WITHOUT spawning/, 'loud log line, never a silent eat');

  child.kill('SIGTERM');
  const r = await result;
  await mock.stop();
  assert.equal(r.code, 0, `stderr:\n${r.stderr}`);
});

test('bridge: incident regression — an all-gated batch (approve --allow-label Submit) spawns NOTHING', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [
    { id: 31, kind: 'notification_reply', body: 'Submit', created_at: 'x',
      ref: { correlation_id: 'gate-2', title: 'Approve: submit the order?', event_kind: 'acted', gated: true } },
  ];
  const outFile = path.join(tmpDir('pidge-gated-only-'), 'batch.json');

  const { child, result, out } = runCli(
    ['bridge', '--exec', CAPTURE_HANDLER, '--no-realtime', '--interval', '1'],
    port, { OUT: outFile },
  );

  assert.ok(await waitFor(() => mock.state.ackBodies.some((b) => (b.ids || []).includes(31))),
    `the gated row must be acked; stderr:\n${out.stderr}`);
  await sleep(500); // give a buggy spawn a chance to write before asserting
  assert.ok(!fs.existsSync(outFile), 'no handler ever ran — no LLM call for a gate outcome');

  child.kill('SIGTERM');
  const r = await result;
  await mock.stop();
  assert.equal(r.code, 0, `stderr:\n${r.stderr}`);
});

test('bridge: an UNMARKED reply (old server / normal answer) still spawns a handler — no over-filtering', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [
    { id: 41, kind: 'notification_reply', body: 'Approve', created_at: 'x',
      ref: { correlation_id: 'pathb-1', title: 'Deploy pronto', event_kind: 'acted' } },
  ];
  const outFile = path.join(tmpDir('pidge-unmarked-'), 'batch.json');

  const { child, result, out } = runCli(
    ['bridge', '--exec', CAPTURE_HANDLER, '--no-realtime', '--interval', '1'],
    port, { OUT: outFile },
  );

  assert.ok(await waitFor(() => mock.state.ackBodies.some((b) => (b.ids || []).includes(41))), `stderr:\n${out.stderr}`);
  const batch = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.equal(batch.messages[0].id, 41, 'a Path-B approve / old-server reply keeps flowing to the handler');

  child.kill('SIGTERM');
  const r = await result;
  await mock.stop();
  assert.equal(r.code, 0, `stderr:\n${r.stderr}`);
});

test('bridge: the per-batch run is minted with a SHORT sliding TTL (never the 24h interactive default)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [
    { id: 51, kind: 'message', body: 'oi', created_at: 'x' },
  ];
  const outFile = path.join(tmpDir('pidge-run-ttl-'), 'batch.json');

  const { child, result, out } = runCli(
    ['bridge', '--exec', CAPTURE_HANDLER, '--no-realtime', '--interval', '1'],
    port, { OUT: outFile },
  );

  assert.ok(await waitFor(() => mock.state.ackBodies.some((b) => (b.ids || []).includes(51))), `stderr:\n${out.stderr}`);
  child.kill('SIGTERM');
  const r = await result;
  await mock.stop();
  assert.equal(r.code, 0, `stderr:\n${r.stderr}`);

  const starts = mock.state.runStarts.filter((s) => s.body.mode === 'bridge');
  assert.ok(starts.length >= 1, 'the batch minted a bridge run');
  for (const s of starts) {
    assert.equal(s.body.ephemeral, true);
    assert.equal(s.body.ttl_seconds, 3600,
      'default --handler-timeout (1800s) ⇒ ttl max(3600, 2×timeout) = 3600 — a dead handler expires in ~1h, not 24h');
  }
});

// ── sleep-aware "channel looks broken" triage (issue: one sleep/wake cycle per
// desktop alert — 30 alerts in a night, all of them the Mac napping). The pure
// halves ride the CLI's test seam; the wiring is exercised end-to-end below.
const { classifyBridgeFailure, sleptThrough, createBridgeAlertPolicy } = require(CLI);

test('triage: failure classification — local errnos / offline / just-woke are LOCAL; HTTP answers and clean-network failures are SERVER-shaped', () => {
  // an errno that means THIS machine's network is gone → local, regardless of the rest
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH'])
    assert.equal(classifyBridgeFailure({ code, hasNetwork: true }), 'local', code);
  // ANY HTTP answer proves the path — even a 502 is the server's problem
  assert.equal(classifyBridgeFailure({ status: 502 }), 'server');
  assert.equal(classifyBridgeFailure({ status: 500, hasNetwork: false }), 'server');
  // ECONNREFUSED on a working network = the server's port is closed → alertable
  assert.equal(classifyBridgeFailure({ code: 'ECONNREFUSED', hasNetwork: true }), 'server');
  // …but with no route at all it's this machine, not the server
  assert.equal(classifyBridgeFailure({ code: 'ECONNREFUSED', hasNetwork: false }), 'local');
  // an abort/timeout right after a detected sleep = wake turbulence
  assert.equal(classifyBridgeFailure({ code: null, hasNetwork: true, justWoke: true }), 'local');
  // a bare timeout with the network up and no recent sleep → server-shaped
  assert.equal(classifyBridgeFailure({ code: null, hasNetwork: true, justWoke: false }), 'server');
  // no non-internal interface ⇒ offline, whatever the error looked like
  assert.equal(classifyBridgeFailure({ code: 'ETIMEDOUT', hasNetwork: false }), 'local');
});

test('triage: sleptThrough — 2× the expected wait plus 30s of slack', () => {
  const POLL = 35000; // the bridge's long-poll ceiling (wait=25 + 10s grace)
  assert.equal(sleptThrough(POLL, POLL + 5000), false, 'a slow poll is not a sleep');
  assert.equal(sleptThrough(POLL, 2 * POLL + 30000), false, 'exactly at the threshold: not yet');
  assert.equal(sleptThrough(POLL, 2 * POLL + 30001), true, 'past it: the machine slept');
  assert.equal(sleptThrough(2000, 40000), true, 'a 2s backoff that took 40s measured a sleep');
  assert.equal(sleptThrough(2000, 30000), false, 'a 2s backoff 28s late is ugly but awake');
});

test('triage: alert policy — local never pops; server needs streak + awake persistence; one per outage + cool-down; sleep resets the streak', () => {
  const MIN = 60000;
  const p = createBridgeAlertPolicy({ brokenAfter: 5, minStreakMs: 10 * MIN, cooldownMs: 240 * MIN });
  let now = 1000000;

  // LOCAL failures never alert, no matter how many or how long
  for (let i = 0; i < 50; i++) assert.equal(p.fail('local', now += MIN), null);
  assert.equal(p.recovered(), false, 'no alert fired ⇒ no recovered notice');

  // 5 quick server-shaped failures: streak yes, awake persistence no → quiet
  for (let i = 0; i < 5; i++) assert.equal(p.fail('server', now += 1000), null);
  // …the SAME outage persisting past 10 awake minutes → exactly ONE alert
  const verdict = p.fail('server', now += 10 * MIN);
  assert.ok(verdict && verdict.awakeMs >= 10 * MIN, 'alert fires with the streak age');
  assert.equal(p.fail('server', now += MIN), null, 'latched: one alert per outage');
  assert.equal(p.alerted, true);

  // recovery closes the outage and reports the alert had fired (→ quiet closure)
  assert.equal(p.recovered(), true);
  assert.equal(p.recovered(), false, 'the report is one-shot');

  // a NEW long outage inside the 4h cool-down stays quiet…
  for (let i = 0; i < 20; i++) assert.equal(p.fail('server', now += MIN), null);
  assert.equal(p.recovered(), false);
  // …and past the cool-down a persistent outage alerts again
  now += 241 * MIN;
  for (let i = 0; i < 4; i++) assert.equal(p.fail('server', now += MIN), null);
  assert.ok(p.fail('server', now += 10 * MIN), 'cool-down elapsed + persistent streak ⇒ alert');
  p.recovered();

  // a detected sleep resets the streak: post-wake failures restart the clock
  const q = createBridgeAlertPolicy({ brokenAfter: 2, minStreakMs: 10 * MIN, cooldownMs: 240 * MIN });
  let t = 5000000;
  q.fail('server', t += MIN); q.fail('server', t += MIN); // streak building
  q.sleptReset();
  assert.equal(q.fail('server', t += 12 * MIN), null, 'first failure after the sleep restarts the streak');
  assert.equal(q.fail('server', t += MIN), null, 'streak count restarted too');
  assert.ok(q.fail('server', t += 10 * MIN), 'only a fresh 10-awake-minute streak alerts');
});

test('bridge: server-shaped outage — desktop alert only after the awake-persistence window, ONE per outage, quiet closure on recovery', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messagesStatus = 500; // server answers = server-shaped, no 401 path

  const { child, result, out } = runCli(
    ['bridge', '--exec', 'true', '--no-realtime'],
    port, {
      PIDGE_BRIDGE_ALERT_STREAK: '1200',  // test-fast "10 minutes"
      PIDGE_BRIDGE_BACKOFF_BASE: '50',
      PIDGE_BRIDGE_BACKOFF_MAX: '150',
    },
  );

  // The streak reaches 5 well before 1.2s — narrated as server-shaped, NO alert yet.
  assert.ok(await waitFor(() => /listen error 500 \(5 consecutive, looks server-shaped\)/.test(out.stderr)),
    `stderr:\n${out.stderr}`);
  // …and once the streak has persisted past the window, exactly one alert fires.
  assert.ok(await waitFor(() => /LOCAL ALERT: channel looks broken/.test(out.stderr)), `stderr:\n${out.stderr}`);
  const alertsAt = (out.stderr.match(/LOCAL ALERT: channel looks broken/g) || []).length;
  assert.equal(alertsAt, 1, 'one alert per outage');
  const before = out.stderr;
  assert.ok(/over ~\d+ min/.test(before), 'the alert states how long the outage persisted');

  // Recovery: healthy polls resume → narrated recovery + the quiet closure notice.
  mock.state.messagesStatus = 200;
  assert.ok(await waitFor(() => /channel recovered after \d+ consecutive/.test(out.stderr)), `stderr:\n${out.stderr}`);
  assert.ok(await waitFor(() => /LOCAL ALERT: channel recovered/.test(out.stderr)), `stderr:\n${out.stderr}`);
  assert.equal((out.stderr.match(/LOCAL ALERT: channel looks broken/g) || []).length, 1,
    'recovery must not re-arm a second alert for the same outage');

  child.kill('SIGTERM');
  await result;
  await mock.stop();
});

test('bridge: below the persistence window a server-shaped streak backs off LOUDLY on stderr but never pops the desktop alert', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messagesStatus = 502;

  const { child, result, out } = runCli(
    ['bridge', '--exec', 'true', '--no-realtime'],
    port, { PIDGE_BRIDGE_BACKOFF_BASE: '50', PIDGE_BRIDGE_BACKOFF_MAX: '120' }, // default 10-min window stays
  );

  // Way past the old BROKEN_AFTER=5 threshold…
  assert.ok(await waitFor(() => /\(8 consecutive, looks server-shaped\)/.test(out.stderr)), `stderr:\n${out.stderr}`);
  // …the stderr log is loud, the desktop stays silent (the outage is seconds old, not 10 minutes).
  assert.ok(!/LOCAL ALERT: channel looks broken/.test(out.stderr),
    'a seconds-old outage (every deploy blip, every wake) must not buzz the human');

  child.kill('SIGTERM');
  await result;
  await mock.stop();
});

// The lock is ONE lock and it works in BOTH directions: `listen` refuses under a
// live bridge (above), and a bridge refuses under a live `listen` — which only
// became true once every listen started HOLDING the lock instead of just reading
// it. Same refusal, same way out (catchup).
test('`bridge` REFUSES when a LIVE `listen` holds the channel lock', async () => {
  const mock = createMock();
  const port = await mock.start();
  const xdg = tmpDir('pidge-bridge-under-listen-');

  const listener = runCli(['listen', '--no-realtime', '--timeout', '6', '--interval', '1'], port, { XDG_CONFIG_HOME: xdg });
  assert.ok(await waitFor(() => fs.existsSync(lockPathFor(xdg))), 'the listener must take the lock');

  const r = await runCli(['bridge', '--exec', 'true', '--no-realtime'], port, { XDG_CONFIG_HOME: xdg }).result;
  assert.equal(r.code, 2, `stderr:\n${r.stderr}`);
  assert.match(r.stderr, /another consumer already holds this channel/);
  assert.match(r.stderr, /catchup/);

  const rl = await listener.result;
  await mock.stop();
  assert.equal(rl.code, 3, `the listener is untouched by the refusal; stderr:\n${rl.stderr}`);
  assert.ok(!fs.existsSync(lockPathFor(xdg)), 'and it releases the lock on its way out');
});

// Refactor guard: the handler machinery (spawn/settle/marker/tee/timeout/renew)
// is shared with `listen --exec` now, so every line it prints takes the caller's
// name. On the bridge those lines must still say "bridge" — a daemon log that
// suddenly narrates as something else is a support call.
test('bridge: the shared handler machinery still narrates as the BRIDGE', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 91, kind: 'message', body: 'demora', created_at: 'x' }];
  const handler = `${process.execPath} -e "require('fs').readFileSync(0); setTimeout(() => {}, 30000)"`;

  const { child, result, out } = runCli(
    ['bridge', '--exec', handler, '--no-realtime', '--interval', '1', '--handler-timeout', '2'],
    port, { PIDGE_BRIDGE_NARRATE: '400', PIDGE_BRIDGE_RENEW: '300' },
  );
  assert.ok(await waitFor(() => /pidge: bridge — handler running for/.test(out.stderr)), `stderr:\n${out.stderr}`);
  assert.ok(await waitFor(() => /pidge: bridge — handler exceeded --handler-timeout/.test(out.stderr)), `stderr:\n${out.stderr}`);
  assert.ok(mock.state.ackBodies.some((b) => b.state === 'delivered'), 'the renew heartbeat still runs from the bridge');
  assert.ok(!/pidge: listen —/.test(out.stderr), 'no line ever leaks the other caller\'s name');

  child.kill('SIGTERM');
  await result;
  await mock.stop();
});
