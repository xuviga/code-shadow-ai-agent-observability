# Changelog

All notable changes to Code Shadow are documented here.

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
- 14 tests passed with 45 assertions.
- Real OpenCode smoke tests passed for Auto Plan and Counterfactual Planner.

## [0.4.0] - 2026-09-29

- Added the guarded agent operating loop, automatic tasks, evidence capture,
  Definition of Done, permission hard gate, and contract enforcement.

## [0.3.0] - 2026-09-29

- Added agent-native task, evidence, failure, contract, provenance, contradiction,
  and handoff storage.
