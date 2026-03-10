/**
 * @polymarket/result - Foundation type utilities
 *
 * @remarks
 * Базовые типы для функционального программирования в Polymarket trading system.
 * Railway-Oriented Programming через Result<T, E>.
 *
 * ## Архитектура
 *
 * - `result.ts` — **ядро**: все FP-функции, единственный источник бизнес-логики
 * - `unsafe.ts` — операции бросающие исключения (unwrap, expectOk)
 * - `ResultChain.ts` — тонкий OOP-адаптер поверх ядра
 * - `AsyncResultChain.ts` — тонкий async-адаптер поверх ядра
 *
 * ## Рекомендуемый путь импорта (для новых пользователей)
 *
 * Основной API — функциональный стиль, все функции safe по умолчанию:
 *
 * ```typescript
 * import {
 *   Result, Ok, Err,
 *   map, flatMap, flatMapW, mapErr, combine,
 *   match, tryCatch, tryAsync,
 *   fromPromise, fromNullable, fromThrowable,
 *   unwrapOr, unwrapOrElse,
 * } from '@polymarket/result';
 * ```
 *
 * ## OOP-стиль (method chaining)
 *
 * ```typescript
 * import { OkChain, ErrChain, toChain } from '@polymarket/result/chain';
 * // или из основного пути для backward compatibility:
 * import { OkChain, ErrChain } from '@polymarket/result';
 *
 * const result = OkChain(10)
 *   .map(x => x / 2)
 *   .map(x => x * 2)
 *   .unwrapOr(0);
 * ```
 *
 * ## Async-стиль (для Promise<Result>)
 *
 * ```typescript
 * import { AsyncResult } from '@polymarket/result/async';
 * // или из основного пути для backward compatibility:
 * import { AsyncResult } from '@polymarket/result';
 *
 * const user = await AsyncResult.from(fetchUser('123'))
 *   .mapAsync(user => enrichUserData(user))
 *   .flatMapAsync(user => validateUser(user))
 *   .unwrapOr({ id: 'guest', name: 'Guest' });
 * ```
 *
 * ## Unsafe операции (явно помечены)
 *
 * ```typescript
 * import { unwrap, expectOk } from '@polymarket/result/unsafe';
 * ```
 *
 * ## Widen-варианты для union-типов ошибок
 *
 * ```typescript
 * type NetworkError = { type: 'network'; code: number };
 * type ValidationError = { type: 'validation'; field: string };
 *
 * const result = flatMapW(
 *   fetchUser('123'),                      // Result<User, NetworkError>
 *   user => validateUser(user)              // Result<ValidUser, ValidationError>
 * );
 * // result: Result<ValidUser, NetworkError | ValidationError>
 * ```
 *
 * @packageDocumentation
 */
export { type Result, Ok, Err, isOk, isErr, map, flatMap, flatMapW, mapErr, mapErrW, orElseW, match, combine, unwrapOr, unwrapOrElse, tryCatch, tryAsync, fromPromise, fromNullable, fromThrowable, } from './result.js';
export { ResultChain, OkChain, ErrChain, toChain, R, } from './ResultChain.js';
export { AsyncResultChain, AsyncResult } from './AsyncResultChain.js';
//# sourceMappingURL=index.d.ts.map