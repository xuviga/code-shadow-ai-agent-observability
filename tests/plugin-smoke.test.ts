import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const HOME_KEYS = ["USERPROFILE", "HOME"] as const
const originalHome: Record<string, string | undefined> = {}

for (const key of HOME_KEYS) originalHome[key] = process.env[key]

let tempHome = ""

function useTempHome(): string {
  tempHome = mkdtempSync(join(tmpdir(), "code-shadow-plugin-home-"))
  mkdirSync(join(tempHome, ".config", "opencode"), { recursive: true })
  for (const key of HOME_KEYS) process.env[key] = tempHome
  return tempHome
}

afterEach(() => {
  for (const key of HOME_KEYS) {
    if (originalHome[key] === undefined) delete process.env[key]
    else process.env[key] = originalHome[key]
  }
  if (tempHome) {
    try {
      rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
    } catch {
      // Best-effort cleanup on Windows WAL handles.
    }
    tempHome = ""
  }
})

describe("plugin entrypoint smoke", () => {
  test("loads, registers tools, records an SDK-shaped session and disposes", async () => {
    const home = useTempHome()
    const projectDir = mkdtempSync(join(tmpdir(), "code-shadow-plugin-project-"))
    const toastCalls: unknown[] = []
    const client = {
      tui: { showToast: async (payload: unknown) => { toastCalls.push(payload); return true } },
    }

    const module = await import("../src/index")
    const hooks = await module.CodeShadow({
      client,
      project: { id: "smoke-project" },
      directory: projectDir,
      worktree: projectDir,
      serverUrl: "http://localhost",
      experimental_workspace: {},
      $: async () => ({}),
    } as never)

    try {
      expect(Object.keys(hooks.tool as Record<string, unknown>)).toHaveLength(16)
      expect(typeof hooks.dispose).toBe("function")

      // Real SDK shape: session has no agent field.
      await hooks.event({
        event: { type: "session.created", properties: { info: { id: "smoke-session", directory: projectDir, time: { created: Date.now() } } } },
      })
      // Agent arrives with the user message.
      await hooks["chat.message"](
        { sessionID: "smoke-session", agent: "build" },
        { parts: [{ type: "text", text: "hi" }] },
      )
      await hooks["tool.execute.before"](
        { tool: "write", sessionID: "smoke-session", callID: "smoke-call" },
        { args: { filePath: "src/smoke.ts" } },
      )
      await hooks["tool.execute.after"](
        { tool: "write", sessionID: "smoke-session", callID: "smoke-call", args: { filePath: "src/smoke.ts" } },
        { title: "write", output: "", metadata: {} },
      )
      // Real SDK shape: file.edited only carries the file path.
      await hooks.event({ event: { type: "file.edited", properties: { file: "src/smoke.ts" } } })
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "smoke-session" } } })

      const dbPath = join(home, ".config", "opencode", "shadow", "data.db")
      expect(existsSync(dbPath)).toBe(true)
      const db = new Database(dbPath, { readonly: true })
      const session = db.prepare("SELECT agent_type, status, files_changed_count, tools_used_count FROM sessions WHERE id = ?1").get("smoke-session") as Record<string, unknown>
      const edits = db.prepare("SELECT COUNT(*) AS cnt FROM file_edits WHERE session_id = ?1").get("smoke-session") as { cnt: number }
      const tools = db.prepare("SELECT COUNT(*) AS cnt FROM tool_executions WHERE session_id = ?1").get("smoke-session") as { cnt: number }
      db.close()

      expect(session.agent_type).toBe("build")
      expect(session.status).toBe("idle")
      expect(Number(session.files_changed_count)).toBe(1)
      expect(Number(session.tools_used_count)).toBe(1)
      expect(edits.cnt).toBe(1)
      expect(tools.cnt).toBe(1)
      expect(existsSync(join(home, ".config", "opencode", "CRUSH.md"))).toBe(true)
      expect(existsSync(join(home, ".config", "opencode", "tui.json"))).toBe(true)
      expect(toastCalls.length).toBeGreaterThanOrEqual(0)
    } finally {
      await hooks.dispose?.()
      try {
        rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
      } catch {
        // Best-effort cleanup.
      }
    }
  })
})
