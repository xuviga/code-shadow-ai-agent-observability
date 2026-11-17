import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { StorageEngine } from "../src/storage"
import { SessionStatus } from "../src/types"
import { createObserver } from "../src/observer"
import {
  eventBelongsToDirectory,
  mapV2EventToV1Events,
  mapV2StepFilesToFileEdits,
  V2_EVENT_TYPES,
  V2FileSessionIndex,
  V2StepUsageBuffer,
} from "../src/v2"
import type {
  V1EventTranslation,
  V2EventLike,
  V2SessionStepEnded,
  V2SubscribableEventType,
} from "../src/v2"

const created = 1700000000000
const databases: Array<{ storage: StorageEngine; directory: string }> = []

/** Absolute forward-slash form of a workspace-relative V2 path. */
function projectFile(projectRoot: string, filePath: string): string {
  return resolve(projectRoot, filePath).replace(/\\/g, "/").replace(/\/{2,}/g, "/")
}

function createObserverFixture() {
  const directory = mkdtempSync(join(tmpdir(), "code-shadow-v2-events-"))
  const config = {
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
  }
  const storage = new StorageEngine(config)
  databases.push({ storage, directory })
  const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  const observer = createObserver(storage as never, config, log as never)
  return { storage, observer }
}

type Observer = ReturnType<typeof createObserver>

async function feed(observer: Observer, translations: V1EventTranslation[]): Promise<void> {
  for (const translated of translations) {
    if (translated.type === "file.edited") {
      await observer["file.edited"](translated.properties as never, {})
    } else {
      await observer.event({ event: translated })
    }
  }
}

function sessionCreatedEvent(sessionID: string, directory: string): V2EventLike {
  return {
    type: "session.created",
    created,
    data: { sessionID, agent: "build", location: { directory } },
  }
}

function stepEndedEvent(
  sessionID: string,
  messageID: string,
  input: number,
  output: number,
  options: { files?: string[]; cost?: number } = {},
): V2SessionStepEnded {
  return {
    type: "session.step.ended",
    created,
    data: {
      sessionID,
      assistantMessageID: messageID,
      tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: options.cost,
      files: options.files,
    },
  }
}

