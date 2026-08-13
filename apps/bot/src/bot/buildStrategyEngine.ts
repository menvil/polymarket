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

import {
  ExecutionEngine,
  StrategyScheduler,
  OrderEventBridge,
  NodeSchedulerTimer,
  UuidOrderIdGenerator,
} from '@polymarket/strategy';
import type {
  ITokenBalanceChecker,
  ICryptoResolutionStore,
  ICryptoMarketDataStore,
  ICryptoSignalRegistry,
  ISchedulerTimer,
  IOrderIdGenerator,
} from '@polymarket/strategy';
import type { IMarketCatalog, IStrategyCommitmentReader } from '@polymarket/ports';
import { SubmissionJournalStrategyCommitmentReader } from '@polymarket/use-cases';
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
  /** Каталог инструментов — для валидации constraints и передачи в snapshot стратегиям */
  readonly marketCatalog: IMarketCatalog;
  /** Опциональный: проверка баланса токена на CLOB при SELL rejection */
  readonly tokenBalanceChecker?: ITokenBalanceChecker;
  /** Опциональный: store strike/resolution для StrategyScheduler */
  readonly cryptoResolutionStore?: ICryptoResolutionStore;
  /** Опциональный: long-lived history/state store для CEX/crypto market data */
  readonly cryptoMarketDataStore?: ICryptoMarketDataStore;
  /** Опциональный: shared crypto signal calculator registry */
  readonly cryptoSignalRegistry?: ICryptoSignalRegistry;
  /**
   * Порт таймеров планировщика (по умолчанию NodeSchedulerTimer).
   * Для replay/backtest передайте DeterministicSchedulerTimer.
   */
  readonly schedulerTimer?: ISchedulerTimer;
  /**
   * Генератор клиентских Order ID (по умолчанию UuidOrderIdGenerator).
   * Для replay/backtest передайте SequentialOrderIdGenerator.
   */
  readonly orderIdGenerator?: IOrderIdGenerator;
  /**
   * Authoritative reader незавершённых commitments стратегии (по умолчанию
   * `SubmissionJournalStrategyCommitmentReader` поверх `repos.orderSubmissionRepo`
   * + `repos.orderRepo`). Передайте свою реализацию для persistent/live
   * submission journal, когда таковой появится — НЕ подставляйте no-op/fake
   * в production (final cleanup post-check зависит от него, см.
   * `StrategySchedulerDeps.commitmentReader`).
   */
  readonly commitmentReader?: IStrategyCommitmentReader;
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
  const {
    infra,
    repos,
    useCases,
    marketDataStore,
    marketCatalog,
    tokenBalanceChecker,
    cryptoResolutionStore,
    cryptoMarketDataStore,
    cryptoSignalRegistry,
    schedulerTimer,
    orderIdGenerator,
    commitmentReader,
  } = params;
  const { clock, logger, eventBus } = infra;
  const { orderRepo, portfolioStore, orderSubmissionRepo } = repos;
  const { placeOrderUseCase, cancelOrderUseCase } = useCases;

  const timer = schedulerTimer ?? new NodeSchedulerTimer();
  const idGenerator = orderIdGenerator ?? new UuidOrderIdGenerator();
  const commitments = commitmentReader ?? new SubmissionJournalStrategyCommitmentReader({
    submissions: orderSubmissionRepo,
    orderStateStore: orderRepo,
    logger,
  });

  const executionEngine = new ExecutionEngine({
    placeOrderUseCase,
    cancelOrderUseCase,
    orderRepo,
    portfolioStore,
    catalog: marketCatalog,
    clock,
    orderIdGenerator: idGenerator,
    logger,
    tokenBalanceChecker,
  });

  const scheduler = new StrategyScheduler({
    marketDataStore,
    orderStateStore: orderRepo,
    portfolioStore,
    catalog: marketCatalog,
    executionEngine,
    clock,
    timer,
    commitmentReader: commitments,
    logger,
    cryptoResolutionStore,
    cryptoMarketDataStore,
    cryptoSignalRegistry,
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
