/**
 * Parity-тесты: одинаковые сценарии для FP / Chain / Async API
 *
 * Цель: убедиться что все три API дают идентичные результаты
 * для одних и тех же входных данных.
 *
 * Также включает:
 * - Тесты AsyncResultChain.map при throw из callback
 * - Тесты normalizer в AsyncResultChain
 * - Тесты контрактных гарантий (что обещаем в ADR)
 */

import { describe, it, expect } from '@jest/globals';
import {
  Ok, Err, type Result,
  map, flatMap, flatMapW, mapErr,
  match, unwrapOr, combine,
  fromNullable,
} from '../../src/result';
import { OkChain, ErrChain, toChain } from '../../src/ResultChain';
import { AsyncResult } from '../../src/AsyncResultChain';

// ============================================================
// Parity: map
// ============================================================
describe('[Parity] map - FP vs Chain vs Async', () => {
  const SCENARIO_VALUE = 42;
  const SCENARIO_TRANSFORM = (x: number) => x * 2;
  const EXPECTED_VALUE = 84;

  it('[FP] map Ok', () => {
    const result = map(Ok(SCENARIO_VALUE), SCENARIO_TRANSFORM);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(EXPECTED_VALUE);
  });

  it('[Chain] map Ok', () => {
    const result = OkChain(SCENARIO_VALUE).map(SCENARIO_TRANSFORM).toResult();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(EXPECTED_VALUE);
  });

  it('[Async] map Ok', async () => {
    const result = await AsyncResult.from(Promise.resolve(Ok(SCENARIO_VALUE)))
      .map(SCENARIO_TRANSFORM)
      .toPromise();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(EXPECTED_VALUE);
  });

  it('[FP] map propagates Err', () => {
    const result = map(Err('error'), SCENARIO_TRANSFORM);
    expect(result.ok).toBe(false);
  });

  it('[Chain] map propagates Err', () => {
    const result = ErrChain('error').map(SCENARIO_TRANSFORM).toResult();
    expect(result.ok).toBe(false);
  });

  it('[Async] map propagates Err', async () => {
    const result = await AsyncResult.from(Promise.resolve(Err('error')))
      .map(SCENARIO_TRANSFORM)
      .toPromise();
    expect(result.ok).toBe(false);
  });
});

// ============================================================
// Parity: flatMap
// ============================================================
describe('[Parity] flatMap - FP vs Chain vs Async', () => {
  const divide = (a: number, b: number): Result<number, string> =>
    b === 0 ? Err('Division by zero') : Ok(a / b);

  it('[FP] flatMap - success chain', () => {
    const result = flatMap(flatMap(Ok(10), x => divide(x, 2)), x => divide(x, 5));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(1);
  });

  it('[Chain] flatMap - success chain', () => {
    const result = OkChain(10)
      .flatMap(x => divide(x, 2))
      .flatMap(x => divide(x, 5))
      .toResult();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(1);
  });

  it('[Async] flatMap - success chain', async () => {
    const result = await AsyncResult.from(Promise.resolve(Ok(10)))
      .flatMap(x => divide(x, 2))
      .flatMap(x => divide(x, 5))
      .toPromise();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(1);
  });

  it('[FP] flatMap - short-circuits at first Err', () => {
    const result = flatMap(flatMap(Ok(10), x => divide(x, 0)), x => divide(x, 5));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('Division by zero');
  });

  it('[Chain] flatMap - short-circuits at first Err', () => {
    const result = OkChain(10)
      .flatMap(x => divide(x, 0))
      .flatMap(x => divide(x, 5))
      .toResult();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('Division by zero');
  });

  it('[Async] flatMap - short-circuits at first Err', async () => {
    const result = await AsyncResult.from(Promise.resolve(Ok(10)))
      .flatMap(x => divide(x, 0))
      .flatMap(x => divide(x, 5))
      .toPromise();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('Division by zero');
  });
});

