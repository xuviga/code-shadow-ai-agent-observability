// Code Shadow installation doctor.
//
// Read-only checks for the local OpenCode setup. Prints one PASS/WARN/FAIL line
// per check and exits non-zero only when at least one FAIL is reported.
// No dependencies: the DB is opened read-only through node:sqlite when the
// running Node version provides it.

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgDir = join(__dirname, "..")
const configDir = join(homedir(), ".config", "opencode")
const dbPath = join(configDir, "shadow", "data.db")

const TUI_ENTRY = "./plugins/code-shadow/tui-v2.ts"
const LEGACY_TUI_ENTRY = "./plugins/code-shadow/tui-plugin.tsx"
const START_MARKER = "<!-- CODE_SHADOW_START -->"
const END_MARKER = "<!-- CODE_SHADOW_END -->"
const REQUIRED_EXPORTS = [".", "./v1", "./v2", "./tui", "./tui-v1"]
const MUTATING_TOOLS = new Set([
  "edit",
  "write",
  "patch",
  "apply_patch",
  "multi_edit",
  "multiedit",
  "str_replace",
  "create_file",
])

let passed = 0
let warnings = 0
let failed = 0

function pass(message) {
  passed += 1
  console.log(`PASS  ${message}`)
}

function warn(message) {
  warnings += 1
  console.log(`WARN  ${message}`)
}

function fail(message) {
  failed += 1
  console.log(`FAIL  ${message}`)
}

