# Changelog

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
