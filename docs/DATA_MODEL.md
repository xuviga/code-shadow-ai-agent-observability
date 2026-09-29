# Модель данных Code Shadow

> Полная спецификация схемы базы данных плагина Code Shadow для OpenCode.
> Версия документа: 3.1.0 | Последнее обновление: 2026-09-29.
> Фактический статус исходного кода и границы проверки: [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).

---

## Оглавление

1. [Общие сведения](#1-общие-сведения)
2. [Таблица file_edits](#2-таблица-file_edits)
3. [Таблица sessions](#3-таблица-sessions)
4. [Таблица session_errors](#4-таблица-session_errors)
5. [Таблица tool_executions](#5-таблица-tool_executions)
6. [Таблица decisions — Архитектурные решения](#6-таблица-decisions--архитектурные-решения)
7. [Таблица knowledge_nodes — Узлы графа знаний](#7-таблица-knowledge_nodes--узлы-графа-знаний)
8. [Таблица knowledge_edges — Рёбра графа знаний](#8-таблица-knowledge_edges--рёбра-графа-знаний)
9. [Таблица developer_events](#9-таблица-developer_events)
10. [Таблица analytics_cache](#10-таблица-analytics_cache)
11. [Таблица schema_version](#11-таблица-schema_version)
12. [TypeScript-интерфейсы](#12-typescript-интерфейсы)
13. [Стратегия миграций](#13-стратегия-миграций)
14. [Типовые запросы](#14-типовые-запросы)
15. [Хранение данных](#15-хранение-данных)

---

## 1. Общие сведения

### 1.1 Характеристики СУБД

| Параметр               | Значение                                      |
|------------------------|-----------------------------------------------|
| **СУБД**               | SQLite 3                                      |
| **Режим работы**       | WAL (Write-Ahead Logging)                     |
| **Путь к файлу БД**    | ~/.config/opencode/shadow/data.db           |
| **Драйвер**            | bun:sqlite (встроен в Bun, не требует компиляции, ноль внешних зависимостей) |
| **Кодировка**          | UTF-8                                         |
| **Внешние ключи**      | Включены (PRAGMA foreign_keys = ON)         |
| **Таймаут блокировки** | 5000 мс (PRAGMA busy_timeout = 5000)        |
| **Размер кеша**        | 64 МБ (PRAGMA cache_size = -64000)          |
| **Synchronous**        | NORMAL (компромисс скорость/надёжность)       |

> **Примечание:** Используется `bun:sqlite` — встроенный SQLite-драйвер Bun.
> В отличие от `better-sqlite3`, не требует нативной компиляции и не добавляет
> внешних зависимостей в `node_modules`. API использует `.query()` вместо `.prepare()`.
>
> **Логирование:** Все диагностические сообщения плагина пишутся в лог-файл
> (`~/.config/opencode/shadow/shadow.log`), а не в stdout/stderr. Это
> предотвращает засорение консоли OpenCode отладочной информацией.

### 1.2 Особенности bun:sqlite

#### Параметры запросов (bun:sqlite vs better-sqlite3)

bun:sqlite использует **SPREAD-параметры**, а не массив:

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
- Именованные параметры (`:name`, `@name`, `$name`) также поддерживаются, но позиционные предпочтительнее для производительности

#### WAL-режим для конкурентного доступа

База открывается в WAL-режиме (Write-Ahead Log), что позволяет одновременную работу двух плагинов:

| Плагин | Режим доступа | Операции |
|--------|--------------|----------|
| **Серверный** (code-shadow) | **Чтение + Запись** | Сохранение событий, аналитика, запись памяти |
| **TUI** (code-shadow-tui) | **Только чтение** (`readonly: true`) | Отображение панели в сайдбаре, запрос статистики |

```
┌──────────────────────┐         ┌──────────────────────┐
│   Серверный плагин   │         │     TUI-плагин       │
│                      │         │                      │
│  ПИШЕТ события ──────┼───WAL───┼── ЧИТАЕТ статистику  │
│  ПИШЕТ аналитику     │   БД    │   ЧИТАЕТ метрики      │
│  ПИШЕТ память        │         │                      │
└──────────────────────┘         └──────────────────────┘
         NO BLOCKING ←──── WAL ────→ NO BLOCKING
```

**Ключевые преимущества:**
- Читатели никогда не блокируют писателей (и наоборот)
- TUI-панель обновляется в реальном времени без задержек
- При падении серверного плагина данные в WAL-журнале не теряются
- `busy_timeout = 5000` гарантирует, что конфликтующие транзакции дождутся друг друга

### 1.3 Условные обозначения

В этом документе используются следующие соглашения:

- **PK** — Primary Key (первичный ключ)
- **FK** — Foreign Key (внешний ключ)
- **AI** — Auto Increment (автоинкремент)
- **UQ** — Unique (уникальное ограничение)
- **NN** — Not Null (не может быть NULL)
- **IDX** — Индекс
- **DEFAULT** — Значение по умолчанию
- **CHECK** — Ограничение допустимых значений

### 1.4 Типы данных SQLite и их TypeScript-аналоги

| SQLite    | TypeScript | Примечание                                                    |
|-----------|------------|---------------------------------------------------------------|
| INTEGER | number   | Целые числа (включая Unix timestamp в миллисекундах и булевы) |
| REAL    | number   | Числа с плавающей точкой (веса рёбер, скоры)                  |
| TEXT    | string   | Строки (включая JSON-сериализованные массивы и объекты)       |
| BLOB    | Buffer   | Бинарные данные (не используется в текущей схеме)             |

> **Важно:** SQLite не имеет нативного булева типа. Булевы значения хранятся
> как INTEGER (0 или 1). В TypeScript-интерфейсах они представлены как boolean.
> При чтении из БД применяется приведение: value === 1.

### 1.5 Диаграмма связей таблиц

```
sessions (PK: id)  <----  file_edits (FK: session_id)
      |
      +------------------+-------------------+
      |                  |                   |
      v                  v                   v
session_errors     tool_executions    developer_events
(FK: session_id)   (FK: session_id)   (FK: session_id)


knowledge_nodes (PK: id)
      |
      v
knowledge_edges (FK: source_id, FK: target_id)


decisions             analytics_cache        schema_version
(нет внешних ключей)  (нет внешних ключей)   (нет внешних ключей)
```

### 1.5.1 ER-диаграмма (текстовая)

```
+------------------+       +------------------+       +-------------------+
|    sessions      |       |   file_edits     |       |  knowledge_nodes  |
|------------------|       |------------------|       |-------------------|
| id (PK, TEXT)    |<------| session_id (FK)  |       | id (PK, AI, INT)  |
| agent_type       |       | file_path        |       | node_type         |
| status           |       | agent_type       |       | name              |
| started_at       |       | edit_type        |       | path              |
| ended_at         |       | diff_preview     |       | metadata (JSON)   |
| duration_ms      |       | lines_added      |       | created_at        |
| ...              |       | lines_removed    |       | updated_at        |
+------------------+       | timestamp        |       +-------------------+
         |                 | project_root     |                |
         |                 | was_reverted     |                |
         |                 | file_language    |                v
         |                 +------------------+       +-------------------+
         |                                            |  knowledge_edges  |
         |                                            |-------------------|
         |                 +------------------+       | id (PK, AI, INT)  |
         +---------------->| session_errors   |       | source_id (FK)    |
         |                 |------------------|       | target_id (FK)    |
         |                 | id (PK, AI, INT) |       | edge_type         |
         |                 | session_id (FK)  |       | weight            |
         |                 | error_type       |       | evidence_count    |
         |                 | error_message    |       | first_seen        |
         |                 | error_stack      |       | last_seen         |
         |                 | context_file     |       +-------------------+
         |                 | context_tool     |
         |                 | timestamp        |
         |                 | resolved         |
         |                 +------------------+
         |
         |                 +------------------+       +-------------------+
         +---------------->| tool_executions  |       |   decisions       |
         |                 |------------------|       |-------------------|
         |                 | id (PK, AI, INT) |       | id (PK, AI, INT)  |
         |                 | session_id (FK)  |       | title             |
         |                 | tool_name        |       | description       |
         |                 | target_file      |       | context           |
         |                 | args_preview     |       | alternatives(JSON)|
         |                 | status           |       | status            |
         |                 | duration_ms      |       | decided_by        |
         |                 | timestamp        |       | decided_at        |
         |                 | result_size_bytes|       | superseded_by(FK) |
         |                 +------------------+       | related_files(JSON)|
         |                                            | tags (JSON)       |
         |                 +------------------+       +-------------------+
         +---------------->| developer_events |
         |                 |------------------|       +-------------------+
         |                 | id (PK, AI, INT) |       |  analytics_cache  |
         |                 | event_type       |       |-------------------|
         |                 | session_id (FK)  |       | id (PK, AI, INT)  |
         |                 | file_path        |       | cache_key (UQ)    |
         |                 | metadata (JSON)  |       | cache_data (JSON) |
         |                 | timestamp        |       | computed_at       |
         |                 +------------------+       | valid_until       |
         |                                            | computation_time_ms|
         |                                            +-------------------+
         |
         |                 +-------------------+
         +                 |  schema_version   |
                           |-------------------|
                           | version (PK, INT) |
                           | applied_at        |
                           | description       |
                           +-------------------+
```

---

## 2. Таблица file_edits

Каждое событие модификации файла, зафиксированное плагином. Это центральная
таблица наблюдения за кодовой базой: любое создание, редактирование или удаление
файла через AI-агента попадает в эту таблицу.

### 2.1 Назначение

Хранит полный контекст каждого изменения: какой файл, кем (какая сессия, какой
агент), что именно изменилось (первые 500 символов диффа), сколько строк
добавлено/удалено, и было ли это изменение впоследствии отменено в той же сессии.

### 2.2 SQL-схема

```sql
CREATE TABLE file_edits (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path       TEXT    NOT NULL,
    session_id      TEXT    NOT NULL,
    agent_type      TEXT    NOT NULL
                        CHECK (agent_type IN ('build', 'plan', 'general', 'explore')),
    edit_type       TEXT    NOT NULL
                    CHECK (edit_type IN ('create', 'update', 'delete')),
    diff_preview    TEXT,
    lines_added     INTEGER DEFAULT 0,
    lines_removed   INTEGER DEFAULT 0,
    timestamp       INTEGER NOT NULL,
    project_root    TEXT    NOT NULL,
    was_reverted    INTEGER DEFAULT 0
                    CHECK (was_reverted IN (0, 1)),
    file_language   TEXT
);

CREATE INDEX idx_file_edits_path     ON file_edits (file_path);
CREATE INDEX idx_file_edits_session  ON file_edits (session_id);
CREATE INDEX idx_file_edits_timestamp ON file_edits (timestamp);
CREATE INDEX idx_file_edits_path_ts  ON file_edits (file_path, timestamp);
```

### 2.3 Описание полей

| Поле             | Тип       | Обяз. | Описание |
|------------------|-----------|-------|----------|
| id             | INTEGER | PK AI | Уникальный идентификатор записи |
| file_path      | TEXT    | NN    | Относительный путь к файлу от корня проекта (напр. src/utils/date.ts) |
| session_id     | TEXT    | NN    | UUID сессии OpenCode, в рамках которой произошло изменение |
| agent_type     | TEXT    | NN    | Тип AI-агента: build (генерирует код), plan (планирует), general (универсальный) |
| edit_type      | TEXT    | NN    | Тип изменения: create (новый файл), update (редактирование), delete (удаление) |
| diff_preview   | TEXT    |       | Первые 500 символов диффа в унифицированном формате (unified diff) |
| lines_added    | INTEGER |       | Количество добавленных строк (по данным диффа) |
| lines_removed  | INTEGER |       | Количество удалённых строк (по данным диффа) |
| timestamp      | INTEGER | NN    | Временная метка события в миллисекундах Unix (напр. 1721234567890) |
| project_root   | TEXT    | NN    | Абсолютный путь к корню проекта на момент события |
| was_reverted   | INTEGER |       | Было ли это изменение отменено (revert) в рамках той же сессии: 0 или 1 |
| file_language  | TEXT    |       | Язык программирования, определённый по расширению (typescript, rust, python, ...) |

### 2.4 Логика определения was_reverted

Плагин анализирует последовательные изменения одного файла в рамках одной сессии.
Если изменение B полностью отменяет изменение A (возвращает файл к состоянию до A),
оба изменения помечаются was_reverted = 1. Это ключевой сигнал для метрики
«фрустрация разработчика» в движке Hotspot.

### 2.5 Определение file_language по расширению

| Расширение      | file_language |
|-----------------|---------------|
| .ts, .tsx   | typescript    |
| .js, .jsx   | javascript    |
| .rs           | rust          |
| .py           | python        |
| .go           | go            |
| .java         | java          |
| .cs           | csharp        |
| .rb           | ruby          |
| .json         | json          |
| .yaml, .yml | yaml          |
| .md           | markdown      |
| .sql          | sql           |
| .css          | css           |
| .html         | html          |
| всё остальное | unknown       |

### 2.6 Примеры записей

```sql
-- Вставка записи о редактировании файла
INSERT INTO file_edits
  (file_path, session_id, agent_type, edit_type, diff_preview,
   lines_added, lines_removed, timestamp, project_root, was_reverted, file_language)
VALUES
  ('src/services/user.ts', 'uuid-sess-001', 'build', 'update',
   '@@ -10,5 +10,8 @@ import { z } from zod; +const UserSchema = z.object({...});',
   3, 0, 1721234567890, '/home/user/projects/my-app', 0, 'typescript');

-- Вставка записи о создании нового файла
INSERT INTO file_edits
  (file_path, session_id, agent_type, edit_type, diff_preview,
   lines_added, lines_removed, timestamp, project_root, was_reverted, file_language)
VALUES
  ('README.md', 'uuid-sess-002', 'general', 'create', NULL,
   45, 0, 1721234667890, '/home/user/projects/my-app', 0, 'markdown');

-- Вставка записи об удалении файла
INSERT INTO file_edits
  (file_path, session_id, agent_type, edit_type, diff_preview,
   lines_added, lines_removed, timestamp, project_root, was_reverted, file_language)
VALUES
  ('src/legacy/deprecated.ts', 'uuid-sess-003', 'build', 'delete', NULL,
    0, 120, 1721234767890, '/home/user/projects/my-app', 0, 'typescript');
```

---

## 3. Таблица sessions

Жизненный цикл каждой сессии OpenCode. Таблица-справочник, на которую ссылаются
большинство других таблиц через внешний ключ session_id.

### 3.1 Назначение

Отслеживает каждую сессию от создания до завершения (или ошибки, или компактизации).
Накапливает агрегированные счётчики: количество изменённых файлов, использованных
инструментов, ошибок, сообщений, потраченных токенов.

### 3.2 SQL-схема

```sql
CREATE TABLE sessions (
    id                  TEXT PRIMARY KEY,
    agent_type          TEXT    NOT NULL
                    CHECK (agent_type IN ('build', 'plan', 'general', 'explore')),
    status              TEXT    NOT NULL
                        CHECK (status IN ('created', 'active', 'idle',
                                          'error', 'compacted', 'deleted')),
    started_at          INTEGER NOT NULL,
    ended_at            INTEGER,
    duration_ms         INTEGER,
    files_changed_count INTEGER DEFAULT 0,
    tools_used_count    INTEGER DEFAULT 0,
    errors_count        INTEGER DEFAULT 0,
    project_root        TEXT    NOT NULL,
    message_count       INTEGER DEFAULT 0,
    total_tokens_used   INTEGER DEFAULT 0,
    compacted_from      TEXT
);

CREATE INDEX idx_sessions_status   ON sessions (status);
CREATE INDEX idx_sessions_started  ON sessions (started_at);
CREATE INDEX idx_sessions_project  ON sessions (project_root);
```

### 3.3 Описание полей

| Поле                  | Тип       | Обяз. | Описание |
|-----------------------|-----------|-------|----------|
| id                  | TEXT    | PK    | UUID сессии, присвоенный OpenCode |
| agent_type          | TEXT    | NN    | Тип агента: build, plan или general |
| status              | TEXT    | NN    | Статус сессии (см. диаграмму состояний ниже) |
| started_at          | INTEGER | NN    | Время создания сессии (Unix timestamp, мс) |
| ended_at            | INTEGER |       | Время завершения сессии; NULL пока сессия активна |
| duration_ms         | INTEGER |       | Длительность сессии (ended_at - started_at); вычисляется при завершении |
| files_changed_count | INTEGER |       | Количество уникальных файлов, изменённых в сессии (из file_edits) |
| tools_used_count    | INTEGER |       | Количество вызовов инструментов (из tool_executions) |
| errors_count        | INTEGER |       | Количество ошибок (из session_errors) |
| project_root        | TEXT    | NN    | Абсолютный путь к корню проекта на момент старта сессии |
| message_count       | INTEGER |       | Общее количество сообщений (user + assistant) в сессии |
| total_tokens_used   | INTEGER |       | Суммарное количество токенов, потреблённых за сессию |
| compacted_from      | TEXT    |       | ID родительской сессии, если эта — результат компактизации |

### 3.4 Конечный автомат статусов

```
                    ┌─────────┐
                    │ created │  (начальное состояние)
                    └────┬────┘
                         │
                         ▼
                    ┌─────────┐
              ┌─────│ active  │─────┐
              │     └────┬────┘     │
              │          │          │
              ▼          ▼          ▼
         ┌──────┐  ┌────────┐  ┌───────────┐
         │ idle │  │ error  │  │ compacted │
         └──────┘  └────────┘  └─────┬─────┘
                                     │
                                     ▼
                                ┌───────────┐
                                │  deleted  │  (ручное удаление)
                                └───────────┘
```

### 3.5 Пример записи

```sql
INSERT INTO sessions (id, agent_type, status, started_at, ended_at,
                      duration_ms, files_changed_count, tools_used_count,
                      errors_count, project_root, message_count, total_tokens_used)
VALUES ('uuid-sess-001', 'build', 'idle', 1721234560000, 1721234860000,
        300000, 5, 12, 0, '/home/user/projects/my-app', 8, 45000);
```

---

## 4. Таблица session_errors

Каждая ошибка, произошедшая во время сессии OpenCode, с полным контекстом:
тип ошибки, сообщение, стек-трейс, над каким файлом работали и каким инструментом.

### 4.1 Назначение

Критически важная таблица для движка Hotspot и Prediction Engine. Позволяет
связать ошибки с конкретными файлами, инструментами и типами операций,
выявляя паттерны: «файл X вызывает ошибки при использовании инструмента Y».

### 4.2 SQL-схема

```sql
CREATE TABLE session_errors (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT    NOT NULL
                    REFERENCES sessions(id) ON DELETE CASCADE,
    error_type      TEXT    NOT NULL
                    CHECK (error_type IN ('tool_error', 'model_error',
                                           'permission_denied', 'unknown', 'lsp')),
    error_message   TEXT    NOT NULL,
    error_stack     TEXT,
    context_file    TEXT,
    context_tool    TEXT,
    timestamp       INTEGER NOT NULL,
    resolved        INTEGER DEFAULT 0
                    CHECK (resolved IN (0, 1))
);

CREATE INDEX idx_errors_session ON session_errors (session_id);
CREATE INDEX idx_errors_file    ON session_errors (context_file);
CREATE INDEX idx_errors_type    ON session_errors (error_type);
```

### 4.3 Описание полей

| Поле            | Тип       | Обяз. | Описание |
|-----------------|-----------|-------|----------|
| id            | INTEGER | PK AI | Уникальный идентификатор ошибки |
| session_id    | TEXT    | NN FK | Сессия, в которой произошла ошибка |
| error_type    | TEXT    | NN    | Тип ошибки: tool_error, model_error, permission_denied, unknown |
| error_message | TEXT    | NN    | Текст сообщения об ошибке |
| error_stack   | TEXT    |       | Полный стек-трейс ошибки (если доступен) |
| context_file  | TEXT    |       | Путь к файлу, с которым работал агент в момент ошибки |
| context_tool  | TEXT    |       | Имя инструмента, выполнение которого привело к ошибке |
| timestamp     | INTEGER | NN    | Временная метка ошибки (Unix timestamp, мс) |
| resolved      | INTEGER |       | Была ли ошибка устранена в той же сессии: 0 = нет, 1 = да |

### 4.4 Классификация типов ошибок

| error_type        | Описание | Пример |
|---------------------|----------|--------|
| tool_error        | Ошибка при выполнении инструмента | Command failed: npm test (ненулевой код) |
| model_error       | Ошибка AI-модели | Rate limit exceeded от API провайдера |
| permission_denied | Отказ в доступе | Попытка редактирования файла вне workspace |
| unknown           | Неизвестный тип ошибки | Необработанное исключение в коде плагина |

### 4.5 Логика определения resolved

После завершения сессии плагин анализирует все её ошибки. Если после ошибки
для того же файла (context_file) было зафиксировано успешное изменение
в file_edits (тот же session_id и file_path), ошибка помечается как resolved = 1.

---

## 5. Таблица tool_executions

Каждый вызов инструмента AI-агентом: что было вызвано, с какими аргументами,
над каким файлом, с каким результатом и сколько времени заняло.

### 5.1 Назначение

Полный аудит использования инструментов. Позволяет анализировать:
- Какие инструменты используются чаще всего
- Какие файлы требуют наибольшего инструментального вмешательства
- Процент успешных/неудачных вызовов по каждому инструменту
- Среднюю длительность выполнения по типам инструментов

### 5.2 SQL-схема

```sql
CREATE TABLE tool_executions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id        TEXT    NOT NULL
                      REFERENCES sessions(id) ON DELETE CASCADE,
    tool_name         TEXT    NOT NULL,
    target_file       TEXT,
    args_preview      TEXT,
    status            TEXT    NOT NULL
                      CHECK (status IN ('success', 'error', 'timeout', 'denied')),
    duration_ms       INTEGER,
    timestamp         INTEGER NOT NULL,
    result_size_bytes INTEGER
);

CREATE INDEX idx_tool_session ON tool_executions (session_id);
CREATE INDEX idx_tool_name    ON tool_executions (tool_name);
CREATE INDEX idx_tool_file    ON tool_executions (target_file);
CREATE INDEX idx_tool_ts      ON tool_executions (timestamp);
```

### 5.3 Описание полей

| Поле                | Тип       | Обяз. | Описание |
|---------------------|-----------|-------|----------|
| id                | INTEGER | PK AI | Уникальный идентификатор записи |
| session_id        | TEXT    | NN FK | Сессия, в которой был вызван инструмент |
| tool_name         | TEXT    | NN    | Имя инструмента: bash, edit, write, grep, glob, read, task, ... |
| target_file       | TEXT    |       | Путь к целевому файлу; NULL для инструментов без файла |
| args_preview      | TEXT    |       | Первые 200 символов аргументов (чувствительные данные заменены) |
| status            | TEXT    | NN    | Статус выполнения: success, error, timeout, denied |
| duration_ms       | INTEGER |       | Время выполнения инструмента в миллисекундах |
| timestamp         | INTEGER | NN    | Временная метка вызова (Unix timestamp, мс) |
| result_size_bytes | INTEGER |       | Размер результата в байтах; NULL если статус не success |

### 5.4 Классификация статусов

| status    | Описание |
|-----------|----------|
| success   | Инструмент выполнился успешно, вернул результат |
| error     | Инструмент завершился с ошибкой (ненулевой код, исключение) |
| timeout   | Инструмент превысил лимит времени и был прерван |
| denied    | Выполнение запрещено политикой безопасности |

### 5.5 Стандартные инструменты и их аргументы

| tool_name | Назначение | target_file заполняется? |
|-------------|-----------|---------------------------|
| bash      | Выполнение shell-команды | Нет |
| edit      | Редактирование существующего файла | Да |
| write     | Создание/перезапись файла | Да |
| grep      | Поиск по содержимому файлов | Нет |
| glob      | Поиск файлов по маске | Нет |
| read      | Чтение содержимого файла | Да |
| task      | Делегирование подзадачи агенту | Нет |
| webfetch  | Загрузка веб-содержимого | Нет |
| question  | Диалог с пользователем | Нет |

---

## 6. Таблица decisions — Архитектурные решения

Архитектурные решения (ADR — Architecture Decision Records). Могут быть
зафиксированы как автоматически (AI-агентом), так и вручную разработчиком.

### 6.1 Назначение

Хранит формализованные записи о ключевых архитектурных решениях с контекстом:
почему решение было принято, какие альтернативы рассматривались, какие файлы
затрагивает, и актуально ли оно сейчас.

### 6.2 SQL-схема

```sql
CREATE TABLE decisions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    title           TEXT    NOT NULL,
    description     TEXT    NOT NULL,
    context         TEXT,
    alternatives    TEXT,
    status          TEXT    NOT NULL
                    CHECK (status IN ('proposed', 'accepted',
                                      'deprecated', 'superseded')),
    decided_by      TEXT,
    decided_at      INTEGER NOT NULL,
    superseded_by   INTEGER REFERENCES decisions(id),
    related_files   TEXT,
    tags            TEXT
);

CREATE INDEX idx_decisions_status ON decisions (status);
CREATE INDEX idx_decisions_tags   ON decisions (tags);
```

### 6.3 Описание полей

| Поле            | Тип       | Обяз. | Описание |
|-----------------|-----------|-------|----------|
| id            | INTEGER | PK AI | Уникальный идентификатор решения |
| title         | TEXT    | NN    | Краткий заголовок (напр. «Использовать Zod вместо Yup для валидации») |
| description   | TEXT    | NN    | Подробное описание решения и его обоснование |
| context       | TEXT    |       | Обстоятельства, которые привели к необходимости решения |
| alternatives  | TEXT    |       | JSON-массив строк с рассмотренными альтернативами |
| status        | TEXT    | NN    | Статус: proposed, accepted, deprecated, superseded |
| decided_by    | TEXT    |       | Кто принял решение: ID сессии или 'manual' |
| decided_at    | INTEGER | NN    | Временная метка принятия решения (Unix timestamp, мс) |
| superseded_by | INTEGER |       | Ссылка на decisions.id — решение, заменившее текущее |
| related_files | TEXT    |       | JSON-массив путей к файлам, которых касается решение |
| tags          | TEXT    |       | JSON-массив тегов: ["architecture", "validation", "typescript"] |

### 6.4 Конечный автомат статусов

```
                    ┌──────────┐
                    │ proposed │  (предложено, ожидает утверждения)
                    └────┬─────┘
                         │
                         ▼
                    ┌──────────┐
                    │ accepted │  (принято, действует)
                    └────┬─────┘
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
         ┌────────────┐       ┌────────────┐
         │ deprecated │       │ superseded │───→ ссылка на новое решение
         └────────────┘       └────────────┘
```

### 6.5 Пример записи

```sql
INSERT INTO decisions (title, description, context, alternatives, status,
                       decided_by, decided_at, superseded_by, related_files, tags)
VALUES (
  'Использовать Zod для валидации',
  'Заменить ручную валидацию в сервисах на схемы Zod.',
  'Обнаружено 4 разных подхода к валидации: ручная, Joi, Yup, class-validator.',
  '["Joi", "Yup", "class-validator"]',
  'accepted',
  'uuid-sess-042',
  1721300000000,
  NULL,
  '["src/services/user.ts", "src/services/order.ts", "src/middleware/validate.ts"]',
  '["architecture", "validation", "typescript", "refactoring"]'
);
```

---

## 7. Таблица knowledge_nodes — Узлы графа знаний

Узлы семантического графа знаний кодовой базы. Каждый узел представляет
некоторую сущность: файл, модуль, концепцию, паттерн, правило или API-эндпоинт.

### 7.1 Назначение

Формирует основу Knowledge Graph — семантической карты проекта. Узлы создаются
автоматически (при обнаружении новых файлов, модулей) и могут дополняться
AI-агентом (концепции, паттерны, правила).

### 7.2 SQL-схема

```sql
CREATE TABLE knowledge_nodes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    node_type       TEXT    NOT NULL
                     CHECK (node_type IN ('file', 'module', 'concept',
                                          'component', 'api', 'pattern',
                                          'rule', 'api_endpoint', 'note', 'decision')),
    name            TEXT    NOT NULL,
    path            TEXT,
    metadata        TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE INDEX idx_kn_type ON knowledge_nodes (node_type);
CREATE INDEX idx_kn_path ON knowledge_nodes (path);
CREATE INDEX idx_kn_name ON knowledge_nodes (name);
```

### 7.3 Описание полей

| Поле         | Тип       | Обяз. | Описание |
|--------------|-----------|-------|----------|
| id         | INTEGER | PK AI | Уникальный идентификатор узла |
| node_type  | TEXT    | NN    | Тип сущности: file, module, concept, pattern, rule, api_endpoint |
| name       | TEXT    | NN    | Человекочитаемое имя (напр. «UserService», «Auth Middleware») |
| path       | TEXT    |       | Путь к файлу, если узел представляет файл (node_type = 'file') |
| metadata   | TEXT    |       | JSON-объект: язык, LOC, сложность, покрытие тестами, git-данные |
| created_at | INTEGER | NN    | Временная метка создания узла (Unix timestamp, мс) |
| updated_at | INTEGER | NN    | Временная метка последнего обновления (Unix timestamp, мс) |

### 7.4 Типы узлов

| node_type     | Описание | Пример name |
|-----------------|----------|---------------|
| file          | Конкретный файл в проекте | src/services/user.ts |
| module        | Логический модуль | Authentication Module |
| concept       | Концепция или абстракция | Dependency Injection |
| pattern       | Паттерн проектирования | Repository Pattern |
| rule          | Бизнес-правило или инвариант | Password must be > 8 chars |
| api_endpoint  | API-эндпоинт | POST /api/users |

### 7.5 Структура поля metadata (JSON)

```json
{
  "language": "typescript",
  "lines_of_code": 247,
  "complexity": {
    "cyclomatic": 12,
    "cognitive": 18
  },
  "last_modified": 1721234567890,
  "last_modified_by_session": "uuid-session-123",
  "git": {
    "last_commit_hash": "a3f2b1c",
    "last_commit_author": "developer",
    "first_seen_commit": "01a2b3c"
  },
  "exports": ["UserService", "CreateUserDTO"],
  "imports": ["AuthService", "Database"],
  "test_coverage": 0.76,
  "dependencies": ["express", "zod", "pg"]
}
```

---

## 8. Таблица knowledge_edges — Рёбра графа знаний

Направленные связи между узлами графа знаний. Каждое ребро описывает
отношение между двумя сущностями с указанием типа связи, силы (веса)
и количества подтверждений этого отношения.

### 8.1 Назначение

Формирует топологию Knowledge Graph. Рёбра строятся на основе:
- Статического анализа (import/export)
- Истории совместных изменений (co-change)
- Ручного указания AI-агентом или разработчиком

### 8.2 SQL-схема

```sql
CREATE TABLE knowledge_edges (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id       INTEGER NOT NULL
                    REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
    target_id       INTEGER NOT NULL
                    REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
    edge_type       TEXT    NOT NULL
                     CHECK (edge_type IN (
                         'imports', 'exports', 'contains',
                         'depends_on', 'causes_bugs_in', 'refactored_to',
                         'similar_to', 'tested_by', 'implements', 'extends',
                         'coupled_with', 'references'
                     )),
    weight          REAL    DEFAULT 1.0,
    evidence_count  INTEGER DEFAULT 1,
    first_seen      INTEGER NOT NULL,
    last_seen       INTEGER NOT NULL,
    UNIQUE (source_id, target_id, edge_type)
);

CREATE INDEX idx_ke_source ON knowledge_edges (source_id);
CREATE INDEX idx_ke_target ON knowledge_edges (target_id);
CREATE INDEX idx_ke_type   ON knowledge_edges (edge_type);
CREATE INDEX idx_ke_both   ON knowledge_edges (source_id, target_id);
```

### 8.3 Описание полей

| Поле             | Тип       | Обяз. | Описание |
|------------------|-----------|-------|----------|
| id             | INTEGER | PK AI | Уникальный идентификатор ребра |
| source_id      | INTEGER | NN FK | ID узла-источника (откуда идёт связь) |
| target_id      | INTEGER | NN FK | ID узла-цели (куда направлена связь) |
| edge_type      | TEXT    | NN    | Тип отношения (см. классификацию ниже) |
| weight         | REAL    |       | Сила связи: 0.0 (слабая) — 1.0 (очень сильная) |
| evidence_count | INTEGER |       | Количество подтверждений этой связи |
| first_seen     | INTEGER | NN    | Когда связь впервые зафиксирована (Unix timestamp, мс) |
| last_seen      | INTEGER | NN    | Когда связь подтверждена последний раз (Unix timestamp, мс) |

### 8.4 Типы рёбер

| edge_type       | Направление | Описание | Источник данных |
|-------------------|-------------|----------|-----------------|
| imports         | A → B       | A импортирует B | Статический анализ |
| exports         | A → B       | A экспортирует символ B | Статический анализ |
| contains        | A → B       | A содержит B | Файловая система |
| depends_on      | A → B       | A зависит от B (логическая связь) | Co-change анализ |
| causes_bugs_in  | A → B       | Изменения в A вызывают баги в B | session_errors |
| refactored_to   | A → B       | A отрефакторен в B | AI/ручной ввод |
| similar_to      | A ↔ B       | A и B семантически похожи | Векторный анализ |
| tested_by       | A → B       | A тестируется файлом B | Статический анализ |
| implements      | A → B       | A реализует интерфейс B | Статический анализ |
| extends         | A → B       | A расширяет класс B | Статический анализ |

### 8.5 Логика вычисления weight

Вес ребра вычисляется на основе частоты совместных изменений и нормализуется
в диапазон [0.0, 1.0]:

```
weight = min(1.0, evidence_count / CO_CHANGE_THRESHOLD)

где CO_CHANGE_THRESHOLD = 10 (настраивается в config.json)
```

Для рёбер типа imports, contains, exports вес фиксирован: **1.0**.
Для causes_bugs_in вес пропорционален количеству подтверждённых багов.

---

## 9. Таблица developer_events

События, относящиеся непосредственно к разработчику (а не к AI-агенту):
запуск сессий, ручные правки, откаты изменений, использование команд.

### 9.1 Назначение

Формирует «профиль разработчика» — метрики продуктивности, паттерны поведения,
частота использования конкретных команд и инструментов.

### 9.2 SQL-схема

```sql
CREATE TABLE developer_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type      TEXT    NOT NULL
                     CHECK (event_type IN ('session_started', 'manual_edit',
                                           'revert', 'command_used', 'human_fix',
                                           'session_start', 'session_end',
                                           'file_focus', 'tool_rejected',
                                           'session_completed', 'todo_completed',
                                           'lsp_diagnostic', 'lsp_diagnostic_summary')),
    session_id      TEXT,
    file_path       TEXT,
    metadata        TEXT,
    timestamp       INTEGER NOT NULL
);

CREATE INDEX idx_dev_type ON developer_events (event_type);
CREATE INDEX idx_dev_ts   ON developer_events (timestamp);
```

### 9.3 Описание полей

| Поле         | Тип       | Обяз. | Описание |
|--------------|-----------|-------|----------|
| id         | INTEGER | PK AI | Уникальный идентификатор события |
| event_type | TEXT    | NN    | Тип события: session_started, manual_edit, revert, command_used |
| session_id | TEXT    |       | Сессия, в контексте которой произошло событие (может быть NULL) |
| file_path  | TEXT    |       | Файл, связанный с событием (для manual_edit, revert) |
| metadata   | TEXT    |       | JSON-объект с дополнительным контекстом |
| timestamp  | INTEGER | NN    | Временная метка события (Unix timestamp, мс) |

### 9.4 Типы событий и структура metadata

**session_started:**
```json
{
  "project_root": "/home/user/projects/my-app",
  "agent_type": "build",
  "trigger": "user_command"
}
```

**manual_edit:**
```json
{
  "editor": "vscode",
  "lines_changed": 15,
  "file_language": "typescript"
}
```

**revert:**
```json
{
  "original_edit_id": 142,
  "reason": "test_failure",
  "time_since_edit_ms": 45000
}
```

**command_used:**
```json
{
  "command": "shadow hotspots",
  "full_input": "/shadow hotspots --limit 10"
}
```

---

## 10. Таблица analytics_cache

Предварительно вычисленные (pre-computed) результаты аналитики для быстрых
запросов. Предотвращает повторные тяжёлые вычисления при каждом обращении
к аналитическим инструментам.

### 10.1 Назначение

Кеширует результаты ресурсоёмких аналитических запросов:
- Тепловые карты (hotspots) за разные периоды
- Профили разработчика
- Матрицы совместных изменений
- Прогнозы рисков для файлов

Каждая запись имеет срок действия (valid_until), после которого требует пересчёта.

### 10.2 SQL-схема

```sql
CREATE TABLE analytics_cache (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    cache_key           TEXT    NOT NULL UNIQUE,
    cache_data          TEXT    NOT NULL,
    computed_at         INTEGER NOT NULL,
    valid_until         INTEGER,
    computation_time_ms INTEGER
);

CREATE INDEX idx_cache_key ON analytics_cache (cache_key);
```

### 10.3 Описание полей

| Поле                  | Тип       | Обяз. | Описание |
|-----------------------|-----------|-------|----------|
| id                  | INTEGER | PK AI | Уникальный идентификатор записи |
| cache_key           | TEXT    | NN UQ | Уникальный ключ: "hotspots:last_30_days", "dev_profile:current_month" |
| cache_data          | TEXT    | NN    | JSON-строка с закешированными данными |
| computed_at         | INTEGER | NN    | Временная метка вычисления (Unix timestamp, мс) |
| valid_until         | INTEGER |       | Срок действия; NULL = бессрочно |
| computation_time_ms | INTEGER |       | Сколько времени заняло вычисление (для мониторинга) |

### 10.4 Стандартные ключи кеша и TTL

| cache_key                     | Содержимое | TTL |
|---------------------------------|------------|-----|
| hotspots:last_7_days          | Тепловая карта за 7 дней | 1 час |
| hotspots:last_30_days         | Тепловая карта за 30 дней | 6 часов |
| hotspots:last_90_days         | Тепловая карта за 90 дней | 24 часа |
| hotspots:all_time             | Тепловая карта за всё время | 24 часа |
| dev_profile:current_month     | Профиль разработчика за месяц | 1 час |
| dev_profile:last_month        | Профиль за прошлый месяц | 24 часа |
| dev_wrapped:current_year      | Developer Wrapped за год | 24 часа |
| risk:file:<path>              | Оценка риска для файла | 30 минут |
| co_change_matrix              | Матрица совместных изменений | 6 часов |
| knowledge_graph:export        | Экспорт графа знаний | 1 час |
| error_rate:weekly             | Частота ошибок по файлам | 1 час |
| tool_usage:weekly             | Статистика инструментов | 6 часов |

---

## 11. Таблица schema_version

Служебная таблица для отслеживания применённых миграций схемы базы данных.

### 11.1 SQL-схема

```sql
CREATE TABLE schema_version (
    version     INTEGER PRIMARY KEY,
    applied_at  INTEGER NOT NULL,
    description TEXT
);
```

### 11.2 Описание полей

| Поле          | Тип       | Обяз. | Описание |
|---------------|-----------|-------|----------|
| version     | INTEGER | PK    | Номер версии схемы (1, 2, 3, ...) |
| applied_at  | INTEGER | NN    | Временная метка применения миграции (Unix timestamp, мс) |
| description | TEXT    |       | Описание миграции (имя файла: 001_initial.ts) |

### 11.3 Пример содержимого

| version | applied_at      | description                        |
|---------|-----------------|------------------------------------|
| 1       | 1720000000000   | 001_initial.ts                     |
| 2       | 1720500000000   | 002_fix_event_types.ts             |

---

## 12. TypeScript-интерфейсы

> В текущей схеме также есть таблица `todos`, добавленная миграцией 005. Она
> содержит `todo_id`, `session_id`, `title`, `status`, `created_at`, `updated_at`
> и связывается с `sessions(id)` внешним ключом. Статус ограничен значениями
> `pending`, `in_progress`, `completed`, `cancelled`.

Полные TypeScript-интерфейсы для каждой таблицы. Имена полей приведены
в camelCase, как принято в TypeScript-коде. При чтении из базы данных
применяется маппинг snake_case -> camelCase.

### 12.1 FileEdit

```typescript
interface FileEdit {
  id: number
  filePath: string
  sessionId: string
  agentType: 'build' | 'plan' | 'general'
  editType: 'create' | 'update' | 'delete'
  diffPreview: string | null
  linesAdded: number
  linesRemoved: number
  timestamp: number
  projectRoot: string
  wasReverted: boolean
  fileLanguage: string | null
}
```

### 12.2 Session

```typescript
interface Session {
  id: string
  agentType: 'build' | 'plan' | 'general'
  status: 'created' | 'active' | 'idle' | 'error' | 'compacted' | 'deleted'
  startedAt: number
  endedAt: number | null
  durationMs: number | null
  filesChangedCount: number
  toolsUsedCount: number
  errorsCount: number
  projectRoot: string
  messageCount: number
  totalTokensUsed: number
  compactedFrom: string | null
}
```

### 12.3 SessionError

```typescript
interface SessionError {
  id: number
  sessionId: string
  errorType: 'tool_error' | 'model_error' | 'permission_denied' | 'unknown'
  errorMessage: string
  errorStack: string | null
  contextFile: string | null
  contextTool: string | null
  timestamp: number
  resolved: boolean
}
```

### 12.4 ToolExecution

```typescript
interface ToolExecution {
  id: number
  sessionId: string
  toolName: string
  targetFile: string | null
  argsPreview: string | null
  status: 'success' | 'error' | 'timeout' | 'denied'
  durationMs: number | null
  timestamp: number
  resultSizeBytes: number | null
}
```

### 12.5 Decision

```typescript
interface Decision {
  id: number
  title: string
  description: string
  context: string | null
  alternatives: string[] | null
  status: 'proposed' | 'accepted' | 'deprecated' | 'superseded'
  decidedBy: string | null
  decidedAt: number
  supersededBy: number | null
  relatedFiles: string[] | null
  tags: string[] | null
}
```

### 12.6 KnowledgeNode

```typescript
interface KnowledgeNode {
  id: number
  nodeType: 'file' | 'module' | 'concept' | 'pattern' | 'rule' | 'api_endpoint'
  name: string
  path: string | null
  metadata: KnowledgeNodeMetadata | null
  createdAt: number
  updatedAt: number
}

interface KnowledgeNodeMetadata {
  language?: string
  lines_of_code?: number
  complexity?: { cyclomatic: number; cognitive: number }
  last_modified?: number
  last_modified_by_session?: string
  git?: {
    last_commit_hash: string
    last_commit_author: string
    first_seen_commit: string
  }
  exports?: string[]
  imports?: string[]
  test_coverage?: number
  dependencies?: string[]
}
```

### 12.7 KnowledgeEdge

```typescript
interface KnowledgeEdge {
  id: number
  sourceId: number
  targetId: number
  edgeType: 'imports' | 'exports' | 'contains' | 'depends_on'
    | 'causes_bugs_in' | 'refactored_to' | 'similar_to'
    | 'tested_by' | 'implements' | 'extends'
  weight: number
  evidenceCount: number
  firstSeen: number
  lastSeen: number
}
```

### 12.8 DeveloperEvent

```typescript
interface DeveloperEvent {
  id: number
  eventType: 'session_started' | 'manual_edit' | 'revert' | 'command_used'
  sessionId: string | null
  filePath: string | null
  metadata: Record<string, unknown> | null
  timestamp: number
}
```

### 12.9 AnalyticsCache

```typescript
interface AnalyticsCache {
  id: number
  cacheKey: string
  cacheData: unknown
  computedAt: number
  validUntil: number | null
  computationTimeMs: number | null
}
```

### 12.10 SchemaVersion

```typescript
interface SchemaVersion {
  version: number
  appliedAt: number
  description: string | null
}
```

### 12.11 Функции маппинга snake_case <-> camelCase

```typescript
function toCamelCase(snakeStr: string): string {
  return snakeStr.replace(/_([a-z])/g, (_, char) => char.toUpperCase())
}

function toSnakeCase(camelStr: string): string {
  return camelStr.replace(/[A-Z]/g, (char) => '_' + char.toLowerCase())
}

function mapRowToInterface<T>(row: Record<string, unknown>): T {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    const camelKey = toCamelCase(key)
    result[camelKey] = value
  }
  return result as T
}
```

---

## 13. Стратегия миграций

### 13.1 Структура директории миграций

```
src/storage/migrations/
├── runner.ts                    # Раннер миграций (класс MigrationRunner)
├── 001_initial.ts               # Начальная схема (все таблицы)
├── 002_add_analytics_cache.ts   # Добавление analytics_cache
├── 003_add_decisions.ts         # Добавление таблицы decisions
└── 004_add_knowledge_graph.ts   # Добавление knowledge_nodes и knowledge_edges
```

### 13.2 Формат файла миграции

Каждая миграция — TypeScript-файл, экспортирующий функцию с сигнатурой
(db: Database) => void. Имя файла: NNN_description.ts, где NNN —
порядковый номер (001, 002, ...).

```typescript
// src/storage/migrations/001_initial.ts
import type { Database } from 'bun:sqlite'

export default function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version     INTEGER PRIMARY KEY,
      applied_at  INTEGER NOT NULL,
      description TEXT
    );
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id                  TEXT PRIMARY KEY,
      agent_type          TEXT NOT NULL CHECK (agent_type IN ('build', 'plan', 'general')),
      status              TEXT NOT NULL CHECK (status IN ('created', 'active', 'idle',
                                                          'error', 'compacted', 'deleted')),
      started_at          INTEGER NOT NULL,
      ended_at            INTEGER,
      duration_ms         INTEGER,
      files_changed_count INTEGER DEFAULT 0,
      tools_used_count    INTEGER DEFAULT 0,
      errors_count        INTEGER DEFAULT 0,
      project_root        TEXT NOT NULL,
      message_count       INTEGER DEFAULT 0,
      total_tokens_used   INTEGER DEFAULT 0,
      compacted_from      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status);
    CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions (started_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions (project_root);
  `)

  // ... остальные CREATE TABLE для file_edits, session_errors, tool_executions
}
```

### 13.3 Раннер миграций

```typescript
// src/storage/migrations/runner.ts
import type { Database } from 'bun:sqlite'
import path from 'node:path'
import fs from 'node:fs'

interface MigrationModule {
  default: (db: Database.Database) => void
}

export class MigrationRunner {
  constructor(private db: Database.Database) {}

  applyPending(migrationsDir: string): void {
    const currentVersion = this.getCurrentVersion()

    const files = fs.readdirSync(migrationsDir)
      .filter(f => /^\d{3}_.+\.(ts|js)$/.test(f))
      .sort()

    for (const file of files) {
      const version = parseInt(file.substring(0, 3), 10)
      if (version <= currentVersion) continue

      const modulePath = path.join(migrationsDir, file)
      const migration = require(modulePath) as MigrationModule

      const migrate = this.db.transaction(() => {
        migration.default(this.db)
        this.db.prepare(
          'INSERT INTO schema_version (version, applied_at, description) VALUES (?, ?, ?)'
        ).run(version, Date.now(), file)
      })

      try {
        migrate()
        console.log('[CodeShadow] Миграция ' + version + ' применена: ' + file)
      } catch (err) {
        console.error('[CodeShadow] Ошибка миграции ' + version + ':', err)
        throw err
      }
    }
  }

  private getCurrentVersion(): number {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version     INTEGER PRIMARY KEY,
        applied_at  INTEGER NOT NULL,
        description TEXT
      );
    `)
    const row = this.db.prepare(
      'SELECT MAX(version) as version FROM schema_version'
    ).get() as { version: number | null }
    return row.version || 0
  }
}
```

### 13.4 Принципы миграций

1. **Идемпотентность:** каждая миграция использует CREATE TABLE IF NOT EXISTS
   и CREATE INDEX IF NOT EXISTS для безопасного повторного запуска.

2. **Транзакционность:** каждая миграция выполняется внутри SQLite-транзакции
   (this.db.transaction()). При ошибке все изменения откатываются.

3. **Try/catch на каждую миграцию:** ошибка в одной миграции пробрасывается
   наружу, предотвращая применение последующих миграций с некорректной базой.

4. **Необратимость:** миграции только вперёд. Откат (down-миграция)
   не поддерживается для простоты.

5. **Регистрация:** после успешного применения миграции в schema_version
   записывается номер версии и имя файла.

### 13.5 Пример будущей миграции

```typescript
// src/storage/migrations/005_add_risk_predictions.ts
import type { Database } from 'bun:sqlite'

export default function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS risk_predictions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      file_path       TEXT NOT NULL,
      risk_score      REAL NOT NULL,
      risk_level      TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
      factors         TEXT NOT NULL,
      recommendation  TEXT,
      predicted_at    INTEGER NOT NULL,
      actual_outcome  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_risk_pred_file ON risk_predictions (file_path);
    CREATE INDEX IF NOT EXISTS idx_risk_pred_time ON risk_predictions (predicted_at);
  `)
}
```

### 13.6 Миграция 002: fix_event_types (реализована)

**Файл:** `src/migrations/002_fix_event_types.ts`  
**Причина:** CHECK constraint на `developer_events.event_type` не включал типы событий,
используемые Observer-ом (`session_completed`, `todo_completed`, `lsp_diagnostic`,
`lsp_diagnostic_summary`). При попытке вставки этих событий возникала ошибка
CHECK constraint failed. Миграция расширяет CHECK-констрейнт, добавляя недостающие
типы событий.

**Добавленные типы:**
| Новый event_type | Источник события |
|------------------|-----------------|
| `session_completed` | `session.idle` / `session.error` |
| `todo_completed` | `todo.updated` (status → completed) |
| `lsp_diagnostic` | `lsp.client.diagnostics` |
| `lsp_diagnostic_summary` | Периодическая агрегация LSP-диагностики |

**Метод:** Пересоздание таблицы через transaction:
1. `CREATE TABLE developer_events_new (...)` — новая таблица с расширенным CHECK
2. `INSERT INTO developer_events_new SELECT * FROM developer_events` — копирование данных
3. `DROP TABLE developer_events` — удаление старой таблицы
4. `ALTER TABLE developer_events_new RENAME TO developer_events` — переименование
5. Пересоздание индексов: `idx_dev_type`, `idx_dev_ts`

**SQLite-ограничение:** ALTER TABLE в SQLite не поддерживает изменение CHECK-констрейнтов,
поэтому использован метод пересоздания таблицы через DROP + RENAME.

```typescript
// src/migrations/002_fix_event_types.ts
import type { Database } from "bun:sqlite";

export default function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS developer_events_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type      TEXT NOT NULL CHECK (event_type IN (
                          'session_started', 'session_completed',
                          'manual_edit', 'revert', 'command_used',
                          'human_fix', 'session_start', 'session_end',
                          'file_focus', 'tool_rejected',
                          'todo_completed',
                          'lsp_diagnostic', 'lsp_diagnostic_summary'
                        )),
        session_id      TEXT,
        file_path       TEXT,
        metadata        TEXT,
        timestamp       INTEGER NOT NULL
    );

    INSERT INTO developer_events_new
      (id, event_type, session_id, file_path, metadata, timestamp)
    SELECT id, event_type, session_id, file_path, metadata, timestamp
    FROM developer_events;

    DROP TABLE developer_events;

    ALTER TABLE developer_events_new RENAME TO developer_events;

    CREATE INDEX IF NOT EXISTS idx_dev_type ON developer_events (event_type);
    CREATE INDEX IF NOT EXISTS idx_dev_ts   ON developer_events (timestamp);
  `);
}
```

### 13.7 Пример будущей миграции

### 14.1 Топ-10 самых «горячих» файлов по частоте изменений

```sql
SELECT
  file_path,
  COUNT(*)                                                AS edit_count,
  SUM(CASE WHEN edit_type = 'update' THEN 1 ELSE 0 END)   AS updates,
  SUM(CASE WHEN edit_type = 'create' THEN 1 ELSE 0 END)   AS creates,
  SUM(CASE WHEN edit_type = 'delete' THEN 1 ELSE 0 END)   AS deletes,
  SUM(lines_added)                                        AS total_lines_added,
  SUM(lines_removed)                                      AS total_lines_removed,
  SUM(CASE WHEN was_reverted = 1 THEN 1 ELSE 0 END)       AS revert_count,
  MAX(timestamp)                                          AS last_edited_at
FROM file_edits
GROUP BY file_path
ORDER BY edit_count DESC
LIMIT 10;
```

### 14.2 Топ-10 файлов с наивысшим риском (частота ошибок)

```sql
SELECT
  context_file                                              AS file_path,
  COUNT(*)                                                  AS error_count,
  COUNT(DISTINCT session_id)                                AS sessions_with_errors,
  SUM(CASE WHEN resolved = 1 THEN 1 ELSE 0 END)             AS resolved_count,
  ROUND(
    CAST(SUM(CASE WHEN resolved = 1 THEN 1 ELSE 0 END) AS REAL)
    / COUNT(*) * 100, 1
  )                                                         AS resolution_rate_pct
FROM session_errors
WHERE context_file IS NOT NULL
GROUP BY context_file
ORDER BY error_count DESC
LIMIT 10;
```

### 14.3 Оценка риска для изменения конкретного файла

```sql
WITH file_stats AS (
  SELECT
    COUNT(*)                                                AS total_edits,
    SUM(CASE WHEN was_reverted = 1 THEN 1 ELSE 0 END)       AS total_reverts,
    MAX(timestamp)                                          AS last_edit
  FROM file_edits
  WHERE file_path = :target_file
),
error_stats AS (
  SELECT
    COUNT(*)                                                AS total_errors,
    SUM(CASE WHEN resolved = 0 THEN 1 ELSE 0 END)           AS unresolved_errors
  FROM session_errors
  WHERE context_file = :target_file
),
co_change_stats AS (
  SELECT COUNT(*) AS coupled_files_count
  FROM knowledge_edges ke
  JOIN knowledge_nodes kn_src ON ke.source_id = kn_src.id
  WHERE kn_src.path = :target_file
    AND ke.edge_type = 'depends_on'
)
SELECT
  :target_file                                              AS file_path,
  COALESCE(fs.total_edits, 0)                               AS total_edits,
  COALESCE(fs.total_reverts, 0)                             AS total_reverts,
  CASE WHEN fs.total_edits > 0
    THEN ROUND(CAST(fs.total_reverts AS REAL) / fs.total_edits * 100, 1)
    ELSE 0
  END                                                       AS revert_rate_pct,
  COALESCE(es.total_errors, 0)                              AS total_errors,
  COALESCE(es.unresolved_errors, 0)                         AS unresolved_errors,
  COALESCE(cs.coupled_files_count, 0)                       AS coupled_files_count,
  CASE
    WHEN COALESCE(fs.total_reverts, 0) > 5
      OR COALESCE(es.unresolved_errors, 0) > 3 THEN 'critical'
    WHEN COALESCE(fs.total_reverts, 0) > 2
      OR COALESCE(es.unresolved_errors, 0) > 1 THEN 'high'
    WHEN COALESCE(fs.total_reverts, 0) > 0
      OR COALESCE(es.total_errors, 0) > 0 THEN 'medium'
    ELSE 'low'
  END                                                       AS risk_level
FROM file_stats fs, error_stats es, co_change_stats cs;
```

### 14.4 Статистика разработчика за текущий месяц

```sql
WITH current_month AS (
  SELECT
    strftime('%Y-%m', datetime(started_at / 1000, 'unixepoch')) AS month,
    COUNT(*)                                                    AS sessions_count,
    SUM(duration_ms)                                            AS total_time_ms,
    AVG(duration_ms)                                            AS avg_session_time_ms,
    SUM(files_changed_count)                                    AS files_changed,
    SUM(tools_used_count)                                       AS tools_used,
    SUM(errors_count)                                           AS errors_total,
    SUM(message_count)                                          AS messages_total,
    SUM(total_tokens_used)                                      AS tokens_total
  FROM sessions
  WHERE status IN ('idle', 'compacted')
    AND started_at >= :month_start_ts
    AND started_at < :next_month_start_ts
),
file_activity AS (
  SELECT
    COUNT(*)                      AS file_edits_total,
    COUNT(DISTINCT file_path)     AS unique_files_touched
  FROM file_edits
  WHERE timestamp >= :month_start_ts
    AND timestamp < :next_month_start_ts
),
reverts AS (
  SELECT COUNT(*) AS reverts_total
  FROM file_edits
  WHERE was_reverted = 1
    AND timestamp >= :month_start_ts
    AND timestamp < :next_month_start_ts
)
SELECT
  cm.month,
  cm.sessions_count,
  cm.total_time_ms,
  ROUND(cm.avg_session_time_ms / 60000.0, 1)   AS avg_session_minutes,
  cm.files_changed,
  cm.tools_used,
  cm.errors_total,
  cm.messages_total,
  cm.tokens_total,
  fa.file_edits_total,
  fa.unique_files_touched,
  rv.reverts_total,
  CASE WHEN cm.sessions_count > 0
    THEN ROUND(CAST(cm.errors_total AS REAL) / cm.sessions_count, 2)
    ELSE 0
  END                                           AS errors_per_session,
  CASE WHEN fa.file_edits_total > 0
    THEN ROUND(CAST(rv.reverts_total AS REAL) / fa.file_edits_total * 100, 1)
    ELSE 0
  END                                           AS revert_rate_pct
FROM current_month cm, file_activity fa, reverts rv;
```

### 14.5 Самые связанные файлы (совместные изменения)

```sql
SELECT
  kn_a.path                                      AS file_a,
  kn_b.path                                      AS file_b,
  ke.evidence_count                              AS co_change_count,
  ke.weight                                      AS coupling_weight,
  ke.first_seen                                  AS first_seen_together,
  ke.last_seen                                   AS last_seen_together
FROM knowledge_edges ke
JOIN knowledge_nodes kn_a ON ke.source_id = kn_a.id
JOIN knowledge_nodes kn_b ON ke.target_id = kn_b.id
WHERE ke.edge_type IN ('depends_on', 'coupled_with')
  AND ke.evidence_count >= 2
ORDER BY ke.evidence_count DESC, ke.weight DESC
LIMIT 20;
```

### 14.6 Частота ошибок по файлам за период

```sql
SELECT
  se.context_file                                AS file_path,
  COUNT(*)                                       AS error_count,
  COUNT(DISTINCT se.session_id)                  AS sessions_affected,
  COUNT(DISTINCT se.error_type)                  AS unique_error_types,
  SUM(CASE WHEN se.resolved = 1 THEN 1 ELSE 0 END) AS resolved_count,
  ROUND(
    CAST(SUM(CASE WHEN se.resolved = 1 THEN 1 ELSE 0 END) AS REAL)
    / COUNT(*) * 100, 1
  )                                              AS resolution_rate_pct,
  MIN(se.timestamp)                              AS first_error_at,
  MAX(se.timestamp)                              AS last_error_at
FROM session_errors se
WHERE se.context_file IS NOT NULL
  AND se.timestamp >= :period_start_ts
  AND se.timestamp < :period_end_ts
GROUP BY se.context_file
ORDER BY error_count DESC;
```

### 14.7 Граф зависимостей для файла (все связи)

```sql
WITH dependencies AS (
  SELECT
    kn_src.path   AS source_file,
    kn_tgt.path   AS target_file,
    ke.edge_type,
    ke.weight,
    ke.evidence_count,
    'outgoing'    AS direction
  FROM knowledge_edges ke
  JOIN knowledge_nodes kn_src ON ke.source_id = kn_src.id
  JOIN knowledge_nodes kn_tgt ON ke.target_id = kn_tgt.id
  WHERE kn_src.path = :target_file

  UNION ALL

  SELECT
    kn_tgt.path   AS source_file,
    kn_src.path   AS target_file,
    ke.edge_type,
    ke.weight,
    ke.evidence_count,
    'incoming'    AS direction
  FROM knowledge_edges ke
  JOIN knowledge_nodes kn_src ON ke.source_id = kn_src.id
  JOIN knowledge_nodes kn_tgt ON ke.target_id = kn_tgt.id
  WHERE kn_tgt.path = :target_file
)
SELECT *
FROM dependencies
ORDER BY weight DESC, evidence_count DESC;
```

### 14.8 Статистика использования инструментов

```sql
SELECT
  tool_name,
  COUNT(*)                                              AS total_calls,
  SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)   AS success_count,
  SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)     AS error_count,
  SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END)   AS timeout_count,
  SUM(CASE WHEN status = 'denied' THEN 1 ELSE 0 END)    AS denied_count,
  ROUND(AVG(duration_ms), 0)                            AS avg_duration_ms,
  MAX(duration_ms)                                      AS max_duration_ms,
  SUM(COALESCE(result_size_bytes, 0))                   AS total_result_bytes
FROM tool_executions
WHERE timestamp >= :period_start_ts
  AND timestamp < :period_end_ts
GROUP BY tool_name
ORDER BY total_calls DESC;
```

### 14.9 Анализ откатов (reverts) по типам агентов

```sql
SELECT
  fe.agent_type,
  COUNT(*)                                              AS total_edits,
  SUM(CASE WHEN fe.was_reverted = 1 THEN 1 ELSE 0 END)  AS reverted_edits,
  ROUND(
    CAST(SUM(CASE WHEN fe.was_reverted = 1 THEN 1 ELSE 0 END) AS REAL)
    / COUNT(*) * 100, 1
  )                                                     AS revert_rate_pct
FROM file_edits fe
WHERE fe.timestamp >= :period_start_ts
  AND fe.timestamp < :period_end_ts
GROUP BY fe.agent_type
ORDER BY revert_rate_pct DESC;
```

### 14.10 Поиск неисправленных ошибок (для Dashboard)

```sql
SELECT
  se.context_file,
  se.error_type,
  se.error_message,
  se.timestamp,
  s.agent_type,
  s.project_root
FROM session_errors se
JOIN sessions s ON se.session_id = s.id
WHERE se.resolved = 0
  AND se.timestamp >= :lookback_start_ts
ORDER BY se.timestamp DESC
LIMIT 50;
```

---

## 15. Хранение данных (Data Retention)

### 15.1 Политики хранения по типам данных

| Тип данных             | Таблицы | Срок хранения | Конфигурация |
|------------------------|---------|---------------|--------------|
| Сырые события          | file_edits, tool_executions, session_errors, developer_events | **90 дней** (по умолчанию) | config.json: retention.rawEventsDays |
| Аналитический кеш      | analytics_cache | **24 часа** (по умолчанию) | config.json: retention.cacheTtlHours |
| Граф знаний            | knowledge_nodes, knowledge_edges | **Бессрочно** (инкрементально обновляется) | Не удаляется |
| Архитектурные решения  | decisions | **Бессрочно** | Не удаляется |
| Сводки сессий          | sessions | **365 дней** (по умолчанию) | config.json: retention.sessionRetentionDays |

### 15.2 Механизм очистки

Очистка запускается при старте плагина и затем периодически (каждый час).
Выполняется внутри SQLite-транзакции для атомарности.

```typescript
// src/storage/retention.ts
import type { Database } from 'bun:sqlite'

interface RetentionConfig {
  rawEventsDays: number
  cacheTtlHours: number
  sessionRetentionDays: number
}

export function scheduleDataRetention(
  db: Database.Database,
  config: RetentionConfig
): void {
  const cleanup = () => {
    const now = Date.now()

    const result = db.transaction(() => {
      let totalDeleted = 0

      // 1. Сырые события: удаляем записи старше rawEventsDays
      if (config.rawEventsDays > 0) {
        const rawCutoff = now - config.rawEventsDays * 24 * 60 * 60 * 1000
        const rawTables = [
          'file_edits', 'tool_executions',
          'session_errors', 'developer_events'
        ]
        for (const table of rawTables) {
          const stmt = db.prepare(
            'DELETE FROM ' + table + ' WHERE timestamp < ?'
          )
          totalDeleted += stmt.run(rawCutoff).changes
        }
      }

      // 2. Сессии: удаляем завершённые сессии старше sessionRetentionDays
      if (config.sessionRetentionDays > 0) {
        const sessionCutoff =
          now - config.sessionRetentionDays * 24 * 60 * 60 * 1000
        const stmt = db.prepare(
          "DELETE FROM sessions WHERE started_at < ? AND status != 'active'"
        )
        totalDeleted += stmt.run(sessionCutoff).changes
      }

      // 3. Кеш аналитики: удаляем просроченные записи
      const expiredCache = db.prepare(
        'DELETE FROM analytics_cache WHERE valid_until IS NOT NULL AND valid_until < ?'
      )
      totalDeleted += expiredCache.run(now).changes

      return totalDeleted
    })()

    if (result > 0) {
      console.log(
        '[CodeShadow] Data retention: удалено ' + result + ' устаревших записей'
      )
    }
  }

  // Запускаем сразу и затем каждый час
  cleanup()
  setInterval(cleanup, 60 * 60 * 1000)
}
```

### 15.3 Конфигурация через config.json

Файл: `C:\plugins\code-shadow\config.json`

```json
{
  "retention": {
    "rawEventsDays": 90,
    "cacheTtlHours": 24,
    "sessionRetentionDays": 365,
    "cleanupIntervalMinutes": 60
  }
}
```

### 15.4 Ручная очистка (CLI-команды)

```bash
# Удалить все данные старше N дней
opencode shadow cleanup --older-than 30

# Удалить данные конкретного проекта
opencode shadow cleanup --project /path/to/project

# Полный сброс (удаление всей БД)
opencode shadow reset --confirm
```

### 15.5 Оценка объёма данных

| Сценарий                          | Событий/день | Строк/день | Объём через 90 дней |
|-----------------------------------|-------------|------------|---------------------|
| Активный соло-разработчик         | ~500        | ~2 000     | ~5 МБ               |
| Активный соло + AI-помощник       | ~1 200      | ~5 000     | ~12 МБ              |
| Команда из 3 человек + AI         | ~3 000      | ~12 000    | ~30 МБ              |

> Примечание: SQLite с WAL-режимом и индексами добавляет ~30% накладных
> расходов. При 90-дневной ротации старые данные удаляются, поэтому
> объём БД стабилизируется.

---

## Приложение А: Полный скрипт инициализации БД

```sql
-- ============================================================
-- Code Shadow: Полная инициализация базы данных (миграция 001)
-- Версия схемы: 1
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA cache_size = -64000;

-- 1. Служебная таблица версий миграций
CREATE TABLE IF NOT EXISTS schema_version (
    version     INTEGER PRIMARY KEY,
    applied_at  INTEGER NOT NULL,
    description TEXT
);

-- 2. Сессии
CREATE TABLE IF NOT EXISTS sessions (
    id                  TEXT PRIMARY KEY,
    agent_type          TEXT NOT NULL CHECK (agent_type IN ('build', 'plan', 'general')),
    status              TEXT NOT NULL CHECK (status IN ('created', 'active', 'idle',
                                                        'error', 'compacted', 'deleted')),
    started_at          INTEGER NOT NULL,
    ended_at            INTEGER,
    duration_ms         INTEGER,
    files_changed_count INTEGER DEFAULT 0,
    tools_used_count    INTEGER DEFAULT 0,
    errors_count        INTEGER DEFAULT 0,
    project_root        TEXT NOT NULL,
    message_count       INTEGER DEFAULT 0,
    total_tokens_used   INTEGER DEFAULT 0,
    compacted_from      TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_status  ON sessions (status);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions (started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions (project_root);

-- 3. Редактирования файлов
CREATE TABLE IF NOT EXISTS file_edits (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path       TEXT NOT NULL,
    session_id      TEXT NOT NULL,
    agent_type      TEXT NOT NULL CHECK (agent_type IN ('build', 'plan', 'general')),
    edit_type       TEXT NOT NULL CHECK (edit_type IN ('create', 'update', 'delete')),
    diff_preview    TEXT,
    lines_added     INTEGER DEFAULT 0,
    lines_removed   INTEGER DEFAULT 0,
    timestamp       INTEGER NOT NULL,
    project_root    TEXT NOT NULL,
    was_reverted    INTEGER DEFAULT 0 CHECK (was_reverted IN (0, 1)),
    file_language   TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_file_edits_path      ON file_edits (file_path);
CREATE INDEX IF NOT EXISTS idx_file_edits_session   ON file_edits (session_id);
CREATE INDEX IF NOT EXISTS idx_file_edits_timestamp ON file_edits (timestamp);
CREATE INDEX IF NOT EXISTS idx_file_edits_path_ts   ON file_edits (file_path, timestamp);

-- 4. Ошибки сессий
CREATE TABLE IF NOT EXISTS session_errors (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    error_type      TEXT NOT NULL CHECK (error_type IN ('tool_error', 'model_error',
                                                        'permission_denied', 'unknown')),
    error_message   TEXT NOT NULL,
    error_stack     TEXT,
    context_file    TEXT,
    context_tool    TEXT,
    timestamp       INTEGER NOT NULL,
    resolved        INTEGER DEFAULT 0 CHECK (resolved IN (0, 1)),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_errors_session ON session_errors (session_id);
CREATE INDEX IF NOT EXISTS idx_errors_file    ON session_errors (context_file);
CREATE INDEX IF NOT EXISTS idx_errors_type    ON session_errors (error_type);

-- 5. Выполнения инструментов
CREATE TABLE IF NOT EXISTS tool_executions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id        TEXT NOT NULL,
    tool_name         TEXT NOT NULL,
    target_file       TEXT,
    args_preview      TEXT,
    status            TEXT NOT NULL CHECK (status IN ('success', 'error', 'timeout', 'denied')),
    duration_ms       INTEGER,
    timestamp         INTEGER NOT NULL,
    result_size_bytes INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tool_session ON tool_executions (session_id);
CREATE INDEX IF NOT EXISTS idx_tool_name    ON tool_executions (tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_file    ON tool_executions (target_file);
CREATE INDEX IF NOT EXISTS idx_tool_ts      ON tool_executions (timestamp);

-- 6. Архитектурные решения
CREATE TABLE IF NOT EXISTS decisions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    title           TEXT NOT NULL,
    description     TEXT NOT NULL,
    context         TEXT,
    alternatives    TEXT,
    status          TEXT NOT NULL CHECK (status IN ('proposed', 'accepted',
                                                    'deprecated', 'superseded')),
    decided_by      TEXT,
    decided_at      INTEGER NOT NULL,
    superseded_by   INTEGER REFERENCES decisions(id),
    related_files   TEXT,
    tags            TEXT
);
CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions (status);
CREATE INDEX IF NOT EXISTS idx_decisions_tags   ON decisions (tags);

-- 7. Узлы графа знаний
CREATE TABLE IF NOT EXISTS knowledge_nodes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    node_type       TEXT NOT NULL CHECK (node_type IN ('file', 'module', 'concept',
                                                       'pattern', 'rule', 'api_endpoint')),
    name            TEXT NOT NULL,
    path            TEXT,
    metadata        TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kn_type ON knowledge_nodes (node_type);
CREATE INDEX IF NOT EXISTS idx_kn_path ON knowledge_nodes (path);
CREATE INDEX IF NOT EXISTS idx_kn_name ON knowledge_nodes (name);

-- 8. Рёбра графа знаний
CREATE TABLE IF NOT EXISTS knowledge_edges (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id       INTEGER NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
    target_id       INTEGER NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
    edge_type       TEXT NOT NULL CHECK (edge_type IN (
                        'imports', 'exports', 'contains',
                        'depends_on', 'causes_bugs_in', 'refactored_to',
                        'similar_to', 'tested_by', 'implements', 'extends'
                    )),
    weight          REAL DEFAULT 1.0,
    evidence_count  INTEGER DEFAULT 1,
    first_seen      INTEGER NOT NULL,
    last_seen       INTEGER NOT NULL,
    UNIQUE (source_id, target_id, edge_type)
);
CREATE INDEX IF NOT EXISTS idx_ke_source ON knowledge_edges (source_id);
CREATE INDEX IF NOT EXISTS idx_ke_target ON knowledge_edges (target_id);
CREATE INDEX IF NOT EXISTS idx_ke_type   ON knowledge_edges (edge_type);
CREATE INDEX IF NOT EXISTS idx_ke_both   ON knowledge_edges (source_id, target_id);

-- 9. События разработчика
CREATE TABLE IF NOT EXISTS developer_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type      TEXT NOT NULL CHECK (event_type IN ('session_started', 'manual_edit',
                                                        'revert', 'command_used')),
    session_id      TEXT,
    file_path       TEXT,
    metadata        TEXT,
    timestamp       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dev_type ON developer_events (event_type);
CREATE INDEX IF NOT EXISTS idx_dev_ts   ON developer_events (timestamp);

-- 10. Кеш аналитики
CREATE TABLE IF NOT EXISTS analytics_cache (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    cache_key           TEXT NOT NULL UNIQUE,
    cache_data          TEXT NOT NULL,
    computed_at         INTEGER NOT NULL,
    valid_until         INTEGER,
    computation_time_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cache_key ON analytics_cache (cache_key);

-- Регистрация миграции
INSERT INTO schema_version (version, applied_at, description)
VALUES (1, CAST(strftime('%s', 'now') AS INTEGER) * 1000, '001_initial.sql');
```

---

## Приложение Б: Быстрый старт — код инициализации

```typescript
// src/storage/index.ts
import { Database } from 'bun:sqlite'
import path from 'node:path'
import fs from 'node:fs'
import { MigrationRunner } from './migrations/runner'

export interface StorageConfig {
  configDir: string
  retentionDays: number
}

export async function createStorageEngine(
  config: StorageConfig
): Promise<Database.Database> {
  const dbDir = path.join(config.configDir, 'shadow')
  const dbPath = path.join(dbDir, 'data.db')

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true })
  }

  const db = new Database(dbPath)

  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('cache_size = -64000')

  const migrator = new MigrationRunner(db)
  const migrationsDir = path.join(__dirname, 'migrations')
  migrator.applyPending(migrationsDir)

  return db
}
```

---

> **Документ актуален на:** 2026-07-17
> **Версия схемы БД:** 2
> **Путь к файлу БД:** ~/.config/opencode/shadow/data.db
> **Следующее обновление документа:** при изменении схемы БД (миграция версии 3+)
