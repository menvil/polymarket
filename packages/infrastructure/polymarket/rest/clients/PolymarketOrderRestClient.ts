/**
 * REST-клиент ордеров Polymarket
 *
 * @remarks
 * Обрабатывает endpoints /order и /orders:
 * - POST /order - Разместить новый ордер
 * - DELETE /order - Отменить ордер
 * - GET /orders - Получить открытые ордера
 *
 * Возвращает СЫРЫЕ ответы API (НЕ нормализованные).
 * Нормализация выполняется маппером в вышестоящих слоях.
 *
 * @example
 * ```typescript
 * const client = new PolymarketOrderRestClient(restClient, logger);
 *
 * // Разместить ордер
 * const order = await client.createOrder({
 *   tokenId: '0x123',
 *   side: 'BUY',
 *   price: 0.52,
 *   size: 100,
 * });
 *
 * // Отменить ордер
 * await client.cancelOrder('order-123');
 *
 * // Получить открытые ордера
 * const orders = await client.getOpenOrders('0x123');
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import { OrderType, orderToJsonV2 } from '@polymarket/clob-client-v2';
import { ApiError } from '../PolymarketRestClient.js';
import type { PolymarketRestClient } from '../PolymarketRestClient.js';
import type { PolymarketOrderBuilder } from '../auth/PolymarketOrderBuilder.js';

/**
 * Запрос на создание ордера (упрощённый формат API)
 */
export interface CreateOrderRequest {
  /** Идентификатор токена */
  tokenId: string;

  /** Направление ордера */
  side: 'BUY' | 'SELL';

  /** Цена (число: 0-1) */
  price: number;

  /** Размер (количество акций) */
  size: number;

  /** true = post-only order; exchange rejects instead of matching immediately */
  postOnly?: boolean;

  /** CLOB order type. FAK is Polymarket CLOB's IOC analogue. */
  orderType?: 'GTC' | 'GTD' | 'FOK' | 'FAK';

  /** Шаг цены для округления (необязательно, по умолчанию: 0.01) */
  priceTick?: number;

  /** true если рынок использует negRisk exchange contract */
  negRisk?: boolean;
}

/**
 * Ответ на создание ордера (сырой формат API)
 */
export interface CreateOrderResponse {
  /** Флаг успеха */
  success: boolean;

  /** Сообщение об ошибке (пустое при успехе) */
  errorMsg: string;

  /** Идентификатор ордера (с заглавной D!) */
  orderID: string;

  /** Статус ордера */
  status: 'pending' | 'live' | 'filled' | 'cancelled' | 'matched' | 'delayed' | 'unmatched';

  /** Сумма к получению */
  takingAmount: string;

  /** Сумма к отдаче */
  makingAmount: string;

  /** Идентификатор токена (необязательно, не всегда присутствует) */
  tokenId?: string;

  /** Направление ордера (необязательно, не всегда присутствует) */
  side?: 'BUY' | 'SELL';

  /** Цена (необязательно, не всегда присутствует) */
  price?: string;

  /** Размер (необязательно, не всегда присутствует) */
  size?: string;

  /** Исполненный размер (необязательно, не всегда присутствует) */
  filledSize?: string;

  /** Временная метка (необязательно, не всегда присутствует) */
  timestamp?: number;
}

/**
 * Запрос на отмену ордера
 */
export interface CancelOrderRequest {
  /** Идентификатор ордера для отмены */
  orderId: string;

  /** Временная метка */
  timestamp: number;
}

/**
 * Ответ Polymarket API на отмену ордера.
 *
 * @remarks
 * Реальный формат: `{"not_canceled": {}, "canceled": ["0xabc..."]}`.
 * `canceled` — массив orderId которые были успешно отменены.
 * `not_canceled` — объект `{ orderId: reason }` для ордеров, которые не удалось отменить.
 */
export interface CancelOrderResponse {
  /** Массив orderId, успешно отменённых */
  canceled: string[];

  /** Объект orderId → причина для не-отменённых ордеров */
  not_canceled: Record<string, string>;
}

