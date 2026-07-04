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
//   TWO AXES (perfis, manifest v40+): (1) the TYPE — one married list of 5 the
//   human configured how to receive: message · important · urgent · event · live;
//   (2) the RESPONSE — buttons (--actions/--custom-action) + send-and-go vs wait
//   (--wait blocks until the human answers). Response composes onto ANY type.
//
//   # just inform — fire-and-forget (prints the raw 201)
//   pidge message --title "Build green" --body "2m12s"
//
//   # a pendency the human should resolve (the DEFAULT type) + block on the answer
//   pidge important --title "Approve deploy?" --actions yes,no --wait
//
//   # a go/no-go decision with Face ID — the approval RECIPE (= important + wait + gate)
//   pidge approval --title "Deploy to production?"
//
//   # urgent: breaks through silent/Focus, escalates to an AlarmKit alarm
//   pidge urgent --title "Balance dropped below $5k" --escalate
//
//   # a thing with a known time: push at T−lead + a lock-screen countdown
//   pidge event --title "Team meeting" --event-at "2026-06-10T15:00:00"
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

// ---------------------------------------------------------------------------
// E2E crypto (E0 — #180; the contract is e2e-spec-v1.md, ratified 2026-07-02).
// AES-256-GCM · 32-byte per-channel key · ONE independent envelope per field:
//   field envelope  "v1:" + base64url( nonce(12) || ciphertext || tag(16) )
//   blob framing    [0x01][nonce 12B][ciphertext][tag 16B]  (binary, no base64)
//   AAD             "ch<channel_id>:<correlation_id>:<field_name>"    (ASCII)
//   kf              base64url(SHA-256(key)[0..3])    (4-byte key fingerprint)
// E0 ships the PURE functions + the shared fixture (test/e2e_vectors.json)
// ONLY — no command encrypts yet (server passthrough is E1; send/receive
// integration is E2/E3). The nonce parameter exists ONLY for the deterministic
// fixture; production callers omit it (crypto.randomBytes(12) per envelope).
// ---------------------------------------------------------------------------
const E2E_FIELD_PREFIX = 'v1:';
const E2E_BLOB_VERSION = 0x01;
const E2E_NONCE_BYTES = 12;
const E2E_TAG_BYTES = 16;

function e2eKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('e2e key must be a 32-byte Buffer');
  return key;
}
function e2eNonce(nonce) {
  if (nonce === undefined) return crypto.randomBytes(E2E_NONCE_BYTES);
  if (!Buffer.isBuffer(nonce) || nonce.length !== E2E_NONCE_BYTES) {
    throw new Error('e2e nonce must be a 12-byte Buffer (deterministic tests only — omit it in production)');
  }
  return nonce;
}

// The AAD binds a ciphertext to ITS channel + notification + field (anti-swap/
// anti-replay: a ciphertext moved to any other slot fails the tag). channel_id
// is the PUBLIC id (whoami/manifest) — never the secret.
function e2eAad(channelId, correlationId, fieldName) {
  if (channelId === undefined || channelId === null || channelId === '') throw new Error('e2e AAD needs a channel_id');
  if (!correlationId) throw new Error('e2e AAD needs a correlation_id');
  if (!fieldName) throw new Error('e2e AAD needs a field_name');
  return `ch${channelId}:${correlationId}:${fieldName}`;
}

function e2eSeal(key, aad, plaintext, nonce) {
  const iv = e2eNonce(nonce);
  const cipher = crypto.createCipheriv('aes-256-gcm', e2eKey(key), iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ct, tag: cipher.getAuthTag() };
}
function e2eOpen(key, aad, raw, what) {
  const iv = raw.subarray(0, E2E_NONCE_BYTES);
  const ct = raw.subarray(E2E_NONCE_BYTES, raw.length - E2E_TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', e2eKey(key), iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(raw.subarray(raw.length - E2E_TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    // GCM gives ONE failure signal for all of these — don't guess further.
    throw new Error(`e2e ${what} failed to authenticate: wrong key, wrong AAD, or corrupted data`);
  }
}

function e2eEncryptField(key, aad, plaintext, nonce) {
  const { iv, ct, tag } = e2eSeal(key, aad, Buffer.from(String(plaintext), 'utf8'), nonce);
  return E2E_FIELD_PREFIX + Buffer.concat([iv, ct, tag]).toString('base64url');
}

function e2eDecryptField(key, aad, envelope) {
  if (typeof envelope !== 'string') throw new Error('e2e envelope must be a string');
  if (!envelope.startsWith(E2E_FIELD_PREFIX)) {
    const ver = /^(v\d+):/.exec(envelope);
    throw new Error(ver ? `unknown e2e envelope version "${ver[1]}" — this CLI speaks v1`
      : 'not an e2e field envelope (missing "v1:" prefix)');
  }
  const b64 = envelope.slice(E2E_FIELD_PREFIX.length);
  // Buffer.from(_, 'base64url') silently SKIPS invalid chars — a mangled
  // envelope must fail loud here, not decode to garbage that then fails the
  // tag with a misleading "wrong key" story. Trailing '=' padding tolerated.
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(b64)) throw new Error('invalid base64url in e2e envelope');
  const raw = Buffer.from(b64, 'base64url');
  if (raw.length < E2E_NONCE_BYTES + E2E_TAG_BYTES) throw new Error('e2e envelope too short');
  return e2eOpen(key, aad, raw, 'field').toString('utf8');
}

function e2eEncryptBlob(key, aad, buffer, nonce) {
  if (!Buffer.isBuffer(buffer)) throw new Error('e2e blob plaintext must be a Buffer');
  const { iv, ct, tag } = e2eSeal(key, aad, buffer, nonce);
  return Buffer.concat([Buffer.from([E2E_BLOB_VERSION]), iv, ct, tag]);
}

function e2eDecryptBlob(key, aad, buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('e2e blob must be a Buffer');
  if (buffer.length < 1 + E2E_NONCE_BYTES + E2E_TAG_BYTES) throw new Error('e2e blob too short');
  if (buffer[0] !== E2E_BLOB_VERSION) {
    throw new Error(`unknown e2e blob version 0x${buffer[0].toString(16).padStart(2, '0')} — this CLI speaks 0x01`);
  }
  return e2eOpen(key, aad, buffer.subarray(1), 'blob');
}

// kf — 4 bytes of SHA-256(key), base64url. Rides CLEAR next to `enc:"v1"` so
// the device can say "sent with another key" PRECISELY instead of showing
// garbage (kills the token-of-one-channel + secret-of-another pitfall).
function e2eKeyFingerprint(key) {
  return crypto.createHash('sha256').update(e2eKey(key)).digest().subarray(0, 4).toString('base64url');
}

// PIDGE_SECRET reads from the SAME slot/precedence as PIDGE_TOKEN: env var wins
// over the config file (per-agent aware via PIDGE_AGENT/XDG_CONFIG_HOME) — the
// {TOKEN, SECRET} pair always travels together from one source.
function e2eLoadSecret() {
  return process.env.PIDGE_SECRET || FILE_ENV.PIDGE_SECRET || null;
}

// PIDGE_SECRET is the channel's 32-byte key, base64url. Returns the key Buffer,
// null when absent, and THROWS a named error on a malformed value — the caller
// decides warn-and-send-clear (send path) vs BROKEN (doctor on an E2E channel).
function e2eParseSecret(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(s)) throw new Error('PIDGE_SECRET is not base64url');
  const key = Buffer.from(s, 'base64url');
  if (key.length !== 32) throw new Error(`PIDGE_SECRET decodes to ${key.length} bytes — the channel key is exactly 32`);
  return key;
}

// Action ids whose LABELS must NEVER be sealed (#313): the server's 12
// built-ins + the two system ids "dismiss"/"acknowledge". Mirrors the server's
// Notification::RESERVED_ACTION_IDS and the iOS builtin set (E2EContent),
// which SKIPS label decrypt for these ids — a sealed label on one would
// render raw "v1:…" on the button. Built-in ids ride CLEAR everywhere (the
// action contract runs on ids); E3 seals only CUSTOM labels. The server 422s
// a custom action with one of these ids anyway (manifest v52) — this is the
// fail-safe for older servers.
const E2E_NEVER_SEAL_LABEL_IDS = new Set([
  'snooze', 'done', 'reschedule', 'mute', 'reply',
  'yes', 'no', 'approve', 'reject', 'accept', 'decline', 'later',
  'dismiss', 'acknowledge',
]);

