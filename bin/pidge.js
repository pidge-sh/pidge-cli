#!/usr/bin/env node
'use strict';
//
// pidge — CLI so an agent (Hermes, or a running Claude Code) can send a rich
// iPhone notification AND block until the human answers (polling — the primary
// read path for terminal/CLI use, where there's no webhook to receive a reply).
//
//   export PIDGE_URL=https://pidge.sh              # default http://localhost:3000
//   export PIDGE_TOKEN=hld_xxx                     # the channel's bearer key
//   (HERALD_URL / HERALD_TOKEN are honored as a fallback; with no env vars set,
//    ~/.config/pidge/env — KEY=VALUE — is read instead, so the key can live
//    OUTSIDE the agent's chat/context entirely, #57)
//
//   # send AND block until the human answers, then print the chosen action as JSON
//   pidge ask --title "Aprovar deploy?" --actions yes,no,reply --timeout 600
//
//   # urgent: escalates to an AlarmKit alarm if unanswered (see the manifest's profiles)
//   pidge ask --title "Posso rodar a migration?" --profile escalating --actions yes,no
//
//   # a thing with a known time: push at T−lead + a lock-screen countdown to the event
//   pidge notify --title "Reunião com o time" --profile event --event-at "2026-06-10T15:00:00"
//
//   # block on an already-sent notification (by correlation_id)
//   pidge wait order-7 --timeout 300
//
//   # cancel a still-scheduled notification before it fires (#56)
//   pidge cancel med-ozempic-qui
//
// stdout is ALWAYS machine-readable: `notify` prints the raw 201 JSON; `ask`/`wait`
// print the chosen_action JSON. Everything human (warnings, the correlation_id,
// snooze notices) goes to stderr. Exit codes: 0 = responded, 3 = timed out (= "no
// answer yet", NOT a failure — back off and retry later), 2 = error, 1 = usage.
//
// DESIGN: this CLI is a thin pipe — the SERVER's manifest (GET /api/v1/manifest)
// is the contract, and validation lives server-side (422s are self-describing).
// New /notify fields work without a CLI release via --param key=value.

const { parseArgs } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// #57 token hygiene: when the env vars are unset, fall back to
// ~/.config/pidge/env (KEY=VALUE lines the HUMAN writes once in THEIR terminal)
// so the raw hld_… key never has to ride the agent's chat/context. Explicit env
// vars always win; `export ` prefixes, quotes and #comments are tolerated.
function configEnv() {
  try {
    const file = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'pidge', 'env');
    const out = {};
    for (let line of fs.readFileSync(file, 'utf8').split('\n')) {
      line = line.trim().replace(/^export\s+/, '');
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i < 1) continue;
      const value = line.slice(i + 1).replace(/^["']|["']$/g, '');
      if (value) out[line.slice(0, i)] = value;
    }
    return out;
  } catch { return {}; }
}
const FILE_ENV = configEnv();

const BASE = process.env.PIDGE_URL || process.env.HERALD_URL || FILE_ENV.PIDGE_URL || 'http://localhost:3000';
const TOKEN = process.env.PIDGE_TOKEN || process.env.HERALD_TOKEN || FILE_ENV.PIDGE_TOKEN;

function die(msg, code = 1) { console.error(msg); process.exit(code); }
// NB: the TOKEN requirement is enforced AFTER help/usage handling (below) — a
// first-time `npx pidge-cli --help` must work without any setup.

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  title: { type: 'string' },
  body: { type: 'string' },
  'body-markdown': { type: 'string' },
  subtitle: { type: 'string' },
  template: { type: 'string' },                // content/action pattern (manifest `templates`)
  profile: { type: 'string' },                 // delivery profile id (manifest `profiles`)
  'event-at': { type: 'string' },              // WHEN the thing happens (profile event)
  'lead-minutes': { type: 'string' },          // notify/countdown lead before event_at
  urgency: { type: 'string' },                 // normal | persistent | alarm (low-level — prefer --profile)
  image: { type: 'string' },                   // banner+feed image: local path → uploaded; URL → as-is
  file: { type: 'string' },                    // real artifact (xlsx/pdf/csv…): local path → uploaded
  url: { type: 'string' },                     // deep link the app opens on tap (#45)
  copy: { type: 'string' },                    // tap-to-copy value on the detail (#45)
  actions: { type: 'string' },                 // comma list from the catalog
  'custom-action': { type: 'string', multiple: true }, // id:label[:destructive][:confirm][:biometric][:terminal]
  'deliver-at': { type: 'string' },
  'reply-to': { type: 'string' },
  'correlation-id': { type: 'string' },
  thread: { type: 'string' },                  // conversation handle (#49) — same id ⇒ one strand on the phone
  after: { type: 'string' },                   // decision queue (#157): held until this cid resolves
  'collapse-key': { type: 'string' },
  param: { type: 'string', multiple: true },   // key=value escape hatch → raw /notify field
  timeout: { type: 'string' },
  interval: { type: 'string' },
  // inbox flags (#83)
  pending: { type: 'boolean' },
  summary: { type: 'boolean' },
  all: { type: 'boolean' },
  limit: { type: 'string' },
  // realtime (#118): WS by default when the runtime has a WebSocket (Node ≥22)
  realtime: { type: 'boolean' },               // force WS (warn+fallback if unavailable)
  'no-realtime': { type: 'boolean' },          // polling only
  // onboarding v2 (#110)
  claim: { type: 'string' },                   // setup --claim <single-use code>
  // #157 P2: listen keeps going after a batch (supervisor loop, one process)
  follow: { type: 'boolean' },
};

