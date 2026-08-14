/**
 * Агрегат Order — самодостаточная торговая заявка
 *
 * @remarks
 * Вся бизнес-логика сосредоточена в одном классе.
 * Внешние зависимости: @polymarket/result, @polymarket/errors, @polymarket/value-objects,
 * @polymarket/ids, decimal.js.
 *
 * ### Три фабрики:
 * - `create()`     — новая заявка (всегда PENDING), эмитирует OrderCreatedEvent
 * - `rehydrate()`  — восстановление из доверенного OrderState (без событий)
 * - `fromEvents()` — воспроизведение из лога событий (без событий)
 *
 * ### Domain Event Outbox:
 * Каждая успешная команда записывает событие в внутренний буфер.
 * Application-слой вызывает `pullEvents()` для извлечения и публикации.
 *
 * ### Жизненный цикл:
 * ```
 * PENDING → OPEN → PARTIALLY_FILLED → FILLED
 *     ↓       ↓            ↓
 * REJECTED  CANCELED    EXPIRED
 * ```
 *
 * ### Инварианты:
 * 1. Статус PENDING при создании — биржа ещё не подтвердила
 * 2. Только OPEN/PARTIALLY_FILLED могут принимать fill
 * 3. Fill не может превышать remainingSize
 * 4. Терминальные статусы (FILLED/CANCELED/REJECTED/EXPIRED) необратимы
 * 5. Все поля неизменяемы — методы возвращают новый экземпляр
 *
 * @example
 * ```typescript
 * // Создание новой заявки
 * const result = Order.create({
 *   id: asOrderId('order-1')!,
 *   asset: myAsset,
 *   side: 'BUY',
 *   price: Price.of(new Decimal('0.65')),
 *   size: Quantity.of(new Decimal('100')),
 *   timestamp: Timestamp.now(),
 * });
 *
 * if (result.ok) {
 *   const order = result.value;
 *   // canonical envelope: metadata поставляет Application-слой (M-003)
 *   const events = order.pullEvents(() => generator.nextRoot()); // [OrderCreatedEvent]
 *   const accepted = order.accept();
 *   if (accepted.ok) console.log(accepted.value.status); // 'OPEN'
 * }
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import { Price, Quantity } from '@polymarket/value-objects';
import type { Side } from '@polymarket/value-objects';
import type { AccountId, AssetId, FillId, OrderId, StrategyId } from '@polymarket/ids';
import { AssetIdHelpers, accountIdToString, assetIdToString } from '@polymarket/ids';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренняя Decimal-арифметика/парсинг границы после VO-типизированного публичного API, см. docs/architecture/boundary-contract.md, Решение 1
import Decimal from 'decimal.js';
import {
  TERMINAL_STATUSES,
  FILLABLE_STATUSES,
  type OrderStatus,
  type OrderState,
  type CreateOrderParams,
  type OrderSnapshot,
} from './OrderState.js';
import type { FillData } from '@polymarket/fill';
import type {
  OrderEvent,
  OrderCreatedEvent,
  OrderAcceptedEvent,
  OrderRejectedEvent,
  OrderCancelledEvent,
  OrderExpiredEvent,
  OrderPartiallyFilledEvent,
  OrderFilledEvent,
} from '@polymarket/order-events';
import type { MessageMetadata } from '@polymarket/messages';
import { TradingError } from '@polymarket/errors';
import { emptyFill, addFill, isFull } from './_fill.js';

const VALID_SIDES = new Set<string>(['BUY', 'SELL']);

/**
 * Внутренний draft доменного события — `{ type, payload }` БЕЗ metadata.
 *
 * @remarks
 * M-003: public `OrderEvent` — canonical envelope `{ type, payload, metadata }`,
 * но Domain детерминирован и не имеет доступа к clock/random/generator.
 * Поэтому команды пишут в outbox именно drafts; canonical событие
 * materialize-ится на границе `pullEvents()` — metadata поставляет caller
 * (Application-слой). Draft НЕ является public system message.
 *
 * Каждый canonical `OrderEvent` структурно совместим со своим draft-ом
 * (лишняя metadata не мешает), поэтому `_applyEventToState` работает и в
 * командах (drafts), и в replay (`fromEvents` с canonical событиями).
 */
