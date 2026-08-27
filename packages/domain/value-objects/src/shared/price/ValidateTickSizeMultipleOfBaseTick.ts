import { Result, Ok, Err } from '@polymarket/result';
import { InvalidTickSizeError, ErrorSource } from '@polymarket/errors';
import { ValidateTickSize } from './ValidateTickSize.js';
import type { TickSizeMultipleReason } from './priceRuleTypes.js';
import type Decimal from 'decimal.js';
import { PriceRuleReason } from './priceRuleTypes.js';
import type { GridStepPolicy } from '../numeric/ValidateGridStep.js';
import { validateGridStep } from '../numeric/ValidateGridStep.js';

/**
 * Описание базового тика как шага дискретной сетки.
 *
 * @remarks
 * Отдельная политика от `TICK_STEP_POLICY`, потому что диагностика должна
 * указывать на `baseTick`, а не на `tickSize`: при разборе отказа важно,
 * какой из двух шагов оказался негодным. Верхнего предела у базового тика
 * нет — его задаёт площадка или биржа, а не мы.
 */
const BASE_TICK_POLICY: GridStepPolicy<InvalidTickSizeError> = {
  ErrorConstructor: InvalidTickSizeError,
  field: 'baseTick',
  label: 'Base tick',
  reasonNaN: PriceRuleReason.IS_NAN,
  reasonNotFinite: PriceRuleReason.NOT_FINITE,
  reasonNotPositive: PriceRuleReason.NOT_POSITIVE
};

/**
 * Правило: TickSize должен быть кратен базовому тику Polymarket
 *
 * @remarks
 * POLYMARKET-СПЕЦИФИЧНОЕ правило.
 * Базовый тик передаётся ПАРАМЕТРОМ: у рынка предсказаний он один на всю
 * площадку (`OutcomePrice.MIN` = 0.0001), у биржи — свой на каждый
 * инструмент и приходит из market info. Захардкоженное значение было
 * причиной, по которой правило не переносилось на второй ценовой домен.
 *
 * Сначала выполняет базовую валидацию через ValidateTickSize,
 * затем проверяет кратность базовому тику.
 *
 * @example
 * ```typescript
 * import { ValidateTickSizeMultipleOfBaseTick } from '@polymarket/value-objects/outcome-price';
 *
 * const result = ValidateTickSizeMultipleOfBaseTick.check(new Decimal('0.0002'));
 * if (result.ok) {
 *   console.log('TickSize кратен базовому тику');
 * } else {
 *   console.error(result.error.context.reason); // 'not_multiple_of_base_tick'
 * }
 * ```
 */
export class ValidateTickSizeMultipleOfBaseTick {
  /**
   * Проверяет что tickSize кратен базовому тику площадки
   *
   * @param tickSize - Размер тика (уже Decimal - парсинг делается в Facade)
   * @returns Result с валидированным Decimal или InvalidTickSizeError
   *
   * @remarks
   * ВАЖНО: Принимает только Decimal. Парсинг должен быть сделан в Facade через toDecimal().
   *
   * Выполняет две проверки:
   * 1. Базовая валидация через ValidateTickSize (positive, finite, в пределах диапазона)
   * 2. Проверка кратности базовому тику: tickSize % 0.0001 === 0
   *
   * @example
   * ```typescript
   * // ✅ Валидные tickSize (кратны 0.0001)
   * const tick1 = new Decimal('0.0001');
   * ValidateTickSizeMultipleOfBaseTick.check(tick1); // Ok
   *
   * const tick2 = new Decimal('0.0002');
   * ValidateTickSizeMultipleOfBaseTick.check(tick2); // Ok
   *
   * // ❌ Невалидные (не кратны 0.0001)
   * const tick3 = new Decimal('0.00015');
   * ValidateTickSizeMultipleOfBaseTick.check(tick3); // Err: not_multiple_of_base_tick
   * ```
   */
  public static check(
    tickSize: Decimal,
    baseTick: Decimal,
    maxAllowed?: Decimal
  ): Result<Decimal, InvalidTickSizeError> {
    // Шаг 1: Базовая валидация тика
    const tickResult = ValidateTickSize.check(tickSize, maxAllowed);
    if (!tickResult.ok) {
      return tickResult;
    }
    const tickDecimal = tickResult.value;

    // Шаг 2: базовый тик — ТОЖЕ шаг сетки и обязан быть валидным.
    // Раньше он принимался на веру, и отрицательное значение проходило
    // насквозь: 0.01 / -0.00000001 = -1000000, целое → Ok. Ноль ловился
    // лишь ПОБОЧНО (деление даёт Infinity, оно не целое) и с обманчивой
    // причиной not_multiple_of_base_tick — потребитель искал бы «подходящий
    // кратный тик», которого не существует.
    const baseResult = validateGridStep(baseTick, BASE_TICK_POLICY);
    if (!baseResult.ok) {
      return baseResult;
    }

    // Шаг 3: Проверка кратности
    const BASE_TICK = baseTick;
    const quotient = tickDecimal.div(BASE_TICK);

    if (!quotient.isInteger()) {
      return Err(
        new InvalidTickSizeError(
          (ctx) =>
            `Tick size ${ctx.tickSize} must be multiple of base tick ${ctx.baseTick}`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              field: 'tickSize',
              reason: PriceRuleReason.NOT_MULTIPLE_OF_BASE_TICK as TickSizeMultipleReason,
              tickSize: tickDecimal.toString(),
              baseTick: BASE_TICK.toString(),
              quotient: quotient.toString()
            }
          }
        )
      );
    }

    return Ok(tickDecimal);
  }
}
