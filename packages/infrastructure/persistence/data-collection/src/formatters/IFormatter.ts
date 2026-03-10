/**
 * Интерфейс форматировщика записей.
 *
 * @remarks
 * Стратегия сериализации сырых событий в строку для записи в файл.
 * Текущая реализация: NDJSONFormatter (.jsonl).
 */
export interface IFormatter {
  /** Расширение файла без точки (например: 'jsonl') */
  readonly extension: string;

  /**
   * Форматирует объект в строку для записи.
   *
   * @param record - Объект для сериализации
   * @returns Строка готовая для записи (включает разделитель строк если нужно)
   */
  formatRecord(record: object): string;
}
