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
 * Типы reason для ValidateTickSize
 *
 * @remarks
 * Все возможные причины ошибок при валидации tickSize.
 *
 * - parse_error: Не удалось распарсить tickSize в Decimal
 * - is_nan: tickSize является NaN
 * - not_finite: tickSize не конечное (Infinity или -Infinity)
 * - not_positive: tickSize <= 0
 * - exceeds_range: tickSize больше допустимого максимума
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
 * Polymarket-специфичное правило:
 * tickSize должен быть кратен базовому тику (0.0001).
 */
export type TickSizeMultipleReason = 'not_multiple_of_base_tick';

/**
 * Типы reason для ValidateAligned
 *
 * @remarks
 * Проверка что price выровнен по tickSize.
 * Price должен быть кратен tickSize (price % tickSize === 0).
 */
export type AlignedErrorReason = 'not_aligned';
