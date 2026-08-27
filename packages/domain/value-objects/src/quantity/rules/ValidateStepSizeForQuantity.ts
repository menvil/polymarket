import type { Result } from '@polymarket/result';
import { InvalidQuantityError } from '@polymarket/errors';
import type Decimal from 'decimal.js';
import type { GridStepPolicy } from '../../shared/numeric/ValidateGridStep.js';
import { validateGridStep } from '../../shared/numeric/ValidateGridStep.js';
import { QuantityErrorReason } from '../errors/QuantityErrorReason.js';

/**
 * Описание шага количества как шага дискретной сетки.
 *
 * @remarks
 * Верхнего предела у шага количества нет: в отличие от тика цены, который
 * не может превышать ширину диапазона `[MIN, MAX]`, количество не
 * ограничено сверху вовсе — поэтому `reasonExceedsMax` не задан.
 */
const QUANTITY_STEP_POLICY: GridStepPolicy<InvalidQuantityError> = {
  ErrorConstructor: InvalidQuantityError,
  field: 'stepSize',
  label: 'Step size',
  reasonNaN: QuantityErrorReason.NAN,
  reasonNotFinite: QuantityErrorReason.NON_FINITE,
  // INVALID_STEP_SIZE существовал в enum, но не эмитился НИКОГДА: правило
  // вообще не клало reason в контекст. Теперь член ожил
  reasonNotPositive: QuantityErrorReason.INVALID_STEP_SIZE
};

/**
 * Правило: шаг округления количества должен быть пригодным числом.
 *
 * @remarks
 * Проверка совпадает с тиком цены — это одно понятие «шаг дискретной
 * сетки», поэтому реализация общая и живёт в `shared/numeric`. Здесь
 * остаётся только привязка к домену: тип ошибки и словарь причин.
 *
 * До объединения у этого правила в контексте ошибки НЕ БЫЛО поля
 * `reason` вообще (в отличие от копии для `SignedQuantity`), и потребитель
 * не мог отличить «не конечный» от «не положительный». Теперь причина
 * приходит всегда.
 *
 * @example
 * ```typescript
 * import { ValidateStepSizeForQuantity } from '@polymarket/value-objects/quantity';
 *
 * ValidateStepSizeForQuantity.check(new Decimal(0.5));  // Ok
 * ValidateStepSizeForQuantity.check(new Decimal(0));    // Err: INVALID_STEP_SIZE
 * ValidateStepSizeForQuantity.check(new Decimal(NaN));  // Err: NAN
 * ```
 */
export class ValidateStepSizeForQuantity {
  /**
   * Проверяет шаг округления количества.
   *
   * @param stepSize - Шаг округления (уже Decimal — парсинг делается в Facade)
   * @returns `Ok(stepSize)` либо `InvalidQuantityError` с причиной отказа
   * @throws Никогда — все ошибки в `Result`
   *
   * @example
   * ```typescript
   * const result = ValidateStepSizeForQuantity.check(new Decimal(-1));
   * if (!result.ok) {
   *   console.error(result.error.context.reason); // 'INVALID_STEP_SIZE'
   * }
   * ```
   */
  public static check(stepSize: Decimal): Result<Decimal, InvalidQuantityError> {
    return validateGridStep(stepSize, QUANTITY_STEP_POLICY);
  }
}