const USAGE = `pidge — send an iPhone notification to a human and block until they answer.

USAGE
  pidge setup --claim CODE [--url BASE]   one-shot onboarding (#110): exchange the single-use
                                          code for the channel key, store it in
                                          ~/.config/pidge/env (chmod 600), run doctor
  pidge doctor                            validate the setup WITHOUT exposing secrets:
                                          env source, server, key, "canal X · N devices"
  pidge whoami                            which channel does this key speak for (JSON)
  pidge ask    [options]                  send AND wait for the answer (prints chosen_action JSON)
  pidge notify [options]                  send only (prints the 201 JSON)
  pidge wait   <correlation_id> [options] block on an already-sent notification
  pidge cancel <correlation_id>           cancel a still-scheduled notification (#56)
  pidge inbox  [--pending|--summary|--all|--limit N]   what you sent: list, pending slice, or counts+latency (#83)
  pidge listen [--timeout N] [--all] [--follow]
                                          block until the human MESSAGES you from the app, print + ack + exit (#48)
                                          --follow = print+ack and KEEP listening until --timeout
                                          (exit 0 if any batch landed; one-shot stays the default)
                                          --all (#131) = the SINGLE EAR: also hear notification ANSWERS
                                          (kind notification_reply + self-contained ref) — nothing the human
                                          says can be missed by a looped listen --all
  pidge skill install                     write .claude/skills/pidge/SKILL.md generated from the
                                          live manifest (persistent Pidge knowledge for Claude Code)
  pidge --help

REALTIME (#118)
  listen/ask/wait hold a WebSocket to the server (ActionCable at /cable) when the
  runtime has one (Node ≥22): answers/messages land in <1 s, an idle hours-long
  listen survives server deploys by RECONNECTING, and while you listen the human
  sees "ouvindo agora" in the app. Everything durable still goes over HTTP
  (backlog GET + ack), so a dropped socket costs latency, never data.
  --realtime      force WS (warns + falls back to polling if unavailable)
  --no-realtime   polling only (the ?wait= long-poll, capped 25 s server-side)
  Degrade ladder, narrated on stderr: WS → ?wait= long-poll → plain GETs every
  ~45 s after 3 consecutive failures on held polls (#119). Degrade is STICKY for
  the session (we can't probe held-poll health without re-paying the failure) —
  re-invoke the command to retry the fast path.

OPTIONS (notify / ask)
  --title TEXT             (required) the headline
  --body TEXT              message shown on the banner
  --body-markdown MD       rich body for the tap-through detail screen
  --subtitle TEXT
  --template ID            content/action pattern — WHAT you're asking: context (FYI,
                           no buttons) · decision (yes/no/reply) · approval · reminder ·
                           nudge · sensitive (gated, Face ID). Composes with --profile.
  --profile ID             delivery profile (the HUMAN owns what it does): default ·
                           event (needs --event-at; countdown Live Activity) ·
                           escalating (alarm if unanswered minutes after delivery) ·
                           the user's custom profiles. See the manifest's \`profiles\`.
  --event-at ISO8601       WHEN the thing happens (a FACT; required by profile event)
  --lead-minutes N         notify/start countdown N min before event_at (5–240)
  --urgency LEVEL          normal | persistent | alarm (low-level — prefer --profile)
  --image PATH_OR_URL      image on the banner + feed: a local path is uploaded for
                           you (your machine has no public URL); an https URL is sent as-is
  --file PATH              a real artifact (xlsx, pdf, csv…) the human previews,
                           shares and saves on the phone; uploaded automatically (≤25 MB)
  --url URL                deep link the app opens when the user taps (PR, dashboard, log)
  --copy TEXT              value offered as tap-to-copy on the detail (code, token)
  --actions LIST           comma list: yes,no,approve,reject,accept,decline,later,
                           done,snooze,reschedule,reply,mute
  --custom-action SPEC     "id:label[:destructive][:confirm][:biometric][:terminal]" (repeatable)
  --deliver-at ISO8601     schedule for later
  --reply-to URL           also POST the answer to your webhook (HMAC-signed)
  --correlation-id ID      idempotency + routing key (auto-generated if omitted)
  --thread ID              conversation handle (#49): sends sharing it group as ONE
                           strand on the phone — use it for follow-ups
  --after CID              decision queue (#157): HELD until that notification is
                           answered — chain N decisions so the human sees one at a
                           time ("Decisão 2/3" --after <cid-da-1>); snooze doesn't advance
  --collapse-key KEY       replace/update a prior notification
  --param KEY=VALUE        pass ANY raw /notify field (repeatable) — future server
                           fields work without a CLI update; the manifest is the contract
  --timeout SECONDS        ask: 600 · wait: 300
  --interval SECONDS       FALLBACK poll cadence (default 30) — normally unused: WS or
                           the server-held long-poll (?wait=25) make answers ~instant

ENV
  PIDGE_URL     your Pidge server (default http://localhost:3000; HERALD_URL honored)
  PIDGE_TOKEN   your channel's bearer key (required; HERALD_TOKEN honored)
                with neither set, ~/.config/pidge/env (KEY=VALUE) is read — the
                key-free path: the human writes the file once, no secret in chat

OUTPUT
  stdout is machine-readable (notify→201 JSON; ask/wait→chosen_action JSON);
  human notices go to stderr. Exit: 0 answered · 3 timed out (no answer yet,
  not a failure) · 4 timed out WITHOUT ONE healthy round-trip all session (the
  CHANNEL looks broken — server/network — not the human ignoring you: surface
  it instead of retrying blindly, #119) · 2 error · 1 usage.

Responses are one-and-done EXCEPT snooze/reschedule (they re-fire); ask/wait keep
polling through a snooze and print snooze_until. Follow-up = a NEW notification.
An over-ceiling profile is delivered DEGRADED, never rejected — read the 201's
degraded/degrade_reason (narrated on stderr). profile "tracking" is Live-Activity-
only: it never produces an answer, so \`ask\` refuses it.

Full spec (the contract — always current): GET $PIDGE_URL/api/v1/manifest`;

let parsed;
try {
  parsed = parseArgs({ options: OPTIONS, allowPositionals: true });
} catch (e) {
  die(`pidge: ${e.message}\n\n${USAGE}`, 1);
}
const v = parsed.values;
const command = parsed.positionals[0];

// `pidge --help` / `-h` / `help` → full help on stdout, exit 0. No command → stderr, exit 1.
if (v.help || command === 'help') { console.log(USAGE); process.exit(0); }
if (!command) { console.error(USAGE); process.exit(1); }
// `setup` is the command that CREATES the token config — it must run without one.
if (!TOKEN && command !== 'setup')
  die('pidge: set PIDGE_TOKEN (env var, or put PIDGE_TOKEN=… in ~/.config/pidge/env) — or onboard with: pidge setup --claim <code> (ask your human for the code: Pidge app → Canais → o canal → copiar prompt de setup)');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

// fetch with a hard timeout (#119 review): a wedged edge proxy can stall even a
// short POST forever, and a hung ack on the realtime listen path would pin the
// process past its deadline — worse than going deaf. NOTHING in this CLI should
// await a fetch that can't time out. A held long-poll passes its own (larger)
// timeout; everything else uses the 30 s default.
function fetchT(url, opts = {}, timeoutMs = 30000) {
  const ms = parseInt(process.env.PIDGE_FETCH_TIMEOUT || '', 10) || timeoutMs; // test/ops hook
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(new Error(`timeout after ${ms}ms`)), ms);
  return fetch(url, { ...opts, signal: ctl.signal }).finally(() => clearTimeout(t));
}

