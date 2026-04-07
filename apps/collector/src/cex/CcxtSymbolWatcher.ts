/**
 * CcxtSymbolWatcher — подписка на ордербук и трейды одного символа через ccxt.pro.
 *
 * @remarks
 * ### Назначение:
 * Запускает два независимых async-цикла (OB и Trades) для одного символа
 * на одной бирже. Каждый цикл вызывает ccxt.pro `watchOrderBook`/`watchTrades`
 * и передаёт события в коллбэк `onRecord`.
 *
 * ### Защита от hung orderbooks:
 * - Проверка `asks[0][0] < bids[0][0]` — инвертированный стакан → restart
 * - Принудительный restart каждые `restartIntervalMs` (по умолчанию 2 часа)
 * - Staleness timeout 30s (`Promise.race`) — если нет обновлений → restart
 * - При любой ошибке: закрываем клиенты ccxt, пересоздаём инстанс, 1 сек задержка
 *
 * ### Формат записей:
 * ```json
 * // ордербук (top-N уровней)
 * {"t":"ob","ts":1712401200000,"bids":[[64999.5,1.2]],"asks":[[65000.0,0.5]]}
 *
 * // трейд
 * {"t":"trade","ts":1712401200123,"p":65000.0,"sz":0.15,"side":"buy"}
 * ```
 *
 * @example
 * ```typescript
 * const watcher = new CcxtSymbolWatcher({
 *   exchangeId: 'binance',
 *   exchangeType: 'spot',
 *   symbol: 'BTC/USDT',
 *   depth: 10,
 *   watchOrderbook: true,
 *   watchTrades: true,
 *   restartIntervalMs: 2 * 60 * 60 * 1000,
 *   onRecord: (r) => rotator.write('binance', 'BTC/USDT', r),
 *   logger,
 * });
 *
 * watcher.start();
 * // ...
 * await watcher.stop();
 * ```
 */

import type { ILogger } from '@polymarket/logger';

// Динамический импорт для ESM совместимости
let ccxtModule: typeof import('ccxt') | null = null;

async function getCcxt(): Promise<typeof import('ccxt')> {
  if (!ccxtModule) {
    ccxtModule = await import('ccxt');
  }
  return ccxtModule;
}

/** Таймаут ожидания обновления данных (мс) — защита от зависших соединений */
const STALE_TIMEOUT_MS = 30_000;

/** Параметры CcxtSymbolWatcher */
export interface CcxtSymbolWatcherParams {
  /** ID биржи в ccxt (например `'binance'`, `'bybit'`) */
  readonly exchangeId: string;
  /** Тип рынка */
  readonly exchangeType: 'spot' | 'futures' | 'swap';
  /** Символ в формате ccxt (например `'BTC/USDT'`) */
  readonly symbol: string;
  /** Глубина ордербука */
  readonly depth: number;
  /** Подписываться ли на ордербук */
  readonly watchOrderbook: boolean;
  /** Подписываться ли на трейды */
  readonly watchTrades: boolean;
  /** Интервал принудительного restart в мс */
  readonly restartIntervalMs: number;
  /** Коллбэк для каждого события (ob или trade) */
  readonly onRecord: (record: object) => void;
  readonly logger: ILogger;
}

/**
 * Наблюдатель за одним символом через ccxt.pro WS.
 */
export class CcxtSymbolWatcher {
  private _stopped = false;
  private readonly _logger: ILogger;

  /**
   * @param _params - Параметры наблюдателя
   */
  constructor(private readonly _params: CcxtSymbolWatcherParams) {
    this._logger = _params.logger.child({
      component: 'CcxtSymbolWatcher',
      exchange: _params.exchangeId,
      symbol: _params.symbol,
    });
  }

  /**
   * Запускает async-циклы наблюдения (fire-and-forget).
   *
   * @remarks
   * Циклы работают независимо. Каждый сам управляет reconnect-логикой.
   */
  public start(): void {
    this._stopped = false;
    if (this._params.watchOrderbook) {
      void this._runObLoop();
    }
    if (this._params.watchTrades) {
      void this._runTradesLoop();
    }
    this._logger.info('Watcher started');
  }

  /**
   * Сигнализирует циклам об остановке.
   *
   * @remarks
   * Циклы завершатся при следующей итерации после установки флага.
   */
  public stop(): void {
    this._stopped = true;
    this._logger.info('Watcher stop requested');
  }

  // ── Приватные методы ──────────────────────────────────────────────────────

