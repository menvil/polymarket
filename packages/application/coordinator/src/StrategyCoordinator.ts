/**
 * StrategyCoordinator — оркестрация обнаружения рынков и жизненного цикла стратегий.
 *
 * @remarks
 * ### Назначение:
 * Координатор реагирует на `STRATEGY_TICK` события (без setInterval!) и управляет:
 * - Обнаружением новых торгуемых инструментов (discovery)
 * - Аллокацией баланса на новые рынки через OpenMarketUseCase
 * - Проверкой политики удаления и закрытием рынков через CloseMarketUseCase
 *
 * ### Без setInterval:
 * Координатор не создаёт таймеры. Вместо этого внешний компонент (Scheduler)
 * публикует `STRATEGY_TICK` с нужной периодичностью.
 * Это делает координатор детерминированным и удобным для тестирования.
 *
 * ### Алгоритм на STRATEGY_TICK:
 * ```
 * tickCounter++
 * if tickCounter % discoverEveryNTicks === 0 → _discover()
 * if tickCounter % policyCheckEveryNTicks === 0 → _checkPolicy()
 * ```
 *
 * ### _discover():
 * 1. `marketCatalog.getAll()` → активные инструменты
 * 2. Фильтр: не в _activeMarkets
 * 3. `balanceAllocator.allocateToNewMarkets(newMarketIds)` → AllocationResult[]
 * 4. Для каждого нового рынка: `openMarketUseCase.execute(...)`
 *
 * ### _checkPolicy():
 * 1. Собрать MarketContext[] из _activeMarkets
 * 2. `removalPolicy.evaluate(contexts)` → MarketId[] для закрытия
 * 3. Для каждого: `closeMarketUseCase.execute(...)`
 *
 * @example
 * ```typescript
 * const coordinator = new StrategyCoordinator({ ... }, config);
 * coordinator.start(totalBalance);
 *
 * // Внешний тикер:
 * setInterval(async () => {
 *   await eventBus.publish({ type: 'STRATEGY_TICK', tickNumber: n++, timestamp });
 * }, 1000);
 * ```
 */
import type { ILogger } from '@polymarket/logger';
import type { Money } from '@polymarket/value-objects';
import { TimestampService } from '@polymarket/value-objects';
import type { IClock } from '@polymarket/time';
import type { IBalanceAllocator, IMarketCatalog } from '@polymarket/ports';
import type { IEventBus, StrategyTickEvent } from '@polymarket/event-bus';
import type { IRemovalPolicy, MarketContext } from '@polymarket/market-lifecycle';
import type { OpenMarketUseCase } from '@polymarket/market-lifecycle';
import type { CloseMarketUseCase } from '@polymarket/market-lifecycle';
import type { StrategyCoordinatorConfig } from './StrategyCoordinatorConfig.js';

/**
 * Зависимости StrategyCoordinator.
 */
export interface StrategyCoordinatorDeps {
  /** Каталог торговых инструментов */
  readonly marketCatalog: IMarketCatalog;
  /** Распределитель баланса */
  readonly balanceAllocator: IBalanceAllocator;
  /** Use case открытия рынка */
  readonly openMarketUseCase: OpenMarketUseCase;
  /** Use case закрытия рынка */
  readonly closeMarketUseCase: CloseMarketUseCase;
  /** Политика удаления рынков */
  readonly removalPolicy: IRemovalPolicy;
  /** Event bus */
  readonly eventBus: IEventBus;
  /** Источник времени */
  readonly clock: IClock;
  /** Logger */
  readonly logger: ILogger;
}

/**
 * Координатор торговых стратегий.
 *
 * @remarks
 * Управляет обнаружением рынков и политикой удаления через event-driven подход.
 * Не использует `setInterval`.
 */
export class StrategyCoordinator {
  private readonly _logger: ILogger;
  /** Счётчик тиков с момента запуска */
  private _tickCounter = 0;
  /** Активные рынки: marketId → MarketContext */
  private readonly _activeMarkets = new Map<string, MarketContext>();
  /** Функция отписки от STRATEGY_TICK */
  private _unsubscribe: (() => void) | undefined;

  /**
   * @param deps - Зависимости координатора
   * @param config - Конфигурация координатора
   */
  constructor(
    private readonly _deps: StrategyCoordinatorDeps,
    private readonly _config: StrategyCoordinatorConfig,
  ) {
    this._logger = _deps.logger.child({ component: 'StrategyCoordinator' });
  }

