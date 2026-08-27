/**
 * Операции над скалярными величинами — общие для `Quantity` и `SignedQuantity`.
 *
 * @remarks
 * До объединения эти семь операций существовали в двух копиях, совпадавших
 * байт в байт с точностью до имён типов:
 *
 * ```typescript
 * // QuantityService.add                    SignedQuantityService.add
 * const ctx = { quantity1: ..., quantity2: ... };   // ← одинаково
 * return wrapOp(SERVICE_NAME, 'add', ctx, () => {   // ← одинаково
 *   const sum = addDecimal(a.value(), b.value());   // ← одинаково
 *   return this.createFromDecimal(sum);             // ← одинаково
 * }, InvalidQuantityError);                         // ← только тип ошибки
 * ```
 *
 * Ключи контекста (`quantity1`, `quantity2`, `factor`, `divisor`,
 * `stepSize`, `rate`, `roundingMode`) сохранены ДОСЛОВНО: на них держатся
 * тесты потребителей, и смена ключа была бы молчаливой сменой контракта.
 *
 * Доменное остаётся в домене: `abs`, `negate`, `scale`, `adjustBy` есть
 * только у знаковой величины, а запрет отрицательного результата у
 * `subtract` — только у `Quantity`, поэтому передаётся параметром.
 */
import { Result, Err, isErr } from '@polymarket/result';
import type { AnyTradingError } from '@polymarket/errors';
import { rewrap, toDecimal, wrapOp } from '@polymarket/errors';
import { addDecimal, divideDecimal, multiplyDecimal, roundToTick, subtractDecimal } from '@polymarket/math';
import Decimal from 'decimal.js';
import type { DecimalValue } from './DecimalValue.js';
import type { ScalarDomain } from './scalarDomain.js';

/** Контекст ошибки: произвольные строковые поля диагностики. */
type OpContext = Record<string, string>;

/**
 * Разбирает внешний операнд в `Decimal`, оборачивая отказ в ошибку домена.
 *
 * @param domain - Описание домена
 * @param field - Имя поля для диагностики (`'factor'`, `'divisor'`, `'stepSize'`)
 * @param opName - Имя операции для `context.op`
 * @param raw - Значение от вызывающего
 * @param context - Контекст ошибки
 * @returns `Decimal` либо ошибку домена
 */
function parseOperand<TValue extends DecimalValue, TError extends AnyTradingError>(
  domain: ScalarDomain<TValue, TError>,
  field: string,
  opName: string,
  raw: number | string | Decimal,
  context: OpContext,
): Result<Decimal, TError> {
  const parsed = toDecimal(field, raw, domain.invalidFormatReason, domain.ErrorConstructor, {
    nanReason: domain.nanReason,
    nonFiniteReason: domain.nonFiniteReason,
  });
  if (isErr(parsed)) {
    return Err(rewrap(domain.serviceName, opName, context, parsed.error, domain.ErrorConstructor));
  }
  return parsed;
}

/**
 * Переводит отказ правила в ошибку домена.
 *
 * @remarks
 * Правила общие и возвращают собственный тип ошибки; `rewrap` приводит его
 * к доменному, сохраняя причину. Приведение изолировано здесь, чтобы не
 * расползаться по операциям.
 */
function ruleErrorToDomain<TValue extends DecimalValue, TError extends AnyTradingError>(
  domain: ScalarDomain<TValue, TError>,
  opName: string,
  context: OpContext,
  error: AnyTradingError,
): TError {
  return rewrap(domain.serviceName, opName, context, error, domain.ErrorConstructor) as TError;
}

/**
 * Складывает две величины.
 *
 * @param domain - Описание домена
 * @param a - Первое слагаемое
 * @param b - Второе слагаемое
 * @returns Сумма как величина домена либо ошибка домена
 * @throws Никогда — все ошибки в `Result`
 *
 * @example
 * ```typescript
 * addScalars(QUANTITY_DOMAIN, qty1, qty2); // Ok(Quantity)
 * ```
 */
