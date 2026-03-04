/**
 * Агрегат Order — самодостаточная торговая заявка
 *
 * @remarks
 * Вся бизнес-логика сосредоточена в одном классе.
 * Внешние зависимости: только value objects и @polymarket/ids.
 *
 * ### Три фабрики:
 * - `create()`        — новая заявка (всегда PENDING)
 * - `fromSnapshot()`  — восстановление из снэпшота (reconciliation)
 * - `fromEvents()`    — воспроизведение из лога событий (replay)
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
 *   const accepted = order.accept();
 *   if (accepted.ok) console.log(accepted.value.status); // 'OPEN'
 * }
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import { Price, Quantity, TimestampService } from '@polymarket/value-objects';
import type { Side, Timestamp } from '@polymarket/value-objects';
import type { AssetId, FillId, OrderId } from '@polymarket/ids';
import { asOrderId, asFillId, parseAssetId, assetIdToString, AssetIdHelpers } from '@polymarket/ids';
import Decimal from 'decimal.js';
import {
  TERMINAL_STATUSES,
  FILLABLE_STATUSES,
  type OrderStatus,
  type OrderState,
  type FillState,
  type FillData,
  type CreateOrderParams,
  type OrderSnapshot,
} from './OrderState.js';
import type { OrderEvent } from './OrderEvents.js';
import { OrderError } from './OrderErrors.js';
import { emptyFill, addFill, isFull } from './_fill.js';

const VALID_SIDES = new Set<string>(['BUY', 'SELL']);
const VALID_STATUSES = new Set<string>([
  'PENDING', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED',
]);

/**
 * Агрегат Order — неизменяемая доменная сущность
 *
 * @remarks
 * Хранит состояние в приватном поле `_s: OrderState`.
 * Все публичные свойства — геттеры над `_s`.
 * Команды (accept, reject, cancel, expire, applyFill) возвращают новый экземпляр.
 */
export class Order {
  private constructor(private readonly _s: OrderState) {}

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
  get timestamp(): Timestamp { return this._s.timestamp; }

  /** Причина отклонения/отмены */
  get reason(): string | undefined { return this._s.reason; }

  /** ID стратегии (для изоляции multi-strategy) */
  get strategyId(): string | undefined { return this._s.strategyId; }

  // ─── Fill state ────────────────────────────────────────────────────────────

  /** Внутреннее состояние fills (filledSize, averagePrice, fillIds) */
  get fill(): FillState { return this._s.fill; }

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

  // ─── Factory: create ───────────────────────────────────────────────────────

  /**
   * Создаёт новую заявку (всегда PENDING)
   *
   * @param params - Параметры новой заявки
   * @returns Result<Order, OrderError>
   *
   * @remarks
   * Единственная точка создания заявки в рамках нормального бизнес-потока.
   * Статус всегда PENDING — биржа ещё не подтвердила.
   * Для восстановления существующей заявки → fromSnapshot() или fromEvents().
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
   * ```
   */
  public static create(params: CreateOrderParams): Result<Order, OrderError> {
    if (!params.id) {
      return Err(new OrderError('Order ID must be a non-empty string', { field: 'id' }));
    }
    if (!params.asset) {
      return Err(new OrderError('Asset is required', { field: 'asset', orderId: params.id }));
    }
    if (!VALID_SIDES.has(params.side)) {
      return Err(new OrderError(`Invalid side: ${params.side}. Must be BUY or SELL`, {
        field: 'side', orderId: params.id,
      }));
    }
    if (!params.size.isPositive()) {
      return Err(new OrderError('Order size must be positive', {
        field: 'size', orderId: params.id,
      }));
    }
    return Ok(new Order({
      id: params.id,
      asset: params.asset,
      side: params.side,
      price: params.price,
      size: params.size,
      status: 'PENDING',
      timestamp: params.timestamp,
      strategyId: params.strategyId,
      fill: emptyFill(),
    }));
  }

  // ─── Factory: fromSnapshot ─────────────────────────────────────────────────

