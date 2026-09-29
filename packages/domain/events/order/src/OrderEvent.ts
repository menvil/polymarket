/**
 * Объединение всех domain-событий Order.
 *
 * @remarks
 * Legacy-контракт: `Order` эти события больше не создаёт и не воспроизводит;
 * в активном дереве union используется только как член `EventBusEvent`
 * (`@polymarket/event-bus`). См. README пакета.
 */
import type { OrderCreatedEvent } from './OrderCreatedEvent.js';
import type { OrderAcceptedEvent } from './OrderAcceptedEvent.js';
import type { OrderRejectedEvent } from './OrderRejectedEvent.js';
import type { OrderCancelledEvent } from './OrderCancelledEvent.js';
import type { OrderExpiredEvent } from './OrderExpiredEvent.js';
import type { OrderPartiallyFilledEvent } from './OrderPartiallyFilledEvent.js';
import type { OrderFilledEvent } from './OrderFilledEvent.js';

export type OrderEvent =
  | OrderCreatedEvent
  | OrderAcceptedEvent
  | OrderRejectedEvent
  | OrderCancelledEvent
  | OrderExpiredEvent
  | OrderPartiallyFilledEvent
  | OrderFilledEvent;
