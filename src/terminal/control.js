'use strict';
// tmux CONTROL MODE client (`tmux -C attach`) + the ControlHub that owns one
// client per tmux SESSION and fans `%output` out PER PANE.
//
// The client is RECOVERED VERBATIM from the retired 0.37.1 arc
// (`src/terminal/control.js` @ acdd106) — the whole tap is a child process
// speaking a line protocol over stdio: no PTY, no native deps. The ONE
// behavioural change is in dispatch(): the old client THREW AWAY the pane id
// out of `%output %<pane> …` (it owned exactly one session and forwarded every
// byte). Phase B shares PANES, so the id is the routing key — `onOutput` now
// receives `(paneId, bytes)`, and the Hub delivers to the mirror registered for
// that pane and to nobody else (spec §19: "filter by pane_id").
//
// Protocol facts this client relies on (verified against tmux 3.7):
//   · Lines are latin1 — %output payloads are octal-escaped BYTES; nothing on
//     the wire is guaranteed UTF-8, so the stream is split on \n as latin1
//     and decoded only after unescaping.
//   · Every command written to stdin answers with one %begin…%end (success)
//     or %begin…%error (failure) block, IN ORDER — a FIFO of pending
//     resolvers correlates them. The block header's third field is a flags
//     word whose bit 1 means "reply to a client command": the greeting block
//     tmux emits on attach carries flags 0, so it can never be mistaken for
//     the first command's reply.
//   · Command-output blocks (capture-pane -p, display-message -p) carry the
//     output lines VERBATIM between %begin/%end — including raw ESC bytes AND
//     pane text that itself starts with `%output`/`%exit`. tmux holds real
//     notifications until a command's block completes, so INSIDE a block every
//     line up to the terminator is body — we must NOT re-interpret a `%…`
//     body line as a notification (that would steal captured pane content out
//     of a seed and inject it into the live stream).
//   · %exit means THIS client is done (detach, session killed, server gone) —
//     stdout EOF follows.

const { spawn } = require('node:child_process');
const { unescapeOctal } = require('./wire');

// Async notifications tmux may emit at any moment. Anything tagged but
// unknown is IGNORED (additive evolution — a newer tmux must not break us);
// %output/%exit/%session-renamed are the ones the Hub actually consumes.
const NOTIFICATION = /^%(output|exit|layout-change|window-add|window-close|window-renamed|window-pane-changed|unlinked-window-add|unlinked-window-close|unlinked-window-renamed|session-changed|session-renamed|session-window-changed|sessions-changed|client-session-changed|client-detached|pane-mode-changed|subscription-changed|paste-buffer-changed|paste-buffer-deleted|continue|pause|extended-output|config-error|message)\b/;

