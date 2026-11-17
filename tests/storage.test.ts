import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StorageEngine } from "../src/storage"
import { migrateV010KnowledgeNodeNaturalKey } from "../src/migrations/010_knowledge_node_natural_key"
import { AgentType, EditType, ErrorType, EvidenceStatus, NodeType, SessionStatus, TaskStatus, TaskStepStatus, ToolStatus } from "../src/types"

const databases: Array<{ storage: StorageEngine; directory: string }> = []

function createStorage(): StorageEngine {
  const directory = mkdtempSync(join(tmpdir(), "code-shadow-storage-"))
  const storage = new StorageEngine({
    dbPath: join(directory, "data.db"),
    retentionDays: 90,
    sessionRetentionDays: 365,
    batchSize: 10,
    flushIntervalMs: 5000,
    riskWarningThreshold: 0.6,
    riskErrorThreshold: 0.8,
    analyticsRecomputeIntervalMs: 3600000,
    maxDiffPreviewChars: 500,
    maxArgsPreviewChars: 200,
    disabledEventTypes: [],
    secretPatterns: [],
  })
  databases.push({ storage, directory })
  return storage
}

afterEach(() => {
  while (databases.length > 0) {
    const item = databases.pop()!
    item.storage.close()
    // Bun/SQLite can keep the WAL handle briefly on Windows after close().
    // The directory is isolated under the OS temp folder, so a locked cleanup
    // must not turn a passing storage test into a false failure.
    try {
      rmSync(item.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
    } catch {
      // Best-effort cleanup; the OS will reclaim the temporary directory.
    }
  }
})

describe("StorageEngine", () => {
  test("applies all migrations, including todos", () => {
    const storage = createStorage()
    const db = storage.getDb()
    const version = db.prepare("SELECT MAX(version) AS version FROM schema_version").get() as { version: number }
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'todos'").get()
    const errorFileIndex = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_errors_file'").get()

    expect(version.version).toBe(15)
    expect(table).toBeTruthy()
    expect(errorFileIndex).toBeTruthy()
    const uniqueEdgeIndex = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_ke_unique'").get()
    expect(uniqueEdgeIndex).toBeTruthy()
    for (const name of ["agent_tasks", "task_steps", "evidence_records", "failure_memory", "change_contracts", "contradiction_records", "provenance_events", "agent_handoffs", "change_passports", "file_claims", "tool_trust"]) {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1").get(name)).toBeTruthy()
    }
    const activeClaimIndex = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_file_claims_active'").get()
    expect(activeClaimIndex).toBeTruthy()
    const toolTrustStatusIndex = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_tool_trust_project_status'").get()
    const toolTrustToolIndex = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_tool_trust_tool'").get()
    expect(toolTrustStatusIndex).toBeTruthy()
    expect(toolTrustToolIndex).toBeTruthy()
    const knColumns = db.prepare(`PRAGMA table_info("knowledge_nodes")`).all() as Array<{ name: string }>
    const decisionColumns = db.prepare(`PRAGMA table_info("decisions")`).all() as Array<{ name: string }>
    expect(knColumns.some((column) => column.name === "project_root")).toBe(true)
    expect(decisionColumns.some((column) => column.name === "project_root")).toBe(true)
  })

  test("stores explore sessions and errors with the real session id", () => {
    const storage = createStorage()
    const sessionId = "session-storage-test"

    storage.insertSession({
      id: sessionId,
      agentType: AgentType.Explore,
      status: SessionStatus.Active,
      startedAt: Date.now(),
      endedAt: null,
      durationMs: null,
      filesChangedCount: 0,
      toolsUsedCount: 0,
      errorsCount: 0,
      projectRoot: "C:/project",
      messageCount: 0,
      totalTokensUsed: 0,
      compactedFrom: null,
    } as never)

    const errorId = storage.recordError({
      sessionId,
      errorType: "lsp",
      errorMessage: "Type error",
      contextFile: "src/index.ts",
    })

    expect(errorId).toBeGreaterThan(0)
    expect(storage.getErrorsForFile("src/index.ts")).toHaveLength(1)
  })

  test("searches knowledge metadata, not only the short node name", () => {
    const storage = createStorage()
    storage.upsertNode({
      nodeType: "concept" as never,
      name: "TypeScript project",
      path: null,
      metadata: { content: "The project uses Bun and SQLite" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })

    expect(storage.searchNodes("SQLite")).toHaveLength(1)
  })

  test("uses FTS5 ranking with LIKE fallback and trigger synchronization", () => {
    const storage = createStorage()
    const root = "C:/project-fts"
    const upsert = (name: string, content: string, projectRoot = root) => storage.upsertNode({
      nodeType: "concept" as never,
      name,
      path: null,
      projectRoot,
      metadata: { content },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never)

    upsert("Storage engine", "Uses bun:sqlite and WAL")
    upsert("Auth flow", "JWT refresh rotation")

    expect(storage.searchNodes("sqlite", 10, root)).toHaveLength(1)
    expect(storage.searchNodes("sto", 10, root)[0]?.name).toBe("Storage engine")
    expect(storage.searchNodes("qli", 10, root)).toHaveLength(1)
    expect(storage.searchNodes("C++ / node.js", 10, root)).toEqual([])
    expect(storage.searchNodes("sqlite", 10, "C:/project-other")).toEqual([])

    upsert("Storage engine", "Uses postgres now")
    expect(storage.searchNodes("sqlite", 10, root)).toEqual([])
    expect(storage.searchNodes("postgres", 10, root)).toHaveLength(1)

    storage.getDb().prepare("DELETE FROM knowledge_nodes WHERE name = 'Auth flow'").run()
    expect(storage.searchNodes("refresh", 10, root)).toEqual([])
  })

  test("isolates a failed batch row without blocking the queue", () => {
    const storage = createStorage()
    storage.enqueue("developer_events", {
      event_type: "not-a-real-event",
      session_id: null,
      file_path: null,
      metadata: null,
      timestamp: Date.now(),
    })
    storage.enqueue("developer_events", {
      event_type: "command_used",
      session_id: null,
      file_path: null,
      metadata: JSON.stringify({ command: "bun test" }),
      timestamp: Date.now(),
    })

    storage.flushBatch()

    expect(storage.batchQueue).toHaveLength(0)
    expect(storage.getDevEvents("command_used")).toHaveLength(1)
  })

  test("persists the agent operating loop", () => {
    const storage = createStorage()
    const task = storage.createTask({
      projectRoot: "C:/project", sessionId: null, title: "Repair observer",
      goal: "Make event tracking verifiable", status: "active" as never,
      priority: 10, metadata: { source: "test" },
    })
    const step = storage.addTaskStep({
      taskId: task.id, title: "Run tests", status: "pending" as never,
      position: 0, blockedBy: null, metadata: null,
    })
    storage.updateTaskStep(step.id, "completed")
    const evidence = storage.recordEvidence({
      projectRoot: "C:/project", taskId: task.id, sessionId: null,
      claim: "Tests pass", evidenceType: "test", source: "bun test",
      status: "observed" as never, confidence: 0.8, details: null,
    })
    storage.updateEvidence(evidence.id, "verified")
    const failure = storage.recordFailure({
      projectRoot: "C:/project", taskId: task.id, sessionId: null,
      hypothesis: "The hook is not registered", action: "inspect plugin",
      failure: "The global plugin was stale", rootCause: "old install",
      resolution: null, doNotRepeat: "reinstall after build", signature: "stale-plugin", metadata: null,
    })
    storage.resolveFailure(failure.id, "Synchronized the global plugin")
    const contract = storage.createChangeContract({
      projectRoot: "C:/project", taskId: task.id, sessionId: null,
      goal: "Only modify source", allowedPaths: ["src/"], forbiddenPaths: [".env"],
      plannedPaths: ["src/index.ts"], verificationPlan: ["bun test"],
    })
    const check = storage.checkChangeContract(contract.id, ["src/index.ts", ".env"])

    expect(storage.getTask(task.id)?.title).toBe("Repair observer")
    expect(storage.getTaskStep(step.id)?.status).toBe(TaskStepStatus.Completed)
    expect(storage.getEvidence(evidence.id)?.status).toBe(EvidenceStatus.Verified)
    expect(storage.getFailure(failure.id)?.status).toBe("resolved")
    expect(check.allowed).toBe(false)
    expect(check.violations).toEqual([".env"])

    const handoff = storage.createHandoff({
      projectRoot: "C:/project", taskId: task.id, sessionId: null,
      summary: "Core loop is persisted", nextAction: "Run integration smoke",
      payload: { task: task.id },
    })
    expect(storage.getHandoff(handoff.id)?.nextAction).toBe("Run integration smoke")
    expect(storage.updateHandoff(handoff.id, "completed")?.status).toBe("completed")
  })

  test("enforces Definition of Done before task completion", () => {
    const storage = createStorage()
    const task = storage.createTask({
      projectRoot: "C:/project", sessionId: null, title: "Complete safely",
      goal: "Finish with evidence", status: "active" as never, priority: 50, metadata: null,
    })
    const step = storage.addTaskStep({ taskId: task.id, title: "Verify", status: "pending" as never, position: 0, blockedBy: null, metadata: null })
    expect(storage.evaluateTaskDone(task.id).ready).toBe(false)
    expect(storage.evaluateTaskDone(task.id).blockers).toContain("pending_steps:1")
    storage.updateTaskStep(step.id, "completed")
    storage.recordEvidence({ projectRoot: "C:/project", taskId: task.id, sessionId: null, claim: "Verification passed", evidenceType: "test", source: "bun test", status: "verified" as never, confidence: 1, details: null })
    expect(storage.evaluateTaskDone(task.id).ready).toBe(true)
  })

  test("scopes co-changed files to the requested project", () => {
    const storage = createStorage()
    const now = Date.now()
    const edit = (projectRoot: string, filePath: string, sessionId: string) => storage.insertFileEdit({
      filePath, sessionId, agentType: AgentType.Build, editType: EditType.Update,
      diffPreview: null, linesAdded: 1, linesRemoved: 0, timestamp: now,
      projectRoot, wasReverted: false, fileLanguage: "ts", diffHash: null,
    } as never)

    edit("C:/project-a", "src/index.ts", "session-a")
    edit("C:/project-a", "src/auth.ts", "session-a")
    edit("C:/project-b", "src/index.ts", "session-b")
    edit("C:/project-b", "src/other.ts", "session-b")

    expect(storage.getCoChangedFiles("src/index.ts", 1, "C:/project-a")).toEqual([
      { file: "src/auth.ts", frequency: 1 },
    ])
  })

  test("scopes analytics aggregates and errors by project root", () => {
    const storage = createStorage()
    const now = Date.now()
    const edit = (projectRoot: string, filePath: string, sessionId: string) => storage.insertFileEdit({
      filePath, sessionId, agentType: AgentType.Build, editType: EditType.Update,
      diffPreview: null, linesAdded: 1, linesRemoved: 0, timestamp: now,
      projectRoot, wasReverted: false, fileLanguage: "ts", diffHash: null,
    } as never)
    const session = (id: string, projectRoot: string) => storage.insertSession({
      id, agentType: AgentType.Build, status: SessionStatus.Idle,
      startedAt: now, endedAt: now + 1000, durationMs: 1000,
      filesChangedCount: 0, toolsUsedCount: 0, errorsCount: 0,
      projectRoot, messageCount: 0, totalTokensUsed: 0, compactedFrom: null,
    } as never)

    session("session-a", "C:/project-a")
    session("session-b", "C:/project-b")
    edit("C:/project-a", "src/a.ts", "session-a")
    edit("C:/project-a", "src/a.ts", "session-a")
    edit("C:/project-b", "src/b.ts", "session-b")
    storage.insertError({
      sessionId: "session-a", errorType: ErrorType.Unknown, errorStack: null, errorMessage: "A error",
      contextFile: "src/a.ts", contextTool: null, timestamp: now, resolved: false,
    })
    storage.insertError({
      sessionId: "session-b", errorType: ErrorType.Unknown, errorStack: null, errorMessage: "B error",
      contextFile: "src/b.ts", contextTool: null, timestamp: now, resolved: false,
    })

    expect(storage.getEditTotals("30d", "C:/project-a")).toEqual({ edits: 2, aiEdits: 2, files: 1 })
    expect(storage.getDistinctFiles("30d", "C:/project-a")).toEqual(["src/a.ts"])
    expect(storage.getSessionCount("30d", "C:/project-a")).toBe(1)
    expect(storage.getHotspotMetrics("30d", "C:/project-a").map((metric) => metric.filePath)).toEqual(["src/a.ts"])
    expect(storage.getTopFilesByEdits("30d", 10, "C:/project-a")).toEqual([{ filePath: "src/a.ts", edits: 2 }])
    expect(storage.getFileEditCount("src/a.ts", "30d", "C:/project-b")).toBe(0)
    expect(storage.getErrorsForFile("src/b.ts", "30d", "C:/project-a")).toEqual([])
    expect([...storage.getErrorCountsByFile("30d", "C:/project-a").keys()]).toEqual(["src/a.ts"])
    expect(storage.getErrorTotalForEditedFiles("30d", "C:/project-a")).toBe(1)
    expect(storage.getHistoricalBreakageRate("src/b.ts", "30d", "C:/project-a")).toBe(0)
    expect(storage.getToolUsageCounts("30d", "C:/project-a")).toEqual({})
    expect(storage.getFileEdits("src/a.ts", "30d", "C:/project-a", 1)).toHaveLength(1)
  })

  test("migration 010 merges duplicate knowledge nodes and enforces natural keys", () => {
    const storage = createStorage()
    const db = storage.getDb()

    // Simulate a pre-010 database with duplicates.
    db.run("DROP INDEX IF EXISTS idx_kn_natural_key")
    db.prepare("DELETE FROM schema_version WHERE version = 10").run()

    const insertNode = (nodeType: string, name: string, path: string | null, projectRoot: string | null): number =>
      Number(db.prepare(
        `INSERT INTO knowledge_nodes (node_type, name, path, metadata, created_at, updated_at, project_root)
         VALUES (?1, ?2, ?3, NULL, 1, 1, ?4)`,
      ).run(nodeType, name, path, projectRoot).lastInsertRowid)
    const insertEdge = (source: number, target: number, type: string): void => {
      db.prepare(
        `INSERT INTO knowledge_edges (source_id, target_id, edge_type, weight, evidence_count, first_seen, last_seen)
         VALUES (?1, ?2, ?3, 1, 1, 1, 1)`,
      ).run(source, target, type)
    }

    const keep = insertNode("concept", "Dup", null, "C:/project-a")
    const loser = insertNode("concept", "Dup", null, "C:/project-a")
    const other = insertNode("concept", "Other", null, "C:/project-a")
    insertNode("concept", "Dup", null, "C:/project-b")
    insertNode("file", "index.ts", "src/a.ts", "C:/project-a")
    insertNode("file", "index.ts", "src/b.ts", "C:/project-a")

    insertEdge(loser, other, "references")
    insertEdge(keep, other, "references")
    insertEdge(loser, keep, "references")

    migrateV010KnowledgeNodeNaturalKey(db)

    const dupCount = db.prepare(
      "SELECT COUNT(*) AS cnt FROM knowledge_nodes WHERE node_type = 'concept' AND name = 'Dup' AND project_root = 'C:/project-a'",
    ).get() as { cnt: number }
    expect(dupCount.cnt).toBe(1)

    const crossProject = db.prepare(
      "SELECT COUNT(*) AS cnt FROM knowledge_nodes WHERE node_type = 'concept' AND name = 'Dup' AND project_root = 'C:/project-b'",
    ).get() as { cnt: number }
    expect(crossProject.cnt).toBe(1)

    const sameNameFiles = db.prepare(
      "SELECT COUNT(*) AS cnt FROM knowledge_nodes WHERE node_type = 'file' AND name = 'index.ts'",
    ).get() as { cnt: number }
    expect(sameNameFiles.cnt).toBe(2)

    const edges = db.prepare(
      "SELECT COUNT(*) AS cnt FROM knowledge_edges WHERE source_id = ?1 AND target_id = ?2 AND edge_type = 'references'",
    ).get(keep, other) as { cnt: number }
    expect(edges.cnt).toBe(1)
    expect((db.prepare("SELECT COUNT(*) AS cnt FROM knowledge_edges WHERE source_id = target_id").get() as { cnt: number }).cnt).toBe(0)

    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_kn_natural_key'").get()).toBeTruthy()
    expect(() => insertNode("concept", "Dup", null, "C:/project-a")).toThrow()

    storage.upsertNode({
      nodeType: "concept" as never, name: "Limit-1", path: null, projectRoot: "C:/project-a",
      metadata: null, createdAt: Date.now(), updatedAt: Date.now(),
    } as never)
    storage.upsertNode({
      nodeType: "concept" as never, name: "Limit-2", path: null, projectRoot: "C:/project-a",
      metadata: null, createdAt: Date.now(), updatedAt: Date.now(),
    } as never)
    expect(storage.getNodesByType("concept", "C:/project-a", 2)).toHaveLength(2)
  })

  test("retention removes only terminal agent-native records", () => {
    const storage = createStorage()
    const root = "C:/project"
    const old = Date.now() - 400 * 24 * 60 * 60 * 1000

    const completedTask = storage.createTask({
      projectRoot: root, sessionId: null, title: "Done", goal: "done",
      status: "completed" as never, priority: 50, metadata: null,
    } as never)
    const activeTask = storage.createTask({
      projectRoot: root, sessionId: null, title: "Active", goal: "active",
      status: "active" as never, priority: 50, metadata: null,
    } as never)
    const step = storage.addTaskStep({
      taskId: completedTask.id, title: "step", status: "completed",
      position: 0, blockedBy: null, metadata: null,
    } as never)
    const evidence = storage.recordEvidence({
      projectRoot: root, taskId: completedTask.id, sessionId: null, claim: "verified",
      evidenceType: "test", source: "bun test", status: "verified", confidence: 1, details: null,
    } as never)
    const openFailure = storage.recordFailure({
      projectRoot: root, taskId: activeTask.id, sessionId: null, hypothesis: "h",
      action: "a", failure: "open", rootCause: null, resolution: null,
      doNotRepeat: null, signature: null, metadata: null,
    } as never)
    const resolvedFailure = storage.recordFailure({
      projectRoot: root, taskId: completedTask.id, sessionId: null, hypothesis: "h",
      action: "a", failure: "resolved", rootCause: null, resolution: null,
      doNotRepeat: null, signature: null, metadata: null, status: "resolved",
    } as never)
    const closedContract = storage.createChangeContract({
      projectRoot: root, taskId: completedTask.id, sessionId: null, goal: "closed",
      allowedPaths: [], forbiddenPaths: [], plannedPaths: [], verificationPlan: [],
      status: "closed" as never,
    } as never)
    const activeContract = storage.createChangeContract({
      projectRoot: root, taskId: activeTask.id, sessionId: null, goal: "active",
      allowedPaths: [], forbiddenPaths: [], plannedPaths: [], verificationPlan: [],
      status: "active" as never,
    } as never)
    const resolvedContradiction = storage.recordContradiction({
      projectRoot: root, taskId: completedTask.id, claimA: "a", sourceA: "s",
      claimB: "b", sourceB: "s", severity: "low", status: "resolved" as never,
    } as never)
    const completedHandoff = storage.createHandoff({
      projectRoot: root, taskId: completedTask.id, sessionId: null,
      summary: "done", nextAction: "none", payload: {}, status: "completed" as never,
    } as never)
    const openHandoff = storage.createHandoff({
      projectRoot: root, taskId: activeTask.id, sessionId: null,
      summary: "open", nextAction: "next", payload: {}, status: "open" as never,
    } as never)

    const db = storage.getDb()
    db.prepare("UPDATE agent_tasks SET updated_at = ?1 WHERE id IN (?2, ?3)").run(old, completedTask.id, activeTask.id)
    db.prepare("UPDATE evidence_records SET created_at = ?1 WHERE id = ?2").run(old, evidence.id)
    db.prepare("UPDATE failure_memory SET created_at = ?1").run(old)
    db.prepare("UPDATE change_contracts SET updated_at = ?1").run(old)
    db.prepare("UPDATE contradiction_records SET created_at = ?1").run(old)
    db.prepare("UPDATE agent_handoffs SET created_at = ?1").run(old)

    storage.runCleanup(90, 365)

    expect(storage.getTask(completedTask.id)).toBeUndefined()
    expect(storage.getTaskStep(step.id)).toBeUndefined()
    expect(storage.getEvidence(evidence.id)).toBeUndefined()
    expect(storage.getFailure(resolvedFailure.id)).toBeUndefined()
    expect(storage.getChangeContract(closedContract.id)).toBeUndefined()
    expect(storage.getContradiction(resolvedContradiction.id)).toBeUndefined()
    expect(storage.getHandoff(completedHandoff.id)).toBeUndefined()

    expect(storage.getTask(activeTask.id)).toBeDefined()
    expect(storage.getFailure(openFailure.id)).toBeDefined()
    expect(storage.getChangeContract(activeContract.id)).toBeDefined()
    expect(storage.getHandoff(openHandoff.id)).toBeDefined()
  })

  test("applies partial task patches and clears completion on reopen", () => {
    const storage = createStorage()
    const task = storage.createTask({
      projectRoot: "C:/project", sessionId: null, title: "Original", goal: "Keep goal",
      status: "active" as never, priority: 50, metadata: null,
    })

    const patched = storage.updateTask(task.id, { priority: 10 })
    expect(patched?.title).toBe("Original")
    expect(patched?.goal).toBe("Keep goal")
    expect(patched?.priority).toBe(10)
    expect(patched?.status).toBe(TaskStatus.Active)

    storage.updateTask(task.id, { status: "completed" as never })
    expect(storage.getTask(task.id)?.completedAt).toBeTruthy()
    storage.updateTask(task.id, { status: "active" as never })
    expect(storage.getTask(task.id)?.completedAt).toBeNull()
  })

  test("cleans expired idle sessions with FK children instead of rolling back", () => {
    const storage = createStorage()
    const sessionId = "expired-session"
    const startedAt = Date.now() - 400 * 24 * 60 * 60 * 1000
    storage.insertSession({
      id: sessionId, agentType: AgentType.Build, status: SessionStatus.Idle,
      startedAt, endedAt: startedAt + 1000, durationMs: 1000,
      filesChangedCount: 0, toolsUsedCount: 0, errorsCount: 1,
      projectRoot: "C:/project", messageCount: 0, totalTokensUsed: 0, compactedFrom: null,
    } as never)
    storage.insertError({ sessionId, errorType: ErrorType.Unknown, errorStack: null, errorMessage: "old error", contextFile: null, contextTool: null, timestamp: startedAt, resolved: false })
    storage.getDb().prepare(
      "INSERT INTO todos (todo_id, session_id, title, status, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?5)",
    ).run("expired-todo", sessionId, "Old todo", "pending", startedAt)

    storage.runCleanup(30, 365)

    expect(storage.getSession(sessionId)).toBeUndefined()
    const todos = storage.getDb().prepare("SELECT COUNT(*) AS cnt FROM todos WHERE session_id = ?1").get(sessionId) as { cnt: number }
    const errors = storage.getDb().prepare("SELECT COUNT(*) AS cnt FROM session_errors WHERE session_id = ?1").get(sessionId) as { cnt: number }
    expect(todos.cnt).toBe(0)
    expect(errors.cnt).toBe(0)
  })

  test("returns recent sessions without a timeframe and orders by latest edit", () => {
    const storage = createStorage()
    const now = Date.now()
    const insertSession = (id: string) => storage.insertSession({
      id, agentType: AgentType.Build, status: SessionStatus.Idle,
      startedAt: now - 10000, endedAt: now, durationMs: 10000,
      filesChangedCount: 1, toolsUsedCount: 0, errorsCount: 0,
      projectRoot: "C:/project", messageCount: 0, totalTokensUsed: 0, compactedFrom: null,
    } as never)
    const edit = (sessionId: string, timestamp: number) => storage.insertFileEdit({
      filePath: "src/recent.ts", sessionId, agentType: AgentType.Build, editType: EditType.Update,
      diffPreview: null, linesAdded: 1, linesRemoved: 0, timestamp,
      projectRoot: "C:/project", wasReverted: false, fileLanguage: "ts", diffHash: null,
    } as never)

    insertSession("older-session")
    insertSession("newer-session")
    edit("older-session", now - 5000)
    edit("newer-session", now - 1000)

    const recent = storage.getRecentSimilarChanges("src/recent.ts")
    expect(recent.map((session) => session.id)).toEqual(["newer-session", "older-session"])
  })

  test("counts co-change frequency in sessions, not edit pairs", () => {
    const storage = createStorage()
    const now = Date.now()
    const edit = (sessionId: string, filePath: string, offset: number) => storage.insertFileEdit({
      filePath, sessionId, agentType: AgentType.Build, editType: EditType.Update,
      diffPreview: null, linesAdded: 1, linesRemoved: 0, timestamp: now + offset,
      projectRoot: "C:/project", wasReverted: false, fileLanguage: "ts", diffHash: null,
    } as never)

    edit("session-a", "src/target.ts", 0)
    edit("session-a", "src/target.ts", 1)
    edit("session-a", "src/related.ts", 2)
    edit("session-a", "src/related.ts", 3)
    edit("session-a", "src/related.ts", 4)
    edit("session-b", "src/target.ts", 5)
    edit("session-b", "src/related.ts", 6)

    expect(storage.getCoChangedFiles("src/target.ts", 1, "C:/project")).toEqual([
      { file: "src/related.ts", frequency: 2 },
    ])
  })

  test("an empty contract check does not mark the contract passed", () => {
    const storage = createStorage()
    const contract = storage.createChangeContract({
      projectRoot: "C:/project", taskId: null, sessionId: null,
      goal: "Keep edits under src", allowedPaths: ["src/**"], forbiddenPaths: [],
      plannedPaths: [], verificationPlan: [],
    })
    const result = storage.checkChangeContract(contract.id, [])
    expect(result.allowed).toBe(false)
    expect(result.contract?.status).toBe("active")
  })

  test("clamps historical breakage rate to a probability", () => {
    const storage = createStorage()
    const now = Date.now()
    const insertSession = (id: string) => storage.insertSession({
      id, agentType: AgentType.Build, status: SessionStatus.Idle,
      startedAt: now - 1000, endedAt: now, durationMs: 1000,
      filesChangedCount: 0, toolsUsedCount: 0, errorsCount: 0,
      projectRoot: "C:/project", messageCount: 0, totalTokensUsed: 0, compactedFrom: null,
    } as never)
    insertSession("error-a")
    insertSession("error-b")
    insertSession("edit-only")
    storage.insertError({ sessionId: "error-a", errorType: ErrorType.Unknown, errorStack: null, errorMessage: "a", contextFile: "src/broken.ts", contextTool: null, timestamp: now, resolved: false })
    storage.insertError({ sessionId: "error-b", errorType: ErrorType.Unknown, errorStack: null, errorMessage: "b", contextFile: "src/broken.ts", contextTool: null, timestamp: now, resolved: false })
    storage.insertFileEdit({
      filePath: "src/broken.ts", sessionId: "edit-only", agentType: AgentType.Build, editType: EditType.Update,
      diffPreview: null, linesAdded: 1, linesRemoved: 0, timestamp: now,
      projectRoot: "C:/project", wasReverted: false, fileLanguage: "ts", diffHash: null,
    } as never)

    expect(storage.getHistoricalBreakageRate("src/broken.ts", "30d")).toBe(1)
  })

  test("scopes memory nodes and decisions by project while keeping global rows visible", () => {
    const storage = createStorage()
    const now = Date.now()
    storage.upsertNode({ nodeType: NodeType.Rule, name: "Rule A", path: null, metadata: { content: "A" }, createdAt: now, updatedAt: now, projectRoot: "C:/project-a" })
    storage.upsertNode({ nodeType: NodeType.Rule, name: "Rule B", path: null, metadata: { content: "B" }, createdAt: now, updatedAt: now, projectRoot: "C:/project-b" })
    storage.upsertNode({ nodeType: NodeType.Rule, name: "Rule Global", path: null, metadata: { content: "G" }, createdAt: now, updatedAt: now })

    const projectA = storage.searchNodes("Rule", 10, "C:/project-a").map((node) => node.name).sort()
    const projectB = storage.searchNodes("Rule", 10, "C:/project-b").map((node) => node.name).sort()
    expect(projectA).toEqual(["Rule A", "Rule Global"])
    expect(projectB).toEqual(["Rule B", "Rule Global"])

    storage.insertDecision({
      title: "Decision A", description: "A", context: null, alternatives: null,
      status: "accepted", decidedBy: null, decidedAt: now, supersededBy: null,
      relatedFiles: null, tags: null, projectRoot: "C:/project-a",
    })
    storage.insertDecision({
      title: "Decision B", description: "B", context: null, alternatives: null,
      status: "accepted", decidedBy: null, decidedAt: now, supersededBy: null,
      relatedFiles: null, tags: null, projectRoot: "C:/project-b",
    })
    storage.insertDecision({
      title: "Decision Global", description: "G", context: null, alternatives: null,
      status: "accepted", decidedBy: null, decidedAt: now, supersededBy: null,
      relatedFiles: null, tags: null,
    })

    const decisionsA = storage.getDecisions(undefined, 10, "C:/project-a").map((decision) => decision.title).sort()
    expect(decisionsA).toEqual(["Decision A", "Decision Global"])
  })

  test("aggregates edits and errors over the full dataset", () => {
    const storage = createStorage()
    const now = Date.now()
    const edit = (sessionId: string, filePath: string, agentType: AgentType, timestamp: number) => storage.insertFileEdit({
      filePath, sessionId, agentType, editType: EditType.Update,
      diffPreview: null, linesAdded: 1, linesRemoved: 0, timestamp,
      projectRoot: "C:/project", wasReverted: false, fileLanguage: "ts", diffHash: null,
    } as never)

    edit("s1", "z-last-alphabetically.ts", AgentType.Build, now - 1000)
    edit("s1", "z-last-alphabetically.ts", AgentType.Build, now - 900)
    edit("s2", "a-first-alphabetically.ts", AgentType.General, now - 800)

    const totals = storage.getEditTotals("30d")
    expect(totals.edits).toBe(3)
    expect(totals.aiEdits).toBe(2)
    expect(totals.files).toBe(2)
    expect(storage.getTopFilesByEdits("30d", 1)).toEqual([{ filePath: "z-last-alphabetically.ts", edits: 2 }])
  })

  test("prunes stale analytics cache rows even without a TTL", () => {
    const storage = createStorage()
    const db = storage.getDb()
    db.prepare(
      `INSERT INTO analytics_cache (cache_key, cache_data, computed_at, valid_until, computation_time_ms)
       VALUES (?1, ?2, ?3, NULL, NULL)`,
    ).run("stale-key", "{}", Date.now() - 40 * 24 * 60 * 60 * 1000)

    storage.runCleanup(30, 365)

    const row = db.prepare("SELECT COUNT(*) AS cnt FROM analytics_cache WHERE cache_key = 'stale-key'").get() as { cnt: number }
    expect(row.cnt).toBe(0)
  })

  test("insertSession is idempotent across plugin instances", () => {
    const storage = createStorage()
    const session = {
      id: "ses_duplicate",
      agentType: AgentType.Build,
      status: SessionStatus.Created,
      startedAt: Date.now(),
      endedAt: null,
      durationMs: null,
      filesChangedCount: 0,
      toolsUsedCount: 0,
      errorsCount: 0,
      projectRoot: "C:/project",
      messageCount: 0,
      totalTokensUsed: 0,
      compactedFrom: null,
    }

    expect(storage.insertSession(session)).toBe(true)
    expect(storage.insertSession(session)).toBe(false)
    expect(storage.getSession("ses_duplicate")).toBeTruthy()
  })

  test("expires abandoned auto-tasks but keeps manual tasks", () => {
    const storage = createStorage()
    const auto = storage.createTask({
      projectRoot: "C:/project", sessionId: "ses_auto", title: "Auto", goal: "Auto",
      status: TaskStatus.Active, priority: 50, metadata: { auto_created: true },
    })
    const manual = storage.createTask({
      projectRoot: "C:/project", sessionId: "ses_manual", title: "Manual", goal: "Manual",
      status: TaskStatus.Active, priority: 50, metadata: { auto_created: false },
    })
    storage.getDb().prepare("UPDATE agent_tasks SET updated_at = ?1 WHERE id IN (?2, ?3)")
      .run(Date.now() - 48 * 60 * 60 * 1000, auto.id, manual.id)

    expect(storage.expireAutoTasks(24 * 60 * 60 * 1000)).toBe(1)
    expect(storage.getTask(auto.id)?.status).toBe(TaskStatus.Cancelled)
    expect(storage.getTask(manual.id)?.status).toBe(TaskStatus.Active)
  })

  test("accepts tool_warning and turn_completed event types", () => {
    const storage = createStorage()
    const now = Date.now()
    storage.insertSession({
      id: "ses_events", agentType: AgentType.Build, status: SessionStatus.Active,
      startedAt: now, endedAt: null, durationMs: null, filesChangedCount: 0,
      toolsUsedCount: 0, errorsCount: 0, projectRoot: "C:/project",
      messageCount: 0, totalTokensUsed: 0, compactedFrom: null,
    })
    storage.enqueue("developer_events", {
      event_type: "tool_warning", session_id: "ses_events", file_path: "src/a.ts",
      metadata: JSON.stringify({ reason: "test", blocking: false }), timestamp: now,
    })
    storage.enqueue("developer_events", {
      event_type: "turn_completed", session_id: "ses_events", file_path: null,
      metadata: JSON.stringify({ kind: "turn", turn_index: 1 }), timestamp: now,
    })
    storage.flushBatch()
    expect(storage.getDevEvents("tool_warning")).toHaveLength(1)
    expect(storage.getDevEvents("turn_completed")).toHaveLength(1)
  })

  test("enforces unique knowledge edges", () => {
    const storage = createStorage()
    const now = Date.now()
    const source = storage.upsertNode({ nodeType: NodeType.File, name: "a.ts", path: "a.ts", metadata: null, createdAt: now, updatedAt: now })
    const target = storage.upsertNode({ nodeType: NodeType.File, name: "b.ts", path: "b.ts", metadata: null, createdAt: now, updatedAt: now })
    storage.upsertEdge({ sourceId: source, targetId: target, edgeType: "imports" as never, weight: 1, evidenceCount: 1 })

    let duplicateRejected = false
    try {
      storage.getDb().prepare(
        `INSERT INTO knowledge_edges (source_id, target_id, edge_type, weight, evidence_count, first_seen, last_seen)
         VALUES (?1, ?2, 'imports', 1, 1, ?3, ?3)`,
      ).run(source, target, now)
    } catch {
      duplicateRejected = true
    }
    expect(duplicateRejected).toBe(true)
  })

  test("creates, updates and chains change passports", () => {
    const storage = createStorage()
    const project = "C:/project"
    const first = storage.createPassport({
      projectRoot: project, sessionId: "ses_pass_a", taskId: "task-a", contractId: null,
      intent: "Add change passports", status: "draft", riskScore: 0.2, riskLevel: "low",
      files: [{ path: "src/passport.ts", editType: "update", linesAdded: 10, linesRemoved: 2, hash: "abc123" }],
      evidenceIds: ["ev-1", "ev-2"],
      checks: [{ id: "typecheck", label: "Typecheck", status: "pass", details: null }],
      findings: [{ kind: "lint", severity: "warning", file: "src/passport.ts", line: 7, message: "unused import" }],
      budgetTokens: 1000, tokensUsed: 50, allowDestructive: false,
      agent: "build", model: "model-x", baseRef: "main",
      rollbackPlan: "git revert", reviewMd: "# Review",
    })

    expect(first.status).toBe("draft")
    expect(first.sealedAt).toBeNull()
    expect(first.files).toEqual([{ path: "src/passport.ts", editType: "update", linesAdded: 10, linesRemoved: 2, hash: "abc123" }])
    expect(first.evidenceIds).toEqual(["ev-1", "ev-2"])
    expect(first.checks[0].status).toBe("pass")
    expect(first.findings[0].line).toBe(7)
    expect(first.allowDestructive).toBe(false)

    // Make the first passport strictly older so created_at ordering is stable.
    storage.getDb().prepare("UPDATE change_passports SET created_at = ?1 WHERE id = ?2").run(Date.now() - 5000, first.id)

    const second = storage.createPassport({
      projectRoot: project, sessionId: "ses_pass_b", taskId: "task-b", contractId: null,
      intent: "Second change", status: "draft", riskScore: 0, riskLevel: "low",
      files: [], evidenceIds: [], checks: [], findings: [],
      budgetTokens: null, tokensUsed: 0, allowDestructive: false,
      agent: null, model: null, baseRef: null, rollbackPlan: null, reviewMd: null,
    })

    const sealed = storage.updatePassport(first.id, {
      status: "sealed", hash: "hash-pass-1", tokensUsed: 120, allowDestructive: true,
      files: [{ path: "src/passport.ts", editType: "update", linesAdded: 10, linesRemoved: 2, hash: "def456" }],
    })!
    expect(sealed.status).toBe("sealed")
    expect(sealed.sealedAt).toBeGreaterThan(0)
    expect(sealed.tokensUsed).toBe(120)
    expect(sealed.allowDestructive).toBe(true)
    expect(sealed.files[0].hash).toBe("def456")
    expect(storage.getLastPassportHash(project)).toBe("hash-pass-1")

    expect(storage.getLatestPassport(project)?.id).toBe(second.id)
    expect(storage.getLatestPassport(project, "ses_pass_a")?.id).toBe(first.id)
    expect(storage.getLatestPassport(project, undefined, "task-a")?.id).toBe(first.id)
    expect(storage.getLatestPassport(project, "ses_pass_a", "task-a")?.id).toBe(first.id)
    expect(storage.getLatestPassport(project, "ses_pass_b", "task-a")).toBeUndefined()

    expect(storage.listPassports(project).map((passport) => passport.id)).toEqual([second.id, first.id])
    expect(storage.listPassports(project, "sealed").map((passport) => passport.id)).toEqual([first.id])
    expect(storage.listPassports(project, undefined, 1).map((passport) => passport.id)).toEqual([second.id])

    const chained = storage.updatePassport(second.id, {
      status: "blocked", hash: "hash-pass-2", prevHash: "hash-pass-1",
    })!
    expect(chained.status).toBe("blocked")
    expect(chained.prevHash).toBe("hash-pass-1")
    expect(chained.sealedAt).toBeGreaterThan(0)
    expect(storage.getLastPassportHash(project)).toBe("hash-pass-2")
  })

  test("coordinates file claims across sessions and expires stale claims", () => {
    const storage = createStorage()
    const project = "C:/project"

    const first = storage.claimFile({
      projectRoot: project, filePath: "src/shared.ts", sessionId: "ses_claim_a",
      agent: "build", note: "refactor",
    })
    expect(first.claim).toBeTruthy()
    expect(first.conflict).toBeNull()
    expect(first.claim!.expiresAt).toBeGreaterThan(first.claim!.createdAt)

    const same = storage.claimFile({ projectRoot: project, filePath: "src/shared.ts", sessionId: "ses_claim_a" })
    expect(same.claim?.id).toBe(first.claim!.id)
    expect(same.conflict).toBeNull()
    expect(storage.listFileClaims(project)).toHaveLength(1)

    const other = storage.claimFile({ projectRoot: project, filePath: "src/shared.ts", sessionId: "ses_claim_b" })
    expect(other.claim).toBeNull()
    expect(other.conflict?.sessionId).toBe("ses_claim_a")

    // An expired claim stops blocking new work and is marked expired.
    storage.getDb().prepare("UPDATE file_claims SET expires_at = ?1 WHERE id = ?2")
      .run(Date.now() - 1000, first.claim!.id)
    const afterExpiry = storage.claimFile({
      projectRoot: project, filePath: "src/shared.ts", sessionId: "ses_claim_b", ttlMs: 60_000,
    })
    expect(afterExpiry.conflict).toBeNull()
    expect(afterExpiry.claim?.sessionId).toBe("ses_claim_b")
    expect(storage.getFileClaim(project, "src/shared.ts")?.sessionId).toBe("ses_claim_b")
    expect(storage.releaseFileClaim(project, "src/shared.ts", "ses_claim_a")).toBe(false)
    expect(storage.releaseFileClaim(project, "src/shared.ts", "ses_claim_b")).toBe(true)
    expect(storage.getFileClaim(project, "src/shared.ts")).toBeUndefined()
    expect(storage.listFileClaims(project)).toHaveLength(0)

    // After release the file is claimable again; released/expired history stays.
    const reclaimed = storage.claimFile({ projectRoot: project, filePath: "src/shared.ts", sessionId: "ses_claim_a" })
    expect(reclaimed.claim?.sessionId).toBe("ses_claim_a")
    expect(reclaimed.conflict).toBeNull()
    const history = storage.listFileClaims(project, false)
    expect(history).toHaveLength(3)
    expect(history.filter((claim) => claim.status === "released")).toHaveLength(1)
    expect(history.filter((claim) => claim.status === "expired")).toHaveLength(1)
  })

  test("collects session changed files and tool execution previews", () => {
    const storage = createStorage()
    const now = Date.now()
    const edit = (sessionId: string, filePath: string, timestamp: number) => storage.insertFileEdit({
      filePath, sessionId, agentType: AgentType.Build, editType: EditType.Update,
      diffPreview: null, linesAdded: 2, linesRemoved: 1, timestamp,
      projectRoot: "C:/project", wasReverted: false, fileLanguage: "ts", diffHash: null,
    } as never)

    edit("ses_files", "src/older.ts", now - 2000)
    edit("ses_files", "src/newer.ts", now - 1000)
    edit("ses_files", "src/newer.ts", now - 500)
    edit("ses_other", "src/other.ts", now)

    expect(storage.getSessionChangedFiles("ses_files")).toEqual(["src/newer.ts", "src/older.ts"])
    expect(storage.getSessionChangedFiles("ses_files", 1)).toEqual(["src/newer.ts"])

    storage.insertToolExecution({
      sessionId: "ses_files", toolName: "read", targetFile: "src/newer.ts",
      argsPreview: "{\"filePath\":\"src/newer.ts\"}", status: ToolStatus.Success,
      durationMs: 4, timestamp: now - 100, resultSizeBytes: 20,
    })
    storage.insertToolExecution({
      sessionId: "ses_files", toolName: "edit", targetFile: "src/newer.ts",
      argsPreview: "{\"filePath\":\"src/newer.ts\"}", status: ToolStatus.Error,
      durationMs: 8, timestamp: now, resultSizeBytes: 0,
    })
    storage.insertToolExecution({
      sessionId: "ses_other", toolName: "bash", targetFile: null,
      argsPreview: "echo", status: ToolStatus.Success,
      durationMs: 1, timestamp: now, resultSizeBytes: 5,
    })

    const previews = storage.getToolExecutionPreviews("ses_files")
    expect(previews).toHaveLength(2)
    expect(previews[0]).toEqual({
      toolName: "edit", argsPreview: "{\"filePath\":\"src/newer.ts\"}",
      status: ToolStatus.Error, timestamp: now,
    })
    expect(previews[1].toolName).toBe("read")
    expect(storage.getToolExecutionPreviews("ses_files", 1)).toHaveLength(1)
  })

  test("pins tool trust fingerprints and detects description changes", () => {
    const storage = createStorage()
    const project = "C:/project"

    const first = storage.upsertToolTrust({
      projectRoot: project, serverName: "mcp-demo", toolName: "read_file",
      fingerprint: "fp-1", descriptionHash: "desc-1", schemaHash: "schema-1",
      metadata: { server: "mcp-demo" },
    })
    expect(first.changed).toBe(false)
    expect(first.previousStatus).toBeNull()
    expect(first.record.status).toBe("trusted")
    expect(first.record.serverName).toBe("mcp-demo")
    expect(first.record.metadata).toEqual({ server: "mcp-demo" })

    const same = storage.upsertToolTrust({
      projectRoot: project, toolName: "read_file", fingerprint: "fp-1",
      descriptionHash: "desc-1", schemaHash: "schema-1",
    })
    expect(same.changed).toBe(false)
    expect(same.previousStatus).toBe("trusted")
    expect(same.record.status).toBe("trusted")
    expect(same.record.firstSeen).toBe(first.record.firstSeen)
    expect(same.record.descriptionHash).toBe("desc-1")

    const changed = storage.upsertToolTrust({
      projectRoot: project, toolName: "read_file", fingerprint: "fp-2",
      descriptionHash: "desc-2", schemaHash: "schema-2",
    })
    expect(changed.changed).toBe(true)
    expect(changed.previousStatus).toBe("trusted")
    expect(changed.record.status).toBe("changed")
    expect(changed.record.fingerprint).toBe("fp-2")
    expect(changed.record.descriptionHash).toBe("desc-2")
    expect(changed.record.schemaHash).toBe("schema-2")

    // A second project keeps its own pinned fingerprint.
    storage.upsertToolTrust({ projectRoot: "C:/other", toolName: "read_file", fingerprint: "fp-1" })
    expect(storage.getToolTrust("C:/other", "read_file")?.status).toBe("trusted")
    expect(storage.listToolTrust(project)).toHaveLength(1)
  })

  test("sets tool trust status and lists by status", () => {
    const storage = createStorage()
    const project = "C:/project"

    storage.upsertToolTrust({ projectRoot: project, toolName: "mcp__demo__write", fingerprint: "fp-1" })
    storage.upsertToolTrust({ projectRoot: project, toolName: "mcp__demo__read", fingerprint: "fp-2" })

    const blocked = storage.setToolTrustStatus(project, "mcp__demo__write", "blocked")
    expect(blocked?.status).toBe("blocked")
    expect(storage.setToolTrustStatus(project, "missing_tool", "trusted")).toBeUndefined()

    const blockedList = storage.listToolTrust(project, "blocked")
    expect(blockedList).toHaveLength(1)
    expect(blockedList[0].toolName).toBe("mcp__demo__write")
    expect(storage.listToolTrust(project, "trusted")).toHaveLength(1)
  })

  test("releaseSessionClaims releases claims for one session only", () => {
    const storage = createStorage()
    const project = "C:/project"

    storage.claimFile({ projectRoot: project, filePath: "src/a.ts", sessionId: "ses_claim_a" })
    storage.claimFile({ projectRoot: project, filePath: "src/b.ts", sessionId: "ses_claim_a" })
    storage.claimFile({ projectRoot: project, filePath: "src/c.ts", sessionId: "ses_claim_b" })

    expect(storage.releaseSessionClaims("ses_claim_a")).toBe(2)
    expect(storage.releaseSessionClaims("ses_claim_a")).toBe(0)

    const rows = storage.getDb().prepare(
      "SELECT session_id, status, released_at FROM file_claims ORDER BY file_path",
    ).all() as Array<{ session_id: string; status: string; released_at: number | null }>
    const sessionA = rows.filter((row) => row.session_id === "ses_claim_a")
    expect(sessionA).toHaveLength(2)
    expect(sessionA.every((row) => row.status === "released" && row.released_at !== null)).toBe(true)
    expect(rows.find((row) => row.session_id === "ses_claim_b")?.status).toBe("active")
  })
})
