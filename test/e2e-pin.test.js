'use strict';
// #313 — the local anti-downgrade pin. The seal decision used to trust
// server-served flags in BOTH directions: e2eEnabled=false (or a failing
// whoami) made the CLI send PLAINTEXT despite holding the key. Contract now:
//   • the first CONFIRMED sealed context stamps state.json (e2ePinned)
//   • pinned ⇒ a would-be clear send is REFUSED (exit 2, nothing on the wire)
//     when the server says off, when whoami fails, or when the secret vanished
//   • only a LOCAL action unpins: PIDGE_E2E=off (env var or env file) — a
//     server response alone can never unpin.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createMock } = require('./mock-server');

const CLI = path.join(__dirname, '..', 'bin', 'pidge.js');
const e2e = require(CLI); // test seam: pure helpers only
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'e2e_vectors.json'), 'utf8'));
const SECRET = FIXTURE.key_b64url;
// The pin is keyed by a hash of the channel token (per CHANNEL, not per install).
const PIN_KEY = e2e.e2ePinKeyFor('hld_test');

function freshXdg() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-pin-'));
}
function statePath(xdg) { return path.join(xdg, 'pidge', 'state.json'); }
function readPin(xdg) {
  try { return JSON.parse(fs.readFileSync(statePath(xdg), 'utf8')).e2ePins[PIN_KEY]; } catch { return undefined; }
}
function writePin(xdg, kf) {
  fs.mkdirSync(path.join(xdg, 'pidge'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(statePath(xdg), JSON.stringify({ e2ePins: { [PIN_KEY]: { v: 1, kf, at: '2026-07-04T00:00:00Z' } } }));
}

function runCli(args, port, env = {}) {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      PIDGE_URL: `http://127.0.0.1:${port}`,
      PIDGE_TOKEN: 'hld_test',
      PIDGE_SECRET: '',
      PIDGE_E2E: '',
      ...env,
    },
  });
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('a CONFIRMED sealed send stamps the local pin (state.json e2ePinned)', async () => {
  const xdg = freshXdg();
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;

  const { code, stderr } = await runCli(['message', '--title', 'x'], port,
    { PIDGE_SECRET: SECRET, XDG_CONFIG_HOME: xdg });
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const pin = readPin(xdg);
  assert.ok(pin && pin.v === 1, 'the sealed send must latch the pin');
  assert.equal(pin.kf, FIXTURE.kf, 'the pin records the sealing key fingerprint');
  assert.match(stderr, /PINNED as E2E/, 'the latch announces itself once');
});

test('pinned + server says NOT e2e ⇒ exit 2 and NOTHING leaves the machine', async () => {
  const xdg = freshXdg();
  writePin(xdg, FIXTURE.kf);
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = false; // the downgrade lie (#313)

  const { code, stderr } = await runCli(['message', '--title', 'secret plan'], port,
    { PIDGE_SECRET: SECRET, XDG_CONFIG_HOME: xdg });
  await mock.stop();

  assert.equal(code, 2, `must refuse with exit 2; stderr: ${stderr}`);
  assert.equal(mock.state.notifies.length, 0, 'no clear payload may reach the wire');
  assert.match(stderr, /REFUSING to send CLEAR/);
  assert.match(stderr, /PIDGE_E2E=off/, 'must teach the LOCAL unpin path');
});

test('pinned + whoami unreachable ⇒ exit 2 (a dead server cannot downgrade)', async () => {
  const xdg = freshXdg();
  writePin(xdg, FIXTURE.kf);
  const mock = createMock();
  const port = await mock.start();
  await mock.stop(); // port is now closed — whoami will fail

  const { code, stderr } = await runCli(['message', '--title', 'x'], port,
    { PIDGE_SECRET: SECRET, XDG_CONFIG_HOME: xdg });

  assert.equal(code, 2, `stderr: ${stderr}`);
  assert.match(stderr, /REFUSING to send CLEAR/);
});

test('pinned + the secret vanished ⇒ exit 2 (a lost key must be loud, not a silent clear send)', async () => {
  const xdg = freshXdg();
  writePin(xdg, FIXTURE.kf);
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;

  const { code, stderr } = await runCli(['message', '--title', 'x'], port,
    { XDG_CONFIG_HOME: xdg }); // no PIDGE_SECRET
  await mock.stop();

  assert.equal(code, 2, `stderr: ${stderr}`);
  assert.equal(mock.state.notifies.length, 0);
  assert.match(stderr, /REFUSING to send CLEAR/);
});

test('PIDGE_E2E=off is the explicit LOCAL unpin — the clear send of always works again', async () => {
  const xdg = freshXdg();
  writePin(xdg, FIXTURE.kf);
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = false; // genuine toggle-off, confirmed by the human

  const { code, stderr } = await runCli(['message', '--title', 'plain again'], port,
    { PIDGE_SECRET: SECRET, XDG_CONFIG_HOME: xdg, PIDGE_E2E: 'off' });
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const sent = mock.state.notifies[0];
  assert.equal(sent.enc, undefined, 'an unpinned clear send carries no enc');
  assert.equal(sent.title, 'plain again');
});

test('unpinned machines keep the old contract: server-off ⇒ clear send, no refusal', async () => {
  const xdg = freshXdg();
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = false;

  const { code } = await runCli(['message', '--title', 'orphan secret'], port,
    { PIDGE_SECRET: SECRET, XDG_CONFIG_HOME: xdg });
  await mock.stop();

  assert.equal(code, 0);
  assert.equal(mock.state.notifies[0].title, 'orphan secret');
  assert.equal(readPin(xdg), undefined, 'a clear send never latches the pin');
});
