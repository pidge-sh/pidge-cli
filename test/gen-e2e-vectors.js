'use strict';
// Generates test/e2e_vectors.json — the SHARED E2E v1 fixture.
//
// Deterministic ON PURPOSE: a fixed test key + SHA-256-derived nonces, so the
// output is byte-identical on every run and platform. The vectors are canonical
// for ANY implementation of wire format v1 — cross-implementation byte-identity
// IS the gate, e.g. against base64url encoding drift. Regenerate ONLY on a
// contract change:
//
//   node test/gen-e2e-vectors.js
//
// NEVER use this key or these nonces in production — production nonces are
// crypto.randomBytes(12) per envelope (the lib's default when none is passed).
// Not published: this file lives under test/, outside package.json `files`.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { e2eAad, e2eEncryptField, e2eEncryptBlob, e2eKeyFingerprint } = require('../bin/pidge.js');

const KEY = crypto.createHash('sha256').update('pidge e2e v1 shared test key — NEVER production').digest();
const WRONG_KEY = crypto.createHash('sha256').update('pidge e2e v1 wrong key — the kf mismatch case').digest();
const CHANNEL_ID = 42;
const nonceFor = (label) => crypto.createHash('sha256').update(`pidge e2e v1 nonce:${label}`).digest().subarray(0, 12);

// The "markdown longo" case must exceed 10 KB by contract (a verbose
// body_markdown is the realistic big field).
function longMarkdown() {
  const lines = ['# Relatório diário — build & deploy', ''];
  for (let i = 1; lines.join('\n').length <= 10 * 1024; i++) {
    lines.push(`- **item ${i}** — o pipeline rodou o passo ${i} com saída \`ok\`; latência ${(i * 7) % 400} ms, retry ${i % 3}× — [log](https://ci.example/run/${i}) ☕️`);
  }
  lines.push('', '> gerado deterministicamente por test/gen-e2e-vectors.js — >10 KB por contrato (caso "markdown longo").');
  return lines.join('\n');
}

// A few KB of deterministic pseudo-binary (SHA-256 in counter mode) — the
// "blob pequeno" case: full byte range, no valid UTF-8 assumption.
function smallBlob() {
  const chunks = [];
  for (let i = 0; i < 96; i++) chunks.push(crypto.createHash('sha256').update(`pidge e2e v1 blob chunk ${i}`).digest());
  return Buffer.concat(chunks); // 96 × 32 B = 3072 B
}

// The spec's case list: campo curto · unicode/emoji · markdown longo · reply —
// plus filename and an action label (both in the spec's encrypted-field list),
// each with a REAL AAD (public channel id + a client-side uuid + the field name).
const FIELDS = [
  { name: 'short-field', field_name: 'title', correlation_id: 'c0ffee01-e2e0-4001-8001-000000000001', plaintext: 'Backup concluído' },
  { name: 'unicode-emoji', field_name: 'body', correlation_id: 'c0ffee01-e2e0-4002-8002-000000000002', plaintext: 'Deploy verde ✅ — latência ↓12%, fila ~zero. Café ☕️ liberado 🇧🇷 (ñ, ü, ação, 中文, עברית)' },
  { name: 'long-markdown', field_name: 'body_markdown', correlation_id: 'c0ffee01-e2e0-4003-8003-000000000003', plaintext: longMarkdown() },
  { name: 'reply', field_name: 'reply', correlation_id: 'c0ffee01-e2e0-4004-8004-000000000004', plaintext: 'Aprovo — mas espera eu chegar em casa 🏠 (uns 20 min)' },
  { name: 'filename', field_name: 'filename', correlation_id: 'c0ffee01-e2e0-4005-8005-000000000005', plaintext: 'relatório-q2 (final) ✅.xlsx' },
  { name: 'action-label', field_name: 'action_label_deploy_prod', correlation_id: 'c0ffee01-e2e0-4006-8006-000000000006', plaintext: 'Fazer o deploy 🚀' },
];

