/**
 * ResultChain - OOP обёртка для Result с поддержкой method chaining
 *
 * @remarks
 * Предоставляет fluent API для работы с Result.
 * Внутри использует plain objects, но позволяет писать цепочки методов.
 *
 * Преимущества:
 * - Читабельный синтаксис с method chaining
 * - Автодополнение в IDE
 * - Совместим с plain objects (через .toResult())
 *
 * @template T - Тип успешного результата
 * @template E - Тип ошибки
 *
 * @example
 * ```typescript
 * const result = OkChain(5)
 *   .map(x => x * 2)
 *   .map(x => x + 1)
 *   .unwrapOr(0);
 * // result: 11
 * ```
 */

import {
  Result,
  Ok,
  Err,
  map as mapFn,
  mapErr as mapErrFn,
  unwrap as unwrapFn,
  unwrapOr as unwrapOrFn,
  isOk,
  isErr,
  formatValue,
} from './result';

/**
 * Класс для method chaining с Result
 */
export class ResultChain<T, E> {
  /**
   * @internal
   * Внутреннее представление Result (plain object)
   */
  private readonly data: Result<T, E>;

  /**
   * Создаёт ResultChain из plain object Result
   *
   * @param data - Plain object Result<T, E>
   */
  constructor(data: Result<T, E>) {
    this.data = data;
  }

  /**
   * Трансформирует успешное значение
   *
   * @param fn - Функция для трансформации значения
   * @returns Новый ResultChain с трансформированным значением
   *
   * @example
   * ```typescript
   * const result = OkChain(5).map(x => x * 2);
   * // result.unwrap() === 10
   * ```
   */
  map<U>(fn: (value: T) => U): ResultChain<U, E> {
    return new ResultChain(mapFn(this.data, fn));
  }

  /**
   * Цепочка Result-возвращающих операций (monadic bind)
   *
   * @param fn - Функция возвращающая Result
   * @returns Новый ResultChain
   *
   * @example
   * ```typescript
   * const divide = (a: number, b: number): Result<number, string> =>
   *   b === 0 ? Err('Деление на ноль') : Ok(a / b);
   *
   * const result = OkChain(10)
   *   .flatMap(x => divide(x, 2))
   *   .flatMap(x => divide(x, 5));
   * // result.unwrap() === 1
   * ```
   */
  flatMap<U, F>(fn: (value: T) => Result<U, F>): ResultChain<U, E | F> {
    if (this.data.ok) {
      return new ResultChain(fn(this.data.value) as Result<U, E | F>);
    }
    return new ResultChain(this.data as Result<U, E | F>);
  }

  /**
   * Цепочка Result-возвращающих операций с ResultChain
   *
   * @param fn - Функция возвращающая ResultChain
   * @returns Новый ResultChain
   *
   * @example
   * ```typescript
   * const result = OkChain(10)
   *   .flatMapChain(x => OkChain(x * 2))
   *   .flatMapChain(x => OkChain(x + 1));
   * // result.unwrap() === 21
   * ```
   */
  flatMapChain<U, F>(fn: (value: T) => ResultChain<U, F>): ResultChain<U, E | F> {
    if (this.data.ok) {
      return new ResultChain(fn(this.data.value).toResult() as Result<U, E | F>);
    }
    return new ResultChain(this.data as Result<U, E | F>);
  }

  /**
   * Трансформирует ошибку
   *
   * @param fn - Функция для трансформации ошибки
   * @returns ResultChain с трансформированной ошибкой
   *
   * @example
   * ```typescript
   * const result = ErrChain({ code: 404, message: 'Не найдено' })
   *   .mapErr(err => err.message);
   * // result.unwrapErr() === 'Не найдено'
   * ```
   */
  mapErr<F>(fn: (error: E) => F): ResultChain<T, F> {
    return new ResultChain(mapErrFn(this.data, fn));
  }

