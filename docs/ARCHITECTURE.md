# Архитектура Code Shadow

> Актуально на 17.11.2026 (v0.5.3 + V2-совместимость). Источник правды — `src/`, миграции и тесты;
> план исправлений и статус — [FIX_PLAN.md](FIX_PLAN.md).

## 1. Назначение

Code Shadow — локальный плагин OpenCode: постоянная память проекта, наблюдаемость
действий агента и guardrails, которые не дают агенту зациклиться или выйти за
рамки согласованного изменения.

Принципы:
- **Local-first**: SQLite в `~/.config/opencode/shadow/data.db`, без сети.
- **Fail-open наблюдаемость**: ошибки observer'а логируются и не роняют хост.
- **Fail-closed guardrails**: Change Contract и edit-loop могут отклонить
  правку до её выполнения.
- **Per-instance state**: каждый экземпляр плагина имеет собственные Map
  (несколько workspace в одном процессе не делят loop-состояние).

## 2. Компоненты

| Модуль | Ответственность |
|---|---|
| `src/index.ts` | точка входа: конфиг, StorageEngine, observer, TUI-хуки, 16 инструментов, интервалы, `dispose`, CRUSH.md/AGENTS.md |
| `src/storage.ts` | SQLite/WAL, миграции, CRUD, аналитические агрегаты, batch-очередь, retention |
| `src/observer.ts` | приём событий/хуков, телеметрия, auto-memory, auto-task, auto-evidence, guardrails |
| `src/tools/agent.ts` | Task Graph, Evidence, Failure Memory, Change Contract, Context Router, Counterfactual, Handoff, Insight, Contradiction, Provenance |
| `src/tools/analyze.ts` | `code_shadow_analyze` (9 режимов) |
| `src/tools/memory.ts` | `code_shadow_memory_write/search/note` |
| `src/tools/context.ts` | `code_shadow_context_inject` |
| `src/tools/decide.ts` | ADR + узлы/рёбра графа знаний |
| `src/tui.ts` | серверные TUI-хуки: риск-тосты, `/shadow`, briefing при compaction |
| `src/v2.ts` | адаптер OpenCode 2: V2 hooks/events → V1-ядро, 14 подписок, буфер шагов |
| `src/tui-v2.ts` | адаптер V2 TUI: `ui.slot`/`data.on` → V1 `slots.register`/`event.on` |
| `tui-plugin.tsx` | SolidJS-панель сайдбара (read-only SQLite) |
| `src/path-match.ts` | glob-матчер контрактов (`*`, `**`, `?`, Windows-пути) |
| `src/import-graph.ts` | индексатор импортов для `dependency_graph` |

## 3. Поток данных

```text
OpenCode event/hook
        │
        ▼
   observer.ts ──► auto-task / auto-evidence / guardrails
        │
        ├── direct SQL (sessions, contracts, todos)
        └── enqueue() ──► flushBatch() ──► SQLite (WAL)
                                              │
                    ┌─────────────────────────┼─────────────────────────┐
                    ▼                         ▼                         ▼
             tools/analyze.ts          tools/memory/context       tui-plugin.tsx
             (агрегаты, 9 режимов)     (память, ADR, scope)       (сайдбар, read-only)
                    │
                    └──► CRUSH.md + AGENTS.md (инструкции для агента, refresh 3 мин)
```

## 4. Жизненный цикл

1. `loadConfig(pluginDir)` читает `<package>/config.json`; значения по
   умолчанию — в `src/config.ts`. `~` разворачивается через env (`USERPROFILE`/
   `HOME`) с fallback на `os.homedir()`.
2. `new StorageEngine(config)`: mkdir, `bun:sqlite`, `journal_mode=WAL`,
   `busy_timeout=5000`, `foreign_keys=ON`, миграции 001–012.
3. `runCleanup()` на старте и далее каждые 6 часов.
4. Интервалы: `flushBatch` каждые 5 с, CRUSH/AGENTS refresh проверяется каждые
   10 с, но запись выполняется не чаще одного раза в 3 минуты (иначе OpenCode 2
   получал бы новую instruction-инъекцию на каждый observer-event).
5. `ensureCrushMd` и `ensureTuiPlugin`: один блок инструкций пишется в
   `CRUSH.md` (OpenCode 1) и `AGENTS.md` (OpenCode 2) с сохранением
   пользовательского текста вне маркеров; установка/мерж `tui.json`.
6. Регистрация 16 инструментов и observer/TUI-хуков.
7. `dispose` (или exit/SIGINT/SIGTERM): снять интервалы и process-listeners,
   flush, закрыть БД.

## 5. Хуки и события (SDK 1.18.x)

