/**
 * Order Execution State - состояния исполнения ордеров
 *
 * @remarks
 * FSM (Finite State Machine) для валидации переходов между состояниями ордеров.
 */

/**
 * Состояния исполнения ордера
 */
export enum OrderExecutionState {
  OPEN = 'OPEN',
  FILLED = 'FILLED',
  CANCELED = 'CANCELED',
  REJECTED = 'REJECTED',
}

/**
 * Разрешенные переходы состояний FSM
 */
const ALLOWED_TRANSITIONS: Record<OrderExecutionState, OrderExecutionState[]> = {
  [OrderExecutionState.OPEN]: [
    OrderExecutionState.FILLED,
    OrderExecutionState.CANCELED,
  ],
  [OrderExecutionState.FILLED]: [],
  [OrderExecutionState.CANCELED]: [],
  [OrderExecutionState.REJECTED]: [],
};

/**
 * Проверяет, разрешён ли переход между состояниями
 *
 * @param from - Текущее состояние
 * @param to - Целевое состояние
 * @returns True если переход разрешён
 *
 * @remarks
 * Использует FSM для валидации переходов.
 * Терминальные состояния (FILLED, CANCELED, REJECTED) не могут переходить в другие.
 *
 * @example
 * ```typescript
 * isAllowedTransition(OrderExecutionState.OPEN, OrderExecutionState.FILLED); // true
 * isAllowedTransition(OrderExecutionState.FILLED, OrderExecutionState.CANCELED); // false
 * ```
 */
export function isAllowedTransition(
  from: OrderExecutionState,
  to: OrderExecutionState
): boolean {
  const allowed = ALLOWED_TRANSITIONS[from] || [];
  return allowed.includes(to);
}
