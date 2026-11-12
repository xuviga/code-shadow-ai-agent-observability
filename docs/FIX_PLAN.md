# Code Shadow — Prioritized Fix Plan

Источник: полный аудит кодовой базы v0.5.3 (12.11.2026), 5 параллельных агентов.
Приоритеты: **P0** — данные теряются или guardrails обходятся; **P1** — некорректные метрики; **P2** — производительность/масштаб; **P3** — гигиена и документация.
Ссылки на строки — состояние до правок; после P0.1 нумерация `src/observer.ts` смещена.

## P0 — критично

### P0.1 Совместимость с `@opencode-ai/plugin` / `@opencode-ai/sdk` 1.18.33
Статус: **закрыто (12.11.2026)**, покрыто 8 regression-тестами (`tests/observer.test.ts`).

| Проблема | Файл | Исправление |
|---|---|---|
| `file.edited` несёт только `{file}`, observer читает sessionID/diff/additions | `src/observer.ts:1001-1012` | читать `file`, сессию брать из `currentSessionId`, diff/строки — nullable, agent наследовать от сессии; дедуп event vs legacy hook |
| `session.created` не содержит `agent` | `src/observer.ts:1114` | агент брать из `chat.message input.agent` и `AssistantMessage.mode` |
| `session.compacted` содержит только `sessionID` | `src/observer.ts:1353-1392` | не вставлять новую сессию: помечать текущую `compacted` + `session_end` event |
| `session.error` содержит только `sessionID/error` | `src/observer.ts:1298-1347` | маппинг реальных error names; `MessageAbortedError` пропускать; ставить статус `error` |
| `message.updated` без `text/parts` | `src/observer.ts:1433-1488` | считать `message_count`/`total_tokens_used` по `tokens` при `time.completed`; human_fix перенести на `file.watcher.updated` |
| `message.part.updated` не обрабатывается | — | добавить: patch parts → `sessionFilesMap`, sessionID → `currentSessionId` |
| `lsp.client.diagnostics` без `diagnostics` | `src/observer.ts:1569-1637` | обрабатывать `lsp.updated` с diagnostics; при отсутствии — debug |
| toast API `client.tui.toast.show` устарел | `src/observer.ts:1177-1184` | `client.tui.showToast({ body })` с legacy fallback |
| `tool.execute.after`: пустой output → `error`, `denied` → `success` | `src/observer.ts:1771-1781` | denied → timeout → error → success; учитывать `metadata.exitCode/success` |
| target не знает `file_path` | `src/observer.ts:1710,1784` | добавить `file_path`, `target_file`, `filepath` |

