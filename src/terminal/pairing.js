'use strict';
// Pairing v2 — the QR payload of `pidge terminal connect --qr`
// (agent-sessions-spec §24.1). The payload IS a wire contract: this builder
// and the iOS parser both assert the shared fixture
// test/pairing_qr_vectors.json (canonical home server/test/fixtures/) —
// the #67 cross-wire guard. The version segment sits OUTSIDE the base64 so
// an unknown version dispatches to an honest "update the app" error before
// any decode; unknown JSON keys are IGNORED by parsers (§12 additive
// evolution). The payload carries K — it is a SECRET: it exists only to be
// rendered as a QR, is never logged, and never persists anywhere.

const core = require('./core');

const PAIR_QR_PREFIX = 'pidge-pair:v1:';

// The loopback hosts the http carve-out below recognises. STRUCTURAL by
// design: only literal loopback addresses and the one name the resolver
// stack is required to map to them — never a DNS name that could merely
// resolve to 127.0.0.1 today (that is the rebinding hole this list exists to
// stay out of). Stored lowercase; the caller lowercases the host it tests.
const LOOPBACK_HOSTS = new Set([
  '127.0.0.1',
  'localhost',
  '[::1]',                 // the IPv6 loopback, in URL bracket form
  '[::ffff:127.0.0.1]',    // …and its IPv4-mapped spelling
]);

// Split an authority into host + port, IPv6 brackets included. Returns null
// for anything that is not a bare host[:port] — userinfo above all: a
// `http://localhost@evil.example/` must never read as loopback.
function splitAuthority(authority) {
  if (authority.includes('@')) return null;
  let host = authority;
  let port = '';
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end === -1) return null;
    port = host.slice(end + 1);
    host = host.slice(0, end + 1);
  } else {
    const colon = host.lastIndexOf(':');
    if (colon !== -1) { port = host.slice(colon); host = host.slice(0, colon); }
  }
  if (port !== '' && !/^:\d+$/.test(port)) return null;
  return { host, port };
}

// https only, with ONE carve-out: loopback http, for the mock-server tests
// and local dev servers. (The PHONE refuses every http base_url per §24.1 —
// a loopback QR is only ever scanned by test tooling, never by the app.)
//
// Scheme and host are compared case-INSENSITIVELY because that is what they
// are (RFC 3986 §3.1/§6.2.2.1) — `HTTP://LOCALHOST:3000` names the same
// server as the documented spelling, and refusing it only ever cost a
// developer their afternoon. The rest of the URL is left alone: only the two
// case-insensitive components get folded. The failure direction never
// changes — a host outside the literal set is refused, never accepted.
function pairingBaseUrlOk(baseUrl) {
  const url = String(baseUrl || '');
  if (/\s/.test(url) || url === '') return false;
  const m = url.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/);
  if (!m) return false;
  const scheme = m[1].toLowerCase();
  const rest = m[2];
  if (scheme === 'https') return rest.length > 0;
  if (scheme !== 'http') return false;
  const slash = rest.indexOf('/');
  const authority = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
  if (/[?#]/.test(authority)) return false;
  const split = splitAuthority(authority);
  return !!split && LOOPBACK_HOSTS.has(split.host);
}

// The parser side (§24.1) refuses host/os that are not DISPLAY-SAFE (>64
// chars, control/newline/bidi scalars — the confirm screen is the security
// boundary). This side simply never emits what that side refuses: strip the
// unsafe scalars, cap the length. A hostname that needed this was broken
// anyway; a QR that the phone is guaranteed to refuse must not be printed.
function displaySafe(text) {
  return Array.from(String(text))
    .filter((ch) => {
      const cp = ch.codePointAt(0);
      if (cp < 0x20 || cp === 0x7f) return false;                  // control
      if (cp >= 0x202a && cp <= 0x202e) return false;              // bidi embed/override
      if (cp >= 0x2066 && cp <= 0x2069) return false;              // bidi isolates
      return cp !== 0x200e && cp !== 0x200f && cp !== 0x061c;      // LRM/RLM/ALM
    })
    .slice(0, 64)
    .join('');
}

// → the exact `pidge-pair:v1:…` string. Field order (k, kf, host, os,
// base_url) is pinned by the fixture: iOS parses JSON and never cares, but
// the byte-for-byte fixture assertion needs ONE canonical serialization.
function buildPairingPayload({ key, host, os, baseUrl }) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('pairing payload needs the 32-byte computer key');
  const h = displaySafe(String(host || '').trim()).trim();
  if (!h) throw new Error('pairing payload needs a non-empty host');
  if (!os) throw new Error('pairing payload needs an os');
  const base = String(baseUrl || '').replace(/\/$/, '');
  if (!pairingBaseUrlOk(base)) {
    throw new Error(`pairing payload base_url must be https:// (got ${JSON.stringify(base)}) — the phone refuses http QR codes`);
  }
  const json = JSON.stringify({
    k: key.toString('base64url'),
    kf: core.e2eKeyFingerprint(key),
    host: h,
    os,
    base_url: base,
  });
  return PAIR_QR_PREFIX + Buffer.from(json, 'utf8').toString('base64url');
}

module.exports = { PAIR_QR_PREFIX, buildPairingPayload, pairingBaseUrlOk };
