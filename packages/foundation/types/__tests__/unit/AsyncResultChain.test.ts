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
  });

  describe('Метод mapErr()', () => {
    it('должен трансформировать ошибку синхронно', async () => {
      const result = await AsyncResult.err({ code: 404, message: 'Not found' })
        .mapErr((err) => err.message)
        .unwrapErr();

      expect(result).toBe('Not found');
    });
  });

  describe('Метод unwrap()', () => {
    it('должен извлекать значение из Ok', async () => {
      const value = await AsyncResult.ok(Promise.resolve(42)).unwrap();

      expect(value).toBe(42);
    });

    it('должен выбрасывать ошибку для Err', async () => {
      await expect(AsyncResult.err('error').unwrap()).rejects.toThrow(
        'Called unwrap on Err result'
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
  });

  describe('Метод unwrapErr()', () => {
    it('должен извлекать ошибку из Err', async () => {
      const error = await AsyncResult.err('error').unwrapErr();

      expect(error).toBe('error');
    });

    it('должен выбрасывать ошибку для Ok', async () => {
      await expect(AsyncResult.ok(Promise.resolve(42)).unwrapErr()).rejects.toThrow(
        'Called unwrapErr on Ok result'
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
  });

  describe('Метод orElse()', () => {
    it('должен восстанавливать значение синхронно', async () => {
      const errorResult: Result<number, string> = Err('error');
      const result = await AsyncResult.from(Promise.resolve(errorResult))
        .orElse((_err) => Ok(0))
        .unwrap();

      expect(result).toBe(0);
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
});
