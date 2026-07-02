# Changelog

## 0.17.1 — builtin/system action labels never seal (#313)

- **fix (send, E2E):** the label of a custom action whose id is a builtin or
  system id — the server's 12 built-ins + `dismiss` + `acknowledge`
  (`Notification::RESERVED_ACTION_IDS`) — is NEVER sealed. Clients treat these
  ids as built-ins and SKIP label decrypt for them, so a sealed label (possible
  pre-fix only with id `acknowledge`, which the server didn't reject until
  manifest v52 closed the collision) would render raw `v1:…` on the button.
  Action IDs already rode clear; E3 will seal only CUSTOM labels. The never-seal
  list is exported (`E2E_NEVER_SEAL_LABEL_IDS`) and pinned by test to match the
  server's list.

## 0.17.0 — E2E v1 ON THE WIRE (#43, phase E2-CLI): sends seal, listen/wait decrypt

The send/receive wiring of end-to-end encryption (contract: `e2e-spec-v1.md`; server
manifest **v49** notifications passthrough + **v51** sealed `/messages`). With
`PIDGE_SECRET` configured and the channel E2E, content leaves the machine as ciphertext
the server cannot read, and sealed answers/messages decrypt back to plaintext locally.
Includes the E0 crypto lib + shared fixture (below), previously unreleased.

- **feat (send):** with a valid `PIDGE_SECRET` (same slot/precedence as `PIDGE_TOKEN`;
  the pair travels together) AND `e2e_enabled` on the channel (whoami says — never a
  guess), EVERY send path (`message/important/urgent/event/live`, `ask`, `approval`,
  `approve`, `hello`, deprecated `notify/send`) seals `title`/`subtitle`/`body`/
  `body_markdown` + **custom-action LABELS** (`action_label_<id>`; action IDs stay
  clear) and rides `enc:"v1"` + `kf` alongside. The `correlation_id` is ALWAYS minted
  client-side under E2E (the AAD needs it before the server sees the payload). No
  secret / non-E2E channel / whoami unreachable ⇒ the clear send of always — a missing
  secret must NEVER block a notification (the app marks it "⚠️ sem criptografia"). An
  INVALID secret warns loud and degrades to clear. Media note: `--image`/`--file` bytes
  + filename still ride CLEAR (phase E3) — narrated on stderr when sealing.
  The 201/upsert echo on stdout shows OUR OWN envelopes **decrypted for display**
  (trust-the-echo keeps meaning something; `enc`/`kf` stay printed as the wire truth).
- **feat (receive):** every read gates on the EXPLICIT `enc` flag — never on sniffing
  the `v1:` prefix. `listen` (WS and polling paths) opens sealed `kind:"message"` rows
  (E1.5: field ALWAYS `"message"`, AAD `ch<channel_id>:<correlation_id>:message` — the
  cid comes on the row) and `notification_reply` rows whose `ref.enc` is set (text =
  field `"reply"` with `ref.correlation_id`; `ref.title` = field `"title"`; a body that
  mirrors a custom-action label = `action_label_<action_id>`). `wait`/`ask`/`approve`/
  `hello` open the poll's `chosen_action` (text = `"reply"`, custom label =
  `action_label_<id>`) — the poll payload has no channel id, so whoami resolves it once.
  On success the plaintext replaces the ciphertext and `enc`/`kf` become
  `e2e:"decrypted"`; rows WITHOUT `enc` render exactly as before (pre-E2E history stays
  clear — honest degradation).
- **feat (precise errors — never garbage):** a sealed thing the CLI can't open is
  BLANKED (`body`/`text` → `null` + `e2e_error`) with ONE precise stderr line per
  distinct reason — base64 never reaches the terminal (follow-up A1). The reasons are
  named: **kf mismatch** ("sealed with ANOTHER key", both fingerprints shown — the
  token-of-one-channel + secret-of-another mixup), **enc without correlation_id**
  (server predates E1.5 / bug), **unknown envelope version**, **no (valid)
  PIDGE_SECRET**, and a failed tag. A NON-envelope value inside a sealed context is
  readable text and passes through (a built-in action label, or a clear reply typed on
  a pre-E2E app — the same accept-and-mark honesty the iOS app shows).
- **feat (doctor):** validates `PIDGE_SECRET` when present (base64url, exactly 32
  bytes; narrates the kf = `base64url(SHA-256(key)[0..3])`, never the secret) and
  crosses it with the channel: `e2e_enabled` + no secret → points at re-running the
  setup prompt (warning); secret + non-E2E channel → ORPHAN-secret warning; E2E channel
  + invalid/mismatched secret → **BROKEN, exit 2**. The stdout JSON gains
  `e2e: {channel, secret, kf}`.
