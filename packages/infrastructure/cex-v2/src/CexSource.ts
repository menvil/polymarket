/**
 * CexSource — ingress boundary CEX V2 над CCXT / CCXT Pro.
 *
 * @remarks
 * ### Поток данных
 *
 * ```text
 * CCXT Pro (watchOrderBook* / watchTrades* / fetchOrderBook)
 *         ↓  live vendor-объект
 * JSON-снапшот момента наблюдения (+ truncate depth стакана)
 *         ↓
 * ExternalMessage {
 *   type:     CEX_ORDERBOOK | CEX_TRADE,
 *   payload:  { exchangeId, marketType, symbol, orderBook|trade },
 *   metadata: metadataGenerator.nextRoot(),
 * }
 *         ↓
 * общий ExternalMessageBus (инъецируется, НЕ создаётся здесь)
 * ```
 *
 * ### Транспортная архитектура (сохранена из production legacy-коллектора)
 *
 * - один CCXT Pro инстанс НА ПОТОК (стакан / сделки) для всех символов
 *   биржи: потоки операционно независимы — сбой транспорта стакана не
 *   валит поток сделок и наоборот;
 * - предпочтителен multiplex (`watchOrderBookForSymbols` /
 *   `watchTradesForSymbols`), fallback — per-symbol `watch*`, для стакана —
 *   сконфигурированный REST `fetchOrderBook`;
 * - supervised restart (`RestartingTask`): exponential backoff, cooldown
 *   после серии отказов;
 * - stale-таймауты (60s стакан / 180s сделки) — зависший watch считается
 *   отказом сессии;
 * - плановый перезапуск инстансов (default 30 мин, ±10% jitter) —
 *   контроль внутренних кэшей/памяти CCXT Pro;
 * - hung-book detection (`ask < bid`) — controlled restart сессии стакана.
 *
 * ### Сделки: без повторной эмиссии кэша
 *
 * Инстансы создаются с ЯВНЫМ `newUpdates: true` (официальный механизм
 * CCXT Pro): каждый resolve `watchTrades*` возвращает ТОЛЬКО новые сделки
 * с прошлого вызова. Ручная очистка внутреннего кэша vendor-а (как в
 * legacy) не выполняется — она не нужна для корректности, а объём кэша
 * ограничен самим CCXT (`tradesLimit`) и плановым перезапуском инстансов.
 * Эвристический dedup по `price+timestamp` сознательно отсутствует: две
 * легитимные сделки с одинаковыми ценой и временем не склеиваются.
 *
 * ### Policy отказов (та же семантика, что у PolymarketSource)
 *
 * - **transport/vendor отказ** (сеть, WS, rejection watch, stale, crossed
 *   book) — проблема сессии: закрытие инстанса → supervised backoff →
 *   новый инстанс → resubscribe; второй поток не затрагивается;
 * - **`Err` от `bus.publish`** — отказ КОНТУРА ДОСТАВКИ, а не транспорта:
 *   source переходит в наблюдаемое терминальное `failed`, останавливает
 *   ОБА потока; retry поверх failed publish сознательно отсутствует —
 *   молчаливой потери наблюдений нет (переход залогирован, `hasFailed`
 *   наблюдаем);
 * - **несериализуемый vendor-объект** — наблюдение пропускается с
 *   error-логом (один битый объект не убивает поток).
 */
import type { ILogger } from '@polymarket/logger';
import type { MessageBusPublishError } from '@polymarket/message-bus';
import type { MessageMetadataGenerator } from '@polymarket/messages';
import type { Result } from '@polymarket/result';
import type {
  CexExternalMessage,
  CexOrderbookExternalMessage,
  CexTradeExternalMessage,
} from './CexExternalMessage.js';
import type {
  CcxtProExchangeFactory,
  CcxtProExchangeInstance,
  CcxtRawOrderBook,
  CcxtRawTrade,
} from './CcxtVendorPort.js';
import { createCcxtProExchange, normalizeOrderbookDepth } from './CcxtVendorPort.js';
import type { CexSourceConfig } from './CexSourceConfig.js';
import {
  DEFAULT_CLOSE_TIMEOUT_MS,
  DEFAULT_FETCH_POLL_INTERVAL_MS,
  DEFAULT_INITIAL_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_ORDERBOOK_DEPTH,
  DEFAULT_ORDERBOOK_STALE_TIMEOUT_MS,
  DEFAULT_RESTART_INTERVAL_MS,
  DEFAULT_TRADES_STALE_TIMEOUT_MS,
  PLANNED_RESTART_JITTER_RATIO,
  assertValidCexSourceConfig,
} from './CexSourceConfig.js';
import { PermanentTaskError, RestartingTask } from './RestartingTask.js';
import { snapshotOrderBook, snapshotTrade } from './snapshots.js';

/**
 * Порт публикации CEX-сообщений в общий ExternalMessageBus.
 *
 * @remarks
 * Структурное подмножество `IExternalMessageBus` (только `publish`).
 * Узкий тип обязателен: общий bus контура параметризуется union-ом всех
 * sources (`ExternalMessageBus<PolymarketExternalMessage |
 * CexExternalMessage>`), и `publish` контравариантен по сообщению — bus с
 * более широким union подходит под порт без кастов.
 */
export interface CexExternalMessagePublisher {
  /**
   * Публикует одно внешнее сообщение (контракт `ExternalMessageBus.publish`).
   *
   * @param message - Полное сообщение `{ type, payload, metadata }`
   * @returns Canonical Result движка доставки
   */
  publish(message: CexExternalMessage): Promise<Result<void, MessageBusPublishError>>;
}

