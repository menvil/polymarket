/**
 * NDJSON (Newline Delimited JSON) Formatter
 *
 * @remarks
 * Форматирует данные в NDJSON (JSON Lines) формат.
 * Один JSON объект на строку, разделённые \n.
 *
 * Преимущества NDJSON:
 * - Простой формат, легко читать и парсить
 * - Streaming-friendly: можно читать построчно
 * - Human-readable: можно открыть в текстовом редакторе
 * - Append-friendly: можно дописывать в конец файла
 *
 * @example
 * ```typescript
 * const formatter = new NDJSONFormatter();
 *
 * const line1 = formatter.formatRecord({ event_type: 'book', bids: [...] });
 * // '{"event_type":"book","bids":[...]}\n'
 *
 * const line2 = formatter.formatRecord({ event_type: 'trade', price: '0.5' });
 * // '{"event_type":"trade","price":"0.5"}\n'
 * ```
 *
 * @module infrastructure/persistence/data-collection/formatters
 */

import type { IFormatter, DataFormat } from './IFormatter.js';

/**
 * NDJSON Formatter
 *
 * @remarks
 * Самый простой форматтер - JSON.stringify + newline.
 * Сохраняет данные как есть без преобразований.
 */
export class NDJSONFormatter implements IFormatter {
  /**
   * Расширение файла
   */
  readonly extension = 'jsonl';

  /**
   * Название формата
   */
  readonly format: DataFormat = 'ndjson';

  /**
   * NDJSON поддерживает потоковую запись
   */
  supportsStreaming(): boolean {
    return true;
  }

  /**
   * Форматирует одну запись в JSON строку с newline
   *
   * @param record - Объект для сериализации
   * @returns JSON строка с \n в конце
   *
   * @example
   * ```typescript
   * formatter.formatRecord({ a: 1, b: 'test' });
   * // '{"a":1,"b":"test"}\n'
   * ```
   */
  formatRecord(record: object): string {
    return JSON.stringify(record) + '\n';
  }

  /**
   * Форматирует batch записей
   *
   * @param records - Массив объектов
   * @returns Buffer с JSON строками
   */
  formatBatch(records: object[]): Buffer {
    const lines = records.map((r) => JSON.stringify(r) + '\n').join('');
    return Buffer.from(lines, 'utf-8');
  }
}
