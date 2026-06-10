#!/usr/bin/env node
'use strict';
//
// pidge — CLI so an agent (Hermes, or a running Claude Code) can send a rich
// iPhone notification AND block until the human answers (polling — the primary
// read path for terminal/CLI use, where there's no webhook to receive a reply).
//
//   export PIDGE_URL=https://pidge.sh              # default http://localhost:3000
//   export PIDGE_TOKEN=hld_xxx                     # the channel's bearer key
//   (HERALD_URL / HERALD_TOKEN are honored as a fallback)
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
//   pidge wait order-7 --timeout 300 --interval 5
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

const BASE = process.env.PIDGE_URL || process.env.HERALD_URL || 'http://localhost:3000';
const TOKEN = process.env.PIDGE_TOKEN || process.env.HERALD_TOKEN;

function die(msg, code = 1) { console.error(msg); process.exit(code); }
if (!TOKEN) die('pidge: set PIDGE_TOKEN');

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  title: { type: 'string' },
  body: { type: 'string' },
  'body-markdown': { type: 'string' },
  subtitle: { type: 'string' },
  profile: { type: 'string' },                 // delivery profile id (manifest `profiles`)
  'event-at': { type: 'string' },              // WHEN the thing happens (profile event)
  'lead-minutes': { type: 'string' },          // notify/countdown lead before event_at
  urgency: { type: 'string' },                 // normal | persistent | alarm (low-level — prefer --profile)
  image: { type: 'string' },                   // banner+feed image: local path → uploaded; URL → as-is
  file: { type: 'string' },                    // real artifact (xlsx/pdf/csv…): local path → uploaded
  actions: { type: 'string' },                 // comma list from the catalog
  'custom-action': { type: 'string', multiple: true }, // id:label[:destructive][:confirm][:biometric][:terminal]
  'deliver-at': { type: 'string' },
  'reply-to': { type: 'string' },
  'correlation-id': { type: 'string' },
  'collapse-key': { type: 'string' },
  param: { type: 'string', multiple: true },   // key=value escape hatch → raw /notify field
  timeout: { type: 'string' },
  interval: { type: 'string' },
};

