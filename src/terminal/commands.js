'use strict';
// `pidge terminal <sub>` — the user-facing side of Agent Sessions v1
// (agent-sessions-spec §2). connect = once per computer (claim exchange + consent +
// hooks + daemon install); enable = per session, through the ONE door: the
// ancestor walk from inside the running claude ("enable yourself on Pidge");
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

  let token = existing.token;
  let channelId = existing.channelId;
  let effectiveBase = existing.base || base;
  let secret = secretRaw || existing.secret;

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
    if (data.channel && data.channel.kind !== 'tunnel') {
      die(`pidge terminal connect: this code belongs to a ${data.channel.kind || 'standard'} channel, not a tunnel — use the app's Settings → Computers → Connect a computer flow (it mints the right kind)`);
    }
  }
  if (!token) die('pidge terminal connect: no stored identity and no --code — paste the one-liner from the app (Settings → Computers → Connect a computer)');
  if (!secret) die('pidge terminal connect: PIDGE_SECRET missing — the app\'s Connect-a-computer one-liner carries it (E2E is mandatory on tunnels; there is no clear mode)');
  try { core.e2eParseSecret(secret); } catch (e) { die(`pidge terminal connect: ${e.message}`); }

  core.saveTerminalEnv({ base: effectiveBase, token, secret, channelId });
  say(`✓ tunnel identity stored (${core.ENV_FILE()}, 0600)`);

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
    say('· hooks NOT installed — sessions cannot announce; `pidge terminal enable` will refuse until you re-run connect');
  }

  // Daemon config + this computer's service manager (--no-daemon skips the
  // install on EVERY platform — the manual line is the same everywhere).
  const cfg = core.readJson(core.DAEMON_FILE(), null) || { port: DAEMON_PORT, token: crypto.randomBytes(24).toString('base64url') };
  core.writeJson(core.DAEMON_FILE(), cfg);
  if (v['no-daemon']) {
    say('· --no-daemon: start it yourself with `pidge terminal daemon`');
  } else {
    const svc = installDaemonService();
    if (svc.kind === 'launchd') say(`✓ daemon installed (launchd ${svc.label}) — logs at ${core.LOG_FILE()}`);
    else if (svc.kind === 'systemd') {
      say(`✓ daemon installed (systemd --user ${svc.label}) — logs at ${core.LOG_FILE()}`);
      say('  (survive logout: `loginctl enable-linger $USER`)');
    } else say(`· daemon logs at ${core.LOG_FILE()}`);
  }
  say('\nDone. Start (or restart) claude inside a tmux pane, then tell it\n"enable yourself on Pidge" — that is the only way to share a session.');
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

