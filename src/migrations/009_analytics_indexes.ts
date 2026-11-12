// =============================================================================
// Code Shadow — Migration 009: analytics indexes and edge uniqueness
// =============================================================================
// Query patterns used by analytics (file+time, session+file, event type+time)
// lacked composite indexes. knowledge_edges also allowed duplicate edges when
// two processes upserted the same relation concurrently.

import type { Database } from "bun:sqlite"

export function migrateV009AnalyticsIndexes(db: Database): void {
  const now = Date.now()

  db.transaction(() => {
    db.run("CREATE INDEX IF NOT EXISTS idx_errors_file_ts ON session_errors(context_file, timestamp)")
    db.run("CREATE INDEX IF NOT EXISTS idx_tool_file_ts ON tool_executions(target_file, timestamp)")
    db.run("CREATE INDEX IF NOT EXISTS idx_dev_type_ts ON developer_events(event_type, timestamp)")
    db.run("CREATE INDEX IF NOT EXISTS idx_sessions_project_started ON sessions(project_root, started_at)")
    db.run("CREATE INDEX IF NOT EXISTS idx_decisions_project_time ON decisions(project_root, decided_at)")
    db.run("CREATE INDEX IF NOT EXISTS idx_decisions_status_time ON decisions(status, decided_at)")
    db.run("CREATE INDEX IF NOT EXISTS idx_file_edits_session_file ON file_edits(session_id, file_path)")
    db.run("CREATE INDEX IF NOT EXISTS idx_kn_project_type ON knowledge_nodes(project_root, node_type)")

    // Deduplicate before enforcing uniqueness.
    db.run(`DELETE FROM knowledge_edges WHERE id NOT IN (
      SELECT MIN(id) FROM knowledge_edges GROUP BY source_id, target_id, edge_type
    )`)
    db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_ke_unique ON knowledge_edges(source_id, target_id, edge_type)")

    db.prepare(
      `INSERT INTO schema_version (version, applied_at, description)
       VALUES (?1, ?2, ?3)`,
    ).run(9, now, "Add analytics composite indexes and unique knowledge edges")
  })()
}

export default migrateV009AnalyticsIndexes
