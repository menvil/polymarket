/**
 * SimpleDumbStrategy - упрощенная версия DumbStrategy для backtesting
 *
 * @remarks
 * КРИТИЧНО: Используется для Parameter Sweep!
 *
 * Отличия от DumbStrategy v5.5:
 * - Использует ФИКСИРОВАННЫЕ цены из конфига (buyPrice, sellPrice)
 * - NO dynamic pricing (НЕ вычисляет bestBid * 0.98)
 * - NO repricing logic
 * - Простой FSM: IDLE → QUOTING → FILLED → QUOTING → ...
 *
 * Зачем:
 * - Parameter Sweep требует чтобы buyPrice/sellPrice влияли на результат
 * - DumbStrategy v5.5 игнорирует конфиг (dynamic pricing)
 * - SimpleDumbStrategy использует конфиг напрямую
 *
 * @example
 * ```typescript
 * const strategy = new SimpleDumbStrategy({
 *   id: 'simple-dumb',
 *   tokenId: '0xabc',
 *   initialSide: 'buy',
 *   buyPrice: 0.50,  // ✅ Используется напрямую!
 *   sellPrice: 0.52, // ✅ Используется напрямую!
 *   size: 100,
 * });
 *
 * // StrategyStarted → place buy order @ 0.50 (из конфига)
 * // OrderFilled → place sell order @ 0.52 (из конфига)
 * ```
 */

import type { IStrategy } from '../IStrategy.js';
import type { StrategyContext } from '../StrategyContext.js';
import type { StrategyEvent } from '../../events/StrategyEvent.js';
import type { StrategyIntent, PlaceOrderIntent } from '../StrategyIntent.js';
import type { DumbStrategyConfig } from './DumbStrategyConfig.js';
import type { ITelemetrySink } from '../../telemetry/ITelemetrySink.js';

type State = 'IDLE' | 'QUOTING' | 'FILLED';

interface SimpleDumbState {
  state: State;
  currentSide: 'buy' | 'sell';
  currentOrderId: string | null;
  lastFillPrice: number | null;
}

export class SimpleDumbStrategy implements IStrategy {
  public readonly id: string;
  private state: SimpleDumbState;

  constructor(
    private readonly config: DumbStrategyConfig,
    _telemetrySink?: ITelemetrySink
  ) {
    this.id = config.id;
    this.state = {
      state: 'IDLE',
      currentSide: config.initialSide,
      currentOrderId: null,
      lastFillPrice: null,
    };
  }

  /**
   * Lifecycle: Start
   *
   * @remarks
   * v3: onStart() НЕ генерирует intents (только инициализация).
   * Первый intent будет через LifecycleEvent: StrategyStarted.
   */
  onStart(_ctx: StrategyContext): StrategyIntent[] {
    // No initialization needed (state already initialized in constructor)
    return [];
  }

  /**
   * Lifecycle: Stop
   *
   * @remarks
   * Cleanup (если нужно).
   */
  onStop(): void {
    // No cleanup needed
  }

  onExecutionEvent(event: StrategyEvent, ctx: StrategyContext): StrategyIntent[] {
    switch (event.type) {
      case 'StrategyStarted':
        return this.onStrategyStarted(ctx);

      case 'OrderAccepted':
        // Обновляем currentOrderId на реальный ID
        this.state.currentOrderId = event.orderId;
        this.state.state = 'QUOTING';
        return [];

      // ✅ v7.7.15: OrderFilled УДАЛЁН - стратегия работает только по StrategyTick!
      // case 'OrderFilled': { ... }

      case 'OrderCancelled':
        if (this.state.currentOrderId && event.orderId === this.state.currentOrderId) {
          this.state.state = 'IDLE';
          this.state.currentOrderId = null;
        }
        return [];

      case 'StrategyTick':
        return [];

      default:
        return [];
    }
  }

  private onStrategyStarted(ctx: StrategyContext): StrategyIntent[] {
    // Разместить первый ордер
    return this.placeOrder(ctx);
  }

  // @ts-expect-error - method for future use
  private _onFilled(ctx: StrategyContext): StrategyIntent[] {
    // Переключить сторону
    this.state.currentSide = this.state.currentSide === 'buy' ? 'sell' : 'buy';

    // Разместить reverse order
    return this.placeOrder(ctx);
  }

  private placeOrder(_ctx: StrategyContext): StrategyIntent[] {
    // ✅ КРИТИЧНО: Используем цены из конфига напрямую!
    const price = this.state.currentSide === 'buy' ? this.config.buyPrice : this.config.sellPrice;

    const intent: PlaceOrderIntent = {
      type: 'PlaceOrder',
      strategyId: this.config.id,
      params: {
        tokenId: this.config.tokenId,
        side: this.state.currentSide,
        price,
        size: this.config.size,
        strategyId: this.config.id,
      },
    };

    // Обновляем state (optimistic update)
    this.state.state = 'QUOTING';
    this.state.currentOrderId = 'pending'; // Будет обновлён в OrderAccepted

    return [intent];
  }

  /**
   * @deprecated onTick больше не используется
   */
  onTick(_ctx: StrategyContext): StrategyIntent[] {
    return [];
  }
}
