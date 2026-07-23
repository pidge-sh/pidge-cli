'use strict';
// Shared plumbing for the terminal commands (mirror + host daemon): the
// sealed-only preflight, the session REST lifecycle, the manifest-served wire
// limits and the per-(channel, session) identity that anchors every seal.

const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const wire = require('./wire');

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
  } catch { /* shipped defaults double as the offline fallback */ }
  // Raw bytes per output frame: base64 + JSON + envelope ≈ 16/9 blow-up, so
  // stay at 9/16 of the cap with headroom — and never above the protocol's
  // own 16 KB chunk.
  limits.dataMax = Math.min(wire.DATA_MAX_BYTES, Math.floor((limits.frameCap * 9) / 16) - 512);
  // Flush at half the allowed rate at most (coalescing is the contract).
  limits.flushMs = Math.max(parseInt(process.env.PIDGE_TERMINAL_FLUSH_MS || '80', 10) || 80,
    Math.ceil(2000 / Math.max(1, limits.fps)));
  return limits;
}

// The per-(channel, name) identity: public_id anchors every seal (minted
// BEFORE anything is sealed, reused across host restarts so the Terminals tab
// keeps ONE row per session), epoch bumps per tap so viewers reset their gap
// detector. `slot` separates namespaces (tmux sessions vs the control lane).
// bump:false mints/returns the identity WITHOUT burning an epoch — the host
// daemon's inventory discovers sessions it may never attach; only an actual
// tap (output about to flow) advances the epoch.
function bumpSessionEntry(ctx, slot, name, { bump = true } = {}) {
  const key = `${ctx.channelKeyFor(ctx.TOKEN) || 'default'}:${slot}`;
  const all = ctx.readState().terminalSessions || {};
  const scope = all[key] || {};
  const entry = scope[name] || { pid: `term_${crypto.randomUUID()}`, epoch: 0 };
  if (bump) entry.epoch += 1;
  ctx.writeState({ terminalSessions: { ...all, [key]: { ...scope, [name]: entry } } });
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

// POST the lifecycle row. `fatal` (the default) dies on failure — right for
// the one session a mirror IS; the host daemon passes fatal:false for
// inventory rows (one bad row must not kill the whole daemon) and gets
// {ok, status, data} back instead.
async function registerSession(ctx, { publicId, name, kind = 'term' }, { fatal = true } = {}) {
  let res, data;
  try {
    res = await ctx.fetchT(`${ctx.BASE}/api/v1/terminal_sessions`, {
      method: 'POST', headers: ctx.headers,
      body: JSON.stringify({ public_id: publicId, name, kind }),
    });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    if (!fatal) return { ok: false, status: 0, data: { error: e.message } };
    ctx.die(`pidge terminal: registering the session failed (network): ${e.message}`, 2);
  }
  await ctx.checkManifestNews(res);
  if (res.status === 402) {
    // Typed plan gate — the message is written by the server to be RELAYED.
    // Never retried: only the human upgrading changes the answer. Fatal even
    // for the daemon: the whole feature is closed, not one row.
    ctx.die(`pidge: ${data.message || 'terminal mirroring is a Pro feature and this account is not on Pro'}\npidge: (plan gate — do not retry; everything else on this key keeps working)`, 2);
  }
  if (res.status === 422 && data.code === 'e2e_required') {
    ctx.die('pidge terminal: the server refused the register — this channel is not E2E (sealed-only is enforced server-side too). Ask your human to enable E2E in the app, then retry.', 2);
  }
  if (res.status !== 201) {
    if (!fatal) return { ok: false, status: res.status, data };
    ctx.die(`pidge terminal: register failed (${res.status}): ${JSON.stringify(data)}`, 2);
  }
  return { ok: true, status: res.status, data };
}

// Mark a session row ended. Best-effort by design: an unreachable server just
// leaves a stale row the heartbeat TTL already reports offline.
async function endSession(ctx, publicId) {
  try {
    await ctx.fetchT(`${ctx.BASE}/api/v1/terminal_sessions/${encodeURIComponent(publicId)}`, {
      method: 'DELETE', headers: ctx.headers,
    });
    return true;
  } catch { return false; }
}

module.exports = {
  SESSION_NAME, execFileP, fetchLimits, bumpSessionEntry,
  preflightSealed, registerSession, endSession,
};
