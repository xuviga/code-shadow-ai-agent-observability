// =============================================================================
// Code Shadow — Analytics Engine: code_shadow_analyze
// Главный аналитический тулз. 9 режимов работы: hotspots, predict_change,
// file_history, team_pulse, my_stats, dependency_graph, knowledge_search,
// decisions_list.
// =============================================================================

import { tool } from "@opencode-ai/plugin"
import type { StorageEngine } from "../storage"
import type { ShadowConfig } from "../types"
import {
  type HotspotEntry,
  type PredictionResult,
  type FileHistory,
  type FileHistoryEntry,
  type FileHistoryTimeline,
  type TeamPulse,
  type DevStats,
  type DependencyGraph,
  type KnowledgeSearchResult,
  type Decision,
  type FileEdit,
  type SessionError,
  type KnowledgeNode,
  type KnowledgeEdge,
  RiskLevel,
  EdgeType,
  NodeType,
  AgentType,
} from "../types"
import { createLogger } from "../logger"

// ---------------------------------------------------------------------------
// Типы аргументов
// ---------------------------------------------------------------------------

type AnalyzerArgs = {
  query: string
  target?: string
  timeframe?: string
  limit?: number
  depth?: number
}

// ---------------------------------------------------------------------------
// Вспомогательные утилиты
// ---------------------------------------------------------------------------

/** Безопасное деление: возвращает 0 при делении на 0 */
function safeDiv(numerator: number, denominator: number): number {
  if (denominator === 0 || !isFinite(denominator)) return 0
  return numerator / denominator
}

/** Зажимает значение в диапазон [0, 1] */
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

/** Нормализует массив чисел "min → 0, max → 1" */
function normalizeArray(values: number[]): number[] {
  if (values.length === 0) return []
  const max = Math.max(...values)
  if (max === 0) return values.map(() => 0)
  return values.map((v) => clamp01(v / max))
}

/** Парсит timeframe в количество дней для сравнения */
function daysFromTimeframe(tf: string): number {
  switch (tf) {
    case "7d": return 7
    case "30d": return 30
    case "90d": return 90
    case "all": return 365
    default: return 30
  }
}

/** Возвращает предыдущий timeframe такой же длительности */
function previousTimeframe(tf: string): string {
  const days = daysFromTimeframe(tf)
  if (days <= 7) return "7d"
  if (days <= 30) return "30d"
  if (days <= 90) return "90d"
  return "all"
}

function periodBounds(timeframe: string, now = Date.now()): {
  currentStart: number
  previousStart: number
  previousEnd: number
} | null {
  if (timeframe === "all") return null
  const duration = daysFromTimeframe(timeframe) * 24 * 60 * 60 * 1000
  const currentStart = now - duration
  return {
    currentStart,
    previousStart: currentStart - duration,
    previousEnd: currentStart,
  }
}

/** Форматирует timestamp в строку YYYY-MM-DD */
function formatDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

// =============================================================================
// Обработчики режимов
// =============================================================================

/**
 * handleHotspots — тепловая карта проблемных файлов.
 * Для каждого файла считаем составной score из частоты правок,
 * доли ошибок, недавних изменений и откатов. Кешируем результат на 1 час.
 */
