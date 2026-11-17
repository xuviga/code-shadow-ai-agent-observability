# Совместимость с OpenCode 2 (V2)

> Актуально на 17.11.2026. Источник правды — `src/v2.ts`, `src/tui-v2.ts`,
> `tests/v2-events.test.ts` и `tests/tui-v2.test.ts`. Типы событий сверяются с
> `@opencode/plugin` 2.3.0 (union `OpenCodeClient["event"]["subscribe"]`).

## 1. Точка входа

OpenCode 2 загружает пакет по `exports["."]`, то есть `src/v2.ts`. Этот файл не
дублирует ядро: он импортирует V1-плагин из `src/index.ts`, поднимает его
StorageEngine/Observer/tools и переводит V2 API в V1-контракты.

| Что регистрируется | V2 API |
|---|---|
| 18 инструментов `code_shadow_*` | `ctx.tool.transform` (`codemode: false`) |
| Guardrails до/после инструмента | `ctx.tool.hook("execute.before")`, `ctx.tool.hook("execute.after")` |
| Auto-task из пользовательского запроса | `ctx.session.hook("prompt")` |
| Briefing при компактизации | `ctx.session.hook("compaction")` |
| Change Contract / edit-loop deny | `ctx.permission.hook("evaluate")` |
| Телеметрия | `ctx.event.subscribe({ types: V2_EVENT_TYPES })` |

V1-точка входа остаётся доступной как `./v1` (`src/index.ts`) и продолжает
работать на OpenCode 1.x.

## 2. Подписка на события: 14 типов

`V2_EVENT_TYPES` проверяется компилятором по union'у хоста: удалённое или
переименованное событие ломает `npm run typecheck`, а не молчит в рантайме.
Хост дополнительно всегда присылает `server.connected`; он не входит в список
подписки и игнорируется транслятором.

| # | V2 event | V1-результат |
|---|---|---|
| 1 | `session.created` | `session.created` (`info.id`, `parentID`, `agent`, `directory`) |
| 2 | `session.deleted` | `session.deleted` |
| 3 | `session.renamed` | `session.updated` (V2 разделил V1 `session.updated` на granular-события) |
| 4 | `session.moved` | `session.updated` |
| 5 | `session.status` | `session.status` |
| 6 | `session.idle` | `session.idle` |
| 7 | `session.execution.failed` | `session.error` |
| 8 | `session.execution.succeeded` | `session.idle` (завершение хода) |
| 9 | `session.execution.interrupted` | `session.idle` (завершение хода) |
| 10 | `session.compaction.ended` | `session.compacted` |
| 11 | `session.step.ended` | буфер шага; `message.updated` + `message.part.updated` перед idle |
| 12 | `filesystem.changed` | `file.edited` (+ `file.watcher.updated` для `change`) |
| 13 | `tui.prompt.append` | `tui.prompt.append` (команды `/shadow`) |
| 14 | `tui.command.execute` | `command.executed` (TUI-команды; ближайший V2-аналог) |

## 3. Шаги и правки: `step.ended.files → file.edited`

В V2 нет события `file.edited`, а `filesystem.changed` не содержит `sessionID`.
Единственный источник правок, привязанный к сессии, — `session.step.ended`:

- `data.files` каждого шага транслируется в `file.edited`, поэтому правки
  попадают в `file_edits` даже без отдельного watcher-события;
- `V2FileSessionIndex` запоминает пары «файл → сессия» (TTL 10 минут, cap 2000)
  и передаёт `sessionID` в `file.edited`, когда приходит `filesystem.changed`.
  Точное совпадение пути приоритетнее; suffix-сопоставление используется только
  как мост «относительный ↔ абсолютный путь» и только при однозначном матче;
- `filesystem.changed` остаётся источником внешних изменений и `human_fix`:
  `change` → `file.edited` + `file.watcher.updated`, `add` → `file.edited`
  (create), `unlink` — намеренный no-op, потому что V1 не умеет удалять правки.
  Дубль `file.edited` от шага и watcher-события гасится штатным dedupe V1 (1.5 с).