// The server advertises its manifest version on every response. When it's newer
// than what this CLI shipped knowing, nudge ONCE on stderr — the agent re-reads
// the manifest (whats_new) and learns the new capabilities without polling.
const KNOWN_MANIFEST_VERSION = 24;
let newsWarned = false;
function checkManifestNews(res) {
  const v = parseInt(res.headers.get('x-pidge-manifest-version') || '0', 10);
  if (v > KNOWN_MANIFEST_VERSION && !newsWarned) {
    newsWarned = true;
    // #119: a pinned npx ref never updates itself — give the CONCRETE command.
    console.error(`pidge: the server has NEW capabilities (manifest v${v}; this CLI knows v${KNOWN_MANIFEST_VERSION}) — re-read GET $PIDGE_URL/api/v1/manifest (see whats_new) and UPDATE the CLI: npm i -g pidge-cli@latest  (npx users: run npx pidge-cli@latest, a pinned ref never self-updates)`);
  }
}

// ---------------------------------------------------------------------------
// #119: the health ledger of one blocking session (wait/ask/listen). Drives
//   (a) automatic DEGRADE from held ?wait= polls to plain GETs after
//       DEGRADE_AFTER consecutive failures (an edge that kills held responses
//       leaves short requests fine — the channel stays alive, less instant),
//   (b) ONE aggregated deafness line per minute instead of a line per failure,
//   (c) exit code 4 when the session ends with ZERO healthy round-trips —
//       deafness must exit LOUD, not masked as "the human didn't answer".
// ---------------------------------------------------------------------------
const DEGRADE_AFTER = 3;
// env override = a test/ops hook, not a documented knob
const DEGRADED_INTERVAL_S = parseInt(process.env.PIDGE_DEGRADED_INTERVAL || '45', 10);
const health = {
  okEver: false, fails: 0, firstFailAt: 0, lastNoteAt: 0, degraded: false,
  ok() {
    if (this.fails > 0) console.error(`pidge: channel recovered after ${this.fails} consecutive failure(s)`);
    this.okEver = true; this.fails = 0; this.firstFailAt = 0; this.lastNoteAt = 0;
  },
  fail(what) {
    this.fails++;
    if (!this.firstFailAt) { this.firstFailAt = Date.now(); this.lastNoteAt = Date.now(); }
    if (!this.degraded && this.fails >= DEGRADE_AFTER) {
      this.degraded = true;
      console.error(`pidge: ${this.fails} consecutive failures on held polls — degraded to plain GETs every ~${DEGRADED_INTERVAL_S}s (channel stays ALIVE, just less instant). Latest: ${what}`);
    } else if (this.fails === 1 || Date.now() - this.lastNoteAt >= 60000) {
      this.lastNoteAt = Date.now();
      const mins = Math.round((Date.now() - this.firstFailAt) / 60000);
      console.error(`pidge: deaf for ${mins} min — ${this.fails} consecutive failure(s) (latest: ${what})`);
    }
  },
  exitTimeout(message) {
    if (this.okEver) { console.error(`pidge: ${message} (= 'no answer yet', not a failure)`); process.exit(3); }
    console.error(`pidge: ${message} — and NOT ONE healthy round-trip all session: the CHANNEL looks broken (server/network), not the human ignoring you. Surface this to your human.`);
    process.exit(4);
  },
};

// ---------------------------------------------------------------------------
// Realtime (#118): a minimal ActionCable client over the runtime's native
// WebSocket (Node ≥22). The token rides an extra Sec-WebSocket-Protocol entry
// (the browser-style API can't set headers). The WS is a WAKE-UP + payload
// channel only — every durable read (message backlog, chosen_action) still
// goes over HTTP, so a dropped socket costs latency, never data.
// ---------------------------------------------------------------------------
function wantRealtime() {
  if (v['no-realtime']) return false;
  if (typeof WebSocket !== 'function') {
    if (v.realtime) console.error('pidge: --realtime needs a native WebSocket (Node ≥22) — falling back to polling');
    return false;
  }
  return true;
}

// Speak just enough of the protocol: welcome → subscribe → confirm → frames.
// The server pings every ~3 s — that heartbeat is the liveness check (silence
// >15 s ⇒ the socket is dead even if TCP hasn't noticed; close → caller
// reconnects). Returns {close()} or null if the constructor itself failed.
function cableSubscribe({ channel, onUp, onFrame, onDown }) {
  let ws;
  try {
    ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/cable', ['actioncable-v1-json', TOKEN]);
  } catch (e) { onDown(e.message); return null; }
  const identifier = JSON.stringify({ channel });
  let lastBeat = Date.now();
  let closed = false;
  const die = (why) => {
    if (closed) return; closed = true;
    clearInterval(beatCheck);
    try { ws.close(); } catch { /* already closing */ }
    onDown(why);
  };
  const beatCheck = setInterval(() => {
    if (Date.now() - lastBeat > 15000) die('heartbeat lost (server gone?)');
  }, 5000);
  ws.onopen = () => ws.send(JSON.stringify({ command: 'subscribe', identifier }));
  ws.onmessage = (e) => {
    lastBeat = Date.now();
    let f; try { f = JSON.parse(e.data); } catch { return; }
    if (f.type === 'ping' || f.type === 'welcome') return;
    if (f.type === 'confirm_subscription') { onUp && onUp(); return; }
    if (f.type === 'reject_subscription') { die('subscription rejected (bad token?)'); return; }
    if (f.identifier === identifier && f.message) onFrame(f.message);
  };
  ws.onerror = () => { /* onclose follows with the code */ };
  ws.onclose = (e) => die(`socket closed (${e.code})`);
  return { close: () => { closed = true; clearInterval(beatCheck); try { ws.close(); } catch { /* noop */ } } };
}

// Run one WS subscription session until the deadline / an unrecoverable WS
// problem, reconnecting with backoff in between (a deploy = seconds of gap; the
// criterion: hours-long listens must SURVIVE it, #119). onUp/onFrame get a
// `finish(reason)` to end the session (e.g. when the answer landed over HTTP).
// Resolves 'deadline' | 'ws-unavailable'.
async function cableSession({ channel, deadline, onUp, onFrame }) {
  let wsFails = 0;
  while (Date.now() < deadline) {
    const outcome = await new Promise((resolve) => {
      let sub = null;
      let settled = false;
      const finish = (reason) => {
        if (settled) return; settled = true;
        clearTimeout(guard);
        if (sub) sub.close();
        resolve(reason);
      };
      const guard = setTimeout(() => finish('deadline'), Math.max(0, deadline - Date.now()));
      sub = cableSubscribe({
        channel,
        onUp: () => { wsFails = 0; onUp(finish); },
        onFrame: (frame) => onFrame(frame, finish),
        onDown: (why) => finish(`down: ${why}`),
      });
      if (!sub) finish('down: no socket');
    });
    if (outcome === 'deadline') return 'deadline';
    if (!outcome.startsWith('down: ')) return outcome; // caller-driven finish (e.g. 'answered')
    wsFails++;
    const MAX_WS_FAILS = 4; // then fall back to polling for the rest of the session
    if (wsFails >= MAX_WS_FAILS) return 'ws-unavailable';
    const backoff = Math.min(2000 * wsFails, 10000);
    console.error(`pidge: realtime socket ${outcome.replace('down: ', '')} — reconnecting in ${Math.round(backoff / 1000)}s (attempt ${wsFails}/${MAX_WS_FAILS})`);
    await sleep(backoff);
  }
  return 'deadline';
}

