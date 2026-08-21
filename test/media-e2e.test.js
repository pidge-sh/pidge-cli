'use strict';
// Sealed media, both directions, against the mock server.
//   send: gate CLOSED ⇒ clear media of always; gate OPEN ⇒ blob sealed BEFORE
//         upload (generic blob.bin), filename an envelope, media_enc:"v1";
//         media pin refuses a downgrade PRE-upload; URL --image refused sealed.
//   receive: a sealed attachment is downloaded + unsealed to a local path with
//         a SANITIZED name; failures are precise and never write ciphertext.
// The pure AAD-separation gate (cross-slot/cross-direction replay must fail
// the tag) is here too — it's a core property of the wire contract.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: rawSpawn } = require('node:child_process');
const { track } = require('./spawn-tracker');
// Own process group per child + group-kill when the file's tests end — a
// straggler (grand)child must never hold this process's event loop open.
const spawn = (cmd, args, opts = {}) => track(rawSpawn(cmd, args, { ...opts, detached: true }));
const { createMock } = require('./mock-server');

const CLI = path.join(__dirname, '..', 'bin', 'pidge.js');
const e2e = require(CLI);

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'e2e_vectors.json'), 'utf8'));
const KEY = Buffer.from(FIXTURE.key_b64url, 'base64url');
const SECRET = FIXTURE.key_b64url;

const CHANNEL_ID = 1;
const aad = (cid, field) => e2e.e2eAad(CHANNEL_ID, cid, field);

function runCli(args, port, env = {}, xdg = null) {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      PIDGE_URL: `http://127.0.0.1:${port}`,
      PIDGE_TOKEN: 'hld_test',
      PIDGE_SECRET: '',
      XDG_CONFIG_HOME: xdg || fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-test-')),
      // Isolate HOME so the skill self-heal never touches the real ~/.claude.
      HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-home-')),
      ...env,
    },
  });
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function tmpFile(name, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-media-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

// --- pure: the AAD registry — direction+slot separation ----------------------

test('blob AAD: a sealed blob opens ONLY in the exact slot it was sealed for', () => {
  const plain = Buffer.from('the-photo-bytes');
  const sealed = e2e.e2eEncryptBlob(KEY, aad('cid-1', 'image_blob'), plain);
  // the right slot opens…
  assert.deepEqual(e2e.e2eDecryptBlob(KEY, aad('cid-1', 'image_blob'), sealed), plain);
  // …every replay class fails the tag:
  for (const [why, badAad] of [
    ['image↔file swap', aad('cid-1', 'file_blob')],
    ['cross-direction (late-reply reuses the cid)', aad('cid-1', 'message_blob')],
    ['cross-notification', aad('cid-2', 'image_blob')],
    ['cross-channel', e2e.e2eAad(2, 'cid-1', 'image_blob')],
  ]) {
    assert.throws(() => e2e.e2eDecryptBlob(KEY, badAad, sealed), /failed to authenticate/, why);
  }
});

test('filename AAD: notification "filename" and message "message_filename" never swap', () => {
  const env1 = e2e.e2eEncryptField(KEY, aad('cid-9', 'filename'), 'relatorio.xlsx');
  assert.equal(e2e.e2eDecryptField(KEY, aad('cid-9', 'filename'), env1), 'relatorio.xlsx');
  assert.throws(() => e2e.e2eDecryptField(KEY, aad('cid-9', 'message_filename'), env1), /failed to authenticate/);
});

// --- pure: the gate decision + filename hygiene -------------------------------

test('e2eMediaSealDecision: ready drives it, overrides win, no context = never', () => {
  const d = e2e.e2eMediaSealDecision;
  assert.equal(d({ sealingActive: true, ready: true, override: null }), true);
  assert.equal(d({ sealingActive: true, ready: false, override: null }), false, 'gate closed = clear');
  assert.equal(d({ sealingActive: true, ready: false, override: 'on' }), true, 'PIDGE_E2E_MEDIA=on forces');
  assert.equal(d({ sealingActive: true, ready: true, override: 'off' }), false, 'PIDGE_E2E_MEDIA=off wins');
  assert.equal(d({ sealingActive: false, ready: true, override: null }), false, 'no sealing context = never');
  assert.equal(d({ sealingActive: false, ready: true, override: 'on' }), false, 'force-on still needs the secret+E2E');
});

test('sanitizeAttachmentName: traversal, separators, dot-leading, garbage', () => {
  const s = e2e.sanitizeAttachmentName;
  assert.equal(s('foto.png'), 'foto.png');
  assert.equal(s('../../etc/passwd'), 'passwd');
  assert.equal(s('a/b/c.txt'), 'c.txt');
  assert.equal(s('C:\\evil\\x.exe'), 'x.exe');
  assert.equal(s('.hidden'), 'hidden');
  assert.equal(s('..'), null);
  assert.equal(s(''), null);
  assert.equal(s(null), null);
  assert.equal(s('a'.repeat(300)).length, 255);
});

// --- SEND: the deploy gate ----------------------------------------------------

test('gate CLOSED (e2e on, media not ready): media rides CLEAR with the real filename; no media_enc', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  mock.state.e2eMediaReady = false;

  const file = tmpFile('relatorio.xlsx', Buffer.from('plain-file-bytes'));
  const { code, stderr } = await runCli(['message', '--title', 'doc', '--file', file], port, { PIDGE_SECRET: SECRET });
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const up = mock.state.uploads[0];
  assert.equal(up.filename, 'relatorio.xlsx', 'clear media keeps the real multipart name');
  assert.deepEqual(up.fileBytes, Buffer.from('plain-file-bytes'), 'clear media uploads plaintext (the path of always)');
  const sent = mock.state.notifies[0];
  assert.equal(sent.media_enc, undefined, 'no media_enc while the gate is closed');
  assert.equal(sent.filename, undefined);
  assert.match(stderr, /media BYTES and filename ride CLEAR/, 'the closed gate is narrated');
});

