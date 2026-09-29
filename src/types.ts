// =============================================================================
// Code Shadow — Полная система типов
// Все интерфейсы соответствуют схеме БД из DATA_MODEL.md.
// Соглашение: поля БД — snake_case, TypeScript-свойства — camelCase.
// =============================================================================

// ---------------------------------------------------------------------------
// Перечисления (Enums)
// ---------------------------------------------------------------------------

/** Тип AI-агента, выполняющего сессию */
export enum AgentType {
  Build = "build",
  Plan = "plan",
  General = "general",
  Explore = "explore",
}

/** Статус сессии — конечный автомат */
export enum SessionStatus {
  Created = "created",
  Active = "active",
  Idle = "idle",
  Error = "error",
  Compacted = "compacted",
  Deleted = "deleted",
}

/** Тип изменения файла */
export enum EditType {
  Create = "create",
  Update = "update",
  Delete = "delete",
}

/** Статус выполнения инструмента */
export enum ToolStatus {
  Success = "success",
  Error = "error",
  Timeout = "timeout",
  Denied = "denied",
}

/** Тип ошибки сессии */
export enum ErrorType {
  ToolError = "tool_error",
  ModelError = "model_error",
  PermissionDenied = "permission_denied",
  Unknown = "unknown",
  Lsp = "lsp",
}

/** Тип узла в графе знаний */
export enum NodeType {
  File = "file",
  Module = "module",
  Concept = "concept",
  Component = "component",
  Api = "api",
  Pattern = "pattern",
  Rule = "rule",
  ApiEndpoint = "api_endpoint",
  Note = "note",
  Decision = "decision",
}

/** Тип ребра (связи) в графе знаний */
export enum EdgeType {
  Imports = "imports",
  Exports = "exports",
  Contains = "contains",
  DependsOn = "depends_on",
  CausesBugsIn = "causes_bugs_in",
  RefactoredTo = "refactored_to",
  SimilarTo = "similar_to",
  TestedBy = "tested_by",
  Implements = "implements",
  Extends = "extends",
  CoupledWith = "coupled_with",
  References = "references",
}

/** Тип события разработчика */
export enum DevEventType {
  SessionStarted = "session_started",
  ManualEdit = "manual_edit",
  Revert = "revert",
  CommandUsed = "command_used",
  HumanFix = "human_fix",
  SessionStart = "session_start",
  SessionEnd = "session_end",
  SessionCompleted = "session_completed",
  TodoCompleted = "todo_completed",
  LspDiagnostic = "lsp_diagnostic",
  LspDiagnosticSummary = "lsp_diagnostic_summary",
  FileFocus = "file_focus",
  ToolRejected = "tool_rejected",
}

/** Уровень риска */
export enum RiskLevel {
  Low = "low",
  Medium = "medium",
  High = "high",
  Critical = "critical",
}

/** Категория долговременной памяти (аналог ctx_memory) */
export enum MemoryCategory {
  ProjectRules = "PROJECT_RULES",
  Architecture = "ARCHITECTURE",
  Constraints = "CONSTRAINTS",
  ConfigValues = "CONFIG_VALUES",
  Naming = "NAMING",
}

/** Жизненный цикл агентской задачи. */
export enum TaskStatus {
  Planned = "planned",
  Active = "active",
  Blocked = "blocked",
  Completed = "completed",
  Cancelled = "cancelled",
}

/** Состояние шага задачи. */
export enum TaskStepStatus {
  Pending = "pending",
  InProgress = "in_progress",
  Completed = "completed",
  Blocked = "blocked",
  Skipped = "skipped",
}

/** Состояние доказательства утверждения. */
export enum EvidenceStatus {
  Observed = "observed",
  Verified = "verified",
  Failed = "failed",
  Unknown = "unknown",
}

/** Уровень доверия к источнику, который попал в контекст агента. */
export enum TrustLevel {
  System = "system",
  User = "user",
  Verified = "verified",
  Observed = "observed",
  Untrusted = "untrusted",
}

// ---------------------------------------------------------------------------
// Интерфейсы таблиц базы данных
// ---------------------------------------------------------------------------

/** file_edits — каждое изменение файла */
export interface FileEdit {
  id: number;
  filePath: string;
  sessionId: string;
  agentType: AgentType;
  editType: EditType;
  diffPreview: string | null;
  linesAdded: number;
  linesRemoved: number;
  timestamp: number;
  projectRoot: string;
  wasReverted: boolean;
  fileLanguage: string | null;
}

