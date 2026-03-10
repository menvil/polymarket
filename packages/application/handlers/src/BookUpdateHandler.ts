/**
 * BookUpdateHandler — обрабатывает снапшоты стакана из Polymarket WS.
 *
 * @remarks
 * Polymarket шлёт ТОЛЬКО полные снапшоты ('book' events) — нет инкрементальных дельт.
 * 'price_change' events существуют, но это batch-уведомления, не дельты стакана.
 * Текущий код их игнорирует.
 *
 * ### Staleness detection:
 * Если timestamp нового снапшота ≤ предыдущему — логируем warn, но применяем.
 * Это может случиться при reconnect-дублях.
 *
 * ### Reconnect:
 * onReconnect() вызывается из MarketDataFeedAdapter при событии reconnect WS.
 * Инвалидирует staleness timestamps — WS пришлёт свежие снапшоты.
 *
 * @example
 * ```typescript
 * const handler = new BookUpdateHandler(bookRegistry, eventBus, catalog, clock, logger);
 *
 * // Подключить к WS-потоку:
 * wsEmitter.onOrderbookSnapshot(async (dto) => {
 *   // Конвертация в PriceLevel[] происходит в MarketDataFeedAdapter (Phase 8)
 * });
 *
 * // При reconnect:
 * wsEmitter.onReconnect(() => handler.onReconnect());
 * ```
 */
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import type { PriceLevel } from '@polymarket/order-book';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import { TimestampService } from '@polymarket/value-objects';
import type { IEventBus } from '@polymarket/event-bus';
import type { TopOfBook } from '@polymarket/event-bus';
import type { IMarketCatalog } from '@polymarket/ports';
import type { IBookRegistry } from './IBookRegistry.js';

export class BookUpdateHandler {
  /** Последний timestamp снапшота per tokenId — для staleness detection */
  private readonly _lastTimestamps = new Map<string, number>();

  /**
   * Создаёт BookUpdateHandler.
   *
   * @param _books - Реестр OrderBook экземпляров
   * @param _eventBus - Event bus для публикации BOOK_UPDATED
   * @param _catalog - Каталог инструментов (tokenId → marketId)
   * @param _clock - Источник времени
   * @param _logger - Logger
   */
  constructor(
    private readonly _books: IBookRegistry,
    private readonly _eventBus: IEventBus,
    private readonly _catalog: IMarketCatalog,
    private readonly _clock: IClock,
    private readonly _logger: ILogger,
  ) {}

  /**
   * Обрабатывает полный снапшот стакана (Polymarket WS event: type='book').
   *
   * @param tokenId - ID токена (YES/NO outcome token)
   * @param bids - Bids в формате PriceLevel[]
   * @param asks - Asks в формате PriceLevel[]
   * @param timestamp - Unix timestamp снапшота в мс
   *
   * @remarks
   * Polymarket не шлёт дельты — каждый 'book' event это полный снапшот.
   */
  public async handleSnapshot(
    tokenId: InstrumentId,
    bids: readonly PriceLevel[],
    asks: readonly PriceLevel[],
    timestamp: number,
  ): Promise<void> {
    const key = String(tokenId);
    const lastTs = this._lastTimestamps.get(key);

    if (lastTs !== undefined && timestamp <= lastTs) {
      this._logger.warn('Stale orderbook snapshot received, applying anyway', {
        tokenId: String(tokenId),
        lastTs,
        got: timestamp,
      });
    }
    this._lastTimestamps.set(key, timestamp);

    // Создаём timestamp ДО мутации Book — чтобы избежать неконсистентного состояния
    // при ошибке создания timestamp
    const tsResult = TimestampService.fromDate(this._clock.now());
    if (!tsResult.ok) {
      this._logger.error('Failed to create timestamp for book snapshot event', {
        error: tsResult.error.message,
        tokenId: String(tokenId),
      });
      return;
    }

    const instrument = this._catalog.get(tokenId);
    // Если инструмент найден — используем его marketId, иначе fallback на tokenId
    const marketId = instrument?.marketId ?? (tokenId as unknown as MarketId);
    const book = this._books.getOrCreate(marketId, tokenId);
    book.applyFullState([...bids], [...asks]);

    this._logger.debug('Order book snapshot applied', {
      tokenId: String(tokenId),
      bidsCount: bids.length,
      asksCount: asks.length,
    });

    const bestBidLevel = book.getBestBid();
    const bestAskLevel = book.getBestAsk();

    const topOfBook: TopOfBook = {
      bestBid: bestBidLevel?.price,
      bestAsk: bestAskLevel?.price,
      spread: undefined, // TODO: вычислить в Phase 8 когда нужно
      bestBidSize: bestBidLevel?.size,
      bestAskSize: bestAskLevel?.size,
    };

    await this._eventBus.publish({
      type: 'BOOK_UPDATED',
      topOfBook,
      instrumentId: tokenId,
      marketId,
      sequenceNumber: timestamp, // proxy: Polymarket не шлёт sequence number
      timestamp: tsResult.value,
    });
  }

  /**
   * Вызывается при reconnect — инвалидирует staleness timestamps.
   *
   * @remarks
   * WS пришлёт свежие снапшоты для каждого tokenId после reconnect.
   * Сбрасываем timestamps чтобы не считать их stale.
   */
  public onReconnect(): void {
    this._lastTimestamps.clear();
    this._logger.info('Book timestamps reset after reconnect', {});
  }
}

