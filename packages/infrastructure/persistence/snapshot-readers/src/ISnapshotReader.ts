/**
 * Интерфейс чтения снапшотов рыночных данных.
 *
 * @remarks
 * Предоставляет единый API для чтения `.jsonl` и `.jsonl.gz` файлов.
 * Использует async generator для memory-efficient построчного чтения
 * без загрузки всего файла в память.
 *
 * @example
 * ```typescript
 * const reader = factory.create('./data/market.jsonl.gz');
 * try {
 *   for await (const line of reader.readLines()) {
 *     const event = JSON.parse(line);
 *     // обработка события
 *   }
 * } finally {
 *   await reader.close();
 * }
 * ```
 */
export interface ISnapshotReader {
  /**
   * Возвращает async generator строк файла.
   *
   * @remarks
   * - Пропускает пустые строки
   * - Каждая строка — валидный JSON (без `\n`)
   * - Генератор автоматически завершается в конце файла
   */
  readLines(): AsyncGenerator<string, void, undefined>;

  /**
   * Закрывает ресурсы (потоки, временные файлы).
   *
   * @remarks
   * ОБЯЗАТЕЛЕН к вызову — GzipJsonlSnapshotReader удаляет временный файл.
   * Используйте try/finally для гарантированного вызова.
   */
  close(): Promise<void>;

  /**
   * Возвращает путь к исходному файлу.
   */
  getFilePath(): string;
}
