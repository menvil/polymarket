/**
 * Оперативное состояние торгового рантайма.
 *
 * @remarks
 * Строится ТОЛЬКО из canonical application events. Ни источников, ни
 * вендорских DTO, ни wall-clock здесь нет: повтор той же последовательности
 * событий даёт то же состояние.
 *
 * Владение разделено по природе данных:
 *
 * - **market-scoped** (`marketId` есть) живёт внутри {@link MarketRuntimeState};
 * - **shared** (`marketId` отсутствует) живёт отдельно и НЕ копируется в
 *   каждый рынок: история Binance BTC/USDT одна на всех, а не по копии в
 *   каждом пятиминутном рынке.
 *
 * Маршрутизация не знает вендоров: решает наличие `marketId`, а не
 * `venueId === POLYMARKET`.
 */
import type { IClock } from '@polymarket/time';
import type { InstrumentId, MarketDataSourceId, MarketId, VenueId } from '@polymarket/ids';
import { Err, Ok, type Result, isErr } from '@polymarket/result';
import { ValidationError } from '@polymarket/errors';
import { AssetPrice, OutcomePrice } from '@polymarket/value-objects';
import { RollingWindow } from '@polymarket/rolling-window';
import {
  freezeRetentionConfig,
  retentionPolicyEntries,
  type TradingStateRetentionConfig,
} from './TradingStateRetentionConfig.js';
import { MarketInstrumentState, SharedInstrumentState } from './instrumentState.js';
import { ReferencePriceState } from './referencePriceState.js';
import { InstrumentMarketConflictError, PriceDomainMismatchError } from './errors.js';
import type {
  BookObservation,
  PublicTradeObservation,
  ReferencePriceObservation,
  ReferencePriceSeriesKey,
  TickSizeState,
} from './observations.js';
import type {
  MarketRuntimeStateView,
  SharedInstrumentStateView,
  RollingWindowView,
  TradingHotStateView,
  MarketInstrumentStateView,
} from './views.js';

/**
 * Рынок и принадлежащие ему инструменты.
 *
 * @remarks
 * Рынок — основная единица владения market-specific данными. Инструменты
 * создаются лениво: `TRADE_RECEIVED` может прийти раньше `BOOK_DEPTH`, и
 * требовать «сначала стакан» значило бы терять сделки.
 */
export class MarketRuntimeState implements MarketRuntimeStateView {
  private readonly _instruments = new Map<InstrumentId, MarketInstrumentState>();

  /**
   * @param marketId - Идентичность рынка
   * @param _config - Политики хранения рыночных рядов
   * @param _clock - Часы
   */
  constructor(
    public readonly marketId: MarketId,
    private readonly _config: TradingStateRetentionConfig,
    private readonly _clock: IClock,
  ) {}

  public getInstrument(instrumentId: InstrumentId): MarketInstrumentStateView | undefined {
    return this._instruments.get(instrumentId);
  }

  public instrumentIds(): readonly InstrumentId[] {
    return [...this._instruments.keys()];
  }

  /**
   * Возвращает инструмент, создавая его при первом наблюдении.
   *
   * @param instrumentId - Идентичность инструмента
   * @returns Состояние инструмента либо ошибка валидации политики хранения
   */
  public ensureInstrument(
    instrumentId: InstrumentId,
  ): Result<MarketInstrumentState, ValidationError> {
    const existing = this._instruments.get(instrumentId);
    if (existing !== undefined) return Ok(existing);

    const created = MarketInstrumentState.create(instrumentId, this._config.market, this._clock);
    if (isErr(created)) return created;
    this._instruments.set(instrumentId, created.value);
    return created;
  }
}

/**
 * Данные площадок, не принадлежащие ни одному рынку.
 *
 * @remarks
 * Ключ — пара «площадка + инструмент», выраженная вложенными Map.
 * Составные строки вроде `"binance:BTCUSDT"` не используются: они теряют
 * типы и делают одинаковый `instrumentId` на двух площадках неотличимым от
 * опечатки.
 */
export class SharedMarketDataState {
  private readonly _byVenue = new Map<VenueId, Map<InstrumentId, SharedInstrumentState>>();

  /**
   * @param _config - Политики хранения shared-рядов
   * @param _clock - Часы
   */
  constructor(
    private readonly _config: TradingStateRetentionConfig,
    private readonly _clock: IClock,
  ) {}