  /**
   * Запускает координатор: обновляет баланс и подписывается на STRATEGY_TICK.
   *
   * @param totalBalance - Текущий общий баланс аккаунта
   *
   * @remarks
   * После start() координатор реагирует на каждый STRATEGY_TICK.
   * Повторный вызов start() без предварительного stop() — no-op.
   */
  public start(totalBalance: Money): void {
    if (this._unsubscribe) {
      this._logger.warn('StrategyCoordinator already running, ignoring start()');
      return;
    }

    this._logger.info('Starting StrategyCoordinator', {
      discoverEveryNTicks: this._config.discoverEveryNTicks,
      policyCheckEveryNTicks: this._config.policyCheckEveryNTicks,
      maxStrategies: this._config.maxStrategies,
    });

    this._deps.balanceAllocator.updateTotalBalance(totalBalance);

    this._unsubscribe = this._deps.eventBus.subscribe(
      'STRATEGY_TICK',
      (event: StrategyTickEvent) => this._onTick(event),
    );
  }

  /**
   * Останавливает координатор: отписывается от STRATEGY_TICK.
   *
   * @remarks
   * Активные рынки не закрываются — для этого используйте closeMarketUseCase явно.
   */
  public stop(): void {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = undefined;
    }
    this._logger.info('StrategyCoordinator stopped');
  }

  /**
   * Обработчик тика координатора.
   *
   * @param event - STRATEGY_TICK событие
   */
  private async _onTick(_event: StrategyTickEvent): Promise<void> {
    this._tickCounter++;
    const tick = this._tickCounter;

    if (tick % this._config.discoverEveryNTicks === 0) {
      await this._discover();
    }

    if (tick % this._config.policyCheckEveryNTicks === 0) {
      await this._checkPolicy();
    }
  }

  /**
   * Обнаруживает новые рынки и открывает их.
   *
   * @remarks
   * Запрашивает все инструменты из каталога, фильтрует уже активные,
   * аллоцирует баланс и открывает новые рынки.
   */
  private async _discover(): Promise<void> {
    this._logger.debug('Running market discovery');

    const allInstruments = this._deps.marketCatalog.getAll();
    const activeInstruments = allInstruments.filter(
      (inst) => inst.active && !this._activeMarkets.has(String(inst.marketId)),
    );

    if (activeInstruments.length === 0) {
      this._logger.debug('No new instruments to discover');
      return;
    }

    // Ограничение по maxStrategies
    const remainingSlots = this._config.maxStrategies - this._activeMarkets.size;
    if (remainingSlots <= 0) {
      this._logger.debug('Max strategies reached, skipping discovery');
      return;
    }

    const newMarketIds = activeInstruments
      .slice(0, remainingSlots)
      .map((inst) => inst.marketId);

    for (const marketId of newMarketIds) {
      const result = await this._deps.openMarketUseCase.execute({
        marketId,
        strategyId: String(marketId),
        accountId: this._config.accountId,
      });

      if (result.ok) {
        // Добавляем в _activeMarkets с минимальным контекстом
        // expiresAt будет обновлён при первом policyCheck
        const nowMs = this._deps.clock.now().getTime();
        const timestampResult = TimestampService.create(nowMs);
        if (timestampResult.ok) {
          this._activeMarkets.set(String(marketId), {
            marketId,
            expiresAt: timestampResult.value,
            allocatedBalance: result.value.allocatedAmount,
            realizedPnL: result.value.allocatedAmount.isZero()
              ? result.value.allocatedAmount
              : result.value.allocatedAmount,
            openOrdersCount: 0,
          });
        }

        this._logger.info('New market opened via discovery', {
          marketId: String(marketId),
          allocated: result.value.allocatedAmount.toNumber(),
        });
      } else {
        this._logger.debug('Could not open market (allocation failed)', {
          marketId: String(marketId),
          reason: result.error.message,
        });
      }
    }
  }

  /**
   * Проверяет политику удаления и закрывает помечённые рынки.
   */
  private async _checkPolicy(): Promise<void> {
    if (this._activeMarkets.size === 0) return;

    const contexts = [...this._activeMarkets.values()];
    const marketIdsToClose = this._deps.removalPolicy.evaluate(contexts);

    if (marketIdsToClose.length === 0) return;

    this._logger.info('Policy check: closing markets', {
      count: marketIdsToClose.length,
    });

    for (const marketId of marketIdsToClose) {
      const result = await this._deps.closeMarketUseCase.execute({
        marketId,
        accountId: this._config.accountId,
        reason: 'POLICY',
      });

      if (result.ok) {
        this._activeMarkets.delete(String(marketId));
        this._logger.info('Market closed by policy', { marketId: String(marketId) });
      } else {
        this._logger.error('Failed to close market by policy', {
          marketId: String(marketId),
          error: result.error.message,
        });
      }
    }
  }
}
