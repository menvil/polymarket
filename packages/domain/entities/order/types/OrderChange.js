/**
 * OrderChange - discriminated union для FSM transitions
 *
 * @remarks
 * OrderChange описывает все возможные изменения состояния Order.
 * Используется в Order._transition() и OrderFSM.apply().
 *
 * ## Discriminated Union Pattern:
 * Каждый тип OrderChange имеет уникальное поле `type`.
 * TypeScript использует это для type narrowing и exhaustiveness check.
 *
 * ## Типы изменений:
 * - **ACCEPTED** — биржа приняла заявку (PENDING → OPEN)
 * - **REJECTED** — биржа отклонила заявку (PENDING → REJECTED)
 * - **CANCELLED** — пользователь отменил заявку (OPEN/PARTIALLY_FILLED → CANCELED)
 * - **EXPIRED** — заявка истекла по времени (OPEN/PARTIALLY_FILLED → EXPIRED)
 * - **FILL_APPLIED** — применен fill исполнения нашего ордера (OPEN → PARTIALLY_FILLED/FILLED)
 *
 * @example
 * ```typescript
 * import type { OrderChange } from './OrderChange';
 *
 * // Accepted
 * const accepted: OrderChange = { type: 'ACCEPTED' };
 *
 * // Rejected с причиной
 * const rejected: OrderChange = {
 *   type: 'REJECTED',
 *   reason: 'Insufficient funds'
 * };
 *
 * // Fill applied
 * const fillApplied: OrderChange = {
 *   type: 'FILL_APPLIED',
 *   fill: fillObject
 * };
 *
 * // Pattern matching
 * switch (change.type) {
 *   case 'ACCEPTED':
 *     // change.reason не существует здесь
 *     break;
 *   case 'REJECTED':
 *     // change.reason доступен здесь
 *     console.log(change.reason);
 *     break;
 *   // ... exhaustive check
 * }
 * ```
 */
export {};
//# sourceMappingURL=OrderChange.js.map