/**
 * Ответ на запрос ордеров
 */
export interface GetOrdersResponse {
  /** Массив ордеров */
  orders: CreateOrderResponse[];
}

/**
 * Ответ с исполненным ордером (из /data/orders?status=MATCHED)
 *
 * @remarks
 * Представляет агрегированный исполненный ордер.
 * Одна строка = один ордер (даже если исполнен несколькими сделками).
 * size_matched = суммарный исполненный размер; avg_price = средняя цена исполнения.
 */
export interface MatchedOrderResponse {
  /** Идентификатор ордера */
  id: string;
  /** Идентификатор актива (токена) */
  asset_id: string;
  /** Направление ордера */
  side: 'BUY' | 'SELL';
  /** Исходный размер ордера */
  original_size: string;
  /** Суммарно исполненный размер (сумма всех сделок) */
  size_matched: string;
  /** Средняя цена исполнения */
  avg_price: string;
  /** Статус ордера */
  status: string;
  /** Адрес мейкера */
  maker_address?: string;
  /** Временная метка создания (строка ISO) */
  created_at?: string;
}

/**
 * Ответ со сделкой (из /data/trades, постраничный)
 *
 * @remarks
 * Представляет одно on-chain исполнение сделки.
 * Возвращается в постраничном формате: { data: TradeResponse[], next_cursor: string }.
 */
export interface TradeResponse {
  /** Идентификатор сделки */
  id: string;
  /** Связанный идентификатор ордера */
  order_id?: string;
  /** Идентификатор условия маркета */
  market?: string;
  /** Идентификатор актива (токена) */
  asset_id: string;
  /** Направление сделки */
  side: 'BUY' | 'SELL';
  /** Размер исполнения */
  size: string;
  /** Цена исполнения */
  price: string;
  /** Ставка комиссии в базисных пунктах */
  fee_rate_bps?: string;
  /** Статус сделки */
  status?: string;
  /** Адрес мейкера */
  maker_address?: string;
  /** Хэш транзакции */
  transaction_hash?: string;
  /** Временная метка матчинга */
  match_time?: string;
  /** Сторона трейдера (MAKER или TAKER) */
  trader_side?: 'MAKER' | 'TAKER';
}

/**
 * Обёртка постраничного ответа со сделками из /data/trades
 */
export interface PaginatedTradesResponse {
  /** Массив сделок текущей страницы */
  data: TradeResponse[];
  /** Курсор для следующей страницы (LTE= означает конец результатов) */
  next_cursor: string;
}

/**
 * REST-клиент ордеров Polymarket
 */
export class PolymarketOrderRestClient {
  constructor(
    private readonly restClient: PolymarketRestClient,
    private readonly orderBuilder: PolymarketOrderBuilder,
    private readonly logger: ILogger,
    private readonly makerAddress?: string // MAKER-адрес для запросов /data/trades
  ) {}

  /**
   * Получает MAKER-адрес (адрес фандера, НЕ адрес подписанта!)
   *
   * @returns MAKER-адрес
   *
   * @remarks
   * Используется для запросов /data/trades для получения fills пользователя.
   * КРИТИЧНО: Это адрес ФАНДЕРА (proxy-кошелёк), НЕ адрес ПОДПИСАНТА!
   */
  getMakerAddress(): string | undefined {
    return this.makerAddress;
  }

