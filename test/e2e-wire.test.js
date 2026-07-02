'use strict';
// E2-CLI (#43): the E2E v1 SEND/RECEIVE wiring, end-to-end against the mock
// server. Contract: e2e-spec-v1.md + manifest v49 (notifications) / v51
// (sealed /messages). The pure-crypto gate (fixture round-trips + the shared
// failure cases) lives in test/e2e.test.js — this file proves the WIRE:
//   send: secret + E2E channel ⇒ envelopes + enc/kf + a client-minted cid;
//         no secret / non-E2E channel / invalid secret ⇒ the clear send of always
//   receive: listen/wait gate on the explicit enc flag, decrypt with the right
//         AAD, and NEVER print base64 — a kf mismatch / missing cid / unknown
//         version is a PRECISE error.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createMock } = require('./mock-server');

const CLI = path.join(__dirname, '..', 'bin', 'pidge.js');
const e2e = require(CLI); // the test seam: pure helpers, no CLI machinery

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'e2e_vectors.json'), 'utf8'));
const KEY = Buffer.from(FIXTURE.key_b64url, 'base64url');
const SECRET = FIXTURE.key_b64url;
const WRONG_KF = FIXTURE.wrong_key_kf;

// The mock's whoami channel id — every AAD in this file binds to it.
const CHANNEL_ID = 1;
const aad = (cid, field) => e2e.e2eAad(CHANNEL_ID, cid, field);
const seal = (cid, field, plaintext) => e2e.e2eEncryptField(KEY, aad(cid, field), plaintext);

function runCli(args, port, env = {}, cwd = undefined) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd,
    env: {
      ...process.env,
      PIDGE_URL: `http://127.0.0.1:${port}`,
      PIDGE_TOKEN: 'hld_test',
      PIDGE_SECRET: '', // explicit: no ambient secret leaks into a test
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

// --- SEND ------------------------------------------------------------------

test('E2E send: secret + E2E channel ⇒ content fields + custom labels sealed, enc/kf/cid on the wire, action IDs clear', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;

  const { result } = runCli(['message',
    '--title', 'Deploy green',
    '--body', '2m12s, zero errors',
    '--subtitle', 'ci',
    '--body-markdown', '# all good',
    '--custom-action', 'ship_it:Ship it now',
  ], port, { PIDGE_SECRET: SECRET });
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const sent = mock.state.notifies[0];
  assert.equal(sent.enc, 'v1');
  assert.equal(sent.kf, FIXTURE.kf);
  assert.ok(sent.correlation_id, 'the cid must be minted CLIENT-side (the AAD needs it)');
  const cid = sent.correlation_id;
  // Every content field left the machine as an envelope that opens with ITS AAD…
  for (const [field, plain] of [['title', 'Deploy green'], ['body', '2m12s, zero errors'],
    ['subtitle', 'ci'], ['body_markdown', '# all good']]) {
    assert.match(sent[field], /^v1:/, `${field} must be sealed`);
    assert.equal(e2e.e2eDecryptField(KEY, aad(cid, field), sent[field]), plain, `${field} round-trip`);
  }
  // …the custom-action LABEL too (field action_label_<id>), while the ID stays clear.
  assert.equal(sent.custom_actions[0].id, 'ship_it', 'action IDs ride CLEAR (the action contract runs on ids)');
  assert.equal(e2e.e2eDecryptField(KEY, aad(cid, 'action_label_ship_it'), sent.custom_actions[0].label), 'Ship it now');
  assert.match(stderr, /E2E — content sealed \(kf /);
  // trust-the-echo: stdout shows OUR OWN envelopes decrypted for display.
  assert.match(stdout, /Deploy green/);
  assert.ok(!stdout.includes('v1:'), `no envelope may reach stdout:\n${stdout}`);
});

test('E2E send: a builtin/system action id NEVER gets its label sealed (#313 — never-seal = server RESERVED_ACTION_IDS)', async () => {
  // The list must match the server's Notification::RESERVED_ACTION_IDS (the 12
  // built-ins + "dismiss" + "acknowledge", manifest v52) — the iOS builtin set
  // skips label decrypt for these ids, so a sealed label on one would render
  // raw "v1:…" on the button.
  assert.deepStrictEqual([...e2e.E2E_NEVER_SEAL_LABEL_IDS].sort(), [
    'snooze', 'done', 'reschedule', 'mute', 'reply',
    'yes', 'no', 'approve', 'reject', 'accept', 'decline', 'later',
    'dismiss', 'acknowledge',
  ].sort());

  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;

  const { result } = runCli(['message',
    '--title', 'Escolha',
    '--custom-action', 'acknowledge:Confirmar',
    '--custom-action', 'ship_it:Ship it now',
  ], port, { PIDGE_SECRET: SECRET });
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const sent = mock.state.notifies[0];
  const cid = sent.correlation_id;
  assert.match(sent.title, /^v1:/, 'content fields still seal');
  // The builtin/system-id label rides CLEAR (a client would skip its decrypt)…
  const ack = sent.custom_actions.find((c) => c.id === 'acknowledge');
  assert.equal(ack.label, 'Confirmar', 'a builtin/system id label must NOT be sealed');
  // …while a genuinely custom label seals exactly as before.
  const ship = sent.custom_actions.find((c) => c.id === 'ship_it');
  assert.equal(e2e.e2eDecryptField(KEY, aad(cid, 'action_label_ship_it'), ship.label), 'Ship it now');
});

test('E2E send: NO secret on an E2E channel ⇒ the clear send of always (never blocked)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;

  const { result } = runCli(['message', '--title', 'sem segredo'], port);
  const { code } = await result;
  await mock.stop();

  assert.equal(code, 0);
  const sent = mock.state.notifies[0];
  assert.equal(sent.enc, undefined);
  assert.equal(sent.kf, undefined);
  assert.equal(sent.title, 'sem segredo');
});

