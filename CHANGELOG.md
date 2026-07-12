# Changelog

## 0.26.0 — 2026-07-12

Stay online. The pitch is "paste a prompt and your agent stays online" — this release
closes the two ways agents quietly dropped off it.

- **Bridge renew heartbeat (fixes #82).** While your `--exec` handler runs (up to 30 min),
  the bridge now pings `POST /messages/ack {ids: <the batch's exact ids>, state: "delivered"}`
  every 60 s: the visibility lease can never lapse mid-run, and servers with manifest ≥ v79
  also refresh "listening now" presence on the renew — so the human no longer sees "offline"
  during a long handler run when the WebSocket is down (older servers: lease renewal only,
  harmless). First ping after a full 60 s (a fast handler never pings); the heartbeat stops
  the moment the handler exits, so a FAILED batch still lapses back to the queue. Failures
  are non-fatal (narrated once, never touching the batch outcome).
- **`pidge online`** — sugar alias for `pidge listen --all`, so a pasted prompt can just say
  "stay online: pidge online". Same flags, same loop; `--all` is forced.
- **Stay-online nudges (stderr only — stdout stays JSON).** After a successful
  `setup`/`hello`/`doctor` with NO live consumer on the channel, a NEXT line teaches the
  loop (listen --all as a harness-tracked background task → handle → ack → RELAUNCH);
  `listen` exiting 3 now says "relaunch the listener"; a successful `pidge ack` (not
  `--renew`) says the same. Suppressed where they'd be wrong (a live consumer exists;
  `--follow`).
- **Skill revision 14** — teaches the stay-online loop and the bridge's automatic renew
  heartbeat; installed copies self-heal on the next networked command.

## 0.25.1 — 2026-07-08

Editorial and reliability release — no behavior change on the wire.

- Docs pass across README, CHANGELOG, `--help` and code comments: everything now
  describes behavior in its own words. New README sections: **Security model**
  and **Multi-runtime identity**; restored `--follow`, the ~10-min visibility
  lease figure, the `<base>/agent-setup` pointer and the `grant`/`deny` action
  ids; honest note that attachments ride clear until the channel's media gate
  is open.
- Test suite hardening: spawned CLI children now run in their own process group
  and are reaped when a test file ends (a straggler could previously hang the
  suite on Linux); two WebSocket tests now skip on Node < 22; a timing race in
  the `--handler-timeout` test is gone. CI runs files individually with
  per-file timeouts, so a hang names its file instead of stalling the job.
- New repo-hygiene test keeps published files free of internal references.
- The generated skill was refreshed (revision 13) — installed copies self-heal
  on the next networked command.

## 0.25.0 — 2026-07-08

When two agents share one channel — say a 24/7 bridge alongside an interactive session — this
release makes each runtime **identify itself on every request** and surfaces the resulting
picture: who else is on the channel, whose work is already in flight, and who armed each
scheduled send. Everything here is **advisory** — nothing about how messages are delivered or
served changes. Give each runtime a name with `PIDGE_AGENT=<id>` (or `PIDGE_LABEL`) so the
lists below read clearly.

- **`doctor` and `whoami` list the channel's live consumers.** For example
  "consumers — 2 live: team-bridge (you) · claude-interactive", where "(you)" is matched
  locally by fingerprint. You get a ⚠️ when two or more consumers are active at once, and a
  nudge when an older client that can't identify itself is listening.
- **`listen` and `bridge` warn once per run** when another consumer is already active on the
  same channel, so you notice a sibling started without having to look.
- **`catchup --digest` shows "being handled by X since T"** on any message another runtime is
  actively working — filtered so you never see your own in-flight work — so two agents don't
  redo each other's tasks.
- **`notify --note "<why>"`** records why a fire-and-forget or scheduled send is armed,
  attributed to this runtime, so whoever comes next reads the intent. The note is clear
  metadata (never sealed), so keep secrets out of it.
- **A provenance block in `doctor`/`whoami`.** When a previous consumer acknowledged messages
  without leaving a note, you'll see a count like "7 acked without a note" — a reminder to use
  `ack --summary` so your own work is legible to the next agent.