/**
 * Зависимости {@link CexSource}.
 *
 * @remarks
 * Ownership: composition root создаёт ОДИН общий ExternalMessageBus и ОДИН
 * canonical metadata generator на процесс и передаёт их каждому source.
 * CCXT-инстансы создаёт и закрывает сам source (per-session).
 */
export interface CexSourceDependencies {
  /** Конфигурация source (одна биржа × один тип рынка). */
  readonly config: CexSourceConfig;
  /** Общий bus внешнего контура (используется только `publish`). */
  readonly bus: CexExternalMessagePublisher;
  /** Canonical генератор metadata runtime (один на процесс). */
  readonly metadataGenerator: MessageMetadataGenerator;
  /** Логгер (будет обёрнут в child с component-контекстом). */
  readonly logger: ILogger;
  /** @internal Test hook: фабрика CCXT-инстансов. Default: реальный ccxt.pro. */
  readonly exchangeFactory?: CcxtProExchangeFactory;
  /** @internal Test hook: источник случайности для jitter. */
  readonly random?: () => number;
}

/**
 * Диагностические счётчики source (loss visibility).
 *
 * @remarks
 * Несериализуемое vendor-наблюдение пропускается (поток жив), но потеря
 * обязана быть ИЗМЕРИМОЙ, а не существовать только в логах: после
 * smoke/runtime ожидается `*SnapshotFailures = 0`, любое ненулевое
 * значение — сигнал деградации vendor-данных.
 */
export interface CexSourceStats {
  /** Отказов снапшота стакана (наблюдение пропущено, error-лог записан). */
  readonly orderbookSnapshotFailures: number;
  /** Отказов снапшота сделки (наблюдение пропущено, error-лог записан). */
  readonly tradeSnapshotFailures: number;
}

/** Sentinel гонки publish ↔ abort сессии. */
const PUBLISH_ABORTED: unique symbol = Symbol('cex-source-publish-aborted');

/** Исход эмиссии одного наблюдения внутри сессионного цикла. */
type EmitOutcome = 'continue' | 'restart' | 'stop';

/**
 * Ingress boundary CEX V2: наблюдения CCXT Pro → canonical ExternalMessages
 * → общий ExternalMessageBus.
 *
 * @remarks
 * ### Lifecycle
 *
 * ```text
 * constructed → start() → running → close() → stopped
 *                            ↓ Err от bus.publish
 *                          failed (терминально, оба потока остановлены)
 * ```
 *
 * Гарантии:
 * - повторный `start()` — no-op (вторые watcher-ы не создаются);
 * - `start()` после `close()`/отказа — ошибка (терминальные состояния);
 * - `close()` идемпотентен, абортит transport-циклы, дожидается их
 *   завершения; pending watch-promises закрываются закрытием инстанса;
 * - CCXT-инстанс закрывается максимум один раз (per-session once-guard);
 * - после завершённого `close()` новых publish нет (сессии завершены);
 * - unhandled rejections исключены (все race-промисы обрабатываются);
 * - restart-механика не может воскресить поток после shutdown
 *   (инвариант `RestartingTask`);
 * - рестарт потока стакана не затрагивает поток сделок и наоборот
 *   (независимые `RestartingTask` + отдельные CCXT-инстансы).
 *
 * @example
 * ```typescript
 * // Composition root:
 * const bus = new ExternalMessageBus<PolymarketExternalMessage | CexExternalMessage>();
 * const source = new CexSource({
 *   config: {
 *     exchangeId: 'binance',
 *     marketType: 'swap',
 *     symbols: ['BTC/USDT:USDT'],
 *     watchOrderbook: true,
 *     watchTrades: true,
 *   },
 *   bus,
 *   metadataGenerator,
 *   logger,
 * });
 * source.start();
 * // Shutdown:
 * await source.close();
 * ```
 */
export class CexSource {
  private readonly _config: CexSourceConfig;
  private readonly _bus: CexExternalMessagePublisher;
  private readonly _metadataGenerator: MessageMetadataGenerator;
  private readonly _logger: ILogger;
  private readonly _exchangeFactory: CcxtProExchangeFactory;
  private readonly _random: () => number;

  private readonly _symbols: readonly string[];
  private readonly _effectiveDepth: number;
  private readonly _obStaleTimeoutMs: number;
  private readonly _tradesStaleTimeoutMs: number;
  private readonly _fetchPollIntervalMs: number;
  private readonly _closeTimeoutMs: number;
  private readonly _restartIntervalMs: number;

  private readonly _obTask: RestartingTask | null;
  private readonly _tradesTask: RestartingTask | null;

  private _started = false;
  private _closed = false;
  private _failed = false;
  // Счётчики CexSourceStats (mutable-состояние диагностики)
  private _orderbookSnapshotFailures = 0;
  private _tradeSnapshotFailures = 0;
  /** Promise остановки потоков, начатой терминальным отказом pipeline. */
  /**
   * Незавершённые операции закрытия CCXT-инстансов.
   *
   * @remarks
   * Существует ровно ради честного `close()`. Session-level cleanup ждёт
   * закрытие инстанса НЕ дольше `closeTimeoutMs` (иначе зависший vendor
   * подвесил бы supervised restart навсегда), но истёкший таймаут —
   * это «мы перестали ЖДАТЬ», а не «teardown завершён». Забытая таким
   * образом операция продолжала бы закрывать websocket-ы в фоне уже после
   * того, как владелец source получил управление и, возможно, поднял новое
   * поколение той же routing identity.
   *
   * Поэтому операция остаётся здесь до фактического settle и удаляется
   * ТОЛЬКО им — таймаут из набора ничего не убирает.
   */
  private readonly _pendingInstanceCloses = new Set<Promise<void>>();

  private _failureStopPromise: Promise<void> | null = null;
  /** Promise первого close() — повторные вызовы ждут его же. */
  private _closePromise: Promise<void> | null = null;

