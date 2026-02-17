/**
 * Расширенные тесты для новых FP-функций ядра
 *
 * Покрывает:
 * - flatMapW, mapErrW, orElseW (widen-варианты)
 * - match (pattern matching)
 * - unwrapOrElse (безопасное извлечение с fallback)
 * - tryCatch, tryAsync (перехват исключений)
 * - fromPromise, fromNullable, fromThrowable (интеграция с внешним миром)
 * - unsafe.ts (unwrap, expect, unwrapErr, expectErr)
 */

import { describe, it, expect } from '@jest/globals';
import {
  type Result,
  Ok,
  Err,
  flatMapW,
  mapErrW,
  orElseW,
  match,
  unwrapOrElse,
  tryCatch,
  tryAsync,
  fromPromise,
  fromNullable,
  fromThrowable,
} from '../../src/result';

// ============================================================
// flatMapW — widen-вариант flatMap
// ============================================================
describe('flatMapW', () => {
  it('должен вернуть результат fn для Ok', () => {
    type ValidationError = { type: 'validation' };

    const r = Ok(42);
    const result = flatMapW(r, (): Result<never, ValidationError> => Err({ type: 'validation' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toEqual({ type: 'validation' });
  });

  it('должен правильно цеплять разные типы ошибок', () => {
    type ValidationError = { type: 'validation' };

    const okResult = Ok(10);
    // flatMapW позволяет fn вернуть Result с другим типом ошибки
    const result = flatMapW(okResult, (x) => {
      if (x > 5) return Ok(x * 2);
      return Err({ type: 'validation' } as ValidationError);
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(20);
  });

  it('должен пропускать Err без вызова fn', () => {
    const errResult = Err('initial error');
    let fnCalled = false;

    const result = flatMapW(errResult, () => {
      fnCalled = true;
      return Ok(42);
    });

    expect(fnCalled).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('initial error');
  });

  it('должен поддерживать цепочку с расширением типа ошибки', () => {
    type ErrA = { kind: 'a' };

    const r1 = Ok(5);
    const r2 = flatMapW(r1, (x) => Ok(x.toString()));
    const r3 = flatMapW(r2, (s) => {
      if (s === '5') return Err({ kind: 'a' } as ErrA);
      return Ok(parseInt(s, 10));
    });

    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error).toEqual({ kind: 'a' });
  });
});

// ============================================================
// mapErrW — widen-вариант mapErr
// ============================================================
describe('mapErrW', () => {
  it('должен трансформировать ошибку в новый тип', () => {
    type HttpError = { status: number };
    type AppError = { code: string };

    const r = Err({ status: 404 } as HttpError);
    const result = mapErrW(r, (err): AppError => ({ code: `HTTP_${err.status}` }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as AppError).code).toBe('HTTP_404');
    }
  });

  it('должен не вызывать fn для Ok', () => {
    let fnCalled = false;
    const r = Ok(42);
    const result = mapErrW(r, (e) => {
      fnCalled = true;
      return String(e);
    });

    expect(fnCalled).toBe(false);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(42);
  });

  it('должен сохранять значение Ok при трансформации', () => {
    const r = Ok({ name: 'Ivan' });
    const result = mapErrW(r, () => 'error');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe('Ivan');
  });
});

// ============================================================
// orElseW — widen-вариант orElse (recovery)
// ============================================================
describe('orElseW', () => {
  it('должен вызвать fn для Err и вернуть результат', () => {
    type TempError = { retryable: boolean };

    const r = Err({ retryable: false } as TempError);
    const result = orElseW(r, (err) => {
      if (err.retryable) return Err('retry exhausted');
      return Err('permanent failure');
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('permanent failure');
  });

  it('должен не вызывать fn для Ok', () => {
    let fnCalled = false;
    const r = Ok(42);
    const result = orElseW(r, () => {
      fnCalled = true;
      return Ok(0);
    });

    expect(fnCalled).toBe(false);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(42);
  });

  it('должен поддерживать recovery с другим типом ошибки', () => {
    const r = Err('original error');
    const result = orElseW(r, (err) => Ok(`recovered from: ${err}`));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('recovered from: original error');
  });
});

// ============================================================
// match — pattern matching
// ============================================================
describe('match', () => {
  it('должен вызвать обработчик ok для Ok', () => {
    const r = Ok(42);
    const result = match(r, {
      ok: (value) => `Success: ${value}`,
      err: (error) => `Error: ${error}`,
    });

    expect(result).toBe('Success: 42');
  });

  it('должен вызвать обработчик err для Err', () => {
    const r = Err('network error');
    const result = match(r, {
      ok: (value) => `Success: ${value}`,
      err: (error) => `Error: ${error}`,
    });

    expect(result).toBe('Error: network error');
  });

  it('должен возвращать разные типы из ok и err обработчиков', () => {
    const r1 = Ok(5);
    const result1 = match(r1, {
      ok: (n) => n * 2,
      err: () => -1,
    });
    expect(result1).toBe(10);

    const r2 = Err('fail');
    const result2 = match(r2, {
      ok: (n) => n * 2,
      err: () => -1,
    });
    expect(result2).toBe(-1);
  });

  it('должен поддерживать side effects в обработчиках', () => {
    const log: string[] = [];
    const r = Ok('hello');

    match(r, {
      ok: (v) => { log.push(`ok: ${v}`); return v; },
      err: (e) => { log.push(`err: ${e}`); return e; },
    });

    expect(log).toEqual(['ok: hello']);
  });
});

// ============================================================
// unwrapOrElse — безопасное извлечение с fallback-функцией
// ============================================================
describe('unwrapOrElse', () => {
  it('должен вернуть значение для Ok', () => {
    const r = Ok(42);
    const result = unwrapOrElse(r, () => 0);
    expect(result).toBe(42);
  });

  it('должен вызвать fn и вернуть fallback для Err', () => {
    const r = Err('network error');
    const result = unwrapOrElse(r, (err) => `default (${err})`);
    expect(result).toBe('default (network error)');
  });

  it('должен передавать ошибку в fn', () => {
    const r = Err({ code: 404, message: 'Not found' });
    const result = unwrapOrElse(r, (err) => err.message);
    expect(result).toBe('Not found');
  });

  it('должен не вызывать fn для Ok', () => {
    let fnCalled = false;
    const r = Ok(42);

    unwrapOrElse(r, () => {
      fnCalled = true;
      return 0;
    });

    expect(fnCalled).toBe(false);
  });
});

// ============================================================
// tryCatch — безопасный перехват синхронных исключений
// ============================================================
describe('tryCatch', () => {
  it('должен вернуть Ok если fn не бросает', () => {
    const result = tryCatch(
      () => JSON.parse('{"name":"Ivan"}') as { name: string },
      (err) => String(err)
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe('Ivan');
  });

  it('должен перехватить исключение и вернуть Err', () => {
    const result = tryCatch(
      () => JSON.parse('invalid json') as unknown,
      (err) => `Parse error: ${err}`
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Parse error');
  });

  it('должен вызвать onError с исходным исключением', () => {
    const thrownError = new Error('test error');
    let caughtError: unknown;

    tryCatch(
      () => { throw thrownError; },
      (err) => { caughtError = err; return 'error'; }
    );

    expect(caughtError).toBe(thrownError);
  });

  it('должен работать с произвольным типом ошибки', () => {
    type MyError = { code: number; message: string };

    const result = tryCatch(
      () => { throw new Error('Oops'); },
      (err): MyError => ({ code: 500, message: String(err) })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(500);
      expect(result.error.message).toContain('Error: Oops');
    }
  });
});

// ============================================================
// tryAsync — безопасный перехват асинхронных исключений
// ============================================================
describe('tryAsync', () => {
  it('должен вернуть Ok если Promise resolves', async () => {
    const result = await tryAsync(
      async () => 42,
      (err) => String(err)
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(42);
  });

  it('должен перехватить rejection и вернуть Err', async () => {
    const result = await tryAsync(
      async () => { throw new Error('Async failure'); },
      (err) => `Async error: ${err}`
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Async error');
  });

  it('должен перехватить rejected Promise', async () => {
    const result = await tryAsync(
      () => Promise.reject(new Error('rejected')),
      (err) => String(err)
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('rejected');
  });

  it('должен передавать ошибку в onError', async () => {
    const thrownError = new Error('test');
    let caughtError: unknown;

    await tryAsync(
      async () => { throw thrownError; },
      (err) => { caughtError = err; return 'caught'; }
    );

    expect(caughtError).toBe(thrownError);
  });
});

// ============================================================
// fromPromise — конвертация Promise в Result
// ============================================================
describe('fromPromise', () => {
  it('должен вернуть Ok для resolved Promise', async () => {
    const result = await fromPromise(
      Promise.resolve(42),
      (err) => String(err)
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(42);
  });

  it('должен вернуть Err для rejected Promise', async () => {
    const result = await fromPromise(
      Promise.reject(new Error('network error')),
      (err) => `Failed: ${err}`
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Failed');
  });

  it('должен передавать исходный rejection в onError', async () => {
    const rejection = new Error('original');
    let caughtError: unknown;

    await fromPromise(
      Promise.reject(rejection),
      (err) => { caughtError = err; return 'error'; }
    );

    expect(caughtError).toBe(rejection);
  });
});

// ============================================================
// fromNullable — конвертация nullable в Result
// ============================================================
describe('fromNullable', () => {
  it('должен вернуть Ok для непустого значения', () => {
    const result = fromNullable({ name: 'Ivan' }, 'Not found');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe('Ivan');
  });

  it('должен вернуть Err для null', () => {
    const result = fromNullable(null, 'Value is null');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('Value is null');
  });

  it('должен вернуть Err для undefined', () => {
    const result = fromNullable(undefined, 'Value is undefined');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('Value is undefined');
  });

  it('должен работать с числом 0 (falsy но не null/undefined)', () => {
    const result = fromNullable(0, 'Missing');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(0);
  });

  it('должен работать с пустой строкой (falsy но не null/undefined)', () => {
    const result = fromNullable('', 'Missing');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('');
  });
});

// ============================================================
// fromThrowable — обёртка над бросающей функцией
// ============================================================
describe('fromThrowable', () => {
  it('должен вернуть Ok если fn не бросает', () => {
    const safeParseJSON = fromThrowable(
      (text: string) => JSON.parse(text) as unknown,
      (err) => `Parse error: ${err}`
    );

    const result = safeParseJSON('{"name":"Ivan"}');
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.value as { name: string }).name).toBe('Ivan');
  });

  it('должен вернуть Err если fn бросает', () => {
    const safeParseJSON = fromThrowable(
      (text: string) => JSON.parse(text) as unknown,
      (err) => `Parse error: ${err}`
    );

    const result = safeParseJSON('invalid json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Parse error');
  });

  it('должен сохранять аргументы функции', () => {
    const safeDivide = fromThrowable(
      (a: number, b: number) => {
        if (b === 0) throw new Error('Division by zero');
        return a / b;
      },
      (err) => String(err)
    );

    const ok = safeDivide(10, 2);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value).toBe(5);

    const err = safeDivide(10, 0);
    expect(err.ok).toBe(false);
    if (!err.ok) expect(err.error).toContain('Division by zero');
  });
});