  /**
   * Возвращает инструмент площадки для чтения.
   *
   * @param venueId - Площадка
   * @param instrumentId - Инструмент площадки
   * @returns Состояние либо `undefined`, если наблюдений не было
   */
  public getInstrument(
    venueId: VenueId,
    instrumentId: InstrumentId,
  ): SharedInstrumentStateView | undefined {
    return this._byVenue.get(venueId)?.get(instrumentId);
  }

  /** Площадки, по которым есть наблюдения */
  public venueIds(): readonly VenueId[] {
    return [...this._byVenue.keys()];
  }

  /**
   * Возвращает инструмент площадки, создавая его при первом наблюдении.
   *
   * @param venueId - Площадка
   * @param instrumentId - Инструмент площадки
   * @returns Состояние либо ошибка валидации политики хранения
   */
  public ensureInstrument(
    venueId: VenueId,
    instrumentId: InstrumentId,
  ): Result<SharedInstrumentState, ValidationError> {
    let byInstrument = this._byVenue.get(venueId);
    if (byInstrument === undefined) {
      byInstrument = new Map();
      this._byVenue.set(venueId, byInstrument);
    }
    const existing = byInstrument.get(instrumentId);
    if (existing !== undefined) return Ok(existing);

    const created = SharedInstrumentState.create(
      venueId,
      instrumentId,
      this._config.shared,
      this._clock,
    );
    if (isErr(created)) return created;
    byInstrument.set(instrumentId, created.value);
    return created;
  }
}

/** Корень оперативного состояния. */
export class TradingHotState implements TradingHotStateView {
  private readonly _markets = new Map<MarketId, MarketRuntimeState>();
  private readonly _instrumentToMarket = new Map<InstrumentId, MarketId>();
  private readonly _shared: SharedMarketDataState;
  private readonly _referencePrices: ReferencePriceState;
  private _version = 0;

  private constructor(
    private readonly _config: TradingStateRetentionConfig,
    private readonly _clock: IClock,
  ) {
    this._shared = new SharedMarketDataState(_config, _clock);
    this._referencePrices = new ReferencePriceState(_config.referencePrices, _clock);
  }

  /**
   * Создаёт пустое состояние, проверив ВСЕ политики хранения.
   *
   * @param config - Конфигурация хранения
   * @param clock - Часы
   * @returns Состояние либо первая непройденная политика
   *
   * @remarks
   * Политики проверяются здесь, а не при первом событии: неверная
   * конфигурация должна падать при сборке рантайма, а не посреди торгов,
   * когда первый рынок наконец пришлёт стакан.
   *
   * Проверенный конфиг копируется и замораживается — состояние владеет
   * своей копией и не зависит от того, что вызывающий сделает со своей.
   *
   * @example
   * ```typescript
   * const state = TradingHotState.create(retention, clock);
   * if (isErr(state)) throw state.error;
   * ```
   */
  public static create(
    config: TradingStateRetentionConfig,
    clock: IClock,
  ): Result<TradingHotState, ValidationError> {
    for (const [path, policy] of retentionPolicyEntries(config)) {
      const probe = RollingWindow.create<{ observedAt: { toNumber(): number } }>(
        policy,
        clock,
        (item) => item.observedAt.toNumber(),
      );
      if (isErr(probe)) {
        return Err(
          new ValidationError(`TradingStateRetentionConfig.${path}: ${probe.error.message}`, {
            context: { path, policy },
          }),
        );
      }
    }
    // Собственная замороженная копия: `readonly` — свойство типа, а не
    // объекта, и вызывающий мог бы изменить уже проверенный конфиг через
    // свою mutable-ссылку, поменяв поведение рантайма без единого события.
    return Ok(new TradingHotState(freezeRetentionConfig(config), clock));
  }

  // ── Read API ────────────────────────────────────────────────────────────────

  public getVersion(): number {
    return this._version;
  }

  public getMarket(marketId: MarketId): MarketRuntimeStateView | undefined {
    return this._markets.get(marketId);
  }

  public marketIds(): readonly MarketId[] {
    return [...this._markets.keys()];
  }

  public getMarketForInstrument(instrumentId: InstrumentId): MarketId | undefined {
    return this._instrumentToMarket.get(instrumentId);
  }

