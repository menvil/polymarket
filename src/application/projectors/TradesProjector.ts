/**
 * TradesProjector - Projector для TradeExecutedEvent
 *
 * @remarks
 * Чистый state-applier для trade событий.
 *
 * ## Ответственность:
 *
 * ✅ Применяет TradeExecutedEvent к Aggregate
 * ✅ Возвращает Trade entity при успехе
 * ✅ Возвращает ошибку при нарушении инвариантов
 *
 * ## Что НЕ делает:
 *
 * ❌ Не владеет state (получает Aggregate извне)
 * ❌ Не подписывается на EventBus
 * ❌ Не вызывает callbacks
 * ❌ Не публикует события
 * ❌ Не содержит бизнес-логику (только делегирует в Aggregate)
 *
 * ## Детерминированность:
 *
 * - Одинаковый (event, state) → одинаковый результат
 * - Replay-safe
 * - Идемпотентный (с поддержкой eventId в будущем)
 *
 * @example
 * ```typescript
 * const projector = new TradesProjector();
 * const aggregate = MarketDataSubscriptionAggregate.create('asset-123');
 *
 * const event = new TradeExecutedEvent(
 *   'asset-123',
 *   0.52,
 *   100,
 *   'BUY',
 *   new Date('2025-01-05T12:00:00Z')
 * );
 *
 * const result = projector.apply(event, aggregate);
 *
 * if (result.success) {
 *   console.log('Trade:', result.entity);
 * } else {
 *   console.error('Error:', result.error);
 * }
 * ```
 */

import type { IProjector, ProjectionResult } from './IProjector.js';
import { TradeExecutedEvent } from '../../domain/events/TradeExecutedEvent.js';
import type { MarketDataSubscriptionAggregate } from '../../domain/aggregates/MarketDataSubscriptionAggregate.js';
import type { Trade } from '../../domain/entities/Trade.js';

/**
 * TradesProjector
 *
 * @remarks
 * Stateless projector для применения trade событий.
 * Делегирует всю логику в Aggregate, сам только адаптирует интерфейс.
 */
export class TradesProjector
  implements
    IProjector<TradeExecutedEvent, MarketDataSubscriptionAggregate, Trade>
{
  /**
   * Применяет TradeExecutedEvent к Aggregate
   *
   * @param event - TradeExecutedEvent
   * @param state - MarketDataSubscriptionAggregate
   * @returns ProjectionResult с Trade или ошибкой
   *
   * @remarks
   * Алгоритм:
   * 1. Вызвать aggregate.apply(event)
   * 2. Если applied = true → вернуть { success: true, entity: trade }
   * 3. Если applied = false → вернуть { success: false, error, invariant }
   *
   * Детерминированность:
   * - НЕ зависит от времени (Date.now())
   * - НЕ делает side effects
   * - НЕ читает внешнее состояние
   * - Результат зависит ТОЛЬКО от (event, state)
   *
   * @example
   * ```typescript
   * const event = new TradeExecutedEvent(
   *   'asset-123',
   *   0.52,
   *   100,
   *   'BUY',
   *   new Date('2025-01-05T12:00:00Z')
   * );
   *
   * const aggregate = MarketDataSubscriptionAggregate.create('asset-123');
   * const result = projector.apply(event, aggregate);
   *
   * // Успех: result = { success: true, entity: Trade { ... } }
   * // Ошибка (time regression): result = { success: false, error: '...', invariant: 'no_time_regression' }
   * ```
   */
  public apply(
    event: TradeExecutedEvent,
    state: MarketDataSubscriptionAggregate
  ): ProjectionResult<Trade> {
    // Делегируем применение в Aggregate
    const applyResult = state.apply(event);

    // Адаптируем ApplyResult → ProjectionResult
    if (applyResult.applied) {
      // Успех: извлекаем entity из aggregate
      const trade = state.getLastTrade();

      if (!trade) {
        // Это programming error - aggregate должен был создать trade
        return {
          success: false,
          error: 'Aggregate did not create trade after successful apply',
        };
      }

      return {
        success: true,
        entity: trade,
      };
    } else {
      // Ошибка: нарушен инвариант
      return {
        success: false,
        error: applyResult.error ?? 'Unknown error',
        invariant: applyResult.invariant,
      };
    }
  }
}
