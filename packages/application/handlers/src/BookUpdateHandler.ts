/**
 * BookUpdateHandler — обрабатывает снапшоты стакана из Polymarket WS.
 *
 * @remarks
 * Polymarket шлёт ТОЛЬКО полные снапшоты ('book' events) — нет инкрементальных дельт.
 * 'price_change' events существуют, но это batch-уведомления, не дельты стакана.
 * Текущий код их игнорирует.
 *
 * ### Immutable-паттерн (Этап 10a):
 * `Orderbook` (`@polymarket/orderbook`) иммутабелен — каждый снапшот строит НОВЫЙ
 * экземпляр через `Orderbook.fromLevels(...)`, не мутирует предыдущий. Предыдущее
 * состояние здесь не нужно (Polymarket не шлёт дельты — каждый новый снапшот
 * полностью заменяет старый), поэтому обработчик не читает реестр перед записью,
 * только пишет через `IBookRegistry.set(...)`.
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
 *   // Конвертация в OrderbookLevel[] происходит в MarketDataFeedAdapter
 * });
 *
 * // При reconnect:
 * wsEmitter.onReconnect(() => handler.onReconnect());
 * ```
 */
import type { ILogger } from '@polymarket/logger';
import { Orderbook, bookPricing, type OrderbookLevel } from '@polymarket/orderbook';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import type { Price } from '@polymarket/value-objects';
import type { Timestamp } from '@polymarket/timestamp';
import { PriceService } from '@polymarket/value-objects';
import type { IEventBus } from '@polymarket/event-bus';
import type { TopOfBook } from '@polymarket/application-events';
import type { MessageMetadataGenerator } from '@polymarket/messages';
import type { IMarketCatalog } from '@polymarket/ports';
import type { IBookRegistry } from './IBookRegistry.js';

/**
 * Ценовые метрики стакана рынка предсказаний.
 *
 * @remarks
 * Фабрика домена связывается ОДИН раз: `Orderbook` — структура и своего
 * ценового домена не знает, поэтому создание производных цен (ширина
 * спреда) выполняется здесь, где домен известен.
 */
const PREDICTION_PRICING = bookPricing(PriceService.create);

/**
 * Обработчик снапшотов стакана — применяет к реестру, публикует BOOK_UPDATED/BOOK_DEPTH.
 *
 * @remarks
 * Полное поведение (staleness detection, reconnect, immutable-паттерн записи) и
 * пример использования — см. докблок модуля выше.
 */
export class BookUpdateHandler {
  /** Последний timestamp снапшота per tokenId — для staleness detection */
  private readonly _lastTimestamps = new Map<string, Timestamp>();
  /** Обратный индекс: marketId → Set<tokenId> — для batch-удаления при закрытии рынка */
  private readonly _marketToTokens = new Map<string, Set<string>>();

  /**
   * Создаёт BookUpdateHandler.
   *
   * @param _books - Реестр Orderbook экземпляров
   * @param _eventBus - Event bus для публикации BOOK_UPDATED и BOOK_DEPTH
   * @param _metadataGenerator - Canonical-генератор metadata публикуемых событий
   *   (book-события — root: первичная реакция на внешнее WS-наблюдение)
   * @param _catalog - Каталог инструментов (tokenId → marketId)
   * @param _logger - Logger
   */
  constructor(
    private readonly _books: IBookRegistry,
    private readonly _eventBus: IEventBus,
    private readonly _metadataGenerator: MessageMetadataGenerator,
    private readonly _catalog: IMarketCatalog,
    private readonly _logger: ILogger,
  ) {}

