/**
 * OrderbookProjector - Projector для OrderBookSnapshotReceivedEvent
 *
 * @remarks
 * Чистый state-applier для orderbook событий.
 *
 * ## Ответственность:
 *
 * ✅ Применяет OrderBookSnapshotReceivedEvent к Aggregate
 * ✅ Возвращает Orderbook entity при успехе
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
 * const projector = new OrderbookProjector();
 * const aggregate = MarketDataSubscriptionAggregate.create('asset-123');
 *
 * const event = new OrderBookSnapshotReceivedEvent(
 *   'asset-123',
 *   [{ price: 0.52, size: 100 }],
 *   [{ price: 0.53, size: 150 }]
 * );
 *
 * const result = projector.apply(event, aggregate);
 *
 * if (result.success) {
 *   console.log('Orderbook:', result.entity);
 * } else {
 *   console.error('Error:', result.error);
 * }
 * ```
 */

import type { IProjector, ProjectionResult } from './IProjector.js';
import { OrderBookSnapshotReceivedEvent } from '../../domain/events/OrderBookSnapshotReceivedEvent.js';
import type { MarketDataSubscriptionAggregate } from '../../domain/aggregates/MarketDataSubscriptionAggregate.js';
import type { Orderbook } from '../../domain/entities/Orderbook.js';

/**
 * OrderbookProjector
 *
 * @remarks
 * Stateless projector для применения orderbook событий.
 * Делегирует всю логику в Aggregate, сам только адаптирует интерфейс.
 */
export class OrderbookProjector
  implements
    IProjector<
      OrderBookSnapshotReceivedEvent,
      MarketDataSubscriptionAggregate,
      Orderbook
    >
{
  /**
   * Применяет OrderBookSnapshotReceivedEvent к Aggregate
   *
   * @param event - OrderBookSnapshotReceivedEvent
   * @param state - MarketDataSubscriptionAggregate
   * @returns ProjectionResult с Orderbook или ошибкой
   *
   * @remarks
   * Алгоритм:
   * 1. Вызвать aggregate.apply(event)
   * 2. Если applied = true → вернуть { success: true, entity: orderbook }
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
   * const event = new OrderBookSnapshotReceivedEvent(
   *   'asset-123',
   *   [{ price: 0.52, size: 100 }],
   *   [{ price: 0.53, size: 150 }],
   *   new Date('2025-01-05T12:00:00Z')
   * );
   *
   * const aggregate = MarketDataSubscriptionAggregate.create('asset-123');
   * const result = projector.apply(event, aggregate);
   *
   * // Успех: result = { success: true, entity: Orderbook { ... } }
   * // Ошибка (time regression): result = { success: false, error: '...', invariant: 'no_time_regression' }
   * ```
   */
  public apply(
    event: OrderBookSnapshotReceivedEvent,
    state: MarketDataSubscriptionAggregate
  ): ProjectionResult<Orderbook> {
    // Делегируем применение в Aggregate
    const applyResult = state.apply(event);

    // Адаптируем ApplyResult → ProjectionResult
    if (applyResult.applied) {
      // Успех: извлекаем entity из aggregate
      const orderbook = state.getOrderbook();

      if (!orderbook) {
        // Это programming error - aggregate должен был создать orderbook
        return {
          success: false,
          error: 'Aggregate did not create orderbook after successful apply',
        };
      }

      return {
        success: true,
        entity: orderbook,
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
