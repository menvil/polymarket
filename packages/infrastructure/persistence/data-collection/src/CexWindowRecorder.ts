/**
 * CexWindowRecorder — оконная (time-window) storage-policy CEX-партиций.
 *
 * @remarks
 * ### Место в архитектуре (N-005)
 *
 * ```text
 * CexSource → ExternalMessage → общий ExternalMessageBus
 *                                       ↓ subscribe('CEX_*')
 *                          ExternalMessageRecorder (ONE service)
 *                              ↙                       ↘
 *                    DataRecorder                CexWindowRecorder (этот класс)
 *                    market-session policy       time-window policy
 *                        ↓                            ↓
 *                    market JSONL.gz             оконные JSONL.gz
 * ```
 *
 * Один Recorder-СЕРВИС — несколько storage/writer-policy: жизненный цикл
 * CEX-партиции (непрерывный поток → выровненное окно → ротация → gzip)
 * принципиально отличается от market-session lifecycle Polymarket
 * (OPEN → SEAL → enrichment → FINALIZE), поэтому это ОТДЕЛЬНЫЙ движок, а
 * не абстракция над обоими (evidence-based решение N-005 PART 18; общая
 * механика переиспользуется точечно — {@link GzipCompressor}).
 *
 * ### Сохранённый behavioral contract legacy `CexFileRotator`
 *
 * - выровненные временные окна (production default — 5 минут);
 * - запись начинается только с ПЕРВОЙ границы окна после `start()`
 *   (записи до выравнивания сознательно отбрасываются — каждая завершённая
 *   партиция покрывает ПОЛНОЕ окно);
 * - множественные независимые writer-ы;
 * - буферизация строк (default 200) + периодический flush (default 5s);
 * - gzip завершённого окна; `.jsonl` = незавершённый, `.jsonl.gz` =
 *   завершённый;
 * - cleanup незавершённых файлов при старте и close;
 * - детерминированное naming (см. ниже).
 *
 * ### Формат партиции (Replayable Raw Format V2)
 *
 * ```text
 * LINE 1  {"t":"meta","formatVersion":2,"source":"CEX", ...routing identity...}
 * LINE 2+ {"type":"CEX_ORDERBOOK","ingress":{...},"payload":{...}}
 * ```
 *
 * Header обязателен: у CCXT-payload-а нет ни биржи, ни типа рынка, а имя
 * файла контрактом не является — reader обязан узнавать формат и routing
 * identity из самого файла. Data-строки — {@link RecordedExternalObservationV2}
 * с НЕИЗМЕНЁННЫМ source-native `payload` внутри конверта.
 *
 * ### Отличия от legacy (осознанные)
 *
 * 1. **Routing-ключ включает stream** (`orderbook`/`trades`): legacy писал
 *    оба типа записей в один файл, различая их полем `t` — V2 разводит
 *    потоки по разным физическим партициям, поэтому тип потока обязан жить
 *    в ключе партиции, имени файла и header-е.
 * 2. **Окно назначается по времени ingress НАБЛЮДЕНИЯ**: у legacy записи,
 *    пришедшие во время асинхронной ротации (gzip), попадали в буфер уже
 *    закрытого writer-а и терялись; write-time wall-clock (первая версия
 *    V2) отправлял бы наблюдение, увиденное до границы, в следующее окно.
 *    Здесь окно вычисляется из `observation.ingress` — из того же значения,
 *    которое уходит на диск.
 * 3. **Символ в имени файла санитизируется** по `[/:]` (swap-символы CCXT
 *    вида `BTC/USDT:USDT`), routing-ключ использует сырой символ.
 *
 * ### Схема именования
 *
 * ```text
 * {outputDir}/{utcDate}/{exchange}/
 *   {exchange}_{symbol}_{marketType}_{stream}_{dateET}_{startET}-{endET}_ET.jsonl[.gz]
 * ```
 *
 * Пример:
 * `snapshots/2026-08-25/binance/binance_BTC-USDT-USDT_swap_orderbook_2026-August-25_0955AM-1000AM_ET.jsonl.gz`
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ILogger } from '@polymarket/logger';
import {
  buildCexPartitionHeader,
  ingressEpochMilliseconds,
} from '@polymarket/raw-archive-format';
import type { RecordedExternalObservationV2 } from '@polymarket/raw-archive-format';
import { GzipCompressor } from './compression/GzipCompressor.js';

/** Тип потока CEX-партиции (часть routing-ключа и имени файла). */
export type CexStreamKind = 'orderbook' | 'trades';

/**
 * Исход записи одной строки через {@link CexWindowRecorder.write}.
 *
 * - `'recorded'` — строка сериализована и поставлена в буфер окна;
 * - `'inactive'` — запись сознательно отброшена (до первой границы окна
 *   либо после close) — это policy, а не ошибка;
 * - `'late'` — окно наблюдения УЖЕ завершено и заархивировано: строку
 *   некуда положить, не разрушив завершённую партицию (см. `write`);
 * - `'failed'` — запись невозможна и это ошибка (залогирована):
 *   сериализация payload либо разрушенный stream.
 */