| Вход | Обработка |
|---|---|
| `event: session.created` | сессия `created`, `session_started`; agent обычно `general` |
| `chat.message` (`input.agent`) | уточняет agent type, реактивирует сессию, auto-task по actionable-тексту, сброс edit-loop |
| `tool.execute.before` | старт таймера, edit-loop guard, preflight Change Contract |
| `tool.execute.after` | `tool_executions`, auto-memory, verification-evidence, failure-loop, успешные правки |
| `permission.ask` | hard gate для `edit`/`write`: loop guard + Change Contract |
| `event: session.idle` / `session.status(idle)` | flush, counts, summary, очистка runtime-состояния |
| `event: session.error` | реальные error names; `MessageAbortedError` пропускается; статус `error` |
| `event: session.compacted` | помечает **ту же** сессию `compacted` (новая не создаётся) |
| `event: message.updated` | `message_count`/`total_tokens_used` по `tokens` при `time.completed`, dedupe по message id |
| `event: message.part.updated` | patch parts → `sessionFilesMap`, актуализация `currentSessionId` |
| `event: file.edited` | `file_edits` (diff/строки nullable), наследование agent, dedupe 1.5 с |
| `event: file.watcher.updated` | `human_fix`, если файл изменён вне tool-вызова после правки агента |
| `event: todo.updated` | `todos` + зеркалирование в `agent_tasks/task_steps` |
| `event: lsp.client.diagnostics` | реальный payload не содержит diagnostics; `lsp.updated` обрабатывается при наличии массива |
| `event: session.updated/deleted` | project root для пустой сессии / статус `deleted` |
| `event: tui.prompt.append` | команды `/shadow`; тост через `client.tui.showToast` |
| `experimental.session.compacting` | briefing по `sessionID` и project scope |

Legacy-хуки `file.edited` и `lsp.diagnostic` сохранены для старых хостов, но
основной путь — `event`.

## 6. Guardrails

- **Successful edit-loop**: окно 10 минут, ключ `session + normalized path`.
  Warning на 3-й успешной мутации; блокировка при повторе контента (≥2) или
  5 подряд полных `write`. Targeted `edit` сбрасывает `writeStreak`. Сброс:
  `chat.message`, успешная verification-команда, истечение окна.
- **Failure-loop**: одинаковый tool+args с ошибкой 3 раза → `tool_warning`
  (`agent_loop_detected`, `blocking=false`); TTL 10 минут, cap 5000 ключей.
- **Event taxonomy**: `tool_rejected` — только блокирующие события
  (`blocking=true`, `severity=error|critical`); `tool_warning` — advisory
  (`successful_edit_loop_warning`, `change_contract_preflight`,
  `agent_loop_detected`). `turn_completed` пишется на каждый idle, а
  `session_completed` больше не используется как per-turn метрика.
- **Change Contract**: пути проверяются `pathMatches` (glob, Windows, project
  root, `./`/`..` нормализуются). Preflight warning, hard deny в
  `permission.ask`, post-edit фиксация violations. Пустой `check` не считается
  успехом; `close` запрещён для `violated`.
- **Mutating tools**: `write`, `edit`, `patch`, `apply_patch`, `multi_edit`;
  цели извлекаются из `filePath`/`files` и заголовков patch text.
- **Definition of Done**: шаги завершены, есть verified evidence, нет открытых
  failures/контрактов/противоречий; failures/evidence ищутся по `task_id` без
  LIKE/LIMIT. `update status=completed` проходит ту же проверку, что `complete`.
- **Verification evidence**: только shell/явная команда, без `echo/grep`-обманок
  и `|| true`; failure-маркеры в успешном выводе переводят evidence в `failed`.

## 7. Хранение

- 19 таблиц + FTS5-таблица `knowledge_nodes_fts`; миграции 001–012, версия в
  `schema_version`.
- Batch-очередь: `batchSize` (default 10), flush каждые 5 с; при ошибке batch
  выполняется построчная запись, «отравленные» строки логируются, очередь не
  блокируется; cap 10 000 с drop-oldest.
- Индексы: file+time, session+file, tool+time, event type+time,
  project+started, decisions project/status+time, `knowledge_edges` UNIQUE.
- Retention: сырые события — `retentionDays`; сессии — `sessionRetentionDays`
  (удаляются `idle/error/deleted/compacted` вместе с todos/errors); stale
  analytics_cache и provenance также чистятся; терминальные agent-native
  записи — по `sessionRetentionDays`, открытые/активные не удаляются.
- Лимиты: `getFileEdits` 5000, `getNodesByType` 1000,
  `getToolExecutionsForFile` 1000 (project-scoped).