test('E2E send: secret present but the channel is NOT E2E ⇒ orphan secret, clear send (doctor is where it warns)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = false;

  const { result } = runCli(['message', '--title', 'canal claro'], port, { PIDGE_SECRET: SECRET });
  const { code } = await result;
  await mock.stop();

  assert.equal(code, 0);
  assert.equal(mock.state.notifies[0].enc, undefined);
  assert.equal(mock.state.notifies[0].title, 'canal claro');
});

test('E2E send: an INVALID secret warns loud and degrades to a clear send (a broken config must not eat messages)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;

  const { result } = runCli(['message', '--title', 'segredo torto'], port, { PIDGE_SECRET: 'tooshort' });
  const { code, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stderr, /PIDGE_SECRET is INVALID/);
  assert.equal(mock.state.notifies[0].enc, undefined);
  assert.equal(mock.state.notifies[0].title, 'segredo torto');
});

// --- RECEIVE: listen (sealed /messages, E1.5) -------------------------------

test('listen decrypts a sealed kind=message row (field ALWAYS "message"); clear rows in the batch render as always', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [
    { id: 30, channel_id: CHANNEL_ID, kind: 'message', created_at: 'x',
      body: seal('cid-m1', 'message', 'segredo: aprova o deploy'),
      enc: 'v1', kf: FIXTURE.kf, correlation_id: 'cid-m1' },
    { id: 31, channel_id: CHANNEL_ID, kind: 'message', created_at: 'x',
      body: 'linha antiga em claro' }, // pre-E1.5 history — honest degradation
  ];

  const { result } = runCli(['listen', '--no-realtime', '--timeout', '20', '--interval', '1'],
    port, { PIDGE_SECRET: SECRET });
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const rows = JSON.parse(stdout);
  assert.equal(rows[0].body, 'segredo: aprova o deploy');
  assert.equal(rows[0].e2e, 'decrypted');
  assert.equal(rows[0].enc, undefined, 'plaintext must not still carry the enc flag');
  assert.equal(rows[1].body, 'linha antiga em claro');
  assert.equal(rows[1].e2e, undefined, 'a clear line rides untouched');
  assert.ok(!stdout.includes('v1:'), `no envelope may reach stdout:\n${stdout}`);
});

test('listen: kf mismatch ⇒ "sealed with ANOTHER key" PRECISELY, body blanked, never base64 (A1)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [
    { id: 32, channel_id: CHANNEL_ID, kind: 'message', created_at: 'x',
      body: seal('cid-m2', 'message', 'nunca lido'),
      enc: 'v1', kf: WRONG_KF, correlation_id: 'cid-m2' },
  ];

  const { result } = runCli(['listen', '--no-realtime', '--timeout', '20', '--interval', '1'],
    port, { PIDGE_SECRET: SECRET });
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const rows = JSON.parse(stdout);
  assert.equal(rows[0].body, null);
  assert.match(rows[0].e2e_error, /ANOTHER key/);
  assert.match(rows[0].e2e_error, new RegExp(WRONG_KF));
  assert.match(stderr, /sealed with ANOTHER key/);
  assert.ok(!stdout.includes('v1:'), `ciphertext leaked to stdout:\n${stdout}`);
});

test('listen: enc present but correlation_id MISSING ⇒ precise "server predates E1.5 / bug" error, not garbage', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [
    { id: 33, channel_id: CHANNEL_ID, kind: 'message', created_at: 'x',
      body: seal('cid-m3', 'message', 'sem âncora'), enc: 'v1', kf: FIXTURE.kf },
  ];

  const { result } = runCli(['listen', '--no-realtime', '--timeout', '20', '--interval', '1'],
    port, { PIDGE_SECRET: SECRET });
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const rows = JSON.parse(stdout);
  assert.equal(rows[0].body, null);
  assert.match(rows[0].e2e_error, /NO correlation_id/);
  assert.ok(!stdout.includes('v1:'));
});

