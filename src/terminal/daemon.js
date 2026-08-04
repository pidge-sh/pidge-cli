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
const HEARTBEAT_MS = 30_000;
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

function nowIso() { return new Date().toISOString(); }

class Daemon {
  constructor() {
    this.env = core.loadTerminalEnv();
    if (!this.env.token || !this.env.base || !this.env.secret || !this.env.channelId) {
      throw new Error('pidge terminal daemon: not connected — run `pidge terminal connect` first');
    }
    this.key = core.e2eParseSecret(this.env.secret);
    this.caps = core.loadCaps();
    this.state = core.readJson(core.STATE_FILE(), { epoch: 0, sessions: {} });
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
    this.logStream = null;
    this.exit = (code) => process.exit(code); // injectable for tests (POST /shutdown)
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
    core.writeJson(core.STATE_FILE(), { epoch: this.state.epoch, sessions });
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
      sid: session.sid, // inside the sealed blob only — refreshed on /clear adoption (§6)
      harness: 'claude',
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
          const twin = this.findReplacedTwin(sid, { tty: core.normalizeTty(tty), cwd });
          if (twin) {
            const src = typeof source === 'string' && source ? source : null;
            if (src === 'clear' && tp && this.adoptReplacedSid(twin, sid, { tp, tty: core.normalizeTty(tty) })) {
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
        if (s) { s.lastAliveAt = Date.now(); this.setStatus(s, 'idle'); }
        return send(200, {});
      }
      case 'GET /sessions': {
        const now = Date.now();
        const ann = [...this.announces.entries()]
          .filter(([, a]) => now - a.at < HOOK_TTL_MS)
          .map(([sid, a]) => ({ sid, tty: a.tty, cwd: a.cwd, transcript_path: a.transcriptPath, at: a.at }));
        const enabled = [...this.sessions.values()].map((s) => ({
          sid: s.sid, public_id: s.publicId, pane_id: s.paneId, cwd: s.cwd, status: s.status,
        }));
        return send(200, { announces: ann, enabled });
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
    // ONE whose bound pane matches, never just the first cwd hit.
    const candidates = [...this.sessions.values()]
      .filter((s) => String(s.cwd || '').replace(/\/+$/, '') === want);
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

  // ADOPTION (spec §6, source-gated): the new sid joins the SAME AgentSession
  // — tailer switches to the new transcript, meta_sealed refreshes (the new
  // sid rides inside the sealed blob), seq stays monotonic, and a notice item
  // marks the seam. The caller has already established source:"clear" + a
  // positive pane+cwd match + a transcript_path. Returns false when the
  // adoption cannot take the writer lock — the caller then ends the old
  // session loudly.
  adoptReplacedSid(s, newSid, { tp, tty }) {
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
    s.tty = tty || null;
    if (tp) { s.file = tp; s.offset = 0; s.bulk = true; } // new transcript; §6 cap bounds the read, uuid dedup guards
    s.lastAliveAt = Date.now();
    this.sessions.set(newSid, s);
    // The seam, visible on the phone — never a silent splice (§11).
    try {
      const preview = 'restarted via /clear — mirror continued';
      const notice = {
        v: 1, uuid: `pidge-clear-${newSid.slice(0, 8)}-${Date.now()}`, parent: null,
        ts: nowIso(), role: 'system', kind: 'notice', preview,
        truncated: false, total_bytes: adapter.byteLen(preview),
        harness: 'claude', hv: s.hv || null, _publicId: s.publicId,
      };
      const b64 = this.sealItem(notice);
      if (b64 !== null) this.queuePush(s, notice.uuid, b64);
    } catch (e) {
      this.log(`${s.publicId}: could not seal the /clear seam notice (${e.message}) — adoption continues`);
    }
    this.persistSession(s);
    // Refresh the sealed meta (new sid inside the blob) — best-effort; the
    // heartbeat's status PATCH keeps flowing regardless.
    this.api('PATCH', `/agent_sessions/${s.publicId}`, { status: s.status, meta_sealed: this.sealMeta(s) })
      .catch((e) => this.log(`${s.publicId}: meta refresh after adoption failed (${e.message}) — retried by the next heartbeat era`));
    this.flush(s).catch((e) => this.log('flush error:', e.message));
    this.log(`session ${oldSid.slice(0, 8)} → ${newSid.slice(0, 8)} ADOPTED (source:"clear" in pane ${s.paneId}) — same AgentSession ${s.publicId}, seq continues, mirror unbroken`);
    return true;
  }

  // End a shared session that a NEW sid replaced but could NOT be adopted (the
  // cold-match path, finding #14): one final legible notice item to the phone,
  // then the normal disable (the server DELETE marks the row ended). Best-
  // effort on the notice; the end itself is unconditional — a frozen mirror
  // that looks alive is the bug.
  async endReplacedSession(s, newSid) {
    try {
      const preview = 'This session ended — /clear started a new one. Share the new session again to keep mirroring.';
      const notice = {
        v: 1, uuid: `pidge-ended-${s.sid.slice(0, 8)}-${Date.now()}`, parent: null,
        ts: nowIso(), role: 'system', kind: 'notice', preview,
        truncated: false, total_bytes: adapter.byteLen(preview),
        harness: 'claude', hv: s.hv || null, _publicId: s.publicId,
      };
      const b64 = this.sealItem(notice);
      if (b64 !== null) this.queuePush(s, notice.uuid, b64);
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
      publicId: `ases_${sid}`,
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
      publicId: s.publicId, paneId: s.paneId, tty: s.tty, cwd: s.cwd,
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
  }

  tailOne(s) {
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

  // The harness's permission mode rides every PreToolUse payload (Claude:
  // default | plan | acceptEdits | bypassPermissions) — read DEFENSIVELY, the
  // field can be absent on older harnesses, and absence is never a change.
  // A change refreshes meta_sealed so viewers see the current mode; the mode
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
    for (const s of [...this.sessions.values()]) { // a copy: the pane check may end sessions mid-walk
      if (!s.registered) continue; // flushTick owns the re-register retry
      // VERIFY the pane before re-affirming (QA r6-6). A dead pane used to be
      // detected only on input delivery, so the heartbeat kept PATCHing status
      // for a session whose pane was gone — last_seen_at stayed fresh, the
      // server's 90 s staleness never fired, and the phone read "waiting for
      // you" forever while its keys went into the void. The human had to FAIL
      // first for the system to admit it broke. One tmux call per session per
      // 30 s buys the honest answer; a vanished tmux server reads the same way
      // (paneAlive returns false when there are no panes to list) — with no
      // pane there is no session either way. Ended LOUDLY, now: log + DELETE
      // (disableSession), never waiting on input or staleness.
      if (s.paneId && !this.paneAlive(s.paneId)) {
        this.log(`${s.sid.slice(0, 8)}: bound pane ${s.paneId} is GONE — ending the session loudly (r6-6: a heartbeat must verify the pane, not re-affirm a corpse into "waiting for you" forever)`);
        await this.disableSession(s.sid, 'pane died (heartbeat liveness check)');
        continue;
      }
      // Carry the CURRENT status, never `{}`. The transition PATCH is
      // fire-and-forget: one dropped running→waiting used to leave the server
      // (and the phone) showing `running` until the NEXT transition — a session
      // that is actually waiting for the human, displayed as busy. The beat now
      // re-asserts it, so a lost transition self-heals within one cadence.
      await this.api('PATCH', `/agent_sessions/${s.publicId}`, { status: s.status })
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
      this.log('cable up — subscribing input lanes');
      for (const s of this.sessions.values()) this.sendSubscribe(s);
    };
    ws.onmessage = (ev) => {
      if (gen !== this.wsGen) return;
      this.wsLastBeat = Date.now();
      let frame; try { frame = JSON.parse(ev.data); } catch { return; }
      if (frame.type === 'confirm_subscription') { this.noteCableConfirmed(); return; }
      if (frame.type === 'ping' || frame.type === 'welcome') return;
      if (frame.type === 'reject_subscription') { this.log('input subscription rejected:', frame.identifier); return; }
      if (frame.message && frame.message.type === 'input' && frame.identifier) {
        let ident; try { ident = JSON.parse(frame.identifier); } catch { return; }
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

  // The server confirmed a subscription on the CURRENT socket — this, not
  // onopen, is what "the cable is up" means (QA r6-3: the watchdog must VERIFY
  // the reconnect, not fire it and assume).
  noteCableConfirmed() {
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
      wanted: this.sessions.size > 0,
      down_since: up || !this.cableDownSince ? null : new Date(this.cableDownSince).toISOString(),
    };
  }

  sendSubscribe(session) {
    try {
      this.ws.send(JSON.stringify({ command: 'subscribe', identifier: this.identifierFor(session) }));
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
    if (!this.paneAlive(session.paneId)) {
      this.log(`bound pane ${session.paneId} is gone — ending session loudly (B2)`);
      this.disableSession(session.sid, 'pane died');
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

  paneAlive(paneId) {
    try {
      const out = core.tmuxExec(['list-panes', '-a', '-F', '#{pane_id}'], { encoding: 'utf8' });
      return out.split('\n').includes(paneId);
    } catch { return false; }
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
    if (this.sessions.size === 0) return;
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
    this.timers = [
      setInterval(() => this.tailTick(), TAIL_POLL_MS),
      setInterval(() => this.flushTick(), FLUSH_MS),
      setInterval(() => this.heartbeatTick(), HEARTBEAT_MS),
      setInterval(() => this.watchdogTick(), WATCHDOG_MS),
    ];
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

module.exports = { Daemon };
