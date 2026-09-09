/**
 * Ряды наблюдений одного инструмента — рыночного и площадочного.
 *
 * @remarks
 * Текущее значение ряда НЕ дублируется отдельным полем: `getLatest()` у
 * `RollingWindow` работает за O(1), а вторая ссылка на тот же объект только
 * добавляет способ рассинхронизировать состояние с историей.
 *
 * Исключение — `tickSize`: это не ряд, а одно действующее значение, и
 * истории его смен в этом MR никто не требует.
 */
import { RollingWindow } from '@polymarket/rolling-window';
import type { IClock } from '@polymarket/time';
import type { InstrumentId, VenueId } from '@polymarket/ids';
import { Ok, type Result, isErr } from '@polymarket/result';
import type { ValidationError } from '@polymarket/errors';
import type { InstrumentRetentionConfig } from './TradingStateRetentionConfig.js';
import type {
  BookObservation,
  Observation,
  PublicTradeObservation,
  TickSizeState,
  TopOfBookObservation,
} from './observations.js';
import type { MarketInstrumentStateView, SharedInstrumentStateView } from './views.js';

/**
 * Время наблюдения записи — единственная основа retention.
 *
 * @param observation - Любая запись наблюдения
 * @returns Момент наблюдения в миллисекундах
 *
 * @remarks
 * `RollingWindow.append()` вытесняет относительно времени ДОБАВЛЯЕМОГО
 * элемента, а не показаний часов. Поэтому, пока сюда подаётся
 * `metadata.createdAt`, повтор той же последовательности событий даёт то же
 * состояние — независимо от того, когда его запускают.
 */
function observedAtMs(observation: Observation): number {
  return observation.observedAt.toNumber();
}

/** Три ряда наблюдений, общие для рыночного и площадочного инструмента. */
interface InstrumentSeries {
  readonly topOfBooks: RollingWindow<TopOfBookObservation>;
  readonly books: RollingWindow<BookObservation>;
  readonly publicTrades: RollingWindow<PublicTradeObservation>;
}

/**
 * Создаёт три ряда по конфигу хранения.
 *
 * @param config - Политики для верхушки, снимков и сделок
 * @param clock - Часы (используются только чтением `getRecent()` без явного `nowMs`)
 * @returns Ряды либо первая же ошибка валидации политики
 */
function createSeries(
  config: InstrumentRetentionConfig,
  clock: IClock,
): Result<InstrumentSeries, ValidationError> {
  const topOfBooks = RollingWindow.create<TopOfBookObservation>(
    config.topOfBooks,
    clock,
    observedAtMs,
  );
  if (isErr(topOfBooks)) return topOfBooks;

  const books = RollingWindow.create<BookObservation>(config.books, clock, observedAtMs);
  if (isErr(books)) return books;

  const publicTrades = RollingWindow.create<PublicTradeObservation>(
    config.trades,
    clock,
    observedAtMs,
  );
  if (isErr(publicTrades)) return publicTrades;

  return Ok({
    topOfBooks: topOfBooks.value,
    books: books.value,
    publicTrades: publicTrades.value,
  });
}

/**
 * Решает, принимать ли обновление верхушки стакана.
 *
 * @param series - Ряд верхушек одного логического потока
 * @param sequenceNumber - Номер пришедшего обновления
 * @returns `true`, если обновление новее последнего принятого
 *
 * @remarks
 * Логический поток — это «рынок + инструмент» либо «площадка + инструмент».
 * Номер последнего принятого берётся из самого ряда: отдельное поле было бы
 * вторым источником правды о том же.
 *
 * Устаревшее или повторное обновление не добавляется, не меняет последнее
 * значение и не увеличивает версию состояния.
 */
function acceptsSequence(
  series: RollingWindow<TopOfBookObservation>,
  sequenceNumber: number,
): boolean {
  const latest = series.getLatest();
  return latest === undefined || sequenceNumber > latest.sequenceNumber;
}

/** Инструмент, принадлежащий конкретному рынку. */
export class MarketInstrumentState implements MarketInstrumentStateView {
  private _tickSize: TickSizeState | undefined;

  private constructor(
    public readonly instrumentId: InstrumentId,
    private readonly _series: InstrumentSeries,
  ) {}

