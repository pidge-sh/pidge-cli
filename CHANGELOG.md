# Changelog

## 0.44.1 — 2026-08-07

**The installed daemon now serves the config slot that installed it — and
refuses to take the service name from one that isn't its own.** Two halves of
the same hole, found in guided QA of `connect --qr` on a machine that already
had a paired daemon.

- **The service template pins `HOME` (and `XDG_CONFIG_HOME`, when you set
  one).** `sh.pidge.terminal` / `pidge-terminal.service` resolved the config
  slot from the environment the SUPERVISOR handed them — the login account's
  `HOME`, never the shell's. So a `connect` run under a custom `HOME` or
  `XDG_CONFIG_HOME` (routine on Linux, and the only way to test a pairing in
  isolation) installed a daemon that read a *different* config than the one
  `connect` had just written: the freshly paired identity never came online,
  while the binary quietly served someone else's. The launchd plist now
  carries `HOME`/`XDG_CONFIG_HOME` in `EnvironmentVariables` and the systemd
  unit carries `Environment=HOME=…` alongside the `XDG_CONFIG_HOME` it already
  had. `XDG_CONFIG_HOME` is pinned only when you actually set one — inventing
  a value would relocate the config of everything the daemon spawns.
- **A second `connect` from a different config slot is now REFUSED, not
  granted in silence.** The service name is one per user account, so
  bootstrapping a new one booted the running daemon out and took its place —
  no warning, no consent, and the displaced computer went offline without
  saying so. Install now asks the OS which slot the existing service serves
  (`launchctl print` / the unit's `FragmentPath`, plus the template on disk)
  and stops with both directories named and two pasteable ways forward: re-run
  in the existing slot's environment, or retire it first. The check runs
  BEFORE the claim too, so a doomed `connect` can no longer burn a pairing
  code and leave the phone spinning on a computer that will never connect.
  Replacing stays silent when it is the same slot — that is an ordinary
  restart. A slot whose directory no longer exists is treated as rubble and
  replaced: a plist that outlived its `/tmp` config must never lock you out of
  your own machine.
- Recognising an existing install reads the service's log path, which every
  version we ever shipped writes — so the refusal also protects daemons
  installed **before** this release, which carry no pinned environment at all.

## 0.44.0 — 2026-08-06

**Pairing v2 — `pidge terminal connect --qr`, the computer-first door.**
Until now pairing always started on the
phone: mint there, paste a one-liner carrying `code+SECRET` through the
clipboard. The new door reverses the direction with a STRICTLY smaller
surface: the computer mints the key and it leaves the machine **only by
camera**.

- **`connect --qr`**: mints K locally (32 bytes CSPRNG, the BYOK generator
  class), prints a QR carrying `pidge-pair:v1:{k, kf, host, os, base_url}`
  plus a screen-share warning, then blocks on
  `Enter the code shown on your phone:`. The app scans, shows host+kf for
  confirmation, creates the tunnel (the phone REMAINS the only channel
  creator — `tunnel_requires_human` untouched) and displays a claim code; you
  type it back. From the claim on it is the existing install path, byte for
  byte (same retry-safe claim exchange, same kind guard, same hooks/skill/
  daemon). A mistyped code reprompts (404 is uniform: unknown =
  expired = mistyped); **nothing persists until the claim succeeds** — ctrl-C
  at the prompt leaves zero residue. `--qr` refuses `--code`/`PIDGE_SECRET`
  (the two doors never half-mix) and the existing-identity guard applies
  verbatim (`--qr --replace` = consented switch, old channel stays server-side).
- **In-tree QR encoder** (`src/terminal/qr.js`, ~300 lines, byte mode, EC
  L/M): pidge-cli keeps its ZERO runtime dependencies — the renderer that
  touches the computer key is code reviewed in this repo, not an npm package
  trusted at install time. Cross-validated module-by-module against an
  independent implementation (python-qrcode) across versions 1–20 × levels
  L/M × all 8 masks (`test/gen-qr-golden.py`); CI re-asserts the committed
  golden matrices with no python.
- **Shared cross-wire fixture** `test/pairing_qr_vectors.json`: the exact
  payload string the CLI emits, plus the failure cases (unknown version, kf mismatch, short key,
  standard-base64 key, http base_url) the iOS parser must refuse with typed
  errors.
- **`pidge setup --claim CODE --from-computer` — the channel secret by
  DERIVATION.** On a machine already paired as a computer, setup can now
  derive `PIDGE_SECRET` from the computer key instead of receiving it:
  `HKDF-SHA256(computer_key, salt empty, info "pidge-derive:v1:ch<id>", 32)`
  — the app derives the SAME key on the phone side, so no secret travels at
  all (no one-liner, no clipboard, no chat). One-way: no channel key ever
  reveals the computer key. Refuses loudly before any network on an unpaired
  machine, and refuses an ambient `PIDGE_SECRET` alongside the flag (two
  secret sources never half-mix). The derivation is byte-asserted against the
  shared fixture's `derivation` suite.
- **E2E fixture caught up to the shared canonical copy**: the `derivation`
  suite (per-channel key derivation — HKDF-SHA256, empty salt, raw-bytes IKM,
  `pidge-derive:v1:ch<id>`, including the IKM-as-string failure case) and the
  Terminals-v2 `computer_*` vectors with their cross-lane and cid-replay
  failure cases — all asserted by this repo's node tests now.

## 0.43.2 — 2026-08-05

- **The bridge's "channel looks broken" desktop alert is now sleep-aware.** On a
  laptop the old rule (any 5 consecutive poll failures) fired on every
  sleep/wake cycle — 30 alerts in one night, all of them the Mac napping.
  Failures are now classified LOCAL (this machine/its network: ENOTFOUND,
  ENETDOWN/UNREACH, EHOSTUNREACH, no non-internal interface, aborts right after
  a wake) vs SERVER-shaped (HTTP 5xx, or network errors while local
  connectivity looks fine); system sleep is detected from wall-clock gaps
  (timers freeze while the OS sleeps) and resets the failure streak. The
  desktop alert pops only for a server-shaped streak that persisted **≥10
  awake minutes**, at most once per outage and once per **4 h** — and when an
  alerted outage heals, a quiet "channel recovered" notice closes the loop.
  Every failure still narrates to stderr and still backs off exactly as
  before; the immediate 401 (rotated key) alert is unchanged, and
  `PIDGE_BRIDGE_ALERT=0` still disables desktop notifications entirely.

## 0.43.1 — 2026-08-05

**A live agent is an agent.** 0.43.0 decided whether a shared pane held an agent
or a plain terminal by matching `#{pane_current_command}` against a closed list
of harness names. Claude Code v2.1.222 reports its **version** there (`2.1.222`,
while `ps` still says `claude`), so the daemon concluded "claude exited" and
retired the live transcript within a second — the phone showed the terminal
placeholder, with no composer, for a session that was in fact waiting for its
human. Nothing errored, because a wrong renderer hint errors nowhere.

- **`term` is now a POSITIVE assertion; doubt shows the transcript.** A live
  transcript is only retired when BOTH halves agree: the pane's current command
  is a shell this CLI recognises (`sh`/`bash`/`zsh`/`fish`/`dash`/…) **and** no
  harness process is alive under the pane's process tree. Anything else — an
  unfamiliar command, a vendor string never seen before, a `ps` that failed —
  keeps the current view and says so once in the log. The list that DECIDES is
  the shell one, because it is ours and it is stable; a closed list of someone
  else's process names cannot say "I do not recognise this", only "absent", and
  absent is not evidence.
- The same rule applies when a pane is FIRST shared: `pidge terminal share` on a
  pane running a harness it cannot name now still looks for that pane's
  transcript instead of publishing a live agent as a terminal.
- **`pidge terminal doctor`** — a new command that answers, on the machine and
  against the binaries actually installed there, "does this computer read a live
  agent AS an agent?". It prints the raw `#{pane_current_command}` for every
  pane, what each half of the rule concludes, and the mode each shared pane is
  published with; a live harness published as `term` exits non-zero.
- **A spawn with no directory now opens in your HOME**, not in whatever the
  daemon inherited. Under launchd/systemd that was `/`, where a spawned claude
  meets its own trust prompt, never announces, and leaves a pane the phone
  cannot answer. An explicit directory is still honoured verbatim.

## 0.43.0 — 2026-08-04

**Terminals v2, Phase A: the unit is a PANE.** A share stops being a Claude
session and becomes a tmux pane — when claude starts in (or exits from) a shared
pane the share stays, same row and same history, and only the view switches.
Requires a server at manifest v102. (0.42.0–0.42.2 shipped as QA rounds r3/r4,
r6 and r7 with no changelog entry of their own.)

- **`pidge terminal share`** — typed INSIDE any tmux pane, shares that pane with
  the phone. It matches its own controlling tty against `#{pane_tty}`, so there
  is no picker and no guessing; a pane list this computer cannot parse is
  reported as a **pidge-side failure**, never as "you are not in tmux".
- **`pidge terminal config remote_spawn|inventory on|off`** — what your phone may
  do to this computer, granted **on the machine where the risk lives**.
  `remote_spawn` defaults **OFF**, `inventory` **ON**; `connect` and `status`
  print both in plain words, and they ride every capabilities frame so the app
  renders only what was actually granted. Typing into a pane you already shared
  needs no grant — the share IS the consent.
- **The computer lane.** While this computer is connected the daemon holds ONE
  always-on cable socket carrying a `ComputerChannel` subscription (presence
  beat every 30 s, sealed capabilities + on-demand pane inventory) — your phone
  sees the computer online with **zero shared panes**. The inventory is gathered
  on demand, sealed end-to-end, size-capped and **never stored**.
- **Commands from the phone** ride the durable message queue (sealed under the
  `computer_cmd` lane, at-least-once + exactly-once effects): spawn a pane
  (optionally running claude), capture a pane, end a share. Every outcome is
  narrated — a refused spawn says exactly which line on this machine opens it.
- **Per-share identity.** New shares mint `ases_<uuid>`; the harness session id
  moves inside the sealed metadata where an occupant attribute belongs. Existing
  shares keep their id **byte-verbatim, forever** (it is the AAD anchor of every
  item already sealed): `state.json` migrates in place to `schema: 2` and
  re-derives nothing.
- `status` now reports **per lane** — `computer:` says whether your phone really
  sees this computer, and `shares:` replaces `sessions:` with public id, pane and
  mode.

## 0.41.0 — 2026-08-03

**Agent Sessions: the enable door is rebuilt, and pairing actually works.** The
on-device QA of 0.40.0 never got past the first step; every fix below was
reproduced on a real Mac, not deduced.

- **Enable now rides the HOOK, not a process-tree walk.** The old
  `pidge terminal enable` walked its own ancestors looking for `claude` — which
  is structurally broken: Claude Code runs every Bash tool inside a **ttyless
  shell wrapper** whose command line mentions `.claude/`, so the walk stopped
  there and refused on every machine. Now the human **pastes an instruction into
  the session they want to share**; claude runs one bash carrying the sentinel
  `pidge terminal enable`; the **`PreToolUse` hook fires before it runs**,
  carrying the authoritative `session_id`, and the daemon shares THAT session
  and **denies the tool** — its denial reason IS the outcome. Consequences:
  - the command never actually runs, so **`pidge` need not be on any PATH**;
  - a claude that has never heard of Pidge just runs one harmless command —
    the pasted text forbids going "online" or acking any queue;
  - pane binding is tty-first with a **cwd fallback**, and **refuses when zero
    or MORE THAN ONE** pane matches — it never guesses which shell to type into.
  `pidge terminal enable` still exists as a **confirmation** (it reports what is
  mirroring and prints the prompt to paste); the daemon's `POST /enable` is gone.
  The approval gate rides the pasted command: `pidge terminal enable --approvals Bash,Write`.
- **`terminal connect` tolerates a server that doesn't report `channel.kind`.**
  Reading a missing field as "not a tunnel" refused **100%** of connects.
- **A post-claim refusal no longer discards the rotated key** — the identity is
  persisted before the kind is validated.
- **`connect` refreshes the Pidge skill** (into `~/.claude/skills/pidge`), so a
  computer prepared for Agent Sessions never leaves a stale rev behind — an old
  skill read "enable yourself on Pidge" with its previous meaning and went
  online on a notification channel instead. Failure warns, never blocks.
- **The daemon service no longer points into the npx cache.** `connect` copies
  the CLI to `~/.config/pidge/terminal/cli/` and the launchd/systemd `ExecStart`
  runs THAT — `npm prune` of `~/.npm/_npx` can no longer kill the daemon weeks
  later, and nothing depends on the npm prefix being in PATH.
- **`pidge update`** — new command: installs `pidge-cli@latest` with the manager
  that owns this copy (npm/pnpm/yarn/bun, auto-detected). `terminal connect`
  self-checks the published version and points here when it's behind
  (`PIDGE_NO_UPDATE_CHECK=1` opts out).
- Skill spine → rev 19 (it teaches the new door, including that the **denial is
  the success signal**).

## 0.40.0 — 2026-08-03

**Agent Sessions hardening** — three adversarial reviews over 0.39.0 (which was
never published to npm with these fixes). Behavior/UX changes worth calling out:

- **Single enable door (lock-down).** `pidge terminal ls` and `enable --session`
  are **removed**, and there is no read-only tier. The only way to share is to
  tell the Claude running inside a tmux *"enable yourself on Pidge"* (the skill
  runs `pidge terminal enable`, which walks its process tree to that claude).
  Run outside a claude session, or outside tmux, and it **refuses loudly** —
  never guesses which session to capture, never creates a pane-less share.
- **Cross-platform daemon.** `connect` installs launchd on macOS, a
  `systemd --user` unit on Linux/WSL2, or a detached process + shell-profile
  hint on WSL without systemd. Fixed a real Linux bug (`ps -o tty=` prints `?`
  not `??`) and dropped the hard `lsof` dependency (`/proc/<pid>/cwd`).
- **All user-facing copy says "computer"** (the app flow is Settings →
  Computers → Connect a computer).
- **Durability (never eats data).** A durable outbox in `state.json` means a
  daemon restart no longer silently drops the un-published queue; rearm retries
  on a transient outage instead of abandoning the session; a `waiting`
  notification re-arms on failure; the heartbeat re-asserts status; `disable`
  reports honestly when it couldn't reach the server.
- **Safety fixes.** The approval gate now asks `approve`/`reject` (the server's
  real pair — `deny` was silently dropped); `installHooks` aborts instead of
  overwriting an unparseable `~/.claude/settings.json`; unknown Claude block
  types surface as a visible notice instead of vanishing.

## 0.39.0 — 2026-08-02

**Agent Sessions — `pidge terminal` reborn as transcript-as-data** (pidge repo
`docs/agent-sessions-spec.md`; pairs with server manifest v98). Not the old byte
mirror: the daemon tails Claude Code's own session transcript (JSONL), normalizes
it into structured items and publishes them **E2E-sealed** to a tunnel channel;
the phone renders a native conversation and typed replies land in the session's
real input box via tmux `send-keys`. Pidge never spawns or wraps the agent.

- `pidge terminal connect --code <code>` — once per computer: exchanges the
  app's claim code (Settings → Computers → Connect a computer), stores the
  tunnel identity in its own machine slot (`~/.config/pidge/terminal/env`,
  0600 — independent of every project/agent identity), asks consent, installs
  Claude Code hooks (tagged `# pidge-hook`, cleanly removable) and a background
  daemon (launchd on macOS, `systemd --user` on Linux/WSL). E2E is mandatory —
  there is no clear mode.
- `pidge terminal enable` — per session, opt-in (consent boundary = capability
  boundary): run from INSIDE claude ("enable yourself on Pidge" — the skill
  teaches it), it walks the process tree to the claude ancestor, binds its exact
  tmux pane + transcript, seeds the last ~100 items and live-tails. `ls` is the
  picker door; sessions outside tmux are not shareable in v1.
- Status via hooks (PreToolUse→running, Notification→waiting→a REAL
  notification, Stop→idle) + 30 s heartbeats; `--approvals Bash,Write` gates
  those tools behind an Approve/Deny push (off by default; timeout falls open
  to the local prompt).
- Input lane hardening inherited from the old feature's paid-for lessons: pane
  binding, single-writer lock, viewer-generation replay ledger + daemon epoch
  echo, a deliberately tiny key allowlist, and items degrade INSIDE the 16 KB
  sealed cap before sending.
- Skill rev 17: the "Enable yourself on Pidge" instruction.

## 0.38.0 — 2026-07-30

**Pidge Terminal removed** — the whole `pidge terminal …` surface (the tmux mirror
wrapper, `terminal attach`, and the `terminal host` daemon) is gone, a product
decision rather than a technical one. Two findings drove it: a terminal-on-your-phone
is already served well by dedicated SSH clients (Termius, Blink — use those for raw
terminal access), and the thing we actually wanted to mirror — a Claude Code
conversation — cannot be faithfully reconstructed from the terminal byte stream, so
the mirror could never become the transcript view it was reaching for. Pidge stays
focused on what it is: the **notify → reply loop** between an agent and its human
(`ask` / `approval` / `approve`, `listen` / `bridge`, `live`).

- Removed: the `terminal` subcommand (all three forms), its flags (`--name`,
  `--install`, `--link`, `--no-link`, `--machine-channel`), the `src/` terminal
  module, and its help/README sections. `pidge terminal` now fails as an unknown
  subcommand.
- No other command changes: notifications, waits, E2E sealing, media, bridge, runs
  and Live Activities are untouched.

## 0.37.1 — 2026-07-30

Terminal hardening — four fixes from the external adversarial review
(2026-07-29 findings #6/#7/#10/#11). No wire/contract changes.

- **Seed ladder no longer bypasses the frame cap (finding #6, HIGH).** The last
  scrollback rung (`-S 0`) used to send unconditionally; an SGR-heavy visible screen
  over the relay's ~64 KB cap entered the exact infinite loop the cap exists to
  prevent (relay drops the seed → viewer reseeds → the host regenerates the same
  dump — the one loss reseed can't heal). The floor now **degrades** instead: the
  screen is re-captured **without `-e`** (colors lost, content kept); if still over
  the cap, lines are **truncated from the top** (the bottom of the screen is the live
  part); every degrade is narrated loudly. An over-cap frame is never sent.
- **An old control client's close can no longer clobber a fresh reattachment
  (finding #7, HIGH).** `detach → new viewer attaches → old client's async onClose`
  used to null `rec.attached` unconditionally (via the shared `rec.detaching` flag),
  leaving the new viewer dark and the new control leaked. The close/output callbacks
  are now **identity-guarded** to their own control instance, and deliberate teardown
  is pinned to the instance being killed — a replaced client's late death touches
  nothing, including the "session died" cleanup.
- **`tmux rename-session` ends the wrapper loudly instead of silently breaking it
  (finding #10, MED).** After a rename, live output kept flowing but every
  `send-keys`/`capture-pane` targeted the frozen old name — input and reseed failed
  silently forever. The wrapper/attach form now exits 2 on `%session-renamed` with
  the re-attach instruction (`pidge terminal attach <new-name>`). The host daemon is
  untouched — its 5 s inventory already self-corrects. Following the rename (pane-id
  pinning) stays Tranche B work.
- **The 12 s spawn cooldown now lives at the host (finding #11, MED).** It existed
  only inside one iOS process, so two devices (or an app relaunch inside the window)
  each carried an empty cooldown and double-spawned heavy agents. The daemon — the
  authority that executes profiles — now enforces one global 12 s window
  (`SPAWN_COOLDOWN_MS`, matching the iOS client's `TerminalSpawnController`); a
  spawn inside the window is ignored with a note.

## 0.37.0 — 2026-07-29

- **Terminal: the seed carries alternate-screen state** — when the pane is on the
  alternate screen the host prefixes the seed's data with `ESC[?1049h`, gated on a
  fail-closed double read of `#{alternate_on}` around the capture, so the alt-drag
  scroll gate on iOS opens for pre-existing TUIs (gotcha #64; cures already-shipped
  viewers via the CLI alone).

## 0.36.0 — 2026-07-29

**Pidge Terminal: a TUI that stays readable** — the two host-side fixes the on-device
QA (r4 verify) pinned as entry gates before the iPhone's Terminals tab can be lit.

- **Post-resize repaint nudge.** A TUI (Claude Code, vim, htop) already painted at
  width W was left **torn** when the tmux grid changed after it drew — opening a
  session, rotating the phone. Nothing redraws it on its own: the mirror attaches as
  tmux's **control** client, which renders no screen, so `refresh-client` only re-emits
  the already-torn grid. The one universal repaint trigger is **SIGWINCH**, and tmux
  delivers it only when the size actually *changes* — so re-opening a session (a resize
  to the size the window already has) produced no SIGWINCH at all and the tear stayed.
  Now, once a burst of resizes has **settled** (debounced ~500 ms after the last one, so
  a rotation's burst only nudges the final size), the size is reapplied with a **1-row
  jiggle** (`rows-1` → `rows`): tmux sees two real changes, the pane gets two
  SIGWINCHes, and it repaints at the **final** size — including the no-op case. The
  pair always ends at the size you asked for. Both lanes drive it: the wrapper's own
  resize and the daemon's control lane (per-session timer, cancelled on detach).
  `C-l` was **rejected** as the mechanism: in Claude Code it clears the transcript the
  human is supervising — the mirror never sends keys.
  New knobs: **`PIDGE_TERMINAL_NUDGE_MS`** (default `500`; **`0` disables the nudge
  entirely** — ops escape hatch) and **`PIDGE_TERMINAL_NUDGE_PAUSE_MS`** (default `60`).
- **The live "echor2" ghost is gone.** Inside tmux, `TERM=screen*` makes zsh emit the
  **screen title sequence** `ESC k <title> ST` around every command, and tmux forwards
  those bytes verbatim in `%output`. The viewer's terminal doesn't treat `ESC k` as a
  string introducer — it dispatches `k` as a 2-byte escape and **paints the title as
  literal text** (`echo r2` showing up as `echor2`, the stray `%` line). That's why it
  was live-only and why a reseed always healed it: `capture-pane` renders grid cells and
  never contains the sequence. The host now strips `ESC k … ST` from the **live stream
  only** — the seed path is untouched, and since the mirror has no window-title UI the
  removal is **lossless**. The stripper is stateful across chunk boundaries (the
  sequence can split at any byte); a held `ESC` that turns out not to open a title is
  re-emitted intact, in order. Only `ESC k` is filtered — this is deliberately not a
  sanitizer.

## 0.35.0 — 2026-07-24

**Pidge Terminal: the machine channel + advisory session links** (server ≥ manifest
v94 — the CLI detects an older server and degrades LOUDLY, never silently).

- **`pidge terminal host --install --machine-channel`** — the daemon no longer needs
  a pre-existing channel. The installer creates a **hidden** machine channel
  (`🖥️ <hostname>`) with your existing key — hidden channels stay off the human's
  Channels tab but are fully functional; the app's Terminals tab is their home — or
  **reuses** the one a previous install minted (a re-install never creates a
  duplicate; only a dead 401 key is replaced). The minted key is stored in the
  daemon's **own identity scope** (`~/.config/pidge/agents/terminal-host/env`, chmod
  600): the shared machine env and every project env are **never touched**, and the
  generated launchd/systemd template pins `PIDGE_AGENT=terminal-host` so the running
  daemon (and `PIDGE_AGENT=terminal-host pidge doctor`) resolves the same scope with
  zero new machinery. Sealed-only is unchanged: the fresh channel is born non-E2E,
  so the installer prints the exact next steps (enable E2E in the app;
  `PIDGE_SECRET` lands next to the token) instead of pretending. On a pre-v94
  server the create is refused **before** anything happens — `hidden:true` would be
  silently dropped there and mint a channel visible in the human's app.
- **`--link <channel-id>` / `--no-link`** on `pidge terminal` and
  `pidge terminal attach` — the session upsert carries `linked_channel_id`:
  ADVISORY provenance ("this terminal runs channel X's agent") the Terminals tab
  can chip; it never changes delivery, auth or relay behavior. Partial-upsert
  semantics ride through honestly: omitted keeps the stored link, `--no-link` sends
  an **explicit null** that clears it. A bad or foreign id is the server's loud
  `422 invalid_linked_channel` — surfaced as exit `2`, never silently dropped.
- **Link inference** (wrapper + attach, when neither flag is passed): if the
  session's cwd lives in a git project holding a project-scoped pidge env
  (`~/.config/pidge/projects/<hash>/env`), that project's channel is linked
  automatically — loudly (the note names the channel), conservatively (no project,
  no env, a different server, the mirror's own channel, an unresolvable whoami ⇒ no
  link), and never fatally: a refused **inferred** link re-registers without it.
- On a pre-v94 server, a requested link is registered fine but IGNORED by the
  server's permit — the CLI says so on stderr instead of pretending it stuck.
- Docs: host/daemon wording says **machine** (Linux/systemd is first-class; WSL
  works) — "Mac" now only where it means the Pidge Mac viewer app.

## 0.34.0 — 2026-07-22

**Pidge Terminal (part 2): `pidge terminal host` — the always-on daemon.** One
process per channel that makes the Terminals tab self-service: the phone lists this
Mac's tmux sessions, opens any of them, and starts new ones — without an agent (or a
human at the keyboard) running anything first.

- **Control lane.** The daemon registers a `kind: control` session and publishes,
  sealed like everything else, the live sessions list and the spawn profile names;
  viewers send `spawn`/`reseed`/`resize` back on the same lane (its own AAD pair,
  anchored on the control session's id; monotonic-seq replay guard).
- **Inventory.** `tmux ls` is polled and kept registered server-side — a session
  appearing anywhere on the Mac shows up in the tab; one that dies gets its row
  marked ended. Session identity (`public_id`) is stable across daemon restarts.
- **Lazy attach.** The tmux tap for a session starts only when someone is actually
  watching (viewer join → attach + seed repaint; a fresh tap bumps the `epoch`) and
  stands down after the last viewer leaves (30 s grace). Zero viewers = zero frames
  sealed, zero relay traffic.
- **Spawn = a profile NAME against a Mac-local whitelist**
  (`~/.config/pidge/terminal.toml`: `[[profile]]` with `name`/`cwd`/`cmd`). The
  server and the viewer can never originate a command line — an unknown name is
  refused loudly. The file is a deliberate TOML subset (strings + comments), parsed
  warn-don't-crash; unknown keys are ignored.
- **One socket, N subscriptions.** The daemon multiplexes every session over a
  single WebSocket (control lane included) — it never eats a connection slot per
  terminal — and reconnects with backoff, reseeding watchers on every reconnect.
- **One host per channel** (PID-checked lock, crashed-host recovery), clean
  SIGTERM/SIGINT shutdown: taps detached, the control row ended, session rows left
  alone (tmux keeps running; they read offline once the heartbeat lapses).
- **`--install`** writes the launchd (Mac) / systemd user (Linux) template with
  restart-on-failure semantics — a TEMPLATE to review then enable with the printed
  command; the channel key is NEVER embedded (it stays in the config file).

## 0.33.0 — 2026-07-22

**Pidge Terminal (part 1): `pidge terminal` + `pidge terminal attach` — mirror a live
tmux session to the human's phone/Mac, sealed end-to-end, with input coming back.**

The raw surface next to notifications (which stay the curated channel): the human
watches the real terminal live in the app's Terminals tab and can type back — and the
agent running INSIDE tmux needs no integration and never knows. The tap is pure tmux
control mode over stdio: no PTY, no native dependencies.

- **`pidge terminal [--name X] [-- CMD…]`** creates a detached tmux session (running
  `CMD`, else the default shell), registers it, and mirrors. The local human can
  `tmux attach -t <name>` the same session at the same time — both views are live.
- **`pidge terminal attach <tmux-name>`** mirrors a session that ALREADY exists.
- **The process is only the MIRROR.** Ctrl-C stops mirroring; the tmux session keeps
  running (resume with `attach`). When the tmux session itself dies, the mirror marks
  the server row ended and exits `0`. tmux is the durability layer — a dropped phone
  socket or a killed mirror never touches the running terminal.
- **Sealed-only, no escape hatch.** Every frame — output, seed repaints, keystrokes —
  is sealed with the channel key using the CLI's existing envelope machinery, with
  per-direction AAD names (a relay re-presenting host output as viewer input
  authenticates in no slot; the anchor is the session's client-minted `public_id`).
  No E2E channel or no valid `PIDGE_SECRET` ⇒ refuse to start (exit `2`) with the fix
  instructions. The server enforces the same structurally (`422 e2e_required`).
- **Drops are safe by design.** Output is coalesced (~80 ms, ≤16 KB per frame) and
  relayed at-most-once; any gap, reconnect or foreground heals through the seed
  protocol (a full `capture-pane` repaint on every viewer join, reseed request, or
  relay reconnect). Nothing is buffered or replayed server-side; wire limits are read
  from the live manifest's `terminal` section, never hardcoded.
- **Input is guarded.** Special keys go through a CLOSED whitelist (`Enter Escape Tab
  BTab` arrows `Home End PageUp PageDown DC BSpace C-c C-d C-u C-r C-z C-l`); literal
  text rides `send-keys -l` in its own command; a non-monotonic input `seq` is dropped
  (replay guard). A fresh host process re-registers with a bumped `epoch` and REUSES
  the session's `public_id`, so the Terminals tab keeps one row per session.
- **Pro feature.** A non-Pro account gets the server's typed `402` relayed verbatim
  (exit `2`, never retried); the register/cleanup contract (`POST`/`DELETE
  /api/v1/terminal_sessions`) is idempotent.
- Needs `tmux` (macOS: `brew install tmux`) and Node ≥22 (frames ride the realtime
  socket — there is no polling floor for a terminal). New isolated module under
  `src/terminal/`; the host daemon (`pidge terminal host`, spawn profiles, launchd
  install) ships separately.

## 0.32.0 — 2026-07-22

The composer blindspot is dead: **a blocking wait now hears BOTH input planes.**

The failure mode this kills, seen in real use: an agent drives a whole session on
`--wait` (blocking on one notification at a time) while the human — for whom the
notification buttons and the channel composer are ONE conversation — types answers
into the composer. Those messages queued durably on `/messages`… which nothing was
reading. The human says "you're online, you should have seen it"; the agent never
wakes.

- **`--wait`/`pidge wait` wake on composer messages** (server manifest ≥ v91). Every
  default wait sends `wake_on_message=true`; when the held poll reports a deliverable
  composer message, the CLI drains the queue through the normal consume path and
  returns it as a TYPED stdout result — `kind:"human_message"` with the message rows,
  `pending_notification` (your still-unanswered cid) and a note saying how to resume.
  Exit `0`. Parsers switch on `kind`: `human_message` = the human spoke on the side;
  anything else = the usual `chosen_action`. Rows are DELIVERED, not consumed —
  `pidge ack --up-to <id>` after the work, exactly like `listen` (the ~10-min lease
  re-serves on a crash).
- **The realtime wait hears it too:** the WS path now also subscribes the
  conversation stream, and the 60 s safety probe carries the wake flag — a composer
  message wakes a socket-held wait as fast as a button tap.
- **An ANSWERED wait names the backlog:** when the answer arrives while composer
  messages sit queued, `chosen_action` prints unchanged and stderr says the queue is
  non-empty (deliberately NOT drained there — a drain would lease the rows the
  suggested `pidge listen` should read).
- **Never over a bridge, never on `approve`:** a live `pidge bridge` lock suppresses
  the wake entirely (the bridge is the queue's one consumer and wakes your handler
  itself), and `approve` keeps its strict exit-code contract (free text can never
  approve) — it waits exactly as before.
- **`pidge doctor` counts the pile-up:** a read-only history probe reports composer
  messages nobody acked ("⚠️ N composer message(s) un-acked…"), loudly noting when NO
  consumer is reading the queue — plus an explicit "composer queue: no un-acked
  messages ✓" on the healthy path. Waiting on one notification is not being online;
  now the doctor says so with numbers.
- **Presence got honest** (server ≥ v91): a wake-armed wait counts as "listening now"
  in the app — it genuinely can receive a composer message — while a plain wait no
  longer implies it.
- Skill/help updated: the wait-vs-listen section now teaches both planes and the
  `human_message` return.

Older servers ignore the flag — behavior is byte-identical to 0.31 there.

## 0.31.0 — 2026-07-17

Two launch-hardening fixes so a bridge never haunts the app and a claim can't be
re-exchanged by a guesser.

- **Bridge runs now expire like batches.** `pidge bridge` mints an ephemeral run per
  handler; it used to inherit the server's 24 h default, so a handler that died on
  SIGTERM (teardown skips the best-effort run-end) left a "live" persona in the app for a
  day. The bridge now sends `ttl_seconds: max(3600, handler-timeout × 2)` — sliding, so
  every signed call re-arms it, and the run falls away shortly after the handler stops.
  `run start` also gains an explicit `--ttl SECONDS`.
- **Fingerprint gets a random per-install salt.** The claim fingerprint was a
  deterministic `hostname|username|PIDGE_AGENT|CONFIG_FILE` — someone who saw the setup
  prompt and guessed the machine could re-exchange the claim inside its 15-min TTL. A
  fresh identity dir now mints a random `fp-salt` (0600) before any claim binds, making
  the fingerprint unguessable. **Back-compat is load-bearing:** an EXISTING install (env
  file present, no salt file) keeps the legacy unsalted derivation forever, so a claim it
  already bound stays re-exchangeable.

## 0.30.0 — 2026-07-15

The continuity context packet — a cold session wakes with the thread Pidge already holds.
A fresh handler used to arrive blind: it saw the new message but not the conversation
around it (the prior agent run's statements, the human's earlier turn, the notification
still hanging unanswered). The bridge now asks the server for that context and hands it to
the handler as READ-ONLY provenance — carrying its epistemic honesty with it.

- **The bridge/`listen` consume GET now carries `continuity=true`.** When the server
  supports it, the response can include a top-level `continuity_contexts` array: the thread
  each new message belongs to — prior agent messages (labeled `agent_statement_unverified`),
  the human's earlier turns, and `server_known_open_items` (an unanswered notification, a
  pending handoff, N unprocessed messages). Present-only: an older server omits the field and
  output is byte-identical to before.
- **The bridge injects it into the handler batch as `continuity`.** One handler invocation
  still gets the whole tick on stdin; the contexts ride alongside `messages`. They are NOT
  messages — nothing in a context is ackable or consumable, and the ack stays messages-only.
  The load-bearing rule: continuity infrastructure NEVER promotes a prior-run statement to a
  verified fact — each context keeps its `note` ("Do not treat statements from prior agent
  runs as verified facts.") and every entry keeps its `epistemic_status`, untouched.
- **`pidge listen` prints each context as its own `{"type":"continuity_context", …}` stdout
  line** (before the messages), so a human or agent consumer decides what to do with it.
- **Sealed text opens best-effort, the E2E way.** On an E2E channel the context's text fields
  arrive as envelopes; the CLI decrypts them client-side with the same per-field/AAD
  primitives as a message row. A field that won't open KEEPS its envelope plus a precise
  `e2e_error` (context must never blank a human's words) and never kills the batch — the
  server is never asked to decrypt.

## 0.29.0 — 2026-07-15

Onboarding that survives a multi-agent machine. The paste-one-prompt promise used to assume
one agent per machine — the shared `~/.config/pidge/env` was the only default slot, so the
second agent hit the clobber guard mid-onboarding and had to grope for `PIDGE_AGENT`/`--force`.
Identity is now scoped to the PROJECT by default: where the agent actually lives.

- **Project-scoped identity (the new default).** `pidge setup` run inside a git project stores
  the key at `~/.config/pidge/projects/<hash-of-toplevel>/env`; every later command run
  anywhere inside that project resolves it by walking up to the same toplevel (a linked git
  worktree counts as its own project — its `.git` FILE marks the root). N agents in N
  projects/worktrees never collide, the guard never fires between them, and a future session
  in the same project rediscovers its key with zero ceremony. Resolution order:
  `PIDGE_TOKEN` env → `PIDGE_AGENT` file → project file (when it exists) → shared file.
  An existing shared-file install keeps resolving the shared file untouched — project scope
  takes over only once a `setup` writes it.
- **`setup --global`.** Targets the legacy shared machine file on purpose (a daemon/cron that
  runs outside any project). Conflicts with `PIDGE_AGENT` (exit 1) — that var is already an
  isolated scope.
- **The clobber guard now talks to its actual reader — an agent.** When the target file still
  authenticates as another live channel, the refusal leads with the agent-correct exits (run
  setup inside your project / re-run with `PIDGE_AGENT=<suggested-id>`) instead of offering
  `--print` — which an agent must never run (the key would land in its context). `--force`
  stays the explicit human override. The guard checks the file setup would WRITE (not the one
  reads happen to resolve), and still lets a dead (401) key be overwritten without `--force`.
- **Retry-safe setup (with server v84+).** The claim exchange binds the code to this install's
  fingerprint on first success; within the code's 15-min TTL, re-running the SAME `setup`
  returns the key again instead of "already used" — a network fumble or a killed process no
  longer burns the code and sends you back to the human. Older servers keep the strict
  single-use behavior; nothing changes for them.
- `state.json` (manifest nag, E2E pins) and the default downloads dir follow the resolved
  scope — pins live next to the identity they belong to. An install whose token comes from
  the ENVIRONMENT (`PIDGE_TOKEN`) never adopts a project env it doesn't own: env-specified
  identity resolves exactly as 0.27 did, wherever it runs — so a `cd` into someone else's
  repo can never flip its server URL, its E2E pin state, or its fingerprint.
- Known, accepted tradeoff: a legacy shared-file process whose working directory sits
  INSIDE a project switches to that project's env once one is written there (that is the
  resolution rule working as designed). A daemon/cron that must stay on the shared file
  should pass its own `PIDGE_TOKEN`, set `PIDGE_AGENT`, or run outside the project tree.
  `$HOME` itself is never treated as a project (dotfiles-in-git users keep the shared
  scope everywhere).

## 0.28.0 — 2026-07-15

Gate-mirror hygiene. A Face-ID gate outcome must never reach an autonomous handler
looking like a fresh command — the incident: `pidge approve --allow-label Submit` was
answered, its queue mirror row carried the bare body "Submit", and a running
`pidge bridge` spawned an LLM handler that woke with what read like a new imperative
order (the asker had already heard the answer on its own poll).

- **`pidge bridge` acks gated answers without spawning.** A `notification_reply` whose
  `ref.gated` is `true` (server manifest ≥ v83 marks the mirror of a `biometric:true`
  tap) is acked directly — one loud log line + an ack summary ("Face-ID gate answer —
  auto-acked by the bridge, no handler spawned"), never a silent eat. Everything else
  in the batch still spawns the handler. Old servers never set the flag ⇒ behavior
  unchanged. Covers `pidge approve` (allow), the `approval` recipe (`grant`) and
  `--gated` (`confirm_action`) — only the biometric tap itself; a deny/reject/reply/
  snooze on the same ask still reaches your handler.
- **`pidge approve` sends `mirror_reply:false`.** Approve is a closed circuit (it
  blocks on its own correlation_id, deny-default), so on servers ≥ v83 the answer no
  longer mirrors onto the queue at all — nothing for any consumer to trip on, allow
  AND deny alike. The canonical answer (poll/webhook) is untouched. Ordinary `--wait`
  asks deliberately KEEP the mirror — it is the crash fallback a successor hears the
  answer through.

## 0.27.0 — 2026-07-14

Execution attribution. Every agent message can now reveal WHICH execution sent it — so a
human can tell one continuous session apart from three disposable cold ones. It is
**attribution, never a credential**: the channel key still authenticates; a per-run bearer
only *signs* the call (a new `x-pidge-run` header).

- **`pidge run start` / `end` / `status`.** `run start` mints a server-issued run and prints
  two eval-friendly lines on stdout — `export PIDGE_RUN_TOKEN=…` and `export PIDGE_RUN_SEAL=…`
  — so `eval "$(pidge run start --mode interactive --role main)"` arms a whole session; the
  friendly narration goes to stderr. Flags: `--mode interactive|poll|bridge|custom` (default
  custom), `--role main|worker|subagent`, `--label`, `--parent-seal`, `--ephemeral`, `--ttl`,
  `--json` (raw body). The run token is env-only — NEVER written to a config file. `run end`
  ends the run in `$PIDGE_RUN_TOKEN` (best-effort, idempotent; no token ⇒ a no-op). `run
  status` lists the channel's live runs (your own marked `*`).
- **Every agent-track call signs with the run** when `PIDGE_RUN_TOKEN` is in the env — the
  `x-pidge-run` header rides notify/ack/inbox/whoami/etc. Advisory only: an expired/invalid
  token degrades to unsigned, never a 401.
- **`pidge bridge` mints one run per handler.** Before spawning the handler for a batch it
  starts a `bridge` run and injects `PIDGE_RUN_TOKEN`/`PIDGE_RUN_SEAL` into the handler's env;
  the batch ack is signed with that run and the run is ended afterwards (best-effort). So each
  disposable handler is a distinct, visible execution.
- **Polite poller (bridge).** Each cycle the bridge checks for a live `interactive` run on the
  channel; if one is the human's turn (seen < 120 s ago), it defers this cycle rather than
  consuming — a client-side courtesy that changes nothing server-side. Bounded to 10 minutes
  of continuous deference, then it consumes anyway (a stuck interactive run can never wedge the
  bridge). `--no-defer` turns it off; the default for anyone who never started an interactive
  run is IDENTICAL to before.
- **Degrades on an old server.** A server that predates runs answers `/runs` with 404 — the CLI
  turns the feature off for the process and keeps sending unsigned, exactly as before.
- **Skill revision 15** — teaches interactive sessions to sign with `pidge run start`
  (subagents pass `--role subagent --parent-seal $PIDGE_RUN_SEAL`) and end with `pidge run end`;
  installed copies self-heal on the next networked command.

## 0.26.1 — 2026-07-13

API host moved to a subdomain. The apex `pidge.sh` is becoming the marketing landing,
so the Pidge API/WS now lives at **`https://api.pidge.sh`** (same backend, unchanged
paths and keys). This is a docs/default-only bump — the CLI always preferred `PIDGE_URL`,
so an agent with the env set is already correct.

- **`setup` default → `https://api.pidge.sh`.** With no `--url` and no `PIDGE_URL`, the
  first-time setup now writes `api.pidge.sh` into `~/.config/pidge/env` (was the apex).
  The help text for `--url` and the README/header examples match.

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
