'use strict';
// Agent Sessions v1 (pidge repo docs/agent-sessions-spec.md) — shared plumbing
// for the `pidge terminal` feature: the terminal-scoped config slot, the E2E
// primitives (kept byte-compatible with bin/pidge.js — verified by the shared
// vectors in test/), and the small HTTP helper. The terminal feature has its
// OWN identity slot (~/.config/pidge/terminal/) on purpose: the tunnel channel
// is machine-scoped, never project- or agent-scoped, and its {URL, TOKEN,
// SECRET} triple must survive any per-project setup the same machine runs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// --- the ONE enable door (HOOK CORRELATION, redesigned 2026-08-03) ----------
//
// There is exactly one way to share a session, and it is NOT a process-tree
// walk any more (that was structurally broken — Claude Code runs every Bash
// tool inside a ttyless shell wrapper whose command line mentions `.claude/`,
// so the walk stopped at the wrapper and refused on every machine; QA finding
// #7). The door now rides the hooks we already install:
//
//   human pastes ENABLE_PROMPT into the session they want to share
//     → claude runs ONE bash carrying the sentinel `pidge terminal enable`
//     → the PreToolUse hook fires BEFORE the command runs, carrying the
//       authoritative `session_id`
//     → the daemon enables THAT session and DENIES the tool, so the command
//       never executes (no PATH dependency — QA finding #8) and the outcome
//       reaches claude as the denial reason (no improvisation — finding #2).
//
// Consent is unchanged and hard: the human chooses which session by pasting
// into it, per session id (a new sid in the same pane is NOT auto-enabled).
const ENABLE_SENTINEL = 'pidge terminal enable';

// The exact text the app/CLI tells the human to paste (spec §2). It works in
// ANY claude — skill or not — because it constrains the agent to one harmless
// command and pre-empts the two ways it used to improvise.
const ENABLE_PROMPT =
  'Run exactly this one bash command and nothing else: `pidge terminal enable` — ' +
  'it signals a local Pidge daemon to mirror THIS Claude session to my phone. ' +
  "If the command isn't found, that's fine: a local hook already caught it. " +
  'Do not run any other command, do not go "online", do not read or ack any queue.';

// The PreToolUse response ALWAYS denies the sentinel tool (the bash is a
// carrier, never a command we want run) and carries the outcome as the reason —
// the only thing claude will read.
const ENABLE_OK_REASON =
  "✓ Pidge is now mirroring this Claude session to the human's phone. " +
  'This is expected — do NOT run any other command, do NOT go online, do NOT read or ack any queue.';
const ENABLE_NO_PANE_REASON =
  "Couldn't mirror this session: it isn't in a uniquely-identifiable tmux pane. " +
  'Start claude inside its own tmux pane and paste the command again. Do not run other commands.';
const ENABLE_NO_TRANSCRIPT_REASON =
  "Couldn't mirror this session: this computer has no transcript path for it. " +
  'Restart claude inside its own tmux pane and paste the command again. Do not run other commands.';

// What `pidge terminal enable` says when it is run OUTSIDE the door (a bare
// terminal, or a claude whose hooks are not installed): the command is a
// friendly CONFIRM now, never the mechanism.
const ENABLE_NOT_MIRRORED =
  'pidge terminal enable: nothing is being mirrored from this computer.\n' +
  'This command is only a confirmation — the PreToolUse hook is what shares a session.\n' +
  'Paste this into the Claude session you want to share (it must be running in its own tmux pane):\n\n' +
  `  ${ENABLE_PROMPT}\n`;

// Is this PreToolUse payload the enable sentinel? Tolerant of the app's
// descriptive prompt (which EMBEDS the literal command) and of an agent that
// reaches for `npx pidge-cli@latest terminal enable` when `pidge` is not on its
// PATH — but never loose: something must name pidge AND `terminal enable`.
// Returns null (not the sentinel) or {approvals:[…]} parsed from the command.
function parseEnableSentinel(toolName, command) {
  if (String(toolName || '').toLowerCase() !== 'bash') return null;
  const c = String(command || '');
  const literal = c.includes(ENABLE_SENTINEL);
  const viaNpx = /pidge-cli(@[^\s]+)?\s+terminal\s+enable\b/.test(c);
  if (!literal && !viaNpx) return null;
  // `--approvals Bash,Write` still rides the sentinel COMMAND (the pasted text
  // is the only carrier left now that the CLI is not the mechanism).
  const m = c.match(/--approvals[=\s]+([A-Za-z0-9_,*-]+)/);
  const approvals = m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
  return { approvals };
}

