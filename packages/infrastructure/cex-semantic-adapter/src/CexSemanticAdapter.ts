/**
 * Semantic adapter CEX: raw-наблюдения CCXT → canonical Domain/Application.
 *
 * @remarks
 * ### Место в контуре
 *
 * ```text
 *                     ExternalMessageBus
 *                    ↙                  ↘
 *       ExternalMessageRecorder      CexSemanticAdapter
 *                 ↓                          ↓
 *               JSONL              Orderbook<AssetPrice>
 *                                            ↓
 *                                     ApplicationEvent
 *                                            ↓
 *                                        IEventBus
 * ```
 *
 * Recorder и адаптер — НЕЗАВИСИМЫЕ потребители одной шины. Адаптер не знает
 * ни про `CexSource`, ни про CCXT, ни про recorder: он подписан на общий
 * raw-bus, и ничего больше. Поэтому отказ semantic-маппинга не мешает
 * записи сырых данных, а отключение адаптера не влияет на сбор.
 *
 * ### Почему адаптер не видит живой CCXT-инстанс
 *
 * Вся входная информация приходит СООБЩЕНИЕМ. Ни `watchOrderBook`, ни
 * REST-догрузка market info отсюда не вызываются — иначе live-путь и
 * будущий replay расходились бы: воспроизведённое сообщение не имеет за
 * собой живой биржи, и адаптер, который к ней ходит, дал бы на тех же
 * данных другой результат.
 *
 * ### Стакан приходит ПОЛНЫМ снапшотом
 *
 * `CexSource` публикует JSON-снапшот unified-стакана CCXT в момент
 * наблюдения (усечённый до глубины подписки), а не дельту. Поэтому здесь
 * НЕТ реконструкции состояния книги, аналогичной Polymarket: каждое
 * наблюдение отображается независимо и целиком. Второй кэш книги адаптер
 * не держит — только отпечаток верхушки и semantic-версию.
 *
 * ### Границы точности
 *
 * Unified-контракт CCXT отдаёт цены и объёмы как JS `number` — точность
 * зафиксирована ДО этого адаптера, внутри библиотеки. Адаптер её не
 * восстанавливает и не ухудшает: значение уходит в `AssetPriceService`/
 * `QuantityService` как есть, а `Decimal` строится по кратчайшему
 * round-trip-представлению числа (`new Decimal(79233.99)` ===
 * `new Decimal('79233.99')`). `Number()`/`parseFloat()`/`toNumber()` к
 * финансовым значениям в этом пакете не применяются нигде.
 *
 * ### Что адаптер НЕ делает
 *
 * - не владеет raw-шиной (`close()` снимает ТОЛЬКО свои подписки);
 * - не агрегирует площадки между собой (книга binance и книга okx —
 *   независимые наблюдения, «лучшая глобальная книга» здесь не строится);
 * - не считает индикаторы (imbalance/OFI/микроцена/базис — не его слой);
 * - не выводит `REFERENCE_PRICE_UPDATED` из середины книги или ленты:
 *   это производная проекция, а не наблюдение;
 * - не мутирует raw-payload наблюдения;
 * - не использует `orderBook.nonce` как canonical `sequenceNumber` —
 *   его отдают не все биржи (замер: binance/okx/cryptocom да,
 *   bybit/coinbase/kraken нет), а семантика и монотонность через
 *   reconnect у него exchange-specific. Canonical-нумерация строится
 *   адаптером сама (см. {@link CexSemanticAdapter}).
 */
import type { ILogger } from '@polymarket/logger';
import type { IEventBus } from '@polymarket/event-bus';
import type { MessageMetadata, MessageMetadataGenerator } from '@polymarket/messages';
import type { IExternalMessageBus } from '@polymarket/external-message-bus';
import type { CexExternalMessage } from '@polymarket/cex-v2';
import type { InstrumentId, VenueId } from '@polymarket/ids';
import { asVenueTradeId } from '@polymarket/ids';
import type { AssetPrice, Side } from '@polymarket/value-objects';
import { AssetPriceService, QuantityService } from '@polymarket/value-objects';
import { Orderbook, OrderbookLevel, bookPricing } from '@polymarket/orderbook';
import type { Timestamp } from '@polymarket/timestamp';
import { TimestampService } from '@polymarket/timestamp';
import type { TopOfBook } from '@polymarket/application-events';
import type { CexInstrumentIdentity } from './identity.js';
import { instrumentStateKey, resolveCexIdentity } from './identity.js';
import { RecentVenueTradeIds } from './RecentVenueTradeIds.js';

/**
 * Порт подписки адаптера на общий bus.
 *
 * @remarks
 * Структурное подмножество `IExternalMessageBus` (только `subscribe`) — то
 * же правило, что у recorder-а и Polymarket-адаптера: адаптер не владеет
 * шиной и не имеет права публиковать/дренировать/закрывать её. Узкий тип
 * также позволяет передать шину, параметризованную БОЛЕЕ ШИРОКИМ union-ом
 * источников контура (Polymarket + CEX + ...).
 */
