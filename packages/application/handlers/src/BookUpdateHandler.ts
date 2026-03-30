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
 * const handler = new BookUpdateHandler(bookRegistry, eventBus, catalog, logger);
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
import type { PriceLevel } from '@polymarket/order-book';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import type { Price, Timestamp } from '@polymarket/value-objects';
import { PriceService } from '@polymarket/value-objects';
import type { IEventBus } from '@polymarket/event-bus';
import type { TopOfBook } from '@polymarket/event-bus';
import type { IMarketCatalog } from '@polymarket/ports';
import type { IBookRegistry } from './IBookRegistry.js';

export class BookUpdateHandler {
  /** Последний timestamp снапшота per tokenId — для staleness detection */
  private readonly _lastTimestamps = new Map<string, Timestamp>();
  /** Обратный индекс: marketId → Set<tokenId> — для batch-удаления при закрытии рынка */
  private readonly _marketToTokens = new Map<string, Set<string>>();

  /**
   * Создаёт BookUpdateHandler.
   *
   * @param _books - Реестр OrderBook экземпляров
   * @param _eventBus - Event bus для публикации BOOK_UPDATED и BOOK_DEPTH
   * @param _catalog - Каталог инструментов (tokenId → marketId)
   * @param _logger - Logger
   */
  constructor(
    private readonly _books: IBookRegistry,
    private readonly _eventBus: IEventBus,
    private readonly _catalog: IMarketCatalog,
    private readonly _logger: ILogger,
  ) {}

  /**
   * Обрабатывает полный снапшот стакана (Polymarket WS event: type='book').
   *
   * @param tokenId - ID токена (UP/DOWN outcome token)
   * @param bids - Bids в формате PriceLevel[]
   * @param asks - Asks в формате PriceLevel[]
   * @param timestamp - Timestamp снапшота из WS
   *
   * @remarks
   * Polymarket не шлёт дельты — каждый 'book' event это полный снапшот.
   *
   * ### События:
   * - `BOOK_UPDATED` — высокочастотное событие с TopOfBook (лучшие уровни)
   * - `BOOK_DEPTH` — полный снапшот стакана для стратегий с глубиной стакана
   */
  public async handleSnapshot(
    tokenId: InstrumentId,
    bids: readonly PriceLevel[],
    asks: readonly PriceLevel[],
    timestamp: Timestamp,
  ): Promise<void> {
    const key   = String(tokenId);
    const lastTs = this._lastTimestamps.get(key);

    if (lastTs !== undefined && timestamp.isBeforeOrEqual(lastTs)) {
      this._logger.debug('Stale orderbook snapshot received, applying anyway', {
        tokenId: String(tokenId),
        lastTs:  lastTs.toISO(),
        got:     timestamp.toISO(),
      });
    }
    this._lastTimestamps.set(key, timestamp);

    const instrument = this._catalog.get(tokenId);
    if (!instrument) {
      this._logger.debug('Received snapshot for unregistered instrument, skipping', {
        tokenId: String(tokenId),
      });
      return;
    }
    const book = this._books.getOrCreate(instrument.marketId, tokenId);
    book.applyFullState(bids, asks, timestamp);

    // Индексируем tokenId → marketId для последующей очистки в onMarketClosed
    const marketKey = String(instrument.marketId);
    const tokenKey  = String(tokenId);
    let tokenSet = this._marketToTokens.get(marketKey);
    if (!tokenSet) {
      tokenSet = new Set();
      this._marketToTokens.set(marketKey, tokenSet);
    }
    tokenSet.add(tokenKey);

    this._logger.debug('Order book snapshot applied', {
      tokenId: tokenKey,
      bidsCount: bids.length,
      asksCount: asks.length,
    });

    const bestBidLevel = book.getBestBid();
    const bestAskLevel = book.getBestAsk();

    // Spread = bestAsk - bestBid (O(1)) — делегируем OrderBook для переиспользования логики
    let spread: Price | undefined;
    if (bestBidLevel && bestAskLevel) {
      const rawSpread = book.getSpread();
      if (rawSpread !== undefined && rawSpread.gt(0)) {
        const spreadResult = PriceService.create(rawSpread.toString());
        if (spreadResult.ok) spread = spreadResult.value;
      }
    }

    const topOfBook: TopOfBook = {
      bestBid: bestBidLevel?.price,
      bestAsk: bestAskLevel?.price,
      spread,
      bestBidSize: bestBidLevel?.size,
      bestAskSize: bestAskLevel?.size,
    };

    await this._eventBus.publish({
      type: 'BOOK_UPDATED',
      topOfBook,
      instrumentId: tokenId,
      marketId: instrument.marketId,
      sequenceNumber: timestamp.toNumber(), // proxy: Polymarket не шлёт sequence number
      timestamp,
    });

    await this._eventBus.publish({
      type: 'BOOK_DEPTH',
      instrumentId: tokenId,
      snapshot: book.toSnapshot(),
      timestamp,
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

  /**
   * Вызывается при закрытии рынка — очищает OrderBook и staleness timestamps.
   *
   * @param marketId - ID закрытого рынка
   *
   * @remarks
   * Удаляет все OrderBook для всех токенов (YES/NO) данного рынка из реестра.
   * Также удаляет staleness timestamps для этих токенов.
   * Освобождает память, занятую стаканами неактивного рынка.
   *
   * Должен вызываться orchestration-слоем при получении MARKET_CLOSED события.
   *
   * @example
   * ```typescript
   * eventBus.subscribe('MARKET_CLOSED', (event) => {
   *   bookHandler.onMarketClosed(event.marketId);
   * });
   * ```
   */
  public onMarketClosed(marketId: MarketId): void {
    const marketKey = String(marketId);
    const tokens = this._marketToTokens.get(marketKey);
    if (!tokens) return;

    for (const tokenKey of tokens) {
      this._lastTimestamps.delete(tokenKey);
    }
    this._marketToTokens.delete(marketKey);
    this._books.deleteMarket(marketId);

    this._logger.info('Book registry cleaned up for closed market', { marketId: marketKey });
  }
}

