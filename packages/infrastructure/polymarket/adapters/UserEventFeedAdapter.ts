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
 *   → логирование + вызов onReconnect() callback (Phase 9: OrderReconciler.reconcile)
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
import type { AccountId, OrderId } from '@polymarket/ids';
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
 *
 * Опциональный `onReconnect` callback вызывается при каждом WS reconnect —
 * используется для запуска OrderReconciler.reconcile() (Phase 9).
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
   * @param _onReconnect - Опциональный callback при WS reconnect (Phase 9: OrderReconciler)
   * @param _makerAddress - ETH-адрес нашего кошелька (maker_address в ордерах Polymarket).
   *   Используется как fallback для поиска нашего maker_order в cross-outcome fills,
   *   где top-level `owner` = UUID тейкера, а не наш UUID.
   * @param _onMatchedOnExchange - Опциональный callback при WS status=MATCHED для ордера.
   *   Позволяет пометить ордер как "matched on exchange" чтобы CancelOrderUseCase
   *   пропустил его отмену — MATCHED ордер уже исполнен, отмена невозможна.
   */
  constructor(
    private readonly _wsEmitter: IPolymarketWsEmitter,
    private readonly _fillHandler: FillEventHandler,
    private readonly _orderHandler: OrderUpdateHandler,
    private readonly _accountId: AccountId,
    logger: ILogger,
    private readonly _onReconnect?: () => Promise<void>,
    private readonly _makerAddress?: string,
    private readonly _onMatchedOnExchange?: (orderId: OrderId) => void,
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
      this._logger.info('[USER-EVENT] fill received', {
        id: dto.id,
        taker_order_id: dto.taker_order_id,
        trader_side: dto.trader_side,
        market: dto.market,
        asset_id: dto.asset_id,
        price: dto.price,
        size: dto.size,
        fee_rate_bps: dto.fee_rate_bps,
        status: dto.status,
        maker_orders: dto.maker_orders,
        timestamp: dto.timestamp,
      });

      // Fill в пути (MATCHED/MINED/CONFIRMED) → помечаем orderId как MATCHED.
      // Это блокирует CancelOrderUseCase от отмены ордера с in-flight fill.
      //
      // Без этого TAKER cross-outcome MINT fills вызывают phantom position:
      // 1. Fill MINED приходит раньше WS order MATCHED event
      // 2. Стратегия отменяет ордер (isMatchedOnExchange = false)
      // 3. Cancel успешен на CLOB, но on-chain MINT завершается
      // 4. Токены в portfolio но не на CLOB balance → SELL невозможен навсегда
      if (dto.status !== 'FAILED' && this._onMatchedOnExchange) {
        this._markOrderFromFill(dto);
      }

      // Явный маппинг WsUserFillDto → Record<string, unknown>
      // FillEventHandler принимает raw DTO в виде Record
      await this._fillHandler.handle(this._mapFillDto(dto), this._accountId);
    });

    // Обновления статуса ордеров из user-channel
    const unsubOrder = this._wsEmitter.onOrderUpdate(async (dto) => {
      this._logger.info('[USER-EVENT] order update received', {
        orderEventType: dto.orderEventType,
        order_id: dto.order_id,
        status: dto.status,
        reason: dto.reason,
        timestamp: dto.timestamp,
      });

      // Когда Polymarket сообщает status=MATCHED — ордер исполнен на бирже,
      // отмена невозможна. Помечаем ордер, чтобы CancelOrderUseCase пропустил его.
      // Это устраняет race condition: partial fill → стратегия отменяет →
      // оставшийся fill на "отменённый" ордер → portfolio desync.
      if (dto.orderEventType === 'UPDATE' && dto.status === 'MATCHED' && this._onMatchedOnExchange) {
        const orderId = asOrderId(dto.order_id);
        if (orderId) {
          this._logger.debug('[USER-EVENT] order MATCHED on exchange — marking non-cancellable', {
            order_id: dto.order_id,
          });
          this._onMatchedOnExchange(orderId);
        }
      }

      const update = this._mapOrderUpdate(dto);
      if (update) {
        await this._orderHandler.handle(update);
      } else {
        this._logger.debug('[USER-EVENT] order update ignored (unmapped type)', {
          orderEventType: dto.orderEventType,
          order_id: dto.order_id,
        });
      }
    });

    // Reconnect — логируем + запускаем reconciliation (Phase 9)
    const unsubReconnect = this._wsEmitter.onReconnect(() => {
      this._logger.warn('User channel reconnected — fills during downtime may be missed');
      if (this._onReconnect) {
        this._onReconnect().catch((err: unknown) => {
          this._logger.error('Reconciliation failed after reconnect', { error: String(err) });
        });
      }
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
    readonly trader_side: 'TAKER' | 'MAKER';
    readonly price: string;
    readonly size: string;
    readonly fee_rate_bps: string;
    readonly status: string;
    readonly asset_id: string;
    readonly owner?: string;
    readonly market?: string;
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
      owner: dto.owner,
      maker_address: this._makerAddress,
      market: dto.market,
      maker_orders: dto.maker_orders,
      timestamp: dto.timestamp,
    };
  }

  /**
   * Помечает orderId из fill-события как MATCHED на бирже.
   *
   * @param dto - Raw fill DTO из user-channel
   *
   * @remarks
   * Определяет наш orderId по trader_side:
   * - TAKER → наш ордер = taker_order_id
   * - MAKER → наши ордера = maker_orders[].order_id
   *
   * Вызывается при любом fill-статусе кроме FAILED.
   * Идемпотентен (Set.add — повторные вызовы безопасны).
   */
  private _markOrderFromFill(dto: {
    readonly taker_order_id: string;
    readonly trader_side: 'TAKER' | 'MAKER';
    readonly maker_orders: ReadonlyArray<{ readonly order_id: string }>;
  }): void {
    if (dto.trader_side === 'TAKER') {
      const orderId = asOrderId(dto.taker_order_id);
      if (orderId) {
        this._logger.debug('[USER-EVENT] fill received — marking order as MATCHED (taker)', {
          order_id: dto.taker_order_id,
        });
        this._onMatchedOnExchange!(orderId);
      }
    } else {
      // MAKER: все maker_orders в этом fill — наши ордера
      for (const mo of dto.maker_orders) {
        const orderId = asOrderId(mo.order_id);
        if (orderId) {
          this._logger.debug('[USER-EVENT] fill received — marking order as MATCHED (maker)', {
            order_id: mo.order_id,
          });
          this._onMatchedOnExchange!(orderId);
        }
      }
    }
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
