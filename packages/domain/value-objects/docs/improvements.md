# План улучшений архитектуры Value Objects

## Статус: Планирование
**Дата создания:** 2026-02-02
**Версия:** 1.0

---

## 1. Восстановление Type Safety для Error Reasons

### 🎯 Проблема

После рефакторинга на single error type архитектуру потеряна type safety на уровне компиляции:

```typescript
// Текущая реализация - runtime-only checking
if (result.error.context?.reason === 'DIVISION_BY_ZERO') {
  // ❌ Опечатка 'DIVISON_BY_ZERO' не будет поймана компилятором
  // ❌ Нет автодополнения для возможных значений
  // ❌ Нельзя гарантировать exhaustive checking
}
```

**Риски:**
- Опечатки в строковых константах не ловятся на этапе компиляции
- Отсутствие автодополнения усложняет разработку
- Невозможность exhaustive checking (TypeScript не может проверить, что все случаи обработаны)
- При добавлении новых причин ошибок нет гарантии, что код обновлён везде

### ✅ Решение: Enum для Reason значений

#### Шаг 1: Создать enum для каждого Value Object

**Файл:** `src/money/errors/MoneyErrorReason.ts`
```typescript
/**
 * Типизированные причины ошибок для Money операций
 *
 * @remarks
 * Используется в InvalidMoneyError.context.reason для дифференциации ошибок
 * на уровне типов вместо строковых констант
 */
export enum MoneyErrorReason {
  /** Значение NaN */
  NAN = 'NAN',

  /** Значение не finite (Infinity, -Infinity) */
  NON_FINITE = 'NON_FINITE',

  /** Результат операции превышает максимальную сумму */
  EXCEEDS_MAX_AMOUNT = 'EXCEEDS_MAX_AMOUNT',

  /** Несовпадение валют в add/subtract операциях */
  CURRENCY_MISMATCH = 'CURRENCY_MISMATCH',

  /** Деление на ноль */
  DIVISION_BY_ZERO = 'DIVISION_BY_ZERO',

  /** Неподдерживаемая валюта */
  UNSUPPORTED_CURRENCY = 'UNSUPPORTED_CURRENCY',

  /** Ошибка парсинга значения */
  INVALID_FORMAT = 'INVALID_FORMAT',

  /** Результат операции меньше нуля */
  NEGATIVE_RESULT = 'NEGATIVE_RESULT'
}
```

**Файл:** `src/price/errors/PriceErrorReason.ts`
```typescript
export enum PriceErrorReason {
  NAN = 'NAN',
  NON_FINITE = 'NON_FINITE',
  EXCEEDS_MAX_PRICE = 'EXCEEDS_MAX_PRICE',
  NEGATIVE_PRICE = 'NEGATIVE_PRICE',
  DIVISION_BY_ZERO = 'DIVISION_BY_ZERO',
  INVALID_FORMAT = 'INVALID_FORMAT',
  NOT_ALIGNED = 'NOT_ALIGNED',
  INVALID_TICK_SIZE = 'INVALID_TICK_SIZE'
}
```

**Файл:** `src/quantity/errors/QuantityErrorReason.ts`
```typescript
export enum QuantityErrorReason {
  NAN = 'NAN',
  NON_FINITE = 'NON_FINITE',
  EXCEEDS_MAX_QUANTITY = 'EXCEEDS_MAX_QUANTITY',
  NEGATIVE_QUANTITY = 'NEGATIVE_QUANTITY',
  DIVISION_BY_ZERO = 'DIVISION_BY_ZERO',
  INVALID_FORMAT = 'INVALID_FORMAT',
  INVALID_STEP_SIZE = 'INVALID_STEP_SIZE'
}
```

#### Шаг 2: Обновить использование в Services

```typescript
// ❌ БЫЛО
return Err(new InvalidMoneyError('Factor cannot be NaN', {
  context: { factor: factor.toString(), reason: 'NAN' }
}));

// ✅ СТАЛО
import { MoneyErrorReason } from '../errors/MoneyErrorReason';

return Err(new InvalidMoneyError('Factor cannot be NaN', {
  context: { factor: factor.toString(), reason: MoneyErrorReason.NAN }
}));
```

