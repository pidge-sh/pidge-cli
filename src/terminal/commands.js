'use strict';
// `pidge terminal <sub>` — the user-facing side of Agent Sessions v1
// (agent-sessions-spec §2). connect = once per computer (claim exchange +
// consent + hooks + skill + daemon install); enable happens in the DAEMON, on
// the PreToolUse hook that carries the sentinel the human pasted into the
// session (see core.ENABLE_PROMPT and daemon.enableFromSentinel) — this file's
// `enable` is a friendly confirmation of that, never the mechanism;
// disable/status/disconnect complete the lifecycle. Everything session-scoped
// talks to the LOCAL daemon over loopback — commands never publish anything
// themselves.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { execFileSync, spawn } = require('child_process');
const core = require('./core');
const { buildPairingPayload } = require('./pairing');
const { qrEncodeText, qrRenderTerminal } = require('./qr');
const { formatFrameActivity } = require('./mirror');

const PIDGE_HOOK_MARKER = '# pidge-hook';
const DAEMON_PORT = 41717;
const LAUNCHD_LABEL = 'sh.pidge.terminal';
const SYSTEMD_UNIT = 'pidge-terminal.service';
const HOOK_EVENTS = [
  ['SessionStart', 'session-start', 10],
  ['PreToolUse', 'pre-tool-use', 90], // holds for the approval gate (spec §9)
  ['Notification', 'notification', 10],
  ['Stop', 'stop', 10],
];

function die(msg, code = 1) { console.error(msg); process.exit(code); }
function say(msg) { console.log(msg); }

async function daemonCall(method, p, body) {
  const cfg = core.readJson(core.DAEMON_FILE(), null);
  if (!cfg) throw new Error('not connected — run `pidge terminal connect` first');
  const res = await core.fetchT(`http://127.0.0.1:${cfg.port}${p}`, {
    method,
    headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, 65_000);
  let data = null;
  try { data = await res.json(); } catch {}
  return { res, data };
}

async function daemonAlive() {
  try {
    const { res, data } = await daemonCall('GET', '/health');
    return res.status === 200 ? data : null;
  } catch { return null; }
}

// Ask the RUNNING daemon (if any) to exit — the loopback half of the
// `connect --replace` recycle (review A2). Returns true when a daemon
// answered the shutdown; false when nothing was listening or the bearer did
// not match (a daemon that refuses our token is NOT ours to kill). After a
// successful shutdown, wait for the port to actually free so the fresh
// daemon cannot die on EADDRINUSE against the exiting one.
async function shutdownLocalDaemon() {
  const cfg = core.readJson(core.DAEMON_FILE(), null);
  if (!cfg || !cfg.port || !cfg.token) return false;
  let res;
  try {
    res = await core.fetchT(`http://127.0.0.1:${cfg.port}/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.token}` },
    }, 3000);
  } catch { return false; } // nothing listening — nothing to recycle
  if (!res.ok) return false; // 401: not our daemon — leave it alone
  for (let i = 0; i < 20; i++) {
    try {
      await core.fetchT(`http://127.0.0.1:${cfg.port}/health`, {}, 500);
    } catch { return true; } // connection refused — it is gone
    await new Promise((r) => setTimeout(r, 100));
  }
  console.error('pidge terminal: WARNING — the old daemon acknowledged the shutdown but its port is still held; the fresh daemon may collide (EADDRINUSE) and exit until the service manager retries');
  return true;
}

// --- connect ----------------------------------------------------------------

async function askYesNo(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

// The claim exchange (retry-safe per fingerprint — the pidge server's #52
// contract): a network fumble re-runs to the SAME key, never a rotation. The
// SAME fingerprint also makes the --qr reprompt loop harmless: every retyped
// attempt is one more idempotent try, never a second identity.
function claimFingerprint() {
  return crypto.createHash('sha256').update(`pidge-terminal:${os.hostname()}:${core.terminalDir()}`).digest('base64url').slice(0, 32);
}
// THROWS on a network failure (the caller decides: --code dies one-shot, the
// --qr loop narrates and reprompts). Non-404 HTTP failures come back as
// { httpStatus } for the same split — only 2xx carries the identity.
async function claimExchange(base, code) {
  const res = await core.fetchT(`${base}/api/v1/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pidge-fingerprint': claimFingerprint() },
    body: JSON.stringify({ code }),
  });
  if (res.status === 404) return { notFound: true };
  if (!res.ok) return { httpStatus: res.status };
  const data = await res.json();
  return {
    token: data.key,
    channelId: data.channel && data.channel.id,
    effectiveBase: (data.base_url || base).replace(/\/$/, ''),
    serverKind: (data.channel && data.channel.kind) || null,
  };
}

// --- the interactive prompt session (connect --qr) ---------------------------
//
// ONE readline interface for the WHOLE interactive connect: the claim loop AND
// the consent prompt read from it. Two interfaces in sequence lose lines
// buffered between them (a pasted "code\ny\n" left the consent hanging
// forever), and a question pending on an ENDED stdin dissolves silently — the
// event loop empties and node exits 0 MID-FLOW, a half install wearing a
// success code. Here end-of-input is an EXPLICIT die at every read point.
//
// Lines are COLLECTED continuously, never read with rl.question() (question()
// drops a line that arrives while an await is in flight), and the buffer is
// BOUNDED: a 300-line paste must not become 300 claim POSTs.
const PROMPT_PENDING_MAX = 32;

function makePromptSession() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const pending = [];
  let ended = false;
  let wake = null;
  const kick = () => { if (wake) { const w = wake; wake = null; w(); } };
  rl.on('line', (l) => { if (pending.length < PROMPT_PENDING_MAX) pending.push(l); kick(); });
  rl.on('close', () => { ended = true; kick(); });
  // ctrl-C on a TTY reaches the interface, not the process — same contract
  // either way: every reader sees the end and dies explicitly.
  rl.on('SIGINT', () => { ended = true; kick(); });
  return {
    /// → the next line, or null when input ENDED (the caller dies explicitly,
    /// with a message that fits what was or wasn't persisted at that point).
    async nextLine(prompt) {
      process.stdout.write(prompt);
      while (!pending.length && !ended) await new Promise((resolve) => { wake = resolve; });
      return pending.length ? pending.shift() : null;
    },
    close() { rl.close(); },
  };
}

// §24.2.4 — the blocking prompt of `connect --qr`. A 404 is uniform by design
// (#52: unknown = expired = mistyped) and REPROMPTS; a network fumble or a
// non-404 HTTP failure ALSO reprompts (every retry is idempotent per #52's
// fingerprint binding — and an unhandled throw here would take K down with a
// raw stack). Attempts are CAPPED: past that, the honest exit is a fresh
// pairing, not more guessing.
const CLAIM_PROMPT_MAX_ATTEMPTS = 20;

async function promptClaimLoop(base, session) {
  let attempts = 0;
  for (;;) {
    const answer = await session.nextLine('Enter the code shown on your phone: ');
    if (answer === null) {
      die('pidge terminal connect: input ended before a code was typed — nothing was stored on this machine.\n' +
        "On your phone, tap 'Cancel this pairing'; when you retry, scan the FRESH QR (this one's key died with this process).", 130);
    }
    // Strip ASCII whitespace ONLY: the app groups the code with spaces for
    // typing, and claim codes legitimately contain `-`/`_` — any other
    // normalization would corrupt a valid code (spec §24.2).
    const code = String(answer).replace(/[\t\n\v\f\r ]+/g, '');
    if (!code) continue;
    attempts += 1;
    if (attempts > CLAIM_PROMPT_MAX_ATTEMPTS) {
      die("pidge terminal connect: too many failed attempts.\nOn your phone, tap 'Cancel this pairing' and re-run `pidge terminal connect --qr` for a fresh QR and a fresh code.", 2);
    }
    say('  checking the code…');
    let res;
    try {
      res = await claimExchange(base, code);
    } catch (e) {
      console.error(`That didn't reach the server (${e.message}) — check the network and type the code again.`);
      continue;
    }
    if (res.notFound) {
      console.error("That code is unknown, expired or mistyped — check the phone's screen and try again (the app re-mints with one tap).");
      continue;
    }
    if (res.httpStatus) {
      console.error(`The server answered ${res.httpStatus} — wait a moment and type the code again.`);
      continue;
    }
    return res;
  }
}

// The consent prompt when a session exists (the --qr flow): reading from the
// SAME session keeps pre-pasted answers alive, and an ended stdin here is a
// distinct, honest exit — the identity IS stored by now (the claim already
// rotated the key), so the message names the documented finish-install path.
async function askYesNoViaSession(session, question) {
  const answer = await session.nextLine(`${question} [y/N] `);
  if (answer === null) {
    die('pidge terminal connect: input ended at the consent prompt — the tunnel identity IS stored.\n' +
      'Re-run `pidge terminal connect` (no flags) in an interactive terminal to finish the hooks/skill/daemon install.', 130);
  }
  return /^y(es)?$/i.test(answer.trim());
}