  /**
   * Разместить новый ордер
   *
   * @param request - Запрос на создание ордера
   * @returns Сырой ответ API с данными ордера
   * @throws {ApiError} При ошибке API-вызова
   *
   * @remarks
   * Возвращает сырой ответ API. Нормализация должна выполняться маппером.
   *
   * @example
   * ```typescript
   * const order = await client.createOrder({
   *   tokenId: '0x123',
   *   side: 'BUY',
   *   price: 0.52,
   *   size: 100,
   * });
   *
   * console.log(`Order created: ${order.orderId}`);
   * ```
   */
  async createOrder(request: CreateOrderRequest): Promise<CreateOrderResponse> {
    this.logger.debug('Creating order', {
      tokenId: request.tokenId,
      side: request.side,
      price: request.price,
      size: request.size,
    });

    // Строим EIP-712 подписанный ордер V2 (без nonce и feeRateBps)
    const signedOrder = await this.orderBuilder.buildOrder({
      tokenId: request.tokenId,
      side: request.side,
      price: request.price,
      size: request.size,
      expiration: 0, // Без истечения
      priceTick: request.priceTick,
      negRisk: request.negRisk,
    });

    this.logger.debug('Order signed', {
      salt: signedOrder.salt,
      maker: signedOrder.maker,
      signer: signedOrder.signer,
      makerAmount: signedOrder.makerAmount,
      takerAmount: signedOrder.takerAmount,
    });

    if (!this.isPositiveIntegerAmount(signedOrder.makerAmount) || !this.isPositiveIntegerAmount(signedOrder.takerAmount)) {
      throw new ApiError(
        `Refusing to submit invalid signed order amounts: makerAmount=${signedOrder.makerAmount}, takerAmount=${signedOrder.takerAmount}, side=${request.side}, price=${request.price}, size=${request.size}`,
      );
    }

    // Отправляем ордер в API (POST /order ожидает формат V2)
    // КРИТИЧНО: owner ДОЛЖЕН быть строкой API KEY (UUID), НЕ адресом кошелька!
    const payload = orderToJsonV2(
      signedOrder as any,
      this.restClient.getApiKey(),
      request.orderType ? OrderType[request.orderType] : OrderType.GTC,
      request.postOnly === true,
      request.postOnly === true,
    );

    const response = await this.restClient.post<CreateOrderResponse>('/order', payload, {
      requireSignature: false,
    });

    if (response.success === false) {
      throw new ApiError(
        `Create order rejected by exchange: ${response.errorMsg || 'unknown error'}`,
      );
    }

    this.logger.info('Order created successfully', {
      orderID: response.orderID,
      status: response.status,
      success: response.success,
      errorMsg: response.errorMsg || undefined,
    });

    return response;
  }

  private isPositiveIntegerAmount(value: string): boolean {
    try {
      return BigInt(value) > 0n;
    } catch {
      return false;
    }
  }

  /**
   * Отменить ордер
   *
   * @param orderId - Идентификатор ордера для отмены
   * @returns Ответ на отмену
   * @throws {ApiError} При ошибке API-вызова
   *
   * @example
   * ```typescript
   * await client.cancelOrder('order-123');
   * console.log('Order cancelled');
   * ```
   */
  async cancelOrder(orderId: string): Promise<CancelOrderResponse> {
    this.logger.debug('Cancelling order', { orderId });

    const response = await this.restClient.delete<CancelOrderResponse>('/order', {
      orderID: orderId,
      timestamp: Date.now(),
    });

    // Проверяем что ордер попал в canceled, а не в not_canceled
    const isCanceled = response.canceled?.includes(orderId);
    const notCanceledReason = response.not_canceled?.[orderId];

    if (notCanceledReason) {
      throw new ApiError(
        `Cancel order rejected by exchange: ${notCanceledReason} (orderId=${orderId})`,
      );
    }

    if (!isCanceled) {
      this.logger.warn('Order not found in canceled list — may have already been filled/cancelled', {
        orderId,
        canceled: response.canceled,
        not_canceled: response.not_canceled,
      });
    } else {
      this.logger.info('Order cancelled successfully', { orderId });
    }

    return response;
  }

  /**
   * Отменить несколько ордеров за один запрос (batch cancel)
   *
   * @param orderIds - Массив идентификаторов ордеров для отмены
   * @returns Ответ с canceled / not_canceled
   * @throws {ApiError} При ошибке API-вызова
   *
   * @example
   * ```typescript
   * await client.cancelOrders(['order-1', 'order-2']);
   * ```
   */
  async cancelOrders(orderIds: string[]): Promise<CancelOrderResponse> {
    this.logger.debug('Cancelling orders (batch)', { count: orderIds.length });

    const response = await this.restClient.delete<CancelOrderResponse>('/orders', {
      orderIDs: orderIds,
    });

    this.logger.info('Batch cancel result', {
      canceledCount: response.canceled?.length ?? 0,
      notCanceledCount: Object.keys(response.not_canceled ?? {}).length,
    });

    return response;
  }

