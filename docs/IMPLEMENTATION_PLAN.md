# План реализации Code Shadow

> Этот файл сохраняет исторический план и проектные варианты. Реализованный
> baseline и проверяемые команды находятся в [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).

> **Code Shadow** — плагин для OpenCode: аналитика, предиктивная безопасность и коллективная память.  
> **Версия документа:** 3.0.0 | **Дата:** 2026-07-18 | **Язык:** Русский  
> **Целевая платформа:** Bun >= 1.1, OpenCode >= 1.0.0, SQLite (bun:sqlite — встроен, без внешних зависимостей)

---

## Сводка статуса фаз

| Фаза | Статус | Ключевой результат |
|------|--------|-------------------|
| 0. Project Setup | ✅ | package.json, tsconfig, 17 файлов |
| 1. Observer Engine | ✅ | 12 хендлеров + file.edited прямой хук, bun:sqlite WAL |
| 2. Memory Engine | ✅ | write/search/note — полная замена Magic Context |
| 3. Analytics Engine | ✅ | analyze (8 режимов), context_inject, decide |
| 4. Proactive Alerts | ✅ | Toast, /shadow команды |
| 5. Developer Wrapped | ✅ | my_stats с трендами |
| 6. Auto-Memory | ✅ | 80+ правил, дедупликация 5 мин |
| 7. TUI Panel | ✅ | Реактивная (5с polling), per-project |
| 8. Autonomy | ✅ | CRUSH.md, агрессивные описания, авто-контекст |
| 9. Bug Fixes | ✅ | ctx bug, SQL params, TUI reactivity |

---

## Оглавление

