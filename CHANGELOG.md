# Changelog

All notable changes to Code Shadow are documented here.

## [Unreleased]

### Fixed

- Aligns the observer with the real `@opencode-ai/plugin` 1.18.x payloads:
  `session.created` agent from `chat.message`, `session.compacted` keeps the
  session id, real error names, `message.updated` token/message metrics,
  `message.part.updated`, `file.watcher.updated` human-fix detection, and
  `client.tui.showToast`.
- Corrects tool result classification (empty success, denied, exit codes) and
  flushes the batch queue before `session.idle` counts.
- Fixes `updateTask` partial patches, retention FK cleanup, lost
  `idx_errors_file`, `getRecentSimilarChanges` bind mismatch, `flushBatch`
  poison rows and the co-change frequency/order bugs.
- Closes Change Contract bypasses: empty checks, closing violated contracts,
  completing tasks through `update`, and Windows/glob path matching.
- Replaces alphabetical analytics sampling with SQL aggregates and scopes
  memory/decisions by `project_root` (migration 008).
- Adds a real import indexer for `dependency_graph` (migration 009 indexes).
- Fixes the TUI contract for `@opencode-ai/plugin` 1.18.x: `/shadow` runs from
  the `tui.prompt.append` event, risk toasts use `client.tui.showToast`, and
  compaction resolves the project from `sessionID`. Observer and TUI `event`
  hooks now run sequentially instead of overwriting each other.
- Scopes storage analytics, the hotspots cache, analyze/context/memory tools,
  auto-memory and the TUI sidebar by `project_root`.
- Closes guardrail bypasses: `./` and `..` are normalized before contract
  matching, and `patch`/`apply_patch`/`multi_edit` are treated as mutating
  tools with targets parsed from patch text.
- Hardens Definition of Done (task-linked failures, evidence and
  contradictions without LIKE/LIMIT), verification evidence (shell command,
  masked exit codes, failure markers in output), migration fail-fast and
  terminal agent-native retention.
- Excludes LSP warnings/info/hints from `session_errors`, fixes Windows-path
  auto-memory, extends `getStats` to agent-native tables, blocks creating a
  task directly as `completed`, and fills terminal timestamps/resolution.
- Adds migration 010 enforcing natural-key uniqueness for `knowledge_nodes`
  (file nodes keyed by path, other nodes by name, scoped by project) and
  re-points edges when duplicate nodes are merged.
- Bounds previously unbounded knowledge/file-history/tool queries with safe
  defaults (5000 edits, 1000 nodes/tool calls).
- Adds `tsconfig.tui.json`, ambient TUI host shims, a `typecheck:tui` script and
  a CI step so `tui-plugin.tsx` is typechecked.
- Adds migration 011: FTS5 index and synchronization triggers for
  `knowledge_nodes`. Memory search now ranks by bm25 (name/path/metadata,
  exact-name boost, token prefixes) and falls back to LIKE for substring-only
  matches.

### Changed

- Removes the unused `src/install.ts` and duplicate `src/tui-plugin.tsx`.
- Postinstall and runtime setup now merge the TUI entry into an existing
  `~/.config/opencode/tui.json` and report failures with a non-zero exit code.
- Observer guard state is per plugin instance; loops have TTL/caps, batch and
  text fields are bounded, and retention runs every 6 hours.
- Adds a `dispose` hook, env-aware `~` resolution and lazy logger init.
- Rewrites `ARCHITECTURE.md`, `DATA_MODEL.md` and `TOOLS_API.md` for the current
  19-table schema and 16 tools; adds an entrypoint smoke harness
  (`tests/plugin-smoke.test.ts`).

## [0.5.3] - 2026-09-30

### Fixed

- Keeps targeted `edit` operations available after an agent moves from full
  rewrites to incremental fixes in the same file.
- Applies the no-progress streak threshold only to consecutive full `write`
  operations; repeated identical content remains blocked for both `write` and
  `edit`.
- Adds regression coverage for the `metadeobf.py` parser-fix workflow and for
  file paths containing `test`.

## [0.5.2] - 2026-09-29

### Improved

- Makes the successful edit-loop guard adaptive instead of counting every
  repeated file edit as a hard failure.
- Different edits remain allowed; verified test/typecheck/build progress resets
  the suspicion state, as does a new user request.
- Repeated identical content is treated as a strong loop signal.
- A long sequence of five consecutive full writes without verified progress is escalated.
- Prevents file paths containing words such as `test` from being misclassified
  as verification commands that reset the guard.
- Adds real OpenCode smoke coverage for both blocking and legitimate progress.

## [0.5.1] - 2026-09-29

### Fixed

- Detects successful `write`/`edit` loops that repeatedly rewrite one file in
  the same session.
- Emits a warning after three successful file mutations within the guard window.
- Allows different iterative edits and resets suspicion after verified progress.
- Blocks repeated identical content or a long no-progress rewrite sequence
  through the permission hook or the pre-execution hook.
- Adds regression coverage for the `collector_async.py` failure pattern.

## [0.5.0] - 2026-09-29

### Added

- Auto Plan for actionable `chat.message` requests.
- `code_shadow_counterfactual` for pre-edit impact and risk analysis.
- Project-scoped co-change history for counterfactual planning.
- Suggested verification checks based on impacted file types.
- Documentation for contributing, security, architecture, tools, and data model.

### Improved

- Agent-native operating loop now connects task planning, historical risk,
  Change Contracts, evidence, and Definition of Done.
- TUI and package metadata report version `0.5.0`.

### Verification

- TypeScript typecheck passed.
- Production build passed.
- 16 tests passed with 51 assertions.
- Real OpenCode smoke tests passed for Auto Plan and Counterfactual Planner.

## [0.4.0] - 2026-09-29

- Added the guarded agent operating loop, automatic tasks, evidence capture,
  Definition of Done, permission hard gate, and contract enforcement.

## [0.3.0] - 2026-09-29

- Added agent-native task, evidence, failure, contract, provenance, contradiction,
  and handoff storage.
