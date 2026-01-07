/**
 * Log panel component for displaying activity logs
 *
 * @remarks
 * Renders timestamped log messages with color coding by category and level.
 * Supports deduplication and auto-scrolling.
 *
 * @module infrastructure/ui/components/LogPanel
 */

import type { LogEntry, LogCategory, LogLevel, UIConfig } from '../types';

/**
 * Builds formatted log lines for display
 *
 * @param logs - Array of log entries
 * @param config - UI configuration
 * @param maxEntries - Maximum entries to display (newest)
 * @returns Array of formatted lines
 *
 * @remarks
 * Each line is formatted as: `[HH:MM:SS.mmm] [CATEGORY] message`
 * Color coding is applied based on log level:
 * - ERROR: red
 * - WARN: yellow
 * - INFO: white
 * - DEBUG: gray
 *
 * @example
 * ```typescript
 * const logs = [
 *   { timestamp: '12:34:56.123', message: 'Order placed', category: 'oms', level: 'INFO' },
 *   { timestamp: '12:34:57.456', message: 'Low liquidity', category: 'risk', level: 'WARN' }
 * ];
 * const lines = buildLogLines(logs, { asciiOnly: true }, 100);
 * ```
 */
export function buildLogLines(
  logs: LogEntry[],
  config: UIConfig,
  maxEntries = 100
): string[] {
  // Take last N entries
  const recentLogs = logs.slice(-maxEntries);

  return recentLogs.map((log) => formatLogLine(log, config));
}

/**
 * Format a single log entry
 *
 * @param log - Log entry
 * @param config - UI configuration
 * @returns Formatted line with blessed tags
 *
 * @example
 * ```typescript
 * formatLogLine({
 *   timestamp: '12:34:56.123',
 *   message: 'Order placed',
 *   category: 'oms',
 *   level: 'INFO'
 * }, { asciiOnly: true })
 * // => "{white-fg}[12:34:56.123] [OMS] Order placed{/white-fg}"
 * ```
 */
function formatLogLine(log: LogEntry, config: UIConfig): string {
  const color = getLevelColor(log.level);
  const categoryTag = formatCategory(log.category, config);
  const message = stripEmojiIfNeeded(log.message, config.asciiOnly);

  return `{${color}}[${log.timestamp}] ${categoryTag} ${message}{/${color}}`;
}

/**
 * Get blessed color tag for log level
 *
 * @param level - Log level
 * @returns Blessed color tag
 */
function getLevelColor(level: LogLevel): string {
  switch (level) {
    case 'ERROR':
      return 'red-fg';
    case 'WARN':
      return 'yellow-fg';
    case 'DEBUG':
      return 'gray-fg';
    case 'INFO':
    default:
      return 'white-fg';
  }
}

/**
 * Format category as short tag
 *
 * @param category - Log category
 * @param config - UI configuration
 * @returns Formatted category string
 */
function formatCategory(category: LogCategory, config: UIConfig): string {
  const icon = getCategoryIcon(category, config.asciiOnly);
  return `[${icon}]`;
}

/**
 * Get icon for category (emoji or ASCII)
 *
 * @param category - Log category
 * @param asciiOnly - Use ASCII symbols
 * @returns Icon string
 */
function getCategoryIcon(category: LogCategory, asciiOnly: boolean): string {
  const ICON_MAP: Record<LogCategory, { emoji: string; ascii: string }> = {
    system: { emoji: '⚙️', ascii: 'SYS' },
    oms: { emoji: '📝', ascii: 'OMS' },
    trade: { emoji: '💱', ascii: 'TRD' },
    flow: { emoji: '🌊', ascii: 'FLW' },
    quote: { emoji: '💰', ascii: 'QTE' },
    arb: { emoji: '🔥', ascii: 'ARB' },
    unwind: { emoji: '🚨', ascii: 'UWD' },
    error: { emoji: '❌', ascii: 'ERR' },
    risk: { emoji: '⚠️', ascii: 'RSK' },
    mode: { emoji: '🎯', ascii: 'MOD' },
    edge: { emoji: '📊', ascii: 'EDG' },
    panic: { emoji: '🚨', ascii: 'PNC' },
    debug: { emoji: '🔍', ascii: 'DBG' },
    mainloop: { emoji: '🔄', ascii: 'ML' },
  };

  const iconData = ICON_MAP[category];
  if (!iconData) return category.toUpperCase().substring(0, 3);
  return asciiOnly ? iconData.ascii : iconData.emoji;
}

/**
 * Strip emoji from message if ASCII-only mode
 *
 * @param message - Original message
 * @param asciiOnly - Whether to strip emoji
 * @returns Processed message
 *
 * @remarks
 * Replaces common emoji with ASCII equivalents
 */
function stripEmojiIfNeeded(message: string, asciiOnly: boolean): string {
  if (!asciiOnly) return message;

  return message
    .replace(/✅/g, '[+]')
    .replace(/❌/g, '[X]')
    .replace(/⚠️/g, '!')
    .replace(/🚨/g, '!!!')
    .replace(/💰/g, '$')
    .replace(/🔥/g, '!!')
    .replace(/🌊/g, '~')
    .replace(/⚙️/g, '*')
    .replace(/📝/g, '+')
    .replace(/💱/g, '<>')
    .replace(/🎯/g, 'o')
    .replace(/ℹ️/g, '[i]')
    .replace(/📊/g, '|')
    .replace(/💼/g, '[#]')
    .replace(/🎲/g, '?')
    .replace(/🛑/g, '[STOP]')
    .replace(/⏸️/g, '[PAUSE]')
    .replace(/🔄/g, '[REFRESH]')
    .replace(/📡/g, '[SIGNAL]')
    .replace(/⏰/g, '[TIME]')
    .replace(/📋/g, '[LIST]')
    .replace(/🔍/g, '[SEARCH]')
    .replace(/📈/g, '[UP]')
    .replace(/📉/g, '[DOWN]');
}

/**
 * Deduplicate consecutive identical log entries
 *
 * @param logs - Array of log entries
 * @returns Deduplicated array
 *
 * @remarks
 * Removes consecutive duplicate messages to reduce noise.
 * Only checks message content, not timestamp.
 *
 * @example
 * ```typescript
 * const logs = [
 *   { timestamp: '12:34:56', message: 'Tick', category: 'mainloop', level: 'DEBUG' },
 *   { timestamp: '12:34:57', message: 'Tick', category: 'mainloop', level: 'DEBUG' },
 *   { timestamp: '12:34:58', message: 'Order placed', category: 'oms', level: 'INFO' }
 * ];
 * const deduped = deduplicateLogs(logs);
 * // => [ { ..., message: 'Tick' }, { ..., message: 'Order placed' } ]
 * ```
 */
export function deduplicateLogs(logs: LogEntry[]): LogEntry[] {
  if (logs.length === 0) return [];

  const result: LogEntry[] = [logs[0]];

  for (let i = 1; i < logs.length; i++) {
    const current = logs[i];
    const previous = logs[i - 1];

    // Skip if same message as previous
    if (current.message === previous.message && current.category === previous.category) {
      continue;
    }

    result.push(current);
  }

  return result;
}
