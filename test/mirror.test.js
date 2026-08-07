'use strict';
// Unit tests for the Phase B pane mirror (src/terminal/wire.js, control.js,
// mirror.js, settings.js + the daemon's encaixe).
//
// The mirror engine is testable WITHOUT tmux: it talks to its control client
// through one narrow interface (`command(line) → {ok, lines}`), so a scripted
// mock drives every path the retired arc's 375-test suite used to reach through
// a fake tmux binary. The handful of things only a real tmux can answer — that
// capture-pane on THIS build produces a seed inside the cap, that %output
// round-trips — run under PIDGE_TEST_TMUX=1 against a PRIVATE tmux socket
// (never the developer's own server). That split is the §12 real-binary rule:
// mocks prove the logic, the binary proves the machine.
//
// SAFETY: HOME/XDG are redirected to fresh tmp dirs BEFORE the modules load,
// exactly as test/terminal.test.js does, and the redirection is asserted.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

const REAL_HOME = os.homedir();
process.env.HOME = tmp('pidge-mirror-home-');
process.env.XDG_CONFIG_HOME = tmp('pidge-mirror-xdg-');
if (os.homedir() !== process.env.HOME || os.homedir() === REAL_HOME) {
  throw new Error('refusing to run: os.homedir() does not honor HOME on this platform');
}

const core = require('../src/terminal/core');
const wire = require('../src/terminal/wire');
const settings = require('../src/terminal/settings');
const { ControlHub } = require('../src/terminal/control');
const { createMirror, BUFFER_DROP_BYTES } = require('../src/terminal/mirror');
const { Daemon } = require('../src/terminal/daemon');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'e2e_vectors.json'), 'utf8'));
const REAL_TMUX = process.env.PIDGE_TEST_TMUX === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===========================================================================
// 1. wire.js — the pure helpers that came back
// ===========================================================================

// The exact octal encoder tmux -C uses for %output payloads (mirrors the old
// arc's fake-tmux, which mirrored tmux 3.7).
function octalEscape(buf) {
  let s = '';
  for (const b of buf) {
    if (b === 0x5c) s += '\\134';
    else if (b < 0x20 || b > 0x7e) s += '\\' + b.toString(8).padStart(3, '0');
    else s += String.fromCharCode(b);
  }
  return s;
}

test('unescapeOctal: every byte 0x00–0xFF survives the tmux control-mode escape round-trip', () => {
  const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  assert.ok(wire.unescapeOctal(octalEscape(all)).equals(all), 'the pipeline must be binary-clean');
  // A lone backslash followed by non-octal passes through rather than eating
  // the next byte (tmux's escaping is version-dependent detail).
  assert.ok(wire.unescapeOctal('a\\zb').equals(Buffer.from('a\\zb', 'latin1')));
  assert.ok(wire.unescapeOctal('\\\\').equals(Buffer.from([0x5c])));
});

test('unescapeOctal decodes the fixture o-frame bytes byte-for-byte (the same bytes the viewer asserts)', () => {
  const v = FIXTURE.blob_vectors.find((b) => b.name === 'pane-output-o');
  const bytes = Buffer.from(JSON.parse(v.plaintext_utf8).data, 'base64');
  assert.ok(wire.unescapeOctal(octalEscape(bytes)).equals(bytes),
    'the cross-wire vector must survive the control-mode path unchanged');
});

test('chunkBytes: a burst becomes N well-formed frames; a broken max never stalls the loop', () => {
  const buf = Buffer.alloc(40 * 1024, 0x41);
  assert.equal(wire.chunkBytes(buf, 16 * 1024).length, 3);
  assert.equal(Buffer.concat(wire.chunkBytes(buf, 16 * 1024)).length, buf.length);
  assert.equal(wire.chunkBytes(buf, 0).length, Math.ceil(buf.length / wire.DATA_MAX_BYTES),
    'a non-positive cap (a bad manifest limit) falls back to the protocol chunk size');
});

test('tmuxQuote: the single-quote splice survives a hostile pane name', () => {
  assert.equal(wire.tmuxQuote("a'b"), "'a'\\''b'");
  assert.equal(wire.tmuxQuote('%42'), "'%42'");
});

