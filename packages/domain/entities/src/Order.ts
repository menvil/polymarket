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
import { Price, Quantity, type Side } from '@polymarket/value-objects';
import { OrderValidationError } from '@polymarket/errors';
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { Trade } from './Trade.js';
import type { OrderChange } from './types/OrderChange.js';
import Decimal from 'decimal.js';

/**
 * Тип статуса ордера
 */
export type OrderStatus = 'PENDING' | 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED';

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
  side: Side;
  price: Price;
  size: Quantity;
  status: OrderStatus;
  timestamp: Date;
  strategyId?: string;
  filledSize?: Quantity;
  averageFillPrice?: Price;
  tradeIds?: string[]; // IDs сделок, заполнивших заявку (denormalization для performance)
  reason?: string; // Причина для REJECTED/CANCELED/EXPIRED статусов
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
  public readonly side: Side;
  public readonly price: Price;
  public readonly size: Quantity;
  public readonly status: OrderStatus;
  public readonly timestamp: Date;
  public readonly strategyId?: string;
  public readonly filledSize?: Quantity;
  public readonly averageFillPrice?: Price;
  public readonly tradeIds: string[]; // IDs сделок, заполнивших заявку
  public readonly reason?: string; // Причина для REJECTED/CANCELED/EXPIRED

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
    // Делаем shallow copy для immutability
    this.tradeIds = params.tradeIds ? [...params.tradeIds] : [];
    this.reason = params.reason;
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

    // Парсинг tradeIds (опционально)
    let tradeIds: string[] | undefined;
    if (json.tradeIds !== undefined && json.tradeIds !== null) {
      if (!Array.isArray(json.tradeIds)) {
        return Err(
          new OrderValidationError(
            'Invalid tradeIds in JSON (must be an array)',
            {
              context: { field: 'tradeIds', orderId: json.id, value: json.tradeIds }
            }
          )
        );
      }
      // Проверка что все элементы - строки
      if (!json.tradeIds.every((id: unknown) => typeof id === 'string')) {
        return Err(
          new OrderValidationError(
            'Invalid tradeIds in JSON (all elements must be strings)',
            {
              context: { field: 'tradeIds', orderId: json.id, value: json.tradeIds }
            }
          )
        );
      }
      tradeIds = json.tradeIds as string[];
    }

    // Парсинг reason (опционально)
    const reason = typeof json.reason === 'string' ? json.reason : undefined;

    // Создание Order через create()
    return Order.create({
      id: json.id as string,
      marketId: json.marketId as string,
      tokenId: json.tokenId as string,
      side: json.side as Side,
      price: priceResult.value,
      size: sizeResult.value,
      status: json.status as OrderStatus,
      timestamp,
      strategyId: typeof json.strategyId === 'string' ? json.strategyId : undefined,
      filledSize,
      averageFillPrice,
      tradeIds,
      reason,
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
   * @returns True если ордер может быть отменен
   *
   * @remarks
   * Заявка может быть отменена только если:
   * - Статус OPEN или PARTIALLY_FILLED
   *
   * PENDING заявки не могут быть отменены напрямую - они должны быть
   * либо accepted (→ OPEN) либо rejected (→ REJECTED) биржей.
   *
   * Терминальные статусы (FILLED, CANCELED, REJECTED, EXPIRED) не могут
   * переходить в другие состояния.
   *
   * Используется в UI для показа кнопки "Cancel".
   *
   * @example
   * ```typescript
   * if (order.canCancel()) {
   *   const result = order.cancel('User cancelled');
   *   // result.ok будет true
   * } else {
   *   console.log('Order cannot be canceled');
   * }
   * ```
   */
  public canCancel(): boolean {
    return this.status === 'OPEN' || this.status === 'PARTIALLY_FILLED';
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
   * Возвращает количество trades, заполнивших эту заявку
   *
   * @returns Количество trades
   *
   * @remarks
   * Полезно для аналитики: сколько частичных fills произошло.
   * Если заявка не была filled - возвращает 0.
   *
   * @example
   * ```typescript
   * const order = unwrap(Order.create({ ...params, tradeIds: ['t1', 't2', 't3'] }));
   * console.log(order.getTradeCount()); // 3
   * ```
   */
  public getTradeCount(): number {
    return this.tradeIds.length;
  }

  /**
   * Проверяет, был ли применен конкретный trade к этой заявке
   *
   * @param tradeId - ID trade для проверки
   * @returns True если trade был применен
   *
   * @remarks
   * Используется для:
   * - Предотвращения дубликатов (уже проверяется в _applyTrade)
   * - Reconciliation: проверка что все ожидаемые trades применены
   * - Аудит: трассировка исполнения заявки
   *
   * @example
   * ```typescript
   * const order = unwrap(Order.create({ ...params, tradeIds: ['trade-1', 'trade-2'] }));
   * console.log(order.hasTrade('trade-1')); // true
   * console.log(order.hasTrade('trade-3')); // false
   * ```
   */
  public hasTrade(tradeId: string): boolean {
    return this.tradeIds.includes(tradeId);
  }

  /**
   * Проверяет, может ли заявка принять данный trade (pre-validation)
   *
   * @param trade - Trade для проверки
   * @returns True если trade может быть применен
   *
   * @remarks
   * Быстрая проверка без создания нового Order объекта.
   * Полезно для фильтрации trades до вызова applyTrade().
   *
   * Проверки (subset от _applyTrade):
   * 1. Статус OPEN или PARTIALLY_FILLED
   * 2. trade.marketId === this.marketId
   * 3. trade.tokenId === this.tokenId
   * 4. trade.side === this.side
   * 5. trade.orderId === this.id (или undefined)
   * 6. trade.size <= remainingSize
   * 7. Нет дубликата trade.id
   *
   * @example
   * ```typescript
   * const order = unwrap(Order.create({ ...params, status: 'OPEN' }));
   * const trade = unwrap(Trade.create({ ...tradeParams, orderId: order.id }));
   *
   * if (order.canAcceptTrade(trade)) {
   *   const result = order.applyTrade(trade);
   *   // result.ok гарантированно true (если не было concurrent changes)
   * }
   * ```
   */
  public canAcceptTrade(trade: Trade): boolean {
    // 1. Статус
    if (this.status !== 'OPEN' && this.status !== 'PARTIALLY_FILLED') {
      return false;
    }

    // 2. marketId
    if (trade.marketId !== this.marketId) {
      return false;
    }

    // 3. tokenId
    if (trade.tokenId !== this.tokenId) {
      return false;
    }

    // 4. side
    if (trade.side !== this.side) {
      return false;
    }

    // 5. orderId (может быть undefined для FIFO)
    if (trade.orderId !== undefined && trade.orderId !== this.id) {
      return false;
    }

    // 6. size <= remainingSize
    const remainingSize = this.getRemainingSize();
    if (trade.size.value > remainingSize.value) {
      return false;
    }

    // 7. Нет дубликата
    if (this.tradeIds.includes(trade.id)) {
      return false;
    }

    return true;
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
      tradeIds: this.tradeIds,
      reason: this.reason,
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
  /**
   * Принять заявку (биржей)
   *
   * @returns Result<Order, OrderValidationError> - Новая заявка со статусом OPEN
   *
   * @remarks
   * Переход: PENDING → OPEN
   *
   * Означает что заявка прошла валидацию биржи и размещена в orderbook.
   * После accept() заявка становится видимой другим участникам и может быть исполнена.
   *
   * Валидация:
   * - Текущий статус должен быть NEW
   *
   * @example
   * ```typescript
   * const newOrder = unwrap(Order.create({ ...params, status: 'PENDING' }));
   * const result = newOrder.accept();
   * if (result.ok) {
   *   console.log(result.value.status); // 'OPEN'
   * }
   * ```
   */
  public accept(): Result<Order, OrderValidationError> {
    const change: OrderChange = { type: 'ACCEPTED' };
    return this._transition(change);
  }

  /**
   * Отклонить заявку (биржей)
   *
   * @param reason - Причина отклонения (обязательна для аудита)
   * @returns Result<Order, OrderValidationError> - Новая заявка со статусом REJECTED
   *
   * @remarks
   * Переход: PENDING → REJECTED
   *
   * Причины отклонения:
   * - Недостаточный баланс
   * - Невалидная цена (вне диапазона)
   * - Рынок закрыт
   * - Нарушение risk limits
   *
   * Валидация:
   * - Текущий статус должен быть NEW
   * - reason не должен быть пустой строкой
   *
   * @example
   * ```typescript
   * const newOrder = unwrap(Order.create({ ...params, status: 'PENDING' }));
   * const result = newOrder.reject('Insufficient balance');
   * if (result.ok) {
   *   console.log(result.value.status); // 'REJECTED'
   *   console.log(result.value.reason); // 'Insufficient balance'
   * }
   * ```
   */
  public reject(reason: string): Result<Order, OrderValidationError> {
    if (!reason || reason.trim().length === 0) {
      return Err(
        new OrderValidationError('Reject reason must be a non-empty string', {
          context: { orderId: this.id, reason }
        })
      );
    }

    const change: OrderChange = { type: 'REJECTED', reason };
    return this._transition(change);
  }

  /**
   * Отменить заявку (пользователем)
   *
   * @param reason - Причина отмены (опционально, по умолчанию "User cancelled")
   * @returns Result<Order, OrderValidationError> - Новая заявка со статусом CANCELED
   *
   * @remarks
   * Переход: OPEN или PARTIALLY_FILLED → CANCELED
   *
   * Пользователь может отменить заявку если она еще не полностью исполнена.
   * Частично исполненная заявка останется с тем же filledSize.
   *
   * Валидация:
   * - Текущий статус должен быть OPEN или PARTIALLY_FILLED
   *
   * @example
   * ```typescript
   * const openOrder = unwrap(Order.create({ ...params, status: 'OPEN' }));
   * const result = openOrder.cancel('Changed strategy');
   * if (result.ok) {
   *   console.log(result.value.status); // 'CANCELED'
   *   console.log(result.value.reason); // 'Changed strategy'
   * }
   * ```
   */
  public cancel(reason?: string): Result<Order, OrderValidationError> {
    const change: OrderChange = {
      type: 'CANCELLED',
      reason: reason || 'User cancelled'
    };
    return this._transition(change);
  }

  /**
   * Истечь заявке по времени
   *
   * @returns Result<Order, OrderValidationError> - Новая заявка со статусом EXPIRED
   *
   * @remarks
   * Переход: OPEN или PARTIALLY_FILLED → EXPIRED
   *
   * Заявка истекает когда:
   * - Время expiresAt достигнуто
   * - Рынок закрывается
   *
   * Валидация:
   * - Текущий статус должен быть OPEN или PARTIALLY_FILLED
   *
   * @example
   * ```typescript
   * const openOrder = unwrap(Order.create({ ...params, status: 'OPEN' }));
   * const result = openOrder.expire();
   * if (result.ok) {
   *   console.log(result.value.status); // 'EXPIRED'
   *   console.log(result.value.reason); // 'Expired'
   * }
   * ```
   */
  public expire(): Result<Order, OrderValidationError> {
    const change: OrderChange = { type: 'EXPIRED' };
    return this._transition(change);
  }

  /**
   * Применить сделку (trade) к заявке
   *
   * @param trade - Trade объект который заполняет эту заявку
   * @returns Result<Order, OrderValidationError> - Новая заявка с обновленным filledSize
   *
   * @remarks
   * Переходы:
   * - OPEN → PARTIALLY_FILLED (если remainingSize > 0)
   * - OPEN или PARTIALLY_FILLED → FILLED (если remainingSize = 0)
   *
   * Это единственный способ fill заявки. Fill всегда происходит из-за trade, а не сам по себе.
   *
   * Валидация в _applyTrade():
   * 1. trade.marketId === this.marketId
   * 2. trade.tokenId === this.tokenId
   * 3. trade.side === this.side
   * 4. trade.orderId === this.id (или undefined для FIFO matching)
   * 5. trade.size <= remainingSize
   * 6. Нет дубликатов trade.id в tradeIds
   *
   * Обновление:
   * - filledSize += trade.size
   * - averageFillPrice = weighted average по всем trades
   * - tradeIds.push(trade.id)
   * - status → PARTIALLY_FILLED или FILLED
   *
   * @example
   * ```typescript
   * const openOrder = unwrap(Order.create({ ...params, status: 'OPEN', size: Quantity(100) }));
   * const trade = unwrap(Trade.create({
   *   ...tradeParams,
   *   orderId: openOrder.id,
   *   size: Quantity(30)
   * }));
   *
   * const result = openOrder.applyTrade(trade);
   * if (result.ok) {
   *   console.log(result.value.status); // 'PARTIALLY_FILLED'
   *   console.log(result.value.filledSize.value); // 30
   *   console.log(result.value.getRemainingSize().value); // 70
   * }
   * ```
   */
  public applyTrade(trade: Trade): Result<Order, OrderValidationError> {
    const change: OrderChange = { type: 'TRADE_APPLIED', trade };
    return this._transition(change);
  }

  /**
   * Приватный метод для применения изменений состояния (FSM transitions)
   *
   * @param change - OrderChange объект описывающий изменение
   * @returns Result<Order, OrderValidationError> - Новая заявка или ошибка
   *
   * @remarks
   * Централизованная логика переходов состояний.
   * Использует discriminated union для type-safe pattern matching.
   *
   * Архитектура:
   * - Все public методы создают OrderChange и вызывают _transition()
   * - _transition() валидирует переход и делегирует обработку специализированным методам
   * - Каждый тип change обрабатывается отдельным методом
   */
  private _transition(change: OrderChange): Result<Order, OrderValidationError> {
    switch (change.type) {
      case 'ACCEPTED':
        return this._handleAccepted();

      case 'REJECTED':
        return this._handleRejected(change.reason);

      case 'CANCELLED':
        return this._handleCancelled(change.reason);

      case 'EXPIRED':
        return this._handleExpired();

      case 'TRADE_APPLIED':
        return this._applyTrade(change.trade);

      default: {
        // TypeScript exhaustiveness check
        const _exhaustive: never = change;
        return _exhaustive;
      }
    }
  }

  /**
   * Обработать принятие заявки
   *
   * @returns Result<Order, OrderValidationError>
   */
  private _handleAccepted(): Result<Order, OrderValidationError> {
    // Валидация: только NEW может быть accepted
    if (this.status !== 'PENDING') {
      return Err(
        new OrderValidationError(
          `Cannot accept order with status ${this.status}. Only PENDING orders can be accepted.`,
          {
            context: { orderId: this.id, currentStatus: this.status }
          }
        )
      );
    }

    // Создать новую заявку со статусом OPEN
    return Order.create({
      ...this,
      status: 'OPEN',
      price: this.price,
      size: this.size,
      filledSize: this.filledSize,
      averageFillPrice: this.averageFillPrice,
      tradeIds: this.tradeIds,
      reason: this.reason,
    });
  }

  /**
   * Обработать отклонение заявки
   *
   * @param reason - Причина отклонения
   * @returns Result<Order, OrderValidationError>
   */
  private _handleRejected(reason: string): Result<Order, OrderValidationError> {
    // Валидация: только NEW может быть rejected
    if (this.status !== 'PENDING') {
      return Err(
        new OrderValidationError(
          `Cannot reject order with status ${this.status}. Only PENDING orders can be rejected.`,
          {
            context: { orderId: this.id, currentStatus: this.status, reason }
          }
        )
      );
    }

    // Создать новую заявку со статусом REJECTED
    return Order.create({
      ...this,
      status: 'REJECTED',
      reason,
      price: this.price,
      size: this.size,
      filledSize: this.filledSize,
      averageFillPrice: this.averageFillPrice,
      tradeIds: this.tradeIds,
    });
  }

  /**
   * Обработать отмену заявки
   *
   * @param reason - Причина отмены
   * @returns Result<Order, OrderValidationError>
   */
  private _handleCancelled(reason?: string): Result<Order, OrderValidationError> {
    // Валидация: только OPEN или PARTIALLY_FILLED может быть cancelled
    if (this.status !== 'OPEN' && this.status !== 'PARTIALLY_FILLED') {
      return Err(
        new OrderValidationError(
          `Cannot cancel order with status ${this.status}. Only OPEN or PARTIALLY_FILLED orders can be cancelled.`,
          {
            context: { orderId: this.id, currentStatus: this.status, reason }
          }
        )
      );
    }

    // Создать новую заявку со статусом CANCELED
    return Order.create({
      ...this,
      status: 'CANCELED',
      reason,
      price: this.price,
      size: this.size,
      filledSize: this.filledSize,
      averageFillPrice: this.averageFillPrice,
      tradeIds: this.tradeIds,
    });
  }

  /**
   * Обработать истечение заявки
   *
   * @returns Result<Order, OrderValidationError>
   */
  private _handleExpired(): Result<Order, OrderValidationError> {
    // Валидация: только OPEN или PARTIALLY_FILLED может быть expired
    if (this.status !== 'OPEN' && this.status !== 'PARTIALLY_FILLED') {
      return Err(
        new OrderValidationError(
          `Cannot expire order with status ${this.status}. Only OPEN or PARTIALLY_FILLED orders can expire.`,
          {
            context: { orderId: this.id, currentStatus: this.status }
          }
        )
      );
    }

    // Создать новую заявку со статусом EXPIRED
    return Order.create({
      ...this,
      status: 'EXPIRED',
      reason: 'Expired',
      price: this.price,
      size: this.size,
      filledSize: this.filledSize,
      averageFillPrice: this.averageFillPrice,
      tradeIds: this.tradeIds,
    });
  }

  /**
   * Применить trade к заявке
   *
   * @param trade - Trade объект
   * @returns Result<Order, OrderValidationError>
   *
   * @remarks
   * Выполняет 6 проверок валидации:
   * 1. Статус должен быть OPEN или PARTIALLY_FILLED
   * 2. trade.marketId === this.marketId
   * 3. trade.tokenId === this.tokenId
   * 4. trade.side === this.side
   * 5. trade.orderId === this.id (или undefined для FIFO)
   * 6. trade.size <= remainingSize
   * 7. Нет дубликатов trade.id в tradeIds
   *
   * Вычисляет:
   * - Новый filledSize = current filledSize + trade.size
   * - Новый averageFillPrice = weighted average по всем trades
   * - Новый status = PARTIALLY_FILLED (если остаток > 0) или FILLED (если остаток = 0)
   */
  private _applyTrade(trade: Trade): Result<Order, OrderValidationError> {
    // Валидация 1: Статус должен быть OPEN или PARTIALLY_FILLED
    if (this.status !== 'OPEN' && this.status !== 'PARTIALLY_FILLED') {
      return Err(
        new OrderValidationError(
          `Cannot apply trade to order with status ${this.status}. Only OPEN or PARTIALLY_FILLED orders can accept trades.`,
          {
            context: {
              orderId: this.id,
              currentStatus: this.status,
              tradeId: trade.id
            }
          }
        )
      );
    }

    // Валидация 2: marketId должен совпадать
    if (trade.marketId !== this.marketId) {
      return Err(
        new OrderValidationError(
          `Trade marketId (${trade.marketId}) does not match order marketId (${this.marketId})`,
          {
            context: {
              orderId: this.id,
              orderMarketId: this.marketId,
              tradeMarketId: trade.marketId,
              tradeId: trade.id
            }
          }
        )
      );
    }

    // Валидация 3: tokenId должен совпадать
    if (trade.tokenId !== this.tokenId) {
      return Err(
        new OrderValidationError(
          `Trade tokenId (${trade.tokenId}) does not match order tokenId (${this.tokenId})`,
          {
            context: {
              orderId: this.id,
              orderTokenId: this.tokenId,
              tradeTokenId: trade.tokenId,
              tradeId: trade.id
            }
          }
        )
      );
    }

    // Валидация 4: side должна совпадать
    if (trade.side !== this.side) {
      return Err(
        new OrderValidationError(
          `Trade side (${trade.side}) does not match order side (${this.side})`,
          {
            context: {
              orderId: this.id,
              orderSide: this.side,
              tradeSide: trade.side,
              tradeId: trade.id
            }
          }
        )
      );
    }

    // Валидация 5: orderId должен совпадать (или быть undefined для FIFO)
    if (trade.orderId !== undefined && trade.orderId !== this.id) {
      return Err(
        new OrderValidationError(
          `Trade orderId (${trade.orderId}) does not match this order id (${this.id})`,
          {
            context: {
              orderId: this.id,
              tradeOrderId: trade.orderId,
              tradeId: trade.id
            }
          }
        )
      );
    }

    // Валидация 6: trade.size не должен превышать remainingSize
    const remainingSize = this.getRemainingSize();
    if (trade.size.value > remainingSize.value) {
      return Err(
        new OrderValidationError(
          `Trade size (${trade.size.value}) exceeds remaining order size (${remainingSize.value})`,
          {
            context: {
              orderId: this.id,
              remainingSize: remainingSize.value,
              tradeSize: trade.size.value,
              tradeId: trade.id
            }
          }
        )
      );
    }

    // Валидация 7: Проверка на дубликаты tradeId
    if (this.tradeIds.includes(trade.id)) {
      return Err(
        new OrderValidationError(
          `Trade ${trade.id} has already been applied to this order`,
          {
            context: {
              orderId: this.id,
              tradeId: trade.id,
              existingTradeIds: this.tradeIds
            }
          }
        )
      );
    }

    // Вычисление нового filledSize
    const currentFilledSize = this.filledSize ?? Quantity.zero();
    const newFilledSizeResult = Quantity.fromValue(
      new Decimal(currentFilledSize.value)
        .plus(trade.size.value)
        .toNumber()
    );

    if (!newFilledSizeResult.ok) {
      return Err(
        new OrderValidationError(
          `Failed to calculate new filled size: ${newFilledSizeResult.error.message}`,
          {
            context: {
              orderId: this.id,
              currentFilledSize: currentFilledSize.value,
              tradeSize: trade.size.value,
              tradeId: trade.id
            }
          }
        )
      );
    }

    const newFilledSize = newFilledSizeResult.value;

    // Вычисление нового averageFillPrice (weighted average)
    const newAverageFillPrice = this._calculateWeightedAveragePrice(
      this.filledSize,
      this.averageFillPrice,
      trade.size,
      trade.price
    );

    // Определение нового статуса
    const newRemainingSize = new Decimal(this.size.value)
      .minus(newFilledSize.value)
      .toNumber();

    const newStatus: OrderStatus = newRemainingSize === 0 ? 'FILLED' : 'PARTIALLY_FILLED';

    // Обновление tradeIds
    const newTradeIds = [...this.tradeIds, trade.id];

    // Создать новую заявку с обновленными данными
    return Order.create({
      ...this,
      status: newStatus,
      filledSize: newFilledSize,
      averageFillPrice: newAverageFillPrice,
      tradeIds: newTradeIds,
      price: this.price,
      size: this.size,
      reason: this.reason,
    });
  }

  /**
   * Вычисляет weighted average price для multiple fills
   *
   * @param currentFilledSize - Текущий filledSize (или undefined если нет fills)
   * @param currentAvgPrice - Текущий average price (или undefined)
   * @param newTradeSize - Размер нового trade
   * @param newTradePrice - Цена нового trade
   * @returns Price - Новый weighted average price
   *
   * @remarks
   * Формула: newAvg = (currentFilledSize * currentAvg + newTradeSize * newTradePrice) / (currentFilledSize + newTradeSize)
   *
   * Использует Decimal.js для точных вычислений.
   */
  private _calculateWeightedAveragePrice(
    currentFilledSize: Quantity | undefined,
    currentAvgPrice: Price | undefined,
    newTradeSize: Quantity,
    newTradePrice: Price
  ): Price {
    // Если это первый fill
    if (!currentFilledSize || !currentAvgPrice) {
      return newTradePrice;
    }

    // Weighted average: (size1 * price1 + size2 * price2) / (size1 + size2)
    const currentNotional = new Decimal(currentFilledSize.value).times(currentAvgPrice.value);
    const newNotional = new Decimal(newTradeSize.value).times(newTradePrice.value);
    const totalNotional = currentNotional.plus(newNotional);

    const totalSize = new Decimal(currentFilledSize.value).plus(newTradeSize.value);

    const avgPrice = totalNotional.dividedBy(totalSize).toNumber();

    // Используем приватный конструктор Price напрямую (гарантированно валидно)
    // так как weighted average двух валидных цен всегда валиден
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new (Price as any)(avgPrice);
  }

  public toString(): string {
    return `Order[${this.id}]: ${this.side} ${this.size.value} @ ${this.price.toString()} (${this.status})`;
  }
}