// ---------------------------------------------------------------------------
// Test seam (E0): require()ing this file exports the pure e2e helpers and
// stops HERE — none of the CLI machinery below (parseArgs, the TOKEN check,
// command dispatch) may run under a test runner's argv. Executed as a binary
// (require.main === module) it skips the export and runs the CLI unchanged.
// ---------------------------------------------------------------------------
if (require.main !== module) {
  module.exports = {
    e2eAad, e2eKeyFingerprint, e2eLoadSecret, e2eParseSecret,
    e2eEncryptField, e2eDecryptField, e2eEncryptBlob, e2eDecryptBlob,
    E2E_NEVER_SEAL_LABEL_IDS,
  };
  return;
}

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  title: { type: 'string' },
  body: { type: 'string' },
  'body-markdown': { type: 'string', short: 'm' },
  'body-markdown-file': { type: 'string' },   // a path, or "-" to read stdin (#274)
  subtitle: { type: 'string' },
  template: { type: 'string' },                // content/action pattern (manifest `templates`)
  profile: { type: 'string' },                 // delivery profile id (manifest `profiles`)
  'event-at': { type: 'string' },              // WHEN the thing happens (profile event)
  'lead-minutes': { type: 'string' },          // notify/countdown lead before event_at
  urgency: { type: 'string' },                 // normal | persistent | alarm (low-level — prefer --profile)
  escalate: { type: 'boolean' },               // #246: alert type — force an AlarmKit alarm (escalate:true)
  gated: { type: 'boolean' },                  // #274: one Face-ID confirm action (replaces content_template:sensitive)
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
  // perfis-S2 response axis: --wait blocks until the human answers (composes on
  // ANY type — send-and-go vs wait). ask/approval imply it.
  wait: { type: 'boolean' },
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
  // #34 approve: the two gated-action labels (default Allow / Deny)
  'allow-label': { type: 'string' },
  'deny-label': { type: 'string' },
  // lote-5 #4: collapse `setup` onboarding to a single status line (the full
  // doctor stays the default; --quiet is opt-in, never the default).
  quiet: { type: 'boolean' },
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
  AXIS 1 — TYPE (the married list of 5; the human configured how each arrives):
  pidge message   [options]               just inform, no action — clears when the human OPENS it
  pidge important [options]  ⭐DEFAULT     a pendency the human should resolve ("waiting-for-you" card)
  pidge urgent    [options]               breaks through silent/Focus; --escalate forces an AlarmKit alarm
  pidge event     [options]               a scheduled thing — needs --event-at (countdown Live Activity)
  pidge live      [options]               an in-flight task with incremental updates (Live Activity)
  AXIS 2 — RESPONSE (composes on ANY type above): --actions/--custom-action add
  buttons; text reply is ALWAYS available; --wait blocks until the human answers
  (send-and-go vs --wait). Two shortcuts bundle both axes:
  pidge ask      [options]                = important + --wait; needs --actions (prints chosen_action JSON)
  pidge approval [options]                = important + Approve/Reject + Face ID + --wait (a go/no-go)
  pidge approve "<question>" [options]    exit-code gate for hooks: Face-ID allow/deny, DENY-DEFAULT —
                                          exit 0 ONLY on explicit allow (deny/timeout/error → non-zero)
  COMPAT aliases (old names still work → mapped to the new type):
  pidge fyi→message · report→important · alert→urgent  (event/live unchanged)
  pidge notify [options]                  DEPRECATED — send without a type; prefer a TYPE above
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
  --gated                  add a Face-ID confirm on the consequential action (money/deletion)
  --body-markdown-file F   read the markdown body from a file (or "-" for stdin)
  --profile ID             low-level alias of the TYPE axis (the HUMAN owns what it
                           does): message · important · urgent · event · live ·
                           the user's custom profiles. Prefer the typed subcommands
                           above; an explicit --profile still wins. See the manifest.
  --event-at ISO8601       WHEN the thing happens (a FACT; required by profile event)
  --lead-minutes N         notify/start countdown N min before event_at (5–240)
  --urgency LEVEL          normal | persistent | alarm (low-level — prefer --profile)
  --image PATH_OR_URL      image on the banner + feed: a local path is uploaded for
                           you (your machine has no public URL); an https URL is sent as-is
  --file PATH              a real artifact (xlsx, pdf, csv…) the human previews,
                           shares and saves on the phone; uploaded automatically (≤25 MB)
  --url URL                deep link the app opens when the user taps (PR, dashboard, log)
  --copy TEXT              value offered as tap-to-copy on the detail (code, token)
  --actions LIST           RESPONSE axis — comma list: yes,no,approve,reject,accept,
                           decline,later,done,snooze,reschedule,reply,mute (or a JSON
                           array of custom {id,label} objects). Composes on ANY type.
  --custom-action SPEC     "id:label[:destructive][:confirm][:biometric][:terminal]" (repeatable)
  --wait                   RESPONSE axis — block until the human answers (any type),
                           then print chosen_action JSON. Without it: fire-and-forget
                           (the answer arrives later in \`pidge listen --all\`). ask/approval imply it.
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
  --timeout SECONDS        how long --wait blocks (ask/approval: template's suggestion,
                           ~3600 for a decision · wait: 300) — explicit always wins
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
  PIDGE_SECRET  the channel's E2E key (base64url, 32 bytes). When the human turns
                on end-to-end encryption, the app's Connect screen shows a separate
                TERMINAL step that writes it to ~/.config/pidge/env — the secret
                never travels in the chat prompt (never paste it in chat). Same
                slot and precedence as PIDGE_TOKEN (the pair travels together).
                With it set and the channel E2E, sends are sealed and sealed
                answers/messages decrypt automatically; without it, sends go clear
                and the app marks them "⚠️ sem criptografia". Validate with
                \`pidge doctor\`.

OUTPUT
  stdout is machine-readable (a fire-and-forget send→the raw 201 JSON; a --wait
  send / ask / approval / wait→chosen_action JSON); human notices go to stderr.
  Exit: 0 answered · 3 timed out (no answer yet, not a failure) · 4 timed out
  WITHOUT ONE healthy round-trip all session (the CHANNEL looks broken —
  server/network — not the human ignoring you: surface it instead of retrying
  blindly, #119) · 2 error · 1 usage.

Responses are one-and-done EXCEPT snooze/reschedule (they re-fire); a --wait send
keeps polling through a snooze and prints snooze_until. Follow-up = a NEW
notification. An over-ceiling type is delivered DEGRADED, never rejected — read
the 201's degraded/degrade_reason (narrated on stderr). \`live\` is status-only:
it never produces an answer, so --wait/ask refuse it.

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
  'body-markdown-file': '--body-markdown-file F   read the markdown body from a file (or "-" for stdin) — avoids shell-quoting long markdown',
  subtitle: '--subtitle TEXT          a secondary line under the title',
  gated: '--gated                  add a Face-ID confirm on the consequential action (money/deletion). Pair with a louder profile if it must also be loud.',
  profile: '--profile ID             low-level alias of the TYPE (the human owns it): message · important · urgent · event · live · custom',
  'event-at': '--event-at ISO8601       WHEN the thing happens (required by event)',
  'lead-minutes': '--lead-minutes N         notify/countdown N min before event_at (5–240)',
  urgency: '--urgency LEVEL          normal | persistent | alarm (low-level — prefer the typed subcommand)',
  escalate: '--escalate               urgent: force an AlarmKit alarm that breaks through silent/Focus',
  image: '--image PATH_OR_URL      banner+feed image: a local path is uploaded; an https URL is sent as-is',
  file: '--file PATH              a real artifact (xlsx/pdf/csv…) uploaded for the human (≤25 MB)',
  url: '--url URL                deep link the app opens on tap (PR, dashboard, log)',
  copy: '--copy TEXT              tap-to-copy value on the detail screen',
  actions: '--actions LIST|JSON      RESPONSE axis: comma list from the catalog (e.g. yes,no · or reply ALONE — never mix a decision with reply) OR a JSON array of {"id","label"} custom actions — composes on ANY type',
  'custom-action': '--custom-action SPEC     "id:label[:destructive][:confirm][:biometric][:terminal]" (repeatable)',
  wait: '--wait                  RESPONSE axis: block until the human answers (any type), then print chosen_action JSON (ask/approval imply it)',
  'deliver-at': '--deliver-at ISO8601     schedule the send for later',
  'reply-to': '--reply-to URL           also POST the answer to your webhook (HMAC-signed)',
  'correlation-id': '--correlation-id ID      idempotency + routing key (auto-generated if omitted)',
  thread: '--thread ID              conversation handle (#49): same id ⇒ one strand on the phone',
  after: '--after CID              decision queue (#157): held until that notification is answered',
  'collapse-key': '--collapse-key KEY       replace/update a prior notification',
  param: '--param KEY=VALUE        pass ANY raw /notify field (repeatable) — the manifest is the contract',
  timeout: '--timeout SECONDS        how long --wait blocks (ask/approval: template suggestion ~3600 · wait: 300 · listen: 600)',
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
  'allow-label': '--allow-label TEXT       approve: label on the Face-ID allow button (default "Allow")',
  'deny-label': '--deny-label TEXT        approve: label on the deny button (default "Deny")',
  quiet: '--quiet                  setup: collapse onboarding to one status line (the full doctor stays the default)',
};
// Content flags shared by every send.
// lote-5 #3: `template` is intentionally OFF the menu (#274 — content_template is
// undocumented back-compat). It stays a parseable OPTION but is NOT listed here,
// so `pidge <type> --help` no longer prints a bare, description-less `template` line.
const CONTENT_OPTS = ['title', 'body', 'body-markdown', 'body-markdown-file', 'subtitle', 'profile',
  'event-at', 'lead-minutes', 'urgency', 'image', 'file', 'url', 'copy', 'actions',
  'custom-action', 'deliver-at', 'reply-to', 'correlation-id', 'thread', 'after',
  'collapse-key', 'param'];
// Typed sends also carry the RESPONSE axis: --wait (block on the answer) + the
// blocking knobs. (`live` is status-only — it never answers, so it skips these.)
const SEND_OPTS = [...CONTENT_OPTS, 'gated', 'wait', 'timeout', 'interval', 'realtime', 'no-realtime'];

const HELP = {
  setup: {
    summary: 'one-shot onboarding (#110): exchange a single-use claim code for the channel key, store it, run doctor.',
    usage: 'pidge setup --claim CODE [--url BASE] [--print] [--force] [--listen-mode MODE]',
    body: 'The CLI writes the key itself (chmod 600) — it never appears on screen or in the agent\'s chat. MULTI-AGENT: set PIDGE_AGENT=<id> at each agent\'s launch for an isolated config. --quiet collapses the onboarding to one status line.',
    opts: ['claim', 'url-base', 'print', 'force', 'listen-mode', 'quiet'],
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
    body: 'First contact on a fresh channel: send the debut handshake and block until your human confirms. The server narrates a 3-stage Live Activity.',
    opts: [...CONTENT_OPTS, 'timeout', 'interval', 'realtime', 'no-realtime'],
  },
  // AXIS 1 — the married catalog of 5 (perfis-S1/S2). The TYPE you pick IS how the
  // human configured it to arrive. RESPONSE (--actions/--wait) composes on any of them.
  message: {
    summary: 'just inform — passive info the human reads when they want; no action (clears when they OPEN it).',
    usage: 'pidge message --title TEXT [--body TEXT | --body-markdown MD] [--image PATH] [--url URL]',
    body: 'Fire-and-forget by default (stdout is the raw 201). Use it for logs, registros and neutral summaries. Need a decision? add --actions + --wait, or use `pidge important`/`pidge approval`. (Replaces the old `fyi`.)',
    opts: [...SEND_OPTS],
  },
  important: {
    summary: '⭐ the DEFAULT — a pendency the human should resolve ("waiting-for-you" card; clears on Done).',
    usage: 'pidge important --title TEXT [--actions yes,no] [--wait] [--body-markdown MD]',
    body: 'Fire-and-forget by default; add --actions/--custom-action for quick-tap buttons and --wait to block until the human answers (prints chosen_action JSON). The most-used type — on the fence between informing and asking, pick this. (Replaces the old `report`.)',
    opts: [...SEND_OPTS],
  },
  urgent: {
    summary: 'breaks through silent/Focus; --escalate forces an AlarmKit alarm. Use for the real and inadiável (<1/day).',
    usage: 'pidge urgent --title TEXT [--escalate] [--actions yes,no] [--wait]',
    body: 'A contract of trust: reserve it for what truly can\'t wait. --escalate asks for an AlarmKit alarm that rings through silent + Focus (the human\'s settings still decide). Once DELIVERED an urgent only stops when answered — you can\'t abort it. (Replaces the old `alert`.)',
    opts: [...SEND_OPTS, 'escalate'],
  },
  event: {
    summary: 'a scheduled thing with a known time — countdown Live Activity (needs --event-at).',
    usage: 'pidge event --title TEXT --event-at ISO8601 [--lead-minutes N] [--body-markdown MD]',
    body: 'REQUIRES --event-at (ISO8601, e.g. 2026-06-26T14:00-03:00 — no offset ⇒ the user\'s timezone). --lead-minutes (5–240) starts the countdown N min before.',
    opts: [...SEND_OPTS],
  },
  live: {
    summary: 'track an in-flight task (deploy/build/trip) with incremental updates (Live Activity). Status-only — never answers.',
    usage: 'pidge live --title TEXT [--body TEXT] [--lead-minutes N]',
    body: 'Fire-and-forget. Records the live type; the LA-as-primitive is being built — today the send is delivered as a normal notification. Use judgement, not a recipe: show what the human WANTS to watch evolve.',
    opts: [...CONTENT_OPTS],
  },
  // AXIS 2 — the two response shortcuts (bundle a type + buttons + --wait).
  ask: {
    summary: 'a DECISION — = important + --wait; needs --actions. Blocks until the human answers (prints chosen_action JSON).',
    usage: 'pidge ask --title TEXT --actions yes,no [--reply-to URL] [options]',
    body: 'Shorthand for important --wait that REQUIRES a way to answer — --actions (catalog or JSON) or --custom-action. For a typed answer use --actions reply ALONE (never a decision + reply together). Holds a WebSocket (or polls) until a TERMINAL answer; a snooze/reschedule re-fires.',
    opts: [...CONTENT_OPTS, 'timeout', 'interval', 'realtime', 'no-realtime'],
  },
  approval: {
    summary: 'a go/no-go RECIPE — = important + Approve/Reject + Face ID on Approve + --wait.',
    usage: 'pidge approval --title TEXT [--body-markdown MD] [options]',
    body: 'The easy shortcut for an explicit approval: injects an Approve (Face-ID gated) / Reject pair and blocks on the answer. Pass your own --actions/--custom-action to override the default pair. A gated action is detail-screen only (the banner shows no quick buttons by design — gotcha #19).',
    opts: [...CONTENT_OPTS, 'timeout', 'interval', 'realtime', 'no-realtime'],
  },
  // #34 — the HOOK-shaped gate. DENY-DEFAULT: exit 0 ONLY on an explicit allow;
  // deny, timeout, a dead channel or any ambiguity is non-zero, so a permission
  // hook fails CLOSED. Built for PreToolUse (see the runnable example below).
  approve: {
    summary: 'ask the human to authorize a risky action (Face ID) and BLOCK — deny-default: exit 0 ONLY on explicit allow.',
    usage: 'pidge approve "<question>" [--body TEXT] [--timeout N] [--allow-label L] [--deny-label L]',
    body: [
      'Sends an important/sensitive notification with two gated custom actions — allow (Face-ID confirm) and deny — then blocks on the answer (the same long-poll as `pidge ask`).',
      'DENY-DEFAULT (the security rule): only an explicit allow is exit 0. deny → exit 1; timeout / no answer / a broken channel / an HTTP failure on the send → exit 1. ONLY a raw network error (the send never reached the server at all) → exit 2. NON-ZERO ALWAYS MEANS "not approved" — treat it as a deny.',
      'TRUST CAVEAT: the gate is only as trustworthy as this process\'s env — whatever can rewrite PIDGE_URL/PIDGE_TOKEN can redirect the approval (and your bearer token) to its own server and answer "allow". Run permission hooks in an environment you trust.',
      'chosen_action JSON is printed to stdout; human notices go to stderr.',
      '',
      'PreToolUse hook (Claude Code) — gate a risky tool behind a human Face-ID tap, fail-closed:',
      '  #!/usr/bin/env bash',
      '  input=$(cat)                                   # the hook JSON on stdin',
      '  tool=$(printf %s "$input" | jq -r .tool_name)',
      '  cmd=$(printf %s "$input" | jq -r ".tool_input.command // (.tool_input|tostring)")',
      '  if pidge approve "Allow $tool?" --body "$cmd" --timeout 300 >/dev/null 2>&1; then',
      '    exit 0            # human approved (Face ID) → let the tool run',
      '  else',
      '    echo "Blocked: no human approval for $tool" >&2',
      '    exit 2            # exit 2 = PreToolUse BLOCK; fail-closed on deny/timeout/error',
      '  fi',
    ].join('\n'),
    opts: [...CONTENT_OPTS, 'allow-label', 'deny-label', 'timeout', 'interval', 'realtime', 'no-realtime'],
  },
  // COMPAT aliases — old names map to the new type (kept so scripts don't break).
  fyi: {
    summary: 'COMPAT alias of `pidge message` (renamed in 0.14 — the married catalog). Still works; prefer `message`.',
    usage: 'pidge fyi … (→ pidge message …)',
    opts: [...SEND_OPTS],
  },
  report: {
    summary: 'COMPAT alias of `pidge important` (renamed in 0.14). Still works; prefer `important`.',
    usage: 'pidge report … (→ pidge important …)',
    opts: [...SEND_OPTS],
  },
  alert: {
    summary: 'COMPAT alias of `pidge urgent` (renamed in 0.14). Still works; prefer `urgent`.',
    usage: 'pidge alert … (→ pidge urgent …)',
    opts: [...SEND_OPTS, 'escalate'],
  },
  notify: {
    summary: 'DEPRECATED — send WITHOUT a type; the server falls back to its default. Use a typed send instead.',
    usage: 'pidge notify [options]',
    body: 'Kept for compat — it warns and still sends (no template_kind; the server picks the channel default). Prefer `pidge message/important/urgent/event/live` (or the `ask`/`approval` shortcuts).',
    opts: [...SEND_OPTS],
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
// lote-5 #4: `--quiet` collapses setup/doctor NARRATION to a single status line.
// `note()` prints an informational line only when NOT quiet; WARNINGS and ERRORS
// keep using console.error directly, so --quiet never hides a broken setup.
const QUIET = !!v.quiet;
const note = (msg) => { if (!QUIET) console.error(msg); };

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
const KNOWN_MANIFEST_VERSION = 51;
// #280: the hand-authored skill SPINE version. BUMP whenever the SKILL.md spine
// (the non-generated prose in installSkill) changes — an existing install whose
// baked marker is older than this self-heals on its next pidge command, so an
// onboarded agent always runs the latest skill without any human action. Start at 1.
// Bumped to 2 in 0.15.3 so every 0.15.2 install (which baked the marker ABOVE the `---`,
// corrupting the skill's description) is detected as stale and self-heals into the fixed
// in-frontmatter format on the next command. Bump this whenever the hand-authored spine moves.
// Bumped to 3 in 0.16.0: the spine now teaches `pidge approve` (the hook-shaped gate)
// and notes the CLI now REFUSES a decision + reply in one send (lote-5 #2).
// Bumped to 4 in 0.16.1 (#38): the generated skill now ends with SKILL_END_MARKER (the
// cheap integrity check) — the bump heals every pre-marker install into the new format.
const SKILL_REVISION = 5;
// #38: the LAST line of every generated skill. A file that carries the frontmatter
// marker but not this trailer was torn mid-write (partial write / full disk) —
// ensureSkillFresh treats it as stale and re-heals instead of trusting its rev.
const SKILL_END_MARKER = '<!-- pidge-skill-end -->';
const NAG_TTL_MS = 24 * 60 * 60 * 1000; // #241: at most one nag per 24 h
let newsWarned = false;
// #280: the self-heal runs at most ONCE per process (one regeneration, even when
// many commands/poll-ticks call checkManifestNews). Non-stale checks stay cheap +
// repeatable; this only latches once an actual heal is attempted.
let skillHealed = false;

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

async function checkManifestNews(res) {
  const ver = parseInt(res.headers.get('x-pidge-manifest-version') || '0', 10);
  // #280: the self-heal runs on EVERY command (its own once-guard + cheap
  // first-line read), BEFORE the nag throttle below — it must fire even when the
  // server isn't ahead of KNOWN_MANIFEST_VERSION (a pure spine bump) and even
  // under QUIET_NAG (which only silences the stderr note, never the regenerate).
  await ensureSkillFresh(ver);
  if (QUIET_NAG || newsWarned) return;
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
  // #26: pidge is a THIN PIPE — a server manifest bump almost never needs a CLI
  // release, because --param carries any new /notify field NOW. So the nudge is
  // "new capabilities + how to use them today", NOT "your CLI is stale, update it".
  // #249-A: the manifest is PUBLIC — the curl reads the catalog without a key
  // (a key only adds your channel's own config). Updating the CLI is the LAST,
  // optional step (only to gain native flags), never the headline.
  console.error(`pidge: the server has NEW capabilities (manifest v${ver}; this CLI knows v${KNOWN_MANIFEST_VERSION}) — pidge is a thin pipe, so you can use any new /notify field RIGHT NOW via --param KEY=VALUE. Read the catalog (whats_new) in the public manifest:  curl $PIDGE_URL/api/v1/manifest  (public; add -H "Authorization: Bearer $PIDGE_TOKEN" to also see your channel's config). Updating the CLI only matters to gain native flags:  npx pidge-cli@latest  (a pinned ref never self-updates). Silence this with --quiet-nag or PIDGE_QUIET_NAG=1.`);
}

// #280: STRUCTURAL self-heal — keep the LOCAL skill current with zero human action.
// The installed .claude/skills/pidge/SKILL.md is written once at onboarding and then
// goes stale silently (a CLI/skill improvement gives an onboarded agent no signal, so
// it keeps running the old skill). This silently regenerates it when EITHER trigger
// fires: this CLI's hand-authored spine moved (SKILL_REVISION > the baked rev) OR the
// server's manifest moved (serverManifestVersion > the baked manifest) — caught from
// the x-pidge-manifest-version header that already rides every response. So the agent's
// NEXT session is always current. Only REFRESHES an existing skill (creating one is
// onboarding's job, never a side effect of an unrelated command), runs at most once per
// process, and is wholly best-effort: any failure is swallowed — a skill refresh must
// NEVER break the user's actual command.
// #38: locate the self-heal marker ONLY where a generated skill ever put it —
// line 1 (the pre-0.15.3 `<!-- pidge-skill … -->` HTML comment, above the `---`)
// or a line inside the OPENING frontmatter block (the 0.15.3+ `# pidge-skill …`
// YAML comment). Body prose mentioning "pidge-skill" is invisible to this scan.
function findSkillMarker(content) {
  const lines = content.split('\n');
  if (lines[0] && lines[0].includes('pidge-skill')) return lines[0];
  if (lines[0] !== '---') return '';
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') break; // closing fence — the marker lives above it
    if (lines[i].includes('pidge-skill')) return lines[i];
  }
  return '';
}

