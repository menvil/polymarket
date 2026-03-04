/**
 * FSM (Finite State Machine) для Order transitions
 *
 * @remarks
 * Этот модуль экспортирует всё необходимое для работы с переходами состояния Order:
 * - OrderFSM - чистый валидатор переходов (принимает status + change)
 * - guards - функции-проверки возможности переходов
 *
 * @example
 * ```typescript
 * import { OrderFSM, canCancel } from '@polymarket/entities/order';
 *
 * // Проверка guard напрямую
 * if (canCancel(order.status)) {
 *   const result = order.cancel('User request');
 * }
 * ```
 */

export { OrderFSM } from './OrderFSM.js';

export {
  canAccept,
  canReject,
  canCancel,
  canExpire,
  canApplyFill,
  canAcceptFillDetailed,
  requiresReason,
  type FillValidationParams,
} from './guards.js';
