/**
 * CexCollectorService — оркестратор сбора CEX рыночных данных.
 *
 * @remarks
 * ### Назначение:
 * Читает конфигурацию бирж, создаёт `CcxtSymbolWatcher` для каждого
 * символа×биржи и координирует запись через `CexFileRotator`.
 *
 * ### Архитектура:
 * ```
 * CexCollectorService
 *   → CexFileRotator (ротация файлов по 5-мин UTC окнам)
 *   → CcxtSymbolWatcher × N (по одному на каждый symbol×exchange)
 *       → ccxt.pro watchOrderBook / watchTrades
 *       → onRecord → CexFileRotator.write()
 * ```
 *
 * ### Пример конфига:
 * ```json
 * {
 *   "exchanges": {
 *     "binance": { "type": "spot", "symbols": ["BTC/USDT"], "orderbook": true, "trades": true },
 *     "bybit":   { "type": "futures", "symbols": ["BTC/USDT"], "orderbook": true, "trades": false }
 *   },
 *   "outputDir": "./data",
 *   "compression": "gzip"
 * }
 * ```
 *
 * @example
 * ```typescript
 * const service = new CexCollectorService(config, logger);
 * service.start();
 * // ...
 * await service.stop();
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { CexCollectorConfig } from './CexCollectorConfig.js';
import { CexFileRotator } from './CexFileRotator.js';
import { CcxtSymbolWatcher } from './CcxtSymbolWatcher.js';

/** Значения по умолчанию */
const DEFAULT_OB_DEPTH = 10;
const DEFAULT_RESTART_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 часа

/**
 * Сервис сбора данных с централизованных бирж.
 */
export class CexCollectorService {
  private readonly _logger: ILogger;
  private readonly _rotator: CexFileRotator;
  private readonly _watchers: CcxtSymbolWatcher[] = [];

  /**
   * @param _config - Конфигурация CEX коллектора
   * @param logger - Логгер
   */
  constructor(
    private readonly _config: CexCollectorConfig,
    logger: ILogger,
  ) {
    this._logger = logger.child({ component: 'CexCollectorService' });

    this._rotator = new CexFileRotator(
      {
        outputDir: _config.outputDir,
        compression: _config.compression,
        windowMinutes: _config.windowMinutes,
        bufferSize: _config.bufferSize,
        flushIntervalMs: _config.flushIntervalMs,
      },
      this._logger,
    );
  }

  /**
   * Запускает ротатор файлов и все watcher'ы.
   *
   * @remarks
   * ### Порядок инициализации:
   * 1. Запускает `CexFileRotator` (ожидает выравнивания по границе окна)
   * 2. Создаёт `CcxtSymbolWatcher` для каждого symbol×exchange из конфига
   * 3. Запускает все watcher'ы (WS соединения поднимаются сразу)
   *
   * Watcher'ы начинают получать данные до первой границы окна, но
   * ротатор их игнорирует до выравнивания — данные не теряются,
   * просто первые секунды/минуты до границы не записываются.
   */
  /**
   * Удаляет незавершённые `.jsonl` файлы от предыдущего краш-запуска.
   *
   * @remarks
   * Вызывать **до** `start()` — при старте процесса.
   * Делегирует в `CexFileRotator.cleanup()` передавая список бирж из конфига.
   */
  public async cleanup(): Promise<void> {
    const exchangeIds = [...new Set(
      Object.entries(this._config.exchanges).map(([key, cfg]) => cfg.exchangeId ?? key),
    )];
    await this._rotator.cleanup(exchangeIds);
  }

  public start(): void {
    this._logger.info('CexCollectorService starting', {
      exchanges: Object.keys(this._config.exchanges),
    });

    this._rotator.start();
    this._createAndStartWatchers();

    this._logger.info('CexCollectorService started', {
      watcherCount: this._watchers.length,
    });
  }

  /**
   * Останавливает все watcher'ы и ротатор.
   *
   * @remarks
   * Незавершённое текущее окно удаляется (неполные данные бесполезны).
   */
  public async stop(): Promise<void> {
    this._logger.info('CexCollectorService stopping');

    // Сигнализируем watcher'ам остановиться
    for (const watcher of this._watchers) {
      watcher.stop();
    }

    // Закрываем ротатор (удаляет незавершённые файлы из snapshot) — теперь асинхронно
    await this._rotator.close();

    // Disk-scan: удаляем любые .jsonl файлы оставшиеся из-за race condition с _rotate()
    // (аналогично cleanup() при старте — один и тот же код)
    await this.cleanup();

    this._watchers.length = 0;

    this._logger.info('CexCollectorService stopped');
  }

  // ── Приватные методы ──────────────────────────────────────────────────────

  /**
   * Создаёт и запускает watcher'ы для всех сконфигурированных бирж и символов.
   */
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
          onRecord: (record) => this._rotator.write(exchangeId, symbol, exchangeConfig.type, record),
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
}
