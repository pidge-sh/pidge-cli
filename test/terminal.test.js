'use strict';
// `pidge terminal` acceptance tests — the CLI as a child process, the mock
// server relaying TerminalChannel frames, and a scripted tmux -C stand-in
// (test/fake-tmux.js via PIDGE_TMUX_BIN). What must hold:
//   · sealed-only refusals (no E2E channel / no PIDGE_SECRET) — exit 2, loud;
//   · the typed 402 plan gate: relayed message, exit 2, NO retry;
//   · the full round-trip: register → host subscribe → viewer join ⇒ SEED
//     frame (terminal_output AAD) → viewer input ⇒ send-keys in tmux ⇒ echoed
//     %output comes back sealed → replay guard drops a reused seq → resize +
//     reseed on the input lane work;
//   · tmux session death ⇒ DELETE the session row, exit 0;
//   · SIGINT stops the MIRROR only — no DELETE (the session keeps running).
// The frames-over-cable tests need the CLI's native WebSocket (Node ≥22) —
// they skip on older runtimes; refusal tests run everywhere they can.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn: rawSpawn } = require('node:child_process');
const WebSocketClient = require('ws');
const { track } = require('./spawn-tracker');
const { createMock } = require('./mock-server');
const { e2eAad, e2eEncryptBlob, e2eDecryptBlob } = require('../bin/pidge.js');

const spawn = (cmd, args, opts = {}) => track(rawSpawn(cmd, args, { ...opts, detached: true }));
const CLI = path.join(__dirname, '..', 'bin', 'pidge.js');
const FAKE_TMUX = path.join(__dirname, 'fake-tmux.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// The CLI's relay loop needs a native WebSocket; on older Node it refuses
// with a clear exit 2 — the cable-riding tests skip there.
const HAS_WS = typeof WebSocket === 'function';

const KEY = Buffer.alloc(32, 5);
const SECRET = KEY.toString('base64url');
const VG = 'testvgen1'; // a valid vgen ([a-z0-9]{8,}) — every viewer→host frame carries one
// The wire form the iOS/Mac viewer speaks: blob framing → STANDARD base64.
const sealBlob = (pid, field, frame) => e2eEncryptBlob(KEY, e2eAad(1, pid, field), Buffer.from(JSON.stringify(frame), 'utf8')).toString('base64');
const sealInput = (pid, frame) => sealBlob(pid, 'terminal_input', frame);          // keystrokes {t:i}
const sealCtrlViewer = (pid, frame) => sealBlob(pid, 'terminal_ctrl_viewer', frame); // roaming reseed/resize
const openOutput = (pid, data) => JSON.parse(e2eDecryptBlob(KEY, e2eAad(1, pid, 'terminal_output'), Buffer.from(data, 'base64')).toString('utf8'));

function runCli(args, port, env = {}, opts = {}) {
  const fakeDir = env.FAKE_TMUX_DIR || tmpDir('pidge-faketmux-');
  const child = spawn(process.execPath, [CLI, ...args], {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    env: {
      ...process.env,
      PIDGE_URL: `http://127.0.0.1:${port}`,
      PIDGE_TOKEN: 'hld_test',
      PIDGE_SECRET: SECRET,
      PIDGE_TMUX_BIN: FAKE_TMUX,
      PIDGE_TERMINAL_FLUSH_MS: '30',
      PIDGE_TERMINAL_BACKOFF_MS: '200',
      PIDGE_QUIET_NAG: '1',
      HOME: tmpDir('pidge-term-home-'),
      XDG_CONFIG_HOME: tmpDir('pidge-term-xdg-'),
      ...env,
      FAKE_TMUX_DIR: fakeDir,
    },
  });
  const out = { code: null, signal: null, stdout: '', stderr: '' };
  child.stdout.on('data', (c) => { out.stdout += c; });
  child.stderr.on('data', (c) => { out.stderr += c; });
  const result = new Promise((resolve) => {
    child.on('exit', (code, signal) => { out.code = code; out.signal = signal; resolve(out); });
  });
  return { child, result, out, fakeDir };
}

async function waitFor(fn, ms = 8000, step = 40) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(step); }
  return false;
}

// A minimal ActionCable viewer (ses_ track → the mock casts it as viewer).
function connectViewer(port, pid) {
  const sock = new WebSocketClient(`ws://127.0.0.1:${port}/cable`, ['actioncable-v1-json', 'ses_viewer']);
  const identifier = JSON.stringify({ channel: 'TerminalChannel', session: pid });
  const viewer = {
    sock, identifier,
    confirmed: false,
    frames: [],   // every {data} message (sealed host frames)
    sendFrame(data) {
      sock.send(JSON.stringify({ command: 'message', identifier, data: JSON.stringify({ action: 'frame', data }) }));
    },
    close() { try { sock.close(); } catch { /* gone */ } },
  };
  sock.on('message', (raw) => {
    let f; try { f = JSON.parse(raw); } catch { return; }
    if (f.type === 'welcome') sock.send(JSON.stringify({ command: 'subscribe', identifier }));
    if (f.type === 'confirm_subscription') viewer.confirmed = true;
    if (f.identifier === identifier && f.message && typeof f.message.data === 'string') viewer.frames.push(f.message.data);
  });
  return viewer;
}

function makeFakeDir(sessions = {}) {
  const dir = tmpDir('pidge-faketmux-');
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify(sessions));
  try { fs.chmodSync(FAKE_TMUX, 0o755); } catch { /* repo mode already fine */ }
  return dir;
}

test('terminal: refuses to start on a non-E2E channel (sealed-only, exit 2, instructions)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = false;
  const { result } = runCli(['terminal', 'attach', 'work'], port, { FAKE_TMUX_DIR: makeFakeDir({ work: {} }) });
  const r = await result;
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /SEALED-ONLY/);
  assert.match(r.stderr, /end-to-end/i);
  assert.strictEqual(mock.state.terminalPosts.length, 0); // refused BEFORE registering
  await mock.stop();
});

