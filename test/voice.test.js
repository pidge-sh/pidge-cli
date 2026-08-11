'use strict';
// Voice notes served HONESTLY: the CLI names audio as audio, carries the
// sender-declared length, and says once per render that it does not transcribe.
// What it must never do is imply words it does not have — an agent handed an
// anonymous blob either ignores the human or narrates a transcript it invented.
//
// Covered here: the detection matrix (content type vs extension vs a filename
// that only becomes legible after unsealing — that last case lives in the
// sealed-media suite), the annotated JSON shape, the human line on stderr, and
// the regression that a NON-audio attachment is left exactly as it was.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: rawSpawn } = require('node:child_process');
const { track } = require('./spawn-tracker');
const spawn = (cmd, args, opts = {}) => track(rawSpawn(cmd, args, { ...opts, detached: true }));
const { createMock } = require('./mock-server');

const CLI = path.join(__dirname, '..', 'bin', 'pidge.js');
const pidge = require(CLI);

function runCli(args, port, env = {}, xdg = null) {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      PIDGE_URL: `http://127.0.0.1:${port}`,
      PIDGE_TOKEN: 'hld_test',
      PIDGE_SECRET: '',
      XDG_CONFIG_HOME: xdg || fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-voice-')),
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

// a collecting stand-in for console.error, so the pure tests read the human line
const collect = () => { const lines = []; const log = (l) => lines.push(l); log.lines = lines; return log; };

const voiceRow = (att, id = 1) => ({ id, kind: 'message', body: '', attachment: { ...att } });

// --- pure: detection ----------------------------------------------------------

test('isVoiceAttachment: content_type audio/* is enough, whatever the name', () => {
  const is = pidge.isVoiceAttachment;
  assert.equal(is({ content_type: 'audio/x-m4a', filename: 'nota' }), true, 'the type the app sends');
  assert.equal(is({ content_type: 'audio/mpeg', filename: 'sem-extensao' }), true);
  assert.equal(is({ content_type: 'AUDIO/WAV', filename: 'x' }), true, 'case-insensitive');
  assert.equal(is({ content_type: '  audio/ogg  ', filename: 'x' }), true, 'trimmed');
  assert.equal(is({ content_type: 'audio/mp4; codecs="mp4a.40.2"', filename: 'x' }), true, 'parameters ride along');
});

test('isVoiceAttachment: a generic content_type falls back to the FILENAME extension', () => {
  const is = pidge.isVoiceAttachment;
  for (const ext of ['.m4a', '.mp3', '.wav', '.ogg', '.opus']) {
    assert.equal(is({ content_type: 'application/octet-stream', filename: `nota${ext}` }), true, ext);
    assert.equal(is({ content_type: 'application/octet-stream', filename: `NOTA${ext.toUpperCase()}` }), true, `${ext} uppercase`);
  }
  assert.equal(is({ content_type: 'application/octet-stream', filename: 'foto.png' }), false);
  assert.equal(is({ content_type: 'application/octet-stream', filename: 'nota.m4a.txt' }), false, 'only the LAST extension counts');
});

test('isVoiceAttachment: everything that is not audio stays not-audio', () => {
  const is = pidge.isVoiceAttachment;
  assert.equal(is({ content_type: 'text/csv', filename: 'dados.csv' }), false);
  assert.equal(is({ content_type: 'image/png', filename: 'foto.png' }), false);
  assert.equal(is({ content_type: 'application/pdf', filename: 'relatorio.pdf' }), false);
  assert.equal(is({ content_type: 'application/octet-stream' }), false, 'no filename at all');
  assert.equal(is({ content_type: 'application/octet-stream', filename: 'semponto' }), false);
  assert.equal(is({ content_type: 'application/octet-stream', filename: '.m4a' }), false, 'a dot-leading name has no extension');
  assert.equal(is(null), false);
  assert.equal(is(undefined), false);
  assert.equal(is('nota.m4a'), false, 'a string is not an attachment');
});

test('isVoiceAttachment: a STILL-SEALED filename is an envelope, not an extension', () => {
  // The sealed row's name is `v1:…` until message_filename opens — which is
  // exactly why detection runs at render time, one step AFTER the unseal.
  const sealed = { content_type: 'application/octet-stream', filename: 'v1:AAAA.BBBB.CCCC', enc: 'v1' };
  assert.equal(pidge.isVoiceAttachment(sealed), false, 'ciphertext must never look like audio');
  assert.equal(pidge.isVoiceAttachment({ ...sealed, filename: 'nota-de-voz.m4a', enc: undefined }), true,
    'the same row, once opened, IS a voice note');
});

// --- pure: the optional duration ----------------------------------------------

test('voiceDurationSeconds: an integer when the sender measured it, null otherwise', () => {
  const d = pidge.voiceDurationSeconds;
  assert.equal(d({ duration_seconds: 42 }), 42);
  assert.equal(d({ duration_seconds: '42' }), 42, 'a numeric string is still a number');
  assert.equal(d({ duration_seconds: 41.6 }), 42, 'rounded — we print whole seconds');
  assert.equal(d({ duration_seconds: 0 }), 0, 'zero is a length, not an absence');
  assert.equal(d({}), null, 'OPTIONAL — absent is the common case');
  assert.equal(d({ duration_seconds: null }), null);
  assert.equal(d({ duration_seconds: '' }), null);
  assert.equal(d({ duration_seconds: 'abc' }), null, 'garbage is absent, never printed');
  assert.equal(d({ duration_seconds: -3 }), null, 'a negative length is garbage');
  assert.equal(d({ duration_seconds: Infinity }), null);
});

test('formatVoiceDuration: m:ss, and h:mm:ss past the hour', () => {
  const f = pidge.formatVoiceDuration;
  assert.equal(f(0), '0:00');
  assert.equal(f(5), '0:05');
  assert.equal(f(42), '0:42');
  assert.equal(f(60), '1:00');
  assert.equal(f(95), '1:35');
  assert.equal(f(599), '9:59');
  assert.equal(f(3599), '59:59');
  assert.equal(f(3600), '1:00:00');
  assert.equal(f(3661), '1:01:01');
});

// --- pure: the render annotation ----------------------------------------------

test('annotateVoiceAttachments: kind + duration on the JSON, one human line', () => {
  const log = collect();
  const rows = [voiceRow({ filename: 'nota.m4a', content_type: 'audio/x-m4a', duration_seconds: 42, path: '/tmp/dl/1/nota.m4a' })];
  pidge.annotateVoiceAttachments(rows, log);

  const att = rows[0].attachment;
  assert.equal(att.kind, 'voice');
  assert.equal(att.duration_seconds, 42);
  assert.equal(att.hint, pidge.VOICE_HINT);
  assert.equal(att.filename, 'nota.m4a', 'nothing else about the attachment moved');
  assert.equal(log.lines.length, 2, 'the 🎤 line + the hint, nothing more');
  assert.match(log.lines[0], /🎤 voice note, 0:42 — saved to \/tmp\/dl\/1\/nota\.m4a/);
  assert.match(log.lines[1], /does not transcribe/);
});

test('annotateVoiceAttachments: NO duration_seconds renders fine — the time is simply absent', () => {
  const log = collect();
  const rows = [voiceRow({ filename: 'nota.m4a', content_type: 'audio/x-m4a', path: '/tmp/dl/1/nota.m4a' })];
  pidge.annotateVoiceAttachments(rows, log);

  assert.equal(rows[0].attachment.kind, 'voice');
  assert.ok(!('duration_seconds' in rows[0].attachment), 'an optional field stays absent, never null/0');
  assert.match(log.lines[0], /🎤 voice note — saved to/, 'no ", m:ss" when nobody measured it');
});

test('annotateVoiceAttachments: a garbage duration is DROPPED, never echoed back', () => {
  const log = collect();
  const rows = [voiceRow({ filename: 'nota.m4a', content_type: 'audio/x-m4a', duration_seconds: 'muito tempo' })];
  pidge.annotateVoiceAttachments(rows, log);

  assert.equal(rows[0].attachment.kind, 'voice');
  assert.ok(!('duration_seconds' in rows[0].attachment), 'we never carry a length we cannot stand behind');
});

test('annotateVoiceAttachments: the hint is ONCE per render, the 🎤 line once per note', () => {
  const log = collect();
  const rows = [
    voiceRow({ filename: 'a.m4a', content_type: 'audio/x-m4a', duration_seconds: 12, path: '/tmp/a.m4a' }, 1),
    voiceRow({ filename: 'foto.png', content_type: 'image/png', url: '/blobs/p' }, 2),
    voiceRow({ filename: 'b.m4a', content_type: 'audio/x-m4a', duration_seconds: 90, path: '/tmp/b.m4a' }, 3),
  ];
  pidge.annotateVoiceAttachments(rows, log);

  const hints = rows.filter((r) => r.attachment.hint !== undefined);
  assert.equal(hints.length, 1, 'exactly ONE row carries the hint — it costs agent context');
  assert.equal(hints[0].id, 1, 'the FIRST voice note of the ordered batch carries it');
  assert.equal(log.lines.filter((l) => /does not transcribe/.test(l)).length, 1, 'one hint line');
  assert.equal(log.lines.filter((l) => /🎤/.test(l)).length, 2, 'but a line per voice note');
  assert.match(log.lines.find((l) => /b\.m4a/.test(l) || /1:30/.test(l)), /1:30/);
});

test('annotateVoiceAttachments: the human line names WHERE the bytes are', () => {
  const cases = [
    [{ filename: 'a.m4a', content_type: 'audio/x-m4a', path: '/tmp/a.m4a' }, /saved to \/tmp\/a\.m4a/],
    [{ filename: 'a.m4a', content_type: 'audio/x-m4a', sealed: true }, /bytes NOT downloaded/],
    [{ filename: 'a.m4a', content_type: 'audio/x-m4a', url: '/blobs/a' }, /--download writes it to disk/],
    [{ filename: 'a.m4a', content_type: 'audio/x-m4a' }, /no local copy/],
  ];
  for (const [att, re] of cases) {
    const log = collect();
    pidge.annotateVoiceAttachments([voiceRow(att)], log);
    assert.match(log.lines[0], re);
  }
});

test('annotateVoiceAttachments: a NON-audio attachment is left byte-for-byte alone', () => {
  const log = collect();
  const rows = [
    voiceRow({ filename: 'dados.csv', content_type: 'text/csv', byte_size: 12, url: '/blobs/c1' }, 7),
    voiceRow({ filename: 'foto.png', content_type: 'image/png', byte_size: 9, path: '/tmp/foto.png' }, 8),
    { id: 9, kind: 'message', body: 'sem anexo' },
  ];
  const before = JSON.parse(JSON.stringify(rows));
  pidge.annotateVoiceAttachments(rows, log);

  assert.deepEqual(rows, before, 'no kind, no duration_seconds, no hint on anything that is not audio');
  assert.equal(log.lines.length, 0, 'and not one line of narration');
});

test('annotateVoiceAttachments: never throws on a shape it did not expect', () => {
  const log = collect();
  assert.doesNotThrow(() => pidge.annotateVoiceAttachments([null, undefined, 'x', {}, { attachment: null }], log));
  assert.equal(pidge.annotateVoiceAttachments(null, log), null, 'a non-array passes straight through');
});

// --- integration: a CLEAR voice note through `listen` ---------------------------

const CLEAR_VOICE = {
  id: 51, channel_id: 1, kind: 'message', created_at: 'x', body: '',
  attachment: {
    filename: 'nota-de-voz.m4a', content_type: 'audio/x-m4a',
    byte_size: 9, url: '/blobs/v1', duration_seconds: 42,
  },
};

test('listen: a clear voice note is named `voice` with its duration + the hint, and is NOT downloaded', async () => {
  const mock = createMock();
  const port = await mock.start();
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-vclear-'));
  mock.state.blobs.v1 = Buffer.from('m4a-bytes');
  mock.state.messages = [JSON.parse(JSON.stringify(CLEAR_VOICE))];

  const { code, stdout, stderr } = await runCli(
    ['listen', '--no-realtime', '--timeout', '20', '--interval', '1'], port, {}, xdg);
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const att = JSON.parse(stdout)[0].attachment;
  assert.equal(att.kind, 'voice');
  assert.equal(att.duration_seconds, 42);
  assert.match(att.hint, /does not transcribe/);
  assert.equal(att.path, undefined, 'the posture for CLEAR attachments is unchanged — no auto-download');
  assert.equal(att.url, '/blobs/v1', 'the url still rides, fetchable');
  assert.match(stderr, /🎤 voice note, 0:42/);
  assert.equal(stderr.match(/does not transcribe/g).length, 1, 'the hint is one line on stderr too');
});

test('listen --download: the clear voice note lands on disk and the line says where', async () => {
  const mock = createMock();
  const port = await mock.start();
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-vdl-'));
  const bytes = Buffer.from('m4a-bytes');
  mock.state.blobs.v1 = bytes;
  mock.state.messages = [JSON.parse(JSON.stringify(CLEAR_VOICE))];

  const { code, stdout, stderr } = await runCli(
    ['listen', '--no-realtime', '--timeout', '20', '--interval', '1', '--download'], port, {}, xdg);
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const att = JSON.parse(stdout)[0].attachment;
  assert.equal(att.kind, 'voice');
  assert.deepEqual(fs.readFileSync(att.path), bytes);
  assert.match(stderr, new RegExp(`🎤 voice note, 0:42 — saved to ${att.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('listen: a voice note WITHOUT duration_seconds still renders (the field is optional end to end)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-vnodur-'));
  const row = JSON.parse(JSON.stringify(CLEAR_VOICE));
  delete row.attachment.duration_seconds;
  mock.state.blobs.v1 = Buffer.from('m4a-bytes');
  mock.state.messages = [row];

  const { code, stdout, stderr } = await runCli(
    ['listen', '--no-realtime', '--timeout', '20', '--interval', '1'], port, {}, xdg);
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const att = JSON.parse(stdout)[0].attachment;
  assert.equal(att.kind, 'voice');
  assert.ok(!('duration_seconds' in att));
  assert.match(stderr, /🎤 voice note — /);
});

test('listen: a NON-audio attachment is untouched — no kind, no hint, no 🎤', async () => {
  const mock = createMock();
  const port = await mock.start();
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-vreg-'));
  mock.state.blobs.c1 = Buffer.from('csv');
  mock.state.messages = [{
    id: 52, channel_id: 1, kind: 'message', created_at: 'x', body: 'segue o csv',
    attachment: { filename: 'dados.csv', content_type: 'text/csv', byte_size: 3, url: '/blobs/c1' },
  }];

  const { code, stdout, stderr } = await runCli(
    ['listen', '--no-realtime', '--timeout', '20', '--interval', '1'], port, {}, xdg);
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const att = JSON.parse(stdout)[0].attachment;
  assert.equal(att.kind, undefined);
  assert.equal(att.hint, undefined);
  assert.equal(att.filename, 'dados.csv');
  assert.ok(!/🎤/.test(stderr), 'nothing was narrated as audio');
  assert.ok(!/does not transcribe/.test(stderr), 'and the hint never fires without a voice note');
});

test('catchup: the read-only thread names voice notes too (one hint for the whole render)', async () => {
  const mock = createMock();
  const port = await mock.start();
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-vcatch-'));
  mock.state.blobs.v1 = Buffer.from('m4a-bytes');
  const second = JSON.parse(JSON.stringify(CLEAR_VOICE));
  second.id = 52;
  second.attachment.duration_seconds = 95;
  mock.state.messages = [JSON.parse(JSON.stringify(CLEAR_VOICE)), second];

  const { code, stdout, stderr } = await runCli(['catchup'], port, {}, xdg);
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  const rows = JSON.parse(stdout).messages;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.attachment.kind), ['voice', 'voice']);
  assert.equal(rows.filter((r) => r.attachment.hint !== undefined).length, 1, 'one hint for the batch');
  assert.equal(stderr.match(/🎤/g).length, 2, 'a line per note');
  assert.match(stderr, /🎤 voice note, 1:35/, 'm:ss past the minute');
  assert.equal(stderr.match(/does not transcribe/g).length, 1);
  assert.equal(mock.state.acks.length, 0, 'catchup still never consumes');
});

test('catchup --limit: only the PRINTED rows are narrated as voice notes', async () => {
  // The annotation runs after the slice — narrating a note this run filtered
  // out would describe something nobody was shown.
  const mock = createMock();
  const port = await mock.start();
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-vlimit-'));
  mock.state.blobs.v1 = Buffer.from('m4a-bytes');
  const second = JSON.parse(JSON.stringify(CLEAR_VOICE));
  second.id = 52;
  mock.state.messages = [JSON.parse(JSON.stringify(CLEAR_VOICE)), second];

  const { code, stdout, stderr } = await runCli(['catchup', '--limit', '1'], port, {}, xdg);
  await mock.stop();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.equal(JSON.parse(stdout).messages.length, 1);
  assert.equal(stderr.match(/🎤/g).length, 1, 'one printed row ⇒ one 🎤 line');
});
