/**
 * Polymarket REST Adapter Factory
 *
 * @remarks
 * Factory for creating fully configured PolymarketRestAdapter with all dependencies.
 *
 * This factory wires up:
 * - PolymarketRestClient (base HTTP client)
 * - 6 REST clients (Order, Balance, Positions, Orderbook, Trades, MarketData)
 * - 3 Mappers (Balance, Order, Position)
 * - 3 Providers (Balance, Positions, Orders)
 * - 2 Policies (MarketConstraints, Balance)
 * - 2 Adapters (Execution, Portfolio)
 * - 1 Facade (RestAdapter)
 *
 * @example
 * ```typescript
 * const config: PolymarketRestConfig = {
 *   baseUrl: 'https://clob.polymarket.com',
 *   privateKey: process.env.PRIVATE_KEY!,
 *   chainId: 137,
 * };
 *
 * const marketDataConfig = {
 *   baseUrl: 'https://gamma-api.polymarket.com',
 * };
 *
 * const adapter = PolymarketRestAdapterFactory.create(
 *   config,
 *   marketDataConfig,
 *   logger
 * );
 *
 * // Use adapter
 * const balance = await adapter.getBalance();
 * console.log(`Balance: ${balance} USDC`);
 * ```
 */

import type { ILogger } from '../../../domain/ports/ILogger.js';
import type { PolymarketRestConfig } from './types.js';
import type { MarketDataClientConfig } from './clients/PolymarketMarketDataRestClient.js';
import type { IEventBus } from '../../../shared/events/IEventBus.js';
import type { IPortfolioProjector } from '../../../domain/services/portfolio/PortfolioProjector.js';

import { PolymarketRestClient } from './PolymarketRestClient.js';
import { PolymarketDataApiClient } from './PolymarketDataApiClient.js';
import { PolymarketOrderRestClient } from './clients/PolymarketOrderRestClient.js';
import { PolymarketBalanceRestClient } from './clients/PolymarketBalanceRestClient.js';
import { PolymarketPositionsRestClient } from './clients/PolymarketPositionsRestClient.js';
import { PolymarketMarketDataRestClient } from './clients/PolymarketMarketDataRestClient.js';

import { PolymarketBalanceMapper } from './mappers/PolymarketBalanceMapper.js';
import { PolymarketOrderMapper } from './mappers/PolymarketOrderMapper.js';
import { PolymarketPositionMapper } from './mappers/PolymarketPositionMapper.js';
import { PolymarketOrderBuilder } from './auth/PolymarketOrderBuilder.js';

import { PolymarketBalanceProvider } from './providers/PolymarketBalanceProvider.js';
import { PolymarketPositionsProvider } from './providers/PolymarketPositionsProvider.js';
import { PolymarketOrdersProvider } from './providers/PolymarketOrdersProvider.js';

import { PolymarketMarketConstraintsPolicy } from './policies/PolymarketMarketConstraintsPolicy.js';
import { PolymarketBalancePolicy } from './policies/PolymarketBalancePolicy.js';

import { PolymarketExecutionAdapter } from './adapters/PolymarketExecutionAdapter.js';
import { PolymarketPortfolioAdapter } from './adapters/PolymarketPortfolioAdapter.js';
import { PolymarketRestAdapter } from './adapters/PolymarketRestAdapter.js';

/**
 * Polymarket REST Adapter Factory
 */
