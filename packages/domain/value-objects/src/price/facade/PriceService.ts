import { Result, Ok, Err } from '@polymarket/result';
import {
  InvalidPriceError,
  InvalidOperandError,
  InvalidDivisorError,
  DivisionByZeroError,
  InvalidTickSizeError
} from '@polymarket/errors';
import { Price, PriceInvariantViolation } from '../core/Price.js';
import { ValidateTickSize } from '../rules/ValidateTickSize.js';
import { ValidateAligned } from '../rules/ValidateAligned.js';
import {
  addDecimal,
  subtractDecimal,
  multiplyDecimal,
  divideDecimal,
  roundToTick,
  floorToTick,
  ceilToTick
} from '@polymarket/math';
import Decimal from 'decimal.js';

/**
 * Фасад для работы с Price - публичный API
 *
 * @remarks
 * Единая точка входа для всех операций с ценами.
 * Оркестрирует Core + Math + Rules.
 *
 * **Facade Error Contract:**
 * ВСЕ публичные методы возвращают Result<T, E>.
 * Никогда не бросают исключения наружу.
 *
 * @example
 * ```typescript
 * import { PriceService } from '@polymarket/value-objects/price';
 *
 * const result = PriceService.create(0.5);
 * if (result.ok) {
 *   console.log(result.value.toNumber()); // 0.5
 * } else {
 *   console.error(result.error.message);
 * }
 * ```
 */
export class PriceService {
  /**
   * Создаёт Price из значения (безопасно - никогда не бросает)
   *
   * @remarks
   * ПУБЛИЧНЫЙ способ создания Price.
   * Возвращает Result вместо исключений.
   *
   * Инварианты проверяются автоматически через Price.of():
   * - finite (не NaN, не Infinity)
   * - диапазон [0.0001, 0.9999]
   *
   * @param value - Значение цены (number, string, или Decimal)
   * @returns Result<Price, InvalidPriceError>
   *
   * @example
   * ```typescript
   * const result = PriceService.create(0.5);
   * if (!result.ok) {
   *   console.error(result.error.context.value); // '0.5'
   *   return;
   * }
   * const price = result.value;
   * ```
   */
  public static create(
    value: number | string | Decimal
  ): Result<Price, InvalidPriceError> {
    try {
      const price = Price.of(value);
      return Ok(price);
    } catch (error) {
      if (error instanceof PriceInvariantViolation) {
        return Err(
          new InvalidPriceError(error.message, {
            context: {
              op: 'create',
              value: String(value)
            }
          })
        );
      }
      // Любая другая ошибка (парсинг Decimal, etc.)
      if (error instanceof Error) {
        return Err(
          new InvalidPriceError(error.message, {
            context: {
              op: 'create',
              value: String(value)
            }
          })
        );
      }
      // Unknown error (не Error) - оборачиваем в InvalidPriceError
      // Сохраняем Result-only контракт: никогда не бросаем исключения
      return Err(
        new InvalidPriceError(
          `Unexpected non-Error thrown during price creation: ${String(error)}`,
          {
            context: {
              op: 'create',
              value: String(value),
              unexpectedError: String(error)
            }
          }
        )
      );
    }
  }

  /**
   * Вычисляет дополнение цены до 1
   *
   * @remarks
   * complement(0.3) = 0.7
   * Используется для вычисления противоположной стороны бинарного маркета.
   *
   * Может вернуть Err если результат выходит за диапазон [0.0001, 0.9999].
   *
   * @param price - Исходная цена
   * @returns Result с дополнением или InvalidPriceError
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.3));
   * const result = PriceService.complement(price);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.7
   * }
   * ```
   */
  public static complement(price: Price): Result<Price, InvalidPriceError> {
    const one = new Decimal(1);
    const result = subtractDecimal(one, price.value());
    return this.create(result);
  }