#### Шаг 3: Обновить все обработчики ошибок

```typescript
// ❌ БЫЛО
if (result.error.context?.reason === 'DIVISION_BY_ZERO') {

// ✅ СТАЛО
import { MoneyErrorReason } from '@polymarket/value-objects/money';

if (result.error.context?.reason === MoneyErrorReason.DIVISION_BY_ZERO) {
  // ✅ Автодополнение работает
  // ✅ Опечатки ловятся на этапе компиляции
}
```

### 📊 Преимущества

1. **Compile-time safety** - опечатки ловятся TypeScript
2. **Автодополнение** - IDE подсказывает все возможные значения
3. **Рефакторинг** - можно безопасно переименовывать через "Rename Symbol"
4. **Документация** - enum документирует все возможные причины ошибок в одном месте
5. **Совместимость** - enum компилируется в строки, обратная совместимость сохраняется

### 📝 Задачи

- [ ] Создать `MoneyErrorReason` enum
- [ ] Создать `PriceErrorReason` enum
- [ ] Создать `QuantityErrorReason` enum
- [ ] Обновить MoneyService для использования enum
- [ ] Обновить PriceService для использования enum
- [ ] Обновить QuantityService для использования enum
- [ ] Обновить все Rules для использования enum
- [ ] Обновить все тесты
- [ ] Обновить документацию с примерами использования enum
- [ ] Добавить migration guide для пользователей API

---

## 2. Типизация Error Context через Discriminated Unions

### 🎯 Проблема

Текущий подход с `context: Record<string, unknown>` не даёт type safety:

```typescript
// Текущая реализация
const { reason, expected, actual } = result.error.context || {};
// ❌ TypeScript не знает, что для CURRENCY_MISMATCH есть expected и actual
// ❌ Нет проверки на наличие обязательных полей
// ❌ Можно случайно передать неправильные поля
```

### ✅ Решение: Discriminated Unions для Context

#### Шаг 1: Определить типы контекстов

**Файл:** `src/money/errors/MoneyErrorContext.ts`
```typescript
import { MoneyErrorReason } from './MoneyErrorReason';

/**
 * Базовый контекст для всех ошибок Money
 */
interface BaseMoneyErrorContext {
  /** Название операции верхнего уровня */
  op: string;

  /** Цепочка операций (для вложенных вызовов) */
  opChain?: string[];

  /** Root-cause для math исключений (не перетирается) */
  cause?: {
    name: string;
    message: string;
    stack?: string;
  };

  /** Сырой ввод при ошибках парсинга */
  raw?: {
    field: string;
    value: string;
  };
}

/**
 * Контекст для ошибки NaN
 */
export interface MoneyErrorContextNaN extends BaseMoneyErrorContext {
  reason: MoneyErrorReason.NAN;
  /** Значение, которое оказалось NaN */
  factor?: string;
  divisor?: string;
  amount?: string;
}

/**
 * Контекст для ошибки несовпадения валют
 */
export interface MoneyErrorContextCurrencyMismatch extends BaseMoneyErrorContext {
  reason: MoneyErrorReason.CURRENCY_MISMATCH;
  /** Ожидаемая валюта */
  expected: string;
  /** Фактическая валюта */
  actual: string;
}

/**
 * Контекст для ошибки деления на ноль
 */
export interface MoneyErrorContextDivisionByZero extends BaseMoneyErrorContext {
  reason: MoneyErrorReason.DIVISION_BY_ZERO;
  /** Делитель (всегда "0") */
  divisor: string;
}

/**
 * Контекст для ошибки превышения максимальной суммы
 */
export interface MoneyErrorContextExceedsMax extends BaseMoneyErrorContext {
  reason: MoneyErrorReason.EXCEEDS_MAX_AMOUNT;
  /** Значение, которое превысило максимум */
  amount: string;
  /** Максимально допустимое значение */
  maxAmount: string;
}

// ... другие контексты

/**
 * Union type всех возможных контекстов ошибок Money
 */
export type MoneyErrorContext =
  | MoneyErrorContextNaN
  | MoneyErrorContextCurrencyMismatch
  | MoneyErrorContextDivisionByZero
  | MoneyErrorContextExceedsMax;
  // ... другие варианты
```

