/** @jsxImportSource @opentui/solid */
import { createSignal, onMount, onCleanup } from "solid-js"
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginMeta,
  TuiSlotPlugin,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"

// =============================================================================
// Code Shadow — Final v25 (per-project only)
// =============================================================================

type Color = string

function theme(ctx: { theme: { current: Record<string, unknown> } }) {
  const t = ctx.theme.current
  const c = (k: string, fallback: Color): Color =>
    typeof t[k] === "string" ? (t[k] as Color) : fallback
  return {
    accent: c("primary", "#7c3aed"),
    text: c("text", "#e6edf3"),
    muted: c("textMuted", "#484f58"),
    success: c("success", "#3fb950"),
    warning: c("warning", "#d29922"),
    error: c("error", "#f85149"),
    border: c("borderSubtle", "#21262d"),
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

function closeDb(): void {
  if (db) {
    try { db.close() } catch {}
    db = null
  }
}

function scalar(sql: string, ...params: unknown[]): number {
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

function query<T extends Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
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

// =============================================================================
// Per-project delta tracking
// =============================================================================
const prevDataMap = new Map<string, { s: number; e: number; err: number; f: number }>()

function delta(cur: number, prev: number | undefined): { value: number; dir: "up" | "down" | "same" } {
  if (prev === undefined || prev < 0) return { value: 0, dir: "same" }
  const d = cur - prev
  return { value: Math.abs(d), dir: d > 0 ? "up" : d < 0 ? "down" : "same" }
}

// =============================================================================
// Main Panel
// =============================================================================

function createStatsPanel(api: TuiPluginApi): TuiSlotPlugin {
  return {
    order: 700,
    slots: {
      sidebar_content(ctx, value) {
        const s = theme(ctx)

        // ----- State -----
        const [sCnt, setSCnt] = createSignal(0)
        const [edits, setEdits] = createSignal(0)
        const [errs, setErrs] = createSignal(0)
        const [files, setFiles] = createSignal(0)
        const [proj, setProj] = createSignal("")
        const [toolsCnt, setToolsCnt] = createSignal(0)
        const [memCnt, setMemCnt] = createSignal(0)
        const [agentTasks, setAgentTasks] = createSignal(0)
        const [agentEvidence, setAgentEvidence] = createSignal(0)
        const [agentFailures, setAgentFailures] = createSignal(0)
        const [agentContracts, setAgentContracts] = createSignal(0)
        const [isLive, setIsLive] = createSignal(false)
        const [noData, setNoData] = createSignal(false)
        const [hotspots, setHotspots] = createSignal<{ file: string; edits: number; errors: number }[]>([])
        const [feed, setFeed] = createSignal<{ time: string; file: string; added: number; removed: number; err: boolean }[]>([])

        // Project root is detected once and cached — all queries use constants
        let projectRoot: string | null = null

        function refresh() {
          // Detect project root on every refresh (session may become available later)
          const detected = detectProjectRoot(api, value)
          if (detected) projectRoot = detected

          if (!projectRoot) {
            // No project data at all — show empty state
            setNoData(true)
            setProj("")
            setSCnt(0); setEdits(0); setErrs(0); setFiles(0)
            setToolsCnt(0); setMemCnt(0)
            setAgentTasks(0); setAgentEvidence(0); setAgentFailures(0); setAgentContracts(0)
            setIsLive(false)
            setHotspots([])
            setFeed([])
            return
          }

          setNoData(false)
          const root = projectRoot
          setProj(root.split(/[\\/]/).pop() ?? "")

          // Sessions — include the active session so the panel is useful while Live.
          setSCnt(scalar(
            "SELECT COUNT(*) FROM sessions WHERE project_root = ?1",
            root,
          ))
          // Active session check
          setIsLive(scalar(
            "SELECT COUNT(*) FROM sessions WHERE project_root = ?1 AND status IN ('created','active')",
            root,
          ) > 0)

          // Edits — accept both direct project_root and the session's project root.
          const eC = scalar(
            "SELECT COUNT(*) FROM file_edits e WHERE e.project_root = ?1 OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = e.session_id AND s.project_root = ?1)",
            root,
          )
          setEdits(eC)

          // Errors via JOIN with sessions
          setErrs(scalar(
            "SELECT COUNT(*) FROM session_errors e INNER JOIN sessions s ON e.session_id = s.id WHERE s.project_root = ?1",
            root,
          ))

          // Unique files
          setFiles(scalar(
            "SELECT COUNT(DISTINCT e.file_path) FROM file_edits e WHERE e.project_root = ?1 OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = e.session_id AND s.project_root = ?1)",
            root,
          ))

          // Tools count
          setToolsCnt(scalar(
            "SELECT COUNT(*) FROM tool_executions t INNER JOIN sessions s ON t.session_id = s.id WHERE s.project_root = ?1",
            root,
          ))

          // Memory (global — not per project)
          setMemCnt(scalar(
            "SELECT COUNT(*) FROM knowledge_nodes WHERE node_type IN ('concept','pattern','rule')",
          ))

          // Agent-native state: the TUI shows whether the agent is reasoning
          // through a tracked task or silently accumulating unverified work.
          setAgentTasks(scalar("SELECT COUNT(*) FROM agent_tasks WHERE project_root = ?1 AND status IN ('planned','active','blocked')", root))
          setAgentEvidence(scalar("SELECT COUNT(*) FROM evidence_records WHERE project_root = ?1", root))
          setAgentFailures(scalar("SELECT COUNT(*) FROM failure_memory WHERE project_root = ?1 AND status = 'open'", root))
          setAgentContracts(scalar("SELECT COUNT(*) FROM change_contracts WHERE project_root = ?1 AND status = 'active'", root))

          // Hotspots — top 3 files by edits in last 30 days
          const cutoff30d = Date.now() - 30 * 24 * 60 * 60 * 1000
          const hsRows = query<{ fp: string; ec: number }>(
            "SELECT e.file_path fp, COUNT(*) ec FROM file_edits e WHERE (e.project_root = ?1 OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = e.session_id AND s.project_root = ?1)) AND e.timestamp >= ?2 GROUP BY e.file_path ORDER BY ec DESC LIMIT 3",
            root,
            cutoff30d,
          )
          const hsWithErrs: { file: string; edits: number; errors: number }[] = []
          for (const hr of hsRows) {
            const er = scalar(
              "SELECT COUNT(*) FROM session_errors WHERE context_file = ?1 AND timestamp >= ?2",
              hr.fp,
              cutoff30d,
            )
            hsWithErrs.push({ file: hr.fp, edits: hr.ec, errors: er })
          }
          setHotspots(hsWithErrs)

          // Activity — last 6 file edits (live, across all sessions)
          const actRows = query<{ file_path: string; lines_added: number; lines_removed: number; timestamp: number; session_id: string }>(
            "SELECT e.file_path, e.lines_added, e.lines_removed, e.timestamp, e.session_id FROM file_edits e WHERE e.project_root = ?1 OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = e.session_id AND s.project_root = ?1) ORDER BY e.timestamp DESC LIMIT 6",
            root,
          )
          const items: { time: string; file: string; added: number; removed: number; err: boolean }[] = []
          for (const r of actRows) {
            const er = scalar("SELECT COUNT(*) FROM session_errors WHERE session_id = ?1", r.session_id)
            const name = r.file_path.split(/[\\/]/).pop() ?? r.file_path
            const dn = name.length > 14 ? name.substring(0, 12) + "…" : name
            items.push({
              time: formatTime(r.timestamp),
              file: dn,
              added: r.lines_added,
              removed: r.lines_removed,
              err: er > 0,
            })
          }
          setFeed(items)

          // Deltas
          const key = root
          const pd = prevDataMap.get(key)
          const dS = delta(sCnt(), pd?.s)
          const dE = delta(eC, pd?.e)
          const dErr = delta(errs(), pd?.err)
          const dF = delta(files(), pd?.f)
          prevDataMap.set(key, { s: sCnt(), e: eC, err: errs(), f: files() })

          // Store deltas on window for render access
          ;(globalThis as any).__csDeltas = { dS, dE, dErr, dF }
        }

        refresh()
        // Refresh immediately when OpenCode publishes activity, with the timer
        // below retained as a fallback for batched SQLite writes.
        let refreshTimer: ReturnType<typeof setTimeout> | undefined
        const scheduleRefresh = () => {
          if (refreshTimer) return
          refreshTimer = setTimeout(() => {
            refreshTimer = undefined
            refresh()
          }, 250)
        }
        const unsubscribers = [
          api.event.on("session.created", scheduleRefresh),
          api.event.on("session.updated", scheduleRefresh),
          api.event.on("session.idle", scheduleRefresh),
          api.event.on("message.part.updated", scheduleRefresh),
          api.event.on("file.edited", scheduleRefresh),
          api.event.on("session.error", scheduleRefresh),
          api.event.on("command.executed", scheduleRefresh),
        ]
        onMount(() => {
          const iv = setInterval(refresh, 5000)
          onCleanup(() => {
            clearInterval(iv)
            if (refreshTimer) clearTimeout(refreshTimer)
            for (const unsubscribe of unsubscribers) unsubscribe()
            closeDb()
          })
        })

        // ----- Computed -----
        const healthScore = () =>
          edits() > 0 ? clamp(100 - (errs() / Math.max(edits(), 1)) * 100, 0, 100) : 100
        const healthColor = () =>
          healthScore() >= 90 ? s.success : healthScore() >= 70 ? s.warning : s.error
        const healthLabel = (score: number): string => {
          if (score >= 90) return "Healthy"
          if (score >= 70) return "Stable"
          if (score >= 50) return "Unstable"
          return "Critical"
        }

        const getDeltaS = () => (globalThis as any).__csDeltas?.dS ?? { value: 0, dir: "same" as const }
        const getDeltaE = () => (globalThis as any).__csDeltas?.dE ?? { value: 0, dir: "same" as const }
        const getDeltaErr = () => (globalThis as any).__csDeltas?.dErr ?? { value: 0, dir: "same" as const }
        const getDeltaF = () => (globalThis as any).__csDeltas?.dF ?? { value: 0, dir: "same" as const }

        const deltaColorFn = (d: { dir: "up" | "down" | "same" }) =>
          d.dir === "up" ? s.success : d.dir === "down" ? s.error : s.muted
        const deltaSymbolFn = (d: { dir: "up" | "down" | "same" }) =>
          d.dir === "up" ? "↑" : d.dir === "down" ? "↓" : ""

        const DIVIDER = "─────────────────────────────────────"

        // Empty state
        if (noData()) {
          return (
            <box flexDirection="column" padding={[0, 2]} gap={0}>
              <text fg={s.border}>{DIVIDER}</text>
              <box flexDirection="row" gap={1} padding={[0, 0]}>
                <text fg={s.accent}>◆</text>
                <text fg={s.text}><b>CODE SHADOW</b></text>
              </box>
              <text fg={s.border}>{DIVIDER}</text>
              <text fg={s.muted}>No project data</text>
              <text fg={s.muted}>Start a session to begin tracking</text>
              <text fg={s.border}>{DIVIDER}</text>
            </box>
          )
        }

        return (
          <box flexDirection="column" padding={[0, 2]} gap={0}>
            <text fg={s.border}>{DIVIDER}</text>

            {/* ─── HEADER ─── */}
            <box flexDirection="row" justifyContent="space-between" padding={[0, 0]}>
              <box flexDirection="row" gap={1}>
                <text fg={s.accent}>◆</text>
                <text fg={s.text}><b>CODE SHADOW</b></text>
                {isLive() && <text fg={s.success}>⬤</text>}
              </box>
              <box flexDirection="row" gap={1}>
                <text fg={healthColor()}>●</text>
                <text fg={healthColor()}>
                  {healthLabel(healthScore())} {healthScore()}%
                </text>
              </box>
            </box>

            <text fg={s.border}>{DIVIDER}</text>

            {/* Project */}
            <box flexDirection="row" gap={1} padding={[0, 0]}>
              <text fg={s.muted}>📁</text>
              <text fg={s.accent}>{proj()}</text>
            </box>

            <text fg={s.border}>{DIVIDER}</text>

            {/* ─── METRICS 2×2 ─── */}
            <box flexDirection="row" justifyContent="space-between" padding={[0, 0]}>
              <MetricItem s={s} label="Sessions" value={sCnt()} delta={getDeltaS()} deltaColor={deltaColorFn(getDeltaS())} deltaSymbol={deltaSymbolFn(getDeltaS())} />
              <MetricItem s={s} label="Edits" value={edits()} delta={getDeltaE()} deltaColor={deltaColorFn(getDeltaE())} deltaSymbol={deltaSymbolFn(getDeltaE())} />
              <MetricItem s={s} label="Errors" value={errs()} delta={getDeltaErr()} deltaColor={deltaColorFn(getDeltaErr())} deltaSymbol={deltaSymbolFn(getDeltaErr())} error={errs() > 0} />
              <MetricItem s={s} label="Files" value={files()} delta={getDeltaF()} deltaColor={deltaColorFn(getDeltaF())} deltaSymbol={deltaSymbolFn(getDeltaF())} />
            </box>
            <box flexDirection="row" justifyContent="space-between" padding={[0, 0]}>
              <MetricItemSimple s={s} label="Tools" value={toolsCnt()} />
              <MetricItemSimple s={s} label="Memory" value={memCnt()} />
              <MetricItemSimple s={s} label="Hotspots" value={hotspots().length} />
              <MetricItemSimple s={s} label="ADRs" value={scalar("SELECT COUNT(*) FROM decisions")} />
            </box>
            <box flexDirection="row" justifyContent="space-between" padding={[0, 0]}>
              <MetricItemSimple s={s} label="Tasks" value={agentTasks()} />
              <MetricItemSimple s={s} label="Evidence" value={agentEvidence()} />
              <MetricItemSimple s={s} label="Failures" value={agentFailures()} />
              <MetricItemSimple s={s} label="Contracts" value={agentContracts()} />
            </box>

            <text fg={s.border}>{DIVIDER}</text>

            {/* ─── HOTSPOTS ─── */}
            {hotspots().length > 0 && (
              <box flexDirection="column" padding={[0, 0]} gap={0}>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={hotspots().some(h => h.errors > 0) ? s.warning : s.muted}>Hotspots 30d</text>
                </box>
                <text fg={s.border}>{DIVIDER}</text>
                {hotspots().map(h => {
                  const name = h.file.split(/[\\/]/).pop() ?? h.file
                  const dn = name.length > 22 ? name.substring(0, 20) + "…" : name
                  return (
                    <box flexDirection="row" gap={1} key={h.file}>
                      <text fg={h.errors > 0 ? s.error : s.success}>
                        {h.errors > 0 ? "🔥" : "·"}
                      </text>
                      <text fg={s.text}>{dn}</text>
                      <text fg={s.muted}>{h.edits}e{h.errors > 0 ? ` ${h.errors}⚠` : ""}</text>
                    </box>
                  )
                })}
              </box>
            )}

            {hotspots().length > 0 && <text fg={s.border}>{DIVIDER}</text>}

            {/* ─── ACTIVITY ─── */}
            <box flexDirection="column" padding={[0, 0]} gap={0}>
              <box flexDirection="row" justifyContent="space-between">
                <text fg={s.muted}>Activity · Live</text>
              </box>
              <text fg={s.border}>{DIVIDER}</text>
              {feed().length > 0
                ? feed().map(f => (
                    <box flexDirection="row" gap={0} key={`${f.time}${f.file}`}>
                      <text fg={s.muted}>{f.time} </text>
                      <text fg={f.err ? s.error : s.success}>{f.err ? "✗" : "✓"} </text>
                      <text fg={s.text}>{f.file}</text>
                      <text fg={s.muted}>
                        {f.added > 0 ? ` +${f.added}` : ""}{f.removed > 0 ? ` -${f.removed}` : ""}
                      </text>
                    </box>
                  ))
                : <text fg={s.muted}>  No edits yet</text>
              }
            </box>

            <text fg={s.border}>{DIVIDER}</text>

            {/* ─── INFO LINE ─── */}
            <box flexDirection="row" justifyContent="space-between" padding={[0, 0]}>
              <text fg={s.muted}>v0.5.1 · {proj()}</text>
            </box>

            <text fg={s.border}>{DIVIDER}</text>
          </box>
        )
      },
    },
  }
}

// =============================================================================
// MetricItem — with delta
// =============================================================================
function MetricItem(props: {
  s: ReturnType<typeof theme>
  label: string
  value: number
  delta: { value: number; dir: "up" | "down" | "same" }
  deltaColor: Color
  deltaSymbol: string
  error?: boolean
}) {
  const valStr = String(props.value)
  const deltaStr = props.delta.dir !== "same" ? ` ${props.deltaSymbol}${props.delta.value}` : ""
  const total = valStr.length + deltaStr.length
  const pad = Math.max(0, 8 - total)
  const leftPad = " ".repeat(Math.floor(pad / 2))
  const rightPad = " ".repeat(Math.ceil(pad / 2))

  return (
    <box flexDirection="column" alignItems="center" justifyContent="center" gap={0} flexGrow={1}>
      <text fg={props.s.muted}>{props.label}</text>
      <box flexDirection="row" gap={0} justifyContent="center">
        <text>{leftPad}</text>
        <text fg={props.error ? props.s.error : props.s.text}><b>{valStr}</b></text>
        <text fg={props.delta.dir !== "same" ? props.deltaColor : props.s.text}>
          {props.delta.dir !== "same" ? ` ${props.deltaSymbol}${props.delta.value}` : ""}
        </text>
        <text>{rightPad}</text>
      </box>
    </box>
  )
}

// =============================================================================
// MetricItemSimple — no delta
// =============================================================================
function MetricItemSimple(props: {
  s: ReturnType<typeof theme>
  label: string
  value: number
}) {
  const valStr = String(props.value)
  const pad = Math.max(0, 8 - valStr.length)
  const leftPad = " ".repeat(Math.floor(pad / 2))
  const rightPad = " ".repeat(Math.ceil(pad / 2))

  return (
    <box flexDirection="column" alignItems="center" justifyContent="center" gap={0} flexGrow={1}>
      <text fg={props.s.muted}>{props.label}</text>
      <box flexDirection="row" gap={0} justifyContent="center">
        <text>{leftPad}</text>
        <text fg={props.s.text}><b>{valStr}</b></text>
        <text>{rightPad}</text>
      </box>
    </box>
  )
}

// =============================================================================
// Plugin Entry
// =============================================================================

const tui: TuiPlugin = async (
  api: TuiPluginApi,
  _options: unknown,
  _meta: TuiPluginMeta,
) => {
  api.slots.register(createStatsPanel(api))
}

const plugin: TuiPluginModule & { id: string } = {
  id: "code-shadow-stats",
  tui,
}

export default plugin