  /**
   * Извлекает значение из Ok
   *
   * @returns Значение если ok = true
   * @throws {Error} Если ok = false
   *
   * @remarks
   * ⚠️ НЕБЕЗОПАСНО - используйте только когда уверены что Result успешный.
   *
   * @example
   * ```typescript
   * const value = OkChain(42).unwrap(); // 42
   * const error = ErrChain('упс').unwrap(); // выбрасывает Error
   * ```
   */
  unwrap(): T {
    return unwrapFn(this.data);
  }

  /**
   * Извлекает значение или возвращает fallback
   *
   * @param defaultValue - Значение по умолчанию
   * @returns Значение или defaultValue
   *
   * @example
   * ```typescript
   * const value1 = OkChain(42).unwrapOr(0); // 42
   * const value2 = ErrChain('error').unwrapOr(0); // 0
   * ```
   */
  unwrapOr(defaultValue: T): T {
    return unwrapOrFn(this.data, defaultValue);
  }

  /**
   * Извлекает ошибку из Err
   *
   * @returns Ошибка если ok = false
   * @throws {Error} Если ok = true
   *
   * @example
   * ```typescript
   * const error = ErrChain('упс').unwrapErr(); // 'упс'
   * const value = OkChain(42).unwrapErr(); // выбрасывает Error с информацией о значении
   * ```
   */
  unwrapErr(): E {
    if (this.data.ok) {
      const valueInfo = formatValue(this.data.value);
      throw new Error(`Called unwrapErr on Ok result: ${valueInfo}`);
    }
    return this.data.error;
  }

  /**
   * Проверяет является ли Result успешным
   *
   * @returns true если ok = true
   *
   * @example
   * ```typescript
   * const result = OkChain(42);
   * if (result.isOk()) {
   *   console.log('Успех!');
   * }
   * ```
   */
  isOk(): boolean {
    return isOk(this.data);
  }

  /**
   * Проверяет содержит ли Result ошибку
   *
   * @returns true если ok = false
   *
   * @example
   * ```typescript
   * const result = ErrChain('error');
   * if (result.isErr()) {
   *   console.log('Ошибка!');
   * }
   * ```
   */
  isErr(): boolean {
    return isErr(this.data);
  }

  /**
   * Конвертирует ResultChain обратно в plain object Result
   *
   * @returns Plain object Result<T, E>
   *
   * @remarks
   * Полезно для совместимости с функциональным API или сериализации.
   *
   * @example
   * ```typescript
   * const chain = OkChain(42);
   * const plain = chain.toResult();
   * // plain: { ok: true, value: 42 }
   * ```
   */
  toResult(): Result<T, E> {
    return this.data;
  }

  /**
   * Выполняет функцию для side effects, возвращает this
   *
   * @param fn - Функция для выполнения (получает value если Ok)
   * @returns this для продолжения цепочки
   *
   * @example
   * ```typescript
   * const result = OkChain(42)
   *   .tap(value => console.log('Значение:', value))
   *   .map(x => x * 2);
   * ```
   */
  tap(fn: (value: T) => void): ResultChain<T, E> {
    if (this.data.ok) {
      fn(this.data.value);
    }
    return this;
  }

  /**
   * Выполняет функцию для side effects при ошибке, возвращает this
   *
   * @param fn - Функция для выполнения (получает error если Err)
   * @returns this для продолжения цепочки
   *
   * @example
   * ```typescript
   * const result = ErrChain('error')
   *   .tapErr(error => console.error('Ошибка:', error))
   *   .unwrapOr(0);
   * ```
   */
  tapErr(fn: (error: E) => void): ResultChain<T, E> {
    if (!this.data.ok) {
      fn(this.data.error);
    }
    return this;
  }

  /**
   * Pattern matching для Result
   *
   * @param handlers - Объект с обработчиками ok и err
   * @returns Результат выполнения соответствующего обработчика
   *
   * @example
   * ```typescript
   * const message = OkChain(42).match({
   *   ok: value => `Успех: ${value}`,
   *   err: error => `Ошибка: ${error}`
   * });
   * // message: 'Успех: 42'
   * ```
   */
  match<U>(handlers: { ok: (value: T) => U; err: (error: E) => U }): U {
    return this.data.ok ? handlers.ok(this.data.value) : handlers.err(this.data.error);
  }

