'use strict';
// `pidge terminal host` acceptance — the daemon against the mock relay and
// the scripted tmux stand-in, plus the pure profile-whitelist parser:
//   · profiles TOML subset: strings, comments, unknown keys ignored,
//     malformed lines are warnings (never a crash), duplicates first-wins;
//   · control lane: register (kind control), sessions+profiles published
//     sealed on viewer join;
//   · spawn strictly by whitelist NAME (unknown profile refused, command
//     lines never come from the wire);
//   · inventory keeps rows registered as tmux sessions appear;
//   · lazy attach: a viewer join on a session starts the tap and seeds; the
//     last leave stands the tap down after the grace period;
//   · one host per channel (PID-checked lock);
//   · --install writes the launchd/systemd template, key never embedded;
//   · clean shutdown DELETEs the control row, never the session rows.
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
const { parseProfiles } = require('../src/terminal/profiles');
const { deriveSessionName } = require('../src/terminal/host');

const spawn = (cmd, args, opts = {}) => track(rawSpawn(cmd, args, { ...opts, detached: true }));
const CLI = path.join(__dirname, '..', 'bin', 'pidge.js');
const FAKE_TMUX = path.join(__dirname, 'fake-tmux.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const HAS_WS = typeof WebSocket === 'function';

const KEY = Buffer.alloc(32, 5);
const SECRET = KEY.toString('base64url');
const VG = 'hostvgen1'; // a valid vgen ([a-z0-9]{8,}) for the test viewer's control frames
// The iOS wire form: blob framing → STANDARD base64.
const sealBlob = (pid, field, frame) => e2eEncryptBlob(KEY, e2eAad(1, pid, field), Buffer.from(JSON.stringify(frame), 'utf8')).toString('base64');
const sealCtrlViewer = (pid, frame) => sealBlob(pid, 'terminal_ctrl_viewer', frame);
const openCtrlHost = (pid, data) => JSON.parse(e2eDecryptBlob(KEY, e2eAad(1, pid, 'terminal_ctrl_host'), Buffer.from(data, 'base64')).toString('utf8'));
const openOutput = (pid, data) => JSON.parse(e2eDecryptBlob(KEY, e2eAad(1, pid, 'terminal_output'), Buffer.from(data, 'base64')).toString('utf8'));

function runHost(port, env = {}) {
  const fakeDir = env.FAKE_TMUX_DIR || tmpDir('pidge-hosttmux-');
  const child = spawn(process.execPath, [CLI, 'terminal', 'host'], {
    env: {
      ...process.env,
      PIDGE_URL: `http://127.0.0.1:${port}`,
      PIDGE_TOKEN: 'hld_test',
      PIDGE_SECRET: SECRET,
      PIDGE_TMUX_BIN: FAKE_TMUX,
      PIDGE_TERMINAL_FLUSH_MS: '30',
      PIDGE_TERMINAL_BACKOFF_MS: '200',
      PIDGE_TERMINAL_INVENTORY_MS: '150',
      PIDGE_TERMINAL_STANDDOWN_MS: '250',
      PIDGE_QUIET_NAG: '1',
      HOME: tmpDir('pidge-host-home-'),
      XDG_CONFIG_HOME: tmpDir('pidge-host-xdg-'),
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

function connectViewer(port, pid) {
  const sock = new WebSocketClient(`ws://127.0.0.1:${port}/cable`, ['actioncable-v1-json', 'ses_viewer']);
  const identifier = JSON.stringify({ channel: 'TerminalChannel', session: pid });
  const viewer = {
    sock, identifier, confirmed: false, frames: [],
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
  const dir = tmpDir('pidge-hosttmux-');
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify(sessions));
  try { fs.chmodSync(FAKE_TMUX, 0o755); } catch { /* repo mode already fine */ }
  return dir;
}

function writeProfiles(xdg, text) {
  const dir = path.join(xdg, 'pidge');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'terminal.toml'), text);
}

// ---- pure units -------------------------------------------------------------

test('profiles: TOML subset — strings, comments, unknown keys/sections ignored, warnings never throw', () => {
  const { profiles, warnings } = parseProfiles([
    '# whitelist',
    '[[profile]]',
    'name = "Claude @ proj"',
    'cwd  = "~/proj"     # inline comment',
    "cmd  = 'claude --continue'",
    'color = "red"',            // unknown key — ignored
    '',
    '[server]',                 // foreign section — skipped whole
    'url = "https://nope"',
    '',
    '[[profile]]',
    'name = "Shell"',
    'cmd = "bash"',
    '',
    '[[profile]]',              // missing cmd — skipped with a warning
    'name = "broken"',
    '',
    '[[profile]]',              // duplicate — first wins
    'name = "Shell"',
    'cmd = "zsh"',
    '',
    '[[profile]]',
    'name = "bad value"',
    'cmd = bare-word',          // not a string — warning, profile then lacks cmd
  ].join('\n'));
  assert.deepStrictEqual(profiles, [
    { name: 'Claude @ proj', cwd: '~/proj', cmd: 'claude --continue' },
    { name: 'Shell', cmd: 'bash' },
  ]);
  // broken (no cmd), duplicate Shell, the bare-word value, and the profile
  // that ends up cmd-less because of it
  assert.strictEqual(warnings.length, 4);
});

test('profiles: escapes in basic strings, literal strings verbatim', () => {
  const { profiles } = parseProfiles('[[profile]]\nname = "a\\"b"\ncmd = "line\\nbreak\\t\\\\"\n');
  assert.deepStrictEqual(profiles, [{ name: 'a"b', cmd: 'line\nbreak\t\\' }]);
});

test('deriveSessionName: whitelist charset, bounded, collision-suffixed', () => {
  assert.strictEqual(deriveSessionName('Claude @ my proj!', new Set()), 'Claude-@-my-proj');
  assert.strictEqual(deriveSessionName('Shell', new Set(['Shell'])), 'Shell-2');
  assert.strictEqual(deriveSessionName('Shell', new Set(['Shell', 'Shell-2'])), 'Shell-3');
  assert.strictEqual(deriveSessionName('!!!', new Set()), 'job');
});

// ---- the daemon ---------------------------------------------------------------

test('terminal host: control lane + inventory + spawn-by-whitelist + lazy attach/stand-down + clean shutdown', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  const fakeDir = makeFakeDir({ alpha: {} });
  const xdg = tmpDir('pidge-host-xdg-');
  writeProfiles(xdg, '[[profile]]\nname = "Shell"\ncmd = "bash"\n[[profile]]\nname = "Claude @ proj"\ncwd = "~/proj"\ncmd = "claude"\n');

  const { child, result, out } = runHost(port, { FAKE_TMUX_DIR: fakeDir, XDG_CONFIG_HOME: xdg });

  assert.ok(await waitFor(() => out.stdout.includes('"control_public_id"')), `stderr: ${out.stderr}`);
  const head = JSON.parse(out.stdout.trim().split('\n')[0]);
  assert.match(head.control_public_id, /^term_[a-z0-9-]+$/);
  assert.deepStrictEqual(head.profiles, ['Shell', 'Claude @ proj']);
  assert.strictEqual(head.sessions, 1);

  // rows: the control lane + the discovered tmux session
  const ctrlPost = mock.state.terminalPosts.find((p) => p.kind === 'control');
  const alphaPost = mock.state.terminalPosts.find((p) => p.name === 'alpha');
  assert.ok(ctrlPost && alphaPost);
  assert.strictEqual(ctrlPost.public_id, head.control_public_id);
  assert.strictEqual(alphaPost.kind, 'term');

  // control-lane viewer joins → sealed sessions + profiles frames
  const ctrlViewer = connectViewer(port, head.control_public_id);
  assert.ok(await waitFor(() => ctrlViewer.frames.length >= 2), `stderr: ${out.stderr}`);
  const ctrlFrames = ctrlViewer.frames.map((d) => openCtrlHost(head.control_public_id, d));
  const sessionsFrame = ctrlFrames.find((f) => f.t === 'sessions');
  const profilesFrame = ctrlFrames.find((f) => f.t === 'profiles');
  assert.ok(sessionsFrame && profilesFrame);
  assert.deepStrictEqual(profilesFrame.names, ['Shell', 'Claude @ proj']);
  assert.strictEqual(sessionsFrame.list.length, 1);
  assert.strictEqual(sessionsFrame.list[0].name, 'alpha');
  const alphaPid = sessionsFrame.list[0].pid;
  assert.strictEqual(alphaPost.public_id, alphaPid);

  // spawn BY NAME from the whitelist → tmux session created with the
  // profile's cmd, registered, and a fresh sessions frame published
  ctrlViewer.sendFrame(sealCtrlViewer(head.control_public_id, { t: 'spawn', vgen: VG, seq: 1, profile: 'Shell' }));
  assert.ok(await waitFor(() => {
    const s = JSON.parse(fs.readFileSync(path.join(fakeDir, 'sessions.json'), 'utf8'));
    return s.Shell && s.Shell.cmd === 'bash';
  }), `spawn never landed; stderr: ${out.stderr}`);
  assert.ok(await waitFor(() => mock.state.terminalPosts.some((p) => p.name === 'Shell')));
  assert.ok(await waitFor(() => ctrlViewer.frames.some((d) => {
    const f = openCtrlHost(head.control_public_id, d);
    return f.t === 'sessions' && f.list.some((s) => s.name === 'Shell');
  })));

  // an unknown profile is REFUSED — a viewer can never originate a command
  const sessionsBefore = Object.keys(JSON.parse(fs.readFileSync(path.join(fakeDir, 'sessions.json'), 'utf8'))).length;
  ctrlViewer.sendFrame(sealCtrlViewer(head.control_public_id, { t: 'spawn', vgen: VG, seq: 2, profile: 'Evil; rm -rf /' }));
  await sleep(400);
  assert.strictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(fakeDir, 'sessions.json'), 'utf8'))).length, sessionsBefore);
  assert.match(out.stderr, /spawn REFUSED/);

  // editing the whitelist is picked up WITHOUT a restart (the daemon lives
  // under launchd) — a fresh profiles frame is published
  await sleep(20); // ensure a distinct mtime even on coarse filesystems
  writeProfiles(xdg, '[[profile]]\nname = "Shell"\ncmd = "bash"\n[[profile]]\nname = "Deploy"\ncmd = "make deploy"\n');
  assert.ok(await waitFor(() => ctrlViewer.frames.some((d) => {
    const f = openCtrlHost(head.control_public_id, d);
    return f.t === 'profiles' && f.names.includes('Deploy');
  }), 5000), `profiles reload never published; stderr: ${out.stderr}`);

  // lazy attach: a viewer joins alpha → the tap starts and a seed arrives
  const alphaViewer = connectViewer(port, alphaPid);
  assert.ok(await waitFor(() => alphaViewer.frames.length >= 1), `no seed; stderr: ${out.stderr}`);
  const seed = openOutput(alphaPid, alphaViewer.frames[0]);
  assert.strictEqual(seed.t, 'seed');
  assert.strictEqual(seed.epoch, 1); // first tap of this session
  assert.match(out.stderr, /attached 'alpha'/);

  // last leave → stand down after the grace period (observable as the
  // control client's detach)
  alphaViewer.close();
  const keysLog = path.join(fakeDir, 'keys.log');
  assert.ok(await waitFor(() => fs.existsSync(keysLog) && fs.readFileSync(keysLog, 'utf8').includes('detach-client'), 5000),
    `no stand-down; stderr: ${out.stderr}`);
  assert.match(out.stderr, /stood down from 'alpha'/);

  // clean shutdown: control row DELETEd (this process IS the control lane);
  // session rows stay (tmux keeps running, they just go offline)
  child.kill('SIGTERM');
  const r = await result;
  assert.strictEqual(r.code, 0);
  assert.ok(mock.state.terminalDeletes.includes(head.control_public_id));
  assert.ok(!mock.state.terminalDeletes.includes(alphaPid));

  ctrlViewer.close();
  await mock.stop();
});