- **`ack` reports "annotated N previously-acked message(s)"** when the server fills in
  attribution a prior consumer left blank.
- **`catchup` stops re-downloading attachments it already has.** `--digest` implies
  `--no-download` (the digest rarely needs the bytes), and a full `catchup` reuses a copy
  already on disk instead of re-fetching and re-unsealing it every session. Pass `--no-download`
  explicitly to skip fetches yourself.
- **Robustness.** A `PIDGE_LABEL` that ends in a split emoji no longer crashes the CLI at
  startup — labels are sanitized to valid text first. Attachment saves are atomic (a partial or
  0-byte file at the cache path is never trusted as a cached copy), and `catchup --help` now
  documents `--download`.

## 0.24.1 — 2026-07-07

Three fixes based on early feedback on 0.24.0.

- **Fix: `catchup --digest` could report `PENDING` for a message that was already
  acknowledged** (when the ack carried no note), which could lead a later session to redo
  finished work. The digest now distinguishes three states: `handled by X: <note>` (note
  present), `✓ acked (no note)` (processed silently — not to be redone), and `PENDING`
  (genuinely unprocessed).
- **Fix: the cursor tip was often never printed.** Previously the tip only appeared when a
  prior cursor existed and the thread had advanced past it, so fresh or quiet channels never
  showed one. Now every `catchup` run without `--since` that saw messages prints the suggested
  cursor on stderr (stdout — JSON or digest — stays clean), pointing at the highest id seen so
  `--since <id>` returns only what arrives later.
- **`pidge doctor` now warns when `~/.claude/skills/pidge/SKILL.md` exists without the pidge
  marker.** Such a file is treated as hand-authored and never auto-updated, so an agent could
  keep following stale guidance without knowing. Doctor now points at the file and suggests
  `cd ~ && npx pidge-cli skill install` (the current file is backed up to `.bak`); doctor
  itself never writes.

## 0.24.0 — 2026-07-06

Two improvements to help a new session catch up without redoing work.

- **Skill self-update now covers the home install path (`~/.claude/skills/pidge`), not just
  the project path.** Previously only the project-relative skill was refreshed, so a skill
  installed in the home directory could stay stale indefinitely with no warning. Both paths
  are now checked and each stale copy is refreshed in place. On the home path, only files
  carrying the pidge marker are touched — a hand-authored `SKILL.md` is left alone.