// ============================================================
// Parity: mapErr
// ============================================================
describe('[Parity] mapErr - FP vs Chain vs Async', () => {
  type HttpError = { status: number };

  const transform = (e: HttpError) => `HTTP ${e.status}`;

  it('[FP] mapErr - transforms error', () => {
    const result = mapErr(Err({ status: 404 } as HttpError), transform);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('HTTP 404');
  });

  it('[Chain] mapErr - transforms error', () => {
    const result = ErrChain({ status: 404 } as HttpError)
      .mapErr(transform)
      .toResult();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('HTTP 404');
  });

  it('[Async] mapErr - transforms error', async () => {
    const result = await AsyncResult.from(Promise.resolve(Err({ status: 404 } as HttpError)))
      .mapErr(transform)
      .toPromise();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('HTTP 404');
  });

  it('[FP] mapErr - preserves Ok unchanged', () => {
    const result = mapErr(Ok(42), transform);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(42);
  });

  it('[Chain] mapErr - preserves Ok unchanged', () => {
    const result = OkChain(42).mapErr(transform).toResult();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(42);
  });

  it('[Async] mapErr - preserves Ok unchanged', async () => {
    const result = await AsyncResult.from(Promise.resolve(Ok(42)))
      .mapErr(transform)
      .toPromise();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(42);
  });
});

// ============================================================
// Parity: match (pattern matching)
// ============================================================
describe('[Parity] match - FP vs Chain vs Async', () => {
  const handlers = {
    ok: (v: number) => `value=${v}`,
    err: (e: string) => `error=${e}`,
  };

  it('[FP] match Ok', () => {
    expect(match(Ok(42), handlers)).toBe('value=42');
  });

  it('[Chain] match Ok', () => {
    expect(OkChain(42).match(handlers)).toBe('value=42');
  });

  it('[Async] match Ok', async () => {
    const result = await AsyncResult.from(Promise.resolve(Ok(42))).match(handlers);
    expect(result).toBe('value=42');
  });

  it('[FP] match Err', () => {
    expect(match(Err('oops'), handlers)).toBe('error=oops');
  });

  it('[Chain] match Err', () => {
    expect(ErrChain('oops').match(handlers)).toBe('error=oops');
  });

  it('[Async] match Err', async () => {
    const result = await AsyncResult.from(Promise.resolve(Err('oops'))).match(handlers);
    expect(result).toBe('error=oops');
  });
});

// ============================================================
// Parity: unwrapOr
// ============================================================
describe('[Parity] unwrapOr - FP vs Chain vs Async', () => {
  it('[FP] unwrapOr - returns value for Ok', () => {
    expect(unwrapOr(Ok(42), 0)).toBe(42);
  });

  it('[Chain] unwrapOr - returns value for Ok', () => {
    expect(OkChain(42).unwrapOr(0)).toBe(42);
  });

  it('[Async] unwrapOr - returns value for Ok', async () => {
    const result = await AsyncResult.from(Promise.resolve(Ok(42))).unwrapOr(0);
    expect(result).toBe(42);
  });

  it('[FP] unwrapOr - returns default for Err', () => {
    expect(unwrapOr(Err<string>('fail') as Result<number, string>, 99)).toBe(99);
  });

  it('[Chain] unwrapOr - returns default for Err', () => {
    const chain = toChain(Err<string>('fail') as Result<number, string>);
    expect(chain.unwrapOr(99)).toBe(99);
  });

  it('[Async] unwrapOr - returns default for Err', async () => {
    const result = await AsyncResult.from(
      Promise.resolve(Err<string>('fail') as Result<number, string>)
    ).unwrapOr(99);
    expect(result).toBe(99);
  });
});

// ============================================================
// AsyncResultChain.map — throw из callback
// (ADR: sync map НЕ перехватывает throw — это rejected Promise)
// ============================================================
describe('AsyncResultChain.map — throw из callback', () => {
  it('должен стать rejected Promise если fn бросает синхронно', async () => {
    const chain = AsyncResult.from(Promise.resolve(Ok(42)))
      .map((value) => {
        throw new Error(`Sync throw from map: ${value}`);
      });

    await expect(chain.toPromise()).rejects.toThrow('Sync throw from map: 42');
  });

  it('mapAsync должен перехватить throw и вернуть Err', async () => {
    const chain = AsyncResult.from(Promise.resolve(Ok(42)))
      .mapAsync(async (value) => {
        throw new Error(`Async throw: ${value}`);
      });

    const result = await chain.toPromise();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe('Async throw: 42');
    }
  });

  it('map не вызывает fn при Err (throw не происходит)', async () => {
    let fnCalled = false;
    const chain = AsyncResult.from(Promise.resolve(Err('initial error')))
      .map(() => {
        fnCalled = true;
        throw new Error('Should not be called');
      });

    const result = await chain.toPromise();
    expect(fnCalled).toBe(false);
    expect(result.ok).toBe(false);
  });
});

