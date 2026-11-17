// =============================================================================
// Code Shadow — OpenCode 2 (v2 plugin API) adapter
//
// The core (storage, observer, tools, TUI integration) is shared with the V1
// entrypoint in ./index.ts. OpenCode 2 cannot execute V1 plugin objects, so this
// file loads the V1 implementation and re-registers its tools and hooks through
// the V2 domains (`ctx.tool`, `ctx.session`, `ctx.permission`, `ctx.event`).
// =============================================================================

import { Plugin } from "@opencode/plugin"
import { tool as v1tool } from "@opencode-ai/plugin"
import * as fs from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import CodeShadowV1 from "./index.js"
import { normalizeProjectPath } from "./project-path.js"

type AnyRecord = Record<string, any>

const v2LogFile = join(homedir(), ".local", "share", "opencode", "log", "code-shadow-v2.log")

function writeV2Log(message: string, details?: unknown): void {
  try {
    const suffix =
      details === undefined
        ? ""
        : " " +
          (details instanceof Error
            ? `${details.message}\n${details.stack ?? ""}`
            : typeof details === "string"
              ? details
              : JSON.stringify(details))
    fs.appendFileSync(v2LogFile, `${new Date().toISOString()} ${message}${suffix}\n`, "utf8")
  } catch {
    // never break plugin setup because diagnostics cannot be written
  }
}

function toJsonSchema(args: AnyRecord): AnyRecord {
  const schema = v1tool.schema.object((args ?? {}) as any)
  const json = v1tool.schema.toJSONSchema(schema as any) as AnyRecord
  delete json.$schema
  return json
}

function toV2Result(result: any): AnyRecord {
  if (typeof result === "string") return { content: result }
  if (result && typeof result === "object") {
    const content =
      typeof result.output === "string"
        ? result.output
        : Array.isArray(result.content)
          ? result.content
              .filter((part: any) => part?.type === "text" && typeof part.text === "string")
              .map((part: any) => part.text)
              .join("\n")
          : ""
    return { content, metadata: result.metadata }
  }
  return { content: String(result ?? "") }
}

function resultText(result: any): string {
  if (typeof result?.content === "string") return result.content
  if (Array.isArray(result?.content)) {
    return result.content
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("\n")
  }
  if (typeof result?.output === "string") return result.output
  return ""
}

// ---------------------------------------------------------------------------
// V2 -> V1 event bridge
//
// OpenCode 2 uses its own event vocabulary. The names below are the exact
// literals accepted by `OpenCodeClient["event"]["subscribe"]` in
// @opencode/plugin 2.3.0 -> @opencode/client 2.3.0
// (dist/promise/client.d.ts, the `event.subscribe<Type extends ...>` union).
// Every event payload is `{ type, data }`; the V1 SDK handlers expect
// `{ event: { type, properties } }`, so each type needs a field-by-field
// translation.
//
// `session.execution.succeeded` / `session.execution.interrupted` are mapped to
// V1 `session.idle`: per-turn completion is what flushes the step-usage buffer
// and turns the session idle (V2 does not re-emit `session.idle` per turn).
// The interrupted translation also carries `interrupted: true` + `reason`, so
// the observer can flag `turn_completed` without changing the idle semantics.
//
// Missing from the V2 subscription union (verified against the same type):
//   message.updated, message.part.updated, todo.updated, session.updated,
//   command.executed, lsp.client.diagnostics, lsp.updated, lsp.diagnostic.
// `message.updated` / `message.part.updated` are approximated from
// `session.step.ended` (tokens + files) because they are the only V2 events
// that carry per-assistant-message usage and changed-file data. `todo.updated`
// and LSP diagnostics have no V2 equivalent at all (OpenCode 2 emits no such
// events), so those V1 handlers stay disabled. `session.message.content.updated`
// and `session.usage.recorded` appear only in SessionEventDurable: they are
// absent from the public V2Event / EventSubscribeOutput union and from the
// client subscribe union, so they cannot be subscribed to.
// ---------------------------------------------------------------------------

type V2SetupContext = Parameters<Plugin.Plugin["setup"]>[0]

/** Event names accepted by the real `ctx.event.subscribe` union in @opencode/plugin 2.3.0. */
export type V2SubscribableEventType = NonNullable<
  NonNullable<Parameters<V2SetupContext["event"]["subscribe"]>[0]>["types"]
>[number]

