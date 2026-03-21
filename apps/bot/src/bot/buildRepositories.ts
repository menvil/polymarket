/**
 * Построитель in-memory репозиториев и store'ов.
 *
 * @remarks
 * Создаёт три хранилища состояния, используемые use cases:
 * - `InMemoryOrderRepository` — хранит ордера, реализует `IOrderRepository` и `IOrderStateStore`
 * - `InMemoryPortfolioStore` — хранит портфели по accountId
 * - `InMemoryProcessedFillRepository` — дедупликация fills (идемпотентность)
 *
 * В paper/backtest режиме используются именно эти реализации.
 * В live режиме заменяются на реальные (Redis, PostgreSQL и т.д.).
 *
 * @example
 * ```typescript
 * const repos = buildRepositories();
 * placeOrderUseCase = new PlaceOrderUseCase({ orderRepo: repos.orderRepo, ... });
 * ```
 */

import {
  InMemoryOrderRepository,
  InMemoryPortfolioStore,
  InMemoryProcessedFillRepository,
} from '@polymarket/in-memory';

/** Результат построения репозиториев */
export interface Repositories {
  readonly orderRepo: InMemoryOrderRepository;
  readonly portfolioStore: InMemoryPortfolioStore;
  readonly processedFillRepo: InMemoryProcessedFillRepository;
}

/**
 * Создаёт in-memory репозитории для хранения состояния бота.
 *
 * @returns Объект с orderRepo, portfolioStore, processedFillRepo
 *
 * @example
 * ```typescript
 * const { orderRepo, portfolioStore, processedFillRepo } = buildRepositories();
 * ```
 */
export function buildRepositories(): Repositories {
  return {
    orderRepo: new InMemoryOrderRepository(),
    portfolioStore: new InMemoryPortfolioStore(),
    processedFillRepo: new InMemoryProcessedFillRepository(),
  };
}