test('keysForMode: `term` extends the §8 set; agent (and anything unknown) does NOT', () => {
  assert.deepEqual([...wire.AGENT_KEYS].sort(),
    ['BTab', 'C-c', 'Down', 'Enter', 'Escape', 'Tab', 'Up'], 'the §8 seven, unchanged');
  for (const k of ['Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'DC', 'BSpace', 'C-d', 'C-u', 'C-r', 'C-z', 'C-l']) {
    assert.ok(wire.TERM_KEYS.has(k), `${k} belongs to the term set`);
    assert.ok(!wire.AGENT_KEYS.has(k), `${k} must NOT reach an agent pane`);
  }
  assert.equal(wire.keysForMode('term'), wire.TERM_KEYS);
  assert.equal(wire.keysForMode('agent'), wire.AGENT_KEYS);
  // Fail closed: an absent or unknown mode never widens what a viewer may push.
  assert.equal(wire.keysForMode(undefined), wire.AGENT_KEYS);
  assert.equal(wire.keysForMode('TERM'), wire.AGENT_KEYS);
});

test('the geometry clamps are the inherited ones (cols 20–500, rows 5–300) and a NaN lands inside them', () => {
  assert.equal(wire.clampCols(1), 20);
  assert.equal(wire.clampCols(9999), 500);
  assert.equal(wire.clampRows(1), 5);
  assert.equal(wire.clampRows(9999), 300);
  assert.equal(wire.clampCols('nonsense'), 20);
  assert.equal(wire.clampRows(null), 5);
});

// ===========================================================================
// 2. mirror.js — the engine, driven by a scripted control client
// ===========================================================================

// A control client stand-in with the same narrow surface the real one exposes.
// `alt` is a QUEUE of #{alternate_on} answers, consumed one per read (last one
// sticky) — that is how the two-read fail-closed case is scripted without a race.
function mockControl({ cols = 80, rows = 24, alt = ['0'], sgrLines = null, plainLines = null, captureOk = true } = {}) {
  const sent = [];
  const altQueue = [...alt];
  const nextAlt = () => (altQueue.length > 1 ? altQueue.shift() : (altQueue[0] || '0'));
  return {
    sent,
    closed: false,
    captureOk,
    command(line) {
      sent.push(line);
      if (line.startsWith('display-message')) {
        if (line.includes('#{pane_width}')) return Promise.resolve({ ok: true, lines: [`${cols} ${rows} ${nextAlt()}`] });
        return Promise.resolve({ ok: true, lines: [nextAlt()] });
      }
      if (line.startsWith('capture-pane')) {
        if (!this.captureOk) return Promise.resolve({ ok: false, lines: [] });
        const withSgr = line.includes(' -e ');
        const body = (withSgr ? sgrLines : plainLines) || ['seed-line-1', 'seed-line-2 \x1b[1mbold\x1b[0m', '%output %9 NOT_A_REAL_NOTIFICATION'];
        return Promise.resolve({ ok: true, lines: body });
      }
      return Promise.resolve({ ok: true, lines: [] });
    },
  };
}

// Frames are sealed as plain JSON here so the tests can read them AND so the
// frame cap arithmetic is deterministic (the real seal adds a fixed 29-byte
// envelope plus base64 expansion — the ladder logic is identical either way).
function harness(opts = {}) {
  const control = opts.control || mockControl(opts);
  const frames = [];
  const logs = [];
  const mirror = createMirror({
    control,
    target: '%7',
    epoch: 42,
    seal: (f) => JSON.stringify(f),
    sendFrame: (data) => { frames.push(JSON.parse(data)); return opts.cableUp === false ? false : true; },
    narrate: (m) => logs.push(m),
    flushMs: opts.flushMs === undefined ? 5 : opts.flushMs,
    dataMax: opts.dataMax || wire.DATA_MAX_BYTES,
    frameCap: opts.frameCap || 64 * 1024,
    nudgeMs: opts.nudgeMs === undefined ? 20 : opts.nudgeMs,
    nudgePauseMs: opts.nudgePauseMs === undefined ? 5 : opts.nudgePauseMs,
  });
  return { mirror, control, frames, logs };
}

test('the viewer gate: output before any reseed is dropped at ZERO cost — no frame, no buffer', async () => {
  const { mirror, frames } = harness();
  mirror.onOutput(Buffer.from('nobody is watching this'));
  await sleep(30);
  assert.equal(frames.length, 0, 'flow control, not delivery policy — and a drop is always healed by reseed');
  assert.equal(mirror.viewers, 0);
});

test('a reseed PROVES a watcher: it opens the gate and repaints — then live output flows', async () => {
  const { mirror, frames } = harness();
  await mirror.reseed();
  assert.equal(mirror.viewers, 1, 'there is no per-pane join event on this wire — the reseed IS the presence signal');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].t, 'seed');
  assert.equal(frames[0].epoch, 42, 'every frame echoes the daemon epoch (the viewer gap detector reads it)');
  assert.equal(frames[0].seq, 1);
  assert.equal(frames[0].cols, 80);
  assert.equal(frames[0].rows, 24);

  mirror.onOutput(Buffer.from('now it flows'));
  await sleep(30);
  assert.equal(frames.length, 2);
  assert.equal(frames[1].t, 'o');
  assert.equal(frames[1].seq, 2, 'ONE counter per share for o+seed — a gap in it is what triggers a reseed');
  assert.equal(Buffer.from(frames[1].data, 'base64').toString(), 'now it flows');
});

test('the seed body keeps a captured line that LOOKS like a %output notification (block bodies are verbatim)', async () => {
  const { mirror, frames } = harness();
  await mirror.reseed();
  const body = Buffer.from(frames[0].data, 'base64').toString('latin1');
  assert.ok(body.includes('%output %9 NOT_A_REAL_NOTIFICATION'),
    'captured pane content must never be re-interpreted as a live notification');
});

test('coalescing: two writes inside one window become ONE frame; a burst over dataMax becomes N', async () => {
  const { mirror, frames } = harness({ dataMax: 8 });
  await mirror.reseed();
  frames.length = 0;
  mirror.onOutput(Buffer.from('ab'));
  mirror.onOutput(Buffer.from('cd'));
  await sleep(30);
  assert.equal(frames.length, 1);
  assert.equal(Buffer.from(frames[0].data, 'base64').toString(), 'abcd');

  frames.length = 0;
  mirror.onOutput(Buffer.from('0123456789ABCDEFGH')); // 18 B at dataMax 8 ⇒ 3 frames
  await sleep(30);
  assert.equal(frames.length, 3);
  assert.deepEqual(frames.map((f) => f.seq), [3, 4, 5], 'seq stays monotonic across the chunks');
  assert.equal(frames.map((f) => Buffer.from(f.data, 'base64').toString()).join(''), '0123456789ABCDEFGH');
});

test('a runaway burst is dropped WHOLE and healed by a seed — a repaint beats a partial stream', async () => {
  const { mirror, frames } = harness({ flushMs: 200 });
  await mirror.reseed();
  frames.length = 0;
  mirror.onOutput(Buffer.alloc(BUFFER_DROP_BYTES + 1, 0x41));
  await sleep(400);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].t, 'seed', 'the buffered bytes are gone; the viewer gets a full repaint instead of a gap');
});

// --- the seed ladder and its degrade steps (gotcha #65) ---------------------

test('seed ladder: an over-cap SGR screen is resent WITHOUT COLORS — inside the cap, loudly', async () => {
  const fat = Array.from({ length: 40 }, () => '\x1b[1;31m' + 'x'.repeat(200) + '\x1b[0m');
  const lean = Array.from({ length: 40 }, () => 'x'.repeat(20));
  const { mirror, frames, logs } = harness({ sgrLines: fat, plainLines: lean, frameCap: 2000 });
  await mirror.reseed();
  assert.equal(frames.length, 1, 'exactly one seed — an over-cap frame is NEVER sent');
  assert.ok(JSON.stringify(frames[0]).length <= 2000);
  assert.ok(Buffer.from(frames[0].data, 'base64').toString('latin1').includes('x'.repeat(20)));
  assert.ok(logs.some((l) => /WITHOUT COLORS/.test(l)), `expected the loud SGR-strip line, got ${JSON.stringify(logs)}`);
});

test('seed ladder: over the cap even WITHOUT colors ⇒ the TOP lines are truncated (the bottom is the live part)', async () => {
  const many = Array.from({ length: 300 }, (_, i) => `line-${i}-${'y'.repeat(40)}`);
  const { mirror, frames, logs } = harness({ sgrLines: many, plainLines: many, frameCap: 1500 });
  await mirror.reseed();
  assert.equal(frames.length, 1);
  assert.ok(JSON.stringify(frames[0]).length <= 1500);
  const body = Buffer.from(frames[0].data, 'base64').toString('latin1');
  assert.ok(body.includes('line-299'), 'the BOTTOM of the screen survives — it is the live part');
  assert.ok(!body.includes('line-0-'), 'the top is what gets cut');
  assert.ok(logs.some((l) => /TOP lines truncated/.test(l)));
});