  /**
   * Обрабатывает полный снапшот стакана (Polymarket WS event: type='book').
   *
   * @param tokenId - ID токена (UP/DOWN outcome token)
   * @param bids - Bids в формате OrderbookLevel[]
   * @param asks - Asks в формате OrderbookLevel[]
   * @param timestamp - Timestamp снапшота из WS
   *
   * @remarks
   * Polymarket не шлёт дельты — каждый 'book' event это полный снапшот, поэтому
   * каждый вызов строит новый `Orderbook` с нуля (`Orderbook.fromLevels`), не
   * читая предыдущее состояние.
   *
   * ### События:
   * - `BOOK_UPDATED` — высокочастотное событие с TopOfBook (лучшие уровни)
   * - `BOOK_DEPTH` — полный снапшот стакана для стратегий с глубиной стакана
   */
  public async handleSnapshot(
    tokenId: InstrumentId,
    bids: readonly OrderbookLevel[],
    asks: readonly OrderbookLevel[],
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

    // `Orderbook.fromLevels`'s первый параметр называется `instrumentId`, но по
    // установленному в Этапе 2 контракту сущности (см. `Orderbook.fromNormalized`)
    // несёт то, что везде в остальном коде называется marketId — тот же неймингный
    // артефакт entity, не вводится здесь заново, а следует уже принятому паттерну.
    const book = Orderbook.fromLevels(
      instrument.marketId as unknown as InstrumentId,
      tokenId,
      bids,
      asks,
      timestamp,
    );
    this._books.set(instrument.marketId, tokenId, book);

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

    const bestBid = book.getBestBid();
    const bestAsk = book.getBestAsk();

    // Spread = bestAsk - bestBid — делегируем bookPricing для переиспользования
    // логики. spread() уже само отсеивает crossed/empty/one-sided книги через
    // Err — отдельная проверка "spread > 0" (как в старом mutable OrderBook)
    // не нужна.
    let spread: Price | undefined;
    const spreadResult = PREDICTION_PRICING.spread(book);
    if (spreadResult.ok) {
      const priceResult = PriceService.create(spreadResult.value.width());
      if (priceResult.ok) spread = priceResult.value;
    }

    const topOfBook: TopOfBook = {
      bestBid: bestBid ?? undefined,
      bestAsk: bestAsk ?? undefined,
      spread,
      bestBidSize: book.bids[0]?.quantity,
      bestAskSize: book.asks[0]?.quantity,
    };

    const bookUpdatedResult = await this._eventBus.publish({
      type: 'BOOK_UPDATED',
      payload: {
        topOfBook,
        instrumentId: tokenId,
        marketId: instrument.marketId,
        sequenceNumber: timestamp.toNumber(), // proxy: Polymarket не шлёт sequence number
        timestamp,
      },
      metadata: this._metadataGenerator.nextRoot(),
    });
    if (!bookUpdatedResult.ok) {
      this._logger.error('Failed to publish BOOK_UPDATED', {
        tokenId: String(tokenId),
        error: bookUpdatedResult.error.message,
      });
    }

    const bookDepthResult = await this._eventBus.publish({
      type: 'BOOK_DEPTH',
      payload: {
        instrumentId: tokenId,
        snapshot: book,
        timestamp,
      },
      metadata: this._metadataGenerator.nextRoot(),
    });
    if (!bookDepthResult.ok) {
      this._logger.error('Failed to publish BOOK_DEPTH', {
        tokenId: String(tokenId),
        error: bookDepthResult.error.message,
      });
    }
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
   * Вызывается при закрытии рынка — очищает Orderbook и staleness timestamps.
   *
   * @param marketId - ID закрытого рынка
   *
   * @remarks
   * Удаляет все Orderbook для всех токенов (YES/NO) данного рынка из реестра.
   * Также удаляет staleness timestamps для этих токенов.
   * Освобождает память, занятую стаканами неактивного рынка.
   *
   * Должен вызываться orchestration-слоем при получении MARKET_CLOSED события.
   *
   * @example
   * ```typescript
   * eventBus.subscribe('MARKET_CLOSED', (event) => {
   *   bookHandler.onMarketClosed(event.payload.marketId);
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