export type CexSemanticBusSubscription = Pick<
  IExternalMessageBus<CexExternalMessage>,
  'subscribe'
>;

/** Зависимости {@link CexSemanticAdapter}. */
export interface CexSemanticAdapterDependencies {
  /** Общий raw bus внешнего контура (используется только `subscribe`). */
  readonly bus: CexSemanticBusSubscription;
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
  /**
   * Ёмкость окна дедупликации сделок на инструмент.
   *
   * @remarks
   * Default см. {@link RecentVenueTradeIds}. Значение открыто ради тестов
   * и нестандартных нагрузок; менять его в production без нового замера
   * повторов не нужно.
   */
  readonly recentTradeIdsCapacity?: number;
}

/** Read-only диагностика адаптера. */
export interface CexSemanticAdapterStats {
  /** Всего raw-сообщений, доставленных адаптеру. */
  readonly rawMessagesSeen: number;
  /** Получено наблюдений стакана (`CEX_ORDERBOOK`). */
  readonly orderBooksReceived: number;
  /** Опубликовано canonical-снапшотов стакана (`BOOK_DEPTH`). */
  readonly orderBooksPublished: number;
  /** Наблюдений стакана, отвергнутых semantic-валидацией. */
  readonly invalidOrderBooks: number;
  /** Из них отвергнуто как скрещенная книга (`ask < bid`). */
  readonly crossedOrderBooks: number;
  /** Опубликовано `BOOK_UPDATED` (верхушка изменилась). */
  readonly bookUpdatedPublished: number;
  /** Получено наблюдений сделок (`CEX_TRADE`). */
  readonly tradesReceived: number;
  /** Опубликовано `TRADE_RECEIVED`. */
  readonly tradesPublished: number;
  /** Сделок, отвергнутых semantic-валидацией (цена/объём/идентичность). */
  readonly invalidTrades: number;
  /** Сделок без пригодного venue-идентификатора (опубликованы без него). */
  readonly tradesMissingId: number;
  /** Сделок без объёма — пропущены (`Quantity` не выдумывается). */
  readonly tradesMissingAmount: number;
  /** Сделок без стороны — пропущены (сторона не угадывается). */
  readonly tradesMissingSide: number;
  /** Сделок без vendor-времени (взято время получения наблюдения). */
  readonly tradesMissingVenueTimestamp: number;
  /** Повторных наблюдений одной сделки, отсечённых дедупом. */
  readonly duplicateTrades: number;
  /** Наблюдений с непригодной идентичностью площадки/инструмента. */
  readonly invalidIdentities: number;
  /** Отказов Application EventBus при публикации semantic-события. */
  readonly semanticPublishFailures: number;
  /** Инструментов с живым semantic-состоянием сейчас. */
  readonly activeInstrumentStates: number;
}

/** Отпечаток последней ОПУБЛИКОВАННОЙ верхушки (для detect-change). */
interface PublishedTop {
  readonly bidPrice: string | undefined;
  readonly bidSize: string | undefined;
  readonly askPrice: string | undefined;
  readonly askSize: string | undefined;
}

/** Semantic-состояние одного инструмента одной площадки. */
interface InstrumentState {
  /** Идентичность (хранится, чтобы `getStats`/cleanup не разбирали ключ). */
  readonly identity: CexInstrumentIdentity;
  /** Semantic-версия книги: растёт после КАЖДОГО принятого наблюдения. */
  version: number;
  /** Отпечаток последней опубликованной верхушки. */
  publishedTop: PublishedTop | undefined;
  /** Окно недавних venue-id сделок (создаётся при первой сделке). */
  recentTradeIds: RecentVenueTradeIds | undefined;
}

/**
 * Ценовые метрики книги биржи, связанные с доменом цены актива.
 *
 * @remarks
 * Связывание один раз на модуль: домен цены у CEX-книги всегда один, а
 * `bookPricing` намеренно требует явной фабрики — см. его докблок.
 * Используется только для проверки «скрещена ли книга»: правило живёт в
 * домене, дублировать сравнение уровней в infrastructure нельзя.
 */
const ASSET_BOOK_PRICING = bookPricing<AssetPrice>((value) => AssetPriceService.create(value));