#### Шаг 2: Типизировать InvalidMoneyError

```typescript
// В @polymarket/errors
export class InvalidMoneyError extends DomainError {
  constructor(
    message: string,
    options?: {
      context?: MoneyErrorContext; // ✅ Типизированный контекст
      cause?: Error;
    }
  ) {
    super(message, options);
  }

  // ✅ Типизированный геттер
  get context(): MoneyErrorContext | undefined {
    return this._context as MoneyErrorContext;
  }
}
```

#### Шаг 3: Использование с type narrowing

```typescript
if (!result.ok) {
  const error = result.error;

  // ✅ Type narrowing работает автоматически
  switch (error.context?.reason) {
    case MoneyErrorReason.CURRENCY_MISMATCH:
      // TypeScript ЗНАЕТ, что здесь есть expected и actual
      console.error(`Currency mismatch: ${error.context.expected} vs ${error.context.actual}`);
      break;

    case MoneyErrorReason.DIVISION_BY_ZERO:
      // TypeScript ЗНАЕТ, что здесь есть divisor
      console.error(`Division by zero: divisor=${error.context.divisor}`);
      break;

    case MoneyErrorReason.NAN:
      // TypeScript ЗНАЕТ возможные поля
      const value = error.context.factor || error.context.divisor || error.context.amount;
      console.error(`NaN value: ${value}`);
      break;
  }
}
```

### 📊 Преимущества

1. **Full type safety** - TypeScript проверяет все поля контекста
2. **Автодополнение** - IDE показывает доступные поля для каждого reason
3. **Обязательные поля** - компилятор проверяет наличие required полей
4. **Документация** - типы документируют структуру контекста
5. **Exhaustive checking** - можно использовать switch с проверкой всех вариантов

### 📝 Задачи

- [ ] Определить MoneyErrorContext discriminated union
- [ ] Определить PriceErrorContext discriminated union
- [ ] Определить QuantityErrorContext discriminated union
- [ ] Обновить типы InvalidMoneyError/InvalidPriceError/InvalidQuantityError
- [ ] Обновить все места создания ошибок в Services
- [ ] Обновить все места обработки ошибок в тестах
- [ ] Добавить примеры в документацию
- [ ] Проверить совместимость с существующим кодом

---

## 3. Type Guards для удобной обработки ошибок

### 🎯 Проблема

Обработка ошибок с type narrowing через switch может быть многословной для простых проверок.

### ✅ Решение: Type Guard функции

**Файл:** `src/money/errors/guards.ts`
```typescript
import { InvalidMoneyError } from '@polymarket/errors';
import { MoneyErrorReason } from './MoneyErrorReason';
import type { MoneyErrorContextCurrencyMismatch, MoneyErrorContextDivisionByZero } from './MoneyErrorContext';

/**
 * Type guard для проверки ошибки несовпадения валют
 *
 * @param error - Ошибка для проверки
 * @returns true если ошибка связана с несовпадением валют
 *
 * @example
 * ```typescript
 * if (isCurrencyMismatch(result.error)) {
 *   // TypeScript знает что error.context имеет expected и actual
 *   console.error(`Expected ${result.error.context.expected}, got ${result.error.context.actual}`);
 * }
 * ```
 */
export function isCurrencyMismatch(
  error: InvalidMoneyError
): error is InvalidMoneyError & { context: MoneyErrorContextCurrencyMismatch } {
  return error.context?.reason === MoneyErrorReason.CURRENCY_MISMATCH;
}

/**
 * Type guard для проверки ошибки деления на ноль
 */
export function isDivisionByZero(
  error: InvalidMoneyError
): error is InvalidMoneyError & { context: MoneyErrorContextDivisionByZero } {
  return error.context?.reason === MoneyErrorReason.DIVISION_BY_ZERO;
}

/**
 * Type guard для проверки NaN ошибок
 */
export function isNaN(error: InvalidMoneyError): boolean {
  return error.context?.reason === MoneyErrorReason.NAN;
}

// ... другие guards
```

#### Использование