async function ensureSkillFresh(serverManifestVersion) {
  if (skillHealed) return;
  try {
    // Resolve the path the SAME way installSkill does (cwd-relative).
    const file = path.join(process.cwd(), '.claude', 'skills', 'pidge', 'SKILL.md');
    if (!fs.existsSync(file)) return; // don't auto-create — only refresh an existing skill
    // #33 fix + #38: the marker rides a `# pidge-skill rev=N manifest=M` YAML comment INSIDE
    // the frontmatter (0.15.3+); pre-0.15.3 installs put `<!-- pidge-skill … -->` as line 1.
    // #38: the scan is ANCHORED to those two positions (line 1, or inside the opening `---`
    // block) — a prose line in the body like "see pidge-skill rev=99" must never be read as
    // the marker and suppress a legitimate heal.
    const content = fs.readFileSync(file, 'utf8');
    const markerLine = findSkillMarker(content);
    const revM = markerLine.match(/rev=(\d+)/);
    const manM = markerLine.match(/manifest=(\d+)/);
    const installedRev = revM ? parseInt(revM[1], 10) : 0;
    const installedManifest = manM ? parseInt(manM[1], 10) : 0;
    // #38 integrity: a generated skill always ends with SKILL_END_MARKER. A marker whose
    // rev looks current but whose trailer is missing = a TORN write (the marker survived
    // on line ~4, the tail didn't) — without this check the tear would read as "fresh"
    // and never heal. Pre-#38 installs lack the trailer too, but their rev < 4 already
    // marks them stale, so the two triggers compose instead of fighting.
    const torn = installedRev > 0 && !content.trimEnd().endsWith(SKILL_END_MARKER);
    const stale = torn || SKILL_REVISION > installedRev || (serverManifestVersion || 0) > installedManifest;
    if (!stale) return;
    skillHealed = true; // latch BEFORE the network write — attempt the heal at most once
    const r = await installSkill(BASE, TOKEN); // silent: it already writes the file
    // Respect QUIET_NAG/PIDGE_QUIET_NAG for the note only — we STILL regenerated.
    if (!QUIET_NAG)
      console.error(`pidge: refreshed your local Pidge skill (rev ${SKILL_REVISION}, manifest v${r.manifest_version}) — your next session will use it.`);
  } catch { /* best-effort — a skill refresh must never break the user's command */ }
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
  // #25: the reconnect log prefixes "realtime socket …", so the reason must NOT
  // start with "socket" again (was "socket socket closed (1006)").
  ws.onclose = (e) => die(`closed (${e.code})`);
  return { close: () => { closed = true; clearInterval(beatCheck); try { ws.close(); } catch { /* noop */ } } };
}