- **`pidge catchup` gains `--since <id>` and `--digest`.** `--since <id>` returns only
  messages with strictly greater ids (no more pulling the whole thread to answer "what
  happened since my last session"). `--digest` condenses each message to one line:
  `id · kind · <excerpt> · handled by X: <summary>` (or `PENDING`). The CLI remembers the
  highest id it printed, per channel, and suggests it as the next cursor on a later run
  without `--since`; the cursor only ever advances. The installed skill now recommends
  `pidge catchup --digest --since <last>` at session start.

## 0.23.1 — 2026-07-06

Skill and onboarding fixes: the installed skill had fallen behind the CLI, and two
onboarding commands could block a session.

- **The installed skill now documents `pidge bridge` and `ack --summary`, and adds a
  multi-agent setup block.** It gains a section on the 24/7 supervisor (`--exec`, the
  single-consumer lock, `bridge install`, the `pidge-summary:` marker), teaches
  `ack --up-to <id> --summary "<what you did>"` as a habit, and explains running multiple
  agents on one host (`PIDGE_AGENT=<id>` in every session, per-agent config under
  `~/.config/pidge/agents/<id>/env`, never `setup --force`). Prose fixes: the queue is
  durable (at-least-once — a missed message is delayed, not lost); write in your human's
  language and mirror the channel; the turn-based agent examples now cover Claude Code,
  Codex, and Gemini CLI.
- **`pidge doctor` now always reports prior-claim backlog state, not only when there is a
  problem.** A silent doctor could not confirm health. When the server reports a healthy
  state it prints `prior-claim backlog: none ✓`; the existing warning still covers the
  unhealthy case. Older servers that don't report the field remain silent.
- **`pidge hello` gains `--timeout` (default 120s) — it no longer blocks the session
  indefinitely.** Previously a fresh session could hang waiting for the human's confirmation.
  An explicit `--timeout` always wins; on timeout it exits 3 with a clear message: the
  confirmation stays in your queue and `pidge listen --all` picks it up whenever your human
  responds — mirroring the `ask`/`wait` contract.

## 0.23.0 — 2026-07-06

Three fixes around attribution and reading the queue.

- **Fix: `pidge ack --summary "<what you did>"` was a silent no-op.** The flag collided with
  the boolean `inbox --summary` and the text was dropped. The value now survives (up to 1000
  chars), is recorded with the ack, and `pidge catchup` shows it as
  `handled by X: <summary>` to the next session. `--summary` with a missing or empty value is
  now a loud usage error (exit 1), never a no-op. `inbox --summary` is unchanged.
- **Fix: `selftest` no longer hijacks real messages.** Its internal listener read the real
  queue, so any real message served in passing was held under a lease for up to ~60s —
  invisible to a concurrent `listen` (which would run its whole window and report
  "no message"). The selftest now reads only messages newer than its own probe, so
  pre-existing backlog is never touched; a short lease remains as defense in depth. The
  `listen` no-message exit gained a hint: if you expected a message, it may be under a lease
  from another read — `pidge catchup` shows the whole queue read-only.
- **`pidge bridge` now captures the handler's summary via a marker line.** The bridge scans
  the handler's stdout (streaming, never buffering the whole output; stdout still tees to the
  log) for the LAST line starting with `pidge-summary: <text>` (up to 1000 chars) and attaches
  it to the ack, so a later interactive session sees who handled what. Only a line that starts
  with the marker counts — incidental output never becomes attribution; if no marker is found,
  the batch is acked without a summary (never invented). An LLM handler can be instructed in
  its own prompt: "end by printing `pidge-summary: <one sentence of what you did>`."
  Documented in the bridge help and README.

## 0.22.0 — 2026-07-06

New: a built-in, model-agnostic 24/7 supervisor.