export type V2LocationLike = { directory?: string }
export type V2TokenUsageLike = {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

/**
 * Structural subset of the fourteen V2 events this adapter consumes. The real
 * payloads carry more fields (id, durable, metadata, ...), which are ignored.
 */
export type V2EventLike =
  | {
      type: "session.created"
      created?: number
      location?: V2LocationLike
      data: { sessionID?: string; parentID?: string; agent?: string; location?: V2LocationLike }
    }
  | {
      type: "session.deleted"
      created?: number
      location?: V2LocationLike
      data: { sessionID?: string }
    }
  | {
      type: "session.renamed"
      created?: number
      location?: V2LocationLike
      data: { sessionID?: string; title?: string }
    }
  | {
      type: "session.moved"
      created?: number
      location?: V2LocationLike
      data: { sessionID?: string; location?: V2LocationLike }
    }
  | {
      type: "session.status"
      created?: number
      location?: V2LocationLike
      data: { sessionID?: string; status?: { type?: "idle" | "retry" | "busy" } }
    }
  | {
      type: "session.idle"
      created?: number
      location?: V2LocationLike
      data: { sessionID?: string }
    }
  | {
      type: "session.execution.succeeded"
      created?: number
      location?: V2LocationLike
      data: { sessionID?: string }
    }
  | {
      type: "session.execution.interrupted"
      created?: number
      location?: V2LocationLike
      data: { sessionID?: string; reason?: string }
    }
  | {
      type: "session.execution.failed"
      created?: number
      location?: V2LocationLike
      data: { sessionID?: string; error?: { type?: string; message?: string } }
    }
  | {
      type: "session.compaction.ended"
      created?: number
      location?: V2LocationLike
      data: { sessionID?: string }
    }
  | {
      type: "session.step.ended"
      created?: number
      location?: V2LocationLike
      data: {
        sessionID?: string
        assistantMessageID?: string
        tokens?: V2TokenUsageLike
        cost?: number
        files?: string[]
      }
    }
  | {
      type: "filesystem.changed"
      created?: number
      location?: V2LocationLike
      data: { file?: string; event?: "add" | "change" | "unlink" }
    }
  | {
      type: "tui.prompt.append"
      created?: number
      location?: V2LocationLike
      data: { text?: string }
    }
  | {
      type: "tui.command.execute"
      created?: number
      location?: V2LocationLike
      data: { command?: string }
    }
  | { type: "server.connected"; created?: number; data?: unknown }

export type V2SessionStepEnded = Extract<V2EventLike, { type: "session.step.ended" }>

export type V1EventTranslation = {
  type: string
  properties: Record<string, unknown>
}

function assertV2EventTypes<T extends V2SubscribableEventType>(types: readonly T[]): readonly T[] {
  return types
}

/**
 * Compile-time checked against `ctx.event.subscribe` via V2SubscribableEventType:
 * a name removed from the host union (or a typo) fails `tsc`, not silently at runtime.
 */
export const V2_EVENT_TYPES = assertV2EventTypes([
  "session.created",
  "session.deleted",
  "session.renamed",
  "session.moved",
  "session.status",
  "session.idle",
  "session.execution.succeeded",
  "session.execution.interrupted",
  "session.execution.failed",
  "session.compaction.ended",
  "session.step.ended",
  "filesystem.changed",
  "tui.prompt.append",
  "tui.command.execute",
] as const)

function readField(source: unknown, key: string): unknown {
  return source !== null && typeof source === "object" ? Reflect.get(source, key) : undefined
}

function stringField(source: unknown, key: string): string {
  const value = readField(source, key)
  return typeof value === "string" ? value : ""
}

function numberField(source: unknown, key: string): number {
  const value = readField(source, key)
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function stringArrayField(source: unknown, key: string): string[] {
  const value = readField(source, key)
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

/**
 * Directory carried by a V2 event. Most events put it in `data.location`;
 * some also mirror it at the top level. `fallbackDirectory` is the setup
 * instance directory (OpenCode 2 exposes `ctx.location.directory`).
 */
export function eventDirectoryOf(
  event: V2EventLike | null | undefined,
  fallbackDirectory = "",
): string {
  return (
    stringField(readField(readField(event, "data"), "location"), "directory") ||
    stringField(readField(event, "location"), "directory") ||
    fallbackDirectory
  )
}

function normalizeDirectoryForCompare(value: string): string {
  let normalized = value.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/")
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, "")
  return normalized
}

function looksLikeWindowsPath(value: string): boolean {
  return /^[a-z]:\//i.test(value) || value.startsWith("\\\\")
}

/**
 * True when a V2 event addresses the same workspace as this plugin instance.
 *
 * OpenCode 2 runs one plugin instance per location and may deliver every
 * event to every instance; without this filter N workspaces would each record
 * the same session (the live DB showed 218 session_started rows for 107
 * sessions). Events with no location are global and always pass, as do
 * instances without a location. Backslashes and Windows casing are
 * normalized; a drive-letter/UNC path is compared case-insensitively even
 * when the test host is not Windows.
 */
export function eventBelongsToDirectory(
  event: V2EventLike | null | undefined,
  instanceDirectory: string,
): boolean {
  const eventDirectory =
    stringField(readField(readField(event, "data"), "location"), "directory") ||
    stringField(readField(event, "location"), "directory")
  if (!eventDirectory || !instanceDirectory) return true

  const normalizedEvent = normalizeDirectoryForCompare(eventDirectory)
  const normalizedInstance = normalizeDirectoryForCompare(instanceDirectory)
  if (!normalizedEvent || !normalizedInstance) return true

  if (
    process.platform === "win32" ||
    looksLikeWindowsPath(eventDirectory) ||
    looksLikeWindowsPath(instanceDirectory)
  ) {
    return normalizedEvent.toLowerCase() === normalizedInstance.toLowerCase()
  }
  return normalizedEvent === normalizedInstance
}

/**
 * Pure translation of one V2 event into zero or more V1 event envelopes.
 * Returns [] for events the V1 core has no handler for (including the
 * always-delivered `server.connected`), so unknown events are harmless.
 */
export function mapV2EventToV1Events(
  event: V2EventLike | null | undefined,
  fallbackDirectory = "",
  sessionIDHint = "",
): V1EventTranslation[] {
  if (!event || typeof event !== "object") return []
  const created = typeof event.created === "number" ? event.created : Date.now()
  const directory = eventDirectoryOf(event, fallbackDirectory)

  switch (event.type) {
    case "session.created": {
      const sessionID = stringField(event.data, "sessionID")
      if (!sessionID) return []
      return [
        {
          type: "session.created",
          properties: {
            info: {
              id: sessionID,
              parentID: readField(event.data, "parentID"),
              agent: stringField(event.data, "agent"),
              directory,
              time: { created },
            },
          },
        },
      ]
    }

    case "session.deleted": {
      const sessionID = stringField(event.data, "sessionID")
      if (!sessionID) return []
      return [{ type: "session.deleted", properties: { info: { id: sessionID } } }]
    }

    // V2 split the V1 `session.updated` event into granular durable events.
    // The V1 handler only uses `info.id` + `info.directory` (to backfill
    // project_root), so renamed/moved are the meaningful projections.
    case "session.renamed":
    case "session.moved": {
      const sessionID = stringField(event.data, "sessionID")
      if (!sessionID) return []
      return [{ type: "session.updated", properties: { info: { id: sessionID, directory } } }]
    }

    case "session.status": {
      const sessionID = stringField(event.data, "sessionID")
      if (!sessionID) return []
      // SessionStatus in V2 is exactly { type: "idle" | "busy" | "retry" }.
      return [
        {
          type: "session.status",
          properties: { sessionID, status: readField(event.data, "status") },
        },
      ]
    }

    case "session.idle": {
      const sessionID = stringField(event.data, "sessionID")
      if (!sessionID) return []
      return [{ type: "session.idle", properties: { sessionID } }]
    }

    // V2 ends every execution (turn) with one of these; the V1 equivalent of
    // "the turn is over" is session.idle. It flushes the step-usage buffer and
    // lets handleSessionIdle write the completion event + session status.
    // Interrupted turns stay idle too, but carry a marker so analytics can tell
    // them apart from a normal completion.
    case "session.execution.succeeded": {
      const sessionID = stringField(event.data, "sessionID")
      if (!sessionID) return []
      return [{ type: "session.idle", properties: { sessionID } }]
    }

    case "session.execution.interrupted": {
      const sessionID = stringField(event.data, "sessionID")
      if (!sessionID) return []
      return [
        {
          type: "session.idle",
          properties: {
            sessionID,
            interrupted: true,
            reason: stringField(event.data, "reason"),
          },
        },
      ]
    }

    case "session.execution.failed": {
      const sessionID = stringField(event.data, "sessionID")
      if (!sessionID) return []
      const error = readField(event.data, "error")
      return [
        {
          type: "session.error",
          properties: {
            sessionID,
            error: {
              name: stringField(error, "type") || "UnknownError",
              data: { message: stringField(error, "message") },
            },
            timestamp: created,
          },
        },
      ]
    }

    case "session.compaction.ended": {
      const sessionID = stringField(event.data, "sessionID")
      if (!sessionID) return []
      return [{ type: "session.compacted", properties: { sessionID } }]
    }

    // No V2 `message.updated` exists. `session.step.ended` is accumulated by
    // V2StepUsageBuffer and flushed as ONE message.updated before session.idle:
    // the V1 handler dedupes by message id, so forwarding each step separately
    // would record only the first step's tokens.
    case "session.step.ended":
      return []

    case "filesystem.changed": {
      const file = stringField(event.data, "file")
      if (!file) return []
      const changeKind = stringField(event.data, "event")
      // V1 has no delete semantics for these hooks: handleFileWatcherUpdated
      // only reacts to "change", and file.edited would resurrect a deletion as
      // an update. Deletions are therefore a documented no-op.
      if (changeKind === "unlink") return []
      const normalizedFile = normalizeProjectPath(directory, file)
      const editType = changeKind === "add" ? "create" : "update"
      const properties: Record<string, unknown> = {
        file: normalizedFile,
        type: editType,
        projectRoot: directory,
        timestamp: created,
      }
      if (sessionIDHint) properties.sessionID = sessionIDHint
      const translated: V1EventTranslation[] = [{ type: "file.edited", properties }]
      // Only a real modification can be a human fix after an agent edit.
      // "add" would be mislabelled as a change and V1 ignores it anyway.
      if (changeKind === "change") {
        translated.push({
          type: "file.watcher.updated",
          properties: { file: normalizedFile, event: "change" },
        })
      }
      return translated
    }

    // V2 has no command.executed event. The TUI command event is the closest
    // equivalent: it records explicit user commands such as session.compact.
    case "tui.command.execute": {
      const command = stringField(event.data, "command")
      if (!command) return []
      const properties: Record<string, unknown> = {
        name: command,
        arguments: "",
        timestamp: created,
      }
      if (sessionIDHint) properties.sessionID = sessionIDHint
      return [{ type: "command.executed", properties }]
    }

    case "tui.prompt.append": {
      const properties: Record<string, unknown> = { text: stringField(event.data, "text") }
      // V2 TuiPromptAppend has no sessionID; pass the last active one so the
      // V1 /shadow handler can resolve the right project root.
      if (sessionIDHint) properties.sessionID = sessionIDHint
      return [{ type: "tui.prompt.append", properties }]
    }

    default:
      return []
  }
}

/**
 * `file.edited` translations for the files reported by one `session.step.ended`.
 *
 * Reasons this exists instead of emitting from `mapV2EventToV1Events`:
 * the step event is buffered for token aggregation, while its files must be
 * recorded immediately so V1 `handleFileEdited` writes `file_edits`, enforces
 * Change Contracts and feeds auto-memory. V2 reports workspace-relative paths,
 * so they are resolved against the instance directory to keep `file_edits` in
 * the same absolute form as `tool_executions.target_file`.
 *
 * Files are de-duplicated per step so a repeated entry cannot produce two
 * dispatches; cross-event duplicates with `filesystem.changed` are handled by
 * V1's 1.5s `FILE_EDIT_DEDUP_MS` window.
 */
export function mapV2StepFilesToFileEdits(
  event: V2SessionStepEnded | null | undefined,
  fallbackDirectory = "",
): V1EventTranslation[] {
  if (!event || event.type !== "session.step.ended") return []
  const sessionID = stringField(event.data, "sessionID")
  if (!sessionID) return []
  const files = stringArrayField(event.data, "files")
  if (files.length === 0) return []

  const directory = eventDirectoryOf(event, fallbackDirectory)
  const timestamp = typeof event.created === "number" ? event.created : Date.now()
  const seen = new Set<string>()
  const translated: V1EventTranslation[] = []
  for (const file of files) {
    if (!file) continue
    const normalizedFile = normalizeProjectPath(directory, file)
    const key = normalizeBridgePath(normalizedFile)
    if (!key || seen.has(key)) continue
    seen.add(key)
    translated.push({
      type: "file.edited",
      properties: {
        file: normalizedFile,
        type: "update",
        projectRoot: directory,
        timestamp,
        sessionID,
      },
    })
  }
  return translated
}

// ---------------------------------------------------------------------------
// Step-usage buffer
//
// V1's message.updated handler dedupes by message id and only counts the first
// snapshot (observer.ts:1682-1686), so one event per step would keep just the
// first step's tokens. This buffer sums tokens/cost/files per assistant message
// and emits a single message.updated immediately before session.idle.
// ---------------------------------------------------------------------------

const MAX_BUFFERED_MESSAGES = 256

type StepUsageEntry = {
  sessionID: string
  messageID: string
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
  files: Set<string>
  completed: number
}

export class V2StepUsageBuffer {
  private readonly steps = new Map<string, StepUsageEntry>()
  private readonly idleSessions = new Set<string>()

  /**
   * Adds one step. Returns an immediate message.updated when the step arrived
   * after that session's idle (late step), otherwise null.
   */
  add(event: V2SessionStepEnded): V1EventTranslation | null {
    if (!event.data || typeof event.data !== "object") return null
    const sessionID = stringField(event.data, "sessionID")
    const messageID = stringField(event.data, "assistantMessageID")
    if (!sessionID || !messageID) return null

    const key = `${sessionID}:${messageID}`
    let entry = this.steps.get(key)
    if (!entry) {
      entry = {
        sessionID,
        messageID,
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        files: new Set<string>(),
        completed: typeof event.created === "number" ? event.created : Date.now(),
      }
      if (this.steps.size >= MAX_BUFFERED_MESSAGES) {
        const oldest = this.steps.keys().next()
        if (!oldest.done) this.steps.delete(oldest.value)
      }
      this.steps.set(key, entry)
    }

    const tokens = readField(event.data, "tokens")
    entry.input += numberField(tokens, "input")
    entry.output += numberField(tokens, "output")
    entry.reasoning += numberField(tokens, "reasoning")
    entry.cacheRead += numberField(readField(tokens, "cache"), "read")
    entry.cacheWrite += numberField(readField(tokens, "cache"), "write")
    entry.cost += numberField(event.data, "cost")
    for (const file of stringArrayField(event.data, "files")) entry.files.add(file)
    if (typeof event.created === "number") entry.completed = Math.max(entry.completed, event.created)

    if (this.idleSessions.has(sessionID)) {
      this.steps.delete(key)
      return this.toMessageUpdated(entry)
    }
    return null
  }

  /** Removes and returns the summed events for a session (one per assistant message). */
  flush(sessionID: string): V1EventTranslation[] {
    const translated: V1EventTranslation[] = []
    for (const [key, entry] of this.steps) {
      if (entry.sessionID !== sessionID) continue
      this.steps.delete(key)
      translated.push(this.toMessageUpdated(entry))
      if (entry.files.size > 0) translated.push(this.toPatchPart(entry))
    }
    return translated
  }

  markIdle(sessionID: string): void {
    if (sessionID) this.idleSessions.add(sessionID)
  }

  markBusy(sessionID: string): void {
    if (sessionID) this.idleSessions.delete(sessionID)
  }

  forget(sessionID: string): void {
    this.idleSessions.delete(sessionID)
    for (const [key, entry] of this.steps) {
      if (entry.sessionID === sessionID) this.steps.delete(key)
    }
  }

  clear(): void {
    this.steps.clear()
    this.idleSessions.clear()
  }

  private toMessageUpdated(entry: StepUsageEntry): V1EventTranslation {
    return {
      type: "message.updated",
      properties: {
        info: {
          id: entry.messageID,
          role: "assistant",
          sessionID: entry.sessionID,
          time: { completed: entry.completed },
          cost: entry.cost,
          tokens: {
            input: entry.input,
            output: entry.output,
            reasoning: entry.reasoning,
            cache: { read: entry.cacheRead, write: entry.cacheWrite },
          },
        },
      },
    }
  }

  private toPatchPart(entry: StepUsageEntry): V1EventTranslation {
    return {
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: entry.sessionID,
          messageID: entry.messageID,
          type: "patch",
          files: [...entry.files],
        },
      },
    }
  }
}

