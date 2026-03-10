/**
 * Polymarket Order REST Client
 *
 * @remarks
 * Handles /order and /orders endpoints:
 * - POST /order - Place new order
 * - DELETE /order - Cancel order
 * - GET /orders - Get open orders
 *
 * Returns RAW API responses (NOT normalized).
 * Normalization is done by mappers in higher layers.
 *
 * @example
 * ```typescript
 * const client = new PolymarketOrderRestClient(restClient, logger);
 *
 * // Place order
 * const order = await client.createOrder({
 *   tokenId: '0x123',
 *   side: 'BUY',
 *   price: '0.52',
 *   size: '100',
 *   nonce: Date.now(),
 * });
 *
 * // Cancel order
 * await client.cancelOrder('order-123');
 *
 * // Get open orders
 * const orders = await client.getOpenOrders('0x123');
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { PolymarketRestClient } from '../PolymarketRestClient.js';
import type { PolymarketOrderBuilder } from '../auth/PolymarketOrderBuilder.js';

/**
 * Create order request (simplified API format)
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

  /** Ставка комиссии в базисных пунктах (по умолчанию: 0) */
  feeRateBps?: number;

  /** Nonce для защиты от повторного воспроизведения */
  nonce: number;

  /** Шаг цены для округления (необязательно, по умолчанию: 0.01) */
  priceTick?: number;
}

/**
 * Create order response (raw API format)
 */
export interface CreateOrderResponse {
  /** Флаг успеха */
  success: boolean;

  /** Сообщение об ошибке (пустое при успехе) */
  errorMsg: string;

  /** Идентификатор ордера (с заглавной D!) */
  orderID: string;

  /** Статус ордера */
  status: 'pending' | 'live' | 'filled' | 'cancelled';

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
 * Cancel order request
 */
export interface CancelOrderRequest {
  /** Идентификатор ордера для отмены */
  orderId: string;

  /** Временная метка */
  timestamp: number;
}

/**
 * Cancel order response
 */
export interface CancelOrderResponse {
  /** Флаг успеха */
  success: boolean;

  /** Идентификатор ордера */
  orderId: string;

