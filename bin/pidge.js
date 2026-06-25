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

// `pidge --version` / `-v` — handled BEFORE parseArgs (which would otherwise
// throw "Unknown option" on the undeclared flag). Prints the version, exit 0.
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  try { console.log(require(path.join(__dirname, '..', 'package.json')).version); }
  catch { console.log('unknown'); }
  process.exit(0);
}

// Per-agent isolation (incident 2026-06-13): ~/.config/pidge/env is one slot
// per machine-user, so N agents sharing a HOME share an identity — one agent's
// setup hijacked another's cron. The fix is a NON-secret namespacing var the
// human sets ONCE at each agent's launch: PIDGE_AGENT=<id> → the config lives
// at ~/.config/pidge/agents/<id>/env, isolated by construction. The CLI still
// WRITES the key (the agent never sees it — #57 hygiene intact), it's just
// per-agent now. No PIDGE_AGENT ⇒ the legacy shared file (single-agent only).
// (An explicit PIDGE_TOKEN env var still wins over any file — the purest
// per-agent path.)
const AGENT_ID = (process.env.PIDGE_AGENT || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
function pidgeConfigDir() {
  const base = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'pidge');
  return AGENT_ID ? path.join(base, 'agents', AGENT_ID) : base;
}

// #57 token hygiene: when the env vars are unset, fall back to the config file
// (KEY=VALUE the CLI writes during setup, or the HUMAN writes once) so the raw
// hld_… key never rides the agent's chat/context. Explicit env vars always win;
// `export ` prefixes, quotes and #comments are tolerated.
function configEnv() {
  try {
    const file = path.join(pidgeConfigDir(), 'env');
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
  escalate: { type: 'boolean' },               // #246: alert type — force an AlarmKit alarm (escalate:true)
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
  'quiet-nag': { type: 'boolean' },            // #241: silence the manifest-version nag for this run
  // onboarding v2 (#110)
  claim: { type: 'string' },                   // setup --claim <single-use code>
  // #157 P2: listen keeps going after a batch (supervisor loop, one process)
  follow: { type: 'boolean' },
  force: { type: 'boolean' },                  // setup: overwrite a config owned by ANOTHER channel
  print: { type: 'boolean' },                  // setup: print export lines instead of writing a file (per-agent, human runs it)
  'listen-mode': { type: 'string' },           // setup: declare operating_contract listen mode (turn_based|always_on; default turn_based)
  // Fix 2 (#170): read-receipt split — `ack` after the work; listen no longer consumes on read.
  'up-to': { type: 'string' },                 // ack: process messages up to this id
  ids: { type: 'string' },                     // ack: process this comma-list of ids
  renew: { type: 'boolean' },                  // ack: heartbeat the visibility-timeout lease (state=delivered)
  'ack-on-read': { type: 'boolean' },          // listen: restore the pre-0.9 immediate-consume
  window: { type: 'string' },                  // selftest: reachability window in seconds (default 30)
};

const USAGE = `pidge — send an iPhone notification to a human and block until they answer.

USAGE
  pidge setup --claim CODE [--url BASE]   one-shot onboarding (#110): exchange the single-use
                                          code for the channel key, store it, run doctor.
                                          MULTI-AGENT: set PIDGE_AGENT=<id> at each agent's launch
                                          → isolated config ~/.config/pidge/agents/<id>/env.
                                          --print  emit 'export PIDGE_TOKEN=…' instead of a file
                                                   (you run it in YOUR terminal; paste into the
                                                   agent's launcher — never run --print as an agent)
                                          --force  overwrite a shared file owned by another channel
                                          --listen-mode turn_based|persistent|external_daemon
                                                   declare how you operate (#182; default turn_based)
  pidge doctor                            validate the setup WITHOUT exposing secrets:
                                          env source, server, key, "canal X · N devices"
  pidge whoami                            which channel does this key speak for (JSON)
  pidge hello  [options]                  FIRST-CONTACT WOW (#217): your channel's debut handshake,
                                          narrated LIVE on the lock screen by a 3-stage Live Activity
                                          (Conectando → toque para confirmar → Concluído ✓). send + wait
                                          in one — run it as your FIRST contact on a fresh channel.
  TYPED SENDS (#246 — pick the one that matches your INTENT):
  pidge fyi    [options]                  passive info, no action — log/registro (template_kind fyi)
  pidge report [options]                  a curated result the human will want to read now (report)
  pidge ask    [options]                  a DECISION — send AND wait; needs --actions (prints chosen_action JSON)
  pidge event  [options]                  a scheduled thing with a time — needs --event-at (event)
  pidge alert  [options]                  an anomaly/error; --escalate forces an AlarmKit alarm (alert)
  pidge live   [options]                  an in-flight task with incremental updates (live)
  pidge notify [options]                  DEPRECATED (0.13.x) — send without a type (server falls back to fyi)
  pidge wait   <correlation_id> [options] block on an already-sent notification
  pidge cancel <correlation_id>           cancel a still-scheduled notification (#56)
  pidge inbox  [--pending|--summary|--all|--limit N]   what you sent: list, pending slice, or counts+latency (#83)
  pidge listen [--timeout N] [--all] [--ack-on-read] [--follow]
                                          block until the human MESSAGES you from the app, print, exit (#48)
                                          #170: a read message is DELIVERED (gray ✓✓), NOT done — ACK it
                                          AFTER the work: pidge ack --up-to <id> (a ~10-min lease re-serves
                                          un-acked messages, so a crash never loses one)
                                          --ack-on-read = the old immediate-consume (ack on print)
                                          --follow      = KEEP listening until --timeout (supervisor-only)
                                          --all (#131)  = the SINGLE EAR: also hear notification ANSWERS
  pidge ack --up-to <id> | --ids a,b [--renew]
                                          mark messages PROCESSED (green ✓✓) after you handled them (#170);
                                          --renew heartbeats the lease on a long task (state=delivered)
  pidge contract set <key>=<value> | contract show
                                          DECLARE how you operate (#182): keep_connection_alive,
                                          mirror_in_origin_session,
                                          listen_mode=turn_based|persistent|external_daemon,
                                          quiet_when_idle. ADVISORY, never policy (the human SEES if you honor it).
  pidge selftest [--window N]             prove your listener works by ROUND-TRIP (#205): fire a nonce,
                                          run the listener, confirm it picks it up + acks in time.
                                          PASS exit 0 / FAIL exit 2 (with the likely cause). Run it as the
                                          last onboarding step + whenever sends seem to go unheard.
  pidge skill install                     write .claude/skills/pidge/SKILL.md generated from the
                                          live manifest (persistent Pidge knowledge for Claude Code)
  pidge --version                         print the CLI version
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
  PIDGE_TOKEN   your channel's bearer key (required; HERALD_TOKEN honored). Setting
                this per agent at launch is the cleanest multi-agent isolation —
                env var always wins over any file.
  PIDGE_AGENT   <id> namespacing the config file to ~/.config/pidge/agents/<id>/env
                so N agents on one machine never share an identity (the CLI still
                writes the key — no secret in the agent's chat). Unset ⇒ the legacy
                shared ~/.config/pidge/env (single-agent only).

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

// ---------------------------------------------------------------------------
// #240: per-subcommand help. `pidge <cmd> --help` (and `pidge help <cmd>`) must
// show the focused help for THAT command — its synopsis, what it does, and only
// the flags that apply — instead of dumping the global USAGE (the bug an agent
// hit: `pidge ask --help` listed the global flags, burying ask's own
// --actions/--timeout). The global USAGE stays the no-command / `pidge --help`
// view. One option dictionary feeds both so the text can't drift.
// ---------------------------------------------------------------------------
const OPTION_DOCS = {
  title: '--title TEXT             (required) the headline',
  body: '--body TEXT              the message shown on the banner',
  'body-markdown': '--body-markdown MD       rich body for the tap-through detail screen',
  subtitle: '--subtitle TEXT          a secondary line under the title',
  template: '--template ID            content/action pattern: context · decision · approval · reminder · nudge · sensitive',
  profile: '--profile ID             delivery profile (the human owns it): default · event · escalating · custom',
  'event-at': '--event-at ISO8601       WHEN the thing happens (required by profile event)',
  'lead-minutes': '--lead-minutes N         notify/countdown N min before event_at (5–240)',
  urgency: '--urgency LEVEL          normal | persistent | alarm (low-level — prefer --profile)',
  escalate: '--escalate               alert: force an AlarmKit alarm that breaks through silent/Focus',
  image: '--image PATH_OR_URL      banner+feed image: a local path is uploaded; an https URL is sent as-is',
  file: '--file PATH              a real artifact (xlsx/pdf/csv…) uploaded for the human (≤25 MB)',
  url: '--url URL                deep link the app opens on tap (PR, dashboard, log)',
  copy: '--copy TEXT              tap-to-copy value on the detail screen',
  actions: '--actions LIST|JSON      comma list from the catalog (yes,no,reply) OR a JSON array of {"id","label"} custom actions',
  'custom-action': '--custom-action SPEC     "id:label[:destructive][:confirm][:biometric][:terminal]" (repeatable)',
  'deliver-at': '--deliver-at ISO8601     schedule the send for later',
  'reply-to': '--reply-to URL           also POST the answer to your webhook (HMAC-signed)',
  'correlation-id': '--correlation-id ID      idempotency + routing key (auto-generated if omitted)',
  thread: '--thread ID              conversation handle (#49): same id ⇒ one strand on the phone',
  after: '--after CID              decision queue (#157): held until that notification is answered',
  'collapse-key': '--collapse-key KEY       replace/update a prior notification',
  param: '--param KEY=VALUE        pass ANY raw /notify field (repeatable) — the manifest is the contract',
  timeout: '--timeout SECONDS        how long to block (ask: 600 · wait: 300 · listen: 600)',
  interval: '--interval SECONDS       FALLBACK poll cadence (default 30) — normally unused (WS/long-poll)',
  realtime: '--realtime               force the realtime WebSocket (warn + fall back to polling if unavailable)',
  'no-realtime': '--no-realtime            polling only (skip the WebSocket)',
  pending: '--pending                only delivered + still-unanswered notifications',
  summary: '--summary                counts + answer latency (one call)',
  'all-inbox': '--all                    whole-account scope (not just this channel)',
  'all-listen': '--all                    single ear: also hear notification ANSWERS, not just messages (#131)',
  limit: '--limit N                cap the number of rows',
  claim: '--claim CODE             the single-use setup code (the human copies it from the Pidge app)',
  'url-base': '--url BASE               the Pidge server base URL (default https://pidge.sh)',
  print: '--print                  emit `export …` lines instead of writing a file (per-agent; you run it)',
  force: '--force                  overwrite a shared config owned by another channel',
  'listen-mode': '--listen-mode MODE       declare how you operate: turn_based | persistent | external_daemon',
  follow: '--follow                 KEEP listening until --timeout (supervisor-only; traps a turn-based agent)',
  'ack-on-read': '--ack-on-read            consume messages on read (pre-0.9 immediate-consume)',
  'up-to': '--up-to ID               process every message up to this id',
  ids: '--ids a,b                process this comma-list of ids',
  renew: '--renew                  heartbeat the visibility-timeout lease instead of processing',
  window: '--window N               reachability window in seconds (default 30)',
  'quiet-nag': '--quiet-nag              silence the "server has new capabilities" nag for this run',
};
// Content flags shared by notify / ask / hello.
const CONTENT_OPTS = ['title', 'body', 'body-markdown', 'subtitle', 'template', 'profile',
  'event-at', 'lead-minutes', 'urgency', 'image', 'file', 'url', 'copy', 'actions',
  'custom-action', 'deliver-at', 'reply-to', 'correlation-id', 'thread', 'after',
  'collapse-key', 'param'];

const HELP = {
  setup: {
    summary: 'one-shot onboarding (#110): exchange a single-use claim code for the channel key, store it, run doctor.',
    usage: 'pidge setup --claim CODE [--url BASE] [--print] [--force] [--listen-mode MODE]',
    body: 'The CLI writes the key itself (chmod 600) — it never appears on screen or in the agent\'s chat. MULTI-AGENT: set PIDGE_AGENT=<id> at each agent\'s launch for an isolated config.',
    opts: ['claim', 'url-base', 'print', 'force', 'listen-mode'],
  },
  doctor: {
    summary: 'validate the setup WITHOUT exposing secrets (env source, server, key, device reach, realtime probe).',
    usage: 'pidge doctor',
    opts: [],
  },
  whoami: {
    summary: 'which channel does this key speak for (prints the identity JSON).',
    usage: 'pidge whoami',
    opts: [],
  },
  hello: {
    summary: 'first-contact WOW (#217): your channel\'s debut handshake, narrated live by a 3-stage Live Activity. send + wait in one.',
    usage: 'pidge hello [options]',
    body: 'A thin wrapper over `ask --template onboarding` with friendly default copy. Run it as your FIRST contact on a fresh channel.',
    opts: [...CONTENT_OPTS, 'timeout', 'interval', 'realtime', 'no-realtime'],
  },
  fyi: {
    summary: 'send passive info the human can read later — no action (#246 type fyi → profile Mensagem).',
    usage: 'pidge fyi --title TEXT [--body TEXT | --body-markdown MD] [--image PATH] [--url URL]',
    body: 'Fire-and-forget: stdout is the raw 201. Use it for logs, registros and neutral summaries — if you need a DECISION use `pidge ask`.',
    opts: [...CONTENT_OPTS],
  },
  report: {
    summary: 'send a curated result/digest the human will want to read now (#246 type report → Relevante).',
    usage: 'pidge report --title TEXT [--body-markdown MD] [--image PATH] [--url URL]',
    body: 'Fire-and-forget, like fyi, but flagged as worth reading now (the feed gives it a highlighted hairline).',
    opts: [...CONTENT_OPTS],
  },
  ask: {
    summary: 'ask the human a yes/no/choice and block until they answer (#246 type ask → Relevante + ação badge).',
    usage: 'pidge ask --title TEXT --actions yes,no,reply [--reply-to URL] [options]',
    body: 'Sends, then holds a WebSocket (or polls) until a TERMINAL answer. REQUIRES a way to answer — --actions (catalog or JSON), --custom-action, or a --template that supplies them. A snooze/reschedule re-fires (ask keeps waiting, prints snooze_until). profile "tracking" is refused (it never produces an answer).',
    opts: [...CONTENT_OPTS, 'timeout', 'interval', 'realtime', 'no-realtime'],
  },
  event: {
    summary: 'surface a scheduled thing with a known time — countdown Live Activity (#246 type event → Evento).',
    usage: 'pidge event --title TEXT --event-at ISO8601 [--lead-minutes N] [--body-markdown MD]',
    body: 'REQUIRES --event-at (ISO8601, e.g. 2026-06-26T14:00-03:00 — no offset ⇒ the user\'s timezone). --lead-minutes (5–240) starts the countdown N min before.',
    opts: [...CONTENT_OPTS],
  },
  alert: {
    summary: 'flag an anomaly/error needing attention; --escalate forces an AlarmKit alarm (#246 type alert → Urgente).',
    usage: 'pidge alert --title TEXT [--body TEXT | --body-markdown MD] [--escalate]',
    body: 'Fire-and-forget. The channel\'s Urgente profile decides the modality; --escalate asks for an AlarmKit alarm that breaks through silent/Focus (the human\'s profile still has the final say).',
    opts: [...CONTENT_OPTS, 'escalate'],
  },
  live: {
    summary: 'track an in-flight task (deploy/build/trip) with incremental updates (#246 type live → Live Activity).',
    usage: 'pidge live --title TEXT [--body TEXT] [--lead-minutes N]',
    body: 'Fire-and-forget. Records the live type; the LA-as-primitive is being built — today the send is delivered as a normal notification.',
    opts: [...CONTENT_OPTS],
  },
  notify: {
    summary: 'DEPRECATED (0.13.x) — send WITHOUT a type; the server falls back to fyi. Use a typed send instead.',
    usage: 'pidge notify [options]',
    body: 'Kept for one minor for compat retro — it warns and still sends (template_kind defaults to fyi server-side; 0.14 will 422). Prefer `pidge fyi/report/ask/event/alert/live`.',
    opts: [...CONTENT_OPTS],
  },
  wait: {
    summary: 'block on an already-sent notification until it is answered (prints chosen_action JSON).',
    usage: 'pidge wait <correlation_id> [options]',
    opts: ['timeout', 'interval', 'realtime', 'no-realtime'],
  },
  cancel: {
    summary: 'cancel a still-scheduled notification before it fires (#56; idempotent; 409 once it reached the phone).',
    usage: 'pidge cancel <correlation_id>',
    opts: [],
  },
  inbox: {
    summary: 'what you sent: the list (default), the pending slice, or counts + answer latency (#83).',
    usage: 'pidge inbox [--pending | --summary] [--all] [--limit N]',
    opts: ['pending', 'summary', 'all-inbox', 'limit'],
  },
  listen: {
    summary: 'block until the human MESSAGES you from the app, print, ACK after the work, exit (#48).',
    usage: 'pidge listen [--timeout N] [--all] [--ack-on-read] [--follow]',
    body: 'One-shot by design (loop it, don\'t daemonize). #170: a read message is DELIVERED (gray ✓✓), NOT done — ack it AFTER the work with `pidge ack --up-to <id>` (a ~10-min lease re-serves un-acked messages, so a crash never loses one).',
    opts: ['timeout', 'all-listen', 'ack-on-read', 'follow', 'interval', 'realtime', 'no-realtime'],
  },
  ack: {
    summary: 'mark messages PROCESSED (green ✓✓) after you handled them, or --renew the lease on a long task (#170).',
    usage: 'pidge ack --up-to <id> | --ids a,b [--renew]',
    opts: ['up-to', 'ids', 'renew'],
  },
  contract: {
    summary: 'DECLARE how you operate (#182) — ADVISORY, never policy (the human SEES if you honor it).',
    usage: 'pidge contract set <key>=<value> | pidge contract show',
    body: 'Keys: keep_connection_alive, mirror_in_origin_session, listen_mode=turn_based|persistent|external_daemon, quiet_when_idle. An unknown key / bad value is rejected locally (exit 1).',
    opts: [],
  },
  selftest: {
    summary: 'prove your listener works by ROUND-TRIP (#205): fire a nonce, run the listener, confirm it acks in time.',
    usage: 'pidge selftest [--window N]',
    body: 'PASS exit 0 / FAIL exit 2 (with the likely cause). Run it as the last onboarding step + whenever sends seem to go unheard.',
    opts: ['window'],
  },
  skill: {
    summary: 'write .claude/skills/pidge/SKILL.md generated from the live manifest (persistent Pidge knowledge for Claude Code).',
    usage: 'pidge skill install',
    opts: [],
  },
};

// Render the focused help for one command, or the global USAGE when the topic is
// unknown / absent (so `pidge --help` and `pidge help` keep the full overview).
function helpFor(topic) {
  const h = HELP[topic];
  if (!h) return USAGE;
  const lines = [`pidge ${topic} — ${h.summary}`, '', 'USAGE', `  ${h.usage}`];
  if (h.body) { lines.push('', h.body); }
  if (h.opts && h.opts.length) {
    lines.push('', 'OPTIONS');
    for (const key of h.opts) lines.push(`  ${OPTION_DOCS[key] || key}`);
  }
  lines.push('', 'Run `pidge --help` for all commands; GET $PIDGE_URL/api/v1/manifest is the full contract (Bearer auth).');
  return lines.join('\n');
}

let parsed;
try {
  parsed = parseArgs({ options: OPTIONS, allowPositionals: true });
} catch (e) {
  die(`pidge: ${e.message}\n\n${USAGE}`, 1);
}
const v = parsed.values;
const command = parsed.positionals[0];
// #241: silence the manifest-version nag entirely (per run via --quiet-nag, or
// per environment via PIDGE_QUIET_NAG=1) — for scripts and CI where the nudge is noise.
const QUIET_NAG = !!v['quiet-nag'] || process.env.PIDGE_QUIET_NAG === '1';

// Help on stdout, exit 0. #240: `pidge <cmd> --help` / `pidge help <cmd>` show the
// FOCUSED help for that command (its synopsis + own flags); `pidge --help` / `help`
// with no command show the global USAGE. No command at all → USAGE on stderr, exit 1.
if (v.help || command === 'help') {
  const topic = command === 'help' ? parsed.positionals[1] : command;
  console.log(helpFor(topic));
  process.exit(0);
}
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
// than what this CLI shipped knowing, nudge on stderr — the agent re-reads the
// manifest (whats_new) and learns the new capabilities without polling.
const KNOWN_MANIFEST_VERSION = 31;
const NAG_TTL_MS = 24 * 60 * 60 * 1000; // #241: at most one nag per 24 h
let newsWarned = false;

// #241: a tiny per-install state cache (~/.config/pidge/state.json, per-agent
// when PIDGE_AGENT is set — same dir as the env file). Best-effort: a read-only
// fs just means the throttle falls back to once-per-process. Date is fine here
// (this is the CLI process, not a workflow script).
function stateFilePath() { return path.join(pidgeConfigDir(), 'state.json'); }
function readState() {
  try { return JSON.parse(fs.readFileSync(stateFilePath(), 'utf8')) || {}; } catch { return {}; }
}
function writeState(patch) {
  try {
    const next = { ...readState(), ...patch };
    fs.mkdirSync(pidgeConfigDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stateFilePath(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  } catch { /* best-effort — the nag just won't persist its throttle */ }
}

function checkManifestNews(res) {
  if (QUIET_NAG || newsWarned) return;
  const ver = parseInt(res.headers.get('x-pidge-manifest-version') || '0', 10);
  // (c) only when the server is ahead of what THIS CLI knows.
  if (!(ver > KNOWN_MANIFEST_VERSION)) return;
  // #241 throttle: nag at most once per 24 h, and after that window only when the
  // server version actually CHANGED — so 5 calls in a row (or a steady server)
  // don't re-spam. A recent OR unchanged record suppresses; the record's seenAt is
  // stamped only on a real nag (suppressed runs don't roll the 24 h clock forward).
  const last = readState().manifestVersion;
  if (last && last.seenAt) {
    const recent = (Date.now() - Date.parse(last.seenAt)) < NAG_TTL_MS; // (a)
    const unchanged = last.value === ver;                               // (b)
    if (recent || unchanged) { newsWarned = true; return; }
  }
  newsWarned = true;
  writeState({ manifestVersion: { value: ver, seenAt: new Date().toISOString() } });
  // #119: a pinned npx ref never updates itself — give the CONCRETE command.
  // #243: show the AUTHENTICATED curl so re-reading the manifest doesn't 401.
  console.error(`pidge: the server has NEW capabilities (manifest v${ver}; this CLI knows v${KNOWN_MANIFEST_VERSION}) — re-read the contract:  curl -H "Authorization: Bearer $PIDGE_TOKEN" $PIDGE_URL/api/v1/manifest  (see whats_new), then UPDATE the CLI: npm i -g pidge-cli@latest  (npx users: run npx pidge-cli@latest, a pinned ref never self-updates). Silence this with --quiet-nag or PIDGE_QUIET_NAG=1.`);
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
// When the blocking session began — so a timeout reports the REAL elapsed
// wall-clock, never the configured deadline. The dogfooding bug (2026-06-14): a
// WS close 1006 made the CLI exit "timed out after 28800s" when only seconds had
// passed — the number lied. exitTimeout now reports elapsed since this baseline.
// MONOTONIC on purpose (§2.5): performance.now() can't be skewed by a wall-clock
// change (NTP step / DST) mid-session — a Date.now() delta could, re-opening the
// "wrong number" failure mode the fix exists to kill.
const SESSION_START_MONO = performance.now();
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
    // REAL elapsed wall-clock — never the configured deadline (the 2026-06-14
    // "timed out after 28800s" lie). If only seconds passed, the number says so.
    const elapsed = Math.round((performance.now() - SESSION_START_MONO) / 1000);
    if (this.okEver) { console.error(`pidge: ${message} after ${elapsed}s (= 'no answer yet', not a failure)`); process.exit(3); }
    console.error(`pidge: ${message} after ${elapsed}s — and NOT ONE healthy round-trip all session: the CHANNEL looks broken (server/network), not the human ignoring you. Surface this to your human.`);
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
function cableSubscribe({ channel, onUp, onFrame, onDown, base = BASE, token = TOKEN }) {
  let ws;
  try {
    ws = new WebSocket(base.replace(/^http/, 'ws') + '/cable', ['actioncable-v1-json', token]);
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
    // env override = a test/ops hook (keeps the forced-1006 degrade test fast)
    const base = parseInt(process.env.PIDGE_WS_BACKOFF_MS || '2000', 10) || 2000;
    const backoff = Math.min(base * wsFails, base * 5);
    console.error(`pidge: realtime socket ${outcome.replace('down: ', '')} — reconnecting in ${Math.round(backoff / 1000)}s (attempt ${wsFails}/${MAX_WS_FAILS})`);
    await sleep(backoff);
  }
  return 'deadline';
}

// #171: doctor's realtime probe — the failure class an HTTP-only doctor can't
// see (#119: an edge killing held responses, a proxy refusing the upgrade). A
// green HTTP doctor can coexist with a `listen` that's deaf over the socket.
// Open ONE ConversationChannel subscription on /cable (reusing cableSubscribe —
// the same client `listen` holds), wait for confirm_subscription, close — all
// within ≤5 s. Degrade is the CONTRACT, not a failure: an unavailable WS just
// means `listen` polls (works, less instant), so this NEVER changes the exit
// code — it only lets the agent KNOW before the first deaf listen. Resolves
// {ok, ms} | {ok:false, reason} | {skipped:true} (Node <22 has no native
// WebSocket — same gate as wantRealtime, :373).
function probeRealtime(base, token) {
  if (typeof WebSocket !== 'function') return Promise.resolve({ skipped: true });
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let sub = null;
    const done = (result) => {
      if (settled) return; settled = true;
      clearTimeout(guard);
      if (sub) sub.close();
      resolve(result);
    };
    const guard = setTimeout(() => done({ ok: false, reason: 'no confirm_subscription within 5s' }), 5000);
    sub = cableSubscribe({
      channel: 'ConversationChannel',
      base,
      token,
      onUp: () => done({ ok: true, ms: Date.now() - started }),
      onFrame: () => { /* a stray frame during the probe is irrelevant */ },
      onDown: (why) => done({ ok: false, reason: why }),
    });
    if (!sub) done({ ok: false, reason: 'WebSocket constructor failed' });
  });
}

// #242: a custom action id is lowercase letters, digits and underscore (≤40) —
// the same rule the server enforces, validated LOCALLY so a typo fails fast.
const CUSTOM_ACTION_ID = /^[a-z0-9_]{1,40}$/;

// --custom-action "id:label[:destructive][:confirm][:biometric][:terminal]"
function customActionFromSpec(spec) {
  const [id, label, ...flags] = spec.split(':');
  // #157 P2: fail fast locally — the rule is stable and the server 422 costs a
  // round-trip an agent then has to interpret.
  if (!CUSTOM_ACTION_ID.test(id || '')) {
    die(`pidge: --custom-action id ${JSON.stringify(id)} is invalid — lowercase letters, digits and underscore only (^[a-z0-9_]{1,40}$)`, 1);
  }
  const ca = { id, label };
  if (flags.includes('destructive')) ca.style = 'destructive';
  if (flags.includes('confirm')) ca.confirm = true;
  if (flags.includes('biometric')) ca.biometric = true;
  if (flags.includes('terminal')) ca.terminal = true;
  return ca;
}

// #242: one item of a JSON --actions array → a custom_actions spec. Validates
// {id,label} and passes the optional gating fields the server understands.
function customActionFromJson(item, i) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    die(`pidge: --actions[${i}] must be an object with "id" and "label" (e.g. {"id":"approve","label":"Aprovar agora"})`, 1);
  }
  if (typeof item.id !== 'string' || !CUSTOM_ACTION_ID.test(item.id)) {
    die(`pidge: --actions[${i}].id ${JSON.stringify(item.id)} is invalid — lowercase letters, digits and underscore only (^[a-z0-9_]{1,40}$)`, 1);
  }
  if (typeof item.label !== 'string' || !item.label.trim()) {
    die(`pidge: --actions[${i}].label is required — a non-empty string`, 1);
  }
  const ca = { id: item.id, label: item.label };
  if (item.sf_symbol !== undefined) ca.sf_symbol = item.sf_symbol;
  if (item.style !== undefined) ca.style = item.style;
  if (item.destructive) ca.style = 'destructive';
  if (item.confirm !== undefined) ca.confirm = !!item.confirm;
  if (item.biometric !== undefined) ca.biometric = !!item.biometric;
  if (item.terminal !== undefined) ca.terminal = !!item.terminal;
  return ca;
}

// Map CLI flags → the /notify JSON body, including only what was provided. `extra`
// carries subcommand-supplied raw fields (#246: the typed sends' template_kind and
// alert's escalate) — merged below, before the --param escape hatch.
function buildBody(extra = {}) {
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

  // --actions: the short comma form (built-in catalog ids → body.actions) OR a
  // JSON array of custom {id,label,…} specs (#242 → body.custom_actions). A
  // leading '[' selects JSON; bad JSON is a friendly LOCAL error (exit 1), never
  // a silent fall-through that drops the labels and sends a plain notification.
  // --custom-action specs APPEND to whatever the JSON form produced, so both can coexist.
  const customActions = [];
  if (v.actions !== undefined) {
    const trimmed = v.actions.trim();
    if (trimmed.startsWith('[')) {
      let arr;
      try { arr = JSON.parse(trimmed); }
      catch (e) { die(`pidge: --actions looks like JSON but didn't parse (${e.message}). Use a JSON array of {"id","label"} objects, or the short form yes,no,reply`, 1); }
      if (!Array.isArray(arr)) die('pidge: --actions JSON must be an ARRAY of {"id","label"} objects', 1);
      arr.forEach((item, i) => customActions.push(customActionFromJson(item, i)));
    } else {
      body.actions = trimmed.split(',').filter(Boolean);
    }
  }
  for (const spec of v['custom-action'] || []) customActions.push(customActionFromSpec(spec));
  if (customActions.length) body.custom_actions = customActions;

  // #246: subcommand-supplied raw fields (template_kind, alert's escalate). Applied
  // before the --param loop so a raw --param can still override in a pinch.
  Object.assign(body, extra);

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
async function doNotify(extra = {}) {
  const payload = buildBody(extra);
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

// #246: the typed send subcommands (fyi/report/event/alert/live) share notify's
// fire-and-forget shape — stamp template_kind, POST, print the raw 201, exit
// (0 ok / 2 failed). `ask` is the one type that send+waits (it needs a decision)
// and so keeps its own case. `extra` carries alert's escalate:true.
async function doTypedNotify(kind, extra = {}) {
  const { ok, info, raw } = await doNotify({ template_kind: kind, ...extra });
  console.log(raw);
  if (ok && info.correlation_id)
    console.error(`pidge: correlation_id=${info.correlation_id} (use: pidge wait ${info.correlation_id})`);
  process.exit(ok ? 0 : 2);
}

// #246: `pidge notify` / `pidge send` (no type) are deprecated for ONE minor
// (0.13.x) — they still send, and the server falls back to template_kind "fyi"
// (soft-rollout). 0.14 will 422 a typeless send. The warning is local (stderr).
function warnDeprecatedSend(name) {
  console.error(`pidge: \`pidge ${name}\` is deprecated — use a TYPE instead: fyi · report · ask · event · alert · live (see \`pidge help\`). Server-side fallback to \`fyi\` continues in 0.13.x; will be removed in 0.14.`);
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
      health.exitTimeout(`no answer on ${cid}`);
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
  // Only exit-as-timeout if the REAL deadline genuinely passed. An EARLY
  // 'deadline' (a spurious guard, a WS oddity) must degrade to polling for the
  // remaining budget, NOT exit lying that the full timeout elapsed (#119).
  if (outcome === 'deadline' && Date.now() >= deadline - 1500) {
    health.exitTimeout(`no answer on ${cid}`);
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

const CONFIG_DIR = pidgeConfigDir();
const CONFIG_FILE = path.join(CONFIG_DIR, 'env');
// True when we're reading the LEGACY shared file (no PIDGE_AGENT, no env var) —
// the multi-agent footgun. doctor warns on it.
const ON_SHARED_FILE = !AGENT_ID && !process.env.PIDGE_TOKEN && !process.env.HERALD_TOKEN && !!FILE_ENV.PIDGE_TOKEN;

// Where the token came from — doctor narrates it, setup respects precedence.
function tokenSource() {
  if (process.env.PIDGE_TOKEN || process.env.HERALD_TOKEN) return 'env var (per-agent)';
  if (FILE_ENV.PIDGE_TOKEN) return CONFIG_FILE + (AGENT_ID ? ` (PIDGE_AGENT=${AGENT_ID})` : ' (shared)');
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

// #181 identity ownership: a STABLE, privacy-safe per-install fingerprint (a
// HASH, never raw hostname/PII) so the server can tell THIS install apart from a
// different agent that grabbed the same key. The label is the human-readable
// self-name (PIDGE_LABEL, else PIDGE_AGENT, else the hostname).
function agentFingerprint() {
  const material = [ os.hostname(), os.userInfo().username || '', AGENT_ID, CONFIG_FILE ].join('|');
  return 'fp_' + crypto.createHash('sha256').update(material).digest('hex').slice(0, 24);
}
function agentLabel() {
  return (process.env.PIDGE_LABEL || AGENT_ID || os.hostname() || 'pidge-cli').slice(0, 80);
}

// #170 first-run notice: show the ack-after-work BREAKING-flip contract ONCE PER
// INSTALL (a stamp under the config dir), not every invocation — a turn-based
// agent runs a FRESH process per turn, so an in-process flag would shout every
// time. Best-effort: if the stamp can't be persisted (env-var-only install /
// read-only fs) the caller's per-process guard still shows it once per run.
const ACK_NOTICE_STAMP = path.join(CONFIG_DIR, '.ack_notice_seen');
function ackNoticeAlreadySeen() {
  try { return fs.existsSync(ACK_NOTICE_STAMP); } catch { return false; }
}
function markAckNoticeSeen() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(ACK_NOTICE_STAMP, `${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch { /* best-effort — per-process guard covers it */ }
}

// Shared by `doctor` AND `whoami` (#182/gotcha #9): narrate HONEST device reach —
// `deliverable` (push-enabled AND on the live APNs environment) can be lower than
// the headline pushable count. Returns true when reach is BROKEN: devices exist
// but NONE are deliverable (a send reaches nobody). doctor exits 2 on that.
function reportDeviceReach(data) {
  const reach = data.device_reach;
  if (!reach) return false;
  console.error(`pidge: reach — ${reach.deliverable}/${reach.total} device(s) will actually receive a push (${reach.apns_environment} APNs)`);
  if (reach.total > reach.deliverable)
    console.error(`pidge: WARNING — ${reach.total - reach.deliverable} registered device(s) are UNREACHABLE (disabled, or on the wrong APNs environment): a send lands on ${reach.deliverable}, not ${reach.total} ("você pensa que alcança ${reach.total}, alcança ${reach.deliverable}").`);
  return reach.total > 0 && reach.deliverable === 0;
}

// Shared by `doctor` AND `whoami` (#181): SHOUT when a DIFFERENT install claimed
// this channel since we set up. Returns 'hard' (different fingerprint AND higher
// generation), 'soft' (we never claimed locally — informational), or null.
function reportClaimMismatch(data) {
  if (!data.claim) return null;
  const localGen = parseInt(FILE_ENV.PIDGE_CLAIM_GENERATION || '', 10);
  const ourFp = FILE_ENV.PIDGE_FINGERPRINT || agentFingerprint();
  const srvGen = data.claim.claim_generation;
  const srvFp = data.claim.claimed_by_fingerprint;
  if (srvFp && srvFp !== ourFp && Number.isFinite(localGen) && srvGen > localGen) {
    console.error(`pidge: ⚠️  ANOTHER AGENT CLAIMED THIS CHANNEL — server generation ${srvGen} > yours ${localGen}, now owned by "${data.claim.claimed_by_label}". Your sends may go out as a DIFFERENT identity. If that's not intended, give THIS agent its own PIDGE_AGENT=<id> (isolated config) or PIDGE_TOKEN, then re-run setup.`);
    return 'hard';
  }
  if (srvFp && srvFp !== ourFp && !Number.isFinite(localGen)) {
    console.error(`pidge: note — this channel is owned by "${data.claim.claimed_by_label}" (generation ${srvGen}); THIS install hasn't claimed it. If you are its agent, run setup to claim ownership (so a future swap becomes detectable).`);
    return 'soft';
  }
  return null;
}

// POST /claim/ownership — stamp WHICH install wears this channel's key (#181), so
// a multi-agent machine can DETECT a silent key swap. Best-effort: a server that
// predates it 404s (skip silently); a network blip never breaks setup. Returns
// the server's claim block or null.
async function claimOwnership(base, token) {
  try {
    const res = await fetchT(`${base}/api/v1/claim/ownership`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ fingerprint: agentFingerprint(), label: agentLabel() }),
    });
    if (res.status !== 200) return null;
    const data = await res.json().catch(() => ({}));
    return data.claim || null;
  } catch { return null; }
}