export function addScalars<TValue extends DecimalValue, TError extends AnyTradingError>(
  domain: ScalarDomain<TValue, TError>,
  a: TValue,
  b: TValue,
): Result<TValue, TError> {
  const context: OpContext = {
    quantity1: a.value().toString(),
    quantity2: b.value().toString(),
  };
  return wrapOp(
    domain.serviceName,
    'add',
    context,
    () => domain.create(addDecimal(a.value(), b.value())),
    domain.ErrorConstructor,
  );
}

/**
 * Вычитает одну величину из другой.
 *
 * @param domain - Описание домена
 * @param a - Уменьшаемое
 * @param b - Вычитаемое
 * @param checkResult - Необязательная доменная проверка результата
 * @returns Разность как величина домена либо ошибка домена
 * @throws Никогда — все ошибки в `Result`
 *
 * @remarks
 * `checkResult` существует ради `Quantity`: у неё разность не имеет права
 * уйти в отрицательные, а у `SignedQuantity` имеет. Это ЕДИНСТВЕННОЕ
 * место, где два домена расходятся в арифметике.
 *
 * @example
 * ```typescript
 * subtractScalars(QUANTITY_DOMAIN, a, b, ValidateResultNonNegative.check);
 * subtractScalars(SIGNED_DOMAIN, a, b); // знак допустим
 * ```
 */
export function subtractScalars<TValue extends DecimalValue, TError extends AnyTradingError>(
  domain: ScalarDomain<TValue, TError>,
  a: TValue,
  b: TValue,
  checkResult?: (diff: Decimal) => Result<unknown, AnyTradingError>,
): Result<TValue, TError> {
  const context: OpContext = {
    quantity1: a.value().toString(),
    quantity2: b.value().toString(),
  };
  return wrapOp(
    domain.serviceName,
    'subtract',
    context,
    () => {
      const diff = subtractDecimal(a.value(), b.value());
      if (checkResult !== undefined) {
        const checked = checkResult(diff);
        if (isErr(checked)) {
          return Err(checked.error as TError);
        }
      }
      return domain.create(diff);
    },
    domain.ErrorConstructor,
  );
}

/**
 * Умножает величину на множитель.
 *
 * @param domain - Описание домена
 * @param value - Исходная величина
 * @param factor - Множитель: число, строка или `Decimal`
 * @returns Произведение как величина домена либо ошибка домена
 * @throws Никогда — все ошибки в `Result`
 *
 * @example
 * ```typescript
 * multiplyScalar(QUANTITY_DOMAIN, qty, '2.5');
 * ```
 */
export function multiplyScalar<TValue extends DecimalValue, TError extends AnyTradingError>(
  domain: ScalarDomain<TValue, TError>,
  value: TValue,
  factor: number | string | Decimal,
): Result<TValue, TError> {
  const rawContext: OpContext = {
    quantity: value.value().toString(),
    factor: String(factor),
  };
  const parsed = parseOperand(domain, 'factor', 'multiply', factor, rawContext);
  if (isErr(parsed)) {
    return parsed;
  }

  const context: OpContext = {
    quantity: value.value().toString(),
    factor: parsed.value.toString(),
  };
  const validated = domain.validateFactor(parsed.value);
  if (isErr(validated)) {
    return Err(ruleErrorToDomain(domain, 'multiply', context, validated.error));
  }

  return wrapOp(
    domain.serviceName,
    'multiply',
    context,
    () => domain.create(multiplyDecimal(value.value(), parsed.value)),
    domain.ErrorConstructor,
  );
}

/**
 * Делит величину на делитель.
 *
 * @param domain - Описание домена
 * @param value - Делимое
 * @param divisor - Делитель: число, строка или `Decimal`
 * @returns Частное как величина домена либо ошибка домена
 * @throws Никогда — все ошибки в `Result`
 *
 * @example
 * ```typescript
 * divideScalar(QUANTITY_DOMAIN, qty, 2);  // Ok
 * divideScalar(QUANTITY_DOMAIN, qty, 0);  // Err: is_zero
 * ```
 */
