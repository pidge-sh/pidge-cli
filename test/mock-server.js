'use strict';
// A controllable Pidge stand-in for the CLI tests: the HTTP surface the CLI
// touches + an ActionCable-speaking WebSocket (via the `ws` devDependency).
// `state.waitMode` simulates the production failure classes of #119:
//   'ok'      — held polls answer normally
//   '502'     — the edge kills held responses as 502 (the Railway incident)
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
    messages: [],          // served by GET /api/v1/messages
    notifications: {},     // cid → body for GET /api/v1/notifications/:cid
    acks: [],
    notifies: [],
  };
  let server = null;
  let wss = null;
  let port = null;

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'x-pidge-manifest-version': '16' });
    res.end(JSON.stringify(body));
  };

  const handler = (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const held = url.searchParams.has('wait');
    if (held && state.waitMode === '502') return json(res, 502, { error: 'bad gateway' });
    if (held && state.waitMode === 'destroy') return setTimeout(() => res.destroy(), 300);

    if (req.method === 'GET' && url.pathname === '/api/v1/messages') {
      return json(res, 200, { messages: state.messages });
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/messages/ack') {
      state.acks.push(req.url);
      state.messages = [];
      if (state.hangAck) return; // simulate a wedged proxy stalling the ack POST
      return json(res, 200, { acked: 1 });
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/notify') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch { /* keep {} */ }
        state.notifies.push(parsed);
        json(res, 201, {
          id: 1, status: 'pending',
          correlation_id: parsed.correlation_id || 'mock-cid',
          registered_devices: 1, render_mode: 'banner',
        });
      });
      return;
    }
    const m = url.pathname.match(/^\/api\/v1\/notifications\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      const cid = decodeURIComponent(m[1]);
      return json(res, 200, state.notifications[cid] || { responded: false, correlation_id: cid });
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
