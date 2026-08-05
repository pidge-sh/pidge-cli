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
// v2 (Terminals Phase A) adds `#{pane_current_command}` — the OCCUPANT signal
// (spec Part II §16: harness ⇒ mode "agent", anything else ⇒ "term") and the
// `current_command` column of the sealed pane inventory (§17). It goes BEFORE
// the location on purpose: loc must stay the LAST field so the "a session name
// may contain the separator" rejoin below keeps working.
// 0.43.1 adds `#{pane_pid}` — the root of the pane's process tree, which is how
// the occupant check answers "is a harness ALIVE in here?" without trusting a
// name the vendor owns (§16 invariant; gotcha #75). Both new fields sit BEFORE
// the location: loc must stay LAST for the rejoin below.
const TMUX_PANE_FORMAT =
  ['#{pane_id}', '#{pane_tty}', '#{pane_current_path}', '#{pane_current_command}', '#{pane_pid}',
    '#{session_name}:#{window_index}.#{pane_index}'].join(TMUX_FIELD_SEP);
const TMUX_PANE_FIELDS = 6;

// Pure parser for `tmux list-panes -F TMUX_PANE_FORMAT` output. A line that
// does not yield the expected fields goes to `unparsable` — the caller decides
// how loud (spec §11: an impossible line NEVER becomes silent 0 panes).
function parseTmuxPanes(out) {
  const panes = [];
  const unparsable = [];
  for (const line of String(out || '').split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(TMUX_FIELD_SEP);
    if (parts.length >= TMUX_PANE_FIELDS && /^%\d+$/.test(parts[0]) && parts[1]) {
      // Extra parts: the separator appeared inside the LAST field (a tmux
      // session name may contain ':::') — rejoin the tail into loc instead of
      // dropping a perfectly identifiable pane (review B2).
      panes.push({
        paneId: parts[0], tty: parts[1], path: parts[2], cmd: parts[3], pid: parts[4],
        loc: parts.slice(TMUX_PANE_FIELDS - 1).join(TMUX_FIELD_SEP),
      });
    } else {
      unparsable.push(line);
    }
  }
  return { panes, unparsable };
}

// --- The `mode` authority ladder (spec §16, gotcha #75) ---------------------
// `term` IS A POSITIVE ASSERTION; DOUBT SHOWS THE TRANSCRIPT. The set that
// DECIDES the agent→term flip is this one — SHELLS — because it is OURS and it
// is stable. It is deliberately NOT the harness set: a closed list of harness
// names cannot say "I do not recognise this", only "absent", and absent read as
// "gone" is what turned every live Claude Code v2.1.222 pane into a terminal
// placeholder at Gate A (tmux answers `2.1.222` — the harness's VERSION — for
// `#{pane_current_command}`, while `ps` still says `claude`).
const SHELL_COMMANDS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh']);
function isShellCommand(cmd) {
  // A login shell shows up as `-zsh`; that is still a shell.
  return SHELL_COMMANDS.has(String(cmd || '').trim().toLowerCase().replace(/^-/, ''));
}

// Process names that mean "a harness is alive in this pane's tree". Unlike the
// shell set above this one is ADVISORY — it can only ever say "definitely
// alive", never "definitely gone", so a name we have not seen costs nothing.
const HARNESS_PROCESS_NAMES = new Set(['claude']);

// `comm` from `ps` is a full path on macOS and may carry the login-shell dash.
function psCommName(comm) {
  const raw = String(comm || '').trim();
  if (!raw) return '';
  return raw.replace(/^-/, '').split('/').pop().toLowerCase();
}

