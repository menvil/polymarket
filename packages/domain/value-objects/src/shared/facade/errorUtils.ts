import { Result, Ok, Err, isErr } from '@polymarket/result';
import Decimal from 'decimal.js';
import {
  InvalidMoneyError,
  InvalidPriceError,
  InvalidQuantityError,
  InvalidPercentageError,
  InvalidQuoteError,
  ArithmeticOverflowError,
  InvalidOperandError,
  DivisionByZeroError
} from '@polymarket/errors';
import { ErrorSource } from './ErrorSource.js';

/**
 * Utility functions для обработки ошибок в Facade сервисах
 *
 * @remarks
 * Устраняет дублирование ~390 строк кода между MoneyService, PriceService, QuantityService, BalanceService, QuoteService.
 *
 * Этот модуль содержит pure functions для:
 * - Извлечения cause из ошибок
 * - Парсинга Decimal значений
 * - Создания и wrapping ошибок
 * - Централизованной обработки исключений
 *
 * @example
 * ```typescript
 * import { toDecimal, wrapOp } from '../../shared/facade/errorUtils';
 * import { MoneyErrorReason } from '../errors/MoneyErrorReason';
 *
 * const result = toDecimal(
 *   'value',
 *   inputValue,
 *   MoneyErrorReason.INVALID_FORMAT,
 *   InvalidMoneyError
 * );
 * ```
 */

/**
 * Тип Domain Error для параметризации функций
 */
export type DomainError =
  | InvalidMoneyError
  | InvalidPriceError
  | InvalidQuantityError
  | InvalidPercentageError
  | InvalidQuoteError;

/**
 * Конструктор Domain Error
 */
export type ErrorConstructor<TError extends DomainError> = new (
  message: string | ((context: Record<string, unknown>) => string),
  options?: { code?: string; context?: Record<string, unknown> }
) => TError;

/**
 * Извлекает структурированный cause из любой ошибки
 *
 * @param e - Ошибка (Error или unknown)
 * @returns Структурированный объект cause
 *
 * @remarks
 * - Если e instanceof Error → { name, message, stack }
 * - Иначе → { name: 'UnknownError', message: String(e) }
 *
 * Используется во всех методах создания ошибок для сохранения root-cause.
 *
 * @example
 * ```typescript
 * try {
 *   // ...
 * } catch (e) {
 *   const cause = toCause(e);
 *   // { name: 'TypeError', message: '...', stack: '...' }
 * }
 * ```
 */
export function toCause(e: unknown): { name: string; message: string; stack?: string } {
  if (e instanceof Error) {
    return {
      name: e.name,
      message: e.message,
      stack: e.stack
    };
  }

  return {
    name: 'UnknownError',
    message: String(e)
  };
}

/**
 * Безопасно конвертирует number | string | Decimal в Decimal
 *
 * @param field - Имя поля (для структурированного raw)
 * @param input - Входное значение
 * @param reasonEnum - Enum значение для INVALID_FORMAT (напр. MoneyErrorReason.INVALID_FORMAT)
 * @param ErrorConstructor - Конструктор ошибки (InvalidMoneyError / InvalidPriceError / InvalidQuantityError)
 * @returns Result<Decimal, TError>
 *
 * @remarks
 * Нормализует вход и корректно работает с двумя копиями decimal.js:
 * - Primitives (number, string) парсим напрямую
 * - Объекты (Decimal из другой копии) → toString() → парсим
 *
 * При ошибке парсинга → TError с raw: { field, value } и cause.
 *
 * Не добавляет op в контекст - внешний код добавит через rewrap.
 *
 * @example
 * ```typescript
 * const result = toDecimal('value', '123.45', MoneyErrorReason.INVALID_FORMAT, InvalidMoneyError);
 * if (result.ok) {
 *   console.log(result.value); // Decimal(123.45)
 * }
 * ```
 */