async function runConnect(v) {
  const code = v.code || null;
  const base = (v.url || 'https://api.pidge.sh').replace(/\/$/, '');
  const secretRaw = process.env.PIDGE_SECRET || v.secret || null;
  const existing = core.loadTerminalEnv();

  // §24.2.1 — the two pairing doors must not half-mix: --qr mints its own key
  // and takes its code from the phone's screen, so a --code or a PIDGE_SECRET
  // alongside it is a confused invocation, not a preference.
  if (v.qr && (code || secretRaw)) {
    die('pidge terminal connect: --qr mints its own key and takes the code from the phone — do not combine it with --code or PIDGE_SECRET.\n' +
      'Use EITHER the app one-liner (phone-first) OR `pidge terminal connect --qr` (computer-first).');
  }

  // A NEW pairing over an EXISTING identity refuses LOUDLY (QA finding #9):
  // connect used to overwrite the slot in silence, leaving the old channel
  // alive on the server — an orphaned "Computer N" that counts against the
  // channel limit and shows in the app as a connected computer that never
  // reports again (Thiago has three of those). The slot being unique is
  // right — one computer, one identity; the SWITCH must be consented.
  // Re-running WITHOUT --code (finishing a half-done install) stays allowed.
  // --qr is a NEW pairing by definition, so it takes the same guard verbatim.
  if ((code || v.qr) && existing.token && !v.replace) {
    // NOTE: the suggestion is --replace, deliberately NOT `disconnect` —
    // disconnect keeps the identity file (review M1), so it would send the
    // human in a circle right back to this refusal.
    //
    // The NON-destructive path goes first (QA r7-3): both escapes this message
    // used to offer burn the pairing, but the real r7 case was a one-liner that
    // stored the identity and then stalled at the consent prompt — the fix was
    // re-running WITHOUT --code, which the guard above already allows and the
    // text never mentioned. Sending someone to --replace for that costs them
    // the channel they just claimed.
    die('pidge terminal connect: this computer is already connected to ' +
      `channel ${existing.channelId != null ? existing.channelId : '(unknown)'} at ${existing.base || '(unknown url)'}.\n` +
      'If you are finishing a half-done install on the SAME channel, just run `pidge terminal connect` again without --code.\n' +
      `To switch this computer to a DIFFERENT channel, run again with --replace — or delete ${core.ENV_FILE()} by hand and re-run.\n` +
      '(On either SWITCH path the OLD channel stays on the server — remove that computer in the app: Settings → Computers.)');
  }

  // Checked BEFORE the claim: if the service install at the end is going
  // to refuse, refusing here costs nothing — refusing after the claim burns a
  // pairing code and leaves the phone spinning on a computer that will never
  // connect (exactly the QA sequence). --no-daemon installs no service, so it
  // has no label to take.
  if (!v['no-daemon']) assertNoForeignDaemon();

  let token = existing.token;
  let channelId = existing.channelId;
  let effectiveBase = existing.base || base;
  let secret = secretRaw || existing.secret;
  // The one moment we KNOW this computer is about to run Agent Sessions — so
  // it is the one moment to notice this CLI is behind (an old copy is how the
  // whole pairing broke for the installed base: npx prefers a local install).
  await warnIfOutdated();

  // `kind` is validated AFTER the identity is persisted (below): the claim has
  // already rotated the key server-side, and dying here used to throw that key
  // away. Retry-safety (gotcha #52) covered it; the order was still wrong.
  let serverKind = null;
  let qrKf = null;
  let promptSession = null;
  if (v.qr) {
    // §24.4 — the QR must only ever meet a REAL terminal. Piped/redirected
    // stdout persists K wherever the pipe goes (a log, a CI transcript — or,
    // the acute case, an agent's Bash tool inside a SHARED session, whose
    // output is published into the mirrored transcript as re-decodable block
    // art). The env override exists for the integration suite ONLY, which
    // drives this flow through pipes by construction — never set it by hand.
    if (!process.stdout.isTTY && !process.env.PIDGE_QR_ALLOW_NO_TTY) {
      die('pidge terminal connect --qr: a QR is only useful on a real terminal — run it directly, not through a pipe, a redirect or an agent tool (the QR carries the computer key).');
    }
    // §24.2 — the computer-first door. Mint K locally (the BYOK generator
    // class: 32 bytes of CSPRNG), show it ONLY as a QR — K leaves this machine
    // by CAMERA, never by clipboard or wire — then block on the code the
    // phone displays. NOTHING persists until the claim succeeds: abandoning
    // at the prompt (ctrl-C) leaves zero residue, K dies with the process.
    const key = crypto.randomBytes(32);
    qrKf = core.e2eKeyFingerprint(key);
    let payload;
    try {
      payload = buildPairingPayload({
        key, host: os.hostname().trim() || 'computer', os: core.computerOs(), baseUrl: base,
      });
    } catch (e) { die(`pidge terminal connect: ${e.message}`); }
    // The renderer receives ONLY the payload string (§24.5); the payload is a
    // secret and is never logged or printed as text.
    say('\nScan this QR with the Pidge app — Settings → Computers → Connect a computer → "From the computer":\n');
    say(qrRenderTerminal(qrEncodeText(payload)));
    say(`\n  key fingerprint: ${qrKf}   (the app must show these SAME six characters)`);
    say('  ⚠ this QR carries the computer key — do not share your screen while it is visible');
    say("  (QR doesn't fit? zoom the terminal out — ⌘− / ctrl−− — or enlarge the window)\n");
    // ONE session carries every remaining prompt (claim code + consent) —
    // see makePromptSession for why two interfaces lose lines and why EOF
    // must die explicitly instead of letting node exit 0 mid-install.
    promptSession = makePromptSession();
    const claim = await promptClaimLoop(base, promptSession);
    token = claim.token;
    channelId = claim.channelId;
    effectiveBase = claim.effectiveBase;
    serverKind = claim.serverKind;
    secret = key.toString('base64url');
  } else if (code) {
    let res;
    try {
      res = await claimExchange(base, code);
    } catch (e) {
      die(`pidge terminal connect: claim failed (network): ${e.message} — is the server URL right? (${base})`, 2);
    }
    if (res.notFound) die('pidge terminal connect: that code is unknown, expired or already used by another machine — mint a fresh one in the app (Settings → Computers → Connect a computer)');
    if (res.httpStatus) die(`pidge terminal connect: claim exchange failed (${res.httpStatus})`);
    token = res.token;
    channelId = res.channelId;
    effectiveBase = res.effectiveBase;
    serverKind = res.serverKind;
  }
  if (!token) die('pidge terminal connect: no stored identity and no --code — paste the one-liner from the app (Settings → Computers → Connect a computer)');
  if (!secret) die('pidge terminal connect: PIDGE_SECRET missing — the app\'s Connect-a-computer one-liner carries it (E2E is mandatory on tunnels; there is no clear mode)');
  try { core.e2eParseSecret(secret); } catch (e) { die(`pidge terminal connect: ${e.message}`); }

  core.saveTerminalEnv({ base: effectiveBase, token, secret, channelId });
  say(`✓ tunnel identity stored (${core.ENV_FILE()}, 0600)`);
  // §24.2.5 — kf at success, so eyes can compare against the app. Equality
  // needs no ceremony: the phone stored the K it scanned, this machine holds
  // the K it minted — the same bytes by construction, never via the server.
  // The first sealed publish proves it end-to-end.
  if (qrKf) say(`✓ computer key kept locally — fingerprint ${qrKf} (compare with the app's Computer screen)`);

  // Only refuse when the server ACTUALLY says a different kind. A server that
  // does not report `kind` at all (every deploy before manifest v100) is not
  // evidence of anything — reading `undefined !== 'tunnel'` as "wrong kind" is
  // what killed 100% of connects (QA finding #1); §12 says tolerate absence.
  if (serverKind && serverKind !== 'tunnel') {
    die(`pidge terminal connect: this code belongs to a ${serverKind} channel, not a tunnel — use the app's Settings → Computers → Connect a computer flow (it mints the right kind)`);
  }

  // Refresh the server caps from the manifest (never hardcode — spec §12).
  try {
    const res = await core.fetchT(`${effectiveBase}/api/v1/manifest`, { headers: { authorization: `Bearer ${token}` } });
    const manifest = await res.json();
    if (manifest.agent_sessions && manifest.agent_sessions.limits) {
      core.saveCaps({ ...core.DEFAULT_CAPS, ...manifest.agent_sessions.limits });
      say('✓ server limits cached from the manifest');
    }
  } catch { say('· manifest unreachable — using default limits (refreshed on next connect)'); }

  // Consent prompt — VERBATIM from the spec (§2). Hooks are local-only by
  // construction; nothing is shared until a per-session enable. The --qr flow
  // reads it from the SAME session as the claim prompt (a second readline
  // would drop a pre-pasted answer, and an ended stdin must die loudly here
  // — with the identity stored, the finish-install path is the honest exit).
  const consentQuestion =
    'Install Claude Code hooks so sessions can announce themselves to the local Pidge daemon?\n' +
    'Hooks talk only to this computer; nothing is shared until you enable a session.';
  const consent = v.yes
    || (promptSession ? await askYesNoViaSession(promptSession, consentQuestion)
                      : await askYesNo(consentQuestion));
  if (promptSession) { promptSession.close(); promptSession = null; }
  if (consent) {
    writeHookShim();
    // A malformed ~/.claude/settings.json aborts the install LOUDLY: we never
    // overwrite a config we could not read (see readClaudeSettings).
    try { installHooks(); } catch (e) { die(`${e.message}\n(the tunnel identity above is stored; re-run \`pidge terminal connect\` once the file parses)`); }
    say('✓ hooks installed in ~/.claude/settings.json (tagged, cleanly removable via `pidge terminal disconnect`)');
  } else {
    say('· hooks NOT installed — the enable door IS the PreToolUse hook, so nothing can be shared until you re-run connect and accept');
  }

  // The skill is the agent-side half of the door: a claude running an OLD rev
  // reads "enable yourself on Pidge" with its pre-existing meaning and goes
  // ONLINE on a notification channel instead (QA finding #2 — it drained and
  // acked 21 real messages while reporting success). connect is the one moment
  // we know this computer will be used for Agent Sessions, so it refreshes the
  // skill here. A failure WARNS — the hook door works without any skill.
  try {
    const file = installPidgeSkill({ base: effectiveBase, token });
    say(`✓ Pidge skill refreshed (${file})`);
  } catch (e) {
    console.error(`pidge terminal: WARNING — could not refresh the Pidge skill (${e.message}).\n  Fix it with:  cd ~ && npx -y pidge-cli@latest skill install\n  (sharing still works without it — the PreToolUse hook is the door, not the skill.)`);
  }

  // Daemon config + this computer's service manager (--no-daemon skips the
  // install on EVERY platform — the manual line is the same everywhere).
  const cfg = core.readJson(core.DAEMON_FILE(), null) || { port: DAEMON_PORT, token: crypto.randomBytes(24).toString('base64url') };
  core.writeJson(core.DAEMON_FILE(), cfg);
  // --replace: a daemon may still be RUNNING with the OLD identity in memory
  // (review A2). launchd's unload+load recycles it, but systemd's
  // `enable --now` is a NO-OP while the unit is active, and the detached
  // fallback's fresh daemon dies on EADDRINUSE while the old one keeps
  // publishing to the orphaned channel — a new enable then lands there in
  // silence. The loopback shutdown covers every platform the same way (and
  // --no-daemon too); the systemd installer adds a belt-and-braces restart.
  if (v.replace) {
    const wasUp = await shutdownLocalDaemon();
    if (wasUp) say('✓ stopped the running daemon (it held the previous tunnel identity in memory)');
  }
  if (v['no-daemon']) {
    say('· --no-daemon: start it yourself with `pidge terminal daemon`');
  } else {
    const svc = installDaemonService({ recycle: !!v.replace });
    if (svc.kind === 'launchd') say(`✓ daemon installed (launchd ${svc.label}) — logs at ${core.LOG_FILE()}`);
    else if (svc.kind === 'systemd') {
      say(`✓ daemon installed (systemd --user ${svc.label}) — logs at ${core.LOG_FILE()}`);
      say('  (survive logout: `loginctl enable-linger $USER`)');
    } else say(`· daemon logs at ${core.LOG_FILE()}`);
  }
  // Capability grants, in plain words (v2 decision §22.2). The human learns
  // what their phone may and may not do to this computer AT THE MOMENT they
  // link it — never buried in a settings screen on the other device.
  say('\nWhat your phone may do to this computer:');
  for (const line of core.grantLines()) say(`  ${line}`);

  say('\nDone. This computer is linked. To share a session: start (or restart) claude');
  say('inside its own tmux pane and PASTE this into it —\n');
  say(`  ${core.ENABLE_PROMPT}\n`);
  say('The PreToolUse hook catches that command and shares THAT session (per session id);');
  say('the command itself never runs, so it does not matter whether `pidge` is on your PATH.');
}

