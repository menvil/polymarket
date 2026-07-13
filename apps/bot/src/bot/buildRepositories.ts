/**
 * Построитель in-memory репозиториев и store'ов.
 *
 * @remarks
 * Создаёт хранилища состояния, используемые use cases:
 * - `InMemoryOrderRepository` — хранит ордера, реализует `IOrderRepository` и `IOrderStateStore`
 * - `InMemoryPortfolioStore` — хранит портфели по accountId
 * - `InMemoryProcessedFillRepository` — идемпотентность fills (state machine)
 * - `InMemoryReconciliationIssueRepository` — queryable хранилище reconciliation
 *   issues (SUBMIT_UNKNOWN_OUTCOME, ORDER_PORTFOLIO_DESYNC и т.д.)
 * - `InMemoryKeyedMutex` — сериализация ProcessFillUseCase/CancelOrderUseCase
 *   по [accountId, orderId, instrumentId]
 *
 * В paper/backtest режиме используются именно эти реализации.
 * В live режиме заменяются на реальные (Redis, PostgreSQL и т.д.).
 *
 * @example
 * ```typescript
 * const repos = buildRepositories();
 * placeOrderUseCase = new PlaceOrderUseCase({
 *   orderRepo: repos.orderRepo,
 *   reconciliationIssues: repos.reconciliationIssueRepo,
 *   ...
 * });
 * ```
 */

import {
  InMemoryOrderRepository,
  InMemoryPortfolioStore,
  InMemoryProcessedFillRepository,
  InMemoryReconciliationIssueRepository,
  InMemoryKeyedMutex,
} from '@polymarket/in-memory';
import type { IMarketCatalog, IKeyedMutex } from '@polymarket/ports';

/** Результат построения репозиториев */
export interface Repositories {
  readonly orderRepo: InMemoryOrderRepository;
  readonly portfolioStore: InMemoryPortfolioStore;
  readonly processedFillRepo: InMemoryProcessedFillRepository;
  readonly reconciliationIssueRepo: InMemoryReconciliationIssueRepository;
  readonly keyedMutex: IKeyedMutex;
}

/**
 * Создаёт in-memory репозитории для хранения состояния бота.
 *
 * @param marketCatalog - Каталог инструментов (опционально). Если передан,
 * `orderRepo.getByMarketId()` резолвит РЕАЛЬНЫЙ marketId → instrumentId через
 * каталог вместо legacy-фолбэка на конвенцию `strategyId == String(marketId)`.
 * Вызывающий код должен строить `marketCatalog` (через `buildMarketData()`)
 * ДО вызова `buildRepositories()`, чтобы прокинуть его сюда.
 * @returns Объект с orderRepo, portfolioStore, processedFillRepo,
 * reconciliationIssueRepo, keyedMutex
 *
 * @example
 * ```typescript
 * const { marketCatalog } = buildMarketData({ infra });
 * const { orderRepo, portfolioStore, processedFillRepo, reconciliationIssueRepo, keyedMutex } =
 *   buildRepositories(marketCatalog);
 * ```
 */
export function buildRepositories(marketCatalog?: IMarketCatalog): Repositories {
  return {
    orderRepo: new InMemoryOrderRepository(marketCatalog),
    portfolioStore: new InMemoryPortfolioStore(),
    processedFillRepo: new InMemoryProcessedFillRepository(),
    reconciliationIssueRepo: new InMemoryReconciliationIssueRepository(),
    keyedMutex: new InMemoryKeyedMutex(),
  };
}
