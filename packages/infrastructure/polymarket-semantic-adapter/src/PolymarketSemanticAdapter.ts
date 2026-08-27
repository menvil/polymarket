/**
 * Semantic adapter Polymarket: raw-наблюдения → canonical Domain/Application.
 *
 * @remarks
 * ### Место в контуре
 *
 * ```text
 *                     ExternalMessageBus
 *                    ↙                  ↘
 *       ExternalMessageRecorder    PolymarketSemanticAdapter
 *                 ↓                          ↓
 *               JSONL                Domain VO / Entities
 *                                            ↓
 *                                     ApplicationEvent
 *                                            ↓
 *                                        EventBus
 * ```
 *
 * Recorder и адаптер — НЕЗАВИСИМЫЕ потребители одной шины. Адаптер не знает
 * ни про `DataCollector`, ни про recorder: он подписан на общий raw-bus, и
 * ничего больше. Поэтому падение semantic-маппинга не мешает записи сырых
 * данных, а отключение адаптера не влияет на сбор.
 *
 * ### Что адаптер НЕ делает
 *
 * - не владеет raw-шиной (`close()` снимает ТОЛЬКО свои подписки);
 * - не создаёт Application EventBus (его передаёт composition root);
 * - не вызывает Application-хендлеры напрямую — только публикует события;
 * - не резолвит рынки и не считает победителей (это MR-B/`MarketFinalizer`);
 * - не мутирует SDK-payload наблюдения.
 *
 * ### Границы точности
 *
 * Все денежные величины проходят путь `десятичная строка vendor-а → VO`.
 * `Number()`/`parseFloat()`/унарный `+` к финансовым значениям в этом
 * пакете не применяются нигде.
 */
import type { ILogger } from '@polymarket/logger';
import type { IEventBus } from '@polymarket/event-bus';
import type { MessageMetadata, MessageMetadataGenerator } from '@polymarket/messages';
import type { IExternalMessageBus } from '@polymarket/external-message-bus';
import type { PolymarketExternalMessage } from '@polymarket/polymarket-v2';
import type { InstrumentId, MarketId, MarketDataSourceId } from '@polymarket/ids';
import { asInstrumentId, asMarketId, asMarketDataSourceId, asVenueTradeId } from '@polymarket/ids';
import type { Orderbook } from '@polymarket/orderbook';
import { bookPricing } from '@polymarket/orderbook';
import type { OutcomePrice, Quantity, Side } from '@polymarket/value-objects';
import { OutcomePriceService, QuantityService, AssetPriceService } from '@polymarket/value-objects';
import type { Timestamp } from '@polymarket/timestamp';
import { TimestampService } from '@polymarket/timestamp';
import type { ReferencePriceFeed, TopOfBook } from '@polymarket/application-events';
import type { OrderSide } from '@polymarket/bindings';
import type { BookSide, LevelDeltaInput, VendorBestPrices } from './OrderbookReconstructionState.js';
import { OrderbookReconstructionState } from './OrderbookReconstructionState.js';
import { parseAssetPair } from './symbols.js';

/**
 * Порт подписки адаптера на общий bus.
 *
 * @remarks
 * Структурное подмножество `IExternalMessageBus` (только `subscribe`) — то
 * же правило, что у recorder-а и TWAP-трекера: адаптер не владеет шиной и
 * не имеет права публиковать/дренировать/закрывать её. Узкий тип также
 * позволяет передать шину, параметризованную БОЛЕЕ ШИРОКИМ union-ом
 * источников контура (Polymarket + CEX + ...).
 */
export type PolymarketSemanticBusSubscription = Pick<
  IExternalMessageBus<PolymarketExternalMessage>,
  'subscribe'
>;

/** Зависимости {@link PolymarketSemanticAdapter}. */
export interface PolymarketSemanticAdapterDependencies {
  /** Общий raw bus внешнего контура (используется только `subscribe`). */
  readonly bus: PolymarketSemanticBusSubscription;
  /** Application event bus, КУДА публикуются semantic-события. */
  readonly eventBus: IEventBus;
  /**
   * Canonical-генератор metadata.
   *
   * @remarks
   * Semantic-событие — СЛЕДСТВИЕ raw-наблюдения, поэтому его metadata
   * создаётся через `nextChild(rawMessage.metadata)`, а не `nextRoot()`:
   * causal chain от внешнего наблюдения до реакции обязана сохраняться.
   */
  readonly metadataGenerator: MessageMetadataGenerator;
  /** Логгер (будет обёрнут в child с component-контекстом). */
  readonly logger: ILogger;
}

/**
 * Источник наблюдения RTDS-фида Binance через Polymarket.
 *
 * @remarks
 * Три отдельных источника, а не «один Chainlink с признаком TWAP»: raw-контур
 * (MR-B) уже развёл эти потоки в три разных `ExternalMessage`-типа именно
 * потому, что TWAP — источник РАСЧЁТА рынка, а не «ещё одна спот-цена».
 * Semantic-слой повторяет это различие 1:1.
 */
export const POLYMARKET_RTDS_BINANCE_SOURCE: MarketDataSourceId =
  asMarketDataSourceId('POLYMARKET_RTDS_BINANCE')!;

/** Источник наблюдения RTDS-фида Chainlink spot через Polymarket. */
export const POLYMARKET_RTDS_CHAINLINK_SOURCE: MarketDataSourceId =
  asMarketDataSourceId('POLYMARKET_RTDS_CHAINLINK')!;

/** Источник наблюдения settlement-фида Chainlink TWAP через Polymarket. */
export const POLYMARKET_RTDS_CHAINLINK_TWAP_SOURCE: MarketDataSourceId =
  asMarketDataSourceId('POLYMARKET_RTDS_CHAINLINK_TWAP')!;

/**
 * Vendor-домен окон усреднения TWAP официального SDK.
 *
 * @remarks
 * Дублирует `CryptoPricesChainlinkTwapWindowSeconds` в рантайме: тип
 * действует на компиляции, а окно приходит по проводу. Расширение домена
 * vendor-ом раньше нашего кода не должно молча смешивать ряды разных окон.
 */
