/**
 * Polymarket Official SDK REST Adapter (Placeholder)
 *
 * @remarks
 * **🚧 PLACEHOLDER IMPLEMENTATION 🚧**
 *
 * This adapter is a placeholder for integrating the official Polymarket SDK.
 * Currently throws "not implemented" errors for all operations.
 *
 * ## Purpose
 *
 * Provides a drop-in replacement for PolymarketRestAdapter that wraps
 * the official @polymarket/clob-client SDK instead of custom REST clients.
 *
 * ## Integration Steps
 *
 * To integrate the official SDK:
 *
 * 1. **Install official SDK**:
 *    ```bash
 *    npm install @polymarket/clob-client
 *    ```
 *
 * 2. **Import official client**:
 *    ```typescript
 *    import { ClobClient } from '@polymarket/clob-client';
 *    ```
 *
 * 3. **Initialize in constructor**:
 *    ```typescript
 *    constructor(config: OfficialSDKConfig, logger: ILogger) {
 *      this.clobClient = new ClobClient({
 *        host: config.baseUrl,
 *        chainId: config.chainId,
 *        privateKey: config.privateKey,
 *      });
 *      this.logger = logger;
 *    }
 *    ```
 *
 * 4. **Implement each method**:
 *    ```typescript
 *    async placeOrder(params: PlaceOrderParams): Promise<OrderResponse> {
 *      // Map params to official SDK format
 *      const sdkParams = {
 *        tokenID: params.tokenId,
 *        price: params.price.toString(),
 *        size: params.size.toString(),
 *        side: params.side.toLowerCase(),
 *      };
 *
 *      // Call official SDK
 *      const result = await this.clobClient.createOrder(sdkParams);
 *
 *      // Map result back to our format
 *      return {
 *        orderId: result.orderID,
 *        status: mapSDKStatus(result.status),
 *        ...
 *      };
 *    }
 *    ```
 *
 * 5. **Update providers.ts**:
 *    ```typescript
 *    // In exchangeAdapter registration
 *    if (env.REST_CLIENT_TYPE === 'official') {
 *      logger.info('[DI] Using official Polymarket SDK client');
 *      const sdkConfig = {
 *        baseUrl: env.POLYMARKET_API_URL,
 *        privateKey: env.PRIVATE_KEY,
 *        chainId: 137,
 *      };
 *      return new PolymarketOfficialRestAdapter(sdkConfig, logger);
 *    }
 *    ```
 *
 * 6. **Test integration**:
 *    ```bash
 *    REST_CLIENT_TYPE=official npm run test:smoke:rest
 *    ```
 *
 * ## Interface Compatibility
 *
 * This adapter implements the same public interface as PolymarketRestAdapter:
 * - placeOrder(params): Promise<OrderResponse>
 * - cancelOrder(orderId): Promise<void>
 * - getOpenOrders(tokenId?): Promise<OrderResponse[]>
 * - getBalance(): Promise<number>
 * - getOutcomeBalance(tokenId): Promise<number>
 * - getPositions(tokenId?): Promise<PositionResponse[]>
 * - approveUSDC(amount): Promise<void>
 * - clearConstraintsCache(tokenId?): void
 *
 * ## Mapping Strategy
 *
 * When implementing, you'll need to map between:
 * - Our domain types (Order, Price, Quantity, Side) ↔ SDK types
 * - Our error types (ValidationError, ApiError) ↔ SDK errors
 * - Our responses (OrderResponse, PositionResponse) ↔ SDK responses
 *
 * ## Error Handling
 *
 * Official SDK may throw different errors. Map them to our error types:
 * ```typescript
 * try {
 *   return await this.clobClient.createOrder(params);
 * } catch (error) {
 *   if (isSDKValidationError(error)) {
 *     throw new ValidationError(error.message);
 *   } else if (isSDKNetworkError(error)) {
 *     throw new ApiError(error.message, error.statusCode);
 *   }
 *   throw error;
 * }
 * ```
 *
 * ## Performance Considerations
 *
 * Official SDK may have different:
 * - Rate limiting behavior
 * - Retry strategies
 * - Connection pooling
 * - Caching mechanisms
 *
 * Benchmark and compare with custom implementation.
 *
 * ## References
 *
 * - Official SDK docs: https://github.com/Polymarket/clob-client
 * - API reference: https://docs.polymarket.com/
 * - Custom implementation: src/infrastructure/polymarket/rest/adapters/PolymarketRestAdapter.ts
 *
 * @example
 * ```typescript
 * // After implementation
 * const adapter = new PolymarketOfficialRestAdapter(
 *   {
 *     baseUrl: 'https://clob.polymarket.com',
 *     privateKey: process.env.PRIVATE_KEY!,
 *     chainId: 137,
 *   },
 *   logger
 * );
 *
 * const order = await adapter.placeOrder({
 *   tokenId: '0x123...',
 *   side: 'BUY',
 *   price: 0.52,
 *   size: 100,
 * });
 * ```
 */

import type { ILogger } from '../../../domain/ports/ILogger.js';
import type { PlaceOrderParams, OrderResponse } from '../../exchange/ports/IExecutionAdapter.js';
import type { PositionResponse } from '../../exchange/ports/IPortfolioAdapter.js';

/**
 * Configuration for official SDK client
 */
export interface OfficialSDKConfig {
  /**
   * CLOB API base URL
   * @example 'https://clob.polymarket.com'
   */
  baseUrl: string;

  /**
   * Private key for signing orders
   * @example '0x...'
   */
  privateKey: string;

