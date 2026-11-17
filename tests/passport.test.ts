import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StorageEngine } from "../src/storage"
import { createPassportTool } from "../src/tools/passport"
import {
  classifyDestructiveCommand,
  computePassportHash,
  scanAlmostRight,
} from "../src/passport"
import { AgentType, SessionStatus, TaskStatus } from "../src/types"

const fixtures: Array<{ storage: StorageEngine; directory: string; project: string }> = []

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
  destructiveActionPolicy: "block" as const,
}

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "code-shadow-passport-"))
  const project = join(directory, "project")
  mkdirSync(join(project, "src"), { recursive: true })
  writeFileSync(join(project, "src", "a.ts"), "export const value = 1\n", "utf8")
  const storage = new StorageEngine({ ...config, dbPath: join(directory, "data.db") })
  const tool = createPassportTool(storage, config as never, {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  } as never)
  fixtures.push({ storage, directory, project })
  return { storage, tool, project }
}

async function call(
  tools: Record<string, unknown>,
  args: Record<string, unknown>,
  context: Record<string, unknown>,
) {
  const definition = tools.code_shadow_passport as {
    execute: (args: Record<string, unknown>, context: Record<string, unknown>) => Promise<{ output: string }>
  }
  return JSON.parse((await definition.execute(args, context)).output)
}

function createSession(storage: StorageEngine, project: string, id = "ses_passport") {
  const now = Date.now()
  storage.insertSession({
    id,
    agentType: AgentType.Build,
    status: SessionStatus.Active,
    startedAt: now,
    endedAt: null,
    durationMs: null,
    filesChangedCount: 1,
    toolsUsedCount: 0,
    errorsCount: 0,
    projectRoot: project,
    messageCount: 0,
    totalTokensUsed: 0,
    compactedFrom: null,
  })
  storage.insertFileEdit({
    filePath: "src/a.ts",
    sessionId: id,
    agentType: AgentType.Build,
    editType: "update" as never,
    diffPreview: "+export const value = 1",
    linesAdded: 1,
    linesRemoved: 0,
    timestamp: now,
    projectRoot: project,
    wasReverted: false,
    fileLanguage: "typescript",
  })
  return id
}