test('terminal: refuses without a PIDGE_SECRET even on an E2E channel (exit 2)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  const { result } = runCli(['terminal', 'attach', 'work'], port, {
    FAKE_TMUX_DIR: makeFakeDir({ work: {} }), PIDGE_SECRET: '',
  });
  const r = await result;
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /PIDGE_SECRET/);
  assert.strictEqual(mock.state.terminalPosts.length, 0);
  await mock.stop();
});

// (needs the CLI's native WebSocket: the register happens after the runtime
// check — refusal ordering is usage → sealed-only → runtime → side effects)
test('terminal: the typed 402 plan gate is relayed verbatim and NEVER retried', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  mock.state.terminalRequiresPro = true;
  const { result } = runCli(['terminal', 'attach', 'work'], port, { FAKE_TMUX_DIR: makeFakeDir({ work: {} }) });
  const r = await result;
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /Pro feature/);
  assert.match(r.stderr, /do not retry/);
  await sleep(300); // a retry loop would land a second POST here
  assert.strictEqual(mock.state.terminalPosts.length, 1);
  await mock.stop();
});

test('terminal attach: full sealed round-trip — seed on join, input→send-keys, echo→output frame, replay guard, resize, reseed', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  const fakeDir = makeFakeDir({ work: {} });
  const { child, result, out } = runCli(['terminal', 'attach', 'work'], port, { FAKE_TMUX_DIR: fakeDir });

  // the one machine-readable stdout line carries the identity
  assert.ok(await waitFor(() => out.stdout.includes('"public_id"')), `no stdout id line; stderr: ${out.stderr}`);
  const pid = JSON.parse(out.stdout.trim().split('\n')[0]).public_id;
  assert.match(pid, /^term_[a-z0-9-]+$/);
  assert.strictEqual(mock.state.terminalPosts[0].kind, 'term');
  assert.strictEqual(mock.state.terminalPosts[0].name, 'work');

  // host subscribed → viewer joins → the join ping makes the host SEED
  assert.ok(await waitFor(() => [...mock.state.terminalSubs].some((s) => s.role === 'host')));
  const viewer = connectViewer(port, pid);
  assert.ok(await waitFor(() => viewer.frames.length >= 1), `no seed frame; stderr: ${out.stderr}`);
  const seed = openOutput(pid, viewer.frames[0]);
  assert.strictEqual(seed.t, 'seed');
  assert.strictEqual(seed.epoch, 1);          // first host process for this name
  assert.strictEqual(seed.cols, 80);
  assert.strictEqual(seed.rows, 24);
  const seedText = Buffer.from(seed.data, 'base64').toString('latin1');
  assert.match(seedText, /seed-line-1\r\nseed-line-2/);
  // a capture-pane body line that LOOKS like a %output notification stays
  // verbatim in the seed and is NOT dispatched into the live stream (control
  // block bodies are contiguous — a `%…` pane line is content, not a tag).
  assert.match(seedText, /%output %9 NOT_A_REAL_NOTIFICATION/);
  assert.ok(!viewer.frames.slice(1).some((d) => {
    const f = openOutput(pid, d);
    return f.t === 'o' && Buffer.from(f.data, 'base64').toString('latin1').includes('NOT_A_REAL_NOTIFICATION');
  }), 'a %-leading seed body line leaked into the live stream');

  // viewer input (terminal_input, carries vgen) → send-keys in tmux
  viewer.sendFrame(sealInput(pid, { t: 'i', vgen: VG, seq: 1, keys: [{ lit: "echo 'oi'" }, { key: 'Enter' }] }));
  const keysLog = path.join(fakeDir, 'keys.log');
  assert.ok(await waitFor(() => fs.existsSync(keysLog) && fs.readFileSync(keysLog, 'utf8').includes('Enter')));
  const log1 = fs.readFileSync(keysLog, 'utf8');
  assert.ok(log1.includes("send-keys -t 'work' -l -- 'echo '\\''oi'\\'''"), `keys.log: ${log1}`);
  assert.ok(log1.includes("send-keys -t 'work' -- Enter"));

  // the fake echoed the literal as %output → it must come back SEALED as t:"o"
  assert.ok(await waitFor(() => viewer.frames.some((d) => {
    const f = openOutput(pid, d);
    return f.t === 'o' && Buffer.from(f.data, 'base64').toString() === "echo 'oi'";
  })), 'echoed output frame never arrived');

  // replay guard: a reused (vgen, seq) is DROPPED (nothing new reaches tmux)
  viewer.sendFrame(sealInput(pid, { t: 'i', vgen: VG, seq: 1, keys: [{ lit: 'HACK' }] }));
  // a frame WITHOUT a vgen is dropped too (mandatory on viewer→host)
  viewer.sendFrame(sealInput(pid, { t: 'i', seq: 99, keys: [{ lit: 'NOVGEN' }] }));
  await sleep(400);
  const afterReplay = fs.readFileSync(keysLog, 'utf8');
  assert.ok(!afterReplay.includes('HACK'), 'a replayed (vgen,seq) reached tmux');
  assert.ok(!afterReplay.includes('NOVGEN'), 'a vgen-less frame reached tmux');

  // a RECONNECTED viewer mints a NEW vgen and restarts at seq 1 — must be honored
  // (the old lifetime-high-water design wrongly dropped this)
  viewer.sendFrame(sealInput(pid, { t: 'i', vgen: 'freshvgen2', seq: 1, keys: [{ lit: 'RECONN' }] }));
  assert.ok(await waitFor(() => fs.readFileSync(keysLog, 'utf8').includes('RECONN')), 'a reconnected viewer (new vgen, seq 1) was wrongly dropped');

  // resize ROAMS on the session's own :in via terminal_ctrl_viewer → refresh-client -C
  viewer.sendFrame(sealCtrlViewer(pid, { t: 'resize', vgen: VG, seq: 2, pid, cols: 61, rows: 21 }));
  assert.ok(await waitFor(() => fs.readFileSync(keysLog, 'utf8').includes('refresh-client -C 61x21')));

  // reseed (also terminal_ctrl_viewer roaming) → a second seed frame
  const framesBefore = viewer.frames.length;
  viewer.sendFrame(sealCtrlViewer(pid, { t: 'reseed', vgen: VG, seq: 3, pid }));
  assert.ok(await waitFor(() => viewer.frames.slice(framesBefore).some((d) => openOutput(pid, d).t === 'seed')));

  // an unknown frame type is IGNORED (additive evolution), not a crash
  viewer.sendFrame(sealInput(pid, { t: 'brand-new-thing', vgen: VG, seq: 5, whatever: true }));
  await sleep(200);
  assert.strictEqual(out.code, null); // still running

  // tmux session dies → DELETE the row, exit 0
  fs.writeFileSync(path.join(fakeDir, 'die'), '');
  const r = await result;
  assert.strictEqual(r.code, 0);
  assert.ok(await waitFor(() => mock.state.terminalDeletes.includes(pid)));
  assert.match(r.stderr, /marking the session ended/);

  viewer.close();
  await mock.stop();
  void child;
});

