import type { ILogger } from '@polymarket/logger';
import type { CexRawRecord } from './CexTypes.js';
import { RestartingTask } from './RestartingTask.js';

let ccxtModule: typeof import('ccxt') | null = null;

async function getCcxt(): Promise<typeof import('ccxt')> {
  if (!ccxtModule) {
    ccxtModule = await import('ccxt');
  }
  return ccxtModule;
}

const OB_STALE_TIMEOUT_MS = 30_000;
const TRADES_STALE_TIMEOUT_MS = 120_000;
const CLOSE_TIMEOUT_MS = 10_000;
const PLANNED_RESTART_JITTER_RATIO = 0.1;

type CcxtExchangeInstance = any;

/**
 * Параметры инициализации `CcxtSymbolWatcher`.
 */
export interface CcxtSymbolWatcherParams {
  /** Идентификатор биржи в ccxt.pro (напр. "binance"). */
  readonly exchangeId: string;
  /** Тип рынка: spot, futures или swap. */
  readonly exchangeType: 'spot' | 'futures' | 'swap';
  /** Символ торговой пары (напр. "BTC/USD"). */
  readonly symbol: string;
  /** Глубина стакана (кол-во уровней). */
  readonly depth: number;
  /** Подписываться на обновления стакана. */
  readonly watchOrderbook: boolean;
  /** Подписываться на поток сделок. */
  readonly watchTrades: boolean;
  /** Интервал планового перезапуска соединения (ms). */
  readonly restartIntervalMs: number;
  /**
   * Метод получения стакана: `watch` (WebSocket) или `fetch` (REST).
   * Если не задан — автоопределение по ccxt.pro capabilities.
   */
  readonly obMethod?: 'watch' | 'fetch';
  /** Callback при получении новой записи (стакан или сделка). */
  readonly onRecord: (record: CexRawRecord) => void;
  readonly logger: ILogger;
  /** @internal Test hook for injecting a fake ccxt.pro exchange instance. */
  readonly exchangeFactory?: () => CcxtExchangeInstance | Promise<CcxtExchangeInstance>;
  /** @internal Test hook for deterministic jitter. */
  readonly random?: () => number;
}

/**
 * Наблюдатель за рыночными данными одного символа на одной бирже.
 *
 * @remarks
 * Запускает отдельные асинхронные петли для стакана и сделок.
 * Каждая петля:
 * 1. Создаёт ccxt.pro-инстанс.
 * 2. Подписывается на WebSocket (или делает REST-polling для стакана).
 * 3. При ошибке — логирует, пересоздаёт инстанс и продолжает.
 * 4. При плановом `restartIntervalMs` — перезапускает инстанс без паузы.
 * 5. Обнаруживает «зависший» стакан (ask < bid) и перезапускается.
 *
 * ### Защита от staleness
 * Каждая операция watch обёрнута в `Promise.race` со stale-таймаутом:
 * 30s для стакана и 120s для сделок. Если обновлений не поступало вовремя,
 * инстанс пересоздаётся.
 *
 * @example
 * ```typescript
 * const watcher = new CcxtSymbolWatcher({
 *   exchangeId: 'binance',
 *   exchangeType: 'futures',
 *   symbol: 'BTC/USD',
 *   depth: 10,
 *   watchOrderbook: true,
 *   watchTrades: true,
 *   restartIntervalMs: 2 * 60 * 60 * 1000,
 *   onRecord: (record) => handleRecord(record),
 *   logger,
 * });
 * watcher.start();
 * // ...
 * watcher.stop();
 * ```
 */
export class CcxtSymbolWatcher {
  private readonly _logger: ILogger;
  private readonly _obTask: RestartingTask | null;
  private readonly _tradesTask: RestartingTask | null;
  private readonly _closePromises = new WeakMap<object, Promise<void>>();
  private _started = false;