test('gate OPEN: blob sealed BEFORE upload (generic blob.bin), filename an envelope, media_enc:"v1" — full round-trip', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  mock.state.e2eMediaReady = true;

  const plain = Buffer.from('the-secret-spreadsheet-bytes');
  const file = tmpFile('relatorio.xlsx', plain);
  const { code, stderr } = await runCli(['message', '--title', 'doc', '--file', file], port, { PIDGE_SECRET: SECRET });
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const up = mock.state.uploads[0];
  assert.equal(up.filename, 'blob.bin', 'a sealed upload NEVER carries the real name');
  assert.equal(up.fileBytes[0], 0x01, 'the uploaded bytes wear the sealed framing');
  assert.ok(!up.fileBytes.includes(plain), 'plaintext must not leave the machine');

  const sent = mock.state.notifies[0];
  assert.equal(sent.media_enc, 'v1');
  assert.equal(sent.enc, 'v1');
  assert.ok(sent.correlation_id, 'cid minted client-side BEFORE sealing');
  // the uploaded blob opens with the file_blob AAD anchored on the SENT cid…
  assert.deepEqual(e2e.e2eDecryptBlob(KEY, aad(sent.correlation_id, 'file_blob'), up.fileBytes), plain);
  // …and the real filename rides as a "filename" envelope on the notify.
  assert.equal(e2e.e2eDecryptField(KEY, aad(sent.correlation_id, 'filename'), sent.filename), 'relatorio.xlsx');
  assert.match(stderr, /media bytes \+ filename sealed/);
});

test('gate OPEN + --image local: sealed with the image_blob AAD (slot-distinct from file_blob)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  mock.state.e2eMediaReady = true;

  const plain = Buffer.from('png-bytes-here');
  const img = tmpFile('chart.png', plain);
  const { code, stderr } = await runCli(['message', '--title', 'img', '--image', img], port, { PIDGE_SECRET: SECRET });
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const sent = mock.state.notifies[0];
  assert.equal(sent.media_enc, 'v1');
  assert.equal(sent.filename, undefined, 'an image has no filename to seal');
  assert.deepEqual(e2e.e2eDecryptBlob(KEY, aad(sent.correlation_id, 'image_blob'), mock.state.uploads[0].fileBytes), plain);
});

