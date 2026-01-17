/**
 * Фабрика Polymarket REST Adapter
 *
 * @remarks
 * Фабрика для создания полностью сконфигурированного PolymarketRestAdapter со всеми зависимостями.
 *
 * Эта фабрика связывает:
 * - PolymarketRestClient (базовый HTTP-клиент)
 * - 6 REST клиентов (Order, Balance, Positions, Orderbook, Trades, MarketData)
 * - 3 маппера (Balance, Order, Position)
 * - 3 провайдера (Balance, Positions, Orders)
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
 * // Использование адаптера
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
 * Фабрика Polymarket REST Adapter
 */
export class PolymarketRestAdapterFactory {
  /**
   * Создать полностью сконфигурированный PolymarketRestAdapter
   *
   * @param config - Конфигурация REST клиента
   * @param marketDataConfig - Конфигурация клиента рыночных данных
   * @param eventBus - EventBus для публикации ExecutionEvent
   * @param logger - Экземпляр логгера
   * @param simulationMode - Включить режим симуляции (виртуальный баланс/сделки)
   * @param portfolioProjector - Опциональный PortfolioProjector для мгновенных проверок баланса (v7.6)
   * @returns Сконфигурированный PolymarketRestAdapter
   *
   * @remarks
   * ExecutionAdapter требует EventBus для публикации ExecutionEvent
   *
   * v7.6: PortfolioProjector позволяет проверять баланс без задержки для SELL ордеров.
   * Когда предоставлен, BalancePolicy использует инвентарь из событий вместо Balance API.
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
    portfolioProjector?: IPortfolioProjector
  ): PolymarketRestAdapter {
    // Базовый HTTP клиент
    const restClient = new PolymarketRestClient(config, logger);

    // Клиент Data API (для эндпоинта positions)
    const dataApiClient = new PolymarketDataApiClient(
      { baseUrl: 'https://data-api.polymarket.com' },
      logger
    );

    // Построитель ордеров (для подписанных EIP-712 ордеров)
    const signer = restClient.getSigner();
    const makerAddress = config.funderAddress || signer.getAddress();
    const orderBuilder = new PolymarketOrderBuilder(
      signer.getWallet(),
      config.chainId,
      makerAddress,
      config.signatureType!
    );

    // REST клиенты
    const orderClient = new PolymarketOrderRestClient(restClient, orderBuilder, logger);
    const balanceClient = new PolymarketBalanceRestClient(restClient, logger);
    // ✅ КРИТИЧНО: Используйте адрес МЕЙКЕРА (спонсора), НЕ адрес ПОДПИСАНТА (прокси)
    // При использовании прокси-кошелька позиции принадлежат МЕЙКЕРУ, не ПОДПИСАНТУ
    const positionsClient = new PolymarketPositionsRestClient(
      dataApiClient,
      makerAddress, // Использовать адрес МЕЙКЕРА/спонсора (тот же адрес, что используется для ордеров)
      logger
    );
    const marketDataClient = new PolymarketMarketDataRestClient(marketDataConfig, logger);

    // Мапперы
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

    // Провайдер ордеров - в настоящее время не используется, но доступен для будущего использования
    // @ts-expect-error - Временно не используется, пока не реализован запрос ордеров
    const _ordersProvider = new PolymarketOrdersProvider(orderClient, orderMapper, logger);

    // Политики
    const constraintsPolicy = new PolymarketMarketConstraintsPolicy(
      marketDataClient,
      logger
    );

    // ✅ v7.6: Передать PortfolioProjector в BalancePolicy для мгновенных проверок баланса
    const balancePolicy = new PolymarketBalancePolicy(
      balanceProvider,
      logger,
      portfolioProjector // undefined для глобального адаптера, предоставлен для адаптера конкретной стратегии
    );

    // Адаптеры (ExecutionAdapter теперь требует EventBus)
    const executionAdapter = new PolymarketExecutionAdapter(
      orderClient,
      orderMapper,
      eventBus,
      logger,
      undefined, // executionContext (использовать значение по умолчанию)
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
