// =============================================================================
// Code Shadow — Migration 015: passport attestation columns
// =============================================================================
// A sealed passport can now carry a DSSE envelope (in-toto Statement + Ed25519
// signature). The envelope is self-contained: the public key travels with it,
// so a reviewer can verify the change without access to this database.
// =============================================================================

import type { Database } from "bun:sqlite"

const COLUMNS: Array<{ name: string; definition: string }> = [
  { name: "attestation", definition: "TEXT" },
  { name: "key_id", definition: "TEXT" },
  { name: "signature", definition: "TEXT" },
  { name: "public_key", definition: "TEXT" },
  { name: "statement_digest", definition: "TEXT" },
  { name: "signed_at", definition: "INTEGER" },
]

export function migrateV015Attestation(db: Database): void {
  const now = Date.now()

  db.transaction(() => {
    const existing = new Set(
      (db.prepare("PRAGMA table_info(change_passports)").all() as Array<{ name: string }>)
        .map((column) => column.name),
    )
    for (const column of COLUMNS) {
      if (existing.has(column.name)) continue
      db.run(`ALTER TABLE change_passports ADD COLUMN ${column.name} ${column.definition}`)
    }

    db.prepare(
      `INSERT INTO schema_version (version, applied_at, description) VALUES (?1, ?2, ?3)`,
    ).run(
      15,
      now,
      "Add DSSE/in-toto attestation fields to change passports",
    )
  })()
}

export default migrateV015Attestation