  /**
   * @param _params - Параметры наблюдателя
   */
  constructor(private readonly _params: CcxtSymbolWatcherParams) {
    this._logger = _params.logger.child({
      component: 'CcxtSymbolWatcher',
      exchange: _params.exchangeId,
      symbol: _params.symbol,
    });
    this._obTask = _params.watchOrderbook
      ? new RestartingTask({
          name: `${_params.exchangeId}:${_params.symbol}:orderbook`,
          run: (signal) => this._runObSession(signal),
          logger: this._logger.child({ stream: 'orderbook' }),
        })
      : null;
    this._tradesTask = _params.watchTrades
      ? new RestartingTask({
          name: `${_params.exchangeId}:${_params.symbol}:trades`,
          run: (signal) => this._runTradesSession(signal),
          logger: this._logger.child({ stream: 'trades' }),
        })
      : null;
  }

  /**
   * Запускает supervised-петли наблюдения (стакан и/или сделки).
   *
   * @remarks
   * Метод синхронный, петли работают в фоне. Повторный start() не создаёт
   * дублирующие фоновые задачи.
   */
  public start(): void {
    if (this._started) {
      this._logger.debug('Watcher already started');
      return;
    }

    this._started = true;
    this._obTask?.start();
    this._tradesTask?.start();
    this._logger.info('Watcher started');
  }

  /**
   * Останавливает supervised-петли наблюдения.
   *
   * @remarks
   * Запрашивает остановку активных session и ждёт завершения bounded close.
   */
  public async stop(): Promise<void> {
    if (!this._started) return;
    this._started = false;
    this._logger.info('Watcher stop requested');
    const stops: Promise<void>[] = [];
    if (this._obTask) stops.push(this._obTask.stop());
    if (this._tradesTask) stops.push(this._tradesTask.stop());
    await Promise.all(stops);
    this._logger.info('Watcher stopped');
  }

  /**
   * Асинхронная session чтения стакана ордеров.
   *
   * @remarks
   * Владеет ровно одним ccxt instance. Возврат без ошибки означает
   * controlled restart, например плановый restart или hung orderbook.
   * Записи передаются в `_params.onRecord` как `CexOrderbookRecord`.
   */
  private async _runObSession(signal: AbortSignal): Promise<void> {
    const instance = await this._makeInstance();
    const closeOnAbort = (): void => {
      void this._closeInstance(instance);
    };
    signal.addEventListener('abort', closeOnAbort, { once: true });

    try {
      const useWatch = this._params.obMethod === 'fetch'
        ? false
        : (this._params.obMethod === 'watch' || !!instance.has?.['watchOrderBook']);

      this._logger.info('OB session starting', {
        method: useWatch ? 'watchOrderBook' : 'fetchOrderBook',
        exchange: this._params.exchangeId,
      });

      while (!signal.aborted) {
        if (this._isPlannedRestartDue(instance)) {
          this._logger.info('Planned restart (restartInterval exceeded)', {
            intervalMs: instance._restartIntervalMs,
            baseIntervalMs: this._params.restartIntervalMs,
          });
          return;
        }

        const ob = useWatch
          ? await this._withWatchTimeout<any>(
              () => instance.watchOrderBook(this._params.symbol, this._params.depth),
              OB_STALE_TIMEOUT_MS,
              'OB stale: no update in 30s',
              signal,
            )
          : await this._withWatchTimeout<any>(
              () => instance.fetchOrderBook(this._params.symbol, this._params.depth),
              OB_STALE_TIMEOUT_MS,
              'OB fetch stale: no response in 30s',
              signal,
            );

        if (signal.aborted) break;

        if (!ob.bids.length || !ob.asks.length) continue;

        if (ob.asks[0][0] < ob.bids[0][0]) {
          this._logger.warn('Hung orderbook detected (ask < bid), restarting', {
            bid: ob.bids[0][0],
            ask: ob.asks[0][0],
          });
          return;
        }

        this._params.onRecord({
          t: 'ob',
          ts: ob.timestamp ?? Date.now(),
          bids: ob.bids.slice(0, this._params.depth),
          asks: ob.asks.slice(0, this._params.depth),
        });

        // Очищаем trades-кеш OB-инстанса (ccxt.pro накапливает trades даже в OB-петле).
        // orderbooks[symbol] НЕ трогаем — ccxt.pro использует его для дельт.
        this._clearTradesCache(instance);
      }
    } finally {
      signal.removeEventListener('abort', closeOnAbort);
      await this._closeInstance(instance);
      this._logger.info('OB session stopped');
    }
  }