// --- the Pidge skill (agent-side half of the door) --------------------------

// Run `skill install` from the HOME dir, so the refreshed skill lands in
// ~/.claude/skills/pidge/SKILL.md — the copy EVERY session loads, not one
// project's. The child gets the tunnel identity purely to read the (public)
// manifest; the generated skill bakes no token. THROWS with a short message —
// the caller decides warn-vs-die (here: warn).
function installPidgeSkill({ base, token }) {
  const entry = cliEntryPath();
  const home = os.homedir();
  try {
    execFileSync(process.execPath, [entry, 'skill', 'install'], {
      cwd: home,
      env: { ...process.env, PIDGE_URL: base, PIDGE_TOKEN: token, PIDGE_QUIET_NAG: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 60_000,
      encoding: 'utf8',
    });
  } catch (e) {
    const detail = String((e && e.stderr) || (e && e.message) || '').trim().split('\n').slice(-1)[0];
    throw new Error(detail || 'skill install failed');
  }
  return path.join(home, '.claude', 'skills', 'pidge', 'SKILL.md');
}

// --- version self-check -----------------------------------------------------

// Never blocks and never installs behind the human's back: it says the one line
// that fixes it. (A network failure is silence — connect must work offline.)
async function warnIfOutdated() {
  if (process.env.PIDGE_NO_UPDATE_CHECK) return; // offline boxes + hermetic tests
  try {
    const { currentVersion, latestVersion, isOlder } = require('../update');
    const current = currentVersion();
    const latest = await latestVersion();
    if (!current || !latest || !isOlder(current, latest)) return;
    console.error(`pidge terminal: this CLI is ${current}; ${latest} is published. Update it first:  pidge update   (or: npm i -g pidge-cli@latest)`);
  } catch { /* best-effort — a version probe must never break connect */ }
}

// --- hook shim + settings.json installer ------------------------------------

function hookShimSource() {
  // Standalone by design: hooks must survive npx cache prunes and CLI
  // upgrades. Dependency-free, exits 0 ALWAYS (a broken shim must never
  // break claude), silent except the PreToolUse gate's decision JSON.
  return `#!/usr/bin/env node
'use strict';
// pidge terminal hook shim — generated by \`pidge terminal connect\`.
// Forwards Claude Code hook events to the LOCAL pidge daemon (loopback only).
// Safe by construction: any failure exits 0 silently and claude proceeds.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const EVENT = process.argv[2] || '';
const CFG = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'pidge', 'terminal', 'daemon.json');
function bail() { process.exit(0); }
let cfg; try { cfg = JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch { bail(); }
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', async () => {
  let body; try { body = JSON.parse(input || '{}'); } catch { body = {}; }
  try {
    // The short tty name (macOS 'ttys003', Linux 'pts/3') becomes the absolute
    // path tmux reports as #{pane_tty}. "no tty" is '??' on macOS and '?' on
    // Linux — both must resolve to null, never to '/dev/?'.
    body.tty = (() => {
      try {
        const t = execFileSync('ps', ['-o', 'tty=', '-p', String(process.pid)], { encoding: 'utf8' }).trim();
        return t && !/^\\?+$/.test(t) ? (t.startsWith('/') ? t : '/dev/' + t) : null;
      } catch { return null; }
    })();
    const ctl = new AbortController();
    const hold = EVENT === 'pre-tool-use' ? 80000 : 3000;
    const t = setTimeout(() => ctl.abort(), hold);
    const res = await fetch('http://127.0.0.1:' + cfg.port + '/hook/' + EVENT, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + cfg.token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (EVENT === 'pre-tool-use' && res.ok) {
      const data = await res.json();
      if (data && data.decision && data.decision.permissionDecision) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', ...data.decision },
        }));
      }
    }
  } catch {}
  bail();
});
`;
}

function writeHookShim() {
  core.writeFileAtomic(core.HOOK_SHIM(), hookShimSource(), 0o755);
}

function claudeSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function hookCommand(slug) {
  // The trailing marker is a shell comment — inert at run time, and the
  // uninstaller's handle (the AoE tagging pattern).
  return `"${process.execPath}" "${core.HOOK_SHIM()}" ${slug} ${PIDGE_HOOK_MARKER}`;
}

// Read ~/.claude/settings.json for a read-MODIFY-write cycle.
//
// Returns `null` when the file genuinely does not exist, and THROWS when it
// exists but does not parse. The tolerant `readJson(file, {})` this replaces
// swallowed a syntax error and the writer then persisted `{hooks:{…}}` over the
// user's real config — a whole Claude Code setup (model, permissions, env,
// statusLine, MCP) wiped by a stray trailing comma. A file we cannot understand
// is never a file we may overwrite.
function readClaudeSettings() {
  const file = claudeSettingsPath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`pidge terminal: cannot read ${file} (${e.message}) — refusing to touch it`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
    return parsed;
  } catch (e) {
    throw new Error(
      `pidge terminal: ${file} is not valid JSON (${e.message}).\n` +
      'Refusing to rewrite it — that would destroy your Claude Code settings.\n' +
      'Fix the file by hand (or move it aside) and re-run the command.');
  }
}

