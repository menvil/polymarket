/**
 * PositionLot entity
 *
 * @remarks
 * Represents a single lot for FIFO (First In, First Out) accounting.
 * Each lot tracks a specific purchase at a specific price and time.
 * Used for accurate P&L calculation and tax reporting.
 *
 * Algorithm:
 * - Each trade creates a new lot with entry price and quantity
 * - When closing position, oldest lots are used first (FIFO)
 * - Unrealized P&L = (current price - entry price) * quantity
 * - Lots can be partially closed
 * - Lots are immutable - closing creates new instance
 *
 * Design Patterns:
 * - Result pattern для всех fallible операций (create, close)
 * - Private constructor + static factory method
 * - Immutability: timestamp хранится как number (Unix ms) для защиты от мутации
 *
 * @example
 * ```typescript
 * // Создание лота через factory
 * const result = PositionLot.create(
 *   'lot-1',
 *   'token-123',
 *   'YES',
 *   Quantity.fromValue(10).value,
 *   Price.fromValue(0.65).value,
 *   Date.now()
 * );
 *
 * if (!result.ok) {
 *   console.error('Failed to create lot:', result.error.message);
 *   return;
 * }
 *
 * const lot = result.value;
 *
 * // Calculate cost
 * const cost = lot.calculateCost();
 * console.log(cost.amount); // 6.50
 *
 * // Calculate unrealized P&L
 * const pnl = lot.calculateUnrealizedPnL(Price.fromValue(0.70).value);
 * console.log(pnl.amount); // 0.50 (profit)
 *
 * // Close partial quantity (возвращает Result)
 * const closeResult = lot.close(Quantity.fromValue(5).value);
 * if (closeResult.ok) {
 *   console.log(closeResult.value.quantity.value); // 5
 *   console.log(closeResult.value.isClosed()); // false
 * }
 * ```
 */
import { Price } from '@polymarket/value-objects';
import { Quantity } from '@polymarket/value-objects';
import { Money } from '@polymarket/value-objects';
import { TradingError, PositionValidationError } from '@polymarket/errors';
import { Result, Ok, Err } from '@polymarket/result';

/**
 * Side of the position
 */
export type Side = 'YES' | 'NO';

/**
 * Insufficient quantity error
 *
 * @remarks
 * Thrown when trying to close more quantity than available in lot.
 */
export class InsufficientLotQuantityError extends TradingError {
  public readonly severity = 'low' as const;

  constructor(
    public readonly requested: number,
    public readonly available: number
  ) {
    super(
      `Insufficient lot quantity: requested ${requested}, available ${available}`,
      { code: 'INSUFFICIENT_LOT_QUANTITY', context: { requested, available } }
    );
  }
}

/**
 * PositionLot entity
 *
 * @remarks
 * Immutable entity representing a single lot in FIFO accounting.
 */
export class PositionLot {
  /**
   * Private constructor - используйте PositionLot.create()
   *
   * @param lotId - Unique identifier for this lot
   * @param tokenId - ID of the token/market
   * @param side - YES or NO side
   * @param quantity - Amount of shares in this lot
   * @param entryPrice - Price at which this lot was purchased
   * @param timestampMs - Unix timestamp в миллисекундах (immutable number)
   */
  private constructor(
    public readonly lotId: string,
    public readonly tokenId: string,
    public readonly side: Side,
    public readonly quantity: Quantity,
    public readonly entryPrice: Price,
    public readonly timestampMs: number
  ) {}