const SUPPORTED_TWAP_WINDOWS: ReadonlySet<number> = new Set([30, 60]);

/**
 * Ценовые метрики стакана рынка предсказаний.
 *
 * @remarks
 * Фабрика домена связывается ОДИН раз: `Orderbook` — структура и своего
 * ценового домена не знает.
 */
const PREDICTION_PRICING = bookPricing(OutcomePriceService.create);

/** Read-only диагностика адаптера. */
export interface PolymarketSemanticAdapterStats {
  /** Всего raw-сообщений, доставленных адаптеру. */
  readonly rawMessagesSeen: number;
  /** Получено authoritative-снапшотов `book`. */
  readonly booksReceived: number;
  /** Опубликовано canonical-снапшотов стакана (`BOOK_DEPTH`). */
  readonly booksPublished: number;
  /** Получено событий `price_change`. */
  readonly priceChangesReceived: number;
  /** Изменений, успешно применённых к реконструкции (по инструментам). */
  readonly priceChangesApplied: number;
  /** Дельт, пришедших до первого `book` по инструменту. */
  readonly deltaBeforeSnapshot: number;
  /** Обнаружено расхождений с объявленной источником верхушкой. */
  readonly desyncs: number;
  /** Восстановлений из DESYNC новым authoritative `book`. */
  readonly resyncs: number;
  /** Получено событий `last_trade_price`. */
  readonly tradesReceived: number;
  /** Опубликовано `TRADE_RECEIVED`. */
  readonly tradesPublished: number;
  /** Трейдов, пропущенных из-за отсутствия размера у источника. */
  readonly tradesMissingSize: number;
  /** Опубликовано `TICK_SIZE_CHANGED`. */
  readonly tickSizeChanges: number;
  /** Опубликовано референсных наблюдений Binance. */
  readonly referenceBinance: number;
  /** Опубликовано референсных наблюдений Chainlink spot. */
  readonly referenceChainlink: number;
  /** Опубликовано референсных наблюдений Chainlink TWAP. */
  readonly referenceTwap: number;
  /** Raw-сообщений, отброшенных из-за непригодного payload. */
  readonly invalidPayloads: number;
  /** Неизвестных SDK event-типов внутри `POLYMARKET_MARKET`. */
  readonly unknownMarketEvents: number;
  /** Отказов Application EventBus при публикации semantic-события. */
  readonly semanticPublishFailures: number;
  /** Наблюдений с vendor-временем «назад» относительно предыдущего. */
  readonly backwardVendorTimestamps: number;
  /** Публикаций, где утверждение источника о верхушке истолковать не удалось. */
  readonly unverifiedBestClaims: number;
  /** Инструментов в реконструкции сейчас. */
  readonly activeBookStates: number;
  /** Из них в состоянии DESYNCED сейчас. */
  readonly desyncedBookStates: number;
}

/** Изменения одного токена внутри одного raw `price_change`. */
interface TokenDeltaBatch {
  /** Все изменения токена в порядке следования в событии. */
  readonly deltas: LevelDeltaInput[];
  /** Лучшие цены из ПОСЛЕДНЕГО изменения токена (итоговое утверждение). */
  best: VendorBestPrices;
}

/** Последняя ОПУБЛИКОВАННАЯ верхушка инструмента (для detect-change). */
interface PublishedTop {
  readonly bidPrice: string | undefined;
  readonly bidSize: string | undefined;
  readonly askPrice: string | undefined;
  readonly askSize: string | undefined;
}

/**
 * Адаптер, превращающий raw-наблюдения Polymarket в canonical-события.
 *
 * @remarks
 * Полное описание архитектурной роли и границ — см. докблок модуля выше.
 *
 * @example
 * ```typescript
 * const adapter = new PolymarketSemanticAdapter({
 *   bus,              // общий raw ExternalMessageBus
 *   eventBus,         // Application EventBus (создаёт composition root)
 *   metadataGenerator,
 *   logger,
 * });
 * adapter.start();
 * // ...
 * adapter.close(); // снимает ТОЛЬКО свои подписки, шину не трогает
 * ```
 */
export class PolymarketSemanticAdapter {
  private readonly _bus: PolymarketSemanticBusSubscription;
  private readonly _eventBus: IEventBus;
  private readonly _metadata: MessageMetadataGenerator;
  private readonly _logger: ILogger;

  private readonly _state = new OrderbookReconstructionState();
  /** Последняя опубликованная верхушка по инструменту. */
  private readonly _publishedTops = new Map<InstrumentId, PublishedTop>();
  /** Максимальное vendor-время, замеченное по инструменту (диагностика). */
  private readonly _lastVendorTimestampMs = new Map<InstrumentId, number>();
  /**
   * Рынок каждого ВИДЕННОГО инструмента.
   *
   * @remarks
   * Отдельно от индекса реконструкции: тот знает только инструменты со
   * стаканом, а диагностика копится и по тем, у кого были ТОЛЬКО трейды
   * или смена шага цены. Без этой связи `forgetMarket` не смог бы вычистить
   * их записи, и они жили бы до конца процесса.
   */
  private readonly _instrumentMarket = new Map<InstrumentId, MarketId>();

  private _disposers: (() => void)[] = [];
  private _started = false;

  private _rawMessagesSeen = 0;
  private _booksReceived = 0;
  private _booksPublished = 0;
  private _priceChangesReceived = 0;
  private _priceChangesApplied = 0;
  private _deltaBeforeSnapshot = 0;
  private _desyncs = 0;
  private _resyncs = 0;
  private _tradesReceived = 0;
  private _tradesPublished = 0;
  private _tradesMissingSize = 0;
  private _tickSizeChanges = 0;
  private _referenceBinance = 0;
  private _referenceChainlink = 0;
  private _referenceTwap = 0;
  private _invalidPayloads = 0;
  private _unknownMarketEvents = 0;
  private _semanticPublishFailures = 0;
  private _backwardVendorTimestamps = 0;
  private _unverifiedBestClaims = 0;

