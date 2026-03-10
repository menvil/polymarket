/**
 * Общие вспомогательные функции для тестов пакета @polymarket/order
 */

import { Order } from '../src/Order.js';
import type { OrderEvent } from '../src/OrderEvents.js';

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
