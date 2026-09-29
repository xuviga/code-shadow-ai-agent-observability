# Архитектура Code Shadow

> Плагин аналитики, автопамяти и предиктивной безопасности для OpenCode.
> Архитектурное описание/исторический дизайн. Фактический baseline исходного
> кода и расхождения с этим документом: [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).
> Версия документа: 2.1.0 | Последнее обновление: 2026-09-29

---

## Оглавление

1. [Обзор архитектуры](#1-обзор-архитектуры)
2. [Движок наблюдения (Observer Engine)](#2-движок-наблюдения-observer-engine)
3. [Движок хранения (Storage Engine)](#3-движок-хранения-storage-engine)
4. [Движок аналитики (Analytics Engine)](#4-движок-аналитики-analytics-engine)
5. [Интеграция с TUI](#5-интеграция-с-tui)
6. [Интерфейс AI-тулзов](#6-интерфейс-ai-тулзов)
7. [Диаграммы потоков данных](#7-диаграммы-потоков-данных)
8. [Жизненный цикл плагина](#8-жизненный-цикл-плагина)
9. [Производительность](#9-производительность)
10. [Безопасность и приватность](#10-безопасность-и-приватность)

---

## 1. Обзор архитектуры

### 1.1 Высокоуровневая диаграмма

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          OPENCODE HOST PROCESS                           │
│                                                                          │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────────────────┐  │
│  │   TUI    │   │ Session  │   │   LSP    │   │     AI Provider      │  │
│  │ (Ink)    │   │ Manager  │   │  Client  │   │  (Anthropic/OpenAI)  │  │
│  └────┬─────┘   └────┬─────┘   └────┬─────┘   └──────────┬───────────┘  │
│       │              │              │                     │              │
│       │     ┌────────┴────────┬─────┴──────────┐          │              │
│       │     │                 │                │          │              │
│       ▼     ▼                 ▼                ▼          ▼              │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                     PLUGIN EVENT BUS (EventEmitter)               │   │
│  │  file.edited │ session.* │ tool.execute.* │ lsp.* │ message.*     │   │
│  └──────────────────────────────┬───────────────────────────────────┘   │
│                                 │                                       │
│                                 ▼                                       │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                     CODE SHADOW PLUGIN                             │  │
│  │                                                                    │  │
│  │  ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐  │  │
│  │  │ Observer Engine  │──▶│  Storage Engine  │──▶│ Analyze Tools   │  │  │
│  │  │  (12 handlers)   │   │  (SQLite/WAL)    │   │  (9 режимов)   │  │  │
│  │  └────────┬─────────┘   └────────┬─────────┘   └────────┬─────────┘  │  │
│  │           │                      │                       │           │  │
│  │           ▼                      ▼                       ▼           │  │
│  │  ┌────────────────────────────────────────────────────────────────┐ │  │
│  │  │                    CORE DATA LAYER                              │ │  │
│  │  │  ~/.config/opencode/shadow/data.db  (SQLite, WAL mode)         │ │  │
│  │  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │ │  │
│  │  │  │file_edits│ │ sessions │ │session_  │ │ tool_executions  │  │ │  │
│  │  │  │          │ │          │ │ errors   │ │                  │  │ │  │
│  │  │  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘  │ │  │
│  │  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │ │  │
│  │  │  │ decisions│ │knowledge │ │knowledge │ │ analytics_cache  │  │ │  │
│  │  │  │          │ │ _nodes   │ │ _edges   │ │                  │  │ │  │
│  │  │  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘  │ │  │
│  │  └────────────────────────────────────────────────────────────────┘ │  │
│  │                                                                    │  │
│  │  ┌──────────────────────┐              ┌─────────────────────────┐ │  │
│  │  │   TUI Integration     │              │   AI Tools Interface    │ │  │
│  │  │  • Toast warnings     │              │  • code_shadow_analyze  │ │  │
│  │  │  • /shadow commands   │              │  • code_shadow_memory_* │ │  │
│  │  │  • Context injection  │              │  • code_shadow_inject   │ │  │
│  │  └───────────────────────┘              └─────────────────────────┘ │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Жизненный цикл плагина (концептуальный)

```
    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
    │ Инициали- │───▶│ Подписка │───▶│  Сбор    │───▶│ Анали-   │───▶│ Экспози- │
    │ зация     │    │ на ивенты│    │  данных  │    │ тика     │    │ ция тулз │
    └──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘
         │                                                                 │
         │  1. Загрузка плагина из .opencode/plugins/                     │
         │  2. Применение миграций БД                                      │
         │  3. Сканирование истории (бутстрап)                             │
         │  4. Регистрация команд /shadow                                  │
         │  5. Экспорт AI-тулзов                                           │
         └─────────────────────────────────────────────────────────────────┘
```

Плагин размещается локально в `.opencode/plugins/code-shadow/`, устанавливается
через npm как `opencode-code-shadow`. Точка входа — `src/index.ts`, экспортирующая
константу `CodeShadow` (совместима с Plugin API):

```typescript
// src/index.ts — точка входа плагина (фактический код)
import { StorageEngine } from "./storage.js"
import { createObserver } from "./observer.js"
import { createTuiIntegration } from "./tui.js"
import { createMemoryTools } from "./tools/memory.js"
import { createAnalyzeTool } from "./tools/analyze.js"
import { createContextTool } from "./tools/context.js"
import { createDecideTool } from "./tools/decide.js"

export const CodeShadow = async (ctx) => {
  const config = loadConfig(pluginDir)
  const storage = new StorageEngine(config)

  // AI-тулзы: базовая аналитика/память плюс agent-native operating layer
  const allTools = {
    ...createMemoryTools(storage, config, log),
    ...createAnalyzeTool(storage, config, log),
    ...createContextTool(storage, config, log),
    ...createDecideTool(storage, config, log),
  }

  // Observer + TUI
  const observerHooks = createObserver(storage, config, log, ctx.client)
  const tuiHooks = createTuiIntegration(storage, config, log)

  // CRUSH.md обновляется каждые 10 секунд
  setInterval(() => ensureCrushMd(storage, config, log), 10000)

  return { ...observerHooks, ...tuiHooks, tool: allTools }
}
```

Примечание: аналитика не выделена в отдельный модуль — запросы к БД
реализованы в методах `StorageEngine` (getFileEdits, getErrorCountForFile,
getHistoricalBreakageRate и др.) и вызываются напрямую из тулзов analyze.ts.

---

## 2. Движок наблюдения (Observer Engine)

Движок наблюдения — единый файл `src/observer.ts` (1426 строк). Подписывается
на 12 событий OpenCode, извлекает структурированные данные и сохраняет их в
StorageEngine. Некоторые обработчики также триггерят проверки в реальном
времени (например, `tool.execute.before` — проверка риска).

Все обработчики регистрируются через `ctx.hooks.on(eventName, handler)` и
возвращают объект с функцией `dispose()` для отписки.

### 2.1 Событие `file.edited`

Прямой именованный хук. Принимает `(input, output)`. Перехватывает каждое
изменение файла. Сохраняет полный контекст: путь, дифф, сессию, тип агента,
тип правки (create/update/delete). Также триггерит **авто-детект фактов** —
анализ пути файла на совпадение с 80+ правилами (язык, фреймворк, БД, CI/CD).

```typescript
// src/observer/handlers/file-edited.ts

interface FileEditedEvent {
  path: string;               // Абсолютный путь к изменённому файлу
  sessionId: string;          // ID текущей сессии
  agentType: "build" | "plan"; // Тип AI-агента
  diff: string;               // Полный diff (унифицированный формат)
  linesAdded: number;         // Количество добавленных строк
  linesRemoved: number;       // Количество удалённых строк
  timestamp: number;          // Unix timestamp (мс)
}

async function handleFileEdited(
  input: FileEditedEvent,
  output: unknown,
  ctx: PluginContext,
  storage: StorageEngine,
  analytics: AnalyticsEngine
): Promise<void> {
  // 1. Извлекаем метаданные файла
  const ext = path.extname(input.path);
  const projectRelative = path.relative(ctx.workspaceRoot, input.path);

  // 2. Фильтруем секреты из диффа (см. раздел 10)
  const safeDiff = filterSecrets(input.diff);

  // 3. Сохраняем в file_edits
  await storage.insert("file_edits", {
    session_id: input.sessionId,
    file_path: projectRelative,
    extension: ext,
    agent_type: input.agentType,
    diff_content: safeDiff,
    lines_added: input.linesAdded,
    lines_removed: input.linesRemoved,
    recorded_at: input.timestamp,
  });

  // 4. Обновляем счётчик событий для дебаунса аналитики
  analytics.incrementEventCounter();

  // 5. Авто-детект фактов о проекте (Auto-Memory Engine)
  await analytics.detectProjectFacts(input.path, projectRelative);
}
```

| Поле           | Тип      | Куда сохраняется       | Примечание                                  |
|----------------|----------|------------------------|---------------------------------------------|
| `path`         | `string` | `file_edits.file_path` | Приводится к относительному от workspace    |
| `sessionId`    | `string` | `file_edits.session_id`| Внешний ключ к `sessions.id`               |
| `agentType`    | `string` | `file_edits.agent_type`| `build` / `plan` / `general` / `explore`   |
| `editType`     | `string` | `file_edits.edit_type` | `create` / `update` / `delete`             |
| `diff`         | `string` | `file_edits.diff_preview`| Обрезается до config.maxDiffPreviewChars |
| `linesAdded`   | `number` | `file_edits.lines_added`|                                            |
| `linesRemoved` | `number` | `file_edits.lines_removed`|                                          |
| `timestamp`    | `number` | `file_edits.timestamp` | Unix timestamp в миллисекундах             |
| `projectRoot`  | `string` | `file_edits.project_root`| Абсолютный путь к корню проекта          |

Также вызывает autoDetectFromFile() — анализ пути файла на 80+ паттернов:
языки (.ts→TypeScript), фреймворки (next.config→Next.js), БД (schema.prisma→Prisma),
CI/CD (.github/workflows→GitHub Actions), тесты (vitest.config→Vitest) и др.

### 2.2 Событие `session.created`

Новая сессия начата — инициализируем трекинг.

```typescript
// src/observer/handlers/session-created.ts

interface SessionCreatedEvent {
  sessionId: string;
  agentType: "build" | "plan";
  timestamp: number;
  workingDirectory: string;
}

async function handleSessionCreated(
  event: SessionCreatedEvent,
  storage: StorageEngine
): Promise<void> {
  await storage.insert("sessions", {
    session_id: event.sessionId,
    agent_type: event.agentType,
    working_directory: event.workingDirectory,
    started_at: event.timestamp,
    status: "active",
    edit_count: 0,
    tool_call_count: 0,
    error_count: 0,
  });
}
```

### 2.3 Событие `session.idle`

Сессия завершена (пользователь перестал взаимодействовать). Подводим итоги:
сводка изменений, использованные инструменты, длительность, успех/неудача.

```typescript
// src/observer/handlers/session-idle.ts

interface SessionIdleEvent {
  sessionId: string;
  timestamp: number;
  summary?: string;          // Авто-сгенерированная сводка сессии
}

async function handleSessionIdle(
  event: SessionIdleEvent,
  storage: StorageEngine,
  analytics: AnalyticsEngine
): Promise<void> {
  // 1. Вычисляем длительность сессии
  const session = await storage.findOne("sessions", { session_id: event.sessionId });
  const duration = event.timestamp - session.started_at;

  // 2. Обновляем запись сессии
  await storage.update("sessions", { session_id: event.sessionId }, {
    status: "completed",
    duration_ms: duration,
    completed_at: event.timestamp,
  });

  // 3. Запускаем пересчёт аналитики
  await analytics.recomputeDeveloperProfile();
  await analytics.recomputeHotspots();
  await analytics.updateKnowledgeGraph();
}
```

### 2.4 Событие `session.error`

Ошибка во время сессии — сохраняем полный контекст для последующего анализа.

```typescript
// src/observer/handlers/session-error.ts

interface SessionErrorEvent {
  sessionId: string;
  errorMessage: string;
  stackTrace?: string;
  context?: {
    filePath?: string;
    toolName?: string;
    operation?: string;
  };
  timestamp: number;
}

async function handleSessionError(
  event: SessionErrorEvent,
  storage: StorageEngine
): Promise<void> {
  await storage.insert("session_errors", {
    session_id: event.sessionId,
    error_message: event.errorMessage,
    stack_trace: event.stackTrace || null,
    context_file: event.context?.filePath || null,
    context_tool: event.context?.toolName || null,
    context_operation: event.context?.operation || null,
    recorded_at: event.timestamp,
  });

  // Инкрементируем счётчик ошибок сессии
  await storage.increment("sessions", { session_id: event.sessionId }, "error_count");

  // Если ошибка связана с файлом — повышаем его hotspot-рейтинг
  if (event.context?.filePath) {
    await storage.upsert("analytics_cache", {
      cache_key: `file_error:${event.context.filePath}`,
      numeric_value: 1,
    }, { numeric_value: `numeric_value + 1` });
  }
}
```

### 2.5 Событие `session.compacted`

Компактизация (сжатие контекста) сессии. Фиксируем, что было сохранено, а что
потеряно, чтобы AI-агент знал, какую информацию нужно восстановить.

```typescript
// src/observer/handlers/session-compacted.ts

interface SessionCompactedEvent {
  sessionId: string;
  compactedSessionId: string;   // Сессия, которая была сжата
  preservedRange: { start: number; end: number };
  summary: string;              // Авто-сгенерированное резюме
  timestamp: number;
}

async function handleSessionCompacted(
  event: SessionCompactedEvent,
  storage: StorageEngine
): Promise<void> {
  await storage.insert("session_compactions", {
    session_id: event.sessionId,
    compacted_session_id: event.compactedSessionId,
    preserved_start: event.preservedRange.start,
    preserved_end: event.preservedRange.end,
    summary: event.summary,
    recorded_at: event.timestamp,
  });
}
```

### 2.6 Событие `tool.execute.before` (PRE-EXECUTION)

**Критически важный обработчик.** Перед выполнением любого инструмента проверяем
историю: является ли операция рискованной. Если риск превышает порог — показываем
тост-предупреждение в TUI.

```typescript
// src/observer/handlers/tool-execute-before.ts

interface ToolExecuteBeforeEvent {
  toolName: string;            // Имя тулза (read, edit, write, bash, ...)
  toolArgs: Record<string, unknown>;
  sessionId: string;
  agentType: "build" | "plan";
  timestamp: number;
}

interface RiskAssessment {
  riskScore: number;           // 0.0 — 1.0
  riskLevel: "low" | "medium" | "high" | "critical";
  reasons: string[];           // Человекочитаемые причины
  affectedFiles: string[];     // Файлы, которые могут быть затронуты
  historicalExamples: string[];// Примеры похожих проблем в прошлом
  recommendation: string;      // Совет: "Рекомендуется запустить тесты после изменения"
}

async function handleToolExecuteBefore(
  event: ToolExecuteBeforeEvent,
  storage: StorageEngine,
  analytics: AnalyticsEngine,
  ctx: PluginContext
): Promise<void> {
  // 1. Определяем целевые файлы из аргументов тулза
  const targetFiles = extractTargetFiles(event.toolName, event.toolArgs);
  if (targetFiles.length === 0) return;

  // 2. Запрашиваем предиктивный анализ риска
  const risk = await analytics.predictRisk(targetFiles, event.toolName);

  // 3. Если риск выше порога — показываем предупреждение
  if (risk.riskScore > ctx.config.warningThreshold) {
    await ctx.tui.toast.show({
      type: risk.riskLevel === "critical" ? "error" : "warning",
      message: `⚠️ Высокий риск: ${risk.reasons[0]}`,
      detail: `${risk.affectedFiles.length} файлов могут быть затронуты`,
      duration: 5000,
      actions: [
        { label: "Подробнее", command: `/shadow predict ${targetFiles[0]}` },
      ],
    });

    // 4. Логируем предупреждение для будущего анализа
    await storage.insert("risk_warnings", {
      session_id: event.sessionId,
      tool_name: event.toolName,
      target_files: JSON.stringify(targetFiles),
      risk_score: risk.riskScore,
      risk_level: risk.riskLevel,
      reasons: JSON.stringify(risk.reasons),
      timestamp: event.timestamp,
    });
  }
}
```

### 2.7 Событие `tool.execute.after` (POST-EXECUTION)

После выполнения инструмента — записываем результат: какой тулз был вызван, над
каким файлом, с каким исходом (успех/ошибка/длительность).

```typescript
// src/observer/handlers/tool-execute-after.ts

interface ToolExecuteAfterEvent {
  toolName: string;
  toolArgs: Record<string, unknown>;
  success: boolean;
  errorMessage?: string;
  durationMs: number;
  sessionId: string;
  agentType: "build" | "plan";
  timestamp: number;
}

async function handleToolExecuteAfter(
  event: ToolExecuteAfterEvent,
  storage: StorageEngine
): Promise<void> {
  const targetFiles = extractTargetFiles(event.toolName, event.toolArgs);

  await storage.insert("tool_executions", {
    session_id: event.sessionId,
    tool_name: event.toolName,
    tool_args: JSON.stringify(sanitizeArgs(event.toolArgs)),
    success: event.success ? 1 : 0,
    error_message: event.errorMessage || null,
    duration_ms: event.durationMs,
    target_files: JSON.stringify(targetFiles),
    agent_type: event.agentType,
    executed_at: event.timestamp,
  });

  // Обновляем счётчик вызовов тулзов в сессии
  await storage.increment("sessions", { session_id: event.sessionId }, "tool_call_count");
}
```

### 2.8 Событие `lsp.client.diagnostics`

Захватываем диагностические данные от LSP-сервера: ошибки, предупреждения,
подсказки в конкретных файлах. Это ключевой источник данных для алгоритма
Hotspot (файл с большим количеством ошибок получает повышенный рейтинг).

```typescript
// src/observer/handlers/lsp-diagnostics.ts

interface LspDiagnosticsEvent {
  filePath: string;
  diagnostics: LspDiagnostic[];
  sessionId: string;
  timestamp: number;
}

interface LspDiagnostic {
  severity: "error" | "warning" | "hint" | "info";
  message: string;
  line: number;
  column: number;
  code?: string;
  source?: string; // eslint, tsc, rust-analyzer, etc.
}

async function handleLspDiagnostics(
  event: LspDiagnosticsEvent,
  storage: StorageEngine
): Promise<void> {
  // Группируем по severity
  const counts = {
    errors: event.diagnostics.filter(d => d.severity === "error").length,
    warnings: event.diagnostics.filter(d => d.severity === "warning").length,
    hints: event.diagnostics.filter(d => d.severity === "hint").length,
  };

  // Записываем агрегированную запись
  await storage.insert("lsp_diagnostics", {
    session_id: event.sessionId,
    file_path: event.filePath,
    error_count: counts.errors,
    warning_count: counts.warnings,
    hint_count: counts.hints,
    source: event.diagnostics[0]?.source || "unknown",
    recorded_at: event.timestamp,
  });

  // Обновляем кеш hotspot (файл с ошибками — горячая точка)
  if (counts.errors > 0) {
    await storage.upsert("analytics_cache", {
      cache_key: `lsp_error:${event.filePath}`,
      numeric_value: counts.errors,
      recorded_at: event.timestamp,
    }, { numeric_value: `numeric_value + ${counts.errors}` });
  }
}
```

### 2.9 Событие `command.executed`

Отслеживаем использование пользовательских команд OpenCode (в том числе и команд
самого Code Shadow — `/shadow *`).

```typescript
// src/observer/handlers/command-executed.ts

interface CommandExecutedEvent {
  command: string;             // Полная строка команды
  commandName: string;         // Имя команды (первый токен)
  args: string[];              // Аргументы
  sessionId: string;
  timestamp: number;
}

async function handleCommandExecuted(
  event: CommandExecutedEvent,
  storage: StorageEngine
): Promise<void> {
  await storage.insert("command_usage", {
    session_id: event.sessionId,
    command_name: event.commandName,
    full_command: event.command,
    args: JSON.stringify(event.args),
    executed_at: event.timestamp,
  });
}
```

### 2.10 Событие `message.updated`

Отслеживаем редактирование сообщений. Ключевая метрика: если AI написал код, а
человек его исправил — это индикатор «AI-reliance ratio» и «fix rate».

```typescript
// src/observer/handlers/message-updated.ts

interface MessageUpdatedEvent {
  messageId: string;
  role: "user" | "assistant";
  sessionId: string;
  wasEdited: boolean;          // Было ли сообщение отредактировано человеком
  originalLength: number;
  newLength: number;
  timestamp: number;
}

async function handleMessageUpdated(
  event: MessageUpdatedEvent,
  storage: StorageEngine
): Promise<void> {
  // Нас интересуют только правки человеком сообщений ассистента
  // Это сигнал: "AI написал, человек исправил"
  if (event.role === "assistant" && event.wasEdited) {
    await storage.insert("developer_events", {
      session_id: event.sessionId,
      event_type: "human_fix",
      event_data: JSON.stringify({
        messageId: event.messageId,
        linesChanged: event.newLength - event.originalLength,
      }),
      recorded_at: event.timestamp,
    });

    // Обновляем коэффициент fix-rate для текущего разработчика
    await storage.increment("developer_profile", { metric: "human_fix_count" }, "value");
  }
}
```

### 2.11 Событие `todo.updated`

Отслеживаем выполнение задач (todo-список OpenCode).

```typescript
// src/observer/handlers/todo-updated.ts

interface TodoUpdatedEvent {
  todoId: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  sessionId: string;
  timestamp: number;
}

async function handleTodoUpdated(
  event: TodoUpdatedEvent,
  storage: StorageEngine
): Promise<void> {
  await storage.upsert("todos", { todo_id: event.todoId }, {
    session_id: event.sessionId,
    title: event.title,
    status: event.status,
    updated_at: event.timestamp,
  });
}
```

### 2.12 Регистрация всех обработчиков

```typescript
// src/observer/index.ts

export function createObserverEngine(
  ctx: PluginContext,
  storage: StorageEngine,
  analytics: AnalyticsEngine
): ObserverEngine {
  const disposers: Array<() => void> = [];

  disposers.push(
    // Прямой именованный хук (не только маршрутизация через event)
    ctx.hooks.on("file.edited",        (input, output) => handleFileEdited(input, output, ctx, storage, analytics)),
    ctx.hooks.on("session.created",    e => handleSessionCreated(e, storage)),
    ctx.hooks.on("session.idle",       e => handleSessionIdle(e, storage, analytics)),
    ctx.hooks.on("session.error",      e => handleSessionError(e, storage)),
    ctx.hooks.on("session.compacted",  e => handleSessionCompacted(e, storage)),
    ctx.hooks.on("tool.execute.before",e => handleToolExecuteBefore(e, storage, analytics, ctx)),
    ctx.hooks.on("tool.execute.after", e => handleToolExecuteAfter(e, storage)),
    ctx.hooks.on("lsp.client.diagnostics", e => handleLspDiagnostics(e, storage)),
    ctx.hooks.on("command.executed",   e => handleCommandExecuted(e, storage)),
    ctx.hooks.on("message.updated",    e => handleMessageUpdated(e, storage)),
    ctx.hooks.on("todo.updated",       e => handleTodoUpdated(e, storage)),
  );

  return {
    getHooks: () => disposers,
    dispose: () => disposers.forEach(fn => fn()),
  };
}
```

---

## 3. Движок хранения (Storage Engine)

### 3.1 Технологический стек

| Аспект              | Решение                                      |
|---------------------|----------------------------------------------|
| **СУБД**            | SQLite через `bun:sqlite` (встроен в Bun)     |
| **Режим работы**    | WAL (Write-Ahead Logging) — конкурентные чтения при записи |
| **Путь к БД**       | `~/.config/opencode/shadow/data.db`          |
| **Драйвер**         | `bun:sqlite` — встроен в Bun, синхронный, быстрый |
| **Логирование**     | Файл `~/.config/opencode/shadow/shadow.log` (не в console) |
| **Миграции**        | Версионированные, авто-применяются при старте |

### 3.2 Инициализация

```typescript
// src/storage.ts
import { Database } from "bun:sqlite"

export class StorageEngine {
  private db: Database
  private batchQueue: BatchQueueItem[] = []

  constructor(private config: ShadowConfig) {
    const dbDir = dirname(config.dbPath)
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true })

    this.db = new Database(config.dbPath)
    this.db.pragma("journal_mode = WAL")
    this.db.pragma("busy_timeout = 5000")
    this.db.pragma("foreign_keys = ON")

    this.runMigrations()
  }

  // Типизированные методы (не generic insert/update!)
  insertFileEdit(edit) { ... }
  getFileEdits(filePath, timeframe): FileEdit[] { ... }
  getFileEditCount(filePath, timeframe): number { ... }
  getRevertedEditCount(filePath, timeframe): number { ... }
  getDistinctFiles(timeframe): string[] { ... }
  getEditFrequency(filePath, timeframe): { total, perDay } { ... }
  insertSession(session) { ... }
  getErrorCountForFile(filePath, timeframe): number { ... }
  getErrorsForFile(filePath, timeframe): SessionError[] { ... }
  getDependencyCount(filePath): number { ... }
  getHistoricalBreakageRate(filePath, timeframe): number { ... }
  getCoChangedFiles(filePath, depth): { file, frequency }[] { ... }
  getRecentSimilarChanges(filePath, timeframe, limit) { ... }
  searchNodes(query, limit): KnowledgeNode[] { ... }
  getNodesByType(nodeType): KnowledgeNode[] { ... }
  upsertNode(node): number { ... }
  upsertEdge(edge): void { ... }
  getEdgesForNode(nodeId): KnowledgeEdge[] { ... }
  insertDecision(decision): number { ... }
  getDecisions(status?, limit?): Decision[] { ... }
  insertDevEvent(event) { ... }
  getDevEvents(eventType?, timeframe?): DeveloperEvent[] { ... }
  getSessionCount(timeframe): number { ... }
  getProjectRoots(): string[] { ... }
  getCached(key): unknown { ... }
  setCached(key, data, ttlMs): void { ... }
  enqueue(table, row): void { ... }
  flushBatch(): number { ... }
  runCleanup(retentionDays, sessionRetentionDays): void { ... }
  getStats(): { tableCounts, dbSize } { ... }
  queryRows(sql, ...params): unknown[] { ... }
  close(): void { ... }
}
```

### 3.3 Схема базы данных

#### Таблица `schema_version`

Служебная таблица для отслеживания версий миграций.

```sql
CREATE TABLE IF NOT EXISTS schema_version (
    version     INTEGER PRIMARY KEY,
    applied_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    description TEXT NOT NULL
);
```

#### Таблица `file_edits`

Каждое изменение файла, захваченное обработчиком `file.edited`.

```sql
CREATE TABLE file_edits (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL,
    file_path     TEXT NOT NULL,        -- Относительный путь от workspace
    extension     TEXT,                  -- Расширение файла (.ts, .rs, etc.)
    agent_type    TEXT NOT NULL CHECK(agent_type IN ('build', 'plan', 'general', 'explore')),
    lines_added   INTEGER DEFAULT 0,
    lines_removed INTEGER DEFAULT 0,
    recorded_at   INTEGER NOT NULL,      -- Unix timestamp мс

    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

CREATE INDEX idx_file_edits_session ON file_edits(session_id);
CREATE INDEX idx_file_edits_path ON file_edits(file_path);
CREATE INDEX idx_file_edits_time ON file_edits(recorded_at);
CREATE INDEX idx_file_edits_path_time ON file_edits(file_path, recorded_at);
```

#### Таблица `sessions`

Жизненный цикл сессий.

```sql
CREATE TABLE sessions (
    session_id         TEXT PRIMARY KEY,
    agent_type    TEXT NOT NULL CHECK(agent_type IN ('build', 'plan', 'general', 'explore')),
    working_directory  TEXT,
    status             TEXT NOT NULL DEFAULT 'active'
                         CHECK(status IN ('active', 'completed', 'error', 'compacted')),
    started_at         INTEGER NOT NULL,
    completed_at       INTEGER,
    duration_ms        INTEGER,
    edit_count         INTEGER DEFAULT 0,
    tool_call_count    INTEGER DEFAULT 0,
    error_count        INTEGER DEFAULT 0,
    summary            TEXT
);

CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_started ON sessions(started_at);
CREATE INDEX idx_sessions_agent ON sessions(agent_type);
```

#### Таблица `session_errors`

Ошибки, произошедшие во время сессий.

```sql
CREATE TABLE session_errors (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id       TEXT NOT NULL,
    error_message    TEXT NOT NULL,
    stack_trace      TEXT,
    context_file     TEXT,               -- Файл, с которым работали
    context_tool     TEXT,               -- Инструмент, который вызвал ошибку
    context_operation TEXT,              -- Операция (read, write, execute, etc.)
    recorded_at      INTEGER NOT NULL,

    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

CREATE INDEX idx_session_errors_session ON session_errors(session_id);
CREATE INDEX idx_session_errors_file ON session_errors(context_file);
CREATE INDEX idx_session_errors_time ON session_errors(recorded_at);
```

#### Таблица `tool_executions`

Каждый вызов инструмента AI-агентом.

```sql
CREATE TABLE tool_executions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL,
    tool_name     TEXT NOT NULL,          -- read, edit, write, bash, glob, grep, ...
    tool_args     TEXT,                   -- JSON-строка аргументов (секреты удалены)
    success       INTEGER NOT NULL DEFAULT 1,  -- 0 или 1
    error_message TEXT,
    duration_ms   INTEGER,
    target_files  TEXT,                   -- JSON-массив затронутых файлов
    agent_type    TEXT NOT NULL CHECK(agent_type IN ('build', 'plan')),
    executed_at   INTEGER NOT NULL,

    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

CREATE INDEX idx_tool_exec_session ON tool_executions(session_id);
CREATE INDEX idx_tool_exec_tool ON tool_executions(tool_name);
CREATE INDEX idx_tool_exec_time ON tool_executions(executed_at);
CREATE INDEX idx_tool_exec_success ON tool_executions(success);
```

#### Таблица `decisions`

Архитектурные решения (ADR-стиль). Заполняется AI-агентом через
`code_shadow_memory_write` с типом `decision`.

```sql
CREATE TABLE decisions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT NOT NULL,
    context       TEXT,                   -- Что привело к решению
    decision      TEXT NOT NULL,          -- Что было решено
    consequences  TEXT,                   -- Последствия
    status        TEXT DEFAULT 'proposed'
                    CHECK(status IN ('proposed', 'accepted', 'deprecated', 'superseded')),
    tags          TEXT,                   -- JSON-массив тегов
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

CREATE INDEX idx_decisions_status ON decisions(status);
CREATE INDEX idx_decisions_created ON decisions(created_at);
```

#### Таблица `knowledge_nodes`

Узлы графа знаний: файлы, модули, концепции, компоненты.

```sql
CREATE TABLE knowledge_nodes (
    id            TEXT PRIMARY KEY,       -- Уникальный идентификатор (file:src/foo.ts, concept:auth)
    type          TEXT NOT NULL CHECK(type IN ('file', 'module', 'concept', 'component', 'api')),
    label         TEXT NOT NULL,          -- Человекочитаемое имя
    description   TEXT,                   -- Описание сущности
    metadata      TEXT,                   -- JSON с дополнительными данными
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

CREATE INDEX idx_knowledge_nodes_type ON knowledge_nodes(type);
```

#### Таблица `knowledge_edges`

Рёбра графа знаний: отношения между узлами.

```sql
CREATE TABLE knowledge_edges (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    source_node_id  TEXT NOT NULL,
    target_node_id  TEXT NOT NULL,
    relation_type   TEXT NOT NULL CHECK(relation_type IN (
                      'depends_on', 'contains', 'imports',
                      'causes_bugs_in', 'coupled_with', 'implements',
                      'extends', 'references', 'tested_by'
                    )),
    weight          REAL DEFAULT 1.0,     -- Сила связи (0.0 — 1.0)
    evidence        TEXT,                 -- Откуда взята связь ("import_analysis", "co_change", "manual")
    created_at      INTEGER NOT NULL,

    FOREIGN KEY (source_node_id) REFERENCES knowledge_nodes(id),
    FOREIGN KEY (target_node_id) REFERENCES knowledge_nodes(id),
    UNIQUE(source_node_id, target_node_id, relation_type)
);

CREATE INDEX idx_knowledge_edges_source ON knowledge_edges(source_node_id);
CREATE INDEX idx_knowledge_edges_target ON knowledge_edges(target_node_id);
CREATE INDEX idx_knowledge_edges_relation ON knowledge_edges(relation_type);
```

#### Таблица `developer_events`

События, связанные с конкретным разработчиком.

```sql
CREATE TABLE developer_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL,
    event_type    TEXT NOT NULL CHECK(event_type IN (
                    'human_fix', 'session_start', 'session_end',
                    'command_used', 'file_focus', 'tool_rejected'
                  )),
    event_data    TEXT,                   -- JSON с деталями события
    recorded_at   INTEGER NOT NULL,

    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

CREATE INDEX idx_developer_events_type ON developer_events(event_type);
CREATE INDEX idx_developer_events_time ON developer_events(recorded_at);
```

#### Таблица `developer_profile`

Предварительно вычисленные метрики разработчика.

```sql
CREATE TABLE developer_profile (
    metric      TEXT PRIMARY KEY,         -- sessions_per_day, avg_duration, etc.
    value       REAL DEFAULT 0,
    updated_at  INTEGER NOT NULL
);
```

#### Таблица `analytics_cache`

Кеш предварительно вычисленной аналитики для быстрых запросов.

```sql
CREATE TABLE analytics_cache (
    cache_key       TEXT PRIMARY KEY,     -- Составной ключ: "hotspot:src/foo.ts"
    category        TEXT NOT NULL,        -- hotspot, risk_prediction, developer_stats
    numeric_value   REAL DEFAULT 0,
    text_value      TEXT,
    json_value      TEXT,                 -- Для сложных объектов
    computed_at     INTEGER NOT NULL,
    expires_at      INTEGER               -- NULL = бессрочно
);

CREATE INDEX idx_analytics_cache_category ON analytics_cache(category);
CREATE INDEX idx_analytics_cache_expires ON analytics_cache(expires_at);
```

#### Таблица `risk_warnings`

Лог предупреждений о риске, выданных через TUI.

```sql
CREATE TABLE risk_warnings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL,
    tool_name     TEXT NOT NULL,
    target_files  TEXT NOT NULL,          -- JSON-массив
    risk_score    REAL NOT NULL,
    risk_level    TEXT NOT NULL CHECK(risk_level IN ('low', 'medium', 'high', 'critical')),
    reasons       TEXT NOT NULL,          -- JSON-массив причин
    timestamp     INTEGER NOT NULL,

    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
```

#### Таблица `session_compactions`

Записи о компактизации сессий.

```sql
CREATE TABLE session_compactions (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id            TEXT NOT NULL,
    compacted_session_id  TEXT NOT NULL,
    preserved_start       INTEGER NOT NULL,
    preserved_end         INTEGER NOT NULL,
    summary               TEXT,
    recorded_at           INTEGER NOT NULL,

    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
```

#### Таблица `lsp_diagnostics`

Диагностические данные от LSP-серверов.

```sql
CREATE TABLE lsp_diagnostics (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL,
    file_path     TEXT NOT NULL,
    error_count   INTEGER DEFAULT 0,
    warning_count INTEGER DEFAULT 0,
    hint_count    INTEGER DEFAULT 0,
    source        TEXT,                   -- eslint, tsc, rust-analyzer, ...
    recorded_at   INTEGER NOT NULL,

    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

CREATE INDEX idx_lsp_diagnostics_file ON lsp_diagnostics(file_path);
CREATE INDEX idx_lsp_diagnostics_time ON lsp_diagnostics(recorded_at);
```

#### Таблица `command_usage`

Лог использования команд.

```sql
CREATE TABLE command_usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL,
    command_name  TEXT NOT NULL,
    full_command  TEXT NOT NULL,
    args          TEXT,                   -- JSON-массив
    executed_at   INTEGER NOT NULL,

    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
```

#### Таблица `todos`

Задачи из todo-списка OpenCode.

```sql
CREATE TABLE todos (
    todo_id     TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    title       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending'
                  CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled')),
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    updated_at  INTEGER NOT NULL,

    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
```

### 3.4 Стратегия миграций

Миграции — версионированные **TypeScript-файлы** в директории `src/migrations/`.
Каждый файл именуется как `NNN_description.ts`, где NNN — порядковый номер.
Применяются последовательно, неповторно, внутри транзакции. Используют паттерн
«пересоздать таблицу» из-за ограничений SQLite на ALTER CHECK.

**История миграций:**

| Версия | Файл | Описание |
|--------|------|----------|
| **v1** | `001_initial.ts` | Начальная схема: 10 таблиц + 20+ индексов |
| **v2** | `002_fix_event_types.ts` | Фикс CHECK: добавлены `session_completed`, `todo_completed`, `lsp_diagnostic`, `lsp_diagnostic_summary` в `developer_events` |
| **v3** | `003_lsp_error_type.ts` | Добавлен `lsp` в `error_type` CHECK таблицы `session_errors` |
| **v4** | `004_explore_agent_type.ts` | Добавлен `explore` в `agent_type` CHECK таблиц `file_edits` и `sessions` |

```typescript
// src/storage.ts — метод runMigrations()

private runMigrations(): void {
  const currentVersion = this.getCurrentVersion()
  const migrations = [
    { version: 1, file: "001_initial.ts", fn: migration001 },
    { version: 2, file: "002_fix_event_types.ts", fn: migration002 },
    { version: 3, file: "003_lsp_error_type.ts", fn: migration003 },
    { version: 4, file: "004_explore_agent_type.ts", fn: migration004 },
  ]

  this.db.transaction(() => {
    for (const m of migrations) {
      if (m.version <= currentVersion) continue
      m.fn.default(this.db)
      this.db.prepare(
        `INSERT INTO schema_version (version, applied_at, description) VALUES (?, ?, ?)`
      ).run(m.version, Date.now(), m.file)
    }
  })()
}
```

### 3.5 Очистка данных (Data Retention)

```typescript
// src/storage/retention.ts

export function scheduleDataRetention(db: Database, retentionDays: number): void {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  // Запускаем при старте и затем раз в час
  const cleanup = () => {
    const result = db.transaction(() => {
      // Удаляем старые сырые события
      const tables = ["file_edits", "tool_executions", "session_errors",
                      "lsp_diagnostics", "risk_warnings", "command_usage"];

      let totalDeleted = 0;
      for (const table of tables) {
        const info = db.prepare(
          `DELETE FROM ${table} WHERE recorded_at < ?`
        ).run(cutoff);
        totalDeleted += info.changes;
      }

      // Аналитические данные не удаляем (бессрочно)
      return totalDeleted;
    })();

    if (result > 0) {
      logger.info(`[CodeShadow] Очищено ${result} записей старше ${retentionDays} дней`);
    }
  };

  cleanup();
  setInterval(cleanup, 60 * 60 * 1000); // Каждый час
}
```

---

## 4. Движок аналитики (Analytics Engine)

### 4.1 Алгоритм Hotspot (Горячие точки)

Вычисляет «температуру» каждого файла в проекте — насколько он проблемный и
требует внимания.

```
                    Формула Hotspot Score (0–100)
    ┌─────────────────────────────────────────────────────────────┐
    │                                                             │
    │  Score = (E × 0.3) + (R × 0.4) + (C × 0.2) + (F × 0.1)    │
    │                                                             │
    │  E = edit_frequency     — нормализованная частота правок    │
    │  R = error_rate         — нормализованная частота ошибок    │
    │  C = recent_changes     — изменения за последние 7 дней     │
    │  F = developer_frustration — правки с последующим откатом   │
    │                                                             │
    └─────────────────────────────────────────────────────────────┘
```

**Developer Frustration (F)** — количество раз, когда файл был изменён, а затем
изменения были отменены (reverted) в рамках одной сессии. Определяется через
анализ последовательных `file_edits` для одного файла: если за изменением А
следует изменение B, которое возвращает файл к состоянию до А — это фрустрация.

```typescript
// src/analytics/hotspots.ts

interface HotspotEntry {
  filePath: string;
  score: number;               // 0–100
  rank: number;
  factors: {
    editFrequency: number;     // 0–1 нормализованный
    errorRate: number;         // 0–1 нормализованный
    recentChanges: number;     // 0–1 нормализованный
    developerFrustration: number; // 0–1 нормализованный
  };
  explanation: string;         // Человекочитаемое объяснение
}

export async function computeHotspots(storage: StorageEngine): Promise<HotspotEntry[]> {
  const db = storage.getDb();
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  // 1. Частота правок (E): количество правок на файл за всё время
  const editCounts = db.prepare(`
    SELECT file_path, COUNT(*) as cnt
    FROM file_edits
    GROUP BY file_path
  `).all() as Array<{ file_path: string; cnt: number }>;

  // 2. Частота ошибок (R): количество ошибок на файл
  const errorCounts = db.prepare(`
    SELECT context_file as file_path, COUNT(*) as cnt
    FROM session_errors
    WHERE context_file IS NOT NULL
    GROUP BY context_file
  `).all() as Array<{ file_path: string; cnt: number }>;

  // 3. Недавние изменения (C): правки за последние 7 дней
  const recentEdits = db.prepare(`
    SELECT file_path, COUNT(*) as cnt
    FROM file_edits
    WHERE recorded_at >= ?
    GROUP BY file_path
  `).all(sevenDaysAgo) as Array<{ file_path: string; cnt: number }>;

  // 4. Фрустрация разработчика (F): revert-паттерны
  const frustration = computeFrustration(db);

  // 5. Нормализуем и вычисляем финальный счёт
  const maxEdit = Math.max(1, ...editCounts.map(e => e.cnt));
  const maxError = Math.max(1, ...errorCounts.map(e => e.cnt));
  const maxRecent = Math.max(1, ...recentEdits.map(e => e.cnt));
  const maxFrustr = Math.max(1, ...frustration.map(f => f.count));

  const allFiles = new Set([
    ...editCounts.map(e => e.file_path),
    ...errorCounts.map(e => e.file_path),
  ]);

  const hotspots: HotspotEntry[] = [];

  for (const file of allFiles) {
    const E = (editCounts.find(e => e.file_path === file)?.cnt || 0) / maxEdit;
    const R = (errorCounts.find(e => e.file_path === file)?.cnt || 0) / maxError;
    const C = (recentEdits.find(e => e.file_path === file)?.cnt || 0) / maxRecent;
    const F = (frustration.find(f => f.file === file)?.count || 0) / maxFrustr;

    const score = Math.round(
      (E * 0.3 + R * 0.4 + C * 0.2 + F * 0.1) * 100
    );

    hotspots.push({
      filePath: file,
      score,
      rank: 0, // Заполним после сортировки
      factors: {
        editFrequency: Math.round(E * 100) / 100,
        errorRate: Math.round(R * 100) / 100,
        recentChanges: Math.round(C * 100) / 100,
        developerFrustration: Math.round(F * 100) / 100,
      },
      explanation: generateExplanation(file, { E, R, C, F }),
    });
  }

  // Сортируем по убыванию score и присваиваем ранги
  hotspots.sort((a, b) => b.score - a.score);
  hotspots.forEach((h, i) => (h.rank = i + 1));

  // Кешируем результат
  await storage.upsert("analytics_cache", {
    cache_key: "hotspots:full",
    category: "hotspot",
    json_value: JSON.stringify(hotspots),
    computed_at: now,
    expires_at: now + 60 * 60 * 1000, // 1 час
  });

  return hotspots;
}
```

### 4.2 Алгоритм предсказания риска (Prediction)

Для заданного изменения файла(ов) предсказывает, что ещё может сломаться.

```typescript
// src/analytics/prediction.ts

interface RiskPrediction {
  riskScore: number;           // 0.0 — 1.0
  riskLevel: "low" | "medium" | "high" | "critical";
  primaryFile: string;         // Файл, который меняется
  affectedFiles: Array<{
    path: string;
    riskContribution: number;  // Вклад в общий риск
    relationType: string;       // depends_on, coupled_with, etc.
    breakageProbability: number; // Вероятность поломки (0–1)
  }>;
  historicalExamples: Array<{
    description: string;
    sessionId: string;
    timestamp: number;
  }>;
  recommendation: string;
}

export async function predictChangeRisk(
  targetFiles: string[],
  toolName: string,
  storage: StorageEngine
): Promise<RiskPrediction> {
  const db = storage.getDb();

  // 1. Находим прямые зависимости целевых файлов через граф знаний
  const dependencies = db.prepare(`
    SELECT ke.target_node_id, ke.relation_type, ke.weight
    FROM knowledge_edges ke
    WHERE ke.source_node_id IN (${targetFiles.map(() => "?").join(",")})
       OR ke.target_node_id IN (${targetFiles.map(() => "?").join(",")})
  `).all(...targetFiles, ...targetFiles) as Array<{
    target_node_id: string; relation_type: string; weight: number;
  }>;

  // 2. Считаем историческую частоту поломок для каждого зависимого файла
  const affectedFiles: RiskPrediction["affectedFiles"] = [];

  for (const dep of dependencies) {
    if (targetFiles.includes(dep.target_node_id)) continue;

    // Сколько раз этот файл ломался при изменении зависимостей
    const breakageHistory = db.prepare(`
      SELECT COUNT(*) as cnt
      FROM session_errors se
      WHERE se.context_file = ?
    `).get(dep.target_node_id) as { cnt: number };

    const totalEdits = (db.prepare(`
      SELECT COUNT(*) as cnt FROM file_edits WHERE file_path = ?
    `).get(dep.target_node_id) as { cnt: number }).cnt || 1;

    const breakageProb = Math.min(breakageHistory.cnt / totalEdits, 1.0);

    affectedFiles.push({
      path: dep.target_node_id,
      riskContribution: dep.weight,
      relationType: dep.relation_type,
      breakageProbability: Math.round(breakageProb * 100) / 100,
    });
  }

  // 3. Находим исторические примеры похожих поломок
  const historicalExamples = db.prepare(`
    SELECT se.error_message, se.session_id, se.recorded_at,
           se.context_file
    FROM session_errors se
    WHERE se.context_file IN (${targetFiles.map(() => "?").join(",")})
    ORDER BY se.recorded_at DESC
    LIMIT 5
  `).all(...targetFiles) as Array<{
    error_message: string; session_id: string;
    recorded_at: number; context_file: string;
  }>;

  // 4. Вычисляем финальный risk score
  const directDepsCount = dependencies.length;
  const totalBreakageRate = affectedFiles.reduce(
    (sum, f) => sum + f.breakageProbability, 0
  ) / Math.max(affectedFiles.length, 1);
  const hasRecentBreakage = historicalExamples.some(
    e => Date.now() - e.recorded_at < 7 * 24 * 60 * 60 * 1000
  );
  const fileComplexity = targetFiles.length; // proxy: сколько файлов меняется

  const riskScore = Math.min(
    (directDepsCount / 50) * 0.25 +       // Прямые зависимости (макс 50)
    totalBreakageRate * 0.35 +             // Историческая частота поломок
    (hasRecentBreakage ? 0.25 : 0) +       // Недавние поломки — плохой знак
    (fileComplexity / 10) * 0.15,          // Сложность изменения
    1.0
  );

  // 5. Определяем уровень риска
  let riskLevel: RiskPrediction["riskLevel"];
  if (riskScore >= 0.8) riskLevel = "critical";
  else if (riskScore >= 0.6) riskLevel = "high";
  else if (riskScore >= 0.3) riskLevel = "medium";
  else riskLevel = "low";

  // 6. Генерируем рекомендацию
  const recommendation = generateRecommendation(riskLevel, affectedFiles, toolName);

  return {
    riskScore: Math.round(riskScore * 100) / 100,
    riskLevel,
    primaryFile: targetFiles[0],
    affectedFiles,
    historicalExamples: historicalExamples.map(e => ({
      description: e.error_message,
      sessionId: e.session_id,
      timestamp: e.recorded_at,
    })),
    recommendation,
  };
}
```

### 4.3 Профиль разработчика (Developer Profile)

```typescript
// src/analytics/developer-profile.ts

interface DeveloperProfile {
  sessionsPerDay: number;
  avgSessionDurationMs: number;
  toolUsageDistribution: Record<string, number>;  // tool_name → count
  topFiles: Array<{ path: string; edits: number }>;
  aiRelianceRatio: number;        // Доля AI-правок vs человеческих
  fixRate: number;                // Доля AI-кода, исправленного человеком
  trends: {
    sessionsTrend: "improving" | "stable" | "deteriorating";
    fixRateTrend: "improving" | "stable" | "deteriorating";
    productivityTrend: "improving" | "stable" | "deteriorating";
  };
  recentActivity: {
    last7Days: { sessions: number; edits: number; errors: number };
    last30Days: { sessions: number; edits: number; errors: number };
    last90Days: { sessions: number; edits: number; errors: number };
  };
}

export async function getDeveloperProfile(storage: StorageEngine): Promise<DeveloperProfile> {
  const db = storage.getDb();

  // Сессии в день
  const sessionsPerDay = db.prepare(`
    SELECT ROUND(COUNT(*) * 1.0 /
      MAX(1, (strftime('%s', 'now') - MIN(started_at) / 1000) / 86400.0), 2) as val
    FROM sessions WHERE status = 'completed'
  `).get() as { val: number };

  // Средняя длительность сессии
  const avgDuration = db.prepare(`
    SELECT AVG(duration_ms) as val FROM sessions
    WHERE status = 'completed' AND duration_ms IS NOT NULL
  `).get() as { val: number };

  // AI-reliance ratio: правки AI / (правки AI + правки человека)
  const aiEdits = db.prepare(`
    SELECT COUNT(*) as cnt FROM file_edits
  `).get() as { cnt: number };

  const humanFixes = db.prepare(`
    SELECT COUNT(*) as cnt FROM developer_events WHERE event_type = 'human_fix'
  `).get() as { cnt: number };

  const aiRelianceRatio = aiEdits.cnt > 0
    ? 1.0 - (humanFixes.cnt / (aiEdits.cnt + humanFixes.cnt))
    : 0;

  const fixRate = aiEdits.cnt > 0
    ? humanFixes.cnt / aiEdits.cnt
    : 0;

  // Распределение использования тулзов
  const toolUsage = db.prepare(`
    SELECT tool_name, COUNT(*) as cnt
    FROM tool_executions
    GROUP BY tool_name ORDER BY cnt DESC
  `).all() as Array<{ tool_name: string; cnt: number }>;

  // Топ файлов
  const topFiles = db.prepare(`
    SELECT file_path, COUNT(*) as cnt
    FROM file_edits
    GROUP BY file_path ORDER BY cnt DESC LIMIT 10
  `).all() as Array<{ file_path: string; cnt: number }>;

  // Тренды (сравниваем последние 7 дней с предыдущими 7 днями)
  const trends = computeTrends(db);

  return {
    sessionsPerDay: sessionsPerDay.val,
    avgSessionDurationMs: avgDuration.val || 0,
    toolUsageDistribution: Object.fromEntries(
      toolUsage.map(t => [t.tool_name, t.cnt])
    ),
    topFiles: topFiles.map(f => ({ path: f.file_path, edits: f.cnt })),
    aiRelianceRatio: Math.round(aiRelianceRatio * 100) / 100,
    fixRate: Math.round(fixRate * 100) / 100,
    trends,
    recentActivity: computeRecentActivity(db),
  };
}
```

### 4.4 Построение графа знаний (Knowledge Graph)

```typescript
// src/analytics/knowledge-graph.ts

export async function updateKnowledgeGraph(storage: StorageEngine): Promise<void> {
  const db = storage.getDb();

  // 1. Анализируем импорты из диффов файлов
  const recentEdits = db.prepare(`
    SELECT DISTINCT file_path, diff_content
    FROM file_edits
    WHERE recorded_at > ?
    ORDER BY recorded_at DESC
    LIMIT 100
  `).all(Date.now() - 24 * 60 * 60 * 1000);

  for (const edit of recentEdits) {
    // Парсим импорты из диффа (import ... from ...)
    const imports = parseImportsFromDiff(edit.diff_content);

    for (const imp of imports) {
      // Создаём/обновляем узлы
      upsertNode(db, `file:${edit.file_path}`, "file", edit.file_path);
      upsertNode(db, `file:${imp}`, "file", imp);

      // Создаём ребро IMPORT
      upsertEdge(db, `file:${edit.file_path}`, `file:${imp}`, "imports", 0.8);
    }
  }

  // 2. Анализируем co-change паттерны (файлы A и B всегда меняются вместе)
  const coChanges = db.prepare(`
    SELECT a.file_path as file_a, b.file_path as file_b, COUNT(*) as co_count
    FROM file_edits a
    JOIN file_edits b ON a.session_id = b.session_id AND a.file_path < b.file_path
    WHERE a.recorded_at > ?
    GROUP BY a.file_path, b.file_path
    HAVING co_count >= 3
  `).all(Date.now() - 30 * 24 * 60 * 60 * 1000);

  for (const cc of coChanges) {
    upsertEdge(db, `file:${cc.file_a}`, `file:${cc.file_b}`,
      "coupled_with", Math.min(cc.co_count / 10, 1.0));
  }

  // 3. Анализируем причинно-следственные связи (ошибки)
  const errorPatterns = db.prepare(`
    SELECT se.context_file as error_file, fe.file_path as edited_file,
           COUNT(*) as pattern_count
    FROM session_errors se
    JOIN file_edits fe ON se.session_id = fe.session_id
    WHERE se.context_file IS NOT NULL
      AND fe.file_path != se.context_file
      AND fe.recorded_at < se.recorded_at
      AND (se.recorded_at - fe.recorded_at) < 60000  -- в течение 1 минуты
    GROUP BY se.context_file, fe.file_path
    HAVING pattern_count >= 2
  `).all();

  for (const ep of errorPatterns) {
    upsertEdge(db, `file:${ep.edited_file}`, `file:${ep.error_file}`,
      "causes_bugs_in", Math.min(ep.pattern_count / 5, 1.0));
  }
}

function upsertNode(db: Database, id: string,
                     type: string, label: string): void {
  db.prepare(`
    INSERT INTO knowledge_nodes (id, type, label, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
  `).run(id, type, label, Date.now(), Date.now());
}

function upsertEdge(db: Database, source: string, target: string,
                    relation: string, weight: number): void {
  db.prepare(`
    INSERT INTO knowledge_edges (source_node_id, target_node_id, relation_type, weight, evidence, created_at)
    VALUES (?, ?, ?, ?, 'auto', ?)
    ON CONFLICT(source_node_id, target_node_id, relation_type)
    DO UPDATE SET weight = (weight + excluded.weight) / 2.0
  `).run(source, target, relation, weight, Date.now());
}
```

### 4.5 Auto-Memory Engine (Движок авто-памяти)

Автоматически детектит и сохраняет факты о проекте без ручных команд.
Срабатывает на два типа событий:

- **`file.edited`** — анализ пути файла (расширение, директория, имя)
- **`tool.execute.after`** — анализ прочитанных конфигов (`package.json`, `tsconfig.json`, `.eslintrc`, `AGENTS.md`)

#### 80+ правил детекции

| Триггер | Сохраняемый факт |
|---|---|
| `.tsx?$` | Проект использует TypeScript |
| `\.jsx?$` | Проект использует JavaScript |
| `\.py$` | Проект использует Python |
| `\.rs$` | Проект использует Rust |
| `\.go$` | Проект использует Go |
| `tailwind.config.*` | Проект использует Tailwind CSS |
| `next.config.*` | Проект использует Next.js |
| `vite.config.*` | Проект использует Vite |
| `prisma/` | Проект использует Prisma ORM |
| `Dockerfile` | Проект использует Docker |
| `docker-compose.yml` | Проект использует Docker Compose |
| `.github/workflows/` | GitHub Actions |
| `.gitlab-ci.yml` | GitLab CI |
| `jest.config.*` | Проект использует Jest |
| `vitest.config.*` | Проект использует Vitest |
| `playwright.config.*` | Проект использует Playwright |
| `src/components/` | Структура: компоненты в `src/components/` |
| `src/hooks/` | Структура: хуки в `src/hooks/` |
| `src/pages/` | Структура: страницы в `src/pages/` |
| `tsconfig.json` (strict: true) | TypeScript strict mode |
| `package.json` (type: "module") | ESM модули |
| `biome.json` | Линтер: Biome |

Полный список правил — 80+ паттернов, покрывающих язык, фреймворк, БД, CI/CD,
структуру проекта, стилизацию, тестирование и конвенции.

#### Дедупликация

Каждый факт сохраняется не чаще раза в 5 минут. Используется `Map`-based кэш:
ключ — `category:value`, значение — timestamp последней записи.

```typescript
// src/analytics/auto-memory.ts

const DEDUP_CACHE = new Map<string, number>();
const DEDUP_INTERVAL_MS = 5 * 60 * 1000; // 5 минут

export async function detectProjectFacts(
  filePath: string,
  storage: StorageEngine
): Promise<void> {
  const rules = loadDetectionRules();
  const detectedFacts: string[] = [];

  for (const rule of rules) {
    if (rule.matches(filePath)) {
      const cacheKey = `${rule.category}:${rule.fact}`;
      const lastSaved = DEDUP_CACHE.get(cacheKey) || 0;

      if (Date.now() - lastSaved < DEDUP_INTERVAL_MS) continue;

      detectedFacts.push(rule.fact);
      DEDUP_CACHE.set(cacheKey, Date.now());
    }
  }

  // Сохраняем факты в knowledge_nodes
  for (const fact of detectedFacts) {
    await storage.upsertNode(`concept:${fact}`, "concept", fact, {
      source: "auto-memory",
      detectedAt: Date.now(),
    });
  }
}
```

#### Источники конвенций (бесконтактный сбор)

Плагин парсит ключевые файлы проекта и сохраняет извлечённые конвенции:

| Файл | Что извлекается |
|---|---|
| `AGENTS.md` | Правила, ограничения, naming conventions |
| `package.json` | Зависимости, скрипты, движок (node/bun) |
| `tsconfig.json` | `baseUrl`, `paths`, strict-режим, target |
| `biome.json` / `.eslintrc` | Стиль кода, линтер-правила |
| `Dockerfile` | Базовый образ, exposed ports |
| `.env.example` | Требуемые переменные окружения |

---

## 5. Интеграция с TUI

### 5.1 Тост-предупреждения

Интеграция с TUI OpenCode (на базе Ink/React). Показываем тосты через
`ctx.tui.toast.show()` — этот метод доступен в контексте плагина.

```typescript
// src/tui/toasts.ts

interface ShadowToast {
  type: "warning" | "info" | "error";
  message: string;
  detail?: string;
  duration?: number;           // мс, по умолчанию 5000
  riskScore?: number;
  actions?: Array<{
    label: string;
    command: string;            // Команда OpenCode для выполнения
  }>;
}

export function showRiskWarning(
  ctx: PluginContext,
  risk: RiskPrediction
): void {
  const toast: ShadowToast = {
    type: risk.riskLevel === "critical" ? "error" : "warning",
    message: `Риск изменения ${risk.primaryFile}: ${risk.riskLevel}`,
    detail: [
      `Score: ${risk.riskScore}`,
      `Затронуто файлов: ${risk.affectedFiles.length}`,
      risk.historicalExamples.length > 0
        ? `⚠️ Были похожие поломки: ${risk.historicalExamples[0].description.slice(0, 80)}`
        : null,
    ].filter(Boolean).join(" | "),
    riskScore: risk.riskScore,
    duration: 6000,
    actions: [
      { label: "Подробнее", command: `/shadow predict ${risk.primaryFile}` },
      { label: "Пропустить", command: "" },
    ],
  };

  ctx.tui.toast.show(toast);
}

export function showInfoToast(ctx: PluginContext, message: string): void {
  ctx.tui.toast.show({
    type: "info",
    message,
    duration: 3000,
  });
}
```

### 5.2 Инъекция контекста при компактизации

Используем хук `experimental.session.compacting` для вставки критических данных
в контекст, сохраняемый при компактизации сессии.

```typescript
// src/tui/context-injection.ts

export function registerContextInjection(
  ctx: PluginContext,
  storage: StorageEngine,
  analytics: AnalyticsEngine
): void {
  ctx.hooks.on("experimental.session.compacting", async (event) => {
    // 1. Получаем текущие hotspots
    const hotspots = await analytics.getHotspotsCached();
    const topHotspots = hotspots.slice(0, 5);

    // 2. Получаем последние архитектурные решения
    const recentDecisions = storage.getDb().prepare(`
      SELECT title, decision FROM decisions
      WHERE status = 'accepted'
      ORDER BY updated_at DESC LIMIT 3
    `).all();

    // 3. Получаем граф зависимостей для недавно изменённых файлов
    const recentFiles = storage.getDb().prepare(`
      SELECT DISTINCT file_path FROM file_edits
      ORDER BY recorded_at DESC LIMIT 10
    `).all();

    // 4. Формируем контекстный блок для вставки
    const contextBlock = [
      "## Code Shadow: Проектный контекст",
      "",
      "### Критические файлы (Hotspots)",
      ...topHotspots.map(h =>
        `- \`${h.filePath}\` — score: ${h.score}/100, ${h.explanation}`
      ),
      "",
      "### Архитектурные решения",
      ...recentDecisions.map((d: any) =>
        `- **${d.title}**: ${d.decision.slice(0, 200)}`
      ),
      "",
      "### Недавно изменённые файлы",
      ...recentFiles.map((f: any) => `- \`${f.file_path}\``),
      "",
      "### Ключевые зависимости",
      "// Внедряются автоматически при компактизации",
    ].join("\n");

    // 5. Вставляем в контекст
    event.injectContext(contextBlock, {
      priority: "high",
      label: "Code Shadow Context",
    });
  });
}
```

### 5.3 Регистрация команд `/shadow`

```typescript
// src/tui/commands.ts

export function createTuiIntegration(
  ctx: PluginContext,
  storage: StorageEngine,
  analytics: AnalyticsEngine
): CommandRegistration[] {
  return [
    {
      name: "shadow",
      subCommands: {
        hotspots: {
          description: "Показать тепловую карту проблемных файлов",
          handler: async (args: string[]) => {
            const hotspots = await analytics.computeHotspots();
            const top10 = hotspots.slice(0, 10);

            // Форматируем вывод
            const lines = [
              "## Тепловая карта проекта (Hotspots)",
              "",
              "| Rank | File | Score | Ключевой фактор |",
              "|------|------|-------|-----------------|",
              ...top10.map(h =>
                `| ${h.rank} | \`${h.filePath}\` | ${h.score} | ${h.explanation} |`
              ),
            ];

            // Выводим в TUI
            ctx.tui.output(lines.join("\n"));
          },
        },

        predict: {
          description: "Предсказать последствия изменения файла",
          usage: "/shadow predict <file_path>",
          handler: async (args: string[]) => {
            const filePath = args[0];
            if (!filePath) {
              ctx.tui.output("Использование: /shadow predict <file_path>");
              return;
            }

            const prediction = await analytics.predictRisk([filePath], "edit");

            ctx.tui.output([
              `## Прогноз последствий изменения: \`${filePath}\``,
              "",
              `**Уровень риска:** ${prediction.riskLevel} (score: ${prediction.riskScore})`,
              "",
              "### Потенциально затронутые файлы:",
              ...prediction.affectedFiles.map(f =>
                `- \`${f.path}\` — вероятность поломки: ${f.breakageProbability} (связь: ${f.relationType})`
              ),
              "",
              prediction.historicalExamples.length > 0
                ? [
                    "### Исторические примеры похожих проблем:",
                    ...prediction.historicalExamples.map(e =>
                      `- ${e.description.slice(0, 100)} (сессия: ${e.sessionId})`
                    ),
                  ].join("\n")
                : "_Нет исторических данных_",
              "",
              `**Рекомендация:** ${prediction.recommendation}`,
            ].join("\n"));
          },
        },

        stats: {
          description: "Показать статистику разработчика",
          handler: async () => {
            const profile = await analytics.getDeveloperProfile();

            ctx.tui.output([
              "## Статистика разработчика",
              "",
              `- Сессий в день: **${profile.sessionsPerDay}**`,
              `- Средняя длительность сессии: **${Math.round(profile.avgSessionDurationMs / 60000)} мин**`,
              `- AI-Reliance ratio: **${profile.aiRelianceRatio}** (доля AI-кода)`,
              `- Fix rate: **${profile.fixRate}** (как часто AI-код требует правок)`,
              "",
              "### Тренды:",
              `- Сессии: ${profile.trends.sessionsTrend}`,
              `- Fix rate: ${profile.trends.fixRateTrend}`,
              `- Продуктивность: ${profile.trends.productivityTrend}`,
              "",
              "### Топ файлов:",
              ...profile.topFiles.map(f =>
                `- \`${f.path}\` — ${f.edits} правок`
              ),
              "",
              "### Использование тулзов:",
              ...Object.entries(profile.toolUsageDistribution).map(
                ([tool, count]) => `- \`${tool}\`: ${count} вызовов`
              ),
            ].join("\n"));
          },
        },

        health: {
          description: "Показать обзор здоровья проекта",
          handler: async () => {
            const hotspots = await analytics.computeHotspots();
            const profile = await analytics.getDeveloperProfile();

            const totalFiles = hotspots.length;
            const criticalFiles = hotspots.filter(h => h.score >= 70).length;
            const healthyFiles = hotspots.filter(h => h.score < 30).length;
            const healthScore = Math.round(
              (healthyFiles / Math.max(totalFiles, 1)) * 100
            );

            ctx.tui.output([
              "## Здоровье проекта",
              "",
              `**Общий рейтинг:** ${healthScore}/100`,
              `**Всего отслеживаемых файлов:** ${totalFiles}`,
              `**Критических файлов (score ≥ 70):** ${criticalFiles}`,
              `**Здоровых файлов (score < 30):** ${healthyFiles}`,
              "",
              healthScore < 40
                ? "⚠️ Проект требует внимания — высокий уровень проблемных файлов"
                : healthScore < 70
                  ? "Проект в норме, но есть зоны риска"
                  : "Проект в хорошем состоянии",
              "",
              `**AI-Reliance ratio:** ${profile.aiRelianceRatio}`,
              `**Fix rate:** ${profile.fixRate}`,
            ].join("\n"));
          },
        },
      },
    },
  ];
}
```

### 5.4 TUI Sidebar Panel (tui-plugin.tsx)

Отдельный TUI-плагин, регистрируется через `tui.jsonc`. Отвечает за рендеринг
live-статистики в правом сайдбаре OpenCode.

**Слот:** `sidebar_content`, order 700 (ниже встроенных панелей).

**Отображает:**
- **Здоровье проекта** (0–100%, цветовой индикатор: зелёный/жёлтый/красный)
- **Длительность последней сессии** (формат: минуты:секунды)
- **Сетка StatBox 2×2**:
  - Сессии (всего)
  - Правки (всего)
  - Ошибки (всего)
  - Файлы (уникальных)
- **Активность**: количество файлов и правок в текущей сессии

**Доступ к данным:** read-only SQLite через `bun:sqlite` (та же БД что и
server-плагин, `~/.config/opencode/shadow/data.db`).

**Рендеринг:** `@opentui/solid` JSX, функция `look()` для цветовой схемы
текущей темы OpenCode.

**Обновление:** подписка на события через `ctx.hooks.on(...)`, перерендер
при каждом новом событии (file_edited, session.*, tool.execute.*).

```tsx
// tui-plugin.tsx — фрагмент рендеринга сайдбара

import { render, Box, Text } from "@opentui/solid";

function ShadowSidebar(props: { stats: SidebarStats }) {
  const healthColor = props.stats.health > 60 ? look("green") :
                      props.stats.health > 30 ? look("yellow") :
                      look("red");

  return (
    <Box flexDirection="column" padding={1}>
      <Box borderStyle="round" borderColor={healthColor} padding={1}>
        <Text bold>Здоровье: {props.stats.health}%</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimmed>Последняя сессия: {props.stats.lastSessionDuration}</Text>
      </Box>

      <Box flexDirection="row" marginTop={1} gap={1}>
        <StatBox label="Сессии" value={props.stats.totalSessions} />
        <StatBox label="Правки" value={props.stats.totalEdits} />
        <StatBox label="Ошибки" value={props.stats.totalErrors} />
        <StatBox label="Файлы" value={props.stats.uniqueFiles} />
      </Box>

      <Box marginTop={1}>
        <Text dimmed>
          Активность: {props.stats.activeFiles} файлов · {props.stats.recentEdits} правок
        </Text>
      </Box>
    </Box>
  );
}

function StatBox(props: { label: string; value: number }) {
  return (
    <Box borderStyle="single" padding={0.5} flexGrow={1} alignItems="center">
      <Text dimmed size="small">{props.label}</Text>
      <Text bold>{props.value}</Text>
    </Box>
  );
}
```

---

## 6. Интерфейс AI-тулзов

Плагин экспортирует набор инструментов, доступных AI-агенту через механизм
`tools:` в возвращаемом объекте плагина.

### 6.1 Общая структура

```typescript
// src/tools/index.ts

export function createAiTools(
  ctx: PluginContext,
  storage: StorageEngine,
  analytics: AnalyticsEngine
): ToolRegistration[] {
  return [
    codeShadowAnalyze(ctx, storage, analytics),
    codeShadowMemoryWrite(ctx, storage),
    codeShadowMemorySearch(ctx, storage),
    codeShadowMemoryNote(ctx, storage),
    codeShadowContextInject(ctx, storage, analytics),
  ];
}
```

### 6.2 `code_shadow_analyze`

Главный аналитический тулз. Единый интерфейс для всех видов аналитики через
параметр `query`.

```typescript
// src/tools/analyze.ts

interface AnalyzeInput {
  query: "hotspots" | "predict_change" | "file_history" |
         "team_pulse" | "my_stats" | "dependency_graph" |
         "knowledge_search";
  // Для predict_change
  filePath?: string;
  changeType?: "edit" | "delete" | "rename" | "refactor";
  // Для file_history
  historyFilePath?: string;
  historyLimit?: number;
  // Для knowledge_search
  searchQuery?: string;
  searchType?: "concept" | "file" | "decision" | "all";
}

interface AnalyzeOutput {
  success: boolean;
  query: string;
  data: unknown;               // Зависит от типа запроса
  cached: boolean;
  computedAt: number;
  summary: string;
}
```

**Варианты запросов:**

#### `query: "hotspots"`

```typescript
// Возвращает:
{
  query: "hotspots",
  data: {
    hotspots: HotspotEntry[];   // Топ-20 проблемных файлов
    totalFilesTracked: number;
    generatedAt: number;
  },
  summary: "Топ-3 проблемных файла: src/auth.ts (85), src/db.ts (72), src/api.ts (68)"
}
```

#### `query: "predict_change"`

```typescript
// Вход:
{ query: "predict_change", filePath: "src/auth/login.ts", changeType: "edit" }

// Возвращает:
{
  query: "predict_change",
  data: {
    prediction: RiskPrediction;
    alternatives: Array<{     // Альтернативные подходы к изменению
      description: string;
      riskScore: number;
      tradeoffs: string;
    }>;
  },
  summary: "Изменение src/auth/login.ts имеет уровень риска HIGH (0.72). " +
           "Затронуты: src/auth/session.ts, src/db/users.ts, src/api/middleware.ts"
}
```

#### `query: "file_history"`

```typescript
// Вход:
{ query: "file_history", historyFilePath: "src/auth/login.ts", historyLimit: 20 }

// Возвращает:
{
  query: "file_history",
  data: {
    filePath: string;
    totalEdits: number;
    firstEditAt: number;
    lastEditAt: number;
    edits: Array<{
      sessionId: string;
      timestamp: number;
      agentType: "build" | "plan";
      linesAdded: number;
      linesRemoved: number;
      associatedErrors: number;
    }>;
    topContributors: Array<{   // Агенты/сессии, больше всего менявшие файл
      sessionId: string;
      editCount: number;
    }>;
  },
  summary: "Файл изменялся 47 раз с 2026-01-15. Последнее изменение: 2 часа назад."
}
```

#### `query: "team_pulse"`

```typescript
// Возвращает:
{
  query: "team_pulse",
  data: {
    recentActivity: {
      last24h: { sessions: number; edits: number; errors: number };
      last7d: { sessions: number; edits: number; errors: number };
    };
    activeAreas: string[];      // Директории с наибольшей активностью
    errorHotspots: Array<{ file: string; errors: number }>;
    collaborationPatterns: string; // Описание паттернов работы
  },
  summary: "За последние 7 дней: 23 сессии, 412 правок, 8 ошибок. " +
           "Активные зоны: src/auth/, src/api/, tests/"
}
```

#### `query: "my_stats"`

```typescript
// Возвращает:
{
  query: "my_stats",
  data: DeveloperProfile,      // Полный профиль (см. раздел 4.3)
  summary: "AI-reliance: 0.78, Fix rate: 0.12, Сессий в день: 4.2"
}
```

#### `query: "dependency_graph"`

```typescript
// Вход:
{ query: "dependency_graph", filePath?: "src/auth/login.ts" }

// Возвращает:
{
  query: "dependency_graph",
  data: {
    rootFile?: string;          // Если указан — отображаем граф от этого файла
    nodes: Array<{
      id: string;
      label: string;
      type: "file" | "module" | "concept";
      hotspotScore?: number;
    }>;
    edges: Array<{
      source: string;
      target: string;
      relation: string;
      weight: number;
    }>;
    graphSummary: string;       // Текстовое описание графа
  },
  summary: "Граф из 45 узлов и 128 рёбер. Наибольшая связность у src/auth/."
}
```

#### `query: "knowledge_search"`

```typescript
// Вход:
{ query: "knowledge_search", searchQuery: "аутентификация", searchType: "concept" }

// Возвращает:
{
  query: "knowledge_search",
  data: {
    results: Array<{
      type: "concept" | "file" | "decision";
      id: string;
      label: string;
      description: string;
      relevanceScore: number;
      relatedNodes: string[];
    }>;
    totalResults: number;
  },
  summary: "Найдено 7 результатов по запросу 'аутентификация'"
}
```

### 6.3 `code_shadow_memory_write`

Запись в персистентную память Shadow. Заменяет `ctx_memory` для проектов,
использующих Code Shadow.

```typescript
// src/tools/memory-write.ts

interface MemoryWriteInput {
  content: string;
  category: "PROJECT_RULES" | "ARCHITECTURE" | "CONSTRAINTS" | "CONFIG_VALUES" | "NAMING";
  type?: "memory" | "decision";  // memory — факт, decision — ADR
  /** Только для type=decision */
  decisionContext?: string;
  decisionConsequences?: string;
  tags?: string[];
}

async function handleMemoryWrite(
  input: MemoryWriteInput,
  storage: StorageEngine
): Promise<{ success: boolean; id: number | string; type: string }> {
  if (input.type === "decision") {
    // Записываем как архитектурное решение
    const result = storage.getDb().prepare(`
      INSERT INTO decisions (title, context, decision, consequences, status, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?)
    `).run(
      input.content.slice(0, 100), // title — первые 100 символов
      input.decisionContext || null,
      input.content,
      input.decisionConsequences || null,
      JSON.stringify(input.tags || []),
      Date.now(),
      Date.now()
    );

    return { success: true, id: result.lastInsertRowid as number, type: "decision" };
  }

  // Записываем как факт в граф знаний
  const nodeId = `memory:${Date.now()}:${input.category}`;
  storage.getDb().prepare(`
    INSERT INTO knowledge_nodes (id, type, label, description, metadata, created_at, updated_at)
    VALUES (?, 'concept', ?, ?, ?, ?, ?)
  `).run(
    nodeId,
    input.content.slice(0, 80),
    input.content,
    JSON.stringify({ category: input.category, tags: input.tags || [] }),
    Date.now(),
    Date.now()
  );

  return { success: true, id: nodeId, type: "memory" };
}
```

### 6.4 `code_shadow_memory_search`

Поиск по персистентной памяти. Заменяет `ctx_search`.

```typescript
// src/tools/memory-search.ts

interface MemorySearchInput {
  query: string;
  sources?: Array<"memory" | "decisions" | "knowledge" | "history">;
  limit?: number;
}

async function handleMemorySearch(
  input: MemorySearchInput,
  storage: StorageEngine
): Promise<{ results: unknown[]; total: number }> {
  const db = storage.getDb();
  const sources = input.sources || ["memory", "decisions", "knowledge", "history"];
  const limit = input.limit || 10;
  const results: unknown[] = [];
  const searchPattern = `%${input.query}%`;

  if (sources.includes("memory") || sources.includes("knowledge")) {
    const nodes = db.prepare(`
      SELECT id, type, label, description, metadata
      FROM knowledge_nodes
      WHERE label LIKE ? OR description LIKE ?
      LIMIT ?
    `).all(searchPattern, searchPattern, limit);
    results.push(...nodes);
  }

  if (sources.includes("decisions")) {
    const decisions = db.prepare(`
      SELECT id, title, context, decision, status, tags, created_at
      FROM decisions
      WHERE title LIKE ? OR decision LIKE ? OR context LIKE ?
      LIMIT ?
    `).all(searchPattern, searchPattern, searchPattern, limit);
    results.push(...decisions);
  }

  if (sources.includes("history")) {
    const history = db.prepare(`
      SELECT id, file_path, agent_type, recorded_at,
             SUBSTR(diff_content, 1, 200) as diff_preview
      FROM file_edits
      WHERE file_path LIKE ? OR diff_content LIKE ?
      ORDER BY recorded_at DESC
      LIMIT ?
    `).all(searchPattern, searchPattern, limit);
    results.push(...history);
  }

  return {
    results: results.slice(0, limit),
    total: results.length,
  };
}
```

### 6.5 `code_shadow_memory_note`

Создание заметки/напоминания. Заменяет `ctx_note`.

```typescript
// src/tools/memory-note.ts

interface MemoryNoteInput {
  action: "write" | "read" | "dismiss" | "update";
  content?: string;
  noteId?: number;
  surfaceCondition?: string;
  filter?: "all" | "active" | "pending" | "ready" | "dismissed";
}

async function handleMemoryNote(
  input: MemoryNoteInput,
  storage: StorageEngine
): Promise<unknown> {
  const db = storage.getDb();

  // Используем таблицу analytics_cache для хранения заметок
  switch (input.action) {
    case "write":
      const noteId = Date.now();
      db.prepare(`
        INSERT INTO analytics_cache (cache_key, category, json_value, computed_at)
        VALUES (?, 'note', ?, ?)
      `).run(
        `note:${noteId}`,
        JSON.stringify({
          content: input.content,
          surfaceCondition: input.surfaceCondition || null,
          status: "active",
          createdAt: Date.now(),
        }),
        Date.now()
      );
      return { success: true, noteId };

    case "read":
      const notes = db.prepare(`
        SELECT cache_key, json_value, computed_at
        FROM analytics_cache
        WHERE category = 'note'
        ORDER BY computed_at DESC
        LIMIT 25
      `).all();
      return {
        notes: notes.map((n: any) => ({
          id: n.cache_key.replace("note:", ""),
          ...JSON.parse(n.json_value),
        })),
      };

    case "dismiss":
      db.prepare(`
        UPDATE analytics_cache
        SET json_value = JSON_SET(json_value, '$.status', 'dismissed')
        WHERE cache_key = ?
      `).run(`note:${input.noteId}`);
      return { success: true };

    case "update":
      db.prepare(`
        UPDATE analytics_cache
        SET json_value = JSON_SET(json_value, '$.content', ?)
        WHERE cache_key = ?
      `).run(input.content, `note:${input.noteId}`);
      return { success: true };

    default:
      return { success: false, error: "Unknown action" };
  }
}
```

### 6.6 `code_shadow_context_inject`

Внедрение проектного контекста из базы Shadow в текущую сессию.

```typescript
// src/tools/context-inject.ts

interface ContextInjectInput {
  include?: Array<"hotspots" | "decisions" | "dependencies" | "file_history" | "stats">;
  targetFile?: string;         // Для инъекции контекста, специфичного для файла
  maxItems?: number;           // Максимум элементов каждого типа
}

async function handleContextInject(
  input: ContextInjectInput,
  storage: StorageEngine,
  analytics: AnalyticsEngine
): Promise<{ injected: string[]; contextBlock: string }> {
  const include = input.include || ["hotspots", "decisions", "dependencies"];
  const maxItems = input.maxItems || 5;
  const blocks: string[] = [];
  const injected: string[] = [];

  if (include.includes("hotspots")) {
    const hotspots = await analytics.computeHotspots();
    blocks.push(
      "## Горячие точки проекта",
      ...hotspots.slice(0, maxItems).map(h =>
        `- \`${h.filePath}\` (score: ${h.score}): ${h.explanation}`
      )
    );
    injected.push("hotspots");
  }

  if (include.includes("decisions")) {
    const decisions = storage.getDb().prepare(`
      SELECT title, decision, status FROM decisions
      WHERE status IN ('accepted', 'proposed')
      ORDER BY updated_at DESC LIMIT ?
    `).all(maxItems);

    if (decisions.length > 0) {
      blocks.push(
        "## Архитектурные решения",
        ...(decisions as any[]).map(d =>
          `- [${d.status}] **${d.title}**: ${d.decision.slice(0, 200)}`
        )
      );
      injected.push("decisions");
    }
  }

  if (include.includes("dependencies") && input.targetFile) {
    const deps = storage.getDb().prepare(`
      SELECT ke.target_node_id, ke.relation_type, ke.weight
      FROM knowledge_edges ke
      WHERE ke.source_node_id = ?
         OR ke.target_node_id = ?
    `).all(`file:${input.targetFile}`, `file:${input.targetFile}`);

    if (deps.length > 0) {
      blocks.push(
        `## Зависимости файла \`${input.targetFile}\``,
        ...(deps as any[]).map(d =>
          `- ${d.relation_type}: \`${d.target_node_id.replace("file:", "")}\` (weight: ${d.weight})`
        )
      );
      injected.push("dependencies");
    }
  }

  if (include.includes("file_history") && input.targetFile) {
    const history = storage.getDb().prepare(`
      SELECT agent_type, lines_added, lines_removed, recorded_at
      FROM file_edits WHERE file_path = ?
      ORDER BY recorded_at DESC LIMIT ?
    `).all(input.targetFile, maxItems);

    if (history.length > 0) {
      blocks.push(
        `## История изменений \`${input.targetFile}\``,
        ...(history as any[]).map(h =>
          `- ${new Date(h.recorded_at).toISOString()}: ${h.agentType}, +${h.lines_added}/-${h.lines_removed} строк`
        )
      );
      injected.push("file_history");
    }
  }

  if (include.includes("stats")) {
    const profile = await analytics.getDeveloperProfile();
    blocks.push(
      "## Статистика разработчика",
      `- AI-Reliance ratio: ${profile.aiRelianceRatio}`,
      `- Fix rate: ${profile.fixRate}`,
      `- Сессий в день: ${profile.sessionsPerDay}`
    );
    injected.push("stats");
  }

  const contextBlock = blocks.join("\n");

  return { injected, contextBlock };
}
```

---

## 7. Диаграммы потоков данных

### 7.1 Сценарий «Файл изменён»

```
Пользователь/AI редактирует файл
│
▼
┌──────────────────────────────────────────────────────────────────┐
│  Event Bus: "file.edited"                                        │
│  { path, sessionId, agentType, diff, linesAdded, linesRemoved }  │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  Observer Engine: handleFileEdited()                             │
│                                                                  │
│  1. Извлекает расширение файла                                   │
│  2. Приводит путь к относительному                               │
│  3. Фильтрует секреты из диффа                                   │
│  4. Если diff > 500 строк — обрезает                             │
│  5. Вызывает storage.insert("file_edits", data)                  │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  Storage Engine: INSERT INTO file_edits (...)                    │
│                                                                  │
│  SQLite WAL mode:                                                │
│  ┌──────────────────────────────────────────┐                   │
│  │  data.db          data.db-wal   data.db-shm                  │
│  │  [основной файл]  [журнал]      [индекс WAL]                 │
│  └──────────────────────────────────────────┘                   │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  Analytics Engine: incrementEventCounter()                       │
│                                                                  │
│  Счётчик событий увеличивается.                                  │
│  Если достигнут порог (каждые N событий или прошло T секунд):    │
│  ┌──────────────────────────────────────────────────────┐       │
│  │  analytics.recomputeHotspots()   — дебаунс 60 сек    │       │
│  │  analytics.updateKnowledgeGraph() — дебаунс 300 сек  │       │
│  │  analytics.recomputeDeveloperProfile() — дебаунс 600 │       │
│  └──────────────────────────────────────────────────────┘       │
└──────────────────────────────────────────────────────────────────┘
```

### 7.2 Сценарий «Сессия завершена»

```
Пользователь прекратил взаимодействие
│
▼
┌──────────────────────────────────────────────────────────────────┐
│  Event Bus: "session.idle"                                       │
│  { sessionId, timestamp }                                        │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  Observer Engine: handleSessionIdle()                            │
│                                                                  │
│  1. Находит сессию в БД по sessionId                             │
│  2. Вычисляет длительность (timestamp - started_at)              │
│  3. Обновляет статус → "completed"                               │
│  4. Запускает пересчёт аналитики                                 │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  Analytics Engine (три параллельных процесса):                    │
│                                                                  │
│  ┌───────────────────┐  ┌───────────────────┐  ┌──────────────┐ │
│  │ recomputeHotspots │  │ recomputeDeveloper│  │ updateKnowl- │ │
│  │                   │  │ Profile           │  │ edgeGraph    │ │
│  │ • Частота правок  │  │ • Сессий в день   │  │ • Импорты    │ │
│  │ • Частота ошибок  │  │ • Длительность    │  │ • Co-change  │ │
│  │ • Фрустрация      │  │ • AI-Reliance     │  │ • Причины    │ │
│  │ • Сохранение в    │  │ • Fix rate        │  │   ошибок     │ │
│  │   analytics_cache │  │ • Тренды          │  │ • Обновление │ │
│  └───────────────────┘  └───────────────────┘  │   рёбер      │ │
│                                                └──────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### 7.3 Сценарий «AI вызывает shadow-тулз»

```
AI-агент (Claude/GPT) формирует запрос
│
▼
┌──────────────────────────────────────────────────────────────────┐
│  Prompt: "Проанализируй риски изменения src/auth/login.ts"       │
│                                                                  │
│  AI решает вызвать: code_shadow_analyze                          │
│  { query: "predict_change", filePath: "src/auth/login.ts" }      │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  OpenCode Plugin System → Tool Execution                         │
│                                                                  │
│  Прежде чем выполнить тулз:                                      │
│  ┌──────────────────────────────────────────────────┐           │
│  │  Observer: handleToolExecuteBefore()             │           │
│  │  • Проверяет исторический риск                   │           │
│  │  • Если риск > порог → TUI Toast Warning         │           │
│  └──────────────────────────────────────────────────┘           │
│                                                                  │
│  Выполняется сам тулз:                                           │
│  ┌──────────────────────────────────────────────────┐           │
│  │  code_shadow_analyze handler()                   │           │
│  │                                                   │           │
│  │  1. Парсит входные параметры                      │           │
│  │  2. Вызывает analytics.predictRisk([filePath])    │           │
│  │  3. Форматирует ответ                             │           │
│  │  4. Возвращает структурированные данные AI         │           │
│  └──────────────────────────────────────────────────┘           │
│                                                                  │
│  После выполнения тулза:                                         │
│  ┌──────────────────────────────────────────────────┐           │
│  │  Observer: handleToolExecuteAfter()              │           │
│  │  • Записывает в tool_executions                  │           │
│  │  • Обновляет счётчики сессии                     │           │
│  └──────────────────────────────────────────────────┘           │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  AI получает ответ:                                              │
│                                                                  │
│  {                                                               │
│    query: "predict_change",                                     │
│    data: {                                                       │
│      riskScore: 0.72,                                           │
│      riskLevel: "high",                                         │
│      affectedFiles: [                                           │
│        { path: "src/auth/session.ts", breakageProbability: 0.6 },│
│        { path: "src/db/users.ts", breakageProbability: 0.4 }    │
│      ],                                                          │
│      recommendation: "Рекомендуется запустить тесты..."         │
│    }                                                             │
│  }                                                               │
│                                                                  │
│  AI использует эти данные для принятия решения и продолжает      │
│  работу с учётом контекста рисков                                │
└──────────────────────────────────────────────────────────────────┘
```

### 7.4 Общая схема потоков данных

```
                        ┌──────────────────┐
                        │   OpenCode Core  │
                        │   (Event Emitter) │
                        └────────┬─────────┘
                                 │
          ┌──────────────────────┼──────────────────────┐
          │                      │                      │
          ▼                      ▼                      ▼
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│  file.edited    │   │  session.*      │   │  tool.execute.* │
│  lsp.diagnostics│   │  message.*      │   │  command.*      │
│                 │   │  todo.*         │   │                 │
└────────┬────────┘   └────────┬────────┘   └────────┬────────┘
         │                     │                     │
         └─────────────────────┼─────────────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │   Observer Engine   │
                    │   (11 handlers)     │
                    └──────────┬──────────┘
                               │
                     ┌─────────┴─────────┐
                     ▼                   ▼
          ┌──────────────────┐  ┌──────────────────┐
          │  Storage Engine  │  │  TUI Integration │
          │  (SQLite WAL)    │  │  (Toast/Commands)│
          └────────┬─────────┘  └──────────────────┘
                   │
                   ▼
          ┌──────────────────┐
          │ Analytics Engine │
          │ • Hotspots       │
          │ • Prediction     │
          │ • Knowledge Graph│
          │ • Dev Profile    │
          └────────┬─────────┘
                   │
                   ▼
          ┌──────────────────┐       ┌──────────────────┐
          │ analytics_cache  │──────▶│  AI Tools         │
          │ (предвычисления) │       │  (query/response) │
          └──────────────────┘       └──────────────────┘
```

---

## 8. Жизненный цикл плагина

### 8.1 Bootstrap (Запуск)

При первом запуске (или после длительного перерыва) плагин выполняет
инициализирующее сканирование для построения базового состояния.

```typescript
// src/bootstrap.ts

export async function bootstrap(ctx: PluginContext, storage: StorageEngine): Promise<void> {
  const config = ctx.config;
  const db = storage.getDb();

  // Проверяем, был ли уже выполнен бутстрап
  const bootstrapped = db.prepare(`
    SELECT numeric_value FROM analytics_cache WHERE cache_key = 'bootstrap:completed'
  `).get() as { numeric_value: number } | undefined;

  if (bootstrapped?.numeric_value) {
    console.log("[CodeShadow] Бутстрап уже выполнен, пропускаем");
    return;
  }

  console.log("[CodeShadow] Выполняется инициализация (бутстрап)...");

  // 1. Сканируем существующие файлы проекта
  const projectFiles = await scanProjectFiles(ctx.workspaceRoot);

  for (const file of projectFiles) {
    db.prepare(`
      INSERT OR IGNORE INTO knowledge_nodes (id, type, label, created_at, updated_at)
      VALUES (?, 'file', ?, ?, ?)
    `).run(`file:${file}`, file, Date.now(), Date.now());
  }

  // 2. Анализируем git-историю (если доступна)
  if (config.bootstrap?.scanGitHistory) {
    await scanGitHistory(ctx.workspaceRoot, storage);
  }

  // 3. Сканируем историю сессий OpenCode (если доступна)
  if (config.bootstrap?.scanSessionHistory) {
    await scanSessionHistory(ctx, storage);
  }

  // 4. Парсим импорты из всех файлов для построения графа
  await parseAllImports(projectFiles, storage);

  // 5. Помечаем бутстрап как выполненный
  db.prepare(`
    INSERT OR REPLACE INTO analytics_cache (cache_key, category, numeric_value, computed_at)
    VALUES ('bootstrap:completed', 'system', 1, ?)
  `).run(Date.now());

  console.log(`[CodeShadow] Бутстрап завершён: ${projectFiles.length} файлов проиндексировано`);
}
```

### 8.2 Runtime (Работа)

```
┌─────────────────────────────────────────────────────────────────┐
│                       RUNTIME CYCLE                              │
│                                                                  │
│  ┌──────────┐     ┌──────────┐     ┌──────────┐                │
│  │ Событие  │────▶│ Observer │────▶│ Storage  │                │
│  │ от ODE   │     │ Handler  │     │ Write    │                │
│  └──────────┘     └──────────┘     └────┬─────┘                │
│                                         │                        │
│                                         ▼                        │
│                              ┌─────────────────────┐            │
│                              │ Event Counter += 1  │            │
│                              └─────────┬───────────┘            │
│                                        │                        │
│                          Достигнут порог?                       │
│                          (каждые 50 событий ИЛИ 60 сек)          │
│                               │                                  │
│                    ┌──────────┴──────────┐                      │
│                    ▼                     ▼                      │
│           ┌──────────────┐      ┌──────────────┐              │
│           │ Debounce     │      │ Force        │              │
│           │ Timer Active?│      │ Recompute    │              │
│           └──────┬───────┘      │ (TTL истёк)  │              │
│                  │              └──────────────┘              │
│                  ▼                                             │
│           ┌──────────────┐                                     │
│           │ Сброс таймера│                                     │
│           │ (продлеваем) │                                     │
│           └──────────────┘                                     │
│                                                                  │
│  Периодические задачи (независимые интервалы):                    │
│  ┌───────────────────────┐  ┌───────────────────────┐          │
│  │ Hotspots recompute    │  │ Knowledge Graph sync  │          │
│  │ Интервал: 5 минут     │  │ Интервал: 30 минут     │          │
│  └───────────────────────┘  └───────────────────────┘          │
│  ┌───────────────────────┐  ┌───────────────────────┐          │
│  │ Dev Profile recompute │  │ Data Retention cleanup│          │
│  │ Интервал: 15 минут    │  │ Интервал: 1 час       │          │
│  └───────────────────────┘  └───────────────────────┘          │
└─────────────────────────────────────────────────────────────────┘
```

### 8.3 Shutdown (Завершение)

```typescript
// src/shutdown.ts

export function registerShutdown(ctx: PluginContext, storage: StorageEngine): void {
  ctx.hooks.on("plugin.shutdown", async () => {
    console.log("[CodeShadow] Завершение работы...");

    const db = storage.getDb();

    // 1. Финализируем незавершённые сессии
    db.prepare(`
      UPDATE sessions SET status = 'completed', completed_at = ?
      WHERE status = 'active'
    `).run(Date.now());

    // 2. Сбрасываем буфер событий (если есть несохранённые)
    storage.flushBuffer();

    // 3. Выполняем последний пересчёт аналитики
    const analytics = storage.getAnalytics();
    await analytics.forceRecomputeAll();

    // 4. Выполняем checkpoint WAL (переносим журнал в основной файл)
    db.pragma("wal_checkpoint(TRUNCATE)");

    // 5. Закрываем соединение с БД
    db.close();

    console.log("[CodeShadow] Работа завершена");
  });
}
```

### 8.4 Upgrade (Обновление плагина)

```typescript
// src/upgrade.ts

export async function handleUpgrade(
  ctx: PluginContext,
  storage: StorageEngine,
  previousVersion: string,
  newVersion: string
): Promise<void> {
  const db = storage.getDb();

  console.log(`[CodeShadow] Обновление: ${previousVersion} → ${newVersion}`);

  // 1. Сохраняем текущую версию
  db.prepare(`
    INSERT OR REPLACE INTO analytics_cache (cache_key, category, text_value, computed_at)
    VALUES ('system:version', 'system', ?, ?)
  `).run(newVersion, Date.now());

  // 2. Версионированные миграции
  if (compareVersions(previousVersion, "1.1.0") < 0) {
    // Миграция на 1.1.0
    console.log("[CodeShadow] Применяем миграции для v1.1.0...");
    db.exec(`
      ALTER TABLE file_edits ADD COLUMN language TEXT;
      ALTER TABLE sessions ADD COLUMN project_name TEXT;
    `);
  }

  if (compareVersions(previousVersion, "1.2.0") < 0) {
    console.log("[CodeShadow] Применяем миграции для v1.2.0...");
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_todos (
        session_id TEXT NOT NULL,
        todo_id TEXT NOT NULL,
        completed_at INTEGER,
        PRIMARY KEY (session_id, todo_id)
      );
    `);
  }

  // 3. Инвалидируем кеш аналитики (требуется полный пересчёт)
  db.prepare(`
    DELETE FROM analytics_cache WHERE category != 'system'
  `).run();

  // 4. Запускаем полный пересчёт
  analytics.forceRecomputeAll();

  console.log("[CodeShadow] Обновление завершено");
}
```

---

## 9. Производительность

### 9.1 Стратегии оптимизации

| Стратегия                     | Описание                                                     |
|-------------------------------|--------------------------------------------------------------|
| **SQLite WAL mode**           | Конкурентные чтения во время записи. Без блокировок на чтение |
| **Синхронные записи**         | `bun:sqlite` — синхронный, но экстремально быстрый        |
| **Батчинг событий**           | События буферизируются (до 10 событий) и сбрасываются в БД пачкой |
| **Дебаунс аналитики**         | Пересчёт не на каждое событие, а с задержкой (debounce)       |
| **Обрезка диффов**            | Diff > 500 строк сохраняется с пометкой `[truncated]`         |
| **Индексная стратегия**       | Индексы на часто запрашиваемые колонки: session_id, file_path, timestamp |
| **TTL-кеш аналитики**         | Предвычисленные результаты кешируются в `analytics_cache`      |
| **Периодическая очистка**     | Старые сырые данные удаляются, аналитика хранится бессрочно    |
| **Ленивая загрузка графа**    | Граф знаний загружается по требованию, а не весь сразу        |

### 9.2 Буферизация событий

```typescript
// src/storage/buffer.ts

export class EventBuffer {
  private buffer: Array<{
    table: string;
    data: Record<string, unknown>;
  }> = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private db: Database,
    private maxSize: number = 10,
    private maxWaitMs: number = 1000
  ) {}

  enqueue(table: string, data: Record<string, unknown>): void {
    this.buffer.push({ table, data });

    if (this.buffer.length >= this.maxSize) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.maxWaitMs);
    }
  }

  flush(): void {
    if (this.buffer.length === 0) return;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const batch = [...this.buffer];
    this.buffer = [];

    const insert = this.db.transaction(() => {
      for (const { table, data } of batch) {
        const columns = Object.keys(data).join(", ");
        const placeholders = Object.keys(data).map(() => "?").join(", ");
        const values = Object.values(data);

        this.db.prepare(
          `INSERT INTO ${table} (${columns}) VALUES (${placeholders})`
        ).run(...values);
      }
    });

    insert();
  }
}
```

### 9.3 Дебаунс пересчёта аналитики

```typescript
// src/analytics/debounce.ts

