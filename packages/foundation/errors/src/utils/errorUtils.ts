import { Result, Ok, Err, isErr } from '@polymarket/result';
import Decimal from 'decimal.js';
import { TradingError } from '../base/TradingError.js';
import { InvalidAssetQuantityError } from '../value-objects/InvalidAssetQuantityError.js';
import { InvalidMoneyError } from '../value-objects/InvalidMoneyError.js';
import { InvalidOutcomeTokenError } from '../value-objects/InvalidOutcomeTokenError.js';
import { InvalidPercentageError } from '../value-objects/InvalidPercentageError.js';
import { InvalidPriceError } from '../value-objects/InvalidPriceError.js';
import { InvalidQuantityError } from '../value-objects/InvalidQuantityError.js';
import { InvalidQuoteError } from '../value-objects/InvalidQuoteError.js';
import { InvalidRatioError } from '../value-objects/InvalidRatioError.js';
import { InvalidAmountError } from '../value-objects/InvalidAmountError.js';
import { InvalidBalanceError } from '../value-objects/InvalidBalanceError.js';
import { CurrencyMismatchError } from '../value-objects/CurrencyMismatchError.js';
import { InvalidSpreadError } from '../value-objects/InvalidSpreadError.js';
import { ArithmeticOverflowError } from '../value-objects/ArithmeticOverflowError.js';
import { DivisionByZeroError } from '../value-objects/DivisionByZeroError.js';
import { InvalidOperandError } from '../math/InvalidOperandError.js';
import { InvalidRoundingModeError } from '../math/InvalidRoundingModeError.js';
import { ErrorSource } from '../ErrorSource.js';

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
 * import { toDecimal, wrapOp } from '@polymarket/errors';
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
 *
 * @remarks
 * Включает ВСЕ value object ошибки, которые могут возникнуть в Facade services.
 * wrapOp() обрабатывает любой TradingError, но этот union обеспечивает типобезопасность
 * для конкретных Service методов.
 *
 * Категории ошибок:
 * - Валидация диапазонов: Price, Quantity, Percentage, Ratio, Amount
 * - Денежные значения: Money, Balance, CurrencyMismatch
 * - Торговые объекты: AssetQuantity, Spread, Quote, OutcomeToken
 * - Математические операции: DivisionByZero, ArithmeticOverflow
 */
export type DomainError =
  // Валидация диапазонов
  | InvalidPriceError
  | InvalidQuantityError
  | InvalidPercentageError
  | InvalidRatioError
  | InvalidAmountError
  // Денежные значения
  | InvalidMoneyError
  | InvalidBalanceError
  | CurrencyMismatchError
  // Торговые объекты
  | InvalidAssetQuantityError
  | InvalidSpreadError
  | InvalidQuoteError
  | InvalidOutcomeTokenError
  // Математические операции
  | DivisionByZeroError
  | ArithmeticOverflowError
  | InvalidOperandError
  | InvalidRoundingModeError;

/**
 * Конструктор Domain Error
 */
export type ErrorConstructor<TError extends DomainError> = new (
  message: string | ((context: Record<string, unknown>) => string),
  options?: { code?: string; context?: Record<string, unknown> }
) => TError;

/**
 * Безопасно конвертирует значение в строку с fallback
 *
 * @param value - Значение для конвертации
 * @returns Строковое представление или "[unserializable input]"
 *
 * @remarks
 * Защищает от "плохих" объектов с toString(), который:
 * - Выбрасывает исключение
 * - Возвращает не-строку
 * - Отсутствует
 *
 * @example
 * ```typescript
 * safeToString({ toString: () => ({}) }); // "[unserializable input]"
 * safeToString({ toString: () => { throw new Error(); } }); // "[unserializable input]"
 * safeToString("hello"); // "hello"
 * ```
 */
