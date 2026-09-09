/**
 * Read-only проекции состояния для потребителей.
 *
 * @remarks
 * Стратегия читает hot state, но дописывать в него не должна: единственный
 * writer — `TradingStateProjector`. Поэтому наружу из пакета выходят только
 * эти интерфейсы, а конкретные mutable-классы не экспортируются вовсе —
 * иначе правило «один писатель» осталось бы комментарием, который ничто не
 * проверяет.
 *
 * `RollingWindow<T>` структурно реализует {@link RollingWindowView} —
 * приведение бесплатно, копирования нет.
 *
 * Глубоких копий при чтении НЕ делается: это горячий путь, а окно может
 * содержать десятки тысяч записей. Возвращаемые массивы объявлены
 * `readonly`, а сами наблюдения immutable по построению.
 */
import type { InstrumentId, MarketDataSourceId, MarketId, VenueId } from '@polymarket/ids';
import type { Market } from '@polymarket/market';
import type { AssetPrice, OutcomePrice } from '@polymarket/value-objects';
import type { TradingMarketLifecycleView } from './lifecycle.js';
import type {
  BookObservation,
  PublicTradeObservation,
  ReferencePriceObservation,
  ReferencePriceSeriesKey,
  TickSizeState,
} from './observations.js';

/**
 * Временной ряд только для чтения.
 *
 * @remarks
 * Повторяет читающую часть `RollingWindow<T>` и намеренно не содержит
 * `append()`.
 *
 * @example
 * ```typescript
 * const latest = state
 *   .getMarket(venueId, marketId)
 *   ?.getInstrument(instrumentId)
 *   ?.books.getLatest();
 * ```
 */
export interface RollingWindowView<T> {
  /** Последнее наблюдение либо `undefined` для пустого ряда */
  getLatest(): T | undefined;
  /**
   * Наблюдения за последние `durationMs` относительно `nowMs`.
   *
   * @remarks
   * `nowMs` ОБЯЗАТЕЛЕН — в отличие от `RollingWindow`, где он необязателен и
   * при отсутствии берётся из часов. Через эту проекцию состояние не должно
   * незаметно обращаться к живым часам: тогда одна и та же история давала бы
   * разные ответы в зависимости от момента чтения, и replay перестал бы
   * совпадать с торговлей.
   *
   * Момент отсчёта — забота вызывающего: будущий `TradingContext` возьмёт
   * его из времени наблюдения, на котором принимается решение.
   */
  getRecent(durationMs: number, nowMs: number): readonly T[];
  /** Последние `n` наблюдений */
  getLast(n: number): readonly T[];
  /** Наблюдения в интервале времени */
  getWindow(fromMs: number, toMs: number): readonly T[];
  /** Все наблюдения ряда */
  getAll(): readonly T[];
  /** Количество наблюдений */
  size(): number;
  /** Ряд пуст */
  isEmpty(): boolean;
}

/** Инструмент конкретного рынка — только чтение. */
export interface MarketInstrumentStateView {
  /** Идентичность инструмента */
  readonly instrumentId: InstrumentId;
  /**
   * История полных снимков стакана (`BOOK_DEPTH`).
   *
   * @remarks
   * Текущий стакан — это `books.getLatest()`. Отдельного `currentBook` нет.
   */
  readonly books: RollingWindowView<BookObservation>;
  /**
   * История публичных сделок (`TRADE_RECEIVED`).
   *
   * @remarks
   * Цена — `OutcomePrice`: инструмент принадлежит рынку предсказаний, и его
   * цена по построению лежит в (0, 1). Сужение делает проектор на границе.
   */
  readonly publicTrades: RollingWindowView<PublicTradeObservation<OutcomePrice>>;
  /**
   * Действующий шаг цены.
   *
   * @remarks
   * Хранится текущим значением, а не историей: в этом MR история смен шага
   * никому не нужна, а ряд ради одного значения — лишняя память.
   */
  readonly tickSize: TickSizeState | undefined;
}

/**
 * Принятый торговым рантаймом рынок — только чтение.
 *
 * @remarks
 * Состояние такого рынка существует ТОЛЬКО после `TRADING_MARKET_ADMITTED`:
 * market-data сама рынок не создаёт (см. `TradingHotStateView.getMarket`).
 *
 * Отдельных полей идентичности здесь нет: её даёт пара `market.venueId` +
 * `market.id`, и вторые поля с тем же смыслом пришлось бы держать
 * согласованными с первыми. По той же причине не дублируются `question`,
 * `startsAt`, `expiresAt`, `outcomes`, `family` и `crypto` — всё это читается
 * из `market`.
 */
export interface MarketRuntimeStateView {
  /**
   * Canonical рынок, каким его знает торговый рантайм.
   *
   * @remarks
   * `Market` immutable, поэтому отдаётся ссылкой без копирования. После
   * `TRADING_MARKET_RESOLVED` здесь лежит РАЗРЕШЁННЫЙ рынок — то есть
   * последнее внешнее состояние, включая `resolvedOutcome`.
   */
  readonly market: Market;
  /**
   * Жизненный цикл рынка в НАШЕМ рантайме.
   *
   * @remarks
   * Это не `market.state`: внешнее состояние площадки и наш торговый цикл —
   * разные вещи (см. `@polymarket/trading-state` → `lifecycle.ts`).
   */
  readonly lifecycle: TradingMarketLifecycleView;
  /**
   * Активное тяжёлое состояние инструмента, если оно ещё удерживается.
   *
   * @remarks
   * `undefined` означает не «инструмента у рынка нет», а «активных рыночных
   * данных по нему больше нет»: после `TRADING_CLOSED` тяжёлые ряды
   * освобождаются, и метод начинает возвращать `undefined` для обоих исходов.
   * Структурный состав инструментов рынка даёт {@link instrumentIds}.
   */
  getInstrument(instrumentId: InstrumentId): MarketInstrumentStateView | undefined;
  /**
   * Структурные инструменты рынка — оба исхода, всегда.
   *
   * @remarks
   * Берутся из canonical `market.outcomes`, а не из ключей текущих рядов,
   * поэтому состав не меняется на протяжении всей жизни рынка:
   *
   * ```text
   * ADMITTED       → [outcome0, outcome1]
   * ACTIVE         → [outcome0, outcome1]
   * TRADING_CLOSED → [outcome0, outcome1]   (но getInstrument уже undefined)
   * FINALIZED      → [outcome0, outcome1]
   * ```
   */
  instrumentIds(): readonly InstrumentId[];
}

