/**
 * Тесты для ResultChain (OOP обёртка с method chaining)
 */

import { describe, it, expect } from '@jest/globals';
import {
  OkChain,
  ErrChain,
  toChain,
  R,
  fromPromise,
  fromNullable,
  fromThrowable,
} from '../../src/ResultChain';
import { Ok, Err, Result } from '../../src/result';

describe('ResultChain', () => {
  describe('OkChain constructor', () => {
    it('должен создавать успешный ResultChain', () => {
      const result = OkChain(42);

      expect(result.isOk()).toBe(true);
      expect(result.unwrap()).toBe(42);
    });

    it('должен работать с разными типами', () => {
      const number = OkChain(123);
      const string = OkChain('hello');
      const object = OkChain({ id: 1, name: 'test' });
      const array = OkChain([1, 2, 3]);

      expect(number.isOk()).toBe(true);
      expect(string.isOk()).toBe(true);
      expect(object.isOk()).toBe(true);
      expect(array.isOk()).toBe(true);
    });
  });

  describe('ErrChain constructor', () => {
    it('должен создавать ResultChain с ошибкой', () => {
      const result = ErrChain('Something went wrong');

      expect(result.isErr()).toBe(true);
      expect(result.unwrapErr()).toBe('Something went wrong');
    });

    it('должен работать с разными типами ошибок', () => {
      const stringError = ErrChain('error');
      const numberError = ErrChain(404);
      const objectError = ErrChain({ code: 'ERR_001', message: 'Error occurred' });

      expect(stringError.isErr()).toBe(true);
      expect(numberError.isErr()).toBe(true);
      expect(objectError.isErr()).toBe(true);
    });
  });

  describe('toChain helper', () => {
    it('должен конвертировать plain object Result в ResultChain', () => {
      const plain = Ok(42);
      const chain = toChain(plain);

      expect(chain.isOk()).toBe(true);
      expect(chain.unwrap()).toBe(42);
    });

    it('должен работать с Err', () => {
      const plain = Err('error');
      const chain = toChain(plain);

      expect(chain.isErr()).toBe(true);
      expect(chain.unwrapErr()).toBe('error');
    });
  });

  describe('toResult method', () => {
    it('должен конвертировать ResultChain обратно в plain object', () => {
      const chain = OkChain(42);
      const plain = chain.toResult();

      expect(plain.ok).toBe(true);
      if (plain.ok) {
        expect(plain.value).toBe(42);
      }
    });

    it('должен сохранять структуру plain object', () => {
      const chain = ErrChain('error');
      const plain = chain.toResult();

      expect(plain.ok).toBe(false);
      if (!plain.ok) {
        expect(plain.error).toBe('error');
      }
    });
  });

  describe('map method', () => {
    it('должен трансформировать значение', () => {
      const result = OkChain(5).map((x) => x * 2);

      expect(result.unwrap()).toBe(10);
    });

    it('должен поддерживать цепочку map', () => {
      const result = OkChain(5)
        .map((x) => x * 2)
        .map((x) => x + 1)
        .map((x) => x.toString());

      expect(result.unwrap()).toBe('11');
    });

    it('должен пропускать ошибку', () => {
      let called = false;
      const result = ErrChain('error').map((x) => {
        called = true;
        return x * 2;
      });

      expect(called).toBe(false);
      expect(result.isErr()).toBe(true);
    });

    it('должен менять тип значения', () => {
      const numberResult = OkChain(42);
      const stringResult = numberResult.map((x) => x.toString());

      expect(stringResult.unwrap()).toBe('42');
      expect(typeof stringResult.unwrap()).toBe('string');
    });
  });

  describe('flatMap method', () => {
    const divide = (a: number, b: number): Result<number, string> =>
      b === 0 ? Err('Division by zero') : Ok(a / b);

    it('должен цеплять успешные операции', () => {
      const result = OkChain(10)
        .flatMap((x) => divide(x, 2))
        .flatMap((x) => divide(x, 5));

      expect(result.unwrap()).toBe(1);
    });

    it('должен возвращать первую ошибку в цепочке', () => {
      const result = OkChain(10)
        .flatMap((x) => divide(x, 2))
        .flatMap((x) => divide(x, 0));

      expect(result.isErr()).toBe(true);
      expect(result.unwrapErr()).toBe('Division by zero');
    });

    it('должен пропускать операцию если исходный Result - ошибка', () => {
      let called = false;
      const result = ErrChain('initial error').flatMap((x) => {
        called = true;
        return divide(x, 2);
      });

      expect(called).toBe(false);
      expect(result.unwrapErr()).toBe('initial error');
    });
  });

  describe('flatMapChain method', () => {
    it('должен работать с ResultChain вместо plain Result', () => {
      const result = OkChain(10)
        .flatMapChain((x) => OkChain(x * 2))
        .flatMapChain((x) => OkChain(x + 1));

      expect(result.unwrap()).toBe(21);
    });

    it('должен обрабатывать ошибки', () => {
      const result = OkChain(10)
        .flatMapChain((x) => OkChain(x * 2))
        .flatMapChain(() => ErrChain('error'));

      expect(result.isErr()).toBe(true);
      expect(result.unwrapErr()).toBe('error');
    });
  });

  describe('mapErr method', () => {
    it('должен трансформировать ошибку', () => {
      const result = ErrChain({ code: 404, message: 'Not found' })
        .mapErr((err) => err.message);

      expect(result.unwrapErr()).toBe('Not found');
    });

    it('должен пропускать Ok без вызова функции', () => {
      let called = false;
      const result = OkChain(42).mapErr((err) => {
        called = true;
        return err;
      });

      expect(called).toBe(false);
      expect(result.unwrap()).toBe(42);
    });

    it('должен менять тип ошибки', () => {
      interface DetailedError {
        code: number;
        message: string;
      }

      const result = ErrChain<DetailedError>({ code: 404, message: 'Not found' })
        .mapErr((err) => `${err.code}: ${err.message}`);

      expect(result.unwrapErr()).toBe('404: Not found');
    });
  });

  describe('unwrap method', () => {
    it('должен извлекать значение из Ok', () => {
      const value = OkChain(42).unwrap();
      expect(value).toBe(42);
    });

    it('должен выбрасывать ошибку для Err', () => {
      expect(() => ErrChain('error').unwrap()).toThrow('Called unwrap on Err result');
    });
  });

  describe('unwrapOr method', () => {
    it('должен извлекать значение из Ok', () => {
      const value = OkChain(42).unwrapOr(0);
      expect(value).toBe(42);
    });

    it('должен возвращать fallback для Err', () => {
      const result: Result<number, string> = Err('error');
      const value = toChain(result).unwrapOr(0);
      expect(value).toBe(0);
    });
  });

  describe('unwrapErr method', () => {
    it('должен извлекать ошибку из Err', () => {
      const error = ErrChain('error').unwrapErr();
      expect(error).toBe('error');
    });

    it('должен выбрасывать ошибку для Ok', () => {
      expect(() => OkChain(42).unwrapErr()).toThrow('Called unwrapErr on Ok result');
    });
  });

  describe('isOk method', () => {
    it('должен возвращать true для Ok', () => {
      expect(OkChain(42).isOk()).toBe(true);
    });

    it('должен возвращать false для Err', () => {
      expect(ErrChain('error').isOk()).toBe(false);
    });
  });

  describe('isErr method', () => {
    it('должен возвращать true для Err', () => {
      expect(ErrChain('error').isErr()).toBe(true);
    });

    it('должен возвращать false для Ok', () => {
      expect(OkChain(42).isErr()).toBe(false);
    });
  });

  describe('tap method', () => {
    it('должен выполнять side effect для Ok', () => {
      let value = 0;
      const result = OkChain(42).tap((x) => {
        value = x;
      });

      expect(value).toBe(42);
      expect(result.unwrap()).toBe(42);
    });

    it('не должен выполнять side effect для Err', () => {
      let called = false;
      const result = ErrChain('error').tap(() => {
        called = true;
      });

      expect(called).toBe(false);
      expect(result.isErr()).toBe(true);
    });

    it('должен возвращать this для chaining', () => {
      const result = OkChain(5)
        .tap((x) => console.log(x))
        .map((x) => x * 2);

      expect(result.unwrap()).toBe(10);
    });
  });

  describe('tapErr method', () => {
    it('должен выполнять side effect для Err', () => {
      let error = '';
      const result = ErrChain('oops').tapErr((err) => {
        error = err;
      });

      expect(error).toBe('oops');
      expect(result.unwrapErr()).toBe('oops');
    });

    it('не должен выполнять side effect для Ok', () => {
      let called = false;
      const result = OkChain(42).tapErr(() => {
        called = true;
      });

      expect(called).toBe(false);
      expect(result.isOk()).toBe(true);
    });

    it('должен возвращать this для chaining', () => {
      const result = ErrChain('error')
        .tapErr((err) => console.error(err))
        .mapErr((err) => err.toUpperCase());

      expect(result.unwrapErr()).toBe('ERROR');
    });
  });

  describe('match method', () => {
    it('должен вызывать ok handler для Ok', () => {
      const message = OkChain(42).match({
        ok: (value) => `Успех: ${value}`,
        err: (error) => `Ошибка: ${error}`,
      });

      expect(message).toBe('Успех: 42');
    });

    it('должен вызывать err handler для Err', () => {
      const message = ErrChain('oops').match({
        ok: (value) => `Успех: ${value}`,
        err: (error) => `Ошибка: ${error}`,
      });

      expect(message).toBe('Ошибка: oops');
    });

    it('должен поддерживать разные типы возврата', () => {
      const result1 = OkChain(42).match({
        ok: (value) => value * 2,
        err: () => 0,
      });

      const result2 = ErrChain('error').match({
        ok: () => true,
        err: () => false,
      });

      expect(result1).toBe(84);
      expect(result2).toBe(false);
    });
  });

  describe('Method chaining (композиция)', () => {
    // Пример реальной бизнес-логики
    interface User {
      id: string;
      balance: number;
    }

    const getUser = (id: string): Result<User, string> => {
      if (id === 'invalid') return Err('User not found');
      return Ok({ id, balance: 100 });
    };

    const checkBalance = (user: User, amount: number): Result<User, string> => {
      if (user.balance < amount) return Err('Insufficient funds');
      return Ok(user);
    };

    const deductBalance = (user: User, amount: number): User => {
      return { ...user, balance: user.balance - amount };
    };

    it('должен композировать операции (success case)', () => {
      const result = toChain(getUser('user-1'))
        .flatMap((user) => checkBalance(user, 50))
        .map((user) => deductBalance(user, 50));

      expect(result.isOk()).toBe(true);
      expect(result.unwrap().balance).toBe(50);
    });

    it('должен останавливаться на первой ошибке (user not found)', () => {
      const result = toChain(getUser('invalid'))
        .flatMap((user) => checkBalance(user, 50))
        .map((user) => deductBalance(user, 50));

      expect(result.isErr()).toBe(true);
      expect(result.unwrapErr()).toBe('User not found');
    });

    it('должен останавливаться на первой ошибке (insufficient funds)', () => {
      const result = toChain(getUser('user-1'))
        .flatMap((user) => checkBalance(user, 200))
        .map((user) => deductBalance(user, 200));

      expect(result.isErr()).toBe(true);
      expect(result.unwrapErr()).toBe('Insufficient funds');
    });
  });

  describe('Совместимость plain objects и ResultChain', () => {
    it('должен конвертировать из plain в chain и обратно', () => {
      const plain1 = Ok(42);
      const chain = toChain(plain1).map((x) => x * 2);
      const plain2 = chain.toResult();

      expect(plain2.ok).toBe(true);
      if (plain2.ok) {
        expect(plain2.value).toBe(84);
      }
    });

    it('должен работать с функциями возвращающими plain Result', () => {
      const divide = (a: number, b: number): Result<number, string> =>
        b === 0 ? Err('Division by zero') : Ok(a / b);

      const result = OkChain(10)
        .flatMap((x) => divide(x, 2))
        .map((x) => x * 3);

      expect(result.unwrap()).toBe(15);
    });
  });

  describe('Реальный пример: Railway-Oriented Programming', () => {
    it('должен обрабатывать сложную цепочку операций', () => {
      const parseNumber = (str: string): Result<number, string> => {
        const num = Number(str);
        return isNaN(num) ? Err('Not a number') : Ok(num);
      };

      const validatePositive = (num: number): Result<number, string> =>
        num > 0 ? Ok(num) : Err('Not positive');

      const sqrt = (num: number): Result<number, string> => Ok(Math.sqrt(num));

      const result = toChain(parseNumber('16'))
        .flatMap(validatePositive)
        .flatMap(sqrt)
        .map((x) => x * 2)
        .match({
          ok: (value) => `Результат: ${value}`,
          err: (error) => `Ошибка: ${error}`,
        });

      expect(result).toBe('Результат: 8');
    });

    it('должен останавливаться на первой ошибке в цепочке', () => {
      const parseNumber = (str: string): Result<number, string> => {
        const num = Number(str);
        return isNaN(num) ? Err('Not a number') : Ok(num);
      };

      const validatePositive = (num: number): Result<number, string> =>
        num > 0 ? Ok(num) : Err('Not positive');

      const result = toChain(parseNumber('-5'))
        .flatMap(validatePositive)
        .map((x) => Math.sqrt(x))
        .unwrapOr(0);

      expect(result).toBe(0); // Вернул fallback из-за ошибки
    });
  });

  describe('Метод and()', () => {
    it('должен возвращать второй Result если первый Ok', () => {
      const result = OkChain(2).and(Ok(3));

      expect(result.isOk()).toBe(true);
      expect(result.unwrap()).toBe(3);
    });

    it('должен возвращать первую ошибку если первый Result - Err', () => {
      const result = ErrChain('error1').and(Ok(5));

      expect(result.isErr()).toBe(true);
      expect(result.unwrapErr()).toBe('error1');
    });

    it('должен работать с разными типами ошибок', () => {
      const result = OkChain(2).and(Ok(5));

      expect(result.isOk()).toBe(true);
      expect(result.unwrap()).toBe(5);
    });
  });

  describe('Метод or()', () => {
    it('должен возвращать первый Result если он Ok', () => {
      const result = OkChain(10).or(Ok(20));

      expect(result.isOk()).toBe(true);
      expect(result.unwrap()).toBe(10);
    });

    it('должен возвращать второй Result если первый Err', () => {
      const errorResult: Result<number, string> = Err('error1');
      const result = toChain(errorResult).or(Ok(42));

      expect(result.isOk()).toBe(true);
      expect(result.unwrap()).toBe(42);
    });

    it('должен возвращать второй Err если оба Err', () => {
      const result = ErrChain('error1').or(Err('error2'));

      expect(result.isErr()).toBe(true);
      expect(result.unwrapErr()).toBe('error2');
    });
  });

  describe('Метод flatten()', () => {
    it('должен разворачивать вложенный Result<Result<T, E>, E>', () => {
      const nested: Result<Result<number, string>, string> = Ok(Ok(42));
      const flat = toChain(nested).flatten();

      expect(flat.isOk()).toBe(true);
      expect(flat.unwrap()).toBe(42);
    });

    it('должен обрабатывать вложенную ошибку', () => {
      const nested: Result<Result<number, string>, string> = Ok(Err('inner error'));
      const flat = toChain(nested).flatten();

      expect(flat.isErr()).toBe(true);
      expect(flat.unwrapErr()).toBe('inner error');
    });

    it('должен обрабатывать внешнюю ошибку', () => {
      const nested: Result<Result<number, string>, string> = Err('outer error');
      const flat = toChain(nested).flatten();

      expect(flat.isErr()).toBe(true);
      expect(flat.unwrapErr()).toBe('outer error');
    });
  });

  describe('Метод expect()', () => {
    it('должен возвращать значение для Ok', () => {
      const value = OkChain(42).expect('Should be Ok');

      expect(value).toBe(42);
    });

    it('должен выбрасывать ошибку с кастомным сообщением для Err', () => {
      expect(() => ErrChain('oops').expect('Failed to get value')).toThrow(
        'Failed to get value: oops'
      );
    });
  });

  describe('Метод expectErr()', () => {
    it('должен возвращать ошибку для Err', () => {
      const error = ErrChain('oops').expectErr('Should be Err');

      expect(error).toBe('oops');
    });

    it('должен выбрасывать ошибку с кастомным сообщением для Ok', () => {
      expect(() => OkChain(42).expectErr('Expected error')).toThrow(
        'Expected error: expected Err but got Ok(42)'
      );
    });
  });

  describe('Метод andThen()', () => {
    const divide = (a: number, b: number): Result<number, string> =>
      b === 0 ? Err('Division by zero') : Ok(a / b);

    it('должен работать как алиас для flatMap', () => {
      const result = OkChain(10)
        .andThen((x) => divide(x, 2))
        .andThen((x) => divide(x, 5));

      expect(result.unwrap()).toBe(1);
    });

    it('должен возвращать первую ошибку', () => {
      const result = OkChain(10)
        .andThen((x) => divide(x, 2))
        .andThen((x) => divide(x, 0));

      expect(result.isErr()).toBe(true);
      expect(result.unwrapErr()).toBe('Division by zero');
    });
  });

  describe('Метод orElse()', () => {
    it('должен восстанавливать значение из ошибки', () => {
      const errorResult: Result<number, string> = Err('error');
      const result = toChain(errorResult)
        .orElse((_err) => {
          return Ok(0); // fallback значение
        })
        .unwrap();

      expect(result).toBe(0);
    });

    it('не должен вызывать функцию для Ok', () => {
      let called = false;
      const result = OkChain(42).orElse((_err) => {
        called = true;
        return Ok(0);
      });

      expect(called).toBe(false);
      expect(result.unwrap()).toBe(42);
    });

    it('должен обрабатывать новую ошибку', () => {
      const result = ErrChain('error1')
        .orElse((_err) => {
          return Err('error2');
        })
        .unwrapErr();

      expect(result).toBe('error2');
    });
  });

  describe('Короткий алиас R', () => {
    it('R.ok должен создавать OkChain', () => {
      const result = R.ok(42);

      expect(result.isOk()).toBe(true);
      expect(result.unwrap()).toBe(42);
    });

    it('R.err должен создавать ErrChain', () => {
      const result = R.err('error');

      expect(result.isErr()).toBe(true);
      expect(result.unwrapErr()).toBe('error');
    });

    it('R.from должен конвертировать plain Result в ResultChain', () => {
      const plain = Ok(42);
      const chain = R.from(plain);

      expect(chain.isOk()).toBe(true);
      expect(chain.unwrap()).toBe(42);
    });

    it('должен поддерживать method chaining', () => {
      const result = R.ok(5)
        .map((x) => x * 2)
        .map((x) => x + 1)
        .unwrap();

      expect(result).toBe(11);
    });
  });

  describe('Helper функция fromPromise()', () => {
    it('должен конвертировать успешный Promise в Ok', async () => {
      const result = await fromPromise(
        Promise.resolve(42),
        (error) => `Error: ${error}`
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(42);
      }
    });

    it('должен конвертировать rejected Promise в Err', async () => {
      const result = await fromPromise(
        Promise.reject('failure'),
        (error) => `Error: ${error}`
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('Error: failure');
      }
    });

    it('должен обрабатывать async функции', async () => {
      const fetchData = async () => {
        throw new Error('Network error');
      };

      const result = await fromPromise(fetchData(), (error) => {
        return error instanceof Error ? error.message : 'Unknown error';
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('Network error');
      }
    });
  });

  describe('Helper функция fromNullable()', () => {
    it('должен конвертировать значение в Ok', () => {
      const result = fromNullable(42, 'Value is null');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(42);
      }
    });

    it('должен конвертировать null в Err', () => {
      const result = fromNullable(null, 'Value is null');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('Value is null');
      }
    });

    it('должен конвертировать undefined в Err', () => {
      const result = fromNullable(undefined, 'Value is undefined');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('Value is undefined');
      }
    });

    it('должен работать с объектами', () => {
      interface User {
        id: string;
        name: string;
      }

      const maybeUser: User | null = { id: '123', name: 'John' };
      const result = fromNullable(maybeUser, 'User not found');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe('John');
      }
    });
  });

  describe('Helper функция fromThrowable()', () => {
    it('должен обернуть успешную функцию в Result-returning функцию', () => {
      const safeParseInt = fromThrowable(
        (text: string) => {
          const num = parseInt(text, 10);
          if (isNaN(num)) throw new Error('Not a number');
          return num;
        },
        (error) => (error instanceof Error ? error.message : 'Unknown error')
      );

      const result = safeParseInt('42');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(42);
      }
    });

    it('должен ловить exceptions и возвращать Err', () => {
      const safeParseJSON = fromThrowable(
        (text: string) => JSON.parse(text),
        (error) => `Parse error: ${error}`
      );

      const result = safeParseJSON('invalid json');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Parse error');
      }
    });

    it('должен работать с функциями с несколькими аргументами', () => {
      const safeDivide = fromThrowable(
        (a: number, b: number) => {
          if (b === 0) throw new Error('Division by zero');
          return a / b;
        },
        (error) => (error instanceof Error ? error.message : 'Unknown error')
      );

      const result1 = safeDivide(10, 2);
      expect(result1.ok).toBe(true);
      if (result1.ok) {
        expect(result1.value).toBe(5);
      }

      const result2 = safeDivide(10, 0);
      expect(result2.ok).toBe(false);
      if (!result2.ok) {
        expect(result2.error).toBe('Division by zero');
      }
    });

    it('должен сохранять контекст функции', () => {
      const obj = {
        value: 10,
        getValue() {
          return this.value;
        },
      };

      const safeGetValue = fromThrowable(
        () => obj.getValue(),
        (_error) => 'Error'
      );

      const result = safeGetValue();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(10);
      }
    });
  });
});
