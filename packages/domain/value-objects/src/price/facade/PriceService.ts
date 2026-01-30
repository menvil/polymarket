import { Result, Ok, Err } from '@polymarket/result';
import {
  InvalidPriceError,
  InvalidOperandError,
  InvalidDivisorError,
  InvalidTickSizeError,
  ArithmeticOverflowError
} from '@polymarket/errors';
import { Price, PriceInvariantViolation } from '../core/Price.js';
import { ValidateTickSizeMultipleOfBaseTick } from '../rules/ValidateTickSizeMultipleOfBaseTick.js';
import { ValidateAligned } from '../rules/ValidateAligned.js';
import { ValidateFactorForPriceMultiplication } from '../rules/ValidateFactorForPriceMultiplication.js';
import { ValidateDivisorForPriceDivision } from '../rules/ValidateDivisorForPriceDivision.js';
import {
  addDecimal,
  subtractDecimal,
  multiplyDecimal,
  divideDecimal,
  roundToTick,
  floorToTick,
  ceilToTick
} from '@polymarket/math';
import { withOperationContext } from './errorUtils.js';
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
   * Константа для арифметических операций - избегаем создания new Decimal(1) каждый раз
   */
  private static readonly ONE = new Decimal(1);

  /**
   * Константа для арифметических операций - избегаем создания new Decimal(2) каждый раз
   */
  private static readonly TWO = new Decimal(2);

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
    const result = subtractDecimal(this.ONE, price.value());
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
    const avgValue = divideDecimal(sum, this.TWO);
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
          (ctx) => `Invalid factor: ${ctx.value}`,
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

    // Валидация через rule (проверяет isNaN, isFinite)
    const validateResult = ValidateFactorForPriceMultiplication.check(factorDecimal);
    if (!validateResult.ok) {
      return Err(
        withOperationContext(validateResult.error, 'multiply', {
          price: price.value().toString()
        })
      );
    }

    // Умножение с обработкой ожидаемых арифметических исключений
    try {
      const result = multiplyDecimal(price.value(), factorDecimal);

      // create() может вернуть Err если результат non-finite (overflow) или выходит за диапазон
      const createResult = this.create(result);
      if (!createResult.ok) {
        return Err(
          withOperationContext(createResult.error, 'multiply', {
            price: price.value().toString(),
            factor: factorDecimal.toString()
          })
        );
      }

      return createResult;
    } catch (error) {
      // Мапим ТОЛЬКО ожидаемые типы ошибок из @polymarket/math
      if (error instanceof ArithmeticOverflowError) {
        return Err(
          new InvalidPriceError(
            `Multiplication failed: ${error.message}`,
            {
              context: {
                op: 'multiply',
                price: price.value().toString(),
                factor: factorDecimal.toString(),
                cause: {
                  name: error.name,
                  message: error.message
                }
              }
            }
          )
        );
      }

      // Неожиданные ошибки - оборачиваем в Result
      return Err(
        new InvalidPriceError(
          `Unexpected error during price multiply: ${error instanceof Error ? error.message : String(error)}`,
          {
            context: {
              op: 'multiply',
              price: price.value().toString(),
              factor: factorDecimal.toString(),
              cause: error instanceof Error ? {
                name: error.name,
                message: error.message
              } : {
                name: 'UnknownError',
                message: String(error)
              }
            }
          }
        )
      );
    }
  }

  /**
   * Делит цену на делитель
   *
   * @param price - Исходная цена
   * @param divisor - Делитель (number, string, или Decimal)
   * @returns Result с результатом или InvalidPriceError | InvalidDivisorError
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * divide(0.6, 2) = 0.3
   * divide(0.5, 0) → InvalidDivisorError (проверка через ValidateDivisorForPriceDivision)
   *
   * Алгоритм:
   * 1. Парсинг divisor в Decimal (try/catch для parse errors)
   * 2. Валидация divisor через ValidateDivisorForPriceDivision (проверка isNaN, isFinite, isZero)
   * 3. Деление через divideDecimal() из @polymarket/math
   * 4. Создание Price из результата
   *
   * Обработка ошибок:
   * - Ошибки парсинга divisor → InvalidDivisorError
   * - Невалидный divisor (через rule) → InvalidDivisorError
   * - ArithmeticOverflowError из divideDecimal → InvalidPriceError с причиной в context.cause
   * - Неожиданные ошибки → InvalidPriceError с полным контекстом
   * - Результат вне диапазона Price → InvalidPriceError
   *
   * Все ошибки оборачиваются в Result. Метод никогда не бросает исключения.
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
  ): Result<Price, InvalidPriceError | InvalidDivisorError> {
    // Парсинг divisor
    let divisorDecimal: Decimal;
    try {
      divisorDecimal = divisor instanceof Decimal ? divisor : new Decimal(divisor);
    } catch (error) {
      return Err(
        new InvalidDivisorError(
          (ctx) => `Invalid divisor: ${ctx.rawDivisor}`,
          {
            context: {
              operation: 'divide',
              rawDivisor: String(divisor),
              divisor: String(divisor),
              dividend: price.value().toString(),
              parseError: error instanceof Error ? error.message : 'unknown'
            }
          }
        )
      );
    }

    // Валидация через rule (принимает только Decimal)
    const validateResult = ValidateDivisorForPriceDivision.check(divisorDecimal);
    if (!validateResult.ok) {
      return Err(
        withOperationContext(validateResult.error, 'divide', {
          dividend: price.value().toString()
        })
      );
    }

    // Делим с обработкой ожидаемых арифметических исключений
    try {
      const result = divideDecimal(price.value(), divisorDecimal);

      // create() может вернуть Err если результат non-finite (overflow) или выходит за диапазон
      const createResult = this.create(result);
      if (!createResult.ok) {
        return Err(
          withOperationContext(createResult.error, 'divide', {
            dividend: price.value().toString(),
            divisor: divisorDecimal.toString()
          })
        );
      }

      return createResult;
    } catch (error) {
      // Мапим ТОЛЬКО ожидаемые типы ошибок из @polymarket/math
      if (error instanceof ArithmeticOverflowError) {
        return Err(
          new InvalidPriceError(
            `Division failed: ${error.message}`,
            {
              context: {
                op: 'divide',
                dividend: price.value().toString(),
                divisor: divisorDecimal.toString(),
                cause: {
                  name: error.name,
                  message: error.message
                }
              }
            }
          )
        );
      }

      // Неожиданные ошибки - оборачиваем в Result
      return Err(
        new InvalidPriceError(
          `Unexpected error during price divide: ${error instanceof Error ? error.message : String(error)}`,
          {
            context: {
              op: 'divide',
              dividend: price.value().toString(),
              divisor: divisorDecimal.toString(),
              cause: error instanceof Error ? {
                name: error.name,
                message: error.message
              } : {
                name: 'UnknownError',
                message: String(error)
              }
            }
          }
        )
      );
    }
  }

  /**
   * Округляет цену до ближайшего тика
   *
   * @param price - Исходная цена
   * @param tickSize - Размер тика (number, string, или Decimal)
   * @param mode - Режим округления ('nearest' | 'floor' | 'ceil')
   * @returns Result с округлённой ценой или InvalidPriceError | InvalidTickSizeError
   * @throws Никогда - все ошибки оборачиваются в Result
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
   * Алгоритм:
   * 1. Валидация tickSize через ValidateTickSizeMultipleOfBaseTick (проверка на кратность базовому тику 0.0001)
   * 2. Выбор направления округления (nearest/floor/ceil)
   * 3. Округление через @polymarket/math функции (roundToTick/floorToTick/ceilToTick)
   * 4. Создание Price из округлённого значения
   *
   * Обработка ошибок:
   * - Невалидный tickSize → InvalidTickSizeError
   * - ArithmeticOverflowError из roundCore → InvalidPriceError с причиной в context.cause
   * - Неожиданные ошибки → InvalidPriceError с полным контекстом
   * - Результат вне диапазона → InvalidPriceError
   *
   * Все ошибки оборачиваются в Result. Метод никогда не бросает исключения.
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
    const tickRes = ValidateTickSizeMultipleOfBaseTick.check(tickSize);
    if (!tickRes.ok) return Err(tickRes.error);
    const tick = tickRes.value;

    try {
      let out: Decimal;

      switch (mode) {
        case 'floor':
          out = floorToTick(price.value(), tick);
          break;

        case 'ceil':
          out = ceilToTick(price.value(), tick);
          break;

        case 'nearest':
        default:
          out = roundToTick(price.value(), tick, Decimal.ROUND_HALF_UP);
          break;
      }

      return this.create(out);
    } catch (e: unknown) {
      if (e instanceof InvalidTickSizeError) return Err(e);

      if (e instanceof ArithmeticOverflowError) {
        return Err(
          new InvalidPriceError(
            e.message,
            {
              context: {
                op: 'roundToMarketTick',
                price: price.value().toString(),
                tickSize: tick.toString(),
                mode,
                cause: { name: e.name, message: e.message }
              }
            }
          )
        );
      }

      return Err(
        new InvalidPriceError(
          e instanceof Error ? e.message : String(e),
          {
            context: {
              op: 'roundToMarketTick',
              price: price.value().toString(),
              tickSize: tick.toString(),
              mode,
              cause: e instanceof Error
                ? { name: e.name, message: e.message }
                : { name: 'UnknownError', message: String(e) }
            }
          }
        )
      );
    }
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
