'use strict';
// `pidge listen --exec` + the consumer lock every `listen` now holds.
//
// The failure this file exists to prevent: a loop that LOOKS online while
// nothing is being handled. So the hard cases are
//   · the handler's EXIT CODE is the ack decision — exit 0 acks the batch's
//     EXACT ids (with its `pidge-summary:` note, never an invented one), and a
//     failed/timed-out handler acks NOTHING and says so ON STDOUT (a
//     handler_failed line, where the agent wakes up) with exit 2;
//   · an empty round spawns nothing and stays exit 3;
//   · the batch reaches the handler on stdin, whole (messages + continuity);
//   · the lease is renewed while the handler thinks;
//   · listen HOLDS the channel lock for its whole run: a second listen, or a
//     bridge, is refused (exit 2) and the lock is released on the way out;
//   · the flags that would fight --exec over stdout or over the ack decision
//     are usage errors, not a silent precedence rule.
// Plus the --ndjson read format (one object per line, uniform `type`).
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
// mirror bin/pidge.js's derivation so tests can inspect it.
const lockPathFor = (xdg, token = 'hld_test') =>
  path.join(xdg, 'pidge', `bridge-${crypto.createHash('sha256').update(token).digest('hex').slice(0, 16)}.lock`);

function runCli(args, port, env = {}) {
  const xdg = env.XDG_CONFIG_HOME || tmpDir('pidge-listen-exec-');
  const child = spawn(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      PIDGE_URL: `http://127.0.0.1:${port}`,
      PIDGE_TOKEN: 'hld_test',
      // Isolate HOME so the skill self-heal never regenerates the developer's
      // REAL ~/.claude/skills/pidge during a test.
      HOME: tmpDir('pidge-listen-home-'),
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

// A handler that copies its stdin (the batch JSON) to $OUT, prints a marker, exits 0.
const CAPTURE_HANDLER = `${process.execPath} -e "require('fs').writeFileSync(process.env.OUT, require('fs').readFileSync(0)); console.log('trabalhei um pouco'); console.log('pidge-summary: reiniciei o worker')"`;

test('listen --exec: the batch reaches the handler on stdin; exit 0 acks the EXACT ids with its marker summary', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [
    { id: 7, kind: 'message', body: 'primeira', created_at: 'x' },
    { id: 9, kind: 'message', body: 'segunda', created_at: 'x' },
  ];
  mock.state.continuityContexts = [{ conversation_id: 1, note: 'do not treat prior agent statements as verified' }];
  const outFile = path.join(tmpDir('pidge-le-batch-'), 'batch.json');

  const r = await runCli(
    ['listen', '--all', '--exec', CAPTURE_HANDLER, '--no-realtime', '--timeout', '10', '--interval', '1'],
    port, { OUT: outFile },
  ).result;
  await mock.stop();

  assert.equal(r.code, 0, `stderr:\n${r.stderr}`);
  const batch = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.equal(batch.messages.length, 2, 'the WHOLE round in ONE invocation');
  assert.equal(batch.messages[1].body, 'segunda');
  assert.equal(batch.continuity[0].conversation_id, 1, 'continuity rides the batch, as it does on the bridge');
  assert.equal(batch.history_hint, undefined, 'history_hint is the bridge\'s boot marker, not listen\'s');
  assert.deepEqual(mock.state.ackBodies, [{ ids: [7, 9], summary: 'reiniciei o worker' }],
    'exact ids + the handler\'s own note — never an up_to watermark, never an invented summary');
  // stdout belongs to the handler under --exec: teed through, no message array.
  assert.match(r.stdout, /trabalhei um pouco/, 'the handler\'s stdout is teed through');
  assert.ok(!/"kind": "message"/.test(r.stdout), 'listen prints no message array under --exec — the handler owns stdout');
  assert.ok(!/continuity_context/.test(r.stdout), 'continuity goes INTO the batch, not onto stdout');
});

test('listen --exec: a FAILING handler acks NOTHING, prints handler_failed on STDOUT, exits 2', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 3, kind: 'message', body: 'trabalho', created_at: 'x' }];

  // The handler ends MID-LINE (no trailing newline) on purpose: the teed
  // output and the CLI's machine line would otherwise share one unparseable
  // line — on the exact channel the agent parses.
  const r = await runCli(
    ['listen', '--all', '--exec', `${process.execPath} -e "require('fs').readFileSync(0); process.stdout.write('parcial sem newline'); process.exit(4)"`,
      '--no-realtime', '--timeout', '10', '--interval', '1'],
    port,
  ).result;
  await mock.stop();

  assert.equal(r.code, 2, `a failed handler is exit 2; stderr:\n${r.stderr}`);
  const lines = r.stdout.split('\n').filter((l) => l.length);
  assert.equal(lines[lines.length - 2], 'parcial sem newline', 'the handler\'s tail keeps its own line');
  const line = JSON.parse(lines[lines.length - 1]); // parses ALONE — no glued prefix
  assert.equal(line.type, 'handler_failed', 'the failure comes out where the agent WAKES UP: stdout');
  assert.equal(line.exit, 4, 'the handler\'s own exit code rides along');
  assert.deepEqual(line.ids, [3], 'and the ids that were NOT acked');
  assert.equal(mock.state.ackBodies.length, 0, 'a failed handler must NEVER ack');
  assert.match(r.stderr, /NOTHING acked/, 'and the human line says so too');
});

