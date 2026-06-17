# pidge

Send rich, actionable **iPhone notifications to a human and block until they answer** —
built for AI agents (Hermes, Claude Code, or any agent with a shell).

It's a thin wrapper over the [Pidge](https://pidge.sh) API. The real value is
`ask`/`wait`: the agent fires a notification and **blocks until the human responds**,
then gets the answer as JSON — no webhook, no polling loop to write.

> **The contract lives server-side.** `GET $PIDGE_URL/api/v1/manifest` is the always-
> current spec (fields, profiles, guarantees). This CLI is a thin pipe over it — any
> new server field works without a CLI update via `--param key=value`.

> **New in v0.9.0** (ships with Pidge manifest v27): **`listen` no longer consumes on
> read** — a read message is DELIVERED, and you `ack` it after the work (a ~10-min
> server lease re-serves un-acked messages, so a crash never loses one; `--ack-on-read`
> restores the old behavior). A WS close **1006 now degrades to long-polling** on the
> same deadline instead of exiting early, and timeouts report the **real** elapsed time.
> New: `ack`, `contract`, `--version`; `setup` claims channel ownership and `doctor`
> reports honest device reach + warns on a silent key swap.
>
> **v0.9.1** (Pidge manifest v28): full spec conformance — `setup` now **declares your
> operating contract** (`listen_mode`, default `turn_based`; `--listen-mode persistent`
> for a supervisor); `contract set` rejects an unknown key/bad value **locally**;
> `whoami` reports honest device reach and SHOUTS on a silent key swap (not just
> `doctor`); `doctor` **exits 2** when devices exist but none are reachable; `--follow`
> prints a loud supervisor-only warning; the ack-after-work notice shows **once per
> install**; and the timeout clock is monotonic. `operating_contract` is **advisory** —
> Pidge is a relay: you declare how you operate, the human registers their expectation
> and *sees* if you honor it; nothing is forced.
>
> **v0.9.2**: `contract set` no longer prints the channel JSON (which echoed the key) —
> stdout now carries only the `operating_contract`, so the key never lands in an agent's
> transcript/logs.
>
> **v0.10.0** (Pidge manifest v29): the onboarding-close batch. **`pidge selftest`** proves
> your listener works by ROUND-TRIP (#205) — fire a nonce, run the listener, confirm it
> picks it up + acks in time (PASS exit 0 / FAIL exit 2 with the likely cause). `listen_mode`
> grew to **`turn_based | persistent | external_daemon`** (`always_on` is a tolerated alias),
> so you declare the mode that matches your runtime. And `listen` installs an **orphan-zombie
> guard**: a background listener whose parent (harness) dies exits instead of consuming the
> channel forever. The full operating guide now lives at `<base>/agent-setup`.

## Setup in one command (v0.8.0 — the claim flow)

```bash
# The human copies a setup prompt from the Pidge app (Canais → the channel) —
# it carries a SINGLE-USE claim code (15 min TTL), never the key:
npx pidge-cli setup --claim <code> --url https://pidge.sh
# → exchanges the code for the real key, stores it (chmod 600), runs `pidge doctor`.
#   The secret never appears on screen or in any chat (the CLI writes it).

npx pidge-cli doctor   # validate anytime: env source, server, key, "canal X · N devices"
npx pidge-cli whoami   # which channel does this key speak for (JSON)
```

### Many agents on one machine — isolate them (read this)

`~/.config/pidge/env` is **one slot per machine-user**: every agent without its
own identity reads the same key, so one agent's `setup` makes another agent send
as the wrong channel (this bit us for real — a cron got hijacked). Each agent
must have its **own** identity. Cheapest correct setups, in order:

```bash
# A. per-agent env var — the cleanest; the human sets it at the agent's launch
#    (systemd unit / launcher / profile). Env var always wins over any file.
export PIDGE_TOKEN=hld_…        # this agent only

# B. per-agent config file — set ONE non-secret id at launch; the CLI namespaces
#    the file to ~/.config/pidge/agents/<id>/env and still writes the key for you
#    (no secret in the agent's chat). setup/doctor/everything follow it.
export PIDGE_AGENT=javier
npx pidge-cli setup --claim <code>

# C. you're at YOUR terminal and want the env var hygienically from a claim:
npx pidge-cli setup --claim <code> --print   # prints `export …`; writes nothing
#    paste the two lines into THAT agent's launcher. NEVER run --print as an agent
#    (the key would land in its context) — that's what A/B are for.
```

The bare `~/.config/pidge/env` (no `PIDGE_AGENT`) is fine for a **single** agent;
`pidge doctor` warns loudly when you're on that shared file. Lost the local key?
Just re-claim — `POST /claim` returns the channel's **same** key, so re-running
setup restores the exact identity.

## Use it (no install — via npx)

```bash
export PIDGE_URL=https://pidge.sh                  # your Pidge server
export PIDGE_TOKEN=hld_xxx                          # your channel's bearer key
# (or skip the exports: the CLI reads ~/.config/pidge/env — KEY=VALUE — so the
#  key never has to appear in an agent's chat; explicit env vars win)

# Send AND wait for the answer (the one an agent wants):
npx pidge-cli ask \
  --title "Aprovar deploy?" --actions yes,no,reply --timeout 600

# Urgent — escalates to an AlarmKit alarm if the human doesn't answer in minutes:
npx pidge-cli ask \
  --title "Posso rodar a migration?" --profile escalating --actions yes,no

# A thing with a known time — push at T−lead + a lock-screen countdown to the event:
npx pidge-cli notify \
  --title "Reunião com o time" --profile event --event-at "2026-06-10T15:00:00"

# A chart you generated — uploaded for you, shown on the banner + feed:
npx pidge-cli notify --title "Gráfico pronto" --image ./chart.png

# A real artifact — the human previews it on the phone, shares it, saves to Files:
npx pidge-cli notify --title "Relatório" --file ./relatorio.xlsx
```

`ask` prints the chosen action as JSON to **stdout** and exits `0`:

```json
{ "kind": "acted", "action_id": "yes", "label": "Sim", "text": null,
  "at": "2026-06-08T18:19:51Z", "snooze_until": null }
```

## Commands

| Command | What it does |
|---|---|
| `ask` | Send a notification **and block** until the human answers; prints the chosen action JSON. The default for agents. |
| `notify` | Send only. Prints the raw 201 JSON; the `correlation_id` + warnings go to stderr. |
| `wait <correlation_id>` | Block on an already-sent notification until it's answered. |
| `cancel <correlation_id>` | Cancel a **still-scheduled** notification before it fires (idempotent; 409 once it reached the phone). |
| `inbox` | What you sent: list, `--pending` slice, or `--summary` (counts + answer latency). |
| `listen` | Block until the human **messages you** from the app; prints them, exits `0`. One-shot — loop it. **v0.9.0:** a read message is DELIVERED (gray ✓✓), **not** done — `ack` it after the work (`--ack-on-read` for the old immediate-consume). |
| `ack --up-to <id>` | **v0.9.0:** mark messages PROCESSED (green ✓✓) **after** you've handled them; `--renew` heartbeats the visibility-timeout lease on a long task. |
| `contract set <k>=<v>` / `contract show` | **v0.9.0:** DECLARE how you operate (`keep_connection_alive`, `mirror_in_origin_session`, `listen_mode=turn_based\|persistent\|external_daemon`, `quiet_when_idle`). **Advisory, never policy** — you declare, the human registers their expectation and *sees* if you honor it; Pidge enforces nothing. An unknown key/bad value is rejected locally (exit 1). |
| `selftest [--window N]` | **v0.10.0 (#205):** prove your listener works by ROUND-TRIP — fire a nonce, run the listener, confirm it picks it up + acks in time. PASS exit `0` / FAIL exit `2` with the likely cause (timeout / orphan / transport). Run it as the last onboarding step + whenever sends seem to go unheard. |
| `setup --claim <code>` | One-shot onboarding (v0.7.0): exchange the single-use code for the key, store it in `~/.config/pidge/env` (600), run doctor. **v0.9.0** also claims channel ownership so `doctor` can warn on a silent key swap. **v0.9.1+** declares your `operating_contract` (default `listen_mode=turn_based`; `--listen-mode persistent\|external_daemon` for a supervisor/daemon). |
| `doctor` | Validate the setup **without exposing secrets**: env source, server reachable, key valid, **honest device reach**, channel ownership. Exit 0/2. |
| `whoami` | Which channel does this key speak for (JSON). |
| `skill install` | Write `.claude/skills/pidge/SKILL.md` generated from the live manifest — persistent Pidge knowledge for Claude Code agents; re-run to update. |
| `--version` | Print the CLI version. |

## Realtime (v0.6.0)

`listen`/`ask`/`wait` hold a **WebSocket** to the server (ActionCable at `/cable`)
whenever the runtime has one (**Node ≥22**): answers and messages land in **<1 s**,
an idle hours-long `listen` **survives server deploys by reconnecting**, and while
you listen the human sees **"ouvindo agora"** in the app — they type more when the
light is on.

Everything durable still goes over HTTP (backlog reads + acks), so a dropped
socket costs latency, never data. The degrade ladder narrates itself on stderr:

```
WebSocket  →  ?wait= long-poll (capped 25 s server-side)  →  plain GETs every ~45 s
              (automatic after repeated WS failures)         (after 3 consecutive
                                                              failures on held polls)
```

- `--realtime` forces WS (warns + falls back if unavailable) · `--no-realtime` = polling only.
- **Deafness exits LOUD**: a session that times out with **zero** healthy round-trips
  exits `4` (≠ `3`, "the human didn't answer") — the channel itself looks broken;
  surface it instead of retrying blindly.

## Options (for `notify` / `ask`)

```
--title TEXT            (required) the headline
--body TEXT             the message shown on the banner
--body-markdown MD      rich body for the tap-through detail screen
--subtitle TEXT
--profile ID            delivery profile — the HUMAN owns what each one does:
                        default · event (needs --event-at; countdown Live Activity) ·
                        escalating (alarm if unanswered minutes after delivery) ·
                        the user's custom profiles. See the manifest's `profiles`.
--event-at ISO8601      WHEN the thing happens (a FACT; required by profile event)
--lead-minutes N        notify/start the countdown N min before event_at (5–240)
--urgency LEVEL         normal | persistent | alarm (low-level — prefer --profile)
--image PATH_OR_URL     image on the banner + feed: a local path is uploaded for you
                        (your machine has no public URL); an https URL is sent as-is
--file PATH             a real artifact (xlsx, pdf, csv…) the human previews, shares
                        and saves on the phone; uploaded automatically (≤25 MB)
--url URL               deep link the app opens when the user taps (PR, dashboard, log)
--copy TEXT             value offered as tap-to-copy on the detail (code, token)
--actions LIST          comma list: yes,no,approve,reject,accept,decline,later,
                        done,snooze,reschedule,reply,mute
--custom-action SPEC    "id:label[:destructive][:confirm][:biometric][:terminal]"
                        (repeatable — your own buttons)
--deliver-at ISO8601    schedule for later
--reply-to URL          also POST the answer to your webhook (HMAC-signed)
--correlation-id ID     idempotency + routing key (auto-generated if omitted)
--collapse-key KEY      replace/update a prior notification
--param KEY=VALUE       pass ANY raw /notify field (repeatable) — future server
                        fields work day-one, no CLI update needed
--timeout SECONDS       ask: default 600 · wait: default 300
--interval SECONDS      FALLBACK poll cadence (default 30) — normally unused: WS or
                        the server-held long-poll (?wait=25) make answers ~instant
--realtime              force the WebSocket (Node ≥22); --no-realtime = polling only
```

## Contract (important for agents)

- **`ask` prints `correlation_id=<cid>` as its FIRST stderr line** (minted client-side
  when you don't pass one) — a killed `ask` always leaves the handle behind, so you
  can `pidge wait <cid>` instead of re-sending.
- **stdout is always machine-readable.** `notify` → the raw 201 JSON; `ask`/`wait` →
  the `chosen_action` JSON. Everything human (warnings, the correlation_id, snooze
  notices, armed-escalation and policy-degrade narration) goes to **stderr**.
- **Exit codes:** `0` answered · `3` timed out (= *no answer yet*, NOT a failure —
  back off and retry later) · `4` timed out **without one healthy round-trip all
  session** (the CHANNEL looks broken — server/network — tell your human) ·
  `2` error · `1` usage.
- **Responses are one-and-done.** Every answer closes the notification EXCEPT a
  **snooze** (or a reschedule that set a new time), which re-fires later. `ask`/`wait`
  keep polling through a snooze and print `snooze_until` so you can schedule a re-check.
- **Profiles degrade, never reject.** An over-ceiling profile is delivered at the
  channel's allowed level — read `degraded`/`degrade_reason` in the 201 (narrated on
  stderr). That's the human's policy working; don't retry harder.
- **`ask --profile tracking` is refused** — tracking is Live-Activity-only and never
  produces an answer.
- A genuine follow-up question is a **new** notification, never a second answer on
  the same one.

ENV: `PIDGE_URL` / `PIDGE_TOKEN` (the old `HERALD_URL` / `HERALD_TOKEN` still work);
with neither set, `~/.config/pidge/env` (KEY=VALUE) is read — the key-free path.

Full machine-readable spec: `GET $PIDGE_URL/api/v1/manifest` (Bearer auth).

## License

MIT