function safeToString(value: unknown): string {
  try {
    const result = String(value);
    // String() может вернуть "[object Object]" для некоторых объектов,
    // но это валидная строка для отладки
    return result;
  } catch {
    return '[unserializable input]';
  }
}

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
 * **Валидация**:
 * - Отвергает NaN и Infinity по умолчанию
 * - Используйте decimal.js проверки для обеспечения finite значений
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
      if (typeof obj.toString === 'function') {
        try {
          // toString() может выбросить исключение или вернуть не-строку
          // Обёртываем в String() для безопасности
          const toStringResult = obj.toString();
          normalized = String(toStringResult);
        } catch (toStringError) {
          return Err(
            new ErrorConstructor(
              toStringError instanceof Error ? toStringError.message : 'toString() threw exception',
              {
                context: {
                  source: ErrorSource.PARSING,
                  raw: { field, value: safeToString(input) },
                  cause: toCause(toStringError),
                  reason: reasonEnum
                }
              }
            )
          );
        }
      } else {
        normalized = undefined;
      }
    }

    if (normalized === undefined) {
      return Err(
        new ErrorConstructor('Failed to normalize value: no valid toString()', {
          context: {
            source: ErrorSource.PARSING,
            raw: { field, value: '[object without toString]' },
            reason: reasonEnum
          }
        })
      );
    }

    // normalized точно number | string после проверки выше
    const decimal = new Decimal(normalized);

    // Проверяем что результат finite (не NaN и не Infinity)
    if (!decimal.isFinite()) {
      return Err(
        new ErrorConstructor('Value must be finite (not NaN or Infinity)', {
          context: {
            source: ErrorSource.PARSING,
            raw: { field, value: String(normalized) },
            reason: reasonEnum
          }
        })
      );
    }

    return Ok(decimal);
  } catch (error) {
    // NOTE: Decimal.js always throws Error, but we handle non-Error for defensive programming
    // Coverage: non-Error branch is unreachable with current Decimal.js implementation
    return Err(
      new ErrorConstructor(
        error instanceof Error ? error.message : 'Failed to parse value',
        {
          context: {
            source: ErrorSource.PARSING,
            raw: { field, value: safeToString(input) },
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
 * @param e - Ошибка из math layer (ТОЛЬКО Error объекты)
 * @param ErrorConstructor - Конструктор ошибки
 * @returns TError с source, cause и сохранённым code/context если e - TradingError (без service/op - добавятся через rewrap)
 *
 * @remarks
 * Используется для обработки ожидаемых ошибок:
 * - InvalidOperandError
 * - ArithmeticOverflowError
 * - DivisionByZeroError
 * - InvalidRoundingModeError
 *
 * Если исходная ошибка - TradingError:
 * - Сохраняет её code и context (включая roundingMode, value и т.д.)
 * - Добавляет originalCode в context
 * - Устанавливает source = MATH_OPERATION
 *
 * ВАЖНО: Принимает только Error. Если это не Error - используй unexpectedError.
 *
 * Фабрика ТОЛЬКО добавляет семантику (source, cause).
 * Трассировка (service, op, opChain) добавляется через rewrap в wrapOp.
 */
export function expectedMathError<TError extends DomainError>(
  e: Error,
  ErrorConstructor: ErrorConstructor<TError>
): TError {
  const cause = toCause(e);

  // Если исходная ошибка - TradingError, сохраняем её code и context
  const baseContext: Record<string, unknown> = {
    source: ErrorSource.MATH_OPERATION,
    cause
  };

  if (e instanceof TradingError) {
    // Сохраняем оригинальный code и context
    if (e.code !== undefined) {
      baseContext.originalCode = e.code;
    }
    if (e.context !== undefined) {
      // Мерджим с сохранением source и cause
      Object.assign(baseContext, e.context);
      // Гарантируем что source и cause не перезаписаны
      baseContext.source = ErrorSource.MATH_OPERATION;
      baseContext.cause = cause;
    }
  }

  return new ErrorConstructor(`Math operation failed: ${cause.message}`, {
    code: e instanceof TradingError ? e.code : undefined,
    context: baseContext
  });
}

/**
 * Создаёт ошибку для неожиданных ошибок
 *
 * @param e - Неожиданная ошибка (any type)
 * @param ErrorConstructor - Конструктор ошибки
 * @returns TError с source и cause (без service/op - добавятся через rewrap)
 *
 * @remarks
 * Используется когда происходит неожиданная ошибка (не из известных типов).
 * Включает полный stack trace для debugging.
 *
 * Фабрика ТОЛЬКО добавляет семантику (source, cause).
 * Трассировка (service, op, opChain) добавляется через rewrap в wrapOp.
 */
export function unexpectedError<TError extends DomainError>(
  e: unknown,
  ErrorConstructor: ErrorConstructor<TError>
): TError {
  const cause = toCause(e);
  return new ErrorConstructor(`Unexpected error: ${cause.message}`, {
    context: {
      source: ErrorSource.UNEXPECTED,
      cause
    }
  });
}

/**
 * Создаёт ошибку для developer misuse (TypeError)
 *
 * @param e - TypeError от неправильного использования API
 * @param ErrorConstructor - Конструктор ошибки
 * @returns TError с source=DEVELOPER_MISUSE, reason=MISUSE
 *
 * @remarks
 * Используется для TypeError ошибок, которые указывают на неправильное использование API.
 * Например: вызов метода с wrong types, обращение к undefined property, и т.д.
 *
 * **Отличается от unexpectedError:**
 * - Использует source: DEVELOPER_MISUSE вместо UNEXPECTED
 * - Добавляет reason: 'MISUSE' для явной идентификации
 * - Помогает отличить ошибки разработчика от runtime ошибок
 * - В логах/мониторинге/аналитике видно что это developer error, а не runtime issue
 *
 * Фабрика ТОЛЬКО добавляет семантику (source, reason, cause).
 * Трассировка (service, op, opChain) добавляется через rewrap в wrapOp.
 */
export function developerMisuseError<TError extends DomainError>(
  e: Error,
  ErrorConstructor: ErrorConstructor<TError>
): TError {
  const cause = toCause(e);
  return new ErrorConstructor(`Developer misuse: ${cause.message}`, {
    context: {
      source: ErrorSource.DEVELOPER_MISUSE,
      reason: 'MISUSE',
      cause
    }
  });
}

/**
 * Создаёт ошибку для Core invariant violations
 *
 * @param e - Core invariant violation (Error & { reason: string })
 * @param ErrorConstructor - Конструктор ошибки
 * @returns TError с source, reason и cause (без service/op - добавятся через rewrap)
 *
 * @remarks
 * Используется для обработки нарушений инвариантов Core (PriceInvariantViolation, etc).
 * Сохраняет reason из исключения Core и полный cause с stack trace.
 *
 * Фабрика ТОЛЬКО добавляет семантику (source, reason, cause).
 * Трассировка (service, op, opChain) добавляется через rewrap в wrapOp.
 */
export function coreInvariantError<TError extends DomainError>(
  e: Error & { reason: string },
  ErrorConstructor: ErrorConstructor<TError>
): TError {
  const cause = toCause(e);
  return new ErrorConstructor(e.message, {
    context: {
      source: ErrorSource.CORE_INVARIANT,
      reason: e.reason,
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
 * - InvalidRoundingModeError - невалидный режим округления
 */
export function isExpectedMathError(e: unknown): e is Error {
  return (
    e instanceof Error &&
    (e instanceof ArithmeticOverflowError ||
      e instanceof InvalidOperandError ||
      e instanceof DivisionByZeroError ||
      e instanceof InvalidRoundingModeError ||
      e.name === 'ArithmeticOverflowError' ||
      e.name === 'InvalidOperandError' ||
      e.name === 'DivisionByZeroError' ||
      e.name === 'InvalidRoundingModeError')
  );
}

/**
 * Проверяет является ли ошибка Core invariant violation
 *
 * @param e - Ошибка для проверки
 * @returns true если это Core invariant violation
 *
 * @remarks
 * Используется в catch блоках wrapOp для обнаружения нарушений инвариантов Core.
 *
 * **Проверка в два этапа:**
 * 1. Стабильный маркер: проверяет `kind === 'INVARIANT_VIOLATION'` (рекомендуется)
 * 2. Fallback: проверяет name по whitelist (для обратной совместимости)
 *
 * **Рекомендация для новых ошибок:**
 * Добавляйте `kind: 'INVARIANT_VIOLATION'` в invariant violation ошибки.
 * Это устойчивее к переименованию классов.
 *
 * Поддерживаемые типы (по name):
 * - PriceInvariantViolation
 * - QuantityInvariantViolation
 * - MoneyInvariantViolation
 * - BalanceInvariantViolation
 * - TokenBalanceInvariantViolation
 * - SpreadInvariantViolation
 * - QuoteInvariantViolation
 * - RatioInvariantViolation
 *
 * @example
 * ```typescript
 * // Новый подход (стабильный):
 * class PriceInvariantViolation extends Error {
 *   kind = 'INVARIANT_VIOLATION' as const;
 *   reason: string;
 *   constructor(message: string, reason: string) {
 *     super(message);
 *     this.reason = reason;
 *   }
 * }
 * ```
 */
export function isCoreInvariantViolation(e: unknown): e is Error & { reason: string } {
  if (!(e instanceof Error) || !('reason' in e)) {
    return false;
  }

  // Проверяем что reason действительно строка
  if (typeof (e as Error & { reason: unknown }).reason !== 'string') {
    return false;
  }

  // Проверяем стабильный маркер (рекомендуемый подход)
  if ('kind' in e && e.kind === 'INVARIANT_VIOLATION') {
    return true;
  }

  // Fallback: проверяем по name (для обратной совместимости)
  return (
    e.name === 'PriceInvariantViolation' ||
    e.name === 'QuantityInvariantViolation' ||
    e.name === 'MoneyInvariantViolation' ||
    e.name === 'BalanceInvariantViolation' ||
    e.name === 'TokenBalanceInvariantViolation' ||
    e.name === 'SpreadInvariantViolation' ||
    e.name === 'QuoteInvariantViolation' ||
    e.name === 'RatioInvariantViolation'
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
 * - cause, reason, raw, source сохраняются из inner (это первопричина)
 * - firstTradingErrorTimestamp, firstTradingErrorStack, originalName, originalCode сохраняют данные самой первой ошибки
 * - opChain накапливает историю операций: [innerOp, ..., op]
 *
 * Это гарантирует:
 * - Операционный контекст (amount, factor) всегда актуален для текущего op
 * - Первопричина (cause, reason, raw) не теряется
 * - История операций сохраняется в opChain
 * - Origin-данные (timestamp, stack, name, code первой ошибки) сохраняются для отладки
 *
 * @example
 * ```typescript
 * const innerError = new InvalidMoneyError('Parse failed', {
 *   context: { reason: 'INVALID_FORMAT', raw: { field: 'value', value: 'abc' } }
 * });
 *
 * const wrappedError = rewrap('MoneyService', 'create', { currency: 'USDC' }, innerError, InvalidMoneyError);
 * // wrappedError.context = {
 * //   service: 'MoneyService',
 * //   op: 'create',
 * //   opChain: ['MoneyService.create'],
 * //   currency: 'USDC',
 * //   reason: 'INVALID_FORMAT',  // сохранён из inner
 * //   raw: { field: 'value', value: 'abc' }  // сохранён из inner
 * // }
 * ```
 */
export function rewrap<TError extends DomainError>(
  serviceName: string,
  op: string,
  ctx: Record<string, unknown>,
  err: TError,
  ErrorConstructor: ErrorConstructor<TError>
): TError {
  const inner = (err.context ?? {}) as Record<string, unknown>;

  // Запрещаем ctx приносить root-поля и trace-поля (защита от случайного перетирания и спуфинга)
  // originalError* поля НЕ вырезаем - они нужны wrapOp, но используем write-once логику ниже
  const {
    cause: _c,
    reason: _r,
    raw: _raw,
    source: _s,
    service: _svc,
    op: _op,
    opChain: _chain,
    firstTradingErrorTimestamp: _ftets,
    firstTradingErrorStack: _ftes,
    originalName: _on,
    originalCode: _oc,
    ...safeCtx
  } = ctx;

  // 1) мерджим контекст: inner база, safeCtx сверху (без root-полей)
  const merged: Record<string, unknown> = {
    ...inner,
    ...safeCtx
  };

  // 2) Сохраняем root service (первоначальный сервис, откуда пришла ошибка)
  if (inner.service !== undefined) {
    merged.service = inner.service; // Root service не перетирается
  } else {
    merged.service = serviceName; // Устанавливаем если это первый rewrap
  }

  // 3) opChain строим с префиксами сервисов: ["ServiceA.opA", "ServiceB.opB"]
  const fullOp = `${serviceName}.${op}`;
  const innerChain = Array.isArray(inner.opChain) ? inner.opChain : undefined;
  const filtered = (innerChain?.filter((x) => typeof x === 'string') as string[]) ?? [];

  // Формируем базу: либо existing chain, либо создаем из inner.op с сервисом
  const base = filtered.length > 0
    ? filtered
    : (typeof inner.op === 'string' && typeof inner.service === 'string'
        ? [`${inner.service}.${inner.op}`]
        : []);

  merged.op = op;
  // Не добавляем op в opChain если он уже последний элемент (избегаем дублирования)
  const lastOp = base[base.length - 1];
  merged.opChain = lastOp === fullOp ? base : [...base, fullOp];

  // 4) root-поля сохраняем из inner, если они есть (не перетираются)
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

  // 5) Сохраняем origin-данные из первоначальной ошибки (если это первый rewrap)
  // Эти поля позволяют отследить самую первую ошибку в цепочке
  // Если поле уже есть в inner, оно уже скопировано через spread на строке 567
  if (inner.firstTradingErrorTimestamp === undefined && err.timestamp) {
    merged.firstTradingErrorTimestamp = err.timestamp.toISOString();
  }

  if (inner.firstTradingErrorStack === undefined && err.stack) {
    merged.firstTradingErrorStack = err.stack;
  }

  if (inner.originalName === undefined && err.name) {
    merged.originalName = err.name;
  }

  if (inner.originalCode === undefined && err.code) {
    merged.originalCode = err.code;
  }

  // 4b) originalError* поля write-once (приоритет у inner для защиты от спуфинга)
  // wrapOp передает их через ctx при foreign TradingError, но повторный rewrap НЕ должен их перезаписывать
  if (inner.originalErrorName !== undefined) {
    merged.originalErrorName = inner.originalErrorName;
  }
  if (inner.originalErrorCode !== undefined) {
    merged.originalErrorCode = inner.originalErrorCode;
  }
  if (inner.originalErrorContext !== undefined) {
    merged.originalErrorContext = inner.originalErrorContext;
  }

  // 5) Создаем новую ошибку с сохранением code и innerError
  const rewrappedError = new ErrorConstructor(err.message, {
    code: err.code, // Сохраняем code из исходной ошибки
    context: merged,
  });

  // Сохраняем innerError через Object.defineProperty (readonly поле)
  if (err.innerError !== undefined) {
    Object.defineProperty(rewrappedError, 'innerError', {
      value: err.innerError,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }

  return rewrappedError;
}

/**
 * Оборачивает facade операцию в try/catch с централизованной обработкой ошибок
 *
 * @param serviceName - Название сервиса ('QuoteService', 'PriceService', и т.д.)
 * @param op - Название операции
 * @param ctx - Контекст операции
 * @param fn - Функция выполняющая операцию (может включать math, create, rules)
 * @param ErrorConstructor - Конструктор ошибки
 * @returns Result с результатом или ошибкой
 *
 * @remarks
 * Устраняет дублирование try/catch блоков во всех операциях.
 * Автоматически классифицирует ошибки как expected/unexpected.
 * Автоматически rewrap'ает ошибки из Result.Err с добавлением serviceName в opChain.
 *
 * **Строгий типовой контракт:**
 * Гарантирует `Result<T, TError>` - всегда возвращается ошибка типа TError.
 * "Чужие" TradingError (например InvalidMoneyError в контексте InvalidPriceError)
 * конвертируются в TError через unexpectedError, с сохранением оригинальных данных
 * в полях originalErrorName, originalErrorCode, originalErrorContext.
 *
 * Обрабатывает типы ошибок/результатов:
 * 1. Result.Err(TError) (из create/rules) → rewrap с добавлением serviceName.op
 * 2. Core invariant violations → coreInvariantError + rewrap
 * 3. Expected math errors → expectedMathError + rewrap
 * 4. Same-type TradingError (instanceof ErrorConstructor) → rewrap
 * 5. Foreign TradingError → unexpectedError + rewrap (с сохранением originalError*)
 * 6. TypeError → developerMisuseError + rewrap
 * 7. Unexpected errors → unexpectedError + rewrap
 *
 * @example
 * ```typescript
 * return wrapOp(
 *   'MoneyService',
 *   'add',
 *   { a: a.amount().toString(), b: b.amount().toString() },
 *   () => {
 *     const sum = addDecimal(a.amount(), b.amount());
 *     return createFromDecimal(sum, a.currency(), 'add', {});
 *   },
 *   InvalidMoneyError
 * );
 * // Если ошибка, opChain будет: ["MoneyService.add"]
 * ```
 */
export function wrapOp<T, TError extends DomainError>(
  serviceName: string,
  op: string,
  ctx: Record<string, unknown>,
  fn: () => Result<T, TError>,
  ErrorConstructor: ErrorConstructor<TError>
): Result<T, TError> {
  try {
    const result = fn();
    // Если fn() вернул Err с TError - rewrap автоматически
    if (isErr(result)) {
      return Err(rewrap(serviceName, op, ctx, result.error, ErrorConstructor));
    }
    return result;
  } catch (e) {
    // Core invariant violations (PriceInvariantViolation, etc) - обрабатываем ПЕРВЫМИ
    if (isCoreInvariantViolation(e)) {
      // Фабрика добавляет source+reason, rewrap добавляет service+op+opChain
      const factoryError = coreInvariantError(e, ErrorConstructor);
      return Err(rewrap(serviceName, op, ctx, factoryError, ErrorConstructor));
    }
    // Если кто-то бросил TradingError того же типа (ErrorConstructor) - просто rewrap
    // Если бросил "чужой" TradingError - классифицируем по isExpectedMathError
    // ВАЖНО: Проверяем ДО isExpectedMathError (для non-TradingError), т.к. expected math errors extends TradingError
    if (e instanceof TradingError) {
      if (e instanceof ErrorConstructor) {
        // Тот же тип - rewrap с добавлением service+op+opChain
        return Err(rewrap(serviceName, op, ctx, e, ErrorConstructor));
      } else if (isExpectedMathError(e)) {
        // Чужой TradingError НО это expected math error (например InvalidRoundingModeError при ErrorConstructor=InvalidPriceError)
        // Классифицируем как math_operation, НЕ unexpected
        const factoryError = expectedMathError(e, ErrorConstructor);
        return Err(rewrap(serviceName, op, ctx, factoryError, ErrorConstructor));
      } else {
        // Чужой TradingError И НЕ expected math error - конвертируем через unexpectedError
        // TypeScript выводит тип 'never' здесь, но мы знаем что это TradingError (не того типа и не expected math)
        const tradingError = e as TradingError;
        const originalContext = {
          originalErrorName: tradingError.name,
          originalErrorCode: tradingError.code,
          originalErrorContext: tradingError.context,
        };
        const factoryError = unexpectedError(tradingError, ErrorConstructor);
        return Err(rewrap(serviceName, op, { ...ctx, ...originalContext }, factoryError, ErrorConstructor));
      }
    }
    // Ожидаемые math ошибки (NON-TradingError, например native Error('Division by zero'))
    // Проверяем ПОСЛЕ TradingError, т.к. если бросили TradingError того же типа - это уже обработано выше
    if (isExpectedMathError(e)) {
      // Фабрика добавляет source+cause, rewrap добавляет service+op+opChain
      const factoryError = expectedMathError(e, ErrorConstructor);
      return Err(rewrap(serviceName, op, ctx, factoryError, ErrorConstructor));
    }
    // Developer misuse (TypeError) - отличаем от обычных unexpected ошибок
    if (e instanceof TypeError) {
      const factoryError = developerMisuseError(e, ErrorConstructor);
      return Err(rewrap(serviceName, op, ctx, factoryError, ErrorConstructor));
    }
    // Неожиданные ошибки - фабрика добавляет source+cause, rewrap добавляет service+op+opChain
    const factoryError = unexpectedError(e, ErrorConstructor);
    return Err(rewrap(serviceName, op, ctx, factoryError, ErrorConstructor));
  }
}

/**
 * Создаёт стандартизированную ошибку несовпадения валют
 *
 * @param expected - Ожидаемая валюта
 * @param actual - Фактическая валюта
 * @param reasonEnum - Enum значение для CURRENCY_MISMATCH (напр. MoneyErrorReason.CURRENCY_MISMATCH)
 * @param ErrorConstructor - Конструктор ошибки
 * @returns TError с source, reason, expected, actual (без op - добавляется caller'ом)
 *
 * @remarks
 * Стандартизирует создание ошибок несовпадения валют во всех Services.
 * Устраняет дублирование кода в comparison и math операциях.
 *
 * **Стандартный контекст:**
 * - source - RULE_VALIDATION (нарушение бизнес-правила совместимости валют)
 * - reason - CURRENCY_MISMATCH enum
 * - expected - ожидаемая валюта
 * - actual - фактическая валюта
 *
 * **Используется в:**
 * - MoneyService: isLessThan, equals, add, subtract, и т.д.
 * - BalanceService: equals, canAfford
 *
 * **ВАЖНО:** Caller должен добавить op в context при необходимости.
 *
 * @example
 * ```typescript
 * // В MoneyService.isLessThan:
 * if (!a.hasSameCurrency(b)) {
 *   const err = currencyMismatchError(
 *     a.currency(),
 *     b.currency(),
 *     MoneyErrorReason.CURRENCY_MISMATCH,
 *     InvalidMoneyError
 *   );
 *   // Добавляем tracing через rewrap если нужно
 *   return Err(rewrap('MoneyService', 'isLessThan', {}, err, InvalidMoneyError));
 * }
 * ```
 */
export function currencyMismatchError<TError extends DomainError>(
  expected: string,
  actual: string,
  reasonEnum: string,
  ErrorConstructor: ErrorConstructor<TError>
): TError {
  return new ErrorConstructor(`Currency mismatch: expected ${expected}, got ${actual}`, {
    context: {
      source: ErrorSource.RULE_VALIDATION,
      reason: reasonEnum,
      expected,
      actual
    }
  });
}