- **feat (setup):** the `{TOKEN, SECRET}` pair travels together — `setup --claim`
  persists `PIDGE_SECRET` from the environment (the human's setup prompt embeds it)
  next to the token in the config file, and `--print` emits the
  `export PIDGE_SECRET=…` line alongside the other two. A secret already in the file
  is never silently dropped on a re-claim.
- **test:** `test/e2e-wire.test.js` — 17 wire tests against the mock server: sealed
  send (envelopes + enc/kf/cid + clear IDs + echo decrypt), the three clear-send
  degrades, sealed-message listen, `--all` reply-ref decrypt (text/title/label +
  narration), chosen_action decrypt (text, custom label, built-in passthrough), the
  precise-error matrix (kf mismatch, missing cid, unknown version, missing secret),
  and the A1 safety net (an unattributable envelope is blanked, never printed). The
  frozen fixture (`test/e2e_vectors.json`, sha `7bdacd01…`) is untouched; the mock
  gains `e2e_enabled` on whoami + the prod-shaped 201 content echo.
- **docs:** README E2E section + `PIDGE_SECRET` in `--help`'s ENV;
  `KNOWN_MANIFEST_VERSION` 46 → 51.

### E0 (#180), first released here: crypto lib + shared test vectors

The first increment of E2E encryption (contract: `e2e-spec-v1.md`, ratified 2026-07-02) —
the pure primitives + the cross-repo fixture the wiring above builds on.

- **feat (E0):** AES-256-GCM primitives inside `bin/pidge.js` (single-file, Node `crypto`
  only — zero new deps): `e2eEncryptField`/`e2eDecryptField` (`"v1:" + base64url(nonce ||
  ct || tag)`, one independent envelope per field), `e2eEncryptBlob`/`e2eDecryptBlob`
  (binary framing `[0x01][nonce][ct][tag]`, no base64), `e2eAad`
  (`ch<channel_id>:<correlation_id>:<field_name>` — anti-swap binding),
  `e2eKeyFingerprint` (`kf` = 4 bytes of SHA-256(key), base64url) and `e2eLoadSecret`
  (`PIDGE_SECRET` from the SAME slot/precedence as `PIDGE_TOKEN`: env wins over the
  per-agent-aware config file — wired into the commands by E2-CLI above). Decrypt fails
  LOUD and precisely:
  wrong AAD/corrupted tag, unknown version prefix (`v9:`), invalid base64url, wrong sizes.
  The nonce is `crypto.randomBytes(12)` in production; injectable ONLY for the fixture.
- **test (E0):** `test/e2e_vectors.json` — the SHARED deterministic fixture (committed
  byte-identical in the product repo too; server/iOS assert the SAME bytes — the cross-SDK
  gate) + its generator `test/gen-e2e-vectors.js` (not published). Cases: short field,
  unicode/emoji, >10 KB markdown, small binary blob, reply, wrong AAD, corrupted tag,
  unknown version, kf mismatch. `test/e2e.test.js` round-trips every vector, asserts every
  failure case, pins the fixture against drift, and covers `e2eLoadSecret` precedence.
  A require() test seam exports the pure helpers without running the CLI (`require.main`
  guard) — executing `pidge` as a binary is byte-for-byte unchanged.

## 0.16.1 — hardening lote (#38 #39 #40 #41): atomic self-heal, NaN fail-closed, CI, docs

Coordination-review batch (2026-07-01): two proven correctness holes closed, the repo's
first CI, and the docs reconciled with what 0.16.0 actually does.

- **fix (#38):** the skill self-heal is now ATOMIC — `SKILL.md` is written to a per-process
  tmp file + `renameSync`, so a killed process/full disk leaves the old skill intact and
  concurrent heals can't tear each other. The marker scan is ANCHORED (line 1 or inside the
  opening frontmatter block) — body prose like `pidge-skill rev=99` can't suppress a heal.
  Every generated skill now ends with a `<!-- pidge-skill-end -->` trailer: a marker without
  the trailer = a TORN write, detected and re-healed (pre-#38 it read as "fresh" forever).
  Overwriting a differing `SKILL.md` saves `SKILL.md.bak` + one stderr line — customizations
  are never clobbered silently. `SKILL_REVISION` 3 → 4.
- **fix (#39):** `--timeout`/`--interval` typos no longer hang the blocking commands FOREVER.
  `parseInt('abc')` → NaN made `doWait`'s deadline unreachable, so wait/ask/approve/hello/
  listen polled eternally and `approve`'s deny-default timeout branch was dead code. Now an
  unparseable value dies immediately (exit 1, fail-closed) BEFORE anything is sent — no ghost
  approval on the phone. `approve` also traps SIGINT → exit 1 with the deny-default narration.
- **ci (#40):** first CI — GitHub Actions runs `npm ci && node --test` on Node 18/20/22 for
  every push to main + every PR (no secrets; the suite uses the local mock server).
- **docs (#41):** the README showcase `ask --actions yes,no,reply` (broken since 0.16.0's
  decision+reply refusal) is fixed; `pidge approve` is documented (commands table, quick-start,
  "New in" banner through 0.16.x); the env TRUST CAVEAT is spelled out in `--help` and README
  (the gate is only as trustworthy as `PIDGE_URL`/`PIDGE_TOKEN`); the approve exit-code doc now
  tells the truth (HTTP failure on the send → 1; ONLY a raw network error → 2); the GitHub repo
  description no longer says "Herald". Two docs-drift guard tests keep it that way.

## 0.16.0 — #34 `pidge approve` (hook-shaped gate) + lote-5 polish

**`pidge approve "<question>"`** — a new, hook-shaped permission gate for wrapping an agent's
OWN risky actions behind a human Face-ID tap. It sends an important/sensitive notification with
two gated custom actions (`allow` = Face-ID confirm, `deny` = destructive), blocks on the same
long-poll as `pidge ask`, and maps the answer to an **exit code, DENY-DEFAULT**: only an explicit
`allow` is exit 0; deny, timeout, a dead channel, or any ambiguity is non-zero — so a Claude Code
`PreToolUse` hook fails CLOSED. `chosen_action` JSON is printed to stdout. Zero server change (a
thin wrapper over the existing send + wait). `--help` documents a runnable `PreToolUse` hook.

- **feat (#34):** `pidge approve` verb + `--allow-label`/`--deny-label`. `doWait`/`realtimeWait`/
  `waitForAnswer` gained optional `onAnswer`/`onTimeout` callbacks so a caller can map the
  outcome to an exit code instead of the default print-and-exit-0.
- **feat (lote-5 #2):** the CLI now REFUSES a decision button + `reply` in one send (e.g.
  `--actions yes,no,reply`) — exit 1, no round-trip. The human would tap the easy Yes/No and you'd
  get a useless "Yes" instead of the typed text (the skill's anti-slop rule #4, now enforced).
  `reply` alongside a non-decision (e.g. `done,reply`) stays allowed.
- **fix (lote-5 #3):** `pidge <type> --help` no longer prints a bare, description-less `template`
  line (`template` is intentionally off the menu; it stays a silent back-compat input).
- **feat (lote-5 #4):** `setup --quiet` collapses onboarding to a single status line (the full
  doctor stays the default; `--quiet` is opt-in and never hides a broken setup — warnings/errors
  still print).
- **feat (lote-5 #5):** `listen --all` now WARNS when its first quick batch is old backlog
  ("N message(s) were ALREADY queued when this listen started … NOT fresh arrivals"), so a
  resurfaced notification answer isn't mistaken for a new event. Within-channel — NOT the
  cross-channel leak (#289).
- **note (lote-5 #1):** the `ask`/`wait` fallback poll cadence is already 30 s (aligned to the
  server's suggestion); `--interval` still overrides. No change needed.
- **chore:** `SKILL_REVISION` 2 → 3 — the installed skill spine now teaches `pidge approve` and
  the decision-vs-reply refusal, so onboarded agents self-heal to it on their next command.

## 0.15.3 — #33 fix: the self-heal marker no longer corrupts the skill

The 0.15.2 marker was written as the FIRST line of `SKILL.md`, ABOVE the opening `---`. A
SKILL.md whose first line isn't `---` fails Claude Code's YAML frontmatter parse: the skill
still appears, but with a GARBAGE description (the HTML comment leaks in as the description and
the real `name`/`description` are lost) — so the agent's Claude Code never learns WHEN to use
Pidge. Verified on a live headless `claude` run: a marker-first probe skill loaded with its
description showing `<!-- pidge-skill … -->` instead of its real text, while an identical
`---`-first control loaded correctly.

- **fix:** the marker now rides a `# pidge-skill rev=R manifest=N` YAML COMMENT INSIDE the
  frontmatter (a `#` comment is valid YAML and invisible to `name`/`description`), so the
  frontmatter opens on line 1 and parses cleanly while the marker still travels with the file.
- **fix:** `ensureSkillFresh()` reads the marker from its new in-frontmatter position and still
  tolerates the old line-1 `<!-- … -->` marker, so a 0.15.2 install is detected as stale.
- **fix:** `SKILL_REVISION` bumped 1 → 2, so every 0.15.2 install (all rev=1, all broken) is
  seen as stale and self-heals into the corrected format on the next command — zero human action.

## 0.15.2 — #280 the skill self-heals

#280 — the local skill self-heals: any pidge command silently refreshes
`.claude/skills/pidge/SKILL.md` when the skill revision or manifest version is newer than
what's installed, so onboarded agents always run the latest skill.

- **feat:** a bumpable `SKILL_REVISION` constant + the live manifest version are baked into a
  first-line marker (`<!-- pidge-skill rev=R manifest=N -->`) of every generated `SKILL.md`.
  `ensureSkillFresh()` (run from `checkManifestNews`, which already fires on every command via
  the `x-pidge-manifest-version` header) compares the installed marker against this CLI's spine
  and the server's manifest; when either is newer it silently regenerates the skill and prints
  one stderr note. Only an EXISTING skill is refreshed (never auto-created), at most once per
  process, fully best-effort (a refresh failure never breaks your command), and `QUIET_NAG`
  suppresses the note (the regenerate still happens).
- **note:** this composes with `@latest` — an agent on `npx pidge-cli@latest` picks up a new
  `SKILL_REVISION` and self-heals the spine on its next command. A PINNED CLI still self-heals
  on a server manifest bump (via the header) but can't gain a newer hand-authored spine without
  updating the CLI. BUMP `SKILL_REVISION` in any future sprint that edits the SKILL.md spine.

## 0.15.1 — #274-D skill polish

skill polish — catalog-first actions, write-for-the-lock-screen (banner = title+body; body_markdown is detail-only), good-report guidance; gold examples now set a plain --body.

## 0.15.0 — #274 CLI redesign (F1)

-m/--body-markdown-file input chain, --gated, English hello, --template off the help menu (still accepted), nag knows v46, --wait defaults to 60 min for decisions.

F3/F4: skill rewritten (two approval paths, English gold examples, no content_template menu, appendix from v46); setup → skill → hello fuse with graceful-degrade.

## 0.14.0 — 2026-06-28

The married vocabulary (perfis) — the CLI now speaks the SAME language as the server
(manifest v42) and the app: ONE list of 5 message types, with RESPONSE as a separate
axis. No scripts break — the old names keep working as aliases.

- **feat:** the typed sends are renamed to the canonical 5 — `pidge message` ·
  `important` · `urgent` · `event` · `live` (message←fyi, important←report, urgent←alert;
  event/live unchanged). `important` is the recommended default. The wire sends the new
  `template_kind`. (perfis-S1)
- **feat (compat):** the OLD names still work as aliases — `pidge fyi`→message,
  `report`→important, `alert`→urgent — mapped to the new type, with a one-line rename
  note on stderr. Muscle-memory and existing scripts are untouched. (perfis-S1)
- **feat:** RESPONSE is now its own axis, composing on ANY type — `--actions`/
  `--custom-action` (buttons) + the new **`--wait`** (block until the human answers,
  then print `chosen_action` JSON; without it = fire-and-forget). This is the explicit
  "send-and-go vs wait". (perfis-S2)
- **feat:** `pidge ask` is now the shortcut for `important --wait` (still REQUIRES a way
  to answer; preserved behavior). There is no `ask` TYPE in the married catalog — asking
  is a type + buttons + wait. (perfis-S2)
- **feat:** `pidge approval` — a new go/no-go RECIPE = `important` + Approve/Reject +
  Face ID on Approve + `--wait`. Sent as `custom_actions` (only custom actions carry
  `biometric`, and a custom id can't reuse a built-in like approve/reject — so the ids
  are `grant`/`deny`). Pass your own `--actions`/`--custom-action` to override the
  pair. (perfis-S2)
- **docs:** USAGE, per-command help and the generated `SKILL.md` rewritten around the two
  axes (type + response) — mirrors the human's app, drops the dead fyi/report framing.
- **chore:** `KNOWN_MANIFEST_VERSION` 36 → 42 (the live server), silencing the news nag.

## 0.13.1 — 2026-06-26

Polish from an agent E2E (2026-06-26). No breaking changes.

- **fix:** the manifest-version nudge no longer scolds "your CLI is stale, UPDATE it".
  pidge is a thin pipe — `--param KEY=VALUE` carries any new `/notify` field NOW, so a
  server manifest bump almost never needs a CLI release. The nudge is reframed as "new
  capabilities + how to use them today" and `KNOWN_MANIFEST_VERSION` is bumped 31 → 36
  (the current server), silencing the false-positive on `@latest`. (#26)
- **fix:** the public manifest (#249-A) curl in that nudge drops the mandatory Bearer —
  the catalog reads without a key; the Bearer is shown only as the optional way to also
  see the channel's own config. (#26)
- **fix:** the realtime reconnect log no longer reads "realtime socket **socket** closed"
  (doubled word) and the counter no longer sticks at "attempt 1/4" — it now shows a
  monotonic "reconnect #N" so a connect→drop flap visibly advances instead of looking
  like a stuck loop. (#25)

## 0.13.0 — 2026-06-25

Template system (#246) — the agent now declares an intent TYPE; the server maps it to
the human's delivery profile (the human never sees the type). Soft-rollout: typeless
sends still work in 0.13.x (server falls back to `fyi`); 0.14 will require a type.

- **feat:** 6 type subcommands — `pidge fyi` · `report` · `ask` · `event` · `alert` ·
  `live`. Each stamps `template_kind` on the `/notify` payload. fyi/report/event/alert/
  live are fire-and-forget (like `notify`); `ask` send+waits for the answer. (#246)
- **feat:** `pidge notify` (and `pidge send`) is **deprecated** with a local warning —
  it still works for one minor (0.13.x; the server falls back to `fyi`) and will 422 in
  0.14. Use a typed send instead. (#246)
- **feat:** local validation before the round-trip — `ask` requires a way to answer
  (`--actions`, `--custom-action`, or a `--template` that supplies them); `event`
  requires a valid ISO8601 `--event-at`. Friendly exit-1 errors, nothing sent. (#246)
- **feat:** `alert --escalate` adds `escalate: true` (ask the Urgente profile for an
  AlarmKit alarm that breaks through silent/Focus; the human's profile decides). (#246)
- **feat:** an unknown subcommand now points at the type catalog instead of dumping the
  whole USAGE; `pidge <type> --help` shows each typed send's own flags. (#246)
- **docs:** `pidge skill install` writes a **"Choose the right type"** catalog table
  into the generated `SKILL.md`. (#246)

## 0.12.0 — 2026-06-25

CLI bugs batch, all reported by an agent in real production use. No breaking changes.

- **fix:** `pidge <sub> --help` shows the SUBCOMMAND's own help (its synopsis + own
  flags), not the global USAGE dump — e.g. `pidge ask --help` now leads with ask's
  `--actions`/`--timeout` instead of burying them. `pidge --help` and `pidge help`
  still show the full command overview; `pidge help <cmd>` is the focused form. (#240)
- **feat:** the "server has new capabilities" manifest-version nag is throttled to
  **once per 24 h** (cached in `~/.config/pidge/state.json`, per-agent when
  `PIDGE_AGENT` is set) and only re-fires when the server version actually changed —
  no more a nag on every call. New `--quiet-nag` flag and `PIDGE_QUIET_NAG=1` env to
  silence it entirely (scripts/CI). (#241)
- **feat:** `--actions` accepts a **JSON array** of custom `{id,label,…}` actions for
  custom labels — `--actions '[{"id":"approve","label":"Aprovar agora"},{"id":"defer","label":"Deixa pra amanhã"}]'`.
  A leading `[` selects JSON; bad JSON / a missing `id`/`label` is a friendly LOCAL
  error (exit 1, nothing sent). The short form `--actions yes,no,reply` is unchanged,
  and JSON composes with `--custom-action`. (#242)
- **docs:** the manifest re-read instruction (the version nag) now shows the
  **authenticated** curl — `curl -H "Authorization: Bearer $PIDGE_TOKEN" $PIDGE_URL/api/v1/manifest`
  — so an agent that follows it doesn't take a 401. (#243)
- **docs:** `pidge skill install` now writes an **"always-on for turn-based agents"**
  recipe into the generated `SKILL.md` — an interactive listening window
  (`pidge listen --follow`) and a no-daemon supervisor poll (looped one-shot
  `pidge listen`). (#244)
