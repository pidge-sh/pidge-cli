'use strict';
// Unit tests for the terminal wire layer (pure helpers — no tmux, no server):
// octal unescaping, sealed-frame roundtrips + direction/anchor separation,
// the key whitelist and the tmux command translation (quoting included).
const { test } = require('node:test');
const assert = require('node:assert');

const wire = require('../src/terminal/wire');
const { e2eAad, e2eEncryptBlob, e2eDecryptBlob } = require('../bin/pidge.js');

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const CH = 1;
const PID = 'term_test-1234';

test('unescapeOctal: \\NNN bytes, escaped backslash, lone backslash passthrough', () => {
  // "\033[1m" (ESC) + plain text
  assert.deepStrictEqual(wire.unescapeOctal('\\033[1mok'), Buffer.from('\x1b[1mok', 'latin1'));
  // tmux escapes a backslash as \134
  assert.deepStrictEqual(wire.unescapeOctal('a\\134b'), Buffer.from('a\\b'));
  // a doubled backslash is tolerated too
  assert.deepStrictEqual(wire.unescapeOctal('a\\\\b'), Buffer.from('a\\b'));
  // a backslash before non-octal passes through unmangled
  assert.deepStrictEqual(wire.unescapeOctal('a\\zb'), Buffer.from('a\\zb'));
  // UTF-8 rides as escaped BYTES (em dash = e2 80 94) — bytes, never chars
  assert.deepStrictEqual(wire.unescapeOctal('\\342\\200\\224'), Buffer.from('—', 'utf8'));
});

test('sealFrame is the iOS WIRE FORM: standard base64 (padded) of a [0x01]-led blob, opens byte-for-byte', () => {
  const frame = { t: 'o', epoch: 3, seq: 41, data: Buffer.from('hello').toString('base64') };
  const sealed = wire.sealFrame(KEY, CH, PID, wire.AAD_OUTPUT, frame);
  // NOT the field-envelope string form — no "v1:" prefix, and STANDARD base64
  // (may contain + / =, never the base64url -_). This is what the viewer's
  // strict Data(base64Encoded:) reader requires.
  assert.doesNotMatch(sealed, /^v1:/);
  assert.match(sealed, /^[A-Za-z0-9+/]+={0,2}$/);
  const blob = Buffer.from(sealed, 'base64');
  assert.strictEqual(blob[0], 0x01, 'blob framing version byte');
  // decode via the raw blob helper with the SAME AAD the iOS side builds
  // (ch<ch>:<pid>:terminal_output) — proves the wire is interop, not just self-consistent
  const plain = e2eDecryptBlob(KEY, e2eAad(CH, PID, wire.AAD_OUTPUT), blob);
  assert.deepStrictEqual(JSON.parse(plain.toString('utf8')), frame);
  // and the wire helper round-trips
  assert.deepStrictEqual(wire.openFrame(KEY, CH, PID, wire.AAD_OUTPUT, sealed), frame);
  // reflection: the same bytes presented as INPUT authenticate in no slot
  assert.strictEqual(wire.openFrame(KEY, CH, PID, wire.AAD_INPUT, sealed), null);
  // a swapped anchor (another session's public_id) fails the tag too
  assert.strictEqual(wire.openFrame(KEY, CH, 'term_other', wire.AAD_OUTPUT, sealed), null);
  // wrong key
  assert.strictEqual(wire.openFrame(OTHER_KEY, CH, PID, wire.AAD_OUTPUT, sealed), null);
});

test('openFrame swallows garbage instead of throwing (a hostile frame must never kill the mirror)', () => {
  assert.strictEqual(wire.openFrame(KEY, CH, PID, wire.AAD_INPUT, 'not-base64-@@@'), null);
  assert.strictEqual(wire.openFrame(KEY, CH, PID, wire.AAD_INPUT, 'AAAA'), null); // decodes but too short / bad version
  // a sealed NON-object (valid crypto, wrong shape) is rejected as a frame
  const sealedScalar = e2eEncryptBlob(KEY, e2eAad(CH, PID, wire.AAD_INPUT), Buffer.from('42', 'utf8')).toString('base64');
  assert.strictEqual(wire.openFrame(KEY, CH, PID, wire.AAD_INPUT, sealedScalar), null);
});

test('openViewerFrame roams: opens a keystroke under terminal_input AND a reseed under terminal_ctrl_viewer', () => {
  const keys = { t: 'i', vgen: 'k3v9x2mq', seq: 7, keys: [{ lit: 'ls' }] };
  const wireKeys = wire.sealFrame(KEY, CH, PID, wire.AAD_INPUT, keys);
  assert.deepStrictEqual(wire.openViewerFrame(KEY, CH, PID, wireKeys), { frame: keys, field: wire.AAD_INPUT });

  // reseed/resize ROAM on the session's own :in sealed with terminal_ctrl_viewer
  const reseed = { t: 'reseed', vgen: 'k3v9x2mq', seq: 5, pid: PID };
  const wireReseed = wire.sealFrame(KEY, CH, PID, wire.AAD_CTRL_VIEWER, reseed);
  assert.deepStrictEqual(wire.openViewerFrame(KEY, CH, PID, wireReseed), { frame: reseed, field: wire.AAD_CTRL_VIEWER });

  // a host→viewer output frame is neither viewer field ⇒ null
  const out = wire.sealFrame(KEY, CH, PID, wire.AAD_OUTPUT, { t: 'o', seq: 1, data: '' });
  assert.strictEqual(wire.openViewerFrame(KEY, CH, PID, out), null);
});

