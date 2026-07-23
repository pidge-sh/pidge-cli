'use strict';
// `pidge terminal host` — the always-on daemon. One process per channel that:
//   · registers a `kind: control` session (the CONTROL LANE — where the
//     viewer app asks for the sessions list, the spawn profiles, reseeds and
//     resizes by session id),
//   · keeps the `tmux ls` INVENTORY registered server-side (one row per tmux
//     session, public_id reused so the Terminals tab never duplicates),
//   · LAZY-ATTACHES the tmux tap only while someone is actually watching a
//     session (viewer join → attach + seed; last leave → stand down after a
//     grace period) — flow control, not delivery policy,
//   · executes `spawn` STRICTLY from the profile whitelist in
//     ~/.config/pidge/terminal.toml (a viewer names a profile; the command
//     line only ever exists on this Mac),
//   · installs itself under launchd/systemd with `--install` (a template —
//     the channel key is NEVER embedded).
//
// One WebSocket, N subscriptions (control lane + every session) — the
// multiplexing client in cable.js; a daemon must not eat a connection slot
// per terminal.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createControl } = require('./control');
const { createMirror } = require('./mirror');
const { createCable } = require('./cable');
const wire = require('./wire');
const {
  execFileP, fetchLimits, bumpSessionEntry,
  preflightSealed, registerSession, endSession,
} = require('./common');
const { loadProfiles, profilesPath, expandTilde } = require('./profiles');
const { xmlEscape, systemdQuote } = require('../../bin/pidge.js');

const PROFILE_EXAMPLE = [
  '  [[profile]]',
  '  name = "Claude @ my-project"',
  '  cwd  = "~/Projects/my-project"',
  '  cmd  = "claude"',
].join('\n');

// ---------------------------------------------------------------------------
// Single instance per channel — a second daemon would double-register the
// control lane and double-attach every session. PID-checked so a crashed
// host never wedges the channel (same recovery rule as the bridge lock).
// ---------------------------------------------------------------------------
function lockFile(ctx) {
  return path.join(ctx.baseDir, `terminal-host-${ctx.channelKeyFor(ctx.TOKEN)}.lock`);
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function acquireLock(ctx) {
  const file = lockFile(ctx);
  try {
    const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cur && cur.pid && cur.pid !== process.pid && pidAlive(cur.pid)) {
      ctx.die(`pidge terminal host: another host daemon is live for this channel (pid ${cur.pid}, since ${cur.at}) — one per channel. Stop it first, or check: ps -p ${cur.pid}`, 2);
    }
  } catch { /* absent or unreadable — claimable */ }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  return () => { try { fs.unlinkSync(file); } catch { /* already gone */ } };
}

