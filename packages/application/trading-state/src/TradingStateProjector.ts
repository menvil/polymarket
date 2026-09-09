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
 * ### Два вида событий и разное отношение к незнакомому рынку
 *
 * ```text
 * lifecycle  TRADING_MARKET_*      producer — сам торговый рантайм
 *                                  рынок обязан быть принят → иначе Err
 *
 * market-data BOOK_DEPTH, …        producer — семантические адаптеры
 *                                  рынок не принят → ИГНОР без ошибки
 * ```
 *
 * `IEventBus` общий: на нём живут данные рынков, нужных коллектору, другому
 * владельцу или будущей стратегии. Canonical-событие не означает
 * автоматически событие торгового состояния, поэтому market-data по
 * непринятому рынку не создаёт ничего и не увеличивает версию. Lifecycle же
 * публикует сам рантайм — переход по рынку, которого он не принимал, означает
 * нарушение инварианта.
 *
 * ### Что на самом деле означает `critical: true`
 *
 * Ровно одно: отказ обработчика возвращается публикующей стороне как
 * `Err` из `IEventBus.publish()`, а не глотается шиной. Никакой остановки
 * торгового рантайма отсюда НЕ следует.
 *
 * Сегодняшняя цепочка выглядит так:
 *
 * ```text
 * SemanticAdapter → publish() → projector throws → publish() возвращает Err
 *                 → адаптер логирует, увеличивает счётчик и ПРОДОЛЖАЕТ
 * ```
 *
 * То есть состояние может остаться с дыркой: наблюдение №101 отвергнуто,
 * №102 принято, и никто не остановился. Это не дефект состояния — так
 * устроена композиция, и для записи сырых данных она верна: коллектор
 * обязан писать дальше, что бы ни случилось с семантикой.
 *
 * **Как живой торговый контур реагирует на отказ семантической публикации —
 * отдельный вопрос, и он обязан быть решён fail-closed ДО включения
 * Strategy.** Ожидаемая форма: отказ → торговый рантайм нездоров → Strategy
 * отключается → Execution останавливается контролируемо, при этом
 * Collector/Recorder продолжают писать raw.
 *
 * Проектор НЕ подписан на `MARKET_OPENED`/`MARKET_CLOSED`: у них семантика
 * старого рантайма (аллокация баланса, strategyId, освобождение и
 * реализованный PnL), а не жизненного цикла рынка, который мы проектируем.
 * Переиспользовать их «пока что» значило бы построить новый lifecycle на
 * чужих гарантиях — поэтому у нового контура свои имена
 * (`TRADING_MARKET_*`).
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
  TradingMarketActivatedEvent,
  TradingMarketAdmittedEvent,
  TradingMarketClosedEvent,
  TradingMarketFinalizedEvent,
  TradingMarketResolvedEvent,
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
 * Только lifecycle нового торгового рантайма и canonical market data.
 * Strategy/Features/Risk/Execution и legacy `MARKET_OPENED`/`MARKET_CLOSED`
 * сюда не входят намеренно.
 *
 * `BOOK_UPDATED` тоже не входит: оба семантических адаптера выводят его из
 * ТОГО ЖЕ снимка, что публикуют как `BOOK_DEPTH`, и только при изменении
 * верхушки. Для состояния это дублирование — верхушка получается из
 * `books.getLatest().snapshot` вычислением. Само событие в
 * `@polymarket/application-events` остаётся: оно может пригодиться
 * потребителю, которому нужно дешёвое уведомление без хранения стакана.
 */
const PROJECTED_EVENT_TYPES = [
  'TRADING_MARKET_ADMITTED',
  'TRADING_MARKET_ACTIVATED',
  'TRADING_MARKET_CLOSED',
  'TRADING_MARKET_RESOLVED',
  'TRADING_MARKET_FINALIZED',
  'BOOK_DEPTH',
  'TRADE_RECEIVED',
  'REFERENCE_PRICE_UPDATED',
  'TICK_SIZE_CHANGED',
] as const;