// Is a harness process alive anywhere under this pane's process tree?
//   true  — yes, definitely (a descendant's `comm` is a known harness)
//   false — no, definitely (the tree was read and holds none)
//   null  — UNKNOWN (no pid, `ps` failed, or it returned nothing usable)
// The three-way answer is the whole point: `null` must never collapse into
// `false`, because only `false` is allowed to help retire a live view.
function paneHasLiveHarness(panePid, opts = {}) {
  const root = Number(panePid);
  if (!Number.isInteger(root) || root <= 0) return null;
  const exec = opts.exec || ((args) => require('node:child_process')
    .execFileSync('ps', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  let out;
  try { out = exec(['-Ao', 'pid=,ppid=,comm=']); } catch { return null; }
  const children = new Map();
  const nameOf = new Map();
  let rows = 0;
  for (const line of String(out || '').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    rows += 1;
    const pid = Number(m[1]); const ppid = Number(m[2]);
    nameOf.set(pid, psCommName(m[3]));
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  if (!rows) return null; // a silent `ps` is not an empty process table
  // Breadth-first from the pane's own process, with a visited set: a corrupt
  // table must not spin us (a pid can never legitimately be its own ancestor,
  // but this code may not assume the table is sane).
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift();
    if (HARNESS_PROCESS_NAMES.has(nameOf.get(pid) || '')) return true;
    for (const kid of children.get(pid) || []) {
      if (!seen.has(kid)) { seen.add(kid); queue.push(kid); }
    }
  }
  return false;
}

// Every tmux pane on this computer: {paneId, tty, path, cmd, pid, loc}.
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
    onWarn(`tmux list-panes: UNPARSABLE line ${JSON.stringify(line)} — expected ${TMUX_PANE_FIELDS} fields separated by ${JSON.stringify(TMUX_FIELD_SEP)}. This is a pidge/tmux mismatch, not a user error.`);
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
  return hit ? { paneId: hit.paneId, loc: hit.loc, cmd: hit.cmd, path: hit.path } : null;
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
// The capability grants (v2 §17/§22) live in their OWN file, deliberately NOT
// in `env`: the identity slot is the {URL, TOKEN, SECRET} triple a paste from
// the app writes, and a grant is a machine-side DECISION the human makes with
// `pidge terminal config`. Keeping them apart means re-pasting the one-liner
// (or `connect --replace`) can never silently re-open a capability.
const CONFIG_FILE = () => path.join(terminalDir(), 'config.json');
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

// --- capability grants (v2 Phase A, spec §17 + decisions §22.2/§22.3) -------
//
// Input into a pane the human already shared is command execution — that risk
// is consented by the share itself. `spawn` and `inventory` are different in
// kind: they create NEW surface with ZERO machine-side act, so the grant lives
// where the risk lives (on the machine), is stated in plain words at connect
// time, and rides every capabilities frame so the phone renders only what was
// actually granted. Defaults: remote_spawn OFF, inventory ON.
const GRANT_KEYS = ['remote_spawn', 'inventory'];
const GRANT_DEFAULTS = { remote_spawn: false, inventory: true };

function loadGrants() {
  const cfg = readJson(CONFIG_FILE(), null) || {};
  // Read STRICTLY: only a literal `true` opens remote_spawn, only a literal
  // `false` closes inventory. A junk/absent file is the documented default,
  // never an accident that grants something.
  return {
    remote_spawn: cfg.remote_spawn === true,
    inventory: cfg.inventory !== false,
  };
}

function saveGrants(changes) {
  const next = { ...loadGrants(), ...changes };
  writeJson(CONFIG_FILE(), { remote_spawn: !!next.remote_spawn, inventory: !!next.inventory });
  return loadGrants();
}

// Decision §22.2 — "deixamos claro no terminal": `connect`, `status` and
// `config` all print the grants in plain words, with the exact line that flips
// each one. Never a table of booleans.
function grantLines(grants = loadGrants()) {
  return [
    `Remote spawn from your phone: ${grants.remote_spawn ? 'ON' : 'OFF'} ` +
      `(${grants.remote_spawn ? 'disable: pidge terminal config remote_spawn off' : 'enable: pidge terminal config remote_spawn on'})`,
    `Pane inventory to your phone: ${grants.inventory ? 'ON' : 'OFF'} ` +
      `(${grants.inventory ? 'disable: pidge terminal config inventory off' : 'enable: pidge terminal config inventory on'})`,
  ];
}

// --- the computer lane (v2 Phase A, spec §17) -------------------------------

// The AAD anchor of EVERY computer-scoped frame is the literal string
// `computer` (media-e2e-spec §2): the computer is 1:1 with its tunnel channel,
// and cross-channel reuse is already blocked by the `ch<id>` prefix.
const COMPUTER_ANCHOR = 'computer';
// Caps enforced by the server relay (server/app/channels/computer_channel.rb:
// META_MAX_BYTES / REQUEST_MAX_BYTES). The server measures `data["frame"]` —
// the base64url STRING — so the daemon's degrade ladder must fit the ENCODED
// frame, not the sealed bytes.
const COMPUTER_META_MAX_BYTES = 32_768;
const COMPUTER_REQUEST_MAX_BYTES = 8_192;
// The daemon's presence beat (§17): `perform "heartbeat"`, no payload, every
// 30 s. The server write-throttles it; effective online = seen within 90 s.
const COMPUTER_HEARTBEAT_MS = 30_000;

// A pane share's identity (spec §16): minted PER SHARE, not per harness
// session id — it survives every occupant change, because it is the AAD anchor
// of every item ever sealed for that share. Server format: /\Aases_[a-z0-9-]{1,64}\z/.
function mintShareId() {
  return `ases_${crypto.randomUUID()}`;
}

// WSL has no user service manager unless the human opted into systemd, and it
// is its own `os` value in the capabilities frame.
function isWsl() {
  if (process.env.WSL_DISTRO_NAME) return true;
  try { return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')); } catch { return false; }
}

// The `os` field of the capabilities frame: "macos" | "linux" | "wsl" (pinned
// shape — iOS builds against these exact strings).
function computerOs(platform = process.platform) {
  if (platform === 'darwin') return 'macos';
  return isWsl() ? 'wsl' : 'linux';
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
// The read half of e2eEncryptField (mirror of bin/pidge.js — keep
// byte-compatible). Needed by the durable `computer_cmd` drain: a message row's
// sealed body arrives as an ordinary "v1:" field envelope.
function e2eDecryptField(key, aad, envelope) {
  if (typeof envelope !== 'string') throw new Error('e2e envelope must be a string');
  if (!envelope.startsWith(E2E_FIELD_PREFIX)) {
    const ver = /^(v\d+):/.exec(envelope);
    throw new Error(ver ? `unknown e2e envelope version "${ver[1]}" — this CLI speaks v1`
      : 'not an e2e field envelope (missing "v1:" prefix)');
  }
  const b64 = envelope.slice(E2E_FIELD_PREFIX.length);
  // Buffer.from(_, 'base64url') silently SKIPS invalid chars — a mangled
  // envelope must fail loud here, not decode to garbage that then fails the
  // tag with a misleading "wrong key" story.
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(b64)) throw new Error('invalid base64url in e2e envelope');
  const raw = Buffer.from(b64, 'base64url');
  if (raw.length < E2E_NONCE_BYTES + E2E_TAG_BYTES) throw new Error('e2e envelope too short');
  return e2eOpen(key, aad, raw, 'field').toString('utf8');
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
  CONFIG_FILE,
  tmuxPanes, tmuxPaneForTty, tmuxPanesForCwd, normalizeTty,
  parseTmuxPanes, tmuxExec, utf8Locale, TMUX_FIELD_SEP, TMUX_PANE_FORMAT, TMUX_PANE_FIELDS,
  SHELL_COMMANDS, isShellCommand, HARNESS_PROCESS_NAMES, psCommName, paneHasLiveHarness,
  parseEnableSentinel, ENABLE_SENTINEL, ENABLE_PROMPT, ENABLE_NOT_MIRRORED,
  ENABLE_OK_REASON, ENABLE_NO_PANE_REASON, ENABLE_NO_TRANSCRIPT_REASON,
  ENABLE_PANE_LOOKUP_FAILED_REASON,
  readEnvFile, writeFileAtomic, readJson, writeJson,
  loadTerminalEnv, saveTerminalEnv,
  loadGrants, saveGrants, grantLines, GRANT_KEYS, GRANT_DEFAULTS,
  COMPUTER_ANCHOR, COMPUTER_META_MAX_BYTES, COMPUTER_REQUEST_MAX_BYTES, COMPUTER_HEARTBEAT_MS,
  mintShareId, isWsl, computerOs,
  e2eAad, e2eParseSecret, e2eKeyFingerprint, e2eEncryptField, e2eDecryptField,
  e2eEncryptBlob, e2eDecryptBlob,
  fetchT, loadCaps, saveCaps, DEFAULT_CAPS,
};
