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

const OB_STALE_TIMEOUT_MS = 60_000;
const TRADES_STALE_TIMEOUT_MS = 180_000;
const CLOSE_TIMEOUT_MS = 10_000;
const PLANNED_RESTART_JITTER_RATIO = 0.1;
const FETCH_POLL_INTERVAL_MS = 500;

type CcxtExchangeInstance = any;

/**
 * Whitelist допустимых значений `depth` для спотового стакана по биржам.
 *
 * @remarks
 * Некоторые биржи принимают только фиксированные значения глубины и падают
 * на валидации при других. Для них приводим запрошенное значение к ближайшему
 * допустимому (не меньше). Например, bybit spot принимает `[1, 50, 200, 1000]`,
 * поэтому `depth=10` транслируется в `50`.
 */
const SPOT_DEPTH_WHITELIST: Readonly<Record<string, readonly number[]>> = {
  bybit: [1, 50, 200, 1000],
  coinbase: [50],
};

function normalizeDepth(exchangeId: string, marketType: string, depth: number): number {
  if (marketType !== 'spot') return depth;
  const allowed = SPOT_DEPTH_WHITELIST[exchangeId];
  if (!allowed) return depth;
  for (const candidate of allowed) {
    if (candidate >= depth) return candidate;
  }
  return allowed[allowed.length - 1]!;
}

/**
 * Параметры инициализации `CcxtExchangeWatcher`.
 */
export interface CcxtExchangeWatcherParams {
  /** Идентификатор биржи в ccxt.pro. */
  readonly exchangeId: string;
  /** Тип рынка. */
  readonly exchangeType: 'spot' | 'futures' | 'swap';
  /** Список символов для мультиплексной подписки. */
  readonly symbols: readonly string[];
  /** Запрошенная глубина стакана (реальная может быть скорректирована по whitelist). */
  readonly depth: number;
  /** Подписываться на обновления стакана. */
  readonly watchOrderbook: boolean;
  /** Подписываться на поток сделок. */
  readonly watchTrades: boolean;
  /** Интервал планового перезапуска (ms). */
  readonly restartIntervalMs: number;
  /** Метод получения стакана. Default: автоопределение. */
  readonly obMethod?: 'watch' | 'fetch';
  /** Callback при получении новой записи. */
  readonly onRecord: (symbol: string, record: CexRawRecord) => void;
  readonly logger: ILogger;
  /** @internal Test hook. */
  readonly exchangeFactory?: () => CcxtExchangeInstance | Promise<CcxtExchangeInstance>;
  /** @internal Test hook. */
  readonly random?: () => number;
}

/**
 * Мультиплексный наблюдатель рыночных данных одной биржи.
 *
 * @remarks
 * В отличие от `CcxtSymbolWatcher`, держит **один ccxt.pro instance на каждый поток**
 * (стакан и/или сделки) для ВСЕХ символов биржи. Использует
 * `watchOrderBookForSymbols` / `watchTradesForSymbols` (или per-symbol fetch/watch
 * с шарингом соединения в fallback режиме). Это:
 *
 * - устраняет rate-limit ошибки 50011 у OKX/Bybit на холодном старте
 *   (одно соединение вместо 2N);
 * - уменьшает blast radius плановых рестартов — вместо 2N реконнектов
 *   выполняется 2;
 * - не увеличивает «stop-the-world» при сбое сети: реконнект соединения всё
 *   равно был бы синхронным для всех N символов.
 *
 * ### Жизненный цикл двух стримов
 * Потоки `orderbook` и `trades` независимы (разные ccxt instance, разные
 * `RestartingTask`): сбой одного не валит другой.
 *
 * ### Per-symbol ошибки
 * Ошибка подписки на конкретный символ (некорректный symbol, несовместимый
 * depth и т.п.) бросается в loop и приводит к рестарту сессии. Если такая
 * ошибка воспроизводится постоянно, `RestartingTask` уйдёт в cooldown —
 * плохой символ стоит убрать из конфига.
 *
 * ### Stale-защита
 * Каждый вызов watch обёрнут в `Promise.race` со stale-таймаутом (60s/180s).
 * Для `obMethod: 'fetch'` применяется меньший таймаут между REST-опросами.
 */
export class CcxtExchangeWatcher {
  private readonly _logger: ILogger;
  private readonly _symbols: readonly string[];
  private readonly _effectiveDepth: number;
  private readonly _obTask: RestartingTask | null;
  private readonly _tradesTask: RestartingTask | null;
  private readonly _closePromises = new WeakMap<object, Promise<void>>();
  private _started = false;