  /**
   * Отменить все открытые ордера аккаунта (emergency stop)
   *
   * @returns Ответ с canceled / not_canceled
   * @throws {ApiError} При ошибке API-вызова
   *
   * @remarks
   * Отменяет все ордера аккаунта независимо от рынка.
   * Используется для аварийного стопа бота.
   *
   * @example
   * ```typescript
   * await client.cancelAll();
   * ```
   */
  async cancelAll(): Promise<CancelOrderResponse> {
    this.logger.info('Cancelling ALL open orders');

    const response = await this.restClient.delete<CancelOrderResponse>('/orders', {
      cancelAll: true,
    });

    this.logger.info('Cancel all result', {
      canceledCount: response.canceled?.length ?? 0,
      notCanceledCount: Object.keys(response.not_canceled ?? {}).length,
    });

    return response;
  }

  /**
   * Отменить все ордера по рынку (conditionId) с опциональным фильтром по токену
   *
   * @param market - Condition ID рынка
   * @param assetId - Опционально: фильтр по конкретному tokenId (UP или DOWN)
   * @returns Ответ с canceled / not_canceled
   * @throws {ApiError} При ошибке API-вызова
   *
   * @example
   * ```typescript
   * // Отменить все ордера по рынку
   * await client.cancelMarketOrders('0xbd31dc8a...');
   *
   * // Отменить только по конкретному токену
   * await client.cancelMarketOrders('0xbd31dc8a...', '52114319...');
   * ```
   */
  async cancelMarketOrders(market: string, assetId?: string): Promise<CancelOrderResponse> {
    this.logger.info('Cancelling market orders', { market: market.slice(0, 20), assetId: assetId?.slice(0, 16) });

    const body: Record<string, string> = { market };
    if (assetId) body['asset_id'] = assetId;

    const response = await this.restClient.delete<CancelOrderResponse>('/orders/market', body);

    this.logger.info('Cancel market orders result', {
      market: market.slice(0, 20),
      canceledCount: response.canceled?.length ?? 0,
    });

    return response;
  }

  /**
   * Получить открытые ордера
   *
   * @param tokenId - Необязательно: фильтр по идентификатору токена
   * @returns Массив открытых ордеров
   * @throws {ApiError} При ошибке API-вызова
   *
   * @remarks
   * Возвращает только ордера в статусах PENDING и LIVE.
   * Ордера FILLED и CANCELLED исключены.
   *
   * @example
   * ```typescript
   * // Все открытые ордера
   * const allOrders = await client.getOpenOrders();
   *
   * // Ордера для конкретного токена
   * const tokenOrders = await client.getOpenOrders('0x123');
   * ```
   */
  async getOpenOrders(tokenId?: string): Promise<CreateOrderResponse[]> {
    this.logger.debug('Getting open orders', {
      tokenId,
      signatureType: this.restClient.getSignatureType(),
    });

    // КРИТИЧНО: НЕ фильтровать по signature_type!
    // signature_type фильтрует по адресу ПОДПИСАНТА, а не МЕЙКЕРА
    // При использовании proxy-кошелька (signature_type=1), ордера создаются с MAKER=адрес фандера
    // Но фильтр signature_type=1 возвращает ордера для адреса ПОДПИСАНТА (proxy)
    // Результат: бот не видит собственные ордера!
    // Решение: убрать фильтр signature_type для получения ВСЕХ ордеров аккаунта
    const params: Record<string, string> = {};

    if (tokenId) {
      params.asset_id = tokenId; // Используем параметр 'asset_id', не 'tokenId'
    }

    // КРИТИЧНО: Используем endpoint /data/orders (не /orders — тот вернёт HTTP 405)
    const response = await this.restClient.get<CreateOrderResponse[]>('/data/orders', params);

    // API возвращает массив напрямую, не в формате { orders: [...] }
    const orders = Array.isArray(response) ? response : [];

    this.logger.debug('Open orders retrieved', {
      count: orders.length,
      tokenIdFilter: tokenId || 'none',
    });

    return orders;
  }