// The other half of a green handler: the work happened and the ACK did not
// land. The ack's return value used to be discarded, so the round exited 0 —
// a green round over a queue that still holds the batch.
test('listen --exec: a handler that exits 0 over a FAILED ack prints ack_failed and exits 2', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 11, kind: 'message', body: 'trabalho real', created_at: 'x' }];
  mock.state.ackStatus = 503; // the ack does not land

  const r = await runCli(
    ['listen', '--all', '--exec', `${process.execPath} -e "require('fs').readFileSync(0); console.log('pidge-summary: fiz o trabalho')"`,
      '--no-realtime', '--timeout', '10', '--interval', '1'],
    port,
  ).result;
  await mock.stop();

  assert.equal(r.code, 2, `an unacked round is NOT green; stderr:\n${r.stderr}`);
  const line = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(line.type, 'ack_failed', 'the agent wakes up on stdout, same as handler_failed');
  assert.deepEqual(line.ids, [11], 'with the ids the server never marked done');
  assert.match(r.stderr, /ACK did NOT land/, 'the human line says what happened');
  assert.match(r.stderr, /pidge ack --ids 11/, 'and how to fix it by hand');
});

test('listen --exec: an ack that lands keeps the round green (exit 0, no ack_failed)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 12, kind: 'message', body: 'ok', created_at: 'x' }];

  const r = await runCli(
    ['listen', '--all', '--exec', `${process.execPath} -e "require('fs').readFileSync(0); console.log('pidge-summary: pronto')"`,
      '--no-realtime', '--timeout', '10', '--interval', '1'],
    port,
  ).result;
  await mock.stop();

  assert.equal(r.code, 0, `stderr:\n${r.stderr}`);
  assert.ok(!/ack_failed/.test(r.stdout), 'no failure line on a round that really acked');
  assert.deepEqual(mock.state.ackBodies, [{ ids: [12], summary: 'pronto' }]);
});

// The batch ack narrates what the SERVER did, not what we hoped: 0 acked rows
// never get the green ✓✓ line, and an ack with no note says it will be filed
// as drained instead of borrowing the good line.
test('listen --exec: an ack the server processed ZERO rows for never prints the green line', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 21, kind: 'message', body: 'x', created_at: 'x' }];
  mock.state.ackAcked = 0;

  const r = await runCli(
    ['listen', '--all', '--exec', `${process.execPath} -e "require('fs').readFileSync(0); console.log('pidge-summary: fiz')"`,
      '--no-realtime', '--timeout', '10', '--interval', '1'],
    port,
  ).result;
  await mock.stop();

  assert.equal(r.code, 0, `the HTTP ack succeeded — the round still ends; stderr:\n${r.stderr}`);
  assert.match(r.stderr, /acked 0 of 1 message/);
  assert.ok(!/green ✓✓/.test(r.stderr), 'nothing was processed — nothing is green');
});

test('listen --exec: a note-LESS ack says DRAINED instead of promising a green ✓✓', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 22, kind: 'message', body: 'x', created_at: 'x' }];

  const r = await runCli(
    ['listen', '--all', '--exec', `${process.execPath} -e "require('fs').readFileSync(0)"`,
      '--no-realtime', '--timeout', '10', '--interval', '1'],
    port,
  ).result;
  await mock.stop();

  assert.equal(r.code, 0, `stderr:\n${r.stderr}`);
  assert.match(r.stderr, /with NO note/);
  assert.match(r.stderr, /DRAINED/);
  assert.ok(!/green ✓✓/.test(r.stderr), 'the green promise belongs to acks that can say what happened');
});

