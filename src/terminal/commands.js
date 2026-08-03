'use strict';
// `pidge terminal <sub>` — the user-facing side of Agent Sessions v1
// (agent-sessions-spec §2). connect = once per computer (claim exchange +
// consent + hooks + skill + daemon install); enable happens in the DAEMON, on
// the PreToolUse hook that carries the sentinel the human pasted into the
// session (see core.ENABLE_PROMPT and daemon.enableFromSentinel) — this file's
// `enable` is a friendly confirmation of that, never the mechanism;
// disable/status/disconnect complete the lifecycle. Everything session-scoped
// talks to the LOCAL daemon over loopback — commands never publish anything
// themselves.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { execFileSync, spawn } = require('child_process');
const core = require('./core');

const PIDGE_HOOK_MARKER = '# pidge-hook';
const DAEMON_PORT = 41717;
const LAUNCHD_LABEL = 'sh.pidge.terminal';
const SYSTEMD_UNIT = 'pidge-terminal.service';
const HOOK_EVENTS = [
  ['SessionStart', 'session-start', 10],
  ['PreToolUse', 'pre-tool-use', 90], // holds for the approval gate (spec §9)
  ['Notification', 'notification', 10],
  ['Stop', 'stop', 10],
];

function die(msg, code = 1) { console.error(msg); process.exit(code); }
function say(msg) { console.log(msg); }

async function daemonCall(method, p, body) {
  const cfg = core.readJson(core.DAEMON_FILE(), null);
  if (!cfg) throw new Error('not connected — run `pidge terminal connect` first');
  const res = await core.fetchT(`http://127.0.0.1:${cfg.port}${p}`, {
    method,
    headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, 65_000);
  let data = null;
  try { data = await res.json(); } catch {}
  return { res, data };
}

async function daemonAlive() {
  try {
    const { res, data } = await daemonCall('GET', '/health');
    return res.status === 200 ? data : null;
  } catch { return null; }
}

// Ask the RUNNING daemon (if any) to exit — the loopback half of the
// `connect --replace` recycle (review A2). Returns true when a daemon
// answered the shutdown; false when nothing was listening or the bearer did
// not match (a daemon that refuses our token is NOT ours to kill). After a
// successful shutdown, wait for the port to actually free so the fresh
// daemon cannot die on EADDRINUSE against the exiting one.
async function shutdownLocalDaemon() {
  const cfg = core.readJson(core.DAEMON_FILE(), null);
  if (!cfg || !cfg.port || !cfg.token) return false;
  let res;
  try {
    res = await core.fetchT(`http://127.0.0.1:${cfg.port}/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.token}` },
    }, 3000);
  } catch { return false; } // nothing listening — nothing to recycle
  if (!res.ok) return false; // 401: not our daemon — leave it alone
  for (let i = 0; i < 20; i++) {
    try {
      await core.fetchT(`http://127.0.0.1:${cfg.port}/health`, {}, 500);
    } catch { return true; } // connection refused — it is gone
    await new Promise((r) => setTimeout(r, 100));
  }
  console.error('pidge terminal: WARNING — the old daemon acknowledged the shutdown but its port is still held; the fresh daemon may collide (EADDRINUSE) and exit until the service manager retries');
  return true;
}

// --- connect ----------------------------------------------------------------

