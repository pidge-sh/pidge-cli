'use strict';
// Pidge Terminal — the wire layer, PURE helpers only (no I/O, no process
// state): frame builders/parsers, the sealed-envelope glue and the tmux
// control-mode byte decoding. Everything here is directly unit-testable.
//
// FRAME CONTRACT (the "Wire form" pinned in the terminal spec §4; shared with
// the server relay and the iOS/Mac viewers):
//   Every frame is a JSON object sealed WHOLE with the BLOB framing
//   (`[0x01][nonce12][ct][tag16]`, AES-256-GCM) and rides the cable as
//   STANDARD base64 (padded, `+/` — NOT base64url). The viewer decodes with a
//   strict standard-base64 reader; base64url would fail to open and degrade to
//   a reseed loop. One encoding end to end — the inner `data` payload of
//   o/seed frames is standard base64 too.
//   Per-DIRECTION AAD field names kill reflection (a relay re-presenting host
//   output as viewer input authenticates in no slot); the AAD anchor is the
//   public_id of the session whose streams carry the frame.
//   Host → viewer (`terminal_output`):
//     { t:"o",    epoch, seq, data:<base64 raw bytes> }       live output
//     { t:"seed", epoch, seq, cols, rows, data:<base64> }     full repaint
//   Viewer → host (`terminal_input`):
//     { t:"i", vgen, seq, keys:[ {lit:"ls"}, {key:"Enter"} ] }
//   Viewer → host control (`terminal_ctrl_viewer`) — reseed/resize may ROAM
//   onto a mirrored session's own :in stream (anchor = that session's
//   public_id) so a wrapper/attach host with no control lane still heals:
//     { t:"reseed", vgen, seq, pid }
//     { t:"resize", vgen, seq, pid, cols, rows }
//   VGEN: every viewer→host frame carries a viewer-minted `vgen` ([a-z0-9]{8,},
//   fresh per subscription) inside the ciphertext; the host ledgers `seq` per
//   (session, AAD field, vgen). A frame without a valid vgen, or one that does
//   not strictly advance its vgen's ledger, is DROPPED (replay guard). Join
//   pings never touch the ledger — they are unsealed and server-forgeable.
//   EVOLUTION IS ADDITIVE: unknown `t` ⇒ ignore the frame; unknown fields
//   inside a known frame ⇒ ignore the field. A newer peer never breaks an
//   older one — enforced here by parsing only what we know.

// The e2e crypto is the CLI's existing, test-vectored machinery — the test
// seam in bin/pidge.js exports the pure helpers when require()d (the CLI
// itself never runs under require). Terminal frames use the BLOB framing
// (`[0x01][nonce12][ct][tag16]`, standard base64 — see sealFrame), NOT the
// field-envelope string (`"v1:"` + base64url); that is the wire the iOS/Mac
// viewers decode with a STRICT standard-base64 reader.
const { e2eAad, e2eEncryptBlob, e2eDecryptBlob } = require('../../bin/pidge.js');

// Per-direction AAD field names (append-only registry — never rename).
const AAD_OUTPUT = 'terminal_output';       // host → viewer (output/seed)
const AAD_INPUT = 'terminal_input';         // viewer → host (input frames)
const AAD_CTRL_HOST = 'terminal_ctrl_host'; // host → viewer, control lane
const AAD_CTRL_VIEWER = 'terminal_ctrl_viewer'; // viewer → host, control lane

// The CLOSED set of special-key tokens a viewer may send (defense in depth —
// the viewer app never generates others; anything outside is DROPPED, never
// forwarded to tmux). Names are tmux `send-keys` tokens verbatim.
const ALLOWED_KEYS = new Set([
  'Enter', 'Escape', 'Tab', 'BTab', 'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PageUp', 'PageDown', 'DC', 'BSpace',
  'C-c', 'C-d', 'C-u', 'C-r', 'C-z', 'C-l',
]);

