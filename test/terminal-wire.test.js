'use strict';
// Unit tests for the terminal wire layer (pure helpers — no tmux, no server):
// octal unescaping, sealed-frame roundtrips + direction/anchor separation,
// the key whitelist and the tmux command translation (quoting included).
const { test } = require('node:test');
const assert = require('node:assert');

const wire = require('../src/terminal/wire');
const { e2eAad, e2eEncryptField } = require('../bin/pidge.js');

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

test('sealFrame/openFrame roundtrip — and the per-direction AADs refuse a reflected frame', () => {
  const frame = { t: 'o', epoch: 3, seq: 41, data: Buffer.from('hello').toString('base64') };
  const sealed = wire.sealFrame(KEY, CH, PID, wire.AAD_OUTPUT, frame);
  assert.match(sealed, /^v1:/);
  assert.deepStrictEqual(wire.openFrame(KEY, CH, PID, wire.AAD_OUTPUT, sealed), frame);
  // reflection: the same bytes presented as INPUT authenticate in no slot
  assert.strictEqual(wire.openFrame(KEY, CH, PID, wire.AAD_INPUT, sealed), null);
  // a swapped anchor (another session's public_id) fails the tag too
  assert.strictEqual(wire.openFrame(KEY, CH, 'term_other', wire.AAD_OUTPUT, sealed), null);
  // wrong key
  assert.strictEqual(wire.openFrame(OTHER_KEY, CH, PID, wire.AAD_OUTPUT, sealed), null);
});

test('openFrame swallows garbage instead of throwing (a hostile frame must never kill the mirror)', () => {
  assert.strictEqual(wire.openFrame(KEY, CH, PID, wire.AAD_INPUT, 'not-an-envelope'), null);
  assert.strictEqual(wire.openFrame(KEY, CH, PID, wire.AAD_INPUT, 'v1:!!!!'), null);
  // a sealed NON-object (valid crypto, wrong shape) is rejected as a frame
  const sealedScalar = e2eEncryptField(KEY, e2eAad(CH, PID, wire.AAD_INPUT), '42');
  assert.strictEqual(wire.openFrame(KEY, CH, PID, wire.AAD_INPUT, sealedScalar), null);
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