Токены и стоимость шагов копятся в `V2StepUsageBuffer` (не более 256
сообщений) и сбрасываются **одним** `message.updated` перед idle: V1 dedupe по
`messageID` учитывает только первый снапшот, поэтому пошаговая отправка потеряла
бы всё, кроме первого шага. Дополнительно эмитится `message.part.updated` с
`type: "patch"` и списком файлов, чтобы V1 обновил `sessionFilesMap`.
Шаг, пришедший после idle, отправляется немедленно.

## 4. Завершение хода: `execution.succeeded/interrupted → session.idle`

В V2 конец хода приходит как `session.execution.succeeded` или
`session.execution.interrupted`; `session.idle` — отдельное состояние сессии и
может прийти раньше или позже. Адаптер обрабатывает все три события одинаково:

1. сбрасывает `V2StepUsageBuffer` для сессии (сначала `message.updated` /
   patch-part, затем idle-событие, чтобы V1 успел посчитать метрики);
2. помечает сессию idle в буфере;
3. эмитит V1-путь `session.idle`, который пишет завершение хода
   (`turn_completed`) и итоговые counts. Для `interrupted` в metadata попадают
   `interrupted:true` и `interrupt_reason` (`user|shutdown|superseded|inactivity`);
   если нормальный idle пришёл раньше, маркер дописывается в уже созданный
   `turn_completed`.

Повторные события безопасны: `flush()` опустошает буфер, а V1 dedupe по
`messageID` не даёт записать один и тот же снапшот дважды.
`session.execution.failed` тоже сначала сбрасывает токены, а затем
транслируется в `session.error`; `session.status{type:"idle"}` делает тот же
flush.

## 5. Фильтрация по location / project root

- Экземпляр плагина привязан к `ctx.location.directory`; этот путь передаётся
  в контекст каждого инструмента как `directory`, `worktree` и `cwd`, поэтому
  чтение и запись идут в проект, из которого запущен OpenCode.
- В событиях приоритет у `data.location.directory`, затем `location.directory`,
  затем `ctx.location.directory`. Полученный путь становится `project_root` в
  `session.created` и `file.edited`, поэтому один и тот же V2-event в нескольких
  инстансах не переносит данные между проектами.
- `session.created` идемпотентен по `sessionID`: повторная доставка (второй
  экземпляр плагина) не создаёт дубль сессии.
- У `filesystem.changed` нет ни location, ни sessionID — сессия определяется
  через `V2FileSessionIndex`, а при неудаче — через активную сессию инстанса.
- Пути правок нормализуются через `normalizeProjectPath`: относительный
  `RelativePath` шага и абсолютный watcher-путь приводятся к абсолютному пути
  с прямыми слэшами; `tool_executions.target_file` нормализуется так же. Старые
  V2-строки, записанные относительными до 17.11.2026, остаются как есть; точные
  lookup'ы (`getFileEdits`, `getToolExecutionsForFile`) требуют абсолютного пути.

## 6. Чего нет в V2 (и чем это заменено)

| V1-событие | Статус в V2 | Следствие |
|---|---|---|
| `todo.updated` | V2 не эмитит todo-события | Синхронизация OpenCode todos с Task Graph в V2 недоступна; Task Graph ведётся через `code_shadow_task` |
| `lsp.client.diagnostics`, `lsp.updated`, `lsp.diagnostic` | В union'е V2 нет LSP-событий | LSP-захват отключён; `code_errors` показывает только сохранённые/компиляторные ошибки |
| `command.executed` | Нет прямого counterpart | `tui.command.execute` транслируется в `command.executed` для TUI-команд (`session.compact` и т.п.); произвольные shell-команды, не проходящие через TUI, по-прежнему не видны |
| `message.updated` | Нет публичного события | Аппроксимируется буфером `session.step.ended` (токены/cost) перед idle |
| `message.part.updated` | Нет публичного события | Аппроксимируется patch-part из файлов шага |
| `session.updated` | Разделён на `renamed` / `moved` / `metadata.updated` | Транслируются только `renamed` и `moved` (V1 использует `id` + `directory`) |
| `file.watcher.updated` | Нет отдельного события | Синтезируется из `filesystem.changed` с `event: "change"` |
| Тосты `client.tui.showToast` | Серверный V2-плагин не может пушить TUI-тосты | Сообщения уходят в лог плагина; панель обновляется из SQLite |