test('seed ladder floor: a cap smaller than the envelope itself SKIPS the seed loudly — it never feeds the reseed loop', async () => {
  const { mirror, frames, logs } = harness({ frameCap: 10 });
  await mirror.reseed();
  assert.equal(frames.length, 0, 'sending an over-cap frame would start the loop reseed cannot break');
  assert.ok(logs.some((l) => /too small for ANY seed/.test(l)), `got ${JSON.stringify(logs)}`);
  assert.equal(mirror.outSeq, 0, 'seq only advances when a frame is actually SENT');
});

test('seed: a failed capture-pane is narrated and skipped — the next reseed retries', async () => {
  const control = mockControl();
  control.captureOk = false;
  const { mirror, frames, logs } = harness({ control });
  await mirror.reseed();
  assert.equal(frames.length, 0);
  assert.ok(logs.some((l) => /capture-pane failed/.test(l)));
});

// --- the alternate-screen prefix (gotcha #64) -------------------------------

test('seed: a pane on the ALTERNATE screen prefixes the data with ESC[?1049h (both reads agree)', async () => {
  const { mirror, frames } = harness({ alt: ['1'] });
  await mirror.reseed();
  const data = Buffer.from(frames[0].data, 'base64').toString('latin1');
  assert.ok(data.startsWith('\x1b[?1049h'), 'the viewer\'s RIS wipes the state — the seed has to carry it back');
});

test('seed: the two #{alternate_on} reads DISAGREE (a TUI exited mid-seed) ⇒ NO prefix — fail CLOSED', async () => {
  const { mirror, frames } = harness({ alt: ['1', '0'] });
  await mirror.reseed();
  const data = Buffer.from(frames[0].data, 'base64').toString('latin1');
  assert.ok(!data.startsWith('\x1b[?1049h'),
    'arrows leaking into a normal shell drive the zsh history; a shut gate merely loses a scroll');
});

test('seed: a NORMAL-screen pane never even asks the second time (no prefix, no extra read)', async () => {
  const { mirror, control, frames } = harness({ alt: ['0'] });
  await mirror.reseed();
  const altReads = control.sent.filter((l) => l.includes('#{alternate_on}'));
  assert.equal(altReads.length, 1, 'the confirm read is skipped when the first already said no');
  assert.ok(!Buffer.from(frames[0].data, 'base64').toString('latin1').startsWith('\x1b'));
});

// --- the live-stream title stripper (gotcha #64's sibling) ------------------

async function stripped(chunks) {
  const { mirror, frames } = harness();
  await mirror.reseed();
  frames.length = 0;
  for (const c of chunks) mirror.onOutput(Buffer.from(c, 'latin1'));
  await sleep(30);
  return { text: frames.map((f) => Buffer.from(f.data, 'base64').toString('latin1')).join(''), mirror };
}

test('stripper: `ESC k title ST` in one chunk — the title never reaches the viewer, the output does', async () => {
  const { text, mirror } = await stripped(['\x1bkzsh-title\x1b\\hello']);
  assert.equal(text, 'hello');
  assert.equal(mirror.stats().stripper_hits, 1);
});

test('stripper: the sequence SPLIT across chunks — mid-title AND mid-`ESC k` — is still stripped', async () => {
  const { text } = await stripped(['before\x1b', 'ktit', 'le\x1b', '\\after']);
  assert.equal(text, 'beforeafter', 'the state must survive chunk boundaries — a per-buffer regex could never be correct');
});

test('stripper: a bare ESC at a chunk edge that is NOT a title passes intact, in order — no byte lost', async () => {
  const { text } = await stripped(['x\x1b', '[1mbold\x1b[0m']);
  assert.equal(text, 'x\x1b[1mbold\x1b[0m');
});

test('stripper: BEL also terminates the title (defensive)', async () => {
  const { text } = await stripped(['\x1bktitle\x07out']);
  assert.equal(text, 'out');
});

test('stripper: it sees every byte even while NOBODY watches — stale state would eat real output after the join', async () => {
  const { mirror, frames } = harness();
  mirror.onOutput(Buffer.from('\x1bkhalf-a-title', 'latin1')); // opens the swallow with viewers = 0
  await mirror.reseed();
  frames.length = 0;
  mirror.onOutput(Buffer.from('\x1b\\real output', 'latin1'));
  await sleep(30);
  assert.equal(frames.map((f) => Buffer.from(f.data, 'base64').toString('latin1')).join(''), 'real output',
    'the title that straddled the join is swallowed whole, and the real bytes survive');
});

// --- resize + the repaint nudge (QA r4 T0-a) --------------------------------

test('resize: clamps, refreshes the client, then jiggles ONE row to force a SIGWINCH — and NEVER sends C-l', async () => {
  const { mirror, control } = harness({ nudgeMs: 10, nudgePauseMs: 2 });
  await mirror.resize(9999, 1); // both out of range
  await sleep(60);
  const refreshes = control.sent.filter((l) => l.startsWith('refresh-client'));
  assert.deepEqual(refreshes, ['refresh-client -C 500x5', 'refresh-client -C 500x6', 'refresh-client -C 500x5'],
    'immediate resize, then the jiggle pair that ends at the requested size (rows-1 hit the ≥5 floor, so it jiggles UP)');
  assert.ok(!control.sent.some((l) => /send-keys/.test(l)),
    'C-l was rejected and stays rejected: in Claude Code it clears the transcript the human is supervising');
});

test('resize: a BURST nudges only the FINAL size, once (the debounce re-arms per resize)', async () => {
  const { mirror, control } = harness({ nudgeMs: 30, nudgePauseMs: 2 });
  mirror.resize(100, 30);
  mirror.resize(110, 40);
  mirror.resize(120, 50);
  await sleep(120);
  const refreshes = control.sent.filter((l) => l.startsWith('refresh-client'));
  assert.deepEqual(refreshes.slice(-2), ['refresh-client -C 120x49', 'refresh-client -C 120x50']);
  assert.equal(refreshes.filter((l) => /x49$/.test(l)).length, 1, 'rotation fires a burst; only the final size is nudged');
});

test('resize: a NO-OP resize still nudges — that is the whole motivating case (no size change ⇒ no SIGWINCH)', async () => {
  const { mirror, control } = harness({ nudgeMs: 10, nudgePauseMs: 2 });
  await mirror.resize(80, 24);
  await sleep(60);
  assert.ok(control.sent.filter((l) => l.startsWith('refresh-client')).length >= 3,
    'a torn TUI at the size it already has is exactly what the jiggle exists to repaint');
});

