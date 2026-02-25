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
 *
 * // Создание новой заявки
 * const result = Order.create({
 *   id: 'order-123',
 *   marketId: 'market-abc',
 *   tokenId: 'token-yes',
 *   side: 'BUY',
 *   price: Price.fromValue(0.65).value()!,
 *   size: Quantity.fromValue(100).value()!,
 *   status: 'PENDING',
 *   timestamp: new Date()
 * });
 *
 * if (result.ok) {
 *   const order = result.value();
 *
 *   // Принять заявку
 *   const accepted = order.accept();
 *   if (accepted.ok) {
 *     console.log(accepted.value().status); // 'OPEN'
 *   }
 * }
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import type { Price, Quantity, Side, Timestamp } from '@polymarket/value-objects';
import { ValidationError } from '@polymarket/errors';
import type { OrderId, AccountId, VenueId, InstrumentId, AssetId } from '@polymarket/ids';
import type { OrderChange, FillForOrder } from '../types/OrderChange';
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
import { canCancel } from './transitions/guards';

/**
 * Параметры создания Order
 *
 * @remarks
 * Используется в Order.create() factory method.
 *
 * ### Обязательные поля:
 * - **id** - уникальный идентификатор заявки (OrderId)
 * - **accountId** - идентификатор аккаунта владельца
 * - **venueId** - идентификатор venue/биржи
 * - **instrumentId** - идентификатор инструмента (рынок + токен)
 * - **asset** - идентификатор актива для расчетов
 * - **side** - направление (BUY/SELL)
 * - **price** - цена заявки
 * - **size** - размер заявки
 * - **status** - статус заявки
 * - **timestamp** - время создания/обновления
 * - **fill** - информация о заполнении (всегда присутствует, OrderFill.empty() для новых)
 *
 * ### Опциональные поля:
 * - **strategyId** - идентификатор стратегии (для multi-strategy изоляции)
 * - **reason** - причина отклонения/отмены/истечения (deprecated, использовать status.reason)
 */
export interface OrderParams {
  readonly id: OrderId;
  readonly accountId: AccountId;
  readonly venueId: VenueId;
  readonly instrumentId: InstrumentId;
  readonly asset: AssetId;
  readonly side: Side;
  readonly price: Price;
  readonly size: Quantity;
  readonly status: OrderStatus;
  readonly timestamp: Timestamp;
  readonly fill: OrderFill;
  readonly strategyId?: string;
  readonly reason?: string;
}

/**
 * Класс Order - неизменяемая доменная сущность
 *
 * @remarks
 * Все свойства readonly для обеспечения неизменяемости.
 * Методы изменения состояния возвращают НОВЫЙ экземпляр.
 *
 * ### Идентификаторы:
 * - **id** - уникальный ID заявки
 * - **accountId** - владелец заявки
 * - **venueId** - биржа на которой размещена
 * - **instrumentId** - инструмент (рынок + outcome token)
 * - **asset** - актив для расчетов (обычно USDC)
 *
 * ### Параметры заявки:
 * - **side** - направление (BUY/SELL)
 * - **price** - цена
 * - **size** - размер
 *
 * ### Состояние:
 * - **status** - текущий статус (discriminated union с typed reasons)
 * - **fill** - информация о заполнении (всегда присутствует)
 * - **timestamp** - время последнего обновления
 *
 * ### Опциональные:
 * - **strategyId** - ID стратегии (если заявка создана ботом)
 * - **reason** - deprecated, использовать status.reason
 */
export class Order {
  public readonly id: OrderId;
  public readonly accountId: AccountId;
  public readonly venueId: VenueId;
  public readonly instrumentId: InstrumentId;
  public readonly asset: AssetId;
  public readonly side: Side;
  public readonly price: Price;
  public readonly size: Quantity;
  public readonly status: OrderStatus;
  public readonly timestamp: Timestamp;
  public readonly fill: OrderFill;
  public readonly strategyId?: string;
  public readonly reason?: string;

