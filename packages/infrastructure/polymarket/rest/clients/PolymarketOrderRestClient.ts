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

import type { ILogger } from '../../../../domain/ports/ILogger.js';
import type { PolymarketRestClient } from '../PolymarketRestClient.js';
import type { PolymarketOrderBuilder } from '../auth/PolymarketOrderBuilder.js';

/**
 * Create order request (simplified API format)
 */
export interface CreateOrderRequest {
  /** Token ID */
  tokenId: string;

  /** Order side */
  side: 'BUY' | 'SELL';

  /** Price (number: 0-1) */
  price: number;

  /** Size (number of shares) */
  size: number;

  /** Fee rate in basis points (default: 0) */
  feeRateBps?: number;

  /** Nonce for replay protection */
  nonce: number;

  /** Price tick size for rounding (optional, defaults to 0.01) */
  priceTick?: number;
}

/**
 * Create order response (raw API format)
 */
export interface CreateOrderResponse {
  /** Success flag */
  success: boolean;

  /** Error message (empty if success) */
  errorMsg: string;

  /** Order ID (Capital D!) */
  orderID: string;

  /** Order status */
  status: 'pending' | 'live' | 'filled' | 'cancelled';

  /** Taking amount */
  takingAmount: string;

  /** Making amount */
  makingAmount: string;

  /** Token ID (optional, not always present) */
  tokenId?: string;

  /** Order side (optional, not always present) */
  side?: 'BUY' | 'SELL';

  /** Price (optional, not always present) */
  price?: string;

  /** Size (optional, not always present) */
  size?: string;

  /** Filled size (optional, not always present) */
  filledSize?: string;

  /** Timestamp (optional, not always present) */
  timestamp?: number;
}

/**
 * Cancel order request
 */
export interface CancelOrderRequest {
  /** Order ID to cancel */
  orderId: string;

  /** Timestamp */
  timestamp: number;
}

/**
 * Cancel order response
 */
export interface CancelOrderResponse {
  /** Success flag */
  success: boolean;

  /** Order ID */
  orderId: string;

  /** Status after cancellation */
  status: 'CANCELLED';
}

/**
 * Get orders response
 */
export interface GetOrdersResponse {
  /** Array of orders */
  orders: CreateOrderResponse[];
}

/**
 * Polymarket Order REST Client
 */
export class PolymarketOrderRestClient {
  constructor(
    private readonly restClient: PolymarketRestClient,
    private readonly orderBuilder: PolymarketOrderBuilder,
    private readonly logger: ILogger,
    private readonly makerAddress?: string // ✅ v7.7.10: MAKER address for /data/trades
  ) {}

