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
import type { OrderId, AccountId, AssetId } from '@polymarket/ids';
import { asOrderId, assetIdToString, isPolymarketCtfToken } from '@polymarket/ids';
import { Price, Quantity, TimestampService } from '@polymarket/value-objects';
import type { Timestamp } from '@polymarket/value-objects';
import type { IExchangeClient, SubmitOrderParams, SubmitOrderResult, CancelOrderResult, ExchangeError, OpenOrderSnapshot, VenueTradeSnapshot } from '@polymarket/ports';
import { ExchangeError as ExchangeErrorClass } from '@polymarket/ports';
import type { PolymarketExecutionAdapter } from '../rest/adapters/PolymarketExecutionAdapter.js';
import type { CancelOrderExecutionResponse, OrderResponse } from '../ports/IExecutionAdapter.js';
import type { PolymarketBalancePolicy } from '../rest/policies/PolymarketBalancePolicy.js';
import { mapUserFillToVenueTradeSnapshots } from './mapUserFillsToVenueTrades.js';

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
  private readonly _makerAddress?: string;
  private _sellDustAdjustCount = 0;

  /**
   * @param _executionAdapter - Low-level HTTP адаптер исполнения
   * @param logger - Logger
   * @param userTradesClient - L2-аутентифицированный клиент user trades (опционально)
   * @param balancePolicy - Политика проверки баланса (опционально, для SELL pre-check по on-chain балансу)
   * @param makerAddress - ETH-адрес нашего кошелька (опционально; тот же
   *   параметр, что `UserEventFeedAdapter._makerAddress`). Используется
   *   `getTrades()` для MAKER ownership matching в `maker_orders[]` — ВСЕГДА
   *   наш собственный адрес (credentials), а не значение из ответа API (см.
   *   `mapUserFillsToVenueTrades`). Без него ownership matching деградирует
   *   до owner UUID-only (см. `FillMapper.allFromPolymarketTradeEvent`).
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
    makerAddress?: string,
  ) {
    this._logger = logger.child({ component: 'PolymarketExchangeClientAdapter' });
    this._userTradesClient = userTradesClient;
    this._balancePolicy = balancePolicy;
    this._makerAddress = makerAddress;
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
    //
    // Exception boundary: сетевой `checkBalance()` внутри preflight может
    // отклонить Promise — это PRE-DISPATCH failure (запрос на venue НЕ
    // отправлялся, ордер точно не создан) → классифицируем как
    // DEFINITELY_NOT_SUBMITTED, НЕ пробрасываем throw (иначе caller не смог бы
    // отличить его от ambiguous post-dispatch сбоя и заблокировал бы retry).
    let adjustedSize: Result<Quantity, ExchangeError>;
    try {
      adjustedSize = await this._preflightSellCheck(params, tokenId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._logger.warn('SELL pre-flight balance check threw (pre-dispatch) — order definitely not submitted', {
        tokenId,
        error: message,
        strategyId: params.strategyId,
      });
      return Err(new ExchangeErrorClass(`SELL pre-flight balance check threw: ${message}`, {
        context: { tokenId },
        submitOutcome: 'DEFINITELY_NOT_SUBMITTED',
      }));
    }
    if (!adjustedSize.ok) {
      // Pre-dispatch validation — запрос на venue НЕ отправлялся: ордер точно не создан.
      return Err(new ExchangeErrorClass(adjustedSize.error.message, {
        context: { tokenId },
        submitOutcome: 'DEFINITELY_NOT_SUBMITTED',
      }));
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
      // Ошибка ПОСЛЕ отправки postOrder (timeout/network/API): venue-ордер МОГ
      // быть создан — ambiguous. Вызывающий код (PlaceOrderUseCase) обязан
      // трактовать как UNKNOWN-like (manual reconciliation), а не «точно не создан».
      return Err(new ExchangeErrorClass(
        `Exchange submitOrder failed: ${message}`,
        { context: { tokenId }, submitOutcome: 'MAY_HAVE_BEEN_SUBMITTED' },
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
      // Venue ОТВЕТИЛ (запрос дошёл), но orderId невалиден — ордер мог быть создан.
      return Err(new ExchangeErrorClass(
        `Invalid orderId returned from exchange: ${response.orderId}`,
        { submitOutcome: 'MAY_HAVE_BEEN_SUBMITTED' },
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
   * Требует L2-аутентифицированный `_userTradesClient` — БЕЗ него полноту
   * ответа доказать нельзя (см. контракт `IExchangeClient.getTrades`), поэтому
   * возвращается `Err`, а не молчаливо неполный `Ok` через `getFilledOrders`.
   * `requireCursor: true` в `getUserFills` — schema drift (bare-array ответ
   * либо объект без `next_cursor` не на сентинеле) тоже становится `Err`.
   *
   * Маппинг `UserFillResponse → VenueTradeSnapshot[]` делегирован
   * `mapUserFillToVenueTradeSnapshots` — тот же `FillMapper`, что и WS
   * user-channel путь (единая логика ownership/fillId, см. doc файла
   * `mapUserFillsToVenueTrades.ts`).
   */
  public async getTrades(
    accountId: AccountId,
    since?: Timestamp,
  ): Promise<Result<VenueTradeSnapshot[], ExchangeError>> {
    if (!this._userTradesClient) {
      return Err(new ExchangeErrorClass(
        'Exchange getTrades failed: no L2-authenticated user trades client configured — ' +
        'cannot guarantee completeness required by the getTrades contract',
      ));
    }
    // MAKER ownership matching в mapUserFillToVenueTradeSnapshots требует
    // makerAddress как fallback к owner UUID (cross-outcome fills, где
    // top-level owner — тейкер, не мы). Без него FillMapper систематически не
    // распознавал бы наши cross-outcome maker-ордера — а с fail-closed
    // маппингом (см. ниже) КАЖДЫЙ такой Err теперь проваливает ВЕСЬ getTrades().
    // Явная ошибка конфигурации лучше, чем непредсказуемые "settlement
    // почему-то никогда не проходит" в проде.
    if (!this._makerAddress) {
      return Err(new ExchangeErrorClass(
        'Exchange getTrades failed: authoritative user trades client is configured but makerAddress ' +
        'is not — MAKER ownership matching would be unreliable for cross-outcome fills',
      ));
    }
    try {
      // Cursor pagination выполняется ВНУТРИ getUserFills (следует по
      // next_cursor до сентинела `"LTE="`, бросает при незавершённой
      // пагинации/schema drift — см. контракт IExchangeClient.getTrades:
      // полнота ответа обязательна, частичный список недопустим). `since`
      // пробрасывается в `after` для сужения окна.
      const userFills = await this._userTradesClient.getUserFills({
        limit: 500,
        requireCursor: true,
        ...(since !== undefined ? { after: Math.floor(since.toNumber() / 1000) } : {}),
      });

      // Fail-closed на КАЖДУЮ запись (P0, см. doc mapUserFillsToVenueTrades):
      // authoritative endpoint возвращает ТОЛЬКО наши trades — Err от маппера
      // значит баг маппинга/schema drift на НАШЕЙ записи, а не «не наша,
      // пропустить». Один необработанный fill не должен молча исчезнуть из
      // authoritative-ответа — вся выборка проваливается, retry на следующем
      // прогоне (капитал остаётся held, а не ошибочно released).
      const snapshots: VenueTradeSnapshot[] = [];
      for (const f of userFills) {
        const mapped = mapUserFillToVenueTradeSnapshots(f, accountId, this._makerAddress);
        if (!mapped.ok) {
          this._logger.error('Exchange getTrades failed — unmappable authoritative user fill', {
            id: f.id,
            error: mapped.error.message,
          });
          return Err(new ExchangeErrorClass(`Exchange getTrades failed: ${mapped.error.message}`));
        }
        snapshots.push(...mapped.value);
      }

      const filtered = since
        ? snapshots.filter((s) => !s.executedAt.value().lessThan(since.value()))
        : snapshots;

      this._logger.info('Trades converted to snapshots', {
        rawCount: userFills.length,
        snapshotCount: filtered.length,
      });
      return Ok(filtered);
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