  /**
   * Приватный конструктор (используйте Order.create())
   */
  private constructor(params: OrderParams) {
    this.id = params.id;
    this.accountId = params.accountId;
    this.venueId = params.venueId;
    this.instrumentId = params.instrumentId;
    this.asset = params.asset;
    this.side = params.side;
    this.price = params.price;
    this.size = params.size;
    this.status = params.status;
    this.timestamp = params.timestamp;
    this.fill = params.fill;
    this.strategyId = params.strategyId;
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
   * ### Валидации:
   * 1. Все ID поля должны быть валидными branded types
   * 2. Price и Size должны быть валидными value objects
   * 3. Size должен быть > 0
   * 4. Fill должен быть валидным и не превышать size
   * 5. Timestamp должен быть валидным
   *
   * @example
   * ```typescript
   * import { Order, OrderStatus } from './Order';
   * import { Price, Quantity, Timestamp, Side } from '@polymarket/value-objects';
   * import { asOrderId, asAccountId, asVenueId, asInstrumentId, asAssetId } from '@polymarket/ids';
   * import { OrderFill } from './value-objects/OrderFill';
   *
   * const result = Order.create({
   *   id: asOrderId('order-123')!,
   *   accountId: asAccountId('account-456')!,
   *   venueId: asVenueId('polymarket')!,
   *   instrumentId: asInstrumentId('market-abc-token-yes')!,
   *   asset: asAssetId('USDC')!,
   *   side: Side.BUY,
   *   price: Price.of(new Decimal(0.65)),
   *   size: Quantity.of(new Decimal(100)),
   *   status: OrderStatus.pending(),
   *   timestamp: Timestamp.now(),
   *   fill: OrderFill.empty()
   * });
   *
   * if (result.ok) {
   *   const order = result.value();
   *   console.log(order.id); // 'order-123'
   * }
   * ```
   */
  public static create(params: OrderParams): Result<Order, ValidationError> {
    // Валидация ID (branded types уже валидированы, проверяем только наличие)
    if (!params.id) {
      return Err(
        new ValidationError('Order ID is required', {
          context: { field: 'id', value: params.id },
        })
      );
    }

    if (!params.accountId) {
      return Err(
        new ValidationError('Account ID is required', {
          context: { field: 'accountId', orderId: params.id },
        })
      );
    }

    if (!params.venueId) {
      return Err(
        new ValidationError('Venue ID is required', {
          context: { field: 'venueId', orderId: params.id },
        })
      );
    }

    if (!params.instrumentId) {
      return Err(
        new ValidationError('Instrument ID is required', {
          context: { field: 'instrumentId', orderId: params.id },
        })
      );
    }

    if (!params.asset) {
      return Err(
        new ValidationError('Asset ID is required', {
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

    // Валидация fill (теперь обязательное поле)
    if (!params.fill) {
      return Err(
        new ValidationError('Fill is required (use OrderFill.empty() for new orders)', {
          context: { field: 'fill', orderId: params.id },
        })
      );
    }

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

    // Валидация timestamp
    if (!params.timestamp) {
      return Err(
        new ValidationError('Timestamp is required', {
          context: { field: 'timestamp', orderId: params.id },
        })
      );
    }

    // Валидация status
    if (!params.status) {
      return Err(
        new ValidationError('Status is required', {
          context: { field: 'status', orderId: params.id },
        })
      );
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
   * Возвращает количество trades заполнивших заявку
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
  public hasFill(fillId: string): boolean {
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
      canCancel(this.status) &&
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
   *   console.log(result.value().status); // 'OPEN'
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
   * Применяет OrderChange через OrderFSM
   *
   * @param change - OrderChange объект
   * @returns Result<Order, ValidationError>
   *
   * @remarks
   * Централизованный метод для всех переходов состояния.
   * Делегирует обработку в OrderFSM.
   */
  private _transition(change: OrderChange): Result<Order, ValidationError> {
    // Конвертируем текущий Order в OrderData
    const orderData: OrderData = {
      id: this.id,
      accountId: this.accountId,
      venueId: this.venueId,
      instrumentId: this.instrumentId,
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

    // Применяем change через FSM
    const result = OrderFSM.apply(orderData, change);

    if (!result.ok) {
      // Конвертируем Error в ValidationError
      return Err(
        new ValidationError(result.error.message, {
          context: { orderId: this.id, change: change.type },
        })
      );
    }

    // Создаем новый Order из обновленных данных
    return Order.create({
      id: result.value().id,
      accountId: result.value().accountId,
      venueId: result.value().venueId,
      instrumentId: result.value().instrumentId,
      asset: result.value().asset,
      side: result.value().side,
      price: result.value().price,
      size: result.value().size,
      status: result.value().status,
      timestamp: result.value().timestamp,
      fill: result.value().fill,
      strategyId: result.value().strategyId,
      reason: result.value().reason,
    });
  }

  // ==================== Serialization ====================

  /**
   * Преобразует Order в plain object
   *
   * @returns Plain object для JSON.stringify()
   */
  public toJSON(): Record<string, unknown> {
    return {
      // Идентификаторы
      id: this.id,
      accountId: this.accountId,
      venueId: this.venueId,
      instrumentId: this.instrumentId,
      asset: this.asset,
      // Параметры заявки
      side: this.side,
      price: this.price.value().toNumber(),
      size: this.size.value().toNumber(),
      // Состояние
      status: this.status,
      timestamp: this.timestamp.toEpochMs(),
      fill: this.fill.toJSON(),
      // Опциональные
      strategyId: this.strategyId,
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
      this.status.type
    })`;
  }
}
