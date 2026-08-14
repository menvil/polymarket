/**
 * OrderUpdateHandler — тонкий адаптер: WS order-channel → EventBus.
 *
 * @remarks
 * Получает `VenueOrderUpdate` из Polymarket WS order-channel и публикует
 * `ORDER_UPDATE_RECEIVED` в EventBus. Никакой доменной логики не содержит.
 *
 * ### Принцип тонкого обработчика:
 * - Парсинг WS DTO → `VenueOrderUpdate` (делает `UserEventFeedAdapter`)
 * - Публикация в EventBus (этот класс)
 * - Доменная обработка → `UpdateOrderStatusUseCase` через `OrderUpdateOrchestrator`
 *
 * @example
 * ```typescript
 * const handler = new OrderUpdateHandler(eventBus, metadataGenerator, clock, accountId, logger);
 *
 * wsEmitter.onOrderUpdate(async (dto) => {
 *   await handler.handle({ type: 'ACCEPTED', orderId: dto.orderId });
 * });
 * ```
 */
import type { ILogger } from '@polymarket/logger';
import type { AccountId } from '@polymarket/ids';
import type { IClock } from '@polymarket/time';
import type { VenueOrderUpdate } from '@polymarket/application-events';
import type { IEventBus } from '@polymarket/event-bus';
import type { MessageMetadataGenerator } from '@polymarket/messages';
import { TimestampService } from '@polymarket/value-objects';

export { type VenueOrderUpdate } from '@polymarket/application-events';

/**
 * Тонкий адаптер: принимает `VenueOrderUpdate`, публикует `ORDER_UPDATE_RECEIVED`.
 *
 * @remarks
 * Без доменной логики — см. докблок модуля выше.
 */
export class OrderUpdateHandler {
  /**
   * Создаёт тонкий OrderUpdateHandler.
   *
   * @param _eventBus - Event bus для публикации ORDER_UPDATE_RECEIVED
   * @param _metadataGenerator - Canonical-генератор metadata публикуемого события
   *   (root: первичная реакция на внешнее WS-наблюдение)
   * @param _clock - Источник времени для receivedAt timestamp
   * @param _accountId - ID аккаунта — нужен UpdateOrderStatusUseCase для portfolio ops
   * @param _logger - Logger
   */
  constructor(
    private readonly _eventBus: IEventBus,
    private readonly _metadataGenerator: MessageMetadataGenerator,
    private readonly _clock: IClock,
    private readonly _accountId: AccountId,
    private readonly _logger: ILogger,
  ) {}

  /**
   * Публикует ORDER_UPDATE_RECEIVED в EventBus.
   *
   * @param update - VenueOrderUpdate из Polymarket WS
   *
   * @remarks
   * Никогда не выбрасывает — ошибки публикации логируются.
   * Доменная обработка выполняется асинхронно в `OrderUpdateOrchestrator`.
   */
  public async handle(update: VenueOrderUpdate): Promise<void> {
    const receivedAtResult = TimestampService.create(this._clock.now().getTime());
    if (!receivedAtResult.ok) {
      this._logger.error('Failed to create timestamp for ORDER_UPDATE_RECEIVED', {
        orderId: String(update.orderId),
        updateType: update.type,
      });
      return;
    }

    const result = await this._eventBus.publish({
      type: 'ORDER_UPDATE_RECEIVED',
      payload: {
        update,
        accountId: this._accountId,
        receivedAt: receivedAtResult.value,
      },
      metadata: this._metadataGenerator.nextRoot(),
    });
    if (!result.ok) {
      this._logger.error('Failed to publish ORDER_UPDATE_RECEIVED', {
        orderId: String(update.orderId),
        updateType: update.type,
        error: result.error.message,
      });
    }
  }
}
