'use strict';
// The pidge terminal daemon (agent-sessions-spec §1/§2/§8/§9/§11).
//
// One per computer (launchd on macOS, `systemd --user` on Linux/WSL), owns:
// the loopback hook endpoint (SessionStart/PreToolUse/Notification/Stop
// announce to it — LOCAL ONLY, publishing is gated per-session by the
// explicit enable, which is itself a PreToolUse SENTINEL the human pastes into
// the session they choose — see enableFromSentinel), the JSONL tailers for ENABLED
// sessions, the sealed publisher, status heartbeats, the waiting→notification
// edge, and the cable input lane (sealed frames → tmux send-keys into the
// BOUND pane). Consent boundary = capability boundary: nothing about a
// session leaves this computer before `pidge terminal enable`, and everything
// enabled is fully interactive.
//
// Inherited scars (see the spec §15): #65 — items degrade INSIDE the cap
// before sending, never bounce-loop on the server's 422; #66 — every async
// callback that touches a session record proves it still owns the slot;
// Tranche-B B2/B3/B4 — pane binding, single-writer lock, vgen/he replay
// ledger; B7 — watchdog prefers a spurious reconnect over a silent stand-down.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const core = require('./core');
const adapter = require('./adapter-claude');

const HOOK_TTL_MS = 24 * 3600 * 1000;   // announce map entries age out (spec §2)
const TAIL_POLL_MS = 400;
const FLUSH_MS = 500;
// One clock for both beats: the per-session heartbeat AND the computer presence
// beat §17 pins at 30 s (the server's effective-online window is 90 s and its
// write throttle 15 s — three beats of headroom). core.COMPUTER_HEARTBEAT_MS is
// the same number stated where the wire contract lives; a test asserts they
// never drift apart.
const HEARTBEAT_MS = core.COMPUTER_HEARTBEAT_MS;
const WATCHDOG_MS = 15_000;
// Cable liveness (B7, REVISED per QA r6-3 — a real 4 h outage): ActionCable
// pings every ~3 s, so 45 s of silence is a dead socket that doesn't know it.
const CABLE_SILENT_MS = 45_000;
// A connect attempt gets this long to reach CONFIRMED (socket open AND at
// least one subscribe confirmation). The r6-3 root cause was a handshake that
// never completed and never errored: readyState sat at CONNECTING forever, and
// the old watchdog treated CONNECTING as health — every tick a no-op, for 4 h.
// A deadline on the ATTEMPT (not on socket callbacks, which may never fire) is
// what makes the retry loop unkillable.
const CABLE_CONFIRM_MS = 20_000;
const CABLE_BACKOFF_CAP_S = 60;
const BACKFILL_ITEMS = 100;             // spec §6
const BACKFILL_SEALED_BYTES = 512 * 1024;
// How many recently-published uuids ride in state.json per session. The uuid
// set is what stops a rescan/rotation from re-publishing a whole transcript,
// and an in-memory-only set is empty after a restart — see seedSeenFromFile.
const SEEN_RING = 500;
// The DURABLE OUTBOX (see persistSession): sealed items awaiting their 201,
// persisted with the offset that produced them. Bounded, because state.json is
// not a queue server — at the cap the TAILER STOPS ADVANCING (tailOne), so the
// un-enqueued tail stays exactly where it is durable: in the transcript file.
const OUTBOX_MAX_ITEMS = 2000;
const OUTBOX_MAX_BYTES = 4 * 1024 * 1024;
// Read windows. A transcript can be multi-GB; nothing here may slurp one.
const LIVE_READ_MAX_BYTES = 4 * 1024 * 1024;   // per live tick (the next tick continues)
const TAIL_WINDOW_BYTES = 8 * 1024 * 1024;     // enable backfill + restart dedup reseed
const RESCAN_MAX_BYTES = 64 * 1024 * 1024;     // a whole-file bulk re-read, hard-clamped
const INPUT_KEYS = new Set(['Enter', 'Escape', 'Up', 'Down', 'Tab', 'BTab', 'C-c']);
// A register the server refused for a reason RETRYING cannot fix (the session
// is gone, the key was rotated, the tunnel is not ours). Everything else — a
// network error, a 5xx, a 402 while a subscription lapses — is transient and
// must NOT cost the human the share they opted into.
const DEFINITIVE_REGISTER_STATUSES = new Set([401, 403, 404, 410]);

// --- v2 (Terminals Phase A) --------------------------------------------------
// state.json schema version, stamped as `schema`. v1 (no stamp) keyed a share
// by the harness session id and derived its public_id from it; v2 makes the
// SHARE the identity (spec §16). The migration is in-place, ONE-WAY and
// GRANDFATHERS every existing public_id byte-verbatim — it is the AAD anchor of
// every item already sealed.
//
// DOWNGRADE (measured, not assumed — see the test "a 0.42.x CLI re-opening a
// schema:2 state file"): a v1 daemon reading this file does NOT refuse. It
// ignores the keys it does not know (`schema`, `share_id`, `current_sid`,
// `occupant`, `cmdIds`) and re-arms each entry from `publicId` exactly as
// before. That is WHY every v1 key stays spelled the way v1 spells it and why
// `publicId` is still written next to `share_id`: the old code path is a real
// consumer of this file, and it must find what it reads.
const STATE_VERSION = 2;
// The computer's own cable subscription — NO params: the tunnel key IS the
// identity (server: ComputerChannel#resolve_computer rejects anything else).
const COMPUTER_IDENT = JSON.stringify({ channel: 'ComputerChannel' });
// `viewer_joined` is an unsealed nudge the server emits per viewer subscribe;
// several phones (or one phone re-subscribing) must not become a caps storm.
const VIEWER_JOINED_DEBOUNCE_MS = 2_000;
// The durable command lane (§17) rides the message queue. The ComputerChannel
// carries NO "a command is waiting" frame in Phase A (verified against the
// server file), so this interval IS the mechanism, not a fallback — see
// drainTick. Deliberately a plain interval and never a held `?wait=` poll: a
// queue that holds rows this daemon must NOT consume would make a long-poll
// return instantly, forever (a hot loop).
const DRAIN_POLL_MS = 15_000;
// …and the floor between cable-triggered drains (today: a viewer joining). The
// nudge that triggers one is UNSEALED and forgeable-innocuous by contract, so
// the worst a hostile relay may buy with it is one GET /messages per floor.
const DRAIN_KICK_FLOOR_MS = 2_000;
// Commands whose outcome is durable on this computer (a spawned pane) must not
// be re-run when an ack is lost (#39 is at-least-once) — the handled ids ride
// state.json, bounded.
const CMD_SEEN_RING = 200;
// Occupant polling (§16) rides the existing 400 ms tail tick but is throttled:
// one `tmux list-panes` per second answers for EVERY bound pane, and 2.5 execs
// a second forever is a battery cost with no product gain.
const OCCUPANT_POLL_MS = 1_000;
// What `#{pane_current_command}` looks like when the harness is in the pane.
// Deliberately BROAD: the set is only ever used to flip agent→term (a share
// becomes `agent` from the SessionStart hook, never from this list), so a false
// "still the harness" merely holds the current view one poll longer, while a
// false "gone" would swap the renderer under a live claude.
const HARNESS_COMMANDS = new Set(['claude', 'node', 'node.exe', 'bun', 'deno', 'npm', 'npx']);
// The tmux session the daemon spawns panes into when the phone asks (§17).
const SPAWN_TMUX_SESSION = 'pidge';

function nowIso() { return new Date().toISOString(); }

// Is the harness sitting in this pane? (see HARNESS_COMMANDS)
function isHarnessCommand(cmd) {
  return HARNESS_COMMANDS.has(String(cmd || '').trim().toLowerCase());
}

class Daemon {
  constructor() {
    this.env = core.loadTerminalEnv();
    if (!this.env.token || !this.env.base || !this.env.secret || !this.env.channelId) {
      throw new Error('pidge terminal daemon: not connected — run `pidge terminal connect` first');
    }
    this.key = core.e2eParseSecret(this.env.secret);
    this.caps = core.loadCaps();
    this.state = core.readJson(core.STATE_FILE(), { schema: STATE_VERSION, epoch: 0, sessions: {} });
    // Durable commands already executed (at-least-once ⇒ exactly-once
    // effects). Read BEFORE the first saveState — it re-writes the ring.
    this.handledCmdIds = new Set((this.state.cmdIds || []).map(Number).filter(Number.isFinite));
    // v1 → v2, IN PLACE (spec §16). Everything below is additive: `publicId`
    // is copied to `share_id` BYTE-VERBATIM (it is the AAD anchor of every item
    // this computer already sealed — it can never change, not once, not ever)
    // and the harness session id the share was named after becomes
    // `current_sid`, an attribute of the CURRENT OCCUPANT. No server call, no
    // transcript re-publish, seq continues.
    const migrated = this.migrateState();
    // Tunnel scoping (QA finding #13): state.json used to persist sessions
    // with no channel stamp, so reconnecting this computer to a DIFFERENT
    // tunnel re-published the old tunnel's sessions there — re-sealing their
    // title+cwd metadata under the NEW key (a cross-owner metadata leak; the
    // item crypto held, the sessions rendered empty). Every persisted session
    // now carries the channelId that owns it (persistSession); on load,
    // anything that does not belong to the CURRENT tunnel is dropped before it
    // can register, publish, or re-seal a byte. A missing stamp (a pre-fix
    // state file) is foreign too: ownership it cannot prove, it does not get.
    const foreign = [];
    for (const [sid, p] of Object.entries(this.state.sessions || {})) {
      if (!p || p.channelId !== this.env.channelId) {
        foreign.push({ sid, channelId: (p && p.channelId) || null });
        delete this.state.sessions[sid];
      }
    }
    this.state.epoch = (this.state.epoch || 0) + 1; // new epoch per process (B4)
    this.saveState();
    if (migrated.length) {
      this.log(`state.json migrated to schema ${STATE_VERSION}: ${migrated.length} share(s) kept their public_id VERBATIM (${migrated.map((m) => m.publicId).join(', ')}) — the id is the AAD anchor of everything already sealed; the harness session id moved to current_sid`);
    }
    for (const f of foreign) {
      this.log(`session ${String(f.sid).slice(0, 8)} belongs to ${f.channelId ? `channel ${f.channelId}` : 'an UNKNOWN channel (pre-scoping state)'}, not the connected channel ${this.env.channelId} — DROPPED from state (a connect that switches tunnels inherits no sessions; metadata never re-seals under another owner's key)`);
    }
    this.announces = new Map();  // sid → {tty, cwd, transcriptPath, at}
    this.sessions = new Map();   // sid → live session record (see enable)
    this.ws = null;              // one cable socket, N subscriptions
    this.wsGen = 0;              // identity guard for reconnects (#66)
    this.wsLastBeat = 0;
    // Cable verification state (QA r6-3): `wsConfirmed` flips true only when
    // the server CONFIRMS a subscription on the current socket — an open
    // socket that never confirmed is not an input lane. `cableDownSince` is
    // the start of the current no-input-lane period (null = confirmed up);
    // the backoff pair paces the forever-retry the watchdog drives.
    this.wsConfirmed = false;
    this.wsAttemptAt = 0;        // when the current connect attempt started
    this.wsBackoff = 0;          // seconds, exponential, capped, reset on confirm
    this.wsRetryAt = 0;          // earliest next connect attempt
    this.cableDownSince = null;
    this.replay = new Map();     // `${publicId}|${vgen}` → last seq (never pruned:
                                 // a viewer generation must stay monotonic for the
                                 // life of the process, including across a
                                 // disable/re-enable of the same sid)
    // RESERVED, deliberately empty in v1: there is no wire signal that retires a
    // viewer generation (the spec's grow-only retired set needs one). Replay
    // defense in v1 rests on the mandatory `he` epoch echo — which kills every
    // pre-restart ciphertext — plus the per-vgen monotonic seq ledger above.
    // Populating this on disable was considered and REJECTED: the app can reuse
    // a vgen across a re-enable, and dropping a live viewer's input silently is
    // worse than the replay window the epoch echo already closes.
    this.retiredVgens = new Set();
    // --- the computer lane (v2 §17) ---
    // The ComputerChannel subscription is held while the machine is CONNECTED,
    // with zero shared panes — it is what makes the phone's online chip, the
    // pane inventory and the capabilities frame possible at all.
    this.computerConfirmed = false;   // the server CONFIRMED the computer subscription
    this.computerRejected = false;    // …or rejected it (said once, loudly)
    this.lastViewerJoinAt = 0;        // caps debounce
    this.capsTimer = null;
    this.viewerDebounceMs = VIEWER_JOINED_DEBOUNCE_MS; // shortened by the tests only
    this.lastOccupantAt = 0;          // occupant poll throttle
    this.draining = false;            // one durable-command drain at a time
    this.drainWarnedAt = 0;
    this.lastKickAt = 0;              // floor between cable-triggered drains
    this.foreignMsgIds = new Set();   // queue rows that are NOT ours: logged once, never acked
    this.logStream = null;
    this.exit = (code) => process.exit(code); // injectable for tests (POST /shutdown)
  }

  // v1 → v2 state migration (spec §16), ONE-WAY and in place: the constructor's
  // saveState() below writes it back through the same writeFileAtomic every
  // other state write uses. Returns the migrated entries so the constructor can
  // narrate them; a file already stamped `schema: 2` is untouched.
  //
  // The two new per-entry keys are spelled the way the WIRE spells things
  // (`share_id`, `current_sid`) while every v1 key keeps its v1 spelling
  // forever — a downgraded 0.42.x daemon still reads `publicId`/`paneId`/… out
  // of this exact file (see STATE_VERSION).
  migrateState() {
    if (Number(this.state.schema || 1) >= STATE_VERSION) { this.state.schema = STATE_VERSION; return []; }
    const migrated = [];
    for (const [sid, p] of Object.entries(this.state.sessions || {})) {
      if (!p || typeof p !== 'object' || !p.publicId) continue;
      // GRANDFATHERED FOREVER — never re-derive, never re-mint.
      if (!p.share_id) p.share_id = p.publicId;
      if (p.current_sid === undefined) p.current_sid = sid;
      // Every v1 share was a harness session by construction.
      if (!p.occupant) p.occupant = 'agent';
      migrated.push({ sid, publicId: p.publicId });
    }
    this.state.schema = STATE_VERSION;
    return migrated;
  }

  log(...args) {
    const line = `[${nowIso()}] ${args.join(' ')}`;
    console.log(line);
    try {
      this.logStream ||= fs.createWriteStream(core.LOG_FILE(), { flags: 'a' });
      this.logStream.write(line + '\n');
    } catch {}
  }

  saveState() {
    const sessions = {};
    for (const [sid, s] of Object.entries(this.state.sessions || {})) sessions[sid] = s;
    core.writeJson(core.STATE_FILE(), {
      schema: STATE_VERSION, epoch: this.state.epoch, sessions,
      // The durable-command dedup ring: a spawn whose ack was lost must not
      // open a second window after a restart.
      cmdIds: [...this.handledCmdIds].slice(-CMD_SEEN_RING),
    });
  }

  noteHandledCmd(id) {
    this.handledCmdIds.add(Number(id));
    if (this.handledCmdIds.size > CMD_SEEN_RING) {
      const keep = [...this.handledCmdIds].slice(-CMD_SEEN_RING);
      this.handledCmdIds = new Set(keep);
    }
    this.saveState();
  }

  // --- server calls ---------------------------------------------------------