  /**
   * Вычисляет среднее двух цен
   *
   * @remarks
   * average(0.2, 0.8) = 0.5
   * Используется для вычисления mid-price.
   *
   * @param price1 - Первая цена
   * @param price2 - Вторая цена
   * @returns Result со средним значением или InvalidPriceError
   *
   * @example
   * ```typescript
   * const p1 = expectOk(PriceService.create(0.2));
   * const p2 = expectOk(PriceService.create(0.8));
   * const result = PriceService.average(p1, p2);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.5
   * }
   * ```
   */
  public static average(
    price1: Price,
    price2: Price
  ): Result<Price, InvalidPriceError> {
    const sum = addDecimal(price1.value(), price2.value());
    const avgValue = divideDecimal(sum, new Decimal(2));
    return this.create(avgValue);
  }

  /**
   * Умножает цену на множитель
   *
   * @remarks
   * multiply(0.5, 2) = 1.0 (выйдет за диапазон → Err)
   * multiply(0.3, 2) = 0.6
   *
   * Парсит factor внутри метода (try/catch).
   * Может вернуть InvalidOperandError при parse errors.
   * Может вернуть InvalidPriceError если результат вне диапазона.
   *
   * @param price - Исходная цена
   * @param factor - Множитель (number, string, или Decimal)
   * @returns Result с результатом или InvalidPriceError | InvalidOperandError
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.3));
   * const result = PriceService.multiply(price, 2);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.6
   * }
   * ```
   */
  public static multiply(
    price: Price,
    factor: number | string | Decimal
  ): Result<Price, InvalidPriceError | InvalidOperandError> {
    // Парсинг factor
    let factorDecimal: Decimal;
    try {
      factorDecimal = factor instanceof Decimal ? factor : new Decimal(factor);
    } catch (error) {
      return Err(
        new InvalidOperandError(
          (ctx) => `Invalid factor: ${ctx.operand}`,
          {
            code: InvalidOperandError.code,
            context: {
              operation: 'multiply',
              operand: 'factor',
              value: String(factor),
              parseError: error instanceof Error ? error.message : 'unknown'
            }
          }
        )
      );
    }

    // Валидация factor после парсинга
    if (factorDecimal.isNaN()) {
      return Err(
        new InvalidOperandError(
          () => `Factor cannot be NaN`,
          {
            code: InvalidOperandError.code,
            context: {
              operation: 'multiply',
              operand: 'factor',
              value: String(factor),
              reason: 'is_nan'
            }
          }
        )
      );
    }

    if (!factorDecimal.isFinite()) {
      return Err(
        new InvalidOperandError(
          () => `Factor must be finite`,
          {
            code: InvalidOperandError.code,
            context: {
              operation: 'multiply',
              operand: 'factor',
              value: String(factor),
              reason: 'not_finite'
            }
          }
        )
      );
    }

    const result = multiplyDecimal(price.value(), factorDecimal);
    return this.create(result);
  }

  /**
   * Делит цену на делитель
   *
   * @remarks
   * divide(0.6, 2) = 0.3
   * divide(0.5, 0) → DivisionByZeroError
   *
   * Парсит divisor внутри метода (try/catch).
   * Проверяет divisor.isZero() явно.
   *
   * @param price - Исходная цена
   * @param divisor - Делитель (number, string, или Decimal)
   * @returns Result с результатом или InvalidPriceError | InvalidDivisorError | DivisionByZeroError
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.6));
   * const result = PriceService.divide(price, 2);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.3
   * }
   * ```
   */
  public static divide(
    price: Price,
    divisor: number | string | Decimal
  ): Result<Price, InvalidPriceError | InvalidDivisorError | DivisionByZeroError> {
    // Парсинг divisor
    let divisorDecimal: Decimal;
    try {
      divisorDecimal = divisor instanceof Decimal ? divisor : new Decimal(divisor);
    } catch (error) {
      return Err(
        new InvalidDivisorError(
          (ctx) => `Invalid divisor: ${ctx.divisor}`,
          {
            code: InvalidDivisorError.code,
            context: {
              divisor: String(divisor),
              dividend: price.value().toString(),
              parseError: error instanceof Error ? error.message : 'unknown'
            }
          }
        )
      );
    }

    // Валидация divisor после парсинга
    if (divisorDecimal.isNaN()) {
      return Err(
        new InvalidDivisorError(
          () => `Divisor cannot be NaN`,
          {
            code: InvalidDivisorError.code,
            context: {
              divisor: String(divisor),
              dividend: price.value().toString(),
              reason: 'is_nan'
            }
          }
        )
      );
    }

    if (!divisorDecimal.isFinite()) {
      return Err(
        new InvalidDivisorError(
          () => `Divisor must be finite`,
          {
            code: InvalidDivisorError.code,
            context: {
              divisor: String(divisor),
              dividend: price.value().toString(),
              reason: 'not_finite'
            }
          }
        )
      );
    }

    // Проверка деления на ноль
    if (divisorDecimal.isZero()) {
      return Err(
        new DivisionByZeroError(
          (ctx) => `Cannot divide ${ctx.dividend} by zero`,
          {
            code: DivisionByZeroError.code,
            context: {
              divisor: divisorDecimal.toString(),
              dividend: price.value().toString()
            }
          }
        )
      );
    }

    const result = divideDecimal(price.value(), divisorDecimal);
    return this.create(result);
  }

