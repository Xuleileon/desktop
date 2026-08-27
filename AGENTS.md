# Browser Use Desktop Agent Notes

## Local Dev Profiles

- The app's runtime database lives under Electron `userData`, not under the git
  worktree. Do not assume the default profile when working across branches.
- Use `task worktree:profile:path` to get this branch's isolated profile path.
  It resolves to `.task/user-data/<current-branch>` by default.
- Use `task worktree:up` to start the app against that isolated profile.
- Use `task worktree:profile:clean FORCE=1` to delete this branch's isolated
  profile after quitting the app.
- Use `task db:worktree:copy FROM=default` to copy `sessions.db` from the
  platform default profile into this branch profile. Pass `FROM=branch:<name>`
  to copy from another branch profile, including branch names with `/`. Use an
  absolute path, `./relative/path`, `~/path`, or `FROM=path:<path>` for explicit
  filesystem paths. Pass `FORCE=1` if the target DB already exists.
- Use `task db:worktree:doctor` after copying or when local task runs fail. It
  compares the target `sessions.db` schema version and schema ID against the
  current checkout's `src/main/sessions/schema-manifest.json`.
- If the app was launched with `AGB_USER_DATA_DIR`, run `task agent:run` with
  the same `AGB_USER_DATA_DIR`. The local task runner reads
  `<userData>/local-task-server.json`; pointing the CLI at a different profile
  will miss the running app even if `sessions.db` is valid.
- Quit the app before copying or cleaning profile files. SQLite WAL files and
  Electron runtime files can be open while the app is running.

## Session Schema Changes

- `DB_SCHEMA_VERSION` gates migrations at runtime.
- `src/main/sessions/schema-manifest.json` tracks the expected fresh schema ID
  for CI/main drift detection.
- Run `task db:schema:check` after touching `SessionDb` migrations.
- Run `task db:schema:update` only after an intentional schema change.

## Windows CDP and Harness Ownership

- `AGB_CDP_PORT` is only a requested port, not proof that Chromium bound it.
  Reject occupied and Windows-excluded ports before Electron starts, then
  verify `/json/version` belongs to this exact Desktop instance before opening
  auth sync or handing `BU_CDP_PORT` to any engine.
- Never let a task start with an unverified, unreachable, or foreign CDP
  endpoint. A clear preflight failure is safer than giving an agent access to
  another Chrome profile or leaving it to loop on a dead port.
- `browser-harness-js` is owned by one engine run. Preserve it across commands
  within that run, but stop its per-session REPL when the engine exits so
  reruns cannot accumulate detached Bun processes.