// ---------------------------------------------------------------------------
// Post-resize repaint nudge (QA r4 T0-a). After the immediate refresh-client, a
// debounced 1-row jiggle forces two real SIGWINCHes so a TUI that already
// painted at the old width repaints at the FINAL size — the cure for the
// on-device tear, and the ONLY thing that fixes a no-op resize (which yields no
// SIGWINCH on its own). Delays are shrunk via PIDGE_TERMINAL_NUDGE_MS/_PAUSE_MS.
// ---------------------------------------------------------------------------

// The nudge is the ordered pair `refresh-client -C {cols}x{rows-1}` then
// `refresh-client -C {cols}x{rows}` — the immediate refresh already wrote the
// requested size once, so we look for the DOWN step and a later UP step.
function nudgeLanded(keysLog, cols, rows) {
  if (!fs.existsSync(keysLog)) return false;
  const lines = fs.readFileSync(keysLog, 'utf8').split('\n');
  const down = lines.indexOf(`refresh-client -C ${cols}x${rows - 1}`);
  if (down === -1) return false;
  return lines.indexOf(`refresh-client -C ${cols}x${rows}`, down + 1) !== -1;
}

test('terminal: a resize schedules a debounced repaint nudge — a rows-jiggle (rows-1 then rows) behind the immediate refresh (QA r4 T0-a)', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  const fakeDir = makeFakeDir({ work: {} });
  const { child, result, out } = runCli(['terminal', 'attach', 'work'], port, {
    FAKE_TMUX_DIR: fakeDir, PIDGE_TERMINAL_NUDGE_MS: '150', PIDGE_TERMINAL_NUDGE_PAUSE_MS: '20',
  });
  assert.ok(await waitFor(() => out.stdout.includes('"public_id"')), `stderr: ${out.stderr}`);
  const pid = JSON.parse(out.stdout.trim().split('\n')[0]).public_id;
  const viewer = connectViewer(port, pid);
  assert.ok(await waitFor(() => viewer.confirmed));

  viewer.sendFrame(sealCtrlViewer(pid, { t: 'resize', vgen: VG, seq: 1, pid, cols: 61, rows: 21 }));
  const keysLog = path.join(fakeDir, 'keys.log');
  assert.ok(await waitFor(() => nudgeLanded(keysLog, 61, 21)),
    `nudge sequence never appeared; log: ${fs.existsSync(keysLog) ? fs.readFileSync(keysLog, 'utf8') : '(none)'}`);
  child.kill('SIGINT');
  await result;
  viewer.close();
  await mock.stop();
});

test('terminal: a BURST of resizes nudges only the FINAL size once (debounce re-arms per resize) (QA r4 T0-a)', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  const fakeDir = makeFakeDir({ work: {} });
  const { child, result, out } = runCli(['terminal', 'attach', 'work'], port, {
    FAKE_TMUX_DIR: fakeDir, PIDGE_TERMINAL_NUDGE_MS: '400', PIDGE_TERMINAL_NUDGE_PAUSE_MS: '20',
  });
  assert.ok(await waitFor(() => out.stdout.includes('"public_id"')), `stderr: ${out.stderr}`);
  const pid = JSON.parse(out.stdout.trim().split('\n')[0]).public_id;
  const viewer = connectViewer(port, pid);
  assert.ok(await waitFor(() => viewer.confirmed));

  // two resizes back-to-back, both well inside the 400ms debounce window
  viewer.sendFrame(sealCtrlViewer(pid, { t: 'resize', vgen: VG, seq: 1, pid, cols: 61, rows: 21 }));
  viewer.sendFrame(sealCtrlViewer(pid, { t: 'resize', vgen: VG, seq: 2, pid, cols: 62, rows: 21 }));
  const keysLog = path.join(fakeDir, 'keys.log');
  assert.ok(await waitFor(() => nudgeLanded(keysLog, 62, 21)),
    `final-size nudge never landed; log: ${fs.existsSync(keysLog) ? fs.readFileSync(keysLog, 'utf8') : '(none)'}`);
  await sleep(200); // let a stray first-size nudge fire if it were ever going to
  const log = fs.readFileSync(keysLog, 'utf8');
  assert.ok(!log.includes('refresh-client -C 61x20'), `the superseded first resize must NOT have nudged; log: ${log}`);
  child.kill('SIGINT');
  await result;
  viewer.close();
  await mock.stop();
});

test('terminal: a resize to the CURRENT size STILL nudges — the no-op resize (no SIGWINCH) is the motivating case (QA r4 T0-a)', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  const fakeDir = makeFakeDir({ work: {} });
  const { child, result, out } = runCli(['terminal', 'attach', 'work'], port, {
    FAKE_TMUX_DIR: fakeDir, PIDGE_TERMINAL_NUDGE_MS: '150', PIDGE_TERMINAL_NUDGE_PAUSE_MS: '20',
  });
  assert.ok(await waitFor(() => out.stdout.includes('"public_id"')), `stderr: ${out.stderr}`);
  const pid = JSON.parse(out.stdout.trim().split('\n')[0]).public_id;
  const viewer = connectViewer(port, pid);
  assert.ok(await waitFor(() => viewer.confirmed));

  // 80x24 is exactly what the fake reports — the nudge must fire even though
  // "nothing changed" (the whole point: a no-op resize gives no SIGWINCH).
  viewer.sendFrame(sealCtrlViewer(pid, { t: 'resize', vgen: VG, seq: 1, pid, cols: 80, rows: 24 }));
  const keysLog = path.join(fakeDir, 'keys.log');
  assert.ok(await waitFor(() => nudgeLanded(keysLog, 80, 24)),
    `no-op resize did not nudge; log: ${fs.existsSync(keysLog) ? fs.readFileSync(keysLog, 'utf8') : '(none)'}`);
  child.kill('SIGINT');
  await result;
  viewer.close();
  await mock.stop();
});