1. [Общая логика реализации](#общая-логика-реализации)
2. [Фаза 0: Project Setup — День 1](#фаза-0-project-setup--день-1)
3. [Фаза 1: Observer Engine — Дни 2–4](#фаза-1-observer-engine--дни-2-4)
4. [Фаза 2: Memory Engine — Дни 5–7](#фаза-2-memory-engine--дни-5-7)
5. [Фаза 3: Analytics Engine — Дни 8–12](#фаза-3-analytics-engine--дни-8-12)
6. [Фаза 4: Proactive Alerts — Дни 13–14](#фаза-4-proactive-alerts--дни-13-14)
7. [Фаза 5: Developer Wrapped — Дни 15–16](#фаза-5-developer-wrapped--дни-15-16)
8. [Фаза 6: Auto-Memory — Авто-детект правил](#фаза-6-auto-memory--авто-детект-правил)
9. [Фаза 7: TUI Panel — Панель в сайдбаре](#фаза-7-tui-panel--панель-в-сайдбаре)
10. [Фаза 8: Автономность (Autonomy Engine)](#фаза-8-автономность-autonomy-engine)
11. [Фаза 9: Исправление критических багов](#фаза-9-исправление-критических-багов-bug-fixes--stabilization)
12. [Фаза 10: Polish & Release — Дни 17–21](#фаза-10-polish--release--дни-17-21)
13. [Риски и их предотвращение](#риски-и-их-предотвращение)
14. [Метрики успеха по фазам](#метрики-успеха-по-фазам)
15. [Приложение А: Полный index.ts](#приложение-а-полный-indexts)
16. [Приложение Б: Полный types.ts](#приложение-б-полный-typests)
17. [Приложение В: Конфигурация tsconfig.json](#приложение-в-конфигурация-tsconfigjson)

---

## Общая логика реализации

Плагин реализуется итеративно, от простого к сложному. Каждая фаза добавляет новый
слой функциональности, при этом предыдущий слой остаётся полностью работоспособным.

```
Неделя 1        Неделя 2        Неделя 3        Неделя 4
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ P0: Setup│───▶│ P1: Obsvr│───▶│ P2: Mem  │───▶│ P3: Anlt │
│ P1: Obsvr│    │ P2: Mem  │    │ P3: Anlt │    │ P4: Alrt │
└──────────┘    └──────────┘    └──────────┘    └────┬─────┘
                                                     │
                                              ┌──────┴──────┐
                                              │ P5: Wrapped │
                                              │ P6: Release │
                                              └─────────────┘
```

**Принципы разработки:**
1. Каждая фаза начинается с ветки git: `phase/N-description`
2. После завершения фазы — merge в `main`
3. Тесты пишутся **параллельно** с кодом, а не после
4. Каждый коммит должен оставлять плагин в **запускаемом** состоянии
5. Все обработчики событий оборачиваются в try/catch — плагин **никогда** не роняет OpenCode

---

## Фаза 0: Project Setup — День 1

**Цель:** Инициализировать структуру проекта, tooling, убедиться что плагин загружается.

### Шаг 0.1: Создание структуры директорий

- [ ] Выполнить в корне проекта:

```bash
mkdir -p code-shadow/src/tools
mkdir -p code-shadow/src/migrations
mkdir -p code-shadow/docs
```

Итоговая структура:

```
code-shadow/
├── src/
│   ├── index.ts              # Точка входа плагина — экспорт CodeShadow
│   ├── observer.ts           # Observer Engine — 12 обработчиков событий + Auto-Memory
│   ├── storage.ts            # Storage Engine — SQLite/WAL, миграции, CRUD + batch queue
│   ├── tui.ts                # TUI — тосты рисков, /shadow команды, инъекция контекста
│   ├── tui-plugin.tsx         # TUI панель — SolidJS статистика в сайдбаре
│   ├── types.ts              # Все TypeScript-интерфейсы + enum'ы
│   ├── config.ts             # Конфигурация плагина (загрузка/значения по умолчанию)
│   ├── install.ts            # Авто-установка в конфиг OpenCode
│   ├── logger.ts             # Файловый логгер
│   ├── tools/
│   │   ├── analyze.ts        # code_shadow_analyze — 9 режимов аналитики
│   │   ├── memory.ts         # memory_write, memory_search, memory_note (3 тулза)
│   │   ├── context.ts        # code_shadow_context_inject
│   │   └── decide.ts         # code_shadow_decide
│   └── migrations/
│       ├── 001_initial.ts    # Начальная SQL-схема: 10 таблиц + индексы
│       ├── 002_fix_event_types.ts # Исправление CHECK developer_events
│       ├── 003_lsp_error_type.ts  # Добавление 'lsp' в error_type
│       └── 004_explore_agent_type.ts # Добавление 'explore' в agent_type
├── tui-plugin.tsx             # Корневой TUI-плагин (расширенная панель)
├── tui.jsonc                  # Конфиг TUI-плагина
├── package.json
├── tsconfig.json
└── README.md
```

### Шаг 0.2: Создание package.json

- [ ] Создать `package.json`:

```json
{
  "name": "opencode-code-shadow",
  "version": "0.1.0",
  "description": "Теневой наблюдатель кодовой базы — аналитика, предиктивная безопасность и коллективная память для OpenCode",
  "main": "src/index.ts",
  "type": "module",
  "files": ["src", "tui-plugin.tsx", "tui.jsonc", "LICENSE", "README.md"],
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "keywords": ["opencode", "opencode-plugin", "analytics", "code-quality"],
  "license": "MIT",
  "peerDependencies": {
    "@opencode-ai/plugin": ">=1.0.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "bun-types": "^1.3.14"
  },
  "comment": "SQLite через bun:sqlite — встроен в Bun, не требует внешних зависимостей",
  "engines": {
    "bun": ">=1.1.0"
  }
}
```

- [ ] Установить зависимости:

```bash
cd code-shadow
bun install
```

### Шаг 0.3: Создание tsconfig.json

- [ ] Создать `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true,
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true,
    "isolatedModules": true,
    "types": ["bun-types"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

### Шаг 0.4: Проверка — «Hello World» плагина

- [ ] Создать минимальный `src/index.ts`:

```typescript
import type { PluginContext, PluginRegistration } from "@opencode-ai/plugin";

export default async function codeShadowPlugin(
  ctx: PluginContext
): Promise<PluginRegistration> {
  ctx.app.log("[CodeShadow] Плагин загружен. Путь к конфигу: " + ctx.configDir);
  ctx.app.log("[CodeShadow] Workspace: " + ctx.workspaceRoot);

  return {
    name: "code-shadow",
    description: "Аналитика, предиктивная безопасность и коллективная память для OpenCode",
    version: "0.1.0",
    hooks: [],
    tools: {},
    commands: [],
  };
}
```

- [ ] Проверить сборку:

```bash
bun run build
```

- [ ] **Критерий успеха:** Плагин компилируется без ошибок. При подключении к OpenCode в логах появляется `[CodeShadow] Плагин загружен`.

---

## Фаза 1: Observer Engine — Дни 2–4

**Цель:** Перехватывать все значимые события OpenCode и сохранять их в SQLite.

### Шаг 1.1: Инициализация SQLite (src/storage.ts)

> **ФАКТ:** В реальной реализации используется `bun:sqlite` (встроен в Bun, не требует компиляции).
> Ноль внешних зависимостей для БД — `better-sqlite3` исключён из `dependencies`.

#### Особенность bun:sqlite — SPREAD-параметры

В отличие от `better-sqlite3`, **bun:sqlite использует spread-аргументы, а не массив**:

```typescript
// ✅ ПРАВИЛЬНО (bun:sqlite)
db.prepare("SELECT * FROM t WHERE a = ?1 AND b = ?2").get(valA, valB)
db.prepare("SELECT * FROM t WHERE a = ?1 AND b = ?2").all(valA, valB)

// ❌ НЕПРАВИЛЬНО (работало в better-sqlite3, но НЕ в bun:sqlite)
db.prepare("SELECT * FROM t WHERE a = ?1 AND b = ?2").get([valA, valB])
```

**Нумерация параметров:**
- `?1`, `?2` — позиционные (рекомендуются)
- Дубликаты (`?1` дважды) получают ОДИНАКОВОЕ значение
- Количество spread-аргументов ДОЛЖНО совпадать с количеством УНИКАЛЬНЫХ номеров

#### WAL-режим для конкурентного доступа

База открывается в WAL-режиме (Write-Ahead Log), что позволяет:
- **Серверному плагину ПИСАТЬ** в БД (события, аналитика)
- **TUI-плагину ЧИТАТЬ** из БД (панель в сайдбаре)
- **Одновременный доступ без блокировок** — читатели не ждут писателей
- TUI открывает БД с `readonly: true` для максимальной безопасности

PRAGMA-конфигурация при старте:
```typescript
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");
db.pragma("cache_size = -64000"); // 64 MB кеша
```

- [ ] Реализовать `createStorageEngine()`:

```typescript
// src/storage.ts
import { Database } from "bun:sqlite";
import path from "node:path";
import fs from "node:fs";
import { applyMigrations } from "./migrations/runner";
import type { PluginContext } from "@opencode-ai/plugin";

export interface StorageEngine {
  db: Database.Database;
  insert(table: string, row: Record<string, unknown>): void;
  update(table: string, where: Record<string, unknown>, data: Record<string, unknown>): void;
  upsert(table: string, where: Record<string, unknown>, data: Record<string, unknown>): void;
  findOne(table: string, where: Record<string, unknown>): Record<string, unknown> | undefined;
  findAll(table: string, where?: Record<string, unknown>): Record<string, unknown>[];
  increment(table: string, where: Record<string, unknown>, column: string, by?: number): void;
  transaction<T>(fn: () => T): T;
  close(): void;
  getDb(): Database.Database;
}

export async function createStorageEngine(ctx: PluginContext): Promise<StorageEngine> {
  const dbDir = path.join(ctx.configDir, "shadow");
  const dbPath = path.join(dbDir, "data.db");

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(dbPath);

  // Включаем WAL-режим для конкурентного доступа
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("cache_size = -64000"); // 64 MB кеша

  // Применяем миграции
  const migrationsDir = path.join(__dirname, "migrations");
  applyMigrations(db, migrationsDir);

  // Запускаем политику хранения данных
  scheduleDataRetention(db, 90);

  const engine: StorageEngine = {
    db,

    insert(table, row) {
      const keys = Object.keys(row);
      const placeholders = keys.map(() => "?").join(", ");
      const columns = keys.join(", ");
      const stmt = db.prepare(
        `INSERT INTO ${table} (${columns}) VALUES (${placeholders})`
      );
      stmt.run(...Object.values(row));
    },

    update(table, where, data) {
      const setClause = Object.keys(data).map(k => `${k} = ?`).join(", ");
      const whereClause = Object.keys(where).map(k => `${k} = ?`).join(" AND ");
      const stmt = db.prepare(
        `UPDATE ${table} SET ${setClause} WHERE ${whereClause}`
      );
      stmt.run(...Object.values(data), ...Object.values(where));
    },

    upsert(table, where, data, onConflictUpdate?: Record<string, string>) {
      const keys = [...Object.keys(where), ...Object.keys(data)];
      const uniqueKeys = [...new Set(keys)];
      const placeholders = uniqueKeys.map(() => "?").join(", ");
      const columns = uniqueKeys.join(", ");
      const conflictTarget = Object.keys(where).join(", ");

      let onConflict = "";
      if (onConflictUpdate) {
        const updates = Object.entries(onConflictUpdate)
          .map(([col, expr]) => `${col} = ${expr}`)
          .join(", ");
        onConflict = ` ON CONFLICT(${conflictTarget}) DO UPDATE SET ${updates}`;
      }

      const values = uniqueKeys.map(k => {
        return (data as Record<string, unknown>)[k] ?? (where as Record<string, unknown>)[k];
      });

      const stmt = db.prepare(
        `INSERT INTO ${table} (${columns}) VALUES (${placeholders})${onConflict}`
      );
      stmt.run(...values);
    },

    findOne(table, where) {
      const whereClause = Object.keys(where).map(k => `${k} = ?`).join(" AND ");
      const stmt = db.prepare(
        `SELECT * FROM ${table} WHERE ${whereClause} LIMIT 1`
      );
      return stmt.get(...Object.values(where)) as Record<string, unknown> | undefined;
    },

    findAll(table, where?) {
      if (!where) {
        return db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      }
      const whereClause = Object.keys(where).map(k => `${k} = ?`).join(" AND ");
      const stmt = db.prepare(
        `SELECT * FROM ${table} WHERE ${whereClause}`
      );
      return stmt.all(...Object.values(where)) as Record<string, unknown>[];
    },

    increment(table, where, column, by = 1) {
      const whereClause = Object.keys(where).map(k => `${k} = ?`).join(" AND ");
      const stmt = db.prepare(
        `UPDATE ${table} SET ${column} = COALESCE(${column}, 0) + ? WHERE ${whereClause}`
      );
      stmt.run(by, ...Object.values(where));
    },

    transaction(fn) {
      return db.transaction(fn)();
    },

    getDb() {
      return db;
    },

    close() {
      db.close();
    },
  };

  ctx.app.log("[CodeShadow] Storage Engine инициализирован: " + dbPath);
  return engine;
}

function scheduleDataRetention(db: Database.Database, retentionDays: number): void {
  const cleanup = () => {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const result = db.transaction(() => {
      let total = 0;
      const tables = ["file_edits", "tool_executions", "session_errors",
                      "lsp_diagnostics", "risk_warnings", "command_usage"];
      for (const table of tables) {
        total += db.prepare(`DELETE FROM ${table} WHERE recorded_at < ?`).run(cutoff).changes;
      }
      return total;
    })();
    if (result > 0) {
      console.log(`[CodeShadow] Data retention: удалено ${result} записей`);
    }
  };
  cleanup();
  setInterval(cleanup, 60 * 60 * 1000);
}
```

### Шаг 1.2: Миграции базы данных (src/migrations/001_initial.ts)

- [ ] Создать файл миграции с полной схемой:

```typescript
// src/migrations/001_initial.ts
import type { Database } from "bun:sqlite";

export default function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
        version     INTEGER PRIMARY KEY,
        applied_at  INTEGER NOT NULL,
        description TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
        session_id         TEXT PRIMARY KEY,
        agent_type         TEXT NOT NULL CHECK(agent_type IN ('build', 'plan', 'general')),
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
    CREATE INDEX IF NOT EXISTS idx_sessions_status  ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_agent   ON sessions(agent_type);

    CREATE TABLE IF NOT EXISTS file_edits (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT NOT NULL,
        file_path     TEXT NOT NULL,
        extension     TEXT,
        agent_type    TEXT NOT NULL CHECK(agent_type IN ('build', 'plan', 'general')),
        edit_type     TEXT NOT NULL DEFAULT 'update'
                        CHECK(edit_type IN ('create', 'update', 'delete')),
        diff_content  TEXT,
        lines_added   INTEGER DEFAULT 0,
        lines_removed INTEGER DEFAULT 0,
        recorded_at   INTEGER NOT NULL,
        was_reverted  INTEGER DEFAULT 0 CHECK(was_reverted IN (0, 1)),
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_file_edits_session ON file_edits(session_id);
    CREATE INDEX IF NOT EXISTS idx_file_edits_path    ON file_edits(file_path);
    CREATE INDEX IF NOT EXISTS idx_file_edits_time    ON file_edits(recorded_at);
    CREATE INDEX IF NOT EXISTS idx_file_edits_path_ts ON file_edits(file_path, recorded_at);

    CREATE TABLE IF NOT EXISTS session_errors (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id       TEXT NOT NULL,
        error_type       TEXT NOT NULL CHECK(error_type IN ('tool_error', 'model_error', 'permission_denied', 'unknown')),
        error_message    TEXT NOT NULL,
        stack_trace      TEXT,
        context_file     TEXT,
        context_tool     TEXT,
        context_operation TEXT,
        recorded_at      INTEGER NOT NULL,
        resolved         INTEGER DEFAULT 0 CHECK(resolved IN (0, 1)),
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_session_errors_session ON session_errors(session_id);
    CREATE INDEX IF NOT EXISTS idx_session_errors_file    ON session_errors(context_file);
    CREATE INDEX IF NOT EXISTS idx_session_errors_time    ON session_errors(recorded_at);

    CREATE TABLE IF NOT EXISTS tool_executions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT NOT NULL,
        tool_name     TEXT NOT NULL,
        tool_args     TEXT,
        success       INTEGER NOT NULL DEFAULT 1,
        error_message TEXT,
        duration_ms   INTEGER,
        target_files  TEXT,
        agent_type    TEXT NOT NULL CHECK(agent_type IN ('build', 'plan')),
        executed_at   INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_tool_exec_session ON tool_executions(session_id);
    CREATE INDEX IF NOT EXISTS idx_tool_exec_tool    ON tool_executions(tool_name);
    CREATE INDEX IF NOT EXISTS idx_tool_exec_time    ON tool_executions(executed_at);
    CREATE INDEX IF NOT EXISTS idx_tool_exec_success ON tool_executions(success);

    CREATE TABLE IF NOT EXISTS decisions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        title         TEXT NOT NULL,
        context       TEXT,
        decision      TEXT NOT NULL,
        consequences  TEXT,
        status        TEXT DEFAULT 'proposed'
                        CHECK(status IN ('proposed', 'accepted', 'deprecated', 'superseded')),
        tags          TEXT,
        decided_at    INTEGER NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_status  ON decisions(status);
    CREATE INDEX IF NOT EXISTS idx_decisions_created ON decisions(created_at);

    CREATE TABLE IF NOT EXISTS knowledge_nodes (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL CHECK(type IN ('file', 'module', 'concept', 'component', 'api', 'note', 'decision', 'pattern', 'rule')),
        label       TEXT NOT NULL,
        description TEXT,
        metadata    TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_type ON knowledge_nodes(type);

    CREATE TABLE IF NOT EXISTS knowledge_edges (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        source_node_id  TEXT NOT NULL,
        target_node_id  TEXT NOT NULL,
        relation_type   TEXT NOT NULL CHECK(relation_type IN (
                          'depends_on', 'contains', 'imports',
                          'causes_bugs_in', 'coupled_with', 'implements',
                          'extends', 'references', 'tested_by'
                        )),
        weight          REAL DEFAULT 1.0,
        evidence        TEXT,
        created_at      INTEGER NOT NULL,
        FOREIGN KEY (source_node_id) REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
        FOREIGN KEY (target_node_id) REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
        UNIQUE(source_node_id, target_node_id, relation_type)
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_edges_source   ON knowledge_edges(source_node_id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_edges_target   ON knowledge_edges(target_node_id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_edges_relation ON knowledge_edges(relation_type);

    CREATE TABLE IF NOT EXISTS developer_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL,
        event_type  TEXT NOT NULL CHECK(event_type IN (
                      'human_fix', 'session_start', 'session_end',
                      'command_used', 'file_focus', 'tool_rejected'
                    )),
        event_data  TEXT,
        recorded_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_developer_events_type ON developer_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_developer_events_time ON developer_events(recorded_at);

    CREATE TABLE IF NOT EXISTS developer_profile (
        metric      TEXT PRIMARY KEY,
        value       REAL DEFAULT 0,
        updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS analytics_cache (
        cache_key       TEXT PRIMARY KEY,
        category        TEXT NOT NULL,
        numeric_value   REAL DEFAULT 0,
        text_value      TEXT,
        json_value      TEXT,
        computed_at     INTEGER NOT NULL,
        expires_at      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_analytics_cache_category ON analytics_cache(category);
    CREATE INDEX IF NOT EXISTS idx_analytics_cache_expires  ON analytics_cache(expires_at);

    CREATE TABLE IF NOT EXISTS risk_warnings (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT NOT NULL,
        tool_name     TEXT NOT NULL,
        target_files  TEXT NOT NULL,
        risk_score    REAL NOT NULL,
        risk_level    TEXT NOT NULL CHECK(risk_level IN ('low', 'medium', 'high', 'critical')),
        reasons       TEXT NOT NULL,
        timestamp     INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS lsp_diagnostics (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT NOT NULL,
        file_path     TEXT NOT NULL,
        error_count   INTEGER DEFAULT 0,
        warning_count INTEGER DEFAULT 0,
        hint_count    INTEGER DEFAULT 0,
        source        TEXT,
        recorded_at   INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_lsp_diagnostics_file ON lsp_diagnostics(file_path);
    CREATE INDEX IF NOT EXISTS idx_lsp_diagnostics_time ON lsp_diagnostics(recorded_at);

    CREATE TABLE IF NOT EXISTS command_usage (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT NOT NULL,
        command_name  TEXT NOT NULL,
        full_command  TEXT NOT NULL,
        args          TEXT,
        executed_at   INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS todos (
        todo_id     TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        title       TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending'
                      CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled')),
        updated_at  INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    INSERT INTO schema_version (version, applied_at, description)
    VALUES (1, ${Date.now()}, '001_initial.ts');
  `);
}
```

### Шаг 1.3: Раннер миграций (src/migrations/runner.ts)

- [ ] Создать `runner.ts`:

```typescript
// src/migrations/runner.ts
import type { Database } from "bun:sqlite";
import path from "node:path";
import fs from "node:fs";

interface MigrationModule {
  default: (db: Database.Database) => void;
}

export function applyMigrations(db: Database.Database, migrationsDir: string): void {
  // Создаём таблицу версий, если её нет
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
        version     INTEGER PRIMARY KEY,
        applied_at  INTEGER NOT NULL,
        description TEXT
    );
  `);

  const currentVersion = getCurrentVersion(db);

  // Ищем файлы миграций: 001_*.ts, 002_*.ts, ...
  const files = fs.readdirSync(migrationsDir)
    .filter(f => /^\d{3}_.+\.(ts|js)$/.test(f))
    .sort();

  for (const file of files) {
    const version = parseInt(file.substring(0, 3), 10);
    if (version <= currentVersion) continue;

    const modulePath = path.join(migrationsDir, file);
    // Динамический импорт файла миграции
    const migration = require(modulePath) as MigrationModule;

    const migrate = db.transaction(() => {
      migration.default(db);
      db.prepare(
        "INSERT INTO schema_version (version, applied_at, description) VALUES (?, ?, ?)"
      ).run(version, Date.now(), file);
    });

    try {
      migrate();
      console.log(`[CodeShadow] Миграция ${version} применена: ${file}`);
    } catch (err) {
      console.error(`[CodeShadow] Ошибка миграции ${version}:`, err);
      throw err;
    }
  }
}

function getCurrentVersion(db: Database.Database): number {
  const row = db.prepare(
    "SELECT MAX(version) as version FROM schema_version"
  ).get() as { version: number | null };
  return row.version || 0;
}
```

### Шаг 1.4: Observer — обработчики событий (src/observer.ts)

> **ФАКТ:** `file.edited` реализован как прямой именованный хук (не просто event routing),
> что обеспечивает максимальную производительность. Также добавлена точка интеграции
> Auto-Memory: при каждом `file.edited` и `tool.execute.after` вызывается
> `autoMemoryEngine.processFileEdit(filePath)` и `autoMemoryEngine.processToolCall(toolName)`.

- [ ] Реализовать `createObserver()` со всеми 11 обработчиками:

```typescript
// src/observer.ts
import type { PluginContext } from "@opencode-ai/plugin";
import type { StorageEngine } from "./storage";
import path from "node:path";

interface ObserverEngine {
  getHooks(): Array<() => void>;
  dispose(): void;
}

export function createObserver(
  ctx: PluginContext,
  storage: StorageEngine
): ObserverEngine {
  const disposers: Array<() => void> = [];

  // --- a) file.edited ---
  disposers.push(
    ctx.hooks.on("file.edited", (event: any) => {
      try {
        const projectRelative = path.relative(ctx.workspaceRoot, event.path || "");
        const ext = path.extname(event.path || "");

        storage.insert("file_edits", {
          session_id: event.sessionId || "unknown",
          file_path: projectRelative,
          extension: ext || null,
          agent_type: event.agentType || "build",
          edit_type: event.editType || "update",
          diff_content: (event.diff || "").substring(0, 500),
          lines_added: event.linesAdded || 0,
          lines_removed: event.linesRemoved || 0,
          recorded_at: event.timestamp || Date.now(),
          was_reverted: 0,
        });

        storage.increment("sessions", { session_id: event.sessionId }, "edit_count");
      } catch (err) {
        ctx.app.log("[CodeShadow] Ошибка в file.edited: " + String(err));
      }
    })
  );

  // --- b) session.created ---
  disposers.push(
    ctx.hooks.on("session.created", (event: any) => {
      try {
        storage.insert("sessions", {
          session_id: event.sessionId,
          agent_type: event.agentType || "general",
          working_directory: event.workingDirectory || ctx.workspaceRoot,
          status: "active",
          started_at: event.timestamp || Date.now(),
          edit_count: 0,
          tool_call_count: 0,
          error_count: 0,
        });
      } catch (err) {
        ctx.app.log("[CodeShadow] Ошибка в session.created: " + String(err));
      }
    })
  );

  // --- c) session.idle ---
  disposers.push(
    ctx.hooks.on("session.idle", (event: any) => {
      try {
        const session = storage.findOne("sessions", { session_id: event.sessionId });
        if (!session) return;

        const duration = (event.timestamp || Date.now()) - (session.started_at as number);

        storage.update("sessions", { session_id: event.sessionId }, {
          status: "completed",
          duration_ms: duration,
          completed_at: event.timestamp || Date.now(),
          summary: event.summary || null,
        });
      } catch (err) {
        ctx.app.log("[CodeShadow] Ошибка в session.idle: " + String(err));
      }
    })
  );

  // --- d) session.error ---
  disposers.push(
    ctx.hooks.on("session.error", (event: any) => {
      try {
        storage.insert("session_errors", {
          session_id: event.sessionId,
          error_type: "tool_error",
          error_message: event.errorMessage || "Неизвестная ошибка",
          stack_trace: event.stackTrace || null,
          context_file: event.context?.filePath || null,
          context_tool: event.context?.toolName || null,
          context_operation: event.context?.operation || null,
          recorded_at: event.timestamp || Date.now(),
          resolved: 0,
        });

        storage.increment("sessions", { session_id: event.sessionId }, "error_count");
      } catch (err) {
        ctx.app.log("[CodeShadow] Ошибка в session.error: " + String(err));
      }
    })
  );

  // --- e) session.compacted ---
  disposers.push(
    ctx.hooks.on("session.compacted", (event: any) => {
      try {
        // Создаём новую сессию — результат компактизации
        storage.insert("sessions", {
          session_id: event.sessionId,
          agent_type: "general",
          working_directory: ctx.workspaceRoot,
          status: "compacted",
          started_at: event.timestamp || Date.now(),
          edit_count: 0,
          tool_call_count: 0,
          error_count: 0,
        });
      } catch (err) {
        ctx.app.log("[CodeShadow] Ошибка в session.compacted: " + String(err));
      }
    })
  );

  // --- f) tool.execute.after ---
  disposers.push(
    ctx.hooks.on("tool.execute.after", (event: any) => {
      try {
        const targetFiles = extractTargetFiles(event.toolName, event.toolArgs);

        storage.insert("tool_executions", {
          session_id: event.sessionId,
          tool_name: event.toolName,
          tool_args: JSON.stringify(sanitizeArgs(event.toolArgs || {})).substring(0, 500),
          success: event.success ? 1 : 0,
          error_message: event.errorMessage || null,
          duration_ms: event.durationMs || 0,
          target_files: JSON.stringify(targetFiles),
          agent_type: event.agentType || "build",
          executed_at: event.timestamp || Date.now(),
        });

        storage.increment("sessions", { session_id: event.sessionId }, "tool_call_count");
      } catch (err) {
        ctx.app.log("[CodeShadow] Ошибка в tool.execute.after: " + String(err));
      }
    })
  );

  // --- g) tool.execute.before (placeholder — основная логика в Phase 4) ---
  disposers.push(
    ctx.hooks.on("tool.execute.before", (event: any) => {
      try {
        // В Phase 4 здесь будет проверка риска и показ тоста
        // Пока просто логируем
        const riskyTools = ["edit", "write"];
        if (riskyTools.includes(event.toolName)) {
          ctx.app.log(`[CodeShadow] Перехвачен tool.execute.before: ${event.toolName}`);
        }
      } catch (err) {
        ctx.app.log("[CodeShadow] Ошибка в tool.execute.before: " + String(err));
      }
    })
  );

  // --- h) command.executed ---
  disposers.push(
    ctx.hooks.on("command.executed", (event: any) => {
      try {
        storage.insert("command_usage", {
          session_id: event.sessionId || "unknown",
          command_name: event.commandName || event.command?.split(" ")[0] || "unknown",
          full_command: event.command || "",
          args: JSON.stringify(event.args || []),
          executed_at: event.timestamp || Date.now(),
        });

        // Сохраняем событие разработчика
        storage.insert("developer_events", {
          session_id: event.sessionId || "unknown",
          event_type: "command_used",
          event_data: JSON.stringify({ command: event.command }),
          recorded_at: event.timestamp || Date.now(),
        });
      } catch (err) {
        ctx.app.log("[CodeShadow] Ошибка в command.executed: " + String(err));
      }
    })
  );

  // --- i) lsp.client.diagnostics ---
  disposers.push(
    ctx.hooks.on("lsp.client.diagnostics", (event: any) => {
      try {
        const diagnostics = event.diagnostics || [];
        const counts = {
          errors: diagnostics.filter((d: any) => d.severity === "error").length,
          warnings: diagnostics.filter((d: any) => d.severity === "warning").length,
          hints: diagnostics.filter((d: any) => d.severity === "hint").length,
        };

        storage.insert("lsp_diagnostics", {
          session_id: event.sessionId || "unknown",
          file_path: event.filePath || "unknown",
          error_count: counts.errors,
          warning_count: counts.warnings,
          hint_count: counts.hints,
          source: diagnostics[0]?.source || "unknown",
          recorded_at: event.timestamp || Date.now(),
        });
      } catch (err) {
        ctx.app.log("[CodeShadow] Ошибка в lsp.client.diagnostics: " + String(err));
      }
    })
  );

  // --- j) message.updated (AI wrote, human fixed) ---
  disposers.push(
    ctx.hooks.on("message.updated", (event: any) => {
      try {
        if (event.role === "assistant" && event.wasEdited) {
          storage.insert("developer_events", {
            session_id: event.sessionId || "unknown",
            event_type: "human_fix",
            event_data: JSON.stringify({
              messageId: event.messageId,
              linesChanged: (event.newLength || 0) - (event.originalLength || 0),
            }),
            recorded_at: event.timestamp || Date.now(),
          });

          storage.upsert("developer_profile", { metric: "human_fix_count" }, {
            updated_at: Date.now(),
          });
          storage.db.prepare(
            "UPDATE developer_profile SET value = COALESCE(value, 0) + 1 WHERE metric = 'human_fix_count'"
          ).run();
        }
      } catch (err) {
        ctx.app.log("[CodeShadow] Ошибка в message.updated: " + String(err));
      }
    })
  );

  // --- k) todo.updated ---
  disposers.push(
    ctx.hooks.on("todo.updated", (event: any) => {
      try {
        storage.db.prepare(`
          INSERT INTO todos (todo_id, session_id, title, status, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(todo_id) DO UPDATE SET
            status = excluded.status,
            updated_at = excluded.updated_at
        `).run(
          event.todoId,
          event.sessionId || "unknown",
          event.title || "Без названия",
          event.status || "pending",
          event.timestamp || Date.now()
        );
      } catch (err) {
        ctx.app.log("[CodeShadow] Ошибка в todo.updated: " + String(err));
      }
    })
  );

  return {
    getHooks: () => disposers,
    dispose: () => disposers.forEach(fn => fn()),
  };
}

// --- Вспомогательные функции ---

function extractTargetFiles(toolName: string, toolArgs: any): string[] {
  if (!toolArgs) return [];
  const targets: string[] = [];

  // Ищем путь к файлу в типичных полях аргументов
  if (toolArgs.filePath) targets.push(toolArgs.filePath);
  if (toolArgs.path) targets.push(toolArgs.path);
  if (toolArgs.target) targets.push(toolArgs.target);
  if (toolArgs.file) targets.push(toolArgs.file);
  if (toolArgs.files && Array.isArray(toolArgs.files)) targets.push(...toolArgs.files);

  return targets;
}

function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  const sensitiveKeys = ["apiKey", "secret", "token", "password", "key", "auth", "credential"];

  for (const [key, value] of Object.entries(args)) {
    const isSensitive = sensitiveKeys.some(sk =>
      key.toLowerCase().includes(sk.toLowerCase())
    );
    if (isSensitive) {
      sanitized[key] = "***REDACTED***";
    } else if (typeof value === "string" && value.length > 200) {
      sanitized[key] = value.substring(0, 200) + "...";
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}
```

### Шаг 1.5: Пакетная запись (Write Buffer)

- [ ] Добавить буферизацию в `storage.ts`:

```typescript
// Дополнение к storage.ts — Write Buffer
class WriteBuffer {
  private queue: Array<{ table: string; row: Record<string, unknown> }> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private maxBatchSize: number;
  private flushIntervalMs: number;

  constructor(
    private db: Database.Database,
    maxBatchSize = 10,
    flushIntervalMs = 5000
  ) {
    this.maxBatchSize = maxBatchSize;
    this.flushIntervalMs = flushIntervalMs;
    this.timer = setInterval(() => this.flush(), flushIntervalMs);

    // Сбрасываем буфер при завершении процесса
    process.on("beforeExit", () => this.flush());
    process.on("SIGINT", () => { this.flush(); process.exit(); });
    process.on("SIGTERM", () => { this.flush(); process.exit(); });
  }

  enqueue(table: string, row: Record<string, unknown>): void {
    this.queue.push({ table, row });
    if (this.queue.length >= this.maxBatchSize) {
      this.flush();
    }
  }

  flush(): number {
    if (this.queue.length === 0) return 0;
    const batch = [...this.queue];
    this.queue = [];

    try {
      this.db.transaction(() => {
        for (const { table, row } of batch) {
          const keys = Object.keys(row);
          const placeholders = keys.map(() => "?").join(", ");
          const columns = keys.join(", ");
          this.db.prepare(
            `INSERT INTO ${table} (${columns}) VALUES (${placeholders})`
          ).run(...Object.values(row));
        }
      })();
    } catch (err) {
      console.error("[CodeShadow] Ошибка сброса буфера:", err);
      // Возвращаем в очередь для повторной попытки
      this.queue.unshift(...batch);
    }

    return batch.length;
  }

  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
  }
}
```

### Шаг 1.6: Верификация Observer Engine

- [ ] Запустить OpenCode с подключённым плагином
- [ ] Провести 5–10 сессий (любые действия: редактирование файлов, вызовы тулзов)
- [ ] После завершения — выполнить SQL-запросы:

```bash
# Проверка таблицы сессий
sqlite3 ~/.config/opencode/shadow/data.db "SELECT session_id, status, started_at FROM sessions;"

# Проверка таблицы правок
sqlite3 ~/.config/opencode/shadow/data.db "SELECT COUNT(*) AS edit_count FROM file_edits;"

# Проверка таблицы ошибок
sqlite3 ~/.config/opencode/shadow/data.db "SELECT COUNT(*) AS error_count FROM session_errors;"

# Проверка выполнения тулзов
sqlite3 ~/.config/opencode/shadow/data.db "SELECT tool_name, COUNT(*) FROM tool_executions GROUP BY tool_name;"
```

- [ ] **Критерий успеха:** Все таблицы содержат реальные данные. `file_edits` — не пустая.

---

## Фаза 2: Memory Engine — Дни 5–7

**Цель:** Реализовать инструменты памяти: `code_shadow_memory_write`, `code_shadow_memory_search`, `code_shadow_memory_note`, `code_shadow_context_inject`, `code_shadow_decide`.

### Шаг 2.1: Типы данных (src/types.ts)

- [ ] Создать полный набор TypeScript-интерфейсов:

```typescript
// src/types.ts

export interface PluginConfig {
  warningThreshold: number;
  retentionDays: number;
  batchSize: number;
  flushIntervalMs: number;
  cacheTimeouts: Record<string, number>;
}

export const DEFAULT_CONFIG: PluginConfig = {
  warningThreshold: 0.6,
  retentionDays: 90,
  batchSize: 10,
  flushIntervalMs: 5000,
  cacheTimeouts: {
    hotspots: 60 * 60 * 1000,       // 1 час
    predictions: 30 * 60 * 1000,    // 30 минут
    developerProfile: 60 * 60 * 1000,
    knowledgeGraph: 6 * 60 * 60 * 1000,
  },
};

export interface HotspotEntry {
  filePath: string;
  score: number;        // 0–100
  rank: number;
  factors: {
    editFrequency: number;      // 0–1 нормализованный
    errorRate: number;          // 0–1 нормализованный
    recentChanges: number;      // 0–1 нормализованный
    developerFrustration: number; // 0–1 нормализованный
  };
  explanation: string;
}

export interface RiskPrediction {
  riskScore: number;
  riskLevel: "low" | "medium" | "high" | "critical";
  primaryFile: string;
  affectedFiles: Array<{
    path: string;
    riskContribution: number;
    relationType: string;
    breakageProbability: number;
  }>;
  recentSimilarChanges: Array<{
    file: string;
    date: string;
    result: string;
  }>;
  dependencyCount: number;
  historicalBreakageRate: number;
  recommendation: string;
}

export interface DeveloperProfile {
  sessionsPerDay: number;
  avgSessionDurationMs: number;
  toolUsageDistribution: Record<string, number>;
  topFiles: Array<{ path: string; edits: number }>;
  aiRelianceRatio: number;
  fixRate: number;
  trends: {
    sessionsTrend: "improving" | "stable" | "declining";
    fixRateTrend: "improving" | "stable" | "declining";
    productivityTrend: "improving" | "stable" | "declining";
  };
  recentActivity: {
    last7Days: { sessions: number; edits: number; errors: number };
    last30Days: { sessions: number; edits: number; errors: number };
    last90Days: { sessions: number; edits: number; errors: number };
  };
}

export interface TeamPulse {
  projectHealthScore: number;     // 0–1
  trend: "improving" | "stable" | "declining";
  totalFiles: number;
  activeFiles: number;
  hotspotCount: number;
  aiRelianceRatio: number;
  errorRate: number;
  topConcern: string;
  healthOverTime: Array<{ month: string; score: number }>;
  moduleBreakdown: Array<{
    module: string;
    healthScore: number;
    files: number;
    hotspot: string | null;
  }>;
}

export interface MemoryWriteInput {
  category: "PROJECT_RULES" | "ARCHITECTURE" | "CONSTRAINTS" | "CONFIG_VALUES" | "NAMING";
  content: string;
}

export interface MemorySearchInput {
  query: string;
  sources?: Array<"memory" | "decisions" | "file_history" | "analytics">;
  limit?: number;
}

export interface MemoryNoteInput {
  content: string;
  surfaceCondition?: string;
}

export interface ContextInjectInput {
  focus?: string;
  include?: Array<"architecture" | "conventions" | "hotspots" | "recent_changes" | "decisions">;
}

export interface DecideInput {
  title: string;
  description: string;
  context?: string;
  alternatives?: string[];
  status?: "proposed" | "accepted" | "deprecated" | "superseded";
  relatedFiles?: string[];
  tags?: string[];
}
```

### Шаг 2.2: Инструмент code_shadow_memory_write (src/tools/memory.ts, часть 1)

- [ ] Реализовать `createMemoryWriteTool()`:

```typescript
// src/tools/memory.ts
import { tool } from "@opencode-ai/plugin-sdk";
import type { PluginContext } from "@opencode-ai/plugin";
import type { StorageEngine } from "../storage";
import { extractTags, hashContent } from "./utils";

export function createMemoryWriteTool(ctx: PluginContext, storage: StorageEngine) {
  return tool({
    name: "code_shadow_memory_write",
    description: [
      "Сохраняет факт о проекте в долговременную память Code Shadow.",
      "Заменяет ctx_memory из Magic Context.",
      "",
      "ИСПОЛЬЗУЙ когда узнаёшь что-то важное о проекте:",
      "- Пути к ключевым файлам, архитектурные конвенции",
      "- Конфигурационные значения, ограничения",
      "- Правила именования",
      "",
      "НЕ ИСПОЛЬЗУЙ для временных заметок — для них есть code_shadow_memory_note.",
      "НЕ ИСПОЛЬЗУЙ для архитектурных решений — для них есть code_shadow_decide.",
    ].join("\n"),

    args: {
      category: tool.schema.enum([
        "PROJECT_RULES", "ARCHITECTURE", "CONSTRAINTS", "CONFIG_VALUES", "NAMING",
      ]),
      content: tool.schema.string(),
    },

    async execute(args: { category: string; content: string }, context: any) {
      const db = storage.getDb();
      const now = Date.now();
      const tags = extractTags(args.content);
      const nodeId = `memory:${hashContent(args.content)}`;

      // Проверяем дубликат
      const existing = db.prepare(
        "SELECT id FROM knowledge_nodes WHERE id = ?"
      ).get(nodeId);

      if (existing) {
        db.prepare(`
          UPDATE knowledge_nodes
          SET description = ?, metadata = ?, updated_at = ?
          WHERE id = ?
        `).run(
          args.content,
          JSON.stringify({ category: args.category, tags, session_id: context.sessionId }),
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

      db.prepare(`
        INSERT INTO knowledge_nodes (id, type, label, description, metadata, created_at, updated_at)
        VALUES (?, 'concept', ?, ?, ?, ?, ?)
      `).run(
        nodeId,
        args.content.substring(0, 100),
        args.content,
        JSON.stringify({ category: args.category, tags, session_id: context.sessionId }),
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
    },
  });
}
```

### Шаг 2.3: Инструмент code_shadow_memory_search (src/tools/memory.ts, часть 2)

- [ ] Реализовать `createMemorySearchTool()`:

```typescript
export function createMemorySearchTool(ctx: PluginContext, storage: StorageEngine) {
  return tool({
    name: "code_shadow_memory_search",
    description: [
      "Ищет по всей долговременной памяти Code Shadow: факты, решения,",
      "историю файлов, аналитические данные.",
      "Заменяет ctx_search из Magic Context.",
      "",
      "ИСПОЛЬЗУЙ когда нужно найти:",
      "- Информацию о модуле или файле",
      "- Архитектурные решения по теме",
      "- Паттерны, конвенции, историю изменений",
    ].join("\n"),

    args: {
      query: tool.schema.string(),
      sources: tool.schema.array(
        tool.schema.enum(["memory", "decisions", "file_history", "analytics"])
      ).optional(),
      limit: tool.schema.number().optional(),
    },

    async execute(args: {
      query: string;
      sources?: string[];
      limit?: number;
    }, context: any) {
      const db = storage.getDb();
      const query = args.query.toLowerCase();
      const sources = args.sources || ["memory", "decisions", "file_history", "analytics"];
      const limit = args.limit || 15;
      const results: any[] = [];
      const startTime = Date.now();

      // 1. Поиск по knowledge_nodes (память)
      if (sources.includes("memory")) {
        const rows = db.prepare(`
          SELECT id, type, label, description, metadata, updated_at
          FROM knowledge_nodes
          WHERE (label LIKE ? OR description LIKE ?) AND type != 'note'
          ORDER BY updated_at DESC LIMIT ?
        `).all(`%${query}%`, `%${query}%`, limit);

        for (const row of rows as any[]) {
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

      // 2. Поиск по decisions
      if (sources.includes("decisions")) {
        const rows = db.prepare(`
          SELECT id, title AS label, decision AS description, status, tags, created_at
          FROM decisions
          WHERE title LIKE ? OR decision LIKE ? OR tags LIKE ?
          ORDER BY created_at DESC LIMIT ?
        `).all(`%${query}%`, `%${query}%`, `%${query}%`, limit);

        for (const row of rows as any[]) {
          results.push({
            source: "decision",
            type: "decision",
            id: row.id,
            label: row.label,
            description: row.description?.substring(0, 200),
            status: row.status,
            tags: JSON.parse(row.tags || "[]"),
            created_at: row.created_at,
          });
        }
      }

      // 3. Поиск по file_edits
      if (sources.includes("file_history")) {
        const rows = db.prepare(`
          SELECT DISTINCT file_path AS label, COUNT(*) AS edit_count, MAX(recorded_at) AS last_edit
          FROM file_edits WHERE file_path LIKE ?
          GROUP BY file_path ORDER BY edit_count DESC LIMIT ?
        `).all(`%${query}%`, limit);

        for (const row of rows as any[]) {
          results.push({
            source: "file_history",
            type: "file",
            label: row.label,
            description: `Редактировался ${row.edit_count} раз(а). Последнее: ${new Date(row.last_edit).toISOString().slice(0, 10)}`,
            metadata: { edit_count: row.edit_count, last_edit: row.last_edit },
          });
        }
      }

      // 4. Поиск по analytics_cache
      if (sources.includes("analytics")) {
        const rows = db.prepare(`
          SELECT cache_key AS id, category AS type, numeric_value, text_value, computed_at
          FROM analytics_cache
          WHERE cache_key LIKE ? OR text_value LIKE ?
          ORDER BY computed_at DESC LIMIT ?
        `).all(`%${query}%`, `%${query}%`, limit);

        for (const row of rows as any[]) {
          results.push({
            source: "analytics",
            id: row.id,
            type: row.type,
            label: row.id,
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
        search_time_ms: Date.now() - startTime,
      };
    },
  });
}
```

### Шаг 2.4: Инструмент code_shadow_memory_note (src/tools/memory.ts, часть 3)

- [ ] Реализовать `createMemoryNoteTool()`:

```typescript
export function createMemoryNoteTool(ctx: PluginContext, storage: StorageEngine) {
  return tool({
    name: "code_shadow_memory_note",
    description: [
      "Создаёт заметку-напоминание в Code Shadow.",
      "Заменяет ctx_note из Magic Context.",
      "",
      "ИСПОЛЬЗУЙ для отложенных задач и напоминаний.",
      "Поддерживает surface_condition для умных заметок.",
      "НЕ ИСПОЛЬЗУЙ для постоянных знаний — для них есть code_shadow_memory_write.",
    ].join("\n"),

    args: {
      content: tool.schema.string(),
      surface_condition: tool.schema.string().optional(),
    },

    async execute(args: { content: string; surface_condition?: string }, context: any) {
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
    },
  });
}
```

### Шаг 2.5: Инструмент code_shadow_context_inject (src/tools/context.ts)

- [ ] Реализовать `createContextInjectTool()`:

```typescript
// src/tools/context.ts
import { tool } from "@opencode-ai/plugin-sdk";
import type { PluginContext } from "@opencode-ai/plugin";
import type { StorageEngine } from "../storage";
import type { AnalyticsEngine } from "../analytics";

export function createContextInjectTool(
  ctx: PluginContext,
  storage: StorageEngine,
  analytics: AnalyticsEngine
) {
  return tool({
    name: "code_shadow_context_inject",
    description: [
      "Внедряет релевантный контекст о проекте в текущую сессию из ВСЕХ источников",
      "Code Shadow: архитектура, конвенции, hotspots, недавние изменения, решения.",
      "",
      "ИСПОЛЬЗУЙ в начале сессии на знакомом проекте, чтобы восстановить контекст.",
      "ИСПОЛЬЗУЙ с focus для контекста конкретного модуля/файла.",
    ].join("\n"),

    args: {
      focus: tool.schema.string().optional(),
      include: tool.schema.array(
        tool.schema.enum([
          "architecture", "conventions", "hotspots", "recent_changes", "decisions",
        ])
      ).optional(),
    },

    async execute(args: {
      focus?: string;
      include?: string[];
    }, context: any) {
      const db = storage.getDb();
      const include = args.include || [
        "architecture", "conventions", "hotspots", "recent_changes", "decisions",
      ];
      const blocks: string[] = [];
      let sectionsCount = 0;

      if (include.includes("architecture")) {
        const nodes = db.prepare(`
          SELECT label, description FROM knowledge_nodes
          WHERE type = 'module' OR metadata LIKE '%ARCHITECTURE%'
          ORDER BY updated_at DESC LIMIT 10
        `).all() as any[];

        if (nodes.length > 0) {
          blocks.push("## Архитектура проекта\n");
          for (const n of nodes) {
            blocks.push(`- **${n.label}**: ${n.description}`);
          }
          sectionsCount++;
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
        `).all() as any[];

        if (nodes.length > 0) {
          blocks.push("\n## Конвенции и ограничения\n");
          for (const n of nodes) {
            blocks.push(`- ${n.description}`);
          }
          sectionsCount++;
        }
      }

      if (include.includes("hotspots")) {
        const rows = db.prepare(`
          SELECT cache_key, numeric_value FROM analytics_cache
          WHERE category = 'hotspot' AND numeric_value > 0.5
          ORDER BY numeric_value DESC LIMIT 5
        `).all() as any[];

        if (rows.length > 0) {
          blocks.push("\n## Проблемные файлы (hotspots)\n");
          for (const r of rows) {
            const fileName = r.cache_key.replace("hotspot:", "");
            blocks.push(`- \`${fileName}\` — score: ${r.numeric_value.toFixed(2)}`);
          }
          sectionsCount++;
        }
      }

      if (include.includes("recent_changes")) {
        const rows = db.prepare(`
          SELECT DISTINCT file_path, COUNT(*) AS cnt
          FROM file_edits WHERE recorded_at >= ?
          GROUP BY file_path ORDER BY cnt DESC LIMIT 10
        `).all(Date.now() - 7 * 24 * 60 * 60 * 1000) as any[];

        if (rows.length > 0) {
          blocks.push("\n## Недавние изменения (7 дней)\n");
          for (const r of rows) {
            blocks.push(`- \`${r.file_path}\` — ${r.cnt} правок`);
          }
          sectionsCount++;
        }
      }

      if (include.includes("decisions")) {
        const rows = db.prepare(`
          SELECT title, decision, status FROM decisions
          WHERE status = 'accepted' ORDER BY created_at DESC LIMIT 5
        `).all() as any[];

        if (rows.length > 0) {
          blocks.push("\n## Ключевые архитектурные решения\n");
          for (const d of rows) {
            blocks.push(`- **${d.title}** [${d.status}]: ${d.decision}`);
          }
          sectionsCount++;
        }
      }

      if (args.focus) {
        const focusInfo = await gatherFocusContext(db, args.focus);
        if (focusInfo) {
          blocks.push(`\n## Контекст для: ${args.focus}\n`);
          blocks.push(focusInfo);
          sectionsCount++;
        }
      }

      return {
        injected_at: Date.now(),
        sections_count: sectionsCount,
        context: blocks.join("\n"),
        focus: args.focus || null,
        message: `Контекст проекта внедрён. ${sectionsCount} разделов.`,
      };
    },
  });
}

async function gatherFocusContext(
  db: any,
  focus: string
): Promise<string | null> {
  const lines: string[] = [];

  // Ищем файл
  const file = db.prepare(`
    SELECT file_path, COUNT(*) AS cnt
    FROM file_edits WHERE file_path LIKE ?
    GROUP BY file_path ORDER BY cnt DESC LIMIT 5
  `).all(`%${focus}%`) as any[];

  if (file.length > 0) {
    lines.push("**Связанные файлы:**");
    for (const f of file) {
      lines.push(`- \`${f.file_path}\` — ${f.cnt} правок`);
    }
  }

  // Ищем зависимости
  const deps = db.prepare(`
    SELECT source_node_id, target_node_id, relation_type, weight
    FROM knowledge_edges
    WHERE source_node_id LIKE ? OR target_node_id LIKE ?
    ORDER BY weight DESC LIMIT 10
  `).all(`%${focus}%`, `%${focus}%`) as any[];

  if (deps.length > 0) {
    lines.push("\n**Зависимости из графа знаний:**");
    for (const d of deps) {
      const source = d.source_node_id.replace("file:", "");
      const target = d.target_node_id.replace("file:", "");
      lines.push(`- ${source} → ${target} (${d.relation_type}, вес: ${d.weight.toFixed(2)})`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : null;
}
```

### Шаг 2.6: Инструмент code_shadow_decide (src/tools/decide.ts)

- [ ] Реализовать `createDecideTool()`:

```typescript
// src/tools/decide.ts
import { tool } from "@opencode-ai/plugin-sdk";
import type { PluginContext } from "@opencode-ai/plugin";
import type { StorageEngine } from "../storage";
import { extractTags } from "./utils";

export function createDecideTool(ctx: PluginContext, storage: StorageEngine) {
  return tool({
    name: "code_shadow_decide",
    description: [
      "Записывает архитектурное решение (ADR) в базу Code Shadow.",
      "",
      "ИСПОЛЬЗУЙ когда принимаешь важное техническое решение:",
      "- Выбор библиотеки или фреймворка",
      "- Архитектурный паттерн",
      "- Формат данных или протокол",
      "- Стратегия кеширования, маршрутизации и т.д.",
      "",
      "НЕ ИСПОЛЬЗУЙ для мелких решений (название переменной, форматирование).",
      "НЕ ИСПОЛЬЗУЙ для фактов о проекте — для них code_shadow_memory_write.",
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

    async execute(args: {
      title: string;
      description: string;
      context?: string;
      alternatives?: string[];
      status?: string;
      related_files?: string[];
      tags?: string[];
    }, context: any) {
      const db = storage.getDb();
      const now = Date.now();

      const finalTags = args.tags?.length
        ? args.tags
        : extractTags(`${args.title} ${args.description}`);

      const result = db.prepare(`
        INSERT INTO decisions (title, context, decision, consequences, status, tags, decided_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        args.title,
        args.context || null,
        args.description,
        null,
        args.status || "proposed",
        JSON.stringify(finalTags),
        now,
        now,
        now
      );

      const decisionId = result.lastInsertRowid;

      // Связываем с файлами через knowledge_edges
      if (args.related_files && args.related_files.length > 0) {
        const decisionNodeId = `decision:${decisionId}`;

        db.prepare(`
          INSERT OR IGNORE INTO knowledge_nodes (id, type, label, description, metadata, created_at, updated_at)
          VALUES (?, 'decision', ?, ?, ?, ?, ?)
        `).run(
          decisionNodeId,
          args.title,
          args.description,
          JSON.stringify({ status: args.status || "proposed", tags: finalTags }),
          now,
          now
        );

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
        decision_id: Number(decisionId),
        title: args.title,
        decision_status: args.status || "proposed",
        tags: finalTags,
        related_files_count: args.related_files?.length || 0,
        created_at: now,
        message: `Архитектурное решение «${args.title}» записано (ID: ${decisionId}).`,
      };
    },
  });
}
```

### Шаг 2.7: Вспомогательные утилиты (src/tools/utils.ts)

- [ ] Создать `src/tools/utils.ts`:

```typescript
// src/tools/utils.ts

export function extractTags(content: string): string[] {
  const tags: Set<string> = new Set();

  // Пути к файлам
  const fileMatches = content.match(/(?:src|packages|lib|app|tests?|docs)\/[\w\/\-\.]+/gi);
  fileMatches?.forEach(m => tags.add(`path:${m}`));

  // Технологии
  const techPattern = /\b(?:react|next\.?js|vue|angular|express|fastify|prisma|drizzle|zod|typebox|typescript|javascript|python|rust|golang|docker|kubernetes|postgres|mysql|redis|sqlite|graphql|rest|grpc)\b/gi;
  const techMatches = content.match(techPattern);
  techMatches?.forEach(m => tags.add(`tech:${m.toLowerCase()}`));

  // Версии (semver)
  const versionMatches = content.match(/(?:>=?|<=?|~|\^)?\d+\.\d+\.\d+/g);
  versionMatches?.forEach(m => tags.add(`version:${m}`));

  return [...tags].slice(0, 10);
}

export function hashContent(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return "h" + Math.abs(hash).toString(36);
}

export function parseTimeframeDays(tf: string): number {
  switch (tf) {
    case "7d": return 7;
    case "30d": return 30;
    case "90d": return 90;
    case "all": return 365 * 10; // 10 лет
    default: return 30;
  }
}
```

### Шаг 2.8: Верификация Memory Engine

- [ ] Открыть сессию OpenCode и попросить AI вызвать тулзы:

```
"Запиши в память факт: проект использует Zod для валидации."
"Найди в памяти информацию о валидации."
"Создай заметку: проверить типы после миграции на Zod."
"Внедри контекст проекта."
"Запиши архитектурное решение: переходим с REST на GraphQL."
```

- [ ] Проверить SQLite:

```bash
sqlite3 ~/.config/opencode/shadow/data.db "SELECT id, label, type FROM knowledge_nodes;"
sqlite3 ~/.config/opencode/shadow/data.db "SELECT * FROM decisions;"
```

- [ ] **Критерий успеха:** Все пять тулзов возвращают корректные результаты. Данные сохраняются между сессиями.

---

## Фаза 3: Analytics Engine — Дни 8–12

**Цель:** Вычислять hotspots, predictions, developer stats, knowledge graph из собранных данных.

### Шаг 3.1: Алгоритм Hotspot (src/analytics.ts, часть 1)

- [ ] Реализовать `computeHotspots()`:

```typescript
// src/analytics.ts
import type { StorageEngine } from "./storage";
import type { HotspotEntry, RiskPrediction, DeveloperProfile, TeamPulse } from "./types";

export interface AnalyticsEngine {
  computeHotspots(timeframe?: string, limit?: number): Promise<HotspotEntry[]>;
  predictRisk(targetFiles: string[], toolName?: string): Promise<RiskPrediction>;
  getDeveloperProfile(timeframe?: string): Promise<DeveloperProfile>;
  getTeamPulse(timeframe?: string): Promise<TeamPulse>;
  updateKnowledgeGraph(): Promise<void>;
  getHotspotsCached(): Promise<HotspotEntry[]>;
}

export function createAnalyticsEngine(storage: StorageEngine): AnalyticsEngine {
  const db = storage.getDb();

  async function computeHotspots(
    timeframe = "30d",
    limit = 20
  ): Promise<HotspotEntry[]> {
    const days = timeframe === "7d" ? 7 : timeframe === "30d" ? 30 : timeframe === "90d" ? 90 : 3650;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    // 1. Частота правок (E)
    const editCounts = db.prepare(`
      SELECT file_path, COUNT(*) as cnt
      FROM file_edits
      WHERE recorded_at >= ?
      GROUP BY file_path
    `).all(cutoff) as Array<{ file_path: string; cnt: number }>;

    // 2. Частота ошибок (R)
    const errorCounts = db.prepare(`
      SELECT context_file as file_path, COUNT(*) as cnt
      FROM session_errors
      WHERE context_file IS NOT NULL AND recorded_at >= ?
      GROUP BY context_file
    `).all(cutoff) as Array<{ file_path: string; cnt: number }>;

    // 3. Недавние изменения (C)
    const recentEdits = db.prepare(`
      SELECT file_path, COUNT(*) as cnt
      FROM file_edits
      WHERE recorded_at >= ?
      GROUP BY file_path
    `).all(sevenDaysAgo) as Array<{ file_path: string; cnt: number }>;

    // 4. Фрустрация (F) — откаты изменений
    const frustration = db.prepare(`
      SELECT file_path, COUNT(*) as cnt
      FROM file_edits
      WHERE was_reverted = 1 AND recorded_at >= ?
      GROUP BY file_path
    `).all(cutoff) as Array<{ file_path: string; cnt: number }>;

    // Нормализация
    const maxEdit = Math.max(1, ...editCounts.map(e => e.cnt));
    const maxError = Math.max(1, ...errorCounts.map(e => e.cnt));
    const maxRecent = Math.max(1, ...recentEdits.map(e => e.cnt));
    const maxFrustr = Math.max(1, ...frustration.map(f => f.cnt));

    const editMap = new Map(editCounts.map(e => [e.file_path, e.cnt]));
    const errorMap = new Map(errorCounts.map(e => [e.file_path, e.cnt]));
    const recentMap = new Map(recentEdits.map(e => [e.file_path, e.cnt]));
    const frustrMap = new Map(frustration.map(f => [f.file_path, f.cnt]));

    const allFiles = new Set([
      ...editMap.keys(),
      ...errorMap.keys(),
    ]);

    const hotspots: HotspotEntry[] = [];

    for (const file of allFiles) {
      const E = (editMap.get(file) || 0) / maxEdit;
      const R = (errorMap.get(file) || 0) / maxError;
      const C = (recentMap.get(file) || 0) / maxRecent;
      const F = (frustrMap.get(file) || 0) / maxFrustr;

      const score = Math.round(
        (E * 0.3 + R * 0.4 + C * 0.2 + F * 0.1) * 100
      );

      hotspots.push({
        filePath: file,
        score,
        rank: 0,
        factors: {
          editFrequency: Math.round(E * 100) / 100,
          errorRate: Math.round(R * 100) / 100,
          recentChanges: Math.round(C * 100) / 100,
          developerFrustration: Math.round(F * 100) / 100,
        },
        explanation: generateHotspotExplanation(file, E, R, C, F, editMap, errorMap, frustrMap),
      });
    }

    hotspots.sort((a, b) => b.score - a.score);
    hotspots.forEach((h, i) => (h.rank = i + 1));

    // Кешируем результат
    db.prepare(`
      INSERT OR REPLACE INTO analytics_cache (cache_key, category, json_value, computed_at, expires_at)
      VALUES (?, 'hotspot', ?, ?, ?)
    `).run(
      `hotspots:${timeframe}`,
      JSON.stringify(hotspots),
      now,
      now + 60 * 60 * 1000 // 1 час TTL
    );

    return hotspots.slice(0, limit);
  }

  function generateHotspotExplanation(
    file: string,
    E: number, R: number, C: number, F: number,
    editMap: Map<string, number>,
    errorMap: Map<string, number>,
    frustrMap: Map<string, number>
  ): string {
    const parts: string[] = [];
    const edits = editMap.get(file) || 0;
    const errors = errorMap.get(file) || 0;
    const frustration = frustrMap.get(file) || 0;

    if (edits > 10) parts.push(`${edits} правок`);
    if (errors > 0) parts.push(`${errors} ошибок`);
    if (frustration > 0) parts.push(`${frustration} откатов`);
    if (C > 0.5) parts.push("активно менялся последние 7 дней");

    return parts.length > 0 ? parts.join(", ") : "недостаточно данных";
  }

  // Дальнейшие части — см. шаги 3.2–3.5

  // ...
}
```

### Шаг 3.2: Prediction Engine (src/analytics.ts, часть 2)

- [ ] Реализовать `predictRisk()`:

```typescript
async function predictRisk(
  targetFiles: string[],
  toolName = "edit"
): Promise<RiskPrediction> {
  const now = Date.now();
  const primaryFile = targetFiles[0];

  // 1. Историческая частота поломок
  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total_edits,
      COUNT(DISTINCT se.id) AS total_errors
    FROM file_edits fe
    LEFT JOIN session_errors se
      ON se.context_file = fe.file_path
    WHERE fe.file_path = ?
  `).get(primaryFile) as { total_edits: number; total_errors: number };

  const breakageRate = stats.total_edits > 0
    ? stats.total_errors / stats.total_edits
    : 0;

  // 2. Файлы, которые ломались вместе с целевым
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
  `).all(primaryFile, primaryFile, primaryFile) as Array<{
    affected_file: string; co_break_count: number;
  }>;

  // 3. Зависимости из knowledge_edges
  const dependencies = db.prepare(`
    SELECT target_node_id, relationship_type, weight
    FROM knowledge_edges
    WHERE source_node_id = ?
      AND relation_type IN ('depends_on', 'causes_bugs_in', 'coupled_with')
    ORDER BY weight DESC
  `).all(`file:${primaryFile}`) as Array<{
    target_node_id: string; relation_type: string; weight: number;
  }>;

  // 4. Похожие изменения в истории
  const similarChanges = db.prepare(`
    SELECT
      fe.file_path AS file,
      fe.recorded_at AS date,
      CASE WHEN se.id IS NOT NULL THEN 'broke something' ELSE 'clean' END AS result
    FROM file_edits fe
    LEFT JOIN session_errors se
      ON se.session_id = fe.session_id
      AND se.context_file = fe.file_path
    WHERE fe.file_path = ?
    ORDER BY fe.recorded_at DESC
    LIMIT 5
  `).all(primaryFile) as Array<{ file: string; date: number; result: string }>;

  // 5. Вычисление финального risk_score
  const depsWeight = dependencies.reduce((sum, d) => sum + d.weight, 0);
  const riskScore = Math.min(
    breakageRate * 0.5 +
    Math.min(depsWeight / 10, 1) * 0.3 +
    Math.min(coBrokenFiles.length / 5, 1) * 0.2,
    1.0
  );

  const riskLevel: RiskPrediction["riskLevel"] =
    riskScore < 0.3 ? "low"
    : riskScore < 0.6 ? "medium"
    : riskScore < 0.8 ? "high"
    : "critical";

  const recommendation = buildRiskRecommendation(riskLevel, breakageRate, coBrokenFiles);

  return {
    riskScore: Math.round(riskScore * 100) / 100,
    riskLevel,
    primaryFile,
    affectedFiles: coBrokenFiles.map(f => {
      const dep = dependencies.find(d =>
        d.target_node_id.replace("file:", "") === f.affected_file
      );
      return {
        path: f.affected_file,
        riskContribution: dep?.weight || 0.3,
        relationType: dep?.relation_type || "unknown",
        breakageProbability: Math.round(
          Math.min(f.co_break_count / Math.max(stats.total_edits, 1), 1) * 100
        ) / 100,
      };
    }),
    recentSimilarChanges: similarChanges.map(c => ({
      file: c.file,
      date: new Date(c.date).toISOString().slice(0, 10),
      result: c.result,
    })),
    dependencyCount: dependencies.length,
    historicalBreakageRate: Math.round(breakageRate * 100) / 100,
    recommendation,
  };
}

function buildRiskRecommendation(
  level: string,
  breakageRate: number,
  coBroken: Array<{ affected_file: string }>
): string {
  switch (level) {
    case "low":
      return "Низкий риск. Можно править без дополнительных проверок.";
    case "medium":
      return "Умеренный риск. Рекомендуется запустить связанные тесты после изменения.";
    case "high":
      return `ВЫСОКИЙ РИСК. Изменения в ${breakageRate * 100}% случаев приводили к ошибкам. `
        + `Потенциально затронуто ${coBroken.length} файлов. Рекомендуется: `
        + "1) запустить полный тест-сьют 2) проверить связанные файлы 3) делать маленькими коммитами.";
    case "critical":
      return "КРИТИЧЕСКИЙ РИСК! История показывает множественные поломки. "
        + "Рекомендуется: 1) обсудить изменение с командой 2) написать тесты ДО изменения "
        + "3) подготовить план отката.";
    default:
      return "Невозможно определить уровень риска.";
  }
}
```

### Шаг 3.3: Профиль разработчика (src/analytics.ts, часть 3)

- [ ] Реализовать `getDeveloperProfile()`:

```typescript
async function getDeveloperProfile(timeframe = "30d"): Promise<DeveloperProfile> {
  const now = Date.now();
  const days = timeframe === "7d" ? 7 : timeframe === "30d" ? 30 : 90;
  const cutoff = now - days * 24 * 60 * 60 * 1000;

  // Сессий в день
  const sessionsPerDay = (db.prepare(`
    SELECT COUNT(*) * 1.0 / MAX(1, (${now} - COALESCE(MIN(started_at), ${now})) / 86400000.0) as val
    FROM sessions WHERE status = 'completed'
  `).get() as { val: number }).val;

  const sessionsPerDayRounded = Math.round(sessionsPerDay * 10) / 10;

  // Средняя длительность сессии
  const avgDuration = (db.prepare(`
    SELECT COALESCE(AVG(duration_ms), 0) as val
    FROM sessions WHERE status = 'completed' AND duration_ms IS NOT NULL
  `).get() as { val: number }).val;

  // Использование тулзов
  const toolUsage = db.prepare(`
    SELECT tool_name, COUNT(*) as cnt
    FROM tool_executions
    GROUP BY tool_name ORDER BY cnt DESC
  `).all() as Array<{ tool_name: string; cnt: number }>;

  const toolUsageDist: Record<string, number> = {};
  for (const t of toolUsage) {
    toolUsageDist[t.tool_name] = t.cnt;
  }

  // Топ файлов
  const topFiles = db.prepare(`
    SELECT file_path, COUNT(*) as cnt
    FROM file_edits
    GROUP BY file_path ORDER BY cnt DESC LIMIT 10
  `).all() as Array<{ file_path: string; cnt: number }>;

  // AI-Reliance ratio: правок AI / (AI + human fixes)
  const aiEdits = (db.prepare(`SELECT COUNT(*) as cnt FROM file_edits`).get() as { cnt: number }).cnt;
  const humanFixes = (db.prepare(
    `SELECT COUNT(*) as cnt FROM developer_events WHERE event_type = 'human_fix'`
  ).get() as { cnt: number }).cnt;

  const aiRelianceRatio = aiEdits > 0
    ? 1.0 - (humanFixes / (aiEdits + humanFixes))
    : 0;

  const fixRate = aiEdits > 0 ? humanFixes / aiEdits : 0;

  // Активность
  const recentActivity = {
    last7Days: getActivityForPeriod(db, now - 7 * 24 * 60 * 60 * 1000),
    last30Days: getActivityForPeriod(db, now - 30 * 24 * 60 * 60 * 1000),
    last90Days: getActivityForPeriod(db, now - 90 * 24 * 60 * 60 * 1000),
  };

  // Тренды
  const trends = computeTrends(db);

  return {
    sessionsPerDay: sessionsPerDayRounded,
    avgSessionDurationMs: Math.round(avgDuration),
    toolUsageDistribution: toolUsageDist,
    topFiles: topFiles.map(f => ({ path: f.file_path, edits: f.cnt })),
    aiRelianceRatio: Math.round(aiRelianceRatio * 100) / 100,
    fixRate: Math.round(fixRate * 100) / 100,
    trends,
    recentActivity,
  };
}

function getActivityForPeriod(db: any, cutoff: number) {
  const sessions = (db.prepare(
    `SELECT COUNT(*) as cnt FROM sessions WHERE started_at >= ?`
  ).get(cutoff) as { cnt: number }).cnt;
  const edits = (db.prepare(
    `SELECT COUNT(*) as cnt FROM file_edits WHERE recorded_at >= ?`
  ).get(cutoff) as { cnt: number }).cnt;
  const errors = (db.prepare(
    `SELECT COUNT(*) as cnt FROM session_errors WHERE recorded_at >= ?`
  ).get(cutoff) as { cnt: number }).cnt;

  return { sessions, edits, errors };
}

function computeTrends(db: any): DeveloperProfile["trends"] {
  const now = Date.now();
  const lastPeriod = now - 14 * 24 * 60 * 60 * 1000;
  const thisPeriod = now - 7 * 24 * 60 * 60 * 1000;

  const lastSessions = (db.prepare(
    `SELECT COUNT(*) as cnt FROM sessions WHERE started_at >= ? AND started_at < ?`
  ).get(lastPeriod, thisPeriod) as { cnt: number }).cnt;

  const thisSessions = (db.prepare(
    `SELECT COUNT(*) as cnt FROM sessions WHERE started_at >= ?`
  ).get(thisPeriod) as { cnt: number }).cnt;

  const sessionsTrend: DeveloperProfile["trends"]["sessionsTrend"] =
    thisSessions > lastSessions * 1.15 ? "improving"
    : thisSessions < lastSessions * 0.85 ? "declining"
    : "stable";

  return {
    sessionsTrend,
    fixRateTrend: "stable",
    productivityTrend: "stable",
  };
}
```

### Шаг 3.4: Team Pulse (src/analytics.ts, часть 4)

- [ ] Реализовать `getTeamPulse()`:

```typescript
async function getTeamPulse(timeframe = "30d"): Promise<TeamPulse> {
  const days = timeframe === "7d" ? 7 : timeframe === "30d" ? 30 : 90;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  // Общая статистика
  const totalFiles = (db.prepare(
    `SELECT COUNT(DISTINCT file_path) as cnt FROM file_edits`
  ).get() as { cnt: number }).cnt;

  const activeFiles = (db.prepare(
    `SELECT COUNT(DISTINCT file_path) as cnt FROM file_edits WHERE recorded_at >= ?`
  ).get(cutoff) as { cnt: number }).cnt;

  const hotspotCount = (db.prepare(`
    SELECT COUNT(*) as cnt FROM analytics_cache
    WHERE category = 'hotspot' AND numeric_value > 0.6
  `).get() as { cnt: number }).cnt;

  // AI-Reliance
  const aiEdits = (db.prepare(`SELECT COUNT(*) as cnt FROM file_edits WHERE recorded_at >= ?`).get(cutoff) as { cnt: number }).cnt;
  const humanFixes = (db.prepare(
    `SELECT COUNT(*) as cnt FROM developer_events WHERE event_type = 'human_fix' AND recorded_at >= ?`
  ).get(cutoff) as { cnt: number }).cnt;
  const aiReliance = aiEdits > 0 ? aiEdits / (aiEdits + humanFixes) : 0;

  // Уровень ошибок
  const totalEdits = (db.prepare(
    `SELECT COUNT(*) as cnt FROM file_edits WHERE recorded_at >= ?`
  ).get(cutoff) as { cnt: number }).cnt;
  const totalErrors = (db.prepare(
    `SELECT COUNT(*) as cnt FROM session_errors WHERE recorded_at >= ?`
  ).get(cutoff) as { cnt: number }).cnt;
  const errorRate = totalEdits > 0 ? totalErrors / totalEdits : 0;

  // Здоровье проекта (0–1)
  const healthyFiles = totalFiles - hotspotCount;
  const healthScore = totalFiles > 0 ? healthyFiles / totalFiles : 0.5;

  // Тренд
  const healthOverTime = getHealthOverTime(db);

  const trend: TeamPulse["trend"] =
    healthOverTime.length >= 2 && healthOverTime[healthOverTime.length - 1].score > healthOverTime[healthOverTime.length - 2].score
      ? "improving"
      : healthOverTime.length >= 2 && healthOverTime[healthOverTime.length - 1].score < healthOverTime[healthOverTime.length - 2].score
        ? "declining"
        : "stable";

  return {
    projectHealthScore: Math.round(healthScore * 100) / 100,
    trend,
    totalFiles,
    activeFiles,
    hotspotCount,
    aiRelianceRatio: Math.round(aiReliance * 100) / 100,
    errorRate: Math.round(errorRate * 100) / 100,
    topConcern: hotspotCount > 0
      ? `${hotspotCount} файлов имеют высокий hotspot-рейтинг (>60). Рекомендуется рефакторинг.`
      : "Проект в хорошем состоянии.",
    healthOverTime,
    moduleBreakdown: getModuleBreakdown(db, cutoff),
  };
}

function getHealthOverTime(db: any): Array<{ month: string; score: number }> {
  const rows = db.prepare(`
    SELECT
      strftime('%Y-%m', datetime(started_at / 1000, 'unixepoch')) AS month,
      COUNT(*) AS sessions,
      AVG(errors_count) AS avg_errors
    FROM sessions
    WHERE status = 'completed'
    GROUP BY month
    ORDER BY month DESC
    LIMIT 6
  `).all() as Array<{ month: string; sessions: number; avg_errors: number }>;

  return rows.reverse().map(r => ({
    month: r.month,
    score: Math.round((1 - Math.min(r.avg_errors / 5, 1)) * 100) / 100,
  }));
}

function getModuleBreakdown(db: any, cutoff: number): TeamPulse["moduleBreakdown"] {
  const rows = db.prepare(`
    SELECT
      SUBSTR(file_path, 1, INSTR(file_path, '/') - 1) AS module,
      COUNT(*) AS file_count,
      SUM(CASE WHEN se.id IS NOT NULL THEN 1 ELSE 0 END) AS error_count
    FROM file_edits fe
    LEFT JOIN session_errors se ON se.context_file = fe.file_path
    WHERE fe.recorded_at >= ?
    GROUP BY module
    ORDER BY error_count DESC
    LIMIT 10
  `).all(cutoff) as Array<{ module: string; file_count: number; error_count: number }>;

  return rows.map(r => ({
    module: r.module || "/",
    healthScore: Math.round((1 - Math.min(r.error_count / (r.file_count * 5 + 1), 1)) * 100) / 100,
    files: r.file_count,
    hotspot: r.error_count > 5 ? `${r.error_count} ошибок` : null,
  }));
}
```

### Шаг 3.5: Knowledge Graph (src/knowledge.ts)

- [ ] Реализовать `updateKnowledgeGraph()`:

```typescript
// src/knowledge.ts
import type { StorageEngine } from "./storage";

export async function updateKnowledgeGraph(storage: StorageEngine): Promise<void> {
  const db = storage.getDb();
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  // 1. Анализ co-change паттернов (файлы, меняющиеся вместе)
  const coChanges = db.prepare(`
    SELECT a.file_path as file_a, b.file_path as file_b, COUNT(*) as co_count
    FROM file_edits a
    JOIN file_edits b ON a.session_id = b.session_id AND a.file_path < b.file_path
    WHERE a.recorded_at > ?
    GROUP BY a.file_path, b.file_path
    HAVING co_count >= 3
    ORDER BY co_count DESC
    LIMIT 200
  `).all(thirtyDaysAgo) as Array<{ file_a: string; file_b: string; co_count: number }>;

  for (const cc of coChanges) {
    // Создаём/обновляем узлы
    upsertNode(db, `file:${cc.file_a}`, "file", cc.file_a, now);
    upsertNode(db, `file:${cc.file_b}`, "file", cc.file_b, now);

    // Создаём ребро
    upsertEdge(
      db,
      `file:${cc.file_a}`,
      `file:${cc.file_b}`,
      "coupled_with",
      Math.min(cc.co_count / 10, 1.0),
      "co_change",
      now
    );
  }

  // 2. Анализ причин ошибок (A → ошибки в B)
  const errorPatterns = db.prepare(`
    SELECT se.context_file as error_file, fe.file_path as edited_file,
           COUNT(*) as pattern_count
    FROM session_errors se
    JOIN file_edits fe ON se.session_id = fe.session_id
    WHERE se.context_file IS NOT NULL
      AND fe.file_path != se.context_file
      AND fe.recorded_at < se.recorded_at
      AND (se.recorded_at - fe.recorded_at) < 300000  -- 5 минут
    GROUP BY se.context_file, fe.file_path
    HAVING pattern_count >= 2
  `).all() as Array<{ error_file: string; edited_file: string; pattern_count: number }>;

  for (const ep of errorPatterns) {
    upsertNode(db, `file:${ep.edited_file}`, "file", ep.edited_file, now);
    upsertNode(db, `file:${ep.error_file}`, "file", ep.error_file, now);
    upsertEdge(
      db,
      `file:${ep.edited_file}`,
      `file:${ep.error_file}`,
      "causes_bugs_in",
      Math.min(ep.pattern_count / 5, 1.0),
      "error_pattern",
      now
    );
  }

  console.log(`[CodeShadow] Knowledge Graph обновлён: ${coChanges.length} co-change, ${errorPatterns.length} error-pattern рёбер`);
}

function upsertNode(
  db: any,
  id: string,
  type: string,
  label: string,
  now: number
): void {
  db.prepare(`
    INSERT INTO knowledge_nodes (id, type, label, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at = ?
  `).run(id, type, label, now, now, now);
}

function upsertEdge(
  db: any,
  source: string,
  target: string,
  relation: string,
  weight: number,
  evidence: string,
  now: number
): void {
  db.prepare(`
    INSERT INTO knowledge_edges (source_node_id, target_node_id, relation_type, weight, evidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_node_id, target_node_id, relation_type)
    DO UPDATE SET weight = (weight + excluded.weight) / 2.0
  `).run(source, target, relation, weight, evidence, now);
}
```

### Шаг 3.6: Верификация Analytics Engine

- [ ] После 10+ сессий с редактированием файлов — вызвать:

```bash
sqlite3 ~/.config/opencode/shadow/data.db "SELECT * FROM analytics_cache WHERE category = 'hotspot';"
sqlite3 ~/.config/opencode/shadow/data.db "SELECT COUNT(*) FROM knowledge_edges;"
```

- [ ] Через AI-тулз: попросить агента вызвать `code_shadow_analyze` с query="hotspots"

- [ ] **Критерий успеха:** Возвращается список файлов с осмысленными score. Knowledge graph содержит рёбра.

---

## Фаза 4: Proactive Alerts — Дни 13–14

**Цель:** Предупреждать разработчика ДО рискованных изменений. Показывать тосты в TUI. Реализовать команды `/shadow`.

> **ФАКТ:** `/shadow` команды используют toast-уведомления (а не модификацию текста prompt-а).
> Формат toast-а: `{ variant, title, message, duration }`, где variant ∈ `{info, warning, error, success}`.
> Команды `/shadow` регистрируются через `plugin.registerCommand()`, отображение результата — через toast.

### Шаг 4.1: Pre-edit Risk Check (обновление observer.ts)

- [ ] Заменить плейсхолдер `tool.execute.before` на реальную логику:

```typescript
// В observer.ts, заменить placeholder в tool.execute.before
ctx.hooks.on("tool.execute.before", async (event: any) => {
  try {
    const riskyTools = ["edit", "write"];
    if (!riskyTools.includes(event.toolName)) return;

    const targetFiles = extractTargetFiles(event.toolName, event.toolArgs);
    if (targetFiles.length === 0) return;

    // Используем Analytics Engine для оценки риска
    const risk = await analytics.predictRisk(targetFiles, event.toolName);

    // Если риск превышает порог — показываем тост
    if (risk.riskScore > (ctx.config?.warningThreshold || 0.6)) {
      showRiskToast(ctx, risk);

      // Логируем предупреждение
      storage.insert("risk_warnings", {
        session_id: event.sessionId,
        tool_name: event.toolName,
        target_files: JSON.stringify(targetFiles),
        risk_score: risk.riskScore,
        risk_level: risk.riskLevel,
        reasons: JSON.stringify([risk.recommendation]),
        timestamp: Date.now(),
      });
    }
  } catch (err) {
    ctx.app.log("[CodeShadow] Ошибка в tool.execute.before (risk check): " + String(err));
  }
})
```

### Шаг 4.2: TUI-тосты (src/tui.ts, часть 1)

- [ ] Реализовать функцию `showRiskToast()`:

```typescript
// src/tui.ts
import type { PluginContext } from "@opencode-ai/plugin";
import type { StorageEngine } from "./storage";
import type { AnalyticsEngine } from "./analytics";
import type { RiskPrediction } from "./types";

export function showRiskToast(ctx: PluginContext, risk: RiskPrediction): void {
  const emoji = risk.riskLevel === "critical" ? "🚫" : risk.riskLevel === "high" ? "⚠️" : "⚡";
  const riskPercent = Math.round(risk.riskScore * 100);

  ctx.tui.toast.show({
    type: risk.riskLevel === "critical" || risk.riskLevel === "high" ? "error" : "warning",
    message: `${emoji} ${risk.primaryFile}: ${risk.riskLevel} риск (${riskPercent}%)`,
    detail: `${risk.affectedFiles.length} файлов могут быть затронуты — ${risk.recommendation.substring(0, 100)}`,
    duration: 6000,
    actions: [
      { label: "Подробнее", command: `/shadow predict ${risk.primaryFile}` },
    ],
  });
}

export function createTuiIntegration(
  ctx: PluginContext,
  storage: StorageEngine,
  analytics: AnalyticsEngine
): any[] {
  return [
    {
      name: "shadow",
      subCommands: {
        hotspots: {
          description: "Показать тепловую карту проблемных файлов",
          handler: async (args: string[]) => {
            const hotspots = await analytics.computeHotspots();
            const top10 = hotspots.slice(0, 10);

            const lines = [
              "## Тепловая карта проекта (Hotspots)",
              "",
              "| Rank | File | Score | Ключевые факторы |",
              "|------|------|-------|------------------|",
              ...top10.map(h =>
                `| ${h.rank} | \`${h.filePath}\` | ${h.score} | ${h.explanation} |`
              ),
            ];

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

            const riskEmoji =
              prediction.riskLevel === "critical" ? "🔴" :
              prediction.riskLevel === "high" ? "🟠" :
              prediction.riskLevel === "medium" ? "🟡" : "🟢";

            ctx.tui.output([
              `## Прогноз для: \`${filePath}\``,
              "",
              `${riskEmoji} **Уровень риска:** ${prediction.riskLevel} (score: ${prediction.riskScore})`,
              "",
              "### Потенциально затронутые файлы:",
              ...prediction.affectedFiles.map(f =>
                `- \`${f.path}\` — вероятность: ${f.breakageProbability} (${f.relationType})`
              ),
              "",
              prediction.recentSimilarChanges.length > 0
                ? "### История похожих изменений:\n" +
                  prediction.recentSimilarChanges.map(c =>
                    `- ${c.date}: ${c.result}`
                  ).join("\n")
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
              `- Средняя длительность: **${Math.round(profile.avgSessionDurationMs / 60000)} мин**`,
              `- AI-Reliance: **${profile.aiRelianceRatio}**`,
              `- Fix rate: **${profile.fixRate}**`,
              "",
              "### Топ файлов:",
              ...profile.topFiles.slice(0, 5).map(f =>
                `- \`${f.path}\` — ${f.edits} правок`
              ),
              "",
              "### Тренды:",
              `- Сессии: ${profile.trends.sessionsTrend}`,
              `- Fix rate: ${profile.trends.fixRateTrend}`,
            ].join("\n"));
          },
        },

        health: {
          description: "Показать здоровье проекта",
          handler: async () => {
            const pulse = await analytics.getTeamPulse();

            const healthEmoji = pulse.projectHealthScore > 0.7 ? "✅" :
              pulse.projectHealthScore > 0.4 ? "⚠️" : "🔴";

            ctx.tui.output([
              `## Здоровье проекта ${healthEmoji}`,
              "",
              `**Общий рейтинг:** ${Math.round(pulse.projectHealthScore * 100)}/100`,
              `**Тренд:** ${pulse.trend}`,
              `**Файлов отслеживается:** ${pulse.totalFiles}`,
              `**Активных файлов:** ${pulse.activeFiles}`,
              `**Hotspot-файлов:** ${pulse.hotspotCount}`,
              `**Уровень ошибок:** ${pulse.errorRate}`,
              `**AI-Reliance:** ${pulse.aiRelianceRatio}`,
              "",
              `**Главная проблема:** ${pulse.topConcern}`,
            ].join("\n"));
          },
        },

        wrapped: {
          description: "Сгенерировать Developer Wrapped за месяц",
          handler: async () => {
            const profile = await analytics.getDeveloperProfile("30d");

            const aiPercent = Math.round(profile.aiRelianceRatio * 100);
            const avgMin = Math.round(profile.avgSessionDurationMs / 60000);

            ctx.tui.output([
              "## Developer Wrapped — Текущий месяц",
              "",
              `### Общая статистика`,
              `- Сессий: **${profile.recentActivity.last30Days.sessions}**`,
              `- Правок: **${profile.recentActivity.last30Days.edits}**`,
              `- Ошибок: **${profile.recentActivity.last30Days.errors}**`,
              `- Средняя сессия: **${avgMin} мин**`,
              `- AI-кода: **${aiPercent}%**`,
              "",
              `### Топ-3 файла месяца`,
              ...profile.topFiles.slice(0, 3).map((f, i) =>
                ` ${i + 1}. \`${f.path}\` — ${f.edits} правок`
              ),
              "",
              `### Тренды`,
              `- Сессии: ${profile.trends.sessionsTrend === "improving" ? "📈 растут" : "📉 падают"}`,
              `- Fix rate: ${profile.trends.fixRateTrend === "improving" ? "✅ улучшается" : "⚠️ ухудшается"}`,
              "",
              `### Инструменты месяца`,
              ...Object.entries(profile.toolUsageDistribution)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 5)
                .map(([tool, count]) => `- \`${tool}\`: ${count} вызовов`),
            ].join("\n"));
          },
        },
      },
    },
  ];
}
```

### Шаг 4.3: Верификация Proactive Alerts

- [ ] Отредактировать файл с высоким hotspot-рейтингом (исторически много ошибок)
- [ ] **Критерий успеха:** Появляется тост-предупреждение в TUI
- [ ] Выполнить `/shadow hotspots` — отображается таблица
- [ ] Выполнить `/shadow health` — отображается health score

---

## Фаза 5: Developer Wrapped — Дни 15–16

**Цель:** Генерация красивых отчётов и статистики разработчика.

### Шаг 5.1: Генератор месячного отчёта

- [ ] Добавить в `analytics.ts` метод `generateMonthlyReport()`:

```typescript
interface MonthlyReport {
  month: string;
  totalEdits: number;
  totalSessions: number;
  totalErrors: number;
  linesAdded: number;
  linesRemoved: number;
  aiGeneratedRatio: number;
  humanFixRatio: number;
  topFiles: Array<{ path: string; edits: number; errors: number }>;
  topTools: Record<string, number>;
  achievements: string[];
  trends: {
    bugsPerChange: { previous: number; current: number; direction: string; changePct: number };
    timeToFix: { previous: number; current: number; direction: string; changePct: number };
    aiReliance: { previous: number; current: number; direction: string; changePct: number };
  };
  comparisonWithPrevious: string;
}

async function generateMonthlyReport(): Promise<MonthlyReport> {
  const now = Date.now();
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const prevMonthStart = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).getTime();

  // Текущий месяц
  const currSessions = (db.prepare(
    `SELECT COUNT(*) as cnt FROM sessions WHERE started_at >= ? AND status = 'completed'`
  ).get(monthStart) as { cnt: number }).cnt;

  const currEdits = (db.prepare(
    `SELECT COUNT(*) as cnt FROM file_edits WHERE recorded_at >= ?`
  ).get(monthStart) as { cnt: number }).cnt;

  const currErrors = (db.prepare(
    `SELECT COUNT(*) as cnt FROM session_errors WHERE recorded_at >= ?`
  ).get(monthStart) as { cnt: number }).cnt;

  const currLines = (db.prepare(`
    SELECT COALESCE(SUM(lines_added), 0) as added, COALESCE(SUM(lines_removed), 0) as removed
    FROM file_edits WHERE recorded_at >= ?
  `).get(monthStart) as { added: number; removed: number });

  // Прошлый месяц
  const prevEdits = (db.prepare(
    `SELECT COUNT(*) as cnt FROM file_edits WHERE recorded_at >= ? AND recorded_at < ?`
  ).get(prevMonthStart, monthStart) as { cnt: number }).cnt;

  const prevErrors = (db.prepare(
    `SELECT COUNT(*) as cnt FROM session_errors WHERE recorded_at >= ? AND recorded_at < ?`
  ).get(prevMonthStart, monthStart) as { cnt: number }).cnt;

  // Топ файлов
  const topFiles = db.prepare(`
    SELECT fe.file_path AS path, COUNT(*) AS edits,
           COUNT(DISTINCT se.id) AS errors
    FROM file_edits fe
    LEFT JOIN session_errors se ON se.context_file = fe.file_path AND se.recorded_at >= ?
    WHERE fe.recorded_at >= ?
    GROUP BY fe.file_path
    ORDER BY edits DESC LIMIT 5
  `).all(monthStart, monthStart) as Array<{ path: string; edits: number; errors: number }>;

  // Топ тулзов
  const topTools = db.prepare(`
    SELECT tool_name, COUNT(*) as cnt
    FROM tool_executions WHERE executed_at >= ?
    GROUP BY tool_name ORDER BY cnt DESC
  `).all(monthStart) as Array<{ tool_name: string; cnt: number }>;
  const topToolsMap: Record<string, number> = {};
  for (const t of topTools) topToolsMap[t.tool_name] = t.cnt;

  // AI-Reliance
  const humanFixes = (db.prepare(
    `SELECT COUNT(*) as cnt FROM developer_events WHERE event_type = 'human_fix' AND recorded_at >= ?`
  ).get(monthStart) as { cnt: number }).cnt;
  const aiRatio = currEdits > 0 ? 1 - (humanFixes / (currEdits + humanFixes)) : 0;
  const fixRatio = currEdits > 0 ? humanFixes / currEdits : 0;

  // Тренды
  const bugsPerChangeCurr = currEdits > 0 ? currErrors / currEdits : 0;
  const bugsPerChangePrev = prevEdits > 0 ? prevErrors / prevEdits : 0;
  const bugsChangePct = bugsPerChangePrev > 0
    ? Math.round(((bugsPerChangeCurr - bugsPerChangePrev) / bugsPerChangePrev) * 100)
    : 0;

  // Ачивки
  const achievements: string[] = [];
  if (currLines.removed > currLines.added) achievements.push("🧹 Чистильщик — удалил больше кода, чем написал");
  if (currErrors === 0 && currEdits > 20) achievements.push("🔥 Огнеупорный — ни одной ошибки за месяц");
  if (currSessions > 50) achievements.push("🤖 AI-напарник — 50+ AI-сессий за месяц");
  if (fixRatio < 0.1 && currEdits > 30) achievements.push("🎯 Снайпер — AI-код почти не требует правок (<10% fix rate)");
  if (bugsChangePct < -20) achievements.push("📈 Качество растёт — багов на 20%+ меньше, чем в прошлом месяце");

  return {
    month: new Date().toLocaleString("ru", { month: "long", year: "numeric" }),
    totalEdits: currEdits,
    totalSessions: currSessions,
    totalErrors: currErrors,
    linesAdded: currLines.added,
    linesRemoved: currLines.removed,
    aiGeneratedRatio: Math.round(aiRatio * 100) / 100,
    humanFixRatio: Math.round(fixRatio * 100) / 100,
    topFiles,
    topTools: topToolsMap,
    achievements,
    trends: {
      bugsPerChange: {
        previous: Math.round(bugsPerChangePrev * 100) / 100,
        current: Math.round(bugsPerChangeCurr * 100) / 100,
        direction: bugsChangePct < 0 ? "improving" : "declining",
        changePct: bugsChangePct,
      },
      timeToFix: { previous: 0, current: 0, direction: "stable", changePct: 0 },
      aiReliance: { previous: 0, current: Math.round(aiRatio * 100) / 100, direction: "stable", changePct: 0 },
    },
    comparisonWithPrevious: prevEdits > 0
      ? `По сравнению с прошлым месяцем: правок ${currEdits > prevEdits ? "+" : ""}${currEdits - prevEdits}, ошибок ${currErrors > prevErrors ? "+" : ""}${currErrors - prevErrors}`
      : "Нет данных за прошлый месяц для сравнения.",
  };
}
```

### Шаг 5.2: Верификация Developer Wrapped

- [ ] Выполнить команду `/shadow wrapped`
- [ ] **Критерий успеха:** Красивый отчёт с ачивками, трендами, статистикой

---

## Фаза 6: Auto-Memory — Авто-детект правил

**Цель:** Автоматически детектить паттерны, конвенции и ограничения проекта без явных вызовов `code_shadow_memory_write`.

### Шаг 7.1: Правила авто-детекта (80+ правил)

Auto-Memory Engine анализирует контент файлов, пути и использование инструментов для авто-сохранения фактов о проекте. Реализовано 80+ детекторов:

| Категория | Примеры правил | Триггер |
|-----------|---------------|---------|
| **Технологии** | React, Next.js, Express, Prisma, Zod, Docker, Postgres, Redis | `package.json`, `docker-compose.yml`, `schema.prisma` |
| **Конфигурации** | ESLint, Prettier, TypeScript strict mode, Biome | `.eslintrc.*`, `.prettierrc`, `tsconfig.json`, `biome.json` |
| **Структура** | Mono-repo (workspaces), `src/` layout, `packages/*` | `package.json` workspaces, структура директорий |
| **Тестирование** | Vitest, Jest, Playwright, Cypress, Testing Library | `vitest.config.*`, `jest.config.*`, `playwright.config.*` |
| **БД** | SQLite WAL mode, PostgreSQL, Prisma migrations | `schema.prisma`, `drizzle.config.*`, `knexfile.*` |
| **Авторизация** | JWT, OAuth, NextAuth, Passport, sessions | `auth.ts`, `middleware/auth`, `next-auth` |
| **API** | REST, GraphQL, tRPC, gRPC, WebSocket | `route.ts`, `schema.graphql`, `trpc/`, `.proto` |
| **Логирование** | Pino, Winston, Bunyan, Console-based | `logger.ts`, `pino` import |
| **Валидация** | Zod, Yup, Joi, class-validator, TypeBox | `z.object`, `yup.object`, слой валидации |
| **Стили** | Tailwind, CSS Modules, Styled Components, SCSS | `tailwind.config.*`, `.module.css`, `styled-components` |
| **CI/CD** | GitHub Actions, GitLab CI, Dockerfile, Vercel | `.github/workflows/`, `.gitlab-ci.yml`, `Dockerfile` |
| **Монорепо** | npm/yarn/pnpm workspaces, Turborepo, Nx, Lerna | `pnpm-workspace.yaml`, `turbo.json`, `nx.json` |
| **Пути** | `src/lib/`, `src/utils/`, `src/services/`, модульная структура | Структура папок |
| **Соглашения** | camelCase, kebab-case, PascalCase в именах файлов | Паттерн имён файлов |
| **Базы данных** | SQLite, PostgreSQL, MySQL, MongoDB, Redis | Драйверы, ORM-конфиги |
| **Хуки Git** | Husky, lint-staged, commitlint, commitizen | `.husky/`, `.lintstagedrc`, `commitlint.config.*` |

### Шаг 7.2: Паттерн-матчинг по путям файлов

Каждое детекторное правило привязано к шаблону пути файла:

```typescript
const DETECTION_RULES: Array<{
  id: string;
  category: "PROJECT_RULES" | "ARCHITECTURE" | "CONSTRAINTS" | "CONFIG_VALUES" | "NAMING";
  pathPattern: RegExp;
  extract: (filePath: string, content?: string) => string | null;
}> = [
  {
    id: "auto:package_manager",
    category: "CONFIG_VALUES",
    pathPattern: /package\.json$/,
    extract: (_, content) => {
      if (!content) return null;
      const pkg = JSON.parse(content);
      if (pkg.packageManager) return `Менеджер пакетов: ${pkg.packageManager}`;
      if (fs.existsSync("pnpm-lock.yaml")) return "Менеджер пакетов: pnpm";
      if (fs.existsSync("yarn.lock")) return "Менеджер пакетов: yarn";
      if (fs.existsSync("bun.lockb")) return "Менеджер пакетов: bun";
      return "Менеджер пакетов: npm";
    },
  },
  {
    id: "auto:typescript_strict",
    category: "CONFIG_VALUES",
    pathPattern: /tsconfig\.json$/,
    extract: (_, content) => {
      if (!content) return null;
      try {
        const config = JSON.parse(content);
        const strict = config?.compilerOptions?.strict;
        if (strict) return "TypeScript настроен в strict mode";
        return null;
      } catch { return null; }
    },
  },
  // ... ещё 78+ правил
];
```

### Шаг 7.3: Дедупликация (Deduplication Map)

Для предотвращения повторной записи одних и тех же фактов используется Deduplication Map с TTL 5 минут:

```typescript
class AutoMemoryDeduplicator {
  private cache = new Map<string, number>(); // hash → timestamp
  private ttl = 5 * 60 * 1000; // 5 минут

  shouldSave(ruleId: string, content: string): boolean {
    this.prune();
    const key = `${ruleId}:${hashContent(content.substring(0, 200))}`;
    const last = this.cache.get(key);
    if (last && Date.now() - last < this.ttl) return false;
    this.cache.set(key, Date.now());
    return true;
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttl;
    for (const [key, ts] of this.cache) {
      if (ts < cutoff) this.cache.delete(key);
    }
  }
}
```

### Шаг 7.4: Интеграция в Observer

Auto-Memory Engine встроен в два ключевых хука Observer Engine:

1. **`file.edited`**: При редактировании файла, путь которого совпадает с `pathPattern` одного из детекторов, срабатывает правило и сохраняет факт в `knowledge_nodes` (если дедупликатор пропускает).

2. **`tool.execute.after`**: Анализирует аргументы инструментов (`write`, `edit`) для выявления технологий и паттернов из создаваемого/редактируемого контента.

```typescript
// В file.edited:
if (autoMemory.shouldScan(event.path)) {
  autoMemory.processFileEdit(event.path, event.diff);
}

// В tool.execute.after:
if (autoMemory.shouldScanTool(event.toolName)) {
  autoMemory.processToolCall(event.toolName, event.toolArgs);
}
```

### Шаг 7.5: Верификация Auto-Memory

- [ ] Создать проект с `package.json`, `tsconfig.json`, `vitest.config.ts`
- [ ] Открыть сессию OpenCode с плагином Code Shadow
- [ ] Выполнить поиск в памяти: `/shadow memory search query="пакетов"`
- [ ] **Критерий успеха:** Факты о `package.json`, `tsconfig.json` и `vitest` автоматически сохранены в `knowledge_nodes`

---

## Фаза 7: TUI Panel — Панель в сайдбаре

**Цель:** Отображать аналитику Code Shadow в боковой панели OpenCode через отдельный TUI-плагин.

### Шаг 8.1: Архитектура TUI-плагина

TUI-панель реализована как **отдельный плагин** OpenCode, подключаемый через `tui.jsonc`. Плагин рендерится в `sidebar_content` слоте с приоритетом `order: 700`.

```
code-shadow/
├── tui-plugin.tsx          # Точка входа TUI-плагина
├── components/
│   ├── StatBox.tsx         # Компонент-карточка со статистикой
│   ├── HotspotList.tsx     # Список проблемных файлов
│   ├── SessionTimeline.tsx # Таймлайн сессий
│   └── HealthGauge.tsx     # Индикатор здоровья проекта
└── hooks/
    ├── useAnalytics.ts     # Данные из SQLite
    └── useAutoRefresh.ts   # Автообновление (опрос каждые 30с)
```

### Шаг 8.2: Конфигурация tui.jsonc

```jsonc
{
  "plugins": {
    "code-shadow-tui": {
      "entry": "./tui-plugin.tsx",
      "slot": "sidebar_content",
      "order": 700,
      "label": "Code Shadow",
      "icon": "shadow"
    }
  }
}
```

### Шаг 8.3: Компонент StatBox (сетка 2×2)

```tsx
// StatBox.tsx — рендеринг @opentui/solid JSX
export function StatBox(props: {
  label: string;
  value: string | number;
  trend: "up" | "down" | "stable";
  icon: string;
}) {
  return (
    <box class="stat-box" flexDirection="column" padding={1}>
      <text color="dim">{props.icon} {props.label}</text>
      <text size="large" bold>{props.value}</text>
      <text color={trendColor(props.trend)}>
        {trendIcon(props.trend)} {props.trend === "up" ? "Растёт" : props.trend === "down" ? "Падает" : "Стабильно"}
      </text>
    </box>
  );
}
```

Сетка 2×2 отображает 4 карточки StatBox:
- **Сессии сегодня** — количество сессий за день
- **Правок AI** — количество AI-правок за 7 дней
- **Ошибок** — количество нерешённых ошибок
- **Hotspots** — количество файлов с высоким риском

### Шаг 8.4: Доступ к данным (Read-only SQLite)

TUI-плагин открывает ту же БД `data.db` в **режиме только для чтения**:

```typescript
import { Database } from "bun:sqlite";

const db = new Database(dbPath, { readonly: true });

export function useAnalytics() {
  const [data, setData] = createSignal<AnalyticsData | null>(null);

  const refresh = () => {
    const sessionsToday = db.query(
      "SELECT COUNT(*) as cnt FROM sessions WHERE started_at >= ?"
    ).get(todayStart());
    const aiEdits = db.query(
      "SELECT COUNT(*) as cnt FROM file_edits WHERE recorded_at >= ?"
    ).get(weekAgo());
    const unresolvedErrors = db.query(
      "SELECT COUNT(*) as cnt FROM session_errors WHERE resolved = 0"
    ).get();
    const hotspotCount = db.query(
      "SELECT COUNT(*) as cnt FROM analytics_cache WHERE category = 'hotspot' AND numeric_value > 0.6"
    ).get();

    setData({ sessionsToday, aiEdits, unresolvedErrors, hotspotCount });
  };

  return { data, refresh };
}
```

### Шаг 8.5: Верификация TUI Panel

- [ ] Запустить OpenCode с Code Shadow и TUI-плагином
- [ ] Проверить, что панель появляется в сайдбаре (слот `sidebar_content`)
- [ ] Проверить, что StatBox корректно отображает все 4 метрики
- [ ] Проверить автообновление (каждые 30 секунд)
- [ ] **Критерий успеха:** Панель рендерится, данные актуальны, обновление работает

---

## Фаза 10: Polish & Release — Дни 17–21

**Цель:** Стабилизация, тестирование, документация, публикация.

### Шаг 6.1: Тестирование

- [ ] Unit-тесты для `computeHotspots()`:

```typescript
// test/analytics.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
// Тесты с in-memory SQLite
```

- [ ] Интеграционные тесты для `storage.ts`: запись/чтение/обновление
- [ ] Ручное тестирование: 20+ реальных сессий с OpenCode

### Шаг 6.2: Оптимизация

- [ ] Добавить недостающие индексы:

```sql
CREATE INDEX IF NOT EXISTS idx_file_edits_session_path ON file_edits(session_id, file_path);
CREATE INDEX IF NOT EXISTS idx_tool_exec_session_tool ON tool_executions(session_id, tool_name);
CREATE INDEX IF NOT EXISTS idx_session_errors_file_resolved ON session_errors(context_file, resolved);
```

- [ ] Тюнинг кеша: `PRAGMA cache_size = -128000;` (128 MB)
- [ ] Batch size: увеличить до 20, flush interval — до 3 секунд

### Шаг 6.3: Документация

- [ ] `README.md` с инструкцией по установке
- [ ] Документация по каждому AI-тулзу в `docs/TOOLS_API.md`
- [ ] Примеры использования в `docs/EXAMPLES.md`

### Шаг 6.4: Публикация в NPM

- [ ] Проверить `package.json`: имя, версия, keywords
- [ ] Собрать: `npm run build`
- [ ] Опубликовать:

```bash
npm login
npm publish --access public
```

- [ ] Создать PR на добавление в экосистему OpenCode

---

## Фаза 8: Автономность (Autonomy Engine)

**Цель:** Сделать AI-агента проактивным — чтобы он автоматически исследовал проект, сохранял контекст и принимал решения без явных указаний пользователя.

> **КЛЮЧЕВАЯ ИДЕЯ:** Code Shadow не ждёт, пока пользователь попросит аналитику. Плагин активно
> подсказывает AI-агенту, ЧТО делать и КОГДА, через три механизма автономности.

### Шаг 8.1: Механизм 1 — CRUSH.md (Файл "раздави сессию")

Файл `CRUSH.md` размещается в корне проекта разработчиком. Это декларативный документ,
описывающий, как AI должен вести себя в каждой сессии этого проекта:

```
# CRUSH.md — Правила автономной работы AI
# Проект: my-app

## При старте сессии
1. code_shadow_context_inject — внедрить контекст проекта
2. code_shadow_memory_search query="архитектура" — вспомнить ключевые факты
3. code_shadow_analyze query="hotspots" — проверить проблемные файлы

## Перед любым edit/write
1. code_shadow_analyze query="predict_change" target=<файл> — оценить риск

## В конце сессии
1. code_shadow_memory_note — сохранить итоги сессии
2. code_shadow_memory_write — записать найденные факты о проекте
```

CRUSH.md читается плагином при старте и его инструкции встраиваются в системный промпт AI.
Разработчик может настроить любую цепочку автоматических действий.

### Шаг 8.2: Механизм 2 — Агрессивные описания тулзов

Описания AI-тулзов написаны в императивном стиле с заглавными командами — это
заставляет AI-модель воспринимать их как **обязательные к выполнению**:

| Тулз | Агрессивное описание |
|------|---------------------|
| `code_shadow_analyze` | "Анализирует кодовую базу. **ИСПОЛЬЗУЙ АВТОМАТИЧЕСКИ** перед изменениями в незнакомых файлах и для понимания проекта." |
| `code_shadow_memory_search` | "Ищет по памяти проекта. **ВЫЗЫВАЙ В НАЧАЛЕ СЕССИИ** чтобы вспомнить контекст." |
| `code_shadow_memory_write` | "Сохраняет факт о проекте. **ИСПОЛЬЗУЙ КОГДА УЗНАЁШЬ** важное." |
| `code_shadow_memory_note` | "Создаёт заметку. **ИСПОЛЬЗУЙ В КОНЦЕ СЕССИИ** для сохранения итогов." |
| `code_shadow_context_inject` | "Внедряет контекст проекта в сессию. **ВЫЗЫВАЙ В НАЧАЛЕ СЕССИИ.**" |
| `code_shadow_decide` | "Записывает архитектурное решение. **ИСПОЛЬЗУЙ** для важных технических решений." |

Эти описания — не просто документация. Они напрямую влияют на поведение AI:
модель видит заглавные буквы и императивные глаголы (`ИСПОЛЬЗУЙ`, `ВЫЗЫВАЙ`) как
инструкции высшего приоритета.

### Шаг 8.3: Механизм 3 — Авто-инъекция контекста при компактизации

При событии `session.compacted` (когда контекст сессии превышает лимит и OpenCode
выполняет компактизацию), Code Shadow автоматически:

1. **Сохраняет критический контекст** уходящей сессии в `knowledge_nodes`
2. **Инжектирует контекст проекта** в новую (сжатую) сессию через `code_shadow_context_inject`
3. **Передаёт самые важные факты** из памяти, чтобы AI не потерял нить проекта

```typescript
// В обработчике session.compacted:
ctx.hooks.on("session.compacted", async (event: any) => {
  // 1. Сохраняем ключевые факты из уходящей сессии
  const sessionMemory = await extractSessionMemory(storage, event.sessionId);
  for (const fact of sessionMemory) {
    storage.upsert("knowledge_nodes", { id: fact.id }, fact);
  }

  // 2. Инжектируем контекст в новую сессию
  const context = await analytics.getProjectContext();
  ctx.app.injectContext(context.summary);

  // 3. Сообщаем AI о произошедшем
  ctx.tui.toast.show({
    variant: "info",
    title: "Code Shadow",
    message: `Контекст проекта восстановлен. ${sessionMemory.length} фактов сохранено.`,
  });
});
```

### Шаг 8.4: Верификация автономности

- [ ] Создать `CRUSH.md` в тестовом проекте с правилами авто-действий
- [ ] Запустить сессию — AI должен автоматически вызвать `context_inject` (без явной просьбы)
- [ ] Выполнить компактизацию длинной сессии — контекст должен сохраниться
- [ ] **Критерий успеха:** AI проактивно вызывает тулзы Code Shadow при старте сессии и перед правками

---

## Фаза 9: Исправление критических багов (Bug Fixes & Stabilization)

**Цель:** Устранить баги, обнаруженные при тестировании v0.1.0, и стабилизировать плагин.

### Баг 1: `_ctx` → `ctx` — падение Observer на каждом старте

**Симптом:** Плагин крашился при загрузке из-за опечатки в имени параметра.

**Причина:** В сигнатуре обработчиков Observer Engine использовалось имя `_ctx` вместо `ctx`:

```typescript
// ❌ БЫЛО — вызывало ReferenceError при обращении к ctx.app
ctx.hooks.on("file.edited", (event: any) => {
  ctx.app.log("[CodeShadow] Ошибка...");  // ctx не определён в этой области видимости
});

// ✅ СТАЛО
ctx.hooks.on("file.edited", (event: any) => {
  ctx.app.log("[CodeShadow] ...");  // корректная ссылка на PluginContext
});
```

**Исправление:** Переименование параметра `_ctx` → `ctx` во всех 11 обработчиках Observer Engine.
Баг проявлялся на каждом запуске OpenCode, делая плагин полностью неработоспособным.

### Баг 2: SQL parameter mismatch — `getDecisions` / `getHistoricalBreakageRate`

**Симптом:** SQL-запросы в Analytics Engine падали с ошибкой параметров.

**Причина:** bun:sqlite использует **spread-параметры**, а не массив (в отличие от better-sqlite3):

```typescript
// ❌ БЫЛО — массив параметров (better-sqlite3 стиль)
db.prepare("SELECT * FROM t WHERE a = ? AND b = ?").get([valA, valB]);

// ✅ СТАЛО — spread-параметры (bun:sqlite стиль)
db.prepare("SELECT * FROM t WHERE a = ?1 AND b = ?2").get(valA, valB);
```

**Затронутые функции:**
- `getDecisions()` — запрос к таблице `decisions` с фильтрацией по статусу
- `getHistoricalBreakageRate()` — запрос к `file_edits` + `session_errors` для расчёта частоты поломок
- Все вызовы `.all()`, `.get()`, `.run()` в проекте проверены и исправлены

**Исправление:** Переход на позиционные параметры (`?1`, `?2`) и spread-синтаксис во всех SQL-запросах.
Добавлена документация по этому отличию в `DATA_MODEL.md` и `IMPLEMENTATION_PLAN.md`.

### Баг 3: TUI reactivity — статичная панель без обновления

**Симптом:** TUI-панель в сайдбаре показывала данные один раз при загрузке и не обновлялась.

**Причина:** Компонент использовал разовую загрузку данных без механизма реактивного обновления.

**Исправление:** Добавлен механизм реактивного обновления через `createSignal` + `setInterval`:

```typescript
// tui-plugin.tsx
import { createSignal } from "@opentui/solid";

function useAnalytics() {
  const [data, setData] = createSignal<AnalyticsData | null>(null);

  const refresh = () => {
    const stats = queryStats(db);
    setData(stats);
  };

  // Периодический опрос БД каждые 5 секунд
  const interval = setInterval(refresh, 5000);

  // Первичная загрузка
  refresh();

  // Очистка при размонтировании
  onCleanup(() => clearInterval(interval));

  return data;
}
```

**Результат:** Панель обновляется каждые 5 секунд, отображая актуальные метрики:
сессии сегодня, AI-правки, ошибки, hotspots. Пользователь видит изменения в реальном времени.

### Шаг 9.1: Верификация исправлений

- [ ] Запустить OpenCode — плагин загружается без ошибок (баг 1 исправлен)
- [ ] Вызвать `code_shadow_analyze query="decisions_list"` — возвращает результаты без SQL-ошибок (баг 2)
- [ ] Открыть сайдбар — панель обновляется каждые 5 секунд (баг 3)
- [ ] **Критерий успеха:** Все 3 бага устранены. Плагин работает стабильно в течение 10+ сессий подряд.

---

## Риски и их предотвращение

| Риск | Вероятность | Влияние | Предотвращение |
|------|-----------|---------|---------------|
| SQLite блокировки (SQLITE_BUSY) | Средняя | Среднее | WAL-режим, короткие транзакции, busy_timeout=5000 |
| Плагин роняет OpenCode | Средняя | Критическое | **Все** обработчики событий в try/catch. Плагин никогда не пробрасывает исключения наружу |
| Рост базы данных | Высокая | Среднее | Data retention: автоочистка записей старше 90 дней при старте и каждый час |
| Холодный старт (нет данных) | 100% | Низкое | Первые 10 сессий — плагин сообщает «недостаточно данных». Не падает, не выбрасывает ошибок |
| Изменение API OpenCode | Низкая | Высокое | Используем стабильные имена событий из документации. Фиксируем peerDependency на `@opencode-ai/plugin >= 1.0.0` |
| Утечки секретов в БД | Средняя | Высокое | `sanitizeArgs()` фильтрует ключи с token/secret/apiKey. Diff обрезается до 500 символов |
| Производительность на больших проектах | Средняя | Среднее | Кеширование аналитики, batch-запись, индексы на все поисковые колонки |

---

## Метрики успеха по фазам

| Фаза | Метрика | Как проверить |
|------|--------|--------------|
| P0 | Плагин загружается | В логах есть `[CodeShadow] Плагин загружен` |
| P1 | События сохраняются | `SELECT COUNT(*) FROM file_edits` > 0 после 5 сессий |
| P2 | Тулзы работают | AI вызывает `code_shadow_memory_write` и `code_shadow_memory_search` — возвращаются корректные результаты |
| P3 | Hotspot list осмыслен | `code_shadow_analyze(query: "hotspots")` возвращает ранжированный список с реальными файлами |
| P4 | Тосты появляются | При редактировании высоко-рискового файла показывается предупреждение |
| P5 | Wrapped генерируется | `/shadow wrapped` отображает отчёт с ачивками и трендами |
| P7 | Авто-правила создаются | Факты о package.json, tsconfig сохраняются без явного вызова memory_write |
| P8 | TUI-панель рендерится | Панель Code Shadow появляется в сайдбаре со StatBox 2×2 |
| P6 | Плагин опубликован | `npx opencode add opencode-code-shadow` работает |

---

## Приложение А: Полный index.ts

```typescript
// src/index.ts
// Точка входа плагина Code Shadow
import type { PluginContext, PluginRegistration } from "@opencode-ai/plugin";
import { createStorageEngine } from "./storage";
import { createAnalyticsEngine } from "./analytics";
import { createObserver } from "./observer";
import { createAiTools } from "./tools/index";
import { createTuiIntegration } from "./tui";
import { DEFAULT_CONFIG, type PluginConfig } from "./types";

export default async function codeShadowPlugin(
  ctx: PluginContext
): Promise<PluginRegistration> {
  ctx.app.log("[CodeShadow] Инициализация плагина...");
  ctx.app.log(`[CodeShadow] Config dir: ${ctx.configDir}`);
  ctx.app.log(`[CodeShadow] Workspace: ${ctx.workspaceRoot}`);

  // Загружаем конфигурацию (или используем значения по умолчанию)
  const config: PluginConfig = { ...DEFAULT_CONFIG };

  // 1. Инициализируем слой хранения (SQLite)
  const storage = await createStorageEngine(ctx);

  // 2. Инициализируем слой аналитики
  const analytics = createAnalyticsEngine(storage);

  // 3. Запускаем Observer Engine (подписка на события)
  const observer = createObserver(ctx, storage);

  // Регистрируем пересчёт аналитики при завершении сессии
  ctx.hooks.on("session.idle", async () => {
    try {
      await analytics.computeHotspots();
      await analytics.updateKnowledgeGraph();
    } catch (err) {
      ctx.app.log("[CodeShadow] Ошибка пересчёта аналитики: " + String(err));
    }
  });

  // 4. Создаём AI-тулзы
  const tools = createAiTools(ctx, storage, analytics);

  // 5. Создаём TUI-интеграцию (тосты, команды)
  const commands = createTuiIntegration(ctx, storage, analytics);

  // 6. Запускаем построение графа знаний (фоновая задача)
  analytics.updateKnowledgeGraph().catch(err => {
    ctx.app.log("[CodeShadow] Ошибка построения Knowledge Graph: " + String(err));
  });

  ctx.app.log("[CodeShadow] Плагин успешно инициализирован.");

  // Очистка при завершении
  process.on("beforeExit", () => {
    observer.dispose();
    storage.close();
    ctx.app.log("[CodeShadow] Плагин остановлен.");
  });

  return {
    name: "code-shadow",
    description: "Теневой наблюдатель кодовой базы — аналитика, предиктивная безопасность и коллективная память",
    version: "0.1.0",
    hooks: observer.getHooks(),
    tools,
    commands,
  };
}
```

---

## Приложение Б: Полный types.ts

См. `src/types.ts` в [Шаге 2.1](#шаг-21-типы-данных-srctypests) — там определён полный набор интерфейсов:
`PluginConfig`, `DEFAULT_CONFIG`, `HotspotEntry`, `RiskPrediction`, `DeveloperProfile`,
`TeamPulse`, `MemoryWriteInput`, `MemorySearchInput`, `MemoryNoteInput`, `ContextInjectInput`,
`DecideInput`.

---

## Приложение В: Конфигурация tsconfig.json

См. `tsconfig.json` в [Шаге 0.3](#шаг-03-создание-tsconfigjson) — полная конфигурация TypeScript.

---

> **Документ актуален на:** 2026-07-17  
> **Автор:** Команда Code Shadow  
> **Версия плана:** 2.0.0  
> **Следующее обновление:** при переходе к следующей фазе или изменении архитектуры