// Run one WS subscription session until the deadline / an unrecoverable WS
// problem, reconnecting with backoff in between (a deploy = seconds of gap; the
// criterion: hours-long listens must SURVIVE it, #119). onUp/onFrame get a
// `finish(reason)` to end the session (e.g. when the answer landed over HTTP).
// Resolves 'deadline' | 'ws-unavailable'.
async function cableSession({ channel, deadline, onUp, onFrame }) {
  let wsFails = 0;      // consecutive drops SINCE the last healthy connect — the degrade gate
  let wsReconnects = 0; // monotonic total this session — what we DISPLAY (never reset)
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
    wsReconnects++;
    const MAX_WS_FAILS = 4; // then fall back to polling for the rest of the session
    if (wsFails >= MAX_WS_FAILS) return 'ws-unavailable';
    // env override = a test/ops hook (keeps the forced-1006 degrade test fast)
    const base = parseInt(process.env.PIDGE_WS_BACKOFF_MS || '2000', 10) || 2000;
    const backoff = Math.min(base * wsFails, base * 5);
    // #25: show the MONOTONIC reconnect count, not the consecutive-fail counter —
    // a connect→drop FLAP resets wsFails (onUp forgives a healthy connect), so the
    // old "attempt 1/4" repeated forever and looked like a stuck loop. The cumulative
    // "#N" visibly advances; the polling fallback is spelled out so the ceiling is clear.
    console.error(`pidge: realtime socket ${outcome.replace('down: ', '')} — reconnecting in ${Math.round(backoff / 1000)}s (reconnect #${wsReconnects}; falls back to polling after ${MAX_WS_FAILS} consecutive failures)`);
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

// ---------------------------------------------------------------------------
// E2E wire layer (E2-CLI, #43 — contract: e2e-spec-v1.md + manifest v49/v51).
// SEND: with a valid PIDGE_SECRET AND an E2E channel (whoami says — never a
// guess), the content fields leave this machine as envelopes with enc:"v1"+kf;
// otherwise the send is the clear send of always (the server accepts-and-marks
// — a missing secret must NEVER block a notification).
// RECEIVE: every read path gates on the EXPLICIT `enc` flag (never on sniffing
// the "v1:" prefix). Inside a sealed context, an envelope MUST open — a kf that
// isn't ours / a failed tag / a missing AAD anchor is a PRECISE error and the
// field is BLANKED (base64 never reaches the terminal — follow-up A1); a value
// that is NOT an envelope is readable text and passes through untouched (a
// built-in action label, or a clear reply typed on a pre-E2E app — the same
// accept-and-mark honesty the iOS app shows).
// ---------------------------------------------------------------------------
const E2E_CONTENT_FIELDS = ['title', 'subtitle', 'body', 'body_markdown'];
const isEnvelope = (s) => typeof s === 'string' && /^v\d+:/.test(s);

// Parse PIDGE_SECRET ONCE per process. null = absent or invalid (invalid warns
// loudly — the send degrades to clear and the app marks it "⚠️ sem criptografia").
let e2eMat; // undefined = not yet computed
function e2eKeyMaterial() {
  if (e2eMat !== undefined) return e2eMat;
  try {
    const key = e2eParseSecret(e2eLoadSecret());
    e2eMat = key ? { key, kf: e2eKeyFingerprint(key) } : null;
  } catch (e) {
    console.error(`pidge: WARNING — PIDGE_SECRET is INVALID (${e.message}). E2E is OFF for this run: sends go CLEAR (the app marks them "⚠️ sem criptografia") and sealed content can't be opened. Fix: the app's Connect screen shows a separate TERMINAL step that writes PIDGE_SECRET to ~/.config/pidge/env — ask your human to run THAT (never paste the secret in chat); \`pidge doctor\` then confirms it.`);
    e2eMat = null;
  }
  return e2eMat;
}

// The channel's PUBLIC id + e2e_enabled, from whoami — the AAD binds to the id,
// and e2e_enabled is the ONLY thing that turns sealing on (a secret pointing at
// a non-E2E channel is an orphan: send clear; `pidge doctor` warns). Cached per
// process; a failure is NOT cached so a later call may retry.
let e2eChannelCache = null;
async function e2eChannelInfo() {
  if (e2eChannelCache) return e2eChannelCache;
  const { res, data } = await fetchWhoami();
  if (res.status !== 200 || !data.channel) throw new Error(`whoami answered ${res.status}`);
  e2eChannelCache = { id: data.channel.id, e2eEnabled: !!data.channel.e2e_enabled };
  return e2eChannelCache;
}

// One stderr line per DISTINCT reason per process — a 50-row backlog sealed
// with another key is one loud line, not 50.
const e2eNoted = new Set();
function e2eNote(msg) {
  if (e2eNoted.has(msg)) return;
  e2eNoted.add(msg);
  console.error(`pidge: E2E — ${msg}`);
}

// The precise pre-flight reason a sealed context can't be opened, or null when
// the key material looks right and the decrypt should be attempted.
function e2eSealedError(enc, theirKf) {
  if (enc !== 'v1') return `sealed with an unknown envelope version ${JSON.stringify(enc)} — this CLI speaks v1 (update pidge-cli)`;
  const mat = e2eKeyMaterial();
  if (!mat) return 'sealed, but no (valid) PIDGE_SECRET is configured — the app\'s Connect screen shows a separate TERMINAL step that writes PIDGE_SECRET to ~/.config/pidge/env; ask your human to run THAT (never paste the secret in chat), then `pidge doctor` confirms it';
  if (theirKf && theirKf !== mat.kf) return `sealed with ANOTHER key (its kf ${theirKf}, your PIDGE_SECRET's kf ${mat.kf}) — your token and secret likely belong to different channels; ask your human to run THIS channel's terminal step from the app's Connect screen (never paste the secret in chat)`;
  return null;
}

// Open ONE value found inside a sealed context (the enc flag gated us in).
// Returns the plaintext; the value UNCHANGED when it isn't an envelope
// (readable text); or null after reporting a precise reason via onError.
function e2eOpenValue({ enc, kf, channelId, cid, field, value, onError }) {
  if (!isEnvelope(value)) return value;
  const reason = e2eSealedError(enc, kf)
    || (!cid && 'sealed but the row carries NO correlation_id (the AAD anchor) — the server predates E1.5, or a bug: it can never be decrypted')
    || (channelId == null && 'sealed but the channel id is unknown (whoami failed) — the AAD needs it; retry when the server is reachable')
    || null;
  if (reason) { onError(reason); return null; }
  try {
    return e2eDecryptField(e2eKeyMaterial().key, e2eAad(channelId, cid, field), value);
  } catch (e) {
    onError(`${field} failed to open: ${e.message}`);
    return null;
  }
}

// SEND-side sealing, called by doNotify on the final payload. Mutates it:
// content fields + custom-action LABELS become envelopes (action IDs stay
// clear — the action contract runs on ids), enc:"v1" + kf ride alongside, and
// the correlation_id is ALWAYS minted client-side (the AAD needs it BEFORE the
// server ever sees the payload).
async function e2eMaybeSeal(payload) {
  const mat = e2eKeyMaterial();
  if (!mat) return;
  let ch;
  try {
    ch = await e2eChannelInfo();
  } catch (e) {
    console.error(`pidge: WARNING — couldn't confirm the channel's E2E state (${e.message}); sending CLEAR (an E2E channel accepts-and-marks it "⚠️ sem criptografia")`);
    return;
  }
  if (!ch.e2eEnabled) return; // orphan secret — clear send is the contract; `pidge doctor` warns
  if (!payload.correlation_id) payload.correlation_id = crypto.randomUUID();
  const seal = (field, value) =>
    e2eEncryptField(mat.key, e2eAad(ch.id, payload.correlation_id, field), String(value));
  for (const f of E2E_CONTENT_FIELDS) {
    if (payload[f] !== undefined && payload[f] !== null && payload[f] !== '') payload[f] = seal(f, payload[f]);
  }
  for (const ca of payload.custom_actions || []) {
    if (E2E_NEVER_SEAL_LABEL_IDS.has(ca.id)) continue; // builtin/system id — the label rides CLEAR (#313)
    if (typeof ca.label === 'string' && ca.label !== '') ca.label = seal(`action_label_${ca.id}`, ca.label);
  }
  payload.enc = 'v1';
  payload.kf = mat.kf;
  if (payload.image !== undefined || payload.file !== undefined)
    console.error('pidge: E2E note — media BYTES and the filename still ride CLEAR (encrypted media is phase E3); the text fields are sealed');
  console.error(`pidge: E2E — content sealed (kf ${mat.kf}); the server stores and relays ciphertext only`);
}

// Decrypt OUR OWN envelopes in the 201/upsert echo so "trust the echo" keeps
// meaning something on stdout (the wire echo is ciphertext by design). enc/kf
// stay in the printed JSON — they are the wire truth of the send.
function e2eOpenEcho(info, payload) {
  const mat = e2eKeyMaterial();
  if (!mat || !e2eChannelCache || !info || typeof info !== 'object') return null;
  const cid = info.correlation_id || payload.correlation_id;
  if (!cid) return null;
  try {
    for (const f of E2E_CONTENT_FIELDS) {
      if (isEnvelope(info[f])) info[f] = e2eDecryptField(mat.key, e2eAad(e2eChannelCache.id, cid, f), info[f]);
    }
    return JSON.stringify(info);
  } catch { return null; } // an un-openable echo prints as the server sent it
}

// RECEIVE: one row of GET /api/v1/messages. Two sealed shapes exist —
//   kind:"message" (E1.5): the row's own enc/kf/correlation_id; body opens with
//     field ALWAYS "message" (composer AND late-reply — the late reply reuses
//     the answered notification's cid as its correlation_id);
//   kind:"notification_reply": the envelope rides ref/ref_payload (E2) — ref.enc
//     gates; text opens with field "reply", ref.title with "title", and a body
//     that is a custom-action LABEL with "action_label_<action_id>".
// On success the plaintext replaces the ciphertext and enc/kf are swapped for
// e2e:"decrypted" (an agent re-gating on `enc` must never mistake plaintext for
// an envelope); on failure the sealed fields are BLANKED and e2e_error says why.
function e2eOpenMessageRow(m) {
  const refEnc = m.ref && m.ref.enc;
  if (!m.enc && !refEnc) return m; // a clear line renders as always (pre-E2E history)
  const out = { ...m };
  const fail = (reason) => { if (!out.e2e_error) out.e2e_error = reason; e2eNote(reason); };
  if (m.enc) {
    out.body = e2eOpenValue({
      enc: m.enc, kf: m.kf, channelId: m.channel_id, cid: m.correlation_id,
      field: 'message', value: m.body, onError: fail,
    });
  }
  if (refEnc) {
    out.ref = { ...m.ref };
    const ctx = { enc: m.ref.enc, kf: m.ref.kf, channelId: m.channel_id, cid: m.ref.correlation_id, onError: fail };
    if (m.text !== undefined && m.text !== null) {
      out.text = e2eOpenValue({ ...ctx, field: 'reply', value: m.text });
      if (m.body === m.text) out.body = out.text; // body mirrors the reply text
    }
    if (m.ref.title !== undefined && m.ref.title !== null) {
      out.ref.title = e2eOpenValue({ ...ctx, field: 'title', value: m.ref.title });
    }
    // No text: the body mirrors the tapped action's LABEL — sealed only for a
    // custom action (a built-in label is server-side clear and passes through).
    if (isEnvelope(out.body) && m.action_id) {
      out.body = e2eOpenValue({ ...ctx, field: `action_label_${m.action_id}`, value: out.body });
    }
    // A1 safety net: an envelope we could not ATTRIBUTE to a field (a label-
    // derived body with no action_id) is still never printed. Compared to the
    // ORIGINAL value so a decrypted plaintext that happens to start with "v1:"
    // can never be blanked by mistake.
    if (isEnvelope(out.body) && out.body === m.body) {
      fail('a sealed field could not be attributed (no action_id on the answer) — not printing ciphertext');
      out.body = null;
    }
  }
  if (!out.e2e_error) {
    delete out.enc; delete out.kf;
    if (out.ref) { delete out.ref.enc; delete out.ref.kf; }
    out.e2e = 'decrypted';
  }
  return out;
}

// RECEIVE: the poll's chosen_action (wait/ask/approve/hello). The notification-
// level enc/kf gate (the poll payload carries them); text opens with field
// "reply", a custom action's label with "action_label_<action_id>". The poll
// payload has no channel id, so whoami resolves it once (cached).
async function e2eOpenChosen(data) {
  const chosen = data.chosen_action;
  if (!data.enc || !chosen) return;
  const fail = (reason) => { if (!chosen.e2e_error) chosen.e2e_error = reason; e2eNote(reason); };
  let channelId = null;
  if (e2eKeyMaterial()) {
    try { channelId = (await e2eChannelInfo()).id; } catch { /* e2eOpenValue names it */ }
  }
  const ctx = { enc: data.enc, kf: data.kf, channelId, cid: data.correlation_id, onError: fail };
  if (chosen.text !== undefined && chosen.text !== null) {
    chosen.text = e2eOpenValue({ ...ctx, field: 'reply', value: chosen.text });
  }
  if (chosen.label !== undefined && chosen.label !== null) {
    if (chosen.action_id) {
      chosen.label = e2eOpenValue({ ...ctx, field: `action_label_${chosen.action_id}`, value: chosen.label });
    } else if (isEnvelope(chosen.label)) {
      // A1 safety net: a sealed label with no action_id can't be attributed —
      // blank it rather than print ciphertext.
      fail('label is sealed but the answer carries no action_id — not printing ciphertext');
      chosen.label = null;
    }
  }
}

// Map CLI flags → the /notify JSON body, including only what was provided. `extra`
// carries subcommand-supplied raw fields (#246: the typed sends' template_kind and
// alert's escalate) — merged below, before the --param escape hatch.
function buildBody(extra = {}) {
  if (!v.title) die('pidge: --title is required', 1);
  const body = { title: v.title };
  if (v.body !== undefined) body.body = v.body;
  if (v['body-markdown-file'] !== undefined) {
    body.body_markdown = v['body-markdown-file'] === '-'
      ? fs.readFileSync(0, 'utf8')
      : fs.readFileSync(v['body-markdown-file'], 'utf8');
  } else if (v['body-markdown'] !== undefined) {
    body.body_markdown = v['body-markdown'];
  }
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
      catch (e) { die(`pidge: --actions looks like JSON but didn't parse (${e.message}). Use a JSON array of {"id","label"} objects, or the short form yes,no (or reply alone)`, 1); }
      if (!Array.isArray(arr)) die('pidge: --actions JSON must be an ARRAY of {"id","label"} objects', 1);
      arr.forEach((item, i) => customActions.push(customActionFromJson(item, i)));
    } else {
      body.actions = trimmed.split(',').filter(Boolean);
    }
  }
  for (const spec of v['custom-action'] || []) customActions.push(customActionFromSpec(spec));
  if (customActions.length) body.custom_actions = customActions;

  // lote-5 #2: REFUSE a decision button + `reply` in the same send (the skill's
  // anti-slop rule #4). The human taps the easy Yes/No and you get a useless
  // "Yes" instead of the typed text you wanted. One question per send — enforce
  // it locally (exit 1, no round-trip), don't warn-and-send. (`reply` alongside a
  // non-decision like done/snooze is fine — DONE_REPLY is a real category.)
  if (Array.isArray(body.actions) && body.actions.includes('reply')) {
    const DECISION_ACTIONS = ['yes', 'no', 'approve', 'reject', 'accept', 'decline', 'later'];
    const decisions = body.actions.filter((a) => DECISION_ACTIONS.includes(a));
    if (decisions.length)
      die(`pidge: --actions can't combine a decision button (${decisions.join(',')}) with \`reply\` — the human taps the easy button and you get a useless "${decisions[0]}" instead of the text you wanted. Use \`--actions reply\` ALONE for a typed answer, or drop \`reply\` for a button decision. One question per send.`, 1);
  }

  // #274: --gated synthesizes ONE Face-ID confirm on the consequential action
  // (money/deletion) — the replacement for the retired content_template:sensitive.
  // Skip if the agent already supplied a biometric action (don't double-gate).
  if (v.gated && !(body.custom_actions || []).some((c) => c.biometric)) {
    body.custom_actions = (body.custom_actions || []).concat([
      { id: 'confirm_action', label: 'Confirm', style: 'destructive', confirm: true, biometric: true, terminal: true },
    ]);
  }

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
  // E2E (E2-CLI): seal the content AFTER everything else composed the payload —
  // typed sends, approval/approve/hello custom actions, --param, media refs all
  // pass through here, so every send path is covered by this one call.
  await e2eMaybeSeal(payload);
  let res, raw;
  try {
    res = await fetch(`${BASE}/api/v1/notify`, {
      method: 'POST', headers, body: JSON.stringify(payload),
    });
    raw = await res.text();
  } catch (e) {
    die(`pidge: send failed (network): ${e.message}`, 2);
  }
  await checkManifestNews(res);
  const ok = res.status >= 200 && res.status < 300;
  let info = {};
  try { info = JSON.parse(raw); } catch { /* leave {} */ }
  if (ok && payload.enc === 'v1') {
    // stdout keeps "trust the echo" meaningful: our own envelopes, decrypted
    // for display (the wire/server saw only ciphertext — enc/kf stay printed).
    const display = e2eOpenEcho(info, payload);
    if (display) raw = display;
  }
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