  /**
   * Создаёт адаптер поверх общего raw-bus и Application EventBus.
   *
   * @param deps - Зависимости (см. {@link PolymarketSemanticAdapterDependencies})
   */
  constructor(deps: PolymarketSemanticAdapterDependencies) {
    this._bus = deps.bus;
    this._eventBus = deps.eventBus;
    this._metadata = deps.metadataGenerator;
    this._logger = deps.logger.child({ component: 'PolymarketSemanticAdapter' });
  }

  /**
   * Подписывается на relevant-сообщения общего raw-bus.
   *
   * @remarks
   * Идемпотентен: повторный вызов при активной подписке НИЧЕГО не делает и
   * пишет warn — двойная подписка означала бы двойную публикацию каждого
   * semantic-события.
   *
   * Подписки строго typed: адаптер видит ТОЛЬКО четыре Polymarket-канала и
   * не влияет на остальных потребителей шины (раздача веерная).
   *
   * @example
   * ```typescript
   * adapter.start();
   * ```
   */
  public start(): void {
    if (this._started) {
      this._logger.warn('Semantic adapter already started, ignoring repeated start');
      return;
    }
    this._started = true;
    this._disposers = [
      this._bus.subscribe('POLYMARKET_MARKET', async (message) => {
        this._rawMessagesSeen++;
        await this._onMarketEvent(message.payload, message.metadata);
      }),
      this._bus.subscribe('POLYMARKET_CRYPTO_BINANCE', async (message) => {
        this._rawMessagesSeen++;
        await this._onReferencePrice(
          POLYMARKET_RTDS_BINANCE_SOURCE,
          message.payload.payload,
          { kind: 'SPOT' },
          message.metadata,
        );
      }),
      this._bus.subscribe('POLYMARKET_CRYPTO_CHAINLINK', async (message) => {
        this._rawMessagesSeen++;
        await this._onReferencePrice(
          POLYMARKET_RTDS_CHAINLINK_SOURCE,
          message.payload.payload,
          { kind: 'SPOT' },
          message.metadata,
        );
      }),
      this._bus.subscribe('POLYMARKET_CRYPTO_CHAINLINK_TWAP', async (message) => {
        this._rawMessagesSeen++;
        // Окно — часть ИДЕНТИЧНОСТИ потока, а не атрибут значения: наблюдение
        // с неизвестным окном нельзя опубликовать «как TWAP вообще», иначе
        // ряды разных окон смешаются в один. Тип обещает 30|60, но приходит
        // это по проводу — проверяем в рантайме.
        const windowSeconds = message.payload.payload.windowSeconds;
        if (!SUPPORTED_TWAP_WINDOWS.has(windowSeconds)) {
          this._invalidPayloads++;
          this._logger.warn('Rejected Chainlink TWAP observation with unsupported window', {
            symbol: message.payload.payload.symbol,
            windowSeconds: String(windowSeconds),
          });
          return;
        }
        await this._onReferencePrice(
          POLYMARKET_RTDS_CHAINLINK_TWAP_SOURCE,
          message.payload.payload,
          { kind: 'TWAP', windowSeconds },
          message.metadata,
        );
      }),
    ];
    this._logger.info('Polymarket semantic adapter started');
  }

  /**
   * Снимает СВОИ подписки и освобождает состояние реконструкции.
   *
   * @remarks
   * Идемпотентен. Общий raw-bus НЕ закрывается: им владеет composition root,
   * и recorder (как и любой другой потребитель) обязан продолжить работу.
   * После `close()` ни одно новое raw-сообщение не порождает semantic-выход.
   *
   * @example
   * ```typescript
   * adapter.close();
   * adapter.close(); // безопасно
   * ```
   */
  public close(): void {
    for (const dispose of this._disposers) {
      dispose();
    }
    this._disposers = [];
    this._started = false;
    this._state.clear();
    this._publishedTops.clear();
    this._lastVendorTimestampMs.clear();
    this._instrumentMarket.clear();
    this._logger.info('Polymarket semantic adapter closed');
  }

  /**
   * Забывает всё состояние ОДНОГО инструмента.
   *
   * @param instrumentId - Токен/инструмент
   * @returns `true`, если состояние существовало
   *
   * @remarks
   * Явная граница памяти. Адаптер СПЕЦИАЛЬНО не подписан на события
   * жизненного цикла сбора: связав его с ними, мы сделали бы semantic-слой
   * collection-specific, а он обязан одинаково работать и для live-торговли,
   * и для будущего replay. Момент «этот рынок больше не нужен» знает
   * владелец, он и вызывает cleanup.
   *
   * @example
   * ```typescript
   * adapter.forgetInstrument(tokenId);
   * ```
   */
  public forgetInstrument(instrumentId: InstrumentId): boolean {
    this._publishedTops.delete(instrumentId);
    this._lastVendorTimestampMs.delete(instrumentId);
    this._instrumentMarket.delete(instrumentId);
    return this._state.forgetInstrument(instrumentId);
  }

  /**
   * Забывает состояние ВСЕХ инструментов рынка.
   *
   * @param marketId - Рынок (condition_id)
   * @returns Число забытых инструментов
   *
   * @example
   * ```typescript
   * adapter.forgetMarket(marketId); // → 2 (UP + DOWN)
   * ```
   */
  public forgetMarket(marketId: MarketId): number {
    const forgotten = this._state.forgetMarket(marketId);
    for (const instrumentId of forgotten) {
      this._publishedTops.delete(instrumentId);
      this._lastVendorTimestampMs.delete(instrumentId);
      this._instrumentMarket.delete(instrumentId);
    }
    // Инструменты рынка, у которых стакана не было вовсе (только трейды или
    // смена шага цены), в реконструкции не числятся — их диагностику надо
    // вычистить отдельно, иначе она переживёт рынок
    for (const [instrumentId, market] of this._instrumentMarket) {
      if (market !== marketId) continue;
      this._publishedTops.delete(instrumentId);
      this._lastVendorTimestampMs.delete(instrumentId);
      this._instrumentMarket.delete(instrumentId);
    }
    return forgotten.length;
  }

