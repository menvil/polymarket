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
 * - **TRADE_APPLIED** — применен trade (OPEN → PARTIALLY_FILLED/FILLED)
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
 * // Trade applied
 * const tradeApplied: OrderChange = {
 *   type: 'TRADE_APPLIED',
 *   trade: tradeObject
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

import type { Trade } from '../Trade';

/**
 * ACCEPTED - биржа приняла заявку
 *
 * @remarks
 * Переход: PENDING → OPEN
 * Заявка выставлена на биржу и может быть заполнена.
 */
export interface OrderChangeAccepted {
  readonly type: 'ACCEPTED';
}

/**
 * REJECTED - биржа отклонила заявку
 *
 * @remarks
 * Переход: PENDING → REJECTED
 * Заявка не прошла валидацию биржи (недостаточно средств, невалидная цена и т.д.)
 * Требуется указать причину отклонения.
 */
export interface OrderChangeRejected {
  readonly type: 'REJECTED';
  readonly reason: string;
}

/**
 * CANCELLED - пользователь отменил заявку
 *
 * @remarks
 * Переход: OPEN или PARTIALLY_FILLED → CANCELED
 * Заявка снята с биржи по инициативе пользователя.
 * Причина опциональна (может быть указана через Order.cancel(reason)).
 */
export interface OrderChangeCancelled {
  readonly type: 'CANCELLED';
  readonly reason: string;
}

/**
 * EXPIRED - заявка истекла по времени
 *
 * @remarks
 * Переход: OPEN или PARTIALLY_FILLED → EXPIRED
 * Заявка автоматически снята с биржи по истечению TTL/expiry time.
 */
export interface OrderChangeExpired {
  readonly type: 'EXPIRED';
}

/**
 * TRADE_APPLIED - применен trade к заявке
 *
 * @remarks
 * Переходы:
 * - OPEN → PARTIALLY_FILLED (если остаток > 0)
 * - OPEN/PARTIALLY_FILLED → FILLED (если остаток = 0)
 *
 * Содержит Trade объект с деталями исполнения.
 */
export interface OrderChangeTradeApplied {
  readonly type: 'TRADE_APPLIED';
  readonly trade: Trade;
}

/**
 * OrderChange - discriminated union всех возможных изменений
 *
 * @remarks
 * TypeScript использует поле `type` для type narrowing.
 * Exhaustiveness check гарантирует что все case обработаны в switch.
 *
 * @example
 * ```typescript
 * function handleChange(change: OrderChange) {
 *   switch (change.type) {
 *     case 'ACCEPTED':
 *       // TypeScript знает что здесь OrderChangeAccepted
 *       break;
 *     case 'REJECTED':
 *       // change.reason доступен
 *       console.log(change.reason);
 *       break;
 *     case 'CANCELLED':
 *       console.log(change.reason);
 *       break;
 *     case 'EXPIRED':
 *       break;
 *     case 'TRADE_APPLIED':
 *       // change.trade доступен
 *       console.log(change.trade.id);
 *       break;
 *     default:
 *       const _exhaustive: never = change; // Ошибка если case забыт
 *       throw new Error(`Unhandled change type`);
 *   }
 * }
 * ```
 */
export type OrderChange =
  | OrderChangeAccepted
  | OrderChangeRejected
  | OrderChangeCancelled
  | OrderChangeExpired
  | OrderChangeTradeApplied;
