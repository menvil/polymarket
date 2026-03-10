/**
 * StrategyCoordinator — оркестрация обнаружения рынков и жизненного цикла стратегий.
 *
 * @remarks
 * ### Назначение:
 * Координатор реагирует на `STRATEGY_TICK` события (без setInterval!) и управляет:
 * - Обнаружением новых торгуемых инструментов (discovery) через IMarketDiscoveryService
 * - Наполнением каталога через IMarketCatalog.register()
 * - Аллокацией баланса на новые рынки через OpenMarketUseCase
 * - Проверкой политики удаления и закрытием рынков через CloseMarketUseCase
 * - Очисткой каталога при закрытии рынков через IMarketCatalog.remove()
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
 * 1. `discoveryService.findCandidates()` → список кандидатов из Gamma API
 * 2. `marketCatalog.register()` для каждого кандидата → наполняем каталог
 * 3. `marketCatalog.getAll()` → активные инструменты
 * 4. Фильтр: не в _activeMarkets
 * 5. `openMarketUseCase.execute(...)` для новых рынков
 *
 * ### _checkPolicy():
 * 1. Собрать MarketContext[] из _activeMarkets
 * 2. `removalPolicy.evaluate(contexts)` → MarketId[] для закрытия
 * 3. Для каждого: `closeMarketUseCase.execute(...)`
 * 4. Найти `InstrumentInfo` по marketId через `catalog.getByMarketId()`
 * 5. `marketCatalog.remove(instrumentInfo.instrumentId)`
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
import type { IClock } from '@polymarket/time';
import type {
  IBalanceAllocator,
  IMarketCatalog,
  IMarketDiscoveryService,
  DiscoveredMarket,
} from '@polymarket/ports';
import type { IEventBus, StrategyTickEvent } from '@polymarket/event-bus';
import type { IRemovalPolicy, MarketContext } from '@polymarket/market-lifecycle';
import type { OpenMarketUseCase } from '@polymarket/market-lifecycle';
import type { CloseMarketUseCase } from '@polymarket/market-lifecycle';
import type { StrategyCoordinatorConfig } from './StrategyCoordinatorConfig.js';

/**
 * Зависимости StrategyCoordinator.
 */
export interface StrategyCoordinatorDeps {
  /** Каталог торговых инструментов (поддерживает read/write операции) */
  readonly marketCatalog: IMarketCatalog;
  /** Сервис обнаружения рынков (Gamma API) */
  readonly discoveryService: IMarketDiscoveryService;
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
   *
   * `updateTotalBalance` возвращает `Result<void, TradingError>`.
   * При ошибке (over-allocation) — логируем предупреждение и продолжаем запуск:
   * система продолжит работать с текущим балансом до следующего обновления.
   *
   * @example
   * ```typescript
   * coordinator.start(Money.of(new Decimal(10000), 'USDC'));
   * ```
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

    const updateResult = this._deps.balanceAllocator.updateTotalBalance(totalBalance);
    if (!updateResult.ok) {
      this._logger.warn('Failed to update total balance on start (possible over-allocation)', {
        error: updateResult.error.message,
        balance: totalBalance.toNumber(),
      });
    }

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
   * ### Алгоритм:
   * 1. Получить кандидатов через `discoveryService.findCandidates()`
   * 2. Зарегистрировать каждого кандидата в `marketCatalog` через `register()`
   * 3. Получить все инструменты из каталога
   * 4. Фильтр: активные, не в `_activeMarkets`
   * 5. Аллоцировать баланс и открыть рынки через `openMarketUseCase`
   *
   * @example
   * ```typescript
   * // Вызывается автоматически каждые discoverEveryNTicks тиков
   * await this._discover();
   * ```
   */
  private async _discover(): Promise<void> {
    this._logger.debug('Running market discovery');

    // 1. Получить кандидатов из discovery service
    let candidates: readonly DiscoveredMarket[];
    try {
      candidates = await this._deps.discoveryService.findCandidates();
    } catch (error) {
      this._logger.error('Failed to fetch discovery candidates', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    // 2. Наполнить каталог из кандидатов — DiscoveredMarket extends InstrumentInfo
    for (const candidate of candidates) {
      this._deps.marketCatalog.register(candidate);
    }

    this._logger.debug('Market catalog updated from discovery', {
      candidates: candidates.length,
    });

    // 3. Получить все инструменты из каталога
    const allInstruments = this._deps.marketCatalog.getAll();
    const activeInstruments = allInstruments.filter(
      (inst) => inst.active && !this._activeMarkets.has(String(inst.marketId)),
    );

    if (activeInstruments.length === 0) {
      this._logger.debug('No new instruments to open after discovery');
      return;
    }

    // 4. Ограничение по maxStrategies
    const remainingSlots = this._config.maxStrategies - this._activeMarkets.size;
    if (remainingSlots <= 0) {
      this._logger.debug('Max strategies reached, skipping discovery');
      return;
    }

    const newInstruments = activeInstruments.slice(0, remainingSlots);

    // 5. Открыть новые рынки — используем inst.expiresAt из каталога (реальный срок истечения)
    for (const inst of newInstruments) {
      const result = await this._deps.openMarketUseCase.execute({
        marketId: inst.marketId,
        strategyId: String(inst.marketId),
        accountId: this._config.accountId,
      });

      if (result.ok) {
        this._activeMarkets.set(String(inst.marketId), {
          marketId: inst.marketId,
          expiresAt: inst.expiresAt,
          allocatedBalance: result.value.allocatedAmount,
          realizedPnL: result.value.allocatedAmount,
          openOrdersCount: 0,
        });

        this._logger.info('New market opened via discovery', {
          marketId: String(inst.marketId),
          allocated: result.value.allocatedAmount.toNumber(),
        });
      } else {
        this._logger.debug('Could not open market (allocation failed)', {
          marketId: String(inst.marketId),
          reason: result.error.message,
        });
      }
    }
  }

  /**
   * Проверяет политику удаления и закрывает помечённые рынки.
   *
   * @remarks
   * При успешном закрытии рынка:
   * 1. Удаляет из `_activeMarkets`
   * 2. Находит `InstrumentInfo` по marketId через `getByMarketId()`
   * 3. Вызывает `marketCatalog.remove(instrumentInfo.instrumentId)`
   *
   * Если `getByMarketId()` возвращает `undefined` — логируем warn,
   * но продолжаем (рынок уже мог быть удалён из каталога).
   *
   * @example
   * ```typescript
   * // Вызывается автоматически каждые policyCheckEveryNTicks тиков
   * await this._checkPolicy();
   * ```
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

        // Удаляем из каталога через getByMarketId → remove
        const instrumentInfo = this._deps.marketCatalog.getByMarketId(marketId);
        if (instrumentInfo) {
          this._deps.marketCatalog.remove(instrumentInfo.instrumentId);
          this._logger.debug('Removed closed market from catalog', {
            marketId: String(marketId),
            instrumentId: String(instrumentInfo.instrumentId),
          });
        } else {
          this._logger.warn('Market closed by policy but not found in catalog', {
            marketId: String(marketId),
          });
        }

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
