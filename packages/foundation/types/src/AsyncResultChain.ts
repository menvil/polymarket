/**
 * AsyncResultChain - асинхронная обёртка для Promise<Result<T, E>>
 *
 * @remarks
 * Предоставляет fluent API для работы с асинхронными Result.
 * Все методы возвращают новый AsyncResultChain для method chaining.
 *
 * Преимущества:
 * - Читабельный синтаксис для async операций
 * - Автоматическая обработка Promise rejections
 * - Композиция async операций без явного await
 *
 * @template T - Тип успешного результата
 * @template E - Тип ошибки
 *
 * @example
 * ```typescript
 * const result = await AsyncResult.from(fetchUser('123'))
 *   .mapAsync(user => fetchProfile(user.id))
 *   .flatMapAsync(profile => validateProfile(profile))
 *   .unwrapOr({ name: 'Guest' });
 * ```
 */

import { Result, Ok, Err, formatValue } from './result';
import { ResultChain, toChain } from './ResultChain';

/**
 * Класс для method chaining с Promise<Result<T, E>>
 */
export class AsyncResultChain<T, E> {
  /**
   * @internal
   * Внутреннее представление Promise<Result<T, E>>
   */
  private readonly promise: Promise<Result<T, E>>;

  /**
   * Создаёт AsyncResultChain из Promise<Result<T, E>>
   *
   * @param promise - Promise содержащий Result
   */
  constructor(promise: Promise<Result<T, E>>) {
    this.promise = promise;
  }

  /**
   * Трансформирует успешное значение асинхронно
   *
   * @param fn - Async функция для трансформации значения
   * @returns Новый AsyncResultChain
   *
   * @example
   * ```typescript
   * const result = AsyncResult.from(getUser('123'))
   *   .mapAsync(user => fetchFullProfile(user.id));
   * ```
   */
  mapAsync<U>(fn: (value: T) => Promise<U>): AsyncResultChain<U, E> {
    const newPromise = this.promise.then(async (result) => {
      if (result.ok) {
        const newValue = await fn(result.value);
        return Ok(newValue);
      }
      return result as Result<U, E>;
    });
    return new AsyncResultChain(newPromise);
  }

  /**
   * Трансформирует успешное значение синхронно
   *
   * @param fn - Функция для трансформации значения
   * @returns Новый AsyncResultChain
   *
   * @example
   * ```typescript
   * const result = AsyncResult.from(getUser('123'))
   *   .map(user => user.name);
   * ```
   */
  map<U>(fn: (value: T) => U): AsyncResultChain<U, E> {
    const newPromise = this.promise.then((result) => {
      if (result.ok) {
        return Ok(fn(result.value));
      }
      return result as Result<U, E>;
    });
    return new AsyncResultChain(newPromise);
  }

  /**
   * Цепочка async Result-возвращающих операций
   *
   * @param fn - Async функция возвращающая Result
   * @returns Новый AsyncResultChain
   *
   * @example
   * ```typescript
   * const result = AsyncResult.from(getUser('123'))
   *   .flatMapAsync(user => validateUser(user))
   *   .flatMapAsync(user => saveUser(user));
   * ```
   */
  flatMapAsync<U, F>(
    fn: (value: T) => Promise<Result<U, F>>
  ): AsyncResultChain<U, E | F> {
    const newPromise = this.promise.then(async (result) => {
      if (result.ok) {
        return (await fn(result.value)) as Result<U, E | F>;
      }
      return result as Result<U, E | F>;
    });
    return new AsyncResultChain(newPromise);
  }

  /**
   * Цепочка sync Result-возвращающих операций
   *
   * @param fn - Функция возвращающая Result
   * @returns Новый AsyncResultChain
   *
   * @example
   * ```typescript
   * const result = AsyncResult.from(getUser('123'))
   *   .flatMap(user => validateAge(user.age));
   * ```
   */
  flatMap<U, F>(fn: (value: T) => Result<U, F>): AsyncResultChain<U, E | F> {
    const newPromise = this.promise.then((result) => {
      if (result.ok) {
        return fn(result.value) as Result<U, E | F>;
      }
      return result as Result<U, E | F>;
    });
    return new AsyncResultChain(newPromise);
  }

  /**
   * Трансформирует ошибку асинхронно
   *
   * @param fn - Async функция для трансформации ошибки
   * @returns AsyncResultChain с трансформированной ошибкой
   *
   * @example
   * ```typescript
   * const result = AsyncResult.from(fetchData())
   *   .mapErrAsync(err => enrichErrorWithContext(err));
   * ```
   */
  mapErrAsync<F>(fn: (error: E) => Promise<F>): AsyncResultChain<T, F> {
    const newPromise = this.promise.then(async (result) => {
      if (!result.ok) {
        const newError = await fn(result.error);
        return Err(newError);
      }
      return result as Result<T, F>;
    });
    return new AsyncResultChain(newPromise);
  }

