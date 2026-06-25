# Changelog

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
