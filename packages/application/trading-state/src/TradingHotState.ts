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
 * - **market-scoped** (`marketId` есть) живёт внутри {@link MarketRuntimeState}
 *   и существует ТОЛЬКО для рынков, принятых торговым рантаймом;
 * - **shared** (`marketId` отсутствует) живёт отдельно и НЕ копируется в
 *   каждый рынок: история Binance BTC/USDT одна на всех, а не по копии в
 *   каждом пятиминутном рынке.
 *
 * Маршрутизация не знает вендоров: решает наличие `marketId`, а не
 * `venueId === POLYMARKET`.
 *
 * ### Идентичность рынка — ПАРА «площадка + рынок»
 *
 * ```text
 * markets:            VenueId → MarketId    → MarketRuntimeState
 * instrumentToMarket: VenueId → InstrumentId → MarketId
 * ```
 *
 * `MarketId` и `InstrumentId` уникальны только внутри пространства имён своей
 * площадки, поэтому `POLYMARKET:X` и `KALSHI:X` — два РАЗНЫХ рынка. Плоский
 * `Map<MarketId, …>` означал бы, что стакан чужой площадки с совпавшим
 * идентификатором тихо ложится в наш рынок, а при несовпавшем инструменте даёт
 * ложный аварийный отказ вместо игнорирования чужих данных. То же правило уже
 * действует в `Market.equals()` и в ключе `MarketUniverse`.
 *
 * Вложенные `Map`, а не составная строка `"POLYMARKET:X"`: строка теряет типы и
 * делает совпадение идентификаторов неотличимым от опечатки (та же причина, по
 * которой так устроено и shared-состояние).
 *
 * ### Рынок создаётся только через admission
 *
 * ```text
 * TRADING_MARKET_ADMITTED → MarketRuntimeState + оба инструмента + индексы
 * BOOK_DEPTH / TRADE_RECEIVED / TICK_SIZE_CHANGED → только наполняют ряды
 * ```
 *
 * `IEventBus` — общая семантическая шина: на ней живут данные рынков, нужных
 * коллектору, другому владельцу или будущей стратегии. Торговое состояние
 * хранит только те рынки, которые приняло само, поэтому market-data по
 * непринятому рынку ИГНОРИРУЕТСЯ — без ошибки и без роста версии. Ленивое
 * создание рынка «от первой книги» отсюда убрано: оно означало бы, что
 * владение инструментом выводится задним числом из наблюдения, а не берётся
 * из canonical `Market`.
 *
 * Shared-данные (CEX, референсные цены) от admission не зависят вовсе: они
 * описывают актив, а не рынок.
 */
import type { IClock } from '@polymarket/time';
import type { InstrumentId, MarketDataSourceId, MarketId, VenueId } from '@polymarket/ids';
import type { Market } from '@polymarket/market';
import type { Timestamp } from '@polymarket/timestamp';
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
import { acceptsMarketData, type TradingMarketLifecycleStatus } from './lifecycle.js';
import { findTradingMarketStructureDifference } from './marketStructure.js';
import {
  InstrumentMarketConflictError,
  PriceDomainMismatchError,
  TradingMarketAdmissionStateError,
  TradingMarketAdmissionTimingError,
  TradingMarketAlreadyAdmittedError,
  TradingMarketLifecycleTransitionError,
  TradingMarketStructureConflictError,
  UnknownTradingMarketInstrumentError,
} from './errors.js';
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
  TradingMarketIdentity,
  MarketInstrumentStateView,
} from './views.js';
import type { TradingMarketLifecycleView } from './lifecycle.js';

/** Ошибки перехода жизненного цикла рынка. */
export type TradingMarketTransitionError =
  | TradingMarketLifecycleTransitionError
  | TradingMarketStructureConflictError;

/**
 * Принятый рынок: canonical `Market`, наш жизненный цикл и активные данные.
 *
 * @remarks
 * Структура состояния:
 *
 * ```text
 * MarketRuntimeState
 * ├── market      canonical Market (после резолюции — RESOLVED)
 * ├── lifecycle   ADMITTED → ACTIVE → TRADING_CLOSED → RESOLVED → FINALIZED
 * └── instruments оба исхода: books, publicTrades, tickSize
 * ```
 *
 * Ни `question`, ни `startsAt`, ни `outcomeIds`, ни `family` не копируются
 * отдельными полями: они уже есть в `market`, и вторая копия неизбежно с ним
 * разошлась бы.
 *
 * Инструменты создаются СРАЗУ при admission — оба, до первого стакана.
 * Владение инструментом известно из canonical метаданных рынка, а не
 * выводится из того, чья книга пришла первой.
 *
 * Тяжёлые ряды (`books`/`publicTrades`/`tickSize`) — active-only состояние: на
 * остановке торгов они освобождаются, а compact-часть (рынок, жизненный цикл,
 * структурный состав инструментов) остаётся жить. Позже к compact-части
 * добавятся ордера, филлы, позиции, решения и итог — они обязаны переживать
 * закрытие торгов.
 */
