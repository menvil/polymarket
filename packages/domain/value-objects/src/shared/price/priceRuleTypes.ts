/**
 * Типизированные поля для Rules
 *
 * @remarks
 * Используется для type-safe error handling в Rules слое.
 * Каждое правило возвращает ошибку с типизированным field.
 */
export type TickSizeField = 'tickSize';
export type AlignedField = 'price';

/**
 * Типизированный контекст ошибки
 *
 * @template F - Тип поля (union литералов)
 * @template R - Тип причины (union литералов)
 *
 * @remarks
 * Базовая структура для всех ошибок в Rules.
 * Гарантирует наличие field и reason в каждой ошибке.
 *
 * @example
 * ```typescript
 * type TickSizeError = ErrorContext<TickSizeField, TickSizeErrorReason>;
 * const error: TickSizeError = {
 *   field: 'tickSize',
 *   reason: 'not_positive',
 *   tickSize: '0'
 * };
 * ```
 */
export type ErrorContext<F extends string, R extends string> = {
  field: F;
  reason: R;
  [k: string]: unknown;
};

/**
 * Единый словарь причин отказа ОБЩИХ ценовых правил.
 *
 * @remarks
 * Правила (`ValidateAligned`, `ValidateTickSize`, `ValidateDivisor...`)
 * общие для всех ценовых доменов и потому НЕ МОГУТ знать доменный enum
 * (`OutcomePriceErrorReason` / `AssetPriceErrorReason`) — иначе они
 * перестали бы быть общими. Это их собственный словарь.
 *
 * Раньше он был размазан по трём несвязанным типам, из-за чего
 * потребителю не с чем было сравнивать: доменный enum перечислял
 * `NOT_ALIGNED = 'NOT_ALIGNED'`, а приходило `'not_aligned'`, и сравнение
 * молча не срабатывало. Теперь сравнивать есть с чем.
 *
 * Различение слоёв по регистру не косметика, а полезный сигнал: пришло
 * `SCREAMING` — отказал инвариант домена; пришло `lower_snake` — отказало
 * общее правило.
 *
 * @example
 * ```typescript
 * import { PriceRuleReason } from '@polymarket/value-objects';
 *
 * if (result.error.context?.reason === PriceRuleReason.NOT_ALIGNED) {
 *   console.error('Price not aligned to tick size');
 * }
 * ```
 */
export enum PriceRuleReason {
  /** Не удалось разобрать значение в Decimal */
  PARSE_ERROR = 'parse_error',

  /** Значение является NaN */
  IS_NAN = 'is_nan',

  /** Значение не конечное (Infinity, -Infinity) */
  NOT_FINITE = 'not_finite',

  /** Значение <= 0 там, где требуется строго положительное */
  NOT_POSITIVE = 'not_positive',

  /** Значение отрицательное */
  IS_NEGATIVE = 'is_negative',

  /** Делитель равен нулю */
  IS_ZERO = 'is_zero',

  /** Значение превышает допустимый максимум */
  EXCEEDS_RANGE = 'exceeds_range',

  /** Тик не кратен базовому тику домена */
  NOT_MULTIPLE_OF_BASE_TICK = 'not_multiple_of_base_tick',

  /** Цена не легла на сетку тика */
  NOT_ALIGNED = 'not_aligned'
}

/**
 * Типы reason для ValidateTickSize
 *
 * @remarks
 * Подмножество {@link PriceRuleReason}, которое может вернуть проверка
 * самого тика.
 */
export type TickSizeErrorReason =
  | 'parse_error'
  | 'is_nan'
  | 'not_finite'
  | 'not_positive'
  | 'exceeds_range';

/**
 * Типы reason для ValidateTickSizeMultipleOfBaseTick
 *
 * @remarks
 * Тик должен быть кратен базовому тику домена: у Polymarket он фиксирован
 * площадкой (`0.0001`), у биржи свой на каждый инструмент.
 */
export type TickSizeMultipleReason = 'not_multiple_of_base_tick';

/**
 * Типы reason для ValidateAligned
 *
 * @remarks
 * Проверка что цена выровнена по тику (`price % tickSize === 0`).
 */
export type AlignedErrorReason = 'not_aligned';