type DraftOf<E extends OrderEvent> = E extends OrderEvent ? Pick<E, 'type' | 'payload'> : never;

/** Union drafts всех доменных событий Order. */
type OrderEventDraft = DraftOf<OrderEvent>;

/**
 * Агрегат Order — неизменяемая доменная сущность
 *
 * @remarks
 * Хранит состояние в приватном поле `_s: OrderState`.
 * Все публичные свойства — геттеры над `_s`.
 * Команды (accept, reject, cancel, expire, applyFill) возвращают новый экземпляр.
 * Каждая успешная команда записывает событие в `_pendingEvents`.
 * Вызов `pullEvents()` опустошает буфер.
 */
export class Order {
  private constructor(
    private readonly _s: OrderState,
    /** Буфер drafts доменных событий (Domain Event Outbox; metadata — на границе pullEvents) */
    private readonly _pendingDrafts: OrderEventDraft[] = [],
  ) {}

  // ─── Identity ──────────────────────────────────────────────────────────────

  /** ID заявки */
  get id(): OrderId { return this._s.id; }

  /** Торгуемый актив */
  get asset(): AssetId { return this._s.asset; }

  /** Сторона (BUY/SELL) */
  get side(): Side { return this._s.side; }

  /** Лимитная цена заявки */
  get price(): Price { return this._s.price; }

  /** Полный размер заявки */
  get size(): Quantity { return this._s.size; }

  /** Текущий статус */
  get status(): OrderStatus { return this._s.status; }

  /** Время создания заявки */
  get timestamp() { return this._s.timestamp; }

  /** Причина отклонения/отмены */
  get reason(): string | undefined { return this._s.reason; }

  /** ID стратегии (для изоляции multi-strategy) */
  get strategyId(): StrategyId | undefined { return this._s.strategyId; }

  /** ID аккаунта-владельца (для ownership-проверок execution-слоя) */
  get accountId(): AccountId | undefined { return this._s.accountId; }

  // ─── Fill state ────────────────────────────────────────────────────────────

  /** Внутреннее состояние fills (filledSize, averagePrice, fillIds) */
  get fill() { return this._s.fill; }

  /** Исполненный объём */
  get filledSize(): Quantity { return this._s.fill.filledSize; }

  /** Средневзвешенная цена исполнения (VWAP), undefined если нет fills */
  get averagePrice(): Price | undefined { return this._s.fill.averagePrice; }

  /** Список ID всех применённых fills */
  get fillIds(): readonly FillId[] { return this._s.fill.fillIds; }

  /** Количество применённых fills */
  get tradeCount(): number { return this._s.fill.fillIds.length; }

  // ─── Computed ──────────────────────────────────────────────────────────────

  /**
   * Оставшийся незаполненный объём
   *
   * @returns size - filledSize
   */
  get remainingSize(): Quantity {
    return Quantity.of(this._s.size.value().minus(this._s.fill.filledSize.value()));
  }

  /**
   * Процент заполнения (0–100)
   *
   * @returns filledSize / size * 100
   */
  get fillPercentage(): Decimal {
    if (this._s.size.isZero()) return new Decimal(0);
    return this._s.fill.filledSize.value().times(100).dividedBy(this._s.size.value());
  }

  /**
   * Номинальная стоимость заявки
   *
   * @returns price * size
   */
  get notional(): Decimal {
    return this._s.price.value().times(this._s.size.value());
  }

  /** true если статус терминальный (FILLED/CANCELED/REJECTED/EXPIRED) */
  get isTerminal(): boolean { return TERMINAL_STATUSES.has(this._s.status); }

  /** true если заявка может принимать fills (OPEN/PARTIALLY_FILLED) */
  get isFillable(): boolean { return FILLABLE_STATUSES.has(this._s.status); }

