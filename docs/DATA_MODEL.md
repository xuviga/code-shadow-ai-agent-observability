# Модель данных Code Shadow

> Актуально на v0.5.3 (12.11.2026). Источник правды — `src/migrations/001…011`
> и `src/types.ts`. SQLite-файл по умолчанию:
> `~/.config/opencode/shadow/data.db` (WAL).

## 1. Подключение и миграции

- `bun:sqlite`, `journal_mode=WAL`, `busy_timeout=5000`, `foreign_keys=ON`.
- Версия схемы: `schema_version(version INTEGER PRIMARY KEY, applied_at, description)`.
- `runMigrations()` перечитывает `MAX(version)` перед каждым шагом (защита от
  параллельного применения), выполняет миграции по одной в собственной
  транзакции и бросает ошибку (fail-fast) вместо работы на полусхеме.

| Версия | Файл | Назначение |
|---|---|---|
| 001 | `001_initial.ts` | базовая схема и индексы |
| 002 | `002_fix_event_types.ts` | CHECK `developer_events` |
| 003 | `003_lsp_error_type.ts` | `session_errors.error_type = 'lsp'` |
| 004 | `004_explore_agent_type.ts` | agent type `explore` |
| 005 | `005_add_todos.ts` | таблица `todos` |
| 006 | `006_agent_native.ts` | Task Graph, Evidence, Failures, Contracts, Contradictions, Provenance, Handoffs |
| 007 | `007_restore_error_file_index.ts` | восстановлен `idx_errors_file` |
| 008 | `008_project_scope.ts` | `project_root` в `knowledge_nodes`/`decisions` |
| 009 | `009_analytics_indexes.ts` | составные индексы + UNIQUE `knowledge_edges` |
| 010 | `010_knowledge_node_natural_key.ts` | natural-key UNIQUE `knowledge_nodes` + перепривязка рёбер |
| 011 | `011_knowledge_fts.ts` | FTS5-индекс `knowledge_nodes_fts` + триггеры |

## 2. Сырая телеметрия

### file_edits
`id` PK, `file_path`, `session_id`, `agent_type` (`build|plan|general|explore`),
`edit_type` (`create|update|delete`), `diff_preview`, `lines_added`,
`lines_removed`, `timestamp`, `project_root`, `was_reverted`, `file_language`,
`diff_hash`.
Индексы: `(file_path,timestamp)`, `(session_id)`, `(timestamp)`,
`(session_id,file_path)` (009).

### sessions
`id` PK, `agent_type`, `status` (`created|active|idle|error|compacted|deleted`),
`started_at`, `ended_at`, `duration_ms`, `files_changed_count`,
`tools_used_count`, `errors_count`, `project_root`, `message_count`,
`total_tokens_used`, `compacted_from`.
Индексы: `status`, `started_at`, `project_root`, `agent_type`,
`(project_root,started_at)`.

### session_errors
`id` PK AI, `session_id` FK→sessions, `error_type`
(`tool_error|model_error|permission_denied|unknown|lsp`), `error_message`,
`error_stack`, `context_file`, `context_tool`, `timestamp`, `resolved`.
Индексы: `session_id`, `error_type`, `timestamp`, `context_file`,
`(context_file,timestamp)`.

### tool_executions
`id` PK AI, `session_id`, `tool_name`, `target_file`, `args_preview`, `status`
(`success|error|timeout|denied`), `duration_ms`, `timestamp`,
`result_size_bytes`.
Индексы: `session_id`, `tool_name`, `target_file`, `timestamp`,
`(target_file,timestamp)`.

### developer_events
`id` PK AI, `event_type` (CHECK: `session_started|session_start|session_end|
session_completed|command_used|human_fix|manual_edit|revert|todo_completed|
lsp_diagnostic|lsp_diagnostic_summary|file_focus|tool_rejected`), `session_id`,
`file_path`, `metadata` JSON, `timestamp`.
Индексы: `event_type`, `timestamp`, `(event_type,timestamp)`.

### todos
`todo_id` PK, `session_id` FK→sessions, `title`, `status`
(`pending|in_progress|completed|cancelled`), `created_at`, `updated_at`.
Зеркалируется в Task Graph по `metadata.todo_id`.

## 3. Память и аналитика

### decisions (ADR)
`id` PK AI, `title`, `description`, `context`, `alternatives` JSON, `status`
(`proposed|accepted|deprecated|superseded`), `decided_by`, `decided_at`,
`superseded_by`, `related_files` JSON, `tags` JSON, `project_root`.
Индексы: `status`, `tags`, `(project_root,decided_at)`, `(status,decided_at)`.

### knowledge_nodes
`id` PK AI, `node_type` (`file|module|concept|component|api|pattern|rule|
api_endpoint|note|decision`), `name`, `path`, `metadata` JSON, `created_at`,
`updated_at`, `project_root` (NULL = global).
Индексы: `node_type`, `path`, `name`, `project_root`, `(project_root,node_type)`,
**UNIQUE `(node_type, COALESCE(project_root,''), path для file / name)`** (010).
Поиск: FTS5-таблица `knowledge_nodes_fts(name, path, metadata)` с внешним
контентом и триггерами insert/update/delete; bm25-ранжирование с бустом точного
имени и LIKE-fallback для подстрочных совпадений.

