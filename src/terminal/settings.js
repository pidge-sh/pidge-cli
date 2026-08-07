'use strict';
// Machine-level knobs — the ops file, owned by the human, never the server.
//
//   # ~/.config/pidge/terminal.toml
//   mirror_idle_ms = 300000   # stand the mirror down this long after the last
//                             # inbound frame from the pane's viewers (5 min)
//   nudge_ms       = 500      # debounce before the post-resize repaint jiggle;
//                             # 0 disables the nudge entirely
//
// The parser is a deliberate TOML SUBSET (comments, top-level `key = <int>`),
// inherited from the retired arc's spawn-profile whitelist: an ops file wants
// boring, reviewable syntax, and a full TOML dependency would be this CLI's
// first one. Unknown keys and whole `[sections]` are IGNORED (additive
// evolution); a malformed line is a WARNING, never a crash — a typo in a
// comfort knob must not take the daemon down.
//
// The path is MACHINE level on purpose (the base pidge dir, not the per-tunnel
// terminal dir): how this computer's mirror behaves is one human decision.

const fs = require('node:fs');
const path = require('node:path');

// Every knob: default + the clamp that keeps a typo from being a weapon.
const KNOBS = {
  // 5 minutes (design §2 (c)): the sliding presence window per share. Re-attach
  // is cheap and a reseed cures everything, so erring toward standing down
  // early is safe by construction (§19).
  mirror_idle_ms: { def: 5 * 60_000, min: 10_000, max: 6 * 3600_000 },
  // 0 = OFF (a deliberate, documented value — not a clamp floor).
  nudge_ms: { def: 500, min: 0, max: 30_000 },
};

// → { settings: {mirror_idle_ms, nudge_ms}, warnings: [string] }
function parseSettings(text) {
  const warnings = [];
  const found = {};
  let inSection = false; // a foreign [section] swallows everything until the next one
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) { inSection = true; continue; } // foreign section — skipped whole
    if (inSection) continue;
    const eq = line.indexOf('=');
    if (eq < 1) { warnings.push(`line ${i + 1}: not a key = value pair — skipped`); continue; }
    const key = line.slice(0, eq).trim();
    if (!Object.hasOwn(KNOBS, key)) continue; // unknown key — additive, ignored in silence
    const raw = line.slice(eq + 1).replace(/\s+#.*$/, '').trim();
    if (!/^-?\d+$/.test(raw)) { warnings.push(`line ${i + 1}: ${key} must be a plain integer (got ${JSON.stringify(raw)}) — using the default`); continue; }
    const n = parseInt(raw, 10);
    const { min, max } = KNOBS[key];
    if (n < min || n > max) {
      warnings.push(`line ${i + 1}: ${key} = ${n} is outside ${min}…${max} — clamped`);
      found[key] = Math.min(max, Math.max(min, n));
      continue;
    }
    found[key] = n;
  }
  const settings = {};
  for (const [k, v] of Object.entries(KNOBS)) settings[k] = Object.hasOwn(found, k) ? found[k] : v.def;
  return { settings, warnings };
}

function settingsPath(baseDir) {
  return path.join(baseDir, 'terminal.toml');
}

function loadSettings(baseDir) {
  const file = settingsPath(baseDir);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { ...parseSettings(''), file, missing: true }; }
  return { ...parseSettings(text), file, missing: false };
}

module.exports = { KNOBS, parseSettings, loadSettings, settingsPath };