  // ─── Status predicates ─────────────────────────────────────────────────────

  isPending(): boolean { return this._s.status === 'PENDING'; }
  isOpen(): boolean { return this._s.status === 'OPEN'; }
  isFilled(): boolean { return this._s.status === 'FILLED'; }
  isPartiallyFilled(): boolean { return this._s.status === 'PARTIALLY_FILLED'; }
  canCancel(): boolean { return FILLABLE_STATUSES.has(this._s.status); }
  canModify(): boolean { return !TERMINAL_STATUSES.has(this._s.status); }

  // ─── Domain Event Outbox ───────────────────────────────────────────────────

  /**
   * Извлекает накопленные доменные события (canonical envelopes) и очищает буфер
   *
   * @param metadataFor - Фабрика metadata: вызывается ОДИН раз на каждое
   *   событие в порядке их возникновения. Application-слой передаёт замыкание
   *   над canonical `MessageMetadataGenerator` (`nextChild(parent)` для
   *   событий, порождённых обработкой сообщения; `nextRoot()` для
   *   инициативных команд вне event-контекста)
   * @returns Массив canonical `OrderEvent` с момента последнего pullEvents()
   *
   * @remarks
   * Pattern: Domain Event Outbox + M-003 materialization boundary.
   * Внутри буфера — детерминированные drafts `{ type, payload }`;
   * canonical envelope `{ type, payload, metadata }` собирается ЗДЕСЬ,
   * metadata поставляет caller. Так Domain остаётся без clock/random/generator,
   * а каждый public OrderEvent получает уникальную системную identity ДО
   * передачи в шину.
   *
   * Вызов pullEvents() опустошает буфер — следующий вызов вернёт [].
   * `rehydrate()` и `fromEvents()` не эмитируют событий.
   *
   * Materialization атомарна: metadata создаётся для ВСЕХ drafts ДО очистки
   * буфера. Если `metadataFor` бросает (генератор документирует RangeError
   * при sequence overflow / отрицательном high-res времени и Error при
   * невалидном времени) — исключение пробрасывается, а outbox остаётся
   * нетронутым: повторный pullEvents() с исправным поставщиком metadata
   * вернёт все исходные события в исходном порядке. Ошибка «декорации»
   * события не уничтожает сами domain events.
   *
   * @example
   * ```typescript
   * const result = Order.create(params);
   * if (result.ok) {
   *   const events = result.value.pullEvents(() => generator.nextRoot());
   *   await eventBus.publishAll(events);
   * }
   * ```
   */
  public pullEvents(metadataFor: () => MessageMetadata): readonly OrderEvent[] {
    // Сначала materialize ВСЕ события, и только при полном успехе очищаем
    // буфер: throw из metadataFor не должен терять domain events (outbox
    // остаётся пригодным для повторного pull).
    const drafts = [...this._pendingDrafts];

    const events = drafts.map((draft) => ({ ...draft, metadata: metadataFor() }));

    this._pendingDrafts.splice(0, drafts.length);

    return events;
  }

  // ─── Factory: create ───────────────────────────────────────────────────────