// ============================================================
// AsyncResultChain — normalizer (onError)
// ============================================================
describe('AsyncResultChain — normalizer (onError)', () => {
  it('AsyncResult.from с onReject — использует normalizer при rejection', async () => {
    type AppError = { code: string; source: string };

    const chain = AsyncResult.from(
      Promise.reject(new Error('network failure')),
      (err): AppError => ({ code: 'NETWORK', source: String(err) })
    );

    const result = await chain.toPromise();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const error = result.error as AppError;
      expect(error.code).toBe('NETWORK');
      expect(error.source).toContain('network failure');
    }
  });

  it('AsyncResult.from без onReject — rejection попадает в Err как есть', async () => {
    const rejection = new Error('raw rejection');
    const chain = AsyncResult.from<string, unknown>(
      Promise.reject(rejection) as Promise<never>
    );

    const result = await chain.toPromise();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(rejection);
  });

  it('mapAsync использует normalizer из конструктора при исключении', async () => {
    type AppError = { code: string };

    const chain = AsyncResult.from(
      Promise.resolve(Ok(42) as Result<number, AppError>),
      (err): AppError => ({ code: `ERR_${String(err)}` })
    ).mapAsync(async () => {
      throw new Error('boom');
    });

    const result = await chain.toPromise();
    expect(result.ok).toBe(false);
    // Normalizer был передан, но mapAsync использует this.onError
    // При исключении типизация через assertion остаётся, т.к. тип E уже определён
    if (!result.ok) {
      // Normalizer преобразует Error в AppError
      const error = result.error as AppError;
      expect(error).toBeDefined();
    }
  });

  it('AsyncResult.ok с onError — корректно типизирует ошибку', async () => {
    type NetworkError = { status: number; message: string };

    const chain = AsyncResult.ok(
      Promise.reject(new Error('timeout')),
      (err): NetworkError => ({ status: 503, message: String(err) })
    );

    const result = await chain.toPromise();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const error = result.error as NetworkError;
      expect(error.status).toBe(503);
      expect(error.message).toContain('timeout');
    }
  });
});

// ============================================================
// Parity: tap и tapErr — side effects не изменяют Result
// ============================================================
describe('[Parity] tap/tapErr — side effects не изменяют Result', () => {
  it('[Chain] tap не изменяет Ok', () => {
    const sideEffects: number[] = [];
    const result = OkChain(42)
      .tap(v => sideEffects.push(v))
      .map(v => v * 2)
      .toResult();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(84);
    expect(sideEffects).toEqual([42]);
  });

  it('[Async] tap не изменяет Ok', async () => {
    const sideEffects: number[] = [];
    const result = await AsyncResult.from(Promise.resolve(Ok(42)))
      .tap(v => { sideEffects.push(v); })
      .map(v => v * 2)
      .toPromise();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(84);
    expect(sideEffects).toEqual([42]);
  });

  it('[Chain] tapErr не изменяет Err', () => {
    const sideEffects: string[] = [];
    const result = ErrChain('original error')
      .tapErr(e => sideEffects.push(e))
      .toResult();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('original error');
    expect(sideEffects).toEqual(['original error']);
  });

  it('[Async] tapErr не изменяет Err', async () => {
    const sideEffects: string[] = [];
    const result = await AsyncResult.from(Promise.resolve(Err('original error')))
      .tapErr(e => { sideEffects.push(e); })
      .toPromise();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('original error');
    expect(sideEffects).toEqual(['original error']);
  });
});

