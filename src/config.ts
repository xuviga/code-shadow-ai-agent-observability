// =============================================================================
// Code Shadow — Конфигурация плагина
// Загружает config.json из директории плагина, сливает со значениями по умолчанию.
// =============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ShadowConfig } from "./types";

// ---------------------------------------------------------------------------
// Конфигурация по умолчанию
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: ShadowConfig = {
  dbPath: path.join(os.homedir(), ".config", "opencode", "shadow", "data.db"),
  retentionDays: 90,
  sessionRetentionDays: 365,
  batchSize: 10,
  flushIntervalMs: 5000,
  riskWarningThreshold: 0.6,
  riskErrorThreshold: 0.8,
  analyticsRecomputeIntervalMs: 3_600_000, // 1 час
  maxDiffPreviewChars: 500,
  maxArgsPreviewChars: 200,
  disabledEventTypes: [],
  secretPatterns: [
    // .env файлы
    "(?:^|\\W)DB_(?:PASSWORD|USER|NAME|HOST|PORT|URL)\\s*=\\s*\\S+",
    "(?:^|\\W)API_KEY\\s*=\\s*\\S+",
    "(?:^|\\W)SECRET(?:_KEY)?\\s*=\\s*\\S+",
    "(?:^|\\W)JWT_SECRET\\s*=\\s*\\S+",
    "(?:^|\\W)ENCRYPTION_KEY\\s*=\\s*\\S+",
    // Пароли
    "(?:password|passwd|pwd)[\"']?\\s*[:=]\\s*[\"']?[^\"'\\s,;}]+",
    // Токены
    "(?:token|access_token|refresh_token|auth_token)[\"']?\\s*[:=]\\s*[\"']?[^\"'\\s,;}]+",
    // Ключи API и секреты
    "(?:api[_-]?key|apikey|secret|private[_-]?key)[\"']?\\s*[:=]\\s*[\"']?[^\"'\\s,;}]+",
    // AWS ключи
    "AKIA[0-9A-Z]{16}",
    // GitHub токены
    "gh[ps]_[0-9a-zA-Z]{36}",
    "github_pat_[0-9a-zA-Z_]{36,}",
    // Private keys (начало PEM)
    "-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----",
    // Bearer токены
    "Bearer\\s+[A-Za-z0-9\\-._~+/]+=*",
    // Строки подключения к БД
    "(?:mongodb|mysql|postgres|postgresql|redis|sqlite)://[^:]+:[^@]+@",
    // Общие секреты в JSON/YAML
    "\"(?:secret|token|password|key)\"\\s*:\\s*\"[^\"]+\"",
  ],
};

// ---------------------------------------------------------------------------
// Разрешение пути (~ → HOME)
// ---------------------------------------------------------------------------

/**
 * Разворачивает ~ в начале пути в домашнюю директорию пользователя.
 * На Windows: ~ → %USERPROFILE% (или HOME, если задана).
 */
export function resolvePath(rawPath: string): string {
  if (rawPath.startsWith("~")) {
    return path.join(os.homedir(), rawPath.slice(1));
  }
  return rawPath;
}

// ---------------------------------------------------------------------------
// Фильтрация секретов
// ---------------------------------------------------------------------------

/**
 * Заменяет найденные секреты в тексте на "[REDACTED]".
 * Использует secretPatterns из конфигурации.
 */
export function sanitizeContent(
  text: string,
  patterns: string[] = DEFAULT_CONFIG.secretPatterns,
): string {
  if (!text || patterns.length === 0) {
    return text;
  }

  let sanitized = text;
  for (const pattern of patterns) {
    try {
      const regex = new RegExp(pattern, "gi");
      sanitized = sanitized.replace(regex, (_match: string) => {
        return "[REDACTED]";
      });
    } catch {
      // Некорректное регулярное выражение — пропускаем
      continue;
    }
  }
  return sanitized;
}

// ---------------------------------------------------------------------------
// Загрузка конфигурации
// ---------------------------------------------------------------------------

