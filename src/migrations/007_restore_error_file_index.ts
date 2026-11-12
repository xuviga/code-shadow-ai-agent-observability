// =============================================================================
// Code Shadow — Migration 007: restore idx_errors_file
// =============================================================================
// Migration 003 recreated session_errors and dropped the context_file index
// created by migration 001. Every file-scoped error query was a full scan.

import type { Database } from "bun:sqlite"

export function migrateV007RestoreErrorFileIndex(db: Database): void {
  const now = Date.now()

  db.transaction(() => {
    db.run("CREATE INDEX IF NOT EXISTS idx_errors_file ON session_errors(context_file)")
    db.prepare(
      `INSERT INTO schema_version (version, applied_at, description)
       VALUES (?1, ?2, ?3)`,
    ).run(7, now, "Restore idx_errors_file dropped by migration 003")
  })()
}

export default migrateV007RestoreErrorFileIndex