afterEach(() => {
  while (fixtures.length > 0) {
    const item = fixtures.pop()!
    item.storage.close()
    try {
      rmSync(item.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
    } catch {
      // Best-effort cleanup on Windows WAL handles.
    }
  }
})

describe("Almost-right scanner", () => {
  test("finds silent catches, disabled tests and masked exit codes", () => {
    const findings = scanAlmostRight(
      "src/a.ts",
      [
        "try { run() } catch {}",
        "test.skip('important', () => {})",
        "const result = run() || true",
        "const value: any = 1",
      ].join("\n"),
    )
    expect(findings.some((item) => item.kind === "silent-catch")).toBe(true)
    expect(findings.some((item) => item.kind === "test-disabled")).toBe(true)
    expect(findings.some((item) => item.kind === "masked-exit-code")).toBe(true)
    expect(findings.some((item) => item.kind === "as-any")).toBe(true)
  })

  test("does not flag clean code", () => {
    expect(scanAlmostRight("src/a.ts", "export const value: number = 1\n")).toEqual([])
    expect(
      scanAlmostRight("src/a.ts", "try { run() } catch { /* logged elsewhere */ }\n"),
    ).toEqual([])
  })

  test("classifies destructive commands", () => {
    const critical = classifyDestructiveCommand("rm -rf ./src")
    expect(critical.some((item) => item.severity === "critical")).toBe(true)
    expect(classifyDestructiveCommand("git status").length).toBe(0)
    expect(classifyDestructiveCommand("git push --force").some((item) => item.severity === "warning")).toBe(true)
    // Search commands often contain destructive words as grep patterns.
    expect(classifyDestructiveCommand("Select-String -Path tests/*.ts -Pattern 'rm -rf|DROP TABLE'")).toEqual([])
    expect(classifyDestructiveCommand("grep -R 'DELETE FROM' src")).toEqual([])
  })
})

describe("Change Passport", () => {
  test("blocks without verified evidence, seals with evidence, verifies and detects stale files", async () => {
    const { storage, tool, project } = createFixture()
    const sessionId = createSession(storage, project)
    const task = storage.createTask({
      projectRoot: project,
      sessionId,
      title: "Change",
      goal: "Change a.ts",
      status: TaskStatus.Active,
      priority: 50,
      metadata: { auto_created: true },
    })
    const context = { sessionID: sessionId, directory: project, agent: "build" }

    const opened = await call(tool, {
      action: "open",
      intent: "Change a.ts safely",
      task_id: task.id,
      files: ["src/a.ts"],
      budget_tokens: 1000,
    }, context)
    expect(opened.passport.status).toBe("draft")

    const blocked = await call(tool, { action: "seal", passport_id: opened.passport.id }, context)
    expect(blocked.passport.status).toBe("blocked")
    expect(blocked.passport.checks.some((item: any) => item.id === "verified-evidence" && item.status === "fail")).toBe(true)
    expect(storage.evaluateTaskDone(task.id).blockers).toContain("passport_blocked")

    storage.recordEvidence({
      projectRoot: project,
      taskId: task.id,
      sessionId,
      claim: "bun test passed",
      evidenceType: "command",
      source: "bash: bun test",
      status: "verified",
      confidence: 1,
      details: null,
    } as never)

    const sealed = await call(tool, { action: "seal", passport_id: opened.passport.id }, context)
    expect(sealed.passport.status).toBe("sealed")
    expect(sealed.passport.hash).toBeTruthy()
    expect(sealed.passport.reviewMd).toContain("Change Passport")
    expect(sealed.passport.files[0].hash).toBeTruthy()
    expect(sealed.passport.checks.find((item: any) => item.id === "verified-evidence")?.status).toBe("pass")

    const verified = await call(tool, { action: "verify", passport_id: opened.passport.id }, context)
    expect(verified.status).toBe("valid")
    expect(verified.hash_valid).toBe(true)

    writeFileSync(join(project, "src", "a.ts"), "try { run() } catch {}\n", "utf8")
    const stale = await call(tool, { action: "verify", passport_id: opened.passport.id }, context)
    expect(stale.status).toBe("stale")
    expect(stale.files_valid).toBe(false)
  })

  test("seal without passport_id creates a draft from the active task", async () => {
    const { storage, tool, project } = createFixture()
    const sessionId = createSession(storage, project, "ses_auto_passport")
    const task = storage.createTask({
      projectRoot: project, sessionId, title: "Auto passport", goal: "Seal the change",
      status: TaskStatus.Active, priority: 50, metadata: { auto_created: true },
    })
    storage.recordEvidence({
      projectRoot: project, taskId: task.id, sessionId, claim: "bun test passed",
      evidenceType: "command", source: "bash: bun test", status: "verified",
      confidence: 1, details: null,
    } as never)

    const sealed = await call(tool, { action: "seal" }, {
      sessionID: sessionId, directory: project, agent: "build",
    })
    expect(sealed.passport.status).toBe("sealed")
    expect(sealed.passport.taskId).toBe(task.id)
    expect(sealed.passport.intent).toContain("Seal the change")
  })

  test("a passport hash changes when evidence/risk changes", () => {
    const base: any = {
      id: "p1", projectRoot: "C:/p", sessionId: "s", taskId: "t", contractId: null,
      intent: "x", status: "sealed", riskScore: 1, riskLevel: "low",
      files: [], evidenceIds: [], checks: [], findings: [], budgetTokens: null,
      tokensUsed: 0, allowDestructive: false, agent: null, model: null, baseRef: null,
      rollbackPlan: null, reviewMd: "r", hash: null, prevHash: null,
      createdAt: 1, updatedAt: 1, sealedAt: 1,
    }
    const first = computePassportHash(base)
    const second = computePassportHash({ ...base, evidenceIds: ["e1"] })
    expect(second).not.toBe(first)
  })

  test("file claims prevent a concurrent session from claiming the same file", async () => {
    const { storage, tool, project } = createFixture()
    createSession(storage, project, "ses_a")
    createSession(storage, project, "ses_b")
    const a = await call(tool, { action: "claim", file_path: "src/a.ts" }, {
      sessionID: "ses_a", directory: project,
    })
    expect(a.claim).toBeTruthy()
    const b = await call(tool, { action: "claim", file_path: "src/a.ts" }, {
      sessionID: "ses_b", directory: project,
    })
    expect(b.claim).toBeNull()
    expect(b.conflict?.sessionId).toBe("ses_a")
    const released = await call(tool, { action: "release", file_path: "src/a.ts" }, {
      sessionID: "ses_a", directory: project,
    })
    expect(released.released).toBe(true)
  })
})