// One control-mode connection to one tmux session.
//   createControl({ target, socketArgs?, onOutput(paneId, bytes), onEvent(tag, rest), onClose(reason) })
// → { command(line) → Promise<{ok, lines}>, kill(), closed }
function createControl({ tmuxBin = 'tmux', socketArgs = [], target, onOutput, onEvent, onClose }) {
  const child = spawn(tmuxBin, [...socketArgs, '-C', 'attach', '-t', target], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = [];        // FIFO of {resolve} for in-flight commands
  let block = null;          // { lines, isReply, error } while inside %begin…%end
  let buf = '';
  let closed = false;
  let closeReason = null;

  const finish = (reason) => {
    if (closed) return;
    closed = true;
    closeReason = closeReason || reason;
    // Commands still in flight can never answer — fail them, don't hang.
    while (pending.length) pending.shift().resolve({ ok: false, lines: [], error: 'control client closed' });
    if (onClose) onClose(closeReason);
  };

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('latin1');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      handleLine(line);
    }
  });
  child.stderr.on('data', () => { /* tmux -C narrates nothing useful here */ });
  child.on('error', (e) => finish(`tmux failed to start: ${e.message}`));
  child.on('exit', (code, signal) => finish(closeReason || `tmux exited (${signal || code})`));
  // A write to a dying tmux surfaces EPIPE / ERR_STREAM_DESTROYED as an ASYNC
  // 'error' on the stdin stream. Without a listener that is an unhandled
  // exception — in the daemon it would take down the whole process, not just
  // the one dead tmux. Treat it as the tap closing (the child 'exit' usually
  // follows and is idempotent here).
  child.stdin.on('error', (e) => finish(`tmux stdin error: ${e.message}`));

  function handleLine(line) {
    if (block) {
      // Inside a block ONLY its own terminator ends it. Everything else is
      // VERBATIM body — a body line that happens to start with `%output`/
      // `%exit` is captured pane content, not a notification (tmux holds real
      // notifications until the block closes), so it must never be dispatched.
      if (line.startsWith('%end ') || line.startsWith('%error ')) {
        const done = block;
        done.error = line.startsWith('%error ');
        block = null;
        if (done.isReply && pending.length) {
          pending.shift().resolve({ ok: !done.error, lines: done.lines });
        }
        return;
      }
      block.lines.push(line);
      return;
    }
    if (line.startsWith('%begin ')) {
      // "%begin <time> <num> <flags>" — flags bit 1 ⇒ a client command's
      // reply; the attach greeting carries 0 and is discarded on %end.
      const flags = parseInt(line.split(' ')[3] || '0', 10);
      block = { lines: [], isReply: (flags & 1) === 1 };
      return;
    }
    if (NOTIFICATION.test(line)) dispatch(line);
    // Anything untagged outside a block is protocol noise — ignored.
  }

  function dispatch(line) {
    if (line.startsWith('%output ')) {
      // "%output %<pane> <octal-escaped bytes>" — the pane id runs from the
      // 8th char to the next space, and the payload starts after it. THE PANE
      // ID IS KEPT (Phase B): it is the routing key the Hub filters on.
      const sp = line.indexOf(' ', 8);
      if (sp !== -1 && onOutput) onOutput(line.slice(8, sp), unescapeOctal(line.slice(sp + 1)));
      return;
    }
    if (line.startsWith('%exit')) {
      closeReason = `tmux session ended (${line.slice(6).trim() || 'detached'})`;
      // %exit is authoritative; the child's own exit follows and calls finish.
      return;
    }
    if (onEvent) {
      const sp = line.indexOf(' ');
      onEvent(sp === -1 ? line.slice(1) : line.slice(1, sp), sp === -1 ? '' : line.slice(sp + 1));
    }
  }

  return {
    // One tmux command per line — every command's reply block consumes a FIFO
    // slot, so everything goes through here. The line must be newline-free by
    // construction — refuse instead of silently truncating the protocol.
    command(line) {
      if (closed) return Promise.resolve({ ok: false, lines: [], error: 'control client closed' });
      if (/[\r\n]/.test(line)) return Promise.resolve({ ok: false, lines: [], error: 'newline in tmux command' });
      return new Promise((resolve) => {
        const entry = { resolve };
        pending.push(entry);
        try {
          child.stdin.write(line + '\n');
        } catch (e) {
          // Synchronous throw on a destroyed pipe (a raced tmux death): fail
          // THIS command now; the 'exit'/stdin-'error' handler fails the rest.
          const idx = pending.indexOf(entry);
          if (idx !== -1) pending.splice(idx, 1);
          resolve({ ok: false, lines: [], error: `tmux stdin write failed: ${e.message}` });
        }
      });
    },
    kill() {
      closeReason = closeReason || 'stopped';
      try { child.stdin.write('detach-client\n'); } catch { /* already gone */ }
      // A detach answers with %exit + EOF; the timer is the backstop.
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 1500);
      if (t.unref) t.unref();
    },
    get closed() { return closed; },
  };
}

// ---------------------------------------------------------------------------
// ControlHub — NEW in Phase B. One control client per (tmux socket, tmux
// SESSION), refcounted by the panes registered on it.
//
// Why a hub at all: `tmux -C attach` is per SESSION. Two panes of the same
// session shared to the phone must not cost two attaches — two control clients
// are two CLIENTS, and `window-size latest` would let their `refresh-client -C`
// calls fight over the window geometry forever. One client, N pane
// registrations, `%output` routed by pane id.
//
// Teardown is IDENTITY-GUARDED (gotcha #66, the finding-#7 scar): a replaced
// client's async onClose used to clear the live entry unconditionally,
// orphaning the fresh attachment. Every callback here first checks that the
// entry still points at the very instance that fired it.
class ControlHub {
  constructor({ tmuxBin = 'tmux', socketArgs = [], narrate = () => {}, create = createControl } = {}) {
    this.tmuxBin = tmuxBin;
    this.socketArgs = socketArgs;
    this.narrate = narrate;
    this.create = create;
    this.entries = new Map(); // sessionName → { control, panes: Map(paneId → onOutput), lastGeometry }
  }