async function handleHotspots(
  storage: StorageEngine,
  args: AnalyzerArgs,
  log: ReturnType<typeof createLogger>,
): Promise<{ hotspots: HotspotEntry[]; generated_at: number; timeframe: string; total_files_analyzed: number }> {
  const limit = args.limit || 10
  const timeframe = args.timeframe || "30d"

  // 1. Проверяем кеш аналитики
  const cacheKey = `hotspots:${timeframe}:${limit}`
  const cached = storage.getCached(cacheKey)
  if (cached) {
    log.info(`Хотспоты взяты из кеша: key=${cacheKey}`)
    return cached as { hotspots: HotspotEntry[]; generated_at: number; timeframe: string; total_files_analyzed: number }
  }

  // 2. Получаем все уникальные файлы за период
  const files = storage.getDistinctFiles(timeframe)
  if (files.length === 0) {
    log.info("Нет данных о правках за указанный период")
    return { hotspots: [], generated_at: Date.now(), timeframe, total_files_analyzed: 0 }
  }

  // 3. Собираем сырые метрики по каждому файлу
  interface RawMetrics {
    filePath: string
    totalEdits: number
    perDay: number
    errorCount: number
    revertedCount: number
    recentEditCount: number
    lastEditedAt: number | null
  }

  const rawMetrics: RawMetrics[] = []
  for (const filePath of files) {
    const editCount = storage.getFileEditCount(filePath, timeframe)
    if (editCount === 0) continue

    const freq = storage.getEditFrequency(filePath, timeframe)
    const errorCount = storage.getErrorCountForFile(filePath, timeframe)
    const revertedCount = storage.getRevertedEditCount(filePath, timeframe)
    const recentEditCount = storage.getFileEditCount(filePath, "7d")
    const edits = storage.getFileEdits(filePath, timeframe)
    const lastEditedAt = edits.length > 0 ? edits[0].timestamp : null

    rawMetrics.push({
      filePath,
      totalEdits: editCount,
      perDay: freq.perDay,
      errorCount,
      revertedCount,
      recentEditCount,
      lastEditedAt,
    })
  }

  if (rawMetrics.length === 0) {
    return { hotspots: [], generated_at: Date.now(), timeframe, total_files_analyzed: 0 }
  }

  // 4. Нормализуем метрики относительно всей выборки
  const perDayValues = rawMetrics.map((m) => m.perDay)
  const perDayNorm = normalizeArray(perDayValues)

  const errorRateValues = rawMetrics.map((m) => safeDiv(m.errorCount, m.totalEdits))
  const errorRateNorm = normalizeArray(errorRateValues)

  const recentValues = rawMetrics.map((m) => safeDiv(m.recentEditCount, m.totalEdits))
  const recentNorm = normalizeArray(recentValues)

  const frustrationValues = rawMetrics.map((m) => safeDiv(m.revertedCount, m.totalEdits))
  const frustrationNorm = normalizeArray(frustrationValues)

  // 5. Вычисляем итоговый score по формуле
  const scored: HotspotEntry[] = rawMetrics.map((m, i) => {
    const scoreRaw =
      perDayNorm[i] * 0.3 +
      errorRateNorm[i] * 0.4 +
      recentNorm[i] * 0.2 +
      frustrationNorm[i] * 0.1

    const score = Math.round(clamp01(scoreRaw) * 100)

    // Генерируем объяснение на русском
    const parts: string[] = []
    if (m.perDay > 3) parts.push(`Высокая частота правок (${m.totalEdits} за период, ~${m.perDay.toFixed(1)}/день)`)
    if (m.errorCount > 0) parts.push(`${m.errorCount} ошибок связано с файлом`)
    if (m.revertedCount > 0) parts.push(`${m.revertedCount} откатов изменений`)
    if (m.recentEditCount >= m.totalEdits * 0.5 && m.totalEdits > 2) parts.push("Активно правится в последние 7 дней")
    const explanation = parts.length > 0 ? parts.join(". ") + "." : "Файл относительно стабилен."

    return {
      filePath: m.filePath,
      score,
      rank: 0, // заполним после сортировки
      breakdown: {
        editFrequency: Math.round(perDayNorm[i] * 100) / 100,
        errorRate: Math.round(errorRateNorm[i] * 100) / 100,
        recentChanges: Math.round(recentNorm[i] * 100) / 100,
        developerFrustration: Math.round(frustrationNorm[i] * 100) / 100,
      },
      stats: {
        totalEdits: m.totalEdits,
        totalErrors: m.errorCount,
        totalReverts: m.revertedCount,
        lastEditedAt: m.lastEditedAt,
      },
      explanation,
    }
  })

  // 6. Сортируем по score, назначаем rank
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, limit)
  top.forEach((h, i) => { h.rank = i + 1 })

  // 7. Кешируем на 1 час
  const result = {
    hotspots: top,
    generated_at: Date.now(),
    timeframe,
    total_files_analyzed: scored.length,
  }
  storage.setCached(cacheKey, result, 3_600_000)

  log.info(
    `Хотспоты рассчитаны: проанализировано файлов=${scored.length}, hotspots=${top.length}, timeframe=${timeframe}`,
  )

  return result
}

// =============================================================================

/**
 * handlePredictChange — предиктивный анализ риска изменения файла.
 * На основе исторической частоты поломок, количества зависимостей
 * и совместно ломающихся файлов вычисляет риск.
 */
