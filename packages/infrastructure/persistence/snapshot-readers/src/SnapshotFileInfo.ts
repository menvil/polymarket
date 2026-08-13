/**
 * Метаданные файла снапшота.
 */
export interface SnapshotFileInfo {
  /** Абсолютный путь к файлу */
  readonly filePath: string;
  /** Дата в формате YYYY-MM-DD (из директории) */
  readonly date: string;
  /** Имя файла (без директории) */
  readonly fileName: string;
  /** Сжатый ли файл (.jsonl.gz) */
  readonly isGzipped: boolean;
  /** Размер файла в байтах */
  readonly sizeBytes: number;
}
