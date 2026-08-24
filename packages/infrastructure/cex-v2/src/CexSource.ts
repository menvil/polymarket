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
import { RestartingTask } from './RestartingTask.js';
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
  /** Promise остановки потоков, начатой терминальным отказом pipeline. */
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
   * Graceful shutdown: абортит оба потока и дожидается их завершения.
   *
   * @returns Promise, разрешающийся когда все transport-циклы остановлены
   *   и CCXT-инстансы закрыты
   *
   * @remarks
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

    const useFetch = this._config.orderbookMethod === 'fetch';
    const canMultiplex =
      !useFetch &&
      typeof instance.watchOrderBookForSymbols === 'function' &&
      !!instance.has?.['watchOrderBookForSymbols'];
    const canWatchPerSymbol =
      !useFetch && typeof instance.watchOrderBook === 'function' && !!instance.has?.['watchOrderBook'];

    const mode: 'multiplex' | 'watch-per-symbol' | 'fetch' = canMultiplex
      ? 'multiplex'
      : canWatchPerSymbol
        ? 'watch-per-symbol'
        : 'fetch';

    try {
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

  private async _runObWatchPerSymbol(
    instance: CcxtProExchangeInstance,
    signal: AbortSignal,
  ): Promise<void> {
    const watch = instance.watchOrderBook;
    if (typeof watch !== 'function') {
      throw new Error('watchOrderBook is not available on the exchange instance');
    }
    const restartDeadline = this._plannedRestartDeadline();
    while (!signal.aborted) {
      if (Date.now() >= restartDeadline) {
        this._logger.info('Planned restart (OB watch-per-symbol)');
        return;
      }

      for (const symbol of this._symbols) {
        if (signal.aborted) break;
        const rawOb = await this._withWatchTimeout(
          () => watch.call(instance, symbol, this._effectiveDepth),
          this._obStaleTimeoutMs,
          `OB watch stale for ${symbol}`,
          signal,
        );
        if (signal.aborted) break;
        if (!rawOb) continue;
        const outcome = await this._emitOrderbook(rawOb, symbol, signal);
        if (outcome === 'restart') return;
        if (outcome === 'stop') return;
      }
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

    const canMultiplex =
      typeof instance.watchTradesForSymbols === 'function' &&
      !!instance.has?.['watchTradesForSymbols'];
    const mode: 'multiplex' | 'watch-per-symbol' = canMultiplex ? 'multiplex' : 'watch-per-symbol';

    try {
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

  private async _runTradesWatchPerSymbol(
    instance: CcxtProExchangeInstance,
    signal: AbortSignal,
  ): Promise<void> {
    const watch = instance.watchTrades;
    if (typeof watch !== 'function') {
      throw new Error('watchTrades is not available on the exchange instance');
    }
    const restartDeadline = this._plannedRestartDeadline();
    while (!signal.aborted) {
      if (Date.now() >= restartDeadline) {
        this._logger.info('Planned restart (trades watch-per-symbol)');
        return;
      }

      for (const symbol of this._symbols) {
        if (signal.aborted) break;
        const trades = await this._withWatchTimeout(
          () => watch.call(instance, symbol),
          this._tradesStaleTimeoutMs,
          `Trades watch stale for ${symbol}`,
          signal,
        );
        if (signal.aborted) break;
        if (!trades?.length) continue;
        const outcome = await this._emitTrades(trades, symbol, signal);
        if (outcome === 'stop') return;
      }
    }
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
   * Закрывает CCXT-инстанс с таймаутом: сперва WS-клиенты, затем сам
   * инстанс; ошибки закрытия — debug (ожидаемы при рестарте).
   */
  private async _closeInstanceWithTimeout(instance: CcxtProExchangeInstance): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const closeOperation = this._closeInstanceOnce(instance).catch((err) => {
      this._logger.debug('Error closing CCXT instance (expected on restart)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this._closeTimeoutMs);
      timer.unref?.();
    });

    const result = await Promise.race([closeOperation.then(() => 'closed' as const), timeout]);
    if (timer) clearTimeout(timer);

    if (result === 'timeout') {
      this._logger.warn('Timed out closing CCXT instance', { timeoutMs: this._closeTimeoutMs });
      closeOperation.catch(() => undefined);
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