export function toDecimal<TError extends DomainError>(
  field: string,
  input: number | string | Decimal,
  reasonEnum: string,
  ErrorConstructor: ErrorConstructor<TError>
): Result<Decimal, TError> {
  try {
    // Не пытаемся "распознать" Decimal из другой копии.
    // Нормализуем: primitives парсим напрямую, объекты — через toString().
    let normalized: number | string | undefined;

    if (typeof input === 'number' || typeof input === 'string') {
      normalized = input;
    } else {
      // input это Decimal (возможно из другой копии decimal.js)
      // Безопасно извлекаем toString если он есть
      const obj = input as unknown as { toString?: unknown };
      normalized = typeof obj.toString === 'function' ? obj.toString() : undefined;
    }

    if (normalized === undefined) {
      return Err(
        new ErrorConstructor('Failed to normalize value: no valid toString()', {
          context: {
            source: ErrorSource.PARSING,
            raw: { field, value: String(input) },
            reason: reasonEnum
          }
        })
      );
    }

    // normalized точно number | string после проверки выше
    const decimal = new Decimal(normalized);
    return Ok(decimal);
  } catch (error) {
    return Err(
      new ErrorConstructor(
        error instanceof Error ? error.message : 'Failed to parse value',
        {
          context: {
            source: ErrorSource.PARSING,
            raw: { field, value: String(input) },
            cause: toCause(error),
            reason: reasonEnum
          }
        }
      )
    );
  }
}

/**
 * Создаёт ошибку для ожидаемых ошибок из @polymarket/math
 *
 * @param op - Название операции
 * @param ctx - Контекст операции (amount, factor, divisor, etc.)
 * @param e - Ошибка из math layer (ТОЛЬКО Error объекты)
 * @param valueName - Название value object ('money', 'price', 'quantity')
 * @param ErrorConstructor - Конструктор ошибки
 * @returns TError с полным контекстом
 *
 * @remarks
 * Используется для обработки ожидаемых ошибок:
 * - InvalidOperandError
 * - ArithmeticOverflowError
 * - DivisionByZeroError
 *
 * ВАЖНО: Принимает только Error. Если это не Error - используй unexpectedError.
 */
export function expectedMathError<TError extends DomainError>(
  op: string,
  ctx: Record<string, unknown>,
  e: Error,
  valueName: string,
  ErrorConstructor: ErrorConstructor<TError>
): TError {
  const cause = toCause(e);
  return new ErrorConstructor(`${valueName} ${op} failed: ${cause.message}`, {
    context: {
      source: ErrorSource.MATH_OPERATION,
      op,
      ...ctx,
      cause
    }
  });
}

/**
 * Создаёт ошибку для неожиданных ошибок
 *
 * @param op - Название операции
 * @param ctx - Контекст операции
 * @param e - Неожиданная ошибка (any type)
 * @param valueName - Название value object ('money', 'price', 'quantity')
 * @param ErrorConstructor - Конструктор ошибки
 * @returns TError с полным контекстом
 *
 * @remarks
 * Используется когда происходит неожиданная ошибка (не из известных типов).
 * Включает полный stack trace для debugging.
 */
export function unexpectedError<TError extends DomainError>(
  op: string,
  ctx: Record<string, unknown>,
  e: unknown,
  valueName: string,
  ErrorConstructor: ErrorConstructor<TError>
): TError {
  const cause = toCause(e);
  return new ErrorConstructor(`Unexpected error during ${valueName} ${op}`, {
    context: {
      source: ErrorSource.UNEXPECTED,
      op,
      ...ctx,
      cause
    }
  });
}

/**
 * Проверяет является ли ошибка ожидаемой math-ошибкой
 *
 * @param e - Ошибка для проверки
 * @returns true если это ожидаемая math-ошибка (ArithmeticOverflowError, InvalidOperandError, DivisionByZeroError)
 *
 * @remarks
 * Используется в catch блоках для централизованной классификации ошибок.
 * Проверяет как instanceof, так и name для надёжности.
 *
 * **ВАЖНО: Список ожидаемых ошибок фиксирован.**
 * Если @polymarket/math добавит новые error types, они попадут в unexpected
 * до явного добавления сюда. Это осознанное решение для безопасности.
 *
 * Текущий whitelist:
 * - ArithmeticOverflowError - переполнение при арифметике
 * - InvalidOperandError - невалидный операнд (NaN, Infinity)
 * - DivisionByZeroError - деление на ноль
 */
export function isExpectedMathError(e: unknown): e is Error {
  return (
    e instanceof Error &&
    (e instanceof ArithmeticOverflowError ||
      e instanceof InvalidOperandError ||
      e instanceof DivisionByZeroError ||
      e.name === 'ArithmeticOverflowError' ||
      e.name === 'InvalidOperandError' ||
      e.name === 'DivisionByZeroError')
  );
}

