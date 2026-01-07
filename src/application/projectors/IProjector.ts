/**
 * IProjector - Базовый интерфейс для всех Projector'ов
 *
 * @remarks
 * Projector - это **чистый state-applier**, который применяет одно событие к состоянию.
 *
 * ## Жёсткие запреты:
 *
 * ❌ **Никакой бизнес-логики** - только прямое применение факта из event в state
 * ❌ **Никаких if/else по market conditions** - нет условных решений
 * ❌ **Никаких таймеров** - нет зависимости от времени
 * ❌ **Никаких side effects** - не публикует события, не логирует, не вызывает callbacks
 * ❌ **Никаких async операций** - только синхронное применение
 * ❌ **Не подписывается на EventBus** - вызывается извне
 * ❌ **Не хранит state** - получает state как аргумент
 *
 * ## Что разрешено:
 *
 * ✅ Применить факт из события к состоянию
 * ✅ Проверить eventId для идемпотентности
 * ✅ Вернуть Result с успехом или ошибкой
 * ✅ Быть детерминированным и replay-ready
 *
 * ## Контракт метода apply():
 *
 * - **Синхронный** - никогда не async
 * - **Детерминированный** - одинаковый (event, state) → одинаковый результат
 * - **Идемпотентный** - повторный вызов с тем же event не меняет результат
 * - **Без side effects** - не модифицирует внешнее состояние
 * - **Возвращает Result** - либо успех с entity, либо ошибку
 *
 * @template E - Тип domain события
 * @template S - Тип состояния (Aggregate)
 * @template R - Тип результата (Entity)
 *
 * @example
 * ```typescript
 * class OrderbookProjector implements IProjector<
 *   OrderBookSnapshotReceivedEvent,
 *   MarketDataSubscriptionAggregate,
 *   Orderbook
 * > {
 *   apply(event, state) {
 *     // Проверка идемпотентности
 *     if (state.hasApplied(event.eventId)) {
 *       return { success: true, entity: state.getOrderbook()! };
 *     }
 *
 *     // Прямое применение факта
 *     const orderbook = new Orderbook(event.assetId, event.bids, event.asks, event.timestamp);
 *     state.applyOrderbook(orderbook, event.eventId);
 *
 *     return { success: true, entity: orderbook };
 *   }
 * }
 * ```
 */

import type { DomainEvent } from '../../domain/events/DomainEvent.js';

/**
 * Результат применения события
 *
 * @template R - Тип entity (результат успешного применения)
 *
 * @remarks
 * Success: { success: true, entity: R }
 * Failure: { success: false, error: string, invariant?: string }
 */
export type ProjectionResult<R> =
  | {
      success: true;
      entity: R;
    }
  | {
      success: false;
      error: string;
      invariant?: string;
    };

/**
 * IProjector - Интерфейс чистого state-applier'а
 *
 * @template E - Domain Event тип
 * @template S - State тип (обычно Aggregate)
 * @template R - Result тип (обычно Entity)
 *
 * @remarks
 * Projector применяет событие к состоянию и возвращает результат.
 * Он НЕ владеет state, НЕ подписывается на EventBus, НЕ делает side effects.
 */
export interface IProjector<E extends DomainEvent, S, R> {
  /**
   * Применяет событие к состоянию
   *
   * @param event - Domain событие
   * @param state - Состояние (Aggregate)
   * @returns Результат применения (успех с entity или ошибка)
   *
   * @remarks
   * Метод ДОЛЖЕН:
   * - Быть синхронным
   * - Быть детерминированным
   * - Быть идемпотентным (проверять eventId)
   * - Не модифицировать внешнее состояние (кроме переданного state)
   * - Не бросать exceptions (возвращать Result)
   * - Не делать side effects (не логировать, не публиковать события)
   *
   * Метод НЕ ДОЛЖЕН:
   * - Содержать бизнес-логику (условные решения)
   * - Зависеть от времени (таймеры, Date.now())
   * - Делать async операции
   * - Подписываться на события
   * - Вызывать callbacks
   *
   * @example
   * ```typescript
   * const result = projector.apply(event, aggregate);
   *
   * if (result.success) {
   *   console.log('Entity:', result.entity);
   * } else {
   *   console.error('Error:', result.error);
   * }
   * ```
   */
  apply(event: E, state: S): ProjectionResult<R>;
}