// ---------------------------------------------------------------------------
// Live ghost-cell stripper (QA T1 ghost). TERM=screen* shells emit the screen
// title sequence `ESC k <title> ST` around every command; tmux forwards it
// verbatim in %output and SwiftTerm paints the title as LITERAL text (it does
// not treat `ESC k` as a string introducer) — the live-only ghost that heals
// on reseed, because capture-pane never contains the sequence. The host strips
// exactly that sequence from the live path, statefully across chunk
// boundaries. Each emit.txt drop below is ONE %output line ⇒ ONE onOutput
// chunk, so the splits are real chunk splits, not string theater.
// ---------------------------------------------------------------------------

// Everything the viewer received on the LIVE lane (t:"o" frames only, seeds
// excluded), concatenated in arrival order.
const liveText = (viewer, pid) => viewer.frames
  .map((d) => openOutput(pid, d))
  .filter((f) => f.t === 'o')
  .map((f) => Buffer.from(f.data, 'base64').toString('latin1'))
  .join('');

// Boot an attached mirror with a joined viewer, plus an emit(bytes) that lands
// the bytes as ONE %output chunk (waits for the fake to consume the file, so
// two calls are GUARANTEED to be two separate chunks).
async function startLiveMirror(mock, port, fakeDir) {
  const { child, result, out } = runCli(['terminal', 'attach', 'work'], port, { FAKE_TMUX_DIR: fakeDir });
  assert.ok(await waitFor(() => out.stdout.includes('"public_id"')), `stderr: ${out.stderr}`);
  const pid = JSON.parse(out.stdout.trim().split('\n')[0]).public_id;
  // The CLI prints public_id BEFORE it subscribes the cable; a viewer that
  // joins in that window is a lost join (the mock only delivers to hosts
  // already subscribed) and the seed never comes — the same guard every
  // pre-existing live test uses.
  assert.ok(await waitFor(() => [...mock.state.terminalSubs].some((s) => s.role === 'host')), 'host never subscribed');
  const viewer = connectViewer(port, pid);
  assert.ok(await waitFor(() => viewer.frames.length >= 1), `no seed frame; stderr: ${out.stderr}`); // joined ⇒ output flows
  const emitFile = path.join(fakeDir, 'emit.txt');
  const emit = async (bytes) => {
    fs.writeFileSync(emitFile, Buffer.from(bytes, 'latin1'));
    assert.ok(await waitFor(() => !fs.existsSync(emitFile)), 'the fake never consumed emit.txt');
  };
  return { child, result, out, pid, viewer, emit };
}

test('terminal live stripper: `ESC k title ST` in one chunk — the title never reaches the viewer, the output does (QA T1 ghost)', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  const fakeDir = makeFakeDir({ work: {} });
  const { child, result, viewer, pid, emit } = await startLiveMirror(mock, port, fakeDir);

  await emit('\x1bkecho\x1b\\r2\r\n'); // exactly the on-device ghost: title "echo" glued to output "r2"
  assert.ok(await waitFor(() => liveText(viewer, pid).includes('r2')), 'live output never arrived');
  const text = liveText(viewer, pid);
  assert.ok(!text.includes('echo'), `the screen title leaked as ghost cells: ${JSON.stringify(text)}`);
  assert.strictEqual(text, 'r2\r\n');

  child.kill('SIGINT');
  await result;
  viewer.close();
  await mock.stop();
});

test('terminal live stripper: the sequence split across chunks — mid-title AND mid-`ESC k` — still stripped (state survives frames) (QA T1 ghost)', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  const fakeDir = makeFakeDir({ work: {} });
  const { child, result, viewer, pid, emit } = await startLiveMirror(mock, port, fakeDir);

  // Cut INSIDE the title: `…ESC k ec` | `ho ESC \ r2…`
  await emit('before \x1bkec');
  await emit('ho\x1b\\r2\r\n');
  // Cut INSIDE the introducer: a chunk ending on the bare ESC, `k…` opening the next.
  await emit('\x1b');
  await emit('kfoo\x1b\\ok\r\n');
  assert.ok(await waitFor(() => liveText(viewer, pid).includes('ok')), 'live output never arrived');
  const text = liveText(viewer, pid);
  assert.ok(!text.includes('echo') && !text.includes('foo'), `a split title leaked: ${JSON.stringify(text)}`);
  assert.strictEqual(text, 'before r2\r\nok\r\n');

  child.kill('SIGINT');
  await result;
  viewer.close();
  await mock.stop();
});

test('terminal live stripper: a bare ESC at a chunk edge that is NOT a title (`ESC [`) passes intact — no byte lost, order kept (QA T1 ghost)', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  const fakeDir = makeFakeDir({ work: {} });
  const { child, result, viewer, pid, emit } = await startLiveMirror(mock, port, fakeDir);

  await emit('\x1b');       // held: could still become `ESC k`…
  await emit('[31mred\r\n'); // …but it's SGR — the ESC must re-emit at the head of this chunk
  assert.ok(await waitFor(() => liveText(viewer, pid).includes('red')), 'live output never arrived');
  assert.strictEqual(liveText(viewer, pid), '\x1b[31mred\r\n');

  child.kill('SIGINT');
  await result;
  viewer.close();
  await mock.stop();
});