test('terminal host: a control-lane resize schedules the repaint nudge on the attached session (QA r4 T0-a)', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  const fakeDir = makeFakeDir({ alpha: {} });
  const { child, result, out } = runHost(port, {
    FAKE_TMUX_DIR: fakeDir, PIDGE_TERMINAL_NUDGE_MS: '150', PIDGE_TERMINAL_NUDGE_PAUSE_MS: '20',
  });
  assert.ok(await waitFor(() => out.stdout.includes('"control_public_id"')), `stderr: ${out.stderr}`);
  const ctrlPid = JSON.parse(out.stdout.trim().split('\n')[0]).control_public_id;

  // learn alpha's pid from a sessions frame on the control lane
  const ctrlViewer = connectViewer(port, ctrlPid);
  assert.ok(await waitFor(() => ctrlViewer.frames.some((d) => {
    const f = openCtrlHost(ctrlPid, d);
    return f.t === 'sessions' && f.list.some((s) => s.name === 'alpha');
  })), `no sessions frame; stderr: ${out.stderr}`);
  const alphaPid = ctrlViewer.frames.map((d) => openCtrlHost(ctrlPid, d))
    .reverse().find((f) => f.t === 'sessions').list.find((s) => s.name === 'alpha').pid;

  // the control-lane resize is a no-op unless the session has a live tap:
  // a viewer joins alpha (lazy attach), then the resize rides the CONTROL lane.
  const alphaViewer = connectViewer(port, alphaPid);
  assert.ok(await waitFor(() => alphaViewer.frames.length >= 1), `no seed; stderr: ${out.stderr}`);

  ctrlViewer.sendFrame(sealCtrlViewer(ctrlPid, { t: 'resize', vgen: VG, seq: 1, pid: alphaPid, cols: 71, rows: 25 }));
  const keysLog = path.join(fakeDir, 'keys.log');
  assert.ok(await waitFor(() => {
    if (!fs.existsSync(keysLog)) return false;
    const lines = fs.readFileSync(keysLog, 'utf8').split('\n');
    const down = lines.indexOf('refresh-client -C 71x24');
    return down !== -1 && lines.indexOf('refresh-client -C 71x25', down + 1) !== -1;
  }), `control-lane nudge never appeared; log: ${fs.existsSync(keysLog) ? fs.readFileSync(keysLog, 'utf8') : '(none)'}`);

  child.kill('SIGTERM');
  await result;
  ctrlViewer.close();
  alphaViewer.close();
  await mock.stop();
});

