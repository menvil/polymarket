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
import type { IExchangeClient, SubmitOrderParams, SubmitOrderResult, CancelOrderResult, ExchangeError, OpenOrderSnapshot, VenueTradeSnapshot } from '@polymarket/ports';
import { ExchangeError as ExchangeErrorClass } from '@polymarket/ports';
import type { PolymarketExecutionAdapter } from '../rest/adapters/PolymarketExecutionAdapter.js';
import type { CancelOrderExecutionResponse, OrderResponse } from '../ports/IExecutionAdapter.js';
import type { PolymarketBalancePolicy } from '../rest/policies/PolymarketBalancePolicy.js';

/**
 * Статусы venue, которые данный маппер умеет распознавать.
 *
 * @remarks
 * Включает как «сырые» статусы Polymarket CLOB API (`live`, `unmatched`, `pending`,
 * `delayed`, `matched`), так и уже нормализованные значения, которые фактически
 * отдаёт `PolymarketOrderMapper.mapStatus()` (`open`, `partially_filled`, `filled`,
 * `cancelled`) — `OrderResponse.status` типизирован как `string`, контракт не
 * гарантирует, какой именно набор значений реально придёт.
 */
const KNOWN_SUBMIT_STATUSES = new Set([
  'live', 'open', 'unmatched', 'pending', 'delayed',
  'matched', 'filled', 'partially_filled',
  'rejected', 'failed', 'cancelled', 'canceled',
]);

