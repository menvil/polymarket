/**
 * FSM (Finite State Machine) для Order transitions
 *
 * @remarks
 * Этот модуль экспортирует всё необходимое для работы с переходами состояния Order:
 * - OrderFSM - главный dispatcher
 * - guards - функции-проверки возможности переходов
 * - handlers - обработчики конкретных переходов
 *
 * @example
 * ```typescript
 * import { OrderFSM, canCancel } from '@polymarket/entities/order';
 *
 * if (canCancel(order.status)) {
 *   const change = { type: 'CANCELLED', reason: 'User request' };
 *   const result = OrderFSM.apply(orderData, change);
 * }
 * ```
 */

export { OrderFSM } from './OrderFSM';

export {
  canAccept,
  canReject,
  canCancel,
  canExpire,
  canApplyTrade,
  canAcceptTradeDetailed,
  requiresReason,
  type TradeValidationParams,
} from './guards';

export {
  handleAccepted,
  handleRejected,
  handleCancelled,
  handleExpired,
  handleTradeApplied,
  type OrderData,
  type TradeParams,
} from './handlers';