function displayPath(filePath) {
  const home = homedir()
  if (filePath === home) return "~"
  if (filePath.startsWith(home)) {
    return `~${filePath.slice(home.length).replaceAll("\\", "/")}`
  }
  return filePath
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

console.log(`Code Shadow doctor (${displayPath(configDir)})`)
console.log("")

// ---------------------------------------------------------------------------
// package.json contract
// ---------------------------------------------------------------------------
let pkg = null
try {
  pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"))
} catch (error) {
  fail(`package.json is unreadable: ${error instanceof Error ? error.message : String(error)}`)
}

if (pkg !== null) {
  const exportsField = pkg.exports && typeof pkg.exports === "object" ? pkg.exports : {}
  const missingExports = REQUIRED_EXPORTS.filter((entry) => !hasOwn(exportsField, entry))
  if (missingExports.length === 0) {
    pass(`package.json exports include ${REQUIRED_EXPORTS.join(" ")}`)
  } else {
    fail(`package.json exports missing: ${missingExports.join(", ")}`)
  }

  if (pkg.main === "src/index.ts") {
    pass('package.json main is "src/index.ts"')
  } else {
    fail(`package.json main is ${JSON.stringify(pkg.main)}, expected "src/index.ts"`)
  }
}

// ---------------------------------------------------------------------------
// Instruction files written by the plugin
// ---------------------------------------------------------------------------
for (const name of ["AGENTS.md", "CRUSH.md"]) {
  const file = join(configDir, name)
  if (!existsSync(file)) {
    warn(`${name} not found at ${displayPath(file)} (plugin has not written its rules yet)`)
    continue
  }

  let text
  try {
    text = readFileSync(file, "utf-8")
  } catch (error) {
    fail(`${name} is unreadable: ${error instanceof Error ? error.message : String(error)}`)
    continue
  }

  const starts = countOccurrences(text, START_MARKER)
  const ends = countOccurrences(text, END_MARKER)
  if (starts === 1 && ends === 1) {
    pass(`${name} has exactly one Code Shadow marker block`)
  } else {
    fail(
      `${name} marker counts are wrong: START=${starts}, END=${ends} (expected 1 and 1)`,
    )
  }
}

// ---------------------------------------------------------------------------
// TUI configuration and installed adapter
// ---------------------------------------------------------------------------
const tuiConfig = join(configDir, "tui.json")
if (!existsSync(tuiConfig)) {
  warn(`${displayPath(tuiConfig)} not found (TUI panel is not configured)`)
} else {
  let tui = null
  try {
    tui = JSON.parse(readFileSync(tuiConfig, "utf-8"))
  } catch (error) {
    fail(
      `${displayPath(tuiConfig)} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  if (tui !== null) {
    const plugins = Array.isArray(tui.plugin) ? tui.plugin : []
    const v2Entries = plugins.filter((entry) => entry === TUI_ENTRY).length
    const legacyEntries = plugins.filter((entry) => entry === LEGACY_TUI_ENTRY).length

    if (v2Entries === 1 && legacyEntries === 0) {
      pass(`tui.json has exactly one "${TUI_ENTRY}" entry and no legacy V1 entry`)
    } else {
      fail(
        `tui.json must have exactly one "${TUI_ENTRY}" and no "${LEGACY_TUI_ENTRY}" ` +
          `(found V2=${v2Entries}, legacy=${legacyEntries})`,
      )
    }
  }
}

const installedTui = join(configDir, "plugins", "code-shadow", "tui-v2.ts")
if (existsSync(installedTui)) {
  pass(`installed TUI adapter exists at ${displayPath(installedTui)}`)
} else {
  warn(
    `installed TUI adapter missing at ${displayPath(installedTui)} ` +
      "(run npm install or copy src/tui-v2.ts via scripts/postinstall.js)",
  )
}

// ---------------------------------------------------------------------------
// Shadow database (read-only)
// ---------------------------------------------------------------------------
async function checkDatabase() {
  if (!existsSync(dbPath)) {
    warn(
      `${displayPath(dbPath)} not found (the plugin has not run yet, so DB checks were skipped)`,
    )
    return
  }

  let sqlite
  try {
    sqlite = await import("node:sqlite")
  } catch (error) {
    warn(
      "DB checks skipped: node:sqlite is unavailable " +
        `(${error instanceof Error ? error.message : String(error)}); Node >= 22.5 is required`,
    )
    return
  }

  // Node exposes DatabaseSync; keep Database as a forward-compatible alias.
  const DatabaseCtor = sqlite.DatabaseSync ?? sqlite.Database
  if (typeof DatabaseCtor !== "function") {
    warn("DB checks skipped: node:sqlite does not export DatabaseSync")
    return
  }

  let db = null
  try {
    db = new DatabaseCtor(dbPath, { readOnly: true })
  } catch (error) {
    fail(
      `cannot open ${displayPath(dbPath)} read-only: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return
  }

  const one = (sql, params = []) => db.prepare(sql).get(...params)
  const count = (sql, params = []) => Number(one(sql, params)?.n ?? 0)
  const since = Date.now() - 24 * 60 * 60 * 1000

  try {
    let schemaVersion = null
    let schemaChecked = false
    try {
      schemaVersion = one("SELECT MAX(version) AS version FROM schema_version")?.version ?? null
      schemaChecked = true
    } catch (error) {
      fail(
        `schema_version check failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    if (schemaChecked) {
      if (Number.isInteger(schemaVersion) && schemaVersion >= 15) {
        pass(`shadow DB schema version is ${schemaVersion} (expected >= 15)`)
      } else {
        fail(`shadow DB schema version is ${schemaVersion ?? "missing"}, expected >= 15`)
      }
    }

    const eventCount = (eventType) => {
      try {
        return count(
          "SELECT COUNT(*) AS n FROM developer_events WHERE event_type = ? AND timestamp >= ?",
          [eventType, since],
        )
      } catch (error) {
        fail(
          `${eventType} count failed: ${error instanceof Error ? error.message : String(error)}`,
        )
        return null
      }
    }
    const tableCount = (table) => {
      try {
        return count(`SELECT COUNT(*) AS n FROM ${table} WHERE timestamp >= ?`, [since])
      } catch (error) {
        fail(`${table} count failed: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    }

    const turnCompleted = eventCount("turn_completed")
    const toolWarning = eventCount("tool_warning")
    const toolRejected = eventCount("tool_rejected")
    const blockingRejected = (() => {
      try {
        return count(
          `SELECT COUNT(*) AS n FROM developer_events
           WHERE timestamp >= ? AND event_type = 'tool_rejected'
             AND (COALESCE(json_extract(metadata, '$.blocking'), 0) = 1
               OR json_extract(metadata, '$.reason') IN ('successful_edit_loop_blocked','change_contract_permission_denied'))`,
          [since],
        )
      } catch (error) {
        fail(`blocking tool_rejected count failed: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    })()
    const legacyGuardWarnings = (() => {
      try {
        return count(
          `SELECT COUNT(*) AS n FROM developer_events
           WHERE timestamp >= ? AND event_type = 'tool_rejected'
             AND json_extract(metadata, '$.reason') = 'successful_edit_loop_warning'`,
          [since],
        )
      } catch {
        return null
      }
    })()
    const fileEdits = tableCount("file_edits")
    const toolExecutions = tableCount("tool_executions")

    try {
      const untrusted = count(
        "SELECT COUNT(*) AS n FROM tool_trust WHERE status IN ('changed','suspicious')",
      )
      const pinned = count("SELECT COUNT(*) AS n FROM tool_trust")
      if (untrusted > 0) {
        warn(`${untrusted} tool(s) changed/suspicious after pinning (of ${pinned} pinned)`)
      } else {
        pass(`${pinned} tool fingerprints pinned, no rug-pull signals`)
      }
    } catch (error) {
      fail(`tool_trust check failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    try {
      const sealed = count(
        "SELECT COUNT(*) AS n FROM change_passports WHERE status = 'sealed'",
      )
      const signed = count(
        "SELECT COUNT(*) AS n FROM change_passports WHERE status = 'sealed' AND attestation IS NOT NULL",
      )
      const keyPath = join(dirname(dbPath), "keys", "passport-signing-key.pem")
      const keyExists = existsSync(keyPath)
      if (sealed > 0 && signed < sealed) {
        warn(`${sealed - signed} sealed passport(s) without an attestation (of ${sealed})`)
      } else {
        pass(`${signed}/${sealed} sealed passport(s) signed, key ${keyExists ? "present" : "missing"}`)
      }
    } catch (error) {
      fail(`passport attestation check failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    try {
      const staleClaims = count(
        `SELECT COUNT(*) AS n FROM file_claims
         WHERE status = 'active' AND expires_at <= ?`,
        [Date.now()],
      )
      const activeClaims = count("SELECT COUNT(*) AS n FROM file_claims WHERE status = 'active'")
      if (staleClaims > 0) {
        warn(`${staleClaims} expired file claim(s) still active (of ${activeClaims})`)
      } else {
        pass(`${activeClaims} active file claim(s), none expired`)
      }
    } catch (error) {
      fail(`file_claims check failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (
      turnCompleted !== null &&
      toolWarning !== null &&
      toolRejected !== null &&
      fileEdits !== null &&
      toolExecutions !== null
    ) {
      pass(
        `last 24h: turn_completed=${turnCompleted} tool_warning=${toolWarning} ` +
          `tool_rejected=${toolRejected} blocking_rejected=${blockingRejected} ` +
          `legacy_guard_warnings=${legacyGuardWarnings} ` +
          `file_edits=${fileEdits} tool_executions=${toolExecutions}`,
      )
    }

    if (fileEdits !== null) {
      let mutatingCalls = null
      try {
        const placeholders = [...MUTATING_TOOLS].map(() => "?").join(", ")
        mutatingCalls = count(
          `SELECT COUNT(*) AS n FROM tool_executions
           WHERE timestamp >= ? AND lower(tool_name) IN (${placeholders})`,
          [since, ...MUTATING_TOOLS],
        )
      } catch (error) {
        fail(
          `mutating tool call count failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }

      if (mutatingCalls !== null && mutatingCalls > 0 && fileEdits === 0) {
        warn(
          `V2 telemetry symptom: ${mutatingCalls} mutating tool call(s) in the last 24h ` +
            "but zero file_edits (check the V2 event translation and code-shadow-v2.log)",
        )
      }
    }
  } finally {
    try {
      db.close()
    } catch {
      // A failed close must not mask the check results.
    }
  }
}

await checkDatabase()

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log("")
console.log(
  `Summary: ${passed} passed, ${warnings} warning(s), ${failed} failed`,
)

if (failed > 0) {
  process.exitCode = 1
}
