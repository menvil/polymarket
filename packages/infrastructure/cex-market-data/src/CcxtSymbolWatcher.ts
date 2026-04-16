import type { ILogger } from '@polymarket/logger';
import type { CexRawRecord } from './CexTypes.js';

let ccxtModule: typeof import('ccxt') | null = null;

async function getCcxt(): Promise<typeof import('ccxt')> {
  if (!ccxtModule) {
    ccxtModule = await import('ccxt');
  }
  return ccxtModule;
}

const STALE_TIMEOUT_MS = 30_000;

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
 * Каждая операция watch обёрнута в `Promise.race` со stale-таймаутом
 * (`STALE_TIMEOUT_MS = 30s`). Если обновлений не поступало 30 секунд —
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
   * Запускает петли наблюдения (стакан и/или сделки).
   *
   * @remarks
   * Сбрасывает флаг `_stopped` и запускает петли через `void ... .catch(...)`.
   * Метод синхронный, петли работают в фоне.
   */
  public start(): void {
    this._stopped = false;
    if (this._params.watchOrderbook) {
      void this._runObLoop().catch((err) => {
        this._logger.error('OB loop crashed unexpectedly', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    if (this._params.watchTrades) {
      void this._runTradesLoop().catch((err) => {
        this._logger.error('Trades loop crashed unexpectedly', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    this._logger.info('Watcher started');
  }

  /**
   * Останавливает петли наблюдения.
   *
   * @remarks
   * Устанавливает `_stopped = true`. Петли завершатся при следующей итерации.
   * Не ждёт полного завершения — используйте `await` при необходимости.
   */
  public stop(): void {
    this._stopped = true;
    this._logger.info('Watcher stop requested');
  }

  /**
   * Асинхронная петля чтения стакана ордеров.
   *
   * @remarks
   * Автоматически определяет метод (watchOrderBook vs fetchOrderBook).
   * При обнаружении «перевёрнутого» стакана (ask < bid) перезапускает инстанс.
   * Записи передаются в `_params.onRecord` как `CexOrderbookRecord`.
   */
  private async _runObLoop(): Promise<void> {
    let instance = await this._makeInstance();

    const useWatch = this._params.obMethod === 'fetch'
      ? false
      : (this._params.obMethod === 'watch' || !!instance.has?.['watchOrderBook']);

    this._logger.info('OB loop starting', {
      method: useWatch ? 'watchOrderBook' : 'fetchOrderBook',
      exchange: this._params.exchangeId,
    });

    while (!this._stopped) {
      try {
        if (Date.now() - instance._createdAt > this._params.restartIntervalMs) {
          this._logger.info('Planned restart (restartInterval exceeded)', {
            intervalMs: this._params.restartIntervalMs,
          });
          await this._closeInstance(instance);
          instance = await this._makeInstance();
          continue;
        }

        const ob = useWatch
          ? await (() => {
              let staleTimer: ReturnType<typeof setTimeout>;
              const stale = new Promise<never>((_, reject) => {
                staleTimer = setTimeout(() => reject(new Error('OB stale: no update in 30s')), STALE_TIMEOUT_MS);
              });
              stale.catch(() => {});
              return Promise.race([
                instance.watchOrderBook(this._params.symbol, this._params.depth)
                  .then((result: unknown) => { clearTimeout(staleTimer); return result; }),
                stale,
              ]);
            })()
          : await instance.fetchOrderBook(this._params.symbol, this._params.depth);

        if (!ob.bids.length || !ob.asks.length) continue;

        if (ob.asks[0][0] < ob.bids[0][0]) {
          this._logger.warn('Hung orderbook detected (ask < bid), restarting', {
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
        this._logger.warn('OB watcher error, restarting', { error: msg.slice(0, 150) });
        await this._closeInstance(instance);
        await this._sleep(1000);
        instance = await this._makeInstance();
      }
    }

    await this._closeInstance(instance);
    this._logger.info('OB loop stopped');
  }

  /**
   * Асинхронная петля чтения потока сделок.
   *
   * @remarks
   * Использует `watchTrades` из ccxt.pro с stale-таймаутом 30 секунд.
   * Каждая сделка передаётся в `_params.onRecord` как `CexTradeRecord`.
   */
  private async _runTradesLoop(): Promise<void> {
    let instance = await this._makeInstance();

    while (!this._stopped) {
      try {
        if (Date.now() - instance._createdAt > this._params.restartIntervalMs) {
          this._logger.info('Planned restart (restartInterval exceeded), trades loop');
          await this._closeInstance(instance);
          instance = await this._makeInstance();
          continue;
        }

        let staleTimer: ReturnType<typeof setTimeout>;
        const stale = new Promise<never>((_, reject) => {
          staleTimer = setTimeout(() => reject(new Error('Trades stale: no update in 30s')), STALE_TIMEOUT_MS);
        });
        stale.catch(() => {});
        const trades = await Promise.race([
          instance.watchTrades(this._params.symbol)
            .then((result: unknown) => { clearTimeout(staleTimer); return result; }),
          stale,
        ]);

        for (const trade of trades) {
          this._params.onRecord({
            t: 'trade',
            ts: trade.timestamp ?? Date.now(),
            p: trade.price,
            sz: trade.amount,
            side: trade.side,
          });
        }


      } catch (err) {
        if (this._stopped) break;
        const msg = err instanceof Error ? err.message : String(err);
        this._logger.warn('Trades watcher error, restarting', { error: msg.slice(0, 150) });
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
   * @remarks
   * Добавляет `_createdAt` timestamp для отслеживания времени жизни инстанса.
   * Инстанс использует `defaultType` из `_params.exchangeType`.
   *
   * @returns Инстанс ccxt.pro биржи
   * @throws {Error} Если биржа не найдена в ccxt.pro
   */
  private async _makeInstance(): Promise<any> {
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

    instance._createdAt = Date.now();
    this._logger.debug('ccxt.pro instance created');
    return instance;
  }

  /**
   * Закрывает ccxt.pro инстанс, закрывая все WebSocket-клиенты.
   *
   * @remarks
   * Ошибки закрытия логируются как debug (ожидаемы при перезапуске).
   *
   * @param instance - ccxt.pro инстанс для закрытия
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
   * Вспомогательный метод паузы.
   *
   * @param ms - Длительность паузы (ms)
   */
  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
