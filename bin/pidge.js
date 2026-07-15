#!/usr/bin/env node
'use strict';
//
// pidge — CLI so an agent (a running Claude Code, or any agent with a shell) can send a rich
// iPhone notification AND block until the human answers (polling — the primary
// read path for terminal/CLI use, where there's no webhook to receive a reply).
//
//   export PIDGE_URL=https://api.pidge.sh          # default http://localhost:3000
//   export PIDGE_TOKEN=hld_xxx                     # the channel's bearer key
//   (HERALD_URL / HERALD_TOKEN are legacy env names, still honored as a
//    fallback; with no env vars set, ~/.config/pidge/env — KEY=VALUE — is read
//    instead, so the key can live OUTSIDE the agent's chat/context entirely)
//
//   TWO AXES: (1) the TYPE — one married list of 5 the
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
//   # cancel a still-scheduled notification before it fires
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

// Per-agent isolation (a real incident: a shared config file made one agent's
// setup hijack another's cron): ~/.config/pidge/env is one slot per
// machine-user, so N agents sharing a HOME share an identity. The fix is a NON-secret namespacing var the
// human sets ONCE at each agent's launch: PIDGE_AGENT=<id> → the config lives
// at ~/.config/pidge/agents/<id>/env, isolated by construction. The CLI still
// WRITES the key (the agent never sees it — token hygiene intact), it's just
// per-agent now. No PIDGE_AGENT ⇒ the legacy shared file (single-agent only).
// (An explicit PIDGE_TOKEN env var still wins over any file — the purest
// per-agent path.)
const AGENT_ID = (process.env.PIDGE_AGENT || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
function pidgeConfigDir() {
  const base = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'pidge');
  return AGENT_ID ? path.join(base, 'agents', AGENT_ID) : base;
}

// token hygiene: when the env vars are unset, fall back to the config file
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
// Execution attribution: the per-run bearer SIGNS every agent-track call
// (header `x-pidge-run`) so the human sees WHICH execution spoke. It is ENV-ONLY
// on purpose — a run is a disposable, per-execution signature, NEVER a stored
// credential (it must never land in the config file the way TOKEN does; a stale
// run token in FILE_ENV would mis-sign a later, unrelated session). Advisory
// everywhere: an expired/invalid token degrades to unsigned, never a 401.
const RUN_TOKEN = process.env.PIDGE_RUN_TOKEN || null;

// Config paths are computed EARLY (multi-runtime v2): the per-request
// agent fingerprint hashes CONFIG_FILE, and the shared `headers` const stamps
// that fingerprint on every call — so both must exist before line-863's headers.
const CONFIG_DIR = pidgeConfigDir();
const CONFIG_FILE = path.join(CONFIG_DIR, 'env');

function die(msg, code = 1) { console.error(msg); process.exit(code); }
// NB: the TOKEN requirement is enforced AFTER help/usage handling (below) — a
// first-time `npx pidge-cli --help` must work without any setup.

// ---------------------------------------------------------------------------
// E2E crypto — wire format v1 (shared with the server and the iOS app; test
// vectors in test/e2e_vectors.json).
// AES-256-GCM · 32-byte per-channel key · ONE independent envelope per field:
//   field envelope  "v1:" + base64url( nonce(12) || ciphertext || tag(16) )
//   blob framing    [0x01][nonce 12B][ciphertext][tag 16B]  (binary, no base64)
//   AAD             "ch<channel_id>:<correlation_id>:<field_name>"    (ASCII)
//   kf              base64url(SHA-256(key)[0..3])    (4-byte key fingerprint)
// This section is the PURE functions + the shared fixture (test/e2e_vectors.json)
// ONLY — the send/receive integration lives further down in the wire layer.
// The nonce parameter exists ONLY for the deterministic
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

// Action ids whose LABELS must NEVER be sealed: the server's 12
// built-ins + the system ids "dismiss"/"acknowledge"/"seen" ("seen"
// is the app's opened-signal: the server intercepts it, so a custom
// "seen" button never reaches the agent; newer servers 422 it).
// Mirrors the server's reserved action-id list and the iOS app's builtin set,
// both of which SKIP label decrypt for these ids — a sealed label on one would
// render raw "v1:…" on the button. Built-in ids ride CLEAR everywhere (the
// action contract runs on ids); only CUSTOM labels are sealed. Newer servers
// 422 a custom action with one of these ids anyway — this is the
// fail-safe for older servers.
const E2E_NEVER_SEAL_LABEL_IDS = new Set([
  'snooze', 'done', 'reschedule', 'mute', 'reply',
  'yes', 'no', 'approve', 'reject', 'accept', 'decline', 'later',
  'dismiss', 'acknowledge', 'seen',
]);

// ---------------------------------------------------------------------------
// Test seam: require()ing this file exports the pure e2e helpers and
// stops HERE — none of the CLI machinery below (parseArgs, the TOKEN check,
// command dispatch) may run under a test runner's argv. Executed as a binary
// (require.main === module) it skips the export and runs the CLI unchanged.
// ---------------------------------------------------------------------------
if (require.main !== module) {
  module.exports = {
    e2eAad, e2eKeyFingerprint, e2eLoadSecret, e2eParseSecret,
    e2eEncryptField, e2eDecryptField, e2eEncryptBlob, e2eDecryptBlob,
    E2E_NEVER_SEAL_LABEL_IDS, e2ePinKeyFor,
    // sealed media — the pure halves (gate decision + filename hygiene).
    e2eMediaSealDecision, sanitizeAttachmentName,
  };
  return;
}

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  title: { type: 'string' },
  body: { type: 'string' },
  'body-markdown': { type: 'string', short: 'm' },
  'body-markdown-file': { type: 'string' },   // a path, or "-" to read stdin
  subtitle: { type: 'string' },
  template: { type: 'string' },                // content/action pattern (manifest `templates`)
  profile: { type: 'string' },                 // delivery profile id (manifest `profiles`)
  'event-at': { type: 'string' },              // WHEN the thing happens (profile event)
  'lead-minutes': { type: 'string' },          // notify/countdown lead before event_at
  urgency: { type: 'string' },                 // normal | persistent | alarm (low-level — prefer --profile)
  escalate: { type: 'boolean' },               // alert type — force an AlarmKit alarm (escalate:true)
  gated: { type: 'boolean' },                  // one Face-ID confirm action (replaces content_template:sensitive)
  image: { type: 'string' },                   // banner+feed image: local path → uploaded; URL → as-is
  file: { type: 'string' },                    // real artifact (xlsx/pdf/csv…): local path → uploaded
  url: { type: 'string' },                     // deep link the app opens on tap
  copy: { type: 'string' },                    // tap-to-copy value on the detail
  actions: { type: 'string' },                 // comma list from the catalog
  'custom-action': { type: 'string', multiple: true }, // id:label[:destructive][:confirm][:biometric][:terminal]
  'deliver-at': { type: 'string' },
  'reply-to': { type: 'string' },
  'correlation-id': { type: 'string' },
  thread: { type: 'string' },                  // conversation handle — same id ⇒ one strand on the phone
  after: { type: 'string' },                   // decision queue: held until this cid resolves
  'collapse-key': { type: 'string' },
  param: { type: 'string', multiple: true },   // key=value escape hatch → raw /notify field
  download: { type: 'boolean' },               // save CLEAR inbound attachments too (sealed ones always save)
  'no-download': { type: 'boolean' },          // catchup: don't fetch/unseal attachments (digest implies it)
  'download-dir': { type: 'string' },          // where attachments land (default <config dir>/downloads)
  note: { type: 'string' },                    // /notify sent_note — WHY this runtime sent it (clear metadata, no secrets)
  timeout: { type: 'string' },
  interval: { type: 'string' },
  // The response axis: --wait blocks until the human answers (composes on
  // ANY type — send-and-go vs wait). ask/approval imply it.
  wait: { type: 'boolean' },
  // inbox flags
  pending: { type: 'boolean' },
  // inbox uses `--summary` as a valueless BOOLEAN (counts+latency). The
  // `ack` command needs `--summary "<what you did>"` as a STRING. One global
  // OPTIONS map can't be both, so this stays boolean (for inbox) and the `ack`
  // case RE-PARSES its own argv with `summary` typed as a string — otherwise the
  // global parse would swallow the value as a stray positional (a silent no-op on
  // an attribution field, the worst failure mode).
  summary: { type: 'boolean' },
  all: { type: 'boolean' },
  limit: { type: 'string' },
  before: { type: 'string' },                  // catchup: page older than this message id
  since: { type: 'string' },                   // catchup: incremental cursor — only ids > this
  digest: { type: 'boolean' },                 // catchup: one condensed line per message
  // realtime: WS by default when the runtime has a WebSocket (Node ≥22)
  realtime: { type: 'boolean' },               // force WS (warn+fallback if unavailable)
  'no-realtime': { type: 'boolean' },          // polling only
  'quiet-nag': { type: 'boolean' },            // silence the manifest-version nag for this run
  // onboarding v2
  claim: { type: 'string' },                   // setup --claim <single-use code>
  // listen keeps going after a batch (supervisor loop, one process)
  follow: { type: 'boolean' },
  force: { type: 'boolean' },                  // setup: overwrite a config owned by ANOTHER channel
  print: { type: 'boolean' },                  // setup: print export lines instead of writing a file (per-agent, human runs it)
  'listen-mode': { type: 'string' },           // setup: declare operating_contract listen mode (turn_based|always_on; default turn_based)
  target: { type: 'string' },                  // skill install: claude (default) | agents | gemini — same content, different destination file
  // Read-receipt split — `ack` after the work; listen no longer consumes on read.
  'up-to': { type: 'string' },                 // ack: process messages up to this id
  ids: { type: 'string' },                     // ack: process this comma-list of ids
  renew: { type: 'boolean' },                  // ack: heartbeat the visibility-timeout lease (state=delivered)
  'ack-on-read': { type: 'boolean' },          // listen: restore the pre-0.9 immediate-consume
  window: { type: 'string' },                  // selftest: reachability window in seconds (default 30)
  exec: { type: 'string' },                    // bridge: the handler command (ONE invocation per batch)
  'handler-timeout': { type: 'string' },       // bridge: max seconds ONE handler run may take (default 1800)
  // approve: the two gated-action labels (default Allow / Deny)
  'allow-label': { type: 'string' },
  'deny-label': { type: 'string' },
  // Collapse `setup` onboarding to a single status line (the full
  // doctor stays the default; --quiet is opt-in, never the default).
  quiet: { type: 'boolean' },
  // The `pidge live` verb drives the REAL Live
  // Activity endpoints (status center) — no more silent degrade to /notify.
  status: { type: 'string' },                  // live: short status line on the card
  symbol: { type: 'string' },                  // live: SF Symbol name
  detail: { type: 'string' },                  // live: small trailing value
  progress: { type: 'string' },                // live: 0..1 → progress bar
  step: { type: 'string' },                    // live: "3/5" sugar → progress + fraction label
  'ends-at': { type: 'string' },               // live: ISO8601 → native countdown (server concludes at zero)
  'starts-at': { type: 'string' },             // live: ISO8601 → elapsed count-up
  paused: { type: 'boolean' },                 // live: is_running=false (pause the timer)
  resume: { type: 'boolean' },                 // live: is_running=true (resume the timer)
  dedicated: { type: 'boolean' },              // live: own device card (budget 2 — over budget degrades loudly)
  end: { type: 'boolean' },                    // live: end the entry (shows done + outcome, lingers, leaves)
  outcome: { type: 'string' },                 // live --end: the line shown next to the ✓
  linger: { type: 'string' },                  // live --end: seconds the final snapshot stays (default 30)
  // execution attribution — `pidge run start` knobs (+ `--json` raw body).
  mode: { type: 'string' },                    // run start: interactive | poll | bridge | custom (default custom)
  role: { type: 'string' },                    // run start: main | worker | subagent (display-only)
  label: { type: 'string' },                   // run start: the friendly execution label (default agentLabel())
  'parent-seal': { type: 'string' },           // run start: a subagent points its parent run's seal
  ephemeral: { type: 'boolean' },              // run start: a disposable, per-message execution
  ttl: { type: 'string' },                     // run start: sliding TTL in seconds → ttl_seconds
  json: { type: 'boolean' },                   // run start: print the raw server body instead of the export lines
  'no-defer': { type: 'boolean' },             // bridge: turn OFF the polite poller (never defer to an interactive run)
};

const USAGE = `pidge — send an iPhone notification to a human and block until they answer.

USAGE
  pidge setup --claim CODE [--url BASE]   one-shot onboarding: exchange the single-use
                                          code for the channel key, store it, run doctor.
                                          MULTI-AGENT: set PIDGE_AGENT=<id> at each agent's launch
                                          → isolated config ~/.config/pidge/agents/<id>/env.
                                          --print  emit 'export PIDGE_TOKEN=…' instead of a file
                                                   (you run it in YOUR terminal; paste into the
                                                   agent's launcher — never run --print as an agent)
                                          --force  overwrite a shared file owned by another channel
                                          --listen-mode turn_based|persistent|external_daemon
                                                   declare how you operate (default turn_based)
  pidge doctor                            validate the setup WITHOUT exposing secrets:
                                          env source, server, key, "canal X · N devices"
  pidge whoami                            which channel does this key speak for (JSON)
  pidge hello  [options]                  FIRST-CONTACT WOW: your channel's debut handshake,
                                          narrated LIVE on the lock screen by a 3-stage Live Activity
                                          (Conectando → toque para confirmar → Concluído ✓). send + wait
                                          in one — run it as your FIRST contact on a fresh channel.
  AXIS 1 — TYPE (the married list of 5; the human configured how each arrives):
  pidge message   [options]               just inform, no action — clears when the human OPENS it
  pidge important [options]  ⭐DEFAULT     a pendency the human should resolve ("waiting-for-you" card)
  pidge urgent    [options]               breaks through silent/Focus; --escalate forces an AlarmKit alarm
  pidge event     [options]               a scheduled thing — needs --event-at (countdown Live Activity)
  pidge live [CID] [options]              a REAL lock-screen card (Live Activity): entry of the
                                          user's consolidated status center. --title starts/upserts;
                                          CID without --title updates; --end concludes (✓ + outcome)
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
  pidge cancel <correlation_id>           cancel a still-scheduled notification
  pidge inbox  [--pending|--summary|--all|--limit N]   what you sent: list, pending slice, or counts+latency
  pidge catchup [--limit N] [--before ID]  READ-ONLY peek at the whole conversation (GET ?history=true):
                                          the thread newest-first, answers included — NEVER consumes,
                                          NEVER acks, NEVER opens a lease. Run it to SITUATE yourself at
                                          the start of an interactive session on a channel whose messages
                                          another runtime (a bridge/daemon) is the real consumer of — so
                                          you learn what's already handled WITHOUT stealing a message.
                                          Exit 0 (printed, even if empty) · 2 error. NEVER run \`listen\`
                                          on a channel another runtime consumes (double-consume).
  pidge bridge --exec '<handler>'         24/7 SUPERVISOR: loop listen --all → your handler runs
                                          ONCE per batch (batch JSON on stdin) → exit 0 ⇒ ack of the
                                          batch's EXACT ids · non-zero ⇒ NOT acked (the server lease
                                          re-serves). ONE instance per channel (pid-checked lockfile by
                                          hash(token)); --handler-timeout caps one run (default 30 min);
                                          model-agnostic: --exec 'claude -p …' | 'codex exec …' | any script
  pidge bridge install --exec '<handler>' write a launchd (Mac) / systemd (Linux) template running the
                                          bridge with Restart=on-failure + declare
                                          listen_mode=external_daemon (advisory). Never embeds the key.
  pidge listen [--timeout N] [--all] [--ack-on-read] [--follow]
                                          block until the human MESSAGES you from the app, print, exit
                                          a read message is DELIVERED (gray ✓✓), NOT done — ACK it
                                          AFTER the work: pidge ack --up-to <id> (a ~10-min lease re-serves
                                          un-acked messages, so a crash never loses one)
                                          --ack-on-read = the old immediate-consume (ack on print)
                                          --follow      = KEEP listening until --timeout (supervisor-only)
                                          --all  = the SINGLE EAR: also hear notification ANSWERS
  pidge online [listen flags]             = pidge listen --all, one word — so a pasted prompt can
                                          just say "stay online: pidge online". Run it as a background
                                          task your harness TRACKS; when it exits: handle → ack → RELAUNCH.
  pidge ack --up-to <id> | --ids a,b [--renew]
                                          mark messages PROCESSED (green ✓✓) after you handled them;
                                          --renew heartbeats the lease on a long task (state=delivered)
  pidge contract set <key>=<value> | contract show
                                          DECLARE how you operate: keep_connection_alive,
                                          mirror_in_origin_session,
                                          listen_mode=turn_based|persistent|external_daemon,
                                          quiet_when_idle. ADVISORY, never policy (the human SEES if you honor it).
  pidge selftest [--window N]             prove your listener works by ROUND-TRIP: fire a nonce,
                                          run the listener, confirm it picks it up + acks in time.
                                          PASS exit 0 / FAIL exit 2 (with the likely cause). Run it as the
                                          last onboarding step + whenever sends seem to go unheard.
  pidge skill install [--target T]        write the generated Pidge skill from the live manifest
                                          (persistent knowledge for an AI agent). --target claude
                                          (default) → .claude/skills/pidge/SKILL.md · agents → AGENTS.md ·
                                          gemini → GEMINI.md (same content, different destination)
  pidge --version                         print the CLI version
  pidge --help

REALTIME
  listen/ask/wait hold a WebSocket to the server (ActionCable at /cable) when the
  runtime has one (Node ≥22): answers/messages land in <1 s, an idle hours-long
  listen survives server deploys by RECONNECTING, and while you listen the human
  sees "ouvindo agora" in the app. Everything durable still goes over HTTP
  (backlog GET + ack), so a dropped socket costs latency, never data.
  --realtime      force WS (warns + falls back to polling if unavailable)
  --no-realtime   polling only (the ?wait= long-poll, capped 25 s server-side)
  Degrade ladder, narrated on stderr: WS → ?wait= long-poll → plain GETs every
  ~45 s after 3 consecutive failures on held polls. Degrade is STICKY for
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
                           (E2E channel + open media gate ⇒ a local path is SEALED first)
  --file PATH              a real artifact (xlsx, pdf, csv…) the human previews,
                           shares and saves on the phone; uploaded automatically (≤25 MB;
                           sealed bytes + filename when the media gate is open)
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
  --thread ID              conversation handle: sends sharing it group as ONE
                           strand on the phone — use it for follow-ups
  --after CID              decision queue: HELD until that notification is
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
  blindly) · 2 error · 1 usage.

Responses are one-and-done EXCEPT snooze/reschedule (they re-fire); a --wait send
keeps polling through a snooze and prints snooze_until. Follow-up = a NEW
notification. An over-ceiling type is delivered DEGRADED, never rejected — read
the 201's degraded/degrade_reason (narrated on stderr). \`live\` is status-only:
it never produces an answer, so --wait/ask refuse it.

Full spec (the contract — always current): GET $PIDGE_URL/api/v1/manifest`;

// ---------------------------------------------------------------------------
// per-subcommand help. `pidge <cmd> --help` (and `pidge help <cmd>`) must
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
  thread: '--thread ID              conversation handle: same id ⇒ one strand on the phone',
  after: '--after CID              decision queue: held until that notification is answered',
  'collapse-key': '--collapse-key KEY       replace/update a prior notification',
  param: '--param KEY=VALUE        pass ANY raw /notify field (repeatable) — the manifest is the contract',
  timeout: '--timeout SECONDS        how long --wait blocks (ask/approval: template suggestion ~3600 · wait: 300 · listen: 600)',
  interval: '--interval SECONDS       FALLBACK poll cadence (default 30) — normally unused (WS/long-poll)',
  realtime: '--realtime               force the realtime WebSocket (warn + fall back to polling if unavailable)',
  'no-realtime': '--no-realtime            polling only (skip the WebSocket)',
  pending: '--pending                only delivered + still-unanswered notifications',
  summary: '--summary                counts + answer latency (one call)',
  'all-inbox': '--all                    whole-account scope (not just this channel)',
  'all-listen': '--all                    single ear: also hear notification ANSWERS, not just messages',
  download: '--download               also save CLEAR inbound attachments to disk (sealed ones always save)',
  'no-download': '--no-download            catchup: skip fetching/unsealing attachments (--digest implies it)',
  'download-dir': '--download-dir DIR       where inbound attachments land (default ~/.config/pidge/downloads)',
  note: '--note TEXT              send: WHY this runtime sent it (sent_note — clear metadata, no secrets)',
  limit: '--limit N                cap the number of rows',
  before: '--before ID              catchup: page the thread OLDER than this message id (walk back through history)',
  since: '--since ID               catchup: incremental cursor — only messages NEWER than this id (O(new), not O(thread))',
  digest: '--digest                 catchup: one condensed line per message (id · kind · 60 chars · handled by X: <note> / ✓ acked (no note) / PENDING)',
  target: '--target T               skill install: claude (default) → .claude/skills/pidge/SKILL.md · agents → AGENTS.md · gemini → GEMINI.md',
  claim: '--claim CODE             the single-use setup code (the human copies it from the Pidge app)',
  'url-base': '--url BASE               the Pidge server base URL (default https://api.pidge.sh)',
  print: '--print                  emit `export …` lines instead of writing a file (per-agent; you run it)',
  force: '--force                  overwrite a shared config owned by another channel',
  'listen-mode': '--listen-mode MODE       declare how you operate: turn_based | persistent | external_daemon',
  follow: '--follow                 KEEP listening until --timeout (supervisor-only; traps a turn-based agent)',
  'ack-on-read': '--ack-on-read            consume messages on read (pre-0.9 immediate-consume)',
  'up-to': '--up-to ID               process every message up to this id',
  ids: '--ids a,b                process this comma-list of ids',
  renew: '--renew                  heartbeat the visibility-timeout lease instead of processing',
  'ack-summary': '--summary "TEXT"         ack: attribution — WHAT you did (a successor session sees it via `pidge catchup`; capped ~1000 chars)',
  window: '--window N               reachability window in seconds (default 30)',
  exec: "--exec CMD               the handler: run ONCE per batch with the batch JSON on stdin; exit 0 = batch acked (its EXACT ids), non-zero = NOT acked (the server lease re-serves — make it idempotent)",
  'handler-timeout': '--handler-timeout N      bridge: max seconds ONE handler run may take (default 1800 = 30 min) — over it: SIGTERM (SIGKILL 5s later), treated as a FAILED batch (not acked)',
  'quiet-nag': '--quiet-nag              silence the "server has new capabilities" nag for this run',
  'allow-label': '--allow-label TEXT       approve: label on the Face-ID allow button (default "Allow")',
  'deny-label': '--deny-label TEXT        approve: label on the deny button (default "Deny")',
  quiet: '--quiet                  setup: collapse onboarding to one status line (the full doctor stays the default)',
  status: '--status TEXT            short status line on the card ("copiando índices")',
  symbol: '--symbol NAME            SF Symbol (hammer.fill, arrow.down.circle)',
  detail: '--detail TEXT            small trailing value on the card',
  progress: '--progress N             0..1 → progress bar (or use --step)',
  step: '--step N/M               steps sugar: "3/5" → progress 0.6 + the fraction label (no steps field on the wire)',
  'ends-at': '--ends-at ISO8601        countdown — the SERVER concludes the entry when it hits zero',
  'starts-at': '--starts-at ISO8601      elapsed count-up from this instant',
  paused: '--paused                 pause the timer (is_running:false); omit-to-preserve — updates never reset it',
  resume: '--resume                 resume a paused timer (is_running:true)',
  dedicated: '--dedicated              own device card instead of a status-center entry (budget 2 — the 3rd degrades loudly)',
  end: '--end                    end the entry: done ✓ + outcome, lingers --linger seconds, then leaves the card',
  outcome: '--outcome TEXT           end: the line shown next to the ✓ (falls back to the final --status)',
  linger: '--linger N               end: seconds the final snapshot stays visible (default 30)',
  mode: '--mode M                 run start: interactive | poll | bridge | custom (default custom)',
  role: '--role R                 run start: main | worker | subagent (display-only)',
  label: '--label L                run start: the friendly execution label (default your PIDGE_LABEL/agent id)',
  'parent-seal': '--parent-seal S          run start: a subagent points at its parent run\'s seal ($PIDGE_RUN_SEAL)',
  ephemeral: '--ephemeral              run start: mark a disposable, per-message execution',
  ttl: '--ttl N                  run start: sliding TTL in seconds (server clamps; default 24h)',
  json: '--json                   run start: print the raw server body instead of the two export lines',
  'no-defer': '--no-defer               bridge: never hold back for a live interactive run (turn OFF the polite poller)',
};
// Content flags shared by every send.
// `template` is intentionally OFF the menu (content_template is
// undocumented back-compat). It stays a parseable OPTION but is NOT listed here,
// so `pidge <type> --help` no longer prints a bare, description-less `template` line.
const CONTENT_OPTS = ['title', 'body', 'body-markdown', 'body-markdown-file', 'subtitle', 'profile',
  'event-at', 'lead-minutes', 'urgency', 'image', 'file', 'url', 'copy', 'actions',
  'custom-action', 'deliver-at', 'reply-to', 'correlation-id', 'thread', 'after',
  'collapse-key', 'note', 'param'];
