/**
 * Объединение всех domain-событий Order — используется в `Order.fromEvents()`
 * (replay) и event-логе.
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