// node + the CLI entry point the service will run. Shared by every branch.
function daemonExec() {
  const nodeBin = process.execPath;
  const cli = require.main ? require.main.filename : path.join(__dirname, '..', '..', 'bin', 'pidge.js');
  if (/[\\/]_npx[\\/]/.test(cli)) {
    console.error('pidge terminal: WARNING — running from the npx CACHE; the service template points into it and BREAKS when npx prunes. Install durably (npm i -g pidge-cli) and re-run `pidge terminal connect`.');
  }
  return { nodeBin, cli };
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
  const envBlock = process.env.PATH
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key><string>${xmlEscape(process.env.PATH)}</string>\n  </dict>\n`
    : '';
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
  const envPairs = {};
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

// --- enable (the ancestor walk — spec §2's ONE door) ------------------------

// `command`, `ppid` and `tty` are POSIX/GNU `ps` output specs — identical on
// macOS (BSD ps) and Linux (procps).
function psField(pid, field) {
  try {
    return execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch { return ''; }
}

// `ps -o tty=` prints a SHORT name (`ttys003` on macOS, `pts/3` on Linux) that
// must become the absolute path tmux reports as `#{pane_tty}` (`/dev/pts/3`).
// "no controlling tty" is `??` on macOS but a single `?` on Linux — reading
// that as a name yields the nonexistent `/dev/?`, and the pane lookup then
// fails with a confusing message instead of the honest "no tty" refusal.
function ttyPath(short) {
  const t = String(short || '').trim();
  if (!t || /^\?+$/.test(t)) return null;
  return t.startsWith('/') ? t : `/dev/${t}`;
}

// The working directory of another process. `/proc/<pid>/cwd` is a symlink on
// Linux — free, always present, and lsof frequently is NOT installed on a
// minimal distro or container. macOS has no /proc, so it falls through to lsof.
function processCwd(pid) {
  try {
    const link = fs.readlinkSync(`/proc/${pid}/cwd`);
    if (link) return link.replace(/ \(deleted\)$/, '');
  } catch {}
  try {
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
    const m = out.split('\n').find((l) => l.startsWith('n'));
    return m ? m.slice(1) : null;
  } catch {}
  return null;
}

function isClaudeCommand(c) {
  return /(^|\/|\s)claude(\s|$)/.test(c) || /\.claude\/.*\/(cli|claude)/.test(c) || /claude-code/.test(c);
}

// Walk UP from this process to the claude ancestor; return {pid, tty, cwd}.
// Refuses loudly when the tree is opaque (spec: never guess).
function findClaudeAncestor() {
  let pid = process.ppid;
  for (let hops = 0; hops < 20 && pid > 1; hops++) {
    const command = psField(pid, 'command');
    if (isClaudeCommand(command)) {
      return { pid, tty: ttyPath(psField(pid, 'tty')), cwd: processCwd(pid) };
    }
    const up = psField(pid, 'ppid');
    if (!up) break;
    pid = Number(up);
  }
  return null;
}

// The pane lookup lives in core so the CLI and the daemon bind identically.
function paneForTty(tty) { return core.tmuxPaneForTty(tty); }

// The ONE door (spec §2, locked down): no picker, no `--session`, no pane-less
// share. Anything that isn't "a claude ancestor, in a tmux pane" refuses with
// the single instruction that fixes it — never a guess, never a read-only tier.
async function runEnable(v) {
  if (!(await daemonAlive())) die('pidge terminal enable: the local daemon is not running — run `pidge terminal connect` (or `pidge terminal daemon` in another shell) first');
  const approvals = v.approvals ? String(v.approvals).split(',').map((s) => s.trim()).filter(Boolean) : [];

  // No claude ancestor (a bare terminal) · a claude with no controlling tty ·
  // a tty that is not a tmux pane — three ways to be un-shareable, ONE answer.
  const claude = findClaudeAncestor();
  const pane = claude && claude.tty ? paneForTty(claude.tty) : null;
  if (!pane) die(core.ENABLE_REFUSAL);
  const target = { tty: claude.tty, cwd: claude.cwd, pane_id: pane.paneId, loc: pane.loc };

  const { res, data } = await daemonCall('POST', '/enable', { ...target, approvals });
  if (res.status !== 200) die(`pidge terminal enable: ${data && data.error ? data.error : `daemon answered ${res.status}`}`);
  if (data.already) {
    say(`✓ this session is already shared (${data.public_id})`);
    return;
  }
  say(`✓ session shared → ${data.public_id}${target.loc ? ` (pane ${target.loc})` : ''}`);
  if (data.backfilled) say(`  seeded ${data.backfilled} recent items; earlier history stays on this computer`);
  say('  Open the Pidge app → Agents to watch and reply. `pidge terminal disable` stops sharing.');
  if (approvals.length) say(`  approval gate ON for: ${approvals.join(', ')}`);
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
    // shared from inside itself, so this points at the prompt, not at a list.
    if (announced > en.length) {
      say('          share one by telling that Claude "enable yourself on Pidge" (from inside its tmux pane)');
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
  let sid = v.session || null;
  if (!sid) {
    const claude = findClaudeAncestor();
    if (claude && claude.tty) {
      const { data } = await daemonCall('GET', '/sessions');
      const ann = (data.announces || []).find((a) => a.tty === claude.tty);
      if (ann) sid = ann.sid;
    }
  }
  if (!sid) die('pidge terminal disable: run it from inside the shared Claude session, or pass --session <sid> (`pidge terminal status` lists them) or --all');
  // Prefix match against enabled sessions for convenience.
  const { data } = await daemonCall('GET', '/sessions');
  const hit = (data.enabled || []).find((e) => e.sid === sid || e.sid.startsWith(sid));
  if (!hit) die(`pidge terminal disable: no shared session matching ${JSON.stringify(sid)}`);
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
  ttyPath, processCwd, SYSTEMD_UNIT, LAUNCHD_LABEL,
};