// Typed sends also carry the RESPONSE axis: --wait (block on the answer) + the
// blocking knobs. (`live` is status-only — it never answers, so it skips these.)
const SEND_OPTS = [...CONTENT_OPTS, 'gated', 'wait', 'timeout', 'interval', 'realtime', 'no-realtime'];

const HELP = {
  setup: {
    summary: 'one-shot onboarding: exchange a single-use claim code for the channel key, store it, run doctor.',
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
    summary: 'first-contact WOW: your channel\'s debut handshake, narrated live by a 3-stage Live Activity. send + wait in one.',
    usage: 'pidge hello [options]',
    body: 'First contact on a fresh channel: send the debut handshake and block until your human confirms. The server narrates a 3-stage Live Activity. --timeout defaults to 120s; a timeout exits 3 (no confirmation yet — it stays in your queue, `pidge listen --all` collects it), never hanging the session.',
    opts: [...CONTENT_OPTS, 'timeout', 'interval', 'realtime', 'no-realtime'],
  },
  // AXIS 1 — the married catalog of 5. The TYPE you pick IS how the
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
    summary: 'track an in-flight task (deploy/build/trip) on a REAL lock-screen Live Activity. Status-only — never answers.',
    usage: 'pidge live [CID] --title TEXT [--status "…"] [--step 3/5 | --progress 0.6 | --ends-at ISO] · pidge live CID --end [--outcome "…"] [--linger N]',
    body: 'Drives the /live_activities endpoints — by default an ENTRY of the user\'s ONE consolidated status-center card (cards never stack; --dedicated opts into an own card, budget 2). FIELDS DRIVE THE RENDER: --step/--progress → bar + fraction · --ends-at → native countdown (the server concludes it at zero) · --end → ✓ + --outcome, lingers --linger seconds, then leaves. The handle is the CID (positional or --correlation-id; auto-generated on first POST — reuse it to update/end). Updates are cheap: identical re-writes echo operation:"noop"; a stale entry is retired by the server. ALWAYS --end what you started anyway — outcome beats timeout.',
    opts: ['title', 'status', 'step', 'progress', 'ends-at', 'starts-at', 'paused', 'resume', 'detail', 'symbol', 'dedicated', 'end', 'outcome', 'linger', 'correlation-id'],
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
    body: 'The easy shortcut for an explicit approval: injects an Approve (Face-ID gated) / Reject pair and blocks on the answer. Pass your own --actions/--custom-action to override the default pair. A gated action is detail-screen only (the banner shows no quick buttons by design).',
    opts: [...CONTENT_OPTS, 'timeout', 'interval', 'realtime', 'no-realtime'],
  },
  // — the HOOK-shaped gate. DENY-DEFAULT: exit 0 ONLY on an explicit allow;
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
    summary: 'cancel a still-scheduled notification before it fires (idempotent; 409 once it reached the phone).',
    usage: 'pidge cancel <correlation_id>',
    opts: [],
  },
  inbox: {
    summary: 'what you sent: the list (default), the pending slice, or counts + answer latency.',
    usage: 'pidge inbox [--pending | --summary] [--all] [--limit N]',
    opts: ['pending', 'summary', 'all-inbox', 'limit'],
  },
  listen: {
    summary: 'block until the human MESSAGES you from the app, print, ACK after the work, exit.',
    usage: 'pidge listen [--timeout N] [--all] [--ack-on-read] [--follow] [--download] [--download-dir DIR]',
    body: 'One-shot by design (loop it, don\'t daemonize). a read message is DELIVERED (gray ✓✓), NOT done — ack it AFTER the work with `pidge ack --up-to <id>` (a ~10-min lease re-serves un-acked messages, so a crash never loses one). a message may carry an `attachment` (a photo/file from the app\'s composer) — a SEALED one is auto-downloaded + decrypted to a local file (`attachment.path` in the JSON); a clear one keeps its fetchable `url` (--download saves it too).',
    opts: ['timeout', 'all-listen', 'ack-on-read', 'follow', 'interval', 'realtime', 'no-realtime', 'download', 'download-dir'],
  },
  online: {
    summary: 'sugar for `pidge listen --all` — the stay-online loop, one word.',
    usage: 'pidge online [--timeout N] [--ack-on-read] [--follow] [--download] [--download-dir DIR]',
    body: 'It exists so a pasted prompt can just say "stay online: pidge online". Every listen flag forwards; --all is forced (the single ear: composer messages + notification answers). The LOOP is the contract: run it as a background task your harness TRACKS (never a loose shell &); it blocks until something lands — handle it, `pidge ack`, then RELAUNCH it. That loop is what "online" means.',
    opts: ['timeout', 'ack-on-read', 'follow', 'interval', 'realtime', 'no-realtime', 'download', 'download-dir'],
  },
  bridge: {
    summary: '24/7 supervisor: long-poll the channel, run YOUR handler once per batch, ack only on exit 0. Model-agnostic.',
    usage: "pidge bridge --exec '<handler>'  ·  pidge bridge install --exec '<handler>'",
    body: [
      'The productized "paste a prompt and the agent stays online". The bridge is deliberately DUMB — no local queue, no own retry ledger: durability is the SERVER\'s ack/lease.',
      '',
      'LOOP: long-poll GET /messages?all=true (the robust floor; a realtime socket, when available, adds presence — "ouvindo agora" — and early wake-ups, never the data path) → your --exec command runs ONCE per batch with the batch JSON on stdin ({"messages":[…]} + "history_hint":true on the first batch since boot — the handler may want `pidge catchup` to situate) → handler exit 0 ⇒ ack of the batch\'s EXACT ids (never a --up-to watermark: that would stamp rows under lease from an EARLIER batch the handler FAILED on) · non-zero ⇒ NOT acked: the ~10-min server lease re-serves the batch. At-least-once is the contract — make the handler IDEMPOTENT. One run is capped by --handler-timeout (default 30 min): over it the handler is SIGTERMed (SIGKILL 5s later) and the batch counts as FAILED; while it runs, a heartbeat line lands on stderr every 5 min AND the batch\'s lease is RENEWED every 60 s (POST /ack {ids, state:"delivered"}) — so a long run neither lapses the ~10-min lease mid-work nor reads as offline (servers with manifest ≥ v79 refresh "listening now" presence on the renew; a failed batch still lapses back: the renew stops the moment the handler exits).',
      'SUMMARY: the handler tells the NEXT session WHAT it did by printing a marker line to stdout — `pidge-summary: <one sentence>`. The bridge tees the handler\'s stdout to its own log AND scans it (streamed, never buffered) for the LAST such line; found ⇒ the ack carries that summary (capped ~1000 chars) so `pidge catchup` shows "handled by X: <summary>"; not found ⇒ acked without one (never invented). An LLM handler is instructable in its own prompt: end with `echo "pidge-summary: <what you did>"` (or have the model print it). Only a line that STARTS with the marker counts — incidental output never becomes attribution.',
      'Model-agnostic by construction: --exec \'claude -p "…"\' | \'codex exec "…"\' | \'gemini "…"\' | any script. This is the multi-LLM answer: no dependence on a harness that wakes on background-task exit.',
      'ONE INSTANCE PER CHANNEL: a lockfile keyed by hash(token) (~/.config/pidge/bridge-<hash>.lock, PID-checked so a crashed bridge never wedges the channel) — a second bridge, or a `listen`, on the same channel is REFUSED (exit 2). Read with `pidge catchup` instead.',
      'FAILURES: 401 → narrated + LOCAL alert + LONG jittered backoff (a rotated key only a human can fix — the bridge never dies silent, never re-loops blind); a channel with no healthy round-trip (the exit-4 class) → same alert + long backoff; every retry sleep is jittered. SIGTERM/SIGINT → clean shutdown: the in-flight batch is NOT acked (the lease re-serves it), the lock is released, exit 0.',
      '`pidge bridge install` writes a launchd (Mac) / systemd (Linux) TEMPLATE that runs this command with Restart=on-failure semantics and declares listen_mode=external_daemon in the operating contract (advisory, honest). The template NEVER embeds the key — it stays in ~/.config/pidge/env.',
    ].join('\n'),
    opts: ['exec', 'handler-timeout', 'interval', 'realtime', 'no-realtime'],
  },
  run: {
    summary: 'execution attribution: mint a per-run SIGNATURE so the human sees WHICH execution spoke (attribution, not a credential).',
    usage: 'pidge run start [--mode M] [--role R] [--label L] [--parent-seal S] [--ephemeral] [--ttl N] [--json]  ·  pidge run end  ·  pidge run status',
    body: [
      'A run is a short, server-issued seal for ONE execution. Every agent-track call then rides `x-pidge-run: $PIDGE_RUN_TOKEN`, so each message you send is stamped with the exact run — the human can tell three cold sessions apart from one continuous mind. It is ATTRIBUTION, never a channel credential: `Authorization: Bearer hld_…` still authenticates; the run token only signs. An expired/invalid run degrades to unsigned (never a 401), and a server that predates runs (/runs 404) turns the feature off for this process — you keep sending unsigned exactly as before.',
      '',
      '`pidge run start` prints two shell-eval lines on stdout — `export PIDGE_RUN_TOKEN=…` and `export PIDGE_RUN_SEAL=…` — so `eval "$(pidge run start --mode interactive --role main)"` arms the whole session; a friendly narration goes to stderr. `--json` prints the raw server body instead. The token is NEVER written to a config file (env-only, disposable). `pidge run end` reads $PIDGE_RUN_TOKEN and ends that run (best-effort, idempotent; no token ⇒ a no-op). `pidge run status` lists the channel\'s live runs (your own marked `*`).',
      '',
      'A subagent/worker inherits attribution by passing `--role subagent --parent-seal $PIDGE_RUN_SEAL`. `pidge bridge` mints its OWN bridge run per handler automatically — you do not run these there.',
    ].join('\n'),
    opts: ['mode', 'role', 'label', 'parent-seal', 'ephemeral', 'ttl', 'json'],
  },
  ack: {
    summary: 'mark messages PROCESSED (green ✓✓) after you handled them, or --renew the lease on a long task.',
    usage: 'pidge ack --up-to <id> | --ids a,b [--renew] [--summary "<what you did>"]',
    body: '--summary attaches a one-line note (WHAT you did) to the acked messages — a successor session sees it as "handled by X: <summary>" in `pidge catchup`. A bare --summary with no value is a usage error, never a silent no-op.',
    opts: ['up-to', 'ids', 'renew', 'ack-summary'],
  },
  contract: {
    summary: 'DECLARE how you operate — ADVISORY, never policy (the human SEES if you honor it).',
    usage: 'pidge contract set <key>=<value> | pidge contract show',
    body: 'Keys: keep_connection_alive, mirror_in_origin_session, listen_mode=turn_based|persistent|external_daemon, quiet_when_idle. An unknown key / bad value is rejected locally (exit 1).',
    opts: [],
  },
  selftest: {
    summary: 'prove your listener works by ROUND-TRIP: fire a nonce, run the listener, confirm it acks in time.',
    usage: 'pidge selftest [--window N]',
    body: 'PASS exit 0 / FAIL exit 2 (with the likely cause). Run it as the last onboarding step + whenever sends seem to go unheard.',
    opts: ['window'],
  },
  skill: {
    summary: 'write the generated Pidge skill from the live manifest (persistent Pidge knowledge for an AI agent).',
    usage: 'pidge skill install [--target claude|agents|gemini]',
    body: 'Content is the same for every target — only the destination changes: --target claude (default) → .claude/skills/pidge/SKILL.md (a Claude Code skill) · --target agents → AGENTS.md · --target gemini → GEMINI.md (both at the repo root). An existing file whose content differs is backed up to <dest>.bak (or <dest>.bak.<timestamp> if that is taken) first. NOTE: only the claude target SELF-HEALS — any pidge command silently refreshes a stale .claude skill, but AGENTS.md/GEMINI.md do NOT auto-update; re-run `pidge skill install --target agents|gemini` yourself to refresh them.',
    opts: ['target'],
  },
  catchup: {
    summary: 'READ-ONLY peek at the whole conversation (GET ?history=true) — the thread newest-first, answers included. NEVER consumes.',
    usage: 'pidge catchup [--since ID] [--digest] [--limit N] [--before ID] [--no-download]',
    body: [
      'Prints the channel\'s conversation as JSON (newest first) over GET /messages?history=true&all=true — the WHOLE thread, notification answers included. It NEVER consumes: no ack, no delivered stamp, no visibility lease. Safe to run any number of times.',
      '',
      'Run it to SITUATE yourself at the start of an interactive session on a channel whose messages another runtime (a 24/7 bridge/daemon) is the real consumer of: you learn what has already been said and handled WITHOUT stealing a message out of that consumer\'s queue. The rule is one consumer per channel — if another runtime consumes this channel, use `catchup` to read and NEVER run `listen` (that would double-consume).',
      '',
      '`--since <id>` is an incremental cursor — only messages with an id GREATER than <id> (situate in O(new), not O(whole thread)). It is enforced client-side too, so it holds regardless of server support. catchup remembers the highest id it printed and, on EVERY no-`--since` run, prints the cursor on stderr (stdout stays clean). `--digest` collapses each message to ONE line — `id · kind · <60 chars> · <state>`, where <state> is `handled by X: <summary>` (acked WITH a note), `✓ acked (no note)` (processed, no note — NOT pending), or `PENDING` (genuinely un-processed). The three states matter: a processed-but-noteless row is NOT work to redo. The two flags compose: `pidge catchup --digest --since <last>`.',
      '',
      'Exit 0 = printed (even the empty `{"messages":[]}`) · 2 = error. There is no wait, so no exit 3/4.',
    ].join('\n'),
    opts: ['since', 'digest', 'limit', 'before', 'download', 'no-download', 'download-dir'],
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
// silence the manifest-version nag entirely (per run via --quiet-nag, or
// per environment via PIDGE_QUIET_NAG=1) — for scripts and CI where the nudge is noise.
const QUIET_NAG = !!v['quiet-nag'] || process.env.PIDGE_QUIET_NAG === '1';
// `--quiet` collapses setup/doctor NARRATION to a single status line.
// `note()` prints an informational line only when NOT quiet; WARNINGS and ERRORS
// keep using console.error directly, so --quiet never hides a broken setup.
const QUIET = !!v.quiet;
const note = (msg) => { if (!QUIET) console.error(msg); };

// Help on stdout, exit 0. `pidge <cmd> --help` / `pidge help <cmd>` show the
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
// The shared header set for every channel-key call — carries the per-request
// agent identity, so every verb (notify/ack/inbox/messages/catchup/…)
// self-identifies without a per-call spread.
const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...identityHeaders() };

// fetch with a hard timeout: a wedged edge proxy can stall even a
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
// The newest server manifest additions this CLI narrates natively: ack
// attribution (acked_by_label/handler_summary on history rows — catchup
// narrates them), stale_from_prior_claim, per-request identity headers,
// whoami consumers/provenance, being_handled_by and sent_note.
const KNOWN_MANIFEST_VERSION = 67;
// The hand-authored skill SPINE version. BUMP whenever the SKILL.md spine
// (the non-generated prose in installSkill) changes — an existing install whose
// baked marker is older than this self-heals on its next pidge command, so an
// onboarded agent always runs the latest skill without any human action.
const SKILL_REVISION = 15;
// the LAST line of every generated skill. A file that carries the frontmatter
// marker but not this trailer was torn mid-write (partial write / full disk) —
// ensureSkillFresh treats it as stale and re-heals instead of trusting its rev.
const SKILL_END_MARKER = '<!-- pidge-skill-end -->';
const NAG_TTL_MS = 24 * 60 * 60 * 1000; // at most one nag per 24 h
let newsWarned = false;
// the self-heal runs at most ONCE per process (one regeneration, even when
// many commands/poll-ticks call checkManifestNews). Non-stale checks stay cheap +
// repeatable; this only latches once an actual heal is attempted.
let skillHealed = false;

// a tiny per-install state cache (~/.config/pidge/state.json, per-agent
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
    const dir = pidgeConfigDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Atomic: write a temp then rename, so a crash/ENOSPC mid-write can't leave
    // a TRUNCATED state.json (which readState would silently treat as {} and
    // drop the E2E pin — fail-open). rename over the live file is atomic on
    // the same fs. (Shallow-merge race across parallel agents on a SHARED dir
    // stays possible; the multi-agent guidance is PIDGE_AGENT, which isolates
    // the dir — a lost pin re-latches on the next confirmed seal anyway.)
    const tmp = path.join(dir, `state.json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, stateFilePath());
  } catch { /* best-effort — the nag just won't persist its throttle */ }
}

async function checkManifestNews(res) {
  const ver = parseInt(res.headers.get('x-pidge-manifest-version') || '0', 10);
  // the self-heal runs on EVERY command (its own once-guard + cheap
  // first-line read), BEFORE the nag throttle below — it must fire even when the
  // server isn't ahead of KNOWN_MANIFEST_VERSION (a pure spine bump) and even
  // under QUIET_NAG (which only silences the stderr note, never the regenerate).
  await ensureSkillFresh(ver);
  if (QUIET_NAG || newsWarned) return;
  // (c) only when the server is ahead of what THIS CLI knows.
  if (!(ver > KNOWN_MANIFEST_VERSION)) return;
  // throttle: nag at most once per 24 h, and after that window only when the
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
  // pidge is a THIN PIPE — a server manifest bump almost never needs a CLI
  // release, because --param carries any new /notify field NOW. So the nudge is
  // "new capabilities + how to use them today", NOT "your CLI is stale, update it".
  // The manifest is PUBLIC — the curl reads the catalog without a key
  // (a key only adds your channel's own config). Updating the CLI is the LAST,
  // optional step (only to gain native flags), never the headline.
  console.error(`pidge: the server has NEW capabilities (manifest v${ver}; this CLI knows v${KNOWN_MANIFEST_VERSION}) — pidge is a thin pipe, so you can use any new /notify field RIGHT NOW via --param KEY=VALUE. Read the catalog (whats_new) in the public manifest:  curl $PIDGE_URL/api/v1/manifest  (public; add -H "Authorization: Bearer $PIDGE_TOKEN" to also see your channel's config). Updating the CLI only matters to gain native flags:  npx pidge-cli@latest  (a pinned ref never self-updates). Silence this with --quiet-nag or PIDGE_QUIET_NAG=1.`);
}

// STRUCTURAL self-heal — keep the LOCAL skill current with zero human action.
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
// locate the self-heal marker ONLY where a generated skill ever put it —
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

// the TWO locations Claude Code loads a `pidge` skill from — the PROJECT skill
// (.claude/skills/pidge under cwd, where `skill install` writes) AND the HOME skill
// (~/.claude/skills/pidge). Old installs (and hand-copies) live in HOME; the
// cwd-only self-heal never visited it, so a live agent ran 3 WEEKS on a home skill
// frozen at an old rev with NO signal. Both are candidates now; each stale copy
// heals IN PLACE. Deduped when cwd IS home (heal once, never twice).
function skillHealCandidates() {
  const rel = path.join('.claude', 'skills', 'pidge', 'SKILL.md');
  const project = path.join(process.cwd(), rel);
  const home = path.join(os.homedir(), rel);
  // The HOME path requires a pidge MARKER before we touch it — an
  // unmarked ~/.claude/skills/pidge/SKILL.md is an AUTHORIAL skill (the human wrote
  // their own), NOT a pidge install gone stale, and must be left alone. The PROJECT
  // path keeps the current semantics (it heals a marker-less file too, since a project
  // skill only exists because pidge/onboarding put it there — covered by an existing
  // test). Deduped when cwd IS home (heal once, and require the marker then).
  if (project === home) return [{ file: project, requireMarker: true }];
  return [{ file: project, requireMarker: false }, { file: home, requireMarker: true }];
}

// Doctor's nudge for a home skill with NO pidge marker. Such a file is
// left untouched by the self-heal (requireMarker) — correct, since it might be
// the human's OWN authored skill — but a PRE-MARKER pidge copy is indistinguishable
// and would silently stay on old doctrine. So doctor SAYS so (never writes). The fix
// it points at is `skill install` run FROM the home dir (the target is cwd-relative),
// which backs the old file up to .bak. Best-effort: a read failure just skips it.
function warnUnmarkedHomeSkill() {
  try {
    const homeSkill = path.join(os.homedir(), '.claude', 'skills', 'pidge', 'SKILL.md');
    // Skip when cwd IS home: that file is the PROJECT skill, already self-healed.
    if (path.join(process.cwd(), '.claude', 'skills', 'pidge', 'SKILL.md') === homeSkill) return;
    if (!fs.existsSync(homeSkill)) return;
    if (findSkillMarker(fs.readFileSync(homeSkill, 'utf8'))) return; // marked ⇒ self-heals; nothing to say
    console.error(`pidge doctor: ⚠️ ${homeSkill} has NO pidge marker — the self-heal won't touch it, so if it's an OLD pidge copy (not a skill you authored) it may be running STALE doctrine with no other signal. To refresh it, run \`pidge skill install\` FROM your home dir (\`cd ~ && npx pidge-cli skill install\`) — the current file is backed up to .bak first. If you AUTHORED it yourself, ignore this.`);
  } catch { /* best-effort — never break doctor over a skill probe */ }
}

// True when the skill at `file` EXISTS and is stale (torn tail, older spine rev, or
// older baked manifest than the server's). A missing file is never stale — the
// self-heal only REFRESHES an existing skill, it never creates one. When
// `requireMarker` is set, a file with NO pidge marker is treated as NOT ours (an
// authorial skill) and left untouched.
function skillIsStale(file, serverManifestVersion, requireMarker = false) {
  if (!fs.existsSync(file)) return false;
  // The marker rides a `# pidge-skill rev=N manifest=M` YAML comment INSIDE
  // the frontmatter (0.15.3+); pre-0.15.3 installs put `<!-- pidge-skill … -->` as line 1.
  // the scan is ANCHORED to those two positions (line 1, or inside the opening `---`
  // block) — a prose line in the body like "see pidge-skill rev=99" must never be read as
  // the marker and suppress a legitimate heal.
  const content = fs.readFileSync(file, 'utf8');
  const markerLine = findSkillMarker(content);
  // no marker + marker required (the HOME path) ⇒ an authorial skill, not ours.
  if (requireMarker && !markerLine) return false;
  const revM = markerLine.match(/rev=(\d+)/);
  const manM = markerLine.match(/manifest=(\d+)/);
  const installedRev = revM ? parseInt(revM[1], 10) : 0;
  const installedManifest = manM ? parseInt(manM[1], 10) : 0;
  // integrity: a generated skill always ends with SKILL_END_MARKER. A marker whose
  // rev looks current but whose trailer is missing = a TORN write (the marker survived
  // on line ~4, the tail didn't) — without this check the tear would read as "fresh"
  // and never heal. Pre-trailer installs lack the trailer too, but their rev < 4 already
  // marks them stale, so the two triggers compose instead of fighting.
  const torn = installedRev > 0 && !content.trimEnd().endsWith(SKILL_END_MARKER);
  return torn || SKILL_REVISION > installedRev || (serverManifestVersion || 0) > installedManifest;
}

async function ensureSkillFresh(serverManifestVersion) {
  if (skillHealed) return;
  try {
    // check BOTH project + home; heal every stale copy in ONE pass (a single
    // process may own two stale skills). A silent home heal is safe in multi-project
    // use: the generated content is agent- AND project-agnostic (it bakes no token —
    // only the server's manifest version + fixed doctrine), so any project's
    // invocation regenerates the SAME skill.
    const stale = skillHealCandidates()
      .filter((c) => skillIsStale(c.file, serverManifestVersion, c.requireMarker))
      .map((c) => c.file);
    if (stale.length === 0) return;
    skillHealed = true; // latch BEFORE the network write — attempt the heal at most once per process
    let manifestVersion = null;
    for (const file of stale) {
      const r = await installSkill(BASE, TOKEN, 'claude', file); // silent: writes the file in place
      manifestVersion = r.manifest_version;
    }
    // Respect QUIET_NAG/PIDGE_QUIET_NAG for the note only — we STILL regenerated.
    if (!QUIET_NAG) {
      const many = stale.length > 1;
      console.error(`pidge: refreshed your local Pidge skill${many ? 's' : ''} (rev ${SKILL_REVISION}, manifest v${manifestVersion}${many ? `; ${stale.length} locations incl. ~/.claude` : ''}) — your next session will use ${many ? 'them' : 'it'}.`);
    }
  } catch { /* best-effort — a skill refresh must never break the user's command */ }
}

// ---------------------------------------------------------------------------
// the health ledger of one blocking session (wait/ask/listen). Drives
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
// wall-clock, never the configured deadline. A real bug once shipped: a
// WS close 1006 made the CLI exit "timed out after 28800s" when only seconds had
// passed — the number lied. exitTimeout now reports elapsed since this baseline.
// MONOTONIC on purpose: performance.now() can't be skewed by a wall-clock
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
  exitTimeout(message, hint, nudge) {
    // REAL elapsed wall-clock — never the configured deadline (the
    // "timed out after 28800s" lie). If only seconds passed, the number says so.
    const elapsed = Math.round((performance.now() - SESSION_START_MONO) / 1000);
    if (this.okEver) {
      // a healthy channel that heard nothing on exit 3 might not be empty —
      // a message can be UNDER A VISIBILITY LEASE from another read (a selftest,
      // a crashed listener, a bridge), invisible until the lease lapses. Point at
      // the read-only diagnostic that sees the whole queue regardless. Only on
      // exit 3 (channel proven healthy) — on exit 4 (channel broken) it's noise.
      // `nudge` (listen-only, suppressed under --follow) rides the SAME gate:
      // "relaunch the listener" is only true advice on a channel proven healthy.
      console.error(`pidge: ${message} after ${elapsed}s (= 'no answer yet', not a failure)`);
      if (hint) console.error(`pidge: ${hint}`);
      if (nudge) console.error(`pidge: ${nudge}`);
      process.exit(3);
    }
    console.error(`pidge: ${message} after ${elapsed}s — and NOT ONE healthy round-trip all session: the CHANNEL looks broken (server/network), not the human ignoring you. Surface this to your human.`);
    process.exit(4);
  },
};

