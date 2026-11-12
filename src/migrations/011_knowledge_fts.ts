// =============================================================================
// Code Shadow — Migration 011: full-text search for knowledge nodes
// =============================================================================
// The memory search used leading-wildcard LIKE queries, which cannot use an
// index. FTS5 gives token/prefix search with bm25 ranking; triggers keep the
// index in sync with knowledge_nodes.

import type { Database } from "bun:sqlite"

export function migrateV011KnowledgeFts(db: Database): void {
  const now = Date.now()

  db.transaction(() => {
    db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_nodes_fts USING fts5(
      name,
      path,
      metadata,
      content='knowledge_nodes',
      content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    )`)

    // Rebuild from the current table so existing memory becomes searchable.
    db.run(`INSERT INTO knowledge_nodes_fts(knowledge_nodes_fts) VALUES('rebuild')`)

    db.run(`CREATE TRIGGER IF NOT EXISTS knowledge_nodes_ai AFTER INSERT ON knowledge_nodes BEGIN
      INSERT INTO knowledge_nodes_fts(rowid, name, path, metadata)
      VALUES (new.id, new.name, new.path, new.metadata);
    END`)

    db.run(`CREATE TRIGGER IF NOT EXISTS knowledge_nodes_ad AFTER DELETE ON knowledge_nodes BEGIN
      INSERT INTO knowledge_nodes_fts(knowledge_nodes_fts, rowid, name, path, metadata)
      VALUES ('delete', old.id, old.name, old.path, old.metadata);
    END`)

    db.run(`CREATE TRIGGER IF NOT EXISTS knowledge_nodes_au AFTER UPDATE ON knowledge_nodes BEGIN
      INSERT INTO knowledge_nodes_fts(knowledge_nodes_fts, rowid, name, path, metadata)
      VALUES ('delete', old.id, old.name, old.path, old.metadata);
      INSERT INTO knowledge_nodes_fts(rowid, name, path, metadata)
      VALUES (new.id, new.name, new.path, new.metadata);
    END`)

    db.prepare(
      `INSERT INTO schema_version (version, applied_at, description)
       VALUES (?1, ?2, ?3)`,
    ).run(11, now, "Add FTS5 index and triggers for knowledge_nodes")
  })()
}

export default migrateV011KnowledgeFts
