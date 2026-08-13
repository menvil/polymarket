import type { ILogger } from '@polymarket/logger';
import type { CexCollectorConfig } from './CexCollectorConfig.js';
import type { CexMarketType, CexRawRecord } from './CexTypes.js';
import { normalizeCexRawRecord } from './CexTypes.js';
import { CexFileRotator } from './CexFileRotator.js';
import { CcxtExchangeWatcher } from './CcxtExchangeWatcher.js';

const DEFAULT_OB_DEPTH = 10;
// Плановый перезапуск ccxt.pro-инстансов каждые 30 мин:
// освобождает накопленный внутренний стейт (WS-буферы, кэши, GC-фрагментацию).
// 2 часа было слишком долго — приводило к росту RSS до 4 GB.
const DEFAULT_RESTART_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Сервис сбора рыночных данных с CEX-бирж через ccxt.pro.
 *
 * @remarks
 * ### Архитектура
 *
 * `CexCollectorService` объединяет:
 * - **`CcxtSymbolWatcher`** — один watcher на каждую пару (биржа × символ),
 *   читает WebSocket-потоки стаканов и сделок.
 * - **`CexFileRotator`** (опционально) — записывает сырые записи в JSONL-файлы
 *   с ротацией по временным окнам и gzip-сжатием.
 * - **`sinks`** (опционально) — callback-функции для downstream потребителей
 *   (напр. `CryptoMarketDataStore`).
 *
 * ### Жизненный цикл
 * ```
 * constructor → start() → [работа] → stop()
 * ```
 * При `stop()` все watcher'ы останавливаются, файловый ротатор закрывается
 * и незавершённые файлы текущего окна удаляются.
 *
 * @example
 * ```typescript
 * const service = new CexCollectorService(config, logger);
 * service.start();
 * // ...
 * await service.stop();
 * ```
 */
export class CexCollectorService {
  private readonly _logger: ILogger;
  private readonly _rotator: CexFileRotator | null;
  private readonly _watchers: CcxtExchangeWatcher[] = [];

  /**
   * @param _config - Конфигурация коллектора
   * @param logger - Логгер (получает child с компонентом 'CexCollectorService')
   */
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

  /**
   * Удаляет незавершённые JSONL-файлы (без .gz) для всех бирж.
   *
   * @remarks
   * Вызывается автоматически в `stop()`.
   * Может использоваться при запуске для очистки остатков предыдущей сессии.
   */
  public async cleanup(): Promise<void> {
    if (!this._rotator) return;
    const exchangeIds = [...new Set(
      Object.entries(this._config.exchanges).map(([key, cfg]) => cfg.exchangeId ?? key),
    )];
    await this._rotator.cleanup(exchangeIds);
  }

  /**
   * Запускает ротатор файлов и все watcher'ы.
   *
   * @remarks
   * Метод синхронный: watcher'ы запускают асинхронные петли через `void`.
   * Ошибки в петлях логируются, но не останавливают сервис.
   */
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

  /**
   * Останавливает все watcher'ы, закрывает ротатор и очищает незавершённые файлы.
   *
   * @remarks
   * Ждёт завершения всех операций записи перед возвратом.
   */
  public async stop(): Promise<void> {
    this._logger.info('CexCollectorService stopping');

    await Promise.all(this._watchers.map((watcher) => watcher.stop()));

    await this._rotator?.close();
    await this.cleanup();
    this._watchers.length = 0;

    this._logger.info('CexCollectorService stopped');
  }

  /**
   * Создаёт и запускает `CcxtExchangeWatcher` — один на биржу, с мультиплексной
   * подпиской на все символы.
   *
   * @remarks
   * Один ccxt.pro-инстанс на поток (orderbook/trades) на биржу вместо одного
   * на символ. Это снимает rate-limit ошибки подписки (OKX 50011, bybit spot
   * depth-валидация) и уменьшает количество WebSocket-соединений в 2N раз.
   */
  private _createAndStartWatchers(): void {
    for (const [configKey, exchangeConfig] of Object.entries(this._config.exchanges)) {
      const exchangeId = exchangeConfig.exchangeId ?? configKey;
      if (exchangeConfig.symbols.length === 0) continue;

      const watcher = new CcxtExchangeWatcher({
        exchangeId,
        exchangeType: exchangeConfig.type,
        symbols: exchangeConfig.symbols,
        depth: exchangeConfig.obDepth ?? DEFAULT_OB_DEPTH,
        watchOrderbook: exchangeConfig.orderbook,
        watchTrades: exchangeConfig.trades,
        restartIntervalMs: exchangeConfig.restartIntervalMs ?? DEFAULT_RESTART_INTERVAL_MS,
        obMethod: exchangeConfig.obMethod,
        onRecord: (symbol, record) =>
          this._handleRecord(exchangeId, symbol, exchangeConfig.type, record),
        logger: this._logger,
      });

      watcher.start();
      this._watchers.push(watcher);

      this._logger.info('Exchange watcher started', {
        exchange: exchangeId,
        type: exchangeConfig.type,
        symbols: exchangeConfig.symbols.length,
        orderbook: exchangeConfig.orderbook,
        trades: exchangeConfig.trades,
        obDepth: exchangeConfig.obDepth ?? DEFAULT_OB_DEPTH,
      });
    }
  }

  /**
   * Обрабатывает новую сырую запись: записывает в ротатор и вызывает sinks.
   *
   * @remarks
   * Ошибки в отдельных sinks логируются и не прерывают обработку.
   *
   * @param exchangeId - Идентификатор биржи
   * @param symbol - Символ торговой пары
   * @param marketType - Тип рынка
   * @param record - Сырая запись (стакан или сделка)
   */
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