  /**
   * Комбинирует два Result - возвращает второй если первый Ok
   *
   * @param other - Другой Result
   * @returns Второй Result если this.ok = true, иначе первую ошибку
   *
   * @example
   * ```typescript
   * const r1 = OkChain(2).and(Ok(3)); // Ok(3)
   * const r2 = ErrChain('error1').and(Ok(5)); // Err('error1')
   * ```
   */
  and<U, F>(other: Result<U, F>): ResultChain<U, E | F> {
    if (this.data.ok) {
      return new ResultChain(other as Result<U, E | F>);
    }
    return new ResultChain(this.data as Result<U, E | F>);
  }

  /**
   * Возвращает первый Ok, иначе второй Result
   *
   * @param other - Fallback Result
   * @returns this если ok = true, иначе other
   *
   * @example
   * ```typescript
   * const r1 = ErrChain('error1').or(Ok(42)); // Ok(42)
   * const r2 = OkChain(10).or(Ok(20)); // Ok(10)
   * ```
   */
  or<F>(other: Result<T, F>): ResultChain<T, F> {
    if (this.data.ok) {
      return new ResultChain(this.data as Result<T, F>);
    }
    return new ResultChain(other);
  }

  /**
   * Разворачивает вложенный Result<Result<T, E>, E> в Result<T, E>
   *
   * @returns ResultChain с развёрнутым значением
   *
   * @example
   * ```typescript
   * const nested: Result<Result<number, string>, string> = Ok(Ok(42));
   * const flat = toChain(nested).flatten(); // ResultChain<number, string>
   * ```
   */
  flatten<U>(this: ResultChain<Result<U, E>, E>): ResultChain<U, E> {
    if (this.data.ok) {
      return new ResultChain(this.data.value);
    }
    return new ResultChain(this.data as Result<U, E>);
  }

  /**
   * Unwrap с кастомным сообщением ошибки
   *
   * @param message - Сообщение для ошибки
   * @returns Значение если ok = true
   * @throws {Error} С кастомным сообщением если ok = false
   *
   * @example
   * ```typescript
   * const value = OkChain(42).expect('Should be Ok'); // 42
   * const error = ErrChain('oops').expect('Failed'); // throws Error: "Failed: oops"
   * ```
   */
  expect(message: string): T {
    if (!this.data.ok) {
      throw new Error(`${message}: ${this.data.error}`);
    }
    return this.data.value;
  }

  /**
   * Unwrap ошибки с кастомным сообщением
   *
   * @param message - Сообщение для ошибки
   * @returns Ошибка если ok = false
   * @throws {Error} С кастомным сообщением если ok = true
   *
   * @example
   * ```typescript
   * const error = ErrChain('oops').expectErr('Should be Err'); // 'oops'
   * const value = OkChain(42).expectErr('Failed'); // throws Error: "Failed: expected Err but got Ok(42)"
   * ```
   */
  expectErr(message: string): E {
    if (this.data.ok) {
      throw new Error(`${message}: expected Err but got Ok(${this.data.value})`);
    }
    return this.data.error;
  }

  /**
   * Алиас для flatMap (более явное имя в Rust-стиле)
   *
   * @param fn - Функция возвращающая Result
   * @returns Новый ResultChain
   *
   * @example
   * ```typescript
   * const result = OkChain(10)
   *   .andThen(x => divide(x, 2))
   *   .andThen(x => divide(x, 5));
   * ```
   */
  andThen<U, F>(fn: (value: T) => Result<U, F>): ResultChain<U, E | F> {
    return this.flatMap(fn);
  }

  /**
   * Recovery при ошибке - возвращает новый Result
   *
   * @param fn - Функция для обработки ошибки
   * @returns ResultChain с восстановленным значением или новой ошибкой
   *
   * @example
   * ```typescript
   * const recovered = ErrChain('error')
   *   .orElse(err => {
   *     console.log('Recovering from:', err);
   *     return Ok(0);  // fallback значение
   *   })
   *   .unwrap();  // 0
   * ```
   */
  orElse<F>(fn: (error: E) => Result<T, F>): ResultChain<T, F> {
    if (this.data.ok) {
      return new ResultChain(this.data as Result<T, F>);
    }
    return new ResultChain(fn(this.data.error));
  }
}

