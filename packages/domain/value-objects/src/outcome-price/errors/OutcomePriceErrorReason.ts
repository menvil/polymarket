/**
 * Причины отказов, которые порождает САМ домен OutcomePrice.
 *
 * @remarks
 * Здесь перечислено ровно то, что домен эмитит, и ничего сверх того.
 * Раньше enum содержал `DIVISION_BY_ZERO`, `NOT_ALIGNED` и
 * `INVALID_TICK_SIZE` — отказы такие бывают, но порождает их не домен, а
 * ОБЩИЕ ПРАВИЛА (`shared/price`), и говорят они своим словарём
 * {@link PriceRuleReason}. Ни одно из трёх значений не эмитилось никогда,
 * а пример в этом докблоке предлагал сравнение, которое всегда `false`:
 * приходило `'not_aligned'`, сравнивалось с `'NOT_ALIGNED'`.
 *
 * Два словаря — не случайность и не долг: правила стали общими для
 * ценовых доменов и потому НЕ МОГУТ знать доменный enum. Разделение
 * проходит по слою, а не по домену:
 *
 * - ядро и фасад домена → `OutcomePriceErrorReason` (этот enum)
 * - общие правила → `PriceRuleReason`
 *
 * Отличие от {@link AssetPriceErrorReason} сводится к семантике диапазона:
 * доля исхода ограничена с ОБЕИХ сторон (`[0.0001, 0.9999]`), поэтому у
 * неё есть `OUT_OF_RANGE_LOW` и `_HIGH`; цена актива ограничена только
 * снизу и строго (`(0, ∞)`), поэтому у неё `NOT_POSITIVE`. Это разные
 * инварианты, и сводить их к одному имени значило бы соврать об обоих.
 *
 * @example
 * ```typescript
 * import { OutcomePriceErrorReason } from '@polymarket/value-objects/outcome-price';
 *
 * // Отказ ДОМЕНА — сравниваем с этим enum
 * if (result.error.context?.reason === OutcomePriceErrorReason.OUT_OF_RANGE_HIGH) {
 *   console.error('Price above the outcome range');
 * }
 *
 * // Отказ ПРАВИЛА — сравниваем со словарём правил
 * if (result.error.context?.reason === PriceRuleReason.NOT_ALIGNED) {
 *   console.error('Price not aligned to tick size');
 * }
 * ```
 */
export enum OutcomePriceErrorReason {
  /** Значение NaN */
  NAN = 'NAN',

  /** Значение не finite (Infinity, -Infinity) */
  NON_FINITE = 'NON_FINITE',

  /** Ошибка парсинга значения */
  INVALID_FORMAT = 'INVALID_FORMAT',

  /** Цена ниже допустимого диапазона */
  OUT_OF_RANGE_LOW = 'OUT_OF_RANGE_LOW',

  /** Цена выше допустимого диапазона */
  OUT_OF_RANGE_HIGH = 'OUT_OF_RANGE_HIGH'
}
