/**
 * Агрегат Order — самодостаточная торговая заявка
 *
 * @remarks
 * Вся бизнес-логика сосредоточена в одном классе.
 * Внешние зависимости: @polymarket/result, @polymarket/errors, @polymarket/value-objects,
 * @polymarket/ids, @polymarket/fill, decimal.js.
 *
 * ### Две фабрики:
 * - `create()`    — новая заявка (всегда PENDING)
 * - `rehydrate()` — восстановление из доверенного OrderState (с кросс-проверками)
 *
 * ### Команды:
 * Каждая команда проверяет допустимость перехода и возвращает
 * `Result<Order, TradingError>` с НОВЫМ экземпляром. Скрытого изменяемого
 * состояния нет: Order не копит и не публикует события — публикация
 * совершённых изменений принадлежит Application-слою
 * (`TRADING_ACCOUNT_ORDER_COMMITTED`).
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
 *   price: OutcomePrice.of(new Decimal('0.65')),
 *   size: Quantity.of(new Decimal('100')),
 *   timestamp: Timestamp.now(),
 * });
 *
 * if (result.ok) {
 *   const pending = result.value;
 *   const accepted = pending.accept();
 *   if (accepted.ok) console.log(accepted.value.status); // 'OPEN'
 *   console.log(pending.status); // 'PENDING' — исходный экземпляр не изменился
 * }
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import { OutcomePrice, Quantity } from '@polymarket/value-objects';
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
import { TradingError } from '@polymarket/errors';
import { emptyFill, addFill, isFull } from './_fill.js';

const VALID_SIDES = new Set<string>(['BUY', 'SELL']);

/**
 * Агрегат Order — неизменяемая доменная сущность
 *
 * @remarks
 * Хранит состояние в единственном приватном поле `_s: OrderState`.
 * Все публичные свойства — геттеры над `_s`.
 * Команды (accept, reject, cancel, expire, applyFill) не меняют текущий
 * экземпляр — они возвращают новый с новым `OrderState`.
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
  get price(): OutcomePrice { return this._s.price; }

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
  get averagePrice(): OutcomePrice | undefined { return this._s.fill.averagePrice; }

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
   * @returns `Ok(Order)` в статусе PENDING или `Err(TradingError)` при невалидных параметрах
   * @throws Не бросает исключений — все ошибки возвращаются через Result
   *
   * @remarks
   * Единственная точка создания заявки в рамках нормального бизнес-потока.
   * Статус всегда PENDING — биржа ещё не подтвердила; fill-состояние пустое.
   *
   * Для восстановления существующей заявки → rehydrate().
   *
   * @example
   * ```typescript
   * const result = Order.create({
   *   id: asOrderId('order-1')!,
   *   asset: myAsset,
   *   side: 'BUY',
   *   price: OutcomePrice.of(new Decimal('0.65')),
   *   size: Quantity.of(new Decimal('100')),
   *   timestamp: Timestamp.now(),
   * });
   * if (result.ok) console.log(result.value.status); // 'PENDING'
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
      return Err(new TradingError('OutcomePrice is required', { context: { field: 'price', orderId: params.id } }));
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

    // Поля перечислены явно: лишние ключи params в состояние не попадают
    return Ok(new Order({
      id: params.id,
      asset: params.asset,
      side: params.side,
      price: params.price,
      size: params.size,
      status: 'PENDING',
      timestamp: params.timestamp,
      strategyId: params.strategyId,
      accountId: params.accountId,
      fill: emptyFill(),
    }));
  }

  // ─── Factory: rehydrate ────────────────────────────────────────────────────

  /**
   * Восстанавливает заявку из доверенного состояния (rehydration)
   *
   * @param state - Внутреннее состояние заявки с value objects
   * @returns `Ok(Order)` или `Err(TradingError)` при несогласованных полях состояния
   * @throws Не бросает исключений — все ошибки возвращаются через Result
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
   * - PARTIALLY_FILLED заявка должна иметь 0 < filledSize < size
   *
   * @example
   * ```typescript
   * const result = Order.rehydrate(state);
   * if (result.ok) console.log(result.value.status);
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

  // ─── Commands ──────────────────────────────────────────────────────────────

  /**
   * Принять заявку биржей
   *
   * @returns `Ok(Order)` в статусе OPEN или `Err(TradingError)`, если статус не PENDING
   * @throws Не бросает исключений — все ошибки возвращаются через Result
   *
   * @remarks
   * Переход: PENDING → OPEN
   * Биржа подтвердила получение и выставила заявку на исполнение.
   * Текущий экземпляр не меняется — возвращается новый.
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
    return Ok(new Order({ ...this._s, status: 'OPEN' }));
  }

  /**
   * Отклонить заявку биржей
   *
   * @param reason - Причина отклонения (обязательна, непустая)
   * @returns `Ok(Order)` в статусе REJECTED или `Err(TradingError)` при пустой
   *   причине либо статусе, отличном от PENDING
   * @throws Не бросает исключений — все ошибки возвращаются через Result
   *
   * @remarks
   * Переход: PENDING → REJECTED
   * Биржа отклонила заявку (недостаточно средств, невалидная цена и т.д.)
   * Причина сохраняется как есть — без обрезки пробелов.
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
    return Ok(new Order({ ...this._s, status: 'REJECTED', reason }));
  }

  /**
   * Отменить заявку
   *
   * @param reason - Причина отмены (опционально, по умолчанию 'User cancelled')
   * @returns `Ok(Order)` в статусе CANCELED или `Err(TradingError)`, если статус
   *   не OPEN/PARTIALLY_FILLED
   * @throws Не бросает исключений — все ошибки возвращаются через Result
   *
   * @remarks
   * Переход: OPEN или PARTIALLY_FILLED → CANCELED
   * Заявка снята с биржи по инициативе пользователя или риск-системы.
   * Fill-состояние (filledSize, VWAP, fillIds) сохраняется.
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
    return Ok(new Order({ ...this._s, status: 'CANCELED', reason: reason ?? 'User cancelled' }));
  }

  /**
   * Истечь заявке по времени
   *
   * @returns `Ok(Order)` в статусе EXPIRED или `Err(TradingError)`, если статус
   *   не OPEN/PARTIALLY_FILLED
   * @throws Не бросает исключений — все ошибки возвращаются через Result
   *
   * @remarks
   * Переход: OPEN или PARTIALLY_FILLED → EXPIRED
   * Автоматически вызывается при истечении TTL заявки.
   * Fill-состояние сохраняется.
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
    return Ok(new Order({ ...this._s, status: 'EXPIRED' }));
  }

  /**
   * Применить fill исполнения к заявке
   *
   * @param fill - Данные исполнения
   * @returns `Ok(Order)` с применённым fill или `Err(TradingError)`, если fill не
   *   проходит проверки ниже
   * @throws Не бросает исключений — все ошибки возвращаются через Result
   *
   * @remarks
   * Переходы:
   * - OPEN или PARTIALLY_FILLED → PARTIALLY_FILLED (если остаток не исчерпан)
   * - OPEN или PARTIALLY_FILLED → FILLED (если остаток исчерпан с учётом
   *   порога «пыли», см. `isFull()` в `_fill.ts`)
   *
   * Алгоритм:
   * 1. Проверяем статус и соответствие fill этой заявке (asset/side/orderId).
   * 2. `addFill()` проверяет размер и дубликат fillId и считает новый
   *    filledSize и VWAP.
   * 3. `isFull()` выбирает итоговый статус.
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

    if (filled && !newFill.averagePrice) {
      // Should not happen: addFill always sets averagePrice on success
      return Err(new TradingError('Internal error: averagePrice missing for fully filled order', {
        context: { orderId: this._s.id, fillId: fill.id },
      }));
    }

    return Ok(new Order({ ...this._s, status: filled ? 'FILLED' : 'PARTIALLY_FILLED', fill: newFill }));
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
