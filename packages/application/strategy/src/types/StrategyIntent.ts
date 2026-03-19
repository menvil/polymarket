/**
 * Декларативное намерение стратегии.
 *
 * @remarks
 * Стратегия не вызывает API напрямую — она возвращает массив intents из tick().
 * ExecutionEngine нормализует (dedupe), сортирует и исполняет их:
 * 1. CANCEL_ALL → удаляет все отдельные CANCEL (дублирование)
 * 2. Dedupe CANCEL по orderId
 * 3. Cancels параллельно, places последовательно
 *
 * AMEND не поддерживается: Polymarket не имеет атомарного amend.
 * Стратегия сама решает когда отменить старый и разместить новый ордер
 * через два отдельных intenta (CANCEL + PLACE).
 *
 * @example
 * ```typescript
 * // Стратегия возвращает из tick():
 * const intents: StrategyIntent[] = [
 *   { type: 'CANCEL_ALL' },
 *   { type: 'PLACE', side: 'BUY', price: Price.of(new Decimal('0.55')), size: Quantity.of(new Decimal('100')) },
 *   { type: 'PLACE', side: 'SELL', price: Price.of(new Decimal('0.65')), size: Quantity.of(new Decimal('100')) },
 * ];
 * ```
 */
import type { OrderId } from '@polymarket/ids';
import type { Price, Quantity, Side } from '@polymarket/value-objects';

export type StrategyIntent =
  | PlaceIntent
  | CancelIntent
  | CancelAllIntent;

/**
 * Намерение разместить новый ордер.
 *
 * @remarks
 * ExecutionEngine генерирует orderId, привязывает strategyId и instrumentId
 * из ExecutionContext, затем вызывает PlaceOrderUseCase.
 * Risk check — внутри PlaceOrderUseCase (не дублируем).
 */
export interface PlaceIntent {
  readonly type: 'PLACE';
  readonly side: Side;
  readonly price: Price;
  readonly size: Quantity;
}

/**
 * Намерение отменить конкретный ордер.
 *
 * @remarks
 * ExecutionEngine вызывает CancelOrderUseCase(orderId).
 * Если CANCEL_ALL уже есть в batch — отдельные CANCEL удаляются при нормализации.
 */
export interface CancelIntent {
  readonly type: 'CANCEL';
  readonly orderId: OrderId;
}

/**
 * Намерение отменить все открытые ордера стратегии.
 *
 * @remarks
 * ExecutionEngine получает список из OrderStateStore и отменяет каждый.
 * При нормализации: если CANCEL_ALL присутствует, все отдельные CANCEL удаляются.
 */
export interface CancelAllIntent {
  readonly type: 'CANCEL_ALL';
}
