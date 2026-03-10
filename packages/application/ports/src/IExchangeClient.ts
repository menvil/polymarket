/**
 * Порт: клиент для взаимодействия с торговой площадкой.
 *
 * @remarks
 * Dependency Inversion — use-cases зависят от этого интерфейса,
 * а не от конкретной инфраструктурной реализации.
 *
 * Реализация: `PolymarketExchangeClientAdapter` в `@polymarket/exchange` (Phase 8).
 *
 * Используется:
 * - PlaceOrderUseCase — `submitOrder()` → получить OrderId от биржи
 * - CancelOrderUseCase — `cancelOrder()` → отменить ордер на бирже
 */
import type { Result } from '@polymarket/result';
import type { OrderId, AssetId } from '@polymarket/ids';
import type { Price, Quantity, Side } from '@polymarket/value-objects';
import { TradingError } from '@polymarket/errors';

/**
 * Ошибка при взаимодействии с биржей.
 *
 * @remarks
 * Severity 'high' — требует немедленного внимания и обычно останавливает стратегию.
 */
export class ExchangeError extends TradingError {
  public readonly severity = 'high' as const;
}

/**
 * Параметры для размещения лимитного ордера.
 */
export interface SubmitOrderParams {
  /** Токен для торговли (YES/NO outcome token) */
  readonly asset: AssetId;
  /** Сторона сделки */
  readonly side: Side;
  /** Цена ордера */
  readonly price: Price;
  /** Объём ордера */
  readonly size: Quantity;
  /** Клиентский ID ордера для идемпотентного retry (опционально) */
  readonly clientOrderId?: string;
  /** ID стратегии для трекинга (опционально) */
  readonly strategyId?: string;
}

/**
 * Порт: клиент торговой площадки.
 *
 * @example
 * ```typescript
 * const result = await exchangeClient.submitOrder({
 *   asset: tokenId,
 *   side: Side.BUY,
 *   price: Price.of(new Decimal('0.65')),
 *   size: Quantity.of(new Decimal('100')),
 * });
 * if (!result.ok) {
 *   logger.error('Failed to submit order', { error: result.error.message });
 *   return;
 * }
 * const orderId = result.value;
 * ```
 */
export interface IExchangeClient {
  /**
   * Размещает лимитный ордер на бирже.
   *
   * @param params - Параметры ордера
   * @returns OrderId при успехе, ExchangeError при отказе биржи
   */
  submitOrder(params: SubmitOrderParams): Promise<Result<OrderId, ExchangeError>>;

  /**
   * Отменяет ордер на бирже.
   *
   * @param orderId - ID ордера для отмены
   * @returns Ok(void) при успехе, ExchangeError при ошибке
   */
  cancelOrder(orderId: OrderId): Promise<Result<void, ExchangeError>>;
}
