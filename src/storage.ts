// =============================================================================
// Code Shadow — SQLite Storage Engine
// Основной слой работы с базой данных: миграции, CRUD, пакетная запись, утилиты.
// Соглашение: поля БД — snake_case, TypeScript-свойства — camelCase.
// =============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Database } from "bun:sqlite";
import type { ShadowConfig } from "./types";
import {
  AgentType,
  SessionStatus,
  EditType,
  ToolStatus,
  ErrorType,
  NodeType,
  EdgeType,
  DevEventType,
} from "./types";
import type {
  FileEdit,
  Session,
  SessionError,
  ToolExecution,
  Decision,
  KnowledgeNode,
  KnowledgeEdge,
  DeveloperEvent,
  AnalyticsCache,
  BatchQueueItem,
  AgentTask,
  TaskStep,
  EvidenceRecord,
  FailureMemory,
  ChangeContract,
  ContradictionRecord,
  ProvenanceEvent,
  AgentHandoff,
} from "./types";
import { resolvePath } from "./config";
import { createLogger } from "./logger";
import { migrateV001Initial } from "./migrations/001_initial";
import { migrateV002FixEventTypes } from "./migrations/002_fix_event_types";
import { migrateV003LspErrorType } from "./migrations/003_lsp_error_type";
import { migrateV004ExploreAgentType } from "./migrations/004_explore_agent_type";
import { migrateV005AddTodos } from "./migrations/005_add_todos";
import { migrateV006AgentNative } from "./migrations/006_agent_native";

// ---------------------------------------------------------------------------
// Логгер
// ---------------------------------------------------------------------------

const log = createLogger("storage");

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------

/** Простой 32-битный хеш строки (DJB2) для дедупликации диффов. */
function hashString(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash; // 32-bit
  }
  return (hash >>> 0).toString(16);
}

/**
 * Преобразует строковой timeframe ("7d", "30d", "90d", "all")
 * в Unix-timestamp отсечки (мс). Возвращает null если timeframe отсутствует.
 */
function timeframeToCutoff(timeframe?: string): number | null {
  if (!timeframe || timeframe === "all") return null;
  const match = timeframe.match(/^(\d+)d$/);
  if (match) {
    const days = parseInt(match[1], 10);
    return Date.now() - days * 24 * 60 * 60 * 1000;
  }
  const numeric = parseInt(timeframe, 10);
  if (!isNaN(numeric)) return numeric;
  return null;
}

/**
 * Вычисляет количество дней в переданном timeframe для нормализации "per day".
 * Если timeframe не указан, использует разницу между первой и последней правкой.
 */
function daysInTimeframe(timeframe?: string, fallbackDays?: number): number {
  if (timeframe && timeframe !== "all") {
    const match = timeframe.match(/^(\d+)d$/);
    if (match) return parseInt(match[1], 10);
  }
  return fallbackDays && fallbackDays > 0 ? fallbackDays : 1;
}

/**
 * Генерирует уникальный идентификатор сессии (UUID v4).
 */
function generateSessionId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Интерфейс строк БД в snake_case (сырые данные из SQLite)
// ---------------------------------------------------------------------------

interface FileEditRow {
  id: number;
  file_path: string;
  session_id: string;
  agent_type: string;
  edit_type: string;
  diff_preview: string | null;
  lines_added: number;
  lines_removed: number;
  timestamp: number;
  project_root: string;
  was_reverted: number;
  file_language: string | null;
  diff_hash: string | null;
}

interface SessionRow {
  id: string;
  agent_type: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  files_changed_count: number;
  tools_used_count: number;
  errors_count: number;
  project_root: string;
  message_count: number;
  total_tokens_used: number;
  compacted_from: string | null;
}

interface SessionErrorRow {
  id: number;
  session_id: string;
  error_type: string;
  error_message: string;
  error_stack: string | null;
  context_file: string | null;
  context_tool: string | null;
  timestamp: number;
  resolved: number;
}

interface ToolExecutionRow {
  id: number;
  session_id: string;
  tool_name: string;
  target_file: string | null;
  args_preview: string | null;
  status: string;
  duration_ms: number | null;
  timestamp: number;
  result_size_bytes: number | null;
}

interface DecisionRow {
  id: number;
  title: string;
  description: string;
  context: string | null;
  alternatives: string | null;
  status: string;
  decided_by: string | null;
  decided_at: number;
  superseded_by: number | null;
  related_files: string | null;
  tags: string | null;
}

interface KnowledgeNodeRow {
  id: number;
  node_type: string;
  name: string;
  path: string | null;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

interface KnowledgeEdgeRow {
  id: number;
  source_id: number;
  target_id: number;
  edge_type: string;
  weight: number;
  evidence_count: number;
  first_seen: number;
  last_seen: number;
}

interface DeveloperEventRow {
  id: number;
  event_type: string;
  session_id: string | null;
  file_path: string | null;
  metadata: string | null;
  timestamp: number;
}

interface AnalyticsCacheRow {
  id: number;
  cache_key: string;
  cache_data: string;
  computed_at: number;
  valid_until: number | null;
  computation_time_ms: number | null;
}

// ---------------------------------------------------------------------------
// Преобразователи строк БД → объекты TypeScript (snake_case → camelCase)
// ---------------------------------------------------------------------------

function rowToFileEdit(row: FileEditRow): FileEdit {
  return {
    id: row.id,
    filePath: row.file_path,
    sessionId: row.session_id,
    agentType: row.agent_type as AgentType,
    editType: row.edit_type as EditType,
    diffPreview: row.diff_preview,
    linesAdded: row.lines_added,
    linesRemoved: row.lines_removed,
    timestamp: row.timestamp,
    projectRoot: row.project_root,
    wasReverted: row.was_reverted === 1,
    fileLanguage: row.file_language,
  };
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    agentType: row.agent_type as AgentType,
    status: row.status as SessionStatus,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    filesChangedCount: row.files_changed_count,
    toolsUsedCount: row.tools_used_count,
    errorsCount: row.errors_count,
    projectRoot: row.project_root,
    messageCount: row.message_count,
    totalTokensUsed: row.total_tokens_used,
    compactedFrom: row.compacted_from,
  };
}

function rowToSessionError(row: SessionErrorRow): SessionError {
  return {
    id: row.id,
    sessionId: row.session_id,
    errorType: row.error_type as ErrorType,
    errorMessage: row.error_message,
    errorStack: row.error_stack,
    contextFile: row.context_file,
    contextTool: row.context_tool,
    timestamp: row.timestamp,
    resolved: row.resolved === 1,
  };
}

function rowToToolExecution(row: ToolExecutionRow): ToolExecution {
  return {
    id: row.id,
    sessionId: row.session_id,
    toolName: row.tool_name,
    targetFile: row.target_file,
    argsPreview: row.args_preview,
    status: row.status as ToolStatus,
    durationMs: row.duration_ms,
    timestamp: row.timestamp,
    resultSizeBytes: row.result_size_bytes,
  };
}

function rowToDecision(row: DecisionRow): Decision {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    context: row.context,
    alternatives: row.alternatives ? JSON.parse(row.alternatives) : null,
    status: row.status as Decision["status"],
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    supersededBy: row.superseded_by,
    relatedFiles: row.related_files ? JSON.parse(row.related_files) : null,
    tags: row.tags ? JSON.parse(row.tags) : null,
  };
}

