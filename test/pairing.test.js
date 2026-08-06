'use strict';
// Pairing v2 (spec §24) — the pure halves: the QR payload builder against the
// shared cross-wire fixture (test/pairing_qr_vectors.json — iOS asserts the
// SAME bytes through its real parser), and the in-tree QR encoder against the
// committed golden matrices (test/qr_golden.json — every case cross-validated
// module-by-module against python-qrcode by test/gen-qr-golden.py). The
// interactive `connect --qr` flow lives in terminal.test.js with the other
// connect integration tests.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { qrEncodeText, qrRenderTerminal } = require('../src/terminal/qr.js');
const { buildPairingPayload, PAIR_QR_PREFIX, pairingBaseUrlOk } = require('../src/terminal/pairing.js');
const core = require('../src/terminal/core.js');
const { buildFixture } = require('./gen-pairing-qr-vectors.js');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'pairing_qr_vectors.json'), 'utf8'));
const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'qr_golden.json'), 'utf8'));
const KEY = Buffer.from(FIXTURE.key_b64url, 'base64url');

// --- the payload (wire contract, §24.1) --------------------------------------

test('pairing fixture drift — regenerating reproduces the committed bytes exactly', () => {
  const committed = fs.readFileSync(path.join(__dirname, 'pairing_qr_vectors.json'), 'utf8');
  const regenerated = JSON.stringify(buildFixture(), null, 2) + '\n';
  assert.equal(regenerated, committed,
    'test/pairing_qr_vectors.json does not match its generator — the payload contract moved without a spec change');
});

test('the builder emits the fixture payload byte-for-byte — iOS parses these SAME bytes', () => {
  const payload = buildPairingPayload({ key: KEY, host: FIXTURE.host, os: FIXTURE.os, baseUrl: FIXTURE.base_url });
  assert.equal(payload, FIXTURE.payload);
});

test('payload wire form: prefix outside the base64, unpadded, pinned field order, kf consistent', () => {
  assert.ok(FIXTURE.payload.startsWith(PAIR_QR_PREFIX), 'version segment rides OUTSIDE the base64');
  const b64 = FIXTURE.payload.slice(PAIR_QR_PREFIX.length);
  assert.match(b64, /^[A-Za-z0-9_-]+$/, 'base64url, UNPADDED');
  const json = Buffer.from(b64, 'base64url').toString('utf8');
  assert.equal(json, FIXTURE.payload_json, 'decodes to the exact pinned JSON string');
  const parsed = JSON.parse(json);
  assert.deepEqual(Object.keys(parsed), ['k', 'kf', 'host', 'os', 'base_url'], 'ONE canonical serialization order');
  assert.equal(parsed.kf, core.e2eKeyFingerprint(Buffer.from(parsed.k, 'base64url')),
    'kf in the payload IS the fingerprint of k — the parser recomputes and refuses a mismatch');
});

test('the builder refuses what the phone would refuse — no QR is ever born invalid', () => {
  const ok = { key: KEY, host: 'studio.local', os: 'macos', baseUrl: 'https://api.pidge.sh' };
  assert.throws(() => buildPairingPayload({ ...ok, key: KEY.subarray(0, 24) }), /32-byte/, 'short key');
  assert.throws(() => buildPairingPayload({ ...ok, key: KEY.toString('base64url') }), /32-byte/, 'a string is not a key');
  assert.throws(() => buildPairingPayload({ ...ok, host: '   ' }), /non-empty host/, 'whitespace host');
  assert.throws(() => buildPairingPayload({ ...ok, os: '' }), /needs an os/);
  assert.throws(() => buildPairingPayload({ ...ok, baseUrl: 'http://api.pidge.sh' }), /https/, 'http dies at the source');
  // The ONE carve-out: loopback http, so the mock-server integration tests
  // (and a local dev server) can exercise the flow end-to-end.
  assert.ok(pairingBaseUrlOk('http://127.0.0.1:3000'));
  assert.ok(pairingBaseUrlOk('http://localhost:3000'));
  assert.ok(!pairingBaseUrlOk('http://192.168.1.10:3000'), 'LAN http is NOT loopback');
  assert.ok(!pairingBaseUrlOk('http://evil.com/127.0.0.1'), 'loopback must be the HOST, not a path');
});

