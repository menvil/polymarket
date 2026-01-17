/**
 * Order entity
 *
 * @remarks
 * Представляет ордер в торговой системе рынка предсказаний.
 * Ордера являются неизменяемыми сущностями с readonly свойствами.
 *
 * ### Бизнес-правила:
 * 1. Ордер должен иметь валидные tokenId, price и size
 * 2. Цена должна быть в валидном диапазоне [0.01, 0.99]
 * 3. Размер должен быть >= минимального количества
 * 4. Исполненный размер не может превышать исходный размер
 * 5. Средняя цена исполнения должна быть валидной если ордер частично/полностью исполнен
 * 6. Только ордера со статусами PENDING, OPEN или PARTIALLY_FILLED могут быть отменены (см. метод canCancel())
 *
 * ### Жизненный цикл ордера:
 * PENDING → OPEN → FILLED (или CANCELED/REJECTED)
 *
 * @example
 * ```typescript
 * // Create a new buy order
 * const order = Order.create({
 *   id: '0x123...',
 *   marketId: 'market-abc',
 *   tokenId: 'token-yes',
 *   side: 'BUY',
 *   price: Price.fromNumber(0.65),
 *   size: Quantity.fromNumber(100),
 *   status: 'PENDING',
 *   timestamp: new Date(),
 *   strategyId: 'strategy-1'
 * });
 *
 * // Check if order can be canceled
 * if (order.canCancel()) {
 *   console.log('Order can be canceled');
 * }
 *
 * // Calculate notional value
 * const notional = order.getNotional();
 * console.log(`Notional: ${notional}`); // 65.00 (100 * 0.65)
 * ```
 */
import { Price } from '../value-objects/Price.js';
import { Quantity } from '../value-objects/Quantity.js';
import { OrderValidationError } from '../../shared/errors/TradingError.js';
import type { ExecutionEvent, OrderAccepted } from '../events/ExecutionEvent.js';
import { OrderExecutionState, isAllowedTransition } from '../execution/OrderExecutionState.js';
import type { Result } from '../../shared/types/Result.js';
import { Ok, Err } from '../../shared/types/Result.js';

/**
 * Тип стороны ордера
 */
export type OrderSide = 'BUY' | 'SELL';

/**
 * Тип статуса ордера
 */
export type OrderStatus = 'PENDING' | 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED';

/**
 * Параметры создания ордера
 *
 * @remarks
 * v4.2 (Фаза 4): strategyId для multi-strategy изоляции
 */
export interface OrderParams {
  id: string;
  marketId: string;
  tokenId: string;
  side: OrderSide;
  price: Price;
  size: Quantity;
  status: OrderStatus;
  timestamp: Date;
  strategyId: string; // v4.2: для multi-strategy изоляции (optional для обратной совместимости)
  filledSize?: Quantity;
  averageFillPrice?: Price;
}

/**
 * Класс сущности Order
 *
 * @remarks
 * Неизменяемая доменная сущность, представляющая торговый ордер.
 * Все свойства readonly для обеспечения неизменяемости.
 */
export class Order {
  public readonly id: string;
  public readonly marketId: string;
  public readonly tokenId: string;
  public readonly side: OrderSide;
  public readonly price: Price;
  public readonly size: Quantity;
  public readonly status: OrderStatus;
  public readonly timestamp: Date;
  public readonly strategyId: string;
  public readonly filledSize?: Quantity;
  public readonly averageFillPrice?: Price;

  private constructor(params: OrderParams) {
    this.id = params.id;
    this.marketId = params.marketId;
    this.tokenId = params.tokenId;
    this.side = params.side;
    this.price = params.price;
    this.size = params.size;
    this.status = params.status;
    this.timestamp = params.timestamp;
    this.strategyId = params.strategyId; // v4.2: propagate strategyId
    this.filledSize = params.filledSize;
    this.averageFillPrice = params.averageFillPrice;
  }