test('terminal live stripper: BEL also terminates the title (`ESC k title BEL out`) (QA T1 ghost)', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  const fakeDir = makeFakeDir({ work: {} });
  const { child, result, viewer, pid, emit } = await startLiveMirror(mock, port, fakeDir);

  await emit('\x1bktitle\x07out\r\n');
  assert.ok(await waitFor(() => liveText(viewer, pid).includes('out')), 'live output never arrived');
  const text = liveText(viewer, pid);
  assert.ok(!text.includes('title'), `a BEL-terminated title leaked: ${JSON.stringify(text)}`);
  assert.strictEqual(text, 'out\r\n');

  child.kill('SIGINT');
  await result;
  viewer.close();
  await mock.stop();
});

// ---------------------------------------------------------------------------
// Seed alternate-screen prefix (spec §4 "Seed state prefix" / gotcha #64 /
// QA 2026-07-29). capture-pane renders CELLS, so a pane's alternate-screen
// STATE never crosses the mirror — and the viewer's RIS wipes whatever state
// it had, so a viewer joining a pre-existing full-screen TUI never opened the
// iOS alt-drag gate. Cure: when the pane is on the alt screen the host
// prefixes the seed's data with ESC[?1049h, gated on a DOUBLE read of
// #{alternate_on} around the capture — both must agree or the prefix is
// withheld (fail closed). alt.txt scripts the fake's answers, one per read.
// ---------------------------------------------------------------------------

const ALT_PREFIX = '\x1b[?1049h';
// The fake's capture-pane body, exactly as the clean (no-prefix) seed carries it.
const FAKE_SEED_BODY = 'seed-line-1\r\nseed-line-2 \x1b[1mbold\x1b[0m\r\n%output %9 NOT_A_REAL_NOTIFICATION\r\n';
// Every seed the viewer received, decoded to latin1 bytes, in arrival order.
const seedTexts = (viewer, pid) => viewer.frames
  .map((d) => openOutput(pid, d))
  .filter((f) => f.t === 'seed')
  .map((f) => Buffer.from(f.data, 'base64').toString('latin1'));

test('terminal seed: a pane on the ALTERNATE screen prefixes the seed data with ESC[?1049h — the dump follows intact (gotcha #64)', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  const fakeDir = makeFakeDir({ work: {} });
  fs.writeFileSync(path.join(fakeDir, 'alt.txt'), '1'); // stable: both reads agree
  const { child, result, viewer, pid } = await startLiveMirror(mock, port, fakeDir);

  const seeds = seedTexts(viewer, pid);
  assert.strictEqual(seeds[0], ALT_PREFIX + FAKE_SEED_BODY,
    `expected the 1049h prefix then the untouched dump; got: ${JSON.stringify(seeds[0])}`);

  child.kill('SIGINT');
  await result;
  viewer.close();
  await mock.stop();
});

test('terminal seed: a NORMAL-screen pane seeds byte-identical to before — no prefix, no state carrier (gotcha #64)', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  const fakeDir = makeFakeDir({ work: {} }); // no alt.txt ⇒ alternate_on = 0
  const { child, result, viewer, pid } = await startLiveMirror(mock, port, fakeDir);

  const seeds = seedTexts(viewer, pid);
  assert.strictEqual(seeds[0], FAKE_SEED_BODY, `a normal-screen seed grew a prefix: ${JSON.stringify(seeds[0])}`);

  child.kill('SIGINT');
  await result;
  viewer.close();
  await mock.stop();
});

test('terminal seed: the two #{alternate_on} reads DISAGREE (TUI exited mid-seed) ⇒ NO prefix — fail closed (gotcha #64)', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  const fakeDir = makeFakeDir({ work: {} });
  // First read (geometry line) answers 1, the post-capture confirm answers 0:
  // arrows leaking into a normal shell would drive the zsh history — the gate
  // must stay shut.
  fs.writeFileSync(path.join(fakeDir, 'alt.txt'), '1\n0');
  const { child, result, viewer, pid } = await startLiveMirror(mock, port, fakeDir);

  const seeds = seedTexts(viewer, pid);
  assert.strictEqual(seeds[0], FAKE_SEED_BODY,
    `a disagreeing double-read must fail CLOSED (no prefix); got: ${JSON.stringify(seeds[0])}`);

  child.kill('SIGINT');
  await result;
  viewer.close();
  await mock.stop();
});

test('terminal seed: a RESEED also carries the prefix once the pane is on the alt screen (every seed path shares seed()) (gotcha #64)', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  const fakeDir = makeFakeDir({ work: {} }); // boots on the normal screen
  const { child, result, viewer, pid } = await startLiveMirror(mock, port, fakeDir);
  assert.strictEqual(seedTexts(viewer, pid)[0], FAKE_SEED_BODY); // join seed: clean

  // The TUI enters the alternate screen AFTER the first seed; the viewer's
  // reseed (foreground / gap heal) must now carry the state.
  fs.writeFileSync(path.join(fakeDir, 'alt.txt'), '1');
  const before = seedTexts(viewer, pid).length;
  viewer.sendFrame(sealCtrlViewer(pid, { t: 'reseed', vgen: VG, seq: 1, pid }));
  assert.ok(await waitFor(() => seedTexts(viewer, pid).length > before), 'reseed never produced a second seed');
  const reseeded = seedTexts(viewer, pid)[before];
  assert.strictEqual(reseeded, ALT_PREFIX + FAKE_SEED_BODY,
    `the reseed path lost the alt-screen prefix: ${JSON.stringify(reseeded)}`);

  child.kill('SIGINT');
  await result;
  viewer.close();
  await mock.stop();
});