export type CexWindowRecordOutcome = 'recorded' | 'inactive' | 'late' | 'failed';

/**
 * Конфигурация {@link CexWindowRecorder}.
 */
export interface CexWindowRecorderConfig {
  /** Директория партиций (создаётся автоматически). */
  readonly outputDir: string;
  /** Сжатие завершённого окна: `gzip` → `.jsonl.gz`, `none` → `.jsonl` остаётся. */
  readonly compression: 'none' | 'gzip';
  /**
   * Длина окна (минуты). Production default: 5.
   * Дробные значения допустимы ТОЛЬКО для тестов/smoke (короткие окна);
   * production-значение не меняется ради них.
   */
  readonly windowMinutes?: number;
  /** Максимальный буфер строк одного writer-а перед flush. Default: 200. */
  readonly bufferSize?: number;
  /** Интервал периодического flush (ms). Default: 5000. */
  readonly flushIntervalMs?: number;
  /**
   * Таймаут подтверждения stream-операций при flush/завершении окна (ms).
   * Default: 5000. Истечение таймаута — это ОТКАЗ writer-а (партиция
   * остаётся incomplete), а не успех.
   */
  readonly streamCloseTimeoutMs?: number;
  /**
   * Отсрочка ротации «тихого» окна после его границы (ms). Default: 250.
   *
   * @remarks
   * Окно партиции выбирается по времени ingress НАБЛЮДЕНИЯ, а не по
   * wall-clock момента записи, поэтому наблюдение, увиденное источником до
   * границы, обязано попасть в старое окно, даже если handler исполнился
   * чуть позже неё. Без отсрочки boundary-таймер мог бы заархивировать
   * партицию буквально в микросекундах до прихода такого наблюдения, и
   * законное наблюдение стало бы `'late'`.
   *
   * Отсрочка касается ТОЛЬКО таймера «тихих» окон: приход наблюдения
   * СЛЕДУЮЩЕГО окна по тому же ключу закрывает предыдущее немедленно —
   * внутри одного ключа поток монотонен, и более раннее наблюдение после
   * более позднего прийти не может.
   */
  readonly boundaryGraceMs?: number;
}

/**
 * Диагностические счётчики оконной политики (completion visibility).
 *
 * @remarks
 * Инвариант завершения: `partitionsCompleted` растёт ТОЛЬКО когда вся
 * обязательная цепочка `flush → close stream → gzip (если настроен)`
 * подтверждённо успешна. Любой отказ цепочки виден в `rotationFailures`
 * (+ уточняющие `streamCloseFailures`/`compressionFailures`).
 */
export interface CexWindowRecorderStats {
  /** Успешно завершённых партиций (вся цепочка finalization подтверждена). */
  readonly partitionsCompleted: number;
  /** Ротаций, НЕ завершившихся успехом (партиция осталась incomplete). */
  readonly rotationFailures: number;
  /** Отказов/таймаутов подтверждения записи или закрытия stream. */
  readonly streamCloseFailures: number;
  /** Отказов gzip-сжатия завершённого окна (`.jsonl` сохранён). */
  readonly compressionFailures: number;
  /**
   * Наблюдений, чьё окно ingress уже было завершено (исход `'late'`).
   *
   * @remarks
   * Настоящая потеря, а не policy: строка принадлежала окну, партиция
   * которого уже заархивирована. Ненулевое значение означает, что
   * {@link CexWindowRecorderConfig.boundaryGraceMs} мал для наблюдаемых
   * задержек доставки.
   */
  readonly lateObservations: number;
}

/** Состояние одного оконного writer-а. */
interface WindowWriter {
  /** Routing-ключ (exchange+symbol+marketType+stream). */
  readonly routingKey: string;
  /** Начало окна writer-а (Unix ms, выровнено). */
  readonly windowStart: number;
  /** Полный путь текущего `.jsonl`. */
  readonly filePath: string;
  buffer: string[];
  stream: fs.WriteStream | null;
  linesAccepted: number;
  /** true после ошибки stream — строки далее не принимаются. */
  failed: boolean;
  /**
   * Хвост цепочки flush-ей writer-а: конкурентные flush (threshold,
   * интервальный таймер, публичный `flush()`, ротация) сериализуются —
   * каждый resolve гарантирует, что ВСЕ ранее принятые строки подтверждены
   * stream-ом, а не только собственный drain вызова.
   */
  pendingFlush: Promise<boolean> | null;
}

const DEFAULT_WINDOW_MINUTES = 5;
const DEFAULT_BUFFER_SIZE = 200;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_STREAM_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_BOUNDARY_GRACE_MS = 250;

