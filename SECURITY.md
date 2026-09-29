# Security Policy

## Scope

Code Shadow is designed as a local-first OpenCode plugin. Its SQLite database
and logs may contain project paths, tool arguments, diffs, task text, and
developer activity metadata. Treat the database as sensitive project data.

The plugin does not require a Code Shadow cloud account or API key. OpenCode
and the configured model provider remain separate trust boundaries.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.5.x | Yes |
| older releases | Best effort |

## Reporting a vulnerability

Please do not open a public issue for an undisclosed security vulnerability.
Use GitHub's private security advisory flow for this repository, or contact
the maintainer through the private contact method listed on the maintainer's
GitHub profile.

Include:

- affected version and environment;
- minimal reproduction steps;
- impact and likely attack prerequisites;
- sanitized logs or proof of concept;
- a suggested mitigation, if available.

Do not include API keys, access tokens, private source code, or a live project
database in the report.

## Security expectations

- Keep the local database outside the repository.
- Review tool-argument previews before sharing logs.
- Do not commit `.env` files, credentials, or generated databases.
- Treat provenance flags as warnings, not as a sandbox for command execution.
- Keep OpenCode and the model provider updated independently of this plugin.