afterEach(() => {
  while (databases.length > 0) {
    const item = databases.pop()!
    item.storage.close()
    try {
      rmSync(item.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
    } catch {
      // Best-effort cleanup on Windows; the directory is under the OS temp dir.
    }
  }
})

describe("V2 -> V1 event bridge", () => {
  test("subscription names come from the real ctx.event.subscribe union", () => {
    // Compile-time assertion: V2SubscribableEventType is derived from
    // Parameters<Context["event"]["subscribe"]>, not from a copied list.
    const checked: readonly V2SubscribableEventType[] = V2_EVENT_TYPES
    expect(checked).toHaveLength(14)
    expect(new Set(checked).size).toBe(checked.length)
    expect(checked).toContain("session.execution.succeeded")
    expect(checked).toContain("session.execution.interrupted")
  })

  test("session.created becomes the V1 info payload", () => {
    const [translation] = mapV2EventToV1Events(sessionCreatedEvent("ses_1", "D:/project"))

    expect(translation.type).toBe("session.created")
    expect(translation.properties.info).toMatchObject({
      id: "ses_1",
      agent: "build",
      directory: "D:/project",
      time: { created },
    })
  })

  test("session.created falls back to the setup directory", () => {
    const [translation] = mapV2EventToV1Events(
      { type: "session.created", created, data: { sessionID: "ses_1" } },
      "D:/fallback",
    )

    expect(translation.properties.info).toMatchObject({ directory: "D:/fallback" })
  })

  test("session.status keeps the V2 status object", () => {
    const [translation] = mapV2EventToV1Events({
      type: "session.status",
      created,
      data: { sessionID: "ses_1", status: { type: "idle" } },
    })

    expect(translation).toEqual({
      type: "session.status",
      properties: { sessionID: "ses_1", status: { type: "idle" } },
    })
  })

  test("session.idle and session.deleted carry the V1 session id fields", () => {
    const [idle] = mapV2EventToV1Events({
      type: "session.idle",
      created,
      data: { sessionID: "ses_1" },
    })
    expect(idle).toEqual({ type: "session.idle", properties: { sessionID: "ses_1" } })

    const [deleted] = mapV2EventToV1Events({
      type: "session.deleted",
      created,
      data: { sessionID: "ses_1" },
    })
    expect(deleted).toEqual({ type: "session.deleted", properties: { info: { id: "ses_1" } } })
  })

  test("per-turn execution completion and interruption become session.idle", () => {
    const [succeeded] = mapV2EventToV1Events({
      type: "session.execution.succeeded",
      created,
      data: { sessionID: "ses_1" },
    })
    expect(succeeded).toEqual({ type: "session.idle", properties: { sessionID: "ses_1" } })

    const [interrupted] = mapV2EventToV1Events({
      type: "session.execution.interrupted",
      created,
      data: { sessionID: "ses_1", reason: "user" },
    })
    expect(interrupted).toEqual({
      type: "session.idle",
      properties: { sessionID: "ses_1", interrupted: true, reason: "user" },
    })

    // A missing reason still marks the turn interrupted.
    const [withoutReason] = mapV2EventToV1Events({
      type: "session.execution.interrupted",
      created,
      data: { sessionID: "ses_1" },
    })
    expect(withoutReason).toEqual({
      type: "session.idle",
      properties: { sessionID: "ses_1", interrupted: true, reason: "" },
    })

    expect(
      mapV2EventToV1Events({ type: "session.execution.succeeded", data: {} }),
    ).toEqual([])
  })

  test("session.execution.failed becomes session.error", () => {
    const [translation] = mapV2EventToV1Events({
      type: "session.execution.failed",
      created,
      data: {
        sessionID: "ses_1",
        error: { type: "APIError", message: "provider down" },
      },
    })

    expect(translation).toEqual({
      type: "session.error",
      properties: {
        sessionID: "ses_1",
        error: { name: "APIError", data: { message: "provider down" } },
        timestamp: created,
      },
    })
  })

  test("session.compaction.ended becomes session.compacted", () => {
    const [translation] = mapV2EventToV1Events({
      type: "session.compaction.ended",
      created,
      data: { sessionID: "ses_1" },
    })

    expect(translation).toEqual({ type: "session.compacted", properties: { sessionID: "ses_1" } })
  })

  test("step events are buffered, not forwarded one-by-one", () => {
    expect(
      mapV2EventToV1Events(stepEndedEvent("ses_1", "msg_1", 10, 20)),
    ).toEqual([])
  })

  test("step files yield one file.edited translation per file", () => {
    const step = stepEndedEvent("ses_1", "msg_1", 10, 20, { files: ["src/a.ts"] })
    expect(mapV2StepFilesToFileEdits(step, "D:/project")).toEqual([
      {
        type: "file.edited",
        properties: {
          file: projectFile("D:/project", "src/a.ts"),
          type: "update",
          projectRoot: "D:/project",
          timestamp: created,
          sessionID: "ses_1",
        },
      },
    ])

    // Duplicate entries / "./" aliases inside one step collapse to one dispatch.
    expect(
      mapV2StepFilesToFileEdits(
        stepEndedEvent("ses_1", "msg_1", 10, 20, { files: ["src/a.ts", "./src/a.ts"] }),
        "D:/project",
      ),
    ).toHaveLength(1)

    // Missing files, empty arrays and missing session ids emit nothing.
    expect(mapV2StepFilesToFileEdits(stepEndedEvent("ses_1", "msg_1", 10, 20))).toEqual([])
    expect(
      mapV2StepFilesToFileEdits(
        stepEndedEvent("ses_1", "msg_1", 10, 20, { files: [] }),
        "D:/project",
      ),
    ).toEqual([])
    expect(
      mapV2StepFilesToFileEdits(
        { type: "session.step.ended", created, data: { assistantMessageID: "msg_1", files: ["src/a.ts"] } },
        "D:/project",
      ),
    ).toEqual([])
    expect(mapV2StepFilesToFileEdits(null, "D:/project")).toEqual([])
  })

  test("two steps of one message sum tokens and files before idle", () => {
    const buffer = new V2StepUsageBuffer()
    expect(buffer.add(stepEndedEvent("ses_1", "msg_1", 100, 10, { cost: 0.01, files: ["src/a.ts"] }))).toBeNull()
    expect(buffer.add(stepEndedEvent("ses_1", "msg_1", 240, 10, { cost: 0.02, files: ["src/b.ts"] }))).toBeNull()

    const flushed = buffer.flush("ses_1")
    expect(flushed.map((entry) => entry.type)).toEqual(["message.updated", "message.part.updated"])
    expect(flushed[0].properties.info).toMatchObject({
      id: "msg_1",
      role: "assistant",
      sessionID: "ses_1",
      time: { completed: created },
      tokens: {
        input: 340,
        output: 20,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      cost: 0.03,
    })
    expect(flushed[1]).toEqual({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: "ses_1",
          messageID: "msg_1",
          type: "patch",
          files: ["src/a.ts", "src/b.ts"],
        },
      },
    })
  })

  test("a step after idle is emitted immediately", () => {
    const buffer = new V2StepUsageBuffer()
    buffer.markIdle("ses_1")

    const immediate = buffer.add(stepEndedEvent("ses_1", "msg_late", 100, 10))
    expect(immediate?.type).toBe("message.updated")
    expect(immediate?.properties.info).toMatchObject({
      sessionID: "ses_1",
      tokens: { input: 100, output: 10 },
    })
    expect(buffer.flush("ses_1")).toEqual([])
  })

  test("two steps of one message produce messageCount=1 and 360 total tokens", async () => {
    const { storage, observer } = createObserverFixture()
    const sessionID = "ses_tokens"

    await feed(observer, mapV2EventToV1Events(sessionCreatedEvent(sessionID, "D:/project")))

    const buffer = new V2StepUsageBuffer()
    buffer.add(stepEndedEvent(sessionID, "msg_1", 100, 10)) // 110
    buffer.add(stepEndedEvent(sessionID, "msg_1", 240, 10)) // 250
    await feed(observer, buffer.flush(sessionID))

    await feed(
      observer,
      mapV2EventToV1Events({ type: "session.idle", created: created + 1000, data: { sessionID } }),
    )
    storage.flushBatch()

    const session = storage.getSession(sessionID)
    expect(session).not.toBeNull()
    expect(session!.messageCount).toBe(1)
    expect(session!.totalTokensUsed).toBe(360)
  })

  test("interrupted execution marks turn_completed while a normal idle stays unflagged", async () => {
    const { storage, observer } = createObserverFixture()
    const interruptedID = "ses_interrupted"
    const normalID = "ses_normal"

    await feed(observer, mapV2EventToV1Events(sessionCreatedEvent(interruptedID, "D:/project")))
    await feed(observer, mapV2EventToV1Events(sessionCreatedEvent(normalID, "D:/project")))

    await feed(
      observer,
      mapV2EventToV1Events({
        type: "session.execution.interrupted",
        created,
        data: { sessionID: interruptedID, reason: "user" },
      }),
    )
    await feed(
      observer,
      mapV2EventToV1Events({
        type: "session.idle",
        created: created + 1000,
        data: { sessionID: normalID },
      }),
    )
    storage.flushBatch()

    // An interrupted turn is still a completed (idle) turn.
    expect(storage.getSession(interruptedID)!.status).toBe(SessionStatus.Idle)

    const rows = storage.queryRows<{ session_id: string; metadata: string }>(
      "SELECT session_id, metadata FROM developer_events WHERE event_type = 'turn_completed' AND session_id IN (?1, ?2)",
      interruptedID,
      normalID,
    )
    const metadataBySession = new Map(
      rows.map((row) => [row.session_id, JSON.parse(row.metadata) as Record<string, unknown>]),
    )

    expect(metadataBySession.get(interruptedID)).toMatchObject({
      kind: "turn",
      interrupted: true,
      interrupt_reason: "user",
    })
    expect(metadataBySession.get(normalID)).toMatchObject({
      kind: "turn",
      interrupted: false,
      interrupt_reason: null,
    })
  })

  test("filesystem.changed change becomes update + watcher with a session hint", () => {
    const translations = mapV2EventToV1Events(
      {
        type: "filesystem.changed",
        created,
        data: { file: "src/a.ts", event: "change" },
      },
      "D:/project",
      "ses_1",
    )

    expect(translations).toEqual([
      {
        type: "file.edited",
        properties: {
          file: projectFile("D:/project", "src/a.ts"),
          type: "update",
          projectRoot: "D:/project",
          timestamp: created,
          sessionID: "ses_1",
        },
      },
      {
        type: "file.watcher.updated",
        properties: { file: projectFile("D:/project", "src/a.ts"), event: "change" },
      },
    ])
  })

  test("filesystem.changed add becomes create without a watcher event", () => {
    const translations = mapV2EventToV1Events(
      {
        type: "filesystem.changed",
        created,
        data: { file: "src/new.ts", event: "add" },
      },
      "D:/project",
    )

    expect(translations).toEqual([
      {
        type: "file.edited",
        properties: {
          file: projectFile("D:/project", "src/new.ts"),
          type: "create",
          projectRoot: "D:/project",
          timestamp: created,
        },
      },
    ])
  })

  test("filesystem.changed unlink is a no-op by V1 design", () => {
    const translations = mapV2EventToV1Events({
      type: "filesystem.changed",
      created,
      data: { file: "src/a.ts", event: "unlink" },
    })

    expect(translations).toEqual([])
  })

  test("tui.prompt.append keeps text and accepts the active session hint", () => {
    const [translation] = mapV2EventToV1Events(
      {
        type: "tui.prompt.append",
        created,
        data: { text: "/shadow stats" },
      },
      "",
      "ses_1",
    )

    expect(translation).toEqual({
      type: "tui.prompt.append",
      properties: { text: "/shadow stats", sessionID: "ses_1" },
    })
  })

  test("tui.command.execute becomes command.executed with the active session", () => {
    const [translation] = mapV2EventToV1Events(
      {
        type: "tui.command.execute",
        created,
        data: { command: "session.compact" },
      },
      "",
      "ses_1",
    )

    expect(translation).toEqual({
      type: "command.executed",
      properties: {
        name: "session.compact",
        arguments: "",
        timestamp: created,
        sessionID: "ses_1",
      },
    })
    expect(mapV2EventToV1Events({ type: "tui.command.execute", data: {} })).toEqual([])
  })

  test("server.connected and malformed payloads are ignored safely", () => {
    expect(mapV2EventToV1Events({ type: "server.connected", data: {} })).toEqual([])
    expect(mapV2EventToV1Events(null)).toEqual([])
    expect(mapV2EventToV1Events({ type: "session.created", data: {} })).toEqual([])
    expect(mapV2EventToV1Events({ type: "session.status", data: { status: { type: "busy" } } })).toEqual([])
    expect(mapV2EventToV1Events({ type: "filesystem.changed", data: {} })).toEqual([])

    const buffer = new V2StepUsageBuffer()
    expect(
      buffer.add({ type: "session.step.ended", created, data: { sessionID: "ses_1" } }),
    ).toBeNull()
  })

  test("tool.execute.after writes tool_executions but not file_edits", async () => {
    const { storage, observer } = createObserverFixture()
    await feed(observer, mapV2EventToV1Events(sessionCreatedEvent("ses_tool", "D:/project")))

    await observer["tool.execute.after"](
      { tool: "edit", sessionID: "ses_tool", callID: "call_1", args: { filePath: "src/tool.ts" } },
      { title: "", output: "ok", metadata: {} },
    )
    storage.flushBatch()

    // Evidence for keeping filesystem.changed -> file.edited: the V1 tool path
    // records tool_executions only (observer.ts:2152); file_edits are written
    // exclusively by the file.edited handlers (observer.ts:1261, 2222).
    expect(storage.getFileEdits("src/tool.ts")).toHaveLength(0)
  })

  test("step files attribute file_edits to the session that actually edited", async () => {
    const { storage, observer } = createObserverFixture()

    // B is created last, so V1's currentSessionId would otherwise point at B.
    await feed(observer, mapV2EventToV1Events(sessionCreatedEvent("ses_a", "D:/a")))
    await feed(observer, mapV2EventToV1Events(sessionCreatedEvent("ses_b", "D:/b")))

    const index = new V2FileSessionIndex()
    index.remember(["src/shared.ts"], "ses_a", created)
    const hint = index.resolve("D:/a/src/shared.ts", created)
    expect(hint).toBe("ses_a")

    await feed(
      observer,
      mapV2EventToV1Events(
        { type: "filesystem.changed", created, data: { file: "D:/a/src/shared.ts", event: "change" } },
        "D:/a",
        hint,
      ),
    )
    storage.flushBatch()

    const edits = storage.getFileEdits("D:/a/src/shared.ts")
    expect(edits).toHaveLength(1)
    expect(edits[0].sessionId).toBe("ses_a")
    expect(edits[0].projectRoot).toBe("D:/a")
  })

  test("agent edit writes file_edits once and the paired watcher adds no human_fix", async () => {
    const { storage, observer } = createObserverFixture()
    await feed(observer, mapV2EventToV1Events(sessionCreatedEvent("ses_watch", "D:/project")))

    // tool.execute.after records the agent edit timestamp used by the
    // human-fix heuristic, but does not write file_edits itself.
    await observer["tool.execute.after"](
      { tool: "edit", sessionID: "ses_watch", callID: "call_edit", args: { filePath: "src/watched.ts" } },
      { title: "", output: "ok", metadata: {} },
    )

    const translations = mapV2EventToV1Events(
      { type: "filesystem.changed", created, data: { file: "src/watched.ts", event: "change" } },
      "D:/project",
      "ses_watch",
    )
    await feed(observer, translations)
    storage.flushBatch()

    const watchedFile = projectFile("D:/project", "src/watched.ts")
    expect(storage.getFileEdits(watchedFile)).toHaveLength(1)
    const humanFixes = storage.queryRows<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM developer_events WHERE event_type = 'human_fix' AND file_path = ?1",
      watchedFile,
    )
    // The watcher is part of the same agent edit, not a human fix.
    expect(humanFixes[0]?.cnt ?? 0).toBe(0)
  })

  test("step files plus the paired filesystem.changed write one file_edit row", async () => {
    const { storage, observer } = createObserverFixture()
    const sessionID = "ses_step_files"
    await feed(observer, mapV2EventToV1Events(sessionCreatedEvent(sessionID, "D:/project")))

    const step = stepEndedEvent(sessionID, "msg_1", 100, 10, { files: ["src/step.ts"] })
    await feed(observer, mapV2StepFilesToFileEdits(step, "D:/project"))
    // The broad filesystem watcher still sees the same change. V1's 1.5s
    // dedupe must keep this from becoming a second file_edits row.
    await feed(
      observer,
      mapV2EventToV1Events(
        { type: "filesystem.changed", created: created + 200, data: { file: "src/step.ts", event: "change" } },
        "D:/project",
        sessionID,
      ),
    )
    storage.flushBatch()

    const stepFile = projectFile("D:/project", "src/step.ts")
    const edits = storage.getFileEdits(stepFile)
    expect(edits).toHaveLength(1)
    expect(edits[0].sessionId).toBe(sessionID)
    expect(edits[0].projectRoot).toBe("D:/project")
  })

  test("file session index expires stale hints and bridges relative to absolute paths", () => {
    const index = new V2FileSessionIndex()
    index.remember(["src/a.ts", "src/b.ts"], "ses_old", created)

    expect(index.resolve("D:/project/src/a.ts", created + 1000)).toBe("ses_old")
    expect(index.resolve("D:/project/src/a.ts", created + 11 * 60 * 1000)).toBe("")
  })

  test("relative suffix collisions are never guessed", () => {
    const index = new V2FileSessionIndex()
    index.remember(["a/b.ts"], "ses_a", created)
    index.remember(["x/a/b.ts"], "ses_b", created)

    // Exact path has priority over every suffix match.
    expect(index.resolve("a/b.ts", created + 1000)).toBe("ses_a")

    // Without an exact record, a relative-vs-relative suffix is a different
    // file and must not resolve to B.
    const onlyB = new V2FileSessionIndex()
    onlyB.remember(["x/a/b.ts"], "ses_b", created)
    expect(onlyB.resolve("a/b.ts", created + 1000)).toBe("")

    // An absolute event matching two relative hints is ambiguous: no guess.
    const ambiguous = new V2FileSessionIndex()
    ambiguous.remember(["src/a.ts"], "ses_a", created)
    ambiguous.remember(["project/src/a.ts"], "ses_b", created)
    expect(ambiguous.resolve("D:/project/src/a.ts", created + 1000)).toBe("")
  })

  test("two sessions editing one file keep both records and resolve deterministically", () => {
    const index = new V2FileSessionIndex()
    index.remember(["src/shared.ts"], "ses_a", created)
    index.remember(["src/shared.ts"], "ses_b", created + 1000)

    // Both records are alive: an explicit active session can select the older one.
    expect(index.resolve("src/shared.ts", created + 2000, "ses_a")).toBe("ses_a")
    // Without a preference the freshest entry wins.
    expect(index.resolve("src/shared.ts", created + 2000)).toBe("ses_b")

    // Equal timestamps tie-break by session id, deterministically.
    const tie = new V2FileSessionIndex()
    tie.remember(["src/tie.ts"], "ses_z", created)
    tie.remember(["src/tie.ts"], "ses_a", created)
    expect(tie.resolve("src/tie.ts", created + 1000)).toBe("ses_a")
  })
})