// ---------------------------------------------------------------------------
// Realtime: a minimal ActionCable client over the runtime's native
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
function cableSubscribe({ channel, params = {}, onUp, onFrame, onDown, base = BASE, token = TOKEN }) {
  let ws;
  try {
    ws = new WebSocket(base.replace(/^http/, 'ws') + '/cable', ['actioncable-v1-json', token]);
  } catch (e) { onDown(e.message); return null; }
  // the per-request identity (fingerprint/label) rides the subscribe
  // params on the REAL consume subscribes (listen/wait/bridge) so the server can
  // attribute presence; the doctor probe passes none (no phantom consumer).
  const identifier = JSON.stringify({ channel, ...params });
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
  // the reconnect log prefixes "realtime socket …", so the reason must NOT
  // start with "socket" again (was "socket socket closed (1006)").
  ws.onclose = (e) => die(`closed (${e.code})`);
  return { close: () => { closed = true; clearInterval(beatCheck); try { ws.close(); } catch { /* noop */ } } };
}

// Run one WS subscription session until the deadline / an unrecoverable WS
// problem, reconnecting with backoff in between (a deploy = seconds of gap; the
// criterion: hours-long listens must SURVIVE it). onUp/onFrame get a
// `finish(reason)` to end the session (e.g. when the answer landed over HTTP).
// Resolves 'deadline' | 'ws-unavailable'.
async function cableSession({ channel, params = {}, deadline, onUp, onFrame }) {
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
        params,
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
    // show the MONOTONIC reconnect count, not the consecutive-fail counter —
    // a connect→drop FLAP resets wsFails (onUp forgives a healthy connect), so the
    // old "attempt 1/4" repeated forever and looked like a stuck loop. The cumulative
    // "#N" visibly advances; the polling fallback is spelled out so the ceiling is clear.
    console.error(`pidge: realtime socket ${outcome.replace('down: ', '')} — reconnecting in ${Math.round(backoff / 1000)}s (reconnect #${wsReconnects}; falls back to polling after ${MAX_WS_FAILS} consecutive failures)`);
    await sleep(backoff);
  }
  return 'deadline';
}

// doctor's realtime probe — the failure class an HTTP-only doctor can't
// see (an edge killing held responses, a proxy refusing the upgrade). A
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

// a custom action id is lowercase letters, digits and underscore (≤40) —
// the same rule the server enforces, validated LOCALLY so a typo fails fast.
const CUSTOM_ACTION_ID = /^[a-z0-9_]{1,40}$/;

// --custom-action "id:label[:destructive][:confirm][:biometric][:terminal]"
function customActionFromSpec(spec) {
  const [id, label, ...flags] = spec.split(':');
  // Fail fast locally — the rule is stable and the server 422 costs a
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

// one item of a JSON --actions array → a custom_actions spec. Validates
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
// E2E wire layer — send/receive integration of wire format v1 (shared with the
// server and the iOS app).
// SEND: with a valid PIDGE_SECRET AND an E2E channel (whoami says — never a
// guess), the content fields leave this machine as envelopes with enc:"v1"+kf;
// otherwise the send is the clear send of always (the server accepts-and-marks
// — a missing secret must NEVER block a notification).
// RECEIVE: every read path gates on the EXPLICIT `enc` flag (never on sniffing
// the "v1:" prefix). Inside a sealed context, an envelope MUST open — a kf that
// isn't ours / a failed tag / a missing AAD anchor is a PRECISE error and the
// field is BLANKED (base64 never reaches the terminal); a value
// that is NOT an envelope is readable text and passes through untouched (a
// built-in action label, or a clear reply typed on a pre-E2E app — the same
// accept-and-mark honesty the iOS app shows).
// ---------------------------------------------------------------------------
// `copy` (tap-to-copy — the field MADE for tokens/codes) and `url`
// (deep link) joined the seal. AAD field names are the payload names verbatim
// ("copy"/"url") — the iOS tap paths decrypt with the same names.
const E2E_CONTENT_FIELDS = ['title', 'subtitle', 'body', 'body_markdown', 'copy', 'url'];
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
  e2eChannelCache = {
    id: data.channel.id,
    e2eEnabled: !!data.channel.e2e_enabled,
    // media gate: sealed media is SAFE on this channel — E2E on AND every
    // deliverable device runs a build that OPENS sealed blobs. Absent on an
    // older server ⇒ false (never seal into the void).
    e2eMediaReady: !!data.channel.e2e_media_ready,
  };
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
    || (!cid && 'sealed but the row carries NO correlation_id (the AAD anchor) — an old server, or a bug: it can never be decrypted')
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

// local pin — the anti-downgrade latch. The seal decision used to trust
// server-served flags in BOTH directions: a lying/compromised server answering
// e2e_enabled=false (or just failing whoami) made this CLI send PLAINTEXT
// despite holding the key — breaking the feature's own threat model ("protects
// against the server"). So: the first CONFIRMED sealed context stamps
// state.json (same per-agent dir as the env file), and from then on a clear
// send here is REFUSED (exit 2) unless the human unpins LOCALLY with
// PIDGE_E2E=off (env var or the env file). A server response alone can never
// unpin — that's the whole point.
function e2eOverrideOff() {
  return String(process.env.PIDGE_E2E || FILE_ENV.PIDGE_E2E || '').toLowerCase() === 'off';
}
// The pin is keyed by a HASH of the channel token — per CHANNEL, not per
// install (one machine can drive an E2E channel and a clear one from the same
// config dir), resolvable with ZERO server help (a whoami-failed refusal must
// still find it), and the token itself never lands in state.json. A re-claim
// rotates the token ⇒ the new token starts unpinned and re-latches on its
// first confirmed seal (the stale entry is inert).
// The channel key — hash(token), resolvable with ZERO server help and never
// storing the token itself in state.json. The E2E pin and the catchup
// cursor both key their state.json entries by THIS, for the same reason:
// one machine can drive two channels from the same config dir, so a per-install
// (unkeyed) entry would let channel A's state leak into channel B.
function channelKeyFor(token) {
  return token ? crypto.createHash('sha256').update(String(token)).digest('base64url').slice(0, 12) : null;
}
function e2ePinKeyFor(token) {
  return channelKeyFor(token);
}
function e2ePinned() {
  const k = e2ePinKeyFor(TOKEN);
  const pins = readState().e2ePins;
  const p = k && pins && pins[k];
  return !!(p && p.v === 1);
}
function e2eStampPin(kf) {
  const k = e2ePinKeyFor(TOKEN);
  if (!k) return;
  const pins = readState().e2ePins || {};
  const cur = pins[k];
  if (cur && cur.v === 1 && cur.kf === kf) return;
  // Spread `cur`: a re-key (new kf, same token) must PRESERVE the media latch
  // — dropping `media:true` here would re-arm the exact server-driven
  // media-downgrade lever the pin exists to deny. e2eStampMediaPin spreads too.
  writeState({ e2ePins: { ...pins, [k]: { ...cur, v: 1, kf, at: new Date().toISOString() } } });
  e2eNote('channel PINNED as E2E on this machine — clear sends here are now refused even if the server claims E2E is off. Genuine toggle-off ⇒ unpin locally with PIDGE_E2E=off (env var or the env file).');
}
const E2E_UNPIN_HINT = 'If your human GENUINELY turned E2E off in the app, unpin locally: PIDGE_E2E=off (env var, or a line in the env file next to PIDGE_TOKEN). A server response alone can never unpin.';

// --- Sealed MEDIA — the deploy gate + its own pin latch. --------------------
// Media sealing is gated on whoami's e2e_media_ready (an iOS build that can
// OPEN sealed blobs is on all the human's devices) because a sealed photo on
// an old device is a broken photo. But a server-served gate is a downgrade
// lever (the same class the E2E pin refuses), so the FIRST confirmed sealed-media send latches
// `media:true` into the channel's pin — from then on a clear-media send is
// REFUSED unless the human sets PIDGE_E2E_MEDIA=off locally. PIDGE_E2E_MEDIA=on
// force-seals (testing before the iOS wave); PIDGE_E2E=off keeps voiding
// everything E2E, media included.
function e2eMediaOverride() {
  const raw = String(process.env.PIDGE_E2E_MEDIA || FILE_ENV.PIDGE_E2E_MEDIA || '').toLowerCase();
  return raw === 'on' || raw === 'off' ? raw : null;
}
// Pure (exported for tests): should this send seal its media?
function e2eMediaSealDecision({ sealingActive, ready, override }) {
  if (!sealingActive) return false;
  if (override === 'off') return false;
  if (override === 'on') return true;
  return !!ready;
}
function e2eMediaPinned() {
  const k = e2ePinKeyFor(TOKEN);
  const pins = readState().e2ePins;
  const p = k && pins && pins[k];
  return !!(p && p.v === 1 && p.media);
}
function e2eStampMediaPin() {
  const k = e2ePinKeyFor(TOKEN);
  if (!k) return;
  const pins = readState().e2ePins || {};
  const cur = pins[k] || {};
  if (cur.v === 1 && cur.media) return;
  writeState({ e2ePins: { ...pins, [k]: { ...cur, v: 1, media: true, at: cur.at || new Date().toISOString() } } });
  e2eNote('channel PINNED as SEALED-MEDIA on this machine — a send whose media would ride CLEAR here is now refused, even if the server claims the media gate closed. Genuine downgrade (a legacy device joined, or E2E off) ⇒ PIDGE_E2E_MEDIA=off locally.');
}
const E2E_MEDIA_UNPIN_HINT = 'If the downgrade is GENUINE (a legacy device joined the account, or your human turned E2E off), unpin media locally: PIDGE_E2E_MEDIA=off (env var, or a line in the env file). A server response alone can never unpin.';

// Attachment filenames are attacker-influenceable — sanitize before ANY disk
// write: no separators, no dot-leading names, bounded length. null = unusable
// (the caller falls back to attachment-<id>). Exported for tests.
function sanitizeAttachmentName(name) {
  if (typeof name !== 'string') return null;
  const base = path.basename(name.replaceAll('\\', '/')).replace(/^\.+/, '').trim();
  if (!base) return null;
  return base.slice(0, 255);
}

// The media plan for THIS send, decided BEFORE any bytes leave the machine:
//   null                       — clear media (the path of always), or no media;
//   { key, channelId, cid }    — seal each local blob under these + media_enc.
// Refusals (exit 2) happen HERE, pre-upload, so a downgrading/lying server
// never receives clear bytes or a real filename (the pin-refuses-before-upload rule).
async function e2eMediaPlan(payload) {
  const hasMedia = v.image !== undefined || v.file !== undefined;
  if (!hasMedia) return null;
  const mediaPinned = e2eMediaPinned() && e2eMediaOverride() !== 'off' && !e2eOverrideOff();
  const mat = e2eKeyMaterial();
  if (!mat) {
    if (mediaPinned) die(`pidge: REFUSING to send CLEAR MEDIA (exit 2) — this channel is locally PINNED as sealed-media but PIDGE_SECRET is missing/invalid. Fix the secret (the app's Connect screen has the terminal step). ${E2E_MEDIA_UNPIN_HINT}`, 2);
    return null;
  }
  let ch;
  try {
    ch = await e2eChannelInfo();
  } catch (e) {
    if (mediaPinned) die(`pidge: REFUSING to send CLEAR MEDIA (exit 2) — this channel is locally PINNED as sealed-media and the server won't confirm its media gate (${e.message}); retry when it's reachable. ${E2E_MEDIA_UNPIN_HINT}`, 2);
    return null; // the text-seal path warns about the whoami failure already
  }
  const willSeal = e2eMediaSealDecision({
    sealingActive: ch.e2eEnabled && !e2eOverrideOff(),
    ready: ch.e2eMediaReady,
    override: e2eMediaOverride(),
  });
  if (!willSeal) {
    if (mediaPinned) die(`pidge: REFUSING to send CLEAR MEDIA (exit 2) — this machine PINNED the channel as sealed-media but this send's media would ride CLEAR (the server says ${ch.e2eEnabled ? 'the media gate is closed — e2e_media_ready:false' : 'the channel is not E2E'}). ${E2E_MEDIA_UNPIN_HINT}`, 2);
    return null;
  }
  // A public-URL --image can't be sealed (we don't hold its bytes' custody) and
  // a mixed send (media_enc + a clear image_url) would make the phone try to
  // unseal clear bytes — the broken photo the gate exists to prevent. Refuse.
  if (v.image !== undefined && !fs.existsSync(v.image)) {
    die('pidge: --image with a URL/ref cannot ride a SEALED-media send — the bytes must be sealed on this machine. Download the image and pass a local path (or PIDGE_E2E_MEDIA=off to send this one clear).', 2);
  }
  if (!payload.correlation_id) payload.correlation_id = crypto.randomUUID();
  return { key: mat.key, channelId: ch.id, cid: payload.correlation_id };
}

// SEND-side sealing, called by doNotify on the final payload. Mutates it:
// content fields + custom-action LABELS become envelopes (action IDs stay
// clear — the action contract runs on ids), enc:"v1" + kf ride alongside, and
// the correlation_id is ALWAYS minted client-side (the AAD needs it BEFORE the
// server ever sees the payload).
// Server-side length caps on the columns these fields land in
// — the AES-GCM+base64url envelope inflates ~4/3 + a prefix, so a value that
// fits in CLEAR can 422 once sealed. We check locally with a message that names
// the CAUSE (the server's bare "too long" wouldn't tell the agent it was E2E).
const E2E_SEALED_FIELD_CAPS = { copy: 512, url: 1024 };

// The refusal MESSAGE when a PINNED channel would otherwise send CLEAR, or null
// when the send may proceed (sealed, or legitimately clear on an unpinned
// channel). Shared by the pre-upload preflight AND e2eMaybeSeal so the two can
// never diverge — and so the pin can REFUSE before any bytes leave the machine
// (a real bug once: media upload used to precede the gate). whoami is cached,
// so calling this twice per send is cheap; when NOT pinned it returns early and
// pays no whoami, keeping the common clear path fast.
async function e2eRefusalIfPinned() {
  if (!(e2ePinned() && !e2eOverrideOff())) return null;
  if (!e2eKeyMaterial())
    return `pidge: REFUSING to send CLEAR (exit 2) — this channel is locally PINNED as E2E but PIDGE_SECRET is missing/invalid. Fix the secret (the app's Connect screen has the terminal step that writes it). ${E2E_UNPIN_HINT}`;
  try {
    const ch = await e2eChannelInfo();
    if (!ch.e2eEnabled)
      return `pidge: REFUSING to send CLEAR (exit 2) — the server says this channel is NOT E2E, but this machine PINNED it as E2E (a lying/compromised server could be downgrading you to plaintext). ${E2E_UNPIN_HINT}`;
  } catch (e) {
    return `pidge: REFUSING to send CLEAR (exit 2) — this channel is locally PINNED as E2E and the server won't confirm its E2E state (${e.message}). A server that can't answer whoami must not be able to downgrade you to plaintext; retry when it's reachable. ${E2E_UNPIN_HINT}`;
  }
  return null;
}

// Called by doNotify BEFORE resolveMedia: on a pinned channel that would
// downgrade to clear, die HERE — so a compromised server never receives the
// upload bytes/filename (which ride clear when media sealing is off) in the first place.
async function e2ePreflightRefusal() {
  const reason = await e2eRefusalIfPinned();
  if (reason) die(reason, 2);
}

async function e2eMaybeSeal(payload) {
  const reason = await e2eRefusalIfPinned();
  if (reason) die(reason, 2); // pinned + would-be-clear (the preflight already caught this pre-upload; belt and suspenders)
  const mat = e2eKeyMaterial();
  if (!mat) return; // unpinned + no secret ⇒ clear send is the contract
  let ch;
  try {
    ch = await e2eChannelInfo();
  } catch (e) {
    console.error(`pidge: WARNING — couldn't confirm the channel's E2E state (${e.message}); sending CLEAR (an E2E channel accepts-and-marks it "⚠️ sem criptografia")`);
    return;
  }
  if (!ch.e2eEnabled) return; // unpinned orphan secret — clear send; `pidge doctor` warns
  if (!payload.correlation_id) payload.correlation_id = crypto.randomUUID();
  const seal = (field, value) =>
    e2eEncryptField(mat.key, e2eAad(ch.id, payload.correlation_id, field), String(value));
  for (const f of E2E_CONTENT_FIELDS) {
    if (payload[f] !== undefined && payload[f] !== null && payload[f] !== '') payload[f] = seal(f, payload[f]);
  }
  for (const ca of payload.custom_actions || []) {
    if (E2E_NEVER_SEAL_LABEL_IDS.has(ca.id)) continue; // builtin/system id — the label rides CLEAR
    if (typeof ca.label === 'string' && ca.label !== '') ca.label = seal(`action_label_${ca.id}`, ca.label);
  }
  for (const [f, cap] of Object.entries(E2E_SEALED_FIELD_CAPS)) {
    if (typeof payload[f] === 'string' && payload[f].length > cap)
      die(`pidge: --${f} is too long to send ENCRYPTED — its sealed envelope is ${payload[f].length} chars but the server caps ${f} at ${cap} (E2E inflates a value ~33%). Shorten it, or send it in the body.`, 2);
  }
  payload.enc = 'v1';
  payload.kf = mat.kf;
  e2eStampPin(mat.kf); // a CONFIRMED sealed context latches the anti-downgrade pin
  if (payload.media_enc === 'v1') {
    e2eStampMediaPin(); // a CONFIRMED sealed-media send latches the media pin too
    console.error('pidge: E2E — media bytes + filename sealed');
  } else if (payload.image !== undefined || payload.file !== undefined) {
    console.error('pidge: E2E note — this send\'s media BYTES and filename ride CLEAR (the media gate is closed: whoami e2e_media_ready:false until an iOS build that opens sealed media is on all devices; PIDGE_E2E_MEDIA=on forces it). The text fields, copy and url are sealed.');
  }
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
//   kind:"message": the row's own enc/kf/correlation_id; body opens with
//     field ALWAYS "message" (composer AND late-reply — the late reply reuses
//     the answered notification's cid as its correlation_id);
//   kind:"notification_reply": the envelope rides ref/ref_payload — ref.enc
//     gates; text opens with field "reply", ref.title with "title", and a body
//     that is a custom-action LABEL with "action_label_<action_id>".
// On success the plaintext replaces the ciphertext and enc/kf are swapped for
// e2e:"decrypted" (an agent re-gating on `enc` must never mistake plaintext for
// an envelope); on failure the sealed fields are BLANKED and e2e_error says why.
async function e2eOpenMessageRow(m, dl = {}) {
  const refEnc = m.ref && m.ref.enc;
  const out = { ...m };
  const fail = (reason) => { if (!out.e2e_error) out.e2e_error = reason; e2eNote(reason); };
  if (!m.enc && !refEnc) {
    // a clear line renders as always (pre-E2E history) — but a clear ATTACHMENT
    // may still want the opt-in --download save.
    if (m.attachment) await e2eProcessAttachment(m, out, fail, dl);
    return m.attachment ? out : m;
  }
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
  if (m.attachment) await e2eProcessAttachment(m, out, fail, dl); // inbound media
  if (!out.e2e_error) {
    delete out.enc; delete out.kf;
    if (out.ref) { delete out.ref.enc; delete out.ref.kf; }
    out.e2e = 'decrypted';
  }
  return out;
}

// you→agent: one message's attachment. A SEALED one ({enc:"v1"} on the
// block) is ALWAYS downloaded + unsealed to a local file — its signed URL
// serves ciphertext, useless to an agent otherwise; the plaintext lands at
// <config dir>/downloads/<message id>/<sanitized real filename> and rides the
// printed JSON as `attachment.path`. A CLEAR one passes through (its url is
// directly fetchable) unless --download asks for the same save. Failures are
// precise e2e_error/stderr — and ciphertext is NEVER written where a file is
// expected.
async function e2eProcessAttachment(m, out, fail, dl = {}) {
  const att = m.attachment;
  if (!att || typeof att !== 'object') return;
  out.attachment = { ...att };
  // catchup (esp. the --digest session-start ritual) must not re-fetch +
  // re-unseal every attachment every run. `noDownload` skips the bytes entirely
  // (the row already carries the name/sealed flag — enough to LIST it);
  // `skipIfExists` reuses a copy already on disk (byte_size match for clear
  // rows; existence for sealed, whose plaintext size ≠ the ciphertext byte_size).
  const noDownload = !!dl.noDownload;
  const skipIfExists = !!dl.skipIfExists;
  const absUrl = (u) => (typeof u === 'string' && u.startsWith('/') ? `${BASE}${u}` : u);
  const download = async () => {
    const res = await fetchT(absUrl(att.url));
    if (!(res.status >= 200 && res.status < 300)) throw new Error(`download answered ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  const destFor = (filename) => {
    const dir = v['download-dir'] || path.join(pidgeConfigDir(), 'downloads');
    // m.id comes off the wire — a hostile server (the E2E threat model)
    // could ship "../.." to steer the decrypted plaintext OUTSIDE the downloads
    // dir. Sanitize the id segment AND the fallback name exactly like any other
    // attacker-influenceable wire string, so both path parts are contained.
    const idSeg = sanitizeAttachmentName(String(m.id)) || 'msg';
    const name = sanitizeAttachmentName(filename) || `attachment-${idSeg}`;
    return path.join(dir, idSeg, name);
  };
  // a copy already on disk (existence for sealed; size match for clear)?
  // a 0-byte file is NEVER cache — a crash mid-write (pre-
  // atomic builds) or an ENOSPC could leave a truncated husk that would
  // otherwise become a permanent "cached" lie. Writes below are tmp+rename
  // (atomic on the same fs), so a partial write can't land at dest at all.
  const cached = (dest) => {
    try {
      const st = fs.statSync(dest); // throws if missing
      if (st.size === 0) return false;
      if (att.enc) return true; // sealed: plaintext already decrypted here once
      return att.byte_size == null || st.size === att.byte_size;
    } catch { return false; }
  };
  // m3: atomic write — tmp in the SAME dir then rename, so a crash/ENOSPC
  // mid-write never leaves a truncated file where cached() would trust it.
  const writeAtomic = (dest, bytes) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, dest);
  };
  if (att.enc) {
    if (att.enc !== 'v1') {
      return fail(`attachment sealed with an unknown envelope version ${JSON.stringify(att.enc)} — this CLI speaks v1 (update pidge-cli)`);
    }
    const reason = e2eSealedError('v1', m.kf)
      || (!m.correlation_id && 'attachment is sealed but the row carries NO correlation_id (the AAD anchor) — it can never be decrypted')
      || null;
    if (reason) return fail(reason);
    const mat = e2eKeyMaterial();
    // The real filename is a "message_filename" envelope on a sealed attachment.
    // Decrypted from the ROW (no network) — so we can name/dest a sealed blob
    // even under --no-download.
    let name = att.filename;
    if (isEnvelope(name)) {
      try {
        name = e2eDecryptField(mat.key, e2eAad(m.channel_id, m.correlation_id, 'message_filename'), name);
        out.attachment.filename = name;
      } catch (e) {
        out.attachment.filename = null;
        return fail(`attachment filename failed to open: ${e.message}`);
      }
    }
    const dest = destFor(name);
    if (noDownload) {
      out.attachment.sealed = true; // present-only marker — bytes NOT fetched
      e2eNote(`attachment ${name || '(sealed)'} not downloaded (--no-download / --digest)`);
      return;
    }
    if (skipIfExists && cached(dest)) {
      out.attachment.path = dest;
      delete out.attachment.enc;
      e2eNote(`attachment already on disk → ${dest} (skipped re-download)`);
      return;
    }
    try {
      const plain = e2eDecryptBlob(mat.key, e2eAad(m.channel_id, m.correlation_id, 'message_blob'), await download());
      writeAtomic(dest, plain); // m3: never a truncated plaintext at dest
      out.attachment.path = dest;
      delete out.attachment.enc;
      e2eNote(`attachment decrypted → ${dest}`);
    } catch (e) {
      fail(`attachment failed to open: ${e.message}`);
    }
  } else if (!noDownload && (v.download || v['download-dir'])) {
    const dest = destFor(att.filename);
    if (skipIfExists && cached(dest)) {
      out.attachment.path = dest; // reuse the copy already saved
      return;
    }
    try {
      const bytes = await download();
      writeAtomic(dest, bytes); // m3: same atomicity for the clear save
      out.attachment.path = dest;
    } catch (e) {
      console.error(`pidge: WARNING — attachment download failed (${e.message}); the url in the JSON is still fetchable`);
    }
  }
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
// carries subcommand-supplied raw fields (the typed sends' template_kind and
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
  // --note → sent_note — the WHY of this send, attributed to this
  // runtime so a successor reads "who armed what, and why". CLEAR metadata (never
  // sealed on E2E channels, D6) — keep secrets out. Server truncates; it never 422s.
  if (v.note !== undefined) body.sent_note = v.note;
  if (v['collapse-key'] !== undefined) body.collapse_key = v['collapse-key'];

  // --actions: the short comma form (built-in catalog ids → body.actions) OR a
  // JSON array of custom {id,label,…} specs (→ body.custom_actions). A
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

  // REFUSE a decision button + `reply` in the same send (the skill's
  // anti-slop rule). The human taps the easy Yes/No and you get a useless
  // "Yes" instead of the typed text you wanted. One question per send — enforce
  // it locally (exit 1, no round-trip), don't warn-and-send. (`reply` alongside a
  // non-decision like done/snooze is fine — DONE_REPLY is a real category.)
  if (Array.isArray(body.actions) && body.actions.includes('reply')) {
    const DECISION_ACTIONS = ['yes', 'no', 'approve', 'reject', 'accept', 'decline', 'later'];
    const decisions = body.actions.filter((a) => DECISION_ACTIONS.includes(a));
    if (decisions.length)
      die(`pidge: --actions can't combine a decision button (${decisions.join(',')}) with \`reply\` — the human taps the easy button and you get a useless "${decisions[0]}" instead of the text you wanted. Use \`--actions reply\` ALONE for a typed answer, or drop \`reply\` for a button decision. One question per send.`, 1);
  }

  // --gated synthesizes ONE Face-ID confirm on the consequential action
  // (money/deletion) — the replacement for the retired content_template:sensitive.
  // Skip if the agent already supplied a biometric action (don't double-gate).
  if (v.gated && !(body.custom_actions || []).some((c) => c.biometric)) {
    body.custom_actions = (body.custom_actions || []).concat([
      { id: 'confirm_action', label: 'Confirm', style: 'destructive', confirm: true, biometric: true, terminal: true },
    ]);
  }

  // subcommand-supplied raw fields (template_kind, alert's escalate). Applied
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
  return uploadBlob(fs.readFileSync(filePath), path.basename(filePath), guessMime(filePath));
}

// A SEALED upload carries a generic name + octet-stream — the real
// filename rides the /notify as an envelope, never the multipart.
async function uploadBlob(bytes, filename, type) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type }), filename);
  let res, raw;
  try {
    res = await fetch(`${BASE}/api/v1/uploads`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, ...identityHeaders() }, body: fd,
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
// With a mediaPlan, each local blob is SEALED before upload
// ([0x01][nonce][ct][tag], AAD "ch<id>:<cid>:image_blob|file_blob"), uploads as
// a generic blob.bin, the file's real name becomes a `filename` envelope (AAD
// field "filename") and the send is flagged media_enc:"v1".
async function resolveMedia(body, mediaPlan = null) {
  for (const key of ['image', 'file']) {
    if (v[key] === undefined) continue;
    if (fs.existsSync(v[key])) {
      if (mediaPlan) {
        const sealed = e2eEncryptBlob(
          mediaPlan.key,
          e2eAad(mediaPlan.channelId, mediaPlan.cid, `${key}_blob`),
          fs.readFileSync(v[key])
        );
        body[key] = await uploadBlob(sealed, 'blob.bin', 'application/octet-stream');
        if (key === 'file') {
          body.filename = e2eEncryptField(
            mediaPlan.key, e2eAad(mediaPlan.channelId, mediaPlan.cid, 'filename'),
            path.basename(v[key])
          );
        }
        body.media_enc = 'v1';
      } else {
        body[key] = await uploadFile(v[key]);
      }
    } else if (key === 'file' && (/^[./~]/.test(v[key]) || v[key].includes('/'))) {
      // --file is PATH-only (no URL form) — fail fast on a typo'd path; the remote
      // 422 ("ref invalid — re-upload") would misdirect the agent's self-heal.
      die(`pidge: --file: no such file: ${v[key]}`, 1);
    } else if (mediaPlan) {
      // A pre-minted ref holds bytes this machine never sealed — riding it on a
      // media_enc send would serve clear bytes the phone tries to unseal.
      die(`pidge: --${key} with a pre-minted ref cannot ride a SEALED-media send — pass the local path so the bytes seal here (or PIDGE_E2E_MEDIA=off to send this one clear).`, 2);
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
  // A PINNED channel must refuse BEFORE resolveMedia
  // uploads any bytes — otherwise a lying server captures the file/filename
  // (which ride clear when media sealing is off) even though the /notify is then refused.
  await e2ePreflightRefusal();
  // Decide the media fate BEFORE any bytes leave the machine — the
  // plan seals local blobs in resolveMedia; a media-pinned channel that would
  // downgrade to clear media refuses HERE, pre-upload.
  const mediaPlan = await e2eMediaPlan(payload);
  await resolveMedia(payload, mediaPlan);
  // E2E: seal the content AFTER everything else composed the payload —
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
    // the same correlation_id while still scheduled EDITS in place.
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
    // threads — remind the agent how to keep the conversation grouped.
    if (info.thread_id)
      console.error(`pidge: thread=${info.thread_id} — send follow-ups with the same --thread to group them on the phone`);
  } else {
    console.error(`pidge: send failed (${res.status}): ${raw}`);
  }
  return { ok, info, raw };
}

// The RESPONSE axis: true when the send carries SOME way for the human
// to answer with a tap — built-in actions, custom actions, or a content --template
// that supplies them. Free-text reply is ALWAYS available, so this is only about
// buttons. `ask` requires it; `approval` injects a default pair when it's absent.
const hasAnswerAffordance = () =>
  v.actions !== undefined || (v['custom-action'] || []).length > 0 || v.template !== undefined;

// The `approval` recipe's default button pair. Sent as
// CUSTOM actions, NOT built-ins: only custom_actions can carry `biometric` (Face
// ID), and a custom id may NOT reuse a built-in id like approve/reject (the server
// 422s "collides with a built-in") — so the ids are grant/deny. Face ID gates the
// consequential "Approve"; "Reject" is the safe (destructive-styled) out. A gated
// action is detail-screen only (no banner buttons), by design.
const APPROVAL_ACTIONS = [
  { id: 'grant', label: 'Approve', biometric: true, terminal: true },
  { id: 'deny', label: 'Reject', style: 'destructive', terminal: true },
];

// The married catalog of 5: one send, stamped with the canonical
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

  // validate the wait knobs BEFORE the send — a typo must die here (exit 1),
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
  // no --timeout ⇒ obey the template's suggestion from the 201 echo (human
  // decisions take 30-40 min; a 600 s default misreads them as silence). Explicit wins.
  let timeout = timeoutArg;
  if (!Number.isFinite(timeout)) {
    if (info.suggested_ask_timeout) {
      timeout = info.suggested_ask_timeout;
      console.error(`pidge: timeout ${Math.round(timeout / 60)} min — suggested by template ${info.template || v.template} (override with --timeout)`);
    } else if (info.requires_action) {
      timeout = 3600;   // a human decision (buttons present) takes 30-40 min, not 600 s of "silence"
      console.error(`pidge: no template suggestion — defaulting --wait to 60 min for a decision (override with --timeout)`);
    } else {
      timeout = 600;
    }
  }
  await waitForAnswer(cid, { timeout, interval: intervalArg });
}

// `pidge live` — the wrapper over the three
// /live_activities endpoints. By default the write lands as an ENTRY of the
// user's consolidated status-center card; the response's `operation` echo
// (started|updated|noop|rotated|ended) is the truth of what happened. The old
// behavior (template_kind:live → a silently-degraded message-profile /notify)
// is dead.
async function doLive() {
  if (v.wait)
    die("pidge: `live` can't --wait — a status card never produces an answer (drop --wait, or ask with a real type)", 1);
  if (v.paused && v.resume) die('pidge: pass --paused OR --resume, not both', 1);
  const cid = parsed.positionals[1] || v['correlation-id'];

  // --step N/M is SUGAR: there is no steps field on the wire — it becomes
  // progress + the fraction label the bar renders.
  let progress; let progressLabel;
  if (v.step !== undefined) {
    if (v.progress !== undefined) die('pidge: pass --step OR --progress, not both', 1);
    const m = String(v.step).match(/^(\d+)\s*\/\s*(\d+)$/);
    if (!m || Number(m[2]) === 0) die('pidge: --step must look like 3/5 (done/total)', 1);
    progress = Math.min(1, Number(m[1]) / Number(m[2]));
    progressLabel = `${m[1]}/${m[2]}`;
  } else if (v.progress !== undefined) {
    progress = Number(v.progress);
    if (!Number.isFinite(progress)) die(`pidge: --progress ${JSON.stringify(v.progress)} is not a number (0..1)`, 1);
  }

  const prune = (obj) => Object.fromEntries(Object.entries(obj).filter(([, x]) => x !== undefined));
  let method; let apiPath;
  let body;
  if (v.end) {
    if (!cid) die('pidge: usage: pidge live <correlation_id> --end [--outcome "…"] [--linger N]', 1);
    method = 'POST';
    apiPath = `/api/v1/live_activities/${encodeURIComponent(cid)}/end`;
    body = prune({
      status: v.status, symbol: v.symbol, detail: v.detail, progress,
      outcome: v.outcome,
      linger_seconds: v.linger !== undefined ? numStrict(v.linger, '--linger', undefined) : undefined,
    });
  } else {
    body = prune({
      correlation_id: cid,
      title: v.title, status: v.status, symbol: v.symbol, detail: v.detail,
      progress, progress_label: progressLabel,
      started_at: v['starts-at'], ends_at: v['ends-at'],
      is_running: v.paused ? false : (v.resume ? true : undefined),
      presentation: v.dedicated ? 'dedicated' : undefined,
    });
    if (v.title !== undefined) {
      // POST upserts by correlation_id — start OR update in one shape.
      method = 'POST';
      apiPath = '/api/v1/live_activities';
    } else {
      if (!cid)
        die('pidge: pass --title to start a card, or <correlation_id> (or --correlation-id) to update one', 1);
      method = 'PATCH';
      apiPath = `/api/v1/live_activities/${encodeURIComponent(cid)}`;
      delete body.correlation_id;
    }
  }

  let res; let raw;
  try {
    res = await fetch(`${BASE}${apiPath}`, { method, headers, body: JSON.stringify(body) });
    raw = await res.text();
  } catch (e) {
    die(`pidge: live ${v.end ? 'end' : 'write'} failed (network): ${e.message}`, 2);
  }
  await checkManifestNews(res);
  console.log(raw); // machine output: the full response JSON (operation/degraded included)
  const ok = res.status >= 200 && res.status < 300;
  let info = {};
  try { info = JSON.parse(raw); } catch { /* leave {} */ }
  if (!ok) {
    if (res.status === 404 && method === 'PATCH')
      console.error(`pidge: no card with correlation_id=${cid} on this channel — add --title to START it (POST upserts)`);
    else
      console.error(`pidge: live ${v.end ? 'end' : 'write'} failed (${res.status})`);
    process.exit(2);
  }
  if (info.correlation_id)
    console.error(`pidge: correlation_id=${info.correlation_id} (update: pidge live ${info.correlation_id} --status "…" · end: pidge live ${info.correlation_id} --end --outcome "…")`);
  if (info.degraded)
    console.error(`pidge: DEGRADED — ${info.reason || 'over budget'}: the card landed as a status-center entry, not a dedicated one (nothing was dropped)`);
  if (info.operation === 'noop')
    console.error('pidge: noop — identical to the current state (your staleness TTL was refreshed; no push burned)');
  if (info.operation === 'rotated')
    console.error('pidge: rotated — the device card had been dismissed; it was re-created via push-to-start');
  if (info.renderable_devices === 0)
    console.error('pidge: 0 devices can render Live Activities — the card goes nowhere (open the app once to register)');
  process.exit(0);
}

// `pidge approve` — a hook-shaped, DENY-DEFAULT permission gate. Sends a
// Face-ID approval and BLOCKS, then maps the human's tap to an exit code: ONLY an
// explicit allow is exit 0; deny, timeout, a dead channel or any ambiguity is
// non-zero (exit 1) so a PreToolUse hook fails CLOSED. A thin wrapper over the
// ask/wait long-poll: it fixes the two gated actions and swaps print-and-exit-0
// for the exit-code mapping (via waitForAnswer's onAnswer/onTimeout).
async function doApprove() {
  const question = parsed.positionals[1] || v.title;
  if (!question)
    die('pidge: usage: pidge approve "<question>" [--body TEXT] [--timeout N] [--allow-label L] [--deny-label L]', 1);
  // a typo in the knobs must die HERE (exit 1, fail-closed), before the
  // approval is even sent — a NaN deadline would hang this gate open forever.
  const timeout = numStrict(v.timeout, '--timeout', 300);
  const interval = numStrict(v.interval, '--interval', 30);
  // an interrupt mid-wait is NOT an approval — exit 1 loudly (deny-default),
  // like every other unanswered path out of this gate.
  process.on('SIGINT', () => {
    console.error('pidge: interrupted before an answer — DENIED (deny-default; nothing was approved). exit 1');
    process.exit(1);
  });
  v.title = question;
  const allowLabel = v['allow-label'] || 'Allow';
  const denyLabel = v['deny-label'] || 'Deny';
  // allow = Face-ID confirm (both confirm+biometric) · deny = destructive out.
  // Both terminal, both gated ⇒ the server resolves the push to a detail-only
  // category: approving is a deliberate in-app Face-ID tap, never a one-tap banner.
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

// A compat alias: the OLD type name still works, mapped to the new
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
// Long-poll: each GET carries ?wait=N (≤55 s) and the SERVER holds it until
// the user acts — answer latency ~instant, ~1 request/min. --interval is only the
// fallback pace against an old server that ignores `wait` (returns immediately).
// onAnswer(chosen)/onTimeout() let a caller (approve) MAP the outcome to an
// exit code instead of the default print-chosen+exit-0 / exitTimeout. Both
// callbacks MUST exit the process; when omitted the wait/ask behavior stands.
async function doWait(cid, { timeout, interval, onAnswer, onTimeout } = {}) {
  const deadline = Date.now() + timeout * 1000;
  let firedNotice = false;
  for (;;) {
    // Degraded: a held poll keeps dying behind some edge — switch to
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
          // stopping the ring on-device now reports `seen` (seen_at flips);
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

// Realtime wait: hold an InboxChannel subscription and treat every frame
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
    params: wsIdentityParams(),
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
  // remaining budget, NOT exit lying that the full timeout elapsed.
  if (outcome === 'deadline' && Date.now() >= deadline - 1500) {
    if (onTimeout) return onTimeout();
    health.exitTimeout(`no answer on ${cid}`);
  }
  console.error('pidge: realtime unavailable — falling back to HTTP polling (same contract, less instant)');
  return Math.max(1, Math.ceil((deadline - Date.now()) / 1000)); // remaining budget
}

// wait/ask entry: WS when we can, polling as the universal fallback.
// onAnswer/onTimeout thread through to both paths so `approve` can map the
// outcome to an exit code; omit them for the default print-and-exit-0 behavior.
async function waitForAnswer(cid, { timeout, interval, onAnswer, onTimeout } = {}) {
  let budget = timeout;
  if (wantRealtime()) budget = await realtimeWait(cid, { timeout, interval, onAnswer, onTimeout });
  await doWait(cid, { timeout: budget, interval, onAnswer, onTimeout });
}

const num = (val, fallback) => (val !== undefined ? parseInt(val, 10) : fallback);

// STRICT variant for the blocking knobs (--timeout/--interval). parseInt('abc')
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

// message-queue ids are STRICT integers. parseInt alone is lazy —
// parseInt("9f2e7c31-…") === 9 — so an agent that pastes a correlation_id where
// the numeric listen id belongs would silently ack messages 1..9 it never
// handled (at-least-once loss, the exact class the strict --timeout parse killed).
// Full-string digits or die loud, BEFORE any HTTP.
const idStrict = (val, flag) => {
  const s = String(val).trim();
  if (!/^\d+$/.test(s))
    die(`pidge: ${flag} ${JSON.stringify(val)} is not a numeric message id — it takes the NUMERIC id from listen output, never the correlation_id. exit 1`, 1);
  return parseInt(s, 10);
};

// ---------------------------------------------------------------------------
// Onboarding v2: setup --claim / doctor / whoami / skill install.
// ---------------------------------------------------------------------------

// (CONFIG_DIR/CONFIG_FILE are defined early — right after TOKEN — so the identity
// headers can hash CONFIG_FILE at the module-level `headers` const.)
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
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...identityHeaders() },
  });
  let data = {};
  try { data = await res.json(); } catch { /* leave {} */ }
  return { res, data };
}