/** sessions — жизненный цикл сессии */
export interface Session {
  id: string;
  agentType: AgentType;
  status: SessionStatus;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  filesChangedCount: number;
  toolsUsedCount: number;
  errorsCount: number;
  projectRoot: string;
  messageCount: number;
  totalTokensUsed: number;
  compactedFrom: string | null;
}

/** session_errors — ошибки во время сессий */
export interface SessionError {
  id: number;
  sessionId: string;
  errorType: ErrorType;
  errorMessage: string;
  errorStack: string | null;
  contextFile: string | null;
  contextTool: string | null;
  timestamp: number;
  resolved: boolean;
}

/** tool_executions — каждый вызов инструмента AI-агентом */
export interface ToolExecution {
  id: number;
  sessionId: string;
  toolName: string;
  targetFile: string | null;
  argsPreview: string | null;
  status: ToolStatus;
  durationMs: number | null;
  timestamp: number;
  resultSizeBytes: number | null;
}

/** decisions — архитектурные решения (ADR) */
export interface Decision {
  id: number;
  title: string;
  description: string;
  context: string | null;
  alternatives: string[] | null;
  status: "proposed" | "accepted" | "deprecated" | "superseded";
  decidedBy: string | null;
  decidedAt: number;
  supersededBy: number | null;
  relatedFiles: string[] | null;
  tags: string[] | null;
}

/** knowledge_nodes — узлы графа знаний */
export interface KnowledgeNode {
  id: number;
  nodeType: NodeType;
  name: string;
  path: string | null;
  metadata: KnowledgeNodeMetadata | null;
  createdAt: number;
  updatedAt: number;
}

/** Метаданные узла графа знаний (хранятся как JSON в БД) */
export interface KnowledgeNodeMetadata {
  content?: string;
  full_content?: string;
  decision_id?: number;
  title?: string;
  status?: string;
  category?: string;
  language?: string;
  lines_of_code?: number;
  complexity?: { cyclomatic: number; cognitive: number };
  last_modified?: number;
  last_modified_by_session?: string;
  git?: {
    last_commit_hash: string;
    last_commit_author: string;
    first_seen_commit: string;
  };
  exports?: string[];
  imports?: string[];
  test_coverage?: number;
  dependencies?: string[];
}

/** knowledge_edges — рёбра (связи) графа знаний */
export interface KnowledgeEdge {
  id: number;
  sourceId: number;
  targetId: number;
  edgeType: EdgeType;
  weight: number;
  evidenceCount: number;
  firstSeen: number;
  lastSeen: number;
}

/** developer_events — события разработчика */
export interface DeveloperEvent {
  id: number;
  eventType: DevEventType;
  sessionId: string | null;
  filePath: string | null;
  metadata: Record<string, unknown> | null;
  timestamp: number;
}

/** analytics_cache — кеш предвычисленной аналитики */
export interface AnalyticsCache {
  id: number;
  cacheKey: string;
  cacheData: unknown;
  computedAt: number;
  validUntil: number | null;
  computationTimeMs: number | null;
}

/** tasks — явная цель агента и её жизненный цикл. */
export interface AgentTask {
  id: string;
  projectRoot: string;
  sessionId: string | null;
  title: string;
  goal: string;
  status: TaskStatus;
  priority: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  metadata: Record<string, unknown> | null;
}

/** task_steps — атомарные проверяемые шаги внутри задачи. */
export interface TaskStep {
  id: string;
  taskId: string;
  title: string;
  status: TaskStepStatus;
  position: number;
  blockedBy: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  metadata: Record<string, unknown> | null;
}

/** evidence — журнал утверждений и их проверяемых источников. */
export interface EvidenceRecord {
  id: string;
  projectRoot: string;
  taskId: string | null;
  sessionId: string | null;
  claim: string;
  evidenceType: string;
  source: string;
  status: EvidenceStatus;
  confidence: number;
  details: string | null;
  createdAt: number;
  verifiedAt: number | null;
}

/** failure_memory — опыт неудачных попыток и запреты на повторение. */
export interface FailureMemory {
  id: string;
  projectRoot: string;
  taskId: string | null;
  sessionId: string | null;
  hypothesis: string;
  action: string;
  failure: string;
  rootCause: string | null;
  resolution: string | null;
  doNotRepeat: string | null;
  signature: string | null;
  status: "open" | "resolved" | "dismissed";
  createdAt: number;
  resolvedAt: number | null;
  metadata: Record<string, unknown> | null;
}

