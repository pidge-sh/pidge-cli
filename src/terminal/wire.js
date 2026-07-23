'use strict';
// Pidge Terminal — the wire layer, PURE helpers only (no I/O, no process
// state): frame builders/parsers, the sealed-envelope glue and the tmux
// control-mode byte decoding. Everything here is directly unit-testable.
//
// FRAME CONTRACT (shared with the server relay and the viewer apps; the live
// manifest's `terminal` section is the served copy):
//   Every frame is a JSON object sealed WHOLE into one field envelope
//   ("v1:" + base64url(nonce||ct||tag)) — the exact machinery notifications
//   already use — and rides the cable as an opaque `data` string the relay
//   never reads. Per-DIRECTION AAD field names kill reflection (a relay
//   re-presenting host output as viewer input authenticates in no slot);
//   the AAD anchor is the session's public_id, minted by the host BEFORE
//   anything is sealed.
//   Host → viewer (`terminal_output`):
//     { t:"o",    epoch, seq, data:<base64 raw bytes> }       live output
//     { t:"seed", epoch, seq, cols, rows, data:<base64> }     full repaint
//   Viewer → host (`terminal_input`):
//     { t:"i",      seq, keys:[ {lit:"ls"}, {key:"Enter"} ] }
//     { t:"reseed", seq }                                     repaint request
//     { t:"resize", seq, cols, rows }
//   EVOLUTION IS ADDITIVE: unknown `t` ⇒ ignore the frame; unknown fields
//   inside a known frame ⇒ ignore the field. A newer peer never breaks an
//   older one — enforced here by parsing only what we know.

// The e2e crypto is the CLI's existing, test-vectored machinery — the test
// seam in bin/pidge.js exports the pure helpers when require()d (the CLI
// itself never runs under require).
const { e2eAad, e2eEncryptField, e2eDecryptField } = require('../../bin/pidge.js');

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

// Seal one frame object for the wire. Returns the opaque `data` string.
function sealFrame(key, channelId, publicId, aadField, frame) {
  return e2eEncryptField(key, e2eAad(channelId, publicId, aadField), JSON.stringify(frame));
}

// Open one inbound `data` string. Returns the parsed frame object, or null
// (bad envelope / wrong key / not JSON) — the caller narrates, never throws:
// a hostile or corrupt frame must never kill the mirror.
function openFrame(key, channelId, publicId, aadField, data) {
  try {
    const plain = e2eDecryptField(key, e2eAad(channelId, publicId, aadField), data);
    const frame = JSON.parse(plain);
    return frame && typeof frame === 'object' ? frame : null;
  } catch {
    return null;
  }
}

// Split a raw output buffer into ≤max-byte chunks (the coalescer flushes one
// frame per chunk — a burst bigger than one frame becomes N well-formed frames).
function chunkBytes(buf, max = DATA_MAX_BYTES) {
  const chunks = [];
  for (let off = 0; off < buf.length; off += max) chunks.push(buf.subarray(off, off + max));
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
  unescapeOctal, sealFrame, openFrame, chunkBytes,
  normalizeKeyEntry, tmuxQuote, keysToTmuxCommands,
};
