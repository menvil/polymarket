/**
 * Polymarket REST API - Public Exports
 *
 * @remarks
 * Main entry point for Polymarket REST implementation.
 *
 * @example
 * ```typescript
 * import {
 *   PolymarketRestAdapterFactory,
 *   PolymarketRestConfig,
 * } from '@infrastructure/polymarket/rest';
 *
 * const config: PolymarketRestConfig = {
 *   baseUrl: 'https://clob.polymarket.com',
 *   privateKey: process.env.PRIVATE_KEY!,
 *   chainId: 137,
 * };
 *
 * const adapter = PolymarketRestAdapterFactory.create(config, marketDataConfig, logger);
 * const balance = await adapter.getBalance();
 * ```
 */

// Типы
export type { PolymarketRestConfig, ApiErrorResponse } from './types.js';
export type { MarketDataClientConfig } from './clients/PolymarketMarketDataRestClient.js';

// Основные экспорты
export { PolymarketRestClient, ApiError } from './PolymarketRestClient.js';
export { PolymarketDataApiClient } from './PolymarketDataApiClient.js';
export { PolymarketRestAdapterFactory } from './PolymarketRestAdapterFactory.js';
export { PolymarketRestAdapter, ValidationError } from './adapters/PolymarketRestAdapter.js';

// Адаптеры
export { PolymarketExecutionAdapter } from './adapters/PolymarketExecutionAdapter.js';
export { PolymarketPortfolioAdapter } from './adapters/PolymarketPortfolioAdapter.js';

// Политики
export { PolymarketMarketConstraintsPolicy } from './policies/PolymarketMarketConstraintsPolicy.js';
export { PolymarketBalancePolicy } from './policies/PolymarketBalancePolicy.js';
export type { BalanceCheckParams, BalanceCheckResult } from './policies/PolymarketBalancePolicy.js';

// Провайдеры
export { PolymarketBalanceProvider } from './providers/PolymarketBalanceProvider.js';
export { PolymarketPositionsProvider } from './providers/PolymarketPositionsProvider.js';
export { PolymarketOrdersProvider } from './providers/PolymarketOrdersProvider.js';

// Клиенты
export { PolymarketOrderRestClient } from './clients/PolymarketOrderRestClient.js';
export { PolymarketBalanceRestClient } from './clients/PolymarketBalanceRestClient.js';
export { PolymarketPositionsRestClient } from './clients/PolymarketPositionsRestClient.js';
export { PolymarketOrderbookRestClient } from './clients/PolymarketOrderbookRestClient.js';
export { PolymarketTradesRestClient } from './clients/PolymarketTradesRestClient.js';
export { PolymarketUserTradesRestClient } from './clients/PolymarketUserTradesRestClient.js';
export { PolymarketMarketDataRestClient } from './clients/PolymarketMarketDataRestClient.js';

// Маппинги
export { PolymarketBalanceMapper } from './mappers/PolymarketBalanceMapper.js';
export { PolymarketOrderMapper } from './mappers/PolymarketOrderMapper.js';
export { PolymarketPositionMapper } from './mappers/PolymarketPositionMapper.js';

// Аутентификация
export { PolymarketSigner } from './auth/PolymarketSigner.js';