// identity ownership: a STABLE, privacy-safe per-install fingerprint (a
// HASH, never raw hostname/PII) so the server can tell THIS install apart from a
// different agent that grabbed the same key. The label is the human-readable
// self-name (PIDGE_LABEL, else PIDGE_AGENT, else the hostname).
function agentFingerprint() {
  const material = [ os.hostname(), os.userInfo().username || '', AGENT_ID, CONFIG_FILE ].join('|');
  return 'fp_' + crypto.createHash('sha256').update(material).digest('hex').slice(0, 24);
}
function agentLabel() {
  const raw = (process.env.PIDGE_LABEL || AGENT_ID || os.hostname() || 'pidge-cli').slice(0, 80);
  // .slice(0, 80) cuts by CODE UNIT and can split a
  // surrogate pair (an astral char — emoji — at the 80 boundary). A lone
  // surrogate makes encodeURIComponent THROW URIError, and identityHeaders()
  // feeds the module-level `headers` const — so EVERY verb would die at load,
  // purely input-dependent. Sanitize to well-formed UTF-16: toWellFormed()
  // (Node ≥20) swaps lone surrogates for U+FFFD; the regex fallback (engines
  // allow Node ≥18) strips them instead — either way, encodable.
  return raw.toWellFormed
    ? raw.toWellFormed()
    : raw.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

// Multi-runtime v2: the per-REQUEST agent identity, sent on EVERY HTTP
// call as headers. Same fingerprint/label the claim computes — the claim
// becomes the server's FALLBACK; these headers are the primary. The label is
// URI-encoded (PIDGE_LABEL may be UTF-8, and raw bytes >127 are undefined across
// proxies/undici; the server decodes + sanitizes). Advisory, never auth (any key
// holder can wear any identity). An OLDER server ignores
// unknown headers, so this is harmless against an older server (release is gated
// on S1+S2 only so the PRINTED features exist, not because headers need lockstep).
function identityHeaders() {
  return {
    'x-pidge-fingerprint': agentFingerprint(),
    'x-pidge-label': encodeURIComponent(agentLabel()),
    // SIGN the call with the execution when a run bearer is in the env — so the
    // human sees which run spoke. Present-only: no run ⇒ unsigned (identical to
    // before). Advisory (never auth) and rides EVERY channel-key call because
    // this set feeds the shared `headers` const + whoami/claim/contract/skill.
    ...(RUN_TOKEN ? { 'x-pidge-run': RUN_TOKEN } : {}),
  };
}
// WS transport: identity rides the ActionCable subscribe params as
// JSON (NOT URI-encoded — it's a JSON string value, not a header). Passed only on
// the REAL consume subscribes (listen/wait/bridge), never the doctor realtime
// probe — a read-only diagnosis must not mint a phantom consumer.
function wsIdentityParams() {
  return { fingerprint: agentFingerprint(), label: agentLabel() };
}

// first-run notice: show the ack-after-work BREAKING-flip contract ONCE PER
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

// Shared by `doctor` AND `whoami`: narrate HONEST device reach —
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

// Shared by `doctor` AND `whoami`: SHOUT when a DIFFERENT install claimed
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

// POST /claim/ownership — stamp WHICH install wears this channel's key, so
// a multi-agent machine can DETECT a silent key swap. Best-effort: a server that
// predates it 404s (skip silently); a network blip never breaks setup. Returns
// the server's claim block or null.
async function claimOwnership(base, token) {
  try {
    const res = await fetchT(`${base}/api/v1/claim/ownership`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...identityHeaders() },
      body: JSON.stringify({ fingerprint: agentFingerprint(), label: agentLabel() }),
    });
    if (res.status !== 200) return null;
    const data = await res.json().catch(() => ({}));
    return data.claim || null;
  } catch { return null; }
}