test('terminal host: a vanished tmux session gets its row ended on the next inventory pass', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  const fakeDir = makeFakeDir({ alpha: {}, beta: {} });
  const { child, result, out } = runHost(port, { FAKE_TMUX_DIR: fakeDir });
  assert.ok(await waitFor(() => out.stdout.includes('"control_public_id"')), `stderr: ${out.stderr}`);
  const betaPid = () => (mock.state.terminalPosts.find((p) => p.name === 'beta') || {}).public_id;
  assert.ok(await waitFor(() => !!betaPid()));

  // beta dies outside our control (tmux kill-session elsewhere)
  const sessions = JSON.parse(fs.readFileSync(path.join(fakeDir, 'sessions.json'), 'utf8'));
  delete sessions.beta;
  fs.writeFileSync(path.join(fakeDir, 'sessions.json'), JSON.stringify(sessions));

  assert.ok(await waitFor(() => mock.state.terminalDeletes.includes(betaPid()), 5000), `stderr: ${out.stderr}`);
  child.kill('SIGTERM');
  await result;
  await mock.stop();
});

test('terminal host: a replayed control spawn frame (same vgen) is DROPPED; a genuine reconnect (new vgen, seq 1) still spawns', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  const xdg = tmpDir('pidge-host-xdg-');
  writeProfiles(xdg, '[[profile]]\nname = "Shell"\ncmd = "bash"\n');
  const { child, result, out } = runHost(port, { FAKE_TMUX_DIR: makeFakeDir({}), XDG_CONFIG_HOME: xdg });
  assert.ok(await waitFor(() => out.stdout.includes('"control_public_id"')), `stderr: ${out.stderr}`);
  const ctrlPid = JSON.parse(out.stdout.trim().split('\n')[0]).control_public_id;

  // a legit spawn at (vgen VG, seq 1) lands one 'Shell' session
  const v1 = connectViewer(port, ctrlPid);
  assert.ok(await waitFor(() => v1.confirmed));
  const capturedSpawn = { t: 'spawn', vgen: VG, seq: 1, profile: 'Shell' };
  v1.sendFrame(sealCtrlViewer(ctrlPid, capturedSpawn));
  assert.ok(await waitFor(() => mock.state.terminalPosts.some((p) => p.name === 'Shell')), `spawn never landed; stderr: ${out.stderr}`);

  // A hostile relay reconnects a viewer (fresh, forgeable join) and REPLAYS the
  // captured sealed frame — it carries its ORIGINAL vgen (VG) + seq 1, which
  // lands in VG's ledger (1 ≤ 1) and is dropped. The relay cannot mint a new
  // vgen (it's inside the seal), so no 'Shell-2' is ever spawned by replay.
  v1.close();
  const v2 = connectViewer(port, ctrlPid);
  assert.ok(await waitFor(() => v2.confirmed));
  v2.sendFrame(sealCtrlViewer(ctrlPid, capturedSpawn));                              // replay (same vgen, seq 1)
  v2.sendFrame(sealCtrlViewer(ctrlPid, { t: 'spawn', vgen: VG, seq: 1, profile: 'Shell' })); // and again
  await sleep(500);
  assert.ok(!mock.state.terminalPosts.some((p) => p.name === 'Shell-2'), `a replayed spawn created a second session; posts: ${JSON.stringify(mock.state.terminalPosts.map((p) => p.name))}`);

  // BUT a genuine reconnect — a NEW vgen at seq 1 — MUST spawn again (the old
  // lifetime-high-water design wrongly dropped a reconnected viewer forever).
  v2.sendFrame(sealCtrlViewer(ctrlPid, { t: 'spawn', vgen: 'freshvgen9', seq: 1, profile: 'Shell' }));
  assert.ok(await waitFor(() => mock.state.terminalPosts.some((p) => p.name === 'Shell-2')), `a reconnected viewer (new vgen, seq 1) could not spawn; stderr: ${out.stderr}`);

  child.kill('SIGTERM');
  await result;
  v2.close();
  await mock.stop();
});

