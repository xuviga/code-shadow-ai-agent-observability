# Code Shadow — API Инструментов для AI-агента

> Сверяйте этот API-документ с фактическим baseline в
> [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md). Примеры ниже описывают
> контракт и могут содержать исторические сигнатуры OpenCode SDK; исполняемый
> источник правды — `src/index.ts` и `src/tools/*.ts`.

> **Версия документа:** 2.0.0 | **Последнее обновление:** 2026-07-18
>
> Полная спецификация инструментов, которые плагин Code Shadow предоставляет
> AI-агенту OpenCode через экспорт `tool:` в плагин-манифесте.

---

## Оглавление

1. [Обзор](#1-обзор)
2. [code_shadow_analyze](#2-code_shadow_analyze)
3. [code_shadow_memory_write](#3-code_shadow_memory_write)
4. [code_shadow_memory_search](#4-code_shadow_memory_search)
5. [code_shadow_memory_note](#5-code_shadow_memory_note)
6. [code_shadow_context_inject](#6-code_shadow_context_inject)
7. [code_shadow_decide](#7-code_shadow_decide)
8. [Рекомендации для AI-агента](#8-рекомендации-для-ai-агента)
9. [Обработка ошибок](#9-обработка-ошибок)
10. [Полный пример регистрации плагина](#10-полный-пример-регистрации-плагина)

---

## 1. Обзор

Code Shadow экспортирует **6 AI-тулзов** через поле `tool` в регистрации плагина
OpenCode. Каждый тулз реализован через фабрику `tool()` из `@opencode-ai/plugin-sdk`
и состоит из четырёх компонентов:

| Компонент   | Назначение                                                            |
|-------------|-----------------------------------------------------------------------|
| **name**    | Уникальный идентификатор с префиксом `code_shadow_`                    |
| **description** | Человекочитаемое описание для AI — объясняет, КОГДА и ЗАЧЕМ вызывать |
| **args**    | Zod-схема аргументов — строгая типизация входных параметров            |
| **execute** | Асинхронная функция `(args, context) => Promise<T>` — логика тулза     |

Каждый тулз возвращает строго типизированный объект. Все возвращаемые структуры
сериализуются в JSON и отображаются AI-агенту в читаемом виде.

Тулзы Code Shadow **заменяют** соответствующие инструменты Magic Context:

| Magic Context      | Code Shadow                | Причина замены                                           |
|--------------------|----------------------------|----------------------------------------------------------|
| `ctx_memory`       | `code_shadow_memory_write` | Структурированное хранение в SQLite вместо текстовых файлов |
| `ctx_search`       | `code_shadow_memory_search`| Поиск по всем сущностям: память, решения, история, аналитика |
| `ctx_note`         | `code_shadow_memory_note`  | Заметки с авто-триггерами на внешних условиях               |
| *нет аналога*      | `code_shadow_analyze`      | Полностью новый: аналитика кодовой базы                     |
| *нет аналога*      | `code_shadow_context_inject`| Полностью новый: инъекция контекста в сессию               |
| *нет аналога*      | `code_shadow_decide`       | Полностью новый: запись архитектурных решений              |

### Анатомия тулза (на примере code_shadow_analyze)

```typescript
import { tool } from "@opencode-ai/plugin-sdk";

tool({
  description: "Анализирует здоровье кодовой базы...",
  args: {
    query: tool.schema.enum([
      "hotspots", "predict_change", "file_history",
      "team_pulse", "my_stats", "dependency_graph",
      "knowledge_search", "decisions_list"
    ]),
    target: tool.schema.string().optional(),
    timeframe: tool.schema.enum(["7d", "30d", "90d", "all"]).optional(),
    limit: tool.schema.number().optional(),
  },
  async execute(args, context) {
    // 1. Валидация аргументов (дополнительная — Zod уже проверил типы)
    // 2. Маршрутизация по значению args.query
    // 3. SQL-запрос к data.db через Storage Engine
    // 4. Формирование типизированного ответа
    // 5. Возврат результата
  },
});
```

Все тулзы объединяются в единый объект экспорта:

```typescript
// src/tools/index.ts
export function createAiTools(
  ctx: PluginContext,
  storage: StorageEngine,
  analytics: AnalyticsEngine
): PluginRegistration["tools"] {
  return {
    code_shadow_analyze:        createAnalyzeTool(ctx, storage, analytics),
    code_shadow_memory_write:   createMemoryWriteTool(ctx, storage),
    code_shadow_memory_search:  createMemorySearchTool(ctx, storage),
    code_shadow_memory_note:    createMemoryNoteTool(ctx, storage),
    code_shadow_context_inject: createContextInjectTool(ctx, storage, analytics),
    code_shadow_decide:         createDecideTool(ctx, storage),
  };
}
```

---

## 2. code_shadow_analyze

**Назначение:** Главный аналитический тулз Code Shadow. Query-ориентированный
дизайн — один тулз, 9 режимов работы. Предоставляет объективные, измеримые данные
о кодовой базе, исключая догадки и субъективные мнения AI.

### Декларация тулза

```typescript
import { tool } from "@opencode-ai/plugin-sdk";

export function createAnalyzeTool(
  ctx: PluginContext,
  storage: StorageEngine,
  analytics: AnalyticsEngine
) {
  return tool({
    description: [
      "Анализирует кодовую базу. ИСПОЛЬЗУЙ АВТОМАТИЧЕСКИ перед изменениями",
      "в незнакомых файлах и для понимания проекта.",
    ].join("\n"),

    args: {
      query: tool.schema.enum([
        "hotspots",
        "predict_change",
        "file_history",
        "team_pulse",
        "my_stats",
        "dependency_graph",
        "knowledge_search",
        "decisions_list",
        "code_errors",
      ]),
      target: tool.schema.string().optional(),
      timeframe: tool.schema.enum(["7d", "30d", "90d", "all"]).optional(),
      limit: tool.schema.number().optional(),
      depth: tool.schema.number().optional(),
    },

    async execute(args, context) {
      // Маршрутизация по типу запроса
      switch (args.query) {
        case "hotspots":         return executeHotspots(storage, args);
        case "predict_change":   return executePredictChange(storage, analytics, args);
        case "file_history":     return executeFileHistory(storage, args);
        case "team_pulse":       return executeTeamPulse(storage, analytics, args);
        case "my_stats":         return executeMyStats(storage, args);
        case "dependency_graph": return executeDependencyGraph(storage, args);
        case "knowledge_search": return executeKnowledgeSearch(storage, args);
        case "decisions_list":   return executeDecisionsList(storage, args);
        case "code_errors":      return executeCodeErrors(storage, args);
        default:
          return { error: `Неизвестный тип запроса: ${args.query}` };
      }
    },
  });
}
```

---

### 2.a Режим "hotspots" — Тепловая карта проблемных файлов

**Назначение:** Ранжирует файлы проекта по проблемному score (0–1).
Чем выше score — тем чаще файл редактируется, тем больше в нём ошибок,
тем более он «фрустрирующий» для разработчика.

**Параметры:**
| Параметр    | Тип     | Обязательный | По умолчанию | Описание                                |
|-------------|---------|-------------|-------------|------------------------------------------|
| `timeframe` | `enum`  | Нет         | `"30d"`     | Окно анализа: 7, 30, 90 дней или всё    |
| `limit`     | `number`| Нет         | `10`        | Максимальное количество файлов в ответе  |

**Логика выполнения:**

```typescript
async function executeHotspots(
  storage: StorageEngine,
  args: { timeframe?: string; limit?: number }
): Promise<HotspotsResult> {
  const days = parseTimeframe(args.timeframe || "30d");
  const limit = args.limit || 10;
  const db = storage.getDb();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  // 1. Собираем агрегированную статистику по каждому файлу
  const rows = db.prepare(`
    SELECT
      fe.file_path,
      COUNT(DISTINCT fe.id) AS total_edits,
      COUNT(DISTINCT se.id) AS errors_caused,
      COUNT(DISTINCT fe.session_id) AS sessions_touched,
      COALESCE(AVG(fe.lines_added + fe.lines_removed), 0) AS avg_lines_changed,
      MAX(fe.recorded_at) AS last_edit,
      -- Frustration: правки одним агентом, после которых был revert
      COUNT(DISTINCT de.id) AS frustration_events
    FROM file_edits fe
    LEFT JOIN session_errors se
      ON se.context_file = fe.file_path
      AND se.recorded_at >= ?
    LEFT JOIN developer_events de
      ON de.event_type = 'human_fix'
      AND de.event_data LIKE '%' || fe.file_path || '%'
      AND de.recorded_at >= ?
    WHERE fe.recorded_at >= ?
    GROUP BY fe.file_path
    ORDER BY total_edits DESC
  `).all(cutoff, cutoff, cutoff);

  // 2. Нормализуем метрики и вычисляем итоговый score
  const allFiles = normalizeAndScore(rows, days);

  // 3. Сортируем по score и обрезаем до limit
  const hotspots = allFiles
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    hotspots,
    generated_at: Date.now(),
    timeframe: args.timeframe || "30d",
    total_files_analyzed: allFiles.length,
  };
}
```

**Формат ответа:**

```json
{
  "hotspots": [
    {
      "file": "src/auth/session.ts",
      "score": 0.87,
      "breakdown": {
        "edit_frequency": 0.9,
        "error_rate": 0.85,
        "recent_changes": 0.7,
        "frustration": 0.95
      },
      "stats": {
        "total_edits": 47,
        "errors_caused": 12,
        "sessions_touched": 23,
        "last_edit": "2026-07-15",
        "avg_lines_changed": 34
      },
      "explanation": "Высокая частота правок (47 за квартал) + 12 ошибок. Файл правили 23 сессии подряд — возможен конфликт архитектурных решений."
    },
    {
      "file": "src/utils/god-object.ts",
      "score": 0.74,
      "breakdown": {
        "edit_frequency": 0.85,
        "error_rate": 0.6,
        "recent_changes": 0.8,
        "frustration": 0.7
      },
      "stats": {
        "total_edits": 38,
        "errors_caused": 8,
        "sessions_touched": 18,
        "last_edit": "2026-07-16",
        "avg_lines_changed": 52
      },
      "explanation": "Крупные изменения (в среднем 52 строки за правку). 8 ошибок за период, высокая фрустрация — разработчик часто откатывает изменения."
    }
  ],
  "generated_at": 1752691200000,
  "timeframe": "30d",
  "total_files_analyzed": 87
}
```

**Интерпретация score:**
| Диапазон   | Уровень   | Рекомендация AI                                      |
|------------|-----------|-------------------------------------------------------|
| 0.0 – 0.3  | Низкий    | Файл стабилен. Можно править без опасений.            |
| 0.3 – 0.6  | Средний   | Умеренный риск. Проверить тесты после изменений.       |
| 0.6 – 0.8  | Высокий   | Файл проблемный. Показать предупреждение пользователю. |
| 0.8 – 1.0  | Критический| Избегать изменений. Предложить рефакторинг или перепись.|

---

### 2.b Режим "predict_change" — Предиктивный анализ риска

**Назначение:** Перед изменением файла предсказывает риск поломки билда,
тестов или смежных модулей. Использует исторические данные: сколько раз
изменения этого файла приводили к ошибкам, какие файлы ломались вместе с ним.

**Параметры:**
| Параметр | Тип     | Обязательный | Описание                                              |
|----------|---------|-------------|-------------------------------------------------------|
| `target` | `string`| **ДА**       | Абсолютный или относительный (от workspace) путь к файлу |

**Логика выполнения:**

```typescript
async function executePredictChange(
  storage: StorageEngine,
  analytics: AnalyticsEngine,
  args: { target: string }
): Promise<PredictChangeResult> {
  const db = storage.getDb();

  // 1. Проверяем существование файла в истории
  const fileStats = db.prepare(`
    SELECT
      COUNT(*) AS total_edits,
      COUNT(DISTINCT se.id) AS total_errors,
      COUNT(DISTINCT fe.session_id) AS sessions_touched
    FROM file_edits fe
    LEFT JOIN session_errors se
      ON se.context_file = fe.file_path
    WHERE fe.file_path = ?
  `).get(args.target);

  // 2. Вычисляем риск-метрики
  const breakageRate = fileStats.total_edits > 0
    ? fileStats.total_errors / fileStats.total_edits
    : 0;

  // 3. Находим файлы, которые исторически ломались вместе с target
  const coBrokenFiles = db.prepare(`
    SELECT
      se2.context_file AS affected_file,
      COUNT(*) AS co_break_count
    FROM session_errors se1
    JOIN file_edits fe ON fe.file_path = ?
    JOIN session_errors se2
      ON se2.session_id = fe.session_id
      AND se2.context_file != ?
    WHERE se1.context_file = ?
    GROUP BY se2.context_file
    ORDER BY co_break_count DESC
    LIMIT 10
  `).all(args.target, args.target, args.target);

  // 4. Находим зависимости через knowledge_edges
  const dependencies = db.prepare(`
    SELECT target_node_id, weight, relation_type
    FROM knowledge_edges
    WHERE source_node_id = ? AND relation_type IN ('depends_on', 'causes_bugs_in', 'coupled_with')
    ORDER BY weight DESC
  `).all(`file:${args.target}`);

  // 5. Ищем похожие изменения в истории и их исходы
  const similarChanges = db.prepare(`
    SELECT
      fe.file_path AS file,
      date(fe.recorded_at / 1000, 'unixepoch') AS date,
      CASE WHEN se.id IS NOT NULL THEN 'broke something' ELSE 'clean' END AS result,
      fe.session_id
    FROM file_edits fe
    LEFT JOIN session_errors se
      ON se.session_id = fe.session_id
      AND se.context_file = fe.file_path
    WHERE fe.file_path = ?
    ORDER BY fe.recorded_at DESC
    LIMIT 5
  `).all(args.target);

  // 6. Вычисляем финальный risk_score
  const depsWeight = dependencies.reduce((sum, d) => sum + d.weight, 0);
  const riskScore = Math.min(
    (breakageRate * 0.5) +
    (Math.min(depsWeight / 10, 1) * 0.3) +
    (Math.min(coBrokenFiles.length / 5, 1) * 0.2),
    1
  );

  const riskLevel = riskScore < 0.3 ? "low"
    : riskScore < 0.6 ? "medium"
    : riskScore < 0.8 ? "high"
    : "critical";

  // 7. Формируем рекомендацию
  const recommendation = buildRecommendation(riskLevel, breakageRate, coBrokenFiles);

  return {
    target: args.target,
    risk_score: Math.round(riskScore * 100) / 100,
    risk_level: riskLevel,
    affected_files: coBrokenFiles.map(f => f.affected_file),
    dependency_count: dependencies.length,
    historical_breakage_rate: Math.round(breakageRate * 100) / 100,
    recent_similar_changes: similarChanges,
    recommendation,
  };
}
```

**Формат ответа:**

```json
{
  "target": "src/db/schema.ts",
  "risk_score": 0.72,
  "risk_level": "high",
  "affected_files": [
    "src/db/migrations/005.ts",
    "src/api/users.ts",
    "src/api/orders.ts"
  ],
  "dependency_count": 12,
  "historical_breakage_rate": 0.6,
  "recent_similar_changes": [
    {
      "file": "src/db/schema.ts",
      "date": "2026-07-13",
      "result": "broke migrations",
      "session_id": "sess_abc123"
    },
    {
      "file": "src/db/schema.ts",
      "date": "2026-07-10",
      "result": "broke migrations",
      "session_id": "sess_def456"
    },
    {
      "file": "src/db/schema.ts",
      "date": "2026-07-01",
      "result": "clean",
      "session_id": "sess_ghi789"
    }
  ],
  "recommendation": "ВЫСОКИЙ РИСК. Изменения schema.ts в 60% случаев ломали миграции. Рекомендую: 1) запустить полный тест-сьют 2) проверить миграции 3) делать маленькими коммитами."
}
```

**Пороги риска и действия AI:**
| Уровень       | Score    | Действие AI                                                 |
|---------------|----------|-------------------------------------------------------------|
| `low`         | < 0.3    | Можно править без дополнительных проверок.                   |
| `medium`      | 0.3–0.6  | Предупредить пользователя, предложить запустить смежные тесты.|
| `high`        | 0.6–0.8  | Показать полный список affected_files, настоять на тестах.    |
| `critical`    | > 0.8    | Заблокировать автоматическое изменение, запросить явное подтверждение. |

---

### 2.c Режим "file_history" — Полная история файла

**Назначение:** Возвращает хронологию всех изменений конкретного файла:
кто правил (AI build/plan или человек), когда, с каким исходом, какие ошибки возникали.

**Параметры:**
| Параметр    | Тип     | Обязательный | По умолчанию | Описание                   |
|-------------|---------|-------------|-------------|----------------------------|
| `target`    | `string`| **ДА**       | —           | Путь к файлу               |
| `timeframe` | `enum`  | Нет         | `"all"`     | Ограничение по времени     |

**Формат ответа:**

```json
{
  "file": "src/auth/session.ts",
  "first_seen": "2025-11-03",
  "total_edits": 89,
  "unique_sessions": 45,
  "authors": {
    "ai_build": 62,
    "ai_plan": 5,
    "human": 22
  },
  "timeline": [
    {
      "date": "2026-07-15",
      "session_id": "sess_xyz789",
      "agent": "build",
      "changes": "+45/-12 lines",
      "caused_error": true,
      "error_type": "type_error",
      "error_message": "Type 'string' is not assignable to type 'number'"
    },
    {
      "date": "2026-07-14",
      "session_id": "sess_abc456",
      "agent": "plan",
      "changes": "+8/-2 lines",
      "caused_error": false
    },
    {
      "date": "2026-07-12",
      "session_id": null,
      "agent": "human",
      "changes": "+23/-45 lines",
      "caused_error": false
    }
  ],
  "top_collaborators": [
    "src/auth/tokens.ts",
    "src/middleware/auth.ts",
    "src/api/login.ts"
  ],
  "refactoring_count": 3,
  "stability_score": 0.45
}
```

**Структура timeline:**
| Поле             | Тип       | Описание                                                     |
|------------------|-----------|--------------------------------------------------------------|
| `date`           | `string`  | Дата изменения (YYYY-MM-DD)                                   |
| `session_id`     | `string?` | ID сессии OpenCode (null для human-изменений вне сессий)      |
| `agent`          | `string`  | `"build"` \| `"plan"` \| `"human"`                           |
| `changes`        | `string`  | Форматированная строка: `"+N/-M lines"`                      |
| `caused_error`   | `boolean` | Привело ли изменение к ошибке в этой или следующей сессии     |
| `error_type`     | `string?` | Тип ошибки: `type_error` \| `runtime_error` \| `test_failure` |
| `error_message`  | `string?` | Текст ошибки (если `caused_error = true`)                     |

---

### 2.d Режим "team_pulse" — Пульс проекта

**Назначение:** Даёт обзорную картину здоровья всего проекта: общий score,
тренд (улучшается/ухудшается), топ проблем, динамика по месяцам.

**Параметры:**
| Параметр    | Тип    | Обязательный | По умолчанию | Описание               |
|-------------|--------|-------------|-------------|------------------------|
| `timeframe` | `enum` | Нет         | `"30d"`     | Окно для расчёта метрик |

**Формат ответа:**

```json
{
  "project_health_score": 0.62,
  "trend": "improving",
  "total_files": 234,
  "active_files": 87,
  "hotspot_count": 5,
  "avg_session_duration_min": 18,
  "ai_reliance_ratio": 0.73,
  "error_rate": 0.12,
  "top_concern": "Модуль auth имеет нарастающую сложность — 3 рефакторинга за месяц не помогли",
  "health_over_time": [
    { "month": "2026-05", "score": 0.58 },
    { "month": "2026-06", "score": 0.55 },
    { "month": "2026-07", "score": 0.62 }
  ],
  "module_breakdown": [
    { "module": "src/auth", "health_score": 0.41, "files": 8, "hotspot": "session.ts" },
    { "module": "src/api", "health_score": 0.72, "files": 15, "hotspot": null },
    { "module": "src/utils", "health_score": 0.55, "files": 12, "hotspot": "god-object.ts" }
  ]
}
```

**Поля:**
| Поле                      | Тип       | Описание                                                                 |
|---------------------------|-----------|--------------------------------------------------------------------------|
| `project_health_score`    | `number`  | 0–1, агрегированный показатель здоровья (чем выше, тем лучше)             |
| `trend`                   | `string`  | `"improving"` \| `"stable"` \| `"declining"`                             |
| `total_files`             | `number`  | Всего отслеживаемых файлов в проекте                                      |
| `active_files`            | `number`  | Файлы, которые редактировались за выбранный timeframe                     |
| `hotspot_count`           | `number`  | Количество файлов со score > 0.6                                          |
| `ai_reliance_ratio`       | `number`  | Доля изменений, внесённых AI (0 = всё руками, 1 = только AI)              |
| `error_rate`              | `number`  | Доля изменений, приведших к ошибке                                        |
| `health_over_time`        | `array`   | Помесячная динамика health_score — позволяет судить о тренде              |
| `module_breakdown`        | `array`   | Детализация по модулям первого уровня (директориям в `src/`)              |

---

### 2.e Режим "my_stats" — Персональная статистика разработчика

**Назначение:** Возвращает статистику текущего разработчика: количество сессий,
их длительность, соотношение AI/человеческого кода, тренды, достижения.

**Параметры:**
| Параметр    | Тип    | Обязательный | По умолчанию | Описание                |
|-------------|--------|-------------|-------------|-------------------------|
| `timeframe` | `enum` | Нет         | `"30d"`     | Период анализа          |

**Формат ответа:**

```json
{
  "sessions_total": 47,
  "sessions_per_day": 2.8,
  "avg_session_duration_min": 23,
  "files_edited": 34,
  "ai_generated_ratio": 0.68,
  "human_fix_ratio": 0.22,
  "top_files": [
    { "file": "src/auth/session.ts", "edits": 15, "errors": 4 },
    { "file": "src/api/payment.ts", "edits": 12, "errors": 2 },
    { "file": "src/db/schema.ts", "edits": 10, "errors": 6 }
  ],
  "tools_used": {
    "bash": 89,
    "edit": 234,
    "grep": 56,
    "read": 312,
    "write": 45,
    "glob": 78
  },
  "errors_encountered": 8,
  "trends": {
    "ai_reliance": {
      "previous": 0.55,
      "current": 0.68,
      "direction": "increasing",
      "change_pct": 23.6
    },
    "fix_rate": {
      "previous": 0.30,
      "current": 0.22,
      "direction": "improving",
      "change_pct": -26.7
    },
    "session_duration": {
      "previous": 18,
      "current": 23,
      "direction": "increasing",
      "change_pct": 27.8
    }
  },
  "achievements": [
    "Fix Rate улучшился на 27% по сравнению с прошлым месяцем",
    "Самый продуктивный день: 15 июля (6 сессий, 34 правки)",
    "Любимый инструмент: edit (234 вызова)"
  ]
}
```

**Поля trends:**
| Поле               | Тип      | Описание                                                      |
|--------------------|----------|---------------------------------------------------------------|
| `ai_reliance`      | `object` | Насколько выросла/упала доля AI-кода                          |
| `fix_rate`         | `object` | Доля правок человека поверх AI-кода (чем ниже, тем лучше AI)  |
| `session_duration` | `object` | Средняя длина сессии (мин). Растущая — возможно, задачи усложняются |

---

### 2.f Режим "dependency_graph" — Граф зависимостей

**Назначение:** Возвращает зависимости файла или модуля: кто его импортирует,
кого импортирует он, с кем исторически менялся вместе.

**Параметры:**
| Параметр | Тип     | Обязательный | По умолчанию | Описание                                        |
|----------|---------|-------------|-------------|-------------------------------------------------|
| `target` | `string`| **ДА**       | —           | Путь к файлу или модулю                         |
| `depth`  | `number`| Нет         | `1`         | Глубина обхода графа (1–3). > 1 рекурсивно раскрывает зависимости |

**Формат ответа:**

```json
{
  "root": "src/auth/session.ts",
  "imports": [
    "src/utils/jwt.ts",
    "src/db/users.ts",
    "src/config/env.ts"
  ],
  "imported_by": [
    "src/middleware/auth.ts",
    "src/api/login.ts",
    "src/api/register.ts",
    "src/api/refresh.ts"
  ],
  "co_changed_with": [
    { "file": "src/auth/tokens.ts", "frequency": 0.85, "last_together": "2026-07-15" },
    { "file": "src/middleware/auth.ts", "frequency": 0.72, "last_together": "2026-07-14" },
    { "file": "src/db/users.ts", "frequency": 0.45, "last_together": "2026-07-10" }
  ],
  "causes_bugs_in": [
    { "file": "src/api/login.ts", "count": 3 },
    { "file": "src/api/refresh.ts", "count": 2 }
  ],
  "depth": 1,
  "total_dependents": 4,
  "total_dependencies": 3
}
```

**Поля:**
| Поле               | Тип      | Описание                                                               |
|--------------------|----------|------------------------------------------------------------------------|
| `imports`          | `array`  | Файлы, которые импортирует target (из knowledge_edges `imports`)        |
| `imported_by`      | `array`  | Файлы, которые импортируют target (из knowledge_edges `imports`)        |
| `co_changed_with`  | `array`  | Файлы, которые исторически менялись вместе с target (из co_changes)     |
| `causes_bugs_in`   | `array`  | Файлы, в которых возникали ошибки после изменений target                |
| `frequency`        | `number` | 0–1: доля изменений target, при которых менялся и этот файл             |

---

### 2.g Режим "knowledge_search" — Семантический поиск по графу знаний

**Назначение:** Ищет по всем сущностям графа знаний Code Shadow: файлы,
модули, концепции, архитектурные решения, паттерны.

**Параметры:**
| Параметр | Тип     | Обязательный | По умолчанию | Описание                                  |
|----------|---------|-------------|-------------|-------------------------------------------|
| `target` | `string`| **ДА**       | —           | Поисковый запрос (на естественном языке)   |
| `limit`  | `number`| Нет         | `10`        | Максимальное количество результатов        |

**Формат ответа:**

```json
{
  "query": "authentication",
  "results": [
    {
      "node_type": "module",
      "name": "Authentication Module",
      "path": "src/auth/",
      "relevance": 0.95,
      "description": "Handles user authentication via JWT + refresh tokens. Contains 3 files: session.ts, tokens.ts, middleware/auth.ts. Exposes 12 API endpoints."
    },
    {
      "node_type": "decision",
      "name": "ADR-003: JWT vs Session-based auth",
      "relevance": 0.82,
      "description": "Chose JWT for stateless scalability. Rejected session-based approach due to Redis dependency and added infrastructure complexity."
    },
    {
      "node_type": "concept",
      "name": "Token refresh flow",
      "path": null,
      "relevance": 0.78,
      "description": "Silent refresh via short-lived access tokens (15 min) and long-lived refresh tokens (7 days). Implemented via interceptor pattern."
    },
    {
      "node_type": "file",
      "name": "src/api/login.ts",
      "path": "src/api/login.ts",
      "relevance": 0.71,
      "description": "POST /api/auth/login endpoint. Handles credential validation, MFA challenge, and initial token pair issuance."
    }
  ],
  "total_found": 12,
  "search_time_ms": 4
}
```

**Типы узлов (node_type):**
| Тип         | Описание                                                       | Пример                        |
|-------------|----------------------------------------------------------------|-------------------------------|
| `file`      | Конкретный файл в проекте                                      | `src/api/login.ts`            |
| `module`    | Логический модуль (группа файлов)                              | `src/auth/`                   |
| `concept`   | Абстрактная концепция или паттерн                              | "Token refresh flow"          |
| `component` | UI-компонент или сервис                                        | "AuthService"                 |
| `api`       | API-эндпоинт или интерфейс                                     | "POST /api/auth/login"        |
| `decision`  | Архитектурное решение (ADR)                                    | "ADR-003: JWT vs Sessions"    |

---

### 2.h Режим "decisions_list" — Список архитектурных решений

**Назначение:** Возвращает список всех архитектурных решений (ADR),
записанных через `code_shadow_decide`. Опционально фильтрует по статусу.

**Параметры:**
| Параметр | Тип     | Обязательный | По умолчанию | Описание                                                    |
|----------|---------|-------------|-------------|-------------------------------------------------------------|
| `target` | `string`| Нет         | —           | Фильтр по статусу: `"proposed"`, `"accepted"`, `"deprecated"`, `"superseded"` |
| `limit`  | `number`| Нет         | `20`        | Максимальное количество записей                              |

**Формат ответа:**

```json
{
  "decisions": [
    {
      "id": 3,
      "title": "ADR-003: JWT vs Session-based auth",
      "status": "accepted",
      "decided_at": "2026-01-15",
      "tags": ["auth", "architecture", "security"],
      "context": "Нужно было выбрать механизм аутентификации для микросервисной архитектуры",
      "decision": "Использовать JWT с refresh-токенами. Access token — 15 минут, refresh — 7 дней.",
      "related_files": [
        "src/auth/session.ts",
        "src/auth/tokens.ts",
        "src/middleware/auth.ts"
      ]
    },
    {
      "id": 7,
      "title": "ADR-007: Переход с Zod на TypeBox",
      "status": "proposed",
      "decided_at": "2026-07-10",
      "tags": ["validation", "performance", "types"],
      "context": "Zod создаёт избыточный overhead в рантайме для высоконагруженных эндпоинтов",
      "decision": "Мигрировать валидацию с Zod на TypeBox для снижения CPU-нагрузки на 30%",
      "alternatives": ["Оставить Zod", "ArkType", "Valibot"],
      "related_files": [
        "src/validators/*.ts"
      ]
    }
  ],
  "total": 7
}
```

---

## 3. code_shadow_memory_write

**Назначение:** Записывает структурированный факт в долговременную память Code Shadow.
Полный аналог `ctx_memory` из Magic Context, но с хранением в SQLite (`knowledge_nodes`)
и авто-извлечением тегов.

### Декларация тулза

```typescript
import { tool } from "@opencode-ai/plugin-sdk";

export function createMemoryWriteTool(
  ctx: PluginContext,
  storage: StorageEngine
) {
  return tool({
    description: [
      "Сохраняет факт о проекте. ИСПОЛЬЗУЙ КОГДА УЗНАЁШЬ важное.",
    ].join("\n"),

    args: {
      category: tool.schema.enum([
        "PROJECT_RULES",
        "ARCHITECTURE",
        "CONSTRAINTS",
        "CONFIG_VALUES",
        "NAMING",
      ]),
      content: tool.schema.string(),
    },

    async execute(args, context) {
      const db = storage.getDb();
      const now = Date.now();

      // 1. Авто-извлекаем теги из содержимого
      const tags = extractTags(args.content);

      // 2. Генерируем уникальный ID узла
      const nodeId = `memory:${hashContent(args.content)}`;

      // 3. Сохраняем в knowledge_nodes
      db.prepare(`
        INSERT INTO knowledge_nodes (id, type, label, description, metadata, created_at, updated_at)
        VALUES (?, 'concept', ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          description = excluded.description,
          metadata = excluded.metadata,
          updated_at = excluded.updated_at
      `).run(
        nodeId,
        args.content.substring(0, 100), // label — первые 100 символов
        args.content,
        JSON.stringify({ category: args.category, tags, session_id: context.sessionId }),
        now,
        now
      );

      // 4. Подтверждение для AI
      return {
        status: "ok",
        node_id: nodeId,
        category: args.category,
        tags,
        stored_at: now,
        message: `Факт сохранён в категории «${args.category}» (${args.content.length} символов).`,
      };
    },
  });
}

/**
 * Извлекает теги из текста: ищет ключевые слова, пути к файлам,
 * упоминания технологий.
 */
function extractTags(content: string): string[] {
  const tags: Set<string> = new Set();

  // Пути к файлам: src/..., packages/..., etc.
  const fileMatches = content.match(/(?:src|packages|lib|app|tests?|docs)\/[\w\/\-\.]+/gi);
  fileMatches?.forEach(m => tags.add(`path:${m}`));

  // Технологии: имена пакетов, фреймворков
  const techPatterns = /\b(?:react|next\.?js|vue|angular|express|fastify|prisma|drizzle|zod|typebox|typescript|javascript|python|rust|golang|docker|kubernetes|postgres|mysql|redis|sqlite|graphql|rest|grpc)\b/gi;
  const techMatches = content.match(techPatterns);
  techMatches?.forEach(m => tags.add(`tech:${m.toLowerCase()}`));

  // Версии: semver
  const versionMatches = content.match(/(?:>=?|<=?|~|\^)?\d+\.\d+\.\d+/g);
  versionMatches?.forEach(m => tags.add(`version:${m}`));

  return [...tags].slice(0, 10); // Максимум 10 тегов
}
```

**Категории и когда их использовать:**
| Категория         | Назначение                                                        | Пример содержимого                                    |
|-------------------|-------------------------------------------------------------------|-------------------------------------------------------|
| `PROJECT_RULES`   | Правила, которым должен следовать AI при работе с проектом         | "Всегда используй `import type` для импорта только типов" |
| `ARCHITECTURE`    | Факты об архитектуре (не ADR — для решений есть code_shadow_decide)| "Модуль auth — единственная точка входа для аутентификации" |
| `CONSTRAINTS`     | Ограничения и жёсткие требования                                  | "Node.js >= 18, нельзя использовать Node.js API старше 20" |
| `CONFIG_VALUES`   | Конкретные значения конфигурации                                  | "Порт по умолчанию: 3000, БД: PostgreSQL на localhost:5432" |
| `NAMING`          | Конвенции именования                                              | "Файлы компонентов: PascalCase.tsx, утилиты: kebab-case.ts" |

---

## 4. code_shadow_memory_search

**Назначение:** Ищет по всей долговременной памяти Code Shadow: факты,
архитектурные решения, историю файлов, аналитические данные. Аналог `ctx_search`.

### Декларация тулза

```typescript
import { tool } from "@opencode-ai/plugin-sdk";

export function createMemorySearchTool(
  ctx: PluginContext,
  storage: StorageEngine
) {
  return tool({
    description: [
      "Ищет по памяти проекта. ВЫЗЫВАЙ В НАЧАЛЕ СЕССИИ чтобы вспомнить контекст.",
    ].join("\n"),

    args: {
      query: tool.schema.string(),
      sources: tool.schema.array(
        tool.schema.enum(["memory", "decisions", "file_history", "analytics"])
      ).optional(),
      limit: tool.schema.number().optional(),
    },

    async execute(args, context) {
      const db = storage.getDb();
      const query = args.query.toLowerCase();
      const sources = args.sources || ["memory", "decisions", "file_history", "analytics"];
      const limit = args.limit || 15;
      const results: SearchResultItem[] = [];

      // 1. Поиск по knowledge_nodes (память)
      if (sources.includes("memory")) {
        const memoryResults = db.prepare(`
          SELECT id, type, label, description, metadata, updated_at
          FROM knowledge_nodes
          WHERE label LIKE ? OR description LIKE ?
          ORDER BY updated_at DESC
          LIMIT ?
        `).all(`%${query}%`, `%${query}%`, limit);

        for (const row of memoryResults) {
          results.push({
            source: "memory",
            id: row.id,
            type: row.type,
            label: row.label,
            description: row.description?.substring(0, 200),
            metadata: JSON.parse(row.metadata || "{}"),
            updated_at: row.updated_at,
          });
        }
      }

      // 2. Поиск по decisions (архитектурные решения)
      if (sources.includes("decisions")) {
        const decisionResults = db.prepare(`
          SELECT id, title, context, decision, status, tags, created_at
          FROM decisions
          WHERE title LIKE ? OR context LIKE ? OR decision LIKE ? OR tags LIKE ?
          ORDER BY created_at DESC
          LIMIT ?
        `).all(`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, limit);

        for (const row of decisionResults) {
          results.push({
            source: "decision",
            id: row.id,
            type: "decision",
            label: row.title,
            description: row.decision?.substring(0, 200),
            status: row.status,
            tags: JSON.parse(row.tags || "[]"),
            created_at: row.created_at,
          });
        }
      }

      // 3. Поиск по file_edits (история файлов)
      if (sources.includes("file_history")) {
        const fileResults = db.prepare(`
          SELECT DISTINCT file_path, COUNT(*) AS edit_count, MAX(recorded_at) AS last_edit
          FROM file_edits
          WHERE file_path LIKE ?
          GROUP BY file_path
          ORDER BY edit_count DESC
          LIMIT ?
        `).all(`%${query}%`, limit);

        for (const row of fileResults) {
          results.push({
            source: "file_history",
            type: "file",
            label: row.file_path,
            description: `Редактировался ${row.edit_count} раз(а). Последнее изменение: ${new Date(row.last_edit).toISOString().split("T")[0]}`,
            metadata: { edit_count: row.edit_count, last_edit: row.last_edit },
          });
        }
      }

      // 4. Поиск по analytics_cache
      if (sources.includes("analytics")) {
        const analyticsResults = db.prepare(`
          SELECT cache_key, category, numeric_value, text_value, computed_at
          FROM analytics_cache
          WHERE cache_key LIKE ? OR text_value LIKE ?
          ORDER BY computed_at DESC
          LIMIT ?
        `).all(`%${query}%`, `%${query}%`, limit);

        for (const row of analyticsResults) {
          results.push({
            source: "analytics",
            id: row.cache_key,
            type: row.category,
            label: row.cache_key,
            description: `Значение: ${row.numeric_value}${row.text_value ? ` — ${row.text_value}` : ""}`,
            metadata: { computed_at: row.computed_at },
          });
        }
      }

      return {
        query: args.query,
        sources_queried: sources,
        results: results.slice(0, limit),
        total_found: results.length,
        search_time_ms: 0, // будет заполнено реальным замером
      };
    },
  });
}
```

**Формат ответа:**

```json
{
  "query": "auth",
  "sources_queried": ["memory", "decisions", "file_history", "analytics"],
  "results": [
    {
      "source": "memory",
      "type": "concept",
      "label": "Модуль auth — единственная точка входа для аутентификации",
      "description": "Модуль auth — единственная точка входа для аутентификации",
      "metadata": { "category": "ARCHITECTURE", "tags": ["path:src/auth/", "tech:jwt"] },
      "updated_at": 1752691200000
    },
    {
      "source": "decision",
      "type": "decision",
      "id": 3,
      "label": "ADR-003: JWT vs Session-based auth",
      "description": "Использовать JWT с refresh-токенами. Access token — 15 минут, refresh — 7 дней.",
      "status": "accepted",
      "tags": ["auth", "architecture", "security"],
      "created_at": 1736899200000
    },
    {
      "source": "file_history",
      "type": "file",
      "label": "src/auth/session.ts",
      "description": "Редактировался 89 раз(а). Последнее изменение: 2026-07-15",
      "metadata": { "edit_count": 89, "last_edit": 1752691200000 }
    }
  ],
  "total_found": 12,
  "search_time_ms": 4
}
```

---

## 5. code_shadow_memory_note

**Назначение:** Создаёт временную заметку-напоминание. Аналог `ctx_note`.
Поддерживает «умные заметки» — отложенное напоминание по внешнему условию
(например, «когда PR #42 будет смержен»).

### Декларация тулза

```typescript
import { tool } from "@opencode-ai/plugin-sdk";

export function createMemoryNoteTool(
  ctx: PluginContext,
  storage: StorageEngine
) {
  return tool({
    description: [
      "Создаёт заметку. ИСПОЛЬЗУЙ В КОНЦЕ СЕССИИ для сохранения итогов.",
    ].join("\n"),

    args: {
      content: tool.schema.string(),
      surface_condition: tool.schema.string().optional(),
    },

    async execute(args, context) {
      const db = storage.getDb();
      const now = Date.now();

      // Сохраняем заметку в специальную таблицу
      // (используем knowledge_nodes с типом 'note')
      const noteId = `note:${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      db.prepare(`
        INSERT INTO knowledge_nodes (id, type, label, description, metadata, created_at, updated_at)
        VALUES (?, 'note', ?, ?, ?, ?, ?)
      `).run(
        noteId,
        args.content.substring(0, 100),
        args.content,
        JSON.stringify({
          surface_condition: args.surface_condition || null,
          session_id: context.sessionId,
          status: "active",
        }),
        now,
        now
      );

      return {
        status: "ok",
        note_id: noteId,
        surface_condition: args.surface_condition || null,
        created_at: now,
        message: args.surface_condition
          ? `Заметка создана. Напомню когда: ${args.surface_condition}`
          : "Заметка создана.",
      };
    },
  });
}
```

**Примеры surface_condition:**
| Условие                                                          | Когда сработает                                       |
|------------------------------------------------------------------|-------------------------------------------------------|
| `"When PR #42 in xuviga/code-shadow is merged"`               | После мержа PR #42 в указанном репозитории             |
| `"When the latest release tag is >= v0.23.0"`                    | При достижении указанной версии                        |
| `"When packages/plugin/src/foo.ts contains a function named bar"`| При обнаружении функции `bar` в файле                  |
| *Не указано*                                                     | Будет показана при следующей удобной возможности       |

---

## 6. code_shadow_context_inject

**Назначение:** Внедряет релевантный контекст о проекте в текущую сессию
AI-агента. Собирает информацию из всех источников Code Shadow (память,
аналитика, решения) и возвращает структурированный блок для прочтения AI.

### Декларация тулза

```typescript
import { tool } from "@opencode-ai/plugin-sdk";

export function createContextInjectTool(
  ctx: PluginContext,
  storage: StorageEngine,
  analytics: AnalyticsEngine
) {
  return tool({
    description: [
      "Внедряет контекст проекта в сессию. ВЫЗЫВАЙ В НАЧАЛЕ СЕССИИ.",
    ].join("\n"),

    args: {
      focus: tool.schema.string().optional(),
      include: tool.schema.array(
        tool.schema.enum([
          "architecture",
          "conventions",
          "hotspots",
          "recent_changes",
          "decisions",
        ])
      ).optional(),
    },

    async execute(args, context) {
      const db = storage.getDb();
      const include = args.include || [
        "architecture", "conventions", "hotspots", "recent_changes", "decisions"
      ];
      const contextBlocks: string[] = [];

      // 1. Архитектурные знания
      if (include.includes("architecture")) {
        const archNodes = db.prepare(`
          SELECT label, description FROM knowledge_nodes
          WHERE type = 'module' OR metadata LIKE '%ARCHITECTURE%'
          ORDER BY updated_at DESC LIMIT 10
        `).all();

        if (archNodes.length > 0) {
          contextBlocks.push("## Архитектура проекта\n");
          for (const node of archNodes) {
            contextBlocks.push(`- **${node.label}**: ${node.description}`);
          }
        }
      }

      // 2. Конвенции (правила, именования, конфиги)
      if (include.includes("conventions")) {
        const conventionNodes = db.prepare(`
          SELECT label, description, metadata FROM knowledge_nodes
          WHERE metadata LIKE '%PROJECT_RULES%'
             OR metadata LIKE '%NAMING%'
             OR metadata LIKE '%CONFIG_VALUES%'
             OR metadata LIKE '%CONSTRAINTS%'
          ORDER BY updated_at DESC LIMIT 15
        `).all();

        if (conventionNodes.length > 0) {
          contextBlocks.push("\n## Конвенции и ограничения\n");
          for (const node of conventionNodes) {
            contextBlocks.push(`- ${node.description}`);
          }
        }
      }

      // 3. Горячие точки
      if (include.includes("hotspots")) {
        const hotspots = db.prepare(`
          SELECT cache_key, numeric_value FROM analytics_cache
          WHERE category = 'hotspot' AND numeric_value > 0.5
          ORDER BY numeric_value DESC LIMIT 5
        `).all();

        if (hotspots.length > 0) {
          contextBlocks.push("\n## Проблемные файлы (hotspots)\n");
          for (const h of hotspots) {
            const fileName = h.cache_key.replace("hotspot:", "");
            contextBlocks.push(`- \`${fileName}\` — score: ${h.numeric_value.toFixed(2)}`);
          }
        }
      }

      // 4. Недавние изменения
      if (include.includes("recent_changes")) {
        const recentChanges = db.prepare(`
          SELECT DISTINCT file_path, MAX(recorded_at) as last_edit, COUNT(*) as cnt
          FROM file_edits
          WHERE recorded_at >= ?
          GROUP BY file_path
          ORDER BY cnt DESC LIMIT 10
        `).all(Date.now() - 7 * 24 * 60 * 60 * 1000);

        if (recentChanges.length > 0) {
          contextBlocks.push("\n## Недавние изменения (7 дней)\n");
          for (const rc of recentChanges) {
            contextBlocks.push(`- \`${rc.file_path}\` — ${rc.cnt} правок`);
          }
        }
      }

      // 5. Архитектурные решения
      if (include.includes("decisions")) {
        const decisions = db.prepare(`
          SELECT title, decision, status FROM decisions
          WHERE status = 'accepted'
          ORDER BY created_at DESC LIMIT 5
        `).all();

        if (decisions.length > 0) {
          contextBlocks.push("\n## Ключевые архитектурные решения\n");
          for (const d of decisions) {
            contextBlocks.push(`- **${d.title}** [${d.status}]: ${d.decision}`);
          }
        }
      }

      // 6. Если указан focus — добавляем информацию о конкретном модуле/файле
      if (args.focus) {
        const focusInfo = await gatherFocusContext(db, analytics, args.focus);
        if (focusInfo) {
          contextBlocks.push(`\n## Контекст для: ${args.focus}\n`);
          contextBlocks.push(focusInfo);
        }
      }

      return {
        injected_at: Date.now(),
        sections_count: contextBlocks.filter(b => b.startsWith("##")).length,
        context: contextBlocks.join("\n"),
        focus: args.focus || null,
        message: `Контекст проекта внедрён. ${contextBlocks.filter(b => b.startsWith("##")).length} разделов.`,
      };
    },
  });
}
```

**Формат ответа:**

```json
{
  "injected_at": 1752691200000,
  "sections_count": 5,
  "context": "## Архитектура проекта\n- **Authentication Module**: Handles...\n\n## Конвенции и ограничения\n- Всегда используй `import type`...\n\n## Проблемные файлы (hotspots)\n- `src/auth/session.ts` — score: 0.87\n\n## Недавние изменения (7 дней)\n- `src/auth/session.ts` — 8 правок\n\n## Ключевые архитектурные решения\n- **ADR-003: JWT vs Session-based auth** [accepted]: ...",
  "focus": null,
  "message": "Контекст проекта внедрён. 5 разделов."
}
```

---

## 7. code_shadow_decide

**Назначение:** Записывает архитектурное решение (ADR — Architecture Decision Record)
в базу Code Shadow. Сохраняет полный контекст: что привело к решению, какие были
альтернативы, какие файлы затронуты.

### Декларация тулза

```typescript
import { tool } from "@opencode-ai/plugin-sdk";

export function createDecideTool(
  ctx: PluginContext,
  storage: StorageEngine
) {
  return tool({
    description: [
      "Записывает архитектурное решение. ИСПОЛЬЗУЙ для важных технических решений.",
    ].join("\n"),

    args: {
      title: tool.schema.string(),
      description: tool.schema.string(),
      context: tool.schema.string().optional(),
      alternatives: tool.schema.array(tool.schema.string()).optional(),
      status: tool.schema.enum(["proposed", "accepted", "deprecated", "superseded"]).optional(),
      related_files: tool.schema.array(tool.schema.string()).optional(),
      tags: tool.schema.array(tool.schema.string()).optional(),
    },

    async execute(args, context) {
      const db = storage.getDb();
      const now = Date.now();

      // 1. Сохраняем решение в таблицу decisions
      const result = db.prepare(`
        INSERT INTO decisions (title, context, decision, consequences, status, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        args.title,
        args.context || null,
        args.description,
        null, // consequences — опционально, можно добавить позже
        args.status || "proposed",
        JSON.stringify(args.tags || []),
        now,
        now
      );

      const decisionId = result.lastInsertRowid;

      // 2. Сохраняем альтернативы как отдельную мета-запись
      if (args.alternatives && args.alternatives.length > 0) {
        db.prepare(`
          INSERT INTO knowledge_nodes (id, type, label, description, metadata, created_at, updated_at)
          VALUES (?, 'concept', ?, ?, ?, ?, ?)
        `).run(
          `decision_alt:${decisionId}`,
          `Альтернативы для: ${args.title}`,
          args.alternatives.join("; "),
          JSON.stringify({ decision_id: decisionId, type: "alternatives" }),
          now,
          now
        );
      }

      // 3. Связываем решение с файлами через knowledge_edges
      if (args.related_files && args.related_files.length > 0) {
        const insertEdge = db.prepare(`
          INSERT OR IGNORE INTO knowledge_edges (source_node_id, target_node_id, relation_type, weight, evidence, created_at)
          VALUES (?, ?, 'references', 0.8, 'manual', ?)
        `);

        const decisionNodeId = `decision:${decisionId}`;

        // Регистрируем решение как узел графа
        db.prepare(`
          INSERT OR IGNORE INTO knowledge_nodes (id, type, label, description, metadata, created_at, updated_at)
          VALUES (?, 'decision', ?, ?, ?, ?, ?)
        `).run(
          decisionNodeId,
          args.title,
          args.description,
          JSON.stringify({
            status: args.status || "proposed",
            tags: args.tags || [],
            alternatives: args.alternatives || [],
          }),
          now,
          now
        );

        for (const file of args.related_files) {
          insertEdge.run(decisionNodeId, `file:${file}`, now);
        }
      }

      // 4. Авто-извлекаем теги если не указаны явно
      const finalTags = args.tags && args.tags.length > 0
        ? args.tags
        : extractTags(`${args.title} ${args.description}`);

      return {
        status: "ok",
        decision_id: decisionId,
        title: args.title,
        status: args.status || "proposed",
        tags: finalTags,
        related_files_count: args.related_files?.length || 0,
        created_at: now,
        message: `Архитектурное решение «${args.title}» записано (ID: ${decisionId}).`,
      };
    },
  });
}
```

**Формат ответа:**

```json
{
  "status": "ok",
  "decision_id": 12,
  "title": "ADR-012: Переход с REST на GraphQL для BFF-слоя",
  "status": "proposed",
  "tags": ["api", "graphql", "architecture", "bff"],
  "related_files_count": 5,
  "created_at": 1752691200000,
  "message": "Архитектурное решение «ADR-012: Переход с REST на GraphQL для BFF-слоя» записано (ID: 12)."
}
```

**Статусы решений:**
| Статус        | Описание                                                     |
|---------------|--------------------------------------------------------------|
| `proposed`    | Решение предложено, но ещё не принято окончательно            |
| `accepted`    | Решение принято и реализуется                                 |
| `deprecated`  | Решение более не актуально (но проект всё ещё его использует) |
| `superseded`  | Решение заменено другим (указать каким в consequences)        |

---

## 8. Рекомендации для AI-агента

### Когда использовать какой тулз

```
┌─────────────────────────────────────────────────────────────────────┐
│                    ДЕРЕВО ПРИНЯТИЯ РЕШЕНИЙ ДЛЯ AI                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Ты начинаешь новую сессию на знакомом проекте?                     │
│  ├── ДА → code_shadow_context_inject                                │
│  └── НЕТ → продолжаем                                               │
│                                                                     │
│  Тебе нужно понять, насколько рискованно менять файл?               │
│  ├── ДА → code_shadow_analyze (query: "predict_change")             │
│  └── НЕТ → продолжаем                                               │
│                                                                     │
│  Тебе нужно узнать «горячие точки» в проекте?                       │
│  ├── ДА → code_shadow_analyze (query: "hotspots")                   │
│  └── НЕТ → продолжаем                                               │
│                                                                     │
│  Ты узнал важный факт о проекте, который нужно запомнить НАВСЕГДА?  │
│  ├── ДА → code_shadow_memory_write                                  │
│  └── НЕТ → продолжаем                                               │
│                                                                     │
│  Ты принял важное архитектурное решение?                            │
│  ├── ДА → code_shadow_decide                                        │
│  └── НЕТ → продолжаем                                               │
│                                                                     │
│  Ты хочешь найти информацию по ключевому слову во всей памяти?      │
│  ├── ДА → code_shadow_memory_search                                 │
│  └── НЕТ → продолжаем                                               │
│                                                                     │
│  Тебе нужно создать отложенное напоминание?                         │
│  ├── ДА → code_shadow_memory_note                                   │
│  └── НЕТ → продолжаем                                               │
│                                                                     │
│  Тебе нужна детальная информация о конкретном файле/модуле?         │
│  ├── ДА → code_shadow_analyze (query: "file_history" /              │
│  │         "dependency_graph" / "knowledge_search" / "decisions_list")│
│  └── НЕТ → используй обычные инструменты (read, grep, glob)         │
│                                                                     │
│  Тебе нужна общая картина проекта или личная статистика?            │
│  ├── ДА → code_shadow_analyze (query: "team_pulse" / "my_stats")    │
│  └── НЕТ → используй обычные инструменты                            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Приоритеты вызова

1. **Перед редактированием незнакомого файла:**
   ```
   code_shadow_analyze(query: "predict_change", target: "путь/к/файлу.ts")
   ```
   Это САМЫЙ важный вызов. Он спасёт от поломки билда.

2. **При входе в новый проект или после долгого перерыва:**
   ```
   code_shadow_context_inject(include: ["architecture", "conventions", "decisions"])
   ```
   Это ВТОРОЙ по важности. Экономит 5-10 минут на исследование проекта.

3. **Когда узнаёшь конвенцию или правило:**
   ```
   code_shadow_memory_write(category: "NAMING", content: "...")
   ```
   Записывай СРАЗУ, не откладывай. Иначе забудешь.

4. **Когда принимаешь решение о выборе технологии:**
   ```
   code_shadow_decide(title: "...", description: "...", alternatives: [...])
   ```
   Особенно если обсуждал несколько вариантов — сохрани альтернативы.

### Антипаттерны (чего НЕ делать)

| ❌ Плохо                                                 | ✅ Хорошо                                                                 |
|---------------------------------------------------------|--------------------------------------------------------------------------|
| Вызывать `analyze` для поиска строки в файле            | Использовать `grep` для поиска строки                                    |
| Вызывать `memory_write` для временной заметки           | Использовать `memory_note` для временных заметок                         |
| Вызывать `decide` для решения «назвать переменную x»    | Использовать `decide` только для нетривиальных архитектурных решений      |
| Вызывать `context_inject` КАЖДЫЙ раз в одной сессии     | Вызвать ОДИН раз в начале сессии                                        |
| Игнорировать `predict_change` перед правкой schema.ts   | ВСЕГДА проверять риск перед изменением файлов со score > 0.5             |
| Вызывать `analyze` (query: "hotspots") и не показывать результат пользователю | Показывать краткую сводку: «Вот 3 самых проблемных файла в проекте»     |

---

## 9. Обработка ошибок

### Стандартный конверт ошибки

Все тулзы Code Shadow возвращают ошибки в едином формате:

```json
{
  "error": true,
  "code": "SHADOW_ERR_DATABASE_LOCKED",
  "message": "База данных временно заблокирована. Повторите запрос через 1-2 секунды.",
  "details": {
    "tool": "code_shadow_analyze",
    "query_type": "hotspots",
    "retryable": true,
    "retry_after_ms": 1000
  }
}
```

### Коды ошибок

#### Общие ошибки (любой тулз)

| Код                               | HTTP-аналог | Описание                                          | Повтор? |
|-----------------------------------|-------------|---------------------------------------------------|---------|
| `SHADOW_ERR_DATABASE_LOCKED`      | 503         | SQLite заблокирован другим писателем (WAL-конфликт) | Да, через 1-2 сек |
| `SHADOW_ERR_DATABASE_CORRUPT`     | 500         | Файл data.db повреждён                             | Нет (требуется ручное восстановление) |
| `SHADOW_ERR_NOT_INITIALIZED`      | 503         | Плагин ещё не завершил инициализацию БД            | Да, через 5 сек |
| `SHADOW_ERR_INSUFFICIENT_DATA`    | 404         | Недостаточно данных для анализа (слишком мало событий) | Да, после накопления данных |
| `SHADOW_ERR_TIMEOUT`              | 504         | Запрос превысил допустимое время выполнения (5 сек)  | Да, с меньшим timeframe |

#### Ошибки валидации аргументов

| Код                                  | Описание                                                         |
|--------------------------------------|------------------------------------------------------------------|
| `SHADOW_ERR_MISSING_TARGET`          | Для запроса типа `predict_change`, `file_history`, `dependency_graph` не указан `target` |
| `SHADOW_ERR_INVALID_QUERY`           | Передан неизвестный тип `query` (не из enum)                     |
| `SHADOW_ERR_INVALID_TIMEFRAME`       | Передан неизвестный `timeframe` (не `7d`, `30d`, `90d`, `all`)   |
| `SHADOW_ERR_INVALID_LIMIT`           | `limit` меньше 1 или больше 100                                  |
| `SHADOW_ERR_UNKNOWN_CATEGORY`        | `category` не из enum для `memory_write`                         |
| `SHADOW_ERR_INVALID_SOURCES`         | Один из `sources` не из допустимого enum                         |

#### Ошибки тулза code_shadow_analyze

| Код                                      | Описание                                                              |
|------------------------------------------|-----------------------------------------------------------------------|
| `SHADOW_ERR_FILE_NOT_FOUND`              | `target`-файл не найден в истории правок                               |
| `SHADOW_ERR_NO_HOTSPOTS`                 | Ни один файл не набрал score > 0.1 (слишком стабильный проект)         |
| `SHADOW_ERR_NO_PREDICTION_DATA`          | Для `predict_change` нет исторических данных по файлу                  |
| `SHADOW_ERR_NO_DEPENDENCIES`             | Для `dependency_graph` не найдено зависимостей (файл изолирован)       |
| `SHADOW_ERR_EMPTY_KNOWLEDGE_GRAPH`       | Граф знаний пуст (плагин только что установлен)                        |
| `SHADOW_ERR_NO_DECISIONS`                | Нет записанных архитектурных решений                                   |
| `SHADOW_ERR_SEARCH_TOO_BROAD`            | Поисковый запрос слишком короткий (< 2 символов) или слишком общий     |

#### Ошибки тулза code_shadow_memory_write

| Код                                      | Описание                                                              |
|------------------------------------------|-----------------------------------------------------------------------|
| `SHADOW_ERR_CONTENT_TOO_SHORT`           | `content` короче 10 символов                                          |
| `SHADOW_ERR_CONTENT_TOO_LONG`            | `content` длиннее 10000 символов                                      |
| `SHADOW_ERR_DUPLICATE_MEMORY`            | Точно такой же факт уже существует (конфликт по хешу)                  |

#### Ошибки тулза code_shadow_memory_search

| Код                                      | Описание                                                              |
|------------------------------------------|-----------------------------------------------------------------------|
| `SHADOW_ERR_SEARCH_QUERY_EMPTY`          | `query` пустой или содержит только пробелы                             |
| `SHADOW_ERR_NO_SOURCES`                  | `sources` — пустой массив (не указано, где искать)                    |

#### Ошибки тулза code_shadow_decide

| Код                                      | Описание                                                              |
|------------------------------------------|-----------------------------------------------------------------------|
| `SHADOW_ERR_TITLE_TOO_SHORT`             | `title` короче 5 символов                                             |
| `SHADOW_ERR_DESCRIPTION_TOO_SHORT`       | `description` короче 20 символов                                      |
| `SHADOW_ERR_DECISION_EXISTS`             | Решение с таким `title` уже существует                                 |

#### Ошибки тулза code_shadow_context_inject

| Код                                      | Описание                                                              |
|------------------------------------------|-----------------------------------------------------------------------|
| `SHADOW_ERR_NO_CONTEXT_AVAILABLE`        | Нет доступного контекста (плагин только установлен, данных нет)        |
| `SHADOW_ERR_INVALID_FOCUS`               | Указанный `focus` не соответствует ни одному файлу или модулю          |

### Обработка ошибок внутри execute()

```typescript
// src/tools/error-handling.ts

export class ShadowToolError extends Error {
  constructor(
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
    public retryable: boolean = false
  ) {
    super(message);
    this.name = "ShadowToolError";
  }

  toJSON() {
    return {
      error: true,
      code: this.code,
      message: this.message,
      details: {
        ...this.details,
        retryable: this.retryable,
        timestamp: Date.now(),
      },
    };
  }
}

export function wrapToolExecute<T>(
  toolName: string,
  fn: () => Promise<T>
): Promise<T | ShadowToolError> {
  return Promise.resolve()
    .then(() => fn())
    .catch((err) => {
      // Известные ошибки SQLite
      if (err.message?.includes("SQLITE_BUSY")) {
        return new ShadowToolError(
          "SHADOW_ERR_DATABASE_LOCKED",
          "База данных временно заблокирована. Повторите запрос через 1-2 секунды.",
          { tool: toolName },
          true
        );
      }

      if (err.message?.includes("SQLITE_CORRUPT")) {
        return new ShadowToolError(
          "SHADOW_ERR_DATABASE_CORRUPT",
          "Файл базы данных повреждён. Запустите `opencode shadow repair`.",
          { tool: toolName },
          false
        );
      }

      // Таймаут
      if (err.name === "TimeoutError") {
        return new ShadowToolError(
          "SHADOW_ERR_TIMEOUT",
          `Тулз ${toolName} превысил лимит времени выполнения. Попробуйте уменьшить timeframe или limit.`,
          { tool: toolName },
          true
        );
      }

      // Неизвестная ошибка: логируем и возвращаем safe-ответ
      console.error(`[CodeShadow] Unhandled error in ${toolName}:`, err);
      return new ShadowToolError(
        "SHADOW_ERR_INTERNAL",
        `Внутренняя ошибка при выполнении ${toolName}.`,
        { tool: toolName, original_error: err.message },
        false
      );
    });
}
```

**Пример использования wrapToolExecute:**

```typescript
async execute(args, context) {
  return wrapToolExecute("code_shadow_analyze", async () => {
    // Основная логика тулза
    switch (args.query) {
      case "hotspots": return await executeHotspots(storage, args);
      // ...
    }
  });
}
```

---

## 10. Полный пример регистрации плагина

Ниже представлен полный файл `src/tools/index.ts`, собирающий все 7 тулзов
в единый экспорт. Именно этот объект попадает в `tools:` плагин-манифеста.

```typescript
// src/tools/index.ts
// ============================================================
// AI Tools Interface — регистрация всех тулзов Code Shadow
// ============================================================

import type { PluginContext, PluginRegistration } from "@opencode-ai/plugin-sdk";
import { tool } from "@opencode-ai/plugin-sdk";
import type { StorageEngine } from "../storage";
import type { AnalyticsEngine } from "../analytics";
import { wrapToolExecute } from "./error-handling";
import {
  executeHotspots,
  executePredictChange,
  executeFileHistory,
  executeTeamPulse,
  executeMyStats,
  executeDependencyGraph,
  executeKnowledgeSearch,
  executeDecisionsList,
} from "./analyze-handlers";
import { extractTags, hashContent } from "./utils";

// ============================================================
// 1. code_shadow_analyze — главный аналитический тулз
// ============================================================

function createAnalyzeTool(
  ctx: PluginContext,
  storage: StorageEngine,
  analytics: AnalyticsEngine
) {
  return tool({
    description: [
      "Анализирует здоровье кодовой базы: hotspots (проблемные файлы),",
      "предикшны риска изменений, историю файлов, статистику разработчика,",
      "граф зависимостей, семантический поиск по знаниям, список архитектурных",
      "решений и общую картину здоровья проекта.",
      "",
      "ИСПОЛЬЗУЙ для получения ОБЪЕКТИВНЫХ ДАННЫХ о проекте, а не догадок.",
      "НЕ используй когда достаточно простого grep/read — этот тулз для",
      "аналитики, а не для поиска по коду.",
    ].join("\n"),

    args: {
      query: tool.schema.enum([
        "hotspots",
        "predict_change",
        "file_history",
        "team_pulse",
        "my_stats",
        "dependency_graph",
        "knowledge_search",
        "decisions_list",
      ]),
      target: tool.schema.string().optional(),
      timeframe: tool.schema.enum(["7d", "30d", "90d", "all"]).optional(),
      limit: tool.schema.number().optional(),
    },

    async execute(args, context) {
      return wrapToolExecute("code_shadow_analyze", async () => {
        switch (args.query) {
          case "hotspots":
            return executeHotspots(storage, {
              timeframe: args.timeframe,
              limit: args.limit,
            });
          case "predict_change":
            if (!args.target) {
              throw new ShadowToolError(
                "SHADOW_ERR_MISSING_TARGET",
                'Для query="predict_change" необходимо указать target (путь к файлу).',
                { query: args.query }
              );
            }
            return executePredictChange(storage, analytics, {
              target: args.target,
            });
          case "file_history":
            if (!args.target) {
              throw new ShadowToolError(
                "SHADOW_ERR_MISSING_TARGET",
                'Для query="file_history" необходимо указать target (путь к файлу).',
                { query: args.query }
              );
            }
            return executeFileHistory(storage, {
              target: args.target,
              timeframe: args.timeframe,
            });
          case "team_pulse":
            return executeTeamPulse(storage, analytics, {
              timeframe: args.timeframe,
            });
          case "my_stats":
            return executeMyStats(storage, {
              timeframe: args.timeframe,
            });
          case "dependency_graph":
            if (!args.target) {
              throw new ShadowToolError(
                "SHADOW_ERR_MISSING_TARGET",
                'Для query="dependency_graph" необходимо указать target (путь к файлу или модулю).',
                { query: args.query }
              );
            }
            return executeDependencyGraph(storage, {
              target: args.target,
              depth: args.limit || 1,
            });
          case "knowledge_search":
            if (!args.target) {
              throw new ShadowToolError(
                "SHADOW_ERR_MISSING_TARGET",
                'Для query="knowledge_search" необходимо указать target (поисковый запрос).',
                { query: args.query }
              );
            }
            return executeKnowledgeSearch(storage, {
              query: args.target,
              limit: args.limit,
            });
          case "decisions_list":
            return executeDecisionsList(storage, {
              status: args.target as string | undefined,
              limit: args.limit,
            });
          default:
            throw new ShadowToolError(
              "SHADOW_ERR_INVALID_QUERY",
              `Неизвестный тип запроса: ${args.query}`,
              { query: args.query }
            );
        }
      });
    },
  });
}

// ============================================================
// 2. code_shadow_memory_write — запись факта в долговременную память
// ============================================================

function createMemoryWriteTool(ctx: PluginContext, storage: StorageEngine) {
  return tool({
    description: [
      "Сохраняет факт о проекте в долговременную память Code Shadow.",
      "Заменяет ctx_memory из Magic Context.",
      "",
      "ИСПОЛЬЗУЙ когда узнаёшь что-то важное о проекте:",
      "- Пути к ключевым файлам",
      "- Конфигурационные значения",
      "- Архитектурные конвенции",
      "- Именования (camelCase vs snake_case, префиксы и суффиксы)",
      "- Ограничения проекта (Node >= 18, нельзя использовать X)",
      "",
      "НЕ ИСПОЛЬЗУЙ для временных заметок — для них есть code_shadow_memory_note.",
      "НЕ ИСПОЛЬЗУЙ для архитектурных решений — для них есть code_shadow_decide.",
    ].join("\n"),

    args: {
      category: tool.schema.enum([
        "PROJECT_RULES",
        "ARCHITECTURE",
        "CONSTRAINTS",
        "CONFIG_VALUES",
        "NAMING",
      ]),
      content: tool.schema.string(),
    },

    async execute(args, context) {
      return wrapToolExecute("code_shadow_memory_write", async () => {
        // Валидация
        if (args.content.length < 10) {
          throw new ShadowToolError(
            "SHADOW_ERR_CONTENT_TOO_SHORT",
            "Содержимое должно быть не короче 10 символов.",
            { length: args.content.length }
          );
        }
        if (args.content.length > 10000) {
          throw new ShadowToolError(
            "SHADOW_ERR_CONTENT_TOO_LONG",
            "Содержимое не должно превышать 10000 символов.",
            { length: args.content.length }
          );
        }

        const db = storage.getDb();
        const now = Date.now();
        const tags = extractTags(args.content);
        const nodeId = `memory:${hashContent(args.content)}`;

        // Проверка на дубликат
        const existing = db.prepare(
          "SELECT id FROM knowledge_nodes WHERE id = ?"
        ).get(nodeId);

        if (existing) {
          // Обновляем существующую запись
          db.prepare(`
            UPDATE knowledge_nodes
            SET description = ?, metadata = ?, updated_at = ?
            WHERE id = ?
          `).run(
            args.content,
            JSON.stringify({
              category: args.category,
              tags,
              session_id: context.sessionId,
            }),
            now,
            nodeId
          );

          return {
            status: "ok",
            node_id: nodeId,
            category: args.category,
            tags,
            updated_at: now,
            message: `Факт обновлён в категории «${args.category}» (${args.content.length} символов).`,
          };
        }

        // Новая запись
        db.prepare(`
          INSERT INTO knowledge_nodes (id, type, label, description, metadata, created_at, updated_at)
          VALUES (?, 'concept', ?, ?, ?, ?, ?)
        `).run(
          nodeId,
          args.content.substring(0, 100),
          args.content,
          JSON.stringify({
            category: args.category,
            tags,
            session_id: context.sessionId,
          }),
          now,
          now
        );

        return {
          status: "ok",
          node_id: nodeId,
          category: args.category,
          tags,
          stored_at: now,
          message: `Факт сохранён в категории «${args.category}» (${args.content.length} символов).`,
        };
      });
    },
  });
}

// ============================================================
// 3. code_shadow_memory_search — поиск по всей памяти
// ============================================================

function createMemorySearchTool(ctx: PluginContext, storage: StorageEngine) {
  return tool({
    description: [
      "Ищет по всей долговременной памяти Code Shadow: факты, решения,",
      "историю файлов, паттерны. Заменяет ctx_search из Magic Context.",
      "",
      "ИСПОЛЬЗУЙ когда нужно найти информацию о модуле, файле, архитектурном",
      "решении или паттерне в проекте.",
    ].join("\n"),

    args: {
      query: tool.schema.string(),
      sources: tool.schema.array(
        tool.schema.enum(["memory", "decisions", "file_history", "analytics"])
      ).optional(),
      limit: tool.schema.number().optional(),
    },

    async execute(args, context) {
      return wrapToolExecute("code_shadow_memory_search", async () => {
        if (!args.query || args.query.trim().length === 0) {
          throw new ShadowToolError(
            "SHADOW_ERR_SEARCH_QUERY_EMPTY",
            "Поисковый запрос не может быть пустым."
          );
        }

        const db = storage.getDb();
        const query = args.query.toLowerCase();
        const sources = args.sources || ["memory", "decisions", "file_history", "analytics"];
        const limit = args.limit || 15;
        const results: Record<string, unknown>[] = [];

        if (sources.includes("memory")) {
          const rows = db.prepare(`
            SELECT id, type, label, description, metadata, updated_at
            FROM knowledge_nodes
            WHERE (label LIKE ? OR description LIKE ?) AND type != 'note'
            ORDER BY updated_at DESC LIMIT ?
          `).all(`%${query}%`, `%${query}%`, limit);
          for (const row of rows) {
            results.push({ source: "memory", ...row });
          }
        }

        if (sources.includes("decisions")) {
          const rows = db.prepare(`
            SELECT id, title AS label, decision AS description, status, tags, created_at
            FROM decisions
            WHERE title LIKE ? OR decision LIKE ? OR tags LIKE ?
            ORDER BY created_at DESC LIMIT ?
          `).all(`%${query}%`, `%${query}%`, `%${query}%`, limit);
          for (const row of rows) {
            results.push({ source: "decision", type: "decision", ...row });
          }
        }

        if (sources.includes("file_history")) {
          const rows = db.prepare(`
            SELECT DISTINCT file_path AS label, COUNT(*) AS edit_count,
                   MAX(recorded_at) AS last_edit
            FROM file_edits WHERE file_path LIKE ?
            GROUP BY file_path ORDER BY edit_count DESC LIMIT ?
          `).all(`%${query}%`, limit);
          for (const row of rows) {
            results.push({
              source: "file_history",
              type: "file",
              label: row.label,
              description: `${row.edit_count} правок, последняя: ${new Date(row.last_edit).toISOString().slice(0, 10)}`,
              metadata: { edit_count: row.edit_count, last_edit: row.last_edit },
            });
          }
        }

        if (sources.includes("analytics")) {
          const rows = db.prepare(`
            SELECT cache_key AS id, category AS type, cache_key AS label,
                   numeric_value, text_value, computed_at
            FROM analytics_cache
            WHERE cache_key LIKE ? OR text_value LIKE ?
            ORDER BY computed_at DESC LIMIT ?
          `).all(`%${query}%`, `%${query}%`, limit);
          for (const row of rows) {
            results.push({ source: "analytics", ...row });
          }
        }

        return {
          query: args.query,
          sources_queried: sources,
          results: results.slice(0, limit),
          total_found: results.length,
          search_time_ms: 0,
        };
      });
    },
  });
}

// ============================================================
// 4. code_shadow_memory_note — создание заметки-напоминания
// ============================================================

function createMemoryNoteTool(ctx: PluginContext, storage: StorageEngine) {
  return tool({
    description: [
      "Создаёт заметку-напоминание в Code Shadow.",
      "Заменяет ctx_note из Magic Context.",
      "",
      "ИСПОЛЬЗУЙ для отложенных задач и напоминаний.",
      "НЕ ИСПОЛЬЗУЙ для постоянных знаний — для них есть code_shadow_memory_write.",
    ].join("\n"),

    args: {
      content: tool.schema.string(),
      surface_condition: tool.schema.string().optional(),
    },

    async execute(args, context) {
      return wrapToolExecute("code_shadow_memory_note", async () => {
        const db = storage.getDb();
        const now = Date.now();
        const noteId = `note:${now}_${Math.random().toString(36).slice(2, 8)}`;

        db.prepare(`
          INSERT INTO knowledge_nodes (id, type, label, description, metadata, created_at, updated_at)
          VALUES (?, 'note', ?, ?, ?, ?, ?)
        `).run(
          noteId,
          args.content.substring(0, 100),
          args.content,
          JSON.stringify({
            surface_condition: args.surface_condition || null,
            session_id: context.sessionId,
            status: "active",
          }),
          now,
          now
        );

        return {
          status: "ok",
          note_id: noteId,
          surface_condition: args.surface_condition || null,
          created_at: now,
          message: args.surface_condition
            ? `Заметка создана. Напомню когда: ${args.surface_condition}`
            : "Заметка создана.",
        };
      });
    },
  });
}

// ============================================================
// 5. code_shadow_context_inject — инъекция контекста проекта
// ============================================================

function createContextInjectTool(
  ctx: PluginContext,
  storage: StorageEngine,
  analytics: AnalyticsEngine
) {
  return tool({
    description: [
      "Внедряет релевантный контекст о проекте в текущую сессию из всех",
      "источников Code Shadow: память, аналитика, решения, история.",
      "",
      "ИСПОЛЬЗУЙ в начале новой сессии на знакомом проекте.",
      "ИСПОЛЬЗУЙ с focus для контекста по конкретному модулю.",
    ].join("\n"),

    args: {
      focus: tool.schema.string().optional(),
      include: tool.schema.array(
        tool.schema.enum([
          "architecture",
          "conventions",
          "hotspots",
          "recent_changes",
          "decisions",
        ])
      ).optional(),
    },

    async execute(args, context) {
      return wrapToolExecute("code_shadow_context_inject", async () => {
        const db = storage.getDb();
        const include = args.include || [
          "architecture", "conventions", "hotspots", "recent_changes", "decisions"
        ];
        const blocks: string[] = [];

        if (include.includes("architecture")) {
          const nodes = db.prepare(`
            SELECT label, description FROM knowledge_nodes
            WHERE type = 'module' OR metadata LIKE '%ARCHITECTURE%'
            ORDER BY updated_at DESC LIMIT 10
          `).all();
          if (nodes.length > 0) {
            blocks.push("## Архитектура\n" + nodes.map(n => `- **${n.label}**: ${n.description}`).join("\n"));
          }
        }

        if (include.includes("conventions")) {
          const nodes = db.prepare(`
            SELECT description FROM knowledge_nodes
            WHERE metadata LIKE '%PROJECT_RULES%'
               OR metadata LIKE '%NAMING%'
               OR metadata LIKE '%CONFIG_VALUES%'
               OR metadata LIKE '%CONSTRAINTS%'
            ORDER BY updated_at DESC LIMIT 15
          `).all();
          if (nodes.length > 0) {
            blocks.push("## Конвенции\n" + nodes.map(n => `- ${n.description}`).join("\n"));
          }
        }

        if (include.includes("hotspots")) {
          const rows = db.prepare(`
            SELECT cache_key, numeric_value FROM analytics_cache
            WHERE category = 'hotspot' AND numeric_value > 0.5
            ORDER BY numeric_value DESC LIMIT 5
          `).all();
          if (rows.length > 0) {
            blocks.push("## Проблемные файлы\n" + rows.map(r =>
              `- \`${r.cache_key.replace("hotspot:", "")}\` — score: ${r.numeric_value.toFixed(2)}`
            ).join("\n"));
          }
        }

        if (include.includes("recent_changes")) {
          const rows = db.prepare(`
            SELECT DISTINCT file_path, COUNT(*) AS cnt
            FROM file_edits WHERE recorded_at >= ?
            GROUP BY file_path ORDER BY cnt DESC LIMIT 10
          `).all(Date.now() - 7 * 24 * 60 * 60 * 1000);
          if (rows.length > 0) {
            blocks.push("## Недавние изменения\n" + rows.map(r =>
              `- \`${r.file_path}\` — ${r.cnt} правок`
            ).join("\n"));
          }
        }

        if (include.includes("decisions")) {
          const rows = db.prepare(`
            SELECT title, decision, status FROM decisions
            WHERE status = 'accepted' ORDER BY created_at DESC LIMIT 5
          `).all();
          if (rows.length > 0) {
            blocks.push("## Архитектурные решения\n" + rows.map(d =>
              `- **${d.title}** [${d.status}]: ${d.decision}`
            ).join("\n"));
          }
        }

        if (blocks.length === 0) {
          throw new ShadowToolError(
            "SHADOW_ERR_NO_CONTEXT_AVAILABLE",
            "Нет доступного контекста. Плагин только установлен, данных недостаточно."
          );
        }

        return {
          injected_at: Date.now(),
          sections_count: blocks.length,
          context: blocks.join("\n\n"),
          focus: args.focus || null,
          message: `Контекст проекта внедрён. ${blocks.length} разделов.`,
        };
      });
    },
  });
}

// ============================================================
// 6. code_shadow_decide — запись архитектурного решения
// ============================================================

function createDecideTool(ctx: PluginContext, storage: StorageEngine) {
  return tool({
    description: [
      "Записывает архитектурное решение (ADR) в базу Code Shadow.",
      "",
      "ИСПОЛЬЗУЙ когда принимаешь важное техническое решение.",
      "НЕ ИСПОЛЬЗУЙ для мелких решений и фактов о проекте.",
    ].join("\n"),

    args: {
      title: tool.schema.string(),
      description: tool.schema.string(),
      context: tool.schema.string().optional(),
      alternatives: tool.schema.array(tool.schema.string()).optional(),
      status: tool.schema.enum(["proposed", "accepted", "deprecated", "superseded"]).optional(),
      related_files: tool.schema.array(tool.schema.string()).optional(),
      tags: tool.schema.array(tool.schema.string()).optional(),
    },

    async execute(args, context) {
      return wrapToolExecute("code_shadow_decide", async () => {
        if (args.title.length < 5) {
          throw new ShadowToolError(
            "SHADOW_ERR_TITLE_TOO_SHORT",
            "Заголовок решения должен быть не короче 5 символов.",
            { length: args.title.length }
          );
        }
        if (args.description.length < 20) {
          throw new ShadowToolError(
            "SHADOW_ERR_DESCRIPTION_TOO_SHORT",
            "Описание решения должно быть не короче 20 символов.",
            { length: args.description.length }
          );
        }

        const db = storage.getDb();
        const now = Date.now();

        // Проверка дубликата
        const existing = db.prepare(
          "SELECT id FROM decisions WHERE title = ?"
        ).get(args.title);
        if (existing) {
          throw new ShadowToolError(
            "SHADOW_ERR_DECISION_EXISTS",
            `Решение с заголовком «${args.title}» уже существует (ID: ${(existing as { id: number }).id}).`,
            { existing_id: (existing as { id: number }).id }
          );
        }

        const finalTags = args.tags && args.tags.length > 0
          ? args.tags
          : extractTags(`${args.title} ${args.description}`);

        const result = db.prepare(`
          INSERT INTO decisions (title, context, decision, consequences, status, tags, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          args.title,
          args.context || null,
          args.description,
          null,
          args.status || "proposed",
          JSON.stringify(finalTags),
          now,
          now
        );

        const decisionId = Number(result.lastInsertRowid);

        // Связываем с файлами
        if (args.related_files && args.related_files.length > 0) {
          const decisionNodeId = `decision:${decisionId}`;
          db.prepare(`
            INSERT OR IGNORE INTO knowledge_nodes (id, type, label, description, metadata, created_at, updated_at)
            VALUES (?, 'decision', ?, ?, ?, ?, ?)
          `).run(decisionNodeId, args.title, args.description, "{}", now, now);

          const insertEdge = db.prepare(`
            INSERT OR IGNORE INTO knowledge_edges (source_node_id, target_node_id, relation_type, weight, evidence, created_at)
            VALUES (?, ?, 'references', 0.8, 'manual', ?)
          `);
          for (const file of args.related_files) {
            insertEdge.run(decisionNodeId, `file:${file}`, now);
          }
        }

        return {
          status: "ok",
          decision_id: decisionId,
          title: args.title,
          status: args.status || "proposed",
          tags: finalTags,
          related_files_count: args.related_files?.length || 0,
          created_at: now,
          message: `Архитектурное решение «${args.title}» записано (ID: ${decisionId}).`,
        };
      });
    },
  });
}

// ============================================================
// Экспорт: точка входа для PluginRegistration.tools
// ============================================================

export function createAiTools(
  ctx: PluginContext,
  storage: StorageEngine,
  analytics: AnalyticsEngine
): PluginRegistration["tools"] {
  return {
    code_shadow_analyze:        createAnalyzeTool(ctx, storage, analytics),
    code_shadow_memory_write:   createMemoryWriteTool(ctx, storage),
    code_shadow_memory_search:  createMemorySearchTool(ctx, storage),
    code_shadow_memory_note:    createMemoryNoteTool(ctx, storage),
    code_shadow_context_inject: createContextInjectTool(ctx, storage, analytics),
    code_shadow_decide:         createDecideTool(ctx, storage),
  };
}
```

---

## Приложение A: Сводная таблица всех тулзов

| Тулз                          | Назначение                                   | Ключевые параметры                    | Magic Context-аналог |
|-------------------------------|----------------------------------------------|---------------------------------------|----------------------|
| `code_shadow_analyze`         | Аналитика кодовой базы (8 режимов)            | `query`, `target`, `timeframe`, `limit`| *нет аналога*        |
| `code_shadow_memory_write`    | Запись факта в долговременную память          | `category`, `content`                 | `ctx_memory`         |
| `code_shadow_memory_search`   | Поиск по всей памяти Code Shadow              | `query`, `sources`, `limit`           | `ctx_search`         |
| `code_shadow_memory_note`     | Создание заметки-напоминания                  | `content`, `surface_condition`        | `ctx_note`           |
| `code_shadow_context_inject`  | Инъекция контекста проекта в текущую сессию   | `focus`, `include`                    | *нет аналога*        |
| `code_shadow_decide`          | Запись архитектурного решения (ADR)           | `title`, `description`, `alternatives`| *нет аналога*        |

## Приложение B: Вспомогательные утилиты

```typescript
// src/tools/utils.ts

import { createHash } from "node:crypto";

/**
 * Извлекает теги из текстового содержимого:
 * пути к файлам, названия технологий, версии.
 */
export function extractTags(content: string): string[] {
  const tags: Set<string> = new Set();

  // Пути к файлам
  const filePattern = /(?:src|packages|lib|app|tests?|docs)\/[\w\/\-\.]+/gi;
  const fileMatches = content.match(filePattern);
  fileMatches?.forEach(m => tags.add(`path:${m}`));

  // Технологии
  const techPattern = /\b(?:react|next\.?js|vue|angular|express|fastify|prisma|drizzle|zod|typebox|typescript|javascript|python|rust|golang|docker|kubernetes|postgres|mysql|redis|sqlite|graphql|rest|grpc)\b/gi;
  const techMatches = content.match(techPattern);
  techMatches?.forEach(m => tags.add(`tech:${m.toLowerCase()}`));

  // Версии
  const versionPattern = /(?:>=?|<=?|~|\^)?\d+\.\d+\.\d+/g;
  const versionMatches = content.match(versionPattern);
  versionMatches?.forEach(m => tags.add(`version:${m}`));

  return [...tags].slice(0, 10);
}

/**
 * Генерирует короткий хеш содержимого для уникального ID узла.
 */
export function hashContent(content: string): string {
  return createHash("sha256")
    .update(content)
    .digest("hex")
    .substring(0, 12);
}

/**
 * Парсит строку timeframe в количество дней.
 */
export function parseTimeframe(tf: string): number {
  switch (tf) {
    case "7d":   return 7;
    case "30d":  return 30;
    case "90d":  return 90;
    case "all":  return 365 * 10; // "всё" = 10 лет
    default:     return 30;
  }
}
```

---

## Приложение C: Карта кодов ошибок

```
SHADOW_ERR_
├── DATABASE_LOCKED          (503, retryable)
├── DATABASE_CORRUPT         (500, non-retryable)
├── NOT_INITIALIZED          (503, retryable)
├── INSUFFICIENT_DATA        (404, retryable)
├── TIMEOUT                  (504, retryable)
├── INTERNAL                 (500, non-retryable)
│
├── MISSING_TARGET           (400)  — не указан target
├── INVALID_QUERY            (400)  — неизвестный query
├── INVALID_TIMEFRAME        (400)
├── INVALID_LIMIT            (400)
├── INVALID_SOURCES          (400)
├── UNKNOWN_CATEGORY         (400)
│
├── FILE_NOT_FOUND           (404)
├── NO_HOTSPOTS              (404)
├── NO_PREDICTION_DATA       (404)
├── NO_DEPENDENCIES          (404)
├── EMPTY_KNOWLEDGE_GRAPH    (404)
├── NO_DECISIONS             (404)
├── NO_CONTEXT_AVAILABLE     (404)
├── INVALID_FOCUS            (400)
│
├── SEARCH_QUERY_EMPTY       (400)
├── SEARCH_TOO_BROAD         (400)
├── NO_SOURCES               (400)
│
├── CONTENT_TOO_SHORT        (400)
├── CONTENT_TOO_LONG         (400)
├── DUPLICATE_MEMORY         (409)
│
├── TITLE_TOO_SHORT          (400)
├── DESCRIPTION_TOO_SHORT    (400)
└── DECISION_EXISTS          (409)
```

---

> **Конец документа.** Версия 1.0.0. Для предложений и правок — PR в
> [github.com/xuviga/code-shadow-ai-agent-observability](https://github.com/xuviga/code-shadow-ai-agent-observability).