test('gate OPEN + a URL --image: REFUSED exit 2 BEFORE any upload (a mixed media_enc send would break the phone)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  mock.state.e2eMediaReady = true;

  const { code, stderr } = await runCli(
    ['message', '--title', 'img', '--image', 'https://example.com/chart.png'],
    port, { PIDGE_SECRET: SECRET });
  await mock.stop();

  assert.equal(code, 2, `stderr: ${stderr}`);
  assert.match(stderr, /cannot ride a SEALED-media send/);
  assert.equal(mock.state.uploads.length, 0);
  assert.equal(mock.state.notifies.length, 0);
});

test('PIDGE_E2E_MEDIA=on forces sealing even with the gate closed (pre-iOS testing)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  mock.state.e2eMediaReady = false;

  const file = tmpFile('x.bin', Buffer.from('forced'));
  const { code, stderr } = await runCli(['message', '--title', 'f', '--file', file], port,
    { PIDGE_SECRET: SECRET, PIDGE_E2E_MEDIA: 'on' });
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.equal(mock.state.notifies[0].media_enc, 'v1');
  assert.equal(mock.state.uploads[0].filename, 'blob.bin');
});

// --- SEND: the media pin (the anti-downgrade latch, extended) -------------------

test('media pin: a confirmed sealed-media send LATCHES; a later "gate closed" server answer is refused PRE-upload; PIDGE_E2E_MEDIA=off unpins', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  mock.state.e2eMediaReady = true;
  // ONE config dir across the three runs — the pin lives in its state.json.
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-pin-'));

  // 1. sealed-media send → latches the media pin.
  const file = tmpFile('a.bin', Buffer.from('aaa'));
  let r = await runCli(['message', '--title', 'a', '--file', file], port, { PIDGE_SECRET: SECRET }, xdg);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /PINNED as SEALED-MEDIA/);

  // 2. the server now claims the gate closed — the pinned channel REFUSES, before upload.
  mock.state.e2eMediaReady = false;
  const uploadsBefore = mock.state.uploads.length;
  r = await runCli(['message', '--title', 'b', '--file', file], port, { PIDGE_SECRET: SECRET }, xdg);
  assert.equal(r.code, 2, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /REFUSING to send CLEAR MEDIA/);
  assert.equal(mock.state.uploads.length, uploadsBefore, 'the refusal fires BEFORE any bytes upload');

  // 3. the human's local unpin lets the clear-media send through (text still seals).
  r = await runCli(['message', '--title', 'c', '--file', file], port,
    { PIDGE_SECRET: SECRET, PIDGE_E2E_MEDIA: 'off' }, xdg);
  await mock.stop();
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  const sent = mock.state.notifies.at(-1);
  assert.equal(sent.media_enc, undefined, 'unpinned send goes clear-media');
  assert.equal(sent.enc, 'v1', 'the TEXT sealing is untouched by the media unpin');
});

// --- RECEIVE: inbound attachments ----------------------------------------------

function sealedAttachmentRow(mock, { id = 40, cid = 'cid-att-1', name = 'foto.png', bytes = Buffer.from('jpeg-bytes'), extra = {} } = {}) {
  mock.state.blobs.a1 = e2e.e2eEncryptBlob(KEY, aad(cid, 'message_blob'), bytes);
  return {
    id, channel_id: CHANNEL_ID, kind: 'message', created_at: 'x',
    body: '', enc: 'v1', kf: FIXTURE.kf, correlation_id: cid,
    attachment: {
      filename: e2e.e2eEncryptField(KEY, aad(cid, 'message_filename'), name),
      content_type: 'application/octet-stream', byte_size: mock.state.blobs.a1.length,
      url: '/blobs/a1', enc: 'v1',
      // clear metadata rides alongside the sealed blob (a length is not content)
      ...extra,
    },
  };
}

