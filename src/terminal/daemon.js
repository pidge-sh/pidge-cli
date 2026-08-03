'use strict';
// The pidge terminal daemon (agent-sessions-spec §1/§2/§8/§9/§11).
//
// One per Mac (launchd), owns: the loopback hook endpoint (SessionStart/
// PreToolUse/Notification/Stop announce to it — LOCAL ONLY, publishing is
// gated per-session by the explicit enable), the JSONL tailers for ENABLED
// sessions, the sealed publisher, status heartbeats, the waiting→notification
// edge, and the cable input lane (sealed frames → tmux send-keys into the
// BOUND pane). Consent boundary = capability boundary: nothing about a
// session leaves this Mac before `pidge terminal enable`, and everything
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
const { execFileSync } = require('child_process');
const core = require('./core');
const adapter = require('./adapter-claude');

const HOOK_TTL_MS = 24 * 3600 * 1000;   // announce map entries age out (spec §2)
const TAIL_POLL_MS = 400;
const FLUSH_MS = 500;
const HEARTBEAT_MS = 30_000;
const WATCHDOG_MS = 15_000;
const BACKFILL_ITEMS = 100;             // spec §6
const BACKFILL_SEALED_BYTES = 512 * 1024;
const INPUT_KEYS = new Set(['Enter', 'Escape', 'Up', 'Down', 'Tab', 'BTab', 'C-c']);

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
    this.state.epoch = (this.state.epoch || 0) + 1; // new epoch per process (B4)
    this.saveState();
    this.announces = new Map();  // sid → {tty, cwd, transcriptPath, at}
    this.sessions = new Map();   // sid → live session record (see enable)
    this.ws = null;              // one cable socket, N subscriptions
    this.wsGen = 0;              // identity guard for reconnects (#66)
    this.wsLastBeat = 0;
    this.replay = new Map();     // `${publicId}|${vgen}` → last seq
    this.retiredVgens = new Set();
    this.logStream = null;
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
      harness: 'claude',
      harness_version: session.hv || null,
      tmux: { pane_id: session.paneId },
      epoch: this.state.epoch,
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
      throw new Error(`register ${session.publicId} → ${res.status} ${JSON.stringify(data)}`);
    }
    return data.session; // {last_seq, …} — the continue-point
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
        return send(200, { ok: true, epoch: this.state.epoch, enabled: [...this.sessions.keys()] });
      case 'POST /hook/session-start': {
        const { session_id: sid, cwd, transcript_path: tp, tty } = body;
        if (!sid) return send(200, {});
        this.announces.set(sid, { tty: tty || null, cwd: cwd || null, transcriptPath: tp || null, at: Date.now() });
        const s = this.sessions.get(sid);
        if (s && tp && tp !== s.file) {
          // /clear+resume rotation: same sid, new file — SAME AgentSession (spec §6).
          this.log(`session ${sid.slice(0, 8)}: transcript rotated → ${path.basename(tp)}`);
          s.file = tp; s.offset = 0; s.partial = ''; // uuid dedup absorbs the re-read
          this.persistSession(s);
        }
        return send(200, {});
      }
      case 'POST /hook/pre-tool-use': {
        const sid = body.session_id;
        const s = sid && this.sessions.get(sid);
        if (s) this.setStatus(s, 'running');
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
          this.setStatus(s, 'waiting');
          this.maybeNotifyWaiting(s, String(body.message || 'Waiting for your input')).catch((e) => this.log('notify failed:', e.message));
        }
        return send(200, {});
      }
      case 'POST /hook/stop': {
        const sid = body.session_id;
        const s = sid && this.sessions.get(sid);
        if (s) this.setStatus(s, 'idle');
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
      case 'POST /enable':
        return this.enableFromRequest(body, send);
      case 'POST /disable': {
        const targets = body.all ? [...this.sessions.keys()] : [body.sid].filter(Boolean);
        for (const sid of targets) await this.disableSession(sid, 'requested');
        return send(200, { disabled: targets });
      }
      default:
        return send(404, {});
    }
  }

  // --- enable / disable -----------------------------------------------------

  async enableFromRequest(body, send) {
    const { tty, cwd, pane_id: paneId, sid: explicitSid, approvals } = body;
    let sid = explicitSid || null;
    if (!sid && tty) {
      const now = Date.now();
      const hits = [...this.announces.entries()]
        .filter(([, a]) => now - a.at < HOOK_TTL_MS && a.tty === tty)
        .sort((a, b) => b[1].at - a[1].at);
      if (hits.length === 0) {
        return send(422, { error: 'no announced session on this tty — restart claude inside the tmux pane (the SessionStart hook announces it), then retry' });
      }
      sid = hits[0][0]; // newest announce on the tty — a new claude re-announces
    }
    if (!sid) return send(422, { error: 'need sid or tty' });
    const ann = this.announces.get(sid);
    if (!ann || !ann.transcriptPath) {
      return send(422, { error: `session ${sid.slice(0, 8)} has no announced transcript path — restart claude and retry` });
    }
    if (this.sessions.has(sid)) {
      const s = this.sessions.get(sid);
      return send(200, { already: true, public_id: s.publicId });
    }
    try {
      const s = await this.enableSession({
        sid, paneId: paneId || null, tty: ann.tty, cwd: cwd || ann.cwd,
        file: ann.transcriptPath, approvals: Array.isArray(approvals) ? approvals : [],
      });
      return send(200, { public_id: s.publicId, backfilled: s.backfilled });
    } catch (e) {
      this.log('enable failed:', e.message);
      return send(502, { error: e.message });
    }
  }

  async enableSession({ sid, paneId, tty, cwd, file, approvals }) {
    this.acquireWriterLock(sid); // B3 — refuse loudly on conflict
    try {
      return await this.enableSessionLocked({ sid, paneId, tty, cwd, file, approvals });
    } catch (e) {
      this.releaseWriterLock(sid); // a failed enable must not strand the lock
      throw e;
    }
  }

  async enableSessionLocked({ sid, paneId, tty, cwd, file, approvals }) {
    const session = {
      sid,
      publicId: `ases_${sid}`,
      paneId, tty, cwd, file,
      title: path.basename(cwd || 'session'),
      hv: null,
      offset: 0, partial: '',
      seenUuids: new Set(),
      queue: [], nextSeq: 1,
      status: 'idle', waitingArmed: true,
      approvals: approvals || [],
      flushing: false, backfilled: 0,
      gen: 0, // teardown identity (#66)
    };
    const echo = await this.registerSession(session, 'idle');
    session.nextSeq = (echo.last_seq || 0) + 1;
    this.sessions.set(sid, session);
    this.persistSession(session);
    await this.backfill(session);
    this.subscribeInput(session);
    this.log(`enabled ${sid.slice(0, 8)} → ${session.publicId} (pane ${paneId || 'NONE — read-only'}, seq from ${session.nextSeq})`);
    return session;
  }

  persistSession(s) {
    this.state.sessions[s.sid] = {
      publicId: s.publicId, paneId: s.paneId, tty: s.tty, cwd: s.cwd,
      file: s.file, offset: s.offset, nextSeq: s.nextSeq, approvals: s.approvals,
    };
    this.saveState();
  }

  async disableSession(sid, why) {
    const s = this.sessions.get(sid);
    if (!s) { delete this.state.sessions[sid]; this.saveState(); return; }
    s.gen += 1; // invalidate every outstanding async callback (#66)
    this.sessions.delete(sid);
    delete this.state.sessions[sid];
    this.saveState();
    this.releaseWriterLock(sid);
    try { await this.api('DELETE', `/agent_sessions/${s.publicId}`); } catch {}
    this.log(`disabled ${sid.slice(0, 8)} (${why})`);
  }

  // On boot: re-arm persisted sessions (daemon restart must not silently
  // disable a share the user opted into — the epoch bump invalidates any
  // pre-restart input ciphertext, so this is safe).
  async rearmPersisted() {
    for (const [sid, p] of Object.entries(this.state.sessions || {})) {
      try {
        this.acquireWriterLock(sid);
        const session = {
          sid, publicId: p.publicId, paneId: p.paneId, tty: p.tty, cwd: p.cwd,
          file: p.file, offset: p.offset || 0, partial: '',
          title: path.basename(p.cwd || 'session'), hv: null,
          seenUuids: new Set(), queue: [], nextSeq: p.nextSeq || 1,
          status: 'idle', waitingArmed: true, approvals: p.approvals || [],
          flushing: false, backfilled: 0, gen: 0,
        };
        const echo = await this.registerSession(session, 'idle');
        session.nextSeq = Math.max(session.nextSeq, (echo.last_seq || 0) + 1);
        this.sessions.set(sid, session);
        this.subscribeInput(session);
        this.log(`re-armed ${sid.slice(0, 8)} after restart (epoch ${this.state.epoch})`);
      } catch (e) {
        this.log(`re-arm ${sid.slice(0, 8)} failed: ${e.message} — dropped from state`);
        delete this.state.sessions[sid];
        this.saveState();
      }
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

  async backfill(session) {
    // Seed = the LAST 100 items / 512 KB sealed, oldest-first (spec §6).
    const items = [];
    try {
      const raw = fs.readFileSync(session.file, 'utf8');
      session.offset = Buffer.byteLength(raw, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let obj; try { obj = JSON.parse(line); } catch { continue; }
        for (const item of adapter.normalize(obj)) {
          if (session.seenUuids.has(item.uuid)) continue;
          session.seenUuids.add(item.uuid);
          if (item.hv) session.hv = item.hv;
          items.push(item);
        }
      }
    } catch (e) {
      this.log(`backfill read failed (${e.message}) — starting live-only`);
      return;
    }
    let seed = items.slice(-BACKFILL_ITEMS);
    // Budget by sealed size, dropping OLDEST first.
    let sealedTotal = 0;
    const sealedSeed = [];
    for (const item of seed.reverse()) { // newest first for the budget…
      item._publicId = session.publicId;
      const b64 = this.sealItem(item);
      if (b64 === null) continue;
      const bytes = Buffer.byteLength(b64, 'utf8');
      if (sealedTotal + bytes > BACKFILL_SEALED_BYTES) break;
      sealedTotal += bytes;
      sealedSeed.push({ item, b64 });
    }
    sealedSeed.reverse(); // …back to oldest-first for seq order
    for (const { b64 } of sealedSeed) {
      session.queue.push(b64);
    }
    session.backfilled = sealedSeed.length;
    if (items.length > sealedSeed.length) {
      this.log(`backfill: seeded ${sealedSeed.length}/${items.length} items (bounded window — earlier history stays on this Mac)`);
    }
    await this.flush(session);
  }

  tailTick() {
    for (const s of this.sessions.values()) this.tailOne(s);
  }

  tailOne(s) {
    let st;
    try { st = fs.statSync(s.file); } catch { return; }
    if (st.size < s.offset) {
      // Truncated/rewritten in place (probe: RESCAN) — re-read whole, dedup by uuid.
      this.log(`${s.sid.slice(0, 8)}: size ${st.size} < offset ${s.offset} — full rescan with uuid dedup`);
      s.offset = 0; s.partial = '';
    }
    if (st.size <= s.offset) return;
    let buf;
    try {
      const fd = fs.openSync(s.file, 'r');
      buf = Buffer.alloc(st.size - s.offset);
      fs.readSync(fd, buf, 0, buf.length, s.offset);
      fs.closeSync(fd);
    } catch { return; }
    s.offset = st.size;
    const data = (s.partial || '') + buf.toString('utf8');
    const lines = data.split('\n');
    s.partial = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      for (const item of adapter.normalize(obj)) {
        if (s.seenUuids.has(item.uuid)) continue;
        s.seenUuids.add(item.uuid);
        if (item.hv && item.hv !== s.hv) {
          if (s.hv) this.log(`${s.sid.slice(0, 8)}: harness version drift ${s.hv} → ${item.hv}`);
          s.hv = item.hv;
        }
        item._publicId = s.publicId;
        // A seal failure on ONE item must never take the tailer interval down —
        // skip it loudly and keep tailing (the JSONL remains durable).
        let b64 = null;
        try { b64 = this.sealItem(item); } catch (e) { this.log(`item ${item.uuid}: seal failed (${e.message}) — skipped`); }
        if (b64 !== null) s.queue.push(b64);
      }
    }
    this.persistSession(s);
  }

  async flushTick() {
    for (const s of this.sessions.values()) {
      if (s.queue.length && !s.flushing) this.flush(s).catch((e) => this.log('flush error:', e.message));
    }
  }

  async flush(session) {
    if (session.flushing) return;
    session.flushing = true;
    const gen = session.gen;
    try {
      while (session.queue.length) {
        if (session.gen !== gen) return; // torn down mid-flush (#66)
        const batch = session.queue.slice(0, this.caps.items_per_call);
        const items = batch.map((b64, i) => ({ seq: session.nextSeq + i, payload_sealed: b64 }));
        const { res, data } = await this.api('POST', `/agent_sessions/${session.publicId}/items`, { items });
        if (res.status === 201) {
          session.queue.splice(0, batch.length);
          session.nextSeq = (data.last_seq || (session.nextSeq + batch.length - 1)) + 1;
          session.backoff = 0;
          this.persistSession(session);
        } else if (res.status === 422 && data && data.code === 'seq_regression') {
          // Server knows more than our state (restart race): re-sync from it.
          const { data: reg } = await this.api('POST', '/agent_sessions', {
            public_id: session.publicId, status: session.status, meta_sealed: this.sealMeta(session),
          });
          const serverSeq = reg && reg.session ? reg.session.last_seq : null;
          if (serverSeq === null || serverSeq + 1 === session.nextSeq) {
            this.log(`${session.publicId}: seq_regression did not resolve — dropping ONE batch loudly to break the loop`);
            session.queue.splice(0, batch.length);
          } else {
            this.log(`${session.publicId}: seq re-synced ${session.nextSeq} → ${serverSeq + 1}`);
            session.nextSeq = serverSeq + 1;
          }
        } else {
          session.backoff = Math.min((session.backoff || 1) * 2, 60);
          this.log(`${session.publicId}: items POST → ${res.status}; retry in ${session.backoff}s (nothing lost — the JSONL is durable)`);
          setTimeout(() => { if (session.gen === gen) this.flush(session).catch(() => {}); }, session.backoff * 1000);
          return;
        }
      }
    } finally {
      session.flushing = false;
    }
  }

  // --- status + waiting notification (spec §9) ------------------------------

  setStatus(s, status) {
    if (status === 'running') s.waitingArmed = true; // re-arm the waiting edge
    if (s.status === status) return;
    s.status = status;
    this.api('PATCH', `/agent_sessions/${s.publicId}`, { status }).catch((e) => this.log('status PATCH failed:', e.message));
  }

  async heartbeatTick() {
    for (const s of this.sessions.values()) {
      this.api('PATCH', `/agent_sessions/${s.publicId}`, {}).catch(() => {});
    }
  }

  async maybeNotifyWaiting(s, message) {
    // One notification per waiting-EPISODE: armed on the running→waiting edge,
    // reset by input or running (spec §9). One-and-done (#30) untouched —
    // this is an ordinary notification.
    if (!s.waitingArmed) return;
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
    const { res } = await this.api('POST', '/notify', payload);
    if (res.status !== 201) this.log(`waiting notify → ${res.status}`);
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
      this.log('WARNING: no native WebSocket (Node <22) — the input lane is OFF; transcripts still publish');
      return;
    }
    const gen = ++this.wsGen;
    const url = this.env.base.replace(/^http/, 'ws') + '/cable';
    const ws = new WebSocket(url, ['actioncable-v1-json', this.env.token]);
    this.ws = ws;
    this.wsLastBeat = Date.now();
    ws.onopen = () => {
      if (gen !== this.wsGen) return ws.close(); // superseded (#66)
      this.log('cable up — subscribing input lanes');
      for (const s of this.sessions.values()) this.sendSubscribe(s);
    };
    ws.onmessage = (ev) => {
      if (gen !== this.wsGen) return;
      this.wsLastBeat = Date.now();
      let frame; try { frame = JSON.parse(ev.data); } catch { return; }
      if (frame.type === 'ping' || frame.type === 'welcome' || frame.type === 'confirm_subscription') return;
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
    };
    ws.onerror = () => {};
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
    for (const k of msg.keys.slice(0, 16)) {
      try {
        if (k && typeof k.lit === 'string' && k.lit.length) {
          this.sendLiteral(session.paneId, k.lit);
          session.waitingArmed = true; // input resets the waiting episode (spec §9)
        } else if (k && typeof k.key === 'string' && INPUT_KEYS.has(k.key)) {
          execFileSync('tmux', ['send-keys', '-t', session.paneId, k.key]);
        }
        // anything else: dropped whole (deliberately tiny allowlist)
      } catch (e) {
        this.log(`send-keys failed: ${e.message}`);
      }
    }
  }

  sendLiteral(paneId, text) {
    if (text.includes('\n')) {
      // Multiline rides a tmux buffer + bracketed paste (spec §8).
      const bufName = `pidge-${Date.now()}`;
      execFileSync('tmux', ['set-buffer', '-b', bufName, text]);
      execFileSync('tmux', ['paste-buffer', '-p', '-b', bufName, '-t', paneId, '-d']);
    } else {
      execFileSync('tmux', ['send-keys', '-t', paneId, '-l', text]);
    }
  }

  paneAlive(paneId) {
    try {
      const out = execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_id}'], { encoding: 'utf8' });
      return out.split('\n').includes(paneId);
    } catch { return false; }
  }

  // --- watchdog (B7) --------------------------------------------------------

  watchdogTick() {
    if (this.sessions.size === 0) return;
    if (!this.ws || this.ws.readyState > 1) {
      this.ensureCable();
    } else if (this.ws.readyState === 1 && Date.now() - this.wsLastBeat > 45_000) {
      // ActionCable pings every ~3s; 45s of silence = a dead socket that
      // doesn't know it. Prefer a spurious reconnect over a silent stand-down.
      this.log('cable silent 45s — forcing reconnect (watchdog)');
      try { this.ws.close(); } catch {}
      this.ws = null;
      this.ensureCable();
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