// --- tmux ------------------------------------------------------------------

// `ps -o tty=` and Claude Code's hook payloads carry a SHORT tty name
// (`ttys003` on macOS, `pts/3` on Linux) that must become the absolute path
// tmux reports as `#{pane_tty}` (`/dev/pts/3`). "No controlling tty" is `??` on
// macOS but a single `?` on Linux — reading either as a name yields the
// nonexistent `/dev/?`, and the pane lookup then fails with a confusing message
// instead of falling through to the cwd correlation.
function normalizeTty(short) {
  const t = String(short || '').trim();
  if (!t || /^\?+$/.test(t)) return null;
  return t.startsWith('/') ? t : `/dev/${t}`;
}

// Every tmux pane on this computer: {paneId, tty, path, loc}.
function tmuxPanes() {
  try {
    const out = execFileSync('tmux',
      ['list-panes', '-a', '-F',
        '#{pane_id}\t#{pane_tty}\t#{pane_current_path}\t#{session_name}:#{window_index}.#{pane_index}'],
      { encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean).map((line) => {
      const [paneId, tty, panePath, loc] = line.split('\t');
      return { paneId, tty, path: panePath, loc };
    });
  } catch { return []; }
}

// Resolve the tmux pane that owns a controlling tty — the PRIMARY binding.
// No pane ⇒ no share (spec §8: enable pins ONE pane_id).
function tmuxPaneForTty(tty) {
  if (!tty) return null;
  const hit = tmuxPanes().find((p) => p.tty === tty);
  return hit ? { paneId: hit.paneId, loc: hit.loc } : null;
}

// The FALLBACK binding, used only when the session announced no usable tty:
// panes whose current path IS the session's cwd. Returns ALL of them on
// purpose — the caller binds only when there is EXACTLY one, because guessing
// between two panes means typing the human's words into a stranger's shell.
function tmuxPanesForCwd(cwd) {
  const want = String(cwd || '').replace(/\/+$/, '');
  if (!want) return [];
  return tmuxPanes()
    .filter((p) => String(p.path || '').replace(/\/+$/, '') === want)
    .map((p) => ({ paneId: p.paneId, loc: p.loc }));
}

// --- config slot -----------------------------------------------------------

function baseDir() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'pidge');
}
function terminalDir() {
  return path.join(baseDir(), 'terminal');
}
const ENV_FILE = () => path.join(terminalDir(), 'env');
const DAEMON_FILE = () => path.join(terminalDir(), 'daemon.json');
const STATE_FILE = () => path.join(terminalDir(), 'state.json');
const LOG_FILE = () => path.join(terminalDir(), 'terminal.log');
const HOOK_SHIM = () => path.join(terminalDir(), 'pidge-hook.js');
const LOCKS_DIR = () => path.join(baseDir(), 'terminal-locks');

function readEnvFile(file) {
  try {
    const out = {};
    for (let line of fs.readFileSync(file, 'utf8').split('\n')) {
      line = line.trim().replace(/^export\s+/, '');
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i < 1) continue;
      const value = line.slice(i + 1).replace(/^["']|["']$/g, '');
      if (value) out[line.slice(0, i)] = value;
    }
    return out;
  } catch { return {}; }
}

function writeFileAtomic(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, data, mode !== undefined ? { mode } : undefined);
  fs.renameSync(tmp, file);
  if (mode !== undefined) { try { fs.chmodSync(file, mode); } catch {} }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj, mode = 0o600) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n', mode);
}

// The terminal identity: {base, token, secret, channelId} or null pieces.
function loadTerminalEnv() {
  const env = readEnvFile(ENV_FILE());
  return {
    base: env.PIDGE_URL || null,
    token: env.PIDGE_TOKEN || null,
    secret: env.PIDGE_SECRET || null,
    channelId: env.PIDGE_CHANNEL_ID ? Number(env.PIDGE_CHANNEL_ID) : null,
  };
}
function saveTerminalEnv({ base, token, secret, channelId }) {
  const body = `# pidge terminal — machine tunnel identity (written by \`pidge terminal connect\`)\n` +
    `PIDGE_URL=${base}\nPIDGE_TOKEN=${token}\nPIDGE_SECRET=${secret}\nPIDGE_CHANNEL_ID=${channelId}\n`;
  writeFileAtomic(ENV_FILE(), body, 0o600);
}