/** change_contracts — границы разрешённых изменений и план проверки. */
export interface ChangeContract {
  id: string;
  projectRoot: string;
  taskId: string | null;
  sessionId: string | null;
  goal: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  plannedPaths: string[];
  verificationPlan: string[];
  status: "active" | "passed" | "violated" | "closed";
  violations: string[];
  createdAt: number;
  updatedAt: number;
}

/** contradiction_records — явно замеченные несовместимые утверждения. */
export interface ContradictionRecord {
  id: string;
  projectRoot: string;
  taskId: string | null;
  claimA: string;
  sourceA: string;
  claimB: string;
  sourceB: string;
  severity: "low" | "medium" | "high" | "critical";
  status: "open" | "resolved" | "accepted";
  resolution: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

/** ProvenanceEvent — происхождение входа для защиты контекста от prompt injection. */
export interface ProvenanceEvent {
  id: number;
  projectRoot: string;
  sessionId: string | null;
  sourceType: "user" | "system" | "file" | "tool_output" | "memory" | "external";
  sourceRef: string;
  contentHash: string;
  trustLevel: TrustLevel;
  flags: string[];
  snippet: string | null;
  createdAt: number;
}

/** AgentHandoff — компактный снимок состояния для продолжения работы другим агентом. */
export interface AgentHandoff {
  id: string;
  projectRoot: string;
  taskId: string | null;
  sessionId: string | null;
  summary: string;
  nextAction: string;
  payload: Record<string, unknown>;
  status: "open" | "claimed" | "completed";
  createdAt: number;
  completedAt: number | null;
}

// ---------------------------------------------------------------------------
// Аналитические типы
// ---------------------------------------------------------------------------

/** Элемент тепловой карты (hotspot) — проблемный файл */
export interface HotspotEntry {
  filePath: string;
  score: number; // 0–100
  rank: number;
  breakdown: {
    editFrequency: number; // 0–1 нормализованный
    errorRate: number; // 0–1 нормализованный
    recentChanges: number; // 0–1 нормализованный
    developerFrustration: number; // 0–1 нормализованный
  };
  stats: {
    totalEdits: number;
    totalErrors: number;
    totalReverts: number;
    lastEditedAt: number | null;
  };
  explanation: string; // Человекочитаемое объяснение
}

/** Результат предиктивного анализа риска */
export interface PredictionResult {
  riskScore: number; // 0.0 — 1.0
  riskLevel: RiskLevel;
  primaryFile: string;
  affectedFiles: Array<{
    path: string;
    riskContribution: number;
    relationType: string;
    breakageProbability: number; // 0–1
  }>;
  recentSimilarChanges: Array<{
    file: string;
    date: string;
    result: string;
  }>;
  dependencyCount: number;
  historicalBreakageRate: number;
  recommendation: string;
}

/** Одна запись в истории изменений файла */
export interface FileHistoryEntry {
  sessionId: string;
  timestamp: number;
  agentType: AgentType;
  editType: EditType;
  linesAdded: number;
  linesRemoved: number;
  associatedErrors: number;
}

/** Временной срез истории файла */
export interface FileHistoryTimeline {
  period: string; // "7d", "30d", "90d", "all"
  editCount: number;
  errorCount: number;
  revertCount: number;
  topContributors: Array<{ sessionId: string; editCount: number }>;
}

/** Полная история файла */
export interface FileHistory {
  filePath: string;
  totalEdits: number;
  firstEditAt: number;
  lastEditAt: number;
  edits: FileHistoryEntry[];
  timeline: FileHistoryTimeline[];
}

/** Статистика разработчика (dev stats) */
export interface DevStats {
  sessionsPerDay: number;
  avgSessionDurationMs: number;
  toolUsageDistribution: Record<string, number>;
  topFiles: Array<{ path: string; edits: number }>;
  aiRelianceRatio: number; // 0–1
  fixRate: number; // 0–1
}

/** Тренд метрики разработчика */
export interface DevTrend {
  sessionsTrend: "improving" | "stable" | "declining";
  fixRateTrend: "improving" | "stable" | "declining";
  productivityTrend: "improving" | "stable" | "declining";
}

/** Достижение разработчика (для Developer Wrapped) */
export interface DevAchievement {
  title: string;
  description: string;
  icon: string;
  unlockedAt: number;
}

/** Пульс команды / здоровье проекта */
export interface TeamPulse {
  projectHealthScore: number; // 0–1
  trend: "improving" | "stable" | "declining";
  totalFiles: number;
  activeFiles: number;
  hotspotCount: number;
  aiRelianceRatio: number;
  errorRate: number;
  topConcern: string;
  healthOverTime: Array<{ month: string; score: number }>;
  moduleBreakdown: Array<{
    module: string;
    healthScore: number;
    files: number;
    hotspot: string | null;
  }>;
}

/** Точка на графике здоровья проекта */
export interface HealthPoint {
  timestamp: number;
  score: number;
  activeErrors: number;
  resolvedErrors: number;
}

/** Граф зависимостей (для AI-тулза dependency_graph) */
export interface DependencyGraph {
  rootFile?: string;
  nodes: Array<{
    id: string;
    label: string;
    type: "file" | "module" | "concept";
    hotspotScore?: number;
  }>;
  edges: Array<{
    source: string;
    target: string;
    relation: EdgeType;
    weight: number;
  }>;
  graphSummary: string;
}

/** Результат поиска по графу знаний */
export interface KnowledgeSearchResult {
  source: "memory" | "decision" | "file_history" | "analytics";
  type: string;
  id: string;
  label: string;
  description: string;
  relevanceScore: number;
  metadata: Record<string, unknown>;
  updatedAt: number | null;
  relatedNodes: string[];
}

/** Элемент долговременной памяти */
export interface MemoryItem {
  nodeId: string;
  category: MemoryCategory;
  content: string;
  tags: string[];
  sessionId: string;
  createdAt: number;
  updatedAt: number;
}

/** Заметка-напоминание */
export interface NoteItem {
  noteId: string;
  content: string;
  surfaceCondition: string | null;
  status: "active" | "dismissed" | "ready";
  sessionId: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Конфигурация и инфраструктура
// ---------------------------------------------------------------------------

/** Конфигурация плагина Code Shadow */
export interface ShadowConfig {
  /** Путь к файлу базы данных (поддерживает ~ для HOME) */
  dbPath: string;
  /** Срок хранения сырых событий (дни) */
  retentionDays: number;
  /** Срок хранения сводок сессий (дни) */
  sessionRetentionDays: number;
  /** Размер пакета для буферизованной записи */
  batchSize: number;
  /** Интервал сброса буфера записи (мс) */
  flushIntervalMs: number;
  /** Порог риска для показа предупреждения (0.0 — 1.0) */
  riskWarningThreshold: number;
  /** Порог риска для показа ошибки (0.0 — 1.0) */
  riskErrorThreshold: number;
  /** Интервал пересчёта аналитики (мс) */
  analyticsRecomputeIntervalMs: number;
  /** Максимальная длина сохраняемого диффа (символов) */
  maxDiffPreviewChars: number;
  /** Максимальная длина сохраняемых аргументов тулзов (символов) */
  maxArgsPreviewChars: number;
  /** Отключённые типы событий (пустой массив = все включены) */
  disabledEventTypes: string[];
  /** Паттерны для фильтрации секретов из данных */
  secretPatterns: string[];
}

/** Элемент очереди пакетной записи */
export interface BatchQueueItem {
  table: string;
  row: Record<string, unknown>;
}

/** Запись лога */
export interface LogEntry {
  timestamp: number;
  level: "debug" | "info" | "warn" | "error";
  namespace: string;
  message: string;
  data?: unknown;
}

// =============================================================================
// Вспомогательные типы
// =============================================================================

/** Функция маппинга snake_case → camelCase */
export type SnakeToCamel<T extends string> =
  T extends `${infer P}_${infer R}`
    ? `${P}${Capitalize<SnakeToCamel<R>>}`
    : T;

/** Функция маппинга camelCase → snake_case */
export type CamelToSnake<T extends string> =
  T extends `${infer P}${infer R}`
    ? P extends Capitalize<P>
      ? `_${Lowercase<P>}${CamelToSnake<R>}`
      : `${P}${CamelToSnake<R>}`
    : T;

// =============================================================================
// Утилитарные экспорты — все таблицы БД, все аналитические типы, все enum'ы
// Экспортированы выше.
// =============================================================================
