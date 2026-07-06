# pidge

Send rich, actionable **iPhone notifications to a human and block until they answer** —
built for AI agents (Hermes, Claude Code, or any agent with a shell).

It's a thin wrapper over the [Pidge](https://pidge.sh) API. The real value is
`ask`/`wait`: the agent fires a notification and **blocks until the human responds**,
then gets the answer as JSON — no webhook, no polling loop to write.

> **The contract lives server-side.** `GET $PIDGE_URL/api/v1/manifest` is the always-
> current spec (fields, profiles, guarantees). This CLI is a thin pipe over it — any
> new server field works without a CLI update via `--param key=value`.

> **New in v0.17.0** — **end-to-end encryption on the wire** (#43, E2E v1). When your
> human turns E2E on for a channel, the setup prompt hands you a **`PIDGE_SECRET`**
> (same slot/precedence as `PIDGE_TOKEN`) and every send seals its content
> (title/body/markdown + custom-action labels) into AES-256-GCM envelopes **the server
> cannot read**; `listen`/`wait`/`ask` decrypt the human's sealed messages and answers
> back to plaintext locally. No secret? Sends go clear and the app marks them
> "⚠️ sem criptografia" — never blocked. See **End-to-end encryption** below.
>
> **New in v0.16.x** — **`pidge approve`** (0.16.0): the hook-shaped, **deny-default
> permission gate** — sends a Face-ID allow/deny pair and maps the human's answer to an
> **exit code** (0 ONLY on explicit allow; deny/timeout/broken channel → 1; a raw network
> error on the send → 2). Built for a Claude Code `PreToolUse` hook that must fail CLOSED.
> ⚠️ Trust caveat: the gate is only as trustworthy as the process **env** — whatever can
> rewrite `PIDGE_URL`/`PIDGE_TOKEN` can redirect the approval (and the bearer token) to
> its own server; run hooks in an environment you trust. Also in 0.16.0: a **decision +
> `reply` in one send is refused** (exit 1, nothing sent) — one tap on `reply` would dodge
> the decision; use `--actions reply` ALONE when you need text. **0.16.1** hardens the gate
> (an unparseable `--timeout`/`--interval` now dies immediately instead of waiting forever)
> and the self-heal (atomic write, torn files detected, `SKILL.md.bak` before clobbering a
> customized skill).
>
> **New in v0.15.x** — the local skill **self-heals**: any networked pidge command detects
> a stale `.claude/skills/pidge/SKILL.md` (CLI spine or server manifest moved) and silently
> regenerates it, so an onboarded agent's next session is always current (`pidge skill
> install` still exists for the first write).
>
> **New in v0.14.0** — the **married vocabulary** (perfis): the CLI now speaks the same
> language as the server (manifest v42) and the app. **One list of 5 types** —
> `pidge message · important · urgent · event · live` (message←fyi, important←report,
> urgent←alert; old names still work as aliases). **RESPONSE is a separate axis**:
> `--actions`/`--custom-action` add buttons on ANY type, and **`--wait`** blocks until
> the human answers — the explicit *send-and-go vs wait*. `pidge ask` is now the shortcut
> for `important --wait`; new **`pidge approval`** = important + Approve/Reject + Face
> ID + wait. `important` is the recommended default.
>
> **New in v0.12.0** — CLI bugs batch (all reported by an agent in real use): **`pidge
> <sub> --help`** now shows that subcommand's own help (its flags), not the global dump
> (#240); the **manifest-version nag is throttled to once / 24 h** (cached in
> `~/.config/pidge/state.json`) with `--quiet-nag` / `PIDGE_QUIET_NAG=1` to silence it
> (#241); **`--actions` accepts a JSON array** of custom `{id,label}` actions for custom
> labels (#242; the short comma form like `yes,no` unchanged — note 0.16.0 now REFUSES a
> decision combined with `reply` in one send); the nag's manifest re-read
> example now shows the **`Authorization: Bearer`** header so it doesn't 401 (#243); and
> `skill install` writes an **"always-on for turn-based agents"** recipe (#244).
>
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
> **v0.11.1** (Pidge manifest v31): **`pidge doctor` now probes the realtime path** (#171) —
> after the HTTP checks it opens a quick `/cable` subscription and reports `realtime: ok` or
> `realtime: INDISPONÍVEL` (the #119 failure class an HTTP-only doctor couldn't see: an edge
> killing held responses, a proxy refusing the WebSocket). Exit stays `0` — an unavailable WS
> just degrades `listen` to polling — but you learn it BEFORE the first deaf listen. The doctor
> hint now leads with `pidge hello`, and the version nudge knows v31 (#229).
>
> **v0.11.0** (Pidge manifest v30): the **first-contact WOW** (#217). New **`pidge hello`** —
> your channel's debut handshake, narrated LIVE on the lock screen by a server-driven 3-stage
> Live Activity (Conectando → toque para confirmar → Concluído ✓) so your human *sees* the
> agent→human→agent loop close. Send + wait in one; run it as your first contact on a fresh
> channel. (It's a thin `ask --template onboarding` wrapper — that path already works on v0.10.0.)
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

# Just inform — fire-and-forget (clears when the human opens it):
npx pidge-cli message --title "Build green" --body "2m12s"

# A pendency they should resolve — the DEFAULT type ("waiting-for-you" card):
npx pidge-cli important --title "Review PR #42" --url https://github.com/…/pull/42

# Send AND wait for the answer (the one an agent wants) — = important + --wait:
npx pidge-cli ask \
  --title "Approve deploy?" --actions yes,no --timeout 600
# (need a TYPED answer instead? --actions reply ALONE — a decision + reply in one
#  send is refused since 0.16.0: one tap on reply would dodge the decision)

# A go/no-go with Face ID — the approval RECIPE (= important + Approve/Reject + wait):
npx pidge-cli approval --title "Deploy to production?"

# Gate YOUR OWN risky action behind a human Face-ID tap — deny-default exit codes,
# built for permission hooks (exit 0 ONLY on explicit allow):
npx pidge-cli approve "Run the schema migration?" --body "Drops legacy_orders" --timeout 300

# Urgent — breaks through silent/Focus; --escalate forces an AlarmKit alarm:
npx pidge-cli urgent --title "Balance dropped below $5k" --escalate

# A thing with a known time — push at T−lead + a lock-screen countdown to the event:
npx pidge-cli event \
  --title "Team meeting" --event-at "2026-06-10T15:00:00"

# A chart you generated — uploaded for you, shown on the banner + feed:
npx pidge-cli message --title "Chart ready" --image ./chart.png

# A real artifact — the human previews it on the phone, shares it, saves to Files:
npx pidge-cli important --title "Report" --file ./report.xlsx
```

`ask`/`approval` (and any `--wait` send) print the chosen action as JSON to
**stdout** and exit `0`:

```json
{ "kind": "acted", "action_id": "yes", "label": "Sim", "text": null,
  "at": "2026-06-08T18:19:51Z", "snooze_until": null }
```

## Two axes: the TYPE + the RESPONSE

You pick **one type** (how much it may intrude — the human already configured how each
arrives), then ORTHOGONALLY decide the **response** (buttons? wait or not?).

**Axis 1 — type** (the married catalog of 5):

| Type | For | Clears when |
|---|---|---|
| `pidge message` | just inform, no action | the human OPENS it |
| `pidge important` ⭐ | a pendency they should resolve (the DEFAULT) | **Feito** |
| `pidge urgent` | wake them now (rare, real); `--escalate` = AlarmKit alarm | Feito (cuts the alarm) |
| `pidge event --event-at <ISO>` | a thing with a known time (countdown LA) | passed / Feito |
| `pidge live` | track something live (Live Activity) | you end it |

**Axis 2 — response** (composes on ANY type): `--actions yes,no` / `--custom-action`
add buttons (free text is always available); `--wait` blocks until the human answers
(else fire-and-forget — the answer arrives later in `pidge listen --all`). Two shortcuts
bundle both: **`pidge ask`** = `important --wait` (needs `--actions`); **`pidge approval`**
= `important` + Approve/Reject + Face ID + `--wait`.

> Old names still work as **aliases**: `fyi`→message, `report`→important, `alert`→urgent.

## Commands

| Command | What it does |
|---|---|
| `message` / `important` / `urgent` / `event` / `live` | The 5 message types (axis 1). Fire-and-forget by default; add `--actions`/`--wait` (axis 2) to ask for a reply. `important` is the recommended default. |
| `ask` | `important --wait` shortcut: send **and block** until the human answers; prints the chosen action JSON. Requires a way to answer (`--actions`/`--custom-action`/`--template`). |
| `approval` | Go/no-go RECIPE: `important` + Approve (Face ID) / Reject + `--wait`. Pass your own `--actions` to override the pair. |
| `approve "<question>"` | **v0.16.0 (#34):** the hook-shaped, **deny-default permission gate** — send a Face-ID allow/deny pair, block, and answer with an **exit code**: `0` ONLY on an explicit allow; deny / timeout / no answer / a broken channel / an HTTP send failure → `1`; only a raw network error (the send never reached the server) → `2`. **Non-zero always means "not approved."** Built for a Claude Code `PreToolUse` hook that must fail CLOSED (`pidge approve --help` has a runnable hook). ⚠️ The gate is only as trustworthy as the process env (`PIDGE_URL`/`PIDGE_TOKEN`) — see the caveat below. |
| `hello` | **v0.11.0 (#217):** your channel's **first-contact WOW** — send the onboarding handshake **and block** until the human confirms. The server narrates a 3-stage Live Activity on the lock screen (Conectando → toque para confirmar → Concluído ✓) so they *see* the agent→human→agent loop close. Run it as your **first** contact on a fresh channel. A thin `ask --template onboarding` wrapper with friendly default copy. |
| `notify` | **Deprecated** — send without a type (the server picks the channel default). Prefer a typed send. Prints the raw 201 JSON; the `correlation_id` + warnings go to stderr. |
| `wait <correlation_id>` | Block on an already-sent notification until it's answered. |
| `cancel <correlation_id>` | Cancel a **still-scheduled** notification before it fires (idempotent; 409 once it reached the phone). |
| `inbox` | What you sent: list, `--pending` slice, or `--summary` (counts + answer latency). |
| `catchup` | **v0.21.0 (#58):** a **READ-ONLY** peek at the whole conversation (`GET /messages?history=true&all=true`) — the thread newest-first, notification answers included. **NEVER consumes**: no ack, no delivered stamp, no lease. Run it to **situate yourself** at the start of an interactive session on a channel whose real consumer is **another runtime** (a bridge/daemon) — so you learn what's already handled without stealing a message. `--limit N` / `--before ID` to page. Exit `0` (printed, even empty) / `2`. **One consumer per channel** — if another runtime consumes this channel, `catchup` here and **never `listen`** (that double-consumes). |
| `listen` | Block until the human **messages you** from the app; prints them, exits `0`. One-shot — loop it. **v0.9.0:** a read message is DELIVERED (gray ✓✓), **not** done — `ack` it after the work (`--ack-on-read` for the old immediate-consume). ⚠️ `listen` **consumes** — run it only on a channel YOU are the sole consumer of; to read a channel another runtime consumes, use `catchup`. **v0.22.0 (#59):** refuses (exit `2`) while a live `pidge bridge` holds this channel's lock. |
| `bridge --exec '<handler>'` | **v0.22.0 (#59):** the **24/7 supervisor** — the productized "paste a prompt and the agent stays online". Long-polls the channel (`--all`); your handler runs **once per batch** with the batch JSON on stdin (`{"messages":[…]}` + `history_hint:true` on the first batch since boot); handler exit `0` ⇒ ack of the batch's **exact ids** (never an `up_to` watermark — that would stamp rows under lease from an earlier FAILED batch) · non-zero ⇒ **not acked** (the ~10-min server lease re-serves — make the handler **idempotent**). One run is capped by `--handler-timeout` (default 30 min: SIGTERM, SIGKILL 5s later, counts as a failed batch), with a stderr heartbeat every 5 min while the handler runs. Model-agnostic: `--exec 'claude -p …' \| 'codex exec …' \|` any script. **One instance per channel**: a PID-checked lockfile by `hash(token)` refuses a second bridge/`listen` (a stale lock from a crash is recovered). 401 / broken channel → narrated + **local alert** + long **jittered** backoff — never a silent death, never a blind hot loop. SIGTERM/SIGINT are clean: in-flight batch NOT acked, lock released, exit `0`. Deliberately DUMB: no local queue — durability is the server's ack/lease. |
| `bridge install --exec '<handler>'` | **v0.22.0 (#59):** write the launchd (Mac) / systemd user (Linux) **template** that runs the bridge with `Restart=on-failure` semantics, and declare `listen_mode=external_daemon` (advisory). The template **never embeds the key** (it stays in `~/.config/pidge/env`); enable with the printed `launchctl`/`systemctl` command. |
| `ack --up-to <id>` | **v0.9.0:** mark messages PROCESSED (green ✓✓) **after** you've handled them; `--renew` heartbeats the visibility-timeout lease on a long task. |
| `contract set <k>=<v>` / `contract show` | **v0.9.0:** DECLARE how you operate (`keep_connection_alive`, `mirror_in_origin_session`, `listen_mode=turn_based\|persistent\|external_daemon`, `quiet_when_idle`). **Advisory, never policy** — you declare, the human registers their expectation and *sees* if you honor it; Pidge enforces nothing. An unknown key/bad value is rejected locally (exit 1). |
| `selftest [--window N]` | **v0.10.0 (#205):** prove your listener works by ROUND-TRIP — fire a nonce, run the listener, confirm it picks it up + acks in time. PASS exit `0` / FAIL exit `2` with the likely cause (timeout / orphan / transport). Run it as the last onboarding step + whenever sends seem to go unheard. |
| `setup --claim <code>` | One-shot onboarding (v0.7.0): exchange the single-use code for the key, store it in `~/.config/pidge/env` (600), run doctor. **v0.9.0** also claims channel ownership so `doctor` can warn on a silent key swap. **v0.9.1+** declares your `operating_contract` (default `listen_mode=turn_based`; `--listen-mode persistent\|external_daemon` for a supervisor/daemon). |
| `doctor` | Validate the setup **without exposing secrets**: env source, server reachable, key valid, **honest device reach**, channel ownership, and (**v0.11.1, #171**) a **realtime probe** (`realtime: ok / INDISPONÍVEL` — exit stays 0; an unavailable WS just degrades `listen` to polling). Exit 0/2. |
| `whoami` | Which channel does this key speak for (JSON). |
| `skill install [--target T]` | Write the generated Pidge skill from the live manifest — persistent Pidge knowledge for an AI agent; re-run to update. **v0.21.0 (#58):** `--target` picks the destination (same content): `claude` (default) → `.claude/skills/pidge/SKILL.md` · `agents` → `AGENTS.md` · `gemini` → `GEMINI.md`. An existing file whose content differs is backed up to `<dest>.bak` first (or `<dest>.bak.<timestamp>` if that backup already exists, so a re-install never destroys your original). ⚠️ **Only the `claude` target self-heals** (any pidge command silently refreshes a stale `.claude` skill); `AGENTS.md`/`GEMINI.md` do **not** auto-update — re-run `pidge skill install --target agents\|gemini` yourself to refresh them. |
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

## End-to-end encryption (v0.17.0)

When the human flips **E2E on** for a channel (in the Pidge app), a 32-byte key is
generated **on their device** — the server never sees it. You receive it as
**`PIDGE_SECRET`** (base64url) inside the channel's **setup prompt**, right next to
`PIDGE_TOKEN`: same slot, same precedence (env var wins, else
`~/.config/pidge[/agents/<id>]/env`; `setup --claim` stores the pair together, and
`--print` emits both export lines). The `{TOKEN, SECRET}` pair always travels from ONE
source — mixing a token from one channel with a secret from another is exactly the
mixup the `kf` fingerprint catches.

What changes, concretely:

- **Sends seal themselves.** With the secret set and the channel E2E, every send's
  `title`/`subtitle`/`body`/`body_markdown` + custom-action **labels** leave your
  machine as `v1:` envelopes with `enc:"v1"` + `kf` alongside (action IDs, profile,
  urgency, cid and timestamps stay clear — the server needs them to route). The 201
  echo prints decrypted for display. Media (`--image`/`--file`) still rides clear
  until phase E3.
- **`listen` decrypts the human's sealed messages.** A `kind:"message"` row carrying
  `enc:"v1"` opens locally before printing; answers to your notifications
  (`listen --all`, `wait`, `ask`) decrypt too. Rows **without** `enc` are clear
  history and render exactly as before.
- **Errors are precise, never garbage.** A sealed row the CLI can't open is blanked
  with an `e2e_error` naming the reason — "sealed with ANOTHER key" (kf mismatch),
  missing `correlation_id`, unknown version, missing secret — base64 never reaches
  your terminal.
- **No secret ⇒ nothing breaks.** Sends go clear and the app marks them
  "⚠️ sem criptografia"; run `pidge doctor` — it validates the secret (32 bytes, shows
  the kf), warns on an orphan secret, and exits 2 when an E2E channel's secret is
  invalid.

Honest scope (from the server manifest's `e2e` section): this protects content against
the **server** (infra, DB dumps, the operator). It does NOT protect against a
compromised agent machine — `PIDGE_SECRET` sits in your env/config in the clear; the
"ends" are the human's device and **your agent**.

## Options (for `notify` / `ask`)

```
--title TEXT            (required) the headline
--body TEXT             the message shown on the banner
--body-markdown MD      rich body for the tap-through detail screen
--subtitle TEXT
--profile ID            low-level alias of the TYPE — the HUMAN owns what each does:
                        message · important · urgent · event (needs --event-at) ·
                        live · the user's custom profiles. Prefer the typed
                        subcommands above; an explicit --profile still wins.
--event-at ISO8601      WHEN the thing happens (a FACT; required by event)
--lead-minutes N        notify/start the countdown N min before event_at (5–240)
--urgency LEVEL         normal | persistent | alarm (low-level — prefer --profile)
--image PATH_OR_URL     image on the banner + feed: a local path is uploaded for you
                        (your machine has no public URL); an https URL is sent as-is
--file PATH             a real artifact (xlsx, pdf, csv…) the human previews, shares
                        and saves on the phone; uploaded automatically (≤25 MB)
--url URL               deep link the app opens when the user taps (PR, dashboard, log)
--copy TEXT             value offered as tap-to-copy on the detail (code, token)
--actions LIST|JSON     comma list of catalog ids: yes,no,approve,reject,accept,
                        decline,later,done,snooze,reschedule,reply,mute — OR a JSON
                        array of custom actions for your own labels:
                        '[{"id":"approve","label":"Aprovar agora"},{"id":"defer","label":"Depois"}]'
--custom-action SPEC    "id:label[:destructive][:confirm][:biometric][:terminal]"
                        (repeatable — your own buttons; composes with --actions JSON)
--wait                  RESPONSE axis: block until the human answers (ANY type), then
                        print chosen_action JSON. Without it: fire-and-forget (the
                        answer arrives later in `pidge listen --all`). ask/approval imply it.
--deliver-at ISO8601    schedule for later
--reply-to URL          also POST the answer to your webhook (HMAC-signed)
--correlation-id ID     idempotency + routing key (auto-generated if omitted)
--collapse-key KEY      replace/update a prior notification
--param KEY=VALUE       pass ANY raw /notify field (repeatable) — future server
                        fields work day-one, no CLI update needed
--timeout SECONDS       how long --wait blocks (ask/approval: template suggestion ~3600 · wait: 300)
--interval SECONDS      FALLBACK poll cadence (default 30) — normally unused: WS or
                        the server-held long-poll (?wait=25) make answers ~instant
--realtime              force the WebSocket (Node ≥22); --no-realtime = polling only
```

## Contract (important for agents)

- **`ask` prints `correlation_id=<cid>` as its FIRST stderr line** (minted client-side
  when you don't pass one) — a killed `ask` always leaves the handle behind, so you
  can `pidge wait <cid>` instead of re-sending.
- **stdout is always machine-readable.** A fire-and-forget send → the raw 201 JSON; a
  `--wait` send / `ask` / `approval` / `wait` → the `chosen_action` JSON. Everything
  human (warnings, the correlation_id, snooze notices, armed-escalation and
  policy-degrade narration) goes to **stderr**.
- **Exit codes:** `0` answered · `3` timed out (= *no answer yet*, NOT a failure —
  back off and retry later) · `4` timed out **without one healthy round-trip all
  session** (the CHANNEL looks broken — server/network — tell your human) ·
  `2` error · `1` usage.
- **`approve` maps everything to deny-default exit codes** (it never exits 3/4):
  `0` explicit allow · `1` deny, timeout, no answer, broken channel, or an HTTP
  failure on the send · `2` only when a raw network error kept the send from ever
  reaching the server. A typo in `--timeout`/`--interval` dies immediately with `1`
  (v0.16.1) — the gate never waits forever.
- **`approve` trusts the process env.** The gate is exactly as trustworthy as
  `PIDGE_URL`/`PIDGE_TOKEN` at the moment it runs: anything able to rewrite the env
  can point the approval at its own server (receiving your bearer token) and answer
  "allow". Inherent to an env-configured CLI — run permission hooks in an environment
  you trust, and treat the env as part of the gate's trusted computing base.
- **Responses are one-and-done.** Every answer closes the notification EXCEPT a
  **snooze** (or a reschedule that set a new time), which re-fires later. `ask`/`wait`
  keep polling through a snooze and print `snooze_until` so you can schedule a re-check.
- **Types degrade, never reject.** An over-ceiling type is delivered at the channel's
  allowed level — read `degraded`/`degrade_reason` in the 201 (narrated on stderr).
  That's the human's policy working; don't retry harder.
- **`--wait` / `ask` on `live` is refused** — `live` is status-only and never produces
  an answer.
- A genuine follow-up question is a **new** notification, never a second answer on
  the same one.
- **One consumer per channel (#58).** A channel's inbound queue is served ONCE:
  whoever runs `listen`/`ack` **consumes** each message (delivered stamp → visibility
  lease → green ✓✓). If a **24/7 bridge/daemon is the channel's consumer**, a second
  runtime that also runs `listen` **steals messages out from under it** (double-consume)
  — the incident that motivated this: an interactive session woke on a bridged channel,
  ran `listen`, and offered to redo work the bridge had already handled, because it had
  no way to read the thread without consuming it. **Situate with `catchup` (read-only,
  never consumes); run `listen`/`ack` only when YOU are the channel's sole consumer.**

ENV: `PIDGE_URL` / `PIDGE_TOKEN` (the old `HERALD_URL` / `HERALD_TOKEN` still work);
with neither set, `~/.config/pidge/env` (KEY=VALUE) is read — the key-free path.

Full machine-readable spec: `GET $PIDGE_URL/api/v1/manifest` (Bearer auth).

## License

MIT
