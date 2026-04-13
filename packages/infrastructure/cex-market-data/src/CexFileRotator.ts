import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import type { ILogger } from '@polymarket/logger';

export interface CexFileRotatorConfig {
  readonly outputDir: string;
  readonly compression: 'none' | 'gzip';
  readonly windowMinutes?: number;
  readonly bufferSize?: number;
  readonly flushIntervalMs?: number;
}

interface BufferedLine {
  readonly line: string;
}

interface SymbolWriter {
  readonly filePath: string;
  buffer: BufferedLine[];
  stream: fs.WriteStream | null;
  eventsWritten: number;
}

export class CexFileRotator {
  private readonly _windowMs: number;
  private readonly _bufferSize: number;
  private readonly _flushIntervalMs: number;

  private _windowStart = 0;
  private _active = false;
  private readonly _writers = new Map<string, SymbolWriter>();
  private _rotationTimer: ReturnType<typeof setTimeout> | null = null;
  private _flushTimer: ReturnType<typeof setInterval> | null = null;
  private _closed = false;

  constructor(
    private readonly _config: CexFileRotatorConfig,
    private readonly _logger: ILogger,
  ) {
    this._windowMs = (_config.windowMinutes ?? 5) * 60 * 1000;
    this._bufferSize = _config.bufferSize ?? 200;
    this._flushIntervalMs = _config.flushIntervalMs ?? 5_000;
  }

  public start(): void {
    const now = Date.now();
    const nextBoundary = this._nextBoundary(now);
    const delay = nextBoundary - now;

    this._logger.info('CexFileRotator started, waiting for alignment', {
      nextWindowUTC: new Date(nextBoundary).toISOString(),
      delayMs: delay,
    });

    this._rotationTimer = setTimeout(() => {
      this._windowStart = nextBoundary;
      this._active = true;
      this._logger.info('CexFileRotator aligned, recording started', {
        windowUTC: new Date(nextBoundary).toISOString(),
      });
      this._scheduleNextRotation();
    }, delay);

    this._flushTimer = setInterval(() => {
      void this._flushAll();
    }, this._flushIntervalMs);

    this._flushTimer.unref?.();
  }

  public write(exchange: string, symbol: string, marketType: string, record: object): void {
    if (!this._active) return;

    const key = this._makeKey(exchange, symbol, marketType);
    let writer = this._writers.get(key);
    if (!writer) {
      writer = this._createWriter(exchange, symbol, marketType);
      this._writers.set(key, writer);
    }

    writer.buffer.push({ line: JSON.stringify(record) + '\n' });
    writer.eventsWritten++;

    if (writer.buffer.length >= this._bufferSize) {
      void this._flushWriter(writer);
    }
  }

