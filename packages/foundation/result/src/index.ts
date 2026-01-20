/**
 * @polymarket/result - Foundation type utilities
 *
 * @remarks
 * Базовые типы для функционального программирования в Polymarket trading system.
 * Railway-Oriented Programming через Result<T, E>.
 *
 * Архитектура:
 * - Result<T, E> - явная обработка ошибок без exceptions
 * - Ok/Err - конструкторы для создания Result (plain objects)
 * - OkChain/ErrChain - конструкторы для method chaining (OOP)
 * - AsyncResultChain - method chaining для async операций
 * - map/flatMap - композиция операций (функции)
 * - .map()/.flatMap() - композиция операций (методы)
 * - Type-safe error handling
 *
 * Три стиля использования:
 *
 * **1. Функциональный стиль (plain objects):**
 * ```typescript
 * import { Result, Ok, Err, map, flatMap } from '@polymarket/result';
 *
 * function divide(a: number, b: number): Result<number, string> {
 *   if (b === 0) return Err('Division by zero');
 *   return Ok(a / b);
 * }
 *
 * const result = divide(10, 2);
 * if (result.ok) {
 *   console.log('Result:', result.value); // 5
 * }
 *
 * // Композиция через функции
 * const doubled = map(result, x => x * 2);
 * ```
 *
 * **2. OOP стиль (method chaining):**
 * ```typescript
 * import { OkChain, ErrChain } from '@polymarket/result';
 *
 * const result = OkChain(10)
 *   .map(x => x / 2)
 *   .map(x => x * 2)
 *   .unwrapOr(0);
 * // result: 10
 * ```
 *
 * **3. Async стиль (для Promise<Result>):**
 * ```typescript
 * import { AsyncResult } from '@polymarket/result';
 *
 * const user = await AsyncResult.from(fetchUser('123'))
 *   .mapAsync(user => enrichUserData(user))
 *   .flatMapAsync(user => validateUser(user))
 *   .unwrapOr({ id: 'guest', name: 'Guest' });
 * ```
 *
 * **Advanced patterns:**
 *
 * *Union error types:*
 * ```typescript
 * type NetworkError = { type: 'network'; code: number };
 * type ValidationError = { type: 'validation'; field: string };
 * type AppError = NetworkError | ValidationError;
 *
 * function fetchAndValidate(id: string): Result<User, AppError> {
 *   return OkChain({ id, name: 'Test' })
 *     .flatMap(user => validateUser(user))
 *     .toResult();
 * }
 * ```
 *
 * *Recovery patterns:*
 * ```typescript
 * const result = await AsyncResult.from(primaryAPI())
 *   .orElseAsync(err => {
 *     console.log('Primary failed:', err);
 *     return fallbackAPI(); // Fallback при ошибке
 *   })
 *   .unwrapOr(defaultValue);
 * ```
 *
 * *Safe wrapping throwable functions:*
 * ```typescript
 * const safeJSON = fromThrowable(
 *   JSON.parse,
 *   (error) => `Parse error: ${error}`
 * );
 * const result = safeJSON('{"name":"John"}');
 * // result: Ok({name: "John"})
 * ```
 *
 * @packageDocumentation
 */

export * from './result.js';
export * from './ResultChain.js';
export * from './AsyncResultChain.js';
