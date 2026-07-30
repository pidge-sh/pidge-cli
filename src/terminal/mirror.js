'use strict';
// The mirror engine — everything between the tmux control client and the
// sealed relay, for ONE session. Owns:
//   · output coalescing (flush every ~80 ms, ≤16 KB of raw bytes per frame —
//     staying far under the relay's per-frame and frames/s guards),
//   · the viewer balance (join/leave EVENTS from the relay; output is only
//     sealed+sent while someone is actually watching — flow control, not
//     delivery policy: a drop is always healed by reseed),
//   · seed/reseed (capture-pane repaint — THE loss-recovery mechanism: any
//     gap, reconnect or foreground ends in a seed, so drops stay safe),
//   · inbound viewer→host frames: keystrokes on `terminal_input` and ROAMING
//     reseed/resize on `terminal_ctrl_viewer` (a wrapper/attach host has no
//     control lane, so gap-healing rides the session's own :in lane).
//
// Replay guard (spec §3/§4): every viewer→host frame carries a viewer-minted
// `vgen`; the host ledgers `seq` per (AAD field, vgen) and drops anything that
// does not strictly advance its vgen's ledger. A reconnecting viewer mints a
// NEW vgen and restarts at 1. The unsealed, server-forgeable join ping plays
// NO role in the ledger — it is host-side flow control only (viewer balance +
// reseed trigger), so a forged join can never re-open a replay window.

const { chunkBytes, keysToTmuxCommands, tmuxQuote, createLedger, AAD_INPUT, AAD_CTRL_VIEWER, DATA_MAX_BYTES } = require('./wire');

// Scrollback ladder for a seed: try the deepest first, shrink until the sealed
// frame fits the relay's byte cap. `0` (the bare visible screen) does NOT
// always fit (finding #6: a nonblank 500x300 SGR screen is several times the
// cap) — past the floor, seed() degrades (no-SGR recapture, then top-truncate)
// instead of ever sending an over-cap frame.
const SEED_SCROLLBACK = [200, 100, 50, 0];

// Seed state prefix (spec §4 "Seed state prefix" / gotcha #64 / QA 2026-07-29).
// DECSET 1049 — "switch to the alternate screen". Prefixed to the seed's data
// bytes when the pane is on the alternate screen, so the viewer's RIS→feed
// order lands its emulator in the host's buffer state and the alt-drag gate
// (`isCurrentBufferAlternate`) opens for a pre-existing TUI. `1049h` ONLY —
// the seed is not a general state carrier.
const ALT_SCREEN_PREFIX = '\x1b[?1049h';

// A runaway burst while the cable is down must not grow memory forever: past
// this, the buffer is dropped WHOLE and a seed repaint is scheduled instead —
// strictly better than a partial stream (the viewer would keep a gap anyway).
const BUFFER_DROP_BYTES = 256 * 1024;

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

