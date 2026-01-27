/**
 * Сущность PositionLot (Лот позиции)
 *
 * @remarks
 * Представляет единичный лот для FIFO (First In, First Out) учета.
 * Каждый лот отслеживает конкретную покупку по конкретной цене и времени.
 * Используется для точного расчета P&L и налоговой отчетности.
 *
 * Алгоритм:
 * - Каждая сделка создает новый лот с ценой входа и количеством
 * - При закрытии позиции используются самые старые лоты первыми (FIFO)
 * - Нереализованный P&L = (текущая цена - цена входа) * количество
 * - Лоты могут быть частично закрыты
 * - Лоты неизменяемы - закрытие создает новый экземпляр
 *
 * Паттерны проектирования:
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
 *   console.error('Не удалось создать лот:', result.error.message);
 *   return;
 * }
 *
 * const lot = result.value;
 *
 * // Вычисляем стоимость
 * const cost = lot.calculateCost();
 * console.log(cost.amount); // 6.50
 *
 * // Вычисляем нереализованный P&L
 * const pnl = lot.calculateUnrealizedPnL(Price.fromValue(0.70).value);
 * console.log(pnl.amount); // 0.50 (прибыль)
 *
 * // Закрываем частичное количество (возвращает Result)
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
 * Сторона позиции
 */
export type Side = 'YES' | 'NO';

/**
 * Ошибка недостаточного количества
 *
 * @remarks
 * Выбрасывается при попытке закрыть больше количества, чем доступно в лоте.
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
 * Сущность PositionLot (Лот позиции)
 *
 * @remarks
 * Неизменяемая сущность, представляющая единичный лот в FIFO учете.
 */
export class PositionLot {
  /**
   * Private constructor - используйте PositionLot.create()
   *
   * @param lotId - Уникальный идентификатор этого лота
   * @param tokenId - ID токена/рынка
   * @param side - Сторона YES или NO
   * @param quantity - Количество акций в этом лоте
   * @param entryPrice - Цена, по которой был куплен этот лот
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
   * Вычисляет общую стоимость этого лота
   *
   * @returns Значение Money, представляющее стоимость (количество * цена входа)
   *
   * @remarks
   * Стоимость = количество * цена входа
   * Это сумма, уплаченная за приобретение этого лота.
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
   * Вычисляет нереализованную прибыль/убыток по текущей цене
   *
   * @param currentPrice - Текущая рыночная цена
   * @returns Значение Money, представляющее нереализованный P&L
   *
   * @remarks
   * Нереализованный P&L = (текущая цена - цена входа) * количество
   * - Положительное значение = прибыль
   * - Отрицательное значение = убыток
   *
   * Для позиций NO, P&L инвертирован:
   * - Стоимость входа = количество * (1 - цена входа)
   * - Текущая стоимость = количество * (1 - текущая цена)
   * - P&L = текущая стоимость - стоимость входа
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
   * // Цена выросла - прибыль
   * const pnl1 = lot.calculateUnrealizedPnL(Price.fromNumber(0.70));
   * console.log(pnl1.amount); // 0.50
   *
   * // Цена упала - убыток
   * const pnl2 = lot.calculateUnrealizedPnL(Price.fromNumber(0.60));
   * console.log(pnl2.amount); // -0.50
   * ```
   */
  public calculateUnrealizedPnL(currentPrice: Price): Money {
    let pnl: number;

    if (this.side === 'YES') {
      // Для YES: P&L = (текущая - входная) * количество
      pnl = (currentPrice.value - this.entryPrice.value) * this.quantity.value;
    } else {
      // Для NO: P&L = (входная - текущая) * количество
      // Потому что стоимость NO токена двигается обратно пропорционально цене
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
   * Проверяет, полностью ли закрыт лот
   *
   * @returns True если количество равно нулю
   *
   * @remarks
   * Закрытый лот имеет нулевое количество и должен быть удален из инвентаря.
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
   * Создает строковое представление этого лота
   *
   * @returns Отформатированная строка с деталями лота
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