  /**
   * Восстанавливает заявку из снэпшота (reconciliation)
   *
   * @param snap - Снэпшот с примитивными значениями
   * @returns Result<Order, OrderError>
   *
   * @remarks
   * Используется для синхронизации с данными биржи или БД.
   * Парсит все примитивы в value objects.
   * Не применяет бизнес-валидацию — доверяет данным источника.
   *
   * @example
   * ```typescript
   * const result = Order.fromSnapshot({
   *   id: 'order-1', asset: '...', side: 'BUY',
   *   price: 0.65, size: 100, status: 'OPEN',
   *   timestamp: '2024-01-01T00:00:00.000Z',
   *   filledSize: 0, fillIds: [],
   * });
   * ```
   */
  public static fromSnapshot(snap: OrderSnapshot): Result<Order, OrderError> {
    try {
      const id = asOrderId(snap.id);
      if (!id) {
        return Err(new OrderError('Invalid order ID in snapshot', { field: 'id', value: snap.id }));
      }

      const asset = parseAssetId(snap.asset);
      if (!asset) {
        return Err(new OrderError('Invalid asset in snapshot', { field: 'asset', orderId: snap.id }));
      }

      if (!VALID_SIDES.has(snap.side)) {
        return Err(new OrderError(`Invalid side in snapshot: ${snap.side}`, { orderId: snap.id }));
      }

      if (!VALID_STATUSES.has(snap.status)) {
        return Err(new OrderError(`Invalid status in snapshot: ${snap.status}`, { orderId: snap.id }));
      }

      const tsResult = TimestampService.fromISO(snap.timestamp);
      if (!tsResult.ok) {
        return Err(new OrderError(`Invalid timestamp in snapshot: ${tsResult.error.message}`, {
          orderId: snap.id,
        }));
      }

      const fillIds: FillId[] = [];
      for (const rawId of snap.fillIds) {
        const fillId = asFillId(rawId);
        if (!fillId) {
          return Err(new OrderError(`Invalid fill ID in snapshot: ${rawId}`, { orderId: snap.id }));
        }
        fillIds.push(fillId);
      }

      const filledSize = Quantity.of(new Decimal(snap.filledSize));
      const averagePrice = snap.averagePrice !== undefined
        ? Price.of(new Decimal(snap.averagePrice))
        : undefined;

      return Ok(new Order({
        id,
        asset,
        side: snap.side as Side,
        price: Price.of(new Decimal(snap.price)),
        size: Quantity.of(new Decimal(snap.size)),
        status: snap.status as OrderStatus,
        timestamp: tsResult.value,
        strategyId: snap.strategyId,
        reason: snap.reason,
        fill: { filledSize, averagePrice, fillIds },
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Err(new OrderError(`Failed to restore order from snapshot: ${msg}`, {
        orderId: snap?.id,
      }));
    }
  }

  // ─── Factory: fromEvents ───────────────────────────────────────────────────

  /**
   * Воспроизводит заявку из лога событий (replay mode)
   *
   * @param events - Последовательность событий в хронологическом порядке
   * @returns Order
   *
   * @remarks
   * Применяет события без валидации — предполагает корректность лога.
   * Используется для воспроизведения истории в режиме paper trading или анализа.
   * Первое событие должно быть ORDER_CREATED.
   *
   * @throws {OrderError} Если массив событий пуст или первое событие не ORDER_CREATED
   *
   * @example
   * ```typescript
   * const order = Order.fromEvents([
   *   { type: 'ORDER_CREATED', orderId, asset, side: 'BUY', price, size, timestamp },
   *   { type: 'ORDER_ACCEPTED', orderId },
   *   { type: 'FILL_APPLIED', orderId, fill: fillData },
   * ]);
   * ```
   */
  public static fromEvents(events: readonly OrderEvent[]): Order {
    if (events.length === 0) {
      throw new OrderError('Cannot create Order from empty events list');
    }

    const first = events[0];
    if (first.type !== 'ORDER_CREATED') {
      throw new OrderError(
        `First event must be ORDER_CREATED, got ${first.type}`,
        { eventType: first.type },
      );
    }

    let state: OrderState = {
      id: first.orderId,
      asset: first.asset,
      side: first.side,
      price: first.price,
      size: first.size,
      status: 'PENDING',
      timestamp: first.timestamp,
      strategyId: first.strategyId,
      fill: emptyFill(),
    };

    for (let i = 1; i < events.length; i++) {
      state = Order._applyEventToState(state, events[i]);
    }

    return new Order(state);
  }

  // ─── Private: event application ───────────────────────────────────────────

  /**
   * Применяет событие к состоянию без валидации
   *
   * @param state - Текущее состояние
   * @param event - Событие для применения
   * @returns Новое состояние
   *
   * @remarks
   * Используется в fromEvents() для воспроизведения лога.
   * При невалидных данных (например, дубль fill) — пропускает событие.
   */
  private static _applyEventToState(state: OrderState, event: OrderEvent): OrderState {
    switch (event.type) {
      case 'ORDER_CREATED':
        return {
          id: event.orderId,
          asset: event.asset,
          side: event.side,
          price: event.price,
          size: event.size,
          status: 'PENDING',
          timestamp: event.timestamp,
          strategyId: event.strategyId,
          fill: emptyFill(),
        };

      case 'ORDER_ACCEPTED':
        return { ...state, status: 'OPEN' };

      case 'ORDER_REJECTED':
        return { ...state, status: 'REJECTED', reason: event.reason };

      case 'ORDER_CANCELLED':
        return { ...state, status: 'CANCELED', reason: event.reason };

      case 'ORDER_EXPIRED':
        return { ...state, status: 'EXPIRED' };

      case 'FILL_APPLIED': {
        const result = addFill(state.fill, event.fill, state.size);
        if (!result.ok) return state;
        const newFill = result.value;
        const newStatus: OrderStatus = isFull(newFill, state.size) ? 'FILLED' : 'PARTIALLY_FILLED';
        return { ...state, status: newStatus, fill: newFill };
      }

      default: {
        // TypeScript exhaustiveness check
        void (event as never);
        return state;
      }
    }
  }

  // ─── Commands ──────────────────────────────────────────────────────────────

  /**
   * Принять заявку биржей
   *
   * @returns Result<Order, OrderError>
   *
   * @remarks
   * Переход: PENDING → OPEN
   * Биржа подтвердила получение и выставила заявку на исполнение.
   *
   * @example
   * ```typescript
   * const result = order.accept();
   * if (result.ok) console.log(result.value.status); // 'OPEN'
   * ```
   */
  public accept(): Result<Order, OrderError> {
    if (this._s.status !== 'PENDING') {
      return Err(new OrderError(
        `Cannot accept order with status ${this._s.status}. Only PENDING orders can be accepted.`,
        { orderId: this._s.id },
      ));
    }
    return Ok(new Order({ ...this._s, status: 'OPEN' }));
  }

  /**
   * Отклонить заявку биржей
   *
   * @param reason - Причина отклонения (обязательна)
   * @returns Result<Order, OrderError>
   *
   * @remarks
   * Переход: PENDING → REJECTED
   * Биржа отклонила заявку (недостаточно средств, невалидная цена и т.д.)
   *
   * @example
   * ```typescript
   * const result = order.reject('Insufficient funds');
   * if (result.ok) console.log(result.value.reason); // 'Insufficient funds'
   * ```
   */
  public reject(reason: string): Result<Order, OrderError> {
    if (!reason || reason.trim().length === 0) {
      return Err(new OrderError('Reject reason must be a non-empty string', { orderId: this._s.id }));
    }
    if (this._s.status !== 'PENDING') {
      return Err(new OrderError(
        `Cannot reject order with status ${this._s.status}. Only PENDING orders can be rejected.`,
        { orderId: this._s.id },
      ));
    }
    return Ok(new Order({ ...this._s, status: 'REJECTED', reason }));
  }

  /**
   * Отменить заявку
   *
   * @param reason - Причина отмены (опционально, по умолчанию 'User cancelled')
   * @returns Result<Order, OrderError>
   *
   * @remarks
   * Переход: OPEN или PARTIALLY_FILLED → CANCELED
   * Заявка снята с биржи по инициативе пользователя или риск-системы.
   *
   * @example
   * ```typescript
   * const result = order.cancel('Risk limit exceeded');
   * if (result.ok) console.log(result.value.status); // 'CANCELED'
   * ```
   */
  public cancel(reason?: string): Result<Order, OrderError> {
    if (!FILLABLE_STATUSES.has(this._s.status)) {
      return Err(new OrderError(
        `Cannot cancel order with status ${this._s.status}. Only OPEN or PARTIALLY_FILLED orders can be cancelled.`,
        { orderId: this._s.id },
      ));
    }
    return Ok(new Order({ ...this._s, status: 'CANCELED', reason: reason ?? 'User cancelled' }));
  }

  /**
   * Истечь заявке по времени
   *
   * @returns Result<Order, OrderError>
   *
   * @remarks
   * Переход: OPEN или PARTIALLY_FILLED → EXPIRED
   * Автоматически вызывается при истечении TTL заявки.
   *
   * @example
   * ```typescript
   * const result = order.expire();
   * if (result.ok) console.log(result.value.status); // 'EXPIRED'
   * ```
   */
  public expire(): Result<Order, OrderError> {
    if (!FILLABLE_STATUSES.has(this._s.status)) {
      return Err(new OrderError(
        `Cannot expire order with status ${this._s.status}. Only OPEN or PARTIALLY_FILLED orders can expire.`,
        { orderId: this._s.id },
      ));
    }
    return Ok(new Order({ ...this._s, status: 'EXPIRED' }));
  }

  /**
   * Применить fill исполнения к заявке
   *
   * @param fill - Данные исполнения
   * @returns Result<Order, OrderError>
   *
   * @remarks
   * Переходы:
   * - OPEN → PARTIALLY_FILLED (если остаток > 0)
   * - OPEN или PARTIALLY_FILLED → FILLED (если остаток = 0)
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
  public applyFill(fill: FillData): Result<Order, OrderError> {
    if (!FILLABLE_STATUSES.has(this._s.status)) {
      return Err(new OrderError(
        `Cannot apply fill to order with status ${this._s.status}. Only OPEN or PARTIALLY_FILLED orders can accept fills.`,
        { orderId: this._s.id, fillId: fill.id },
      ));
    }

    if (!AssetIdHelpers.equals(fill.asset, this._s.asset)) {
      return Err(new OrderError('Fill asset does not match order asset', {
        orderId: this._s.id, fillId: fill.id,
      }));
    }

    if (fill.side !== this._s.side) {
      return Err(new OrderError(
        `Fill side (${fill.side}) does not match order side (${this._s.side})`,
        { orderId: this._s.id, fillId: fill.id },
      ));
    }

    if (fill.orderId !== this._s.id) {
      return Err(new OrderError(
        `Fill orderId (${fill.orderId}) does not match this order id (${this._s.id})`,
        { orderId: this._s.id, fillId: fill.id },
      ));
    }

    const newFillResult = addFill(this._s.fill, fill, this._s.size);
    if (!newFillResult.ok) {
      return Err(new OrderError(`Failed to apply fill: ${newFillResult.error.message}`, {
        orderId: this._s.id, fillId: fill.id,
      }));
    }

    const newFill = newFillResult.value;
    const newStatus: OrderStatus = isFull(newFill, this._s.size) ? 'FILLED' : 'PARTIALLY_FILLED';
    return Ok(new Order({ ...this._s, status: newStatus, fill: newFill }));
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
      !(this._s.fill.fillIds as unknown as string[]).includes(fill.id as string)
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
   * Round-trip: Order.fromSnapshot(order.toSnapshot()) воспроизводит тот же Order.
   *
   * @example
   * ```typescript
   * const snap = order.toSnapshot();
   * const restored = Order.fromSnapshot(snap);
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
