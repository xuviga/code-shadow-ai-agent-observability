// =============================================================================
// Code Shadow — Migration 013: change passports and file claims
// =============================================================================
// `change_passports` stores a machine-verifiable passport for a single agent
// change: intent, touched files, findings, checks, evidence ids and a hash
// chain (hash/prev_hash) so passports can be audited in order.
//
// `file_claims` is the coordination primitive for multi-agent work: an agent
// claims a file for a limited time, other sessions see the conflict, and the
// partial unique index guarantees at most one active claim per file.
// =============================================================================

import type { Database } from "bun:sqlite"

export function migrateV013ChangePassports(db: Database): void {
  const now = Date.now()

  db.transaction(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS change_passports (
        id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL,
        session_id TEXT,
        task_id TEXT,
        contract_id TEXT,
        intent TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('draft','sealed','blocked','superseded')),
        risk_score REAL DEFAULT 0,
        risk_level TEXT,
        files TEXT,
        evidence_ids TEXT,
        checks TEXT,
        findings TEXT,
        budget_tokens INTEGER,
        tokens_used INTEGER DEFAULT 0,
        allow_destructive INTEGER DEFAULT 0,
        agent TEXT,
        model TEXT,
        base_ref TEXT,
        rollback_plan TEXT,
        review_md TEXT,
        hash TEXT,
        prev_hash TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        sealed_at INTEGER
      )
    `)

    db.run(`CREATE INDEX IF NOT EXISTS idx_change_passports_project_created
      ON change_passports(project_root, created_at)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_change_passports_project_task_created
      ON change_passports(project_root, task_id, created_at)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_change_passports_session_created
      ON change_passports(session_id, created_at)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_change_passports_status
      ON change_passports(status)`)

    db.run(`
      CREATE TABLE IF NOT EXISTS file_claims (
        id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL,
        file_path TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent TEXT,
        status TEXT NOT NULL CHECK(status IN ('active','released','expired')),
        note TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        released_at INTEGER
      )
    `)

    db.run(`CREATE INDEX IF NOT EXISTS idx_file_claims_project_file
      ON file_claims(project_root, file_path)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_file_claims_project_status
      ON file_claims(project_root, status)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_file_claims_session_status
      ON file_claims(session_id, status)`)
    // At most one live claim per file; released/expired history stays.
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_file_claims_active
      ON file_claims(project_root, file_path) WHERE status = 'active'`)

    db.prepare(
      `INSERT INTO schema_version (version, applied_at, description) VALUES (?1, ?2, ?3)`,
    ).run(
      13,
      now,
      "Add change passports with hash chain and file claims for agent coordination",
    )
  })()
}

export default migrateV013ChangePassports
