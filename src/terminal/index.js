'use strict';
// `pidge terminal` — mirror a real tmux session to the human's phone/Mac,
// live, with input coming back. The agent running INSIDE tmux needs no
// integration: this process is a transparent tap (tmux control mode) that
// seals every frame with the channel key and relays through the server,
// which forwards ciphertext blind.
//
// ISOLATION: this module owns the terminal feature end to end. It imports
// the CLI's pure crypto through the bin/pidge.js test seam (wire.js) and
// receives the LIVE pieces — the cable client, config/identity, HTTP — as an
// injected context from the dispatch site, so nothing here reaches into the
// CLI's runtime state and the module stays testable with fakes.
//
// SEALED-ONLY (no escape hatch): no E2E channel or no valid PIDGE_SECRET ⇒
// refuse to start, loudly, with the enable instructions. There is no
// clear-text terminal path — a terminal leaks env vars, tokens and code.

const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const { createControl } = require('./control');
const { createMirror } = require('./mirror');
const wire = require('./wire');

const USAGE = 'pidge: usage: pidge terminal [--name NAME] [-- CMD…]  ·  pidge terminal attach <tmux-session>';

// tmux forbids ':' and '.' in session names; the mirror stays stricter (the
// name is also CLEAR server-side metadata and rides tmux command lines).
const SESSION_NAME = /^[A-Za-z0-9_@-]{1,64}$/;

const execFileP = (bin, args) => new Promise((resolve, reject) => {
  execFile(bin, args, { timeout: 10000 }, (err, stdout, stderr) => {
    if (err) reject(new Error((stderr || err.message || '').trim() || 'command failed'));
    else resolve(stdout);
  });
});

// Wire limits come from the served manifest (generated from the server's live
// constants — hardcoding them WILL drift). The section narrates them in prose,
// so the numbers are extracted tolerantly; the protocol's shipped values are
// the fallback when the section (or the fetch) is missing.
async function fetchLimits(ctx) {
  const limits = { frameCap: 64 * 1024, fps: 30 };
  try {
    const res = await ctx.fetchT(`${ctx.BASE}/api/v1/manifest`, { headers: ctx.headers });
    const m = await res.json();
    const relay = (m && m.terminal && m.terminal.relay) || '';
    const cap = /\(>\s*(\d+)\s*KB\)/.exec(relay);
    const fps = /~?(\d+)\s*frames\/s/.exec(relay);
    if (cap) limits.frameCap = parseInt(cap[1], 10) * 1024;
    if (fps) limits.fps = parseInt(fps[1], 10);
  } catch { /* served defaults double as the offline fallback */ }
  // Raw bytes per output frame: base64 + JSON + envelope ≈ 16/9 blow-up, so
  // stay at 9/16 of the cap with headroom — and never above the protocol's
  // own 16 KB chunk.
  limits.dataMax = Math.min(wire.DATA_MAX_BYTES, Math.floor((limits.frameCap * 9) / 16) - 512);
  // Flush at half the allowed rate at most (coalescing is the contract).
  limits.flushMs = Math.max(parseInt(process.env.PIDGE_TERMINAL_FLUSH_MS || '80', 10) || 80,
    Math.ceil(2000 / Math.max(1, limits.fps)));
  return limits;
}

// The per-(channel, tmux-name) identity: public_id anchors every seal (minted
// BEFORE anything is sealed, reused across host restarts so the Terminals tab
// keeps ONE row per session), epoch bumps per host process so viewers reset
// their gap detector.
function bumpSessionEntry(ctx, name) {
  const key = ctx.channelKeyFor(ctx.TOKEN) || 'default';
  const all = ctx.readState().terminalSessions || {};
  const chan = all[key] || {};
  const entry = chan[name] || { pid: `term_${crypto.randomUUID()}`, epoch: 0 };
  entry.epoch += 1;
  ctx.writeState({ terminalSessions: { ...all, [key]: { ...chan, [name]: entry } } });
  return entry;
}

async function preflightSealed(ctx) {
  let info;
  try {
    info = await ctx.e2eChannelInfo();
  } catch (e) {
    ctx.die(`pidge terminal: cannot reach the server to verify the channel's E2E state (${e.message}) — the mirror is sealed-only and never starts unverified`, 2);
  }
  if (!info.e2eEnabled) {
    ctx.die([
      'pidge terminal: REFUSING to start — terminal mirroring is SEALED-ONLY and this channel is not end-to-end encrypted.',
      'A terminal leaks env vars, tokens and code, so there is no clear-text path (no flag overrides this).',
      'Fix: ask your human to turn ON end-to-end encryption for this channel in the Pidge app, run the Connect screen\'s',
      'TERMINAL step (it writes PIDGE_SECRET into this install\'s env file — never paste the secret in chat), then retry.',
      '`pidge doctor` confirms the E2E state.',
    ].join('\n'), 2);
  }
  const mat = ctx.e2eKeyMaterial();
  if (!mat) {
    ctx.die([
      'pidge terminal: REFUSING to start — the channel is E2E but this install has no (valid) PIDGE_SECRET, so frames could not be sealed.',
      'Fix: the Pidge app\'s Connect screen shows a TERMINAL step that writes PIDGE_SECRET next to the token (never paste the secret',
      'in chat). Run that, confirm with `pidge doctor`, then retry.',
    ].join('\n'), 2);
  }
  return { info, mat };
}

