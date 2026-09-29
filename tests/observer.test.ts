import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StorageEngine } from "../src/storage"
import { createObserver } from "../src/observer"

const databases: Array<{ storage: StorageEngine; directory: string }> = []

function createObserverFixture() {
  const directory = mkdtempSync(join(tmpdir(), "code-shadow-observer-"))
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

  const log = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }

  const observer = createObserver(storage as never, {
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
  }, log as never)

  return { storage, observer }
}

afterEach(() => {
  while (databases.length > 0) {
    const item = databases.pop()!
    item.storage.close()
    // Bun/SQLite can keep the WAL handle briefly on Windows after close().
    // The directory is isolated under the OS temp folder, so a locked cleanup
    // must not turn a passing observer test into a false failure.
    try {
      rmSync(item.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
    } catch {
      // Best-effort cleanup; the OS will reclaim the temporary directory.
    }
  }
})

describe("Observer", () => {
  test("normalizes direct file.edited input and keeps project root", async () => {
    const { storage, observer } = createObserverFixture()
    const sessionId = "observer-session"

    await observer.event({
      event: {
        type: "session.created",
        properties: {
          info: {
            id: sessionId,
            agent: "explore",
            directory: "C:/project",
            time: { created: Date.now() },
          },
        },
      },
    })

    await observer["file.edited"]({
      file: "src/index.ts",
      sessionID: sessionId,
      diff: "+const value = 1",
    }, {})
    storage.flushBatch()

    const edit = storage.getFileEdits("src/index.ts")[0]
    expect(edit.projectRoot).toBe("C:/project")
    expect(edit.agentType).toBe("general")
  })

  test("stores LSP errors and todos for the active session", async () => {
    const { storage, observer } = createObserverFixture()
    const sessionId = "observer-session-lsp"

    await observer.event({
      event: {
        type: "session.created",
        properties: {
          info: {
            id: sessionId,
            agent: "build",
            directory: "C:/project",
            time: { created: Date.now() },
          },
        },
      },
    })

    await observer["lsp.diagnostic"]({
      file: "src/index.ts",
      sessionID: sessionId,
      diagnostics: [{ message: "Type mismatch", severity: 1, line: 4 }],
    }, {})

    await observer.event({
      event: {
        type: "lsp.client.diagnostics",
        properties: {
          path: "src/index.ts",
          sessionID: sessionId,
          diagnostics: [{ message: "Warning", severity: "warning", source: "tsserver" }],
        },
      },
    })

    await observer.event({
      event: {
        type: "todo.updated",
        properties: {
          sessionID: sessionId,
          todos: [{ id: "todo-1", content: "Fix type", status: "completed" }],
        },
      },
    })
    storage.flushBatch()

    expect(storage.getErrorsForFile("src/index.ts")).toHaveLength(1)
    expect(storage.getDb().prepare("SELECT status FROM todos WHERE todo_id = 'todo-1'").get()).toEqual({ status: "completed" })
    expect(storage.getDevEvents("todo_completed")).toHaveLength(1)
    expect(storage.getDevEvents("lsp_diagnostic_summary")).toHaveLength(1)
    expect(storage.getDb().prepare("SELECT COUNT(*) AS count FROM agent_tasks WHERE project_root = 'C:/project'").get()).toEqual({ count: 1 })
  })

  test("marks an active change contract violated on file.edited", async () => {
    const { storage, observer } = createObserverFixture()
    const sessionId = "observer-session-contract"

    await observer.event({
      event: {
        type: "session.created",
        properties: {
          info: { id: sessionId, agent: "build", directory: "C:/project", time: { created: Date.now() } },
        },
      },
    })
    const contract = storage.createChangeContract({
      projectRoot: "C:/project", taskId: null, sessionId,
      goal: "Only touch source", allowedPaths: ["src/"], forbiddenPaths: [],
      plannedPaths: ["src/index.ts"], verificationPlan: ["bun test"],
    })

    await observer["file.edited"]({ file: "README.md", sessionID: sessionId, diff: "+outside contract" }, {})

    const row = storage.getChangeContract(contract.id)
    expect(row?.status).toBe("violated")
    expect(row?.violations).toEqual(["README.md"])
  })

  test("captures successful verification commands as verified evidence", async () => {
    const { storage, observer } = createObserverFixture()
    const sessionId = "observer-session-evidence"
    await observer.event({
      event: {
        type: "session.created",
        properties: { info: { id: sessionId, agent: "build", directory: "C:/project", time: { created: Date.now() } } },
      },
    })
    const task = storage.createTask({
      projectRoot: "C:/project", sessionId, title: "Verify build", goal: "Run the build",
      status: "active" as never, priority: 50, metadata: null,
    })
    await observer["tool.execute.after"]({
      tool: "bash", sessionID: sessionId, callID: "verify-1", args: { command: "npm run typecheck" },
    }, { title: "npm run typecheck", output: "passed", metadata: {} })

    const evidence = storage.listEvidence("C:/project", task.id)
    expect(evidence).toHaveLength(1)
    expect(evidence[0].status).toBe("verified")
    expect(evidence[0].evidenceType).toBe("command")
  })

  test("emits a preflight warning for an edit outside the active contract", async () => {
    const { storage, observer } = createObserverFixture()
    const sessionId = "observer-session-preflight"
    await observer.event({
      event: {
        type: "session.created",
        properties: { info: { id: sessionId, agent: "build", directory: "C:/project", time: { created: Date.now() } } },
      },
    })
    storage.createChangeContract({
      projectRoot: "C:/project", taskId: null, sessionId,
      goal: "Keep edits under src", allowedPaths: ["src/"], forbiddenPaths: [],
      plannedPaths: ["src/index.ts"], verificationPlan: ["bun test"],
    })
    await observer["tool.execute.before"]({ tool: "edit", sessionID: sessionId, callID: "preflight-1" }, { args: { filePath: "README.md" } })
    storage.flushBatch()
    const warning = storage.getDevEvents("tool_rejected").find((event) => String(event.metadata?.reason) === "change_contract_preflight")
    expect(warning).toBeTruthy()
  })

  test("creates a task from an actionable user message", async () => {
    const { storage, observer } = createObserverFixture()
    const sessionId = "observer-session-chat"
    await observer.event({
      event: {
        type: "session.created",
        properties: { info: { id: sessionId, agent: "build", directory: "C:/project", time: { created: Date.now() } } },
      },
    })
    await observer["chat.message"]({ sessionID: sessionId, messageID: "message-1" }, {
      parts: [{ type: "text", text: "Implement a fix for the authentication flow and add tests" }],
    })
    const task = storage.listTasks("C:/project", "active", 10)[0]
    expect(task?.metadata).toEqual({ source: "chat.message", message_id: "message-1", auto_created: true })
    const steps = storage.listTaskSteps(task!.id)
    expect(steps[0].status).toBe("in_progress")
    expect(steps.map((step) => step.title)).toEqual([
      "Изучить релевантный код и контекст проекта",
      "Воспроизвести проблему и найти root cause",
      "Проверить затронутые границы, зависимости и исторический риск",
      "Реализовать изменение в пределах Change Contract",
      "Добавить или обновить regression tests",
      "Запустить verification-команды и записать verified evidence",
    ])
    expect(steps.slice(1).every((step) => step.status === "pending")).toBe(true)
  })

  test("denies permission when an edit violates an active contract", async () => {
    const { storage, observer } = createObserverFixture()
    const sessionId = "observer-session-permission"
    await observer.event({
      event: {
        type: "session.created",
        properties: { info: { id: sessionId, agent: "build", directory: "C:/project", time: { created: Date.now() } } },
      },
    })
    storage.createChangeContract({
      projectRoot: "C:/project", taskId: null, sessionId,
      goal: "Keep edits under src", allowedPaths: ["src/"], forbiddenPaths: [".env"],
      plannedPaths: ["src/index.ts"], verificationPlan: ["bun test"],
    })
    const denied = { status: "ask" as const }
    await observer["permission.ask"]({ id: "permission-1", type: "edit", pattern: "README.md", sessionID: sessionId, messageID: "message-2", title: "Edit README", metadata: {} }, denied)
    expect(denied.status).toBe("deny")
    const allowed = { status: "ask" as const }
    await observer["permission.ask"]({ id: "permission-2", type: "edit", pattern: "src/index.ts", sessionID: sessionId, messageID: "message-2", title: "Edit source", metadata: {} }, allowed)
    expect(allowed.status).toBe("ask")
  })
})