/** Статусы, означающие терминальный исход без live-ордера (reject/cancel на этапе submit). */
const REJECTED_SUBMIT_STATUSES = new Set(['rejected', 'failed', 'cancelled', 'canceled']);

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
  private readonly _balancePolicy?: PolymarketBalancePolicy;
  private _sellDustAdjustCount = 0;

  /**
   * @param _executionAdapter - Low-level HTTP адаптер исполнения
   * @param logger - Logger
   * @param userTradesClient - L2-аутентифицированный клиент user trades (опционально)
   * @param balancePolicy - Политика проверки баланса (опционально, для SELL pre-check по on-chain балансу)
   *
   * @remarks
   * Если передан `balancePolicy` — перед каждым SELL вызывается `checkBalance()`
   * с on-chain балансом как источником истины (должен быть инстанс БЕЗ
   * `portfolioProjector`, иначе проверка будет по event-sourced кешу).
   * При дефиците < 1% policy возвращает `suggestedSize` равный реальному
   * балансу, округлённому вниз до 2 знаков — используем его вместо исходного
   * `params.size`, предотвращая отказ API `not enough balance / allowance`.
   */
  constructor(
    private readonly _executionAdapter: PolymarketExecutionAdapter,
    logger: ILogger,
    userTradesClient?: import('../rest/clients/PolymarketUserTradesRestClient.js').PolymarketUserTradesRestClient,
    balancePolicy?: PolymarketBalancePolicy,
  ) {
    this._logger = logger.child({ component: 'PolymarketExchangeClientAdapter' });
    this._userTradesClient = userTradesClient;
    this._balancePolicy = balancePolicy;
  }

  /**
   * Возвращает диагностические счётчики адаптера.
   *
   * @returns Статистика: сколько раз SELL size был скорректирован по on-chain балансу
   */
  public get stats(): { sellDustAdjustCount: number } {
    return { sellDustAdjustCount: this._sellDustAdjustCount };
  }

  /**
   * Размещает лимитный ордер через Polymarket REST.
   *
   * @param params - Параметры ордера (domain VOs)
   * @returns Ok(SubmitOrderResult) с типизированным business-исходом; Err(ExchangeError)
   * только при транспортной/API ошибке
   *
   * @remarks
   * Конвертирует:
   * - `params.asset: AssetId` → raw tokenId string
   * - `params.price: Price` → number (через `.value().toNumber()`)
   * - `params.size: Quantity` → number (через `.value().toNumber()`)
   * - `params.side: Side` → lowercase 'buy' | 'sell'
   *
   * Все exceptions из PolymarketExecutionAdapter оборачиваются в ExchangeError.
   * Business-классификация ответа (OPEN/PARTIALLY_FILLED/FILLED/REJECTED/UNKNOWN)
   * выполняется в `_mapSubmitResponse` — сам этот метод её не парсит.
   */
  public async submitOrder(params: SubmitOrderParams): Promise<Result<SubmitOrderResult, ExchangeError>> {
    const tokenId = this._extractTokenId(params);

    // Pre-flight balance check для SELL: on-chain балансе как источнике истины.
    // Защищает от рассинхрона event-sourced Portfolio ↔ фактический on-chain баланс
    // (типичный случай: dust-потеря 0.001-0.01% после BUY settlement).
    // При дефиците < 1% policy возвращает suggestedSize = floor(onChain*100)/100 → адаптируем size.
    const adjustedSize = await this._preflightSellCheck(params, tokenId);
    if (!adjustedSize.ok) {
      return Err(adjustedSize.error);
    }
    const effectiveSize = adjustedSize.value;

    try {
      const response = await this._executionAdapter.postOrder({
        tokenId,
        side: params.side.toLowerCase() as 'buy' | 'sell',
        price: params.price.value().toNumber(),
        size: effectiveSize.value().toNumber(),
        postOnly: params.postOnly,
        orderType: params.orderType,
        clientOrderId: params.clientOrderId,
        strategyId: params.strategyId,
      });

      const mapped = this._mapSubmitResponse(response, effectiveSize);
      if (!mapped.ok) {
        return mapped;
      }

      this._logger.info('Order submit result mapped', {
        orderId: response.orderId,
        tokenId,
        side: params.side,
        strategyId: params.strategyId,
        status: mapped.value.status,
      });

      return mapped;
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
   * Маппит сырой venue-ответ на размещение ордера в структурированный SubmitOrderResult.
   *
   * @param response - Ответ `IExecutionAdapter.postOrder()` (нормализован
   * `PolymarketOrderMapper`, но `status` типизирован как `string` — контракт не
   * гарантирует конкретный набор значений)
   * @param effectiveSize - Фактический size, отправленный на биржу
   * @returns Ok(SubmitOrderResult) с классифицированным business outcome;
   * Err(ExchangeError) только если orderId невалиден (адаптер вернул мусор)
   *
   * @remarks
   * Приоритет источников истины: `filledSize` (вычисленный из ответа) важнее
   * текстового `status` — `status` используется только чтобы (1) отсеять
   * нераспознанные значения в UNKNOWN и (2) для терминальных статусов
   * (rejected/failed/cancelled/canceled) отличить REJECTED (`filledSize == 0`,
   * ничего не исполнено) от FAK/IOC-подобного FILLED (`filledSize > 0`, часть
   * исполнилась, остаток venue закрыл сам — live-ордера больше нет независимо
   * от того, что показывает сырой `sizeRemaining`).
   * Никогда не синтезирует fills — `filledSize`/`remainingSize` это просто числа,
   * не `Fill`-объекты; реальные fills приходят через WS/reconciliation.
   */
  private _mapSubmitResponse(
    response: OrderResponse,
    effectiveSize: Quantity,
  ): Result<SubmitOrderResult, ExchangeError> {
    const orderId = asOrderId(response.orderId);
    if (!orderId) {
      return Err(new ExchangeErrorClass(
        `Invalid orderId returned from exchange: ${response.orderId}`,
      ));
    }

    const normalizedStatus = response.status.toLowerCase();
    if (!KNOWN_SUBMIT_STATUSES.has(normalizedStatus)) {
      this._logger.warn('Unrecognized venue order status on submit', {
        orderId: response.orderId,
        status: response.status,
      });
      return Ok({
        status: 'UNKNOWN',
        reason: `Unrecognized venue order status: ${response.status}`,
        orderId,
        effectiveSize,
      });
    }

    const totalSize = effectiveSize.value();
    const remainingRaw = response.sizeRemaining;
    if (!Number.isFinite(remainingRaw)) {
      return Ok({
        status: 'UNKNOWN',
        reason: `Non-finite sizeRemaining from venue: ${String(remainingRaw)}`,
        orderId,
        effectiveSize,
      });
    }

    const remainingDecimal = new Decimal(remainingRaw);
    if (remainingDecimal.isNegative() || remainingDecimal.greaterThan(totalSize)) {
      return Ok({
        status: 'UNKNOWN',
        reason: `sizeRemaining (${remainingRaw}) out of bounds for effectiveSize (${totalSize.toString()})`,
        orderId,
        effectiveSize,
      });
    }
    const filledDecimal = totalSize.minus(remainingDecimal);

    if (REJECTED_SUBMIT_STATUSES.has(normalizedStatus)) {
      // filled == 0 → ничего не исполнилось, ордер целиком отклонён/отменён venue —
      // никакого live-ордера не создано. `remainingDecimal` здесь НЕ проверяем на ноль:
      // sizeRemaining = size - filledSize, поэтому при filled=0 remaining математически
      // равен totalSize (venue просто эхом возвращает исходный размер как «неисполненный»),
      // а не 0 — требовать remaining==0 тут было бы недостижимым условием.
      if (filledDecimal.isZero()) {
        return Ok({
          status: 'REJECTED',
          reason: `Venue reported status "${response.status}" with no fill`,
        });
      }
      // filled > 0 при терминальном статусе — FAK/IOC-подобный исход: часть исполнилась,
      // остаток venue закрыл/отменил сам. Live-ордера больше нет, поэтому это FILLED тем
      // объёмом, что реально исполнился (НЕ ждём отдельного OPEN/PARTIALLY_FILLED remainder).
      // `remainingDecimal` из сырого ответа здесь не используется — терминальный статус
      // авторитетнее: остатка в стакане нет независимо от того, что показывает sizeRemaining.
      return Ok({
        status: 'FILLED',
        orderId,
        effectiveSize,
        filledSize: Quantity.of(filledDecimal),
      });
    }

    if (remainingDecimal.isZero() && filledDecimal.isPositive()) {
      return Ok({
        status: 'FILLED',
        orderId,
        effectiveSize,
        filledSize: Quantity.of(filledDecimal),
      });
    }

    if (remainingDecimal.isPositive() && filledDecimal.isZero()) {
      return Ok({
        status: 'OPEN',
        orderId,
        effectiveSize,
        remainingSize: Quantity.of(remainingDecimal),
      });
    }

    if (remainingDecimal.isPositive() && filledDecimal.isPositive()) {
      return Ok({
        status: 'PARTIALLY_FILLED',
        orderId,
        effectiveSize,
        filledSize: Quantity.of(filledDecimal),
        remainingSize: Quantity.of(remainingDecimal),
      });
    }

    // filled == 0 && remaining == 0 при не-REJECTED статусе означало бы totalSize == 0,
    // что невозможно (Quantity гарантирует > 0) — сюда попадаем только при рассинхроне
    // данных venue; не додумываем исход.
    return Ok({
      status: 'UNKNOWN',
      reason: `Ambiguous venue response: status="${response.status}", filled=0, remaining=0`,
      orderId,
      effectiveSize,
    });
  }

  /**
   * Отменяет ордер на бирже.
   *
   * @param orderId - ID ордера для отмены
   * @returns Ok(CancelOrderResult) с бизнес-исходом отмены; Err(ExchangeError) только
   * при транспортной/API ошибке (executionAdapter.cancelOrder бросил exception)
   *
   * @remarks
   * `not_canceled[orderId]` от venue — это НЕ ошибка, а нормальный business outcome:
   * маппится в `CancelOrderResult` через `_mapCancelResponse` /
   * `_classifyCancelRejection`. Err возвращается только если сам HTTP/API вызов упал.
   */
  public async cancelOrder(orderId: OrderId): Promise<Result<CancelOrderResult, ExchangeError>> {
    try {
      const response = await this._executionAdapter.cancelOrder(String(orderId));
      const result = this._mapCancelResponse(orderId, response);

      this._logger.info('Order cancel result mapped', {
        orderId: String(orderId),
        status: result.status,
      });
      return Ok(result);
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
   * Маппит сырой venue-ответ на отмену в структурированный CancelOrderResult.
   *
   * @param orderId - ID ордера, для которого запрашивалась отмена
   * @param response - Сырой ответ venue (`canceled` / `not_canceled`)
   * @returns CancelOrderResult с классифицированным business outcome
   */
  private _mapCancelResponse(orderId: OrderId, response: CancelOrderExecutionResponse): CancelOrderResult {
    const orderIdStr = String(orderId);

    if (response.canceled.includes(orderIdStr)) {
      return { status: 'CANCELLED' };
    }

    const reason = response.not_canceled[orderIdStr];
    if (reason !== undefined) {
      return this._classifyCancelRejection(reason);
    }

    return {
      status: 'UNKNOWN_RETRY_NEEDED',
      reason: `Order ${orderIdStr} not present in canceled/not_canceled response`,
    };
  }

  /**
   * Классифицирует venue-специфичную причину отказа в отмене.
   *
   * @param reason - Текст причины из `not_canceled[orderId]`
   * @returns CancelOrderResult с классифицированным статусом (ALREADY_FILLED,
   * ALREADY_CANCELLED, NOT_FOUND или UNKNOWN_RETRY_NEEDED)
   *
   * @remarks
   * Единственное место в кодовой базе, где допустим парсинг текста venue-ошибки —
   * application layer (`CancelOrderUseCase`) полагается на уже классифицированный
   * `status` и не видит сырой текст.
   */
  private _classifyCancelRejection(reason: string): CancelOrderResult {
    const lower = reason.toLowerCase();

    if (
      lower.includes('matched') ||
      lower.includes('filled') ||
      lower.includes('executed') ||
      lower.includes("can't be canceled") ||
      lower.includes('cannot be canceled')
    ) {
      return { status: 'ALREADY_FILLED', reason };
    }

    // NOT_FOUND проверяется ДО generic already-cancelled — иначе фразы вроде
    // "order not found, not canceled" ошибочно попали бы в ALREADY_CANCELLED.
    if (
      lower.includes('not found') ||
      lower.includes('does not exist') ||
      lower.includes('unknown order') ||
      lower.includes('not exist')
    ) {
      return { status: 'NOT_FOUND', reason };
    }

    // Только точные признаки "уже отменён" — НЕ просто lower.includes('cancelled'),
    // иначе "not canceled" / "could not be canceled" ошибочно классифицировались бы
    // как идемпотентный успех, хотя venue фактически сообщил об отказе в отмене.
    if (
      lower.includes('already canceled') ||
      lower.includes('already cancelled') ||
      lower.includes('previously canceled') ||
      lower.includes('previously cancelled') ||
      lower.includes('status canceled') ||
      lower.includes('status cancelled')
    ) {
      return { status: 'ALREADY_CANCELLED', reason };
    }

    return { status: 'UNKNOWN_RETRY_NEEDED', reason };
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
          // Polymarket API возвращает taker_order_id/maker_order_id, не order_id.
          // Если пользователь был TAKER — его ордер в taker_order_id.
          // Если MAKER — в maker_order_id.
          order_id: f.trader_side === 'MAKER' ? f.maker_order_id : f.taker_order_id,
          market: f.market,
          asset_id: f.asset_id,
          side: f.side,
          price: f.price,
          size: f.size,
          fee_rate_bps: f.fee_rate_bps,
          trader_side: f.trader_side,
          // Polymarket API возвращает match_time как numeric string (Unix секунды): "1775457709".
          // Date.parse() не понимает такой формат — нужно конвертировать явно.
          // Fallback на числовой timestamp если match_time отсутствует.
          match_time: (() => {
            const raw = f.match_time;
            if (!raw) return undefined;
            const numVal = Number(raw);
            if (!isNaN(numVal) && numVal > 0) {
              return new Date(numVal < 1e12 ? numVal * 1000 : numVal).toISOString();
            }
            return raw; // уже ISO строка — возвращаем как есть
          })(),
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
  /**
   * Предварительная проверка баланса для SELL-ордера по on-chain источнику истины.
   *
   * @param params - Параметры исходного ордера
   * @param tokenId - Raw tokenId для Balance API
   * @returns Ok(size для отправки в postOrder) или Err(ExchangeError) если балансa нет
   *
   * @remarks
   * Алгоритм:
   * 1. Если side=BUY или balancePolicy не сконфигурирован — возвращаем исходный size.
   * 2. Вызываем `balancePolicy.checkBalance()` (уходит в Balance API, zero-cache).
   * 3. Если `check.ok === false` — возвращаем Err, submitOrder не вызывает постордер.
   * 4. Если `check.suggestedSize` меньше исходного — создаём новый Quantity
   *    из suggestedSize (уже округлён вниз до 2 знаков policy'ей) и логируем WARN.
   * 5. Иначе возвращаем исходный size.
   *
   * Ошибка создания Quantity из suggestedSize (например, 0 при полном обнулении)
   * возвращается как Err — нельзя отправлять zero-size ордер.
   */
  private async _preflightSellCheck(
    params: SubmitOrderParams,
    tokenId: string,
  ): Promise<Result<Quantity, ExchangeError>> {
    if (params.side !== 'SELL' || !this._balancePolicy) {
      return Ok(params.size);
    }

    const originalSize = params.size.value().toNumber();
    const check = await this._balancePolicy.checkBalance({
      tokenId,
      side: 'sell',
      price: params.price.value().toNumber(),
      size: originalSize,
    });

    if (!check.ok) {
      this._logger.warn('SELL pre-flight balance check failed', {
        tokenId,
        reason: check.reason,
        required: check.required,
        available: check.available,
        strategyId: params.strategyId,
      });
      return Err(new ExchangeErrorClass(
        `SELL pre-flight balance check failed: ${check.reason ?? 'unknown'}`,
        {
          context: {
            tokenId,
            strategyId: params.strategyId,
            required: check.required,
            available: check.available,
          },
        },
      ));
    }

    if (check.suggestedSize === undefined || check.suggestedSize >= originalSize) {
      return Ok(params.size);
    }

    // Tiny deficit обработан policy: suggestedSize — фактический on-chain остаток,
    // округлённый вниз до 2 знаков (требование API: makerAmount ≤ 2 dp для SELL).
    try {
      const adjusted = Quantity.of(new Decimal(check.suggestedSize));
      this._sellDustAdjustCount++;
      this._logger.warn('SELL size adjusted to on-chain balance (tiny deficit)', {
        tokenId,
        originalSize,
        adjustedSize: check.suggestedSize,
        deltaTokens: originalSize - check.suggestedSize,
        deficitPercent: ((originalSize - check.suggestedSize) / originalSize * 100).toFixed(3),
        strategyId: params.strategyId,
      });
      return Ok(adjusted);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._logger.warn('Failed to construct adjusted Quantity, rejecting SELL', {
        tokenId,
        suggestedSize: check.suggestedSize,
        error: message,
      });
      return Err(new ExchangeErrorClass(
        `SELL suggested size is invalid: ${check.suggestedSize}`,
        { context: { tokenId, strategyId: params.strategyId } },
      ));
    }
  }

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
