'use strict';
// E0 (#180): the shared E2E v1 crypto lib — round-trip every committed vector,
// prove every failure case fails LOUD, pin the fixture against drift, and
// check e2eLoadSecret's slot/precedence (the same as PIDGE_TOKEN).
// Contract: e2e-spec-v1.md (ratified 2026-07-02). NO command uses any of this
// yet — E0 is lib + vectors only (wire/send integration is E1..E3).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'pidge.js');
// The test seam: require()ing the CLI exports the pure helpers WITHOUT running
// the command machinery (no parseArgs, no TOKEN check, no dispatch).
const e2e = require(CLI);
const { buildVectors } = require('./gen-e2e-vectors.js');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'e2e_vectors.json'), 'utf8'));
const KEY = Buffer.from(FIXTURE.key_b64url, 'base64url');
const WRONG_KEY = Buffer.from(FIXTURE.wrong_key_b64url, 'base64url');

test('require()ing the CLI exposes the e2e helpers without running a command', () => {
  for (const fn of ['e2eAad', 'e2eKeyFingerprint', 'e2eLoadSecret',
    'e2eEncryptField', 'e2eDecryptField', 'e2eEncryptBlob', 'e2eDecryptBlob']) {
    assert.equal(typeof e2e[fn], 'function', `${fn} must be exported`);
  }
});

test('fixture drift — regenerating the vectors reproduces the committed bytes exactly', () => {
  const committed = fs.readFileSync(path.join(__dirname, 'e2e_vectors.json'), 'utf8');
  const regenerated = JSON.stringify(buildVectors(), null, 2) + '\n';
  assert.equal(regenerated, committed,
    'test/e2e_vectors.json does not match test/gen-e2e-vectors.js output — the lib or the generator moved without re-ratifying the contract (the fixture is committed byte-identical in BOTH repos)');
});

test('field vectors round-trip: encrypt(fixed nonce) reproduces the envelope; decrypt returns the plaintext', () => {
  assert.ok(FIXTURE.field_vectors.length >= 6, 'the spec case list needs at least 6 field vectors');
  for (const v of FIXTURE.field_vectors) {
    assert.equal(e2e.e2eAad(v.channel_id, v.correlation_id, v.field_name), v.aad, `${v.name}: AAD construction`);
    const nonce = Buffer.from(v.nonce_b64url, 'base64url');
    assert.equal(e2e.e2eEncryptField(KEY, v.aad, v.plaintext, nonce), v.envelope, `${v.name}: encrypt must be byte-identical`);
    assert.equal(e2e.e2eDecryptField(KEY, v.aad, v.envelope), v.plaintext, `${v.name}: decrypt round-trip`);
  }
  // The contract's "markdown longo" case must genuinely exceed 10 KB.
  const long = FIXTURE.field_vectors.find((v) => v.name === 'long-markdown');
  assert.ok(Buffer.byteLength(long.plaintext, 'utf8') > 10 * 1024, 'long-markdown must be >10 KB');
});

test('blob vector round-trips through the binary framing [0x01][nonce][ct][tag]', () => {
  for (const v of FIXTURE.blob_vectors) {
    const plain = Buffer.from(v.plaintext_b64url, 'base64url');
    assert.equal(require('node:crypto').createHash('sha256').update(plain).digest('hex'),
      v.plaintext_sha256_hex, `${v.name}: fixture blob bytes are self-consistent`);
    const nonce = Buffer.from(v.nonce_b64url, 'base64url');
    const framed = e2e.e2eEncryptBlob(KEY, v.aad, plain, nonce);
    assert.equal(framed.toString('base64url'), v.framed_b64url, `${v.name}: framing must be byte-identical`);
    assert.equal(framed[0], 0x01, `${v.name}: version byte`);
    assert.ok(e2e.e2eDecryptBlob(KEY, v.aad, framed).equals(plain), `${v.name}: decrypt round-trip`);
  }
});

test('failure cases from the fixture all fail LOUD (wrong AAD, corrupted tag, unknown version, bad base64)', () => {
  const f = FIXTURE.failure_cases;
  assert.throws(() => e2e.e2eDecryptField(KEY, f.wrong_aad.aad, f.wrong_aad.envelope),
    /failed to authenticate/, 'wrong AAD must fail the tag (anti-swap)');
  assert.throws(() => e2e.e2eDecryptField(KEY, f.corrupted_tag.aad, f.corrupted_tag.envelope),
    /failed to authenticate/, 'a bit-flipped tag must fail');
  assert.throws(() => e2e.e2eDecryptField(KEY, f.unknown_version.aad, f.unknown_version.envelope),
    /unknown e2e envelope version "v9"/, 'v9: must produce a PRECISE version error');
  assert.throws(() => e2e.e2eDecryptField(KEY, f.invalid_base64.aad, f.invalid_base64.envelope),
    /invalid base64url/, 'mangled base64url must fail as an encoding error');
  assert.throws(() => e2e.e2eDecryptBlob(KEY, f.blob_unknown_version.aad,
    Buffer.from(f.blob_unknown_version.framed_b64url, 'base64url')),
  /unknown e2e blob version 0x09/, 'blob version byte 0x09 must produce a version error');
  // And a plain non-envelope string names the missing prefix.
  assert.throws(() => e2e.e2eDecryptField(KEY, 'ch1:x:title', 'not an envelope'), /missing "v1:" prefix/);
});