  /**
   * Создаёт состояние инструмента рынка.
   *
   * @param instrumentId - Идентичность инструмента
   * @param config - Политики хранения рыночных рядов
   * @param clock - Часы
   * @returns Состояние либо ошибка валидации политики
   *
   * @example
   * ```typescript
   * const state = MarketInstrumentState.create(tokenId, retention.market, clock);
   * ```
   */
  public static create(
    instrumentId: InstrumentId,
    config: InstrumentRetentionConfig,
    clock: IClock,
  ): Result<MarketInstrumentState, ValidationError> {
    const series = createSeries(config, clock);
    if (isErr(series)) return series;
    return Ok(new MarketInstrumentState(instrumentId, series.value));
  }

  public get topOfBooks(): RollingWindow<TopOfBookObservation> {
    return this._series.topOfBooks;
  }

  public get books(): RollingWindow<BookObservation> {
    return this._series.books;
  }

  public get publicTrades(): RollingWindow<PublicTradeObservation> {
    return this._series.publicTrades;
  }

  public get tickSize(): TickSizeState | undefined {
    return this._tickSize;
  }

  /**
   * Принимает обновление верхушки стакана, если оно не устарело.
   *
   * @param observation - Наблюдение с монотонным номером
   * @returns `true`, если наблюдение принято и состояние изменилось
   */
  public applyTopOfBook(observation: TopOfBookObservation): boolean {
    if (!acceptsSequence(this._series.topOfBooks, observation.sequenceNumber)) return false;
    this._series.topOfBooks.append(observation);
    return true;
  }

  /**
   * Добавляет снимок стакана.
   *
   * @param observation - Наблюдение полного стакана
   */
  public applyBook(observation: BookObservation): void {
    this._series.books.append(observation);
  }

  /**
   * Добавляет публичную сделку.
   *
   * @param observation - Наблюдение сделки
   */
  public applyPublicTrade(observation: PublicTradeObservation): void {
    this._series.publicTrades.append(observation);
  }

  /**
   * Обновляет действующий шаг цены.
   *
   * @param tickSize - Новое действующее значение
   */
  public applyTickSize(tickSize: TickSizeState): void {
    this._tickSize = tickSize;
  }
}

/**
 * Инструмент площадки, не принадлежащий рынку.
 *
 * @remarks
 * Отличается от {@link MarketInstrumentState} наличием площадки в
 * идентичности и отсутствием шага цены: шаг — свойство рынка Polymarket, а
 * не общей ленты площадки.
 */
export class SharedInstrumentState implements SharedInstrumentStateView {
  private constructor(
    public readonly venueId: VenueId,
    public readonly instrumentId: InstrumentId,
    private readonly _series: InstrumentSeries,
  ) {}

  /**
   * Создаёт состояние инструмента площадки.
   *
   * @param venueId - Площадка
   * @param instrumentId - Инструмент площадки
   * @param config - Политики хранения shared-рядов
   * @param clock - Часы
   * @returns Состояние либо ошибка валидации политики
   */
  public static create(
    venueId: VenueId,
    instrumentId: InstrumentId,
    config: InstrumentRetentionConfig,
    clock: IClock,
  ): Result<SharedInstrumentState, ValidationError> {
    const series = createSeries(config, clock);
    if (isErr(series)) return series;
    return Ok(new SharedInstrumentState(venueId, instrumentId, series.value));
  }

  public get topOfBooks(): RollingWindow<TopOfBookObservation> {
    return this._series.topOfBooks;
  }

  public get books(): RollingWindow<BookObservation> {
    return this._series.books;
  }

  public get publicTrades(): RollingWindow<PublicTradeObservation> {
    return this._series.publicTrades;
  }

  /**
   * Принимает обновление верхушки стакана, если оно не устарело.
   *
   * @param observation - Наблюдение с монотонным номером
   * @returns `true`, если наблюдение принято и состояние изменилось
   */
  public applyTopOfBook(observation: TopOfBookObservation): boolean {
    if (!acceptsSequence(this._series.topOfBooks, observation.sequenceNumber)) return false;
    this._series.topOfBooks.append(observation);
    return true;
  }

  /**
   * Добавляет снимок стакана.
   *
   * @param observation - Наблюдение полного стакана
   */
  public applyBook(observation: BookObservation): void {
    this._series.books.append(observation);
  }

  /**
   * Добавляет публичную сделку.
   *
   * @param observation - Наблюдение сделки
   */
  public applyPublicTrade(observation: PublicTradeObservation): void {
    this._series.publicTrades.append(observation);
  }
}

export { observedAtMs };