function buildVectors() {
  const field_vectors = FIELDS.map((f) => {
    const aad = e2eAad(CHANNEL_ID, f.correlation_id, f.field_name);
    const nonce = nonceFor(f.name);
    return {
      name: f.name,
      channel_id: CHANNEL_ID,
      correlation_id: f.correlation_id,
      field_name: f.field_name,
      aad,
      nonce_b64url: nonce.toString('base64url'),
      plaintext: f.plaintext,
      envelope: e2eEncryptField(KEY, aad, f.plaintext, nonce),
    };
  });

  const blobPlain = smallBlob();
  const blobCid = 'c0ffee01-e2e0-4007-8007-000000000007';
  const blobAad = e2eAad(CHANNEL_ID, blobCid, 'blob');
  const blobNonce = nonceFor('small-blob');
  const blobFramed = e2eEncryptBlob(KEY, blobAad, blobPlain, blobNonce);
  const blob_vectors = [{
    name: 'small-blob',
    channel_id: CHANNEL_ID,
    correlation_id: blobCid,
    field_name: 'blob',
    aad: blobAad,
    nonce_b64url: blobNonce.toString('base64url'),
    plaintext_b64url: blobPlain.toString('base64url'),
    plaintext_sha256_hex: crypto.createHash('sha256').update(blobPlain).digest('hex'),
    framed_b64url: blobFramed.toString('base64url'),
  }];

  // Failure cases derive from the short-field vector so every implementation
  // rejects the SAME bytes for the SAME reason.
  const base = field_vectors[0];
  const baseRaw = Buffer.from(base.envelope.slice('v1:'.length), 'base64url');
  const corruptedRaw = Buffer.from(baseRaw);
  corruptedRaw[corruptedRaw.length - 1] ^= 0x01; // flip one bit of the GCM tag
  const blobBadVersion = Buffer.from(blobFramed);
  blobBadVersion[0] = 0x09;
  const failure_cases = {
    wrong_aad: {
      envelope: base.envelope,
      aad: e2eAad(CHANNEL_ID, base.correlation_id, 'body'),
      note: 'the short-field ciphertext presented under ANOTHER field\'s AAD — must FAIL (anti-swap)',
    },
    corrupted_tag: {
      envelope: 'v1:' + corruptedRaw.toString('base64url'),
      aad: base.aad,
      note: 'last byte of the GCM tag bit-flipped — must FAIL',
    },
    unknown_version: {
      envelope: 'v9:' + baseRaw.toString('base64url'),
      aad: base.aad,
      note: 'unknown version prefix — must fail with a PRECISE version error, never be attempted as v1',
    },
    invalid_base64: {
      envelope: 'v1:not*valid*base64url!',
      aad: base.aad,
      note: 'mangled base64url payload — must fail loud as an encoding error, not decode-to-garbage',
    },
    blob_unknown_version: {
      framed_b64url: blobBadVersion.toString('base64url'),
      aad: blobAad,
      note: 'blob framing whose version byte is 0x09 — must fail with a version error',
    },
  };

  return {
    _readme: [
      'pidge E2E v1 — SHARED test vectors for wire format v1.',
      'AES-256-GCM · key 32 B · nonce 12 B · tag 16 B. Field envelope: "v1:" + base64url(nonce || ciphertext || tag).',
      'Blob framing: [0x01][nonce 12B][ciphertext][tag 16B] — binary, NO base64 on the wire (b64url here is JSON transport only).',
      'AAD = "ch<channel_id>:<correlation_id>:<field_name>" (ASCII; channel_id is the PUBLIC id). base64url is UNPADDED.',
      'kf = base64url(SHA-256(key)[0..3]) — 4 bytes, rides clear next to enc:"v1" so a key mismatch is a precise error.',
      'DETERMINISTIC test material — key/nonces fixed here only; production nonces are crypto.randomBytes(12). NEVER reuse this key.',
      'These vectors are canonical for ANY implementation of wire format v1 — every implementation asserts THESE bytes.',
      'Regenerate only on a contract change: node test/gen-e2e-vectors.js',
      'field_vectors/blob_vectors round-trip both ways; failure_cases MUST throw/fail in every implementation.',
    ],
    suite: 'pidge-e2e-v1',
    algorithm: 'AES-256-GCM',
    key_b64url: KEY.toString('base64url'),
    wrong_key_b64url: WRONG_KEY.toString('base64url'),
    kf: e2eKeyFingerprint(KEY),
    wrong_key_kf: e2eKeyFingerprint(WRONG_KEY),
    field_vectors,
    blob_vectors,
    failure_cases,
  };
}

const OUT = path.join(__dirname, 'e2e_vectors.json');
function writeFixture() {
  const json = JSON.stringify(buildVectors(), null, 2) + '\n';
  const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
  if (prev === json) { console.error(`e2e_vectors.json unchanged (${json.length} bytes)`); return; }
  fs.writeFileSync(OUT, json);
  console.error(`wrote ${OUT} (${json.length} bytes)`);
}
// node --test may execute this file as a test-runner main (everything under
// test/ counts as a test file on some Node versions) — the write is idempotent
// byte-for-byte, so that run is a harmless no-op that "passes".
if (require.main === module) writeFixture();
module.exports = { buildVectors };
