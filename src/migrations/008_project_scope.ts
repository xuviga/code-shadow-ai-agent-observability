// =============================================================================
// Code Shadow — Migration 008: project scope for memory and decisions
// =============================================================================
// knowledge_nodes and decisions were global, so hotspots/memory/adr from one
// project leaked into every other project. Existing rows keep project_root
// NULL and remain globally visible; new rows can be scoped.

import type { Database } from "bun:sqlite"

function hasColumn(db: Database, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>
  return columns.some((item) => item.name === column)
}

export function migrateV008ProjectScope(db: Database): void {
  const now = Date.now()

  db.transaction(() => {
    if (!hasColumn(db, "knowledge_nodes", "project_root")) {
      db.run(`ALTER TABLE knowledge_nodes ADD COLUMN project_root TEXT`)
    }
    if (!hasColumn(db, "decisions", "project_root")) {
      db.run(`ALTER TABLE decisions ADD COLUMN project_root TEXT`)
    }
    db.run("CREATE INDEX IF NOT EXISTS idx_kn_project ON knowledge_nodes(project_root)")
    db.run("CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project_root)")
    db.prepare(
      `INSERT INTO schema_version (version, applied_at, description)
       VALUES (?1, ?2, ?3)`,
    ).run(8, now, "Add project_root to knowledge_nodes and decisions")
  })()
}

export default migrateV008ProjectScope
