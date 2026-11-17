# API инструментов Code Shadow

> Актуально на v0.5.3 (17.11.2026). 18 инструментов;
> исполняемый источник — `src/tools/*.ts`. Все инструменты возвращают
> `{ output: string }`; в норме `output` — JSON, но `analyze`,
> `memory_write` и `memory_note` при внутренней ошибке могут вернуть plain
> text с `❌`.

## Общие правила

- `project_root` опционален: если не передан, берётся из сессии, `context.directory`,
  `context.cwd` или `process.cwd()`. `code_shadow_analyze` резолвит его так же
  и передаёт во все режимы; `code_errors` использует `target || project_root`.
- `limit` — число; отрицательные значения не валидируются на уровне Zod.
- Память и ADR поддерживают project scope: строки с `project_root = NULL`
  (legacy/global) видны во всех проектах.
- Governance-инструменты не проверяют принадлежность `task_id`/`contract_id`
  проекту при update-операциях (осознанное ограничение текущей версии).

## Память (3)

### `code_shadow_memory_write`
```json
{ "category": "ARCHITECTURE", "content": "Storage uses bun:sqlite WAL", "project_root": "C:/project" }
```
`category`: `PROJECT_RULES | ARCHITECTURE | CONSTRAINTS | CONFIG_VALUES | NAMING`.
Маппинг в `node_type`: rule / concept / rule / concept / pattern. Content
санитизируется, теги извлекаются из исходного текста, узел upsert-ится в рамках
проекта.

### `code_shadow_memory_search`
```json
{ "query": "sqlite", "sources": ["memory", "decisions"], "limit": 10, "project_root": "C:/project" }
```
`sources`: `memory | decisions | file_history | analytics` (по умолчанию все).
`memory` ищет через FTS5 + bm25 по `name/path/metadata` (префиксы токенов, буст
точного имени) с LIKE-fallback для подстрочных совпадений; `decisions` — по
title/description; `file_history` — по путям; `analytics` читает project-scoped
ключи `hotspots:<project>:*`. Пустой `query` включает flood-режим для memory,
но не для decisions.

### `code_shadow_memory_note`
```json
{ "content": "Проверить миграцию 011 на старой БД", "surface_condition": "next session" }
```
Создаёт узел `note` с `status=active`. `surface_condition` сохраняется, но
планировщика поверхностного показа пока нет.

## Аналитика (1)

### `code_shadow_analyze`
```json
{ "query": "predict_change", "target": "src/storage.ts", "timeframe": "30d", "project_root": "C:/project" }
```
| query | target | Результат |
|---|---|---|
| `hotspots` | — | score 0–100 по частоте/ошибкам/недавности/откатам |
| `predict_change` | путь | riskScore 0..1, affectedFiles (≤20 co-changed), breakage rate |
| `file_history` | путь | edits + timeline 7d/30d/90d/all из полной истории |
| `team_pulse` | — | health, trend, aiRelianceRatio, errorRate, modules |
| `my_stats` | — | sessions/day, top files, AI reliance, fix rate, tool usage |
| `dependency_graph` | путь | import edges (ленивая индексация до depth 5), co-change, типы узлов |
| `knowledge_search` | запрос | узлы памяти + ADR в рамках проекта |
| `decisions_list` | статус (необяз.) | ADR проекта, `limit` |
| `code_errors` | project root (необяз.) | агрегаты LSP-ошибок (warnings не входят) |

`predict_change` пока использует окно 30 дней для breakage/recent независимо от
`timeframe`; кеш `hotspots` привязан к `project_root`.

`timeframe`: `7d | 30d | 90d | all`; `depth` для графа — 1..5.

## Контекст (1)

### `code_shadow_context_inject`
```json
{ "focus": "observer", "include": ["architecture", "conventions", "hotspots", "recent_changes", "decisions", "agent_state"] }
```
Возвращает готовый текст: архитектура/конвенции (project-scoped узлы), hotspots
(свежий кеш `hotspots:30d:*` или fallback), последние правки, ADR, состояние
агента, focus-секцию.

## ADR (1)

### `code_shadow_decide`
```json
{ "title": "Use WAL", "description": "Concurrent reads", "alternatives": ["DELETE journal"], "status": "accepted", "related_files": ["src/storage.ts"], "project_root": "C:/project" }
```
Пишет `decisions`, узел `decision`, файловые узлы и `references`-рёбра.
`alternatives`/`related_files` санитизируются, массивы ограничиваются по длине.

## Proof-Carrying Change (1)

### `code_shadow_passport`
Actions: `open | add | seal | get | list | review | verify | export | claim | release | claims`.

Паспорт изменения — единый проверяемый пакет: intent, файлы и их хеши,
almost-right findings (пустые catch, отключённые тесты, `|| true`, `as any`,
SQL DROP/DELETE без WHERE), Change Contract, verified evidence, открытые
failures/contradictions, разрушительные shell-команды, file claims, бюджет
токенов, risk-score, hash-chain (`prev_hash`) и готовый review Markdown.

- `open` требует `intent`; `files` и `budget_tokens` опциональны.
- `seal` собирает доказательства, блокирует при отсутствии verified evidence,
  нарушениях контракта, конфликтах claims или critical/error findings.
- Для файлов под git сканируется только `git diff --unified=0 <base_ref|HEAD>`:
  legacy-паттерны в неизменённых строках не создают шум. Новые/untracked файлы
  сканируются целиком. Удаление `expect(`/`assert` без добавления новой
  проверки даёт `test-assertion-removed`.
- `verify` пересчитывает hash и сверяет хеши файлов с диском; изменение файла
  после seal делает паспорт `stale`.
