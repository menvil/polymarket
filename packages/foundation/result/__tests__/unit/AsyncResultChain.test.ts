/**
 * Тесты для AsyncResultChain (async wrapper для Promise<Result<T, E>>)
 */

import { describe, it, expect } from '@jest/globals';
import { AsyncResult } from '../../src/AsyncResultChain';
import { Ok, Err, Result } from '../../src/result';

describe('AsyncResultChain', () => {
  describe('AsyncResult.from()', () => {
    it('должен создавать AsyncResultChain из Promise<Result>', async () => {
      const result = await AsyncResult.from(Promise.resolve(Ok(42))).unwrap();

      expect(result).toBe(42);
    });

    it('должен обрабатывать Err', async () => {
      const result = await AsyncResult.from(Promise.resolve(Err('error'))).unwrapErr();

      expect(result).toBe('error');
    });

    it('должен ловить Promise.reject с onReject трансформацией', async () => {
      const rejectedPromise = Promise.reject('Network error');

      const result = await AsyncResult.from(
        rejectedPromise as Promise<Result<number, Error>>,
        (error) => new Error(String(error))
      ).unwrapErr();

      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('Network error');
    });

    it('должен ловить Promise.reject без onReject (type assertion)', async () => {
      const rejectedPromise = Promise.reject('Failed');

      const result = await AsyncResult.from<number, string>(
        rejectedPromise as Promise<Result<number, string>>
      ).unwrapErr();

      expect(result).toBe('Failed');
    });

    it('должен ловить Promise.reject с Error объектом', async () => {
      const error = new Error('Something went wrong');
      const rejectedPromise = Promise.reject(error);

      const result = await AsyncResult.from<number, Error>(
        rejectedPromise as Promise<Result<number, Error>>
      ).unwrapErr();

      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('Something went wrong');
    });
  });

  describe('AsyncResult.ok()', () => {
    it('должен создавать AsyncResultChain из Promise<T>', async () => {
      const result = await AsyncResult.ok(Promise.resolve(42)).unwrap();

      expect(result).toBe(42);
    });

    it('должен работать с разными типами', async () => {
      const number = await AsyncResult.ok(Promise.resolve(123)).unwrap();
      const string = await AsyncResult.ok(Promise.resolve('hello')).unwrap();

      expect(number).toBe(123);
      expect(string).toBe('hello');
    });

    it('должен ловить Promise.reject и преобразовывать в Err', async () => {
      const rejectedPromise = Promise.reject('Network error');

      const result = await AsyncResult.ok(rejectedPromise).unwrapErr();

      expect(result).toBe('Network error');
    });

    it('должен ловить Promise.reject с onError трансформацией', async () => {
      const rejectedPromise = Promise.reject('Network error');

      const result = await AsyncResult.ok(
        rejectedPromise,
        (error) => new Error(String(error))
      ).unwrapErr();

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe('Network error');
    });

    it('должен ловить Promise.reject с Error объектом', async () => {
      const error = new Error('Something went wrong');
      const rejectedPromise = Promise.reject(error);

      const result = await AsyncResult.ok(rejectedPromise).unwrapErr();

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe('Something went wrong');
    });
  });

  describe('AsyncResult.err()', () => {
    it('должен создавать AsyncResultChain с ошибкой', async () => {
      const error = await AsyncResult.err('error').unwrapErr();

      expect(error).toBe('error');
    });
  });

  describe('Метод mapAsync()', () => {
    it('должен трансформировать значение асинхронно', async () => {
      const fetchUser = async (id: number) => ({ id, name: 'John' });

      const result = await AsyncResult.ok(Promise.resolve(123))
        .mapAsync(fetchUser)
        .unwrap();

      expect(result.id).toBe(123);
      expect(result.name).toBe('John');
    });

    it('должен поддерживать цепочку mapAsync', async () => {
      const double = async (x: number) => x * 2;
      const addOne = async (x: number) => x + 1;

      const result = await AsyncResult.ok(Promise.resolve(5))
        .mapAsync(double)
        .mapAsync(addOne)
        .unwrap();

      expect(result).toBe(11);
    });

    it('должен пропускать ошибку', async () => {
      let called = false;

      const result = await AsyncResult.err('error')
        .mapAsync(async (x) => {
          called = true;
          return x * 2;
        })
        .unwrapErr();

      expect(called).toBe(false);
      expect(result).toBe('error');
    });

    it('должен ловить exceptions из async функции и преобразовывать в Err', async () => {
      const throwingFn = async (_x: number) => {
        throw new Error('Transformation failed');
      };

      const result = await AsyncResult.ok(Promise.resolve(42))
        .mapAsync(throwingFn)
        .unwrapErr();

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe('Transformation failed');
    });

    it('должен ловить Promise rejection из async функции и преобразовывать в Err', async () => {
      const rejectingFn = async (_x: number) => {
        return Promise.reject(new Error('Async operation failed'));
      };

      const result = await AsyncResult.ok(Promise.resolve(42))
        .mapAsync(rejectingFn)
        .unwrapErr();

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe('Async operation failed');
    });
  });

  describe('Метод map()', () => {
    it('должен трансформировать значение синхронно', async () => {
      const result = await AsyncResult.ok(Promise.resolve(5))
        .map((x) => x * 2)
        .unwrap();

      expect(result).toBe(10);
    });

    it('должен поддерживать цепочку map и mapAsync', async () => {
      const double = async (x: number) => x * 2;

      const result = await AsyncResult.ok(Promise.resolve(5))
        .map((x) => x + 1)
        .mapAsync(double)
        .map((x) => x.toString())
        .unwrap();

      expect(result).toBe('12');
    });

    it('должен перехватить throw из fn и вернуть Err (safe по умолчанию)', async () => {
      const result = await AsyncResult.ok(Promise.resolve(5))
        .map((x) => {
          if (x === 5) throw new Error('map threw');
          return x * 2;
        })
        .toPromise();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
        expect((result.error as Error).message).toBe('map threw');
      }
    });
  });

  describe('Метод mapUnsafe()', () => {
    it('должен трансформировать значение синхронно', async () => {
      const result = await AsyncResult.ok(Promise.resolve(5))
        .mapUnsafe((x) => x * 2)
        .unwrap();

      expect(result).toBe(10);
    });

    it('должен стать rejected Promise если fn бросает', async () => {
      const chain = AsyncResult.ok(Promise.resolve(5))
        .mapUnsafe((x) => {
          throw new Error(`mapUnsafe throw: ${x}`);
        });

      await expect(chain.toPromise()).rejects.toThrow('mapUnsafe throw: 5');
    });

    it('должен пропускать Err (fn не вызывается)', async () => {
      let called = false;
      const result = await AsyncResult.err('error')
        .mapUnsafe(() => {
          called = true;
          return 99;
        })
        .toPromise();

      expect(called).toBe(false);
      expect(result.ok).toBe(false);
    });
  });

  describe('Метод flatMapAsync()', () => {
    const fetchUser = async (id: number): Promise<Result<{ id: number; name: string }, string>> => {
      if (id === 0) return Err('User not found');
      return Ok({ id, name: 'John' });
    };

    it('должен цеплять async Result-операции', async () => {
      const result = await AsyncResult.ok(Promise.resolve(123))
        .flatMapAsync(fetchUser)
        .unwrap();

      expect(result.name).toBe('John');
    });

    it('должен возвращать первую ошибку', async () => {
      const result = await AsyncResult.ok(Promise.resolve(0))
        .flatMapAsync(fetchUser)
        .unwrapErr();

      expect(result).toBe('User not found');
    });

    it('должен пропускать операцию если исходный Result - ошибка', async () => {
      let called = false;

      const result = await AsyncResult.err('initial error')
        .flatMapAsync(async (x) => {
          called = true;
          return fetchUser(x);
        })
        .unwrapErr();

      expect(called).toBe(false);
      expect(result).toBe('initial error');
    });

    it('должен ловить exceptions из async Result функции и преобразовывать в Err', async () => {
      const throwingFn = async (_x: number): Promise<Result<string, Error>> => {
        throw new Error('FlatMap transformation failed');
      };

      const result = await AsyncResult.ok(Promise.resolve(42))
        .flatMapAsync(throwingFn)
        .unwrapErr();

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe('FlatMap transformation failed');
    });

    it('должен ловить Promise rejection из async Result функции и преобразовывать в Err', async () => {
      const rejectingFn = async (_x: number): Promise<Result<string, Error>> => {
        return Promise.reject(new Error('FlatMap async operation failed'));
      };

      const result = await AsyncResult.ok(Promise.resolve(42))
        .flatMapAsync(rejectingFn)
        .unwrapErr();

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe('FlatMap async operation failed');
    });
  });

  describe('Метод flatMap()', () => {
    const divide = (a: number, b: number): Result<number, string> =>
      b === 0 ? Err('Division by zero') : Ok(a / b);

    it('должен цеплять sync Result-операции', async () => {
      const result = await AsyncResult.ok(Promise.resolve(10))
        .flatMap((x) => divide(x, 2))
        .flatMap((x) => divide(x, 5))
        .unwrap();

      expect(result).toBe(1);
    });

    it('должен возвращать ошибку', async () => {
      const result = await AsyncResult.ok(Promise.resolve(10))
        .flatMap((x) => divide(x, 0))
        .unwrapErr();

      expect(result).toBe('Division by zero');
    });

    it('должен пропускать операцию если исходный Result - ошибка', async () => {
      let called = false;
      const errorResult: Result<number, string> = Err('initial error');

      const result = await AsyncResult.from(Promise.resolve(errorResult))
        .flatMap((x) => {
          called = true;
          return divide(x, 2);
        })
        .unwrapErr();

      expect(called).toBe(false);
      expect(result).toBe('initial error');
    });

    it('должен ловить exceptions из sync Result функции и преобразовывать в Err', async () => {
      const throwingFn = (_x: number): Result<string, Error> => {
        throw new Error('FlatMap sync transformation failed');
      };

      const result = await AsyncResult.ok(Promise.resolve(42))
        .flatMap(throwingFn)
        .unwrapErr();

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe('FlatMap sync transformation failed');
    });
  });

  describe('Метод mapErrAsync()', () => {
    it('должен трансформировать ошибку асинхронно', async () => {
      const enrichError = async (err: string) => `Enriched: ${err}`;

      const result = await AsyncResult.err('error')
        .mapErrAsync(enrichError)
        .unwrapErr();

      expect(result).toBe('Enriched: error');
    });

    it('не должен вызывать функцию для Ok', async () => {
      let called = false;

      const result = await AsyncResult.ok(Promise.resolve(42))
        .mapErrAsync(async (err) => {
          called = true;
          return err;
        })
        .unwrap();

      expect(called).toBe(false);
      expect(result).toBe(42);
    });

    it('должен ловить exceptions из async error transformation и преобразовывать в Err', async () => {
      const throwingTransform = async (_err: string) => {
        throw new Error('Error transformation failed');
      };

      const result = await AsyncResult.err('original error')
        .mapErrAsync(throwingTransform)
        .unwrapErr();

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe('Error transformation failed');
    });

    it('должен ловить Promise rejection из async error transformation и преобразовывать в Err', async () => {
      const rejectingTransform = async (_err: string) => {
        return Promise.reject(new Error('Async error transformation failed'));
      };

      const result = await AsyncResult.err('original error')
        .mapErrAsync(rejectingTransform)
        .unwrapErr();

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe('Async error transformation failed');
    });

    it('при throw внутри async callback возвращает сырое исключение (не E-normalizer)', async () => {
      type AppError = { code: string };
      const normalizer = (e: unknown): AppError => ({ code: `NORM:${String(e)}` });

      const result = await AsyncResult.from(
        Promise.resolve(Err('original') as Result<number, AppError>),
        normalizer
      )
        .mapErrAsync(async (_err: AppError): Promise<string> => {
          throw new Error('mapErrAsync threw');
        })
        .unwrapErr();

      // E-normalizer НЕ вызывается для F — возвращается сырое исключение
      expect(result).toBeInstanceOf(Error);
      expect((result as unknown as Error).message).toBe('mapErrAsync threw');
    });
  });

  describe('Метод mapErr()', () => {
    it('должен трансформировать ошибку синхронно', async () => {
      const result = await AsyncResult.err({ code: 404, message: 'Not found' })
        .mapErr((err) => err.message)
        .unwrapErr();

      expect(result).toBe('Not found');
    });

    it('не должен вызывать функцию для Ok', async () => {
      let called = false;

      const result = await AsyncResult.ok(Promise.resolve(42))
        .mapErr((err) => {
          called = true;
          return err;
        })
        .unwrap();

      expect(called).toBe(false);
      expect(result).toBe(42);
    });

    it('должен ловить exceptions из sync error transformation и преобразовывать в Err', async () => {
      const throwingTransform = (_err: string) => {
        throw new Error('Sync error transformation failed');
      };

      const result = await AsyncResult.err('original error')
        .mapErr(throwingTransform)
        .unwrapErr();

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe('Sync error transformation failed');
    });

    it('при throw внутри callback возвращает сырое исключение (не E-normalizer)', async () => {
      type AppError = { code: string };
      const normalizer = (e: unknown): AppError => ({ code: `NORM:${String(e)}` });

      const result = await AsyncResult.from(
        Promise.resolve(Err('original') as Result<number, AppError>),
        normalizer
      )
        .mapErr((_err: AppError): string => {
          throw new Error('mapErr threw');
        })
        .unwrapErr();

      // E-normalizer НЕ вызывается для F — возвращается сырое исключение
      expect(result).toBeInstanceOf(Error);
      expect((result as unknown as Error).message).toBe('mapErr threw');
    });

    it('последующие шаги после mapErr используют e as F normalizer', async () => {
      type AppError = { code: string };
      const normalizer = (e: unknown): AppError => ({ code: `NORM:${String(e)}` });
      const thrownError = new Error('map after mapErr threw');

      // Начинаем с Ok, чтобы map() вызвал fn и бросил исключение.
      // mapErr — no-op для Ok, но меняет тип нормализатора цепочки на F=string.
      const result = await AsyncResult.from(
        Promise.resolve(Ok(42) as Result<number, AppError>),
        normalizer
      )
        .mapErr((err: AppError) => err.code)
        .map((_v) => {
          throw thrownError;
        })
        .toPromise();

      expect(result.ok).toBe(false);
      // normalizerF после mapErr = (e) => e as F, поэтому error — сырое исключение
      if (!result.ok) {
        expect(result.error).toBe(thrownError);
      }
    });
  });

  describe('Метод unwrap()', () => {
    it('должен извлекать значение из Ok', async () => {
      const value = await AsyncResult.ok(Promise.resolve(42)).unwrap();

      expect(value).toBe(42);
    });

    it('должен выбрасывать ошибку для Err', async () => {
      await expect(AsyncResult.err('error').unwrap()).rejects.toThrow(
        'Called unwrap on Err result: error'
      );
    });
  });

  describe('Метод unwrapOr()', () => {
    it('должен извлекать значение из Ok', async () => {
      const value = await AsyncResult.ok(Promise.resolve(42)).unwrapOr(0);

      expect(value).toBe(42);
    });

    it('должен возвращать fallback для Err', async () => {
      const errorResult: Result<number, string> = Err('error');
      const value = await AsyncResult.from(Promise.resolve(errorResult)).unwrapOr(0);

      expect(value).toBe(0);
    });
  });

  describe('Метод unwrapOrElse()', () => {
    it('должен извлекать значение из Ok', async () => {
      const value = await AsyncResult.ok(Promise.resolve(42)).unwrapOrElse(() => 0);

      expect(value).toBe(42);
    });

    it('должен вычислять fallback для Err', async () => {
      const errorResult: Result<number, string> = Err('error');
      const value = await AsyncResult.from(Promise.resolve(errorResult)).unwrapOrElse((err) => {
        return err.length;
      });

      expect(value).toBe(5); // "error".length === 5
    });

    it('должен ловить exceptions из fallback функции и reject с wrapped message', async () => {
      const throwingFallback = (_err: string): number => {
        throw new Error('Fallback computation failed');
      };

      const errorResult: Result<number, string> = Err('error');
      await expect(
        AsyncResult.from(Promise.resolve(errorResult)).unwrapOrElse(throwingFallback)
      ).rejects.toThrow('Fallback computation failed');
    });
  });

  describe('Метод unwrapErr()', () => {
    it('должен извлекать ошибку из Err', async () => {
      const error = await AsyncResult.err('error').unwrapErr();

      expect(error).toBe('error');
    });

    it('должен выбрасывать ошибку для Ok', async () => {
      await expect(AsyncResult.ok(Promise.resolve(42)).unwrapErr()).rejects.toThrow(
        'Called unwrapErr on Ok result: 42'
      );
    });
  });

  describe('Метод isOk()', () => {
    it('должен возвращать true для Ok', async () => {
      const isOk = await AsyncResult.ok(Promise.resolve(42)).isOk();

      expect(isOk).toBe(true);
    });

    it('должен возвращать false для Err', async () => {
      const isOk = await AsyncResult.err('error').isOk();

      expect(isOk).toBe(false);
    });
  });

  describe('Метод isErr()', () => {
    it('должен возвращать true для Err', async () => {
      const isErr = await AsyncResult.err('error').isErr();

      expect(isErr).toBe(true);
    });

    it('должен возвращать false для Ok', async () => {
      const isErr = await AsyncResult.ok(Promise.resolve(42)).isErr();

      expect(isErr).toBe(false);
    });
  });

  describe('Метод tap()', () => {
    it('должен выполнять side effect для Ok', async () => {
      let value = 0;

      const result = await AsyncResult.ok(Promise.resolve(42))
        .tap((x) => {
          value = x;
        })
        .unwrap();

      expect(value).toBe(42);
      expect(result).toBe(42);
    });

    it('должен поддерживать async side effect', async () => {
      const logs: number[] = [];

      const result = await AsyncResult.ok(Promise.resolve(42))
        .tap(async (x) => {
          logs.push(x);
        })
        .unwrap();

      expect(logs).toEqual([42]);
      expect(result).toBe(42);
    });

    it('не должен выполнять side effect для Err', async () => {
      let called = false;

      const result = await AsyncResult.err('error')
        .tap(() => {
          called = true;
        })
        .unwrapErr();

      expect(called).toBe(false);
      expect(result).toBe('error');
    });
  });

  describe('Метод tapErr()', () => {
    it('должен выполнять side effect для Err', async () => {
      let error = '';

      const result = await AsyncResult.err('oops')
        .tapErr((err) => {
          error = err;
        })
        .unwrapErr();

      expect(error).toBe('oops');
      expect(result).toBe('oops');
    });

    it('не должен выполнять side effect для Ok', async () => {
      let called = false;

      const result = await AsyncResult.ok(Promise.resolve(42))
        .tapErr(() => {
          called = true;
        })
        .unwrap();

      expect(called).toBe(false);
      expect(result).toBe(42);
    });
  });

  describe('Метод match()', () => {
    it('должен вызывать ok handler для Ok', async () => {
      const message = await AsyncResult.ok(Promise.resolve(42)).match({
        ok: (value) => `Успех: ${value}`,
        err: (error) => `Ошибка: ${error}`,
      });

      expect(message).toBe('Успех: 42');
    });

    it('должен вызывать err handler для Err', async () => {
      const message = await AsyncResult.err('oops').match({
        ok: (value) => `Успех: ${value}`,
        err: (error) => `Ошибка: ${error}`,
      });

      expect(message).toBe('Ошибка: oops');
    });

    it('должен поддерживать async handlers', async () => {
      const result = await AsyncResult.ok(Promise.resolve(42)).match({
        ok: async (value) => {
          await Promise.resolve();
          return value * 2;
        },
        err: () => 0,
      });

      expect(result).toBe(84);
    });

    it('должен ловить exceptions из ok handler и reject с wrapped message', async () => {
      const throwingOkHandler = (_value: number): string => {
        throw new Error('Ok handler failed');
      };

      await expect(
        AsyncResult.ok(Promise.resolve(42)).match({
          ok: throwingOkHandler,
          err: () => 'error',
        })
      ).rejects.toThrow('Ok handler failed');
    });

    it('должен ловить exceptions из err handler и reject с wrapped message', async () => {
      const throwingErrHandler = (_err: string): string => {
        throw new Error('Err handler failed');
      };

      await expect(
        AsyncResult.err('error').match({
          ok: () => 'ok',
          err: throwingErrHandler,
        })
      ).rejects.toThrow('Err handler failed');
    });
  });

  describe('Метод and()', () => {
    it('должен возвращать второй Result если первый Ok', async () => {
      const result = await AsyncResult.ok(Promise.resolve(2))
        .and(Ok(3))
        .unwrap();

      expect(result).toBe(3);
    });

    it('должен возвращать первую ошибку если первый Result - Err', async () => {
      const result = await AsyncResult.err('error1')
        .and(Ok(5))
        .unwrapErr();

      expect(result).toBe('error1');
    });
  });

  describe('Метод andAsync()', () => {
    it('должен работать с async Result', async () => {
      const step2 = async (): Promise<Result<number, string>> => {
        return Ok(42);
      };

      const result = await AsyncResult.ok(Promise.resolve(1))
        .andAsync(step2())
        .unwrap();

      expect(result).toBe(42);
    });

    it('должен возвращать первую ошибку если первый Result - Err', async () => {
      const errorResult: Result<number, string> = Err('error1');
      const step2 = async (): Promise<Result<number, string>> => {
        return Ok(42);
      };

      const result = await AsyncResult.from(Promise.resolve(errorResult))
        .andAsync(step2())
        .unwrapErr();

      expect(result).toBe('error1');
    });
  });

  describe('Метод or()', () => {
    it('должен возвращать первый Result если он Ok', async () => {
      const result = await AsyncResult.ok(Promise.resolve(10))
        .or(Ok(20))
        .unwrap();

      expect(result).toBe(10);
    });

    it('должен возвращать второй Result если первый Err', async () => {
      const errorResult: Result<number, string> = Err('error1');
      const result = await AsyncResult.from(Promise.resolve(errorResult))
        .or(Ok(42))
        .unwrap();

      expect(result).toBe(42);
    });

    it('после .or() последующие шаги используют e as F normalizer (без E-normalizer)', async () => {
      type AppError = { code: string };
      const normalizer = (e: unknown): AppError => ({ code: `NORM:${String(e)}` });
      const thrownError = new Error('after .or threw');

      const result = await AsyncResult.from(
        Promise.resolve(Err('original') as Result<number, AppError>),
        normalizer
      )
        .or(Ok(0))
        .map((_v: number) => {
          throw thrownError;
        })
        .toPromise();

      expect(result.ok).toBe(false);
      // normalizerF после or() = (e) => e as F — не вызывает исходный E-normalizer
      if (!result.ok) {
        expect(result.error).toBe(thrownError);
      }
    });
  });

  describe('Метод orAsync()', () => {
    it('должен работать с async Result', async () => {
      const fallback = async (): Promise<Result<number, string>> => {
        return Ok(99);
      };

      const errorResult: Result<number, string> = Err('error');
      const result = await AsyncResult.from(Promise.resolve(errorResult))
        .orAsync(fallback())
        .unwrap();

      expect(result).toBe(99);
    });

    it('должен возвращать первый Result если он Ok', async () => {
      const fallback = async (): Promise<Result<number, string>> => {
        return Ok(99);
      };

      const result = await AsyncResult.ok(Promise.resolve(10))
        .orAsync(fallback())
        .unwrap();

      expect(result).toBe(10);
    });

    it('после .orAsync() последующие шаги используют e as F normalizer (без E-normalizer)', async () => {
      type AppError = { code: string };
      const normalizer = (e: unknown): AppError => ({ code: `NORM:${String(e)}` });
      const thrownError = new Error('after .orAsync threw');

      const result = await AsyncResult.from(
        Promise.resolve(Err('original') as Result<number, AppError>),
        normalizer
      )
        .orAsync(Promise.resolve(Ok(0) as Result<number, AppError>))
        .map((_v: number) => {
          throw thrownError;
        })
        .toPromise();

      expect(result.ok).toBe(false);
      // normalizerF после orAsync() = (e) => e as F — не вызывает исходный E-normalizer
      if (!result.ok) {
        expect(result.error).toBe(thrownError);
      }
    });
  });

  describe('Метод orAsyncLazy()', () => {
    it('должен вызывать фабрику только при Err', async () => {
      let called = false;
      const fallback = async (): Promise<Result<number, string>> => {
        called = true;
        return Ok(99);
      };

      const errorResult: Result<number, string> = Err('error');
      const result = await AsyncResult.from(Promise.resolve(errorResult))
        .orAsyncLazy(fallback)
        .unwrap();

      expect(called).toBe(true);
      expect(result).toBe(99);
    });

    it('НЕ должен вызывать фабрику если первый Result - Ok', async () => {
      let called = false;
      const fallback = async (): Promise<Result<number, string>> => {
        called = true;
        return Ok(99);
      };

      const result = await AsyncResult.ok(Promise.resolve(10))
        .orAsyncLazy(fallback)
        .unwrap();

      expect(called).toBe(false);
      expect(result).toBe(10);
    });

    it('должен избегать side-effects при Ok', async () => {
      const sideEffects: string[] = [];

      const expensiveOperation = async (): Promise<Result<number, string>> => {
        sideEffects.push('executed');
        await new Promise((resolve) => setTimeout(resolve, 10));
        return Ok(99);
      };

      await AsyncResult.ok(Promise.resolve(42))
        .orAsyncLazy(expensiveOperation)
        .unwrap();

      expect(sideEffects).toEqual([]); // Фабрика не вызвана, side-effects не произошли
    });

    it('должен ловить exceptions из lazy factory и преобразовывать в Err', async () => {
      const throwingFactory = async (): Promise<Result<number, Error>> => {
        throw new Error('Factory failed');
      };

      const errorResult: Result<number, Error> = Err(new Error('original error'));
      const result = await AsyncResult.from(Promise.resolve(errorResult))
        .orAsyncLazy(throwingFactory)
        .unwrapErr();

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe('Factory failed');
    });

    it('должен ловить Promise rejection из lazy factory и преобразовывать в Err', async () => {
      const rejectingFactory = async (): Promise<Result<number, Error>> => {
        return Promise.reject(new Error('Async factory failed'));
      };

      const errorResult: Result<number, Error> = Err(new Error('original error'));
      const result = await AsyncResult.from(Promise.resolve(errorResult))
        .orAsyncLazy(rejectingFactory)
        .unwrapErr();

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe('Async factory failed');
    });
  });

  describe('Метод orElseAsync()', () => {
    it('должен восстанавливать значение асинхронно', async () => {
      const recover = async (_err: string): Promise<Result<number, string>> => {
        return Ok(0);
      };

      const errorResult: Result<number, string> = Err('error');
      const result = await AsyncResult.from(Promise.resolve(errorResult))
        .orElseAsync(recover)
        .unwrap();

      expect(result).toBe(0);
    });

    it('не должен вызывать функцию для Ok', async () => {
      let called = false;

      const result = await AsyncResult.ok(Promise.resolve(42))
        .orElseAsync(async (_err) => {
          called = true;
          return Ok(0);
        })
        .unwrap();

      expect(called).toBe(false);
      expect(result).toBe(42);
    });

    it('должен ловить exceptions из async recovery и преобразовывать в Err', async () => {
      const throwingRecovery = async (_err: Error): Promise<Result<number, Error>> => {
        throw new Error('Recovery failed');
      };

      const errorResult: Result<number, Error> = Err(new Error('original error'));
      const result = await AsyncResult.from(Promise.resolve(errorResult))
        .orElseAsync(throwingRecovery)
        .unwrapErr();

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe('Recovery failed');
    });

    it('должен ловить Promise rejection из async recovery и преобразовывать в Err', async () => {
      const rejectingRecovery = async (_err: Error): Promise<Result<number, Error>> => {
        return Promise.reject(new Error('Async recovery failed'));
      };

      const errorResult: Result<number, Error> = Err(new Error('original error'));
      const result = await AsyncResult.from(Promise.resolve(errorResult))
        .orElseAsync(rejectingRecovery)
        .unwrapErr();

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe('Async recovery failed');
    });
  });

  describe('Метод orElse()', () => {
    it('должен восстанавливать значение синхронно', async () => {
      const errorResult: Result<number, string> = Err('error');
      const result = await AsyncResult.from(Promise.resolve(errorResult))
        .orElse((_err) => Ok(0))
        .unwrap();

      expect(result).toBe(0);
    });

    it('не должен вызывать функцию для Ok', async () => {
      let called = false;

      const result = await AsyncResult.ok(Promise.resolve(42))
        .orElse((_err) => {
          called = true;
          return Ok(0);
        })
        .unwrap();

      expect(called).toBe(false);
      expect(result).toBe(42);
    });

    it('должен ловить exceptions из sync recovery и преобразовывать в Err', async () => {
      const throwingRecovery = (_err: Error): Result<number, Error> => {
        throw new Error('Sync recovery failed');
      };

      const errorResult: Result<number, Error> = Err(new Error('original error'));
      const result = await AsyncResult.from(Promise.resolve(errorResult))
        .orElse(throwingRecovery)
        .unwrapErr();

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe('Sync recovery failed');
    });
  });

  describe('Метод andThen()', () => {
    const fetchUser = async (id: number): Promise<Result<{ id: number; name: string }, string>> => {
      if (id === 0) return Err('User not found');
      return Ok({ id, name: 'John' });
    };

    it('должен работать как алиас для flatMapAsync', async () => {
      const result = await AsyncResult.ok(Promise.resolve(123))
        .andThen(fetchUser)
        .unwrap();

      expect(result.name).toBe('John');
    });

    it('должен возвращать первую ошибку', async () => {
      const result = await AsyncResult.ok(Promise.resolve(0))
        .andThen(fetchUser)
        .unwrapErr();

      expect(result).toBe('User not found');
    });
  });

  describe('Метод expect()', () => {
    it('должен возвращать значение для Ok', async () => {
      const value = await AsyncResult.ok(Promise.resolve(42)).expect('Should be Ok');

      expect(value).toBe(42);
    });

    it('должен выбрасывать ошибку с кастомным сообщением для Err', async () => {
      await expect(
        AsyncResult.err('oops').expect('Failed to get value')
      ).rejects.toThrow('Failed to get value: oops');
    });
  });

  describe('Метод expectErr()', () => {
    it('должен возвращать ошибку для Err', async () => {
      const error = await AsyncResult.err('oops').expectErr('Should be Err');

      expect(error).toBe('oops');
    });

    it('должен выбрасывать ошибку с кастомным сообщением для Ok', async () => {
      await expect(
        AsyncResult.ok(Promise.resolve(42)).expectErr('Expected error')
      ).rejects.toThrow('Expected error: expected Err but got Ok(42)');
    });
  });

  describe('Метод toPromise()', () => {
    it('должен конвертировать в Promise<Result>', async () => {
      const promise = AsyncResult.ok(Promise.resolve(42)).toPromise();
      const result = await promise;

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(42);
      }
    });
  });

  describe('Метод toChain()', () => {
    it('должен конвертировать в ResultChain после await', async () => {
      const chain = await AsyncResult.ok(Promise.resolve(42)).toChain();

      expect(chain.isOk()).toBe(true);
      expect(chain.unwrap()).toBe(42);
    });
  });

  describe('Реальный пример: async операции с Result', () => {
    interface User {
      id: number;
      name: string;
      balance: number;
    }

    const fetchUser = async (id: number): Promise<Result<User, string>> => {
      if (id === 0) return Err('User not found');
      return Ok({ id, name: 'John', balance: 100 });
    };

    const validateBalance = async (user: User, amount: number): Promise<Result<User, string>> => {
      if (user.balance < amount) return Err('Insufficient funds');
      return Ok(user);
    };

    const deductBalance = (user: User, amount: number): User => {
      return { ...user, balance: user.balance - amount };
    };

    it('должен композировать async операции (success case)', async () => {
      const result = await AsyncResult.from(fetchUser(123))
        .flatMapAsync((user) => validateBalance(user, 50))
        .map((user) => deductBalance(user, 50))
        .unwrap();

      expect(result.balance).toBe(50);
    });

    it('должен останавливаться на первой ошибке (user not found)', async () => {
      const result = await AsyncResult.from(fetchUser(0))
        .flatMapAsync((user) => validateBalance(user, 50))
        .map((user) => deductBalance(user, 50))
        .unwrapErr();

      expect(result).toBe('User not found');
    });

    it('должен останавливаться на первой ошибке (insufficient funds)', async () => {
      const result = await AsyncResult.from(fetchUser(123))
        .flatMapAsync((user) => validateBalance(user, 200))
        .map((user) => deductBalance(user, 200))
        .unwrapErr();

      expect(result).toBe('Insufficient funds');
    });

    it('должен использовать fallback при ошибке', async () => {
      const result = await AsyncResult.from(fetchUser(0))
        .flatMapAsync((user) => validateBalance(user, 50))
        .map((user) => deductBalance(user, 50))
        .unwrapOr({ id: 0, name: 'Guest', balance: 0 });

      expect(result.name).toBe('Guest');
    });

    it('должен использовать recovery при ошибке', async () => {
      const result = await AsyncResult.from(fetchUser(0))
        .orElseAsync(async (_err) => {
          // Fallback на guest user
          return Ok({ id: 0, name: 'Guest', balance: 0 });
        })
        .unwrap();

      expect(result.name).toBe('Guest');
    });
  });

  // ============================================================
  // Тесты на unhandledRejection
  // ============================================================
  describe('unhandledRejection защита', () => {
    it('orAsync: rejected fallback не вызывает unhandledRejection когда this — Ok', async () => {
      const rejectedFallback = Promise.reject(new Error('fallback rejected'));

      // Результат остаётся Ok — fallback никогда не awaiting-ся
      const result = await AsyncResult.ok(Promise.resolve(42))
        .orAsync(rejectedFallback as Promise<Result<number, Error>>)
        .toPromise();

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(42);
    });

    it('andAsync: rejected other не вызывает unhandledRejection когда this — Err', async () => {
      const rejectedOther = Promise.reject(new Error('other rejected'));

      // Результат остаётся первая ошибка — other никогда не awaiting-ся
      const result = await AsyncResult.from(
        Promise.resolve(Err('first error') as Result<number, string>)
      )
        .andAsync(rejectedOther as Promise<Result<number, Error>>)
        .toPromise();

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('first error');
    });
  });

  // ============================================================
  // Тесты на ветки когда normalizer/onError сам бросает
  // ============================================================
  describe('AsyncResult.from — onReject сам бросает', () => {
    it('должен завершиться Err без rejected Promise когда onReject бросает', async () => {
      const throwingOnReject = (_err: unknown): Error => {
        throw new Error('onReject failed');
      };

      const result = await AsyncResult.from(
        Promise.reject('original') as Promise<Result<number, Error>>,
        throwingOnReject
      ).toPromise();

      // Promise должен остаться resolved — ошибка из onReject идёт как Err
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
        expect((result.error as Error).message).toBe('onReject failed');
      }
    });
  });

  describe('AsyncResult.ok — onError сам бросает', () => {
    it('должен завершиться Err без rejected Promise когда onError бросает', async () => {
      const throwingOnError = (_err: unknown): Error => {
        throw new Error('onError failed');
      };

      const result = await AsyncResult.ok(
        Promise.reject('original'),
        throwingOnError
      ).toPromise();

      // Promise должен остаться resolved — ошибка из onError идёт как Err
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
        expect((result.error as Error).message).toBe('onError failed');
      }
    });
  });

  // ============================================================
  // normalize() fallback: когда chain normalizer сам бросает
  // внутри transform-метода, fallback — error as E
  // ============================================================
  describe('normalize() fallback когда chain normalizer бросает внутри transform', () => {
    it('map: Promise остаётся resolved если normalizer бросает при обработке throw из fn', async () => {
      let callCount = 0;
      const throwingNormalizer = (_e: unknown): Error => {
        callCount++;
        throw new Error('normalizer itself failed');
      };

      const mapError = new Error('map callback threw');
      const result = await AsyncResult.ok(
        Promise.resolve(42),
        throwingNormalizer
      )
        .map((_v) => {
          throw mapError;
        })
        .toPromise();

      // Promise должен остаться resolved — fallback error as E
      expect(result.ok).toBe(false);
      expect(callCount).toBe(1); // normalizer был вызван (хотя и бросил)
      // fallback: возвращается исходное исключение из callback (error as E), а не из normalizer
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
        expect((result.error as Error).message).toBe('map callback threw');
      }
    });
  });

  // ============================================================
  // E→F методы: поведение normalizer при F ≠ E
  // Когда тип ошибки меняется (E→F), исключения из callback
  // оборачиваются через e as F — без вызова E-normalizer.
  // ============================================================
  describe('E→F методы: normalizer при F ≠ E', () => {
    type AppError = { code: string; tag: 'AppError' };
    const mkNormalizer = () => (e: unknown): AppError => ({
      code: `NORM:${String(e)}`,
      tag: 'AppError',
    });

    it('mapErr: throw в callback → сырое исключение, не E-normalizer', async () => {
      const thrown = new TypeError('mapErr cb threw');
      const result = await AsyncResult.from(
        Promise.resolve(Err('err') as Result<number, AppError>),
        mkNormalizer()
      )
        .mapErr((_e: AppError): string => {
          throw thrown;
        })
        .toPromise();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(thrown);
      }
    });

    it('mapErrAsync: throw в callback → сырое исключение, не E-normalizer', async () => {
      const thrown = new TypeError('mapErrAsync cb threw');
      const result = await AsyncResult.from(
        Promise.resolve(Err('err') as Result<number, AppError>),
        mkNormalizer()
      )
        .mapErrAsync(async (_e: AppError): Promise<string> => {
          throw thrown;
        })
        .toPromise();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(thrown);
      }
    });

    it('orElse: throw в callback → сырое исключение, не E-normalizer', async () => {
      const thrown = new TypeError('orElse cb threw');
      const result = await AsyncResult.from(
        Promise.resolve(Err({ code: 'E', tag: 'AppError' as const } as AppError) as Result<number, AppError>),
        mkNormalizer()
      )
        .orElse((_e: AppError): Result<number, string> => {
          throw thrown;
        })
        .toPromise();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(thrown);
      }
    });

    it('orElseAsync: throw в callback → сырое исключение, не E-normalizer', async () => {
      const thrown = new TypeError('orElseAsync cb threw');
      const result = await AsyncResult.from(
        Promise.resolve(Err({ code: 'E', tag: 'AppError' as const } as AppError) as Result<number, AppError>),
        mkNormalizer()
      )
        .orElseAsync(async (_e: AppError): Promise<Result<number, string>> => {
          throw thrown;
        })
        .toPromise();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(thrown);
      }
    });

    it('orAsyncLazy: throw в factory → сырое исключение, не E-normalizer', async () => {
      const thrown = new TypeError('orAsyncLazy factory threw');
      const result = await AsyncResult.from(
        Promise.resolve(Err({ code: 'E', tag: 'AppError' as const } as AppError) as Result<number, AppError>),
        mkNormalizer()
      )
        .orAsyncLazy((): Promise<Result<number, string>> => {
          throw thrown;
        })
        .toPromise();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(thrown);
      }
    });
  });
});
