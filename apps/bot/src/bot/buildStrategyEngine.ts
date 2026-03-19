/**
 * Построитель стратегического движка.
 *
 * @remarks
 * Создаёт три компонента стратегического слоя:
 *
 * - `ExecutionEngine` — принимает `StrategyIntent[]`, нормализует и выполняет
 *   через `PlaceOrderUseCase` / `CancelOrderUseCase`. Читает состояние ордеров
 *   и портфеля для контекста. Клампирует размер ордера к `minOrderSize` из каталога.
 *
 * - `StrategyScheduler` — управляет жизненным циклом стратегий: регистрация,
 *   event-driven вызов `tick()`, дедупликация через `DirtyTracker`.
 *   Читает данные из `MarketDataStore`, `IOrderStateStore`, `IPortfolioStore`.
 *
 * - `OrderEventBridge` — транслирует `ORDER_*` события из EventBus в вызовы
 *   `scheduler.dirty()`, замыкая петлю обратной связи: fill → событие → tick.
 *
 * ### Жизненный цикл:
 * - `scheduler.start()` — запускает внутренний цикл обработки
 * - `orderEventBridge.start()` — начинает слушать ORDER_* события
 * - `scheduler.register(...)` — регистрирует стратегию для инструмента
 * - `scheduler.stop()` + `orderEventBridge.stop()` — graceful shutdown
 *
 * @example
 * ```typescript
 * const engine = buildStrategyEngine({ infra, repos, useCases, marketDataStore, marketCatalog });
 * engine.scheduler.start();
 * engine.orderEventBridge.start();
 * await engine.scheduler.register({ strategy, instrumentId, ... });
 * ```
 */

import { ExecutionEngine, StrategyScheduler, OrderEventBridge } from '@polymarket/strategy';
import type { IMarketCatalog } from '@polymarket/ports';
import type { RiskParams } from '@polymarket/risk';
import type { CoreInfra } from './buildCoreInfra.js';
import type { Repositories } from './buildRepositories.js';
import type { UseCases } from './buildUseCases.js';
import type { MarketDataStore } from '@polymarket/market-state';

/** Зависимости для построения стратегического движка */
export interface BuildStrategyEngineParams {
  readonly infra: CoreInfra;
  readonly repos: Repositories;
  readonly useCases: UseCases;
  readonly marketDataStore: MarketDataStore;
  /** Каталог инструментов — для клампирования размера ордера к minOrderSize */
  readonly marketCatalog: IMarketCatalog;
  /** Параметры риска — используются для ограничения minOrderValue-клампирования по maxPositionSize */
  readonly riskParams?: RiskParams;
}

/** Результат построения стратегического движка */
export interface StrategyEngine {
  readonly executionEngine: ExecutionEngine;
  readonly scheduler: StrategyScheduler;
  readonly orderEventBridge: OrderEventBridge;
}

/**
 * Создаёт стратегический движок: ExecutionEngine, StrategyScheduler, OrderEventBridge.
 *
 * @param params - Зависимости
 * @returns Объект с тремя компонентами движка
 *
 * @example
 * ```typescript
 * const { scheduler, orderEventBridge } = buildStrategyEngine({ infra, repos, useCases, marketDataStore, marketCatalog });
 * scheduler.start();
 * orderEventBridge.start();
 * ```
 */
export function buildStrategyEngine(params: BuildStrategyEngineParams): StrategyEngine {
  const { infra, repos, useCases, marketDataStore, marketCatalog, riskParams } = params;
  const { clock, logger, eventBus } = infra;
  const { orderRepo, portfolioStore } = repos;
  const { placeOrderUseCase, cancelOrderUseCase } = useCases;

  const executionEngine = new ExecutionEngine({
    placeOrderUseCase,
    cancelOrderUseCase,
    orderRepo,
    portfolioStore,
    catalog: marketCatalog,
    maxPositionSize: riskParams?.maxPositionSize,
    logger,
  });

  const scheduler = new StrategyScheduler({
    marketDataStore,
    orderStateStore: orderRepo,
    portfolioStore,
    executionEngine,
    clock,
    logger,
  });

  const orderEventBridge = new OrderEventBridge({
    eventBus,
    scheduler,
    orderStateStore: orderRepo,
    orderRepo,
    logger,
  });

  return { executionEngine, scheduler, orderEventBridge };
}