// Live-output ceiling per frame: ≤16 KB of raw bytes (base64 + JSON + the
// envelope stay far under the relay's frame cap). The relay cap is read from
// the live manifest at startup; this is the protocol's own chunk size.
const DATA_MAX_BYTES = 16 * 1024;

// tmux -C octal-escapes %output payloads: bytes < 0x20, non-ASCII and the
// backslash ride as \NNN (octal). The payload is BYTES, not UTF-8 — unescape
// FIRST, decode (if ever) later. `\\` is tolerated too, defensively: the
// escaping tmux applies is version-dependent detail, and a lone backslash
// followed by non-octal passes through as-is rather than being eaten.
function unescapeOctal(s) {
  const out = Buffer.alloc(s.length);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      const oct = s.slice(i + 1, i + 4);
      if (/^[0-7]{3}$/.test(oct)) {
        out[n++] = parseInt(oct, 8);
        i += 3;
        continue;
      }
      if (s[i + 1] === '\\') {
        out[n++] = 0x5c;
        i += 1;
        continue;
      }
    }
    out[n++] = s.charCodeAt(i) & 0xff;
  }
  return out.subarray(0, n);
}

// Seal one frame object for the wire: blob framing → STANDARD base64 (padded).
// `.toString('base64')` is standard (not base64url), matching the viewer's
// strict `Data(base64Encoded:)` reader byte-for-byte.
function sealFrame(key, channelId, publicId, aadField, frame) {
  const blob = e2eEncryptBlob(key, e2eAad(channelId, publicId, aadField), Buffer.from(JSON.stringify(frame), 'utf8'));
  return blob.toString('base64');
}

// Open one inbound `data` string (standard base64 of the blob). Returns the
// parsed frame object, or null (bad base64 / wrong key/AAD / not a JSON object)
// — the caller narrates, never throws: a hostile or corrupt frame must never
// kill the mirror.
function openFrame(key, channelId, publicId, aadField, data) {
  try {
    const blob = Buffer.from(String(data), 'base64');
    const plain = e2eDecryptBlob(key, e2eAad(channelId, publicId, aadField), blob);
    const frame = JSON.parse(plain.toString('utf8'));
    return frame && typeof frame === 'object' ? frame : null;
  } catch {
    return null;
  }
}

// Open a viewer→host frame on a mirrored session's :in stream, which carries
// BOTH keystroke frames (`terminal_input`) and ROAMING control frames
// (`terminal_ctrl_viewer` — reseed/resize, anchored on THIS session's id).
// Try input first, then ctrl_viewer; returns { frame, field } or null. The
// field is what the caller keys its per-vgen seq ledger on.
function openViewerFrame(key, channelId, publicId, data) {
  const asInput = openFrame(key, channelId, publicId, AAD_INPUT, data);
  if (asInput) return { frame: asInput, field: AAD_INPUT };
  const asCtrl = openFrame(key, channelId, publicId, AAD_CTRL_VIEWER, data);
  if (asCtrl) return { frame: asCtrl, field: AAD_CTRL_VIEWER };
  return null;
}

// A vgen is a viewer-minted random token, [a-z0-9] and ≥8 chars (iOS mints 12).
const VGEN_RE = /^[a-z0-9]{8,}$/;
function isValidVgen(v) { return typeof v === 'string' && VGEN_RE.test(v); }