```typescript
import { MoneyService, isCurrencyMismatch, isDivisionByZero } from '@polymarket/value-objects/money';

const result = MoneyService.add(money1, money2);

if (!result.ok) {
  if (isCurrencyMismatch(result.error)) {
    // ✅ TypeScript знает структуру context
    const { expected, actual } = result.error.context;
    console.error(`Cannot add ${actual} to ${expected}`);
    return;
  }

  // Generic fallback
  console.error(result.error.message);
}
```

### 📊 Преимущества

1. **Удобство** - краткие проверки вместо switch
2. **Type safety** - автоматический type narrowing
3. **Переиспользование** - guards можно экспортировать и использовать везде
4. **Читаемость** - `isCurrencyMismatch(error)` читается лучше чем `error.context?.reason === ...`

### 📝 Задачи

- [ ] Создать type guards для Money errors
- [ ] Создать type guards для Price errors
- [ ] Создать type guards для Quantity errors
- [ ] Добавить примеры использования в документацию
- [ ] Экспортировать guards из index.ts каждого value object

---

## 4. Устранение дублирования Helper Methods

### 🎯 Проблема

Идентичные helper methods дублируются в MoneyService, PriceService и QuantityService:

**Дублированные методы:**
1. `toCause(e: unknown)` - 100% идентичен в трёх сервисах (15 строк × 3 = 45 строк)
2. `wrapOp<T>(op, ctx, fn)` - идентичная логика, только разные типы ошибок (20 строк × 3 = 60 строк)
3. `rewrap(op, ctx, err)` - идентичная логика, только разные типы ошибок (35 строк × 3 = 105 строк)
4. `toDecimal(field, input)` - идентичная логика, только разные типы ошибок (40 строк × 3 = 120 строк)
5. `expectedMathError(op, ctx, e)` - идентичная логика (10 строк × 3 = 30 строк)
6. `unexpectedError(op, ctx, e)` - идентичная логика (10 строк × 3 = 30 строк)

**Итого дублирования:** ~390 строк кода

**Риски:**
- Изменение логики требует обновления в трёх местах
- Высокий риск рассинхронизации реализаций
- Усложнение поддержки и ревью
- Сложнее добавлять новые value objects

### ✅ Решение: Извлечь в Base Class или Utility

#### Вариант A: Abstract Base Class (рекомендуется)