  /**
   * Создаёт новый PositionLot
   *
   * @param lotId - Уникальный идентификатор лота
   * @param tokenId - ID токена/рынка
   * @param side - Сторона (YES/NO)
   * @param quantity - Количество
   * @param entryPrice - Цена входа
   * @param timestamp - Время создания (Date или Unix ms)
   * @returns Result с PositionLot или ошибкой
   *
   * @remarks
   * Валидирует все параметры перед созданием:
   * - lotId должен быть непустой строкой
   * - tokenId должен быть непустой строкой
   * - quantity должен быть положительным
   * - timestamp конвертируется в number для immutability
   *
   * @example
   * ```typescript
   * const result = PositionLot.create(
   *   'lot-1',
   *   'token-123',
   *   'YES',
   *   Quantity.fromValue(10).value,
   *   Price.fromValue(0.65).value,
   *   Date.now()
   * );
   * if (result.ok) {
   *   console.log(result.value.lotId);
   * }
   * ```
   */
  public static create(
    lotId: string,
    tokenId: string,
    side: Side,
    quantity: Quantity,
    entryPrice: Price,
    timestamp: Date | number
  ): Result<PositionLot, PositionValidationError> {
    // Валидация lotId
    if (!lotId || typeof lotId !== 'string' || lotId.trim() === '') {
      return Err(
        new PositionValidationError(
          'Lot ID must be a non-empty string',
          { context: { field: 'lotId', value: lotId } }
        )
      );
    }

    // Валидация tokenId
    if (!tokenId || typeof tokenId !== 'string' || tokenId.trim() === '') {
      return Err(
        new PositionValidationError(
          'Token ID must be a non-empty string',
          { context: { field: 'tokenId', lotId, value: tokenId } }
        )
      );
    }

    // Валидация quantity (allow zero for closed lots)
    if (quantity.value < 0) {
      return Err(
        new PositionValidationError(
          'Lot quantity cannot be negative',
          { context: { field: 'quantity', lotId, value: quantity.value } }
        )
      );
    }

    // Конвертируем timestamp в ms
    const timestampMs = timestamp instanceof Date ? timestamp.getTime() : timestamp;

    return Ok(
      new PositionLot(
        lotId,
        tokenId,
        side,
        quantity,
        entryPrice,
        timestampMs
      )
    );
  }

  /**
   * Получает timestamp как Date объект
   *
   * @returns Date объект (копия для immutability)
   *
   * @remarks
   * Возвращает новую копию Date каждый раз для защиты от мутации.
   * Внутренне timestamp хранится как number (Unix ms).
   *
   * @example
   * ```typescript
   * const lot = PositionLot.create(...).value;
   * const date = lot.getTimestamp();
   * console.log(date.toISOString());
   * ```
   */
  public getTimestamp(): Date {
    return new Date(this.timestampMs);
  }

  /**
   * Calculates the total cost of this lot
   *
   * @returns Money value representing cost (quantity * entry price)
   *
   * @remarks
   * Cost = quantity * entry price
   * This is the amount paid to acquire this lot.
   *
   * @example
   * ```typescript
   * const lot = new PositionLot(
   *   'lot-1',
   *   'token-123',
   *   'YES',
   *   Quantity.fromNumber(10),
   *   Price.fromNumber(0.65),
   *   new Date()
   * );
   * const cost = lot.calculateCost();
   * console.log(cost.amount); // 6.50
   * ```
   */
  public calculateCost(): Money {
    const costValue = this.quantity.value * this.entryPrice.value;
    const result = Money.fromValue(costValue);
    if (!result.ok) {
      // Это не должно случиться - математически гарантировано валидно
      throw new Error(`Failed to create Money for cost: ${result.error.message}`);
    }
    return result.value;
  }

  /**
   * Calculates unrealized profit/loss at current price
   *
   * @param currentPrice - Current market price
   * @returns Money value representing unrealized P&L
   *
   * @remarks
   * Unrealized P&L = (current price - entry price) * quantity
   * - Positive value = profit
   * - Negative value = loss
   *
   * For NO positions, P&L is inverted:
   * - Entry cost = quantity * (1 - entry price)
   * - Current value = quantity * (1 - current price)
   * - P&L = current value - entry cost
   *
   * @example
   * ```typescript
   * const lot = new PositionLot(
   *   'lot-1',
   *   'token-123',
   *   'YES',
   *   Quantity.fromNumber(10),
   *   Price.fromNumber(0.65),
   *   new Date()
   * );
   *
   * // Price went up - profit
   * const pnl1 = lot.calculateUnrealizedPnL(Price.fromNumber(0.70));
   * console.log(pnl1.amount); // 0.50
   *
   * // Price went down - loss
   * const pnl2 = lot.calculateUnrealizedPnL(Price.fromNumber(0.60));
   * console.log(pnl2.amount); // -0.50
   * ```
   */
  public calculateUnrealizedPnL(currentPrice: Price): Money {
    let pnl: number;

    if (this.side === 'YES') {
      // For YES: P&L = (current - entry) * quantity
      pnl = (currentPrice.value - this.entryPrice.value) * this.quantity.value;
    } else {
      // For NO: P&L = (entry - current) * quantity
      // Because NO token value moves inversely to price
      pnl = (this.entryPrice.value - currentPrice.value) * this.quantity.value;
    }

    // Округляем очень маленькие значения до нуля
    const pnlValue = Math.abs(pnl) < 0.000001 ? 0 : pnl;
    const result = Money.fromValue(pnlValue);

    if (!result.ok) {
      // Это не должно случиться - математически гарантировано валидно
      throw new Error(`Failed to create Money for P&L: ${result.error.message}`);
    }

    return result.value;
  }