  /**
   * Снимок диагностики адаптера.
   *
   * @returns Read-only счётчики (см. {@link PolymarketSemanticAdapterStats})
   *
   * @example
   * ```typescript
   * const stats = adapter.getStats();
   * console.log(stats.booksPublished, stats.desyncs);
   * ```
   */
  public getStats(): PolymarketSemanticAdapterStats {
    const reconstruction = this._state.getStats();
    return {
      rawMessagesSeen: this._rawMessagesSeen,
      booksReceived: this._booksReceived,
      booksPublished: this._booksPublished,
      priceChangesReceived: this._priceChangesReceived,
      priceChangesApplied: this._priceChangesApplied,
      deltaBeforeSnapshot: this._deltaBeforeSnapshot,
      desyncs: this._desyncs,
      resyncs: this._resyncs,
      tradesReceived: this._tradesReceived,
      tradesPublished: this._tradesPublished,
      tradesMissingSize: this._tradesMissingSize,
      tickSizeChanges: this._tickSizeChanges,
      referenceBinance: this._referenceBinance,
      referenceChainlink: this._referenceChainlink,
      referenceTwap: this._referenceTwap,
      invalidPayloads: this._invalidPayloads,
      unknownMarketEvents: this._unknownMarketEvents,
      semanticPublishFailures: this._semanticPublishFailures,
      backwardVendorTimestamps: this._backwardVendorTimestamps,
      unverifiedBestClaims: this._unverifiedBestClaims,
      activeBookStates: reconstruction.activeInstruments,
      desyncedBookStates: reconstruction.desyncedInstruments,
    };
  }

  /**
   * Маршрутизирует событие CLOB market channel по его SDK-типу.
   *
   * @param event - Payload наблюдения (`StandardMarketEvent` официального SDK)
   * @param parent - Metadata raw-наблюдения (родитель causal chain)
   *
   * @remarks
   * Неизвестный тип НЕ роняет обработчик шины: он считается диагностикой и
   * пропускается — сырое сообщение всё равно уже записано recorder-ом.
   */
  private async _onMarketEvent(
    event: PolymarketMarketEventPayload,
    parent: MessageMetadata,
  ): Promise<void> {
    switch (event.type) {
      case 'book':
        await this._onBook(event.payload, parent);
        return;
      case 'price_change':
        await this._onPriceChange(event.payload, parent);
        return;
      case 'last_trade_price':
        await this._onLastTradePrice(event.payload, parent);
        return;
      case 'tick_size_change':
        await this._onTickSizeChange(event.payload, parent);
        return;
      default:
        this._unknownMarketEvents++;
        this._logger.debug('Unknown Polymarket market event type, skipping', {
          eventType: String((event as { type?: unknown }).type),
        });
    }
  }

  /**
   * Обрабатывает authoritative-снапшот стакана.
   *
   * @param payload - Payload SDK-события `book`
   * @param parent - Metadata raw-наблюдения
   *
   * @remarks
   * Снапшот ПОЛНОСТЬЮ замещает состояние инструмента и снимает DESYNC.
   * Публикуется `BOOK_DEPTH` (всегда) и `BOOK_UPDATED` (если верхушка
   * изменилась) — оба как children одного raw-наблюдения.
   */
  private async _onBook(
    payload: PolymarketBookPayload,
    parent: MessageMetadata,
  ): Promise<void> {
    this._booksReceived++;

    const identity = this._resolveIdentity(payload.market, payload.tokenId);
    if (identity === undefined) {
      return;
    }
    const wasDesynced = this._state.isDesynced(identity.instrumentId);
    const receivedAt = parent.createdAt;
    const venueTimestamp = this._toVenueTimestamp(payload.timestamp, identity.instrumentId);

    const outcome = this._state.applySnapshot(
      identity.instrumentId,
      identity.marketId,
      payload.bids.map((level) => ({ price: String(level.price), size: String(level.size) })),
      payload.asks.map((level) => ({ price: String(level.price), size: String(level.size) })),
      receivedAt,
      venueTimestamp,
    );

    if (!outcome.ok) {
      this._invalidPayloads++;
      this._logger.warn('Rejected Polymarket book snapshot, previous state kept', {
        instrumentId: String(identity.instrumentId),
        reason: outcome.reason,
        detail: outcome.detail ?? '',
      });
      return;
    }

    if (wasDesynced) {
      this._resyncs++;
      this._logger.info('Orderbook resynchronized by authoritative snapshot', {
        instrumentId: String(identity.instrumentId),
      });
    }

    await this._publishBook(identity, outcome.book, outcome.version, venueTimestamp, receivedAt, parent);
  }