- Текстовые поля ограничены (ошибки 4k/16k, decisions 8k, evidence 8k,
  failure 4k, handoff 4k/32k JSON, dev event metadata 16k JSON).

## 8. Аналитика

`code_shadow_analyze`: `hotspots`, `predict_change`, `file_history`,
`team_pulse`, `my_stats`, `dependency_graph`, `knowledge_search`,
`decisions_list`, `code_errors`.

Агрегаты выполняются SQL-выборками (`getEditTotals*`,
`getErrorTotalForEditedFiles*`, `getTopFilesByEdits`, `getToolUsageCounts`,
`getFileMetrics`, `getHotspotMetrics`, `getErrorCountsByFile`) — без N+1 по
файлам. `dependency_graph` лениво индексирует импорты (`import-graph.ts`).
Агрегаты, hotspots-кеш, file history и TUI-панель фильтруются по
`project_root`; память и ADR — с миграции 008 (NULL = global).
Поиск памяти: FTS5 + bm25 (name/path/metadata, префиксы токенов, буст точного
имени) и LIKE-fallback для подстрочных совпадений.

## 9. TUI

- Серверные хуки (`src/tui.ts`): риск-тост перед `edit/write` через
  `client.tui.showToast`, команды `/shadow hotspots|predict|stats|health|tui`
  из события `tui.prompt.append`, briefing в `experimental.session.compacting`
  (project из `sessionID`).
- Сайдбар (`tui-plugin.tsx`): read-only БД, слот `sidebar_content`, обновление
  по событиям с debounce и polling 5 с. Устанавливается postinstall/рантаймом
  в `~/.config/opencode/plugins/code-shadow/` и мержится в `tui.json`.
- OpenCode 2 подключает панель через `src/tui-v2.ts`: адаптер мостит
  `ui.slot("sidebar.content")` и `data.on` на V1 API `slots.register` /
  `event.on`. `tui.json` содержит одну запись
  `./plugins/code-shadow/tui-v2.ts`; legacy-запись V1 удаляется при мерже.

## 10. Безопасность и ограничения

- Секреты вычищаются `secretPatterns` (`sanitizeContent`) на путях записи;
  аргументы/диффы обрезаются до санитизации только по размеру.
- `provenance` помечает trust level и эвристически детектит prompt injection.
- Ограничения: аналитика эвристическая (не ML), LSP-диагностика зависит от
  payload хоста, FTS — токены/префиксы (не семантический поиск), host harness
  в CI ограничен smoke-тестом `tests/plugin-smoke.test.ts`; отдельный ручной
  прогон на OpenCode 1.18.30 выполнен (serve + session lifecycle).

## 11. Адаптер OpenCode 2

`src/v2.ts` — единственная точка входа V2 (`exports["."]`). Он поднимает то же
ядро, что и `src/index.ts`, и переводит V2 API в V1-контракты.

- **Tools**: `ctx.tool.transform` регистрирует 16 инструментов с
  `codemode: false`; `ctx.tool.hook("execute.before"/"execute.after")` вызывает
  V1-guardrails, `ctx.session.hook("prompt")` — auto-task, `ctx.session.hook("compaction")`
  — briefing, `ctx.permission.hook("evaluate")` — hard deny Change Contract.
- **Events**: 14 подписок (`V2_EVENT_TYPES`), проверяемых компилятором по union'у
  хоста. `session.created/deleted/renamed/moved/status`, `session.idle`,
  `session.execution.failed/succeeded/interrupted`, `session.compaction.ended`,
  `session.step.ended`, `filesystem.changed`, `tui.prompt.append`.
- **Правки**: `session.step.ended.files` → `file.edited` с атрибуцией сессии;
  `filesystem.changed` даёт внешние правки и `human_fix`, `unlink` — no-op.
  `V2StepUsageBuffer` суммирует токены/cost и отправляет один `message.updated`
  перед idle.
- **Завершение хода**: `execution.succeeded/interrupted` (как и `session.idle`)
  сбрасывают буфер и эмитят V1 `session.idle`; `execution.failed` сначала
  сохраняет токены, затем даёт `session.error`.
- **Location**: приоритет `data.location.directory` → `location.directory` →
  `ctx.location.directory`; этот путь становится `project_root`.
- **Ограничения**: в V2 нет `todo.updated`, LSP-событий и
  `message.updated/part.updated`; todo-синхронизация и LSP-захват отключены,
  message-метрики аппроксимируются буфером шагов. `tui.command.execute` даёт
  частичную замену `command.executed` только для TUI-команд.

Подробная таблица соответствий, упаковка и установка TUI — в
[V2_COMPATIBILITY.md](V2_COMPATIBILITY.md).
