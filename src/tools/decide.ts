// =============================================================================
// Code Shadow — Decision Recording Tool: code_shadow_decide
// Записывает архитектурное решение (ADR) в БД. Сохраняет контекст,
// альтернативы, связанные файлы. Создаёт узлы и рёбра в графе знаний.
// =============================================================================

import { tool } from "@opencode-ai/plugin"
import type { StorageEngine } from "../storage"
import type { ShadowConfig, Decision } from "../types"
import { NodeType, EdgeType } from "../types"
import { sanitizeContent } from "../config"
import { createLogger } from "../logger"

// ---------------------------------------------------------------------------
// Извлечение тегов из текста
// ---------------------------------------------------------------------------

/**
 * Извлекает теги из текста: пути к файлам, тех-термины, строки в кавычках.
 * Возвращает до 10 уникальных тегов.
 */
function extractTags(content: string): string[] {
  const tags = new Set<string>()

  // Пути к директориям и файлам
  const pathRe = /[^\s(){}[\]]*\/(?:[\w.-]+\/)*[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|py|rs|go|java|kt|rb|css|scss|json|yaml|yml|sql|md|html)/gi
  for (const match of content.matchAll(pathRe)) {
    if (tags.size >= 10) break
    tags.add(match[0])
  }

  // Технологические термины
  const techTerms = [
    "TypeScript", "JavaScript", "React", "Vue", "Angular", "Node", "Python", "Rust",
    "SQLite", "PostgreSQL", "MySQL", "Redis", "Docker", "GraphQL", "REST", "gRPC",
    "JWT", "OAuth", "CLI", "API", "CSS", "Tailwind", "Prisma", "Drizzle", "Zod",
    "Valibot", "Express", "Fastify", "Next.js", "Nuxt", "tRPC", "WebSocket",
  ]
  for (const term of techTerms) {
    if (tags.size >= 10) break
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const re = new RegExp(`\\b${escaped}\\b`, "i")
    if (re.test(content)) {
      tags.add(term.toLowerCase())
    }
  }

  return Array.from(tags).slice(0, 10)
}

// =============================================================================
// createDecideTool — фабрика тулза
// =============================================================================

export function createDecideTool(
  storage: StorageEngine,
  config: ShadowConfig,
  log: ReturnType<typeof createLogger>,
): Record<string, unknown> {
  const decideLog = createLogger("decide-tool")

  return {
    code_shadow_decide: tool({
      description:
        "Записывает архитектурное решение. ИСПОЛЬЗУЙ для важных технических решений — выбор БД, паттерна, библиотеки.",

      args: {
        title: tool.schema.string(),
        description: tool.schema.string(),
        context: tool.schema.string().optional(),
        alternatives: tool.schema.array(tool.schema.string()).optional(),
        status: tool.schema
          .enum(["proposed", "accepted", "deprecated", "superseded"])
          .optional(),
        related_files: tool.schema.array(tool.schema.string()).optional(),
        tags: tool.schema.array(tool.schema.string()).optional(),
      },

      async execute(args, context) {
        try {
          // 1. Санитизация текстовых полей
          const title = sanitizeContent(
            args.title as string,
            config.secretPatterns,
          )
          const description = sanitizeContent(
            args.description as string,
            config.secretPatterns,
          )
          const decisionContext = args.context
            ? sanitizeContent(args.context as string, config.secretPatterns)
            : null
          const alternatives = (args.alternatives as string[] | undefined) || null
          const status = (args.status as string | undefined) || "proposed"
          const relatedFiles =
            (args.related_files as string[] | undefined) || null

          // Авто-извлечение тегов если не указаны явно
          let tags: string[]
          if (args.tags && (args.tags as string[]).length > 0) {
            tags = (args.tags as string[]).map((t) =>
              sanitizeContent(t, config.secretPatterns),
            )
          } else {
            tags = extractTags(`${title} ${description}`)
          }

          // 2. Вставка в таблицу decisions
          const decisionId = storage.insertDecision({
            title,
            description,
            context: decisionContext,
            alternatives,
            status: status as Decision["status"],
            decidedBy: (context as Record<string, unknown>).sessionID as string || null,
            decidedAt: Date.now(),
            supersededBy: null,
            relatedFiles,
            tags,
          })

          if (decisionId < 0) {
            return {
              output: JSON.stringify(
                {
                  error: true,
                  message: "Ошибка сохранения решения в базу данных",
                },
                null,
                2,
              ),
            }
          }

          // decisions.id и knowledge_nodes.id принадлежат разным таблицам.
          // Сначала создаём узел ADR, чтобы внешние ключи knowledge_edges
          // ссылались на правильную сущность графа.
          const decisionNodeId = storage.upsertNode({
            nodeType: NodeType.Decision,
            name: `ADR #${decisionId}: ${title}`.slice(0, 200),
            path: null,
            metadata: {
              decision_id: decisionId,
              title,
              status,
              category: "ARCHITECTURE",
              content: description,
            },
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })

          // 3. Создаём узел в графе знаний для каждого related_file
          // и связываем решение с файлами
          if (relatedFiles && relatedFiles.length > 0) {
            for (const filePath of relatedFiles) {
              // Создаём или обновляем файловый узел
              const fileNodeId = storage.upsertNode({
                nodeType: NodeType.File,
                name: filePath.split("/").pop() || filePath,
                path: filePath,
                metadata: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              })

              if (decisionNodeId > 0 && fileNodeId > 0) {
                // Создаём ребро references от решения к файлу
                storage.upsertEdge({
                  sourceId: decisionNodeId,
                  targetId: fileNodeId,
                  edgeType: EdgeType.References,
                  weight: 0.8,
                  evidenceCount: 1,
                })
              }
            }
            decideLog.debug(
              `Созданы связи решения #${decisionId} с ${relatedFiles.length} файлами`,
            )
          }

          decideLog.info(
            `Решение записано: id=${decisionId}, title="${title}", status=${status}, tags=[${tags.join(", ")}]`,
          )

          return {
            output: JSON.stringify(
              {
                status: "ok",
                decision_id: decisionId,
                title,
                decision_status: status,
                tags,
                related_files_count: relatedFiles?.length || 0,
                created_at: Date.now(),
                message: `Архитектурное решение «${title}» записано (ID: ${decisionId}).`,
              },
              null,
              2,
            ),
          }
        } catch (err) {
          decideLog.error(`Ошибка code_shadow_decide: ${String(err)}`)
          return {
            output: JSON.stringify(
              {
                error: true,
                message: `Ошибка записи решения: ${String(err)}`,
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
