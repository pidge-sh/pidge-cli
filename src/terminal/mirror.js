'use strict';
// The mirror engine — everything between the tmux control client and the
// sealed `pane_output` relay, for ONE shared PANE. Owns:
//   · output coalescing (flush every ~80 ms, ≤16 KB of raw bytes per frame —
//     staying far under the relay's per-frame and frames/s guards),
//   · the viewer gate (output is only sealed+sent while someone is actually
//     watching — flow control, not delivery policy: a drop is always healed by
//     reseed),
//   · seed/reseed (capture-pane repaint — THE loss-recovery mechanism: any
//     gap, reconnect or foreground ends in a seed, so drops stay safe),
//   · the post-resize repaint nudge and the live-stream title stripper.
//
// RECOVERED from the retired 0.37.1 arc (`src/terminal/mirror.js` @ acdd106).
// The LOGIC is verbatim — the coalescer, the seed ladder with its degrade
// steps, the stateful `ESC k` stripper, the jiggle nudge, the buffer-drop
// threshold. What changed is the ENCAIXE (spec §19, design §3):
//   1. TRANSPORT: `sendFrame` is a `perform "frame"` on the share's EXISTING
//      AgentSessionChannel subscription — there is no socket, no channel and
//      no lane of the mirror's own any more. Sealing is the daemon's envelope
//      machinery on the `pane_output` AAD.
//   2. ANCHOR: the unit is a PANE, not a session. `target` is the pane id; the
//      control client is shared through the ControlHub and hands us only our
//      own pane's bytes.
//   3. INBOUND: nothing arrives here from a cable. The daemon opens every
//      viewer frame on the ONE `agent_input` lane (vgen/he ledger included)
//      and calls `reseed()` / `resize()` on us. No second ledger exists.
//   4. VIEWERS: there is no `leave` event on the Phase-B wire (verified:
//      ComputerChannel emits viewer_joined on subscribe and NOTHING on
//      unsubscribe), so presence is a decaying window the DAEMON owns — this
//      module only exposes `lastInboundAt` and obeys stop().

const { chunkBytes, tmuxQuote, clampCols, clampRows, DATA_MAX_BYTES } = require('./wire');

// Scrollback ladder for a seed: try the deepest first, shrink until the sealed
// frame fits the relay's byte cap. `0` (the bare visible screen) does NOT
// always fit (old-arc finding #6: a nonblank 500x300 SGR screen is several
// times the cap) — past the floor, seed() degrades (no-SGR recapture, then
// top-truncate, then tail-bytes) instead of ever sending an over-cap frame.
const SEED_SCROLLBACK = [200, 100, 50, 0];

// Seed state prefix (gotcha #64 / QA 2026-07-29). DECSET 1049 — "switch to the
// alternate screen". Prefixed to the seed's data bytes when the pane is on the
// alternate screen, so the viewer's RIS→feed order lands its emulator in the
// host's buffer state for a pre-existing TUI. `1049h` ONLY — the seed is not a
// general state carrier.
const ALT_SCREEN_PREFIX = '\x1b[?1049h';

// A runaway burst while the cable is down must not grow memory forever: past
// this, the buffer is dropped WHOLE and a seed repaint is scheduled instead —
// strictly better than a partial stream (the viewer would keep a gap anyway).
const BUFFER_DROP_BYTES = 256 * 1024;

// The relay's drop notice (§19) is honest but PRIVATE — it reaches the sender
// only. `rate_limited` means the 30/s window bit: flush 4× slower for this
// long so the storm drains instead of re-flooding.
const PENALTY_MS = 2000;

// The shortest window a frames/s figure is allowed to be computed over. Under
// it, an all-time average is arithmetic on noise: two frames 3 ms apart are not
// "666 frames per second", they are two frames. The diagnostic says so instead.
const RATE_MIN_SPAN_MS = 1000;