### P0.2 Потеря данных и обходы guardrails
Статус: **закрыто (12.11.2026)**. Дополнительно исправлено: `getCoChangedFiles` считает сессии (`COUNT(DISTINCT session_id)`) вместо пар правок; `runCleanup` клампит retention ≥ 1 дня и удаляет FK-children перед сессиями; `complete_step` больше не стирает `blocked_by`; для путей добавлен единый glob-модуль `src/path-match.ts` (`*`, `**`, `?`, `\`, project root).
Ранее закрыто вместе с P0.1: корректные статусы `tool.execute.after`, flush перед `session.idle`, agent-наследование, verification-evidence только по явной команде.

| Проблема | Файл |
|---|---|
| `updateTask` падает на NOT NULL при частичном patch | `src/storage.ts:957-967`, `src/tools/agent.ts:69` |
| retention не работает: FK `todos`/`session_errors` + статус `idle` | `src/storage.ts:2005-2007` |
| потерян `idx_errors_file` после миграции 003 | `src/migrations/003_lsp_error_type.ts:59-64` |
| `getRecentSimilarChanges` bind mismatch без timeframe | `src/storage.ts:1940-1970` |
| `flushBatch` poison-pill блокирует очередь навсегда | `src/storage.ts:2088-2118` |
| contract `check` с пустыми путями → `passed` | `src/storage.ts:1127-1137`, `src/tools/agent.ts:181` |
| `close` снимает `violated`; `update status=completed` минует DoD | `src/tools/agent.ts:69,182` |
| verification-evidence засчитывается read/grep с «test» в title | `src/observer.ts:815-824` |
| matches не globs и не понимает `\` Windows (4 копии) | `src/observer.ts:786,1066,1716,1889`, `src/storage.ts:1130` |
| `session.idle` считает counts до flush, повторный idle дублирует события | `src/observer.ts:1198-1251` |

## P1 — некорректные метрики
Статус: **закрыто (12.11.2026)**.
- `team_pulse`/`my_stats` больше не читают алфавитную выборку: добавлены SQL-агрегаты `getEditTotals`, `getEditTotalsBetween`, `getErrorTotalForEditedFiles(Between)`, `getTopFilesByEdits`, `getToolUsageCounts`, `getFileMetrics`. `activeFiles` = файлы, редактировавшиеся за 7 дней. `moduleBreakdown` считается по реальным edits/errors.
- `predict_change` riskScore/breakageRate клампятся в 0..1; `file_history` строит timeline из полной истории; `context_inject` читает любой свежий `hotspots:30d:*`; `context_router` реально различает фазы; `agent_insight risk` возвращает отдельный risk-score.
- `dependency_graph`: добавлен индексатор импортов `src/import-graph.ts` (relative imports → File-узлы, external → Module-узлы, `imports` edges, ленивая индексация до depth≤5/40 файлов), узлы получают реальный type/label.
- Project scoping: миграция 008 добавляет `project_root` в `knowledge_nodes` и `decisions`; memory/decide/context/analyze принимают `project_root`; старые глобальные строки (`NULL`) видны во всех проектах.
- Осталось (осознанно): auto-detected факты observer'а по-прежнему глобальные (`project_root NULL`), `my_stats` не персонализирован по разработчику.
- `predict_change` riskScore > 1 (клампить 0..1), breakage rate > 1 (`src/tools/analyze.ts:280-282`, `src/storage.ts:1917-1932`).
- `file_history` усекает timeline при заданном timeframe; `totalSessions/errorSessionsCount` мёртвые (`src/tools/analyze.ts:353-437`).
- `team_pulse`/`my_stats` считают по алфавитной выборке 100–200 файлов; `activeFiles` дубликат (`src/tools/analyze.ts:478-562,648-704`).
- `dependency_graph` — не импорты, а ADR-ссылки; все узлы помечаются `file` (`src/tools/analyze.ts:736-810`).
- `context_router` фазы косметические; `agent_insight risk` = `quality` (`src/tools/agent.ts:192-214,315-351`).
- кеш hotspots: ключ `hotspots:timeframe:limit` не совпадает с `hotspots:30d:5` в context_inject (`src/tools/analyze.ts:126`, `src/tools/context.ts:118`).
- аналитика не project-scoped (`knowledge_nodes`, `decisions` без `project_root`).

## P2 — производительность и масштаб
Статус: **закрыто (12.11.2026)**.
- Миграция 009: составные индексы (`context_file+timestamp`, `target_file+timestamp`, `event_type+timestamp`, `project_root+started_at`, `decisions(project,time/status,time)`, `session_id+file_path`, `project_root+node_type`), дедупликация и `UNIQUE` на `knowledge_edges(source_id,target_id,edge_type)`.
- N+1: `hotspots` — 2 агрегатных запроса вместо 6×N; `listHandoffs` без повторного `getHandoff`; `dependency_graph` кеширует узлы и берёт hotspot-метрики одним `getFileMetrics`; `predict_change`/`dependency_graph` ограничивают co-changed файлы 20.
- Лимиты: `batchQueue` ≤ 10000 с drop-oldest после неудачного flush; truncation текстов (`session_errors`, decisions, evidence, failure_memory, provenance, handoffs, developer_events JSON); `analytics_cache` с `valid_until=NULL` чистится по возрасту; `provenance_events` — по retention.
- Периодическая очистка: `runCleanup` каждые 6 часов, не только на старте.
- Observer state теперь per-instance (loop maps, session maps, `currentSessionId`, `crushDirty`, dedupe maps); `toolLoopMap` получил 10-минутный TTL и cap.
- Закрыто в Follow-up 2/3: `knowledge_nodes` natural-key UNIQUE (миграция 010), LIMIT для `getFileEdits`/`getToolExecutionsForFile`/`getNodesByType`, FTS5-поиск (миграция 011).

## P3 — гигиена
Статус: **закрыто (12.11.2026)**.
- Удалён дубликат `src/tui-plugin.tsx` и мёртвый `src/install.ts`; корневая TUI-панель и `package-lock.json` синхронизированы на v0.5.3.
- `scripts/postinstall.js` и runtime `ensureTuiPlugin` дополняют существующий `tui.json`, а не перезаписывают его; ошибки установки дают non-zero exit code.
- README обновлён: 19 таблиц + FTS5, 16 инструментов, миграции 001–011, один TUI-файл, актуальные команды `/shadow`.
- `ARCHITECTURE.md`, `DATA_MODEL.md`, `TOOLS_API.md` переписаны под текущий код; `ROADMAP.md`, `IMPLEMENTATION_STATUS.md`, `CHANGELOG.md` обновлены.
- Добавлены тесты: `path-match`, `import-graph`, `agent-tools`.

## Остаток
Статус: **закрыто (12.11.2026)**.
- Добавлен `tests/plugin-smoke.test.ts`: реальная точка входа `CodeShadow` с mock OpenCode client, изолированный temp home, SDK-shaped события, проверка БД/CRUSH/tui.json и `dispose`.
- `dispose` теперь возвращается плагином, снимает интервалы и process-listeners.
- `resolvePath` и логгер используют env-home и ленивую инициализацию — тестовая/portable изоляция работает.
- Выполнен ручной интеграционный прогон на OpenCode 1.18.30 (serve + session lifecycle + flush); автоматического host harness в CI нет. `knowledge_nodes` UNIQUE/FTS/LIMIT закрыты в Follow-up 2/3.

## Follow-up — закрыто 12.11.2026 (после первичного аудита)

### TUI-контракт 1.18.x
- `tui.prompt.append` перенесён из несуществующего хука в `event`; команды
  `/shadow` снова исполняются.
- Риск-тосты используют `client.tui.showToast` вместо неконтрактного
  `output.toast`; observer и TUI `event`-хуки выполняются последовательно.
- `experimental.session.compacting` читает `sessionID` и берёт `project_root`
  из сессии.

### Project scope
- `storage`-агрегаты (`hotspots`, `edit totals`, errors, sessions, dev events,
  tool usage, breakage rate, dependencies, file history) принимают
  `projectRoot`.
- `analyze`, `context_inject`, `memory_search`, auto-memory observer'а и
  TUI-панель передают проект; кеш hotspots стал
  `hotspots:<project>:<timeframe>:<limit>`.
- Глобальные legacy-узлы памяти (`project_root = NULL`) остаются видимыми.

### Guardrails, DoD, evidence
- `pathMatches` лексически разрешает `.`/`..` до glob-сравнения.
- `patch`/`apply_patch`/`multi_edit` входят в mutating guard; цели извлекаются
  из `filePath`, `files` и заголовков patch text.
- DoD ищет failures/evidence/contradictions по `task_id` без LIKE и LIMIT 100.
- Verification-evidence требует shell-tool или явный `command`, отвергает
  `echo/grep/cat`-обманки и `|| true`, а также failure-маркеры в успешном
  выводе.
- `code_shadow_task create` больше не принимает `status=completed`.

### Данные и миграции
- Retention удаляет только терминальные agent-native записи старше
  `sessionRetentionDays`; активные/open записи сохраняются.
- Миграции fail-fast и перечитывают версию перед каждым шагом.
- LSP warnings/info/hints больше не создают `session_errors`.
- Windows-пути нормализуются в auto-memory; `getStats` видит agent-native
  таблицы; terminal-таймстампы и `contradiction.resolution` заполняются.
- Тестовый контур: 58 тестов (path/observer/storage/agent-tools/TUI).

### Осталось
- `README.md`/`ROADMAP.md` всё ещё содержат исторические обещания
  (achievements, team dashboard, semantic search); их нужно привести к
  фактическому объёму v0.5.3.
- `lsp.client.diagnostics` в SDK 1.18.x не несёт `diagnostics`; богатые данные
  приходят только через `lsp.updated` (host-dependent).
- Интеграционный прогон против реального OpenCode host.

### Follow-up 2 — закрыто 12.11.2026
- `tui-plugin.tsx` включён в typecheck: `tsconfig.tui.json`, ambient-шимы
  `types/tui-shims.d.ts`, скрипт `typecheck:tui`, шаг CI.
- Миграция 010: natural-key UNIQUE для `knowledge_nodes`
  (`node_type`, `project_root`, `path` для file / `name` для остальных) с
  перепривязкой и дедупликацией `knowledge_edges`.
- `getFileEdits` (5000), `getNodesByType` (1000), `getToolExecutionsForFile`
  (1000) получили безопасные LIMIT-дефолты; `getToolExecutionsForFile` теперь
  фильтруется по проекту.
- Тестовый контур: 59 тестов.

### Follow-up 3 — закрыто 12.11.2026
- Миграция 011: FTS5-таблица `knowledge_nodes_fts` (external content) и
  триггеры insert/update/delete.
- `searchNodes` использует FTS5 + bm25 (веса name/path/metadata, буст точного
  имени) и LIKE-fallback для подстрочных совпадений и пустых запросов.
- Тестовый контур: 60 тестов.