  /**
   * Обрабатывает пачку изменений уровней (`price_change`).
   *
   * @param payload - Payload SDK-события `price_change`
   * @param parent - Metadata raw-наблюдения
   *
   * @remarks
   * Одно raw-событие может нести изменения НЕСКОЛЬКИХ токенов. Изменения
   * группируются по токену, применяются пачкой и лишь ПОСЛЕ полного
   * применения публикуется по одному итоговому снапшоту на затронутый
   * инструмент — промежуточная полуприменённая книга наружу не выходит.
   *
   * `price_change` — это изменение КНИГИ, а не сделка: `TRADE_RECEIVED`
   * отсюда не публикуется ни при каких условиях.
   */
  private async _onPriceChange(
    payload: PolymarketPriceChangePayload,
    parent: MessageMetadata,
  ): Promise<void> {
    this._priceChangesReceived++;

    const marketId = asMarketId(payload.market);
    if (marketId === undefined) {
      this._invalidPayloads++;
      this._logger.warn('Rejected Polymarket price_change with invalid market id');
      return;
    }
    const receivedAt = parent.createdAt;

    // Группировка по токену: применяем ВСЕ изменения токена и только потом
    // публикуем его итоговое состояние
    const batches = new Map<InstrumentId, TokenDeltaBatch>();
    for (const change of payload.priceChanges) {
      const instrumentId = asInstrumentId(String(change.tokenId));
      if (instrumentId === undefined) {
        this._invalidPayloads++;
        this._logger.warn('Rejected Polymarket price change with invalid token id');
        continue;
      }
      const side = toBookSide(change.side);
      if (side === undefined) {
        this._invalidPayloads++;
        this._logger.warn('Rejected Polymarket price change with unknown side', {
          instrumentId: String(instrumentId),
        });
        continue;
      }
      const best: VendorBestPrices = {
        bestBid: change.bestBid ?? undefined,
        bestAsk: change.bestAsk ?? undefined,
      };
      const existing = batches.get(instrumentId);
      if (existing === undefined) {
        batches.set(instrumentId, {
          deltas: [{ side, price: String(change.price), size: String(change.size) }],
          best,
        });
      } else {
        existing.deltas.push({ side, price: String(change.price), size: String(change.size) });
        // Итоговым считается утверждение ПОСЛЕДНЕГО изменения токена
        existing.best = best;
      }
    }

    const venueTimestamp = this._toVenueTimestamp(payload.timestamp, undefined);

    for (const [instrumentId, batch] of batches) {
      const outcome = this._state.applyDeltas(
        instrumentId,
        batch.deltas,
        batch.best,
        receivedAt,
        venueTimestamp,
      );
      if (!outcome.ok) {
        this._onApplyFailure(instrumentId, outcome.reason, outcome.detail);
        continue;
      }
      this._priceChangesApplied++;
      if (outcome.unverifiedBest !== undefined) {
        // Дельта применена, но утверждение источника о верхушке истолковать
        // не удалось — публикуем, однако «не проверили» не должно выглядеть
        // в диагностике как «проверили»
        this._unverifiedBestClaims++;
        this._logger.debug('Book published without top-of-book verification', {
          instrumentId: String(instrumentId),
          detail: outcome.unverifiedBest,
        });
      }
      await this._publishBook(
        { marketId, instrumentId },
        outcome.book,
        outcome.version,
        venueTimestamp,
        receivedAt,
        parent,
      );
    }
  }

  /**
   * Учитывает неуспешное применение дельт и логирует по severity.
   *
   * @param instrumentId - Токен/инструмент
   * @param reason - Причина отказа
   * @param detail - Деталь для structured-лога
   */
  private _onApplyFailure(
    instrumentId: InstrumentId,
    reason: 'NO_SNAPSHOT' | 'DESYNCED' | 'INVALID_LEVEL' | 'DESYNC_DETECTED',
    detail: string | undefined,
  ): void {
    switch (reason) {
      case 'NO_SNAPSHOT':
        // Книга ещё не инициализирована: частичный стакан строить нельзя —
        // отсутствие уровня в дельте НЕ означает его отсутствия на venue
        this._deltaBeforeSnapshot++;
        this._logger.debug('Delta before initial snapshot, waiting for authoritative book', {
          instrumentId: String(instrumentId),
        });
        return;
      case 'DESYNCED':
        // Уже помечен рассинхронизированным — молча ждём следующий `book`
        this._logger.debug('Delta skipped for desynced instrument', {
          instrumentId: String(instrumentId),
        });
        return;
      case 'DESYNC_DETECTED':
        this._desyncs++;
        this._logger.warn('Orderbook desync detected, publication paused until next book', {
          instrumentId: String(instrumentId),
          detail: detail ?? '',
        });
        return;
      case 'INVALID_LEVEL':
      default:
        this._invalidPayloads++;
        this._logger.warn('Rejected Polymarket price change level, book state unchanged', {
          instrumentId: String(instrumentId),
          detail: detail ?? '',
        });
    }
  }

  /**
   * Публикует canonical-события стакана как children raw-наблюдения.
   *
   * @param identity - Рынок и инструмент
   * @param book - Новый иммутабельный стакан
   * @param version - Semantic-версия книги инструмента
   * @param venueTimestamp - Время venue (если известно)
   * @param receivedAt - Время получения наблюдения
   * @param parent - Metadata raw-наблюдения
   *
   * @remarks
   * `BOOK_DEPTH` публикуется на КАЖДОЕ успешно применённое обновление —
   * его контракт несёт полную книгу, и глубина меняется даже когда верхушка
   * осталась прежней.
   *
   * `BOOK_UPDATED` публикуется ТОЛЬКО при изменении верхушки: его
   * документированный контракт — «каждое изменение лучшей цены стакана», и
   * событие несёт `TopOfBook`. Публиковать его на чисто глубинную правку
   * значило бы слать подписчикам событие «верхушка изменилась», когда она
   * не изменилась.
   *
   * Односторонняя/пустая книга допустима: `TopOfBook` представляет
   * отсутствующую сторону как `undefined`, поэтому уровни НЕ выдумываются.
   */
  private async _publishBook(
    identity: { readonly marketId: MarketId; readonly instrumentId: InstrumentId },
    book: Orderbook,
    version: number,
    venueTimestamp: Timestamp | undefined,
    receivedAt: Timestamp,
    parent: MessageMetadata,
  ): Promise<void> {
    const timestamp = venueTimestamp ?? receivedAt;

    const depthPublished = await this._publish({
      type: 'BOOK_DEPTH',
      payload: { instrumentId: identity.instrumentId, snapshot: book, timestamp },
      metadata: this._metadata.nextChild(parent),
    });
    if (depthPublished) {
      this._booksPublished++;
    }

    const topOfBook = buildTopOfBook(book);
    const fingerprint = fingerprintTop(topOfBook);
    const previous = this._publishedTops.get(identity.instrumentId);
    if (previous !== undefined && sameTop(previous, fingerprint)) {
      return;
    }

    const topPublished = await this._publish({
      type: 'BOOK_UPDATED',
      payload: {
        topOfBook,
        instrumentId: identity.instrumentId,
        marketId: identity.marketId,
        // Per-instrument semantic-версия, а не sequence шины: глобальная
        // последовательность содержит чужие токены/RTDS/CEX и у одного
        // инструмента имеет естественные «дыры», неотличимые от потерь
        sequenceNumber: version,
        timestamp,
      },
      metadata: this._metadata.nextChild(parent),
    });
    // Отпечаток запоминается ТОЛЬКО после успешной публикации: иначе
    // отвергнутое шиной событие «зачлось» бы как опубликованное, и
    // следующее обновление с той же верхушкой подписчики не увидели бы
    // никогда — гашение дубликатов превратилось бы в потерю данных
    if (topPublished) {
      this._publishedTops.set(identity.instrumentId, fingerprint);
    }
  }