export function divideScalar<TValue extends DecimalValue, TError extends AnyTradingError>(
  domain: ScalarDomain<TValue, TError>,
  value: TValue,
  divisor: number | string | Decimal,
): Result<TValue, TError> {
  const rawContext: OpContext = {
    quantity: value.value().toString(),
    divisor: String(divisor),
  };
  const parsed = parseOperand(domain, 'divisor', 'divide', divisor, rawContext);
  if (isErr(parsed)) {
    return parsed;
  }

  const context: OpContext = {
    quantity: value.value().toString(),
    divisor: parsed.value.toString(),
  };
  const validated = domain.validateDivisor(parsed.value);
  if (isErr(validated)) {
    return Err(ruleErrorToDomain(domain, 'divide', context, validated.error));
  }

  return wrapOp(
    domain.serviceName,
    'divide',
    context,
    () => domain.create(divideDecimal(value.value(), parsed.value)),
    domain.ErrorConstructor,
  );
}

/**
 * Берёт долю от величины.
 *
 * @param domain - Описание домена
 * @param value - Исходная величина
 * @param rate - Доля как `Decimal` (уже проверенная `Ratio`)
 * @returns Доля как величина домена либо ошибка домена
 * @throws Никогда — все ошибки в `Result`
 *
 * @remarks
 * `rate` приходит уже `Decimal`, а не `Ratio`: тип `Ratio` — доменный, и
 * тянуть его сюда значило бы связать общий модуль с конкретным VO.
 * Проверку доли делает вызывающий, у которого `Ratio` на руках.
 *
 * @example
 * ```typescript
 * portionOfScalar(QUANTITY_DOMAIN, qty, ratio.toDecimal());
 * ```
 */
export function portionOfScalar<TValue extends DecimalValue, TError extends AnyTradingError>(
  domain: ScalarDomain<TValue, TError>,
  value: TValue,
  rate: Decimal,
): Result<TValue, TError> {
  const context: OpContext = {
    quantity: value.value().toString(),
    rate: rate.toString(),
  };
  return wrapOp(
    domain.serviceName,
    'portion',
    context,
    () => domain.create(multiplyDecimal(value.value(), rate)),
    domain.ErrorConstructor,
  );
}

/**
 * Округляет величину до шага дискретной сетки.
 *
 * @param domain - Описание домена
 * @param value - Исходная величина
 * @param stepSize - Шаг: число, строка или `Decimal`
 * @param roundingMode - Режим округления `Decimal`
 * @returns Округлённая величина либо ошибка домена
 * @throws Никогда — все ошибки в `Result`
 *
 * @example
 * ```typescript
 * roundScalarToStep(QUANTITY_DOMAIN, qty, '0.01');
 * roundScalarToStep(QUANTITY_DOMAIN, qty, 0);    // Err: шаг не положителен
 * ```
 */
export function roundScalarToStep<TValue extends DecimalValue, TError extends AnyTradingError>(
  domain: ScalarDomain<TValue, TError>,
  value: TValue,
  stepSize: number | string | Decimal,
  roundingMode: Decimal.Rounding = Decimal.ROUND_HALF_UP,
): Result<TValue, TError> {
  const rawContext: OpContext = {
    quantity: value.value().toString(),
    stepSize: String(stepSize),
  };
  const parsed = parseOperand(domain, 'stepSize', 'roundToStep', stepSize, rawContext);
  if (isErr(parsed)) {
    return parsed;
  }

  const stepContext: OpContext = {
    quantity: value.value().toString(),
    stepSize: parsed.value.toString(),
  };
  const validated = domain.validateStep(parsed.value);
  if (isErr(validated)) {
    return Err(ruleErrorToDomain(domain, 'roundToStep', stepContext, validated.error));
  }

  const context: OpContext = {
    ...stepContext,
    roundingMode: String(roundingMode),
  };
  return wrapOp(
    domain.serviceName,
    'roundToStep',
    context,
    () => domain.create(roundToTick(value.value(), parsed.value, roundingMode)),
    domain.ErrorConstructor,
  );
}
