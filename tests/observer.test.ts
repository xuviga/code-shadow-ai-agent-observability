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
    // The session agent is inherited when the edit payload has no agent field.
    expect(edit.agentType).toBe("explore")
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

  test("does not count LSP warnings as session errors", async () => {
    const { storage, observer } = createObserverFixture()
    const sessionId = "observer-session-lsp-severity"
    await observer.event({
      event: {
        type: "session.created",
        properties: { info: { id: sessionId, agent: "build", directory: "C:/project", time: { created: Date.now() } } },
      },
    })

    await observer["lsp.diagnostic"]({
      file: "src/warn.ts", sessionID: sessionId,
      diagnostics: [{ message: "Warning", severity: 2 }, { message: "Hint", severity: 4 }],
    }, {})
    await observer["lsp.diagnostic"]({
      file: "src/error.ts", sessionID: sessionId,
      diagnostics: [{ message: "Type mismatch", severity: 1 }],
    }, {})

    expect(storage.getErrorsForFile("src/warn.ts")).toHaveLength(0)
    expect(storage.getErrorsForFile("src/error.ts")).toHaveLength(1)
  })

  test("auto-detects facts from Windows-style absolute paths", async () => {
    const { storage, observer } = createObserverFixture()
    const sessionId = "observer-session-win-auto-memory"
    await observer.event({
      event: {
        type: "session.created",
        properties: { info: { id: sessionId, agent: "build", directory: "C:/project", time: { created: Date.now() } } },
      },
    })

    await observer["file.edited"]({ file: "C:\\project\\src\\components\\Button.tsx", sessionID: sessionId }, {})

    const row = storage.getDb().prepare(
      "SELECT COUNT(*) AS cnt FROM knowledge_nodes WHERE project_root = 'C:/project' AND name LIKE '%Компоненты%'",
    ).get() as { cnt: number }
    expect(row.cnt).toBe(1)
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

  test("rejects noisy commands and success outputs that contain failures", async () => {
    const { storage, observer } = createObserverFixture()
    const sessionId = "observer-session-evidence-noise"
    await observer.event({
      event: {
        type: "session.created",
        properties: { info: { id: sessionId, agent: "build", directory: "C:/project", time: { created: Date.now() } } },
      },
    })

    await observer["tool.execute.after"]({
      tool: "bash", sessionID: sessionId, callID: "noise-echo", args: { command: "echo test" },
    }, { title: "echo", output: "test", metadata: {} })
    await observer["tool.execute.after"]({
      tool: "bash", sessionID: sessionId, callID: "noise-masked", args: { command: "npm test || true" },
    }, { title: "npm test", output: "failed", metadata: {} })
    await observer["tool.execute.after"]({
      tool: "grep", sessionID: sessionId, callID: "noise-grep", args: { pattern: "test", path: "src" },
    }, { title: "grep", output: "test", metadata: {} })

    expect(storage.listEvidence("C:/project")).toHaveLength(0)

    await observer["tool.execute.after"]({
      tool: "bash", sessionID: sessionId, callID: "noise-failing-output", args: { command: "npm test" },
    }, { title: "npm test", output: "Tests: 1 failed, 3 passed", metadata: {} })

    const evidence = storage.listEvidence("C:/project")
    expect(evidence).toHaveLength(1)
    expect(evidence[0].status).toBe("failed")
  })

  test("guards patch tools and parses patched file names for contracts", async () => {
    const { storage, observer } = createObserverFixture()
    const sessionId = "observer-session-patch"
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

    await observer["tool.execute.before"](
      { tool: "apply_patch", sessionID: sessionId, callID: "patch-preflight" },
      { args: { patchText: "*** Update File: README.md\n@@\n-old\n+new" } },
    )
    storage.flushBatch()
    const warning = storage.getDevEvents("tool_rejected").find((event) => String(event.metadata?.reason) === "change_contract_preflight")
    expect(warning?.filePath).toBe("README.md")

    for (let index = 0; index < 3; index += 1) {
      await observer["tool.execute.after"]({
        tool: "apply_patch", sessionID: sessionId, callID: `patch-${index}`,
        args: { filePath: "src/a.ts", patchText: "same patch" },
      }, { title: "apply_patch", output: "done", metadata: {} })
    }

    let blocked = false
    try {
      await observer["tool.execute.before"](
        { tool: "apply_patch", sessionID: sessionId, callID: "patch-blocked" },
        { args: { filePath: "src/a.ts", patchText: "same patch" } },
      )
    } catch {
      blocked = true
    }
    expect(blocked).toBe(true)
    storage.flushBatch()
  })

  test("detects and blocks a successful write loop for one file", async () => {
    const { storage, observer } = createObserverFixture()
    const sessionId = "observer-session-write-loop"
    await observer.event({
      event: {
        type: "session.created",
        properties: { info: { id: sessionId, agent: "build", directory: "C:/project", time: { created: Date.now() } } },
      },
    })

    for (const content of ["same version", "same version", "same version"]) {
      await observer["tool.execute.after"]({
        tool: "write", sessionID: sessionId, callID: `write-${content}`, args: { filePath: "C:/test/collector_async.py", content },
      }, { title: "write file", output: "updated", metadata: {} })
    }
    storage.flushBatch()

    const warning = storage.getDevEvents("tool_rejected").find((event) => String(event.metadata?.reason) === "successful_edit_loop_warning")
    expect(warning?.filePath).toBe("C:/test/collector_async.py")
    expect(warning?.metadata?.repeats).toBe(3)

    const permission = { status: "ask" as const }
    await observer["permission.ask"]({
      id: "permission-write-loop", type: "write", pattern: "C:/test/collector_async.py",
      sessionID: sessionId, messageID: "message-loop", title: "Rewrite file", metadata: {},
    }, permission)
    expect(permission.status).toBe("deny")

    let blocked = false
    try {
      await observer["tool.execute.before"](
        { tool: "write", sessionID: sessionId, callID: "write-blocked" },
        { args: { filePath: "C:/test/collector_async.py", content: "version four" } },
      )
    } catch (error) {
      blocked = true
      expect(String(error)).toContain("остановлена повторная запись")
    }
    expect(blocked).toBe(true)
  })

  test("allows iterative edits after verified progress", async () => {
    const { storage, observer } = createObserverFixture()
    const sessionId = "observer-session-write-progress"
    await observer.event({
      event: {
        type: "session.created",
        properties: { info: { id: sessionId, agent: "build", directory: "C:/project", time: { created: Date.now() } } },
      },
    })

    for (const content of ["attempt one", "attempt two", "attempt three"]) {
      await observer["tool.execute.after"]({
        tool: "write", sessionID: sessionId, callID: `initial-${content}`, args: { filePath: "src/collector_async.py", content },
      }, { title: "write file", output: "updated", metadata: {} })
    }

    await observer["tool.execute.after"]({
      tool: "bash", sessionID: sessionId, callID: "verified-progress", args: { command: "npm test" },
    }, { title: "npm test", output: "passed", metadata: {} })

    for (const content of ["follow-up one", "follow-up two", "follow-up three"]) {
      await observer["tool.execute.after"]({
        tool: "write", sessionID: sessionId, callID: `follow-up-${content}`, args: { filePath: "src/collector_async.py", content },
      }, { title: "write file", output: "updated", metadata: {} })
    }

    let blocked = false
    try {
      await observer["tool.execute.before"](
        { tool: "write", sessionID: sessionId, callID: "progress-allowed" },
        { args: { filePath: "src/collector_async.py", content: "follow-up four" } },
      )
    } catch {
      blocked = true
    }
    expect(blocked).toBe(false)
    storage.flushBatch()
  })

  test("allows targeted edits after full rewrites without verified progress", async () => {
    const { storage, observer } = createObserverFixture()
    const sessionId = "observer-session-targeted-edits"
    await observer.event({
      event: {
        type: "session.created",
        properties: { info: { id: sessionId, agent: "build", directory: "C:/project", time: { created: Date.now() } } },
      },
    })

    for (const content of ["full rewrite one", "full rewrite two", "full rewrite three"]) {
      await observer["tool.execute.after"]({
        tool: "write", sessionID: sessionId, callID: `full-${content}`, args: { filePath: "src/metadeobf.py", content },
      }, { title: "write file", output: "updated", metadata: {} })
    }

    for (const newString of ["patch one", "patch two", "patch three", "patch four", "patch five"]) {
      await observer["tool.execute.after"]({
        tool: "edit", sessionID: sessionId, callID: `patch-${newString}`,
        args: { filePath: "src/metadeobf.py", oldString: "previous value", newString },
      }, { title: "edit file", output: "updated", metadata: {} })
    }

    const permission = { status: "ask" as const }
    await observer["permission.ask"]({
      id: "permission-targeted-edit", type: "edit", pattern: "src/metadeobf.py",
      sessionID: sessionId, messageID: "message-targeted-edit", title: "Patch parser", metadata: {},
    }, permission)
    expect(permission.status).toBe("ask")

    let blocked = false
    try {
      await observer["tool.execute.before"](
        { tool: "edit", sessionID: sessionId, callID: "targeted-edit-allowed" },
        { args: { filePath: "src/metadeobf.py", oldString: "patch five", newString: "patch six" } },
      )
    } catch {
      blocked = true
    }
    expect(blocked).toBe(false)
    storage.flushBatch()
  })

  test("blocks the next full rewrite after five consecutive writes without progress", async () => {
    const { storage, observer } = createObserverFixture()
    const sessionId = "observer-session-full-write-streak"
    await observer.event({
      event: {
        type: "session.created",
        properties: { info: { id: sessionId, agent: "build", directory: "C:/project", time: { created: Date.now() } } },
      },
    })

    for (let index = 1; index <= 5; index += 1) {
      await observer["tool.execute.after"]({
        tool: "write", sessionID: sessionId, callID: `streak-${index}`,
        args: { filePath: "src/collector_async.py", content: `rewrite ${index}` },
      }, { title: "write file", output: "updated", metadata: {} })
    }

    let blocked = false
    try {
      await observer["tool.execute.before"](
        { tool: "write", sessionID: sessionId, callID: "streak-blocked" },
        { args: { filePath: "src/collector_async.py", content: "rewrite 6" } },
      )
    } catch {
      blocked = true
    }
    expect(blocked).toBe(true)
    storage.flushBatch()
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

  // -------------------------------------------------------------------------
  // Реальные payload'ы @opencode-ai/sdk 1.18.33
  // -------------------------------------------------------------------------

  test("learns the agent from chat.message because session.created has no agent", async () => {
    const { storage, observer } = createObserverFixture()
    const sessionId = "observer-sdk-agent"
    await observer.event({
      event: { type: "session.created", properties: { info: { id: sessionId, directory: "C:/project", time: { created: Date.now() } } } },
    })
    await observer["chat.message"]({ sessionID: sessionId, agent: "plan" }, { parts: [{ type: "text", text: "hi" }] })
    const session = storage.getSession(sessionId)!
    expect(session.agentType).toBe("plan")
    expect(session.status).toBe("active")
  })

  test("compaction keeps the session id because the event only has sessionID", async () => {
    const { storage, observer } = createObserverFixture()
    const sessionId = "observer-sdk-compacted"
    await observer.event({
      event: { type: "session.created", properties: { info: { id: sessionId, directory: "C:/project", time: { created: Date.now() } } } },
    })
    await observer.event({ event: { type: "session.compacted", properties: { sessionID: sessionId } } })
    const session = storage.getSession(sessionId)!
    expect(session.status).toBe("compacted")
    const count = storage.getDb().prepare("SELECT COUNT(*) as cnt FROM sessions").get() as { cnt: number }
    expect(count.cnt).toBe(1)
  })

  test("maps real session.error payloads and ignores aborted turns", async () => {
    const { storage, observer } = createObserverFixture()
    const sessionId = "observer-sdk-error"
    await observer.event({
      event: { type: "session.created", properties: { info: { id: sessionId, directory: "C:/project", time: { created: Date.now() } } } },
    })
    await observer.event({
      event: {
        type: "session.error",
        properties: { sessionID: sessionId, error: { name: "APIError", data: { message: "provider exploded", statusCode: 500, isRetryable: true } } },
      },
    })
    expect(storage.getSession(sessionId)!.status).toBe("error")
    const errors = storage.getDb().prepare("SELECT error_type, error_message FROM session_errors WHERE session_id = ?").all(sessionId) as Array<{ error_type: string; error_message: string }>
    expect(errors).toHaveLength(1)
    expect(errors[0].error_type).toBe("model_error")
    expect(errors[0].error_message).toBe("provider exploded")

    await observer.event({
      event: {
        type: "session.error",
        properties: { sessionID: sessionId, error: { name: "MessageAbortedError", data: { message: "aborted" } } },
      },
    })
    const afterAbort = storage.getDb().prepare("SELECT COUNT(*) as cnt FROM session_errors WHERE session_id = ?").get(sessionId) as { cnt: number }
    expect(afterAbort.cnt).toBe(1)
  })

  test("counts completed assistant messages once and learns mode/tokens", async () => {
    const { storage, observer } = createObserverFixture()
    const sessionId = "observer-sdk-metrics"
    await observer.event({
      event: { type: "session.created", properties: { info: { id: sessionId, directory: "C:/project", time: { created: Date.now() } } } },
    })
    const info = {
      id: "message-metrics", sessionID: sessionId, role: "assistant", mode: "build",
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 0, write: 0 } },
      time: { created: 1, completed: 2 },
    }
    await observer.event({ event: { type: "message.updated", properties: { info } } })
    await observer.event({ event: { type: "message.updated", properties: { info } } })
    const row = storage.getDb().prepare("SELECT message_count, total_tokens_used, agent_type FROM sessions WHERE id = ?").get(sessionId) as { message_count: number; total_tokens_used: number; agent_type: string }
    expect(row.message_count).toBe(1)
    expect(row.total_tokens_used).toBe(15)
    expect(row.agent_type).toBe("build")
  })

  test("stores file.edited with only {file} using the current session", async () => {
    const { storage, observer } = createObserverFixture()
    const sessionId = "observer-sdk-file"
    await observer.event({
      event: { type: "session.created", properties: { info: { id: sessionId, agent: "build", directory: "C:/project", time: { created: Date.now() } } } },
    })
    await observer.event({ event: { type: "file.edited", properties: { file: "src/sdk-file.ts" } } })
    storage.flushBatch()
    const edits = storage.getFileEdits("src/sdk-file.ts")
    expect(edits).toHaveLength(1)
    expect(edits[0].sessionId).toBe(sessionId)
    expect(edits[0].agentType).toBe("build")
    expect(edits[0].diffPreview).toBeNull()
  })

  test("classifies empty, denied and failed tool results correctly", async () => {
    const { storage, observer } = createObserverFixture()
    const sessionId = "observer-sdk-status"
    await observer.event({
      event: { type: "session.created", properties: { info: { id: sessionId, directory: "C:/project", time: { created: Date.now() } } } },
    })
    await observer["tool.execute.after"](
      { tool: "bash", sessionID: sessionId, callID: "empty", args: { command: "true" } },
      { title: "bash", output: "", metadata: {} },
    )
    await observer["tool.execute.after"](
      { tool: "bash", sessionID: sessionId, callID: "denied", args: { command: "rm -rf /" } },
      { title: "bash", output: "blocked", metadata: { denied: true } },
    )
    await observer["tool.execute.after"](
      { tool: "bash", sessionID: sessionId, callID: "failed", args: { command: "false" } },
      { title: "bash", output: "nope", metadata: { exitCode: 1 } },
    )
    await observer["tool.execute.after"](
      { tool: "read", sessionID: sessionId, callID: "file-path", args: { file_path: "src/status.ts" } },
      { title: "read", output: "content", metadata: {} },
    )
    storage.flushBatch()
    const rows = storage.getDb().prepare("SELECT tool_name, target_file, status FROM tool_executions WHERE session_id = ? ORDER BY id").all(sessionId) as Array<{ tool_name: string; target_file: string | null; status: string }>
    expect(rows.map((row) => row.status)).toEqual(["success", "denied", "error", "success"])
    expect(rows[3].target_file).toBe("src/status.ts")
  })

  test("flushes pending batch before session.idle counts", async () => {
    const { storage, observer } = createObserverFixture()
    const sessionId = "observer-sdk-idle-flush"
    await observer.event({
      event: { type: "session.created", properties: { info: { id: sessionId, directory: "C:/project", time: { created: Date.now() } } } },
    })
    await observer["tool.execute.after"](
      { tool: "read", sessionID: sessionId, callID: "pending-1", args: { file: "src/pending.ts" } },
      { title: "read", output: "content", metadata: {} },
    )
    await observer["tool.execute.after"](
      { tool: "read", sessionID: sessionId, callID: "pending-2", args: { file: "src/pending.ts" } },
      { title: "read", output: "content", metadata: {} },
    )
    await observer.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })
    const session = storage.getSession(sessionId)!
    expect(session.status).toBe("idle")
    expect(session.toolsUsedCount).toBe(2)

    // A duplicate idle event must not overwrite the completed session.
    await observer.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })
    storage.flushBatch()
    const completed = storage.getDb().prepare("SELECT COUNT(*) as cnt FROM developer_events WHERE session_id = ? AND event_type = 'session_completed'").get(sessionId) as { cnt: number }
    expect(completed.cnt).toBe(1)
  })

  test("marks a deleted session and registers patch files for the idle summary", async () => {
    const { storage, observer } = createObserverFixture()
    const sessionId = "observer-sdk-deleted"
    await observer.event({
      event: { type: "session.created", properties: { info: { id: sessionId, directory: "C:/project", time: { created: Date.now() } } } },
    })
    await observer.event({
      event: { type: "message.part.updated", properties: { part: { type: "patch", sessionID: sessionId, hash: "abc", files: ["src/patched.ts"] } } },
    })
    await observer.event({ event: { type: "session.idle", properties: { sessionID: sessionId } } })
    const summary = storage.searchNodes("summary", 100).find((node) => node.name.includes(sessionId.substring(0, 8)))
    expect(summary).toBeTruthy()

    await observer.event({ event: { type: "session.deleted", properties: { info: { id: sessionId } } } })
    expect(storage.getSession(sessionId)!.status).toBe("deleted")
  })
})