// Map CLI flags → the /notify JSON body, including only what was provided.
function buildBody() {
  if (!v.title) die('pidge: --title is required', 1);
  const body = { title: v.title };
  if (v.body !== undefined) body.body = v.body;
  if (v['body-markdown'] !== undefined) body.body_markdown = v['body-markdown'];
  if (v.subtitle !== undefined) body.subtitle = v.subtitle;
  if (v.template !== undefined) body.template = v.template;
  if (v.profile !== undefined) body.profile = v.profile;
  if (v['event-at'] !== undefined) body.event_at = v['event-at'];
  if (v['lead-minutes'] !== undefined) body.lead_minutes = parseInt(v['lead-minutes'], 10);
  if (v.urgency !== undefined) body.urgency = v.urgency;
  if (v.url !== undefined) body.url = v.url;
  if (v.copy !== undefined) body.copy = v.copy;
  if (v['deliver-at'] !== undefined) body.deliver_at = v['deliver-at'];
  if (v['reply-to'] !== undefined) body.reply_to = v['reply-to'];
  if (v['correlation-id'] !== undefined) body.correlation_id = v['correlation-id'];
  if (v.thread !== undefined) body.thread_id = v.thread;
  if (v.after !== undefined) body.after = v.after;
  if (v['collapse-key'] !== undefined) body.collapse_key = v['collapse-key'];
  if (v.actions !== undefined) body.actions = v.actions.split(',').filter(Boolean);

  const customs = v['custom-action'] || [];
  if (customs.length) {
    body.custom_actions = customs.map((spec) => {
      const [id, label, ...flags] = spec.split(':');
      // #157 P2: fail fast locally — the rule is stable and the server 422
      // costs a round-trip an agent then has to interpret.
      if (!/^[a-z0-9_]{1,40}$/.test(id || '')) {
        die(`pidge: --custom-action id ${JSON.stringify(id)} is invalid — lowercase letters, digits and underscore only (^[a-z0-9_]{1,40}$)`, 1);
      }
      const ca = { id, label };
      if (flags.includes('destructive')) ca.style = 'destructive';
      if (flags.includes('confirm')) ca.confirm = true;
      if (flags.includes('biometric')) ca.biometric = true;
      if (flags.includes('terminal')) ca.terminal = true;
      return ca;
    });
  }

  // Escape hatch: any raw /notify field, so a NEW server field documented in the
  // manifest works the day it ships — no CLI release needed. JSON values parse
  // (numbers/bools/objects); anything else passes as a string.
  for (const pair of v.param || []) {
    const eq = pair.indexOf('=');
    if (eq < 1) die(`pidge: --param expects KEY=VALUE, got ${JSON.stringify(pair)}`, 1);
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    let value = raw;
    try { value = JSON.parse(raw); } catch { /* keep the string */ }
    body[key] = value;
  }
  return body;
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
  '.pdf': 'application/pdf', '.csv': 'text/csv', '.txt': 'text/plain',
  '.md': 'text/markdown', '.json': 'application/json', '.zip': 'application/zip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const guessMime = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

// Multipart upload of a local file to POST /api/v1/uploads → the opaque `ref`
// /notify accepts as `image`/`file`. This is how a LOCALLY-generated artifact
// reaches the phone: the agent's machine has no public URL and the push payload
// is far too small to carry a file.
async function uploadFile(filePath) {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(filePath)], { type: guessMime(filePath) }),
            path.basename(filePath));
  let res, raw;
  try {
    res = await fetch(`${BASE}/api/v1/uploads`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: fd,
    });
    raw = await res.text();
  } catch (e) {
    die(`pidge: upload failed (network): ${e.message}`, 2);
  }
  if (!(res.status >= 200 && res.status < 300)) die(`pidge: upload failed (${res.status}): ${raw}`, 2);
  let ref;
  try { ref = JSON.parse(raw).ref; } catch { /* fall through */ }
  if (!ref) die('pidge: upload returned no ref', 2);
  return ref;
}

// --image / --file: an existing local path is uploaded and swapped for its ref;
// anything else (an https URL on --image, or an already-minted ref) passes through
// untouched — the server 422s self-describingly on an invalid value.
async function resolveMedia(body) {
  for (const key of ['image', 'file']) {
    if (v[key] === undefined) continue;
    if (fs.existsSync(v[key])) {
      body[key] = await uploadFile(v[key]);
    } else if (key === 'file' && (/^[./~]/.test(v[key]) || v[key].includes('/'))) {
      // --file is PATH-only (no URL form) — fail fast on a typo'd path; the remote
      // 422 ("ref invalid — re-upload") would misdirect the agent's self-heal.
      die(`pidge: --file: no such file: ${v[key]}`, 1);
    } else {
      body[key] = v[key];
    }
  }
}

// POST /notify. Returns { ok, info, raw }. Emits to STDERR what an agent most
// needs to KNOW (0 devices / no banner buttons / an armed alarm / a policy
// degrade), so stdout stays free for machine output.
async function doNotify() {
  const payload = buildBody();
  await resolveMedia(payload);
  let res, raw;
  try {
    res = await fetch(`${BASE}/api/v1/notify`, {
      method: 'POST', headers, body: JSON.stringify(payload),
    });
    raw = await res.text();
  } catch (e) {
    die(`pidge: send failed (network): ${e.message}`, 2);
  }
  checkManifestNews(res);
  const ok = res.status >= 200 && res.status < 300;
  let info = {};
  try { info = JSON.parse(raw); } catch { /* leave {} */ }
  if (ok) {
    // #56: the same correlation_id while still scheduled EDITS in place.
    if (info.updated)
      console.error('pidge: updated scheduled notification (same correlation_id, nothing fires twice)');
    if (info.registered_devices === 0)
      console.error('pidge: 0 registered devices — nobody will receive this');
    if (info.render_mode === 'detail_only')
      console.error('pidge: render_mode=detail_only — the banner shows NO buttons; the user must open the app to act (use a banner-eligible action shape if you want quick taps)');
    const esc = info.escalation;
    if (esc && (esc.state === 'pending' || esc.state === 'armed')) {
      const when = esc.after_minutes != null ? `${esc.after_minutes} min after delivery` : 'on delivery';
      console.error(`pidge: ESCALATES TO ALARM if unanswered ${when} (answering/snoozing defuses it)`);
    }
    if (info.degraded)
      console.error(`pidge: DEGRADED by channel policy — ${info.degrade_reason} (delivered anyway, quieter; the human's setting, don't retry harder)`);
    // #49: threads — remind the agent how to keep the conversation grouped.
    if (info.thread_id)
      console.error(`pidge: thread=${info.thread_id} — send follow-ups with the same --thread to group them on the phone`);
  } else {
    console.error(`pidge: send failed (${res.status}): ${raw}`);
  }
  return { ok, info, raw };
}