  /**
   * Get MAKER address (funder address, NOT signer address!)
   *
   * @returns MAKER address
   *
   * @remarks
   * v7.7.10: Used for /data/trades endpoint to fetch user's fills.
   * CRITICAL: This is FUNDER address (proxy wallet), NOT SIGNER address!
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

    // IMPORTANT: Pass nonce=0 for API auto-assignment
    // API will automatically assign the correct nonce for the exchange
    const exchangeNonce = 0;

    this.logger.debug('Using nonce for order', { exchangeNonce });

    // Build EIP-712 signed order
    const signedOrder = await this.orderBuilder.buildOrder({
      tokenId: request.tokenId,
      side: request.side,
      price: request.price,
      size: request.size,
      feeRateBps: request.feeRateBps ?? 0,
      nonce: exchangeNonce,
      expiration: 0, // No expiration
      priceTick: request.priceTick, // Pass price tick for rounding
    });

    this.logger.debug('Order signed', {
      salt: signedOrder.salt,
      maker: signedOrder.maker,
      signer: signedOrder.signer,
      makerAmount: signedOrder.makerAmount,
      takerAmount: signedOrder.takerAmount,
    });

    // Send order to API (POST /order expects specific format)
    // CRITICAL: owner MUST be the API KEY string (UUID), NOT a wallet address!
    // SDK reference: orderToJson(order, this.creds?.key, orderType, deferExec)
    const response = await this.restClient.post<CreateOrderResponse>(
      '/order',
      {
        order: signedOrder,
        owner: this.restClient.getApiKey(), // API key string (UUID)
        orderType: 'GTC', // Good Till Cancel
      },
      { requireSignature: false } // Order is already signed with EIP-712
    );

    this.logger.info('Order created successfully', {
      orderID: response.orderID,
      status: response.status,
      success: response.success,
    });

    this.logger.info('📤 POST /order FULL RESPONSE', {
      response: JSON.stringify(response, null, 2),
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

    // ✅ CRITICAL FIX: DO NOT filter by signature_type!
    // signature_type filters by SIGNER address, not MAKER address
    // When using proxy wallet (signature_type=1), orders are created with MAKER=funder address
    // But signature_type=1 filter returns orders for SIGNER address (proxy)
    // Result: bot cannot see its own orders!
    // Solution: Remove signature_type filter to get ALL orders for this account
    const params: Record<string, string> = {};

    if (tokenId) {
      params.asset_id = tokenId; // Use 'asset_id' parameter, not 'tokenId'
    }

    // CRITICAL: Use /data/orders endpoint (not /orders - that returns HTTP 405)
    const response = await this.restClient.get<CreateOrderResponse[]>('/data/orders', params);

    // API returns array directly, not { orders: [...] } format
    const orders = Array.isArray(response) ? response : [];

    this.logger.info('📥 GET /data/orders RESPONSE', {
      count: orders.length,
      tokenIdFilter: tokenId || 'none',
      orders: orders.length > 0 ? JSON.stringify(orders, null, 2) : 'NO ORDERS',
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
  async getMatchedOrders(tokenId?: string, limit: number = 100): Promise<any[]> {
    this.logger.debug('[PolymarketOrderRestClient] v7.7.11: Getting matched orders from /data/orders', {
      tokenId: tokenId ? tokenId.substring(0, 16) + '...' : 'all',
      limit,
    });

    const params: Record<string, string> = {
      limit: limit.toString(),
      status: 'MATCHED', // ✅ Only filled orders
    };

    if (tokenId) {
      params.asset_id = tokenId;
    }

    // Use /data/orders endpoint (not /data/trades!)
    const response = await this.restClient.get<any[]>('/data/orders', params);

    // API returns array directly
    const orders = Array.isArray(response) ? response : [];

    this.logger.info('[PolymarketOrderRestClient] 📊 v7.7.11: Matched orders from /data/orders retrieved', {
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
  ): Promise<any[]> {
    // Default options
    const onlyFirstPage = options?.onlyFirstPage ?? false;
    const includeAllTrades = options?.includeAllTrades ?? true;

    this.logger.debug('[PolymarketOrderRestClient] v7.7.12: Getting fills from /data/trades', {
      tokenId: tokenId ? tokenId.substring(0, 16) + '...' : 'all',
      makerAddress: makerAddress ? makerAddress.substring(0, 10) + '...' : 'none',
      limit,
      onlyFirstPage,
      includeAllTrades,
    });

    // ✅ v7.7.12: Paginate through results (optional)
    let allTrades: any[] = [];
    let nextCursor = 'MA=='; // Initial cursor
    const END_CURSOR = 'LTE='; // End marker
    let pageCount = 0;

    while (nextCursor !== END_CURSOR) {
      const params: Record<string, string> = {
        limit: limit.toString(),
        next_cursor: nextCursor,
      };

      // ✅ v7.7.10: CRITICAL - Use maker_address parameter!
      if (makerAddress) {
        params.maker_address = makerAddress;
      }

      if (tokenId) {
        params.asset_id = tokenId;
      }

      // ✅ v7.7.10: Use /data/trades endpoint (not /data/orders!)
      // ✅ v7.7.11: API returns { data: [...], next_cursor: "..." }, NOT array directly!
      const response = await this.restClient.get<any>('/data/trades', params);

      // ✅ v7.7.11: Extract data field from response (paginated response format)
      const trades = Array.isArray(response?.data) ? response.data : [];

      pageCount++;

      this.logger.debug('[PolymarketOrderRestClient] v7.7.12: Page fetched', {
        page: pageCount,
        count: trades.length,
        nextCursor: response?.next_cursor || 'none',
      });

      allTrades = [...allTrades, ...trades];

      // Update cursor for next iteration
      nextCursor = response?.next_cursor || END_CURSOR;

      // Safety: stop if no more data
      if (trades.length === 0) {
        break;
      }

      // ✅ v7.7.12: Stop after first page if requested
      if (onlyFirstPage) {
        this.logger.debug('[PolymarketOrderRestClient] v7.7.12: Stopping after first page');
        break;
      }
    }

    this.logger.info('[PolymarketOrderRestClient] 📊 v7.7.12: Fills from /data/trades retrieved', {
      totalCount: allTrades.length,
      pages: pageCount,
      tokenIdFilter: tokenId ? tokenId.substring(0, 16) + '...' : 'all',
      makerAddress: makerAddress ? makerAddress.substring(0, 10) + '...' : 'none',
      limit,
      onlyFirstPage,
    });

    // ✅ v7.7.12: Filter trades if needed
    if (!includeAllTrades) {
      const beforeFilter = allTrades.length;

      // Filter to only trades where we were MAKER
      allTrades = allTrades.filter((trade) => trade.trader_side === 'MAKER');

      this.logger.info('[PolymarketOrderRestClient] 📊 v7.7.12: Filtered to MAKER trades only', {
        before: beforeFilter,
        after: allTrades.length,
        filtered: beforeFilter - allTrades.length,
      });
    }

    return allTrades;
  }
}