/**
 * Оборачивает ошибку с добавлением op и контекста
 *
 * @param op - Название операции (станет верхним в opChain)
 * @param ctx - Дополнительный контекст для добавления (операционные поля: amount, factor, divisor, etc)
 * @param err - Исходная ошибка
 * @param ErrorConstructor - Конструктор ошибки
 * @returns Новая ошибка с объединённым контекстом
 *
 * @remarks
 * Простая перепаковка без рефлексии (никогда не бросает exception).
 *
 * Порядок мерджа:
 * 1. inner (err.context) - база из вложенной ошибки
 * 2. ctx - операционные поля (amount, factor, divisor) - перетирают inner
 * 3. op + opChain - строит цепочку операций, НЕ теряя внутренний op
 * 4. preserve root-полей: cause, reason, raw (первопричина не перетирается)
 *
 * **Root-cause semantics:**
 * - cause, reason, raw сохраняются из inner (это первопричина)
 * - opChain накапливает историю операций: [innerOp, ..., op]
 *
 * Это гарантирует:
 * - Операционный контекст (amount, factor) всегда актуален для текущего op
 * - Первопричина (cause, reason, raw) не теряется
 * - История операций сохраняется в opChain
 *
 * @example
 * ```typescript
 * const innerError = new InvalidMoneyError('Parse failed', {
 *   context: { reason: 'INVALID_FORMAT', raw: { field: 'value', value: 'abc' } }
 * });
 *
 * const wrappedError = rewrap('create', { currency: 'USDC' }, innerError, InvalidMoneyError);
 * // wrappedError.context = {
 * //   op: 'create',
 * //   opChain: ['create'],
 * //   currency: 'USDC',
 * //   reason: 'INVALID_FORMAT',  // сохранён из inner
 * //   raw: { field: 'value', value: 'abc' }  // сохранён из inner
 * // }
 * ```
 */
export function rewrap<TError extends DomainError>(
  op: string,
  ctx: Record<string, unknown>,
  err: TError,
  ErrorConstructor: ErrorConstructor<TError>
): TError {
  const inner = (err.context ?? {}) as Record<string, unknown>;

  // Запрещаем ctx приносить root-поля (защита от случайного перетирания)
  const { cause: _c, reason: _r, raw: _raw, source: _s, op: _op, opChain: _chain, ...safeCtx } = ctx;

  // 1) мерджим контекст: inner база, safeCtx сверху (без root-полей)
  const merged: Record<string, unknown> = {
    ...inner,
    ...safeCtx
  };

  // 2) opChain строим только тут (единственное место истины)
  const innerChain = Array.isArray(inner.opChain) ? inner.opChain : undefined;
  const filtered = (innerChain?.filter((x) => typeof x === 'string') as string[]) ?? [];
  const base = filtered.length > 0 ? filtered : (typeof inner.op === 'string' ? [inner.op] : []);

  merged.op = op;
  // Не добавляем op в opChain если он уже последний элемент (избегаем дублирования)
  const lastOp = base[base.length - 1];
  merged.opChain = lastOp === op ? base : [...base, op];

  // 3) root-поля сохраняем из inner, если они есть (не перетираются)
  if (inner.cause !== undefined) {
    merged.cause = inner.cause;
  }
  if (inner.reason !== undefined) {
    merged.reason = inner.reason;
  }
  if (inner.raw !== undefined) {
    merged.raw = inner.raw;
  }
  if (inner.source !== undefined) {
    merged.source = inner.source;
  }

  return new ErrorConstructor(err.message, { context: merged });
}

