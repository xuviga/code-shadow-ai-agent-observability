// =============================================================================
// Code Shadow — Migration 014: tool trust fingerprints
// =============================================================================
// `tool_trust` pins the description and input schema of every tool/MCP tool a
// project has seen. A later scan with a different fingerprint marks the record
// as "changed", which surfaces a possible rug pull (a tool that silently
// rewrote its description or schema after the agent trusted it).
// =============================================================================

import type { Database } from "bun:sqlite"

export function migrateV014ToolTrust(db: Database): void {
  const now = Date.now()

  db.transaction(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS tool_trust (
        id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL,
        server_name TEXT,
        tool_name TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        description_hash TEXT,
        schema_hash TEXT,
        status TEXT NOT NULL CHECK(status IN ('trusted','changed','blocked','suspicious')),
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        metadata TEXT,
        UNIQUE(project_root, tool_name)
      )
    `)

    db.run(`CREATE INDEX IF NOT EXISTS idx_tool_trust_project_status
      ON tool_trust(project_root, status)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_tool_trust_tool
      ON tool_trust(tool_name)`)

    db.prepare(
      `INSERT INTO schema_version (version, applied_at, description) VALUES (?1, ?2, ?3)`,
    ).run(
      14,
      now,
      "Add tool trust fingerprints to detect description/schema rug pulls",
    )
  })()
}

export default migrateV014ToolTrust
