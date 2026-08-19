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
 * - События накапливаются в памяти (строки NDJSON) в порядке поступления
 * - Сброс при `buffer.length >= bufferSize` (100 событий)
 * - Сброс по таймеру каждые `flushIntervalMs` (10 сек)
 * - Строки пишутся в порядке прихода (arrival order) — БЕЗ сортировки по
 *   timestamp: replay в бектесте обязан получить ту же последовательность,
 *   что видели paper/live консюмеры
 *
 * ### Маршрутизация:
 * - Legacy-путь: обратный индекс `tokenId → MarketWriter` (`recordEvent`)
 * - V2-путь: прямой ключ `String(marketId) → MarketWriter`
 *   (`recordMarketEvent`) — source market id (conditionId) известен
 *   вызывающему из SDK-события
 *
 * @example
 * ```typescript
 * const recorder = new DataRecorder(config, new NDJSONFormatter(), new GzipCompressor(), logger);
 * recorder.registerMarket({ marketId, question, tokenIds, expiresAt });
 * recorder.recordEvent('0xyes...', { event_type: 'book', ... });
 * recorder.recordMarketEvent(marketId, sdkEvent); // V2: маршрутизация по рынку
 * await recorder.finalizeMarket(marketId, 'EXPIRED');
 * await recorder.close();
 * ```
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ILogger } from '@polymarket/logger';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import type { IMarketDataRecorder, MarketMeta } from '@polymarket/ports';
import type { DataRecorderConfig } from './config/DataRecorderConfig.js';
import type { IFormatter } from './formatters/IFormatter.js';
import type { GzipCompressor } from './compression/GzipCompressor.js';

const META_RESERVED_BYTES = 16 * 1024;

/**
 * Исход записи одного события через {@link DataRecorder.recordMarketEvent}.
 *
 * - `'recorded'` — строка сериализована и поставлена в буфер записи;
 * - `'inactive'` — рынок зарегистрирован, но `startsAt` ещё не наступил —
 *   событие сознательно проигнорировано (activation policy);
 * - `'unregistered'` — рынок не зарегистрирован (или уже финализирован);
 * - `'failed'` — запись невозможна и это ошибка (залогирована): не удалась
 *   сериализация payload, упала активация writer-а либо его stream
 *   недоступен/разрушен.
 */
export type RecordOutcome = 'recorded' | 'inactive' | 'unregistered' | 'failed';

/**
 * Внутреннее состояние записи для одного рынка.
 *
 * @remarks
 * `buffer` хранит готовые NDJSON-строки (с trailing `\n`) строго в порядке
 * поступления — flush пишет их без пересортировки.
 *
 * Инвариант флагов: `active` становится `true` ТОЛЬКО после полного успеха
 * активации (файл создан, meta записана, stream открыт); `failed` помечает
 * терминальный отказ writer-а (ошибка активации или ошибка stream) —
 * последующие записи возвращают `'failed'`, а не молча копятся в буфере,
 * который никогда не будет сброшен.
 */
