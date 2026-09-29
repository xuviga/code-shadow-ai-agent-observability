// =============================================================================
// Code Shadow — Memory Engine Tools
// Заменяют ctx_memory, ctx_search, ctx_note из Magic Context.
// Три тулза для долговременной памяти на базе SQLite knowledge_nodes.
// =============================================================================

import { tool } from "@opencode-ai/plugin"
import type { StorageEngine } from "../storage"
import type { ShadowConfig } from "../types"
import { NodeType, type KnowledgeNodeMetadata } from "../types"
import { sanitizeContent } from "../config"
import { createLogger } from "../logger"

// ---------------------------------------------------------------------------
// Вспомогательные константы
// ---------------------------------------------------------------------------

/** Сопоставление категорий памяти → тип узла графа знаний */
const CATEGORY_TO_NODE_TYPE: Record<string, string> = {
  PROJECT_RULES: NodeType.Rule,
  ARCHITECTURE: NodeType.Concept,
  CONSTRAINTS: NodeType.Rule,
  CONFIG_VALUES: NodeType.Concept,
  NAMING: NodeType.Pattern,
}

/**
 * Набор известных технологических терминов для извлечения тегов.
 * При поиске тегов в тексте ищем эти ключевые слова (без учёта регистра).
 */
const KNOWN_TECH_TERMS = [
  "TypeScript", "JavaScript", "React", "Vue", "Angular", "Svelte",
  "Node.js", "Node", "Python", "Rust", "Go", "Golang",
  "SQLite", "PostgreSQL", "MySQL", "MongoDB", "Redis",
  "Docker", "Kubernetes", "AWS", "GCP", "Azure",
  "API", "REST", "GraphQL", "gRPC", "WebSocket",
  "JWT", "OAuth", "OAuth2", "OpenID",
  "CLI", "TUI", "GUI", "SSR", "SSG", "SPA",
  "CSS", "SCSS", "Tailwind", "Bootstrap",
  "Webpack", "Vite", "esbuild", "Rollup", "Parcel",
  "ESLint", "Prettier", "Biome",
  "Jest", "Vitest", "Mocha", "Cypress", "Playwright",
  "Git", "GitHub", "GitLab",
  "CI", "CD", "CI/CD",
  "Linux", "macOS", "Windows",
  "SQL", "NoSQL", "JSON", "YAML", "TOML", "XML",
  "HTTP", "HTTPS", "TCP", "UDP",
  "Regex", "RegExp",
  "PWA", "Electron", "Tauri",
  "Prisma", "Drizzle", "TypeORM", "Sequelize",
  "Express", "Fastify", "Koa", "Hono",
  "Next.js", "Nuxt", "Remix", "Astro",
  "tRPC", "Zod", "Valibot",
]

/** Известные ключи кеша аналитики */
const ANALYTICS_CACHE_KEYS = [
  "hotspots",
  "team_pulse",
  "dev_stats",
  "dev_trend",
  "dev_achievements",
  "predictions_recent",
  "dependency_graph",
]

// ---------------------------------------------------------------------------
// Извлечение тегов из текста
// ---------------------------------------------------------------------------

/**
 * Извлекает теги из содержимого факта для улучшения поиска.
 * Ищет: пути к файлам, имена пакетов, тех-термины, строки в кавычках.
 * Возвращает до 10 уникальных тегов.
 */