function createMirror({
  control, target, epoch,
  seal,        // (frameObj)  → opaque data string (terminal_output AAD)
  openViewer,  // (data)      → { frame, field } | null  (tries input + ctrl_viewer)
  sendFrame,   // (data)      → boolean — false = not sent (socket down/closed)
  narrate = () => {},
  dataMax = DATA_MAX_BYTES,
  frameCap = 64 * 1024,   // relay byte ceiling per frame (from the manifest) — caps the seed
  flushMs = 80,
  nudgeMs = 500,          // debounce after the LAST resize before the repaint nudge fires
  nudgePauseMs = 60,      // pause between the two jiggle steps (one real SIGWINCH each)
}) {
  let outSeq = 0;          // host→viewer, one counter for o+seed frames
  const ledger = createLedger(); // per-(field, vgen) monotonic seq replay guard
  let viewers = 0;         // local running balance of join/leave events
  let pending = [];        // coalesce buffer (Buffer[])
  let pendingBytes = 0;
  let flushTimer = null;
  let stopped = false;
  let penaltyUntil = 0;    // rate-limited by the relay → flush slower briefly
  let seedWanted = false;  // a dropped buffer heals via seed on next flush
  let inputChain = Promise.resolve(); // serializes inbound frames (see handleCable)
  let nudgeTimer = null;   // debounce timer for the post-resize repaint nudge
  let titleSwallow = false; // live-stream title stripper: inside `ESC k …`, discarding up to ST/BEL
  let heldEsc = false;      // live-stream title stripper: last byte was a bare ESC — classify on the NEXT byte
  const notedOnce = new Set();
  const noteOnce = (msg) => { if (!notedOnce.has(msg)) { notedOnce.add(msg); narrate(msg); } };

  function emit(frame) {
    return sendFrame(seal(frame));
  }

  function scheduleFlush() {
    if (flushTimer || stopped) return;
    const wait = Date.now() < penaltyUntil ? flushMs * 4 : flushMs;
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, wait);
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
  // the reseed protocol can't heal (relay drops it → viewer reseeds → the host
  // regenerates the SAME oversized dump → loop). So shrink scrollback
  // (-200→-100→-50→0) until the SEALED+base64 frame is under the cap. The bare
  // visible screen (0) does NOT always fit — a nonblank SGR-heavy screen at
  // the allowed 500x300 grid is already several times the cap (finding #6) —
  // so past the ladder's floor the seed DEGRADES instead of bypassing the cap:
  //   (a) re-capture without -e (no SGR — plain text shrinks massively; color
  //       is lost, content is not),
  //   (b) still over: truncate lines from the TOP of the dump (the bottom of
  //       the screen is the live part),
  //   and every degrade is narrated loudly. A frame over the cap is NEVER
  //   sent — degrade loudly, never loop (and degrade beats a dark screen).
  async function seed() {
    if (stopped) return;
    const t = tmuxQuote(target);
    // #{alternate_on} rides the SAME display-message as the geometry — the
    // FIRST of the two reads the seed state prefix is gated on (spec §4 "Seed
    // state prefix" / gotcha #64 / QA 2026-07-29): capture-pane renders CELLS,
    // so alternate-screen STATE never crosses the mirror on its own, and the
    // viewer's RIS actively wipes whatever state it had — a viewer joining a
    // pre-existing full-screen TUI never opened the alt-drag gate.
    const size = await control.command(`display-message -p -t ${t} '#{pane_width} #{pane_height} #{alternate_on}'`);
    const m = size.ok ? /^(\d+)\s+(\d+)(?:\s+(\d+))?/.exec(size.lines[0] || '') : null;
    const cols = m ? parseInt(m[1], 10) : 80;
    const rows = m ? parseInt(m[2], 10) : 24;
    const altBefore = !!m && m[3] === '1';

    // One capture (with or without SGR) at one scrollback depth, plus the
    // SECOND #{alternate_on} read immediately after it: the prefix is emitted
    // only if BOTH reads agree on `1` — a TUI exiting mid-seed must fail
    // CLOSED (arrows leaking into a normal shell drive the zsh history; a
    // shut gate merely loses a scroll). Skipped entirely when the first read
    // already said no (no prefix either way). Mid-session flips need nothing:
    // DECSET/DECRST 1049 cross on the LIVE path. Returns null on failure —
    // the caller distinguishes `stopped` (silent) from a real capture error.
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
    const send = (sealed) => { outSeq += 1; sendFrame(sealed); };
    const fits = (sealed) => Buffer.byteLength(sealed) <= frameCap;

    for (let i = 0; i < SEED_SCROLLBACK.length; i++) {
      const got = await capture(true, SEED_SCROLLBACK[i]);
      if (!got) {
        if (!stopped) noteOnce('pidge terminal: capture-pane failed — seed skipped (will retry on the next reseed)');
        return;
      }
      const sealed = sealLines(got.prefix, got.lines);
      if (fits(sealed)) {
        if (i > 0) noteOnce(`pidge terminal: seed shrunk to ${SEED_SCROLLBACK[i]} lines of scrollback to fit the relay frame cap`);
        send(sealed);
        return;
      }
    }

    // Ladder exhausted: the bare visible screen WITH SGR is over the cap.
    // (a) re-capture the visible screen without -e — colors lost, not content.
    const plain = await capture(false, 0);
    if (!plain) {
      if (!stopped) noteOnce('pidge terminal: capture-pane failed — seed skipped (will retry on the next reseed)');
      return;
    }
    let sealed = sealLines(plain.prefix, plain.lines);
    if (fits(sealed)) {
      noteOnce('pidge terminal: seed exceeded the relay frame cap — resent WITHOUT COLORS (SGR stripped, content intact; degrade loudly, never loop)');
      send(sealed);
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
      send(best);
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
      noteOnce('pidge terminal: the relay frame cap is too small for ANY seed — seed skipped (check the server manifest terminal limits)');
      return;
    }
    noteOnce('pidge terminal: seed exceeded the relay frame cap even without colors — TOP bytes truncated to fit (degrade loudly, never loop)');
    send(sealed);
  }

  // Handle one opened viewer→host frame. `field` is the AAD it opened under —
  // it both gates the valid frame types (keystrokes on terminal_input;
  // reseed/resize on terminal_ctrl_viewer) and keys the per-vgen replay ledger.
  async function handleInput(frame, field) {
    if (!ledger.accept(field, frame.vgen, frame.seq)) {
      noteOnce('pidge terminal: dropped a viewer frame (missing vgen or non-monotonic seq — replay guard)');
      return;
    }
    if (field === AAD_INPUT) {
      if (frame.t !== 'i') return; // only keystrokes ride terminal_input
      for (const cmd of keysToTmuxCommands(target, frame.keys)) {
        await control.command(cmd); // in order — keystrokes must not interleave
      }
      return;
    }
    // field === AAD_CTRL_VIEWER: the roaming control frames.
    if (frame.t === 'reseed') {
      await reseed();
      return;
    }
    if (frame.t === 'resize') {
      if (!frame.cols || !frame.rows) return;
      const cols = Math.min(500, Math.max(20, parseInt(frame.cols, 10) || 0));
      const rows = Math.min(300, Math.max(5, parseInt(frame.rows, 10) || 0));
      // Resizing OUR control client resizes the window (window-size latest);
      // the reflow arrives as ordinary %output.
      await control.command(`refresh-client -C ${cols}x${rows}`);
      // …but a no-op resize (same size) yields NO SIGWINCH, so a torn TUI stays
      // torn — schedule the debounced repaint nudge behind the immediate call.
      scheduleRepaintNudge(cols, rows);
      return;
    }
    // Unknown t ⇒ a newer viewer — ignore by contract.
  }

  // Post-resize repaint nudge (QA r4 T0-a). A TUI (Claude Code, vim, htop)
  // already painted at width W is left TORN when the tmux grid changes AFTER
  // it drew — nothing redraws it on its own. Our attached client is the tmux
  // CONTROL client: it renders no screen, so `refresh-client` on it only
  // re-emits the ALREADY-torn grid as %output. The one universal repaint
  // trigger is SIGWINCH, which tmux delivers to the pane ONLY when the window
  // size actually CHANGES — so a resize to the size the window already has
  // (e.g. re-opening the session) produces NO SIGWINCH and the tear persists.
  // Cure: once a burst of resizes has SETTLED (debounced ~nudgeMs after the
  // last one — rotation fires a burst, only the final size gets nudged),
  // reapply the size with a 1-row jiggle so tmux sees two real changes and
  // hands the pane two SIGWINCHes, repainting it at the FINAL size even when
  // the requested resize was a no-op. (`C-l` was rejected: in Claude Code it
  // clears the transcript the human is supervising — never send keys.)
  //
  // Accepted tradeoffs, on purpose:
  // - window-size latest: the immediate resize already makes the PHONE the
  //   "latest" client the moment it gestures; the nudge repeats that up to
  //   ~nudgeMs later, so a Mac-side resize landing inside the debounce window
  //   gets snapped back once. One-shot by construction (the nudge never
  //   re-arms itself), and the Mac wins again by simply acting again.
  // - stop() in the ~pauseMs between the two jiggle steps can leave the tmux
  //   window at rows-1 (the session keeps running — the next attach/resize
  //   heals it).
  // - a resize arriving DURING the pause briefly re-applies the older size;
  //   its own nudge converges within ~nudgeMs.
  // Set PIDGE_TERMINAL_NUDGE_MS=0 to disable the nudge entirely (ops knob).
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

  // Live-stream stripper for the screen title sequence (QA T1 ghost). Inside
  // tmux, TERM=screen* makes the shell (zsh precmd/preexec) emit the screen
  // title sequence `ESC k <title> ST` around every command, and tmux forwards
  // those bytes VERBATIM in %output. SwiftTerm (the iOS viewer) does not treat
  // `ESC k` as a string introducer — it dispatches `k` as a 2-byte escape and
  // paints the TITLE as literal text. That is exactly the live-only ghost
  // ("echor2" where the pane shows "r2", the stray `%` line): capture-pane
  // renders grid cells and never contains the sequence, so it only bites on
  // the live path and every reseed heals it. The mirror has no window-title
  // UI, so removing `ESC k … ST` (BEL accepted defensively) is LOSSLESS here.
  // ONLY `ESC k` is filtered: OSC/APC/PM/SOS are already handled as strings by
  // SwiftTerm — minimalism is the contract, don't grow this into a sanitizer.
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
        if (b === 0x6b) { titleSwallow = true; continue; } // `ESC k` — the introducer SwiftTerm can't parse
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

  // A reseed proves someone is watching even if we missed their join, so it
  // makes output flow again (viewers ≥ 1) and repaints. Shared by the input
  // lane (a viewer's reseed frame) AND the control lane (reseed-by-pid) so
  // both paths self-heal identically — a control-lane reseed must NOT leave a
  // tap attached with viewers stuck at 0 (output would be silently dropped).
  function reseed() {
    if (viewers < 1) viewers = 1;
    return seed();
  }

  return {
    // Raw pane bytes from the control client (%output, already unescaped).
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

    // One message from the cable subscription (host side consumes :in).
    handleCable(msg) {
      if (!msg || typeof msg !== 'object' || stopped) return;
      if (msg.sys === 'viewer') {
        // Flow control ONLY — never a ledger event (join is unsealed and
        // server-forgeable). A join repaints (the viewer reset its emulator).
        if (msg.ev === 'join') {
          viewers += 1;
          seed();
        } else if (msg.ev === 'leave') {
          viewers = Math.max(0, viewers - 1);
        }
        return;
      }
      if (msg.dropped) {
        if (msg.reason === 'rate_limited') penaltyUntil = Date.now() + 2000;
        noteOnce(`pidge terminal: relay dropped a frame (${msg.reason}) — self-heals via reseed`);
        return;
      }
      if (typeof msg.data !== 'string') return;
      const opened = openViewer(msg.data);
      if (!opened) {
        noteOnce('pidge terminal: an inbound frame failed to open (wrong key or corrupt) — ignored');
        return;
      }
      // SERIALIZE: chain onto the previous frame so a multi-command frame
      // (e.g. a literal + Enter) fully drains to tmux before the next frame's
      // keys start — handleCable fires without await, so an unchained
      // handleInput would let two frames' send-keys interleave and scramble
      // keystroke order across frames.
      inputChain = inputChain
        .then(() => handleInput(opened.frame, opened.field))
        .catch((e) => narrate(`pidge terminal: input relay error: ${e.message}`));
    },

    // The cable reconnected: repaint anyone still watching (their gap
    // detector may not fire if nothing moved while we were away).
    onRelayUp() {
      if (viewers > 0) seed();
    },

    seed,
    reseed,
    scheduleRepaintNudge, // the control lane (host.js) drives this for its own resize path
    get viewers() { return viewers; },
    stop() {
      stopped = true;
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (nudgeTimer) { clearTimeout(nudgeTimer); nudgeTimer = null; }
    },
  };
}

module.exports = { createMirror, BUFFER_DROP_BYTES };