  /**
   * Обрабатывает публичный маркет-принт (`last_trade_price`).
   *
   * @param payload - Payload SDK-события `last_trade_price`
   * @param parent - Metadata raw-наблюдения
   *
   * @remarks
   * ### Идентичность сделки
   *
   * `transactionHash` источника переносится в `venueTradeId` КАК ЕСТЬ.
   * Замер на записанном архиве (37 407 трейдов, 51 рынок, 29 часов,
   * 2026-08-25/26) дал 37 407 различных хешей: хеш уникален на сделку даже
   * когда в одну миллисекунду проходит до 8 сделок. Поэтому синтетический
   * ключ не нужен — и не строится: vendor не прислал хеш → поле остаётся
   * `undefined`, потому что фальшивый id молча склеил бы разные сделки.
   *
   * ### Почему НЕ `Trade` entity
   *
   * `Trade` — Domain-сущность с обязательными `VenueTradeId`/`VenueId`; её
   * место в ленте (`TradeTape`), а не на границе наблюдения. Адаптер
   * публикует НАБЛЮДЕНИЕ со всеми полями, нужными для построения `Trade`
   * (включая настоящий id и marketId), а собирает сущность потребитель,
   * которому она нужна. Так граница не тянет за собой сборку агрегатов.
   *
   * ### Отсутствующий размер
   *
   * `size` в SDK-контракте опционален. Событие `TRADE_RECEIVED` требует
   * `Quantity`, а выдумывать объём (`0`/`1`) запрещено — такой трейд
   * пропускается со счётчиком; raw-сообщение уже сохранено recorder-ом,
   * поэтому данные не теряются.
   */
  private async _onLastTradePrice(
    payload: PolymarketLastTradePricePayload,
    parent: MessageMetadata,
  ): Promise<void> {
    this._tradesReceived++;

    const identity = this._resolveIdentity(payload.market, payload.tokenId);
    if (identity === undefined) {
      return;
    }
    const { instrumentId, marketId } = identity;

    const rawSize = payload.size ?? undefined;
    if (rawSize === undefined) {
      this._tradesMissingSize++;
      this._logger.debug('Polymarket trade without size, semantic trade skipped', {
        instrumentId: String(instrumentId),
      });
      return;
    }

    const price = this._parsePrice(payload.price, 'trade price', instrumentId);
    if (price === undefined) return;

    const sizeResult = QuantityService.create(String(rawSize));
    if (!sizeResult.ok) {
      this._invalidPayloads++;
      this._logger.warn('Rejected Polymarket trade with invalid size', {
        instrumentId: String(instrumentId),
      });
      return;
    }
    const size: Quantity = sizeResult.value;

    const side = toTradeSide(payload.side);
    if (side === undefined) {
      this._invalidPayloads++;
      this._logger.warn('Rejected Polymarket trade with unknown side', {
        instrumentId: String(instrumentId),
      });
      return;
    }

    const timestamp =
      this._toVenueTimestamp(payload.timestamp, instrumentId) ?? parent.createdAt;

    // Идентификатор берётся у источника КАК ЕСТЬ; отсутствие остаётся
    // отсутствием — синтезировать id из других полей запрещено
    const rawTradeId = payload.transactionHash ?? undefined;
    const venueTradeId = rawTradeId === undefined ? undefined : asVenueTradeId(rawTradeId);
    if (rawTradeId !== undefined && venueTradeId === undefined) {
      this._invalidPayloads++;
      this._logger.warn('Polymarket trade carries unusable transaction hash, publishing without id', {
        instrumentId: String(instrumentId),
      });
    }

    const published = await this._publish({
      type: 'TRADE_RECEIVED',
      payload: { instrumentId, marketId, venueTradeId, price, size, side, timestamp },
      metadata: this._metadata.nextChild(parent),
    });
    if (published) {
      this._tradesPublished++;
    }
  }

  /**
   * Обрабатывает смену шага цены инструмента.
   *
   * @param payload - Payload SDK-события `tick_size_change`
   * @param parent - Metadata raw-наблюдения
   *
   * @remarks
   * Tick size — вход последующего execution (по старому шагу venue отвергнет
   * ордер), поэтому событие не игнорируется. `oldTickSize` опционален в
   * SDK-контракте: если venue не сообщил прежний шаг, поле остаётся
   * `undefined`, а не выдумывается.
   */
  private async _onTickSizeChange(
    payload: PolymarketTickSizeChangePayload,
    parent: MessageMetadata,
  ): Promise<void> {
    const identity = this._resolveIdentity(payload.market, payload.tokenId);
    if (identity === undefined) {
      return;
    }

    const newTickSize = this._parsePrice(
      payload.newTickSize,
      'new tick size',
      identity.instrumentId,
    );
    if (newTickSize === undefined) return;

    let oldTickSize: OutcomePrice | undefined;
    const rawOld = payload.oldTickSize ?? undefined;
    if (rawOld !== undefined) {
      const parsed = OutcomePriceService.create(String(rawOld));
      // Непарсящийся ПРЕЖНИЙ шаг не отменяет факта смены: публикуем без него
      oldTickSize = parsed.ok ? parsed.value : undefined;
    }

    const timestamp =
      this._toVenueTimestamp(payload.timestamp, identity.instrumentId) ?? parent.createdAt;

    const published = await this._publish({
      type: 'TICK_SIZE_CHANGED',
      payload: {
        marketId: identity.marketId,
        instrumentId: identity.instrumentId,
        oldTickSize,
        newTickSize,
        timestamp,
      },
      metadata: this._metadata.nextChild(parent),
    });
    if (published) {
      this._tickSizeChanges++;
    }
  }