- **`pidge bridge --exec '<handler>'` — a first-class supervisor loop.** Long-polls the
  channel; each batch of messages runs the handler ONCE with the batch JSON on stdin
  (`{"messages":[…]}`, plus `history_hint:true` on the first batch after a restart — pair it
  with `pidge catchup`). Handler exit 0 acknowledges exactly the ids of that batch; a non-zero
  exit acknowledges nothing and the messages are redelivered after the lease expires —
  delivery is at-least-once, so handlers should be idempotent. `--handler-timeout` (default
  30 min) bounds each invocation (SIGTERM, then SIGKILL; counts as a failed batch — a hung
  handler can't wedge the channel), with a heartbeat on stderr every 5 min. Model-agnostic by
  construction: `--exec 'claude -p …'`, `'codex exec …'`, `'gemini …'`, or any script. The
  bridge keeps no local queue or ledger — durability lives in the server's ack/lease.
- **Single instance per channel.** A lockfile prevents a second bridge on the same channel:
  the second one refuses with exit 2 and a clear message (pointing at `catchup`, plus how to
  remove the lock if you're certain no bridge is running). A stale lock left by a crash is
  recovered automatically and race-safely. `listen` also refuses while a live bridge holds the
  channel — two consumers on one channel can't silently steal each other's messages.
- **Failure modes are narrated, never a blind retry loop.** Auth failure → a clear message
  plus a best-effort local desktop notification (`PIDGE_BRIDGE_ALERT=0` disables), then long
  jittered backoff and retry forever — a rotated key needs a human, and the daemon neither
  dies silently nor flaps its supervisor. A persistently failing channel gets the same
  treatment; a failing handler gets its own escalating backoff (a dead handler doesn't burn
  one LLM call per message). Clean SIGTERM/SIGINT: the signal is forwarded to the in-flight
  handler, the in-flight batch is NOT acknowledged (it will be redelivered), the lock is
  released, exit 0.
- **`pidge bridge install --exec '<handler>'`** generates a launchd template (macOS,
  `~/Library/LaunchAgents/…`) or a systemd user unit (Linux,
  `~/.config/systemd/user/…`) for running the bridge as a service. The template never embeds
  your channel key (it stays in `~/.config/pidge/env`); only non-secret environment travels,
  including your current PATH so handlers installed via Homebrew/nvm work under
  launchd/systemd. Warns if the key exists only in your shell environment (the daemon
  wouldn't inherit it) or if the CLI is running from the npx cache (the template would break
  on a cache prune).
- **`listen`, `doctor`, `catchup`, and bridge startup now surface a one-line advisory** when
  queued backlog likely belongs to a previous owner of the channel key (printed once per
  process, phrased as "probably", never as certainty).

## 0.21.0 — 2026-07-06

New: a read-only way to catch up on a channel, and multi-target skill installs.

- **`pidge catchup` — read-only channel history.** Prints the whole conversation (JSON,
  newest first), notification replies included, and NEVER consumes: no ack, no delivered
  stamp, no lease. This is how an interactive session situates itself on a channel whose real
  consumer is another runtime (a 24/7 bridge/daemon) — it reads what was already handled
  without stealing messages from the consumer's queue. `--limit N` / `--before ID` paginate.
  Exit 0 when it printed (even an empty `{"messages":[]}`), 2 on error. End-to-end-encrypted
  rows are decrypted locally, same as `listen`. When the server records who handled a
  message, catchup narrates `handled by <who>: <what>` per row on stderr.
- **The one-consumer-per-channel rule is now written down.** Whoever runs `listen`/`ack`
  CONSUMES each message; a second runtime also running `listen` steals messages from the
  first. Fixed guidance: an interactive session could double-consume a channel owned by a
  bridge — situate yourself with `catchup` (read-only) and run `listen`/`ack` only when you
  are the channel's sole consumer. Documented in the README (Contract section + command
  table) and in the installed skill.
- **`pidge skill install --target claude|agents|gemini`:** the same agent-agnostic content,
  different destination — `claude` (default) → `.claude/skills/pidge/SKILL.md` · `agents` →
  `AGENTS.md` · `gemini` → `GEMINI.md` (both at the repo root). An existing file that differs
  is saved to `<dest>.bak`; if the `.bak` already exists (a re-install), the new backup goes
  to `<dest>.bak.<timestamp>` — a re-install never destroys your original backup. The install
  message names the actual destination file. Only the `claude` target self-updates;
  `AGENTS.md`/`GEMINI.md` don't auto-refresh — re-run
  `pidge skill install --target agents|gemini` to update them.
- **Installed skill updated** with the multi-runtime guidance (how an interactive session
  wakes up on a channel that already has a consumer).

## 0.20.0 — 2026-07-06

End-to-end encryption now covers file and image attachments, in both directions.

- **Sealed media, agent → you.** On an end-to-end-encrypted channel whose devices support
  sealed media, local `--image`/`--file` attachments are encrypted on your machine before
  upload; the real filename travels sealed as well, and the upload itself is an opaque blob.
  Local overrides: `PIDGE_E2E_MEDIA=on` (force, for testing) / `off` (opt out). Once a
  channel has sent sealed media, the CLI pins that choice: any later media send that would go
  out in the clear on that channel is refused (exit 2, before a single byte uploads) — only a
  local `PIDGE_E2E_MEDIA=off` unpins. On a sealed send, `--image` with a public URL and
  pre-minted media refs are refused (bytes outside the CLI's custody can't be honestly
  encrypted).
- **Inbound attachments, you → agent.** A message can now carry an attachment
  (`{filename, content_type, byte_size, url, enc?}`). In `listen`/`listen --all`, an
  encrypted attachment is always downloaded and decrypted to
  `~/.config/pidge/downloads/<msg id>/<real name>` and the printed JSON gains
  `attachment.path`; a clear attachment passes through with its signed URL (save it with
  `--download`, choose the destination with `--download-dir DIR`). Filenames are sanitized
  before touching disk (path separators, `..`, leading dots); a decryption failure yields a
  precise `e2e_error` and ciphertext never becomes a file. `body` may be `""` when the
  attachment IS the message.

## 0.19.0 — 2026-07-04

- **`pidge live` now drives real Live Activities.** Previously a `live` send silently
  degraded to a normal notification and no card ever appeared; that failure mode is gone. By
  default the activity appears as an entry in the user's consolidated status center;
  `--dedicated` requests a standalone card (when over the device budget it degrades loudly,
  with the reason narrated on stderr). New flags: `--status --step N/M --progress --ends-at
  --starts-at --paused --resume --detail --symbol --dedicated --end --outcome --linger`.
  `--step 3/5` is sugar for a progress fraction plus label. `--title` creates or updates the
  activity (keyed by correlation id); a correlation id without `--title` updates an existing
  one (a 404 hints at `--title`); `--end` concludes it (checkmark + outcome, default linger
  30s). The full response JSON (including `operation: started|updated|noop|rotated|ended`)
  prints to stdout; `--wait` remains refused for live sends.
- **Installed skill updated** to teach the live command (fields drive the render; omitted
  fields preserve the running timer) and drop the old "silently degrades" warning.

## 0.17.3 — 2026-07-04

- **Fix: `ack --up-to`/`--ids` now require a whole numeric id and fail loudly before any
  request is made.** Previously a correlation id pasted there was silently truncated to a
  number (e.g. "9f2e…" → 9), producing a wrong watermark that could acknowledge messages that
  were never handled; and `--ids 12,abc` dropped the invalid entry silently. The error message
  spells out the fix: use the NUMERIC id from `listen` output, never the correlation id.
- **Fix: `pidge doctor` with a session token in the environment reported the key as valid**
  (`channel "undefined"`) and exited 0, hiding the misconfiguration until the first send
  failed. It now says "this is a SESSION token, not a channel key" and exits 2.

## 0.17.2

Text-only release: setup and remediation messages hardened around the secret.

- **The E2E secret no longer travels in the setup prompt pasted into chat** — the app now
  provides it via a separate terminal step that writes `~/.config/pidge/env`. Every
  remediation message that used to say "re-run the setup prompt" now points at that terminal
  step instead, and warns to NEVER paste the secret into a chat (a chat prompt is a log).
  Updated: the `--help` ENV section, the invalid-secret runtime warning, the sealed-content
  pre-flight errors, and all doctor E2E texts. Wire format, sealing, and exit codes are
  unchanged.

## 0.17.1

- **Fix (E2E send): labels of built-in and reserved actions are never encrypted.** Clients
  skip label decryption for built-in action ids, so an encrypted label on one of those ids
  would render raw ciphertext on the button. Action ids already traveled clear; only custom
  labels are sealed.
- **`pidge approve` is now listed in the top-level `--help` USAGE** (the deny-default
  exit-code gate was previously undiscoverable from the main help).
- **Installed skill improvements**, each fixing a failure mode observed with fresh agents:
  `--file`/`--image` are documented (agents pasted digests but never attached the artifact);
  a Live progress section; the supervisor-poll example now uses `listen --all`, with an
  explicit note that a pending notification's answer never surfaces in plain `listen`
  (recover it via `wait <cid>` or `listen --all`); the guidance for a channel with no
  registered devices now clearly says to abort a blocking wait.

## 0.17.0

End-to-end encryption v1 is live on the wire: sends seal, reads decrypt. With
`PIDGE_SECRET` configured and E2E enabled on the channel, content leaves your machine as
ciphertext the server cannot read, and sealed answers and messages decrypt back to plaintext
locally.

- **Sending:** with a valid `PIDGE_SECRET` (same slot and precedence as `PIDGE_TOKEN`; the
  pair travels together) AND E2E enabled on the channel, EVERY send path
  (`message/important/urgent/event/live`, `ask`, `approval`, `approve`, `hello`, the
  deprecated `notify`/`send`) seals `title`/`subtitle`/`body`/`body_markdown` plus
  custom-action LABELS (action ids stay clear). No secret / non-E2E channel / channel status
  unreachable ⇒ the clear send of always — a missing secret must NEVER block a notification
  (the app marks such messages as unencrypted). An INVALID secret warns loudly and degrades
  to clear. Media note: `--image`/`--file` bytes and filenames still ride clear in this
  release — narrated on stderr when sealing (sealed media arrived in 0.20.0). The send echo
  on stdout shows your own content decrypted for display, with the encryption markers
  printed as the wire truth.
- **Receiving:** `listen` (realtime and polling paths) opens sealed messages and sealed
  notification replies; `wait`/`ask`/`approve`/`hello` open sealed answers (typed text and
  custom action labels; built-in labels pass through). On success the plaintext replaces the
  ciphertext and the row is marked `e2e:"decrypted"`; rows sent before E2E render exactly as
  before — honest degradation, never guessed.
- **Precise errors — never garbage on your terminal:** sealed content the CLI can't open is
  BLANKED (`body`/`text` → `null` plus an `e2e_error`) with ONE precise stderr line per
  distinct reason: sealed with ANOTHER key (both key fingerprints shown — the classic
  token-of-one-channel/secret-of-another mixup), a sealed row missing its correlation id, an
  unknown envelope version, no (valid) `PIDGE_SECRET`, or a failed integrity check.
  Ciphertext never reaches the terminal. A readable non-envelope value in a sealed context
  (a built-in action label, or a clear reply typed on an older app) passes through as text.
- **`pidge doctor`:** validates `PIDGE_SECRET` when present (base64url, exactly 32 bytes;
  narrates the key fingerprint, never the secret) and crosses it with the channel: E2E
  channel + no secret → warning pointing at the setup step; secret + non-E2E channel →
  orphan-secret warning; E2E channel + invalid/mismatched secret → BROKEN, exit 2. The
  stdout JSON gains `e2e: {channel, secret, kf}`.
- **`pidge setup`:** the `{TOKEN, SECRET}` pair travels together — `setup --claim` persists
  `PIDGE_SECRET` next to the token in the config file, and `--print` emits the
  `export PIDGE_SECRET=…` line alongside the others. A secret already in the file is never
  silently dropped on a re-claim.
- **Under the hood:** AES-256-GCM via Node's built-in `crypto` — zero new dependencies, still
  a single-file CLI. Every field is sealed as an independent envelope bound to its channel,
  message, and field name (so a sealed value can't be swapped between slots). Decryption
  failures are loud and precise, and the implementation is pinned by a deterministic test
  fixture shared across the Pidge clients.

## 0.16.1

Hardening batch: two correctness holes closed, docs reconciled with 0.16.0.

- **Fix: the skill self-update is now atomic.** `SKILL.md` is written to a temp file and
  renamed into place, so a killed process or a full disk leaves the old skill intact and
  concurrent refreshes can't tear each other. A torn write from an older version is now
  detected and repaired (previously it read as "fresh" forever). Overwriting a `SKILL.md`
  that differs saves `SKILL.md.bak` with one stderr note — customizations are never
  clobbered silently.
- **Fix: `--timeout`/`--interval` typos no longer hang the blocking commands forever.** An
  unparseable value (e.g. `--timeout abc`) used to make the deadline unreachable, so
  `wait`/`ask`/`approve`/`hello`/`listen` polled eternally and `approve`'s deny-default
  timeout never fired. Now an invalid value dies immediately (exit 1, fail-closed) BEFORE
  anything is sent — no ghost approval on the phone. `approve` also traps SIGINT → exit 1
  with the deny-default narration.
- **Docs:** the README example `ask --actions yes,no,reply` (broken since 0.16.0's
  decision+reply refusal) is fixed; `pidge approve` is documented (commands table,
  quick-start); the environment TRUST CAVEAT is spelled out in `--help` and the README (the
  gate is only as trustworthy as `PIDGE_URL`/`PIDGE_TOKEN`); the `approve` exit-code docs now
  tell the whole truth (an HTTP failure on the send → 1; only a raw network error → 2).

## 0.16.0

New: `pidge approve` — a hook-shaped permission gate.

- **`pidge approve "<question>"`** wraps an agent's OWN risky actions behind a human Face-ID
  tap. It sends an important, sensitive notification with two gated actions (`allow` =
  Face-ID confirm, `deny` = destructive style), blocks like `pidge ask`, and maps the answer
  to an **exit code, DENY-DEFAULT**: only an explicit `allow` is exit 0; deny, timeout, a
  dead channel, or any ambiguity is non-zero — so a Claude Code `PreToolUse` hook fails
  CLOSED. The `chosen_action` JSON prints to stdout. `--allow-label`/`--deny-label` customize
  the buttons; `--help` includes a runnable `PreToolUse` hook example.
- **The CLI now refuses a decision button combined with `reply` in one send** (e.g.
  `--actions yes,no,reply`) — exit 1, nothing sent. The human would tap the easy Yes/No and
  you'd get a useless "Yes" instead of the typed text. `reply` alongside a non-decision
  action (e.g. `done,reply`) stays allowed.
- **Fix:** `pidge <type> --help` no longer prints a bare, description-less `template` line
  (`--template` is intentionally off the menu; it remains a silent back-compat input).
- **`setup --quiet`** collapses onboarding to a single status line (the full doctor output
  stays the default; `--quiet` never hides a broken setup — warnings and errors still print).
- **`listen --all` now WARNS when its first quick batch is old backlog** ("N message(s) were
  ALREADY queued when this listen started … NOT fresh arrivals"), so a resurfaced
  notification answer isn't mistaken for a new event.
- **Installed skill updated** to teach `pidge approve` and the decision-vs-reply refusal.

## 0.15.3

- **Fix: the skill self-update marker no longer corrupts the skill.** The 0.15.2 marker was
  written as the first line of `SKILL.md`, above the opening `---`, which broke Claude Code's
  frontmatter parsing: the skill still appeared, but with a garbage description — so the
  agent never learned WHEN to use Pidge. The marker now rides as a YAML comment INSIDE the
  frontmatter (invisible to `name`/`description`), the old broken position is still
  recognized as stale, and every 0.15.2 install self-heals into the corrected format on the
  next command — zero human action needed.

## 0.15.2

- **The installed skill now self-updates:** any pidge command silently refreshes
  `.claude/skills/pidge/SKILL.md` when a newer skill revision is available, so onboarded
  agents always run the latest guidance. Only an EXISTING skill is refreshed (never
  auto-created), at most once per process, fully best-effort (a refresh failure never breaks
  your command), and the quiet-nag setting suppresses the stderr note (the refresh still
  happens). Composes naturally with `npx pidge-cli@latest`.

## 0.15.1

- **Installed skill polish:** catalog-first action guidance; write-for-the-lock-screen (the
  banner is title+body; `body_markdown` is detail-only); guidance on writing a good report;
  the gold examples now set a plain `--body`.

## 0.15.0

CLI redesign.

- **Input:** `-m`/`--body-markdown-file` input chain; new `--gated` flag; `hello` is now in
  English; `--template` removed from the help menu (still accepted for back-compat);
  `--wait` defaults to 60 minutes for decisions.
- **Installed skill rewritten:** two approval paths, English gold examples, no
  content-template menu, capability appendix.
- **Onboarding:** `setup → skill → hello` now runs as one fused flow with graceful
  degradation.

## 0.14.0 — 2026-06-28

The unified vocabulary — the CLI now speaks the same language as the app: ONE list of 5
message types, with RESPONSE as a separate axis. No scripts break — the old names keep
working as aliases.

- **The typed sends are renamed to the canonical 5** — `pidge message` · `important` ·
  `urgent` · `event` · `live` (message←fyi, important←report, urgent←alert; event/live
  unchanged). `important` is the recommended default.
- **Compat:** the OLD names still work as aliases — `pidge fyi`→message, `report`→important,
  `alert`→urgent — with a one-line rename note on stderr. Muscle memory and existing scripts
  are untouched.
- **RESPONSE is now its own axis, composing on ANY type** — `--actions`/`--custom-action`
  (buttons) plus the new **`--wait`** (block until the human answers, then print
  `chosen_action` JSON; without it = fire-and-forget). This is the explicit "send-and-go vs
  wait".
- **`pidge ask` is now the shortcut for `important --wait`** (still REQUIRES a way to
  answer; behavior preserved). Asking is a type + buttons + wait, not a separate type.
- **`pidge approval`** — a new go/no-go RECIPE = `important` + Approve/Reject buttons +
  Face ID on Approve + `--wait`. Pass your own `--actions`/`--custom-action` to override the
  default pair.
- **Docs:** USAGE, per-command help, and the generated `SKILL.md` rewritten around the two
  axes (type + response), dropping the old fyi/report framing.

## 0.13.1 — 2026-06-26

Polish. No breaking changes.

- **Fix:** the new-capabilities nudge no longer scolds "your CLI is stale, UPDATE it". pidge
  is a thin pipe — `--param KEY=VALUE` carries any new field TODAY, so new server
  capabilities almost never need a CLI release. The nudge is reframed as "new capabilities +
  how to use them now", and the false-positive nag on `@latest` is silenced.
- **Fix:** the capability-catalog `curl` example shown in that nudge was corrected.
- **Fix:** the realtime reconnect log no longer reads "realtime socket **socket** closed"
  (doubled word), and the counter no longer sticks at "attempt 1/4" — it shows a monotonic
  "reconnect #N", so a connect→drop flap visibly advances instead of looking like a stuck
  loop.

## 0.13.0 — 2026-06-25

Message types — the agent declares an intent TYPE; the server maps it to the human's
delivery preferences (the human never sees the type). Soft rollout: typeless sends still
work in 0.13.x.

- **6 type subcommands** — `pidge fyi` · `report` · `ask` · `event` · `alert` · `live`.
  fyi/report/event/alert/live are fire-and-forget (like `notify`); `ask` sends and waits for
  the answer.
- **`pidge notify` (and `pidge send`) is deprecated** with a local warning. Use a typed send
  instead. (The type names were later refined in 0.14.0, where the old names became
  aliases.)
- **Local validation before the round-trip** — `ask` requires a way to answer (`--actions`,
  `--custom-action`, or a template that supplies them); `event` requires a valid ISO8601
  `--event-at`. Friendly exit-1 errors, nothing sent.
- **`alert --escalate`** requests escalation (an alarm that breaks through silent/Focus —
  the human's profile decides).
- **An unknown subcommand now points at the type catalog** instead of dumping the whole
  USAGE, and `pidge <type> --help` shows each typed send's own flags.
- **`pidge skill install` writes a "Choose the right type" catalog table** into the
  generated `SKILL.md`.

## 0.12.0 — 2026-06-25

Bug-fix batch from real production use. No breaking changes.

- **Fix:** `pidge <sub> --help` shows the SUBCOMMAND's own help (its synopsis + own flags),
  not the global USAGE dump — e.g. `pidge ask --help` now leads with ask's
  `--actions`/`--timeout`. `pidge --help` and `pidge help` still show the full overview;
  `pidge help <cmd>` is the focused form.
- **The "server has new capabilities" notice is throttled to once per 24h** (cached in
  `~/.config/pidge/state.json`, per-agent when `PIDGE_AGENT` is set) and only re-fires when
  the capabilities actually changed — no more a nag on every call. New `--quiet-nag` flag
  and `PIDGE_QUIET_NAG=1` env to silence it entirely (scripts/CI).
- **`--actions` accepts a JSON array** of custom `{id,label,…}` actions for custom labels —
  e.g. `--actions '[{"id":"approve","label":"Approve now"},{"id":"defer","label":"Leave it for tomorrow"}]'`.
  A leading `[` selects JSON; bad JSON or a missing `id`/`label` is a friendly LOCAL error
  (exit 1, nothing sent). The short form `--actions yes,no,reply` is unchanged, and JSON
  composes with `--custom-action`.
- **Docs:** the capability-catalog instructions in the version notice were fixed so that
  following them works on the first try.
- **`pidge skill install` now writes an "always-on for turn-based agents" recipe** into the
  generated `SKILL.md` — an interactive listening window (`pidge listen --follow`) and a
  no-daemon supervisor poll (looped one-shot `pidge listen`).