  /**
   * Создаёт новый экземпляр Order
   *
   * @param params - Параметры создания ордера
   * @returns Экземпляр Order
   * @throws {OrderValidationError} Если валидация не прошла
   *
   * @remarks
   * Фабричный метод, который создаёт и валидирует Order.
   * Выполняет полную валидацию всех бизнес-правил.
   *
   * @example
   * ```typescript
   * const order = Order.create({
   *   id: '0x123abc',
   *   marketId: 'market-abc',
   *   tokenId: 'token-yes-123',
   *   side: 'BUY',
   *   price: Price.fromNumber(0.55),
   *   size: Quantity.fromNumber(50),
   *   status: 'PENDING',
   *   timestamp: new Date(),
   *   strategyId: 'strategy-1'
   * });
   * ```
   */
  public static create(params: OrderParams): Order {
    const order = new Order(params);
    order.validate();
    return order;
  }

  /**
   * Создаёт новый Order aggregate из OrderAccepted event
   *
   * @param event - OrderAccepted event
   * @returns Result<Order, string>
   *
   * @remarks
   * OrderAccepted содержит minimal context (side, marketId, price, size)
   * NO Pending Orders Registry - ExecutionEvent self-contained
   *
   * Invariant checks:
   * - price > 0
   * - size > 0
   * - marketId non-empty
   *
   * @example
   * ```typescript
   * const event: OrderAccepted = {
   *   type: 'OrderAccepted',
   *   orderId: '123',
   *   strategyId: 'strategy-1',
   *   marketId: 'market-abc',
   *   tokenId: 'token-yes',
   *   side: 'BUY',
   *   price: 0.55,
   *   size: 100,
   *   timestamp: new Date()
   * };
   *
   * const result = Order.fromOrderAccepted(event);
   * if (result.ok) {
   *   console.log('Order created:', result.value.id);
   * } else {
   *   console.error('Invariant violation:', result.error);
   * }
   * ```
   */
  public static fromOrderAccepted(event: OrderAccepted): Result<Order, string> {
    // Invariant checks в aggregate, NOT в mapper
    if (event.price <= 0) {
      return Err(`Invariant violation: price ${event.price} <= 0 for order ${event.orderId}`);
    }

    if (event.size <= 0) {
      return Err(`Invariant violation: size ${event.size} <= 0 for order ${event.orderId}`);
    }

    if (!event.marketId || event.marketId.trim().length === 0) {
      return Err(`Invariant violation: marketId empty for order ${event.orderId}`);
    }

    if (!event.tokenId || event.tokenId.trim().length === 0) {
      return Err(`Invariant violation: tokenId empty for order ${event.orderId}`);
    }

    try {
      const order = Order.create({
        id: event.orderId,
        marketId: event.marketId,
        tokenId: event.tokenId,
        side: event.side,
        price: Price.fromNumber(event.price),
        size: Quantity.fromNumber(event.size),
        status: 'OPEN', // OrderAccepted → OPEN state
        timestamp: event.timestamp,
        strategyId: event.strategyId,
        filledSize: Quantity.fromNumber(0), // Initial state
      });

      return Ok(order);
    } catch (error) {
      return Err(`Failed to create Order from OrderAccepted: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Применяет ExecutionEvent к Order aggregate
   *
   * @param event - ExecutionEvent для применения
   * @returns Result<Order, string> - успех или ошибка с нарушением invariant
   *
   * @remarks
   * aggregate logic (invariants, FSM transitions, derived values)
   *
   * Responsibilities:
   * - Вычисление totalFilled из filledDelta
   * - Invariant checks (filledDelta > 0, price > 0, totalFilled <= size)
   * - FSM transitions (OPEN → PARTIALLY_FILLED → FILLED)
   * - Weighted average fillPrice (если multiple fills)
   * - Derived values (remaining = size - totalFilled)
   *
   * FSM transitions проверяются через isAllowedTransition()
   * - Aggregate проверяет: текущий status → target status = allowed?
   * - Invalid transition = Result.fail()
   *
   * Projector НЕ должен содержать эту логику - он только вызывает applyExecutionEvent()
   *
   * @example
   * ```typescript
   * const event: OrderPartiallyFilled = {
   *   type: 'OrderPartiallyFilled',
   *   orderId: '123',
   *   strategyId: 'strategy-1',
   *   marketId: 'market-abc',
   *   tokenId: 'token-yes',
   *   side: 'BUY',
   *   filledDelta: 50,
   *   price: 0.55,
   *   timestamp: new Date()
   * };
   *
   * const result = order.applyExecutionEvent(event);
   * if (result.ok) {
   *   const updatedOrder = result.value;
   *   console.log('Order updated:', updatedOrder.status);
   * } else {
   *   console.error('Failed to apply event:', result.error);
   * }
   * ```
   */
  public applyExecutionEvent(event: ExecutionEvent): Result<Order, string> {
    switch (event.type) {
      case 'OrderAccepted':
        // OrderAccepted не применяется к существующему Order
        // Order создаётся через Order.fromOrderAccepted()
        return Err(`Cannot apply OrderAccepted to existing order ${this.id}`);

      case 'OrderPartiallyFilled':
        return this.applyFill(event.filledDelta, event.price, 'PARTIALLY_FILLED');

      case 'OrderFilled':
        return this.applyFill(event.filledDelta, event.price, 'FILLED');

      case 'OrderCancelled':
        return this.applyTerminalStatus(OrderExecutionState.CANCELED, 'CANCELED');

      case 'OrderRejected':
        return this.applyTerminalStatus(OrderExecutionState.REJECTED, 'REJECTED');

      default: {
        const _exhaustive: never = event;
        return Err(`Unhandled ExecutionEvent: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /**
   * Маппит OrderStatus → OrderExecutionState для FSM transitions
   *
   * @param status - OrderStatus
   * @returns OrderExecutionState
   *
   * @remarks
   * используется для FSM validation в applyExecutionEvent()
   *
   * Mapping:
   * - PENDING → OPEN (считаем как OPEN для FSM)
   * - OPEN → OPEN
   * - PARTIALLY_FILLED → OPEN (частично исполненный ордер все еще открыт)
   * - FILLED → FILLED
   * - CANCELED → CANCELED
   * - REJECTED → CANCELED (считаем как CANCELED для FSM)
   */
  private mapStatusToExecutionState(status: OrderStatus): OrderExecutionState {
    switch (status) {
      case 'PENDING':
      case 'OPEN':
      case 'PARTIALLY_FILLED':
        return OrderExecutionState.OPEN;
      case 'FILLED':
        return OrderExecutionState.FILLED;
      case 'CANCELED':
      case 'REJECTED':
        return OrderExecutionState.CANCELED;
      default: {
        // Exhaustive check: если добавлен новый OrderStatus, компилятор выдаст ошибку
        const _exhaustiveCheck: never = status;
        throw new Error(`Unhandled OrderStatus: ${_exhaustiveCheck}`);
      }
    }
  }

  /**
   * Применяет терминальный статус к ордеру (CANCELED или REJECTED)
   *
   * @param targetState - Целевое состояние FSM (CANCELED или REJECTED)
   * @param status - Новый статус ордера ('CANCELED' или 'REJECTED')
   * @returns Result<Order, string> - обновлённый ордер или ошибка FSM/создания
   *
   * @remarks
   * Вспомогательный метод для устранения дублирования в обработчиках
   * OrderCancelled и OrderRejected. Выполняет:
   * 1. Проверку FSM перехода через isAllowedTransition()
   * 2. Создание нового Order с обновлённым статусом
   * 3. Сохранение всех остальных свойств (id, tokenId, side, price, size, timestamp, filledSize, averageFillPrice)
   */
  private applyTerminalStatus(
    targetState: OrderExecutionState,
    status: 'CANCELED' | 'REJECTED'
  ): Result<Order, string> {
    const currentState = this.mapStatusToExecutionState(this.status);

    if (!isAllowedTransition(currentState, targetState)) {
      return Err(
        `FSM violation: transition ${currentState} → ${targetState} not allowed for order ${this.id}`
      );
    }

    try {
      const updatedOrder = Order.create({
        id: this.id,
        marketId: this.marketId,
        tokenId: this.tokenId,
        side: this.side,
        price: this.price,
        size: this.size,
        status,
        timestamp: this.timestamp,
        strategyId: this.strategyId,
        filledSize: this.filledSize,
        averageFillPrice: this.averageFillPrice,
      });

      return Ok(updatedOrder);
    } catch (error) {
      return Err(`Failed to create updated Order: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Применяет fill к ордеру (частичный или полный)
   *
   * @param filledDelta - Размер исполнения (delta)
   * @param price - Цена исполнения
   * @param targetStatus - Целевой статус ('PARTIALLY_FILLED' или 'FILLED')
   * @returns Result<Order, string>
   */
  private applyFill(
    filledDelta: number,
    price: number,
    targetStatus: 'PARTIALLY_FILLED' | 'FILLED'
  ): Result<Order, string> {
    // Invariant checks
    if (filledDelta <= 0) {
      return Err(`Invariant violation: filledDelta ${filledDelta} <= 0 for order ${this.id}`);
    }

    if (price <= 0) {
      return Err(`Invariant violation: price ${price} <= 0 for order ${this.id}`);
    }

    // Вычисляем новый totalFilled
    const previousFilled = this.filledSize?.value ?? 0;
    const newTotalFilled = previousFilled + filledDelta;

    // Проверяем что не превышаем размер ордера
    if (newTotalFilled > this.size.value) {
      return Err(
        `Invariant violation: totalFilled ${newTotalFilled} > size ${this.size.value} for order ${this.id}`
      );
    }

    // Вычисляем weighted average price
    const previousValue = previousFilled * (this.averageFillPrice?.value ?? 0);
    const newValue = filledDelta * price;
    const newAveragePrice = (previousValue + newValue) / newTotalFilled;

    try {
      const updatedOrder = Order.create({
        id: this.id,
        marketId: this.marketId,
        tokenId: this.tokenId,
        side: this.side,
        price: this.price,
        size: this.size,
        status: targetStatus,
        timestamp: this.timestamp,
        strategyId: this.strategyId,
        filledSize: Quantity.fromNumber(newTotalFilled),
        averageFillPrice: Price.fromNumber(newAveragePrice),
      });

      return Ok(updatedOrder);
    } catch (error) {
      return Err(`Failed to apply fill to Order: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Валидирует ордер согласно бизнес-правилам
   *
   * @throws {OrderValidationError} Если любое правило валидации не прошло
   *
   * @remarks
   * Валидирует следующие правила:
   * 1. ID должен быть непустой строкой
   * 2. TokenId должен быть непустой строкой
   * 3. Side должен быть 'BUY' или 'SELL'
   * 4. Status должен быть валидным OrderStatus
   * 5. Size должен быть положительным
   * 6. Price должна быть в диапазоне [0.01, 0.99]
   * 7. FilledSize (если присутствует) не может превышать исходный размер
   * 8. AverageFillPrice должна быть валидной если filledSize > 0
   * 9. Timestamp должен быть валидной датой
   *
   * @example
   * ```typescript
   * try {
   *   order.validate();
   * } catch (error) {
   *   if (error instanceof OrderValidationError) {
   *     console.error(`Validation failed: ${error.message}`);
   *   }
   * }
   * ```
   */
  public validate(): void {
    // Валидация ID
    if (!this.id || typeof this.id !== 'string' || this.id.trim().length === 0) {
      throw new OrderValidationError('Order ID must be a non-empty string', 'id');
    }

    // Валидация marketId
    if (!this.marketId || typeof this.marketId !== 'string' || this.marketId.trim().length === 0) {
      throw new OrderValidationError('Market ID must be a non-empty string', 'marketId');
    }

    // Валидация tokenId
    if (!this.tokenId || typeof this.tokenId !== 'string' || this.tokenId.trim().length === 0) {
      throw new OrderValidationError('Token ID must be a non-empty string', 'tokenId');
    }

    // Валидация стороны
    if (this.side !== 'BUY' && this.side !== 'SELL') {
      throw new OrderValidationError(`Invalid order side: ${this.side}`, 'side');
    }

    // Валидация статуса
    const validStatuses: OrderStatus[] = ['PENDING', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED'];
    if (!validStatuses.includes(this.status)) {
      throw new OrderValidationError(`Invalid order status: ${this.status}`, 'status');
    }

    // Валидация что размер положительный
    if (!this.size.isPositive()) {
      throw new OrderValidationError('Order size must be positive', 'size');
    }

    // Валидация диапазона цены
    if (this.price.value < 0.01 || this.price.value > 0.99) {
      throw new OrderValidationError(
        `Price must be in range [0.01, 0.99], got ${this.price.value}`,
        'price'
      );
    }

    // Валидация filledSize если присутствует
    if (this.filledSize) {
      if (this.filledSize.isGreaterThan(this.size)) {
        throw new OrderValidationError(
          `Filled size (${this.filledSize.value}) cannot exceed order size (${this.size.value})`,
          'filledSize'
        );
      }
    }

    // Валидация averageFillPrice если filledSize > 0
    if (this.filledSize && this.filledSize.isPositive() && !this.averageFillPrice) {
      throw new OrderValidationError(
        'Average fill price is required when filled size > 0',
        'averageFillPrice'
      );
    }

    // Валидация timestamp
    if (!(this.timestamp instanceof Date) || isNaN(this.timestamp.getTime())) {
      throw new OrderValidationError('Invalid timestamp', 'timestamp');
    }

    // Валидация консистентности статуса с filledSize и averageFillPrice
    // PARTIALLY_FILLED и FILLED требуют наличия filledSize > 0 и averageFillPrice
    if (this.status === 'PARTIALLY_FILLED' || this.status === 'FILLED') {
      if (!this.filledSize || !this.filledSize.isPositive()) {
        throw new OrderValidationError(
          `Status ${this.status} requires filledSize > 0, got ${this.filledSize?.value ?? 'undefined'}`,
          'filledSize'
        );
      }

      if (!this.averageFillPrice) {
        throw new OrderValidationError(
          `Status ${this.status} requires averageFillPrice to be present`,
          'averageFillPrice'
        );
      }
    }

    // Для FILLED дополнительно проверяем что filledSize === size (полное исполнение)
    if (this.status === 'FILLED') {
      if (this.filledSize && !this.filledSize.equals(this.size)) {
        throw new OrderValidationError(
          `Status FILLED requires filledSize (${this.filledSize.value}) to equal size (${this.size.value})`,
          'filledSize'
        );
      }
    }
  }

  /**
   * Проверяет, полностью ли исполнен ордер
   *
   * @returns True если статус ордера FILLED
   *
   * @remarks
   * Исполненный ордер завершил выполнение.
   * Весь запрошенный размер был сопоставлен.
   *
   * @example
   * ```typescript
   * if (order.isFilled()) {
   *   console.log('Order completed');
   * }
   * ```
   */
  public isFilled(): boolean {
    return this.status === 'FILLED';
  }

  /**
   * Проверяет, открыт ли ордер
   *
   * @returns True если статус ордера OPEN
   *
   * @remarks
   * Открытый ордер активно находится в стакане
   * и ожидает исполнения.
   *
   * @example
   * ```typescript
   * if (order.isOpen()) {
   *   console.log('Order is active in the book');
   * }
   * ```
   */
  public isOpen(): boolean {
    return this.status === 'OPEN';
  }

  /**
   * Проверяет, находится ли ордер в ожидании
   *
   * @returns True если статус ордера PENDING
   *
   * @remarks
   * Ордер в ожидании был отправлен, но ещё не
   * принят биржей.
   *
   * @example
   * ```typescript
   * if (order.isPending()) {
   *   console.log('Order awaiting exchange acceptance');
   * }
   * ```
   */
  public isPending(): boolean {
    return this.status === 'PENDING';
  }

  /**
   * Проверяет, может ли ордер быть отменён
   *
   * @returns True если ордер PENDING, OPEN или PARTIALLY_FILLED
   *
   * @remarks
   * Только ордера в состоянии PENDING, OPEN или PARTIALLY_FILLED могут быть отменены.
   * Частично исполненный ордер (PARTIALLY_FILLED) все еще активен и может быть отменён,
   * при этом исполненная часть остается, а оставшаяся часть отменяется.
   *
   * Ордера FILLED, CANCELED и REJECTED не могут быть отменены.
   *
   * Бизнес-правило: Терминальные состояния (FILLED, CANCELED, REJECTED)
   * неизменяемы и не могут переходить в другие состояния.
   *
   * @example
   * ```typescript
   * if (order.canCancel()) {
   *   await exchangeService.cancelOrder(order.id);
   * } else {
   *   console.log('Order cannot be canceled');
   * }
   * ```
   */
  public canCancel(): boolean {
    return this.status === 'PENDING' || this.status === 'OPEN' || this.status === 'PARTIALLY_FILLED';
  }

  /**
   * Вычисляет условную стоимость ордера
   *
   * @returns Условная стоимость (цена * размер)
   *
   * @remarks
   * Условная стоимость = Цена × Размер
   *
   * Для BUY ордеров: Это максимальная сумма, необходимая для исполнения ордера
   * Для SELL ордеров: Это сумма, полученная при исполнении ордера
   *
   * Пример:
   * - Цена: 0.65
   * - Размер: 100
   * - Условная стоимость: 65.00
   *
   * @example
   * ```typescript
   * const order = Order.create({
   *   id: '123',
   *   marketId: 'market-abc',
   *   tokenId: 'token-yes',
   *   side: 'BUY',
   *   price: Price.fromNumber(0.65),
   *   size: Quantity.fromNumber(100),
   *   status: 'PENDING',
   *   timestamp: new Date(),
   *   strategyId: 'strategy-1'
   * });
   *
   * const notional = order.getNotional();
   * console.log(notional); // 65.0
   * ```
   */
  public getNotional(): number {
    return this.price.value * this.size.value;
  }

  /**
   * Получает оставшийся неисполненный размер
   *
   * @returns Оставшееся количество для исполнения
   *
   * @remarks
   * Вычисляет: Исходный размер - Исполненный размер
   *
   * Возвращает исходный размер если не было исполнений.
   * Возвращает ноль если ордер полностью исполнен.
   *
   * @example
   * ```typescript
   * const order = Order.create({
   *   id: '123',
   *   marketId: 'market-abc',
   *   tokenId: 'token-yes',
   *   side: 'BUY',
   *   price: Price.fromNumber(0.55),
   *   size: Quantity.fromNumber(100),
   *   status: 'PARTIALLY_FILLED',
   *   timestamp: new Date(),
   *   strategyId: 'strategy-1',
   *   filledSize: Quantity.fromNumber(40),
   *   averageFillPrice: Price.fromNumber(0.55)
   * });
   *
   * const remaining = order.getRemainingSize();
   * console.log(remaining.value); // 60
   * ```
   */
  public getRemainingSize(): Quantity {
    if (!this.filledSize || this.filledSize.isZero()) {
      return this.size;
    }
    return this.size.subtract(this.filledSize);
  }

  /**
   * Проверяет, частично ли исполнен ордер
   *
   * @returns True если 0 < filledSize < size
   *
   * @remarks
   * Частично исполненный ордер имеет некоторое исполнение, но не завершён.
   *
   * @example
   * ```typescript
   * if (order.isPartiallyFilled()) {
   *   const remaining = order.getRemainingSize();
   *   console.log(`${remaining.value} shares remaining`);
   * }
   * ```
   */
  public isPartiallyFilled(): boolean {
    if (!this.filledSize) {
      return false;
    }
    return this.filledSize.isPositive() && this.filledSize.isLessThan(this.size);
  }

  /**
   * Получает процент исполнения
   *
   * @returns Процент исполнения (0-100)
   *
   * @remarks
   * Вычисляет: (Исполненный размер / Размер) × 100
   *
   * Возвращает 0 если нет исполнений.
   * Возвращает 100 если полностью исполнен.
   *
   * @example
   * ```typescript
   * const fillPct = order.getFillPercentage();
   * console.log(`Order ${fillPct.toFixed(1)}% filled`);
   * ```
   */
  public getFillPercentage(): number {
    if (!this.filledSize || this.filledSize.isZero()) {
      return 0;
    }
    return (this.filledSize.value / this.size.value) * 100;
  }

  /**
   * Создаёт новый ордер с обновлённым статусом
   *
   * @param status - Новый статус ордера
   * @returns Новый экземпляр Order с обновлённым статусом
   *
   * @remarks
   * Создаёт новый неизменяемый экземпляр Order с изменённым статусом.
   * Исходный ордер остаётся неизменным (immutability).
   *
   * @example
   * ```typescript
   * const pendingOrder = Order.create({...});
   * const openOrder = pendingOrder.withStatus('OPEN');
   * ```
   */
  public withStatus(status: OrderStatus): Order {
    return Order.create({
      ...this,
      status
    });
  }

  /**
   * Создаёт новый ордер с исполненным размером и средней ценой
   *
   * @param filledSize - Исполненное количество
   * @param averageFillPrice - Средняя цена исполнения
   * @returns Новый экземпляр Order с информацией об исполнении
   * @throws {OrderValidationError} Если исполненный размер превышает размер ордера
   *
   * @remarks
   * Создаёт новый неизменяемый Order с деталями исполнения.
   * Автоматически устанавливает статус:
   * - FILLED если filledSize >= size (полностью исполнен)
   * - PARTIALLY_FILLED если 0 < filledSize < size (частично исполнен)
   * - Оставляет текущий статус если filledSize = 0
   *
   * @example
   * ```typescript
   * const openOrder = Order.create({...});
   * const filledOrder = openOrder.withFill(
   *   Quantity.fromNumber(100),
   *   Price.fromNumber(0.55)
   * );
   * ```
   */
  public withFill(filledSize: Quantity, averageFillPrice: Price): Order {
    const isFullyFilled = filledSize.equals(this.size) || filledSize.isGreaterThan(this.size);
    const isPartiallyFilled = !filledSize.isZero() && filledSize.isLessThan(this.size);

    return Order.create({
      ...this,
      filledSize,
      averageFillPrice,
      status: isFullyFilled ? 'FILLED' : isPartiallyFilled ? 'PARTIALLY_FILLED' : this.status
    });
  }

  /**
   * Конвертирует ордер в простой объект
   *
   * @returns Представление в виде простого объекта
   *
   * @remarks
   * Полезно для сериализации, логирования или API ответов.
   *
   * @example
   * ```typescript
   * const orderData = order.toJSON();
   * console.log(JSON.stringify(orderData, null, 2));
   * ```
   */
  public toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      marketId: this.marketId,
      tokenId: this.tokenId,
      side: this.side,
      price: this.price.value,
      size: this.size.value,
      status: this.status,
      timestamp: this.timestamp.toISOString(),
      strategyId: this.strategyId,
      filledSize: this.filledSize?.value,
      averageFillPrice: this.averageFillPrice?.value,
      notional: this.getNotional(),
      remainingSize: this.getRemainingSize().value,
      fillPercentage: this.getFillPercentage()
    };
  }

  /**
   * Конвертирует ордер в строковое представление
   *
   * @returns Читаемая строка
   *
   * @example
   * ```typescript
   * console.log(order.toString());
   * // Output: "Order[0x123]: BUY 100 @ 0.5500 (OPEN)"
   * ```
   */
  public toString(): string {
    return `Order[${this.id}]: ${this.side} ${this.size.value} @ ${this.price.toString()} (${this.status})`;
  }
}