export class AnalyticsScheduler {
  private eventCounter = 0;
  private lastRecompute = Date.now();
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(
    private analytics: AnalyticsEngine,
    private thresholds: {
      eventCount: number;    // 50 событий
      timeMs: number;        // 60 секунд
    } = { eventCount: 50, timeMs: 60_000 }
  ) {}

  incrementEventCounter(): void {
    this.eventCounter++;

    const timeSinceLastRecompute = Date.now() - this.lastRecompute;

    if (this.eventCounter >= this.thresholds.eventCount ||
        timeSinceLastRecompute >= this.thresholds.timeMs) {
      this.scheduleRecompute();
    }
  }

  private scheduleRecompute(): void {
    // Дебаунсим: сбрасываем предыдущий таймер, ставим новый
    const existingTimer = this.timers.get("full");
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
      this.eventCounter = 0;
      this.lastRecompute = Date.now();
      this.analytics.forceRecomputeAll();
      this.timers.delete("full");
    }, 5_000); // Ждём 5 секунд бездействия перед пересчётом

    this.timers.set("full", timer);
  }
}
```

### 9.4 Профили запросов

Ниже приведены типичные запросы и их ожидаемая производительность на проекте
среднего размера (10K файлов, 50K событий, 100 сессий):

| Запрос                                   | Без индексов | С индексами | Кеширован |
|------------------------------------------|-------------|------------|-----------|
| Hotspots топ-20                          | ~800ms      | ~120ms     | <5ms      |
| Predicted risk (зависимости до 50)       | ~200ms      | ~30ms      | <2ms      |
| История файла (100 записей)              | ~150ms      | ~8ms       | <1ms      |
| Профиль разработчика                     | ~600ms      | ~90ms      | <3ms      |
| Поиск по графу знаний (1000 узлов)       | ~300ms      | ~15ms      | <3ms      |

---

## 10. Безопасность и приватность

### 10.1 Принципы

```
┌─────────────────────────────────────────────────────────────────┐
│                  ПРИНЦИПЫ БЕЗОПАСНОСТИ CODE SHADOW               │
│                                                                  │
│  🔒 ВСЕ ДАННЫЕ ЛОКАЛЬНЫ — ничего не отправляется вовне           │
│  🔒 NO TELEMETRY — плагин не содержит телеметрии                 │
│  🔒 ФИЛЬТРАЦИЯ СЕКРЕТОВ — .env, ключи, токены не сохраняются    │
│  🔒 МАШИННАЯ ИДЕНТИЧНОСТЬ — не привязана к личности             │
│  🔒 ОПТ-АУТ — можно отключить конкретные типы событий            │
│  🔒 ЭКСПОРТ/УДАЛЕНИЕ — полный контроль над своими данными        │
└─────────────────────────────────────────────────────────────────┘
```

### 10.2 Фильтрация секретов

```typescript
// src/security/secret-filter.ts

