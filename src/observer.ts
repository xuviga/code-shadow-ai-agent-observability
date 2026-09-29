// =============================================================================
// Code Shadow — Observer Engine (Фаза 1.2)
// Подписывается на все события OpenCode и сохраняет их в SQLite.
// Каждый обработчик обёрнут в try/catch — плагин НИКОГДА не роняет OpenCode.
// =============================================================================
// Фаза 2: Auto-Memory — автоматическое обнаружение фактов о проекте без
// ручного вызова code_shadow_memory_write.
// =============================================================================

import type { ShadowConfig } from "./types"
import { NodeType } from "./types"
import { sanitizeContent } from "./config"
import type { createLogger } from "./logger"
import * as path from "node:path"

// ---------------------------------------------------------------------------
// Минимальный интерфейс StorageEngine — только те методы, которые реально
// использует observer. Соответствует реальному StorageEngine из storage.ts.
// Никаких вымышленных insert/update/findOne/increment!
// ---------------------------------------------------------------------------

interface StorageEngineLike {
  // Sessions
  insertSession(session: any): void
  updateSessionStatus(id: string, status: string, extra?: any): void
  getSession(id: string): any | undefined

  // Errors
  insertError(error: any): number
  recordError(error: {
    sessionId?: string | null
    errorType: string
    errorMessage: string
    contextFile?: string | null
    location?: string
    metadata?: string
  }): number

  // Batch
  enqueue(table: string, row: Record<string, unknown>): void

  // Raw DB access
  getDb(): any

  // Knowledge graph — auto-memory
  upsertNode(node: {
    nodeType: string
    name: string
    path: string | null
    metadata: Record<string, unknown> | null
    updatedAt: number
    createdAt?: number
  }): number

  // Agent-native operating layer
  createTask(input: any): any
  addTaskStep(input: any): any
  updateTask(id: string, patch: any): any
  listTasks(projectRoot: string, status?: string, limit?: number): any[]
  recordEvidence(input: any): any
}

// ---------------------------------------------------------------------------
// Интерфейс возвращаемых хуков
// ---------------------------------------------------------------------------

interface ObserverHooks {
  event: (input: { event: { type: string; properties: Record<string, unknown> } }) => Promise<void>
  "chat.message": (input: { sessionID: string; messageID?: string }, output: { parts: Array<Record<string, unknown>> }) => Promise<void>
  "permission.ask": (input: { id: string; type: string; pattern?: string | string[]; sessionID: string; messageID: string; callID?: string; title: string; metadata: Record<string, unknown> }, output: { status: "ask" | "deny" | "allow" }) => Promise<void>
  "file.edited": (input: { file?: string; filePath?: string; path?: string; type?: string; editType?: string; diff?: string; content?: string; linesAdded?: number; additions?: number; linesRemoved?: number; deletions?: number; sessionID?: string; sessionId?: string; agentType?: string; agent?: string; projectRoot?: string; cwd?: string }, output: any) => Promise<void>
  "tool.execute.before": (input: { tool: string; sessionID: string; callID: string }, output: { args: Record<string, unknown> }) => Promise<void>
  "tool.execute.after": (input: { tool: string; sessionID: string; callID: string; args: Record<string, unknown> }, output: { title: string; output: string; metadata: Record<string, unknown> }) => Promise<void>
  "lsp.diagnostic": (input: { file?: string; uri?: string; sessionID?: string; sessionId?: string; diagnostics?: Array<Record<string, unknown>>; errors?: Array<Record<string, unknown>> }, output: any) => Promise<void>
  isCrushDirty: () => boolean
  clearCrushDirty: () => void
}

// ---------------------------------------------------------------------------
// Модульные переменные
// ---------------------------------------------------------------------------

/** Отслеживание времени старта инструментов: ключ = `${sessionId}:${callId}` */
const toolStartTimes = new Map<string, number>()

/** Same failing tool signature repeated in one session. */
const toolLoopMap = new Map<string, { count: number; lastStatus: string }>()

/**
 * Successful write/edit operations repeated for one file in one session.
 * A successful tool call is not proof of progress: an agent can rewrite the
 * same file forever while every individual operation technically succeeds.
 */
type SuccessfulEditLoopState = {
  count: number
  firstAt: number
  lastAt: number
  fingerprints: Set<string>
  warned: boolean
  blocked: boolean
}

const successfulEditLoopMap = new Map<string, SuccessfulEditLoopState>()
const SUCCESSFUL_EDIT_LOOP_WINDOW_MS = 10 * 60 * 1000
const SUCCESSFUL_EDIT_LOOP_WARNING_COUNT = 3
const SUCCESSFUL_EDIT_LOOP_BLOCK_COUNT = 3

class SuccessfulEditLoopGuardError extends Error {
  constructor(filePath: string, count: number) {
    super(`[Code Shadow] остановлена повторная запись ${filePath}: ${count} успешных write/edit за короткий интервал. Проверь root cause, текущий diff и следующий шаг задачи.`)
    this.name = "SuccessfulEditLoopGuardError"
  }
}

/** Dedup-кэш для авто-сохранения: ключ → timestamp последней записи */
const autoMemCache = new Map<string, number>()
const AUTO_MEM_DEDUP_MS = 5 * 60 * 1000 // 5 минут

/** Отслеживание файлов, отредактированных в каждой сессии (для авто-саммари) */
const sessionFilesMap = new Map<string, Set<string>>()

/** ID текущей активной сессии — обновляется из session.created / tool.execute */
let currentSessionId = ""

/** Флаг для немедленного обновления CRUSH.md при изменении данных */
let crushDirty = false

/** Маппинг категорий на nodeType */
const CATEGORY_TO_NODE_TYPE: Record<string, string> = {
  PROJECT_RULES: NodeType.Rule,
  ARCHITECTURE: NodeType.Concept,
  CONSTRAINTS: NodeType.Rule,
  CONFIG_VALUES: NodeType.Concept,
  NAMING: NodeType.Pattern,
}

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

/**
 * DJB2-хеш: простая не-криптографическая хеш-функция для дедупликации.
 * Не требует внешних зависимостей.
 */
function hashContent(content: string): string {
  let hash = 5381
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash) + content.charCodeAt(i)
    hash = hash & hash // Конвертация в 32-битное целое
  }
  return hash.toString(16)
}

function normalizeTrackedPath(filePath: string): string {
  return path.normalize(filePath).replace(/[\\/]+/g, path.sep).toLowerCase()
}

function isMutatingFileTool(toolName: string): boolean {
  return /^(write|edit)$/i.test(toolName)
}

function getEditFingerprint(toolName: string, args: Record<string, unknown>): string | null {
  const content = toolName.toLowerCase() === "write"
    ? args.content
    : args.newString ?? args.content ?? args.diff
  return typeof content === "string" && content.length > 0 ? hashContent(content) : null
}

function successfulEditLoopKey(sessionId: string, filePath: string): string {
  return `${sessionId}:${normalizeTrackedPath(filePath)}`
}

/**
 * Определение языка программирования по расширению файла.
 * Покрывает 25+ распространённых расширений.
 */
function detectLanguage(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase()

  const languageMap: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".pyi": "python",
    ".pyx": "python",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".rb": "ruby",
    ".css": "css",
    ".scss": "scss",
    ".less": "less",
    ".html": "html",
    ".htm": "html",
    ".json": "json",
    ".jsonc": "json",
    ".md": "markdown",
    ".mdx": "markdown",
    ".sql": "sql",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".xml": "xml",
    ".svg": "svg",
    ".toml": "toml",
    ".ini": "ini",
    ".cfg": "ini",
    ".sh": "shell",
    ".bash": "shell",
    ".zsh": "shell",
    ".ps1": "powershell",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cxx": "cpp",
    ".cc": "cpp",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".swift": "swift",
    ".dart": "dart",
    ".lua": "lua",
    ".r": "r",
    ".php": "php",
    ".graphql": "graphql",
    ".gql": "graphql",
    ".proto": "protobuf",
    ".vue": "vue",
    ".svelte": "svelte",
    ".prisma": "prisma",
  }

  if (languageMap[ext]) {
    return languageMap[ext]
  }

  // Если расширение есть, но не в мапе — возвращаем его без точки
  if (ext.length > 1) {
    return ext.slice(1)
  }

  return "unknown"
}

const VALID_AGENT_TYPES = new Set(["build", "plan", "general", "explore"])
const VALID_EDIT_TYPES = new Set(["create", "update", "delete"])

function normalizeAgentType(value: unknown): string {
  const candidate = typeof value === "string" ? value.toLowerCase() : ""
  return VALID_AGENT_TYPES.has(candidate) ? candidate : "general"
}

function normalizeEditType(value: unknown): string {
  const candidate = typeof value === "string" ? value.toLowerCase() : ""
  return VALID_EDIT_TYPES.has(candidate) ? candidate : "update"
}

