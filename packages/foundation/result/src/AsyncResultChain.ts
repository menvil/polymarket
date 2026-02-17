/**
 * AsyncResultChain - асинхронная обёртка для Promise<Result<T, E>>
 *
 * @remarks
 * Предоставляет fluent API для работы с асинхронными Result.
 * Все методы возвращают новый AsyncResultChain для method chaining.
 *
 * ## Единая политика обработки исключений
 *
 * **Transform-методы** (map, mapAsync, flatMapAsync, flatMap, mapErrAsync, mapErr,
 * orElseAsync, orElse, orAsyncLazy) **перехватывают** исключения из callback
 * и преобразуют их в `Err(onError(exception))`. Promise цепочки остаётся resolved.
 *
 * **Небезопасный transform** (`mapUnsafe`) **НЕ перехватывает** исключения —
 * они приводят к rejected Promise. Используйте только когда rejected Promise
 * является желаемым поведением.
 *
 * **Side-effect методы** (tap, tapErr) **НЕ перехватывают** исключения —
 * они приводят к rejected Promise. Исключение в side-effect методе — это баг
 * в коде пользователя, который не следует маскировать.
 *
 * **match** — особый случай: исключение из handler перехватывается, но
 * пробрасывается как **новый** `Error` с текстом оригинальной ошибки.
 * Это сохраняет rejected-семантику, но изменяет тип и стек исходного исключения.
 *
 * ## Normalizer (onError)
 *
 * Чтобы избежать небезопасного `error as E`, AsyncResultChain принимает
 * опциональный `onError: (e: unknown) => E` normalizer при создании.
 * При перехвате исключений в transform-методах используется этот normalizer.
 * Без normalizer тип `E` должен включать `unknown`.
 *
 * @template T - Тип успешного результата
 * @template E - Тип ошибки
 *
 * @example
 * ```typescript
 * // AsyncResult.from ожидает Promise<Result<T,E>>
 * const result = await AsyncResult.from(fetchUser('123'))
 *   .mapAsync(user => fetchProfile(user.id))
 *   .flatMapAsync(profile => validateProfile(profile))
 *   .unwrapOr({ name: 'Guest' });
 *
 * // С normalizer для строгой типизации:
 * const result2 = await AsyncResult.from(
 *   fetchUser('123'),
 *   (err) => new AppError(String(err))
 * ).mapAsync(user => fetchProfile(user.id))
 *  .unwrapOr({ name: 'Guest' });
 * ```
 */

