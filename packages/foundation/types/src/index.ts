/**
 * @polymarket/types - Foundation type utilities
 *
 * @remarks
 * Базовые типы для функционального программирования в Polymarket trading system.
 * Railway-Oriented Programming через Result<T, E>.
 *
 * Архитектура:
 * - Result<T, E> - явная обработка ошибок без exceptions
 * - Ok/Err - конструкторы для создания Result
 * - map/flatMap - композиция операций
 * - Type-safe error handling
 *
 * Использование:
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
 * } else {
 *   console.error('Error:', result.error);
 * }
 *
 * // Композиция операций
 * const doubled = map(result, x => x * 2);
 * // doubled: Ok(10)
 *
 * // Цепочка операций
 * const chained = flatMap(divide(10, 2), x => divide(x, 2));
 * // chained: Ok(2.5)
 * ```
 *
 * @packageDocumentation
 */

export * from './result.js';