  /**
   * Создаёт новую заявку (всегда PENDING)
   *
   * @param params - Параметры новой заявки
   * @returns Result<Order, TradingError>
   *
   * @remarks
   * Единственная точка создания заявки в рамках нормального бизнес-потока.
   * Статус всегда PENDING — биржа ещё не подтвердила.
   * Эмитирует OrderCreatedEvent в буфер (pullEvents() вернёт его).
   *
   * Для восстановления существующей заявки → rehydrate() или fromEvents().
   *
   * @example
   * ```typescript
   * const result = Order.create({
   *   id: asOrderId('order-1')!,
   *   asset: myAsset,
   *   side: 'BUY',
   *   price: Price.of(new Decimal('0.65')),
   *   size: Quantity.of(new Decimal('100')),
   *   timestamp: Timestamp.now(),
   * });
   * if (result.ok) {
   *   const events = result.value.pullEvents(() => generator.nextRoot()); // [OrderCreatedEvent]
   * }
   * ```
   */
  public static create(params: CreateOrderParams): Result<Order, TradingError> {
    if (!params.id) {
      return Err(new TradingError('Order ID must be a non-empty string', { context: { field: 'id' } }));
    }
    if (!params.asset) {
      return Err(new TradingError('Asset is required', { context: { field: 'asset', orderId: params.id } }));
    }
    if (!params.price) {
      return Err(new TradingError('Price is required', { context: { field: 'price', orderId: params.id } }));
    }
    if (!VALID_SIDES.has(params.side)) {
      return Err(new TradingError(`Invalid side: ${params.side}. Must be BUY or SELL`, {
        context: { field: 'side', orderId: params.id },
      }));
    }
    if (params.size == null) {
      return Err(new TradingError('Order size is required', {
        context: { field: 'size', orderId: params.id },
      }));
    }
    if (!params.size.isPositive()) {
      return Err(new TradingError('Order size must be positive', {
        context: { field: 'size', orderId: params.id },
      }));
    }
    if (params.timestamp == null) {
      return Err(new TradingError('Timestamp is required', {
        context: { field: 'timestamp', orderId: params.id },
      }));
    }

    const draft: DraftOf<OrderCreatedEvent> = {
      type: 'ORDER_CREATED',
      payload: {
        orderId: params.id,
        asset: params.asset,
        side: params.side,
        price: params.price,
        size: params.size,
        timestamp: params.timestamp,
        strategyId: params.strategyId,
        accountId: params.accountId,
      },
    };

    return Ok(new Order(Order._applyEventToState({} as OrderState, draft), [draft]));
  }

  // ─── Factory: rehydrate ────────────────────────────────────────────────────

  /**
   * Восстанавливает заявку из доверенного состояния (rehydration)
   *
   * @param state - Внутреннее состояние заявки с value objects
   * @returns Result<Order, TradingError>
   *
   * @remarks
   * В отличие от create() не применяет бизнес-валидацию — состояние уже прошло
   * через доменную логику ранее.
   *
   * Используется OrderDeserializer после парсинга снэпшота из БД или API.
   *
   * Проверяет консистентность состояния (кросс-поля):
   * - filledSize не может превышать size
   * - PENDING заявка не может иметь fills
   * - FILLED заявка должна быть полностью исполнена
   *
   * Не эмитирует события — pullEvents() вернёт [].
   *
   * @example
   * ```typescript
   * const result = Order.rehydrate(state);
   * if (result.ok) {
   *   console.log(result.value.status);
   *   result.value.pullEvents(() => generator.nextRoot()); // всегда []
   * }
   * ```
   */
  public static rehydrate(state: OrderState): Result<Order, TradingError> {
    const filledVal = state.fill.filledSize.value();
    const sizeVal = state.size.value();

    if (filledVal.gt(sizeVal)) {
      return Err(new TradingError(
        `filledSize (${filledVal}) exceeds size (${sizeVal})`,
        { context: { orderId: state.id, filledSize: filledVal.toString(), size: sizeVal.toString() } },
      ));
    }

    if (state.status === 'PENDING' && !filledVal.isZero()) {
      return Err(new TradingError(
        `PENDING order cannot have fills (filledSize: ${filledVal})`,
        { context: { orderId: state.id, filledSize: filledVal.toString() } },
      ));
    }

    if (state.status === 'FILLED' && !filledVal.eq(sizeVal)) {
      return Err(new TradingError(
        `FILLED order must have filledSize equal to size (filledSize: ${filledVal}, size: ${sizeVal})`,
        { context: { orderId: state.id, filledSize: filledVal.toString(), size: sizeVal.toString() } },
      ));
    }

    if (state.status === 'PARTIALLY_FILLED' && !(filledVal.gt(0) && filledVal.lt(sizeVal))) {
      return Err(new TradingError(
        `PARTIALLY_FILLED order must have 0 < filledSize < size (filledSize: ${filledVal}, size: ${sizeVal})`,
        { context: { orderId: state.id, filledSize: filledVal.toString(), size: sizeVal.toString() } },
      ));
    }

    return Ok(new Order(state));
  }

