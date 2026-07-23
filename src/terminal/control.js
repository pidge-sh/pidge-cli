'use strict';
// tmux CONTROL MODE client (`tmux -C attach`) — the whole tap is a child
// process speaking a line protocol over stdio: no PTY, no native deps.
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
//     output lines VERBATIM between %begin/%end — including raw ESC bytes.
//     Only the block's own terminator ends it; a known notification tag
//     inside is dispatched as the async event it is.
//   · %exit means THIS client is done (detach, session killed, server gone) —
//     stdout EOF follows.

const { spawn } = require('node:child_process');
const { unescapeOctal } = require('./wire');

// Async notifications tmux may emit at any moment. Anything tagged but
// unknown is IGNORED (additive evolution — a newer tmux must not break us);
// %output/%exit/%layout-change are the ones the mirror actually consumes.
const NOTIFICATION = /^%(output|exit|layout-change|window-add|window-close|window-renamed|window-pane-changed|unlinked-window-add|unlinked-window-close|unlinked-window-renamed|session-changed|session-renamed|session-window-changed|sessions-changed|client-session-changed|client-detached|pane-mode-changed|subscription-changed|paste-buffer-changed|paste-buffer-deleted|continue|pause|extended-output|config-error|message)\b/;

// One control-mode connection to one tmux session.
//   createControl({ target, socketName?, onOutput(bytes), onEvent(tag, rest), onClose(reason) })
// → { command(line) → Promise<{ok, lines}>, write(line), kill() }
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

  function handleLine(line) {
    if (block) {
      // Inside a block: only its own terminator ends it; async notifications
      // may interleave and are dispatched; everything else is body.
      if (line.startsWith('%end ') || line.startsWith('%error ')) {
        const done = block;
        done.error = line.startsWith('%error ');
        block = null;
        if (done.isReply && pending.length) {
          pending.shift().resolve({ ok: !done.error, lines: done.lines });
        }
        return;
      }
      if (NOTIFICATION.test(line)) { dispatch(line); return; }
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
      // "%output %<pane> <octal-escaped bytes>" — the payload starts after
      // the space that follows the pane id.
      const sp = line.indexOf(' ', 8);
      if (sp !== -1 && onOutput) onOutput(unescapeOctal(line.slice(sp + 1)));
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
    // One tmux command per line — send-keys relays included (every command's
    // reply block consumes a FIFO slot, so everything goes through here). The
    // line must be newline-free by construction (wire.js splits literals on
    // newlines) — refuse instead of silently truncating the protocol.
    command(line) {
      if (closed) return Promise.resolve({ ok: false, lines: [], error: 'control client closed' });
      if (/[\r\n]/.test(line)) return Promise.resolve({ ok: false, lines: [], error: 'newline in tmux command' });
      return new Promise((resolve) => {
        pending.push({ resolve });
        child.stdin.write(line + '\n');
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

module.exports = { createControl };
