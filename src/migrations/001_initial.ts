// =============================================================================
// Code Shadow — Миграция 001: Начальная схема
// Создаёт все таблицы, индексы и настройки базы данных.
// Все таблицы соответствуют DATA_MODEL.md и типам в types.ts.
// =============================================================================

import type { Database } from "bun:sqlite";

export function migrateV001Initial(db: Database): void {
  const now = Date.now();

  db.transaction(() => {
    // -----------------------------------------------------------------------
    // Таблица версий схемы
    // -----------------------------------------------------------------------
    db.run(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        description TEXT NOT NULL
      );
    `);

    // -----------------------------------------------------------------------
    // Таблица: file_edits — каждое изменение файла AI-агентом
    // -----------------------------------------------------------------------
    db.run(`
      CREATE TABLE IF NOT EXISTS file_edits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_type TEXT NOT NULL CHECK(agent_type IN ('build','plan','general','explore')),
        edit_type TEXT NOT NULL CHECK(edit_type IN ('create','update','delete')),
        diff_preview TEXT,
        lines_added INTEGER DEFAULT 0,
        lines_removed INTEGER DEFAULT 0,
        timestamp INTEGER NOT NULL,
        project_root TEXT NOT NULL DEFAULT '',
        was_reverted INTEGER DEFAULT 0,
        file_language TEXT,
        diff_hash TEXT
      );
    `);

    // -----------------------------------------------------------------------
    // Таблица: sessions — жизненный цикл каждой сессии AI-агента
    // -----------------------------------------------------------------------
    db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent_type TEXT NOT NULL CHECK(agent_type IN ('build','plan','general','explore')),
        status TEXT NOT NULL CHECK(status IN ('created','active','idle','error','compacted','deleted')),
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        duration_ms INTEGER,
        files_changed_count INTEGER DEFAULT 0,
        tools_used_count INTEGER DEFAULT 0,
        errors_count INTEGER DEFAULT 0,
        project_root TEXT NOT NULL,
        message_count INTEGER DEFAULT 0,
        total_tokens_used INTEGER DEFAULT 0,
        compacted_from TEXT
      );
    `);

    // -----------------------------------------------------------------------
    // Таблица: session_errors — ошибки, произошедшие во время сессий
    // -----------------------------------------------------------------------
    db.run(`
      CREATE TABLE IF NOT EXISTS session_errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        error_type TEXT NOT NULL CHECK(error_type IN ('tool_error','model_error','permission_denied','unknown')),
        error_message TEXT NOT NULL,
        error_stack TEXT,
        context_file TEXT,
        context_tool TEXT,
        timestamp INTEGER NOT NULL,
        resolved INTEGER DEFAULT 0
      );
    `);

    // -----------------------------------------------------------------------
    // Таблица: tool_executions — каждый вызов инструмента AI-агентом
    // -----------------------------------------------------------------------
    db.run(`
      CREATE TABLE IF NOT EXISTS tool_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        target_file TEXT,
        args_preview TEXT,
        status TEXT NOT NULL CHECK(status IN ('success','error','timeout','denied')),
        duration_ms INTEGER,
        timestamp INTEGER NOT NULL,
        result_size_bytes INTEGER
      );
    `);

    // -----------------------------------------------------------------------
    // Таблица: decisions — архитектурные решения (ADR)
    // -----------------------------------------------------------------------
    db.run(`
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        context TEXT,
        alternatives TEXT,
        status TEXT NOT NULL CHECK(status IN ('proposed','accepted','deprecated','superseded')),
        decided_by TEXT,
        decided_at INTEGER NOT NULL,
        superseded_by INTEGER,
        related_files TEXT,
        tags TEXT
      );
    `);

    // -----------------------------------------------------------------------
    // Таблица: knowledge_nodes — узлы графа знаний
    // -----------------------------------------------------------------------
    db.run(`
      CREATE TABLE IF NOT EXISTS knowledge_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_type TEXT NOT NULL CHECK(node_type IN ('file','module','concept','component','api','pattern','rule','api_endpoint','note','decision')),
        name TEXT NOT NULL,
        path TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // -----------------------------------------------------------------------
    // Таблица: knowledge_edges — рёбра (связи) графа знаний
    // -----------------------------------------------------------------------
    db.run(`
      CREATE TABLE IF NOT EXISTS knowledge_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL REFERENCES knowledge_nodes(id),
        target_id INTEGER NOT NULL REFERENCES knowledge_nodes(id),
        edge_type TEXT NOT NULL CHECK(edge_type IN ('imports','exports','contains','depends_on','causes_bugs_in','refactored_to','similar_to','tested_by','implements','extends','coupled_with','references')),
        weight REAL DEFAULT 1.0,
        evidence_count INTEGER DEFAULT 1,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
    `);

    // -----------------------------------------------------------------------
    // Таблица: developer_events — события разработчика
    // -----------------------------------------------------------------------
    db.run(`
      CREATE TABLE IF NOT EXISTS developer_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL CHECK(event_type IN ('session_started','manual_edit','revert','command_used','human_fix','session_start','session_end','file_focus','tool_rejected','session_completed','todo_completed','lsp_diagnostic','lsp_diagnostic_summary')),
        session_id TEXT,
        file_path TEXT,
        metadata TEXT,
        timestamp INTEGER NOT NULL
      );
    `);

    // -----------------------------------------------------------------------
    // Таблица: analytics_cache — кеш предвычисленной аналитики
    // -----------------------------------------------------------------------
    db.run(`
      CREATE TABLE IF NOT EXISTS analytics_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cache_key TEXT NOT NULL UNIQUE,
        cache_data TEXT NOT NULL,
        computed_at INTEGER NOT NULL,
        valid_until INTEGER,
        computation_time_ms INTEGER
      );
    `);

    // -----------------------------------------------------------------------
    // Индексы: file_edits
    // -----------------------------------------------------------------------
    db.run(`CREATE INDEX IF NOT EXISTS idx_file_edits_path ON file_edits(file_path);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_file_edits_session ON file_edits(session_id);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_file_edits_timestamp ON file_edits(timestamp);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_file_edits_path_ts ON file_edits(file_path, timestamp);`);

    // -----------------------------------------------------------------------
    // Индексы: sessions
    // -----------------------------------------------------------------------
    db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_root);`);

    // -----------------------------------------------------------------------
    // Индексы: session_errors
    // -----------------------------------------------------------------------
    db.run(`CREATE INDEX IF NOT EXISTS idx_errors_session ON session_errors(session_id);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_errors_file ON session_errors(context_file);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_errors_type ON session_errors(error_type);`);

    // -----------------------------------------------------------------------
    // Индексы: tool_executions
    // -----------------------------------------------------------------------
    db.run(`CREATE INDEX IF NOT EXISTS idx_tool_session ON tool_executions(session_id);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_tool_name ON tool_executions(tool_name);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_tool_file ON tool_executions(target_file);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_tool_ts ON tool_executions(timestamp);`);

    // -----------------------------------------------------------------------
    // Индексы: decisions
    // -----------------------------------------------------------------------
    db.run(`CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(status);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_decisions_tags ON decisions(tags);`);

    // -----------------------------------------------------------------------
    // Индексы: knowledge_nodes
    // -----------------------------------------------------------------------
    db.run(`CREATE INDEX IF NOT EXISTS idx_kn_type ON knowledge_nodes(node_type);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_kn_path ON knowledge_nodes(path);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_kn_name ON knowledge_nodes(name);`);

    // -----------------------------------------------------------------------
    // Индексы: knowledge_edges
    // -----------------------------------------------------------------------
    db.run(`CREATE INDEX IF NOT EXISTS idx_ke_source ON knowledge_edges(source_id);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ke_target ON knowledge_edges(target_id);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ke_type ON knowledge_edges(edge_type);`);

    // -----------------------------------------------------------------------
    // Индексы: developer_events
    // -----------------------------------------------------------------------
    db.run(`CREATE INDEX IF NOT EXISTS idx_dev_type ON developer_events(event_type);`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_dev_ts ON developer_events(timestamp);`);

    // -----------------------------------------------------------------------
    // Индексы: analytics_cache
    // -----------------------------------------------------------------------
    db.run(`CREATE INDEX IF NOT EXISTS idx_cache_key ON analytics_cache(cache_key);`);

    // -----------------------------------------------------------------------
    // Настройки производительности
    // -----------------------------------------------------------------------
    db.run("PRAGMA journal_mode=WAL");
    db.run("PRAGMA busy_timeout=5000");
    db.run("PRAGMA foreign_keys=ON");

    // -----------------------------------------------------------------------
    // Запись версии схемы
    // -----------------------------------------------------------------------
    const insertVersion = db.prepare(
      `INSERT INTO schema_version (version, applied_at, description) VALUES (?1, ?2, ?3)`,
    );
    insertVersion.run(1, now, "Initial schema — all tables, indexes, WAL mode");

  })();
}