  // Register a pane on the control client of `sessionName`, attaching one if
  // this is the first pane there. `onOutput(bytes)` receives ONLY this pane's
  // bytes. `onLost(reason)` fires when the underlying client dies for any
  // reason (session gone, rename, detach) — the mirror marks itself detached
  // and the next reseed re-attaches from scratch (a reseed heals everything).
  attach(sessionName, paneId, { onOutput, onLost = () => {} }) {
    let entry = this.entries.get(sessionName);
    if (!entry || entry.control.closed) {
      entry = { control: null, panes: new Map(), lastGeometry: null, session: sessionName };
      this.entries.set(sessionName, entry);
      entry.control = this.create({
        tmuxBin: this.tmuxBin,
        socketArgs: this.socketArgs,
        target: sessionName,
        onOutput: (pid, bytes) => {
          // Identity guard: a dying client's last bytes must never be routed
          // through a successor's pane table.
          if (this.entries.get(sessionName) !== entry) return;
          const fn = entry.panes.get(pid);
          if (fn) fn(bytes);
        },
        onEvent: (tag) => {
          if (this.entries.get(sessionName) !== entry) return;
          // %session-renamed is a HIGH death (old-arc finding #10): after a
          // rename this client's `-t <name>` target is a lie and every
          // send-keys/capture silently addresses nothing. Kill the tap loudly.
          // Phase B recovers automatically: pane ids are STABLE, so the next
          // reseed re-resolves the session NAME from the pane id and attaches
          // a fresh client (see Daemon.hubAttach).
          if (tag === 'session-renamed') {
            this.narrate(`pidge terminal: tmux session ${JSON.stringify(sessionName)} was RENAMED — the mirror's control client is dead (its attach target no longer exists). The next reseed re-resolves the name from the pane id and re-attaches.`);
            this.drop(sessionName, entry, 'the tmux session was renamed');
          }
        },
        onClose: (reason) => {
          if (this.entries.get(sessionName) !== entry) return; // superseded (#66)
          this.drop(sessionName, entry, reason);
        },
      });
    }
    entry.panes.set(paneId, onOutput);
    entry.lost ||= new Map();
    entry.lost.set(paneId, onLost);
    return {
      control: entry.control,
      // Refcount down. The LAST pane to leave takes the client with it —
      // re-attaching is cheap and a reseed cures whatever was missed, so
      // erring toward standing down early is safe by construction (§19).
      release: () => {
        const live = this.entries.get(sessionName);
        if (live !== entry) return; // already superseded — nothing of ours left
        entry.panes.delete(paneId);
        entry.lost.delete(paneId);
        if (entry.panes.size) return;
        this.entries.delete(sessionName);
        try { entry.control.kill(); } catch { /* already gone */ }
      },
    };
  }

  // Tear one entry down and tell every pane registered on it. Never called for
  // an entry that has already been replaced (every caller identity-guards).
  drop(sessionName, entry, reason) {
    this.entries.delete(sessionName);
    for (const [, onLost] of entry.lost || []) {
      try { onLost(reason); } catch { /* a mirror's bookkeeping must not kill the hub */ }
    }
    entry.panes.clear();
    try { entry.control.kill(); } catch { /* already gone */ }
  }

  // Diagnostics for `pidge terminal doctor` / GET /mirror.
  stats() {
    return [...this.entries.entries()].map(([session, e]) => ({
      session,
      panes: [...e.panes.keys()],
      alive: !e.control.closed,
    }));
  }

  get size() { return this.entries.size; }

  stopAll() {
    for (const [name, entry] of [...this.entries]) this.drop(name, entry, 'the daemon is shutting down');
  }
}

module.exports = { createControl, ControlHub };