/**
 * Оконный storage-движок CEX-партиций: буферизация, ротация по границе
 * окна, gzip, cleanup.
 *
 * @remarks
 * ### Lifecycle
 *
 * ```text
 * cleanup() (опционально, при старте процесса)
 * start()   → выравнивание по границе окна → приём записей
 * write()   → буфер окна (flush по threshold/таймеру)
 * [граница] → ротация: flush → close stream → gzip → партиция завершена
 * close()   → таймеры сняты, in-flight ротации дождались, незавершённые
 *             .jsonl текущих окон удалены
 * ```
 *
 * ### Строгая семантика завершения партиции
 *
 * ```text
 * flush подтверждён
 *      ↓ иначе → FAILED (partition incomplete)
 * stream закрыт подтверждённо (finish)
 *      ↓ error/timeout → FAILED (без gzip)
 * gzip успешен (если compression=gzip)
 *      ↓ отказ → FAILED (.jsonl сохранён)
 * COMPLETED
 * ```
 *
 * Инвариант storage: `.jsonl.gz` существует ⇒ flush успешен ⇒ stream
 * полностью закрыт ⇒ gzip успешен. Таймаут закрытия stream — это ОТКАЗ,
 * а не успех: writer помечается failed, gzip не выполняется, партиция
 * остаётся incomplete (`.jsonl`) и будет удалена startup-cleanup-ом.
 * При `compression: 'none'` завершением считается подтверждённые
 * flush + close (политика явно настроена без архива).
 *
 * Потокобезопасность — single-threaded Node.js.
 *
 * @example
 * ```typescript
 * const storage = new CexWindowRecorder(
 *   { outputDir: './cex-snapshots', compression: 'gzip' },
 *   logger,
 * );
 * await storage.cleanup();
 * storage.start();
 * storage.write(
 *   'binance',
 *   'BTC/USDT:USDT',
 *   'swap',
 *   'orderbook',
 *   toRecordedObservation(message),
 * );
 * // ... shutdown:
 * await storage.close();
 * ```
 */
export class CexWindowRecorder {
  private readonly _logger: ILogger;
  private readonly _windowMs: number;
  private readonly _bufferSize: number;
  private readonly _flushIntervalMs: number;
  private readonly _compressor: GzipCompressor | null;
  private readonly _outputDir: string;
  /** Источник времени (инъецируем в тестах для детерминизма окон). */
  private readonly _now: () => number;

  /** Активные writer-ы: routingKey → writer ТЕКУЩЕГО окна ключа. */
  private readonly _writers = new Map<string, WindowWriter>();
  /**
   * routingKey → самое позднее окно, для которого writer уже открывался.
   *
   * @remarks
   * Вместе с наличием активного writer-а образует watermark «партиция окна
   * закрыта»: окно старше последнего открытого закрыто всегда, а последнее
   * открытое — как только его writer снят (ротация по приходу следующего
   * окна ЛИБО boundary-sweep «тихого» окна).
   *
   * Партиция завершённого окна уже сжата и удалена как `.jsonl`; повторное
   * открытие writer-а того же окна создало бы второй `.jsonl`, а его ротация
   * заменила бы (`rename`) завершённый `.jsonl.gz` архивом из одной
   * опоздавшей строки. Поэтому такое наблюдение отвергается как `'late'`, а
   * не «дописывается».
   */
  private readonly _latestWindowStart = new Map<string, number>();
  /** In-flight ротации (gzip): close() дожидается их завершения. */
  private readonly _pendingRotations = new Set<Promise<void>>();
  private _boundaryTimer: ReturnType<typeof setTimeout> | null = null;
  private _flushTimer: ReturnType<typeof setInterval> | null = null;
  /** Первая граница, с которой принимаются записи (полные окна). */
  private _firstWindowStart = Number.POSITIVE_INFINITY;
  private _started = false;
  private _closed = false;
  private _closePromise: Promise<void> | null = null;
  private readonly _streamCloseTimeoutMs: number;
  /** Отсрочка ротации «тихого» окна после его границы (ms). */
  private readonly _boundaryGraceMs: number;
  /** Фабрика writable stream партиции (test hook). */
  private readonly _createStream: (filePath: string) => fs.WriteStream;

  // Счётчики CexWindowRecorderStats (mutable-состояние диагностики)
  private _partitionsCompleted = 0;
  private _rotationFailures = 0;
  private _streamCloseFailures = 0;
  private _compressionFailures = 0;
  private _lateObservations = 0;

  /**
   * @param config - Конфигурация оконной политики
   * @param logger - Логгер (будет обёрнут в child с component-контекстом)
   * @param now - @internal Test hook: источник времени. Default: `Date.now`
   * @param createStream - @internal Test hook: фабрика writable stream
   *   партиции (детерминированные failure-тесты hang/error путей).
   *   Default: `fs.createWriteStream(filePath, { flags: 'a' })`
   */
  constructor(
    config: CexWindowRecorderConfig,
    logger: ILogger,
    now: () => number = Date.now,
    createStream: (filePath: string) => fs.WriteStream = (filePath) =>
      fs.createWriteStream(filePath, { flags: 'a' }),
  ) {
    this._createStream = createStream;
    this._logger = logger.child({ component: 'CexWindowRecorder' });
    this._windowMs = Math.max(1, Math.round((config.windowMinutes ?? DEFAULT_WINDOW_MINUTES) * 60_000));
    this._bufferSize = config.bufferSize ?? DEFAULT_BUFFER_SIZE;
    this._flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this._compressor = config.compression === 'gzip' ? new GzipCompressor() : null;
    this._streamCloseTimeoutMs = config.streamCloseTimeoutMs ?? DEFAULT_STREAM_CLOSE_TIMEOUT_MS;
    this._boundaryGraceMs = Math.max(0, config.boundaryGraceMs ?? DEFAULT_BOUNDARY_GRACE_MS);
    this._now = now;
    this._outputDir = config.outputDir;
  }