/**
 * Проецирует canonical lifecycle- и market-data события в {@link TradingHotState}.
 *
 * @example
 * ```typescript
 * const projector = new TradingStateProjector(eventBus, state);
 * projector.start();
 * await eventBus.publish(admittedEvent);
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
   * комментарием: любой потребитель мог бы вызвать `applyBook()` или
   * `admitMarket()` без единого приведения типов.
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
   * @returns Проекция без возможности мутировать рынки и ряды
   */
  public state(): TradingHotStateView {
    return this._state;
  }

  /** Проектор подписан на шину */
  public isRunning(): boolean {
    return this._unsubscribes.length > 0;
  }

  /**
   * Подписывает проектор на lifecycle- и market-data события.
   *
   * @remarks
   * Повторный вызов ничего не делает: вторая подписка на те же типы
   * означала бы двойную запись каждого наблюдения — и, что хуже, второй
   * lifecycle-переход по каждому событию.
   *
   * Все подписки critical, включая lifecycle: отвергнутый переход обязан быть
   * виден публикующей стороне, иначе рантайм считал бы рынок активным, а
   * состояние — принятым и не более.
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
        'TRADING_MARKET_ADMITTED',
        (event) => {
          this._onMarketAdmitted(event as TradingMarketAdmittedEvent);
        },
        { critical: true },
      ),
      this._eventBus.subscribe(
        'TRADING_MARKET_ACTIVATED',
        (event) => {
          this._onMarketActivated(event as TradingMarketActivatedEvent);
        },
        { critical: true },
      ),
      this._eventBus.subscribe(
        'TRADING_MARKET_CLOSED',
        (event) => {
          this._onMarketTradingClosed(event as TradingMarketClosedEvent);
        },
        { critical: true },
      ),
      this._eventBus.subscribe(
        'TRADING_MARKET_RESOLVED',
        (event) => {
          this._onMarketResolved(event as TradingMarketResolvedEvent);
        },
        { critical: true },
      ),
      this._eventBus.subscribe(
        'TRADING_MARKET_FINALIZED',
        (event) => {
          this._onMarketFinalized(event as TradingMarketFinalizedEvent);
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
   * Принимает рынок к торговле.
   *
   * @param event - Canonical `TRADING_MARKET_ADMITTED`
   * @throws {Error} При повторном admission, терминальном внешнем состоянии,
   *   опоздании относительно `startsAt` или конфликте инструментов
   *
   * @remarks
   * Время перехода — `metadata.createdAt`, а не показания часов: иначе replay
   * той же последовательности событий давал бы другие времена жизненного
   * цикла.
   */
  private _onMarketAdmitted(event: TradingMarketAdmittedEvent): void {
    const applied = this._state.admitMarket(event.payload.market, event.metadata.createdAt);
    if (isErr(applied)) throw applied.error;
  }

  /**
   * Переводит рынок в торговлю.
   *
   * @param event - Canonical `TRADING_MARKET_ACTIVATED`
   * @throws {Error} При активации не из `ADMITTED` либо вне окна расписания
   */
  private _onMarketActivated(event: TradingMarketActivatedEvent): void {
    const applied = this._state.activateMarket(
      event.payload.marketId,
      event.metadata.createdAt,
    );
    if (isErr(applied)) throw applied.error;
  }

  /**
   * Останавливает торговлю по рынку.
   *
   * @param event - Canonical `TRADING_MARKET_CLOSED`
   * @throws {Error} При закрытии не из `ACTIVE` либо раньше активации
   */
  private _onMarketTradingClosed(event: TradingMarketClosedEvent): void {
    const applied = this._state.closeMarketTrading(
      event.payload.marketId,
      event.metadata.createdAt,
    );
    if (isErr(applied)) throw applied.error;
  }

  /**
   * Фиксирует резолюцию рынка.
   *
   * @param event - Canonical `TRADING_MARKET_RESOLVED`
   * @throws {Error} При неразрешённом рынке в payload, недопустимой фазе или
   *   расхождении trading-critical структуры
   */
  private _onMarketResolved(event: TradingMarketResolvedEvent): void {
    const applied = this._state.resolveMarket(event.payload.market, event.metadata.createdAt);
    if (isErr(applied)) throw applied.error;
  }

  /**
   * Завершает работу по рынку.
   *
   * @param event - Canonical `TRADING_MARKET_FINALIZED`
   * @throws {Error} При финализации не из `RESOLVED`
   */
  private _onMarketFinalized(event: TradingMarketFinalizedEvent): void {
    const applied = this._state.finalizeMarket(
      event.payload.marketId,
      event.metadata.createdAt,
    );
    if (isErr(applied)) throw applied.error;
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
   * @throws {Error} При расхождении идентичности снимка или неизвестном
   *   инструменте принятого рынка
   *
   * @remarks
   * Наблюдение по непринятому рынку и наблюдение после остановки торгов
   * проходят без ошибки и без изменения состояния.
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
   *
   * Проверка идёт ДО маршрутизации, то есть и для непринятых рынков:
   * несогласованный снимок остаётся дефектом адаптера независимо от того,
   * интересует нас этот рынок или нет.
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
   * @throws {Error} При несовпадении ценового домена или неизвестном
   *   инструменте принятого рынка
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
   * не рынок, и от admission не зависят. Идентичность ряда собирается из всех
   * различающих полей — `nativeSymbol` в неё не входит, это происхождение.
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
   * @throws {Error} При неизвестном инструменте принятого рынка
   *
   * @remarks
   * Событие market-scoped по контракту, поэтому подчиняется тем же правилам,
   * что стакан и сделки: непринятый рынок — игнор, чужой инструмент — отказ.
   * Рынок оно НЕ создаёт.
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
