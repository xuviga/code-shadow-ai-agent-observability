// =============================================================================
// Code Shadow — Миграция 002: Исправление CHECK-ограничения developer_events
// В миграции 001 ограничение было неполным (отсутствовали event_type:
// session_completed, todo_completed, lsp_diagnostic, lsp_diagnostic_summary).
// Поскольку SQLite не поддерживает ALTER TABLE CONSTRAINT, пересоздаём таблицу:
//   1. Создаём новую таблицу с полным CHECK
//   2. Копируем все данные
//   3. Удаляем старую таблицу
//   4. Переименовываем новую
//   5. Пересоздаём индексы
// =============================================================================

import type { Database } from "bun:sqlite";

export function migrateV002FixEventTypes(db: Database): void {
  const now = Date.now();

  db.transaction(() => {
    // -----------------------------------------------------------------------
    // Шаг 1: Создаём новую таблицу с полным CHECK-ограничением
    // -----------------------------------------------------------------------
    db.run(`
      CREATE TABLE developer_events_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL CHECK(event_type IN (
          'session_started','manual_edit','revert','command_used','human_fix',
          'session_start','session_end','file_focus','tool_rejected',
          'session_completed','todo_completed','lsp_diagnostic','lsp_diagnostic_summary'
        )),
        session_id TEXT,
        file_path TEXT,
        metadata TEXT,
        timestamp INTEGER NOT NULL
      );
    `);

    // -----------------------------------------------------------------------
    // Шаг 2: Копируем все существующие данные из старой таблицы в новую
    // -----------------------------------------------------------------------
    const existingRows = db.query("SELECT * FROM developer_events").all() as {
      id: number;
      event_type: string;
      session_id: string | null;
      file_path: string | null;
      metadata: string | null;
      timestamp: number;
    }[];

    if (existingRows.length > 0) {
      const insertStmt = db.prepare(
        `INSERT INTO developer_events_new (id, event_type, session_id, file_path, metadata, timestamp)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      );

      for (const row of existingRows) {
        insertStmt.run(
          row.id,
          row.event_type,
          row.session_id,
          row.file_path,
          row.metadata,
          row.timestamp,
        );
      }
    }

    // -----------------------------------------------------------------------
    // Шаг 3: Удаляем старую таблицу
    // -----------------------------------------------------------------------
    db.run("DROP TABLE developer_events");

    // -----------------------------------------------------------------------
    // Шаг 4: Переименовываем новую таблицу
    // -----------------------------------------------------------------------
    db.run("ALTER TABLE developer_events_new RENAME TO developer_events");

    // -----------------------------------------------------------------------
    // Шаг 5: Пересоздаём индексы
    // -----------------------------------------------------------------------
    db.run("CREATE INDEX IF NOT EXISTS idx_dev_type ON developer_events(event_type)");
    db.run("CREATE INDEX IF NOT EXISTS idx_dev_ts ON developer_events(timestamp)");

    // -----------------------------------------------------------------------
    // Шаг 6: Запись версии схемы
    // -----------------------------------------------------------------------
    db.prepare(
      `INSERT INTO schema_version (version, applied_at, description) VALUES (?1, ?2, ?3)`,
    ).run(
      2,
      now,
      "Fix developer_events CHECK constraint — added session_completed, todo_completed, lsp_diagnostic, lsp_diagnostic_summary",
    );
  })();

  console.log("Миграция 002 применена: CHECK-ограничение developer_events исправлено");
}