const SECRET_PATTERNS = [
  /(?:api[_-]?key|apikey|secret|token|password|passwd|auth)\s*[:=]\s*['"][^'"]+['"]/gi,
  /(?:-----BEGIN\s(?:RSA\s)?PRIVATE\sKEY-----)/gi,
  /(?:[A-Za-z0-9+/]{40,})/,  // Длинные base64 строки (потенциальные токены)
  /(?:mongodb(?:\+srv)?:\/\/[^@\s]+@)/gi,  // Строки подключения
  /(?:DATABASE_URL|REDIS_URL|AWS_SECRET|GITHUB_TOKEN)\s*=\s*[^\s]+/gi,
];

const ENV_FILE_PATTERNS = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "credentials.json",
  "service-account.json",
  "secrets.yaml",
  "secrets.yml",
];

export function filterSecrets(content: string): string {
  let filtered = content;

  for (const pattern of SECRET_PATTERNS) {
    filtered = filtered.replace(pattern, "***[SECRET FILTERED]***");
  }

  return filtered;
}

export function isSecretFile(filePath: string): boolean {
  const basename = filePath.split(/[\\/]/).pop() || "";
  return ENV_FILE_PATTERNS.some(pattern =>
    basename === pattern || basename.endsWith(pattern)
  );
}

