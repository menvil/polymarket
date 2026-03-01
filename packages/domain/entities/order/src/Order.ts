/**
 * Сущность Order (Заявка)
 *
 * @remarks
 * Представляет торговую заявку в системе предсказательных рынков.
 * Order является неизменяемой доменной сущностью (immutable entity).
 *
 * ### Архитектура:
 * - **Entity**: Order - чистая бизнес-логика без FSM деталей
 * - **Value Objects**: OrderStatus, Side (BUY/SELL), OrderFill - инварианты и данные
 * - **FSM**: OrderFSM - управление переходами состояния
 * - **Utils**: calculations, predicates - вспомогательные функции
 *
 * ### Жизненный цикл:
 * ```
 * PENDING → OPEN → PARTIALLY_FILLED → FILLED
 *     ↓       ↓            ↓
 * REJECTED  CANCELED    EXPIRED
 * ```
 *
 * ### Бизнес-правила:
 * 1. Заявка должна иметь валидные id, marketId, tokenId, price, size
 * 2. Price и Size должны быть валидными value objects
 * 3. Fill не может превышать size
 * 4. Только OPEN/PARTIALLY_FILLED заявки могут быть отменены
 * 5. Терминальные статусы не могут измениться
 *
 * @example
 * ```typescript
 * import { Order } from './Order';
 * import { Price, Quantity } from '@polymarket/value-objects';
 * import Decimal from 'decimal.js';
 *
 * // Создание новой заявки
 * const result = Order.create({
 *   id: 'order-123',
 *   marketId: 'market-abc',
 *   tokenId: 'token-yes',
 *   side: 'BUY',
 *   price: Price.of(new Decimal('0.65')),
 *   size: Quantity.of(new Decimal('100')),
 *   status: 'PENDING',
 *   timestamp: new Date()
 * });
 *
 * if (result.ok) {
 *   const order = result.value;
 *   const accepted = order.accept();
 *   if (accepted.ok) {
 *     console.log(accepted.value.status); // 'OPEN'
 *   }
 * }
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import type { Price, Quantity, Side, Timestamp } from '@polymarket/value-objects';
import { ValidationError } from '@polymarket/errors';
import type { AssetId, OrderId, FillId } from '@polymarket/ids';
import { asOrderId } from '@polymarket/ids';
import type { OrderChange, FillForOrder } from './types/OrderChange';
import type { OrderStatus } from './value-objects/OrderStatus';
import { OrderFill } from './value-objects/OrderFill';
import { OrderFSM } from './transitions/OrderFSM';
import type { OrderData } from './transitions/handlers';
import { getNotional, getRemainingSize, getFillPercentage } from './utils/calculations';
import {
  isFilled,
  isOpen,
  isPending,
  isPartiallyFilled,
  canModify,
} from './utils/predicates';
import { canCancel, canApplyFill } from './transitions/guards';

/**
 * Параметры создания Order
 *
 * @remarks
 * Используется в Order.create() factory method.
 * strategyId опциональный для multi-strategy изоляции.
 */
export interface OrderParams {
  readonly id: OrderId;
  readonly asset: AssetId;
  readonly side: Side;
  readonly price: Price;
  readonly size: Quantity;
  readonly status: OrderStatus;
  readonly timestamp: Timestamp;
  readonly strategyId?: string;
  readonly fill?: OrderFill;
  readonly reason?: string;
}

/**
 * Класс Order - неизменяемая доменная сущность
 *
 * @remarks
 * Все свойства readonly для обеспечения неизменяемости.
 * Методы изменения состояния возвращают НОВЫЙ экземпляр.
 */
export class Order {
  public readonly id: OrderId;
  public readonly asset: AssetId;
  public readonly side: Side;
  public readonly price: Price;
  public readonly size: Quantity;
  public readonly status: OrderStatus;
  public readonly timestamp: Timestamp;
  public readonly strategyId?: string;
  public readonly fill: OrderFill;
  public readonly reason?: string;

  /**
   * Приватный конструктор (используйте Order.create())
   */
  private constructor(params: OrderParams) {
    this.id = params.id;
    this.asset = params.asset;
    this.side = params.side;
    this.price = params.price;
    this.size = params.size;
    this.status = params.status;
    this.timestamp = params.timestamp;
    this.strategyId = params.strategyId;
    this.fill = params.fill || OrderFill.empty();
    this.reason = params.reason;
  }