**Файл:** `src/shared/facade/ValueObjectServiceBase.ts`
```typescript
import { Result, Ok, Err } from '@polymarket/result';
import Decimal from 'decimal.js';
import type { DomainError } from '@polymarket/errors';

/**
 * Базовый класс для всех Facade сервисов Value Objects
 *
 * @remarks
 * Содержит общую логику обработки ошибок, wrapOp, rewrap, toDecimal
 * для устранения дублирования между Money, Price, Quantity сервисами
 *
 * @typeParam TError - Тип ошибки (InvalidMoneyError, InvalidPriceError, InvalidQuantityError)
 * @typeParam TFieldName - Union type имён полей для toDecimal ('value' | 'factor' | ...)
 */
export abstract class ValueObjectServiceBase<
  TError extends DomainError,
  TFieldName extends string
> {
  /**
   * Извлекает структурированный cause из любой ошибки
   *
   * @param e - Ошибка (Error или unknown)
   * @returns Структурированный объект cause
   *
   * @remarks
   * - Если e instanceof Error → { name, message, stack }
   * - Иначе → { name: 'UnknownError', message: String(e) }
   */
  protected static toCause(e: unknown): { name: string; message: string; stack?: string } {
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
   * Обёртка для операций с автоматической обработкой ошибок
   *
   * @param op - Название операции
   * @param ctx - Контекст операции
   * @param fn - Функция операции, возвращающая Result
   * @param ErrorConstructor - Конструктор ошибки (класс)
   * @returns Result с автоматическим rewrap при ошибке
   *
   * @remarks
   * - Ловит все исключения и конвертирует в Result.Err
   * - Автоматически вызывает rewrap для вложенных ошибок
   * - Сохраняет opChain для трассировки вложенных операций
   */
  protected static wrapOp<T, TError extends DomainError>(
    op: string,
    ctx: Record<string, unknown>,
    fn: () => Result<T, TError>,
    ErrorConstructor: new (message: string, options?: { context?: unknown }) => TError
  ): Result<T, TError> {
    try {
      const result = fn();

      if (!result.ok) {
        return Err(this.rewrap(op, ctx, result.error, ErrorConstructor));
      }

      return result;
    } catch (e) {
      if (e instanceof ErrorConstructor) {
        return Err(this.rewrap(op, ctx, e as TError, ErrorConstructor));
      }

      // Неожиданная ошибка - создаём новую с cause
      const cause = this.toCause(e);
      return Err(
        new ErrorConstructor(`${op} failed unexpectedly: ${cause.message}`, {
          context: {
            op,
            ...ctx,
            cause
          }
        })
      );
    }
  }

  /**
   * Rewrap существующей ошибки с добавлением контекста операции
   *
   * @param op - Название операции
   * @param ctx - Контекст операции
   * @param err - Существующая ошибка
   * @param ErrorConstructor - Конструктор ошибки (класс)
   * @returns Новая ошибка с объединённым контекстом
   *
   * @remarks
   * Правила мерджа контекста:
   * 1. Root-поля (cause, reason, raw) НЕ перетираются
   * 2. op и opChain обновляются для трассировки
   * 3. Остальные поля из ctx добавляются в контекст
   */
  protected static rewrap<TError extends DomainError>(
    op: string,
    ctx: Record<string, unknown>,
    err: TError,
    ErrorConstructor: new (message: string, options?: { context?: unknown }) => TError
  ): TError {
    const inner = (err.context ?? {}) as Record<string, unknown>;

    // Запрещаем ctx приносить root-поля (защита от случайного перетирания)
    const { cause: _c, reason: _r, raw: _raw, op: _op, opChain: _chain, ...safeCtx } = ctx;

    // 1) Мерджим контекст: inner база, safeCtx сверху (без root-полей)
    const merged: Record<string, unknown> = {
      ...inner,
      ...safeCtx
    };

    // 2) Сохраняем root-поля из inner (если были)
    if (inner.cause) merged.cause = inner.cause;
    if (inner.reason !== undefined) merged.reason = inner.reason;
    if (inner.raw) merged.raw = inner.raw;

    // 3) Обновляем op/opChain для трассировки
    const innerOp = typeof inner.op === 'string' ? inner.op : undefined;
    const innerChain = Array.isArray(inner.opChain) ? (inner.opChain as string[]) : [];

    merged.op = op;

    if (innerOp && innerOp !== op) {
      merged.opChain = [innerOp, ...innerChain];
    } else if (innerChain.length > 0) {
      merged.opChain = innerChain;
    }

    return new ErrorConstructor(err.message, { context: merged });
  }

  /**
   * Безопасно конвертирует number | string | Decimal в Decimal
   *
   * @param field - Имя поля (для структурированного raw)
   * @param input - Входное значение
   * @param ErrorConstructor - Конструктор ошибки (класс)
   * @returns Result<Decimal, TError>
   *
   * @remarks
   * Нормализует вход и корректно работает с двумя копиями decimal.js:
   * - Primitives (number, string) парсим напрямую
   * - Объекты (Decimal из другой копии) → toString() → парсим
   */
  protected static toDecimal<TError extends DomainError>(
    field: string,
    input: number | string | Decimal,
    ErrorConstructor: new (message: string, options?: { context?: unknown }) => TError
  ): Result<Decimal, TError> {
    try {
      let normalized: number | string | undefined;

      if (typeof input === 'number' || typeof input === 'string') {
        normalized = input;
      } else {
        // input это Decimal (возможно из другой копии decimal.js)
        const obj = input as unknown as { toString?: unknown };
        normalized = typeof obj.toString === 'function' ? obj.toString() : undefined;
      }

      if (normalized === undefined) {
        return Err(
          new ErrorConstructor('Failed to normalize value: no valid toString()', {
            context: {
              raw: { field, value: String(input) },
              reason: 'INVALID_FORMAT'
            }
          })
        );
      }

      const decimal = new Decimal(normalized);
      return Ok(decimal);
    } catch (e) {
      const cause = this.toCause(e);
      return Err(
        new ErrorConstructor(`Failed to parse ${field}: ${cause.message}`, {
          context: {
            raw: { field, value: String(input) },
            cause,
            reason: 'INVALID_FORMAT'
          }
        })
      );
    }
  }
}
```