export function shouldSkipFile(filePath: string): boolean {
  // Пропускаем файлы секретов полностью
  if (isSecretFile(filePath)) return true;

  // Пропускаем node_modules, бинарные файлы
  if (filePath.includes("node_modules")) return true;

  return false;
}
```

### 10.3 Санитизация аргументов тулзов

```typescript
// src/security/sanitize-args.ts

export function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = [
    "apiKey", "api_key", "apikey",
    "token", "secret", "password", "passwd",
    "authorization", "auth",
  ];

  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    const keyLower = key.toLowerCase();

    if (sensitiveKeys.some(sk => keyLower.includes(sk))) {
      sanitized[key] = "***[REDACTED]***";
    } else if (typeof value === "string" && value.length > 1000) {
      sanitized[key] = value.slice(0, 200) + "...[TRUNCATED]";
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}
```

### 10.4 Конфигурация приватности

```typescript
// src/config/privacy.ts

interface PrivacyConfig {
  enabled: boolean;
  retentionDays: number;        // Дней хранения сырых данных (по умолчанию: 90)
  analyticsRetention: "forever" | number; // Хранение аналитики
  excludedEventTypes: string[]; // Типы событий, которые НЕ отслеживаются
  excludedPaths: string[];      // Пути, исключённые из мониторинга
  filterSecrets: boolean;       // Фильтровать секреты (по умолчанию: true)
  maxDiffLines: number;         // Максимум строк диффа для хранения
}

