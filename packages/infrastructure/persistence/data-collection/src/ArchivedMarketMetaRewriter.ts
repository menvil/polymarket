import * as fs from 'node:fs';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createGunzip, createGzip } from 'node:zlib';
import type { ILogger } from '@polymarket/logger';

/**
 * Перезаписывает первую NDJSON-строку в архивном market snapshot.
 *
 * @remarks
 * Использует temp-файл + atomic rename, чтобы не повредить архив при сбое.
 * Поддерживает `.jsonl` и `.jsonl.gz`.
 */
export class ArchivedMarketMetaRewriter {
  private readonly _logger: ILogger;

  constructor(logger: ILogger) {
    this._logger = logger.child({ component: 'ArchivedMarketMetaRewriter' });
  }

  public async rewrite(filePath: string, metaRecord: Record<string, unknown>): Promise<void> {
    if (filePath.endsWith('.jsonl.gz')) {
      await this._rewriteGzip(filePath, metaRecord);
      return;
    }

    if (filePath.endsWith('.jsonl')) {
      await this._rewriteJsonl(filePath, metaRecord);
      return;
    }

    throw new Error(`Unsupported snapshot file extension: ${filePath}`);
  }

  private async _rewriteJsonl(filePath: string, metaRecord: Record<string, unknown>): Promise<void> {
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    const input = fs.createReadStream(filePath);
    const output = fs.createWriteStream(tempPath, { flags: 'wx' });
    const rl = createInterface({
      input,
      crlfDelay: Infinity,
    });

    let replaced = false;

    try {
      for await (const line of rl) {
        if (!replaced) {
          await this._writeChunk(output, this._formatLine(metaRecord));
          replaced = true;
          continue;
        }

        await this._writeChunk(output, `${line}\n`);
      }

      if (!replaced) {
        throw new Error(`Snapshot file is empty: ${filePath}`);
      }

      output.end();
      await once(output, 'finish');
      await fs.promises.rename(tempPath, filePath);
    } catch (error) {
      output.destroy();
      await this._safeUnlink(tempPath);
      throw error;
    } finally {
      rl.close();
      input.destroy();
    }

    this._logger.info('Archived market meta rewritten', { filePath });
  }

  private async _rewriteGzip(filePath: string, metaRecord: Record<string, unknown>): Promise<void> {
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    const source = fs.createReadStream(filePath);
    const gunzip = createGunzip();
    const gzip = createGzip();
    const output = fs.createWriteStream(tempPath, { flags: 'wx' });
    const rl = createInterface({
      input: source.pipe(gunzip),
      crlfDelay: Infinity,
    });

    gzip.pipe(output);

    let replaced = false;

    try {
      for await (const line of rl) {
        if (!replaced) {
          await this._writeChunk(gzip, this._formatLine(metaRecord));
          replaced = true;
          continue;
        }

        await this._writeChunk(gzip, `${line}\n`);
      }

      if (!replaced) {
        throw new Error(`Snapshot file is empty: ${filePath}`);
      }

      gzip.end();
      await once(output, 'finish');
      await fs.promises.rename(tempPath, filePath);
    } catch (error) {
      gzip.destroy();
      output.destroy();
      await this._safeUnlink(tempPath);
      throw error;
    } finally {
      rl.close();
      source.destroy();
      gunzip.destroy();
    }

    this._logger.info('Archived gzipped market meta rewritten', { filePath });
  }

  private _formatLine(metaRecord: Record<string, unknown>): string {
    return `${JSON.stringify(metaRecord)}\n`;
  }

  private async _writeChunk(
    stream: NodeJS.WritableStream,
    chunk: string,
  ): Promise<void> {
    if (stream.write(chunk)) {
      return;
    }

    await once(stream, 'drain');
  }

  private async _safeUnlink(filePath: string): Promise<void> {
    try {
      await fs.promises.unlink(filePath);
    } catch {
      // ignore cleanup failure
    }
  }
}