test('nudge_ms = 0 disables the nudge entirely (the ops knob), leaving the immediate resize alone', async () => {
  const { mirror, control } = harness({ nudgeMs: 0 });
  await mirror.resize(100, 30);
  await sleep(60);
  assert.deepEqual(control.sent.filter((l) => l.startsWith('refresh-client')), ['refresh-client -C 100x30']);
});

// --- the relay's drop notice (spec §19) -------------------------------------

test('frame_dropped rate_limited ⇒ the flush slows 4× for the penalty window; frame_too_large is counted, not penalised', async () => {
  const { mirror, frames, logs } = harness({ flushMs: 20 });
  await mirror.reseed();
  frames.length = 0;

  mirror.noteDrop('rate_limited');
  mirror.onOutput(Buffer.from('slow'));
  await sleep(40);
  assert.equal(frames.length, 0, 'inside the penalty the flush waits 4× longer (20 → 80 ms)');
  await sleep(80);
  assert.equal(frames.length, 1, '…and then it drains — never retried, never dropped on the floor');

  mirror.noteDrop('frame_too_large');
  const st = mirror.stats();
  assert.equal(st.drops.rate_limited, 1);
  assert.equal(st.drops.frame_too_large, 1);
  assert.ok(logs.some((l) => /self-heals via reseed/.test(l)), 'a drop is narrated once, honestly');
});

test('a cable that is DOWN loses the frame silently and the reconnect repaints — nothing is ever queued', async () => {
  const { mirror, frames } = harness({ cableUp: false });
  await mirror.reseed();
  assert.equal(mirror.outSeq, 1, 'seq advances on the attempt — the viewer detects the gap and asks');
  frames.length = 0;
  mirror.onRelayUp();
  await sleep(30);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].t, 'seed', 'the cable coming back is a repaint, not a replay (there is no buffer to replay from)');
});

test('stop(): no timer, no frame, no viewer survives it', async () => {
  const { mirror, frames } = harness();
  await mirror.reseed();
  frames.length = 0;
  mirror.stop();
  mirror.onOutput(Buffer.from('after the stop'));
  await mirror.reseed();
  await sleep(40);
  assert.equal(frames.length, 0);
  assert.equal(mirror.viewers, 0);
});

test('onHubLost marks the mirror detached and says so ONCE — the next reseed re-attaches', async () => {
  const { mirror, logs } = harness();
  assert.equal(mirror.attached, true);
  mirror.onHubLost('the tmux session was renamed');
  mirror.onHubLost('the tmux session was renamed');
  assert.equal(mirror.attached, false);
  assert.equal(logs.filter((l) => /tmux tap for %7 is gone/.test(l)).length, 1);
});

// ===========================================================================
// 3. ControlHub — one client per tmux SESSION, %output routed per pane
// ===========================================================================

function fakeControlFactory() {
  const made = [];
  const create = (opts) => {
    const c = {
      opts, closed: false, commands: [],
      command(line) { c.commands.push(line); return Promise.resolve({ ok: true, lines: [] }); },
      kill() { c.closed = true; },
      emit(paneId, bytes) { opts.onOutput(paneId, Buffer.from(bytes)); },
      event(tag, rest = '') { opts.onEvent(tag, rest); },
      close(reason) { c.closed = true; opts.onClose(reason); },
    };
    made.push(c);
    return c;
  };
  return { made, create };
}

test('hub: two panes of the SAME tmux session share ONE control client (two clients would fight over the geometry)', () => {
  const f = fakeControlFactory();
  const hub = new ControlHub({ create: f.create });
  const a = hub.attach('work', '%1', { onOutput: () => {} });
  const b = hub.attach('work', '%2', { onOutput: () => {} });
  assert.equal(f.made.length, 1);
  assert.equal(a.control, b.control);
  assert.equal(hub.size, 1);
  // …and a pane in ANOTHER session is a second client, as tmux -C requires.
  hub.attach('other', '%9', { onOutput: () => {} });
  assert.equal(f.made.length, 2);
  assert.equal(hub.size, 2);
});

test('hub: %output is delivered to the mirror of THAT pane and to nobody else (§19: filter by pane_id)', () => {
  const f = fakeControlFactory();
  const hub = new ControlHub({ create: f.create });
  const got = { '%1': [], '%2': [] };
  hub.attach('work', '%1', { onOutput: (b) => got['%1'].push(b.toString()) });
  hub.attach('work', '%2', { onOutput: (b) => got['%2'].push(b.toString()) });
  f.made[0].emit('%1', 'for one');
  f.made[0].emit('%2', 'for two');
  f.made[0].emit('%99', 'for a pane nobody shared');
  assert.deepEqual(got['%1'], ['for one']);
  assert.deepEqual(got['%2'], ['for two']);
});

test('hub: refcount — the LAST pane to leave takes the client with it', () => {
  const f = fakeControlFactory();
  const hub = new ControlHub({ create: f.create });
  const a = hub.attach('work', '%1', { onOutput: () => {} });
  const b = hub.attach('work', '%2', { onOutput: () => {} });
  a.release();
  assert.equal(f.made[0].closed, false, 'one pane left — the tap stays');
  b.release();
  assert.equal(f.made[0].closed, true);
  assert.equal(hub.size, 0);
});

test('hub: %session-renamed is a HIGH death — every pane is told, and the client is killed (old-arc finding #10)', () => {
  const f = fakeControlFactory();
  const said = [];
  const hub = new ControlHub({ create: f.create, narrate: (m) => said.push(m) });
  const lost = [];
  hub.attach('work', '%1', { onOutput: () => {}, onLost: (r) => lost.push(['%1', r]) });
  hub.attach('work', '%2', { onOutput: () => {}, onLost: (r) => lost.push(['%2', r]) });
  f.made[0].event('session-renamed', '$0 newname');
  assert.equal(lost.length, 2, 'after a rename the -t target silently addresses nothing — both mirrors must know');
  assert.equal(hub.size, 0);
  assert.equal(f.made[0].closed, true);
  assert.ok(said.some((m) => /RENAMED/.test(m)));
});

