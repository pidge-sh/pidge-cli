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
//   · inbound input (seq replay guard, key whitelist → send-keys) and the
//     input-lane resize.
//
// Replay guard: input seq must be strictly increasing. The ledger RESETS on
// a viewer join ping — a fresh viewer legitimately restarts at 1. Residual:
// the join ping is the one unsealed relay message, so a hostile relay could
// forge join+replay to re-run keys it captured THIS epoch, in order, from 1.
// Same residual class the sealed-text fields accept; documented, not fought
// in v1 (the fix would need viewer-persistent seq or a handshake).

const { chunkBytes, keysToTmuxCommands, tmuxQuote, DATA_MAX_BYTES } = require('./wire');

// A runaway burst while the cable is down must not grow memory forever: past
// this, the buffer is dropped WHOLE and a seed repaint is scheduled instead —
// strictly better than a partial stream (the viewer would keep a gap anyway).
const BUFFER_DROP_BYTES = 256 * 1024;

function createMirror({
  control, target, epoch,
  seal,        // (frameObj) → opaque data string (terminal_output AAD)
  open,        // (data)     → frame | null      (terminal_input AAD)
  sendFrame,   // (data)     → boolean — false = not sent (socket down/closed)
  narrate = () => {},
  dataMax = DATA_MAX_BYTES,
  flushMs = 80,
}) {
  let outSeq = 0;          // host→viewer, one counter for o+seed frames
  let lastInSeq = 0;       // the replay-guard ledger (viewer→host)
  let viewers = 0;         // local running balance of join/leave events
  let pending = [];        // coalesce buffer (Buffer[])
  let pendingBytes = 0;
  let flushTimer = null;
  let stopped = false;
  let penaltyUntil = 0;    // rate-limited by the relay → flush slower briefly
  let seedWanted = false;  // a dropped buffer heals via seed on next flush
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
  async function seed() {
    if (stopped) return;
    const t = tmuxQuote(target);
    const size = await control.command(`display-message -p -t ${t} '#{pane_width} #{pane_height}'`);
    const m = size.ok ? /^(\d+)\s+(\d+)/.exec(size.lines[0] || '') : null;
    const cap = await control.command(`capture-pane -p -e -J -S -200 -t ${t}`);
    if (!cap.ok) { noteOnce('pidge terminal: capture-pane failed — seed skipped (will retry on the next reseed)'); return; }
    // Block body lines are latin1-preserved bytes; \r\n between lines so the
    // viewer's emulator repaints rows, not one endless line.
    const data = Buffer.from(cap.lines.join('\r\n') + '\r\n', 'latin1');
    emit({
      t: 'seed', epoch, seq: ++outSeq,
      cols: m ? parseInt(m[1], 10) : 80,
      rows: m ? parseInt(m[2], 10) : 24,
      data: data.toString('base64'),
    });
  }

  async function handleInput(frame) {
    if (frame.t === 'i') {
      const seq = frame.seq;
      if (!Number.isInteger(seq) || seq <= lastInSeq) {
        noteOnce('pidge terminal: dropped non-monotonic input seq (replay guard)');
        return;
      }
      lastInSeq = seq;
      for (const cmd of keysToTmuxCommands(target, frame.keys)) {
        await control.command(cmd); // in order — keystrokes must not interleave
      }
      return;
    }
    if (frame.t === 'reseed') {
      // A reseed proves someone is watching even if we missed their join.
      if (viewers < 1) viewers = 1;
      await seed();
      return;
    }
    if (frame.t === 'resize') {
      const cols = Math.min(500, Math.max(20, parseInt(frame.cols, 10) || 0));
      const rows = Math.min(300, Math.max(5, parseInt(frame.rows, 10) || 0));
      if (!frame.cols || !frame.rows) return;
      // Resizing OUR control client resizes the window (window-size latest);
      // the reflow arrives as ordinary %output.
      await control.command(`refresh-client -C ${cols}x${rows}`);
      return;
    }
    // Unknown t ⇒ a newer viewer — ignore by contract.
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
        if (msg.ev === 'join') {
          viewers += 1;
          lastInSeq = 0; // fresh viewer, fresh seq space (see header note)
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
      const frame = open(msg.data);
      if (!frame) {
        noteOnce('pidge terminal: an inbound frame failed to open (wrong key or corrupt) — ignored');
        return;
      }
      handleInput(frame).catch((e) => narrate(`pidge terminal: input relay error: ${e.message}`));
    },

    // The cable reconnected: repaint anyone still watching (their gap
    // detector may not fire if nothing moved while we were away).
    onRelayUp() {
      if (viewers > 0) seed();
    },

    seed,
    get viewers() { return viewers; },
    stop() {
      stopped = true;
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    },
  };
}

module.exports = { createMirror, BUFFER_DROP_BYTES };