#### Использование в MoneyService

```typescript
import { ValueObjectServiceBase } from '../shared/facade/ValueObjectServiceBase';
import { InvalidMoneyError } from '@polymarket/errors';

export class MoneyService extends ValueObjectServiceBase<
  InvalidMoneyError,
  'value' | 'factor' | 'divisor'
> {
  // ✅ Все helper methods наследуются автоматически

  public static create(
    value: number | string | Decimal,
    currency: SupportedCurrency
  ): Result<Money, InvalidMoneyError> {
    // Используем унаследованный toDecimal
    const decimalResult = this.toDecimal('value', value, InvalidMoneyError);
    if (!decimalResult.ok) {
      return decimalResult;
    }

    // Используем унаследованный wrapOp
    return this.wrapOp(
      'create',
      { value: String(value), currency },
      () => {
        // логика создания
      },
      InvalidMoneyError
    );
  }

  public static multiply(
    m: Money,
    factor: number | string | Decimal
  ): Result<Money, InvalidMoneyError> {
    const ctx = { amount: m.amount().toString(), factor: String(factor), currency: m.currency() };

    const factorDecimal = this.toDecimal('factor', factor, InvalidMoneyError);
    if (!factorDecimal.ok) {
      // rewrap автоматически добавит op и ctx
      return Err(this.rewrap('multiply', ctx, factorDecimal.error, InvalidMoneyError));
    }

    // ... остальная логика
  }
}
```

#### Вариант B: Utility Functions

Если не хотим inheritance, можно создать utility модуль:

**Файл:** `src/shared/facade/errorUtils.ts`
```typescript
import { Result, Ok, Err } from '@polymarket/result';
import Decimal from 'decimal.js';
import type { DomainError } from '@polymarket/errors';

export function toCause(e: unknown): { name: string; message: string; stack?: string } {
  // ... реализация
}

export function wrapOp<T, TError extends DomainError>(...) {
  // ... реализация
}

export function rewrap<TError extends DomainError>(...) {
  // ... реализация
}

export function toDecimal<TError extends DomainError>(...) {
  // ... реализация
}
```

### 📊 Сравнение подходов

| Критерий | Abstract Base Class | Utility Functions |
|----------|-------------------|-------------------|
| **Переиспользование кода** | ✅ Полное | ✅ Полное |
| **Type safety** | ✅ Высокая (generic параметры) | ⚠️ Средняя (нужно передавать типы) |
| **Читаемость** | ✅ `this.wrapOp(...)` | ⚠️ `wrapOp(..., ErrorConstructor)` |
| **Тестирование** | ⚠️ Нужно тестировать базовый класс | ✅ Проще тестировать функции |
| **Гибкость** | ⚠️ Жёсткая связь через наследование | ✅ Композиция |
| **Рефакторинг** | ⚠️ Сложнее менять базовый класс | ✅ Проще менять отдельные функции |

**Рекомендация:** Abstract Base Class для единообразия API, но если нужна гибкость - Utility Functions.

### 📝 Задачи

#### Вариант A (Base Class):
- [ ] Создать `ValueObjectServiceBase` abstract class
- [ ] Рефакторить MoneyService для использования базового класса
- [ ] Рефакторить PriceService для использования базового класса
- [ ] Рефакторить QuantityService для использования базового класса
- [ ] Удалить дублированные методы из всех сервисов
- [ ] Обновить тесты (проверить что всё работает)
- [ ] Обновить документацию с описанием базового класса

#### Вариант B (Utility Functions):
- [ ] Создать модуль `errorUtils.ts` с utility функциями
- [ ] Обновить MoneyService для использования utilities
- [ ] Обновить PriceService для использования utilities
- [ ] Обновить QuantityService для использования utilities
- [ ] Удалить дублированные методы
- [ ] Добавить тесты для utility функций
- [ ] Обновить документацию