// A profile name becomes a tmux session name: whitelist charset, bounded,
// suffixed on collision ("shell", "shell-2", …).
function deriveSessionName(profileName, taken) {
  const base = (profileName.replace(/[^A-Za-z0-9_@-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'job');
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  return name;
}

async function runHost(ctx, { tmuxBin, socketArgs }) {
  const { die, note } = ctx;
  if (typeof WebSocket !== 'function') {
    die('pidge terminal host: needs a native WebSocket (Node ≥22) — frames ride the realtime socket', 2);
  }
  try { await execFileP(tmuxBin, ['-V']); } catch {
    die('pidge terminal host: tmux not found — the daemon is a tmux tap (pure JS, no PTY). Install it (macOS: brew install tmux) and retry.', 2);
  }

  const { info, mat } = await preflightSealed(ctx);

  // The whitelist is re-read when the file changes (the daemon lives under
  // launchd — the human editing terminal.toml must not need a restart).
  let prof = loadProfiles(ctx.baseDir);
  let profMtime = fs.statSync(prof.file, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  for (const w of prof.warnings) note(`pidge terminal host: profiles — ${w}`);
  if (prof.missing) {
    note(`pidge terminal host: no spawn profiles (${prof.file} not found) — viewers can watch existing sessions but not start new ones. To offer spawns, create it with entries like:\n${PROFILE_EXAMPLE}`);
  }
  function reloadProfilesIfChanged() {
    const mtime = fs.statSync(prof.file, { throwIfNoEntry: false })?.mtimeMs ?? 0;
    if (mtime === profMtime) return false;
    profMtime = mtime;
    prof = loadProfiles(ctx.baseDir);
    for (const w of prof.warnings) note(`pidge terminal host: profiles — ${w}`);
    note(`pidge terminal host: spawn profiles reloaded (${prof.profiles.length}) — publishing`);
    return true;
  }

  const releaseLock = acquireLock(ctx);

  // The control lane's own identity (its public_id anchors the ctrl seals).
  const ctrl = bumpSessionEntry(ctx, 'control', 'control');
  const hostName = os.hostname().split('.')[0] || 'mac';
  await registerSession(ctx, { publicId: ctrl.pid, name: hostName, kind: 'control' });
  const limits = await fetchLimits(ctx);

  const inventoryMs = parseInt(process.env.PIDGE_TERMINAL_INVENTORY_MS || '5000', 10) || 5000;
  const standdownMs = parseInt(process.env.PIDGE_TERMINAL_STANDDOWN_MS || '30000', 10) || 30000;
  const backoffBase = parseInt(process.env.PIDGE_TERMINAL_BACKOFF_MS || '2000', 10) || 2000;

  let stopping = false;
  let inventoryTimer = null; // set after the first inventory pass
  const records = new Map(); // tmux name → {name, entry, sub, attached, standTimer, cols, rows}
  const notedOnce = new Set();
  const noteOnce = (msg) => { if (!notedOnce.has(msg)) { notedOnce.add(msg); note(msg); } };

  const cable = createCable({
    base: ctx.BASE, token: ctx.TOKEN,
    onDown: (why) => {
      if (stopping) return;
      wsFails += 1;
      const backoff = Math.min(backoffBase * wsFails, backoffBase * 15);
      note(`pidge terminal host: relay socket ${why} — reconnecting in ${Math.round(backoff / 1000)}s (sessions untouched; viewers repaint via reseed)`);
      setTimeout(() => { if (!stopping) cable.connect(); }, backoff);
    },
  });
  let wsFails = 0;

  // ---- control lane ---------------------------------------------------------
  let ctrlSeq = 0;
  let ctrlInSeq = 0;
  let ctrlRejects = 0;
  const sealCtrl = (frame) => wire.sealFrame(mat.key, info.id, ctrl.pid, wire.AAD_CTRL_HOST, frame);
  const openCtrl = (data) => wire.openFrame(mat.key, info.id, ctrl.pid, wire.AAD_CTRL_VIEWER, data);

  function publishState() {
    const list = [...records.values()].map((r) => ({ pid: r.entry.pid, name: r.name, cols: r.cols, rows: r.rows }));
    ctrlSub.send('frame', { data: sealCtrl({ t: 'sessions', seq: ++ctrlSeq, list }) });
    ctrlSub.send('frame', { data: sealCtrl({ t: 'profiles', seq: ++ctrlSeq, names: prof.profiles.map((p) => p.name) }) });
  }

  async function handleCtrlFrame(frame) {
    if (!Number.isInteger(frame.seq) || frame.seq <= ctrlInSeq) {
      noteOnce('pidge terminal host: dropped non-monotonic control seq (replay guard)');
      return;
    }
    ctrlInSeq = frame.seq;
    if (frame.t === 'spawn') return spawn(String(frame.profile || ''));
    if (frame.t === 'reseed') {
      const rec = [...records.values()].find((r) => r.entry.pid === frame.pid);
      if (rec) (await ensureAttached(rec)).seed();
      return;
    }
    if (frame.t === 'resize') {
      const rec = [...records.values()].find((r) => r.entry.pid === frame.pid);
      if (!rec || !rec.attached) return; // resizing an unwatched session is a no-op
      const cols = Math.min(500, Math.max(20, parseInt(frame.cols, 10) || 0));
      const rows = Math.min(300, Math.max(5, parseInt(frame.rows, 10) || 0));
      if (frame.cols && frame.rows) await rec.attached.control.command(`refresh-client -C ${cols}x${rows}`);
      return;
    }
    // unknown t — a newer viewer; ignore by contract.
  }

  const ctrlSub = cable.subscribe({ session: ctrl.pid }, {
    onUp: () => { wsFails = 0; ctrlRejects = 0; publishState(); },
    onFrame: (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.sys === 'viewer') {
        if (msg.ev === 'join') { ctrlInSeq = 0; publishState(); }
        return;
      }
      if (msg.dropped) { noteOnce(`pidge terminal host: relay dropped a control frame (${msg.reason})`); return; }
      if (typeof msg.data !== 'string') return;
      const frame = openCtrl(msg.data);
      if (!frame) { noteOnce('pidge terminal host: a control frame failed to open (wrong key or corrupt) — ignored'); return; }
      handleCtrlFrame(frame).catch((e) => note(`pidge terminal host: control error: ${e.message}`));
    },
    onReject: () => {
      ctrlRejects += 1;
      if (ctrlRejects >= 2) {
        shutdown(2, 'pidge terminal host: the relay REJECTED the control subscription twice — plan gate, E2E toggled off, or a revoked session row. `pidge doctor` shows the channel state.');
      }
    },
  });

  // ---- spawn (whitelist only) ----------------------------------------------
  async function spawn(profileName) {
    const p = prof.profiles.find((x) => x.name === profileName);
    if (!p) {
      note(`pidge terminal host: spawn REFUSED — ${JSON.stringify(profileName)} is not in the whitelist (${profilesPath(ctx.baseDir)}). A viewer can only name a profile; commands live on this Mac.`);
      return;
    }
    const name = deriveSessionName(p.name, new Set(records.keys()));
    const args = [...socketArgs, 'new-session', '-d', '-s', name];
    if (p.cwd) args.push('-c', expandTilde(p.cwd));
    args.push(p.cmd);
    try {
      await execFileP(tmuxBin, args);
      await execFileP(tmuxBin, [...socketArgs, 'set-option', '-g', 'focus-events', 'on']).catch(() => {});
      note(`pidge terminal host: spawned '${name}' from profile ${JSON.stringify(p.name)}`);
      await inventory(); // register + publish without waiting a tick
    } catch (e) {
      note(`pidge terminal host: spawn of ${JSON.stringify(p.name)} failed: ${e.message}`);
    }
  }

  // ---- per-session mirrors (lazy) ------------------------------------------
  async function ensureAttached(rec) {
    if (rec.attached) return rec.attached.mirror;
    if (rec.attaching) return rec.attaching;
    rec.attaching = (async () => {
      // A fresh tap = a fresh epoch (output seq restarts; viewers reset).
      rec.entry = bumpSessionEntry(ctx, 'term', rec.name);
      const control = createControl({
        tmuxBin, socketArgs, target: rec.name,
        onOutput: (bytes) => { if (rec.attached) rec.attached.mirror.onOutput(bytes); },
        onClose: async (reason) => {
          const wasDeliberate = rec.detaching || stopping;
          rec.attached = null;
          rec.attaching = null;
          rec.detaching = false;
          if (wasDeliberate) return;
          // The tmux session died under the tap.
          note(`pidge terminal host: '${rec.name}' — ${reason}`);
          records.delete(rec.name);
          await endSession(ctx, rec.entry.pid);
          if (rec.sub) rec.sub.unsubscribe();
          publishState();
        },
      });
      const mirror = createMirror({
        control, target: rec.name, epoch: rec.entry.epoch,
        seal: (frame) => wire.sealFrame(mat.key, info.id, rec.entry.pid, wire.AAD_OUTPUT, frame),
        open: (data) => wire.openFrame(mat.key, info.id, rec.entry.pid, wire.AAD_INPUT, data),
        sendFrame: (data) => rec.sub.send('frame', { data }),
        narrate: note,
        dataMax: limits.dataMax,
        flushMs: limits.flushMs,
      });
      rec.attached = { control, mirror };
      rec.attaching = null;
      note(`pidge terminal host: attached '${rec.name}' (epoch ${rec.entry.epoch}) — someone is watching`);
      return mirror;
    })();
    return rec.attaching;
  }

  function detach(rec, why) {
    if (!rec.attached) return;
    rec.detaching = true;
    rec.attached.mirror.stop();
    rec.attached.control.kill();
    rec.attached = null;
    note(`pidge terminal host: stood down from '${rec.name}' (${why}) — reattaches on the next viewer`);
  }

  function onSessionFrame(rec, msg) {
    if (!msg || typeof msg !== 'object' || stopping) return;
    if (msg.sys === 'viewer' && msg.ev === 'leave') {
      if (!rec.attached) return;
      rec.attached.mirror.handleCable(msg);
      if (rec.attached.mirror.viewers === 0) {
        clearTimeout(rec.standTimer);
        rec.standTimer = setTimeout(() => {
          if (rec.attached && rec.attached.mirror.viewers === 0) detach(rec, 'nobody watching');
        }, standdownMs);
        if (rec.standTimer.unref) rec.standTimer.unref();
      }
      return;
    }
    // join, input, reseed, resize — all imply someone is watching: attach
    // lazily, then let the mirror handle the message (a join seeds there).
    clearTimeout(rec.standTimer);
    ensureAttached(rec)
      .then((mirror) => mirror.handleCable(msg))
      .catch((e) => note(`pidge terminal host: '${rec.name}' attach failed: ${e.message}`));
  }

  // ---- inventory -------------------------------------------------------------
  let inventoryRunning = false;
  async function inventory() {
    if (inventoryRunning || stopping) return;
    inventoryRunning = true;
    try {
      let changed = reloadProfilesIfChanged();
      const raw = await execFileP(tmuxBin, [...socketArgs, 'list-sessions', '-F', '#{session_name}\t#{window_width}\t#{window_height}'])
        .catch(() => ''); // no tmux server / no sessions — an empty inventory
      const seen = new Map();
      for (const line of raw.split('\n')) {
        const [name, cols, rows] = line.split('\t');
        if (name) seen.set(name, { cols: parseInt(cols, 10) || 80, rows: parseInt(rows, 10) || 24 });
      }
      for (const [name, size] of seen) {
        let rec = records.get(name);
        if (!rec) {
          rec = {
            name, cols: size.cols, rows: size.rows,
            entry: bumpSessionEntry(ctx, 'term', name, { bump: false }),
            attached: null, attaching: null, standTimer: null, detaching: false,
          };
          records.set(name, rec);
          const reg = await registerSession(ctx, { publicId: rec.entry.pid, name, kind: 'term' }, { fatal: false });
          if (!reg.ok) noteOnce(`pidge terminal host: registering '${name}' failed (${reg.status}) — it stays unlisted until the next inventory pass`);
          rec.sub = cable.subscribe({ session: rec.entry.pid }, {
            onUp: () => { if (rec.attached) rec.attached.mirror.onRelayUp(); },
            onFrame: (msg) => onSessionFrame(rec, msg),
            onReject: () => noteOnce(`pidge terminal host: relay rejected the subscription for '${name}'`),
          });
          changed = true;
        } else if (rec.cols !== size.cols || rec.rows !== size.rows) {
          rec.cols = size.cols;
          rec.rows = size.rows;
          changed = true;
        }
      }
      for (const [name, rec] of [...records]) {
        if (seen.has(name)) continue;
        // the tmux session is gone — end the row, drop the tap.
        clearTimeout(rec.standTimer);
        detach(rec, 'session ended');
        records.delete(name);
        await endSession(ctx, rec.entry.pid);
        if (rec.sub) rec.sub.unsubscribe();
        note(`pidge terminal host: '${name}' ended — row marked ended`);
        changed = true;
      }
      if (changed) publishState();
    } finally {
      inventoryRunning = false;
    }
  }

  // ---- lifecycle -------------------------------------------------------------
  async function shutdown(code = 0, message = null) {
    if (stopping) return;
    stopping = true;
    if (message) console.error(message);
    clearInterval(inventoryTimer);
    for (const rec of records.values()) {
      clearTimeout(rec.standTimer);
      detach(rec, 'host shutting down');
    }
    // Session rows stay (the tmux sessions keep running — they read offline
    // once the heartbeat lapses); the CONTROL row is this process, so it ends.
    await endSession(ctx, ctrl.pid);
    cable.close();
    releaseLock();
    note('pidge terminal host: stopped — tmux sessions keep running; restart the host to mirror again');
    process.exit(code);
  }
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  cable.connect();
  await inventory();
  inventoryTimer = setInterval(inventory, inventoryMs);

  console.log(JSON.stringify({
    ok: true, control_public_id: ctrl.pid, host: hostName,
    profiles: prof.profiles.map((p) => p.name), sessions: records.size,
  }));
  note(`pidge terminal host: up — control lane '${hostName}' (${records.size} session(s), ${prof.profiles.length} profile(s)); watching tmux every ${Math.round(inventoryMs / 1000)}s. SIGTERM stops the mirror; tmux sessions are never touched.`);
}

// ---------------------------------------------------------------------------
// `pidge terminal host --install` — write the launchd (Mac) / systemd user
// (Linux) TEMPLATE that keeps the daemon running. Same contract as the
// bridge's installer: review-then-enable, Restart=on-failure semantics, the
// channel key NEVER embedded (it stays in the config file).
// ---------------------------------------------------------------------------
function installHost(ctx) {
  const platform = process.env.PIDGE_TERMINAL_PLATFORM || process.platform;
  const nodeBin = process.execPath;
  const cli = require.resolve('../../bin/pidge.js');
  const agentId = (process.env.PIDGE_AGENT || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
  const nameSuffix = agentId ? `.${agentId}` : '';
  const envPairs = {};
  for (const k of ['PIDGE_URL', 'PIDGE_AGENT', 'XDG_CONFIG_HOME', 'PIDGE_TMUX_BIN', 'PIDGE_TMUX_SOCKET', 'PATH']) {
    if (process.env[k]) envPairs[k] = process.env[k];
  }
  if (!ctx.tokenFromFile) {
    console.error(`pidge: terminal host install — WARNING: your key lives ONLY in this shell's env; the daemon won't inherit it (the template NEVER embeds secrets). Put it in the config file first — re-run \`pidge setup --claim <code>\`, or write PIDGE_TOKEN=… to the env file yourself (chmod 600).`);
  }
  if (/[\\/]_npx[\\/]/.test(cli)) {
    console.error('pidge: terminal host install — WARNING: this CLI is running from the npx CACHE — the generated template points into it and BREAKS when npx prunes. Install it durably first (npm i -g pidge-cli) and re-run.');
  }

  let file, enable;
  if (platform === 'darwin') {
    const label = `sh.pidge.terminal-host${nameSuffix}`;
    const envBlock = Object.keys(envPairs).length
      ? `  <key>EnvironmentVariables</key>\n  <dict>\n${Object.entries(envPairs).map(([k, val]) => `    <key>${xmlEscape(k)}</key><string>${xmlEscape(val)}</string>`).join('\n')}\n  </dict>\n`
      : '';
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<!-- generated by \`pidge terminal host --install\`. A TEMPLATE: review, then
     launchctl load -w <this file>
     The channel key stays in ~/.config/pidge/env — NEVER embedded here. -->
<dict>
  <key>Label</key><string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodeBin)}</string>
    <string>${xmlEscape(cli)}</string>
    <string>terminal</string>
    <string>host</string>
  </array>
  <key>RunAtLoad</key><true/>
  <!-- Restart=on-failure: a clean exit 0 (SIGTERM shutdown / launchctl unload) stays down -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
${envBlock}  <key>StandardOutPath</key><string>${xmlEscape(path.join(ctx.configDir, 'terminal-host.log'))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(path.join(ctx.configDir, 'terminal-host.err.log'))}</string>
</dict>
</plist>
`;
    const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, `${label}.plist`);
    fs.writeFileSync(file, plist);
    enable = `launchctl load -w "${file}"`;
  } else {
    const name = `pidge-terminal-host${nameSuffix}.service`;
    const envLines = Object.entries(envPairs).map(([k, val]) => `Environment=${systemdQuote(`${k}=${val}`)}`).join('\n');
    const unit = `# generated by \`pidge terminal host --install\`. A TEMPLATE: review, then
#   systemctl --user daemon-reload && systemctl --user enable --now ${name}
# The channel key stays in ~/.config/pidge/env — NEVER embedded here.
[Unit]
Description=pidge terminal host — sealed tmux mirror daemon (Terminals tab)
Wants=network-online.target
After=network-online.target

[Service]
ExecStart=${systemdQuote(nodeBin)} ${systemdQuote(cli)} terminal host
Restart=on-failure
RestartSec=10
${envLines ? envLines + '\n' : ''}StandardOutput=append:${path.join(ctx.configDir, 'terminal-host.log')}
StandardError=append:${path.join(ctx.configDir, 'terminal-host.err.log')}

[Install]
WantedBy=default.target
`;
    const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, name);
    fs.writeFileSync(file, unit);
    enable = `systemctl --user daemon-reload && systemctl --user enable --now ${name}`;
  }
  console.error(`pidge: terminal host install — template written to ${file} (Restart=on-failure semantics; logs → ${path.join(ctx.configDir, 'terminal-host.log')})`);
  console.error(`pidge: enable it with:  ${enable}`);
  console.error(`pidge: spawn profiles live in ${profilesPath(ctx.baseDir)} — entries like:\n${PROFILE_EXAMPLE}`);
  console.log(JSON.stringify({ ok: true, file, platform: platform === 'darwin' ? 'launchd' : 'systemd' }, null, 2));
  process.exit(0);
}

module.exports = { runHost, installHost, deriveSessionName };