  public constructor(private readonly _params: CcxtExchangeWatcherParams) {
    this._logger = _params.logger.child({
      component: 'CcxtExchangeWatcher',
      exchange: _params.exchangeId,
    });
    this._symbols = [..._params.symbols];
    this._effectiveDepth = normalizeDepth(_params.exchangeId, _params.exchangeType, _params.depth);

    if (this._effectiveDepth !== _params.depth) {
      this._logger.info('Normalized orderbook depth for exchange', {
        requested: _params.depth,
        effective: this._effectiveDepth,
        exchange: _params.exchangeId,
        marketType: _params.exchangeType,
      });
    }

    this._obTask = _params.watchOrderbook
      ? new RestartingTask({
          name: `${_params.exchangeId}:orderbook`,
          run: (signal) => this._runObSession(signal),
          logger: this._logger.child({ stream: 'orderbook' }),
          initialBackoffMs: 2_000,
          maxBackoffMs: 60_000,
        })
      : null;
    this._tradesTask = _params.watchTrades
      ? new RestartingTask({
          name: `${_params.exchangeId}:trades`,
          run: (signal) => this._runTradesSession(signal),
          logger: this._logger.child({ stream: 'trades' }),
          initialBackoffMs: 2_000,
          maxBackoffMs: 60_000,
        })
      : null;
  }

  public start(): void {
    if (this._started) {
      this._logger.debug('Watcher already started');
      return;
    }
    this._started = true;
    this._obTask?.start();
    this._tradesTask?.start();
    this._logger.info('Exchange watcher started', {
      symbols: this._symbols.length,
      orderbook: !!this._obTask,
      trades: !!this._tradesTask,
    });
  }

  public async stop(): Promise<void> {
    if (!this._started) return;
    this._started = false;
    this._logger.info('Exchange watcher stop requested');
    const stops: Promise<void>[] = [];
    if (this._obTask) stops.push(this._obTask.stop());
    if (this._tradesTask) stops.push(this._tradesTask.stop());
    await Promise.all(stops);
    this._logger.info('Exchange watcher stopped');
  }