### knowledge_edges
`id` PK AI, `source_id` FK, `target_id` FK, `edge_type`
(`imports|exports|contains|depends_on|causes_bugs_in|refactored_to|similar_to|
tested_by|implements|extends|coupled_with|references`), `weight`,
`evidence_count`, `first_seen`, `last_seen`.
Индексы: `source_id`, `target_id`, `edge_type`,
**UNIQUE `(source_id,target_id,edge_type)`**.

### analytics_cache
`id` PK AI, `cache_key` UNIQUE, `cache_data` JSON, `computed_at`,
`valid_until` (NULL = без TTL), `computation_time_ms`.
Чистится по `valid_until` и по возрасту `computed_at`.

## 4. Agent-native слой

| Таблица | Ключевые поля | Статусы |
|---|---|---|
| `agent_tasks` | `id TEXT PK`, `project_root`, `session_id`, `title`, `goal`, `priority`, timestamps, `metadata` | `planned/active/blocked/completed/cancelled` |
| `task_steps` | `id TEXT PK`, `task_id FK CASCADE`, `title`, `position`, `blocked_by`, timestamps, `metadata` | `pending/in_progress/completed/blocked/skipped` |
| `evidence_records` | `id TEXT PK`, `project_root`, `task_id FK SET NULL`, `session_id`, `claim`, `evidence_type`, `source`, `confidence` 0–1, `details`, `created_at`, `verified_at` | `observed/verified/failed/unknown` |
| `failure_memory` | `id TEXT PK`, `project_root`, `task_id FK SET NULL`, `hypothesis`, `action`, `failure`, `root_cause`, `resolution`, `do_not_repeat`, `signature`, timestamps, `metadata` | `open/resolved/dismissed` |
| `change_contracts` | `id TEXT PK`, `project_root`, `task_id FK SET NULL`, `goal`, `allowed_paths`/`forbidden_paths`/`planned_paths`/`verification_plan` JSON, `violations` JSON, timestamps | `active/passed/violated/closed` |
| `contradiction_records` | `id TEXT PK`, `project_root`, `task_id FK SET NULL`, `claim_a/source_a`, `claim_b/source_b`, `severity`, `resolution`, timestamps | `open/resolved/accepted`; severity `low/medium/high/critical` |
| `provenance_events` | `id INTEGER PK AI`, `project_root`, `session_id`, `source_type` (`user/system/file/tool_output/memory/external`), `source_ref`, `content_hash`, `trust_level` (`system/user/verified/observed/untrusted`), `flags` JSON, `snippet` | — |
| `agent_handoffs` | `id TEXT PK`, `project_root`, `task_id FK SET NULL`, `session_id`, `summary`, `next_action`, `payload` JSON, timestamps | `open/claimed/completed` |

Индексы: `(project_root,status,updated_at)` для tasks/contracts,
`(task_id,position)`, `(project_root,task_id,created_at)` для evidence,
`(project_root,status,created_at)` для failures/contradictions/handoffs,
`(project_root,created_at)` для provenance.

## 5. Ограничения и retention

- Внешние ключи: `task_steps → agent_tasks` (CASCADE), agent-native task_id
  (SET NULL), `session_errors/todos → sessions` (без CASCADE).
- `runCleanup(retentionDays, sessionRetentionDays)`:
  - сырые события старше `retentionDays`;
  - `provenance_events` старше `retentionDays`;
  - сессии `idle/error/deleted/compacted` старше `sessionRetentionDays`
    (сначала удаляются `todos` и `session_errors`);
  - истёкший/старый `analytics_cache` (TTL или `max(retentionDays, 7)` дней);
  - терминальные agent-native записи старше `sessionRetentionDays`:
    completed/cancelled tasks (+steps), verified/failed evidence,
    resolved/dismissed failures, passed/closed contracts,
    resolved/accepted contradictions, completed handoffs. Открытые/активные
    записи не удаляются.
- Retention значения клампятся ≥ 1 дня; очистка выполняется на старте и каждые
  6 часов.
- Project scope: file/session/error-аналитика фильтруется по `project_root`
  (для errors — через `sessions.project_root`); в `knowledge_nodes`/`decisions`
  строки с `project_root = NULL` считаются глобальными и видны во всех
  проектах.
- Batch-очередь: `batchSize` (10), flush 5 с; cap 10 000 (drop-oldest при
  переполнении после неудачного flush).
- Текстовые поля обрезаются при вставке (ошибки 4k/16k, decisions 8k,
  evidence 8k, failures 4k, handoffs 4k/32k JSON, dev metadata 16k JSON).
- Безопасные LIMIT-дефолты: `getFileEdits` — 5000, `getNodesByType` — 1000,
  `getToolExecutionsForFile` — 1000 (последний также фильтруется по проекту).