// The viewer→host replay guard (spec §3/§4): a per-(field, vgen) monotonic
// `seq` ledger with a small LRU of recent vgens. `accept(field, vgen, seq)`
// returns true exactly once per strictly-increasing seq within a vgen; a frame
// with no valid vgen, a non-integer/≤0 seq, or a seq that doesn't advance its
// vgen's ledger is rejected. A reconnecting viewer mints a NEW vgen and
// restarts at 1 (a fresh ledger entry). The LRU bounds memory; an evicted
// vgen's very-old replay could re-open, the documented tail risk (≥4 kept).
function createLedger(cap = 8) {
  const seqs = new Map(); // `${field}\0${vgen}` → lastSeq, insertion-ordered (LRU)
  return {
    accept(field, vgen, seq) {
      if (!isValidVgen(vgen)) return false;
      if (!Number.isInteger(seq) || seq < 1) return false;
      const k = `${field}\0${vgen}`;
      const last = seqs.get(k);
      if (last !== undefined && seq <= last) return false;
      seqs.delete(k);            // refresh LRU recency
      seqs.set(k, seq);
      while (seqs.size > cap) seqs.delete(seqs.keys().next().value);
      return true;
    },
  };
}

// Split a raw output buffer into ≤max-byte chunks (the coalescer flushes one
// frame per chunk — a burst bigger than one frame becomes N well-formed frames).
// A non-positive `max` (a bad manifest-derived limit) must never make the loop
// stall forever — floor the step at the protocol chunk size.
function chunkBytes(buf, max = DATA_MAX_BYTES) {
  const step = max > 0 ? max : DATA_MAX_BYTES;
  const chunks = [];
  for (let off = 0; off < buf.length; off += step) chunks.push(buf.subarray(off, off + step));
  return chunks;
}

// Validate + normalize one viewer key entry. Returns
//   { lit: "<text>" }  — literal text, control bytes stripped (specials must
//                        arrive as {key} tokens; a stray \n/\r is honored as
//                        the Enter the sender meant)
//   { key: "<token>" } — a whitelisted special key
//   null               — malformed / not allowed ⇒ DROP silently by contract.
function normalizeKeyEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.key === 'string') return ALLOWED_KEYS.has(entry.key) ? { key: entry.key } : null;
  if (typeof entry.lit === 'string') {
    // Cap pathological literals (a keystroke frame is small by construction).
    const lit = entry.lit.slice(0, 4096);
    return { lit };
  }
  return null;
}

// tmux command-line quoting for a literal send-keys argument: single-quote
// wrap with the '\'' splice. tmux's parser honors it like a shell, and single
// quotes suppress every other expansion. Newlines can NEVER ride a control-
// mode command line — callers split literals on \r?\n and send Enter between.
function tmuxQuote(s) {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Translate one input frame's keys[] into tmux control-mode command lines.
// Literal text goes through `send-keys -l` in its OWN command (so the -l can
// never eat a special token); special keys ride bare in a separate send-keys.
// Embedded newlines in a literal become Enter (the line protocol can't carry
// them). Returns the array of command strings, disallowed entries dropped.
function keysToTmuxCommands(target, keys) {
  const cmds = [];
  if (!Array.isArray(keys)) return cmds;
  const t = tmuxQuote(target);
  for (const raw of keys) {
    const entry = normalizeKeyEntry(raw);
    if (!entry) continue;
    if (entry.key) {
      cmds.push(`send-keys -t ${t} -- ${entry.key}`);
      continue;
    }
    const segments = entry.lit.split(/\r\n|\r|\n/);
    segments.forEach((seg, i) => {
      // Strip the remaining C0 controls: specials belong in {key} tokens, and
      // a raw control byte inside a quoted tmux argument is undefined ground.
      const clean = seg.replace(/[\u0000-\u001f\u007f]/g, '');
      if (clean) cmds.push(`send-keys -t ${t} -l -- ${tmuxQuote(clean)}`);
      if (i < segments.length - 1) cmds.push(`send-keys -t ${t} -- Enter`);
    });
  }
  return cmds;
}

module.exports = {
  AAD_OUTPUT, AAD_INPUT, AAD_CTRL_HOST, AAD_CTRL_VIEWER,
  ALLOWED_KEYS, DATA_MAX_BYTES,
  unescapeOctal, sealFrame, openFrame, openViewerFrame, chunkBytes,
  isValidVgen, createLedger,
  normalizeKeyEntry, tmuxQuote, keysToTmuxCommands,
};