function extractTags(content: string): string[] {
  const tags = new Set<string>()

  // Пути к файлам с известными расширениями
  const filePathRe =
    /[^\s(){}[\]]*\/(?:[\w.-]+\/)*[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|py|pyi|rs|go|java|kt|kts|rb|css|scss|less|html|json|jsonc|md|mdx|sql|yaml|yml|toml|xml|svg|sh|bash|zsh|ps1|c|h|cpp|hpp|cs|swift|dart|lua|r|ex|exs|erl|hrl|hs|lhs|elm|fs|fsx|fsi|nim|zig|odin|v|cr|scala|sbt|groovy|gradle|clj|cljs|edn|proto|tf|hcl)/gi
  for (const match of content.matchAll(filePathRe)) {
    if (tags.size >= 10) break
    tags.add(match[0])
  }

  // Имена пакетов (@scope/name или package-name)
  const pkgRe = /@[\w.-]+\/[\w.-]+|(?<!\w)[\w-]+\/[\w-]+(?!=\w)/g
  for (const match of content.matchAll(pkgRe)) {
    if (tags.size >= 10) break
    const pkg = match[0].trim()
    if (pkg.length > 3 && pkg.includes("/")) {
      tags.add(pkg)
    }
  }

  // Технологические термины (без учёта регистра)
  for (const term of KNOWN_TECH_TERMS) {
    if (tags.size >= 10) break
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const re = new RegExp(`\\b${escaped}\\b`, "i")
    if (re.test(content)) {
      tags.add(term)
    }
  }

  // Строки в двойных кавычках
  const doubleQuoteRe = /"([^"]{2,40})"/g
  for (const match of content.matchAll(doubleQuoteRe)) {
    if (tags.size >= 10) break
    const quoted = match[1].trim()
    if (quoted.length >= 2) {
      tags.add(quoted)
    }
  }

  // Строки в одинарных кавычках
  const singleQuoteRe = /'([^']{2,40})'/g
  for (const match of content.matchAll(singleQuoteRe)) {
    if (tags.size >= 10) break
    const quoted = match[1].trim()
    if (quoted.length >= 2) {
      tags.add(quoted)
    }
  }

  return Array.from(tags).slice(0, 10)
}

// ---------------------------------------------------------------------------
// Вычисление релевантности
// ---------------------------------------------------------------------------

/**
 * Вычисляет простой скоринг релевантности для строки относительно запроса.
 * Точное совпадение = 10, частичное = 5, без совпадения = 0.
 */
function scoreRelevance(query: string, target: string): number {
  if (!query || !target) return 0
  const q = query.toLowerCase().trim()
  const t = target.toLowerCase()
  if (t === q) return 10
  if (t.includes(q)) return 5
  // Проверяем отдельные слова запроса
  const words = q.split(/\s+/).filter((w) => w.length > 1)
  const matchedWords = words.filter((w) => t.includes(w))
  if (matchedWords.length === words.length && words.length > 0) return 4
  if (matchedWords.length > 0) return 3
  return 0
}

// =============================================================================
// createMemoryTools
// =============================================================================