// Пример конфигурации в opencode.json:
// {
//   "plugins": {
//     "code-shadow": {
//       "privacy": {
//         "enabled": true,
//         "retentionDays": 30,
//         "excludedEventTypes": ["lsp.client.diagnostics"],
//         "excludedPaths": ["node_modules", ".git", "dist", "build"],
//         "filterSecrets": true,
//         "maxDiffLines": 500
//       }
//     }
//   }
// }
```

### 10.5 Экспорт и удаление данных

```typescript
// src/data-control.ts

interface DataControlResult {
  success: boolean;
  message: string;
  path?: string;
}

export async function exportData(storage: StorageEngine): Promise<DataControlResult> {
  const db = storage.getDb();
  const exportPath = path.join(ctx.configDir, "shadow", "export.json");

  const data = {
    exportedAt: new Date().toISOString(),
    statistics: {
      totalFileEdits: db.prepare("SELECT COUNT(*) as cnt FROM file_edits").get(),
      totalSessions: db.prepare("SELECT COUNT(*) as cnt FROM sessions").get(),
      totalErrors: db.prepare("SELECT COUNT(*) as cnt FROM session_errors").get(),
      totalToolCalls: db.prepare("SELECT COUNT(*) as cnt FROM tool_executions").get(),
    },
    hotspots: JSON.parse((db.prepare(
      "SELECT json_value FROM analytics_cache WHERE cache_key = 'hotspots:full'"
    ).get() as any)?.json_value || "[]"),
    developerProfile: await getDeveloperProfile(storage),
    // Не экспортируем сырые диффы (могут содержать чувствительные данные)
  };

  fs.writeFileSync(exportPath, JSON.stringify(data, null, 2), "utf-8");

  return {
    success: true,
    message: `Данные экспортированы в ${exportPath}`,
    path: exportPath,
  };
}