  public getSharedInstrument(
    venueId: VenueId,
    instrumentId: InstrumentId,
  ): SharedInstrumentStateView | undefined {
    return this._shared.getInstrument(venueId, instrumentId);
  }

  public sharedVenueIds(): readonly VenueId[] {
    return this._shared.venueIds();
  }

  public getReferencePriceSeries(
    key: ReferencePriceSeriesKey,
  ): RollingWindowView<ReferencePriceObservation> | undefined {
    return this._referencePrices.getSeries(key);
  }

  public referencePriceSeriesKeys(): readonly ReferencePriceSeriesKey[] {
    return this._referencePrices.seriesKeys();
  }

  public referencePriceSourceIds(): readonly MarketDataSourceId[] {
    return this._referencePrices.sourceIds();
  }

  // ── Мутации (только для проектора) ─────────────────────────────────────────

  /**
   * Применяет снимок стакана.
   *
   * @param target - Рынок и инструмент либо площадка и инструмент
   * @param observation - Наблюдение полного стакана
   * @returns `Ok(true)` после принятия
   */
  public applyBook(
    target: ObservationTarget,
    observation: BookObservation,
  ): Result<boolean, ValidationError | InstrumentMarketConflictError> {
    const instrument = this._resolveInstrument(target);
    if (isErr(instrument)) return instrument;
    instrument.value.applyBook(observation);
    this._version += 1;
    return Ok(true);
  }

  /**
   * Применяет публичную сделку.
   *
   * @param target - Рынок и инструмент либо площадка и инструмент
   * @param observation - Наблюдение сделки с ценой в общем домене
   * @returns `Ok(true)` после принятия либо несовпадение ценового домена
   *
   * @remarks
   * Ценовой домен проверяется ПЕРВЫМ — до того, как что-либо создано.
   * `_resolveMarketInstrument`/`_resolveSharedInstrument` создают рынок,
   * инструмент и запись индекса, то есть уже мутируют состояние. Проверь мы
   * домен после них, отвергнутое событие оставило бы за собой рынок,
   * инструмент и — что хуже всего — запись `instrumentToMarket`, из-за
   * которой следующее ЗАКОННОЕ событие того же инструмента с другим рынком
   * упало бы конфликтом владения. Версия при этом говорила бы, что мутации
   * не было.
   *
   * Домен известен из самого маршрута, `instanceof` по состоянию для этого
   * не нужен: market-scoped — всегда `OutcomePrice`, shared — всегда
   * `AssetPrice`. Проверка значения — через `instanceof`, без повторной
   * валидации инварианта (ADR, Решение 9).
   *
   * Замер на записанных данных run-05 (7 163 758 ценовых уровней, 73 284
   * книги, 35 016 сделок Polymarket) показал диапазон [0.001, 0.999] и ни
   * одного значения вне (0.0001, 0.9999). Сужение безопасно, а отказ ловит
   * ошибку маршрутизации в адаптере, а не законный случай.
   */
  public applyPublicTrade(
    target: ObservationTarget,
    observation: PublicTradeObservation,
  ): Result<
    boolean,
    ValidationError | InstrumentMarketConflictError | PriceDomainMismatchError
  > {
    if (target.kind === 'MARKET') {
      const { price } = observation;
      if (!(price instanceof OutcomePrice)) {
        return Err(new PriceDomainMismatchError('OutcomePrice', price));
      }
      const instrument = this._resolveMarketInstrument(target.marketId, target.instrumentId);
      if (isErr(instrument)) return instrument;
      instrument.value.applyPublicTrade({ ...observation, price });
    } else {
      const { price } = observation;
      if (!(price instanceof AssetPrice)) {
        return Err(new PriceDomainMismatchError('AssetPrice', price));
      }
      const instrument = this._resolveSharedInstrument(target.venueId, target.instrumentId);
      if (isErr(instrument)) return instrument;
      instrument.value.applyPublicTrade({ ...observation, price });
    }

    this._version += 1;
    return Ok(true);
  }

  /**
   * Обновляет действующий шаг цены инструмента рынка.
   *
   * @param marketId - Рынок
   * @param instrumentId - Инструмент рынка
   * @param tickSize - Новое действующее значение
   * @returns `Ok(true)` после принятия
   */
  public applyTickSize(
    marketId: MarketId,
    instrumentId: InstrumentId,
    tickSize: TickSizeState,
  ): Result<boolean, ValidationError | InstrumentMarketConflictError> {
    const instrument = this._resolveMarketInstrument(marketId, instrumentId);
    if (isErr(instrument)) return instrument;
    instrument.value.applyTickSize(tickSize);
    this._version += 1;
    return Ok(true);
  }