test('listen: a SEALED attachment is downloaded + unsealed to a local path; filename decrypted; empty body stays ""', async () => {
  const mock = createMock();
  const port = await mock.start();
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-dl-'));
  const plain = Buffer.from('jpeg-bytes-of-the-photo');
  mock.state.messages = [sealedAttachmentRow(mock, { bytes: plain })];

  const { code, stdout, stderr } = await runCli(
    ['listen', '--no-realtime', '--timeout', '20', '--interval', '1'],
    port, { PIDGE_SECRET: SECRET }, xdg);
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const row = JSON.parse(stdout)[0];
  assert.equal(row.body, '', 'an attachment-only message keeps its empty body');
  assert.equal(row.attachment.filename, 'foto.png', 'the real name, decrypted');
  assert.ok(row.attachment.path, 'the plaintext file path rides the JSON');
  assert.ok(row.attachment.path.includes(`${path.sep}40${path.sep}`), 'namespaced by message id');
  assert.deepEqual(fs.readFileSync(row.attachment.path), plain, 'the file on disk is the PLAINTEXT');
  assert.equal(row.attachment.enc, undefined, 'opened = no enc flag left');
  assert.equal(row.e2e, 'decrypted');
});

test('listen: a traversal filename in a sealed attachment is SANITIZED before touching disk', async () => {
  const mock = createMock();
  const port = await mock.start();
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-trav-'));
  mock.state.messages = [sealedAttachmentRow(mock, { name: '../../../evil.sh' })];

  const { code, stdout, stderr } = await runCli(
    ['listen', '--no-realtime', '--timeout', '20', '--interval', '1'],
    port, { PIDGE_SECRET: SECRET }, xdg);
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const row = JSON.parse(stdout)[0];
  assert.equal(path.basename(row.attachment.path), 'evil.sh');
  assert.ok(row.attachment.path.startsWith(path.join(xdg, 'pidge', 'downloads')),
    `must stay INSIDE the downloads dir, got ${row.attachment.path}`);
});

test('listen: kf mismatch on a sealed attachment ⇒ precise e2e_error, NOTHING written to disk', async () => {
  const mock = createMock();
  const port = await mock.start();
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-kf-'));
  const row = sealedAttachmentRow(mock);
  row.kf = FIXTURE.wrong_key_kf; // sealed with another key
  mock.state.messages = [row];

  const { code, stdout, stderr } = await runCli(
    ['listen', '--no-realtime', '--timeout', '20', '--interval', '1'],
    port, { PIDGE_SECRET: SECRET }, xdg);
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const out = JSON.parse(stdout)[0];
  assert.match(out.e2e_error, /ANOTHER key/);
  assert.equal(out.attachment.path, undefined);
  assert.ok(!fs.existsSync(path.join(xdg, 'pidge', 'downloads')), 'no downloads dir, no file');
});

test('listen: a CLEAR attachment passes through with its url; --download saves it too', async () => {
  const mock = createMock();
  const port = await mock.start();
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-clear-'));
  const plain = Buffer.from('clear-csv-bytes');
  mock.state.blobs.c1 = plain;
  const row = {
    id: 41, channel_id: CHANNEL_ID, kind: 'message', created_at: 'x', body: 'segue o csv',
    attachment: { filename: 'dados.csv', content_type: 'text/csv', byte_size: plain.length, url: '/blobs/c1' },
  };
  mock.state.messages = [row];

  // without --download: url passthrough only.
  let r = await runCli(['listen', '--no-realtime', '--timeout', '20', '--interval', '1'], port, {}, xdg);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  let out = JSON.parse(r.stdout)[0];
  assert.equal(out.attachment.filename, 'dados.csv');
  assert.equal(out.attachment.path, undefined, 'clear = no auto-download');

  // with --download: saved + path in the JSON.
  mock.state.messages = [row]; // the ack cleared the queue — re-arm
  r = await runCli(['listen', '--no-realtime', '--timeout', '20', '--interval', '1', '--download'], port, {}, xdg);
  await mock.stop();
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  out = JSON.parse(r.stdout)[0];
  assert.ok(out.attachment.path);
  assert.deepEqual(fs.readFileSync(out.attachment.path), plain);
});

// --- Voice notes: a sealed one is only recognizable AFTER the filename opens -----

