/** @jsxImportSource @opentui/solid */
import { createSignal } from "solid-js"
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginMeta,
  TuiSlotPlugin,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import { Database } from "bun:sqlite"
import { appendFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// =============================================================================
// Code Shadow — v26 (live session + project)
// =============================================================================

type Color = string

function toColor(value: unknown, fallback: Color): Color {
  if (typeof value === "string" && value) return value
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>
    if (typeof v.r === "number" && typeof v.g === "number" && typeof v.b === "number") {
      // The host exposes RGBA 0-255; some themes use normalized 0-1 floats.
      const normalized = v.r <= 1 && v.g <= 1 && v.b <= 1
      const channel = (n: number) =>
        clamp(Math.round(normalized ? n * 255 : n), 0, 255).toString(16).padStart(2, "0")
      return `#${channel(v.r)}${channel(v.g)}${channel(v.b)}`
    }
    for (const key of ["base", "primary", "default", "main", "subtle", "muted"]) {
      const nested = toColor(v[key], "")
      if (nested) return nested
    }
  }
  return fallback
}

function theme(ctx: { theme: { current: Record<string, unknown> } }) {
  const t = ctx?.theme?.current ?? {}
  const c = (k: string, fallback: Color): Color => toColor(t[k], fallback)
  return {
    accent: c("primary", "#7c3aed"),
    accent2: c("secondary", "#2f81f7"),
    info: c("info", "#58a6ff"),
    text: c("text", "#e6edf3"),
    muted: c("textMuted", "#8b949e"),
    success: c("success", "#3fb950"),
    warning: c("warning", "#d29922"),
    error: c("error", "#f85149"),
    border: c("borderSubtle", "#30363d"),
    borderActive: c("borderActive", "#8b949e"),
    added: c("diffAdded", "#3fb950"),
    removed: c("diffRemoved", "#f85149"),
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

// =============================================================================
// Database
// =============================================================================
const DB_PATH = join(homedir(), ".config", "opencode", "shadow", "data.db")
let db: Database | null = null

function getDb(): Database | null {
  if (db) return db
  try {
    db = new Database(DB_PATH, { readonly: true })
    return db
  } catch {
    return null
  }
}

function scalar(sql: string, ...params: any[]): number {
  const d = getDb()
  if (!d) return 0
  try {
    const row = d.prepare(sql).get(...params) as Record<string, unknown> | undefined
    if (!row) return 0
    const val = Object.values(row)[0]
    return typeof val === "number" ? val : 0
  } catch {
    return 0
  }
}

function query<T extends Record<string, unknown>>(sql: string, ...params: any[]): T[] {
  const d = getDb()
  if (!d) return []
  try {
    return d.prepare(sql).all(...params) as T[]
  } catch {
    return []
  }
}

function detectProjectRoot(ctx: any, val: any): string | null {
  const d = getDb()
  if (!d) return null

  // 1) Session id → project_root from sessions table
  const sid = val?.session_id ?? val?.sessionID ?? val?.id ?? ""
  if (sid) {
    try {
      const row = d.prepare("SELECT project_root FROM sessions WHERE id = ?1").get(sid) as { project_root: string } | undefined
      if (row?.project_root) return row.project_root
    } catch { /* ok */ }
  }

  // 2) ctx workspace/project path
  const dir =
    ctx?.state?.path?.directory ?? ctx?.state?.path?.worktree ??
    ctx?.path?.directory ?? ctx?.path?.worktree ??
    ctx?.workspaceRoot ?? ctx?.workspace ?? ctx?.projectRoot ?? ctx?.cwd ??
    ctx?.config?.workspaceRoot ?? ctx?.config?.projectDir ??
    val?.projectRoot ?? val?.workspaceRoot ?? val?.cwd ??
    process.cwd() ?? ""
  if (typeof dir === "string" && dir) {
    try {
      const row = d.prepare("SELECT project_root FROM sessions WHERE project_root = ?1 ORDER BY started_at DESC LIMIT 1").get(dir) as { project_root: string } | undefined
      if (row?.project_root) return row.project_root
    } catch { /* ok */ }
    return dir
  }

  return null
}

function formatTime(ts: number | null): string {
  if (!ts) return "??:??"
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

function shortSessionId(id: string): string {
  return truncate(String(id).replace(/^ses_/, ""), 10)
}

function unwrapResult(value: any): any {
  // Generated SDK clients return { data } with the default "fields" style,
  // while the TUI client may be configured to return the payload directly.
  if (value && typeof value === "object" && !Array.isArray(value) && "data" in value) return value.data
  return value
}

function logPanelDebug(payload: Record<string, unknown>): void {
  try {
    appendFileSync(
      join(homedir(), ".config", "opencode", "shadow", "tui-debug.log"),
      `${new Date().toISOString()} ${JSON.stringify(payload)}\n`,
    )
  } catch {
    // Diagnostics must never break the panel.
  }
}

// =============================================================================
// Main Panel
// =============================================================================

type Theme = ReturnType<typeof theme>
type SessionState = "busy" | "idle" | "retry" | "unknown"

type ChangeItem = { file: string; additions: number; deletions: number }
type TodoItem = { content: string; status: string; priority: string }
type ActivityItem = { time: string; tool: string; target: string; status: string; duration: string }
type HotspotItem = { file: string; edits: number; errors: number }

type Snapshot = {
  project: string
  branch: string
  worktree: string
  sessions: number
  activeSessions: number
  edits: number
  files: number
  errors: number
  tools: number
  memory: number
  tasks: number
  evidence: number
  failures: number
  contracts: number
  adrs: number
  todaySessions: number
  todayEdits: number
  todayErrors: number
  hotspots: HotspotItem[]
  activity: ActivityItem[]
  touched: Array<{ file: string; edits: number }>
  sessionId: string
  sessionAgent: string
  sessionModel: string
  sessionMessages: number
  sessionTokens: number
  sessionCost: number
  sessionStarted: number
  sessionStatus: SessionState
  changes: ChangeItem[]
  changeSummary: { files: number; additions: number; deletions: number } | null
  todos: TodoItem[]
  recentProjects: Array<{ name: string; sessions: number }>
  refreshedAt: number
}

function emptySnapshot(): Snapshot {
  return {
    project: "", branch: "", worktree: "", sessions: 0, activeSessions: 0, edits: 0, files: 0,
    errors: 0, tools: 0, memory: 0, tasks: 0, evidence: 0, failures: 0,
    contracts: 0, adrs: 0, todaySessions: 0, todayEdits: 0, todayErrors: 0,
    hotspots: [], activity: [], touched: [], sessionId: "", sessionAgent: "", sessionModel: "",
    sessionMessages: 0, sessionTokens: 0, sessionCost: 0, sessionStarted: 0,
    sessionStatus: "unknown", changes: [], changeSummary: null, todos: [],
    recentProjects: [], refreshedAt: 0,
  }
}

type PanelRuntime = {
  snap: () => Snapshot
  setSnap: (value: Snapshot | ((prev: Snapshot) => Snapshot)) => Snapshot
  started: boolean
  timer?: ReturnType<typeof setInterval>
  unsubscribers: Array<() => void>
}

// The V2 host re-renders slot claims; keeping the signals and the refresh
// interval here prevents a new panel instance from being created every tick.
const panelRuntimes = new Map<string, PanelRuntime>()

const RULE = "─".repeat(36)

function basename(path: string): string {
  const parts = String(path).split(/[\\/]/)
  return parts[parts.length - 1] || String(path)
}

function truncate(value: string, max: number): string {
  const s = String(value)
  return s.length > max ? s.slice(0, Math.max(1, max - 1)) + "…" : s
}

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

function formatClock(ts: number): string {
  if (!ts) return "--:--:--"
  const d = new Date(ts)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—"
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

function formatCost(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ""
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`
}

function shortTool(name: string): string {
  const raw = String(name || "tool")
  return truncate(
    raw.replace(/^code_shadow_/, "").replace(/^poster-compiler_/, "").replace(/^poster_/, ""),
    9,
  )
}

function toolStatus(status: string): { glyph: string; color: "success" | "error" | "warning" | "muted" } {
  switch (String(status || "").toLowerCase()) {
    case "success":
    case "ok":
      return { glyph: "✓", color: "success" }
    case "error":
    case "failed":
      return { glyph: "✗", color: "error" }
    case "denied":
    case "blocked":
      return { glyph: "⊘", color: "warning" }
    case "timeout":
    case "retry":
      return { glyph: "◷", color: "warning" }
    default:
      return { glyph: "·", color: "muted" }
  }
}

function todoStatus(status: string): { glyph: string; color: "success" | "accent" | "error" | "muted" } {
  switch (String(status)) {
    case "completed": return { glyph: "✓", color: "success" }
    case "in_progress": return { glyph: "▶", color: "accent" }
    case "cancelled": return { glyph: "✕", color: "error" }
    default: return { glyph: "○", color: "muted" }
  }
}

function healthBar(score: number | null, width = 10): string {
  if (score === null) return "░".repeat(width)
  const filled = Math.round(clamp(score, 0, 100) / 100 * width)
  return "█".repeat(filled) + "░".repeat(width - filled)
}

function miniBar(value: number, max: number, width = 5): string {
  if (max <= 0) return "░".repeat(width)
  const filled = Math.max(1, Math.round(clamp(value / max, 0, 1) * width))
  return "█".repeat(filled) + "░".repeat(width - filled)
}

function Section(props: { s: Theme; title: string; right?: string; rightColor?: string }) {
  return (
    <box flexDirection="row" justifyContent="space-between" padding={[1, 0, 0, 0]}>
      <text fg={props.s.muted}><b>{props.title}</b></text>
      {props.right ? <text fg={props.rightColor ?? props.s.muted}>{props.right}</text> : null}
    </box>
  )
}

function KV(props: { s: Theme; label: string; value: string; color?: string; zero?: boolean }) {
  return (
    <box flexDirection="row" justifyContent="space-between" gap={1}>
      <text fg={props.s.muted}>{props.label}</text>
      <text fg={props.color ?? (props.zero ? props.s.muted : props.s.text)}><b>{props.value}</b></text>
    </box>
  )
}

function ChangeRow(props: { s: Theme; item: ChangeItem }) {
  return (
    <box flexDirection="row" justifyContent="space-between" gap={1}>
      <text fg={props.s.text}>{truncate(basename(props.item.file), 20)}</text>
      <box flexDirection="row" gap={1}>
        <text fg={props.s.added}>+{props.item.additions}</text>
        <text fg={props.s.removed}>-{props.item.deletions}</text>
      </box>
    </box>
  )
}

function TodoRow(props: { s: Theme; item: TodoItem }) {
  const status = todoStatus(props.item.status)
  return (
    <box flexDirection="row" gap={1}>
      <text fg={props.s[status.color]}>{status.glyph}</text>
      <text fg={props.item.status === "completed" ? props.s.muted : props.s.text}>
        {truncate(props.item.content, 30)}
      </text>
    </box>
  )
}

function ActivityRow(props: { s: Theme; item: ActivityItem }) {
  const status = toolStatus(props.item.status)
  return (
    <box flexDirection="row" justifyContent="space-between" gap={1}>
      <box flexDirection="row" gap={1}>
        <text fg={props.s.muted}>{props.item.time}</text>
        <text fg={props.s[status.color]}>{status.glyph}</text>
        <text fg={props.s.text}>{truncate(props.item.tool, 9)}</text>
        {props.item.target ? <text fg={props.s.muted}>{truncate(props.item.target, 10)}</text> : null}
      </box>
      {props.item.duration ? <text fg={props.s.muted}>{props.item.duration}</text> : null}
    </box>
  )
}

function HotspotRow(props: { s: Theme; item: HotspotItem; max: number }) {
  return (
    <box flexDirection="row" justifyContent="space-between" gap={1}>
      <text fg={props.s.text}>{truncate(basename(props.item.file), 16)}</text>
      <box flexDirection="row" gap={1}>
        <text fg={props.item.errors > 0 ? props.s.error : props.s.muted}>{miniBar(props.item.edits, props.max)}</text>
        <text fg={props.s.muted}>{props.item.edits}e</text>
        {props.item.errors > 0 ? <text fg={props.s.error}>{props.item.errors}!</text> : null}
      </box>
    </box>
  )
}

function createStatsPanel(api: TuiPluginApi): TuiSlotPlugin {
  return {
    order: 700,
    slots: {
      sidebar_content(ctx: any, value: any) {
        const s = theme(ctx)
        const runtimeKey = String(value?.session_id ?? value?.sessionID ?? "") || "__global__"
        let runtime = panelRuntimes.get(runtimeKey)
        if (!runtime) {
          const [snap, setSnap] = createSignal<Snapshot>(emptySnapshot())
          runtime = { snap, setSnap, started: false, unsubscribers: [] }
          panelRuntimes.set(runtimeKey, runtime)
          if (panelRuntimes.size > 8) {
            const oldest = panelRuntimes.keys().next().value
            if (oldest !== undefined && oldest !== runtimeKey) {
              const stale = panelRuntimes.get(oldest)
              if (stale) {
                if (stale.timer) clearInterval(stale.timer)
                for (const unsubscribe of stale.unsubscribers) unsubscribe()
              }
              panelRuntimes.delete(oldest)
            }
          }
        }
        const { snap, setSnap } = runtime

        // Project root is detected once and cached; all SQL uses this value.
        let projectRoot: string | null = null
        let lastSessionFetch = 0
        let sessionFetchInFlight = false
        let debuggedSession = ""

        // OpenCode 2 loads V1 TUI plugins through a compatibility layer whose
        // `state.session` can be empty. The SDK client is the reliable source
        // for the live session, so fill the panel asynchronously and keep the
        // SQLite values as the fallback.
        function fetchLiveSession(root: string, sid: string) {
          if (!sid) return
          const client: any = (api as any)?.client
          if (!client?.session) return
          const now = Date.now()
          if (sessionFetchInFlight || now - lastSessionFetch < 1500) return
          sessionFetchInFlight = true
          lastSessionFetch = now
          const query = { directory: root }
          const call = (fn: () => any) => Promise.resolve().then(fn)
          Promise.allSettled([
            call(() => client.session.get({ path: { id: sid }, query })),
            call(() => client.session.messages({ path: { id: sid }, query: { ...query, limit: 200 } })),
            call(() => client.session.todo({ path: { id: sid }, query })),
            call(() => client.session.diff({ path: { id: sid }, query })),
          ]).then((results) => {
            sessionFetchInFlight = false
            if (snap().sessionId !== sid) return
            const session = unwrapResult(results[0].status === "fulfilled" ? results[0].value : undefined)
            const messageRows = unwrapResult(results[1].status === "fulfilled" ? results[1].value : undefined) ?? []
            const todoRows = unwrapResult(results[2].status === "fulfilled" ? results[2].value : undefined) ?? []
            const diffRows = unwrapResult(results[3].status === "fulfilled" ? results[3].value : undefined) ?? []

            const messages = (Array.isArray(messageRows) ? messageRows : [])
              .map((entry: any) => entry?.info ?? entry)
              .filter(Boolean)

            let sessionMessages = 0
            let sessionTokens = 0
            let sessionCost = 0
            let sessionAgent = ""
            let sessionModel = ""
            for (const message of messages) {
              if (message?.role !== "assistant") continue
              sessionMessages += 1
              const tokens = message.tokens
              if (tokens) {
                sessionTokens += (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0)
              }
              if (typeof message.cost === "number") sessionCost += message.cost
              if (typeof message.mode === "string" && message.mode) sessionAgent = message.mode
              if (typeof message.modelID === "string" && message.modelID) sessionModel = message.modelID
            }

            const allChanges: ChangeItem[] = (Array.isArray(diffRows) ? diffRows : [])
              .filter((item: any) => item && typeof item.file === "string")
              .map((item: any) => ({
                file: item.file,
                additions: Number(item.additions ?? 0),
                deletions: Number(item.deletions ?? 0),
              }))
              .sort((a: ChangeItem, b: ChangeItem) => (b.additions + b.deletions) - (a.additions + a.deletions))
            const changes = allChanges.slice(0, 3)
            const summary = session?.summary
            const changeSummary = summary && typeof summary.files === "number"
              ? { files: summary.files, additions: summary.additions ?? 0, deletions: summary.deletions ?? 0 }
              : allChanges.length
                ? {
                    files: allChanges.length,
                    additions: allChanges.reduce((sum, item) => sum + item.additions, 0),
                    deletions: allChanges.reduce((sum, item) => sum + item.deletions, 0),
                  }
                : null

            const rank: Record<string, number> = { in_progress: 0, pending: 1, completed: 2, cancelled: 3 }
            const todos: TodoItem[] = (Array.isArray(todoRows) ? todoRows : [])
              .filter((item: any) => item && typeof item.content === "string")
              .map((item: any) => ({
                content: item.content,
                status: String(item.status ?? "pending"),
                priority: String(item.priority ?? ""),
              }))
              .sort((a: TodoItem, b: TodoItem) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9))
              .slice(0, 3)

            setSnap((prev) => ({
              ...prev,
              sessionAgent: sessionAgent || prev.sessionAgent,
              sessionModel: sessionModel || prev.sessionModel,
              sessionMessages: sessionMessages || prev.sessionMessages,
              sessionTokens: sessionTokens || prev.sessionTokens,
              sessionCost: sessionCost || prev.sessionCost,
              sessionStarted: Number(session?.time?.created ?? prev.sessionStarted),
              changes: changes.length ? changes : prev.changes,
              changeSummary: changeSummary ?? prev.changeSummary,
              todos: todos.length ? todos : prev.todos,
              refreshedAt: Date.now(),
            }))
          }).catch(() => {
            sessionFetchInFlight = false
          })
        }

        function refresh() {
          const detected = detectProjectRoot(api, value)
          if (detected) projectRoot = detected
          const now = Date.now()

          if (!projectRoot) {
            const recent = query<{ project_root: string; c: number }>(
              `SELECT project_root, COUNT(*) c FROM sessions
               WHERE project_root IS NOT NULL
               GROUP BY project_root ORDER BY MAX(started_at) DESC LIMIT 3`,
            ).map((row) => ({ name: basename(row.project_root), sessions: row.c }))
            setSnap({ ...emptySnapshot(), recentProjects: recent, refreshedAt: now })
            return
          }

          const root = projectRoot
          const sid = String(value?.session_id ?? value?.sessionID ?? "")
          if (sid && sid !== debuggedSession) {
            debuggedSession = sid
            let sessionProbe: any = undefined
            try {
              sessionProbe = (api as any)?.state?.session?.get?.(sid)
            } catch (error) {
              sessionProbe = String(error)
            }
            let messageCount = 0
            try {
              messageCount = (api as any)?.state?.session?.messages?.(sid)?.length ?? 0
            } catch { /* session not ready */ }
            logPanelDebug({
              kind: "panel-bind",
              sessionId: sid,
              valueKeys: Object.keys(value ?? {}),
              apiKeys: Object.keys(api ?? {}),
              hasState: Boolean((api as any)?.state),
              stateKeys: Object.keys((api as any)?.state ?? {}),
              sessionKeys: Object.keys((api as any)?.state?.session ?? {}),
              sessionProbe,
              messageCount,
              hasClient: Boolean((api as any)?.client),
            })
          }
          const dayStart = new Date()
          dayStart.setHours(0, 0, 0, 0)
          const day = dayStart.getTime()

          // ----- Project aggregates (SQLite is read-only) -----
          const sessions = scalar("SELECT COUNT(*) FROM sessions WHERE project_root = ?1", root)
          const activeSessions = scalar(
            "SELECT COUNT(*) FROM sessions WHERE project_root = ?1 AND status IN ('created','active')",
            root,
          )
          const edits = scalar(
            "SELECT COUNT(*) FROM file_edits e WHERE e.project_root = ?1 OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = e.session_id AND s.project_root = ?1)",
            root,
          )
          const files = scalar(
            "SELECT COUNT(DISTINCT e.file_path) FROM file_edits e WHERE e.project_root = ?1 OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = e.session_id AND s.project_root = ?1)",
            root,
          )
          // Observer's file_edits can lag or miss V2 sessions. Count mutating
          // tool calls as a fallback so the project block reflects real work.
          const editTools = scalar(
            `SELECT COUNT(*) FROM tool_executions t INNER JOIN sessions s ON t.session_id = s.id
             WHERE s.project_root = ?1 AND t.tool_name IN ('edit','write','patch','apply_patch','multiedit')`,
            root,
          )
          const toolFiles = scalar(
            `SELECT COUNT(DISTINCT t.target_file) FROM tool_executions t INNER JOIN sessions s ON t.session_id = s.id
             WHERE s.project_root = ?1 AND t.tool_name IN ('edit','write','patch','apply_patch','multiedit')
               AND t.target_file IS NOT NULL AND t.target_file <> ''`,
            root,
          )
          const errors = scalar(
            "SELECT COUNT(*) FROM session_errors e INNER JOIN sessions s ON e.session_id = s.id WHERE s.project_root = ?1",
            root,
          )
          const tools = scalar(
            "SELECT COUNT(*) FROM tool_executions t INNER JOIN sessions s ON t.session_id = s.id WHERE s.project_root = ?1",
            root,
          )
          const memory = scalar(
            "SELECT COUNT(*) FROM knowledge_nodes WHERE node_type IN ('concept','pattern','rule') AND (project_root = ?1 OR project_root IS NULL)",
            root,
          )
          const tasks = scalar(
            "SELECT COUNT(*) FROM agent_tasks WHERE project_root = ?1 AND status IN ('planned','active','blocked')",
            root,
          )
          const evidence = scalar("SELECT COUNT(*) FROM evidence_records WHERE project_root = ?1", root)
          const failures = scalar(
            "SELECT COUNT(*) FROM failure_memory WHERE project_root = ?1 AND status = 'open'",
            root,
          )
          const contracts = scalar(
            "SELECT COUNT(*) FROM change_contracts WHERE project_root = ?1 AND status = 'active'",
            root,
          )
          const adrs = scalar(
            "SELECT COUNT(*) FROM decisions WHERE project_root = ?1 OR project_root IS NULL",
            root,
          )
          const todaySessions = scalar(
            "SELECT COUNT(*) FROM sessions WHERE project_root = ?1 AND started_at >= ?2",
            root, day,
          )
          const todayEdits = scalar(
            "SELECT COUNT(*) FROM file_edits e WHERE (e.project_root = ?1 OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = e.session_id AND s.project_root = ?1)) AND e.timestamp >= ?2",
            root, day,
          )
          const todayErrors = scalar(
            "SELECT COUNT(*) FROM session_errors e INNER JOIN sessions s ON e.session_id = s.id WHERE s.project_root = ?1 AND e.timestamp >= ?2",
            root, day,
          )
          const todayEditTools = scalar(
            `SELECT COUNT(*) FROM tool_executions t INNER JOIN sessions s ON t.session_id = s.id
             WHERE s.project_root = ?1 AND t.timestamp >= ?2
               AND t.tool_name IN ('edit','write','patch','apply_patch','multiedit')`,
            root, day,
          )

          // ----- Current session from the TUI host (live, no DB lag) -----
          const st: any = (api as any)?.state
          let branch = ""
          try {
            const rawBranch = st?.vcs?.branch
            if (typeof rawBranch === "string") branch = rawBranch
            else if (rawBranch && typeof rawBranch === "object") {
              branch = String(rawBranch.current ?? rawBranch.default ?? "")
            }
          } catch { /* vcs not ready */ }
          let session: any = undefined
          try {
            session = sid ? st?.session?.get?.(sid) : undefined
          } catch { /* session not ready */ }

          let sessionStatus: SessionState = "unknown"
          try {
            const raw = sid ? st?.session?.status?.(sid)?.type : undefined
            if (raw === "busy" || raw === "idle" || raw === "retry") sessionStatus = raw
          } catch { /* session not ready */ }

          let messages: any[] = []
          try {
            messages = sid ? (st?.session?.messages?.(sid) ?? []) : []
          } catch { /* session not ready */ }

          let sessionMessages = 0
          let sessionTokens = 0
          let sessionCost = 0
          let sessionAgent = ""
          let sessionModel = ""
          for (const message of messages) {
            if (message?.role !== "assistant") continue
            sessionMessages += 1
            const tokens = message.tokens
            if (tokens) {
              sessionTokens += (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0)
            }
            if (typeof message.cost === "number") sessionCost += message.cost
            if (typeof message.mode === "string" && message.mode) sessionAgent = message.mode
            if (typeof message.modelID === "string" && message.modelID) sessionModel = message.modelID
          }

          // OpenCode 2 exposes SessionInfo with tokens/cost/agent/model and a
          // message list whose entries use `type`, not `role`.
          const messageCount = Array.isArray(messages) ? messages.length : 0
          if (messageCount > 0) sessionMessages = messageCount
          if (session) {
            if (typeof session.agent === "string" && session.agent) sessionAgent = session.agent
            if (session.model) {
              const model = session.model
              sessionModel = typeof model === "string"
                ? model
                : String(model.id ?? model.modelID ?? model.name ?? "")
            }
            if (session.tokens) {
              sessionTokens = (session.tokens.input ?? 0) +
                (session.tokens.output ?? 0) +
                (session.tokens.reasoning ?? 0)
            }
            if (typeof session.cost === "number") sessionCost = session.cost
          }

          // Older sessions may not be loaded into the TUI state; use the DB row.
          if (sid && sessionMessages === 0) {
            const row = query<{ message_count: number; total_tokens_used: number }>(
              "SELECT message_count, total_tokens_used FROM sessions WHERE id = ?1", sid,
            )[0]
            if (row) {
              sessionMessages = row.message_count ?? sessionMessages
              if (!sessionTokens) sessionTokens = row.total_tokens_used ?? 0
            }
          }

          let rawChanges: any[] = []
          try {
            rawChanges = sid ? (st?.session?.diff?.(sid) ?? []) : []
          } catch { /* session not ready */ }
          if (!rawChanges.length && Array.isArray(session?.summary?.diffs)) {
            rawChanges = session.summary.diffs
          }
          const allChanges: ChangeItem[] = rawChanges
            .filter((item) => item && typeof item.file === "string")
            .map((item) => ({
              file: item.file,
              additions: Number(item.additions ?? 0),
              deletions: Number(item.deletions ?? 0),
            }))
            .sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions))
          const changes = allChanges.slice(0, 3)
          const summary = session?.summary
          const changeSummary = summary && typeof summary.files === "number"
            ? { files: summary.files, additions: summary.additions ?? 0, deletions: summary.deletions ?? 0 }
            : allChanges.length
              ? {
                  files: allChanges.length,
                  additions: allChanges.reduce((sum, item) => sum + item.additions, 0),
                  deletions: allChanges.reduce((sum, item) => sum + item.deletions, 0),
                }
              : null

          let rawTodos: any[] = []
          try {
            rawTodos = sid ? (st?.session?.todo?.(sid) ?? []) : []
          } catch { /* session not ready */ }
          const rank: Record<string, number> = { in_progress: 0, pending: 1, completed: 2, cancelled: 3 }
          const todos: TodoItem[] = rawTodos
            .filter((item) => item && typeof item.content === "string")
            .map((item) => ({
              content: item.content,
              status: String(item.status ?? "pending"),
              priority: String(item.priority ?? ""),
            }))
            .sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9))
            .slice(0, 3)

          // ----- Activity: latest tool calls, fallback to file edits -----
          const toolRows = query<{ tool_name: string; target_file: string | null; status: string; duration_ms: number | null; timestamp: number }>(
            `SELECT t.tool_name, t.target_file, t.status, t.duration_ms, t.timestamp
             FROM tool_executions t INNER JOIN sessions s ON s.id = t.session_id
             WHERE s.project_root = ?1 ORDER BY t.timestamp DESC LIMIT 4`,
            root,
          )
          let activity: ActivityItem[] = toolRows.map((row) => ({
            time: formatTime(row.timestamp),
            tool: row.tool_name,
            target: row.target_file ? basename(row.target_file) : "",
            status: row.status,
            duration: row.duration_ms == null ? "" : formatDuration(row.duration_ms),
          }))
          if (!activity.length) {
            const editRows = query<{ file_path: string; lines_added: number | null; lines_removed: number | null; timestamp: number }>(
              `SELECT e.file_path, e.lines_added, e.lines_removed, e.timestamp
               FROM file_edits e
               WHERE e.project_root = ?1 OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = e.session_id AND s.project_root = ?1)
               ORDER BY e.timestamp DESC LIMIT 4`,
              root,
            )
            activity = editRows.map((row) => ({
              time: formatTime(row.timestamp),
              tool: "edit",
              target: basename(row.file_path),
              status: "success",
              duration: `+${row.lines_added ?? 0} -${row.lines_removed ?? 0}`,
            }))
          }

          // Current-session edit targets stay visible even when session.diff
          // is scoped to another directory (the actual worktree can differ).
          const touchedRows = sid
            ? query<{ target_file: string; c: number }>(
                `SELECT t.target_file, COUNT(*) c FROM tool_executions t
                 WHERE t.session_id = ?1
                   AND t.tool_name IN ('edit','write','patch','apply_patch','multiedit')
                   AND t.target_file IS NOT NULL AND t.target_file <> ''
                 GROUP BY t.target_file ORDER BY MAX(t.timestamp) DESC LIMIT 3`,
                sid,
              )
            : []
          const touched = touchedRows.map((row) => ({ file: row.target_file, edits: row.c }))
          const latestTarget = touchedRows[0]?.target_file ?? toolRows[0]?.target_file ?? ""
          const worktree = latestTarget
            ? basename(String(latestTarget).replace(/[\\/][^\\/]*$/, ""))
            : ""

          // ----- Hotspots (30d) -----
          const cutoff = now - 30 * 24 * 60 * 60 * 1000
          const hotspots = query<{ fp: string; ec: number; er: number }>(
            `SELECT e.file_path fp, COUNT(*) ec,
               (SELECT COUNT(*) FROM session_errors er INNER JOIN sessions s2 ON s2.id = er.session_id
                WHERE er.context_file = e.file_path AND er.timestamp >= ?2 AND s2.project_root = ?1) er
             FROM file_edits e
             WHERE (e.project_root = ?1 OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = e.session_id AND s.project_root = ?1))
               AND e.timestamp >= ?2
             GROUP BY e.file_path ORDER BY ec DESC LIMIT 3`,
            root, cutoff,
          ).map((row) => ({ file: row.fp, edits: row.ec, errors: row.er }))

          setSnap({
            project: basename(root),
            branch,
            sessions, activeSessions,
            edits: Math.max(edits, editTools),
            files: Math.max(files, toolFiles, changeSummary?.files ?? 0),
            errors, tools, memory, tasks,
            evidence, failures, contracts, adrs,
            todaySessions, todayEdits: Math.max(todayEdits, todayEditTools), todayErrors,
            hotspots, activity, touched, worktree,
            sessionId: sid,
            sessionAgent, sessionModel, sessionMessages, sessionTokens, sessionCost,
            sessionStarted: Number(session?.time?.created ?? 0),
            sessionStatus,
            changes, changeSummary, todos,
            recentProjects: [],
            refreshedAt: now,
          })
          fetchLiveSession(root, sid)
        }

        // Event-driven refresh with a short debounce; the timer is a fallback
        // for batched SQLite writes and hosts that do not emit every event.
        let refreshTimer: ReturnType<typeof setTimeout> | undefined
        const scheduleRefresh = () => {
          if (refreshTimer) return
          refreshTimer = setTimeout(() => {
            refreshTimer = undefined
            refresh()
          }, 400)
        }
        if (!runtime.started) {
          runtime.started = true
          refresh()
          runtime.timer = setInterval(refresh, 5000)
          runtime.unsubscribers.push(
            api.event.on("session.created", scheduleRefresh),
            api.event.on("session.updated", scheduleRefresh),
            api.event.on("session.idle", scheduleRefresh),
            api.event.on("message.updated", scheduleRefresh),
            api.event.on("message.part.updated", scheduleRefresh),
            api.event.on("todo.updated", scheduleRefresh),
            api.event.on("file.edited", scheduleRefresh),
            api.event.on("session.error", scheduleRefresh),
            api.event.on("command.executed", scheduleRefresh),
          )
        }

        // ----- Render -----
        const state = snap()
        const touched = state.touched ?? []
        const worktree = state.worktree ?? ""
        const elapsed = state.sessionStarted ? Date.now() - state.sessionStarted : 0
        const score = state.tools > 0
          ? state.errors === 0
            ? 100
            : clamp(Math.round(100 - (state.errors / state.tools) * 100), 0, 99)
          : null
        const healthColor = score === null
          ? s.muted
          : score >= 90
            ? s.success
            : score >= 70
              ? s.warning
              : s.error
        const healthLabel = score === null
          ? "no data"
          : score === 100
            ? "Healthy"
            : score >= 90
              ? "Stable"
              : score >= 70
                ? "Watch"
                : "Critical"
        const live = state.sessionStatus === "busy" || state.sessionStatus === "retry" ||
          (state.sessionStatus === "unknown" && state.activeSessions > 0)
        const liveGlyph = state.sessionStatus === "retry" ? "◐" : live ? "●" : "○"
        const liveLabel = state.sessionStatus === "retry" ? "RETRY" : live ? "LIVE" : "IDLE"
        const liveColor = state.sessionStatus === "retry" ? s.warning : live ? s.success : s.muted
        const sessionLine = [state.sessionAgent, state.sessionModel].filter(Boolean).join(" · ")
        const sessionLabel = sessionLine || (state.sessionId ? `session ${shortSessionId(state.sessionId)}` : "no session")
        const todayLine = state.todaySessions + state.todayEdits + state.todayErrors > 0
          ? `today ${state.todaySessions}s · ${state.todayEdits}e · ${state.todayErrors}err`
          : ""
        const hotspotMax = state.hotspots[0]?.edits ?? 0

        if (!state.project) {
          return (
            <box flexDirection="column" padding={[0, 1]} gap={0}>
              <box flexDirection="row" justifyContent="space-between">
                <text fg={s.text}><b>No active project</b></text>
                <text fg={s.muted}>○ IDLE</text>
              </box>
              <text fg={s.border}>{RULE}</text>
              <text fg={s.muted}>The panel fills as soon as a session starts.</text>
              {state.recentProjects.length > 0 ? (
                <>
                  <Section s={s} title="RECENT" />
                  {state.recentProjects.map((item) => (
                    <box flexDirection="row" justifyContent="space-between" key={item.name}>
                      <text fg={s.text}>{truncate(item.name, 24)}</text>
                      <text fg={s.muted}>{item.sessions} sess</text>
                    </box>
                  ))}
                </>
              ) : null}
              <text fg={s.border}>{RULE}</text>
              <text fg={s.muted}>v0.5.3 · {formatClock(state.refreshedAt)}</text>
            </box>
          )
        }

        return (
          <box flexDirection="column" padding={[0, 1]} gap={0}>
            {/* ── Project + live state ── */}
            <box flexDirection="row" justifyContent="space-between">
              <box flexDirection="row" gap={1}>
                <text fg={s.accent}><b>{truncate(state.project, 24)}</b></text>
                {state.branch ? <text fg={s.muted}>· {truncate(state.branch, 12)}</text> : null}
              </box>
              <text fg={liveColor}>{liveGlyph} {liveLabel}</text>
            </box>
            {worktree && worktree !== state.project ? (
              <text fg={s.muted}>worktree {truncate(worktree, 24)}</text>
            ) : null}
            <text fg={s.border}>{RULE}</text>

            {/* ── Health ── */}
            <box flexDirection="row" justifyContent="space-between">
              <box flexDirection="row" gap={1}>
                <text fg={s.muted}>HEALTH</text>
                <text fg={healthColor}>{healthBar(score)}</text>
                <text fg={healthColor}><b>{score === null ? "—" : `${score}%`}</b></text>
              </box>
              <text fg={healthColor}>{healthLabel}</text>
            </box>
            <text fg={s.muted}>{state.errors} err / {state.tools} tools · {state.sessions} sess</text>
            {todayLine ? <text fg={s.muted}>{todayLine}</text> : null}

            {/* ── Current session ── */}
            <Section s={s} title="SESSION" right={state.sessionId ? shortSessionId(state.sessionId) : undefined} />
            {state.sessionId ? (
              <>
                <text fg={s.text}>{truncate(sessionLabel, 34)}</text>
                {state.sessionMessages > 0 ? (
                  <text fg={s.muted}>
                    {state.sessionMessages} msg · {formatTokens(state.sessionTokens)} tok · {formatDuration(elapsed)}
                    {formatCost(state.sessionCost) ? ` · ${formatCost(state.sessionCost)}` : ""}
                  </text>
                ) : (
                  <text fg={s.muted}>waiting for session data…</text>
                )}
              </>
            ) : (
              <text fg={s.muted}>no session bound to this panel</text>
            )}

            {/* ── Working tree ── */}
            {state.changeSummary ? (
              <>
                <Section
                  s={s}
                  title="CHANGES"
                  right={`${state.changeSummary.files} files`}
                  rightColor={state.changeSummary.files > 0 ? s.text : s.muted}
                />
                {state.changes.map((item) => (
                  <ChangeRow s={s} item={item} key={item.file} />
                ))}
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={s.muted}>total</text>
                  <box flexDirection="row" gap={1}>
                    <text fg={s.added}>+{state.changeSummary.additions}</text>
                    <text fg={s.removed}>-{state.changeSummary.deletions}</text>
                  </box>
                </box>
              </>
            ) : touched.length > 0 ? (
              <>
                <Section s={s} title="TOUCHED" right={`${touched.length}`} />
                {touched.map((item) => (
                  <box flexDirection="row" justifyContent="space-between" key={item.file}>
                    <text fg={s.text}>{truncate(basename(item.file), 22)}</text>
                    <text fg={s.muted}>{item.edits}×</text>
                  </box>
                ))}
              </>
            ) : null}

            {/* ── Live todos ── */}
            {state.todos.length > 0 ? (
              <>
                <Section s={s} title="NOW" />
                {state.todos.map((item, index) => (
                  <TodoRow s={s} item={item} key={`${item.content}-${index}`} />
                ))}
              </>
            ) : null}

            {/* ── Activity ── */}
            <Section s={s} title="ACTIVITY" right={state.activity.length ? "last 4" : undefined} />
            {state.activity.length > 0 ? (
              state.activity.map((item, index) => (
                <ActivityRow s={s} item={item} key={`${item.time}-${item.tool}-${index}`} />
              ))
            ) : (
              <text fg={s.muted}>waiting for activity</text>
            )}

            {/* ── Project ── */}
            <Section s={s} title="PROJECT" right={state.activeSessions > 0 ? `${state.activeSessions} active` : undefined} />
            <box flexDirection="row" gap={2}>
              <box flexDirection="column" flexGrow={1}>
                <KV s={s} label="sessions" value={String(state.sessions)} zero={state.sessions === 0} />
                <KV s={s} label="files" value={String(state.files)} zero={state.files === 0} />
                <KV s={s} label="errors" value={String(state.errors)} zero={state.errors === 0} color={state.errors > 0 ? s.error : undefined} />
                <KV s={s} label="tasks" value={String(state.tasks)} zero={state.tasks === 0} />
                <KV s={s} label="ADRs" value={String(state.adrs)} zero={state.adrs === 0} />
              </box>
              <box flexDirection="column" flexGrow={1}>
                <KV s={s} label="edits" value={String(state.edits)} zero={state.edits === 0} />
                <KV s={s} label="tools" value={String(state.tools)} zero={state.tools === 0} />
                <KV s={s} label="memory" value={String(state.memory)} zero={state.memory === 0} />
                <KV s={s} label="evidence" value={String(state.evidence)} zero={state.evidence === 0} />
                <KV s={s} label="contracts" value={String(state.contracts)} zero={state.contracts === 0} />
              </box>
            </box>
            {state.failures > 0 ? (
              <KV s={s} label="failures" value={String(state.failures)} color={s.error} />
            ) : null}

            {/* ── Hotspots ── */}
            {state.hotspots.length > 0 ? (
              <>
                <Section s={s} title="HOTSPOTS 30d" />
                {state.hotspots.map((item) => (
                  <HotspotRow s={s} item={item} max={hotspotMax} key={item.file} />
                ))}
              </>
            ) : null}

            <text fg={s.border}>{RULE}</text>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={s.muted}>v0.5.3</text>
              <text fg={s.muted}>{formatClock(state.refreshedAt)}</text>
            </box>
          </box>
        )
      },
    },
  }
}

// =============================================================================
// Plugin Entry
// =============================================================================

const tui = (async (
  api: TuiPluginApi,
  _options: unknown,
  _meta?: TuiPluginMeta,
) => {
  api.slots.register(createStatsPanel(api))
}) satisfies TuiPlugin

const plugin = {
  id: "code-shadow-stats",
  tui,
} satisfies TuiPluginModule & { id: string }

export default plugin
