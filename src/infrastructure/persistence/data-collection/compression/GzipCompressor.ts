/**
 * Gzip Compressor для сжатия файлов данных
 *
 * @remarks
 * Использует встроенный Node.js zlib модуль для сжатия.
 * Применяется при финализации маркета (когда он истёк).
 *
 * Преимущества gzip:
 * - Встроен в Node.js (не требует зависимостей)
 * - Хорошее сжатие для JSON данных (70-90% уменьшение)
 * - Широко поддерживается (можно открыть любым архиватором)
 *
 * @example
 * ```typescript
 * const compressor = new GzipCompressor();
 *
 * // Сжать файл
 * await compressor.compressFile('/path/to/file.jsonl');
 * // Создаст /path/to/file.jsonl.gz и удалит оригинал
 *
 * // Проверить нужно ли сжимать
 * if (compressor.shouldCompress('/path/to/file.jsonl')) {
 *   await compressor.compressFile('/path/to/file.jsonl');
 * }
 * ```
 *
 * @module infrastructure/persistence/data-collection/compression
 */

import * as fs from 'fs';
import * as zlib from 'zlib';
import { pipeline } from 'stream/promises';

/**
 * Тип сжатия
 */
export type CompressionType = 'none' | 'gzip';

/**
 * Gzip Compressor
 *
 * @remarks
 * Сжимает файлы с помощью gzip алгоритма.
 * Использует streaming для эффективной работы с большими файлами.
 */
export class GzipCompressor {
  /**
   * Расширение сжатых файлов
   */
  readonly extension = '.gz';

  /**
   * Сжимает файл
   *
   * @param filePath - Путь к файлу для сжатия
   * @param deleteOriginal - Удалить оригинальный файл после сжатия (default: true)
   * @returns Путь к сжатому файлу
   *
   * @throws {Error} Если файл не существует или ошибка сжатия
   *
   * @example
   * ```typescript
   * const gzPath = await compressor.compressFile('/data/file.jsonl');
   * // '/data/file.jsonl.gz'
   * ```
   */
  async compressFile(filePath: string, deleteOriginal = true): Promise<string> {
    const gzPath = filePath + this.extension;

    // Создаём read и write streams
    const source = fs.createReadStream(filePath);
    const destination = fs.createWriteStream(gzPath);
    const gzip = zlib.createGzip({
      level: zlib.constants.Z_BEST_COMPRESSION, // Максимальное сжатие
    });

    // Streaming pipeline: file → gzip → file.gz
    await pipeline(source, gzip, destination);

    // Удаляем оригинал если нужно
    if (deleteOriginal) {
      await fs.promises.unlink(filePath);
    }

    return gzPath;
  }

  /**
   * Проверяет, нужно ли сжимать файл
   *
   * @param filePath - Путь к файлу
   * @returns true если файл не сжат и существует
   */
  shouldCompress(filePath: string): boolean {
    // Уже сжат
    if (filePath.endsWith(this.extension)) {
      return false;
    }

    // Проверяем существование
    return fs.existsSync(filePath);
  }

  /**
   * Получает путь к сжатому файлу
   *
   * @param filePath - Оригинальный путь
   * @returns Путь с .gz расширением
   */
  getCompressedPath(filePath: string): string {
    return filePath + this.extension;
  }

  /**
   * Получает оригинальный путь из сжатого
   *
   * @param gzPath - Путь к .gz файлу
   * @returns Оригинальный путь без .gz
   */
  getOriginalPath(gzPath: string): string {
    if (gzPath.endsWith(this.extension)) {
      return gzPath.slice(0, -this.extension.length);
    }
    return gzPath;
  }
}