/**
 * Оборачивает facade операцию в try/catch с централизованной обработкой ошибок
 *
 * @param op - Название операции
 * @param ctx - Контекст операции
 * @param fn - Функция выполняющая операцию (может включать math, create, rules)
 * @param valueName - Название value object ('money', 'price', 'quantity')
 * @param ErrorConstructor - Конструктор ошибки
 * @returns Result с результатом или ошибкой
 *
 * @remarks
 * Устраняет дублирование try/catch блоков во всех операциях.
 * Автоматически классифицирует ошибки как expected/unexpected.
 * Автоматически rewrap'ает ошибки из Result.Err.
 *
 * Обрабатывает четыре типа ошибок/результатов:
 * 1. Result.Err(TError) (из create/rules) → rewrap с добавлением op
 * 2. throw TError (из вложенных операций) → rewrap с добавлением op
 * 3. Expected math errors (ArithmeticOverflowError, etc.) → expectedMathError
 * 4. Unexpected errors → unexpectedError
 *
 * @example
 * ```typescript
 * return wrapOp(
 *   'add',
 *   { a: a.amount().toString(), b: b.amount().toString() },
 *   () => {
 *     const sum = addDecimal(a.amount(), b.amount());
 *     return createFromDecimal(sum, a.currency(), 'add', {});
 *   },
 *   'money',
 *   InvalidMoneyError
 * );
 * ```
 */
export function wrapOp<T, TError extends DomainError>(
  op: string,
  ctx: Record<string, unknown>,
  fn: () => Result<T, TError>,
  valueName: string,
  ErrorConstructor: ErrorConstructor<TError>
): Result<T, TError> {
  try {
    const result = fn();
    // Если fn() вернул Err с TError - rewrap автоматически
    if (isErr(result)) {
      return Err(rewrap(op, ctx, result.error, ErrorConstructor));
    }
    return result;
  } catch (e) {
    // Если кто-то бросил Domain Error
    if (
      e instanceof InvalidMoneyError ||
      e instanceof InvalidPriceError ||
      e instanceof InvalidQuantityError ||
      e instanceof InvalidPercentageError ||
      e instanceof InvalidQuoteError
    ) {
      return Err(rewrap(op, ctx, e as TError, ErrorConstructor));
    }
    // Ожидаемые math ошибки - прогоняем через rewrap для opChain
    if (isExpectedMathError(e)) {
      return Err(rewrap(op, ctx, expectedMathError(op, ctx, e, valueName, ErrorConstructor), ErrorConstructor));
    }
    // Неожиданные ошибки - прогоняем через rewrap для opChain
    return Err(rewrap(op, ctx, unexpectedError(op, ctx, e, valueName, ErrorConstructor), ErrorConstructor));
  }
}

/**
 * Создаёт стандартизированную ошибку несовпадения валют
 *
 * @param op - Название операции ('isLessThan', 'equals', 'add', etc.)
 * @param expected - Ожидаемая валюта
 * @param actual - Фактическая валюта
 * @param reasonEnum - Enum значение для CURRENCY_MISMATCH (напр. MoneyErrorReason.CURRENCY_MISMATCH)
 * @param ErrorConstructor - Конструктор ошибки
 * @returns TError с стандартизированным контекстом
 *
 * @remarks
 * Стандартизирует создание ошибок несовпадения валют во всех Services.
 * Устраняет дублирование кода в comparison и math операциях.
 *
 * **Стандартный контекст:**
 * - op - название операции
 * - reason - CURRENCY_MISMATCH enum
 * - expected - ожидаемая валюта
 * - actual - фактическая валюта
 *
 * **Используется в:**
 * - MoneyService: isLessThan, equals, add, subtract, и т.д.
 * - BalanceService: equals, canAfford
 *
 * @example
 * ```typescript
 * // В MoneyService.isLessThan:
 * if (!a.hasSameCurrency(b)) {
 *   return Err(currencyMismatchError(
 *     'isLessThan',
 *     a.currency(),
 *     b.currency(),
 *     MoneyErrorReason.CURRENCY_MISMATCH,
 *     InvalidMoneyError
 *   ));
 * }
 *
 * // В BalanceService.equals:
 * if (!balance1.hasSameCurrency(balance2)) {
 *   return Err(currencyMismatchError(
 *     'equals',
 *     balance1.currency(),
 *     balance2.currency(),
 *     BalanceErrorReason.CURRENCY_MISMATCH,
 *     InvalidBalanceError
 *   ));
 * }
 * ```
 */
export function currencyMismatchError<TError extends DomainError>(
  op: string,
  expected: string,
  actual: string,
  reasonEnum: string,
  ErrorConstructor: ErrorConstructor<TError>
): TError {
  return new ErrorConstructor(`Cannot ${op}: currency mismatch`, {
    context: {
      op,
      reason: reasonEnum,
      expected,
      actual
    }
  });
}
