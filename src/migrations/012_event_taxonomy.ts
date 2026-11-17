// =============================================================================
// Code Shadow — Migration 012: event taxonomy for guard signals and turns
// =============================================================================
// `tool_rejected` historically mixed real blocks with advisory warnings
// (`successful_edit_loop_warning`, `change_contract_preflight`,
// `agent_loop_detected`). `session_completed` was also emitted after every
// idle turn, which made "completed sessions" metrics several times too high.
//
// This migration only widens the CHECK constraint. Existing rows keep their
// type; new writes use `tool_warning` for non-blocking signals and
// `turn_completed` for per-turn completion.
// =============================================================================

import type { Database } from "bun:sqlite"

export function migrateV012EventTaxonomy(db: Database): void {
  const now = Date.now()

  db.transaction(() => {
    db.run(`
      CREATE TABLE developer_events_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL CHECK(event_type IN (
          'session_started','manual_edit','revert','command_used','human_fix',
          'session_start','session_end','file_focus','tool_rejected','tool_warning',
          'session_completed','turn_completed','todo_completed','lsp_diagnostic',
          'lsp_diagnostic_summary'
        )),
        session_id TEXT,
        file_path TEXT,
        metadata TEXT,
        timestamp INTEGER NOT NULL
      );
    `)

    const existingRows = db.query("SELECT * FROM developer_events").all() as {
      id: number
      event_type: string
      session_id: string | null
      file_path: string | null
      metadata: string | null
      timestamp: number
    }[]

    if (existingRows.length > 0) {
      const insertStmt = db.prepare(
        `INSERT INTO developer_events_new (id, event_type, session_id, file_path, metadata, timestamp)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      for (const row of existingRows) {
        insertStmt.run(
          row.id,
          row.event_type,
          row.session_id,
          row.file_path,
          row.metadata,
          row.timestamp,
        )
      }
    }

    db.run("DROP TABLE developer_events")
    db.run("ALTER TABLE developer_events_new RENAME TO developer_events")
    db.run("CREATE INDEX IF NOT EXISTS idx_dev_type ON developer_events(event_type)")
    db.run("CREATE INDEX IF NOT EXISTS idx_dev_ts ON developer_events(timestamp)")

    db.prepare(
      `INSERT INTO schema_version (version, applied_at, description) VALUES (?1, ?2, ?3)`,
    ).run(
      12,
      now,
      "Add tool_warning and turn_completed event types; separate blocking signals",
    )
  })()
}

export default migrateV012EventTaxonomy