/**
 * Создаёт ResultChain с успешным значением
 *
 * @param value - Значение успешного результата
 * @returns ResultChain с ok = true
 *
 * @example
 * ```typescript
 * const result = OkChain(42).map(x => x * 2);
 * // result.unwrap() === 84
 * ```
 */
export const OkChain = <T>(value: T): ResultChain<T, never> => {
  return new ResultChain(Ok(value));
};

/**
 * Создаёт ResultChain с ошибкой
 *
 * @param error - Описание ошибки
 * @returns ResultChain с ok = false
 *
 * @example
 * ```typescript
 * const result = ErrChain('Что-то пошло не так')
 *   .mapErr(err => err.toUpperCase());
 * ```
 */
export const ErrChain = <E>(error: E): ResultChain<never, E> => {
  return new ResultChain(Err(error));
};

/**
 * Конвертирует plain object Result в ResultChain
 *
 * @param result - Plain object Result
 * @returns ResultChain для method chaining
 *
 * @example
 * ```typescript
 * const plain = Ok(42);
 * const chain = toChain(plain).map(x => x * 2);
 * ```
 */
export const toChain = <T, E>(result: Result<T, E>): ResultChain<T, E> => {
  return new ResultChain(result);
};

/**
 * Короткий алиас для быстрого создания ResultChain
 *
 * @example
 * ```typescript
 * import { R } from '@polymarket/types';
 *
 * const result = R.ok(42).map(x => x * 2).unwrap(); // 84
 * const fallback = R.err('error').or(Ok(0)); // Ok(0)
 * ```
 */
export const R = {
  ok: OkChain,
  err: ErrChain,
  from: toChain,
} as const;

/**
 * Конвертирует Promise в Result (обрабатывает exceptions)
 *
 * @param promise - Promise для конвертации
 * @param onError - Функция для обработки ошибки
 * @returns Promise<Result<T, E>>
 *
 * @example
 * ```typescript
 * const result = await fromPromise(
 *   fetch('/api/user'),
 *   (error) => `Network error: ${error}`
 * );
 *
 * if (result.ok) {
 *   console.log('Response:', result.value);
 * }
 * ```
 */
export async function fromPromise<T, E>(
  promise: Promise<T>,
  onError: (error: unknown) => E
): Promise<Result<T, E>> {
  try {
    const value = await promise;
    return Ok(value);
  } catch (error) {
    return Err(onError(error));
  }
}

/**
 * Конвертирует nullable значение в Result
 *
 * @param value - Значение которое может быть null/undefined
 * @param error - Ошибка если значение null/undefined
 * @returns Result<T, E>
 *
 * @example
 * ```typescript
 * const maybeUser: User | null = findUser('123');
 * const result = fromNullable(maybeUser, 'User not found');
 *
 * if (result.ok) {
 *   console.log('User:', result.value);
 * }
 * ```
 */
export function fromNullable<T, E>(
  value: T | null | undefined,
  error: E
): Result<T, E> {
  if (value == null) {
    return Err(error);
  }
  return Ok(value);
}

/**
 * Оборачивает функцию которая может выбросить exception в Result-returning функцию
 *
 * @param fn - Функция которая может выбросить exception
 * @param onError - Функция для обработки exception
 * @returns Обёрнутая функция возвращающая Result
 *
 * @example
 * ```typescript
 * const safeParseJSON = fromThrowable(
 *   (text: string) => JSON.parse(text),
 *   (error) => `Parse error: ${error}`
 * );
 *
 * const result = safeParseJSON('{"name": "John"}');
 * if (result.ok) {
 *   console.log('Parsed:', result.value);
 * }
 * ```
 */
export function fromThrowable<Args extends readonly unknown[], T, E>(
  fn: (...args: Args) => T,
  onError: (error: unknown) => E
): (...args: Args) => Result<T, E> {
  return (...args: Args) => {
    try {
      const value = fn(...args);
      return Ok(value);
    } catch (error) {
      return Err(onError(error));
    }
  };
}
