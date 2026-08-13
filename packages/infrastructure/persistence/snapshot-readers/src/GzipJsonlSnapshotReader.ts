/**
 * GzipJsonlSnapshotReader — чтение сжатых NDJSON файлов (.jsonl.gz).
 *
 * @remarks
 * Читает файл потоково: createReadStream → createGunzip → readline.
 * Временные распакованные файлы не создаются.
 *
 * ### ВАЖНО:
 * Вызывайте `close()` в блоке `finally`, если чтение прерывается досрочно.
 *
 * @example
 * ```typescript
 * const reader = new GzipJsonlSnapshotReader('./data/market.jsonl.gz', logger);
 * try {
 *   for await (const line of reader.readLines()) {
 *     // обработка
 *   }
 * } finally {
 *   await reader.close(); // закрывает открытые stream/readline ресурсы
 * }
 * ```
 */
import { createReadStream, type ReadStream } from 'node:fs';
import { createInterface, type Interface as RlInterface } from 'node:readline';
import { createGunzip, type Gunzip } from 'node:zlib';
import type { ILogger } from '@polymarket/logger';
import type { ISnapshotReader } from './ISnapshotReader.js';

export class GzipJsonlSnapshotReader implements ISnapshotReader {
  private _rl: RlInterface | null = null;
  private _sourceStream: ReadStream | null = null;
  private _gunzip: Gunzip | null = null;

  /**
   * @param _filePath - Путь к .jsonl.gz файлу
   * @param _logger - Логгер
   */
  constructor(
    private readonly _filePath: string,
    private readonly _logger: ILogger,
  ) {}

  /**
   * Потоково распаковывает файл и читает построчно.
   *
   * @remarks
   * Не пишет распакованные данные на диск.
   *
   * @yields Строки файла (непустые)
   */
  public async *readLines(): AsyncGenerator<string, void, undefined> {
    const sourceStream = createReadStream(this._filePath);
    const gunzip = createGunzip();
    const rl = createInterface({
      input: sourceStream.pipe(gunzip),
      crlfDelay: Infinity,
    });

    this._sourceStream = sourceStream;
    this._gunzip = gunzip;
    this._rl = rl;

    this._logger.debug('Streaming gzip snapshot file', { source: this._filePath });

    try {
      for await (const line of rl) {
        if (line.trim().length > 0) {
          yield line;
        }
      }
    } finally {
      this._cleanupStreams();
    }
  }

  /**
   * Закрывает открытые stream/readline ресурсы.
   *
   * @remarks
   * Безопасен при вызове без предварительного `readLines()`.
   */
  public async close(): Promise<void> {
    this._cleanupStreams();
  }

  /**
   * Возвращает путь к исходному .gz файлу.
   *
   * @returns Абсолютный путь к .jsonl.gz файлу
   */
  public getFilePath(): string {
    return this._filePath;
  }

  private _cleanupStreams(): void {
    this._rl?.close();
    this._rl = null;
    this._sourceStream?.destroy();
    this._sourceStream = null;
    this._gunzip?.destroy();
    this._gunzip = null;
  }
}
