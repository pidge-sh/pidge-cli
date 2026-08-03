'use strict';
// `pidge terminal <sub>` — the user-facing side of Agent Sessions v1
// (agent-sessions-spec §2). connect = once per Mac (claim exchange + consent +
// hooks + daemon install); enable = per session, via the ancestor walk (the
// "enable yourself on Pidge" prompt door) or the `ls` picker; disable/status/
// disconnect complete the lifecycle. Everything session-scoped talks to the
// LOCAL daemon over loopback — commands never publish anything themselves.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { execFileSync } = require('child_process');
const core = require('./core');

const PIDGE_HOOK_MARKER = '# pidge-hook';
const DAEMON_PORT = 41717;
const LAUNCHD_LABEL = 'sh.pidge.terminal';
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
    if (res.status === 404) die('pidge terminal connect: that code is unknown, expired or already used by another machine — mint a fresh one in the app (Settings → Tunnels → Link a Mac)');
    if (!res.ok) die(`pidge terminal connect: claim exchange failed (${res.status})`);
    const data = await res.json();
    token = data.key;
    channelId = data.channel && data.channel.id;
    effectiveBase = (data.base_url || base).replace(/\/$/, '');
    if (data.channel && data.channel.kind !== 'tunnel') {
      die(`pidge terminal connect: this code belongs to a ${data.channel.kind || 'standard'} channel, not a tunnel — use the app's Settings → Tunnels → Link a Mac flow (it mints the right kind)`);
    }
  }
  if (!token) die('pidge terminal connect: no stored identity and no --code — paste the one-liner from the app (Settings → Tunnels → Link a Mac)');
  if (!secret) die('pidge terminal connect: PIDGE_SECRET missing — the app\'s Link-a-Mac one-liner carries it (E2E is mandatory on tunnels; there is no clear mode)');
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
    'Hooks talk only to this Mac; nothing is shared until you enable a session.');
  if (consent) {
    writeHookShim();
    // A malformed ~/.claude/settings.json aborts the install LOUDLY: we never
    // overwrite a config we could not read (see readClaudeSettings).
    try { installHooks(); } catch (e) { die(`${e.message}\n(the tunnel identity above is stored; re-run \`pidge terminal connect\` once the file parses)`); }
    say('✓ hooks installed in ~/.claude/settings.json (tagged, cleanly removable via `pidge terminal disconnect`)');
  } else {
    say('· hooks NOT installed — sessions cannot announce; `pidge terminal enable` will refuse until you re-run connect');
  }

  // Daemon config + launchd.
  const cfg = core.readJson(core.DAEMON_FILE(), null) || { port: DAEMON_PORT, token: crypto.randomBytes(24).toString('base64url') };
  core.writeJson(core.DAEMON_FILE(), cfg);
  if (v['no-daemon']) {
    say('· --no-daemon: start it yourself with `pidge terminal daemon`');
  } else {
    installLaunchd();
    say(`✓ daemon installed (launchd ${LAUNCHD_LABEL}) — logs at ${core.LOG_FILE()}`);
  }
  say('\nDone. Start (or restart) claude inside a tmux pane, then tell it\n"enable yourself on Pidge" — or run `pidge terminal ls` to pick a session.');
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
    body.tty = (() => {
      try {
        const t = execFileSync('ps', ['-o', 'tty=', '-p', String(process.pid)], { encoding: 'utf8' }).trim();
        return t && t !== '??' ? '/dev/' + t : null;
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

// --- launchd ----------------------------------------------------------------

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function launchdPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function installLaunchd() {
  const nodeBin = process.execPath;
  const cli = require.main ? require.main.filename : path.join(__dirname, '..', '..', 'bin', 'pidge.js');
  if (/[\\/]_npx[\\/]/.test(cli)) {
    console.error('pidge terminal: WARNING — running from the npx CACHE; the launchd template points into it and BREAKS when npx prunes. Install durably (npm i -g pidge-cli) and re-run `pidge terminal connect`.');
  }
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
  try { execFileSync('launchctl', ['unload', file], { stdio: 'ignore' }); } catch {}
  try {
    execFileSync('launchctl', ['load', '-w', file], { stdio: 'ignore' });
  } catch (e) {
    console.error(`pidge terminal: launchctl load failed (${e.message}) — start manually: launchctl load -w "${file}"`);
  }
}

// --- enable (the ancestor walk — spec §2's prompt door) ---------------------

function psField(pid, field) {
  try {
    return execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch { return ''; }
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
      const ttyShort = psField(pid, 'tty');
      const tty = ttyShort && ttyShort !== '??' ? `/dev/${ttyShort}` : null;
      let cwd = null;
      try {
        const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
        const m = out.split('\n').find((l) => l.startsWith('n'));
        cwd = m ? m.slice(1) : null;
      } catch {}
      return { pid, tty, cwd };
    }
    const up = psField(pid, 'ppid');
    if (!up) break;
    pid = Number(up);
  }
  return null;
}

function paneForTty(tty) {
  try {
    const out = execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_id}\t#{pane_tty}\t#{session_name}:#{window_index}.#{pane_index}'], { encoding: 'utf8' });
    for (const line of out.trim().split('\n')) {
      const [paneId, paneTty, loc] = line.split('\t');
      if (paneTty === tty) return { paneId, loc };
    }
  } catch {}
  return null;
}

async function runEnable(v) {
  if (!(await daemonAlive())) die('pidge terminal enable: the local daemon is not running — run `pidge terminal connect` (or `pidge terminal daemon` in another shell) first');
  const approvals = v.approvals ? String(v.approvals).split(',').map((s) => s.trim()).filter(Boolean) : [];

  let target;
  if (v.session) {
    target = { sid: v.session };
  } else {
    const claude = findClaudeAncestor();
    if (!claude) {
      die('pidge terminal enable: no claude ancestor found in this process tree.\n' +
          'This command is meant to run FROM INSIDE a Claude Code session ("enable yourself on Pidge").\n' +
          'Fallback: `pidge terminal ls` lists shareable sessions; enable one with `pidge terminal enable --session <sid>`.');
    }
    if (!claude.tty) {
      die('pidge terminal enable: the claude ancestor has no controlling tty — cannot bind a tmux pane.\n' +
          'v1 shares only sessions running INSIDE tmux (start: `tmux`, then `claude`).');
    }
    const pane = paneForTty(claude.tty);
    if (!pane) {
      die(`pidge terminal enable: claude's tty (${claude.tty}) is not a tmux pane.\n` +
          'v1 shares only sessions running INSIDE tmux — start claude inside tmux and retry.');
    }
    target = { tty: claude.tty, cwd: claude.cwd, pane_id: pane.paneId, loc: pane.loc };
  }

  const { res, data } = await daemonCall('POST', '/enable', { ...target, approvals });
  if (res.status !== 200) die(`pidge terminal enable: ${data && data.error ? data.error : `daemon answered ${res.status}`}`);
  if (data.already) {
    say(`✓ this session is already shared (${data.public_id})`);
  } else {
    say(`✓ session shared → ${data.public_id}${target.loc ? ` (pane ${target.loc})` : ''}`);
    if (data.backfilled) say(`  seeded ${data.backfilled} recent items; earlier history stays on this Mac`);
    say('  Open the Pidge app → Agents to watch and reply. `pidge terminal disable` stops sharing.');
    if (approvals.length) say(`  approval gate ON for: ${approvals.join(', ')}`);
  }
}

// --- ls / status / disable / disconnect -------------------------------------

async function runLs() {
  const health = await daemonAlive();
  if (!health) die('pidge terminal ls: the local daemon is not running — run `pidge terminal connect` first');
  const { data } = await daemonCall('GET', '/sessions');
  let panes = [];
  try {
    panes = execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_id}\t#{pane_tty}\t#{pane_current_command}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_current_path}'], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean).map((l) => {
        const [paneId, tty, cmd, loc, cwd] = l.split('\t');
        return { paneId, tty, cmd, loc, cwd };
      });
  } catch { say('(no tmux server running — only announced sessions shown)'); }

  const enabledBySid = new Map((data.enabled || []).map((e) => [e.sid, e]));
  const announceByTty = new Map((data.announces || []).map((a) => [a.tty, a]));
  const rows = [];
  for (const p of panes) {
    const ann = announceByTty.get(p.tty);
    const looksAgent = /^(claude|node)$/.test(p.cmd) || ann;
    if (!looksAgent) continue;
    if (ann) {
      const en = enabledBySid.get(ann.sid);
      rows.push(`${p.loc.padEnd(16)} ${ann.sid.slice(0, 8)}  ${path.basename(ann.cwd || p.cwd)}  ${en ? `SHARED (${en.status})` : 'shareable'}`);
    } else {
      rows.push(`${p.loc.padEnd(16)} ${'—'.padEnd(8)}  ${path.basename(p.cwd)}  restart claude to share (no announcement)`);
    }
  }
  for (const a of data.announces || []) {
    if (panes.some((p) => p.tty === a.tty)) continue;
    const en = enabledBySid.get(a.sid);
    rows.push(`${'(no tmux pane)'.padEnd(16)} ${a.sid.slice(0, 8)}  ${path.basename(a.cwd || '?')}  ${en ? `SHARED (${en.status})` : 'not shareable (outside tmux)'}`);
  }
  if (!rows.length) { say('no claude sessions found — start claude inside a tmux pane'); return; }
  say('PANE             SESSION   PROJECT  STATE');
  for (const r of rows) say(r);
  say('\nenable: tell that claude "enable yourself on Pidge", or `pidge terminal enable --session <sid>`');
}

