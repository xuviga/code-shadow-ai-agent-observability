// =============================================================================
// Code Shadow — Context Injection Tool: code_shadow_context_inject
// Внедряет релевантный контекст о проекте в текущую сессию AI-агента.
// Собирает архитектуру, конвенции, хотспоты, недавние изменения и ADR.
// =============================================================================

import { tool } from "@opencode-ai/plugin"
import type { StorageEngine } from "../storage"
import type { ShadowConfig, KnowledgeNode, Decision, FileEdit } from "../types"
import { NodeType, AgentType } from "../types"
import { sanitizeContent } from "../config"
import { createLogger } from "../logger"

// =============================================================================
// createContextTool — фабрика тулза
// =============================================================================

export function createContextTool(
  storage: StorageEngine,
  config: ShadowConfig,
  log: ReturnType<typeof createLogger>,
): Record<string, unknown> {
  const ctxLog = createLogger("context-tool")

  return {
    code_shadow_context_inject: tool({
      description:
        "Внедряет контекст проекта в сессию. ВЫЗЫВАЙ В НАЧАЛЕ СЕССИИ на знакомом проекте чтобы загрузить архитектуру, конвенции и hotspots.",

      args: {
        focus: tool.schema.string().optional(),
        include: tool.schema
          .array(
            tool.schema.enum([
              "architecture",
              "conventions",
              "hotspots",
              "recent_changes",
              "decisions",
              "agent_state",
            ]),
          )
          .optional(),
      },

      async execute(args, context) {
        const sections: string[] = []
        const includes: string[] =
          args.include && (args.include as string[]).length > 0
            ? (args.include as string[])
            : ["architecture", "conventions", "hotspots", "recent_changes", "decisions", "agent_state"]

        const focus = args.focus as string | undefined
        const session = context.sessionID ? storage.getSession(context.sessionID) : undefined
        const projectRoot = session?.projectRoot || (context as Record<string, unknown>).directory as string || process.cwd()

        try {
          // =====================================================================
          // 1. Архитектура проекта — узлы типа module/concept
          // =====================================================================
          if (includes.includes("architecture")) {
            const moduleNodes = storage.getNodesByType(NodeType.Module)
            const conceptNodes = storage.getNodesByType(NodeType.Concept)
            const archNodes = [...moduleNodes, ...conceptNodes]

            if (archNodes.length > 0) {
              const lines: string[] = ["## Архитектура проекта"]
              for (const node of archNodes.slice(0, 10)) {
                const meta = node.metadata as Record<string, unknown> | null
                const desc = (meta?.content ?? meta?.full_content)
                  ? sanitizeContent(String(meta.content ?? meta.full_content), config.secretPatterns).slice(0, 300)
                  : node.path || ""
                lines.push(`- **${node.name}**: ${desc}`)
              }
              sections.push(lines.join("\n"))
            }
          }

          // =====================================================================
          // 2. Конвенции — узлы с категориями PROJECT_RULES, NAMING, CONSTRAINTS, CONFIG_VALUES
          // =====================================================================
          if (includes.includes("conventions")) {
            const ruleNodes = storage.getNodesByType(NodeType.Rule)
            const patternNodes = storage.getNodesByType(NodeType.Pattern)
            const conventionNodes = [...ruleNodes, ...patternNodes]

            // Также ищем concept-узлы с соответствующими категориями в метаданных
            const allConcepts = storage.getNodesByType(NodeType.Concept)
            for (const c of allConcepts) {
              const meta = c.metadata as Record<string, unknown> | null
              const cat = meta?.category as string | undefined
              if (
                cat &&
                ["PROJECT_RULES", "NAMING", "CONFIG_VALUES", "CONSTRAINTS"].includes(cat)
              ) {
                conventionNodes.push(c)
              }
            }

            if (conventionNodes.length > 0) {
              const lines: string[] = ["## Конвенции и ограничения"]
              for (const node of conventionNodes.slice(0, 15)) {
                const meta = node.metadata as Record<string, unknown> | null
                const content = (meta?.content ?? meta?.full_content)
                  ? sanitizeContent(String(meta.content ?? meta.full_content), config.secretPatterns)
                  : node.path || node.name
                lines.push(`- ${content}`)
              }
              sections.push(lines.join("\n"))
            }
          }

          // =====================================================================
          // 3. Хотспоты — топ-5 проблемных файлов
          // =====================================================================
          if (includes.includes("hotspots")) {
            // Используем кеш аналитики либо соберём данные напрямую
            const cacheKey = "hotspots:30d:5"
            const cached = storage.getCached(cacheKey) as {
              hotspots?: Array<{
                filePath: string
                score: number
                explanation: string
              }>
            } | undefined

            if (cached && cached.hotspots && cached.hotspots.length > 0) {
              const lines: string[] = ["## Проблемные файлы (hotspots)"]
              for (const h of cached.hotspots) {
                lines.push(
                  `- \`${h.filePath}\` — score: ${h.score}/100 — ${h.explanation}`,
                )
              }
              sections.push(lines.join("\n"))
            } else {
              // Fallback: собираем вручную — топ-5 файлов по частоте ошибок
              const allFiles = storage.getDistinctFiles("30d")
              const fileScores: { path: string; score: number; errors: number; edits: number }[] = []

              for (const file of allFiles.slice(0, 100)) {
                const errors = storage.getErrorCountForFile(file, "30d")
                const edits = storage.getFileEditCount(file, "30d")
                if (edits === 0) continue
                const score = Math.min(Math.round((errors / edits) * 100), 100)
                fileScores.push({ path: file, score, errors, edits })
              }
              fileScores.sort((a, b) => b.score - a.score)
              const top5 = fileScores.slice(0, 5)

              if (top5.length > 0) {
                const lines: string[] = ["## Проблемные файлы (hotspots)"]
                for (const f of top5) {
                  lines.push(
                    `- \`${f.path}\` — ${f.errors} ошибок на ${f.edits} правок (score: ${f.score}/100)`,
                  )
                }
                sections.push(lines.join("\n"))
              }
            }
          }

          // =====================================================================
          // 4. Недавние изменения — последние 10 правок в любом timeframe
          // =====================================================================
          if (includes.includes("recent_changes")) {
            const allFiles = storage.getDistinctFiles("7d")
            const fileChanges: { path: string; count: number }[] = []

            for (const file of allFiles.slice(0, 50)) {
              const count = storage.getFileEditCount(file, "7d")
              if (count > 0) fileChanges.push({ path: file, count })
            }
            fileChanges.sort((a, b) => b.count - a.count)

            if (fileChanges.length > 0) {
              const lines: string[] = ["## Недавние изменения (7 дней)"]
              for (const fc of fileChanges.slice(0, 10)) {
                lines.push(`- \`${fc.path}\` — ${fc.count} правок`)
              }
              sections.push(lines.join("\n"))
            }
          }

          // =====================================================================
          // 5. Архитектурные решения — последние 5 accepted
          // =====================================================================
          if (includes.includes("decisions")) {
            const decisions = storage.getDecisions("accepted", 5)

            if (decisions.length > 0) {
              const lines: string[] = ["## Ключевые архитектурные решения"]
              for (const d of decisions) {
                const desc = sanitizeContent(
                  d.description.length > 200
                    ? d.description.slice(0, 200) + "..."
                    : d.description,
                  config.secretPatterns,
                )
                lines.push(`- **${d.title}** [${d.status}]: ${desc}`)
              }
              sections.push(lines.join("\n"))
            }
          }

          // =====================================================================
          // 6. Agent operating state — цель, evidence, failures and contracts
          // =====================================================================
          if (includes.includes("agent_state")) {
            const tasks = storage.listTasks(projectRoot, undefined, 5)
            const active = tasks.find((task) => task.status === "active") || tasks[0]
            const evidence = storage.listEvidence(projectRoot, active?.id, 5)
            const failures = storage.searchFailures(projectRoot, active?.goal, 5).filter((item) => item.status === "open")
            const contracts = storage.listChangeContracts(projectRoot, active?.id).filter((item) => item.status === "active")
            const contradictions = storage.listContradictions(projectRoot, "open", 5)
            if (active || evidence.length || failures.length || contracts.length || contradictions.length) {
              const lines: string[] = ["## Agent operating state"]
              if (active) {
                lines.push(`- **Задача**: ${active.title} — ${active.goal} [${active.status}]`)
                const steps = storage.listTaskSteps(active.id)
                if (steps.length) lines.push(`- **Шаги**: ${steps.map((step) => `${step.status}: ${step.title}`).join("; ")}`)
              }
              if (evidence.length) lines.push(`- **Последние evidence**: ${evidence.map((item) => `${item.status}: ${item.claim} (${item.source})`).join("; ")}`)
              if (failures.length) lines.push(`- **Открытые сбои**: ${failures.map((item) => `${item.failure}${item.doNotRepeat ? `; не повторять: ${item.doNotRepeat}` : ""}`).join("; ")}`)
              if (contracts.length) lines.push(`- **Активные контракты изменений**: ${contracts.map((item) => `${item.goal} [${item.id}]`).join("; ")}`)
              if (contradictions.length) lines.push(`- **Неразрешённые противоречия**: ${contradictions.map((item) => `${item.claimA} ↔ ${item.claimB}`).join("; ")}`)
              sections.push(lines.join("\n"))
            }
          }

          // =====================================================================
          // 7. Если указан focus — добавляем информацию о конкретном файле/модуле
          // =====================================================================
          if (focus) {
            const focusLines: string[] = [`## Контекст для: ${focus}`]

            // Ищем узел знаний по focus
            const matchedNodes = storage.searchNodes(focus, 5)
            if (matchedNodes.length > 0) {
              focusLines.push("### Связанные знания")
              for (const node of matchedNodes) {
                const meta = node.metadata as Record<string, unknown> | null
                focusLines.push(
                  `- **${node.nodeType}: ${node.name}** — ${(meta?.content ?? meta?.full_content) ? String(meta.content ?? meta.full_content).slice(0, 150) : "нет описания"}`,
                )
              }
            }

            // Ищем файл в истории правок
            const edits = storage.getFileEdits(focus, "30d")
            if (edits.length > 0) {
              focusLines.push(
                `### История правок: ${edits.length} правок за 30 дней`,
              )
              const lastEdits = edits.slice(0, 3)
              for (const e of lastEdits) {
                focusLines.push(
                  `- ${formatDate(e.timestamp)}: ${e.agentType} ${e.editType} (+${e.linesAdded}/-${e.linesRemoved})`,
                )
              }
            }

            // Ошибки файла
            const focusErrors = storage.getErrorCountForFile(focus, "30d")
            if (focusErrors > 0) {
              focusLines.push(`### Ошибки: ${focusErrors} за 30 дней`)
            }

            sections.push(focusLines.join("\n"))
          }

          // =====================================================================
          // Собираем финальный контекст
          // =====================================================================

          if (sections.length === 0) {
            return {
              output: JSON.stringify(
                {
                  context: "",
                  sections_count: 0,
                  message:
                    "Нет доступного контекста. Плагин только установлен, данных недостаточно. Поработайте в проекте — Observer автоматически соберёт данные.",
                  injected_at: Date.now(),
                },
                null,
                2,
              ),
            }
          }

          const contextString = sections.join("\n\n")

          ctxLog.info(
            `Контекст внедрён: ${sections.length} разделов, focus=${focus ?? "нет"}`,
          )

          return {
            output: JSON.stringify(
              {
                context: contextString,
                sections_count: sections.length,
                focus: focus || null,
                injected_at: Date.now(),
                message: `Контекст проекта внедрён. ${sections.length} разделов.`,
              },
              null,
              2,
            ),
          }
        } catch (err) {
          ctxLog.error(`Ошибка code_shadow_context_inject: ${String(err)}`)
          return {
            output: JSON.stringify(
              {
                context: "",
                sections_count: 0,
                error: `Ошибка внедрения контекста: ${String(err)}`,
                injected_at: Date.now(),
              },
              null,
              2,
            ),
          }
        }
      },
    }),
  }
}

// ---------------------------------------------------------------------------
// Вспомогательные утилиты
// ---------------------------------------------------------------------------

function formatDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}