// Preserve the file's permissions across the rewrite: a settings.json the user
// deliberately kept at 0600 must not come back world-readable. A file we create
// ourselves starts private.
function claudeSettingsMode() {
  try { return fs.statSync(claudeSettingsPath()).mode & 0o777; } catch { return 0o600; }
}

function writeClaudeSettings(settings) {
  core.writeFileAtomic(claudeSettingsPath(), JSON.stringify(settings, null, 2) + '\n', claudeSettingsMode());
}

function installHooks() {
  const settings = readClaudeSettings() || {};
  settings.hooks = settings.hooks || {};
  for (const [event, slug, timeout] of HOOK_EVENTS) {
    const entries = (settings.hooks[event] || []).filter(
      (e) => !(e.hooks || []).some((h) => String(h.command || '').includes(PIDGE_HOOK_MARKER)));
    entries.push({
      ...(event === 'PreToolUse' ? { matcher: '*' } : {}),
      hooks: [{ type: 'command', command: hookCommand(slug), timeout }],
    });
    settings.hooks[event] = entries;
  }
  writeClaudeSettings(settings);
}

function uninstallHooks() {
  // Same rule as the installer: a settings.json we cannot parse is left ALONE.
  // Uninstall must not abort the rest of `disconnect`, so this one narrates and
  // returns instead of throwing — the hook lines stay, but they are inert once
  // the daemon and its shim are gone.
  let settings;
  try {
    settings = readClaudeSettings();
  } catch (e) {
    console.error(`${e.message}\n· hook entries left in place (they are inert without the daemon).`);
    return;
  }
  if (!settings || !settings.hooks) return;
  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = (settings.hooks[event] || []).filter(
      (e) => !(e.hooks || []).some((h) => String(h.command || '').includes(PIDGE_HOOK_MARKER)));
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  writeClaudeSettings(settings);
}

// --- the daemon service (launchd · systemd --user · detached fallback) -------
//
// The feature is not macOS-only: it needs node + tmux, which every developer
// box has. So the supervisor is chosen per platform — launchd on macOS,
// `systemd --user` on Linux (including WSL2 with systemd enabled) — and a
// computer with NO user service manager (an older WSL, a container) still gets
// a RUNNING daemon plus the two lines that make it durable. Never a hard
// failure: `connect` that half-works is worse than one that says what's left.

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function xmlUnescape(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// systemd unit-file quoting: double quotes with backslash escapes, PLUS the
// unit-file expansions ('$$' = literal $, '%%' = literal %) — a node path or a
// PATH entry containing either must arrive verbatim.
function systemdQuote(s) {
  return '"' + String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, () => '$$')
    .replace(/%/g, '%%') + '"';
}

function launchdPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function systemdUnitPath() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'systemd', 'user', SYSTEMD_UNIT);
}

// PIDGE_TERMINAL_PLATFORM: test hook so EVERY template is exercised on any OS
// (same shape as the bridge installer's PIDGE_BRIDGE_PLATFORM).
function daemonPlatform(probe = {}) {
  return probe.platform || process.env.PIDGE_TERMINAL_PLATFORM || process.platform;
}

// --- the label is per-USER, the config slot is per-ENV ----------------------
//
// `sh.pidge.terminal` / `pidge-terminal.service` are ONE name per user account,
// but the config slot they serve is resolved from HOME/XDG_CONFIG_HOME at run
// time. Connect from a shell with a custom env therefore installs a service
// under the SAME label as the machine's real daemon — and bootstrapping it
// boots the real one out, silently, in favour of an identity the human never
// meant to replace. Observed in QA: an isolated install took the label, launchd
// started it with the REAL $HOME, and the freshly paired identity never
// connected while the real one silently went dark.
//
// So before writing any template we ask the OS which config slot the existing
// service serves, and refuse to take the label from a stranger.