  /**
   * Трансформирует ошибку синхронно
   *
   * @param fn - Функция для трансформации ошибки
   * @returns AsyncResultChain с трансформированной ошибкой
   *
   * @example
   * ```typescript
   * const result = AsyncResult.from(fetchData())
   *   .mapErr(err => `Failed: ${err}`);
   * ```
   */
  mapErr<F>(fn: (error: E) => F): AsyncResultChain<T, F> {
    const newPromise = this.promise.then((result) => {
      if (!result.ok) {
        return Err(fn(result.error));
      }
      return result as Result<T, F>;
    });
    return new AsyncResultChain(newPromise);
  }

  /**
   * Извлекает значение из Ok
   *
   * @returns Promise с значением если ok = true
   * @throws {Error} Если ok = false
   *
   * @example
   * ```typescript
   * const user = await AsyncResult.from(fetchUser('123')).unwrap();
   * ```
   */
  async unwrap(): Promise<T> {
    const result = await this.promise;
    if (!result.ok) {
      const errorInfo = formatValue(result.error);
      throw new Error(`Called unwrap on Err result: ${errorInfo}`);
    }
    return result.value;
  }

  /**
   * Извлекает значение или возвращает fallback
   *
   * @param defaultValue - Значение по умолчанию
   * @returns Promise с значением или defaultValue
   *
   * @example
   * ```typescript
   * const user = await AsyncResult.from(fetchUser('123'))
   *   .unwrapOr({ id: 'guest', name: 'Guest' });
   * ```
   */
  async unwrapOr(defaultValue: T): Promise<T> {
    const result = await this.promise;
    return result.ok ? result.value : defaultValue;
  }

  /**
   * Извлекает значение или вычисляет fallback через функцию
   *
   * @param fn - Функция для вычисления fallback из ошибки
   * @returns Promise с значением или результатом fn
   *
   * @example
   * ```typescript
   * const user = await AsyncResult.from(fetchUser('123'))
   *   .unwrapOrElse(err => {
   *     console.log('Failed:', err);
   *     return { id: 'guest', name: 'Guest' };
   *   });
   * ```
   */
  async unwrapOrElse(fn: (error: E) => T): Promise<T> {
    const result = await this.promise;
    return result.ok ? result.value : fn(result.error);
  }

  /**
   * Извлекает ошибку из Err
   *
   * @returns Promise с ошибкой если ok = false
   * @throws {Error} Если ok = true
   *
   * @example
   * ```typescript
   * const error = await AsyncResult.from(failedOperation()).unwrapErr();
   * ```
   */
  async unwrapErr(): Promise<E> {
    const result = await this.promise;
    if (result.ok) {
      const valueInfo = formatValue(result.value);
      throw new Error(`Called unwrapErr on Ok result: ${valueInfo}`);
    }
    return result.error;
  }

  /**
   * Проверяет является ли Result успешным
   *
   * @returns Promise<boolean>
   *
   * @example
   * ```typescript
   * if (await AsyncResult.from(fetchUser('123')).isOk()) {
   *   console.log('Success!');
   * }
   * ```
   */
  async isOk(): Promise<boolean> {
    const result = await this.promise;
    return result.ok;
  }

  /**
   * Проверяет содержит ли Result ошибку
   *
   * @returns Promise<boolean>
   *
   * @example
   * ```typescript
   * if (await AsyncResult.from(fetchUser('123')).isErr()) {
   *   console.log('Error!');
   * }
   * ```
   */
  async isErr(): Promise<boolean> {
    const result = await this.promise;
    return !result.ok;
  }

  /**
   * Выполняет функцию для side effects, возвращает this
   *
   * @param fn - Функция для выполнения (получает value если Ok)
   * @returns this для продолжения цепочки
   *
   * @example
   * ```typescript
   * const result = await AsyncResult.from(fetchUser('123'))
   *   .tap(user => console.log('User:', user))
   *   .map(user => user.name)
   *   .unwrap();
   * ```
   */
  tap(fn: (value: T) => void | Promise<void>): AsyncResultChain<T, E> {
    const newPromise = this.promise.then(async (result) => {
      if (result.ok) {
        await fn(result.value);
      }
      return result;
    });
    return new AsyncResultChain(newPromise);
  }