export class MarketRuntimeState implements MarketRuntimeStateView {
  private readonly _instruments = new Map<InstrumentId, MarketInstrumentState>();
  private readonly _structuralInstrumentIds: readonly InstrumentId[];
  private _market: Market;
  private _status: TradingMarketLifecycleStatus = 'ADMITTED';
  private _activatedAt: Timestamp | undefined;
  private _tradingClosedAt: Timestamp | undefined;
  private _resolvedAt: Timestamp | undefined;
  private _finalizedAt: Timestamp | undefined;
  private _lifecycle: TradingMarketLifecycleView;

  private constructor(
    market: Market,
    private readonly _admittedAt: Timestamp,
    instruments: readonly MarketInstrumentState[],
  ) {
    this._market = market;
    // Заморожено: состав исходов — структурный инвариант рынка, и отдавать
    // наружу массив, который потребитель может изменить, значило бы позволить
    // ему «переопределить» инструменты принятого рынка через read-проекцию.
    this._structuralInstrumentIds = Object.freeze(
      market.outcomes.map((outcome) => outcome.instrumentId),
    );
    for (const instrument of instruments) {
      this._instruments.set(instrument.instrumentId, instrument);
    }
    this._lifecycle = this._buildLifecycle();
  }

  /**
   * Создаёт состояние принятого рынка вместе с ОБОИМИ инструментами.
   *
   * @param market - Canonical рынок (проверки admission делает вызывающий)
   * @param admittedAt - Момент admission, он же `metadata.createdAt`
   * @param config - Политики хранения рыночных рядов
   * @param clock - Часы
   * @returns Состояние либо первая непройденная политика хранения
   *
   * @remarks
   * Оба инструмента создаются здесь, а не при первом наблюдении: canonical
   * `Market` гарантирует ровно два исхода с различными `InstrumentId`, и
   * ждать стакана незачем — стратегия, спросившая инструмент до первой книги,
   * получила бы `undefined` там, где рынок уже принят.
   *
   * Объект возвращается целиком либо не возвращается вовсе: частично
   * созданного рынка с одним инструментом не существует.
   *
   * @example
   * ```typescript
   * const state = MarketRuntimeState.admit(market, admittedAt, retention.market, clock);
   * if (isErr(state)) throw state.error;
   * ```
   */
  public static admit(
    market: Market,
    admittedAt: Timestamp,
    config: TradingStateRetentionConfig,
    clock: IClock,
  ): Result<MarketRuntimeState, ValidationError> {
    const instruments: MarketInstrumentState[] = [];
    for (const outcome of market.outcomes) {
      const created = MarketInstrumentState.create(outcome.instrumentId, config.market, clock);
      if (isErr(created)) return created;
      instruments.push(created.value);
    }
    return Ok(new MarketRuntimeState(market, admittedAt, instruments));
  }

  // ── Read API ────────────────────────────────────────────────────────────────

  public get market(): Market {
    return this._market;
  }

  public get lifecycle(): TradingMarketLifecycleView {
    return this._lifecycle;
  }

  public getInstrument(instrumentId: InstrumentId): MarketInstrumentStateView | undefined {
    return this._instruments.get(instrumentId);
  }

  public instrumentIds(): readonly InstrumentId[] {
    return this._structuralInstrumentIds;
  }

  /**
   * Принадлежит ли инструмент этому рынку структурно.
   *
   * @param instrumentId - Идентичность инструмента
   * @returns `true`, если это один из двух исходов рынка
   *
   * @remarks
   * Отвечает по canonical `market.outcomes`, а не по текущим рядам, поэтому
   * ответ не меняется после освобождения тяжёлых данных.
   */
  public hasInstrument(instrumentId: InstrumentId): boolean {
    return this._structuralInstrumentIds.includes(instrumentId);
  }

  /**
   * Принимает ли рынок сейчас новые наблюдения площадки.
   *
   * @returns `true` в фазах `ADMITTED` и `ACTIVE`
   */
  public acceptsMarketData(): boolean {
    return acceptsMarketData(this._status);
  }

