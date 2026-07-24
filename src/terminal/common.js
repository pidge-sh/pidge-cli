'use strict';
// Shared plumbing for the terminal commands (mirror + host daemon): the
// sealed-only preflight, the session REST lifecycle, the manifest-served wire
// limits and the per-(channel, session) identity that anchors every seal.

const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
  // own 16 KB chunk. Floored at 1 KB so a malformed/tiny manifest cap can
  // never yield a non-positive chunk step (which would loop the flusher forever).
  limits.dataMax = Math.max(1024, Math.min(wire.DATA_MAX_BYTES, Math.floor((limits.frameCap * 9) / 16) - 512));
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

// The advisory channel link landed with server manifest v94 — prod stamps
// X-Pidge-Manifest-Version on every response, so an older server is
// detectable. On one, an unknown `linked_channel_id` param is SILENTLY dropped
// by the permit — say so loudly instead of pretending the link stuck (the
// echoed row is the belt when the header is missing).
function warnLinkIgnoredByOldServer(res, data, link) {
  const ver = parseInt(res.headers.get('x-pidge-manifest-version') || '0', 10) || 0;
  const echoed = !!(data && data.terminal_session && ('linked_channel_id' in data.terminal_session));
  if ((ver && ver < 94) || (!ver && !echoed)) {
    console.error(`pidge terminal: this server (manifest v${ver || '?'}) predates linked_channel_id (v94) — the ${link.id === null ? 'link CLEAR' : `link to channel id ${link.id}`} was IGNORED (nothing stored or cleared). The session mirrors normally; re-run against an updated server to link it.`);
  }
}

