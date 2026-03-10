/**
 * UserEventFeedAdapter — маршрутизация user-channel событий в FillEventHandler и OrderUpdateHandler.
 *
 * @remarks
 * Одна ответственность: user channel (fills + lifecycle ордеров).
 * Market channel (orderbook, trades) → MarketDataFeedAdapter.
 *
 * ### Поток данных:
 * ```
 * IPolymarketWsEmitter.onUserFill(dto)
 *   → _mapFillDto(dto)                    (WsUserFillDto → Record<string, unknown>)
 *   → FillEventHandler.handle(raw, accountId)
 *
 * IPolymarketWsEmitter.onOrderUpdate(dto)
 *   → _mapOrderUpdate(dto)                (WsOrderUpdateDto → VenueOrderUpdate | null)
 *   → OrderUpdateHandler.handle(update)
 *
 * IPolymarketWsEmitter.onReconnect()
 *   → логирование; TODO Phase 9: trigger reconciliation
 * ```
 *
 * ### Маппинг orderEventType → VenueOrderUpdate:
 * - 'PLACEMENT' → { type: 'ACCEPTED', orderId }
 * - 'CANCELLATION' → { type: 'CANCELLED', orderId, reason }
 * - Другие значения → null (игнорируем — не влияют на Order FSM)
 *
 * @example
 * ```typescript
 * const adapter = new UserEventFeedAdapter(wsEmitter, fillHandler, orderHandler, accountId, logger);
 * adapter.start();
 * // При завершении:
 * adapter.stop();
 * ```
 */
import type { ILogger } from '@polymarket/logger';
import type { AccountId } from '@polymarket/ids';
import { asOrderId } from '@polymarket/ids';
import type { FillEventHandler, OrderUpdateHandler, VenueOrderUpdate } from '@polymarket/handlers';
import type { IPolymarketWsEmitter } from '../ws/IPolymarketWsEmitter.js';
import type { WsOrderUpdateDto } from '../ws/dto/WsUserEventDto.js';

/**
 * Адаптер user-channel: мост между WS-эмиттером и application handlers.
 *
 * @remarks
 * Подписывается на user-channel события при `start()`.
 * Снимает все подписки при `stop()`.
 *
 * Для активации user channel перед вызовом `start()` необходимо вызвать:
 * `wsEmitter.subscribeUserChannel({ apiKey, secret, passphrase })`.
 */
export class UserEventFeedAdapter {
  private readonly _logger: ILogger;
  /** Список активных unsubscribe-функций */
  private readonly _unsubscribes: Array<() => void> = [];

  /**
   * @param _wsEmitter - WS-эмиттер raw событий Polymarket
   * @param _fillHandler - Application handler fill-событий
   * @param _orderHandler - Application handler lifecycle-событий ордера
   * @param _accountId - AccountId для передачи в FillEventHandler
   * @param logger - Logger
   */
  constructor(
    private readonly _wsEmitter: IPolymarketWsEmitter,
    private readonly _fillHandler: FillEventHandler,
    private readonly _orderHandler: OrderUpdateHandler,
    private readonly _accountId: AccountId,
    logger: ILogger,
  ) {
    this._logger = logger.child({ component: 'UserEventFeedAdapter' });
  }

