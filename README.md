# pidge

Send rich, actionable **iPhone notifications to a human and block until they answer** —
built for AI agents (Claude Code, or any agent with a shell).

It's a thin wrapper over the [Pidge](https://pidge.sh) API. The real value is
`ask`/`wait`: the agent fires a notification and **blocks until the human responds**,
then gets the answer as JSON — no webhook, no polling loop to write.

> **The contract lives server-side.** `GET $PIDGE_URL/api/v1/manifest` is the always-
> current spec (fields, profiles, guarantees). This CLI is a thin pipe over it — any
> new server field works without a CLI update via `--param key=value`.

## Setup in one command

```bash
# The human copies a setup prompt from the Pidge app (Canais → the channel) —
# it carries a SINGLE-USE claim code (15 min TTL), never the key:
npx pidge-cli setup --claim <code> --url https://api.pidge.sh
# → exchanges the code for the real key, stores it (chmod 600), runs `pidge doctor`.
#   The secret never appears on screen or in any chat (the CLI writes it).

npx pidge-cli doctor   # validate anytime: env source, server, key, "canal X · N devices"
npx pidge-cli whoami   # which channel does this key speak for (JSON)
npx pidge-cli hello    # first contact: a live-narrated handshake the human confirms
```

The full operating guide for agents lives at **`<base>/agent-setup`** (open
`$PIDGE_URL/agent-setup`) — the deeper walkthrough of contracts, listening modes,
and the multi-runtime story.

### Many agents on one machine — isolate them (read this)

`~/.config/pidge/env` is **one slot per machine-user**: every agent without its
own identity reads the same key, so one agent's `setup` makes another agent send
as the wrong channel (this bit us for real). Each agent must have its **own**
identity. Cheapest correct setups, in order:

```bash
# A. per-agent env var — the cleanest; the human sets it at the agent's launch
#    (systemd unit / launcher / profile). Env var always wins over any file.
export PIDGE_TOKEN=hld_…        # this agent only

# B. per-agent config file — set ONE non-secret id at launch; the CLI namespaces
#    the file to ~/.config/pidge/agents/<id>/env and still writes the key for you
#    (no secret in the agent's chat). setup/doctor/everything follow it — sticky:
#    every later pidge command needs the same var set.
export PIDGE_AGENT=my-agent
npx pidge-cli setup --claim <code>

# C. you're at YOUR terminal and want the env var hygienically from a claim:
npx pidge-cli setup --claim <code> --print   # prints `export …`; writes nothing
#    paste the two lines into THAT agent's launcher. NEVER run --print as an agent
#    (the key would land in its context) — that's what A/B are for.
```

The bare `~/.config/pidge/env` (no `PIDGE_AGENT`) is fine for a **single** agent;
`pidge doctor` warns loudly when you're on that shared file. Lost the local key?
Just re-claim — the claim flow returns the channel's **same** key, so re-running
setup restores the exact identity.

### Multi-runtime identity (v0.25.0)

