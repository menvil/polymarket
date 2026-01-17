/**
 * ExecutionEvent - ТОЛЬКО факты внешнего мира (биржа, CLOB API)
 *
 * @remarks
 * КРИТИЧНО v7.7.15: Только OrderAccepted, OrderCancelled, OrderRejected!
 * OrderPartiallyFilled и OrderFilled УДАЛЕНЫ - стратегия работает только по StrategyTick!
 *
 * Execution остаётся чистым.
 * Можно реплеить execution-stream из биржевых логов.
 *
 * Если событие НЕ факт биржи → оно НЕ ExecutionEvent.
 *
 * Принципы:
 * - ExecutionEvent = факты внешнего мира (биржа, CLOB API)
 * - Self-contained (deterministic without external state)
 * - Включает timestamp для deterministic replay (v4)
 * - OrderAccepted содержит MINIMAL CONTEXT (side, marketId, price, size)
 * - Immutable facts
 *
 * v7.7.15 changes:
 * - OrderPartiallyFilled УДАЛЁН (стратегия не использует)
 * - OrderFilled УДАЛЁН (стратегия не использует)
 * - Стратегия работает ТОЛЬКО по StrategyTick + ctx.getInventory()
 */
export type ExecutionEvent =
  | OrderAccepted
  | OrderCancelled
  | OrderRejected;

/**
 * ExecutionErrorEvent - execution errors (для metrics/logging)
 *
 * @remarks
 * LEGACY: Separated error events для metrics/logging.
 * OrderRejected теперь также в ExecutionEvent (для FSM compatibility).
 *
 * Обработка:
 * - ErrorMetricsProjector подписывается
 * - Может быть отдельный ErrorEventBus / topic
 */
export type ExecutionErrorEvent =
  | OrderRejected
  | OrderValidationFailed;

/**
 * OrderAccepted - ордер принят биржей
 *
 * @remarks
 * OrderAccepted содержит MINIMAL CONTEXT
 *
 * Почему context необходим:
 * - Projector должен создать Order aggregate детерминированно
 * - NO Pending Orders Registry (hidden state, NOT evented, NOT replay-friendly)
 * - ExecutionEvent = self-contained (без external dependencies)
 * - side, marketId, price, size - execution-time facts, NOT business decisions
 *
 * Context = MINIMAL:
 * - side: BUY | SELL (execution fact)
 * - marketId: string (где исполняется)
 * - price: number (лимит цена, принятая биржей)
 * - size: number (размер, принятый биржей)
 *
 * v4: timestamp field для deterministic replay
 * v4.2 (Фаза 4): strategyId для multi-strategy изоляции
 *
 * Invariants проверяются в AGGREGATE, NOT в mapper
 * - Mapper = pure parsing (может вернуть price=0 для replay на грязных данных)
 * - Aggregate проверяет: price > 0, size > 0, marketId non-empty
 */
export interface OrderAccepted {
  readonly type: 'OrderAccepted';
  readonly orderId: string; // Биржевой ID
  readonly strategyId?: string; // v4.2: для multi-strategy изоляции (optional для обратной совместимости)
  readonly side: 'BUY' | 'SELL';
  readonly marketId: string;
  readonly price: number; // Aggregate проверит > 0
  readonly size: number; // Aggregate проверит > 0
  readonly timestamp: Date; // v4: для deterministic replay
}

/**
 * v7.7.15: OrderPartiallyFilled УДАЛЁН
 * v7.7.15: OrderFilled УДАЛЁН
 *
 * @remarks
 * Стратегия работает ТОЛЬКО по StrategyTick!
 * Inventory берётся из ctx.getInventory() (синхронизируется каждые 4 секунды с биржей).
 * События fill НЕ НУЖНЫ для принятия решений стратегией.
 */

/**
 * OrderCancelled - ордер отменён
 *
 * @remarks
 * v4: timestamp field для deterministic replay
 * v4.2 (Фаза 4): strategyId для multi-strategy изоляции
 */
export interface OrderCancelled {
  readonly type: 'OrderCancelled';
  readonly orderId: string;
  readonly strategyId?: string; // v4.2: для multi-strategy изоляции (optional для обратной совместимости)
  readonly reason?: string;
  readonly timestamp: Date; // v4: для deterministic replay
}

/**
 * OrderRejected - ордер отклонён биржей
 *
 * @remarks
 * v4: OrderRejected включён в ExecutionEvent (для FSM compatibility)
 *
 * Семантика:
 * - OrderRejected = execution error, НО также часть ExecutionEvent (для FSM)
 * - Для DumbStrategy FSM: OrderRejected → STOPPED state
 * - Для metrics/logging: также в ExecutionErrorEvent
 *
 * v4: timestamp field для deterministic replay
 * v4.2 (Фаза 4): strategyId для multi-strategy изоляции
 *
 * orderId может быть undefined - ордер не дошёл до биржи (validation error)
 */
export interface OrderRejected {
  readonly type: 'OrderRejected';
  readonly orderId?: string; // Может быть undefined если ордер не дошёл до биржи
  readonly strategyId?: string; // v4.2: для multi-strategy изоляции (optional для обратной совместимости)
  readonly reason: string;
  readonly errorCode?: string;
  readonly timestamp: Date; // v4: для deterministic replay
}

/**
 * OrderValidationFailed - ордер не прошёл validation до отправки на биржу
 *
 * @remarks
 * OrderValidationFailed = ExecutionErrorEvent (pre-execution error)
 *
 * Отличие от OrderRejected:
 * - OrderRejected = биржа отклонила
 * - OrderValidationFailed = не дошёл до биржи (pre-flight validation)
 */
export interface OrderValidationFailed {
  readonly type: 'OrderValidationFailed';
  readonly orderId?: string; // Может быть null если ID не сгенерирован
  readonly reason: string;
  readonly validationErrors: Record<string, string>; // field → error message
}

// Type guards для ExecutionEvent (используются ТОЛЬКО в infrastructure, NOT в projectors)
export function isOrderAccepted(event: ExecutionEvent): event is OrderAccepted {
  return event.type === 'OrderAccepted';
}

export function isOrderCancelled(event: ExecutionEvent): event is OrderCancelled {
  return event.type === 'OrderCancelled';
}

// v7.7.15: isOrderPartiallyFilled УДАЛЁН
// v7.7.15: isOrderFilled УДАЛЁН

// Type guards для ExecutionErrorEvent
export function isOrderRejected(event: ExecutionErrorEvent): event is OrderRejected {
  return event.type === 'OrderRejected';
}

export function isOrderValidationFailed(event: ExecutionErrorEvent): event is OrderValidationFailed {
  return event.type === 'OrderValidationFailed';
}
