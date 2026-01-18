/**
 * StrategyIntent - намерения стратегии (НЕ команды)
 *
 * @remarks
 * Стратегия возвращает ИНТЕНТЫ → executor исполняет их.
 *
 * Почему интенты, а не команды:
 * - Можно фильтровать (risk limits) - но НЕ в Executor!
 * - Можно логировать (audit trail)
 * - Можно отменять (перед исполнением)
 * - Testable (можно проверить, какие intents генерирует стратегия)
 * - Separation of concerns (стратегия решает "что", executor решает "как")
 *
 * v2 правило:
 * Executor НЕ фильтрует intents (только исполняет).
 * Фильтрация (если нужна) происходит в отдельном слое (risk manager).
 *
 * @example
 * ```typescript
 * // Стратегия генерирует intents:
 * onExecutionEvent(event: StrategyEvent, ctx: StrategyContext): StrategyIntent[] {
 *   if (event.type === 'StrategyStarted') {
 *     return [
 *       {
 *         type: 'PlaceOrder',
 *         params: {
 *           tokenId: '0x123',
 *           side: 'buy',
 *           price: 0.52,
 *           size: 100,
 *         },
 *         reason: 'Initial quote',
 *       }
 *     ];
 *   }
 *   return [];
 * }
 *
 * // Executor исполняет intents:
 * execute(intents: StrategyIntent[], ctx: StrategyContext): void {
 *   for (const intent of intents) {
 *     if (isPlaceOrderIntent(intent)) {
 *       ctx.placeLimitOrder(intent.params); // ✅ Тупо исполняет
 *     }
 *   }
 * }
 * ```
 */

import type { PlaceLimitOrderParams } from './StrategyContext.js';

/**
 * PlaceOrderIntent - намерение разместить ордер
 *
 * @remarks
 * v4.2 (Фаза 4): strategyId для domain correlation
 * strategyId = связь intent → strategy → event
 * Позволяет изолировать события multiple strategies
 */
export interface PlaceOrderIntent {
  readonly type: 'PlaceOrder';
  readonly strategyId: string; // v4.2: Domain correlation (связь intent → strategy → event)
  readonly params: PlaceLimitOrderParams;
  readonly reason?: string; // Optional: для audit trail
}

/**
 * CancelOrderIntent - намерение отменить ордер
 *
 * @remarks
 * v4.2 (Фаза 4): strategyId для domain correlation
 * strategyId = связь intent → strategy → event
 * Позволяет изолировать события multiple strategies
 */
export interface CancelOrderIntent {
  readonly type: 'CancelOrder';
  readonly strategyId: string; // v4.2: Domain correlation (связь intent → strategy → event)
  readonly orderId: string;
  readonly reason?: string; // Optional: для audit trail
}

/**
 * NoopIntent - намерение ничего не делать
 *
 * @remarks
 * Полезно для явного указания "стратегия ничего не делает в этом цикле".
 * Можно использовать для debugging/telemetry.
 */
export interface NoopIntent {
  readonly type: 'Noop';
}

/**
 * StrategyIntent union type
 */
export type StrategyIntent = PlaceOrderIntent | CancelOrderIntent | NoopIntent;

/**
 * Type guard для PlaceOrderIntent
 *
 * @param intent - Intent для проверки
 * @returns true если intent это PlaceOrderIntent
 *
 * @example
 * ```typescript
 * if (isPlaceOrderIntent(intent)) {
 *   // intent: PlaceOrderIntent
 *   ctx.placeLimitOrder(intent.params);
 * }
 * ```
 */
export function isPlaceOrderIntent(intent: StrategyIntent): intent is PlaceOrderIntent {
  return intent.type === 'PlaceOrder';
}

/**
 * Type guard для CancelOrderIntent
 *
 * @param intent - Intent для проверки
 * @returns true если intent это CancelOrderIntent
 *
 * @example
 * ```typescript
 * if (isCancelOrderIntent(intent)) {
 *   // intent: CancelOrderIntent
 *   ctx.cancelOrder(intent.orderId);
 * }
 * ```
 */
export function isCancelOrderIntent(intent: StrategyIntent): intent is CancelOrderIntent {
  return intent.type === 'CancelOrder';
}

/**
 * Type guard для NoopIntent
 *
 * @param intent - Intent для проверки
 * @returns true если intent это NoopIntent
 *
 * @example
 * ```typescript
 * if (isNoopIntent(intent)) {
 *   // intent: NoopIntent
 *   // Do nothing
 * }
 * ```
 */
export function isNoopIntent(intent: StrategyIntent): intent is NoopIntent {
  return intent.type === 'Noop';
}