// ---------------------------------------------------------------------------
// File -> session attribution
//
// session.step.ended.files carries the exact files of each agent step. They are
// recorded directly as file.edited (see mapV2StepFilesToFileEdits) and also
// remembered here: filesystem.changed has no sessionID, so V1 would otherwise
// fall back to currentSessionId. Suffix matching only bridges
// relative-vs-absolute paths, and only when the match is unambiguous.
// ---------------------------------------------------------------------------

const FILE_SESSION_TTL_MS = 10 * 60 * 1000
const MAX_FILE_SESSION_PAIRS = 2000

function normalizeBridgePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function isAbsoluteBridgePath(value: string): boolean {
  return value.startsWith("/") || /^[a-z]:\//i.test(value)
}

export class V2FileSessionIndex {
  // path -> sessionID -> last seen. Per-session entries keep concurrent
  // sessions from overwriting each other on the same file.
  private readonly entries = new Map<string, Map<string, number>>()
  private pairCount = 0

  remember(files: unknown, sessionID: string, at = Date.now()): void {
    if (!sessionID || !Array.isArray(files)) return
    for (const file of files) {
      if (typeof file !== "string" || !file) continue
      const key = normalizeBridgePath(file)
      if (!key) continue

      let sessions = this.entries.get(key)
      if (!sessions) {
        sessions = new Map<string, number>()
        this.entries.set(key, sessions)
      }
      if (!sessions.has(sessionID)) {
        if (this.pairCount >= MAX_FILE_SESSION_PAIRS) this.evictOldest()
        this.pairCount++
      }
      sessions.set(sessionID, at)
    }
  }