test('terminal host: a transient register failure is RETRIED on a later inventory pass (not hidden forever)', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  // Fail the FIRST registration of the 'alpha' inventory row (the control lane
  // registers under the hostname and is unaffected); the daemon must retry.
  mock.state.terminalRegisterFailName = 'alpha';
  mock.state.terminalRegisterFailTimes = 1;
  const { child, result, out } = runHost(port, { FAKE_TMUX_DIR: makeFakeDir({ alpha: {} }) });
  assert.ok(await waitFor(() => out.stdout.includes('"control_public_id"')), `stderr: ${out.stderr}`);

  // first attempt 500s; a later pass re-POSTs and succeeds → alpha becomes a row
  assert.ok(await waitFor(() => Object.values(mock.state.terminalSessions).some((r) => r.name === 'alpha'), 5000),
    `alpha never registered after the transient failure; stderr: ${out.stderr}`);
  const alphaPosts = mock.state.terminalPosts.filter((p) => p.name === 'alpha').length;
  assert.ok(alphaPosts >= 2, `expected a retry (≥2 POSTs for alpha), saw ${alphaPosts}`);

  child.kill('SIGTERM');
  await result;
  await mock.stop();
});

test('terminal host: ONE per channel — a second host is refused (exit 2) while the first is live', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  const xdg = tmpDir('pidge-host-xdg-');
  const first = runHost(port, { FAKE_TMUX_DIR: makeFakeDir({ alpha: {} }), XDG_CONFIG_HOME: xdg });
  assert.ok(await waitFor(() => first.out.stdout.includes('"control_public_id"')));

  const second = runHost(port, { FAKE_TMUX_DIR: makeFakeDir({}), XDG_CONFIG_HOME: xdg });
  const r2 = await second.result;
  assert.strictEqual(r2.code, 2);
  assert.match(r2.stderr, /another host daemon is live/);

  first.child.kill('SIGTERM');
  await first.result;
  await mock.stop();
});

