// =============================================================================
// Code Shadow — Миграция 003: Добавление 'lsp' в CHECK-ограничение session_errors
// SQLite не поддерживает ALTER TABLE CONSTRAINT — пересоздаём таблицу.
// =============================================================================

import type { Database } from "bun:sqlite";

export function migrateV003LspErrorType(db: Database): void {
  const now = Date.now();

  db.transaction(() => {
    db.run(`
      CREATE TABLE session_errors_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        error_type TEXT NOT NULL CHECK(error_type IN ('tool_error','model_error','permission_denied','unknown','lsp')),
        error_message TEXT NOT NULL,
        error_stack TEXT,
        context_file TEXT,
        context_tool TEXT,
        timestamp INTEGER NOT NULL,
        resolved INTEGER DEFAULT 0
      );
    `);

    const existingRows = db.query("SELECT * FROM session_errors").all() as {
      id: number;
      session_id: string;
      error_type: string;
      error_message: string;
      error_stack: string | null;
      context_file: string | null;
      context_tool: string | null;
      timestamp: number;
      resolved: number;
    }[];

    if (existingRows.length > 0) {
      const insertStmt = db.prepare(
        `INSERT INTO session_errors_new (id, session_id, error_type, error_message, error_stack, context_file, context_tool, timestamp, resolved)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      );

      for (const row of existingRows) {
        insertStmt.run(
          row.id,
          row.session_id,
          row.error_type,
          row.error_message,
          row.error_stack,
          row.context_file,
          row.context_tool,
          row.timestamp,
          row.resolved,
        );
      }
    }

    db.run("DROP TABLE session_errors");
    db.run("ALTER TABLE session_errors_new RENAME TO session_errors");

    db.run("CREATE INDEX IF NOT EXISTS idx_errors_session ON session_errors(session_id)");
    db.run("CREATE INDEX IF NOT EXISTS idx_errors_type ON session_errors(error_type)");
    db.run("CREATE INDEX IF NOT EXISTS idx_errors_ts ON session_errors(timestamp)");

    db.prepare(
      `INSERT INTO schema_version (version, applied_at, description) VALUES (?1, ?2, ?3)`,
    ).run(
      3,
      now,
      "Add lsp to session_errors CHECK constraint — LSP real code error tracking",
    );
  })();

  console.log("Миграция 003 применена: CHECK-ограничение session_errors расширено (добавлен lsp)");
}
