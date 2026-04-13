import type { ILogger } from '@polymarket/logger';
import type { CexCollectorConfig } from './CexCollectorConfig.js';
import type { CexMarketType, CexRawRecord } from './CexTypes.js';
import { normalizeCexRawRecord } from './CexTypes.js';
import { CexFileRotator } from './CexFileRotator.js';
import { CcxtSymbolWatcher } from './CcxtSymbolWatcher.js';

const DEFAULT_OB_DEPTH = 10;
const DEFAULT_RESTART_INTERVAL_MS = 2 * 60 * 60 * 1000;

export class CexCollectorService {
  private readonly _logger: ILogger;
  private readonly _rotator: CexFileRotator | null;
  private readonly _watchers: CcxtSymbolWatcher[] = [];

  constructor(
    private readonly _config: CexCollectorConfig,
    logger: ILogger,
  ) {
    this._logger = logger.child({ component: 'CexCollectorService' });
    this._rotator = _config.outputDir
      ? new CexFileRotator(
          {
            outputDir: _config.outputDir,
            compression: _config.compression ?? 'gzip',
            windowMinutes: _config.windowMinutes,
            bufferSize: _config.bufferSize,
            flushIntervalMs: _config.flushIntervalMs,
          },
          this._logger,
        )
      : null;
  }

  public async cleanup(): Promise<void> {
    if (!this._rotator) return;
    const exchangeIds = [...new Set(
      Object.entries(this._config.exchanges).map(([key, cfg]) => cfg.exchangeId ?? key),
    )];
    await this._rotator.cleanup(exchangeIds);
  }

  public start(): void {
    this._logger.info('CexCollectorService starting', {
      exchanges: Object.keys(this._config.exchanges),
      diskRecording: this._rotator !== null,
      sinks: this._config.sinks?.length ?? 0,
    });

    this._rotator?.start();
    this._createAndStartWatchers();

    this._logger.info('CexCollectorService started', {
      watcherCount: this._watchers.length,
    });
  }

  public async stop(): Promise<void> {
    this._logger.info('CexCollectorService stopping');

    for (const watcher of this._watchers) {
      watcher.stop();
    }

    await this._rotator?.close();
    await this.cleanup();
    this._watchers.length = 0;

    this._logger.info('CexCollectorService stopped');
  }

  private _createAndStartWatchers(): void {
    for (const [configKey, exchangeConfig] of Object.entries(this._config.exchanges)) {
      const exchangeId = exchangeConfig.exchangeId ?? configKey;
      for (const symbol of exchangeConfig.symbols) {
        const watcher = new CcxtSymbolWatcher({
          exchangeId,
          exchangeType: exchangeConfig.type,
          symbol,
          depth: exchangeConfig.obDepth ?? DEFAULT_OB_DEPTH,
          watchOrderbook: exchangeConfig.orderbook,
          watchTrades: exchangeConfig.trades,
          restartIntervalMs: exchangeConfig.restartIntervalMs ?? DEFAULT_RESTART_INTERVAL_MS,
          obMethod: exchangeConfig.obMethod,
          onRecord: (record) => this._handleRecord(exchangeId, symbol, exchangeConfig.type, record),
          logger: this._logger,
        });

        watcher.start();
        this._watchers.push(watcher);

        this._logger.info('Watcher started', {
          exchange: exchangeId,
          symbol,
          type: exchangeConfig.type,
          orderbook: exchangeConfig.orderbook,
          trades: exchangeConfig.trades,
          obDepth: exchangeConfig.obDepth ?? DEFAULT_OB_DEPTH,
        });
      }
    }
  }

  private _handleRecord(
    exchangeId: string,
    symbol: string,
    marketType: CexMarketType,
    record: CexRawRecord,
  ): void {
    this._rotator?.write(exchangeId, symbol, marketType, record);

    if (!this._config.sinks?.length) return;
    const event = normalizeCexRawRecord(exchangeId, symbol, marketType, record);
    if (!event) return;

    for (const sink of this._config.sinks) {
      try {
        sink(event, record);
      } catch (err) {
        this._logger.warn('CEX sink failed', {
          exchange: exchangeId,
          symbol,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
