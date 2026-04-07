/**
 * DataRecorder — запись сырых WS-событий в NDJSON-файлы.
 *
 * @remarks
 * ### Назначение:
 * Реализует `IMarketDataRecorder` из `@polymarket/ports`.
 * Записывает сырые события с биржи на диск для воспроизведения в бектесте.
 *
 * ### Структура файлов:
 * ```
 * outputDir/
 *   2026-01-01/
 *     Bitcoin_Up___0xabc.jsonl(.gz)
 *     Ethereum_Down___0xdef.jsonl(.gz)
 *   2026-01-02/
 *     ...
 * ```
 *
 * ### Первая запись в файл — meta-событие:
 * ```json
 * {"t":"meta","ts":1234567890,"marketId":"0x...","question":"...","tokenIds":["0x..."]}
 * ```
 *
 * ### Буферизация:
 * - События накапливаются в памяти (строки NDJSON)
 * - Сброс при `buffer.length >= bufferSize` (100 событий)
 * - Сброс по таймеру каждые `flushIntervalMs` (10 сек)
 * - Обратный индекс `tokenId → MarketWriter` для O(1) маршрутизации
 *
 * @example
 * ```typescript
 * const recorder = new DataRecorder(config, new NDJSONFormatter(), new GzipCompressor(), logger);
 * recorder.registerMarket({ marketId, question, tokenIds, expiresAt });
 * recorder.recordEvent('0xyes...', { event_type: 'book', ... });
 * await recorder.finalizeMarket(marketId, 'EXPIRED');
 * await recorder.close();
 * ```
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ILogger } from '@polymarket/logger';
import type { MarketId } from '@polymarket/ids';
import type { IMarketDataRecorder, MarketMeta } from '@polymarket/ports';
import type { DataRecorderConfig } from './config/DataRecorderConfig.js';
import type { IFormatter } from './formatters/IFormatter.js';
import type { GzipCompressor } from './compression/GzipCompressor.js';

/**
 * Буферизированное событие с timestamp для сортировки перед записью.
 *
 * @remarks
 * Хранит извлечённый timestamp и отформатированную NDJSON-строку.
 * При flush буфер сортируется по `ts`, чтобы crypto_price события
 * были перемешаны с book/trade в хронологическом порядке.
 */
interface BufferedEvent {
  /** Timestamp события в Unix ms (для сортировки) */
  readonly ts: number;
  /** Отформатированная NDJSON-строка (с trailing newline) */
  readonly line: string;
}

/**
 * Внутреннее состояние записи для одного рынка.
 */
interface MarketWriter {
  readonly meta: MarketMeta;
  readonly filePath: string;
  buffer: BufferedEvent[];
  stream: fs.WriteStream | null;
  lastFlushTime: number;
  eventsRecorded: number;
}

/**
 * Реализация IMarketDataRecorder.
 *
 * @remarks
 * Thread-safe только в single-threaded Node.js окружении.
 */
export class DataRecorder implements IMarketDataRecorder {
  private readonly _logger: ILogger;
  /** Хранилище состояния: marketId → MarketWriter */
  private readonly _writers = new Map<string, MarketWriter>();
  /** Обратный индекс для O(1) маршрутизации: tokenId → MarketWriter */
  private readonly _tokenIndex = new Map<string, MarketWriter>();
  /** Таймер периодического сброса буферов */
  private _flushTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param _config - Конфигурация рекордера
   * @param _formatter - Форматировщик записей
   * @param _compressor - Компрессор (null = сжатие отключено)
   * @param logger - Логгер
   */
  constructor(
    private readonly _config: DataRecorderConfig,
    private readonly _formatter: IFormatter,
    private readonly _compressor: GzipCompressor | null,
    logger: ILogger,
  ) {
    this._logger = logger.child({ component: 'DataRecorder' });
    this._startFlushTimer();
  }

  /**
   * Проверяет, включён ли рекордер.
   *
   * @returns Всегда true — экземпляр DataRecorder создаётся только когда запись включена
   */
  public isEnabled(): boolean {
    return true;
  }