/**
 * Адаптер, превращающий raw-наблюдения CEX в canonical-события.
 *
 * @remarks
 * ### Semantic-нумерация книги
 *
 * `BOOK_UPDATED.sequenceNumber` — счётчик, локальный для пары
 * `venueId + instrumentId` и увеличиваемый ТОЛЬКО после успешно принятого
 * наблюдения стакана. Глобальная последовательность raw-шины для этого
 * непригодна: в ней перемешаны другие биржи, другие символы, сделки и
 * сообщения Polymarket, поэтому у одного инструмента она имеет
 * естественные «дыры», неотличимые от потерь. `orderBook.nonce` биржи тоже
 * не используется — см. докблок модуля.
 *
 * ### Один адаптер на все биржи
 *
 * Payload унифицирован самим CCXT, поэтому отдельных
 * `BinanceSemanticAdapter`/`OkxSemanticAdapter` не существует: одна
 * реализация обслуживает все настроенные площадки, а состояние ключуется
 * `venueId + instrumentId`, так что `BTC/USDT` на разных биржах никогда не
 * делит верхушку и нумерацию.
 *
 * @example
 * ```typescript
 * const adapter = new CexSemanticAdapter({
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
export class CexSemanticAdapter {
  private readonly _bus: CexSemanticBusSubscription;
  private readonly _eventBus: IEventBus;
  private readonly _metadata: MessageMetadataGenerator;
  private readonly _logger: ILogger;
  private readonly _recentTradeIdsCapacity: number | undefined;

  /** Semantic-состояние по ключу `venueId + instrumentId`. */
  private readonly _states = new Map<string, InstrumentState>();

  private _disposers: (() => void)[] = [];
  private _started = false;

  private _rawMessagesSeen = 0;
  private _orderBooksReceived = 0;
  private _orderBooksPublished = 0;
  private _invalidOrderBooks = 0;
  private _crossedOrderBooks = 0;
  private _bookUpdatedPublished = 0;
  private _tradesReceived = 0;
  private _tradesPublished = 0;
  private _invalidTrades = 0;
  private _tradesMissingId = 0;
  private _tradesMissingAmount = 0;
  private _tradesMissingSide = 0;
  private _tradesMissingVenueTimestamp = 0;
  private _duplicateTrades = 0;
  private _invalidIdentities = 0;
  private _semanticPublishFailures = 0;

  /**
   * Создаёт адаптер поверх общего raw-bus и Application EventBus.
   *
   * @param deps - Зависимости (см. {@link CexSemanticAdapterDependencies})
   */
  constructor(deps: CexSemanticAdapterDependencies) {
    this._bus = deps.bus;
    this._eventBus = deps.eventBus;
    this._metadata = deps.metadataGenerator;
    this._logger = deps.logger.child({ component: 'CexSemanticAdapter' });
    this._recentTradeIdsCapacity = deps.recentTradeIdsCapacity;
  }

  /**
   * Подписывается на CEX-сообщения общего raw-bus.
   *
   * @remarks
   * Идемпотентен: повторный вызов при активной подписке НИЧЕГО не делает и
   * пишет warn — двойная подписка означала бы двойную публикацию каждого
   * semantic-события.
   *
   * Подписки строго typed: адаптер видит ТОЛЬКО два CEX-канала и не влияет
   * на остальных потребителей шины (раздача веерная).
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
      this._bus.subscribe('CEX_ORDERBOOK', async (message) => {
        this._rawMessagesSeen++;
        await this._onOrderbook(message.payload, message.metadata);
      }),
      this._bus.subscribe('CEX_TRADE', async (message) => {
        this._rawMessagesSeen++;
        await this._onTrade(message.payload, message.metadata);
      }),
    ];
    this._logger.info('CEX semantic adapter started');
  }

  /**
   * Снимает СВОИ подписки и освобождает semantic-состояние.
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
    this._states.clear();
    this._logger.info('CEX semantic adapter closed');
  }

  /**
   * Забывает semantic-состояние ОДНОГО инструмента площадки.
   *
   * @param venueId - Площадка
   * @param instrumentId - Инструмент внутри площадки
   * @returns `true`, если состояние существовало
   *
   * @remarks
   * Явная граница памяти: адаптер специально не подписан на события
   * жизненного цикла сбора — связав его с ними, мы сделали бы semantic-слой
   * collection-specific, а он обязан одинаково работать и для live, и для
   * будущего replay. Момент «этот инструмент больше не нужен» знает
   * владелец, он и вызывает cleanup.
   *
   * @example
   * ```typescript
   * adapter.forgetInstrument(venueId, instrumentId);
   * ```
   */
  public forgetInstrument(venueId: VenueId, instrumentId: InstrumentId): boolean {
    return this._states.delete(instrumentStateKey({ venueId, instrumentId }));
  }

  /**
   * Забывает semantic-состояние ВСЕХ инструментов одной площадки.
   *
   * @param venueId - Площадка
   * @returns Число забытых инструментов
   *
   * @example
   * ```typescript
   * adapter.forgetVenue(binanceVenueId); // → 10
   * ```
   */
  public forgetVenue(venueId: VenueId): number {
    let forgotten = 0;
    for (const [key, state] of this._states) {
      if (state.identity.venueId !== venueId) continue;
      this._states.delete(key);
      forgotten++;
    }
    return forgotten;
  }

  /**
   * Снимок диагностики адаптера.
   *
   * @returns Read-only счётчики (см. {@link CexSemanticAdapterStats})
   *
   * @example
   * ```typescript
   * const stats = adapter.getStats();
   * console.log(stats.orderBooksPublished, stats.invalidOrderBooks);
   * ```
   */
  public getStats(): CexSemanticAdapterStats {
    return {
      rawMessagesSeen: this._rawMessagesSeen,
      orderBooksReceived: this._orderBooksReceived,
      orderBooksPublished: this._orderBooksPublished,
      invalidOrderBooks: this._invalidOrderBooks,
      crossedOrderBooks: this._crossedOrderBooks,
      bookUpdatedPublished: this._bookUpdatedPublished,
      tradesReceived: this._tradesReceived,
      tradesPublished: this._tradesPublished,
      invalidTrades: this._invalidTrades,
      tradesMissingId: this._tradesMissingId,
      tradesMissingAmount: this._tradesMissingAmount,
      tradesMissingSide: this._tradesMissingSide,
      tradesMissingVenueTimestamp: this._tradesMissingVenueTimestamp,
      duplicateTrades: this._duplicateTrades,
      invalidIdentities: this._invalidIdentities,
      semanticPublishFailures: this._semanticPublishFailures,
      activeInstrumentStates: this._states.size,
    };
  }

  // ─────────────────────────────── Стакан ───────────────────────────────

  /**
   * Отображает одно наблюдение стакана в canonical-события.
   *
   * @param payload - Payload `CEX_ORDERBOOK` (routing identity + vendor-снапшот)
   * @param parent - Metadata raw-наблюдения (родитель causal chain)
   *
   * @remarks
   * ### Атомарность
   *
   * Наблюдение отображается ЦЕЛИКОМ или не отображается вовсе: сначала
   * валидируются все уровни обеих сторон, и только потом строится книга.
   * Один битый уровень не превращается в книгу «на 95 уровней из 96» —
   * такая книга выглядела бы исправной и молча искажала бы глубину.
   *
   * ### Односторонняя и пустая книга
   *
   * Допустимы и публикуются как есть: `TopOfBook` представляет
   * отсутствующую сторону `undefined`, уровни не выдумываются. (В live эти
   * состояния до адаптера не доходят — `CexSource` их пропускает, — но
   * replay-сообщение обязано обрабатываться тем же кодом.)
   *
   * ### Скрещенная книга
   *
   * Отвергается: `ask < bid` — невозможное состояние, и `CexSource` уже
   * считает его отказом транспорта. Цены НЕ правятся, стороны НЕ меняются
   * местами, спред НЕ расширяется — наблюдение просто не порождает
   * canonical-события.
   */
  private async _onOrderbook(
    payload: CexOrderbookPayloadShape,
    parent: MessageMetadata,
  ): Promise<void> {
    this._orderBooksReceived++;

    const identity = this._resolveIdentity(payload, 'orderbook');
    if (identity === undefined) return;

    const snapshot = payload.orderBook;
    const bids = this._parseLevels(snapshot.bids, 'bids', identity);
    if (bids === undefined) return;
    const asks = this._parseLevels(snapshot.asks, 'asks', identity);
    if (asks === undefined) return;

    const receivedAt = parent.createdAt;
    const venueTimestamp = this._toVenueTimestamp(snapshot.timestamp, identity, 'orderbook');

    const book = Orderbook.fromLevels<AssetPrice>({
      venueId: identity.venueId,
      // marketId у биржи НЕ существует отдельно от инструмента: «рынок
      // BTC/USDT» и «инструмент BTC/USDT» на binance — одно и то же.
      // Продублировать сюда символ значило бы выдумать сущность площадки.
      instrumentId: identity.instrumentId,
      bids,
      asks,
      ...(venueTimestamp !== undefined ? { venueTimestamp } : {}),
      receivedAt,
    });

    const spread = ASSET_BOOK_PRICING.spread(book);
    // Пустая и односторонняя книги тоже дают Err — но они ВАЛИДНЫ и
    // публикуются; отвергается ровно скрещенная
    if (!spread.ok && spread.error.isCrossedBook()) {
      this._invalidOrderBooks++;
      this._crossedOrderBooks++;
      this._logger.warn('Rejected crossed CEX orderbook observation', {
        venueId: String(identity.venueId),
        instrumentId: String(identity.instrumentId),
        bestBid: book.getBestBid()?.value().toString() ?? '',
        bestAsk: book.getBestAsk()?.value().toString() ?? '',
      });
      return;
    }

    const state = this._stateFor(identity);
    state.version++;

    await this._publishBook(identity, state, book, venueTimestamp ?? receivedAt, parent);
  }

  /**
   * Публикует canonical-события стакана как children raw-наблюдения.
   *
   * @param identity - Площадка и инструмент
   * @param state - Semantic-состояние инструмента
   * @param book - Иммутабельная canonical-книга наблюдения
   * @param timestamp - Время снапшота (vendor, иначе получение)
   * @param parent - Metadata raw-наблюдения
   *
   * @remarks
   * `BOOK_DEPTH` публикуется на КАЖДОЕ принятое наблюдение — его контракт
   * несёт полную книгу, и глубина меняется даже когда верхушка осталась
   * прежней.
   *
   * `BOOK_UPDATED` публикуется ТОЛЬКО при изменении верхушки: его
   * документированный контракт — «каждое изменение лучшей цены стакана».
   * Слать его на чисто глубинную правку значило бы сообщать подписчикам,
   * что верхушка изменилась, когда она не изменилась.
   */
  private async _publishBook(
    identity: CexInstrumentIdentity,
    state: InstrumentState,
    book: Orderbook<AssetPrice>,
    timestamp: Timestamp,
    parent: MessageMetadata,
  ): Promise<void> {
    const depthPublished = await this._publish({
      type: 'BOOK_DEPTH',
      payload: {
        venueId: identity.venueId,
        instrumentId: identity.instrumentId,
        snapshot: book,
        timestamp,
      },
      metadata: this._metadata.nextChild(parent),
    });
    if (depthPublished) {
      this._orderBooksPublished++;
    }

    const topOfBook = buildTopOfBook(book);
    const fingerprint = fingerprintTop(topOfBook);
    if (state.publishedTop !== undefined && sameTop(state.publishedTop, fingerprint)) {
      return;
    }

    const topPublished = await this._publish({
      type: 'BOOK_UPDATED',
      payload: {
        topOfBook,
        venueId: identity.venueId,
        instrumentId: identity.instrumentId,
        sequenceNumber: state.version,
        timestamp,
      },
      metadata: this._metadata.nextChild(parent),
    });
    // Отпечаток запоминается ТОЛЬКО после успешной публикации: иначе
    // отвергнутое шиной событие «зачлось» бы как опубликованное, и
    // следующее наблюдение с той же верхушкой подписчики не увидели бы
    // никогда — гашение дубликатов превратилось бы в потерю данных
    if (topPublished) {
      state.publishedTop = fingerprint;
      this._bookUpdatedPublished++;
    }
  }

  /**
   * Отображает одну сторону vendor-стакана в canonical-уровни.
   *
   * @param raw - Сторона снапшота (`bids`/`asks`) как её отдал vendor
   * @param side - Имя стороны для structured-лога
   * @param identity - Идентичность наблюдения (для контекста лога)
   * @returns Массив уровней либо `undefined`, если сторона непригодна
   *   (счётчик `invalidOrderBooks` уже увеличен)
   *
   * @remarks
   * Отсутствующая сторона — пустой массив уровней, а не отказ: книга без
   * одной стороны валидна (см. докблок `_onOrderbook`). Отказ — это
   * сторона, которая ЕСТЬ, но непригодна: не массив, уровень не массив,
   * цена вне домена (`AssetPrice` строго положителен), объём отрицателен.
   *
   * Сортировка здесь НЕ выполняется: `Orderbook.fromLevels` сортирует сам,
   * и повторять доменное правило в infrastructure нельзя — две копии
   * компаратора рано или поздно разойдутся.
   *
   * Уровни с нулевым объёмом сохраняются как есть: `Quantity` ноль
   * представляет, а source-контракт нигде не объявляет такие строки
   * удаляемым шумом. Молча их выбрасывать значило бы менять наблюдаемую
   * глубину.
   */
  private _parseLevels(
    raw: unknown,
    side: 'bids' | 'asks',
    identity: CexInstrumentIdentity,
  ): OrderbookLevel<AssetPrice>[] | undefined {
    if (raw === undefined || raw === null) {
      return [];
    }
    if (!Array.isArray(raw)) {
      this._rejectBook(identity, side, 'side is not an array');
      return undefined;
    }

    const levels: OrderbookLevel<AssetPrice>[] = [];
    for (const entry of raw as readonly unknown[]) {
      if (!Array.isArray(entry)) {
        this._rejectBook(identity, side, 'level is not an array');
        return undefined;
      }
      const rawPrice = numericField((entry as readonly unknown[])[0]);
      const rawAmount = numericField((entry as readonly unknown[])[1]);
      if (rawPrice === undefined || rawAmount === undefined) {
        this._rejectBook(identity, side, 'level price/amount is not a finite number or decimal string');
        return undefined;
      }

      const price = AssetPriceService.create(rawPrice);
      if (!price.ok) {
        this._rejectBook(identity, side, `level price rejected: ${String(price.error.context?.reason)}`);
        return undefined;
      }
      const quantity = QuantityService.create(rawAmount);
      if (!quantity.ok) {
        this._rejectBook(identity, side, `level amount rejected: ${String(quantity.error.context?.reason)}`);
        return undefined;
      }
      levels.push(OrderbookLevel.create(price.value, quantity.value));
    }
    return levels;
  }

  /**
   * Учитывает отказ semantic-маппинга книги и пишет structured-диагностику.
   *
   * @param identity - Идентичность наблюдения
   * @param side - Сторона, на которой отказ обнаружен
   * @param detail - Причина отказа
   */
  private _rejectBook(
    identity: CexInstrumentIdentity,
    side: 'bids' | 'asks',
    detail: string,
  ): void {
    this._invalidOrderBooks++;
    this._logger.warn('Rejected CEX orderbook observation, no canonical book published', {
      venueId: String(identity.venueId),
      instrumentId: String(identity.instrumentId),
      side,
      detail,
    });
  }

  // ─────────────────────────────── Сделки ───────────────────────────────

  /**
   * Отображает одно наблюдение сделки в `TRADE_RECEIVED`.
   *
   * @param payload - Payload `CEX_TRADE` (routing identity + vendor-снапшот)
   * @param parent - Metadata raw-наблюдения
   *
   * @remarks
   * ### Идентичность сделки НЕ синтезируется
   *
   * `venueTradeId` берётся из unified-поля `id` КАК ЕСТЬ. Если биржа его не
   * прислала, поле остаётся `undefined` — и это единственное допустимое
   * поведение: ключ из `timestamp`/`symbol+timestamp`/хеша полей склеил бы
   * разные сделки (у нас уже есть этот дефект в legacy-коде, повторять его
   * в новом адаптере нельзя). Контракт `TRADE_RECEIVED` сделку без
   * идентификатора представляет честно, поэтому она публикуется.
   *
   * Замер на записанном архиве (1 128 052 сделки, 6 бирж): `id` есть у
   * 100% наблюдений всех шести площадок.
   *
   * ### Объём — только `amount`
   *
   * `cost` (= `price * amount`) объёмом НЕ является и в `Quantity` не
   * переводится; вычислять `cost / price` тоже запрещено — это уже не
   * наблюдение, а реконструкция. Нет `amount` → сделка пропускается.
   *
   * ### Сторона не угадывается
   *
   * Unified `side` CCXT — сторона агрессора (taker). Она переносится как
   * есть; инверсии «по maker/taker» здесь нет. Нет стороны или значение
   * незнакомо → сделка пропускается.
   *
   * ### Дедупликация
   *
   * `newUpdates: true` источника гарантирует «только новые сделки» в
   * пределах сессии, но не переживает пересоздание инстанса. Замер на
   * архиве нашёл 525 повторов (cryptocom 517, coinbase 8) — побайтно
   * идентичных, с тем же venue-id. Поэтому повтор отсекается ограниченным
   * окном по `venueId + instrumentId + venueTradeId`
   * (см. {@link RecentVenueTradeIds}). Сделки БЕЗ id в дедуп не попадают
   * вовсе: без настоящего идентификатора отличить повтор от двух
   * одинаковых сделок невозможно, и «дедуп» стал бы потерей данных.
   */
  private async _onTrade(
    payload: CexTradePayloadShape,
    parent: MessageMetadata,
  ): Promise<void> {
    this._tradesReceived++;

    const identity = this._resolveIdentity(payload, 'trade');
    if (identity === undefined) return;

    const trade = payload.trade;

    const rawAmount = numericField(trade.amount);
    if (rawAmount === undefined) {
      this._tradesMissingAmount++;
      this._logger.debug('CEX trade without usable amount, semantic trade skipped', {
        venueId: String(identity.venueId),
        instrumentId: String(identity.instrumentId),
      });
      return;
    }

    const side = toTradeSide(trade.side);
    if (side === undefined) {
      this._tradesMissingSide++;
      this._logger.debug('CEX trade without usable side, semantic trade skipped', {
        venueId: String(identity.venueId),
        instrumentId: String(identity.instrumentId),
      });
      return;
    }

    const rawPrice = numericField(trade.price);
    if (rawPrice === undefined) {
      this._invalidTrades++;
      this._logger.warn('Rejected CEX trade without usable price', {
        venueId: String(identity.venueId),
        instrumentId: String(identity.instrumentId),
      });
      return;
    }
    const price = AssetPriceService.create(rawPrice);
    if (!price.ok) {
      this._invalidTrades++;
      this._logger.warn('Rejected CEX trade with invalid price', {
        venueId: String(identity.venueId),
        instrumentId: String(identity.instrumentId),
        reason: String(price.error.context?.reason),
      });
      return;
    }

    const size = QuantityService.create(rawAmount);
    if (!size.ok) {
      this._invalidTrades++;
      this._logger.warn('Rejected CEX trade with invalid amount', {
        venueId: String(identity.venueId),
        instrumentId: String(identity.instrumentId),
        reason: String(size.error.context?.reason),
      });
      return;
    }

    const venueTradeId = this._resolveVenueTradeId(trade.id, identity);
    if (venueTradeId !== undefined) {
      const state = this._stateFor(identity);
      state.recentTradeIds ??= new RecentVenueTradeIds(this._recentTradeIdsCapacity);
      if (!state.recentTradeIds.registerIfNew(venueTradeId)) {
        this._duplicateTrades++;
        this._logger.debug('Skipped repeated CEX trade observation', {
          venueId: String(identity.venueId),
          instrumentId: String(identity.instrumentId),
          venueTradeId,
        });
        return;
      }
    }

    const venueTimestamp = this._toVenueTimestamp(trade.timestamp, identity, 'trade');
    if (venueTimestamp === undefined) {
      this._tradesMissingVenueTimestamp++;
    }

    const published = await this._publish({
      type: 'TRADE_RECEIVED',
      payload: {
        venueId: identity.venueId,
        instrumentId: identity.instrumentId,
        // marketId остаётся undefined: у биржи нет рынка отдельно от
        // инструмента (см. `_onOrderbook`)
        ...(venueTradeId !== undefined ? { venueTradeId: asVenueTradeId(venueTradeId) } : {}),
        price: price.value,
        size: size.value,
        side,
        // Vendor-время, если биржа его прислала; иначе — время получения
        // наблюдения. Локальное время НЕ выдаётся за биржевое: расхождение
        // видно счётчиком `tradesMissingVenueTimestamp`
        timestamp: venueTimestamp ?? parent.createdAt,
      },
      metadata: this._metadata.nextChild(parent),
    });
    if (published) {
      this._tradesPublished++;
    } else if (venueTradeId !== undefined) {
      // Регистрация снимается: НЕопубликованная сделка не имеет права
      // остаться помеченной виденной — повторную выдачу биржей мы бы тогда
      // отбросили как дубликат, и гашение повторов стало бы потерей данных
      // (то же правило, что и у отпечатка верхушки в `_publishBook`)
      this._stateFor(identity).recentTradeIds?.forget(venueTradeId);
    }
  }

  /**
   * Валидирует venue-идентификатор сделки, ничего не синтезируя.
   *
   * @param raw - Поле `id` unified-сделки CCXT
   * @param identity - Идентичность наблюдения (для контекста лога)
   * @returns Строковый идентификатор либо `undefined`, если биржа его не
   *   прислала или прислала непригодным
   *
   * @remarks
   * Обе ветки «нет id» и «id непригоден» дают `undefined` и увеличивают
   * `tradesMissingId`: снаружи это одно и то же — venue не сообщил
   * пригодного идентификатора. Сделка всё равно публикуется, просто без
   * него.
   *
   * Числовая ветка — оборонительная: замер на архиве (372 062 сделки,
   * все шесть бирж) не нашёл НИ ОДНОГО числового `id`, unified-контракт
   * CCXT объявляет поле строкой. Если такой id всё же придёт и окажется
   * длиннее 2^53−1, его точность будет потеряна ещё в `JSON.parse` —
   * до адаптера, и восстановить её здесь невозможно (ровно как с
   * ценами). Собственного искажения адаптер при этом не вносит:
   * `String()` печатает то значение, которое реально пришло.
   */
  private _resolveVenueTradeId(
    raw: unknown,
    identity: CexInstrumentIdentity,
  ): string | undefined {
    if (raw === undefined || raw === null) {
      this._tradesMissingId++;
      return undefined;
    }
    // Числовой id у биржи допустим — это тот же идентификатор, записанный
    // числом; строковое представление берётся дословно, без переформатирования
    const asString =
      typeof raw === 'string' ? raw : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : undefined;
    const validated = asString === undefined ? undefined : asVenueTradeId(asString);
    if (validated === undefined) {
      this._tradesMissingId++;
      this._logger.debug('CEX trade carries unusable venue trade id, publishing without it', {
        venueId: String(identity.venueId),
        instrumentId: String(identity.instrumentId),
      });
      return undefined;
    }
    return validated;
  }

  // ────────────────────────────── Общее ──────────────────────────────

  /**
   * Возвращает (создавая при необходимости) semantic-состояние инструмента.
   *
   * @param identity - Площадка и инструмент
   * @returns Состояние, ключёванное `venueId + instrumentId`
   */
  private _stateFor(identity: CexInstrumentIdentity): InstrumentState {
    const key = instrumentStateKey(identity);
    let state = this._states.get(key);
    if (state === undefined) {
      state = { identity, version: 0, publishedTop: undefined, recentTradeIds: undefined };
      this._states.set(key, state);
    }
    return state;
  }

  /**
   * Выводит canonical-идентичность наблюдения из его routing-полей.
   *
   * @param payload - Payload наблюдения (стакан либо сделка)
   * @param kind - Вид наблюдения для structured-лога
   * @returns Идентичность либо `undefined` (счётчик уже увеличен)
   */
  private _resolveIdentity(
    payload: CexIdentityFields,
    kind: 'orderbook' | 'trade',
  ): CexInstrumentIdentity | undefined {
    const identity = resolveCexIdentity(payload);
    if (identity === undefined) {
      this._invalidIdentities++;
      this._logger.warn('Rejected CEX observation with unmappable venue/instrument identity', {
        kind,
        exchangeId: String(payload.exchangeId),
        marketType: String(payload.marketType),
        symbol: String(payload.symbol),
      });
    }
    return identity;
  }

  /**
   * Превращает vendor-время наблюдения в `Timestamp`.
   *
   * @param raw - Поле `timestamp` vendor-снапшота (epoch ms) либо `null`
   * @param identity - Идентичность наблюдения (для контекста лога)
   * @param kind - Вид наблюдения для structured-лога
   * @returns `Timestamp` биржи либо `undefined`, если биржа времени не дала
   *
   * @remarks
   * Vendor-время НЕ подменяется локальным: `receivedAt` берётся из metadata
   * наблюдения отдельно, и смешивать их нельзя — их разность и есть
   * задержка доставки. `Date.now()` здесь не вызывается вовсе.
   */
  private _toVenueTimestamp(
    raw: unknown,
    identity: CexInstrumentIdentity,
    kind: 'orderbook' | 'trade',
  ): Timestamp | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      this._logger.debug('CEX observation carries unusable vendor timestamp', {
        kind,
        venueId: String(identity.venueId),
        instrumentId: String(identity.instrumentId),
      });
      return undefined;
    }
    const result = TimestampService.create(raw);
    if (!result.ok) {
      this._logger.debug('Rejected CEX vendor timestamp', {
        kind,
        venueId: String(identity.venueId),
        instrumentId: String(identity.instrumentId),
      });
      return undefined;
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
 * Достаёт финансовое значение уровня/сделки, не теряя точности.
 *
 * @param value - Поле vendor-снапшота
 * @returns Число или десятичная строка, пригодные для VO-фабрики; либо
 *   `undefined`, если значение отсутствует или не является числом
 *
 * @remarks
 * Значение НЕ преобразуется: `number` уходит числом, `string` — строкой.
 * `Number(...)`/`parseFloat(...)` здесь нет специально — строка от биржи
 * точнее своего числового представления, и переводить её в `number`
 * значило бы ухудшить точность прямо на границе. Обратное преобразование
 * (`number` → строка) тоже не нужно: `Decimal` строит из числа его
 * кратчайшее round-trip-представление, то есть ровно то же значение.
 *
 * @example
 * ```typescript
 * numericField(79233.99);    // → 79233.99
 * numericField('79233.99');  // → '79233.99'
 * numericField(null);        // → undefined
 * numericField(Number.NaN);  // → undefined
 * ```
 */
function numericField(value: unknown): number | string | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }
  return undefined;
}