  /**
   * Возвращает снимок диагностических счётчиков оконной политики.
   *
   * @returns Текущие значения {@link CexWindowRecorderStats}
   */
  public getStats(): CexWindowRecorderStats {
    return {
      partitionsCompleted: this._partitionsCompleted,
      rotationFailures: this._rotationFailures,
      streamCloseFailures: this._streamCloseFailures,
      compressionFailures: this._compressionFailures,
      lateObservations: this._lateObservations,
    };
  }

  /** true после {@link CexWindowRecorder.close}. */
  public get isClosed(): boolean {
    return this._closed;
  }

  /**
   * Запускает оконную политику: приём записей начнётся с ПЕРВОЙ границы
   * окна после вызова (записи до выравнивания отбрасываются как `inactive`).
   *
   * @remarks
   * Идемпотентен. Параллельно запускает периодический flush-таймер и
   * boundary-таймер ротации «тихих» writer-ов (окна без новых записей
   * завершаются по границе, а не ждут следующей записи своего ключа).
   */
  public start(): void {
    if (this._started || this._closed) {
      return;
    }
    this._started = true;
    const now = this._now();
    this._firstWindowStart = this._nextBoundary(now);

    this._logger.info('CexWindowRecorder started, waiting for window alignment', {
      firstWindowUTC: new Date(this._firstWindowStart).toISOString(),
      delayMs: this._firstWindowStart - now,
      windowMs: this._windowMs,
    });

    this._scheduleBoundarySweep();
    this._flushTimer = setInterval(() => {
      void this._flushAll();
    }, this._flushIntervalMs);
    this._flushTimer.unref?.();
  }