test('createLedger: per-vgen monotonic seq, missing/invalid vgen dropped, reconnect (new vgen) restarts at 1', () => {
  const L = wire.createLedger();
  const F = wire.AAD_INPUT;
  assert.ok(L.accept(F, 'aaaaaaaa', 1));
  assert.ok(L.accept(F, 'aaaaaaaa', 2));
  assert.ok(!L.accept(F, 'aaaaaaaa', 2), 'replay of the same seq dropped');
  assert.ok(!L.accept(F, 'aaaaaaaa', 1), 'an older seq dropped');
  assert.ok(L.accept(F, 'aaaaaaaa', 5), 'a gap forward is fine');
  // a reconnecting viewer mints a NEW vgen and restarts at 1 — must be accepted
  // (the OLD lifetime-high-water design wrongly dropped this)
  assert.ok(L.accept(F, 'bbbbbbbb', 1));
  // vgen validation: missing / too short / wrong charset ⇒ dropped
  assert.ok(!L.accept(F, undefined, 1));
  assert.ok(!L.accept(F, 'short', 1));
  assert.ok(!L.accept(F, 'HASUPPER1', 1));
  // non-integer / non-positive seq ⇒ dropped
  assert.ok(!L.accept(F, 'cccccccc', 0));
  assert.ok(!L.accept(F, 'cccccccc', 1.5));
  // the field is part of the key: same vgen, different field is an independent ledger
  assert.ok(L.accept(wire.AAD_CTRL_VIEWER, 'aaaaaaaa', 1));
});

test('createLedger: a replayed frame in its ORIGINAL vgen is a no-op even after another vgen advanced', () => {
  const L = wire.createLedger();
  const F = wire.AAD_CTRL_VIEWER;
  assert.ok(L.accept(F, 'vgenonexx', 4));  // viewer 1 sends spawn seq 4
  assert.ok(L.accept(F, 'vgentwoxx', 1));  // viewer 2 joins, seq 1
  assert.ok(!L.accept(F, 'vgenonexx', 4), 'replaying viewer 1 seq 4 lands in its own dead ledger → dropped');
});

test('chunkBytes splits a burst into ≤max frames, preserving bytes', () => {
  const buf = Buffer.from('x'.repeat(40000));
  const chunks = wire.chunkBytes(buf, 16 * 1024);
  assert.strictEqual(chunks.length, 3);
  assert.strictEqual(Buffer.concat(chunks).length, buf.length);
  assert.strictEqual(chunks[2].length, 40000 - 2 * 16 * 1024);
});

test('chunkBytes never hangs on a non-positive max (a bad manifest limit)', () => {
  // A zero/negative step would loop forever; the guard floors it to the
  // protocol chunk size, so the call terminates with finite, byte-preserving chunks.
  const buf = Buffer.from('y'.repeat(40000));
  for (const bad of [0, -5]) {
    const chunks = wire.chunkBytes(buf, bad);
    assert.strictEqual(Buffer.concat(chunks).length, buf.length);
    assert.ok(chunks.length >= 1 && chunks.every((c) => c.length > 0));
  }
});

test('normalizeKeyEntry: whitelist is CLOSED — unknown tokens drop, literals cap', () => {
  assert.deepStrictEqual(wire.normalizeKeyEntry({ key: 'BTab' }), { key: 'BTab' });
  assert.strictEqual(wire.normalizeKeyEntry({ key: 'F12' }), null);
  assert.strictEqual(wire.normalizeKeyEntry({ key: 'C-b' }), null); // not in the set
  assert.strictEqual(wire.normalizeKeyEntry({}), null);
  assert.strictEqual(wire.normalizeKeyEntry('Enter'), null); // wrong shape
  assert.strictEqual(wire.normalizeKeyEntry({ lit: 'x'.repeat(9000) }).lit.length, 4096);
});

test('keysToTmuxCommands: literals in their own send-keys -l, specials separate, quoting exact', () => {
  const cmds = wire.keysToTmuxCommands('work', [
    { lit: "echo 'a b'" },
    { key: 'Enter' },
    { key: 'NotAKey' },        // dropped
    { lit: 'multi\nline' },    // newline → Enter between segments
  ]);
  assert.deepStrictEqual(cmds, [
    "send-keys -t 'work' -l -- 'echo '\\''a b'\\'''",
    "send-keys -t 'work' -- Enter",
    "send-keys -t 'work' -l -- 'multi'",
    "send-keys -t 'work' -- Enter",
    "send-keys -t 'work' -l -- 'line'",
  ]);
});

test('keysToTmuxCommands strips C0 controls from literals (specials must ride as tokens)', () => {
  const cmds = wire.keysToTmuxCommands('w', [{ lit: 'a\x1b\x03b' }]);
  assert.deepStrictEqual(cmds, ["send-keys -t 'w' -l -- 'ab'"]);
  // a control-only literal produces nothing at all
  assert.deepStrictEqual(wire.keysToTmuxCommands('w', [{ lit: '\x1b' }]), []);
});