  /**
   * Exact path wins. Among exact matches, the preferred (active) session wins;
   * otherwise the freshest one, with sessionID as a deterministic tie-break.
   * Suffix matching is only a relative-vs-absolute bridge and only when it
   * resolves to exactly one session; otherwise "" lets activeSessionID decide.
   */
  resolve(file: string, now = Date.now(), preferredSessionID = ""): string {
    const normalized = normalizeBridgePath(file)
    if (!normalized) return ""

    this.pruneExpired(now)

    const exact = this.entries.get(normalized)
    if (exact && exact.size > 0) {
      if (preferredSessionID && exact.has(preferredSessionID)) return preferredSessionID
      let bestSession = ""
      let bestAt = -Infinity
      for (const [sessionID, at] of exact) {
        if (at > bestAt || (at === bestAt && sessionID < bestSession)) {
          bestSession = sessionID
          bestAt = at
        }
      }
      return bestSession
    }

    const normalizedIsAbsolute = isAbsoluteBridgePath(normalized)
    const suffixMatches = new Map<string, number>()
    for (const [key, sessions] of this.entries) {
      // Only bridge relative step paths with absolute watcher paths. Two
      // relative paths are distinct files even if one ends with the other.
      if (normalizedIsAbsolute === isAbsoluteBridgePath(key)) continue
      if (!normalized.endsWith(`/${key}`) && !key.endsWith(`/${normalized}`)) continue
      for (const [sessionID, at] of sessions) {
        const previous = suffixMatches.get(sessionID)
        if (previous === undefined || at > previous) suffixMatches.set(sessionID, at)
      }
    }

    if (suffixMatches.size === 1) {
      const only = suffixMatches.keys().next()
      return only.done ? "" : only.value
    }
    return ""
  }

