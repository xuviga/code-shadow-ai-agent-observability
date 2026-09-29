// =============================================================================
// Code Shadow — TUI Integration & Proactive Alerts (Фаза 4)
// Интеграция с TUI-интерфейсом OpenCode: тосты предупреждений,
// команды /shadow, инъекция контекста при компактизации сессии.
// =============================================================================

import type { ShadowConfig } from "./types"
import { StorageEngine } from "./storage"
import type { createLogger } from "./logger"

// ---------------------------------------------------------------------------
// Интерфейс возвращаемых хуков
// ---------------------------------------------------------------------------

interface TuiHooks {
  "tool.execute.before": (input: any, output: any) => Promise<void>
  "tui.prompt.append": (input: any, output: any) => Promise<void>
  "experimental.session.compacting": (input: any, output: any) => Promise<void>
}

// ---------------------------------------------------------------------------
// Фабрика TUI-интеграции
// ---------------------------------------------------------------------------

export function createTuiIntegration(
  storage: StorageEngine,
  config: ShadowConfig,
  log: ReturnType<typeof createLogger>,
): TuiHooks {

  // =========================================================================
  // 1. Toast Warnings — предупреждения перед рискованными правками
  // =========================================================================

  async function toolExecuteBefore(input: any, output: any): Promise<void> {
    try {
      if (input.tool !== "edit" && input.tool !== "write") return

      const filePath =
        output.args?.filePath ||
        output.args?.file_path ||
        input.args?.filePath ||
        input.args?.file_path
      if (!filePath) return

      const deps = storage.getDependencyCount(filePath)
      const breakageRate = storage.getHistoricalBreakageRate(filePath, "90d")
      const recentSessions = storage.getRecentSimilarChanges(filePath, "30d", 3)
      const riskScore = Math.min(
        breakageRate * 0.6 + Math.min(deps / 20, 1) * 0.4,
        1,
      )

      let riskLevel: string
      if (riskScore >= config.riskErrorThreshold) riskLevel = "КРИТИЧЕСКИЙ"
      else if (riskScore >= config.riskWarningThreshold) riskLevel = "ВЫСОКИЙ"
      else return

      const hasRecentBreakage = recentSessions.some(
        (s) => s.errorsCount > 0,
      )

      const fileName = filePath.split("/").pop() || filePath
      const type = riskScore >= config.riskErrorThreshold ? "error" : "warning"
      const briefReason = hasRecentBreakage
        ? `последнее изменение вызвало ошибку`
        : `${deps} зависимостей`

      output.toast = {
        type,
        message: `⚠️ ${fileName}: ${riskLevel} риск (${Math.round(riskScore * 100)}%) — ${briefReason}`,
        duration: 5000,
      }

      log.info(
        `Toast: ${riskLevel} риск для ${filePath} (score: ${riskScore.toFixed(2)})`,
      )
    } catch (err) {
      log.error(`Ошибка проверки риска: ${String(err)}`)
    }
  }

  // =========================================================================
  // 2. /shadow Commands — обработка кастомных команд
  // =========================================================================

  async function tuiPromptAppend(input: any, output: any): Promise<void> {
    try {
      const text: string = input.text || ""
      if (!text.startsWith("/shadow")) return

      const parts = text.trim().split(/\s+/)
      const subcommand = parts[1]
      const arg = parts.slice(2).join(" ")

      let message = ""

      switch (subcommand) {
        case "hotspots": {
          const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
          const top = storage.queryRows<{ file_path: string; edit_count: number }>(
            `SELECT file_path, COUNT(*) AS edit_count
             FROM file_edits
             WHERE timestamp >= ?1
             GROUP BY file_path
             ORDER BY edit_count DESC
             LIMIT 5`,
            cutoff,
          ).map((row) => row.file_path)
          if (top.length === 0) {
            message = "Пока недостаточно данных для hotspots"
          } else {
            message = `🔥 Hotspots:\n${top.map(f => `  ${f}`).join("\n")}`
          }
          break
        }
        case "predict": {
          if (!arg) { message = "Укажите файл: /shadow predict src/app.ts"; break }
          const deps = storage.getDependencyCount(arg)
          const breakageRate = storage.getHistoricalBreakageRate(arg, "90d")
          const risk = Math.round(Math.min(breakageRate * 0.6 + Math.min(deps / 20, 1) * 0.4, 1) * 100)
          const level = risk < 30 ? "низкий" : risk < 60 ? "средний" : risk < 80 ? "высокий" : "критический"
          message = `🔮 ${arg.split("/").pop()}: ${level} риск (${risk}%)`
          break
        }
        case "stats": {
          const sessions = storage.getSessionCount("30d")
          const files = storage.getDistinctFiles("30d").length
          message = `📊 За 30 дней: ${sessions} сессий, ${files} файлов`
          break
        }
        case "health": {
          const files = storage.getDistinctFiles("30d")
          const edits = files.reduce((sum, file) => sum + storage.getFileEditCount(file, "30d"), 0)
          const errors = files.reduce((sum, file) => sum + storage.getErrorCountForFile(file, "30d"), 0)
          const score = edits > 0 ? Math.max(0, Math.round((1 - errors / edits) * 100)) : 100
          message = `💚 Здоровье проекта: ${score}% (${files.length} файлов, ${errors} ошибок)`
          break
        }
        case "tui": {
          if (["stats", "errors", "memory"].includes(arg)) {
            storage.setCached("tui_active_tab", arg)
            message = `TUI: вкладка "${arg}"`
          } else {
            message = "Используйте: /shadow tui stats|errors|memory"
          }
          break
        }
        default: {
          message = "/shadow hotspots | predict <file> | stats | health | tui <tab>"
        }
      }

      if (message) {
        output.toast = {
          variant: "info" as const,
          title: "Code Shadow",
          message,
          duration: 5000,
        }
      }
    } catch (err) {
      log.error(`Ошибка /shadow: ${String(err)}`)
    }
  }

  // =========================================================================
  // 3. Context Injection — инъекция КОМПЛЕКСНОГО контекста при компактизации
  // =========================================================================

  async function sessionCompacting(input: any, output: any): Promise<void> {
    output.context = output.context || []

    try {
      // 1. Project identity
      const projectRoot = input.projectRoot || ""
      const projectName = projectRoot.split(/[\\/]/).pop() || "неизвестный проект"

      // 2. Memory facts
      const memoryNodes = storage.searchNodes("", 20) || []
      const facts = memoryNodes
        .filter((n: any) => n.nodeType !== "note")
        .map((n: any) => {
          try {
            const meta = n.metadata || {}
            return `- [${meta.category || n.nodeType}] ${meta.full_content || meta.content || n.name}`
          } catch { return `- ${n.name}` }
        })

      // 3. Hotspots
      const files = storage.getDistinctFiles("30d")
      const hotspots: { file: string; edits: number; errors: number }[] = []
      for (const f of files.slice(0, 10)) {
        const edits = storage.getFileEditCount(f, "30d")
        const errors = storage.getErrorCountForFile(f, "30d")
        if (edits >= 2) hotspots.push({ file: f, edits, errors })
      }
      hotspots.sort((a, b) => b.edits - a.edits)

      // 4. Stats
      const sessionCount = storage.getSessionCount("30d")
      const totalFiles = files.length

      // 5. Project health
      const stats = storage.getStats()
      const totalErrors = stats.tableCounts["session_errors"] || 0
      const healthPct = sessionCount > 0
        ? Math.round(Math.max(0, Math.min(100, 100 - (totalErrors / sessionCount) * 100)))
        : 100

      // BUILD THE BRIEFING
      const briefing = `## АВТОНОМНЫЙ КОНТЕКСТ ПРОЕКТА (Code Shadow)

Ты работаешь над проектом **${projectName}**.
Здоровье проекта: **${healthPct}%**. Всего сессий: ${sessionCount}, активных файлов: ${totalFiles}.

### Память проекта (авто-сохранённые факты)
${facts.length > 0 ? facts.slice(0, 15).join("\n") : "(пока нет сохранённых фактов — используй code_shadow_memory_write чтобы сохранить важное)"}

${hotspots.length > 0 ? `### Активные файлы (правки за 30 дней)
${hotspots.slice(0, 8).map(h => `- ${h.file} (${h.edits} правок${h.errors > 0 ? `, ${h.errors} ошибок` : ""})`).join("\n")}` : ""}

### ИНСТРУКЦИЯ: как использовать Code Shadow АВТОНОМНО

Ты имеешь доступ к этим инструментам. ИСПОЛЬЗУЙ ИХ ПРОАКТИВНО, без явной просьбы пользователя:

1. **Перед изменениями в незнакомых файлах** → вызови code_shadow_analyze query="predict_change" target="<file>"
2. **В начале работы над задачей** → вызови code_shadow_memory_search query="<ключевые слова>" чтобы найти релевантные факты
3. **Когда узнаёшь важное о проекте** → сохрани через code_shadow_memory_write
4. **Для проверки общей картины** → code_shadow_analyze query="hotspots"
5. **В конце сессии** → code_shadow_memory_note с итогами и что нужно сделать дальше
6. **Для архитектурных решений** → code_shadow_decide

НЕ ЖДИ команды пользователя. Будь проактивным ассистентом, который использует память и аналитику самостоятельно.`

      output.context.push(briefing)
    } catch (err) {
      log.error(`Ошибка инъекции контекста: ${String(err)}`)
    }
  }

  // =========================================================================
  // Возврат хуков
  // =========================================================================

  return {
    "tool.execute.before": toolExecuteBefore,
    "tui.prompt.append": tuiPromptAppend,
    "experimental.session.compacting": sessionCompacting,
  }
}