  /**
   * Выполняет функцию для side effects при ошибке
   *
   * @param fn - Функция для выполнения (получает error если Err)
   * @returns this для продолжения цепочки
   *
   * @example
   * ```typescript
   * const result = await AsyncResult.from(fetchUser('123'))
   *   .tapErr(error => console.error('Error:', error))
   *   .unwrapOr(null);
   * ```
   */
  tapErr(fn: (error: E) => void | Promise<void>): AsyncResultChain<T, E> {
    const newPromise = this.promise.then(async (result) => {
      if (!result.ok) {
        await fn(result.error);
      }
      return result;
    });
    return new AsyncResultChain(newPromise);
  }

  /**
   * Pattern matching для Result
   *
   * @param handlers - Объект с обработчиками ok и err
   * @returns Promise с результатом выполнения соответствующего обработчика
   *
   * @example
   * ```typescript
   * const message = await AsyncResult.from(fetchUser('123')).match({
   *   ok: user => `Success: ${user.name}`,
   *   err: error => `Error: ${error}`
   * });
   * ```
   */
  async match<U>(handlers: {
    ok: (value: T) => U | Promise<U>;
    err: (error: E) => U | Promise<U>;
  }): Promise<U> {
    const result = await this.promise;
    return result.ok ? handlers.ok(result.value) : handlers.err(result.error);
  }

  /**
   * Комбинирует два Result - возвращает второй если первый Ok
   *
   * @param other - Другой Result
   * @returns Второй Result если this.ok = true, иначе первую ошибку
   *
   * @example
   * ```typescript
   * const result = await AsyncResult.from(step1())
   *   .and(step2())
   *   .unwrap();
   * ```
   */
  and<U, F>(other: Result<U, F>): AsyncResultChain<U, E | F> {
    const newPromise = this.promise.then((result) => {
      if (result.ok) {
        return other as Result<U, E | F>;
      }
      return result as Result<U, E | F>;
    });
    return new AsyncResultChain(newPromise);
  }

  /**
   * Комбинирует с async Result
   *
   * @param other - Promise<Result>
   * @returns Второй Result если this.ok = true, иначе первую ошибку
   *
   * @example
   * ```typescript
   * const result = await AsyncResult.from(step1())
   *   .andAsync(step2())
   *   .unwrap();
   * ```
   */
  andAsync<U, F>(other: Promise<Result<U, F>>): AsyncResultChain<U, E | F> {
    const newPromise = this.promise.then(async (result) => {
      if (result.ok) {
        return (await other) as Result<U, E | F>;
      }
      return result as Result<U, E | F>;
    });
    return new AsyncResultChain(newPromise);
  }

  /**
   * Возвращает первый Ok, иначе второй Result
   *
   * @param other - Fallback Result
   * @returns this если ok = true, иначе other
   *
   * @example
   * ```typescript
   * const result = await AsyncResult.from(primarySource())
   *   .or(Ok(defaultValue))
   *   .unwrap();
   * ```
   */
  or<F>(other: Result<T, F>): AsyncResultChain<T, F> {
    const newPromise = this.promise.then((result) => {
      if (result.ok) {
        return result as Result<T, F>;
      }
      return other;
    });
    return new AsyncResultChain(newPromise);
  }

  /**
   * Возвращает первый Ok, иначе async fallback
   *
   * @param other - Promise<Result> fallback
   * @returns this если ok = true, иначе other
   *
   * @example
   * ```typescript
   * const result = await AsyncResult.from(primarySource())
   *   .orAsync(fallbackSource())
   *   .unwrap();
   * ```
   */
  orAsync<F>(other: Promise<Result<T, F>>): AsyncResultChain<T, F> {
    const newPromise = this.promise.then(async (result) => {
      if (result.ok) {
        return result as Result<T, F>;
      }
      return await other;
    });
    return new AsyncResultChain(newPromise);
  }

  /**
   * Recovery при ошибке через async функцию
   *
   * @param fn - Async функция для обработки ошибки
   * @returns AsyncResultChain с восстановленным значением или новой ошибкой
   *
   * @example
   * ```typescript
   * const result = await AsyncResult.from(primaryOperation())
   *   .orElseAsync(async err => {
   *     console.log('Recovering from:', err);
   *     return await fallbackOperation();
   *   })
   *   .unwrap();
   * ```
   */
  orElseAsync<F>(fn: (error: E) => Promise<Result<T, F>>): AsyncResultChain<T, F> {
    const newPromise = this.promise.then(async (result) => {
      if (result.ok) {
        return result as Result<T, F>;
      }
      return await fn(result.error);
    });
    return new AsyncResultChain(newPromise);
  }

