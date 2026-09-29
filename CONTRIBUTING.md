# Contributing to Code Shadow

Thank you for helping improve Code Shadow. The project is an OpenCode plugin
for AI-agent memory, observability, risk analysis, and safe task completion.

## Development setup

Requirements:

- Node.js 20+;
- Bun 1.3+ for the test runner;
- a local OpenCode installation for integration smoke tests.

Install dependencies and run the local checks:

```bash
npm install
npm run typecheck
npm run build
npm test
```

The test suite uses isolated temporary SQLite databases. Do not point unit
tests at a personal OpenCode database.

## Pull requests

Before opening a pull request:

1. Explain the user or agent workflow being improved.
2. Keep storage migrations backward-compatible and document schema changes.
3. Add or update tests for observer events, storage behavior, and agent tools.
4. Run `npm run typecheck`, `npm run build`, and `npm test`.
5. If the change affects OpenCode hooks or the TUI, run a real smoke test with
   the plugin installed in a disposable test project.
6. Update the relevant documentation and `CHANGELOG.md`.

Do not commit local databases, secrets, generated `dist/` output, or private
project data. The repository intentionally keeps the plugin local-first and
does not require API keys.

## Design principles

- Prefer explicit evidence over inferred certainty.
- Keep agent safety checks deterministic and explainable.
- Scope history and analytics to the current project whenever possible.
- Fail open for telemetry-only paths, but fail closed for explicit safety gates.
- Preserve privacy: project data belongs on the developer's machine by default.

## Commit style

Use concise, imperative commits. Conventional Commit prefixes are encouraged:

```text
feat: add project-scoped counterfactual analysis
fix: preserve evidence when a batch write fails
docs: clarify OpenCode installation
test: cover contract permission denial
```

## Reporting bugs

Include the Code Shadow version, OpenCode version, operating system, relevant
hook or tool name, sanitized logs, and a minimal reproduction. Never attach a
database containing proprietary source code or credentials.