async function registerSession(ctx, publicId, name) {
  let res, data;
  try {
    res = await ctx.fetchT(`${ctx.BASE}/api/v1/terminal_sessions`, {
      method: 'POST', headers: ctx.headers,
      body: JSON.stringify({ public_id: publicId, name, kind: 'term' }),
    });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    ctx.die(`pidge terminal: registering the session failed (network): ${e.message}`, 2);
  }
  await ctx.checkManifestNews(res);
  if (res.status === 402) {
    // Typed plan gate — the message is written by the server to be RELAYED.
    // Never retried: only the human upgrading changes the answer.
    ctx.die(`pidge: ${data.message || 'terminal mirroring is a Pro feature and this account is not on Pro'}\npidge: (plan gate — do not retry; everything else on this key keeps working)`, 2);
  }
  if (res.status === 422 && data.code === 'e2e_required') {
    ctx.die('pidge terminal: the server refused the register — this channel is not E2E (sealed-only is enforced server-side too). Ask your human to enable E2E in the app, then retry.', 2);
  }
  if (res.status !== 201) {
    ctx.die(`pidge terminal: register failed (${res.status}): ${JSON.stringify(data)}`, 2);
  }
}

// Quote one argv word for the single shell-command string tmux new-session
// takes (wrapped commands run under the user's shell inside the pane).
const shellWord = (a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);