  /**
   * Записывает V2-наблюдение в партицию ЕГО окна ingress.
   *
   * @param exchangeId - Идентификатор биржи (routing)
   * @param symbol - Сырой unified-символ (routing; в имени файла
   *   санитизируется)
   * @param marketType - Тип рынка (routing)
   * @param stream - Тип потока (routing: партиции стакана и сделок раздельны)
   * @param observation - V2-наблюдение (`{type, ingress, payload}`);
   *   `payload` внутри — НЕИЗМЕНЁННЫЙ source-native объект
   * @returns Исход записи (см. {@link CexWindowRecordOutcome})
   *
   * @remarks
   * ### Окно выбирается по времени ingress, а не по времени записи
   *
   * Между наблюдением источника и исполнением storage-handler-а лежат bus и
   * планировщик. Наблюдение, увиденное ДО границы окна, обязано попасть в
   * СТАРОЕ окно, даже если handler исполнился уже после неё: wall-clock
   * момента записи — это время нашей обработки, а не время наблюдения.
   * Поэтому окно вычисляется из `observation.ingress` — из того же значения,
   * которое уходит на диск.
   *
   * ### Смена окна и опоздания
   *
   * Наблюдение СЛЕДУЮЩЕГО окна по тому же ключу немедленно отправляет
   * предыдущее окно в ротацию, а само пишется в writer нового окна (у legacy
   * такие строки терялись в буфере закрытого writer-а). Наблюдение окна,
   * партиция которого для этого ключа уже закрыта, возвращает `'late'`:
   * воскрешать заархивированную партицию нельзя — новая ротация заменила бы
   * (`rename`) `.jsonl.gz` полного окна архивом из одной опоздавшей строки.
   *
   * Закрытым считается и окно, writer которого снял boundary-sweep, ещё НЕ
   * увидев наблюдения следующего окна: watermark — пара «последнее открытое
   * окно + наличие его активного writer-а», а не только номер окна.
   */
  public write(
    exchangeId: string,
    symbol: string,
    marketType: string,
    stream: CexStreamKind,
    observation: RecordedExternalObservationV2,
  ): CexWindowRecordOutcome {
    if (this._closed || !this._started) {
      return 'inactive';
    }
    const observedAtMs = ingressEpochMilliseconds(observation.ingress);
    const windowStart = this._windowStartOf(observedAtMs);
    if (windowStart < this._firstWindowStart) {
      return 'inactive';
    }

    let line: string;
    try {
      line = `${JSON.stringify(observation)}\n`;
    } catch (error) {
      this._logger.error('Failed to serialize CEX observation line', {
        exchangeId,
        symbol,
        stream,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'failed';
    }

    const routingKey = this._routingKey(exchangeId, symbol, marketType, stream);
    let writer = this._writers.get(routingKey);
    const latestWindowStart = this._latestWindowStart.get(routingKey);
    // Партиция окна закрыта, если writer этого окна уже НЕ активен. Два пути:
    // окно старше последнего открытого (его writer давно ротирован) либо это
    // ЕЩЁ последнее открытое окно, но его writer уже снят — boundary-sweep
    // забрал его в ротацию, не дожидаясь наблюдения следующего окна.
    // Проверять только `<` недостаточно: после sweep-а равенство прошло бы
    // дальше и _createWriter открыл бы ВТОРОЙ `.jsonl` того же окна, а его
    // ротация заменила бы (rename) готовый `.jsonl.gz` полного окна архивом
    // из одной опоздавшей строки.
    if (
      latestWindowStart !== undefined &&
      (windowStart < latestWindowStart ||
        (windowStart === latestWindowStart && writer === undefined))
    ) {
      this._lateObservations++;
      this._logger.warn('CEX observation arrived after its window was archived', {
        exchangeId,
        symbol,
        marketType,
        stream,
        observationWindowUTC: new Date(windowStart).toISOString(),
        latestWindowUTC: new Date(latestWindowStart).toISOString(),
      });
      return 'late';
    }
    if (writer && writer.windowStart !== windowStart) {
      // Ключ пересёк границу: прежнее окно уходит в ротацию, новое — сразу
      // принимает запись (без гонки с асинхронным gzip)
      this._writers.delete(routingKey);
      this._trackRotation(this._rotateWriter(writer));
      writer = undefined;
    }
    if (!writer) {
      try {
        writer = this._createWriter(routingKey, exchangeId, symbol, marketType, stream, windowStart);
      } catch (error) {
        this._logger.error('Failed to open CEX window writer', {
          exchangeId,
          symbol,
          stream,
          error: error instanceof Error ? error.message : String(error),
        });
        return 'failed';
      }
      this._writers.set(routingKey, writer);
      this._latestWindowStart.set(routingKey, windowStart);
    }
    if (writer.failed || !writer.stream) {
      return 'failed';
    }

    writer.buffer.push(line);
    writer.linesAccepted++;
    if (writer.buffer.length >= this._bufferSize) {
      void this._flushWriter(writer);
    }
    return 'recorded';
  }

  /**
   * Принудительный flush всех буферов на диск.
   *
   * @returns Promise завершения записи буферов
   */
  public async flush(): Promise<void> {
    await this._flushAll();
  }

  /**
   * Удаляет незавершённые `.jsonl` (без `.gz`) из датированных директорий.
   *
   * @returns Promise завершения очистки
   *
   * @remarks
   * Вызывается при старте процесса: остатки прошлого некорректно
   * завершённого запуска (незавершённые окна) не подлежат восстановлению —
   * семантика `.jsonl` = incomplete сохранена из legacy. Завершённые
   * `.jsonl.gz` не трогаются.
   */
  public async cleanup(): Promise<void> {
    let dateDirs: fs.Dirent[];
    try {
      dateDirs = await fs.promises.readdir(this._outputDir, { withFileTypes: true });
    } catch {
      return; // директории ещё нет — чистить нечего
    }

    let deleted = 0;
    for (const dateEntry of dateDirs) {
      if (!dateEntry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(dateEntry.name)) continue;
      const dateDir = path.join(this._outputDir, dateEntry.name);

      let exchangeDirs: fs.Dirent[];
      try {
        exchangeDirs = await fs.promises.readdir(dateDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const exchangeEntry of exchangeDirs) {
        if (!exchangeEntry.isDirectory()) continue;
        const exchangeDir = path.join(dateDir, exchangeEntry.name);

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
            // Файл мог исчезнуть параллельно — cleanup best-effort
          }
        }
      }
    }

    if (deleted > 0) {
      this._logger.info('CexWindowRecorder cleaned up incomplete files', { deleted });
    }
  }

  /**
   * Останавливает политику: таймеры сняты, in-flight ротации дождались,
   * незавершённые файлы текущих окон удалены.
   *
   * @returns Promise завершения shutdown (идемпотентен)
   *
   * @remarks
   * Незавершённое окно НЕ архивируется: его данные не покрывают полное
   * окно (семантика legacy). Уже завершённые `.jsonl.gz` не трогаются.
   */
  public async close(): Promise<void> {
    if (this._closePromise) {
      return this._closePromise;
    }
    this._closed = true;
    if (this._boundaryTimer) {
      clearTimeout(this._boundaryTimer);
      this._boundaryTimer = null;
    }
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }

    const writersSnapshot = [...this._writers.values()];
    this._writers.clear();

    this._closePromise = (async () => {
      // Сначала дожидаемся ротаций, начатых ДО close: их партиции завершены
      // легитимно и должны быть сжаты
      await Promise.allSettled([...this._pendingRotations]);

      // Незавершённые окна: stream разрушается, файл удаляется
      await Promise.all(
        writersSnapshot.map(async (writer) => {
          await this._destroyStream(writer);
          try {
            await fs.promises.unlink(writer.filePath);
          } catch {
            // Файл мог не существовать (writer без единого flush)
          }
        }),
      );
      this._logger.info('CexWindowRecorder closed', {
        deletedIncomplete: writersSnapshot.length,
      });
    })();
    return this._closePromise;
  }

