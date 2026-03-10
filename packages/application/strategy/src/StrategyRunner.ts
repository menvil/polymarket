/**
 * StrategyRunner — управление жизненным циклом торговых стратегий.
 *
 * @remarks
 * Реализует полный IStrategyRunner: start, stop, stopAll, getMetrics, onRiskBreached.
 * Совместим с IStrategyRunner из @polymarket/orchestrators (подмножество).
 *
 * ### Хранилища:
 * - `_strategies: Map<strategyId, IStrategy>` — активные стратегии
 * - `_tradingAPIs: Map<strategyId, TradingAPI>` — изолированные TradingAPI
 *
 * ### Жизненный цикл:
 * ```
 * start(strategy):
 *   TradingAPI ← new TradingAPI({ strategyId, ...sharedDeps })
 *   ctx ← { api: tradingAPI }
 *   result ← strategy.initialize(ctx)
 *   if Err → tradingAPI.unsubscribeAll(); return Err
 *   _strategies.set(id, strategy)
 *   _tradingAPIs.set(id, tradingAPI)
 *
 * stop(strategyId):
 *   strategy.stop()
 *   tradingAPI.unsubscribeAll()
 *   _strategies.delete(id)
 *   _tradingAPIs.delete(id)
 * ```
 *
 * @example
 * ```typescript
 * const runner = new StrategyRunner({
 *   accountId, placeOrderUseCase, cancelOrderUseCase,
 *   orderRepo, portfolioStore, eventBus, logger,
 * });
 *
 * await runner.start(new SimpleQuoter());
 * ```
 */
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import type { ILogger } from '@polymarket/logger';
import type { AccountId } from '@polymarket/ids';
import type {
  MarketOpenedEvent,
  MarketClosedEvent,
  RiskLimitBreachedEvent,
  IEventBus,
} from '@polymarket/event-bus';
import type { IOrderRepository, IPortfolioStore } from '@polymarket/ports';
import type { PlaceOrderUseCase, CancelOrderUseCase } from '@polymarket/use-cases';
import type { IStrategy } from './IStrategy.js';
import type { IStrategyRunner } from './IStrategyRunner.js';
import { TradingAPI } from './TradingAPI.js';
import type { StrategyContext } from './StrategyContext.js';

/**
 * Фабрика для создания стратегий из события открытия рынка.
 *
 * @remarks
 * Передаётся в `StrategyRunnerDeps.strategyFactory`.
 * `StrategyRunner` вызывает фабрику при каждом `MARKET_OPENED` событии.
 * Если фабрика возвращает `undefined`, стратегия не запускается.
 *
 * @param event - Событие открытия рынка (содержит marketId, strategyId, allocatedBalance)
 * @returns Новый экземпляр `IStrategy` или `undefined`, если рынок не интересен
 *
 * @example
 * ```typescript
 * const factory: StrategyFactory = (event) => {
 *   if (!isEligibleMarket(event.marketId)) return undefined;
 *   return new SimpleQuoterStrategy(event.strategyId, event.marketId);
 * };
 * ```
 */
export type StrategyFactory = (event: MarketOpenedEvent) => IStrategy | undefined;

/**
 * Зависимости StrategyRunner.
 *
 * @remarks
 * Общие (shared) зависимости — используются для создания TradingAPI каждой стратегии.
 */
export interface StrategyRunnerDeps {
  /** ID аккаунта для всех TradingAPI (один аккаунт — несколько стратегий) */
  readonly accountId: AccountId;
  /** Use case размещения ордеров */
  readonly placeOrderUseCase: PlaceOrderUseCase;
  /** Use case отмены ордеров */
  readonly cancelOrderUseCase: CancelOrderUseCase;
  /** Репозиторий ордеров */
  readonly orderRepo: IOrderRepository;
  /** Хранилище Portfolio */
  readonly portfolioStore: IPortfolioStore;
  /** Event bus */
  readonly eventBus: IEventBus;
  /** Logger */
  readonly logger: ILogger;
  /**
   * Необязательная фабрика для автоматического запуска стратегий.
   *
   * @remarks
   * Если указана, `StrategyRunner` подписывается на `MARKET_OPENED` и создаёт
   * стратегию через фабрику при каждом новом рынке. При `MARKET_CLOSED` автоматически
   * останавливает стратегию с ID = `String(event.marketId)`.
   */
  readonly strategyFactory?: StrategyFactory;
}

/**
 * Менеджер жизненного цикла торговых стратегий.
 *
 * @remarks
 * Создаёт изолированный TradingAPI для каждой стратегии и управляет:
 * - Инициализацией (`start`)
 * - Остановкой (`stop`, `stopAll`)
 * - Реакцией на риск-лимиты (`onRiskBreached`)
 * - Мониторингом метрик (`getMetrics`)
 */
export class StrategyRunner implements IStrategyRunner {
  private readonly _logger: ILogger;
  /** Активные стратегии по strategyId */
  private readonly _strategies = new Map<string, IStrategy>();
  /** Изолированные TradingAPI по strategyId */
  private readonly _tradingAPIs = new Map<string, TradingAPI>();