  /**
   * Async-цикл наблюдения за ордербуком.
   *
   * @remarks
   * Алгоритм:
   * 1. Создаёт ccxt.pro инстанс
   * 2. Вызывает `watchOrderBook(symbol, depth)` в цикле
   * 3. Hung detection: `asks[0][0] < bids[0][0]` → restart
   * 4. Плановый restart по `restartIntervalMs`
   * 5. Любая ошибка → закрыть клиент, пересоздать, продолжить
   */
  private async _runObLoop(): Promise<void> {
    let instance = await this._makeInstance();

    while (!this._stopped) {
      try {
        // Плановый restart для защиты от silent hangs
        if (Date.now() - instance._createdAt > this._params.restartIntervalMs) {
          this._logger.info('Planned restart (restartInterval exceeded)', {
            intervalMs: this._params.restartIntervalMs,
          });
          await this._closeInstance(instance);
          instance = await this._makeInstance();
          continue;
        }

        const ob = await Promise.race([
          instance.watchOrderBook(this._params.symbol, this._params.depth),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('OB stale: no update in 30s')), STALE_TIMEOUT_MS)
          ),
        ]);

        if (!ob.bids.length || !ob.asks.length) continue;

        // Hung detection: инвертированный стакан
        if (ob.asks[0][0] < ob.bids[0][0]) {
          this._logger.warn('Hung orderbook detected (ask < bid) — restarting', {
            bid: ob.bids[0][0],
            ask: ob.asks[0][0],
          });
          await this._closeInstance(instance);
          instance = await this._makeInstance();
          continue;
        }

        this._params.onRecord({
          t: 'ob',
          ts: ob.timestamp ?? Date.now(),
          bids: ob.bids.slice(0, this._params.depth),
          asks: ob.asks.slice(0, this._params.depth),
        });
      } catch (err) {
        if (this._stopped) break;

        const msg = err instanceof Error ? err.message : String(err);
        this._logger.warn('OB watcher error — restarting', { error: msg.slice(0, 150) });

        await this._closeInstance(instance);
        await this._sleep(1000);
        instance = await this._makeInstance();
      }
    }

    await this._closeInstance(instance);
    this._logger.info('OB loop stopped');
  }

  /**
   * Async-цикл наблюдения за трейдами.
   *
   * @remarks
   * `watchTrades` возвращает массив новых трейдов с момента последнего вызова.
   * Каждый трейд передаётся в `onRecord` отдельно.
   */
  private async _runTradesLoop(): Promise<void> {
    let instance = await this._makeInstance();

    while (!this._stopped) {
      try {
        // Плановый restart
        if (Date.now() - instance._createdAt > this._params.restartIntervalMs) {
          this._logger.info('Planned restart (restartInterval exceeded) — trades loop');
          await this._closeInstance(instance);
          instance = await this._makeInstance();
          continue;
        }

        const trades = await Promise.race([
          instance.watchTrades(this._params.symbol),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Trades stale: no update in 30s')), STALE_TIMEOUT_MS)
          ),
        ]);

        for (const trade of trades) {
          this._params.onRecord({
            t: 'trade',
            ts: trade.timestamp ?? Date.now(),
            p: trade.price,
            sz: trade.amount,
            side: trade.side, // 'buy' | 'sell'
          });
        }
      } catch (err) {
        if (this._stopped) break;

        const msg = err instanceof Error ? err.message : String(err);
        this._logger.warn('Trades watcher error — restarting', { error: msg.slice(0, 150) });

        await this._closeInstance(instance);
        await this._sleep(1000);
        instance = await this._makeInstance();
      }
    }

    await this._closeInstance(instance);
    this._logger.info('Trades loop stopped');
  }

  /**
   * Создаёт новый ccxt.pro инстанс для биржи.
   *
   * @returns ccxt.pro exchange инстанс с `_createdAt` меткой
   */
  private async _makeInstance(): Promise<any> {
    const { default: ccxt } = await getCcxt();
    const pro = (ccxt as any).pro as Record<string, new (opts: object) => any>;
    const ExchangeClass = pro[this._params.exchangeId];

    if (!ExchangeClass) {
      throw new Error(`Exchange '${this._params.exchangeId}' not found in ccxt.pro`);
    }

    const instance = new ExchangeClass({
      options: {
        defaultType: this._params.exchangeType,
        timeout: 30_000,
        watchOrderBook: { checksum: false, limit: this._params.depth },
      },
    });

    instance._createdAt = Date.now();

    this._logger.debug('ccxt.pro instance created');
    return instance;
  }

  /**
   * Закрывает все WS-клиенты ccxt инстанса.
   *
   * @param instance - ccxt.pro exchange инстанс
   */
  private async _closeInstance(instance: any): Promise<void> {
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
      this._logger.debug('Error closing ccxt instance (expected on restart)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Задержка выполнения.
   *
   * @param ms - Задержка в мс
   */
  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
