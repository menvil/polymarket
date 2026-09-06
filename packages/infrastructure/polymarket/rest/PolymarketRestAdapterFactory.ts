/**
 * Polymarket REST Adapter Factory
 *
 * @remarks
 * Фабрика для создания полностью сконфигурированного PolymarketRestAdapter со всеми зависимостями.
 *
 * Фабрика собирает:
 * - PolymarketRestClient (базовый HTTP-клиент)
 * - 6 REST-клиентов (Order, Balance, Positions, Orderbook, Trades, MarketData)
 * - 3 маппера (Balance, Order, Position)
 * - 2 провайдера (Balance, Positions)
 * - 2 политики (MarketConstraints, Balance)
 * - 2 адаптера (Execution, Portfolio)
 * - 1 фасад (RestAdapter)
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
 * // Используем адаптер
 * const balance = await adapter.getBalance();
 * console.log(`Balance: ${balance} USDC`);
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { PolymarketRestConfig } from './types.js';
import type { MarketDataClientConfig } from './clients/PolymarketMarketDataRestClient.js';
import type { IEventBus } from '../ports/IEventBus.js';
import type { IPortfolioProjector } from '../ports/IPortfolioProjector.js';
import type { DnsOverride } from '../dns/index.js';

import { PolymarketRestClient } from './PolymarketRestClient.js';
import { PolymarketDataApiClient } from './PolymarketDataApiClient.js';
import { PolymarketOrderRestClient } from './clients/PolymarketOrderRestClient.js';
import { PolymarketOrderbookRestClient } from './clients/PolymarketOrderbookRestClient.js';
import { PolymarketBalanceRestClient } from './clients/PolymarketBalanceRestClient.js';
import { PolymarketPositionsRestClient } from './clients/PolymarketPositionsRestClient.js';
import { PolymarketMarketDataRestClient } from './clients/PolymarketMarketDataRestClient.js';

import { PolymarketBalanceMapper } from './mappers/PolymarketBalanceMapper.js';
import { PolymarketOrderMapper } from './mappers/PolymarketOrderMapper.js';
import { PolymarketPositionMapper } from './mappers/PolymarketPositionMapper.js';
import { PolymarketOrderBuilder } from './auth/PolymarketOrderBuilder.js';

import { PolymarketBalanceProvider } from './providers/PolymarketBalanceProvider.js';
import { PolymarketPositionsProvider } from './providers/PolymarketPositionsProvider.js';

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
   * Создаёт полностью сконфигурированный PolymarketRestAdapter
   *
   * @param config - Конфигурация REST-клиента
   * @param marketDataConfig - Конфигурация клиента рыночных данных
   * @param eventBus - EventBus для публикации ExecutionEvent
   * @param logger - Экземпляр логгера
   * @param simulationMode - Включить режим симуляции (виртуальный баланс/сделки)
   * @param portfolioProjector - Опциональный PortfolioProjector для мгновенных проверок баланса
   * @param dnsOverride - Опциональный DnsOverride для обхода DNS-блокировок
   * @returns Сконфигурированный PolymarketRestAdapter
   *
   * @remarks
   * ExecutionAdapter требует EventBus для публикации ExecutionEvent
   *
   * PortfolioProjector позволяет проводить проверки баланса без задержки для SELL ордеров.
   * Если передан, BalancePolicy использует event-sourced инвентарь вместо Balance API.
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
   * // Без PortfolioProjector (глобальный адаптер)
   * const adapter = PolymarketRestAdapterFactory.create(
   *   config,
   *   marketDataConfig,
   *   eventBus,
   *   logger
   * );
   *
   * // С PortfolioProjector (адаптер для конкретной стратегии)
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
    portfolioProjector?: IPortfolioProjector,
    dnsOverride?: DnsOverride,
  ): PolymarketRestAdapter {
    // Базовый HTTP клиент
    const restClient = new PolymarketRestClient(config, logger, dnsOverride);

    // Data API клиент (для endpoint позиций)
    const dataApiClient = new PolymarketDataApiClient(
      { baseUrl: 'https://data-api.polymarket.com' },
      logger
    );

    // Построитель ордеров (для EIP-712 подписанных ордеров)
    const signer = restClient.getSigner();
    const makerAddress = config.funderAddress || signer.getAddress();
    const orderBuilder = new PolymarketOrderBuilder(
      signer.getWallet(),
      config.chainId,
      makerAddress,
      config.signatureType!,
      logger,
      config.builderCode,
    );

    // REST клиенты
    const orderClient = new PolymarketOrderRestClient(restClient, orderBuilder, logger);
    const orderbookClient = new PolymarketOrderbookRestClient(restClient, logger);
    const balanceClient = new PolymarketBalanceRestClient(restClient, logger);
    // КРИТИЧНО: Используем адрес MAKER (funder), НЕ адрес SIGNER (proxy)
    // При использовании proxy-кошелька позиции принадлежат MAKER, не SIGNER
    const positionsClient = new PolymarketPositionsRestClient(
      dataApiClient,
      makerAddress, // Используем адрес MAKER/funder (тот же, что используется для ордеров)
      logger
    );
    const marketDataClient = new PolymarketMarketDataRestClient(marketDataConfig, logger);

    // Маппинги
    const balanceMapper = new PolymarketBalanceMapper(logger);
    const orderMapper = new PolymarketOrderMapper(logger);
    const positionMapper = new PolymarketPositionMapper();

    // Провайдеры
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

    // Политики
    const constraintsPolicy = new PolymarketMarketConstraintsPolicy(
      marketDataClient,
      logger,
    );

    // Передаём PortfolioProjector в BalancePolicy для мгновенных проверок баланса
    const balancePolicy = new PolymarketBalancePolicy(
      balanceProvider,
      logger,
      portfolioProjector // undefined для глобального адаптера, передаётся для стратегий
    );

    // Адаптеры (ExecutionAdapter теперь требует EventBus)
    const executionAdapter = new PolymarketExecutionAdapter(
      orderClient,
      orderbookClient,
      orderMapper,
      eventBus,
      logger,
      undefined, // executionContext (используем дефолтный)
      simulationMode
    );

    const portfolioAdapter = new PolymarketPortfolioAdapter(
      balanceProvider,
      positionsProvider,
      balancePolicy,
      constraintsPolicy,
      logger
    );

    // Фасад
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
