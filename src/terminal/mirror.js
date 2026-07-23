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
// frame fits the relay's byte cap. `0` (the bare visible screen) always fits.
const SEED_SCROLLBACK = [200, 100, 50, 0];

// A runaway burst while the cable is down must not grow memory forever: past
// this, the buffer is dropped WHOLE and a seed repaint is scheduled instead —
// strictly better than a partial stream (the viewer would keep a gap anyway).
const BUFFER_DROP_BYTES = 256 * 1024;

function createMirror({
  control, target, epoch,
  seal,        // (frameObj)  → opaque data string (terminal_output AAD)
  openViewer,  // (data)      → { frame, field } | null  (tries input + ctrl_viewer)
  sendFrame,   // (data)      → boolean — false = not sent (socket down/closed)
  narrate = () => {},
  dataMax = DATA_MAX_BYTES,
  frameCap = 64 * 1024,   // relay byte ceiling per frame (from the manifest) — caps the seed
  flushMs = 80,
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
  // (-200→-100→-50→0) until the SEALED+base64 frame is under the cap; the bare
  // visible screen (0) always fits and is sent unconditionally as the floor.
  async function seed() {
    if (stopped) return;
    const t = tmuxQuote(target);
    const size = await control.command(`display-message -p -t ${t} '#{pane_width} #{pane_height}'`);
    const m = size.ok ? /^(\d+)\s+(\d+)/.exec(size.lines[0] || '') : null;
    const cols = m ? parseInt(m[1], 10) : 80;
    const rows = m ? parseInt(m[2], 10) : 24;
    for (let i = 0; i < SEED_SCROLLBACK.length; i++) {
      const lines = SEED_SCROLLBACK[i];
      const cap = await control.command(`capture-pane -p -e -J -S -${lines} -t ${t}`);
      if (!cap.ok) { noteOnce('pidge terminal: capture-pane failed — seed skipped (will retry on the next reseed)'); return; }
      if (stopped) return;
      // Block body lines are latin1-preserved bytes; \r\n between lines so the
      // viewer's emulator repaints rows, not one endless line.
      const data = Buffer.from(cap.lines.join('\r\n') + '\r\n', 'latin1');
      const sealed = seal({ t: 'seed', epoch, seq: outSeq + 1, cols, rows, data: data.toString('base64') });
      const last = i === SEED_SCROLLBACK.length - 1;
      if (last || Buffer.byteLength(sealed) <= frameCap) {
        if (!last && i > 0) noteOnce(`pidge terminal: seed shrunk to ${lines} lines of scrollback to fit the relay frame cap`);
        outSeq += 1;
        sendFrame(sealed);
        return;
      }
    }
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
      return;
    }
    // Unknown t ⇒ a newer viewer — ignore by contract.
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
      if (stopped || viewers < 1) return; // nobody watching — drop at zero cost
      pending.push(bytes);
      pendingBytes += bytes.length;
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
    get viewers() { return viewers; },
    stop() {
      stopped = true;
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    },
  };
}

module.exports = { createMirror, BUFFER_DROP_BYTES };
