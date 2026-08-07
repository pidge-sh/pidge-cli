'use strict';
// Pidge Terminals — the mirror's wire layer (Phase B, spec §19). PURE helpers
// only (no I/O, no process state): tmux control-mode byte decoding, the output
// chunker, tmux quoting, the per-mode key allowlists and the geometry clamps.
// Everything here is directly unit-testable.
//
// RECOVERED VERBATIM from the retired 0.37.1 arc (`src/terminal/wire.js` @
// acdd106) — the paid-for parts, minus everything the Phase B encaixe made
// obsolete. What did NOT come back, and why:
//   · sealFrame/openFrame/openViewerFrame — the four `terminal_*` AAD lanes are
//     RETIRED FOREVER (spec §19). Output/seed now ride ONE new lane,
//     `pane_output`, sealed by the daemon's own envelope machinery
//     (core.e2eEncryptBlob + core.e2eAad, base64url — the same bytes every
//     other lane on this socket uses).
//   · createLedger — the daemon already owns the replay guard (§8/B4: vgen +
//     per-(share,vgen) monotonic seq + the mandatory `he` epoch echo). Phase B
//     adds `reseed`/`resize` as ADDITIVE frame types on the EXISTING
//     `agent_input` lane, so they pass through that one ledger and no second
//     one exists to disagree with it.
//   · keysToTmuxCommands — keystrokes no longer travel through the control
//     connection. The daemon delivers them with core.tmuxExec (synchronous by
//     construction, so the old inputChain's ordering guarantee is structural
//     here instead of chained).
//
// FRAME CONTRACT (spec §19, re-pinned from the proven old-arc wire; the
// fixture rows `pane-output-seed` / `pane-output-o` in test/e2e_vectors.json
// ARE the contract):
//   daemon → viewers, lane `pane_output`, anchor = the pane share's public_id
//     { t:"o",    epoch, seq, data:"<b64 raw bytes>" }        live output
//     { t:"seed", epoch, seq, cols, rows, data:"<b64>" }      full repaint
//   viewers → daemon, lane `agent_input` (EXISTING; additive types)
//     { t:"reseed", vgen, seq, he }
//     { t:"resize", vgen, seq, he, cols, rows }
// `epoch` is the daemon epoch the input lane already echoes; any (epoch,seq)
// gap on the viewer means "send t:reseed", NEVER a server-side buffer (#7's
// DNA — the WS is not a ledger).
// EVOLUTION IS ADDITIVE: an unknown `t` is ignored, unknown fields inside a
// known frame are ignored — a newer peer never breaks an older one (§12).

// The lane name (append-only registry — media-e2e-spec §2; never rename).
const PANE_OUTPUT_FIELD = 'pane_output';

// Live-output ceiling per frame: ≤16 KB of RAW bytes, so base64 + JSON + the
// sealed envelope stay far under the relay's per-frame cap. The relay cap
// itself is read from the live manifest (`agent_sessions.limits.
// pane_output_frame_max_bytes`); this is the protocol's own chunk size.
const DATA_MAX_BYTES = 16 * 1024;

// The §8 allowlist, unchanged: what a viewer may send to an AGENT pane. The
// composer is the primary surface; the arrows exist for Claude's `❯ 1./2.`
// permission menus. Anything outside is dropped WHOLE.
const AGENT_KEYS = new Set(['Enter', 'Escape', 'Up', 'Down', 'Tab', 'BTab', 'C-c']);

// The TERM extension (spec §19): a shell needs more than a transcript does —
// line editing, paging, job control, a clear. Proven in the old arc, restored
// verbatim. The decision is made by the share's CURRENT `mode` and nothing
// else: a raw peek at an AGENT pane does NOT extend the set (the composer is
// the one surface, a Claude has no use for C-z, and if the mode is wrong the
// §16 ladder is what fixes it — not the key set).
const TERM_KEYS = new Set([
  ...AGENT_KEYS,
  'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'DC', 'BSpace',
  'C-d', 'C-u', 'C-r', 'C-z', 'C-l',
]);

// `mode` is the CLEAR occupant column (§16). Anything that is not literally
// "term" gets the smaller set — an unknown/absent mode must never widen what a
// viewer may push into a pane (fail closed).
function keysForMode(mode) {
  return mode === 'term' ? TERM_KEYS : AGENT_KEYS;
}

// Geometry clamps, inherited: a viewer may not ask for a grid tmux would choke
// on, and a NaN must land somewhere sane rather than propagate.
function clampCols(v) { return Math.min(500, Math.max(20, parseInt(v, 10) || 0)); }
function clampRows(v) { return Math.min(300, Math.max(5, parseInt(v, 10) || 0)); }

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

// Split a raw output buffer into ≤max-byte chunks (the coalescer flushes one
// frame per chunk — a burst bigger than one frame becomes N well-formed
// frames). A non-positive `max` (a bad manifest-derived limit) must never make
// the loop stall forever — floor the step at the protocol chunk size.
function chunkBytes(buf, max = DATA_MAX_BYTES) {
  const step = max > 0 ? max : DATA_MAX_BYTES;
  const chunks = [];
  for (let off = 0; off < buf.length; off += step) chunks.push(buf.subarray(off, off + step));
  return chunks;
}

// tmux command-line quoting for one control-mode argument: single-quote wrap
// with the '\'' splice. tmux's parser honors it like a shell, and single quotes
// suppress every other expansion. Newlines can NEVER ride a control-mode
// command line — control.js refuses a command containing one rather than
// truncating the protocol.
function tmuxQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

module.exports = {
  PANE_OUTPUT_FIELD, DATA_MAX_BYTES,
  AGENT_KEYS, TERM_KEYS, keysForMode,
  clampCols, clampRows,
  unescapeOctal, chunkBytes, tmuxQuote,
};
