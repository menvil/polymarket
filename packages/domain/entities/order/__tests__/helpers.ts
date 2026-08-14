/**
 * Общие вспомогательные функции для тестов пакета @polymarket/order
 */

import { MessageMetadataGenerator } from '@polymarket/messages';
import type { MessageMetadata } from '@polymarket/messages';
import { unsafeRunId } from '@polymarket/ids';
import { Order } from '../src/Order.js';
import type { OrderEvent } from '@polymarket/order-events';

/**
 * Детерминированный canonical-генератор metadata тестовых событий (M-003).
 *
 * @remarks
 * Замороженный clock + фиксированный runId: тесты не зависят от реального
 * времени, а materialization canonical envelope идёт через настоящий генератор.
 */
export const TEST_METADATA_GENERATOR = new MessageMetadataGenerator({
  clock: { now: () => new Date('2024-01-01T00:00:00.000Z') },
  runId: unsafeRunId('testrun1'),
});

/**
 * Возвращает следующую детерминированную metadata для тестового события.
 *
 * @returns Root-metadata от общего тестового генератора
 *
 * @example
 * ```typescript
 * const event = { type: 'ORDER_ACCEPTED', payload: { orderId }, metadata: nextTestMetadata() };
 * ```
 */
export function nextTestMetadata(): MessageMetadata {
  return TEST_METADATA_GENERATOR.nextRoot();
}

/**
 * Извлекает события ордера с тестовой metadata (root).
 *
 * @param order - Order, чей outbox нужно опустошить
 * @returns Canonical OrderEvent[] с metadata тестового генератора
 *
 * @remarks
 * Обёртка над `order.pullEvents(...)` для тестов: metadata поставляет общий
 * детерминированный генератор — сигнатура тестов остаётся короткой.
 *
 * @example
 * ```typescript
 * const events = pullTestEvents(order); // [OrderCreatedEvent]
 * ```
 */
export function pullTestEvents(order: Order): readonly OrderEvent[] {
  return order.pullEvents(nextTestMetadata);
}

/**
 * Разворачивает результат Order.fromEvents() или бросает ошибку
 *
 * @param events - Список доменных событий для воспроизведения заявки
 * @returns Order при успехе
 * @throws {TradingError} Если Order.fromEvents() вернул Err
 *
 * @remarks
 * Используется в unit и интеграционных тестах вместо ручного unwrap в каждом describe.
 * Единственное определение — дублирование устранено.
 *
 * @example
 * ```typescript
 * import { replay } from '../helpers.js';
 * const order = replay([createdEvent, acceptedEvent]);
 * expect(order.status).toBe('OPEN');
 * ```
 */
export function replay(events: readonly OrderEvent[]): Order {
  const result = Order.fromEvents(events);
  if (!result.ok) throw result.error;
  return result.value;
}
