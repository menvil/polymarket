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
 * - `unsafe.ts` — операции бросающие исключения (unwrap, expect)
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
 * import { unwrap, expect } from '@polymarket/result/unsafe';
 * // или из основного пути (для backward compatibility):
 * import { unwrap } from '@polymarket/result';
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

// ============================================================
// Ядро (рекомендуемый путь, safe API)
// ============================================================
export {
  // Тип и конструкторы
  type Result,
  Ok,
  Err,
  // Type guards
  isOk,
  isErr,
  // Трансформации (safe)
  map,
  flatMap,
  flatMapW,
  mapErr,
  mapErrW,
  // Recovery
  orElseW,
  match,
  // Комбинаторы
  combine,
  // Извлечение значения (safe)
  unwrapOr,
  unwrapOrElse,
  // Unsafe (для backward compatibility — предпочитайте @polymarket/result/unsafe)
  unwrap,
  // Хелперы для интеграции с внешним миром
  tryCatch,
  tryAsync,
  fromPromise,
  fromNullable,
  fromThrowable,
  // Внутренний хелпер (для advanced usage)
  formatValue,
} from './result.js';

// ============================================================
// OOP-адаптер (backward compatibility — предпочитайте /chain)
// ============================================================
export {
  ResultChain,
  OkChain,
  ErrChain,
  toChain,
  R,
} from './ResultChain.js';

// ============================================================
// Async-адаптер (backward compatibility — предпочитайте /async)
// ============================================================
export { AsyncResultChain, AsyncResult } from './AsyncResultChain.js';
