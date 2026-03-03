/**
 * Value Object для информации о заполнении заявки
 *
 * @remarks
 * Инкапсулирует состояние исполнения заявки:
 * - filledSize: Сколько исполнено
 * - averageFillPrice: По какой средней цене
 * - fillIds: Какие fills заполнили заявку
 *
 * ### Инварианты:
 * 1. filledSize должен быть >= 0
 * 2. filledSize должен быть <= orderSize
 * 3. fillIds не должен содержать дубликатов
 *
 * ### Immutability:
 * OrderFill неизменяемый. Методы addFill() возвращают НОВЫЙ экземпляр.
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
 * // Добавить fill
 * const result = empty.addFill(
 *   Quantity.fromValue(30).value!,
 *   Price.fromValue(0.65).value!,
 *   'fill-1',
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
import type { FillId } from '@polymarket/ids';
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
  private readonly _fillIds: readonly FillId[];

  /**
   * Приватный конструктор (используйте OrderFill.empty() или OrderFill.create())
   */
  private constructor(
    filledSize: Quantity,
    averageFillPrice: Price | undefined,
    fillIds: readonly FillId[]
  ) {
    this._filledSize = filledSize;
    this._averageFillPrice = averageFillPrice;
    this._fillIds = fillIds;
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
    return new OrderFill(Quantity.ZERO, undefined, [] as FillId[]);
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
    fillIds: FillId[],
    orderSize: Quantity
  ): Result<OrderFill, Error> {
    // Валидация 1: filledSize должен быть >= 0 (гарантируется инвариантом Quantity)

    // Валидация 2: если filledSize > 0, averageFillPrice обязателен
    if (filledSize.isPositive() && !averageFillPrice) {
      return Err(new Error('Average fill price is required when filledSize > 0'));
    }

    // Валидация 3: filledSize должен быть <= orderSize
    if (filledSize.isGreaterThan(orderSize)) {
      return Err(
        new Error(
          `Filled size (${filledSize.value()}) cannot exceed order size (${orderSize.value()})`
        )
      );
    }

    // Валидация 4: fillIds не должен содержать дубликатов
    const uniqueFillIds = new Set(fillIds);
    if (uniqueFillIds.size !== fillIds.length) {
      return Err(new Error('Fill IDs must be unique'));
    }

    return Ok(new OrderFill(filledSize, averageFillPrice, [...fillIds]));
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
   * Возвращает IDs fills
   *
   * @returns Массив fill IDs (readonly)
   */
  public getFillIds(): readonly FillId[] {
    return [...this._fillIds];
  }

  /**
   * Возвращает количество fills
   *
   * @returns Число fills заполнивших заявку
   *
   * @example
   * ```typescript
   * console.log(fill.getTradeCount()); // 3
   * ```
   */
  public getTradeCount(): number {
    return this._fillIds.length;
  }

  /**
   * Проверяет, был ли применен конкретный fill
   *
   * @param fillId - ID fill для проверки
   * @returns True если fill был применен
   *
   * @example
   * ```typescript
   * console.log(fill.hasFill('fill-1')); // true
   * console.log(fill.hasFill('fill-99')); // false
   * ```
   */
  public hasFill(fillId: FillId): boolean {
    return this._fillIds.includes(fillId);
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
   * Добавляет fill к OrderFill (возвращает НОВЫЙ экземпляр)
   *
   * @param fillSize - Размер fill
   * @param fillPrice - Цена fill
   * @param fillId - ID fill
   * @param orderSize - Размер заявки (для валидации)
   * @returns Result<OrderFill, Error> - Новый экземпляр или ошибка
   *
   * @remarks
   * Валидация:
   * - fillSize должен быть > 0
   * - fillSize должен быть <= remainingSize
   * - fillId не должен быть дубликатом
   *
   * Обновление:
   * - newFilledSize = currentFilledSize + fillSize
   * - newAverageFillPrice = weighted average
   * - newFillIds = [...currentFillIds, fillId]
   *
   * @example
   * ```typescript
   * const orderFill = OrderFill.empty();
   * const result = orderFill.addFill(
   *   Quantity(30), Price(0.65), 'fill-1', Quantity(100)
   * );
   * if (result.ok) {
   *   const updated = result.value;
   *   console.log(updated.getFilledSize().value); // 30
   *   // orderFill остался пустым (immutability)
   *   console.log(orderFill.isEmpty()); // true
   * }
   * ```
   */
  public addFill(
    fillSize: Quantity,
    fillPrice: Price,
    fillId: FillId,
    orderSize: Quantity
  ): Result<OrderFill, Error> {
    // Валидация 1: fillSize должен быть > 0
    if (fillSize.isZero()) {
      return Err(new Error('Fill size must be positive'));
    }

    // Валидация 2: fillId не должен быть дубликатом
    if (this.hasFill(fillId)) {
      return Err(new Error(`Fill ${fillId} has already been applied`));
    }

    // Валидация 3: fillSize не должен превышать remainingSize
    const remainingSize = this.getRemainingSize(orderSize);
    if (fillSize.isGreaterThan(remainingSize)) {
      return Err(
        new Error(
          `Fill size (${fillSize.value()}) exceeds remaining order size (${remainingSize.value()})`
        )
      );
    }

    // Вычисление нового filledSize через Decimal arithmetic
    const newFilledSizeDecimal = this._filledSize.value().plus(fillSize.value());
    const newFilledSize = Quantity.of(newFilledSizeDecimal);

    // Вычисление нового averageFillPrice (weighted average)
    const newAverageFillPrice = this._calculateWeightedAveragePrice(
      this._filledSize,
      this._averageFillPrice,
      fillSize,
      fillPrice
    );

    // Обновление fillIds
    const newFillIds = [...this._fillIds, fillId];

    // Создать новый OrderFill
    return Ok(new OrderFill(newFilledSize, newAverageFillPrice, newFillIds));
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
      fillIds: [...this._fillIds],
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