// step 5: after onboarding, DECLARE how this agent operates so the human
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
  // alive (a supervisor or daemon holding the listen).
  if (!mode || mode === 'turn_based') contract = { listen_mode: 'turn_based', keep_connection_alive: false };
  else if (['persistent', 'external_daemon', 'always_on'].includes(mode)) contract = { listen_mode: mode, keep_connection_alive: true };
  else { console.error(`pidge: --listen-mode must be turn_based | persistent | external_daemon (got "${mode}") — skipping the contract declaration`); return null; }
  try {
    const res = await fetchT(`${base}/api/v1/channels/${channelId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...identityHeaders() },
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

// the CLOSED allowlist (mirrors the server's closed allowlist of contract keys) — so
// `contract set` and `setup` reject an unknown key / bad value type LOCALLY (exit
// 1) before the round-trip, instead of leaning on the server's 422.
const OPERATING_CONTRACT_SPEC = {
  keep_connection_alive: 'boolean',
  mirror_in_origin_session: 'boolean',
  // Match your RUNTIME. turn_based (no event loop — block-and-exit) · persistent
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

// operating_contract: DECLARE how you operate. ADVISORY, never policy —
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

// Orphan-zombie guard: when `npx pidge-cli listen` is launched as a
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

// ---------------------------------------------------------------------------
// The digest's per-row state — THREE states, not two. Deriving it
// from acked_by_label/handler_summary ALONE (the old two-state code) marked a row
// PENDING whenever the ack carried no note — even when the server had stamped
// `processed_at`. In the anti-redo tool, that's the worst lie: a successor reads
// PENDING and re-does finished work. So:
//   · handler_summary present        → `handled by X: <summary>`   (done, with a note)
//   · processed (processed_at OR a    → `✓ acked[ by X] (no note)`  (done, silently)
//     label) but no note
//   · neither                         → `PENDING`                    (genuinely not done)
function digestHandledState(m) {
  if (m.handler_summary) {
    const who = m.acked_by_label || 'another consumer';
    return `handled by ${who}: ${String(m.handler_summary).replace(/\s+/g, ' ').trim()}`;
  }
  if (m.processed_at || m.acked_by_label) {
    return `✓ acked${m.acked_by_label ? ` by ${m.acked_by_label}` : ''} (no note)`;
  }
  return 'PENDING';
}

// stale_from_prior_claim — newer servers serve it (Bool, top-level) on the
// channel-key GET /messages and on /whoami: the channel holds un-acked messages
// whose arrival PREDATES this install's ownership claim — probably a previous
// owner's leftover work, not fresh asks for you. ADVISORY in tone by design:
// the anchor has known false negatives (claim-code exchange doesn't set
// claimed_at) and false positives (a same-fingerprint re-doctor refreshes the
// anchor — benign, self-clears on drain). Surfaces:
// listen (session header), doctor, catchup, and the bridge boot.
// Warned ONCE per process (a long-lived bridge doesn't re-shout every poll).
let stalePriorClaimWarned = false;
const STALE_PRIOR_CLAIM_HINT = 'Run `pidge catchup` (read-only) to see what they are before acting on them.';
function warnStalePriorClaim(data, hint = STALE_PRIOR_CLAIM_HINT) {
  if (!data || data.stale_from_prior_claim !== true || stalePriorClaimWarned) return;
  stalePriorClaimWarned = true;
  console.error(`pidge: ⚠️ this channel holds unprocessed messages from a PRIOR claim — probably a previous owner's leftover work, not fresh asks for you (advisory). ${hint}`);
}

// ---------------------------------------------------------------------------
// Multi-runtime v2 surfacing — all PRESENT-ONLY: an older server omits the
// fields, so it yields silence, never a break.
// ---------------------------------------------------------------------------

// whoami/doctor: the channel's LIVE consumers. "(you)" is marked CLIENT-side
// by fingerprint compare — the server stays symmetric (no `you` flag).
// ⚠️ on consumer_conflict; a nudge on unattributed_listening.
function reportConsumers(data) {
  if (!Array.isArray(data.consumers)) return; // older server / no block
  const ours = agentFingerprint();
  const live = data.consumers.filter((c) => c && c.live);
  if (!live.length) {
    console.error('pidge: consumers — none live on this channel right now');
  } else {
    const line = live.map((c) => {
      const you = c.fingerprint === ours ? ' (you)' : '';
      const listening = c.listening ? ', listening' : '';
      return `${c.label || c.fingerprint || 'unknown'}${you}${listening}`;
    }).join(' · ');
    console.error(`pidge: consumers — ${live.length} live: ${line}`);
  }
  if (data.consumer_conflict === true)
    console.error('pidge: ⚠️  consumer_conflict — 2+ live consumers on this channel. One channel = one consumer: if that\'s a bridge/daemon, SITUATE with `pidge catchup` and do NOT `listen` here (double-consume).');
  if (data.unattributed_listening === true)
    console.error('pidge: note — an UNIDENTIFIED consumer is listening here (an old CLI, pre-0.25). It won\'t show above; upgrade it so its identity surfaces.');
}

// whoami/doctor: the predecessor's ack hygiene (the provenance block) — the
// "left N acks blind" nudge the successor reads first.
function reportProvenance(data) {
  const p = data.provenance;
  if (!p || typeof p !== 'object') return; // older server / no block
  const bits = [];
  if (p.processed != null) bits.push(`${p.processed} processed`);
  if (p.processed_without_summary) bits.push(`${p.processed_without_summary} acked WITHOUT a note`);
  if (p.processed_unattributed) bits.push(`${p.processed_unattributed} with no identity at all`);
  if (!bits.length) return;
  const since = p.since ? ` (since ${p.since})` : '';
  console.error(`pidge: provenance${since} — ${bits.join(' · ')}. A note-less ack means the work was done SILENTLY (\`pidge catchup\` can't say what) — get in the habit of \`ack --summary\`.`);
}

// The stay-online nudge — the product's core loop, said out loud at the moments
// an agent decides what to do NEXT (setup/hello/doctor just succeeded). Presence
// is a LOOP, not a state: listen (background, harness-tracked) → handle → ack →
// RELAUNCH. The relaunch is the step turn-based agents forget — the queue keeps
// messages safe meanwhile, but the human sees "offline" until something listens.
// stderr ONLY (stdout stays parseable JSON for agents), and SUPPRESSED when the
// channel already has a live consumer: nudging `listen` next to a live
// bridge/daemon would bait the exact double-consume the lockfile exists to stop.
const STAY_ONLINE_NUDGE = 'pidge: NEXT — stay online: run `npx -y pidge-cli@latest listen --all` (or its alias `pidge online`) as a background task YOUR HARNESS TRACKS (never a loose shell &). It blocks until a message lands: handle it, ack, RELAUNCH it. That loop is what "online" means.';
async function nudgeStayOnline(data = null) {
  try {
    if (!data) data = (await fetchWhoami()).data; // hello has no whoami in hand — best-effort
  } catch { return; } // the nudge must never fail the command that just succeeded
  const live = Array.isArray(data.consumers) ? data.consumers.filter((c) => c && c.live) : [];
  if (live.length) return; // someone IS online — the nudge would be wrong here
  console.error(STAY_ONLINE_NUDGE);
}

// listen + bridge: consumer_conflict, warned ONCE per process. The field rides
// whoami (bridge boot) AND the consume GET /messages (listen loop) — so a
// consuming loop learns a sibling started consuming without a second call.
let consumerConflictWarned = false;
function warnConsumerConflict(data) {
  if (!data || data.consumer_conflict !== true || consumerConflictWarned) return;
  consumerConflictWarned = true;
  console.error('pidge: ⚠️  another consumer is live on this channel (consumer_conflict). One channel = one consumer: you may be double-consuming a bridge/daemon\'s queue. Situate with `pidge catchup`; if a bridge owns this channel, stop this `listen`.');
}

// The in-flight lease holder on a delivered-but-unprocessed row, self-FILTERED
// — the CLI suppresses the block when the holder is its own fingerprint
// (self-noise). Returns a one-line "being handled by X since T" or null
// (absent block, or held by us).
function beingHandledLine(m) {
  const b = m && m.being_handled_by;
  if (!b || typeof b !== 'object') return null;
  if (b.fingerprint && b.fingerprint === agentFingerprint()) return null; // self
  // Execution attribution: a run-only lease (no fingerprint header on the serve)
  // identifies the holder by run seal — recognize OURSELF on that axis too, so a
  // run-signed caller never stands down for its own in-flight work.
  if (b.run_seal && process.env.PIDGE_RUN_SEAL && b.run_seal === process.env.PIDGE_RUN_SEAL) return null; // self (by run)
  const who = b.label || (b.run_seal ? `run ${b.run_seal}` : null) || b.fingerprint || 'another consumer';
  const since = b.since ? ` since ${b.since}` : '';
  return `being handled by ${who}${since}`;
}

// ---------------------------------------------------------------------------
// `pidge bridge --exec '<handler>'` — the 1st-class, model-agnostic
// supervisor. The bridge is deliberately DUMB: no local queue, no retry ledger
// of its own — durability lives in the server's ack/lease (reimplementing a
// local queue is an explicit non-goal).
//   loop: long-poll GET /messages?all=true (the robust long-poll floor; a realtime
//   socket, when available, is presence + early wake, never the data path)
//   → ONE handler invocation per batch (the whole tick as JSON on stdin — one
//   LLM invocation per batch, not per message) → handler exit 0 ⇒ ack --up-to
//   <last id> · non-zero ⇒ NOT acked (the ~10-min server lease re-serves).
// ---------------------------------------------------------------------------

// --- the single-consumer lock. PER-CHANNEL on purpose: keyed by
// hash(token) and living in the BASE ~/.config/pidge — PIDGE_AGENT is IGNORED
// here, because two agents wearing the SAME key are still one channel and MUST
// collide (a per-agent dir would hide exactly the double-consume this kills).
function bridgeLockBaseDir() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'pidge');
}
function bridgeLockPath() {
  const h = crypto.createHash('sha256').update(String(TOKEN)).digest('hex').slice(0, 16);
  return path.join(bridgeLockBaseDir(), `bridge-${h}.lock`);
}
function readBridgeLock(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return d && Number.isInteger(d.pid) ? d : null;
  } catch { return null; } // missing or garbage — the caller treats it as stale
}
// Is that pid a live process? Signal 0 probes without touching it. EPERM =
// "exists, but not ours to signal" — SUSPICIOUS, so treated as ALIVE: when we
// can't prove the holder is dead, refusing beats double-consuming.
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
// Whoever holds the channel lock RIGHT NOW (a live pid), or null. `listen`
// checks this to refuse double-consuming a channel a running bridge owns.
function bridgeLockHolder() {
  const cur = readBridgeLock(bridgeLockPath());
  return cur && pidAlive(cur.pid) ? cur : null;
}
function acquireBridgeLock() {
  const file = bridgeLockPath();
  fs.mkdirSync(bridgeLockBaseDir(), { recursive: true, mode: 0o700 });
  const payload = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), label: agentLabel() }) + '\n';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600); // atomic create-exclusive — the file IS the lock
      fs.writeSync(fd, payload);
      fs.closeSync(fd);
    } catch (e) {
      if (e.code !== 'EEXIST') die(`pidge: bridge — can't create the lock at ${file}: ${e.message}`, 2);
      const cur = readBridgeLock(file);
      if (cur && pidAlive(cur.pid))
        die(`pidge: bridge — REFUSED: another consumer already holds this channel (pid ${cur.pid}${cur.label ? `, "${cur.label}"` : ''}, since ${cur.started_at || '?'}). One consumer per channel — a second bridge/listen double-consumes. Stop it first, or read with \`pidge catchup\` (read-only). If you are CERTAIN no bridge is running (e.g. the pid belongs to an unrelated process), delete the lockfile yourself: rm "${file}"`, 2);
      // Stale lock: the pid is gone (a crashed bridge never releases — that's
      // WHY the lock stores a pid) or the file is garbage. So:
      // CLAIM the corpse by atomic RENAME — on the same fs exactly ONE racer's
      // rename succeeds; the loser gets ENOENT and refuses. This closes the
      // unlink-race window where two starters both saw the same stale pid and
      // the second unlinked the first's FRESH lock.
      const corpse = `${file}.stale.${process.pid}`;
      try {
        fs.renameSync(file, corpse);
      } catch (re) {
        die(`pidge: bridge — lost the stale-lock takeover race (${re.code}: another starter claimed it first) — refusing to double-consume. Re-run if you believe it also crashed.`, 2);
      }
      try { fs.unlinkSync(corpse); } catch { /* best-effort cleanup of the claimed corpse */ }
      console.error(`pidge: bridge — recovered a STALE lock (pid ${cur ? cur.pid : '?'} is gone; crashed bridge / power loss). Taking over.`);
      continue; // retry the exclusive create ONCE — a racing NEW starter makes us EEXIST → re-check above
    }
    // Paranoia re-read (belt on top of the rename): whoever the file names now
    // is the holder; if it isn't us, back off.
    const now = readBridgeLock(file);
    if (!now || now.pid !== process.pid)
      die(`pidge: bridge — lost the lock race to pid ${now ? now.pid : '?'} — refusing to double-consume.`, 2);
    return file;
  }
  die('pidge: bridge — couldn\'t acquire the lock (raced twice); try again.', 2);
}
function releaseBridgeLock(file) {
  // Remove only OUR lock: after a crash + takeover the file may name another pid.
  const cur = readBridgeLock(file);
  if (cur && cur.pid !== process.pid) return;
  try { fs.unlinkSync(file); } catch { /* best-effort */ }
}

// A LOCAL alert for the two "only a human can fix this" failures (401 —
// rotated key? — and a channel with no healthy round-trip). We can't pidge —
// that's exactly what's broken — so local is all there is: the stderr line is
// the alert of record (launchd/systemd capture it in the log), and a desktop
// notification is attempted best-effort. PIDGE_BRIDGE_ALERT=0 disables the
// desktop part (test/ops hook — tests must not pop notifications).
function localAlert(title, msg) {
  console.error(`pidge: bridge — 🔔 LOCAL ALERT: ${title} — ${msg}`);
  if (process.env.PIDGE_BRIDGE_ALERT === '0') return;
  try {
    const { spawn } = require('node:child_process');
    const [cmd, args] = process.platform === 'darwin'
      ? ['osascript', ['-e', `display notification ${JSON.stringify(msg)} with title ${JSON.stringify(`pidge bridge: ${title}`)}`]]
      : ['notify-send', [`pidge bridge: ${title}`, msg]];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch { /* the stderr line above is the alert of record */ }
}

// ── execution attribution (runs) ────────────────────────────────────────────
// A run is a server-issued, per-execution SIGNATURE — attribution, never a
// credential (the channel key still authenticates; the run token only stamps who
// spoke). An old server (/runs 404) makes every run verb degrade honestly.
const RUN_MODES = ['interactive', 'poll', 'bridge', 'custom'];
const RUN_ROLES = ['main', 'worker', 'subagent'];

async function runRunCommand() {
  const sub = parsed.positionals[1];
  if (sub === 'start') return runRunStart();
  if (sub === 'end') return runRunEnd();
  if (sub === 'status') return runRunStatus();
  die('pidge: usage: pidge run start [--mode M] [--role R] [--label L] [--parent-seal S] [--ephemeral] [--ttl N] [--json]  |  pidge run end  |  pidge run status', 1);
}

async function runRunStart() {
  const mode = (v.mode || 'custom').trim().toLowerCase();
  if (!RUN_MODES.includes(mode))
    die(`pidge: run start --mode must be ${RUN_MODES.join(' | ')} (got ${JSON.stringify(v.mode)})`, 1);
  let role = null;
  if (v.role !== undefined) {
    role = String(v.role).trim().toLowerCase();
    if (!RUN_ROLES.includes(role))
      die(`pidge: run start --role must be ${RUN_ROLES.join(' | ')} (got ${JSON.stringify(v.role)})`, 1);
  }
  const label = (v.label !== undefined ? String(v.label) : agentLabel()).slice(0, 80);
  const body = { mode, label };
  if (role) body.role = role;
  if (v['parent-seal']) body.parent_seal = String(v['parent-seal']);
  if (v.ephemeral) body.ephemeral = true;
  if (v.ttl !== undefined) body.ttl_seconds = numStrict(v.ttl, '--ttl', undefined);
  let res, data;
  try {
    res = await fetchT(`${BASE}/api/v1/runs`, { method: 'POST', headers, body: JSON.stringify(body) });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    die(`pidge: run start failed (network): ${e.message}`, 1);
  }
  await checkManifestNews(res);
  if (res.status === 404)
    die('pidge: run start — this server predates execution attribution (/runs 404). Update the server, or just keep sending: the channel key works unsigned.', 1);
  if (res.status < 200 || res.status >= 300 || !data.run_token)
    die(`pidge: run start failed (${res.status}): ${JSON.stringify(data)}`, 1);
  if (v.json) { console.log(JSON.stringify(data, null, 2)); process.exit(0); }
  const run = data.run || {};
  // stdout is EXACTLY the two export lines so `eval "$(pidge run start …)"`
  // arms the session; every narration goes to stderr (never pollutes the eval).
  console.log(`export PIDGE_RUN_TOKEN=${data.run_token}`);
  console.log(`export PIDGE_RUN_SEAL=${run.seal || ''}`);
  console.error(`pidge: run ${run.seal || '?'} started · mode ${run.mode || mode}${run.role ? ` · role ${run.role}` : ''}${run.ephemeral ? ' · ephemeral' : ''} — messages you send now are SIGNED with this execution (attribution, not a credential). End it with \`pidge run end\`.`);
  process.exit(0);
}

async function runRunEnd() {
  // env-ONLY, like every run bearer — never from FILE_ENV.
  const token = process.env.PIDGE_RUN_TOKEN || null;
  if (!token) {
    console.error('pidge: run end — no PIDGE_RUN_TOKEN in the environment; nothing to end (no-op).');
    process.exit(0);
  }
  let res, data;
  try {
    res = await fetchT(`${BASE}/api/v1/runs/end`, { method: 'POST', headers: { ...headers, 'x-pidge-run': token } });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    console.error(`pidge: run end — best-effort POST failed (network: ${e.message}); the server expiry reaps the run.`);
    process.exit(0);
  }
  await checkManifestNews(res);
  if (res.status >= 200 && res.status < 300)
    console.error(`pidge: run ${data.seal || process.env.PIDGE_RUN_SEAL || ''} ended.`);
  else
    console.error(`pidge: run end — server said ${res.status} (best-effort; the run expires on its own).`);
  process.exit(0);
}

async function runRunStatus() {
  let res, data;
  try {
    res = await fetchT(`${BASE}/api/v1/runs/active`, { headers });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    die(`pidge: run status failed (network): ${e.message}`, 1);
  }
  await checkManifestNews(res);
  if (res.status === 404)
    die('pidge: run status — this server predates execution attribution (/runs 404).', 1);
  if (res.status < 200 || res.status >= 300)
    die(`pidge: run status failed (${res.status}): ${JSON.stringify(data)}`, 1);
  const runs = Array.isArray(data.runs) ? data.runs : [];
  const own = process.env.PIDGE_RUN_SEAL || null; // mark THIS execution's row with a *
  if (runs.length === 0) { console.log('(no live runs)'); process.exit(0); }
  const header = ['RUN', 'MODE', 'ROLE', 'LABEL', 'LAST SEEN'];
  const rows = runs.map((r) => [
    (own && r.seal === own ? '*' : ' ') + (r.seal || '?'),
    r.mode || '-', r.role || '-', (r.label || '-').slice(0, 24), r.last_seen_at || '-',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => String(row[i]).length)));
  const fmt = (cols) => cols.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(fmt(header));
  for (const row of rows) console.log(fmt(row));
  process.exit(0);
}

