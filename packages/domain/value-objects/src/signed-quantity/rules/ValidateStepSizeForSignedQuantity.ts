import type { Result } from '@polymarket/result';
import { InvalidSignedQuantityError } from '@polymarket/errors';
import type Decimal from 'decimal.js';
import type { GridStepPolicy } from '../../shared/numeric/ValidateGridStep.js';
import { validateGridStep } from '../../shared/numeric/ValidateGridStep.js';
import { SignedQuantityErrorReason } from '../errors/SignedQuantityErrorReason.js';

/**
 * Описание шага знакового количества как шага дискретной сетки.
 *
 * @remarks
 * Верхнего предела нет: количество не ограничено сверху, в отличие от
 * тика цены, который не может превышать ширину диапазона `[MIN, MAX]`.
 */
const SIGNED_QUANTITY_STEP_POLICY: GridStepPolicy<InvalidSignedQuantityError> = {
  ErrorConstructor: InvalidSignedQuantityError,
  field: 'stepSize',
  label: 'Step size',
  reasonNaN: SignedQuantityErrorReason.NAN,
  reasonNotFinite: SignedQuantityErrorReason.NON_FINITE,
  reasonNotPositive: SignedQuantityErrorReason.NON_POSITIVE_STEP_SIZE
};

/**
 * Правило: шаг округления знакового количества должен быть пригодным числом.
 *
 * @remarks
 * Проверка совпадает с тиком цены и с шагом обычного количества — это одно
 * понятие «шаг дискретной сетки», поэтому реализация общая и живёт в
 * `shared/numeric`. Здесь остаётся привязка к домену: тип ошибки и словарь
 * причин, которые закреплены тестами потребителей.
 *
 * Знак шага не имеет отношения к знаку самого количества: шаг всегда
 * строго положителен, даже когда округляемая величина отрицательна.
 *
 * @example
 * ```typescript
 * ValidateStepSizeForSignedQuantity.check(new Decimal(0.5));  // Ok
 * ValidateStepSizeForSignedQuantity.check(new Decimal(-1));   // Err: NON_POSITIVE_STEP_SIZE
 * ```
 */
export class ValidateStepSizeForSignedQuantity {
  /**
   * Проверяет шаг округления знакового количества.
   *
   * @param stepSize - Шаг округления (уже Decimal — парсинг делается в Facade)
   * @returns `Ok(stepSize)` либо `InvalidSignedQuantityError` с причиной отказа
   * @throws Никогда — все ошибки в `Result`
   *
   * @example
   * ```typescript
   * const result = ValidateStepSizeForSignedQuantity.check(new Decimal(0));
   * if (!result.ok) {
   *   console.error(result.error.context.reason); // 'NON_POSITIVE_STEP_SIZE'
   * }
   * ```
   */
  public static check(stepSize: Decimal): Result<Decimal, InvalidSignedQuantityError> {
    return validateGridStep(stepSize, SIGNED_QUANTITY_STEP_POLICY);
  }
}