const USAGE = `pidge — send an iPhone notification to a human and block until they answer.

USAGE
  pidge ask    [options]                  send AND wait for the answer (prints chosen_action JSON)
  pidge notify [options]                  send only (prints the 201 JSON)
  pidge wait   <correlation_id> [options] block on an already-sent notification
  pidge --help

OPTIONS (notify / ask)
  --title TEXT             (required) the headline
  --body TEXT              message shown on the banner
  --body-markdown MD       rich body for the tap-through detail screen
  --subtitle TEXT
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
  --actions LIST           comma list: yes,no,approve,reject,accept,decline,later,
                           done,snooze,reschedule,reply,mute
  --custom-action SPEC     "id:label[:destructive][:confirm][:biometric][:terminal]" (repeatable)
  --deliver-at ISO8601     schedule for later
  --reply-to URL           also POST the answer to your webhook (HMAC-signed)
  --correlation-id ID      idempotency + routing key (auto-generated if omitted)
  --collapse-key KEY       replace/update a prior notification
  --param KEY=VALUE        pass ANY raw /notify field (repeatable) — future server
                           fields work without a CLI update; the manifest is the contract
  --timeout SECONDS        ask: 600 · wait: 300
  --interval SECONDS       poll cadence — ask: 10 · wait: 5

ENV
  PIDGE_URL     your Pidge server (default http://localhost:3000; HERALD_URL honored)
  PIDGE_TOKEN   your channel's bearer key (required; HERALD_TOKEN honored)

OUTPUT
  stdout is machine-readable (notify→201 JSON; ask/wait→chosen_action JSON);
  human notices go to stderr. Exit: 0 answered · 3 timed out (no answer yet,
  not a failure) · 2 error · 1 usage.

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

// The server advertises its manifest version on every response. When it's newer
// than what this CLI shipped knowing, nudge ONCE on stderr — the agent re-reads
// the manifest (whats_new) and learns the new capabilities without polling.
const KNOWN_MANIFEST_VERSION = 2;
let newsWarned = false;
function checkManifestNews(res) {
  const v = parseInt(res.headers.get('x-pidge-manifest-version') || '0', 10);
  if (v > KNOWN_MANIFEST_VERSION && !newsWarned) {
    newsWarned = true;
    console.error(`pidge: the server has NEW capabilities (manifest v${v}; this CLI knows v${KNOWN_MANIFEST_VERSION}) — re-read GET $PIDGE_URL/api/v1/manifest (see whats_new) and consider updating the CLI`);
  }
}

// Map CLI flags → the /notify JSON body, including only what was provided.
function buildBody() {
  if (!v.title) die('pidge: --title is required', 1);
  const body = { title: v.title };
  if (v.body !== undefined) body.body = v.body;
  if (v['body-markdown'] !== undefined) body.body_markdown = v['body-markdown'];
  if (v.subtitle !== undefined) body.subtitle = v.subtitle;
  if (v.profile !== undefined) body.profile = v.profile;
  if (v['event-at'] !== undefined) body.event_at = v['event-at'];
  if (v['lead-minutes'] !== undefined) body.lead_minutes = parseInt(v['lead-minutes'], 10);
  if (v.urgency !== undefined) body.urgency = v.urgency;
  if (v['deliver-at'] !== undefined) body.deliver_at = v['deliver-at'];
  if (v['reply-to'] !== undefined) body.reply_to = v['reply-to'];
  if (v['correlation-id'] !== undefined) body.correlation_id = v['correlation-id'];
  if (v['collapse-key'] !== undefined) body.collapse_key = v['collapse-key'];
  if (v.actions !== undefined) body.actions = v.actions.split(',').filter(Boolean);

  const customs = v['custom-action'] || [];
  if (customs.length) {
    body.custom_actions = customs.map((spec) => {
      const [id, label, ...flags] = spec.split(':');
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
  } else {
    console.error(`pidge: send failed (${res.status}): ${raw}`);
  }
  return { ok, info, raw };
}

// Poll GET /notifications/:cid until a TERMINAL answer, print chosen_action JSON to
// stdout, exit 0. A snooze (snooze / reschedule-to-a-time) is non-terminal — it
// re-fires — so keep waiting through it. Exits 3 on timeout.
async function doWait(cid, { timeout, interval }) {
  const deadline = Date.now() + timeout * 1000;
  const url = `${BASE}/api/v1/notifications/${encodeURIComponent(cid)}`;
  let firedNotice = false;
  for (;;) {
    try {
      const res = await fetch(url, { headers });
      checkManifestNews(res);
      if (res.status === 200) {
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
          console.error('pidge: the escalation alarm FIRED and there is still no answer — the human may have stopped the alarm on-device (that is not reported back); keep waiting or back off');
        }
      } else if (res.status === 404) {
        console.error(`pidge: no notification for correlation_id=${cid}`);
        // keep polling — the agent may call wait/ask before the send round-trips
      } else {
        console.error(`pidge: poll error ${res.status}`);
      }
    } catch (e) {
      console.error(`pidge: poll error (network): ${e.message}`);
    }

    if (Date.now() >= deadline) {
      console.error(`pidge: timed out after ${timeout}s waiting on ${cid} (= 'no answer yet', not a failure)`);
      process.exit(3);
    }
    await sleep(interval * 1000);
  }
}

const num = (val, fallback) => (val !== undefined ? parseInt(val, 10) : fallback);

(async () => {
  switch (command) {
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
      const { ok, info } = await doNotify();
      if (!ok) process.exit(2);
      const cid = info.correlation_id || v['correlation-id'];
      if (!cid) die('pidge: notify did not return a correlation_id', 2);
      console.error(`pidge: sent (${info.registered_devices} device(s)) — waiting on ${cid}`);
      await doWait(cid, { timeout: num(v.timeout, 600), interval: num(v.interval, 10) });
      break;
    }
    case 'wait': {
      const cid = parsed.positionals[1];
      if (!cid) die('pidge: usage: pidge wait <correlation_id> [--timeout N] [--interval N]', 1);
      await doWait(cid, { timeout: num(v.timeout, 300), interval: num(v.interval, 5) });
      break;
    }
    default:
      die(USAGE, 1);
  }
})();