  // ─── Factory: fromEvents ───────────────────────────────────────────────────

  /**
   * Воспроизводит заявку из лога событий (replay mode)
   *
   * @param events - Последовательность событий в хронологическом порядке; первое должно быть ORDER_CREATED
   * @returns `Ok(Order)` при успехе, `Err(TradingError)` если массив пуст или первое событие не ORDER_CREATED
   * @throws Не бросает исключений — все ошибки возвращаются через Result
   *
   * @remarks
   * Применяет события без валидации — предполагает корректность лога.
   * Используется для воспроизведения истории в режиме paper trading или анализа.
   * Не эмитирует события — pullEvents() вернёт [].
   *
   * @example
   * ```typescript
   * const result = Order.fromEvents([
   *   { type: 'ORDER_CREATED', payload: { orderId, asset, side: 'BUY', price, size, timestamp }, metadata },
   *   { type: 'ORDER_ACCEPTED', payload: { orderId }, metadata },
   *   { type: 'ORDER_FILLED', payload: { orderId, fill: fillData, averagePrice }, metadata },
   * ]);
   * if (result.ok) console.log(result.value.status); // 'FILLED'
   * ```
   */
  public static fromEvents(events: readonly OrderEvent[]): Result<Order, TradingError> {
    if (events.length === 0) {
      return Err(new TradingError('Cannot create Order from empty events list'));
    }

    const first = events[0];
    if (first.type !== 'ORDER_CREATED') {
      return Err(new TradingError(
        `First event must be ORDER_CREATED, got ${first.type}`,
        { context: { eventType: first.type } },
      ));
    }

    let state: OrderState = {
      id: first.payload.orderId,
      asset: first.payload.asset,
      side: first.payload.side,
      price: first.payload.price,
      size: first.payload.size,
      status: 'PENDING',
      timestamp: first.payload.timestamp,
      strategyId: first.payload.strategyId,
      accountId: first.payload.accountId,
      fill: emptyFill(),
    };

    for (let i = 1; i < events.length; i++) {
      state = Order._applyEventToState(state, events[i]);
    }

    return Ok(new Order(state));
  }

  // ─── Private: event application ───────────────────────────────────────────

  /**
   * Применяет событие к состоянию — единственный источник истины для переходов
   *
   * @param state - Текущее состояние
   * @param event - Событие для применения
   * @returns Новое состояние (без изменений если событие не применимо)
   *
   * @remarks
   * Используется двояко:
   * 1. В командах (accept, reject, cancel, expire, applyFill) — state derived from event
   * 2. В fromEvents() — replay лога событий без валидации
   *
   * Гарантии безопасности:
   * - Если orderId события не совпадает с id текущего состояния — событие игнорируется
   *   (silent corruption prevention при попадании чужого события в поток)
   * - Статус-гарды предотвращают недопустимые переходы при replay
   *
   * Это гарантирует, что переход состояния всегда проходит через один код,
   * а не дублируется в каждой команде.
   *
   * Принимает draft `{ type, payload }` — canonical `OrderEvent` структурно
   * совместим (metadata игнорируется), поэтому replay canonical-событий и
   * применение внутренних drafts идут через один код. Metadata по построению
   * НЕ влияет на переход состояния.
   */
  private static _applyEventToState(state: OrderState, event: OrderEventDraft): OrderState {
    // Защита от чужих событий: игнорируем если orderId не совпадает (кроме ORDER_CREATED)
    if (event.type !== 'ORDER_CREATED' && event.payload.orderId !== state.id) return state;

    switch (event.type) {
      case 'ORDER_CREATED':
        return {
          id: event.payload.orderId,
          asset: event.payload.asset,
          side: event.payload.side,
          price: event.payload.price,
          size: event.payload.size,
          status: 'PENDING',
          timestamp: event.payload.timestamp,
          strategyId: event.payload.strategyId,
          accountId: event.payload.accountId,
          fill: emptyFill(),
        };

      case 'ORDER_ACCEPTED':
        if (state.status !== 'PENDING') return state;
        return { ...state, status: 'OPEN' };

      case 'ORDER_REJECTED':
        if (state.status !== 'PENDING') return state;
        return { ...state, status: 'REJECTED', reason: event.payload.reason };

      case 'ORDER_CANCELLED':
        if (!FILLABLE_STATUSES.has(state.status)) return state;
        return { ...state, status: 'CANCELED', reason: event.payload.reason };

      case 'ORDER_EXPIRED':
        if (!FILLABLE_STATUSES.has(state.status)) return state;
        return { ...state, status: 'EXPIRED' };

      case 'ORDER_PARTIALLY_FILLED':
      case 'ORDER_FILLED': {
        if (!FILLABLE_STATUSES.has(state.status)) return state;
        const result = addFill(state.fill, event.payload.fill, state.size);
        if (!result.ok) return state;
        const newFill = result.value;
        const newStatus: OrderStatus = event.type === 'ORDER_FILLED' ? 'FILLED' : 'PARTIALLY_FILLED';
        return { ...state, status: newStatus, fill: newFill };
      }

      default:
        return state;
    }
  }

