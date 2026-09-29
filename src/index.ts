// =============================================================================
// Code Shadow — Точка входа плагина OpenCode
// Связывает Storage, Observer и Tools в единый плагин.
// =============================================================================

import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as fs from "node:fs"
import type { Plugin } from "@opencode-ai/plugin"
import type { ShadowConfig } from "./types.js"
import { loadConfig, resolvePath } from "./config.js"
import { StorageEngine } from "./storage.js"
import { createObserver } from "./observer.js"
import { createTuiIntegration } from "./tui.js"
import { createMemoryTools } from "./tools/memory.js"
import { createAnalyzeTool } from "./tools/analyze.js"
import { createContextTool } from "./tools/context.js"
import { createDecideTool } from "./tools/decide.js"
import { createAgentTools } from "./tools/agent.js"
import { createLogger } from "./logger.js"

// ---------------------------------------------------------------------------
// Определение директории плагина
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(__dirname, "..")

// ---------------------------------------------------------------------------
// Управление CRUSH.md — автономные инструкции для AI
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Авто-установка TUI-плагина — копирует tui-plugin.tsx и создаёт tui.json
// ---------------------------------------------------------------------------

async function ensureTuiPlugin(pluginDir: string, log: ReturnType<typeof createLogger>): Promise<void> {
  const srcTui = join(pluginDir, "tui-plugin.tsx")
  const tuiDestDir = resolvePath("~/.config/opencode/plugins/code-shadow")
  const tuiDest = join(tuiDestDir, "tui-plugin.tsx")
  const tuiConfigPath = resolvePath("~/.config/opencode/tui.json")

  try {
    if (!fs.existsSync(srcTui)) return

    if (!fs.existsSync(tuiDestDir)) {
      fs.mkdirSync(tuiDestDir, { recursive: true })
    }

    const srcMtime = fs.statSync(srcTui).mtimeMs
    const needCopy = !fs.existsSync(tuiDest) || fs.statSync(tuiDest).mtimeMs < srcMtime

    if (needCopy) {
      fs.copyFileSync(srcTui, tuiDest)
      log.info("TUI-плагин скопирован в ~/.config/opencode/plugins/code-shadow/")
    }

    if (!fs.existsSync(tuiConfigPath)) {
      const tuiConfig = { plugin: ["./plugins/code-shadow/tui-plugin.tsx"] }
      fs.writeFileSync(tuiConfigPath, JSON.stringify(tuiConfig, null, 2) + "\n", "utf-8")
      log.info("tui.json создан — перезапустите OpenCode для активации сайдбара")
    }
  } catch (err) {
    log.error(`Ошибка авто-установки TUI: ${String(err)}`)
  }
}