  /**
   * Закрывает часть или весь лот
   *
   * @param closeQuantity - Количество для закрытия
   * @returns Result с новым PositionLot или ошибкой
   *
   * @remarks
   * Создаёт новый лот с уменьшенным количеством.
   * Если закрываем всё - возвращает лот с нулевым количеством.
   * Оригинальный лот остаётся неизменным (immutable).
   *
   * Шаги:
   * 1. Проверяем что closeQuantity не превышает доступное количество
   * 2. Вычисляем remainingQuantity = quantity - closeQuantity
   * 3. Создаём новый лот через create() factory
   *
   * @example
   * ```typescript
   * const lot = PositionLot.create(...).value;
   *
   * // Закрываем частично
   * const result = lot.close(Quantity.fromValue(6).value);
   * if (result.ok) {
   *   console.log(result.value.quantity.value); // 4
   *   console.log(result.value.isClosed()); // false
   * }
   *
   * // Закрываем полностью
   * const closeResult = result.value.close(Quantity.fromValue(4).value);
   * if (closeResult.ok) {
   *   console.log(closeResult.value.quantity.value); // 0
   *   console.log(closeResult.value.isClosed()); // true
   * }
   * ```
   */
  public close(closeQuantity: Quantity): Result<PositionLot, InsufficientLotQuantityError | PositionValidationError> {
    if (closeQuantity.isGreaterThan(this.quantity)) {
      return Err(
        new InsufficientLotQuantityError(
          closeQuantity.value,
          this.quantity.value
        )
      );
    }

    const subtractResult = this.quantity.subtract(closeQuantity);
    if (!subtractResult.ok) {
      // Конвертируем в PositionValidationError
      return Err(
        new PositionValidationError(
          `Failed to subtract quantities: ${subtractResult.error.message}`,
          { context: { lotId: this.lotId, closeQuantity: closeQuantity.value, available: this.quantity.value } }
        )
      );
    }

    const remainingQuantity = subtractResult.value;

    const result = PositionLot.create(
      this.lotId,
      this.tokenId,
      this.side,
      remainingQuantity,
      this.entryPrice,
      this.timestampMs
    );

    return result;
  }

  /**
   * Checks if lot is fully closed
   *
   * @returns True if quantity is zero
   *
   * @remarks
   * A closed lot has zero quantity and should be removed from inventory.
   *
   * @example
   * ```typescript
   * const lot = new PositionLot(
   *   'lot-1',
   *   'token-123',
   *   'YES',
   *   Quantity.fromNumber(10),
   *   Price.fromNumber(0.65),
   *   new Date()
   * );
   * console.log(lot.isClosed()); // false
   *
   * const closed = lot.close(Quantity.fromNumber(10));
   * console.log(closed.isClosed()); // true
   * ```
   */
  public isClosed(): boolean {
    return this.quantity.isZero();
  }

  /**
   * Creates a string representation of this lot
   *
   * @returns Formatted string with lot details
   *
   * @example
   * ```typescript
   * const lot = PositionLot.create(
   *   'lot-1',
   *   'token-123',
   *   'YES',
   *   Quantity.fromValue(10).value,
   *   Price.fromValue(0.65).value,
   *   new Date('2024-01-01')
   * ).value;
   * console.log(lot.toString());
   * // "Lot[lot-1]: 10.00 YES @ $0.6500 (2024-01-01)"
   * ```
   */
  public toString(): string {
    const date = new Date(this.timestampMs).toISOString().split('T')[0];
    return `Lot[${this.lotId}]: ${this.quantity.toString()} ${this.side} @ $${this.entryPrice.toString()} (${date})`;
  }
}