async function runBridge() {
  const handlerCmd = v.exec;
  if (!handlerCmd)
    die('pidge: bridge needs --exec \'<handler command>\' — invoked ONCE per batch with the batch JSON on stdin; exit 0 acks the batch, non-zero leaves it for the server lease to re-serve. E.g.: pidge bridge --exec \'claude -p "handle this pidge batch"\'', 1);
  const { spawn } = require('node:child_process');

  // NO orphan watchdog here, deliberately (that guard is for `listen`): the bridge is
  // MEANT to outlive its launcher (nohup, a closed terminal, launchd) — its
  // lifecycle belongs to the supervisor and the lock, not to the parent pid.
  const lockFile = acquireBridgeLock();
  let lockReleased = false;
  const releaseOnce = () => { if (!lockReleased) { lockReleased = true; releaseBridgeLock(lockFile); } };
  process.on('exit', releaseOnce);

  // Pacing knobs. The env overrides are test/ops hooks, not documented knobs.
  const intervalS = numStrict(v.interval, '--interval', 5);
  // How long ONE handler invocation may run before SIGTERM
  // (default 30 min — an LLM handler can legitimately think for many minutes).
  const handlerTimeoutS = numStrict(v['handler-timeout'], '--handler-timeout', 1800);
  const HANDLER_NARRATE_MS = parseInt(process.env.PIDGE_BRIDGE_NARRATE || '', 10) || 300000; // 5 min
  // Lease/presence renew pace while a handler runs (issue #82) — see the heartbeat below.
  const RENEW_MS = parseInt(process.env.PIDGE_BRIDGE_RENEW || '', 10) || 60000; // 60 s
  const BACKOFF_BASE_MS = parseInt(process.env.PIDGE_BRIDGE_BACKOFF_BASE || '', 10) || 2000;
  const BACKOFF_MAX_MS = parseInt(process.env.PIDGE_BRIDGE_BACKOFF_MAX || '', 10) || 120000;
  const BACKOFF_LONG_MS = parseInt(process.env.PIDGE_BRIDGE_BACKOFF_LONG || '', 10) || 300000;
  const BROKEN_AFTER = 5;
  // Jitter EVERY retry sleep: N bridges restarting after the
  // same server deploy must not stampede back in lockstep.
  const jitter = (ms) => Math.round(ms * (0.75 + Math.random() * 0.5));

  let shuttingDown = false;
  let currentChild = null;
  let wake = null; // resolves the current sleep early (realtime frame / shutdown)
  const sleepInterruptible = (ms) => new Promise((resolve) => {
    const t = setTimeout(() => { wake = null; resolve(); }, ms);
    wake = () => { clearTimeout(t); wake = null; resolve(); };
  });

  // Hard case: SIGTERM/SIGINT must be CLEAN — forward the signal to an
  // in-flight handler, NEVER ack the in-flight batch (the lease re-serves it;
  // at-least-once is the contract, the handler must tolerate a replay), release
  // the lock, exit 0. The `shuttingDown` flag also closes the handler-exit→ack
  // race: an ack decision reached after the signal is refused even when the
  // handler finished 0 — acking during teardown could stamp "processed" on work
  // whose own side effects (the handler's sends) were cut short.
  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`pidge: bridge — ${sig}: shutting down cleanly. An in-flight batch is NOT acked (the server lease re-serves it).`);
    const finish = () => { releaseOnce(); process.exit(0); };
    if (currentChild && currentChild.exitCode === null && currentChild.signalCode === null) {
      try { currentChild.kill('SIGTERM'); } catch { /* already gone */ }
      const hardKill = setTimeout(() => { try { currentChild.kill('SIGKILL'); } catch { /* gone */ } finish(); }, 5000);
      if (hardKill.unref) hardKill.unref();
      currentChild.once('exit', () => { clearTimeout(hardKill); finish(); });
    } else {
      if (wake) wake(); // not strictly needed (finish exits) — but never leave a sleep dangling
      finish();
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  console.error(`pidge: bridge — up (pid ${process.pid}, lock ${path.basename(lockFile)}) · handler: ${handlerCmd}`);
  console.error('pidge: bridge — ONE handler invocation per batch, batch JSON on stdin; exit 0 = acked, non-zero = re-served by the server lease (make the handler idempotent).');

  // Boot: narrate reach + declare listen_mode=external_daemon when it isn't
  // already (the honest advisory — a bridge IS an external daemon).
  // Best-effort by design: a 401 at boot does NOT kill the process (a daemon
  // that dies on 401 just flap-restarts under launchd/systemd — the loop below
  // owns the narrate + long-backoff treatment).
  try {
    const who = await fetchWhoami();
    if (who.res.status === 200 && who.data.channel) {
      console.error(`pidge: bridge — canal "${who.data.channel.name}" · ${who.data.devices ?? '?'} device(s)`);
      warnStalePriorClaim(who.data); // the boot warning
      warnConsumerConflict(who.data); // another consumer live at boot (whoami)
      const oc = who.data.operating_contract || {};
      if (!(oc.listen_mode && oc.listen_mode.value === 'external_daemon')) {
        v['listen-mode'] = 'external_daemon';
        await declareOperatingContract(BASE, TOKEN, who.data.channel.id);
      }
    }
  } catch (e) {
    console.error(`pidge: bridge — boot whoami failed (network: ${e.message}) — the loop keeps trying`);
  }
  if (shuttingDown) return;

  // Realtime as PRESENCE + EARLY WAKE only: a frame cuts the current
  // idle/backoff sleep short and the human sees "ouvindo agora"; every batch
  // still comes from the durable long-poll GET (a dropped socket costs latency,
  // never data — the existing WS→long-poll degrade, with long-poll as floor).
  if (wantRealtime()) {
    let announced = false;
    const connectWs = (channel) => {
      if (shuttingDown) return;
      const sub = cableSubscribe({
        channel,
        params: wsIdentityParams(),
        onUp: () => {
          if (!announced) { announced = true; console.error('pidge: bridge — realtime socket up (the human sees "ouvindo agora"); the long-poll stays the data path'); }
          if (wake) wake();
        },
        onFrame: () => { if (wake) wake(); },
        onDown: () => {
          const t = setTimeout(() => connectWs(channel), jitter(15000));
          if (t.unref) t.unref();
        },
      });
      if (!sub && !announced) {
        announced = true;
        console.error('pidge: bridge — no realtime socket — the long-poll floor carries the loop (same contract, less instant)');
      }
    };
    connectWs('ConversationChannel');
    connectWs('InboxChannel'); // --all semantics: notification answers too
  }

  let firstBatch = true;      // history_hint rides the first batch post-restart
  let transportFails = 0;     // consecutive network/5xx failures
  let handlerFails = 0;       // consecutive non-zero handler exits
  let alerted401 = false;     // ONE local alert per outage, not one per retry
  let alertedBroken = false;

  // Execution attribution — the bridge mints ONE run per handler invocation so
  // each spawned handler signs the messages it answers. A server that predates
  // runs (/runs 404) latches OFF for the whole process: no vars are injected and
  // the bridge behaves EXACTLY as before (attribution can never gate messages).
  let runsUnsupported = false;
  // Polite poller: hold back when a live INTERACTIVE run is the human's turn —
  // a client-side courtesy (delivery is unchanged server-side). Bounded so a
  // dead-but-unexpired interactive run can never wedge the bridge forever.
  let politeUnsupported = false;       // /runs/active 404 ⇒ turn the courtesy off
  let deferSince = null;               // when THIS continuous deference streak began
  const deferEnabled = !v['no-defer']; // --no-defer opts out entirely
  const DEFER_CAP_MS = parseInt(process.env.PIDGE_BRIDGE_DEFER_CAP || '', 10) || 600000; // 10 min ceiling

  // Mint a bridge run for ONE handler. 404 ⇒ latch runsUnsupported (old server);
  // any other failure ⇒ spawn UNSIGNED (a message must never fail to be handled
  // because attribution hiccuped). Returns {token, seal} or null.
  const startBridgeRun = async () => {
    if (runsUnsupported) return null;
    try {
      const res = await fetchT(`${BASE}/api/v1/runs`, {
        method: 'POST', headers,
        body: JSON.stringify({ mode: 'bridge', ephemeral: true, label: agentLabel() }),
      });
      if (res.status === 404) { runsUnsupported = true; return null; }
      if (res.status < 200 || res.status >= 300) {
        console.error(`pidge: bridge — run start failed (${res.status}) — handling this batch WITHOUT execution attribution`);
        return null;
      }
      const data = await res.json().catch(() => ({}));
      if (!data.run_token) return null;
      return { token: data.run_token, seal: (data.run && data.run.seal) || '' };
    } catch (e) {
      console.error(`pidge: bridge — run start failed (network: ${e.message}) — handling this batch WITHOUT execution attribution`);
      return null;
    }
  };
  // Best-effort run end (idempotent; server expiry covers a miss).
  const endBridgeRun = async (token) => {
    if (!token) return;
    try {
      await fetchT(`${BASE}/api/v1/runs/end`, {
        method: 'POST', headers: { ...headers, 'x-pidge-run': token },
      });
    } catch { /* best-effort — the server reaps it on expiry */ }
  };
  // The polite-poller probe: a live interactive run (last seen < 120 s, not our
  // own seal) ⇒ return it. 404 ⇒ latch politeUnsupported. Any error ⇒ null (never
  // block the loop on a bad probe).
  const liveInteractiveRun = async () => {
    if (politeUnsupported) return null;
    try {
      const res = await fetchT(`${BASE}/api/v1/runs/active`, { headers });
      if (res.status === 404) { politeUnsupported = true; return null; }
      if (res.status < 200 || res.status >= 300) return null;
      const data = await res.json().catch(() => ({}));
      const runs = Array.isArray(data.runs) ? data.runs : [];
      const own = process.env.PIDGE_RUN_SEAL || null;
      const now = Date.now();
      for (const r of runs) {
        if (r.mode !== 'interactive') continue;
        if (own && r.seal === own) continue;
        const seen = r.last_seen_at ? Date.parse(r.last_seen_at) : NaN;
        if (Number.isFinite(seen) && now - seen < 120000) return r;
      }
      return null;
    } catch { return null; }
  };

  // Ack the batch's EXACT ids, never `up_to`.
  // The server's up_to flips EVERY unprocessed row ≤ id — including rows under
  // lease from an EARLIER batch the handler FAILED on (or never saw): a later
  // success would stamp "processed" on work that never happened. ids:[…] can
  // only stamp what this handler demonstrably just handled.
  const ackBatch = async (ids, summary, runToken) => {
    const body = { ids };
    // attribution — WHAT the handler did, captured from its stdout marker
    // line (below). Absent ⇒ no field (never invent one). Server slices; we cap.
    if (summary) body.summary = String(summary).slice(0, 1000);
    // Sign the ack with THIS batch's run (the handler that just did the work),
    // never the parent bridge's — so the human sees who processed the message.
    const ackHeaders = runToken ? { ...headers, 'x-pidge-run': runToken } : headers;
    try {
      const res = await fetchT(`${BASE}/api/v1/messages/ack`, {
        method: 'POST', headers: ackHeaders, body: JSON.stringify(body),
      });
      if (res.status >= 200 && res.status < 300) {
        console.error(`pidge: bridge — acked ${ids.length} message(s) (exact ids of the batch — green ✓✓)${body.summary ? ` · summary: ${body.summary.length > 80 ? body.summary.slice(0, 77) + '…' : body.summary}` : ''}`);
        return true;
      }
      console.error(`pidge: bridge — WARNING: ack failed (${res.status}) — the batch re-serves after the lease; the handler will see it again`);
    } catch (e) {
      console.error(`pidge: bridge — WARNING: ack failed (network: ${e.message}) — the batch re-serves after the lease`);
    }
    return false;
  };

  for (;;) {
    if (shuttingDown) return;

    // Polite poller (CLIENT-side courtesy — server delivery is UNCHANGED): if a
    // live interactive run is the human's turn, hold this cycle so the daemon
    // doesn't consume a message meant for the person at the keyboard. Bounded to
    // DEFER_CAP_MS of CONTINUOUS deference (then consume anyway — a stuck
    // interactive run must never wedge the bridge); the budget resets only when
    // the interactive run clears. For anyone who never started an interactive
    // run, `other` is always null ⇒ behaviour is IDENTICAL to before.
    if (deferEnabled && !politeUnsupported) {
      const other = await liveInteractiveRun();
      if (shuttingDown) return;
      if (other) {
        if (deferSince === null) deferSince = Date.now();
        if (Date.now() - deferSince < DEFER_CAP_MS) {
          console.error(`pidge bridge: deferring to interactive run ${other.seal}`);
          await sleepInterruptible(jitter(intervalS * 1000));
          continue;
        }
        // past the ceiling — consume this cycle, but keep deferSince set so we
        // don't re-arm the whole budget while the interactive run lingers.
      } else {
        deferSince = null; // interactive run gone → the courtesy budget resets
      }
    }

    let res = null, data = null, failWhat = null;
    const waitS = 25;
    const askedAt = Date.now();
    try {
      const qs = new URLSearchParams({ all: 'true', wait: String(waitS) });
      res = await fetchT(`${BASE}/api/v1/messages?${qs}`, { headers }, (waitS + 10) * 1000);
      await checkManifestNews(res);
    } catch (e) {
      failWhat = `network: ${e.message}`;
    }
    if (shuttingDown) return;

    if (res && res.status === 200) {
      data = await res.json().catch(() => null);
      if (data === null) failWhat = 'unparseable 200 body';
    } else if (res && res.status === 401) {
      // A 401 must not die silent NOR re-loop blind — narrate, alert
      // locally ONCE per outage, retry with LONG jittered backoff. The key may
      // have been rotated; only the human can fix that.
      if (!alerted401) {
        alerted401 = true;
        localAlert('key rejected (401)', `the server rejected the channel key — probably ROTATED. The bridge is deaf until a human re-onboards (\`pidge setup --claim <code>\`). Retrying every ~${Math.round(BACKOFF_LONG_MS / 1000)}s.`);
      } else {
        console.error(`pidge: bridge — still 401 (rotated key?) — next retry in ~${Math.round(BACKOFF_LONG_MS / 1000)}s`);
      }
      await sleepInterruptible(jitter(BACKOFF_LONG_MS));
      continue;
    } else if (res) {
      failWhat = `listen error ${res.status}`;
    }

    if (failWhat) {
      transportFails++;
      // The exit-4 class (a channel with NO healthy round-trip) becomes, in a
      // daemon, "local alert + LONG backoff" — never a blind hot re-loop and
      // never a silent death.
      if (transportFails >= BROKEN_AFTER) {
        if (!alertedBroken) {
          alertedBroken = true;
          localAlert('channel looks broken', `${transportFails} consecutive failures reaching ${BASE} (latest: ${failWhat}) — server or network, not the human. The bridge keeps retrying with long backoff.`);
        }
        await sleepInterruptible(jitter(BACKOFF_MAX_MS));
      } else {
        console.error(`pidge: bridge — ${failWhat} (${transportFails} consecutive) — backing off`);
        await sleepInterruptible(jitter(Math.min(BACKOFF_BASE_MS * 2 ** (transportFails - 1), BACKOFF_MAX_MS)));
      }
      continue;
    }

    // A healthy round-trip: narrate recovery once, reset the failure ledgers.
    if (transportFails > 0 || alerted401 || alertedBroken) {
      console.error(`pidge: bridge — channel recovered${transportFails ? ` after ${transportFails} consecutive failure(s)` : ''}`);
      transportFails = 0; alerted401 = false; alertedBroken = false;
    }
    warnStalePriorClaim(data); // newer servers serve the flag on this GET too
    warnConsumerConflict(data); // the consume GET flags a live sibling

    const msgs = Array.isArray(data.messages) ? data.messages : [];
    if (msgs.length === 0) {
      // The long-poll hold IS the pacing; only a fast empty return sleeps (a
      // server that doesn't hold ?wait= must not become a hot loop).
      if (Date.now() - askedAt < 2000) await sleepInterruptible(jitter(intervalS * 1000));
      continue;
    }

    // ONE handler invocation per batch — the whole tick as JSON on stdin.
    // Sealed rows are opened BEFORE the handler sees them (same path as listen).
    const opened = await Promise.all(msgs.map((m) => e2eOpenMessageRow(m)));
    const batchIds = opened.map((m) => Number(m.id)).filter(Number.isInteger);
    const batch = { messages: opened, ...(firstBatch ? { history_hint: true } : {}) };
    console.error(`pidge: bridge — batch of ${opened.length} message(s) → handler${firstBatch ? ' (history_hint: first batch since this bridge started — the handler may want `pidge catchup` to situate)' : ''}`);
    // Mint ONE run for this handler and inject its bearer + seal — the handler's
    // own pidge calls (and this batch's ack) then sign with it. null ⇒ old server
    // or a hiccup: spawn unsigned, exactly as before.
    const runInfo = await startBridgeRun();
    if (runInfo) console.error(`pidge: bridge — run ${runInfo.seal || '?'} signs this batch`);
    // capture the handler's summary from a MARKER LINE on its stdout —
    // `pidge-summary: <text>`. We STREAM, never buffer the whole output: stdout is
    // teed to the bridge's own stdout (the existing log is preserved) while a
    // bounded line-scanner keeps only the LAST marker's value (cap 1000). A handler
    // that dumps megabytes, or closes stdout early, can neither wedge the loop nor
    // grow memory. No marker ⇒ no summary field (we NEVER invent one).
    let lastSummary = null;
    let markerTail = '';
    const MARKER_TAIL_CAP = 2048; // a marker value is ≤1000; this head is plenty to still recognize the prefix
    const takeMarker = (line) => {
      const m = /^pidge-summary:[ \t]?(.*)$/.exec(line.trim());
      if (m) lastSummary = m[1].trim().slice(0, 1000);
    };
    const scanStdout = (text) => {
      // Split once (O(n)); the last part is the unterminated tail carried forward.
      const parts = (markerTail + text).split('\n');
      markerTail = parts.pop();
      for (const line of parts) takeMarker(line);
      // Bound the unterminated tail — keep only the HEAD (a marker must start at
      // the line start); a single line longer than the cap can't be a marker we'd
      // keep, and truncating the head preserves the prefix + a full ≤1000 value.
      if (markerTail.length > MARKER_TAIL_CAP) markerTail = markerTail.slice(0, MARKER_TAIL_CAP);
    };
    const t0 = Date.now();
    const outcome = await new Promise((resolve) => {
      let child;
      try {
        // Inject the run bearer + seal so the handler's pidge calls self-sign;
        // no run ⇒ plain process.env (unchanged behaviour).
        const childEnv = runInfo
          ? { ...process.env, PIDGE_RUN_TOKEN: runInfo.token, PIDGE_RUN_SEAL: runInfo.seal }
          : process.env;
        child = spawn(handlerCmd, { shell: true, stdio: ['pipe', 'pipe', 'inherit'], env: childEnv });
      } catch (e) { return resolve({ code: null, error: e.message }); }
      currentChild = child;
      let timedOut = false;
      let hardKill = null;
      let settled = false;
      let exited = null;        // {code, signal} once the process exits
      let stdoutEnded = false;  // true once the stdout pipe reaches EOF
      let graceT = null;
      // A hung handler must not wedge the channel
      // forever (the lease keeps re-serving to a bridge that never finishes a
      // batch). --handler-timeout (default 30 min) → SIGTERM (SIGKILL 5 s
      // later), treated EXACTLY like a failed handler: no ack, backoff ladder.
      const killT = setTimeout(() => {
        timedOut = true;
        console.error(`pidge: bridge — handler exceeded --handler-timeout (${handlerTimeoutS}s) — SIGTERM (SIGKILL in 5s). Treated as a FAILED batch: NOT acked.`);
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        hardKill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 5000);
        if (hardKill.unref) hardKill.unref();
      }, handlerTimeoutS * 1000);
      if (killT.unref) killT.unref();
      // Periodic heartbeat on stderr while the handler runs — a daemon log that
      // goes silent for 25 minutes reads as "dead", not "thinking".
      const narrate = setInterval(() => {
        const elapsed = Date.now() - t0;
        const shown = elapsed < 60000 ? `${Math.round(elapsed / 1000)}s` : `${Math.round(elapsed / 60000)} min`;
        console.error(`pidge: bridge — handler running for ${shown} (SIGTERM at --handler-timeout ${handlerTimeoutS}s)`);
      }, HANDLER_NARRATE_MS);
      if (narrate.unref) narrate.unref();
      // Lease/presence heartbeat while the handler thinks (issue #82): renew the
      // batch's EXACT ids every 60 s — POST /ack {ids, state:"delivered"}. Two jobs
      // in one ping: (a) the visibility lease can't lapse mid-run (a 30-min handler
      // outlives the ~10-min lease — without this the batch re-serves WHILE it's
      // being worked), and (b) servers ≥ manifest v79 refresh "listening now"
      // presence on a renew that actually renewed rows — so the human never sees
      // "offline" during a long handler run even when the WS is down (older
      // servers: lease renewal only, harmless). First ping only after a full
      // interval — a fast handler never pings. Cleared in done(), BEFORE the
      // ack/failure verdict: a FAILED batch must lapse back to the queue, so we
      // never renew after the child exits. Failures are NON-FATAL and can never
      // touch the handler or the batch outcome: narrate the FIRST one, then stay
      // silent (a line per ping would drown a long outage's log).
      let renewFailed = false;
      const renew = batchIds.length === 0 ? null : setInterval(() => {
        fetchT(`${BASE}/api/v1/messages/ack`, {
          method: 'POST', headers, body: JSON.stringify({ ids: batchIds, state: 'delivered' }),
        }).then((r) => {
          if (r.status >= 200 && r.status < 300) return;
          if (renewFailed) return;
          renewFailed = true;
          console.error(`pidge: bridge — renew heartbeat failed (${r.status}) — non-fatal: the handler keeps running; the lease may lapse early (at-least-once covers a re-serve)`);
        }).catch((e) => {
          if (renewFailed) return;
          renewFailed = true;
          console.error(`pidge: bridge — renew heartbeat failed (network: ${e.message}) — non-fatal: the handler keeps running; the lease may lapse early (at-least-once covers a re-serve)`);
        });
      }, RENEW_MS);
      if (renew && renew.unref) renew.unref();
      const done = (o) => {
        if (settled) return; settled = true;
        clearTimeout(killT); if (hardKill) clearTimeout(hardKill); clearInterval(narrate);
        if (renew) clearInterval(renew);
        if (graceT) clearTimeout(graceT);
        // A final marker line with NO trailing newline still counts.
        if (markerTail) { takeMarker(markerTail); markerTail = ''; }
        currentChild = null; resolve(o);
      };
      // finalize only when the process has exited AND its stdout has drained,
      // so a marker on the LAST unflushed chunk is never missed (the 'exit' event
      // can fire before the pipe's trailing data is read). If stdout stays open past
      // exit (a grandchild inherited the pipe), a short grace caps the wait.
      const finishIfReady = () => { if (exited && stdoutEnded) done({ code: exited.code, signal: exited.signal, timedOut }); };
      child.on('error', (e) => done({ code: null, error: e.message }));
      child.on('exit', (code, signal) => {
        exited = { code, signal };
        if (stdoutEnded) return finishIfReady();
        graceT = setTimeout(() => done({ code, signal, timedOut }), 2000);
        if (graceT.unref) graceT.unref();
      });
      child.stdout.on('data', (chunk) => {
        scanStdout(chunk.toString('utf8'));
        // Tee to the bridge's own stdout (preserve the log) WITH backpressure — a
        // slow sink pauses the child rather than buffering a big dump in memory.
        if (!process.stdout.write(chunk)) {
          child.stdout.pause();
          process.stdout.once('drain', () => { try { child.stdout.resume(); } catch { /* child gone */ } });
        }
      });
      child.stdout.on('end', () => { stdoutEnded = true; finishIfReady(); });
      // A broken read side must never crash the daemon; treat it as drained.
      child.stdout.on('error', () => { stdoutEnded = true; finishIfReady(); });
      // EPIPE guard: a handler may exit without reading stdin — its exit code
      // still decides the batch; the write failure itself is not a verdict.
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(batch) + '\n');
    });
    // Hard case: the handler-exit → ack race. A signal that landed while the
    // handler ran (or right as it exited) means shutdown() is tearing us down —
    // do NOT ack: the batch stays leased and re-serves. A duplicate delivery
    // beats a batch stamped "processed" during a teardown.
    if (shuttingDown) return;
    const secs = Math.round((Date.now() - t0) / 1000);
    // A timed-out handler NEVER acks — even if it trapped SIGTERM and exited 0:
    // its work was cut short by definition.
    if (outcome.code === 0 && !outcome.timedOut) {
      handlerFails = 0;
      if (batchIds.length === 0) {
        console.error('pidge: bridge — WARNING: batch had no numeric ids — nothing to ack (server bug?)');
      } else if (await ackBatch(batchIds, lastSummary, runInfo && runInfo.token)) {
        // Only a DELIVERED + ACKED first batch retires the hint: if the ack
        // failed, the re-served batch is still effectively "first post-restart".
        firstBatch = false;
      }
    } else {
      handlerFails++;
      const why = outcome.error ? `couldn't run (${outcome.error})`
        : outcome.timedOut ? `timed out (--handler-timeout ${handlerTimeoutS}s)`
          : outcome.signal ? `killed by ${outcome.signal}` : `exit ${outcome.code}`;
      console.error(`pidge: bridge — handler ${why} after ${secs}s — batch NOT acked (the server lease re-serves it in ~10 min; ${handlerFails} consecutive handler failure(s))`);
      // Backoff BEFORE the next poll: fresh arrivals would re-invoke a handler
      // that's evidently broken — escalate so a dead handler doesn't burn one
      // LLM call per message. Jittered like every other sleep.
      await sleepInterruptible(jitter(Math.min(BACKOFF_BASE_MS * 2 ** (handlerFails - 1), BACKOFF_MAX_MS)));
    }
    // End the handler's run AFTER the ack (which had to sign with it). Best-effort:
    // a miss is reaped by the server's run expiry.
    await endBridgeRun(runInfo && runInfo.token);
  }
}

// `pidge bridge install` — write the launchd (Mac) / systemd (Linux)
// TEMPLATE that runs the bridge under the OS supervisor with Restart=on-failure
// semantics, and declare listen_mode=external_daemon (advisory). The template
// NEVER embeds the key — it stays in ~/.config/pidge/env (token hygiene); only
// the non-secret env (PIDGE_URL/PIDGE_AGENT/XDG_CONFIG_HOME) rides along.
function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
// systemd unit-file quoting: double quotes with backslash escapes, PLUS the
// unit-file expansions: '$' would be variable-expanded in command
// lines ($$ = literal $) and '%' is a specifier everywhere (%% = literal %) —
// a handler like `claude -p "$x is 100%"` must arrive verbatim.
function systemdQuote(s) {
  return '"' + String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, () => '$$')
    .replace(/%/g, '%%') + '"';
}

async function runBridgeInstall() {
  const handlerCmd = v.exec;
  if (!handlerCmd) die('pidge: bridge install needs --exec \'<handler>\' — the exact command the daemon will run once per batch', 1);
  // PIDGE_BRIDGE_PLATFORM: test hook so BOTH templates are exercised on any OS.
  const platform = process.env.PIDGE_BRIDGE_PLATFORM || process.platform;
  const nodeBin = process.execPath;
  const cli = __filename;
  const nameSuffix = AGENT_ID ? `.${AGENT_ID}` : '';
  const envPairs = {};
  if (process.env.PIDGE_URL) envPairs.PIDGE_URL = process.env.PIDGE_URL;
  if (process.env.PIDGE_AGENT) envPairs.PIDGE_AGENT = process.env.PIDGE_AGENT;
  if (process.env.XDG_CONFIG_HOME) envPairs.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  // launchd/systemd give services a MINIMAL PATH — a handler like
  // `claude`/`codex` installed via homebrew/nvm would exit 127 under the
  // daemon while working fine in the shell. Embed the CURRENT PATH (non-secret)
  // so the daemon resolves the same binaries the human just tested with.
  if (process.env.PATH) envPairs.PATH = process.env.PATH;

  if (!FILE_ENV.PIDGE_TOKEN && (process.env.PIDGE_TOKEN || process.env.HERALD_TOKEN))
    console.error(`pidge: bridge install — WARNING: your key lives ONLY in this shell's env; the daemon won't inherit it (the template NEVER embeds secrets). Put it in the config file first — re-run \`pidge setup --claim <code>\`, or write PIDGE_TOKEN=… to ${CONFIG_FILE} yourself (chmod 600).`);
  // An npx-cache CLI path is EPHEMERAL (npx prunes its cache) — a template
  // pointing into it dies on the next prune. Warn; the human should install
  // globally (npm i -g pidge-cli) and re-run so the template survives.
  if (/[\\/]_npx[\\/]/.test(cli))
    console.error('pidge: bridge install — WARNING: this CLI is running from the npx CACHE — the generated template points into it and BREAKS when npx prunes. Install it durably first (npm i -g pidge-cli) and re-run `pidge bridge install`.');

  let file, enable;
  if (platform === 'darwin') {
    const label = `sh.pidge.bridge${nameSuffix}`;
    const envBlock = Object.keys(envPairs).length
      ? `  <key>EnvironmentVariables</key>\n  <dict>\n${Object.entries(envPairs).map(([k, val]) => `    <key>${xmlEscape(k)}</key><string>${xmlEscape(val)}</string>`).join('\n')}\n  </dict>\n`
      : '';
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<!-- generated by \`pidge bridge install\`. A TEMPLATE: review, then
     launchctl load -w <this file>
     The channel key stays in ~/.config/pidge/env — NEVER embedded here. -->
<dict>
  <key>Label</key><string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodeBin)}</string>
    <string>${xmlEscape(cli)}</string>
    <string>bridge</string>
    <string>--exec</string>
    <string>${xmlEscape(handlerCmd)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <!-- Restart=on-failure: a clean exit 0 (SIGTERM shutdown / launchctl unload) stays down -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
${envBlock}  <key>StandardOutPath</key><string>${xmlEscape(path.join(CONFIG_DIR, 'bridge.log'))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(path.join(CONFIG_DIR, 'bridge.err.log'))}</string>
</dict>
</plist>
`;
    const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, `${label}.plist`);
    fs.writeFileSync(file, plist);
    enable = `launchctl load -w "${file}"`;
  } else {
    const name = `pidge-bridge${nameSuffix}.service`;
    const envLines = Object.entries(envPairs).map(([k, val]) => `Environment=${systemdQuote(`${k}=${val}`)}`).join('\n');
    const unit = `# generated by \`pidge bridge install\`. A TEMPLATE: review, then
#   systemctl --user daemon-reload && systemctl --user enable --now ${name}
# The channel key stays in ~/.config/pidge/env — NEVER embedded here.
[Unit]
Description=pidge bridge — supervised Pidge consumer (one handler invocation per batch)
# Wants + After: After alone only ORDERS against the target if
# something else pulls it in — Wants actually pulls it into the transaction.
Wants=network-online.target
After=network-online.target

[Service]
ExecStart=${systemdQuote(nodeBin)} ${systemdQuote(cli)} bridge --exec ${systemdQuote(handlerCmd)}
Restart=on-failure
RestartSec=10
${envLines ? envLines + '\n' : ''}StandardOutput=append:${path.join(CONFIG_DIR, 'bridge.log')}
StandardError=append:${path.join(CONFIG_DIR, 'bridge.err.log')}

[Install]
WantedBy=default.target
`;
    const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, name);
    fs.writeFileSync(file, unit);
    enable = `systemctl --user daemon-reload && systemctl --user enable --now ${name}`;
  }
  console.error(`pidge: bridge install — template written to ${file} (Restart=on-failure semantics; logs → ${path.join(CONFIG_DIR, 'bridge.log')})`);
  console.error(`pidge: enable it with:  ${enable}`);

  // Declare listen_mode=external_daemon (ADVISORY, honest — the "same instance
  // forever" sharp edge the human should see). Best-effort like setup's declaration.
  let declared = null;
  try {
    const who = await fetchWhoami();
    if (who.res.status === 200 && who.data.channel) {
      v['listen-mode'] = 'external_daemon';
      declared = await declareOperatingContract(BASE, TOKEN, who.data.channel.id);
    } else {
      console.error(`pidge: bridge install — couldn't declare listen_mode=external_daemon (whoami ${who.res.status}); do it later: pidge contract set listen_mode=external_daemon`);
    }
  } catch (e) {
    console.error(`pidge: bridge install — couldn't declare listen_mode=external_daemon (network: ${e.message}); do it later: pidge contract set listen_mode=external_daemon`);
  }
  console.log(JSON.stringify({
    ok: true, file, platform: platform === 'darwin' ? 'launchd' : 'systemd',
    listen_mode_declared: declared === 'external_daemon',
  }, null, 2));
  process.exit(0);
}

