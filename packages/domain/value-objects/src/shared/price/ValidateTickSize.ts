import type { Result } from '@polymarket/result';
import { InvalidTickSizeError } from '@polymarket/errors';
import Decimal from 'decimal.js';
import { PriceRuleReason } from './priceRuleTypes.js';
import type { GridStepPolicy } from '../numeric/ValidateGridStep.js';
import { validateGridStep } from '../numeric/ValidateGridStep.js';

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
    // Тик — частный случай шага дискретной сетки; проверка общая
    // с количествами и живёт в shared/numeric
    return validateGridStep(tickSize, TICK_STEP_POLICY, maxAllowed);
  }
}

/**
 * Описание тика как шага сетки.
 *
 * @remarks
 * Ценовой словарь причин отдаётся общему правилу, поэтому контекст ошибки
 * остаётся прежним: `field: 'tickSize'`, `reason` из {@link PriceRuleReason}.
 */
const TICK_STEP_POLICY: GridStepPolicy<InvalidTickSizeError> = {
  ErrorConstructor: InvalidTickSizeError,
  field: 'tickSize',
  label: 'Tick size',
  reasonNaN: PriceRuleReason.IS_NAN,
  reasonNotFinite: PriceRuleReason.NOT_FINITE,
  reasonNotPositive: PriceRuleReason.NOT_POSITIVE,
  reasonExceedsMax: PriceRuleReason.EXCEEDS_RANGE
};
