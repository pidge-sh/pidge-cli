'use strict';
// A multiplexing ActionCable client for the host daemon: ONE WebSocket, N
// TerminalChannel subscriptions (the control lane + every tmux session).
// The single-subscription client the rest of the CLI uses opens one socket
// per subscribe — fine for a wait/listen, wrong for a daemon that would eat
// a connection slot per session. Same wire behavior otherwise: token as the
// extra Sec-WebSocket-Protocol entry, server pings as the liveness signal
// (silence >15 s ⇒ the socket is dead even if TCP hasn't noticed).
//
// Reconnect is the CALLER's loop (backoff lives there): `connect()` opens one
// socket session and reports its end via onDown; registered subscriptions
// persist across connects and are re-subscribed on every open — a subscriber
// just sees onUp again (and reseeds, which makes reconnects self-healing).

function createCable({ base, token, onDown }) {
  const subs = new Map(); // identifier → {onUp, onFrame, onReject, confirmed}
  let ws = null;
  let beatCheck = null;
  let lastBeat = 0;
  let sessionEnded = null; // per-connect close reporter

  const up = () => !!ws && ws.readyState === 1;

  function endSession(why) {
    if (!sessionEnded) return;
    const report = sessionEnded;
    sessionEnded = null;
    clearInterval(beatCheck);
    beatCheck = null;
    for (const s of subs.values()) s.confirmed = false;
    try { ws.close(); } catch { /* already closing */ }
    ws = null;
    report(why);
  }

  return {
    get up() { return up(); },

    connect() {
      try {
        ws = new WebSocket(base.replace(/^http/, 'ws') + '/cable', ['actioncable-v1-json', token]);
      } catch (e) { onDown(e.message); return; }
      sessionEnded = onDown;
      lastBeat = Date.now();
      beatCheck = setInterval(() => {
        if (Date.now() - lastBeat > 15000) endSession('heartbeat lost (server gone?)');
      }, 5000);
      ws.onopen = () => {
        for (const identifier of subs.keys()) {
          ws.send(JSON.stringify({ command: 'subscribe', identifier }));
        }
      };
      ws.onmessage = (e) => {
        lastBeat = Date.now();
        let f; try { f = JSON.parse(e.data); } catch { return; }
        if (f.type === 'ping' || f.type === 'welcome') return;
        const sub = f.identifier && subs.get(f.identifier);
        if (!sub) return;
        if (f.type === 'confirm_subscription') { sub.confirmed = true; if (sub.onUp) sub.onUp(); return; }
        if (f.type === 'reject_subscription') { if (sub.onReject) sub.onReject(); return; }
        if (f.message) sub.onFrame(f.message);
      };
      ws.onerror = () => { /* onclose follows with the code */ };
      ws.onclose = (e) => endSession(`closed (${e.code})`);
    },

    // Register a subscription (survives reconnects until unsubscribed).
    subscribe(params, { onUp, onFrame, onReject }) {
      const identifier = JSON.stringify({ channel: 'TerminalChannel', ...params });
      subs.set(identifier, { onUp, onFrame, onReject, confirmed: false });
      if (up()) ws.send(JSON.stringify({ command: 'subscribe', identifier }));
      return {
        identifier,
        send: (action, payload) => {
          const s = subs.get(identifier);
          if (!up() || !s || !s.confirmed) return false;
          try {
            ws.send(JSON.stringify({ command: 'message', identifier, data: JSON.stringify({ action, ...payload }) }));
            return true;
          } catch { return false; }
        },
        unsubscribe: () => {
          subs.delete(identifier);
          if (up()) { try { ws.send(JSON.stringify({ command: 'unsubscribe', identifier })); } catch { /* closing */ } }
        },
      };
    },

    close() {
      const report = sessionEnded;
      sessionEnded = null; // a deliberate close is not a failure — mute onDown
      clearInterval(beatCheck);
      beatCheck = null;
      if (ws) { try { ws.close(); } catch { /* gone */ } }
      ws = null;
      void report;
    },
  };
}

module.exports = { createCable };
