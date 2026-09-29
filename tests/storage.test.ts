import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StorageEngine } from "../src/storage"
import { AgentType, EditType, SessionStatus } from "../src/types"

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

    expect(version.version).toBe(6)
    expect(table).toBeTruthy()
    for (const name of ["agent_tasks", "task_steps", "evidence_records", "failure_memory", "change_contracts", "contradiction_records", "provenance_events", "agent_handoffs"]) {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1").get(name)).toBeTruthy()
    }
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

  test("does not silently drop a failed batch", () => {
    const storage = createStorage()
    storage.enqueue("developer_events", {
      event_type: "not-a-real-event",
      session_id: null,
      file_path: null,
      metadata: null,
      timestamp: Date.now(),
    })

    storage.flushBatch()

    expect(storage.batchQueue).toHaveLength(1)
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
    expect(storage.getTaskStep(step.id)?.status).toBe("completed")
    expect(storage.getEvidence(evidence.id)?.status).toBe("verified")
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
})