test('terminal: interop with the iOS wire dialect — an iOS-form reseed opens on the host, the host seed passes the STRICT viewer reader', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  const { child, result, out } = runCli(['terminal', 'attach', 'work'], port, { FAKE_TMUX_DIR: makeFakeDir({ work: {} }) });
  assert.ok(await waitFor(() => out.stdout.includes('"public_id"')), `stderr: ${out.stderr}`);
  const pid = JSON.parse(out.stdout.trim().split('\n')[0]).public_id;
  assert.ok(await waitFor(() => [...mock.state.terminalSubs].some((s) => s.role === 'host')));

  const viewer = connectViewer(port, pid);
  assert.ok(await waitFor(() => viewer.confirmed));

  // EXACTLY what iOS TerminalSessionController sends: a 12-char [a-z0-9] vgen,
  // {t,vgen,seq,pid} sealed with terminal_ctrl_viewer anchored on the session
  // id, on the session's own :in stream (roaming — no control lane here).
  const iosVgen = 'k3v9x2mqab12';
  const before = viewer.frames.length;
  viewer.sendFrame(sealCtrlViewer(pid, { t: 'reseed', vgen: iosVgen, seq: 1, pid }));

  // The host answers with a seed on :out. Open it the way the iOS viewer does —
  // a STRICT standard-base64 reader (rejects base64url), then the [0x01] blob,
  // then terminal_output. If the host emitted base64url or a field envelope,
  // this reader gets nothing and the app would loop on reseed.
  assert.ok(await waitFor(() => viewer.frames.slice(before).some((d) => {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(d)) return false;       // strict standard base64 only
    const blob = Buffer.from(d, 'base64');
    if (blob[0] !== 0x01) return false;                         // blob framing version byte
    const f = openOutput(pid, d);
    return f.t === 'seed' && typeof f.data === 'string';
  })), `the host did not answer the iOS-form reseed with a strict-standard-base64 seed; stderr: ${out.stderr}`);

  child.kill('SIGINT');
  await result;
  viewer.close();
  await mock.stop();
});

test('terminal wrapper: creates the tmux session (wrapped CMD verbatim) and SIGINT stops the mirror WITHOUT deleting it', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  const fakeDir = makeFakeDir({});
  const { child, result, out } = runCli(['terminal', '--name', 'job', '--', 'claude', '--continue'], port, { FAKE_TMUX_DIR: fakeDir });

  assert.ok(await waitFor(() => out.stdout.includes('"public_id"')), `stderr: ${out.stderr}`);
  const sessions = JSON.parse(fs.readFileSync(path.join(fakeDir, 'sessions.json'), 'utf8'));
  assert.deepStrictEqual(sessions.job, { cmd: 'claude --continue' });
  assert.strictEqual(mock.state.terminalPosts[0].name, 'job');
  assert.ok(await waitFor(() => [...mock.state.terminalSubs].some((s) => s.role === 'host')));

  child.kill('SIGINT');
  const r = await result;
  assert.strictEqual(r.code, 0);
  assert.match(r.stderr, /KEEPS RUNNING/);
  assert.strictEqual(mock.state.terminalDeletes.length, 0); // mirror stop ≠ session end
  await mock.stop();
});

test('terminal: a second host process bumps the epoch and REUSES the public_id (one Terminals-tab row per session)', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  const fakeDir = makeFakeDir({ work: {} });
  const xdg = tmpDir('pidge-term-xdg-');

  const first = runCli(['terminal', 'attach', 'work'], port, { FAKE_TMUX_DIR: fakeDir, XDG_CONFIG_HOME: xdg });
  assert.ok(await waitFor(() => first.out.stdout.includes('"public_id"')));
  const id1 = JSON.parse(first.out.stdout.trim().split('\n')[0]);
  first.child.kill('SIGINT');
  await first.result;

  const second = runCli(['terminal', 'attach', 'work'], port, { FAKE_TMUX_DIR: fakeDir, XDG_CONFIG_HOME: xdg });
  assert.ok(await waitFor(() => second.out.stdout.includes('"public_id"')));
  const id2 = JSON.parse(second.out.stdout.trim().split('\n')[0]);
  assert.strictEqual(id2.public_id, id1.public_id);
  assert.strictEqual(id1.epoch, 1);
  assert.strictEqual(id2.epoch, 2);
  second.child.kill('SIGINT');
  await second.result;
  await mock.stop();
});

// ---------------------------------------------------------------------------
// REAL tmux integration — opt-in (PIDGE_TEST_TMUX=1) because CI runners don't
// ship tmux. Everything runs on an ISOLATED tmux server (-L, via
// PIDGE_TMUX_SOCKET) so the developer's real sessions are never touched.
// This is the proof the fake can't give: real control-mode framing, real
// octal escapes, a real shell echoing back through the sealed pipe.
// ---------------------------------------------------------------------------
const { execFileSync } = require('node:child_process');
const REAL_TMUX = process.env.PIDGE_TEST_TMUX === '1' && (() => {
  try { execFileSync('tmux', ['-V']); return true; } catch { return false; }
})();

test('terminal (REAL tmux): sealed seed + typed command echoes back through the relay', { skip: !REAL_TMUX || !HAS_WS }, async () => {
  const sockName = `pidge-test-${process.pid}`;
  const tmuxCtl = (args) => execFileSync('tmux', ['-L', sockName, ...args], { stdio: 'pipe' });
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  try {
    tmuxCtl(['new-session', '-d', '-s', 'realwork', '-x', '80', '-y', '24']);
    const { child, result, out } = runCli(['terminal', 'attach', 'realwork'], port, {
      PIDGE_TMUX_BIN: 'tmux',
      PIDGE_TMUX_SOCKET: sockName,
    });
    assert.ok(await waitFor(() => out.stdout.includes('"public_id"')), `stderr: ${out.stderr}`);
    const pid = JSON.parse(out.stdout.trim().split('\n')[0]).public_id;
    assert.ok(await waitFor(() => [...mock.state.terminalSubs].some((s) => s.role === 'host')));

    const viewer = connectViewer(port, pid);
    assert.ok(await waitFor(() => viewer.frames.length >= 1, 10000), 'no seed from real tmux');
    const seed = openOutput(pid, viewer.frames[0]);
    assert.strictEqual(seed.t, 'seed');
    assert.ok(seed.cols > 0 && seed.rows > 0);

    // type into the REAL shell through the sealed pipe; the echo (and the
    // command's output) must come back as sealed output frames.
    viewer.sendFrame(sealInput(pid, { t: 'i', vgen: VG, seq: 1, keys: [{ lit: 'echo PIDGE_RT_MARKER' }, { key: 'Enter' }] }));
    assert.ok(await waitFor(() => viewer.frames.some((d) => {
      const f = openOutput(pid, d);
      return f.t === 'o' && Buffer.from(f.data, 'base64').toString('latin1').includes('PIDGE_RT_MARKER');
    }), 10000), 'real-shell echo never arrived through the relay');

    child.kill('SIGINT');
    const r = await result;
    assert.strictEqual(r.code, 0);
    viewer.close();
  } finally {
    try { tmuxCtl(['kill-server']); } catch { /* already gone */ }
    await mock.stop();
  }
});