  /** Статус после отмены */
  status: 'CANCELLED';
}

/**
 * Get orders response
 */
export interface GetOrdersResponse {
  /** Массив ордеров */
  orders: CreateOrderResponse[];
}

/**
 * Matched order response (from /data/orders?status=MATCHED)
 *
 * @remarks
 * Represents an aggregated filled order.
 * One row = one order (even if filled by multiple trades).
 * size_matched = total filled size; avg_price = average execution price.
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
 * Trade response (from /data/trades, paginated)
 *
 * @remarks
 * Represents a single on-chain trade execution.
 * Returned in paginated format: { data: TradeResponse[], next_cursor: string }.
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
}

/**
 * Paginated trades response envelope from /data/trades
 */
export interface PaginatedTradesResponse {
  /** Массив сделок текущей страницы */
  data: TradeResponse[];
  /** Курсор для следующей страницы (LTE= означает конец результатов) */
  next_cursor: string;
}

/**
 * Polymarket Order REST Client
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
   * Place new order
   *
   * @param request - Order request
   * @returns Raw order response
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Returns raw API response. Normalization should be done by mapper.
   *
   * @example
   * ```typescript
   * const order = await client.createOrder({
   *   tokenId: '0x123',
   *   side: 'BUY',
   *   price: 0.52,
   *   size: 100,
   *   nonce: Date.now(),
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

    // ВАЖНО: Передаём nonce=0 для автоматического назначения API
    // API автоматически назначит корректный nonce для биржи
    const exchangeNonce = 0;

    this.logger.debug('Using nonce for order', { exchangeNonce });

    // Строим EIP-712 подписанный ордер
    const signedOrder = await this.orderBuilder.buildOrder({
      tokenId: request.tokenId,
      side: request.side,
      price: request.price,
      size: request.size,
      feeRateBps: request.feeRateBps ?? 0,
      nonce: exchangeNonce,
      expiration: 0, // Без истечения
      priceTick: request.priceTick, // Передаём шаг цены для округления
    });

    this.logger.debug('Order signed', {
      salt: signedOrder.salt,
      maker: signedOrder.maker,
      signer: signedOrder.signer,
      makerAmount: signedOrder.makerAmount,
      takerAmount: signedOrder.takerAmount,
    });

    // Отправляем ордер в API (POST /order ожидает конкретный формат)
    // КРИТИЧНО: owner ДОЛЖЕН быть строкой API KEY (UUID), НЕ адресом кошелька!
    // Референс SDK: orderToJson(order, this.creds?.key, orderType, deferExec)
    const response = await this.restClient.post<CreateOrderResponse>(
      '/order',
      {
        order: signedOrder,
        owner: this.restClient.getApiKey(), // Строка API ключа (UUID)
        orderType: 'GTC', // Good Till Cancel
      },
      { requireSignature: false } // Ордер уже подписан через EIP-712
    );

    this.logger.info('Order created successfully', {
      orderID: response.orderID,
      status: response.status,
      success: response.success,
      errorMsg: response.errorMsg || undefined,
    });

    return response;
  }

  /**
   * Cancel order
   *
   * @param orderId - Order ID to cancel
   * @returns Cancel response
   * @throws {ApiError} If API call fails
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
      orderId,
      timestamp: Date.now(),
    });

    this.logger.info('Order cancelled successfully', { orderId });

    return response;
  }

  /**
   * Get open orders
   *
   * @param tokenId - Optional: filter by token ID
   * @returns Array of open orders
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Returns only PENDING and LIVE orders.
   * FILLED and CANCELLED orders are excluded.
   *
   * @example
   * ```typescript
   * // All open orders
   * const allOrders = await client.getOpenOrders();
   *
   * // Orders for specific token
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
   * Get order by ID
   *
   * @param orderId - Order ID
   * @returns Order response
   * @throws {ApiError} If API call fails or order not found
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
   * Get matched orders (using /data/orders?status=MATCHED endpoint)
   *
   * @param tokenId - Optional: filter by token ID
   * @param limit - Maximum number of orders to return (default: 100)
   * @returns Array of matched orders (AGGREGATED per order!)
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * v7.7.11: FALLBACK method when /data/trades returns empty.
   * Uses /data/orders with status=MATCHED parameter (like old bot).
   *
   * IMPORTANT: Returns ORDERS, not individual TRADES!
   * - One order = one row (even if filled by multiple trades)
   * - size_matched = total filled size (sum of all trades)
   * - avg_price = average execution price (NOT limit price!)
   *
   * @example
   * ```typescript
   * // Get all matched orders
   * const orders = await client.getMatchedOrders('0x123...', 100);
   * // orders[0].size_matched - total filled
   * // orders[0].avg_price - average price
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
   * Get filled orders (using /data/trades endpoint with maker_address)
   *
   * @param tokenId - Optional: filter by token ID
   * @param makerAddress - MAKER address (FUNDER, NOT SIGNER!)
   * @param limit - Maximum number of trades to return (default: 100)
   * @returns Array of filled orders
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * v7.7.10: Uses /data/trades with maker_address parameter (like official @polymarket/clob-client)
   * CRITICAL: Must use MAKER address (funder), NOT SIGNER address (proxy)!
   *
   * v7.7.11: FALLBACK - if this returns empty, call getMatchedOrders() instead!
   *
   * Official CLOB client approach:
   * ```typescript
   * getTrades({ maker_address: funderAddress, asset_id: tokenId })
   * ```
   *
   * @example
   * ```typescript
   * // Get all fills for MAKER address
   * const fills = await client.getFilledOrders('0x123...', '0xMAKER...', 100);
   * if (fills.length === 0) {
   *   // Fallback to matched orders
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
