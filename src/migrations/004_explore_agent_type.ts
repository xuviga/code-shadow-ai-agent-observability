// =============================================================================
// Code Shadow — Migration 004: Add 'explore' agent type to CHECK constraints
// OpenCode can create sessions with agent types: build, plan, general, explore.
// SQLite does not support ALTER TABLE CHECK constraints — recreate tables.
// =============================================================================

import type { Database } from "bun:sqlite"

export function migrateV004ExploreAgentType(db: Database): void {
  const now = Date.now()

  db.run("PRAGMA foreign_keys = OFF")

  try {
    db.transaction(() => {
      // -----------------------------------------------------------------------
      // 1. Update file_edits — widen agent_type CHECK to include 'explore'
      // -----------------------------------------------------------------------
      db.run(`
        CREATE TABLE file_edits_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_path TEXT NOT NULL,
          session_id TEXT NOT NULL,
          agent_type TEXT NOT NULL CHECK(agent_type IN ('build','plan','general','explore')),
          edit_type TEXT NOT NULL CHECK(edit_type IN ('create','update','delete')),
          diff_preview TEXT,
          lines_added INTEGER DEFAULT 0,
          lines_removed INTEGER DEFAULT 0,
          timestamp INTEGER NOT NULL,
          project_root TEXT NOT NULL DEFAULT '',
          was_reverted INTEGER DEFAULT 0,
          file_language TEXT,
          diff_hash TEXT
        )
      `)

      db.run("INSERT INTO file_edits_new SELECT * FROM file_edits")
      db.run("DROP TABLE file_edits")
      db.run("ALTER TABLE file_edits_new RENAME TO file_edits")

      db.run("CREATE INDEX IF NOT EXISTS idx_file_edits_path ON file_edits(file_path)")
      db.run("CREATE INDEX IF NOT EXISTS idx_file_edits_session ON file_edits(session_id)")
      db.run("CREATE INDEX IF NOT EXISTS idx_file_edits_timestamp ON file_edits(timestamp)")
      db.run("CREATE INDEX IF NOT EXISTS idx_file_edits_path_ts ON file_edits(file_path, timestamp)")

      // -----------------------------------------------------------------------
      // 2. Update sessions — widen agent_type CHECK to include 'explore'
      // -----------------------------------------------------------------------
      db.run(`
        CREATE TABLE sessions_new (
          id TEXT PRIMARY KEY,
          agent_type TEXT NOT NULL CHECK(agent_type IN ('build','plan','general','explore')),
          status TEXT NOT NULL CHECK(status IN ('created','active','idle','error','compacted','deleted')),
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          duration_ms INTEGER,
          files_changed_count INTEGER DEFAULT 0,
          tools_used_count INTEGER DEFAULT 0,
          errors_count INTEGER DEFAULT 0,
          project_root TEXT NOT NULL,
          message_count INTEGER DEFAULT 0,
          total_tokens_used INTEGER DEFAULT 0,
          compacted_from TEXT
        )
      `)

      db.run("INSERT INTO sessions_new SELECT * FROM sessions")
      db.run("DROP TABLE sessions")
      db.run("ALTER TABLE sessions_new RENAME TO sessions")

      db.run("CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)")
      db.run("CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at)")
      db.run("CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_root)")
      db.run("CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_type)")

      // -----------------------------------------------------------------------
      // 3. Record migration version
      // -----------------------------------------------------------------------
      db.prepare(
        `INSERT INTO schema_version (version, applied_at, description) VALUES (?1, ?2, ?3)`
      ).run(4, now, "Add 'explore' agent type to file_edits and sessions CHECK constraints")

      console.log("[migration:004] Added 'explore' agent type to CHECK constraints")
    })()
  } finally {
    db.run("PRAGMA foreign_keys = ON")
  }
}

export default migrateV004ExploreAgentType
