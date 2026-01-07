/**
 * Snapshot Scanner
 *
 * @remarks
 * Сканирует директорию snapshots/ и находит все .jsonl и .jsonl.gz файлы.
 * Поддерживает фильтрацию по датам.
 *
 * Структура директорий:
 * ```
 * snapshots/
 *   2026-01-01/
 *     market1.jsonl
 *     market2.jsonl.gz
 *   2026-01-02/
 *     market3.jsonl.gz
 * ```
 *
 * @example
 * ```typescript
 * const scanner = new SnapshotScanner('./snapshots', logger);
 *
 * const files = await scanner.scan({
 *   fromDate: '2026-01-01',
 *   toDate: '2026-01-05'
 * });
 *
 * console.log(`Found ${files.length} snapshot files`);
 * ```
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ILogger } from '../../../domain/ports/ILogger.js';
import type { SnapshotFileInfo } from './ISnapshotReader.js';

/**
 * Scan options
 */
export interface ScanOptions {
  /** Start date (YYYY-MM-DD), inclusive */
  fromDate?: string;
  /** End date (YYYY-MM-DD), inclusive */
  toDate?: string;
}

/**
 * Scan result
 */
export interface ScanResult {
  /** All snapshot files found */
  files: SnapshotFileInfo[];
  /** Total files count */
  totalFiles: number;
  /** Total size in bytes */
  totalSizeBytes: number;
  /** Date range scanned */
  dateRange: {
    from: string;
    to: string;
  };
  /** Dates with files */
  datesFound: string[];
}

/**
 * Snapshot Scanner
 */
export class SnapshotScanner {
  private readonly inputDir: string;
  private readonly logger: ILogger;

  constructor(inputDir: string, logger: ILogger) {
    this.inputDir = inputDir;
    this.logger = logger;
  }

  /**
   * Scan for snapshot files
   *
   * @param options - Scan options (date filters)
   * @returns Scan result with file list
   *
   * @throws {Error} If input directory doesn't exist
   *
   * @remarks
   * Algorithm:
   * 1. List all YYYY-MM-DD folders in inputDir
   * 2. Filter by date range if specified
   * 3. For each folder: find all .jsonl and .jsonl.gz files
   * 4. Sort by date and filename
   * 5. Return aggregated result
   */
  async scan(options: ScanOptions = {}): Promise<ScanResult> {
    this.logger.info('Scanning snapshots', {
      inputDir: this.inputDir,
      fromDate: options.fromDate,
      toDate: options.toDate,
    });

    // Check input dir exists
    if (!fs.existsSync(this.inputDir)) {
      throw new Error(`Input directory not found: ${this.inputDir}`);
    }

    // Get all date folders
    const dateFolders = await this.getDateFolders();

    // Filter by date range
    const filteredDates = this.filterDateRange(dateFolders, options);

    // Scan each date folder
    const allFiles: SnapshotFileInfo[] = [];
    let totalSize = 0;

    for (const date of filteredDates) {
      const folderPath = path.join(this.inputDir, date);
      const files = await this.scanFolder(folderPath, date);

      allFiles.push(...files);
      totalSize += files.reduce((sum, f) => sum + f.sizeBytes, 0);
    }

    // Sort by date then filename
    allFiles.sort((a, b) => {
      if (a.date !== b.date) {
        return a.date.localeCompare(b.date);
      }
      return a.fileName.localeCompare(b.fileName);
    });

    const result: ScanResult = {
      files: allFiles,
      totalFiles: allFiles.length,
      totalSizeBytes: totalSize,
      dateRange: {
        from: filteredDates[0] || 'N/A',
        to: filteredDates[filteredDates.length - 1] || 'N/A',
      },
      datesFound: filteredDates,
    };

    this.logger.info('Scan complete', {
      totalFiles: result.totalFiles,
      totalSizeMB: (result.totalSizeBytes / (1024 * 1024)).toFixed(2),
      dateRange: result.dateRange,
    });

    return result;
  }

  /**
   * Get all YYYY-MM-DD folders
   */
  private async getDateFolders(): Promise<string[]> {
    const entries = await fs.promises.readdir(this.inputDir, {
      withFileTypes: true,
    });

    const dateFolders: string[] = [];
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;

    for (const entry of entries) {
      if (entry.isDirectory() && datePattern.test(entry.name)) {
        dateFolders.push(entry.name);
      }
    }

    // Sort chronologically
    dateFolders.sort();

    return dateFolders;
  }

  /**
   * Filter date folders by range
   */
  private filterDateRange(dates: string[], options: ScanOptions): string[] {
    let filtered = dates;

    if (options.fromDate) {
      filtered = filtered.filter(date => date >= options.fromDate!);
    }

    if (options.toDate) {
      filtered = filtered.filter(date => date <= options.toDate!);
    }

    return filtered;
  }

  /**
   * Scan single date folder for .jsonl and .jsonl.gz files
   */
  private async scanFolder(
    folderPath: string,
    date: string
  ): Promise<SnapshotFileInfo[]> {
    const files: SnapshotFileInfo[] = [];

    try {
      const entries = await fs.promises.readdir(folderPath, {
        withFileTypes: true,
      });

      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }

        const fileName = entry.name;

        // Check if .jsonl or .jsonl.gz
        const isJsonl = fileName.endsWith('.jsonl');
        const isGzipped = fileName.endsWith('.jsonl.gz');

        if (!isJsonl && !isGzipped) {
          continue;
        }

        const filePath = path.join(folderPath, fileName);
        const stats = await fs.promises.stat(filePath);

        files.push({
          filePath,
          date,
          fileName,
          isGzipped,
          sizeBytes: stats.size,
        });
      }
    } catch (error) {
      this.logger.warn('Failed to scan folder', {
        folder: folderPath,
        error,
      });
    }

    return files;
  }
}
