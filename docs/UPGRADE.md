# Upgrading Code Shadow

This page covers the steps that are easy to miss after pulling a new version:
the OpenCode host reload, the instruction file it reads, the installed TUI
adapter, and the shadow database.

## Reproducible installs

`package-lock.json` is tracked in git and **must stay committed**. CI installs
dependencies with:

```bash
npm ci --ignore-scripts
```

`npm ci` refuses to run when the lockfile is missing or out of sync with
`package.json`, so a dependency change without a lockfile update fails the job
before typecheck. After editing dependencies run:

```bash
npm install --package-lock-only --ignore-scripts
```

Commit the resulting lockfile with the manifest. Do not replace the CI install
step with `bun install`: Bun is used to run the tests, while npm owns the
lockfile and the reproducible install.

## After an update

1. Upgrade the plugin (for example
   `opencode plugin https://github.com/xuviga/code-shadow-ai-agent-observability --global --force`,
   or `npm install` in a local checkout).
2. Run `opencode reload`, or fully restart OpenCode. Plugin and TUI modules are
   loaded at startup, so an in-place package update is not visible until the
   host reloads.
3. Run `npm run doctor` and review its `WARN`/`FAIL` lines.
4. Open a new session and confirm that the Code Shadow sidebar is present.

OpenCode 2 reads project rules from `~/.config/opencode/AGENTS.md`; OpenCode 1
read `~/.config/opencode/CRUSH.md`. Code Shadow keeps the same
`<!-- CODE_SHADOW_START -->` / `<!-- CODE_SHADOW_END -->` block in both files.
After an upgrade, verify that the file used by your host still contains exactly
one such block — a duplicated block means the old rules were not replaced.

## Doctor

```bash
npm run doctor
```

The doctor is read-only and has no extra dependencies. It prints one
`PASS`/`WARN`/`FAIL` line per check and exits non-zero only when a `FAIL` is
present. `WARN` means the environment is usable but incomplete, for example the
plugin has not run yet and the database does not exist.

It checks:

- `package.json`: `main` is `src/index.ts`, and `exports` contains `.`,
  `./v1`, `./v2`, `./tui`, `./tui-v1`;
- `AGENTS.md` and `CRUSH.md`: exactly one Code Shadow marker block each (a
  missing file is a warning);
- `tui.json`: exactly one `./plugins/code-shadow/tui-v2.ts` entry and no legacy
  `./plugins/code-shadow/tui-plugin.tsx`;
- the installed `~/.config/opencode/plugins/code-shadow/tui-v2.ts`;
- the shadow DB at `~/.config/opencode/shadow/data.db`: `schema_version` is at
  least 13, plus counts for `turn_completed`, `tool_warning`, `tool_rejected`,
  blocking `tool_rejected`, `file_edits`, and `tool_executions` over the last
  24 hours.

The DB is opened read-only through `node:sqlite`. If the running Node version
does not provide it, DB checks are skipped with a warning and the remaining
checks still run.

The doctor also warns about the V2 telemetry symptom: mutating tool calls in
the last 24 hours with zero `file_edits`. That usually means V2 events are not
being translated into the V1 observer path; use the log below.

## Logs

After the reload, inspect `~/.local/share/opencode/log/code-shadow-v2.log`:

- `registered <hook>` lines for each guard hook;
- `v2 event subscription (14)`;
- `v2 registry (17)`;
- no repeated event-translation errors or stack traces.

If the sidebar is missing, also check
`~/.config/opencode/shadow/tui-debug.log` and confirm that the installed
`tui-v2.ts` exists. `npm run doctor` covers the config and file checks.

## OpenCode 1 package-root users

The package root (`.`) now resolves to the OpenCode 2 entry point
(`src/v2.ts`). OpenCode 1 users who previously loaded the package root must
point the plugin at the `./v1` subpath, which maps to `src/index.ts`, for
example `opencode-code-shadow/v1`, or pin a version from before the V2 root
entry was introduced. The `./v1` entry keeps the OpenCode 1 hook API.

## Database

Migrations run automatically when the plugin starts. The doctor only reads
`MAX(version)` from `schema_version`. If it reports a version below 13, start
OpenCode once so migrations 013 and later are applied, then rerun
`npm run doctor`. Do not open the database read-write while OpenCode is
running; the doctor already opens it read-only.
