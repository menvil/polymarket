/**
 * Value Object для информации о заполнении заявки
 *
 * @remarks
 * Инкапсулирует состояние исполнения заявки:
 * - filledSize: Сколько исполнено
 * - averageFillPrice: По какой средней цене
 * - tradeIds: Какие trades заполнили заявку
 *
 * ### Инварианты:
 * 1. filledSize должен быть >= 0
 * 2. filledSize должен быть <= orderSize
 * 3. averageFillPrice требуется если filledSize > 0
 * 4. tradeIds не должен содержать дубликатов
 *
 * ### Immutability:
 * OrderFill неизменяемый. Методы addTrade() возвращают НОВЫЙ экземпляр.
 *
 * @example
 * ```typescript
 * import { OrderFill } from './OrderFill';
 * import { Quantity, Price } from '@polymarket/value-objects';
 *
 * // Пустое fill (новая заявка)
 * const empty = OrderFill.empty();
 * console.log(empty.isEmpty());  // true
 *
 * // Добавить trade
 * const result = empty.addTrade(
 *   Quantity.fromValue(30).value!,
 *   Price.fromValue(0.65).value!,
 *   'trade-1',
 *   Quantity.fromValue(100).value! // orderSize
 * );
 * if (result.ok) {
 *   const filled = result.value;
 *   console.log(filled.getFilledSize().value);       // 30
 *   console.log(filled.getAverageFillPrice()?.value); // 0.65
 *   console.log(filled.getFillPercentage(Quantity(100))); // 30%
 * }
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import { Quantity, Price } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

/**
 * Класс OrderFill - информация о заполнении заявки
 *
 * @remarks
 * Value Object со следующими гарантиями:
 * - Неизменяемость (immutable)
 * - Валидность инвариантов
 * - Type-safe операции
 */
export class OrderFill {
  private readonly _filledSize: Quantity;
  private readonly _averageFillPrice: Price | undefined;
  private readonly _tradeIds: readonly string[];

  /**
   * Приватный конструктор (используйте OrderFill.empty() или OrderFill.create())
   */
  private constructor(
    filledSize: Quantity,
    averageFillPrice: Price | undefined,
    tradeIds: readonly string[]
  ) {
    this._filledSize = filledSize;
    this._averageFillPrice = averageFillPrice;
    this._tradeIds = tradeIds;
  }

  /**
   * Создает пустое fill (новая заявка без исполнения)
   *
   * @returns OrderFill с нулевым заполнением
   *
   * @example
   * ```typescript
   * const fill = OrderFill.empty();
   * console.log(fill.isEmpty());  // true
   * ```
   */
  public static empty(): OrderFill {
    return new OrderFill(Quantity.ZERO, undefined, []);
  }

  /**
   * Создает OrderFill из существующих данных
   *
   * @param filledSize - Заполненное количество
   * @param averageFillPrice - Средняя цена исполнения
   * @param tradeIds - IDs trades (опционально)
   * @param orderSize - Размер заявки (для валидации)
   * @returns Result<OrderFill, Error>
   *
   * @remarks
   * Валидация:
   * - filledSize должен быть >= 0
   * - filledSize должен быть <= orderSize
   * - averageFillPrice требуется если filledSize > 0
   * - tradeIds не должен содержать дубликатов
   *
   * @example
   * ```typescript
   * const result = OrderFill.create(
   *   Quantity.fromValue(50).value!,
   *   Price.fromValue(0.65).value!,
   *   ['trade-1', 'trade-2'],
   *   Quantity.fromValue(100).value!
   * );
   * if (result.ok) {
   *   const fill = result.value;
   *   console.log(fill.getFilledSize().value); // 50
   * }
   * ```
   */
  public static create(
    filledSize: Quantity,
    averageFillPrice: Price | undefined,
    tradeIds: string[],
    orderSize: Quantity
  ): Result<OrderFill, Error> {
    // Валидация 1: filledSize должен быть >= 0 (гарантируется инвариантом Quantity)

    // Валидация 2: filledSize должен быть <= orderSize
    if (filledSize.isGreaterThan(orderSize)) {
      return Err(
        new Error(
          `Filled size (${filledSize.value()}) cannot exceed order size (${orderSize.value()})`
        )
      );
    }

    // Валидация 3: averageFillPrice требуется если filledSize > 0
    if (filledSize.isPositive() && !averageFillPrice) {
      return Err(new Error('Average fill price is required when filled size > 0'));
    }

    // Валидация 4: tradeIds не должен содержать дубликатов
    const uniqueTradeIds = new Set(tradeIds);
    if (uniqueTradeIds.size !== tradeIds.length) {
      return Err(new Error('Trade IDs must be unique'));
    }

    return Ok(new OrderFill(filledSize, averageFillPrice, tradeIds));
  }