  /**
   * Получить ордер по идентификатору
   *
   * @param orderId - Идентификатор ордера
   * @returns Ответ с данными ордера
   * @throws {ApiError} При ошибке API-вызова или если ордер не найден
   *
   * @example
   * ```typescript
   * const order = await client.getOrderById('order-123');
   * console.log(`Order status: ${order.status}`);
   * ```
   */
  async getOrderById(orderId: string): Promise<CreateOrderResponse> {
    this.logger.debug('Getting order by ID', { orderId });

    const response = await this.restClient.get<CreateOrderResponse>(`/order/${orderId}`);

    this.logger.debug('Order retrieved', {
      orderID: response.orderID,
      status: response.status,
    });

    return response;
  }

  /**
   * Получить исполненные ордера (используя endpoint /data/orders?status=MATCHED)
   *
   * @param tokenId - Необязательно: фильтр по идентификатору токена
   * @param limit - Максимальное количество ордеров для возврата (по умолчанию: 100)
   * @returns Массив исполненных ордеров (АГРЕГИРОВАННЫХ по ордеру!)
   * @throws {ApiError} При ошибке API-вызова
   *
   * @remarks
   * v7.7.11: ЗАПАСНОЙ метод когда /data/trades возвращает пустой результат.
   * Использует /data/orders с параметром status=MATCHED (как старый бот).
   *
   * ВАЖНО: Возвращает ОРДЕРА, а не отдельные СДЕЛКИ!
   * - Один ордер = одна строка (даже если исполнен несколькими сделками)
   * - size_matched = суммарный исполненный размер (сумма всех сделок)
   * - avg_price = средняя цена исполнения (НЕ лимитная цена!)
   *
   * @example
   * ```typescript
   * // Получить все исполненные ордера
   * const orders = await client.getMatchedOrders('0x123...', 100);
   * // orders[0].size_matched - суммарное исполнение
   * // orders[0].avg_price - средняя цена
   * ```
   */
  async getMatchedOrders(tokenId?: string, limit: number = 100): Promise<MatchedOrderResponse[]> {
    this.logger.debug('[PolymarketOrderRestClient] Getting matched orders from /data/orders', {
      tokenId: tokenId ? tokenId.substring(0, 16) + '...' : 'all',
      limit,
    });

    const params: Record<string, string> = {
      limit: limit.toString(),
      status: 'MATCHED', // Только исполненные ордера
    };

    if (tokenId) {
      params.asset_id = tokenId;
    }

    // Используем endpoint /data/orders (не /data/trades!)
    const response = await this.restClient.get<MatchedOrderResponse[]>('/data/orders', params);

    // API возвращает массив напрямую
    const orders = Array.isArray(response) ? response : [];

    this.logger.info('[PolymarketOrderRestClient] Matched orders from /data/orders retrieved', {
      count: orders.length,
      tokenIdFilter: tokenId ? tokenId.substring(0, 16) + '...' : 'all',
      limit,
    });

    return orders;
  }