export async function deleteAllData(storage: StorageEngine): Promise<DataControlResult> {
  const db = storage.getDb();

  // Удаляем все данные из всех таблиц
  const tables = [
    "file_edits", "sessions", "session_errors", "tool_executions",
    "decisions", "knowledge_nodes", "knowledge_edges",
    "developer_events", "analytics_cache", "risk_warnings",
    "session_compactions", "lsp_diagnostics", "command_usage",
    "todos", "developer_profile",
  ];

  db.transaction(() => {
    for (const table of tables) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
  })();

  // Сбрасываем автоинкременты
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");

  return {
    success: true,
    message: "Все данные Code Shadow удалены. База данных очищена.",
  };
}
```

---

## Приложение А: Структура директорий проекта

```
code-shadow/
├── src/
│   ├── index.ts                   # Точка входа плагина
│   ├── bootstrap.ts               # Инициализация при первом запуске
│   ├── upgrade.ts                 # Миграции при обновлении версии
│   ├── shutdown.ts                # Корректное завершение
│   │
│   ├── observer/                  # Движок наблюдения
│   │   ├── index.ts               # createObserverEngine()
│   │   └── handlers/
│   │       ├── file-edited.ts
│   │       ├── session-created.ts
│   │       ├── session-idle.ts
│   │       ├── session-error.ts
│   │       ├── session-compacted.ts
│   │       ├── tool-execute-before.ts
│   │       ├── tool-execute-after.ts
│   │       ├── lsp-diagnostics.ts
│   │       ├── command-executed.ts
│   │       ├── message-updated.ts
│   │       └── todo-updated.ts
│   │
│   ├── storage/                   # Движок хранения
│   │   ├── index.ts               # createStorageEngine()
│   │   ├── buffer.ts              # Буферизация событий
│   │   ├── retention.ts           # Очистка старых данных
│   │   ├── query-builder.ts       # Построитель SQL-запросов
│   │   └── migrations/
│   │       ├── runner.ts          # Движок миграций
│   │       ├── 001_initial.sql    # Начальная схема
│   │       └── 002_indexes.sql    # Добавление индексов
│   │
│   ├── analytics/                 # Движок аналитики
│   │   ├── index.ts               # createAnalyticsEngine()
│   │   ├── hotspots.ts            # Алгоритм Hotspot
│   │   ├── prediction.ts          # Алгоритм предсказания риска
│   │   ├── developer-profile.ts   # Профиль разработчика
│   │   ├── knowledge-graph.ts     # Построение графа знаний
│   │   ├── trends.ts              # Анализ трендов
│   │   └── debounce.ts            # Дебаунс-планировщик
│   │
│   ├── tui/                       # Интеграция с TUI
│   │   ├── index.ts               # createTuiIntegration()
│   │   ├── toasts.ts              # Тост-уведомления
│   │   ├── commands.ts            # Команды /shadow
│   │   └── context-injection.ts   # Инъекция контекста
│   │
│   ├── tools/                     # AI-тулзы
│   │   ├── index.ts               # createAiTools()
│   │   ├── analyze.ts             # code_shadow_analyze
│   │   ├── memory-write.ts        # code_shadow_memory_write
│   │   ├── memory-search.ts       # code_shadow_memory_search
│   │   ├── memory-note.ts         # code_shadow_memory_note
│   │   └── context-inject.ts      # code_shadow_context_inject
│   │
│   ├── security/                  # Безопасность
│   │   ├── secret-filter.ts       # Фильтрация секретов
│   │   └── sanitize-args.ts       # Санитизация аргументов
│   │
│   ├── data-control.ts            # Экспорт/удаление данных
│   └── types.ts                   # Общие типы и интерфейсы
│
├── docs/
│   └── ARCHITECTURE.md            # Этот документ
│
├── tests/
│   ├── observer.test.ts
│   ├── storage.test.ts
│   ├── analytics.test.ts
│   └── integration.test.ts
│
├── package.json
├── tsconfig.json
└── README.md
```

---

## Приложение Б: Глоссарий

| Термин                   | Определение                                                     |
|--------------------------|-----------------------------------------------------------------|
| **AI-Reliance Ratio**    | Доля кода, написанного AI, от общего объёма изменений           |
| **Fix Rate**             | Доля AI-кода, которая была впоследствии исправлена человеком     |
| **Hotspot**              | Файл с высоким рейтингом проблемности (частые правки + ошибки)  |
| **WAL**                  | Write-Ahead Logging — режим SQLite для конкурентного доступа    |
| **Бутстрап**             | Процесс инициализации плагина: сканирование истории и файлов    |
| **Граф знаний**          | Семантическая сеть файлов, модулей и концепций с отношениями    |
| **Дебаунс**              | Техника отложенного выполнения: ждём N мс бездействия           |
| **Компактизация**        | Сжатие контекста сессии с сохранением ключевой информации       |
| **ADR**                  | Architecture Decision Record — запись архитектурного решения    |

---

> **Code Shadow** — коллективная память и предиктивная безопасность для
> AI-ассистированной разработки. Плагин живёт локально, собирает данные о
> вашем проекте и работе AI-агентов, строит аналитику и предупреждает о
> потенциальных проблемах до того, как они возникнут.
>
> Версия документа: 1.0.0 | 2026-07-17
