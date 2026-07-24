'use strict';
// Spawn profiles — the whitelist that lives ON THE MACHINE, never server-side.
// A viewer can only ever NAME a profile; the command line, cwd and everything
// executable exist only in this file, owned by the human:
//
//   # ~/.config/pidge/terminal.toml
//   [[profile]]
//   name = "Claude @ my-project"
//   cwd  = "~/Projects/my-project"
//   cmd  = "claude"
//
// The parser is a deliberate TOML SUBSET (comments, [[profile]] tables,
// key = "basic" | 'literal' strings): a whitelist wants boring, reviewable
// syntax, and a full TOML dependency would be this CLI's first one. Unknown
// keys and sections are IGNORED (additive evolution); malformed lines are
// collected as warnings, never a crash — a typo must not take the daemon down.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KNOWN_KEYS = new Set(['name', 'cwd', 'cmd']);

function unquoteValue(raw) {
  const s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    // basic string: the escapes that matter for paths/commands
    return s.slice(1, -1).replace(/\\(["\\nrt])/g, (_, c) => ({ '"': '"', '\\': '\\', n: '\n', r: '\r', t: '\t' }[c]));
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1); // literal string: no escapes
  }
  return null; // only strings are meaningful here
}

// → { profiles: [{name, cwd?, cmd}], warnings: [string] }
function parseProfiles(text) {
  const profiles = [];
  const warnings = [];
  let current = null; // the [[profile]] being filled, or null (outside)
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/^\s+|\s+$/g, '');
    if (!line || line.startsWith('#')) continue;
    if (/^\[\[\s*profile\s*\]\]$/.test(line)) {
      current = {};
      profiles.push(current);
      continue;
    }
    if (line.startsWith('[')) { current = null; continue; } // foreign section — skip it whole
    if (!current) continue;
    const eq = line.indexOf('=');
    if (eq < 1) { warnings.push(`line ${i + 1}: not a key = "value" pair — skipped`); continue; }
    const key = line.slice(0, eq).trim();
    if (!KNOWN_KEYS.has(key)) continue; // unknown key — additive, ignored
    const value = unquoteValue(line.slice(eq + 1).replace(/\s+#.*$/, ''));
    if (value === null) { warnings.push(`line ${i + 1}: ${key} must be a quoted string — skipped`); continue; }
    current[key] = value;
  }
  const valid = [];
  const seen = new Set();
  for (const p of profiles) {
    if (!p.name || !p.cmd) { warnings.push(`a [[profile]] without both name and cmd was skipped`); continue; }
    if (seen.has(p.name)) { warnings.push(`duplicate profile name ${JSON.stringify(p.name)} — first one wins`); continue; }
    seen.add(p.name);
    valid.push(p);
  }
  return { profiles: valid, warnings };
}

// The whitelist path is MACHINE-level on purpose (the base pidge dir, never
// the per-agent scope): what may be spawned on this machine is one human
// decision, not a per-agent one.
function profilesPath(baseDir) {
  return path.join(baseDir, 'terminal.toml');
}

function loadProfiles(baseDir) {
  const file = profilesPath(baseDir);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { profiles: [], warnings: [], file, missing: true }; }
  return { ...parseProfiles(text), file, missing: false };
}

// ~ expansion for the profile's cwd (the daemon runs from launchd — no shell).
function expandTilde(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

module.exports = { parseProfiles, loadProfiles, profilesPath, expandTilde };