test('listen: unknown envelope version + missing secret are each their own precise error', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [
    { id: 34, channel_id: CHANNEL_ID, kind: 'message', created_at: 'x',
      body: 'v2:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      enc: 'v2', kf: FIXTURE.kf, correlation_id: 'cid-m4' },
    { id: 35, channel_id: CHANNEL_ID, kind: 'message', created_at: 'x',
      body: seal('cid-m5', 'message', 'sem chave aqui'),
      enc: 'v1', kf: FIXTURE.kf, correlation_id: 'cid-m5' },
  ];

  const { result } = runCli(['listen', '--no-realtime', '--timeout', '20', '--interval', '1'], port);
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const rows = JSON.parse(stdout);
  assert.match(rows[0].e2e_error, /unknown envelope version "v2"/);
  assert.match(rows[1].e2e_error, /no \(valid\) PIDGE_SECRET/);
  assert.ok(!stdout.includes(':' + mock.state.messages[1].body), 'no ciphertext on stdout');
});

test('listen --all: a notification_reply with ref.enc decrypts text (field "reply"), ref.title (field "title") and a label-derived body', async () => {
  const mock = createMock();
  const port = await mock.start();
  const replyText = seal('cid-n1', 'reply', 'faz o rollback primeiro');
  const sealedTitle = seal('cid-n1', 'title', 'Deploy da API');
  const sealedLabel = seal('cid-n2', 'action_label_ship_it', 'Ship it now');
  mock.state.messages = [
    { id: 40, channel_id: CHANNEL_ID, kind: 'notification_reply', created_at: 'x',
      action_id: 'reply', text: replyText, body: replyText,
      ref: { correlation_id: 'cid-n1', title: sealedTitle, enc: 'v1', kf: FIXTURE.kf, event_kind: 'replied' } },
    // A custom-action tap with no text: the body mirrors the sealed LABEL.
    { id: 41, channel_id: CHANNEL_ID, kind: 'notification_reply', created_at: 'x',
      action_id: 'ship_it', body: sealedLabel,
      ref: { correlation_id: 'cid-n2', title: seal('cid-n2', 'title', 'PR 99'), enc: 'v1', kf: FIXTURE.kf, event_kind: 'acted' } },
  ];

  const { result } = runCli(['listen', '--all', '--no-realtime', '--timeout', '20', '--interval', '1'],
    port, { PIDGE_SECRET: SECRET });
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const rows = JSON.parse(stdout);
  assert.equal(rows[0].text, 'faz o rollback primeiro');
  assert.equal(rows[0].body, 'faz o rollback primeiro');
  assert.equal(rows[0].ref.title, 'Deploy da API');
  assert.equal(rows[0].e2e, 'decrypted');
  assert.equal(rows[1].body, 'Ship it now');
  assert.equal(rows[1].ref.title, 'PR 99');
  // The #131 narration reads the DECRYPTED values too.
  assert.match(stderr, /Deploy da API/);
  assert.match(stderr, /faz o rollback primeiro/);
  assert.ok(!stdout.includes('v1:'), `ciphertext leaked to stdout:\n${stdout}`);
});

test('listen --all: an envelope that cannot be ATTRIBUTED (no action_id) is blanked, never printed (A1 safety net)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.messages = [
    { id: 42, channel_id: CHANNEL_ID, kind: 'notification_reply', created_at: 'x',
      body: seal('cid-n3', 'action_label_mystery', 'rótulo perdido'), // no action_id on the row
      ref: { correlation_id: 'cid-n3', title: null, enc: 'v1', kf: FIXTURE.kf, event_kind: 'acted' } },
  ];

  const { result } = runCli(['listen', '--all', '--no-realtime', '--timeout', '20', '--interval', '1'],
    port, { PIDGE_SECRET: SECRET });
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const rows = JSON.parse(stdout);
  assert.equal(rows[0].body, null);
  assert.match(rows[0].e2e_error, /could not be attributed/);
  assert.ok(!stdout.includes('v1:'), `ciphertext leaked to stdout:\n${stdout}`);
});

// --- RECEIVE: wait/ask (the poll's chosen_action) ----------------------------