  /**
   * Округляет цену до ближайшего тика
   *
   * @remarks
   * НЕ требует что price уже aligned.
   * Это функция округления, а не валидации.
   *
   * Режимы округления:
   * - nearest: к ближайшему тику (по умолчанию)
   * - floor: вниз — используй для bid price
   * - ceil: вверх — используй для ask price
   *
   * КОНТРАКТ: результат ДОЛЖЕН проходить ValidateAligned.check()
   *
   * @param price - Исходная цена
   * @param tickSize - Размер тика (number, string, или Decimal)
   * @param mode - Режим округления ('nearest' | 'floor' | 'ceil')
   * @returns Result с округлённой ценой или InvalidPriceError | InvalidTickSizeError
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.12345));
   * const result = PriceService.roundToMarketTick(price, 0.001);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.123
   * }
   * ```
   */
  public static roundToMarketTick(
    price: Price,
    tickSize: number | string | Decimal,
    mode: 'nearest' | 'floor' | 'ceil' = 'nearest'
  ): Result<Price, InvalidPriceError | InvalidTickSizeError> {
    // Валидация tickSize через ValidateTickSize (получаем Decimal)
    const tickResult = ValidateTickSize.check(tickSize);
    if (!tickResult.ok) {
      return tickResult as Result<never, InvalidTickSizeError>;
    }
    const tickDecimal = tickResult.value;

    // Выбор направления округления
    let rounded: Decimal;
    switch (mode) {
      case 'floor':
        rounded = floorToTick(price.value(), tickDecimal);
        break;
      case 'ceil':
        rounded = ceilToTick(price.value(), tickDecimal);
        break;
      case 'nearest':
      default:
        rounded = roundToTick(price.value(), tickDecimal, Decimal.ROUND_HALF_UP);
        break;
    }

    // Создание Price
    return this.create(rounded);
  }

  /**
   * Проверяет что price кратен tickSize
   *
   * @remarks
   * Проверяет что price УЖЕ кратен tickSize.
   * Для округления используй roundToMarketTick().
   *
   * Используется для валидации после округления или
   * для проверки входящих данных.
   *
   * @param price - Цена для проверки
   * @param tickSize - Размер тика (number, string, или Decimal)
   * @returns Result<void> если кратен, InvalidPriceError | InvalidTickSizeError если нет
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.5));
   * const result = PriceService.ensureAlignedToMarketTick(price, 0.01);
   * if (result.ok) {
   *   console.log('Price aligned to tick size');
   * } else {
   *   console.error(result.error.context.reason); // 'not_aligned'
   * }
   * ```
   */
  public static ensureAlignedToMarketTick(
    price: Price,
    tickSize: number | string | Decimal
  ): Result<void, InvalidPriceError | InvalidTickSizeError> {
    return ValidateAligned.check(price, tickSize);
  }
}
