'use strict';
// `pidge terminal` — mirror a real tmux session to the human's phone/Mac app,
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

const crypto = require('node:crypto');
const { createControl } = require('./control');
const { createMirror } = require('./mirror');
const wire = require('./wire');
const {
  SESSION_NAME, execFileP, fetchLimits, bumpSessionEntry,
  preflightSealed, registerSession, endSession, inferLinkedChannel,
} = require('./common');

const USAGE = 'pidge: usage: pidge terminal [--name NAME] [--link ID | --no-link] [-- CMD…]  ·  pidge terminal attach <tmux-session> [--link ID | --no-link]  ·  pidge terminal host [--install [--machine-channel]]';

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

  if (sub[0] === 'host') {
    if (sub.length > 1) die(USAGE, 1);
    if (ctx.values.link !== undefined || ctx.values['no-link']) {
      die('pidge terminal host: --link/--no-link apply to the wrapper/attach forms — the daemon inventories MANY sessions; link a specific one from its own mirror', 1);
    }
    const host = require('./host');
    if (ctx.values.install) return host.installHost(ctx);
    if (ctx.values['machine-channel']) die('pidge terminal host: --machine-channel only applies together with --install (it provisions the daemon before the template is written)', 1);
    return host.runHost(ctx, { tmuxBin, socketArgs });
  }
  if (ctx.values['machine-channel']) die('pidge terminal: --machine-channel only applies to `pidge terminal host --install`', 1);

  // The advisory channel link — validated BEFORE any side effect (usage
  // errors must leave nothing behind). undefined = omit (the server keeps a
  // stored link, partial upsert); {id:null} = explicit clear.
  let link;
  if (ctx.values.link !== undefined && ctx.values['no-link']) {
    die('pidge terminal: --link and --no-link conflict — pass one', 1);
  }
  if (ctx.values.link !== undefined) {
    if (!/^\d+$/.test(ctx.values.link)) {
      die(`pidge terminal: --link takes the channel's numeric id (got ${JSON.stringify(ctx.values.link)}) — \`pidge whoami\` with that channel's key prints it`, 1);
    }
    link = { id: Number(ctx.values.link), source: 'flag' };
  } else if (ctx.values['no-link']) {
    link = { id: null, source: 'flag' };
  }

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

  // No explicit --link/--no-link ⇒ try the conservative inference: the
  // session's cwd (the wrapper starts in OURS; an attached session answers
  // for its own) mapping to a project-scoped pidge env names the channel
  // whose agent runs inside. Loud on success, one note on a near-miss,
  // never fatal — and an old tmux that can't answer the cwd query simply
  // skips it.
  if (link === undefined) {
    const cwd = creating
      ? process.cwd()
      : await execFileP(tmuxBin, [...socketArgs, 'display-message', '-p', '-t', `=${name}`, '-F', '#{pane_current_path}'])
        .then((s) => s.trim(), () => '');
    if (cwd) link = await inferLinkedChannel(ctx, cwd);
  } else if (link.id !== null) {
    note(`pidge terminal: linking this session to channel id ${link.id} (--link) — advisory provenance for the Terminals tab`);
  } else {
    note('pidge terminal: clearing any stored channel link (--no-link)');
  }

  const entry = bumpSessionEntry(ctx, 'term', name);
  await registerSession(ctx, { publicId: entry.pid, name, kind: 'term', link });
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
      // The tmux session died under us ⇒ the row is history now.
      await endSession(ctx, entry.pid);
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
