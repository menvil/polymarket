/**
 * UserEventsMapper - маппинг WebSocket user events в Domain events
 *
 * @remarks
 * Преобразует WebSocket user events (fills, order status changes) в domain события:
 * - OrderFilledEvent (когда ордер исполнен полностью или частично)
 * - OrderUpdatedEvent (когда изменился статус ордера)
 * - OrderCancelledEvent (когда ордер отменён)
 *
 * WebSocket User Events Format (Polymarket):
 * ```json
 * {
 *   "event_type": "order_update",
 *   "order": {
 *     "id": "0xabc...",
 *     "asset_id": "0x123...",
 *     "status": "FILLED",
 *     "side": "BUY",
 *     "price": "0.55",
 *     "size": "100",
 *     "filled_size": "100",
 *     "timestamp": 1234567890
 *   }
 * }
 * ```
 *
 * @example
 * ```typescript
 * const event = UserEventsMapper.fromWebSocketMessage(wsMessage);
 * if (event) {
 *   eventBus.publish(event);
 * }
 * ```
 */

import { Order } from '../../../domain/entities/Order.js';
import { Quantity } from '../../../domain/value-objects/Quantity.js';
import { Price } from '../../../domain/value-objects/Price.js';
import { OrderFilledEvent } from '../../../domain/events/OrderFilledEvent.js';
import { OrderUpdatedEvent } from '../../../domain/events/OrderUpdatedEvent.js';
import { OrderCancelledEvent } from '../../../domain/events/OrderCancelledEvent.js';
import type { DomainEvent } from '../../../domain/events/DomainEvent.js';

/**
 * WebSocket User Event (raw format from Polymarket)
 */
interface UserEventMessage {
  event_type: string;
  order?: {
    id: string;
    asset_id: string;
    status: string;
    side: string;
    price: string;
    size: string;
    filled_size?: string;
    avg_fill_price?: string;
    timestamp?: number;
  };
  reason?: string;
}

/**
 * UserEventsMapper class
 *
 * @remarks
 * Статический класс для маппинга WebSocket user events в domain события.
 */
export class UserEventsMapper {
  /**
   * Преобразует WebSocket user event message в Domain event
   *
   * @param message - WebSocket message (может быть string или object)
   * @returns Domain event или null если message invalid/unsupported
   *
   * @remarks
   * Алгоритм:
   * 1. Парсим JSON если message это string
   * 2. Проверяем event_type
   * 3. Создаём Order entity из order данных
   * 4. Определяем тип события по status и filled_size:
   *    - status === 'FILLED' → OrderFilledEvent
   *    - status === 'CANCELLED' → OrderCancelledEvent
   *    - иначе → OrderUpdatedEvent
   * 5. Возвращаем соответствующий domain event
   *
   * @example
   * ```typescript
   * const event = UserEventsMapper.fromWebSocketMessage(rawMessage);
   * if (event) {
   *   console.log(`Event: ${event.eventName}`);
   * }
   * ```
   */
  public static fromWebSocketMessage(message: string | unknown): DomainEvent | null {
    try {
      // Step 1: Parse JSON if string
      const parsed = typeof message === 'string' ? JSON.parse(message) : message;

      // Step 2: Validate event_type
      if (!parsed || typeof parsed !== 'object' || !('event_type' in parsed)) {
        return null;
      }

      const eventType = (parsed as UserEventMessage).event_type;

      // Support various event types
      if (eventType !== 'order_update' && eventType !== 'order' && eventType !== 'fill') {
        return null;
      }

      // Step 3: Extract order data
      const orderData = (parsed as UserEventMessage).order;
      if (!orderData) {
        return null;
      }

      // Validate required fields
      if (
        !orderData.id ||
        !orderData.asset_id ||
        !orderData.status ||
        !orderData.side ||
        !orderData.price ||
        !orderData.size
      ) {
        return null;
      }

      // Parse numeric values
      const price = parseFloat(orderData.price);
      const size = parseFloat(orderData.size);
      const filledSize = orderData.filled_size ? parseFloat(orderData.filled_size) : 0;
      const avgFillPrice = orderData.avg_fill_price ? parseFloat(orderData.avg_fill_price) : price;

      if (isNaN(price) || isNaN(size)) {
        return null;
      }

      // Map status (API → Domain)
      const statusMap: Record<string, Order['status']> = {
        PENDING: 'PENDING',
        OPEN: 'OPEN',
        LIVE: 'OPEN', // Polymarket uses "LIVE" for open orders
        FILLED: 'FILLED',
        CANCELLED: 'CANCELED',
        CANCELED: 'CANCELED', // Handle both spellings
        PARTIALLY_FILLED: 'OPEN', // Map to OPEN with filledSize > 0
      };

      const status = statusMap[orderData.status.toUpperCase()] || 'PENDING';

      // Step 4: Create Order entity
      const order = Order.create({
        id: orderData.id,
        tokenId: orderData.asset_id,
        side: orderData.side.toUpperCase() as 'BUY' | 'SELL',
        price: Price.fromNumber(price),
        size: Quantity.fromNumber(size),
        status,
        timestamp: orderData.timestamp ? new Date(orderData.timestamp * 1000) : new Date(),
        filledSize: filledSize > 0 ? Quantity.fromNumber(filledSize) : undefined,
        averageFillPrice: filledSize > 0 ? Price.fromNumber(avgFillPrice) : undefined,
      });

      // Step 5: Determine event type and create domain event
      // Case 1: Order filled (full or partial)
      if (filledSize > 0 && status === 'FILLED') {
        return new OrderFilledEvent(
          order,
          Quantity.fromNumber(filledSize),
          Price.fromNumber(avgFillPrice),
          order.timestamp
        );
      }

      // Case 2: Order cancelled
      if (status === 'CANCELED') {
        const reason = (parsed as UserEventMessage).reason || 'Order cancelled';
        return new OrderCancelledEvent(order.id, reason, order.timestamp);
      }

      // Case 3: Order status updated (any other status change)
      return new OrderUpdatedEvent(order, undefined, order.timestamp);
    } catch (error) {
      // Invalid JSON or parsing error
      return null;
    }
  }

  /**
   * Проверяет, является ли message user event
   *
   * @param message - WebSocket message
   * @returns true если это user event
   *
   * @remarks
   * Быстрая проверка без полного парсинга.
   * Используется для фильтрации messages перед маппингом.
   */
  public static isUserEvent(message: string | unknown): boolean {
    try {
      const parsed = typeof message === 'string' ? JSON.parse(message) : message;

      if (!parsed || typeof parsed !== 'object') {
        return false;
      }

      const eventType = (parsed as { event_type?: string }).event_type;
      return eventType === 'order_update' || eventType === 'order' || eventType === 'fill';
    } catch {
      return false;
    }
  }
}