test('fixture failure cases are what their notes claim (the fixture cannot lie to iOS)', () => {
  const f = FIXTURE.failure_cases;
  assert.ok(f.unknown_version.payload.startsWith('pidge-pair:v9:'), 'unknown version, same base64');
  const parse = (p) => JSON.parse(Buffer.from(p.slice(PAIR_QR_PREFIX.length), 'base64url').toString('utf8'));
  const mism = parse(f.kf_mismatch.payload);
  assert.notEqual(mism.kf, core.e2eKeyFingerprint(Buffer.from(mism.k, 'base64url')), 'kf really mismatches');
  const short = parse(f.short_key.payload);
  assert.equal(Buffer.from(short.k, 'base64url').length, 24, 'short key really decodes to 24 bytes');
  assert.equal(short.kf, core.e2eKeyFingerprint(Buffer.from(short.k, 'base64url')),
    'short-key kf matches the short bytes — LENGTH is the one failure in this case');
  const std = parse(f.standard_base64_key.payload);
  assert.match(std.k, /[+/]/, 'standard base64 visibly differs from base64url');
  assert.ok(Buffer.from(std.k, 'base64').equals(KEY), 'same 32 bytes, wrong alphabet');
  const http = parse(f.http_base_url.payload);
  assert.match(http.base_url, /^http:\/\//);
  // And the additive-evolution case parses fine with an ignorable extra key.
  const extra = parse(FIXTURE.unknown_extra_key_payload);
  assert.equal(extra.color, 'teal');
  assert.equal(extra.k, FIXTURE.key_b64url);
});

// --- the QR encoder (§24.5) ---------------------------------------------------

test('QR golden — the encoder reproduces every cross-validated matrix module-by-module', () => {
  assert.ok(GOLDEN.cases.length >= 6, 'the golden set covers multiple versions');
  for (const c of GOLDEN.cases) {
    const q = qrEncodeText(c.text, { ecl: c.ecl });
    assert.equal(q.version, c.version, `${c.ecl} v${c.version}: version pick`);
    assert.equal(q.size, c.size);
    assert.equal(q.mask, c.mask, `${c.ecl} v${c.version}: penalty-chosen mask`);
    assert.deepEqual(q.modules.map((r) => r.join('')), c.rows, `${c.ecl} v${c.version}: matrix`);
  }
});

test('QR of the fixture payload: deterministic, sane size, renders with a quiet zone', () => {
  const q = qrEncodeText(FIXTURE.payload);
  assert.equal(q.size, 17 + 4 * q.version);
  assert.ok(q.version <= 12, `a pairing payload stays a scannable size (got v${q.version})`);
  const render = qrRenderTerminal(q);
  const lines = render.split('\n');
  assert.ok(lines.every((l) => [...l].length === q.size + 4), 'every line = size + 2×2 quiet modules wide');
  assert.equal(lines.length, Math.ceil((q.size + 4) / 2), 'two modules per character row');
  assert.match(render, /[█▀▄]/, 'half-block rendering');
  const again = qrRenderTerminal(qrEncodeText(FIXTURE.payload));
  assert.equal(render, again, 'same payload ⇒ the same QR, always');
});

test('QR encoder guardrails: unknown EC level and oversize payloads die with named errors', () => {
  assert.throws(() => qrEncodeText('x', { ecl: 'H' }), /speaks L and M/);
  assert.throws(() => qrEncodeText('A'.repeat(3000)), /exceeds QR capacity/);
});

test('the payload class never collides with the sentinel or leaks structure', () => {
  // A hostile "payload" is handled by the PHONE's parser (typed errors against
  // the fixture); here we only pin that OUR builder never emits whitespace or
  // quotes that could smuggle shell metacharacters into a terminal renderer.
  const weird = buildPairingPayload({
    key: crypto.createHash('sha256').update('weird host key').digest(),
    host: '  Mac de João — "dev" $(box)  ',
    os: 'macos',
    baseUrl: 'https://api.pidge.sh',
  });
  assert.match(weird, /^pidge-pair:v1:[A-Za-z0-9_-]+$/, 'prefix + base64url and NOTHING else');
});
