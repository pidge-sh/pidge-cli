#!/usr/bin/env node
'use strict';
//
// herald — CLI so an agent (Hermes, or a running Claude Code) can send a rich
// iPhone notification AND block until the human answers (polling — the primary
// read path for terminal/CLI use, where there's no webhook to receive a reply).
//
//   export HERALD_URL=https://herald.example.com   # default http://localhost:3000
//   export HERALD_TOKEN=hld_xxx                     # the channel's bearer key
//
//   # send AND block until the human answers, then print the chosen action as JSON
//   herald ask --title "Aprovar deploy?" --actions yes,no,reply --timeout 600
//
//   # send only (prints the 201 JSON; correlation_id + warnings go to stderr)
//   herald notify --title "Reunião em 15 min" --body "Sala 3" --actions done,snooze
//
//   # block on an already-sent notification (by correlation_id)
//   herald wait order-7 --timeout 300 --interval 5
//
// stdout is ALWAYS machine-readable: `notify` prints the raw 201 JSON; `ask`/`wait`
// print the chosen_action JSON. Everything human (warnings, the correlation_id,
// snooze notices) goes to stderr. Exit codes: 0 = responded, 3 = timed out (= "no
// answer yet", NOT a failure — back off and retry later), 2 = error, 1 = usage.

const { parseArgs } = require('node:util');

const BASE = process.env.HERALD_URL || 'http://localhost:3000';
const TOKEN = process.env.HERALD_TOKEN;

function die(msg, code = 1) { console.error(msg); process.exit(code); }
if (!TOKEN) die('herald: set HERALD_TOKEN');

const OPTIONS = {
  title: { type: 'string' },
  body: { type: 'string' },
  'body-markdown': { type: 'string' },
  subtitle: { type: 'string' },
  urgency: { type: 'string' },                 // normal | persistent | alarm
  actions: { type: 'string' },                 // comma list from the catalog
  'custom-action': { type: 'string', multiple: true }, // id:label[:destructive][:confirm][:biometric][:terminal]
  'deliver-at': { type: 'string' },
  'reply-to': { type: 'string' },
  'correlation-id': { type: 'string' },
  'collapse-key': { type: 'string' },
  timeout: { type: 'string' },
  interval: { type: 'string' },
};

const USAGE =
  'Usage: herald notify|ask [options]\n' +
  '       herald wait <correlation_id> [--timeout N] [--interval N]\n' +
  'Options: --title --body --body-markdown --subtitle --urgency --actions\n' +
  '         --custom-action "id:label[:destructive][:confirm][:biometric][:terminal]" (repeatable)\n' +
  '         --deliver-at --reply-to --correlation-id --collapse-key --timeout --interval';

let parsed;
try {
  parsed = parseArgs({ options: OPTIONS, allowPositionals: true });
} catch (e) {
  die(`herald: ${e.message}\n${USAGE}`, 1);
}
const v = parsed.values;
const command = parsed.positionals[0];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

// Map CLI flags → the /notify JSON body, including only what was provided.
function buildBody() {
  if (!v.title) die('herald: --title is required', 1);
  const body = { title: v.title };
  if (v.body !== undefined) body.body = v.body;
  if (v['body-markdown'] !== undefined) body.body_markdown = v['body-markdown'];
  if (v.subtitle !== undefined) body.subtitle = v.subtitle;
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
  return body;
}

// POST /notify. Returns { ok, info, raw }. Emits to STDERR the two things an agent
// most needs (0 devices / detail_only), so stdout stays free for machine output.
async function doNotify() {
  let res, raw;
  try {
    res = await fetch(`${BASE}/api/v1/notify`, {
      method: 'POST', headers, body: JSON.stringify(buildBody()),
    });
    raw = await res.text();
  } catch (e) {
    die(`herald: send failed (network): ${e.message}`, 2);
  }
  const ok = res.status >= 200 && res.status < 300;
  let info = {};
  try { info = JSON.parse(raw); } catch { /* leave {} */ }
  if (ok) {
    if (info.registered_devices === 0)
      console.error('herald: 0 registered devices — nobody will receive this');
    if (info.render_mode === 'detail_only')
      console.error('herald: render_mode=detail_only — the banner shows NO buttons; the user must open the app to act (use a banner-eligible action shape if you want quick taps)');
  } else {
    console.error(`herald: send failed (${res.status}): ${raw}`);
  }
  return { ok, info, raw };
}

// Poll GET /notifications/:cid until a TERMINAL answer, print chosen_action JSON to
// stdout, exit 0. A snooze (snooze / reschedule-to-a-time) is non-terminal — it
// re-fires — so keep waiting through it. Exits 3 on timeout.
async function doWait(cid, { timeout, interval }) {
  const deadline = Date.now() + timeout * 1000;
  const url = `${BASE}/api/v1/notifications/${encodeURIComponent(cid)}`;
  for (;;) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 200) {
        const data = await res.json().catch(() => ({}));
        if (data.responded) {
          const chosen = data.chosen_action || {};
          if (chosen.kind === 'snoozed') {
            console.error(`herald: snoozed until ${chosen.snooze_until || chosen.at} — re-fires then, still waiting`);
          } else {
            console.log(JSON.stringify(chosen, null, 2));
            process.exit(0);
          }
        }
      } else if (res.status === 404) {
        console.error(`herald: no notification for correlation_id=${cid}`);
        // keep polling — the agent may call wait/ask before the send round-trips
      } else {
        console.error(`herald: poll error ${res.status}`);
      }
    } catch (e) {
      console.error(`herald: poll error (network): ${e.message}`);
    }

    if (Date.now() >= deadline) {
      console.error(`herald: timed out after ${timeout}s waiting on ${cid} (= 'no answer yet', not a failure)`);
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
        console.error(`herald: correlation_id=${info.correlation_id} (use: herald wait ${info.correlation_id})`);
      process.exit(ok ? 0 : 2);
      break;
    }
    case 'ask': {
      // Send, then block on the answer in one shot. stdout = ONLY chosen_action JSON.
      const { ok, info } = await doNotify();
      if (!ok) process.exit(2);
      const cid = info.correlation_id || v['correlation-id'];
      if (!cid) die('herald: notify did not return a correlation_id', 2);
      console.error(`herald: sent (${info.registered_devices} device(s)) — waiting on ${cid}`);
      await doWait(cid, { timeout: num(v.timeout, 600), interval: num(v.interval, 10) });
      break;
    }
    case 'wait': {
      const cid = parsed.positionals[1];
      if (!cid) die('herald: usage: herald wait <correlation_id> [--timeout N] [--interval N]', 1);
      await doWait(cid, { timeout: num(v.timeout, 300), interval: num(v.interval, 5) });
      break;
    }
    default:
      die(USAGE, 1);
  }
})();
