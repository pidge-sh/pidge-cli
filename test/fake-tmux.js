#!/usr/bin/env node
'use strict';
// A scripted tmux stand-in for the terminal tests — speaks just enough of the
// CLI surface and of control mode (-C) that `pidge terminal` exercises:
//   -V · has-session · new-session · set-option · -C attach
// Control-mode fidelity mirrors real tmux 3.7 behavior: greeting block with
// flags 0, command replies with flags 1 (in order), %output payloads
// octal-escaped, %exit + EOF on detach.
//
// Coordination happens through FAKE_TMUX_DIR:
//   sessions.json   — {name: {cmd}} the fake's session table
//   keys.log        — every send-keys/refresh-client line received (append)
//   emit.txt        — drop bytes here → emitted as %output, file unlinked
//   alt.txt         — scripted #{alternate_on} answers, one per line: each
//                     display-message read consumes a line, the LAST line
//                     sticks (missing file = 0). "1" = stable alt screen;
//                     "1\n0" = the two seed reads DISAGREE (TUI exited
//                     mid-seed — the fail-closed case)
//   die             — create it → the fake emits %exit and quits (session died)
// Echo behavior: a literal send-keys is echoed back as %output (like a shell
// would), so input→output round-trips are testable without a real shell.

const fs = require('node:fs');
const path = require('node:path');

const dir = process.env.FAKE_TMUX_DIR;
if (!dir) { console.error('fake-tmux: FAKE_TMUX_DIR not set'); process.exit(1); }
const sessionsFile = path.join(dir, 'sessions.json');
const keysLog = path.join(dir, 'keys.log');
const readSessions = () => { try { return JSON.parse(fs.readFileSync(sessionsFile, 'utf8')); } catch { return {}; } };
const writeSessions = (s) => fs.writeFileSync(sessionsFile, JSON.stringify(s));

const args = process.argv.slice(2);
if (args[0] === '-L') args.splice(0, 2); // socket name — irrelevant to the fake

if (args[0] === '-V') { console.log('tmux 3.7b'); process.exit(0); }

const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};

if (args[0] === 'has-session') {
  const t = String(flag('-t') || '').replace(/^=/, '');
  process.exit(readSessions()[t] ? 0 : 1);
}
if (args[0] === 'new-session') {
  let name = null;
  let cwd = null;
  const rest = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '-d') continue;
    if (a === '-s') { name = args[++i]; continue; }
    if (a === '-c') { cwd = args[++i]; continue; }
    if (a === '-x' || a === '-y') { ++i; continue; }
    rest.push(a);
  }
  const sessions = readSessions();
  sessions[String(name)] = { cmd: rest.length ? rest.join(' ') : null, ...(cwd ? { cwd } : {}) };
  writeSessions(sessions);
  process.exit(0);
}
if (args[0] === 'set-option') process.exit(0);
if (args[0] === 'list-sessions') {
  const sessions = readSessions();
  const names = Object.keys(sessions);
  if (!names.length) { console.error('no server running'); process.exit(1); }
  for (const n of names) console.log(`${n}\t80\t24`);
  process.exit(0);
}

if (args[0] !== '-C' || args[1] !== 'attach') {
  console.error(`fake-tmux: unhandled args ${JSON.stringify(args)}`);
  process.exit(1);
}

// ---- control mode ----------------------------------------------------------
const out = (s) => process.stdout.write(s + '\n');
const octal = (buf) => {
  let s = '';
  for (const b of buf) {
    if (b === 0x5c) s += '\\134';
    else if (b < 0x20 || b > 0x7e) s += '\\' + b.toString(8).padStart(3, '0');
    else s += String.fromCharCode(b);
  }
  return s;
};
const emitOutput = (bytes) => out(`%output %0 ${octal(Buffer.from(bytes))}`);

let num = 100;
const reply = (lines = [], ok = true) => {
  num += 1;
  out(`%begin 1 ${num} 1`);
  for (const l of lines) out(l);
  out(`${ok ? '%end' : '%error'} 1 ${num} 1`);
};

out('%begin 1 99 0');
out('%end 1 99 0');
out('%session-changed $0 fake');

// Unquote ONE single-quoted tmux argument (the '\'' splice included): walk
// quoted runs, honoring \' between them.
function unquote(s) {
  let res = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === "'") {
      const j = s.indexOf("'", i + 1);
      res += s.slice(i + 1, j === -1 ? s.length : j);
      i = j === -1 ? s.length : j + 1;
    } else if (s[i] === '\\' && s[i + 1] === "'") {
      res += "'";
      i += 2;
    } else {
      res += s[i];
      i += 1;
    }
  }
  return res;
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('latin1');
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    handle(line);
  }
});

// One scripted #{alternate_on} answer per read: alt.txt holds a line per read,
// consumed in order, last line sticky — lets a test flip the value BETWEEN the
// seed's two reads (the mid-seed TUI exit) without racing the mirror.
function readAlt() {
  const altFile = path.join(dir, 'alt.txt');
  let lines;
  try { lines = fs.readFileSync(altFile, 'utf8').split('\n').filter((l) => l.trim() !== ''); } catch { return '0'; }
  if (!lines.length) return '0';
  if (lines.length > 1) fs.writeFileSync(altFile, lines.slice(1).join('\n'));
  return lines[0].trim();
}

function handle(line) {
  if (line.startsWith('display-message')) {
    // Expand the two format shapes the mirror sends (geometry+alt for the
    // seed's first read, bare alternate_on for the confirm read).
    if (line.includes('#{alternate_on}')) {
      return reply([line.includes('#{pane_width}') ? `80 24 ${readAlt()}` : readAlt()]);
    }
    return reply(['80 24']);
  }
  // The last line deliberately LOOKS like a %output notification: real pane
  // content (a log, a paste) can start with `%output`/`%exit`, and the parser
  // must keep it as verbatim seed body, never dispatch it into the live stream.
  if (line.startsWith('capture-pane')) return reply(['seed-line-1', 'seed-line-2 \x1b[1mbold\x1b[0m', '%output %9 NOT_A_REAL_NOTIFICATION']);
  if (line.startsWith('send-keys') || line.startsWith('refresh-client')) {
    fs.appendFileSync(keysLog, line + '\n');
    reply([]);
    // Echo a literal back as pane output (shell-echo stand-in).
    const lit = /-l -- (.+)$/.exec(line);
    if (lit) emitOutput(unquote(lit[1]));
    return;
  }
  if (line.startsWith('detach-client')) {
    fs.appendFileSync(keysLog, line + '\n'); // stand-down is observable
    reply([]);
    out('%exit');
    process.exit(0);
  }
  reply([], false); // unknown command — %error, like real tmux
}

// Session death is signalled by the `die` file (the watcher below), matching
// how a killed tmux session surfaces to a control client: %exit, then EOF.
setInterval(() => {
  if (fs.existsSync(path.join(dir, 'die'))) {
    out('%exit');
    process.exit(0);
  }
  const emitFile = path.join(dir, 'emit.txt');
  if (fs.existsSync(emitFile)) {
    const bytes = fs.readFileSync(emitFile);
    fs.unlinkSync(emitFile);
    emitOutput(bytes);
  }
}, 50);
