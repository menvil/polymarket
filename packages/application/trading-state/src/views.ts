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
 * const latest = state.getMarket(marketId)?.getInstrument(instrumentId)?.books.getLatest();
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
  /** История публичных сделок (`TRADE_RECEIVED`) */
  readonly publicTrades: RollingWindowView<PublicTradeObservation>;
  /**
   * Действующий шаг цены.
   *
   * @remarks
   * Хранится текущим значением, а не историей: в этом MR история смен шага
   * никому не нужна, а ряд ради одного значения — лишняя память.
   */
  readonly tickSize: TickSizeState | undefined;
}

/** Рынок — только чтение. */
export interface MarketRuntimeStateView {
  /** Идентичность рынка */
  readonly marketId: MarketId;
  /** Инструмент рынка либо `undefined`, если наблюдений по нему не было */
  getInstrument(instrumentId: InstrumentId): MarketInstrumentStateView | undefined;
  /** Идентичности всех инструментов, по которым есть наблюдения */
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
  /** История публичных сделок */
  readonly publicTrades: RollingWindowView<PublicTradeObservation>;
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
 * const book = view.getMarket(marketId)?.getInstrument(tokenId)?.books.getLatest();
 * ```
 */
export interface TradingHotStateView {
  /** Сколько принятых наблюдений изменило состояние с момента создания */
  getVersion(): number;
  /** Состояние рынка либо `undefined`, если наблюдений по нему не было */
  getMarket(marketId: MarketId): MarketRuntimeStateView | undefined;
  /** Идентичности всех рынков с наблюдениями */
  marketIds(): readonly MarketId[];
  /**
   * Рынок, которому принадлежит market-scoped инструмент.
   *
   * @remarks
   * Вторичный индекс для навигации. Владение остаётся за
   * `markets[marketId].instruments[instrumentId]`.
   */
  getMarketForInstrument(instrumentId: InstrumentId): MarketId | undefined;
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
