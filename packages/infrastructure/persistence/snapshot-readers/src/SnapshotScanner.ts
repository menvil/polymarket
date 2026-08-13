/**
 * SnapshotScanner — сканирование директории снапшотов.
 *
 * @remarks
 * Сканирует структуру `outputDir/YYYY-MM-DD/*.jsonl(.gz)` и возвращает
 * список файлов с фильтрацией по дате и рынку.
 *
 * ### Структура директории:
 * ```
 * outputDir/
 *   2026-01-01/
 *     Market_Question___0xabc.jsonl.gz
 *     Another_Market___0xdef.jsonl
 *   2026-01-02/
 *     ...
 * ```
 *
 * @example
 * ```typescript
 * const scanner = new SnapshotScanner('./data/snapshots', logger);
 * const result = await scanner.scan({ fromDate: '2026-01-01', toDate: '2026-01-07' });
 * console.log(result.totalFiles, result.totalSizeBytes);
 * ```
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ILogger } from '@polymarket/logger';
import type { SnapshotFileInfo } from './SnapshotFileInfo.js';

/**
 * Параметры сканирования.
 */
export interface ScanOptions {
  /** Начальная дата включительно (YYYY-MM-DD) */
  readonly fromDate?: string;
  /** Конечная дата включительно (YYYY-MM-DD) */
  readonly toDate?: string;
  /** Фильтр по marketId (substring match в имени файла) */
  readonly marketId?: string;
}

/**
 * Результат сканирования.
 */
export interface ScanResult {
  /** Найденные файлы, отсортированные по дате и имени */
  readonly files: SnapshotFileInfo[];
  /** Общее количество файлов */
  readonly totalFiles: number;
  /** Суммарный размер в байтах */
  readonly totalSizeBytes: number;
  /** Диапазон найденных дат */
  readonly dateRange: { readonly from: string; readonly to: string } | null;
  /** Список уникальных дат с данными */
  readonly datesFound: readonly string[];
}

export class SnapshotScanner {
  private readonly _logger: ILogger;

  /**
   * @param _inputDir - Корневая директория снапшотов
   * @param logger - Логгер
   */
  constructor(
    private readonly _inputDir: string,
    logger: ILogger,
  ) {
    this._logger = logger.child({ component: 'SnapshotScanner' });
  }

  /**
   * Сканирует директорию и возвращает список файлов.
   *
   * @remarks
   * Алгоритм:
   * 1. Проверяет существование `_inputDir`.
   * 2. Считывает подпапки вида `YYYY-MM-DD`.
   * 3. Фильтрует по `fromDate`/`toDate`.
   * 4. Для каждой папки собирает `.jsonl` и `.jsonl.gz` файлы.
   * 5. Применяет фильтр по `marketId` (substring в имени файла).
   * 6. Сортирует результат по дате, затем по имени файла.
   *
   * @param options - Параметры фильтрации
   * @returns Результат сканирования
   */
  async scan(options: ScanOptions = {}): Promise<ScanResult> {
    this._logger.debug('Scanning snapshot directory', {
      inputDir: this._inputDir,
      ...options,
    });

    if (!fs.existsSync(this._inputDir)) {
      this._logger.warn('Snapshot directory does not exist', { dir: this._inputDir });
      return this._emptyResult();
    }

    const dateFolders = await this._getDateFolders();
    const filtered = this._filterByDateRange(dateFolders, options);

    const allFiles: SnapshotFileInfo[] = [];
    for (const date of filtered) {
      const files = await this._scanFolder(path.join(this._inputDir, date), date, options);
      allFiles.push(...files);
    }

    // Сортируем по дате, затем по имени
    allFiles.sort((a, b) =>
      a.date !== b.date ? a.date.localeCompare(b.date) : a.fileName.localeCompare(b.fileName),
    );

    const totalSizeBytes = allFiles.reduce((sum, f) => sum + f.sizeBytes, 0);
    const datesFound = [...new Set(allFiles.map((f) => f.date))].sort();

    this._logger.debug('Scan complete', {
      totalFiles: allFiles.length,
      totalSizeBytes,
      datesFound: datesFound.length,
    });

    return {
      files: allFiles,
      totalFiles: allFiles.length,
      totalSizeBytes,
      dateRange:
        datesFound.length > 0
          ? { from: datesFound[0], to: datesFound[datesFound.length - 1] }
          : null,
      datesFound,
    };
  }

  // ── Приватные методы ──────────────────────────────────────────────────────

  /**
   * Возвращает список папок вида YYYY-MM-DD из корневой директории.
   *
   * @returns Массив имён папок, отсортированный по возрастанию
   */
  private async _getDateFolders(): Promise<string[]> {
    const entries = fs.readdirSync(this._inputDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
      .map((e) => e.name)
      .sort();
  }

  /**
   * Фильтрует папки по диапазону дат.
   *
   * @param dates - Список имён папок вида YYYY-MM-DD
   * @param options - Параметры с `fromDate` и `toDate`
   * @returns Отфильтрованный список
   */
  private _filterByDateRange(dates: string[], options: ScanOptions): string[] {
    return dates.filter((date) => {
      if (options.fromDate && date < options.fromDate) return false;
      if (options.toDate && date > options.toDate) return false;
      return true;
    });
  }

  /**
   * Сканирует одну папку с датой.
   *
   * @param folderPath - Абсолютный путь к папке
   * @param date - Дата в формате YYYY-MM-DD
   * @param options - Параметры фильтрации (marketId)
   * @returns Список метаданных файлов в папке
   */
  private async _scanFolder(
    folderPath: string,
    date: string,
    options: ScanOptions,
  ): Promise<SnapshotFileInfo[]> {
    if (!fs.existsSync(folderPath)) return [];

    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    const results: SnapshotFileInfo[] = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const fileName = entry.name;
      if (!fileName.endsWith('.jsonl') && !fileName.endsWith('.jsonl.gz')) continue;

      // Фильтр по marketId (substring в имени файла)
      if (options.marketId && !fileName.includes(options.marketId)) continue;

      const filePath = path.join(folderPath, fileName);
      const stat = fs.statSync(filePath);

      results.push({
        filePath,
        date,
        fileName,
        isGzipped: fileName.endsWith('.jsonl.gz'),
        sizeBytes: stat.size,
      });
    }

    return results;
  }

  /**
   * Возвращает пустой результат сканирования.
   *
   * @returns ScanResult с нулевыми значениями
   */
  private _emptyResult(): ScanResult {
    return {
      files: [],
      totalFiles: 0,
      totalSizeBytes: 0,
      dateRange: null,
      datesFound: [],
    };
  }
}
