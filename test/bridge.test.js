'use strict';
// `pidge bridge` acceptance tests — the hard cases:
//   · ONE handler invocation per batch (batch JSON on stdin, history_hint on
//     the first batch post-restart), exit 0 ⇒ ack --up-to the LAST id;
//   · a failing handler NEVER acks (the server lease is the durability);
//   · the per-channel lock (hash(token)) refuses a second instance, recovers a
//     STALE lock (dead pid — crashed bridge), and `listen` refuses under it;
//   · SIGTERM with a batch in flight: no ack, lock released, exit 0;
//   · 401 = narrate + LOCAL alert + LONG jittered backoff, never a hot loop.
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
  assert.match(out.stderr, /timed out \(--handler-timeout 2s\)/);
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