  /**
   * Создаёт source поверх инъецированных bus/metadata generator.
   *
   * @param deps - Зависимости (см. {@link CexSourceDependencies})
   * @throws {Error} При невалидной конфигурации (пустые symbols, ни одного
   *   потока, некорректная depth)
   */
  constructor(deps: CexSourceDependencies) {
    assertValidCexSourceConfig(deps.config);
    this._config = deps.config;
    this._bus = deps.bus;
    this._metadataGenerator = deps.metadataGenerator;
    this._logger = deps.logger.child({
      component: 'CexSource',
      exchange: deps.config.exchangeId,
      marketType: deps.config.marketType,
    });
    this._exchangeFactory = deps.exchangeFactory ?? createCcxtProExchange;
    this._random = deps.random ?? Math.random;

    this._symbols = [...deps.config.symbols];
    const requestedDepth = deps.config.orderbookDepth ?? DEFAULT_ORDERBOOK_DEPTH;
    this._effectiveDepth = normalizeOrderbookDepth(
      deps.config.exchangeId,
      deps.config.marketType,
      requestedDepth,
    );
    if (this._effectiveDepth !== requestedDepth) {
      this._logger.info('Normalized orderbook depth for exchange', {
        requested: requestedDepth,
        effective: this._effectiveDepth,
      });
    }

    this._obStaleTimeoutMs = deps.config.orderbookStaleTimeoutMs ?? DEFAULT_ORDERBOOK_STALE_TIMEOUT_MS;
    this._tradesStaleTimeoutMs = deps.config.tradesStaleTimeoutMs ?? DEFAULT_TRADES_STALE_TIMEOUT_MS;
    this._fetchPollIntervalMs = deps.config.fetchPollIntervalMs ?? DEFAULT_FETCH_POLL_INTERVAL_MS;
    this._closeTimeoutMs = deps.config.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this._restartIntervalMs = deps.config.restartIntervalMs ?? DEFAULT_RESTART_INTERVAL_MS;

    const backoff = {
      initialBackoffMs: deps.config.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS,
      maxBackoffMs: deps.config.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
    };
    this._obTask = deps.config.watchOrderbook
      ? new RestartingTask({
          name: `${deps.config.exchangeId}:orderbook`,
          run: (signal) => this._runObSession(signal),
          logger: this._logger.child({ stream: 'orderbook' }),
          random: this._random,
          ...backoff,
        })
      : null;
    this._tradesTask = deps.config.watchTrades
      ? new RestartingTask({
          name: `${deps.config.exchangeId}:trades`,
          run: (signal) => this._runTradesSession(signal),
          logger: this._logger.child({ stream: 'trades' }),
          random: this._random,
          ...backoff,
        })
      : null;
  }

  /** true после `close()` — source терминально остановлен. */
  public get isClosed(): boolean {
    return this._closed;
  }

  /**
   * true после терминального отказа pipeline: общий bus отклонил публикацию.
   * Оба потока остановлены, дальнейшие наблюдения не публикуются.
   */
  public get hasFailed(): boolean {
    return this._failed;
  }

  /** true, пока жив хотя бы один supervised transport-поток. */
  public get isRunning(): boolean {
    return (this._obTask?.isRunning() ?? false) || (this._tradesTask?.isRunning() ?? false);
  }

  /**
   * Возвращает снимок диагностических счётчиков source.
   *
   * @returns Текущие значения {@link CexSourceStats}
   */
  public getStats(): CexSourceStats {
    return {
      orderbookSnapshotFailures: this._orderbookSnapshotFailures,
      tradeSnapshotFailures: this._tradeSnapshotFailures,
    };
  }

  /**
   * Запускает transport-потоки source (идемпотентно).
   *
   * @throws {Error} Если source уже закрыт или в терминальном `failed`
   *
   * @remarks
   * Повторный вызов — no-op: вторые watcher-ы не создаются.
   */
  public start(): void {
    if (this._closed) {
      throw new Error('CexSource is closed and cannot start');
    }
    if (this._failed) {
      throw new Error('CexSource has failed and cannot start');
    }
    if (this._started) {
      this._logger.debug('CexSource already started');
      return;
    }
    this._started = true;
    this._obTask?.start();
    this._tradesTask?.start();
    this._logger.info('CexSource started', {
      symbols: this._symbols.length,
      orderbook: this._obTask !== null,
      trades: this._tradesTask !== null,
      depth: this._effectiveDepth,
    });
  }

  /**
   * Graceful shutdown: граница жизненного цикла владельца source.
   *
   * @returns Promise, разрешающийся когда все transport-циклы остановлены
   *   И все операции закрытия CCXT-инстансов ЗАВЕРШЕНЫ
   *
   * @remarks
   * ### Что именно гарантирует резолв
   *
   * ```text
   * await source.close()
   *   ⇒ ни один instance.close() этого source больше не выполняется в фоне
   * ```
   *
   * Это сильнее, чем «остановка запрошена». Session-level `closeTimeoutMs`
   * ограничивает лишь то, сколько cleanup ОДНОЙ сессии держит supervised
   * restart; истёкший таймаут оставляет vendor-закрытие работать дальше.
   * Владельцу source этого недостаточно: если он поднимет новое поколение
   * с той же routing identity (биржа + тип рынка + символ + поток), пока
   * старый транспорт ещё закрывается, два поколения окажутся живы
   * одновременно. Поэтому здесь ожидание ПОДТВЕРЖДЁННОЕ и, в отличие от
   * session cleanup, не ограничено таймаутом.
   *
   * Порядок: запретить новые сессии → аборт текущих → дождаться
   * `RestartingTask.stop()` (после него новых инстансов не появится) →
   * дождаться реестра незавершённых закрытий.
   *
   * Идемпотентен (повторные вызовы ждут первый). Общий bus НЕ закрывается —
   * им владеет composition root. Безопасен при гонке с плановым/аварийным
   * рестартом: `RestartingTask` не начинает новую сессию после `stop()`.
   */
  public async close(): Promise<void> {
    if (this._closePromise) {
      return this._closePromise;
    }
    this._closed = true;
    this._closePromise = (async () => {
      const stops: Promise<void>[] = [];
      if (this._obTask) stops.push(this._obTask.stop());
      if (this._tradesTask) stops.push(this._tradesTask.stop());
      if (this._failureStopPromise) stops.push(this._failureStopPromise);
      await Promise.all(stops);
      // Supervised-петли остановлены ⇒ новых CCXT-инстансов появиться уже
      // не может, и набор незавершённых закрытий больше не растёт. Только
      // теперь ожидание конечно.
      await this._awaitPendingInstanceCloses();
      this._logger.info('CexSource closed');
    })();
    return this._closePromise;
  }