// Poll GET /notifications/:cid until a TERMINAL answer, print chosen_action JSON to
// stdout, exit 0. A snooze (snooze / reschedule-to-a-time) is non-terminal — it
// re-fires — so keep waiting through it. Exits 3 on timeout.
// Long-poll (#45): each GET carries ?wait=N (≤55 s) and the SERVER holds it until
// the user acts — answer latency ~instant, ~1 request/min. --interval is only the
// fallback pace against an old server that ignores `wait` (returns immediately).
async function doWait(cid, { timeout, interval }) {
  const deadline = Date.now() + timeout * 1000;
  let firedNotice = false;
  for (;;) {
    // Degraded (#119): a held poll keeps dying behind some edge — switch to
    // PLAIN GETs (the requests that kept working in the wild) on a slow pace.
    const waitS = health.degraded ? 0 : Math.max(0, Math.min(25, Math.ceil((deadline - Date.now()) / 1000)));
    const url = `${BASE}/api/v1/notifications/${encodeURIComponent(cid)}${waitS > 0 ? `?wait=${waitS}` : ''}`;
    const askedAt = Date.now();
    try {
      const res = await fetchT(url, { headers }, (waitS + 10) * 1000);
      checkManifestNews(res);
      if (res.status === 200) {
        health.ok();
        const data = await res.json().catch(() => ({}));
        if (data.responded) {
          const chosen = data.chosen_action || {};
          if (chosen.kind === 'snoozed') {
            console.error(`pidge: snoozed until ${chosen.snooze_until || chosen.at} — re-fires then, still waiting`);
          } else {
            console.log(JSON.stringify(chosen, null, 2));
            process.exit(0);
          }
        } else if (!firedNotice && data.escalation && data.escalation.state === 'fired') {
          firedNotice = true;
          // #70: stopping the ring on-device now reports `seen` (seen_at flips);
          // snoozing it is a real snoozed event this loop narrates.
          console.error('pidge: the escalation alarm FIRED and there is still no answer — seen_at tells you if the human at least silenced it; keep waiting or back off');
        }
      } else if (res.status === 404) {
        health.ok(); // the server ANSWERED — the channel is fine, the cid isn't known (yet)
        console.error(`pidge: no notification for correlation_id=${cid}`);
        // keep polling — the agent may call wait/ask before the send round-trips
      } else if (res.status >= 500) {
        health.fail(`poll error ${res.status}`); // aggregated — no line per failure
      } else {
        health.ok();
        console.error(`pidge: poll error ${res.status}`);
      }
    } catch (e) {
      health.fail(`network: ${e.message}`);
    }

    if (Date.now() >= deadline) {
      health.exitTimeout(`timed out after ${timeout}s waiting on ${cid}`);
    }
    // A server WITH long-poll just held us for waitS — loop right back. One that
    // ignored `wait`, an error, or degraded mode returned fast: pace ourselves.
    const pace = health.degraded ? DEGRADED_INTERVAL_S : interval;
    if (Date.now() - askedAt < 2000) {
      await sleep(Math.min(pace, Math.max(1, Math.ceil((deadline - Date.now()) / 1000))) * 1000);
    }
  }
}

// Realtime wait (#118): hold an InboxChannel subscription and treat every frame
// for OUR cid as a wake-up; the durable answer is always re-read over HTTP
// (doWait prints + exits). A safety re-check every 60 s covers a frame lost in
// a reconnect gap. Returns only when WS can't carry us — caller falls back.
async function realtimeWait(cid, { timeout, interval }) {
  const deadline = Date.now() + timeout * 1000;
  const answered = async () => {
    try {
      const res = await fetchT(`${BASE}/api/v1/notifications/${encodeURIComponent(cid)}`, { headers });
      if (res.status !== 200) return false;
      const data = await res.json().catch(() => ({}));
      return !!(data.responded && data.chosen_action && data.chosen_action.kind !== 'snoozed');
    } catch { return false; }
  };
  let safety = null;
  const outcome = await cableSession({
    channel: 'InboxChannel',
    deadline,
    onUp: (finish) => {
      health.ok();
      // catch an answer that landed while we were connecting/offline
      answered().then((done) => done && finish('answered'));
      clearInterval(safety);
      safety = setInterval(() => answered().then((done) => done && finish('answered')), 60000);
    },
    onFrame: (m, finish) => {
      if (m.type !== 'event' || m.correlation_id !== cid) return;
      if (m.kind === 'delivered') console.error('pidge: delivered to the phone');
      else if (m.kind === 'seen') console.error('pidge: the human OPENED it (no answer yet)');
      else if (m.kind === 'snoozed') console.error(`pidge: snoozed until ${m.snooze_until || m.at} — re-fires then, still waiting`);
      else if (m.responded) finish('answered');
    },
  });
  clearInterval(safety);
  if (outcome === 'answered') {
    // fetch + print + exit via the poller (one quick authoritative read)
    await doWait(cid, { timeout: Math.max(10, Math.ceil((deadline - Date.now()) / 1000)), interval });
  }
  if (outcome === 'deadline') {
    health.exitTimeout(`timed out after ${timeout}s waiting on ${cid}`);
  }
  console.error('pidge: realtime unavailable — falling back to HTTP polling (same contract, less instant)');
  return Math.max(1, Math.ceil((deadline - Date.now()) / 1000)); // remaining budget
}

// wait/ask entry: WS when we can, polling as the universal fallback (#118/#119).
async function waitForAnswer(cid, { timeout, interval }) {
  let budget = timeout;
  if (wantRealtime()) budget = await realtimeWait(cid, { timeout, interval });
  await doWait(cid, { timeout: budget, interval });
}

const num = (val, fallback) => (val !== undefined ? parseInt(val, 10) : fallback);

// ---------------------------------------------------------------------------
// Onboarding v2 (#110): setup --claim / doctor / whoami / skill install.
// ---------------------------------------------------------------------------

const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'pidge');
const CONFIG_FILE = path.join(CONFIG_DIR, 'env');