  // ─── Commands ──────────────────────────────────────────────────────────────

  /**
   * Принять заявку биржей
   *
   * @returns Result<Order, TradingError>
   *
   * @remarks
   * Переход: PENDING → OPEN
   * Биржа подтвердила получение и выставила заявку на исполнение.
   * Эмитирует OrderAcceptedEvent.
   *
   * @example
   * ```typescript
   * const result = order.accept();
   * if (result.ok) console.log(result.value.status); // 'OPEN'
   * ```
   */
  public accept(): Result<Order, TradingError> {
    if (this._s.status !== 'PENDING') {
      return Err(new TradingError(
        `Cannot accept order with status ${this._s.status}. Only PENDING orders can be accepted.`,
        { context: { orderId: this._s.id } },
      ));
    }
    const draft: DraftOf<OrderAcceptedEvent> = { type: 'ORDER_ACCEPTED', payload: { orderId: this._s.id } };
    return Ok(new Order(Order._applyEventToState(this._s, draft), [...this._pendingDrafts, draft]));
  }

  /**
   * Отклонить заявку биржей
   *
   * @param reason - Причина отклонения (обязательна)
   * @returns Result<Order, TradingError>
   *
   * @remarks
   * Переход: PENDING → REJECTED
   * Биржа отклонила заявку (недостаточно средств, невалидная цена и т.д.)
   * Эмитирует OrderRejectedEvent.
   *
   * @example
   * ```typescript
   * const result = order.reject('Insufficient funds');
   * if (result.ok) console.log(result.value.reason); // 'Insufficient funds'
   * ```
   */
  public reject(reason: string): Result<Order, TradingError> {
    if (!reason || reason.trim().length === 0) {
      return Err(new TradingError('Reject reason must be a non-empty string', { context: { orderId: this._s.id } }));
    }
    if (this._s.status !== 'PENDING') {
      return Err(new TradingError(
        `Cannot reject order with status ${this._s.status}. Only PENDING orders can be rejected.`,
        { context: { orderId: this._s.id } },
      ));
    }
    const draft: DraftOf<OrderRejectedEvent> = { type: 'ORDER_REJECTED', payload: { orderId: this._s.id, reason } };
    return Ok(new Order(Order._applyEventToState(this._s, draft), [draft]));
  }

