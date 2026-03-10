/**
 * GzipJsonlSnapshotReader — чтение сжатых NDJSON файлов (.jsonl.gz).
 *
 * @remarks
 * Распаковывает файл во временный файл на первом вызове `readLines()`.
 * Временный файл ОБЯЗАТЕЛЬНО удаляется в `close()`.
 *
 * ### Именование временного файла:
 * `{baseName}.decompressed.{process.pid}.tmp`
 *
 * ### ВАЖНО:
 * Всегда вызывайте `close()` в блоке `finally` для очистки временного файла.
 *
 * @example
 * ```typescript
 * const reader = new GzipJsonlSnapshotReader('./data/market.jsonl.gz', logger);
 * try {
 *   for await (const line of reader.readLines()) {
 *     // обработка
 *   }
 * } finally {
 *   await reader.close(); // удаляет временный файл
 * }
 * ```
 */
import { createReadStream, createWriteStream, unlink, existsSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { ILogger } from '@polymarket/logger';
import { JsonlSnapshotReader } from './JsonlSnapshotReader.js';
import type { ISnapshotReader } from './ISnapshotReader.js';

const unlinkAsync = promisify(unlink);

export class GzipJsonlSnapshotReader implements ISnapshotReader {
  private _decompressedPath: string | null = null;
  private _innerReader: JsonlSnapshotReader | null = null;

  /**
   * @param _filePath - Путь к .jsonl.gz файлу
   * @param _logger - Логгер
   */
  constructor(
    private readonly _filePath: string,
    private readonly _logger: ILogger,
  ) {}

  /**
   * Распаковывает файл во временный и читает построчно.
   *
   * @remarks
   * При первом вызове выполняет декомпрессию через `_decompress()`.
   * Последующие вызовы используют уже существующий временный файл.
   *
   * @yields Строки файла (непустые)
   */
  public async *readLines(): AsyncGenerator<string, void, undefined> {
    if (!this._decompressedPath) {
      await this._decompress();
    }

    const innerReader = new JsonlSnapshotReader(this._decompressedPath!);
    this._innerReader = innerReader;

    yield* innerReader.readLines();
  }

  /**
   * Закрывает ресурсы и удаляет временный файл.
   *
   * @remarks
   * Безопасен при вызове без предварительного `readLines()`.
   * Логирует предупреждение если не удалось удалить временный файл.
   */
  public async close(): Promise<void> {
    await this._innerReader?.close();
    this._innerReader = null;

    if (this._decompressedPath && existsSync(this._decompressedPath)) {
      try {
        await unlinkAsync(this._decompressedPath);
        this._logger.debug('Temp decompressed file deleted', { path: this._decompressedPath });
      } catch (err) {
        this._logger.warn('Failed to delete temp decompressed file', {
          path: this._decompressedPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this._decompressedPath = null;
    }
  }

  /**
   * Возвращает путь к исходному .gz файлу.
   *
   * @returns Абсолютный путь к .jsonl.gz файлу
   */
  public getFilePath(): string {
    return this._filePath;
  }

  /**
   * Распаковывает .jsonl.gz во временный файл.
   *
   * @remarks
   * Имя временного файла: `{base}.decompressed.{process.pid}.tmp`
   * Использует Node.js stream pipeline для эффективной потоковой декомпрессии.
   *
   * @throws {Error} При ошибке чтения исходного файла или записи временного
   */
  private async _decompress(): Promise<void> {
    const base = this._filePath.replace(/\.gz$/, '');
    this._decompressedPath = `${base}.decompressed.${process.pid}.tmp`;

    this._logger.debug('Decompressing snapshot file', {
      source: this._filePath,
      target: this._decompressedPath,
    });

    await pipeline(
      createReadStream(this._filePath),
      createGunzip(),
      createWriteStream(this._decompressedPath),
    );
  }
}