export function createMemoryTools(
  storage: StorageEngine,
  config: ShadowConfig,
  log: ReturnType<typeof createLogger>,
): Record<string, unknown> {
  const memoryLog = createLogger("memory-tools")

  return {

    // =========================================================================
    // Tool 1: code_shadow_memory_write
    // =========================================================================

    code_shadow_memory_write: tool({
      description:
        "Сохраняет факт о проекте. ИСПОЛЬЗУЙ КОГДА УЗНАЁШЬ: пути, конфигурации, конвенции, архитектурные решения. Категории: PROJECT_RULES, ARCHITECTURE, CONSTRAINTS, CONFIG_VALUES, NAMING.",

      args: {
        category: tool.schema.enum([
          "PROJECT_RULES",
          "ARCHITECTURE",
          "CONSTRAINTS",
          "CONFIG_VALUES",
          "NAMING",
        ]),
        content: tool.schema.string(),
      },

      async execute(args, context) {
        try {
          const sanitized = sanitizeContent(args.content, config.secretPatterns)
          const tags = extractTags(args.content)
          const nodeType = CATEGORY_TO_NODE_TYPE[args.category] || NodeType.Rule
          const name = sanitized.slice(0, 60).trim()

          const metadata: Record<string, unknown> = {
            category: args.category,
            content: sanitized,
            tags,
            session_id: context.sessionID,
          }

          const id = storage.upsertNode({
            nodeType: nodeType as NodeType,
            name: name || "memory_fact",
            path: null,
            metadata: metadata as unknown as KnowledgeNodeMetadata,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })

          memoryLog.info(
            `Факт сохранён: category=${args.category}, name="${name}", tags=[${tags.join(", ")}], id=${id}`,
          )

          return {
            output: JSON.stringify(
              {
                id,
                category: args.category,
                name,
                tags,
                message: "Факт сохранён в память Code Shadow",
              },
              null,
              2,
            ),
          }
        } catch (err) {
          memoryLog.error(`Ошибка code_shadow_memory_write: ${String(err)}`)
          return {
            output: `❌ Ошибка сохранения факта: ${String(err)}`,
          }
        }
      },
    }),

    // =========================================================================
    // Tool 2: code_shadow_memory_search
    // =========================================================================

    code_shadow_memory_search: tool({
      description:
        "Ищет по памяти проекта. ВЫЗЫВАЙ В НАЧАЛЕ СЕССИИ чтобы вспомнить контекст. Ищи по ключевым словам: язык, фреймворк, название модуля.",

      args: {
        query: tool.schema.string(),
        sources: tool.schema
          .array(
            tool.schema.enum([
              "memory",
              "decisions",
              "file_history",
              "analytics",
            ]),
          )
          .optional(),
        limit: tool.schema.number().optional(),
      },

      async execute(args, context) {
        const limit = args.limit || 10
        const activeSources =
          args.sources && args.sources.length > 0
            ? args.sources
            : ["memory", "decisions", "file_history", "analytics"]
        const results: Record<string, unknown>[] = []

        try {
          // -----------------------------------------------------------------
          // a) "memory" — поиск по knowledge_nodes
          // -----------------------------------------------------------------
          if (activeSources.includes("memory")) {
            const nodes = storage.searchNodes(args.query, limit)

            for (const node of nodes) {
              const meta = node.metadata as Record<string, unknown> | null
              results.push({
                type: "memory",
                node_type: node.nodeType,
                name: node.name,
                path: node.path,
                relevance: scoreRelevance(args.query, node.name),
                content: meta?.content ?? meta?.full_content ?? meta ?? null,
                tags: meta?.tags ?? null,
                category: meta?.category ?? null,
                updated_at: node.updatedAt,
                node_id: node.id,
              })
            }
          }

          // -----------------------------------------------------------------
          // b) "decisions" — поиск по таблице decisions
          // -----------------------------------------------------------------
          if (activeSources.includes("decisions")) {
            const decisions = storage.getDecisions(undefined, 100)

            for (const d of decisions) {
              const titleScore = scoreRelevance(args.query, d.title)
              const descScore = scoreRelevance(
                args.query,
                d.description,
              )
              const relevance = Math.max(titleScore, descScore)

              if (relevance > 0) {
                results.push({
                  type: "decision",
                  id: d.id,
                  title: d.title,
                  status: d.status,
                  description:
                    d.description.length > 200
                      ? d.description.slice(0, 200) + "..."
                      : d.description,
                  relevance,
                  decided_at: d.decidedAt,
                  tags: d.tags,
                  related_files: d.relatedFiles,
                })
              }
            }
          }

          // -----------------------------------------------------------------
          // c) "file_history" — поиск по file_edits
          // -----------------------------------------------------------------
          if (activeSources.includes("file_history")) {
            const allFiles = storage.getDistinctFiles()
            const queryLower = args.query.toLowerCase()

            const matchingFiles = allFiles.filter(
              (fp) =>
                fp.toLowerCase().includes(queryLower) ||
                queryLower.split(/\s+/).some(
                  (word) =>
                    word.length > 1 && fp.toLowerCase().includes(word),
                ),
            )

            for (const filePath of matchingFiles.slice(0, limit)) {
              const editCount = storage.getFileEditCount(filePath)
              const edits = storage.getFileEdits(filePath, undefined)
              const lastEdit =
                edits.length > 0 ? edits[0].timestamp : null
              const language =
                edits.length > 0 ? edits[0].fileLanguage : null

              results.push({
                type: "file",
                path: filePath,
                edit_count: editCount,
                last_edit: lastEdit,
                language,
                relevance: scoreRelevance(args.query, filePath),
              })
            }
          }

          // -----------------------------------------------------------------
          // d) "analytics" — поиск по analytics_cache
          // -----------------------------------------------------------------
          if (activeSources.includes("analytics")) {
            const relevantKeys = ANALYTICS_CACHE_KEYS.filter((key) => {
              const keyLower = key.toLowerCase()
              const qLower = args.query.toLowerCase()
              return (
                keyLower.includes(qLower) ||
                qLower.split(/\s+/).some(
                  (word) =>
                    word.length > 1 && keyLower.includes(word),
                )
              )
            })

            // Если запрос явно не матчит известные ключи — проверяем все
            const keysToCheck =
              relevantKeys.length > 0
                ? relevantKeys
                : ANALYTICS_CACHE_KEYS

            for (const cacheKey of keysToCheck.slice(0, 3)) {
              const cached = storage.getCached(cacheKey)
              if (cached) {
                results.push({
                  type: "analytics",
                  cache_key: cacheKey,
                  data: cached,
                  relevance: scoreRelevance(args.query, cacheKey),
                })
              }
            }
          }

          // -----------------------------------------------------------------
          // Сортировка и лимитирование результатов
          // -----------------------------------------------------------------
          results.sort((a, b) => {
            const ra =
              typeof a.relevance === "number" ? a.relevance : 0
            const rb =
              typeof b.relevance === "number" ? b.relevance : 0
            return rb - ra
          })

          const limitedResults = results.slice(0, limit)

          memoryLog.info(
            `Поиск: query="${args.query}", sources=[${activeSources.join(", ")}], найдено=${limitedResults.length}`,
          )

          if (limitedResults.length === 0) {
            return {
              output: JSON.stringify(
                {
                  query: args.query,
                  results: [],
                  total: 0,
                  searched_sources: activeSources,
                  suggestion:
                    "Ничего не найдено. Попробуй: другой запрос, поиск по имени файла, ключевому слову из кодовой базы, или проверь что Observer записал данные за время работы.",
                },
                null,
                2,
              ),
            }
          }

          return {
            output: JSON.stringify(
              {
                query: args.query,
                results: limitedResults,
                total: limitedResults.length,
                searched_sources: activeSources,
              },
              null,
              2,
            ),
          }
        } catch (err) {
          memoryLog.error(
            `Ошибка code_shadow_memory_search: ${String(err)}`,
          )
          return {
            output: JSON.stringify(
              {
                query: args.query,
                results: [],
                total: 0,
                searched_sources: activeSources,
                error: String(err),
              },
              null,
              2,
            ),
          }
        }
      },
    }),

    // =========================================================================
    // Tool 3: code_shadow_memory_note
    // =========================================================================

    code_shadow_memory_note: tool({
      description:
        "Создаёт заметку-напоминание. ИСПОЛЬЗУЙ В КОНЦЕ СЕССИИ для follow-up'ов и отложенных задач.",

      args: {
        content: tool.schema.string(),
        surface_condition: tool.schema.string().optional(),
      },

      async execute(args, context) {
        try {
          const sanitized = sanitizeContent(
            args.content,
            config.secretPatterns,
          )
          const name = sanitized.slice(0, 60).trim()

          const metadata: Record<string, unknown> = {
            content: sanitized,
            surface_condition: args.surface_condition ?? null,
            status: "active",
            session_id: context.sessionID,
          }

          const id = storage.upsertNode({
            nodeType: NodeType.Note,
            name: name || "note",
            path: null,
            metadata: metadata as unknown as KnowledgeNodeMetadata,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })

          memoryLog.info(
            `Заметка создана: id=${id}, name="${name}", surface_condition=${args.surface_condition ?? "нет"}`,
          )

          return {
            output: JSON.stringify(
              {
                id,
                message: "Заметка создана",
                surface_condition: args.surface_condition ?? null,
              },
              null,
              2,
            ),
          }
        } catch (err) {
          memoryLog.error(
            `Ошибка code_shadow_memory_note: ${String(err)}`,
          )
          return {
            output: `❌ Ошибка создания заметки: ${String(err)}`,
          }
        }
      },
    }),
  }
}