  public async cleanup(exchangeIds: string[]): Promise<void> {
    if (!fs.existsSync(this._config.outputDir)) return;

    let dateDirs: fs.Dirent[];
    try {
      dateDirs = await fs.promises.readdir(this._config.outputDir, { withFileTypes: true });
    } catch {
      return;
    }

    let deleted = 0;
    for (const dateEntry of dateDirs) {
      if (!dateEntry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(dateEntry.name)) continue;

      for (const exchangeId of exchangeIds) {
        const exchangeDir = path.join(this._config.outputDir, dateEntry.name, exchangeId);
        if (!fs.existsSync(exchangeDir)) continue;

        let files: fs.Dirent[];
        try {
          files = await fs.promises.readdir(exchangeDir, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const file of files) {
          if (!file.isFile()) continue;
          if (!file.name.endsWith('.jsonl') || file.name.endsWith('.jsonl.gz')) continue;
          try {
            await fs.promises.unlink(path.join(exchangeDir, file.name));
            deleted++;
          } catch {
            // ignore
          }
        }
      }
    }

    if (deleted > 0) {
      this._logger.info('CexFileRotator cleaned up incomplete files', {
        deleted,
        exchanges: exchangeIds,
      });
    }
  }

  public async close(): Promise<void> {
    this._closed = true;
    this._logger.info('CexFileRotator closing, deleting incomplete window files');

    if (this._rotationTimer) {
      clearTimeout(this._rotationTimer);
      this._rotationTimer = null;
    }
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }

    this._active = false;
    const writersSnapshot = [...this._writers.values()];
    this._writers.clear();

    await Promise.all(
      writersSnapshot.map((writer) =>
        Promise.race([
          new Promise<void>((resolve) => {
            if (!writer.stream) {
              resolve();
              return;
            }
            writer.stream.once('close', () => resolve());
            writer.stream.destroy();
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 5000)),
        ]),
      ),
    );

    let deleted = 0;
    await Promise.all(
      writersSnapshot.map(async (writer) => {
        try {
          if (fs.existsSync(writer.filePath)) {
            await fs.promises.unlink(writer.filePath);
            deleted++;
          }
        } catch (err) {
          this._logger.warn('Failed to delete incomplete CEX file', {
            filePath: writer.filePath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );

    this._logger.info('CexFileRotator closed', { deletedFiles: deleted });
  }

  private _scheduleNextRotation(): void {
    if (this._closed) return;
    const nextBoundary = this._windowStart + this._windowMs;
    const delay = nextBoundary - Date.now();

    this._rotationTimer = setTimeout(() => {
      void this._rotate(nextBoundary);
    }, Math.max(0, delay));
  }

  private async _rotate(newWindowStart: number): Promise<void> {
    if (this._closed) return;
    const oldWindowStart = this._windowStart;
    this._logger.info('Rotating CEX window', {
      closedWindowUTC: new Date(oldWindowStart).toISOString(),
      newWindowUTC: new Date(newWindowStart).toISOString(),
      activeSymbols: this._writers.size,
    });

    await this._flushAll();
    await this._closeAllStreams();

    if (this._config.compression === 'gzip') {
      await this._gzipAllCurrentFiles();
    }

    this._windowStart = newWindowStart;
    this._writers.clear();
    this._logger.info('CEX window rotation complete', {
      newWindowUTC: new Date(newWindowStart).toISOString(),
    });

    this._scheduleNextRotation();
  }

  private async _gzipAllCurrentFiles(): Promise<void> {
    await Promise.all(
      [...this._writers.values()].map(async (writer) => {
        const src = writer.filePath;
        const dst = `${src}.gz`;
        if (!fs.existsSync(src)) return;

        try {
          await pipeline(
            fs.createReadStream(src),
            zlib.createGzip(),
            fs.createWriteStream(dst),
          );
          await fs.promises.unlink(src);
          this._logger.debug('CEX file compressed', { src, dst });
        } catch (err) {
          this._logger.warn('Failed to gzip CEX file', {
            src,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
  }

  private _createWriter(exchange: string, symbol: string, marketType: string): SymbolWriter {
    const filePath = this._buildFilePath(exchange, symbol, marketType, this._windowStart);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      this._logger.warn('Deleted leftover incomplete CEX file from previous run', { filePath });
    }

    const stream = fs.createWriteStream(filePath, { flags: 'a' });
    stream.on('error', (err) => {
      this._logger.error('CEX write stream error', { filePath, error: err.message });
    });

    const writer: SymbolWriter = {
      filePath,
      buffer: [],
      stream,
      eventsWritten: 0,
    };

    this._logger.debug('CEX writer opened', { exchange, symbol, filePath });
    return writer;
  }

  private async _flushWriter(writer: SymbolWriter): Promise<void> {
    if (writer.buffer.length === 0 || !writer.stream) return;

    const data = writer.buffer.map((item) => item.line).join('');
    writer.buffer = [];

    const canContinue = writer.stream.write(data, (err) => {
      if (err) this._logger.error('CEX stream write error', { error: err.message });
    });

    if (!canContinue) {
      await new Promise<void>((resolve) => writer.stream!.once('drain', resolve));
    }
  }

  private async _flushAll(): Promise<void> {
    await Promise.all([...this._writers.values()].map((writer) => this._flushWriter(writer)));
  }

  private async _closeAllStreams(): Promise<void> {
    await Promise.all(
      [...this._writers.values()].map(
        (writer) =>
          new Promise<void>((resolve) => {
            if (!writer.stream) {
              resolve();
              return;
            }
            writer.stream.end((err?: Error | null) => {
              if (err) {
                this._logger.warn('Failed to close CEX write stream', {
                  filePath: writer.filePath,
                  error: err.message,
                });
              }
              resolve();
            });
            writer.stream = null;
          }),
      ),
    );
  }

  private _buildFilePath(exchange: string, symbol: string, marketType: string, windowStart: number): string {
    const utcDate = new Date(windowStart).toISOString().slice(0, 10);
    const windowEnd = windowStart + this._windowMs;
    const dateLabel = this._formatDateET(windowStart);
    const startLabel = this._formatTimeET(windowStart);
    const endLabel = this._formatTimeET(windowEnd);
    const safeSymbol = symbol.replace('/', '-');
    const fileName = `${exchange}_${safeSymbol}_${marketType}_${dateLabel}_${startLabel}-${endLabel}_ET.jsonl`;
    return path.join(this._config.outputDir, utcDate, exchange, fileName);
  }

  private _formatDateET(ms: number): string {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: 'long',
      day: '2-digit',
    }).formatToParts(new Date(ms));
    const year = parts.find((part) => part.type === 'year')!.value;
    const month = parts.find((part) => part.type === 'month')!.value;
    const day = parts.find((part) => part.type === 'day')!.value;
    return `${year}-${month}-${day}`;
  }

  private _formatTimeET(ms: number): string {
    const raw = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(ms));
    return raw.replace(':', '').replace(' ', '');
  }

  private _nextBoundary(now: number): number {
    return (Math.floor(now / this._windowMs) + 1) * this._windowMs;
  }

  private _makeKey(exchange: string, symbol: string, marketType: string): string {
    return `${exchange}__${symbol.replace('/', '-')}__${marketType}`;
  }
}
