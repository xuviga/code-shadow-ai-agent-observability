import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The plugin resolves "~" from the environment on every call (src/config.ts),
// so isolating HOME/USERPROFILE makes the DB and CRUSH.md live in a temp dir.
const HOME_KEYS = ["USERPROFILE", "HOME"] as const
const originalHome: Record<string, string | undefined> = {}

for (const key of HOME_KEYS) originalHome[key] = process.env[key]

let tempHome = ""
let tempProject = ""

function useTempHome(): string {
  tempHome = mkdtempSync(join(tmpdir(), "code-shadow-v2-home-"))
  mkdirSync(join(tempHome, ".config", "opencode"), { recursive: true })
  for (const key of HOME_KEYS) process.env[key] = tempHome
  return tempHome
}

afterEach(() => {
  for (const key of HOME_KEYS) {
    if (originalHome[key] === undefined) delete process.env[key]
    else process.env[key] = originalHome[key]
  }
  for (const directory of [tempProject, tempHome]) {
    if (!directory) continue
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
    } catch {
      // Best-effort cleanup on Windows WAL handles.
    }
  }
  tempProject = ""
  tempHome = ""
})

// ---------------------------------------------------------------------------
// Fake OpenCode 2 event stream
// ---------------------------------------------------------------------------

type FeedEvent = {
  type: string
  created?: number
  location?: { directory?: string }
  data?: Record<string, unknown>
}

type FeedResult = IteratorResult<FeedEvent>

function createEventFeed() {
  const queue: FeedEvent[] = []
  const waiters: Array<(result: FeedResult) => void> = []
  let closed = false

  function push(event: FeedEvent): void {
    if (closed) return
    const waiter = waiters.shift()
    if (waiter) waiter({ done: false, value: event })
    else queue.push(event)
  }

  function close(): void {
    closed = true
    queue.length = 0
    while (waiters.length > 0) waiters.shift()!({ done: true, value: undefined })
  }

  function subscribe(options?: { signal?: AbortSignal }): AsyncIterable<FeedEvent> {
    const signal = options?.signal
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<FeedEvent, void, unknown> {
        while (true) {
          if (closed || signal?.aborted) return
          const buffered = queue.shift()
          if (buffered) {
            yield buffered
            continue
          }
          const result = await new Promise<FeedResult>((resolve) => {
            waiters.push(resolve)
            signal?.addEventListener(
              "abort",
              () => {
                const index = waiters.indexOf(resolve)
                if (index >= 0) waiters.splice(index, 1)
                resolve({ done: true, value: undefined })
              },
              { once: true },
            )
          })
          if (result.done) return
          yield result.value
        }
      },
    }
  }

  /**
   * Resolves once every pushed event has been fully handled: the consumer has
   * finished its loop body and asked the generator for the next item. This is
   * stronger than a queue-length check and removes dispose races.
   */
  async function waitForDrain(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (closed || (queue.length === 0 && waiters.length > 0)) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`event feed did not drain within ${timeoutMs}ms`)
  }

  return { push, close, subscribe, waitForDrain }
}