// selftest: prove the listener works by ROUND-TRIP, not prose. Fire a nonce
// onto our own queue, run the listener (long-poll floor — the reachability path) for
// the window, ack the nonce, then read the server's verdict. PASS = it round-tripped
// in time. FAIL = the server's window verdict + a likely CAUSE the server can't see
// (the orphan/`&`/transport bugs). Only the nonce is acked (ids:[id]).
//
// the reachability read is scoped to `?since=<nonce id − 1>` — the POST
// /selftest returns the nonce's id, and every message in the PRE-EXISTING backlog
// has a LOWER id (it was already in the queue when we fired), so the backlog is
// excluded BY CONSTRUCTION and never served/leased here (a real bug once: the
// selftest read leased the whole backlog, blacking it out for the real reader).
//
// `since=` alone is NOT enough, though: a real message
// arriving DURING the window has id > nonce, so it IS served — and if the server
// stamps it delivered with its DEFAULT lease (~10 min), that's 10× worse than the
// original 60s bug. The `sinceId=0` fallback (a server that didn't return a numeric
// id) has the same exposure across the whole backlog. So we KEEP `lease=60` as
// defence in depth: `since=` removes the backlog from the read entirely, and
// `lease=60` bounds the blackout on anything still served to ~60s, never ~10 min.
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
  // read strictly ABOVE the nonce's predecessor — the nonce and anything
  // newer, never the pre-existing real backlog. A non-numeric id (a broken server
  // shape) falls back to 0 (= no floor); the selftest already fails on the id
  // match in that case, so the fallback never masks a real bug.
  const sinceId = Number.isFinite(Number(id)) ? Number(id) - 1 : 0;
  console.error(`pidge: self-test fired (id ${id}) — listening up to ${windowS}s to prove the round-trip (a nonce on your own queue; PASS = your listener picks it up + acks it in time)`);

  const deadline = Date.now() + windowS * 1000;
  let sawNonce = false;
  while (Date.now() < deadline && !sawNonce) {
    const waitS = Math.max(0, Math.min(25, Math.ceil((deadline - Date.now()) / 1000)));
    const askedAt = Date.now();
    try {
      // since=<nonce id − 1> keeps the pre-existing backlog out of the read;
      // lease=60 bounds the blackout on anything still served (a mid-window arrival
      // with id > nonce, or the whole queue under the sinceId=0 fallback) to ~60s
      // instead of the server's ~10-min default. Both together, always.
      const qs = new URLSearchParams({ all: 'true', since: String(sinceId), lease: '60' });
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
    // Older server: no /whoami yet — the key may still be fine; prove it on the manifest.
    const m = await fetchT(`${base}/api/v1/manifest`, { headers: { authorization: `Bearer ${token}`, ...identityHeaders() } }).catch(() => null);
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
  // On newer servers /whoami is either-track — a SESSION token (ses_) gets
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
  // device-reach honesty + install ownership — shared with whoami.
  const unreachable = reportDeviceReach(data);
  reportClaimMismatch(data);
  // Live consumers on this channel + predecessor ack hygiene (present-only —
  // an older server omits them and these no-op).
  reportConsumers(data);
  reportProvenance(data);
  // SHOUT on a stale prior-claim backlog (advisory tone — the anchor has
  // known false ±). Warning only, never exit 2: the messages are
  // real and drainable; the human/agent decides what they're worth.
  warnStalePriorClaim(data, 'Run `pidge catchup` (read-only) to see them before any listen/ack.');
  // doctor ALWAYS reports the prior-claim state — a CONFIRMATION on false, not
  // just a warning on true. "I didn't see the warning" ≠ "there is no orphaned
  // backlog"; a silent doctor can't confirm health. The warning above covers true;
  // here we speak the healthy case. Only when the field is EXPLICITLY false:
  // an older server that omits it can't confirm either way, so stay silent then.
  if (data.stale_from_prior_claim === false)
    console.error('pidge doctor: prior-claim backlog: none ✓ (no un-acked messages predate your ownership claim)');
  // An UNMARKED home skill is one the self-heal (correctly) won't touch
  // (requireMarker) — so a PRE-MARKER pidge copy silently stays on old doctrine
  // with no signal (a real incident: an install ran months-stale doctrine
  // unnoticed). doctor can't fix it (it might be an
  // AUTHORED skill), but it can SAY so — a nudge, never a write.
  warnUnmarkedHomeSkill();
  // E2E: validate PIDGE_SECRET when present (32 bytes after base64url;
  // kf = base64url(SHA-256(key)[0..3])) and cross-check it against the channel:
  //   e2e_enabled + no secret   → sends go CLEAR-and-marked; point at the app's Connect-screen terminal step
  //   secret + non-E2E channel  → an ORPHAN secret (never used); warn
  //   e2e_enabled + bad/mismatched secret → BROKEN (exit 2): the seal promise can't hold
  const e2e = reportE2eHealth(data);
  if (ON_SHARED_FILE)
    console.error(`pidge doctor: WARNING — reading the SHARED file ${CONFIG_FILE}. If another agent runs on this machine, it reads the SAME key and you'll send as each other (a real incident, not a hypothetical). Isolate: set PIDGE_AGENT=<id> at this agent's launch (config → ~/.config/pidge/agents/<id>/env) or give it its own PIDGE_TOKEN.`);
  // devices exist but 0 are deliverable ⇒ a send reaches NOBODY — BROKEN
  // (exit 2). (0 devices total stays a warning above: a fresh setup before the
  // app is installed isn't "broken".) The claim mismatch SHOUTS but stays exit 0
  // — the warning is the contract (the severity split is a judgment call).
  if (unreachable) {
    console.error('pidge doctor: BROKEN (exit 2) — devices exist but 0 are reachable (all disabled or on the wrong APNs environment): a send reaches nobody.');
    process.exit(2);
  }
  if (e2e.broken) {
    console.error('pidge doctor: BROKEN (exit 2) — this channel is E2E but the PIDGE_SECRET cannot seal/open anything on it. The app\'s Connect screen shows a separate TERMINAL step that writes PIDGE_SECRET to ~/.config/pidge/env — ask your human to run THAT (never paste the secret in chat), then re-run `pidge doctor`.');
    process.exit(2);
  }
  // probe the realtime path (the held-poll failure class an HTTP-only doctor
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
  // lead with `pidge hello` — the first-contact WOW (send + wait in one),
  // the same debut the /agent-setup guide leads with. (no --template hint —
  // `pidge hello` IS the entry point; the content_template surface is off the menu.)
  // --quiet collapses ALL of the above to this single status line.
  if (QUIET)
    console.error(`pidge: ✓ setup ok — canal "${data.channel && data.channel.name}" · ${devices} device(s) · realtime ${realtime} (run \`pidge doctor\` for the full check)`);
  else
    console.error('pidge doctor: all good — try: pidge hello   (first-contact WOW — send + wait in one)');
  // setup/doctor just proved the channel works — say what keeps it WORKING.
  // Consumer-gated: silent when someone (a bridge, another session) is live.
  // Deliberately printed even under --quiet: the loop IS the product's pitch,
  // and the pasted-prompt onboarding (which uses --quiet) is exactly who needs it.
  await nudgeStayOnline(data);
  console.log(JSON.stringify({ ok: true, base_url: base, channel: data.channel, devices, manifest_version: data.manifest_version, realtime, e2e: { channel: e2e.channelOn, secret: e2e.status, kf: e2e.kf, pinned: !!e2e.pinned } }));
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
    e2eStampPin(out.kf); // doctor CONFIRMED the sealed context — latch the pin
  } else if (e2ePinned() && !e2eOverrideOff()) {
    console.error(`pidge doctor: WARNING — the server says this channel is NOT E2E, but this machine PINNED it as E2E: every send here is REFUSED (exit 2) instead of going clear — a lying server must not downgrade you to plaintext. ${E2E_UNPIN_HINT}`);
  } else {
    console.error('pidge doctor: WARNING — PIDGE_SECRET present but this channel is NOT E2E (secret órfão): sends stay CLEAR and the secret is never used. Either the human turns on E2E for this channel in the app, or drop the secret.');
  }
  out.pinned = e2ePinned() && !e2eOverrideOff();
  return out;
}

// setup --claim: exchange the single-use code for the key, store it ourselves
// (the secret never appears on screen or in the chat the prompt was pasted in),
// then prove the loop with doctor.
async function runSetup() {
  const code = v.claim;
  if (!code) die('pidge: usage: pidge setup --claim <code> [--url <base>]   (the human copies the code from the Pidge app)', 1);
  const base = (v.url || process.env.PIDGE_URL || FILE_ENV.PIDGE_URL || 'https://api.pidge.sh').replace(/\/+$/, '');

  // THE SHARED-CONFIG GUARD (a real incident: a shared config file let one
  // agent's setup hijack another's cron). Only the FILE path can
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
      method: 'POST', headers: { 'content-type': 'application/json', ...identityHeaders() },
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

  // step 5: DECLARE how this agent operates (operating_contract) right after
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
    // running setup), emit it alongside. (the secret comes from the app's
    // Connect-screen terminal step, never from the chat prompt.)
    if (process.env.PIDGE_SECRET) console.log(`export PIDGE_SECRET=${process.env.PIDGE_SECRET}`);
    console.error(`pidge: canal "${channelName}" — modo POR-AGENTE (nada gravado em disco). Cole as duas linhas no ambiente de lançamento DESTE agente (systemd/launcher/cron/profile). Cada agente tem a SUA chave; perdeu, é só pegar outro código no app e re-rodar (a chave do canal é a MESMA). NÃO rode --print de dentro de um agente — a chave apareceria no contexto dele.`);
    await fuseSkillAndHello(finalBase, data.key);
    await runDoctor(finalBase, data.key, 'fresh claim (per-agent env — not stored on disk)');
    return;
  }

  // File path (default): the CLI writes the key — the agent never sees it
  // (token hygiene). Per-agent when PIDGE_AGENT is set; otherwise the legacy shared file.
  // E2E: the {TOKEN, SECRET} pair travels together from ONE source — persist
  // PIDGE_SECRET next to the token when this env already carries it (it
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
  // claim ownership of the channel for THIS install and record the
  // generation locally, so a later `pidge doctor` can DETECT a silent key swap
  // by a different agent (a real incident, now caught in code). Best-effort.
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

// The setup fuse: setup → skill → hello. Best-effort, run right BEFORE the post-setup
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

// skill install: persistent Pidge knowledge for AI
// agents — the live manifest's APPENDIX (profiles / notes / exits) wrapped around
// a HAND-AUTHORED, failure-mode-first spine. The dead content_template
// `decision_table` is NEVER pulled again, so even an old manifest can't reinject
// the v46 collision. Non-exiting: RETURNS {file, manifest_version} and THROWS on
// failure, so callers (`skill install` AND the setup fuse) choose die-vs-degrade.
// `--target` picks the DESTINATION only — the generated content is identical
// (it's already agent-agnostic). claude = a Claude Code skill; agents/gemini = the
// emerging root-file conventions (AGENTS.md for Codex et al., GEMINI.md for Gemini).
const SKILL_TARGETS = {
  claude: () => path.join(process.cwd(), '.claude', 'skills', 'pidge', 'SKILL.md'),
  agents: () => path.join(process.cwd(), 'AGENTS.md'),
  gemini: () => path.join(process.cwd(), 'GEMINI.md'),
};