function rowToKnowledgeNode(row: KnowledgeNodeRow): KnowledgeNode {
  return {
    id: row.id,
    nodeType: row.node_type as NodeType,
    name: row.name,
    path: row.path,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToKnowledgeEdge(row: KnowledgeEdgeRow): KnowledgeEdge {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    edgeType: row.edge_type as EdgeType,
    weight: row.weight,
    evidenceCount: row.evidence_count,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  };
}

function rowToDeveloperEvent(row: DeveloperEventRow): DeveloperEvent {
  return {
    id: row.id,
    eventType: row.event_type as DevEventType,
    sessionId: row.session_id,
    filePath: row.file_path,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    timestamp: row.timestamp,
  };
}

// ---------------------------------------------------------------------------
// StorageEngine — основной класс работы с БД
// ---------------------------------------------------------------------------

export class StorageEngine {
  private db: Database | null = null;
  private config: ShadowConfig;
  private dbPath: string;
  public batchQueue: BatchQueueItem[];

  constructor(config: ShadowConfig) {
    this.config = config;
    this.dbPath = resolvePath(config.dbPath);
    this.batchQueue = [];
    this.initDatabase();
  }

  // =========================================================================
  // Инициализация базы данных
  // =========================================================================

  /** Открывает базу данных, выполняет ожидающие миграции. */
  initDatabase(): void {
    try {
      // Создаём директорию, если не существует
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        log.info(`Создана директория БД: ${dir}`);
      }

      this.db = new Database(this.dbPath, { create: true, strict: true });

      // Глобальные настройки
      this.db.run("PRAGMA journal_mode = WAL");
      this.db.run("PRAGMA busy_timeout = 5000");
      this.db.run("PRAGMA foreign_keys = ON");

      log.info(`База данных открыта: ${this.dbPath}`);

      // Запуск миграций
      this.runMigrations();
    } catch (err) {
      log.error(`Ошибка инициализации БД: ${String(err)}`);
      this.db = null;
    }
  }

  /** Проверяет текущую версию схемы и применяет непройденные миграции. */
  runMigrations(): void {
    if (!this.db) {
      log.error("runMigrations: база данных не открыта");
      return;
    }

    try {
      // Проверяем существование таблицы schema_version
      const tableCheck = this.db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`,
        )
        .get() as { name: string } | undefined;

      let currentVersion = 0;

      if (tableCheck) {
        const row = this.db
          .prepare(`SELECT MAX(version) as version FROM schema_version`)
          .get() as { version: number | null } | undefined;
        currentVersion = row?.version ?? 0;
      }

      log.debug(`Текущая версия схемы: ${currentVersion}`);

      // Применяем миграции по порядку
      if (currentVersion < 1) {
        log.info("Применяю миграцию 001 (начальная схема)...");
        migrateV001Initial(this.db);
      }

      if (currentVersion < 2) {
        log.info("Применяю миграцию 002 (исправление CHECK developer_events)...");
        migrateV002FixEventTypes(this.db);
      }

      if (currentVersion < 3) {
        log.info("Применяю миграцию 003 (добавление lsp в session_errors)...");
        migrateV003LspErrorType(this.db);
      }

      if (currentVersion < 4) {
        log.info("Применяю миграцию 004 (добавление 'explore' agent type)...");
        migrateV004ExploreAgentType(this.db);
      }

      if (currentVersion < 5) {
        log.info("Применяю миграцию 005 (добавление таблицы todos)...");
        migrateV005AddTodos(this.db);
      }

      if (currentVersion < 6) {
        log.info("Применяю миграцию 006 (agent-native память)...");
        migrateV006AgentNative(this.db);
      }

      log.info("Все миграции применены.");
    } catch (err) {
      log.error(`Ошибка миграции: ${String(err)}`);
    }
  }

  /** Закрывает соединение с базой данных. */
  close(): void {
    try {
      this.flushBatch();
      if (this.db) {
        this.db.close();
        this.db = null;
        log.info("Соединение с БД закрыто.");
      }
    } catch (err) {
      log.error(`Ошибка закрытия БД: ${String(err)}`);
    }
  }

  /** Возвращает экземпляр БД, выбрасывает если не инициализирован. */
  getDb(): Database {
    if (!this.db) {
      throw new Error("База данных не инициализирована");
    }
    return this.db;
  }

  // =========================================================================
  // CRUD: file_edits
  // =========================================================================

  /** Вставляет запись о редактировании файла. Возвращает id новой записи. */
  insertFileEdit(edit: Omit<FileEdit, "id">): number {
    try {
      const db = this.getDb();
      const diffHash = edit.diffPreview
        ? hashString(edit.diffPreview)
        : null;

      const result = db
        .prepare(
          `INSERT INTO file_edits
            (file_path, session_id, agent_type, edit_type, diff_preview,
             lines_added, lines_removed, timestamp, project_root,
             was_reverted, file_language, diff_hash)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
        )
        .run(
          edit.filePath,
          edit.sessionId,
          edit.agentType,
          edit.editType,
          edit.diffPreview,
          edit.linesAdded,
          edit.linesRemoved,
          edit.timestamp,
          edit.projectRoot,
          edit.wasReverted ? 1 : 0,
          edit.fileLanguage,
          diffHash,
        );

      log.debug(`file_edit вставлен: id=${result.lastInsertRowid}, файл=${edit.filePath}`);
      return Number(result.lastInsertRowid);
    } catch (err) {
      log.error(`Ошибка insertFileEdit: ${String(err)}`);
      return -1;
    }
  }

  /** Возвращает список правок файла с опциональным фильтром по времени. */
  getFileEdits(filePath: string, timeframe?: string): FileEdit[] {
    try {
      const db = this.getDb();
      const cutoff = timeframeToCutoff(timeframe);

      let query = `SELECT * FROM file_edits WHERE file_path = ?1`;
      const params: (string | number)[] = [filePath];

      if (cutoff !== null) {
        query += ` AND timestamp >= ?2`;
        params.push(cutoff);
      }

      query += ` ORDER BY timestamp DESC`;
      const rows = db.prepare(query).all(...params) as FileEditRow[];
      return rows.map(rowToFileEdit);
    } catch (err) {
      log.error(`Ошибка getFileEdits: ${String(err)}`);
      return [];
    }
  }

  /** Возвращает количество правок файла. */
  getFileEditCount(filePath: string, timeframe?: string): number {
    try {
      const db = this.getDb();
      const cutoff = timeframeToCutoff(timeframe);

      let query = `SELECT COUNT(*) as cnt FROM file_edits WHERE file_path = ?1`;
      const params: (string | number)[] = [filePath];

      if (cutoff !== null) {
        query += ` AND timestamp >= ?2`;
        params.push(cutoff);
      }

      const row = db.prepare(query).get(...params) as { cnt: number };
      return row.cnt;
    } catch (err) {
      log.error(`Ошибка getFileEditCount: ${String(err)}`);
      return 0;
    }
  }

  /** Возвращает количество откаченных правок файла (was_reverted = 1). */
  getRevertedEditCount(filePath: string, timeframe?: string): number {
    try {
      const db = this.getDb();
      const cutoff = timeframeToCutoff(timeframe);

      let query = `SELECT COUNT(*) as cnt FROM file_edits WHERE file_path = ?1 AND was_reverted = 1`;
      const params: (string | number)[] = [filePath];

      if (cutoff !== null) {
        query += ` AND timestamp >= ?2`;
        params.push(cutoff);
      }

      const row = db.prepare(query).get(...params) as { cnt: number };
      return row.cnt;
    } catch (err) {
      log.error(`Ошибка getRevertedEditCount: ${String(err)}`);
      return 0;
    }
  }

  /** Помечает правку как откаченную (устанавливает was_reverted = 1). */
  markReverted(editId: number): void {
    try {
      const db = this.getDb();
      db.prepare(`UPDATE file_edits SET was_reverted = 1 WHERE id = ?1`).run(
        editId,
      );
      log.debug(`Правка помечена как откаченная: id=${editId}`);
    } catch (err) {
      log.error(`Ошибка markReverted: ${String(err)}`);
    }
  }

  // =========================================================================
  // CRUD: sessions
  // =========================================================================

  /** Вставляет новую сессию. */
  insertSession(session: Omit<Session, "id">): void {
    try {
      const db = this.getDb();
      const fullSession = session as Record<string, unknown>;
      const id =
        (fullSession.id as string) || generateSessionId();

      db.prepare(
        `INSERT INTO sessions
          (id, agent_type, status, started_at, ended_at, duration_ms,
           files_changed_count, tools_used_count, errors_count,
           project_root, message_count, total_tokens_used, compacted_from)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      ).run(
        id,
        session.agentType,
        session.status,
        session.startedAt,
        session.endedAt ?? null,
        session.durationMs ?? null,
        session.filesChangedCount,
        session.toolsUsedCount,
        session.errorsCount,
        session.projectRoot,
        session.messageCount,
        session.totalTokensUsed,
        session.compactedFrom ?? null,
      );

      log.debug(`Сессия вставлена: id=${id}`);
    } catch (err) {
      log.error(`Ошибка insertSession: ${String(err)}`);
    }
  }

  /** Обновляет статус сессии и опционально другие поля. */
  updateSessionStatus(
    id: string,
    status: SessionStatus,
    extra?: Partial<Session>,
  ): void {
    try {
      const db = this.getDb();

      const updates: string[] = ["status = ?1"];
      const params: unknown[] = [status];

      if (extra) {
        if (extra.endedAt !== undefined) {
          updates.push("ended_at = ?");
          params.push(extra.endedAt);
        }
        if (extra.durationMs !== undefined) {
          updates.push("duration_ms = ?");
          params.push(extra.durationMs);
        }
        if (extra.filesChangedCount !== undefined) {
          updates.push("files_changed_count = ?");
          params.push(extra.filesChangedCount);
        }
        if (extra.toolsUsedCount !== undefined) {
          updates.push("tools_used_count = ?");
          params.push(extra.toolsUsedCount);
        }
        if (extra.errorsCount !== undefined) {
          updates.push("errors_count = ?");
          params.push(extra.errorsCount);
        }
        if (extra.messageCount !== undefined) {
          updates.push("message_count = ?");
          params.push(extra.messageCount);
        }
        if (extra.totalTokensUsed !== undefined) {
          updates.push("total_tokens_used = ?");
          params.push(extra.totalTokensUsed);
        }
        if (extra.compactedFrom !== undefined) {
          updates.push("compacted_from = ?");
          params.push(extra.compactedFrom);
        }
      }

      params.push(id);
      db.prepare(
        `UPDATE sessions SET ${updates.join(", ")} WHERE id = ?`,
      ).run(...(params as any));

      log.debug(`Сессия обновлена: id=${id}, status=${status}`);
    } catch (err) {
      log.error(`Ошибка updateSessionStatus: ${String(err)}`);
    }
  }

  /** Возвращает сессию по идентификатору. */
  getSession(id: string): Session | undefined {
    try {
      const db = this.getDb();
      const row = db
        .prepare(`SELECT * FROM sessions WHERE id = ?1`)
        .get(id) as SessionRow | undefined;
      return row ? rowToSession(row) : undefined;
    } catch (err) {
      log.error(`Ошибка getSession: ${String(err)}`);
      return undefined;
    }
  }

  /** Возвращает последние сессии в рамках проекта. */
  getRecentSessions(projectRoot: string, limit = 10): Session[] {
    try {
      const db = this.getDb();
      const rows = db
        .prepare(
          `SELECT * FROM sessions WHERE project_root = ?1 ORDER BY started_at DESC LIMIT ?2`,
        )
        .all(projectRoot, limit) as SessionRow[];
      return rows.map(rowToSession);
    } catch (err) {
      log.error(`Ошибка getRecentSessions: ${String(err)}`);
      return [];
    }
  }

  // =========================================================================
  // CRUD: session_errors
  // =========================================================================

  /** Вставляет запись об ошибке сессии. Возвращает id. */
  insertError(error: Omit<SessionError, "id">): number {
    try {
      const db = this.getDb();
      const result = db
        .prepare(
          `INSERT INTO session_errors
            (session_id, error_type, error_message, error_stack,
             context_file, context_tool, timestamp, resolved)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        )
        .run(
          error.sessionId,
          error.errorType,
          error.errorMessage,
          error.errorStack ?? null,
          error.contextFile ?? null,
          error.contextTool ?? null,
          error.timestamp,
          error.resolved ? 1 : 0,
        );

      log.debug(
        `Ошибка сессии вставлена: id=${result.lastInsertRowid}, тип=${error.errorType}`,
      );
      return Number(result.lastInsertRowid);
    } catch (err) {
      log.error(`Ошибка insertError: ${String(err)}`);
      return -1;
    }
  }

  /** Возвращает ошибки, связанные с указанным файлом. */
  getErrorsForFile(filePath: string, timeframe?: string): SessionError[] {
    try {
      const db = this.getDb();
      const cutoff = timeframeToCutoff(timeframe);

      let query = `SELECT * FROM session_errors WHERE context_file = ?1`;
      const params: (string | number)[] = [filePath];

      if (cutoff !== null) {
        query += ` AND timestamp >= ?2`;
        params.push(cutoff);
      }

      query += ` ORDER BY timestamp DESC`;
      const rows = db.prepare(query).all(...params) as SessionErrorRow[];
      return rows.map(rowToSessionError);
    } catch (err) {
      log.error(`Ошибка getErrorsForFile: ${String(err)}`);
      return [];
    }
  }

  /** Возвращает количество ошибок, связанных с указанным файлом. */
  getErrorCountForFile(filePath: string, timeframe?: string): number {
    try {
      const db = this.getDb();
      const cutoff = timeframeToCutoff(timeframe);

      let query = `SELECT COUNT(*) as cnt FROM session_errors WHERE context_file = ?1`;
      const params: (string | number)[] = [filePath];

      if (cutoff !== null) {
        query += ` AND timestamp >= ?2`;
        params.push(cutoff);
      }

      const row = db.prepare(query).get(...params) as { cnt: number };
      return row.cnt;
    } catch (err) {
      log.error(`Ошибка getErrorCountForFile: ${String(err)}`);
      return 0;
    }
  }

  /** Помечает ошибку как исправленную (resolved = 1). */
  markErrorResolved(id: number): void {
    try {
      const db = this.getDb();
      db.prepare(`UPDATE session_errors SET resolved = 1 WHERE id = ?1`).run(id);
      log.debug(`Ошибка помечена как исправленная: id=${id}`);
    } catch (err) {
      log.error(`Ошибка markErrorResolved: ${String(err)}`);
    }
  }

  /**
   * Упрощённая запись ошибки — для LSP-диагностики и других event-based источников.
   * Поля location и metadata сериализуются в error_stack.
   */
  recordError(error: {
    sessionId?: string | null
    errorType: string
    errorMessage: string
    contextFile?: string | null
    location?: string
    metadata?: string
  }): number {
    if (!error.sessionId || !this.getSession(error.sessionId)) {
      log.warn(`Ошибка ${error.errorType} пропущена: неизвестная сессия`)
      return -1
    }

    const extraData: Record<string, unknown> = {}
    if (error.location) extraData.location = error.location
    if (error.metadata) {
      try { Object.assign(extraData, JSON.parse(error.metadata)) } catch { extraData.raw_metadata = error.metadata }
    }

    return this.insertError({
      sessionId: error.sessionId || "",
      errorType: error.errorType as ErrorType,
      errorMessage: error.errorMessage,
      errorStack: Object.keys(extraData).length > 0 ? JSON.stringify(extraData) : null,
      contextFile: error.contextFile ?? null,
      contextTool: "lsp",
      timestamp: Date.now(),
      resolved: false,
    })
  }

  /** Выполняет произвольный SQL-запрос и возвращает строки. */
  queryRows<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): T[] {
    try {
      const db = this.getDb()
      return db.prepare(sql).all(...params) as T[]
    } catch (err) {
      log.error(`queryRows error: ${String(err)}, SQL: ${sql.substring(0, 100)}, params: ${JSON.stringify(params)}`)
      return []
    }
  }

  // =========================================================================
  // Agent-native memory: Task Graph / Evidence / Failure / Contracts
  // =========================================================================

  private json(value: unknown): string {
    return JSON.stringify(value ?? null)
  }

  private parseJson<T>(value: string | null | undefined, fallback: T): T {
    if (!value) return fallback
    try { return JSON.parse(value) as T } catch { return fallback }
  }

  private taskRow(row: Record<string, any>): AgentTask {
    return {
      id: row.id, projectRoot: row.project_root, sessionId: row.session_id,
      title: row.title, goal: row.goal, status: row.status,
      priority: row.priority, createdAt: row.created_at, updatedAt: row.updated_at,
      completedAt: row.completed_at, metadata: this.parseJson(row.metadata, null),
    }
  }

  private stepRow(row: Record<string, any>): TaskStep {
    return {
      id: row.id, taskId: row.task_id, title: row.title, status: row.status,
      position: row.position, blockedBy: row.blocked_by, createdAt: row.created_at,
      updatedAt: row.updated_at, completedAt: row.completed_at,
      metadata: this.parseJson(row.metadata, null),
    }
  }

  private evidenceRow(row: Record<string, any>): EvidenceRecord {
    return {
      id: row.id, projectRoot: row.project_root, taskId: row.task_id,
      sessionId: row.session_id, claim: row.claim, evidenceType: row.evidence_type,
      source: row.source, status: row.status, confidence: row.confidence,
      details: row.details, createdAt: row.created_at, verifiedAt: row.verified_at,
    }
  }

  private failureRow(row: Record<string, any>): FailureMemory {
    return {
      id: row.id, projectRoot: row.project_root, taskId: row.task_id,
      sessionId: row.session_id, hypothesis: row.hypothesis, action: row.action,
      failure: row.failure, rootCause: row.root_cause, resolution: row.resolution,
      doNotRepeat: row.do_not_repeat, signature: row.signature, status: row.status,
      createdAt: row.created_at, resolvedAt: row.resolved_at,
      metadata: this.parseJson(row.metadata, null),
    }
  }

  private contractRow(row: Record<string, any>): ChangeContract {
    return {
      id: row.id, projectRoot: row.project_root, taskId: row.task_id,
      sessionId: row.session_id, goal: row.goal,
      allowedPaths: this.parseJson(row.allowed_paths, []),
      forbiddenPaths: this.parseJson(row.forbidden_paths, []),
      plannedPaths: this.parseJson(row.planned_paths, []),
      verificationPlan: this.parseJson(row.verification_plan, []),
      status: row.status, violations: this.parseJson(row.violations, []),
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  private contradictionRow(row: Record<string, any>): ContradictionRecord {
    return {
      id: row.id, projectRoot: row.project_root, taskId: row.task_id,
      claimA: row.claim_a, sourceA: row.source_a, claimB: row.claim_b,
      sourceB: row.source_b, severity: row.severity, status: row.status,
      resolution: row.resolution, createdAt: row.created_at, resolvedAt: row.resolved_at,
    }
  }

  createTask(input: Omit<AgentTask, "id" | "createdAt" | "updatedAt" | "completedAt"> & { id?: string }): AgentTask {
    const now = Date.now(), id = input.id || crypto.randomUUID()
    this.getDb().prepare(`INSERT INTO agent_tasks
      (id, project_root, session_id, title, goal, status, priority, created_at, updated_at, completed_at, metadata)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8,NULL,?9)`).run(
      id, input.projectRoot, input.sessionId ?? null, input.title, input.goal,
      input.status, input.priority ?? 50, now, this.json(input.metadata),
    )
    return this.getTask(id)!
  }

  getTask(id: string): AgentTask | undefined {
    const row = this.getDb().prepare(`SELECT * FROM agent_tasks WHERE id = ?1`).get(id) as Record<string, any> | undefined
    return row ? this.taskRow(row) : undefined
  }

  listTasks(projectRoot: string, status?: string, limit = 20): AgentTask[] {
    const sql = status
      ? `SELECT * FROM agent_tasks WHERE project_root = ?1 AND status = ?2 ORDER BY updated_at DESC LIMIT ?3`
      : `SELECT * FROM agent_tasks WHERE project_root = ?1 ORDER BY updated_at DESC LIMIT ?2`
    const rows = (status ? this.getDb().prepare(sql).all(projectRoot, status, limit) : this.getDb().prepare(sql).all(projectRoot, limit)) as Record<string, any>[]
    return rows.map((row) => this.taskRow(row))
  }

  updateTask(id: string, patch: Partial<Pick<AgentTask, "title" | "goal" | "status" | "priority" | "metadata">>): AgentTask | undefined {
    const fields: string[] = [], values: unknown[] = []
    for (const [key, value] of Object.entries(patch)) {
      const column = key === "metadata" ? "metadata" : key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)
      fields.push(`${column} = ?`); values.push(key === "metadata" ? this.json(value) : value)
    }
    if (patch.status === "completed") { fields.push("completed_at = ?"); values.push(Date.now()) }
    if (!fields.length) return this.getTask(id)
    fields.push("updated_at = ?"); values.push(Date.now(), id)
    this.getDb().prepare(`UPDATE agent_tasks SET ${fields.join(", ")} WHERE id = ?`).run(...(values as any[]))
    return this.getTask(id)
  }

  /** Проверяет Definition of Done, не меняя состояние задачи. */
  evaluateTaskDone(taskId: string): {
    ready: boolean
    blockers: string[]
    checks: Record<string, boolean | number>
  } {
    const task = this.getTask(taskId)
    if (!task) return { ready: false, blockers: ["task_not_found"], checks: {} }
    const steps = this.listTaskSteps(taskId)
    const evidence = this.listEvidence(task.projectRoot, taskId, 100)
    const failures = this.searchFailures(task.projectRoot, task.goal, 100).filter((item) => item.taskId === taskId && item.status === "open")
    const contracts = this.listChangeContracts(task.projectRoot, taskId)
    const contradictions = this.listContradictions(task.projectRoot, "open", 100).filter((item) => item.taskId === taskId || !item.taskId)
    const pendingSteps = steps.filter((step) => !["completed", "skipped"].includes(step.status)).length
    const verifiedEvidence = evidence.filter((item) => item.status === "verified").length
    const badContracts = contracts.filter((item) => ["active", "violated"].includes(item.status)).length
    const blockers: string[] = []
    if (steps.length === 0) blockers.push("no_steps")
    if (pendingSteps > 0) blockers.push(`pending_steps:${pendingSteps}`)
    if (verifiedEvidence === 0) blockers.push("no_verified_evidence")
    if (failures.length > 0) blockers.push(`open_failures:${failures.length}`)
    if (badContracts > 0) blockers.push(`unclosed_contracts:${badContracts}`)
    if (contradictions.length > 0) blockers.push(`open_contradictions:${contradictions.length}`)
    return {
      ready: blockers.length === 0,
      blockers,
      checks: {
        steps: steps.length,
        pendingSteps,
        verifiedEvidence,
        openFailures: failures.length,
        unclosedContracts: badContracts,
        openContradictions: contradictions.length,
      },
    }
  }

  addTaskStep(input: Omit<TaskStep, "id" | "createdAt" | "updatedAt" | "completedAt"> & { id?: string }): TaskStep {
    const now = Date.now(), id = input.id || crypto.randomUUID()
    this.getDb().prepare(`INSERT INTO task_steps
      (id, task_id, title, status, position, blocked_by, created_at, updated_at, completed_at, metadata)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?7,NULL,?8)`).run(
      id, input.taskId, input.title, input.status, input.position,
      input.blockedBy ?? null, now, this.json(input.metadata),
    )
    return this.getTaskStep(id)!
  }

  getTaskStep(id: string): TaskStep | undefined {
    const row = this.getDb().prepare(`SELECT * FROM task_steps WHERE id = ?1`).get(id) as Record<string, any> | undefined
    return row ? this.stepRow(row) : undefined
  }

  listTaskSteps(taskId: string): TaskStep[] {
    return (this.getDb().prepare(`SELECT * FROM task_steps WHERE task_id = ?1 ORDER BY position, created_at`).all(taskId) as Record<string, any>[]).map((row) => this.stepRow(row))
  }

  updateTaskStep(id: string, status: string, blockedBy?: string | null): TaskStep | undefined {
    const completed = status === "completed" ? Date.now() : null
    this.getDb().prepare(`UPDATE task_steps SET status = ?1, blocked_by = ?2, completed_at = ?3, updated_at = ?4 WHERE id = ?5`).run(status, blockedBy ?? null, completed, Date.now(), id)
    return this.getTaskStep(id)
  }

  recordEvidence(input: Omit<EvidenceRecord, "id" | "createdAt" | "verifiedAt"> & { id?: string }): EvidenceRecord {
    const now = Date.now(), id = input.id || crypto.randomUUID()
    this.getDb().prepare(`INSERT INTO evidence_records
      (id, project_root, task_id, session_id, claim, evidence_type, source, status, confidence, details, created_at, verified_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`).run(
      id, input.projectRoot, input.taskId ?? null, input.sessionId ?? null, input.claim,
      input.evidenceType, input.source, input.status, Math.max(0, Math.min(1, input.confidence)),
      input.details ?? null, now, input.status === "verified" ? now : null,
    )
    return this.getEvidence(id)!
  }

  getEvidence(id: string): EvidenceRecord | undefined {
    const row = this.getDb().prepare(`SELECT * FROM evidence_records WHERE id = ?1`).get(id) as Record<string, any> | undefined
    return row ? this.evidenceRow(row) : undefined
  }

  listEvidence(projectRoot: string, taskId?: string, limit = 30): EvidenceRecord[] {
    const rows = taskId
      ? this.getDb().prepare(`SELECT * FROM evidence_records WHERE project_root = ?1 AND task_id = ?2 ORDER BY created_at DESC LIMIT ?3`).all(projectRoot, taskId, limit)
      : this.getDb().prepare(`SELECT * FROM evidence_records WHERE project_root = ?1 ORDER BY created_at DESC LIMIT ?2`).all(projectRoot, limit)
    return (rows as Record<string, any>[]).map((row) => this.evidenceRow(row))
  }

  updateEvidence(id: string, status: string, details?: string): EvidenceRecord | undefined {
    this.getDb().prepare(`UPDATE evidence_records SET status = ?1, details = COALESCE(?2, details), verified_at = CASE WHEN ?1 = 'verified' THEN ?3 ELSE verified_at END WHERE id = ?4`).run(status, details ?? null, Date.now(), id)
    return this.getEvidence(id)
  }

  recordFailure(input: Omit<FailureMemory, "id" | "createdAt" | "resolvedAt" | "status"> & { id?: string; status?: FailureMemory["status"] }): FailureMemory {
    const now = Date.now(), id = input.id || crypto.randomUUID()
    this.getDb().prepare(`INSERT INTO failure_memory
      (id, project_root, task_id, session_id, hypothesis, action, failure, root_cause, resolution, do_not_repeat, signature, status, created_at, resolved_at, metadata)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,NULL,?14)`).run(
      id, input.projectRoot, input.taskId ?? null, input.sessionId ?? null, input.hypothesis,
      input.action, input.failure, input.rootCause ?? null, input.resolution ?? null,
      input.doNotRepeat ?? null, input.signature ?? null, input.status || "open", now, this.json(input.metadata),
    )
    return this.getFailure(id)!
  }

  getFailure(id: string): FailureMemory | undefined {
    const row = this.getDb().prepare(`SELECT * FROM failure_memory WHERE id = ?1`).get(id) as Record<string, any> | undefined
    return row ? this.failureRow(row) : undefined
  }

  searchFailures(projectRoot: string, query?: string, limit = 20): FailureMemory[] {
    const pattern = query ? `%${query}%` : "%"
    const rows = this.getDb().prepare(`SELECT * FROM failure_memory
      WHERE project_root = ?1 AND (hypothesis LIKE ?2 OR action LIKE ?2 OR failure LIKE ?2 OR root_cause LIKE ?2 OR do_not_repeat LIKE ?2)
      ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at DESC LIMIT ?3`).all(projectRoot, pattern, limit) as Record<string, any>[]
    return rows.map((row) => this.failureRow(row))
  }

  resolveFailure(id: string, resolution: string, doNotRepeat?: string): FailureMemory | undefined {
    this.getDb().prepare(`UPDATE failure_memory SET status = 'resolved', resolution = ?1, do_not_repeat = COALESCE(?2, do_not_repeat), resolved_at = ?3 WHERE id = ?4`).run(resolution, doNotRepeat ?? null, Date.now(), id)
    return this.getFailure(id)
  }

  createChangeContract(input: Omit<ChangeContract, "id" | "createdAt" | "updatedAt" | "status" | "violations"> & { id?: string; status?: ChangeContract["status"] }): ChangeContract {
    const now = Date.now(), id = input.id || crypto.randomUUID()
    this.getDb().prepare(`INSERT INTO change_contracts
      (id, project_root, task_id, session_id, goal, allowed_paths, forbidden_paths, planned_paths, verification_plan, status, violations, created_at, updated_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'[]',?11,?11)`).run(
      id, input.projectRoot, input.taskId ?? null, input.sessionId ?? null, input.goal,
      this.json(input.allowedPaths), this.json(input.forbiddenPaths), this.json(input.plannedPaths),
      this.json(input.verificationPlan), input.status || "active", now,
    )
    return this.getChangeContract(id)!
  }

  getChangeContract(id: string): ChangeContract | undefined {
    const row = this.getDb().prepare(`SELECT * FROM change_contracts WHERE id = ?1`).get(id) as Record<string, any> | undefined
    return row ? this.contractRow(row) : undefined
  }

  listChangeContracts(projectRoot: string, taskId?: string): ChangeContract[] {
    const rows = taskId
      ? this.getDb().prepare(`SELECT * FROM change_contracts WHERE project_root = ?1 AND task_id = ?2 ORDER BY updated_at DESC`).all(projectRoot, taskId)
      : this.getDb().prepare(`SELECT * FROM change_contracts WHERE project_root = ?1 ORDER BY updated_at DESC`).all(projectRoot)
    return (rows as Record<string, any>[]).map((row) => this.contractRow(row))
  }

  updateChangeContract(id: string, patch: Partial<Pick<ChangeContract, "status" | "violations" | "verificationPlan">>): ChangeContract | undefined {
    const values: unknown[] = [], fields: string[] = []
    if (patch.status !== undefined) { fields.push("status = ?"); values.push(patch.status) }
    if (patch.violations !== undefined) { fields.push("violations = ?"); values.push(this.json(patch.violations)) }
    if (patch.verificationPlan !== undefined) { fields.push("verification_plan = ?"); values.push(this.json(patch.verificationPlan)) }
    if (!fields.length) return this.getChangeContract(id)
    fields.push("updated_at = ?"); values.push(Date.now(), id)
    this.getDb().prepare(`UPDATE change_contracts SET ${fields.join(", ")} WHERE id = ?`).run(...(values as any[]))
    return this.getChangeContract(id)
  }

  checkChangeContract(id: string, changedPaths: string[]): { contract: ChangeContract | undefined; allowed: boolean; violations: string[] } {
    const contract = this.getChangeContract(id)
    if (!contract) return { contract: undefined, allowed: false, violations: ["contract_not_found"] }
    const matches = (pattern: string, value: string) => pattern === "*" || value === pattern || value.startsWith(pattern.replace(/[*]$/, ""))
    const violations = changedPaths.filter((file) => {
      if (contract.forbiddenPaths.some((p) => matches(p, file))) return true
      return contract.allowedPaths.length > 0 && !contract.allowedPaths.some((p) => matches(p, file))
    })
    const updated = this.updateChangeContract(id, { status: violations.length ? "violated" : "passed", violations })
    return { contract: updated, allowed: violations.length === 0, violations }
  }

  recordContradiction(input: Omit<ContradictionRecord, "id" | "createdAt" | "resolvedAt" | "status" | "resolution"> & { id?: string; status?: ContradictionRecord["status"]; resolution?: string | null }): ContradictionRecord {
    const now = Date.now(), id = input.id || crypto.randomUUID()
    this.getDb().prepare(`INSERT INTO contradiction_records
      (id, project_root, task_id, claim_a, source_a, claim_b, source_b, severity, status, resolution, created_at, resolved_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,NULL,?10,NULL)`).run(
      id, input.projectRoot, input.taskId ?? null, input.claimA, input.sourceA, input.claimB,
      input.sourceB, input.severity, input.status || "open", now,
    )
    return this.getContradiction(id)!
  }

  getContradiction(id: string): ContradictionRecord | undefined {
    const row = this.getDb().prepare(`SELECT * FROM contradiction_records WHERE id = ?1`).get(id) as Record<string, any> | undefined
    return row ? this.contradictionRow(row) : undefined
  }

  listContradictions(projectRoot: string, status = "open", limit = 20): ContradictionRecord[] {
    const rows = this.getDb().prepare(`SELECT * FROM contradiction_records WHERE project_root = ?1 AND status = ?2 ORDER BY created_at DESC LIMIT ?3`).all(projectRoot, status, limit) as Record<string, any>[]
    return rows.map((row) => this.contradictionRow(row))
  }

  resolveContradiction(id: string, resolution: string, status: "resolved" | "accepted" = "resolved"): ContradictionRecord | undefined {
    this.getDb().prepare(`UPDATE contradiction_records SET status = ?1, resolution = ?2, resolved_at = ?3 WHERE id = ?4`).run(status, resolution, Date.now(), id)
    return this.getContradiction(id)
  }

  recordProvenance(input: Omit<ProvenanceEvent, "id" | "createdAt">): number {
    const result = this.getDb().prepare(`INSERT INTO provenance_events
      (project_root, session_id, source_type, source_ref, content_hash, trust_level, flags, snippet, created_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`).run(
      input.projectRoot, input.sessionId ?? null, input.sourceType, input.sourceRef,
      input.contentHash, input.trustLevel, this.json(input.flags), input.snippet ?? null, Date.now(),
    )
    return Number(result.lastInsertRowid)
  }

  listProvenance(projectRoot: string, limit = 30): ProvenanceEvent[] {
    const rows = this.getDb().prepare(`SELECT * FROM provenance_events WHERE project_root = ?1 ORDER BY created_at DESC LIMIT ?2`).all(projectRoot, limit) as Record<string, any>[]
    return rows.map((row) => ({
      id: row.id, projectRoot: row.project_root, sessionId: row.session_id,
      sourceType: row.source_type, sourceRef: row.source_ref, contentHash: row.content_hash,
      trustLevel: row.trust_level, flags: this.parseJson(row.flags, []), snippet: row.snippet,
      createdAt: row.created_at,
    }))
  }

  createHandoff(input: Omit<AgentHandoff, "id" | "createdAt" | "completedAt" | "status"> & { id?: string; status?: AgentHandoff["status"] }): AgentHandoff {
    const now = Date.now(), id = input.id || crypto.randomUUID()
    this.getDb().prepare(`INSERT INTO agent_handoffs
      (id, project_root, task_id, session_id, summary, next_action, payload, status, created_at, completed_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,NULL)`).run(
      id, input.projectRoot, input.taskId ?? null, input.sessionId ?? null,
      input.summary, input.nextAction, this.json(input.payload), input.status || "open", now,
    )
    return this.getHandoff(id)!
  }

  getHandoff(id: string): AgentHandoff | undefined {
    const row = this.getDb().prepare(`SELECT * FROM agent_handoffs WHERE id = ?1`).get(id) as Record<string, any> | undefined
    return row ? {
      id: row.id, projectRoot: row.project_root, taskId: row.task_id, sessionId: row.session_id,
      summary: row.summary, nextAction: row.next_action, payload: this.parseJson(row.payload, {}),
      status: row.status, createdAt: row.created_at, completedAt: row.completed_at,
    } : undefined
  }

  listHandoffs(projectRoot: string, status?: string, limit = 10): AgentHandoff[] {
    const rows = status
      ? this.getDb().prepare(`SELECT * FROM agent_handoffs WHERE project_root = ?1 AND status = ?2 ORDER BY created_at DESC LIMIT ?3`).all(projectRoot, status, limit)
      : this.getDb().prepare(`SELECT * FROM agent_handoffs WHERE project_root = ?1 ORDER BY created_at DESC LIMIT ?2`).all(projectRoot, limit)
    return (rows as Record<string, any>[]).map((row) => this.getHandoff(row.id)!).filter(Boolean)
  }

  updateHandoff(id: string, status: "open" | "claimed" | "completed"): AgentHandoff | undefined {
    this.getDb().prepare(`UPDATE agent_handoffs SET status = ?1, completed_at = CASE WHEN ?1 = 'completed' THEN ?2 ELSE completed_at END WHERE id = ?3`).run(status, Date.now(), id)
    return this.getHandoff(id)
  }

  // =========================================================================
  // CRUD: tool_executions
  // =========================================================================

  /** Вставляет запись о вызове инструмента. Возвращает id. */
  insertToolExecution(exec: Omit<ToolExecution, "id">): number {
    try {
      const db = this.getDb();
      const result = db
        .prepare(
          `INSERT INTO tool_executions
            (session_id, tool_name, target_file, args_preview,
             status, duration_ms, timestamp, result_size_bytes)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        )
        .run(
          exec.sessionId,
          exec.toolName,
          exec.targetFile ?? null,
          exec.argsPreview ? exec.argsPreview.slice(0, this.config.maxArgsPreviewChars) : null,
          exec.status,
          exec.durationMs ?? null,
          exec.timestamp,
          exec.resultSizeBytes ?? null,
        );

      log.debug(
        `Инструмент вставлен: id=${result.lastInsertRowid}, tool=${exec.toolName}`,
      );
      return Number(result.lastInsertRowid);
    } catch (err) {
      log.error(`Ошибка insertToolExecution: ${String(err)}`);
      return -1;
    }
  }

  /** Возвращает вызовы инструментов, связанные с указанным файлом. */
  getToolExecutionsForFile(
    filePath: string,
    timeframe?: string,
  ): ToolExecution[] {
    try {
      const db = this.getDb();
      const cutoff = timeframeToCutoff(timeframe);

      let query = `SELECT * FROM tool_executions WHERE target_file = ?1`;
      const params: (string | number)[] = [filePath];

      if (cutoff !== null) {
        query += ` AND timestamp >= ?2`;
        params.push(cutoff);
      }

      query += ` ORDER BY timestamp DESC`;
      const rows = db.prepare(query).all(...params) as ToolExecutionRow[];
      return rows.map(rowToToolExecution);
    } catch (err) {
      log.error(`Ошибка getToolExecutionsForFile: ${String(err)}`);
      return [];
    }
  }

  // =========================================================================
  // CRUD: decisions
  // =========================================================================

  /** Вставляет архитектурное решение. Возвращает id. */
  insertDecision(decision: Omit<Decision, "id">): number {
    try {
      const db = this.getDb();
      const result = db
        .prepare(
          `INSERT INTO decisions
            (title, description, context, alternatives, status,
             decided_by, decided_at, superseded_by, related_files, tags)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
        )
        .run(
          decision.title,
          decision.description,
          decision.context ?? null,
          decision.alternatives ? JSON.stringify(decision.alternatives) : null,
          decision.status,
          decision.decidedBy ?? null,
          decision.decidedAt,
          decision.supersededBy ?? null,
          decision.relatedFiles ? JSON.stringify(decision.relatedFiles) : null,
          decision.tags ? JSON.stringify(decision.tags) : null,
        );

      log.debug(
        `Решение вставлено: id=${result.lastInsertRowid}, заголовок=${decision.title}`,
      );
      return Number(result.lastInsertRowid);
    } catch (err) {
      log.error(`Ошибка insertDecision: ${String(err)}`);
      return -1;
    }
  }

  /** Возвращает список решений с фильтром по статусу. */
  getDecisions(status?: string, limit = 50): Decision[] {
    try {
      const db = this.getDb();

      let query = `SELECT * FROM decisions`;
      const params: (string | number)[] = [];

      if (status) {
        query += ` WHERE status = ?1`;
        query += ` ORDER BY decided_at DESC LIMIT ?2`;
        params.push(status, limit);
      } else {
        query += ` ORDER BY decided_at DESC LIMIT ?1`;
        params.push(limit);
      }

      const rows = db.prepare(query).all(...params) as DecisionRow[];
      return rows.map(rowToDecision);
    } catch (err) {
      log.error(`Ошибка getDecisions: ${String(err)}`);
      return [];
    }
  }

  /** Обновляет статус решения. */
  updateDecisionStatus(id: number, status: string): void {
    try {
      const db = this.getDb();
      db.prepare(`UPDATE decisions SET status = ?1 WHERE id = ?2`).run(
        status,
        id,
      );
      log.debug(`Статус решения обновлён: id=${id}, status=${status}`);
    } catch (err) {
      log.error(`Ошибка updateDecisionStatus: ${String(err)}`);
    }
  }

  // =========================================================================
  // CRUD: knowledge_nodes
  // =========================================================================

  /** Вставляет или обновляет узел графа знаний. Возвращает id. */
  upsertNode(node: Omit<KnowledgeNode, "id">): number {
    try {
      const db = this.getDb();
      const now = Date.now();

      const metadata = node.metadata
        ? JSON.stringify(node.metadata)
        : null;

      if (node.nodeType === NodeType.File && node.path) {
        // Для файловых узлов — ищем по path
        const existing = db
          .prepare(`SELECT id FROM knowledge_nodes WHERE node_type = 'file' AND path = ?1`)
          .get(node.path) as { id: number } | undefined;

        if (existing) {
          db.prepare(
            `UPDATE knowledge_nodes
             SET name = ?1, metadata = ?2, updated_at = ?3
             WHERE id = ?4`,
          ).run(node.name, metadata, now, existing.id);
          return existing.id;
        }
      } else {
        // Для остальных узлов — ищем по name и node_type
        const existing = db
          .prepare(`SELECT id FROM knowledge_nodes WHERE name = ?1 AND node_type = ?2`)
          .get(node.name, node.nodeType) as { id: number } | undefined;

        if (existing) {
          db.prepare(
            `UPDATE knowledge_nodes
             SET path = ?1, metadata = ?2, updated_at = ?3
             WHERE id = ?4`,
          ).run(node.path ?? null, metadata, now, existing.id);
          return existing.id;
        }
      }

      // Вставка нового узла
      const result = db
        .prepare(
          `INSERT INTO knowledge_nodes
            (node_type, name, path, metadata, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        )
        .run(
          node.nodeType,
          node.name,
          node.path ?? null,
          metadata,
          node.createdAt || now,
          node.updatedAt || now,
        );

      log.debug(`Узел знаний вставлен: id=${result.lastInsertRowid}, name=${node.name}`);
      return Number(result.lastInsertRowid);
    } catch (err) {
      log.error(`Ошибка upsertNode: ${String(err)}`);
      return -1;
    }
  }

  /** Возвращает узел графа знаний по id. */
  getNode(id: number): KnowledgeNode | undefined {
    try {
      const db = this.getDb();
      const row = db
        .prepare(`SELECT * FROM knowledge_nodes WHERE id = ?1`)
        .get(id) as KnowledgeNodeRow | undefined;
      return row ? rowToKnowledgeNode(row) : undefined;
    } catch (err) {
      log.error(`Ошибка getNode: ${String(err)}`);
      return undefined;
    }
  }

  /** Поиск узлов по имени (LIKE). */
  searchNodes(query: string, limit = 20): KnowledgeNode[] {
    try {
      const db = this.getDb();
      const rows = db
        .prepare(
          `SELECT * FROM knowledge_nodes
           WHERE name LIKE ?1 OR path LIKE ?1 OR metadata LIKE ?1
           ORDER BY updated_at DESC
           LIMIT ?2`,
        )
        .all(`%${query}%`, limit) as KnowledgeNodeRow[];
      return rows.map(rowToKnowledgeNode);
    } catch (err) {
      log.error(`Ошибка searchNodes: ${String(err)}`);
      return [];
    }
  }

  /** Возвращает все узлы заданного типа. */
  getNodesByType(type: string): KnowledgeNode[] {
    try {
      const db = this.getDb();
      const rows = db
        .prepare(`SELECT * FROM knowledge_nodes WHERE node_type = ?1`)
        .all(type) as KnowledgeNodeRow[];
      return rows.map(rowToKnowledgeNode);
    } catch (err) {
      log.error(`Ошибка getNodesByType: ${String(err)}`);
      return [];
    }
  }

  // =========================================================================
  // CRUD: knowledge_edges
  // =========================================================================

  /** Вставляет или обновляет ребро графа знаний. Возвращает id. */
  upsertEdge(
    edge: Omit<KnowledgeEdge, "id" | "firstSeen" | "lastSeen">,
  ): number {
    try {
      const db = this.getDb();
      const now = Date.now();

      const existing = db
        .prepare(
          `SELECT id FROM knowledge_edges
           WHERE source_id = ?1 AND target_id = ?2 AND edge_type = ?3`,
        )
        .get(edge.sourceId, edge.targetId, edge.edgeType) as
        | { id: number }
        | undefined;

      if (existing) {
        db.prepare(
          `UPDATE knowledge_edges
           SET weight = ?1, evidence_count = evidence_count + 1, last_seen = ?2
           WHERE id = ?3`,
        ).run(edge.weight, now, existing.id);
        return existing.id;
      }

      const result = db
        .prepare(
          `INSERT INTO knowledge_edges
            (source_id, target_id, edge_type, weight, evidence_count, first_seen, last_seen)
           VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)`,
        )
        .run(edge.sourceId, edge.targetId, edge.edgeType, edge.weight, now, now);

      log.debug(
        `Ребро знаний вставлено: id=${result.lastInsertRowid}, тип=${edge.edgeType}`,
      );
      return Number(result.lastInsertRowid);
    } catch (err) {
      log.error(`Ошибка upsertEdge: ${String(err)}`);
      return -1;
    }
  }

  /** Возвращает все рёбра, связанные с узлом (как источник или цель). */
  getEdgesForNode(nodeId: number): KnowledgeEdge[] {
    try {
      const db = this.getDb();
      const rows = db
        .prepare(
          `SELECT * FROM knowledge_edges WHERE source_id = ?1 OR target_id = ?2`,
        )
        .all(nodeId, nodeId) as KnowledgeEdgeRow[];
      return rows.map(rowToKnowledgeEdge);
    } catch (err) {
      log.error(`Ошибка getEdgesForNode: ${String(err)}`);
      return [];
    }
  }

  /**
   * Возвращает файлы, которые редактировались в тех же сессиях,
   * что и указанный файл — с частотой совместного изменения.
   */
  getCoChangedFiles(
    filePath: string,
    minFrequency = 1,
    projectRoot?: string,
  ): { file: string; frequency: number }[] {
    try {
      const db = this.getDb();
      const rows = db
        .prepare(
          `SELECT fe2.file_path AS file, COUNT(*) AS frequency
           FROM file_edits fe1
           JOIN file_edits fe2 ON fe1.session_id = fe2.session_id
           WHERE fe1.file_path = ?1 AND fe2.file_path != ?2
             AND (?4 IS NULL OR fe1.project_root = ?4)
             AND (?4 IS NULL OR fe2.project_root = ?4)
           GROUP BY fe2.file_path
           HAVING COUNT(*) >= ?3
           ORDER BY frequency DESC`,
        )
        .all(filePath, filePath, minFrequency, projectRoot ?? null) as {
        file: string;
        frequency: number;
      }[];
      return rows;
    } catch (err) {
      log.error(`Ошибка getCoChangedFiles: ${String(err)}`);
      return [];
    }
  }

  // =========================================================================
  // CRUD: developer_events
  // =========================================================================

  /** Вставляет событие разработчика. Возвращает id. */
  insertDevEvent(event: Omit<DeveloperEvent, "id">): number {
    try {
      const db = this.getDb();
      const result = db
        .prepare(
          `INSERT INTO developer_events
            (event_type, session_id, file_path, metadata, timestamp)
           VALUES (?1, ?2, ?3, ?4, ?5)`,
        )
        .run(
          event.eventType,
          event.sessionId ?? null,
          event.filePath ?? null,
          event.metadata ? JSON.stringify(event.metadata) : null,
          event.timestamp,
        );

      log.debug(
        `Событие разработчика вставлено: id=${result.lastInsertRowid}, тип=${event.eventType}`,
      );
      return Number(result.lastInsertRowid);
    } catch (err) {
      log.error(`Ошибка insertDevEvent: ${String(err)}`);
      return -1;
    }
  }

  /** Возвращает события разработчика с фильтром по типу и времени. */
  getDevEvents(type?: string, timeframe?: string): DeveloperEvent[] {
    try {
      const db = this.getDb();
      const cutoff = timeframeToCutoff(timeframe);

      const conditions: string[] = [];
      const params: (string | number)[] = [];

      let paramIdx = 0;

      if (type) {
        paramIdx++;
        conditions.push(`event_type = ?${paramIdx}`);
        params.push(type);
      }

      if (cutoff !== null) {
        paramIdx++;
        conditions.push(`timestamp >= ?${paramIdx}`);
        params.push(cutoff);
      }

      let query = `SELECT * FROM developer_events`;
      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(" AND ")}`;
      }
      query += ` ORDER BY timestamp DESC`;

      const rows = db.prepare(query).all(...params) as DeveloperEventRow[];
      return rows.map(rowToDeveloperEvent);
    } catch (err) {
      log.error(`Ошибка getDevEvents: ${String(err)}`);
      return [];
    }
  }

  /** Возвращает общее количество сессий (на основе developer_events типа session_start). */
  getSessionCount(timeframe?: string): number {
    try {
      const db = this.getDb();
      const cutoff = timeframeToCutoff(timeframe);

      let query = `SELECT COUNT(*) as cnt FROM sessions`;
      const params: number[] = [];

      if (cutoff !== null) {
        query += ` WHERE started_at >= ?1`;
        params.push(cutoff);
      }

      const row = db.prepare(query).get(...params) as { cnt: number };
      return row.cnt;
    } catch (err) {
      log.error(`Ошибка getSessionCount: ${String(err)}`);
      return 0;
    }
  }

  // =========================================================================
  // CRUD: analytics_cache
  // =========================================================================

  /** Получает закешированное значение. Возвращает undefined если нет или истекло. */
  getCached(key: string): unknown | undefined {
    try {
      const db = this.getDb();
      const now = Date.now();
      const row = db
        .prepare(
          `SELECT cache_data, valid_until FROM analytics_cache
           WHERE cache_key = ?1 AND (valid_until IS NULL OR valid_until > ?2)`,
        )
        .get(key, now) as { cache_data: string; valid_until: number | null } | undefined;

      if (!row) return undefined;

      return JSON.parse(row.cache_data);
    } catch (err) {
      log.error(`Ошибка getCached: ${String(err)}`);
      return undefined;
    }
  }

  /** Сохраняет значение в кеш. Обновляет существующую запись по ключу. */
  setCached(key: string, data: unknown, ttlMs?: number): void {
    try {
      const db = this.getDb();
      const now = Date.now();
      const validUntil = ttlMs ? now + ttlMs : null;
      const cacheData = JSON.stringify(data);

      db.prepare(
        `INSERT INTO analytics_cache
          (cache_key, cache_data, computed_at, valid_until)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(cache_key) DO UPDATE SET
           cache_data = excluded.cache_data,
           computed_at = excluded.computed_at,
           valid_until = excluded.valid_until`,
      ).run(key, cacheData, now, validUntil);

      log.debug(`Кеш обновлён: key=${key}, ttl=${ttlMs ?? "∞"}ms`);
    } catch (err) {
      log.error(`Ошибка setCached: ${String(err)}`);
    }
  }

  // =========================================================================
  // Утилитарные методы
  // =========================================================================

  /** Все уникальные file_path за указанный период. */
  getDistinctFiles(timeframe?: string): string[] {
    try {
      const db = this.getDb();
      const cutoff = timeframeToCutoff(timeframe);

      let query = `SELECT DISTINCT file_path FROM file_edits`;
      const params: number[] = [];

      if (cutoff !== null) {
        query += ` WHERE timestamp >= ?1`;
        params.push(cutoff);
      }

      query += ` ORDER BY file_path`;
      const rows = db.prepare(query).all(...params) as { file_path: string }[];
      return rows.map((r) => r.file_path);
    } catch (err) {
      log.error(`Ошибка getDistinctFiles: ${String(err)}`);
      return [];
    }
  }

  /** Возвращает уникальные файлы в явном временном диапазоне [from, to). */
  getDistinctFilesBetween(from: number, to: number): string[] {
    try {
      const db = this.getDb()
      const rows = db.prepare(
        `SELECT DISTINCT file_path FROM file_edits
         WHERE timestamp >= ?1 AND timestamp < ?2
         ORDER BY file_path`,
      ).all(from, to) as { file_path: string }[]
      return rows.map((row) => row.file_path)
    } catch (err) {
      log.error(`Ошибка getDistinctFilesBetween: ${String(err)}`)
      return []
    }
  }

  /** Возвращает правки файла в явном временном диапазоне [from, to). */
  getFileEditsBetween(filePath: string, from: number, to: number): FileEdit[] {
    try {
      const db = this.getDb()
      const rows = db.prepare(
        `SELECT * FROM file_edits
         WHERE file_path = ?1 AND timestamp >= ?2 AND timestamp < ?3
         ORDER BY timestamp DESC`,
      ).all(filePath, from, to) as FileEditRow[]
      return rows.map(rowToFileEdit)
    } catch (err) {
      log.error(`Ошибка getFileEditsBetween: ${String(err)}`)
      return []
    }
  }

  /** Возвращает ошибки файла в явном временном диапазоне [from, to). */
  getErrorsForFileBetween(filePath: string, from: number, to: number): SessionError[] {
    try {
      const db = this.getDb()
      const rows = db.prepare(
        `SELECT * FROM session_errors
         WHERE context_file = ?1 AND timestamp >= ?2 AND timestamp < ?3
         ORDER BY timestamp DESC`,
      ).all(filePath, from, to) as SessionErrorRow[]
      return rows.map(rowToSessionError)
    } catch (err) {
      log.error(`Ошибка getErrorsForFileBetween: ${String(err)}`)
      return []
    }
  }

  /** Возвращает число сессий в явном временном диапазоне [from, to). */
  getSessionCountBetween(from: number, to: number): number {
    try {
      const db = this.getDb()
      const row = db.prepare(
        `SELECT COUNT(*) AS cnt FROM sessions
         WHERE started_at >= ?1 AND started_at < ?2`,
      ).get(from, to) as { cnt: number }
      return row.cnt
    } catch (err) {
      log.error(`Ошибка getSessionCountBetween: ${String(err)}`)
      return 0
    }
  }

  /** Developer events в явном временном диапазоне [from, to). */
  getDevEventsBetween(type: string | undefined, from: number, to: number): DeveloperEvent[] {
    try {
      const db = this.getDb()
      const params: (string | number)[] = [from, to]
      let query = `SELECT * FROM developer_events WHERE timestamp >= ?1 AND timestamp < ?2`
      if (type) {
        query += ` AND event_type = ?3`
        params.push(type)
      }
      query += ` ORDER BY timestamp DESC`
      const rows = db.prepare(query).all(...params) as DeveloperEventRow[]
      return rows.map(rowToDeveloperEvent)
    } catch (err) {
      log.error(`Ошибка getDevEventsBetween: ${String(err)}`)
      return []
    }
  }

  /**
   * Частота редактирования файла: общее количество и нормализованное "в день".
   */
  getEditFrequency(
    filePath: string,
    timeframe?: string,
  ): { total: number; perDay: number } {
    try {
      const db = this.getDb();
      const cutoff = timeframeToCutoff(timeframe);

      let whereClause = `WHERE file_path = ?1`;
      const params: (string | number)[] = [filePath];

      if (cutoff !== null) {
        whereClause += ` AND timestamp >= ?2`;
        params.push(cutoff);
      }

      const countRow = db
        .prepare(`SELECT COUNT(*) AS cnt FROM file_edits ${whereClause}`)
        .get(...params) as { cnt: number };

      const total = countRow.cnt;

      // Определяем количество дней для нормализации
      let days = 1;
      if (cutoff !== null) {
        const elapsed = Date.now() - cutoff;
        days = Math.max(1, Math.ceil(elapsed / (24 * 60 * 60 * 1000)));
        days = Math.min(days, daysInTimeframe(timeframe));
      } else {
        // Без timeframe — используем разброс между первой и последней правкой
        const span = db
          .prepare(
            `SELECT MIN(timestamp) AS first_ts, MAX(timestamp) AS last_ts
             FROM file_edits WHERE file_path = ?1`,
          )
          .get(filePath) as { first_ts: number | null; last_ts: number | null };
        if (span.first_ts && span.last_ts && span.last_ts > span.first_ts) {
          days = Math.max(
            1,
            Math.ceil((span.last_ts - span.first_ts) / (24 * 60 * 60 * 1000)),
          );
        }
      }

      const perDay = days > 0 ? parseFloat((total / days).toFixed(2)) : total;
      return { total, perDay };
    } catch (err) {
      log.error(`Ошибка getEditFrequency: ${String(err)}`);
      return { total: 0, perDay: 0 };
    }
  }

  /** Количество зависимостей файла (рёбра графа знаний, где файл — источник или цель). */
  getDependencyCount(filePath: string): number {
    try {
      const db = this.getDb();
      const row = db
        .prepare(
          `SELECT COUNT(*) AS cnt
           FROM knowledge_edges ke
           JOIN knowledge_nodes kn_src ON ke.source_id = kn_src.id
           JOIN knowledge_nodes kn_tgt ON ke.target_id = kn_tgt.id
           WHERE kn_src.path = ?1 OR kn_tgt.path = ?2`,
        )
        .get(filePath, filePath) as { cnt: number };
      return row.cnt;
    } catch (err) {
      log.error(`Ошибка getDependencyCount: ${String(err)}`);
      return 0;
    }
  }

  /**
   * Историческая частота поломок файла.
   * = (сессии с ошибками по этому файлу) / (сессии, трогавшие этот файл).
   */
  getHistoricalBreakageRate(
    filePath: string,
    timeframe?: string,
  ): number {
    try {
      const db = this.getDb();
      const cutoff = timeframeToCutoff(timeframe);

      let errorFilter = "";
      let editFilter = "";
      const params: number[] = [];

      if (cutoff !== null) {
        errorFilter = ` AND timestamp >= ?2`;
        editFilter = ` AND timestamp >= ?2`;
        params.push(cutoff);
      }

      const errorRow = db
        .prepare(
          `SELECT COUNT(DISTINCT session_id) AS cnt
           FROM session_errors
           WHERE context_file = ?1${errorFilter}`,
        )
        .get(filePath, ...params) as { cnt: number };

      const totalRow = db
        .prepare(
          `SELECT COUNT(DISTINCT session_id) AS cnt
           FROM file_edits
           WHERE file_path = ?1${editFilter}`,
        )
        .get(filePath, ...params) as { cnt: number };

      if (totalRow.cnt === 0) return 0;
      return parseFloat((errorRow.cnt / totalRow.cnt).toFixed(4));
    } catch (err) {
      log.error(`Ошибка getHistoricalBreakageRate: ${String(err)}`);
      return 0;
    }
  }

  /** Последние сессии, изменявшие указанный файл. */
  getRecentSimilarChanges(
    filePath: string,
    timeframe?: string,
    limit = 5,
  ): Session[] {
    try {
      const db = this.getDb();
      const cutoff = timeframeToCutoff(timeframe);

      let query = `
        SELECT DISTINCT s.*
        FROM sessions s
        JOIN file_edits fe ON s.id = fe.session_id
        WHERE fe.file_path = ?1`;
      const params: (string | number)[] = [filePath];

      if (cutoff !== null) {
        query += ` AND fe.timestamp >= ?2`;
        params.push(cutoff);
      }

      query += ` ORDER BY fe.timestamp DESC LIMIT ?3`;
      params.push(limit);

      const rows = db.prepare(query).all(...params) as SessionRow[];
      return rows.map(rowToSession);
    } catch (err) {
      log.error(`Ошибка getRecentSimilarChanges: ${String(err)}`);
      return [];
    }
  }

  /** Все уникальные project_root в таблице сессий. */
  getProjectRoots(): string[] {
    try {
      const db = this.getDb();
      const rows = db
        .prepare(`SELECT DISTINCT project_root FROM sessions ORDER BY project_root`)
        .all() as { project_root: string }[];
      return rows.map((r) => r.project_root);
    } catch (err) {
      log.error(`Ошибка getProjectRoots: ${String(err)}`);
      return [];
    }
  }

  /**
   * Очистка старых данных.
   * Сырые события удаляются по retentionDays, сессии — по sessionRetentionDays.
   */
  runCleanup(retentionDays: number, sessionRetentionDays: number): void {
    try {
      const db = this.getDb();
      const rawCutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      const sessionCutoff =
        Date.now() - sessionRetentionDays * 24 * 60 * 60 * 1000;

      db.transaction(() => {
        // Удаляем старые сырые события
        db.prepare(`DELETE FROM file_edits WHERE timestamp < ?1`).run(rawCutoff);
        db.prepare(`DELETE FROM tool_executions WHERE timestamp < ?1`).run(rawCutoff);
        db.prepare(`DELETE FROM session_errors WHERE timestamp < ?1`).run(rawCutoff);
        db.prepare(`DELETE FROM developer_events WHERE timestamp < ?1`).run(rawCutoff);

        // Сессии храним дольше — удаляем только удалённые/сжатые старше порога
        db.prepare(
          `DELETE FROM sessions WHERE started_at < ?1 AND status IN ('deleted','compacted')`,
        ).run(sessionCutoff);

        // Чистим устаревший кеш
        db.prepare(
          `DELETE FROM analytics_cache WHERE valid_until IS NOT NULL AND valid_until < ?1`,
        ).run(Date.now());

        log.info(
          `Очистка выполнена: события старше ${retentionDays}д, сессии старше ${sessionRetentionDays}д.`,
        );
      })();
    } catch (err) {
      log.error(`Ошибка runCleanup: ${String(err)}`);
    }
  }

  /** Приблизительный размер БД в байтах (размер файла на диске). */
  getDbSize(): number {
    try {
      const stat = fs.statSync(this.dbPath);
      return stat.size;
    } catch (err) {
      log.error(`Ошибка getDbSize: ${String(err)}`);
      return 0;
    }
  }

  /** Возвращает количество строк в каждой таблице. */
  getStats(): { tableCounts: Record<string, number> } {
    try {
      const db = this.getDb();
      const tables = [
        "file_edits",
        "sessions",
        "session_errors",
        "tool_executions",
        "decisions",
        "knowledge_nodes",
        "knowledge_edges",
        "developer_events",
        "analytics_cache",
        "schema_version",
      ];

      const tableCounts: Record<string, number> = {};
      for (const table of tables) {
        const row = db
          .prepare(`SELECT COUNT(*) AS cnt FROM "${table}"`)
          .get() as { cnt: number };
        tableCounts[table] = row.cnt;
      }

      return { tableCounts };
    } catch (err) {
      log.error(`Ошибка getStats: ${String(err)}`);
      return { tableCounts: {} };
    }
  }

  // =========================================================================
  // Пакетная запись (Batch Queue)
  // =========================================================================

  /**
   * Добавляет строку в очередь пакетной записи.
   * Автоматический сброс при достижении batchSize.
   */
  enqueue(table: string, data: Record<string, unknown>): void {
    this.batchQueue.push({ table, row: data });
    log.debug(
      `Пакет: +1 в таблицу ${table}, очередь=${this.batchQueue.length}`,
    );

    if (this.batchQueue.length >= this.config.batchSize) {
      this.flushBatch();
    }
  }

  /**
   * Сбрасывает всю очередь пакетной записи в БД одной транзакцией.
   */
  flushBatch(): void {
    if (this.batchQueue.length === 0) return;

    const items = [...this.batchQueue];

    try {
      const db = this.getDb();
      this.batchQueue = [];

      db.transaction(() => {
        for (const item of items) {
          const columns = Object.keys(item.row);
          const placeholders = columns.map((_, i) => `?${i + 1}`).join(", ");
          const values = Object.values(item.row);

          // Экранируем имя таблицы (безопасно, так как table задаётся кодом)
          const query = `INSERT INTO "${item.table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`;

          // Ошибка отдельной записи должна откатить весь batch. Иначе
          // вызывающий код считает запись успешной, а данные бесшумно теряются.
          db.prepare(query).run(...(values as any));
        }
      })();

      log.info(`Пакетная запись: ${items.length} строк сброшено в БД.`);
    } catch (err) {
      log.error(`Ошибка flushBatch: ${String(err)}`);
      // Возвращаем элементы, чтобы временная ошибка БД не уничтожила события.
      this.batchQueue = [...items, ...this.batchQueue];
    }
  }
}