  /**
   * Запускает маршрутизацию user-channel событий.
   *
   * @remarks
   * Идемпотентен: повторный вызов добавит дублирующие подписки —
   * вызывай `stop()` перед повторным `start()`.
   *
   * @example
   * ```typescript
   * adapter.start();
   * ```
   */
  public start(): void {
    // Fills из user-channel (исполнение наших ордеров)
    const unsubFill = this._wsEmitter.onUserFill(async (dto) => {
      this._logger.debug('Received user fill from WS', { id: dto.id, status: dto.status });
      // Явный маппинг WsUserFillDto → Record<string, unknown>
      // FillEventHandler принимает raw DTO в виде Record
      await this._fillHandler.handle(this._mapFillDto(dto), this._accountId);
    });

    // Обновления статуса ордеров из user-channel
    const unsubOrder = this._wsEmitter.onOrderUpdate(async (dto) => {
      const update = this._mapOrderUpdate(dto);
      if (update) {
        this._logger.debug('Received order update from WS', {
          orderId: String(update.orderId),
          type: update.type,
        });
        await this._orderHandler.handle(update);
      }
    });

    // Reconnect — логируем; Phase 9 добавит запуск reconciliation
    const unsubReconnect = this._wsEmitter.onReconnect(() => {
      this._logger.warn('User channel reconnected — fills during downtime may be missed');
      // TODO Phase 9: trigger OrderReconciler.reconcile(accountId)
    });

    this._unsubscribes.push(unsubFill, unsubOrder, unsubReconnect);
    this._logger.info('UserEventFeedAdapter started');
  }

  /**
   * Останавливает маршрутизацию: снимает все WS-подписки.
   *
   * @remarks
   * Идемпотентен: повторный вызов безопасен.
   */
  public stop(): void {
    for (const unsub of this._unsubscribes) {
      unsub();
    }
    this._unsubscribes.length = 0;
    this._logger.info('UserEventFeedAdapter stopped');
  }

  /**
   * Явный маппинг WsUserFillDto → Record<string, unknown>.
   *
   * @param dto - Raw fill DTO из user-channel
   * @returns Record для передачи в FillEventHandler.handle()
   *
   * @remarks
   * FillEventHandler ожидает raw Polymarket trade event как Record.
   * Используем явный маппинг вместо `as unknown as Record` для type safety.
   */
  private _mapFillDto(dto: {
    readonly id: string;
    readonly taker_order_id: string;
    readonly trader_side: 'BUY' | 'SELL';
    readonly price: string;
    readonly size: string;
    readonly fee_rate_bps: string;
    readonly status: string;
    readonly asset_id: string;
    readonly maker_orders: Array<{ readonly order_id: string; readonly matched_amount: string }>;
    readonly timestamp: string;
  }): Record<string, unknown> {
    return {
      id: dto.id,
      taker_order_id: dto.taker_order_id,
      trader_side: dto.trader_side,
      price: dto.price,
      size: dto.size,
      fee_rate_bps: dto.fee_rate_bps,
      status: dto.status,
      asset_id: dto.asset_id,
      maker_orders: dto.maker_orders,
      timestamp: dto.timestamp,
    };
  }

  /**
   * Маппинг WsOrderUpdateDto → VenueOrderUpdate или null.
   *
   * @param dto - Raw order update DTO из user-channel
   * @returns VenueOrderUpdate если поддерживаемый тип, null — если неизвестный (игнорируем)
   *
   * @remarks
   * Поддерживаемые orderEventType:
   * - 'PLACEMENT' → { type: 'ACCEPTED', orderId }
   * - 'CANCELLATION' → { type: 'CANCELLED', orderId, reason }
   *
   * Неизвестные типы (например, будущие extension от Polymarket) игнорируются
   * без ошибки — это осознанное решение для forward-compatibility.
   */
  private _mapOrderUpdate(dto: WsOrderUpdateDto): VenueOrderUpdate | null {
    const orderId = asOrderId(dto.order_id);
    if (!orderId) {
      this._logger.warn('Invalid order_id in WS order update, skipping', {
        order_id: dto.order_id,
        orderEventType: dto.orderEventType,
      });
      return null;
    }

    switch (dto.orderEventType) {
      case 'PLACEMENT':
        return { type: 'ACCEPTED', orderId };

      case 'CANCELLATION':
        return { type: 'CANCELLED', orderId, reason: dto.reason };

      default:
        this._logger.debug('Unknown orderEventType, ignoring', {
          orderEventType: dto.orderEventType,
          orderId: dto.order_id,
        });
        return null;
    }
  }
}