  /**
   * Chain ID (Polygon mainnet = 137)
   */
  chainId: number;
}

/**
 * Polymarket Official SDK REST Adapter (Placeholder)
 *
 * @remarks
 * 🚧 NOT YET IMPLEMENTED - throws errors for all operations
 *
 * This is a placeholder for official SDK integration.
 * See class documentation for integration steps.
 */
export class PolymarketOfficialRestAdapter {
  private readonly logger: ILogger;

  /**
   * Create PolymarketOfficialRestAdapter
   *
   * @param config - Official SDK configuration
   * @param logger - Logger instance
   *
   * @remarks
   * Currently just stores logger. When implementing:
   * 1. Import official SDK: `import { ClobClient } from '@polymarket/clob-client'`
   * 2. Initialize client: `this.clobClient = new ClobClient(config)`
   * 3. Store reference: `private readonly clobClient: ClobClient`
   */
  constructor(_config: OfficialSDKConfig, logger: ILogger) {
    this.logger = logger;

    // TODO: Initialize official SDK client here
    // Example:
    // this.clobClient = new ClobClient({
    //   host: config.baseUrl,
    //   chainId: config.chainId,
    //   privateKey: config.privateKey,
    // });

    this.logger.warn('[PolymarketOfficialRestAdapter] Placeholder - not yet implemented');
  }

  /**
   * Place order
   *
   * @param params - Order parameters
   * @returns Order response
   * @throws {Error} Not implemented
   *
   * @remarks
   * **Implementation steps:**
   * 1. Map params to SDK format
   * 2. Call SDK's createOrder()
   * 3. Map result back to OrderResponse
   * 4. Handle SDK errors and map to our error types
   */
  async placeOrder(_params: PlaceOrderParams): Promise<OrderResponse> {
    throw new Error('PolymarketOfficialRestAdapter.placeOrder() not implemented - use REST_CLIENT_TYPE=custom');
  }

  /**
   * Cancel order
   *
   * @param orderId - Order ID to cancel
   * @throws {Error} Not implemented
   *
   * @remarks
   * **Implementation steps:**
   * 1. Call SDK's cancelOrder(orderId)
   * 2. Handle SDK errors
   */
  async cancelOrder(_orderId: string): Promise<void> {
    throw new Error('PolymarketOfficialRestAdapter.cancelOrder() not implemented - use REST_CLIENT_TYPE=custom');
  }

  /**
   * Get open orders
   *
   * @param tokenId - Optional: filter by token ID
   * @returns Array of open orders
   * @throws {Error} Not implemented
   *
   * @remarks
   * **Implementation steps:**
   * 1. Call SDK's getOrders() with filters
   * 2. Filter by status: OPEN
   * 3. Map results to OrderResponse[]
   */
  async getOpenOrders(_tokenId?: string): Promise<OrderResponse[]> {
    throw new Error('PolymarketOfficialRestAdapter.getOpenOrders() not implemented - use REST_CLIENT_TYPE=custom');
  }

  /**
   * Get balance
   *
   * @returns Available USDC balance
   * @throws {Error} Not implemented
   *
   * @remarks
   * **Implementation steps:**
   * 1. Call SDK's getBalance() or equivalent
   * 2. Extract USDC balance
   * 3. Return as number
   */
  async getBalance(): Promise<number> {
    throw new Error('PolymarketOfficialRestAdapter.getBalance() not implemented - use REST_CLIENT_TYPE=custom');
  }

  /**
   * Get outcome balance
   *
   * @param tokenId - Token ID
   * @returns Outcome token balance
   * @throws {Error} Not implemented
   *
   * @remarks
   * **Implementation steps:**
   * 1. Call SDK's getBalances() or equivalent
   * 2. Find token by tokenId
   * 3. Return balance as number
   */
  async getOutcomeBalance(_tokenId: string): Promise<number> {
    throw new Error('PolymarketOfficialRestAdapter.getOutcomeBalance() not implemented - use REST_CLIENT_TYPE=custom');
  }

  /**
   * Get positions
   *
   * @param tokenId - Optional: filter by token ID
   * @returns Array of positions
   * @throws {Error} Not implemented
   *
   * @remarks
   * **Implementation steps:**
   * 1. Call SDK's getPositions()
   * 2. Filter by tokenId if provided
   * 3. Map results to PositionResponse[]
   */
  async getPositions(_tokenId?: string): Promise<PositionResponse[]> {
    throw new Error('PolymarketOfficialRestAdapter.getPositions() not implemented - use REST_CLIENT_TYPE=custom');
  }

  /**
   * Approve USDC for trading
   *
   * @param amount - Amount to approve
   * @throws {Error} Not implemented
   *
   * @remarks
   * **Implementation steps:**
   * 1. Call SDK's approve() or equivalent
   * 2. Wait for blockchain confirmation
   * 3. Handle blockchain errors
   */
  async approveUSDC(_amount: number): Promise<void> {
    throw new Error('PolymarketOfficialRestAdapter.approveUSDC() not implemented - use REST_CLIENT_TYPE=custom');
  }

  /**
   * Clear constraints cache
   *
   * @param tokenId - Optional: clear specific token, or all if not specified
   *
   * @remarks
   * **Implementation note:**
   * Official SDK may not have constraints caching.
   * This method may be no-op or log warning.
   */
  clearConstraintsCache(_tokenId?: string): void {
    this.logger.debug('[PolymarketOfficialRestAdapter] clearConstraintsCache() - no-op in official SDK');
    // Official SDK may not cache constraints
    // This is a no-op unless SDK provides cache clearing
  }
}