  /**
   * Отменить заявку
   *
   * @param reason - Причина отмены (опционально, по умолчанию 'User cancelled')
   * @returns Result<Order, TradingError>
   *
   * @remarks
   * Переход: OPEN или PARTIALLY_FILLED → CANCELED
   * Заявка снята с биржи по инициативе пользователя или риск-системы.
   * Эмитирует OrderCancelledEvent.
   *
   * @example
   * ```typescript
   * const result = order.cancel('Risk limit exceeded');
   * if (result.ok) console.log(result.value.status); // 'CANCELED'
   * ```
   */
  public cancel(reason?: string): Result<Order, TradingError> {
    if (!FILLABLE_STATUSES.has(this._s.status)) {
      return Err(new TradingError(
        `Cannot cancel order with status ${this._s.status}. Only OPEN or PARTIALLY_FILLED orders can be cancelled.`,
        { context: { orderId: this._s.id } },
      ));
    }
    const cancelReason = reason ?? 'User cancelled';
    const draft: DraftOf<OrderCancelledEvent> = {
      type: 'ORDER_CANCELLED',
      payload: { orderId: this._s.id, reason: cancelReason },
    };
    return Ok(new Order(Order._applyEventToState(this._s, draft), [draft]));
  }

  /**
   * Истечь заявке по времени
   *
   * @returns Result<Order, TradingError>
   *
   * @remarks
   * Переход: OPEN или PARTIALLY_FILLED → EXPIRED
   * Автоматически вызывается при истечении TTL заявки.
   * Эмитирует OrderExpiredEvent.
   *
   * @example
   * ```typescript
   * const result = order.expire();
   * if (result.ok) console.log(result.value.status); // 'EXPIRED'
   * ```
   */
  public expire(): Result<Order, TradingError> {
    if (!FILLABLE_STATUSES.has(this._s.status)) {
      return Err(new TradingError(
        `Cannot expire order with status ${this._s.status}. Only OPEN or PARTIALLY_FILLED orders can expire.`,
        { context: { orderId: this._s.id } },
      ));
    }
    const draft: DraftOf<OrderExpiredEvent> = { type: 'ORDER_EXPIRED', payload: { orderId: this._s.id } };
    return Ok(new Order(Order._applyEventToState(this._s, draft), [draft]));
  }

  /**
   * Применить fill исполнения к заявке
   *
   * @param fill - Данные исполнения
   * @returns Result<Order, TradingError>
   *
   * @remarks
   * Переходы:
   * - OPEN → PARTIALLY_FILLED (если остаток > 0) → эмитирует OrderPartiallyFilledEvent
   * - OPEN или PARTIALLY_FILLED → FILLED (если остаток = 0) → эмитирует OrderFilledEvent
   *
   * Валидирует:
   * - Статус OPEN или PARTIALLY_FILLED
   * - fill.asset совпадает с order.asset
   * - fill.side совпадает с order.side
   * - fill.orderId совпадает с order.id
   * - fill.size > 0 и не превышает remainingSize
   * - fill.id не дублируется
   *
   * @example
   * ```typescript
   * const result = order.applyFill({ id: fillId, orderId, asset, side: 'BUY', size, price });
   * if (result.ok) console.log(result.value.filledSize.value().toNumber()); // 30
   * ```
   */
  public applyFill(fill: FillData): Result<Order, TradingError> {
    if (!FILLABLE_STATUSES.has(this._s.status)) {
      return Err(new TradingError(
        `Cannot apply fill to order with status ${this._s.status}. Only OPEN or PARTIALLY_FILLED orders can accept fills.`,
        { context: { orderId: this._s.id, fillId: fill.id } },
      ));
    }

    if (!AssetIdHelpers.equals(fill.asset, this._s.asset)) {
      return Err(new TradingError('Fill asset does not match order asset', {
        context: { orderId: this._s.id, fillId: fill.id },
      }));
    }

    if (fill.side !== this._s.side) {
      return Err(new TradingError(
        `Fill side (${fill.side}) does not match order side (${this._s.side})`,
        { context: { orderId: this._s.id, fillId: fill.id } },
      ));
    }

    if (fill.orderId !== this._s.id) {
      return Err(new TradingError(
        `Fill orderId (${fill.orderId}) does not match this order id (${this._s.id})`,
        { context: { orderId: this._s.id, fillId: fill.id } },
      ));
    }

    const newFillResult = addFill(this._s.fill, fill, this._s.size);
    if (!newFillResult.ok) {
      return Err(new TradingError(`Failed to apply fill: ${newFillResult.error.message}`, {
        context: { orderId: this._s.id, fillId: fill.id },
      }));
    }

    const newFill = newFillResult.value;
    const filled = isFull(newFill, this._s.size);

    if (filled) {
      if (!newFill.averagePrice) {
        // Should not happen: addFill always sets averagePrice on success
        return Err(new TradingError('Internal error: averagePrice missing for fully filled order', {
          context: { orderId: this._s.id, fillId: fill.id },
        }));
      }
      const draft: DraftOf<OrderFilledEvent> = {
        type: 'ORDER_FILLED',
        payload: {
          orderId: this._s.id,
          fill,
          averagePrice: newFill.averagePrice,
        },
      };
      return Ok(new Order(Order._applyEventToState(this._s, draft), [draft]));
    }

    const draft: DraftOf<OrderPartiallyFilledEvent> = {
      type: 'ORDER_PARTIALLY_FILLED',
      payload: {
        orderId: this._s.id,
        fill,
        filledSize: newFill.filledSize,
        remainingSize: Quantity.of(this._s.size.value().minus(newFill.filledSize.value())),
      },
    };
    return Ok(new Order(Order._applyEventToState(this._s, draft), [draft]));
  }