  /**
   * Изменяемое состояние инструмента, если тяжёлые данные ещё удерживаются.
   *
   * @param instrumentId - Идентичность инструмента
   * @returns Состояние либо `undefined` после освобождения на закрытии торгов
   *
   * @remarks
   * Единственный путь к мутации рядов; наружу из пакета не выходит, потому что
   * сам класс не экспортируется.
   */
  public activeInstrument(instrumentId: InstrumentId): MarketInstrumentState | undefined {
    return this._instruments.get(instrumentId);
  }

  // ── Переходы жизненного цикла ──────────────────────────────────────────────

  /**
   * `ADMITTED → ACTIVE`: начинается торговля.
   *
   * @param activatedAt - `metadata.createdAt` события активации
   * @returns `Ok` после перехода либо причина отказа
   *
   * @remarks
   * Требуется `market.startsAt <= activatedAt < market.expiresAt`. Ранняя
   * активация запрещена, потому что до `startsAt` торговать нечем; активация
   * после `expiresAt` — потому что торговать уже поздно.
   *
   * Планировщика здесь нет: кто публикует активацию ровно на `startsAt` —
   * ответственность будущей композиции рантайма.
   *
   * @example
   * ```typescript
   * const activated = state.activate(event.metadata.createdAt);
   * if (isErr(activated)) throw activated.error;
   * ```
   */
  public activate(activatedAt: Timestamp): Result<void, TradingMarketLifecycleTransitionError> {
    if (this._status !== 'ADMITTED') return Err(this._phaseError('ACTIVE'));
    if (activatedAt.isBefore(this._market.startsAt)) {
      return Err(
        this._timingError(
          'ACTIVE',
          `activatedAt ${activatedAt.toISO()} is before market startsAt ` +
            `${this._market.startsAt.toISO()}`,
        ),
      );
    }
    if (activatedAt.isAfterOrEqual(this._market.expiresAt)) {
      return Err(
        this._timingError(
          'ACTIVE',
          `activatedAt ${activatedAt.toISO()} is at or after market expiresAt ` +
            `${this._market.expiresAt.toISO()}`,
        ),
      );
    }

    this._status = 'ACTIVE';
    this._activatedAt = activatedAt;
    this._lifecycle = this._buildLifecycle();
    return Ok(undefined);
  }

  /**
   * `ACTIVE → TRADING_CLOSED`: МЫ прекращаем торговать.
   *
   * @param closedAt - `metadata.createdAt` события закрытия
   * @returns `Ok` после перехода либо причина отказа
   *
   * @remarks
   * Закрыть раньше `expiresAt` разрешено — это понадобится для risk,
   * kill switch, venue halt и контролируемой остановки. Причины закрытия пока
   * не моделируются: набор, угаданный без producer-ов, оказался бы либо
   * неполным, либо мёртвым.
   *
   * Переход освобождает тяжёлые ряды инструментов, но НЕ удаляет рынок:
   * compact-состояние остаётся (см. {@link MarketRuntimeState}).
   */
  public closeTrading(closedAt: Timestamp): Result<void, TradingMarketLifecycleTransitionError> {
    if (this._status !== 'ACTIVE') return Err(this._phaseError('TRADING_CLOSED'));
    const activatedAt = this._activatedAt;
    if (activatedAt !== undefined && closedAt.isBefore(activatedAt)) {
      return Err(
        this._timingError(
          'TRADING_CLOSED',
          `tradingClosedAt ${closedAt.toISO()} is before activatedAt ${activatedAt.toISO()}`,
        ),
      );
    }

    this._status = 'TRADING_CLOSED';
    this._tradingClosedAt = closedAt;
    this._dropActiveMarketData();
    this._lifecycle = this._buildLifecycle();
    return Ok(undefined);
  }

