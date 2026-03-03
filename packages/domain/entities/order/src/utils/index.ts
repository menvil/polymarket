/**
 * Утилиты для Order
 *
 * @remarks
 * Этот модуль экспортирует вспомогательные функции для работы с Order:
 * - calculations - вычисления (notional, remaining size, fill percentage)
 * - predicates - предикаты (isFilled, isOpen, isPending, etc.)
 *
 * @example
 * ```typescript
 * import { getNotional, isFilled, isPartiallyFilled } from '@polymarket/entities/order';
 *
 * const notional = getNotional(order.price, order.size);
 * if (isFilled(order.status)) {
 *   console.log('Order completed');
 * }
 * ```
 */

export {
  getNotional,
  getRemainingSize,
  getFillPercentage,
} from './calculations.js';

export {
  isFilled,
  isOpen,
  isPending,
  isCanceled,
  isRejected,
  isExpired,
  isPartiallyFilled,
  isTerminal,
  isActive,
  canModify,
  isFailed,
  isSuccessful,
} from './predicates.js';
