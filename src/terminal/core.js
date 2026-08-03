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

// --- tmux ------------------------------------------------------------------

// Resolve the tmux pane that owns a controlling tty. The ONE place both enable
// doors look it up — the ancestor-walk door (commands.runEnable) and the daemon
// (`enable --session`, where the CLI has no pane to offer). Both must bind the
// same way or the ls door silently produces a read-only session the phone still
// shows as interactive (spec §8: enable pins ONE pane_id).
function tmuxPaneForTty(tty) {
  if (!tty) return null;
  try {
    const out = execFileSync('tmux',
      ['list-panes', '-a', '-F', '#{pane_id}\t#{pane_tty}\t#{session_name}:#{window_index}.#{pane_index}'],
      { encoding: 'utf8' });
    for (const line of out.trim().split('\n')) {
      const [paneId, paneTty, loc] = line.split('\t');
      if (paneTty === tty) return { paneId, loc };
    }
  } catch {}
  return null;
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
  tmuxPaneForTty,
  readEnvFile, writeFileAtomic, readJson, writeJson,
  loadTerminalEnv, saveTerminalEnv,
  e2eAad, e2eParseSecret, e2eKeyFingerprint, e2eEncryptField, e2eEncryptBlob, e2eDecryptBlob,
  fetchT, loadCaps, saveCaps, DEFAULT_CAPS,
};
