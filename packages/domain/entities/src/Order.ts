/**
 * Сущность Order (Ордер)
 *
 * @remarks
 * Представляет ордер в системе трейдинга на рынках предсказаний.
 * Ордера являются неизменяемыми сущностями с readonly свойствами.
 *
 * ### Бизнес-правила:
 * 1. Ордер должен иметь валидные tokenId, price и size
 * 2. Цена должна быть в валидном диапазоне [0.01, 0.99]
 * 3. Размер должен быть >= минимального количества
 * 4. Заполненный размер не может превышать исходный размер
 * 5. Средняя цена исполнения должна быть валидной если ордер частично/полностью исполнен
 * 6. Только PENDING или OPEN ордера могут быть отменены
 *
 * ### Жизненный цикл ордера:
 * PENDING → OPEN → PARTIALLY_FILLED → FILLED (или CANCELED/REJECTED на любом этапе)
 *
 * @example
 * ```typescript
 * // Создание нового ордера на покупку
 * const order = Order.create({
 *   id: '0x123...',
 *   tokenId: 'token-yes',
 *   side: 'BUY',
 *   price: Price.fromValue(0.65).value!,
 *   size: Quantity.fromValue(100).value!,
 *   status: 'PENDING',
 *   timestamp: new Date()
 * });
 *
 * // Проверка возможности отмены ордера
 * if (order.value.canCancel()) {
 *   console.log('Ордер можно отменить');
 * }
 *
 * // Расчёт номинальной стоимости
 * const notional = order.value.getNotional();
 * console.log(`Notional: ${notional}`); // 65.00 (100 * 0.65)
 * ```
 */
import { Price } from '@polymarket/value-objects';
import { Quantity } from '@polymarket/value-objects';
import { OrderValidationError } from '@polymarket/errors';
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { TradeSide } from './Trade.js';
import Decimal from 'decimal.js';

/**
 * Тип статуса ордера
 */
export type OrderStatus = 'PENDING' | 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED';

/**
 * Параметры создания ордера
 *
 * @remarks
 * strategyId опциональный для multi-strategy изоляции (optional для обратной совместимости)
 */
