// =============================================================================
// Code Shadow — Migration 005: persist OpenCode todos
// =============================================================================

import type { Database } from "bun:sqlite"

/**
 * Adds the todos table used by observer.ts for todo.updated events.
 * IF NOT EXISTS keeps the migration safe for databases that were bootstrapped
 * from a development schema containing the table already.
 */
export function migrateV005AddTodos(db: Database): void {
  const now = Date.now()

  db.transaction(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS todos (
        todo_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled')),
        created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `)

    db.run("CREATE INDEX IF NOT EXISTS idx_todos_session ON todos(session_id)")
    db.run("CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status)")
    db.run("CREATE INDEX IF NOT EXISTS idx_todos_updated ON todos(updated_at)")

    db.prepare(
      `INSERT INTO schema_version (version, applied_at, description)
       VALUES (?1, ?2, ?3)`,
    ).run(5, now, "Add todos table for todo.updated tracking")
  })()
}

export default migrateV005AddTodos