async function askYesNo(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function runConnect(v) {
  const code = v.code || null;
  const base = (v.url || 'https://api.pidge.sh').replace(/\/$/, '');
  const secretRaw = process.env.PIDGE_SECRET || v.secret || null;
  const existing = core.loadTerminalEnv();

  // A NEW pairing over an EXISTING identity refuses LOUDLY (QA finding #9):
  // connect used to overwrite the slot in silence, leaving the old channel
  // alive on the server — an orphaned "Computer N" that counts against the
  // channel limit and shows in the app as a connected computer that never
  // reports again (Thiago has three of those). The slot being unique is
  // right — one computer, one identity; the SWITCH must be consented.
  // Re-running WITHOUT --code (finishing a half-done install) stays allowed.
  if (code && existing.token && !v.replace) {
    // NOTE: the suggestion is --replace, deliberately NOT `disconnect` —
    // disconnect keeps the identity file (review M1), so it would send the
    // human in a circle right back to this refusal.
    die('pidge terminal connect: this computer is already connected to ' +
      `channel ${existing.channelId != null ? existing.channelId : '(unknown)'} at ${existing.base || '(unknown url)'}.\n` +
      `Run again with --replace to switch this computer over — or delete ${core.ENV_FILE()} by hand and re-run.\n` +
      '(Either way the OLD channel stays on the server — remove that computer in the app: Settings → Computers.)');
  }

  let token = existing.token;
  let channelId = existing.channelId;
  let effectiveBase = existing.base || base;
  let secret = secretRaw || existing.secret;
  // The one moment we KNOW this computer is about to run Agent Sessions — so
  // it is the one moment to notice this CLI is behind (an old copy is how the
  // whole pairing broke for the installed base: npx prefers a local install).
  await warnIfOutdated();

  // `kind` is validated AFTER the identity is persisted (below): the claim has
  // already rotated the key server-side, and dying here used to throw that key
  // away. Retry-safety (gotcha #52) covered it; the order was still wrong.
  let serverKind = null;
  if (code) {
    // The claim exchange (retry-safe per fingerprint — the pidge server's #52
    // contract): a network fumble re-runs to the SAME key, never a rotation.
    const fp = crypto.createHash('sha256').update(`pidge-terminal:${os.hostname()}:${core.terminalDir()}`).digest('base64url').slice(0, 32);
    const res = await core.fetchT(`${base}/api/v1/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pidge-fingerprint': fp },
      body: JSON.stringify({ code }),
    });
    if (res.status === 404) die('pidge terminal connect: that code is unknown, expired or already used by another machine — mint a fresh one in the app (Settings → Computers → Connect a computer)');
    if (!res.ok) die(`pidge terminal connect: claim exchange failed (${res.status})`);
    const data = await res.json();
    token = data.key;
    channelId = data.channel && data.channel.id;
    effectiveBase = (data.base_url || base).replace(/\/$/, '');
    serverKind = (data.channel && data.channel.kind) || null;
  }
  if (!token) die('pidge terminal connect: no stored identity and no --code — paste the one-liner from the app (Settings → Computers → Connect a computer)');
  if (!secret) die('pidge terminal connect: PIDGE_SECRET missing — the app\'s Connect-a-computer one-liner carries it (E2E is mandatory on tunnels; there is no clear mode)');
  try { core.e2eParseSecret(secret); } catch (e) { die(`pidge terminal connect: ${e.message}`); }

  core.saveTerminalEnv({ base: effectiveBase, token, secret, channelId });
  say(`✓ tunnel identity stored (${core.ENV_FILE()}, 0600)`);

  // Only refuse when the server ACTUALLY says a different kind. A server that
  // does not report `kind` at all (every deploy before manifest v100) is not
  // evidence of anything — reading `undefined !== 'tunnel'` as "wrong kind" is
  // what killed 100% of connects (QA finding #1); §12 says tolerate absence.
  if (serverKind && serverKind !== 'tunnel') {
    die(`pidge terminal connect: this code belongs to a ${serverKind} channel, not a tunnel — use the app's Settings → Computers → Connect a computer flow (it mints the right kind)`);
  }

  // Refresh the server caps from the manifest (never hardcode — spec §12).
  try {
    const res = await core.fetchT(`${effectiveBase}/api/v1/manifest`, { headers: { authorization: `Bearer ${token}` } });
    const manifest = await res.json();
    if (manifest.agent_sessions && manifest.agent_sessions.limits) {
      core.saveCaps({ ...core.DEFAULT_CAPS, ...manifest.agent_sessions.limits });
      say('✓ server limits cached from the manifest');
    }
  } catch { say('· manifest unreachable — using default limits (refreshed on next connect)'); }

  // Consent prompt — VERBATIM from the spec (§2). Hooks are local-only by
  // construction; nothing is shared until a per-session enable.
  const consent = v.yes || await askYesNo(
    'Install Claude Code hooks so sessions can announce themselves to the local Pidge daemon?\n' +
    'Hooks talk only to this computer; nothing is shared until you enable a session.');
  if (consent) {
    writeHookShim();
    // A malformed ~/.claude/settings.json aborts the install LOUDLY: we never
    // overwrite a config we could not read (see readClaudeSettings).
    try { installHooks(); } catch (e) { die(`${e.message}\n(the tunnel identity above is stored; re-run \`pidge terminal connect\` once the file parses)`); }
    say('✓ hooks installed in ~/.claude/settings.json (tagged, cleanly removable via `pidge terminal disconnect`)');
  } else {
    say('· hooks NOT installed — the enable door IS the PreToolUse hook, so nothing can be shared until you re-run connect and accept');
  }

  // The skill is the agent-side half of the door: a claude running an OLD rev
  // reads "enable yourself on Pidge" with its pre-existing meaning and goes
  // ONLINE on a notification channel instead (QA finding #2 — it drained and
  // acked 21 real messages while reporting success). connect is the one moment
  // we know this computer will be used for Agent Sessions, so it refreshes the
  // skill here. A failure WARNS — the hook door works without any skill.
  try {
    const file = installPidgeSkill({ base: effectiveBase, token });
    say(`✓ Pidge skill refreshed (${file})`);
  } catch (e) {
    console.error(`pidge terminal: WARNING — could not refresh the Pidge skill (${e.message}).\n  Fix it with:  cd ~ && npx -y pidge-cli@latest skill install\n  (sharing still works without it — the PreToolUse hook is the door, not the skill.)`);
  }

  // Daemon config + this computer's service manager (--no-daemon skips the
  // install on EVERY platform — the manual line is the same everywhere).
  const cfg = core.readJson(core.DAEMON_FILE(), null) || { port: DAEMON_PORT, token: crypto.randomBytes(24).toString('base64url') };
  core.writeJson(core.DAEMON_FILE(), cfg);
  // --replace: a daemon may still be RUNNING with the OLD identity in memory
  // (review A2). launchd's unload+load recycles it, but systemd's
  // `enable --now` is a NO-OP while the unit is active, and the detached
  // fallback's fresh daemon dies on EADDRINUSE while the old one keeps
  // publishing to the orphaned channel — a new enable then lands there in
  // silence. The loopback shutdown covers every platform the same way (and
  // --no-daemon too); the systemd installer adds a belt-and-braces restart.
  if (v.replace) {
    const wasUp = await shutdownLocalDaemon();
    if (wasUp) say('✓ stopped the running daemon (it held the previous tunnel identity in memory)');
  }
  if (v['no-daemon']) {
    say('· --no-daemon: start it yourself with `pidge terminal daemon`');
  } else {
    const svc = installDaemonService({ recycle: !!v.replace });
    if (svc.kind === 'launchd') say(`✓ daemon installed (launchd ${svc.label}) — logs at ${core.LOG_FILE()}`);
    else if (svc.kind === 'systemd') {
      say(`✓ daemon installed (systemd --user ${svc.label}) — logs at ${core.LOG_FILE()}`);
      say('  (survive logout: `loginctl enable-linger $USER`)');
    } else say(`· daemon logs at ${core.LOG_FILE()}`);
  }
  say('\nDone. This computer is linked. To share a session: start (or restart) claude');
  say('inside its own tmux pane and PASTE this into it —\n');
  say(`  ${core.ENABLE_PROMPT}\n`);
  say('The PreToolUse hook catches that command and shares THAT session (per session id);');
  say('the command itself never runs, so it does not matter whether `pidge` is on your PATH.');
}

// --- the Pidge skill (agent-side half of the door) --------------------------

// Run `skill install` from the HOME dir, so the refreshed skill lands in
// ~/.claude/skills/pidge/SKILL.md — the copy EVERY session loads, not one
// project's. The child gets the tunnel identity purely to read the (public)
// manifest; the generated skill bakes no token. THROWS with a short message —
// the caller decides warn-vs-die (here: warn).
function installPidgeSkill({ base, token }) {
  const entry = cliEntryPath();
  const home = os.homedir();
  try {
    execFileSync(process.execPath, [entry, 'skill', 'install'], {
      cwd: home,
      env: { ...process.env, PIDGE_URL: base, PIDGE_TOKEN: token, PIDGE_QUIET_NAG: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 60_000,
      encoding: 'utf8',
    });
  } catch (e) {
    const detail = String((e && e.stderr) || (e && e.message) || '').trim().split('\n').slice(-1)[0];
    throw new Error(detail || 'skill install failed');
  }
  return path.join(home, '.claude', 'skills', 'pidge', 'SKILL.md');
}

// --- version self-check -----------------------------------------------------

// Never blocks and never installs behind the human's back: it says the one line
// that fixes it. (A network failure is silence — connect must work offline.)
async function warnIfOutdated() {
  if (process.env.PIDGE_NO_UPDATE_CHECK) return; // offline boxes + hermetic tests
  try {
    const { currentVersion, latestVersion, isOlder } = require('../update');
    const current = currentVersion();
    const latest = await latestVersion();
    if (!current || !latest || !isOlder(current, latest)) return;
    console.error(`pidge terminal: this CLI is ${current}; ${latest} is published. Update it first:  pidge update   (or: npm i -g pidge-cli@latest)`);
  } catch { /* best-effort — a version probe must never break connect */ }
}

// --- hook shim + settings.json installer ------------------------------------

function hookShimSource() {
  // Standalone by design: hooks must survive npx cache prunes and CLI
  // upgrades. Dependency-free, exits 0 ALWAYS (a broken shim must never
  // break claude), silent except the PreToolUse gate's decision JSON.
  return `#!/usr/bin/env node
'use strict';
// pidge terminal hook shim — generated by \`pidge terminal connect\`.
// Forwards Claude Code hook events to the LOCAL pidge daemon (loopback only).
// Safe by construction: any failure exits 0 silently and claude proceeds.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const EVENT = process.argv[2] || '';
const CFG = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'pidge', 'terminal', 'daemon.json');
function bail() { process.exit(0); }
let cfg; try { cfg = JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch { bail(); }
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', async () => {
  let body; try { body = JSON.parse(input || '{}'); } catch { body = {}; }
  try {
    // The short tty name (macOS 'ttys003', Linux 'pts/3') becomes the absolute
    // path tmux reports as #{pane_tty}. "no tty" is '??' on macOS and '?' on
    // Linux — both must resolve to null, never to '/dev/?'.
    body.tty = (() => {
      try {
        const t = execFileSync('ps', ['-o', 'tty=', '-p', String(process.pid)], { encoding: 'utf8' }).trim();
        return t && !/^\\?+$/.test(t) ? (t.startsWith('/') ? t : '/dev/' + t) : null;
      } catch { return null; }
    })();
    const ctl = new AbortController();
    const hold = EVENT === 'pre-tool-use' ? 80000 : 3000;
    const t = setTimeout(() => ctl.abort(), hold);
    const res = await fetch('http://127.0.0.1:' + cfg.port + '/hook/' + EVENT, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + cfg.token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (EVENT === 'pre-tool-use' && res.ok) {
      const data = await res.json();
      if (data && data.decision && data.decision.permissionDecision) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', ...data.decision },
        }));
      }
    }
  } catch {}
  bail();
});
`;
}

function writeHookShim() {
  core.writeFileAtomic(core.HOOK_SHIM(), hookShimSource(), 0o755);
}

function claudeSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function hookCommand(slug) {
  // The trailing marker is a shell comment — inert at run time, and the
  // uninstaller's handle (the AoE tagging pattern).
  return `"${process.execPath}" "${core.HOOK_SHIM()}" ${slug} ${PIDGE_HOOK_MARKER}`;
}

// Read ~/.claude/settings.json for a read-MODIFY-write cycle.
//
// Returns `null` when the file genuinely does not exist, and THROWS when it
// exists but does not parse. The tolerant `readJson(file, {})` this replaces
// swallowed a syntax error and the writer then persisted `{hooks:{…}}` over the
// user's real config — a whole Claude Code setup (model, permissions, env,
// statusLine, MCP) wiped by a stray trailing comma. A file we cannot understand
// is never a file we may overwrite.
function readClaudeSettings() {
  const file = claudeSettingsPath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`pidge terminal: cannot read ${file} (${e.message}) — refusing to touch it`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
    return parsed;
  } catch (e) {
    throw new Error(
      `pidge terminal: ${file} is not valid JSON (${e.message}).\n` +
      'Refusing to rewrite it — that would destroy your Claude Code settings.\n' +
      'Fix the file by hand (or move it aside) and re-run the command.');
  }
}

// Preserve the file's permissions across the rewrite: a settings.json the user
// deliberately kept at 0600 must not come back world-readable. A file we create
// ourselves starts private.
function claudeSettingsMode() {
  try { return fs.statSync(claudeSettingsPath()).mode & 0o777; } catch { return 0o600; }
}

function writeClaudeSettings(settings) {
  core.writeFileAtomic(claudeSettingsPath(), JSON.stringify(settings, null, 2) + '\n', claudeSettingsMode());
}

function installHooks() {
  const settings = readClaudeSettings() || {};
  settings.hooks = settings.hooks || {};
  for (const [event, slug, timeout] of HOOK_EVENTS) {
    const entries = (settings.hooks[event] || []).filter(
      (e) => !(e.hooks || []).some((h) => String(h.command || '').includes(PIDGE_HOOK_MARKER)));
    entries.push({
      ...(event === 'PreToolUse' ? { matcher: '*' } : {}),
      hooks: [{ type: 'command', command: hookCommand(slug), timeout }],
    });
    settings.hooks[event] = entries;
  }
  writeClaudeSettings(settings);
}

function uninstallHooks() {
  // Same rule as the installer: a settings.json we cannot parse is left ALONE.
  // Uninstall must not abort the rest of `disconnect`, so this one narrates and
  // returns instead of throwing — the hook lines stay, but they are inert once
  // the daemon and its shim are gone.
  let settings;
  try {
    settings = readClaudeSettings();
  } catch (e) {
    console.error(`${e.message}\n· hook entries left in place (they are inert without the daemon).`);
    return;
  }
  if (!settings || !settings.hooks) return;
  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = (settings.hooks[event] || []).filter(
      (e) => !(e.hooks || []).some((h) => String(h.command || '').includes(PIDGE_HOOK_MARKER)));
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  writeClaudeSettings(settings);
}

// --- the daemon service (launchd · systemd --user · detached fallback) -------
//
// The feature is not macOS-only: it needs node + tmux, which every developer
// box has. So the supervisor is chosen per platform — launchd on macOS,
// `systemd --user` on Linux (including WSL2 with systemd enabled) — and a
// computer with NO user service manager (an older WSL, a container) still gets
// a RUNNING daemon plus the two lines that make it durable. Never a hard
// failure: `connect` that half-works is worse than one that says what's left.

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// systemd unit-file quoting: double quotes with backslash escapes, PLUS the
// unit-file expansions ('$$' = literal $, '%%' = literal %) — a node path or a
// PATH entry containing either must arrive verbatim.
function systemdQuote(s) {
  return '"' + String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, () => '$$')
    .replace(/%/g, '%%') + '"';
}

function launchdPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function systemdUnitPath() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'systemd', 'user', SYSTEMD_UNIT);
}