test('terminal (REAL tmux): a pre-existing alt-screen TUI (less) seeds with the ESC[?1049h prefix (gotcha #64)', { skip: !REAL_TMUX || !HAS_WS }, async () => {
  const sockName = `pidge-test-alt-${process.pid}`;
  const tmuxCtl = (args) => execFileSync('tmux', ['-L', sockName, ...args], { stdio: 'pipe' });
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  try {
    tmuxCtl(['new-session', '-d', '-s', 'realalt', '-x', '80', '-y', '24']);
    // Put a REAL full-screen TUI on the pane BEFORE any viewer exists — the
    // exact on-device scenario the gate never opened for. `less` of this test
    // file uses smcup/rmcup; poll #{alternate_on} so the shell's startup and
    // less's screen switch never race the assertion.
    tmuxCtl(['send-keys', '-t', 'realalt', '-l', `less ${__filename}`]);
    tmuxCtl(['send-keys', '-t', 'realalt', 'Enter']);
    assert.ok(await waitFor(() => {
      try { return tmuxCtl(['display-message', '-p', '-t', 'realalt', '#{alternate_on}']).toString().trim() === '1'; } catch { return false; }
    }, 10000), 'less never reached the alternate screen');

    const { child, result, out } = runCli(['terminal', 'attach', 'realalt'], port, {
      PIDGE_TMUX_BIN: 'tmux',
      PIDGE_TMUX_SOCKET: sockName,
    });
    assert.ok(await waitFor(() => out.stdout.includes('"public_id"')), `stderr: ${out.stderr}`);
    const pid = JSON.parse(out.stdout.trim().split('\n')[0]).public_id;
    assert.ok(await waitFor(() => [...mock.state.terminalSubs].some((s) => s.role === 'host')));

    const viewer = connectViewer(port, pid);
    assert.ok(await waitFor(() => viewer.frames.length >= 1, 10000), 'no seed from real tmux');
    const seed = openOutput(pid, viewer.frames[0]);
    assert.strictEqual(seed.t, 'seed');
    const data = Buffer.from(seed.data, 'base64').toString('latin1');
    assert.ok(data.startsWith(ALT_PREFIX),
      `real alt-screen seed did not start with ESC[?1049h; first bytes: ${JSON.stringify(data.slice(0, 24))}`);

    child.kill('SIGINT');
    const r = await result;
    assert.strictEqual(r.code, 0);
    viewer.close();
  } finally {
    try { tmuxCtl(['kill-server']); } catch { /* already gone */ }
    await mock.stop();
  }
});

test('terminal: usage errors are exit 1 (bad subcommand, bad --name, bad --link, misplaced flags)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const bad = runCli(['terminal', 'bogus'], port, {});
  assert.strictEqual((await bad.result).code, 1);
  const badName = runCli(['terminal', '--name', 'no:colons.allowed'], port, {});
  const r = await badName.result;
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /session name/);
  // --link takes the channel's NUMERIC id — anything else refuses before side effects
  const badLink = runCli(['terminal', 'attach', 'work', '--link', 'abc'], port, {});
  const rl = await badLink.result;
  assert.strictEqual(rl.code, 1);
  assert.match(rl.stderr, /numeric id/);
  assert.strictEqual(mock.state.terminalPosts.length, 0);
  // --link and --no-link conflict
  const both = runCli(['terminal', 'attach', 'work', '--link', '7', '--no-link'], port, {});
  assert.strictEqual((await both.result).code, 1);
  // link flags don't apply to the daemon; --machine-channel only to host --install
  const hostLink = runCli(['terminal', 'host', '--link', '3'], port, {});
  const rh = await hostLink.result;
  assert.strictEqual(rh.code, 1);
  assert.match(rh.stderr, /wrapper\/attach/);
  const wrapMachine = runCli(['terminal', '--machine-channel'], port, {});
  const rw = await wrapMachine.result;
  assert.strictEqual(rw.code, 1);
  assert.match(rw.stderr, /host --install/);
  await mock.stop();
});

// ---------------------------------------------------------------------------
// Advisory channel link (server ≥ manifest v94): --link / --no-link on the
// wrapper+attach upsert, project-env inference, the loud 422, and the
// old-server degrade. All ADVISORY — nothing here touches frames or sealing.
// ---------------------------------------------------------------------------

test('terminal --link: linked_channel_id rides the register upsert (integer, echoed, no warning)', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  mock.state.manifestVersion = 94;
  const { child, result, out } = runCli(['terminal', 'attach', 'work', '--link', '7'], port, { FAKE_TMUX_DIR: makeFakeDir({ work: {} }) });
  assert.ok(await waitFor(() => mock.state.terminalPosts.length >= 1), `stderr: ${out.stderr}`);
  assert.strictEqual(mock.state.terminalPosts[0].linked_channel_id, 7);
  assert.ok(await waitFor(() => out.stdout.includes('"public_id"')), `stderr: ${out.stderr}`);
  assert.match(out.stderr, /linking this session to channel id 7/);
  assert.doesNotMatch(out.stderr, /IGNORED/);
  child.kill('SIGINT');
  await result;
  await mock.stop();
});

test('terminal --no-link: an EXPLICIT null clears the stored link (partial upsert: omitted keeps, null clears)', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  mock.state.manifestVersion = 94;
  const { child, result, out } = runCli(['terminal', 'attach', 'work', '--no-link'], port, { FAKE_TMUX_DIR: makeFakeDir({ work: {} }) });
  assert.ok(await waitFor(() => mock.state.terminalPosts.length >= 1), `stderr: ${out.stderr}`);
  const post = mock.state.terminalPosts[0];
  assert.ok('linked_channel_id' in post, 'the clear must be an EXPLICIT null, not an omission');
  assert.strictEqual(post.linked_channel_id, null);
  assert.ok(await waitFor(() => out.stdout.includes('"public_id"')), `stderr: ${out.stderr}`);
  child.kill('SIGINT');
  await result;
  await mock.stop();
});

