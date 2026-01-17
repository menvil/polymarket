/**
 * Generic market data adapter interface
 *
 * @remarks
 * Market data adapter provides read-only access to public market data:
 * - Orderbook snapshots
 * - Market trades (NOT user trades - use IExecutionAdapter.getFillHistory for that)
 * - Market information (constraints, limits, etc.)
 *
 * **IMPORTANT**: This is PUBLIC data, NOT user-specific data.
 * For user positions/orders, use IPortfolioAdapter / IExecutionAdapter.
 *
 * **Use cases**:
 * - Get orderbook for trading decisions
 * - Get recent market trades
 * - Get market constraints (min/max size, tick size)
 * - Display market overview
 *
 * @example
 * ```typescript
 * const adapter = new PolymarketMarketDataAdapter(
 *   orderbookClient,
 *   tradesClient,
 *   marketDataClient,
 *   mapper,
 *   logger
 * );
 *
 * const orderbook = await adapter.getOrderbook('0x123');
 * console.log(`Best bid: ${orderbook.bids[0].price}`);
 *
 * const constraints = await adapter.getMarketConstraints('0x123');
 * console.log(`Min size: ${constraints.minOrderSize}`);
 * ```
 */

/**
 * Orderbook level (bid or ask)
 */
export interface OrderbookLevel {
  /** Price */
  price: number;

  /** Size at this price */
  size: number;
}

/**
 * Orderbook snapshot
 */
export interface OrderbookSnapshot {
  /** Token ID */
  tokenId: string;

  /** Bids (sorted descending by price) */
  bids: OrderbookLevel[];

  /** Asks (sorted ascending by price) */
  asks: OrderbookLevel[];

  /** Snapshot timestamp (ms) */
  timestamp: number;
}

/**
 * Market trade (NOT user trade)
 */
export interface MarketTrade {
  /** Trade ID */
  tradeId: string;

  /** Token ID */
  tokenId: string;

  /** Trade side (from taker perspective) */
  side: 'buy' | 'sell';

  /** Execution price */
  price: number;

  /** Trade size */
  size: number;

  /** Execution timestamp (ms) */
  timestamp: number;
}

/**
 * Market constraints
 */
export interface MarketConstraints {
  /** Minimum order size */
  minOrderSize: number;

  /** Maximum order size */
  maxOrderSize: number;

  /** Size tick (minimum size increment) */
  sizeTick: number;

  /** Price tick (minimum price increment) */
  priceTick: number;

  /** Minimum price */
  minPrice?: number;

  /** Maximum price */
  maxPrice?: number;
}

/**
 * Market information
 */
export interface MarketInfo {
  /** Token ID */
  tokenId: string;

  /** Market name/description */
  name: string;

  /** Market constraints */
  constraints: MarketConstraints;

  /** Market status */
  status: 'active' | 'inactive' | 'closed';

  /** Optional: expiration timestamp */
  expiresAt?: number;
}

/**
 * Generic market data adapter interface
 */
export interface IMarketDataAdapter {
  /**
   * Get orderbook snapshot
   *
   * @param tokenId - Token ID
   * @param depth - Optional: number of levels to return (default: all)
   * @returns Orderbook snapshot
   * @throws {ApiError} If API call fails
   *
   * @example
   * ```typescript
   * const orderbook = await adapter.getOrderbook('0x123');
   * console.log(`Best bid: ${orderbook.bids[0].price}`);
   * console.log(`Best ask: ${orderbook.asks[0].price}`);
   *
   * const top10 = await adapter.getOrderbook('0x123', 10);
   * console.log(`Top 10 levels: ${top10.bids.length} bids`);
   * ```
   */
  getOrderbook(tokenId: string, depth?: number): Promise<OrderbookSnapshot>;

  /**
   * Get recent market trades
   *
   * @param tokenId - Token ID
   * @param limit - Optional: max number of trades to return
   * @returns Array of market trades (sorted by timestamp descending)
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Returns PUBLIC market trades (NOT user-specific trades).
   * For user fill history, use IExecutionAdapter.getFillHistory().
   *
   * @example
   * ```typescript
   * const trades = await adapter.getMarketTrades('0x123', 100);
   * console.log(`Last 100 trades: ${trades.length}`);
   * console.log(`Last trade price: ${trades[0].price}`);
   * ```
   */
  getMarketTrades(tokenId: string, limit?: number): Promise<MarketTrade[]>;

  /**
   * Get market constraints
   *
   * @param tokenId - Token ID
   * @returns Market constraints
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Returns min/max sizes, tick sizes, etc.
   * Used by MarketConstraintsPolicy for normalization.
   *
   * @example
   * ```typescript
   * const constraints = await adapter.getMarketConstraints('0x123');
   * console.log(`Min size: ${constraints.minOrderSize}`);
   * console.log(`Size tick: ${constraints.sizeTick}`);
   * ```
   */
  getMarketConstraints(tokenId: string): Promise<MarketConstraints>;

  /**
   * Get market information
   *
   * @param tokenId - Token ID
   * @returns Market information
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Returns full market info including name, status, expiration, etc.
   *
   * @example
   * ```typescript
   * const info = await adapter.getMarketInfo('0x123');
   * console.log(`Market: ${info.name}`);
   * console.log(`Status: ${info.status}`);
   * ```
   */
  getMarketInfo(tokenId: string): Promise<MarketInfo>;

  /**
   * Get all active markets
   *
   * @returns Array of market information
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Optional method. Returns list of all active markets.
   */
  getActiveMarkets?(): Promise<MarketInfo[]>;
}