/** Инструмент площадки вне рынка — только чтение. */
export interface SharedInstrumentStateView {
  /** Площадка */
  readonly venueId: VenueId;
  /** Инструмент площадки */
  readonly instrumentId: InstrumentId;
  /** История полных снимков стакана */
  readonly books: RollingWindowView<BookObservation>;
  /**
   * История публичных сделок.
   *
   * @remarks
   * Цена — `AssetPrice`: это лента внешней площадки, где верхней границы у
   * цены нет.
   */
  readonly publicTrades: RollingWindowView<PublicTradeObservation<AssetPrice>>;
}

/**
 * Идентичность рынка в торговом состоянии — ПАРА, а не один идентификатор.
 *
 * @remarks
 * `MarketId` уникален только внутри пространства имён своей площадки, поэтому
 * `POLYMARKET:X` и `KALSHI:X` — два РАЗНЫХ рынка, а не один в двух
 * наблюдениях. То же правило уже действует в `Market.equals()` (сравнивает
 * `venueId + id`) и в ключе `MarketUniverse`.
 *
 * Тип нужен перечислению: `getMarket()` принимает пару аргументов, а вот
 * `marketIds()` вернул бы список, из которого нельзя построить обратный вызов —
 * поэтому его заменяет {@link TradingHotStateView.marketIdentities}.
 */
export interface TradingMarketIdentity {
  /** Площадка рынка */
  readonly venueId: VenueId;
  /** Идентификатор рынка внутри пространства имён площадки */
  readonly marketId: MarketId;
}

/**
 * Hot state — только чтение.
 *
 * @remarks
 * Единственный тип состояния, доступный за пределами пакета.
 *
 * @example
 * ```typescript
 * const view: TradingHotStateView = projector.state();
 * const book = view.getMarket(venueId, marketId)?.getInstrument(tokenId)?.books.getLatest();
 * ```
 */
export interface TradingHotStateView {
  /** Сколько принятых мутаций изменило состояние с момента создания */
  getVersion(): number;
  /**
   * Состояние принятого рынка либо `undefined`, если рынок не принят.
   *
   * @param venueId - Площадка рынка — обязательная часть идентичности
   * @param marketId - Идентификатор рынка внутри пространства имён площадки
   *
   * @remarks
   * `undefined` — обычный ответ, а не признак проблемы: на общей шине живут
   * данные рынков, нужных коллектору или другому владельцу, и торговое
   * состояние их не хранит.
   *
   * Площадка обязательна: `MarketId` уникален только внутри своего
   * пространства имён, и поиск по одному идентификатору вернул бы «любой рынок
   * с таким id» — то есть чужой рынок при совпадении идентификаторов.
   */
  getMarket(venueId: VenueId, marketId: MarketId): MarketRuntimeStateView | undefined;
  /**
   * Идентичности всех принятых рынков — парами «площадка + рынок».
   *
   * @remarks
   * Это НЕ вселенная рынков: технически существующие рынки живут в
   * `MarketUniverse` (их бывают десятки тысяч). Здесь — только те, которые
   * торговый рантайм явно принял через `TRADING_MARKET_ADMITTED`.
   *
   * Возвращает пары, а не `MarketId[]`: из плоского списка идентификаторов
   * нельзя вызвать {@link getMarket}, а два рынка разных площадок с одинаковым
   * `marketId` в нём стали бы неотличимы.
   */
  marketIdentities(): readonly TradingMarketIdentity[];
  /**
   * Рынок площадки, которому принадлежит market-scoped инструмент.
   *
   * @param venueId - Площадка инструмента
   * @param instrumentId - Инструмент исхода
   *
   * @remarks
   * Вторичный индекс для навигации, заполняемый по обоим исходам при
   * admission. Владение остаётся за canonical `market.outcomes`. Запись
   * переживает остановку торгов и финализацию: она структурная, а не
   * наблюдаемая.
   *
   * Индекс тоже venue-scoped: одинаковый `InstrumentId` на двух площадках —
   * два разных инструмента, и запись одного не должна отвечать за другой.
   */
  getMarketForInstrument(venueId: VenueId, instrumentId: InstrumentId): MarketId | undefined;
  /** Инструмент площадки вне рынка */
  getSharedInstrument(
    venueId: VenueId,
    instrumentId: InstrumentId,
  ): SharedInstrumentStateView | undefined;
  /** Идентичности всех площадок с shared-наблюдениями */
  sharedVenueIds(): readonly VenueId[];
  /** Ряд референсных цен по полной идентичности фида */
  getReferencePriceSeries(
    key: ReferencePriceSeriesKey,
  ): RollingWindowView<ReferencePriceObservation> | undefined;
  /** Идентичности всех рядов референсных цен */
  referencePriceSeriesKeys(): readonly ReferencePriceSeriesKey[];
  /** Источники референсных цен, по которым есть наблюдения */
  referencePriceSourceIds(): readonly MarketDataSourceId[];
}
