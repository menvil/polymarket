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
   * ```
   */
  unwrapErr(): E {
    if (this.data.ok) {
      throw new Error('Called unwrapErr on Ok result');
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