test('terminal host --install: launchd template on darwin — daemon args, NO key embedded', async () => {
  const home = tmpDir('pidge-install-home-');
  const install = spawn(process.execPath, [CLI, 'terminal', 'host', '--install'], {
    env: {
      ...process.env,
      PIDGE_URL: 'http://127.0.0.1:9', PIDGE_TOKEN: 'hld_test', PIDGE_SECRET: SECRET,
      PIDGE_TERMINAL_PLATFORM: 'darwin', PIDGE_QUIET_NAG: '1',
      HOME: home, XDG_CONFIG_HOME: tmpDir('pidge-install-xdg-'),
    },
  });
  const iout = { stdout: '', stderr: '' };
  install.stdout.on('data', (c) => { iout.stdout += c; });
  install.stderr.on('data', (c) => { iout.stderr += c; });
  const code = await new Promise((r) => install.on('exit', r));
  assert.strictEqual(code, 0, iout.stderr);
  const res = JSON.parse(iout.stdout);
  assert.strictEqual(res.platform, 'launchd');
  const plist = fs.readFileSync(res.file, 'utf8');
  assert.ok(res.file.startsWith(path.join(home, 'Library', 'LaunchAgents')));
  assert.match(plist, /<string>terminal<\/string>\s*<string>host<\/string>/);
  assert.ok(!plist.includes('hld_test'), 'the channel key must NEVER be embedded');
  assert.match(plist, /SuccessfulExit/);
});

