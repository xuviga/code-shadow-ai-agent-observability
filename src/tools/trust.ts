// =============================================================================
// Code Shadow — Tool Trust tool (`code_shadow_tool_trust`)
// =============================================================================
// Pins tool descriptions and input schemas, lists changed/suspicious tools,
// manually trusts or blocks a tool, scans a JSON dump of MCP tools and verifies
// a single tool against its pinned fingerprint.
// =============================================================================

import { tool } from "@opencode-ai/plugin"
import type { StorageEngine } from "../storage"
import type { ShadowConfig, ToolTrustStatus } from "../types"
import { sanitizeContent } from "../config"
import { createLogger } from "../logger"
import { stableStringify } from "../passport"
import { hashText, isSuspiciousToolDescription, toolFingerprint } from "../tool-trust"

type ToolContext = Record<string, unknown>

function resolveRoot(storage: StorageEngine, context: ToolContext, explicit?: string): string {
  if (explicit) return explicit
  const sessionId = context.sessionID as string | undefined
  const session = sessionId ? storage.getSession(sessionId) : undefined
  return (
    session?.projectRoot ||
    (context.directory as string | undefined) ||
    (context.cwd as string | undefined) ||
    process.cwd()
  )
}

function output(value: unknown): { output: string } {
  return { output: JSON.stringify(value, null, 2) }
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text.length > 0 ? text : null
}

/** One entry of the `tools_json` scan payload. */
interface ScanToolEntry {
  name?: unknown
  tool_name?: unknown
  id?: unknown
  server?: unknown
  serverName?: unknown
  description?: unknown
  input_schema?: unknown
  input?: unknown
  parameters?: unknown
  schema?: unknown
}

export function createToolTrustTool(
  storage: StorageEngine,
  config: ShadowConfig,
  log: ReturnType<typeof createLogger>,
): Record<string, unknown> {
  const trustLog = createLogger("tool-trust-tool")

  return {
    code_shadow_tool_trust: tool({
      description:
        "Закрепляет описания и схемы инструментов (включая MCP), показывает изменённые/подозрительные инструменты, позволяет доверять, блокировать, сканировать и проверять их отпечатки.",
      args: {
        action: tool.schema.enum(["list", "get", "trust", "block", "scan", "verify"]),
        status: tool.schema
          .enum(["trusted", "changed", "blocked", "suspicious"])
          .optional(),
        limit: tool.schema.number().optional(),
        tool_name: tool.schema.string().optional(),
        tools_json: tool.schema.string().optional(),
        description: tool.schema.string().optional(),
        input_schema: tool.schema.unknown().optional(),
        project_root: tool.schema.string().optional(),
      },
      async execute(args, context) {
        const root = resolveRoot(storage, context as ToolContext, args.project_root)
        try {
          if (args.action === "list") {
            const limit = Math.max(1, Math.min(500, Math.floor(args.limit ?? 100)))
            const records = storage.listToolTrust(
              root,
              args.status as ToolTrustStatus | undefined,
              limit,
            )
            return output({ records, count: records.length })
          }

          if (args.action === "scan") {
            if (!args.tools_json) return output({ error: "tools_json обязателен для scan" })
            let parsed: unknown
            try {
              parsed = JSON.parse(args.tools_json)
            } catch {
              return output({ error: "tools_json: невалидный JSON" })
            }
            if (!Array.isArray(parsed)) {
              return output({ error: "tools_json должен содержать JSON-массив инструментов" })
            }

            const results: Array<{
              tool_name: string
              changed: boolean
              status: ToolTrustStatus
              previous_status: ToolTrustStatus | null
            }> = []
            const suspicious: string[] = []

            for (const raw of parsed as ScanToolEntry[]) {
              if (!raw || typeof raw !== "object") continue
              const name = optionalString(raw.name ?? raw.tool_name ?? raw.id)
              if (!name) continue

              const description = sanitizeContent(
                String(raw.description ?? ""),
                config.secretPatterns,
              )
              const schema = raw.input_schema ?? raw.input ?? raw.parameters ?? raw.schema ?? {}
              const result = storage.upsertToolTrust({
                projectRoot: root,
                serverName: optionalString(raw.server ?? raw.serverName),
                toolName: name,
                fingerprint: toolFingerprint(name, description, schema),
                descriptionHash: hashText(description),
                schemaHash: hashText(stableStringify(schema)),
                metadata: { source: "tool-trust-scan" },
              })

              let record = result.record
              const suspiciousDescription = isSuspiciousToolDescription(description)
              if (suspiciousDescription) {
                record = storage.setToolTrustStatus(root, name, "suspicious") ?? record
                suspicious.push(name)
              }

              results.push({
                tool_name: name,
                changed: result.changed,
                status: record.status,
                previous_status: result.previousStatus,
              })
            }

            return output({ results, suspicious, count: results.length })
          }

          if (!args.tool_name) {
            return output({ error: "tool_name обязателен для этого действия" })
          }
          const toolName = args.tool_name

          if (args.action === "get") {
            const record = storage.getToolTrust(root, toolName)
            return record
              ? output({ record })
              : output({ error: `Инструмент не найден: ${toolName}` })
          }

          if (args.action === "trust" || args.action === "block") {
            const status: ToolTrustStatus = args.action === "trust" ? "trusted" : "blocked"
            const record = storage.setToolTrustStatus(root, toolName, status)
            return record
              ? output({ record })
              : output({ error: `Инструмент не найден: ${toolName}` })
          }

          if (args.action === "verify") {
            const record = storage.getToolTrust(root, toolName)
            if (!record) return output({ error: `Инструмент не найден: ${toolName}` })
            if (args.description === undefined && args.input_schema === undefined) {
              // Nothing to recompute against: report the pinned state instead of
              // comparing with an empty description and producing a false alarm.
              return output({
                trusted: record.status === "trusted",
                expected: record.fingerprint,
                actual: null,
                status: record.status,
                note: "Передай description и input_schema, чтобы пересчитать fingerprint",
                first_seen: record.firstSeen,
                last_seen: record.lastSeen,
              })
            }

            const description = sanitizeContent(
              args.description ?? "",
              config.secretPatterns,
            )
            const schema = args.input_schema ?? {}
            const actual = toolFingerprint(toolName, description, schema)
            return output({
              trusted: actual === record.fingerprint,
              expected: record.fingerprint,
              actual,
              status: record.status,
            })
          }

          return output({ error: `Неизвестное действие: ${String(args.action)}` })
        } catch (err) {
          trustLog.error(`tool trust error: ${String(err)}`)
          log.debug(`tool trust error: ${String(err)}`)
          return output({ error: String(err) })
        }
      },
    }),
  }
}

export default createToolTrustTool