module.exports = async function runTerminal(ctx) {
  const { die, note } = ctx;

  const tmuxBin = process.env.PIDGE_TMUX_BIN || 'tmux';
  // Test/ops hook: an isolated tmux server (-L) so suites never touch the
  // user's real sessions.
  const socketArgs = process.env.PIDGE_TMUX_SOCKET ? ['-L', process.env.PIDGE_TMUX_SOCKET] : [];

  // `pidge terminal -- CMD…`: everything after the first `--` is the wrapped
  // command, verbatim (parseArgs read those tokens as positionals — carve
  // them off the tail before reading OUR subcommand words).
  const ddi = ctx.rawArgv.indexOf('--');
  const wrapped = ddi === -1 ? [] : ctx.rawArgv.slice(ddi + 1);
  const sub = ctx.positionals.slice(1, ctx.positionals.length - wrapped.length);

  let name;
  let creating = false;
  if (sub[0] === 'attach') {
    name = sub[1];
    if (!name) die(USAGE, 1);
    if (sub.length > 2) die(USAGE, 1);
  } else if (sub.length > 0) {
    die(USAGE, 1);
  } else {
    creating = true;
    name = ctx.values.name || `pidge-${crypto.randomBytes(2).toString('hex')}`;
  }
  if (!SESSION_NAME.test(name)) {
    die(`pidge terminal: session name ${JSON.stringify(name)} — use 1-64 of letters, digits, _ @ - (tmux forbids ':' and '.')`, 1);
  }

  try { await execFileP(tmuxBin, ['-V']); } catch {
    die('pidge terminal: tmux not found — the mirror is a tmux tap (pure JS, no PTY). Install it (macOS: brew install tmux) and retry.', 2);
  }

  const { info, mat } = await preflightSealed(ctx);

  // Checked AFTER usage + the sealed-only preflight (those errors are the
  // actionable ones) but BEFORE any tmux session is created or registered —
  // an old runtime must leave zero side effects behind.
  if (typeof WebSocket !== 'function') {
    die('pidge terminal: needs a native WebSocket (Node ≥22) — frames ride the realtime socket, there is no polling floor for a terminal', 2);
  }

  const hasSession = await execFileP(tmuxBin, [...socketArgs, 'has-session', '-t', `=${name}`]).then(() => true, () => false);
  if (creating) {
    if (hasSession) die(`pidge terminal: tmux session '${name}' already exists — mirror it with: pidge terminal attach ${name}`, 1);
    const args = [...socketArgs, 'new-session', '-d', '-s', name];
    if (wrapped.length) args.push(wrapped.map(shellWord).join(' '));
    try { await execFileP(tmuxBin, args); } catch (e) {
      die(`pidge terminal: tmux new-session failed: ${e.message}`, 2);
    }
    // Claude Code (and every focus-aware TUI) asks for focus events.
    await execFileP(tmuxBin, [...socketArgs, 'set-option', '-g', 'focus-events', 'on']).catch(() => {});
  } else if (!hasSession) {
    die(`pidge terminal: no tmux session named '${name}' (tmux ls shows what exists)`, 2);
  }

  const entry = bumpSessionEntry(ctx, name);
  await registerSession(ctx, entry.pid, name);
  const limits = await fetchLimits(ctx);

  let stopping = false;
  let cableHandle = null;   // the LIVE (confirmed) subscription, or null
  let mirror = null;

  const control = createControl({
    tmuxBin, socketArgs, target: name,
    onOutput: (bytes) => { if (mirror) mirror.onOutput(bytes); },
    onClose: async (reason) => {
      if (stopping) return;
      stopping = true;
      if (mirror) mirror.stop();
      note(`pidge terminal: ${reason} — marking the session ended`);
      // The tmux session died under us ⇒ the row is history now. Best-effort:
      // an unreachable server just leaves a stale row the heartbeat TTL
      // already reports offline.
      try {
        await ctx.fetchT(`${ctx.BASE}/api/v1/terminal_sessions/${encodeURIComponent(entry.pid)}`, { method: 'DELETE', headers: ctx.headers });
      } catch { /* best-effort cleanup */ }
      if (cableHandle) cableHandle.close();
      process.exit(0);
    },
  });

  mirror = createMirror({
    control, target: name, epoch: entry.epoch,
    seal: (frame) => wire.sealFrame(mat.key, info.id, entry.pid, wire.AAD_OUTPUT, frame),
    // A wrapper/attach host has no control lane, so reseed/resize ROAM onto
    // this session's own :in (terminal_ctrl_viewer, anchored on entry.pid) —
    // openViewer tries terminal_input then terminal_ctrl_viewer.
    openViewer: (data) => wire.openViewerFrame(mat.key, info.id, entry.pid, data),
    sendFrame: (data) => (cableHandle ? cableHandle.send('frame', { data }) : false),
    narrate: (msg) => console.error(msg),
    dataMax: limits.dataMax,
    frameCap: limits.frameCap,
    flushMs: limits.flushMs,
  });

  const stop = () => {
    if (stopping) return;
    stopping = true;
    mirror.stop();
    if (cableHandle) cableHandle.close();
    control.kill();
    note(`pidge terminal: mirror stopped — the tmux session '${name}' KEEPS RUNNING (resume: pidge terminal attach ${name} · local: tmux attach -t ${name})`);
    const t = setTimeout(() => process.exit(0), 400); // let the detach land
    if (t.unref) t.unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // stdout stays machine-readable: the one line an agent scripts against.
  console.log(JSON.stringify({ ok: true, public_id: entry.pid, name, epoch: entry.epoch }));
  note(`pidge terminal: mirroring tmux session '${name}' (sealed, epoch ${entry.epoch}) — it appears in the app's Terminals tab; local shells can \`tmux attach -t ${name}\` anytime. Ctrl-C stops the mirror only.`);

  // The relay loop: one subscription, reconnected with backoff for as long as
  // the mirror lives. A REJECT is a deterministic refusal (plan gate backstop,
  // E2E toggled off, or a session row revoked underneath us) — two in a row
  // ⇒ die with the map, never a blind reconnect loop.
  let rejects = 0;
  let fails = 0;
  const base = parseInt(process.env.PIDGE_TERMINAL_BACKOFF_MS || '2000', 10) || 2000;
  while (!stopping) {
    const why = await new Promise((resolve) => {
      const h = ctx.cableSubscribe({
        channel: 'TerminalChannel',
        params: { session: entry.pid },
        onUp: () => {
          cableHandle = h;
          rejects = 0;
          fails = 0;
          note('pidge terminal: relay up — sealed frames flow while someone is watching');
          mirror.onRelayUp();
        },
        onFrame: (m) => mirror.handleCable(m),
        onDown: (r) => { cableHandle = null; resolve(r); },
      });
      if (!h) resolve('no socket');
    });
    if (stopping) break;
    if (/rejected/.test(why)) {
      rejects += 1;
      if (rejects >= 2) {
        mirror.stop();
        control.kill();
        die([
          'pidge terminal: the relay REJECTED the host subscription twice — that is a deterministic refusal, not a network blip. One of:',
          '  · the plan gate (terminal mirroring is Pro-only — the register POST carries the precise message),',
          '  · E2E was toggled OFF for this channel (sealed-only: the lane closes),',
          '  · the session row was revoked (a key rotation ends the old inventory).',
          'Re-run `pidge terminal` after fixing the cause; `pidge doctor` shows the channel state.',
        ].join('\n'), 2);
      }
    }
    fails += 1;
    const backoff = Math.min(base * fails, base * 15);
    note(`pidge terminal: relay socket ${why} — reconnecting in ${Math.round(backoff / 1000)}s (the tmux session is untouched; viewers repaint via reseed)`);
    await ctx.sleep(backoff);
  }
};
