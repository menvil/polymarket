import { Result, Ok, Err } from '@polymarket/result';
import { InvalidTickSizeError, ErrorSource } from '@polymarket/errors';
import Decimal from 'decimal.js';

/**
 * Правило: TickSize должен быть валидным шагом сетки цен.
 *
 * Проверки NaN/finite/positive универсальны для любого ценового домена.
 * Верхняя граница передаётся ПАРАМЕТРОМ и проверяется только когда домен
 * её имеет: у рынка предсказаний тик не может превышать ширину диапазона
 * `[MIN, MAX]`, а у цены актива верхней границы нет вовсе.
 *
 * @remarks
 * Проверяет базовые свойства tickSize:
 * - Не NaN
 * - Положительный
 * - Конечный
 * - Не больше чем диапазон (MAX - MIN)
 *
 * НЕ проверяет кратность базовому тику - используй ValidateTickSizeMultipleOfBaseTick.
 *
 * @example
 * ```typescript
 * import { ValidateTickSize } from '@polymarket/value-objects/outcome-price';
 * import Decimal from 'decimal.js';
 *
 * const result = ValidateTickSize.check(new Decimal(0.0001));
 * if (result.ok) {
 *   const tickDecimal = result.value; // Decimal
 * } else {
 *   console.error(result.error.context.reason); // 'is_nan' | ...
 * }
 * ```
 */
export class ValidateTickSize {
  /**
   * Проверяет валидность tickSize
   *
   * @param tickSize - Размер тика (уже Decimal - парсинг делается в Facade)
   * @returns Result с валидированным Decimal или InvalidTickSizeError
   *
   * @remarks
   * ВАЖНО: Принимает только Decimal. Парсинг должен быть сделан в Facade через toDecimal().
   * Rule НЕ должна парсить - это ответственность Facade.
   *
   * @example
   * ```typescript
   * const tickDecimal = new Decimal('0.0001');
   * const result = ValidateTickSize.check(tickDecimal);
   * if (!result.ok) {
   *   console.error(result.error.context.field); // 'tickSize'
   *   console.error(result.error.context.reason); // 'is_nan' | ...
   *   return;
   * }
   * const validated = result.value; // Используем в дальнейшем
   * ```
   */
  public static check(
    tickSize: Decimal,
    maxAllowed?: Decimal
  ): Result<Decimal, InvalidTickSizeError> {
    // Проверка NaN
    if (tickSize.isNaN()) {
      return Err(
        new InvalidTickSizeError(
          () => `Tick size must not be NaN`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              field: 'tickSize',
              reason: 'is_nan',
              tickSize: tickSize.toString()
            }
          }
        )
      );
    }

    // Проверка Finite
    if (!tickSize.isFinite()) {
      return Err(
        new InvalidTickSizeError(
          (ctx) => `Tick size must be finite, got ${ctx.tickSize}`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              field: 'tickSize',
              reason: 'not_finite',
              tickSize: tickSize.toString()
            }
          }
        )
      );
    }

    // Проверка Positive
    if (tickSize.lessThanOrEqualTo(0)) {
      return Err(
        new InvalidTickSizeError(
          (ctx) => `Tick size must be positive, got ${ctx.tickSize}`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              field: 'tickSize',
              reason: 'not_positive',
              tickSize: tickSize.toString()
            }
          }
        )
      );
    }

    // Верхняя граница проверяется только если домен её имеет
    if (maxAllowed !== undefined && tickSize.greaterThan(maxAllowed)) {
      return Err(
        new InvalidTickSizeError(
          (ctx) => `Tick size ${ctx.tickSize} exceeds price range`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              field: 'tickSize',
              reason: 'exceeds_range',
              tickSize: tickSize.toString(),
              maxAllowed: maxAllowed.toString()
            }
          }
        )
      );
    }

    return Ok(tickSize);
  }
}
