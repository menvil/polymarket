import Decimal from 'decimal.js';
import {
  InvalidOperandError,
  InvalidDecimalPlacesError,
  InvalidRoundingModeError,
  InvalidTickSizeError,
  ArithmeticOverflowError,
} from '@polymarket/errors';

/**
 * Максимально допустимое количество десятичных знаков
 *
 * @remarks
 * Ограничение Decimal.js для toDecimalPlaces().
 */
export const MAX_DECIMAL_PLACES = 1e9;

/**
 * Минимальный допустимый режим округления Decimal.js
 */
export const MIN_ROUNDING_MODE = 0;

/**
 * Максимальный допустимый режим округления Decimal.js
 */
export const MAX_ROUNDING_MODE = 8;

/**
 * Единый формат контекста для математических операций
 */
export interface MathOperationContext {
  operation: string;
  [key: string]: unknown;
}

/**
 * Проверяет, что значение является конечным числом
 *
 * @param value - Decimal значение для проверки
 * @param paramName - Имя параметра для сообщения об ошибке
 * @param context - Контекст операции
 * @throws {InvalidOperandError} Если значение не конечно
 *
 * @remarks
 * Используется для валидации всех входных операндов математических операций.
 *
 * @example
 * ```typescript
 * assertFiniteOperand(a, 'a', { operation: 'add', a: a.toString(), b: b.toString() });
 * ```
 */
export function assertFiniteOperand(
  value: Decimal,
  paramName: string,
  context: MathOperationContext
): void {
  // Проверка на undefined/null перед вызовом методов
  if (!value || typeof value.isFinite !== 'function') {
    throw new InvalidOperandError(
      (ctx) => `${ctx.paramName} must be a valid Decimal, got ${ctx.value}`,
      {
        context: {
          ...context,
          paramName,
          value: String(value),
        },
      }
    );
  }

  if (!value.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `${ctx.paramName} must be finite, got ${ctx.value}`,
      {
        context: {
          ...context,
          paramName,
          value: value.toString(),
        },
      }
    );
  }
}

/**
 * Проверяет, что оба операнда являются конечными числами
 *
 * @param a - Первый операнд
 * @param b - Второй операнд
 * @param context - Контекст операции
 * @throws {InvalidOperandError} Если любой из операндов не конечен
 *
 * @remarks
 * Удобная функция для бинарных операций (add, subtract, multiply, divide, etc).
 * Использует единый формат context с ключами 'a' и 'b'.
 *
 * @example
 * ```typescript
 * assertFiniteOperands(a, b, { operation: 'add', a: a.toString(), b: b.toString() });
 * ```
 */
export function assertFiniteOperands(
  a: Decimal,
  b: Decimal,
  context: MathOperationContext
): void {
  // Проверка на undefined/null перед вызовом методов
  if (!a || typeof a.isFinite !== 'function') {
    throw new InvalidOperandError(
      (ctx) => `Operand 'a' must be a valid Decimal, got ${ctx.a}`,
      { context }
    );
  }

  if (!b || typeof b.isFinite !== 'function') {
    throw new InvalidOperandError(
      (ctx) => `Operand 'b' must be a valid Decimal, got ${ctx.b}`,
      { context }
    );
  }

  if (!a.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `Operand 'a' must be finite, got ${ctx.a}`,
      { context }
    );
  }

  if (!b.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `Operand 'b' must be finite, got ${ctx.b}`,
      { context }
    );
  }
}

/**
 * Проверяет, что количество десятичных знаков валидно
 *
 * @param decimalPlaces - Количество десятичных знаков
 * @param context - Контекст операции
 * @throws {InvalidDecimalPlacesError} Если decimalPlaces невалидно
 *
 * @remarks
 * Проверяет:
 * - Конечность (isFinite)
 * - Целочисленность (isInteger)
 * - Неотрицательность (>= 0)
 * - Максимум (<=  1e9)
 *
 * @example
 * ```typescript
 * assertValidDecimalPlaces(2, {
 *   operation: 'roundToPrecision',
 *   value: '10.567',
 *   decimalPlaces: '2'
 * });
 * ```
 */