  /**
   * Получить исполненные ордера (используя endpoint /data/trades с maker_address)
   *
   * @param tokenId - Необязательно: фильтр по идентификатору токена
   * @param makerAddress - MAKER-адрес (ФАНДЕР, НЕ ПОДПИСАНТ!)
   * @param limit - Максимальное количество сделок для возврата (по умолчанию: 100)
   * @returns Массив исполненных ордеров
   * @throws {ApiError} При ошибке API-вызова
   *
   * @remarks
   * v7.7.10: Использует /data/trades с параметром maker_address (как официальный @polymarket/clob-client)
   * КРИТИЧНО: Необходимо использовать MAKER-адрес (фандер), НЕ адрес ПОДПИСАНТА (proxy)!
   *
   * v7.7.11: ЗАПАСНОЙ ВАРИАНТ — если возвращает пустой результат, вызвать getMatchedOrders()!
   *
   * Подход официального CLOB-клиента:
   * ```typescript
   * getTrades({ maker_address: funderAddress, asset_id: tokenId })
   * ```
   *
   * @example
   * ```typescript
   * // Получить все исполнения для MAKER-адреса
   * const fills = await client.getFilledOrders('0x123...', '0xMAKER...', 100);
   * if (fills.length === 0) {
   *   // Запасной вариант: исполненные ордера
   *   const orders = await client.getMatchedOrders('0x123...', 100);
   * }
   * console.log(`Total fills: ${fills.length}`);
   * ```
   */
  async getFilledOrders(
    tokenId?: string,
    makerAddress?: string,
    limit: number = 100,
    options?: {
      onlyFirstPage?: boolean;
      includeAllTrades?: boolean;
    }
  ): Promise<TradeResponse[]> {
    // Параметры по умолчанию
    const onlyFirstPage = options?.onlyFirstPage ?? false;
    const includeAllTrades = options?.includeAllTrades ?? true;

    this.logger.debug('[PolymarketOrderRestClient] Getting fills from /data/trades', {
      tokenId: tokenId ? tokenId.substring(0, 16) + '...' : 'all',
      makerAddress: makerAddress ? makerAddress.substring(0, 10) + '...' : 'none',
      limit,
      onlyFirstPage,
      includeAllTrades,
    });

    // Постранично получаем результаты (опционально)
    let allTrades: TradeResponse[] = [];
    let nextCursor = 'MA=='; // Начальный курсор
    const END_CURSOR = 'LTE='; // Маркер конца результатов
    let pageCount = 0;

    while (nextCursor !== END_CURSOR) {
      const params: Record<string, string> = {
        limit: limit.toString(),
        next_cursor: nextCursor,
      };

      // КРИТИЧНО: Используем параметр maker_address!
      if (makerAddress) {
        params.maker_address = makerAddress;
      }

      if (tokenId) {
        params.asset_id = tokenId;
      }

      // Используем endpoint /data/trades (не /data/orders!)
      // API возвращает { data: [...], next_cursor: "..." }, НЕ массив напрямую!
      const response = await this.restClient.get<PaginatedTradesResponse>('/data/trades', params);

      // Извлекаем поле data из ответа (постраничный формат ответа)
      const trades = Array.isArray(response?.data) ? response.data : [];

      pageCount++;

      this.logger.debug('[PolymarketOrderRestClient] Page fetched', {
        page: pageCount,
        count: trades.length,
        nextCursor: response?.next_cursor || 'none',
      });

      allTrades = [...allTrades, ...trades];

      // Обновляем курсор для следующей итерации
      nextCursor = response?.next_cursor || END_CURSOR;

      // Защита: останавливаемся если нет данных
      if (trades.length === 0) {
        break;
      }

      // Останавливаемся после первой страницы если запрошено
      if (onlyFirstPage) {
        this.logger.debug('[PolymarketOrderRestClient] Stopping after first page');
        break;
      }
    }

    this.logger.info('[PolymarketOrderRestClient] Fills from /data/trades retrieved', {
      totalCount: allTrades.length,
      pages: pageCount,
      tokenIdFilter: tokenId ? tokenId.substring(0, 16) + '...' : 'all',
      makerAddress: makerAddress ? makerAddress.substring(0, 10) + '...' : 'none',
      limit,
      onlyFirstPage,
    });

    // Фильтруем сделки если нужно
    if (!includeAllTrades) {
      const beforeFilter = allTrades.length;

      // Фильтруем только сделки, где мы были MAKER
      allTrades = allTrades.filter((trade) => trade.trader_side === 'MAKER');

      this.logger.info('[PolymarketOrderRestClient] Filtered to MAKER trades only', {
        before: beforeFilter,
        after: allTrades.length,
        filtered: beforeFilter - allTrades.length,
      });
    }

    return allTrades;
  }
}