  // ───────────────────────── Ротация окон ─────────────────────────

  /**
   * Планирует sweep «тихих» writer-ов на следующую границу окна + grace.
   *
   * @remarks
   * Grace даёт наблюдениям, увиденным до границы, но доставленным чуть
   * позже неё, попасть в СВОЁ окно до его архивации
   * ({@link CexWindowRecorderConfig.boundaryGraceMs}).
   */
  private _scheduleBoundarySweep(): void {
    if (this._closed) return;
    const now = this._now();
    const delay = Math.max(0, this._nextBoundary(now) + this._boundaryGraceMs - now);
    this._boundaryTimer = setTimeout(() => {
      this._sweepExpiredWindows();
      this._scheduleBoundarySweep();
    }, delay);
    this._boundaryTimer.unref?.();
  }

  /**
   * Ротирует writer-ы, чьё окно закончилось более чем grace назад.
   *
   * @remarks
   * Условие — по абсолютному времени конца окна, а не по номеру текущего
   * окна: только так grace фактически защищает граничные наблюдения.
   */
  private _sweepExpiredWindows(): void {
    const now = this._now();
    for (const [routingKey, writer] of [...this._writers]) {
      if (writer.windowStart + this._windowMs + this._boundaryGraceMs <= now) {
        this._writers.delete(routingKey);
        this._trackRotation(this._rotateWriter(writer));
      }
    }
  }

