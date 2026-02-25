/**
 * Value Objects для Order entity
 *
 * @remarks
 * Этот модуль экспортирует все value objects связанные с Order:
 * - OrderStatus - discriminated union статус заявки
 * - CancelReason - типизированные причины отмены
 * - RejectReason - типизированные причины отклонения
 * - ExpireReason - типизированные причины истечения
 * - OrderFill - информация о заполнении заявки
 *
 * Side (BUY/SELL) импортируется из @polymarket/value-objects
 */

// OrderStatus (simple string union type)
export {
  type OrderStatus,
  type OrderStatusType,
  OrderStatusConstructors,
  ORDER_STATUS_TYPES,
  TERMINAL_STATUS_TYPES,
  ACTIVE_STATUS_TYPES,
  isPending,
  isOpen,
  isPartiallyFilled,
  isFilled,
  isCanceled,
  isRejected,
  isExpired,
  isTerminal,
  isActive,
  canCancel,
  canTransition,
  getNextStatusTypes,
  isValidStatusType,
  statusToString,
} from './OrderStatus.js';

// Typed reasons
export {
  CancelReason,
  CANCEL_REASONS,
  isValidCancelReason,
} from './CancelReason.js';

export {
  RejectReason,
  REJECT_REASONS,
  isValidRejectReason,
} from './RejectReason.js';

export {
  ExpireReason,
  EXPIRE_REASONS,
  isValidExpireReason,
} from './ExpireReason.js';

// OrderFill
export { OrderFill } from './OrderFill.js';
