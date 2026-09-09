/**
 * Единственный писатель оперативного торгового состояния.
 *
 * @remarks
 * Обработчики одного события в `IEventBus` выполняются ПАРАЛЛЕЛЬНО. Поэтому
 * несколько независимых подписчиков на `BOOK_UPDATED` — state, features,
 * strategy — читали бы и писали состояние вперемешку, и порядок их эффектов
 * был бы не определён. Отсюда правило: подписан один проектор, а всё
 * остальное строится НАД готовым состоянием, а не рядом с ним.
 *
 * Подписки объявлены critical: если canonical-событие не удалось принять,
 * торговый рантайм не должен молча продолжать с частично обновлённым
 * состоянием. Ошибка возвращается из `publish()` и прерывает разбор
 * очереди.
 *
 * Проектор НЕ подписан на `MARKET_OPENED`/`MARKET_CLOSED`: у них семантика
 * старого рантайма (аллокация баланса, strategyId, освобождение и
 * реализованный PnL), а не жизненного цикла рынка, который мы проектируем.
 * Переиспользовать их «пока что» значило бы построить новый lifecycle на
 * чужих гарантиях.
 */
import type { IEventBus } from '@polymarket/event-bus';
import type {
  BookDepthEvent,
  BookUpdatedEvent,
  ReferencePriceUpdatedEvent,
  TickSizeChangedEvent,
  TradeReceivedEvent,
} from '@polymarket/application-events';
import type { DecimalPrice } from '@polymarket/value-objects';
import { isErr } from '@polymarket/result';
import type { TradingHotState, ObservationTarget } from './TradingHotState.js';
import type { TradingHotStateView } from './views.js';
import type { ReferencePriceSeriesKey } from './observations.js';

/**
 * Типы событий, которые проектор принимает в состояние.
 *
 * @remarks
 * Только canonical market data. Strategy/Features/Risk/Execution и
 * `MARKET_OPENED`/`MARKET_CLOSED` сюда не входят намеренно.
 */
const PROJECTED_EVENT_TYPES = [
  'BOOK_UPDATED',
  'BOOK_DEPTH',
  'TRADE_RECEIVED',
  'REFERENCE_PRICE_UPDATED',
  'TICK_SIZE_CHANGED',
] as const;

/**
 * Проецирует canonical market-data события в {@link TradingHotState}.
 *
 * @example
 * ```typescript
 * const projector = new TradingStateProjector(eventBus, state);
 * projector.start();
 * await eventBus.publish(bookDepthEvent);
 * const view = projector.state();
 * projector.stop();
 * ```
 */
export class TradingStateProjector {
  private _unsubscribes: Array<() => void> = [];

  /**
   * @param _eventBus - Шина canonical-событий приложения
   * @param _state - Состояние, которым проектор владеет единолично
   */
  constructor(
    private readonly _eventBus: IEventBus,
    private readonly _state: TradingHotState,
  ) {}

  /**
   * Состояние только для чтения.
   *
   * @returns Проекция без возможности мутировать ряды
   */
  public state(): TradingHotStateView {
    return this._state;
  }

  /** Проектор подписан на шину */
  public isRunning(): boolean {
    return this._unsubscribes.length > 0;
  }

  /**
   * Подписывает проектор на canonical market-data события.
   *
   * @remarks
   * Повторный вызов ничего не делает: вторая подписка на те же типы
   * означала бы двойную запись каждого наблюдения.
   *
   * @example
   * ```typescript
   * projector.start();
   * projector.start(); // no-op
   * ```
   */
  public start(): void {
    if (this.isRunning()) return;

    this._unsubscribes = [
      this._eventBus.subscribe(
        'BOOK_UPDATED',
        (event) => {
          this._onBookUpdated(event as BookUpdatedEvent<DecimalPrice>);
        },
        { critical: true },
      ),
      this._eventBus.subscribe(
        'BOOK_DEPTH',
        (event) => {
          this._onBookDepth(event as BookDepthEvent<DecimalPrice>);
        },
        { critical: true },
      ),
      this._eventBus.subscribe(
        'TRADE_RECEIVED',
        (event) => {
          this._onTradeReceived(event as TradeReceivedEvent<DecimalPrice>);
        },
        { critical: true },
      ),
      this._eventBus.subscribe(
        'REFERENCE_PRICE_UPDATED',
        (event) => {
          this._onReferencePrice(event as ReferencePriceUpdatedEvent);
        },
        { critical: true },
      ),
      this._eventBus.subscribe(
        'TICK_SIZE_CHANGED',
        (event) => {
          this._onTickSizeChanged(event as TickSizeChangedEvent);
        },
        { critical: true },
      ),
    ];
  }

  /**
   * Снимает все подписки.
   *
   * @remarks
   * Повторный вызов безопасен. После остановки новые события состояние не
   * меняют.
   */
  public stop(): void {
    for (const unsubscribe of this._unsubscribes) unsubscribe();
    this._unsubscribes = [];
  }

