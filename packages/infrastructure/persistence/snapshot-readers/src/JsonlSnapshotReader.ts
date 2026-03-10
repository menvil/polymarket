/**
 * JsonlSnapshotReader — построчное чтение NDJSON файла.
 *
 * @remarks
 * Использует `readline` для эффективного построчного чтения
 * без загрузки всего файла в память.
 *
 * @example
 * ```typescript
 * const reader = new JsonlSnapshotReader('./data/market.jsonl');
 * for await (const line of reader.readLines()) {
 *   const event = JSON.parse(line);
 * }
 * await reader.close();
 * ```
 */
import { createReadStream } from 'node:fs';
import { createInterface, type Interface as RlInterface } from 'node:readline';
import type { ISnapshotReader } from './ISnapshotReader.js';

export class JsonlSnapshotReader implements ISnapshotReader {
  private _rl: RlInterface | null = null;

  /**
   * @param _filePath - Путь к .jsonl файлу
   */
  constructor(private readonly _filePath: string) {}

  /**
   * Построчно читает файл через readline.
   *
   * @yields Строки файла (непустые)
   */
  public async *readLines(): AsyncGenerator<string, void, undefined> {
    const rl = createInterface({
      input: createReadStream(this._filePath),
      crlfDelay: Infinity,
    });
    this._rl = rl;

    for await (const line of rl) {
      if (line.trim().length > 0) {
        yield line;
      }
    }

    this._rl = null;
  }

  /**
   * Закрывает readline интерфейс если открыт.
   */
  public async close(): Promise<void> {
    this._rl?.close();
    this._rl = null;
  }

  /**
   * Возвращает путь к исходному файлу.
   *
   * @returns Абсолютный путь к .jsonl файлу
   */
  public getFilePath(): string {
    return this._filePath;
  }
}
