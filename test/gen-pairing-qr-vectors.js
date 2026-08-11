'use strict';
// Generates test/pairing_qr_vectors.json — the SHARED Pairing-v2 QR fixture
// (agent-sessions-spec §24.6). Canonical home: server/test/fixtures/ in the
// pidge repo, beside e2e_vectors.json; this repo carries the byte-identical
// copy (the same arrangement as the E2E fixture). The CLI asserts its
// generator emits `payload` byte-for-byte; iOS asserts the REAL parser (the
// one the scan path calls) accepts the payload and refuses every failure
// case with a typed error.
//
// Deterministic ON PURPOSE — regenerate only on a contract change:
//   node test/gen-pairing-qr-vectors.js
// NEVER use this key in production.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { buildPairingPayload, PAIR_QR_PREFIX, PAIR_DROP_PREFIX, pairDropId } = require('../src/terminal/pairing.js');
const core = require('../src/terminal/core.js');

const KEY = crypto.createHash('sha256').update('pidge pairing v1 shared test key — NEVER production').digest();
const WRONG_KEY = crypto.createHash('sha256').update('pidge pairing v1 wrong key — the kf mismatch case').digest();
const HOST = 'studio.local';
const OS = 'macos';
const BASE_URL = 'https://api.pidge.sh';

// The standard-base64 failure case must be UNAMBIGUOUS: a standard encoding
// that happens to contain no '+'/'/' would differ from base64url only in
// padding, and implementations disagree on padding tolerance. Assert the
// chosen key's standard form actually shows the alphabet difference.
const KEY_STD_B64 = KEY.toString('base64');
if (!/[+/]/.test(KEY_STD_B64)) {
  throw new Error('fixture key\'s standard base64 shows no +// — pick a different key label');
}

const encode = (obj) => PAIR_QR_PREFIX + Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
const fields = (over = {}) => ({
  k: KEY.toString('base64url'),
  kf: core.e2eKeyFingerprint(KEY),
  host: HOST,
  os: OS,
  base_url: BASE_URL,
  ...over,
});

function buildFixture() {
  const payload = buildPairingPayload({ key: KEY, host: HOST, os: OS, baseUrl: BASE_URL });
  const shortKey = KEY.subarray(0, 24);
  return {
    _readme: [
      'pidge Pairing v2 — SHARED QR payload vectors (agent-sessions-spec §24.1/§24.6).',
      'Payload: "pidge-pair:v1:" + base64url_unpadded(UTF-8 JSON {k, kf, host, os, base_url}).',
      'The v1 segment sits OUTSIDE the base64: an unknown version must error ("update the app") BEFORE any decode.',
      'Parsers MUST recompute kf from k and REFUSE on mismatch — the confirm screen may never show a fingerprint the stored key won\'t have.',
      'k is validated by the BYOK validator: exact PIDGE_SECRET wire form, 32 bytes, base64url alphabet (standard base64 refused).',
      'base_url must be well-formed https:// — the phone refuses http, and refuses a base_url that differs from its own (copy names BOTH urls).',
      'host: trimmed, non-empty. os: macos|linux|wsl — unknown values are TOLERATED (rendered raw; older phone vs newer CLI).',
      'Unknown JSON keys are IGNORED (§12 additive evolution).',
      'The CLI asserts its generator emits `payload` byte-for-byte; iOS asserts the REAL scan-path parser accepts/refuses each case with a typed error.',
      'DETERMINISTIC test material — NEVER use this key in production. Regenerate only on contract change: node test/gen-pairing-qr-vectors.js',
    ],
    suite: 'pidge-pairing-qr-v1',
    prefix: PAIR_QR_PREFIX,
    key_b64url: KEY.toString('base64url'),
    kf: core.e2eKeyFingerprint(KEY),
    pair_drop: {
      prefix: PAIR_DROP_PREFIX,
      drop_id: pairDropId(KEY),
      note: 'spec §24.7 — drop_id = base64url_unpadded(SHA-256(UTF-8 prefix || raw 32-byte K)), 43 chars. Derived by CLI and phone, never transmitted alongside K; both sides assert THIS value from key_b64url.',
    },
    host: HOST,
    os: OS,
    base_url: BASE_URL,
    payload_json: JSON.stringify(fields()),
    payload,
    // A payload with a key the phone does not expect ("future CLI added a
    // field"): parsers must ACCEPT it and ignore the extra (§12).
    unknown_extra_key_payload: encode({ ...fields(), color: 'teal' }),
    failure_cases: {
      unknown_version: {
        payload: 'pidge-pair:v9:' + payload.slice(PAIR_QR_PREFIX.length),
        note: 'version segment is OUTSIDE the base64 — must error "update the app" before any decode is attempted',
      },
      kf_mismatch: {
        payload: encode(fields({ kf: core.e2eKeyFingerprint(WRONG_KEY) })),
        note: 'kf does not match SHA-256(k)[0..3] — the parser recomputes and REFUSES (the confirm screen never lies)',
      },
      short_key: {
        payload: encode(fields({ k: shortKey.toString('base64url'), kf: core.e2eKeyFingerprint(shortKey) })),
        note: 'k decodes to 24 bytes — the BYOK validator refuses anything but exactly 32 (kf here matches the short bytes, so the LENGTH is the one failure)',
      },
      standard_base64_key: {
        payload: encode(fields({ k: KEY_STD_B64 })),
        note: 'the SAME 32 bytes in standard base64 (contains + or /) — refused: the wire form is base64url exactly',
      },
      http_base_url: {
        payload: encode(fields({ base_url: 'http://api.pidge.sh' })),
        note: 'base_url must be https:// — an http QR is refused outright (and a mismatching https one is refused naming both urls)',
      },
      duplicate_key: {
        // Hand-built JSON (stringify cannot emit duplicates): "k" appears
        // TWICE — first a WRONG key, then the right one. A parser that
        // "resolved" instead of refusing would bind different keys per
        // implementation (Swift's Decodable keeps the FIRST, JSON.parse the
        // LAST) — which is exactly why duplicates are refused, never resolved.
        payload: PAIR_QR_PREFIX + Buffer.from(
          `{"k":"${WRONG_KEY.toString('base64url')}",` + JSON.stringify(fields()).slice(1),
          'utf8').toString('base64url'),
        note: 'the same JSON key twice (k: a wrong key first, the right one second) — parsers disagree on duplicate resolution, so ANY duplicated key is a typed refusal, never resolved',
      },
    },
  };
}

const OUT = path.join(__dirname, 'pairing_qr_vectors.json');
function writeFixture() {
  const json = JSON.stringify(buildFixture(), null, 2) + '\n';
  const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
  if (prev === json) { console.error(`pairing_qr_vectors.json unchanged (${json.length} bytes)`); return; }
  fs.writeFileSync(OUT, json);
  console.error(`wrote ${OUT} (${json.length} bytes)`);
}
// Idempotent byte-for-byte, so an accidental `node --test` execution of this
// file is a harmless no-op that "passes" (same caveat as gen-e2e-vectors.js).
if (require.main === module) writeFixture();
module.exports = { buildFixture };