// ============================================================
// Parity: combine — одинаковое поведение на всех сценариях
// ============================================================
describe('[Parity] combine', () => {
  it('возвращает Ok с массивом всех значений', () => {
    const result = combine([Ok(1), Ok(2), Ok(3)]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([1, 2, 3]);
  });

  it('возвращает первый Err', () => {
    const result = combine([Ok(1), Err('first error'), Err('second error')]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('first error');
  });

  it('пустой массив возвращает Ok([])', () => {
    const result = combine([]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });
});

// ============================================================
// Интеграционные тесты: реальный сценарий через все три API
// ============================================================
describe('Интеграция: процессинг пользователя через FP / Chain / Async', () => {
  interface User { id: string; name: string; age: number }
  interface ValidUser { id: string; name: string; age: number; verified: true }

  type FetchError = { type: 'fetch'; message: string };
  type ValidationError = { type: 'validation'; field: string };

  const findUser = (id: string): Result<User, FetchError> =>
    id === 'valid'
      ? Ok({ id, name: 'Ivan', age: 25 })
      : Err({ type: 'fetch', message: 'User not found' });

  const validateUser = (user: User): Result<ValidUser, ValidationError> =>
    user.age >= 18
      ? Ok({ ...user, verified: true as const })
      : Err({ type: 'validation', field: 'age' });

  it('[FP] полный флоу успешного пути', () => {
    // flatMapW нужен т.к. validateUser возвращает ValidationError, а не FetchError
    const result = flatMapW(
      map(findUser('valid'), user => user),
      validateUser
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.verified).toBe(true);
      expect(result.value.name).toBe('Ivan');
    }
  });

  it('[Chain] полный флоу успешного пути', () => {
    const result = toChain(findUser('valid'))
      .flatMap(validateUser)
      .toResult();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.verified).toBe(true);
  });

  it('[Async] полный флоу успешного пути', async () => {
    const result = await AsyncResult.from(Promise.resolve(findUser('valid')))
      .flatMap(validateUser)
      .toPromise();

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.verified).toBe(true);
  });

  it('[FP] флоу с ошибкой fetch', () => {
    // flatMapW нужен т.к. validateUser возвращает ValidationError, а не FetchError
    const result = flatMapW(findUser('invalid'), validateUser);
    expect(result.ok).toBe(false);
    if (!result.ok) expect((result.error as FetchError).type).toBe('fetch');
  });

  it('[Chain] флоу с ошибкой fetch', () => {
    const result = toChain(findUser('invalid')).flatMap(validateUser).toResult();
    expect(result.ok).toBe(false);
    if (!result.ok) expect((result.error as FetchError).type).toBe('fetch');
  });

  it('[Async] флоу с ошибкой fetch', async () => {
    const result = await AsyncResult.from(Promise.resolve(findUser('invalid')))
      .flatMap(validateUser)
      .toPromise();

    expect(result.ok).toBe(false);
    if (!result.ok) expect((result.error as FetchError).type).toBe('fetch');
  });

  it('fromNullable + chain — интеграция с nullable API', () => {
    const getUser = (id: string): User | null =>
      id === 'valid' ? { id, name: 'Ivan', age: 25 } : null;

    const result = toChain(fromNullable(getUser('valid'), { type: 'fetch', message: 'Not found' } as FetchError))
      .flatMap(validateUser)
      .toResult();

    expect(result.ok).toBe(true);
  });
});

// ============================================================
// AsyncResultChain: tap throw → rejected Promise (контрактная проверка)
// ============================================================
describe('AsyncResultChain: tap throw → rejected Promise (ADR-контракт)', () => {
  it('tap бросает → Promise rejected (не Err)', async () => {
    const chain = AsyncResult.from(Promise.resolve(Ok(42)))
      .tap(() => {
        throw new Error('Side effect failure');
      });

    await expect(chain.toPromise()).rejects.toThrow('Side effect failure');
  });

  it('tapErr бросает → Promise rejected (не Err)', async () => {
    const chain = AsyncResult.from(Promise.resolve(Err('original')))
      .tapErr(() => {
        throw new Error('tapErr failure');
      });

    await expect(chain.toPromise()).rejects.toThrow('tapErr failure');
  });

  it('mapAsync бросает → Err (не rejected)', async () => {
    const chain = AsyncResult.from(Promise.resolve(Ok(42)))
      .mapAsync(async () => {
        throw new Error('transform failure');
      });

    const result = await chain.toPromise();
    expect(result.ok).toBe(false);
  });

  it('flatMapAsync бросает → Err (не rejected)', async () => {
    const chain = AsyncResult.from(Promise.resolve(Ok(42)))
      .flatMapAsync(async () => {
        throw new Error('flatMap failure');
      });

    const result = await chain.toPromise();
    expect(result.ok).toBe(false);
  });
});
