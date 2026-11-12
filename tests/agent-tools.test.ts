import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StorageEngine } from "../src/storage"
import { createAgentTools } from "../src/tools/agent"

const databases: Array<{ storage: StorageEngine; directory: string }> = []

const config = {
  dbPath: "",
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
}

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "code-shadow-agent-tools-"))
  const storage = new StorageEngine({ ...config, dbPath: join(directory, "data.db") })
  databases.push({ storage, directory })
  const tools = createAgentTools(storage, config as never, {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  } as never)
  return { storage, tools }
}

async function call(tools: Record<string, unknown>, name: string, args: Record<string, unknown>) {
  const tool = tools[name] as { execute: (args: Record<string, unknown>, context: Record<string, unknown>) => Promise<{ output: string }> }
  const result = await tool.execute(args, { directory: "C:/project" })
  return JSON.parse(result.output)
}

afterEach(() => {
  while (databases.length > 0) {
    const item = databases.pop()!
    item.storage.close()
    try {
      rmSync(item.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
    } catch {
      // Best-effort cleanup on Windows WAL handles.
    }
  }
})

describe("agent tools guardrails", () => {
  test("update to completed respects Definition of Done", async () => {
    const { storage, tools } = createFixture()
    const created = await call(tools, "code_shadow_task", { action: "create", title: "Guard", goal: "Stay open" })
    const taskId = created.task.id as string

    const blocked = await call(tools, "code_shadow_task", { action: "update", task_id: taskId, status: "completed" })
    expect(blocked.definition_of_done.ready).toBe(false)
    expect(storage.getTask(taskId)?.status).toBe("active")
  })

  test("cannot create a task directly in completed state", async () => {
    const { storage, tools } = createFixture()
    const result = await call(tools, "code_shadow_task", {
      action: "create", title: "Bypass", goal: "Skip DoD", status: "completed",
    })
    expect(result.error).toBeDefined()
    expect(storage.listTasks("C:/project")).toHaveLength(0)
  })

  test("Definition of Done blocks task-linked failures even when the text does not mention the goal", async () => {
    const { storage, tools } = createFixture()
    const created = await call(tools, "code_shadow_task", { action: "create", title: "Refactor", goal: "Refactor auth flow" })
    const taskId = created.task.id as string

    const step = await call(tools, "code_shadow_task", {
      action: "add_step", task_id: taskId, step_title: "Implement", step_status: "pending",
    })
    await call(tools, "code_shadow_task", {
      action: "complete_step", task_id: taskId, step_id: step.step.id,
    })
    storage.recordEvidence({
      projectRoot: "C:/project", taskId, sessionId: null, claim: "tests pass",
      evidenceType: "test", source: "bun test", status: "verified", confidence: 1, details: null,
    } as never)
    storage.recordFailure({
      projectRoot: "C:/project", taskId, sessionId: null, hypothesis: "retry",
      action: "run", failure: "unrelated wording", rootCause: null, resolution: null,
      doNotRepeat: null, signature: null, metadata: null,
    } as never)

    const check = await call(tools, "code_shadow_task", { action: "done_check", task_id: taskId })
    expect(check.definition_of_done.ready).toBe(false)
    expect(check.definition_of_done.blockers).toContain("open_failures:1")
  })

  test("empty contract check and closing a violated contract are refused", async () => {
    const { storage, tools } = createFixture()
    const created = await call(tools, "code_shadow_change_contract", {
      action: "create", goal: "Only src", allowed_paths: ["src/**"], forbidden_paths: [".env"],
    })
    const contractId = created.contract.id as string

    const emptyCheck = await call(tools, "code_shadow_change_contract", { action: "check", contract_id: contractId })
    expect(emptyCheck.error).toBeDefined()
    expect(storage.getChangeContract(contractId)?.status).toBe("active")

    storage.checkChangeContract(contractId, [".env"])
    expect(storage.getChangeContract(contractId)?.status).toBe("violated")
    const close = await call(tools, "code_shadow_change_contract", { action: "close", contract_id: contractId })
    expect(close.error).toBeDefined()
    expect(storage.getChangeContract(contractId)?.status).toBe("violated")
  })
})