// The doctor's frame line, as a pure formatter (the count is always true; the
// rate is only printed when the sample earns it). Shared so the daemon side and
// the printed line can never disagree about when a rate exists.
function formatFrameActivity({ frames_sent: sent = 0, frames_span_ms: spanMs, frames_per_s: rate } = {}) {
  const count = `${sent} frame${sent === 1 ? '' : 's'}`;
  if (typeof rate === 'number' && rate > 0) return `${count} · ${rate}/s`;
  if (!sent) return `${count} sent`;
  const span = typeof spanMs === 'number' ? `${spanMs} ms` : 'an unmeasured span';
  return `${count} in ${span} — too short a sample for a rate`;
}

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

function createMirror({
  control,     // the ControlHub's client for this pane's tmux session
  target,      // the PANE id (`%42`) — capture/display/refresh target and the %output filter
  epoch,       // the daemon epoch, echoed in every o/seed frame (viewer gap detection)
  seal,        // (frameObj)  → sealed wire string (pane_output AAD, base64url)
  sendFrame,   // (data)      → boolean — false = not sent (cable down/closed)
  narrate = () => {},
  dataMax = DATA_MAX_BYTES,
  frameCap = 64 * 1024,   // relay byte ceiling per frame (from the manifest) — caps the seed
  flushMs = 80,
  nudgeMs = 500,          // debounce after the LAST resize before the repaint nudge fires
  nudgePauseMs = 60,      // pause between the two jiggle steps (one real SIGWINCH each)
  now = () => Date.now(),
}) {
  let outSeq = 0;          // daemon→viewer, ONE counter per share for o+seed frames
  let viewers = 0;         // the emission gate (see reseed(): a reseed proves a watcher)
  let pending = [];        // coalesce buffer (Buffer[])
  let pendingBytes = 0;
  let flushTimer = null;
  let stopped = false;
  let penaltyUntil = 0;    // rate-limited by the relay → flush slower briefly
  let seedWanted = false;  // a dropped buffer heals via seed on next flush
  let ctrlChain = Promise.resolve(); // serializes reseed/resize (see below)
  let nudgeTimer = null;   // debounce timer for the post-resize repaint nudge
  let titleSwallow = false; // live-stream title stripper: inside `ESC k …`, discarding up to ST/BEL
  let heldEsc = false;      // live-stream title stripper: last byte was a bare ESC — classify on the NEXT byte
  let attached = true;      // the hub's client is alive for this pane
  const notedOnce = new Set();
  const noteOnce = (msg) => { if (!notedOnce.has(msg)) { notedOnce.add(msg); narrate(msg); } };

  // Diagnostics for `pidge terminal doctor` (spec §19's real-binary rule, and
  // gotcha #75's "every field that governs rendering gets a probe").
  const stats = {
    framesSent: 0, framesFirstAt: 0, framesLastAt: 0,
    stripperHits: 0, seeds: 0, drops: { rate_limited: 0, frame_too_large: 0 },
    lastSeed: null,       // { bytes, scrollback, degraded, alt, cols, rows, fits }
    lastInboundAt: now(), // ATTACH is t0 of the idle window — an eager term
                          // attach that never gets a reseed stands down on its own
  };

  function emit(frame) {
    const sent = sendFrame(seal(frame));
    if (sent) {
      stats.framesSent += 1;
      stats.framesFirstAt ||= now();
      stats.framesLastAt = now();
    }
    return sent;
  }

  function scheduleFlush() {
    if (flushTimer || stopped) return;
    const wait = now() < penaltyUntil ? flushMs * 4 : flushMs;
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, wait);
    if (flushTimer.unref) flushTimer.unref();
  }

  function flush() {
    if (stopped) return;
    if (seedWanted) { seedWanted = false; pending = []; pendingBytes = 0; seed(); return; }
    if (!pendingBytes) return;
    const buf = Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;
    for (const chunk of chunkBytes(buf, dataMax)) {
      emit({ t: 'o', epoch, seq: ++outSeq, data: chunk.toString('base64') });
    }
  }

  // Full repaint: pane size + screen/scrollback captured INSIDE the control
  // connection, sent as ONE seed frame the viewer resets its emulator on.
  // THE SEED MUST FIT the relay's frame cap: an oversized seed is the one loss
  // the reseed protocol can't heal (relay drops it → viewer reseeds → the
  // daemon regenerates the SAME oversized dump → loop). So shrink scrollback
  // (-200→-100→-50→0) until the SEALED frame is under the cap. The bare
  // visible screen (0) does NOT always fit — a nonblank SGR-heavy screen at
  // the allowed 500x300 grid is already several times the cap (finding #6) —
  // so past the ladder's floor the seed DEGRADES instead of bypassing the cap:
  //   (a) re-capture without -e (no SGR — plain text shrinks massively; color
  //       is lost, content is not),
  //   (b) still over: truncate lines from the TOP of the dump (the bottom of
  //       the screen is the live part),
  //   (c) floor of the floor: keep the TAIL bytes,
  //   and every degrade is narrated loudly. A frame over the cap is NEVER
  //   sent — degrade loudly, never loop (and degrade beats a dark screen).
  async function seed() {
    if (stopped) return;
    const t = tmuxQuote(target);
    // #{alternate_on} rides the SAME display-message as the geometry — the
    // FIRST of the two reads the seed state prefix is gated on (gotcha #64 /
    // QA 2026-07-29): capture-pane renders CELLS, so alternate-screen STATE
    // never crosses the mirror on its own, and the viewer's RIS actively wipes
    // whatever state it had — a viewer joining a pre-existing full-screen TUI
    // never opened the alt-drag gate.
    const size = await control.command(`display-message -p -t ${t} '#{pane_width} #{pane_height} #{alternate_on}'`);
    const m = size.ok ? /^(\d+)\s+(\d+)(?:\s+(\d+))?/.exec(size.lines[0] || '') : null;
    const cols = m ? parseInt(m[1], 10) : 80;
    const rows = m ? parseInt(m[2], 10) : 24;
    const altBefore = !!m && m[3] === '1';

    // One capture (with or without SGR) at one scrollback depth, plus the
    // SECOND #{alternate_on} read immediately after it: the prefix is emitted
    // only if BOTH reads agree on `1` — a TUI exiting mid-seed must fail
    // CLOSED (arrows leaking into a normal shell drive the zsh history; a shut
    // gate merely loses a scroll). Skipped entirely when the first read
    // already said no (no prefix either way). Mid-session flips need nothing:
    // DECSET/DECRST 1049 cross on the LIVE path. Returns null on failure — the
    // caller distinguishes `stopped` (silent) from a real capture error.
    async function capture(sgr, lines) {
      const cap = await control.command(`capture-pane -p${sgr ? ' -e' : ''} -J -S -${lines} -t ${t}`);
      if (!cap.ok || stopped) return null;
      let prefix = '';
      if (altBefore) {
        const again = await control.command(`display-message -p -t ${t} '#{alternate_on}'`);
        if (stopped) return null;
        if (again.ok && (again.lines[0] || '').trim() === '1') prefix = ALT_SCREEN_PREFIX;
      }
      return { lines: cap.lines, prefix };
    }
    // Block body lines are latin1-preserved bytes; \r\n between lines so the
    // viewer's emulator repaints rows, not one endless line. The state prefix
    // rides INSIDE data, so it counts toward the frame cap honestly. `seq` is
    // outSeq+1 on every attempt — it only advances when a frame is SENT.
    const sealData = (dataBuf) => seal({ t: 'seed', epoch, seq: outSeq + 1, cols, rows, data: dataBuf.toString('base64') });
    const sealLines = (prefix, bodyLines) => sealData(Buffer.from(prefix + bodyLines.join('\r\n') + '\r\n', 'latin1'));
    const fits = (sealed) => Buffer.byteLength(sealed) <= frameCap;
    const send = (sealed, note) => {
      outSeq += 1;
      const ok = sendFrame(sealed);
      stats.seeds += 1;
      if (ok) { stats.framesSent += 1; stats.framesFirstAt ||= now(); stats.framesLastAt = now(); }
      stats.lastSeed = {
        at: now(), bytes: Buffer.byteLength(sealed), cols, rows, alt: altBefore,
        fits: true, sent: ok, ...note,
      };
    };
    const skipped = (why) => { stats.lastSeed = { at: now(), bytes: null, cols, rows, alt: altBefore, fits: false, sent: false, degraded: why }; };

    for (let i = 0; i < SEED_SCROLLBACK.length; i++) {
      const got = await capture(true, SEED_SCROLLBACK[i]);
      if (!got) {
        if (!stopped) {
          noteOnce('pidge terminal: capture-pane failed — seed skipped (will retry on the next reseed)');
          skipped('capture-pane failed');
        }
        return;
      }
      const sealed = sealLines(got.prefix, got.lines);
      if (fits(sealed)) {
        if (i > 0) noteOnce(`pidge terminal: seed shrunk to ${SEED_SCROLLBACK[i]} lines of scrollback to fit the relay frame cap`);
        send(sealed, { scrollback: SEED_SCROLLBACK[i], degraded: i > 0 ? 'scrollback-shrunk' : null });
        return;
      }
    }

    // Ladder exhausted: the bare visible screen WITH SGR is over the cap.
    // (a) re-capture the visible screen without -e — colors lost, not content.
    const plain = await capture(false, 0);
    if (!plain) {
      if (!stopped) {
        noteOnce('pidge terminal: capture-pane failed — seed skipped (will retry on the next reseed)');
        skipped('capture-pane failed');
      }
      return;
    }
    let sealed = sealLines(plain.prefix, plain.lines);
    if (fits(sealed)) {
      noteOnce('pidge terminal: seed exceeded the relay frame cap — resent WITHOUT COLORS (SGR stripped, content intact; degrade loudly, never loop)');
      send(sealed, { scrollback: 0, degraded: 'sgr-stripped' });
      return;
    }
    // (b) even the plain screen is over the cap: keep the LARGEST bottom slice
    // of lines that fits (binary search — sealing is cheap, the dump is not).
    let best = null;
    for (let lo = 1, hi = plain.lines.length; lo <= hi;) {
      const mid = (lo + hi) >> 1;
      const s = sealLines(plain.prefix, plain.lines.slice(plain.lines.length - mid));
      if (fits(s)) { best = s; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (best) {
      noteOnce('pidge terminal: seed exceeded the relay frame cap even without colors — TOP lines truncated to fit (the bottom of the screen is the live part; degrade loudly, never loop)');
      send(best, { scrollback: 0, degraded: 'top-lines-truncated' });
      return;
    }
    // Floor of the floor: even ONE line over the cap (a pathological single
    // giant line). Keep the TAIL bytes — the freshest — halving until the
    // sealed frame fits. A partial screen still beats a dark viewer, and a
    // dark viewer beats the reseed loop.
    let bytes = Buffer.from(plain.prefix + plain.lines.join('\r\n') + '\r\n', 'latin1');
    while (bytes.length > 1 && !fits(sealData(bytes))) bytes = bytes.subarray(bytes.length >> 1);
    sealed = sealData(bytes);
    if (!fits(sealed)) {
      // The cap is smaller than the seal envelope itself — NOTHING can ever
      // fit. Sending anyway would feed the loop; skip loudly instead (the
      // viewer keeps its last paint).
      noteOnce('pidge terminal: the relay frame cap is too small for ANY seed — seed skipped (check the server manifest agent_sessions limits)');
      skipped('the frame cap is smaller than the seal envelope');
      return;
    }
    noteOnce('pidge terminal: seed exceeded the relay frame cap even without colors — TOP bytes truncated to fit (degrade loudly, never loop)');
    send(sealed, { scrollback: 0, degraded: 'tail-bytes-only' });
  }

  // Post-resize repaint nudge (QA r4 T0-a). A TUI (Claude Code, vim, htop)
  // already painted at width W is left TORN when the tmux grid changes AFTER
  // it drew — nothing redraws it on its own. Our attached client is the tmux
  // CONTROL client: it renders no screen, so `refresh-client` on it only
  // re-emits the ALREADY-torn grid as %output. The one universal repaint
  // trigger is SIGWINCH, which tmux delivers to the pane ONLY when the window
  // size actually CHANGES — so a resize to the size the window already has
  // (e.g. re-opening the pane screen) produces NO SIGWINCH and the tear
  // persists. Cure: once a burst of resizes has SETTLED (debounced ~nudgeMs
  // after the last one — rotation fires a burst, only the final size gets
  // nudged), reapply the size with a 1-row jiggle so tmux sees two real
  // changes and hands the pane two SIGWINCHes, repainting it at the FINAL size
  // even when the requested resize was a no-op.
  //
  // `C-l` WAS REJECTED AND STAYS REJECTED: in Claude Code it clears the very
  // transcript the human is supervising. The mirror never sends keys to force
  // a repaint — not once, not as a fallback.
  //
  // Accepted tradeoffs, on purpose:
  // - window-size latest: the immediate resize already makes the PHONE the
  //   "latest" client the moment it gestures; the nudge repeats that up to
  //   ~nudgeMs later, so a Mac-side resize landing inside the debounce window
  //   gets snapped back once. One-shot by construction, and the Mac wins again
  //   by simply acting again.
  // - stop() in the ~pauseMs between the two jiggle steps can leave the tmux
  //   window at rows-1 (the session keeps running — the next attach/resize
  //   heals it).
  // Set nudge_ms = 0 in terminal.toml to disable the nudge entirely (ops knob).
  function scheduleRepaintNudge(cols, rows) {
    if (stopped || nudgeMs <= 0) return;
    if (nudgeTimer) clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => { nudgeTimer = null; runRepaintNudge(cols, rows); }, nudgeMs);
    if (nudgeTimer.unref) nudgeTimer.unref();
  }
  async function runRepaintNudge(cols, rows) {
    if (stopped) return;
    // Jiggle by one row so the size genuinely changes (rows-1, respecting the
    // ≥5 clamp — if the floor makes rows-1 land back on rows, jiggle UP under
    // the 300 ceiling). The pair still ends at the requested `rows`.
    let jiggle = Math.max(5, rows - 1);
    if (jiggle === rows) jiggle = Math.min(300, rows + 1);
    if (jiggle === rows) return; // degenerate (unreachable for valid rows) — nothing to jiggle
    try {
      const a = await control.command(`refresh-client -C ${cols}x${jiggle}`);
      if (stopped || !a.ok) return; // control detached/died mid-nudge — drop silently
      await sleep(nudgePauseMs);
      if (stopped) return;
      const b = await control.command(`refresh-client -C ${cols}x${rows}`);
      if (b.ok) noteOnce('pidge terminal: post-resize repaint nudge (1-row jiggle) — forcing a SIGWINCH so a torn TUI repaints at the final size');
    } catch { /* raced control teardown — no unhandled rejection */ }
  }

  // Live-stream stripper for the screen title sequence (QA T1 ghost, gotcha
  // #64's sibling). Inside tmux, TERM=screen* makes the shell (zsh
  // precmd/preexec) emit the screen title sequence `ESC k <title> ST` around
  // every command, and tmux forwards those bytes VERBATIM in %output.
  // SwiftTerm (the iOS viewer) does not treat `ESC k` as a string introducer —
  // it dispatches `k` as a 2-byte escape and paints the TITLE as literal text.
  // That is exactly the live-only ghost ("echor2" where the pane shows "r2",
  // the stray `%` line): capture-pane renders grid cells and never contains
  // the sequence, so it only bites on the live path and every reseed heals it.
  // The mirror has no window-title UI, so removing `ESC k … ST` (BEL accepted
  // defensively) is LOSSLESS here. ONLY `ESC k` is filtered: OSC/APC/PM/SOS
  // are already handled as strings by SwiftTerm — minimalism is the contract,
  // don't grow this into a sanitizer.
  // The two state flags above live on the mirror instance and MUST survive
  // chunk boundaries: the sequence can arrive split at ANY byte (ESC ending
  // one %output, `k` opening the next; a title spanning chunks), so a
  // per-buffer regex could never be correct. A bare ESC held at a chunk edge
  // that turns out NOT to start a title (e.g. `ESC [`) is re-emitted intact,
  // in order, at the head of the next chunk — no byte is ever lost.
  function stripScreenTitle(bytes) {
    const out = Buffer.allocUnsafe(bytes.length + 1); // +1: a held ESC from the PREVIOUS chunk may re-emit here
    let n = 0;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (titleSwallow) {
        if (heldEsc) { // an ESC inside the title — `ESC \` (ST) ends it
          heldEsc = false;
          if (b === 0x5c) { titleSwallow = false; continue; }
          if (b === 0x1b) { heldEsc = true; continue; } // ESC ESC — the new one may still open ST
          continue; // anything else is still title bytes — keep swallowing
        }
        if (b === 0x1b) { heldEsc = true; continue; }
        if (b === 0x07) { titleSwallow = false; continue; } // BEL terminator (defensive)
        continue;
      }
      if (heldEsc) {
        heldEsc = false;
        if (b === 0x6b) { titleSwallow = true; stats.stripperHits += 1; continue; } // `ESC k` — the introducer SwiftTerm can't parse
        out[n++] = 0x1b; // not a title: the retained ESC re-enters the stream intact, in order
        if (b === 0x1b) { heldEsc = true; continue; } // ESC ESC — hold the fresh one instead
        out[n++] = b;
        continue;
      }
      if (b === 0x1b) { heldEsc = true; continue; } // may be `ESC k` split across chunks — hold and classify next
      out[n++] = b;
    }
    return out.subarray(0, n);
  }

  // Serialize the control-lane frames (reseed/resize) exactly the way the old
  // arc serialized input: a reseed's capture-pane pair and a resize's
  // refresh-client must never interleave on the shared control client, and the
  // daemon calls these WITHOUT awaiting. Keystrokes need no chain here — they
  // never touch this connection (the daemon delivers them with a SYNCHRONOUS
  // core.tmuxExec, so their ordering is structural).
  function chain(fn) {
    ctrlChain = ctrlChain.then(fn).catch((e) => narrate(`pidge terminal: mirror control error: ${e.message}`));
    return ctrlChain;
  }

  return {
    // Raw pane bytes from the control client (%output for OUR pane, already
    // unescaped and routed by the hub).
    onOutput(bytes) {
      if (stopped) return;
      // The stripper sees EVERY live byte, even while nobody watches: a title
      // sequence can straddle a join, and stale state would either leak title
      // text as ghost cells or eat real output right after the join's seed.
      // Seeds (capture-pane) never pass through here — live path ONLY.
      const cleaned = stripScreenTitle(bytes);
      if (viewers < 1 || !cleaned.length) return; // nobody watching / nothing left — drop at zero cost
      pending.push(cleaned);
      pendingBytes += cleaned.length;
      if (pendingBytes > BUFFER_DROP_BYTES) {
        pending = [];
        pendingBytes = 0;
        seedWanted = true; // repaint beats a partial stream
      }
      scheduleFlush();
    },

    // A reseed PROVES someone is watching even if we never saw them arrive
    // (there is no join event per pane on this wire), so it opens the emission
    // gate and repaints. Every gap, reconnect, foreground and raw-toggle-open
    // funnels through here — this is the loss-recovery mechanism, and it is
    // why dropping frames is always safe.
    reseed() {
      // A stopped mirror is a stood-down one: it must not re-open its own
      // emission gate behind the daemon's back (the daemon builds a FRESH
      // instance when the share comes back).
      if (stopped) return Promise.resolve();
      stats.lastInboundAt = now();
      if (viewers < 1) viewers = 1;
      return chain(() => seed());
    },

    // `t:"resize"` — clamps inherited (cols 20–500, rows 5–300).
    resize(rawCols, rawRows) {
      if (stopped) return Promise.resolve();
      stats.lastInboundAt = now();
      const cols = clampCols(rawCols);
      const rows = clampRows(rawRows);
      return chain(async () => {
        // Resizing OUR control client resizes the WINDOW (window-size latest);
        // the reflow arrives as ordinary %output.
        await control.command(`refresh-client -C ${cols}x${rows}`);
        // …but a no-op resize (same size) yields NO SIGWINCH, so a torn TUI
        // stays torn — schedule the debounced repaint nudge behind it.
        scheduleRepaintNudge(cols, rows);
      });
    },

    // Any inbound frame for this share is presence evidence at PANE level (the
    // daemon's idle window is measured from here). Keystrokes call this too.
    noteInbound() { stats.lastInboundAt = now(); },

    // The relay's sender-only drop notice (§19). `rate_limited` ⇒ back off:
    // flush 4× slower for PENALTY_MS so the storm drains. Both reasons are
    // self-healing by construction — the viewer's gap detector asks for a
    // reseed — so nothing is retried here.
    noteDrop(reason) {
      if (reason === 'rate_limited') penaltyUntil = now() + PENALTY_MS;
      if (stats.drops[reason] !== undefined) stats.drops[reason] += 1;
      noteOnce(`pidge terminal: the relay dropped a pane_output frame (${reason}) — self-heals via reseed`);
    },

    // The cable reconnected: repaint anyone still watching (their gap detector
    // may not fire if nothing moved while we were away).
    onRelayUp() { if (viewers > 0) chain(() => seed()); },

    // The hub's control client died under us (session gone, renamed, detached).
    // Stay ALIVE but mark detached: the daemon re-attaches on the next reseed,
    // and until then output simply does not arrive (a gap the reseed heals).
    onHubLost(reason) {
      attached = false;
      noteOnce(`pidge terminal: the mirror's tmux tap for ${target} is gone (${reason}) — the next reseed re-attaches`);
    },

    seed,
    get viewers() { return viewers; },
    get attached() { return attached; },
    get lastInboundAt() { return stats.lastInboundAt; },
    get outSeq() { return outSeq; },
    stats() {
      // A rate needs a sample that can support one. The span between the first
      // and last frame is measured, never clamped: with a single frame it is
      // genuinely 0 ms, and forcing that to 1 ms manufactured "1000 frames/s"
      // on a pane that had sent exactly the seed — 33x over the relay budget,
      // in the one output whose whole job is to be trusted. Under the floor the
      // rate is `null` and the raw count + span are what get reported.
      const spanMs = stats.framesFirstAt && stats.framesLastAt
        ? stats.framesLastAt - stats.framesFirstAt : 0;
      const rateable = stats.framesSent >= 2 && spanMs >= RATE_MIN_SPAN_MS;
      return {
        target, viewers, attached, epoch, out_seq: outSeq,
        frames_sent: stats.framesSent,
        frames_span_ms: spanMs,
        frames_per_s: rateable ? Number((stats.framesSent / (spanMs / 1000)).toFixed(2)) : null,
        stripper_hits: stats.stripperHits,
        seeds: stats.seeds,
        last_seed: stats.lastSeed,
        drops: { ...stats.drops },
        last_inbound_at: stats.lastInboundAt,
        frame_cap: frameCap,
      };
    },
    stop() {
      stopped = true;
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (nudgeTimer) { clearTimeout(nudgeTimer); nudgeTimer = null; }
      pending = [];
      pendingBytes = 0;
      viewers = 0;
    },
  };
}

module.exports = {
  createMirror, BUFFER_DROP_BYTES, SEED_SCROLLBACK, ALT_SCREEN_PREFIX, PENALTY_MS,
  RATE_MIN_SPAN_MS, formatFrameActivity,
};