async function runStatus() {
  const env = core.loadTerminalEnv();
  say(`tunnel:   ${env.token ? `connected (channel ${env.channelId}, ${env.base})` : 'NOT connected'}`);
  const health = await daemonAlive();
  say(`daemon:   ${health ? `up (epoch ${health.epoch})` : 'DOWN'}`);
  if (health) {
    const { data } = await daemonCall('GET', '/sessions');
    const en = data.enabled || [];
    say(`sessions: ${en.length} shared${en.length ? ' — ' + en.map((e) => `${e.sid.slice(0, 8)} (${e.status})`).join(', ') : ''}`);
    say(`announced: ${(data.announces || []).length} (local only, not shared)`);
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

async function runDisable(v) {
  if (!(await daemonAlive())) die('pidge terminal disable: daemon not running');
  if (v.all) {
    const { data } = await daemonCall('POST', '/disable', { all: true });
    say(`✓ disabled ${data.disabled.length} session(s)`);
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
  if (!sid) die('pidge terminal disable: pass --session <sid> (see `pidge terminal ls`) or --all');
  // Prefix match against enabled sessions for convenience.
  const { data } = await daemonCall('GET', '/sessions');
  const hit = (data.enabled || []).find((e) => e.sid === sid || e.sid.startsWith(sid));
  if (!hit) die(`pidge terminal disable: no shared session matching ${JSON.stringify(sid)}`);
  await daemonCall('POST', '/disable', { sid: hit.sid });
  say(`✓ stopped sharing ${hit.sid.slice(0, 8)}`);
}

async function runDisconnect() {
  const health = await daemonAlive();
  if (health) { try { await daemonCall('POST', '/disable', { all: true }); } catch {} }
  uninstallHooks();
  say('✓ hooks removed from ~/.claude/settings.json');
  const file = launchdPlistPath();
  try { execFileSync('launchctl', ['unload', '-w', file], { stdio: 'ignore' }); } catch {}
  try { fs.unlinkSync(file); say('✓ daemon uninstalled (launchd)'); } catch {}
  say('· tunnel identity kept at ' + core.ENV_FILE() + ' — delete it (and the tunnel in the app) to fully unlink');
}

// --- dispatcher --------------------------------------------------------------

async function runTerminal(sub, v) {
  switch (sub) {
    case 'connect': return runConnect(v);
    case 'enable': return runEnable(v);
    case 'ls': return runLs();
    case 'status': return runStatus();
    case 'disable': return runDisable(v);
    case 'disconnect': return runDisconnect();
    case 'daemon': {
      const { Daemon } = require('./daemon');
      const d = new Daemon();
      return d.run();
    }
    default:
      die(`pidge terminal: unknown subcommand ${JSON.stringify(sub || '')} — one of: connect, ls, enable, disable, status, disconnect, daemon`);
  }
}

module.exports = { runTerminal, installHooks, uninstallHooks, hookShimSource, PIDGE_HOOK_MARKER };