test('kf — fingerprints match the fixture and a wrong key is DETECTABLE before decrypting', () => {
  assert.equal(e2e.e2eKeyFingerprint(KEY), FIXTURE.kf);
  assert.equal(e2e.e2eKeyFingerprint(WRONG_KEY), FIXTURE.wrong_key_kf);
  assert.notEqual(FIXTURE.kf, FIXTURE.wrong_key_kf, 'the mismatch must be detectable');
  assert.match(FIXTURE.kf, /^[A-Za-z0-9_-]{6}$/, '4 bytes → 6 base64url chars, unpadded');
  // The failure the kf exists to catch: decrypting with the other channel's key.
  const v = FIXTURE.field_vectors[0];
  assert.throws(() => e2e.e2eDecryptField(WRONG_KEY, v.aad, v.envelope), /failed to authenticate/);
});

test('production path — a RANDOM nonce per envelope: same input twice ⇒ different envelopes, both decrypt', () => {
  const aad = e2e.e2eAad(42, 'cid-random-nonce', 'body');
  const a = e2e.e2eEncryptField(KEY, aad, 'segredo do agente');
  const b = e2e.e2eEncryptField(KEY, aad, 'segredo do agente');
  assert.match(a, /^v1:[A-Za-z0-9_-]+$/);
  assert.notEqual(a, b, 'nonce must be random when not injected — envelopes never repeat');
  assert.equal(e2e.e2eDecryptField(KEY, aad, a), 'segredo do agente');
  assert.equal(e2e.e2eDecryptField(KEY, aad, b), 'segredo do agente');
  const blobA = e2e.e2eEncryptBlob(KEY, aad, Buffer.from([1, 2, 3]));
  const blobB = e2e.e2eEncryptBlob(KEY, aad, Buffer.from([1, 2, 3]));
  assert.notEqual(blobA.toString('base64url'), blobB.toString('base64url'));
  assert.ok(e2e.e2eDecryptBlob(KEY, aad, blobA).equals(Buffer.from([1, 2, 3])));
});

test('guardrails — bad key/nonce sizes are named errors, not OpenSSL stack traces', () => {
  const aad = 'ch1:x:title';
  assert.throws(() => e2e.e2eEncryptField(Buffer.alloc(16), aad, 'x'), /32-byte Buffer/);
  assert.throws(() => e2e.e2eEncryptField('not-a-buffer', aad, 'x'), /32-byte Buffer/);
  assert.throws(() => e2e.e2eEncryptField(KEY, aad, 'x', Buffer.alloc(8)), /12-byte Buffer/);
  assert.throws(() => e2e.e2eDecryptField(KEY, aad, 'v1:AAAA'), /too short/);
  assert.throws(() => e2e.e2eEncryptBlob(KEY, aad, 'not-a-buffer'), /must be a Buffer/);
  assert.throws(() => e2e.e2eDecryptBlob(KEY, aad, Buffer.alloc(4)), /too short/);
  assert.throws(() => e2e.e2eAad(undefined, 'cid', 'title'), /channel_id/);
  assert.throws(() => e2e.e2eAad(1, '', 'title'), /correlation_id/);
  assert.throws(() => e2e.e2eAad(1, 'cid', ''), /field_name/);
});

// --- e2eLoadSecret — the PIDGE_TOKEN slot/precedence, for the secret ---------
// Each case runs in a fresh child process (the config file is read at module
// load, like the TOKEN) with a controlled env — exactly how the CLI runs.

function loadSecretVia(env, home) {
  const r = spawnSync(process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify(require(process.argv[1]).e2eLoadSecret()))', CLI],
    { env: { PATH: process.env.PATH, HOME: home, ...env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('e2eLoadSecret — env var wins over the config file; file is the fallback; nothing set ⇒ null', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-e2e-'));
  const xdg = path.join(home, '.config');
  fs.mkdirSync(path.join(xdg, 'pidge'), { recursive: true });
  fs.writeFileSync(path.join(xdg, 'pidge', 'env'), 'PIDGE_TOKEN=hld_x\nPIDGE_SECRET=file-secret\n');

  assert.equal(loadSecretVia({ XDG_CONFIG_HOME: xdg }, home), 'file-secret', 'config file is the fallback slot');
  assert.equal(loadSecretVia({ XDG_CONFIG_HOME: xdg, PIDGE_SECRET: 'env-secret' }, home), 'env-secret', 'explicit env var always wins');
  assert.equal(loadSecretVia({ XDG_CONFIG_HOME: path.join(home, 'empty') }, home), null, 'no env + no file ⇒ null');
});

test('e2eLoadSecret — PIDGE_AGENT isolates the slot (agents/<id>/env), never the shared file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pidge-e2e-agent-'));
  const xdg = path.join(home, '.config');
  fs.mkdirSync(path.join(xdg, 'pidge', 'agents', 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(xdg, 'pidge', 'env'), 'PIDGE_SECRET=shared-secret\n');
  fs.writeFileSync(path.join(xdg, 'pidge', 'agents', 'alpha', 'env'), 'PIDGE_SECRET=alpha-secret\n');

  assert.equal(loadSecretVia({ XDG_CONFIG_HOME: xdg, PIDGE_AGENT: 'alpha' }, home), 'alpha-secret', 'per-agent file is THE slot when PIDGE_AGENT is set');
  assert.equal(loadSecretVia({ XDG_CONFIG_HOME: xdg, PIDGE_AGENT: 'beta' }, home), null, 'an agent with no file must NOT inherit the shared secret (hijack guard)');
  assert.equal(loadSecretVia({ XDG_CONFIG_HOME: xdg }, home), 'shared-secret', 'no PIDGE_AGENT ⇒ the legacy shared file');
});