  /**
   * Recovery при ошибке через sync функцию
   *
   * @param fn - Функция для обработки ошибки
   * @returns AsyncResultChain с восстановленным значением или новой ошибкой
   *
   * @example
   * ```typescript
   * const result = await AsyncResult.from(operation())
   *   .orElse(err => {
   *     console.log('Recovering from:', err);
   *     return Ok(defaultValue);
   *   })
   *   .unwrap();
   * ```
   */
  orElse<F>(fn: (error: E) => Result<T, F>): AsyncResultChain<T, F> {
    const newPromise = this.promise.then((result) => {
      if (result.ok) {
        return result as Result<T, F>;
      }
      return fn(result.error);
    });
    return new AsyncResultChain(newPromise);
  }

  /**
   * Алиас для flatMapAsync (Rust-стиль)
   *
   * @param fn - Async функция возвращающая Result
   * @returns Новый AsyncResultChain
   *
   * @example
   * ```typescript
   * const result = await AsyncResult.from(getUser('123'))
   *   .andThen(user => validateUser(user));
   * ```
   */
  andThen<U, F>(fn: (value: T) => Promise<Result<U, F>>): AsyncResultChain<U, E | F> {
    return this.flatMapAsync(fn);
  }

  /**
   * Unwrap с кастомным сообщением ошибки
   *
   * @param message - Сообщение для ошибки
   * @returns Promise с значением если ok = true
   * @throws {Error} С кастомным сообщением если ok = false
   *
   * @example
   * ```typescript
   * const user = await AsyncResult.from(fetchUser('123'))
   *   .expect('User should exist');
   * ```
   */
  async expect(message: string): Promise<T> {
    const result = await this.promise;
    if (!result.ok) {
      const errorInfo = formatValue(result.error);
      throw new Error(`${message}: ${errorInfo}`);
    }
    return result.value;
  }

  /**
   * Unwrap ошибки с кастомным сообщением
   *
   * @param message - Сообщение для ошибки
   * @returns Promise с ошибкой если ok = false
   * @throws {Error} С кастомным сообщением если ok = true
   *
   * @example
   * ```typescript
   * const error = await AsyncResult.from(failedOperation())
   *   .expectErr('Operation should fail');
   * ```
   */
  async expectErr(message: string): Promise<E> {
    const result = await this.promise;
    if (result.ok) {
      const valueInfo = formatValue(result.value);
      throw new Error(`${message}: expected Err but got Ok(${valueInfo})`);
    }
    return result.error;
  }

  /**
   * Конвертирует AsyncResultChain в Promise<Result<T, E>>
   *
   * @returns Promise с plain object Result
   *
   * @example
   * ```typescript
   * const plainResult = await AsyncResult.from(fetchUser('123')).toPromise();
   * if (plainResult.ok) {
   *   console.log('User:', plainResult.value);
   * }
   * ```
   */
  toPromise(): Promise<Result<T, E>> {
    return this.promise;
  }

  /**
   * Конвертирует в sync ResultChain после await
   *
   * @returns Promise<ResultChain<T, E>>
   *
   * @example
   * ```typescript
   * const chain = await AsyncResult.from(fetchUser('123')).toChain();
   * const userName = chain.map(user => user.name).unwrap();
   * ```
   */
  async toChain(): Promise<ResultChain<T, E>> {
    const result = await this.promise;
    return toChain(result);
  }
}

/**
 * Хелперы для создания AsyncResultChain
 *
 * @example
 * ```typescript
 * import { AsyncResult } from '@polymarket/types';
 *
 * // Из Promise<Result>
 * const result1 = await AsyncResult.from(fetchUser('123')).unwrap();
 *
 * // Из Promise (wraps в Ok)
 * const result2 = await AsyncResult.ok(fetch('/api/user')).unwrap();
 *
 * // Из значения ошибки
 * const result3 = await AsyncResult.err('Failed').unwrapErr();
 * ```
 */
export const AsyncResult = {
  /**
   * Создаёт AsyncResultChain из Promise<Result<T, E>>
   */
  from: <T, E>(promise: Promise<Result<T, E>>): AsyncResultChain<T, E> => {
    return new AsyncResultChain(promise);
  },

  /**
   * Создаёт AsyncResultChain из Promise<T> (wraps в Ok)
   */
  ok: <T>(promise: Promise<T>): AsyncResultChain<T, never> => {
    return new AsyncResultChain(promise.then(Ok));
  },

  /**
   * Создаёт AsyncResultChain с ошибкой (для симметрии API)
   */
  err: <E>(error: E): AsyncResultChain<never, E> => {
    return new AsyncResultChain(Promise.resolve(Err(error)));
  },
} as const;