  async api(method, p, body, timeoutMs = 20000) {
    const res = await core.fetchT(`${this.env.base}/api/v1${p}`, {
      method,
      headers: { authorization: `Bearer ${this.env.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, timeoutMs);
    let data = null;
    try { data = await res.json(); } catch {}
    return { res, data };
  }

  sealItem(item) {
    // #65 discipline: degrade INSIDE the cap BEFORE sending. Sealing envelope
    // adds 29 bytes; base64 of the JSON is what the server measures decoded.
    const cap = this.caps.item_sealed_max_bytes;
    let preview = item.preview;
    for (const budget of [adapter.PREVIEW_BYTES, 1024, 256, 0]) {
      const candidate = { ...item, preview: adapter.byteSlice(preview, budget), truncated: item.truncated || adapter.byteLen(preview) > budget };
      const sealed = core.e2eEncryptBlob(this.key,
        core.e2eAad(this.env.channelId, candidate._publicId, 'agent_transcript'),
        Buffer.from(JSON.stringify(stripPrivate(candidate)), 'utf8'));
      if (sealed.length <= cap) {
        if (budget < adapter.PREVIEW_BYTES && adapter.byteLen(preview) > budget) {
          this.log(`item ${item.uuid}: preview degraded to ${budget}B to fit the ${cap}B sealed cap`);
        }
        return sealed.toString('base64url');
      }
    }
    // Even an empty preview doesn't fit — structurally impossible for §7
    // items, but the rule is: NEVER send over-cap, never loop (skip loudly).
    this.log(`item ${item.uuid}: cannot fit sealed cap even with empty preview — SKIPPED (loud)`);
    return null;
  }

  sealMeta(session) {
    const meta = {
      title: session.title,
      cwd: session.cwd,
      // The harness session id is an attribute of the CURRENT OCCUPANT (spec
      // §16) — it rides inside the sealed blob and is refreshed on every
      // adoption (/clear, a claude starting in a shared terminal pane). NULL on
      // a pane share whose occupant is a plain shell. `currentSid === undefined`
      // is a v1-shaped record: fall back to the map key, which IS its sid.
      sid: session.currentSid !== undefined ? session.currentSid : session.sid,
      harness: session.harness || 'claude',
      harness_version: session.hv || null,
      tmux: { pane_id: session.paneId },
      epoch: this.state.epoch,
      // The harness's permission mode as last seen by the hooks (Claude:
      // default | plan | acceptEdits | bypassPermissions). OMITTED when
      // unknown — viewers must tolerate absence (spec §4, added 2026-08-03).
      ...(session.mode ? { mode: session.mode } : {}),
    };
    return core.e2eEncryptBlob(this.key,
      core.e2eAad(this.env.channelId, session.publicId, 'agent_meta'),
      Buffer.from(JSON.stringify(meta), 'utf8')).toString('base64url');
  }

  async registerSession(session, status) {
    const { res, data } = await this.api('POST', '/agent_sessions', {
      public_id: session.publicId, status, meta_sealed: this.sealMeta(session),
      // The occupant (spec §16). ABSENT means unchanged server-side, so a v1
      // record with no occupant simply doesn't send it.
      ...(session.occupant ? { mode: session.occupant } : {}),
    });
    if (res.status !== 201) {
      // The status rides the error: the caller must tell "the session is gone"
      // (drop it) from "the server is having a bad minute" (keep and retry).
      const err = new Error(`register ${session.publicId} → ${res.status} ${JSON.stringify(data)}`);
      err.status = res.status;
      throw err;
    }
    return (data && data.session) || {}; // {last_seq, …} — the continue-point
  }

  // --- narration (spec §11: an outcome is NEVER silent) ---------------------

  noticeItem(s, preview, tag) {
    return {
      v: 1, uuid: `pidge-${tag}-${Date.now()}`, parent: null,
      ts: nowIso(), role: 'system', kind: 'notice', preview,
      truncated: false, total_bytes: adapter.byteLen(preview),
      harness: s.harness || 'claude', hv: s.hv || null, _publicId: s.publicId,
    };
  }

  // Seal + enqueue a seam notice onto a share's transcript. Best-effort by
  // design (a notice that will not seal must not abort the transition it
  // narrates), but never silent: a failure logs.
  queueNotice(s, preview, tag) {
    try {
      const item = this.noticeItem(s, preview, tag);
      const b64 = this.sealItem(item);
      if (b64 === null) return false;
      this.queuePush(s, item.uuid, b64);
      return true;
    } catch (e) {
      this.log(`${s.publicId}: could not seal the "${preview}" notice (${e.message}) — the transition itself is unaffected`);
      return false;
    }
  }

  // Narrate + publish a seam notice right now (the command paths: a spawn, a
  // capture, an occupant flip).
  narrateShare(s, preview, tag) {
    if (this.queueNotice(s, preview, tag)) {
      this.persistSession(s);
      this.flush(s).catch((e) => this.log('flush error:', e.message));
    }
  }

  // --- hooks endpoint (loopback) -------------------------------------------

  startHookServer(port, token) {
    this.hookToken = token;
    this.httpServer = http.createServer((req, res) => this.handleHttp(req, res).catch((e) => {
      this.log('http error:', e.message);
      try { res.writeHead(500); res.end('{}'); } catch {}
    }));
    this.httpServer.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        this.log(`port ${port} already held — another daemon is running; exiting cleanly`);
        process.exit(0); // clean exit: launchd's SuccessfulExit=false won't respawn-loop
      }
      this.log(`hook server error: ${e.message}`);
      process.exit(1);
    });
    this.httpServer.listen(port, '127.0.0.1', () => this.log(`daemon listening on 127.0.0.1:${port}`));
  }

  readBody(req) {
    return new Promise((resolve) => {
      let buf = '';
      req.on('data', (c) => { buf += c; if (buf.length > 1e6) req.destroy(); });
      req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); } });
    });
  }

  async handleHttp(req, res) {
    if ((req.headers.authorization || '') !== `Bearer ${this.hookToken}`) {
      res.writeHead(401); return res.end('{}');
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = req.method === 'POST' ? await this.readBody(req) : {};
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

    switch (`${req.method} ${url.pathname}`) {
      case 'GET /health':
        // `cable` is what lets `terminal status` refuse to present a daemon
        // with a dead input lane as healthy (QA r6-3.2): the publish path is
        // plain HTTPS POSTs, so the mirror reads fine precisely while the
        // human's words evaporate — the cable state must be said out loud.
        return send(200, { ok: true, epoch: this.state.epoch, enabled: [...this.sessions.keys()], cable: this.cableState() });
      case 'POST /hook/session-start': {
        const { session_id: sid, cwd, transcript_path: tp, tty, source } = body;
        if (!sid) return send(200, {});
        this.announces.set(sid, { tty: tty || null, cwd: cwd || null, transcriptPath: tp || null, at: Date.now() });
        const s = this.sessions.get(sid);
        if (s) this.notePermissionMode(s, body.permission_mode); // every hook carries the mode (r6-5)
        if (s && tp && tp !== s.file) {
          // Same-sid rotation (an in-place transcript swap): SAME AgentSession.
          this.log(`session ${sid.slice(0, 8)}: transcript rotated → ${path.basename(tp)}`);
          s.file = tp; s.offset = 0; s.bulk = true; // uuid dedup absorbs the re-read; bulk caps it (§6)
          this.persistSession(s);
        }
        if (!s) {
          // `/clear` = a NEW session, not a rotation (spec §6, corrected per QA
          // finding #14): Claude Code mints a new sid AND a new transcript, the
          // old JSONL never grows again, and the phone froze on a mirror that
          // LOOKED alive. Adoption is gated on the HARNESS'S OWN rotation
          // signal (§6 REVISED after adversarial review): SessionStart carries
          // `source` ("startup"|"resume"|"clear"|"compact"), and only
          // source:"clear" — the authoritative statement that a human typed
          // /clear INSIDE a session they already shared — carries consent
          // over. The earlier "mirror hot within 90 s" window is GONE: it
          // failed both ways (a nested `claude -p` run as a Bash tool inside
          // the mirrored session satisfies cwd+hot and would HIJACK the
          // mirror; a human who reads the last answer for >90 s before /clear
          // would fail it). Adoption also requires a transcript_path —
          // adopting without a new file recreates the frozen-mirror bug.
          // Every other case ends the displaced session loudly (§11).
          // v2 §16, the TERMINAL→AGENT flip: a claude that starts in a pane
          // this computer already shares as a plain terminal (the phone
          // spawned it, or the human ran `pidge terminal share` there) joins
          // THAT share — consent rides the pane, the row keeps its public_id,
          // the renderer swaps on the `mode` flip. This is checked BEFORE the
          // /clear machinery: a term share has no sid to be a "twin" of.
          const termShare = this.findTermShareForAnnounce({ tty: core.normalizeTty(tty), cwd });
          if (termShare) {
            if (tp) {
              this.adoptSid(termShare, sid, {
                tp, tty: core.normalizeTty(tty),
                notice: 'claude started — agent view', tag: `agent-${sid.slice(0, 8)}`,
                occupant: 'agent', why: 'a harness started in a shared terminal pane',
              });
            } else {
              // No transcript ⇒ no adoption (the frozen-mirror rule, §6). The
              // terminal share stays exactly what it is — never ended, never
              // silently flipped to an agent view with nothing behind it.
              this.log(`${termShare.publicId}: a harness announced in its pane ${termShare.paneId} with NO transcript_path — the pane stays a terminal share (adopting without a file recreates the frozen-mirror bug)`);
            }
            return send(200, {});
          }
          const twin = this.findReplacedTwin(sid, { tty: core.normalizeTty(tty), cwd });
          if (twin) {
            const src = typeof source === 'string' && source ? source : null;
            if (src === 'clear' && tp && this.adoptSid(twin, sid, {
              tp, tty: core.normalizeTty(tty),
              notice: 'restarted via /clear — mirror continued', tag: `clear-${sid.slice(0, 8)}`,
              occupant: 'agent', why: 'source:"clear"',
            })) {
              // adopted — everything narrated inside adoptReplacedSid.
            } else {
              this.log(`session ${twin.sid.slice(0, 8)}: new sid ${sid.slice(0, 8)} announced in its pane/cwd (source: ${src || 'absent'}${src === 'clear' && !tp ? ', NO transcript_path' : ''}) — no adoption; ending the old session, the new claude needs its own enable`);
              // Fire-and-forget: the SessionStart hook has a 3 s budget, and
              // the end path talks to the server. Failures logged, never eaten.
              this.endReplacedSession(twin, sid).catch((e) => this.log(`end-replaced ${twin.sid.slice(0, 8)} failed: ${e.message}`));
            }
          }
        }
        return send(200, {});
      }
      case 'POST /hook/pre-tool-use': {
        const sid = body.session_id;
        // THE ENABLE DOOR (spec §2, hook correlation). The human pasted the
        // instruction into THIS session; claude is about to run one bash
        // carrying the sentinel. We enable the session id the hook hands us —
        // authoritative, no process introspection — and DENY the tool, so the
        // command never runs (its success was always cosmetic) and the outcome
        // reaches claude as the denial reason.
        const sentinel = core.parseEnableSentinel(body.tool_name, body.tool_input && body.tool_input.command);
        if (sid && sentinel) {
          return send(200, { decision: await this.enableFromSentinel(sid, body, sentinel) });
        }
        const s = sid && this.sessions.get(sid);
        if (s) {
          s.lastAliveAt = Date.now();
          this.setStatus(s, 'running');
          this.notePermissionMode(s, body.permission_mode);
        }
        if (s && s.approvals && s.approvals.length && this.toolGated(s, body.tool_name)) {
          const decision = await this.approvalGate(s, body);
          return send(200, decision ? { decision } : {});
        }
        return send(200, {});
      }
      case 'POST /hook/notification': {
        const sid = body.session_id;
        const s = sid && this.sessions.get(sid);
        if (s) {
          s.lastAliveAt = Date.now();
          this.setStatus(s, 'waiting');
          this.notePermissionMode(s, body.permission_mode); // every hook carries the mode (r6-5)
          // Composer-spec Tranche A, MINIMAL cherry-pick: the Notification
          // hook fires for eight distinct reasons and carries
          // `notification_type` (permission_prompt | idle_prompt |
          // auth_success | elicitation_dialog | elicitation_complete |
          // elicitation_response | agent_needs_input | agent_completed —
          // read defensively). `idle_prompt` is the ~60 s "it's your turn"
          // nudge after EVERY turn — the 4-in-8-minutes spam QA #16 measured.
          // It is noise, not a request: it never pushes, even when
          // notify_on_waiting is ON, and it does not consume the armed
          // episode a real request would use. Everything else — including an
          // absent or unknown type — keeps today's behavior; the
          // fine-grained STATUS semantics are v1.1, untouched here.
          if (String(body.notification_type || '') !== 'idle_prompt') {
            this.maybeNotifyWaiting(s, String(body.message || 'Waiting for your input')).catch((e) => this.log('notify failed:', e.message));
          }
        }
        return send(200, {});
      }
      case 'POST /hook/stop': {
        const sid = body.session_id;
        const s = sid && this.sessions.get(sid);
        if (s) {
          s.lastAliveAt = Date.now();
          this.setStatus(s, 'idle');
          this.notePermissionMode(s, body.permission_mode); // every hook carries the mode (r6-5)
        }
        return send(200, {});
      }
      case 'GET /sessions': {
        const now = Date.now();
        const ann = [...this.announces.entries()]
          .filter(([, a]) => now - a.at < HOOK_TTL_MS)
          .map(([sid, a]) => ({ sid, tty: a.tty, cwd: a.cwd, transcript_path: a.transcriptPath, at: a.at }));
        const enabled = [...this.sessions.values()].map((s) => ({
          sid: s.sid, public_id: s.publicId, pane_id: s.paneId, cwd: s.cwd, status: s.status,
          // v2: what OCCUPIES the pane, and the harness sid when there is one.
          mode: s.occupant || 'agent', current_sid: s.currentSid !== undefined ? s.currentSid : s.sid,
        }));
        return send(200, { announces: ann, enabled, grants: core.loadGrants() });
      }
      // v2 §17: `pidge terminal share`, typed by a human INSIDE a pane. The CLI
      // did the tty→pane match (it has a real tty; the Claude-hook ttyless
      // problem is not this path's) — the daemon still VERIFIES the pane and
      // owns the binding.
      case 'POST /share': {
        const out = await this.shareLocalPane(body.pane_id, { by: 'pidge terminal share' });
        return send(out.ok ? 200 : 409, out);
      }
      // The grants changed on this machine (`pidge terminal config`) — the
      // phone learns within one frame instead of waiting for the next viewer.
      case 'POST /caps': {
        const grants = core.loadGrants();
        const published = this.publishCaps('the grants changed on this computer');
        return send(200, { grants, published });
      }
      case 'POST /shutdown': {
        // `connect --replace` recycles the daemon (review A2): a live process
        // keeps the OLD tunnel identity (base/key) in memory — under systemd
        // `enable --now` is a no-op while the unit is active, and a detached
        // replacement dies on EADDRINUSE while the old process keeps
        // publishing to the orphaned channel. Clean exit: neither launchd
        // (SuccessfulExit=false) nor systemd (Restart=on-failure) respawns a
        // 0-exit; connect starts the fresh daemon right after.
        this.log('shutdown requested over loopback (connect --replace recycles the daemon)');
        send(200, { ok: true });
        setTimeout(() => this.exit(0), 50); // let the response flush first
        return;
      }
      // There is NO POST /enable any more: the PreToolUse sentinel above is the
      // only door, so no local caller can mint a share for a session it merely
      // named (the "which session did you mean?" guess this feature refuses).
      case 'POST /disable': {
        const targets = body.all ? [...this.sessions.keys()] : [body.sid].filter(Boolean);
        // The results carry whether the server was actually told — the CLI
        // reports that honestly instead of a blanket "✓ stopped sharing".
        const results = [];
        for (const sid of targets) results.push(await this.disableSession(sid, 'requested'));
        return send(200, { disabled: targets, results });
      }
      default:
        return send(404, {});
    }
  }

  // --- enable / disable -----------------------------------------------------

  // The ONE enable door: a PreToolUse hook whose Bash command carries the
  // sentinel. The session id comes from the harness itself, so nothing is
  // guessed and nothing is introspected — the failure class that kept this door
  // shut (a shell wrapper matched as "claude", with no controlling tty) simply
  // has no surface here.
  //
  // ALWAYS returns a permissionDecision: the sentinel command is a carrier, not
  // a command we want executed. Denying it is what makes the door independent
  // of PATH — `pidge` need not exist on this machine at all.
  async enableFromSentinel(sid, body, sentinel) {
    const deny = (reason) => ({ permissionDecision: 'deny', permissionDecisionReason: reason });

    // The SessionStart announce is the preferred binding source (it is the
    // claude process's own tty/cwd/transcript); the PreToolUse payload is the
    // fallback, so a session that started before the daemon can still be
    // shared. Whatever we learn here also refreshes the announce map.
    // …but only a FRESH announce (the map ages out at 24 h, spec §2): a stale
    // entry's transcript path can be a file this session no longer writes.
    const known = this.announces.get(sid);
    const ann = known && Date.now() - known.at < HOOK_TTL_MS ? known : null;
    const tty = (ann && ann.tty) || core.normalizeTty(body.tty) || null;
    const cwd = (ann && ann.cwd) || body.cwd || null;
    const file = (ann && ann.transcriptPath) || body.transcript_path || null;
    this.announces.set(sid, { tty, cwd, transcriptPath: file, at: Date.now() });

    const live = this.sessions.get(sid);
    if (live) {
      this.log(`enable ${sid.slice(0, 8)}: already shared as ${live.publicId} — the sentinel is idempotent`);
      return deny(core.ENABLE_OK_REASON);
    }
    if (!file) {
      this.log(`enable ${sid.slice(0, 8)} REFUSED: no transcript path announced and none in the hook payload`);
      return deny(core.ENABLE_NO_TRANSCRIPT_REASON);
    }

    const { pane, refusal } = this.resolvePane({ sid, tty, cwd });
    if (!pane) return deny(refusal);

    // The pane may ALREADY be a share (v2 §16): the human typed `pidge terminal
    // share` in it, or the phone spawned/captured it. Consent rides the PANE,
    // so the harness ADOPTS the existing share row instead of minting a second
    // one for the same pane — same public_id, seq continues, seam notice.
    const onPane = this.shareForPaneId(pane.paneId);
    if (onPane) {
      if (this.adoptSid(onPane, sid, {
        tp: file, tty,
        notice: 'claude started — agent view', tag: `agent-${sid.slice(0, 8)}`,
        occupant: 'agent',
        why: `the sentinel enabled sid ${sid.slice(0, 8)} in an already-shared pane`,
      })) return deny(core.ENABLE_OK_REASON);
      this.log(`enable ${sid.slice(0, 8)}: pane ${pane.paneId} is shared as ${onPane.publicId} but the adoption could not take the writer lock — refusing rather than minting a second share for one pane`);
      return deny(`Couldn't mirror this session: this computer already shares that pane and could not hand it over. Do not run other commands.`);
    }

    try {
      const s = await this.enableSession({
        sid, paneId: pane.paneId, tty, cwd, file,
        // The enable ride IS a PreToolUse payload — its permission_mode (read
        // defensively; older harnesses omit it) seeds the very first meta.
        mode: typeof body.permission_mode === 'string' && body.permission_mode ? body.permission_mode : null,
        approvals: (sentinel && sentinel.approvals) || [],
      });
      this.log(`enable ${sid.slice(0, 8)} via the PreToolUse sentinel → ${s.publicId} (pane ${pane.paneId}${pane.loc ? ` ${pane.loc}` : ''}, bound by ${pane.by})`);
      return deny(core.ENABLE_OK_REASON);
    } catch (e) {
      // enableSession already tore its half-built record down; say what broke
      // instead of claiming a share that does not exist (§11: never quiet).
      this.log(`enable ${sid.slice(0, 8)} FAILED: ${e.message}`);
      return deny(`Couldn't mirror this session: ${e.message}. Do not run other commands.`);
    }
  }

  // Did this NEW sid land on the pane+cwd of a currently-shared session? The
  // match must be POSITIVE on both (spec §6: pane_id AND cwd): cwd equality
  // finds the candidate, and the pane check must AFFIRM the same pane — via
  // the announced tty when there is one, or, in the ttyless reality of Claude
  // Code hooks (finding #12), via "exactly one pane sits in that cwd and it IS
  // the bound one". Ambiguity (2+ panes in the cwd), a provably different
  // pane, or an unreadable pane list all yield NO match — logged loudly, but
  // neither adoption nor a kill of a possibly-live mirror.
  findReplacedTwin(newSid, { tty, cwd }) {
    const want = String(cwd || '').replace(/\/+$/, '');
    if (!want) return null;
    // ALL candidates in that cwd (there can be several — tty-bound enables can
    // legitimately share a cwd across panes); the pane check then affirms the
    // ONE whose bound pane matches, never just the first cwd hit. TERMINAL
    // shares are excluded: they carry no harness session to be displaced, and
    // findTermShareForAnnounce (called first) owns that transition.
    const candidates = [...this.sessions.values()]
      .filter((s) => s.occupant !== 'term' && String(s.cwd || '').replace(/\/+$/, '') === want);
    if (!candidates.length) return null;
    const tag = `new sid ${newSid.slice(0, 8)}`;
    const opts = { onWarn: (m) => this.log(m) };
    try {
      if (tty) {
        const hit = core.tmuxPaneForTty(tty, opts);
        const twin = hit && candidates.find((s) => s.paneId === hit.paneId);
        if (twin) return twin;
        this.log(`${tag} announced in ${want} but its tty ${tty} ${hit ? `is pane ${hit.paneId}, bound to no shared session` : 'is not a tmux pane'} — no pane match, leaving the share(s) alone`);
        return null;
      }
      const hits = core.tmuxPanesForCwd(want, opts);
      const twin = hits.length === 1 ? candidates.find((s) => s.paneId === hits[0].paneId) : null;
      if (twin) return twin;
      this.log(`${tag} announced in ${want}, but ${hits.length === 1 ? `the only pane there is ${hits[0].paneId}, bound to no shared session` : `${hits.length} pane(s) sit there — cannot tell a /clear from a second claude`}; leaving the share(s) alone`);
      return null;
    } catch (e) {
      this.log(`${tag}: pane list unreadable (${e.message}) — cannot affirm the pane match, leaving the share(s) alone`);
      return null;
    }
  }

  // Did this SessionStart land in a pane this computer already shares as a
  // TERMINAL? (v2 §16 — the terminal→agent flip.) Same discriminators as the
  // /clear twin check, same refusals: an ambiguous cwd or an unreadable pane
  // list yields NO match (loudly), never a guess. Consent is not at stake here
  // — the pane is already shared — but binding the WRONG pane would splice a
  // stranger's transcript into it, which is worse.
  findTermShareForAnnounce({ tty, cwd }) {
    const terms = [...this.sessions.values()].filter((s) => s.occupant === 'term' && s.paneId);
    if (!terms.length) return null;
    const opts = { onWarn: (m) => this.log(m) };
    try {
      if (tty) {
        const hit = core.tmuxPaneForTty(tty, opts);
        return (hit && terms.find((s) => s.paneId === hit.paneId)) || null;
      }
      const hits = core.tmuxPanesForCwd(cwd, opts);
      if (hits.length !== 1) {
        if (hits.length > 1) this.log(`a harness announced in ${cwd} where ${hits.length} panes sit — cannot tell which is the shared terminal; no adoption`);
        return null;
      }
      return terms.find((s) => s.paneId === hits[0].paneId) || null;
    } catch (e) {
      this.log(`terminal-share lookup: pane list unreadable (${e.message}) — no adoption, the share is left exactly as it is`);
      return null;
    }
  }

  // ADOPTION — v1's source-gated `/clear` machinery (spec §6, #70), now the
  // GENERAL case (v2 §16): same pane ⇒ same SHARE row ⇒ seq continues. The new
  // sid becomes the share's current occupant — the tailer switches to its
  // transcript, `meta_sealed` refreshes (the sid rides inside the sealed blob),
  // the public_id NEVER changes, and a `notice` item marks the seam. Callers
  // that adopt across a `/clear` have already established source:"clear" + a
  // positive pane+cwd match + a transcript_path; the terminal→agent callers
  // have a positive PANE match. Returns false when the writer lock cannot be
  // taken — the caller then decides (end loudly, or refuse).
  adoptSid(s, newSid, { tp, tty, notice, tag, occupant, why }) {
    const oldSid = s.sid;
    try {
      this.acquireWriterLock(newSid); // B3: the new sid's slot must be ours too
    } catch (e) {
      this.log(`adopt ${newSid.slice(0, 8)} REFUSED: ${e.message}`);
      return false;
    }
    this.sessions.delete(oldSid);
    delete this.state.sessions[oldSid];
    this.releaseWriterLock(oldSid);
    s.sid = newSid;
    s.currentSid = newSid;
    s.tty = tty || null;
    if (occupant) s.occupant = occupant;
    if (occupant === 'agent') s.harness = 'claude';
    if (tp) { s.file = tp; s.offset = 0; s.bulk = true; } // new transcript; §6 cap bounds the read, uuid dedup guards
    s.lastAliveAt = Date.now();
    this.sessions.set(newSid, s);
    // The seam, visible on the phone — never a silent splice (§11).
    this.queueNotice(s, notice, tag);
    this.persistSession(s);
    // Refresh the sealed meta (new sid inside the blob) + the occupant — best-
    // effort; the heartbeat's PATCH keeps flowing regardless.
    this.api('PATCH', `/agent_sessions/${s.publicId}`, {
      status: s.status, meta_sealed: this.sealMeta(s), ...(s.occupant ? { mode: s.occupant } : {}),
    }).catch((e) => this.log(`${s.publicId}: meta refresh after adoption failed (${e.message}) — retried by the next heartbeat era`));
    this.flush(s).catch((e) => this.log('flush error:', e.message));
    this.log(`share ${s.publicId}: ${oldSid.slice(0, 8)} → ${newSid.slice(0, 8)} ADOPTED (${why}, pane ${s.paneId}) — same share row, seq continues, mirror unbroken`);
    return true;
  }

  // The share bound to a tmux pane, if any (one pane = at most one share).
  shareForPaneId(paneId) {
    if (!paneId) return null;
    return [...this.sessions.values()].find((s) => s.paneId === paneId) || null;
  }

  // The share carrying a given public_id (the `kill_share` command's target).
  shareForPublicId(publicId) {
    if (!publicId) return null;
    return [...this.sessions.values()].find((s) => s.publicId === publicId) || null;
  }

  // End a shared session that a NEW sid replaced but could NOT be adopted (the
  // cold-match path, finding #14): one final legible notice item to the phone,
  // then the normal disable (the server DELETE marks the row ended). Best-
  // effort on the notice; the end itself is unconditional — a frozen mirror
  // that looks alive is the bug.
  async endReplacedSession(s, newSid) {
    try {
      this.queueNotice(s,
        'This session ended — /clear started a new one. Share the new session again to keep mirroring.',
        `ended-${s.sid.slice(0, 8)}`);
      await this.flush(s);
      if (s.queue.length) this.log(`${s.publicId}: the ended notice did not reach the server (${s.queue.length} item(s) pending) — ending anyway, the status change is what the phone keys on`);
    } catch (e) {
      this.log(`${s.publicId}: could not publish the ended notice (${e.message}) — ending anyway`);
    }
    await this.disableSession(s.sid, `/clear (or a fresh claude) replaced it with sid ${newSid.slice(0, 8)}`);
  }

  // Bind exactly ONE pane, or refuse. Primary = the tty (authoritative: a pane
  // OWNS its tty). Fallback = the cwd, used ONLY when there is no usable tty
  // (Claude Code can spawn a hook without a controlling tty), and only when
  // exactly one pane matches — two candidates means typing the human's words
  // into a stranger's shell, so ambiguity refuses like absence does.
  //
  // Returns {pane} or {refusal}. The refusal DISTINGUISHES "you are not in a
  // tmux pane" from "the daemon could not read the pane list" — the second was
  // reported as the first for weeks (QA finding #10: a locale-mangled
  // list-panes read as 0 panes, and the message blamed the user).
  resolvePane({ sid, tty, cwd }) {
    const tag = String(sid || '').slice(0, 8);
    const opts = { onWarn: (m) => this.log(m) };
    try {
      if (tty) {
        const hit = core.tmuxPaneForTty(tty, opts);
        if (hit) return { pane: { paneId: hit.paneId, loc: hit.loc, by: `tty ${tty}` } };
        // A REAL tty that no pane owns = claude is not running inside tmux. The
        // cwd fallback must NOT rescue this: it would bind an unrelated pane.
        this.log(`enable ${tag} REFUSED: tty ${tty} is not a tmux pane — claude is not running inside tmux`);
        return { refusal: core.ENABLE_NO_PANE_REASON };
      }
      const hits = core.tmuxPanesForCwd(cwd, opts);
      if (hits.length === 1) return { pane: { paneId: hits[0].paneId, loc: hits[0].loc, by: `cwd ${cwd}` } };
      this.log(`enable ${tag} REFUSED: no controlling tty and ${hits.length} tmux pane(s) sit in ${cwd || '(unknown cwd)'} — a pane-less or guessed share would drop every keystroke`);
      return { refusal: core.ENABLE_NO_PANE_REASON };
    } catch (e) {
      // The pane list existed but could not be PARSED (core.tmuxPanes threw).
      // That is a daemon-side failure — refuse loudly WITHOUT telling the human
      // they are not in tmux (§11: the silence/misblame is the bug).
      this.log(`enable ${tag} REFUSED: ${e.message}`);
      return { refusal: core.ENABLE_PANE_LOOKUP_FAILED_REASON };
    }
  }

  async enableSession({ sid, paneId, tty, cwd, file, mode, approvals }) {
    this.acquireWriterLock(sid); // B3 — refuse loudly on conflict
    try {
      return await this.enableSessionLocked({ sid, paneId, tty, cwd, file, mode, approvals });
    } catch (e) {
      // A failed enable must not strand the lock — NOR leave the half-enabled
      // record live: enableSessionLocked inserts into this.sessions and persists
      // before the first backfill flush, so a throw after that point would leave
      // a session publishing without the single-writer guarantee and reviving
      // from state.json on the next boot.
      const s = this.sessions.get(sid);
      if (s) { s.gen += 1; this.sessions.delete(sid); }
      delete this.state.sessions[sid];
      this.saveState();
      this.releaseWriterLock(sid);
      throw e;
    }
  }

  async enableSessionLocked({ sid, paneId, tty, cwd, file, mode, approvals }) {
    const session = {
      sid,
      // The SHARE's identity (spec §16) — minted per share, kept across every
      // occupant change. v1 derived it from the sid (`ases_<sid>`); those ids
      // are grandfathered forever in state.json, but nothing new is minted that
      // way: the harness session id now lives in `currentSid` (and inside
      // meta_sealed), where an occupant attribute belongs.
      publicId: core.mintShareId(),
      currentSid: sid,
      occupant: 'agent',
      harness: 'claude',
      paneId, tty, cwd, file,
      title: path.basename(cwd || 'session'),
      mode: mode || null, // harness permission mode — sealed meta only (§4)
      hv: null,
      offset: 0,
      seenUuids: new Set(), seenRing: [],
      queue: [], outboxBytes: 0, nextSeq: 1,
      status: 'idle', waitingArmed: true,
      notifyOnWaiting: false, // opt-in per session, learned from the server echo (§9)
      lastAliveAt: Date.now(), // mirror-life diagnostic (narrated in logs; NOT an adoption gate)
      approvals: approvals || [],
      flushing: false, backfilled: 0,
      registered: true, registering: false, // the server knows this session
      backoff: 0, nextFlushAt: 0, // publish backoff window (flushTick honors it)
      gen: 0, // teardown identity (#66)
    };
    const echo = await this.registerSession(session, 'idle');
    session.nextSeq = (echo.last_seq || 0) + 1;
    session.notifyOnWaiting = echo.notify_on_waiting === true; // absent ⇒ false (§9)
    this.sessions.set(sid, session);
    this.persistSession(session);
    await this.backfill(session);
    this.subscribeInput(session);
    this.log(`enabled ${sid.slice(0, 8)} → ${session.publicId} (pane ${paneId}, seq from ${session.nextSeq})`);
    return session;
  }

  // Record a uuid as published. Returns false when it was already known — the
  // ONE dedup gate for the tailer, the backfill and every rescan. `seenRing` is
  // the bounded, persistable tail of the same knowledge (see persistSession).
  markSeen(s, uuid) {
    if (s.seenUuids.has(uuid)) return false;
    s.seenUuids.add(uuid);
    s.seenRing.push(uuid);
    if (s.seenRing.length > SEEN_RING) s.seenRing.splice(0, s.seenRing.length - SEEN_RING);
    return true;
  }

  // --- the durable outbox ---------------------------------------------------
  //
  // An item is enqueued the moment it is sealed and removed ONLY when the
  // server has acked it (201). Because the queue used to live in memory only
  // while the read offset and the uuid ring were persisted immediately, a
  // server outage plus a restart was silent DATA LOSS: the offset sat at EOF,
  // the uuids were deduped, and the queued items were simply gone — the phone
  // never saw them and the next item took their seq (an invisible splice).
  // Now the offset, the uuid ring and the pending items are written in ONE
  // atomic state.json write, so they can never disagree about what was read
  // but not yet delivered.

  queuePush(s, uuid, sealed) {
    s.queue.push({ uuid, sealed });
    s.outboxBytes = (s.outboxBytes || 0) + sealed.length;
  }

  // Drop the first n entries — ONLY ever called for items the server has
  // confirmed it stored (a 201, or a seq re-sync that proved they landed).
  queueDrop(s, n) {
    const gone = s.queue.splice(0, n);
    let freed = 0;
    for (const e of gone) freed += (e.sealed || '').length;
    s.outboxBytes = Math.max(0, (s.outboxBytes || 0) - freed);
    if (!s.queue.length) s.outboxBytes = 0;
    return gone.length;
  }

  outboxFull(s) {
    return s.queue.length >= OUTBOX_MAX_ITEMS || (s.outboxBytes || 0) >= OUTBOX_MAX_BYTES;
  }

  persistSession(s) {
    this.state.sessions[s.sid] = {
      // v1's key, kept forever: a downgraded 0.42.x daemon re-arms from THIS
      // field (see STATE_VERSION — the downgrade is silent, not a refusal).
      publicId: s.publicId,
      // v2 (spec §16): the share identity and the CURRENT occupant, side by
      // side. `share_id` is `publicId` verbatim — the duplication is the
      // migration contract (a grandfathered id must be readable as a share id
      // without deriving anything).
      share_id: s.publicId,
      current_sid: s.currentSid !== undefined ? s.currentSid : s.sid,
      occupant: s.occupant || 'agent',
      harness: s.harness || 'claude',
      paneId: s.paneId, tty: s.tty, cwd: s.cwd,
      // The tunnel that owns this session (finding #13): the load-time scope
      // check keys on it, so a reconnect to another tunnel cannot inherit it.
      channelId: this.env.channelId,
      file: s.file, offset: s.offset, nextSeq: s.nextSeq, approvals: s.approvals,
      lastAliveAt: s.lastAliveAt || 0, // mirror-life diagnostic
      mode: s.mode || null,
      seen: s.seenRing, // restart dedup (§6) — see seedSeenFromFile
      // The pending sealed items, with the uuid that produced each. Riding in
      // the SAME write as `offset`/`seen` is the point: a uuid may be marked
      // seen before its 201 precisely because the item itself survives here and
      // is replayed on the next boot (rearmPersisted).
      outbox: s.queue,
    };
    this.saveState();
  }

  // Local teardown only — no server call. Used when the server has told us the
  // session is gone (a re-register it refused definitively).
  dropSession(session, why) {
    session.gen += 1; // invalidate every outstanding async callback (#66)
    if (this.sessions.get(session.sid) === session) this.sessions.delete(session.sid);
    delete this.state.sessions[session.sid];
    this.saveState();
    this.releaseWriterLock(session.sid);
    this.log(`dropped ${session.sid.slice(0, 8)} (${why})`);
  }

  // Returns {sid, server_ok, detail}: the LOCAL stop always happens, but a
  // DELETE that never reached the server must be reported as such — telling
  // the human "✓ stopped sharing" while the row is still live on the server is
  // the kind of quiet lie this feature does not get to tell.
  async disableSession(sid, why) {
    const s = this.sessions.get(sid);
    if (!s) { delete this.state.sessions[sid]; this.saveState(); return { sid, server_ok: true, detail: null }; }
    s.gen += 1; // invalidate every outstanding async callback (#66)
    this.sessions.delete(sid);
    delete this.state.sessions[sid];
    this.saveState();
    this.releaseWriterLock(sid);
    let serverOk = false;
    let detail = null;
    try {
      const { res } = await this.api('DELETE', `/agent_sessions/${s.publicId}`);
      // 404 = already gone (the DELETE is idempotent by contract) — that IS a
      // clean stop, not a failure.
      serverOk = (res.status >= 200 && res.status < 300) || res.status === 404;
      if (!serverOk) detail = `server answered ${res.status}`;
    } catch (e) {
      detail = e.message;
    }
    this.log(`disabled ${sid.slice(0, 8)} (${why})${serverOk ? '' : ` — the server was NOT told (${detail}); it reaps the session on staleness`}`);
    return { sid, server_ok: serverOk, detail };
  }

  // On boot: re-arm persisted sessions (daemon restart must not silently
  // disable a share the user opted into — the epoch bump invalidates any
  // pre-restart input ciphertext, so this is safe).
  async rearmPersisted() {
    for (const [sid, p] of Object.entries(this.state.sessions || {})) {
      try {
        this.acquireWriterLock(sid);
      } catch (e) {
        // Another live daemon owns this session. Leaving it in state is the
        // whole point — it is not ours to un-share.
        this.log(`re-arm ${sid.slice(0, 8)} skipped: ${e.message}`);
        continue;
      }
      // The un-acked items from the previous process, replayed before a single
      // new byte is tailed (their seqs are re-assigned from the server's
      // high-water at register, so ordering and monotonicity hold).
      const outbox = (p.outbox || []).filter((e) => e && typeof e.sealed === 'string');
      const session = {
        sid, publicId: p.publicId, paneId: p.paneId, tty: p.tty, cwd: p.cwd,
        // A migrated v1 entry carries current_sid = its old sid (see
        // migrateState); a v2 term share carries null.
        currentSid: p.current_sid !== undefined ? p.current_sid : sid,
        occupant: p.occupant || 'agent',
        harness: p.harness || 'claude',
        file: p.file, offset: p.offset || 0,
        title: path.basename(p.cwd || 'session'), hv: null,
        // Restart dedup: start from the persisted ring, then rebuild the rest
        // from the bytes we already published (below) BEFORE any tick can emit.
        seenUuids: new Set(p.seen || []), seenRing: [...(p.seen || [])],
        queue: outbox, outboxBytes: outbox.reduce((n, e) => n + e.sealed.length, 0),
        nextSeq: p.nextSeq || 1,
        status: 'idle', waitingArmed: true, approvals: p.approvals || [],
        notifyOnWaiting: false, // re-learned from the boot register's echo (§9)
        lastAliveAt: p.lastAliveAt || 0, // mirror-life diagnostic
        mode: p.mode || null,
        flushing: false, backfilled: 0, registered: false, registering: false,
        backoff: 0, nextFlushAt: 0, gen: 0,
      };
      this.seedSeenFromFile(session);
      // A pending item's uuid counts as seen: it is not published yet, but it
      // IS captured — re-reading it from the transcript would queue it twice.
      for (const e of session.queue) if (e.uuid) this.markSeen(session, e.uuid);
      this.sessions.set(sid, session);
      this.subscribeInput(session);
      if (outbox.length) this.log(`${sid.slice(0, 8)}: ${outbox.length} un-acked item(s) recovered from the outbox — they publish before any new bytes`);
      await this.registerOrKeep(session);
      if (this.sessions.get(sid) === session) {
        this.log(`re-armed ${sid.slice(0, 8)} after restart (epoch ${this.state.epoch})`);
      }
    }
  }

  // Register (or re-register) a session with the server. A failure the server
  // owns definitively drops the share; ANY transient failure keeps it — the
  // offsets, the dedup ring and the pending outbox all live on this computer,
  // so publishing simply resumes when the server comes back. A Mac that reboots
  // during a deploy used to lose every share here.
  async registerOrKeep(session) {
    if (session.registering) return false;
    session.registering = true;
    const gen = session.gen;
    try {
      const echo = await this.registerSession(session, session.status || 'idle');
      if (!this.stillOwns(session, gen)) return false; // torn down mid-flight (#66)
      session.nextSeq = Math.max(session.nextSeq || 1, (echo.last_seq || 0) + 1);
      session.notifyOnWaiting = echo.notify_on_waiting === true; // absent ⇒ false (§9)
      session.registered = true;
      session.backoff = 0;
      session.nextFlushAt = 0;
      this.persistSession(session);
      return true;
    } catch (e) {
      if (!this.stillOwns(session, gen)) return false;
      if (DEFINITIVE_REGISTER_STATUSES.has(e.status)) {
        this.log(`${session.sid.slice(0, 8)}: the server refused this session for good (${e.message}) — un-sharing it locally`);
        this.dropSession(session, 'server refused the session');
        return false;
      }
      session.registered = false;
      this.backOff(session, `register failed (${e.message})`);
      this.log(`${session.sid.slice(0, 8)}: keeping the share — offsets and ${session.queue.length} pending item(s) stay on this computer; publishing resumes on reconnect`);
      return false;
    } finally {
      session.registering = false;
    }
  }

  // --- single-writer lock (B3) ---------------------------------------------

  lockPath(sid) { return path.join(core.LOCKS_DIR(), `${sid}.lock`); }

  acquireWriterLock(sid) {
    fs.mkdirSync(core.LOCKS_DIR(), { recursive: true });
    const p = this.lockPath(sid);
    const mine = `${process.pid}\n`;
    try {
      fs.writeFileSync(p, mine, { flag: 'wx' });
      return;
    } catch {
      let holder = 0;
      try { holder = Number(fs.readFileSync(p, 'utf8').trim()) || 0; } catch {}
      const alive = holder && (() => { try { process.kill(holder, 0); return true; } catch { return false; } })();
      if (alive && holder !== process.pid) {
        throw new Error(`session ${sid.slice(0, 8)} already has a live writer (pid ${holder}) — refuse loudly, never rebind (B3)`);
      }
      fs.writeFileSync(p, mine); // stale/own lock: take over
    }
  }

  releaseWriterLock(sid) {
    try { fs.unlinkSync(this.lockPath(sid)); } catch {}
  }

  // --- tailer + publisher ---------------------------------------------------

  // Read [from, to) of the session file and return its COMPLETE lines as parsed
  // JSONL records (the trailing fragment, if any, is left for the tailer).
  // `ends[i]` is the absolute offset just past record i — what lets the tailer
  // stop MID-CHUNK (outbox at cap) without losing the records it did not take.
  readRecords(file, from, to) {
    const fd = fs.openSync(file, 'r');
    let buf;
    try {
      buf = Buffer.alloc(Math.max(0, to - from));
      if (buf.length) fs.readSync(fd, buf, 0, buf.length, from);
    } finally { fs.closeSync(fd); }
    const objs = [];
    const ends = [];
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(0x0a, start);
      if (nl < 0) break;
      const line = buf.subarray(start, nl).toString('utf8');
      start = nl + 1;
      if (!line.trim()) continue;
      let obj; try { obj = JSON.parse(line); } catch { continue; }
      objs.push(obj);
      ends.push(from + start);
    }
    // consumed = how far the caller may advance its offset: never past a record
    // still being written (a half-flushed line would otherwise be skipped forever).
    return { objs, ends, consumed: from + start };
  }

  // Rebuild the dedup set after a daemon restart.
  //
  // seenUuids is what keeps a rescan (`size < offset`, the probe-proven
  // in-place rewrite) or a /clear rotation from re-publishing an entire
  // transcript under fresh seqs. It lives in memory, so a restart used to empty
  // it: the very next rescan re-emitted every record the phone already had.
  // Two guards, cheapest first: the ring persisted in state.json, plus a
  // no-emit re-read of the prefix we already published ([0, offset)). This runs
  // BEFORE the session joins this.sessions, so no tick can emit in between.
  seedSeenFromFile(s) {
    if (!s.offset) return;
    let objs;
    try {
      const st = fs.statSync(s.file);
      const to = Math.min(s.offset, st.size);
      // Bounded: a multi-GB transcript must not be slurped to rebuild a dedup
      // set. What the window can miss is old records a LATER rescan might
      // re-publish — and a rescan is itself capped at the newest 100 items
      // (enqueueBounded), all of which live inside this window.
      const from = Math.max(0, to - TAIL_WINDOW_BYTES);
      if (from > 0) this.log(`${s.sid.slice(0, 8)}: reseeding the dedup set from the last ${TAIL_WINDOW_BYTES}B of a ${to}B prefix`);
      ({ objs } = this.readRecords(s.file, from, to));
    } catch (e) {
      this.log(`${s.sid.slice(0, 8)}: dedup set could not be reseeded (${e.message}) — the ${s.seenUuids.size} persisted uuid(s) are the only guard`);
      return;
    }
    for (const obj of objs) for (const item of adapter.normalize(obj)) this.markSeen(s, item.uuid);
    this.log(`${s.sid.slice(0, 8)}: dedup set reseeded with ${s.seenUuids.size} published uuid(s)`);
  }

  // Seal + enqueue a BULK emission (the enable backfill, a rescan, a /clear
  // rotation), bounded to the LAST 100 items / 512 KB sealed (spec §6). Live
  // tailing goes through the unbounded path — this cap exists so a 5k-item
  // transcript can never flood the lane in one go.
  enqueueBounded(s, items, why) {
    let total = 0;
    const sealed = [];
    for (const item of items.slice(-BACKFILL_ITEMS).reverse()) { // newest first for the budget…
      item._publicId = s.publicId;
      let b64 = null;
      try { b64 = this.sealItem(item); } catch (e) { this.log(`item ${item.uuid}: seal failed (${e.message}) — skipped`); }
      if (b64 === null) continue;
      const bytes = Buffer.byteLength(b64, 'utf8');
      if (total + bytes > BACKFILL_SEALED_BYTES) break;
      total += bytes;
      sealed.push({ uuid: item.uuid, b64 });
    }
    sealed.reverse(); // …back to oldest-first for seq order
    for (const e of sealed) this.queuePush(s, e.uuid, e.b64);
    if (items.length > sealed.length) {
      this.log(`${why}: seeded ${sealed.length}/${items.length} items (bounded window — earlier history stays on this computer)`);
    }
    return sealed.length;
  }

  async backfill(session) {
    // Seed = the LAST 100 items / 512 KB sealed, oldest-first (spec §6).
    const items = [];
    try {
      const st = fs.statSync(session.file);
      // Read a bounded TAIL, not the whole file: the seed is the newest 100
      // items, and a long-running session's transcript can be gigabytes. A
      // partial first line inside the window simply fails to parse and is
      // skipped — the window boundary is a record boundary from then on.
      const from = Math.max(0, st.size - TAIL_WINDOW_BYTES);
      if (from > 0) this.log(`backfill: transcript is ${st.size}B — seeding from its last ${TAIL_WINDOW_BYTES}B (earlier history stays on this computer)`);
      const { objs, consumed } = this.readRecords(session.file, from, st.size);
      session.offset = consumed; // NOT st.size: a record mid-write stays unread
      for (const obj of objs) {
        for (const item of adapter.normalize(obj)) {
          if (!this.markSeen(session, item.uuid)) continue;
          if (item.hv) session.hv = item.hv;
          items.push(item);
        }
      }
    } catch (e) {
      this.log(`backfill read failed (${e.message}) — starting live-only`);
      return;
    }
    session.backfilled = this.enqueueBounded(session, items, 'backfill');
    // Persist offset + the uuid ring BEFORE publishing (same order the tailer
    // uses): a restart mid-flush must not re-read and re-publish the seed.
    this.persistSession(session);
    await this.flush(session);
  }

  tailTick() {
    for (const s of this.sessions.values()) this.tailOne(s);
    this.occupantTick(); // v2 §16 — throttled inside
  }

  tailOne(s) {
    // A terminal share has no transcript to tail (v2 §16): its bytes are the
    // mirror's business (Phase B), never a JSONL on this disk.
    if (!s.file) return;
    let st;
    try { st = fs.statSync(s.file); } catch { return; }
    if (st.size < s.offset) {
      // Truncated/rewritten in place (probe: RESCAN) — re-read whole, dedup by
      // uuid. `bulk` makes this re-read obey the §6 cap: a 5k-item transcript
      // whose dedup set is somehow cold must not flood the lane in one tick.
      this.log(`${s.sid.slice(0, 8)}: size ${st.size} < offset ${s.offset} — full rescan with uuid dedup`);
      s.offset = 0; s.bulk = true;
    }
    if (st.size <= s.offset) return;
    // The outbox is at its cap (the server has been unreachable long enough to
    // fill it): STOP READING. The offset stays where it is, so everything past
    // it remains exactly where it is already durable — in the transcript file —
    // instead of piling into a queue we would have to bound by dropping it.
    if (this.outboxFull(s)) {
      if (!s.outboxWarned) {
        s.outboxWarned = true;
        this.log(`${s.sid.slice(0, 8)}: outbox FULL (${s.queue.length} items / ${s.outboxBytes}B un-acked) — pausing the tail at offset ${s.offset}; nothing is lost, the transcript keeps it until the backlog drains`);
      }
      return;
    }
    s.outboxWarned = false;
    const bulk = !!s.bulk;
    s.bulk = false;
    // Live reads are windowed (the next tick continues where this one stopped);
    // a bulk re-read wants the whole prefix for dedup, but is still clamped —
    // a transcript larger than the clamp degrades to windowed live reads, whose
    // items the dedup set absorbs.
    const to = Math.min(st.size, s.offset + (bulk ? RESCAN_MAX_BYTES : LIVE_READ_MAX_BYTES));
    if (bulk && to < st.size) this.log(`${s.sid.slice(0, 8)}: rescan clamped to ${RESCAN_MAX_BYTES}B of a ${st.size}B transcript — the remainder streams on the next ticks`);
    let objs, ends, consumed;
    try {
      ({ objs, ends, consumed } = this.readRecords(s.file, s.offset, to));
    } catch (e) { this.log(`${s.sid.slice(0, 8)}: tail read failed (${e.message}) — retrying next tick`); return; }
    // The trailing fragment of a record still being written is left UNREAD
    // rather than carried in memory: offset only ever advances past COMPLETE
    // records, so the next tick re-reads it (and a restart resumes at a record
    // boundary instead of skipping the half-written one forever).
    if (consumed <= s.offset) return;
    if (bulk) {
      const fresh = [];
      for (const obj of objs) {
        for (const item of adapter.normalize(obj)) {
          if (!this.markSeen(s, item.uuid)) continue;
          this.noteHarnessVersion(s, item);
          fresh.push(item);
        }
      }
      s.offset = consumed;
      this.enqueueBounded(s, fresh, `${s.sid.slice(0, 8)}: rescan`);
    } else {
      // Record by record, so hitting the cap mid-chunk parks the offset at the
      // last record we actually enqueued — the rest is re-read, never skipped.
      let consumedTo = consumed;
      for (let i = 0; i < objs.length; i++) {
        for (const item of adapter.normalize(objs[i])) {
          if (!this.markSeen(s, item.uuid)) continue;
          this.noteHarnessVersion(s, item);
          item._publicId = s.publicId;
          // A seal failure on ONE item must never take the tailer interval down —
          // skip it loudly and keep tailing (the JSONL remains durable).
          let b64 = null;
          try { b64 = this.sealItem(item); } catch (e) { this.log(`item ${item.uuid}: seal failed (${e.message}) — skipped`); }
          if (b64 !== null) this.queuePush(s, item.uuid, b64);
        }
        if (this.outboxFull(s)) {
          consumedTo = ends[i];
          this.log(`${s.sid.slice(0, 8)}: outbox hit its cap mid-read — parking the tail at offset ${consumedTo}; the remaining records stay in the transcript`);
          break;
        }
      }
      s.offset = consumedTo;
    }
    s.lastAliveAt = Date.now(); // transcript growth = mirror life (diagnostic)
    this.persistSession(s);
  }

  noteHarnessVersion(s, item) {
    if (!item.hv || item.hv === s.hv) return;
    if (s.hv) this.log(`${s.sid.slice(0, 8)}: harness version drift ${s.hv} → ${item.hv}`);
    s.hv = item.hv;
  }

  // Does this record still own its slot? Every await inside flush must ask:
  // `disable` bumps gen AND removes the session, and a late success that then
  // persisted the record would REVIVE a share the human just revoked (#66).
  stillOwns(session, gen) {
    return session.gen === gen && this.sessions.get(session.sid) === session;
  }

  async flushTick() {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      // Honor the backoff window. Without this the tick simply re-fired every
      // 500 ms after every failure (`flushing` is cleared on the way out), so a
      // Base-tier 402 or a 500 became a 2 req/s storm against the server AND
      // piled up one retry timer per failure.
      if (s.nextFlushAt && now < s.nextFlushAt) continue;
      // A session the server does not know about yet (the boot register failed
      // transiently) retries HERE, on the same backoff clock — publishing waits
      // for it, the durable outbox holds everything meanwhile.
      if (!s.registered) {
        this.registerOrKeep(s).catch((e) => this.log('re-register error:', e.message));
        continue;
      }
      if (!s.queue.length || s.flushing) continue;
      this.flush(s).catch((e) => this.log('flush error:', e.message));
    }
  }

  // Back off after a failed batch. No timer is scheduled: flushTick is already
  // running every FLUSH_MS and picks the session up once the window elapses —
  // one clock, no accumulation.
  backOff(session, why) {
    session.backoff = Math.min((session.backoff || 1) * 2, 60);
    session.nextFlushAt = Date.now() + session.backoff * 1000;
    this.log(`${session.publicId}: ${why}; retry in ${session.backoff}s (nothing lost — the JSONL is durable)`);
  }

  async flush(session) {
    if (session.flushing) return;
    session.flushing = true;
    const gen = session.gen;
    try {
      while (session.queue.length) {
        if (!this.stillOwns(session, gen)) return; // torn down mid-flush (#66)
        const batch = session.queue.slice(0, this.caps.items_per_call);
        const items = batch.map((e, i) => ({ seq: session.nextSeq + i, payload_sealed: e.sealed }));
        const { res, data } = await this.api('POST', `/agent_sessions/${session.publicId}/items`, { items });
        // Re-check BEFORE any mutation: an await is a teardown window, and
        // persistSession() on a disabled session writes it back into state.json
        // — it would come back alive on the next boot (consent violation).
        if (!this.stillOwns(session, gen)) {
          this.log(`${session.publicId}: disabled mid-flush — response dropped, nothing re-persisted (#66)`);
          return;
        }
        if (res.status === 201) {
          // ONLY here does an item leave the durable outbox: the server has it.
          this.queueDrop(session, batch.length);
          session.nextSeq = (data.last_seq || (session.nextSeq + batch.length - 1)) + 1;
          session.backoff = 0;
          session.nextFlushAt = 0;
          this.persistSession(session);
        } else if (res.status === 422 && data && data.code === 'seq_regression') {
          if (!(await this.resyncSeq(session, gen))) return;
        } else {
          this.backOff(session, `items POST → ${res.status}`);
          return;
        }
      }
    } finally {
      session.flushing = false;
    }
  }

  // seq_regression = the server already stored seqs we are re-sending. The
  // canonical cause is a LOST 201: the batch landed, the ack didn't, so the
  // retry replays stored seqs. Re-register to learn the server's high-water and
  // drop from the queue EXACTLY the items at or below it — they are persisted
  // already. Never re-send a stored seq (duplicates in the conversation), never
  // blind-drop an unstored one (a hole the JSONL can no longer fill).
  // Returns false when the caller must stop this flush pass.
  async resyncSeq(session, gen) {
    const { data: reg } = await this.api('POST', '/agent_sessions', {
      public_id: session.publicId, status: session.status, meta_sealed: this.sealMeta(session),
    });
    if (!this.stillOwns(session, gen)) return false;
    this.applySessionEcho(session, reg);
    const serverSeq = reg && reg.session && Number.isInteger(reg.session.last_seq) ? reg.session.last_seq : null;
    if (serverSeq === null) {
      // Could not learn the high-water: back off and retry, do NOT guess.
      this.backOff(session, 'seq_regression but the re-register carried no last_seq');
      return false;
    }
    const firstSeq = session.nextSeq; // the seq queue[0] would have been sent as
    const stored = serverSeq - firstSeq + 1;
    if (stored > 0) {
      const drop = this.queueDrop(session, Math.min(stored, session.queue.length));
      this.log(`${session.publicId}: seq_regression — ${drop} queued item(s) were already stored (server last_seq ${serverSeq}); continuing at ${serverSeq + 1}`);
    } else if (stored === 0) {
      // Our numbering ALREADY continues the server's high-water, yet it 422'd:
      // the re-sync explains nothing and re-sending the same seqs would spin
      // forever. Back off instead of looping (and keep the items).
      this.backOff(session, `seq_regression at seq ${firstSeq} that the re-register does not explain (server last_seq ${serverSeq})`);
      return false;
    } else {
      // firstSeq > serverSeq + 1: a gap this daemon cannot fill (the missing
      // items belong to a previous process). Renumber onto the server's
      // high-water and keep going — loudly. The phone renders the gap; looping
      // here forever would be worse (§11: visible boundary, never a silent splice).
      this.log(`${session.publicId}: seq GAP — queue starts at ${firstSeq} but the server is at ${serverSeq}; resuming at ${serverSeq + 1}, the missing items are only on this computer`);
    }
    session.nextSeq = serverSeq + 1;
    session.backoff = 0;
    session.nextFlushAt = 0;
    this.persistSession(session);
    return true;
  }

  // --- status + waiting notification (spec §9) ------------------------------

  // The harness's permission mode rides the BASE payload of every hook event
  // (Claude: default | plan | acceptEdits | bypassPermissions) — read
  // DEFENSIVELY from ALL of them (SessionStart, PreToolUse, Notification,
  // Stop), the field can be absent on older harnesses, and absence is never a
  // change. Reading it only on PreToolUse was QA r6-5's stagnant chip: a
  // switch INTO plan mode tends to be followed by zero tool calls (plan mode
  // exists to not run tools), so the daemon never saw the transition and the
  // phone showed "Accepting edits" against a pane sitting in plan mode. A
  // change refreshes meta_sealed so viewers see the current mode; the mode
  // lives only inside the sealed blob (the server never reads it).
  notePermissionMode(s, mode) {
    if (typeof mode !== 'string' || !mode || mode === s.mode) return;
    const had = s.mode || null;
    s.mode = mode;
    this.persistSession(s);
    this.api('PATCH', `/agent_sessions/${s.publicId}`, { status: s.status, meta_sealed: this.sealMeta(s) })
      .catch((e) => this.log(`${s.publicId}: meta refresh on mode change failed (${e.message}) — the next change retries`));
    this.log(`${s.sid.slice(0, 8)}: permission mode ${had ? `${had} → ` : ''}${mode}`);
  }

  // The server echoes the session row on every agent-side POST/PATCH response
  // (spec §9): notify_on_waiting is the human's per-session opt-in, learned
  // here within one heartbeat of a flip — zero new polling surface. ABSENT
  // (an older server, or a response with no session echo) changes nothing;
  // an echo WITHOUT the field reads FALSE.
  applySessionEcho(s, data) {
    const echo = data && data.session;
    if (!echo || typeof echo !== 'object') return;
    s.notifyOnWaiting = echo.notify_on_waiting === true;
  }

  // s.status IS the desired status: the transition PATCH is best-effort, and
  // the heartbeat re-asserts whatever this last set.
  setStatus(s, status) {
    if (status === 'running') s.waitingArmed = true; // re-arm the waiting edge
    if (s.status === status) return;
    s.status = status;
    this.api('PATCH', `/agent_sessions/${s.publicId}`, { status })
      .then(({ data }) => this.applySessionEcho(s, data))
      .catch((e) => this.log('status PATCH failed:', e.message));
  }

  async heartbeatTick() {
    // The computer's own presence beat (§17): `perform "heartbeat"`, no
    // payload, on the same 30 s clock. Write-throttled server-side; it keeps
    // the phone's online chip fresh with zero shared panes. DISPLAY-ONLY —
    // nothing downstream may read it (invariant #3).
    this.performComputer('heartbeat');
    for (const s of [...this.sessions.values()]) { // a copy: the pane check may end sessions mid-walk
      if (!s.registered) continue; // flushTick owns the re-register retry
      // VERIFY the pane before re-affirming (QA r6-6). A dead pane used to be
      // detected only on input delivery, so the heartbeat kept PATCHing status
      // for a session whose pane was gone — last_seen_at stayed fresh, the
      // server's 90 s staleness never fired, and the phone read "waiting for
      // you" forever while its keys went into the void. The human had to FAIL
      // first for the system to admit it broke. One tmux call per session per
      // 30 s buys the honest answer; a vanished tmux SERVER reads the same way
      // (tmux runs, answers "no server" ⇒ paneAlive false) — with no pane
      // there is no session either way. Ended LOUDLY, now: log + DELETE
      // (disableSession), never waiting on input or staleness.
      //
      // Ended ONLY on a definite `false` (PR #110 review): `null` means the
      // EXEC failed (EAGAIN/ENOENT/wedged-tmux timeout) — the daemon could not
      // ask, and ending N live sessions over a transient exec hiccup with a
      // "pane is GONE" log is the #10 mis-blame family. Unknown ⇒ say so
      // loudly, re-affirm as normal, let the next beat re-check.
      if (s.paneId) {
        const alive = this.paneAlive(s.paneId);
        if (alive === false) {
          this.log(`${s.sid.slice(0, 8)}: bound pane ${s.paneId} is GONE — ending the session loudly (r6-6: a heartbeat must verify the pane, not re-affirm a corpse into "waiting for you" forever)`);
          await this.disableSession(s.sid, 'pane died (heartbeat liveness check)');
          continue;
        }
        if (alive === null) {
          this.log(`${s.sid.slice(0, 8)}: pane check FAILED (daemon-side — tmux could not be asked) — NOT ending the session; re-affirming status, the next beat re-checks`);
        }
      }
      // Carry the CURRENT status, never `{}`. The transition PATCH is
      // fire-and-forget: one dropped running→waiting used to leave the server
      // (and the phone) showing `running` until the NEXT transition — a session
      // that is actually waiting for the human, displayed as busy. The beat now
      // re-asserts it, so a lost transition self-heals within one cadence.
      // `mode` rides the same beat (§16): absent means unchanged server-side,
      // so re-asserting the occupant self-heals a dropped flip exactly the way
      // re-asserting the status self-heals a dropped transition.
      await this.api('PATCH', `/agent_sessions/${s.publicId}`,
        { status: s.status, ...(s.occupant ? { mode: s.occupant } : {}) })
        .then(({ data }) => this.applySessionEcho(s, data))
        .catch(() => {});
    }
  }

  async maybeNotifyWaiting(s, message) {
    // OFF by default, opt-in PER SESSION (spec §9 REVISED, QA finding #16:
    // every agent reply is a running→waiting edge, so the old always-on rule
    // fired once per turn — 4 notifications in 8 minutes of normal use). The
    // server echoes notify_on_waiting on every register/heartbeat; a fresh
    // session, or any server that does not echo the field, reads FALSE and
    // never notifies. This gate bounds WHETHER; the episode debounce below
    // bounds HOW OFTEN once opted in.
    if (s.notifyOnWaiting !== true) return;
    // One notification per waiting-EPISODE: armed on the running→waiting edge,
    // reset by input or running (spec §9). One-and-done (#30) untouched —
    // this is an ordinary notification.
    if (!s.waitingArmed) return;
    // Disarmed only for the duration of the send (so a burst of Notification
    // hooks cannot double-fire); a send that does NOT land re-arms below —
    // otherwise a single 502 ate the whole waiting episode and the human simply
    // never learned the agent was waiting for them.
    s.waitingArmed = false;
    const cid = `ases-wait-${s.sid.slice(0, 8)}-${Date.now()}`;
    const aad = (f) => core.e2eAad(this.env.channelId, cid, f);
    const payload = {
      correlation_id: cid,
      profile: 'important',
      enc: 'v1',
      kf: core.e2eKeyFingerprint(this.key),
      title: core.e2eEncryptField(this.key, aad('title'), `${s.title} is waiting for you`),
      body_markdown: core.e2eEncryptField(this.key, aad('body_markdown'), message),
      url: core.e2eEncryptField(this.key, aad('url'), `pidge://agents/${s.publicId}`),
    };
    let status = null;
    try {
      ({ res: { status } } = await this.api('POST', '/notify', payload));
    } catch (e) {
      s.waitingArmed = true;
      this.log(`waiting notify failed (${e.message}) — still armed, the next waiting signal retries`);
      return;
    }
    if (status !== 201) {
      s.waitingArmed = true;
      this.log(`waiting notify → ${status} — still armed, the next waiting signal retries`);
    }
  }

  // --- approval gate (spec §9, off unless enable --approvals) ---------------

  toolGated(s, toolName) {
    if (!toolName) return false;
    return s.approvals.some((t) => t === '*' || t.toLowerCase() === String(toolName).toLowerCase());
  }

  async approvalGate(s, body) {
    const cid = `ases-appr-${s.sid.slice(0, 8)}-${Date.now()}`;
    const aad = (f) => core.e2eAad(this.env.channelId, cid, f);
    const input = JSON.stringify(body.tool_input || {}).slice(0, 400);
    const payload = {
      correlation_id: cid,
      profile: 'urgent',
      enc: 'v1',
      kf: core.e2eKeyFingerprint(this.key),
      title: core.e2eEncryptField(this.key, aad('title'), `Approve ${body.tool_name} in ${s.title}?`),
      body_markdown: core.e2eEncryptField(this.key, aad('body_markdown'), '```\n' + input + '\n```'),
      // The server's built-in pair is approve/REJECT (Notification::BUILTIN_CATALOG
      // — there is no `deny` action id; it would be dropped silently, leaving an
      // approve-only ask with no banner buttons). approve+reject is also an EXACT
      // banner category (HERALD_APPROVE_REJECT), so both buttons ride the banner.
      actions: ['approve', 'reject'],
      mirror_reply: false,
    };
    const { res, data } = await this.api('POST', '/notify', payload);
    if (res.status !== 201) { this.log(`approval notify → ${res.status} — falling open to the local prompt`); return null; }
    const deadline = Date.now() + 50_000; // hook budget minus slack (spec §9)
    while (Date.now() < deadline) {
      const waitS = Math.min(25, Math.ceil((deadline - Date.now()) / 1000));
      if (waitS <= 0) break;
      try {
        const { data: poll } = await this.api('GET', `/notifications/${cid}?wait=${waitS}`, undefined, (waitS + 10) * 1000);
        if (poll && poll.responded && poll.chosen_action) {
          const id = poll.chosen_action.action_id;
          if (id === 'approve') return { permissionDecision: 'allow', permissionDecisionReason: 'approved via Pidge' };
          if (id === 'reject') return { permissionDecision: 'deny', permissionDecisionReason: 'rejected via Pidge' };
          return null; // done/snooze/anything else: fall open to the local human
        }
      } catch { /* transient — keep waiting inside the budget */ }
    }
    // Timeout/error ⇒ NOTHING ⇒ Claude falls back to its local prompt —
    // fail-open to the local human, by design. Cancel the stale ask.
    this.api('DELETE', `/notifications/${cid}`).catch(() => {});
    return null;
  }

  // --- pane shares (v2 §16/§17): the consent unit is a PANE -----------------

  // Bind a tmux pane as a SHARE and register it. `sid`/`file` are present only
  // when a harness already occupies the pane; a plain terminal share carries a
  // LOCAL map key (`term-…`) that never leaves this computer — the wire
  // identity is the minted public_id, and the sealed meta's `sid` is honestly
  // null until a harness adopts the pane.
  async sharePane({ paneId, cwd, loc, occupant, sid = null, file = null, why }) {
    const existing = this.shareForPaneId(paneId);
    if (existing) throw new Error(`pane ${paneId} is already shared as ${existing.publicId}`);
    const key = sid || `term-${crypto.randomUUID().slice(0, 8)}`;
    this.acquireWriterLock(key); // B3 — one writer per share slot, always
    try {
      const session = {
        sid: key,
        publicId: core.mintShareId(),
        currentSid: sid,
        occupant,
        harness: occupant === 'agent' ? 'claude' : 'terminal',
        paneId, tty: null, cwd: cwd || null, file: file || null,
        title: path.basename(cwd || loc || 'pane'),
        mode: null, // the HARNESS permission mode (§4) — unrelated to `occupant`
        hv: null,
        offset: 0,
        seenUuids: new Set(), seenRing: [],
        queue: [], outboxBytes: 0, nextSeq: 1,
        status: 'idle', waitingArmed: true,
        notifyOnWaiting: false,
        lastAliveAt: Date.now(),
        approvals: [],
        flushing: false, backfilled: 0,
        registered: true, registering: false,
        backoff: 0, nextFlushAt: 0,
        gen: 0,
      };
      const echo = await this.registerSession(session, 'idle');
      session.nextSeq = (echo.last_seq || 0) + 1;
      session.notifyOnWaiting = echo.notify_on_waiting === true;
      this.sessions.set(key, session);
      this.persistSession(session);
      if (session.file) await this.backfill(session);
      this.subscribeInput(session);
      // The share opens with a legible line — a pane that appears on the phone
      // with no explanation is exactly the silence §11 forbids.
      this.narrateShare(session, why, `share-${session.publicId.slice(5, 13)}`);
      this.log(`shared pane ${paneId}${loc ? ` (${loc})` : ''} as ${session.publicId} — ${why} (mode ${occupant})`);
      return session;
    } catch (e) {
      const s = this.sessions.get(key);
      if (s) { s.gen += 1; this.sessions.delete(key); }
      delete this.state.sessions[key];
      this.saveState();
      this.releaseWriterLock(key);
      throw e;
    }
  }

  // A pane whose current command IS the harness may ALREADY have announced its
  // session to this daemon (SessionStart fires for every session, shared or
  // not). Binding that announcement is what makes a captured claude pane a real
  // transcript instead of an empty agent view. Requires a fresh announce that
  // resolves to THIS pane unambiguously — anything less is no bind (the pane is
  // still shared, as a terminal, and says so).
  announceForPane(pane, panes) {
    const now = Date.now();
    const want = String(pane.path || '').replace(/\/+$/, '');
    const sameCwdPanes = panes.filter((p) => String(p.path || '').replace(/\/+$/, '') === want).length;
    const hits = [...this.announces.entries()].filter(([sid, a]) => {
      if (now - a.at >= HOOK_TTL_MS || !a.transcriptPath || this.sessions.has(sid)) return false;
      // The announce map holds the tty exactly as the hook sent it — including
      // the "no controlling tty" markers, which must never be read as a name.
      const atty = core.normalizeTty(a.tty);
      if (atty) return atty === pane.tty;
      // ttyless (the Claude-hook reality, finding #12): cwd correlation, and
      // ONLY when this pane is the only one sitting there.
      return sameCwdPanes === 1 && String(a.cwd || '').replace(/\/+$/, '') === want;
    });
    if (hits.length !== 1) {
      if (hits.length > 1) this.log(`pane ${pane.paneId}: ${hits.length} announced sessions match it — cannot tell which claude is in there; sharing it as a terminal`);
      return null;
    }
    return { sid: hits[0][0], file: hits[0][1].transcriptPath };
  }

  // Share a pane that EXISTS on this computer, choosing the occupant from
  // `#{pane_current_command}` (§17: harness ⇒ agent, else term). Used by both
  // capture doors: the phone's sealed `capture` command and the human's
  // `pidge terminal share`. Returns a plain result object — every refusal is a
  // sentence, never a silent no-op.
  async shareExistingPane(paneId, { by }) {
    if (!paneId) return { ok: false, error: 'no pane_id was given' };
    let panes;
    try {
      panes = core.tmuxPanes({ onWarn: (m) => this.log(m) });
    } catch (e) {
      // #68: an unreadable pane list is a DAEMON-side failure, never "the pane
      // is not there".
      return { ok: false, error: `the tmux pane list came back mangled (${e.message}) — refusing to share a pane this computer cannot read` };
    }
    const pane = panes.find((p) => p.paneId === paneId);
    if (!pane) return { ok: false, error: `pane ${paneId} does not exist on this computer (it may have closed since the list was taken)` };
    const existing = this.shareForPaneId(paneId);
    if (existing) return { ok: false, error: `pane ${paneId} is already shared as ${existing.publicId}` };

    const harness = isHarnessCommand(pane.cmd);
    const bound = harness ? this.announceForPane(pane, panes) : null;
    try {
      const s = await this.sharePane({
        paneId,
        cwd: pane.path,
        loc: pane.loc,
        occupant: bound ? 'agent' : 'term',
        sid: bound ? bound.sid : null,
        file: bound ? bound.file : null,
        why: bound
          ? `shared by ${by} — claude is running here`
          : `shared by ${by}${harness ? ` — "${pane.cmd}" is running here, but this computer holds no transcript for it yet (it becomes an agent view the moment claude announces)` : ''}`,
      });
      return { ok: true, public_id: s.publicId, pane_id: paneId, loc: pane.loc, mode: s.occupant };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  shareLocalPane(paneId, { by }) {
    return this.shareExistingPane(paneId, { by });
  }

  // The occupant flip (§16). The `mode` column is CLEAR and the flip rides the
  // heartbeat PATCH the daemon already sends; every transition leaves a seam
  // notice in the transcript, so the renderer never swaps under the human
  // without a word.
  setOccupant(s, occupant, narration) {
    if (!occupant || s.occupant === occupant) return;
    s.occupant = occupant;
    if (occupant === 'term') { s.currentSid = null; s.harness = 'terminal'; s.file = null; }
    this.persistSession(s);
    this.api('PATCH', `/agent_sessions/${s.publicId}`, {
      status: s.status, mode: occupant, meta_sealed: this.sealMeta(s),
    }).catch((e) => this.log(`${s.publicId}: the mode PATCH failed (${e.message}) — the heartbeat re-asserts it`));
    this.narrateShare(s, narration, `occupant-${occupant}`);
    this.log(`${s.publicId}: occupant → ${occupant} (${narration})`);
  }

  // Poll the bound panes' current command (§16). Rides the 400 ms tail tick,
  // throttled to one tmux call per OCCUPANT_POLL_MS for ALL bound panes.
  occupantTick() {
    const now = Date.now();
    if (now - this.lastOccupantAt < OCCUPANT_POLL_MS) return;
    const watched = [...this.sessions.values()].filter((s) => s.paneId && s.occupant === 'agent');
    if (!watched.length) return;
    this.lastOccupantAt = now;
    let panes;
    try {
      panes = core.tmuxPanes({ onWarn: (m) => this.log(m) });
    } catch (e) {
      // #68 again: a mangled list is not an empty one, and it is CERTAINLY not
      // "claude exited" on every share at once.
      this.log(`occupant poll: pane list unreadable (${e.message}) — no mode is flipped on an unanswerable question`);
      return;
    }
    const byId = new Map(panes.map((p) => [p.paneId, p]));
    for (const s of watched) {
      const pane = byId.get(s.paneId);
      // A pane that is GONE is the heartbeat's job (r6-6: ended loudly, never
      // rebound) — absence must never read as "the harness exited".
      if (!pane) continue;
      if (!isHarnessCommand(pane.cmd)) {
        this.setOccupant(s, 'term', `claude exited — terminal (${pane.cmd || 'shell'})`);
      }
    }
  }

  // --- the computer lane (v2 §17) ------------------------------------------

  computerAad(field) {
    return core.e2eAad(this.env.channelId, core.COMPUTER_ANCHOR, field);
  }

  sealComputerFrame(obj) {
    return core.e2eEncryptBlob(this.key, this.computerAad('computer_meta'),
      Buffer.from(JSON.stringify(obj), 'utf8')).toString('base64url');
  }

  // An ActionCable `perform` on the computer subscription. Returns false when
  // there is no live socket — the caller narrates; nothing here retries, because
  // a computer_meta frame is ephemeral by contract (a lost one costs one cheap
  // re-request).
  performComputer(action, data = {}) {
    if (!this.ws || this.ws.readyState !== 1 || !this.computerConfirmed) return false;
    try {
      this.ws.send(JSON.stringify({
        command: 'message', identifier: COMPUTER_IDENT, data: JSON.stringify({ ...data, action }),
      }));
      return true;
    } catch (e) {
      this.log(`computer lane: perform ${action} failed (${e.message})`);
      return false;
    }
  }

  // Every meta frame goes through here so the SERVER'S cap (32 KB measured on
  // the base64url string) is enforced on THIS side first — an over-cap frame is
  // dropped by the relay in silence, which is exactly the failure #65 forbids.
  publishMeta(payload, why) {
    let frame;
    try {
      frame = this.sealComputerFrame(payload);
    } catch (e) {
      this.log(`computer lane: could not seal the ${payload.kind} frame (${e.message}) — ${why}`);
      return false;
    }
    const bytes = Buffer.byteLength(frame, 'utf8');
    if (bytes > core.COMPUTER_META_MAX_BYTES) {
      this.log(`computer lane: ${payload.kind} frame is ${bytes}B > the ${core.COMPUTER_META_MAX_BYTES}B relay cap — NOT sent (${why})`);
      return false;
    }
    const sent = this.performComputer('meta', { frame });
    if (!sent) this.log(`computer lane: ${payload.kind} frame not sent — the computer subscription is not confirmed (${why})`);
    return sent;
  }

  // The capabilities frame (PINNED shape — iOS builds against it, spec §17):
  // {kind:"caps", epoch, remote_spawn, inventory, hostname, os}.
  //
  // `epoch` is MANDATORY and it is the reason this frame is re-published on
  // every viewer_joined: with ZERO shared panes there is no agent_meta anywhere
  // for the viewer to learn the daemon epoch from, and "paired computer, zero
  // panes, spawn from bed" is the Phase-A target flow. The caps frame IS the
  // viewer's epoch source, so a fresh one must always precede the first sealed
  // computer_req (whose `he` this daemon checks against exactly this number).
  capsPayload() {
    const grants = core.loadGrants();
    return {
      kind: 'caps',
      epoch: this.state.epoch,
      remote_spawn: grants.remote_spawn,
      inventory: grants.inventory,
      hostname: os.hostname(),
      os: core.computerOs(),
    };
  }

  publishCaps(why) {
    return this.publishMeta(this.capsPayload(), why);
  }

  // A viewer_joined nudge is UNSEALED and forgeable-innocuous by design (§17):
  // the worst it can buy is a re-published sealed frame. Debounced so N phones
  // (or one reconnecting phone) cannot turn it into a frame storm.
  onViewerJoined() {
    this.lastViewerJoinAt = Date.now();
    // A viewer is LOOKING: anything it queued while this daemon was busy (or
    // down) should not wait out the poll interval. The cable is the wake-up,
    // the queue stays the ledger (#39) — see kickDrain.
    this.kickDrain('a viewer joined');
    if (this.capsTimer) return; // a publish is already coming for this burst
    this.capsTimer = setTimeout(() => {
      this.capsTimer = null;
      this.publishCaps('a viewer joined');
    }, this.viewerDebounceMs);
    if (this.capsTimer.unref) this.capsTimer.unref();
  }

  // The only wake-up the Phase-A wire offers. The ComputerChannel carries NO
  // "a command is waiting" frame (verified against
  // server/app/channels/computer_channel.rb — it relays request/meta and
  // touches presence, nothing else), so DRAIN_POLL_MS remains the mechanism;
  // this just makes the daemon hot exactly while a human is interacting with
  // it. Floored so a nudge storm can never become a GET /messages storm.
  kickDrain(why) {
    const now = Date.now();
    if (now - (this.lastKickAt || 0) < DRAIN_KICK_FLOOR_MS) return;
    this.lastKickAt = now;
    this.log(`draining the command queue now — ${why}`);
    this.drainTick();
  }

  // viewer→daemon, sealed under the `computer_req` lane. The op set is CLOSED:
  // Phase A has `inventory` and nothing else. Replay defense is the input
  // lane's, verbatim (§8/B4): vgen + per-vgen monotonic seq + the mandatory
  // epoch echo, on a COMPUTER-scoped ledger.
  handleComputerRequest(frameB64) {
    let msg;
    try {
      const sealed = Buffer.from(String(frameB64 || ''), 'base64url');
      if (sealed.length > core.COMPUTER_REQUEST_MAX_BYTES) throw new Error(`frame is ${sealed.length}B, over the ${core.COMPUTER_REQUEST_MAX_BYTES}B cap`);
      const plain = core.e2eDecryptBlob(this.key, this.computerAad('computer_req'), sealed);
      msg = JSON.parse(plain.toString('utf8'));
    } catch (e) {
      this.log(`computer request rejected (${e.message})`);
      return;
    }
    if (!msg || typeof msg.op !== 'string' || !msg.vgen || !Number.isInteger(msg.seq) || !Number.isInteger(msg.he)) {
      this.log('computer request missing op/vgen/seq/he — dropped');
      return;
    }
    if (msg.he !== this.state.epoch) {
      this.log(`computer request from epoch ${msg.he} (current ${this.state.epoch}) — pre-restart ciphertext, dropped`);
      return;
    }
    const ledgerKey = `${core.COMPUTER_ANCHOR}|${msg.vgen}`;
    const last = this.replay.get(ledgerKey) || 0;
    if (msg.seq <= last) { this.log(`computer request replay (seq ${msg.seq} ≤ ${last}) — dropped`); return; }
    this.replay.set(ledgerKey, msg.seq);

    if (msg.op !== 'inventory') {
      // Degrade LOUDLY (#33): an unknown op is dropped and said out loud, never
      // guessed at and never silently swallowed.
      this.log(`computer request: unknown op ${JSON.stringify(msg.op)} — DROPPED (the Phase A op set is closed to "inventory"; durable commands ride the message queue, never this lane)`);
      return;
    }
    this.answerInventory();
  }

  // The sealed pane inventory (§17). NEVER persisted — gathered on demand,
  // sealed, relayed, forgotten. The grant is read at ANSWER time, so turning it
  // off takes effect on the very next ask.
  answerInventory() {
    const grants = core.loadGrants();
    if (!grants.inventory) {
      this.log('inventory asked while the machine grant is OFF — answering with capabilities instead (the phone renders only granted affordances)');
      this.publishCaps('inventory is not granted on this computer');
      return;
    }
    let panes;
    try {
      panes = core.tmuxPanes({ onWarn: (m) => this.log(m) });
    } catch (e) {
      this.log(`inventory: the pane list came back mangled (${e.message}) — answering with capabilities, never with a false "no panes"`);
      this.publishCaps('the pane list could not be read');
      return;
    }
    // `shared` is the share's PUBLIC_ID or null (§17) — never a bool: the
    // picker gets "already shared → open that pane" deep-linking for free, and
    // a bool would make the phone ask a second question to do anything with it.
    const rows = panes.map((p) => {
      const share = this.shareForPaneId(p.paneId);
      return {
        pane_id: p.paneId,
        cwd: p.path || null,
        loc: p.loc || null,
        current_command: p.cmd || null,
        shared: share ? share.publicId : null,
      };
    });
    this.publishInventory(rows);
  }

  // #65 DNA: degrade INSIDE the cap BEFORE sending. The list shrinks (newest
  // pane ids first is meaningless here — tmux order is stable, so the head is
  // kept) and `truncated:true` tells the phone the list is partial. An
  // over-cap frame is NEVER sent.
  publishInventory(rows) {
    let list = rows;
    let truncated = false;
    for (;;) {
      const payload = { kind: 'inventory', panes: list, truncated };
      let frame;
      try {
        frame = this.sealComputerFrame(payload);
      } catch (e) {
        this.log(`inventory: seal failed (${e.message}) — nothing sent`);
        return false;
      }
      if (Buffer.byteLength(frame, 'utf8') <= core.COMPUTER_META_MAX_BYTES) {
        if (truncated) this.log(`inventory: degraded to ${list.length}/${rows.length} pane(s) to fit the ${core.COMPUTER_META_MAX_BYTES}B relay cap — sent with truncated:true`);
        const sent = this.performComputer('meta', { frame });
        if (!sent) this.log('inventory: the computer subscription is not confirmed — frame not sent');
        return sent;
      }
      if (!list.length) {
        // Structurally impossible (an empty list seals to ~100 B) but the rule
        // is the rule: never send over-cap, never loop.
        this.log('inventory: even an EMPTY pane list does not fit the relay cap — nothing sent (loud)');
        return false;
      }
      truncated = true;
      list = list.slice(0, Math.floor(list.length / 2));
    }
  }

  // Computer-level narration (§17: "every command's outcome is narrated"). Used
  // when there is no share to carry a notice — a refusal, an unknown op, a
  // spawn that never got as far as a pane.
  narrateComputer(text) {
    this.log(`computer command: ${text}`);
    this.publishMeta({ kind: 'notice', text, at: nowIso() }, 'command narration');
    return false;
  }

  // --- durable computer commands (§17: the message queue, lane computer_cmd) -

  // Open a queue row under the `computer_cmd` lane, anchored on THAT row's cid
  // (a consumed spawn can never replay). Returns null for anything that is not
  // ours — a row we cannot open is never acked and never acted on.
  openComputerCmd(row) {
    if (!row || !row.enc || !row.correlation_id) return null;
    const aad = core.e2eAad(this.env.channelId, row.correlation_id, 'computer_cmd');
    const body = String(row.body || '');
    let plain = null;
    try {
      // Two carriers are accepted on purpose: the message `body` is an ordinary
      // string param, so the natural sealing is the "v1:" FIELD envelope every
      // other string field uses; a base64url blob is tolerated because the spec
      // pins the LANE, not the framing (see the PR notes).
      plain = body.startsWith('v1:')
        ? core.e2eDecryptField(this.key, aad, body)
        : core.e2eDecryptBlob(this.key, aad, Buffer.from(body, 'base64url')).toString('utf8');
    } catch { return null; }
    try {
      const obj = JSON.parse(plain);
      return obj && typeof obj === 'object' && typeof obj.op === 'string' ? obj : null;
    } catch { return null; }
  }

  async drainTick() {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.drainOnce();
    } catch (e) {
      this.log(`computer command drain failed (${e.message}) — the rows stay on the queue, the next tick retries`);
    } finally {
      this.draining = false;
    }
  }

  async drainOnce() {
    const { res, data } = await this.api('GET', '/messages');
    if (res.status !== 200) {
      // Throttled, but never silent: a 401 here means the tunnel key is dead.
      if (Date.now() - this.drainWarnedAt > 300_000) {
        this.drainWarnedAt = Date.now();
        this.log(`computer command drain → ${res.status} — no command from the phone can arrive while this lasts`);
      }
      return;
    }
    const rows = Array.isArray(data && data.messages) ? data.messages : [];
    const ackIds = [];
    for (const row of rows) {
      const cmd = this.openComputerCmd(row);
      if (!cmd) {
        // NOT ours. A row this daemon cannot open is left on the queue —
        // eating a human's message to keep our own polling quiet is the
        // trade this feature does not get to make.
        if (!this.foreignMsgIds.has(row.id)) {
          this.foreignMsgIds.add(row.id);
          this.log(`queue row ${row.id} does not open under the computer_cmd lane — LEFT on the queue (not acked, not acted on)`);
        }
        continue;
      }
      if (this.handledCmdIds.has(Number(row.id))) {
        // At-least-once (#39): a lost ack re-serves a command whose effect is
        // already on this computer. Ack it again, run it never.
        ackIds.push(row.id);
        continue;
      }
      try {
        await this.runComputerCommand(cmd, row);
      } catch (e) {
        this.narrateComputer(`"${cmd.op}" failed: ${e.message}`);
      }
      // Noted (and persisted) BEFORE the ack: a crash between the two costs a
      // duplicate ack, never a duplicate spawn.
      this.noteHandledCmd(row.id);
      ackIds.push(row.id);
    }
    if (ackIds.length) {
      const { res: ackRes } = await this.api('POST', '/messages/ack', { ids: ackIds });
      if (ackRes.status < 200 || ackRes.status >= 300) {
        this.log(`computer command ack → ${ackRes.status} for ${JSON.stringify(ackIds)} — the rows re-serve; the dedup ring keeps the effect once`);
      }
    }
  }

  async runComputerCommand(cmd, row) {
    switch (cmd.op) {
      case 'spawn': return this.cmdSpawn(cmd);
      case 'capture': return this.cmdCapture(cmd);
      case 'kill_share': return this.cmdKillShare(cmd);
      default:
        // Ack + a loud log (§17) — and the phone hears about it too.
        return this.narrateComputer(`unknown op ${JSON.stringify(cmd.op)} on message ${row && row.id} — acked and ignored (this computer speaks spawn, capture, kill_share)`);
    }
  }

  // `tmux new-window -d` in the daemon's own `pidge` session, created detached
  // if it does not exist. `-P -F '#{pane_id}'` makes the new pane's id the
  // command's OUTPUT — no matching, no guessing which pane was just made.
  spawnPane(cwd) {
    const where = cwd ? ['-c', cwd] : [];
    let exists = true;
    try {
      core.tmuxExec(['has-session', '-t', SPAWN_TMUX_SESSION], { stdio: 'ignore' });
    } catch { exists = false; }
    const out = exists
      ? core.tmuxExec(['new-window', '-d', '-t', `${SPAWN_TMUX_SESSION}:`, '-P', '-F', '#{pane_id}', ...where], { encoding: 'utf8' })
      : core.tmuxExec(['new-session', '-d', '-s', SPAWN_TMUX_SESSION, '-P', '-F', '#{pane_id}', ...where], { encoding: 'utf8' });
    return String(out || '').trim();
  }

  async cmdSpawn(cmd) {
    const template = cmd.template === 'claude' ? 'claude' : 'shell';
    if (!core.loadGrants().remote_spawn) {
      // A refusal is NARRATED, never silent (§17) — and it says exactly which
      // machine-side line opens the door.
      return this.narrateComputer(`REFUSED a remote ${template} spawn: this computer does not grant it. Turn it on here with \`pidge terminal config remote_spawn on\`.`);
    }
    const cwd = typeof cmd.cwd === 'string' && cmd.cwd ? cmd.cwd : null;
    let paneId;
    try {
      paneId = this.spawnPane(cwd);
    } catch (e) {
      return this.narrateComputer(`could not spawn a pane${cwd ? ` in ${cwd}` : ''}: ${e.message}`);
    }
    if (!/^%\d+$/.test(paneId)) {
      return this.narrateComputer(`tmux did not return a pane id for the spawn (got ${JSON.stringify(paneId)}) — nothing was shared`);
    }
    let s;
    try {
      s = await this.sharePane({
        paneId, cwd, occupant: 'term',
        // Consent by construction: the sealed command came from the owner's
        // phone and the server cannot forge it.
        why: `spawned from your phone (${template})`,
      });
    } catch (e) {
      return this.narrateComputer(`spawned pane ${paneId} but could not share it: ${e.message}`);
    }
    if (template === 'claude') {
      try {
        // send-keys, deliberately: the harness is NOT wrapped — its own
        // SessionStart hook is what flips this share to `agent`.
        this.sendLiteral(paneId, 'claude');
        core.tmuxExec(['send-keys', '-t', paneId, 'Enter']);
        this.narrateShare(s, 'claude is starting in this pane…', 'spawn-claude');
      } catch (e) {
        this.narrateShare(s, `could not start claude in this pane (${e.message}) — it stays a plain terminal`, 'spawn-failed');
      }
    }
    this.narrateComputer(`spawned a ${template} pane (${paneId}) and shared it as ${s.publicId}`);
    return s;
  }

  async cmdCapture(cmd) {
    const paneId = typeof cmd.pane_id === 'string' ? cmd.pane_id : null;
    const out = await this.shareExistingPane(paneId, { by: 'your phone' });
    if (!out.ok) return this.narrateComputer(`could not capture ${paneId || '(no pane_id)'}: ${out.error}`);
    this.narrateComputer(`captured pane ${out.pane_id}${out.loc ? ` (${out.loc})` : ''} as ${out.public_id} in ${out.mode} mode`);
    return out;
  }

  async cmdKillShare(cmd) {
    const publicId = typeof cmd.public_id === 'string' ? cmd.public_id : null;
    const s = publicId && this.shareForPublicId(publicId);
    if (!s) return this.narrateComputer(`kill_share: ${publicId || '(no public_id)'} is not shared from this computer — nothing to end`);
    // The seam BEFORE the end: the last thing the transcript says is why it
    // stopped (§11 — a mirror must never just go quiet).
    this.narrateShare(s, 'sharing ended from your phone', 'kill-share');
    try { await this.flush(s); } catch { /* the end is unconditional */ }
    const res = await this.disableSession(s.sid, 'kill_share from the phone');
    this.narrateComputer(`ended the share ${publicId}${res.server_ok ? '' : ` LOCALLY (the server was not told: ${res.detail || 'unreachable'})`}`);
    return res;
  }

  // --- cable input lane (spec §8) ------------------------------------------

  subscribeInput(session) {
    this.ensureCable();
    if (this.ws && this.ws.readyState === 1) this.sendSubscribe(session);
  }

  identifierFor(session) {
    return JSON.stringify({ channel: 'AgentSessionChannel', public_id: session.publicId });
  }

  ensureCable() {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    if (typeof WebSocket === 'undefined') {
      if (!this.cableDownSince) this.cableDownSince = Date.now();
      this.log('WARNING: no native WebSocket (Node <22) — the input lane is OFF; transcripts still publish');
      return;
    }
    if (Date.now() < this.wsRetryAt) return; // backoff window — the watchdog re-calls forever
    const gen = ++this.wsGen;
    const url = this.env.base.replace(/^http/, 'ws') + '/cable';
    const ws = new WebSocket(url, ['actioncable-v1-json', this.env.token]);
    this.ws = ws;
    this.wsLastBeat = Date.now();
    this.wsAttemptAt = Date.now();
    this.wsConfirmed = false;
    // The lane is DOWN from the moment we need a (re)connect until the server
    // confirms a subscription — an open-but-unconfirmed socket is not "up".
    if (!this.cableDownSince) this.cableDownSince = Date.now();
    ws.onopen = () => {
      if (gen !== this.wsGen) return ws.close(); // superseded (#66)
      this.log('cable up — subscribing the computer lane + input lanes');
      // The COMPUTER subscription first: it is the one this socket exists for
      // even with zero shared panes (v2 §17, always-on).
      this.sendComputerSubscribe();
      for (const s of this.sessions.values()) this.sendSubscribe(s);
    };
    ws.onmessage = (ev) => {
      if (gen !== this.wsGen) return;
      this.wsLastBeat = Date.now();
      let frame; try { frame = JSON.parse(ev.data); } catch { return; }
      if (frame.type === 'confirm_subscription') { this.noteCableConfirmed(frame.identifier); return; }
      if (frame.type === 'ping' || frame.type === 'welcome') return;
      if (frame.type === 'reject_subscription') {
        if (this.isComputerIdentifier(frame.identifier)) {
          // Said ONCE, and said properly: the server rejects this subscription
          // only when the channel is not a tunnel or its E2E was turned off —
          // neither is something a retry fixes.
          if (!this.computerRejected) {
            this.computerRejected = true;
            this.log('computer subscription REJECTED by the server — this key is not a tunnel with E2E on. The phone will show this computer offline and no capabilities/inventory frame can be published (transcripts and input for existing shares are unaffected).');
          }
          return;
        }
        this.log('input subscription rejected:', frame.identifier);
        return;
      }
      if (!frame.message || !frame.identifier) return;
      let ident; try { ident = JSON.parse(frame.identifier); } catch { return; }
      if (ident && ident.channel === 'ComputerChannel') {
        // Server → daemon on the computer lane (§17): a sealed request, or the
        // unsealed viewer nudge. Presence frames ride the viewer side only.
        if (frame.message.type === 'request') this.handleComputerRequest(frame.message.frame);
        else if (frame.message.type === 'viewer_joined') this.onViewerJoined();
        return;
      }
      if (frame.message.type === 'input') {
        const session = [...this.sessions.values()].find((s) => s.publicId === ident.public_id);
        if (session) this.handleInputFrame(session, frame.message.frame);
      }
    };
    ws.onclose = () => {
      if (gen !== this.wsGen) return; // an old socket's goodbye must not touch the live one (#66)
      this.ws = null;
      this.cableRetry('socket closed'); // never a silent stand-down (r6-3)
    };
    ws.onerror = () => {};
  }

  isComputerIdentifier(identifier) {
    try { return JSON.parse(identifier).channel === 'ComputerChannel'; } catch { return false; }
  }

  // The server confirmed a subscription on the CURRENT socket — this, not
  // onopen, is what "the cable is up" means (QA r6-3: the watchdog must VERIFY
  // the reconnect, not fire it and assume).
  noteCableConfirmed(identifier) {
    if (this.isComputerIdentifier(identifier) && !this.computerConfirmed) {
      this.computerConfirmed = true;
      this.computerRejected = false;
      this.log('computer lane confirmed — publishing capabilities');
      // Fresh caps on every (re)subscribe: a phone that was looking while the
      // socket was down gets the truth without asking.
      this.publishCaps('the computer subscription was confirmed');
    }
    if (this.wsConfirmed) return;
    this.wsConfirmed = true;
    const hadFailures = (this.wsBackoff || 0) > 0;
    this.wsBackoff = 0;
    this.wsRetryAt = 0;
    if (this.cableDownSince) {
      const downS = Math.round((Date.now() - this.cableDownSince) / 1000);
      // Narrated whenever the down period was real (a failure happened or it
      // lasted); the subsecond first-boot connect stays quiet — "cable up —
      // subscribing input lanes" already covers it.
      if (hadFailures || downS > 0) this.log(`cable RESTORED — input lane confirmed after ${downS}s down`);
    }
    this.cableDownSince = null;
  }

  // A cable attempt failed or a live socket died: mark the lane DOWN, say so
  // LOUDLY, and arm the next attempt on an exponential backoff (capped). The
  // watchdog tick re-calls ensureCable on its own clock, so recovery never
  // depends on a socket callback that may never fire — the exact state the
  // r6-3 outage wedged in (a reconnect fired once, never verified, never
  // retried, while the read mirror kept looking healthy for 4 hours).
  cableRetry(why) {
    if (!this.cableDownSince) this.cableDownSince = Date.now();
    this.wsConfirmed = false;
    this.computerConfirmed = false; // a new socket must be re-confirmed, never assumed
    this.wsBackoff = Math.min(Math.max((this.wsBackoff || 0) * 2, 5), CABLE_BACKOFF_CAP_S);
    this.wsRetryAt = Date.now() + this.wsBackoff * 1000;
    const downS = Math.round((Date.now() - this.cableDownSince) / 1000);
    this.log(`cable DOWN (${why}) — input lane dead for ${downS}s; next attempt in ≤${this.wsBackoff}s (the watchdog insists forever, never one-shot)`);
  }

  // Abandon a socket the watchdog gave up on. The gen bump makes every one of
  // its callbacks a no-op (#66) — including a close() that never completes.
  abandonSocket(ws, why) {
    this.wsGen += 1;
    try { ws.close(); } catch {}
    if (this.ws === ws) this.ws = null;
    this.cableRetry(why);
    this.ensureCable(); // honors the backoff window; the next tick retries otherwise
  }

  // The input lane's honest state — surfaced on GET /health so `terminal
  // status` can say `cable: up | DOWN since <T>` (QA r6-3: a daemon with a
  // dead input lane may not present as healthy).
  cableState() {
    const up = !!(this.ws && this.ws.readyState === 1 && this.wsConfirmed);
    return {
      up,
      // v2 §17: the socket is ALWAYS wanted while this computer is connected —
      // the ComputerChannel subscription (presence, capabilities, inventory)
      // does not need a single shared pane to exist.
      wanted: true,
      down_since: up || !this.cableDownSince ? null : new Date(this.cableDownSince).toISOString(),
      // Reported per LANE (#72): an input lane that is up while the COMPUTER
      // subscription was rejected is a half-working computer, and saying "up"
      // for it would be the exact class of lie that ledger exists to stop.
      computer: !!(up && this.computerConfirmed),
    };
  }

  sendSubscribe(session) {
    try {
      this.ws.send(JSON.stringify({ command: 'subscribe', identifier: this.identifierFor(session) }));
    } catch {}
  }

  // The computer's own subscription — NO params (the tunnel key IS the
  // identity; the server rejects anything that is not a tunnel with E2E on).
  sendComputerSubscribe() {
    if (!this.ws || this.ws.readyState !== 1) return;
    try {
      this.ws.send(JSON.stringify({ command: 'subscribe', identifier: COMPUTER_IDENT }));
    } catch {}
  }

  handleInputFrame(session, frameB64) {
    let msg;
    try {
      const sealed = Buffer.from(String(frameB64), 'base64url');
      const plain = core.e2eDecryptBlob(this.key,
        core.e2eAad(this.env.channelId, session.publicId, 'agent_input'), sealed);
      msg = JSON.parse(plain.toString('utf8'));
    } catch (e) {
      this.log(`input frame rejected (${e.message})`);
      return;
    }
    // Replay ledger (B4): vgen + per-vgen monotonic seq + mandatory epoch echo.
    if (msg.t !== 'i' || !msg.vgen || !Number.isInteger(msg.seq) || !Number.isInteger(msg.he)) {
      this.log('input frame missing t/vgen/seq/he — dropped');
      return;
    }
    if (msg.he !== this.state.epoch) {
      this.log(`input frame from epoch ${msg.he} (current ${this.state.epoch}) — pre-restart ciphertext, dropped`);
      return;
    }
    const ledgerKey = `${session.publicId}|${msg.vgen}`;
    if (this.retiredVgens.has(ledgerKey)) return;
    const last = this.replay.get(ledgerKey) || 0;
    if (msg.seq <= last) { this.log(`input replay (seq ${msg.seq} ≤ ${last}) — dropped`); return; }
    this.replay.set(ledgerKey, msg.seq);

    if (!session.paneId) { this.log('input for a session with no bound pane — dropped'); return; }
    const alive = this.paneAlive(session.paneId);
    if (alive === false) {
      this.log(`bound pane ${session.paneId} is gone — ending session loudly (B2)`);
      this.disableSession(session.sid, 'pane died');
      return;
    }
    if (alive === null) {
      // Could not ASK tmux (daemon-side failure) — that is not a dead pane.
      // The input cannot be delivered, so say so loudly and keep the session.
      this.log(`input for ${session.sid.slice(0, 8)} DROPPED: pane check failed (daemon-side, tmux could not be asked) — NOT ending the session`);
      return;
    }
    if (!Array.isArray(msg.keys)) return;
    session.lastAliveAt = Date.now(); // delivered input = mirror life (diagnostic)
    for (const k of msg.keys.slice(0, 16)) {
      try {
        if (k && typeof k.lit === 'string' && k.lit.length) {
          this.sendLiteral(session.paneId, k.lit);
          session.waitingArmed = true; // input resets the waiting episode (spec §9)
        } else if (k && typeof k.key === 'string' && INPUT_KEYS.has(k.key)) {
          core.tmuxExec(['send-keys', '-t', session.paneId, k.key]);
        }
        // anything else: dropped whole (deliberately tiny allowlist)
      } catch (e) {
        this.log(`send-keys failed: ${e.message}`);
      }
    }
  }

  sendLiteral(paneId, text) {
    // core.tmuxExec carries a UTF-8 locale on every call (finding #10 defense
    // in depth): a service env without one makes tmux mangle non-ASCII.
    if (text.includes('\n')) {
      // Multiline rides a tmux buffer + bracketed paste (spec §8).
      const bufName = `pidge-${Date.now()}`;
      core.tmuxExec(['set-buffer', '-b', bufName, text]);
      core.tmuxExec(['paste-buffer', '-p', '-b', bufName, '-t', paneId, '-d']);
    } else {
      core.tmuxExec(['send-keys', '-t', paneId, '-l', text]);
    }
  }

  // Tri-state (PR #110 review): `true` = tmux answered and the pane is listed;
  // `false` = tmux RAN and the pane provably is not there (including a
  // non-zero exit — "no server running" means no panes exist, so the r6-6
  // dead-pane treatment applies); `null` = the exec itself failed (ENOENT,
  // EAGAIN, the 5 s timeout against a wedged server) — the daemon could not
  // ASK, and an unanswerable question must never read as "the pane is gone".
  // A transient EAGAIN ending N live sessions with a "pane is GONE" log is the
  // mis-blame family finding #10 killed; callers end sessions ONLY on `false`.
  paneAlive(paneId) {
    try {
      const out = core.tmuxExec(['list-panes', '-a', '-F', '#{pane_id}'], { encoding: 'utf8' });
      return out.split('\n').includes(paneId);
    } catch (e) {
      if (typeof e.status === 'number') return false; // tmux ran and answered "no" (no server ⇒ no panes)
      return null; // spawn/timeout failure — unknown, NOT "gone"
    }
  }

  // --- watchdog (B7) --------------------------------------------------------

  // REWRITTEN per QA r6-3 (the 4 h real outage). The old tick had a hole that
  // ate the input lane: a socket stuck in CONNECTING matched NEITHER branch
  // (`readyState > 1` false, `readyState === 1` false), so once a forced
  // reconnect produced a handshake that never completed and never errored,
  // every subsequent tick was a no-op — the retry machinery only re-armed from
  // socket callbacks that never fired. Now the watchdog VERIFIES on its own
  // clock: an attempt that has not reached CONFIRMED (open + subscribe
  // confirmation) within its deadline is abandoned loudly and retried with
  // backoff, forever.
  watchdogTick() {
    // v2 §17: no "only with ≥1 session" gate any more. While this computer is
    // connected the socket is WANTED — it carries the ComputerChannel
    // subscription (presence + capabilities + inventory) with zero shared panes.
    const ws = this.ws;
    if (!ws || ws.readyState > 1) { this.ensureCable(); return; }
    const now = Date.now();
    if (ws.readyState === 0) {
      // CONNECTING is an attempt, not health — it gets a deadline.
      if (now - this.wsAttemptAt > CABLE_CONFIRM_MS) {
        this.abandonSocket(ws, `connect attempt stuck ${Math.round((now - this.wsAttemptAt) / 1000)}s in CONNECTING`);
      }
      return;
    }
    // readyState === 1 (open). Open without a confirmed subscription is not an
    // input lane either — verify, don't assume (r6-3: "firing the reconnect is
    // not the job").
    if (!this.wsConfirmed && now - this.wsAttemptAt > CABLE_CONFIRM_MS) {
      this.abandonSocket(ws, 'socket open but the subscribe was never confirmed');
      return;
    }
    // Same discipline for the COMPUTER subscription (v2 §17): confirmed input
    // lanes on a socket whose computer lane never answered is not a healthy
    // computer — verify it, don't assume it. A server that REJECTED it is a
    // different thing (said once, above): retrying that forever would be a
    // reconnect loop against a permanent no.
    if (!this.computerConfirmed && !this.computerRejected && now - this.wsAttemptAt > CABLE_CONFIRM_MS) {
      this.abandonSocket(ws, 'the computer subscription was never confirmed');
      return;
    }
    if (now - this.wsLastBeat > CABLE_SILENT_MS) {
      // ActionCable pings every ~3s; 45s of silence = a dead socket that
      // doesn't know it. Prefer a spurious reconnect over a silent stand-down.
      this.log(`cable silent ${Math.round(CABLE_SILENT_MS / 1000)}s — forcing reconnect (watchdog)`);
      this.abandonSocket(ws, 'silent socket');
    }
  }

  // --- lifecycle ------------------------------------------------------------

  async run() {
    const cfg = core.readJson(core.DAEMON_FILE(), null);
    if (!cfg || !cfg.port || !cfg.token) throw new Error('daemon.json missing — run `pidge terminal connect`');
    this.startHookServer(cfg.port, cfg.token);
    await this.rearmPersisted();
    // ALWAYS-ON (v2 §17): the socket comes up because this computer is
    // connected, not because something is shared.
    this.ensureCable();
    this.timers = [
      setInterval(() => this.tailTick(), TAIL_POLL_MS),
      setInterval(() => this.flushTick(), FLUSH_MS),
      setInterval(() => this.heartbeatTick(), HEARTBEAT_MS),
      setInterval(() => this.watchdogTick(), WATCHDOG_MS),
      // The durable command lane (§17). The ComputerChannel carries no
      // "a command is waiting" frame, so this interval IS how a spawn from the
      // phone arrives — see DRAIN_POLL_MS for why it is not a held poll.
      setInterval(() => this.drainTick(), DRAIN_POLL_MS),
    ];
    this.drainTick(); // don't make a command posted while the daemon was down wait a full tick
    const bye = async (code) => {
      this.log('daemon shutting down');
      for (const t of this.timers) clearInterval(t);
      // Sessions stay ENABLED in state (they re-arm on the next boot); the
      // server shows them offline via staleness — honest without a teardown race.
      process.exit(code);
    };
    process.on('SIGINT', () => bye(0));
    process.on('SIGTERM', () => bye(0));
    this.log(`pidge terminal daemon up — epoch ${this.state.epoch}, ${Object.keys(this.state.sessions).length} persisted session(s)`);
  }
}

// meta/privacy: strip daemon-internal fields before sealing/publishing.
function stripPrivate(item) {
  const { _publicId, ...rest } = item;
  return rest;
}

// The cadences are exported for the tests: §17 pins the presence beat at 30 s
// and the server's online window at 90 s, so a drift here is a wire bug.
module.exports = { Daemon, HEARTBEAT_MS, DRAIN_POLL_MS, DRAIN_KICK_FLOOR_MS };