async function handlePredictChange(
  storage: StorageEngine,
  args: AnalyzerArgs,
  log: ReturnType<typeof createLogger>,
): Promise<PredictionResult | { error: string }> {
  const filePath = args.target
  if (!filePath) return { error: "Укажите target — путь к файлу для анализа" }

  // 1. Количество зависимостей из графа знаний
  const dependencyCount = storage.getDependencyCount(filePath)

  // 2. Историческая частота поломок
  const breakageRate = storage.getHistoricalBreakageRate(filePath, "30d")

  // 3. Недавние похожие изменения
  const recentSessions = storage.getRecentSimilarChanges(filePath, "30d", 5)
  const recentSimilarChanges = recentSessions.map((s) => ({
    file: filePath,
    date: formatDate(s.startedAt),
    result: s.errorsCount > 0 ? "errors" : "clean",
  }))

  // 4. Вычисляем риск
  const riskScore =
    breakageRate * 0.6 +
    Math.min(dependencyCount / 20, 1) * 0.4

  // 5. Определяем уровень риска
  let riskLevel: RiskLevel
  if (riskScore < 0.3) riskLevel = RiskLevel.Low
  else if (riskScore < 0.6) riskLevel = RiskLevel.Medium
  else if (riskScore < 0.8) riskLevel = RiskLevel.High
  else riskLevel = RiskLevel.Critical

  // 6. Файлы, которые могут быть затронуты
  const coChanged = storage.getCoChangedFiles(filePath, 1)
  const affectedFiles = coChanged.map((cc) => {
    // Считаем вероятность поломки со-изменяемого файла
    const coBreakRate = storage.getHistoricalBreakageRate(cc.file, "30d")
    const coFreq = cc.frequency
    const breakProbability = clamp01(coBreakRate * 0.7 + Math.min(coFreq / 20, 1) * 0.3)
    return {
      path: cc.file,
      riskContribution: Math.round(cc.frequency / Math.max(coChanged[0]?.frequency ?? 1, 1) * 100) / 100,
      relationType: "co_changed",
      breakageProbability: Math.round(breakProbability * 100) / 100,
    }
  })

  // 7. Рекомендация на основе уровня риска
  let recommendation: string
  switch (riskLevel) {
    case RiskLevel.Low:
      recommendation = "НИЗКИЙ РИСК. Файл стабилен, можно править без дополнительных проверок."
      break
    case RiskLevel.Medium:
      recommendation = "СРЕДНИЙ РИСК. Рекомендуется запустить тесты смежных модулей после изменений."
      break
    case RiskLevel.High:
      recommendation = `ВЫСОКИЙ РИСК. Изменения этого файла в ${Math.round(breakageRate * 100)}% случаев приводили к ошибкам. Рекомендуется: 1) полный прогон тестов, 2) проверка затронутых файлов, 3) маленькие коммиты.`
      break
    case RiskLevel.Critical:
      recommendation = `КРИТИЧЕСКИЙ РИСК. Файл имеет ${dependencyCount} зависимостей и высокую частоту поломок. Рекомендуется обсудить изменения с командой, подготовить rollback-план.`
      break
  }

  log.info(
    `predict_change: file=${filePath}, risk=${riskLevel}, score=${riskScore.toFixed(3)}, deps=${dependencyCount}`,
  )

  return {
    riskScore: Math.round(riskScore * 100) / 100,
    riskLevel,
    primaryFile: filePath,
    affectedFiles,
    recentSimilarChanges,
    dependencyCount,
    historicalBreakageRate: Math.round(breakageRate * 100) / 100,
    recommendation,
  }
}

// =============================================================================

/**
 * handleFileHistory — полная история изменений файла.
 * Возвращает хронологию правок, aggregated timeline и посчитанную стабильность.
 */
async function handleFileHistory(
  storage: StorageEngine,
  args: AnalyzerArgs,
  log: ReturnType<typeof createLogger>,
): Promise<FileHistory | { error: string }> {
  const filePath = args.target
  if (!filePath) return { error: "Укажите target — путь к файлу" }

  const timeframe = args.timeframe || "all"

  // 1. Получаем все правки файла
  const edits = storage.getFileEdits(filePath, timeframe)
  if (edits.length === 0) {
    return {
      filePath,
      totalEdits: 0,
      firstEditAt: 0,
      lastEditAt: 0,
      edits: [],
      timeline: [],
    }
  }

  // 2. Получаем ошибки файла для привязки к правкам
  const errors = storage.getErrorsForFile(filePath, timeframe)

  // Группируем ошибки по sessionId для быстрого поиска
  const errorsBySession = new Map<string, SessionError[]>()
  for (const err of errors) {
    const list = errorsBySession.get(err.sessionId) || []
    list.push(err)
    errorsBySession.set(err.sessionId, list)
  }

  // 3. Строим timeline — каждый элемент соответствует одной правке
  const editEntries: FileHistoryEntry[] = edits.map((edit) => {
    const sessionErrors = errorsBySession.get(edit.sessionId) || []
    return {
      sessionId: edit.sessionId,
      timestamp: edit.timestamp,
      agentType: edit.agentType,
      editType: edit.editType,
      linesAdded: edit.linesAdded,
      linesRemoved: edit.linesRemoved,
      associatedErrors: sessionErrors.length,
    }
  })

  // 4. Строим агрегированные временные срезы
  const now = Date.now()
  const periods: { label: string; cutoffDays: number }[] = [
    { label: "7d", cutoffDays: 7 },
    { label: "30d", cutoffDays: 30 },
    { label: "90d", cutoffDays: 90 },
    { label: "all", cutoffDays: 3650 },
  ]

  const timeline: FileHistoryTimeline[] = periods.map((p) => {
    const cutoff = now - p.cutoffDays * 24 * 60 * 60 * 1000
    const filtered = edits.filter((e) => e.timestamp >= cutoff)
    const errorCount = errors.filter((e) => e.timestamp >= cutoff).length
    const revertCount = filtered.filter((e) => e.wasReverted).length

    // Топ контрибьюторов по sessionId
    const contribMap = new Map<string, number>()
    for (const e of filtered) {
      contribMap.set(e.sessionId, (contribMap.get(e.sessionId) || 0) + 1)
    }
    const topContributors = [...contribMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([sessionId, editCount]) => ({ sessionId, editCount }))

    return {
      period: p.label,
      editCount: filtered.length,
      errorCount,
      revertCount,
      topContributors,
    }
  })

  // 5. Считаем стабильность
  // Уникальные сессии, трогавшие файл
  const sessionsSet = new Set(edits.map((e) => e.sessionId))
  const totalSessions = sessionsSet.size
  // Сессии, в которых были ошибки связанные с этим файлом
  const errorSessionIds = new Set(errors.map((e) => e.sessionId))
  // Считаем только ошибки, пересекающиеся с сессиями правок
  let errorSessionsCount = 0
  for (const sid of errorSessionIds) {
    if (sessionsSet.has(sid)) errorSessionsCount++
  }

  // 6. Сортируем записи по дате (от новых к старым)
  editEntries.sort((a, b) => b.timestamp - a.timestamp)

  const firstEditAt = edits.reduce((min, e) => Math.min(min, e.timestamp), edits[0]?.timestamp ?? 0)
  const lastEditAt = edits.reduce((max, e) => Math.max(max, e.timestamp), edits[0]?.timestamp ?? 0)

  log.info(
    `file_history: file=${filePath}, edits=${edits.length}, sessions=${totalSessions}, errors=${errors.length}`,
  )

  return {
    filePath,
    totalEdits: edits.length,
    firstEditAt,
    lastEditAt,
    edits: editEntries,
    timeline,
  }
}