---

## 5. Дополнительные улучшения (Future)

### 5.1. Добавить Result Helpers

Для упрощения работы с Result можно добавить helper методы:

```typescript
// src/shared/result/helpers.ts
export function mapError<T, E1, E2>(
  result: Result<T, E1>,
  mapper: (e: E1) => E2
): Result<T, E2> {
  return result.ok ? result : Err(mapper(result.error));
}

export function flatMap<T, U, E>(
  result: Result<T, E>,
  mapper: (value: T) => Result<U, E>
): Result<U, E> {
  return result.ok ? mapper(result.value) : result;
}

// Использование
const result = MoneyService.create(100, 'USDC')
  .flatMap(money => MoneyService.multiply(money, 2))
  .flatMap(money => MoneyService.add(money, otherMoney));
```

### 5.2. Builder Pattern для сложных операций

```typescript
const result = MoneyBuilder.start(100, 'USDC')
  .multiply(2)
  .add(otherMoney)
  .subtract(fee)
  .build();
```

### 5.3. Structured Logging для операций

```typescript
const result = MoneyService.create(100, 'USDC', {
  trace: true, // включает трассировку
  logger: customLogger
});

// Автоматически логирует:
// [MoneyService.create] input: { value: 100, currency: 'USDC' }
// [MoneyService.create] success: Money(100 USDC)
```

---

## Приоритизация

### 🔥 Критично (реализовать в первую очередь)
1. **Enum для Error Reasons** (§1) - восстановление compile-time safety
2. **Устранение дублирования Helper Methods** (§4) - снижение технического долга

### ⚡ Важно (реализовать во вторую очередь)
3. **Типизация Error Context** (§2) - улучшение type safety
4. **Type Guards** (§3) - улучшение DX (Developer Experience)

### 💡 Опционально (future improvements)
5. **Result Helpers** (§5.1)
6. **Builder Pattern** (§5.2)
7. **Structured Logging** (§5.3)

---

## Метрики успеха

После реализации улучшений мы должны достичь:

✅ **Type Safety:**
- 0 string literals для error reasons (все через enum)
- 100% типизированных error contexts
- Exhaustive checking для всех обработчиков ошибок

✅ **Code Quality:**
- Уменьшение дублирования на ~390 строк кода
- Единая точка изменения для общей логики
- Упрощение добавления новых value objects

✅ **Developer Experience:**
- Автодополнение для всех error reasons
- Автодополнение для полей error context
- Меньше boilerplate при обработке ошибок

✅ **Maintainability:**
- Изменение логики в одном месте вместо трёх
- Проще добавлять новые value objects
- Меньше рисков рассинхронизации

---

## Миграция для пользователей API

### Breaking Changes

Переход на enum для error reasons не является breaking change, так как enum компилируется в строки:

```typescript
// Старый код будет работать
if (error.context?.reason === 'DIVISION_BY_ZERO') { }

// Новый код предпочтительнее
if (error.context?.reason === MoneyErrorReason.DIVISION_BY_ZERO) { }
```

### Migration Path

1. Выпустить v1.x с enum, но сохранить обратную совместимость
2. Deprecate string literals в документации
3. В v2.0 (если нужно) можно сделать context.reason строго типизированным

---

## Контрольный список для ревью

При реализации каждого улучшения проверить:

- [ ] Все тесты проходят
- [ ] Type safety не нарушен
- [ ] Документация обновлена
- [ ] Примеры в документации актуальны
- [ ] Migration guide добавлен (если есть breaking changes)
- [ ] Performance не ухудшился (запустить benchmarks)
- [ ] Code coverage не упал
- [ ] Обратная совместимость сохранена (где возможно)

---

## Ссылки

- [TypeScript Discriminated Unions](https://www.typescriptlang.org/docs/handbook/2/narrowing.html#discriminated-unions)
- [TypeScript Type Guards](https://www.typescriptlang.org/docs/handbook/2/narrowing.html#using-type-predicates)
- [TypeScript Enums](https://www.typescriptlang.org/docs/handbook/enums.html)
- [DRY Principle](https://en.wikipedia.org/wiki/Don%27t_repeat_yourself)