test('wait decrypts a sealed chosen_action: text (field "reply") opens, a BUILT-IN label passes through clear', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['cid-w1'] = {
    responded: true, correlation_id: 'cid-w1', enc: 'v1', kf: FIXTURE.kf,
    chosen_action: { kind: 'replied', action_id: 'reply', label: 'Responder',
      text: seal('cid-w1', 'reply', 'sim, manda ver') },
  };

  const { result } = runCli(['wait', 'cid-w1', '--no-realtime', '--timeout', '20', '--interval', '1'],
    port, { PIDGE_SECRET: SECRET });
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const chosen = JSON.parse(stdout);
  assert.equal(chosen.text, 'sim, manda ver');
  assert.equal(chosen.label, 'Responder', 'a built-in label is server-side clear — passthrough, never an error');
  assert.equal(chosen.e2e_error, undefined);
  assert.ok(!stdout.includes('v1:'));
});

test('wait decrypts a sealed CUSTOM action label (field action_label_<id>)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['cid-w2'] = {
    responded: true, correlation_id: 'cid-w2', enc: 'v1', kf: FIXTURE.kf,
    chosen_action: { kind: 'acted', action_id: 'ship_it',
      label: seal('cid-w2', 'action_label_ship_it', 'Ship it now'), text: null },
  };

  const { result } = runCli(['wait', 'cid-w2', '--no-realtime', '--timeout', '20', '--interval', '1'],
    port, { PIDGE_SECRET: SECRET });
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.equal(JSON.parse(stdout).label, 'Ship it now');
  assert.ok(!stdout.includes('v1:'));
});

test('wait: kf mismatch on a sealed answer ⇒ text BLANKED + precise e2e_error (action_id still usable)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.notifications['cid-w3'] = {
    responded: true, correlation_id: 'cid-w3', enc: 'v1', kf: WRONG_KF,
    chosen_action: { kind: 'replied', action_id: 'reply',
      text: seal('cid-w3', 'reply', 'ilegível') },
  };

  const { result } = runCli(['wait', 'cid-w3', '--no-realtime', '--timeout', '20', '--interval', '1'],
    port, { PIDGE_SECRET: SECRET });
  const { code, stdout, stderr } = await result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const chosen = JSON.parse(stdout);
  assert.equal(chosen.text, null);
  assert.match(chosen.e2e_error, /ANOTHER key/);
  assert.equal(chosen.action_id, 'reply', 'the clear action_id survives — the agent can still branch on it');
  assert.match(stderr, /sealed with ANOTHER key/);
  assert.ok(!stdout.includes('v1:'));
});

// --- doctor ------------------------------------------------------------------

test('doctor: valid secret + E2E channel ⇒ kf narrated, e2e ok in the JSON, exit 0', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;

  const { code, stdout, stderr } = await runCli(['doctor'], port, { PIDGE_SECRET: SECRET }).result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stderr, new RegExp(`e2e secret found \\(env var, 32 bytes, kf ${FIXTURE.kf}\\)`));
  assert.match(stderr, /e2e ON — sends are sealed/);
  const out = JSON.parse(stdout);
  assert.deepEqual(out.e2e, { channel: true, secret: 'ok', kf: FIXTURE.kf });
});

test('doctor: E2E channel but NO secret ⇒ instruct re-running the setup prompt (warning, exit 0 — clear sends still work)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;

  const { code, stdout, stderr } = await runCli(['doctor'], port).result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.match(stderr, /NO PIDGE_SECRET is configured/);
  assert.match(stderr, /re-run the setup prompt/);
  assert.deepEqual(JSON.parse(stdout).e2e, { channel: true, secret: 'absent', kf: null });
});

test('doctor: INVALID secret on an E2E channel is BROKEN (exit 2); orphan secret on a clear channel is a warning (exit 0)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  let out = await runCli(['doctor'], port, { PIDGE_SECRET: 'not!base64url' }).result;
  assert.equal(out.code, 2, `stderr: ${out.stderr}`);
  assert.match(out.stderr, /BROKEN — PIDGE_SECRET \(env var\) is INVALID/);

  mock.state.e2eEnabled = false;
  out = await runCli(['doctor'], port, { PIDGE_SECRET: SECRET }).result;
  await mock.stop();
  assert.equal(out.code, 0, `stderr: ${out.stderr}`);
  assert.match(out.stderr, /secret órfão/);
});

// --- setup: the {TOKEN, SECRET} pair travels together -------------------------

test('setup --claim persists PIDGE_SECRET from the env next to the token (one source for the pair)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-e2e-setup-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-e2e-cwd-'));

  const { code, stderr } = await runCli(['setup', '--claim', 'claim-ok'], port,
    { XDG_CONFIG_HOME: home, PIDGE_TOKEN: '', PIDGE_SECRET: SECRET }, cwd).result;
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const written = fs.readFileSync(path.join(home, 'pidge', 'env'), 'utf8');
  assert.match(written, /PIDGE_TOKEN=hld_minted_by_claim/);
  assert.match(written, new RegExp(`PIDGE_SECRET=${SECRET}`));
  assert.match(stderr, /pair travels together/);
});