  /**
   * Регистрирует in-flight ротацию (close() дожидается).
   *
   * @remarks
   * Rejection ротации (синхронный throw stream-метода и т.п.) поглощается
   * ЗДЕСЬ с маршрутизацией в счётчики — фоновая ротация никем больше не
   * await-ится, невыловленный отказ стал бы unhandled rejection.
   */
  private _trackRotation(rotation: Promise<void>): void {
    const tracked = rotation
      .catch((error) => {
        this._rotationFailures++;
        this._logger.error('CEX window rotation crashed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this._pendingRotations.delete(tracked);
      });
    this._pendingRotations.add(tracked);
  }

  /**
   * Завершает окно writer-а строгой цепочкой: flush → close stream → gzip.
   *
   * @param writer - Writer завершённого окна (уже удалён из map)
   *
   * @remarks
   * Партиция объявляется completed ТОЛЬКО при подтверждённом успехе всех
   * обязательных этапов. Любой отказ (flush error/timeout, stream
   * error/timeout, gzip error) оставляет `.jsonl` incomplete-артефактом:
   * gzip НЕ выполняется поверх неподтверждённых данных, «completed» не
   * логируется, отказ учитывается в счётчиках. Незавершённый артефакт
   * удалит startup-cleanup следующего запуска (та же судьба, что у любых
   * incomplete `.jsonl`).
   */
  private async _rotateWriter(writer: WindowWriter): Promise<void> {
    const flushed = await this._flushWriter(writer);
    const closed = await this._endStream(writer);

    if (!flushed || !closed || writer.failed) {
      this._rotationFailures++;
      this._logger.error('CEX window rotation failed, partition left incomplete', {
        filePath: writer.filePath,
        flushConfirmed: flushed,
        streamClosed: closed,
        windowUTC: new Date(writer.windowStart).toISOString(),
      });
      return;
    }

    if (this._compressor) {
      try {
        await this._compressor.compressFile(writer.filePath);
        this._logger.debug('CEX window partition compressed', { filePath: writer.filePath });
      } catch (error) {
        // Компрессор не удаляет исходник при отказе — .jsonl остаётся
        // incomplete-артефактом, completed-статус НЕ объявляется
        this._compressionFailures++;
        this._rotationFailures++;
        this._logger.error('CEX window compression failed, partition left incomplete', {
          filePath: writer.filePath,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }

    this._partitionsCompleted++;
    this._logger.info('CEX window partition completed', {
      filePath: writer.filePath,
      lines: writer.linesAccepted,
      compressed: this._compressor !== null,
      windowUTC: new Date(writer.windowStart).toISOString(),
    });
  }

  // ───────────────────────── Writer-ы и запись ─────────────────────────

  /**
   * Открывает writer окна и ставит в его буфер header-строку партиции.
   *
   * @remarks
   * Header — LINE 1 партиции: он объявляет `formatVersion` и полную routing
   * identity (`exchangeId + marketType + stream` + `symbol` + границы окна).
   * Reader не обязан выводить формат из имени файла или из формы первой
   * data-строки. Header кладётся в тот же FIFO-буфер, что и наблюдения,
   * поэтому он гарантированно уходит на диск первым; партиция без единого
   * наблюдения не создаётся вовсе (writer открывается лениво).
   */
  private _createWriter(
    routingKey: string,
    exchangeId: string,
    symbol: string,
    marketType: string,
    stream: CexStreamKind,
    windowStart: number,
  ): WindowWriter {
    const filePath = this._buildFilePath(exchangeId, symbol, marketType, stream, windowStart);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      this._logger.warn('Deleted leftover incomplete CEX window file', { filePath });
    }

    const header = buildCexPartitionHeader({
      exchangeId,
      marketType,
      symbol,
      stream,
      windowStartMs: windowStart,
      windowEndMs: windowStart + this._windowMs,
    });

    const writer: WindowWriter = {
      routingKey,
      windowStart,
      filePath,
      buffer: [`${JSON.stringify(header)}\n`],
      stream: this._createStream(filePath),
      linesAccepted: 0,
      failed: false,
      pendingFlush: null,
    };
    writer.stream!.on('error', (error) => {
      writer.failed = true;
      this._logger.error('CEX window stream error', { filePath, error: error.message });
    });

    this._logger.debug('CEX window writer opened', { filePath });
    return writer;
  }

  /**
   * Пишет буфер writer-а в stream и дожидается ПОДТВЕРЖДЕНИЯ, сериализуя
   * конкурентные flush-и.
   *
   * @param writer - Writer для сброса буфера
   * @returns `true` — все принятые к этому моменту строки подтверждённо
   *   переданы stream-у; `false` — write error либо таймаут подтверждения
   *   (writer помечен failed, партиция не может стать completed)
   *
   * @remarks
   * Flush-и одного writer-а выстраиваются в цепочку (`pendingFlush`):
   * без этого конкурентный вызов (например, публичный `flush()` во время
   * in-flight интервального) увидел бы уже опустошённый буфер и resolve-ился
   * бы ДО того, как чужие данные подтверждены stream-ом — наблюдаемое
   * состояние файла врало бы вызывающему (ротация начала бы gzip раньше
   * подтверждения записи).
   */
  private _flushWriter(writer: WindowWriter): Promise<boolean> {
    const previous = writer.pendingFlush;
    const current = (async (): Promise<boolean> => {
      let previousOk = true;
      if (previous !== null) {
        try {
          previousOk = await previous;
        } catch {
          previousOk = false; // отказ предыдущего звена уже учтён им самим
        }
      }
      let drained = false;
      try {
        drained = await this._drainWriterBuffer(writer);
      } catch (error) {
        // Синхронный throw stream.write и т.п.: flush никогда не reject-ится
        // (hot path вызывает его через void) — отказ фиксируется состоянием
        writer.failed = true;
        this._streamCloseFailures++;
        this._logger.error('CEX window flush crashed', {
          filePath: writer.filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return previousOk && drained && !writer.failed;
    })();
    writer.pendingFlush = current;
    return current;
  }

  /**
   * Один drain буфера в stream с подтверждением write-callback-ом.
   *
   * @param writer - Writer для сброса буфера
   * @returns `true` — буфер подтверждённо передан (или был пуст);
   *   `false` — write error либо таймаут подтверждения
   *
   * @remarks
   * Подтверждение нужно ротации: gzip читает файл сразу после flush.
   * Ожидание ограничено `streamCloseTimeoutMs` — зависший FS не
   * подвешивает ротацию/shutdown; таймаут = отказ writer-а, НЕ успех
   * (поздний callback гонки не создаёт: failed-writer больше не участвует
   * в завершении).
   */
  private async _drainWriterBuffer(writer: WindowWriter): Promise<boolean> {
    if (writer.failed) return false;
    if (writer.buffer.length === 0) return true;
    const stream = writer.stream;
    if (!stream) return false;

    const data = writer.buffer.join('');
    writer.buffer = [];

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      const timer = setTimeout(() => {
        writer.failed = true;
        this._streamCloseFailures++;
        this._logger.error('CEX window flush confirmation timed out', {
          filePath: writer.filePath,
          timeoutMs: this._streamCloseTimeoutMs,
        });
        settle(false);
      }, this._streamCloseTimeoutMs);
      timer.unref?.();

      stream.write(data, (error) => {
        clearTimeout(timer);
        if (error) {
          writer.failed = true;
          this._streamCloseFailures++;
          this._logger.error('CEX window stream write error', {
            filePath: writer.filePath,
            error: error.message,
          });
          settle(false);
          return;
        }
        settle(!writer.failed);
      });
    });
  }

  private async _flushAll(): Promise<void> {
    await Promise.all([...this._writers.values()].map((writer) => this._flushWriter(writer)));
  }

  /**
   * Завершает writable stream writer-а с ЯВНОЙ семантикой исхода.
   *
   * @param writer - Writer завершаемого окна
   * @returns `true` — stream подтверждённо завершён (finish) и writer не
   *   failed; `false` — stream error либо таймаут завершения
   *
   * @remarks
   * Исходы:
   * - **finish** — единственный успех;
   * - **stream error** — writer.failed, stream разрушается, `false`;
   * - **timeout** — это ОТКАЗ, а не успех: writer.failed, stream
   *   разрушается best-effort (dangling writable не остаётся), `false`.
   *
   * После `false` вызывающая ротация обязана НЕ выполнять gzip и НЕ
   * объявлять партицию completed.
   */
  private async _endStream(writer: WindowWriter): Promise<boolean> {
    const stream = writer.stream;
    if (!stream) return !writer.failed;
    writer.stream = null;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };

      const timer = setTimeout(() => {
        writer.failed = true;
        this._streamCloseFailures++;
        this._logger.error('CEX window stream close timed out, partition left incomplete', {
          filePath: writer.filePath,
          timeoutMs: this._streamCloseTimeoutMs,
        });
        stream.destroy();
        settle(false);
      }, this._streamCloseTimeoutMs);
      timer.unref?.();

      stream.once('error', (error) => {
        writer.failed = true;
        this._streamCloseFailures++;
        this._logger.error('CEX window stream close error', {
          filePath: writer.filePath,
          error: error.message,
        });
        clearTimeout(timer);
        stream.destroy();
        settle(false);
      });

      stream.end((error?: Error | null) => {
        clearTimeout(timer);
        if (error) {
          writer.failed = true;
          this._streamCloseFailures++;
          this._logger.error('CEX window stream close error', {
            filePath: writer.filePath,
            error: error.message,
          });
          settle(false);
          return;
        }
        settle(!writer.failed);
      });
    });
  }

  /**
   * Разрушает stream writer-а без дозаписи (файл будет удалён).
   *
   * @remarks
   * Best-effort cleanup для shutdown-пути: успех здесь не требуется
   * (артефакт всё равно удаляется как incomplete), поэтому таймаут только
   * ограничивает ожидание, ничего не «засчитывая» успехом.
   */
  private async _destroyStream(writer: WindowWriter): Promise<void> {
    const stream = writer.stream;
    if (!stream) return;
    writer.stream = null;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this._streamCloseTimeoutMs);
      timer.unref?.();
      stream.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      stream.destroy();
    });
  }

  // ───────────────────────── Naming и время ─────────────────────────

  private _routingKey(
    exchangeId: string,
    symbol: string,
    marketType: string,
    stream: CexStreamKind,
  ): string {
    return `${exchangeId}\n${symbol}\n${marketType}\n${stream}`;
  }

  /** Начало окна, содержащего момент `ms`. */
  private _windowStartOf(ms: number): number {
    return Math.floor(ms / this._windowMs) * this._windowMs;
  }

  /** Ближайшая граница окна ПОСЛЕ момента `ms`. */
  private _nextBoundary(ms: number): number {
    return this._windowStartOf(ms) + this._windowMs;
  }

  /**
   * Полный путь партиции окна.
   *
   * @remarks
   * Организация сохранена из legacy: `{utcDate}/{exchange}/`, метки времени
   * окна — Eastern Time. Добавлен сегмент `stream`; символ санитизируется
   * по `[/:]` (unified swap-символы CCXT содержат двоеточие).
   */
  private _buildFilePath(
    exchangeId: string,
    symbol: string,
    marketType: string,
    stream: CexStreamKind,
    windowStart: number,
  ): string {
    const utcDate = new Date(windowStart).toISOString().slice(0, 10);
    const windowEnd = windowStart + this._windowMs;
    const dateLabel = this._formatDateET(windowStart);
    const startLabel = this._formatTimeET(windowStart);
    const endLabel = this._formatTimeET(windowEnd);
    const safeSymbol = symbol.replace(/[/:]/g, '-');
    const fileName =
      `${exchangeId}_${safeSymbol}_${marketType}_${stream}_` +
      `${dateLabel}_${startLabel}-${endLabel}_ET.jsonl`;
    return path.join(this._outputDir, utcDate, exchangeId, fileName);
  }

  /** Дата окна в Eastern Time: `2026-August-25`. */
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

  /**
   * Время в Eastern Time: `0955AM`.
   *
   * @remarks
   * Для окон, НЕ кратных минуте (только тестовые/smoke-конфигурации),
   * метка дополняется секундами — иначе два разных окна внутри одной
   * минуты получили бы одинаковое имя и вторая партиция перезаписала бы
   * первую. Production-окна (кратные минуте) сохраняют legacy-формат
   * байт-в-байт.
   */
  private _formatTimeET(ms: number): string {
    const subMinuteWindow = this._windowMs % 60_000 !== 0;
    const raw = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      // Двузначный час: документированный формат метки HHMM («0955AM»);
      // 'numeric' давал бы «955AM» для часов 1-9
      hour: '2-digit',
      minute: '2-digit',
      ...(subMinuteWindow ? { second: '2-digit' as const } : {}),
      hour12: true,
    }).format(new Date(ms));
    return raw.replace(/[: ]/g, '');
  }
}