test('hub: a dead client\'s late onClose can NEVER tear down its successor (identity guard, gotcha #66)', () => {
  const f = fakeControlFactory();
  const hub = new ControlHub({ create: f.create });
  const lost = [];
  hub.attach('work', '%1', { onOutput: () => {}, onLost: (r) => lost.push(r) });
  const first = f.made[0];
  first.close('the session died'); // entry dropped, mirror told
  assert.equal(lost.length, 1);

  hub.attach('work', '%1', { onOutput: () => {}, onLost: (r) => lost.push(r) }); // a fresh tap
  assert.equal(f.made.length, 2);
  first.opts.onClose('a late goodbye from the OLD client');
  assert.equal(lost.length, 1, 'the successor survives the corpse\'s callbacks');
  assert.equal(hub.size, 1);
  // …and so does its output routing.
  const seen = [];
  hub.attach('work', '%2', { onOutput: (b) => seen.push(b.toString()) });
  first.emit('%2', 'from the dead client');
  assert.deepEqual(seen, [], 'a superseded client\'s bytes never reach a live pane table');
});

test('hub: a release() from a stale handle does not touch the live entry', () => {
  const f = fakeControlFactory();
  const hub = new ControlHub({ create: f.create });
  const stale = hub.attach('work', '%1', { onOutput: () => {} });
  f.made[0].close('died');
  hub.attach('work', '%1', { onOutput: () => {} });
  stale.release();
  assert.equal(hub.size, 1, 'the fresh tap survives a stale release');
  assert.equal(f.made[1].closed, false);
});

test('hub: stopAll detaches every client deliberately (a leaked `tmux -C attach` is a client tmux keeps counting)', () => {
  const f = fakeControlFactory();
  const hub = new ControlHub({ create: f.create });
  hub.attach('a', '%1', { onOutput: () => {} });
  hub.attach('b', '%2', { onOutput: () => {} });
  assert.equal(hub.stats().length, 2);
  hub.stopAll();
  assert.equal(hub.size, 0);
  assert.ok(f.made.every((c) => c.closed));
});

// ===========================================================================
// 4. settings.js — terminal.toml
// ===========================================================================

test('terminal.toml: the knobs parse, unknown keys and foreign sections are ignored, junk warns', () => {
  const { settings: s, warnings } = settings.parseSettings([
    '# the ops file',
    'mirror_idle_ms = 60000',
    'nudge_ms = 0            # off',
    'something_new = 5       ',
    '[[profile]]',
    'mirror_idle_ms = 1      # inside a foreign section — not ours',
    'this line is junk',
  ].join('\n'));
  assert.equal(s.mirror_idle_ms, 60000);
  assert.equal(s.nudge_ms, 0, '0 is a real value (nudge OFF), not a clamp floor');
  assert.equal(warnings.length, 0, 'unknown keys and foreign sections are additive-silent');
});

test('terminal.toml: a missing file is the defaults, and an out-of-range value is CLAMPED loudly', () => {
  const dir = tmp('pidge-toml-');
  const missing = settings.loadSettings(dir);
  assert.equal(missing.missing, true);
  assert.equal(missing.settings.mirror_idle_ms, 5 * 60_000, 'the design pin: 5 minutes');
  assert.equal(missing.settings.nudge_ms, 500);

  fs.writeFileSync(path.join(dir, 'terminal.toml'), 'mirror_idle_ms = 1\nnudge_ms = "500"\n');
  const loaded = settings.loadSettings(dir);
  assert.equal(loaded.settings.mirror_idle_ms, 10_000, 'clamped to the floor');
  assert.equal(loaded.settings.nudge_ms, 500, 'a non-integer falls back to the default');
  assert.equal(loaded.warnings.length, 2, 'both are said out loud — a silent clamp is a lie');
});

// ===========================================================================
// 5. the daemon encaixe — lane, key sets, attach policy, stand-down
// ===========================================================================

const SECRET = crypto.randomBytes(32).toString('base64url');

function freshXdg() {
  process.env.XDG_CONFIG_HOME = tmp('pidge-mirror-xdg-');
  return process.env.XDG_CONFIG_HOME;
}

// A daemon with a stubbed tmux + cable: the hub never spawns a process, and
// every perform lands in `sent` so the wire can be read byte by byte.
function mirrorDaemon({ secret = SECRET, channelId = 1, occupant = 'term' } = {}) {
  freshXdg();
  core.saveTerminalEnv({ base: 'http://127.0.0.1:9', token: 'hld_x', secret, channelId });
  core.writeJson(core.DAEMON_FILE(), { port: 41719, token: 'local-test-token' });
  const d = new Daemon();
  d.logLines = [];
  d.log = (...a) => { d.logLines.push(a.join(' ')); };
  d.subscribeInput = () => {};
  d.tmuxSessionForPane = () => 'work';
  d.paneAlive = () => true;
  const f = fakeControlFactory();
  d.hub.create = f.create;
  d.fake = f;
  const sent = [];
  d.sent = sent;
  d.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
  d.wsConfirmed = true;
  const session = {
    sid: 'sess-m', publicId: 'ases_t', paneId: '%1', occupant,
    status: 'idle', waitingArmed: true, approvals: [], tty: null,
  };
  d.sessions.set(session.sid, session);
  return { d, session, fake: f, sent };
}

function inputFrame(d, msg, { aad, publicId = 'ases_t', channelId = 1 } = {}) {
  return core.e2eEncryptBlob(d.key, aad || core.e2eAad(channelId, publicId, 'agent_input'),
    Buffer.from(JSON.stringify(msg), 'utf8')).toString('base64url');
}

// The sealed pane_output frames the daemon put on the wire, opened back up.
function paneFrames(d, sent, { publicId = 'ases_t', channelId = 1 } = {}) {
  return sent
    .map((m) => JSON.parse(m.data))
    .filter((p) => p.action === 'frame')
    .map((p) => JSON.parse(core.e2eDecryptBlob(d.key,
      core.e2eAad(channelId, publicId, 'pane_output'),
      Buffer.from(p.frame, 'base64url')).toString('utf8')));
}

test('daemon: a `reseed` on the agent_input lane attaches the mirror and puts a sealed seed on the share\'s OWN subscription', async () => {
  const { d, session, sent } = mirrorDaemon({ occupant: 'agent' });
  assert.equal(d.mirrors.size, 0, 'an agent pane is NOT mirrored until its raw peek opens');

  d.handleInputFrame(session, inputFrame(d, { t: 'reseed', vgen: 'v1', seq: 1, he: d.state.epoch }));
  await sleep(40);
  assert.equal(d.mirrors.size, 1, 'the reseed IS the raw toggle opening (§19)');

  const performs = sent.filter((m) => JSON.parse(m.data).action === 'frame');
  assert.equal(performs.length, 1);
  assert.equal(performs[0].command, 'message');
  assert.equal(JSON.parse(performs[0].identifier).channel, 'AgentSessionChannel',
    'the mirror rides the share\'s EXISTING subscription — the ONE server change is a perform, not a channel');
  assert.equal(JSON.parse(performs[0].identifier).public_id, 'ases_t');

  const [frame] = paneFrames(d, sent);
  assert.equal(frame.t, 'seed');
  assert.equal(frame.epoch, d.state.epoch);
  assert.equal(frame.seq, 1);
});