  /**
   * Превращает RTDS-наблюдение в canonical `REFERENCE_PRICE_UPDATED`.
   *
   * @param sourceId - Источник наблюдения (Binance / Chainlink / Chainlink TWAP)
   * @param payload - Payload RTDS-события (`{ symbol, timestamp, value }`)
   * @param feed - Спот либо TWAP с окном усреднения
   * @param parent - Metadata raw-наблюдения
   *
   * @remarks
   * Значение идёт в `AssetPriceService`, а НЕ в `OutcomePrice`: цена базового
   * актива (`79341.36626633028`) не помещается в домен рынка предсказаний
   * `[0.0001, 0.9999]` — конструктор `OutcomePrice` обязан её отвергнуть.
   *
   * Символ разбирается в canonical-пару ЗДЕСЬ: наружу уходят
   * `baseAsset`/`quoteAsset`, а нативная форма — только как provenance.
   * Пропустив наружу один лишь vendor-символ, мы бы заставили Application
   * разбирать `btcusdt` и `btc/usd` самостоятельно, то есть просто
   * перенесли бы нормализацию за границу адаптера.
   *
   * Неразобранный символ — отказ, а не догадка: наблюдение без canonical
   * идентичности пары бесполезно downstream.
   */
  private async _onReferencePrice(
    sourceId: MarketDataSourceId,
    payload: PolymarketReferencePricePayload,
    feed: ReferencePriceFeed,
    parent: MessageMetadata,
  ): Promise<void> {
    const pair = parseAssetPair(payload.symbol);
    if (pair === undefined) {
      this._invalidPayloads++;
      this._logger.warn('Rejected reference price observation with unparseable symbol', {
        sourceId: String(sourceId),
        symbol: payload.symbol,
      });
      return;
    }

    const valueResult = AssetPriceService.create(String(payload.value));
    if (!valueResult.ok) {
      this._invalidPayloads++;
      this._logger.warn('Rejected reference price observation with invalid value', {
        sourceId: String(sourceId),
        symbol: payload.symbol,
      });
      return;
    }

    const venueTimestampResult = TimestampService.create(payload.timestamp);
    if (!venueTimestampResult.ok) {
      this._invalidPayloads++;
      this._logger.warn('Rejected reference price observation with invalid timestamp', {
        sourceId: String(sourceId),
        symbol: payload.symbol,
      });
      return;
    }

    const published = await this._publish({
      type: 'REFERENCE_PRICE_UPDATED',
      payload: {
        sourceId,
        baseAsset: pair.baseAsset,
        quoteAsset: pair.quoteAsset,
        nativeSymbol: payload.symbol,
        feed,
        value: valueResult.value,
        venueTimestamp: venueTimestampResult.value,
        receivedAt: parent.createdAt,
      },
      metadata: this._metadata.nextChild(parent),
    });
    if (!published) {
      return;
    }
    if (sourceId === POLYMARKET_RTDS_BINANCE_SOURCE) {
      this._referenceBinance++;
    } else if (sourceId === POLYMARKET_RTDS_CHAINLINK_SOURCE) {
      this._referenceChainlink++;
    } else {
      this._referenceTwap++;
    }
  }

  /**
   * Валидирует пару (рынок, инструмент) из payload наблюдения.
   *
   * @param market - Идентификатор рынка (condition_id) из payload
   * @param tokenId - Идентификатор токена из payload
   * @returns Типизированная пара либо `undefined`, если идентификаторы
   *   непригодны (счётчик `invalidPayloads` уже увеличен)
   */
  private _resolveIdentity(
    market: string,
    tokenId: string,
  ): { readonly marketId: MarketId; readonly instrumentId: InstrumentId } | undefined {
    const marketId = asMarketId(market);
    const instrumentId = asInstrumentId(String(tokenId));
    if (marketId === undefined || instrumentId === undefined) {
      this._invalidPayloads++;
      this._logger.warn('Rejected Polymarket market event with invalid identifiers');
      return undefined;
    }
    this._instrumentMarket.set(instrumentId, marketId);
    return { marketId, instrumentId };
  }

  /**
   * Парсит цену рынка предсказаний из десятичной строки источника.
   *
   * @param raw - Десятичная строка vendor-а
   * @param field - Имя поля для structured-лога
   * @param instrumentId - Инструмент (для контекста лога)
   * @returns `OutcomePrice` VO либо `undefined` (счётчик `invalidPayloads` увеличен)
   */
  private _parsePrice(
    raw: string,
    field: string,
    instrumentId: InstrumentId,
  ): OutcomePrice | undefined {
    const result = OutcomePriceService.create(String(raw));
    if (result.ok) {
      return result.value;
    }
    this._invalidPayloads++;
    this._logger.warn('Rejected Polymarket value outside prediction price domain', {
      instrumentId: String(instrumentId),
      field,
    });
    return undefined;
  }

  /**
   * Превращает vendor-время наблюдения в `Timestamp` и следит за монотонностью.
   *
   * @param raw - Время из payload источника (epoch ms) либо `null`/`undefined`
   * @param instrumentId - Инструмент для учёта «времени назад» (или `undefined`,
   *   если событие относится сразу к нескольким инструментам)
   * @returns `Timestamp` venue либо `undefined`, если источник времени не прислал
   *
   * @remarks
   * Vendor-время НЕ подменяется локальным: `receivedAt` берётся из metadata
   * наблюдения отдельно, и смешивать их нельзя — их разность и есть задержка
   * доставки. `Date.now()` здесь не вызывается вовсе.
   *
   * Порядок обработки задаёт шина; наблюдение с временем «назад» только
   * считается диагностикой и НЕ переупорядочивается.
   */
  private _toVenueTimestamp(
    raw: number | null | undefined,
    instrumentId: InstrumentId | undefined,
  ): Timestamp | undefined {
    if (raw === null || raw === undefined) {
      return undefined;
    }
    const result = TimestampService.create(raw);
    if (!result.ok) {
      this._invalidPayloads++;
      this._logger.warn('Rejected Polymarket venue timestamp', {
        instrumentId: instrumentId === undefined ? '' : String(instrumentId),
      });
      return undefined;
    }
    if (instrumentId !== undefined) {
      const previous = this._lastVendorTimestampMs.get(instrumentId);
      const current = result.value.toNumber();
      if (previous !== undefined && current < previous) {
        this._backwardVendorTimestamps++;
      } else {
        this._lastVendorTimestampMs.set(instrumentId, current);
      }
    }
    return result.value;
  }