// destFileOverride lets the self-heal write to a SPECIFIC file (e.g. the
// HOME skill ~/.claude/skills/pidge/SKILL.md) rather than the cwd-relative claude
// target — so a stale skill is healed IN PLACE wherever it lives, never cross-written.
async function installSkill(base = BASE, token = TOKEN, target = 'claude', destFileOverride = null) {
  const destFor = destFileOverride ? () => destFileOverride : SKILL_TARGETS[target];
  if (!destFor) throw new Error(`unknown skill target ${JSON.stringify(target)} — use claude, agents or gemini`);
  const hdrs = { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...identityHeaders() };
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
  // The self-heal marker rides a `# pidge-skill …` YAML COMMENT INSIDE
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

**Many agents on this machine?** Export \`PIDGE_AGENT=<your-id>\` in EVERY session before any pidge command — your config then lives at \`~/.config/pidge/agents/<your-id>/env\` and you can never speak through another agent's channel. Without it, commands use the DEFAULT config (\`~/.config/pidge/env\`), which may be someone else's channel. Never run \`setup --force\`.

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
| Waking up where a bridge/daemon may already consume the channel | \`pidge catchup\` first (read-only; NEVER \`listen\`) |

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
- **\`pidge live\` — the real lock-screen card.** By default your card is an ENTRY
  of the user's ONE consolidated status-center Live Activity (all agents share it — cards never
  stack). Fields drive the render: \`--step 3/5\` (sugar → progress + fraction) or \`--progress\`
  → bar; \`--ends-at\` → native countdown the SERVER concludes at zero; \`--end\` → ✓ + outcome,
  lingers ~30 s, leaves the card. The handle is the correlation_id you pass (or the one echoed
  back) — reuse it to update/end.
  \`\`\`bash
  pidge live backfill-1 --title "Backfill" --status "Stage 1/4" --step 1/4
  pidge live backfill-1 --status "Stage 3/4" --step 3/4
  pidge live backfill-1 --end --outcome "Backfill ok ✓"
  \`\`\`
  Trust the echo: \`operation\` (started/updated/noop/rotated/ended) says what happened;
  \`degraded:true\` means an over-budget \`--dedicated\` landed as a consolidated entry. Updates
  are cheap (identical re-writes are a \`noop\` that refreshes your staleness TTL), and the
  server retires what you forget (stale after a TTL, concluded at \`--ends-at\`) — but **end
  what you started anyway**: an explicit \`--outcome\` beats a timeout.
- **Lighter: ONE \`pidge message\` re-sent with the same \`--collapse-key\`** — each update replaces
  the previous banner (1 slot, not N pings).
Either path: a live surface never answers (no \`--wait\`); if the finished job leaves a pendency,
that's a separate \`important\` at the end.

## Anti-slop rules (judgment a recipe can't teach)

1. **One send = one fact = one ask.** Never two questions in a notification.
2. **Default to \`important\`.** \`message\` only for true no-action FYIs; \`urgent\` is a contract, not a volume knob — **<1/day**, abuse caps your channel.
3. **There is no content-template menu.** Every send is type + markdown + optional buttons. If you're reaching for \`--template context/report/digest/sensitive\`, stop — that surface is gone (the field still parses as silent back-compat, but don't teach or rely on it).
4. **Typed answer? \`--actions reply\` ALONE** — never a decision + \`reply\` together (the CLI refuses it, exit 1).
5. **Trust the 201 echo over your intent** — \`degraded\`/\`render_mode\`/\`registered_devices\`. \`registered_devices:0\` ⇒ it went nowhere; ABORT a blocking \`--wait\` on it (kill it, don't let it burn its timeout) and run \`pidge doctor\`.
6. **Don't spam to signal importance.** Consolidate into one markdown body; use \`--collapse-key\` for self-replacing progress, \`--thread\` only for follow-ups over time.
7. **Be listening when the answer lands — the queue keeps it safe (at-least-once, nothing is ever lost), but nobody wakes you until something reads it. What you lose is TIME, not the message.** Ack only AFTER the work is durably done.
8. **Write to your human in THEIR language — mirror the language they use in the channel.** Phone-friendly markdown: narrow tables (they render), no emoji-spam.
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

## Sharp edges (paid for in production)

- **There is no \`pidge reply\`.** \`reply\` is a built-in action id, not a command. To answer the human's composer message, send a normal \`pidge message --thread <id>\` reusing the message's \`thread_id\`.
- **\`urgent\` is a trust contract, not a button.** It arms an AlarmKit alarm; once delivered you **cannot abort it** (\`pidge cancel\` → 409). Real + unpostponable only, <1/day. Never test it without warning the human.
- **A 201 ≠ "seen."** \`registered_devices:0\` goes nowhere; \`delivered\` is APNs dispatch, not eyes; only \`seen_at\`/an answer is the human.
- **The ask reply-vs-yes/no trap.** \`--actions yes,no,reply\` let the human dodge a typed answer with one tap — so the CLI now REFUSES a decision + \`reply\` in one send (exit 1). Use \`--actions reply\` alone when you need text.
- **\`event\` is quiet today** — \`event --event-at\` schedules the notification + countdown; for hand-driven progress use \`pidge live\`.
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

## Waking up in an interactive session (multi-runtime channels)

Your channel may already have a LIVE consumer — an always-on bridge or daemon (\`listen_mode: persistent\` or \`external_daemon\` in the channel contract). To the human, you and that consumer are ONE assistant. So before you offer any work in a fresh interactive session:

1. **Situate first — \`pidge catchup --digest --since <last>\`.** \`catchup\` prints the channel's thread read-only — the human's messages, their answers to notifications, and what was already handled. \`--digest\` collapses it to one line per message (\`id · kind · <60 chars> · <state>\`) so you read "what happened, who handled what" at a glance instead of raw JSON; \`--since <last>\` scopes it to what's NEW since your last session (O(new), not O(whole thread)). **The <state> has THREE values — read them carefully before offering work: \`handled by X: <summary>\` (done, with a note) · \`✓ acked (no note)\` (done SILENTLY — do NOT redo it) · \`PENDING\` (genuinely un-processed — this is the work).** catchup prints the cursor on stderr every no-\`--since\` run (stdout stays clean). It never consumes and never steals from the live consumer, so it is always safe to repeat.
2. **Never run \`pidge listen\` when another runtime is the consumer.** One channel has exactly ONE consumer. A second listener double-consumes: you steal messages the bridge was supposed to handle, and the human sees work done twice or not at all.
3. **Only then speak.** The human may have already asked the bridge for the thing you are about to offer — the catchup is how you know.

**The rule: one channel = one consumer. Reads are free (\`catchup\`, \`pidge wait <cid>\`); the consume loop (\`listen\`/\`ack\`) belongs to exactly one process.**

**New signals when you DO share a channel (server v66+):** the CLI now identifies itself on every call, so \`pidge doctor\`/\`whoami\` LIST the live consumers on your channel — you'll see "\`team-bridge (you)\` · \`claude-interactive\`" and a ⚠️ \`consumer_conflict\` when 2+ are live (\`listen\` warns the same, once per run). In \`--digest\`, a message another runtime is actively working shows "\`· being handled by <who> since <T>\`" (self-filtered — never your own) so you don't redo it. And when you fire-and-forget a scheduled send, add \`--note "<why>"\` (\`sent_note\`, clear metadata — no secrets) so a successor reads WHY it's armed. Set \`PIDGE_AGENT=<id>\` (or \`PIDGE_LABEL\`) per runtime so those consumer names are meaningful.

\`\`\`bash
pidge catchup --digest                  # the whole thread, one line per message (the session-start read)
pidge catchup --digest --since 480      # only what's NEW since message id 480 (O(new))
pidge catchup                           # the full raw JSON (newest first), when you need every field
pidge catchup --before 480              # page further back (older than message id 480)
\`\`\`
In \`--digest\` each line already carries its state — \`handled by <who>: <summary>\`, \`✓ acked (no note)\`, or \`PENDING\` — so you SEE what the other consumer already did (or that it's done silently), not just that a message exists. Only \`PENDING\` is work to pick up.

## Stay "always-on" while you're turn-based

A turn-based agent (e.g. Claude Code, Codex, Gemini CLI — anything invoked on demand) stays COMMANDABLE without a daemon:

### Stay online (the loop)

"Online" is a LOOP, not a state: run \`pidge online\` (sugar for \`pidge listen --all\`) as a background task YOUR HARNESS TRACKS (never a loose shell \`&\`). It blocks until something lands; when it exits: **handle what it printed → \`pidge ack --up-to <id> --summary "…"\` → RELAUNCH it immediately** (exit 3 = nothing arrived — relaunch anyway). The RELAUNCH is the step turn-based agents forget: the queue keeps messages safe meanwhile (at-least-once, nothing lost), but the human sees you offline until something listens again.

- **Active session:** \`pidge listen --follow --timeout 300\` holds for 5 min, printing messages as they arrive. \`--follow\` traps the turn — use it only when you intend to sit and wait.
- **Supervisor poll (24/7):** a cron/systemd timer invokes you every N min; each tick runs ONE one-shot \`pidge listen --all --timeout 50\` (block up to 50s, print, exit 0; exit 3 = nothing this tick — the \`--all\` ear also catches answers to questions you fire-and-forgot), do the work, \`pidge ack --up-to <id>\`, sleep. \`--timeout\` is always SECONDS. Do NOT background \`pidge listen\` with \`&\`.
- **Ack with attribution:** \`pidge ack --up-to <id> --summary "<what you did>"\` — a successor runtime (or your own next session) reads it in \`pidge catchup\` instead of redoing the work. Make it a habit on every ack.

## The 24/7 supervisor: \`pidge bridge\`

When your human wants you reachable around the clock without a harness session, run the built-in supervisor instead of hand-rolling a loop:

\`pidge bridge --exec '<your handler>'\` — it long-polls the queue, runs your handler ONCE per batch (batch JSON on stdin), and acks the batch's exact ids only when the handler exits 0. A lockfile enforces ONE consumer per channel (a second bridge or \`listen\` is refused). While your handler runs (up to 30 min), the bridge automatically RENEWS the batch's lease every 60 s — the lease never lapses mid-run and the human keeps seeing "listening now"; you do nothing for it. \`pidge bridge install\` writes a launchd/systemd template and declares \`listen_mode: external_daemon\` for you.

Tell the next session WHAT you did: end your handler's output with one line — \`pidge-summary: <one sentence>\` — and the ack carries it; \`pidge catchup\` then shows "handled by <you>: <that sentence>". Full contract: \`pidge bridge --help\`.

## Sign your messages with the execution (\`pidge run\`)

So the human can tell ONE continuous session apart from three disposable cold ones, sign your messages with an **execution attribution run**:

- **At the start of an interactive session:** \`eval "$(pidge run start --mode interactive --role main --label <your-agent-name>)"\`. This sets \`PIDGE_RUN_TOKEN\`/\`PIDGE_RUN_SEAL\` in your env; every \`pidge\` call you make afterward is stamped with that execution, so each message shows WHO spoke.
- **Subagents / workers you spawn:** \`eval "$(pidge run start --mode interactive --role subagent --parent-seal $PIDGE_RUN_SEAL)"\` inside the child, so it signs as its own execution under yours.
- **When you finish:** \`pidge run end\`.

This is **attribution, not a credential** — your channel key still authenticates; the run only reveals which execution is talking (the human sees "label · mode/SEAL"). An old server just ignores it (you keep sending unsigned). \`pidge run status\` lists the channel's live runs. \`pidge bridge\` mints its own run per handler automatically — don't call these inside it.

## Full spec

\`curl $PIDGE_URL/api/v1/manifest -H "Authorization: Bearer $PIDGE_TOKEN"\` — the always-current contract (fields, profiles, custom actions, media, threads, realtime).

${SKILL_END_MARKER}
`;
  const file = destFor();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  // never clobber silently — the installed skill may have been customized.
  // When the file being replaced differs from what we're writing, keep the old
  // content as <dest>.bak and say so in one stderr line.
  let previous = null;
  try { previous = fs.readFileSync(file, 'utf8'); } catch { /* no existing file */ }
  if (previous !== null && previous !== skill) {
    // NEVER clobber an existing .bak. The FIRST install
    // to a shared target (agents/gemini) parks the user's ORIGINAL file (e.g. their
    // hand-written AGENTS.md) at <dest>.bak; a later re-install whose generated
    // content changed would otherwise overwrite that .bak with our now-stale skill,
    // destroying the only copy of their work. If .bak is taken, use a timestamped
    // sibling so every prior version survives. (Date is fine here — the CLI process,
    // not a workflow script.)
    let bak = `${file}.bak`;
    if (fs.existsSync(bak)) bak = `${file}.bak.${Date.now()}`;
    fs.writeFileSync(bak, previous);
    // Name the ACTUAL destination file, not a hardcoded "SKILL.md"
    // (a --target agents/gemini install writes AGENTS.md/GEMINI.md).
    console.error(`pidge: the previous ${path.basename(file)} differed from the regenerated one — saved to ${bak}`);
  }
  // ATOMIC replace — write a per-process tmp, then rename. A killed process or
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
      // whoami MUST also report HONEST reach + SHOUT on a claim swap,
      // not just doctor — the same shared helpers (deliverable, ANOTHER AGENT…).
      reportDeviceReach(data);
      reportClaimMismatch(data);
      // live consumers + predecessor provenance (present-only).
      reportConsumers(data);
      reportProvenance(data);
      process.exit(0);
      break;
    }
    case 'skill': {
      if (parsed.positionals[1] !== 'install') die('pidge: usage: pidge skill install [--target claude|agents|gemini]', 1);
      // --target picks the DESTINATION (claude → .claude skill · agents →
      // AGENTS.md · gemini → GEMINI.md); the generated content is identical.
      const target = (v.target || 'claude').trim().toLowerCase();
      if (!SKILL_TARGETS[target])
        die(`pidge: unknown --target ${JSON.stringify(v.target)} — use claude (default), agents or gemini`, 1);
      let r;
      try { r = await installSkill(BASE, TOKEN, target); } catch (e) { die(`pidge: ${e.message}`, 2); }
      console.error(`pidge: skill written to ${r.file} (target ${target}, manifest v${r.manifest_version}) — your future sessions in this project know Pidge now`);
      console.log(JSON.stringify({ ok: true, file: r.file, target, manifest_version: r.manifest_version }));
      process.exit(0);
    }
    // === AXIS 1 — the married catalog of 5. Each stamps the
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
      // the verb drives the REAL /live_activities endpoints now — the
      // old silent degrade (template_kind:live → a message-profile /notify 201
      // with no card) is dead. --wait is refused inside (status never answers).
      await doLive();
      break;
    // --- compat aliases: old type names → the new canonical 5. They
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
    // `approval` = the RECIPE: important + Approve/Reject
    // (Face ID on Approve) + --wait. A shortcut for an explicit go/no-go; the human
    // can override the pair with their own --actions/--custom-action.
    case 'approval': {
      const extra = hasAnswerAffordance() ? {} : { custom_actions: APPROVAL_ACTIONS };
      await doTypedSend('important', { wait: true, extra, label: 'approval' });
      break;
    }
    // — the hook-shaped, deny-default permission gate (allow→0, everything
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
      // — the first-contact WOW: fire the onboarding handshake and block on
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
      // validate the knobs BEFORE the send — a typo dies here (exit 1) instead
      // of hanging the handshake forever on a NaN deadline.
      // --timeout defaults to 120 s (was the onboarding template's ~3600 s, which
      // let `hello` pin a fresh session indefinitely — a live agent had to KILL it).
      // The handshake is durable: a missing confirmation is "not yet", never lost.
      const timeoutArg = numStrict(v.timeout, '--timeout', 120);
      const intervalArg = numStrict(v.interval, '--interval', 30);
      const cid = v['correlation-id'] || crypto.randomUUID();
      v['correlation-id'] = cid;
      console.error(`pidge: correlation_id=${cid}`);
      const { ok, info } = await doNotify();
      if (!ok) process.exit(2);
      console.error(`pidge: WOW sent (${info.registered_devices} device(s)) — watch the lock screen narrate the handshake; waiting up to ${timeoutArg}s for your human to confirm on ${cid}`);
      // a timeout exits 3 NARRATED (mirrors the ask/wait contract) — the
      // confirmation is safe in the queue; `pidge listen --all` collects it later.
      await waitForAnswer(cid, {
        timeout: timeoutArg,
        interval: intervalArg,
        // the default print-and-exit-0, plus the stay-online nudge — the
        // handshake closing is EXACTLY when the agent decides what to do next.
        // nudgeStayOnline fetches whoami itself (best-effort, consumer-gated).
        onAnswer: async (chosen) => {
          console.log(JSON.stringify(chosen, null, 2));
          await nudgeStayOnline();
          process.exit(0);
        },
        onTimeout: () => {
          const elapsed = Math.round((performance.now() - SESSION_START_MONO) / 1000);
          console.error(`pidge: no confirmation yet after ${elapsed}s — it stays in your queue (at-least-once, nothing lost); \`pidge listen --all\` picks it up when your human taps. (exit 3 = no answer yet, not a failure)`);
          process.exit(3);
        },
      });
      break;
    }
    case 'ask': {
      // `ask` = the preserved shortcut: important + --wait + REQUIRES a way to
      // answer. There is no `ask` TYPE in the married catalog —
      // asking is "a type + buttons + wait". The legacy alias keeps working because
      // it always ships with buttons. `live`/tracking is refused (it never answers).
      await doTypedSend('important', { wait: true, requireAnswerable: true, label: 'ask' });
      break;
    }
    case 'wait': {
      const cid = parsed.positionals[1];
      if (!cid) die('pidge: usage: pidge wait <correlation_id> [--timeout N] [--interval N]', 1);
      // strict — a NaN deadline would make this wait eternal (fail-closed instead)
      await waitForAnswer(cid, { timeout: numStrict(v.timeout, '--timeout', 300), interval: numStrict(v.interval, '--interval', 30) });
      break;
    }
    case 'cancel': {
      // withdraw a still-scheduled notification (also kills a snooze re-fire).
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
      // read-receipt split: mark messages PROCESSED (green ✓✓) AFTER you've
      // durably handled them — `listen` only DELIVERS them now. --renew
      // (state=delivered) instead RENEWS the visibility-timeout lease, a
      // heartbeat for a long task so the reservation doesn't lapse and re-serve.
      //
      // `--summary` is a global BOOLEAN (for `inbox --summary`), so the
      // module-level parse would read `ack --summary "text"` as boolean-true and
      // drop "text" to an ignored positional — a SILENT no-op on an attribution
      // field. Re-parse THIS command's argv with `summary` typed as a string so
      // the value survives; a bare `--summary` (no value) now THROWS → usage
      // error, never a no-op. Everything else parses identically to the global.
      let av;
      try {
        av = parseArgs({ options: { ...OPTIONS, summary: { type: 'string' } }, allowPositionals: true }).values;
      } catch (e) {
        die(`pidge: ack: ${e.message}\n  usage: pidge ack --up-to <id> | --ids a,b [--renew] [--summary "<what you did>"]`, 1);
      }
      const ackBody = {};
      if (av['up-to'] !== undefined && av.ids !== undefined)
        die('pidge: pass EITHER --up-to <id> OR --ids a,b, not both', 1);
      // strict ids — a lazy parse here silently acks the wrong watermark
      // (and the old .filter(Number.isFinite) silently DROPPED bad ids).
      if (av['up-to'] !== undefined) ackBody.up_to = idStrict(av['up-to'], '--up-to');
      else if (av.ids !== undefined) ackBody.ids = av.ids.split(',').map((s) => idStrict(s, '--ids'));
      else die('pidge: usage: pidge ack --up-to <id> | --ids a,b [--renew] [--summary "<what you did>"]', 1);
      if (av.renew) ackBody.state = 'delivered';
      // attribution — the successor session sees WHAT this handler did
      // (server handler_summary on the history row, shown by `pidge catchup`).
      // A present-but-EMPTY --summary is a usage error, never a silent no-op; the
      // server caps the field, we also send at most 1000 chars.
      if (av.summary !== undefined) {
        const s = String(av.summary).trim();
        if (!s) die('pidge: ack --summary needs a value (e.g. --summary "restarted the worker") — pass text or omit the flag', 1);
        ackBody.summary = s.slice(0, 1000);
      }
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
      if (av.renew) console.error(`pidge: lease renewed on ${adata.renewed ?? 0} message(s) (still yours; ack again when done)`);
      else console.error(`pidge: processed ${adata.acked ?? 0} message(s)${ackBody.summary ? ' with a summary (visible in `pidge catchup`)' : ''} — green ✓✓ (the human sees "lida pelo agente")`);
      // the ack may have annotated messages a PRIOR
      // consumer already acked without a note — narrate it (present-only; a
      // an older server omits `annotated`).
      if (Number(adata.annotated) > 0)
        console.error(`pidge: annotated ${adata.annotated} previously-acked message(s) — filled in the attribution a prior consumer left blank.`);
      // The "what next" line, LAST so it reads as the next step. Only a real
      // ack (work done) — a --renew is a mid-task heartbeat, the listener is
      // deliberately NOT running then. The bridge never takes this path (its
      // internal ackBatch above owns that loop), so no suppression needed here.
      if (!av.renew)
        console.error('pidge: ✓ acked. Relaunch your listener (`pidge listen --all`) to stay online.');
      process.exit(0);
      break;
    }
    case 'contract': {
      await runContract();
      break;
    }
    case 'run': {
      // execution attribution — start/end/status. start exits after printing
      // the eval-friendly export lines; end/status exit inside their handlers.
      await runRunCommand();
      break;
    }
    case 'bridge': {
      // the 1st-class supervisor. `bridge install` writes the launchd/
      // systemd template; bare `bridge --exec` runs the loop (forever — its
      // lifecycle belongs to the OS supervisor / the human, not a timeout).
      const sub = parsed.positionals[1];
      if (sub === 'install') { await runBridgeInstall(); break; }
      if (sub !== undefined)
        die("pidge: usage: pidge bridge --exec '<handler>'  |  pidge bridge install --exec '<handler>'", 1);
      await runBridge();
      break;
    }
    case 'selftest': {
      // prove reachability by round-trip. Fire a nonce, run the listener,
      // confirm it picks it up + acks in time. PASS exit 0 / FAIL exit 2.
      await doSelftest();
      break;
    }
    case 'inbox': {
      // what this channel sent — the list (default), the pending slice
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
    case 'catchup': {
      // READ-ONLY situational read. GET /messages?history=true&all=true — the
      // WHOLE thread (server never consumes/stamps delivered/opens a lease on the
      // history read), answers (notification_reply) included. This verb
      // NEVER acks and NEVER holds a lease: it's the safe way to SITUATE yourself at
      // the start of an interactive session on a channel whose real consumer is
      // ANOTHER runtime (a 24/7 bridge/daemon) — you read what's already handled
      // without stealing a message. One consumer per channel: catchup here, and
      // NEVER `listen` (which would double-consume). Exit 0 (printed, even empty) / 2.
      const qs = new URLSearchParams();
      qs.set('history', 'true');
      // --all is default-ON for catchup (the situational read WANTS the answers to
      // earlier notifications, not just composer messages) — always request them.
      qs.set('all', 'true');
      // The server IGNORES `limit` on the ?history=true
      // path (it always returns the whole thread), so --limit must be enforced
      // LOCALLY — a slice of the newest N after the sort below. --before IS honored
      // server-side (older-than paging); we still forward both (harmless if a future
      // server learns limit), but the local slice is the guarantee, not the query.
      let catchupLimit = null;
      if (v.limit !== undefined) {
        catchupLimit = parseInt(v.limit, 10);
        if (!Number.isInteger(catchupLimit) || catchupLimit < 1)
          die(`pidge: --limit must be a positive integer (got ${JSON.stringify(v.limit)})`, 1);
        qs.set('limit', String(catchupLimit));
      }
      if (v.before !== undefined) qs.set('before', v.before);
      // --since <id> — the incremental cursor. STRICT numeric (same class as
      // --up-to/--ids: a lazy parse would silently read the wrong watermark). Forwarded
      // to the server AND enforced locally below, so "since my last session" is
      // O(new) regardless of whether this server paginates history by id.
      let catchupSince = null;
      if (v.since !== undefined) {
        catchupSince = idStrict(v.since, '--since');
        qs.set('since', String(catchupSince));
      }
      // the cursor the LAST catchup left, keyed by CHANNEL (hash(token)) — the
      // same keying the E2E pin uses, so a catchup on channel A never contaminates
      // the --since suggested for channel B from the same config dir. Read BEFORE we
      // overwrite it below; a no-`--since` run suggests it so the agent situates in
      // O(new) next time.
      const channelKey = channelKeyFor(TOKEN);
      const priorCursor = v.since === undefined && channelKey
        ? ((readState().catchupLastSeen || {})[channelKey] || null) : null;
      let res, data;
      try {
        res = await fetchT(`${BASE}/api/v1/messages?${qs}`, { headers });
        data = await res.json().catch(() => ({}));
      } catch (e) {
        die(`pidge: catchup failed (network): ${e.message}`, 2);
      }
      await checkManifestNews(res);
      if (!(res.status >= 200 && res.status < 300))
        die(`pidge: catchup failed (${res.status}): ${JSON.stringify(data)}`, 2);
      // note the flag when the history carries it — the reader is looking
      // at the very rows the warning is about.
      warnStalePriorClaim(data, 'They are included in the thread below — note which predate you before acting on them.');
      // Open sealed rows locally (E2E history is ciphertext on the wire) — same path
      // listen uses; on a channel with no secret / clear rows this is a passthrough.
      const rows = Array.isArray(data.messages) ? data.messages : [];
      // catchup re-runs constantly (the --digest session-start ritual), so
      // don't re-fetch/re-unseal attachments each time. --digest (rarely needs the
      // bytes) OR explicit --no-download ⇒ skip the download; a full catchup reuses
      // a copy already on disk (skip-if-exists) instead of re-downloading.
      const catchupDl = { noDownload: !!(v.digest || v['no-download']), skipIfExists: true };
      const opened = await Promise.all(rows.map((m) => e2eOpenMessageRow(m, catchupDl)));
      // Newest first (the situational read wants the latest context up top); the
      // server orders history this way already, but sort defensively by id desc.
      opened.sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0));
      // the highest id in the WHOLE thread (before any --since/--limit slice) —
      // the cursor to persist so the NEXT no-`--since` catchup can suggest it.
      const highestId = opened.reduce((mx, m) => Math.max(mx, Number(m.id) || 0), 0);
      // --since <id> filters to STRICTLY newer rows, client-side (belt-and-braces
      // over the server query) — acceptable at the catchup scale (≤200). Applied before
      // --limit, so --limit still means "the newest N of what's new".
      const fresh = catchupSince != null ? opened.filter((m) => (Number(m.id) || 0) > catchupSince) : opened;
      // Enforce --limit locally (server ignores it here) — the
      // newest N after the sort/since-filter.
      const printed = catchupLimit != null ? fresh.slice(0, catchupLimit) : fresh;
      if (v.digest) {
        // --digest — one condensed line per message. The condensed view for
        // "what happened, who handled what" before offering work; the raw JSON works
        // against that purpose on a long thread.
        for (const m of printed) {
          const kind = m.kind || 'message';
          const body = String(m.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
          // an in-flight lease held by ANOTHER runtime (self-filtered)
          // appends "being handled by X since T" — the sibling took it, don't redo.
          const inflight = beingHandledLine(m);
          const state = inflight ? `${digestHandledState(m)} · ${inflight}` : digestHandledState(m);
          console.log(`${m.id} · ${kind} · ${body} · ${state}`);
        }
      } else {
        console.log(JSON.stringify({ messages: printed }, null, 2));
        // Newer servers: a PROCESSED row carries
        // acked_by_label + handler_summary — narrate WHO already handled it and WHAT
        // they did, so the reader sees the other consumer's work instead of re-offering
        // it (the whole point of catchup). In --digest mode this rides inline instead.
        // Present-only: rows without the fields (never acked, or an older server) skip.
        for (const m of printed) {
          if (m.acked_by_label || m.handler_summary) {
            const who = m.acked_by_label || 'another consumer';
            const what = m.handler_summary ? `: ${String(m.handler_summary)}` : '';
            console.error(`pidge: message ${m.id} handled by ${who}${what}`);
          }
        }
      }
      // remember the highest id seen (per channel) so a later no-`--since` run
      // can suggest the cursor. Best-effort (writeState swallows a read-only fs). Date
      // is fine here — the CLI process, not a workflow script. Only ADVANCE the cursor:
      // a `--before` page (older rows) has a lower highest and must NOT regress it.
      const cursors = readState().catchupLastSeen || {};
      const storedId = (channelKey && cursors[channelKey] && cursors[channelKey].id) || 0;
      if (channelKey && highestId > storedId)
        writeState({ catchupLastSeen: { ...cursors, [channelKey]: { id: highestId, at: new Date().toISOString() } } });
      const replies = printed.filter((m) => m.kind === 'notification_reply').length;
      const clipped = catchupLimit != null && fresh.length > printed.length
        ? ` (newest ${printed.length} of ${fresh.length} — --limit; drop it or raise --before to see more)` : '';
      const sinceNote = catchupSince != null ? ` since id ${catchupSince}` : '';
      console.error(`pidge: catchup — ${printed.length} message(s)${sinceNote} in the thread${clipped}${replies ? ` · ${replies} answer(s) to earlier notifications` : ''}, read-only: NOT consumed, NOT acked. This is a peek; it never steals a message from another consumer.`);
      // The incremental-cursor nudge must ALWAYS surface on stderr — an
      // agent ALWAYS pipes (no TTY), and a repeat situating run must still learn the
      // --since cursor even when the thread hasn't moved. The old gate (only when a
      // prior cursor existed AND the thread moved past it) meant a fresh channel, or a
      // quiet one polled a few times, printed NO tip at all (the observed bug). Now:
      // any no-`--since` run that saw messages prints the cursor on stderr; stdout stays
      // clean (JSON or digest only). It points at the CURRENT highest id — the right
      // cursor for "only what arrives after".
      if (v.since === undefined && highestId > 0) {
        let newerNote = '';
        if (priorCursor && priorCursor.id && highestId > priorCursor.id) {
          const n = opened.filter((m) => (Number(m.id) || 0) > priorCursor.id).length;
          newerNote = ` (${n} new since your last read at id ${priorCursor.id})`;
        }
        console.error(`pidge: cursor — newest message is id ${highestId}${newerNote}. Next session: \`pidge catchup --digest --since ${highestId}\` shows only what arrives after.`);
      }
      process.exit(0);
      break;
    }
    case 'online':
      // `pidge online` = `pidge listen --all`, one word — so a pasted prompt can
      // just say "stay online: pidge online". Sugar ONLY: it forces --all (the
      // single ear) and falls through into listen — same loop, same flags, no
      // duplicated implementation.
      v.all = true;
      // fall through
    case 'listen': {
      // block until the human messages this channel (the app's composer),
      // print the messages as JSON, ACK them, exit 0. One-shot by design (loop
      // it, don't daemonize) — same contract as `wait`. Exit 3 on timeout, 4 if
      // the whole session never had a healthy round-trip.
      // At-least-once: the ack happens AFTER the print — a crash re-serves them;
      // dedupe by id if you've seen one before.
      // --all: the SINGLE EAR — the queue also serves notification
      // ANSWERS (kind notification_reply, with a self-contained ref), so a
      // fire-and-forget notify can't lose its reply. Without --all the original
      // composer-only contract stands (no double-consumption for ask/wait users).
      // refuse to double-consume a channel a RUNNING bridge owns (the lock
      // is pid-checked — a stale lock from a crashed bridge never blocks a
      // listen). Local-machine advisory by construction, which is exactly the
      // failure mode it exists for; `catchup` stays the read path.
      const bridgeHolder = bridgeLockHolder();
      if (bridgeHolder)
        die(`pidge: listen REFUSED — a running \`pidge bridge\` (pid ${bridgeHolder.pid}${bridgeHolder.label ? `, "${bridgeHolder.label}"` : ''}) is this channel's consumer; a second consumer double-consumes. Read with \`pidge catchup\` (read-only), or stop the bridge first.`, 2);
      installOrphanWatchdog(); // a killed-parent orphan exits instead of eating the queue
      // strict — same class as wait/ask/approve: a NaN deadline never ends
      const timeout = numStrict(v.timeout, '--timeout', 600);
      const listenInterval = numStrict(v.interval, '--interval', 5);
      const listenStartedAt = Date.now();
      let deadline = Date.now() + timeout * 1000;
      const queueQs = v.all ? '?all=true' : '';
      // the exit-3 hint — a message you EXPECT may be under a visibility lease
      // from another read (a selftest, a crashed listener, a bridge), invisible to
      // this listen until it lapses. `pidge catchup` shows the whole queue read-only.
      const LEASE_HINT = 'if you expected a message, it may be under a visibility lease from another read (a selftest / crashed listener / bridge) — `pidge catchup` shows the whole queue read-only (delivered_at/lease), never consuming.';
      // the exit-3 companion: the RELAUNCH reflex. A one-shot listener that
      // isn't relaunched is an agent that quietly went offline — say so every
      // empty round. Suppressed under --follow (a supervisor window ending is
      // its own contract, not a lapse in the loop).
      const RELAUNCH_NUDGE = v.follow ? null : 'Nothing arrived this round. Relaunch the listener now — the loop (listen → handle → ack → relaunch) is what keeps you online.';
      // The FIRST batch that comes back QUICKLY was already sitting in
      // the queue when this listen started — with --all that includes answers to
      // EARLIER notifications, which read as "new" if we don't say otherwise. A
      // batch that arrives after a real hold (a long-poll that waited) is fresh.
      const BACKLOG_WINDOW_MS = 5000;
      let firstBatch = true;
      // --follow is SUPERVISOR-ONLY — warn LOUDLY at startup. A turn-based
      // agent that uses it traps its turn (the process keeps listening); the
      // default one-shot, looped from the supervisor, is what almost everyone wants.
      if (v.follow) {
        console.error('pidge: --follow keeps this process listening until --timeout (supervisor mode).');
        console.error('pidge: a TURN-BASED agent must NOT use --follow — it traps the turn. Use the');
        console.error('pidge: default one-shot (loop the command from your supervisor) instead.');
      }
      // --follow: print+ack a batch and KEEP listening until the
      // timeout — the supervisor loop without re-spawning a process per batch.
      let gotAny = false;
      const followEnd = () => {
        if (v.follow && gotAny) {
          console.error(`pidge: --follow window ended after ${timeout}s — batches were delivered`);
          process.exit(0);
        }
        return false;
      };

      // read-receipt split: by DEFAULT a read message is DELIVERED (gray
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
        // async now — a sealed attachment is downloaded + unsealed to a
        // local path here (attachment.path in the printed JSON).
        const msgs = await Promise.all(msgsRaw.map((m) => e2eOpenMessageRow(m)));
        console.log(JSON.stringify(msgs, null, 2));
        // Heads-up on ORPHANED backlog served on the first quick read
        // (--all only). It's within-channel — NOT the cross-channel leak.
        if (v.all && firstBatch && (Date.now() - listenStartedAt) < BACKLOG_WINDOW_MS) {
          const replies = msgs.filter((m) => m.kind === 'notification_reply').length;
          const detail = replies ? ` (${replies} of them are answers to EARLIER notifications)` : '';
          console.error(`pidge: --all — ${msgs.length} message(s) were ALREADY queued when this listen started${detail}: OLD backlog (sent while you weren't listening), NOT fresh arrivals. This is your OWN channel's backlog, not a cross-channel leak.`);
        }
        firstBatch = false;
        // narrate answers so the agent knows WHICH notification spoke back.
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

      // Realtime path: hold ConversationChannel — the human sees "ouvindo
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
              const data = await res.json().catch(() => ({}));
              warnStalePriorClaim(data); // session-header warning, once
              warnConsumerConflict(data); // the consume GET flags a live sibling
              const msgs = data.messages || [];
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
          params: wsIdentityParams(),
          deadline,
          onUp: (finish) => {
            if (!announced) { announced = true; console.error(`pidge: listening over the realtime socket${v.all ? ' — single ear: composer + notification answers' : ''} (the human sees "ouvindo agora")`); }
            drain(finish);
          },
          onFrame: (m, finish) => { if (m.type === 'message') drain(finish); },
        })];
        // --all: answers broadcast on InboxChannel, not Conversation — a
        // second subscription wakes the same HTTP drain (the queue is the ledger;
        // the loser session leaks until exit, harmless in a one-shot process).
        if (v.all) {
          sessions.push(cableSession({
            channel: 'InboxChannel',
            params: wsIdentityParams(),
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
          health.exitTimeout('no message from the human', LEASE_HINT, RELAUNCH_NUDGE);
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
            warnStalePriorClaim(data); // session-header warning, once
            warnConsumerConflict(data); // the consume GET flags a live sibling
            const msgs = data.messages || [];
            if (msgs.length) await printAndAck(msgs);
          } else if (res.status >= 500) {
            health.fail(`listen error ${res.status}`); // aggregated — no line per attempt
          } else {
            health.ok();
            console.error(`pidge: listen error ${res.status}`);
          }
        } catch (e) {
          health.fail(`network: ${e.message}`);
        }
        if (Date.now() >= deadline) {
          followEnd();
          health.exitTimeout('no message from the human', LEASE_HINT, RELAUNCH_NUDGE);
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