// --- E2E primitives (mirror of bin/pidge.js — keep byte-compatible) ---------

const E2E_FIELD_PREFIX = 'v1:';
const E2E_BLOB_VERSION = 0x01;
const E2E_NONCE_BYTES = 12;
const E2E_TAG_BYTES = 16;

function e2eAad(channelId, anchor, fieldName) {
  if (channelId === undefined || channelId === null || channelId === '') throw new Error('e2e AAD needs a channel_id');
  if (!anchor) throw new Error('e2e AAD needs an anchor');
  if (!fieldName) throw new Error('e2e AAD needs a field_name');
  return `ch${channelId}:${anchor}:${fieldName}`;
}
function e2eParseSecret(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(s)) throw new Error('PIDGE_SECRET is not base64url');
  const key = Buffer.from(s, 'base64url');
  if (key.length !== 32) throw new Error(`PIDGE_SECRET decodes to ${key.length} bytes — the channel key is exactly 32`);
  return key;
}
function e2eKeyFingerprint(key) {
  return crypto.createHash('sha256').update(key).digest().subarray(0, 4).toString('base64url');
}
function e2eSeal(key, aad, plaintext) {
  const iv = crypto.randomBytes(E2E_NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ct, tag: cipher.getAuthTag() };
}
function e2eOpen(key, aad, raw, what) {
  const iv = raw.subarray(0, E2E_NONCE_BYTES);
  const ct = raw.subarray(E2E_NONCE_BYTES, raw.length - E2E_TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(raw.subarray(raw.length - E2E_TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error(`e2e ${what} failed to authenticate: wrong key, wrong AAD, or corrupted data`);
  }
}
function e2eEncryptField(key, aad, plaintext) {
  const { iv, ct, tag } = e2eSeal(key, aad, Buffer.from(String(plaintext), 'utf8'));
  return E2E_FIELD_PREFIX + Buffer.concat([iv, ct, tag]).toString('base64url');
}
function e2eEncryptBlob(key, aad, buffer) {
  const { iv, ct, tag } = e2eSeal(key, aad, buffer);
  return Buffer.concat([Buffer.from([E2E_BLOB_VERSION]), iv, ct, tag]);
}
function e2eDecryptBlob(key, aad, buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('e2e blob must be a Buffer');
  if (buffer.length < 1 + E2E_NONCE_BYTES + E2E_TAG_BYTES) throw new Error('e2e blob too short');
  if (buffer[0] !== E2E_BLOB_VERSION) {
    throw new Error(`unknown e2e blob version 0x${buffer[0].toString(16).padStart(2, '0')} — this daemon speaks 0x01`);
  }
  return e2eOpen(key, aad, buffer.subarray(1), 'blob');
}

// --- HTTP -------------------------------------------------------------------

async function fetchT(url, opts = {}, timeoutMs = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally { clearTimeout(t); }
}

// Server caps (agent-sessions manifest section). Defaults match manifest v98;
// connect refreshes them from GET /manifest and caches — never hardcode
// anywhere else (the manifest is the contract).
const DEFAULT_CAPS = {
  item_sealed_max_bytes: 16384,
  items_per_call: 20,
  catchup_page_limit: 100,
  heartbeat_seconds: 30,
  offline_after_seconds: 90,
  input_frame_max_bytes: 8192,
};
function loadCaps() {
  const cached = readJson(path.join(terminalDir(), 'caps.json'), null);
  return { ...DEFAULT_CAPS, ...(cached || {}) };
}
function saveCaps(caps) {
  writeJson(path.join(terminalDir(), 'caps.json'), caps);
}

module.exports = {
  baseDir, terminalDir, ENV_FILE, DAEMON_FILE, STATE_FILE, LOG_FILE, HOOK_SHIM, LOCKS_DIR,
  tmuxPanes, tmuxPaneForTty, tmuxPanesForCwd, normalizeTty,
  parseEnableSentinel, ENABLE_SENTINEL, ENABLE_PROMPT, ENABLE_NOT_MIRRORED,
  ENABLE_OK_REASON, ENABLE_NO_PANE_REASON, ENABLE_NO_TRANSCRIPT_REASON,
  readEnvFile, writeFileAtomic, readJson, writeJson,
  loadTerminalEnv, saveTerminalEnv,
  e2eAad, e2eParseSecret, e2eKeyFingerprint, e2eEncryptField, e2eEncryptBlob, e2eDecryptBlob,
  fetchT, loadCaps, saveCaps, DEFAULT_CAPS,
};