// ---------------------------------------------------------------------------
// Auto-Memory: дедупликация и сохранение
// ---------------------------------------------------------------------------

function shouldAutoSave(key: string): boolean {
  const last = autoMemCache.get(key)
  if (last && Date.now() - last < AUTO_MEM_DEDUP_MS) return false
  autoMemCache.set(key, Date.now())
  return true
}

async function autoSaveFact(
  storage: StorageEngineLike,
  category: string,
  content: string,
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  const key = `${category}:${content.substring(0, 50)}`
  if (!shouldAutoSave(key)) return

  try {
    const nodeType = CATEGORY_TO_NODE_TYPE[category] || NodeType.Pattern
    storage.upsertNode({
      nodeType,
      name: content.substring(0, 60),
      path: null,
      metadata: {
        category,
        content,
        full_content: content,
        auto_detected: true,
      },
      updatedAt: Date.now(),
    })
    log.debug(`Авто-сохранение: [${category}] ${content.substring(0, 40)}...`)
  } catch (_err) {
    // Silently fail — never crash the observer
  }
}

// ---------------------------------------------------------------------------
// Auto-Memory: обнаружение фактов о проекте по пути файла
// ---------------------------------------------------------------------------

async function autoDetectFromFile(
  storage: StorageEngineLike,
  filePath: string,
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  try {
    // Не обрабатываем файлы из системных директорий
    if (filePath.match(/node_modules|\.git|dist|build|\.next|\.cache|__pycache__|vendor|\.venv|venv/)) return

    // --- Конфигурационные файлы ---

    // package.json
    if (filePath.endsWith("package.json") || filePath.endsWith("package.jsonc")) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Node.js / npm", log)
    }

    // tsconfig.json
    if (filePath.endsWith("tsconfig.json")) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует TypeScript (tsconfig.json)", log)
    }

    // AGENTS.md / CONTEXT.md / README.md / CLAUDE.md
    if (filePath.endsWith("AGENTS.md") || filePath.endsWith("CONTEXT.md") || filePath.endsWith("CLAUDE.md")) {
      await autoSaveFact(storage, "PROJECT_RULES", `Проект имеет файл конвенций: ${filePath.split("/").pop() || filePath}`, log)
    }

    // --- Языки и фреймворки по расширениям ---

    if (filePath.match(/\.tsx?$/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует TypeScript", log)
    }
    if (filePath.match(/\.vue$/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Vue", log)
    }
    if (filePath.match(/\.svelte$/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Svelte", log)
    }
    if (filePath.match(/\.jsx$/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует React (JSX)", log)
    }
    if (filePath.match(/\.py$/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Python", log)
    }
    if (filePath.match(/\.rs$/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Rust", log)
    }
    if (filePath.match(/\.go$/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Go", log)
    }
    if (filePath.match(/\.java$/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Java", log)
    }
    if (filePath.match(/\.cs$/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует C#", log)
    }
    if (filePath.match(/\.swift$/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Swift", log)
    }
    if (filePath.match(/\.dart$/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Dart", log)
    }

    // --- CSS-фреймворки и инструменты ---

    if (filePath.match(/tailwind\.config/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Tailwind CSS", log)
    }
    if (filePath.match(/postcss\.config/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует PostCSS", log)
    }
    if (filePath.match(/\.scss$/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует SCSS/Sass", log)
    }

    // --- Инфраструктура ---

    if (filePath.match(/Dockerfile/)) {
      await autoSaveFact(storage, "ARCHITECTURE", "Проект использует Docker", log)
    }
    if (filePath.match(/docker-compose/)) {
      await autoSaveFact(storage, "ARCHITECTURE", "Проект использует Docker Compose", log)
    }
    if (filePath.match(/\.github\/workflows/)) {
      await autoSaveFact(storage, "ARCHITECTURE", "Проект использует GitHub Actions для CI/CD", log)
    }
    if (filePath.match(/\.gitlab-ci\.yml/)) {
      await autoSaveFact(storage, "ARCHITECTURE", "Проект использует GitLab CI/CD", log)
    }
    if (filePath.match(/Jenkinsfile/)) {
      await autoSaveFact(storage, "ARCHITECTURE", "Проект использует Jenkins", log)
    }
    if (filePath.match(/\.circleci\//)) {
      await autoSaveFact(storage, "ARCHITECTURE", "Проект использует CircleCI", log)
    }

    // --- Базы данных и ORM ---

    if (filePath.match(/prisma/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Prisma ORM", log)
    }
    if (filePath.match(/drizzle/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Drizzle ORM", log)
    }
    if (filePath.match(/knex/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Knex.js", log)
    }
    if (filePath.match(/typeorm/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует TypeORM", log)
    }
    if (filePath.match(/mongoose/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Mongoose (MongoDB)", log)
    }

    // --- Структура проекта ---

    if (filePath.match(/^src\/components\//)) {
      await autoSaveFact(storage, "ARCHITECTURE", "Компоненты находятся в src/components/", log)
    }
    if (filePath.match(/^src\/utils\//)) {
      await autoSaveFact(storage, "ARCHITECTURE", "Утилиты находятся в src/utils/", log)
    }
    if (filePath.match(/^src\/hooks\//)) {
      await autoSaveFact(storage, "ARCHITECTURE", "React-хуки находятся в src/hooks/", log)
    }
    if (filePath.match(/^src\/pages\//)) {
      await autoSaveFact(storage, "ARCHITECTURE", "Страницы находятся в src/pages/", log)
    }
    if (filePath.match(/^src\/lib\//)) {
      await autoSaveFact(storage, "ARCHITECTURE", "Библиотечный код находится в src/lib/", log)
    }
    if (filePath.match(/^src\/services\//)) {
      await autoSaveFact(storage, "ARCHITECTURE", "Сервисы находятся в src/services/", log)
    }
    if (filePath.match(/^src\/app\//)) {
      await autoSaveFact(storage, "ARCHITECTURE", "Next.js App Router используется (src/app/)", log)
    }

    // --- Конвенции тестирования ---

    if (filePath.match(/^tests?\//) || filePath.match(/\.test\./)) {
      await autoSaveFact(storage, "NAMING", "Тесты используют .test. в имени файла", log)
    }
    if (filePath.match(/\.spec\./)) {
      await autoSaveFact(storage, "NAMING", "Тесты используют .spec. в имени файла", log)
    }
    if (filePath.match(/__tests__\//)) {
      await autoSaveFact(storage, "NAMING", "Тесты находятся в директориях __tests__/", log)
    }
    if (filePath.match(/vitest\.config/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Vitest для тестирования", log)
    }
    if (filePath.match(/jest\.config/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Jest для тестирования", log)
    }
    if (filePath.match(/playwright\.config/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Playwright для e2e-тестов", log)
    }
    if (filePath.match(/cypress\.config/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Cypress для e2e-тестов", log)
    }

    // --- Сборщики и бандлеры ---

    if (filePath.match(/webpack\.config/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Webpack", log)
    }
    if (filePath.match(/vite\.config/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Vite", log)
    }
    if (filePath.match(/esbuild\.config/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует esbuild", log)
    }
    if (filePath.match(/rollup\.config/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Rollup", log)
    }

    // --- Линтеры и форматтеры ---

    if (filePath.match(/eslint\.config|\.eslintrc/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует ESLint", log)
    }
    if (filePath.match(/prettier\.config|\.prettierrc/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Prettier", log)
    }
    if (filePath.match(/biome\.json/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Biome", log)
    }

    // --- Пакетные менеджеры ---

    if (filePath.endsWith("pnpm-lock.yaml") || filePath.match(/pnpm-workspace\.yaml/) || filePath.match(/\.npmrc/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует pnpm", log)
    }
    if (filePath.endsWith("yarn.lock")) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Yarn", log)
    }
    if (filePath.endsWith("bun.lockb") || filePath.endsWith("bun.lock")) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Bun", log)
    }

    // --- Фреймворки по конфигурационным файлам ---

    if (filePath.match(/next\.config/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Next.js", log)
    }
    if (filePath.match(/nuxt\.config/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Nuxt", log)
    }
    if (filePath.match(/svelte\.config/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует SvelteKit", log)
    }
    if (filePath.match(/remix\.config/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Remix", log)
    }
    if (filePath.match(/astro\.config/)) {
      await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Astro", log)
    }

    // --- CI/CD и окружение ---

    if (filePath.match(/\.env\.example/) || filePath.match(/\.env\.template/)) {
      await autoSaveFact(storage, "ARCHITECTURE", "Проект имеет шаблон переменных окружения", log)
    }
    if (filePath.match(/Makefile/)) {
      await autoSaveFact(storage, "ARCHITECTURE", "Проект использует Makefile для автоматизации", log)
    }
    crushDirty = true
  } catch (_err) {
    // Silently fail — never crash the observer
  }
}

// ---------------------------------------------------------------------------
// Auto-Memory: обнаружение фактов из результатов инструментов
// ---------------------------------------------------------------------------

async function autoDetectFromToolResult(
  toolName: string,
  args: Record<string, unknown>,
  outputText: string,
  storage: StorageEngineLike,
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  try {
    // Read tool: проверяем, какой файл читали
    if (toolName === "read" || toolName === "Read") {
      const filePath = (args.filePath as string) || (args.file as string) || (args.path as string) || ""
      if (filePath &&
        (filePath.endsWith(".json") || filePath.endsWith(".yaml") || filePath.endsWith(".yml") ||
         filePath.endsWith("AGENTS.md") || filePath.endsWith("CONTEXT.md") || filePath.endsWith("CLAUDE.md"))) {
        await autoDetectFromFile(storage, filePath, log)

        // Попытка парсинга package.json из результата чтения
        if ((filePath.endsWith("package.json") || filePath.endsWith("package.jsonc")) && outputText) {
          try {
            const pkg = JSON.parse(outputText) as Record<string, unknown>
            if (pkg.name) {
              await autoSaveFact(storage, "CONFIG_VALUES", `Название проекта: ${pkg.name}`, log)
            }
            if (pkg.dependencies) {
              const depCount = Object.keys(pkg.dependencies as object).length
              await autoSaveFact(storage, "CONFIG_VALUES", `Зависимостей проекта: ${depCount}`, log)
            }
            if (pkg.scripts) {
              const scriptNames = Object.keys(pkg.scripts as object)
              if (scriptNames.includes("build")) await autoSaveFact(storage, "CONFIG_VALUES", `Скрипт сборки: npm run build`, log)
              if (scriptNames.includes("test")) await autoSaveFact(storage, "CONFIG_VALUES", `Скрипт тестов: npm test`, log)
              if (scriptNames.includes("lint")) await autoSaveFact(storage, "CONFIG_VALUES", `Скрипт линтинга: npm run lint`, log)
              if (scriptNames.includes("dev")) await autoSaveFact(storage, "CONFIG_VALUES", `Скрипт разработки: npm run dev`, log)
            }
          } catch (_parseErr) {
            // Invalid JSON — ignore
          }
        }

        // Попытка парсинга tsconfig.json
        if (filePath.endsWith("tsconfig.json") && outputText) {
          try {
            // tsconfig может содержать комментарии (jsonc), пробуем распарсить
            const cleaned = outputText.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
            const tsconfig = JSON.parse(cleaned) as Record<string, unknown>
            const compilerOptions = (tsconfig.compilerOptions || {}) as Record<string, unknown>
            if (compilerOptions.target) await autoSaveFact(storage, "CONFIG_VALUES", `TypeScript target: ${compilerOptions.target}`, log)
            if (compilerOptions.module) await autoSaveFact(storage, "CONFIG_VALUES", `TypeScript module: ${compilerOptions.module}`, log)
            if (compilerOptions.strict === true) await autoSaveFact(storage, "CONFIG_VALUES", "TypeScript strict mode включён", log)
            if (compilerOptions.jsx) await autoSaveFact(storage, "CONFIG_VALUES", `TypeScript JSX: ${compilerOptions.jsx}`, log)
          } catch (_parseErr) {
            // Invalid JSON — ignore
          }
        }
      }
    }

    // Glob tool: анализируем паттерн
    if (toolName === "glob" || toolName === "Glob") {
      const pattern = (args.pattern as string) || ""

      if (pattern.includes("src/components") || pattern.includes("components/**/*.tsx")) {
        await autoSaveFact(storage, "ARCHITECTURE", "Компоненты находятся в src/components/", log)
      }
      if (pattern.includes("src/utils") || pattern.includes("utils/**")) {
        await autoSaveFact(storage, "ARCHITECTURE", "Утилиты находятся в src/utils/", log)
      }
      if (pattern.includes("src/hooks") || pattern.includes("hooks/**")) {
        await autoSaveFact(storage, "ARCHITECTURE", "Хуки находятся в src/hooks/", log)
      }
      if (pattern.includes("src/pages") || pattern.includes("pages/**")) {
        await autoSaveFact(storage, "ARCHITECTURE", "Страницы находятся в src/pages/", log)
      }
      if (pattern.includes("src/app") || pattern.includes("app/**")) {
        await autoSaveFact(storage, "ARCHITECTURE", "Next.js App Router: src/app/", log)
      }
      if (pattern.includes("tests") || pattern.includes("__tests__") || pattern.includes(".test.") || pattern.includes(".spec.")) {
        await autoSaveFact(storage, "NAMING", "Тесты обнаружены через glob-поиск", log)
      }
      if (pattern.includes("*.tsx") || pattern.includes("*.ts")) {
        await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует TypeScript (обнаружено через glob)", log)
      }
      if (pattern.includes("*.vue")) {
        await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Vue (обнаружено через glob)", log)
      }
      if (pattern.includes("*.svelte")) {
        await autoSaveFact(storage, "CONFIG_VALUES", "Проект использует Svelte (обнаружено через glob)", log)
      }
    }
  } catch (_err) {
    // Silently fail — never crash the observer
  }
}

// ---------------------------------------------------------------------------
// Создание Observer Engine
// ---------------------------------------------------------------------------

export function createObserver(
  storage: StorageEngineLike,
  config: ShadowConfig,
  log: ReturnType<typeof createLogger>,
  client?: any,
): ObserverHooks {

  // =========================================================================
  // Обработчик события: диспетчер на основе event.type
  // =========================================================================

  async function event(input: { event: { type: string; properties: Record<string, unknown> } }): Promise<void> {
    const evt = input.event

    try {
      switch (evt.type) {
        case "file.edited":
          await handleFileEdited(evt.properties)
          break
        case "session.created":
          await handleSessionCreated(evt.properties)
          break
        case "session.idle":
          await handleSessionIdle(evt.properties)
          break
        case "session.error":
          await handleSessionError(evt.properties)
          break
        case "session.compacted":
          await handleSessionCompacted(evt.properties)
          break
        case "command.executed":
          await handleCommandExecuted(evt.properties)
          break
        case "message.updated":
          await handleMessageUpdated(evt.properties)
          break
        case "todo.updated":
          await handleTodoUpdated(evt.properties)
          break
        case "lsp.client.diagnostics":
          await handleLspClientDiagnostics(evt.properties)
          break
        case "lsp.diagnostic":
          await handleLspDiagnostic(evt.properties)
          break
        default:
          // Неизвестный тип события — безопасно игнорируем
          break
      }
    } catch (err) {
      log.error("Критическая ошибка в event dispatcher", err)
    }
  }

  // =========================================================================
  // chat.message — automatic Task Graph bootstrap from a user request
  // =========================================================================

  function inferTaskPlan(text: string): string[] {
    const steps = ["Изучить релевантный код и контекст проекта"]
    if (/(fix|bug|debug|исправ|ошиб|баг)/i.test(text)) steps.push("Воспроизвести проблему и найти root cause")
    if (/(api|auth|database|db|schema|архитект|интеграц|endpoint|авторизац|баз[аы] данн)/i.test(text)) steps.push("Проверить затронутые границы, зависимости и исторический риск")
    steps.push("Реализовать изменение в пределах Change Contract")
    if (/(test|тест|провер|regression|регрес)/i.test(text)) steps.push("Добавить или обновить regression tests")
    steps.push("Запустить verification-команды и записать verified evidence")
    return Array.from(new Set(steps))
  }

  async function handleChatMessage(
    input: { sessionID: string; messageID?: string },
    output: { parts: Array<Record<string, unknown>> },
  ): Promise<void> {
    try {
      const session = storage.getSession(input.sessionID)
      if (!session) return
      const text = (output.parts || [])
        .filter((part) => part.type === "text" || typeof part.text === "string")
        .map((part) => String(part.text || part.content || ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
      if (text.length < 18 || /^(hi|hello|привет|ок|спасибо|thanks)[!. ]*$/i.test(text)) return
      const actionable = /\b(fix|implement|add|remove|update|refactor|create|build|write|test|debug|check|исправ|реализ|добав|удал|обнов|рефактор|созд|собер|напиш|проверь|сделай)\w*/i.test(text)
      if (!actionable && text.length < 80) return

      const existing = storage.listTasks(session.projectRoot, "active", 10)
        .find((task) => task.sessionId === input.sessionID)
      if (existing) return

      const title = (text.split(/[.!?\n]/)[0] || text).slice(0, 120).trim()
      const task = storage.createTask({
        projectRoot: session.projectRoot,
        sessionId: input.sessionID,
        title: title || "User request",
        goal: text.slice(0, 2000),
        status: "active",
        priority: 50,
        metadata: { source: "chat.message", message_id: input.messageID || null, auto_created: true },
      })
      for (const [position, stepTitle] of inferTaskPlan(text).entries()) {
        storage.addTaskStep({
          taskId: task.id,
          title: stepTitle,
          status: position === 0 ? "in_progress" : "pending",
          position,
          blockedBy: null,
          metadata: { auto_created: true, plan_source: "heuristic" },
        })
      }
      log.info(`Auto-Task создана из user message: ${task.id} — ${title}`)
    } catch (err) {
      log.debug(`Auto-Task из chat.message пропущена: ${String(err)}`)
    }
  }

  // =========================================================================
  // permission.ask — hard gate для Change Contract
  // =========================================================================

  async function handlePermissionAsk(
    input: { id: string; type: string; pattern?: string | string[]; sessionID: string; messageID: string; callID?: string; title: string; metadata: Record<string, unknown> },
    output: { status: "ask" | "deny" | "allow" },
  ): Promise<void> {
    try {
      if (!/^(edit|write)$/i.test(input.type)) return
      const session = storage.getSession(input.sessionID)
      if (!session) return
      const targets = Array.isArray(input.pattern) ? input.pattern : input.pattern ? [input.pattern] : []
      if (targets.length === 0) return

      for (const target of targets) {
        const loopState = getRecentSuccessfulEditState(input.sessionID, target)
        if (loopState && loopState.count >= SUCCESSFUL_EDIT_LOOP_BLOCK_COUNT) {
          rejectSuccessfulEditLoop(input.sessionID, target, input.type, loopState)
          output.status = "deny"
          return
        }
      }

      const contracts = storage.getDb().prepare(`SELECT id, allowed_paths, forbidden_paths FROM change_contracts WHERE project_root = ?1 AND status = 'active'`).all(session.projectRoot) as Array<{ id: string; allowed_paths: string; forbidden_paths: string }>
      const matches = (pattern: string, value: string) => pattern === "*" || value === pattern || value.startsWith(pattern.replace(/[*]$/, ""))
      for (const contract of contracts) {
        const allowed = JSON.parse(contract.allowed_paths || "[]") as string[]
        const forbidden = JSON.parse(contract.forbidden_paths || "[]") as string[]
        const violations = targets.filter((target) => forbidden.some((pattern) => matches(pattern, target)) || (allowed.length > 0 && !allowed.some((pattern) => matches(pattern, target))))
        if (violations.length > 0) {
          output.status = "deny"
          storage.enqueue("developer_events", {
            event_type: "tool_rejected",
            session_id: input.sessionID,
            file_path: violations[0],
            metadata: JSON.stringify({ reason: "change_contract_permission_denied", permission_id: input.id, contract_id: contract.id, tool: input.type, violations }),
            timestamp: Date.now(),
          })
          log.warn(`Change Contract hard-gate: permission denied for ${violations.join(", ")}, contract=${contract.id}`)
          return
        }
      }
    } catch (err) {
      // Fail open only when the permission payload cannot be inspected; the
      // existing preflight and post-edit gates still provide observability.
      log.debug(`Permission Change Contract gate пропущен: ${String(err)}`)
    }
  }

  // =========================================================================
  // 1. file.edited — каждое изменение файла
  // =========================================================================

  function extractCommand(args: Record<string, unknown>, title: string): string {
    for (const key of ["command", "cmd", "script", "input"]) {
      if (typeof args[key] === "string" && String(args[key]).trim()) return String(args[key]).trim()
    }
    return title.trim()
  }

  function isVerificationCommand(command: string): boolean {
    return /\b(test|typecheck|build|lint|check|verify|compile|tsc|eslint|vitest|jest)\b/i.test(command)
  }

  function captureCommandEvidence(
    toolName: string,
    sessionId: string,
    args: Record<string, unknown>,
    title: string,
    resultOutput: string,
    status: string,
  ): void {
    try {
      const session = storage.getSession(sessionId)
      if (!session) return
      const command = extractCommand(args, title)
      if (!isVerificationCommand(command)) return
      const activeTask = storage.listTasks(session.projectRoot, "active", 1)[0]
      const successful = status === "success"
      storage.recordEvidence({
        projectRoot: session.projectRoot,
        taskId: activeTask?.id || null,
        sessionId,
        claim: `${command.slice(0, 180)} ${successful ? "завершилась успешно" : "завершилась ошибкой"}`,
        evidenceType: "command",
        source: `${toolName}: ${command.slice(0, 220)}`,
        status: successful ? "verified" : "failed",
        confidence: successful ? 1 : 0.95,
        details: sanitizeContent(resultOutput.slice(-1500), config.secretPatterns) || null,
      })
      log.debug(`Auto-Evidence: ${command.slice(0, 100)} → ${successful ? "verified" : "failed"}`)
    } catch (err) {
      log.debug(`Auto-Evidence пропущен: ${String(err)}`)
    }
  }

  function inspectToolLoop(toolName: string, sessionId: string, argsPreview: string | null, status: string): void {
    const key = `${sessionId}:${toolName}:${argsPreview || ""}`
    if (status === "success") {
      toolLoopMap.delete(key)
      return
    }
    const previous = toolLoopMap.get(key) || { count: 0, lastStatus: status }
    previous.count += 1
    previous.lastStatus = status
    toolLoopMap.set(key, previous)
    if (previous.count === 3) {
      const session = storage.getSession(sessionId)
      if (!session) return
      const activeTask = storage.listTasks(session.projectRoot, "active", 1)[0]
      storage.getDb().prepare(`INSERT INTO developer_events (event_type, session_id, file_path, metadata, timestamp) VALUES (?1,?2,NULL,?3,?4)`).run(
        "tool_rejected", sessionId, JSON.stringify({ reason: "agent_loop_detected", tool: toolName, signature: argsPreview, repeats: previous.count }), Date.now(),
      )
      log.warn(`Agent loop detected: ${toolName} повторён 3 раза с ошибкой; task=${activeTask?.id || "none"}`)
    }
  }

  function getRecentSuccessfulEditState(sessionId: string, filePath: string, now = Date.now()): SuccessfulEditLoopState | undefined {
    const key = successfulEditLoopKey(sessionId, filePath)
    const state = successfulEditLoopMap.get(key)
    if (!state) return undefined
    if (now - state.lastAt > SUCCESSFUL_EDIT_LOOP_WINDOW_MS) {
      successfulEditLoopMap.delete(key)
      return undefined
    }
    return state
  }

  function recordSuccessfulEdit(
    toolName: string,
    sessionId: string,
    filePath: string,
    args: Record<string, unknown>,
  ): SuccessfulEditLoopState {
    const now = Date.now()
    const key = successfulEditLoopKey(sessionId, filePath)
    let state = getRecentSuccessfulEditState(sessionId, filePath, now)
    if (!state) {
      state = { count: 0, firstAt: now, lastAt: now, fingerprints: new Set<string>(), warned: false, blocked: false }
      successfulEditLoopMap.set(key, state)
    }

    state.count += 1
    state.lastAt = now
    const fingerprint = getEditFingerprint(toolName, args)
    if (fingerprint) state.fingerprints.add(fingerprint)

    if (state.count === SUCCESSFUL_EDIT_LOOP_WARNING_COUNT && !state.warned) {
      state.warned = true
      storage.enqueue("developer_events", {
        event_type: "tool_rejected",
        session_id: sessionId,
        file_path: filePath,
        metadata: JSON.stringify({
          reason: "successful_edit_loop_warning",
          tool: toolName,
          file: filePath,
          repeats: state.count,
          unique_contents: state.fingerprints.size,
          window_ms: SUCCESSFUL_EDIT_LOOP_WINDOW_MS,
        }),
        timestamp: now,
      })
      log.warn(`Successful edit loop warning: ${filePath} переписан ${state.count} раз за ${Math.round((now - state.firstAt) / 1000)}с`)
    }

    return state
  }

  function rejectSuccessfulEditLoop(
    sessionId: string,
    filePath: string,
    toolName: string,
    state: SuccessfulEditLoopState,
  ): void {
    if (state.blocked) return
    state.blocked = true
    storage.enqueue("developer_events", {
      event_type: "tool_rejected",
      session_id: sessionId,
      file_path: filePath,
      metadata: JSON.stringify({
        reason: "successful_edit_loop_blocked",
        tool: toolName,
        file: filePath,
        repeats: state.count,
        unique_contents: state.fingerprints.size,
        window_ms: SUCCESSFUL_EDIT_LOOP_WINDOW_MS,
      }),
      timestamp: Date.now(),
    })
    log.warn(`Successful edit loop blocked: ${toolName} → ${filePath}, repeats=${state.count}`)
  }

  function assertEditLoopAllowed(
    sessionId: string,
    toolName: string,
    filePath: string,
  ): void {
    if (!isMutatingFileTool(toolName)) return
    const state = getRecentSuccessfulEditState(sessionId, filePath)
    if (!state || state.count < SUCCESSFUL_EDIT_LOOP_BLOCK_COUNT) return
    rejectSuccessfulEditLoop(sessionId, filePath, toolName, state)
    throw new SuccessfulEditLoopGuardError(filePath, state.count)
  }

  async function handleFileEdited(properties: Record<string, unknown>): Promise<void> {
    try {
      const filePath = (properties.file as string) || (properties.filePath as string) || (properties.path as string) || "unknown"
      const sessionId = (properties.sessionID as string) || currentSessionId || "unknown"
      const agentType = normalizeAgentType(properties.agentType || properties.agent)
      const editType = normalizeEditType(properties.editType || properties.type)
      const diffPreview = (properties.diff as string) || null
      const linesAdded = (properties.additions as number) || (properties.linesAdded as number) || 0
      const linesRemoved = (properties.deletions as number) || (properties.linesRemoved as number) || 0
      const timestamp = (properties.timestamp as number) || Date.now()

      let projectRoot = (properties.projectRoot as string) || (properties.directory as string) || ""
      if (!projectRoot && sessionId !== "unknown") {
        try {
          const session = storage.getSession(sessionId)
          if (session?.projectRoot) {
            projectRoot = session.projectRoot as string
          }
        } catch { /* ок */ }
      }

      // Обрезаем дифф до config.maxDiffPreviewChars
      let truncatedDiff: string | null = null
      if (diffPreview) {
        truncatedDiff = diffPreview.length > config.maxDiffPreviewChars
          ? diffPreview.substring(0, config.maxDiffPreviewChars)
          : diffPreview
      }

      // Хеш диффа для дедупликации
      const diffHash = truncatedDiff ? hashContent(truncatedDiff) : null

      // Фильтрация секретов
      const safeDiff = truncatedDiff
        ? sanitizeContent(truncatedDiff, config.secretPatterns)
        : null

      // Определение языка
      const language = detectLanguage(filePath)

      // Пакетная запись в file_edits
      storage.enqueue("file_edits", {
        file_path: filePath,
        session_id: sessionId,
        agent_type: agentType,
        edit_type: editType,
        diff_preview: safeDiff,
        lines_added: linesAdded,
        lines_removed: linesRemoved,
        timestamp,
        project_root: projectRoot,
        was_reverted: 0,
        file_language: language,
        diff_hash: diffHash,
      })

      // Proactive Change Contract gate: even if the agent forgets to call
      // code_shadow_change_contract action="check", a file.edited event can
      // mark an active contract as violated immediately.
      if (projectRoot) {
        try {
          const activeContracts = storage.getDb().prepare(
            `SELECT id, allowed_paths, forbidden_paths, violations FROM change_contracts
             WHERE project_root = ?1 AND status = 'active'`,
          ).all(projectRoot) as Array<{ id: string; allowed_paths: string; forbidden_paths: string; violations: string }>
          const matches = (pattern: string, value: string) => pattern === "*" || value === pattern || value.startsWith(pattern.replace(/[*]$/, ""))
          for (const contract of activeContracts) {
            const allowed = JSON.parse(contract.allowed_paths || "[]") as string[]
            const forbidden = JSON.parse(contract.forbidden_paths || "[]") as string[]
            const forbiddenHit = forbidden.some((pattern) => matches(pattern, filePath))
            const outsideAllowed = allowed.length > 0 && !allowed.some((pattern) => matches(pattern, filePath))
            if (forbiddenHit || outsideAllowed) {
              const previous = JSON.parse(contract.violations || "[]") as string[]
              const violations = Array.from(new Set([...previous, filePath]))
              storage.getDb().prepare(
                `UPDATE change_contracts SET status = 'violated', violations = ?1, updated_at = ?2 WHERE id = ?3`,
              ).run(JSON.stringify(violations), Date.now(), contract.id)
              log.warn(`Change Contract нарушен: contract=${contract.id}, file=${filePath}`)
            }
          }
        } catch (contractError) {
          log.debug(`Change Contract gate пропущен: ${String(contractError)}`)
        }
      }

      // Auto-Memory: отслеживание файлов сессии для авто-саммари
      if (!sessionFilesMap.has(sessionId)) {
        sessionFilesMap.set(sessionId, new Set())
      }
      sessionFilesMap.get(sessionId)!.add(filePath)

      // Auto-Memory: обнаружение фактов о проекте
      autoDetectFromFile(storage, filePath, log)

      log.debug(`file.edited: ${filePath} (${language}, +${linesAdded}/-${linesRemoved})`)
    } catch (err) {
      log.error("Ошибка в handleFileEdited", err)
    }
  }

  // =========================================================================
  // 2. session.created — создание новой сессии
  // =========================================================================

  async function handleSessionCreated(properties: Record<string, unknown>): Promise<void> {
    try {
      const info = properties.info as Record<string, unknown> | undefined
      if (!info) {
        log.warn("session.created: отсутствует info")
        return
      }

      const sessionId = (info.id as string) || "unknown"
      const agentType = normalizeAgentType(info.agent)
      const timestamp = (info.time as Record<string, unknown>)?.created as number || Date.now()
      const projectRoot = (info.directory as string) || ""

      // Track current session for file.edited
      currentSessionId = sessionId
      crushDirty = true

      // Вставка сессии со статусом 'created' — используем РЕАЛЬНЫЙ метод insertSession
      storage.insertSession({
        id: sessionId,
        agentType,
        status: "created",
        startedAt: timestamp,
        endedAt: null,
        durationMs: null,
        filesChangedCount: 0,
        toolsUsedCount: 0,
        errorsCount: 0,
        projectRoot,
        messageCount: 0,
        totalTokensUsed: 0,
        compactedFrom: null,
      })

      // Вставка developer event (тип: 'session_started')
      storage.enqueue("developer_events", {
        event_type: "session_started",
        session_id: sessionId,
        file_path: null,
        metadata: JSON.stringify({
          project_root: projectRoot,
          agent_type: agentType,
          trigger: "user_command",
        }),
        timestamp,
      })

      // Авто-инжект контекста для новой сессии
      try {
        const projectName = projectRoot.split(/[\\/]/).pop() || ""
        if (projectName) {
          const db = storage.getDb()
          const row = db.prepare(
            "SELECT COUNT(*) as cnt FROM knowledge_nodes"
          ).get() as { cnt: number } | undefined
          if (row && row.cnt > 0) {
            log.info(`Авто-контекст: проект "${projectRoot}" имеет ${row.cnt}+ фактов в памяти`)
          }
        }
      } catch { /* silently ignore */ }

      // Проактивный режим: если client доступен, логируем готовность
      if (client && projectRoot) {
        try {
          const db = storage.getDb()
          const kRow = db.prepare(
            "SELECT COUNT(*) as cnt FROM knowledge_nodes"
          ).get() as { cnt: number } | undefined
          const projectName = projectRoot.split(/[\\/]/).pop() || ""
          const factsCount = kRow?.cnt ?? 0
          log.info(`Проактивный режим: проект "${projectName}", фактов: ${factsCount}`)

          if (typeof client.tui?.toast?.show === "function") {
            client.tui.toast.show({
              variant: "info",
              title: "Code Shadow",
              message: `Контекст загружен. Используй code_shadow_analyze и code_shadow_memory_search.`,
              duration: 3000,
            })
          }
        } catch { /* client API may differ */ }
      }

      log.info(`Сессия ${sessionId} создана (agent: ${agentType}, project: ${projectRoot})`)
    } catch (err) {
      log.error("Ошибка в handleSessionCreated", err)
    }
  }

  // =========================================================================
  // 3. session.idle — завершение сессии
  // =========================================================================

  async function handleSessionIdle(properties: Record<string, unknown>): Promise<void> {
    try {
      const sessionId = (properties.sessionID as string) || ""
      if (!sessionId) {
        log.warn("session.idle: отсутствует sessionID")
        return
      }

      const endedAt = Date.now()

      // Получаем текущую запись сессии — используем РЕАЛЬНЫЙ метод getSession
      const session = storage.getSession(sessionId)
      if (!session) {
        log.warn(`session.idle: сессия ${sessionId} не найдена`)
        return
      }

      const startedAt = (session.startedAt as number) || endedAt
      const duration = endedAt - startedAt

      // Получаем сводную статистику из агрегатов БД
      const db = storage.getDb()
      const filesCount = db.prepare(
        "SELECT COUNT(DISTINCT file_path) as cnt FROM file_edits WHERE session_id = ?"
      ).get(sessionId) as { cnt: number } | undefined
      const toolsCount = db.prepare(
        "SELECT COUNT(*) as cnt FROM tool_executions WHERE session_id = ?"
      ).get(sessionId) as { cnt: number } | undefined
      const errorsCount = db.prepare(
        "SELECT COUNT(*) as cnt FROM session_errors WHERE session_id = ?"
      ).get(sessionId) as { cnt: number } | undefined

      // Обновление сессии — используем РЕАЛЬНЫЙ метод updateSessionStatus
      storage.updateSessionStatus(sessionId, "idle", {
        endedAt,
        durationMs: duration,
        filesChangedCount: filesCount?.cnt ?? 0,
        toolsUsedCount: toolsCount?.cnt ?? 0,
        errorsCount: errorsCount?.cnt ?? 0,
      })

      // Вставка developer event (тип: 'session_completed')
      storage.enqueue("developer_events", {
        event_type: "session_completed",
        session_id: sessionId,
        file_path: null,
        metadata: JSON.stringify({
          duration_ms: duration,
          files_changed: filesCount?.cnt ?? 0,
          tools_used: toolsCount?.cnt ?? 0,
          errors: errorsCount?.cnt ?? 0,
        }),
        timestamp: endedAt,
      })

      // Auto-Memory: сохраняем сводку сессии
      try {
        const sessionFiles = sessionFilesMap.get(sessionId)
        if (sessionFiles && sessionFiles.size > 0) {
          const agentType = (session.agentType as string) || "general"
          const filesArray = Array.from(sessionFiles).slice(0, 50) // не более 50 файлов

          storage.upsertNode({
            nodeType: NodeType.Concept,
            name: `Session ${sessionId.substring(0, 8)} summary`,
            path: null,
            metadata: {
              files_worked_on: filesArray,
              duration_ms: duration,
              agent_type: agentType,
              session_id: sessionId,
              auto_detected: true,
              category: "ARCHITECTURE",
              full_content: `Session ${sessionId.substring(0, 8)} worked on ${filesArray.length} files`,
            },
            updatedAt: Date.now(),
          })

          log.debug(`Авто-саммари сессии ${sessionId}: ${filesArray.length} файлов`)
        }

        // Очистка трекинга сессии
        sessionFilesMap.delete(sessionId)
      } catch (_err) {
        // Silently fail on auto-summary
      }

      crushDirty = true

      const durationSec = (duration / 1000).toFixed(1)
      log.info(`Сессия ${sessionId} завершена (длительность: ${durationSec}с, файлов: ${filesCount?.cnt ?? 0})`)
    } catch (err) {
      log.error("Ошибка в handleSessionIdle", err)
    }
  }

  // =========================================================================
  // 4. session.error — ошибка во время сессии
  // =========================================================================

  async function handleSessionError(properties: Record<string, unknown>): Promise<void> {
    try {
      const sessionId = (properties.sessionID as string) || currentSessionId || "unknown"
      const errorData = properties.error as Record<string, unknown> | undefined
      const errorMessage = errorData
        ? ((errorData.data as Record<string, unknown>)?.message as string) || (errorData.name as string) || "Неизвестная ошибка"
        : "Неизвестная ошибка"
      const stackTrace = (properties.stackTrace as string) || null
      const contextFile = (properties.contextFile as string) || (properties.file as string) || null
      const contextTool = (properties.contextTool as string) || (properties.tool as string) || null
      const timestamp = (properties.timestamp as number) || Date.now()

      // Определение типа ошибки
      let errorType = "unknown"
      if (errorData) {
        const name = errorData.name as string
        if (name === "ProviderAuthError") errorType = "model_error"
        else if (name === "PermissionError") errorType = "permission_denied"
        else if (name === "ToolError" || contextTool) errorType = "tool_error"
      }

      // Санитизация сообщения об ошибке
      const safeMessage = sanitizeContent(errorMessage, config.secretPatterns)
      const safeStack = stackTrace ? sanitizeContent(stackTrace, config.secretPatterns) : null

      // Вставка в session_errors — используем РЕАЛЬНЫЙ метод insertError
      if (storage.getSession(sessionId)) {
        storage.insertError({
          sessionId,
          errorType,
          errorMessage: safeMessage,
          errorStack: safeStack,
          contextFile,
          contextTool,
          timestamp,
          resolved: false,
        })

        // Инкрементируем счётчик только для существующей сессии.
        const db = storage.getDb()
        db.prepare("UPDATE sessions SET errors_count = errors_count + 1 WHERE id = ?").run(sessionId)
      } else {
        log.warn(`Ошибка ${sessionId} не сохранена: сессия не найдена`)
      }

      log.warn(`Ошибка в сессии ${sessionId}: ${safeMessage.substring(0, 120)}`)
    } catch (err) {
      log.error("Ошибка в handleSessionError", err)
    }
  }

  // =========================================================================
  // 5. session.compacted — компактизация сессии
  // =========================================================================

  async function handleSessionCompacted(properties: Record<string, unknown>): Promise<void> {
    try {
      const newSessionId = (properties.sessionID as string) || ""
      const oldSessionId = (properties.compactedSessionID as string) || (properties.parentID as string) || null
      const timestamp = (properties.timestamp as number) || Date.now()
      const projectRoot = (properties.directory as string) || ""

      if (!newSessionId) {
        log.warn("session.compacted: отсутствует sessionID")
        return
      }

      // Получаем старую сессию для переноса данных — используем РЕАЛЬНЫЙ метод getSession
      const oldSession = oldSessionId
        ? storage.getSession(oldSessionId)
        : null

      // Вставка новой сессии — результат компактизации — используем РЕАЛЬНЫЙ метод insertSession
      storage.insertSession({
        id: newSessionId,
        agentType: (oldSession?.agentType as string) || "general",
        status: "active",
        startedAt: timestamp,
        endedAt: null,
        durationMs: null,
        filesChangedCount: (oldSession?.filesChangedCount as number) || 0,
        toolsUsedCount: (oldSession?.toolsUsedCount as number) || 0,
        errorsCount: (oldSession?.errorsCount as number) || 0,
        projectRoot: projectRoot || (oldSession?.projectRoot as string) || "",
        messageCount: 0,
        totalTokensUsed: (oldSession?.totalTokensUsed as number) || 0,
        compactedFrom: oldSessionId,
      })

      // Помечаем старую сессию как compacted — используем РЕАЛЬНЫЙ метод updateSessionStatus
      if (oldSessionId) {
        storage.updateSessionStatus(oldSessionId, "compacted")
      }

      log.info(`Сессия ${oldSessionId || "?"} компактизирована → ${newSessionId}`)
    } catch (err) {
      log.error("Ошибка в handleSessionCompacted", err)
    }
  }

  // =========================================================================
  // 6. command.executed — использование пользовательских команд
  // =========================================================================

  async function handleCommandExecuted(properties: Record<string, unknown>): Promise<void> {
    try {
      const commandName = (properties.name as string) || "unknown"
      const sessionId = (properties.sessionID as string) || currentSessionId || ""
      const args = (properties.arguments as string) || ""
      const messageId = (properties.messageID as string) || null
      const timestamp = Date.now()

      // Вставка developer event (тип: 'command_used')
      storage.enqueue("developer_events", {
        event_type: "command_used",
        session_id: sessionId,
        file_path: null,
        metadata: JSON.stringify({
          command: commandName,
          full_input: `${commandName} ${args}`,
          message_id: messageId,
        }),
        timestamp,
      })

      log.debug(`command.executed: ${commandName} (сессия: ${sessionId})`)
    } catch (err) {
      log.error("Ошибка в handleCommandExecuted", err)
    }
  }

  // =========================================================================
  // 7. message.updated — обнаружение паттерна "AI написал, человек исправил"
  // =========================================================================

  async function handleMessageUpdated(properties: Record<string, unknown>): Promise<void> {
    try {
      const info = properties.info as Record<string, unknown> | undefined
      if (!info) return

      const role = (info.role as string) || ""
      const sessionId = (info.sessionID as string) || "unknown"
      const messageId = (info.id as string) || ""
      const timestamp = (info.time as Record<string, unknown>)?.created as number || Date.now()

      // Нас интересуют только сообщения ассистента,
      // которые были отредактированы человеком
      // Эвристика: если роль assistant и сообщение содержит кодовые блоки —
      // считаем это исправлением AI-кода человеком
      if (role !== "assistant") return

      // Проверяем наличие кодовых блоков в сообщении
      const text = (info.text as string) || ""
      const parts = info.parts as Array<Record<string, unknown>> | undefined
      let combinedText = text
      if (parts) {
        for (const part of parts) {
          if (part.type === "text" && part.text) {
            combinedText += (part.text as string)
          }
        }
      }

      const hasCodeBlocks = combinedText.includes("```") || combinedText.includes("`")
      if (!hasCodeBlocks) return

      // Получаем связанный файл из контекста
      const summary = info.summary as Record<string, unknown> | undefined
      const diffs = summary?.diffs as Array<Record<string, unknown>> | undefined
      const relatedFile = diffs && diffs.length > 0
        ? (diffs[0].file as string)
        : null

      // Вставка developer event (тип: 'human_fix')
      storage.enqueue("developer_events", {
        event_type: "human_fix",
        session_id: sessionId,
        file_path: relatedFile,
        metadata: JSON.stringify({
          message_id: messageId,
          role: "assistant",
          has_code_blocks: true,
        }),
        timestamp,
      })

      log.debug(`message.updated: обнаружен human_fix для сессии ${sessionId}`)
    } catch (err) {
      log.error("Ошибка в handleMessageUpdated", err)
    }
  }

  // =========================================================================
  // 8. todo.updated — отслеживание выполнения задач
  // =========================================================================

  async function handleTodoUpdated(properties: Record<string, unknown>): Promise<void> {
    try {
      const sessionId = (properties.sessionID as string) || "unknown"
      const todos = properties.todos as Array<Record<string, unknown>> | undefined
      const timestamp = Date.now()

      if (!todos || !Array.isArray(todos) || !sessionId || !storage.getSession(sessionId)) return

      const session = storage.getSession(sessionId)
      const projectRoot = session?.projectRoot || ""

      for (const todo of todos) {
        const todoId = (todo.id as string) || ""
        const title = (todo.content as string) || "Без названия"
        const status = (todo.status as string) || "pending"

        if (!todoId) continue

        const db = storage.getDb()
        const previous = db.prepare("SELECT status FROM todos WHERE todo_id = ?1").get(todoId) as { status: string } | undefined

        // Upsert задачи в таблицу todos
        db.prepare(`
          INSERT INTO todos (todo_id, session_id, title, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(todo_id) DO UPDATE SET
            status = excluded.status,
            updated_at = excluded.updated_at
        `).run(todoId, sessionId, title, status, timestamp, timestamp)

        // Mirror OpenCode todos into the agent-native Task Graph. The
        // metadata link makes repeated todo.updated events idempotent.
        if (projectRoot) {
          try {
            const linked = db.prepare(`SELECT id FROM agent_tasks WHERE project_root = ?1 AND json_extract(metadata, '$.todo_id') = ?2 LIMIT 1`).get(projectRoot, todoId) as { id: string } | undefined
            const taskStatus = status === "completed" ? "completed" : status === "in_progress" ? "active" : "planned"
            if (!linked) {
              const task = storage.createTask({
                projectRoot, sessionId, title, goal: `Complete OpenCode todo: ${title}`,
                status: taskStatus, priority: 50, metadata: { todo_id: todoId, source: "opencode_todo" },
              })
              storage.addTaskStep({ taskId: task.id, title, status: taskStatus === "completed" ? "completed" : taskStatus === "active" ? "in_progress" : "pending", position: 0, blockedBy: null, metadata: { todo_id: todoId } })
            } else {
              storage.updateTask(linked.id, { status: taskStatus })
            }
          } catch (taskError) {
            log.debug(`todo → Task Graph пропущен: ${String(taskError)}`)
          }
        }

        // Если задача перешла в completed — записываем developer event
        if (status === "completed" && previous?.status !== "completed") {
          storage.enqueue("developer_events", {
            event_type: "todo_completed",
            session_id: sessionId,
            file_path: null,
            metadata: JSON.stringify({
              todo_id: todoId,
              title,
            }),
            timestamp,
          })

          log.debug(`todo.updated: задача "${title}" завершена`)
        }
      }
    } catch (err) {
      log.error("Ошибка в handleTodoUpdated", err)
    }
  }

  // =========================================================================
  // 9. lsp.client.diagnostics — диагностика от LSP-серверов
  // =========================================================================

  async function handleLspClientDiagnostics(properties: Record<string, unknown>): Promise<void> {
    try {
      const filePath = (properties.path as string) || "unknown"
      const serverId = (properties.serverID as string) || "unknown"
      const candidateSessionId = (properties.sessionID as string) || currentSessionId || ""
      const sessionId = candidateSessionId && storage.getSession(candidateSessionId)
        ? candidateSessionId
        : null
      const diagnostics = properties.diagnostics as Array<Record<string, unknown>> | undefined
      const timestamp = Date.now()

      if (!diagnostics || !Array.isArray(diagnostics)) {
        // Событие без diagnostics — только file/path/serverID
        // Логируем факт диагностики
        log.debug(`lsp.client.diagnostics: ${filePath} (сервер: ${serverId})`)
        return
      }

      // Подсчёт по severity
      let errors = 0
      let warnings = 0
      let hints = 0

      for (const diag of diagnostics) {
        const severity = (diag.severity as string) || ""
        if (severity === "error" || severity === "1") {
          errors++

          // Для каждой ошибки пишем developer event
          storage.enqueue("developer_events", {
            event_type: "lsp_diagnostic",
            session_id: sessionId,
            file_path: filePath,
            metadata: JSON.stringify({
              severity: "error",
              message: diag.message || "",
              line: diag.line,
              column: diag.column,
              code: diag.code || null,
              source: diag.source || serverId,
            }),
            timestamp,
          })
        } else if (severity === "warning" || severity === "2") {
          warnings++
        } else if (severity === "hint" || severity === "info" || severity === "3" || severity === "4") {
          hints++
        }
      }

      // Агрегированная запись через developer_events (таблицы lsp_diagnostics нет в схеме)
      storage.enqueue("developer_events", {
        event_type: "lsp_diagnostic_summary",
        session_id: sessionId,
        file_path: filePath,
        metadata: JSON.stringify({
          error_count: errors,
          warning_count: warnings,
          hint_count: hints,
          source: diagnostics[0]?.source as string || serverId,
        }),
        timestamp,
      })

      log.debug(`lsp.client.diagnostics: ${filePath} — ошибок: ${errors}, предупреждений: ${warnings}, подсказок: ${hints}`)
    } catch (err) {
      log.error("Ошибка в handleLspClientDiagnostics", err)
    }
  }

  // =========================================================================
  // 9b. lsp.diagnostic — реальные ошибки кода от LSP (TypeScript, ESLint и т.д.)
  // =========================================================================

  async function handleLspDiagnostic(properties: Record<string, unknown>): Promise<void> {
    try {
      const filePath = String(properties.file || properties.uri || "unknown")
      const sessionId = String(properties.sessionID || properties.sessionId || currentSessionId || "")
      const diagnostics = (properties.diagnostics || properties.errors || []) as Array<Record<string, unknown>>

      if (!Array.isArray(diagnostics) || diagnostics.length === 0) return

      for (const diag of diagnostics) {
        const message = String(diag.message || diag.text || "")
        const severity = String(diag.severity || diag.type || "warning")
        const range = diag.range as { start?: { line?: number; character?: number } } | undefined
        const line = Number(diag.line || range?.start?.line || 0)
        const column = Number(diag.column || range?.start?.character || 0)
        const source = String(diag.source || "lsp")
        const code = String(diag.code || "")

        // Store as session error with lsp type
        if (!sessionId || !storage.getSession(sessionId)) continue

        storage.recordError({
          sessionId,
          errorType: "lsp",
          errorMessage: message,
          contextFile: filePath,
          location: `${filePath}:${line}:${column}`,
          metadata: JSON.stringify({ severity, source, code }),
        })
      }

      log.debug(`lsp: ${filePath} — ${diagnostics.length} diagnostics`)
    } catch (err) {
      log.error("Ошибка в handleLspDiagnostic", err)
    }
  }

  // =========================================================================
  // 10. tool.execute.before — перехват перед выполнением инструмента
  // =========================================================================

  async function toolExecuteBefore(
    input: { tool: string; sessionID: string; callID: string },
    output: { args: Record<string, unknown> },
  ): Promise<void> {
    try {
      const toolName = input.tool
      const sessionId = input.sessionID
      const callId = input.callID

      // Track current session
      if (sessionId) currentSessionId = sessionId

      // Проверка: не отключён ли этот тип события
      if (config.disabledEventTypes.includes(toolName)) {
        log.debug(`tool.execute.before: ${toolName} отключён в конфигурации`)
        return
      }

      // Запоминаем время старта для расчёта длительности в tool.execute.after
      const timingKey = `${sessionId}:${callId}`
      toolStartTimes.set(timingKey, Date.now())

      // Для 'edit' и 'write' тулзов:
      // Phase 4: proactive risk check goes here
      // Пока только логируем вызов
      if (toolName === "edit" || toolName === "write") {
        log.debug(`tool.execute.before: ${toolName} (сессия: ${sessionId}, callId: ${callId}) — Phase 4: proactive risk check goes here`)
        const target = String(output.args?.filePath || output.args?.file || output.args?.path || "")
        if (target) assertEditLoopAllowed(sessionId, toolName, target)
        const session = storage.getSession(sessionId)
        if (target && session) {
          try {
            const contracts = storage.getDb().prepare(`SELECT id, allowed_paths, forbidden_paths FROM change_contracts WHERE project_root = ?1 AND status = 'active'`).all(session.projectRoot) as Array<{ id: string; allowed_paths: string; forbidden_paths: string }>
            const matches = (pattern: string, value: string) => pattern === "*" || value === pattern || value.startsWith(pattern.replace(/[*]$/, ""))
            for (const contract of contracts) {
              const allowed = JSON.parse(contract.allowed_paths || "[]") as string[]
              const forbidden = JSON.parse(contract.forbidden_paths || "[]") as string[]
              const violation = forbidden.some((pattern) => matches(pattern, target)) || (allowed.length > 0 && !allowed.some((pattern) => matches(pattern, target)))
              if (violation) {
                storage.enqueue("developer_events", {
                  event_type: "tool_rejected",
                  session_id: sessionId,
                  file_path: target,
                  metadata: JSON.stringify({ reason: "change_contract_preflight", contract_id: contract.id, tool: toolName }),
                  timestamp: Date.now(),
                })
                log.warn(`Preflight Change Contract warning: ${toolName} → ${target}, contract=${contract.id}`)
              }
            }
          } catch (preflightError) {
            log.debug(`Preflight Contract пропущен: ${String(preflightError)}`)
          }
        }
      } else {
        log.debug(`tool.execute.before: ${toolName} (сессия: ${sessionId})`)
      }
    } catch (err) {
      if (err instanceof SuccessfulEditLoopGuardError) throw err
      log.error("Ошибка в toolExecuteBefore", err)
    }
  }

  // =========================================================================
  // 11. tool.execute.after — запись результата выполнения инструмента
  // =========================================================================

  async function toolExecuteAfter(
    input: { tool: string; sessionID: string; callID: string; args: Record<string, unknown> },
    output: { title: string; output: string; metadata: Record<string, unknown> },
  ): Promise<void> {
    try {
      const toolName = input.tool
      const sessionId = input.sessionID
      const callId = input.callID
      const args = input.args || {}
      const resultOutput = output.output || ""
      const metadata = output.metadata || {}
      const resultTitle = output.title || ""

      // Расчёт длительности
      const timingKey = `${sessionId}:${callId}`
      const startTime = toolStartTimes.get(timingKey)
      const endTime = Date.now()
      const duration = startTime ? endTime - startTime : null

      // Удаляем ключ из Map для экономии памяти
      toolStartTimes.delete(timingKey)

      // Определение статуса
      let status: string
      if (resultOutput && !metadata.error && !metadata.timeout) {
        status = "success"
      } else if (metadata.timeout) {
        status = "timeout"
      } else if (metadata.denied) {
        status = "denied"
      } else {
        status = "error"
      }

      // Извлечение целевого файла из аргументов
      let targetFile: string | null = null
      if (args.filePath) targetFile = args.filePath as string
      else if (args.file) targetFile = args.file as string
      else if (args.path) targetFile = args.path as string
      else if (args.target) targetFile = args.target as string

      // Обрезка аргументов до config.maxArgsPreviewChars
      const argsStr = JSON.stringify(args)
      let argsPreview: string | null = null
      if (argsStr && argsStr !== "{}") {
        argsPreview = argsStr.length > config.maxArgsPreviewChars
          ? argsStr.substring(0, config.maxArgsPreviewChars)
          : argsStr
      }

      // Санитизация аргументов (удаление секретов)
      const safeArgsPreview = argsPreview
        ? sanitizeContent(argsPreview, config.secretPatterns)
        : null

      // Расчёт размера результата
      const resultSize = resultOutput ? Buffer.byteLength(resultOutput, "utf8") : null

      // Пакетная запись tool_execution
      storage.enqueue("tool_executions", {
        session_id: sessionId,
        tool_name: toolName,
        target_file: targetFile,
        args_preview: safeArgsPreview,
        status,
        duration_ms: duration,
        timestamp: endTime,
        result_size_bytes: resultSize,
      })

      // Auto-Memory: обнаружение фактов из результатов инструментов
      autoDetectFromToolResult(toolName, args, resultOutput, storage, log)

      // Verification commands become Evidence Ledger records automatically.
      captureCommandEvidence(toolName, sessionId, args, resultTitle, resultOutput, status)
      inspectToolLoop(toolName, sessionId, safeArgsPreview, status)
      if (status === "success" && targetFile && isMutatingFileTool(toolName)) {
        recordSuccessfulEdit(toolName, sessionId, targetFile, args)
      }

      const durationStr = duration !== null ? `${duration}мс` : "N/A"
      log.debug(`tool.execute.after: ${toolName} — ${status} (${durationStr})`)
    } catch (err) {
      log.error("Ошибка в toolExecuteAfter", err)
    }
  }

  // =========================================================================
  // 12. file.edited — прямой именованный хук (в дополнение к маршрутизации через event)
  // =========================================================================

  async function handleFileEditedDirect(input: any, output: any): Promise<void> {
    try {
      const filePath = input.file || input.filePath || input.path || "unknown"
      const editType = input.type || input.editType || "update"
      const diffText = input.diff || input.content || ""
      const linesAdded = input.linesAdded || input.additions || 0
      const linesRemoved = input.linesRemoved || input.deletions || 0
      const sessionId = input.sessionID || input.sessionId || currentSessionId || "unknown"
      const agentType = normalizeAgentType(input.agentType || input.agent)
      const normalizedEditType = normalizeEditType(editType)
      const timestamp = Date.now()

      let projectRoot = input.projectRoot || input.cwd || ""
      if (!projectRoot && sessionId !== "unknown") {
        try {
          const session = storage.getSession(sessionId)
          if (session?.projectRoot) {
            projectRoot = session.projectRoot
          }
        } catch { /* игнорируем ошибки получения сессии */ }
      }

      const language = detectLanguage(filePath)
      const diffHash = hashContent(diffText)
      const sanitizedDiff = sanitizeContent(diffText.substring(0, config.maxDiffPreviewChars))

      storage.enqueue("file_edits", {
        file_path: filePath,
        session_id: sessionId,
        agent_type: agentType,
        edit_type: normalizedEditType,
        diff_preview: sanitizedDiff,
        diff_hash: diffHash,
        lines_added: linesAdded,
        lines_removed: linesRemoved,
        timestamp,
        project_root: projectRoot,
        was_reverted: 0,
        file_language: language,
      })

      // The direct file.edited hook is used by OpenCode's host in addition to
      // the generic event dispatcher, so it must enforce the contract gate too.
      if (projectRoot) {
        try {
          const activeContracts = storage.getDb().prepare(
            `SELECT id, allowed_paths, forbidden_paths, violations FROM change_contracts
             WHERE project_root = ?1 AND status = 'active'`,
          ).all(projectRoot) as Array<{ id: string; allowed_paths: string; forbidden_paths: string; violations: string }>
          const matches = (pattern: string, value: string) => pattern === "*" || value === pattern || value.startsWith(pattern.replace(/[*]$/, ""))
          for (const contract of activeContracts) {
            const allowed = JSON.parse(contract.allowed_paths || "[]") as string[]
            const forbidden = JSON.parse(contract.forbidden_paths || "[]") as string[]
            if (forbidden.some((pattern) => matches(pattern, filePath)) || (allowed.length > 0 && !allowed.some((pattern) => matches(pattern, filePath)))) {
              const previous = JSON.parse(contract.violations || "[]") as string[]
              const violations = Array.from(new Set([...previous, filePath]))
              storage.getDb().prepare(`UPDATE change_contracts SET status = 'violated', violations = ?1, updated_at = ?2 WHERE id = ?3`).run(JSON.stringify(violations), Date.now(), contract.id)
              log.warn(`Change Contract нарушен: contract=${contract.id}, file=${filePath}`)
            }
          }
        } catch (contractError) {
          log.debug(`Change Contract gate пропущен: ${String(contractError)}`)
        }
      }

      // Авто-детект фактов из файла
      await autoDetectFromFile(storage, filePath, log)
      crushDirty = true

      log.debug(`file.edited: ${filePath} (${language}, +${linesAdded}/-${linesRemoved})`)
    } catch (err) {
      log.error("Ошибка в file.edited (прямой хук)", err)
    }
  }

  // =========================================================================
  // Возврат объекта хуков
  // =========================================================================

  return {
    event,
    "chat.message": handleChatMessage,
    "permission.ask": handlePermissionAsk,
    "file.edited": handleFileEditedDirect,
    "tool.execute.before": toolExecuteBefore,
    "tool.execute.after": toolExecuteAfter,
    "lsp.diagnostic": handleLspDiagnostic,
    // Экспортируем флаг для index.ts
    isCrushDirty: () => crushDirty,
    clearCrushDirty: () => { crushDirty = false },
  }
}