// Where the token came from — doctor narrates it, setup respects precedence.
function tokenSource() {
  if (process.env.PIDGE_TOKEN || process.env.HERALD_TOKEN) return 'env var';
  if (FILE_ENV.PIDGE_TOKEN) return CONFIG_FILE;
  return null;
}

// GET /whoami — which channel does this key speak for. Returns {res, data}.
async function fetchWhoami(base = BASE, token = TOKEN) {
  const res = await fetchT(`${base}/api/v1/whoami`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  let data = {};
  try { data = await res.json(); } catch { /* leave {} */ }
  return { res, data };
}

// doctor: validate the setup WITHOUT exposing secrets. Narration on stderr,
// a compact machine-readable line on stdout. Exit 0 healthy / 2 broken.
async function runDoctor(base = BASE, token = TOKEN) {
  const source = token === TOKEN ? tokenSource() : CONFIG_FILE; // post-setup call passes the fresh token
  if (!token) {
    console.error('pidge doctor: NO TOKEN — set PIDGE_TOKEN, or onboard with `pidge setup --claim <code>` (the human copies the code from the Pidge app)');
    process.exit(2);
  }
  console.error(`pidge doctor: token found (${source || 'passed in'}) — never displayed`);
  console.error(`pidge doctor: server ${base}`);
  let out;
  try {
    out = await fetchWhoami(base, token);
  } catch (e) {
    console.error(`pidge doctor: server UNREACHABLE — ${e.message} (check the URL; is it ${base}?)`);
    process.exit(2);
  }
  const { res, data } = out;
  checkManifestNews(res);
  if (res.status === 401) {
    console.error('pidge doctor: server reachable but the key is INVALID/REVOKED — re-onboard: ask your human for a fresh claim code (Pidge app → Canais → o canal → copiar prompt de setup)');
    process.exit(2);
  }
  if (res.status === 404) {
    // pre-#110 server: no /whoami yet — the key may still be fine; prove it on the manifest.
    const m = await fetchT(`${base}/api/v1/manifest`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
    if (m && m.status === 200) {
      console.error('pidge doctor: key VALID (server predates /whoami — channel/device detail unavailable; update the server to see it)');
      console.log(JSON.stringify({ ok: true, base_url: base, channel: null, devices: null }));
      process.exit(0);
    }
    console.error(`pidge doctor: unexpected ${m ? m.status : 'network error'} on the manifest — server looks broken`);
    process.exit(2);
  }
  if (res.status !== 200) {
    console.error(`pidge doctor: unexpected ${res.status} from /whoami — ${JSON.stringify(data)}`);
    process.exit(2);
  }
  const devices = data.devices ?? 0;
  console.error(`pidge doctor: key valid — canal "${data.channel && data.channel.name}" · ${devices} device(s)`);
  if (devices === 0)
    console.error('pidge doctor: WARNING — 0 devices: sends will reach NOBODY until the human installs/opens the Pidge app on their iPhone');
  console.error('pidge doctor: all good — try: pidge ask --template decision --title "Pidge funcionando?"');
  console.log(JSON.stringify({ ok: true, base_url: base, channel: data.channel, devices, manifest_version: data.manifest_version }));
  process.exit(0);
}

// setup --claim: exchange the single-use code for the key, store it ourselves
// (the secret never appears on screen or in the chat the prompt was pasted in),
// then prove the loop with doctor.
async function runSetup() {
  const code = v.claim;
  if (!code) die('pidge: usage: pidge setup --claim <code> [--url <base>]   (the human copies the code from the Pidge app)', 1);
  const base = (v.url || process.env.PIDGE_URL || FILE_ENV.PIDGE_URL || 'https://pidge.sh').replace(/\/+$/, '');
  let res, data = {};
  try {
    res = await fetchT(`${base}/api/v1/claim`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    try { data = await res.json(); } catch { /* leave {} */ }
  } catch (e) {
    die(`pidge: claim failed (network): ${e.message} — is the server URL right? (${base})`, 2);
  }
  if (res.status === 404)
    die('pidge: claim code unknown, EXPIRED (15 min TTL) or already used — ask your human for a fresh one (Pidge app → Canais → o canal → copiar prompt de setup)', 2);
  if (!(res.status >= 200 && res.status < 300) || !data.key)
    die(`pidge: claim failed (${res.status}): ${JSON.stringify(data)}`, 2);

  const finalBase = (data.base_url || base).replace(/\/+$/, '');
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, `PIDGE_URL=${finalBase}\nPIDGE_TOKEN=${data.key}\n`, { mode: 0o600 });
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* mode set on create */ }
  console.error(`pidge: configured for canal "${data.channel && data.channel.name}" — key stored in ${CONFIG_FILE} (chmod 600, never displayed)`);
  await runDoctor(finalBase, data.key);
}

// skill install (#110e): persistent Pidge knowledge for Claude Code agents —
// a skill generated FROM the live manifest (so it can't drift), versioned with
// manifest_version (re-run to update; whats_new is the changelog).
async function runSkillInstall() {
  let res, m;
  try {
    res = await fetchT(`${BASE}/api/v1/manifest`, { headers });
    m = await res.json();
  } catch (e) {
    die(`pidge: could not read the manifest: ${e.message}`, 2);
  }
  if (res.status !== 200) die(`pidge: manifest read failed (${res.status})`, 2);
  const table = (m.templates && m.templates.decision_table) || [];
  const profileTable = (m.profiles && m.profiles.decision_table) || [];
  const notes = m.notes || [];
  const exits = (m.cli && m.cli.output) || '';
  const skill = `---
name: pidge
description: Send rich, actionable iPhone notifications to your human and get their decision back (Pidge). Use when finishing long tasks (report), needing a decision/approval, sending FYIs with substance, or anything time-anchored. Also covers reading the human's replies/messages back.
---

# Pidge — notify your human, get answers back

Generated from manifest v${m.manifest_version} of ${BASE} — re-run \`pidge skill install\` to update (any API response header X-Pidge-Manifest-Version > ${m.manifest_version} means there's news).

All commands: \`npx pidge-cli …\` (Node ≥18; reads ~/.config/pidge/env — no token in context). Not set up? \`pidge doctor\` tells you; onboard with \`pidge setup --claim <code>\` (the human copies the code from the Pidge app).

## Pick the right send (decision table)

${table.map((r) => `- ${r}`).join('\n')}

## How it intrudes (profiles — the human owns them)

${profileTable.map((r) => `- ${r}`).join('\n')}

## The contract

${notes.map((n) => `- ${n}`).join('\n')}

## Getting answers

- \`pidge ask …\` blocks and prints chosen_action JSON; \`pidge wait <cid>\` blocks on an existing send.
- \`pidge listen\` blocks until the human MESSAGES you from the app (composer) — run it when idle.
- ${exits}

## Full spec

\`curl $PIDGE_URL/api/v1/manifest -H "Authorization: Bearer $PIDGE_TOKEN"\` — the always-current contract (fields, templates, custom actions, media, threads, realtime).
`;
  const dir = path.join(process.cwd(), '.claude', 'skills', 'pidge');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, skill);
  console.error(`pidge: skill written to ${file} (manifest v${m.manifest_version}) — your future sessions in this project know Pidge now`);
  console.log(JSON.stringify({ ok: true, file, manifest_version: m.manifest_version }));
  process.exit(0);
}

