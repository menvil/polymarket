import Decimal from 'decimal.js';
import {
  InvalidOperandError,
  InvalidDecimalPlacesError,
  InvalidRoundingModeError,
  InvalidTickSizeError,
  ArithmeticOverflowError,
  InvalidDivisorError,
  DivisionByZeroError,
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
 * Минимальный контракт Decimal-подобного объекта
 *
 * @remarks
 * Используется для duck-typing при проверке операндов.
 * Позволяет работать с разными копиями decimal.js (кросс-контекстная совместимость).
 */
export interface DecimalLike {
  isFinite(): boolean;
  toString(): string;
  toNumber(): number;
}

/**
 * Контракт делителя — расширяет DecimalLike методом isZero
 *
 * @remarks
 * Необходим для assertNonZeroDivisor, чтобы безопасно проверить b === 0.
 */
export interface DivisorLike extends DecimalLike {
  isZero(): boolean;
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
  if (value !== null && value !== undefined && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.toString === 'function') {
      try {
        const result = (obj as { toString(): unknown }).toString();
        if (typeof result === 'string') {
          return result;
        }
      } catch {
        // toString() бросает — используем Object.prototype.toString
        // для безопасного fallback без повторного вызова переопределённого toString()
        return Object.prototype.toString.call(value);
      }
    }
    return Object.prototype.toString.call(value);
  }
  return String(value);
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
 * Проверяет, является ли значение Decimal-подобным объектом
 *
 * @param value - Значение для проверки
 * @returns true если объект соответствует контракту DecimalLike
 *
 * @remarks
 * Использует комбинированный подход:
 * 1. Fast path: instanceof Decimal (для стандартного случая одной копии библиотеки)
 * 2. Fallback: duck-typing для совместимости с разными копиями decimal.js
 *
 * Duck-typing проверяет наличие ключевых методов Decimal.js:
 * - isFinite() - проверка конечности
 * - toString() - сериализация
 * - toNumber() - конвертация в number
 *
 * @example
 * ```typescript
 * // Работает с любой копией Decimal
 * const d1 = new Decimal('1.5');  // копия A
 * isDecimalLike(d1); // true (fast path - instanceof)
 * isDecimalLike(null); // false
 * ```
 */
function isDecimalLike(value: unknown): value is DecimalLike {
  // Fast path: instanceof для стандартного случая
  if (value instanceof Decimal) {
    return true;
  }

  // Fallback: duck-typing для кросс-контекстных Decimal объектов
  if (value === null || value === undefined || typeof value !== 'object') {
    return false;
  }

  const obj = value as Record<string, unknown>;
  return (
    typeof obj.isFinite === 'function' &&
    typeof obj.toString === 'function' &&
    typeof obj.toNumber === 'function'
  );
}

/**
 * Проверяет, что значение является конечным числом (generic версия)
 *
 * @param value - Значение для проверки (принимает unknown для runtime валидации)
 * @param paramName - Имя параметра для сообщения об ошибке
 * @param context - Контекст операции
 * @param ErrorCtor - Конструктор ошибки для создания исключения
 * @throws {TError} Если значение не является Decimal-like или не конечно
 *
 * @remarks
 * Generic функция позволяет использовать разные типы ошибок для одной и той же валидации.
 * Принимает unknown и суживает тип до DecimalLike через type assertion.
 *
 * Порядок проверок:
 * 1. isDecimalLike — проверяет duck-typing (isFinite, toString, toNumber)
 * 2. isFinite() — проверяет конечность значения
 *
 * @example
 * ```typescript
 * // Валидация обычного операнда
 * assertFiniteOperandWith(a, 'a', context, InvalidOperandError);
 *
 * // Валидация делителя с другим типом ошибки
 * assertFiniteOperandWith(b, 'b', context, InvalidDivisorError);
 * ```
 */
export function assertFiniteOperandWith<TError>(
  value: unknown,
  paramName: string,
  context: MathOperationContext,
  ErrorCtor: ErrorConstructor<TError>
): asserts value is DecimalLike {
  // Проверка на undefined/null и Decimal-подобный объект (duck-typing)
  if (!isDecimalLike(value)) {
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
 * @param value - Значение для проверки
 * @param paramName - Имя параметра для сообщения об ошибке
 * @param context - Контекст операции
 * @throws {InvalidOperandError} Если значение не является Decimal-like или не конечно
 *
 * @remarks
 * Обёртка над assertFiniteOperandWith с фиксированным типом ошибки InvalidOperandError.
 *
 * @example
 * ```typescript
 * assertFiniteOperand(a, 'a', { operation: 'add', a: a.toString(), b: b.toString() });
 * ```
 */
export function assertFiniteOperand(
  value: unknown,
  paramName: string,
  context: MathOperationContext
): asserts value is DecimalLike {
  assertFiniteOperandWith(value, paramName, context, InvalidOperandError);
}

/**
 * Проверяет, что оба операнда являются конечными числами
 *
 * @param a - Первый операнд
 * @param b - Второй операнд
 * @param context - Контекст операции
 * @throws {InvalidOperandError} Если любой из операндов не является Decimal-like или не конечен
 *
 * @remarks
 * Удобная функция для бинарных операций (add, subtract, multiply, divide, etc).
 * Формирует fullContext с a/b из реальных значений, не доверяя внешнему context.
 * Переиспользует assertFiniteOperandWith для обоих операндов — нет дублирования логики.
 *
 * @example
 * ```typescript
 * const context = { operation: 'add', a: toStringSafe(a), b: toStringSafe(b) };
 * assertFiniteOperands(a, b, context);
 * ```
 */
export function assertFiniteOperands(
  a: unknown,
  b: unknown,
  context: MathOperationContext
): void {
  // Формируем a/b из реальных параметров, не доверяя context
  const fullContext = {
    ...context,
    a: toStringSafe(a),
    b: toStringSafe(b),
  };

  assertFiniteOperandWith(a, 'a', fullContext, InvalidOperandError);
  assertFiniteOperandWith(b, 'b', fullContext, InvalidOperandError);
}

/**
 * Проверяет, что делитель является конечным ненулевым числом
 *
 * @param divisor - Делитель для проверки (принимает unknown для runtime валидации)
 * @param context - Контекст операции
 * @throws {InvalidDivisorError} Если делитель не является Decimal-like, не конечен или не имеет isZero
 * @throws {DivisionByZeroError} Если делитель равен нулю
 *
 * @remarks
 * Централизует все проверки делителя, исключая их дублирование в операциях деления.
 *
 * Порядок проверок:
 * 1. assertFiniteOperandWith — проверяет duck-typing и конечность (с InvalidDivisorError)
 * 2. Проверка наличия метода isZero (duck-typing для DivisorLike контракта)
 * 3. isZero() === true → DivisionByZeroError
 *
 * @example
 * ```typescript
 * const context = { operation: 'divide', a: toStringSafe(a), b: toStringSafe(b) };
 * assertNonZeroDivisor(b, context);
 * // После вызова b гарантированно является DivisorLike (конечный, ненулевой)
 * ```
 */
export function assertNonZeroDivisor(
  divisor: unknown,
  context: MathOperationContext
): asserts divisor is DivisorLike {
  // 1. Проверяем что делитель — конечный Decimal-like объект
  assertFiniteOperandWith(divisor, 'b', context, InvalidDivisorError);

  // 2. Проверяем наличие isZero — специфично для делителя
  const obj = divisor as unknown as Record<string, unknown>;
  if (typeof obj.isZero !== 'function') {
    throw new InvalidDivisorError(
      (ctx) => `Operand 'b' (divisor) must have isZero method, got ${ctx.b}`,
      { context }
    );
  }

  // 3. Проверяем что делитель не равен нулю
  if ((divisor as DivisorLike).isZero()) {
    throw new DivisionByZeroError(
      (ctx) => `Cannot divide by zero (operand 'b' is ${ctx.b})`,
      { context }
    );
  }
}

/**
 * Создаёт контекст операции с добавленным результатом
 *
 * @param context - Базовый контекст операции
 * @param result - Результат операции (любой тип, сериализуется через toStringSafe)
 * @returns Новый контекст с полем result
 *
 * @remarks
 * Удобный helper для единообразного добавления result к контексту перед assertFiniteResult.
 * Исключает ручное { ...context, result: result.toString() } во всех операциях.
 *
 * @example
 * ```typescript
 * const result = a.plus(b);
 * assertFiniteResult(result, withResult(context, result));
 * ```
 */
export function withResult(
  context: MathOperationContext,
  result: unknown
): MathOperationContext {
  return { ...context, result: toStringSafe(result) };
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
 * - Наличие методов Decimal-like (duck-typing)
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
  // Проверка на undefined/null и Decimal-подобный объект (duck-typing)
  if (!isDecimalLike(tickSize)) {
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
  const obj = tickSize as unknown as Record<string, unknown>;
  if (typeof obj.lte !== 'function') {
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
 * @param context - Контекст операции (должен содержать result для сообщения об ошибке)
 * @throws {ArithmeticOverflowError} Если результат не конечен
 *
 * @remarks
 * Используется для проверки результатов всех арифметических операций.
 * Контекст формируется через withResult() для единообразия.
 *
 * @example
 * ```typescript
 * const result = a.plus(b);
 * assertFiniteResult(result, withResult(context, result));
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