- `claim/release/claims` — координация нескольких агентов по файлам.
- `export` пишет `.md`/`.json` в `~/.config/opencode/shadow/passports/`.
- Если у задачи есть паспорт, Definition of Done требует `status=sealed`.

Паспорт создаётся автоматически на каждый actionable-ход: `chat.message`
открывает draft, `file.edited` добавляет файлы, `session.idle` выполняет
auto-seal. Файлы, которые правит сессия, автоматически закрепляются за ней
(`file_claims`, TTL 30 минут); `session.idle` освобождает claims. Конфликт
с живой сессией блокирует правку (`fileClaimPolicy: block`), брошенный claim
неактивной сессии перехватывается автоматически через `fileClaimStaleMs`
(по умолчанию 5 минут).

## Tool trust (1)

### `code_shadow_tool_trust`
Actions: `list | get | trust | block | scan | verify`.

Пиннинг MCP/инструментов: fingerprint = SHA-256 от имени, описания и схемы
аргументов. V2 при старте сканирует `editor.list()` и записывает `tool_trust`;
изменение описания или схемы после пиннинга помечает инструмент `changed`
(rug pull), эвристики prompt injection — `suspicious`.

- `scan` принимает `tools_json` — массив `{name, server?, description?, input_schema?}`.
- `verify` пересчитывает fingerprint и сравнивает с записанным, не меняя статус.
- `trust`/`block` — явное решение человека.
- `toolTrustPolicy: warn | block` управляет observer: `warn` пишет
  `tool_warning`, `block` отклоняет вызов инструмента со статусом
  `changed`/`suspicious`/`blocked`.

## Task Graph и governance (10)

### `code_shadow_task`
Actions: `create | list | get | update | add_step | complete_step | done_check | complete | block`.
- `create` требует `title`, `goal`; статус по умолчанию `active`, priority 50.
- Auto-Task из `chat.message` создаёт одну задачу на сессию и один шаг
  «Выполнить запрос пользователя»; остальные шаги агент добавляет сам.
  Брошенные auto-задачи старше 24 часов отменяются cleanup-интервалом.
- `add_step` требует `step_title`; позиция = число шагов.
- `complete_step` требует `step_id`; `blocked_by` при отсутствии сохраняется.
- `done_check` — read-only Definition of Done.
- `complete` и `update status=completed` проходят DoD-проверку; при blockers
  статус не меняется.

### `code_shadow_evidence`
Actions: `record | list | verify | fail`.
`record` требует `claim`, `source`; статус `observed`, confidence 0..1.
`verify`/`fail` требуют `evidence_id`. При `fail` старый `verified_at`
сохраняется (известное ограничение).

### `code_shadow_failure_memory`
Actions: `record | search | resolve`.
`record` требует `hypothesis`, `attempted_action`, `failure`.
`resolve` требует `failure_id`, `resolution`; пишет `do_not_repeat`.
`search` возвращает все статусы (open первыми).

### `code_shadow_change_contract`
Actions: `create | list | get | check | close`.
- `create` требует `goal`; пути — массивы (glob `*`, `**`, `?`, Windows `\`).
- `check` требует непустой `changed_paths`, иначе ошибка; статус → `passed`/`violated`.
- `close` запрещён для `violated`.
- Observer дополнительно: preflight warning, hard deny в `permission.ask`,
  post-edit фиксация violations.

### `code_shadow_context_router`
```json
{ "phase": "verify", "task_id": "...", "query": "storage", "limit": 20, "project_root": "C:/project" }
```
Также возвращает `passport` — последний Change Passport текущей задачи/сессии.
Фазы: `explore` (+architecture), `build` (task state), `verify` (без памяти,
limit 20), `handoff` (+последний open handoff). Возвращает задачи/шаги,
evidence, открытые failures (по задаче или глобальные), активные контракты,
противоречия, память, агрегаты tool usage.

### `code_shadow_counterfactual`
```json
{ "files": ["src/observer.ts"], "query": "session.idle", "timeframe": "90d", "limit": 8 }
```
Оценивает seed-файлы и co-changed соседей: breakage, зависимости, частоту,
risk_score 0–100, suggested checks. Ничего не меняет.

### `code_shadow_handoff`
Actions: `create | list | read | claim | complete`.
`create` требует `summary`, `next_action`; payload собирает task/steps/evidence/
failures/contracts. `list` показывает только `open` (limit 20).

### `code_shadow_agent_insight`
Actions: `behavior | quality | risk`.
- `behavior` — calls/errors/avg duration по инструментам + сессии.
- `quality` — verified/unverified evidence, open failures, violated contracts,
  contradictions, `guard_warnings` (`tool_warning`) и `blocking_rejections`
  (только `tool_rejected` с `blocking=true` или блокирующим reason).
- `risk` — отдельный score 0..1 и level (`low/medium/high`) по этим сигналам.
  `tool_warning` не считается отказом; для rejection-rate используйте
  `blocking_rejections`, а не общий `tool_rejected`.

### `code_shadow_contradiction`
Actions: `record | list | resolve | accept`.
`record` требует `claim_a/source_a/claim_b/source_b`; severity по умолчанию
`medium`. `list` — только open. `resolve`/`accept` требуют id и resolution.

### `code_shadow_provenance`
Actions: `record | list`.
`record` требует `source_type`, `source_ref`, `content`; trust level понижается
до `untrusted` при эвристике prompt injection. Хеш считается после санитизации.

## Пример рабочего цикла

```text
code_shadow_task(create)
code_shadow_change_contract(create, allowed_paths)
code_shadow_task(add_step) × N
... правки ...
code_shadow_change_contract(check, changed_paths)
code_shadow_evidence(record → verify)
code_shadow_task(done_check → complete)
code_shadow_handoff(create, summary, next_action)
```
