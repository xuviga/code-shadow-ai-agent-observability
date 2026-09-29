// =============================================================================
// Code Shadow — Migration 006: agent-native operating memory
// =============================================================================

import type { Database } from "bun:sqlite"

/**
 * Task Graph, Evidence Ledger, Failure Memory, Change Contracts,
 * Contradictions and Provenance. Все таблицы намеренно простые и append-friendly:
 * агент может безопасно писать прогресс после каждого шага.
 */
export function migrateV006AgentNative(db: Database): void {
  const now = Date.now()
  db.transaction(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS agent_tasks (
        id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL,
        session_id TEXT,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planned'
          CHECK(status IN ('planned','active','blocked','completed','cancelled')),
        priority INTEGER NOT NULL DEFAULT 50,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        metadata TEXT
      )
    `)
    db.run(`
      CREATE TABLE IF NOT EXISTS task_steps (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','in_progress','completed','blocked','skipped')),
        position INTEGER NOT NULL DEFAULT 0,
        blocked_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        metadata TEXT
      )
    `)
    db.run(`
      CREATE TABLE IF NOT EXISTS evidence_records (
        id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL,
        task_id TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
        session_id TEXT,
        claim TEXT NOT NULL,
        evidence_type TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'observed'
          CHECK(status IN ('observed','verified','failed','unknown')),
        confidence REAL NOT NULL DEFAULT 0.5,
        details TEXT,
        created_at INTEGER NOT NULL,
        verified_at INTEGER
      )
    `)
    db.run(`
      CREATE TABLE IF NOT EXISTS failure_memory (
        id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL,
        task_id TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
        session_id TEXT,
        hypothesis TEXT NOT NULL,
        action TEXT NOT NULL,
        failure TEXT NOT NULL,
        root_cause TEXT,
        resolution TEXT,
        do_not_repeat TEXT,
        signature TEXT,
        status TEXT NOT NULL DEFAULT 'open'
          CHECK(status IN ('open','resolved','dismissed')),
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        metadata TEXT
      )
    `)
    db.run(`
      CREATE TABLE IF NOT EXISTS change_contracts (
        id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL,
        task_id TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
        session_id TEXT,
        goal TEXT NOT NULL,
        allowed_paths TEXT NOT NULL DEFAULT '[]',
        forbidden_paths TEXT NOT NULL DEFAULT '[]',
        planned_paths TEXT NOT NULL DEFAULT '[]',
        verification_plan TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active','passed','violated','closed')),
        violations TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    db.run(`
      CREATE TABLE IF NOT EXISTS contradiction_records (
        id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL,
        task_id TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
        claim_a TEXT NOT NULL,
        source_a TEXT NOT NULL,
        claim_b TEXT NOT NULL,
        source_b TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'medium'
          CHECK(severity IN ('low','medium','high','critical')),
        status TEXT NOT NULL DEFAULT 'open'
          CHECK(status IN ('open','resolved','accepted')),
        resolution TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      )
    `)
    db.run(`
      CREATE TABLE IF NOT EXISTS provenance_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_root TEXT NOT NULL,
        session_id TEXT,
        source_type TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        trust_level TEXT NOT NULL,
        flags TEXT NOT NULL DEFAULT '[]',
        snippet TEXT,
        created_at INTEGER NOT NULL
      )
    `)
    db.run(`
      CREATE TABLE IF NOT EXISTS agent_handoffs (
        id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL,
        task_id TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
        session_id TEXT,
        summary TEXT NOT NULL,
        next_action TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'open'
          CHECK(status IN ('open','claimed','completed')),
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      )
    `)

    const indexes = [
      "CREATE INDEX IF NOT EXISTS idx_agent_tasks_project_status ON agent_tasks(project_root, status, updated_at)",
      "CREATE INDEX IF NOT EXISTS idx_task_steps_task ON task_steps(task_id, position)",
      "CREATE INDEX IF NOT EXISTS idx_evidence_project_task ON evidence_records(project_root, task_id, created_at)",
      "CREATE INDEX IF NOT EXISTS idx_failure_project_status ON failure_memory(project_root, status, created_at)",
      "CREATE INDEX IF NOT EXISTS idx_contract_project_status ON change_contracts(project_root, status, updated_at)",
      "CREATE INDEX IF NOT EXISTS idx_contradiction_project_status ON contradiction_records(project_root, status, created_at)",
      "CREATE INDEX IF NOT EXISTS idx_provenance_project_time ON provenance_events(project_root, created_at)",
      "CREATE INDEX IF NOT EXISTS idx_handoffs_project_status ON agent_handoffs(project_root, status, created_at)",
    ]
    for (const sql of indexes) db.run(sql)

    db.prepare(
      `INSERT INTO schema_version (version, applied_at, description)
       VALUES (?1, ?2, ?3)`,
    ).run(6, now, "Add agent-native task, evidence, failure, contract and provenance memory")
  })()
}

export default migrateV006AgentNative
