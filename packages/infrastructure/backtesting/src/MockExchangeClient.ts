/**
 * MockExchangeClient — симулятор биржевого клиента для бектестирования.
 *
 * @remarks
 * Реализует интерфейс `IExchangeClient` без реального сетевого взаимодействия.
 * Используется в `BacktestEngine` для изоляции торговой логики от инфраструктуры.
 *
 * ### Поведение:
 * - `submitOrder()` генерирует уникальный OrderId и сохраняет ордер в памяти.
 * - `cancelOrder()` отмечает ордер как отменённый.
 * - `getOpenOrders()` всегда возвращает пустой массив (в бектесте ордера не
 *   отслеживаются через venue API — они приходят через снапшоты).
 * - `getTrades()` всегда возвращает пустой массив (сделки берутся из снапшотов).
 *
 * ### Вспомогательный API для тестов:
 * `getSubmittedOrders()` возвращает все ордера, поданные через `submitOrder()`.
 * Используется в тестах для проверки поведения стратегии.
 *
 * @example
 * ```typescript
 * const client = new MockExchangeClient(clock);
 *
 * const result = await client.submitOrder({
 *   asset: tokenId,
 *   side: Side.BUY,
 *   price: Price.of(new Decimal('0.65')),
 *   size: Quantity.of(new Decimal('100')),
 * });
 *
 * if (result.ok) {
 *   console.log('Submitted:', result.value);
 * }
 *
 * const submitted = client.getSubmittedOrders();
 * console.log('Total orders:', submitted.length);
 * ```
 */
import { Ok } from '@polymarket/result';
import type { Result } from '@polymarket/result';
import type { OrderId, AccountId } from '@polymarket/ids';
import type { IClock } from '@polymarket/time';
import type { Timestamp } from '@polymarket/timestamp';
import type {
  IExchangeClient,
  SubmitOrderParams,
  SubmitOrderResult,
  CancelOrderResult,
  OpenOrderSnapshot,
  VenueTradeSnapshot,
  ExchangeError,
} from '@polymarket/ports';

/**
 * Информация о поданном ордере (для тестовых assertions).
 */
export interface SubmittedOrder {
  /** Идентификатор ордера, присвоенный моком */
  readonly orderId: OrderId;
  /** Параметры, переданные в submitOrder() */
  readonly params: SubmitOrderParams;
  /** Время подачи ордера */
  readonly submittedAt: Date;
}

/**
 * Симулятор биржевого клиента для бектестирования и юнит-тестов.
 *
 * @remarks
 * Все методы возвращают заранее определённые ответы без реальных HTTP-запросов.
 * Счётчик ордеров обеспечивает уникальность OrderId в рамках одного экземпляра.
 */
export class MockExchangeClient implements IExchangeClient {
  /** Счётчик для генерации уникальных OrderId */
  private _counter = 0;

  /**
   * @param _clock - Источник времени для детерминированной генерации OrderId и submittedAt
   */
  constructor(private readonly _clock: IClock) {}

  /** Список всех поданных ордеров */
  private readonly _submittedOrders: SubmittedOrder[] = [];

  /** Множество отменённых OrderId */
  private readonly _cancelledOrderIds = new Set<OrderId>();

  /**
   * Симулирует подачу лимитного ордера.
   *
   * @remarks
   * Генерирует OrderId вида `order-{timestamp}-{counter}`, сохраняет параметры.
   * По умолчанию всегда возвращает `Ok({status: 'OPEN', ...})` — в бектесте fills
   * приходят отдельно из записанных снапшотов (не мгновенно на submit), поэтому
   * ордер всегда встаёт в стакан целиком, ничего не исполнено сразу.
   *
   * @param params - Параметры ордера
   * @returns Ok({status: 'OPEN', orderId, effectiveSize, remainingSize}) — всегда успех
   *
   * @example
   * ```typescript
   * const result = await client.submitOrder({ asset, side, price, size });
   * // result.ok === true, result.value.status === 'OPEN'
   * ```
   */
  public async submitOrder(
    params: SubmitOrderParams,
  ): Promise<Result<SubmitOrderResult, ExchangeError>> {
    this._counter += 1;
    const now = this._clock.now();
    const orderId = (params.clientOrderId ?? `order-${now.getTime()}-${this._counter}`) as OrderId;

    this._submittedOrders.push({
      orderId,
      params,
      submittedAt: now,
    });

    return Ok({
      status: 'OPEN',
      orderId,
      effectiveSize: params.size,
      remainingSize: params.size,
    });
  }