  /**
   * Регистрирует рынок: создаёт файл, записывает meta-событие.
   *
   * @param meta - Метаданные рынка
   *
   * @remarks
   * Идемпотентный — повторный вызов для того же marketId — no-op.
   */
  public registerMarket(meta: MarketMeta): void {
    const key = String(meta.marketId);
    if (this._writers.has(key)) {
      this._logger.debug('Market already registered, skipping', { marketId: key });
      return;
    }

    const filePath = this._buildFilePath(meta);

    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });

      // Если файл уже существует от предыдущего запуска — удаляем.
      // Это предотвращает дублирование meta-записей при повторном старте без graceful shutdown.
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        this._logger.warn('Existing market file deleted (previous run, no graceful shutdown)', {
          marketId: key,
          filePath,
        });
      }

      // Синхронно записываем meta-событие: файл гарантированно появляется на диске
      // до создания WriteStream. Это позволяет тестам и мониторингу сразу видеть файл.
      const metaRecord: Record<string, unknown> = {
        t: 'meta',
        ts: Date.now(),
        marketId: key,
        question: meta.question,
        tokenIds: Array.from(meta.tokenIds),
      };
      if (meta.rawMarket) {
        metaRecord['m'] = meta.rawMarket;
      }
      const metaLine = this._formatter.formatRecord(metaRecord);
      fs.writeFileSync(filePath, metaLine, { flag: 'a' });

      // Открываем поток в режиме append после того, как файл создан синхронно
      const stream = fs.createWriteStream(filePath, { flags: 'a' });

      stream.on('error', (err) => {
        this._logger.error('Write stream error', { marketId: key, filePath, err });
      });

      const writer: MarketWriter = {
        meta,
        filePath,
        buffer: [],
        stream,
        lastFlushTime: Date.now(),
        eventsRecorded: 0,
      };

      this._writers.set(key, writer);
      for (const tokenId of meta.tokenIds) {
        this._tokenIndex.set(tokenId, writer);
      }

      this._logger.debug('Market registered for recording', {
        marketId: key,
        question: meta.question,
        tokenCount: meta.tokenIds.length,
        filePath,
      });
    } catch (err) {
      this._logger.error('Failed to register market', {
        marketId: key,
        filePath,
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  /**
   * Обновляет первую строку (meta) файла с новыми rawMarket данными.
   *
   * @param marketId - ID рынка
   * @param updatedRawMarket - Обновлённый rawMarket из Gamma API
   *
   * @remarks
   * Перезаписывает первую строку файла. Нужно вызывать после flush буфера,
   * но до закрытия stream. Используется для записи `eventMetadata.priceToBeat`
   * и `eventMetadata.finalPrice` которые появляются в API после старта/завершения рынка.
   */
  public async updateMarketMeta(marketId: MarketId, updatedRawMarket: Record<string, unknown>): Promise<void> {
    const key = String(marketId);
    const writer = this._writers.get(key);
    if (!writer) return;

    // Сбрасываем буфер перед перезаписью
    await this._flushWriter(writer);

    // Закрываем текущий stream
    if (writer.stream) {
      await new Promise<void>((resolve, reject) => {
        writer.stream!.end((err?: Error | null) => {
          if (err) reject(err); else resolve();
        });
      });
      writer.stream = null;
    }

    // Читаем файл, заменяем первую строку
    const content = fs.readFileSync(writer.filePath, 'utf-8');
    const lines = content.split('\n');
    const newMeta: Record<string, unknown> = {
      t: 'meta',
      ts: Date.now(),
      marketId: key,
      question: writer.meta.question,
      tokenIds: Array.from(writer.meta.tokenIds),
      m: updatedRawMarket,
    };
    lines[0] = this._formatter.formatRecord(newMeta).replace(/\n$/, '');
    fs.writeFileSync(writer.filePath, lines.join('\n'));

    // Переоткрываем stream для append
    writer.stream = fs.createWriteStream(writer.filePath, { flags: 'a' });
    writer.stream.on('error', (err) => {
      this._logger.error('Write stream error', { marketId: key, filePath: writer.filePath, err });
    });

    this._logger.info('Market meta updated with API data', {
      marketId: key,
      hasPriceToBeat: updatedRawMarket['events'] !== undefined,
    });
  }

  /**
   * Записывает сырое WS-событие в буфер (синхронно, fire-and-forget).
   *
   * @param tokenId - ID токена (YES или NO)
   * @param rawEvent - Сырое событие
   *
   * @remarks
   * Никогда не бросает. O(1) поиск через tokenIndex.
   * Извлекает timestamp из события для сортировки при flush.
   * Поддерживаемые поля: `timestamp` (string|number), `ts` (number).
   */
  public recordEvent(tokenId: string, rawEvent: unknown): void {
    const writer = this._tokenIndex.get(tokenId);
    if (!writer) return;

    try {
      const line = this._formatter.formatRecord(rawEvent as object);
      const ts = this._extractTimestamp(rawEvent);
      writer.buffer.push({ ts, line });
      writer.eventsRecorded++;

      if (writer.buffer.length >= this._config.bufferSize) {
        void this._flushWriter(writer);
      }
    } catch {
      // Ошибка форматирования — пропускаем событие, не блокируем trading path
    }
  }

  /**
   * Завершает запись рынка: сбрасывает буфер, закрывает поток, сжимает файл.
   *
   * @param marketId - ID рынка
   * @param reason - Причина завершения
   *
   * @throws При ошибке I/O
   */
  public async finalizeMarket(marketId: MarketId, reason: 'EXPIRED' | 'SHUTDOWN'): Promise<void> {
    const key = String(marketId);
    const writer = this._writers.get(key);
    if (!writer) {
      this._logger.debug('finalizeMarket: market not found', { marketId: key });
      return;
    }

    // Удаляем из индексов до завершения (новые события игнорируются)
    this._writers.delete(key);
    for (const tokenId of writer.meta.tokenIds) {
      this._tokenIndex.delete(tokenId);
    }

    if (reason === 'SHUTDOWN') {
      // При shutdown файл всё равно удаляется — флашить и ждать close бессмысленно.
      // Сразу уничтожаем стрим (не ждём drain, не зависаем) и удаляем файл.
      try { writer.stream?.destroy(); } catch { /* ignore */ }
      writer.stream = null;

      try {
        await fs.promises.unlink(writer.filePath);
        this._logger.info('Incomplete market file deleted on shutdown', {
          marketId: key,
          eventsRecorded: writer.eventsRecorded,
          filePath: writer.filePath,
        });
      } catch (err) {
        this._logger.warn('Failed to delete incomplete market file', {
          marketId: key,
          filePath: writer.filePath,
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
      return;
    }

    // EXPIRED: данные нужны — флашим буфер и корректно закрываем стрим перед сжатием.
    await this._flushWriter(writer);

    await new Promise<void>((resolve, reject) => {
      if (!writer.stream) { resolve(); return; }
      writer.stream.end((err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });

    if (this._config.compression === 'gzip' && this._compressor) {
      try {
        const gzPath = await this._compressor.compressFile(writer.filePath);
        this._logger.debug('Market file compressed', { marketId: key, gzPath });
      } catch (err) {
        this._logger.warn('Failed to compress market file', {
          marketId: key,
          filePath: writer.filePath,
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    this._logger.info('Market finalized (expired)', {
      marketId: key,
      eventsRecorded: writer.eventsRecorded,
      filePath: writer.filePath,
    });
  }

  /**
   * Очищает артефакты от предыдущих запусков.
   *
   * @remarks
   * ### Два механизма очистки:
   *
   * 1. **Legacy `.incomplete/`** — папка от старой версии коллектора.
   *    Удаляется если существует (обратная совместимость).
   *
   * 2. **Scan незавершённых `.jsonl`** — основной механизм для краш-сценариев.
   *    При SIGKILL/OOM graceful shutdown не выполняется, `.jsonl` файлы остаются
   *    на диске. `cleanup()` вызывается при следующем старте (до создания любых
   *    новых файлов), поэтому все `.jsonl` на диске гарантированно от упавшего
   *    прошлого запуска.
   *
   * ### Структура сканирования:
   * - С `sourceSubDir`: `outputDir/YYYY-MM-DD/{sourceSubDir}/*.jsonl`
   * - Без `sourceSubDir`: `outputDir/YYYY-MM-DD/*.jsonl`
   *
   * `.jsonl.gz` не трогаются — это завершённые архивы.
   *
   * @remarks
   * ⚠️ Не запускать два коллектора с одинаковым `outputDir` —
   * `cleanup()` удалит активные файлы параллельного инстанса.
   */
  public async cleanup(): Promise<void> {
    // 1. Legacy .incomplete/ (обратная совместимость со старыми версиями)
    const incompleteDir = path.join(this._config.outputDir, '.incomplete');
    if (fs.existsSync(incompleteDir)) {
      const files = await fs.promises.readdir(incompleteDir);
      for (const file of files) {
        try {
          await fs.promises.unlink(path.join(incompleteDir, file));
        } catch {
          // ignore
        }
      }
      try {
        await fs.promises.rmdir(incompleteDir);
      } catch {
        // ignore
      }
      if (files.length > 0) {
        this._logger.info('Cleaned up legacy .incomplete market files', { count: files.length });
      }
    }

    // 2. Scan незавершённых .jsonl от предыдущего краш-запуска
    const jsonlFiles = await this._findLeftoverJsonlFiles();
    for (const filePath of jsonlFiles) {
      try {
        await fs.promises.unlink(filePath);
      } catch {
        // ignore — файл мог быть удалён между scan и unlink
      }
    }
    if (jsonlFiles.length > 0) {
      this._logger.info('Cleaned up incomplete market files from previous crash', {
        count: jsonlFiles.length,
      });
    }
  }

  /**
   * Принудительно сбрасывает все буферы на диск.
   *
   * @throws При ошибке записи
   */
  public async flush(): Promise<void> {
    await this._flushAll();
  }

  /**
   * Завершает работу: финализирует все рынки, останавливает таймеры.
   *
   * @throws При ошибке I/O
   */
  public async close(): Promise<void> {
    this._stopFlushTimer();

    const marketIds = [...this._writers.keys()];
    this._logger.info('Closing DataRecorder', { activeMarkets: marketIds.length });

    await Promise.all(
      marketIds.map((id) =>
        this.finalizeMarket(id as unknown as MarketId, 'SHUTDOWN'),
      ),
    );

    // Удаляем пустые date-директории после удаления незаконченных файлов
    await this._removeEmptyDateDirs();

    this._logger.info('DataRecorder closed');
  }

  /**
   * Ищет незавершённые `.jsonl` файлы от предыдущего краш-запуска.
   *
   * @returns Массив абсолютных путей к `.jsonl` файлам (без `.gz`)
   *
   * @remarks
   * Сканирует структуру `outputDir/YYYY-MM-DD/[sourceSubDir]/`.
   * `.jsonl.gz` пропускаются — это завершённые архивы.
   */
  private async _findLeftoverJsonlFiles(): Promise<string[]> {
    const result: string[] = [];
    if (!fs.existsSync(this._config.outputDir)) return result;

    let dateDirs: fs.Dirent[];
    try {
      dateDirs = await fs.promises.readdir(this._config.outputDir, { withFileTypes: true });
    } catch {
      return result;
    }

    for (const dateEntry of dateDirs) {
      if (!dateEntry.isDirectory()) continue;
      // Игнорируем .incomplete/ и прочие служебные папки — только YYYY-MM-DD
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateEntry.name)) continue;

      const scanDir = this._config.sourceSubDir
        ? path.join(this._config.outputDir, dateEntry.name, this._config.sourceSubDir)
        : path.join(this._config.outputDir, dateEntry.name);

      if (!fs.existsSync(scanDir)) continue;

      let files: fs.Dirent[];
      try {
        files = await fs.promises.readdir(scanDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.isFile()) continue;
        // Только .jsonl без .gz — .jsonl.gz это завершённые архивы
        if (file.name.endsWith('.jsonl') && !file.name.endsWith('.jsonl.gz')) {
          result.push(path.join(scanDir, file.name));
        }
      }
    }

    return result;
  }

  /**
   * Удаляет пустые date-директории в outputDir.
   *
   * @remarks
   * После удаления незаконченных файлов при shutdown date-директории
   * (e.g. `2026-03-21/`) могут остаться пустыми. Этот метод их подчищает.
   */
  private async _removeEmptyDateDirs(): Promise<void> {
    try {
      const entries = await fs.promises.readdir(this._config.outputDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dirPath = path.join(this._config.outputDir, entry.name);
        const files = await fs.promises.readdir(dirPath);
        if (files.length === 0) {
          await fs.promises.rmdir(dirPath);
          this._logger.debug('Removed empty date directory', { dir: dirPath });
        }
      }
    } catch {
      // outputDir может не существовать — игнорируем
    }
  }

  // ── Приватные методы ──────────────────────────────────────────────────────

  /**
   * Строит путь к файлу для рынка.
   * Формат: `outputDir/YYYY-MM-DD/{sourceSubDir?}/polymarket_{sanitizedQuestion_with_year}___{marketId}.{ext}`
   *
   * @param meta - Метаданные рынка
   * @returns Абсолютный путь к файлу
   *
   * @remarks
   * Год вставляется прямо перед датой в вопросе: паттерн `_-_` (из ` - `) заменяется на `_-{YYYY}_`.
   * Пример: `Bitcoin_Up_or_Down_-_March_22` → `Bitcoin_Up_or_Down_-2026_March_22`
   *
   * @example
   * ```typescript
   * // question = "Will Bitcoin go up or down - March 22 1:30PM-1:45PM ET?"
   * // → 'snapshots/2026-03-22/polymarket/polymarket_Bitcoin_Up_or_Down_-2026_March_22_130PM-145PM_ET___0xabc.jsonl'
   * ```
   */
  private _buildFilePath(meta: MarketMeta): string {
    const now  = new Date();
    const date = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const year = now.getUTCFullYear();
    const safeQuestion = meta.question
      .replace(/[^\w\s-]/g, '')   // оставляем буквы, цифры, дефис, пробелы
      .replace(/\s+/g, '_')       // пробелы → _
      .slice(0, 80);              // ограничение длины
    // Вставляем год перед датой: "Bitcoin_Up_or_Down_-_March_22" → "Bitcoin_Up_or_Down_-2026_March_22"
    // Паттерн "_-_" возникает из " - " в вопросах вида "... up or down - March 22 ..."
    const safeQuestionWithYear = safeQuestion.includes('_-_')
      ? safeQuestion.replace('_-_', `_-${year}_`)
      : `${safeQuestion}_${year}`;
    const marketId = String(meta.marketId).slice(0, 40);
    const fileName = `polymarket_${safeQuestionWithYear}___${marketId}.${this._formatter.extension}`;
    const segments = [this._config.outputDir, date];
    if (this._config.sourceSubDir) segments.push(this._config.sourceSubDir);
    segments.push(fileName);
    return path.join(...segments);
  }

  /**
   * Сбрасывает буфер одного рынка на диск.
   *
   * @param writer - Внутреннее состояние рынка
   *
   * @remarks
   * Записывает события в порядке прихода (без сортировки по timestamp).
   * Это гарантирует что бектест replay получит события в той же последовательности
   * что и paper/live — идентичные EWMA, delta, и решения стратегии.
   *
   * @throws При ошибке записи в поток
   */
  private async _flushWriter(writer: MarketWriter): Promise<void> {
    if (writer.buffer.length === 0 || !writer.stream) return;

    const data = writer.buffer.map((e) => e.line).join('');
    writer.buffer = [];
    writer.lastFlushTime = Date.now();

    const canContinue = writer.stream!.write(data, (err) => {
      if (err) this._logger.error('Stream write error', { error: err.message });
    });

    // Backpressure: если внутренний буфер потока переполнен — ждём drain
    if (!canContinue) {
      await new Promise<void>((resolve) => {
        writer.stream!.once('drain', resolve);
      });
    }
  }

  /**
   * Сбрасывает буферы всех активных рынков.
   *
   * @throws При ошибке записи
   */
  private async _flushAll(): Promise<void> {
    await Promise.all(
      [...this._writers.values()].map((w) => this._flushWriter(w)),
    );
  }

  /**
   * Извлекает timestamp из сырого события для сортировки в буфере.
   *
   * @param rawEvent - Сырое событие (book, trade, crypto_price и т.д.)
   * @returns Timestamp в Unix ms. Если не найден — Date.now() (fallback).
   *
   * @remarks
   * Поддерживаемые поля:
   * - `timestamp` (string|number) — book/trade события Polymarket WS
   * - `ts` (number) — crypto_price и meta события
   */
  private _extractTimestamp(rawEvent: unknown): number {
    if (rawEvent && typeof rawEvent === 'object') {
      const obj = rawEvent as Record<string, unknown>;
      // WS book/trade: timestamp (строка Unix ms)
      if (obj['timestamp'] !== undefined) {
        const v = Number(obj['timestamp']);
        if (!Number.isNaN(v)) return v;
      }
      // crypto_price / meta: ts (число)
      if (obj['ts'] !== undefined) {
        const v = Number(obj['ts']);
        if (!Number.isNaN(v)) return v;
      }
    }
    return Date.now();
  }

  /**
   * Запускает таймер периодического сброса.
   */
  private _startFlushTimer(): void {
    this._flushTimer = setInterval(() => {
      void this._flushAll();
    }, this._config.flushIntervalMs);

    // Не блокируем завершение процесса
    if (this._flushTimer.unref) {
      this._flushTimer.unref();
    }
  }

  /**
   * Останавливает таймер периодического сброса.
   */
  private _stopFlushTimer(): void {
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
  }
}