/**
 * Отображает unified-сторону сделки CCXT в canonical `Side`.
 *
 * @param side - Поле `side` unified-сделки (`buy`/`sell`)
 * @returns `Side` либо `undefined` для отсутствующего/незнакомого значения
 *
 * @remarks
 * Сохраняется ФАКТИЧЕСКАЯ семантика источника: `buy` → `BUY`. Инвертировать
 * сторону «потому что maker/taker» без доказательства запрещено — это молча
 * исказило бы всю ленту. Регистр приводится, потому что unified-контракт
 * CCXT задаёт нижний, а замер на архиве (1 128 052 сделки) других значений
 * не встретил.
 */
function toTradeSide(side: unknown): Side | undefined {
  if (typeof side !== 'string') return undefined;
  const normalized = side.trim().toLowerCase();
  if (normalized === 'buy') return 'BUY';
  if (normalized === 'sell') return 'SELL';
  return undefined;
}

/**
 * Строит `TopOfBook` из canonical-стакана.
 *
 * @param book - Иммутабельный стакан
 * @returns Верхушка стакана; отсутствующая сторона представлена `undefined`
 *
 * @remarks
 * Уровни НЕ выдумываются: односторонняя и пустая книга — валидные
 * состояния, и подставлять нули ради «полноты» `TopOfBook` запрещено.
 */