// #182 step 5: after onboarding, DECLARE how this agent operates so the human
// knows what to expect from this channel. ADVISORY — Pidge enforces nothing; it's
// metadata the human reads. The default is the common case (a turn-based agent:
// one-shot listen, no keep-alive); `--listen-mode always_on` flips it for a
// long-lived supervisor. Non-interactive by design (the safe default is narrated);
// best-effort — a 422/blip never breaks setup. Returns the declared mode or null.
async function declareOperatingContract(base, token, channelId) {
  if (!channelId) return null;
  const mode = v['listen-mode'];
  let contract;
  // turn_based holds no connection; persistent/external_daemon/always_on all keep one
  // alive (a supervisor or daemon holding the listen). §3c.
  if (!mode || mode === 'turn_based') contract = { listen_mode: 'turn_based', keep_connection_alive: false };
  else if (['persistent', 'external_daemon', 'always_on'].includes(mode)) contract = { listen_mode: mode, keep_connection_alive: true };
  else { console.error(`pidge: --listen-mode must be turn_based | persistent | external_daemon (got "${mode}") — skipping the contract declaration`); return null; }
  try {
    const res = await fetchT(`${base}/api/v1/channels/${channelId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ operating_contract: contract }),
    });
    if (res.status >= 200 && res.status < 300) {
      const hint = mode ? '' : ' (default — pass --listen-mode always_on for a long-lived supervisor)';
      console.error(`pidge: declared listen_mode=${contract.listen_mode}${hint} — ADVISORY, how you operate (the human sees it; Pidge enforces nothing). Change anytime: pidge contract set listen_mode=...`);
      return contract.listen_mode;
    }
    console.error(`pidge: note — couldn't declare the operating_contract (${res.status}); set it later with \`pidge contract set listen_mode=turn_based\``);
  } catch (e) {
    console.error(`pidge: note — couldn't declare the operating_contract (network: ${e.message}); set it later with \`pidge contract set\``);
  }
  return null;
}

// #182 the CLOSED allowlist (mirrors the server's OPERATING_CONTRACT_KEYS) — so
// `contract set` and `setup` reject an unknown key / bad value type LOCALLY (exit
// 1) before the round-trip, instead of leaning on the server's 422.
const OPERATING_CONTRACT_SPEC = {
  keep_connection_alive: 'boolean',
  mirror_in_origin_session: 'boolean',
  // §3c: match your RUNTIME. turn_based (no event loop — block-and-exit) · persistent
  // (a supervisor holding the socket, --follow) · external_daemon (a daemon outside the
  // session). always_on stays as a tolerated deprecated alias of persistent.
  listen_mode: ['turn_based', 'persistent', 'external_daemon', 'always_on'],
  quiet_when_idle: 'boolean',
};
// Coerce + validate one operating_contract value against the allowlist. Returns
// the typed value, or throws an Error whose message the caller die()s with (exit 1).
function coerceContractValue(key, raw) {
  const spec = OPERATING_CONTRACT_SPEC[key];
  if (!spec) throw new Error(`unknown operating_contract key "${key}" (allowed: ${Object.keys(OPERATING_CONTRACT_SPEC).join(', ')})`);
  if (spec === 'boolean') {
    if (raw === true || raw === 'true') return true;
    if (raw === false || raw === 'false') return false;
    throw new Error(`operating_contract.${key} must be true or false`);
  }
  const value = String(raw);
  if (!spec.includes(value)) throw new Error(`operating_contract.${key} must be one of: ${spec.join(', ')}`);
  return value;
}

// #182 operating_contract: DECLARE how you operate. ADVISORY, never policy —
// nothing derives urgency/ceiling from it and Pidge enforces nothing; you declare,
// the human registers their own expectation and SEES if you honor it.
//   pidge contract show           → print the channel's operating_contract
//   pidge contract set key=value  → PATCH it (key ∈ the closed allowlist above)
async function runContract() {
  const sub = parsed.positionals[1];
  if (sub !== 'show' && sub !== 'set' && sub !== undefined)
    die('pidge: usage: pidge contract set <key>=<value> | pidge contract show', 1);

  // For `set`: parse + validate the key/value LOCALLY (exit 1) BEFORE any network
  // — an unknown key / bad type never reaches the server (the allowlist is closed
  // and known client-side; the server would 422, but a local usage error is
  // faster and clearer, and avoids a needless round-trip).
  let key, value;
  if (sub === 'set') {
    const assignment = parsed.positionals[2];
    if (!assignment || !assignment.includes('=')) die('pidge: usage: pidge contract set <key>=<value>  (e.g. listen_mode=turn_based)', 1);
    const eq = assignment.indexOf('=');
    key = assignment.slice(0, eq);
    const raw = assignment.slice(eq + 1);
    try { value = coerceContractValue(key, raw); } catch (e) { die(`pidge: ${e.message}`, 1); }
  }

  let who;
  try { who = await fetchWhoami(); } catch (e) { die(`pidge: contract failed (network): ${e.message}`, 2); }
  if (who.res.status !== 200) die(`pidge: contract: whoami failed (${who.res.status})`, 2);
  const channelId = who.data.channel && who.data.channel.id;

  if (sub === 'show' || sub === undefined) {
    const oc = who.data.operating_contract || {};
    console.log(JSON.stringify(oc, null, 2));
    const keys = Object.keys(oc);
    console.error(keys.length
      ? `pidge: operating_contract — ${keys.map((k) => `${k}=${JSON.stringify(oc[k].value)}${oc[k].locked ? ' (registered by your human)' : ''}`).join(', ')}`
      : 'pidge: no operating_contract declared yet — set one with `pidge contract set listen_mode=turn_based`');
    process.exit(0);
  }

  let res, body;
  try {
    res = await fetch(`${BASE}/api/v1/channels/${channelId}`, {
      method: 'PATCH', headers, body: JSON.stringify({ operating_contract: { [key]: value } }),
    });
    body = await res.text();
  } catch (e) {
    die(`pidge: contract set failed (network): ${e.message}`, 2);
  }
  checkManifestNews(res);
  if (!(res.status >= 200 && res.status < 300)) die(`pidge: contract set failed (${res.status}): ${body}`, 2);
  // stdout = ONLY the operating_contract, never the raw channel JSON. The
  // /channels PATCH echoes the whole channel — INCLUDING "key":"hld_…" — and
  // dumping it would land this agent's OWN key in its stdout/transcript/logs
  // (the one thing the whole claim flow exists to avoid). Print just the contract.
  let parsedBody = {};
  try { parsedBody = JSON.parse(body); } catch { /* leave {} */ }
  console.log(JSON.stringify({
    operating_contract: parsedBody.operating_contract || {},
    operating_contract_ignored: parsedBody.operating_contract_ignored
  }, null, 2));
  console.error(`pidge: declared ${key}=${JSON.stringify(value)} (ADVISORY, never policy — the human sees if you honor it; Pidge enforces nothing)`);
  process.exit(0);
}

// Orphan-zombie guard (§3c pitfall #1): when `npx pidge-cli listen` is launched as a
// background task and the harness later kills the npx wrapper, the node LEAF can
// orphan and keep consuming the channel forever without ever waking the agent. A
// long-running listen polls its parent: if it had a real parent at startup and that
// parent dies (re-parented to pid 1), it exits so it stops eating the queue. Skipped
// when started detached (ppid 1 already — e.g. an external_daemon under systemd).
function installOrphanWatchdog() {
  if (process.ppid === 1) return; // already detached — nothing to orphan from
  const t = setInterval(() => {
    if (process.ppid === 1) {
      console.error('pidge: parent process died — exiting so I stop consuming the channel (orphan-zombie guard). Relaunch from your harness.');
      process.exit(0);
    }
  }, 2000);
  if (t.unref) t.unref(); // never keep the process alive just for the watchdog
}

// selftest (#205): prove the listener works by ROUND-TRIP, not prose. Fire a nonce
// onto our own queue, run the listener (long-poll floor — the reachability path) for
// the window, ack the nonce, then read the server's verdict. PASS = it round-tripped
// in time. FAIL = the server's window verdict + a likely CAUSE the server can't see
// (the orphan/`&`/transport bugs). Only the nonce is acked (ids:[id]) and any real
// messages briefly served are re-served fast (lease=60), so it doesn't eat the queue.
async function doSelftest() {
  // Guard the parse: a non-numeric --window (e.g. "30s", a typo) must NOT become NaN
  // — that would make the deadline NaN, skip the poll loop entirely, and mis-report a
  // perfectly fine listener as "orphaned/dead" (the most misleading failure possible).
  const rawWindow = num(v.window, 30);
  const windowS = Math.max(5, Math.min(120, Number.isFinite(rawWindow) ? rawWindow : 30));
  let fired;
  try {
    const res = await fetchT(`${BASE}/api/v1/selftest`, {
      method: 'POST', headers, body: JSON.stringify({ window_seconds: windowS }),
    });
    checkManifestNews(res);
    if (res.status < 200 || res.status >= 300) die(`pidge: selftest: the server refused (${res.status}) — is your key valid? try \`pidge doctor\``, 2);
    fired = await res.json();
  } catch (e) {
    die(`pidge: selftest failed (network): ${e.message}`, 2);
  }
  const id = fired.id;
  console.error(`pidge: self-test fired (id ${id}) — listening up to ${windowS}s to prove the round-trip (a nonce on your own queue; PASS = your listener picks it up + acks it in time)`);

  const deadline = Date.now() + windowS * 1000;
  let sawNonce = false;
  while (Date.now() < deadline && !sawNonce) {
    const waitS = Math.max(0, Math.min(25, Math.ceil((deadline - Date.now()) / 1000)));
    const askedAt = Date.now();
    try {
      const qs = new URLSearchParams({ all: 'true', lease: '60' });
      if (waitS > 0) qs.set('wait', String(waitS));
      const res = await fetchT(`${BASE}/api/v1/messages?${qs}`, { headers }, (waitS + 10) * 1000);
      if (res.status === 200) {
        const msgs = (await res.json().catch(() => ({}))).messages || [];
        if (msgs.some((m) => m.id === id)) {
          sawNonce = true;
          // ack ONLY the nonce (ids, not up_to) so real pending messages aren't consumed.
          try { await fetchT(`${BASE}/api/v1/messages/ack`, { method: 'POST', headers, body: JSON.stringify({ ids: [ id ] }) }); } catch { /* server verdict is the source of truth */ }
        }
      }
    } catch { /* keep trying until the deadline */ }
    // pace: if the poll returned fast (the server didn't actually hold ?wait=), don't busy-spin.
    if (!sawNonce && Date.now() - askedAt < 1000 && Date.now() < deadline) await sleep(1000);
  }

  let verdict = {};
  try {
    const res = await fetchT(`${BASE}/api/v1/selftest/${id}`, { headers });
    if (res.status === 200) verdict = await res.json();
  } catch (e) {
    die(`pidge: selftest: couldn't read the result (${e.message})`, 2);
  }

  if (verdict.status === 'passed') {
    console.error('pidge: ✅ SELF-TEST PASSED — your listener received the nonce and acked it in time. Reachability proven.');
    console.log(JSON.stringify({ status: 'passed', id, window_seconds: windowS }));
    process.exit(0);
  }
  const cause = sawNonce
    ? 'your listener received the nonce but acked it AFTER the window — a slow/flaky transport, or the work between read and ack took too long. Widen --window, or make your real listen loop ack sooner.'
    : 'your listener never received the nonce in the window — likely an ORPHANED/detached listener (an npx leaf left running, or a loose `&`), or a dead transport. Run ONE single-process listener as a tracked background task; `pidge listen --no-realtime` is the robust floor.';
  console.error(`pidge: ❌ SELF-TEST FAILED — ${cause}`);
  console.log(JSON.stringify({ status: verdict.status || 'failed', id, saw_nonce: sawNonce }));
  process.exit(2);
}

// doctor: validate the setup WITHOUT exposing secrets. Narration on stderr,
// a compact machine-readable line on stdout. Exit 0 healthy / 2 broken.
async function runDoctor(base = BASE, token = TOKEN, sourceLabel = null) {
  // sourceLabel is passed by setup (it knows exactly where the key went —
  // a per-agent file, the shared file, or NOWHERE for --print); the bare
  // `doctor` command computes it from the env/file precedence.
  const source = sourceLabel || (token === TOKEN ? tokenSource() : CONFIG_FILE);
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
  // #182 device-reach honesty (gotcha #9) + #181 ownership — shared with whoami.
  const unreachable = reportDeviceReach(data);
  reportClaimMismatch(data);
  if (ON_SHARED_FILE)
    console.error(`pidge doctor: WARNING — reading the SHARED file ${CONFIG_FILE}. If another agent runs on this machine, it reads the SAME key and you'll send as each other (the 2026-06-13 incident). Isolate: set PIDGE_AGENT=<id> at this agent's launch (config → ~/.config/pidge/agents/<id>/env) or give it its own PIDGE_TOKEN.`);
  // #182: devices exist but 0 are deliverable ⇒ a send reaches NOBODY — BROKEN
  // (exit 2). (0 devices total stays a warning above: a fresh setup before the
  // app is installed isn't "broken".) The claim mismatch SHOUTS but stays exit 0
  // — the warning is the contract (§4.6: the severity split is a judgment call).
  if (unreachable) {
    console.error('pidge doctor: BROKEN (exit 2) — devices exist but 0 are reachable (all disabled or on the wrong APNs environment): a send reaches nobody.');
    process.exit(2);
  }
  // #171: probe the realtime path (the #119 failure class an HTTP-only doctor
  // misses). Exit stays 0 either way — an unavailable WS degrades to polling.
  const rt = await probeRealtime(base, token);
  let realtime;
  if (rt.skipped) {
    realtime = 'skipped';
    console.error('pidge doctor: realtime: skipped — this Node lacks a native WebSocket (need Node ≥22); `listen` will poll. Upgrade Node for instant delivery.');
  } else if (rt.ok) {
    realtime = 'ok';
    console.error(`pidge doctor: realtime: ok (ws connect + subscribe em ${rt.ms}ms)`);
  } else {
    realtime = 'unavailable';
    console.error(`pidge doctor: realtime: INDISPONÍVEL — ${rt.reason}. O \`listen\` degrada pra polling (funciona, menos instantâneo); use --no-realtime pra fixar o piso.`);
  }
  // #229: lead with `pidge hello` — the first-contact WOW (send + wait in one),
  // the same debut the /agent-setup guide leads with. It's a thin wrapper over
  // `ask --template onboarding` (the underlying mechanism, if you need it raw).
  console.error('pidge doctor: all good — try: pidge hello   (first-contact WOW — send + wait in one; equivalent: pidge ask --template onboarding)');
  console.log(JSON.stringify({ ok: true, base_url: base, channel: data.channel, devices, manifest_version: data.manifest_version, realtime }));
  process.exit(0);
}

// setup --claim: exchange the single-use code for the key, store it ourselves
// (the secret never appears on screen or in the chat the prompt was pasted in),
// then prove the loop with doctor.
async function runSetup() {
  const code = v.claim;
  if (!code) die('pidge: usage: pidge setup --claim <code> [--url <base>]   (the human copies the code from the Pidge app)', 1);
  const base = (v.url || process.env.PIDGE_URL || FILE_ENV.PIDGE_URL || 'https://pidge.sh').replace(/\/+$/, '');

  // THE SHARED-CONFIG GUARD (real incident, 2026-06-13). Only the FILE path can
  // collide; --print writes nothing, so skip it there. CONFIG_FILE is now
  // per-agent when PIDGE_AGENT is set (no collision by construction), but on the
  // legacy shared file two agents still share it — refuse to clobber a file that
  // still authenticates as some channel unless --force. Checked BEFORE the
  // exchange so the single-use code survives the refusal.
  if (!v.print && !v.force && FILE_ENV.PIDGE_TOKEN) {
    let owner = null;
    try {
      const { res: wres, data: wdata } = await fetchWhoami(base, FILE_ENV.PIDGE_TOKEN);
      if (wres.status === 200 && wdata.channel) owner = wdata.channel.name;
      else if (wres.status !== 401) owner = 'um canal (servidor não confirmou)';
      // 401 ⇒ the stored key is dead — overwriting a corpse needs no --force.
    } catch {
      owner = 'um canal (servidor inalcançável para confirmar)';
    }
    if (owner) {
      die(`pidge: ${CONFIG_FILE} já guarda a chave de "${owner}". Sobrescrever faria qualquer agente que lê esse arquivo enviar como o canal novo (incidente real: um cron foi sequestrado assim). O jeito certo de rodar VÁRIOS agentes na mesma máquina: dê a cada um um PIDGE_AGENT=<id> no launch (cada um ganha ~/.config/pidge/agents/<id>/env isolado), ou um PIDGE_TOKEN próprio, ou rode com --print e cole o export no launcher DESTE agente. Substituir mesmo assim? --force (o claim code continua válido — nada foi consumido).`, 2);
    }
  }

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
  const channelName = data.channel && data.channel.name;
  const channelId = data.channel && data.channel.id;

  // #182 step 5: DECLARE how this agent operates (operating_contract) right after
  // the claim succeeds — ADVISORY metadata, the same for --print and the file
  // path. Done here (before the branch) so both onboarding modes declare it.
  await declareOperatingContract(finalBase, data.key, channelId);

  // --print: the pure per-agent path — emit the export lines (the HUMAN runs
  // this in THEIR terminal and pastes them into the agent's launcher). Stores
  // nothing; the key shows on screen, so DON'T let an agent run --print (the
  // key would land in its context — that's what the file path is for). stdout
  // is eval-able; the guidance goes to stderr.
  if (v.print) {
    console.log(`export PIDGE_URL=${finalBase}`);
    console.log(`export PIDGE_TOKEN=${data.key}`);
    console.error(`pidge: canal "${channelName}" — modo POR-AGENTE (nada gravado em disco). Cole as duas linhas no ambiente de lançamento DESTE agente (systemd/launcher/cron/profile). Cada agente tem a SUA chave; perdeu, é só pegar outro código no app e re-rodar (a chave do canal é a MESMA). NÃO rode --print de dentro de um agente — a chave apareceria no contexto dele.`);
    await runDoctor(finalBase, data.key, 'fresh claim (per-agent env — not stored on disk)');
    return;
  }

  // File path (default): the CLI writes the key — the agent never sees it
  // (#57). Per-agent when PIDGE_AGENT is set; otherwise the legacy shared file.
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, `PIDGE_URL=${finalBase}\nPIDGE_TOKEN=${data.key}\n`, { mode: 0o600 });
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* mode set on create */ }
  console.error(`pidge: canal "${channelName}" configurado — chave em ${CONFIG_FILE} (chmod 600, nunca exibida)`);
  // #181: claim ownership of the channel for THIS install and record the
  // generation locally, so a later `pidge doctor` can DETECT a silent key swap
  // by a different agent (the v25 incident, now caught in code). Best-effort.
  const claim = await claimOwnership(finalBase, data.key);
  if (claim) {
    fs.appendFileSync(CONFIG_FILE, `PIDGE_CLAIM_GENERATION=${claim.claim_generation}\nPIDGE_FINGERPRINT=${agentFingerprint()}\n`, { mode: 0o600 });
    console.error(`pidge: ownership claimed as "${agentLabel()}" (generation ${claim.claim_generation}) — doctor WARNS if another agent takes this channel.`);
  }
  if (!AGENT_ID)
    console.error('pidge: este é o arquivo COMPARTILHADO (single-agent). Vai rodar 2+ agentes nesta máquina? Dê a cada um PIDGE_AGENT=<id> no launch (arquivo isolado por agente) — senão eles enviam como o mesmo canal.');
  await runDoctor(finalBase, data.key, CONFIG_FILE);
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