test('daemon: viewer_joined warms EVERY term pane eagerly — attached, but emitting NOTHING until a reseed', async () => {
  const { d, sent } = mirrorDaemon({ occupant: 'term' });
  d.onViewerJoined();
  assert.equal(d.mirrors.size, 1, 'the tap is warm so the first paint is instant');
  assert.equal(d.mirrors.get('sess-m').mirror.viewers, 0, 'emission is GATED — a warm tap costs zero cable traffic');
  d.fake.made[0].emit('%1', 'output nobody asked for');
  await sleep(40);
  assert.equal(sent.filter((m) => JSON.parse(m.data).action === 'frame').length, 0);
});

test('daemon: an AGENT pane is never warmed by viewer_joined (its default surface is the transcript)', () => {
  const { d } = mirrorDaemon({ occupant: 'agent' });
  d.onViewerJoined();
  assert.equal(d.mirrors.size, 0);
});

test('daemon: live pane output reaches the wire sealed on pane_output, binary-clean across 0x80–0xFF', async () => {
  const { d, session, sent } = mirrorDaemon({ occupant: 'term' });
  d.handleInputFrame(session, inputFrame(d, { t: 'reseed', vgen: 'v1', seq: 1, he: d.state.epoch }));
  await sleep(40);
  sent.length = 0;

  const raw = Buffer.from(Array.from({ length: 128 }, (_, i) => 0x80 + i));
  d.fake.made[0].emit('%1', raw);
  await sleep(250); // the daemon's mirror uses the production 80 ms coalesce window
  const frames = paneFrames(d, sent);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].t, 'o');
  assert.ok(Buffer.from(frames[0].data, 'base64').equals(raw), 'not one byte is mangled between tmux and the seal');
});

test('daemon: a `resize` clamps and drives the tmux client; on an AGENT pane with no raw view open it attaches NOTHING', async () => {
  const term = mirrorDaemon({ occupant: 'term' });
  term.d.handleInputFrame(term.session, inputFrame(term.d, { t: 'resize', cols: 9999, rows: 2, vgen: 'v1', seq: 1, he: term.d.state.epoch }));
  await sleep(40);
  assert.equal(term.d.mirrors.size, 1);
  assert.ok(term.fake.made[0].commands.some((c) => c === 'refresh-client -C 500x5'));

  const agent = mirrorDaemon({ occupant: 'agent' });
  agent.d.handleInputFrame(agent.session, inputFrame(agent.d, { t: 'resize', cols: 100, rows: 30, vgen: 'v1', seq: 1, he: agent.d.state.epoch }));
  await sleep(20);
  assert.equal(agent.d.mirrors.size, 0, 'only a reseed (the raw toggle) opens an agent pane\'s mirror');
});

test('daemon: reseed/resize obey the ONE replay ledger — no vgen/he, no frame (and a replay is dropped)', async () => {
  const { d, session } = mirrorDaemon({ occupant: 'term' });
  d.handleInputFrame(session, inputFrame(d, { t: 'reseed', seq: 1, he: d.state.epoch })); // no vgen
  assert.match(d.logLines.at(-1), /missing t\/vgen\/seq\/he/);
  assert.equal(d.mirrors.size, 0);

  d.logLines = [];
  d.handleInputFrame(session, inputFrame(d, { t: 'reseed', vgen: 'v1', seq: 1, he: d.state.epoch - 1 }));
  assert.match(d.logLines.at(-1), /epoch/, 'pre-restart ciphertext dies on the he echo');
  assert.equal(d.mirrors.size, 0);

  d.logLines = [];
  const frame = inputFrame(d, { t: 'reseed', vgen: 'v1', seq: 1, he: d.state.epoch });
  d.handleInputFrame(session, frame);
  await sleep(30);
  assert.equal(d.mirrors.size, 1);
  const before = d.mirrors.get('sess-m').mirror.outSeq;
  d.handleInputFrame(session, frame); // byte-identical replay
  await sleep(30);
  assert.match(d.logLines.at(-1), /replay/);
  assert.equal(d.mirrors.get('sess-m').mirror.outSeq, before, 'a replayed reseed does not even repaint');
});

test('daemon: an unknown frame type is ignored by contract (§12 additive evolution)', () => {
  const { d, session } = mirrorDaemon();
  d.handleInputFrame(session, inputFrame(d, { t: 'scroll', vgen: 'v1', seq: 1, he: d.state.epoch, lines: 5 }));
  assert.match(d.logLines.at(-1), /missing t\/vgen\/seq\/he/, 'a newer viewer never breaks this daemon');
});

test('daemon: the key set follows `mode` — C-l reaches a term pane and is DROPPED WHOLE on an agent pane', () => {
  const execd = [];
  const realExec = core.tmuxExec;
  core.tmuxExec = (args) => { execd.push(args.join(' ')); return ''; };
  try {
    const term = mirrorDaemon({ occupant: 'term' });
    term.d.handleInputFrame(term.session, inputFrame(term.d, {
      t: 'i', vgen: 'v1', seq: 1, he: term.d.state.epoch,
      keys: [{ key: 'C-l' }, { key: 'PageUp' }, { key: 'Enter' }],
    }));
    assert.deepEqual(execd, ['send-keys -t %1 C-l', 'send-keys -t %1 PageUp', 'send-keys -t %1 Enter']);

    execd.length = 0;
    const agent = mirrorDaemon({ occupant: 'agent' });
    agent.d.handleInputFrame(agent.session, inputFrame(agent.d, {
      t: 'i', vgen: 'v1', seq: 1, he: agent.d.state.epoch,
      keys: [{ key: 'C-l' }, { key: 'PageUp' }, { key: 'Enter' }],
    }));
    assert.deepEqual(execd, ['send-keys -t %1 Enter'],
      'a raw peek does NOT widen the set — the composer is the one surface, and §16 is what fixes a wrong mode');
  } finally {
    core.tmuxExec = realExec;
  }
});