// The terminal dir a service template (or a `launchctl print` dump) SERVES,
// recovered from its own text. The log path is the reliable giveaway across
// every version we ever shipped — it is always `<terminalDir>/terminal.log` —
// so this reads pre-0.44.1 installs, which carry no pinned env, just as well.
function serviceTerminalDir(text) {
  const s = String(text || '');
  let m = s.match(/<key>StandardOutPath<\/key>\s*<string>([^<]*)<\/string>/); // launchd plist
  if (m) return path.dirname(xmlUnescape(m[1]).trim());
  m = s.match(/^StandardOutput=append:(.+)$/m); // systemd unit
  if (m) return path.dirname(m[1].trim());
  m = s.match(/^\s*stdout path\s*=\s*(.+)$/m); // `launchctl print` prose
  if (m) return path.dirname(m[1].trim());
  // Last resort: the CLI copy a service runs lives at <terminalDir>/cli/bin/pidge.js.
  m = s.match(/([^\s"'<>]*)\/cli\/bin\/pidge\.js/);
  return m && m[1] ? xmlUnescape(m[1]) : null;
}

// Same directory, allowing for symlinked prefixes (/tmp → /private/tmp on
// macOS would otherwise read as a stranger and refuse a legitimate restart).
function sameDir(a, b) {
  const norm = (p) => path.resolve(String(p)).replace(/\/+$/, '');
  if (norm(a) === norm(b)) return true;
  const real = (p) => { try { return fs.realpathSync(norm(p)); } catch { return norm(p); } };
  return real(a) === real(b);
}

// A capturing runner — deliberately NOT `probe.run`, which is stdio:'ignore'.
function serviceQuery(probe = {}) {
  return probe.query || ((cmd, args) => {
    try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { return ''; }
  });
}

function readIfFile(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

// The config slot an ALREADY installed service serves, when that is not the one
// this process would install. Returns null when there is nothing installed, or
// when it is ours (the normal restart), or when the slot it names no longer
// exists on disk — rubble holds no identity, and refusing over it would leave
// a human with a dead plist and no way forward.
function foreignDaemonConfig(probe = {}) {
  const mine = core.terminalDir();
  const query = serviceQuery(probe);
  const found = [];
  if (daemonPlatform(probe) === 'darwin') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const dir = serviceTerminalDir(query('launchctl', ['print', `gui/${uid}/${LAUNCHD_LABEL}`]));
    if (dir) found.push({ dir, where: `the launchd job already loaded as ${LAUNCHD_LABEL}` });
    const file = launchdPlistPath();
    const onDisk = serviceTerminalDir(readIfFile(file));
    if (onDisk) found.push({ dir: onDisk, where: file });
  } else {
    const systemd = probe.systemd !== undefined ? probe.systemd : hasSystemd();
    if (!systemd) return null; // no service manager ⇒ no shared label to take
    const frag = String(query('systemctl', ['--user', 'show', '-p', 'FragmentPath', '--value', SYSTEMD_UNIT]) || '').trim();
    if (frag) {
      const dir = serviceTerminalDir(readIfFile(frag));
      if (dir) found.push({ dir, where: `the unit ${SYSTEMD_UNIT} already installed at ${frag}` });
    }
    const file = systemdUnitPath();
    const onDisk = serviceTerminalDir(readIfFile(file));
    if (onDisk) found.push({ dir: onDisk, where: file });
  }
  for (const f of found) {
    if (sameDir(f.dir, mine)) continue;
    if (!fs.existsSync(f.dir)) continue;
    return { dir: f.dir, where: f.where, mine };
  }
  return null;
}

// <configHome>/pidge/terminal → the env that reaches that slot again. HOME is
// preferred whenever the slot sits in a plain `.config`, because it addresses
// BOTH halves at once: the config dir resolves through XDG_CONFIG_HOME while
// the launchd plist only ever lives under $HOME, so an XDG-only prefix would
// read the right config and then address the WRONG plist — advice that breaks
// a third daemon while retiring the second.
function slotEnvPrefix(dir) {
  const configHome = path.dirname(path.dirname(dir));
  return path.basename(configHome) === '.config'
    ? `HOME=${path.dirname(configHome)}`
    : `XDG_CONFIG_HOME=${configHome}`;
}

// Refuse the hijack, naming BOTH slots and the two ways out. Never guesses for
// the human: which identity survives is their call, not the installer's.
function assertNoForeignDaemon(probe = {}) {
  const foreign = foreignDaemonConfig(probe);
  if (!foreign) return null;
  const env = slotEnvPrefix(foreign.dir);
  die('pidge terminal connect: this computer already runs a pidge daemon for a DIFFERENT config slot.\n' +
    `  already installed:  ${foreign.dir}\n` +
    `                      (${foreign.where})\n` +
    `  this run would use: ${foreign.mine}\n` +
    '\n' +
    'Both want the same per-user service name, so installing this one would boot the\n' +
    'other daemon out — silently, taking its identity offline. Refusing.\n' +
    'Pick one:\n' +
    '  · connect the EXISTING slot instead — re-run with its environment:\n' +
    `      ${env} pidge terminal connect\n` +
    '  · or retire it first, then re-run this connect:\n' +
    `      ${env} pidge terminal disconnect`);
  return null;
}

// The OTHER half of the same address, and the reason this exists at all: the
// two ends of a teardown are resolved from DIFFERENT variables. The config slot
// comes from XDG_CONFIG_HOME (falling back to $HOME/.config) while the launchd
// plist is only ever `$HOME/Library/LaunchAgents/<label>.plist` — launchd reads
// nowhere else, so there is no pinning that could make an XDG-only environment
// address its own plist. Under a custom XDG_CONFIG_HOME, `disconnect` therefore
// read the right config and would unload a plist belonging to a THIRD slot:
// retiring one identity by taking a different one offline, silently, which is
// the exact shape install already refuses.
//
// So teardown asks the same question install asks — which slot does the
// installed service actually SERVE — and stops when the answer is not ours. All
// the recognition (launchctl print, the unit FragmentPath, the template on
// disk, rubble tolerated, symlinked prefixes) is foreignDaemonConfig's,
// unchanged: one guard, two commands.
function assertNoForeignTeardown(probe = {}) {
  const foreign = foreignDaemonConfig(probe);
  if (!foreign) return null;
  const env = slotEnvPrefix(foreign.dir);
  die('pidge terminal disconnect: the daemon service on this computer serves a DIFFERENT config slot.\n' +
    `  installed service:  ${foreign.dir}\n` +
    `                      (${foreign.where})\n` +
    `  this run resolves:  ${foreign.mine}\n` +
    '\n' +
    'Removing it from here would take that OTHER identity offline — the computer it\n' +
    'serves would simply stop answering, with nothing said. Refusing.\n' +
    'Pick one:\n' +
    '  · retire the INSTALLED slot — re-run with its environment:\n' +
    `      ${env} pidge terminal disconnect\n` +
    '  · or leave it running: this slot has no service of its own, so there is\n' +
    '    nothing here to remove.');
  return null;
}

// A user service manager we can actually talk to. `/run/systemd/system` is the
// canonical "systemd is PID 1" marker; the systemctl probe additionally proves
// the per-user manager is reachable (a WSL2 with systemd=true but no user bus
// would otherwise take us down a path that silently does nothing).
function hasSystemd() {
  if (fs.existsSync('/run/systemd/system')) return true;
  try {
    execFileSync('systemctl', ['--user', '--no-pager'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// WSL has no user service manager unless the human opted into systemd, so it
// gets its own (actionable) fallback text. (The detector lives in core — the
// capabilities frame reports the same three OS values.)
const isWsl = core.isWsl;

// Where THIS process's CLI lives (bin/pidge.js) and its package root.
function cliEntryPath() {
  return require.main ? require.main.filename : path.join(__dirname, '..', '..', 'bin', 'pidge.js');
}
function cliRootPath() {
  return path.resolve(path.dirname(cliEntryPath()), '..'); // <root>/bin/pidge.js → <root>
}
function stableCliDir() { return path.join(core.terminalDir(), 'cli'); }
function stableCliEntry() { return path.join(stableCliDir(), 'bin', 'pidge.js'); }

// A service template must NEVER point at where the CLI happens to be running
// from: `npx` runs it out of ~/.npm/_npx/<hash>, npm prunes that cache, and the
// daemon dies silently weeks later (QA finding #4 — proven on a real launchd
// plist). And `npm i -g` cannot be trusted either: on a real machine the npm
// prefix was outside PATH entirely (finding #8). So connect COPIES the CLI it
// is running into ~/.config/pidge/terminal/cli/ and the service runs that —
// a path this feature owns, with no cache and no PATH in the loop.
function copyCliToStablePath() {
  const root = cliRootPath();
  const dest = stableCliDir();
  if (path.resolve(root) === path.resolve(dest)) return stableCliEntry(); // already the copy
  const staging = `${dest}.new.${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  // bin/ + src/ is the whole runtime (pidge-cli has no runtime dependencies);
  // package.json rides along so `pidge --version` keeps telling the truth.
  for (const part of ['bin', 'src', 'package.json']) {
    const from = path.join(root, part);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(staging, part), { recursive: true });
  }
  if (!fs.existsSync(path.join(staging, 'bin', 'pidge.js'))) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`could not find bin/pidge.js under ${root}`);
  }
  // Swap last: a half-copied tree must never be what the service points at.
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(staging, dest);
  try { fs.chmodSync(stableCliEntry(), 0o755); } catch {}
  return stableCliEntry();
}

// node + the CLI entry point the service will run. Shared by every branch.
function daemonExec() {
  const nodeBin = process.execPath;
  const fallback = cliEntryPath();
  try {
    return { nodeBin, cli: copyCliToStablePath() };
  } catch (e) {
    const npx = /[\\/]_npx[\\/]/.test(fallback);
    console.error(`pidge terminal: WARNING — could not copy the CLI to ${stableCliDir()} (${e.message}); the service will point at ${fallback}${npx ? ' — the npx CACHE, which npm PRUNES: the daemon would die silently later. Install durably (npm i -g pidge-cli@latest) and re-run `pidge terminal connect`.' : '.'}`);
    return { nodeBin, cli: fallback };
  }
}

// `probe` exists for the TESTS and nothing else: it lets one machine exercise
// every template (and lets the assertions prove which OS command was, and was
// NOT, run). Production always takes the defaults.
function installDaemonService(probe = {}) {
  const run = probe.run || ((cmd, args) => execFileSync(cmd, args, { stdio: 'ignore' }));
  return daemonPlatform(probe) === 'darwin'
    ? installLaunchd(run, probe)
    : installSystemdUser(probe, run);
}

function installLaunchd(run, probe = {}) {
  assertNoForeignDaemon(probe); // never take the label from another config slot
  const { nodeBin, cli } = daemonExec();
  // launchd hands a service NO locale — and without a UTF-8 locale tmux
  // SANITIZES control characters in its -F output, which is how the pane
  // parser found "0 panes" with the pane right there (QA finding #10). The
  // daemon also forces the locale on every tmux call (core.tmuxExec); setting
  // it here too is deliberate defense in depth, per platform template.
  // HOME/XDG_CONFIG_HOME: launchd hands an agent the LOGIN account's HOME, not
  // the one this process resolved its config from — so a daemon installed from
  // a custom env used to read a DIFFERENT config slot than the one connect had
  // just written to: the installed binary served the real machine's identity
  // while the fresh pairing never connected. The service must serve the
  // slot that installed it, so the slot is PINNED here rather than re-derived.
  // XDG_CONFIG_HOME is pinned only when the human actually set it — inventing
  // one would also relocate the config of everything the daemon spawns.
  const locale = core.utf8Locale();
  const envPairs = { LANG: locale, LC_ALL: locale, HOME: os.homedir() };
  if (process.env.XDG_CONFIG_HOME) envPairs.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  if (process.env.PATH) envPairs.PATH = process.env.PATH;
  const envEntries = Object.entries(envPairs)
    .map(([k, val]) => `    <key>${xmlEscape(k)}</key><string>${xmlEscape(val)}</string>`).join('\n');
  const envBlock = `  <key>EnvironmentVariables</key>\n  <dict>\n${envEntries}\n  </dict>\n`;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<!-- generated by \`pidge terminal connect\`. The tunnel key stays in
     ~/.config/pidge/terminal/env — NEVER embedded here. -->
<dict>
  <key>Label</key><string>${xmlEscape(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodeBin)}</string>
    <string>${xmlEscape(cli)}</string>
    <string>terminal</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
${envBlock}  <key>StandardOutPath</key><string>${xmlEscape(core.LOG_FILE())}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(path.join(core.terminalDir(), 'terminal.err.log'))}</string>
</dict>
</plist>
`;
  const file = launchdPlistPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, plist);
  try { run('launchctl', ['unload', file]); } catch {}
  try {
    run('launchctl', ['load', '-w', file]);
  } catch (e) {
    console.error(`pidge terminal: launchctl load failed (${e.message}) — start manually: launchctl load -w "${file}"`);
  }
  return { kind: 'launchd', file, label: LAUNCHD_LABEL };
}

function installSystemdUser(probe, run) {
  const systemd = probe.systemd !== undefined ? probe.systemd : hasSystemd();
  if (!systemd) return startDetachedDaemon(probe);
  assertNoForeignDaemon(probe); // never take the unit name from another config slot

  const { nodeBin, cli } = daemonExec();
  // launchd/systemd hand a service a MINIMAL PATH — and this daemon SHELLS OUT
  // to tmux and ps on every enable and every keystroke it delivers. A tmux from
  // homebrew/nix/~/.local/bin would simply not exist for the service while
  // working fine in the shell the human just tested from.
  // LANG/LC_ALL: same story as the launchd template — no locale in the service
  // env makes tmux sanitize control characters in -F output (QA finding #10).
  // HOME: `systemd --user` sets HOME from the account, so a connect run under a
  // custom HOME produced a unit that resolved a DIFFERENT config slot.
  // XDG_CONFIG_HOME was already pinned; HOME is the other half of that address.
  const locale = core.utf8Locale();
  const envPairs = { LANG: locale, LC_ALL: locale, HOME: os.homedir() };
  if (process.env.PATH) envPairs.PATH = process.env.PATH;
  if (process.env.XDG_CONFIG_HOME) envPairs.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  const envLines = Object.entries(envPairs)
    .map(([k, val]) => `Environment=${systemdQuote(`${k}=${val}`)}`).join('\n');
  const unit = `# generated by \`pidge terminal connect\`. The tunnel key stays in
# ~/.config/pidge/terminal/env — NEVER embedded here.
[Unit]
Description=pidge terminal daemon — Agent Sessions (local hook endpoint, sealed publisher, input lane)
# Wants + After: After alone only ORDERS against the target if something else
# pulls it in — Wants actually pulls it into the transaction.
Wants=network-online.target
After=network-online.target

[Service]
ExecStart=${systemdQuote(nodeBin)} ${systemdQuote(cli)} terminal daemon
Restart=on-failure
RestartSec=10
${envLines ? envLines + '\n' : ''}StandardOutput=append:${core.LOG_FILE()}
StandardError=append:${path.join(core.terminalDir(), 'terminal.err.log')}

[Install]
WantedBy=default.target
`;
  const file = systemdUnitPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, unit);
  try {
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT]);
    // `enable --now` is a NO-OP while the unit is already active, so a
    // --replace would leave the OLD daemon running with the previous identity
    // in memory (review A2). The loopback shutdown usually got it first —
    // this restart is belt-and-braces, harmless on a freshly started unit.
    if (probe.recycle) run('systemctl', ['--user', 'restart', SYSTEMD_UNIT]);
  } catch (e) {
    console.error(`pidge terminal: systemctl failed (${e.message}) — start it manually:\n  systemctl --user daemon-reload && systemctl --user enable --now ${SYSTEMD_UNIT}`);
  }
  return { kind: 'systemd', file, label: SYSTEMD_UNIT };
}

// No user service manager (an older WSL, /etc/wsl.conf without systemd, a bare
// container). Refusing here would leave a connected tunnel with no daemon, so
// we START it — detached, so it outlives this shell — and say exactly what
// makes it survive a reboot.
function startDetachedDaemon(probe = {}) {
  const { nodeBin, cli } = daemonExec();
  const spawnFn = probe.spawn || spawn;
  let pid = null;
  try {
    const child = spawnFn(nodeBin, [cli, 'terminal', 'daemon'], { detached: true, stdio: 'ignore' });
    child.unref();
    pid = child.pid;
  } catch (e) {
    console.error(`pidge terminal: could not start the daemon (${e.message}) — run it yourself: pidge terminal daemon`);
  }
  const wsl = probe.wsl !== undefined ? probe.wsl : isWsl();
  say(`· no user service manager here (no systemd)${pid ? ` — daemon started detached (pid ${pid})` : ''}`);
  say('  It will NOT come back after a reboot. Make it durable, either:');
  if (wsl) {
    say('   · enable systemd — add to /etc/wsl.conf:');
    say('       [boot]');
    say('       systemd=true');
    say('     then `wsl --shutdown` from Windows and re-run `pidge terminal connect`');
  }
  say('   · or start it from your shell profile (~/.bashrc, ~/.zshrc):');
  say('       pgrep -f "terminal daemon" >/dev/null || (pidge terminal daemon &)');
  return { kind: 'detached', pid, wsl };
}

function uninstallDaemonService(probe = {}) {
  assertNoForeignTeardown(probe); // never unload a service belonging to another slot
  const run = probe.run || ((cmd, args) => execFileSync(cmd, args, { stdio: 'ignore' }));
  if (daemonPlatform(probe) === 'darwin') {
    const file = launchdPlistPath();
    try { run('launchctl', ['unload', '-w', file]); } catch {}
    try { fs.unlinkSync(file); return { kind: 'launchd', removed: true }; } catch { return { kind: 'launchd', removed: false }; }
  }
  const file = systemdUnitPath();
  try { run('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]); } catch {}
  let removed = false;
  try { fs.unlinkSync(file); removed = true; } catch {}
  if (removed) { try { run('systemctl', ['--user', 'daemon-reload']); } catch {} }
  return { kind: 'systemd', removed };
}

// --- enable (a CONFIRMATION — the door is the hook) -------------------------
//
// This command used to BE the mechanism: it walked its own process tree up to
// the claude process to read its tty. That is structurally broken (QA finding
// #7 — Claude Code runs every Bash tool inside a ttyless shell wrapper whose
// command line mentions `.claude/`, so the walk stopped there and refused on
// every machine), and it dragged a PATH problem along (finding #8). The whole
// walk is GONE: the daemon enables sessions from the PreToolUse hook, which
// carries the session id authoritatively (core.parseEnableSentinel).
//
// What's left is a friendly confirm for a human in a bare terminal: it never
// mints a share, and it says the one thing that does.
async function runEnable(v) {
  if (!(await daemonAlive())) die('pidge terminal enable: the local daemon is not running — run `pidge terminal connect` (or `pidge terminal daemon` in another shell) first');
  const { data } = await daemonCall('GET', '/sessions');
  const enabled = data.enabled || [];
  if (!enabled.length) {
    // Loud, actionable, and NOT a share: exit 1 keeps "nothing was created".
    die(core.ENABLE_NOT_MIRRORED);
  }
  say(`✓ ${enabled.length} session(s) mirroring from this computer — ${enabled.map((e) => `${e.sid.slice(0, 8)} (${e.status})`).join(', ')}`);
  say('  Open the Pidge app → Agents to watch and reply. `pidge terminal disable` stops sharing.');
  say('  (This command only reports: the PreToolUse hook is what shares a session.');
  say('   To share ANOTHER session, paste the prompt above into it — `pidge terminal status` shows it.)');
  if (v.approvals) {
    say(`· --approvals is ignored here — it rides the pasted command instead: \`pidge terminal enable --approvals ${v.approvals}\``);
  }
}

// --- config: the capability grants (v2 §17/§22) -----------------------------
//
// The grants live ON THE MACHINE because that is where the risk lives: typing
// into a pane the human already shared is consented by the share itself, but
// SPAWNING a pane and LISTING every pane create new surface with zero
// machine-side act. Defaults: remote_spawn OFF, inventory ON.
async function runConfig(args) {
  const [key, value] = args || [];
  if (!key) {
    say('pidge terminal config — what your phone may do to this computer:\n');
    for (const line of core.grantLines()) say(`  ${line}`);
    return;
  }
  if (!core.GRANT_KEYS.includes(key)) {
    die(`pidge terminal config: unknown setting ${JSON.stringify(key)} — one of: ${core.GRANT_KEYS.join(', ')}\n` +
      `  usage: pidge terminal config [${core.GRANT_KEYS.join('|')}] [on|off]`);
  }
  if (value !== 'on' && value !== 'off') {
    die(`pidge terminal config ${key}: pass \`on\` or \`off\` (got ${JSON.stringify(value || '')}).\n` +
      `  current: ${core.grantLines()[core.GRANT_KEYS.indexOf(key)]}`);
  }
  core.saveGrants({ [key]: value === 'on' });
  say(`✓ ${core.grantLines()[core.GRANT_KEYS.indexOf(key)]}`);
  // Tell the running daemon so the phone's capabilities frame is refreshed
  // now instead of on the next viewer join. Best-effort: the grant is already
  // durable on disk, and the daemon re-reads it on every use.
  try {
    const { res } = await daemonCall('POST', '/caps', {});
    if (res.status === 200) say('· the running daemon re-published its capabilities to your phone');
  } catch {
    say('· the daemon is not running — it picks this up when it starts');
  }
}

// --- share: the terminal-side capture door (v2 §17) -------------------------
//
// Typed by a HUMAN inside the pane they want to share. A real shell HAS a
// controlling tty (the ttyless problem is Claude-hook-specific, finding #7),
// so the CLI can match its own tty against `#{pane_tty}` and hand the daemon
// an exact pane id — no guessing, ever.
function currentTty() {
  try {
    const out = execFileSync('ps', ['-o', 'tty=', '-p', String(process.pid)], { encoding: 'utf8' }).trim();
    return core.normalizeTty(out);
  } catch { return null; }
}

// `probe` exists for the TESTS and nothing else (the installDaemonService
// pattern): a test runner's stdio is not a tty, so there would be no way to
// exercise the tty→pane match at all. Production always reads the real tty.
async function runShare(probe = {}) {
  if (!(await daemonAlive())) die('pidge terminal share: the local daemon is not running — run `pidge terminal connect` (or `pidge terminal daemon` in another shell) first');
  const tty = probe.tty || currentTty();
  if (!tty) {
    die('pidge terminal share: this shell has no controlling tty, so it cannot be matched to a tmux pane.\n' +
      'Run it by hand INSIDE the tmux pane you want to share (it is not meant for scripts, hooks or CI).');
  }
  if (!process.env.TMUX) {
    die(`pidge terminal share: you are not inside tmux (no $TMUX for tty ${tty}).\n` +
      'Start tmux, open the pane you want on your phone, and run this there.');
  }
  let pane;
  try {
    pane = core.tmuxPaneForTty(tty, { onWarn: (m) => console.error(m) });
  } catch (e) {
    // #68: a pane list this computer cannot PARSE is a pidge-side failure —
    // it must never be reported as "you are not in tmux".
    die(`pidge terminal share: the tmux pane list came back mangled (${e.message}).\n` +
      'That is a pidge/tmux problem on this computer, NOT your setup — see ' + core.LOG_FILE());
  }
  if (!pane) {
    die(`pidge terminal share: no tmux pane owns this shell's tty (${tty}).\n` +
      'Run it inside the pane you want to share.');
  }
  const { data } = await daemonCall('POST', '/share', { pane_id: pane.paneId });
  if (!data || !data.ok) {
    die(`pidge terminal share: ${(data && data.error) || 'the daemon refused the share'}`);
  }
  say(`✓ sharing pane ${data.pane_id}${data.loc ? ` (${data.loc})` : ''} → ${data.public_id} [${data.mode}]`);
  say('  It shows up in the Pidge app under this computer. `pidge terminal disable --all` stops sharing.');
}

// --- status / disable / disconnect ------------------------------------------

// The input lane, said out loud (QA r6-3.2). `daemon: up` used to be the whole
// health story while the cable — the ONLY path phone input travels — was dead
// for hours: publishing is plain HTTPS POSTs, so the mirror kept reading fine
// precisely while the human's words evaporated. A daemon with a dead input
// lane may not present as healthy.
function cableLine(cable) {
  if (cable.up) return 'up';
  if (cable.wanted) {
    return `DOWN since ${cable.down_since || 'daemon start'} — phone input does NOT reach this computer (the daemon is retrying; transcripts still publish)`;
  }
  return 'idle (no shared sessions — it connects on the first share)';
}

async function runStatus() {
  const env = core.loadTerminalEnv();
  say(`tunnel:   ${env.token ? `connected (channel ${env.channelId}, ${env.base})` : 'NOT connected'}`);
  const health = await daemonAlive();
  say(`daemon:   ${health ? `up (epoch ${health.epoch})` : 'DOWN'}`);
  if (health && health.cable) say(`cable:    ${cableLine(health.cable)}`);
  // Reported per LANE (#72): the input lane can be perfectly up while the
  // COMPUTER subscription — presence, capabilities, the pane inventory — was
  // rejected. `computer` is absent on a pre-0.43 daemon; absence prints nothing.
  if (health && health.cable && health.cable.computer !== undefined) {
    say(`computer: ${health.cable.computer
      ? 'lane confirmed — your phone sees this computer'
      : 'lane NOT confirmed — your phone shows it offline and cannot list or spawn panes'}`);
  }
  if (health) {
    const { data } = await daemonCall('GET', '/sessions');
    const en = data.enabled || [];
    const announced = (data.announces || []).length;
    say(`shares:   ${en.length}${en.length ? ' — ' + en.map((e) => `${e.public_id || e.sid} ${e.pane_id || ''} [${e.mode || 'agent'}] (${e.status})`).join(', ') : ''}`);
    say(`announced: ${announced} (local only, not shared)`);
    // The announce map is diagnostics, never a picker: a session can only be
    // shared from INSIDE itself, so this points at the prompt, not at a list.
    if (announced > en.length) {
      say('\n          To share one, paste this into that Claude session:');
      say(`          ${core.ENABLE_PROMPT}\n`);
    }
  }
  let hooksLine;
  try {
    const settings = readClaudeSettings();
    hooksLine = JSON.stringify(settings || {}).includes(PIDGE_HOOK_MARKER) ? 'installed' : 'NOT installed';
  } catch {
    // Honest: an unparseable file is not "not installed" — and `connect` will
    // refuse to rewrite it rather than destroy it.
    hooksLine = 'UNKNOWN — the file is not valid JSON (pidge will not rewrite it)';
  }
  say(`hooks:    ${hooksLine} (~/.claude/settings.json)`);
  say('grants:');
  for (const line of core.grantLines()) say(`  ${line}`);
}

// The local stop ALWAYS happens (publishing ends, the session leaves state) —
// but a DELETE the server never received must not be reported as a clean stop:
// the row lives on until the retention/staleness reaper catches it, and the
// human deserves to know which of the two happened.
function sayDisabled(label, results) {
  const failed = (results || []).filter((r) => r && !r.server_ok);
  if (!failed.length) { say(`✓ stopped sharing ${label}`); return; }
  say(`✓ stopped sharing ${label} LOCALLY — nothing more is published from this computer.`);
  say(`  Could not tell the server (${failed[0].detail || 'unreachable'}); it will reap the session shortly.`);
}

async function runDisable(v) {
  if (!(await daemonAlive())) die('pidge terminal disable: daemon not running');
  if (v.all) {
    const { data } = await daemonCall('POST', '/disable', { all: true });
    sayDisabled(`${data.disabled.length} session(s)`, data.results);
    return;
  }
  // No process introspection here either (the ancestor walk is gone): a
  // single shared session is unambiguous, more than one needs a --session
  // (prefix match) or --all. Never guess WHICH share to end.
  const { data } = await daemonCall('GET', '/sessions');
  const enabled = data.enabled || [];
  const sid = v.session || null;
  const hit = sid
    ? enabled.find((e) => e.sid === sid || e.sid.startsWith(sid))
    : (enabled.length === 1 ? enabled[0] : null);
  if (!hit) {
    if (sid) die(`pidge terminal disable: no shared session matching ${JSON.stringify(sid)}`);
    if (!enabled.length) die('pidge terminal disable: nothing is being shared from this computer');
    die(`pidge terminal disable: ${enabled.length} sessions are shared — pass --session <sid> (\`pidge terminal status\` lists them) or --all`);
  }
  const { data: out } = await daemonCall('POST', '/disable', { sid: hit.sid });
  sayDisabled(hit.sid.slice(0, 8), out && out.results);
}

async function runDisconnect() {
  // FIRST, before anything is torn down: the service installed here has to be
  // the one this environment owns. A refusal that arrives after the shares are
  // disabled and the hooks are gone is not a refusal, it is half a teardown.
  assertNoForeignTeardown();
  const health = await daemonAlive();
  if (health) { try { await daemonCall('POST', '/disable', { all: true }); } catch {} }
  uninstallHooks();
  say('✓ hooks removed from ~/.claude/settings.json');
  const svc = uninstallDaemonService();
  if (svc.removed) say(`✓ daemon uninstalled (${svc.kind})`);
  else say(`· no ${svc.kind} service to remove — if a daemon is still running (the no-systemd fallback starts one detached), stop it with: pkill -f "terminal daemon"`);
  say('· tunnel identity kept at ' + core.ENV_FILE() + ' — delete it (and the tunnel in the app) to fully unlink');
}

// `pidge terminal doctor` — THE ACCEPTANCE TEST AGAINST THE REAL BINARY.
//
// Gate A (2026-08-05) shipped a field whose only job is to choose which screen
// the human sees. It went through an adversarial review and two green suites,
// and it was wrong on first contact with a real machine: Claude Code v2.1.222
// answers `#{pane_current_command}` with its VERSION, and a closed harness
// allowlist read that as "claude exited". No mock could have caught it, because
// the whole bug lived in what the installed binary calls itself.
//
// So this exists to be RUN, on the machine, against whatever is actually
// installed: it prints the raw string tmux gives for every pane, what each half
// of the §16 ladder concludes, and the mode that follows. If a live claude does
// not read `mode=agent ✓` here, the renderer is lying — whatever the tests say.
// (gotcha #75: every field that governs RENDERING gets a step like this.)
async function runDoctor() {
  say('pidge terminal doctor — occupant detection, against the binaries actually installed here.\n');
  let panes;
  try {
    panes = core.tmuxPanes({ onWarn: (m) => say(`  ! ${m}`) });
  } catch (e) {
    die(`pidge terminal doctor: the tmux pane list came back mangled (${e.message}) — a pidge/tmux mismatch, not a user error`, 2);
  }
  if (!panes.length) {
    say('No tmux panes on this computer — start one (with a claude inside it) and run this again.');
    return;
  }

  // Bound panes come from the daemon when it is up; without it the probe still
  // works and simply has no live mode to compare against.
  const bound = new Map();
  if (await daemonAlive()) {
    try {
      const { data } = await daemonCall('GET', '/sessions');
      for (const e of data.enabled || []) if (e.pane_id) bound.set(e.pane_id, e);
    } catch { /* the probe below is the point — a daemon hiccup must not kill it */ }
  } else {
    say('(daemon DOWN — showing what the detection WOULD conclude; there are no live modes to compare against)\n');
  }

  let liveAgents = 0; let wrong = 0;
  for (const p of panes) {
    const shell = core.isShellCommand(p.cmd);
    const alive = core.paneHasLiveHarness(p.pid);
    const verdict = !shell
      ? 'KEEP (not a shell we recognise — doubt shows the transcript)'
      : alive === true ? 'KEEP (a harness is alive in the process tree)'
        : alive === null ? 'KEEP (ps unreadable — unknown never retires a live view)'
          : 'may flip to term (a known shell AND no harness in the tree)';
    const share = bound.get(p.paneId);
    say(`${p.paneId}  ${p.loc}`);
    say(`  pane_current_command = ${JSON.stringify(p.cmd)}   (raw, exactly as tmux said it)`);
    say(`  is a known shell?      ${shell ? 'yes' : 'no'}`);
    say(`  harness in the tree?   ${alive === true ? 'YES (claude)' : alive === false ? 'no' : 'UNKNOWN (ps failed)'}   [pane_pid ${p.pid || '?'}]`);
    say(`  the §16 ladder says:   ${verdict}`);
    if (share) {
      const ok = !(alive === true && (share.mode || 'agent') === 'term');
      if (alive === true) { liveAgents += 1; if (!ok) wrong += 1; }
      say(`  shared as:             ${share.public_id} mode=${share.mode || 'agent'} ${ok ? '✓' : '✗  A LIVE HARNESS IS PUBLISHED AS A TERMINAL — the gotcha #75 failure'}`);
    }
    say('');
  }

  const mirrorBad = await doctorMirror(bound.size > 0);

  if (!bound.size) {
    say('No pane is shared right now, so there is no mode to check. Share the pane a claude runs in and re-run — THAT is the acceptance test.');
  } else if (!liveAgents) {
    say('No shared pane currently has a live harness in its tree. Start a claude inside a shared pane and re-run.');
  } else if (wrong) {
    die(`pidge terminal doctor: ${wrong} shared pane(s) hold a LIVE harness but are published as \`term\` — the phone is showing a terminal placeholder instead of the transcript.`, 2);
  } else {
    say(`✓ ${liveAgents} shared pane(s) hold a live harness and are published as mode=agent. Occupant detection agrees with reality on this machine.`);
  }
  if (mirrorBad) {
    die(`pidge terminal doctor: ${mirrorBad} shared pane(s) could not produce a seed that fits the relay frame cap — the raw view would reseed forever on this machine (spec §19, gotcha #65).`, 2);
  }
}

// The MIRROR half of the doctor (Phase B, spec §19 + the §12 real-binary rule).
//
// The seed is the one frame whose failure cannot be healed by asking again: an
// oversized seed is dropped by the relay, the viewer sees the gap, asks for a
// reseed, and the daemon regenerates the SAME oversized dump — forever. The
// ladder degrades inside the cap precisely so that loop cannot start, and the
// only way to know it holds against THIS tmux, at THIS pane size, with THESE
// manifest limits is to make a real one and measure it. So: attach for real,
// force one reseed, print what came out. Returns how many shares failed.
async function doctorMirror(anyShares) {
  say('--- mirror (the raw byte view, spec §19) ---\n');
  let report;
  try {
    const { res, data } = await daemonCall('GET', '/mirror');
    if (res.status !== 200) throw new Error(`daemon answered ${res.status}`);
    report = data;
  } catch (e) {
    say(`(no mirror diagnostics — ${e.message}. Start the daemon and re-run.)\n`);
    return 0;
  }
  say(`relay frame cap:  ${report.frame_cap} B (from the manifest — the seed ladder degrades against THIS number)`);
  say(`daemon epoch:     ${report.epoch}   (echoed in every o/seed frame; a viewer gap ⇒ reseed)`);
  say(`idle stand-down:  ${Math.round(report.settings.mirror_idle_ms / 1000)}s   ·  resize nudge: ${report.settings.nudge_ms ? `${report.settings.nudge_ms}ms` : 'OFF'}   (terminal.toml)`);
  for (const w of report.warnings || []) say(`  ! terminal.toml: ${w}`);
  say(`tmux control taps: ${report.hub.length ? report.hub.map((h) => `${h.session} [${h.panes.join(' ')}]${h.alive ? '' : ' DEAD'}`).join(', ') : 'none (no pane is being mirrored right now)'}`);
  say('');

  if (!anyShares) {
    say('No pane is shared, so there is nothing to mirror. Share one and re-run.\n');
    return 0;
  }

  let probes;
  try {
    const { data } = await daemonCall('POST', '/mirror/probe', {});
    probes = (data && data.probes) || [];
  } catch (e) {
    say(`(the reseed probe could not run — ${e.message})\n`);
    return 0;
  }
  let bad = 0;
  for (const p of probes) {
    say(`${p.public_id}  pane ${p.pane_id}  mode=${p.mode}`);
    if (!p.attached) {
      say('  tmux tap:            NOT ATTACHED — this computer could not open a control-mode client for the pane');
      say('');
      bad += 1;
      continue;
    }
    const seed = p.seed;
    if (!seed) {
      say('  seed:                none produced');
      say('');
      bad += 1;
      continue;
    }
    const rung = seed.scrollback === undefined ? '—' : `-${seed.scrollback} lines`;
    say(`  seed:                ${seed.bytes === null ? 'SKIPPED' : `${seed.bytes} B sealed`}  (${seed.cols}x${seed.rows}${seed.alt ? ', alternate screen' : ''})`);
    say(`  ladder rung used:    ${rung}${seed.degraded ? `  → DEGRADED: ${seed.degraded}` : ''}`);
    say(`  fits the cap?        ${seed.fits ? 'yes ✓' : 'NO ✗  — the reseed loop starts here'}`);
    say(`  sent on the cable?   ${seed.sent ? 'yes' : 'no (the cable is not up — the seed still had to fit)'}`);
    say(`  frames · stripper:   ${formatFrameActivity(p)} · ${p.stripper_hits} ESC-k title sequence(s) removed from the live stream`);
    say('');
    if (!seed.fits) bad += 1;
  }
  if (!probes.length) say('No shared pane has a bound tmux pane to mirror.\n');
  else if (!bad) say(`✓ ${probes.length} shared pane(s) produced a seed inside the relay frame cap against the tmux installed here.\n`);
  return bad;
}

// --- dispatcher --------------------------------------------------------------

async function runTerminal(sub, v, args = []) {
  switch (sub) {
    case 'connect': return runConnect(v);
    case 'enable': return runEnable(v);
    case 'status': return runStatus();
    case 'doctor': return runDoctor();
    case 'disable': return runDisable(v);
    case 'disconnect': return runDisconnect();
    case 'config': return runConfig(args);
    case 'share': return runShare(v && v._probe ? v._probe : {});
    case 'daemon': {
      const { Daemon } = require('./daemon');
      const d = new Daemon();
      return d.run();
    }
    default:
      // `ls` (the session picker) was REMOVED with the enable lock-down: it is
      // not deprecated-but-tolerated, it is gone — sharing happens only from
      // inside the session, so a list of other people's sessions is not a door.
      die(`pidge terminal: unknown subcommand ${JSON.stringify(sub || '')} — one of: connect, share, config, enable, disable, status, doctor, disconnect, daemon`);
  }
}

module.exports = {
  runTerminal, runConfig, runShare, currentTty,
  installHooks, uninstallHooks, hookShimSource, PIDGE_HOOK_MARKER,
  installDaemonService, uninstallDaemonService, launchdPlistPath, systemdUnitPath,
  copyCliToStablePath, stableCliDir, stableCliEntry, installPidgeSkill,
  shutdownLocalDaemon, serviceTerminalDir, foreignDaemonConfig, slotEnvPrefix,
  SYSTEMD_UNIT, LAUNCHD_LABEL,
};