// The RESPONSE axis (perfis-S2): true when the send carries SOME way for the human
// to answer with a tap — built-in actions, custom actions, or a content --template
// that supplies them. Free-text reply is ALWAYS available, so this is only about
// buttons. `ask` requires it; `approval` injects a default pair when it's absent.
const hasAnswerAffordance = () =>
  v.actions !== undefined || (v['custom-action'] || []).length > 0 || v.template !== undefined;

// The `approval` recipe's default button pair (perfis-S2 follow-up). Sent as
// CUSTOM actions, NOT built-ins: only custom_actions can carry `biometric` (Face
// ID), and a custom id may NOT reuse a built-in id like approve/reject (the server
// 422s "collides with a built-in") — so the ids are grant/deny. Face ID gates the
// consequential "Approve"; "Reject" is the safe (destructive-styled) out. A gated
// action is detail-screen only (no banner buttons — gotcha #19), by design.
const APPROVAL_ACTIONS = [
  { id: 'grant', label: 'Approve', biometric: true, terminal: true },
  { id: 'deny', label: 'Reject', style: 'destructive', terminal: true },
];

// The married catalog of 5 (perfis-S1): one send, stamped with the canonical
// `template_kind` (message/important/urgent/event/live). The RESPONSE axis is
// orthogonal: with `wait:false` it's fire-and-forget (print the raw 201, exit);
// with `wait:true` it mints a cid, sends, and BLOCKS until a terminal answer
// (print chosen_action JSON). `requireAnswerable` gates `ask`. `extra` carries
// raw fields (urgent's escalate:true, approval's injected custom_actions).
async function doTypedSend(kind, { wait = false, extra = {}, requireAnswerable = false, label = kind } = {}) {
  if (!v.title) die('pidge: --title is required', 1);
  // `live` is status-only — it never produces an answer, so --wait would block the
  // full timeout believing the human is deciding. Refuse it (mirror the old ask guard).
  if (wait && (kind === 'live' || v.profile === 'tracking'))
    die(`pidge: \`${label}\`${kind === 'live' ? '' : ' --profile tracking'} can't --wait — ${kind === 'live' ? '`live` is' : 'tracking is'} status-only and never produces an answer (drop --wait, or ask with a real type)`, 1);
  if (requireAnswerable && !hasAnswerAffordance())
    die(`pidge: --actions required for ${label}. Add buttons with --actions yes,no (or approve,reject) or --custom-action id:label.`, 1);

  if (!wait) {
    const { ok, info, raw } = await doNotify({ template_kind: kind, ...extra });
    console.log(raw);
    if (ok && info.correlation_id)
      console.error(`pidge: correlation_id=${info.correlation_id} (use: pidge wait ${info.correlation_id})`);
    process.exit(ok ? 0 : 2);
  }

  // #39: validate the wait knobs BEFORE the send — a typo must die here (exit 1),
  // not hang the poll loop forever nor leave a ghost notification behind a post-send die.
  const timeoutArg = numStrict(v.timeout, '--timeout', NaN);
  const intervalArg = numStrict(v.interval, '--interval', 30);
  // --wait: the cid is minted CLIENT-side when not given, and printed as the FIRST
  // stderr line (greppable) — a killed/crashed wait always leaves the handle behind,
  // so the agent can `pidge wait <cid>` instead of re-sending.
  const cid = v['correlation-id'] || crypto.randomUUID();
  v['correlation-id'] = cid;
  console.error(`pidge: correlation_id=${cid}`);
  const { ok, info } = await doNotify({ template_kind: kind, ...extra });
  if (!ok) process.exit(2);
  console.error(`pidge: sent (${info.registered_devices} device(s)) — waiting on ${cid}`);
  // #132: no --timeout ⇒ obey the template's suggestion from the 201 echo (human
  // decisions take 30-40 min; a 600 s default misreads them as silence). Explicit wins.
  let timeout = timeoutArg;
  if (!Number.isFinite(timeout)) {
    if (info.suggested_ask_timeout) {
      timeout = info.suggested_ask_timeout;
      console.error(`pidge: timeout ${Math.round(timeout / 60)} min — suggested by template ${info.template || v.template} (override with --timeout)`);
    } else if (info.requires_action) {
      timeout = 3600;   // #274/#132: a human decision (buttons present) takes 30-40 min, not 600 s of "silence"
      console.error(`pidge: no template suggestion — defaulting --wait to 60 min for a decision (override with --timeout)`);
    } else {
      timeout = 600;
    }
  }
  await waitForAnswer(cid, { timeout, interval: intervalArg });
}

// `pidge approve` (#34) — a hook-shaped, DENY-DEFAULT permission gate. Sends a
// Face-ID approval and BLOCKS, then maps the human's tap to an exit code: ONLY an
// explicit allow is exit 0; deny, timeout, a dead channel or any ambiguity is
// non-zero (exit 1) so a PreToolUse hook fails CLOSED. A thin wrapper over the
// ask/wait long-poll: it fixes the two gated actions and swaps print-and-exit-0
// for the exit-code mapping (via waitForAnswer's onAnswer/onTimeout).
async function doApprove() {
  const question = parsed.positionals[1] || v.title;
  if (!question)
    die('pidge: usage: pidge approve "<question>" [--body TEXT] [--timeout N] [--allow-label L] [--deny-label L]', 1);
  // #39: a typo in the knobs must die HERE (exit 1, fail-closed), before the
  // approval is even sent — a NaN deadline would hang this gate open forever.
  const timeout = numStrict(v.timeout, '--timeout', 300);
  const interval = numStrict(v.interval, '--interval', 30);
  // #39: an interrupt mid-wait is NOT an approval — exit 1 loudly (deny-default),
  // like every other unanswered path out of this gate.
  process.on('SIGINT', () => {
    console.error('pidge: interrupted before an answer — DENIED (deny-default; nothing was approved). exit 1');
    process.exit(1);
  });
  v.title = question;
  const allowLabel = v['allow-label'] || 'Allow';
  const denyLabel = v['deny-label'] || 'Deny';
  // allow = Face-ID confirm (both confirm+biometric) · deny = destructive out.
  // Both terminal, both gated ⇒ the banner is detail-only (resolve_push_category →
  // HERALD_OPEN): approving is a deliberate in-app Face-ID tap, never a one-tap banner.
  const customActions = [
    { id: 'allow', label: allowLabel, confirm: true, biometric: true, terminal: true },
    { id: 'deny', label: denyLabel, style: 'destructive', terminal: true },
  ];
  const cid = v['correlation-id'] || crypto.randomUUID();
  v['correlation-id'] = cid;
  console.error(`pidge: correlation_id=${cid}`);
  const { ok, info } = await doNotify({ template_kind: 'important', custom_actions: customActions });
  if (!ok) {
    // Couldn't even ask the human ⇒ fail closed. (doNotify already narrated the
    // HTTP failure; a raw network error exits 2 inside doNotify — also non-zero.)
    console.error('pidge: could NOT send the approval — DENIED (deny-default; nothing was approved). exit 1');
    process.exit(1);
  }
  console.error(`pidge: approval sent (${info.registered_devices} device(s)) — waiting on ${cid} (only an explicit "${allowLabel}" is exit 0)`);
  await waitForAnswer(cid, {
    timeout,
    interval,
    onAnswer: (chosen) => {
      console.log(JSON.stringify(chosen, null, 2)); // machine output on stdout
      if (chosen && chosen.action_id === 'allow') {
        console.error('pidge: ALLOWED — the human approved (Face ID). exit 0');
        process.exit(0);
      }
      console.error(`pidge: DENIED — the human chose "${(chosen && chosen.action_id) || '?'}" (deny-default: only an explicit allow is exit 0). exit 1`);
      process.exit(1);
    },
    onTimeout: () => {
      console.log(JSON.stringify({ decision: 'deny', reason: 'timeout', correlation_id: cid }));
      console.error('pidge: no answer before the timeout — DENIED (deny-default; a gate must fail closed). exit 1');
      process.exit(1);
    },
  });
}

// A compat alias (perfis-S1): the OLD type name still works, mapped to the new
// canonical one — a one-line note points at the rename so muscle-memory migrates.
function warnRenamed(oldName, newName) {
  console.error(`pidge: \`pidge ${oldName}\` was renamed → use \`pidge ${newName}\` (the married catalog of 5; the alias keeps working).`);
}

// `pidge notify` / `pidge send` (no type) are deprecated — they still send, and the
// server falls back to the channel default. Prefer a typed send. Warning is local.
function warnDeprecatedSend(name) {
  console.error(`pidge: \`pidge ${name}\` is deprecated — use a TYPE instead: message · important · urgent · event · live (or the ask/approval shortcuts; see \`pidge help\`). It still sends (no template_kind ⇒ the server picks the channel default).`);
}