  clear(): void {
    this.entries.clear()
    this.pairCount = 0
  }

  private pruneExpired(now: number): void {
    for (const [key, sessions] of this.entries) {
      for (const [sessionID, at] of sessions) {
        if (now - at > FILE_SESSION_TTL_MS) {
          sessions.delete(sessionID)
          this.pairCount--
        }
      }
      if (sessions.size === 0) this.entries.delete(key)
    }
  }

  private evictOldest(): void {
    let oldestKey = ""
    let oldestSession = ""
    let oldestAt = Infinity
    for (const [key, sessions] of this.entries) {
      for (const [sessionID, at] of sessions) {
        if (at < oldestAt) {
          oldestAt = at
          oldestKey = key
          oldestSession = sessionID
        }
      }
    }
    if (!oldestKey) return
    const sessions = this.entries.get(oldestKey)
    if (!sessions) return
    if (sessions.delete(oldestSession)) this.pairCount--
    if (sessions.size === 0) this.entries.delete(oldestKey)
  }
}

export default Plugin.define({
  id: "code-shadow",
  async setup(ctx) {
    const log = (...args: any[]) => console.log("[code-shadow:v2]", ...args)
    writeV2Log("setup start", {
      version: ctx.app?.version,
      directory: ctx.location?.directory,
    })

    // The V1 core only uses `client.tui.showToast` for notifications. OpenCode 2
    // server plugins cannot push TUI toasts, so keep them in the server log.
    const clientShim = {
      tui: {
        showToast: (options: any) => log("toast:", options?.body?.message ?? options?.message ?? options),
        toast: { show: (payload: any) => log("toast:", payload?.message ?? payload) },
      },
    }

    let hooks: AnyRecord
    try {
      hooks = (await CodeShadowV1({ client: clientShim } as any, {
        skipTuiAutoInstall: true,
      })) as AnyRecord
    } catch (err) {
      log("failed to initialise V1 core:", err)
      throw err
    }

    const v1Tools = (hooks.tool ?? {}) as Record<string, AnyRecord>
    const registrations: Array<{ dispose?: () => Promise<void> | void }> = []

    async function register(create: () => Promise<any>, label: string): Promise<void> {
      try {
        const registration = await create()
        if (registration && typeof registration.dispose === "function") {
          registrations.push(registration)
        }
        log(`registered ${label}`)
        writeV2Log(`registered ${label}`)
      } catch (err) {
        log(`failed to register ${label}:`, err)
        writeV2Log(`FAILED to register ${label}`, err)
      }
    }

    // -----------------------------------------------------------------------
    // Tools (16 `code_shadow_*` tools), native rather than Code Mode
    // -----------------------------------------------------------------------
    await register(
      () =>
        ctx.tool.transform((editor) => {
          for (const [name, definition] of Object.entries(v1Tools)) {
            try {
              editor.add({
                name,
                description: definition.description ?? name,
                options: { codemode: false },
                input: toJsonSchema(definition.args ?? {}),
                execute: async (input: any, toolContext: any) => {
                  const v1Context = {
                    sessionID: toolContext.sessionID,
                    messageID: toolContext.messageID,
                    agent: toolContext.agent,
                    directory: ctx.location.directory,
                    worktree: ctx.location.project?.canonical ?? ctx.location.directory,
                    cwd: ctx.location.directory,
                    abort: toolContext.signal,
                    metadata: () => {},
                    ask: async () => {},
                  }
                  return toV2Result(await definition.execute(input, v1Context))
                },
              })
            } catch (err) {
              log(`failed to add tool ${name}:`, err)
            }
          }
        }),
      `tools (${Object.keys(v1Tools).length})`,
    )

    // -----------------------------------------------------------------------
    // tool.execute.before
    // -----------------------------------------------------------------------
    const before = hooks["tool.execute.before"]
    if (typeof before === "function") {
      await register(
        () =>
          ctx.tool.hook("execute.before", async (event: any) => {
            await before(
              { tool: event.tool, sessionID: event.sessionID, callID: String(event.id) },
              { args: (event.input ?? {}) as AnyRecord },
            )
          }),
        "hook tool.execute.before",
      )
    }

    // -----------------------------------------------------------------------
    // tool.execute.after
    // -----------------------------------------------------------------------
    const after = hooks["tool.execute.after"]
    if (typeof after === "function") {
      await register(
        () =>
          ctx.tool.hook("execute.after", async (event: any) => {
            let output: AnyRecord
            if (event.status === "completed") {
              output = {
                title: "",
                output: resultText(event.result),
                metadata: event.result?.metadata ?? {},
              }
            } else {
              const message = event.error?.message ?? String(event.error ?? "tool error")
              output = {
                title: "",
                output: message,
                metadata: { error: message, success: false },
              }
            }
            await after(
              {
                tool: event.tool,
                sessionID: event.sessionID,
                callID: String(event.id),
                args: (event.input ?? {}) as AnyRecord,
              },
              output,
            )
          }),
        "hook tool.execute.after",
      )
    }

    // -----------------------------------------------------------------------
    // chat.message -> session prompt hook
    // -----------------------------------------------------------------------
    const chatMessage = hooks["chat.message"]
    if (typeof chatMessage === "function") {
      await register(
        () =>
          ctx.session.hook("prompt", async (event: any) => {
            await chatMessage(
              { sessionID: event.sessionID, messageID: event.messageID },
              { parts: [{ type: "text", text: event.prompt?.text ?? "" }] },
            )
          }),
        "hook chat.message",
      )
    }

    // -----------------------------------------------------------------------
    // permission.ask -> permission evaluate hook
    // -----------------------------------------------------------------------
    const permissionAsk = hooks["permission.ask"]
    if (typeof permissionAsk === "function") {
      await register(
        () =>
          ctx.permission.hook("evaluate", async (event: any) => {
            const output: AnyRecord = { status: event.effect }
            await permissionAsk(
              {
                id: event.source?.id ?? "",
                type: event.action,
                pattern: event.resources ?? [],
                sessionID: event.sessionID,
                messageID: event.source?.messageID ?? "",
                callID: event.source?.id,
                title: event.action,
                metadata: event.metadata ?? {},
              },
              output,
            )
            if (output.status !== event.effect) {
              event.effect = output.status
              if (output.status === "deny" && !event.message) {
                event.message = "Code Shadow: blocked by Change Contract or edit-loop guard"
              }
            }
          }),
        "hook permission.ask",
      )
    }

    // -----------------------------------------------------------------------
    // experimental.session.compacting -> session compaction hook
    // -----------------------------------------------------------------------
    const compacting = hooks["experimental.session.compacting"]
    if (typeof compacting === "function") {
      await register(
        () =>
          ctx.session.hook("compaction", async (event: any) => {
            const output: AnyRecord = { context: [] }
            await compacting({ sessionID: event.sessionID }, output)
            const briefing = Array.isArray(output.context) ? output.context.join("\n\n") : ""
            if (briefing) {
              event.system ??= []
              event.system.push({ type: "text", text: briefing })
            }
          }),
        "hook session.compaction",
      )
    }

    // -----------------------------------------------------------------------
    // Event hooks: session lifecycle, message usage, /shadow, file edits
    // -----------------------------------------------------------------------
    const onEvent = hooks["event"]
    const onFileEdited = hooks["file.edited"]
    const controller = new AbortController()
    const eventDirectory = ctx.location?.directory ?? ""
    const stepUsage = new V2StepUsageBuffer()
    const fileSessions = new V2FileSessionIndex()
    let activeSessionID = ""

    const dispatch = async (translated: V1EventTranslation): Promise<void> => {
      try {
        // Keep the existing direct file.edited routing; the rest go through
        // the V1 event dispatcher.
        if (translated.type === "file.edited" && typeof onFileEdited === "function") {
          await onFileEdited(translated.properties, {})
        } else if (typeof onEvent === "function") {
          await onEvent({ event: translated })
        }
      } catch (err) {
        log(`V1 handler failed for ${translated.type}:`, err)
        writeV2Log(`FAILED V1 handler ${translated.type}`, err)
      }
    }

    // Flush before the idle translation: V1 snapshots files/tools/errors and
    // clears sessionFilesMap inside handleSessionIdle, so message counts and
    // patch files must already be recorded.
    const flushStepUsage = async (sessionID: string): Promise<void> => {
      if (!sessionID) return
      for (const translated of stepUsage.flush(sessionID)) await dispatch(translated)
      stepUsage.markIdle(sessionID)
    }

    if (typeof onEvent === "function" || typeof onFileEdited === "function") {
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({
            types: V2_EVENT_TYPES,
            signal: controller.signal,
          })) {
            try {
              // OpenCode 2 may deliver every workspace event to every plugin
              // instance; only handle events that address this location.
              if (!eventBelongsToDirectory(event, eventDirectory)) continue

              if (event.type === "session.created") {
                const sessionID = stringField(event.data, "sessionID")
                if (sessionID) {
                  activeSessionID = sessionID
                  stepUsage.markBusy(sessionID)
                }
              }

              if (event.type === "session.status") {
                const sessionID = stringField(event.data, "sessionID")
                const statusType = stringField(readField(event.data, "status"), "type")
                if (sessionID && (statusType === "busy" || statusType === "retry")) {
                  activeSessionID = sessionID
                  stepUsage.markBusy(sessionID)
                }
                if (sessionID && statusType === "idle") {
                  await flushStepUsage(sessionID)
                  if (activeSessionID === sessionID) activeSessionID = ""
                }
              }

              if (event.type === "session.idle") {
                const sessionID = stringField(event.data, "sessionID")
                await flushStepUsage(sessionID)
                if (activeSessionID === sessionID) activeSessionID = ""
              }

              // V2 reports per-turn completion with execution.* (session.idle
              // is only the final idle). Flush tokens here, then let the
              // session.idle translation below close the turn in V1.
              if (
                event.type === "session.execution.succeeded" ||
                event.type === "session.execution.interrupted"
              ) {
                const sessionID = stringField(event.data, "sessionID")
                await flushStepUsage(sessionID)
                if (activeSessionID === sessionID) activeSessionID = ""
              }

              if (event.type === "session.execution.failed") {
                const sessionID = stringField(event.data, "sessionID")
                // A failed execution is terminal for this turn: record the
                // tokens before V1 marks the session as errored.
                await flushStepUsage(sessionID)
                if (activeSessionID === sessionID) activeSessionID = ""
              }

              if (event.type === "session.deleted") {
                const sessionID = stringField(event.data, "sessionID")
                stepUsage.forget(sessionID)
                if (activeSessionID === sessionID) activeSessionID = ""
              }

              if (event.type === "session.step.ended") {
                const sessionID = stringField(event.data, "sessionID")
                if (sessionID) activeSessionID = sessionID
                fileSessions.remember(
                  readField(event.data, "files"),
                  sessionID,
                  typeof event.created === "number" ? event.created : Date.now(),
                )
                // V2 does not emit file edits anywhere else in a usable form:
                // record the step's files through the V1 file.edited handler
                // so file_edits, contracts and auto-memory see them.
                for (const translated of mapV2StepFilesToFileEdits(event, eventDirectory)) {
                  await dispatch(translated)
                }
                // A step after idle is flushed immediately; normal steps wait
                // for the session.idle flush.
                const immediate = stepUsage.add(event)
                if (immediate) await dispatch(immediate)
              }

              let sessionIDHint = ""
              if (event.type === "filesystem.changed") {
                sessionIDHint =
                  fileSessions.resolve(
                    stringField(event.data, "file"),
                    Date.now(),
                    activeSessionID,
                  ) || activeSessionID
              } else if (
                event.type === "tui.prompt.append" ||
                event.type === "tui.command.execute"
              ) {
                sessionIDHint = activeSessionID
              }

              const translations = mapV2EventToV1Events(
                event,
                eventDirectory,
                sessionIDHint,
              )
              for (const translated of translations) await dispatch(translated)
            } catch (err) {
              log(`failed to translate event ${event.type}:`, err)
              writeV2Log(`FAILED to translate event ${event.type}`, err)
            }
          }
        } catch (err) {
          if (!controller.signal.aborted) {
            log("event subscription failed:", err)
            writeV2Log("FAILED event subscription", err)
          }
        }
      })()
      log(`subscribed to events: ${V2_EVENT_TYPES.join(", ")}`)
      writeV2Log(`v2 event subscription (${V2_EVENT_TYPES.length})`, V2_EVENT_TYPES.join(", "))
    }

    // `lsp.*`, `todo.updated`, `command.executed` and `session.updated` are not
    // part of the V2 event union; report once instead of failing silently.
    if (typeof hooks["lsp.diagnostic"] === "function") {
      log("lsp.diagnostic hook has no OpenCode 2 event equivalent; diagnostics capture disabled")
    }
    log("todo.updated has no OpenCode 2 event equivalent; OpenCode todo -> Task Graph mirroring disabled")
    if (typeof hooks["file.edited"] === "function") {
      log("file.edited mapped from session.step.ended files and filesystem.changed (V2 payload has no diff/lines)")
    }

    // -----------------------------------------------------------------------
    // Verify the tool registry and return cleanup
    // -----------------------------------------------------------------------
    try {
      const registered = await ctx.tool.list()
      const names = registered
        .map((entry) => entry.id)
        .filter((id) => id.startsWith("code_shadow_"))
        .sort()
      log(`v2 tool registry: ${names.length} code_shadow tools`, names.join(", "))
      writeV2Log(`v2 registry (${names.length})`, names.join(", "))
    } catch (err) {
      log("failed to inspect tool registry:", err)
      writeV2Log("FAILED to inspect tool registry", err)
    }

    return async () => {
      log("shutting down")
      controller.abort()
      stepUsage.clear()
      fileSessions.clear()
      for (const registration of registrations.reverse()) {
        try {
          await registration.dispose?.()
        } catch (err) {
          log("registration dispose failed:", err)
        }
      }
      try {
        await hooks.dispose?.()
      } catch (err) {
        log("core dispose failed:", err)
      }
    }
  },
})