/**
 * Загружает пользовательскую конфигурацию из config.json (рядом с package.json),
 * сливает со значениями по умолчанию. Отсутствующие ключи берутся из DEFAULT_CONFIG.
 */
export function loadConfig(
  pluginDir: string,
): ShadowConfig {
  const configPath = path.join(pluginDir, "config.json");
  let userConfig: Partial<ShadowConfig> = {};

  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      userConfig = normalizeUserConfig(parsed);
    } catch (err) {
      console.error(
        `[CodeShadow][config] Ошибка чтения config.json: ${String(err)}. Использую значения по умолчанию.`,
      );
    }
  }

  const merged: ShadowConfig = {
    dbPath: resolvePath(userConfig.dbPath ?? DEFAULT_CONFIG.dbPath),
    retentionDays: userConfig.retentionDays ?? DEFAULT_CONFIG.retentionDays,
    sessionRetentionDays:
      userConfig.sessionRetentionDays ?? DEFAULT_CONFIG.sessionRetentionDays,
    batchSize: userConfig.batchSize ?? DEFAULT_CONFIG.batchSize,
    flushIntervalMs:
      userConfig.flushIntervalMs ?? DEFAULT_CONFIG.flushIntervalMs,
    riskWarningThreshold:
      userConfig.riskWarningThreshold ?? DEFAULT_CONFIG.riskWarningThreshold,
    riskErrorThreshold:
      userConfig.riskErrorThreshold ?? DEFAULT_CONFIG.riskErrorThreshold,
    analyticsRecomputeIntervalMs:
      userConfig.analyticsRecomputeIntervalMs ??
      DEFAULT_CONFIG.analyticsRecomputeIntervalMs,
    maxDiffPreviewChars:
      userConfig.maxDiffPreviewChars ?? DEFAULT_CONFIG.maxDiffPreviewChars,
    maxArgsPreviewChars:
      userConfig.maxArgsPreviewChars ?? DEFAULT_CONFIG.maxArgsPreviewChars,
    disabledEventTypes:
      userConfig.disabledEventTypes ?? DEFAULT_CONFIG.disabledEventTypes,
    secretPatterns: userConfig.secretPatterns ?? DEFAULT_CONFIG.secretPatterns,
  };

  return merged;
}

/**
 * Приводит сырые ключи из config.json к ожидаемой структуре.
 * Игнорирует неизвестные ключи.
 */
function normalizeUserConfig(
  raw: Record<string, unknown>,
): Partial<ShadowConfig> {
  const result: Partial<ShadowConfig> = {};

  if (typeof raw.dbPath === "string") result.dbPath = raw.dbPath;
  if (typeof raw.retentionDays === "number")
    result.retentionDays = raw.retentionDays;
  if (typeof raw.sessionRetentionDays === "number")
    result.sessionRetentionDays = raw.sessionRetentionDays;
  if (typeof raw.batchSize === "number") result.batchSize = raw.batchSize;
  if (typeof raw.flushIntervalMs === "number")
    result.flushIntervalMs = raw.flushIntervalMs;
  if (typeof raw.riskWarningThreshold === "number")
    result.riskWarningThreshold = raw.riskWarningThreshold;
  if (typeof raw.riskErrorThreshold === "number")
    result.riskErrorThreshold = raw.riskErrorThreshold;
  if (typeof raw.analyticsRecomputeIntervalMs === "number")
    result.analyticsRecomputeIntervalMs = raw.analyticsRecomputeIntervalMs;
  if (typeof raw.maxDiffPreviewChars === "number")
    result.maxDiffPreviewChars = raw.maxDiffPreviewChars;
  if (typeof raw.maxArgsPreviewChars === "number")
    result.maxArgsPreviewChars = raw.maxArgsPreviewChars;
  if (Array.isArray(raw.disabledEventTypes))
    result.disabledEventTypes = raw.disabledEventTypes as string[];
  if (Array.isArray(raw.secretPatterns))
    result.secretPatterns = raw.secretPatterns as string[];

  return result;
}