describe("location filter", () => {
  test("matches the instance directory despite Windows slashes and casing", () => {
    expect(
      eventBelongsToDirectory(
        { type: "session.created", created, data: { location: { directory: "D:\\Code\\Shadow" } } },
        "d:/code/shadow",
      ),
    ).toBe(true)

    // The location may be mirrored at the top level instead of data.location.
    expect(
      eventBelongsToDirectory(
        { type: "session.created", created, location: { directory: "C:\\Users\\Dev\\PROJECT\\" }, data: {} },
        "c:/users/dev/project",
      ),
    ).toBe(true)

    // A trailing separator is not a different workspace.
    expect(
      eventBelongsToDirectory(
        { type: "session.created", created, data: { location: { directory: "/work/app/" } } },
        "/work/app",
      ),
    ).toBe(true)
  })

  test("rejects a known foreign directory", () => {
    expect(
      eventBelongsToDirectory(
        { type: "session.created", created, data: { location: { directory: "D:/other-workspace" } } },
        "D:/project",
      ),
    ).toBe(false)
    expect(
      eventBelongsToDirectory(
        { type: "session.created", created, location: { directory: "/other" }, data: {} },
        "/project",
      ),
    ).toBe(false)
  })

  test("events without a location are global and always pass", () => {
    expect(
      eventBelongsToDirectory({ type: "tui.prompt.append", created, data: { text: "x" } }, "D:/project"),
    ).toBe(true)
    expect(
      eventBelongsToDirectory({ type: "server.connected", created, data: {} }, ""),
    ).toBe(true)
    expect(eventBelongsToDirectory(null, "D:/project")).toBe(true)
  })
})
