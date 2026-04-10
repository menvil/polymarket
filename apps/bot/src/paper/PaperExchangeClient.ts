/**
 * PaperExchangeClient — обёртка над MockExchangeClient для paper/backtest режима.
 *
 * @remarks
 * Добавляет к MockExchangeClient регистрацию ордеров в PaperFillSimulator:
 * - `submitOrder()` → MockExchangeClient + simulator.trackOrder()
 * - `cancelOrder()` → MockExchangeClient + simulator.removeOrder()
 *
 * ### Мульти-маркет:
 * Поддерживает одновременную торговлю на нескольких рынках.
 * `registerMarket()` добавляет рыночный контекст в реестр,
 * `submitOrder()` маршрутизирует по `params.asset` → правильный инструмент/рынок.
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
 *
 * // Мульти-маркет: регистрируем дополнительные рынки
 * paperClient.registerMarket(instrumentId2, marketId2, accountId, asset2);
 *
 * // Используется вместо реального exchange client:
 * const placeOrderUseCase = new PlaceOrderUseCase({ exchangeClient: paperClient, ... });
 * ```
 */

import type { IExchangeClient, OpenOrderSnapshot, VenueTradeSnapshot, SubmitOrderParams } from '@polymarket/ports';
import type { MockExchangeClient } from '@polymarket/backtesting';
import type { AccountId, AssetId, InstrumentId, MarketId, OrderId } from '@polymarket/ids';
import { assetIdToString } from '@polymarket/ids';
import type { Timestamp } from '@polymarket/value-objects';
import type { IClock } from '@polymarket/time';
import type { Result } from '@polymarket/result';
import { Err } from '@polymarket/result';
import { ExchangeError } from '@polymarket/ports';
import type { PaperFillSimulator } from './PaperFillSimulator.js';

/**
 * Контекст рынка для маршрутизации ордеров.
 */
interface MarketContext {
  readonly instrumentId: InstrumentId;
  readonly marketId: MarketId;
  readonly accountId: AccountId;
  readonly asset: AssetId;
}

/**
 * Зависимости PaperExchangeClient.
 */
export interface PaperExchangeClientDeps {
  /** Базовый mock клиент для хранения состояния ордеров */
  readonly mock: MockExchangeClient;
  /** Симулятор fills */
  readonly simulator: PaperFillSimulator;
  /** Источник времени для определения maker/taker */
  readonly clock: IClock;
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

  /** Реестр рыночных контекстов: asset string → context */
  private readonly _marketContexts = new Map<string, MarketContext>();

  constructor(private readonly _deps: PaperExchangeClientDeps) {
    this._instrumentId = _deps.instrumentId;
    this._marketId = _deps.marketId;
    this._accountId = _deps.accountId;
    this._asset = _deps.asset;

    // Регистрируем начальный рынок
    this._marketContexts.set(assetIdToString(_deps.asset), {
      instrumentId: _deps.instrumentId,
      marketId: _deps.marketId,
      accountId: _deps.accountId,
      asset: _deps.asset,
    });
  }

  /**
   * Регистрирует дополнительный рынок для мульти-маркет торговли.
   *
   * @param instrumentId - Инструмент (outcome token)
   * @param marketId - Рынок
   * @param accountId - Аккаунт
   * @param asset - Торговый актив (ключ маршрутизации)
   *
   * @remarks
   * При `submitOrder()` контекст выбирается по `params.asset`.
   * Если asset не зарегистрирован — используется fallback (текущий `this._instrumentId`).
   */
  public registerMarket(
    instrumentId: InstrumentId,
    marketId: MarketId,
    accountId: AccountId,
    asset: AssetId,
  ): void {
    this._marketContexts.set(assetIdToString(asset), {
      instrumentId,
      marketId,
      accountId,
      asset,
    });
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
   * Вызывается при смене рынка в discovery-режиме (sequential rotation).
   * Для мульти-маркет используйте `registerMarket()`.
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

    // Синхронизируем реестр
    this._marketContexts.set(assetIdToString(asset), {
      instrumentId,
      marketId,
      accountId,
      asset,
    });
  }

  /**
   * Размещает ордер и регистрирует его в симуляторе fills.
   *
   * @param params - Параметры ордера
   * @returns Результат с orderId или ошибкой биржи
   *
   * @remarks
   * Маршрутизация: по `params.asset` находит зарегистрированный рыночный контекст.
   * При отсутствии — fallback на текущий `this._instrumentId`.
   * При успехе: ордер добавляется в PaperFillSimulator.
   * При ошибке (risk check и т.д.): в симулятор не добавляется.
   */
  public async submitOrder(
    params: SubmitOrderParams,
  ): Promise<Result<import('@polymarket/ports').SubmitOrderResult, ExchangeError>> {
    const ctx = this._marketContexts.get(assetIdToString(params.asset));
    const instrumentId = ctx?.instrumentId ?? this._instrumentId;

    if (
      params.postOnly === true &&
      this._deps.simulator.wouldCrossImmediately(instrumentId, params.side, params.price)
    ) {
      return Err(new ExchangeError('post-only order would execute immediately (marketable)'));
    }

    const result = await this._deps.mock.submitOrder(params);

    if (result.ok) {
      this._deps.simulator.trackOrder({
        orderId: result.value.orderId,
        instrumentId,
        marketId: ctx?.marketId ?? this._marketId,
        side: params.side,
        price: params.price,
        totalSize: params.size,
        remainingSize: params.size.value(),
        accountId: ctx?.accountId ?? this._accountId,
        asset: ctx?.asset ?? this._asset,
        postOnly: params.postOnly === true,
        placedAtMs: this._deps.clock.now().getTime(),
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
