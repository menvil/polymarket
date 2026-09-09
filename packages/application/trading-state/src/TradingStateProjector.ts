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
import type { IClock } from '@polymarket/time';
import type { ValidationError } from '@polymarket/errors';
import { Ok, type Result, isErr } from '@polymarket/result';
import type {
  BookDepthEvent,
  ReferencePriceUpdatedEvent,
  TickSizeChangedEvent,
  TradeReceivedEvent,
} from '@polymarket/application-events';
import type { DecimalPrice } from '@polymarket/value-objects';
import { TradingHotState, type ObservationTarget } from './TradingHotState.js';
import { BookIdentityMismatchError } from './errors.js';
import type { TradingStateRetentionConfig } from './TradingStateRetentionConfig.js';
import type { TradingHotStateView } from './views.js';
import type { ReferencePriceSeriesKey } from './observations.js';

/**
 * Типы событий, которые проектор принимает в состояние.
 *
 * @remarks
 * Только canonical market data. Strategy/Features/Risk/Execution и
 * `MARKET_OPENED`/`MARKET_CLOSED` сюда не входят намеренно.
 *
 * `BOOK_UPDATED` тоже не входит: оба семантических адаптера выводят его из
 * ТОГО ЖЕ снимка, что публикуют как `BOOK_DEPTH`, и только при изменении
 * верхушки. Для состояния это дублирование — верхушка получается из
 * `books.getLatest().snapshot` вычислением. Само событие в
 * `@polymarket/application-events` остаётся: оно может пригодиться
 * потребителю, которому нужно дешёвое уведомление без хранения стакана.
 */
const PROJECTED_EVENT_TYPES = [
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

  private constructor(
    private readonly _eventBus: IEventBus,
    private readonly _state: TradingHotState,
  ) {}

  /**
   * Создаёт проектор вместе с состоянием, которым он владеет.
   *
   * @param eventBus - Шина canonical-событий приложения
   * @param config - Конфигурация хранения (проверяется здесь)
   * @param clock - Часы
   * @returns Проектор либо первая непройденная политика хранения
   *
   * @remarks
   * Состояние создаётся ВНУТРИ и наружу отдаётся только как
   * {@link TradingHotStateView}. Конкретный mutable-класс из пакета не
   * экспортируется вовсе — иначе правило «единственный писатель» осталось бы
   * комментарием: любой потребитель мог бы вызвать `applyBook()` без единого
   * приведения типов.
   *
   * @example
   * ```typescript
   * const projector = TradingStateProjector.create(bus, retention, clock);
   * if (isErr(projector)) throw projector.error;
   * projector.value.start();
   * ```
   */
  public static create(
    eventBus: IEventBus,
    config: TradingStateRetentionConfig,
    clock: IClock,
  ): Result<TradingStateProjector, ValidationError> {
    const state = TradingHotState.create(config, clock);
    if (isErr(state)) return state;
    return Ok(new TradingStateProjector(eventBus, state.value));
  }

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
   * Принимает снимок стакана.
   *
   * @param event - Canonical `BOOK_DEPTH`
   * @throws {Error} При нарушении инварианта владения инструментом
   */
  private _onBookDepth(event: BookDepthEvent<DecimalPrice>): void {
    this._assertBookIdentity(event);
    const applied = this._state.applyBook(this._target(event.payload), {
      snapshot: event.payload.snapshot,
      sourceTimestamp: event.payload.timestamp,
      observedAt: event.metadata.createdAt,
    });
    if (isErr(applied)) throw applied.error;
  }

  /**
   * Сверяет идентичность снимка с идентичностью события.
   *
   * @param event - Canonical `BOOK_DEPTH`
   * @throws {BookIdentityMismatchError} При расхождении любого из трёх полей
   *
   * @remarks
   * Контракт события требует, чтобы `venueId`/`marketId`/`instrumentId`
   * повторяли те же поля `Orderbook`. Маршрутизация берётся из payload, а в
   * состояние кладётся snapshot: при расхождении книга одного инструмента
   * тихо легла бы под ключом другого, и обнаружилось бы это только по
   * необъяснимым ценам у стратегии. Три сравнения дешевле такой отладки.
   */
  private _assertBookIdentity(event: BookDepthEvent<DecimalPrice>): void {
    const { payload } = event;
    const { snapshot } = payload;
    if (payload.venueId !== snapshot.venueId) {
      throw new BookIdentityMismatchError('venueId', payload.venueId, snapshot.venueId);
    }
    if (payload.instrumentId !== snapshot.instrumentId) {
      throw new BookIdentityMismatchError(
        'instrumentId',
        payload.instrumentId,
        snapshot.instrumentId,
      );
    }
    if (payload.marketId !== snapshot.marketId) {
      throw new BookIdentityMismatchError('marketId', payload.marketId, snapshot.marketId);
    }
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
