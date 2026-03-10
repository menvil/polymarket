/**
 * ITradingAPI — фасадный интерфейс для взаимодействия стратегии с системой.
 *
 * @remarks
 * Единственная точка входа для стратегии: размещение/отмена ордеров,
 * запрос открытых ордеров и подписка на события.
 *
 * Каждая стратегия получает изолированный экземпляр TradingAPI со своим `strategyId`.
 * Это обеспечивает:
 * - Изоляцию подписок (unsubscribeAll удаляет только подписки этой стратегии)
 * - Правильную маршрутизацию ордеров (strategyId пробрасывается в PlaceOrderUseCase)
 * - Фильтрацию открытых ордеров (getOpenOrders возвращает только ордера стратегии)
 *
 * @example
 * ```typescript
 * class SimpleQuoter implements IStrategy {
 *   async initialize(ctx: StrategyContext): Promise<Result<void, Error>> {
 *     ctx.api.subscribe('BOOK_UPDATED', async (event) => {
 *       const result = await ctx.api.placeOrder({
 *         asset: myAssetId,
 *         instrumentId: myInstrumentId,
 *         side: 'BUY',
 *         price: event.topOfBook.bestAsk,
 *         size: Quantity.of(new Decimal('10')),
 *       });
 *       if (!result.ok) console.error('Place order failed:', result.error.message);
 *     });
 *     return Ok(undefined);
 *   }
 * }
 * ```
 */
import type { Result } from '@polymarket/result';
import type { TradingError } from '@polymarket/errors';
import type { AssetId, InstrumentId, OrderId } from '@polymarket/ids';
import type { Price, Quantity, Side } from '@polymarket/value-objects';
import type { Order } from '@polymarket/order';
import type { ApplicationEvent, EventHandler } from '@polymarket/event-bus';
import type { PlaceOrderError } from '@polymarket/use-cases';

/**
 * Параметры для размещения нового ордера.
 *
 * @remarks
 * `instrumentId` используется для пре-трейд риск-проверки позиции.
 * `asset` определяет торгуемый актив (токен или валюту).
 */
export interface PlaceOrderParams {
  /** Торгуемый актив (например, POLYMARKET_CTF_TOKEN) */
  readonly asset: AssetId;
  /** ID инструмента для риск-проверки позиции */
  readonly instrumentId: InstrumentId;
  /** Сторона (BUY/SELL) */
  readonly side: Side;
  /** Лимитная цена */
  readonly price: Price;
  /** Размер ордера */
  readonly size: Quantity;
}

/**
 * Фасадный интерфейс торгового API для стратегии.
 *
 * @remarks
 * Реализуется: TradingAPI.
 * Потребляется: IStrategy через StrategyContext.
 */
export interface ITradingAPI {
  /**
   * ID стратегии, которой принадлежит этот API.
   *
   * @remarks
   * Используется для трекинга ордеров и подписок в репозиториях.
   */
  readonly strategyId: string;

  /**
   * Размещает новый лимитный ордер.
   *
   * @param params - Параметры ордера
   * @returns Ok(OrderId) при успехе, Err(PlaceOrderError) при нарушении риска или ошибке биржи
   *
   * @remarks
   * Внутри вызывает PlaceOrderUseCase, который:
   * 1. Выполняет пре-трейд риск-проверку
   * 2. Резервирует баланс
   * 3. Отправляет ордер на биржу
   *
   * @example
   * ```typescript
   * const result = await api.placeOrder({
   *   asset: myAsset,
   *   instrumentId: myInstrumentId,
   *   side: 'BUY',
   *   price: Price.of(new Decimal('0.65')),
   *   size: Quantity.of(new Decimal('100')),
   * });
   * if (result.ok) console.log('Placed:', result.value);
   * ```
   */
  placeOrder(params: PlaceOrderParams): Promise<Result<OrderId, PlaceOrderError>>;

  /**
   * Отменяет открытый ордер.
   *
   * @param orderId - ID ордера для отмены
   * @returns Ok(void) при успехе или если ордер уже в терминальном статусе
   *
   * @remarks
   * Best-effort отмена на бирже: ошибки биржи логируются, но не возвращаются.
   *
   * @example
   * ```typescript
   * await api.cancelOrder(orderId);
   * ```
   */
  cancelOrder(orderId: OrderId): Promise<Result<void, TradingError>>;

  /**
   * Возвращает открытые ордера этой стратегии.
   *
   * @returns Readonly массив открытых ордеров стратегии
   *
   * @remarks
   * Возвращает только ордера, созданные этой стратегией (по strategyId).
   *
   * @example
   * ```typescript
   * const orders = await api.getOpenOrders();
   * console.log(`Open orders: ${orders.length}`);
   * ```
   */
  getOpenOrders(): Promise<readonly Order[]>;

  /**
   * Подписывается на событие application event bus.
   *
   * @param type - Тип события из ApplicationEvent['type']
   * @param handler - Async handler события
   * @returns Функция отписки — вызвать при cleanup конкретной подписки
   *
   * @remarks
   * Все подписки отслеживаются внутри TradingAPI.
   * При вызове `unsubscribeAll()` все активные подписки будут сняты.
   *
   * @example
   * ```typescript
   * const unsub = api.subscribe('BOOK_UPDATED', async (event) => {
   *   // event: BookUpdatedEvent
   * });
   * // Снять только эту подписку:
   * unsub();
   * ```
   */
  subscribe<K extends ApplicationEvent['type']>(
    type: K,
    handler: EventHandler<Extract<ApplicationEvent, { type: K }>>
  ): () => void;

  /**
   * Снимает все подписки этой стратегии.
   *
   * @remarks
   * Вызывается StrategyRunner автоматически после `strategy.stop()`.
   * Гарантирует полный cleanup: ни один handler не будет вызван после остановки.
   *
   * @example
   * ```typescript
   * // Вызывается StrategyRunner — не вызывай вручную из стратегии
   * api.unsubscribeAll();
   * ```
   */
  unsubscribeAll(): void;
}