test('listen --exec: a hung handler is SIGTERMed at --handler-timeout — no ack, handler_failed says timeout', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 4, kind: 'message', body: 'trava', created_at: 'x' }];

  const r = await runCli(
    ['listen', '--all', '--exec', `${process.execPath} -e "setTimeout(() => {}, 30000)"`,
      '--no-realtime', '--timeout', '20', '--interval', '1', '--handler-timeout', '1'],
    port,
  ).result;
  await mock.stop();

  assert.equal(r.code, 2, `stderr:\n${r.stderr}`);
  assert.match(r.stderr, /exceeded --handler-timeout \(1s\)/);
  const line = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(line.type, 'handler_failed');
  assert.equal(line.reason, 'timeout', 'the failure names its cause');
  assert.deepEqual(line.ids, [4]);
  assert.equal(mock.state.ackBodies.length, 0, 'a timed-out handler must NEVER ack');
});

test('listen --exec: no marker ⇒ the ack carries NO summary, and the nudge says how to add one', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 5, kind: 'message', body: 'oi', created_at: 'x' }];

  const r = await runCli(
    ['listen', '--all', '--exec', `${process.execPath} -e "require('fs').readFileSync(0); console.log('só logs')"`,
      '--no-realtime', '--timeout', '10', '--interval', '1'],
    port,
  ).result;
  await mock.stop();

  assert.equal(r.code, 0, `stderr:\n${r.stderr}`);
  assert.deepEqual(mock.state.ackBodies, [{ ids: [5] }], 'no summary key when the handler prints no marker');
  assert.match(r.stderr, /no `pidge-summary:` line/, 'the silence is named, not hidden');
});

test('listen --exec: the lease is RENEWED (exact ids, state=delivered) while a slow handler thinks', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 7, kind: 'message', body: 'demorada', created_at: 'x' }];
  // thinks ~1.4s — at PIDGE_BRIDGE_RENEW=300ms that's several pings mid-run
  const handler = `${process.execPath} -e "require('fs').readFileSync(0); setTimeout(() => {}, 1400)"`;

  const { result, out } = runCli(
    ['listen', '--all', '--exec', handler, '--no-realtime', '--timeout', '20', '--interval', '1'],
    port, { PIDGE_BRIDGE_RENEW: '300' },
  );
  assert.ok(await waitFor(() => mock.state.ackBodies.some((b) => b.state === 'delivered')),
    `expected a renew ping; stderr:\n${out.stderr}`);
  assert.deepEqual(mock.state.ackBodies.find((b) => b.state === 'delivered'), { ids: [7], state: 'delivered' },
    'the ping renews the batch\'s EXACT ids (state=delivered — never a consume)');

  const r = await result;
  await mock.stop();
  assert.equal(r.code, 0, `stderr:\n${r.stderr}`);
  assert.deepEqual(mock.state.ackBodies.find((b) => b.state === undefined).ids, [7], 'the terminal ack still lands');
});

test('listen --exec (adversarial): MB of output then a trailing marker — no wedge, the marker still wins', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 7, kind: 'message', body: 'oi', created_at: 'x' }];
  // ~4MB on a SINGLE unterminated line, then a newline, then the marker line.
  const handler = `${process.execPath} -e "require('fs').readFileSync(0); const big='z'.repeat(200000); for(let i=0;i<20;i++) process.stdout.write(big); process.stdout.write('\\npidge-summary: sobrevivi ao dump\\n')"`;

  const { result, out } = runCli(
    ['listen', '--all', '--exec', handler, '--no-realtime', '--timeout', '30', '--interval', '1'],
    port,
  );
  assert.ok(await waitFor(() => mock.state.ackBodies.length >= 1, 20000), `the round must not wedge; stderr:\n${out.stderr}`);
  assert.equal(mock.state.ackBodies[0].summary, 'sobrevivi ao dump', 'the trailing marker survives a multi-MB stream');
  const r = await result;
  await mock.stop();
  assert.equal(r.code, 0, `stderr:\n${r.stderr}`);
});

