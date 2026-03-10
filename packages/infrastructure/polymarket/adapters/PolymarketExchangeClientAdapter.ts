/**
 * PolymarketExchangeClientAdapter — реализует IExchangeClient через REST.
 *
 * @remarks
 * Маппинг domain VOs → Polymarket REST params и обратно.
 * PlaceOrderUseCase зависит от IExchangeClient, не от этого класса.
 *
 * ### Маппинг AssetId → tokenId:
 * Polymarket REST принимает числовой token_id (строка).
 * Для `POLYMARKET_CTF_TOKEN` — используем `asset.tokenId`.
 * Для других типов AssetId — конвертируем через `assetIdToString()` как fallback
 * (не ожидается на Polymarket).
 *
 * ### Обёртка вызовов:
 * `submitOrder` и `cancelOrder` оборачивают throws в `Err(ExchangeError)` —
 * IExchangeClient не бросает исключений.
 *
 * ### Зависимость от PolymarketExecutionAdapter:
 * Делегирует фактические HTTP-вызовы существующему `PolymarketExecutionAdapter`,
 * который содержит retry-логику, signing и обработку edge cases Polymarket API.
 *
 * @example
 * ```typescript
 * const exchangeClient: IExchangeClient = new PolymarketExchangeClientAdapter(
 *   executionAdapter,
 *   logger,
 * );
 *
 * // В PlaceOrderUseCase:
 * const result = await exchangeClient.submitOrder({
 *   asset: polymarketToken,
 *   side: 'BUY',
 *   price: Price.of(new Decimal('0.65')),
 *   size: Quantity.of(new Decimal('100')),
 * });
 * if (result.ok) console.log('Order placed:', result.value);
 * ```
 */
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import type { ILogger } from '@polymarket/logger';
import type { OrderId } from '@polymarket/ids';
import { asOrderId, assetIdToString, isPolymarketCtfToken } from '@polymarket/ids';
import type { IExchangeClient, SubmitOrderParams, ExchangeError } from '@polymarket/ports';
import { ExchangeError as ExchangeErrorClass } from '@polymarket/ports';
import type { PolymarketExecutionAdapter } from '../rest/adapters/PolymarketExecutionAdapter.js';

/**
 * Реализует IExchangeClient через PolymarketExecutionAdapter.
 *
 * @remarks
 * `PolymarketExecutionAdapter` содержит HTTP-логику и signing.
 * Этот адаптер добавляет:
 * - Конвертацию domain VOs → raw числа/строки
 * - Обёртку throws → `Err(ExchangeError)` (соответствует контракту IExchangeClient)
 * - Логирование на уровне application layer
 */
export class PolymarketExchangeClientAdapter implements IExchangeClient {
  private readonly _logger: ILogger;

  /**
   * @param _executionAdapter - Low-level HTTP адаптер исполнения
   * @param logger - Logger
   */
  constructor(
    private readonly _executionAdapter: PolymarketExecutionAdapter,
    logger: ILogger,
  ) {
    this._logger = logger.child({ component: 'PolymarketExchangeClientAdapter' });
  }

  /**
   * Размещает лимитный ордер через Polymarket REST.
   *
   * @param params - Параметры ордера (domain VOs)
   * @returns Ok(OrderId) при успехе, Err(ExchangeError) при ошибке
   *
   * @remarks
   * Конвертирует:
   * - `params.asset: AssetId` → raw tokenId string
   * - `params.price: Price` → number (через `.value().toNumber()`)
   * - `params.size: Quantity` → number (через `.value().toNumber()`)
   * - `params.side: Side` → lowercase 'buy' | 'sell'
   *
   * Все exceptions из PolymarketExecutionAdapter оборачиваются в ExchangeError.
   */
  public async submitOrder(params: SubmitOrderParams): Promise<Result<OrderId, ExchangeError>> {
    const tokenId = this._extractTokenId(params);

    try {
      const response = await this._executionAdapter.postOrder({
        tokenId,
        side: params.side.toLowerCase() as 'buy' | 'sell',
        price: params.price.value().toNumber(),
        size: params.size.value().toNumber(),
        strategyId: params.strategyId,
      });

      const orderId = asOrderId(response.orderId);
      if (!orderId) {
        return Err(new ExchangeErrorClass(
          `Invalid orderId returned from exchange: ${response.orderId}`,
          { context: { tokenId, strategyId: params.strategyId } },
        ));
      }

      this._logger.info('Order submitted to exchange', {
        orderId: response.orderId,
        tokenId,
        side: params.side,
        strategyId: params.strategyId,
      });

      return Ok(orderId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._logger.error('Exchange submitOrder failed', {
        tokenId,
        side: params.side,
        error: message,
      });
      return Err(new ExchangeErrorClass(
        `Exchange submitOrder failed: ${message}`,
        { context: { tokenId } },
      ));
    }
  }

  /**
   * Отменяет ордер на бирже.
   *
   * @param orderId - ID ордера для отмены
   * @returns Ok(void) при успехе, Err(ExchangeError) при ошибке
   *
   * @remarks
   * Все exceptions из PolymarketExecutionAdapter оборачиваются в ExchangeError.
   */
  public async cancelOrder(orderId: OrderId): Promise<Result<void, ExchangeError>> {
    try {
      await this._executionAdapter.cancelOrder(String(orderId));

      this._logger.info('Order cancelled on exchange', { orderId: String(orderId) });
      return Ok(undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._logger.error('Exchange cancelOrder failed', {
        orderId: String(orderId),
        error: message,
      });
      return Err(new ExchangeErrorClass(
        `Exchange cancelOrder failed: ${message}`,
        { context: { orderId: String(orderId) } },
      ));
    }
  }

  /**
   * Извлекает raw tokenId из AssetId для Polymarket REST API.
   *
   * @param params - Параметры ордера с AssetId
   * @returns Строковый token_id для Polymarket REST
   *
   * @remarks
   * Polymarket REST принимает числовой tokenId (например, '123456...').
   * Для POLYMARKET_CTF_TOKEN — используем `.tokenId` напрямую.
   * Для других типов — fallback через `assetIdToString()`.
   */
  private _extractTokenId(params: SubmitOrderParams): string {
    if (isPolymarketCtfToken(params.asset)) {
      return params.asset.tokenId;
    }
    // Fallback для других типов AssetId (OUTCOME_TOKEN, CURRENCY)
    // На Polymarket это не должно происходить, но логируем предупреждение
    const str = assetIdToString(params.asset);
    this._logger.warn('Non-CTF asset submitted to Polymarket exchange, using string representation', {
      assetType: params.asset.type,
      assetStr: str,
    });
    return str;
  }
}