  /**
   * Асинхронная сессия мультиплексного чтения стакана для всех символов биржи.
   *
   * @remarks
   * Владеет ровно одним ccxt instance. Алгоритм:
   * 1. Определяем метод: `watchOrderBookForSymbols` (предпочтительно), затем
   *    `watchOrderBook` per-symbol в loop, либо `fetchOrderBook` (REST polling).
   * 2. На каждой итерации ждём одну обновлённую пару книг и роутим запись
   *    в `onRecord` по её `symbol`.
   * 3. Обнаружение crossed book (ask < bid) триггерит controlled restart.
   */
  private async _runObSession(signal: AbortSignal): Promise<void> {
    const instance = await this._makeInstance();
    const closeOnAbort = (): void => {
      void this._closeInstance(instance);
    };
    signal.addEventListener('abort', closeOnAbort, { once: true });

    const useFetch = this._params.obMethod === 'fetch';
    const canMultiplex =
      !useFetch && typeof instance.watchOrderBookForSymbols === 'function' && !!instance.has?.['watchOrderBookForSymbols'];
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
      await this._closeInstance(instance);
      this._logger.info('OB session stopped');
    }
  }

  private async _runObMultiplex(instance: CcxtExchangeInstance, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (this._isPlannedRestartDue(instance)) {
        this._logger.info('Planned restart (OB multiplex)');
        return;
      }

      const ob = await this._withWatchTimeout<any>(
        () => instance.watchOrderBookForSymbols(this._symbols, this._effectiveDepth),
        OB_STALE_TIMEOUT_MS,
        'OB multiplex stale: no update in 60s',
        signal,
      );

      if (signal.aborted) break;
      if (!ob) continue;
      if (!this._emitOb(ob)) return;
      this._clearTradesCache(instance);
    }
  }

  private async _runObWatchPerSymbol(instance: CcxtExchangeInstance, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (this._isPlannedRestartDue(instance)) {
        this._logger.info('Planned restart (OB watch-per-symbol)');
        return;
      }

      for (const symbol of this._symbols) {
        if (signal.aborted) break;
        const ob = await this._withWatchTimeout<any>(
          () => instance.watchOrderBook(symbol, this._effectiveDepth),
          OB_STALE_TIMEOUT_MS,
          `OB watch stale for ${symbol}`,
          signal,
        );
        if (signal.aborted) break;
        if (!ob) continue;
        if (!ob.symbol) ob.symbol = symbol;
        if (!this._emitOb(ob)) return;
        this._clearTradesCache(instance);
      }
    }
  }

  private async _runObFetch(instance: CcxtExchangeInstance, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (this._isPlannedRestartDue(instance)) {
        this._logger.info('Planned restart (OB fetch)');
        return;
      }

      for (const symbol of this._symbols) {
        if (signal.aborted) break;
        const ob = await this._withWatchTimeout<any>(
          () => instance.fetchOrderBook(symbol, this._effectiveDepth),
          OB_STALE_TIMEOUT_MS,
          `OB fetch stale for ${symbol}`,
          signal,
        );
        if (signal.aborted) break;
        if (!ob) continue;
        if (!ob.symbol) ob.symbol = symbol;
        if (!this._emitOb(ob)) return;
      }

      if (!signal.aborted) {
        await this._sleep(FETCH_POLL_INTERVAL_MS, signal);
      }
    }
  }

  /**
   * Публикует обновление стакана и проверяет его валидность.
   *
   * @returns `false` — если обнаружен crossed book, сессию нужно перезапустить.
   */
  private _emitOb(ob: any): boolean {
    if (!ob?.symbol) return true;
    if (!ob.bids?.length || !ob.asks?.length) return true;

    if (ob.asks[0][0] < ob.bids[0][0]) {
      this._logger.warn('Hung orderbook detected (ask < bid), restarting stream', {
        symbol: ob.symbol,
        bid: ob.bids[0][0],
        ask: ob.asks[0][0],
      });
      return false;
    }

    this._params.onRecord(ob.symbol, {
      t: 'ob',
      ts: ob.timestamp ?? Date.now(),
      bids: ob.bids.slice(0, this._effectiveDepth),
      asks: ob.asks.slice(0, this._effectiveDepth),
    });
    return true;
  }

  /**
   * Асинхронная сессия мультиплексного чтения потока сделок.
   */
  private async _runTradesSession(signal: AbortSignal): Promise<void> {
    const instance = await this._makeInstance();
    const closeOnAbort = (): void => {
      void this._closeInstance(instance);
    };
    signal.addEventListener('abort', closeOnAbort, { once: true });

    const canMultiplex =
      typeof instance.watchTradesForSymbols === 'function' && !!instance.has?.['watchTradesForSymbols'];
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
      await this._closeInstance(instance);
      this._logger.info('Trades session stopped');
    }
  }

  private async _runTradesMultiplex(instance: CcxtExchangeInstance, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (this._isPlannedRestartDue(instance)) {
        this._logger.info('Planned restart (trades multiplex)');
        return;
      }

      const trades = await this._withWatchTimeout<any[]>(
        () => instance.watchTradesForSymbols(this._symbols),
        TRADES_STALE_TIMEOUT_MS,
        'Trades multiplex stale: no update in 180s',
        signal,
      );

      if (signal.aborted) break;
      if (!trades?.length) continue;

      for (const trade of trades) {
        if (!trade?.symbol) continue;
        this._params.onRecord(trade.symbol, {
          t: 'trade',
          ts: trade.timestamp ?? Date.now(),
          p: trade.price,
          sz: trade.amount,
          side: trade.side,
        });
      }

      this._clearTradesCache(instance);
    }
  }

  private async _runTradesWatchPerSymbol(instance: CcxtExchangeInstance, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (this._isPlannedRestartDue(instance)) {
        this._logger.info('Planned restart (trades watch-per-symbol)');
        return;
      }

      for (const symbol of this._symbols) {
        if (signal.aborted) break;
        const trades = await this._withWatchTimeout<any[]>(
          () => instance.watchTrades(symbol),
          TRADES_STALE_TIMEOUT_MS,
          `Trades watch stale for ${symbol}`,
          signal,
        );
        if (signal.aborted) break;
        if (!trades?.length) continue;

        for (const trade of trades) {
          this._params.onRecord(trade.symbol ?? symbol, {
            t: 'trade',
            ts: trade.timestamp ?? Date.now(),
            p: trade.price,
            sz: trade.amount,
            side: trade.side,
          });
        }
      }

      this._clearTradesCache(instance);
    }
  }

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
        watchOrderBook: { checksum: false, limit: this._effectiveDepth },
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
      this._logger.warn('Timed out closing ccxt instance', { timeoutMs: CLOSE_TIMEOUT_MS });
      closeOperation.catch(() => undefined);
    }
  }

  private async _closeInstanceOnce(instance: CcxtExchangeInstance): Promise<void> {
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
          // ignore
        }
      }
    }
    if (instance?.close) {
      await instance.close();
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

  private async _sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0 || signal.aborted) return;
    await new Promise<void>((resolve) => {
      let resolved = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (): void => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      timer = setTimeout(finish, ms);
      timer.unref?.();
      signal.addEventListener('abort', finish, { once: true });
    });
  }

  private _clearTradesCache(instance: CcxtExchangeInstance): void {
    const tradesMap = instance.trades;
    if (!tradesMap || typeof tradesMap !== 'object') return;
    for (const key of Object.keys(tradesMap as Record<string, unknown>)) {
      const cache = (tradesMap as Record<string, any>)[key];
      if (cache && typeof cache.length === 'number') {
        cache.length = 0;
      }
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
