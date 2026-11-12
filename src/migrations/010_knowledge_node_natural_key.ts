// =============================================================================
// Code Shadow — Migration 010: natural-key uniqueness for knowledge nodes
// =============================================================================
// knowledge_nodes had no unique key, so concurrent upserts could create
// duplicate nodes and inflate dependency counts. File nodes are keyed by path,
// other nodes by name, and both are scoped by project_root.

import type { Database } from "bun:sqlite"

const KEY_VALUE = `(CASE WHEN node_type = 'file' AND path IS NOT NULL THEN path ELSE name END)`

export function migrateV010KnowledgeNodeNaturalKey(db: Database): void {
  const now = Date.now()

  db.transaction(() => {
    // Re-pointing edges onto a survivor can collide with the edge unique index,
    // so drop it for the duration of the merge.
    db.run("DROP INDEX IF EXISTS idx_ke_unique")

    const duplicateGroups = db.prepare(
      `SELECT node_type,
              COALESCE(project_root, '') AS scope,
              ${KEY_VALUE} AS key_value,
              MIN(id) AS keep_id
       FROM knowledge_nodes
       GROUP BY node_type, scope, key_value
       HAVING COUNT(*) > 1`,
    ).all() as Array<{
      node_type: string
      scope: string
      key_value: string
      keep_id: number
    }>

    for (const group of duplicateGroups) {
      const losers = db.prepare(
        `SELECT id FROM knowledge_nodes
         WHERE node_type = ?1
           AND COALESCE(project_root, '') = ?2
           AND ${KEY_VALUE} = ?3
           AND id != ?4`,
      ).all(group.node_type, group.scope, group.key_value, group.keep_id) as Array<{ id: number }>

      for (const loser of losers) {
        db.prepare("UPDATE knowledge_edges SET source_id = ?1 WHERE source_id = ?2").run(group.keep_id, loser.id)
        db.prepare("UPDATE knowledge_edges SET target_id = ?1 WHERE target_id = ?2").run(group.keep_id, loser.id)
        db.prepare("DELETE FROM knowledge_nodes WHERE id = ?1").run(loser.id)
      }
    }

    // Merging can produce self-edges and duplicate relations; keep the first.
    db.run("DELETE FROM knowledge_edges WHERE source_id = target_id")
    db.run(`DELETE FROM knowledge_edges WHERE id NOT IN (
      SELECT MIN(id) FROM knowledge_edges GROUP BY source_id, target_id, edge_type
    )`)
    db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_ke_unique ON knowledge_edges(source_id, target_id, edge_type)")
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_kn_natural_key
      ON knowledge_nodes(node_type, COALESCE(project_root, ''), ${KEY_VALUE})`)

    db.prepare(
      `INSERT INTO schema_version (version, applied_at, description)
       VALUES (?1, ?2, ?3)`,
    ).run(10, now, "Enforce knowledge_nodes natural-key uniqueness")
  })()
}

export default migrateV010KnowledgeNodeNaturalKey