// ---------------------------------------------------------------------------
// --install --machine-channel: auto-create (or reuse) the HIDDEN machine
// channel, key stored in the daemon's OWN scope — never the shared env.
// ---------------------------------------------------------------------------

function runInstall(port, env = {}) {
  const child = spawn(process.execPath, [CLI, 'terminal', 'host', '--install', '--machine-channel'], {
    env: {
      ...process.env,
      PIDGE_URL: `http://127.0.0.1:${port}`,
      PIDGE_TOKEN: 'hld_test',
      PIDGE_AGENT: '',
      PIDGE_TERMINAL_PLATFORM: 'darwin',
      PIDGE_QUIET_NAG: '1',
      ...env,
    },
  });
  const out = { code: null, stdout: '', stderr: '' };
  child.stdout.on('data', (c) => { out.stdout += c; });
  child.stderr.on('data', (c) => { out.stderr += c; });
  const result = new Promise((resolve) => { child.on('exit', (code) => { out.code = code; resolve(out); }); });
  return { result, out };
}

test('terminal host --install --machine-channel: mints the hidden channel, stores the key in the daemon scope, NEVER clobbers the shared env', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.manifestVersion = 94;
  const home = tmpDir('pidge-mc-home-');
  const xdg = tmpDir('pidge-mc-xdg-');
  // a pre-existing SHARED env (another channel's key) that must stay untouched
  const sharedEnv = path.join(xdg, 'pidge', 'env');
  fs.mkdirSync(path.dirname(sharedEnv), { recursive: true });
  fs.writeFileSync(sharedEnv, 'PIDGE_TOKEN=hld_someone_else\n');

  const { result } = runInstall(port, { HOME: home, XDG_CONFIG_HOME: xdg });
  const r = await result;
  assert.strictEqual(r.code, 0, r.stderr);

  // the create: hidden:true, named after the host
  assert.strictEqual(mock.state.channelPosts.length, 1);
  assert.strictEqual(mock.state.channelPosts[0].hidden, true);
  assert.ok(String(mock.state.channelPosts[0].name).startsWith('🖥️ '), mock.state.channelPosts[0].name);

  // the minted key lands in the DAEMON scope only — the shared env is untouched
  const daemonEnv = path.join(xdg, 'pidge', 'agents', 'terminal-host', 'env');
  const stored = fs.readFileSync(daemonEnv, 'utf8');
  assert.match(stored, /PIDGE_TOKEN=hld_minted_/);
  assert.match(stored, new RegExp(`PIDGE_URL=http://127\\.0\\.0\\.1:${port}`));
  assert.strictEqual(fs.readFileSync(sharedEnv, 'utf8'), 'PIDGE_TOKEN=hld_someone_else\n');

  // stdout JSON names the machine channel + its env file
  const res = JSON.parse(r.stdout);
  assert.strictEqual(res.machine_channel.hidden, true);
  assert.strictEqual(res.machine_channel.reused, false);
  assert.strictEqual(res.machine_channel.env_file, daemonEnv);

  // the template pins the daemon to the machine scope and embeds NO key
  const plist = fs.readFileSync(res.file, 'utf8');
  assert.match(plist, /<key>PIDGE_AGENT<\/key><string>terminal-host<\/string>/);
  assert.ok(!plist.includes('hld_minted'), 'the minted key must NEVER be embedded');
  assert.ok(!plist.includes('hld_test'), 'the creator key must NEVER be embedded');

  // sealed-only next steps are narrated (the fresh channel is not E2E yet)
  assert.match(r.stderr, /sealed-only/);
  assert.match(r.stderr, /PIDGE_SECRET/);
  assert.match(r.stderr, /PIDGE_AGENT=terminal-host pidge doctor/);
  await mock.stop();
});