export function assertValidDecimalPlaces(
  decimalPlaces: number,
  context: MathOperationContext
): void {
  if (!Number.isFinite(decimalPlaces)) {
    throw new InvalidDecimalPlacesError(
      (ctx) => `Decimal places must be a finite number, got ${ctx.decimalPlaces}`,
      { context }
    );
  }

  if (!Number.isInteger(decimalPlaces)) {
    throw new InvalidDecimalPlacesError(
      (ctx) => `Decimal places must be an integer, got ${ctx.decimalPlaces}`,
      { context }
    );
  }

  if (decimalPlaces < 0) {
    throw new InvalidDecimalPlacesError(
      (ctx) => `Decimal places must be non-negative, got ${ctx.decimalPlaces}`,
      { context }
    );
  }

  if (decimalPlaces > MAX_DECIMAL_PLACES) {
    throw new InvalidDecimalPlacesError(
      (ctx) =>
        `Decimal places must not exceed ${ctx.max}, got ${ctx.decimalPlaces}`,
      { context: { ...context, max: String(MAX_DECIMAL_PLACES) } }
    );
  }
}

/**
 * Проверяет, что режим округления валиден
 *
 * @param roundingMode - Режим округления Decimal.js
 * @param context - Контекст операции
 * @throws {InvalidRoundingModeError} Если roundingMode невалиден
 *
 * @remarks
 * Проверяет:
 * - Целочисленность (isInteger)
 * - Диапазон [0, 8]
 *
 * @example
 * ```typescript
 * assertValidRoundingMode(Decimal.ROUND_HALF_UP, {
 *   operation: 'roundToPrecision',
 *   roundingMode: '4'
 * });
 * ```
 */
export function assertValidRoundingMode(
  roundingMode: Decimal.Rounding,
  context: MathOperationContext
): void {
  if (!Number.isInteger(roundingMode)) {
    throw new InvalidRoundingModeError(
      (ctx) => `Rounding mode must be an integer, got ${ctx.roundingMode}`,
      { context }
    );
  }

  if (roundingMode < MIN_ROUNDING_MODE || roundingMode > MAX_ROUNDING_MODE) {
    throw new InvalidRoundingModeError(
      (ctx) =>
        `Rounding mode must be between ${ctx.min} and ${ctx.max}, got ${ctx.roundingMode}`,
      {
        context: {
          ...context,
          min: String(MIN_ROUNDING_MODE),
          max: String(MAX_ROUNDING_MODE),
        },
      }
    );
  }
}

/**
 * Проверяет, что tick size валиден
 *
 * @param tickSize - Размер тика
 * @param context - Контекст операции
 * @throws {InvalidTickSizeError} Если tickSize невалиден
 *
 * @remarks
 * Проверяет:
 * - Конечность (isFinite)
 * - Строго положительное значение (> 0, не включая 0)
 *
 * @example
 * ```typescript
 * assertValidTickSize(new Decimal('0.01'), {
 *   operation: 'roundToTick',
 *   value: '10.567',
 *   tickSize: '0.01'
 * });
 * ```
 */
export function assertValidTickSize(
  tickSize: Decimal,
  context: MathOperationContext
): void {
  // Проверка на undefined/null перед вызовом методов
  if (!tickSize || typeof tickSize.isFinite !== 'function') {
    throw new InvalidTickSizeError(
      (ctx) => `Tick size must be a valid Decimal, got ${ctx.tickSize}`,
      { context }
    );
  }

  if (!tickSize.isFinite()) {
    throw new InvalidTickSizeError(
      (ctx) => `Tick size must be finite, got ${ctx.tickSize}`,
      { context }
    );
  }

  if (tickSize.lte(0)) {
    throw new InvalidTickSizeError(
      (ctx) => `Tick size must be positive, got ${ctx.tickSize}`,
      { context }
    );
  }
}

/**
 * Проверяет, что результат операции конечен
 *
 * @param result - Результат операции
 * @param context - Контекст операции
 * @throws {ArithmeticOverflowError} Если результат не конечен
 *
 * @remarks
 * Используется для проверки результатов всех арифметических операций.
 *
 * @example
 * ```typescript
 * const result = a.plus(b);
 * assertFiniteResult(result, {
 *   operation: 'add',
 *   a: a.toString(),
 *   b: b.toString(),
 *   result: result.toString()
 * });
 * ```
 */
export function assertFiniteResult(
  result: Decimal,
  context: MathOperationContext
): void {
  if (!result.isFinite()) {
    throw new ArithmeticOverflowError(
      (ctx) => `${ctx.operation} resulted in non-finite value: ${ctx.result}`,
      { context }
    );
  }
}
