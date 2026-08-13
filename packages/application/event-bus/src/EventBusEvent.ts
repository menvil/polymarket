/**
 * EventBusEvent — union контура доставки Application EventBus.
 *
 * @remarks
 * Это **union доставки, а не ownership-слоя**: Application EventBus фактически
 * переносит события двух разных semantic-контуров, и этот тип называет это
 * честно:
 *
 * - {@link ApplicationEvent} — события, которыми владеет Application-слой
 *   (canonical owner: `@polymarket/application-events`);
 * - {@link OrderEvent} — domain-события Order-агрегата
 *   (canonical owner: `@polymarket/order-events`).
 *
 * Принадлежность события слою определяется его canonical-пакетом, а не фактом
 * доставки через этот bus. Конкретные контракты импортируй из их owner-пакетов;
 * `EventBusEvent` нужен там, где код работает с «любым событием, допустимым в
 * контуре доставки» (сигнатуры `IEventBus`, generic-параметр движка).
 */
import type { ApplicationEvent } from '@polymarket/application-events';
import type { OrderEvent } from '@polymarket/order-events';

export type EventBusEvent =
  | ApplicationEvent
  | OrderEvent;
