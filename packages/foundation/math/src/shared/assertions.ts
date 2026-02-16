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
 * Безопасно конвертирует значение в строку
 *
 * @param value - Значение для конвертации
 * @returns Строковое представление значения
 *
 * @remarks
 * Используется для безопасного формирования контекста ошибок.
 * Проверяет наличие метода toString перед вызовом.
 *
 * @example
 * ```typescript
 * const context = {
 *   operation: 'add',
 *   a: toStringSafe(a),
 *   b: toStringSafe(b)
 * };
 * ```
 */
export function toStringSafe(value: unknown): string {
  return value && typeof (value as any).toString === 'function'
    ? (value as any).toString()
    : String(value);
}

/**
 * Создаёт контекст для бинарных математических операций
 *
 * @param operation - Название операции (add, subtract, multiply, divide, compare, etc)
 * @param a - Первый операнд
 * @param b - Второй операнд
 * @returns Объект контекста с operation, a, b
 *
 * @remarks
 * Helper для устранения дублирования при создании context в бинарных операциях.
 * Используется для унификации формирования контекста в compare.ts и других файлах.
 *
 * @example
 * ```typescript
 * const context = createBinaryContext('equals', a, b);
 * // { operation: 'equals', a: '10', b: '20' }
 * ```
 */
export function createBinaryContext(
  operation: string,
  a: Decimal,
  b: Decimal
): MathOperationContext {
  return {
    operation,
    a: toStringSafe(a),
    b: toStringSafe(b),
  };
}

/**
 * Тип конструктора ошибки для assertion функций
 *
 * @remarks
 * Используется в generic assertions для создания ошибок нужного типа.
 */
export type ErrorConstructor<TError> = new (
  message: string | ((ctx: Record<string, unknown>) => string),
  options?: { code?: string; context?: Record<string, unknown> }
) => TError;

/**
 * Проверяет, что значение является конечным числом (generic версия)
 *
 * @param value - Decimal значение для проверки
 * @param paramName - Имя параметра для сообщения об ошибке
 * @param context - Контекст операции
 * @param ErrorCtor - Конструктор ошибки для создания исключения
 * @throws {TError} Если значение не конечно
 *
 * @remarks
 * Generic функция позволяет использовать разные типы ошибок для одной и той же валидации.
 * Например, для обычных операндов - InvalidOperandError, для делителя - InvalidDivisorError.
 *
 * @example
 * ```typescript
 * // Валидация обычного операнда
 * assertFiniteOperandWith(a, 'a', context, InvalidOperandError);
 *
 * // Валидация делителя
 * assertFiniteOperandWith(b, 'b', context, InvalidDivisorError);
 * ```
 */
export function assertFiniteOperandWith<TError>(
  value: Decimal,
  paramName: string,
  context: MathOperationContext,
  ErrorCtor: ErrorConstructor<TError>
): void {
  // Проверка на undefined/null и instanceof Decimal
  if (!(value instanceof Decimal)) {
    throw new ErrorCtor(
      (ctx) => `${ctx.paramName} must be a valid Decimal instance, got ${ctx.value}`,
      {
        context: {
          ...context,
          paramName,
          value: toStringSafe(value),
        },
      }
    );
  }

  if (!value.isFinite()) {
    throw new ErrorCtor(
      (ctx) => `${ctx.paramName} must be finite, got ${ctx.value}`,
      {
        context: {
          ...context,
          paramName,
          value: toStringSafe(value),
        },
      }
    );
  }
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
 * Обёртка над assertFiniteOperandWith с InvalidOperandError.
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
  assertFiniteOperandWith(value, paramName, context, InvalidOperandError);
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
 * Формирует a/b из реальных параметров, не доверяя внешнему context.
 *
 * @example
 * ```typescript
 * assertFiniteOperands(a, b, { operation: 'add' });
 * ```
 */
export function assertFiniteOperands(
  a: Decimal,
  b: Decimal,
  context: MathOperationContext
): void {
  // Формируем a/b из реальных параметров, не доверяя context
  const fullContext = {
    ...context,
    a: toStringSafe(a),
    b: toStringSafe(b),
  };

  // Проверка на undefined/null перед вызовом методов
  if (!a || typeof a.isFinite !== 'function') {
    throw new InvalidOperandError(
      (ctx) => `Operand 'a' must be a valid Decimal, got ${ctx.a}`,
      { context: fullContext }
    );
  }

  if (!b || typeof b.isFinite !== 'function') {
    throw new InvalidOperandError(
      (ctx) => `Operand 'b' must be a valid Decimal, got ${ctx.b}`,
      { context: fullContext }
    );
  }

  if (!a.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `Operand 'a' must be finite, got ${ctx.a}`,
      { context: fullContext }
    );
  }

  if (!b.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `Operand 'b' must be finite, got ${ctx.b}`,
      { context: fullContext }
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
  // Проверка на undefined/null и instanceof Decimal
  if (!(tickSize instanceof Decimal)) {
    throw new InvalidTickSizeError(
      (ctx) => `Tick size must be a valid Decimal instance, got ${ctx.tickSize}`,
      { context }
    );
  }

  if (!tickSize.isFinite()) {
    throw new InvalidTickSizeError(
      (ctx) => `Tick size must be finite, got ${ctx.tickSize}`,
      { context }
    );
  }

  // Defensive: проверяем наличие метода lte перед вызовом
  if (typeof (tickSize as any).lte !== 'function') {
    throw new InvalidTickSizeError(
      (ctx) => `Tick size must have lte method, got ${ctx.tickSize}`,
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
