/**
 * Тесты для Result<T, E> type
 */

import { describe, it, expect } from '@jest/globals';
import {
  Result,
  Ok,
  Err,
  isOk,
  isErr,
  map,
  flatMap,
  mapErr,
  combine,
  unwrap,
  unwrapOr,
  formatValue,
} from '../../src/result';

describe('Result<T, E>', () => {
  describe('Ok constructor', () => {
    it('должен создавать успешный Result', () => {
      const result = Ok(42);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(42);
      }
    });

    it('должен работать с разными типами', () => {
      const number = Ok(123);
      const string = Ok('hello');
      const object = Ok({ id: 1, name: 'test' });
      const array = Ok([1, 2, 3]);

      expect(number.ok).toBe(true);
      expect(string.ok).toBe(true);
      expect(object.ok).toBe(true);
      expect(array.ok).toBe(true);
    });

    it('должен работать с null и undefined', () => {
      const nullResult = Ok(null);
      const undefinedResult = Ok(undefined);

      expect(nullResult.ok).toBe(true);
      expect(undefinedResult.ok).toBe(true);
    });
  });

  describe('Err constructor', () => {
    it('должен создавать Result с ошибкой', () => {
      const result = Err('Something went wrong');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('Something went wrong');
      }
    });

    it('должен работать с разными типами ошибок', () => {
      const stringError = Err('error');
      const numberError = Err(404);
      const objectError = Err({ code: 'ERR_001', message: 'Error occurred' });

      expect(stringError.ok).toBe(false);
      expect(numberError.ok).toBe(false);
      expect(objectError.ok).toBe(false);
    });
  });

  describe('isOk type guard', () => {
    it('должен возвращать true для Ok', () => {
      const result = Ok(42);
      expect(isOk(result)).toBe(true);
    });

    it('должен возвращать false для Err', () => {
      const result = Err('error');
      expect(isOk(result)).toBe(false);
    });

    it('должен правильно сужать тип', () => {
      const result: Result<number, string> = Ok(42);

      if (isOk(result)) {
        // TypeScript должен знать что это Ok
        const value: number = result.value;
        expect(value).toBe(42);
      }
    });
  });

  describe('isErr type guard', () => {
    it('должен возвращать true для Err', () => {
      const result = Err('error');
      expect(isErr(result)).toBe(true);
    });

    it('должен возвращать false для Ok', () => {
      const result = Ok(42);
      expect(isErr(result)).toBe(false);
    });

    it('должен правильно сужать тип', () => {
      const result: Result<number, string> = Err('error');

      if (isErr(result)) {
        // TypeScript должен знать что это Err
        const error: string = result.error;
        expect(error).toBe('error');
      }
    });
  });

  describe('map function', () => {
    it('должен трансформировать значение Ok', () => {
      const result = Ok(5);
      const doubled = map(result, (x) => x * 2);

      expect(doubled.ok).toBe(true);
      if (doubled.ok) {
        expect(doubled.value).toBe(10);
      }
    });

    it('должен пропускать ошибку без вызова функции', () => {
      const result = Err('error');
      let called = false;

      const mapped = map(result, (x) => {
        called = true;
        return x * 2;
      });

      expect(called).toBe(false);
      expect(mapped.ok).toBe(false);
      if (!mapped.ok) {
        expect(mapped.error).toBe('error');
      }
    });

    it('должен поддерживать цепочку map', () => {
      const result = Ok(5);
      const transformed = map(map(map(result, (x) => x * 2), (x) => x + 1), (x) => x.toString());

      expect(transformed.ok).toBe(true);
      if (transformed.ok) {
        expect(transformed.value).toBe('11');
      }
    });

    it('должен менять тип значения', () => {
      const numberResult = Ok(42);
      const stringResult = map(numberResult, (x) => x.toString());

      expect(stringResult.ok).toBe(true);
      if (stringResult.ok) {
        expect(typeof stringResult.value).toBe('string');
        expect(stringResult.value).toBe('42');
      }
    });
  });

  describe('flatMap function', () => {
    const divide = (a: number, b: number): Result<number, string> =>
      b === 0 ? Err('Division by zero') : Ok(a / b);

    it('должен цеплять успешные операции', () => {
      const result = flatMap(divide(10, 2), (x) => divide(x, 5));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(1);
      }
    });

    it('должен возвращать первую ошибку в цепочке', () => {
      const result = flatMap(divide(10, 2), (x) => divide(x, 0));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('Division by zero');
      }
    });

    it('должен пропускать операцию если исходный Result - ошибка', () => {
      let called = false;
      const result = flatMap(Err('initial error'), (x) => {
        called = true;
        return divide(x, 2);
      });

      expect(called).toBe(false);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('initial error');
      }
    });

    it('должен поддерживать цепочку flatMap', () => {
      const result = flatMap(
        flatMap(
          flatMap(Ok(20), (x) => divide(x, 2)),
          (x) => divide(x, 2)
        ),
        (x) => divide(x, 5)
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(1);
      }
    });
  });

  describe('mapErr function', () => {
    it('должен трансформировать ошибку', () => {
      const result = Err({ code: 404, message: 'Not found' });
      const mapped = mapErr(result, (err) => err.message);

      expect(mapped.ok).toBe(false);
      if (!mapped.ok) {
        expect(mapped.error).toBe('Not found');
      }
    });

    it('должен пропускать Ok без вызова функции', () => {
      const result = Ok(42);
      let called = false;

      const mapped = mapErr(result, (err) => {
        called = true;
        return err;
      });

      expect(called).toBe(false);
      expect(mapped.ok).toBe(true);
      if (mapped.ok) {
        expect(mapped.value).toBe(42);
      }
    });

    it('должен менять тип ошибки', () => {
      interface DetailedError {
        code: number;
        message: string;
      }

      const result: Result<number, DetailedError> = Err({ code: 404, message: 'Not found' });
      const simplified: Result<number, string> = mapErr(result, (err) => `${err.code}: ${err.message}`);

      expect(simplified.ok).toBe(false);
      if (!simplified.ok) {
        expect(simplified.error).toBe('404: Not found');
      }
    });
  });

  describe('combine function', () => {
    it('должен объединять массив успешных Results', () => {
      const results = [Ok(1), Ok(2), Ok(3)];
      const combined = combine(results);

      expect(combined.ok).toBe(true);
      if (combined.ok) {
        expect(combined.value).toEqual([1, 2, 3]);
      }
    });

    it('должен возвращать первую ошибку', () => {
      const results = [Ok(1), Err('error 1'), Ok(3), Err('error 2')];
      const combined = combine(results);

      expect(combined.ok).toBe(false);
      if (!combined.ok) {
        expect(combined.error).toBe('error 1');
      }
    });

    it('должен работать с пустым массивом', () => {
      const results: Array<Result<number, string>> = [];
      const combined = combine(results);

      expect(combined.ok).toBe(true);
      if (combined.ok) {
        expect(combined.value).toEqual([]);
      }
    });

    it('должен работать с одним элементом', () => {
      const results = [Ok(42)];
      const combined = combine(results);

      expect(combined.ok).toBe(true);
      if (combined.ok) {
        expect(combined.value).toEqual([42]);
      }
    });
  });

  describe('unwrap function', () => {
    it('должен извлекать значение из Ok', () => {
      const result = Ok(42);
      const value = unwrap(result);

      expect(value).toBe(42);
    });

    it('должен выбрасывать ошибку для Err', () => {
      const result = Err('error');

      expect(() => unwrap(result)).toThrow('Called unwrap on Err result: error');
    });

    it('должен работать с разными типами', () => {
      const numberResult = Ok(123);
      const stringResult = Ok('hello');
      const objectResult = Ok({ id: 1 });

      expect(unwrap(numberResult)).toBe(123);
      expect(unwrap(stringResult)).toBe('hello');
      expect(unwrap(objectResult)).toEqual({ id: 1 });
    });

    it('должен корректно форматировать функции в сообщениях об ошибках', () => {
      const fn = () => 42;
      const result = Err(fn);

      expect(() => unwrap(result)).toThrow('Called unwrap on Err result: [Function: fn]');
    });

    it('должен корректно форматировать символы в сообщениях об ошибках', () => {
      const sym = Symbol('test');
      const result = Err(sym);

      expect(() => unwrap(result)).toThrow('Called unwrap on Err result: Symbol(test)');
    });
  });

  describe('unwrapOr function', () => {
    it('должен извлекать значение из Ok', () => {
      const result = Ok(42);
      const value = unwrapOr(result, 0);

      expect(value).toBe(42);
    });

    it('должен возвращать fallback для Err', () => {
      const result = Err('error');
      const value = unwrapOr(result, 0);

      expect(value).toBe(0);
    });

    it('должен работать с разными типами fallback', () => {
      const stringErr: Result<string, string> = Err('error');
      const objectErr: Result<{ id: number }, string> = Err('error');

      expect(unwrapOr(stringErr, 'default')).toBe('default');
      expect(unwrapOr(objectErr, { id: 0 })).toEqual({ id: 0 });
    });
  });

  describe('Railway-Oriented Programming (композиция)', () => {
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

    const deductBalance = (user: User, amount: number): Result<User, string> => {
      return Ok({ ...user, balance: user.balance - amount });
    };

    it('должен композировать операции (success case)', () => {
      const result = flatMap(
        flatMap(getUser('user-1'), (user) => checkBalance(user, 50)),
        (user) => deductBalance(user, 50)
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.balance).toBe(50);
      }
    });

    it('должен останавливаться на первой ошибке (user not found)', () => {
      const result = flatMap(
        flatMap(getUser('invalid'), (user) => checkBalance(user, 50)),
        (user) => deductBalance(user, 50)
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('User not found');
      }
    });

    it('должен останавливаться на первой ошибке (insufficient funds)', () => {
      const result = flatMap(
        flatMap(getUser('user-1'), (user) => checkBalance(user, 200)),
        (user) => deductBalance(user, 200)
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('Insufficient funds');
      }
    });
  });

  describe('TypeScript type narrowing', () => {
    it('должен правильно сужать тип через .ok', () => {
      const result: Result<number, string> = Ok(42);

      if (result.ok) {
        // TypeScript знает что это { ok: true, value: number }
        const value: number = result.value;
        expect(value).toBe(42);
      } else {
        // TypeScript знает что это { ok: false, error: string }
        const error: string = result.error;
        // Этот код не выполнится
        expect(error).toBe('never');
      }
    });

    it('должен работать с pattern matching', () => {
      const result: Result<number, string> = Err('error');

      const message = result.ok
        ? `Success: ${result.value}`
        : `Error: ${result.error}`;

      expect(message).toBe('Error: error');
    });
  });

  describe('formatValue', () => {
    it('должен форматировать null и undefined', () => {
      expect(formatValue(null)).toBe('null');
      expect(formatValue(undefined)).toBe('undefined');
    });

    it('должен форматировать строки', () => {
      expect(formatValue('hello')).toBe('hello');
      expect(formatValue('')).toBe('');
    });

    it('должен форматировать примитивы', () => {
      expect(formatValue(42)).toBe('42');
      expect(formatValue(true)).toBe('true');
      expect(formatValue(false)).toBe('false');
    });

    it('должен форматировать bigint', () => {
      expect(formatValue(BigInt(9007199254740991))).toBe('9007199254740991');
      expect(formatValue(123n)).toBe('123');
    });

    it('должен форматировать символы', () => {
      expect(formatValue(Symbol('test'))).toBe('Symbol(test)');
      expect(formatValue(Symbol())).toBe('Symbol()');
    });

    it('должен форматировать функции', () => {
      function namedFunc() {}
      const anonymousFunc = () => {};

      expect(formatValue(namedFunc)).toBe('[Function: namedFunc]');
      expect(formatValue(anonymousFunc)).toMatch(/\[Function(?:: anonymousFunc)?\]/);
    });

    it('должен форматировать Error с именем и сообщением', () => {
      const error = new Error('Something went wrong');
      expect(formatValue(error)).toBe('Error: Something went wrong');

      const typeError = new TypeError('Invalid type');
      expect(formatValue(typeError)).toBe('TypeError: Invalid type');
    });

    it('должен форматировать Error без сообщения', () => {
      const error = new Error();
      expect(formatValue(error)).toBe('Error');
    });

    it('должен форматировать валидные даты', () => {
      const date = new Date('2024-01-15T10:30:00.000Z');
      expect(formatValue(date)).toBe('Date(2024-01-15T10:30:00.000Z)');
    });

    it('должен безопасно форматировать невалидные даты', () => {
      const invalidDate = new Date('invalid');
      expect(formatValue(invalidDate)).toBe('Date(Invalid Date)');

      const invalidDate2 = new Date(NaN);
      expect(formatValue(invalidDate2)).toBe('Date(Invalid Date)');
    });

    it('должен форматировать объекты через JSON.stringify', () => {
      expect(formatValue({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
      expect(formatValue([1, 2, 3])).toBe('[1,2,3]');
    });

    it('должен обрабатывать циклические ссылки с метками [Circular]', () => {
      const circular: any = { a: 1 };
      circular.self = circular;

      const result = formatValue(circular);
      expect(result).toBe('{"a":1,"self":"[Circular]"}');
    });
  });
});