async function waitFor(
  condition: () => boolean,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

// ---------------------------------------------------------------------------
// DB readers (read-only, so they work while the plugin owns the writer)
// ---------------------------------------------------------------------------

const DB_RELATIVE_PATH = join(".config", "opencode", "shadow", "data.db")

type SessionStateRow = {
  status: string
  message_count: number
  total_tokens_used: number
  file_edits: number
}

function readSessionState(dbPath: string, sessionID: string): SessionStateRow | null {
  const db = new Database(dbPath, { readonly: true })
  try {
    const row = db
      .prepare(
        `SELECT status, message_count, total_tokens_used,
           (SELECT COUNT(*) FROM file_edits WHERE session_id = ?1) AS file_edits
         FROM sessions WHERE id = ?1`,
      )
      .get(sessionID) as SessionStateRow | undefined
    return row ?? null
  } finally {
    db.close()
  }
}

function readSessionFileEdits(
  dbPath: string,
  sessionID: string,
): Array<{ file_path: string; session_id: string; project_root: string | null }> {
  const db = new Database(dbPath, { readonly: true })
  try {
    return db
      .prepare("SELECT file_path, session_id, project_root FROM file_edits WHERE session_id = ?1")
      .all(sessionID) as Array<{ file_path: string; session_id: string; project_root: string | null }>
  } finally {
    db.close()
  }
}

function readDeveloperEventTypes(dbPath: string, sessionID: string): string[] {
  const db = new Database(dbPath, { readonly: true })
  try {
    const rows = db
      .prepare("SELECT event_type FROM developer_events WHERE session_id = ?1")
      .all(sessionID) as Array<{ event_type: string }>
    return rows.map((row) => row.event_type)
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// Fake V2 setup context
// ---------------------------------------------------------------------------

type FakeToolDefinition = { name: string; [key: string]: unknown }
type FakeToolEditor = { add: (definition: FakeToolDefinition) => void }

function createFakeContext(projectDirectory: string, feed: ReturnType<typeof createEventFeed>) {
  const tools = new Map<string, { id: string }>()
  const domainRegistration = { dispose: () => {} }
  const state = { subscribedTypes: [] as readonly string[] }

  const ctx = {
    app: { version: "2.3.0-test" },
    location: {
      directory: projectDirectory,
      project: {
        id: "project_test",
        directory: projectDirectory,
        canonical: projectDirectory,
      },
    },
    tool: {
      transform: async (transform: (editor: FakeToolEditor) => void) => {
        transform({
          add: (definition) => {
            tools.set(definition.name, { id: definition.name })
          },
        })
        return domainRegistration
      },
      hook: async () => domainRegistration,
      list: async () => [...tools.values()],
    },
    session: { hook: async () => domainRegistration },
    permission: { hook: async () => domainRegistration },
    event: {
      subscribe: (options?: { types?: readonly string[]; signal?: AbortSignal }) => {
        state.subscribedTypes = options?.types ?? []
        return feed.subscribe({ signal: options?.signal })
      },
    },
  }

  return { ctx, tools, state }
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("v2 plugin setup", () => {
  test("records step files, tokens and turn completion, then disposes", async () => {
    const home = useTempHome()
    tempProject = mkdtempSync(join(tmpdir(), "code-shadow-v2-project-"))
    const projectDirectory = tempProject
    const dbPath = join(home, DB_RELATIVE_PATH)
    const sessionID = "ses_v2_setup"

    const feed = createEventFeed()
    const { ctx, tools, state } = createFakeContext(projectDirectory, feed)

    // Import after HOME is redirected so the V2 log path also stays isolated.
    const module = await import("../src/v2")
    const plugin = module.default

    let dispose: (() => Promise<void> | void) | undefined
    try {
      const cleanup = await plugin.setup(ctx as never)
      dispose = typeof cleanup === "function" ? cleanup : undefined
      expect(typeof dispose).toBe("function")

      const toolNames = [...tools.keys()]
      expect(toolNames).toHaveLength(18)
      expect(toolNames.filter((id) => id.startsWith("code_shadow_"))).toHaveLength(18)
      expect(state.subscribedTypes).toHaveLength(14)
      expect(state.subscribedTypes).toContain("session.execution.succeeded")
      expect(state.subscribedTypes).toContain("session.execution.interrupted")

      feed.push({
        type: "session.created",
        created: Date.now(),
        location: { directory: projectDirectory },
        data: { sessionID, agent: "build", location: { directory: projectDirectory } },
      })
      feed.push({
        type: "session.step.ended",
        created: Date.now(),
        location: { directory: projectDirectory },
        data: {
          sessionID,
          assistantMessageID: "msg_v2_setup",
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
          files: ["src/a.ts"],
        },
      })
      feed.push({
        type: "session.execution.succeeded",
        created: Date.now(),
        location: { directory: projectDirectory },
        data: { sessionID },
      })

      await feed.waitForDrain()
      await waitFor(
        () => readSessionState(dbPath, sessionID)?.status === "idle",
        "session to become idle",
      )

      const session = readSessionState(dbPath, sessionID)
      expect(session).not.toBeNull()
      expect(session!.status).toBe("idle")
      expect(Number(session!.message_count)).toBe(1)
      expect(Number(session!.total_tokens_used)).toBe(110)
      expect(Number(session!.file_edits)).toBe(1)

      const edits = readSessionFileEdits(dbPath, sessionID)
      expect(edits).toHaveLength(1)
      // V2 reports workspace-relative files; the bridge stores them absolute.
      expect(edits[0].file_path).toBe(join(projectDirectory, "src", "a.ts").replace(/\\/g, "/"))
      expect(edits[0].session_id).toBe(sessionID)
      expect(edits[0].project_root).toBe(projectDirectory)

      // A turn also has to surface in analytics, not only in file_edits.
      const beforeDisposeEvents = readDeveloperEventTypes(dbPath, sessionID)
      expect(beforeDisposeEvents).toContain("session_started")
    } finally {
      if (dispose) {
        try {
          await dispose()
          dispose = undefined
        } catch (err) {
          // Re-throw so the test reports a failing dispose.
          throw err
        }
      }
      feed.close()
    }

    // dispose flushed the batch queue, so the completion event is now durable.
    const eventTypes = readDeveloperEventTypes(dbPath, sessionID)
    expect(eventTypes).toContain("session_started")
    expect(
      eventTypes.some((type) => type === "session_completed" || type === "turn_completed"),
    ).toBe(true)
  }, 30000)
})
