'use strict';
// A controllable Pidge stand-in for the CLI tests: the HTTP surface the CLI
// touches + an ActionCable-speaking WebSocket (via the `ws` devDependency).
// `state.waitMode` simulates held-poll failure classes seen in production:
//   'ok'      — held polls answer normally
//   '502'     — an edge/proxy kills held responses as 502
//   'destroy' — a proxy with a short response-timeout drops the held socket
// stop()/start() on the same port simulate a server deploy/restart.
const http = require('node:http');
const { WebSocketServer } = require('ws');

function createMock() {
  const state = {
    sockets: new Set(),
    subscriptions: [],     // channel names confirmed, in order
    onSubscribe: null,     // (channel, sock) => {} test hook
    waitMode: 'ok',
    wsMode: 'ok',          // '1006' = drop every WS abruptly (a proxy/edge refusing the upgrade)
    messages: [],          // served by GET /api/v1/messages
    messageReads: [],      // every GET /api/v1/messages req.url (assert catchup's history=true&all=true)
    notifications: {},     // cid → body for GET /api/v1/notifications/:cid
    inboxNotifications: [], // rows for GET /api/v1/notifications (the list)
    inboxSummary: null,     // body for GET /api/v1/inbox/summary (null → default zeros)
    acks: [],
    ackBodies: [], // the parsed ack payloads, so tests can assert up_to/ids exactly
    notifies: [],
    uploads: [],
    blobs: {},             // name → Buffer, served at GET /blobs/<name>
    claimCode: 'claim-ok',   // POST /api/v1/claim exchanges this once
    devices: 1,
    // claim ownership + operating-contract/device_reach surfaces.
    claim: { claimed_by_label: null, claimed_by_fingerprint: null, claimed_at: null, claim_generation: 0 },
    deviceReach: null,       // set by a test to exercise the honesty warning
    operatingContract: {},   // PATCH /channels/:id merges into this
    manifestVersion: 16,     // X-Pidge-Manifest-Version header — a test bumps it to fire the news nudge
    manifestStatus: 200,     // a test sets 500 to force a manifest read failure (skill fuse degrades)
    notifyStatus: 201,       // a test forces a non-2xx to exercise approve's fail-closed send
    selftests: {},           // id → {nonce, window_seconds, created, processed}
    selftestSeq: 100,        // next selftest/message id
    // the /live_activities wire.
    liveWrites: [],          // every {method, path, body} the CLI sent
    liveCards: {},           // cid → true (existence drives started|updated + PATCH 404)
    liveDegrade: false,      // a test forces the dedicated-budget degrade echo
    // bridge: a test forces a non-200 on GET /messages (401 = rotated key).
    messagesStatus: 200,
    // >0 models the server VISIBILITY LEASE — a delivered row is NOT re-served
    // within the window (ack removes it regardless). Default 0 keeps the
    // legacy always-re-serve behavior the older tests rely on.
    leaseMs: 0,
    // stale_from_prior_claim rides top-level on the channel-key GET /messages
    // and on whoami — a test flips it true.
    staleFromPriorClaim: false,
  };
  let server = null;
  let wss = null;
  let port = null;

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'x-pidge-manifest-version': String(state.manifestVersion) });
    res.end(JSON.stringify(body));
  };

  const handler = (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const held = url.searchParams.has('wait');
    if (held && state.waitMode === '502') return json(res, 502, { error: 'bad gateway' });
    if (held && state.waitMode === 'destroy') return setTimeout(() => res.destroy(), 300);

    // Onboarding: claim exchange (public, single-use) + whoami.
    if (req.method === 'POST' && url.pathname === '/api/v1/claim') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let code = null;
        try { code = JSON.parse(body).code; } catch { /* keep null */ }
        if (state.claimCode && code === state.claimCode) {
          state.claimCode = null; // single-use
          return json(res, 200, {
            key: 'hld_minted_by_claim', channel: { id: 1, name: 'mock' },
            user: 'Thiago', base_url: `http://127.0.0.1:${port}`,
          });
        }
        json(res, 404, { error: 'not_found' });
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/whoami') {
      const auth = req.headers.authorization || '';
      // whoami is either-track — a ses_ token gets a 200 with the HUMAN view
      // (no channel block). Mirrored here so doctor's branch is testable.
      if (/^Bearer ses_/.test(auth)) {
        return json(res, 200, {
          user: { name: 'Thiago', timezone: 'America/Sao_Paulo' },
          devices: state.devices ?? 1,
          device_reach: state.deviceReach,
          transport_budgets: { scope: 'process', ws_sockets: { held: 0, cap: 32 }, longpoll: { held: 0, capacity: 6 } },
          manifest_version: 16,
        });
      }
      // 'hld_revoked' simulates a dead key (the shared-config guard lets a
      // corpse be overwritten without --force).
      if (!/^Bearer hld_/.test(auth) || auth === 'Bearer hld_revoked') return json(res, 401, { error: 'unauthorized' });
      return json(res, 200, {
        // e2e_enabled mirrors prod whoami — the ONLY signal that turns the
        // CLI's send-side sealing on (a test flips state.e2eEnabled).
        channel: { id: 1, name: 'mock', icon: 'bot', color: 'violet', e2e_enabled: !!state.e2eEnabled,
                   // media gate: a test flips state.e2eMediaReady.
                   e2e_media_ready: !!state.e2eMediaReady },
        operating_contract: state.operatingContract,
        user: { name: 'Thiago', timezone: 'America/Sao_Paulo' },
        claim: state.claim,
        devices: state.devices ?? 1,
        device_reach: state.deviceReach,                     // null unless a test sets it
        stale_from_prior_claim: state.staleFromPriorClaim,
        manifest_version: 16,
      });
    }
    // POST /claim/ownership — bump generation only on a DIFFERENT fingerprint.
    if (req.method === 'POST' && url.pathname === '/api/v1/claim/ownership') {
      const auth = req.headers.authorization || '';
      if (!/^Bearer hld_/.test(auth) || auth === 'Bearer hld_revoked') return json(res, 401, { error: 'unauthorized' });
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let p = {}; try { p = JSON.parse(body); } catch { /* keep {} */ }
        const fp = (p.fingerprint || '').toString();
        if (!fp) return json(res, 400, { error: 'fingerprint required' });
        const c = state.claim;
        const changed = !!c.claimed_by_fingerprint && c.claimed_by_fingerprint !== fp;
        let gen = changed ? c.claim_generation + 1 : c.claim_generation;
        if (gen === 0) gen = 1;
        state.claim = {
          claimed_by_label: p.label || null, claimed_by_fingerprint: fp,
          claimed_at: new Date().toISOString(), claim_generation: gen,
        };
        json(res, 200, { channel: { id: 1, name: 'mock' }, claim: state.claim, generation: gen });
      });
      return;
    }
    // PATCH /channels/:id — merge operating_contract (CONTRACT, never policy).
    const pmatch = url.pathname.match(/^\/api\/v1\/channels\/(\d+)$/);
    if (req.method === 'PATCH' && pmatch) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let p = {}; try { p = JSON.parse(body); } catch { /* keep {} */ }
        if (p.operating_contract && typeof p.operating_contract === 'object') {
          for (const [k, val] of Object.entries(p.operating_contract)) {
            if (val === null) delete state.operatingContract[k];
            else state.operatingContract[k] = { value: val, by: 'agent:mock', at: new Date().toISOString(), locked: false };
          }
        }
        // Mirror prod: the /channels PATCH echoes the WHOLE channel, key included
        // — so the CLI must NOT dump it to stdout (the 0.9.2 key-leak fix).
        json(res, 200, { id: 1, name: 'mock', key: 'hld_mock_secret_key', operating_contract: state.operatingContract });
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/manifest') {
      // a test can force a manifest read failure (the skill fuse must degrade).
      if (state.manifestStatus && state.manifestStatus !== 200) return json(res, state.manifestStatus, { error: 'boom' });
      return json(res, 200, {
        manifest_version: 16,
        // The dead content_template menu is STILL served — the generator must IGNORE it.
        templates: { decision_table: ['need a decision → template decision'] },
        profiles: { decision_table: ['no answer needed → profile omitted'] },
        notes: ['trust the echo'],
        cli: { output: 'exit 0 answered · 3 timed out' },
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/messages') {
      // record every read so a test can assert catchup's query (history/all).
      state.messageReads.push(req.url);
      // a test forces a 401 (rotated key) / 5xx — the bridge must narrate,
      // alert locally and back off LONG, never a blind hot loop.
      if (state.messagesStatus && state.messagesStatus !== 200)
        return json(res, state.messagesStatus, { error: 'unauthorized' });
      // notification_reply rows are served only on the unified queue.
      const all = url.searchParams.get('all') === 'true';
      // history=true is the READ-ONLY thread read (never consumes, stamps
      // delivered or opens a lease). The mock never deletes on GET anyway, so
      // the observable contract under test is that catchup NEVER POSTs an ack
      // (state.acks stays empty).
      let rows = all ? state.messages
        : state.messages.filter((m) => !m.kind || m.kind === 'message');
      // `since=<id>` scopes the read to rows with a STRICTLY GREATER id (the
      // selftest reads since=<nonce id − 1> so the pre-existing real backlog — all
      // lower ids — is excluded by construction and never served/leased here).
      const since = url.searchParams.get('since');
      if (since !== null && since !== '') {
        const floor = Number(since);
        if (Number.isFinite(floor)) rows = rows.filter((m) => Number(m.id) > floor);
      }
      // the lease model applies only to the CONSUME path — a history read
      // (catchup) is read-only and never opens/honors a lease.
      const history = url.searchParams.get('history') === 'true';
      if (state.leaseMs > 0 && !history) {
        const now = Date.now();
        // a `lease=<seconds>` query param OVERRIDES the default lease (the
        // selftest passes lease=60 to cap the blackout on anything it serves;
        // the server default is the ~10-min state.leaseMs).
        const leaseParam = url.searchParams.get('lease');
        const leaseMs = leaseParam && Number.isFinite(Number(leaseParam)) ? Number(leaseParam) * 1000 : state.leaseMs;
        rows = rows.filter((m) => !m._leasedUntil || m._leasedUntil <= now);
        for (const m of rows) m._leasedUntil = now + leaseMs;
      }
      // strip the internal lease stamp — it must not leak into the served JSON
      return json(res, 200, {
        messages: rows.map(({ _leasedUntil, ...rest }) => rest),
        stale_from_prior_claim: state.staleFromPriorClaim,
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/messages/ack') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let p = {}; try { p = JSON.parse(body); } catch { /* keep {} */ }
        state.acks.push(req.url);
        state.ackBodies.push(p);
        if (state.hangAck) return; // simulate a wedged proxy stalling the ack POST
        // state=delivered RENEWS the lease (not consumed); else PROCESS it.
        if (p.state === 'delivered') return json(res, 200, { renewed: 1 });
        // mark an acked selftest PROCESSED (the round-trip PASS signal). ids
        // acks just those; up_to (no ids) processes + clears the whole queue.
        const ackedIds = Array.isArray(p.ids) ? p.ids : state.messages.map((mm) => mm.id);
        for (const st of Object.values(state.selftests)) if (ackedIds.includes(st.id)) st.processed = true;
        state.messages = Array.isArray(p.ids) ? state.messages.filter((mm) => !p.ids.includes(mm.id)) : [];
        json(res, 200, { acked: 1 });
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/uploads') {
      // Record THE upload (the CLI's e2e pin must refuse BEFORE any bytes
      // reach here). Also captures the multipart's filename + the file part's
      // raw bytes, so sealed-media tests prove WHAT left the machine (sealed
      // framing + generic blob.bin, never plaintext + the real name). Naive
      // single-part extraction — the CLI sends one part.
      const chunks = [];
      req.on('data', (c) => { chunks.push(c); });
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        const fnMatch = /filename="([^"]*)"/.exec(raw.toString('latin1'));
        let fileBytes = null;
        const sep = raw.indexOf('\r\n\r\n');
        const tail = raw.lastIndexOf('\r\n--');
        if (sep !== -1 && tail > sep) fileBytes = raw.subarray(sep + 4, tail);
        state.uploads.push({ bytes: raw.length, filename: fnMatch ? fnMatch[1] : null, fileBytes });
        json(res, 201, { ref: 'upload-ref-mock' });
      });
      return;
    }
    // attachment blob download (the signed-URL stand-in). A test parks
    // bytes in state.blobs['a1'] and points a message's attachment.url at
    // '/blobs/a1' (relative — the CLI prefixes its BASE).
    if (req.method === 'GET' && url.pathname.startsWith('/blobs/')) {
      const blob = state.blobs[url.pathname.slice('/blobs/'.length)];
      if (!blob) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(blob);
    }
    // the three Live Activity endpoints.
    const laEnd = url.pathname.match(/^\/api\/v1\/live_activities\/([^/]+)\/end$/);
    const laOne = url.pathname.match(/^\/api\/v1\/live_activities\/([^/]+)$/);
    if (url.pathname === '/api/v1/live_activities' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* keep {} */ }
        state.liveWrites.push({ method: 'POST', path: url.pathname, body: parsed });
        const cid = parsed.correlation_id || 'gen-la-cid';
        const op = state.liveCards[cid] ? 'updated' : 'started';
        state.liveCards[cid] = true;
        const degraded = state.liveDegrade && parsed.presentation === 'dedicated';
        json(res, 201, {
          id: 1, correlation_id: cid, state: 'active', title: parsed.title || 'Pidge',
          content: {}, presentation: degraded ? 'consolidated' : (parsed.presentation || 'consolidated'),
          linger_seconds: null, operation: op,
          ...(degraded ? { degraded: true, reason: 'dedicated_budget_exhausted' } : {}),
          started_at: 'x', ended_at: null, created_at: 'x', renderable_devices: 1,
        });
      });
      return;
    }
    if (laEnd && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* keep {} */ }
        const cid = decodeURIComponent(laEnd[1]);
        state.liveWrites.push({ method: 'POST', path: url.pathname, body: parsed });
        if (!state.liveCards[cid]) return json(res, 404, { error: 'not_found' });
        json(res, 200, {
          id: 1, correlation_id: cid, state: 'ended', title: 'T', content: parsed,
          presentation: 'consolidated', linger_seconds: parsed.linger_seconds ?? null,
          operation: 'ended', started_at: 'x', ended_at: 'x', created_at: 'x', renderable_devices: 1,
        });
      });
      return;
    }
    if (laOne && req.method === 'PATCH') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* keep {} */ }
        const cid = decodeURIComponent(laOne[1]);
        state.liveWrites.push({ method: 'PATCH', path: url.pathname, body: parsed });
        if (!state.liveCards[cid]) return json(res, 404, { error: 'not_found' });
        json(res, 200, {
          id: 1, correlation_id: cid, state: 'active', title: 'T', content: parsed,
          presentation: 'consolidated', linger_seconds: null, operation: 'updated',
          started_at: 'x', ended_at: null, created_at: 'x', renderable_devices: 1,
        });
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/notify') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* keep {} */ }
        state.notifies.push(parsed);
        // a test forces a non-2xx so `approve` fails CLOSED on a send error.
        if (state.notifyStatus && state.notifyStatus !== 201)
          return json(res, state.notifyStatus, { error: 'notify_failed' });
        // the real server keys requires_action on the PRESENCE of decision
        // buttons (any custom_action, or a built-in action beyond a bare
        // `done`) — NOT on the type. Mirror that so the CLI's decision-timeout
        // default is exercised exactly as in prod.
        const acts = Array.isArray(parsed.actions) ? parsed.actions : [];
        const customs = Array.isArray(parsed.custom_actions) ? parsed.custom_actions : [];
        const requires_action = customs.length > 0 || acts.some((a) => a !== 'done');
        json(res, 201, {
          id: 1, status: 'pending',
          correlation_id: parsed.correlation_id || 'mock-cid',
          registered_devices: 1, render_mode: 'banner',
          template: parsed.template || null,
          requires_action,
          // E2E: prod echoes the content byte-identical, enc/kf alongside —
          // the CLI's trust-the-echo display decrypt is exercised against this.
          title: parsed.title ?? null,
          subtitle: parsed.subtitle ?? null,
          body: parsed.body ?? null,
          enc: parsed.enc || null,
          kf: parsed.kf || null,
          // per-template suggestion the real server echoes
          suggested_ask_timeout: parsed.template === 'approval' ? 3600 : null,
        });
      });
      return;
    }
    // inbox: the list (GET /notifications) and the one-call summary
    // (GET /inbox/summary) — used to prove `inbox --summary` still hits
    // the summary path after the ack `--summary` type split.
    if (req.method === 'GET' && url.pathname === '/api/v1/notifications') {
      return json(res, 200, { notifications: state.inboxNotifications || [] });
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/inbox/summary') {
      const scope = url.searchParams.get('all') === 'true' ? 'account' : 'channel';
      return json(res, 200, state.inboxSummary || { total: 0, scope, pending: 0, avg_response_seconds: null });
    }
    const m = url.pathname.match(/^\/api\/v1\/notifications\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      // a test forces a MALFORMED 200 body — the poller must read it as
      // "no answer yet" and a blocked approve must still fail CLOSED on timeout.
      if (state.pollGarbage) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{{{ not json');
      }
      const cid = decodeURIComponent(m[1]);
      return json(res, 200, state.notifications[cid] || { responded: false, correlation_id: cid });
    }
    // reachability self-test. POST mints a nonce + a kind:'system' selftest
    // message on the queue; GET reads PASS (acked in window) / FAILED / pending.
    if (req.method === 'POST' && url.pathname === '/api/v1/selftest') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let p = {}; try { p = JSON.parse(body); } catch { /* keep {} */ }
        const id = state.selftestSeq++;
        const windowS = Math.max(5, Math.min(120, parseInt(p.window_seconds, 10) || 30));
        const nonce = `nonce-${id}`;
        state.selftests[id] = { id, nonce, window_seconds: windowS, created: Date.now(), processed: false };
        // dropSelftest: the nonce never reaches the queue (simulates an orphaned/
        // unreachable listener or a transport that drops it) → the CLI FAILs with cause.
        if (!state.dropSelftest) state.messages.push({ id, kind: 'system', system_kind: 'selftest', nonce, body: `selftest nonce=${nonce}` });
        json(res, 201, { id, status: 'pending', nonce, window_seconds: windowS, expires_at: new Date(Date.now() + windowS * 1000).toISOString() });
      });
      return;
    }
    const stMatch = url.pathname.match(/^\/api\/v1\/selftest\/(\d+)$/);
    if (req.method === 'GET' && stMatch) {
      const st = state.selftests[stMatch[1]];
      if (!st) return json(res, 404, { error: 'not_found' });
      const status = st.processed ? 'passed'
        : (Date.now() < st.created + st.window_seconds * 1000 ? 'pending' : 'failed');
      return json(res, 200, { id: st.id, status, nonce: st.nonce, window_seconds: st.window_seconds });
    }
    json(res, 404, { error: 'not_found' });
  };

  const start = (atPort = port || 0) => new Promise((resolve) => {
    server = http.createServer(handler);
    wss = new WebSocketServer({
      server,
      handleProtocols: () => 'actioncable-v1-json', // negotiate like ActionCable
    });
    wss.on('connection', (sock) => {
      // wsMode '1006': drop EVERY socket abruptly (no close frame) → the client
      // sees close code 1006, an intermittent failure mode seen in production.
      if (state.wsMode === '1006') { try { sock.terminate(); } catch { /* gone */ } return; }
      state.sockets.add(sock);
      sock.send(JSON.stringify({ type: 'welcome' }));
      const ping = setInterval(() => {
        if (sock.readyState === 1) sock.send(JSON.stringify({ type: 'ping', message: Date.now() }));
      }, 1000);
      sock.on('message', (raw) => {
        let f; try { f = JSON.parse(raw); } catch { return; }
        if (f.command === 'subscribe') {
          const channel = JSON.parse(f.identifier).channel;
          state.subscriptions.push(channel);
          sock.send(JSON.stringify({ type: 'confirm_subscription', identifier: f.identifier }));
          if (state.onSubscribe) state.onSubscribe(channel, sock);
        }
      });
      sock.on('close', () => { clearInterval(ping); state.sockets.delete(sock); });
    });
    server.listen(atPort, '127.0.0.1', () => { port = server.address().port; resolve(port); });
  });

  const stop = () => new Promise((resolve) => {
    for (const sock of state.sockets) { try { sock.terminate(); } catch { /* gone */ } }
    state.sockets.clear();
    wss.close();
    server.closeAllConnections();
    server.close(() => resolve());
  });

  const broadcast = (channel, message) => {
    const identifier = JSON.stringify({ channel });
    for (const sock of state.sockets) {
      if (sock.readyState === 1) sock.send(JSON.stringify({ identifier, message }));
    }
  };

  return { state, start, stop, broadcast, get port() { return port; } };
}

module.exports = { createMock };