// =============================================================================

/**
 * handleTeamPulse — пульс команды / здоровье проекта.
 * Собирает агрегированные метрики по всему проекту.
 */
async function handleTeamPulse(
  storage: StorageEngine,
  args: AnalyzerArgs,
  log: ReturnType<typeof createLogger>,
): Promise<TeamPulse> {
  const timeframe = args.timeframe || "30d"

  // 1. Количество хотспотов (переиспользуем логику, но ограниченно)
  const hotspotResult = await handleHotspots(storage, { ...args, limit: 50 }, log)
  const hotspots = hotspotResult.hotspots
  const hotspotCount = hotspots.filter((h) => h.score > 60).length

  // 2. Количество уникальных файлов
  const allFiles = storage.getDistinctFiles(timeframe)
  const totalFiles = allFiles.length

  // 3. Файлы, которые редактировались (активные)
  const activeFiles = allFiles.length

  // 4. Статистика сессий
  const sessionCount = storage.getSessionCount(timeframe)

  // 5. AI reliance ratio: доля правок от AI-агентов
  let totalEditsAll = 0
  let aiEdits = 0
  let totalErrors = 0
  for (const file of allFiles.slice(0, 200)) {
    // Ограничиваем 200 файлами для производительности
    const edits = storage.getFileEdits(file, timeframe)
    totalEditsAll += edits.length
    aiEdits += edits.filter(
      (e) => e.agentType === AgentType.Build || e.agentType === AgentType.Plan,
    ).length
    totalErrors += storage.getErrorCountForFile(file, timeframe)
  }
  const aiRelianceRatio = safeDiv(aiEdits, totalEditsAll)

  // 6. Error rate
  const errorRate = safeDiv(totalErrors, totalEditsAll)

  // 7. Project health score: взвешенная композиция метрик
  // Чем меньше хотспотов, чем выше стабильность — тем лучше
  const maxPossibleHotspots = Math.max(allFiles.length, 1)
  const hotspotPenalty = clamp01(hotspotCount / maxPossibleHotspots)
  const errorPenalty = clamp01(errorRate)
  const aiBonus = clamp01(aiRelianceRatio) * 0.1 // AI помогает

  const healthScore = clamp01(1 - (hotspotPenalty * 0.3 + errorPenalty * 0.5) + aiBonus)

  // 8. Определяем тренд: сравниваем с предыдущим периодом
  let prevErrors = 0
  let prevEdits = 0
  const bounds = periodBounds(timeframe)
  if (bounds) {
    const prevFiles = storage.getDistinctFilesBetween(bounds.previousStart, bounds.previousEnd)
    for (const file of prevFiles.slice(0, 200)) {
      const edits = storage.getFileEditsBetween(file, bounds.previousStart, bounds.previousEnd)
      prevEdits += edits.length
      prevErrors += storage.getErrorsForFileBetween(file, bounds.previousStart, bounds.previousEnd).length
    }
  }
  const prevErrorRate = safeDiv(prevErrors, prevEdits)

  let trend: "improving" | "stable" | "declining"
  if (prevErrorRate > 0 && errorRate < prevErrorRate * 0.8) trend = "improving"
  else if (prevErrorRate > 0 && errorRate > prevErrorRate * 1.2) trend = "declining"
  else trend = "stable"

  // 9. Топ-концерн: файл с наивысшим hotspot score
  const topConcern =
    hotspots.length > 0
      ? `Файл ${hotspots[0].filePath} имеет наивысший показатель проблемности (${hotspots[0].score}/100)`
      : "Явных проблемных файлов не выявлено"

  // 10. Помесячная динамика здоровья
  const healthOverTime: { month: string; score: number }[] = []
  const now = Date.now()
  for (let i = 5; i >= 0; i--) {
    const currentMonth = new Date(now)
    const monthStart = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - i, 1)
    const monthStr = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, "0")}`

    // Приблизительная оценка здоровья за месяц
    const monthCutoff = monthStart.getTime()
    const nextMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1).getTime()
    const monthEnd = i === 0 ? now : nextMonth

    let monthErrors = 0
    let monthEdits = 0
    for (const file of allFiles.slice(0, 100)) {
      const monthFiltered = storage.getFileEditsBetween(file, monthCutoff, monthEnd)
      monthEdits += monthFiltered.length
      monthErrors += storage.getErrorsForFileBetween(file, monthCutoff, monthEnd).length
    }
    const monthErrorRate = safeDiv(monthErrors, monthEdits)
    const monthScore = clamp01(1 - monthErrorRate * 1.5)
    healthOverTime.push({ month: monthStr, score: Math.round(monthScore * 100) / 100 })
  }

  // 11. Разбивка по модулям (директориям первого уровня)
  const moduleMap = new Map<string, { files: number; healthScore: number; hotspot: string | null }>()
  for (const file of allFiles) {
    const parts = file.replace(/\\/g, "/").split("/")
    const module = parts.length > 1 ? parts.slice(0, 2).join("/") : parts[0] || "root"

    const existing = moduleMap.get(module) || { files: 0, healthScore: 0, hotspot: null }
    existing.files++
    // Приблизительный health score для модуля на основе хотспотов
    // Находим hotspot для этого модуля если есть
    const modHotspot = hotspots.find((h) => h.filePath.startsWith(module))
    if (modHotspot) {
      existing.healthScore = clamp01(1 - modHotspot.score / 100)
      if (!existing.hotspot) existing.hotspot = modHotspot.filePath
    } else {
      existing.healthScore = clamp01(existing.healthScore + 0.02)
    }
    moduleMap.set(module, existing)
  }

  const moduleBreakdown = [...moduleMap.entries()].map(([module, data]) => ({
    module,
    healthScore: Math.round(data.healthScore * 100) / 100,
    files: data.files,
    hotspot: data.hotspot,
  }))

  log.info(
    `team_pulse: health=${healthScore.toFixed(2)}, trend=${trend}, files=${totalFiles}, hotspots=${hotspotCount}`,
  )

  return {
    projectHealthScore: Math.round(healthScore * 100) / 100,
    trend,
    totalFiles,
    activeFiles,
    hotspotCount,
    aiRelianceRatio: Math.round(aiRelianceRatio * 100) / 100,
    errorRate: Math.round(errorRate * 100) / 100,
    topConcern,
    healthOverTime,
    moduleBreakdown,
  }
}

// =============================================================================

/**
 * handleMyStats — персональная статистика разработчика.
 * Считает сессии, частоту, AI-reliance, распределение инструментов,
 * тренды и достижения.
 */
async function handleMyStats(
  storage: StorageEngine,
  args: AnalyzerArgs,
  log: ReturnType<typeof createLogger>,
): Promise<DevStats> {
  const timeframe = args.timeframe || "30d"

  // 1. Количество сессий в периоде
  const sessionCount = storage.getSessionCount(timeframe)
  const daysTotal = daysFromTimeframe(timeframe)
  const sessionsPerDay = safeDiv(sessionCount, daysTotal)

  // 2. Средняя длительность сессий (используем developer_events и sessions)
  const devEvents = storage.getDevEvents(undefined, timeframe)
  const sessionStartEvents = devEvents.filter((e) => e.eventType === "session_start" || e.eventType === "session_started")
  const sessionEndEvents = devEvents.filter((e) => e.eventType === "session_end" || e.eventType === "session_completed")

  // Приблизительная оценка длительности по событиям
  let totalDuration = 0
  let sessionDurations = 0
  for (let i = 0; i < Math.min(sessionStartEvents.length, sessionEndEvents.length); i++) {
    const start = sessionStartEvents[i]
    const end = sessionEndEvents.find((e) => e.sessionId === start.sessionId)
    if (end && end.timestamp > start.timestamp) {
      totalDuration += end.timestamp - start.timestamp
      sessionDurations++
    }
  }
  const avgSessionDurationMs =
    sessionDurations > 0 ? totalDuration / sessionDurations : sessionCount > 0 ? 15 * 60 * 1000 : 0

  // 3. Топ файлов по количеству правок
  const allFiles = storage.getDistinctFiles(timeframe)
  const fileEditCounts: { path: string; edits: number }[] = []
  for (const file of allFiles.slice(0, 100)) {
    const count = storage.getFileEditCount(file, timeframe)
    if (count > 0) fileEditCounts.push({ path: file, edits: count })
  }
  fileEditCounts.sort((a, b) => b.edits - a.edits)
  const topFiles = fileEditCounts.slice(0, 10)

  // 4. AI reliance ratio (доля правок AI vs все правки)
  let totalEditsAll = 0
  let aiEditCount = 0
  for (const file of allFiles.slice(0, 200)) {
    const edits = storage.getFileEdits(file, timeframe)
    totalEditsAll += edits.length
    aiEditCount += edits.filter(
      (e) => e.agentType === AgentType.Build || e.agentType === AgentType.Plan,
    ).length
  }
  const aiRelianceRatio = safeDiv(aiEditCount, totalEditsAll)

  // 5. Fix rate: доля правок, в которых человек исправлял AI-код
  // (оцениваем через developer_events типа 'human_fix')
  const humanFixEvents = devEvents.filter((e) => e.eventType === "human_fix" || e.eventType === "manual_edit")
  const fixRate = safeDiv(humanFixEvents.length, totalEditsAll)

  // 6. Распределение использования инструментов
  // Получаем через tool_executions для всех сессий периода
  const toolUsage: Record<string, number> = {}
  // Для каждого файла собираем tool_executions
  const toolFiles = new Map<string, number>()
  for (const file of allFiles.slice(0, 200)) {
    const execs = storage.getToolExecutionsForFile(file, timeframe)
    for (const exec of execs) {
      toolUsage[exec.toolName] = (toolUsage[exec.toolName] || 0) + 1
    }
  }

  // 7. Тренды: сравниваем с предыдущим периодом
  let prevTotalEdits = 0
  let prevAiEdits = 0
  const bounds = periodBounds(timeframe)
  if (bounds) {
    const prevFiles = storage.getDistinctFilesBetween(bounds.previousStart, bounds.previousEnd)
    for (const file of prevFiles.slice(0, 200)) {
      const edits = storage.getFileEditsBetween(file, bounds.previousStart, bounds.previousEnd)
      prevTotalEdits += edits.length
      prevAiEdits += edits.filter(
        (e) => e.agentType === AgentType.Build || e.agentType === AgentType.Plan,
      ).length
    }
  }
  const prevAiReliance = safeDiv(prevAiEdits, prevTotalEdits)
  const prevHumanFix = bounds
    ? storage.getDevEventsBetween("human_fix", bounds.previousStart, bounds.previousEnd).length
    : 0
  const prevFixRate = safeDiv(prevHumanFix, prevTotalEdits)

  log.info(
    `my_stats: sessions=${sessionCount}, sessions/day=${sessionsPerDay.toFixed(1)}, ai=${aiRelianceRatio.toFixed(2)}`,
  )

  return {
    sessionsPerDay: Math.round(sessionsPerDay * 100) / 100,
    avgSessionDurationMs,
    toolUsageDistribution: toolUsage,
    topFiles,
    aiRelianceRatio: Math.round(aiRelianceRatio * 100) / 100,
    fixRate: Math.round(fixRate * 100) / 100,
  }
}

// =============================================================================

/**
 * handleDependencyGraph — граф зависимостей файла.
 * Возвращает импорты, обратные импорты, со-изменяемые файлы.
 */
async function handleDependencyGraph(
  storage: StorageEngine,
  args: AnalyzerArgs,
  log: ReturnType<typeof createLogger>,
): Promise<DependencyGraph | { error: string }> {
  const filePath = args.target
  if (!filePath) return { error: "Укажите target — путь к файлу" }
  const depth = Math.max(1, Math.min(args.depth || 1, 5))

  // 1. Ищем узел файла в knowledge_nodes
  const nodes = storage.searchNodes(filePath, 100)
  const fileNode = nodes.find((n) => n.nodeType === NodeType.File && n.path === filePath)

  // 2. Получаем рёбра графа знаний
  const edges: { source: string; target: string; relation: EdgeType; weight: number }[] = []
  const nodeIds = new Set<string>()

  // Обходим граф breadth-first до указанной глубины.
  if (fileNode) {
    const visited = new Set<number>([fileNode.id])
    const edgeKeys = new Set<string>()
    let frontier = [fileNode.id]

    const nodeKey = (nodeId: number): string => {
      const node = storage.getNode(nodeId)
      return node?.path ?? `node:${nodeId}`
    }

    nodeIds.add(nodeKey(fileNode.id))
    for (let level = 0; level < depth && frontier.length > 0; level++) {
      const next: number[] = []
      for (const nodeId of frontier) {
        for (const edge of storage.getEdgesForNode(nodeId)) {
          const key = `${edge.id}:${edge.sourceId}:${edge.targetId}`
          if (edgeKeys.has(key)) continue
          edgeKeys.add(key)

          const srcKey = nodeKey(edge.sourceId)
          const tgtKey = nodeKey(edge.targetId)
          edges.push({ source: srcKey, target: tgtKey, relation: edge.edgeType, weight: edge.weight })
          nodeIds.add(srcKey)
          nodeIds.add(tgtKey)

          const neighbor = edge.sourceId === nodeId ? edge.targetId : edge.sourceId
          if (!visited.has(neighbor)) {
            visited.add(neighbor)
            next.push(neighbor)
          }
        }
      }
      frontier = next
    }
  }

  // 3. Со-изменяемые файлы (co-changed)
  const coChanged = storage.getCoChangedFiles(filePath, 1)
  for (const cc of coChanged) {
    const weight = Math.min(cc.frequency / 10, 1)
    edges.push({
      source: filePath,
      target: cc.file,
      relation: EdgeType.CoupledWith,
      weight: Math.round(weight * 100) / 100,
    })
    nodeIds.add(cc.file)
  }
  // Добавляем сам файл
  nodeIds.add(filePath)

  // 4. Строим узлы
  const graphNodes = [...nodeIds].map((id) => {
    const hotspot = (() => {
      // Быстрая оценка hotspot score через частоту правок
      const freq = storage.getEditFrequency(id, "30d")
      const errCount = storage.getErrorCountForFile(id, "30d")
      if (freq.total === 0) return undefined
      const rawScore = clamp01(Math.min(freq.perDay / 5, 1) * 0.5 + safeDiv(errCount, freq.total) * 0.5)
      return Math.round(rawScore * 100)
    })()
    return {
      id,
      label: id.split("/").pop() || id,
      type: "file" as const,
      hotspotScore: hotspot,
    }
  })

  // 5. Саммари графа
  const importCount = edges.filter((e) => e.relation === EdgeType.Imports).length
  const coupledCount = edges.filter((e) => e.relation === EdgeType.CoupledWith).length
  const depCount = edges.filter((e) => e.relation === EdgeType.DependsOn).length

  const graphSummary =
    `Граф зависимостей для ${filePath}: ${graphNodes.length} узлов, ${edges.length} рёбер. ` +
    `Импорты: ${importCount}, ко-изменения: ${coupledCount}, зависимости: ${depCount}. ` +
    `Глубина обхода: ${depth}.`

  log.info(
    `dependency_graph: file=${filePath}, depth=${depth}, nodes=${graphNodes.length}, edges=${edges.length}`,
  )

  return {
    rootFile: filePath,
    nodes: graphNodes,
    edges,
    graphSummary,
  }
}

// =============================================================================

/**
 * handleCodeErrors — поиск реальных ошибок кода (LSP-диагностика).
 * Фильтрует session_errors с error_type = 'lsp', агрегирует по файлу и сообщению.
 */
async function handleCodeErrors(
  storage: StorageEngine,
  args: AnalyzerArgs,
  log: ReturnType<typeof createLogger>,
): Promise<{ result: string; items: Array<Record<string, unknown>>; suggestion?: string }> {
  const timeframe = args.timeframe || "7d"
  const limit = args.limit || 20
  const projectRoot = args.target || ""

  const cutoff = (() => {
    const match = timeframe.match(/^(\d+)d$/)
    if (match) return Date.now() - parseInt(match[1], 10) * 24 * 60 * 60 * 1000
    return null
  })()

  const params: (string | number)[] = []
  let sql = `
    SELECT e.error_message, e.context_file, e.error_stack, e.timestamp, COUNT(*) as cnt
    FROM session_errors e
    INNER JOIN sessions s ON e.session_id = s.id
    WHERE e.error_type = 'lsp'
  `

  if (projectRoot) {
    sql += ` AND s.project_root = ?${params.length + 1}`
    params.push(projectRoot)
  }

  if (cutoff !== null) {
    sql += ` AND e.timestamp >= ?${params.length + 1}`
    params.push(cutoff)
  }

  sql += ` GROUP BY e.error_message, e.context_file`
  sql += ` ORDER BY cnt DESC`
  sql += ` LIMIT ?${params.length + 1}`
  params.push(limit)

  const rows = storage.queryRows(sql, ...params) as Array<{
    error_message: string
    context_file: string
    error_stack: string | null
    timestamp: number
    cnt: number
  }>

  if (rows.length === 0) {
    return {
      result: "🔍 Ошибок кода не найдено за выбранный период. Включи LSP в настройках OpenCode.",
      items: [],
    }
  }

  const items = rows.map((r) => {
    const meta = (() => {
      try { return JSON.parse(r.error_stack || "{}") } catch { return {} }
    })() as Record<string, unknown>

    return {
      file: r.context_file,
      message: r.error_message,
      location: (meta.location as string) || r.context_file,
      count: r.cnt,
      severity: (meta.severity as string) || "warning",
    }
  })

  return {
    result: `🔍 Найдено ${items.length} уникальных ошибок в коде проекта.`,
    items,
    suggestion: "Попроси меня исправить эти ошибки — я проанализирую каждую и предложу фикс.",
  }
}

// =============================================================================

/**
 * handleKnowledgeSearch — семантический поиск по графу знаний.
 * Ищет по knowledge_nodes и decisions, ранжирует по релевантности.
 */
async function handleKnowledgeSearch(
  storage: StorageEngine,
  args: AnalyzerArgs,
  log: ReturnType<typeof createLogger>,
): Promise<{ results: KnowledgeSearchResult[]; query: string; total_found: number } | { error: string }> {
  const query = args.target
  if (!query) return { error: "Укажите target — поисковый запрос" }
  const limit = args.limit || 10

  const results: KnowledgeSearchResult[] = []

  // 1. Поиск по knowledge_nodes
  const nodes = storage.searchNodes(query, limit)
  for (const node of nodes) {
    const meta = node.metadata as Record<string, unknown> | null
    // Точное совпадение > частичное > по тегам
    const nameLower = node.name.toLowerCase()
    const queryLower = query.toLowerCase()
    let relevanceScore = 0
    if (nameLower === queryLower) relevanceScore = 10
    else if (nameLower.includes(queryLower)) relevanceScore = 7
    else {
      const words = queryLower.split(/\s+/).filter((w) => w.length > 1)
      const matched = words.filter((w) => nameLower.includes(w))
      relevanceScore = safeDiv(matched.length, words.length) * 5
    }

    results.push({
      source: "memory",
      type: node.nodeType,
      id: String(node.id),
      label: node.name,
      description: (meta?.content ?? meta?.full_content)
        ? String(meta.content ?? meta.full_content).slice(0, 200)
        : (node.path ?? ""),
      relevanceScore,
      metadata: (meta ?? {}) as Record<string, unknown>,
      updatedAt: node.updatedAt,
      relatedNodes: [],
    })
  }

  // 2. Поиск по decisions
  const decisions = storage.getDecisions(undefined, 100)
  for (const d of decisions) {
    const titleLower = d.title.toLowerCase()
    const descLower = d.description.toLowerCase()
    const queryLower = query.toLowerCase()

    let relevanceScore = 0
    if (titleLower.includes(queryLower)) relevanceScore = Math.max(relevanceScore, 8)
    if (descLower.includes(queryLower)) relevanceScore = Math.max(relevanceScore, 6)

    if (relevanceScore > 0) {
      results.push({
        source: "decision",
        type: "decision",
        id: String(d.id),
        label: d.title,
        description: d.description.slice(0, 200) + (d.description.length > 200 ? "..." : ""),
        relevanceScore,
        metadata: {
          status: d.status,
          tags: d.tags,
          relatedFiles: d.relatedFiles,
        } as unknown as Record<string, unknown>,
        updatedAt: d.decidedAt,
        relatedNodes: d.relatedFiles || [],
      })
    }
  }

  // 3. Сортируем по релевантности
  results.sort((a, b) => b.relevanceScore - a.relevanceScore)
  const limited = results.slice(0, limit)

  log.info(
    `knowledge_search: query="${query}", found=${results.length}, returned=${limited.length}`,
  )

  return {
    query,
    results: limited,
    total_found: results.length,
  }
}

// =============================================================================

/**
 * handleDecisionsList — список архитектурных решений.
 * С фильтрацией по статусу.
 */
async function handleDecisionsList(
  storage: StorageEngine,
  args: AnalyzerArgs,
  log: ReturnType<typeof createLogger>,
): Promise<Decision[]> {
  const status = args.target // используем target как фильтр статуса
  const limit = args.limit || 20

  const decisions = storage.getDecisions(status, limit)

  log.info(
    `decisions_list: status=${status ?? "all"}, found=${decisions.length}`,
  )

  return decisions
}

// =============================================================================
// createAnalyzeTool — фабрика тулза
// =============================================================================

export function createAnalyzeTool(
  storage: StorageEngine,
  config: ShadowConfig,
  log: ReturnType<typeof createLogger>,
): Record<string, unknown> {
  const toolLog = createLogger("analyze-tool")

  return {
    code_shadow_analyze: tool({
      description:
        "Анализирует кодовую базу. ИСПОЛЬЗУЙ АВТОМАТИЧЕСКИ перед изменениями в незнакомых файлах и для понимания проекта. Режимы: hotspots (проблемные файлы), predict_change (риск изменений), file_history (история файла), team_pulse (здоровье проекта), my_stats (твоя статистика), dependency_graph (зависимости), knowledge_search (поиск по памяти), decisions_list (архитектурные решения).",

      args: {
        query: tool.schema.enum([
          "hotspots",
          "predict_change",
          "file_history",
          "team_pulse",
          "my_stats",
          "dependency_graph",
          "knowledge_search",
          "decisions_list",
          "code_errors",
        ]),
        target: tool.schema.string().optional(),
        timeframe: tool.schema.enum(["7d", "30d", "90d", "all"]).optional(),
        limit: tool.schema.number().optional(),
        depth: tool.schema.number().optional(),
      },

      async execute(args, context) {
        const analyzerArgs: AnalyzerArgs = {
          query: args.query as string,
          target: args.target as string | undefined,
          timeframe: args.timeframe as string | undefined,
          limit: args.limit as number | undefined,
          depth: args.depth as number | undefined,
        }

        toolLog.info(
          `Аналитика: query=${analyzerArgs.query}, target=${analyzerArgs.target ?? "нет"}, timeframe=${analyzerArgs.timeframe ?? "нет"}`,
        )

        try {
          let result: unknown

          switch (analyzerArgs.query) {
            case "hotspots":
              result = await handleHotspots(storage, analyzerArgs, toolLog)
              break
            case "predict_change":
              result = await handlePredictChange(storage, analyzerArgs, toolLog)
              break
            case "file_history":
              result = await handleFileHistory(storage, analyzerArgs, toolLog)
              break
            case "team_pulse":
              result = await handleTeamPulse(storage, analyzerArgs, toolLog)
              break
            case "my_stats":
              result = await handleMyStats(storage, analyzerArgs, toolLog)
              break
            case "dependency_graph":
              result = await handleDependencyGraph(storage, analyzerArgs, toolLog)
              break
            case "knowledge_search":
              result = await handleKnowledgeSearch(storage, analyzerArgs, toolLog)
              break
            case "decisions_list":
              result = await handleDecisionsList(storage, analyzerArgs, toolLog)
              break
            case "code_errors":
              result = await handleCodeErrors(storage, analyzerArgs, toolLog)
              break
            default:
              result = { error: `Неизвестный тип запроса: ${analyzerArgs.query}` }
          }

          return { output: JSON.stringify(result, null, 2) }
        } catch (err) {
          toolLog.error(`Ошибка в code_shadow_analyze: ${String(err)}`)
          return { output: `❌ Ошибка анализа: ${String(err)}` }
        }
      },
    }),
  }
}
