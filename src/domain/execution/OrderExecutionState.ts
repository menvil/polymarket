import type { ExecutionEvent } from '../events/ExecutionEvent.js';

/**
 * OrderExecutionState - формальная state machine для execution
 *
 * @remarks
 * Decision Layer требует чёткую FSM
 *
 * Почему нужна FSM:
 * - Decision Layer должен знать allowed transitions
 * - Aggregate проверяет FSM при applyExecutionEvent()
 * - Replay проверяет корректность event stream
 * - Debugging: invalid transition = red flag
 */
export enum OrderExecutionState {
  /**
   * OPEN - ордер принят биржей, ждёт исполнения
   */
  OPEN = 'OPEN',

  /**
   * PARTIALLY_FILLED - ордер частично исполнен
   */
  PARTIALLY_FILLED = 'PARTIALLY_FILLED',

  /**
   * FILLED - ордер полностью исполнен
   */
  FILLED = 'FILLED',

  /**
   * CANCELED - ордер отменён
   */
  CANCELED = 'CANCELED',

  /**
   * REJECTED - ордер отклонён биржей
   */
  REJECTED = 'REJECTED',
}

/**
 * Allowed transitions matrix
 *
 * @remarks
 * Aggregate проверяет allowed transitions
 *
 * Таблица transitions:
 * - OPEN → PARTIALLY_FILLED (OrderPartiallyFilled)
 * - OPEN → FILLED (OrderFilled)
 * - OPEN → CANCELED (OrderCancelled)
 * - OPEN → REJECTED (OrderRejected)
 * - PARTIALLY_FILLED → PARTIALLY_FILLED (OrderPartiallyFilled)
 * - PARTIALLY_FILLED → FILLED (OrderFilled)
 * - PARTIALLY_FILLED → CANCELED (OrderCancelled)
 * - PARTIALLY_FILLED → REJECTED (OrderRejected)
 * - FILLED → НИКУДА (terminal state)
 * - CANCELED → НИКУДА (terminal state)
 * - REJECTED → НИКУДА (terminal state)
 *
 * @example
 * ```typescript
 * // Проверка allowed transition
 * const currentState = OrderExecutionState.OPEN;
 * const targetState = OrderExecutionState.PARTIALLY_FILLED;
 *
 * if (!isAllowedTransition(currentState, targetState)) {
 *   throw new Error(`Invalid transition: ${currentState} → ${targetState}`);
 * }
 * ```
 */
export const ALLOWED_TRANSITIONS: Record<OrderExecutionState, OrderExecutionState[]> = {
  [OrderExecutionState.OPEN]: [
    OrderExecutionState.PARTIALLY_FILLED,
    OrderExecutionState.FILLED,
    OrderExecutionState.CANCELED,
    OrderExecutionState.REJECTED,
  ],
  [OrderExecutionState.PARTIALLY_FILLED]: [
    OrderExecutionState.PARTIALLY_FILLED, // Может быть multiple fills
    OrderExecutionState.FILLED,
    OrderExecutionState.CANCELED,
    OrderExecutionState.REJECTED,
  ],
  [OrderExecutionState.FILLED]: [],
  [OrderExecutionState.CANCELED]: [],
  [OrderExecutionState.REJECTED]: [],
};

/**
 * Проверяет allowed transition
 *
 * @param from - Текущий state
 * @param to - Target state
 * @returns true если transition allowed
 *
 * @example
 * ```typescript
 * // Valid transitions
 * isAllowedTransition(OrderExecutionState.OPEN, OrderExecutionState.FILLED); // true
 * isAllowedTransition(OrderExecutionState.PARTIALLY_FILLED, OrderExecutionState.FILLED); // true
 *
 * // Invalid transitions
 * isAllowedTransition(OrderExecutionState.FILLED, OrderExecutionState.OPEN); // false
 * isAllowedTransition(OrderExecutionState.CANCELED, OrderExecutionState.FILLED); // false
 * ```
 */
export function isAllowedTransition(from: OrderExecutionState, to: OrderExecutionState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Проверяет terminal state (FILLED, CANCELED)
 *
 * @param state - State для проверки
 * @returns true если state terminal
 *
 * @remarks
 * Terminal states не могут переходить в другие states.
 * После достижения terminal state, Order НЕ может измениться.
 *
 * @example
 * ```typescript
 * isTerminalState(OrderExecutionState.FILLED); // true
 * isTerminalState(OrderExecutionState.CANCELED); // true
 * isTerminalState(OrderExecutionState.OPEN); // false
 * isTerminalState(OrderExecutionState.PARTIALLY_FILLED); // false
 * ```
 */
export function isTerminalState(state: OrderExecutionState): boolean {
  return state === OrderExecutionState.FILLED || state === OrderExecutionState.CANCELED;
}

/**
 * Вычисляет target state для ExecutionEvent
 *
 * @param event - ExecutionEvent
 * @param _currentFilledTotal - Текущий filledTotal (для определения PARTIALLY_FILLED vs FILLED)
 * @param _orderSize - Размер ордера
 * @returns Target OrderExecutionState
 *
 * @remarks
 * Aggregate использует это для FSM transitions
 *
 * Логика:
 * - OrderAccepted → OPEN
 * - OrderPartiallyFilled → PARTIALLY_FILLED
 * - OrderFilled → FILLED
 * - OrderCancelled → CANCELED
 * - OrderRejected → REJECTED
 *
 * @example
 * ```typescript
 * const event: OrderPartiallyFilled = {
 *   type: 'OrderPartiallyFilled',
 *   orderId: '123',
 *   filledDelta: 50,
 *   price: 100
 * };
 *
 * const targetState = targetStateForEvent(event, 50, 100);
 * // targetState = OrderExecutionState.PARTIALLY_FILLED
 * ```
 */
export function targetStateForEvent(
  event: ExecutionEvent,
  _currentFilledTotal: number,
  _orderSize: number
): OrderExecutionState {
  switch (event.type) {
    case 'OrderAccepted':
      return OrderExecutionState.OPEN;

    case 'OrderPartiallyFilled':
      return OrderExecutionState.PARTIALLY_FILLED;

    case 'OrderFilled':
      return OrderExecutionState.FILLED;

    case 'OrderCancelled':
      return OrderExecutionState.CANCELED;

    case 'OrderRejected':
      return OrderExecutionState.REJECTED;

    default: {
      const _exhaustive: never = event;
      throw new Error(`Unhandled ExecutionEvent: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
