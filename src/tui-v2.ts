// =============================================================================
// Code Shadow — OpenCode 2 TUI adapter
//
// The panel implementation lives in ../tui-plugin.tsx and targets the V1 TUI
// API (`api.slots.register`, `api.event.on`). OpenCode 2 exposes a context with
// `ui.slot`, `data.on`, and theme tokens instead. This adapter keeps the panel
// code untouched and bridges those two APIs.
// =============================================================================

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Plugin as TuiPluginNamespace } from "@opencode/plugin/tui"
import { appendFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// `@opencode/plugin/tui` exports define() as an identity function. Inlining
// it removes the adapter's only runtime dependency, so the plugin directory
// does not need node_modules to load it.
const Plugin = {
  define: <Definition>(plugin: Definition): Definition => plugin,
}

function logTui(payload: Record<string, unknown>): void {
  try {
    appendFileSync(
      join(homedir(), ".config", "opencode", "shadow", "tui-debug.log"),
      `${new Date().toISOString()} ${JSON.stringify(payload)}\n`,
    )
  } catch {
    // Diagnostics must never break the plugin.
  }
}

// The V2 event union is the only source of truth for subscriptions: a name
// outside it would compile only through a cast and would never fire.
export type V2EventName = Parameters<TuiPluginNamespace.Context["data"]["on"]>[0]

export const eventMap: Record<string, ReadonlyArray<V2EventName>> = {
  "session.created": ["session.created"],
  "session.updated": ["session.status", "session.metadata.updated", "session.renamed"],
  "session.idle": ["session.idle"],
  "message.part.updated": ["session.text.delta", "session.reasoning.delta"],
  "file.edited": ["filesystem.changed"],
  "session.error": ["session.execution.failed"],
  // V1 emits `command.executed`; V2 exposes TUI commands as
  // `tui.command.execute`, which is close enough for panel refresh.
  "command.executed": ["tui.command.execute"],
}

type Rgba = {
  readonly r: number
  readonly g: number
  readonly b: number
  readonly a?: number
}

// Keys read by the panel's own theme() helper in tui-plugin.tsx.
export type PanelTheme = {
  readonly primary: string
  readonly text: string
  readonly textMuted: string
  readonly success: string
  readonly warning: string
  readonly error: string
  readonly borderSubtle: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isRgba(value: unknown): value is Rgba {
  return (
    isRecord(value) &&
    typeof value.r === "number" &&
    typeof value.g === "number" &&
    typeof value.b === "number"
  )
}

function rgbaToHex(value: Rgba): string {
  // The host's theme package is not a build-time dependency here, so the
  // channel scale is detected instead of assumed: OpenTUI uses 0-255, while
  // some hosts expose normalized 0-1 floats. Alpha is dropped because the V1
  // theme contract consumes opaque color strings.
  const normalized = value.r <= 1 && value.g <= 1 && value.b <= 1
  const channel = (n: number) => {
    const scaled = Math.round(normalized ? n * 255 : n)
    return Math.max(0, Math.min(255, scaled)).toString(16).padStart(2, "0")
  }
  return `#${channel(value.r)}${channel(value.g)}${channel(value.b)}`
}

function firstColor(value: unknown, fallback: string): string {
  if (typeof value === "string" && value) return value
  if (isRgba(value)) return rgbaToHex(value)
  if (isRecord(value)) {
    // V1 themes nest tokens under { base, primary, ... }.
    for (const key of ["base", "primary", "default", "main", "subtle", "muted"]) {
      const nested = value[key]
      if (typeof nested === "string" && nested) return nested
      if (isRgba(nested)) return rgbaToHex(nested)
    }
  }
  return fallback
}

function token(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

export function mapTheme(theme: unknown): PanelTheme {
  const text = token(theme, "text")
  const border = token(theme, "border")
  return {
    // V2 exposes RGBA tokens (`primary`, `text`, `textMuted`, ...); V1 nested
    // text tokens under `text.base`/`text.primary`, so both shapes are accepted.
    primary: firstColor(token(theme, "primary") ?? token(theme, "accent"), "#7c3aed"),
    text: firstColor(token(text, "base") ?? token(text, "primary") ?? token(theme, "foreground") ?? text, "#e6edf3"),
    textMuted: firstColor(token(theme, "textMuted") ?? token(text, "muted") ?? token(text, "dim") ?? token(text, "faint"), "#484f58"),
    success: firstColor(token(theme, "success"), "#3fb950"),
    warning: firstColor(token(theme, "warning"), "#d29922"),
    error: firstColor(token(theme, "error"), "#f85149"),
    borderSubtle: firstColor(token(border, "subtle") ?? token(border, "base") ?? token(theme, "borderSubtle") ?? border, "#21262d"),
  }
}

export type PanelRenderContext = {
  readonly theme: { readonly current: PanelTheme }
  readonly state: any
}

// Narrow structural view of the V1 slot plugin the panel registers.
export type PanelSlotPlugin = {
  readonly order?: number
  readonly slots?: {
    readonly sidebar_content?: (ctx: PanelRenderContext, value: unknown) => JSX.Element
  }
}

type SidebarClaim = {
  readonly append: "sidebar.content"
  readonly render: (input: unknown) => JSX.Element
}

// The subset of TuiPluginApi the panel actually touches.
export type PanelApi = {
  readonly theme: { readonly current: PanelTheme }
  readonly state?: any
  readonly client?: any
  readonly slots: {
    register(plugin: PanelSlotPlugin): void
  }
  readonly event: {
    on(name: string, callback: () => void): () => void
  }
}

// The subset of the V2 plugin context this adapter consumes.
export type AdapterContext = {
  readonly theme: unknown
  readonly location?: { readonly directory?: string }
  readonly client?: any
  readonly data: {
    on(type: V2EventName, handler: () => void): () => void
    readonly session?: any
    readonly location?: any
  }
  readonly ui: {
    slot(claim: SidebarClaim): () => void
  }
}

export function createPanelShim(context: AdapterContext): {
  api: PanelApi
  dispose: () => void
} {
  const cleanups: Array<() => void> = []
  const data: any = (context as any)?.data
  const sessionApi: any = data?.session
  const client: any = (context as any)?.client
  const diffCache = new Map<string, { at: number; items: any[] }>()
  const diffInFlight = new Set<string>()
  const synced = new Set<string>()

  const readDirectory = (): string => {
    try {
      return context.location?.directory ?? data?.location?.default?.()?.directory ?? ""
    } catch {
      return ""
    }
  }
  const readBranch = (): string => {
    try {
      const branch = data?.location?.vcs?.info?.()?.branch
      // OpenCode 2 exposes VcsBranch { current?, default? }, not a string.
      if (typeof branch === "string") return branch
      if (branch && typeof branch === "object") {
        return String(branch.current ?? branch.default ?? "")
      }
      return ""
    } catch {
      return ""
    }
  }

  // The V1 panel reads `api.state`. OpenCode 2 exposes the live session via
  // `data.session` (SessionInfo + a typed message list), so adapt it here
  // instead of leaving the panel with an empty V1 state shim.
  const panelState = {
    get path() {
      return { directory: readDirectory() }
    },
    get vcs() {
      return { branch: readBranch() }
    },
    session: {
      get(sessionID: string) {
        try {
          const info = sessionApi?.get?.(sessionID)
          if (!info && !synced.has(sessionID)) {
            synced.add(sessionID)
            Promise.resolve(sessionApi?.sync?.(sessionID)).catch(() => {})
          }
          return info
        } catch {
          return undefined
        }
      },
      status(sessionID: string) {
        try {
          const status = sessionApi?.status?.(sessionID)
          return status ? { type: status === "running" ? "busy" : "idle" } : undefined
        } catch {
          return undefined
        }
      },
      messages(sessionID: string) {
        try {
          return sessionApi?.message?.list?.(sessionID) ?? []
        } catch {
          return []
        }
      },
      diff(sessionID: string) {
        const cached = diffCache.get(sessionID)
        if (!cached || Date.now() - cached.at > 2000) {
          if (!diffInFlight.has(sessionID) && typeof client?.session?.diff === "function") {
            diffInFlight.add(sessionID)
            Promise.resolve()
              .then(() => client.session.diff({ sessionID }))
              .then((items: any) => {
                diffCache.set(sessionID, { at: Date.now(), items: Array.isArray(items) ? items : [] })
              })
              .catch(() => {})
              .finally(() => diffInFlight.delete(sessionID))
          }
        }
        return cached?.items ?? []
      },
      todo() {
        return []
      },
    },
  }

  const api: PanelApi = {
    get theme() {
      return { current: mapTheme(context.theme) }
    },
    get state() {
      return panelState
    },
    slots: {
      register(plugin) {
        const sidebar = plugin.slots?.sidebar_content
        if (typeof sidebar !== "function") {
          logTui({ kind: "adapter-slot-missing" })
          return
        }
        try {
          const dispose = context.ui.slot({
            append: "sidebar.content",
            render: (props) => {
              try {
                return sidebar(
                  {
                    theme: { current: mapTheme(context.theme) },
                    state: panelState,
                  },
                  props,
                )
              } catch (error) {
                logTui({ kind: "adapter-render-error", error: String(error), stack: (error as Error)?.stack })
                return null as any
              }
            },
          })
          cleanups.push(dispose)
          logTui({ kind: "adapter-slot", ok: true })
        } catch (error) {
          logTui({ kind: "adapter-slot-error", error: String(error), stack: (error as Error)?.stack })
        }
      },
    },
    event: {
      on(name, callback) {
        const types = eventMap[name] ?? []
        const unsubscribers = types.map((type) => {
          try {
            return context.data.on(type, callback)
          } catch {
            return () => {}
          }
        })
        return () => {
          for (const unsubscribe of unsubscribers) unsubscribe()
        }
      },
    },
  }

  return {
    api,
    dispose: () => {
      for (const cleanup of cleanups.splice(0)) cleanup()
    },
  }
}

// The panel is copied next to this adapter by postinstall, while in the repo
// layout it lives one level up. Bun resolves a `.js` specifier to `.tsx`, so the
// first two candidates cover both layouts; the explicit `.tsx` entries are a
// fallback for runtimes that do not perform that substitution.
const PANEL_CANDIDATES = [
  "./tui-plugin.js",
  "../tui-plugin.js",
  "./tui-plugin.tsx",
  "../tui-plugin.tsx",
] as const

type PanelModule = {
  tui(api: TuiPluginApi, options?: unknown): Promise<void> | void
}

async function loadPanelModule(): Promise<PanelModule> {
  const failures: string[] = []
  for (const candidate of PANEL_CANDIDATES) {
    // A plain string variable keeps TypeScript from resolving the specifier at
    // build time: only one of the candidates exists in any given layout.
    const specifier: string = candidate
    try {
      const loaded: any = await import(specifier)
      const panel = loaded?.default ?? loaded
      if (panel && typeof panel.tui === "function") {
        logTui({ kind: "adapter-panel-loaded", specifier })
        return panel as PanelModule
      }
      failures.push(`${specifier}: no tui() export`)
    } catch (error) {
      failures.push(`${specifier}: ${String(error)}`)
    }
  }

  logTui({ kind: "adapter-panel-missing", failures })
  throw new Error(
    `[code-shadow] TUI panel module not found. Tried: ${PANEL_CANDIDATES.join(", ")}. ` +
      `Run the package postinstall (or copy tui-plugin.tsx next to tui-v2.ts) and restart OpenCode.`,
  )
}

export default Plugin.define({
  id: "code-shadow-stats",
  async setup(context: any) {
    try {
      const panel = await loadPanelModule()
      logTui({ kind: "adapter-setup", hasPanel: Boolean(panel), directory: (context as any)?.location?.directory })
      const { api, dispose } = createPanelShim(context)
      // The V1 panel expects the full TuiPluginApi while this adapter implements
      // only the subset it uses. V1 and V2 are structurally incompatible, so this
      // is the single explicit cast on the V1 boundary.
      await panel.tui(api as unknown as TuiPluginApi, undefined)
      return dispose
    } catch (error) {
      logTui({ kind: "adapter-error", error: String(error), stack: (error as Error)?.stack })
      throw error
    }
  },
})