// Poll GET /notifications/:cid until a TERMINAL answer, print chosen_action JSON to
// stdout, exit 0. A snooze (snooze / reschedule-to-a-time) is non-terminal — it
// re-fires — so keep waiting through it. Exits 3 on timeout.
// Long-poll (#45): each GET carries ?wait=N (≤55 s) and the SERVER holds it until
// the user acts — answer latency ~instant, ~1 request/min. --interval is only the
// fallback pace against an old server that ignores `wait` (returns immediately).
// #34: onAnswer(chosen)/onTimeout() let a caller (approve) MAP the outcome to an
// exit code instead of the default print-chosen+exit-0 / exitTimeout. Both
// callbacks MUST exit the process; when omitted the wait/ask behavior stands.
async function doWait(cid, { timeout, interval, onAnswer, onTimeout } = {}) {
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
      await checkManifestNews(res);
      if (res.status === 200) {
        health.ok();
        const data = await res.json().catch(() => ({}));
        if (data.responded) {
          await e2eOpenChosen(data); // sealed answer → plaintext (gated on data.enc)
          const chosen = data.chosen_action || {};
          if (chosen.kind === 'snoozed') {
            console.error(`pidge: snoozed until ${chosen.snooze_until || chosen.at} — re-fires then, still waiting`);
          } else if (onAnswer) {
            return onAnswer(chosen);
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
      if (onTimeout) return onTimeout();
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
async function realtimeWait(cid, { timeout, interval, onAnswer, onTimeout } = {}) {
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
    // fetch + resolve (print+exit, or the caller's onAnswer/onTimeout mapping) via
    // the poller (one quick authoritative read)
    await doWait(cid, { timeout: Math.max(10, Math.ceil((deadline - Date.now()) / 1000)), interval, onAnswer, onTimeout });
  }
  // Only exit-as-timeout if the REAL deadline genuinely passed. An EARLY
  // 'deadline' (a spurious guard, a WS oddity) must degrade to polling for the
  // remaining budget, NOT exit lying that the full timeout elapsed (#119).
  if (outcome === 'deadline' && Date.now() >= deadline - 1500) {
    if (onTimeout) return onTimeout();
    health.exitTimeout(`no answer on ${cid}`);
  }
  console.error('pidge: realtime unavailable — falling back to HTTP polling (same contract, less instant)');
  return Math.max(1, Math.ceil((deadline - Date.now()) / 1000)); // remaining budget
}

// wait/ask entry: WS when we can, polling as the universal fallback (#118/#119).
// #34: onAnswer/onTimeout thread through to both paths so `approve` can map the
// outcome to an exit code; omit them for the default print-and-exit-0 behavior.
async function waitForAnswer(cid, { timeout, interval, onAnswer, onTimeout } = {}) {
  let budget = timeout;
  if (wantRealtime()) budget = await realtimeWait(cid, { timeout, interval, onAnswer, onTimeout });
  await doWait(cid, { timeout: budget, interval, onAnswer, onTimeout });
}

const num = (val, fallback) => (val !== undefined ? parseInt(val, 10) : fallback);

// #39: STRICT variant for the blocking knobs (--timeout/--interval). parseInt('abc')
// → NaN would make doWait's deadline NaN — never reached — so wait/ask/approve/hello
// would poll FOREVER; on `pidge approve` that turns the deny-default gate into an
// agent hung open. An unparseable value dies IMMEDIATELY (exit 1), before any send.
const numStrict = (val, flag, fallback) => {
  if (val === undefined) return fallback;
  const n = parseInt(val, 10);
  if (!Number.isFinite(n))
    die(`pidge: ${flag} ${JSON.stringify(val)} is not a number of seconds — refusing to wait forever (fail-closed). exit 1`, 1);
  return n;
};

// #51: message-queue ids are STRICT integers. parseInt alone is lazy —
// parseInt("9f2e7c31-…") === 9 — so an agent that pastes a correlation_id where
// the numeric listen id belongs would silently ack messages 1..9 it never
// handled (at-least-once loss, the exact class #39 killed for --timeout).
// Full-string digits or die loud, BEFORE any HTTP.
const idStrict = (val, flag) => {
  const s = String(val).trim();
  if (!/^\d+$/.test(s))
    die(`pidge: ${flag} ${JSON.stringify(val)} is not a numeric message id — it takes the NUMERIC id from listen output, never the correlation_id. exit 1`, 1);
  return parseInt(s, 10);
};

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
  await checkManifestNews(res);
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
    await checkManifestNews(res);
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
  note(`pidge doctor: token found (${source || 'passed in'}) — never displayed`);
  note(`pidge doctor: server ${base}`);
  let out;
  try {
    out = await fetchWhoami(base, token);
  } catch (e) {
    console.error(`pidge doctor: server UNREACHABLE — ${e.message} (check the URL; is it ${base}?)`);
    process.exit(2);
  }
  const { res, data } = out;
  await checkManifestNews(res);
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
  // #52: since server v57 /whoami is either-track — a SESSION token (ses_) gets
  // a 200 with NO channel block. Pre-v57 that misconfig 401ed loudly; without
  // this branch the doctor would print key valid — canal "undefined" and exit 0,
  // hiding the error until the first send 401s.
  if (!data.channel) {
    console.error('pidge doctor: this token is a SESSION token (ses_), not a channel key — the CLI needs the hld_ channel key (Pidge app → Canais → your channel). Sends would 401.');
    console.log(JSON.stringify({ ok: false, reason: 'session_token_not_channel_key' }));
    process.exit(2);
  }
  const devices = data.devices ?? 0;
  note(`pidge doctor: key valid — canal "${data.channel && data.channel.name}" · ${devices} device(s)`);
  if (devices === 0)
    console.error('pidge doctor: WARNING — 0 devices: sends will reach NOBODY until the human installs/opens the Pidge app on their iPhone');
  // #182 device-reach honesty (gotcha #9) + #181 ownership — shared with whoami.
  const unreachable = reportDeviceReach(data);
  reportClaimMismatch(data);
  // E2E (E2-CLI): validate PIDGE_SECRET when present (32 bytes after base64url;
  // kf = base64url(SHA-256(key)[0..3])) and cross-check it against the channel:
  //   e2e_enabled + no secret   → sends go CLEAR-and-marked; point at the app's Connect-screen terminal step
  //   secret + non-E2E channel  → an ORPHAN secret (never used); warn
  //   e2e_enabled + bad/mismatched secret → BROKEN (exit 2): the seal promise can't hold
  const e2e = reportE2eHealth(data);
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
  if (e2e.broken) {
    console.error('pidge doctor: BROKEN (exit 2) — this channel is E2E but the PIDGE_SECRET cannot seal/open anything on it. The app\'s Connect screen shows a separate TERMINAL step that writes PIDGE_SECRET to ~/.config/pidge/env — ask your human to run THAT (never paste the secret in chat), then re-run `pidge doctor`.');
    process.exit(2);
  }
  // #171: probe the realtime path (the #119 failure class an HTTP-only doctor
  // misses). Exit stays 0 either way — an unavailable WS degrades to polling.
  const rt = await probeRealtime(base, token);
  let realtime;
  if (rt.skipped) {
    realtime = 'skipped';
    note('pidge doctor: realtime: skipped — this Node lacks a native WebSocket (need Node ≥22); `listen` will poll. Upgrade Node for instant delivery.');
  } else if (rt.ok) {
    realtime = 'ok';
    note(`pidge doctor: realtime: ok (ws connect + subscribe em ${rt.ms}ms)`);
  } else {
    realtime = 'unavailable';
    note(`pidge doctor: realtime: INDISPONÍVEL — ${rt.reason}. O \`listen\` degrada pra polling (funciona, menos instantâneo); use --no-realtime pra fixar o piso.`);
  }
  // #229: lead with `pidge hello` — the first-contact WOW (send + wait in one),
  // the same debut the /agent-setup guide leads with. (#274: no --template hint —
  // `pidge hello` IS the entry point; the content_template surface is off the menu.)
  // lote-5 #4: --quiet collapses ALL of the above to this single status line.
  if (QUIET)
    console.error(`pidge: ✓ setup ok — canal "${data.channel && data.channel.name}" · ${devices} device(s) · realtime ${realtime} (run \`pidge doctor\` for the full check)`);
  else
    console.error('pidge doctor: all good — try: pidge hello   (first-contact WOW — send + wait in one)');
  console.log(JSON.stringify({ ok: true, base_url: base, channel: data.channel, devices, manifest_version: data.manifest_version, realtime, e2e: { channel: e2e.channelOn, secret: e2e.status, kf: e2e.kf } }));
  process.exit(0);
}

// doctor's E2E block: validate the secret locally, cross it with the channel's
// e2e_enabled (whoami), and — when the server exposes the channel's expected
// fingerprint — compare kfs so a token-of-one-channel + secret-of-another mixup
// is named BEFORE the first garbled send. Returns {status, kf, channelOn, broken}.
function reportE2eHealth(data) {
  const channelOn = !!(data.channel && data.channel.e2e_enabled);
  const raw = e2eLoadSecret();
  const out = { status: 'absent', kf: null, channelOn, broken: false };
  if (!raw) {
    if (channelOn)
      console.error('pidge doctor: WARNING — this channel is E2E (e2e_enabled) but NO PIDGE_SECRET is configured: sends go CLEAR and the app marks them "⚠️ sem criptografia". The app\'s Connect screen shows a separate TERMINAL step that writes PIDGE_SECRET to ~/.config/pidge/env — ask your human to run THAT (never paste the secret in chat); `pidge doctor` then confirms it.');
    return out;
  }
  const source = process.env.PIDGE_SECRET ? 'env var' : 'config file';
  let key;
  try {
    key = e2eParseSecret(raw);
  } catch (e) {
    out.status = 'invalid';
    out.broken = channelOn;
    console.error(`pidge doctor: ${channelOn ? 'BROKEN' : 'WARNING'} — PIDGE_SECRET (${source}) is INVALID: ${e.message}. ${channelOn ? 'Sends go CLEAR on an E2E channel.' : ''} Fix: the app's Connect screen shows a separate TERMINAL step that rewrites PIDGE_SECRET in ~/.config/pidge/env (never paste the secret in chat).`);
    return out;
  }
  out.status = 'ok';
  out.kf = e2eKeyFingerprint(key);
  note(`pidge doctor: e2e secret found (${source}, 32 bytes, kf ${out.kf}) — never displayed`);
  // Compare with the channel's own fingerprint when the server exposes one
  // (additive/forward-compatible — whoami serves only e2e_enabled today).
  const serverKf = data.channel && (data.channel.e2e_kf || data.channel.key_fingerprint);
  if (channelOn && serverKf && serverKf !== out.kf) {
    out.broken = true;
    console.error(`pidge doctor: BROKEN — your PIDGE_SECRET (kf ${out.kf}) is NOT this channel's key (kf ${serverKf}): the token and the secret belong to different channels. Ask your human to run THIS channel's terminal step from the app's Connect screen (never paste the secret in chat).`);
  } else if (channelOn) {
    note('pidge doctor: e2e ON — sends are sealed end-to-end (the server relays ciphertext only)');
  } else {
    console.error('pidge doctor: WARNING — PIDGE_SECRET present but this channel is NOT E2E (secret órfão): sends stay CLEAR and the secret is never used. Either the human turns on E2E for this channel in the app, or drop the secret.');
  }
  return out;
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
    // E2E: the {TOKEN, SECRET} pair travels together from ONE source — when this
    // environment already carries PIDGE_SECRET (the human exported it before
    // running setup), emit it alongside. (#315: the secret comes from the app's
    // Connect-screen terminal step, never from the chat prompt.)
    if (process.env.PIDGE_SECRET) console.log(`export PIDGE_SECRET=${process.env.PIDGE_SECRET}`);
    console.error(`pidge: canal "${channelName}" — modo POR-AGENTE (nada gravado em disco). Cole as duas linhas no ambiente de lançamento DESTE agente (systemd/launcher/cron/profile). Cada agente tem a SUA chave; perdeu, é só pegar outro código no app e re-rodar (a chave do canal é a MESMA). NÃO rode --print de dentro de um agente — a chave apareceria no contexto dele.`);
    await fuseSkillAndHello(finalBase, data.key);
    await runDoctor(finalBase, data.key, 'fresh claim (per-agent env — not stored on disk)');
    return;
  }

  // File path (default): the CLI writes the key — the agent never sees it
  // (#57). Per-agent when PIDGE_AGENT is set; otherwise the legacy shared file.
  // E2E: the {TOKEN, SECRET} pair travels together from ONE source — persist
  // PIDGE_SECRET next to the token when this env already carries it (#315: it
  // gets there via the app's Connect-screen terminal step, never the chat
  // prompt), and never silently DROP a secret the file already held: the human
  // may be re-claiming the same E2E channel with a fresh code.
  const e2eSecret = process.env.PIDGE_SECRET || FILE_ENV.PIDGE_SECRET || null;
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE,
    `PIDGE_URL=${finalBase}\nPIDGE_TOKEN=${data.key}\n${e2eSecret ? `PIDGE_SECRET=${e2eSecret}\n` : ''}`,
    { mode: 0o600 });
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* mode set on create */ }
  note(`pidge: canal "${channelName}" configurado — chave em ${CONFIG_FILE} (chmod 600, nunca exibida)`);
  if (e2eSecret) note('pidge: PIDGE_SECRET stored next to the token (the {TOKEN, SECRET} pair travels together) — E2E sends seal automatically when the channel is E2E');
  // #181: claim ownership of the channel for THIS install and record the
  // generation locally, so a later `pidge doctor` can DETECT a silent key swap
  // by a different agent (the v25 incident, now caught in code). Best-effort.
  const claim = await claimOwnership(finalBase, data.key);
  if (claim) {
    fs.appendFileSync(CONFIG_FILE, `PIDGE_CLAIM_GENERATION=${claim.claim_generation}\nPIDGE_FINGERPRINT=${agentFingerprint()}\n`, { mode: 0o600 });
    note(`pidge: ownership claimed as "${agentLabel()}" (generation ${claim.claim_generation}) — doctor WARNS if another agent takes this channel.`);
  }
  if (!AGENT_ID)
    note('pidge: este é o arquivo COMPARTILHADO (single-agent). Vai rodar 2+ agentes nesta máquina? Dê a cada um PIDGE_AGENT=<id> no launch (arquivo isolado por agente) — senão eles enviam como o mesmo canal.');
  await fuseSkillAndHello(finalBase, data.key);
  await runDoctor(finalBase, data.key, CONFIG_FILE);
}

// #274 F4: setup → skill → hello. Best-effort, run right BEFORE the post-setup
// doctor (runDoctor process.exit()s, so this can't trail it). A skill-install
// failure is ONE stderr line — NEVER a `--help`/USAGE dump (the graceful-degrade
// invariant). `pidge hello` stays a printed NEXT step: we don't auto-fire a push
// the human didn't ask for. base+key are the freshly-claimed ones (the manifest
// is public, so this works even on the --print path where no token is on disk).
async function fuseSkillAndHello(base, token) {
  try {
    const r = await installSkill(base, token);
    note(`pidge: skill written to ${r.file} (manifest v${r.manifest_version}) — your future sessions in this project know Pidge now`);
  } catch (e) {
    console.error(`pidge: skill install skipped (${e.message}) — run \`pidge skill install\` later.`);
  }
  note('pidge: next → `pidge hello` to send your first handshake and watch it confirm on the lock screen.');
}