  // ───────────────────────── Сессия стакана ─────────────────────────

  /**
   * Одна supervised-сессия потока стакана: владеет ровно одним
   * CCXT-инстансом.
   *
   * @param signal - Сигнал остановки сессии (abort закрывает инстанс,
   *   разблокируя pending watch)
   *
   * @remarks
   * Выбор метода: multiplex → per-symbol watch → REST fetch
   * (сконфигурированный `orderbookMethod: 'fetch'` пропускает WS-режимы).
   * Нормальный return = controlled restart (плановый перезапуск, crossed
   * book); исключение = restart с backoff.
   */
  private async _runObSession(signal: AbortSignal): Promise<void> {
    const instance = await this._makeInstance();
    let closeOnce: Promise<void> | null = null;
    const closeInstance = (): Promise<void> => {
      closeOnce ??= this._closeInstanceWithTimeout(instance);
      return closeOnce;
    };
    const closeOnAbort = (): void => {
      void closeInstance();
    };
    signal.addEventListener('abort', closeOnAbort, { once: true });

    // Selection ВНУТРИ try: capability-ошибка обязана закрыть инстанс
    // через тот же finally (иначе утечка инстанса + висящий abort-listener)
    try {
      const fetchConfigured = this._config.orderbookMethod === 'fetch';
      const canMultiplex =
        !fetchConfigured && this._isCapabilitySupported(instance, 'watchOrderBookForSymbols');
      const canWatchPerSymbol =
        !fetchConfigured && this._isCapabilitySupported(instance, 'watchOrderBook');
      const canFetch = this._isCapabilitySupported(instance, 'fetchOrderBook');

      // Fetch выбирается ТОЛЬКО при явной конфигурации либо как последний
      // fallback — в обоих случаях при ПОДТВЕРЖДЁННОЙ capability
      // (has-map, не наличие функции: base-класс CCXT определяет unified
      // методы всегда, неподдерживаемые бросают NotSupported).
      // Capability-несоответствие — перманентный отказ потока: рестарты
      // не изменят has-map exchange-класса
      let mode: 'multiplex' | 'watch-per-symbol' | 'fetch';
      if (canMultiplex) {
        mode = 'multiplex';
      } else if (canWatchPerSymbol) {
        mode = 'watch-per-symbol';
      } else if (fetchConfigured) {
        if (!canFetch) {
          throw new PermanentTaskError(
            `orderbookMethod 'fetch' is configured but fetchOrderBook is not supported ` +
              `by exchange '${this._config.exchangeId}' (has.fetchOrderBook=${String(
                instance.has?.['fetchOrderBook'],
              )})`,
          );
        }
        mode = 'fetch';
      } else if (canFetch) {
        mode = 'fetch';
        this._logger.warn(
          'Orderbook watch capabilities unavailable, downgrading to REST fetch polling',
          {
            pollIntervalMs: this._fetchPollIntervalMs,
          },
        );
      } else {
        throw new PermanentTaskError(
          `Exchange '${this._config.exchangeId}' supports none of ` +
            'watchOrderBookForSymbols/watchOrderBook/fetchOrderBook',
        );
      }

      this._logger.info('OB session starting', {
        method: mode,
        symbols: this._symbols.length,
        depth: this._effectiveDepth,
      });

      if (mode === 'multiplex') {
        await this._runObMultiplex(instance, signal);
      } else if (mode === 'watch-per-symbol') {
        await this._runObWatchPerSymbol(instance, signal);
      } else {
        await this._runObFetch(instance, signal);
      }
    } finally {
      signal.removeEventListener('abort', closeOnAbort);
      await closeInstance();
      this._logger.info('OB session stopped');
    }
  }

  private async _runObMultiplex(instance: CcxtProExchangeInstance, signal: AbortSignal): Promise<void> {
    const watch = instance.watchOrderBookForSymbols;
    if (typeof watch !== 'function') {
      throw new Error('watchOrderBookForSymbols is not available on the exchange instance');
    }
    const restartDeadline = this._plannedRestartDeadline();
    while (!signal.aborted) {
      if (Date.now() >= restartDeadline) {
        this._logger.info('Planned restart (OB multiplex)');
        return;
      }

      const rawOb = await this._withWatchTimeout(
        () => watch.call(instance, [...this._symbols], this._effectiveDepth),
        this._obStaleTimeoutMs,
        'OB multiplex stale: no update within timeout',
        signal,
      );

      if (signal.aborted) break;
      if (!rawOb) continue;
      const outcome = await this._emitOrderbook(rawOb, undefined, signal);
      if (outcome === 'restart') return;
      if (outcome === 'stop') return;
    }
  }

