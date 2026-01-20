/**
 * @polymarket/types - Foundation type utilities
 *
 * @remarks
 * Базовые типы для функционального программирования в Polymarket trading system.
 * Railway-Oriented Programming через Result<T, E>.
 *
 * Архитектура:
 * - Result<T, E> - явная обработка ошибок без exceptions
 * - Ok/Err - конструкторы для создания Result (plain objects)
 * - OkChain/ErrChain - конструкторы для method chaining (OOP)
 * - map/flatMap - композиция операций (функции)
 * - .map()/.flatMap() - композиция операций (методы)
 * - Type-safe error handling
 *
 * Два стиля использования:
 *
 * **1. Функциональный стиль (plain objects):**
 * ```typescript
 * import { Result, Ok, Err, map, flatMap } from '@polymarket/types';
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
 * import { OkChain, ErrChain } from '@polymarket/types';
 *
 * const result = OkChain(10)
 *   .map(x => x / 2)
 *   .map(x => x * 2)
 *   .unwrapOr(0);
 * // result: 10
 * ```
 *
 * @packageDocumentation
 */

export * from './result.js';
export * from './ResultChain.js';