interface MarketWriter {
  readonly meta: MarketMeta;
  readonly filePath: string;
  buffer: string[];
  stream: fs.WriteStream | null;
  lastFlushTime: number;
  eventsRecorded: number;
  /** true ТОЛЬКО после полного успеха активации (startsAt достигнут, stream открыт) */
  active: boolean;
  /** true после терминального отказа writer-а (активация/stream) */
  failed: boolean;
  /** Таймер активации (ожидание startsAt) */
  activationTimer: ReturnType<typeof setTimeout> | null;
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
   * @returns `true` — writer установлен (или уже был зарегистрирован);
   *   `false` — регистрация не удалась (залогировано), состояние НЕ создано —
   *   вызов можно безопасно повторить
   *
   * @remarks
   * Идемпотентный — повторный вызов для того же marketId — no-op (`true`).
   * При отказе немедленной активации (I/O) writer НЕ попадает в индексы:
   * маршрутизация не должна ссылаться на storage-состояние, которого нет.
   * Порт `IMarketDataRecorder.registerMarket(): void` совместим — legacy
   * вызывающие возвращаемое значение игнорируют.
   */
  public registerMarket(meta: MarketMeta): boolean {
    const key = String(meta.marketId);
    if (this._writers.has(key)) {
      this._logger.debug('Market already registered, skipping', { marketId: key });
      return true;
    }

    const filePath = this._buildFilePath(meta);

    try {
      // Вычисляем: активен ли рынок сразу или нужно ждать startsAt
      const now = Date.now();
      const hasStartsAt = !!meta.startsAt;
      const startsAtMs = hasStartsAt ? meta.startsAt!.toNumber() : now;
      const alreadyStarted = now >= startsAtMs;

      const writer: MarketWriter = {
        meta,
        filePath,
        buffer: [],
        stream: null, // НЕ создаём stream до активации
        lastFlushTime: now,
        eventsRecorded: 0,
        active: false, // active ставит ТОЛЬКО успешная _activateMarket
        failed: false,
        activationTimer: null,
      };

      // Если рынок уже начался — создаём файл и stream сразу.
      // Отказ активации = отказ регистрации: индексы не заполняются, retry возможен.
      if (alreadyStarted) {
        if (!this._activateMarket(writer)) {
          return false;
        }
      } else if (hasStartsAt) {
        // Рынок ещё не начался — планируем активацию на startsAt
        const delayMs = startsAtMs - now;
        writer.activationTimer = setTimeout(() => {
          this._activateMarket(writer);
          writer.activationTimer = null;
        }, delayMs);

        // unref чтобы таймер не удерживал процесс при shutdown
        if (writer.activationTimer.unref) writer.activationTimer.unref();

        this._logger.info('Market registered, waiting for startsAt', {
          marketId: key,
          question: meta.question,
          startsAt: new Date(startsAtMs).toISOString(),
          delayMs,
        });
      }

      this._writers.set(key, writer);
      for (const tokenId of meta.tokenIds) {
        this._tokenIndex.set(tokenId, writer);
      }
      return true;
    } catch (err) {
      this._logger.error('Failed to register market', {
        marketId: key,
        filePath,
        err: err instanceof Error ? err : new Error(String(err)),
      });
      return false;
    }
  }

  /**
   * Активирует запись рынка: создаёт файл, пишет meta, открывает stream.
   *
   * @param writer - Writer рынка
   * @returns `true` — активация полностью успешна (`active` установлен);
   *   `false` — активация упала (`failed` установлен, запись невозможна)
   *
   * @remarks
   * Вызывается либо сразу при `registerMarket()` (если рынок уже начался),
   * либо по таймеру когда достигаем `startsAt`. `active` выставляется ТОЛЬКО
   * после успеха всех шагов; ошибка активации и ошибка stream помечают writer
   * как `failed` — последующие `recordMarketEvent` возвращают `'failed'`.
   */
  private _activateMarket(writer: MarketWriter): boolean {
    const key = String(writer.meta.marketId);

    try {
      fs.mkdirSync(path.dirname(writer.filePath), { recursive: true });

      // Если файл уже существует от предыдущего запуска — удаляем
      if (fs.existsSync(writer.filePath)) {
        fs.unlinkSync(writer.filePath);
        this._logger.warn('Existing market file deleted (previous run, no graceful shutdown)', {
          marketId: key,
          filePath: writer.filePath,
        });
      }

      // Синхронно записываем meta-событие
      const metaRecord: Record<string, unknown> = {
        t: 'meta',
        ...(this._config.formatVersion !== undefined
          ? { formatVersion: this._config.formatVersion }
          : {}),
        ts: Date.now(),
        marketId: key,
        question: writer.meta.question,
        tokenIds: Array.from(writer.meta.tokenIds),
      };
      if (writer.meta.rawMarket) {
        metaRecord['m'] = writer.meta.rawMarket;
      }
      const metaLine = this._formatReservedMetaLine(metaRecord);
      fs.writeFileSync(writer.filePath, metaLine, { flag: 'a' });

      // Открываем поток в режиме append
      writer.stream = fs.createWriteStream(writer.filePath, { flags: 'a' });
      writer.stream.on('error', (err) => {
        // Ошибка stream терминальна (autoDestroy закроет поток) — писать больше
        // некуда; помечаем writer, чтобы записи возвращали 'failed', а не копились
        writer.failed = true;
        this._logger.error('Write stream error', { marketId: key, filePath: writer.filePath, err });
      });

      writer.active = true;

      this._logger.info('Market recording activated', {
        marketId: key,
        question: writer.meta.question,
        filePath: writer.filePath,
      });
      return true;
    } catch (err) {
      writer.failed = true;
      writer.active = false;
      // Убираем частично созданный файл (meta без stream) — retry регистрации
      // начнёт с чистого листа; успешно активированные файлы сюда не попадают
      try {
        if (fs.existsSync(writer.filePath)) {
          fs.unlinkSync(writer.filePath);
        }
      } catch {
        // Файл заберёт disk-scan cleanup() при следующем старте
      }
      this._logger.error('Failed to activate market recording', {
        marketId: key,
        filePath: writer.filePath,
        err: err instanceof Error ? err : new Error(String(err)),
      });
      return false;
    }
  }

