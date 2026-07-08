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
import type { AccountId, OrderId, InstrumentId, FillId } from '@polymarket/ids';
import { asOrderId, asInstrumentId, asFillId } from '@polymarket/ids';
import { pendingMatchFillId } from '@polymarket/ports';
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
   *   Позволяет пометить конкретный fill ордера как "matched on exchange" чтобы
   *   CancelOrderUseCase пропустил его отмену — MATCHED ордер уже исполнен, отмена
   *   невозможна. Второй параметр — fillId (из fill-события, либо `pendingMatchFillId`
   *   когда конкретный fillId неизвестен на этом уровне — order-update MATCHED без
   *   привязанного fill-события).
   * @param _onInFlightFill - Опциональный callback при WS status=MATCHED для fill-события.
   *   Помечает instrument как имеющий in-flight fill, идентифицируя запись по fillId
   *   (третий параметр — orderId, к которому относится fill).
   */
  constructor(
    private readonly _wsEmitter: IPolymarketWsEmitter,
    private readonly _fillHandler: FillEventHandler,
    private readonly _orderHandler: OrderUpdateHandler,
    private readonly _accountId: AccountId,
    logger: ILogger,
    private readonly _onReconnect?: () => Promise<void>,
    private readonly _makerAddress?: string,
    private readonly _onMatchedOnExchange?: (orderId: OrderId, fillId: FillId) => void,
    private readonly _onInFlightFill?: (instrumentId: InstrumentId, fillId: FillId, orderId: OrderId) => void,
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
        fee_rate_bps: dto.fee_rate_bps ?? '0',
        status: dto.status,
        bucket_index: dto.bucket_index,
        maker_orders: dto.maker_orders,
        timestamp: dto.timestamp,
      });

      // Fill в пути → помечаем orderId как MATCHED.
      // Это блокирует CancelOrderUseCase от отмены ордера с in-flight fill.
      //
      // Без этого TAKER cross-outcome MINT fills вызывают phantom position:
      // 1. Fill MINED приходит раньше WS order MATCHED event
      // 2. Стратегия отменяет ордер (hasMatchedFills = false)
      // 3. Cancel успешен на CLOB, но on-chain MINT завершается
      // 4. Токены в portfolio но не на CLOB balance → SELL невозможен навсегда
      //
      // Помечаем ордер при MATCHED и MINED (в обоих случаях cancel опасен).
      // НЕ маркируем при CONFIRMED: ProcessFillUseCase сразу снимет флаг.
      // При FAILED — fill не исполнился, маркировать не нужно.
      const shouldMarkOrder = dto.status !== 'FAILED' && dto.status !== 'CONFIRMED';
      if (shouldMarkOrder && this._onMatchedOnExchange) {
        this._markOrderFromFill(dto);
      }

      // Instrument-level tracking: помечаем инструмент как имеющий in-flight fills.
      // ТОЛЬКО при MATCHED — первое подтверждение in-flight fill.
      //
      // НЕ маркируем при MINED: fill уже обработан при MATCHED, ProcessFillUseCase
      // уже снял флаг через clearInFlightFill(fillId). Раньше (при counter-based
      // хранилище) повторная маркировка при MINED создавала риск double-increment
      // без гарантированного decrement (если FILL_RECEIVED для повторного MINED
      // не публикуется как "already processed" fill) → hasInFlightFills=true навсегда.
      // Сейчас хранилище identity-based (`Map<FillId, InFlightFill>`) — повторная
      // маркировка ТЕМ ЖЕ dto.id идемпотентна (перезаписывает ту же запись, не
      // удваивает), поэтому этот риск структурно исключён. MATCHED-only оставлен
      // как есть — маркировать при MINED всё равно избыточно (fill уже отслежен).
      //
      // Order-level tracking (shouldMarkOrder) маркирует и MINED — это безопасно,
      // т.к. order-level флаг снимается ProcessFillUseCase для каждого fill.
      const shouldMarkInstrument = dto.status === 'MATCHED';
      if (shouldMarkInstrument && this._onInFlightFill) {
        const instrumentId = asInstrumentId(dto.asset_id);
        const fillId = asFillId(dto.id);
        const [firstOrderId] = this._resolveOurOrderIds(dto);
        if (instrumentId && fillId && firstOrderId) {
          this._logger.debug('[USER-EVENT] marking instrument as having in-flight fill', {
            asset_id: dto.asset_id,
            status: dto.status,
            fillId: dto.id,
          });
          this._onInFlightFill(instrumentId, fillId, firstOrderId);
        }
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
      // Это order-lifecycle событие, а не fill-событие — конкретный fillId здесь
      // неизвестен, используем pendingMatchFillId placeholder (см. doc в @polymarket/ports);
      // он автоматически снимется, когда придёт реальный fill для этого ордера.
      if (dto.orderEventType === 'UPDATE' && dto.status === 'MATCHED' && this._onMatchedOnExchange) {
        const orderId = asOrderId(dto.order_id);
        if (orderId) {
          this._logger.debug('[USER-EVENT] order MATCHED on exchange — marking non-cancellable', {
            order_id: dto.order_id,
          });
          this._onMatchedOnExchange(orderId, pendingMatchFillId(orderId));
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
    readonly fee_rate_bps?: string;
    readonly status: string;
    readonly asset_id: string;
    readonly owner?: string;
    readonly market?: string;
    readonly bucket_index?: number;
    readonly match_time?: string;
    readonly maker_orders: Array<{
      readonly order_id: string;
      readonly matched_amount: string;
      readonly asset_id?: string;
      readonly owner?: string;
      readonly price?: string;
      readonly side?: 'BUY' | 'SELL';
      readonly maker_address?: string;
    }>;
    readonly timestamp: string;
  }): Record<string, unknown> {
    return {
      id: dto.id,
      taker_order_id: dto.taker_order_id,
      trader_side: dto.trader_side,
      price: dto.price,
      size: dto.size,
      fee_rate_bps: dto.fee_rate_bps ?? '0',
      status: dto.status,
      asset_id: dto.asset_id,
      owner: dto.owner,
      maker_address: this._makerAddress,
      market: dto.market,
      bucket_index: dto.bucket_index,
      match_time: dto.match_time,
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
    readonly id: string;
    readonly taker_order_id: string;
    readonly trader_side: 'TAKER' | 'MAKER';
    readonly maker_orders: ReadonlyArray<{ readonly order_id: string }>;
  }): void {
    const fillId = asFillId(dto.id);
    if (!fillId) return;

    for (const orderId of this._resolveOurOrderIds(dto)) {
      this._logger.debug('[USER-EVENT] fill received — marking order as MATCHED', {
        order_id: String(orderId),
        fillId: dto.id,
        trader_side: dto.trader_side,
      });
      this._onMatchedOnExchange!(orderId, fillId);
    }
  }

  /**
   * Определяет НАШИ orderId, участвующие в fill-событии.
   *
   * @param dto - Raw fill DTO из user-channel
   * @returns Массив наших OrderId (TAKER — всегда один; MAKER — может быть несколько)
   *
   * @remarks
   * - TAKER → наш ордер = taker_order_id
   * - MAKER → наши ордера = maker_orders[].order_id
   */
  private _resolveOurOrderIds(dto: {
    readonly taker_order_id: string;
    readonly trader_side: 'TAKER' | 'MAKER';
    readonly maker_orders: ReadonlyArray<{ readonly order_id: string }>;
  }): readonly OrderId[] {
    if (dto.trader_side === 'TAKER') {
      const orderId = asOrderId(dto.taker_order_id);
      return orderId ? [orderId] : [];
    }
    const orderIds: OrderId[] = [];
    for (const mo of dto.maker_orders) {
      const orderId = asOrderId(mo.order_id);
      if (orderId) orderIds.push(orderId);
    }
    return orderIds;
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