  /**
   * Создаёт Order с валидацией
   *
   * @param params - Параметры создания заявки
   * @returns Result<Order, ValidationError>
   *
   * @remarks
   * Factory method с Result pattern.
   * Валидирует все обязательные поля и бизнес-правила.
   *
   * @example
   * ```typescript
   * import Decimal from 'decimal.js';
   *
   * const result = Order.create({
   *   id: 'order-123',
   *   marketId: 'market-abc',
   *   tokenId: 'token-yes',
   *   side: 'BUY',
   *   price: Price.of(new Decimal('0.65')),
   *   size: Quantity.of(new Decimal('100')),
   *   status: 'PENDING',
   *   timestamp: new Date()
   * });
   * ```
   */
  public static create(params: OrderParams): Result<Order, ValidationError> {
    // Валидация ID через branded type
    if (!asOrderId(params.id)) {
      return Err(
        new ValidationError('Order ID must be a non-empty string (max 256 chars)', {
          context: { field: 'id', value: params.id },
        })
      );
    }

    // Валидация asset
    if (!params.asset) {
      return Err(
        new ValidationError('Asset is required', {
          context: { field: 'asset', orderId: params.id },
        })
      );
    }

    // Валидация price
    if (!params.price) {
      return Err(
        new ValidationError('Price is required', {
          context: { field: 'price', orderId: params.id },
        })
      );
    }

    // Валидация size
    if (!params.size) {
      return Err(
        new ValidationError('Size is required', {
          context: { field: 'size', orderId: params.id },
        })
      );
    }

    if (!params.size.isPositive()) {
      return Err(
        new ValidationError('Order size must be positive', {
          context: { field: 'size', orderId: params.id, value: params.size.value().toNumber() },
        })
      );
    }

    // Валидация fill (если есть)
    if (params.fill) {
      const fillValidation = OrderFill.create(
        params.fill.getFilledSize(),
        params.fill.getAverageFillPrice(),
        Array.from(params.fill.getFillIds()),
        params.size
      );
      if (!fillValidation.ok) {
        return Err(
          new ValidationError(`Invalid fill: ${fillValidation.error.message}`, {
            context: { field: 'fill', orderId: params.id },
          })
        );
      }
    }

    return Ok(new Order(params));
  }

  // ==================== Status Predicates ====================

  /**
   * Проверяет, полностью ли заполнена заявка
   */
  public isFilled(): boolean {
    return isFilled(this.status);
  }

  /**
   * Проверяет, открыта ли заявка
   */
  public isOpen(): boolean {
    return isOpen(this.status);
  }

  /**
   * Проверяет, находится ли заявка в ожидании
   */
  public isPending(): boolean {
    return isPending(this.status);
  }

  /**
   * Проверяет, частично ли заполнена заявка
   */
  public isPartiallyFilled(): boolean {
    return isPartiallyFilled(this.status, this.fill, this.size);
  }

  /**
   * Проверяет, можно ли отменить заявку
   */
  public canCancel(): boolean {
    return canCancel(this.status);
  }

  /**
   * Проверяет, можно ли модифицировать заявку
   */
  public canModify(): boolean {
    return canModify(this.status);
  }

  // ==================== Calculations ====================

  /**
   * Вычисляет номинальную стоимость заявки
   *
   * @returns Notional (price * size) как Decimal
   *
   * @example
   * ```typescript
   * const notional = order.getNotional();
   * console.log(notional.toNumber()); // 65.0
   * ```
   */
  public getNotional() {
    return getNotional(this.price, this.size);
  }

  /**
   * Возвращает оставшийся незаполненный размер
   *
   * @returns Remaining quantity
   */
  public getRemainingSize(): Quantity {
    return getRemainingSize(this.size, this.fill.getFilledSize());
  }

  /**
   * Возвращает процент заполнения
   *
   * @returns Процент (0-100) как Decimal
   */
  public getFillPercentage() {
    return getFillPercentage(this.fill.getFilledSize(), this.size);
  }

  /**
   * Возвращает количество fills заявки
   */
  public getTradeCount(): number {
    return this.fill.getTradeCount();
  }

  /**
   * Проверяет, был ли применен конкретный fill
   *
   * @param fillId - ID fill для проверки
   * @returns True если fill был применен
   */
  public hasFill(fillId: FillId): boolean {
    return this.fill.hasFill(fillId);
  }

  /**
   * Проверяет, может ли заявка принять данный fill (pre-validation)
   *
   * @param fill - Fill для проверки
   * @returns True если fill может быть применен
   *
   * @remarks
   * Быстрая проверка без создания нового Order.
   * Полезно для фильтрации fills до вызова applyFill().
   * Fill.orderId всегда обязателен — явная проверка совпадения с order.id.
   */
  public canAcceptFill(fill: FillForOrder): boolean {
    return (
      canApplyFill(this.status) &&
      fill.orderId === this.id &&
      fill.side === this.side &&
      fill.size.value().lte(this.getRemainingSize().value()) &&
      !this.hasFill(fill.id)
    );
  }

  // ==================== FSM Transitions ====================