test('terminal --link: a plain register (no flags, no project env) sends NO linked_channel_id — omission keeps the stored value', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  mock.state.manifestVersion = 94;
  const { child, result, out } = runCli(['terminal', 'attach', 'work'], port, { FAKE_TMUX_DIR: makeFakeDir({ work: {} }) });
  assert.ok(await waitFor(() => mock.state.terminalPosts.length >= 1), `stderr: ${out.stderr}`);
  assert.ok(!('linked_channel_id' in mock.state.terminalPosts[0]), 'no decision ⇒ the key must be omitted entirely');
  child.kill('SIGINT');
  await result;
  await mock.stop();
});

test('terminal --link: the server\'s 422 invalid_linked_channel is surfaced LOUDLY (exit 2, no retry, no silent drop)', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  mock.state.manifestVersion = 94;
  mock.state.rejectLink = true;
  const { result } = runCli(['terminal', 'attach', 'work', '--link', '999'], port, { FAKE_TMUX_DIR: makeFakeDir({ work: {} }) });
  const r = await result;
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /REFUSED the channel link/);
  assert.match(r.stderr, /--link 999/);
  await sleep(200);
  assert.strictEqual(mock.state.terminalPosts.length, 1, 'an explicit refused link must never be retried');
  await mock.stop();
});

test('terminal --link on a pre-v94 server: register succeeds but the CLI says LOUDLY the link was ignored', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  mock.state.manifestVersion = 93; // today's prod — the param is silently dropped by the permit
  const { child, result, out } = runCli(['terminal', 'attach', 'work', '--link', '7'], port, { FAKE_TMUX_DIR: makeFakeDir({ work: {} }) });
  assert.ok(await waitFor(() => out.stdout.includes('"public_id"')), `stderr: ${out.stderr}`);
  assert.ok(await waitFor(() => /predates linked_channel_id/.test(out.stderr)), `no old-server warning; stderr: ${out.stderr}`);
  assert.match(out.stderr, /IGNORED/);
  child.kill('SIGINT');
  await result;
  await mock.stop();
});

// The inference setup: a git project whose toplevel hashes to a project-scoped
// pidge env (~/.config/pidge/projects/<hash>/env) holding ANOTHER channel's
// token — the wrapper started inside it must link that channel automatically.
function makeLinkedProject(xdg, port, token = 'hld_project') {
  const projDir = fs.realpathSync(tmpDir('pidge-proj-')); // realpath: the child's process.cwd() is kernel-resolved
  fs.mkdirSync(path.join(projDir, '.git'));
  const crypto = require('node:crypto');
  const hash = crypto.createHash('sha256').update(projDir).digest('hex').slice(0, 16);
  const envDir = path.join(xdg, 'pidge', 'projects', hash);
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, 'env'), `PIDGE_URL=http://127.0.0.1:${port}\nPIDGE_TOKEN=${token}\n`);
  return projDir;
}

test('terminal wrapper: the project-env inference links the project\'s channel — loudly, resolved via whoami', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  mock.state.manifestVersion = 94;
  mock.state.whoamiChannels.hld_project = { id: 9, name: 'proj-agent' };
  const xdg = tmpDir('pidge-term-xdg-');
  const projDir = makeLinkedProject(xdg, port);
  const { child, result, out } = runCli(['terminal', '--name', 'job'], port, { XDG_CONFIG_HOME: xdg }, { cwd: projDir });
  assert.ok(await waitFor(() => mock.state.terminalPosts.length >= 1), `stderr: ${out.stderr}`);
  assert.strictEqual(mock.state.terminalPosts[0].linked_channel_id, 9);
  assert.match(out.stderr, /linking this session to channel "proj-agent" \(id 9\)/);
  assert.match(out.stderr, /inferred from this project/);
  child.kill('SIGINT');
  await result;
  await mock.stop();
});

test('terminal wrapper: --no-link DISABLES the inference (explicit beats inferred)', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  mock.state.manifestVersion = 94;
  mock.state.whoamiChannels.hld_project = { id: 9, name: 'proj-agent' };
  const xdg = tmpDir('pidge-term-xdg-');
  const projDir = makeLinkedProject(xdg, port);
  const { child, result, out } = runCli(['terminal', '--name', 'job', '--no-link'], port, { XDG_CONFIG_HOME: xdg }, { cwd: projDir });
  assert.ok(await waitFor(() => mock.state.terminalPosts.length >= 1), `stderr: ${out.stderr}`);
  assert.strictEqual(mock.state.terminalPosts[0].linked_channel_id, null);
  assert.doesNotMatch(out.stderr, /inferred/);
  child.kill('SIGINT');
  await result;
  await mock.stop();
});

test('terminal wrapper: a REFUSED inferred link never kills the mirror — it re-registers without it, loudly', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  mock.state.manifestVersion = 94;
  mock.state.rejectLink = true; // models an unknown/foreign id refusal
  mock.state.whoamiChannels.hld_project = { id: 9, name: 'proj-agent' };
  const xdg = tmpDir('pidge-term-xdg-');
  const projDir = makeLinkedProject(xdg, port);
  const { child, result, out } = runCli(['terminal', '--name', 'job'], port, { XDG_CONFIG_HOME: xdg }, { cwd: projDir });
  assert.ok(await waitFor(() => out.stdout.includes('"public_id"')), `mirror never started; stderr: ${out.stderr}`);
  assert.match(out.stderr, /refused the inferred channel link/);
  assert.strictEqual(mock.state.terminalPosts.length, 2);
  assert.strictEqual(mock.state.terminalPosts[0].linked_channel_id, 9);
  assert.ok(!('linked_channel_id' in mock.state.terminalPosts[1]), 'the retry must register WITHOUT the link');
  child.kill('SIGINT');
  await result;
  await mock.stop();
});