  /** Типы событий, которые проектор принимает */
  public static projectedEventTypes(): readonly string[] {
    return PROJECTED_EVENT_TYPES;
  }

  /**
   * Куда направить наблюдение стакана или сделки.
   *
   * @param payload - Полезная нагрузка canonical-события
   * @returns Рынок, если `marketId` есть; иначе площадка
   *
   * @remarks
   * Правило source-agnostic: решает НАЛИЧИЕ `marketId`, а не то, какая это
   * площадка. Проверок вида `if (venue === BINANCE)` здесь нет и быть не
   * должно — application state не знает вендорских правил.
   */
  private _target(payload: {
    readonly marketId?: unknown;
    readonly venueId: unknown;
    readonly instrumentId: unknown;
  }): ObservationTarget {
    return payload.marketId !== undefined
      ? {
          kind: 'MARKET',
          marketId: payload.marketId as never,
          instrumentId: payload.instrumentId as never,
        }
      : {
          kind: 'SHARED',
          venueId: payload.venueId as never,
          instrumentId: payload.instrumentId as never,
        };
  }

  /**
   * Принимает обновление верхушки стакана.
   *
   * @param event - Canonical `BOOK_UPDATED`
   * @throws {Error} При нарушении инварианта владения инструментом
   */
  private _onBookUpdated(event: BookUpdatedEvent<DecimalPrice>): void {
    const applied = this._state.applyTopOfBook(this._target(event.payload), {
      topOfBook: event.payload.topOfBook,
      sequenceNumber: event.payload.sequenceNumber,
      sourceTimestamp: event.payload.timestamp,
      observedAt: event.metadata.createdAt,
    });
    if (isErr(applied)) throw applied.error;
  }

  /**
   * Принимает снимок стакана.
   *
   * @param event - Canonical `BOOK_DEPTH`
   * @throws {Error} При нарушении инварианта владения инструментом
   */
  private _onBookDepth(event: BookDepthEvent<DecimalPrice>): void {
    const applied = this._state.applyBook(this._target(event.payload), {
      snapshot: event.payload.snapshot,
      sourceTimestamp: event.payload.timestamp,
      observedAt: event.metadata.createdAt,
    });
    if (isErr(applied)) throw applied.error;
  }

  /**
   * Принимает публичную сделку.
   *
   * @param event - Canonical `TRADE_RECEIVED`
   * @throws {Error} При нарушении инварианта владения инструментом
   */
  private _onTradeReceived(event: TradeReceivedEvent<DecimalPrice>): void {
    const applied = this._state.applyPublicTrade(this._target(event.payload), {
      venueTradeId: event.payload.venueTradeId,
      price: event.payload.price,
      size: event.payload.size,
      side: event.payload.side,
      sourceTimestamp: event.payload.timestamp,
      observedAt: event.metadata.createdAt,
    });
    if (isErr(applied)) throw applied.error;
  }

  /**
   * Принимает наблюдение референсной цены.
   *
   * @param event - Canonical `REFERENCE_PRICE_UPDATED`
   * @throws {Error} При ошибке создания ряда
   *
   * @remarks
   * Референсные цены ВСЕГДА идут в shared-состояние: они описывают актив, а
   * не рынок. Идентичность ряда собирается из всех различающих полей —
   * `nativeSymbol` в неё не входит, это происхождение.
   */
  private _onReferencePrice(event: ReferencePriceUpdatedEvent): void {
    const { sourceId, baseAsset, quoteAsset, feed, value, venueTimestamp, receivedAt } =
      event.payload;
    const key: ReferencePriceSeriesKey =
      feed.kind === 'TWAP'
        ? { sourceId, baseAsset, quoteAsset, kind: 'TWAP', windowSeconds: feed.windowSeconds }
        : { sourceId, baseAsset, quoteAsset, kind: 'SPOT' };

    const applied = this._state.applyReferencePrice(key, {
      value,
      venueTimestamp,
      receivedAt,
      observedAt: event.metadata.createdAt,
    });
    if (isErr(applied)) throw applied.error;
  }

  /**
   * Обновляет действующий шаг цены.
   *
   * @param event - Canonical `TICK_SIZE_CHANGED`
   * @throws {Error} При нарушении инварианта владения инструментом
   *
   * @remarks
   * Событие market-scoped по контракту, поэтому рынок и инструмент
   * создаются лениво, если наблюдений по ним ещё не было.
   */
  private _onTickSizeChanged(event: TickSizeChangedEvent): void {
    const applied = this._state.applyTickSize(
      event.payload.marketId,
      event.payload.instrumentId,
      {
        tickSize: event.payload.newTickSize,
        sourceTimestamp: event.payload.timestamp,
        observedAt: event.metadata.createdAt,
      },
    );
    if (isErr(applied)) throw applied.error;
  }
}