  /**
   * Асинхронная session чтения потока сделок.
   *
   * @remarks
   * Владеет ровно одним ccxt instance. Ошибки выходят наружу в supervisor,
   * который перезапускает только эту session.
   * Каждая сделка передаётся в `_params.onRecord` как `CexTradeRecord`.
   */
  private async _runTradesSession(signal: AbortSignal): Promise<void> {
    const instance = await this._makeInstance();
    const closeOnAbort = (): void => {
      void this._closeInstance(instance);
    };
    signal.addEventListener('abort', closeOnAbort, { once: true });

    try {
      this._logger.info('Trades session starting');

      while (!signal.aborted) {
        if (this._isPlannedRestartDue(instance)) {
          this._logger.info('Planned restart (restartInterval exceeded), trades loop', {
            intervalMs: instance._restartIntervalMs,
            baseIntervalMs: this._params.restartIntervalMs,
          });
          return;
        }

        const trades = await this._withWatchTimeout<any[]>(
          () => instance.watchTrades(this._params.symbol),
          TRADES_STALE_TIMEOUT_MS,
          'Trades stale: no update in 120s',
          signal,
        );

        if (signal.aborted) break;

        for (const trade of trades) {
          this._params.onRecord({
            t: 'trade',
            ts: trade.timestamp ?? Date.now(),
            p: trade.price,
            sz: trade.amount,
            side: trade.side,
          });
        }

        // После записи на диск очищаем внутренний буфер ccxt.pro.
        // instance.trades[symbol] — это ArrayCache (extends Array), поэтому
        // обнуляем через .length = 0 (не заменяем ссылку, иначе .append сломается).
        this._clearTradesCache(instance);
      }
    } finally {
      signal.removeEventListener('abort', closeOnAbort);
      await this._closeInstance(instance);
      this._logger.info('Trades session stopped');
    }
  }

  /**
   * Создаёт новый ccxt.pro инстанс для биржи.
   *
   * @remarks
   * Добавляет `_createdAt` timestamp для отслеживания времени жизни инстанса.
   * Инстанс использует `defaultType` из `_params.exchangeType`.
   *
   * @returns Инстанс ccxt.pro биржи
   * @throws {Error} Если биржа не найдена в ccxt.pro
   */
  private async _makeInstance(): Promise<CcxtExchangeInstance> {
    if (this._params.exchangeFactory) {
      const instance = await this._params.exchangeFactory();
      this._initializeInstanceLifecycle(instance);
      this._logger.debug('ccxt.pro instance created from injected factory');
      return instance;
    }

    const { default: ccxt } = await getCcxt();
    const pro = (ccxt as any).pro as Record<string, new (opts: object) => any>;
    const ExchangeClass = pro[this._params.exchangeId];
    if (!ExchangeClass) {
      throw new Error(`Exchange '${this._params.exchangeId}' not found in ccxt.pro`);
    }

    const instance = new ExchangeClass({
      enableRateLimit: true,
      options: {
        defaultType: this._params.exchangeType,
        timeout: 30_000,
        watchOrderBook: { checksum: false, limit: this._params.depth },
      },
    });

    this._initializeInstanceLifecycle(instance);
    this._logger.debug('ccxt.pro instance created');
    return instance;
  }