// PIDGE_TERMINAL_PLATFORM: test hook so EVERY template is exercised on any OS
// (same shape as the bridge installer's PIDGE_BRIDGE_PLATFORM).
function daemonPlatform(probe = {}) {
  return probe.platform || process.env.PIDGE_TERMINAL_PLATFORM || process.platform;
}

// A user service manager we can actually talk to. `/run/systemd/system` is the
// canonical "systemd is PID 1" marker; the systemctl probe additionally proves
// the per-user manager is reachable (a WSL2 with systemd=true but no user bus
// would otherwise take us down a path that silently does nothing).
function hasSystemd() {
  if (fs.existsSync('/run/systemd/system')) return true;
  try {
    execFileSync('systemctl', ['--user', '--no-pager'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// WSL has no user service manager unless the human opted into systemd, so it
// gets its own (actionable) fallback text.
function isWsl() {
  if (process.env.WSL_DISTRO_NAME) return true;
  try { return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')); } catch { return false; }
}

// Where THIS process's CLI lives (bin/pidge.js) and its package root.
function cliEntryPath() {
  return require.main ? require.main.filename : path.join(__dirname, '..', '..', 'bin', 'pidge.js');
}
function cliRootPath() {
  return path.resolve(path.dirname(cliEntryPath()), '..'); // <root>/bin/pidge.js → <root>
}
function stableCliDir() { return path.join(core.terminalDir(), 'cli'); }
function stableCliEntry() { return path.join(stableCliDir(), 'bin', 'pidge.js'); }

// A service template must NEVER point at where the CLI happens to be running
// from: `npx` runs it out of ~/.npm/_npx/<hash>, npm prunes that cache, and the
// daemon dies silently weeks later (QA finding #4 — proven on a real launchd
// plist). And `npm i -g` cannot be trusted either: on a real machine the npm
// prefix was outside PATH entirely (finding #8). So connect COPIES the CLI it
// is running into ~/.config/pidge/terminal/cli/ and the service runs that —
// a path this feature owns, with no cache and no PATH in the loop.
function copyCliToStablePath() {
  const root = cliRootPath();
  const dest = stableCliDir();
  if (path.resolve(root) === path.resolve(dest)) return stableCliEntry(); // already the copy
  const staging = `${dest}.new.${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  // bin/ + src/ is the whole runtime (pidge-cli has no runtime dependencies);
  // package.json rides along so `pidge --version` keeps telling the truth.
  for (const part of ['bin', 'src', 'package.json']) {
    const from = path.join(root, part);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(staging, part), { recursive: true });
  }
  if (!fs.existsSync(path.join(staging, 'bin', 'pidge.js'))) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`could not find bin/pidge.js under ${root}`);
  }
  // Swap last: a half-copied tree must never be what the service points at.
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(staging, dest);
  try { fs.chmodSync(stableCliEntry(), 0o755); } catch {}
  return stableCliEntry();
}

// node + the CLI entry point the service will run. Shared by every branch.
function daemonExec() {
  const nodeBin = process.execPath;
  const fallback = cliEntryPath();
  try {
    return { nodeBin, cli: copyCliToStablePath() };
  } catch (e) {
    const npx = /[\\/]_npx[\\/]/.test(fallback);
    console.error(`pidge terminal: WARNING — could not copy the CLI to ${stableCliDir()} (${e.message}); the service will point at ${fallback}${npx ? ' — the npx CACHE, which npm PRUNES: the daemon would die silently later. Install durably (npm i -g pidge-cli@latest) and re-run `pidge terminal connect`.' : '.'}`);
    return { nodeBin, cli: fallback };
  }
}

// `probe` exists for the TESTS and nothing else: it lets one machine exercise
// every template (and lets the assertions prove which OS command was, and was
// NOT, run). Production always takes the defaults.
function installDaemonService(probe = {}) {
  const run = probe.run || ((cmd, args) => execFileSync(cmd, args, { stdio: 'ignore' }));
  return daemonPlatform(probe) === 'darwin'
    ? installLaunchd(run)
    : installSystemdUser(probe, run);
}

function installLaunchd(run) {
  const { nodeBin, cli } = daemonExec();
  // launchd hands a service NO locale — and without a UTF-8 locale tmux
  // SANITIZES control characters in its -F output, which is how the pane
  // parser found "0 panes" with the pane right there (QA finding #10). The
  // daemon also forces the locale on every tmux call (core.tmuxExec); setting
  // it here too is deliberate defense in depth, per platform template.
  const locale = core.utf8Locale();
  const envPairs = { LANG: locale, LC_ALL: locale };
  if (process.env.PATH) envPairs.PATH = process.env.PATH;
  const envEntries = Object.entries(envPairs)
    .map(([k, val]) => `    <key>${xmlEscape(k)}</key><string>${xmlEscape(val)}</string>`).join('\n');
  const envBlock = `  <key>EnvironmentVariables</key>\n  <dict>\n${envEntries}\n  </dict>\n`;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<!-- generated by \`pidge terminal connect\`. The tunnel key stays in
     ~/.config/pidge/terminal/env — NEVER embedded here. -->
<dict>
  <key>Label</key><string>${xmlEscape(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodeBin)}</string>
    <string>${xmlEscape(cli)}</string>
    <string>terminal</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
${envBlock}  <key>StandardOutPath</key><string>${xmlEscape(core.LOG_FILE())}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(path.join(core.terminalDir(), 'terminal.err.log'))}</string>
</dict>
</plist>
`;
  const file = launchdPlistPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, plist);
  try { run('launchctl', ['unload', file]); } catch {}
  try {
    run('launchctl', ['load', '-w', file]);
  } catch (e) {
    console.error(`pidge terminal: launchctl load failed (${e.message}) — start manually: launchctl load -w "${file}"`);
  }
  return { kind: 'launchd', file, label: LAUNCHD_LABEL };
}

function installSystemdUser(probe, run) {
  const systemd = probe.systemd !== undefined ? probe.systemd : hasSystemd();
  if (!systemd) return startDetachedDaemon(probe);

  const { nodeBin, cli } = daemonExec();
  // launchd/systemd hand a service a MINIMAL PATH — and this daemon SHELLS OUT
  // to tmux and ps on every enable and every keystroke it delivers. A tmux from
  // homebrew/nix/~/.local/bin would simply not exist for the service while
  // working fine in the shell the human just tested from.
  // LANG/LC_ALL: same story as the launchd template — no locale in the service
  // env makes tmux sanitize control characters in -F output (QA finding #10).
  const locale = core.utf8Locale();
  const envPairs = { LANG: locale, LC_ALL: locale };
  if (process.env.PATH) envPairs.PATH = process.env.PATH;
  if (process.env.XDG_CONFIG_HOME) envPairs.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  const envLines = Object.entries(envPairs)
    .map(([k, val]) => `Environment=${systemdQuote(`${k}=${val}`)}`).join('\n');
  const unit = `# generated by \`pidge terminal connect\`. The tunnel key stays in
# ~/.config/pidge/terminal/env — NEVER embedded here.
[Unit]
Description=pidge terminal daemon — Agent Sessions (local hook endpoint, sealed publisher, input lane)
# Wants + After: After alone only ORDERS against the target if something else
# pulls it in — Wants actually pulls it into the transaction.
Wants=network-online.target
After=network-online.target

[Service]
ExecStart=${systemdQuote(nodeBin)} ${systemdQuote(cli)} terminal daemon
Restart=on-failure
RestartSec=10
${envLines ? envLines + '\n' : ''}StandardOutput=append:${core.LOG_FILE()}
StandardError=append:${path.join(core.terminalDir(), 'terminal.err.log')}

[Install]
WantedBy=default.target
`;
  const file = systemdUnitPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, unit);
  try {
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT]);
    // `enable --now` is a NO-OP while the unit is already active, so a
    // --replace would leave the OLD daemon running with the previous identity
    // in memory (review A2). The loopback shutdown usually got it first —
    // this restart is belt-and-braces, harmless on a freshly started unit.
    if (probe.recycle) run('systemctl', ['--user', 'restart', SYSTEMD_UNIT]);
  } catch (e) {
    console.error(`pidge terminal: systemctl failed (${e.message}) — start it manually:\n  systemctl --user daemon-reload && systemctl --user enable --now ${SYSTEMD_UNIT}`);
  }
  return { kind: 'systemd', file, label: SYSTEMD_UNIT };
}

// No user service manager (an older WSL, /etc/wsl.conf without systemd, a bare
// container). Refusing here would leave a connected tunnel with no daemon, so
// we START it — detached, so it outlives this shell — and say exactly what
// makes it survive a reboot.
function startDetachedDaemon(probe = {}) {
  const { nodeBin, cli } = daemonExec();
  const spawnFn = probe.spawn || spawn;
  let pid = null;
  try {
    const child = spawnFn(nodeBin, [cli, 'terminal', 'daemon'], { detached: true, stdio: 'ignore' });
    child.unref();
    pid = child.pid;
  } catch (e) {
    console.error(`pidge terminal: could not start the daemon (${e.message}) — run it yourself: pidge terminal daemon`);
  }
  const wsl = probe.wsl !== undefined ? probe.wsl : isWsl();
  say(`· no user service manager here (no systemd)${pid ? ` — daemon started detached (pid ${pid})` : ''}`);
  say('  It will NOT come back after a reboot. Make it durable, either:');
  if (wsl) {
    say('   · enable systemd — add to /etc/wsl.conf:');
    say('       [boot]');
    say('       systemd=true');
    say('     then `wsl --shutdown` from Windows and re-run `pidge terminal connect`');
  }
  say('   · or start it from your shell profile (~/.bashrc, ~/.zshrc):');
  say('       pgrep -f "terminal daemon" >/dev/null || (pidge terminal daemon &)');
  return { kind: 'detached', pid, wsl };
}

function uninstallDaemonService(probe = {}) {
  const run = probe.run || ((cmd, args) => execFileSync(cmd, args, { stdio: 'ignore' }));
  if (daemonPlatform(probe) === 'darwin') {
    const file = launchdPlistPath();
    try { run('launchctl', ['unload', '-w', file]); } catch {}
    try { fs.unlinkSync(file); return { kind: 'launchd', removed: true }; } catch { return { kind: 'launchd', removed: false }; }
  }
  const file = systemdUnitPath();
  try { run('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]); } catch {}
  let removed = false;
  try { fs.unlinkSync(file); removed = true; } catch {}
  if (removed) { try { run('systemctl', ['--user', 'daemon-reload']); } catch {} }
  return { kind: 'systemd', removed };
}

// --- enable (a CONFIRMATION — the door is the hook) -------------------------
//
// This command used to BE the mechanism: it walked its own process tree up to
// the claude process to read its tty. That is structurally broken (QA finding
// #7 — Claude Code runs every Bash tool inside a ttyless shell wrapper whose
// command line mentions `.claude/`, so the walk stopped there and refused on
// every machine), and it dragged a PATH problem along (finding #8). The whole
// walk is GONE: the daemon enables sessions from the PreToolUse hook, which
// carries the session id authoritatively (core.parseEnableSentinel).
//
// What's left is a friendly confirm for a human in a bare terminal: it never
// mints a share, and it says the one thing that does.
async function runEnable(v) {
  if (!(await daemonAlive())) die('pidge terminal enable: the local daemon is not running — run `pidge terminal connect` (or `pidge terminal daemon` in another shell) first');
  const { data } = await daemonCall('GET', '/sessions');
  const enabled = data.enabled || [];
  if (!enabled.length) {
    // Loud, actionable, and NOT a share: exit 1 keeps "nothing was created".
    die(core.ENABLE_NOT_MIRRORED);
  }
  say(`✓ ${enabled.length} session(s) mirroring from this computer — ${enabled.map((e) => `${e.sid.slice(0, 8)} (${e.status})`).join(', ')}`);
  say('  Open the Pidge app → Agents to watch and reply. `pidge terminal disable` stops sharing.');
  say('  (This command only reports: the PreToolUse hook is what shares a session.');
  say('   To share ANOTHER session, paste the prompt above into it — `pidge terminal status` shows it.)');
  if (v.approvals) {
    say(`· --approvals is ignored here — it rides the pasted command instead: \`pidge terminal enable --approvals ${v.approvals}\``);
  }
}

// --- status / disable / disconnect ------------------------------------------

async function runStatus() {
  const env = core.loadTerminalEnv();
  say(`tunnel:   ${env.token ? `connected (channel ${env.channelId}, ${env.base})` : 'NOT connected'}`);
  const health = await daemonAlive();
  say(`daemon:   ${health ? `up (epoch ${health.epoch})` : 'DOWN'}`);
  if (health) {
    const { data } = await daemonCall('GET', '/sessions');
    const en = data.enabled || [];
    const announced = (data.announces || []).length;
    say(`sessions: ${en.length} shared${en.length ? ' — ' + en.map((e) => `${e.sid.slice(0, 8)} (${e.status})`).join(', ') : ''}`);
    say(`announced: ${announced} (local only, not shared)`);
    // The announce map is diagnostics, never a picker: a session can only be
    // shared from INSIDE itself, so this points at the prompt, not at a list.
    if (announced > en.length) {
      say('\n          To share one, paste this into that Claude session:');
      say(`          ${core.ENABLE_PROMPT}\n`);
    }
  }
  let hooksLine;
  try {
    const settings = readClaudeSettings();
    hooksLine = JSON.stringify(settings || {}).includes(PIDGE_HOOK_MARKER) ? 'installed' : 'NOT installed';
  } catch {
    // Honest: an unparseable file is not "not installed" — and `connect` will
    // refuse to rewrite it rather than destroy it.
    hooksLine = 'UNKNOWN — the file is not valid JSON (pidge will not rewrite it)';
  }
  say(`hooks:    ${hooksLine} (~/.claude/settings.json)`);
}

// The local stop ALWAYS happens (publishing ends, the session leaves state) —
// but a DELETE the server never received must not be reported as a clean stop:
// the row lives on until the retention/staleness reaper catches it, and the
// human deserves to know which of the two happened.
function sayDisabled(label, results) {
  const failed = (results || []).filter((r) => r && !r.server_ok);
  if (!failed.length) { say(`✓ stopped sharing ${label}`); return; }
  say(`✓ stopped sharing ${label} LOCALLY — nothing more is published from this computer.`);
  say(`  Could not tell the server (${failed[0].detail || 'unreachable'}); it will reap the session shortly.`);
}

async function runDisable(v) {
  if (!(await daemonAlive())) die('pidge terminal disable: daemon not running');
  if (v.all) {
    const { data } = await daemonCall('POST', '/disable', { all: true });
    sayDisabled(`${data.disabled.length} session(s)`, data.results);
    return;
  }
  // No process introspection here either (the ancestor walk is gone): a
  // single shared session is unambiguous, more than one needs a --session
  // (prefix match) or --all. Never guess WHICH share to end.
  const { data } = await daemonCall('GET', '/sessions');
  const enabled = data.enabled || [];
  const sid = v.session || null;
  const hit = sid
    ? enabled.find((e) => e.sid === sid || e.sid.startsWith(sid))
    : (enabled.length === 1 ? enabled[0] : null);
  if (!hit) {
    if (sid) die(`pidge terminal disable: no shared session matching ${JSON.stringify(sid)}`);
    if (!enabled.length) die('pidge terminal disable: nothing is being shared from this computer');
    die(`pidge terminal disable: ${enabled.length} sessions are shared — pass --session <sid> (\`pidge terminal status\` lists them) or --all`);
  }
  const { data: out } = await daemonCall('POST', '/disable', { sid: hit.sid });
  sayDisabled(hit.sid.slice(0, 8), out && out.results);
}

async function runDisconnect() {
  const health = await daemonAlive();
  if (health) { try { await daemonCall('POST', '/disable', { all: true }); } catch {} }
  uninstallHooks();
  say('✓ hooks removed from ~/.claude/settings.json');
  const svc = uninstallDaemonService();
  if (svc.removed) say(`✓ daemon uninstalled (${svc.kind})`);
  else say(`· no ${svc.kind} service to remove — if a daemon is still running (the no-systemd fallback starts one detached), stop it with: pkill -f "terminal daemon"`);
  say('· tunnel identity kept at ' + core.ENV_FILE() + ' — delete it (and the tunnel in the app) to fully unlink');
}

// --- dispatcher --------------------------------------------------------------

async function runTerminal(sub, v) {
  switch (sub) {
    case 'connect': return runConnect(v);
    case 'enable': return runEnable(v);
    case 'status': return runStatus();
    case 'disable': return runDisable(v);
    case 'disconnect': return runDisconnect();
    case 'daemon': {
      const { Daemon } = require('./daemon');
      const d = new Daemon();
      return d.run();
    }
    default:
      // `ls` (the session picker) was REMOVED with the enable lock-down: it is
      // not deprecated-but-tolerated, it is gone — sharing happens only from
      // inside the session, so a list of other people's sessions is not a door.
      die(`pidge terminal: unknown subcommand ${JSON.stringify(sub || '')} — one of: connect, enable, disable, status, disconnect, daemon`);
  }
}

module.exports = {
  runTerminal, installHooks, uninstallHooks, hookShimSource, PIDGE_HOOK_MARKER,
  installDaemonService, uninstallDaemonService, launchdPlistPath, systemdUnitPath,
  copyCliToStablePath, stableCliDir, stableCliEntry, installPidgeSkill,
  shutdownLocalDaemon,
  SYSTEMD_UNIT, LAUNCHD_LABEL,
};