test('listen: a SEALED voice note is named `voice` once its filename decrypts (generic content_type)', async () => {
  // On the wire this row is application/octet-stream + an envelope for a name:
  // nothing says "audio". The `.m4a` becomes legible exactly one step after
  // message_filename opens — which is why detection lives in the render.
  const mock = createMock();
  const port = await mock.start();
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-vsealed-'));
  const plain = Buffer.from('the-m4a-bytes');
  mock.state.messages = [sealedAttachmentRow(mock, {
    id: 45, name: 'nota-de-voz.m4a', bytes: plain, extra: { duration_seconds: 95 },
  })];

  const { code, stdout, stderr } = await runCli(
    ['listen', '--no-realtime', '--timeout', '20', '--interval', '1'],
    port, { PIDGE_SECRET: SECRET }, xdg);
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const att = JSON.parse(stdout)[0].attachment;
  assert.equal(att.filename, 'nota-de-voz.m4a', 'the real name, decrypted');
  assert.equal(att.kind, 'voice', 'recognized by extension — the content_type never said audio');
  assert.equal(att.duration_seconds, 95);
  assert.match(att.hint, /does not transcribe/);
  assert.deepEqual(fs.readFileSync(att.path), plain, 'the file on disk is the PLAINTEXT audio');
  assert.match(stderr, /🎤 voice note, 1:35 — saved to /);
  assert.equal(stderr.match(/does not transcribe/g).length, 1, 'the hint is ONE line');
});

test('catchup --no-download: a sealed voice note is still NAMED, and says the bytes stayed put', async () => {
  const mock = createMock();
  const port = await mock.start();
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-vnodl-'));
  mock.state.messages = [sealedAttachmentRow(mock, {
    id: 46, name: 'recado.m4a', extra: { duration_seconds: 7 },
  })];

  const { code, stdout, stderr } = await runCli(
    ['catchup', '--no-download'], port, { PIDGE_SECRET: SECRET }, xdg);
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const att = JSON.parse(stdout).messages[0].attachment;
  assert.equal(att.kind, 'voice', 'the name opens off the row — no network needed to know it is audio');
  assert.equal(att.sealed, true);
  assert.equal(att.duration_seconds, 7);
  assert.equal(att.path, undefined, 'no bytes were fetched');
  assert.match(stderr, /🎤 voice note, 0:07 — sealed, bytes NOT downloaded/);
});

test('listen: a sealed PHOTO is not a voice note (the regression that keeps the two apart)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-vphoto-'));
  mock.state.messages = [sealedAttachmentRow(mock, { id: 47, name: 'foto.png' })];

  const { code, stdout, stderr } = await runCli(
    ['listen', '--no-realtime', '--timeout', '20', '--interval', '1'],
    port, { PIDGE_SECRET: SECRET }, xdg);
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const att = JSON.parse(stdout)[0].attachment;
  assert.equal(att.kind, undefined);
  assert.equal(att.hint, undefined);
  assert.ok(!/🎤/.test(stderr));
});

// --- Regressions: hostile-server hardening ---------------------------------------

test('listen: a traversal MESSAGE ID (server-chosen) cannot steer the plaintext outside the downloads dir', async () => {
  // Regression: destFor interpolated String(m.id) raw — a hostile server
  // could ship "../.." to write the decrypted plaintext anywhere. The id
  // segment is sanitized like any wire string now.
  const mock = createMock();
  const port = await mock.start();
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-idtrav-'));
  mock.state.messages = [sealedAttachmentRow(mock, { id: '../../../../../../tmp/pidge-pwned-marker' })];

  const { code, stdout, stderr } = await runCli(
    ['listen', '--no-realtime', '--timeout', '20', '--interval', '1'],
    port, { PIDGE_SECRET: SECRET }, xdg);
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const row = JSON.parse(stdout)[0];
  const downloads = path.join(xdg, 'pidge', 'downloads');
  assert.ok(row.attachment.path.startsWith(downloads + path.sep),
    `plaintext must stay INSIDE ${downloads}, got ${row.attachment.path}`);
  assert.ok(!fs.existsSync('/tmp/pidge-pwned-marker'), 'the traversal target must NOT be created');
});