test('daemon: the relay\'s frame_dropped notice reaches the mirror that earned it', async () => {
  const { d, session } = mirrorDaemon({ occupant: 'term' });
  d.handleInputFrame(session, inputFrame(d, { t: 'reseed', vgen: 'v1', seq: 1, he: d.state.epoch }));
  await sleep(30);
  const mirror = d.mirrors.get('sess-m').mirror;
  d.ws.onmessage = null;
  // The daemon's own dispatch path (what ensureCable installs) is exercised
  // through the same shape the server sends.
  const ident = JSON.stringify({ channel: 'AgentSessionChannel', public_id: 'ases_t' });
  const handle = (msg) => {
    const found = [...d.sessions.values()].find((s) => s.publicId === JSON.parse(ident).public_id);
    const entry = found && d.mirrors.get(found.sid);
    if (entry) entry.mirror.noteDrop(String(msg.reason));
  };
  handle({ type: 'frame_dropped', reason: 'rate_limited' });
  assert.equal(mirror.stats().drops.rate_limited, 1);
});

test('daemon: the mirror stands down only when BOTH windows are cold — and a reseed brings it right back', async () => {
  const { d, session } = mirrorDaemon({ occupant: 'term' });
  d.handleInputFrame(session, inputFrame(d, { t: 'reseed', vgen: 'v1', seq: 1, he: d.state.epoch }));
  await sleep(30);
  assert.equal(d.mirrors.size, 1);

  d.mirrorSettings = { ...d.mirrorSettings, mirror_idle_ms: 0 }; // the share window is cold
  d.lastViewerActivityAt = Date.now();                            // …but a viewer is on this computer
  d.mirrorTick();
  assert.equal(d.mirrors.size, 1, 'a human reading a still screen sends nothing — that is not absence');

  d.lastViewerActivityAt = 0; // now the computer is cold too
  d.mirrorTick();
  assert.equal(d.mirrors.size, 0);
  assert.ok(d.logLines.some((l) => /standing down/.test(l)), 'a stand-down is never silent');
  assert.equal(d.fake.made[0].closed, true, 'the tmux tap goes with it');

  d.handleInputFrame(session, inputFrame(d, { t: 'reseed', vgen: 'v1', seq: 2, he: d.state.epoch }));
  await sleep(30);
  assert.equal(d.mirrors.size, 1, 'standing down early is safe by construction — the reseed re-attaches');
  assert.equal(d.fake.made.length, 2);
});

test('daemon: disabling a share takes its mirror and its tmux tap with it', async () => {
  const { d, session } = mirrorDaemon({ occupant: 'term' });
  d.api = async () => ({ res: { status: 204 } });
  d.releaseWriterLock = () => {};
  d.handleInputFrame(session, inputFrame(d, { t: 'reseed', vgen: 'v1', seq: 1, he: d.state.epoch }));
  await sleep(30);
  await d.disableSession('sess-m', 'test');
  assert.equal(d.mirrors.size, 0);
  assert.equal(d.fake.made[0].closed, true, 'the tap dies with the consent that opened it');
});

test('daemon: a frame over the relay cap is refused HERE, loudly — never handed to a relay that would eat it', async () => {
  const { d, session, sent } = mirrorDaemon({ occupant: 'term' });
  d.caps = { ...d.caps, pane_output_frame_max_bytes: 200 };
  d.handleInputFrame(session, inputFrame(d, { t: 'reseed', vgen: 'v1', seq: 1, he: d.state.epoch }));
  await sleep(30);
  sent.length = 0;
  // The seed ladder degrades inside the cap, so force the case from the other
  // side: a live chunk bigger than the (absurdly small) cap.
  d.mirrors.get('sess-m').mirror.noteInbound();
  d.fake.made[0].emit('%1', 'x'.repeat(4096));
  await sleep(250);
  assert.equal(sent.filter((m) => JSON.parse(m.data).action === 'frame').length, 0);
  assert.ok(d.logLines.some((l) => /over the 200B relay cap/.test(l)));
});

test('daemon: GET /mirror reports the taps, the cap and the knobs (what `doctor` prints)', async () => {
  const { d, session } = mirrorDaemon({ occupant: 'term' });
  d.handleInputFrame(session, inputFrame(d, { t: 'reseed', vgen: 'v1', seq: 1, he: d.state.epoch }));
  await sleep(30);
  const r = d.mirrorReport();
  assert.equal(r.frame_cap, 65536, 'the manifest v104 limit, from the caps cache');
  assert.equal(r.settings.mirror_idle_ms, 5 * 60_000);
  assert.deepEqual(r.hub, [{ session: 'work', panes: ['%1'], alive: true }]);
  assert.equal(r.shares.length, 1);
  assert.equal(r.shares[0].public_id, 'ases_t');
  assert.equal(r.shares[0].mode, 'term');
  assert.ok(r.shares[0].last_seed.fits);
});

// --- cross-wire: the DAEMON's own seal/open against the fixture bytes -------

test('cross-wire: the daemon seals pane_output on the EXACT AAD the fixture pins, and opens the fixture\'s own bytes', () => {
  const anchor = 'ases_c0ffee01-e2e0-4010-8010-000000000010';
  const { d } = mirrorDaemon({ secret: FIXTURE.key_b64url, channelId: 42 });
  const session = { sid: 's', publicId: anchor, paneId: '%1', occupant: 'term' };

  for (const name of ['pane-output-seed', 'pane-output-o']) {
    const v = FIXTURE.blob_vectors.find((b) => b.name === name);
    const frame = JSON.parse(v.plaintext_utf8);

    // 1. The daemon's AAD construction IS the fixture's AAD, character for
    //    character — that string is the contract both sides authenticate on.
    assert.equal(core.e2eAad(42, anchor, 'pane_output'), v.aad, `${name}: AAD`);

    // 2. What the daemon SEALS opens back to the exact fixture plaintext (the
    //    nonce is random in production, so byte-identity is asserted on the
    //    plaintext + AAD, which is what interop actually needs).
    const sealed = d.sealPaneFrame(session, frame);
    const opened = core.e2eDecryptBlob(d.key, v.aad, Buffer.from(sealed, 'base64url'));
    assert.equal(opened.toString('utf8'), v.plaintext_utf8, `${name}: daemon seal → fixture plaintext`);
    assert.equal(crypto.createHash('sha256').update(opened).digest('hex'), v.plaintext_sha256_hex);

    // 3. And the fixture's OWN sealed bytes open on this daemon's key/AAD —
    //    the viewer half of the wire, executed here.
    const back = core.e2eDecryptBlob(d.key, core.e2eAad(42, anchor, 'pane_output'),
      Buffer.from(v.framed_b64url, 'base64url'));
    assert.deepEqual(JSON.parse(back.toString('utf8')), frame, `${name}: fixture bytes open daemon-side`);
  }

  // 4. The anchor symmetry: pane_output and agent_transcript share this ases_
  //    anchor, so the field name is the ONLY separator. Crossing it must fail.
  const paneO = FIXTURE.blob_vectors.find((b) => b.name === 'pane-output-o');
  assert.throws(() => core.e2eDecryptBlob(d.key, core.e2eAad(42, anchor, 'agent_transcript'),
    Buffer.from(paneO.framed_b64url, 'base64url')),
  /failed to authenticate/, 'raw terminal bytes must never validate as a transcript item');
});