  /**
   * Проверяет возможность принятия fill без применения
   *
   * @param fill - Данные исполнения для проверки
   * @returns true если fill может быть применён
   *
   * @remarks
   * Быстрая проверка перед вызовом applyFill().
   * Паритет с applyFill(): если canAcceptFill() == false, то applyFill() вернёт Err.
   *
   * @example
   * ```typescript
   * if (order.canAcceptFill(fill)) {
   *   const result = order.applyFill(fill);
   * }
   * ```
   */
  public canAcceptFill(fill: FillData): boolean {
    return (
      FILLABLE_STATUSES.has(this._s.status) &&
      AssetIdHelpers.equals(fill.asset, this._s.asset) &&
      fill.orderId === this._s.id &&
      fill.side === this._s.side &&
      fill.size.isPositive() &&
      fill.size.value().lte(this.remainingSize.value()) &&
      !this._s.fill.fillIds.includes(fill.id)
    );
  }

  // ─── Serialization ─────────────────────────────────────────────────────────

  /**
   * Создаёт снэпшот заявки с примитивными типами
   *
   * @returns OrderSnapshot — плоский объект с примитивами
   *
   * @remarks
   * Используется для персистентности (БД, кэш) и синхронизации с биржей.
   * Round-trip: Order.rehydrate(parsed(order.toSnapshot())) воспроизводит тот же Order.
   *
   * @example
   * ```typescript
   * const snap = order.toSnapshot();
   * const restored = OrderDeserializer.fromSnapshot(snap);
   * ```
   */
  public toSnapshot(): OrderSnapshot {
    return {
      id: this._s.id as string,
      asset: assetIdToString(this._s.asset),
      side: this._s.side,
      price: this._s.price.value().toNumber(),
      size: this._s.size.value().toNumber(),
      status: this._s.status,
      timestamp: this._s.timestamp.toISO(),
      filledSize: this._s.fill.filledSize.value().toNumber(),
      averagePrice: this._s.fill.averagePrice?.value().toNumber(),
      fillIds: this._s.fill.fillIds.map(id => id as string),
      reason: this._s.reason,
      strategyId: this._s.strategyId,
      accountId: this._s.accountId !== undefined ? accountIdToString(this._s.accountId) : undefined,
    };
  }

  /**
   * Строковое представление для логирования
   *
   * @returns Читаемая строка с основными полями заявки
   *
   * @example
   * ```typescript
   * console.log(order.toString());
   * // "Order[order-1]: BUY 100 @ 0.65 (OPEN)"
   * ```
   */
  public toString(): string {
    return `Order[${this._s.id}]: ${this._s.side} ${this._s.size.value().toNumber()} @ ${this._s.price.value().toNumber()} (${this._s.status})`;
  }
}