  /**
   * Принять заявку (биржей)
   *
   * @returns Result<Order, ValidationError>
   *
   * @remarks
   * Переход: PENDING → OPEN
   *
   * @example
   * ```typescript
   * const result = order.accept();
   * if (result.ok) {
   *   console.log(result.value.status); // 'OPEN'
   * }
   * ```
   */
  public accept(): Result<Order, ValidationError> {
    const change: OrderChange = { type: 'ACCEPTED' };
    return this._transition(change);
  }

  /**
   * Отклонить заявку (биржей)
   *
   * @param reason - Причина отклонения (обязательна)
   * @returns Result<Order, ValidationError>
   *
   * @remarks
   * Переход: PENDING → REJECTED
   */
  public reject(reason: string): Result<Order, ValidationError> {
    if (!reason || reason.trim().length === 0) {
      return Err(
        new ValidationError('Reject reason must be a non-empty string', {
          context: { orderId: this.id, reason },
        })
      );
    }

    const change: OrderChange = { type: 'REJECTED', reason };
    return this._transition(change);
  }

  /**
   * Отменить заявку (пользователем)
   *
   * @param reason - Причина отмены (опционально)
   * @returns Result<Order, ValidationError>
   *
   * @remarks
   * Переход: OPEN или PARTIALLY_FILLED → CANCELED
   */
  public cancel(reason?: string): Result<Order, ValidationError> {
    const change: OrderChange = {
      type: 'CANCELLED',
      reason: reason || 'User cancelled',
    };
    return this._transition(change);
  }

  /**
   * Истечь заявке по времени
   *
   * @returns Result<Order, ValidationError>
   *
   * @remarks
   * Переход: OPEN или PARTIALLY_FILLED → EXPIRED
   */
  public expire(): Result<Order, ValidationError> {
    const change: OrderChange = { type: 'EXPIRED' };
    return this._transition(change);
  }

  /**
   * Применить fill исполнения к заявке
   *
   * @param fill - Fill данные исполнения
   * @returns Result<Order, ValidationError>
   *
   * @remarks
   * Переходы:
   * - OPEN → PARTIALLY_FILLED (если остаток > 0)
   * - OPEN или PARTIALLY_FILLED → FILLED (если остаток = 0)
   *
   * Fill.orderId всегда обязателен — связь с ордером явная.
   */
  public applyFill(fill: FillForOrder): Result<Order, ValidationError> {
    const change: OrderChange = { type: 'FILL_APPLIED', fill };
    return this._transition(change);
  }

  // ==================== Private FSM ====================

  /**
   * Восстанавливает Order из OrderData без повторной валидации
   *
   * @param data - Данные заявки из FSM handler
   * @returns Новый Order instance
   *
   * @remarks
   * Используется ТОЛЬКО внутри `_transition()` после успешного FSM перехода.
   * Данные уже валидированы при создании исходного Order — повторная
   * валидация излишня и создаёт ложные точки отказа.
   * FSM handlers изменяют только `status`, `fill` и `reason` — инварианты id/asset/price/size/timestamp не нарушаются.
   */
  private static _reconstitute(data: OrderData): Order {
    return new Order(data);
  }

  /**
   * Применяет OrderChange через OrderFSM
   *
   * @param change - OrderChange объект
   * @returns Result<Order, ValidationError>
   *
   * @remarks
   * Централизованный метод для всех переходов состояния.
   * Делегирует обработку в OrderFSM, затем восстанавливает Order
   * через `_reconstitute()` без повторной валидации неизменных полей.
   */
  private _transition(change: OrderChange): Result<Order, ValidationError> {
    const orderData: OrderData = {
      id: this.id,
      asset: this.asset,
      side: this.side,
      price: this.price,
      size: this.size,
      status: this.status,
      timestamp: this.timestamp,
      fill: this.fill,
      strategyId: this.strategyId,
      reason: this.reason,
    };

    const result = OrderFSM.apply(orderData, change);

    if (!result.ok) {
      return Err(
        new ValidationError(result.error.message, {
          context: { orderId: this.id, change: change.type },
        })
      );
    }

    return Ok(Order._reconstitute(result.value));
  }

  // ==================== Serialization ====================

  /**
   * Преобразует Order в plain object
   *
   * @returns Plain object для JSON.stringify()
   */
  public toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      asset: this.asset,
      side: this.side,
      price: this.price.value().toNumber(),
      size: this.size.value().toNumber(),
      status: this.status,
      timestamp: this.timestamp.toISO(),
      strategyId: this.strategyId,
      fill: this.fill.toJSON(),
      reason: this.reason,
      // Вычисляемые поля
      notional: this.getNotional().toNumber(),
      remainingSize: this.getRemainingSize().value().toNumber(),
      fillPercentage: this.getFillPercentage().toNumber(),
    };
  }

  /**
   * Строковое представление
   */
  public toString(): string {
    return `Order[${this.id}]: ${this.side} ${this.size.value().toNumber()} @ ${this.price.value().toNumber()} (${
      this.status
    })`;
  }
}