test('media pin: a re-key (new kf, same token) PRESERVES the media latch — a text send cannot silently re-open the downgrade lever', async () => {
  // Regression: e2eStampPin rewrote the pin WITHOUT spreading cur, dropping
  // media:true. A secret rotation (new kf, same token) + one text send wiped the
  // media latch and re-armed the server-driven media-downgrade lever.
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  mock.state.e2eMediaReady = true;
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-rekey-'));

  // a SECOND valid secret: same 32-byte shape, one byte flipped ⇒ a different kf.
  const key2 = Buffer.from(KEY); key2[key2.length - 1] ^= 0xff;
  const SECRET2 = key2.toString('base64url');

  const file = tmpFile('a.bin', Buffer.from('aaa'));
  // 1. sealed-media send with key #1 → latches the media pin.
  let r = await runCli(['message', '--title', 'a', '--file', file], port, { PIDGE_SECRET: SECRET }, xdg);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /PINNED as SEALED-MEDIA/);

  // 2. a re-key: a TEXT-only send with key #2 (new kf, same token) rewrites the
  //    E2E pin. It must NOT drop media:true.
  r = await runCli(['message', '--title', 'just text'], port, { PIDGE_SECRET: SECRET2 }, xdg);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);

  // 3. server now claims the media gate closed — the latch must STILL refuse.
  mock.state.e2eMediaReady = false;
  const uploadsBefore = mock.state.uploads.length;
  r = await runCli(['message', '--title', 'c', '--file', file], port, { PIDGE_SECRET: SECRET2 }, xdg);
  await mock.stop();
  assert.equal(r.code, 2, `the media latch must survive the re-key; stderr: ${r.stderr}`);
  assert.match(r.stderr, /REFUSING to send CLEAR MEDIA/);
  assert.equal(mock.state.uploads.length, uploadsBefore, 'refused before upload');
});

// --- catchup must not re-download/unseal attachments every session -------

test('catchup --digest does NOT fetch or unseal a sealed attachment', async () => {
  const mock = createMock();
  const port = await mock.start();
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-c74d-'));
  mock.state.messages = [sealedAttachmentRow(mock, { id: 40, cid: 'cid-att-1', name: 'report.pdf' })];

  const { code, stdout, stderr } = await runCli(['catchup', '--digest'], port, { PIDGE_SECRET: SECRET }, xdg);
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const blobHits = mock.state.reqLog.filter((r) => r.pathname === '/blobs/a1');
  assert.equal(blobHits.length, 0, '--digest implies --no-download: the blob is never fetched');
  const downloads = path.join(xdg, 'pidge', 'downloads');
  assert.ok(!fs.existsSync(downloads) || fs.readdirSync(downloads).length === 0, 'nothing written to disk');
  assert.match(stdout, /^40 · /m, 'the message still appears in the digest');
});

test('catchup --no-download skips attachment bytes even without --digest', async () => {
  const mock = createMock();
  const port = await mock.start();
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-c74n-'));
  mock.state.messages = [sealedAttachmentRow(mock, { id: 42, cid: 'cid-att-1', name: 'r.pdf' })];

  const { code, stdout, stderr } = await runCli(['catchup', '--no-download'], port, { PIDGE_SECRET: SECRET }, xdg);
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.equal(mock.state.reqLog.filter((r) => r.pathname === '/blobs/a1').length, 0, 'no blob fetch under --no-download');
  const row = JSON.parse(stdout).messages.find((m) => m.id === 42);
  assert.equal(row.attachment.sealed, true, 'the attachment is marked sealed (not-downloaded)');
  assert.equal(row.attachment.path, undefined, 'no local path — the bytes were not fetched');
  assert.equal(row.attachment.filename, 'r.pdf', 'the filename still opens (it rides the row, no network)');
});