(async () => {
  switch (command) {
    case 'setup': {
      await runSetup(); // exits via runDoctor
      break;
    }
    case 'doctor': {
      await runDoctor();
      break;
    }
    case 'whoami': {
      const { res, data } = await fetchWhoami().catch((e) => { die(`pidge: whoami failed (network): ${e.message}`, 2); });
      checkManifestNews(res);
      if (res.status !== 200) die(`pidge: whoami failed (${res.status}): ${JSON.stringify(data)}`, 2);
      console.log(JSON.stringify(data, null, 2));
      console.error(`pidge: you are canal "${data.channel && data.channel.name}" · ${data.devices ?? '?'} device(s)`);
      process.exit(0);
      break;
    }
    case 'skill': {
      if (parsed.positionals[1] !== 'install') die('pidge: usage: pidge skill install', 1);
      await runSkillInstall();
      break;
    }
    case 'notify': {
      const { ok, info, raw } = await doNotify();
      console.log(raw);
      if (ok && info.correlation_id)
        console.error(`pidge: correlation_id=${info.correlation_id} (use: pidge wait ${info.correlation_id})`);
      process.exit(ok ? 0 : 2);
      break;
    }
    case 'ask': {
      // Send, then block on the answer in one shot. stdout = ONLY chosen_action JSON.
      // tracking is Live-Activity-only: it NEVER produces a chosen_action, so an ask
      // would block the full timeout believing the human is deciding.
      if (v.profile === 'tracking')
        die('pidge: `ask --profile tracking` makes no sense — tracking never produces an answer (use the live_activities API; need a decision? send a real profile)', 1);
      if (!v.title) die('pidge: --title is required', 1);
      // The cid is minted CLIENT-side when not given, and printed as the FIRST
      // stderr line (greppable) — a killed/crashed ask always leaves the handle
      // behind, so the agent can `pidge wait <cid>` instead of re-sending.
      const cid = v['correlation-id'] || crypto.randomUUID();
      v['correlation-id'] = cid;
      console.error(`pidge: correlation_id=${cid}`);
      const { ok, info } = await doNotify();
      if (!ok) process.exit(2);
      console.error(`pidge: sent (${info.registered_devices} device(s)) — waiting on ${cid}`);
      // #132: no --timeout ⇒ obey the template's suggestion from the 201 echo
      // (human decisions take 30-40 min in the wild; a 600 s default misread
      // them as silence). Explicit --timeout always wins.
      let timeout = num(v.timeout, NaN);
      if (!Number.isFinite(timeout)) {
        if (info.suggested_ask_timeout) {
          timeout = info.suggested_ask_timeout;
          const mins = Math.round(timeout / 60);
          console.error(`pidge: timeout ${mins} min — suggested by template ${info.template || v.template} (override with --timeout)`);
        } else {
          timeout = 600;
        }
      }
      await waitForAnswer(cid, { timeout, interval: num(v.interval, 30) });
      break;
    }
    case 'wait': {
      const cid = parsed.positionals[1];
      if (!cid) die('pidge: usage: pidge wait <correlation_id> [--timeout N] [--interval N]', 1);
      await waitForAnswer(cid, { timeout: num(v.timeout, 300), interval: num(v.interval, 30) });
      break;
    }
    case 'cancel': {
      // #56: withdraw a still-scheduled notification (also kills a snooze re-fire).
      // Exit 0 cancelled (idempotent) · 2 otherwise (404 unknown, 409 too late).
      const cid = parsed.positionals[1];
      if (!cid) die('pidge: usage: pidge cancel <correlation_id>', 1);
      let res, raw;
      try {
        res = await fetch(`${BASE}/api/v1/notifications/${encodeURIComponent(cid)}`, {
          method: 'DELETE', headers,
        });
        raw = await res.text();
      } catch (e) {
        die(`pidge: cancel failed (network): ${e.message}`, 2);
      }
      checkManifestNews(res);
      console.log(raw);
      if (res.status >= 200 && res.status < 300) {
        console.error(`pidge: cancelled ${cid} — nothing will fire`);
        process.exit(0);
      }
      console.error(`pidge: cancel failed (${res.status}) — ${res.status === 409 ? 'too late, it already reached the phone' : 'unknown correlation_id?'}`);
      process.exit(2);
      break;
    }
    case 'inbox': {
      // #83: what this channel sent — the list (default), the pending slice
      // (--pending = delivered + still unanswered) or the one-call summary
      // (--summary = counts + answer latency). stdout = raw server JSON.
      const qs = new URLSearchParams();
      if (v.all) qs.set('all', 'true');
      let inboxPath = '/api/v1/inbox/summary';
      if (!v.summary) {
        inboxPath = '/api/v1/notifications';
        if (v.pending) qs.set('pending', 'true');
        if (v.limit !== undefined) qs.set('limit', v.limit);
      }
      let res, raw;
      try {
        res = await fetch(`${BASE}${inboxPath}${qs.size ? `?${qs}` : ''}`, { headers });
        raw = await res.text();
      } catch (e) {
        die(`pidge: inbox failed (network): ${e.message}`, 2);
      }
      checkManifestNews(res);
      console.log(raw);
      if (!(res.status >= 200 && res.status < 300)) die(`pidge: inbox failed (${res.status})`, 2);
      let data = {};
      try { data = JSON.parse(raw); } catch { /* leave {} */ }
      if (v.summary) {
        const latency = data.avg_response_seconds != null
          ? `, human answers in ~${Math.round(data.avg_response_seconds / 60)} min` : '';
        console.error(`pidge: ${data.total} sent (${data.scope}) — ${data.pending} pending${latency}`);
      } else {
        const rows = data.notifications || [];
        const pendingCount = rows.filter((r) => r.status === 'delivered' && !r.responded).length;
        console.error(`pidge: ${rows.length} notification(s)${v.pending ? ' pending' : ` — ${pendingCount} pending`} (add --summary for counts+latency)`);
      }
      process.exit(0);
      break;
    }
    case 'listen': {
      // #48: block until the human messages this channel (the app's composer),
      // print the messages as JSON, ACK them, exit 0. One-shot by design (loop
      // it, don't daemonize) — same contract as `wait`. Exit 3 on timeout, 4 if
      // the whole session never had a healthy round-trip (#119).
      // At-least-once: the ack happens AFTER the print — a crash re-serves them;
      // dedupe by id if you've seen one before.
      // --all (#131): the SINGLE EAR — the queue also serves notification
      // ANSWERS (kind notification_reply, with a self-contained ref), so a
      // fire-and-forget notify can't lose its reply. Without --all the original
      // composer-only contract stands (no double-consumption for ask/wait users).
      const timeout = num(v.timeout, 600);
      let deadline = Date.now() + timeout * 1000;
      const queueQs = v.all ? '?all=true' : '';
      // #157 P2 --follow: print+ack a batch and KEEP listening until the
      // timeout — the supervisor loop without re-spawning a process per batch.
      let gotAny = false;
      const followEnd = () => {
        if (v.follow && gotAny) {
          console.error(`pidge: --follow window ended after ${timeout}s — batches were delivered`);
          process.exit(0);
        }
        return false;
      };

      // Print + ack (+ exit 0 unless --follow) — shared by the WS and polling paths.
      const printAndAck = async (msgs) => {
        console.log(JSON.stringify(msgs, null, 2));
        // #131: narrate answers so the agent knows WHICH notification spoke back.
        for (const m of msgs) {
          if (m.kind === 'notification_reply' && m.ref) {
            const said = m.text ? `: ${String(m.text).slice(0, 120)}` : '';
            console.error(`pidge: reply to your notification ${m.ref.correlation_id} ("${m.ref.title}") — ${m.action_id || m.ref.event_kind}${said}`);
            if (m.truncated) console.error('pidge: that reply hit the server cap (truncated:true) — tell your human the tail was lost');
          }
        }
        const upTo = Math.max(...msgs.map((m) => m.id));
        try {
          // fetchT, not fetch: a wedged proxy stalling this ack would otherwise
          // pin the process forever (the WS drain path awaits printAndAck's exit
          // with no deadline) — messages are already printed, so a timeout here
          // just re-serves them next listen (at-least-once).
          const ack = await fetchT(`${BASE}/api/v1/messages/ack`, {
            method: 'POST', headers, body: JSON.stringify({ up_to: upTo }),
          });
          if (ack.status >= 200 && ack.status < 300) {
            console.error(`pidge: ${msgs.length} message(s) from the human — acked (answer via notify; reuse thread_id when present)`);
          } else {
            console.error(`pidge: WARNING — ack failed (${ack.status}); these messages will be re-served next listen`);
          }
        } catch (e) {
          console.error(`pidge: WARNING — ack failed (network: ${e.message}); these messages will be re-served next listen`);
        }
        gotAny = true;
        if (!v.follow) process.exit(0);
        console.error('pidge: --follow — still listening');
      };

      // Realtime path (#118): hold ConversationChannel — the human sees "ouvindo
      // agora" — and treat frames as wake-ups: the BACKLOG is always re-read over
      // a plain GET (at-least-once; also catches messages sent while offline).
      if (wantRealtime()) {
        let draining = false;
        const drain = async (finish) => {
          if (draining) return;
          draining = true;
          try {
            const res = await fetchT(`${BASE}/api/v1/messages${queueQs}`, { headers });
            checkManifestNews(res);
            if (res.status === 200) {
              health.ok();
              const msgs = (await res.json().catch(() => ({}))).messages || [];
              if (msgs.length) {
                if (!v.follow) finish('got-messages');
                await printAndAck(msgs);
              }
            } else if (res.status >= 500) {
              health.fail(`backlog read ${res.status}`);
            }
          } catch (e) {
            health.fail(`backlog read (network: ${e.message})`);
          } finally {
            draining = false;
          }
        };
        let announced = false;
        const sessions = [cableSession({
          channel: 'ConversationChannel',
          deadline,
          onUp: (finish) => {
            if (!announced) { announced = true; console.error(`pidge: listening over the realtime socket${v.all ? ' — single ear: composer + notification answers (#131)' : ''} (the human sees "ouvindo agora")`); }
            drain(finish);
          },
          onFrame: (m, finish) => { if (m.type === 'message') drain(finish); },
        })];
        // --all (#131): answers broadcast on InboxChannel, not Conversation — a
        // second subscription wakes the same HTTP drain (the queue is the ledger;
        // the loser session leaks until exit, harmless in a one-shot process).
        if (v.all) {
          sessions.push(cableSession({
            channel: 'InboxChannel',
            deadline,
            onUp: (finish) => drain(finish),
            onFrame: (m, finish) => { if (m.type === 'event' && m.responded) drain(finish); },
          }));
        }
        const outcome = await Promise.race(sessions);
        if (outcome === 'deadline') {
          followEnd();
          health.exitTimeout(`timed out after ${timeout}s — no message from the human`);
        }
        if (outcome === 'got-messages') {
          await new Promise(() => {}); // printAndAck is in flight and exits the process
        }
        console.error('pidge: realtime unavailable — falling back to HTTP polling (same contract, less instant)');
      }

      for (;;) {
        const waitS = health.degraded ? 0 : Math.max(0, Math.min(25, Math.ceil((deadline - Date.now()) / 1000)));
        const askedAt = Date.now();
        try {
          const qs = new URLSearchParams();
          if (waitS > 0) qs.set('wait', String(waitS));
          if (v.all) qs.set('all', 'true');
          const res = await fetchT(`${BASE}/api/v1/messages${qs.size ? `?${qs}` : ''}`, { headers }, (waitS + 10) * 1000);
          checkManifestNews(res);
          if (res.status === 200) {
            health.ok();
            const data = await res.json().catch(() => ({}));
            const msgs = data.messages || [];
            if (msgs.length) await printAndAck(msgs);
          } else if (res.status >= 500) {
            health.fail(`listen error ${res.status}`); // aggregated (#119) — no line per attempt
          } else {
            health.ok();
            console.error(`pidge: listen error ${res.status}`);
          }
        } catch (e) {
          health.fail(`network: ${e.message}`);
        }
        if (Date.now() >= deadline) {
          followEnd();
          health.exitTimeout(`timed out after ${timeout}s — no message from the human`);
        }
        const pace = health.degraded ? DEGRADED_INTERVAL_S : num(v.interval, 5);
        if (Date.now() - askedAt < 2000) {
          await sleep(Math.min(pace, Math.max(1, Math.ceil((deadline - Date.now()) / 1000))) * 1000);
        }
      }
      break;
    }
    default:
      die(USAGE, 1);
  }
})();