  /**
   * Применяет наблюдение референсной цены.
   *
   * @param key - Полная идентичность фида
   * @param observation - Значение с временами площадки и наблюдения
   * @returns `Ok(true)` после принятия
   */
  public applyReferencePrice(
    key: ReferencePriceSeriesKey,
    observation: ReferencePriceObservation,
  ): Result<boolean, ValidationError> {
    const appended = this._referencePrices.append(key, observation);
    if (isErr(appended)) return appended;
    this._version += 1;
    return Ok(true);
  }

  /**
   * Находит инструмент рынка, создавая рынок и инструмент при первом наблюдении.
   *
   * @param marketId - Рынок
   * @param instrumentId - Инструмент рынка
   * @returns Состояние инструмента либо нарушение инварианта владения
   *
   * @remarks
   * **Метод мутирует состояние**: создаёт `MarketRuntimeState`,
   * `MarketInstrumentState` и запись вторичного индекса. Вызывать его можно
   * только после того, как все проверки события пройдены — иначе
   * отвергнутое событие оставит за собой созданные объекты.
   *
   * Проверка владения идёт ДО создания: если market-specific инструмент
   * зарегистрирован за другим рынком, состояние закрывается ошибкой, а не
   * переносит инструмент молча — молчаливый перенос оставил бы часть
   * истории на старом рынке и сделал бы оба состояния неверными.
   */
  private _resolveMarketInstrument(
    marketId: MarketId,
    instrumentId: InstrumentId,
  ): Result<MarketInstrumentState, ValidationError | InstrumentMarketConflictError> {
    const registered = this._instrumentToMarket.get(instrumentId);
    if (registered !== undefined && registered !== marketId) {
      return Err(new InstrumentMarketConflictError(instrumentId, registered, marketId));
    }

    let market = this._markets.get(marketId);
    if (market === undefined) {
      market = new MarketRuntimeState(marketId, this._config, this._clock);
      this._markets.set(marketId, market);
    }
    const instrument = market.ensureInstrument(instrumentId);
    if (isErr(instrument)) return instrument;
    this._instrumentToMarket.set(instrumentId, marketId);
    return instrument;
  }

  /**
   * Находит инструмент площадки, создавая его при первом наблюдении.
   *
   * @param venueId - Площадка
   * @param instrumentId - Инструмент площадки
   * @returns Состояние инструмента либо ошибка валидации политики хранения
   *
   * @remarks
   * **Метод мутирует состояние** — см. {@link _resolveMarketInstrument}.
   */
  private _resolveSharedInstrument(
    venueId: VenueId,
    instrumentId: InstrumentId,
  ): Result<SharedInstrumentState, ValidationError> {
    return this._shared.ensureInstrument(venueId, instrumentId);
  }

  /**
   * Находит инструмент по маршруту наблюдения.
   *
   * @param target - Куда направлено наблюдение
   * @returns Состояние инструмента либо нарушение инварианта владения
   *
   * @remarks
   * **Метод мутирует состояние** — см. {@link _resolveMarketInstrument}.
   * Используется там, где у наблюдения нет проверок сверх владения.
   */
  private _resolveInstrument(
    target: ObservationTarget,
  ): Result<
    MarketInstrumentState | SharedInstrumentState,
    ValidationError | InstrumentMarketConflictError
  > {
    return target.kind === 'MARKET'
      ? this._resolveMarketInstrument(target.marketId, target.instrumentId)
      : this._resolveSharedInstrument(target.venueId, target.instrumentId);
  }
}

/** Куда направлено наблюдение: в рынок или в общие данные площадки. */
export type ObservationTarget =
  | {
      /** Наблюдение принадлежит конкретному рынку */
      readonly kind: 'MARKET';
      readonly marketId: MarketId;
      readonly instrumentId: InstrumentId;
    }
  | {
      /** Наблюдение принадлежит площадке и не связано с рынком */
      readonly kind: 'SHARED';
      readonly venueId: VenueId;
      readonly instrumentId: InstrumentId;
    };
