/**
 * CollectorService — сервис сбора рыночных данных Polymarket без торговой логики.
 *
 * @remarks
 * ### Назначение:
 * Подключается к Polymarket WebSocket, подписывается на указанные tokenIds
 * и записывает все входящие orderbook-снапшоты на диск через `DataRecorder`.
 * Сервис намеренно НЕ выполняет никакой торговой логики.
 *
 * ### Архитектура:
 * ```
 * CollectorService (принимает IPolymarketWsEmitter через DI)
 *   → MarketDataFeedAdapter (маршрутизация WS → NoOpBookUpdateHandler + DataRecorder)
 *   → DataRecorder (запись raw WS-событий на диск)
 * ```
 *
 * ### Зависимости через DI:
 * `IPolymarketWsEmitter` передаётся в конструктор, а не создаётся внутри.
 * Это позволяет использовать как `PolymarketWsAdapter` (production),
 * так и любую mock-реализацию в тестах.
 *
 * ### NoOpBookUpdateHandler:
 * `MarketDataFeedAdapter` требует `BookUpdateHandler` для доменной обработки стаканов.
 * В сервисе сбора данных доменная обработка не нужна — используется заглушка.
 *
 * @example
 * ```typescript
 * const wsManager = new PolymarketWebSocketManager({ url: WS_URL }, logger);
 * const wsAdapter = new PolymarketWsAdapter(wsManager, logger);
 * const config: CollectorConfig = {
 *   outputDir: './data',
 *   compression: 'none',
 *   tokenIds: ['0xabc...', '0xdef...'],
 * };
 * const service = new CollectorService(wsAdapter, config, logger);
 * service.start();
 * // ...
 * await service.stop();
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { InstrumentId } from '@polymarket/ids';
import { asMarketId } from '@polymarket/ids';
import { TimestampService } from '@polymarket/value-objects';
import type { PriceLevel } from '@polymarket/order-book';
import type { IMarketDataRecorder, MarketMeta } from '@polymarket/ports';
import type { BookUpdateHandler } from '@polymarket/handlers';
import type { IPolymarketWsEmitter } from '@polymarket/exchange/ws';
import {
  DataRecorder,
  NDJSONFormatter,
  GzipCompressor,
} from '@polymarket/data-collection';
import { MarketDataFeedAdapter } from '@polymarket/exchange/adapters';
import type { CollectorConfig } from './CollectorConfig.js';

/**
 * Заглушка BookUpdateHandler для использования в CollectorService.
 *
 * @remarks
 * `MarketDataFeedAdapter` требует экземпляр `BookUpdateHandler` как 2-й аргумент
 * конструктора. В сервисе сбора данных доменная обработка стаканов не нужна —
 * достаточно записи raw WS-событий через `DataRecorder`.
 *
 * Реализует тот же публичный интерфейс что и `BookUpdateHandler`:
 * - `handleSnapshot()` — no-op, возвращает resolved Promise
 * - `onReconnect()` — no-op
 *
 * Используется только внутри `CollectorService` — не экспортируется.
 */
class NoOpBookUpdateHandler {
  /**
   * Заглушка обработки снапшота стакана.
   *
   * @param _tokenId - Token ID (игнорируется)
   * @param _bids - Bids (игнорируются)
   * @param _asks - Asks (игнорируются)
   * @param _timestamp - Timestamp (игнорируется)
   * @returns Resolved Promise
   */
  public async handleSnapshot(
    _tokenId: InstrumentId,
    _bids: readonly PriceLevel[],
    _asks: readonly PriceLevel[],
    _timestamp: number,
  ): Promise<void> {
    // Намеренно пусто — доменная обработка не нужна в сервисе сбора данных
  }

  /**
   * Заглушка обработки reconnect.
   *
   * @remarks
   * В настоящем BookUpdateHandler этот метод инвалидирует staleness timestamps.
   * Здесь — no-op, т.к. нет кэша стаканов.
   */
  public onReconnect(): void {
    // Намеренно пусто
  }
}

/**
 * Сервис сбора рыночных данных Polymarket.
 *
 * @remarks
 * Единственная ответственность: подключиться к Polymarket WS и записывать
 * входящие orderbook-снапшоты на диск. Торговая логика отсутствует.
 */
export class CollectorService {
  private readonly _logger: ILogger;
  private readonly _recorder: DataRecorder;
  private _feedAdapter: MarketDataFeedAdapter | null = null;

  /**
   * Создаёт CollectorService.
   *
   * @param _wsEmitter - WS эмиттер (IPolymarketWsEmitter). Управление соединением
   *   (connect/disconnect, подписка на токены) — на стороне вызывающего кода (main.ts).
   * @param _config - Конфигурация сервиса сбора данных
   * @param logger - Logger
   */
  constructor(
    private readonly _wsEmitter: IPolymarketWsEmitter,
    private readonly _config: CollectorConfig,
    logger: ILogger,
  ) {
    this._logger = logger.child({ component: 'CollectorService' });

    const formatter = new NDJSONFormatter();
    const compressor = _config.compression === 'gzip' ? new GzipCompressor() : null;

    this._recorder = new DataRecorder(
      {
        outputDir: _config.outputDir,
        bufferSize: _config.bufferSize ?? 100,
        flushIntervalMs: _config.flushIntervalMs ?? 10_000,
        compression: _config.compression,
      },
      formatter,
      compressor,
      this._logger,
    );
  }