test('terminal host --install --machine-channel: a re-install REUSES the stored machine channel — no duplicate mint', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.manifestVersion = 94;
  const home = tmpDir('pidge-mc-home-');
  const xdg = tmpDir('pidge-mc-xdg-');

  const first = runInstall(port, { HOME: home, XDG_CONFIG_HOME: xdg });
  assert.strictEqual((await first.result).code, 0, first.out.stderr);
  assert.strictEqual(mock.state.channelPosts.length, 1);

  const second = runInstall(port, { HOME: home, XDG_CONFIG_HOME: xdg });
  const r2 = await second.result;
  assert.strictEqual(r2.code, 0, r2.stderr);
  assert.strictEqual(mock.state.channelPosts.length, 1, 'a re-install must never mint a second machine channel');
  assert.match(r2.stderr, /reusing the machine channel/);
  assert.strictEqual(JSON.parse(r2.stdout).machine_channel.reused, true);
  await mock.stop();
});

test('terminal host: the installed machine scope WORKS — the daemon resolves key+URL from agents/terminal-host/env via PIDGE_AGENT, no ambient token', { skip: !HAS_WS }, async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.manifestVersion = 94;
  mock.state.e2eEnabled = true;
  const home = tmpDir('pidge-mc-home-');
  const xdg = tmpDir('pidge-mc-xdg-');
  const inst = runInstall(port, { HOME: home, XDG_CONFIG_HOME: xdg });
  assert.strictEqual((await inst.result).code, 0, inst.out.stderr);
  const envFile = path.join(xdg, 'pidge', 'agents', 'terminal-host', 'env');
  // what the app's terminal step writes next to the token
  fs.appendFileSync(envFile, `PIDGE_SECRET=${SECRET}\n`);

  // The daemon exactly as launchd would run it: PIDGE_AGENT pins the scope,
  // NO token/URL/secret in the environment — everything comes from the file.
  const { child, result, out } = runHost(port, {
    HOME: home, XDG_CONFIG_HOME: xdg, PIDGE_AGENT: 'terminal-host',
    PIDGE_URL: '', PIDGE_TOKEN: '', PIDGE_SECRET: '', HERALD_URL: '', HERALD_TOKEN: '',
    FAKE_TMUX_DIR: makeFakeDir({ alpha: {} }),
  });
  assert.ok(await waitFor(() => out.stdout.includes('"control_public_id"')), `daemon never came up from the machine scope; stderr: ${out.stderr}`);
  assert.ok(mock.state.terminalPosts.some((p) => p.kind === 'control'));
  child.kill('SIGTERM');
  assert.strictEqual((await result).code, 0);
  await mock.stop();
});

