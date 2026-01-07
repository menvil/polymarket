/**
 * Formatter Interface для сериализации данных
 *
 * @remarks
 * Определяет контракт для форматирования данных перед записью.
 * Поддерживаемые форматы: NDJSON, Parquet, Arrow.
 *
 * @example
 * ```typescript
 * const formatter: IFormatter = new NDJSONFormatter();
 * const line = formatter.formatRecord({ event_type: 'book', ... });
 * // '{"event_type":"book",...}\n'
 * ```
 *
 * @module infrastructure/persistence/data-collection/formatters
 */

/**
 * Тип формата данных
 */
export type DataFormat = 'ndjson' | 'parquet' | 'arrow';

/**
 * Formatter Interface
 *
 * @remarks
 * Strategy pattern для форматирования данных.
 * Каждый формат имеет свою реализацию.
 */
export interface IFormatter {
  /**
   * Расширение файла (без точки)
   * @example 'jsonl', 'parquet', 'arrow'
   */
  readonly extension: string;

  /**
   * Название формата
   */
  readonly format: DataFormat;

  /**
   * Поддерживает ли потоковую запись
   *
   * @remarks
   * - true: можно писать построчно (NDJSON)
   * - false: требуется batch запись (Parquet, Arrow)
   */
  supportsStreaming(): boolean;

  /**
   * Форматирует одну запись
   *
   * @param record - Объект для сериализации
   * @returns Сериализованные данные (string или Buffer)
   *
   * @remarks
   * Для streaming форматов (NDJSON) возвращает строку с \n
   * Для batch форматов может накапливать записи
   */
  formatRecord(record: object): string | Buffer;

  /**
   * Форматирует batch записей (для non-streaming форматов)
   *
   * @param records - Массив объектов
   * @returns Сериализованные данные
   */
  formatBatch?(records: object[]): Buffer;

  /**
   * Финализирует запись (для batch форматов)
   *
   * @remarks
   * Для Parquet/Arrow - записывает footer и завершает файл
   */
  finalize?(): Buffer | null;
}
