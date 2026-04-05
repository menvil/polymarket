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
import Decimal from 'decimal.js';
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import type { ILogger } from '@polymarket/logger';
import type { OrderId, AccountId, AssetId, MarketId } from '@polymarket/ids';
import { asOrderId, assetIdToString, isPolymarketCtfToken, asFillId, asMarketId, unsafeMarketId, AssetIdHelpers } from '@polymarket/ids';
import { Price, Quantity, TimestampService } from '@polymarket/value-objects';
import { calculatePolymarketTakerFee } from '@polymarket/fill';
import type { Timestamp } from '@polymarket/value-objects';
import type { IExchangeClient, SubmitOrderParams, SubmitOrderResult, ExchangeError, OpenOrderSnapshot, VenueTradeSnapshot } from '@polymarket/ports';
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
  private readonly _userTradesClient?: import('../rest/clients/PolymarketUserTradesRestClient.js').PolymarketUserTradesRestClient;

  /**
   * @param _executionAdapter - Low-level HTTP адаптер исполнения
   * @param logger - Logger
   * @param userTradesClient - L2-аутентифицированный клиент user trades (опционально)
   */
  constructor(
    private readonly _executionAdapter: PolymarketExecutionAdapter,
    logger: ILogger,
    userTradesClient?: import('../rest/clients/PolymarketUserTradesRestClient.js').PolymarketUserTradesRestClient,
  ) {
    this._logger = logger.child({ component: 'PolymarketExchangeClientAdapter' });
    this._userTradesClient = userTradesClient;
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
  public async submitOrder(params: SubmitOrderParams): Promise<Result<SubmitOrderResult, ExchangeError>> {
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

      // Polymarket CLOB может мгновенно исполнить ордер (status=matched).
      // Обнаруживаем это чтобы вызывающий код пометил ордер через markMatchedOnExchange
      // и не пытался отменять уже исполненный ордер.
      const immediatelyMatched =
        (response.status === 'matched' || response.status === 'filled') &&
        response.sizeRemaining === 0;

      this._logger.info('Order submitted to exchange', {
        orderId: response.orderId,
        tokenId,
        side: params.side,
        strategyId: params.strategyId,
        ...(immediatelyMatched ? { immediatelyMatched: true, responseStatus: response.status } : {}),
      });

      return Ok({ orderId, immediatelyMatched });
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
   * Возвращает открытые ордера аккаунта от биржи.
   *
   * @param accountId - ID аккаунта трейдера (проставляется в каждый snapshot)
   * @returns Ok(OpenOrderSnapshot[]) при успехе, Err(ExchangeError) при ошибке
   *
   * @remarks
   * Вызывает `_executionAdapter.getOpenOrders()` без фильтра по tokenId — возвращает
   * все открытые ордера аккаунта. Невалидные записи (некорректный orderId, VO) пропускаются.
   * `filledSize = size - sizeRemaining` (вычисляется из полей ответа API).
   */
  public async getOpenOrders(accountId: AccountId): Promise<Result<OpenOrderSnapshot[], ExchangeError>> {
    try {
      const orders = await this._executionAdapter.getOpenOrders();
      const snapshots: OpenOrderSnapshot[] = [];

      for (const o of orders) {
        const orderId = asOrderId(o.orderId);
        if (!orderId) {
          this._logger.warn('Skipping open order with invalid orderId', { orderId: o.orderId });
          continue;
        }

        const timestampResult = TimestampService.create(o.createdAt);
        if (!timestampResult.ok) {
          this._logger.warn('Skipping open order with invalid createdAt', { orderId: o.orderId });
          continue;
        }

        const filledSizeNum = Math.max(0, o.size - o.sizeRemaining);

        try {
          const asset: AssetId = { type: 'POLYMARKET_CTF_TOKEN', tokenId: o.tokenId };
          snapshots.push({
            orderId,
            accountId,
            asset,
            side: o.side.toUpperCase() as 'BUY' | 'SELL',
            price: Price.of(new Decimal(o.price)),
            size: Quantity.of(new Decimal(o.size)),
            filledSize: Quantity.of(new Decimal(filledSizeNum)),
            status: filledSizeNum > 0 ? 'PARTIALLY_FILLED' : 'OPEN',
            createdAt: timestampResult.value,
          });
        } catch {
          this._logger.warn('Skipping open order with invalid price/size values', {
            orderId: o.orderId,
          });
        }
      }

      this._logger.debug('Open orders fetched from exchange', { count: snapshots.length });
      return Ok(snapshots);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._logger.error('Exchange getOpenOrders failed', { error: message });
      return Err(new ExchangeErrorClass(`Exchange getOpenOrders failed: ${message}`));
    }
  }

  /**
   * Возвращает исполненные сделки аккаунта от биржи.
   *
   * @param accountId - ID аккаунта (проставляется в каждый VenueTradeSnapshot)
   * @param since - Фильтр по времени: пропускаются сделки раньше этого момента (опционально)
   * @returns Ok(VenueTradeSnapshot[]) при успехе, Err(ExchangeError) при ошибке
   *
   * @remarks
   * Вызывает `/data/trades` через `_executionAdapter.getFilledOrders()`.
   * Маппинг `TradeResponse → VenueTradeSnapshot`:
   * - `id`           → `fillId` (asFillId)
   * - `order_id`     → `orderId` (asOrderId); сделки без orderId пропускаются
   * - `market`       → `marketId` (asMarketId); если отсутствует — unsafeMarketId('')
   * - `asset_id`     → `asset: { type: 'POLYMARKET_CTF_TOKEN', tokenId }`
   * - `side`         → уже 'BUY' | 'SELL'
   * - `price`/`size` → Price/Quantity VOs
   * - `fee_rate_bps` → fee amount = price × size × bps / 10000, asset = USDC
   * - `match_time`   → executedAt (ISO → epoch ms через Date.parse)
   *
   * Фильтрация по `since`: применяется после получения данных (API не поддерживает since-фильтр).
   */
  public async getTrades(
    accountId: AccountId,
    since?: Timestamp,
  ): Promise<Result<VenueTradeSnapshot[], ExchangeError>> {
    try {
      // Используем L2-аутентифицированный endpoint для user-specific trades
      // (публичный endpoint без maker_address возвращает все trades всех пользователей)
      let trades: Array<{ id: string; order_id?: string; market?: string; asset_id: string; side: string; price: string; size: string; fee_rate_bps?: string; trader_side?: string; match_time?: string; status?: string }>;
      if (this._userTradesClient) {
        const userFills = await this._userTradesClient.getUserFills({ limit: 100 });
        trades = userFills.map(f => ({
          id: f.id,
          order_id: f.order_id,
          market: f.market,
          asset_id: f.asset_id,
          side: f.side,
          price: f.price,
          size: f.size,
          fee_rate_bps: f.fee_rate_bps,
          trader_side: undefined,
          // timestamp может быть в секундах (10 цифр) или миллисекундах (13 цифр)
          match_time: f.timestamp
            ? new Date(f.timestamp < 1e12 ? f.timestamp * 1000 : f.timestamp).toISOString()
            : undefined,
          status: 'CONFIRMED', // user trades endpoint возвращает confirmed fills
        }));
        this._logger.info('User fills retrieved via L2 auth', { count: trades.length });
      } else {
        trades = await this._executionAdapter.getFilledOrders(undefined, { onlyFirstPage: true });
      }
      const snapshots: VenueTradeSnapshot[] = [];

      for (const t of trades) {
        const fillId = asFillId(t.id);
        if (!fillId) {
          this._logger.warn('Skipping trade with invalid fillId', { id: t.id });
          continue;
        }

        // order_id обязателен для VenueTradeSnapshot
        if (!t.order_id) {
          this._logger.debug('Skipping trade without order_id', { fillId: t.id });
          continue;
        }
        const orderId = asOrderId(t.order_id);
        if (!orderId) {
          this._logger.warn('Skipping trade with invalid order_id', { order_id: t.order_id });
          continue;
        }

        // Время исполнения
        const matchTimeMs = t.match_time ? Date.parse(t.match_time) : NaN;
        if (isNaN(matchTimeMs)) {
          this._logger.warn('Skipping trade with invalid match_time', { fillId: t.id });
          continue;
        }
        const executedAtResult = TimestampService.create(matchTimeMs);
        if (!executedAtResult.ok) continue;

        // Фильтр по since
        if (since && executedAtResult.value.value().lessThan(since.value())) continue;

        const marketId: MarketId = t.market
          ? (asMarketId(t.market) ?? unsafeMarketId(t.market))
          : unsafeMarketId('');

        try {
          const price = Price.of(new Decimal(t.price));
          const size = Quantity.of(new Decimal(t.size));
          // MAKER fee = 0 на Polymarket. Комиссию платит только TAKER.
          const isMaker = t.trader_side === 'MAKER';
          const feeAmount = (!isMaker && t.fee_rate_bps && parseFloat(t.fee_rate_bps) > 0)
            ? calculatePolymarketTakerFee(size.value(), price.value())
            : new Decimal(0);

          const knownStatuses = ['MATCHED', 'MINED', 'CONFIRMED', 'RETRYING', 'FAILED'] as const;
          type KnownStatus = typeof knownStatuses[number];
          const status = knownStatuses.includes(t.status as KnownStatus)
            ? (t.status as KnownStatus)
            : undefined;

          snapshots.push({
            fillId,
            orderId,
            accountId,
            marketId,
            asset: { type: 'POLYMARKET_CTF_TOKEN', tokenId: t.asset_id } as AssetId,
            side: t.side as 'BUY' | 'SELL',
            price,
            size,
            fee: {
              amount: Quantity.of(feeAmount),
              asset: AssetIdHelpers.USDC,
            },
            executedAt: executedAtResult.value,
            status,
          });
        } catch {
          this._logger.warn('Skipping trade with invalid price/size values', { fillId: t.id });
        }
      }

      this._logger.info('Trades converted to snapshots', {
        rawCount: trades.length,
        snapshotCount: snapshots.length,
        firstTradeId: trades[0]?.id?.slice(0, 20),
        firstMatchTime: trades[0]?.match_time?.slice(0, 25),
        firstStatus: trades[0]?.status,
      });
      return Ok(snapshots);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._logger.error('Exchange getTrades failed', { error: message });
      return Err(new ExchangeErrorClass(`Exchange getTrades failed: ${message}`));
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
