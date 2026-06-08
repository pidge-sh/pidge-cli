# herald-cli

Send rich, actionable **iPhone notifications to a human and block until they answer** —
built for AI agents (Hermes, Claude Code, or any agent with a shell).

It's a thin wrapper over the [Herald](https://github.com/thiagoc77/herald) API. The
real value is `ask`/`wait`: the agent fires a notification and **blocks until the
human responds**, then gets the answer as JSON — no webhook, no polling loop to write.

## Use it (no install — via npx)

```bash
export HERALD_URL=https://your-herald-host         # your Herald server
export HERALD_TOKEN=hld_xxx                          # your channel's bearer key

# Send AND wait for the answer (the one an agent wants):
npx github:thiagoc7/herald-cli ask \
  --title "Aprovar deploy?" --actions yes,no,reply --timeout 600
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

## Options (for `notify` / `ask`)

```
--title TEXT            (required) the headline
--body TEXT             the message shown on the banner
--body-markdown MD      rich body for the tap-through detail screen
--subtitle TEXT
--urgency LEVEL         normal | persistent | alarm
--actions LIST          comma list: yes,no,approve,reject,accept,decline,later,
                        done,snooze,reschedule,reply,mute
--custom-action SPEC    "id:label[:destructive][:confirm][:biometric][:terminal]"
                        (repeatable — your own buttons)
--deliver-at ISO8601    schedule for later
--reply-to URL          also POST the answer to your webhook (HMAC-signed)
--correlation-id ID     idempotency + routing key (auto-generated if omitted)
--collapse-key KEY      replace/update a prior notification
--timeout SECONDS       ask: default 600 · wait: default 300
--interval SECONDS      poll cadence — ask: default 10 · wait: default 5
```

## Contract (important for agents)

- **stdout is always machine-readable.** `notify` → the raw 201 JSON; `ask`/`wait` →
  the `chosen_action` JSON. Everything human (warnings, the correlation_id, snooze
  notices) goes to **stderr**.
- **Exit codes:** `0` answered · `3` timed out (= *no answer yet*, NOT a failure —
  back off and retry later) · `2` error · `1` usage.
- **Responses are one-and-done.** Every answer closes the notification EXCEPT a
  **snooze** (or a reschedule that set a new time), which re-fires later. `ask`/`wait`
  keep polling through a snooze and print `snooze_until` so you can schedule a re-check.
- A genuine follow-up question is a **new** notification, never a second answer on
  the same one.

Full machine-readable spec: `GET $HERALD_URL/api/v1/manifest` (Bearer auth).

## License

MIT