// POST the lifecycle row. `fatal` (the default) dies on failure — right for
// the one session a mirror IS; the host daemon passes fatal:false for
// inventory rows (one bad row must not kill the whole daemon) and gets
// {ok, status, data} back instead.
// `link` (optional): { id: <integer|null>, source: 'flag'|'inferred' }.
// Partial-upsert semantics ride through untouched: an OMITTED link keeps the
// stored value server-side, an explicit null clears it — so the key is only
// ever sent when the caller actually decided something.
async function registerSession(ctx, { publicId, name, kind = 'term', link }, { fatal = true } = {}) {
  const post = async (withLink) => {
    const body = { public_id: publicId, name, kind };
    if (withLink && link !== undefined) body.linked_channel_id = link.id;
    const res = await ctx.fetchT(`${ctx.BASE}/api/v1/terminal_sessions`, {
      method: 'POST', headers: ctx.headers, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  };
  let res, data;
  let sentLink = link !== undefined;
  try {
    ({ res, data } = await post(true));
  } catch (e) {
    if (!fatal) return { ok: false, status: 0, data: { error: e.message } };
    ctx.die(`pidge terminal: registering the session failed (network): ${e.message}`, 2);
  }
  await ctx.checkManifestNews(res);
  // An INFERRED link the server refuses must never kill the mirror it was
  // only meant to garnish: drop it, say so, register plain. An EXPLICIT
  // --link is the user's ask — that refusal stays the loud exit below.
  if (res.status === 422 && data.code === 'invalid_linked_channel' && link && link.source === 'inferred') {
    console.error(`pidge terminal: the server refused the inferred channel link (id ${link.id}: ${data.error || 'invalid_linked_channel'}) — registering WITHOUT it. Pass --link <id> to set one explicitly.`);
    sentLink = false;
    try {
      ({ res, data } = await post(false));
    } catch (e) {
      if (!fatal) return { ok: false, status: 0, data: { error: e.message } };
      ctx.die(`pidge terminal: registering the session failed (network): ${e.message}`, 2);
    }
  }
  if (res.status === 201) {
    if (sentLink) warnLinkIgnoredByOldServer(res, data, link);
    return { ok: true, status: 201, data };
  }
  // Any non-201. A daemon inventory row (fatal:false) must NEVER tear down the
  // whole process on ONE bad row — including a 402/422 that only means a race
  // (the control-lane register, which is fatal:true, already relayed the plan
  // gate / e2e refusal): return and leave the row unlisted for a later pass.
  if (!fatal) return { ok: false, status: res.status, data };
  if (res.status === 402) {
    // Typed plan gate — the message is written by the server to be RELAYED.
    // Never retried: only the human upgrading changes the answer.
    ctx.die(`pidge: ${data.message || 'terminal mirroring is a Pro feature and this account is not on Pro'}\npidge: (plan gate — do not retry; everything else on this key keeps working)`, 2);
  }
  if (res.status === 422 && data.code === 'e2e_required') {
    ctx.die('pidge terminal: the server refused the register — this channel is not E2E (sealed-only is enforced server-side too). Ask your human to enable E2E in the app, then retry.', 2);
  }
  if (res.status === 422 && data.code === 'invalid_linked_channel') {
    // Loud by server design: a typo'd link must be visible, never degrade
    // into "no chip". The id must name a channel of the SAME account.
    ctx.die(`pidge terminal: the server REFUSED the channel link (--link ${link && link.id}): ${data.error || 'invalid_linked_channel'} — the id must be a channel of the same account (\`pidge whoami\` on that channel's key prints its id). Re-run with the right --link, or without it.`, 2);
  }
  ctx.die(`pidge terminal: register failed (${res.status}): ${JSON.stringify(data)}`, 2);
  return { ok: false, status: res.status, data }; // unreachable (die exits) — keeps the shape honest
}

// The git-project toplevel for a directory: walk up to the first `.git` entry
// (a dir in a checkout, a file in a linked worktree). $HOME is never a project
// and outside any project is null — byte-for-byte the rule the CLI's
// project-scoped identity uses, because the hash below must land on the SAME
// ~/.config/pidge/projects/<hash> directory `setup` wrote.
function projectRootFor(startDir) {
  try {
    let dir = startDir;
    for (;;) {
      try {
        fs.statSync(path.join(dir, '.git'));
        return dir === os.homedir() ? null : dir;
      } catch { /* keep walking */ }
      const up = path.dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
  } catch { return null; }
}

// Advisory link inference: when the mirrored session's cwd lives inside a git
// project that holds a project-scoped pidge env (~/.config/pidge/projects/
// <hash>/env — the identity mechanism `setup` writes), the agent running
// INSIDE this terminal is almost certainly that project's channel — link the
// session to it so the Terminals tab shows provenance. CONSERVATIVE and LOUD:
// any doubt (no project, no env, a different server, the mirror's own
// channel, an unresolvable whoami) ⇒ no link with at most one note, never
// fatal, never a retry loop. Explicit --link always wins and --no-link
// disables — both are handled by the caller before this ever runs. The
// project token is read only to ask whoami for its channel id; it is never
// printed, stored or sent anywhere else.
async function inferLinkedChannel(ctx, cwd) {
  const root = projectRootFor(cwd);
  if (!root) return undefined;
  const hash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
  const envFile = path.join(ctx.baseDir, 'projects', hash, 'env');
  const env = ctx.readEnvFile(envFile);
  if (!env.PIDGE_TOKEN) return undefined;                 // no project identity — the common case, no noise
  if (env.PIDGE_TOKEN === ctx.TOKEN) return undefined;    // the mirror's own channel — a self-link adds nothing
  const projBase = (env.PIDGE_URL || '').replace(/\/+$/, '');
  if (projBase && projBase !== ctx.BASE.replace(/\/+$/, '')) {
    ctx.note(`pidge terminal: this project's pidge env speaks to a different server (${projBase}) — session not linked`);
    return undefined;
  }
  try {
    const { res, data } = await ctx.fetchWhoami(ctx.BASE, env.PIDGE_TOKEN);
    if (res.status === 200 && data.channel && data.channel.id != null) {
      ctx.note(`pidge terminal: linking this session to channel ${JSON.stringify(data.channel.name || String(data.channel.id))} (id ${data.channel.id}) — inferred from this project's pidge env. --no-link disables; --link <id> overrides.`);
      return { id: data.channel.id, source: 'inferred' };
    }
    ctx.note(`pidge terminal: this project has a pidge env but its channel could not be resolved (whoami ${res.status}) — session not linked`);
  } catch (e) {
    ctx.note(`pidge terminal: channel-link inference skipped (whoami failed: ${e.message}) — session not linked`);
  }
  return undefined;
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
  preflightSealed, registerSession, endSession, inferLinkedChannel,
};
