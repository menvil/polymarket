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

export interface CcxtSymbolWatcherParams {
  readonly exchangeId: string;
  readonly exchangeType: 'spot' | 'futures' | 'swap';
  readonly symbol: string;
  readonly depth: number;
  readonly watchOrderbook: boolean;
  readonly watchTrades: boolean;
  readonly restartIntervalMs: number;
  readonly obMethod?: 'watch' | 'fetch';
  readonly onRecord: (record: CexRawRecord) => void;
  readonly logger: ILogger;
}

export class CcxtSymbolWatcher {
  private _stopped = false;
  private readonly _logger: ILogger;

  constructor(private readonly _params: CcxtSymbolWatcherParams) {
    this._logger = _params.logger.child({
      component: 'CcxtSymbolWatcher',
      exchange: _params.exchangeId,
      symbol: _params.symbol,
    });
  }

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

  public stop(): void {
    this._stopped = true;
    this._logger.info('Watcher stop requested');
  }

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
              const stale = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('OB stale: no update in 30s')), STALE_TIMEOUT_MS)
              );
              stale.catch(() => {});
              return Promise.race([
                instance.watchOrderBook(this._params.symbol, this._params.depth),
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

        const stale = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Trades stale: no update in 30s')), STALE_TIMEOUT_MS)
        );
        stale.catch(() => {});
        const trades = await Promise.race([
          instance.watchTrades(this._params.symbol),
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

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
