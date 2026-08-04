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
// When the daemon could not even READ the pane list (mangled tmux output), the
// refusal must not blame the human — "start claude inside tmux" with the pane
// right there is exactly the lie QA finding #10 caught.
const ENABLE_PANE_LOOKUP_FAILED_REASON =
  "Couldn't mirror this session: the local Pidge daemon failed to read the tmux pane list " +
  '(a daemon-side problem, NOT your setup — see ~/.config/pidge/terminal/terminal.log). ' +
  'Do not run other commands.';

// What `pidge terminal enable` says when it is run OUTSIDE the door (a bare
// terminal, or a claude whose hooks are not installed): the command is a
// friendly CONFIRM now, never the mechanism.
const ENABLE_NOT_MIRRORED =
  'pidge terminal enable: nothing is being mirrored from this computer.\n' +
  'This command is only a confirmation — the PreToolUse hook is what shares a session.\n' +
  'Paste this into the Claude session you want to share (it must be running in its own tmux pane):\n\n' +
  `  ${ENABLE_PROMPT}\n`;

// Is this PreToolUse payload the enable sentinel? The command must BE the
// sentinel — the WHOLE trimmed string, not a substring (QA finding #11: the
// substring match fired on ANY bash that merely MENTIONED the command — a
// `tmux send-keys` payload, an echo, a doc snippet — denying legitimate tool
// calls and trying to enable the WRONG session). Accepted invokers, all
// anchored end-to-end:
//   pidge terminal enable                       (the pasted literal)
//   /path/to/pidge terminal enable              (stable-path binary)
//   /path/to/pidge.js terminal enable           (the shebang'd entry)
//   node /path/to/pidge.js terminal enable      (explicit node)
//   npx [-y|--yes] pidge-cli[@tag] terminal enable  (the observed PATH-less improvisation)
// plus an optional trailing `--approvals LIST`. Anything else — prefixes,
// suffixes, redirects, compound commands — is NOT the door.
// Hardened (review B3): path prefixes allow path-looking characters ONLY —
// no `$()`, backticks, spaces — so `$(evil)/pidge …` can never read as the
// sentinel; and whitespace is `[ \t]` only, so a multi-line command smuggling
// the words (`pidge\nterminal\nenable`) does not match either.
// Returns null (not the sentinel) or {approvals:[…]} parsed from the command.
const ENABLE_PATHISH = '[\\w@.~/\\-]*';
const ENABLE_COMMAND_RE = new RegExp(
  '^(?:' +
    `${ENABLE_PATHISH}node(?:\\.exe)?[ \\t]+${ENABLE_PATHISH}/pidge(?:\\.js)?` +
    `|${ENABLE_PATHISH}pidge(?:\\.js)?` +
    '|npx[ \\t]+(?:(?:-y|--yes)[ \\t]+)?pidge-cli(?:@[\\w.^~-]+)?' +
  ')[ \\t]+terminal[ \\t]+enable' +
  '(?:[ \\t]+--approvals[= \\t]+[A-Za-z0-9_,*-]+)?[ \\t]*$'
);
function parseEnableSentinel(toolName, command) {
  if (String(toolName || '').toLowerCase() !== 'bash') return null;
  const c = String(command || '').trim();
  if (!ENABLE_COMMAND_RE.test(c)) return null;
  // `--approvals Bash,Write` still rides the sentinel COMMAND (the pasted text
  // is the only carrier left now that the CLI is not the mechanism).
  const m = c.match(/--approvals[= \t]+([A-Za-z0-9_,*-]+)/);
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

// The UTF-8 locale every tmux call must carry (QA finding #10): launchd and
// `systemd --user` hand a service NO locale, and without a UTF-8 locale tmux
// SANITIZES control characters in its -F output — the old TAB separator came
// back as `_` (byte 0x5f, proven on the byte), the parser found 0 panes, and
// enable refused "you're not in tmux" with the pane right there. Prefer the
// locale the human's shell already proved works; fall back to one that exists
// on the platform (en_US.UTF-8 ships on macOS; C.UTF-8 on any modern glibc).
function utf8Locale(env = process.env, platform = process.platform) {
  for (const v of [env.LC_ALL, env.LANG]) {
    if (v && /utf-?8/i.test(v)) return v;
  }
  return platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
}

// Defense in depth: the service templates set LANG/LC_ALL too (commands.js),
// but the daemon must not depend on being installed by a template that did.
function tmuxExec(args, opts = {}) {
  const locale = utf8Locale();
  // timeout: a wedged tmux server (SIGSTOP, disk hang) must not freeze the
  // daemon's whole event loop from a synchronous heartbeat call. The throw a
  // timeout produces is an EXEC failure — call sites must treat it as "could
  // not ask tmux", never as "the pane is gone" (see daemon.paneAlive).
  return execFileSync('tmux', args,
    { timeout: 5000, ...opts, env: { ...process.env, LANG: locale, LC_ALL: locale, ...(opts.env || {}) } });
}

// The list-panes field separator is a PRINTABLE, improbable delimiter on
// purpose: TAB is a control character and tmux has license to sanitize it away
// under a non-UTF-8 locale (finding #10). `:::` survives any locale; a pane
// path that somehow contains it makes the line unparsable — which is LOUD
// below, never silent.
const TMUX_FIELD_SEP = ':::';
const TMUX_PANE_FORMAT =
  ['#{pane_id}', '#{pane_tty}', '#{pane_current_path}', '#{session_name}:#{window_index}.#{pane_index}']
    .join(TMUX_FIELD_SEP);

// Pure parser for `tmux list-panes -F TMUX_PANE_FORMAT` output. A line that
// does not yield the expected fields goes to `unparsable` — the caller decides
// how loud (spec §11: an impossible line NEVER becomes silent 0 panes).
function parseTmuxPanes(out) {
  const panes = [];
  const unparsable = [];
  for (const line of String(out || '').split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(TMUX_FIELD_SEP);
    if (parts.length >= 4 && /^%\d+$/.test(parts[0]) && parts[1]) {
      // >4 parts: the separator appeared inside the LAST field (a tmux session
      // name may contain ':::') — rejoin the tail into loc instead of dropping
      // a perfectly identifiable pane (review B2).
      panes.push({ paneId: parts[0], tty: parts[1], path: parts[2], loc: parts.slice(3).join(TMUX_FIELD_SEP) });
    } else {
      unparsable.push(line);
    }
  }
  return { panes, unparsable };
}

// Every tmux pane on this computer: {paneId, tty, path, loc}.
// `opts.exec`/`opts.onWarn` exist for tests and for the daemon's logger.
function tmuxPanes(opts = {}) {
  const exec = opts.exec || ((args) => tmuxExec(args, { encoding: 'utf8' }));
  const onWarn = opts.onWarn || ((msg) => console.error(msg));
  let out;
  try {
    out = exec(['list-panes', '-a', '-F', TMUX_PANE_FORMAT]);
  } catch { return []; } // no tmux binary / no server: genuinely zero panes
  const { panes, unparsable } = parseTmuxPanes(out);
  for (const line of unparsable) {
    onWarn(`tmux list-panes: UNPARSABLE line ${JSON.stringify(line)} — expected 4 fields separated by ${JSON.stringify(TMUX_FIELD_SEP)}. This is a pidge/tmux mismatch, not a user error.`);
  }
  if (!panes.length && unparsable.length) {
    // tmux LISTED panes and we understood none of them. Reading that as "0
    // panes ⇒ you are not in tmux" is the silent lie finding #10 caught —
    // fail LOUD instead, and let the caller refuse without blaming the user.
    throw new Error(`tmux listed ${unparsable.length} pane(s) but none parsed — the pane list came back mangled (locale/sanitization?); refusing to read that as "no panes"`);
  }
  return panes;
}

// Resolve the tmux pane that owns a controlling tty — the PRIMARY binding.
// No pane ⇒ no share (spec §8: enable pins ONE pane_id).
function tmuxPaneForTty(tty, opts) {
  if (!tty) return null;
  const hit = tmuxPanes(opts).find((p) => p.tty === tty);
  return hit ? { paneId: hit.paneId, loc: hit.loc } : null;
}

// The FALLBACK binding, used only when the session announced no usable tty:
// panes whose current path IS the session's cwd. Returns ALL of them on
// purpose — the caller binds only when there is EXACTLY one, because guessing
// between two panes means typing the human's words into a stranger's shell.
function tmuxPanesForCwd(cwd, opts) {
  const want = String(cwd || '').replace(/\/+$/, '');
  if (!want) return [];
  return tmuxPanes(opts)
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
  parseTmuxPanes, tmuxExec, utf8Locale, TMUX_FIELD_SEP, TMUX_PANE_FORMAT,
  parseEnableSentinel, ENABLE_SENTINEL, ENABLE_PROMPT, ENABLE_NOT_MIRRORED,
  ENABLE_OK_REASON, ENABLE_NO_PANE_REASON, ENABLE_NO_TRANSCRIPT_REASON,
  ENABLE_PANE_LOOKUP_FAILED_REASON,
  readEnvFile, writeFileAtomic, readJson, writeJson,
  loadTerminalEnv, saveTerminalEnv,
  e2eAad, e2eParseSecret, e2eKeyFingerprint, e2eEncryptField, e2eEncryptBlob, e2eDecryptBlob,
  fetchT, loadCaps, saveCaps, DEFAULT_CAPS,
};