  /**
   * Обновляет первую строку (meta) файла с новыми rawMarket данными.
   *
   * @param marketId - ID рынка
   * @param updatedRawMarket - Обновлённый rawMarket из Gamma API
   *
   * @remarks
   * Перезаписывает фиксированный first-line meta block без чтения всего файла.
   * Используется для записи `eventMetadata.priceToBeat` и `eventMetadata.finalPrice`,
   * которые появляются в API после старта/завершения рынка.
   */
  public async updateMarketMeta(marketId: MarketId, updatedRawMarket: Record<string, unknown>): Promise<void> {
    const key = String(marketId);
    const writer = this._writers.get(key);
    if (!writer) return;

    if (!writer.active) return;

    await this._flushWriter(writer);

    const newMeta: Record<string, unknown> = {
      t: 'meta',
      ...(this._config.formatVersion !== undefined
        ? { formatVersion: this._config.formatVersion }
        : {}),
      ts: Date.now(),
      marketId: key,
      question: writer.meta.question,
      tokenIds: Array.from(writer.meta.tokenIds),
      m: updatedRawMarket,
    };

    let metaLine: Buffer;
    try {
      metaLine = this._formatReservedMetaLine(newMeta);
    } catch (err) {
      this._logger.warn('Market meta update skipped: meta exceeds reserved first-line block', {
        marketId: key,
        filePath: writer.filePath,
        reservedBytes: META_RESERVED_BYTES,
        err: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (!this._hasReservedMetaBlock(writer.filePath)) {
      this._logger.warn('Market meta update skipped: file does not use reserved first-line block', {
        marketId: key,
        filePath: writer.filePath,
        reservedBytes: META_RESERVED_BYTES,
      });
      return;
    }

    const fd = await fs.promises.open(writer.filePath, 'r+');
    try {
      await fd.write(metaLine, 0, metaLine.length, 0);
      await fd.sync();
    } finally {
      await fd.close();
    }

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
   * Строка попадает в буфер в порядке прихода — flush не пересортировывает.
   * Если рынок ещё не достиг `startsAt` — события игнорируются (не записываются).
   */
  public recordEvent(tokenId: InstrumentId, rawEvent: unknown): void {
    const writer = this._tokenIndex.get(tokenId);
    if (!writer) return;

    // Игнорируем события до startsAt (аналог CEX window alignment)
    // и отказавшие writer-ы (буфер без stream никогда не будет сброшен)
    if (!writer.active || writer.failed) return;

    try {
      const line = this._formatter.formatRecord(rawEvent as object);
      this._enqueueLine(writer, line);
    } catch {
      // Ошибка форматирования — пропускаем событие, не блокируем trading path
    }
  }

  /**
   * Записывает source-native событие в буфер по source market id (синхронно).
   *
   * @param marketId - ID рынка (conditionId) — ключ регистрации writer-а
   * @param rawEvent - Source-native payload (например, decoded SDK-событие)
   * @returns Исход записи (см. {@link RecordOutcome})
   *
   * @remarks
   * V2-путь маршрутизации: market-события официального SDK несут source
   * market id (`payload.market` == conditionId == `String(meta.marketId)`),
   * поэтому запись адресуется рынку напрямую, без обратного token-индекса.
   * `price_change` с изменениями по нескольким tokenIds записывается ОДНОЙ
   * строкой в файл рынка.
   *
   * Никогда не бросает: ошибка сериализации, упавшая активация writer-а и
   * недоступный/разрушенный stream логируются и возвращаются как `'failed'` —
   * recording failure наблюдаем, но не убивает вызывающего. Событие НЕ
   * ставится в буфер, который никогда не будет сброшен на диск.
   *
   * @example
   * ```typescript
   * const outcome = recorder.recordMarketEvent(marketId, sdkEvent);
   * if (outcome === 'failed') stats.serializationFailures++;
   * ```
   */
  public recordMarketEvent(marketId: MarketId, rawEvent: unknown): RecordOutcome {
    const writer = this._writers.get(String(marketId));
    if (!writer) return 'unregistered';

    // Терминальный отказ writer-а (активация/stream) — до проверки active:
    // упавшая отложенная активация оставляет active=false, но это ошибка,
    // а не «ещё не начался»
    if (writer.failed) return 'failed';

    // Игнорируем события до startsAt (activation policy, см. registerMarket)
    if (!writer.active) return 'inactive';

    // active=true гарантирует созданный stream; защита от рассинхрона
    // (например, stream разрушен во время shutdown) — запись невозможна
    if (writer.stream === null || writer.stream.destroyed) return 'failed';

    let line: string;
    try {
      line = this._formatter.formatRecord(rawEvent as object);
    } catch (err) {
      this._logger.error('Failed to serialize market event for recording', {
        marketId: String(marketId),
        err: err instanceof Error ? err : new Error(String(err)),
      });
      return 'failed';
    }

    this._enqueueLine(writer, line);
    return 'recorded';
  }

  /**
   * Ставит готовую NDJSON-строку в буфер writer-а и триггерит threshold-flush.
   *
   * @param writer - Writer рынка
   * @param line - Отформатированная строка с trailing `\n`
   *
   * @remarks
   * Threshold-flush — fire-and-forget: ошибка записи уже логируется внутри
   * `_flushWriter`, поэтому rejection здесь гасится (иначе floating promise
   * превратил бы disk-ошибку в unhandled rejection).
   */
  private _enqueueLine(writer: MarketWriter, line: string): void {
    writer.buffer.push(line);
    writer.eventsRecorded++;

    if (writer.buffer.length >= this._config.bufferSize) {
      this._flushWriter(writer).catch(() => {
        // Ошибка уже залогирована в _flushWriter
      });
    }
  }

  /**
   * Завершает запись рынка согласно причине завершения.
   *
   * @param marketId - ID рынка
   * @param reason - `'EXPIRED'` — завершённый dataset: flush → close → gzip-архив;
   *   `'SHUTDOWN'` — незавершённый dataset: буфер отбрасывается, stream
   *   разрушается, файл УДАЛЯЕТСЯ (архив не создаётся)
   *
   * @remarks
   * Семантика различия (та же, что у cleanup-policy `close()`):
   * `.jsonl.gz` = завершённый архив, `.jsonl` = incomplete. SHUTDOWN-датасет
   * неполон по определению — превращать его в архив нельзя, иначе бектест
   * примет обрубок за полную сессию рынка.
   *
   * @throws При ошибке I/O (только EXPIRED-путь: flush/close/rename)
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

    // Отменяем таймер активации если рынок не успел начаться
    if (writer.activationTimer) {
      clearTimeout(writer.activationTimer);
      writer.activationTimer = null;
    }

    // SHUTDOWN: incomplete dataset — данные отбрасываются, файл удаляется
    if (reason === 'SHUTDOWN') {
      writer.buffer = [];
      await this._destroyWriterStream(writer);
      try {
        if (fs.existsSync(writer.filePath)) {
          await fs.promises.unlink(writer.filePath);
        }
      } catch (err) {
        this._logger.warn('Failed to delete incomplete market file', {
          marketId: key,
          filePath: writer.filePath,
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
      this._logger.info('Market finalized (shutdown), incomplete file removed', {
        marketId: key,
        filePath: writer.filePath,
      });
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
   * Разрушает stream writer-а и дожидается освобождения FD ('close' event).
   *
   * @param writer - Writer рынка
   *
   * @remarks
   * Общий помощник SHUTDOWN-финализации и `close()`: unlink файла безопасен
   * только после освобождения дескриптора ОС. Уже закрытый stream
   * (`closed === true`) не ждём — 'close' повторно не эмитится. Fallback
   * 5 секунд очищается по 'close', висящих таймеров не остаётся.
   */
  private async _destroyWriterStream(writer: MarketWriter): Promise<void> {
    if (!writer.stream || writer.stream.closed) return;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 5_000);
      if (timeout.unref) timeout.unref();
      writer.stream!.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
      writer.stream!.destroy();
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

    // 3. Удаляем пустые date-директории после удаления файлов
    await this._removeEmptyDateDirs();
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
   * Завершает работу: закрывает streams, удаляет незавершённые файлы.
   *
   * @remarks
   * ### Алгоритм shutdown:
   * 1. Останавливаем flush таймер
   * 2. Отменяем таймеры активации для неначавшихся рынков
   * 3. Закрываем все активные WriteStream'ы — destroy() + ждём 'close' event (5с таймаут)
   * 4. Очищаем Map'ы (новые события игнорируются)
   * 5. Вызываем `cleanup()` — тот же disk-scan что и при запуске
   *
   * Использует тот же `cleanup()` что и при старте коллектора: сканирует диск и
   * удаляет все `.jsonl` файлы. Это гарантирует удаление ВСЕХ незавершённых файлов
   * независимо от состояния Map'ов (race condition между активными таймерами и shutdown).
   *
   * Ожидание 'close' event (паттерн из `CexFileRotator.close()`) гарантирует что
   * файловые дескрипторы освобождены ОС **до** того как `cleanup()` вызывает `unlink()`.
   *
   * @throws При ошибке I/O
   */
  public async close(): Promise<void> {
    this._stopFlushTimer();

    const writersSnapshot = [...this._writers.values()];
    this._logger.info('Closing DataRecorder', { activeMarkets: writersSnapshot.length });

    // Отменяем таймеры активации и ждём закрытия всех stream'ов.
    // Ожидание 'close' event гарантирует освобождение FD до disk-scan в cleanup().
    await Promise.all(
      writersSnapshot.map((writer) => {
        if (writer.activationTimer) {
          clearTimeout(writer.activationTimer);
          writer.activationTimer = null;
        }
        // destroy + ожидание 'close' гарантируют освобождение FD до disk-scan cleanup()
        return this._destroyWriterStream(writer);
      }),
    );

    // Очищаем Map'ы (новые события будут игнорироваться)
    this._writers.clear();
    this._tokenIndex.clear();

    // Тот же disk-scan что и при старте: сканируем outputDir и удаляем все .jsonl файлы
    await this.cleanup();

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
   * Форматирует meta-запись в fixed-width first-line block.
   *
   * @remarks
   * Padding делается пробелами: `JSON.parse(line)` принимает trailing whitespace,
   * а бектесты продолжают читать первую строку как обычный JSON.
   */
  private _formatReservedMetaLine(metaRecord: Record<string, unknown>): Buffer {
    const jsonLine = this._formatter.formatRecord(metaRecord).replace(/\r?\n$/, '');
    const jsonBytes = Buffer.byteLength(jsonLine, 'utf8');
    if (jsonBytes > META_RESERVED_BYTES - 1) {
      throw new Error(`Meta line is ${jsonBytes} bytes, max ${META_RESERVED_BYTES - 1}`);
    }

    const buffer = Buffer.alloc(META_RESERVED_BYTES, 0x20);
    buffer.write(jsonLine, 0, 'utf8');
    buffer[META_RESERVED_BYTES - 1] = 0x0a;
    return buffer;
  }

  /**
   * Проверяет, что файл был создан новым fixed-width meta форматом.
   */
  private _hasReservedMetaBlock(filePath: string): boolean {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size < META_RESERVED_BYTES) return false;

      const fd = fs.openSync(filePath, 'r');
      try {
        const header = Buffer.alloc(META_RESERVED_BYTES);
        fs.readSync(fd, header, 0, META_RESERVED_BYTES, 0);
        return header.indexOf(0x0a) === META_RESERVED_BYTES - 1;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return false;
    }
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
   * Ожидает write callback — это гарантирует что данные переданы в kernel buffer
   * и будут видны при последующем `fs.readFileSync()`. Без ожидания callback данные
   * могут остаться в Node.js internal stream buffer.
   *
   * @throws При ошибке записи в поток
   */
  private async _flushWriter(writer: MarketWriter): Promise<void> {
    if (writer.buffer.length === 0 || !writer.stream) return;

    const data = writer.buffer.join('');
    writer.buffer = [];
    writer.lastFlushTime = Date.now();

    // Ожидаем write callback: он гарантирует передачу данных в kernel buffer.
    // write() возвращает false при backpressure — callback всё равно срабатывает
    // когда данные фактически записаны, поэтому drain отдельно не нужен.
    await new Promise<void>((resolve, reject) => {
      writer.stream!.write(data, (err) => {
        if (err) {
          this._logger.error('Stream write error', { error: err.message });
          reject(err);
        } else {
          resolve();
        }
      });
    });
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
   * Запускает таймер периодического сброса.
   *
   * @remarks
   * Rejection гасится: ошибка записи уже логируется в `_flushWriter`,
   * а floating promise таймера не должен превращаться в unhandled rejection.
   */
  private _startFlushTimer(): void {
    this._flushTimer = setInterval(() => {
      this._flushAll().catch(() => {
        // Ошибка уже залогирована в _flushWriter
      });
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