async function ensureCrushMd(storage: StorageEngine, config: ShadowConfig, log: ReturnType<typeof createLogger>): Promise<void> {
  const crushPath = resolvePath("~/.config/opencode/CRUSH.md")

  let sessionCount = 0
  let fileCount = 0
  let knowledgeCount = 0
  let errorCount = 0
  let projects: string[] = []

  try {
    const stats = storage.getStats()
    sessionCount = stats.tableCounts["sessions"] || 0
    fileCount = stats.tableCounts["file_edits"] || 0
    knowledgeCount = stats.tableCounts["knowledge_nodes"] || 0
    errorCount = stats.tableCounts["session_errors"] || 0
  } catch {
    // DB not ready — continue with defaults
  }

  try {
    projects = storage.getProjectRoots()
  } catch {
    projects = []
  }

  // Build per-project sections with facts from DB
  let projectSections = ""
  for (const proj of projects.slice(0, 5)) {
    const name = proj.split(/[\\/]/).pop() || proj

    let hotspots: { file_path: string; edit_count: number }[] = []
    let editCount = 0
    let sessionsCount = 0
    let lastSession: { agent_type: string; duration_ms: number } | undefined

    try {
      hotspots = storage.queryRows(
        `SELECT f.file_path, COUNT(*) as edit_count FROM file_edits f WHERE f.project_root = ?1 OR f.session_id IN (SELECT id FROM sessions WHERE project_root = ?1) GROUP BY f.file_path ORDER BY edit_count DESC LIMIT 3`,
        proj
      )
      log.debug(`CRUSH: ${name} — запрос хотспотов вернул ${hotspots.length} шт.`)
    } catch { /* ignore */ }

    try {
      editCount = storage.queryRows<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM file_edits WHERE project_root = ?1 OR session_id IN (SELECT id FROM sessions WHERE project_root = ?1)`,
        proj
      )[0]?.cnt || 0
      log.debug(`CRUSH: ${name} — запрос правок вернул ${editCount}`)
    } catch { /* ignore */ }

    try {
      lastSession = storage.queryRows(
        `SELECT agent_type, duration_ms FROM sessions WHERE project_root = ?1 AND status = 'idle' ORDER BY ended_at DESC LIMIT 1`,
        proj
      )[0] as { agent_type: string; duration_ms: number } | undefined

      if (lastSession) {
        sessionsCount = storage.queryRows<{ cnt: number }>(
          `SELECT COUNT(*) as cnt FROM sessions WHERE project_root = ?1`,
          proj
        )[0]?.cnt || 1
      }
    } catch { /* ignore */ }

    projectSections += `
### ${name}
- **Путь**: \`${proj}\`
- **Правок**: ${editCount} | **Сессий**: ${sessionsCount}
${hotspots.length > 0 ? `- **Горячие файлы**: ${hotspots.map((h) => `\`${h.file_path.split(/[\\/]/).pop() || h.file_path}\``).join(", ")}` : ""}
${lastSession ? `- **Последняя сессия**: ${lastSession.agent_type || "?"} (${Math.round((lastSession.duration_ms || 0) / 1000)}с)` : ""}
`
  }

  if (!projectSections) {
    projectSections = "(пока нет проектов в памяти)\n"
  }

  // Global knowledge summary (since knowledge_nodes has no project_root)
  let knowledgeSummary = ""
  try {
    const facts = storage.queryRows<{ name: string; category: string; node_type: string }>(
      `SELECT name, json_extract(metadata, '$.category') as category, node_type FROM knowledge_nodes WHERE node_type IN ('concept','rule','pattern') ORDER BY updated_at DESC LIMIT 20`
    )
    if (facts.length > 0) {
      const categories = [...new Set(facts.map((f) => f.category).filter(Boolean))]
      knowledgeSummary = `\n### Накопленные знания\n`
      for (const cat of categories.slice(0, 5)) {
        const catFacts = facts.filter((f) => f.category === cat).slice(0, 3)
        knowledgeSummary += `- **${cat}**: ${catFacts.map((f) => f.name?.substring(0, 80)).join("; ")}\n`
      }
    }
  } catch { /* ignore */ }

  const shadowSection = `
<!-- CODE_SHADOW_START -->
## Code Shadow — Автономный анализ проекта

> Управляется плагином автоматически. Обновлено: ${new Date().toISOString()}
> Проектов: ${projects.length} | Сессий: ${sessionCount} | Правок: ${fileCount} | Фактов: ${knowledgeCount} | Ошибок: ${errorCount}

### Обязательные правила (БЕЗ команды)

1. **В начале сессии** → code_shadow_context_inject и code_shadow_context_router
2. **Пользовательский запрос** → Task Graph создаётся автоматически из chat.message
3. **Для задачи дольше одного шага** → code_shadow_task action="create"
4. **Перед правкой unfamiliar файла** → code_shadow_analyze query="predict_change" + code_shadow_change_contract
5. **Перед рискованной правкой** → code_shadow_counterfactual
6. **При баге или ошибке** → code_shadow_analyze query="code_errors" + code_shadow_failure_memory
7. **После проверки** → evidence создаётся автоматически для test/typecheck/build/lint/check команд
8. **Перед завершением** → code_shadow_task action="done_check", затем action="complete"
9. **При конфликте источников** → code_shadow_contradiction
10. **Важный факт о проекте** → code_shadow_memory_write
11. **Каждые 5-10 правок** → code_shadow_analyze query="hotspots"
12. **Проверка качества** → code_shadow_agent_insight action="quality" или "risk"
13. **Перед передачей работы** → code_shadow_handoff action="create"
14. **В конце сессии** → code_shadow_task action="complete"

### Инструменты (используй проактивно)

| Инструмент | Когда |
|---|---|
| code_shadow_memory_search | Поиск фактов о проекте, конвенций, истории |
| code_shadow_analyze query="predict_change" | Перед правкой любого файла |
| code_shadow_analyze query="hotspots" | Периодически для оценки здоровья |
| code_shadow_analyze query="code_errors" | Проверить ошибки LSP/компилятора |
| code_shadow_analyze query="my_stats" | Моя статистика разработчика |
| code_shadow_analyze query="team_pulse" | Общее здоровье проекта |
| code_shadow_analyze query="file_history" | История конкретного файла |
| code_shadow_context_inject | Быстрый вход в контекст проекта |
| code_shadow_context_router | Контекст под текущую задачу: task/evidence/failures/contracts |
| code_shadow_task | Task Graph: цель, шаги, блокировки, завершение |
| code_shadow_evidence | Evidence Ledger: утверждение → проверяемый источник |
| code_shadow_failure_memory | Неудачные попытки, root cause и do-not-repeat |
| code_shadow_change_contract | Границы файлов и план верификации изменений |
| code_shadow_counterfactual | Какие файлы/риски/проверки затронет возможная правка |
| code_shadow_contradiction | Конфликтующие утверждения и их разрешение |
| code_shadow_provenance | Доверие к файлам/выводу инструментов и injection flags |
| code_shadow_handoff | Переносимый снимок работы между агентами/сессиями |
| code_shadow_agent_insight | Поведение агента, качество evidence и риск работы |
| code_shadow_memory_write | Сохранить важный факт (пути, конфиги, конвенции) |
| code_shadow_memory_note | Заметка/напоминание/итог сессии |
| code_shadow_decide | Архитектурное решение (ADR) |

### Проекты в памяти

${projectSections}${knowledgeSummary}
<!-- CODE_SHADOW_END -->
`

  try {
    let existing = ""
    try {
      existing = fs.readFileSync(crushPath, "utf-8")
    } catch {
      // File doesn't exist — will be created
    }

    const startMarker = "<!-- CODE_SHADOW_START -->"
    const endMarker = "<!-- CODE_SHADOW_END -->"
    const startIdx = existing.indexOf(startMarker)
    const endIdx = existing.indexOf(endMarker)

    if (startIdx === -1) {
      const updated = existing.trimEnd() + "\n\n" + shadowSection.trim() + "\n"
      const dir = dirname(crushPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(crushPath, updated, "utf-8")
      log.info(`CRUSH.md обновлён (проектов: ${projects.length})`)
    } else {
      const before = existing.substring(0, startIdx)
      const after = existing.substring(endIdx + endMarker.length)
      const updated = before + shadowSection.trim() + after
      fs.writeFileSync(crushPath, updated, "utf-8")
      log.info(`CRUSH.md обновлён (проектов: ${projects.length})`)
    }
  } catch (err) {
    log.error(`Ошибка управления CRUSH.md: ${String(err)}`)
  }
}

// ---------------------------------------------------------------------------
// Code Shadow Plugin
// ---------------------------------------------------------------------------

export const CodeShadow = async (ctx: Parameters<Plugin>[0]) => {
  const log = createLogger("core")

  // =========================================================================
  // 1. Загрузка конфигурации
  // =========================================================================

  const config = loadConfig(pluginDir)
  log.info(`Code Shadow v0.5.0 — Теневой наблюдатель активирован`)
  log.info(`База данных: ${config.dbPath}`)
  log.info(`Хранение сырых данных: ${config.retentionDays} дней`)

  // =========================================================================
  // 2. Инициализация хранилища
  // =========================================================================

  let storage: StorageEngine
  try {
    storage = new StorageEngine(config)
    log.info("База данных инициализирована")

    const stats = storage.getStats()
    log.info(`Статистика БД: ${JSON.stringify(stats)}`)
  } catch (err) {
    log.error(`Ошибка инициализации БД: ${String(err)}`)
    return { tool: {} }
  }

  // =========================================================================
  // 3. Очистка устаревших данных
  // =========================================================================

  try {
    storage.runCleanup(config.retentionDays, config.sessionRetentionDays)
    log.debug("Очистка старых данных выполнена")
  } catch (err) {
    log.error(`Ошибка очистки: ${String(err)}`)
  }

  // =========================================================================
  // 4. Периодический сброс пакетной очереди
  // =========================================================================

  const flushInterval = setInterval(() => {
    try {
      storage.flushBatch()
    } catch (err) {
      log.error(`Ошибка flushBatch: ${String(err)}`)
    }
  }, config.flushIntervalMs)

  // CRUSH.md refresh — проверяем каждые 10 секунд, обновляем только если данные изменились
  let crushChecksSinceRefresh = 0
  const crushInterval = setInterval(async () => {
    try {
      crushChecksSinceRefresh++
      const obsAny = observerHooks as any
      const shouldRefresh = (obsAny.isCrushDirty && obsAny.isCrushDirty?.()) || crushChecksSinceRefresh >= 18 // 18 * 10s = 3 min
      if (shouldRefresh) {
        await ensureCrushMd(storage, config, log)
        obsAny.clearCrushDirty?.()
        crushChecksSinceRefresh = 0
      }
    } catch (err) {
      log.error(`CRUSH refresh error: ${String(err)}`)
    }
  }, 10000)

  // =========================================================================
  // 4.1. CRUSH.md — автономные инструкции для AI
  // =========================================================================

  try {
    await ensureCrushMd(storage, config, log)
  } catch (err) {
    log.error(`Ошибка ensureCrushMd: ${String(err)}`)
  }

  // =========================================================================
  // 4.2. Авто-установка TUI-плагина
  // =========================================================================

  try {
    await ensureTuiPlugin(pluginDir, log)
  } catch (err) {
    log.error(`Ошибка ensureTuiPlugin: ${String(err)}`)
  }

  // =========================================================================
  // 5. Создание AI-тулзов
  // =========================================================================

  const allTools: Record<string, unknown> = {
    ...createMemoryTools(storage, config, log),
    ...createAnalyzeTool(storage, config, log),
    ...createContextTool(storage, config, log),
    ...createDecideTool(storage, config, log),
    ...createAgentTools(storage, config, log),
  }

  log.info(`Загружено тулзов: ${Object.keys(allTools).length}`)

  // =========================================================================
  // 6. Создание наблюдателя (Observer Engine)
  // =========================================================================

  let observerHooks: Record<string, unknown> = {}
  try {
    observerHooks = createObserver(storage as any, config, log, ctx.client) as unknown as Record<string, unknown>
    log.info("Observer активирован")
  } catch (err) {
    log.error(`Ошибка создания Observer: ${String(err)}`)
  }

  // =========================================================================
  // 7. Создание TUI-интеграции (тосты, /shadow команды, инъекция контекста)
  // =========================================================================

  let tuiHooks: Record<string, unknown> = {}
  try {
    tuiHooks = createTuiIntegration(storage, config, log) as unknown as Record<string, unknown>
    log.info("TUI-интеграция активирована")
  } catch (err) {
    log.error(`Ошибка создания TUI-интеграции: ${String(err)}`)
  }

  // =========================================================================
  // 8. Graceful shutdown — очистка ресурсов при выгрузке плагина
  // =========================================================================

  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    log.info("Code Shadow завершает работу...")
    clearInterval(flushInterval)
    clearInterval(crushInterval)
    try {
      storage.flushBatch()
      storage.close()
      log.info("База данных закрыта")
    } catch (err) {
      log.error(`Ошибка при завершении: ${String(err)}`)
    }
  }

  process.on("exit", cleanup)
  process.on("SIGINT", cleanup)
  process.on("SIGTERM", cleanup)

  // =========================================================================
  // 9. Возврат объекта регистрации плагина
  // =========================================================================

  // OpenCode принимает один callback на имя hook. Не даём TUI-интеграции
  // затереть Observer: оба обработчика должны выполняться последовательно.
  const mergedHooks: Record<string, unknown> = {
    ...observerHooks,
    ...tuiHooks,
  }

  const observerBefore = observerHooks["tool.execute.before"] as
    | ((input: unknown, output: unknown) => Promise<void>)
    | undefined
  const tuiBefore = tuiHooks["tool.execute.before"] as
    | ((input: unknown, output: unknown) => Promise<void>)
    | undefined

  if (observerBefore && tuiBefore) {
    mergedHooks["tool.execute.before"] = async (input: unknown, output: unknown) => {
      await observerBefore(input, output)
      await tuiBefore(input, output)
    }
  }

  return {
    ...mergedHooks,
    tool: allTools as Record<string, unknown>,
  } as any
}

export default CodeShadow