  private _initializeInstanceLifecycle(instance: CcxtExchangeInstance): void {
    const createdAt = Date.now();
    const restartIntervalMs = this._jitterRestartIntervalMs(this._params.restartIntervalMs);

    instance._createdAt = createdAt;
    instance._restartIntervalMs = restartIntervalMs;
    instance._plannedRestartAt = createdAt + restartIntervalMs;
  }

  private _isPlannedRestartDue(instance: CcxtExchangeInstance): boolean {
    if (typeof instance?._plannedRestartAt === 'number') {
      return Date.now() >= instance._plannedRestartAt;
    }

    return Date.now() - instance._createdAt > this._params.restartIntervalMs;
  }

  private _jitterRestartIntervalMs(baseIntervalMs: number): number {
    if (baseIntervalMs <= 0) return baseIntervalMs;

    const random = this._params.random ?? Math.random;
    const jitterRange = baseIntervalMs * PLANNED_RESTART_JITTER_RATIO;
    const jitter = ((random() * 2) - 1) * jitterRange;
    return Math.max(1, Math.round(baseIntervalMs + jitter));
  }

  /**
   * Закрывает ccxt.pro инстанс, закрывая все WebSocket-клиенты.
   *
   * @remarks
   * Ошибки закрытия логируются как debug (ожидаемы при перезапуске).
   *
   * @param instance - ccxt.pro инстанс для закрытия
   */
  private async _closeInstance(instance: CcxtExchangeInstance): Promise<void> {
    if (!instance) return;

    if (typeof instance === 'object' || typeof instance === 'function') {
      const existing = this._closePromises.get(instance);
      if (existing) {
        await existing;
        return;
      }

      const closePromise = this._closeInstanceWithTimeout(instance)
        .finally(() => this._clearClosedInstanceState(instance));
      this._closePromises.set(instance, closePromise);
      await closePromise;
      return;
    }

    await this._closeInstanceWithTimeout(instance);
  }

  private async _closeInstanceWithTimeout(instance: CcxtExchangeInstance): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const closeOperation = this._closeInstanceOnce(instance).catch((err) => {
      this._logger.debug('Error closing ccxt instance (expected on restart)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), CLOSE_TIMEOUT_MS);
      timer.unref?.();
    });

    const result = await Promise.race([
      closeOperation.then(() => 'closed' as const),
      timeout,
    ]);

    if (timer) clearTimeout(timer);

    if (result === 'timeout') {
      this._logger.warn('Timed out closing ccxt instance', {
        timeoutMs: CLOSE_TIMEOUT_MS,
      });
      closeOperation.catch(() => undefined);
    }
  }

  private async _closeInstanceOnce(instance: CcxtExchangeInstance): Promise<void> {
    try {
      if (instance?.clients) {
        for (const clientKey of Object.keys(instance.clients)) {
          const client = instance.clients[clientKey];
          try {
            if (client?.close) {
              await client.close();
            } else if (client?.connection?.close) {
              await client.connection.close();
            }
          } catch {
            // ignore individual client close errors
          }
        }
      }
      if (instance?.close) {
        await instance.close();
      }
    } catch (err) {
      throw err;
    }
  }

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

  private _clearTradesCache(instance: CcxtExchangeInstance): void {
    const tradesCache = instance.trades?.[this._params.symbol];
    if (tradesCache && typeof tradesCache.length === 'number') {
      tradesCache.length = 0;
    }
  }

  private _clearClosedInstanceState(instance: CcxtExchangeInstance): void {
    for (const prop of ['trades', 'orderbooks', 'myTrades', 'orders']) {
      this._clearCacheObject(instance?.[prop]);
    }
  }

  private _clearCacheObject(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.length = 0;
      return;
    }

    for (const key of Object.keys(value as Record<string, unknown>)) {
      delete (value as Record<string, unknown>)[key];
    }
  }
}
