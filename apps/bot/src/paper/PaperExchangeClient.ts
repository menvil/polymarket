/**
 * PaperExchangeClient — обёртка над MockExchangeClient для paper/backtest режима.
 *
 * @remarks
 * Добавляет к MockExchangeClient регистрацию ордеров в PaperFillSimulator:
 * - `submitOrder()` → MockExchangeClient + simulator.trackOrder()
 * - `cancelOrder()` → MockExchangeClient + simulator.removeOrder()
 *
 * ### Почему отдельный класс, а не модификация MockExchangeClient:
 * MockExchangeClient — инфраструктурный компонент для тестирования.
 * PaperExchangeClient — application-уровень, зависит от домена.
 * Разделение соблюдает направление зависимостей.
 *
 * @example
 * ```typescript
 * const paperClient = new PaperExchangeClient({
 *   mock: new MockExchangeClient(clock),
 *   simulator,
 *   instrumentId,
 *   marketId,
 *   accountId,
 * });
 * // Используется вместо реального exchange client:
 * const placeOrderUseCase = new PlaceOrderUseCase({ exchangeClient: paperClient, ... });
 * ```
 */

import type { IExchangeClient, OpenOrderSnapshot, VenueTradeSnapshot, ExchangeError, SubmitOrderParams } from '@polymarket/ports';
import type { MockExchangeClient } from '@polymarket/backtesting';
import type { AccountId, AssetId, InstrumentId, MarketId, OrderId } from '@polymarket/ids';
import type { Timestamp } from '@polymarket/value-objects';
import type { Result } from '@polymarket/result';
import type { PaperFillSimulator } from './PaperFillSimulator.js';

/**
 * Зависимости PaperExchangeClient.
 */
export interface PaperExchangeClientDeps {
  /** Базовый mock клиент для хранения состояния ордеров */
  readonly mock: MockExchangeClient;
  /** Симулятор fills */
  readonly simulator: PaperFillSimulator;
  /** ID торгуемого инструмента (outcome token) */
  readonly instrumentId: InstrumentId;
  /** ID рынка */
  readonly marketId: MarketId;
  /** ID аккаунта */
  readonly accountId: AccountId;
  /** AssetId торгуемого токена */
  readonly asset: AssetId;
}

export class PaperExchangeClient implements IExchangeClient {
  private _instrumentId: InstrumentId;
  private _marketId: MarketId;
  private _accountId: AccountId;
  private _asset: AssetId;

  constructor(private readonly _deps: PaperExchangeClientDeps) {
    this._instrumentId = _deps.instrumentId;
    this._marketId = _deps.marketId;
    this._accountId = _deps.accountId;
    this._asset = _deps.asset;
  }

  /**
   * Обновляет рыночный контекст при переключении на новый рынок.
   *
   * @param instrumentId - Новый инструмент (outcome token)
   * @param marketId - Новый рынок
   * @param accountId - Аккаунт (обычно не меняется)
   * @param asset - Новый торговый актив
   *
   * @remarks
   * Вызывается при смене рынка в discovery-режиме без пересоздания
   * всей цепочки PlaceOrderUseCase → ExecutionEngine → StrategyScheduler.
   */
  public setMarket(
    instrumentId: InstrumentId,
    marketId: MarketId,
    accountId: AccountId,
    asset: AssetId,
  ): void {
    this._instrumentId = instrumentId;
    this._marketId = marketId;
    this._accountId = accountId;
    this._asset = asset;
  }

  /**
   * Размещает ордер и регистрирует его в симуляторе fills.
   *
   * @param params - Параметры ордера
   * @returns Результат с orderId или ошибкой биржи
   *
   * @remarks
   * При успехе: ордер добавляется в PaperFillSimulator.
   * При ошибке (risk check и т.д.): в симулятор не добавляется.
   */
  public async submitOrder(
    params: SubmitOrderParams,
  ): Promise<Result<OrderId, ExchangeError>> {
    const result = await this._deps.mock.submitOrder(params);

    if (result.ok) {
      this._deps.simulator.trackOrder({
        orderId: result.value,
        instrumentId: this._instrumentId,
        marketId: this._marketId,
        side: params.side,
        price: params.price,
        totalSize: params.size,
        remainingSize: params.size.value(),
        accountId: this._accountId,
        asset: this._asset,
      });
    }

    return result;
  }

  /**
   * Отменяет ордер и удаляет его из симулятора.
   *
   * @param orderId - ID ордера для отмены
   * @returns Результат отмены
   */
  public async cancelOrder(orderId: OrderId): Promise<Result<void, ExchangeError>> {
    const result = await this._deps.mock.cancelOrder(orderId);

    if (result.ok) {
      this._deps.simulator.removeOrder(orderId);
    }

    return result;
  }

  /**
   * Возвращает открытые ордера (делегируется в MockExchangeClient).
   *
   * @param accountId - ID аккаунта
   * @returns Список открытых ордеров
   */
  public async getOpenOrders(
    accountId: AccountId,
  ): Promise<Result<OpenOrderSnapshot[], ExchangeError>> {
    return this._deps.mock.getOpenOrders(accountId);
  }

  /**
   * Возвращает историю сделок (делегируется в MockExchangeClient).
   *
   * @param accountId - ID аккаунта
   * @param since - Начальный момент времени (опционально)
   * @returns Список сделок
   */
  public async getTrades(
    accountId: AccountId,
    since?: Timestamp,
  ): Promise<Result<VenueTradeSnapshot[], ExchangeError>> {
    return this._deps.mock.getTrades(accountId, since);
  }
}