## Choose the right type (REQUIRED in 0.14+)

Every send needs a type. Pick by intent:

| You want to... | Use | Example |
|---|---|---|
| Log something the human can read later, no action | \`pidge fyi\` | "Build completed in 2m12s" |
| Deliver a curated result/digest worth reading now | \`pidge report\` | "Daily standup summary" |
| Ask the human a yes/no/choice — block until they answer | \`pidge ask\` | "Approve deploy v3.2?" with \`--actions yes,no\` |
| Surface a scheduled thing (with time) | \`pidge event\` | "Sprint review 14h" with \`--event-at ...\` |
| Anomaly/error needing attention; add \`--escalate\` for AlarmKit | \`pidge alert\` | "API 503 errors spiked" |
| Track an in-flight task with incremental updates | \`pidge live\` | "Deploy v3.2 — building..." |

If unsure: \`fyi\` for passive info, \`ask\` if you need a decision. NEVER use \`pidge send\`
without a type — in 0.14 it'll 422. (In 0.13.x it warns locally + server falls back to fyi.)

Available CLI commands (typed sends): \`pidge fyi\` · \`pidge report\` · \`pidge ask\` · \`pidge event\` · \`pidge alert\` · \`pidge live\` (and \`pidge notify\`, deprecated). Run \`pidge <type> --help\` for each one's own flags.

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

## Stay "always-on" while you're turn-based (#244)

A turn-based agent (Claude Code, ChatGPT, anything that only runs when invoked) can still be COMMANDABLE by your human. Two ways, neither needs a daemon:

### Path 1 — an interactive listening window (active session)
\`\`\`bash
pidge listen --follow --timeout 300   # hold for 5 min (--timeout is SECONDS), printing messages as they arrive
\`\`\`
Good while you're actively working. You stay online until the window closes. \`--follow\` is supervisor-style — it traps the turn — so only use it when you intend to sit and wait.

### Path 2 — a supervisor that polls, no daemon (24/7)
A \`cron\` job or \`systemd\` timer invokes you every N minutes; each tick runs ONE one-shot listen and exits:
\`\`\`bash
pidge listen --timeout 50   # block up to 50s for a message, print it, exit 0 (exit 3 = nothing this tick)
\`\`\`
Each poll is one of your turns: pick up the message, do the work, \`pidge ack --up-to <id>\`, then sleep until the next tick. Real always-on without being a daemon. With Claude Code, the built-in \`/loop\` (auto-wake every N min) drives the same loop.

> \`--timeout\` is always SECONDS (not "5m"). One-shot \`pidge listen\` is the polling primitive — loop it from your supervisor; do NOT background it with \`&\` (an orphaned listener eats the queue).

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
      // §5.2/§4.6: whoami MUST also report HONEST reach + SHOUT on a claim swap,
      // not just doctor — the same shared helpers (deliverable, ANOTHER AGENT…).
      reportDeviceReach(data);
      reportClaimMismatch(data);
      process.exit(0);
      break;
    }
    case 'skill': {
      if (parsed.positionals[1] !== 'install') die('pidge: usage: pidge skill install', 1);
      await runSkillInstall();
      break;
    }
    // #246: typed sends — fyi/report/event/alert/live stamp template_kind and
    // fire-and-forget. ask is separate (it send+waits). notify/send are the
    // deprecated typeless path (server falls back to fyi during the soft-rollout).
    case 'fyi':
    case 'report':
      await doTypedNotify(command);
      break;
    case 'event': {
      // event needs a TIME — validate locally (ISO8601) so the agent fails fast
      // instead of taking the server's event_at_required 422 round-trip.
      if (v['event-at'] === undefined)
        die('pidge: --event-at required for event. Use ISO8601: --event-at 2026-06-26T14:00-03:00', 1);
      if (Number.isNaN(Date.parse(v['event-at'])))
        die(`pidge: --event-at ${JSON.stringify(v['event-at'])} is not a valid ISO8601 datetime. Use e.g. --event-at 2026-06-26T14:00-03:00`, 1);
      await doTypedNotify('event');
      break;
    }
    case 'alert':
      // --escalate ⇒ escalate:true (ask the channel's Urgente profile for an
      // AlarmKit alarm that breaks through silent/Focus; the human's profile decides).
      await doTypedNotify('alert', v.escalate ? { escalate: true } : {});
      break;
    case 'live':
      await doTypedNotify('live');
      break;
    case 'notify':
    case 'send': {
      warnDeprecatedSend(command);
      const { ok, info, raw } = await doNotify();
      console.log(raw);
      if (ok && info.correlation_id)
        console.error(`pidge: correlation_id=${info.correlation_id} (use: pidge wait ${info.correlation_id})`);
      process.exit(ok ? 0 : 2);
      break;
    }
    case 'hello': {
      // #217 — the first-contact WOW: fire the onboarding handshake and block on
      // your human's confirmation. The SERVER narrates a 3-stage Live Activity on
      // the lock screen (Conectando → toque para confirmar → Concluído ✓) so your
      // human SEES the agent→human→agent loop close. One command: send + wait.
      // Run it as your FIRST contact on a fresh channel. A thin wrapper over `ask`:
      // it just pins template=onboarding and friendly default copy.
      if (v.profile === 'tracking')
        die('pidge: `hello --profile tracking` makes no sense — the handshake waits for a confirmation, which tracking (Live-Activity-only) never produces', 1);
      v.template = 'onboarding';
      if (v.title === undefined) v.title = 'Seu agente está pronto 🐦';
      if (v.body === undefined) v.body = 'Toque em Feito ✓ para confirmar que me recebeu — você vai ver o teste fechar na tela.';
      const cid = v['correlation-id'] || crypto.randomUUID();
      v['correlation-id'] = cid;
      console.error(`pidge: correlation_id=${cid}`);
      const { ok, info } = await doNotify();
      if (!ok) process.exit(2);
      console.error(`pidge: WOW sent (${info.registered_devices} device(s)) — watch the lock screen narrate the handshake; waiting for your human to confirm on ${cid}`);
      // No --timeout ⇒ obey the template's suggestion from the 201 echo (onboarding
      // = 3600 s); explicit --timeout always wins.
      let timeout = num(v.timeout, NaN);
      if (!Number.isFinite(timeout)) timeout = info.suggested_ask_timeout || 3600;
      await waitForAnswer(cid, { timeout, interval: num(v.interval, 30) });
      break;
    }
    case 'ask': {
      // Send, then block on the answer in one shot. stdout = ONLY chosen_action JSON.
      // tracking is Live-Activity-only: it NEVER produces a chosen_action, so an ask
      // would block the full timeout believing the human is deciding.
      if (v.profile === 'tracking')
        die('pidge: `ask --profile tracking` makes no sense — tracking never produces an answer (use the live_activities API; need a decision? send a real profile)', 1);
      if (!v.title) die('pidge: --title is required', 1);
      // #246: an ask DECLARES a decision — it must say HOW the human answers.
      // --actions (catalog or JSON), --custom-action, or a --template that supplies
      // them all satisfy it; none ⇒ a local error (the spec's "no hidden default").
      if (v.actions === undefined && !(v['custom-action'] || []).length && v.template === undefined)
        die('pidge: --actions required for ask. Use --actions yes,no,reply or a JSON array.', 1);
      // The cid is minted CLIENT-side when not given, and printed as the FIRST
      // stderr line (greppable) — a killed/crashed ask always leaves the handle
      // behind, so the agent can `pidge wait <cid>` instead of re-sending.
      const cid = v['correlation-id'] || crypto.randomUUID();
      v['correlation-id'] = cid;
      console.error(`pidge: correlation_id=${cid}`);
      const { ok, info } = await doNotify({ template_kind: 'ask' });
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
    case 'ack': {
      // #170 read-receipt split: mark messages PROCESSED (green ✓✓) AFTER you've
      // durably handled them — `listen` only DELIVERS them now. --renew
      // (state=delivered) instead RENEWS the visibility-timeout lease, a
      // heartbeat for a long task so the reservation doesn't lapse and re-serve.
      const ackBody = {};
      if (v['up-to'] !== undefined && v.ids !== undefined)
        die('pidge: pass EITHER --up-to <id> OR --ids a,b, not both', 1);
      if (v['up-to'] !== undefined) ackBody.up_to = parseInt(v['up-to'], 10);
      else if (v.ids !== undefined) ackBody.ids = v.ids.split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite);
      else die('pidge: usage: pidge ack --up-to <id> | --ids a,b [--renew]', 1);
      if (v.renew) ackBody.state = 'delivered';
      let res, raw;
      try {
        res = await fetch(`${BASE}/api/v1/messages/ack`, { method: 'POST', headers, body: JSON.stringify(ackBody) });
        raw = await res.text();
      } catch (e) {
        die(`pidge: ack failed (network): ${e.message}`, 2);
      }
      checkManifestNews(res);
      console.log(raw);
      if (!(res.status >= 200 && res.status < 300)) die(`pidge: ack failed (${res.status}): ${raw}`, 2);
      let adata = {};
      try { adata = JSON.parse(raw); } catch { /* leave {} */ }
      if (v.renew) console.error(`pidge: lease renewed on ${adata.renewed ?? 0} message(s) (still yours; ack again when done)`);
      else console.error(`pidge: processed ${adata.acked ?? 0} message(s) — green ✓✓ (the human sees "lida pelo agente")`);
      process.exit(0);
      break;
    }
    case 'contract': {
      await runContract();
      break;
    }
    case 'selftest': {
      // #205: prove reachability by round-trip. Fire a nonce, run the listener,
      // confirm it picks it up + acks in time. PASS exit 0 / FAIL exit 2.
      await doSelftest();
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
      installOrphanWatchdog(); // §3c: a killed-parent orphan exits instead of eating the queue
      const timeout = num(v.timeout, 600);
      let deadline = Date.now() + timeout * 1000;
      const queueQs = v.all ? '?all=true' : '';
      // §2.6: --follow is SUPERVISOR-ONLY — warn LOUDLY at startup. A turn-based
      // agent that uses it traps its turn (the process keeps listening); the
      // default one-shot, looped from the supervisor, is what almost everyone wants.
      if (v.follow) {
        console.error('pidge: --follow keeps this process listening until --timeout (supervisor mode).');
        console.error('pidge: a TURN-BASED agent must NOT use --follow — it traps the turn. Use the');
        console.error('pidge: default one-shot (loop the command from your supervisor) instead.');
      }
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

      // #170 read-receipt split: by DEFAULT a read message is DELIVERED (gray
      // ✓✓), NOT consumed — the agent ACKS after the work (`pidge ack`), and a
      // ~10-min server lease re-serves un-acked messages so a crash never loses
      // one. --ack-on-read restores the pre-0.9 immediate-consume.
      const ackOnRead = v['ack-on-read'];
      // Per-INSTALL notice (stamp file) + an in-process guard so a --follow run
      // doesn't repeat it across batches before the stamp write is observed.
      let ackNoticeShownThisProcess = false;
      // Print + (conditionally) ack — shared by the WS and polling paths.
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
        if (ackOnRead) {
          try {
            // fetchT, not fetch: a wedged proxy stalling this ack would otherwise
            // pin the process forever (the WS drain path awaits printAndAck's exit
            // with no deadline) — messages are already printed, so a timeout here
            // just re-serves them next listen (at-least-once).
            const ack = await fetchT(`${BASE}/api/v1/messages/ack`, {
              method: 'POST', headers, body: JSON.stringify({ up_to: upTo }),
            });
            if (ack.status >= 200 && ack.status < 300) {
              console.error(`pidge: ${msgs.length} message(s) — acked on read (--ack-on-read); answer via notify, reuse thread_id when present`);
            } else {
              console.error(`pidge: WARNING — ack failed (${ack.status}); these messages will be re-served next listen`);
            }
          } catch (e) {
            console.error(`pidge: WARNING — ack failed (network: ${e.message}); these messages will be re-served next listen`);
          }
        } else if (!ackNoticeShownThisProcess && !ackNoticeAlreadySeen()) {
          ackNoticeShownThisProcess = true;
          markAckNoticeSeen(); // once per install (stamp); a fresh per-turn process won't re-shout
          // The version-gated BREAKING flip — LOUD on stderr the first time.
          console.error(`pidge: NEW in 0.9.x — ${msgs.length} message(s) DELIVERED (gray ✓✓), NOT done. ACK AFTER you handle them: \`pidge ack --up-to ${upTo}\` (a ~10-min lease re-serves un-acked messages, so a crash between "I have it" and "I'm done" never loses one). Use --ack-on-read for the old immediate-consume.`);
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
        // Only a GENUINE deadline exits; an early/spurious 'deadline' or
        // 'ws-unavailable' degrades to polling below (never an early timeout lie).
        if (outcome === 'deadline' && Date.now() >= deadline - 1500) {
          followEnd();
          health.exitTimeout('no message from the human');
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
          health.exitTimeout('no message from the human');
        }
        const pace = health.degraded ? DEGRADED_INTERVAL_S : num(v.interval, 5);
        if (Date.now() - askedAt < 2000) {
          await sleep(Math.min(pace, Math.max(1, Math.ceil((deadline - Date.now()) / 1000))) * 1000);
        }
      }
      break;
    }
    default:
      // #246: name the bad command and point at the type catalog (a friendlier
      // landing than dumping the whole USAGE on a typo).
      die(`pidge: unknown subcommand '${command}'. Try: fyi · report · ask · event · alert · live · notify (deprecated). pidge --help`, 1);
  }
})();