function buildTopOfBook(book: Orderbook<AssetPrice>): TopOfBook<AssetPrice> {
  return {
    bestBid: book.getBestBid() ?? undefined,
    bestAsk: book.getBestAsk() ?? undefined,
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
 * Сравнение идёт по КАНОНИЧЕСКОЙ `Decimal`-строке, а не по исходному
 * значению vendor-а: `79234` и `79234.00` — одна и та же цена, и считать
 * это изменением верхушки было бы ложным событием.
 */
function fingerprintTop(top: TopOfBook<AssetPrice>): PublishedTop {
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
 * Payload наблюдения стакана.
 *
 * @remarks
 * Выведен из фактического union `CexExternalMessage`, а не написан руками:
 * любое изменение source-контракта немедленно проявится ошибкой компиляции
 * здесь, а не расхождением в рантайме.
 */
type CexOrderbookPayloadShape = Extract<
  CexExternalMessage,
  { type: 'CEX_ORDERBOOK' }
>['payload'];

/** Payload наблюдения сделки (выведен из union источника). */
type CexTradePayloadShape = Extract<CexExternalMessage, { type: 'CEX_TRADE' }>['payload'];

/** Общие routing-поля обоих payload-ов. */
type CexIdentityFields = Pick<CexOrderbookPayloadShape, 'exchangeId' | 'marketType' | 'symbol'>;
