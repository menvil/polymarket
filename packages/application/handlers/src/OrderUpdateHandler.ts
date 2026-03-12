/**
 * OrderUpdateHandler — применяет venue-обновления статуса ордера к Order entity.
 *
 * @remarks
 * Получает VenueOrderUpdate из Polymarket WS order-channel,
 * вызывает соответствующий метод Order (accept/reject/cancel/expire),
 * сохраняет обновлённый ордер в IOrderRepository,
 * публикует OrderEvent[] (из pullEvents()) в EventBus.
 *
 * ### Ответственность:
 * - НЕ создаёт новые ордера — только обновляет статус существующих
 * - НЕ обрабатывает fills — это задача FillEventHandler
 * - Stateless — никакого внутреннего состояния
 *
 * @example
 * ```typescript
 * const handler = new OrderUpdateHandler(orderRepository, eventBus, logger);
 *
 * wsEmitter.onOrderUpdate(async (dto) => {
 *   await handler.handle({ type: 'ACCEPTED', orderId: dto.orderId });
 * });
 * ```
 */
import type { ILogger } from '@polymarket/logger';
import type { OrderId } from '@polymarket/ids';
import type { IOrderRepository } from '@polymarket/ports';
import type { IEventBus, ApplicationEvent } from '@polymarket/event-bus';

/**
 * Venue-обновление статуса ордера (из Polymarket WS order-channel).
 *
 * @remarks
 * Discriminated union — тип обновления определяет доступные поля.
 * ACCEPTED — ордер принят биржей и активен на стакане.
 * REJECTED — ордер отклонён (невалидная цена, превышение лимита и т.д.).
 * CANCELLED — ордер отменён (пользователем или биржей).
 * EXPIRED — ордер истёк по TTL.
 */
export type VenueOrderUpdate =
  | { readonly type: 'ACCEPTED'; readonly orderId: OrderId }
  | { readonly type: 'REJECTED'; readonly orderId: OrderId; readonly reason: string }
  | { readonly type: 'CANCELLED'; readonly orderId: OrderId; readonly reason?: string }
  | { readonly type: 'EXPIRED'; readonly orderId: OrderId };

export class OrderUpdateHandler {
  /**
   * Создаёт OrderUpdateHandler.
   *
   * @param _orders - Репозиторий ордеров для get/save
   * @param _eventBus - Event bus для публикации OrderEvent[]
   * @param _logger - Logger
   */
  constructor(
    private readonly _orders: IOrderRepository,
    private readonly _eventBus: IEventBus,
    private readonly _logger: ILogger,
  ) {}

  /**
   * Применяет venue-обновление статуса к существующему ордеру.
   *
   * @param update - VenueOrderUpdate из Polymarket WS
   *
   * @remarks
   * Если ордер не найден в репозитории — логирует warn и возвращает.
   * Если Order.accept/reject/cancel/expire вернул error — логирует error и возвращает.
   * При успехе: сохраняет обновлённый ордер, публикует OrderEvent[] из pullEvents().
   */
  public async handle(update: VenueOrderUpdate): Promise<void> {
    const order = await this._orders.get(update.orderId);
    if (!order) {
      this._logger.warn('Order not found for venue update', {
        orderId: String(update.orderId),
        updateType: update.type,
      });
      return;
    }

    let result;
    switch (update.type) {
      case 'ACCEPTED':
        result = order.accept();
        break;
      case 'REJECTED':
        result = order.reject(update.reason);
        break;
      case 'CANCELLED':
        result = order.cancel(update.reason);
        break;
      case 'EXPIRED':
        result = order.expire();
        break;
    }

    if (!result.ok) {
      // Дублирующее WS-событие (ACCEPTED на уже OPEN ордере и т.п.) — idempotent, debug уровень.
      // Реальная ошибка (ACCEPTED на CANCELLED/FILLED) — error уровень.
      const isIdempotent =
        (update.type === 'ACCEPTED' && order.status === 'OPEN') ||
        (update.type === 'CANCELLED' && order.status === 'CANCELED') ||
        (update.type === 'EXPIRED' && order.status === 'EXPIRED');

      if (isIdempotent) {
        this._logger.debug('Ignoring duplicate venue update (already in target state)', {
          orderId: String(update.orderId),
          updateType: update.type,
          currentStatus: order.status,
        });
      } else {
        this._logger.error('Failed to apply order update', {
          error: result.error.message,
          orderId: String(update.orderId),
          updateType: update.type,
        });
      }
      return;
    }

    const updatedOrder = result.value;
    try {
      await this._orders.save(updatedOrder);
    } catch (err) {
      this._logger.error('Failed to save order after venue update', {
        orderId: String(update.orderId),
        updateType: update.type,
        err: err instanceof Error ? err : new Error(String(err)),
      });
      return;
    }

    const events = updatedOrder.pullEvents();
    if (events.length > 0) {
      try {
        await this._eventBus.publishAll(events as readonly ApplicationEvent[]);
      } catch (err) {
        this._logger.error('Failed to publish order events', {
          orderId: String(update.orderId),
          updateType: update.type,
          err: err instanceof Error ? err : new Error(String(err)),
        });
        return;
      }
    }

    this._logger.info('Order update applied', {
      orderId: String(update.orderId),
      updateType: update.type,
    });
  }
}