test('listen --exec: an EMPTY round spawns nothing and stays exit 3 (with the relaunch nudge)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const marker = path.join(tmpDir('pidge-le-empty-'), 'ran');
  const handler = `${process.execPath} -e "require('fs').writeFileSync(process.env.MARK, 'x')"`;

  const r = await runCli(
    ['listen', '--all', '--exec', handler, '--no-realtime', '--timeout', '2', '--interval', '1'],
    port, { MARK: marker },
  ).result;
  await mock.stop();

  assert.equal(r.code, 3, `an empty round is "nothing arrived", not a failure; stderr:\n${r.stderr}`);
  assert.ok(!fs.existsSync(marker), 'no handler is spawned for an empty round — no LLM call for nothing');
  assert.match(r.stderr, /Relaunch the listener/);
  assert.equal(mock.state.ackBodies.length, 0);
});

test('listen --exec refuses the flags that would fight it over stdout or over the ack (exit 1)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const cases = [
    [['--ack-on-read'], /--ack-on-read/],
    [['--follow'], /ONE round/],
    [['--ndjson'], /owns stdout/],
  ];
  for (const [extra, why] of cases) {
    const r = await runCli(['listen', '--all', '--exec', 'true', '--no-realtime', '--timeout', '2', ...extra], port).result;
    assert.equal(r.code, 1, `${extra.join(' ')} must be a usage error; stderr:\n${r.stderr}`);
    assert.match(r.stderr, why);
  }
  await mock.stop();
  assert.equal(mock.state.messageReads.length, 0, 'a usage error never touches the queue');
});

// ── the consumer lock: every listen holds it, not just the bridge ────────────

