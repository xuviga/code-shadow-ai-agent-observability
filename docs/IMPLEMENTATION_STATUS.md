# Code Shadow — фактический статус реализации

Документ отражает состояние исходного кода на 2026-09-29 и является источником
правды для текущего `v0.5.2`. Проект — локальный плагин OpenCode; он не является
облачным сервисом и не требует API-ключей.

## Что готово

- Серверный плагин экспортируется из `src/index.ts` и подключается к OpenCode
  через `@opencode-ai/plugin`.
- Observer сохраняет сессии, правки файлов, ошибки, вызовы инструментов,
  developer events, todo-изменения, LSP-диагностику и автоматически найденные
  факты.
- Storage работает на `bun:sqlite`, включает WAL, batch-запись и миграции до
  версии 6.
- Аналитика предоставляет 9 режимов: `hotspots`, `predict_change`,
  `file_history`, `team_pulse`, `my_stats`, `dependency_graph`,
  `knowledge_search`, `decisions_list`, `code_errors`.
- Экспортируется базовый набор AI-инструментов и agent-native слой: `code_shadow_analyze`,
  `code_shadow_memory_write`, `code_shadow_memory_search`,
  `code_shadow_memory_note`, `code_shadow_context_inject` и
  `code_shadow_decide`, а также `code_shadow_task`, `code_shadow_evidence`,
  `code_shadow_failure_memory`, `code_shadow_change_contract`,
  `code_shadow_counterfactual`, `code_shadow_context_router`, `code_shadow_contradiction`,
  `code_shadow_provenance`, `code_shadow_handoff` и `code_shadow_agent_insight`.
- Change Contract автоматически помечается нарушенным на событии `file.edited`.
- Handoff сохраняет переносимый снимок задачи, шагов, evidence, открытых сбоев
  и активных контрактов в SQLite.
- OpenCode todos автоматически синхронизируются с Task Graph.
- Verification-команды автоматически записываются как `verified` или `failed`
  evidence, а `Definition of Done` блокирует преждевременный `complete`.
- Preflight-контроль Change Contract предупреждает до edit/write, а повторение
  одинакового ошибочного tool signature три раза отмечается как agent loop.
- `chat.message` автоматически создаёт Task Graph для actionable user request,
  а `permission.ask` отклоняет edit/write при нарушении активного контракта.
- Successful edit-loop guard предупреждает после трёх успешных write/edit одного
  файла за короткий интервал, сбрасывается после verified progress и блокирует
  только повторяющееся содержимое или длинную серию из пяти записей без прогресса.
- Auto Plan добавляет шаги по смыслу пользовательского запроса, а
  Counterfactual Planner строит impact/risk/checks-срез по истории проекта.
- Серверный и TUI-хук `tool.execute.before` объединяются, поэтому предупреждение
  о риске не теряется при подключённой панели.
- Архитектурные решения создают отдельные узлы графа знаний, а LSP/todo-пути
  используют реальные внешние ключи и таблицы.
- Базовый тестовый контур находится в `tests/` и покрывает миграции, batch-запись,
  session/LSP/todo-события, нормализацию входных данных и поиск памяти.

## Фактическая схема SQLite

В свежей базе после миграций присутствуют 19 таблиц:

`schema_version`, `file_edits`, `sessions`, `session_errors`, `tool_executions`,
`decisions`, `knowledge_nodes`, `knowledge_edges`, `developer_events`,
`analytics_cache`, `todos`, `agent_tasks`, `task_steps`, `evidence_records`,
`failure_memory`, `change_contracts`, `contradiction_records`,
`provenance_events`, `agent_handoffs`.

Таблица `developer_profile` в текущей реализации отсутствует: статистика
разработчика вычисляется из событий и сессий. Таблица `todos` добавлена миграцией
005 и связана с `sessions(id)` через `session_id`. Agent-native таблицы добавлены
миграцией 006 и используют UUID-идентификаторы для безопасной записи из разных
сессий.

## Проверка перед выпуском

Из корня проекта:

```bash
npm install --ignore-scripts
npm run typecheck
bun test
```

`npm run typecheck` проверяет TypeScript без генерации файлов. `bun test`
запускает 16 тестов (51 assertion). Для интеграционной проверки в реальном
OpenCode дополнительно нужно установить плагин в тестовый проект и проверить
реальные события `session.created`, `file.edited`, `tool.execute.*`,
`lsp.client.diagnostics` и TUI-команды `/shadow`.

## Известные границы v0.5.2

- Проект тестирует Storage/Observer на реальной SQLite-базе, но не содержит
  полноценного OpenCode host harness; поэтому совместимость с конкретной версией
  OpenCode подтверждается отдельным smoke-тестом.
- `src/tui-plugin.tsx` и корневой `tui-plugin.tsx` — два варианта TUI-интеграции;
  через `tui.jsonc` устанавливается корневой файл. Изменения панели нужно
  синхронно проверять в обоих местах.
- Аналитика локальная и эвристическая: score не является ML-моделью и требует
  накопленной истории событий.
- Provenance детектирует распространённые признаки prompt injection эвристикой;
  это маркировка источника, а не изоляция выполнения команд.
- Change Contract блокирует `permission.ask` для edit/write при доступном
  permission hook; preflight/post-edit проверки остаются fallback для событий,
  которые не проходят через permission API. Это не заменяет code review.
- Установка рассчитана на Bun/OpenCode. Наличие `node_modules` в репозитории не
  является требованием поставки и не должно включаться в архив релиза.