`session.message.content.updated` и `session.usage.recorded` встречаются только
в durable-типах и отсутствуют в публичном union подписки, поэтому подписаться на
них нельзя.

## 7. Упаковка

```jsonc
"exports": {
  ".":       "./src/v2.ts",        // OpenCode 2 (package root)
  "./v1":    "./src/index.ts",     // OpenCode 1.x
  "./v2":    "./src/v2.ts",        // явный V2-subpath
  "./tui":   "./src/tui-v2.ts",    // V2 TUI-адаптер
  "./tui-v1":"./tui-plugin.tsx"    // V1 SolidJS-панель
}
```

`@opencode/plugin` и `@opencode-ai/plugin` объявлены как `peerDependencies`
(их предоставляет хост) и продублированы в `devDependencies` для типов и
локальной сборки. Runtime-зависимостей у пакета нет: SQLite — встроенный
`bun:sqlite`, TUI-адаптер не импортирует `@opencode/plugin/tui` в рантайме.

## 8. Установка TUI

- `scripts/postinstall.js` копирует `tui-plugin.tsx` и `src/tui-v2.ts` в
  `~/.config/opencode/plugins/code-shadow/` и мержит
  `~/.config/opencode/tui.json` с единственной записью
  `./plugins/code-shadow/tui-v2.ts`.
- Legacy-запись `./plugins/code-shadow/tui-plugin.tsx` удаляется при мерже:
  две записи нарисовали бы две панели. Остальные плагины пользователя
  сохраняются, невалидный JSON не перезаписывается.
- Репозиторный `tui.jsonc` указывает на тот же V2-адаптер.
- `src/tui-v2.ts` ищет панель в порядке `./tui-plugin.js`, `../tui-plugin.js`,
  `./tui-plugin.tsx`, `../tui-plugin.tsx`: postinstall кладёт файлы рядом, а в
  репозитории панель лежит на уровень выше. Bun резолвит `.js` в `.tsx`; явные
  `.tsx`-кандидаты нужны для сред без такой подстановки. Если не загрузился ни
  один вариант, адаптер пишет диагностику в `~/.config/opencode/shadow/tui-debug.log`
  и падает с понятной ошибкой.

## 9. CRUSH.md → AGENTS.md

OpenCode 1 читает `~/.config/opencode/CRUSH.md`, OpenCode 2 — только
`~/.config/opencode/AGENTS.md`. `ensureCrushMd` пишет один и тот же блок

```
<!-- CODE_SHADOW_START -->
...
<!-- CODE_SHADOW_END -->
```

в оба файла:

- пользовательский текст вне маркеров сохраняется;
- при отсутствии маркеров блок дописывается в конец;
- при наличии маркеров заменяется только блок, поэтому повторные refresh не
  создают второй экземпляр правил;
- каталог создаётся при необходимости, ошибка записи одного файла не мешает
  записи второго;
- refresh запускается не чаще одного раза в 3 минуты: AGENTS.md — живой
  источник инструкций OpenCode 2, и запись на каждый observer-event приводила
  бы к новой instruction-инъекции каждые 10 секунд.

## 10. Проверка

```bash
npm install --ignore-scripts
npm run typecheck        # V1-ядро + V2-адаптер
npm run typecheck:tui    # tui-plugin.tsx + src/tui-v2.ts
npm run typecheck:test   # tests/**
bun test tests/v2-events.test.ts tests/v2-setup.test.ts tests/tui-v2.test.ts
```

Для ручной проверки в OpenCode 2 смотрите
`~/.local/share/opencode/log/code-shadow-v2.log`: там фиксируются
`registered <hook>`, `v2 event subscription (14)` и `v2 registry (18)`.
Ошибки трансляции событий пишутся туда же и не роняют хост.