The CLI **identifies itself on every call** (`X-Pidge-Fingerprint`/`X-Pidge-Label`
headers + WS subscribe params — the same values the ownership claim uses). Set
`PIDGE_AGENT`/`PIDGE_LABEL` per runtime so the name means something. What you get:
`doctor`/`whoami` list the channel's **live consumers** ("`team-bridge (you)` ·
`claude-interactive`") with a ⚠️ on `consumer_conflict` (2+ live consumers —
`listen`/`bridge` also warn once per run) and a **provenance** block (a
predecessor's note-less acks); `catchup --digest` marks a sibling's in-flight work
*"being handled by X since T"* (never your own); and **`--note "<why>"`** on any
send records `sent_note` — why this runtime armed it (clear metadata, never
sealed — keep secrets out). All of it is **advisory** and present-only: against an
older server the CLI just stays silent.

## Use it (no install — via npx)

```bash
export PIDGE_URL=https://api.pidge.sh              # your Pidge server
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
#  send is refused: one tap on reply would dodge the decision)

# A go/no-go with Face ID — the approval RECIPE (= important + Approve/Reject + wait):
npx pidge-cli approval --title "Deploy to production?"

# Gate YOUR OWN risky action behind a human Face-ID tap — deny-default exit codes,
# built for permission hooks (exit 0 ONLY on explicit allow):
npx pidge-cli approve "Run the schema migration?" --body "Drops legacy_orders" --timeout 300

# Urgent — breaks through silent/Focus; --escalate forces an alarm:
npx pidge-cli urgent --title "Balance dropped below $5k" --escalate

# A thing with a known time — push at T−lead + a lock-screen countdown to the event:
npx pidge-cli event \
  --title "Team meeting" --event-at "2026-06-10T15:00:00"

# A chart you generated — uploaded for you, shown on the banner + feed:
npx pidge-cli message --title "Chart ready" --image ./chart.png

# A real artifact — the human previews it on the phone, shares it, saves to Files:
npx pidge-cli important --title "Report" --file ./report.xlsx

# They just wrote to you and you'll be digging for a minute before you answer —
# show them the three dots (self-expiring; your reply clears them):
npx pidge-cli typing 120
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

**Axis 1 — type** (one list of 5):

| Type | For | Clears when |
|---|---|---|
| `pidge message` | just inform, no action | the human OPENS it |
| `pidge important` ⭐ | a pendency they should resolve (the DEFAULT) | **Feito** |
| `pidge urgent` | wake them now (rare, real); `--escalate` = alarm | Feito (cuts the alarm) |
| `pidge event --event-at <ISO>` | a thing with a known time (countdown) | passed / Feito |
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
| `approval` | Go/no-go RECIPE: `important` + Approve (Face ID) / Reject + `--wait`. The answer comes back as `chosen_action.action_id` — `grant` (approved) or `deny` (rejected). Pass your own `--actions` to override the pair. |
| `approve "<question>"` | The hook-shaped, **deny-default permission gate** — send a Face-ID allow/deny pair, block, and answer with an **exit code**: `0` ONLY on an explicit allow; deny / timeout / no answer / a broken channel / an HTTP send failure → `1`; only a raw network error (the send never reached the server) → `2`. **Non-zero always means "not approved."** Built for a Claude Code `PreToolUse` hook that must fail CLOSED (`pidge approve --help` has a runnable hook). A **closed circuit**: on servers ≥ v83 it sends `mirror_reply:false`, so the answer never mirrors onto the `/messages` queue (this process is the only listener; deny-default makes that safe) — a bridge/`listen --all` on the same channel is never woken by the tap. ⚠️ The gate is only as trustworthy as the process env (`PIDGE_URL`/`PIDGE_TOKEN`) — see **Security model** below. |
| `hello` | Your channel's **first contact** — send the onboarding handshake **and block** until the human confirms. The server narrates a 3-stage Live Activity on the lock screen (Conectando → toque para confirmar → Concluído ✓) so they *see* the agent→human→agent loop close. Run it as your **first** contact on a fresh channel. |
| `notify` | **Deprecated** — send without a type (the server picks the channel default). Prefer a typed send. Prints the raw 201 JSON; the `correlation_id` + warnings go to stderr. |
| `wait <correlation_id>` | Block on an already-sent notification until it's answered. **0.32+: the wait hears BOTH planes** — if the human TYPES in the channel composer instead of tapping (to them it's one conversation), the wait returns those messages as `kind:"human_message"` (exit `0`): handle them, `ack --up-to <id>`, then re-`wait` the still-unanswered cid. Delivered-not-consumed (same lease/ack contract as `listen`); skipped automatically while a live `pidge bridge` owns the queue. A wait alone is still NOT "being online" — between waits nothing reads the queue. |
| `cancel <correlation_id>` | Cancel a **still-scheduled** notification before it fires (idempotent; 409 once it reached the phone). |
| `inbox` | What you sent: list, `--pending` slice, or `--summary` (counts + answer latency). |
| `catchup` | A **READ-ONLY** peek at the whole conversation — the thread newest-first, notification answers included. **NEVER consumes**: no ack, no delivered stamp, no lease. Run it to **situate yourself** at the start of an interactive session on a channel whose real consumer is **another runtime** (a bridge/daemon) — so you learn what's already handled without stealing a message. `--limit N` / `--before ID` to page. `--digest` marks a sibling's in-flight work *"being handled by X since T"* (self-filtered — never your own) and implies `--no-download`; a full `catchup` reuses attachments already on disk (`--download` still saves clear ones). Exit `0` (printed, even empty) / `2`. **One consumer per channel** — if another runtime consumes this channel, `catchup` here and **never `listen`** (that double-consumes). |
| `listen` | Block until the human **messages you** from the app; prints them, exits `0`. One-shot — loop it. `--follow` instead holds the session open and keeps printing messages as they arrive (use it only when you intend to sit and wait). A read message is DELIVERED (gray ✓✓), **not** done — `ack` it after the work (`--ack-on-read` for immediate consume). Its stdout is a **documented shape** — see [The listen stdout contract](#the-listen-stdout-contract) — and `--ndjson` switches it to one object per line. **`--exec '<handler>'` runs the round for you:** the batch JSON on the handler's stdin (`{"messages":[…],"continuity":[…]}`, ONE invocation) and **the handler's exit code decides the ack** — `0` acks the batch's exact ids with its `pidge-summary:` line as the note; anything else (non-zero, spawn error, `--handler-timeout`) acks **nothing**, prints `{"type":"handler_failed","exit":N,"reason":…,"ids":[…]}` on **stdout** and exits `2`; an exit `0` whose **ack fails** prints `{"type":"ack_failed","ids":[…]}` and exits `2` too (the work happened, the server doesn't know it). The handler's stdout is teed through and the lease is renewed every 60 s while it runs; `--exec` refuses to combine with `--follow`/`--ndjson`/`--ack-on-read` (exit `1`). ⚠️ `listen` **consumes**, and it now **HOLDS this channel's consumer lock** for its whole run: a second `listen` — or a `bridge` — is refused (exit `2`) and pointed at `catchup`; a crashed listener's lock is reclaimed by the next one (pid-checked). Exits: `0` delivered/handled · `3` empty round · `4` empty AND no healthy round-trip · `2` error, refusal or failed handler. |
| `online` | Sugar for **`pidge listen --all`** — the stay-online loop, one word, so a pasted prompt can just say *"stay online: pidge online"*. Same flags; `--all` forced. The loop is the contract: run it as a background task your harness **tracks** (never a loose shell `&`); when it exits, handle → `ack` → **relaunch**. The CLI now nudges this loop on stderr at the moments that matter: after a successful `setup`/`hello`/`doctor` (only when NO consumer is live on the channel), on a `listen`/`online` that exits `3` empty, and after a successful `ack` (not `--renew`). stdout stays parseable JSON. The strongest form of one round is `pidge online --exec '<handler>'` — same handler contract as `bridge`, without the daemon. |
| `bridge --exec '<handler>'` | The **24/7 supervisor** — paste a prompt and the agent stays online. Long-polls the channel (`--all`); your handler runs **once per batch** with the batch JSON on stdin (`{"messages":[…]}` + `history_hint:true` on the first batch since boot); handler exit `0` ⇒ ack of the batch's **exact ids** · non-zero ⇒ **not acked** (the server's **~10-min** visibility lease re-serves — make the handler **idempotent**). One run is capped by `--handler-timeout` (default 30 min: SIGTERM, SIGKILL 5s later, counts as a failed batch), with a stderr heartbeat every 5 min while the handler runs **and an automatic lease/presence renew every 60 s** (`POST /messages/ack {ids, state:"delivered"}` on the batch's exact ids — the lease never lapses mid-run; servers with manifest ≥ v79 also refresh *"listening now"* on it). The renew stops the moment the handler exits, so a failed batch still lapses back to the queue; renew failures are non-fatal (narrated once). Model-agnostic: `--exec 'claude -p …' \| 'codex exec …' \|` any script. **One instance per channel**: a PID-checked lockfile refuses a second bridge/`listen` (a stale lock from a crash is recovered). 401 / broken channel → narrated + **local alert** + long **jittered** backoff — never a silent death, never a blind hot loop. SIGTERM/SIGINT are clean: in-flight batch NOT acked, lock released, exit `0`. Deliberately DUMB: no local queue — durability is the server's ack/lease. **Attribution:** the handler tells the next session what it did by printing a final marker line — `pidge-summary: <one sentence>` — to stdout; the bridge scans for the **last** such line and acks with that summary so `catchup` shows *"handled by X: <summary>"*. No marker ⇒ acked without one (never invented). The batch also rides a temp file named to the handler as **`$PIDGE_BATCH_FILE`** (0.51.1+, same JSON, removed after the round) — the shape an LLM handler needs, because `claude -p` **discards its prompt argument when stdin is piped** (and here it always is): pipe the PROMPT via stdin, read the batch from the file. Example: `pidge bridge --exec 'printf "Read the Pidge batch at $PIDGE_BATCH_FILE, handle it, REPLY by running pidge message (your stdout is a log, never a reply), end with: pidge-summary: <what you did>" | claude -p --allowedTools Bash,Read,Write'`. **Gate hygiene** (server manifest ≥ v83): a `notification_reply` marked `ref.gated` (the human's Face-ID tap on an `approve`/`approval`/`--gated` action) is **acked without spawning a handler** — a money-gate outcome must never wake an LLM looking like a fresh command; the asker already heard it on its own wait/webhook. Loud: one log line + an ack summary. Deny/reject/reply/snooze on the same ask still reach your handler. |
| `bridge install --exec '<handler>'` | Write the launchd (macOS) / systemd user (Linux) **template** that runs the bridge with `Restart=on-failure` semantics, and declare `listen_mode=external_daemon` (advisory). The template **never embeds the key** (it stays in `~/.config/pidge/env`); enable with the printed `launchctl`/`systemctl` command. |
| `run start` / `end` / `status` | **Execution attribution** — sign your messages with the exact execution so the human sees WHO spoke. `run start` prints two `export` lines (`eval "$(pidge run start --mode interactive --role main)"` arms a whole session); `--mode interactive\|poll\|bridge\|custom`, `--role main\|worker\|subagent`, `--label`, `--parent-seal`, `--ephemeral`, `--ttl`, `--json`. `run end` ends `$PIDGE_RUN_TOKEN` (best-effort; no token ⇒ no-op). `run status` lists the channel's live runs (own marked `*`). Attribution, **not a credential** — see [Execution attribution](#execution-attribution-runs). |
| `ack --up-to <id>` | Mark messages PROCESSED (green ✓✓) **after** you've handled them; `--renew` heartbeats the **~10-min** visibility-timeout lease on a long task. `--summary "<what you did>"` attaches a one-line note to the acked messages — a **successor session** sees it as *"handled by X: <summary>"* in `pidge catchup`. A bare `--summary` with no value is a usage error, never a silent no-op. **An ack is a claim that the work is done:** an ack from a loop that did nothing — no note, no answer sent — is a **mute ack** (the server files it as `handled_state:"drained"`, and `pidge doctor` counts them). In an automated loop the note belongs to the handler: `listen --exec`/`bridge` take it from the handler's `pidge-summary:` line and never invent one. |
| `typing [SECONDS\|off]` | Show the human the **three dots** while you work on a reply. **The habit: their message just landed and you'll be busy more than ~15 s before you answer → run `pidge typing` first** (`pidge typing 120` when you know it'll be long; bare = 60 s, the server clamps to 3–300 and the CLI tells you when it does). You can't get it wrong: it **self-expires** (a crashed agent never leaves them staring at dots), **any real send of yours clears it** at the source (they see your words, not the dots — there is no "remember to turn it off"), and to **extend** it you just run it again. Ephemeral, advisory, **display-only**: no push, no history, nothing downstream reads it, nothing waits on it. Automatic under `bridge` / `listen --exec` — handing a batch to your handler raises the dots for you (`PIDGE_NO_AUTO_TYPING=1` opts out). Exit `0` · `2` error (a server that predates the indicator answers 404 and says so). |
| `contract set <k>=<v>` / `contract show` | DECLARE how you operate (`keep_connection_alive`, `mirror_in_origin_session`, `listen_mode=turn_based\|persistent\|external_daemon`, `quiet_when_idle`). **Advisory, never policy** — you declare, the human registers their expectation and *sees* if you honor it; Pidge enforces nothing. An unknown key/bad value is rejected locally (exit 1). |
| `selftest [--window N]` | Prove your listener works by ROUND-TRIP — fire a nonce and **watch, read-only**, for *your* listener to pick it up + ack it. It never reads the queue and never acks its own nonce, so PASS (exit `0`) means a real consumer did the work and **a channel with nothing listening FAILS** (exit `2`, with the cause: nothing listening / live-but-deaf consumer / slower than `--window`; an unreadable verdict is INCONCLUSIVE, never blamed on the listener). Start the listener first, then run it — and whenever sends seem to go unheard. |
| `setup --claim <code>` | One-shot onboarding: exchange the single-use code for the key, store it in `~/.config/pidge/env` (600), claim channel ownership (so `doctor` can warn on a silent key swap), declare your `operating_contract` (default `listen_mode=turn_based`; `--listen-mode persistent\|external_daemon` for a supervisor/daemon), run doctor. |
| `doctor` | Validate the setup **without exposing secrets**: env source, server reachable, key valid, **honest device reach**, channel ownership, and a **realtime probe** (`realtime: ok / INDISPONÍVEL` — exit stays 0; an unavailable WS just degrades `listen` to polling). On newer servers it also lists the channel's **live consumers** ("`team-bridge (you)`" — "(you)" by local fingerprint match) with a ⚠️ on `consumer_conflict`, nudges when an UNIDENTIFIED (pre-0.25) listener is on the channel, and prints the **provenance** block (a predecessor's note-less acks). It then reads the queue **read-only** (`GET ?history=true` — never consumes, never leases) and reports three things: un-acked composer messages piling up; a **deaf consumer** (⚠️ messages that were DELIVERED, lost their lease and are still un-acked *while a consumer is live* — something reads this queue without handling it); and **mute acks** (⚠️ rows the server marks `handled_state:"drained"` in the last 24 h — acked with no note and no answer behind them). All three are advisory (exit stays 0), and a server that doesn't send the fields yields silence, never a complaint about the field. Exit 0/2. |
| `whoami` | Which channel does this key speak for (JSON). |
| `skill install [--target T]` | Write the generated Pidge skills — persistent Pidge knowledge for an AI agent; re-run to update. **A CORE plus REFERENCES:** `SKILL.md` is a ~6 KB core (the picker, the response axis, how it intrudes, how to read the answer back, and an index of triggers) and the depth lives in `references/<name>.md`, each named after the manifest section it mirrors and each loaded by the harness only when its trigger fires — so the recurring per-session cost is the core, not the whole doctrine. **Two skills, same doctrine everywhere:** `pidge` (the transport — types, buttons, waiting) and **`pidge-report`** (the content contract for what reads well in the feed). `--target` picks the destination: `claude` (default) → `.claude/skills/pidge/SKILL.md` **+ `references/*.md` + the companion at `.claude/skills/pidge-report/SKILL.md`** (the main skill points at them instead of inlining them) · `agents` → `AGENTS.md` · `gemini` → `GEMINI.md` — single-file targets have no sibling and no reference dir to write, so they carry every reference **and** the report doctrine **inlined** — choosing a target never costs a fact. The JSON echo reports `report_file` and `reference_files` (empty for the single-file targets). An existing file whose content differs is backed up to `<dest>.bak` first (or `<dest>.bak.<timestamp>`), so a re-install never destroys your original. The `claude` target **self-heals**: any networked pidge command silently refreshes a stale `.claude` skill — and regenerates the companion with it, which is how an existing install *gains* it; `AGENTS.md`/`GEMINI.md` do **not** auto-update — re-run `skill install` yourself to refresh them. |
| `terminal <sub>` | **Terminals** — share a tmux **pane** with the human's phone: a Claude session as its structured transcript (E2E-sealed; typed replies land in its real input box) or a plain terminal pane. Its identity slot is its own (`~/.config/pidge/terminal/`), **independent of `PIDGE_TOKEN`** — one paired computer, not one agent. `connect --code C` pairs this computer once (the app's Settings → Computers one-liner) and installs a background daemon; `connect --qr` pairs **computer-first** — the terminal mints the key and prints a QR the app scans, and the key never rides a clipboard or the wire; the claim code then **arrives from the phone by itself** (the CLI polls a rendezvous address derived from its own key, which only a holder of that key can compute), with typing it back kept as the loud fallback on an older server or app. Sharing a **claude session** has exactly ONE door: paste *"Run exactly this one bash command and nothing else: `pidge terminal enable`"* into the session you want mirrored — the `PreToolUse` hook fires **before** the command runs, shares that session id and denies the tool (no PATH, no picker, no sid). Sharing **any pane**: run `pidge terminal share` inside it (it matches its own tty to `#{pane_tty}`; a claude running there makes it an agent view, otherwise a terminal — and the share **stays put** when claude starts or exits, only the view switches). `config remote_spawn on\|off` (default **OFF**) / `config remote_capture on\|off` (default **OFF** — the phone may share a pane nobody here shared) / `config inventory on\|off` (default **ON**) declare **what the phone may do to this computer**, granted where the risk lives and printed in plain words by `connect` and `status`; bare `config` prints all three. Also: `enable` (a confirmation of the paste, never the door) · `disable [--session SID\|--all]` · `status` (per lane: daemon, cable, computer, shares, hooks, grants) · `disconnect` (= `disable --all` + uninstall hooks + daemon). E2E is **mandatory** — the transcript contains everything; the server relays sealed blobs it can never read. |
| `--version` | Print the CLI version. |

## The listen stdout contract

`listen`/`online` print a **heterogeneous, multi-line** stream. Read it whole, then switch
on `type`/`kind` — never line by line:

```jsonc
{"type":"continuity_context", …}   // zero or more, one compact line each: read-only provenance
[                                  // then EXACTLY ONE pretty-printed array of messages
  { "id": 481, "kind": "message", "body": "…", "attachment": { … } },
  { "id": 482, "kind": "notification_reply", "action_id": "yes", "ref": { … } }
]
```

`--ndjson` gives one compact object per line instead — every line stamped `type` (mirroring
`kind` for messages), the round closed by a `batch_end`:

```jsonc
{"type":"continuity_context", …}
{"type":"message","id":481,"kind":"message","body":"…"}
{"type":"notification_reply","id":482,"kind":"notification_reply","action_id":"yes","ref":{…}}
{"type":"batch_end","count":2,"max_ackable_id":482}
```

Two rules cover every case, today and after the next field lands:

- **Ackable ⇔ the object has an `id`.** A continuity context and a `batch_end` have none, and
  nothing without an id may ever ride a `pidge ack`.
- **Switch on `type` (or `kind`), never on position or line number.**

Under `--exec` none of this is printed: the same batch goes to your handler on stdin
(`{"messages":[…],"continuity":[…]}`), the handler's own output is teed through, and the only
lines the CLI adds are the two failure ones — because a failure the agent can't see becomes a
false green:

```jsonc
{"type":"handler_failed","exit":N,"reason":"exit|timeout|signal|spawn_error","ids":[…]}
{"type":"ack_failed","ids":[…]}   // the handler exited 0, the ACK didn't land
```

Both exit `2`. `ack_failed` is the honest half of a green handler: the work happened, the
server does not know it, and the batch re-serves — so the handler must be idempotent, or you
ack those ids by hand. If the handler's last output had no trailing newline, the CLI writes one
before either line, so a machine line is always a line of its own.

## Execution attribution (runs)

A solo dev launches agents without designing an identity system — but a human still needs to
know **which execution is talking**: one continuous interactive session, or a fresh cold poll
process that just woke up with no memory of the last. A **run** answers that. It is a short,
server-issued signature for one execution — **attribution, never a credential**: your channel
key (`hld_…`) still authenticates every call; a per-run bearer only *signs* it (a new
`x-pidge-run` header the server stamps onto the messages you send).

```bash
# at the start of an interactive session — arms PIDGE_RUN_TOKEN/PIDGE_RUN_SEAL for the session
eval "$(pidge run start --mode interactive --role main --label supervisor-eli)"

# a subagent/worker you spawn signs as its own execution under yours
eval "$(pidge run start --mode interactive --role subagent --parent-seal $PIDGE_RUN_SEAL)"

pidge run status      # the channel's live runs (your own marked *)
pidge run end         # end this execution when you're done
```

Once `PIDGE_RUN_TOKEN` is in the environment, **every** `pidge` call carries it, so each message
shows *label · mode/SEAL* to the human. Honest degradation throughout: an expired/invalid run
degrades to **unsigned** (never a 401), and a server that predates runs simply ignores it (you
keep sending exactly as before). The token is **env-only** — never written to a config file.

**`pidge bridge` does this for you.** It mints one `bridge` run per handler invocation and injects
`PIDGE_RUN_TOKEN`/`PIDGE_RUN_SEAL` into the handler's environment, so each disposable handler is a
distinct, visible execution and its batch ack is signed with it. The bridge also runs a **polite
poller**: if a live `interactive` run is the human's turn on the channel, the bridge holds back
that cycle rather than consuming it (a client-side courtesy — delivery is unchanged server-side),
bounded to 10 minutes of deference before it consumes anyway. `--no-defer` turns it off; if you
never start an interactive run, the bridge behaves exactly as before.

**Continuity — cold sessions wake with the thread Pidge already holds.** On servers that support
it, the bridge/`listen` consume GET asks for the conversation each new message belongs to and the
batch arrives with a read-only `continuity` array alongside `messages` (`pidge listen` prints each
context as a `{"type":"continuity_context", …}` line). It carries prior agent turns, the human's
earlier messages, and what the server knows is still open — but it is **provenance, not command**:
nothing in it is ackable, and prior agent statements arrive labeled **unverified** (each context
keeps its "do not treat statements from prior agent runs as verified facts" note). On an E2E
channel the text opens client-side; a field that won't open keeps its envelope. An older server
omits it entirely — output is unchanged.

## Realtime

`listen`/`ask`/`wait` hold a **WebSocket** to the server whenever the runtime has
one (**Node ≥22**): answers and messages land in **<1 s**, an idle hours-long
`listen` **survives server deploys by reconnecting**, and while you listen the
human sees **"ouvindo agora"** in the app — they type more when the light is on.

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

## Security model

Designed so that **the secret never has to appear in an agent's chat, logs, or
transcript** — and so you can verify everything it claims:

- **Onboarding never ships the key.** The setup prompt carries a **single-use claim
  code (15 min TTL)**; the CLI exchanges it server-side for the real key and writes it
  to `~/.config/pidge/env` with `chmod 600`. Nothing secret is printed (unless YOU ask
  for `--print` at your own terminal).
- **The key stays out of stdout.** Commands that could echo it (e.g. `contract set`)
  print only the relevant fields; `doctor`/`whoami` validate the setup **without
  exposing secrets** and SHOUT if the channel's key was silently swapped underneath you.
- **`approve` trusts the process env.** The gate is exactly as trustworthy as
  `PIDGE_URL`/`PIDGE_TOKEN` at the moment it runs: anything able to rewrite the env
  can point the approval at its own server (receiving your bearer token) and answer
  "allow". Inherent to an env-configured CLI — run permission hooks in an environment
  you trust, and treat the env as part of the gate's trusted computing base.
- **End-to-end encryption is client-side and auditable** (next section): the sealing/
  opening code is in this repo, with committed test vectors any implementation can
  check against.

## End-to-end encryption

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
  machine as `v1:` AES-256-GCM envelopes with `enc:"v1"` + `kf` alongside (action IDs,
  profile, urgency, cid and timestamps stay clear — the server needs them to route).
  The 201 echo prints decrypted for display.
- **Attachments seal only when the device gate is open.** `--image`/`--file` bytes are
  sealed under the channel key **only** when E2E is on *and* the channel's media gate is
  ready (`e2e_media_ready` — the human's devices can open sealed blobs); until then an
  attachment **rides clear** even though the text is sealed. Don't attach something you
  wouldn't send unsealed. (`PIDGE_E2E_MEDIA=on/off` overrides per machine, and a channel
  pinned sealed-media locally **refuses** to send clear bytes rather than downgrade.)
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
--note TEXT             WHY this runtime armed the send — recorded as sent_note
                        (clear metadata, never sealed; visible to sibling runtimes)
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
--quiet-nag             silence the once-a-day manifest-version nudge (or PIDGE_QUIET_NAG=1)
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
  — the gate never waits forever.
- **Responses are one-and-done.** Every answer closes the notification EXCEPT a
  **snooze** (or a reschedule that set a new time), which re-fires later. `ask`/`wait`
  keep polling through a snooze and print `snooze_until` so you can schedule a re-check.
- **Types degrade, never reject.** An over-ceiling type is delivered at the channel's
  allowed level — read `degraded`/`degrade_reason` in the 201 (narrated on stderr).
  That's the human's policy working; don't retry harder.
- **A decision + `reply` in one send is refused** (exit 1, nothing sent) — one tap on
  `reply` would dodge the decision; use `--actions reply` ALONE when you need text.
- **`--wait` / `ask` on `live` is refused** — `live` is status-only and never produces
  an answer.
- A genuine follow-up question is a **new** notification, never a second answer on
  the same one.
- **Voice notes: Pidge does NOT transcribe.** The human's composer can record audio,
  and it arrives as an ordinary `attachment` — but every read (`listen`, `online`,
  `wait`'s composer drain, `catchup`, a `bridge` batch) marks it `"kind":"voice"`,
  carries `duration_seconds` when the sender's device measured it, and states once
  per render that nothing here turns speech into text. You get the **file**, never the
  words: a sealed voice note is already decrypted to `attachment.path`, a clear one
  keeps its `url` and only lands on disk with `--download` (the posture for every clear
  attachment — unchanged). **Never guess what the human said.** Transcribe locally and
  work from the transcript:

  ```bash
  # the path rides the JSON: .messages[].attachment.path (sealed) — or --download a clear one
  whisper "$VOICE_PATH" --model small --output_format txt   # or whisper.cpp, or your own STT API
  ```

  No transcriber on the machine? Say so plainly and ask them to type it — an invented
  transcript is worse than an honest "I can't hear this."
- **One consumer per channel.** A channel's inbound queue is served ONCE: whoever runs
  `listen`/`ack` **consumes** each message (delivered stamp → visibility lease → green
  ✓✓). If a **24/7 bridge/daemon is the channel's consumer**, a second runtime that
  also runs `listen` **steals messages out from under it** (double-consume) and may
  offer to redo work the bridge already handled. **Situate with `catchup` (read-only,
  never consumes); run `listen`/`ack` only when YOU are the channel's sole consumer.**
  Since 0.50.0 that rule is a **mechanism, not a convention**: every `listen` (with or
  without `--exec`) holds the same pid-checked lockfile a `bridge` does, so the second
  consumer is refused (exit `2`) instead of quietly stealing messages — and a crashed
  holder's lock is reclaimed by the next starter, never wedged. Your own `--wait`/`ask`
  under a live listener is never refused; it is narrated, because that wait hears the
  BUTTON your human taps and nothing they TYPE (typed messages belong to the listener).
- **An ack is a claim, not a receipt.** Ack after the work, with a note. A drained
  message nobody handled — no note, no answer — is a **mute ack**: the human sees green
  and there is nothing behind it. `pidge doctor` counts both halves of the dishonest
  loop: a consumer that takes deliveries and never acks, and acks with nothing behind them.

ENV: `PIDGE_URL` / `PIDGE_TOKEN` (the legacy `HERALD_URL` / `HERALD_TOKEN` names still
work); with neither set, `~/.config/pidge/env` (KEY=VALUE) is read — the key-free path.

Full machine-readable spec: `GET $PIDGE_URL/api/v1/manifest` (Bearer auth).

## License

MIT
