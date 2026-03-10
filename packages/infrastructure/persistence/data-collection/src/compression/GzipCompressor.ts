/**
 * GzipCompressor — сжатие файлов через Node.js zlib.
 *
 * @remarks
 * Используется для сжатия `.jsonl` файлов в `.jsonl.gz` после завершения записи.
 * Применяет максимальный уровень сжатия (Z_BEST_COMPRESSION = 9).
 *
 * @example
 * ```typescript
 * const compressor = new GzipCompressor();
 * const gzPath = await compressor.compressFile('./data/market.jsonl');
 * // → './data/market.jsonl.gz' (оригинал удалён)
 * ```
 */
import { createReadStream, createWriteStream, unlink } from 'node:fs';
import { createGzip, constants as zlibConstants } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const unlinkAsync = promisify(unlink);

export class GzipCompressor {
  /**
   * Сжимает файл в `.gz` формат.
   *
   * @param filePath - Путь к исходному файлу
   * @param deleteOriginal - Удалить оригинал после сжатия (default: true)
   * @returns Путь к сжатому файлу (filePath + '.gz')
   *
   * @throws При ошибке чтения/записи файла
   */
  async compressFile(filePath: string, deleteOriginal = true): Promise<string> {
    const gzPath = `${filePath}.gz`;

    await pipeline(
      createReadStream(filePath),
      createGzip({ level: zlibConstants.Z_BEST_COMPRESSION }),
      createWriteStream(gzPath),
    );

    if (deleteOriginal) {
      await unlinkAsync(filePath);
    }

    return gzPath;
  }

  /**
   * Возвращает путь к сжатой версии файла.
   *
   * @param filePath - Путь к исходному файлу
   * @returns Путь с суффиксом `.gz`
   */
  getCompressedPath(filePath: string): string {
    return `${filePath}.gz`;
  }
}