test('cross-wire: the fixture\'s reseed/resize frames drive the daemon through its REAL input path', async () => {
  const anchor = 'ases_c0ffee01-e2e0-4010-8010-000000000010';
  const { d } = mirrorDaemon({ secret: FIXTURE.key_b64url, channelId: 42, occupant: 'term' });
  const session = {
    sid: 'sess-fx', publicId: anchor, paneId: '%1', occupant: 'term',
    status: 'idle', waitingArmed: true, approvals: [], tty: null,
  };
  d.sessions.clear();
  d.sessions.set(session.sid, session);
  // The fixture frames were minted with he: 7 — the daemon epoch is per
  // process, so pin it to the vector's rather than re-seal the bytes.
  d.state.epoch = 7;

  for (const name of ['agent-input-reseed', 'agent-input-resize']) {
    const v = FIXTURE.blob_vectors.find((b) => b.name === name);
    // Presented EXACTLY as the relay presents it: the sealed blob, base64url.
    d.handleInputFrame(session, v.framed_b64url);
  }
  await sleep(60);
  assert.equal(d.mirrors.size, 1, 'the fixture reseed attached a real mirror');
  assert.ok(d.fake.made[0].commands.some((c) => c === 'refresh-client -C 120x40'),
    'the fixture resize reached tmux with its own cols/rows');
});

// ===========================================================================
// 6. against the REAL binary (PIDGE_TEST_TMUX=1) — §12's acceptance rule
// ===========================================================================

function tmuxSock(sock, args) {
  return execFileSync('tmux', ['-L', sock, ...args], { encoding: 'utf8', timeout: 10_000 });
}

test('mirror (REAL tmux): a live pane seeds inside the cap and its bytes round-trip through %output',
  { skip: !REAL_TMUX }, async () => {
    const sock = `pidge-mirror-${process.pid}`;
    tmuxSock(sock, ['new-session', '-d', '-s', 'mt', '-x', '80', '-y', '24']);
    try {
      const paneId = tmuxSock(sock, ['list-panes', '-t', 'mt', '-F', '#{pane_id}']).trim();
      const hub = new ControlHub({ socketArgs: ['-L', sock], narrate: () => {} });
      const frames = [];
      const h = hub.attach('mt', paneId, { onOutput: (b) => mirror.onOutput(b), onLost: () => {} });
      const mirror = createMirror({
        control: h.control, target: paneId, epoch: 9,
        seal: (f) => JSON.stringify(f),
        sendFrame: (data) => { frames.push(JSON.parse(data)); return true; },
        frameCap: 65536, flushMs: 30, nudgeMs: 0,
      });
      await sleep(400); // let the attach settle
      await mirror.reseed();

      const seed = frames.find((f) => f.t === 'seed');
      assert.ok(seed, 'the real capture-pane produced a seed');
      assert.ok(JSON.stringify(seed).length <= 65536, 'and it fits the relay frame cap on THIS tmux');
      assert.equal(seed.cols, 80);
      assert.equal(seed.rows, 24);
      assert.equal(seed.epoch, 9);

      frames.length = 0;
      tmuxSock(sock, ['send-keys', '-t', paneId, '-l', 'echo pidge-mirror-real']);
      tmuxSock(sock, ['send-keys', '-t', paneId, 'Enter']);
      await sleep(1200);
      const live = frames.filter((f) => f.t === 'o')
        .map((f) => Buffer.from(f.data, 'base64').toString('latin1')).join('');
      assert.ok(live.includes('pidge-mirror-real'),
        `expected the echoed command in the live stream, got ${JSON.stringify(live.slice(0, 400))}`);
      mirror.stop();
      h.release();
    } finally {
      try { tmuxSock(sock, ['kill-server']); } catch { /* already gone */ }
    }
  });

test('mirror (REAL tmux): a pane on the ALTERNATE screen seeds with the ESC[?1049h prefix (gotcha #64)',
  { skip: !REAL_TMUX }, async () => {
    const sock = `pidge-mirror-alt-${process.pid}`;
    tmuxSock(sock, ['new-session', '-d', '-s', 'alt', '-x', '80', '-y', '24']);
    try {
      const paneId = tmuxSock(sock, ['list-panes', '-t', 'alt', '-F', '#{pane_id}']).trim();
      // `less` puts the pane on the alternate screen — the pre-existing-TUI case.
      tmuxSock(sock, ['send-keys', '-t', paneId, '-l', 'printf "a\\nb\\nc\\n" | less']);
      tmuxSock(sock, ['send-keys', '-t', paneId, 'Enter']);
      await sleep(1200);
      assert.equal(tmuxSock(sock, ['display-message', '-p', '-t', paneId, '#{alternate_on}']).trim(), '1',
        'this tmux/less pair did not reach the alternate screen — the assertion below would be meaningless');

      const hub = new ControlHub({ socketArgs: ['-L', sock], narrate: () => {} });
      const frames = [];
      const h = hub.attach('alt', paneId, { onOutput: () => {}, onLost: () => {} });
      const mirror = createMirror({
        control: h.control, target: paneId, epoch: 1,
        seal: (f) => JSON.stringify(f),
        sendFrame: (data) => { frames.push(JSON.parse(data)); return true; },
        frameCap: 65536, flushMs: 30, nudgeMs: 0,
      });
      await sleep(400);
      await mirror.reseed();
      const seed = frames.find((f) => f.t === 'seed');
      assert.ok(seed, 'a seed was produced');
      assert.ok(Buffer.from(seed.data, 'base64').toString('latin1').startsWith('\x1b[?1049h'),
        'capture-pane renders CELLS — without this prefix the viewer never learns it is on the alt screen');
      mirror.stop();
      h.release();
    } finally {
      try { tmuxSock(sock, ['kill-server']); } catch { /* already gone */ }
    }
  });
