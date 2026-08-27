/**
 * Правило: шаг дискретной сетки должен быть пригодным числом.
 *
 * @remarks
 * «Шаг сетки» — общее понятие для цен и количеств: у цены это тик
 * (`0.01`), у количества — минимальная доля лота. Проверка одна и та же,
 * различаются лишь имя поля в диагностике и словарь причин домена.
 *
 * Поэтому правило живёт в `shared/numeric`, а НЕ в `shared/price`:
 * `quantity` ценовым доменом не является, и импорт из `shared/price`
 * повторил бы ту самую ошибку плоской папки, из-за которой `shared/`
 * пришлось разбирать.
 *
 * До объединения существовали три копии: `ValidateTickSize` (полная —
 * NaN, finite, positive, максимум), `ValidateStepSizeForQuantity` и
 * `ValidateStepSizeForSignedQuantity` (обе — усечённые до finite и
 * positive). Копии разошлись: у quantity-версии в контексте ошибки НЕ
 * БЫЛО поля `reason` вообще, и потребитель не мог отличить «не конечный»
 * от «не положительный».
 */
import { Result, Ok, Err } from '@polymarket/result';
import type { AnyTradingError, ErrorConstructor } from '@polymarket/errors';
import { ErrorSource } from '@polymarket/errors';
import type Decimal from 'decimal.js';

/**
 * Описание домена для правила шага сетки.
 *
 * @remarks
 * Тот же приём, что и `PriceDomain`: общей делается механика проверки, а
 * тип ошибки и словарь причин остаются за доменом — их форма закреплена
 * тестами потребителей.
 *
 * @typeParam TError - Тип ошибки домена
 */
export interface GridStepPolicy<TError extends AnyTradingError> {
  /** Конструктор ошибки домена */
  readonly ErrorConstructor: ErrorConstructor<TError>;
  /** Имя поля в контексте: `'tickSize'`, `'stepSize'` */
  readonly field: string;
  /** Человекочитаемое имя в сообщении: `'Tick size'`, `'Step size'` */
  readonly label: string;
  /** Причина «значение NaN» */
  readonly reasonNaN: string;
  /** Причина «значение не конечно» */
  readonly reasonNotFinite: string;
  /** Причина «значение не положительно» */
  readonly reasonNotPositive: string;
  /** Причина «значение превышает максимум»; нужна, только если домен задаёт максимум */
  readonly reasonExceedsMax?: string;
}

/**
 * Проверяет шаг дискретной сетки.
 *
 * @param step - Проверяемый шаг
 * @param policy - Описание домена: тип ошибки, имена, словарь причин
 * @param maxAllowed - Верхний предел, если он в домене есть
 * @returns Тот же `step` при успехе либо ошибку домена
 * @throws Никогда — все ошибки в `Result`
 *
 * @remarks
 * Порядок проверок значим: NaN отсекается ПЕРВЫМ, иначе он был бы
 * поглощён проверкой `isFinite` (у `Decimal` NaN не конечен) и потерял бы
 * собственную причину — ровно это и происходило в усечённых копиях.
 *
 * Возврат `step`, а не `void`: вызывающему обычно нужно проверенное
 * значение, и промежуточная переменная у него исчезает.
 *
 * @example
 * ```typescript
 * const TICK: GridStepPolicy<InvalidTickSizeError> = {
 *   ErrorConstructor: InvalidTickSizeError,
 *   field: 'tickSize',
 *   label: 'Tick size',
 *   reasonNaN: PriceRuleReason.IS_NAN,
 *   reasonNotFinite: PriceRuleReason.NOT_FINITE,
 *   reasonNotPositive: PriceRuleReason.NOT_POSITIVE,
 *   reasonExceedsMax: PriceRuleReason.EXCEEDS_RANGE,
 * };
 *
 * validateGridStep(new Decimal(0.01), TICK);                    // Ok
 * validateGridStep(new Decimal(0), TICK);                       // Err: not_positive
 * validateGridStep(new Decimal(2), TICK, new Decimal(0.9998));  // Err: exceeds_range
 * ```
 */
export function validateGridStep<TError extends AnyTradingError>(
  step: Decimal,
  policy: GridStepPolicy<TError>,
  maxAllowed?: Decimal,
): Result<Decimal, TError> {
  const fail = (
    message: string,
    reason: string,
    extra?: Record<string, unknown>,
  ): Result<Decimal, TError> =>
    Err(
      new policy.ErrorConstructor(message, {
        context: {
          source: ErrorSource.RULE_VALIDATION,
          field: policy.field,
          reason,
          [policy.field]: step.toString(),
          ...extra,
        },
      }),
    );

  // NaN отсекается первым: иначе его поглотит isFinite и причина потеряется
  if (step.isNaN()) {
    return fail(`${policy.label} must not be NaN`, policy.reasonNaN);
  }

  if (!step.isFinite()) {
    return fail(`${policy.label} must be finite, got ${step.toString()}`, policy.reasonNotFinite);
  }

  if (step.lessThanOrEqualTo(0)) {
    return fail(`${policy.label} must be positive, got ${step.toString()}`, policy.reasonNotPositive);
  }

  // Верхняя граница проверяется, только если домен её задал
  if (maxAllowed !== undefined && step.greaterThan(maxAllowed)) {
    return fail(
      `${policy.label} ${step.toString()} exceeds allowed range`,
      policy.reasonExceedsMax ?? policy.reasonNotPositive,
      { maxAllowed: maxAllowed.toString() },
    );
  }

  return Ok(step);
}