// skill install (#110e; rewritten #274 F3): persistent Pidge knowledge for AI
// agents — the live manifest's APPENDIX (profiles / notes / exits) wrapped around
// a HAND-AUTHORED, failure-mode-first spine. The dead content_template
// `decision_table` is NEVER pulled again, so even an old manifest can't reinject
// the v46 collision. Non-exiting: RETURNS {file, manifest_version} and THROWS on
// failure, so callers (`skill install` AND the setup fuse) choose die-vs-degrade.
async function installSkill(base = BASE, token = TOKEN) {
  const hdrs = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  let res, m;
  try {
    res = await fetchT(`${base}/api/v1/manifest`, { headers: hdrs });
    m = await res.json();
  } catch (e) {
    throw new Error(`could not read the manifest: ${e.message}`);
  }
  if (res.status !== 200) throw new Error(`manifest read failed (${res.status})`);
  // The ONLY generated parts (the appendix). m.templates.* is deliberately UNREAD.
  const profileTable = (m.profiles && m.profiles.decision_table) || [];
  const notes = m.notes || [];
  const exits = (m.cli && m.cli.output) || '';
  // #33 fix (0.15.3): the self-heal marker rides a `# pidge-skill …` YAML COMMENT INSIDE
  // the frontmatter — it MUST NOT precede the opening `---`. A SKILL.md whose first line
  // isn't `---` fails the YAML frontmatter parse, so Claude Code loads the skill with a
  // GARBAGE description (the HTML comment leaked in as the description, the real one lost)
  // — proven on a live headless run. A `#` comment line is valid YAML and invisible to
  // name/description, so the marker survives without corrupting the load. ensureSkillFresh
  // reads it from this position (and still tolerates the old line-1 marker to heal it).
  const skill = `---
name: pidge
description: Send rich, actionable iPhone notifications to your human and get their decision back (Pidge). Every send is a TYPE (message/important/urgent/event/live) plus an OPTIONAL response (buttons + send-and-go vs wait). Use when finishing long tasks, needing a decision/approval, sending updates with substance, or anything time-anchored. Also covers reading the human's replies back.
# pidge-skill rev=${SKILL_REVISION} manifest=${m.manifest_version}
---

# Pidge — notify your human, get answers back

Generated from manifest v${m.manifest_version} of ${BASE} — re-run \`pidge skill install\` to update (any API response header \`X-Pidge-Manifest-Version\` > ${m.manifest_version} means there's news).

All commands: \`npx pidge-cli …\` (Node ≥18; reads \`~/.config/pidge/env\` — no token in your context). Not set up? Run \`pidge doctor\`. Onboard with \`pidge setup --claim <code>\` (the human copies the code from the Pidge app), then \`pidge hello\`.

## One breath

Every send is **a TYPE + a markdown body + an OPTIONAL response**. The TYPE (one of five) decides how much it may intrude — the human already configured how each arrives. The RESPONSE (buttons? wait or not?) is a second, orthogonal axis. **There is no content "template" to choose.**

## THE PICKER — situation → exact command

| Your situation | Run |
|---|---|
| Just inform — a result/log, no action needed | \`pidge message\` |
| A pendency they should act on (can wait) ⭐ DEFAULT | \`pidge important\` |
| You need a decision and CAN'T proceed without it | \`pidge important --actions yes,no --wait\` |
| YOU are asking for a formal go/no-go (money/risk) | \`pidge approval\` |
| Gate your OWN risky tool behind a human OK (a hook) | \`pidge approve "<question>"\` (exit 0 = allow) |
| A thing with a known TIME | \`pidge event --event-at <ISO8601>\` |
| A live status you'll keep updating | Live Activity endpoints (see **Live progress** below) |
| WAKE them now — rare, real, <1/day | \`pidge urgent\` |

⭐ \`important\` is the default. On the fence between informing and asking, pick \`important\`. \`message\` is only for a true no-action FYI. (\`fyi\`/\`report\`/\`ask\`/\`alert\` still work as silent aliases → message/important/important/urgent.) Run \`pidge <type> --help\` for each one's flags.

## Write for the lock screen (what the human actually sees)

The banner shows your **\`--title\`** and **\`--body\`** (plain text). **\`--body-markdown\` does NOT appear on the banner** — it's the in-app detail screen only. So:
- **Always give a concise \`--body\`** — the one-line human-readable gist. A title-only send can show as an empty banner (just your channel name).
- Put the rich part (tables, lists, code, an image) in **\`--body-markdown\`** (and/or \`--image\`) — the human sees it when they tap in.
- A good send: **title = the answer at a glance · body = the few facts they need to decide/act · body-markdown = the rich detail · ONE ask.** Never ship a title-only notification.
- **A real artifact rides as an attachment, never as pasted text.** A log, xlsx, pdf, csv → \`--file <path>\` (the human gets a Quick Look preview + share/save on the phone); a picture → \`--image <path>\`. One image + one file can ride the same send. Long output (a build log, a report): distilled digest in \`--body-markdown\`, raw thing attached with \`--file\` — never paste hundreds of lines into the markdown.

## Approval has two paths — know which one you're in

**Path A — YOU request it (\`pidge approval\`).** You decided this needs a human sign-off. \`pidge approval\` = \`important\` + an **Approve** (Face-ID gated) / **Reject** pair + \`--wait\`. You send it, you block, and you get \`chosen_action.action_id: "grant"\` (approved) or \`"deny"\` (rejected) back. Use it for money, deletions, irreversible actions.

**Path B — your HUMAN requires it (a profile knob).** In the app, the human can turn ON **"Require approval · Face ID"** on any profile (the \`ack_requires_biometric\` knob — **OFF by default everywhere**). When it's ON for, say, \`important\`, then **every ordinary send on that profile silently becomes an Approve-with-Face-ID decision** — even a plain \`pidge important\` with no buttons. The server injects a single \`approve\` action, so the send reads back \`actions:["approve"], requires_action:true, acknowledgeable:false\`, the banner is detail-only, and **the human's tap reaches you as \`chosen_action.action_id: "approve"\`** (poll / webhook / \`pidge listen --all\`). You didn't ask — they imposed it.

**Same screen ("Approve + Face ID"), opposite origin: you REQUEST (A, ids \`grant\`/\`deny\`) vs they REQUIRE (B, id \`approve\`).** To tell at runtime: a send that comes back \`acknowledgeable:false\` + \`requires_action:true\` when you didn't add buttons means Path B is on for that profile — treat the \`approve\` as the positive decision it is. (To check a profile's knob ahead of time, read \`ack_requires_biometric\` from the live manifest: \`curl $PIDGE_URL/api/v1/manifest -H "Authorization: Bearer $PIDGE_TOKEN"\` → \`profiles\`.) Caution: Path B on a busy profile means one approval per send — the human's deliberate high-trust choice.

**\`pidge approve "<question>"\` — the hook-shaped gate (for permission hooks).** When YOU need the human to authorize one of YOUR OWN risky actions before you take it — and you want the answer as an EXIT CODE, not JSON to parse — use \`pidge approve\`. It sends a Face-ID allow / deny pair, blocks, and is **DENY-DEFAULT: exit 0 ONLY on an explicit allow; deny, timeout, or a broken channel → non-zero.** Perfect for a Claude Code \`PreToolUse\` hook that must fail CLOSED (see \`pidge approve --help\` for a runnable hook). \`pidge approval\` is the JSON-answer sibling (Path A); \`pidge approve\` is the exit-code gate.

## The response axis (composes on ANY type)

Asking for a reply is orthogonal to the type — you don't need \`approval\` to get a button.
- **Free text** is always available; the human can write back on anything.
- **Buttons** — reach for a BUILT-IN catalog action FIRST; they're tappable right on the lock-screen banner. Decisions: \`--actions yes,no\` · \`approve,reject\` · \`accept,decline\` · \`later\`; plus \`done\`, \`snooze\`, \`reply\`. Use \`--custom-action id:label\` ONLY when none fit — **custom labels (and any destructive/Face-ID action) render detail-only**, so the human must open the app to answer instead of tapping the banner.
- **Face ID** on a consequential action: \`--gated\` injects one confirm-with-Face-ID button (use it for money/deletion). It does NOT change loudness — pair with a louder profile if it must also be loud. A flag, not a type.
- **send-and-go vs wait** — the choice that decides how YOU work:
  - *send-and-go* (default): fire and continue; the answer arrives later in \`pidge listen --all\`.
  - *wait*: \`--wait\` (or \`pidge ask\`) **blocks** until they tap. Use it when you can't proceed.
- **Exit codes on a \`--wait\`/\`ask\`:** \`0\` = answered (\`chosen_action\` JSON on stdout) · **\`3\` = no answer yet → NOT a failure** (back off, or treat a blocking go/no-go as "no/hold" and re-ask later) · \`2\` = error.

Need a TYPED reply (a time/value/name)? \`--actions reply\` ALONE — never a decision + \`reply\` together (the human taps the easy button and you get a useless "Yes"). The CLI now **refuses** \`yes,no,reply\` (exit 1) so you can't ship the trap by accident. ONE question per send.

## Live progress (a status card you update in place)

For a long job whose progress the human wants to GLANCE at, you have two honest paths:
- **Live Activity (the real lock-screen card):** three HTTP endpoints; the handle is YOUR
  \`correlation_id\` (re-POST = upsert; PATCH updates in place). **ALWAYS end it** — an orphan
  card stuck at "stage 3/4" is slop.
  \`\`\`bash
  curl -X POST $PIDGE_URL/api/v1/live_activities -H "Authorization: Bearer $PIDGE_TOKEN" \\
    -H "Content-Type: application/json" \\
    -d '{"correlation_id":"backfill-1","title":"Backfill","status":"Stage 1/4","progress":0.25}'
  curl -X PATCH $PIDGE_URL/api/v1/live_activities/backfill-1 -H "Authorization: Bearer $PIDGE_TOKEN" \\
    -H "Content-Type: application/json" -d '{"status":"Stage 3/4","progress":0.75}'
  curl -X POST $PIDGE_URL/api/v1/live_activities/backfill-1/end -H "Authorization: Bearer $PIDGE_TOKEN" \\
    -H "Content-Type: application/json" -d '{"status":"Done ✓","progress":1,"done":true}'
  \`\`\`
- **Lighter: ONE \`pidge message\` re-sent with the same \`--collapse-key\`** — each update replaces
  the previous banner (1 slot, not N pings).
Heads-up: \`pidge live\` as a SEND silently degrades today — the server treats the bare type as a
default and delivers a normal \`message\`-profile 201 (check \`profile\` in the echo); **no card ever
starts**. Use the endpoints above (\`$PIDGE_URL\`/\`$PIDGE_TOKEN\` live in \`~/.config/pidge/env\` if you
set up via claim — source it before curling). Either path: a live surface never answers (no
\`--wait\`); if the finished job leaves a pendency, that's a separate \`important\` at the end.

## Anti-slop rules (judgment a recipe can't teach)

1. **One send = one fact = one ask.** Never two questions in a notification.
2. **Default to \`important\`.** \`message\` only for true no-action FYIs; \`urgent\` is a contract, not a volume knob — **<1/day**, abuse caps your channel.
3. **There is no content-template menu.** Every send is type + markdown + optional buttons. If you're reaching for \`--template context/report/digest/sensitive\`, stop — that surface is gone (the field still parses as silent back-compat, but don't teach or rely on it).
4. **Typed answer? \`--actions reply\` ALONE** — never a decision + \`reply\` together (the CLI refuses it, exit 1).
5. **Trust the 201 echo over your intent** — \`degraded\`/\`render_mode\`/\`registered_devices\`. \`registered_devices:0\` ⇒ it went nowhere; ABORT a blocking \`--wait\` on it (kill it, don't let it burn its timeout) and run \`pidge doctor\`.
6. **Don't spam to signal importance.** Consolidate into one markdown body; use \`--collapse-key\` for self-replacing progress, \`--thread\` only for follow-ups over time.
7. **Be listening when the answer lands, or you lose it.** Ack only AFTER the work is durably done.
8. **English only, phone-friendly markdown.** Narrow tables (they render), no emoji-spam.
9. **Banner-first + catalog-first.** Give a real \`--body\` (the banner shows title+body, never body-markdown), and fit decisions into a catalog action (\`yes,no\`/\`approve,reject\`) before inventing a custom label (custom = a tap-through, not a banner tap).

## Gold examples (full commands)

Pendency with a real table → \`important\`:
\`\`\`bash
pidge important --title "Weekly metrics ready" \\
  --body "Signups 1,204 (+8%) · churn 1.9% (−0.3pp) · table inside" \\
  --body-markdown $'| Metric | This week | Δ |\\n|---|---|---|\\n| Signups | 1,204 | +8% |\\n| Churn | 1.9% | −0.3pp |' \\
  --actions reply
\`\`\`

Blocking decision → ask→wait loop (handle exit 3):
\`\`\`bash
pidge important --title "Run the schema migration?" \\
  --body "Drops legacy_orders (412k rows), not reversible. Safe mid-deploy?" \\
  --body-markdown "Dropping \\\`legacy_orders\\\` (412k rows, archived 2025). **Not reversible.** Safe to run mid-deploy?" \\
  --actions yes,no --wait --timeout 3600
# exit 0 → read chosen_action.action_id (yes|no); exit 3 → no answer, treat as NO / hold, re-ask
\`\`\`

Agent-initiated approval (money) → \`pidge approval\`:
\`\`\`bash
pidge approval --title "Place \\$4,200 purchase order?" \\
  --body "Acme · PO #4471 · \\$4,200 — moves real money" \\
  --body-markdown "Vendor: Acme · PO #4471 · **\\$4,200**, moves real money." \\
  --wait --timeout 3600
# = important + Approve(Face ID)/Reject + wait; chosen_action.action_id: grant|deny
\`\`\`

Time-anchored → \`event\` (needs \`--event-at\` in the human's tz):
\`\`\`bash
pidge event --event-at "2026-06-30T15:00:00-03:00" --title "Call with accountant" \\
  --body "3pm tomorrow with the accountant"
\`\`\`

Long markdown without shell-quoting pain → pipe it:
\`\`\`bash
generate_report | pidge important --title "Report ready" \\
  --body "Q2 report ready — revenue, churn, and 3 risks inside" --body-markdown-file - --actions reply
\`\`\`

## Gotchas we already paid for

- **There is no \`pidge reply\`.** \`reply\` is a built-in action id, not a command. To answer the human's composer message, send a normal \`pidge message --thread <id>\` reusing the message's \`thread_id\`.
- **\`urgent\` is a trust contract, not a button.** It arms an AlarmKit alarm; once delivered you **cannot abort it** (\`pidge cancel\` → 409). Real + unpostponable only, <1/day. Never test it without warning the human.
- **A 201 ≠ "seen."** \`registered_devices:0\` goes nowhere; \`delivered\` is APNs dispatch, not eyes; only \`seen_at\`/an answer is the human.
- **The ask reply-vs-yes/no trap.** \`--actions yes,no,reply\` let the human dodge a typed answer with one tap — so the CLI now REFUSES a decision + \`reply\` in one send (exit 1). Use \`--actions reply\` alone when you need text.
- **\`event\` is quiet today** — \`event --event-at\` schedules; the countdown LA-as-primitive is still being built.
- **content_template still parses as input** (back-compat) but is OFF the menu — if a legacy habit sends \`--template report\`, it silently maps; don't rely on it, don't teach it.
- **The banner ≠ the detail screen.** Lock-screen banner = \`title\` + \`body\` (plain). \`body_markdown\`/images render only when the human taps in. A send with only \`--title\` can look empty on the lock screen — always include a \`--body\`.

## How it intrudes (profiles — the human owns them)

${profileTable.map((r) => `- ${r}`).join('\n')}

## The contract

${notes.map((n) => `- ${n}`).join('\n')}

## Getting answers

- \`pidge ask …\` blocks and prints \`chosen_action\` JSON; \`pidge wait <cid>\` blocks on an existing send.
- \`pidge listen\` blocks until the human MESSAGES you from the app (composer) — run it when idle.
- **A pending notification's answer does NOT surface in plain \`pidge listen\`** (messages only).
  To collect the answer to a question you already sent: \`pidge wait <cid>\` (you printed the cid
  on stderr at send time) or \`pidge listen --all\` (replies + messages). Park the cid, never re-send.
- ${exits}

## Stay "always-on" while you're turn-based

A turn-based agent (Claude Code, anything invoked on demand) stays COMMANDABLE without a daemon:
- **Active session:** \`pidge listen --follow --timeout 300\` holds for 5 min, printing messages as they arrive. \`--follow\` traps the turn — use it only when you intend to sit and wait.
- **Supervisor poll (24/7):** a cron/systemd timer invokes you every N min; each tick runs ONE one-shot \`pidge listen --all --timeout 50\` (block up to 50s, print, exit 0; exit 3 = nothing this tick — the \`--all\` ear also catches answers to questions you fire-and-forgot), do the work, \`pidge ack --up-to <id>\`, sleep. \`--timeout\` is always SECONDS. Do NOT background \`pidge listen\` with \`&\`.

## Full spec

\`curl $PIDGE_URL/api/v1/manifest -H "Authorization: Bearer $PIDGE_TOKEN"\` — the always-current contract (fields, profiles, custom actions, media, threads, realtime).

${SKILL_END_MARKER}
`;
  const dir = path.join(process.cwd(), '.claude', 'skills', 'pidge');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  // #38: never clobber silently — the installed skill may have been customized.
  // When the file being replaced differs from what we're writing, keep the old
  // content as SKILL.md.bak and say so in one stderr line.
  const bak = path.join(dir, 'SKILL.md.bak');
  let previous = null;
  try { previous = fs.readFileSync(file, 'utf8'); } catch { /* no existing file */ }
  if (previous !== null && previous !== skill) {
    fs.writeFileSync(bak, previous);
    console.error(`pidge: the previous SKILL.md differed from the regenerated one — saved to ${bak}`);
  }
  // #38: ATOMIC replace — write a per-process tmp, then rename. A killed process or
  // a full disk leaves the OLD skill intact instead of a torn file whose surviving
  // marker reads as "fresh" (the 0.15.2→0.15.3 corruption class, one version on);
  // concurrent heals each rename a WHOLE file (last one wins), never interleaved bytes.
  const tmp = path.join(dir, `.SKILL.md.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`);
  try {
    fs.writeFileSync(tmp, skill);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw e;
  }
  return { file, manifest_version: m.manifest_version };
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
      await checkManifestNews(res);
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
      let r;
      try { r = await installSkill(); } catch (e) { die(`pidge: ${e.message}`, 2); }
      console.error(`pidge: skill written to ${r.file} (manifest v${r.manifest_version}) — your future sessions in this project know Pidge now`);
      console.log(JSON.stringify({ ok: true, file: r.file, manifest_version: r.manifest_version }));
      process.exit(0);
    }
    // === AXIS 1 — the married catalog of 5 (perfis-S1/S2). Each stamps the
    // canonical template_kind. AXIS 2 (response) is orthogonal: --actions/
    // --custom-action add buttons, --wait blocks on the answer (else fire-and-
    // forget). notify/send = the deprecated typeless path; ask/approval = the
    // two shortcuts that bundle a type + response. ===
    case 'message':
      await doTypedSend('message', { wait: !!v.wait });
      break;
    case 'important':
      await doTypedSend('important', { wait: !!v.wait });
      break;
    case 'urgent':
      // --escalate ⇒ escalate:true (ask the Urgente profile for an AlarmKit alarm
      // that breaks through silent/Focus; the human's profile still decides).
      await doTypedSend('urgent', { wait: !!v.wait, extra: v.escalate ? { escalate: true } : {} });
      break;
    case 'event': {
      // event needs a TIME — validate locally (ISO8601) so the agent fails fast
      // instead of taking the server's event_at_required 422 round-trip.
      if (v['event-at'] === undefined)
        die('pidge: --event-at required for event. Use ISO8601: --event-at 2026-06-26T14:00-03:00', 1);
      if (Number.isNaN(Date.parse(v['event-at'])))
        die(`pidge: --event-at ${JSON.stringify(v['event-at'])} is not a valid ISO8601 datetime. Use e.g. --event-at 2026-06-26T14:00-03:00`, 1);
      await doTypedSend('event', { wait: !!v.wait });
      break;
    }
    case 'live':
      // status-only — pass --wait through so doTypedSend REFUSES it loudly (it
      // never produces an answer); without --wait it's fire-and-forget.
      await doTypedSend('live', { wait: !!v.wait });
      break;
    // --- compat aliases (perfis-S1): old type names → the new canonical 5. They
    // map to the new template_kind and still honor --wait/--actions, so scripts
    // and muscle-memory keep working; a one-line note points at the new name.
    case 'fyi':
      warnRenamed('fyi', 'message');
      await doTypedSend('message', { wait: !!v.wait, label: 'fyi' });
      break;
    case 'report':
      warnRenamed('report', 'important');
      await doTypedSend('important', { wait: !!v.wait, label: 'report' });
      break;
    case 'alert':
      warnRenamed('alert', 'urgent');
      await doTypedSend('urgent', { wait: !!v.wait, extra: v.escalate ? { escalate: true } : {}, label: 'alert' });
      break;
    // `approval` = the RECIPE (perfis-S2 follow-up): important + Approve/Reject
    // (Face ID on Approve) + --wait. A shortcut for an explicit go/no-go; the human
    // can override the pair with their own --actions/--custom-action.
    case 'approval': {
      const extra = hasAnswerAffordance() ? {} : { custom_actions: APPROVAL_ACTIONS };
      await doTypedSend('important', { wait: true, extra, label: 'approval' });
      break;
    }
    // #34 — the hook-shaped, deny-default permission gate (allow→0, everything
    // else→non-zero). See doApprove + `pidge approve --help` (PreToolUse example).
    case 'approve': {
      await doApprove();
      break;
    }
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
      if (v.title === undefined) v.title = 'Your agent is ready 🐦';
      if (v.body === undefined) v.body = 'Tap Done ✓ to confirm you received me — proves the round-trip works.';
      // #39: validate the knobs BEFORE the send — a typo dies here (exit 1) instead
      // of hanging the handshake forever on a NaN deadline.
      const timeoutArg = numStrict(v.timeout, '--timeout', NaN);
      const intervalArg = numStrict(v.interval, '--interval', 30);
      const cid = v['correlation-id'] || crypto.randomUUID();
      v['correlation-id'] = cid;
      console.error(`pidge: correlation_id=${cid}`);
      const { ok, info } = await doNotify();
      if (!ok) process.exit(2);
      console.error(`pidge: WOW sent (${info.registered_devices} device(s)) — watch the lock screen narrate the handshake; waiting for your human to confirm on ${cid}`);
      // No --timeout ⇒ obey the template's suggestion from the 201 echo (onboarding
      // = 3600 s); explicit --timeout always wins.
      let timeout = timeoutArg;
      if (!Number.isFinite(timeout)) timeout = info.suggested_ask_timeout || 3600;
      await waitForAnswer(cid, { timeout, interval: intervalArg });
      break;
    }
    case 'ask': {
      // `ask` = the preserved shortcut: important + --wait + REQUIRES a way to
      // answer. There is no `ask` TYPE in the married catalog (manifest v40+) —
      // asking is "a type + buttons + wait". The legacy alias keeps working because
      // it always ships with buttons. `live`/tracking is refused (it never answers).
      await doTypedSend('important', { wait: true, requireAnswerable: true, label: 'ask' });
      break;
    }
    case 'wait': {
      const cid = parsed.positionals[1];
      if (!cid) die('pidge: usage: pidge wait <correlation_id> [--timeout N] [--interval N]', 1);
      // #39: strict — a NaN deadline would make this wait eternal (fail-closed instead)
      await waitForAnswer(cid, { timeout: numStrict(v.timeout, '--timeout', 300), interval: numStrict(v.interval, '--interval', 30) });
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
      await checkManifestNews(res);
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
      // #51: strict ids — a lazy parse here silently acks the wrong watermark
      // (and the old .filter(Number.isFinite) silently DROPPED bad ids).
      if (v['up-to'] !== undefined) ackBody.up_to = idStrict(v['up-to'], '--up-to');
      else if (v.ids !== undefined) ackBody.ids = v.ids.split(',').map((s) => idStrict(s, '--ids'));
      else die('pidge: usage: pidge ack --up-to <id> | --ids a,b [--renew]', 1);
      if (v.renew) ackBody.state = 'delivered';
      let res, raw;
      try {
        res = await fetch(`${BASE}/api/v1/messages/ack`, { method: 'POST', headers, body: JSON.stringify(ackBody) });
        raw = await res.text();
      } catch (e) {
        die(`pidge: ack failed (network): ${e.message}`, 2);
      }
      await checkManifestNews(res);
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
      await checkManifestNews(res);
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
        // E2E: the index is a raw passthrough by design — sealed rows echo YOUR
        // OWN envelopes as stored. Say so instead of letting it read as garbage.
        const sealed = rows.filter((r) => r.enc).length;
        if (sealed)
          console.error(`pidge: ${sealed} of them are E2E-sealed — the index echoes your envelopes as stored (ciphertext); \`pidge wait <cid>\` decrypts an answer, the app shows plaintext`);
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
      // #39: strict — same class as wait/ask/approve: a NaN deadline never ends
      const timeout = numStrict(v.timeout, '--timeout', 600);
      const listenInterval = numStrict(v.interval, '--interval', 5);
      const listenStartedAt = Date.now();
      let deadline = Date.now() + timeout * 1000;
      const queueQs = v.all ? '?all=true' : '';
      // lote-5 #5: the FIRST batch that comes back QUICKLY was already sitting in
      // the queue when this listen started — with --all that includes answers to
      // EARLIER notifications, which read as "new" if we don't say otherwise. A
      // batch that arrives after a real hold (a long-poll that waited) is fresh.
      const BACKLOG_WINDOW_MS = 5000;
      let firstBatch = true;
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
      const printAndAck = async (msgsRaw) => {
        // E2E: open sealed rows BEFORE anything prints (stdout JSON and the
        // stderr narration below both read the decrypted values — a row we
        // can't open is blanked with a precise e2e_error, never base64).
        const msgs = msgsRaw.map(e2eOpenMessageRow);
        console.log(JSON.stringify(msgs, null, 2));
        // lote-5 #5: heads-up on ORPHANED backlog served on the first quick read
        // (--all only). It's within-channel — NOT the cross-channel leak (#289).
        if (v.all && firstBatch && (Date.now() - listenStartedAt) < BACKLOG_WINDOW_MS) {
          const replies = msgs.filter((m) => m.kind === 'notification_reply').length;
          const detail = replies ? ` (${replies} of them are answers to EARLIER notifications)` : '';
          console.error(`pidge: --all — ${msgs.length} message(s) were ALREADY queued when this listen started${detail}: OLD backlog (sent while you weren't listening), NOT fresh arrivals. This is your OWN channel's backlog, not a cross-channel leak (#289).`);
        }
        firstBatch = false;
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
            await checkManifestNews(res);
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
          await checkManifestNews(res);
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
        const pace = health.degraded ? DEGRADED_INTERVAL_S : listenInterval;
        if (Date.now() - askedAt < 2000) {
          await sleep(Math.min(pace, Math.max(1, Math.ceil((deadline - Date.now()) / 1000))) * 1000);
        }
      }
      break;
    }
    default:
      // Name the bad command and point at the married catalog + the two response
      // shortcuts (a friendlier landing than dumping the whole USAGE on a typo).
      die(`pidge: unknown subcommand '${command}'. Types: message · important · urgent · event · live (response: --actions/--wait, or the ask/approval shortcuts). pidge --help`, 1);
  }
})();
