# pidge

Send rich, actionable **iPhone notifications to a human and block until they answer** —
built for AI agents (Hermes, Claude Code, or any agent with a shell).

It's a thin wrapper over the [Pidge](https://pidge.sh) API. The real value is
`ask`/`wait`: the agent fires a notification and **blocks until the human responds**,
then gets the answer as JSON — no webhook, no polling loop to write.

> **The contract lives server-side.** `GET $PIDGE_URL/api/v1/manifest` is the always-
> current spec (fields, profiles, guarantees). This CLI is a thin pipe over it — any
> new server field works without a CLI update via `--param key=value`.

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
--interval SECONDS      FALLBACK poll cadence (default 30) — normally unused: the
                        server long-polls each GET (?wait=55), answers are ~instant
```

## Contract (important for agents)

- **`ask` prints `correlation_id=<cid>` as its FIRST stderr line** (minted client-side
  when you don't pass one) — a killed `ask` always leaves the handle behind, so you
  can `pidge wait <cid>` instead of re-sending.
- **stdout is always machine-readable.** `notify` → the raw 201 JSON; `ask`/`wait` →
  the `chosen_action` JSON. Everything human (warnings, the correlation_id, snooze
  notices, armed-escalation and policy-degrade narration) goes to **stderr**.
- **Exit codes:** `0` answered · `3` timed out (= *no answer yet*, NOT a failure —
  back off and retry later) · `2` error · `1` usage.
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