  /**
   * Публикует semantic-событие в Application EventBus.
   *
   * @param event - Готовое canonical-событие
   * @returns `true`, если публикация удалась
   *
   * @remarks
   * `IEventBus.publish` возвращает `Result` и не бросает на operational-
   * ошибках; отказ учитывается счётчиком и логируется, но НЕ прерывает
   * обработку raw-сообщения и тем более не роняет шину — запись сырых
   * данных обязана продолжаться.
   */
  private async _publish(event: Parameters<IEventBus['publish']>[0]): Promise<boolean> {
    const result = await this._eventBus.publish(event);
    if (result.ok) {
      return true;
    }
    this._semanticPublishFailures++;
    this._logger.error('Failed to publish semantic event', {
      eventType: event.type,
      error: result.error.message,
    });
    return false;
  }
}

/**
 * Отображает vendor-сторону изменения книги в сторону стакана.
 *
 * @param side - `OrderSide` официального SDK
 * @returns Сторона книги либо `undefined` для неизвестного значения
 *
 * @remarks
 * Vendor-семантика Polymarket: `BUY` — заявка на покупку, то есть уровень
 * стороны BID; `SELL` — стороны ASK. Никакой инверсии по предположениям о
 * maker/taker здесь нет и быть не должно.
 */
function toBookSide(side: OrderSide): BookSide | undefined {
  const raw: string = side;
  if (raw === 'BUY') return 'BID';
  if (raw === 'SELL') return 'ASK';
  return undefined;
}

/**
 * Отображает vendor-сторону сделки в canonical `Side`.
 *
 * @param side - `OrderSide` официального SDK
 * @returns `Side` либо `undefined` для неизвестного значения
 *
 * @remarks
 * Сохраняется ФАКТИЧЕСКАЯ семантика источника: `BUY` остаётся `BUY`.
 * Инвертировать сторону «потому что maker/taker» без доказательства
 * запрещено — это молча исказило бы всю ленту.
 */
function toTradeSide(side: OrderSide): Side | undefined {
  const raw: string = side;
  if (raw === 'BUY') return 'BUY';
  if (raw === 'SELL') return 'SELL';
  return undefined;
}

/**
 * Строит `TopOfBook` из canonical-стакана.
 *
 * @param book - Иммутабельный стакан
 * @returns Верхушка стакана; отсутствующая сторона представлена `undefined`
 *
 * @remarks
 * Уровни НЕ выдумываются: односторонняя и пустая книга — валидные состояния
 * полной глубины, и подставлять `0`/`1` ради «полноты» `TopOfBook`
 * запрещено. Спред считается через `bookPricing`, который сам отсеивает
 * пустую/одностороннюю/скрещенную книгу.
 */
function buildTopOfBook(book: Orderbook): TopOfBook {
  let spread: OutcomePrice | undefined;
  const spreadResult = PREDICTION_PRICING.spread(book);
  if (spreadResult.ok) {
    const priceResult = OutcomePriceService.create(spreadResult.value.width());
    if (priceResult.ok) spread = priceResult.value;
  }
  return {
    bestBid: book.getBestBid() ?? undefined,
    bestAsk: book.getBestAsk() ?? undefined,
    spread,
    bestBidSize: book.bids[0]?.quantity,
    bestAskSize: book.asks[0]?.quantity,
  };
}

/**
 * Строит сравнимый отпечаток верхушки стакана.
 *
 * @param top - Верхушка стакана
 * @returns Каноничные десятичные строки лучших цен и размеров
 *
 * @remarks
 * Сравнение идёт по КАНОНИЧЕСКОЙ `Decimal`-строке, а не по исходной строке
 * источника: `"0.50"` и `"0.5"` — одна и та же цена, и считать это
 * изменением верхушки было бы ложным событием.
 */
function fingerprintTop(top: TopOfBook): PublishedTop {
  return {
    bidPrice: top.bestBid?.value().toString(),
    bidSize: top.bestBidSize?.value().toString(),
    askPrice: top.bestAsk?.value().toString(),
    askSize: top.bestAskSize?.value().toString(),
  };
}

/**
 * Сравнивает два отпечатка верхушки.
 *
 * @param a - Предыдущий отпечаток
 * @param b - Текущий отпечаток
 * @returns `true`, если верхушка не изменилась
 */
function sameTop(a: PublishedTop, b: PublishedTop): boolean {
  return (
    a.bidPrice === b.bidPrice &&
    a.bidSize === b.bidSize &&
    a.askPrice === b.askPrice &&
    a.askSize === b.askSize
  );
}

/**
 * Payload наблюдения CLOB market channel.
 *
 * @remarks
 * Выведен из фактического union `PolymarketExternalMessage`, а не написан
 * руками: любое изменение SDK-контракта немедленно проявится ошибкой
 * компиляции здесь, а не расхождением в рантайме.
 */
type PolymarketMarketEventPayload = Extract<
  PolymarketExternalMessage,
  { type: 'POLYMARKET_MARKET' }
>['payload'];

/** Payload SDK-события `book`. */
type PolymarketBookPayload = Extract<
  PolymarketMarketEventPayload,
  { type: 'book' }
>['payload'];

/** Payload SDK-события `price_change`. */
type PolymarketPriceChangePayload = Extract<
  PolymarketMarketEventPayload,
  { type: 'price_change' }
>['payload'];

/** Payload SDK-события `last_trade_price`. */
type PolymarketLastTradePricePayload = Extract<
  PolymarketMarketEventPayload,
  { type: 'last_trade_price' }
>['payload'];

/** Payload SDK-события `tick_size_change`. */
type PolymarketTickSizeChangePayload = Extract<
  PolymarketMarketEventPayload,
  { type: 'tick_size_change' }
>['payload'];

/** Payload RTDS-наблюдения цены (общая форма spot/TWAP). */
interface PolymarketReferencePricePayload {
  /** Символ фида в нативном формате источника. */
  readonly symbol: string;
  /** Vendor-время наблюдения (epoch ms). */
  readonly timestamp: number;
  /** Значение точной десятичной строкой SDK. */
  readonly value: string;
}
