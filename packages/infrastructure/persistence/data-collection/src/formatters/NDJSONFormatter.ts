/**
 * NDJSONFormatter — сериализация в формат Newline Delimited JSON.
 *
 * @remarks
 * Каждая запись — одна строка JSON, заканчивается `\n`.
 * Формат совместим с большинством стриминговых парсеров и читается `readline`.
 *
 * @example
 * ```typescript
 * const fmt = new NDJSONFormatter();
 * const line = fmt.formatRecord({ event_type: 'book', ts: 1234 });
 * // → '{"event_type":"book","ts":1234}\n'
 * ```
 */
import type { IFormatter } from './IFormatter.js';

export class NDJSONFormatter implements IFormatter {
  readonly extension = 'jsonl';

  /**
   * Сериализует объект в JSON-строку с завершающим символом новой строки.
   *
   * @param record - Объект для сериализации
   * @returns JSON-строка с `\n` в конце
   */
  formatRecord(record: object): string {
    return JSON.stringify(record) + '\n';
  }
}