  /**
   * Fallback-режим стакана: НЕЗАВИСИМЫЕ параллельные петли по символам.
   *
   * @remarks
   * Петли не выстраиваются в очередь: «тихий» символ (ждущий свой
   * stale-таймаут) не блокирует эмиссию остальных. Отказ любой петли
   * завершает сессию целиком (supervised restart пересоздаёт инстанс для
   * всех символов — как в multiplex-режиме); у каждого watch-вызова свой
   * stale-дедлайн.
   */
  private async _runObWatchPerSymbol(
    instance: CcxtProExchangeInstance,
    signal: AbortSignal,
  ): Promise<void> {
    const watch = instance.watchOrderBook;
    if (typeof watch !== 'function') {
      throw new Error('watchOrderBook is not available on the exchange instance');
    }
    await this._runPerSymbolLoops(
      signal,
      'Planned restart (OB watch-per-symbol)',
      async (symbol, sessionSignal) => {
        const rawOb = await this._withWatchTimeout(
          () => watch.call(instance, symbol, this._effectiveDepth),
          this._obStaleTimeoutMs,
          `OB watch stale for ${symbol}`,
          sessionSignal,
        );
        if (sessionSignal.aborted) return 'exit';
        if (!rawOb) return 'continue';
        const outcome = await this._emitOrderbook(rawOb, symbol, sessionSignal);
        return outcome === 'continue' ? 'continue' : 'exit';
      },
    );
  }

  /**
   * Запускает независимые петли по всем символам и координирует их выход.
   *
   * @param parentSignal - Сигнал остановки сессии (RestartingTask)
   * @param plannedRestartMessage - Лог планового перезапуска
   * @param step - Одна итерация петли символа: watch → emit
   *
   * @remarks
   * Координация через session-local AbortController:
   * - плановый дедлайн/`exit`-исход любой петли завершают сессию штатно
   *   (controlled restart) — остальные петли будятся abort-ом;
   * - исключение петли (stale/транспорт) фиксируется как отказ сессии и
   *   пробрасывается ПОСЛЕ завершения всех петель (supervised backoff);
   *   поздние rejections остальных петель поглощаются как следствие
   *   останова, unhandled rejections исключены.
   */
  private async _runPerSymbolLoops(
    parentSignal: AbortSignal,
    plannedRestartMessage: string,
    step: (symbol: string, sessionSignal: AbortSignal) => Promise<'continue' | 'exit'>,
  ): Promise<void> {
    const restartDeadline = this._plannedRestartDeadline();
    const session = new AbortController();
    const onParentAbort = (): void => session.abort();
    if (parentSignal.aborted) {
      session.abort();
    } else {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }

    let failure: unknown = null;
    const loops = this._symbols.map(async (symbol) => {
      while (!session.signal.aborted) {
        if (Date.now() >= restartDeadline) {
          this._logger.info(plannedRestartMessage);
          session.abort();
          return;
        }
        let outcome: 'continue' | 'exit';
        try {
          outcome = await step(symbol, session.signal);
        } catch (error) {
          if (session.signal.aborted) {
            return; // сессию уже завершает другой участник — это следствие
          }
          failure ??= error;
          session.abort();
          return;
        }
        if (outcome === 'exit') {
          session.abort();
          return;
        }
      }
    });

    try {
      await Promise.all(loops);
    } finally {
      parentSignal.removeEventListener('abort', onParentAbort);
    }
    if (failure !== null && !parentSignal.aborted) {
      throw failure;
    }
  }

  private async _runObFetch(instance: CcxtProExchangeInstance, signal: AbortSignal): Promise<void> {
    const fetch = instance.fetchOrderBook;
    if (typeof fetch !== 'function') {
      throw new Error('fetchOrderBook is not available on the exchange instance');
    }
    const restartDeadline = this._plannedRestartDeadline();
    while (!signal.aborted) {
      if (Date.now() >= restartDeadline) {
        this._logger.info('Planned restart (OB fetch)');
        return;
      }

      for (const symbol of this._symbols) {
        if (signal.aborted) break;
        const rawOb = await this._withWatchTimeout(
          () => fetch.call(instance, symbol, this._effectiveDepth),
          this._obStaleTimeoutMs,
          `OB fetch stale for ${symbol}`,
          signal,
        );
        if (signal.aborted) break;
        if (!rawOb) continue;
        const outcome = await this._emitOrderbook(rawOb, symbol, signal);
        if (outcome === 'restart') return;
        if (outcome === 'stop') return;
      }

      if (!signal.aborted) {
        await this._sleep(this._fetchPollIntervalMs, signal);
      }
    }
  }