test('catchup (full) reuses an attachment already on disk instead of re-downloading', async () => {
  const mock = createMock();
  const port = await mock.start();
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-c74s-'));
  const plain = Buffer.from('the-real-pdf-bytes');
  mock.state.messages = [sealedAttachmentRow(mock, { id: 41, cid: 'cid-att-1', name: 'r.pdf', bytes: plain })];
  // Pre-place the decrypted copy where the CLI would have written it.
  const dest = path.join(xdg, 'pidge', 'downloads', '41', 'r.pdf');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, plain);

  const { code, stdout, stderr } = await runCli(['catchup'], port, { PIDGE_SECRET: SECRET }, xdg);
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.equal(mock.state.reqLog.filter((r) => r.pathname === '/blobs/a1').length, 0, 'the cached copy is reused; no re-download');
  const row = JSON.parse(stdout).messages.find((m) => m.id === 41);
  assert.equal(row.attachment.path, dest, 'the JSON points at the cached file');
  assert.equal(row.attachment.enc, undefined, 'the row reads as opened');
});

// --- sent_note is CLEAR metadata even on an E2E channel -----------

test('sent_note rides CLEAR on an E2E channel (D6 honesty — content sealed, note is not)', async () => {
  const mock = createMock();
  const port = await mock.start();
  mock.state.e2eEnabled = true;
  const { code, stderr } = await runCli(
    ['important', '--title', 'secret thing', '--note', 'armed by nightly'],
    port, { PIDGE_SECRET: SECRET });
  await mock.stop();
  assert.equal(code, 0, `stderr: ${stderr}`);
  const sent = mock.state.notifies[0];
  assert.equal(sent.enc, 'v1', 'the content IS sealed on this E2E channel');
  assert.match(String(sent.title), /^v\d+:/, 'the title rode as ciphertext');
  assert.equal(sent.sent_note, 'armed by nightly', 'sent_note stays CLEAR (never sealed) — it is server-read attribution');
});

test('a 0-byte file at the cache path is NOT trusted — catchup re-downloads', async () => {
  const mock = createMock();
  const port = await mock.start();
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-c74z-'));
  const plain = Buffer.from('real-bytes');
  mock.state.messages = [sealedAttachmentRow(mock, { id: 43, cid: 'cid-att-1', name: 'r.pdf', bytes: plain })];
  // A truncated husk (crash mid-write on a pre-atomic build): 0 bytes at dest.
  const dest = path.join(xdg, 'pidge', 'downloads', '43', 'r.pdf');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.alloc(0));

  const { code, stdout, stderr } = await runCli(['catchup'], port, { PIDGE_SECRET: SECRET }, xdg);
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.equal(mock.state.reqLog.filter((r) => r.pathname === '/blobs/a1').length, 1, 'the husk is NOT cache — re-downloaded');
  const row = JSON.parse(stdout).messages.find((m) => m.id === 43);
  assert.equal(row.attachment.path, dest);
  assert.deepEqual(fs.readFileSync(dest), plain, 'the real plaintext replaced the 0-byte husk');
});

test('listen: an attachment url off this server is fetched only over https to a public host — other schemes, credentials and internal addresses are refused, nothing written', async () => {
  const mock = createMock();
  const port = await mock.start();
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-att-url-'));
  mock.state.messages = [
    sealedAttachmentRow(mock, { id: 61, cid: 'cid-u-1', extra: { url: 'http://169.254.169.254/latest/meta-data/' } }),
    sealedAttachmentRow(mock, { id: 62, cid: 'cid-u-2', extra: { url: 'https://10.0.0.7/blobs/a1' } }),
    sealedAttachmentRow(mock, { id: 63, cid: 'cid-u-3', extra: { url: 'file:///etc/passwd' } }),
    sealedAttachmentRow(mock, { id: 64, cid: 'cid-u-4', extra: { url: 'https://user:pw@cdn.example/blobs/a1' } }),
  ];

  const { code, stdout, stderr } = await runCli(
    ['listen', '--no-realtime', '--timeout', '20', '--interval', '1'],
    port, { PIDGE_SECRET: SECRET }, xdg);
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const out = JSON.parse(stdout);
  assert.equal(out.length, 4);
  for (const o of out) {
    assert.match(o.e2e_error, /attachment url/, `row ${o.id}: ${o.e2e_error}`);
    assert.equal(o.attachment.path, undefined);
  }
  assert.ok(!fs.existsSync(path.join(xdg, 'pidge', 'downloads')), 'no downloads dir, no file');
});
