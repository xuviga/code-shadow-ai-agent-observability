import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StorageEngine } from "../src/storage"
import { createTuiIntegration } from "../src/tui"
import { AgentType, EditType, NodeType, SessionStatus } from "../src/types"

const databases: Array<{ storage: StorageEngine; directory: string }> = []

function createStorage(): StorageEngine {
  const directory = mkdtempSync(join(tmpdir(), "code-shadow-tui-"))
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

function createLoggerStub() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as never
}

function insertSession(storage: StorageEngine, id: string, projectRoot: string): void {
  storage.insertSession({
    id,
    agentType: AgentType.Build,
    status: SessionStatus.Active,
    startedAt: Date.now(),
    endedAt: null,
    durationMs: null,
    filesChangedCount: 0,
    toolsUsedCount: 0,
    errorsCount: 0,
    projectRoot,
    messageCount: 0,
    totalTokensUsed: 0,
    compactedFrom: null,
  } as never)
}

function insertEdit(storage: StorageEngine, projectRoot: string, filePath: string, sessionId: string): void {
  storage.insertFileEdit({
    filePath,
    sessionId,
    agentType: AgentType.Build,
    editType: EditType.Update,
    diffPreview: null,
    linesAdded: 1,
    linesRemoved: 0,
    timestamp: Date.now(),
    projectRoot,
    wasReverted: false,
    fileLanguage: "ts",
    diffHash: null,
  } as never)
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

describe("TUI integration (plugin 1.18.x contract)", () => {
  test("uses the event hook for /shadow and does not register tui.prompt.append", async () => {
    const storage = createStorage()
    insertSession(storage, "session-1", "C:/project-a")

    const calls: Array<{ body?: { message?: string } }> = []
    const hooks = createTuiIntegration(
      storage,
      {
        dbPath: "ignored",
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
      } as never,
      createLoggerStub(),
      { tui: { showToast: async (payload: unknown) => { calls.push(payload as never); return true } } },
    )

    expect("tui.prompt.append" in hooks).toBe(false)
    expect(typeof hooks.event).toBe("function")

    await hooks.event({
      event: { type: "tui.prompt.append", properties: { text: "/shadow stats" } },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].body?.message).toContain("1 сессий")
  })

  test("compaction reads project from sessionID and scopes memory/hotspots", async () => {
    const storage = createStorage()
    insertSession(storage, "session-a", "C:/project-a")
    insertSession(storage, "session-b", "C:/project-b")

    storage.upsertNode({
      nodeType: NodeType.Concept,
      name: "Alpha fact",
      path: null,
      projectRoot: "C:/project-a",
      metadata: { category: "ARCHITECTURE", content: "ALPHA-FACT" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never)
    storage.upsertNode({
      nodeType: NodeType.Concept,
      name: "Beta fact",
      path: null,
      projectRoot: "C:/project-b",
      metadata: { category: "ARCHITECTURE", content: "BETA-FACT" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never)

    insertEdit(storage, "C:/project-a", "src/alpha-file.ts", "session-a")
    insertEdit(storage, "C:/project-a", "src/alpha-file.ts", "session-a")
    insertEdit(storage, "C:/project-b", "src/beta-file.ts", "session-b")
    insertEdit(storage, "C:/project-b", "src/beta-file.ts", "session-b")

    const hooks = createTuiIntegration(
      storage,
      {
        dbPath: "ignored",
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
      } as never,
      createLoggerStub(),
    )

    const output: { context: string[] } = { context: [] }
    await hooks["experimental.session.compacting"]({ sessionID: "session-a" }, output)

    const briefing = output.context.join("\n")
    expect(briefing).toContain("ALPHA-FACT")
    expect(briefing).not.toContain("BETA-FACT")
    expect(briefing).toContain("alpha-file.ts")
    expect(briefing).not.toContain("beta-file.ts")
  })
})