  /**
   * Эмитирует одно наблюдение стакана: health-проверки → снапшот →
   * canonical message → publish.
   *
   * @param rawOb - Живой vendor-объект стакана
   * @param symbolFallback - Символ подписки (per-symbol/fetch режимы);
   *   vendor-объект НЕ патчится, routing-символ уходит в typed payload
   * @param signal - Сигнал остановки сессии
   * @returns `'continue'` — цикл продолжается; `'restart'` — controlled
   *   restart сессии (crossed book); `'stop'` — сессия завершается
   *   (shutdown или терминальный отказ pipeline)
   */
  private async _emitOrderbook(
    rawOb: CcxtRawOrderBook,
    symbolFallback: string | undefined,
    signal: AbortSignal,
  ): Promise<EmitOutcome> {
    const symbol = rawOb.symbol ?? symbolFallback;
    if (!symbol) {
      this._logger.debug('Orderbook observation without symbol, skipping');
      return 'continue';
    }
    const bids = rawOb.bids;
    const asks = rawOb.asks;
    if (!bids?.length || !asks?.length) {
      return 'continue';
    }

    const bestBid = bids[0]?.[0];
    const bestAsk = asks[0]?.[0];
    if (typeof bestBid === 'number' && typeof bestAsk === 'number' && bestAsk < bestBid) {
      this._logger.warn('Hung orderbook detected (ask < bid), restarting stream', {
        symbol,
        bid: bestBid,
        ask: bestAsk,
      });
      return 'restart';
    }

    let message: CexOrderbookExternalMessage;
    try {
      message = {
        type: 'CEX_ORDERBOOK',
        payload: {
          exchangeId: this._config.exchangeId,
          marketType: this._config.marketType,
          symbol,
          orderBook: snapshotOrderBook(rawOb, this._effectiveDepth),
        },
        metadata: this._metadataGenerator.nextRoot(),
      };
    } catch (error) {
      this._orderbookSnapshotFailures++;
      this._logger.error('Failed to snapshot orderbook observation, skipping', {
        symbol,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'continue';
    }

    return this._publish(message, signal);
  }

  // ───────────────────────── Сессия сделок ─────────────────────────

  /**
   * Одна supervised-сессия потока сделок: владеет ровно одним
   * CCXT-инстансом.
   *
   * @param signal - Сигнал остановки сессии
   *
   * @remarks
   * `newUpdates: true` инстанса гарантирует, что каждый resolve отдаёт
   * ТОЛЬКО новые сделки — повторная публикация накопленного кэша
   * исключена официальным механизмом CCXT, ручная очистка кэша не
   * выполняется.
   */
  private async _runTradesSession(signal: AbortSignal): Promise<void> {
    const instance = await this._makeInstance();
    let closeOnce: Promise<void> | null = null;
    const closeInstance = (): Promise<void> => {
      closeOnce ??= this._closeInstanceWithTimeout(instance);
      return closeOnce;
    };
    const closeOnAbort = (): void => {
      void closeInstance();
    };
    signal.addEventListener('abort', closeOnAbort, { once: true });

    // Selection внутри try — см. пояснение в OB-сессии (закрытие инстанса)
    try {
      const canMultiplex = this._isCapabilitySupported(instance, 'watchTradesForSymbols');
      const canWatchPerSymbol = this._isCapabilitySupported(instance, 'watchTrades');
      if (!canMultiplex && !canWatchPerSymbol) {
        throw new PermanentTaskError(
          `Exchange '${this._config.exchangeId}' supports neither ` +
            'watchTradesForSymbols nor watchTrades',
        );
      }
      const mode: 'multiplex' | 'watch-per-symbol' = canMultiplex
        ? 'multiplex'
        : 'watch-per-symbol';

      this._logger.info('Trades session starting', {
        method: mode,
        symbols: this._symbols.length,
      });

      if (mode === 'multiplex') {
        await this._runTradesMultiplex(instance, signal);
      } else {
        await this._runTradesWatchPerSymbol(instance, signal);
      }
    } finally {
      signal.removeEventListener('abort', closeOnAbort);
      await closeInstance();
      this._logger.info('Trades session stopped');
    }
  }

  private async _runTradesMultiplex(
    instance: CcxtProExchangeInstance,
    signal: AbortSignal,
  ): Promise<void> {
    const watch = instance.watchTradesForSymbols;
    if (typeof watch !== 'function') {
      throw new Error('watchTradesForSymbols is not available on the exchange instance');
    }
    const restartDeadline = this._plannedRestartDeadline();
    while (!signal.aborted) {
      if (Date.now() >= restartDeadline) {
        this._logger.info('Planned restart (trades multiplex)');
        return;
      }

      const trades = await this._withWatchTimeout(
        () => watch.call(instance, [...this._symbols]),
        this._tradesStaleTimeoutMs,
        'Trades multiplex stale: no update within timeout',
        signal,
      );

      if (signal.aborted) break;
      if (!trades?.length) continue;
      const outcome = await this._emitTrades(trades, undefined, signal);
      if (outcome === 'stop') return;
    }
  }

  /**
   * Fallback-режим сделок: независимые параллельные петли по символам
   * (та же координация, что у стакана — см. `_runPerSymbolLoops`).
   */
  private async _runTradesWatchPerSymbol(
    instance: CcxtProExchangeInstance,
    signal: AbortSignal,
  ): Promise<void> {
    const watch = instance.watchTrades;
    if (typeof watch !== 'function') {
      throw new Error('watchTrades is not available on the exchange instance');
    }
    await this._runPerSymbolLoops(
      signal,
      'Planned restart (trades watch-per-symbol)',
      async (symbol, sessionSignal) => {
        const trades = await this._withWatchTimeout(
          () => watch.call(instance, symbol),
          this._tradesStaleTimeoutMs,
          `Trades watch stale for ${symbol}`,
          sessionSignal,
        );
        if (sessionSignal.aborted) return 'exit';
        if (!trades?.length) return 'continue';
        const outcome = await this._emitTrades(trades, symbol, sessionSignal);
        return outcome === 'stop' ? 'exit' : 'continue';
      },
    );
  }

  /**
   * Эмитирует batch сделок: одна сделка = одно root-сообщение.
   *
   * @param trades - Batch новых сделок из watch-вызова
   * @param symbolFallback - Символ подписки (per-symbol режим)
   * @param signal - Сигнал остановки сессии
   * @returns `'continue'` — batch обработан; `'stop'` — сессия завершается
   */
  private async _emitTrades(
    trades: readonly CcxtRawTrade[],
    symbolFallback: string | undefined,
    signal: AbortSignal,
  ): Promise<Exclude<EmitOutcome, 'restart'>> {
    for (const rawTrade of trades) {
      if (signal.aborted) return 'stop';
      const symbol = rawTrade?.symbol ?? symbolFallback;
      if (!symbol) {
        this._logger.debug('Trade observation without symbol, skipping');
        continue;
      }

      let message: CexTradeExternalMessage;
      try {
        message = {
          type: 'CEX_TRADE',
          payload: {
            exchangeId: this._config.exchangeId,
            marketType: this._config.marketType,
            symbol,
            trade: snapshotTrade(rawTrade),
          },
          metadata: this._metadataGenerator.nextRoot(),
        };
      } catch (error) {
        this._tradeSnapshotFailures++;
        this._logger.error('Failed to snapshot trade observation, skipping', {
          symbol,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const outcome = await this._publish(message, signal);
      if (outcome === 'stop') return 'stop';
    }
    return 'continue';
  }

  // ───────────────────── Публикация и отказ pipeline ─────────────────────

  /**
   * Публикует сообщение в общий bus, гоняясь с сигналом остановки сессии.
   *
   * @param message - Canonical CEX-сообщение
   * @param signal - Сигнал остановки сессии
   * @returns `'continue'` — опубликовано; `'stop'` — сессия должна
   *   завершиться (abort во время publish или терминальный отказ pipeline)
   *
   * @remarks
   * Гонка с abort обязательна: `publish` движка может стать drain-owner-ом
   * и ждать обработчиков, а обработчик имеет право await-ить `close()`
   * этого source — без гонки образовался бы deadlock
   * handler → close → session → publish → handler. Сообщение, чей publish
   * прерван сигналом, уже находится в очереди движка; его Result
   * дологируется асинхронно.
   */
  private async _publish(message: CexExternalMessage, signal: AbortSignal): Promise<EmitOutcome> {
    if (signal.aborted) return 'stop';

    const publishPromise = this._bus.publish(message);
    let abortHandler: (() => void) | null = null;
    const aborted = new Promise<typeof PUBLISH_ABORTED>((resolve) => {
      abortHandler = () => resolve(PUBLISH_ABORTED);
      signal.addEventListener('abort', abortHandler, { once: true });
    });

    let outcome: Result<void, MessageBusPublishError> | typeof PUBLISH_ABORTED;
    try {
      outcome = await Promise.race([publishPromise, aborted]);
    } finally {
      if (abortHandler) signal.removeEventListener('abort', abortHandler);
    }

    if (outcome === PUBLISH_ABORTED) {
      void publishPromise.then(
        (result) => {
          if (!result.ok) {
            this._logger.debug('Publication settled with rejection after session abort', {
              messageType: message.type,
              error: result.error.message,
            });
          }
        },
        () => undefined,
      );
      return 'stop';
    }

    if (!outcome.ok) {
      this._failPipeline(message.type, outcome.error);
      return 'stop';
    }
    return 'continue';
  }

  /**
   * Терминальный отказ pipeline: общий bus отклонил публикацию.
   *
   * @param messageType - Тип отклонённого сообщения (для лога)
   * @param error - Ошибка движка доставки
   *
   * @remarks
   * Идемпотентен. Останавливает ОБА потока (`RestartingTask.stop()`
   * синхронно помечает остановку и абортит текущие сессии — сессия,
   * вызвавшая отказ, завершается сама и не await-ит собственную петлю,
   * поэтому deadlock исключён). Retry поверх отклонённого publish
   * сознательно отсутствует: отказ canonical bus (closed/overflow) — отказ
   * контура доставки, а не транзиентная сетевая ошибка.
   */
  private _failPipeline(messageType: string, error: MessageBusPublishError): void {
    if (this._failed) return;
    this._failed = true;
    this._logger.error('External message bus rejected publication, failing CEX source', {
      messageType,
      error: error.message,
    });
    const stops: Promise<void>[] = [];
    if (this._obTask) stops.push(this._obTask.stop());
    if (this._tradesTask) stops.push(this._tradesTask.stop());
    this._failureStopPromise = Promise.all(stops).then(() => {
      this._logger.error('CexSource stopped after pipeline failure');
    });
  }

  // ───────────────────────── Транспортные утилиты ─────────────────────────

  /**
   * Проверяет unified-capability CCXT: метод существует И объявлен в
   * `has`-map биржи.
   *
   * @param instance - CCXT-инстанс
   * @param method - Имя unified-метода
   * @returns true, если capability подтверждена биржей
   *
   * @remarks
   * Одного `typeof === 'function'` НЕДОСТАТОЧНО: base-класс CCXT определяет
   * unified-методы всегда, неподдерживаемые бросают `NotSupported` при
   * вызове — источником истины является `has`-map. Значение `'emulated'`
   * (реконструированная библиотекой capability) считается поддержкой:
   * `Boolean('emulated') === true`, это согласуется с трактовкой
   * has-значений самим CCXT.
   */
  private _isCapabilitySupported(
    instance: CcxtProExchangeInstance,
    method:
      | 'watchOrderBookForSymbols'
      | 'watchOrderBook'
      | 'fetchOrderBook'
      | 'watchTradesForSymbols'
      | 'watchTrades',
  ): boolean {
    return typeof instance[method] === 'function' && Boolean(instance.has?.[method]);
  }

  private async _makeInstance(): Promise<CcxtProExchangeInstance> {
    const instance = await this._exchangeFactory({
      exchangeId: this._config.exchangeId,
      marketType: this._config.marketType,
      depth: this._effectiveDepth,
    });
    this._logger.debug('CCXT Pro instance created');
    return instance;
  }

  /** Вычисляет дедлайн планового перезапуска текущей сессии (с jitter). */
  private _plannedRestartDeadline(): number {
    const base = this._restartIntervalMs;
    if (base <= 0) return Number.POSITIVE_INFINITY;
    const jitterRange = base * PLANNED_RESTART_JITTER_RATIO;
    const jitter = ((this._random() * 2) - 1) * jitterRange;
    return Date.now() + Math.max(1, Math.round(base + jitter));
  }

  /**
   * Ограничивает ОЖИДАНИЕ закрытия CCXT-инстанса внутри session cleanup.
   *
   * @param instance - Инстанс закрываемой сессии
   *
   * @remarks
   * Таймаут здесь ограничивает ровно одно: сколько session cleanup держит
   * supervised restart. Он НЕ означает, что транспорт закрыт, — истёкший
   * таймаут оставляет операцию выполняться дальше, и она остаётся
   * зарегистрированной в {@link CexSource._pendingInstanceCloses}, пока не
   * завершится по-настоящему. Подтверждённого teardown дожидается
   * {@link CexSource.close} — граница жизненного цикла владельца source.
   *
   * Прежняя версия после таймаута теряла операцию из виду, и `close()`
   * возвращал управление, пока `instance.close()` ещё выполнялся: владелец
   * (например, контроллер подписок) мог поднять новое поколение той же
   * routing identity поверх ещё живого транспорта старого.
   */
  private async _closeInstanceWithTimeout(instance: CcxtProExchangeInstance): Promise<void> {
    const closeOperation = this._trackInstanceClose(instance);

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this._closeTimeoutMs);
      timer.unref?.();
    });

    const result = await Promise.race([closeOperation.then(() => 'closed' as const), timeout]);
    if (timer) clearTimeout(timer);

    if (result === 'timeout') {
      this._logger.warn('Timed out waiting for CCXT instance close (teardown continues)', {
        timeoutMs: this._closeTimeoutMs,
        pendingCloses: this._pendingInstanceCloses.size,
      });
    }
  }

  /**
   * Регистрирует операцию закрытия инстанса в реестре незавершённых.
   *
   * @param instance - Инстанс закрываемой сессии
   * @returns Промис операции: не отклоняется, settle = teardown завершён
   *
   * @remarks
   * Наблюдает УЖЕ создаваемую операцию, второй `instance.close()` не
   * порождает: единственность закрытия обеспечивает once-guard сессии
   * (`closeOnce ??=`), а этот метод вызывается ровно из неё.
   *
   * Отказ vendor-закрытия ожидаем при рестарте и гасится здесь же — и
   * ради отсутствия unhandled rejection, и потому что предмет реестра не
   * успешность закрытия, а факт «асинхронный teardown больше не идёт».
   */
  private _trackInstanceClose(instance: CcxtProExchangeInstance): Promise<void> {
    const operation = this._closeInstanceOnce(instance).catch((err: unknown) => {
      this._logger.debug('Error closing CCXT instance (expected on restart)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    // Удаляет себя только по фактическому settle. Ссылка на `tracked`
    // внутри собственного обработчика безопасна: он выполняется строго
    // после присваивания.
    const tracked: Promise<void> = operation.finally(() => {
      this._pendingInstanceCloses.delete(tracked);
    });
    this._pendingInstanceCloses.add(tracked);
    return tracked;
  }

  /**
   * Дожидается завершения ВСЕХ незавершённых закрытий инстансов.
   *
   * @returns Промис, разрешающийся при пустом реестре
   *
   * @remarks
   * Цикл, а не один снимок: вызывается после остановки supervised-петель,
   * когда новых инстансов появиться уже не может, но защита от пополнения
   * набора между снимком и его ожиданием стоит одной строки, а её
   * отсутствие стоило бы ровно того же тихого фонового teardown, ради
   * которого весь реестр и заведён.
   */
  private async _awaitPendingInstanceCloses(): Promise<void> {
    while (this._pendingInstanceCloses.size > 0) {
      await Promise.all([...this._pendingInstanceCloses]);
    }
  }

  private async _closeInstanceOnce(instance: CcxtProExchangeInstance): Promise<void> {
    const clients = instance.clients;
    if (clients) {
      for (const clientKey of Object.keys(clients)) {
        const client = clients[clientKey];
        try {
          if (client?.close) {
            await client.close();
          } else if (client?.connection?.close) {
            await client.connection.close();
          }
        } catch {
          // Закрытие отдельного WS-клиента best-effort: ошибки не мешают
          // закрыть остальные и сам инстанс
        }
      }
    }
    if (instance.close) {
      await instance.close();
    }
  }

  /**
   * Оборачивает watch/fetch-вызов в гонку со stale-таймаутом и abort.
   *
   * @param operationFactory - Фабрика vendor-вызова
   * @param timeoutMs - Stale-таймаут
   * @param timeoutMessage - Текст ошибки stale
   * @param signal - Сигнал остановки сессии
   * @returns Результат vendor-вызова
   * @throws {Error} При stale-таймауте или abort (поздний reject
   *   vendor-промиса подавляется — unhandled rejection исключён)
   */
  private async _withWatchTimeout<T>(
    operationFactory: () => Promise<T>,
    timeoutMs: number,
    timeoutMessage: string,
    signal: AbortSignal,
  ): Promise<T> {
    if (signal.aborted) {
      throw new Error(`${timeoutMessage}: aborted`);
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    let abortHandler: (() => void) | null = null;

    const operation = Promise.resolve().then(operationFactory);
    operation.catch(() => undefined);

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      timer.unref?.();
    });

    const aborted = new Promise<never>((_, reject) => {
      abortHandler = () => reject(new Error(`${timeoutMessage}: aborted`));
      signal.addEventListener('abort', abortHandler, { once: true });
    });

    try {
      return await Promise.race([operation, timeout, aborted]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abortHandler) signal.removeEventListener('abort', abortHandler);
    }
  }

  /** Abort-aware пауза REST-опроса. */
  private async _sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0 || signal.aborted) return;
    await new Promise<void>((resolve) => {
      let resolved = false;
      const finish = (): void => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer: ReturnType<typeof setTimeout> = setTimeout(finish, ms);
      timer.unref?.();
      signal.addEventListener('abort', finish, { once: true });
    });
  }
}