test('terminal host --install --machine-channel: a pre-v94 server is refused LOUDLY before anything is created', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.manifestVersion = 93; // today's prod: hidden:true would silently mint a VISIBLE channel
  const xdg = tmpDir('pidge-mc-xdg-');
  const { result } = runInstall(port, { HOME: tmpDir('pidge-mc-home-'), XDG_CONFIG_HOME: xdg });
  const r = await result;
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /VISIBLE/);
  assert.match(r.stderr, /Nothing was created/);
  assert.strictEqual(mock.state.channelPosts.length, 0);
  assert.ok(!fs.existsSync(path.join(xdg, 'pidge', 'agents', 'terminal-host', 'env')));
  await mock.stop();
});

test('terminal host --install --machine-channel: a foreign PIDGE_AGENT scope is refused (they would fight over the daemon env)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.manifestVersion = 94;
  const { result } = runInstall(port, {
    HOME: tmpDir('pidge-mc-home-'), XDG_CONFIG_HOME: tmpDir('pidge-mc-xdg-'), PIDGE_AGENT: 'myagent',
  });
  const r = await result;
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /PIDGE_AGENT/);
  assert.strictEqual(mock.state.channelPosts.length, 0);
  await mock.stop();
});

test('terminal host --install: systemd template on linux — unit shape, NO key embedded', async () => {
  const xdg = tmpDir('pidge-install-xdg-');
  const install = spawn(process.execPath, [CLI, 'terminal', 'host', '--install'], {
    env: {
      ...process.env,
      PIDGE_URL: 'http://127.0.0.1:9', PIDGE_TOKEN: 'hld_test', PIDGE_SECRET: SECRET,
      PIDGE_TERMINAL_PLATFORM: 'linux', PIDGE_QUIET_NAG: '1',
      HOME: tmpDir('pidge-install-home-'), XDG_CONFIG_HOME: xdg,
    },
  });
  const iout = { stdout: '', stderr: '' };
  install.stdout.on('data', (c) => { iout.stdout += c; });
  install.stderr.on('data', (c) => { iout.stderr += c; });
  const code = await new Promise((r) => install.on('exit', r));
  assert.strictEqual(code, 0, iout.stderr);
  const res = JSON.parse(iout.stdout);
  assert.strictEqual(res.platform, 'systemd');
  const unit = fs.readFileSync(res.file, 'utf8');
  assert.ok(res.file.startsWith(path.join(xdg, 'systemd', 'user')));
  assert.match(unit, /terminal.*host/);
  assert.match(unit, /Restart=on-failure/);
  assert.ok(!unit.includes('hld_test'));
});