  /**
   * Симулирует отмену ордера.
   *
   * @remarks
   * Помечает orderId как отменённый. Не проверяет существование ордера —
   * в бектесте стратегия сама управляет жизненным циклом ордеров.
   *
   * @param orderId - ID ордера для отмены
   * @returns Ok({status: 'CANCELLED'}) — всегда успех
   *
   * @example
   * ```typescript
   * const result = await client.cancelOrder(orderId);
   * // result.ok === true, result.value.status === 'CANCELLED'
   * ```
   */
  public async cancelOrder(
    orderId: OrderId,
  ): Promise<Result<CancelOrderResult, ExchangeError>> {
    this._cancelledOrderIds.add(orderId);
    return Ok({ status: 'CANCELLED' });
  }

  /**
   * Возвращает открытые ордера аккаунта.
   *
   * @remarks
   * В бектесте всегда возвращает пустой массив: ордера не реплицируются
   * через venue API, они управляются через снапшоты.
   *
   * @param _accountId - ID аккаунта (не используется)
   * @returns Ok([]) — пустой массив
   *
   * @example
   * ```typescript
   * const result = await client.getOpenOrders(accountId);
   * // result.value === []
   * ```
   */
  public async getOpenOrders(
    _accountId: AccountId,
  ): Promise<Result<OpenOrderSnapshot[], ExchangeError>> {
    return Ok([]);
  }

  /**
   * Возвращает исполненные сделки аккаунта.
   *
   * @remarks
   * В бектесте всегда возвращает пустой массив: сделки (fills) приходят
   * из записанных снапшотов, а не от venue API.
   *
   * @param _accountId - ID аккаунта (не используется)
   * @param _since - Временная метка начала (не используется)
   * @returns Ok([]) — пустой массив
   *
   * @example
   * ```typescript
   * const result = await client.getTrades(accountId);
   * // result.value === []
   * ```
   */
  public async getTrades(
    _accountId: AccountId,
    _since?: Timestamp,
  ): Promise<Result<VenueTradeSnapshot[], ExchangeError>> {
    return Ok([]);
  }

  // ── Вспомогательные методы для тестовых assertions ───────────────────────

  /**
   * Возвращает все ордера, поданные через submitOrder().
   *
   * @remarks
   * Используется в тестах для проверки поведения стратегии:
   * сколько ордеров было создано, с какими параметрами и когда.
   *
   * @returns Копия массива поданных ордеров (readonly snapshot)
   *
   * @example
   * ```typescript
   * const orders = client.getSubmittedOrders();
   * expect(orders).toHaveLength(2);
   * expect(orders[0].params.side).toBe(Side.BUY);
   * ```
   */
  public getSubmittedOrders(): readonly SubmittedOrder[] {
    return [...this._submittedOrders];
  }

  /**
   * Проверяет, был ли ордер отменён.
   *
   * @param orderId - ID ордера для проверки
   * @returns true если orderId был передан в cancelOrder()
   *
   * @example
   * ```typescript
   * await client.cancelOrder(orderId);
   * expect(client.isCancelled(orderId)).toBe(true);
   * ```
   */
  public isCancelled(orderId: OrderId): boolean {
    return this._cancelledOrderIds.has(orderId);
  }

  /**
   * Сбрасывает внутреннее состояние мока.
   *
   * @remarks
   * Очищает список поданных ордеров, отменённых ордеров и сбрасывает счётчик.
   * Используется в beforeEach тестовых сьютов для изоляции тестов.
   *
   * @example
   * ```typescript
   * beforeEach(() => client.reset());
   * ```
   */
  public reset(): void {
    this._counter = 0;
    this._submittedOrders.length = 0;
    this._cancelledOrderIds.clear();
  }
}