  /**
   * `ACTIVE | TRADING_CLOSED → RESOLVED`: площадка объявила исход.
   *
   * @param incoming - Canonical рынок в состоянии `RESOLVED`
   * @param resolvedAt - `metadata.createdAt` события резолюции
   * @returns `Ok` после перехода либо причина отказа
   *
   * @remarks
   * Переход из `ACTIVE` разрешён: внешний источник может отдать резолюцию
   * сразу, а промежуточное закрытие мы могли не увидеть или не успеть
   * опубликовать. В этом случае `tradingClosedAt` ставится равным
   * `resolvedAt` и тяжёлые данные освобождаются тем же переходом — разрешённый
   * рынок не остаётся торгово активным.
   *
   * Из `ADMITTED` резолюция отвергается: рынок, по которому торговля не
   * начиналась, наш рантайм разрешить не может, и такой переход означал бы
   * mid-market catch-up.
   *
   * Сохранённый `Market` заменяется целиком — так резолюция одновременно
   * обновляет внешнее состояние и даёт победителя через
   * `market.resolvedOutcome`. Поэтому структура обязана совпасть: подмена
   * структуры оставила бы накопленную историю относящейся к рынку, которого в
   * состоянии больше нет.
   */
  public resolve(
    incoming: Market,
    resolvedAt: Timestamp,
  ): Result<void, TradingMarketTransitionError> {
    if (!incoming.isResolved()) {
      return Err(
        new TradingMarketLifecycleTransitionError(
          this._market.venueId,
          this._market.id,
          'RESOLVED',
          this._status,
          'PAYLOAD',
          `incoming market venue state is ${incoming.state.status}, expected RESOLVED`,
        ),
      );
    }
    if (this._status !== 'ACTIVE' && this._status !== 'TRADING_CLOSED') {
      return Err(this._phaseError('RESOLVED'));
    }

    const difference = findTradingMarketStructureDifference(this._market, incoming);
    if (difference !== undefined) {
      return Err(
        new TradingMarketStructureConflictError(
          this._market.venueId,
          this._market.id,
          difference,
        ),
      );
    }

    const notBefore = this._tradingClosedAt ?? this._activatedAt;
    if (notBefore !== undefined && resolvedAt.isBefore(notBefore)) {
      return Err(
        this._timingError(
          'RESOLVED',
          `resolvedAt ${resolvedAt.toISO()} is before ${notBefore.toISO()}`,
        ),
      );
    }

    this._market = incoming;
    this._status = 'RESOLVED';
    this._resolvedAt = resolvedAt;
    // Резолюция из ACTIVE закрывает торговлю тем же переходом: разрешённый
    // рынок не может остаться торгово активным, а второго события мы можем
    // никогда не увидеть.
    this._tradingClosedAt = this._tradingClosedAt ?? resolvedAt;
    this._dropActiveMarketData();
    this._lifecycle = this._buildLifecycle();
    return Ok(undefined);
  }

  /**
   * `RESOLVED → FINALIZED`: работа по рынку закончена.
   *
   * @param finalizedAt - `metadata.createdAt` события финализации
   * @returns `Ok` после перехода либо причина отказа
   *
   * @remarks
   * Состояние рынка НЕ удаляется: это retained compact market. Выселение из
   * памяти появится вместе с durable Market History — пока сохранять некуда.
   */
  public finalize(finalizedAt: Timestamp): Result<void, TradingMarketLifecycleTransitionError> {
    if (this._status !== 'RESOLVED') return Err(this._phaseError('FINALIZED'));
    const resolvedAt = this._resolvedAt;
    if (resolvedAt !== undefined && finalizedAt.isBefore(resolvedAt)) {
      return Err(
        this._timingError(
          'FINALIZED',
          `finalizedAt ${finalizedAt.toISO()} is before resolvedAt ${resolvedAt.toISO()}`,
        ),
      );
    }

    this._status = 'FINALIZED';
    this._finalizedAt = finalizedAt;
    this._lifecycle = this._buildLifecycle();
    return Ok(undefined);
  }

  /**
   * Освобождает тяжёлые active-only данные инструментов.
   *
   * @remarks
   * Удаляются состояния инструментов целиком — вместе с рядами стакана,
   * сделок и текущим шагом цены. Структурная идентичность при этом не
   * теряется: она живёт в canonical `market.outcomes`, поэтому
   * `instrumentIds()` продолжает отдавать оба исхода, а `getInstrument()`
   * начинает отвечать `undefined`.
   */
  private _dropActiveMarketData(): void {
    this._instruments.clear();
  }

  /** Пересобирает неизменяемое представление жизненного цикла. */
  private _buildLifecycle(): TradingMarketLifecycleView {
    return Object.freeze({
      status: this._status,
      admittedAt: this._admittedAt,
      ...(this._activatedAt === undefined ? {} : { activatedAt: this._activatedAt }),
      ...(this._tradingClosedAt === undefined ? {} : { tradingClosedAt: this._tradingClosedAt }),
      ...(this._resolvedAt === undefined ? {} : { resolvedAt: this._resolvedAt }),
      ...(this._finalizedAt === undefined ? {} : { finalizedAt: this._finalizedAt }),
    });
  }