  /**
   * @param deps - Общие зависимости для всех TradingAPI
   *
   * @remarks
   * Если `deps.strategyFactory` задана, автоматически подписывается на:
   * - `MARKET_OPENED` → создаёт стратегию через фабрику и запускает её
   * - `MARKET_CLOSED` → останавливает стратегию с `strategyId = String(event.marketId)`
   *
   * Подписки действуют на весь срок жизни StrategyRunner.
   */
  constructor(private readonly _deps: StrategyRunnerDeps) {
    this._logger = _deps.logger.child({ component: 'StrategyRunner' });

    if (_deps.strategyFactory) {
      _deps.eventBus.subscribe(
        'MARKET_OPENED',
        async (event: MarketOpenedEvent) => {
          const strategy = this._deps.strategyFactory!(event);
          if (!strategy) return;
          const result = await this.start(strategy);
          if (!result.ok) {
            this._logger.error('Failed to start strategy on MARKET_OPENED', {
              marketId: String(event.marketId),
              strategyId: event.strategyId,
              error: result.error.message,
            });
          }
        },
      );

      _deps.eventBus.subscribe(
        'MARKET_CLOSED',
        async (event: MarketClosedEvent) => {
          await this.stop(String(event.marketId));
        },
      );
    }
  }

  /**
   * Запускает стратегию: создаёт TradingAPI, вызывает initialize().
   *
   * @param strategy - Стратегия для запуска
   * @returns Ok(void) при успехе, Err(Error) если initialize() вернул ошибку
   *
   * @throws Не бросает — все ошибки возвращаются через Result
   *
   * @example
   * ```typescript
   * const result = await runner.start(new SimpleQuoter());
   * if (!result.ok) console.error(result.error.message);
   * ```
   */
  public async start(strategy: IStrategy): Promise<Result<void, Error>> {
    if (this._strategies.has(strategy.id)) {
      this._logger.warn('Strategy already running, skipping start', { strategyId: strategy.id });
      return Ok(undefined);
    }

    const tradingAPI = new TradingAPI({
      strategyId: strategy.id,
      accountId: this._deps.accountId,
      placeOrderUseCase: this._deps.placeOrderUseCase,
      cancelOrderUseCase: this._deps.cancelOrderUseCase,
      orderRepo: this._deps.orderRepo,
      portfolioStore: this._deps.portfolioStore,
      eventBus: this._deps.eventBus,
      logger: this._deps.logger,
    });

    const ctx: StrategyContext = { api: tradingAPI };

    this._logger.info('Starting strategy', { strategyId: strategy.id, name: strategy.name });

    let initResult;
    try {
      initResult = await strategy.initialize(ctx);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this._logger.error('Strategy initialization threw an error, cleaning up', {
        strategyId: strategy.id,
        error: error.message,
      });
      tradingAPI.unsubscribeAll();
      return Err(error);
    }

    if (!initResult.ok) {
      this._logger.error('Strategy initialization failed, cleaning up', {
        strategyId: strategy.id,
        error: initResult.error.message,
      });
      tradingAPI.unsubscribeAll();
      return initResult;
    }

    this._strategies.set(strategy.id, strategy);
    this._tradingAPIs.set(strategy.id, tradingAPI);

    this._logger.info('Strategy started successfully', {
      strategyId: strategy.id,
      name: strategy.name,
      activeStrategies: this._strategies.size,
    });

    return Ok(undefined);
  }

  /**
   * Останавливает стратегию по ID.
   *
   * @param strategyId - ID стратегии
   *
   * @remarks
   * Вызывает `strategy.stop()`, затем `tradingAPI.unsubscribeAll()`.
   * Если стратегия не найдена — предупреждение в лог, no-op.
   */
  public async stop(strategyId: string): Promise<void> {
    const strategy = this._strategies.get(strategyId);
    if (!strategy) {
      this._logger.warn('Strategy not found for stop', { strategyId });
      return;
    }

    this._logger.info('Stopping strategy', { strategyId, name: strategy.name });

    try {
      await strategy.stop();
    } catch (err) {
      this._logger.error('Strategy.stop() threw an error', {
        strategyId,
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }

    const tradingAPI = this._tradingAPIs.get(strategyId);
    tradingAPI?.unsubscribeAll();

    this._strategies.delete(strategyId);
    this._tradingAPIs.delete(strategyId);

    this._logger.info('Strategy stopped', {
      strategyId,
      activeStrategies: this._strategies.size,
    });
  }

  /**
   * Останавливает все активные стратегии параллельно.
   *
   * @remarks
   * Используется при системном завершении или системном нарушении риска.
   */
  public async stopAll(): Promise<void> {
    const strategyIds = [...this._strategies.keys()];
    if (strategyIds.length === 0) {
      this._logger.debug('No active strategies to stop');
      return;
    }

    this._logger.warn('Stopping all strategies', { count: strategyIds.length });
    await Promise.all(strategyIds.map((id) => this.stop(id)));
    this._logger.info('All strategies stopped');
  }

  /**
   * Возвращает метрики стратегии.
   *
   * @param strategyId - ID стратегии
   * @returns Метрики или undefined если стратегия не найдена
   */
  public getMetrics(strategyId: string): Record<string, unknown> | undefined {
    return this._strategies.get(strategyId)?.getMetrics();
  }

  /**
   * Реагирует на нарушение риск-лимита.
   *
   * @param event - RiskLimitBreachedEvent
   *
   * @remarks
   * - Если `event.strategyId` указан → останавливает конкретную стратегию
   * - Если `event.strategyId` undefined → системное нарушение, останавливает все
   */
  public async onRiskBreached(event: RiskLimitBreachedEvent): Promise<void> {
    if (event.strategyId) {
      this._logger.warn('Risk limit breached for strategy, stopping', {
        strategyId: event.strategyId,
        violationType: event.violationType,
        violation: event.violation,
      });
      await this.stop(event.strategyId);
    } else {
      this._logger.warn('System-wide risk limit breached, stopping all strategies', {
        violationType: event.violationType,
        violation: event.violation,
      });
      await this.stopAll();
    }
  }
}