  /**
   * Запускает сервис: регистрирует рынки в рекордере и запускает маршрутизацию событий.
   *
   * @remarks
   * ### Порядок инициализации:
   * 1. Регистрирует каждый tokenId в `DataRecorder` (создаёт файлы на диске)
   * 2. Создаёт `MarketDataFeedAdapter` с `NoOpBookUpdateHandler` и `DataRecorder`
   * 3. Запускает `MarketDataFeedAdapter` (подписывается на WS-события из эмиттера)
   *
   * Подключение WebSocket и подписка на токены выполняются на стороне `main.ts`.
   *
   * @throws {Error} При ошибке создания файлов на диске
   *
   * @example
   * ```typescript
   * await wsAdapter.connect();
   * await wsAdapter.subscribeToToken(tokenId);
   * service.start();
   * ```
   */
  public start(): void {
    this._logger.info('Starting CollectorService', {
      tokenCount: this._config.tokenIds.length,
      outputDir: this._config.outputDir,
      compression: this._config.compression,
    });

    // Регистрируем каждый tokenId как отдельный «рынок» в DataRecorder
    for (const tokenId of this._config.tokenIds) {
      this._registerToken(tokenId);
    }

    // Создаём feed-адаптер с NoOp обработчиком (доменная обработка не нужна).
    // NoOpBookUpdateHandler структурно совместим с BookUpdateHandler:
    // оба имеют handleSnapshot() и onReconnect() с идентичными сигнатурами.
    const noOpHandler = new NoOpBookUpdateHandler();
    this._feedAdapter = new MarketDataFeedAdapter(
      this._wsEmitter,
      noOpHandler as unknown as BookUpdateHandler,
      this._logger,
      this._recorder as IMarketDataRecorder,
    );

    // Запускаем маршрутизацию WS-событий → recorder
    this._feedAdapter.start();

    this._logger.info('CollectorService started', {
      tokenCount: this._config.tokenIds.length,
    });
  }

  /**
   * Останавливает сервис: останавливает адаптер, закрывает рекордер.
   *
   * @remarks
   * Идемпотентен — повторный вызов безопасен.
   *
   * ### Порядок завершения:
   * 1. Останавливает `MarketDataFeedAdapter` (снимает WS-подписки)
   * 2. Закрывает `DataRecorder` (сбрасывает буферы, финализирует все рынки)
   *
   * @throws {Error} При ошибке I/O во время финализации рекордера
   *
   * @example
   * ```typescript
   * process.on('SIGINT', async () => {
   *   await service.stop();
   *   process.exit(0);
   * });
   * ```
   */
  public async stop(): Promise<void> {
    this._logger.info('Stopping CollectorService');

    if (this._feedAdapter) {
      this._feedAdapter.stop();
      this._feedAdapter = null;
    }

    await this._recorder.close();

    this._logger.info('CollectorService stopped');
  }

  /**
   * Регистрирует один tokenId как рынок в DataRecorder.
   *
   * @param tokenId - Token ID для регистрации
   *
   * @remarks
   * Каждый tokenId регистрируется как отдельный «рынок»:
   * - `marketId` = tokenId (нет REST-запроса для получения conditionId)
   * - `question` = tokenId (placeholder, т.к. нет каталога рынков)
   * - `tokenIds` = [tokenId]
   * - `expiresAt` = +1 год от текущего момента (рынок не истечёт во время сбора)
   *
   * Для получения реальных метаданных (question, expiresAt) потребуется
   * интеграция с `PolymarketMarketCatalog` — это улучшение за рамками текущей задачи.
   */
  private _registerToken(tokenId: string): void {
    const marketId = asMarketId(tokenId);
    if (!marketId) {
      this._logger.warn('Invalid tokenId, skipping registration', { tokenId });
      return;
    }

    // Используем +1 год как expiresAt — рынок не истечёт во время сбора данных
    const farFuture = Date.now() + 365 * 24 * 60 * 60 * 1000;
    const expiresAtResult = TimestampService.create(farFuture);
    if (!expiresAtResult.ok) {
      this._logger.warn('Failed to create expiresAt timestamp, skipping registration', {
        tokenId,
        error: expiresAtResult.error.message,
      });
      return;
    }

    const meta: MarketMeta = {
      marketId,
      question: tokenId,
      tokenIds: [tokenId],
      expiresAt: expiresAtResult.value,
    };

    this._recorder.registerMarket(meta);

    this._logger.debug('Token registered for recording', { tokenId });
  }
}