export class PolymarketRestAdapterFactory {
  /**
   * Create fully configured PolymarketRestAdapter
   *
   * @param config - REST client configuration
   * @param marketDataConfig - Market data client configuration
   * @param eventBus - EventBus for publishing ExecutionEvent
   * @param logger - Logger instance
   * @param simulationMode - Enable simulation mode (virtual balance/trades)
   * @param portfolioProjector - Optional PortfolioProjector for instant balance checks (v7.6)
   * @returns Configured PolymarketRestAdapter
   *
   * @remarks
   * ExecutionAdapter требует EventBus для публикации ExecutionEvent
   *
   * v7.6: PortfolioProjector enables zero-lag balance checks for SELL orders.
   * When provided, BalancePolicy uses event-sourced inventory instead of Balance API.
   *
   * @example
   * ```typescript
   * const config: PolymarketRestConfig = {
   *   baseUrl: 'https://clob.polymarket.com',
   *   privateKey: process.env.PRIVATE_KEY!,
   *   chainId: 137,
   * };
   *
   * const marketDataConfig = {
   *   baseUrl: 'https://gamma-api.polymarket.com',
   * };
   *
   * // Without PortfolioProjector (global adapter)
   * const adapter = PolymarketRestAdapterFactory.create(
   *   config,
   *   marketDataConfig,
   *   eventBus,
   *   logger
   * );
   *
   * // With PortfolioProjector (strategy-specific adapter)
   * const portfolioProjector = new PortfolioProjector('strategy-1');
   * const adapterWithProjector = PolymarketRestAdapterFactory.create(
   *   config,
   *   marketDataConfig,
   *   eventBus,
   *   logger,
   *   false,
   *   portfolioProjector
   * );
   * ```
   */
  static create(
    config: PolymarketRestConfig,
    marketDataConfig: MarketDataClientConfig,
    eventBus: IEventBus,
    logger: ILogger,
    simulationMode: boolean = false,
    portfolioProjector?: IPortfolioProjector
  ): PolymarketRestAdapter {
    // Base HTTP client
    const restClient = new PolymarketRestClient(config, logger);

    // Data API client (for positions endpoint)
    const dataApiClient = new PolymarketDataApiClient(
      { baseUrl: 'https://data-api.polymarket.com' },
      logger
    );

    // Order builder (for EIP-712 signed orders)
    const signer = restClient.getSigner();
    const makerAddress = config.funderAddress || signer.getAddress();
    const orderBuilder = new PolymarketOrderBuilder(
      signer.getWallet(),
      config.chainId,
      makerAddress,
      config.signatureType!
    );

    // REST clients
    const orderClient = new PolymarketOrderRestClient(restClient, orderBuilder, logger);
    const balanceClient = new PolymarketBalanceRestClient(restClient, logger);
    // ✅ CRITICAL: Use MAKER address (funder), NOT SIGNER address (proxy)
    // When using proxy wallet, positions belong to MAKER, not SIGNER
    const positionsClient = new PolymarketPositionsRestClient(
      dataApiClient,
      makerAddress, // Use MAKER/funder address (same address used for orders)
      logger
    );
    const marketDataClient = new PolymarketMarketDataRestClient(marketDataConfig, logger);

    // Mappers
    const balanceMapper = new PolymarketBalanceMapper(logger);
    const orderMapper = new PolymarketOrderMapper(logger);
    const positionMapper = new PolymarketPositionMapper();

    // Providers
    const balanceProvider = new PolymarketBalanceProvider(
      balanceClient,
      balanceMapper,
      logger,
      simulationMode
    );

    const positionsProvider = new PolymarketPositionsProvider(
      positionsClient,
      positionMapper,
      logger
    );

    // Orders provider - currently unused, but available for future use
    // @ts-expect-error - Temporarily unused until order querying is implemented
    const _ordersProvider = new PolymarketOrdersProvider(orderClient, orderMapper, logger);

    // Policies
    const constraintsPolicy = new PolymarketMarketConstraintsPolicy(
      marketDataClient,
      logger
    );

    // ✅ v7.6: Pass PortfolioProjector to BalancePolicy for instant balance checks
    const balancePolicy = new PolymarketBalancePolicy(
      balanceProvider,
      logger,
      portfolioProjector // undefined for global adapter, provided for strategy-specific adapter
    );

    // Adapters ( ExecutionAdapter теперь требует EventBus)
    const executionAdapter = new PolymarketExecutionAdapter(
      orderClient,
      orderMapper,
      eventBus,
      logger,
      undefined, // executionContext (use default)
      simulationMode
    );

    const portfolioAdapter = new PolymarketPortfolioAdapter(
      balanceProvider,
      positionsProvider,
      balancePolicy,
      constraintsPolicy,
      logger
    );

    // Facade
    const restAdapter = new PolymarketRestAdapter(
      executionAdapter,
      portfolioAdapter,
      constraintsPolicy,
      logger
    );

    logger.info('PolymarketRestAdapter created successfully', {
      baseUrl: config.baseUrl,
      address: restClient.getAddress(),
      chainId: restClient.getChainId(),
    });

    return restAdapter;
  }
}