  /**
   * Проверяет, пустое ли fill (нет исполнения)
   *
   * @returns True если заявка не исполнена
   *
   * @example
   * ```typescript
   * const fill = OrderFill.empty();
   * console.log(fill.isEmpty());  // true
   * ```
   */
  public isEmpty(): boolean {
    return this._filledSize.isZero();
  }

  /**
   * Проверяет, полностью ли заполнена заявка
   *
   * @param orderSize - Размер заявки
   * @returns True если filledSize === orderSize
   *
   * @example
   * ```typescript
   * const fill = OrderFill.create(
   *   Quantity(100), Price(0.65), ['t1'], Quantity(100)
   * ).value!;
   * console.log(fill.isFull(Quantity(100)));  // true
   * ```
   */
  public isFull(orderSize: Quantity): boolean {
    return this._filledSize.equals(orderSize);
  }

  /**
   * Проверяет, частично ли заполнена заявка
   *
   * @param orderSize - Размер заявки
   * @returns True если 0 < filledSize < orderSize
   *
   * @example
   * ```typescript
   * const fill = OrderFill.create(
   *   Quantity(50), Price(0.65), ['t1'], Quantity(100)
   * ).value!;
   * console.log(fill.isPartial(Quantity(100)));  // true
   * ```
   */
  public isPartial(orderSize: Quantity): boolean {
    return this._filledSize.isPositive() && this._filledSize.isLessThan(orderSize);
  }

  /**
   * Возвращает заполненное количество
   *
   * @returns Filled size
   */
  public getFilledSize(): Quantity {
    return this._filledSize;
  }

  /**
   * Возвращает среднюю цену исполнения
   *
   * @returns Average fill price или undefined если не исполнено
   */
  public getAverageFillPrice(): Price | undefined {
    return this._averageFillPrice;
  }

  /**
   * Возвращает IDs trades
   *
   * @returns Массив trade IDs (readonly)
   */
  public getTradeIds(): readonly string[] {
    return this._tradeIds;
  }

  /**
   * Возвращает количество trades
   *
   * @returns Число trades заполнивших заявку
   *
   * @example
   * ```typescript
   * console.log(fill.getTradeCount()); // 3
   * ```
   */
  public getTradeCount(): number {
    return this._tradeIds.length;
  }

  /**
   * Проверяет, был ли применен конкретный trade
   *
   * @param tradeId - ID trade для проверки
   * @returns True если trade был применен
   *
   * @example
   * ```typescript
   * console.log(fill.hasTrade('trade-1')); // true
   * console.log(fill.hasTrade('trade-99')); // false
   * ```
   */
  public hasTrade(tradeId: string): boolean {
    return this._tradeIds.includes(tradeId);
  }

  /**
   * Вычисляет оставшийся размер для заполнения
   *
   * @param orderSize - Размер заявки
   * @returns Оставшееся количество
   *
   * @remarks
   * remaining = orderSize - filledSize
   *
   * @example
   * ```typescript
   * const remaining = fill.getRemainingSize(Quantity(100));
   * console.log(remaining.value); // 50
   * ```
   */
  public getRemainingSize(orderSize: Quantity): Quantity {
    // Вычисляем через Decimal arithmetic
    const remaining = orderSize.value().minus(this._filledSize.value());
    return Quantity.of(remaining);
  }

  /**
   * Вычисляет процент заполнения
   *
   * @param orderSize - Размер заявки
   * @returns Процент заполнения (0-100) как Decimal
   *
   * @remarks
   * Формула: (filledSize / orderSize) × 100
   *
   * @example
   * ```typescript
   * const percentage = fill.getFillPercentage(Quantity(100));
   * console.log(percentage.toFixed(1)); // '50.0'
   * ```
   */
  public getFillPercentage(orderSize: Quantity): Decimal {
    if (this._filledSize.isZero()) {
      return new Decimal(0);
    }
    return this._filledSize.value()
      .dividedBy(orderSize.value())
      .times(100);
  }

