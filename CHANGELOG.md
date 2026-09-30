# Changelog

All notable changes to Code Shadow are documented here.

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