test('listen HOLDS the channel lock while it runs and releases it on the way out', async () => {
  const mock = createMock();
  const port = await mock.start();
  const xdg = tmpDir('pidge-listen-lock-');

  const a = runCli(['listen', '--no-realtime', '--timeout', '6', '--interval', '1'], port, { XDG_CONFIG_HOME: xdg });
  assert.ok(await waitFor(() => fs.existsSync(lockPathFor(xdg))), 'a running listen must take the lock');
  assert.equal(JSON.parse(fs.readFileSync(lockPathFor(xdg), 'utf8')).pid, a.child.pid, 'the lock names the listener');

  // a SECOND listen on the same channel is refused, and told the way out
  const b = await runCli(['listen', '--no-realtime', '--timeout', '5'], port, { XDG_CONFIG_HOME: xdg }).result;
  assert.equal(b.code, 2, `a second consumer must refuse; stderr:\n${b.stderr}`);
  assert.match(b.stderr, /listen REFUSED/);
  assert.match(b.stderr, /LIVE consumer/);
  assert.match(b.stderr, /pidge catchup/, 'it points at the read-only alternative');
  // The refusal must ALSO name the escape hatch — the EEXIST path has always
  // had it, this one sent the reader to a dead end when the pid was a stranger.
  assert.match(b.stderr, new RegExp(`rm "${lockPathFor(xdg).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
    'the pre-check refusal carries the same rm escape hatch as the EEXIST one');

  // …and a BRIDGE under a live listen is refused the same way (symmetry)
  const c = await runCli(['bridge', '--exec', 'true', '--no-realtime'], port, { XDG_CONFIG_HOME: xdg }).result;
  assert.equal(c.code, 2, `a bridge under a live listen must refuse; stderr:\n${c.stderr}`);
  assert.match(c.stderr, /another consumer already holds this channel/);

  const ra = await a.result;
  await mock.stop();
  assert.equal(ra.code, 3, `the listener itself is untouched (empty round); stderr:\n${ra.stderr}`);
  assert.ok(!fs.existsSync(lockPathFor(xdg)), 'the lock is released on the way out — every exit path');
});

test('listen releases the lock on the DELIVERED path too (exit 0), so the next round can take it', async () => {
  const mock = createMock();
  const port = await mock.start();
  const xdg = tmpDir('pidge-listen-lock2-');
  mock.state.messages = [{ id: 21, kind: 'message', body: 'oi', created_at: 'x' }];

  const r = await runCli(['listen', '--no-realtime', '--timeout', '10', '--interval', '1'], port, { XDG_CONFIG_HOME: xdg }).result;
  assert.equal(r.code, 0, `stderr:\n${r.stderr}`);
  assert.ok(!fs.existsSync(lockPathFor(xdg)), 'a delivered round releases the lock');

  // the relaunch (the loop's whole point) is not blocked by its predecessor
  mock.state.messages = [{ id: 22, kind: 'message', body: 'de novo', created_at: 'x' }];
  const r2 = await runCli(['listen', '--no-realtime', '--timeout', '10', '--interval', '1'], port, { XDG_CONFIG_HOME: xdg }).result;
  await mock.stop();
  assert.equal(r2.code, 0, `the relaunch must not meet its own corpse; stderr:\n${r2.stderr}`);
  assert.match(r2.stdout, /de novo/);
});

// Ctrl-C / SIGTERM kills Node WITHOUT running the 'exit' hook, so every
// interrupted listen used to leave a corpse lock behind.
for (const [sig, expected] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`listen releases the lock on ${sig} and exits ${expected} (the shell's own convention)`, async () => {
    const mock = createMock();
    const port = await mock.start();
    const xdg = tmpDir('pidge-listen-sig-');

    const a = runCli(['listen', '--no-realtime', '--timeout', '60', '--interval', '1'], port, { XDG_CONFIG_HOME: xdg });
    assert.ok(await waitFor(() => fs.existsSync(lockPathFor(xdg))), 'the listener took the lock');
    a.child.kill(sig);
    const r = await a.result;
    await mock.stop();

    assert.equal(r.code, expected, `stderr:\n${r.stderr}`);
    assert.match(r.stderr, new RegExp(`${sig}: released the consumer lock`));
    assert.ok(!fs.existsSync(lockPathFor(xdg)), 'no corpse lock left behind for the next listener to fight');
  });
}

// A pid is not an identity: pids wrap. A lock naming a REUSED pid looked alive
// forever and locked every listen out of the channel until a human deleted it.
test('a REUSED pid is a corpse, not a live consumer — the start time settles it', async (t) => {
  if (process.platform !== 'linux' || !fs.existsSync(`/proc/${process.pid}/stat`)) return t.skip('needs /proc');
  const mock = createMock();
  const port = await mock.start();
  const xdg = tmpDir('pidge-listen-reuse-');
  fs.mkdirSync(path.join(xdg, 'pidge'), { recursive: true });
  // A pid that IS alive (this very test process) but whose recorded start time
  // belongs to the process that died and gave the number up.
  fs.writeFileSync(lockPathFor(xdg), JSON.stringify({
    pid: process.pid, proc_started_at: '1', started_at: 'x', label: 'long-dead-bridge',
  }) + '\n');

  mock.state.messages = [{ id: 55, kind: 'message', body: 'oi', created_at: 'x' }];
  const r = await runCli(['listen', '--no-realtime', '--timeout', '10', '--interval', '1'], port, { XDG_CONFIG_HOME: xdg }).result;
  await mock.stop();
  assert.equal(r.code, 0, `a reused pid must not wedge the channel; stderr:\n${r.stderr}`);
  assert.match(r.stderr, /STALE lock/);
});

test('the SAME live process is still refused — the start time matches, so the holder is real', async (t) => {
  if (process.platform !== 'linux' || !fs.existsSync(`/proc/${process.pid}/stat`)) return t.skip('needs /proc');
  const mock = createMock();
  const port = await mock.start();
  const xdg = tmpDir('pidge-listen-live-');
  fs.mkdirSync(path.join(xdg, 'pidge'), { recursive: true });
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const started = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
  fs.writeFileSync(lockPathFor(xdg), JSON.stringify({
    pid: process.pid, proc_started_at: started, started_at: 'x', label: 'very-much-alive',
  }) + '\n');

  const r = await runCli(['listen', '--no-realtime', '--timeout', '5'], port, { XDG_CONFIG_HOME: xdg }).result;
  await mock.stop();
  assert.equal(r.code, 2, `stderr:\n${r.stderr}`);
  assert.match(r.stderr, /listen REFUSED/);
  assert.match(r.stderr, /very-much-alive/);
});

test('a listen WRITES its own start time into the lock, so the next one can tell it apart', async (t) => {
  if (process.platform !== 'linux' || !fs.existsSync(`/proc/${process.pid}/stat`)) return t.skip('needs /proc');
  const mock = createMock();
  const port = await mock.start();
  const xdg = tmpDir('pidge-listen-stamp-');
  const a = runCli(['listen', '--no-realtime', '--timeout', '10', '--interval', '1'], port, { XDG_CONFIG_HOME: xdg });
  assert.ok(await waitFor(() => fs.existsSync(lockPathFor(xdg))));
  const lock = JSON.parse(fs.readFileSync(lockPathFor(xdg), 'utf8'));
  a.child.kill('SIGTERM');
  await a.result;
  await mock.stop();
  assert.match(String(lock.proc_started_at), /^\d+$/, 'the lock pins the pid to THIS process');
});

test('a CRASHED listener (dead pid) never wedges the channel — the next one claims the corpse', async () => {
  const mock = createMock();
  const port = await mock.start();
  const xdg = tmpDir('pidge-listen-corpse-');
  // A REAL dead pid: spawn a no-op node, wait for it to exit, reuse its pid.
  const corpse = spawn(process.execPath, ['-e', '']);
  const deadPid = corpse.pid;
  await new Promise((r) => corpse.on('exit', r));
  fs.mkdirSync(path.join(xdg, 'pidge'), { recursive: true });
  fs.writeFileSync(lockPathFor(xdg), JSON.stringify({ pid: deadPid, started_at: 'x', label: 'crashed-listener' }) + '\n');

  mock.state.messages = [{ id: 31, kind: 'message', body: 'oi', created_at: 'x' }];
  const r = await runCli(['listen', '--no-realtime', '--timeout', '10', '--interval', '1'], port, { XDG_CONFIG_HOME: xdg }).result;
  await mock.stop();
  assert.equal(r.code, 0, `a stale lock must not block a listen; stderr:\n${r.stderr}`);
  assert.match(r.stderr, /STALE lock/);
  assert.ok(!fs.existsSync(lockPathFor(xdg)), 'and the takeover releases it in turn');
});

// ── --ndjson: the line-oriented read format ─────────────────────────────────

test('listen --ndjson: one object per line, uniform `type`, closed by batch_end', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [
    { id: 41, kind: 'message', body: 'texto do humano', created_at: 'x' },
    { id: 42, kind: 'notification_reply', body: 'yes', created_at: 'x', ref: { correlation_id: 'c1', title: 'Q', event_kind: 'acted' } },
  ];
  mock.state.continuityContexts = [{ conversation_id: 1, note: 'unverified' }];

  const r = await runCli(['listen', '--all', '--ndjson', '--no-realtime', '--timeout', '10', '--interval', '1'], port).result;
  await mock.stop();

  assert.equal(r.code, 0, `stderr:\n${r.stderr}`);
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l)); // EVERY line parses alone
  assert.deepEqual(lines.map((l) => l.type),
    ['continuity_context', 'message', 'notification_reply', 'batch_end'],
    'heterogeneous, in order, each line stamped with its own type');
  assert.equal(lines[1].body, 'texto do humano', 'the whole row is preserved under the type stamp');
  assert.equal(lines[1].kind, 'message', 'kind survives — type MIRRORS it, never replaces it');
  assert.equal(lines[2].ref.correlation_id, 'c1');
  assert.equal(lines[3].count, 2);
  assert.equal(lines[3].max_ackable_id, 42, 'batch_end carries the highest ACKABLE id');
  // the one rule a consumer needs: ackable ⇔ it has an id
  assert.equal(lines[0].id, undefined, 'a continuity context is NOT ackable');
  assert.ok(lines.filter((l) => l.id !== undefined).every((l) => /message|notification_reply/.test(l.type)));
});

test('the DEFAULT listen stdout is unchanged: continuity lines, then ONE pretty array', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [{ id: 51, kind: 'message', body: 'sem ndjson', created_at: 'x' }];
  mock.state.continuityContexts = [{ conversation_id: 1, note: 'unverified' }];

  const r = await runCli(['listen', '--all', '--no-realtime', '--timeout', '10', '--interval', '1'], port).result;
  await mock.stop();

  assert.equal(r.code, 0, `stderr:\n${r.stderr}`);
  const [first, ...rest] = r.stdout.split('\n');
  assert.equal(JSON.parse(first).type, 'continuity_context', 'the continuity line still leads');
  const arr = JSON.parse(rest.join('\n'));
  assert.ok(Array.isArray(arr) && arr[0].body === 'sem ndjson', 'and the messages are ONE pretty-printed array');
  assert.ok(!/batch_end/.test(r.stdout), 'batch_end belongs to --ndjson only — the default format is untouched');
});
