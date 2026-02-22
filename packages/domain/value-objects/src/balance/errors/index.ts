/**
 * Balance Errors - типизированные причины ошибок для Balance
 *
 * @remarks
 * Этот модуль содержит enum для типизированных причин ошибок Balance операций.
 *
 * **Преимущества типизированных enum:**
 * - ✅ Compile-time проверка на опечатки
 * - ✅ Автодополнение в IDE
 * - ✅ Exhaustive checking в switch statements
 * - ✅ Безопасный рефакторинг через "Rename Symbol"
 *
 * **Категории ошибок:**
 *
 * 1. **Недостаточно средств:**
 *    - INSUFFICIENT_FUNDS - недостаточно available для reserve
 *    - INSUFFICIENT_RESERVED - недостаточно reserved для unfreezeReserved/consumeReserved
 *
 * 2. **Валидация валюты:**
 *    - CURRENCY_MISMATCH - несовпадение валют
 *    - UNSUPPORTED_CURRENCY - неизвестная валюта
 *
 * 3. **Нарушение инвариантов:**
 *    - NEGATIVE_AVAILABLE - available amount < 0
 *    - NEGATIVE_RESERVED - reserved amount < 0
 *
 * 4. **Ошибки парсинга:**
 *    - INVALID_FORMAT - ошибка парсинга входных данных
 *
 * @example
 * ```typescript
 * import { BalanceErrorReason } from '@polymarket/value-objects/balance';
 *
 * // Type-safe проверка ошибок
 * if (result.error.context?.reason === BalanceErrorReason.INSUFFICIENT_FUNDS) {
 *   console.log('Not enough available funds');
 * }
 *
 * // Exhaustive checking в switch
 * switch (result.error.context?.reason) {
 *   case BalanceErrorReason.INSUFFICIENT_FUNDS:
 *     console.log('Available funds too low');
 *     break;
 *   case BalanceErrorReason.INSUFFICIENT_RESERVED:
 *     console.log('Reserved funds too low');
 *     break;
 *   case BalanceErrorReason.CURRENCY_MISMATCH:
 *     console.log('Currency mismatch detected');
 *     break;
 *   // TypeScript проверит что все cases покрыты
 * }
 * ```
 *
 * @packageDocumentation
 */

export * from './BalanceErrorReason';