export interface OrderParams {
  id: string;
  marketId: string;
  tokenId: string;
  side: TradeSide;
  price: Price;
  size: Quantity;
  status: OrderStatus;
  timestamp: Date;
  strategyId?: string;
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
  public readonly side: TradeSide;
  public readonly price: Price;
  public readonly size: Quantity;
  public readonly status: OrderStatus;
  public readonly timestamp: Date;
  public readonly strategyId?: string;
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
    this.strategyId = params.strategyId;
    this.filledSize = params.filledSize;
    this.averageFillPrice = params.averageFillPrice;
  }

  /**
   * Создаёт новый Order с валидацией
   *
   * @param params - Параметры создания ордера
   * @returns Result<Order, OrderValidationError>
   *
   * @remarks
   * Factory method с Result pattern.
   * Валидирует все обязательные поля и бизнес-правила:
   * - ID, marketId, tokenId не пустые
   * - side = 'BUY' или 'SELL'
   * - status валидный
   * - size положительный
   * - filledSize не превышает size
   * - averageFillPrice присутствует если filledSize > 0
   * - timestamp валидный Date
   *
   * @example
   * ```typescript
   * const result = Order.create({
   *   id: 'order-123',
   *   marketId: 'market-abc',
   *   tokenId: 'token-yes-456',
   *   side: 'BUY',
   *   price: Price.fromValue(0.65).value!,
   *   size: Quantity.fromValue(100).value!,
   *   status: 'OPEN',
   *   timestamp: new Date()
   * });
   *
   * if (result.ok) {
   *   const order = result.value;
   *   console.log('Order created:', order.id);
   * } else {
   *   console.error('Validation failed:', result.error.message);
   * }
   * ```
   */
  public static create(params: OrderParams): Result<Order, OrderValidationError> {
    // Валидация ID
    if (!params.id || typeof params.id !== 'string' || params.id.trim() === '') {
      return Err(
        new OrderValidationError(
          'Order ID must be a non-empty string',
          {
            context: { field: 'id', value: params.id }
          }
        )
      );
    }

    // Валидация marketId
    if (!params.marketId || typeof params.marketId !== 'string' || params.marketId.trim() === '') {
      return Err(
        new OrderValidationError(
          'Market ID must be a non-empty string',
          {
            context: { field: 'marketId', orderId: params.id, value: params.marketId }
          }
        )
      );
    }

    // Валидация tokenId
    if (!params.tokenId || typeof params.tokenId !== 'string' || params.tokenId.trim() === '') {
      return Err(
        new OrderValidationError(
          'Token ID must be a non-empty string',
          {
            context: { field: 'tokenId', orderId: params.id, value: params.tokenId }
          }
        )
      );
    }

    // Валидация side
    if (params.side !== 'BUY' && params.side !== 'SELL') {
      return Err(
        new OrderValidationError(
          `Invalid order side: ${params.side}`,
          {
            context: {
              field: 'side',
              orderId: params.id,
              value: params.side,
              validValues: ['BUY', 'SELL']
            }
          }
        )
      );
    }

    // Валидация price (existence)
    if (!params.price) {
      return Err(
        new OrderValidationError(
          'Price is required',
          {
            context: { field: 'price', orderId: params.id, value: params.price }
          }
        )
      );
    }

    // Валидация size (existence)
    if (!params.size) {
      return Err(
        new OrderValidationError(
          'Size is required',
          {
            context: { field: 'size', orderId: params.id, value: params.size }
          }
        )
      );
    }

    // Валидация size (business rule)
    if (!params.size.isPositive()) {
      return Err(
        new OrderValidationError(
          'Order size must be positive',
          {
            context: { field: 'size', orderId: params.id, value: params.size.value }
          }
        )
      );
    }

    // Валидация filledSize
    if (params.filledSize && params.filledSize.isGreaterThan(params.size)) {
      return Err(
        new OrderValidationError(
          `Filled size (${params.filledSize.value}) cannot exceed order size (${params.size.value})`,
          {
            context: {
              field: 'filledSize',
              orderId: params.id,
              filledSize: params.filledSize.value,
              orderSize: params.size.value
            }
          }
        )
      );
    }

    // Валидация averageFillPrice если filledSize > 0
    if (params.filledSize && params.filledSize.isPositive() && !params.averageFillPrice) {
      return Err(
        new OrderValidationError(
          'Average fill price is required when filled size > 0',
          {
            context: { field: 'averageFillPrice', orderId: params.id }
          }
        )
      );
    }

    // Валидация timestamp
    if (!(params.timestamp instanceof Date) || isNaN(params.timestamp.getTime())) {
      return Err(
        new OrderValidationError(
          'Invalid timestamp',
          {
            context: { field: 'timestamp', orderId: params.id, value: params.timestamp }
          }
        )
      );
    }

    return Ok(new Order(params));
  }

  /**
   * Создаёт Order из JSON данных
   *
   * @param json - JSON объект с данными ордера
   * @returns Result<Order, OrderValidationError>
   *
   * @remarks
   * Преобразует примитивные типы в value objects и создаёт Order.
   * Валидация происходит через Order.create().
   *
   * @example
   * ```typescript
   * const json = {
   *   id: 'order-123',
   *   marketId: 'market-abc',
   *   tokenId: 'token-yes',
   *   side: 'BUY',
   *   price: 0.65,
   *   size: 100,
   *   status: 'OPEN',
   *   timestamp: '2024-01-15T10:30:00.000Z',
   *   filledSize: 50,
   *   averageFillPrice: 0.64
   * };
   *
   * const result = Order.fromJSON(json);
   * if (result.ok) {
   *   console.log('Order loaded:', result.value.id);
   * } else {
   *   console.error('Invalid JSON:', result.error.message);
   * }
   * ```
   */
  public static fromJSON(json: Record<string, unknown>): Result<Order, OrderValidationError> {
    // Валидация обязательных полей
    if (!json.id || typeof json.id !== 'string') {
      return Err(
        new OrderValidationError(
          'Missing or invalid id in JSON',
          {
            context: { field: 'id', value: json.id }
          }
        )
      );
    }

    if (!json.marketId || typeof json.marketId !== 'string') {
      return Err(
        new OrderValidationError(
          'Missing or invalid marketId in JSON',
          {
            context: { field: 'marketId', orderId: json.id, value: json.marketId }
          }
        )
      );
    }

    if (!json.tokenId || typeof json.tokenId !== 'string') {
      return Err(
        new OrderValidationError(
          'Missing or invalid tokenId in JSON',
          {
            context: { field: 'tokenId', orderId: json.id, value: json.tokenId }
          }
        )
      );
    }

    if (!json.side || (json.side !== 'BUY' && json.side !== 'SELL')) {
      return Err(
        new OrderValidationError(
          'Missing or invalid side in JSON',
          {
            context: { field: 'side', orderId: json.id, value: json.side }
          }
        )
      );
    }

    if (typeof json.price !== 'number') {
      return Err(
        new OrderValidationError(
          'Missing or invalid price in JSON',
          {
            context: { field: 'price', orderId: json.id, value: json.price }
          }
        )
      );
    }

    if (typeof json.size !== 'number') {
      return Err(
        new OrderValidationError(
          'Missing or invalid size in JSON',
          {
            context: { field: 'size', orderId: json.id, value: json.size }
          }
        )
      );
    }

    if (!json.status || typeof json.status !== 'string') {
      return Err(
        new OrderValidationError(
          'Missing or invalid status in JSON',
          {
            context: { field: 'status', orderId: json.id, value: json.status }
          }
        )
      );
    }

    // Парсинг timestamp
    let timestamp: Date;
    if (json.timestamp instanceof Date) {
      timestamp = json.timestamp;
    } else if (typeof json.timestamp === 'string') {
      timestamp = new Date(json.timestamp);
    } else {
      return Err(
        new OrderValidationError(
          'Missing or invalid timestamp in JSON',
          {
            context: { field: 'timestamp', orderId: json.id, value: json.timestamp }
          }
        )
      );
    }

    // Создание Price value object
    const priceResult = Price.fromValue(json.price as number);
    if (!priceResult.ok) {
      return Err(
        new OrderValidationError(
          `Invalid price value: ${priceResult.error.message}`,
          {
            context: { field: 'price', orderId: json.id, value: json.price }
          }
        )
      );
    }

    // Создание Quantity value object для size
    const sizeResult = Quantity.fromValue(json.size as number);
    if (!sizeResult.ok) {
      return Err(
        new OrderValidationError(
          `Invalid size value: ${sizeResult.error.message}`,
          {
            context: { field: 'size', orderId: json.id, value: json.size }
          }
        )
      );
    }

    // Опциональный filledSize
    let filledSize: Quantity | undefined;
    if (json.filledSize !== undefined && json.filledSize !== null) {
      if (typeof json.filledSize !== 'number') {
        return Err(
          new OrderValidationError(
            'Invalid filledSize in JSON',
            {
              context: { field: 'filledSize', orderId: json.id, value: json.filledSize }
            }
          )
        );
      }
      const filledSizeResult = Quantity.fromValue(json.filledSize);
      if (!filledSizeResult.ok) {
        return Err(
          new OrderValidationError(
            `Invalid filledSize value: ${filledSizeResult.error.message}`,
            {
              context: { field: 'filledSize', orderId: json.id, value: json.filledSize }
            }
          )
        );
      }
      filledSize = filledSizeResult.value;
    }

    // Опциональный averageFillPrice
    let averageFillPrice: Price | undefined;
    if (json.averageFillPrice !== undefined && json.averageFillPrice !== null) {
      if (typeof json.averageFillPrice !== 'number') {
        return Err(
          new OrderValidationError(
            'Invalid averageFillPrice in JSON',
            {
              context: { field: 'averageFillPrice', orderId: json.id, value: json.averageFillPrice }
            }
          )
        );
      }
      const avgPriceResult = Price.fromValue(json.averageFillPrice);
      if (!avgPriceResult.ok) {
        return Err(
          new OrderValidationError(
            `Invalid averageFillPrice value: ${avgPriceResult.error.message}`,
            {
              context: { field: 'averageFillPrice', orderId: json.id, value: json.averageFillPrice }
            }
          )
        );
      }
      averageFillPrice = avgPriceResult.value;
    }

    // Создание Order через create()
    return Order.create({
      id: json.id as string,
      marketId: json.marketId as string,
      tokenId: json.tokenId as string,
      side: json.side as TradeSide,
      price: priceResult.value,
      size: sizeResult.value,
      status: json.status as OrderStatus,
      timestamp,
      strategyId: typeof json.strategyId === 'string' ? json.strategyId : undefined,
      filledSize,
      averageFillPrice,
    });
  }

  /**
   * Проверяет, полностью ли заполнен ордер
   *
   * @returns True если статус ордера FILLED
   *
   * @remarks
   * Заполненный ордер завершил исполнение.
   * Весь запрошенный объем был исполнен.
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
   * Ордер в ожидании был отправлен, но еще не принят биржей.
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
   * Проверяет, можно ли отменить ордер
   *
   * @returns True если ордер в статусе PENDING или OPEN
   *
   * @remarks
   * Только ордера в статусе PENDING или OPEN могут быть отменены.
   * Ордера в статусе FILLED, CANCELED и REJECTED не могут быть отменены.
   *
   * Бизнес-правило: Терминальные статусы (FILLED, CANCELED, REJECTED)
   * неизменны и не могут переходить в другие состояния.
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
    return this.status === 'PENDING' || this.status === 'OPEN';
  }

  /**
   * Вычисляет номинальную стоимость ордера
   *
   * @returns Номинальная стоимость (price * size) как Decimal
   *
   * @remarks
   * Notional = Цена × Размер
   *
   * Для BUY ордеров: Это максимальная сумма необходимая для исполнения ордера
   * Для SELL ордеров: Это сумма которая будет получена при исполнении ордера
   *
   * Использует Decimal.js для точных вычислений без ошибок округления.
   *
   * Пример:
   * - Цена: 0.65
   * - Размер: 100
   * - Notional: 65.00
   *
   * @example
   * ```typescript
   * const result = Order.create({
   *   id: '123',
   *   marketId: 'market-abc',
   *   tokenId: 'token-yes',
   *   side: 'BUY',
   *   price: Price.fromValue(0.65).value!,
   *   size: Quantity.fromValue(100).value!,
   *   status: 'PENDING',
   *   timestamp: new Date()
   * });
   *
   * if (result.ok) {
   *   const notional = result.value.getNotional();
   *   console.log(notional.toNumber()); // 65.0
   * }
   * ```
   */
  public getNotional(): Decimal {
    return new Decimal(this.price.value).times(this.size.value);
  }

  /**
   * Возвращает оставшийся незаполненный размер
   *
   * @returns Оставшееся количество для заполнения
   *
   * @remarks
   * Вычисляет: Исходный размер - Заполненный размер
   *
   * Возвращает исходный размер если не было заполнения.
   * Возвращает ноль если ордер полностью заполнен.
   *
   * @example
   * ```typescript
   * const result = Order.create({
   *   id: '123',
   *   marketId: 'market-abc',
   *   tokenId: 'token-yes',
   *   side: 'BUY',
   *   price: Price.fromValue(0.55).value!,
   *   size: Quantity.fromValue(100).value!,
   *   status: 'OPEN',
   *   timestamp: new Date(),
   *   filledSize: Quantity.fromValue(40).value!
   * });
   *
   * if (result.ok) {
   *   const remaining = result.value.getRemainingSize();
   *   console.log(remaining.value); // 60
   * }
   * ```
   */
  public getRemainingSize(): Quantity {
    if (!this.filledSize || this.filledSize.isZero()) {
      return this.size;
    }
    const remainingResult = this.size.subtract(this.filledSize);
    if (!remainingResult.ok) {
      // Не должно произойти если filledSize <= size (проверяется в create)
      return this.size;
    }
    return remainingResult.value;
  }

  /**
   * Проверяет, частично ли заполнен ордер
   *
   * @returns True если 0 < filledSize < size
   *
   * @remarks
   * Частично заполненный ордер имеет некоторое исполнение, но не завершен.
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
   * Возвращает процент заполнения
   *
   * @returns Процент заполнения (0-100) как Decimal
   *
   * @remarks
   * Вычисляет: (FilledSize / Size) × 100
   *
   * Возвращает 0 если не было заполнения.
   * Возвращает 100 если ордер полностью заполнен.
   *
   * Использует Decimal.js для точных вычислений без ошибок округления.
   *
   * @example
   * ```typescript
   * const fillPct = order.getFillPercentage();
   * console.log(`Order ${fillPct.toFixed(1)}% filled`);
   * ```
   */
  public getFillPercentage(): Decimal {
    if (!this.filledSize || this.filledSize.isZero()) {
      return new Decimal(0);
    }
    return new Decimal(this.filledSize.value)
      .dividedBy(this.size.value)
      .times(100);
  }

  /**
   * Создает новый ордер с обновленным статусом
   *
   * @param status - Новый статус ордера
   * @returns Result<Order, OrderValidationError> с новым экземпляром или ошибкой
   *
   * @remarks
   * Создает новый неизменяемый экземпляр Order с измененным статусом.
   * Исходный ордер остается неизменным (immutability).
   *
   * Следует Result паттерну - возвращает Ok(order) при успехе или Err(error) при ошибке валидации.
   *
   * @example
   * ```typescript
   * const pendingResult = Order.create({...});
   * if (pendingResult.ok) {
   *   const openResult = pendingResult.value.withStatus('OPEN');
   *   if (openResult.ok) {
   *     const openOrder = openResult.value;
   *     console.log('Order is now OPEN');
   *   }
   * }
   * ```
   */
  public withStatus(status: OrderStatus): Result<Order, OrderValidationError> {
    return Order.create({
      ...this,
      status
    });
  }

  /**
   * Создает новый ордер с информацией о заполнении
   *
   * @param filledSize - Заполненное количество
   * @param averageFillPrice - Средняя цена исполнения
   * @returns Result<Order, OrderValidationError> с новым экземпляром или ошибкой
   *
   * @remarks
   * Создает новый неизменяемый Order с деталями исполнения.
   * Автоматически устанавливает статус FILLED если полностью исполнен.
   *
   * Следует Result паттерну - возвращает Ok(order) при успехе или Err(error) при ошибке валидации.
   *
   * @example
   * ```typescript
   * const openResult = Order.create({...});
   * if (openResult.ok) {
   *   const fillResult = openResult.value.withFill(
   *     Quantity.fromValue(100).value!,
   *     Price.fromValue(0.55).value!
   *   );
   *   if (fillResult.ok) {
   *     const filledOrder = fillResult.value;
   *     console.log('Order filled');
   *   }
   * }
   * ```
   */
  public withFill(filledSize: Quantity, averageFillPrice: Price): Result<Order, OrderValidationError> {
    const isFullyFilled = filledSize.equals(this.size) || filledSize.isGreaterThan(this.size);

    return Order.create({
      ...this,
      filledSize,
      averageFillPrice,
      status: isFullyFilled ? 'FILLED' : this.status
    });
  }

  /**
   * Преобразует Order в plain object
   *
   * @returns Представление в виде простого объекта
   *
   * @remarks
   * Используется для сериализации, логирования, или API responses.
   * Включает вычисляемые поля (notional, remainingSize, fillPercentage).
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
      notional: this.getNotional().toNumber(),
      remainingSize: this.getRemainingSize().value,
      fillPercentage: this.getFillPercentage().toNumber()
    };
  }

  /**
   * Преобразует ордер в строковое представление
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