  /** Отказ по фазе: переход запрещён из текущего статуса. */
  private _phaseError(
    target: TradingMarketLifecycleStatus,
  ): TradingMarketLifecycleTransitionError {
    return new TradingMarketLifecycleTransitionError(
      this._market.venueId,
      this._market.id,
      target,
      this._status,
      'PHASE',
    );
  }

  /** Отказ по времени: переход нарушает временной инвариант. */
  private _timingError(
    target: TradingMarketLifecycleStatus,
    detail: string,
  ): TradingMarketLifecycleTransitionError {
    return new TradingMarketLifecycleTransitionError(
      this._market.venueId,
      this._market.id,
      target,
      this._status,
      'TIMING',
      detail,
    );
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
 *
 * От admission рынков это состояние не зависит: инструмент биржи описывает
 * актив, и ждать под него принятого рынка предсказаний бессмысленно.
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
  private readonly _markets = new Map<VenueId, Map<MarketId, MarketRuntimeState>>();
  private readonly _instrumentToMarket = new Map<VenueId, Map<InstrumentId, MarketId>>();
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

  public getMarket(venueId: VenueId, marketId: MarketId): MarketRuntimeStateView | undefined {
    return this._markets.get(venueId)?.get(marketId);
  }

  public marketIdentities(): readonly TradingMarketIdentity[] {
    const identities: TradingMarketIdentity[] = [];
    for (const [venueId, byMarket] of this._markets) {
      for (const marketId of byMarket.keys()) identities.push({ venueId, marketId });
    }
    return identities;
  }

  public getMarketForInstrument(
    venueId: VenueId,
    instrumentId: InstrumentId,
  ): MarketId | undefined {
    return this._instrumentToMarket.get(venueId)?.get(instrumentId);
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

  // ── Жизненный цикл рынка (только для проектора) ────────────────────────────

  /**
   * Принимает рынок к торговле: единственный способ создать состояние рынка.
   *
   * @param market - Canonical рынок из `TRADING_MARKET_ADMITTED`
   * @param admittedAt - `metadata.createdAt` события
   * @returns `Ok(true)` после принятия либо причина отказа
   *
   * @remarks
   * Проверки идут ВСЕ до единой мутации:
   *
   * ```text
   * 1. рынок с таким MarketId ещё не принят
   * 2. внешнее состояние рынка — ACTIVE (не CLOSED/RESOLVED)
   * 3. admittedAt < market.startsAt          (ровно в startsAt уже поздно)
   * 4. ОБА instrumentId свободны
   * 5. политики хранения проходят для обоих инструментов
   * ```
   *
   * Порядок важен именно этим: конфликт по ВТОРОМУ исходу не должен оставить
   * за собой ни зарегистрированный первый инструмент, ни сам рынок. Поэтому
   * оба инструмента проверяются до того, как в индекс попадёт хотя бы одна
   * запись, а состояние рынка собирается целиком и лишь затем публикуется в
   * `_markets`.
   *
   * Идентичность рынка не проверяется вручную: `Market` уже провалидирован
   * при создании — ровно два исхода с различными canonical `InstrumentId`,
   * `startsAt < expiresAt`, семейство со своей спецификацией.
   *
   * @example
   * ```typescript
   * const admitted = state.admitMarket(market, event.metadata.createdAt);
   * if (isErr(admitted)) throw admitted.error;
   * ```
   */
  public admitMarket(
    market: Market,
    admittedAt: Timestamp,
  ): Result<
    boolean,
    | ValidationError
    | InstrumentMarketConflictError
    | TradingMarketAlreadyAdmittedError
    | TradingMarketAdmissionStateError
    | TradingMarketAdmissionTimingError
  > {
    const venueId = market.venueId;
    const existing = this._markets.get(venueId)?.get(market.id);
    if (existing !== undefined) {
      return Err(
        new TradingMarketAlreadyAdmittedError(venueId, market.id, existing.lifecycle.status),
      );
    }
    if (!market.isActive()) {
      return Err(
        new TradingMarketAdmissionStateError(venueId, market.id, market.state.status),
      );
    }
    if (admittedAt.isAfterOrEqual(market.startsAt)) {
      return Err(
        new TradingMarketAdmissionTimingError(venueId, market.id, admittedAt, market.startsAt),
      );
    }
    // Владение инструментом проверяется В ПРЕДЕЛАХ ПЛОЩАДКИ: одинаковый
    // `InstrumentId` у Polymarket и у другой площадки — два разных инструмента,
    // и занятость одного не может блокировать admission другого.
    const venueInstruments = this._instrumentToMarket.get(venueId);
    for (const outcome of market.outcomes) {
      const owner = venueInstruments?.get(outcome.instrumentId);
      if (owner !== undefined) {
        return Err(
          new InstrumentMarketConflictError(venueId, outcome.instrumentId, owner, market.id),
        );
      }
    }

    const created = MarketRuntimeState.admit(market, admittedAt, this._config, this._clock);
    if (isErr(created)) return created;

    this._venueMarkets(venueId).set(market.id, created.value);
    const instrumentIndex = this._venueInstruments(venueId);
    for (const outcome of market.outcomes) {
      instrumentIndex.set(outcome.instrumentId, market.id);
    }
    this._version += 1;
    return Ok(true);
  }

  /**
   * Переводит принятый рынок в торговлю (`ADMITTED → ACTIVE`).
   *
   * @param marketId - Рынок из `TRADING_MARKET_ACTIVATED`
   * @param activatedAt - `metadata.createdAt` события
   * @returns `Ok(true)` после перехода либо причина отказа
   */
  public activateMarket(
    venueId: VenueId,
    marketId: MarketId,
    activatedAt: Timestamp,
  ): Result<boolean, TradingMarketLifecycleTransitionError> {
    const market = this._requireMarket(venueId, marketId, 'ACTIVE');
    if (isErr(market)) return market;
    const activated = market.value.activate(activatedAt);
    if (isErr(activated)) return activated;
    this._version += 1;
    return Ok(true);
  }

  /**
   * Останавливает торговлю по рынку (`ACTIVE → TRADING_CLOSED`).
   *
   * @param marketId - Рынок из `TRADING_MARKET_CLOSED`
   * @param closedAt - `metadata.createdAt` события
   * @returns `Ok(true)` после перехода либо причина отказа
   *
   * @remarks
   * Переход освобождает тяжёлые ряды инструментов и оставляет compact-рынок.
   * Версия растёт на ЕДИНИЦУ, хотя изменились и жизненный цикл, и данные: это
   * одна принятая мутация состояния.
   */
  public closeMarketTrading(
    venueId: VenueId,
    marketId: MarketId,
    closedAt: Timestamp,
  ): Result<boolean, TradingMarketLifecycleTransitionError> {
    const market = this._requireMarket(venueId, marketId, 'TRADING_CLOSED');
    if (isErr(market)) return market;
    const closed = market.value.closeTrading(closedAt);
    if (isErr(closed)) return closed;
    this._version += 1;
    return Ok(true);
  }

  /**
   * Фиксирует резолюцию рынка и обновляет сохранённый canonical `Market`.
   *
   * @param market - Canonical рынок в состоянии `RESOLVED`
   * @param resolvedAt - `metadata.createdAt` события
   * @returns `Ok(true)` после перехода либо причина отказа
   *
   * @remarks
   * Рынок ищется по `market.id`: резолюция непринятого рынка отвергается как
   * `NOT_ADMITTED`. Совпадение `venueId` и trading-critical структуры
   * проверяет сам переход.
   *
   * Версия растёт на единицу, хотя переход одновременно заменяет `Market`,
   * записывает времена и освобождает тяжёлые данные.
   */
  public resolveMarket(
    market: Market,
    resolvedAt: Timestamp,
  ): Result<boolean, TradingMarketTransitionError> {
    const state = this._requireMarket(market.venueId, market.id, 'RESOLVED');
    if (isErr(state)) return state;
    const resolved = state.value.resolve(market, resolvedAt);
    if (isErr(resolved)) return resolved;
    this._version += 1;
    return Ok(true);
  }

  /**
   * Завершает работу по рынку (`RESOLVED → FINALIZED`).
   *
   * @param marketId - Рынок из `TRADING_MARKET_FINALIZED`
   * @param finalizedAt - `metadata.createdAt` события
   * @returns `Ok(true)` после перехода либо причина отказа
   *
   * @remarks
   * Состояние рынка остаётся в памяти: это retained compact market.
   */
  public finalizeMarket(
    venueId: VenueId,
    marketId: MarketId,
    finalizedAt: Timestamp,
  ): Result<boolean, TradingMarketLifecycleTransitionError> {
    const market = this._requireMarket(venueId, marketId, 'FINALIZED');
    if (isErr(market)) return market;
    const finalized = market.value.finalize(finalizedAt);
    if (isErr(finalized)) return finalized;
    this._version += 1;
    return Ok(true);
  }

  // ── Наблюдения площадок (только для проектора) ─────────────────────────────

  /**
   * Применяет снимок стакана.
   *
   * @param target - Рынок и инструмент либо площадка и инструмент
   * @param observation - Наблюдение полного стакана
   * @returns `Ok(true)` после принятия, `Ok(false)` если наблюдение намеренно
   *   проигнорировано, либо нарушение canonical-маршрутизации
   */
  public applyBook(
    target: ObservationTarget,
    observation: BookObservation,
  ): Result<boolean, ValidationError | UnknownTradingMarketInstrumentError> {
    if (target.kind === 'MARKET') {
      const routed = this._routeMarketInstrument(
        target.venueId,
        target.marketId,
        target.instrumentId,
      );
      if (isErr(routed)) return routed;
      if (routed.value === undefined) return Ok(false);
      routed.value.applyBook(observation);
    } else {
      const shared = this._shared.ensureInstrument(target.venueId, target.instrumentId);
      if (isErr(shared)) return shared;
      shared.value.applyBook(observation);
    }

    this._version += 1;
    return Ok(true);
  }

  /**
   * Применяет публичную сделку.
   *
   * @param target - Рынок и инструмент либо площадка и инструмент
   * @param observation - Наблюдение сделки с ценой в общем домене
   * @returns `Ok(true)` после принятия, `Ok(false)` при намеренном игноре,
   *   либо несовпадение ценового домена / нарушение маршрутизации
   *
   * @remarks
   * Домен известен из самого маршрута, `instanceof` по состоянию для этого
   * не нужен: market-scoped — всегда `OutcomePrice`, shared — всегда
   * `AssetPrice`. Проверка значения — через `instanceof`, без повторной
   * валидации инварианта (ADR, Решение 9).
   *
   * Порядок проверок разный у двух маршрутов, и это не случайность:
   *
   * - **market-scoped** — сначала маршрут, потом домен. Маршрут больше НЕ
   *   мутирует состояние (рынок и инструменты созданы при admission), а
   *   события непринятых рынков нас не касаются вовсе: проверять домен цены
   *   в чужих данных значило бы отвечать за чужую маршрутизацию;
   * - **shared** — сначала домен, потом маршрут: `ensureInstrument()` создаёт
   *   инструмент площадки, то есть уже мутирует состояние. Проверь мы домен
   *   после него, отвергнутое событие оставило бы за собой пустой ряд, а
   *   версия говорила бы, что мутации не было.
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
    ValidationError | UnknownTradingMarketInstrumentError | PriceDomainMismatchError
  > {
    if (target.kind === 'MARKET') {
      const routed = this._routeMarketInstrument(
        target.venueId,
        target.marketId,
        target.instrumentId,
      );
      if (isErr(routed)) return routed;
      if (routed.value === undefined) return Ok(false);
      const { price } = observation;
      if (!(price instanceof OutcomePrice)) {
        return Err(new PriceDomainMismatchError('OutcomePrice', price));
      }
      routed.value.applyPublicTrade({ ...observation, price });
    } else {
      const { price } = observation;
      if (!(price instanceof AssetPrice)) {
        return Err(new PriceDomainMismatchError('AssetPrice', price));
      }
      const shared = this._shared.ensureInstrument(target.venueId, target.instrumentId);
      if (isErr(shared)) return shared;
      shared.value.applyPublicTrade({ ...observation, price });
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
   * @returns `Ok(true)` после принятия, `Ok(false)` при намеренном игноре,
   *   либо нарушение canonical-маршрутизации
   */
  public applyTickSize(
    venueId: VenueId,
    marketId: MarketId,
    instrumentId: InstrumentId,
    tickSize: TickSizeState,
  ): Result<boolean, UnknownTradingMarketInstrumentError> {
    const routed = this._routeMarketInstrument(venueId, marketId, instrumentId);
    if (isErr(routed)) return routed;
    if (routed.value === undefined) return Ok(false);
    routed.value.applyTickSize(tickSize);
    this._version += 1;
    return Ok(true);
  }

  /**
   * Применяет наблюдение референсной цены.
   *
   * @param key - Полная идентичность фида
   * @param observation - Значение с временами площадки и наблюдения
   * @returns `Ok(true)` после принятия
   *
   * @remarks
   * От admission рынков не зависит: референсная цена описывает актив.
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
   * Находит принятый рынок для lifecycle-перехода.
   *
   * @param marketId - Рынок из lifecycle-события
   * @param target - Статус, в который просят перейти (для контекста ошибки)
   * @returns Состояние рынка либо отказ `NOT_ADMITTED`
   *
   * @remarks
   * В отличие от market-data, lifecycle-событие по непринятому рынку — это
   * НЕ «чужие данные», которые можно проигнорировать: producer'ом этих
   * событий является сам торговый рантайм, и переход по рынку, которого он не
   * принимал, означает нарушение инварианта, а не постороннюю шину.
   */
  private _requireMarket(
    venueId: VenueId,
    marketId: MarketId,
    target: TradingMarketLifecycleStatus,
  ): Result<MarketRuntimeState, TradingMarketLifecycleTransitionError> {
    const market = this._markets.get(venueId)?.get(marketId);
    if (market === undefined) {
      return Err(
        new TradingMarketLifecycleTransitionError(
          venueId,
          marketId,
          target,
          undefined,
          'NOT_ADMITTED',
        ),
      );
    }
    return Ok(market);
  }

  /**
   * Куда направить market-scoped наблюдение.
   *
   * @param marketId - Рынок из события
   * @param instrumentId - Инструмент из события
   * @returns Инструмент для записи; `undefined`, если наблюдение намеренно
   *   игнорируется; либо нарушение canonical-маршрутизации
   *
   * @remarks
   * **Метод НЕ мутирует состояние** — в отличие от прежней ленивой схемы.
   * Рынок и оба инструмента создаются исключительно при admission, поэтому
   * отвергнутое или проигнорированное наблюдение физически не может оставить
   * за собой ни рынка, ни инструмента, ни записи индекса.
   *
   * Три разных исхода, и путать их нельзя:
   *
   * ```text
   * рынок не принят          → Ok(undefined)   игнор: чужие данные общей шины
   * инструмент не тот        → Err            нарушение canonical routing
   * фаза не принимает данные → Ok(undefined)  игнор: поздние наблюдения
   * ```
   *
   * Проверка инструмента идёт ДО проверки фазы: третий `instrumentId` под
   * нашим `marketId` остаётся нарушением маршрутизации и после остановки
   * торгов, тогда как поздние наблюдения по законному инструменту — рядовое
   * событие, ради которого закрывать слой нечестно.
   */
  private _routeMarketInstrument(
    venueId: VenueId,
    marketId: MarketId,
    instrumentId: InstrumentId,
  ): Result<MarketInstrumentState | undefined, UnknownTradingMarketInstrumentError> {
    const market = this._markets.get(venueId)?.get(marketId);
    if (market === undefined) return Ok(undefined);
    if (!market.hasInstrument(instrumentId)) {
      return Err(
        new UnknownTradingMarketInstrumentError(
          venueId,
          marketId,
          instrumentId,
          market.instrumentIds(),
        ),
      );
    }
    if (!market.acceptsMarketData()) return Ok(undefined);
    return Ok(market.activeInstrument(instrumentId));
  }

  /**
   * Рынки площадки, создавая пустой уровень при первом рынке.
   *
   * @param venueId - Площадка
   * @returns Изменяемая карта `MarketId → MarketRuntimeState` этой площадки
   */
  private _venueMarkets(venueId: VenueId): Map<MarketId, MarketRuntimeState> {
    let byMarket = this._markets.get(venueId);
    if (byMarket === undefined) {
      byMarket = new Map();
      this._markets.set(venueId, byMarket);
    }
    return byMarket;
  }

  /**
   * Индекс инструментов площадки, создавая пустой уровень при первом рынке.
   *
   * @param venueId - Площадка
   * @returns Изменяемая карта `InstrumentId → MarketId` этой площадки
   */
  private _venueInstruments(venueId: VenueId): Map<InstrumentId, MarketId> {
    let byInstrument = this._instrumentToMarket.get(venueId);
    if (byInstrument === undefined) {
      byInstrument = new Map();
      this._instrumentToMarket.set(venueId, byInstrument);
    }
    return byInstrument;
  }
}

/** Куда направлено наблюдение: в рынок или в общие данные площадки. */
export type ObservationTarget =
  | {
      /**
       * Наблюдение принадлежит конкретному рынку конкретной площадки.
       *
       * @remarks
       * `venueId` обязателен и здесь: идентичность рынка — пара, и выбросить
       * площадку значило бы направить стакан чужой площадки в наш рынок при
       * совпадении `marketId`.
       */
      readonly kind: 'MARKET';
      readonly venueId: VenueId;
      readonly marketId: MarketId;
      readonly instrumentId: InstrumentId;
    }
  | {
      /** Наблюдение принадлежит площадке и не связано с рынком */
      readonly kind: 'SHARED';
      readonly venueId: VenueId;
      readonly instrumentId: InstrumentId;
    };