import { Result, Ok, Err, formatValue } from './result.js';
import { ResultChain, toChain } from './ResultChain.js';

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
   * @internal
   * Normalizer для преобразования unknown исключений в тип E
   * Используется в transform-методах при перехвате исключений
   */
  private readonly onError: (error: unknown) => E;

  /**
   * Создаёт AsyncResultChain из Promise<Result<T, E>>
   *
   * @param promise - Promise содержащий Result
   * @param onError - Normalizer для преобразования исключений в E
   *   По умолчанию — identity (error as E), что корректно только если E = unknown
   */
  constructor(promise: Promise<Result<T, E>>, onError?: (error: unknown) => E) {
    this.promise = promise;
    this.onError = onError ?? ((error) => error as E);
  }

  /**
   * @internal
   * Создаёт новый AsyncResultChain с тем же normalizer
   */
  private chain<U>(promise: Promise<Result<U, E>>): AsyncResultChain<U, E> {
    return new AsyncResultChain(promise, this.onError);
  }

  /**
   * @internal
   * Безопасный вызов onError normalizer
   *
   * @param error - Перехваченное исключение
   * @returns Нормализованная ошибка типа E
   *
   * @remarks
   * Если сам normalizer выбросит исключение, возвращает error as E.
   * Гарантирует, что Promise остаётся resolved, даже если normalizer некорректен.
   */
  private normalize(error: unknown): E {
    try {
      return this.onError(error);
    } catch {
      return error as E;
    }
  }

  /**
   * Трансформирует успешное значение асинхронно
   *
   * @param fn - Async функция для трансформации значения
   * @returns Новый AsyncResultChain
   *
   * @remarks
   * Автоматически перехватывает исключения из fn и преобразует их в `Err`
   * через normalizer onError. Promise цепочки остаётся resolved (не rejected).
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
        try {
          const newValue = await fn(result.value);
          return Ok(newValue) as Result<U, E>;
        } catch (error) {
          return Err(this.normalize(error)) as Result<U, E>;
        }
      }
      return result as Result<U, E>;
    });
    return this.chain(newPromise);
  }

  /**
   * Трансформирует успешное значение синхронно (safe по умолчанию)
   *
   * @param fn - Функция для трансформации значения
   * @returns Новый AsyncResultChain
   *
   * @remarks
   * Автоматически перехватывает исключения из fn и преобразует их в `Err`
   * через normalizer onError. Promise цепочки остаётся resolved (не rejected).
   *
   * Для поведения при котором исключение → rejected Promise используйте `mapUnsafe`.
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
        try {
          return Ok(fn(result.value)) as Result<U, E>;
        } catch (error) {
          return Err(this.normalize(error)) as Result<U, E>;
        }
      }
      return result as Result<U, E>;
    });
    return this.chain(newPromise);
  }

  /**
   * Трансформирует успешное значение синхронно (небезопасная версия)
   *
   * @param fn - Функция для трансформации значения
   * @returns Новый AsyncResultChain
   *
   * @remarks
   * ⚠️ Если fn выбросит исключение, Promise будет rejected.
   * Это небезопасная версия `map`. Для автоматического перехвата исключений
   * используйте `map` (safe по умолчанию) или `mapAsync`.
   *
   * Предназначен для случаев когда rejected Promise является желаемым поведением
   * (например, если исключение из callback должно прервать всю цепочку).
   *
   * @example
   * ```typescript
   * const result = AsyncResult.from(getUser('123'))
   *   .mapUnsafe(user => user.name); // rejected если fn бросает
   * ```
   */
  mapUnsafe<U>(fn: (value: T) => U): AsyncResultChain<U, E> {
    const newPromise = this.promise.then((result) => {
      if (result.ok) {
        return Ok(fn(result.value)) as Result<U, E>;
      }
      return result as Result<U, E>;
    });
    return this.chain(newPromise);
  }

  /**
   * Цепочка async Result-возвращающих операций
   *
   * @param fn - Async функция возвращающая Result
   * @returns Новый AsyncResultChain
   *
   * @remarks
   * Автоматически перехватывает исключения из fn и преобразует их в `Err`
   * через normalizer onError. Promise цепочки остаётся resolved (не rejected).
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
    const normalizer = (e: unknown): E | F => this.normalize(e);
    const newPromise = this.promise.then(async (result) => {
      if (result.ok) {
        try {
          return (await fn(result.value)) as Result<U, E | F>;
        } catch (error) {
          return Err(normalizer(error)) as Result<U, E | F>;
        }
      }
      return result as Result<U, E | F>;
    });
    return new AsyncResultChain<U, E | F>(newPromise, normalizer);
  }

  /**
   * Цепочка sync Result-возвращающих операций
   *
   * @param fn - Функция возвращающая Result
   * @returns Новый AsyncResultChain
   *
   * @remarks
   * Автоматически перехватывает исключения из fn и преобразует их в `Err`
   * через normalizer onError. Promise цепочки остаётся resolved (не rejected).
   *
   * @example
   * ```typescript
   * const result = AsyncResult.from(getUser('123'))
   *   .flatMap(user => validateAge(user.age));
   * ```
   */
  flatMap<U, F>(fn: (value: T) => Result<U, F>): AsyncResultChain<U, E | F> {
    const normalizer = (e: unknown): E | F => this.normalize(e);
    const newPromise = this.promise.then((result) => {
      if (result.ok) {
        try {
          return fn(result.value) as Result<U, E | F>;
        } catch (error) {
          return Err(normalizer(error)) as Result<U, E | F>;
        }
      }
      return result as Result<U, E | F>;
    });
    return new AsyncResultChain<U, E | F>(newPromise, normalizer);
  }

  /**
   * Трансформирует ошибку асинхронно
   *
   * @param fn - Async функция для трансформации ошибки
   * @returns AsyncResultChain с трансформированной ошибкой
   *
   * @remarks
   * Автоматически перехватывает исключения из fn и преобразует их в `Err<F>`
   * через normalizer onError. Promise цепочки остаётся resolved (не rejected).
   *
   * @example
   * ```typescript
   * const result = AsyncResult.from(fetchData())
   *   .mapErrAsync(err => enrichErrorWithContext(err));
   * ```
   */
  mapErrAsync<F>(fn: (error: E) => Promise<F>): AsyncResultChain<T, F> {
    // Используем chain normalizer для F, приводя E → F через as unknown as F.
    // Это единственный доступный normalizer; честнее, чем e as F без нормализации.
    const normalizerF = (e: unknown): F => this.normalize(e) as unknown as F;
    const newPromise = this.promise.then(async (result) => {
      if (!result.ok) {
        try {
          const newError = await fn(result.error);
          return Err(newError) as Result<T, F>;
        } catch (error) {
          return Err(normalizerF(error)) as Result<T, F>;
        }
      }
      return result as Result<T, F>;
    });
    return new AsyncResultChain<T, F>(newPromise, normalizerF);
  }

  /**
   * Трансформирует ошибку синхронно
   *
   * @param fn - Функция для трансформации ошибки
   * @returns AsyncResultChain с трансформированной ошибкой
   *
   * @remarks
   * Автоматически перехватывает исключения из fn и преобразует их в `Err<F>`
   * через normalizer onError. Promise цепочки остаётся resolved (не rejected).
   *
   * @example
   * ```typescript
   * const result = AsyncResult.from(fetchData())
   *   .mapErr(err => `Failed: ${err}`);
   * ```
   */
  mapErr<F>(fn: (error: E) => F): AsyncResultChain<T, F> {
    // Используем chain normalizer для F, приводя E → F через as unknown as F.
    // Это единственный доступный normalizer; честнее, чем e as F без нормализации.
    const normalizerF = (e: unknown): F => this.normalize(e) as unknown as F;
    const newPromise = this.promise.then((result) => {
      if (!result.ok) {
        try {
          return Err(fn(result.error)) as Result<T, F>;
        } catch (error) {
          return Err(normalizerF(error)) as Result<T, F>;
        }
      }
      return result as Result<T, F>;
    });
    return new AsyncResultChain<T, F>(newPromise, normalizerF);
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
   * @remarks
   * Если callback fn бросает исключение, оно пробрасывается как есть (без обёртки).
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
    if (result.ok) {
      return result.value;
    }
    return fn(result.error);
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
   * Выполняет функцию для side effects при успехе, возвращает this
   *
   * @param fn - Функция для выполнения (получает value если Ok)
   * @returns this для продолжения цепочки
   *
   * @remarks
   * ⚠️ Если fn выбросит исключение, Promise будет rejected.
   * tap предназначен для side-effects. Исключение в tap означает баг в логике пользователя.
   * Для обработки ошибок в tap используйте try/catch внутри fn.
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
    return this.chain(newPromise);
  }

  /**
   * Выполняет функцию для side effects при ошибке, возвращает this
   *
   * @param fn - Функция для выполнения (получает error если Err)
   * @returns this для продолжения цепочки
   *
   * @remarks
   * ⚠️ Если fn выбросит исключение, Promise будет rejected.
   * tapErr предназначен для side-effects. Исключение в tapErr означает баг в логике пользователя.
   * Для обработки ошибок в tapErr используйте try/catch внутри fn.
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
    return this.chain(newPromise);
  }

  /**
   * Pattern matching для Result
   *
   * @param handlers - Объект с обработчиками ok и err
   * @returns Promise с результатом выполнения соответствующего обработчика
   *
   * @remarks
   * ⚠️ Если handler бросит исключение, Promise будет rejected.
   * match — это терминальная операция для извлечения значения, не transform-метод.
   *
   * Исключение из handler перехватывается и пробрасывается как новый `Error`
   * с сообщением `"Exception in match handler: <оригинальное значение>"`.
   * Это изменяет тип и стек исходной ошибки — не следует полагаться на исходный тип exception.
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
    try {
      return result.ok ? await handlers.ok(result.value) : await handlers.err(result.error);
    } catch (error) {
      throw new Error(`Exception in match handler: ${formatValue(error)}`);
    }
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
    const normalizer = (e: unknown): E | F => this.normalize(e);
    const newPromise = this.promise.then((result) => {
      if (result.ok) {
        return other as Result<U, E | F>;
      }
      return result as Result<U, E | F>;
    });
    return new AsyncResultChain<U, E | F>(newPromise, normalizer);
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
    // Предотвращаем unhandledRejection когда берётся ветка Err (short-circuit),
    // и other никогда не awaiting-ся.
    void other.catch(() => {});
    const normalizer = (e: unknown): E | F => this.normalize(e);
    const newPromise = this.promise.then(async (result) => {
      if (result.ok) {
        return (await other) as Result<U, E | F>;
      }
      return result as Result<U, E | F>;
    });
    return new AsyncResultChain<U, E | F>(newPromise, normalizer);
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
    const normalizerF = (e: unknown): F => this.normalize(e) as unknown as F;
    const newPromise = this.promise.then((result) => {
      if (result.ok) {
        return result as Result<T, F>;
      }
      return other;
    });
    return new AsyncResultChain<T, F>(newPromise, normalizerF);
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
    // Предотвращаем unhandledRejection когда берётся ветка Ok (short-circuit),
    // и other никогда не awaiting-ся.
    void other.catch(() => {});
    const normalizerF = (e: unknown): F => this.normalize(e) as unknown as F;
    const newPromise = this.promise.then(async (result) => {
      if (result.ok) {
        return result as Result<T, F>;
      }
      return await other;
    });
    return new AsyncResultChain<T, F>(newPromise, normalizerF);
  }

  /**
   * Возвращает первый Ok, иначе lazy async fallback
   *
   * @param fn - Функция возвращающая Promise<Result> (вызывается только при Err)
   * @returns this если ok = true, иначе результат fn()
   *
   * @remarks
   * В отличие от orAsync, принимает фабричную функцию которая вызывается
   * только когда результат — Err. Это позволяет избежать ненужных side-effects
   * и вычислений если основной результат успешный.
   *
   * Исключения из fn перехватываются и преобразуются в Err через normalizer.
   *
   * @example
   * ```typescript
   * const result = await AsyncResult.from(primarySource())
   *   .orAsyncLazy(() => expensiveFallbackSource())  // Вызовется только при Err
   *   .unwrap();
   * ```
   */
  orAsyncLazy<F>(fn: () => Promise<Result<T, F>>): AsyncResultChain<T, F> {
    const normalizer = (e: unknown): F => this.normalize(e) as unknown as F;
    const newPromise = this.promise.then(async (result) => {
      if (result.ok) {
        return result as Result<T, F>;
      }
      try {
        return await fn();
      } catch (error) {
        return Err(normalizer(error)) as Result<T, F>;
      }
    });
    return new AsyncResultChain<T, F>(newPromise, normalizer);
  }

  /**
   * Recovery при ошибке через async функцию
   *
   * @param fn - Async функция для обработки ошибки
   * @returns AsyncResultChain с восстановленным значением или новой ошибкой
   *
   * @remarks
   * Исключения из fn перехватываются и преобразуются в Err через normalizer.
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
    const normalizer = (e: unknown): F => this.normalize(e) as unknown as F;
    const newPromise = this.promise.then(async (result) => {
      if (result.ok) {
        return result as Result<T, F>;
      }
      try {
        return await fn(result.error);
      } catch (error) {
        return Err(normalizer(error)) as Result<T, F>;
      }
    });
    return new AsyncResultChain<T, F>(newPromise, normalizer);
  }

  /**
   * Recovery при ошибке через sync функцию
   *
   * @param fn - Функция для обработки ошибки
   * @returns AsyncResultChain с восстановленным значением или новой ошибкой
   *
   * @remarks
   * Исключения из fn перехватываются и преобразуются в Err через normalizer.
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
    const normalizer = (e: unknown): F => this.normalize(e) as unknown as F;
    const newPromise = this.promise.then((result) => {
      if (result.ok) {
        return result as Result<T, F>;
      }
      try {
        return fn(result.error);
      } catch (error) {
        return Err(normalizer(error)) as Result<T, F>;
      }
    });
    return new AsyncResultChain<T, F>(newPromise, normalizer);
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
 * import { AsyncResult } from '@polymarket/result';
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
   *
   * @remarks
   * Автоматически перехватывает Promise rejections и преобразует их в Err.
   * Если Promise реджектится, rejection будет обёрнут в Err<E>.
   * Параметр `onReject` позволяет безопасно трансформировать unknown error в E.
   * Без `onReject`: если E = unknown — корректно; если E — конкретный тип,
   * нужно указать normalizer для type safety.
   *
   * @param promise - Promise<Result<T, E>> для оборачивания
   * @param onReject - Опциональная функция для трансформации rejection в E
   * @returns AsyncResultChain<T, E>
   *
   * @example
   * ```typescript
   * // Базовое использование (E = string)
   * const result1 = await AsyncResult.from(fetchUser('123')).unwrap();
   *
   * // С normalizer для type safety:
   * const result2 = await AsyncResult.from(
   *   Promise.reject('Network error'),
   *   (error) => new Error(String(error))
   * ).unwrapErr();
   * // result2: Error('Network error')
   * ```
   */
  from: (<T, E>(
    promise: Promise<Result<T, E>>,
    onReject?: (error: unknown) => E
  ): AsyncResultChain<T, E> => {
    const safePromise = promise.catch((error) => {
      if (onReject) {
        // Защищаем от исключений в onReject: если onReject бросает,
        // оборачиваем брошенное значение в Err чтобы Promise оставался resolved.
        try {
          return Err(onReject(error)) as Result<T, E>;
        } catch (onRejectError) {
          return Err(onRejectError as E) as Result<T, E>;
        }
      }
      return Err(error as E) as Result<T, E>;
    });
    return new AsyncResultChain(safePromise, onReject);
  }) as {
    /**
     * Без normalizer — тип ошибки из Promise<Result<T,E>>.
     * ⚠️ Promise rejections обёртываются через `error as E` (небезопасный каст).
     * Если E = unknown — корректно. Если E — конкретный тип, rejections не будут
     * честно нормализованы; используйте перегрузку с onReject для type safety.
     */
    <T, E>(promise: Promise<Result<T, E>>): AsyncResultChain<T, E>;
    /**
     * С normalizer — E определяется возвращаемым типом onReject.
     * Гарантирует type-safe обработку Promise rejections.
     */
    <T, E>(promise: Promise<Result<T, E>>, onReject: (error: unknown) => E): AsyncResultChain<T, E>;
  },

  /**
   * Создаёт AsyncResultChain из Promise<T> (оборачивает в Ok)
   *
   * @remarks
   * Автоматически перехватывает Promise rejections и преобразует их в Err.
   * Параметр `onError` позволяет трансформировать ошибку в конкретный тип.
   *
   * @param promise - Promise для оборачивания
   * @param onError - Опциональная функция для трансформации ошибки
   *
   * @example
   * ```typescript
   * // Базовое использование (E = unknown):
   * const result = await AsyncResult.ok(fetch('/api/user')).unwrap();
   *
   * // С трансформацией ошибки:
   * const result = await AsyncResult.ok(
   *   fetch('/api/user'),
   *   (error) => new NetworkError(error)
   * ).unwrap();
   * ```
   */
  ok: (<T, E = unknown>(
    promise: Promise<T>,
    onError?: (error: unknown) => E
  ): AsyncResultChain<T, E> => {
    const mapError = onError ?? ((error) => error as E);

    return new AsyncResultChain(
      promise.then((value) => Ok(value)).catch((error) => {
        // Защищаем от исключений в mapError: если mapError бросает,
        // оборачиваем брошенное значение в Err чтобы Promise оставался resolved.
        try {
          return Err(mapError(error));
        } catch (mapErrorError) {
          return Err(mapErrorError as E);
        }
      }),
      mapError
    );
  }) as {
    /**
     * Без normalizer — E = unknown (rejection reason неизвестен).
     */
    <T>(promise: Promise<T>): AsyncResultChain<T, unknown>;
    /**
     * С normalizer — E определяется возвращаемым типом onError.
     * Гарантирует type-safe обработку Promise rejections.
     */
    <T, E>(promise: Promise<T>, onError: (error: unknown) => E): AsyncResultChain<T, E>;
  },

  /**
   * Создаёт AsyncResultChain с ошибкой (для симметрии API)
   */
  err: <E>(error: E): AsyncResultChain<never, E> => {
    return new AsyncResultChain(Promise.resolve(Err(error)));
  },
} as const;