  /**
   * Добавляет trade к fill (возвращает НОВЫЙ экземпляр)
   *
   * @param tradeSize - Размер trade
   * @param tradePrice - Цена trade
   * @param tradeId - ID trade
   * @param orderSize - Размер заявки (для валидации)
   * @returns Result<OrderFill, Error> - Новый экземпляр или ошибка
   *
   * @remarks
   * Валидация:
   * - tradeSize должен быть > 0
   * - tradeSize должен быть <= remainingSize
   * - tradeId не должен быть дубликатом
   *
   * Обновление:
   * - newFilledSize = currentFilledSize + tradeSize
   * - newAverageFillPrice = weighted average
   * - newTradeIds = [...currentTradeIds, tradeId]
   *
   * @example
   * ```typescript
   * const fill1 = OrderFill.empty();
   * const result = fill1.addTrade(
   *   Quantity(30), Price(0.65), 'trade-1', Quantity(100)
   * );
   * if (result.ok) {
   *   const fill2 = result.value;
   *   console.log(fill2.getFilledSize().value); // 30
   *   // fill1 остался пустым (immutability)
   *   console.log(fill1.isEmpty()); // true
   * }
   * ```
   */
  public addTrade(
    tradeSize: Quantity,
    tradePrice: Price,
    tradeId: string,
    orderSize: Quantity
  ): Result<OrderFill, Error> {
    // Валидация 1: tradeSize должен быть > 0
    if (tradeSize.isZero()) {
      return Err(new Error('Trade size must be positive'));
    }

    // Валидация 2: tradeId не должен быть дубликатом
    if (this.hasTrade(tradeId)) {
      return Err(new Error(`Trade ${tradeId} has already been applied`));
    }

    // Валидация 3: tradeSize не должен превышать remainingSize
    const remainingSize = this.getRemainingSize(orderSize);
    if (tradeSize.isGreaterThan(remainingSize)) {
      return Err(
        new Error(
          `Trade size (${tradeSize.value()}) exceeds remaining order size (${remainingSize.value()})`
        )
      );
    }

    // Вычисление нового filledSize через Decimal arithmetic
    const newFilledSizeDecimal = this._filledSize.value().plus(tradeSize.value());
    const newFilledSize = Quantity.of(newFilledSizeDecimal);

    // Вычисление нового averageFillPrice (weighted average)
    const newAverageFillPrice = this._calculateWeightedAveragePrice(
      this._filledSize,
      this._averageFillPrice,
      tradeSize,
      tradePrice
    );

    // Обновление tradeIds
    const newTradeIds = [...this._tradeIds, tradeId];

    // Создать новый OrderFill
    return Ok(new OrderFill(newFilledSize, newAverageFillPrice, newTradeIds));
  }

  /**
   * Вычисляет weighted average price для множественных fills
   *
   * @param currentFilledSize - Текущий filled size
   * @param currentAvgPrice - Текущий average price
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
    currentFilledSize: Quantity,
    currentAvgPrice: Price | undefined,
    newTradeSize: Quantity,
    newTradePrice: Price
  ): Price {
    // Если это первый fill
    if (currentFilledSize.isZero() || !currentAvgPrice) {
      return newTradePrice;
    }

    // Weighted average: (size1 * price1 + size2 * price2) / (size1 + size2)
    const currentNotional = currentFilledSize.value().times(currentAvgPrice.value());
    const newNotional = newTradeSize.value().times(newTradePrice.value());
    const totalNotional = currentNotional.plus(newNotional);

    const totalSize = currentFilledSize.value().plus(newTradeSize.value());

    const avgPriceDecimal = totalNotional.dividedBy(totalSize);

    // Используем Price.of для создания
    return Price.of(avgPriceDecimal);
  }

  /**
   * Сериализация в plain object
   *
   * @returns Plain object для JSON.stringify()
   *
   * @example
   * ```typescript
   * const json = fill.toJSON();
   * console.log(JSON.stringify(json));
   * ```
   */
  public toJSON(): Record<string, unknown> {
    return {
      filledSize: this._filledSize.value().toNumber(),
      averageFillPrice: this._averageFillPrice?.value().toNumber(),
      tradeIds: this._tradeIds,
    };
  }

  /**
   * Строковое представление
   *
   * @returns Строка для отладки
   *
   * @example
   * ```typescript
   * console.log(fill.toString());
   * // "OrderFill[50/100 @ 0.65]"
   * ```
   */
  public toString(): string {
    if (this.isEmpty()) {
      return 'OrderFill[empty]';
    }
    return `OrderFill[${this._filledSize.value().toString()} @ ${this._averageFillPrice?.value().toString() || 'N/A'}]`;
  }
}
