/**
 * MultiStrategyCoordinator - координация множественных стратегий
 *
 * @remarks
 * КРИТИЧНО v4.2: Event-driven (NO setInterval, реагирует на StrategyTick)!
 *
 * Смешивает 3 роли (на первом этапе допустимо):
 * 1. StrategySupervisor - lifecycle runner'ов
 * 2. MarketAllocator - discovery + баланс
 * 3. PolicyExecutor - исполняет ВНЕШНЮЮ removal policy
 *
 * ЗАПРЕЩЕНО:
 * - Принимать решения "стратегия плохая" (только policy решает)
 * - Иметь hardcoded logic "когда удалять"
 * - Использовать setInterval (только реакция на StrategyTick)
 *
 * РАЗРЕШЕНО:
 * - Исполнять pluggable removal policy
 * - Механизм lifecycle (start/stop)
 * - Распределение баланса по формуле
 *
 * TODO (v5): Разделить на 3 класса:
 * - StrategySupervisor (lifecycle)
 * - MarketAllocator (discovery + allocation)
 * - MultiStrategyCoordinator (только координация)
 *
 * @example
 * ```typescript
 * const coordinator = new MultiStrategyCoordinator(
 *   marketDiscovery,
 *   strategyFactory,
 *   new ExpirationRemovalPolicy(), // ✅ Pluggable policy
 *   config,
 *   eventBus,
 *   executionAdapter,
 *   logger
 * );
 *
 * await coordinator.start(Money.fromUSDC(10000));
 * // → Поиск рынков, создание стратегий, подписка на StrategyTick
 *
 * // StrategyTick → coordinator реагирует (scan, policy check)
 *
 * await coordinator.stop();
 * // → Остановка всех стратегий
 * ```
 */

import type { IStrategy } from '../../domain/strategies/IStrategy.js';
import type { IStrategyRunner } from '../../domain/strategies/IStrategyRunner.js';
import type { StrategyContext } from '../../domain/strategies/StrategyContext.js';
import type { IPortfolioProjector } from '../../domain/services/portfolio/PortfolioProjector.js';
import { Money } from '../../domain/value-objects/Money.js';
import type { IEventBus } from '../../shared/events/IEventBus.js';
import type { IExecutionAdapter } from '../../domain/ports/IExecutionAdapter.js';
import type { ILogger } from '../../domain/ports/ILogger.js';
import type { StrategyTick } from '../../domain/events/TickEvent.js';
import type { IStrategyFactory, StrategyFactoryConfig, MarketCandidate } from '../factories/StrategyFactory.js';
import type { IStrategyMetricsProjector } from './StrategyMetricsProjector.js';
import type { IOrderbookProjector } from '../../domain/services/orderbook/OrderbookProjector.js';
import { StrategyRunner } from '../strategies/StrategyRunner.js';
import { StrategyExecutor } from '../strategies/StrategyExecutor.js';
import { StrategyContextImpl } from '../strategies/StrategyContextImpl.js';
// TODO: import { PnLCalculator } from '../../domain/services/portfolio/PnLCalculator.js';
import { LiveClock } from '../../infrastructure/time/LiveClock.js';
import { Environment } from '../../domain/execution/ExecutionContext.js';

/**
 * IWebSocketSubscriber - интерфейс для подписки на WebSocket каналы
 *
 * @remarks
 * v5.2: Нужен для динамической подписки на orderbook при добавлении стратегий.
 * При переключении рынка нужно подписаться на новый tokenId.
 *
 * ВАЖНО: Polymarket WebSocket требует переподключения для изменения подписок!
 * Используйте reconnectForNewSubscription() + subscribeToTokens(ALL tokens).
 */
export interface IWebSocketSubscriber {
  subscribeToTokens(tokenIds: string[]): Promise<void>;
  unsubscribeFromTokens?(tokenIds: string[]): Promise<void>;
  /**
   * Переподключить WebSocket для новых подписок
   *
   * @remarks
   * Polymarket НЕ поддерживает добавление подписок к существующему соединению.
   * Нужно: reconnect → subscribe to ALL tokens (old + new)
   */
  reconnectForNewSubscription(): Promise<void>;

  /**
   * Подписаться на трейды с callback
   *
   * @param tokenId - Token ID для подписки
   * @param callback - Callback при получении трейда
   *
   * @remarks
   * v5.3: Для trade-based fill detection!
   * Callback вызывается при каждом трейде, что позволяет
   * накапливать трейды в TradeAccumulator.
   */
  subscribeToTrades?(
    tokenId: string,
    callback: (trade: { price: number; quantity: number; side: 'BUY' | 'SELL' | null }) => void
  ): void;
}

/**
 * RemovalPolicy - ВНЕШНЯЯ policy "когда удалять стратегию"
 *
 * @remarks
 * КРИТИЧНО v4.2: Policy = pluggable, НЕ hardcoded в Coordinator!
 *
 * Примеры policy:
 * - ExpirationPolicy: удаляет когда рынок истёк
 * - ErrorCountPolicy: удаляет после N ошибок
 * - PnLThresholdPolicy: удаляет если loss > threshold
 * - CompositePolicy: комбинация нескольких policy
 *
 * @example
 * ```typescript
 * class PnLThresholdPolicy implements IRemovalPolicy {
 *   shouldRemove(instance: StrategyInstance): string | null {
 *     const pnl = instance.portfolioProjector.getPositions();
 *     // ... check PnL
 *     if (totalPnL < -100) {
 *       return 'PNL_THRESHOLD_EXCEEDED';
 *     }
 *     return null;
 *   }
 * }
 * ```
 */
export interface IRemovalPolicy {
  /**
   * Проверить нужно ли удалить стратегию
   *
   * @param instance - Экземпляр стратегии
   * @returns null если оставить, reason string если удалить
   *
   * @remarks
   * КРИТИЧНО v4.2: Policy РЕШАЕТ, Coordinator ИСПОЛНЯЕТ!
   *
   * Coordinator НЕ принимает решений, он вызывает policy.shouldRemove()
   * и исполняет результат.
   *
   * @example
   * ```typescript
   * const reason = policy.shouldRemove(instance);
   * if (reason) {
   *   coordinator.removeStrategy(instance.strategyId, reason);
   * }
   * ```
   */
  shouldRemove(instance: StrategyInstance): string | null;
}

/**
 * ExpirationRemovalPolicy - удаляет когда рынок истёк
 *
 * @remarks
 * Проверяет market.expirationDate < now.
 * Если рынок истёк, возвращает 'MARKET_EXPIRED'.
 *
 * v5.2: Использует instance.expirationDate
 */
export class ExpirationRemovalPolicy implements IRemovalPolicy {
  // Отменять ордера за 5 секунд до истечения рынка
  private readonly SAFETY_MARGIN_MS = 5000;

  shouldRemove(instance: StrategyInstance): string | null {
    // Проверяем expiration date если он есть
    if (instance.expirationDate) {
      const now = new Date();
      const timeToExpiry = instance.expirationDate.getTime() - now.getTime();

      // Логируем для отладки
      if (timeToExpiry < 60000) { // Меньше минуты
        console.log('[ExpirationRemovalPolicy] Market close to expiry', {
          strategyId: instance.strategyId,
          expirationDate: instance.expirationDate.toISOString(),
          timeToExpiryMs: timeToExpiry,
          safetyMarginMs: this.SAFETY_MARGIN_MS,
        });
      }

      // ✅ v5.2: Удаляем за 5 секунд до истечения, чтобы успеть отменить ордера
      if (timeToExpiry < this.SAFETY_MARGIN_MS) {
        console.log('[ExpirationRemovalPolicy] Market expiring soon - removing strategy!', {
          strategyId: instance.strategyId,
          expirationDate: instance.expirationDate.toISOString(),
          timeToExpiryMs: timeToExpiry,
        });
        return 'MARKET_EXPIRING_SOON';
      }
    } else {
      // Нет даты истечения - предупреждение
      console.warn('[ExpirationRemovalPolicy] No expirationDate for strategy', {
        strategyId: instance.strategyId,
        marketQuestion: instance.marketQuestion,
      });
    }
    return null;
  }
}

/**
 * StrategyInstance - экземпляр запущенной стратегии
 *
 * @remarks
 * Содержит всё что нужно для управления стратегией:
 * - runner (lifecycle)
 * - strategy (logic)
 * - context (sandbox)
 * - portfolioProjector (positions)
 * - metadata (marketId, question, balance)
 * - status (ACTIVE, STOPPED, ERROR)
 */
export interface StrategyInstance {
  strategyId: string;
  runner: IStrategyRunner;
  strategy: IStrategy;
  context: StrategyContext;
  portfolioProjector: IPortfolioProjector;
  marketId: string;
  marketQuestion: string; // Для UI
  allocatedBalance: Money;
  status: 'ACTIVE' | 'STOPPED' | 'ERROR';
  startedAt: Date;
  expirationDate?: Date; // v5.2: Для проверки истечения рынка
  tokenIds: string[]; // v5.2: Для отслеживания подписок WebSocket
}

/**
 * MultiStrategyStatus - статус координатора
 *
 * @remarks
 * Агрегированная информация о всех стратегиях.
 * Используется для UI/метрик.
 */
export interface MultiStrategyStatus {
  totalStrategies: number;
  activeStrategies: number;
  stoppedStrategies: number;
  errorStrategies: number;
  totalRealizedPnL: number;
  totalAllocatedBalance: number;
  freeBalance: number;
}

/**
 * MultiStrategyConfig - конфигурация координатора
 */
export interface MultiStrategyConfig {
  maxConcurrentStrategies: number; // Макс количество стратегий одновременно
  minCapitalPerMarket: number; // Минимальный капитал на рынок (USDC)
  tickIntervalMs: number; // Интервал тика стратегий (для расчёта N тиков)
  scanIntervalMs: number; // Интервал сканирования новых рынков
  removalCheckIntervalMs: number; // Интервал проверки removal policy
  strategyFactoryConfig: StrategyFactoryConfig; // Конфиг для создания стратегий
  environment: Environment; // Режим работы (LIVE/PAPER/REPLAY)
}

/**
 * IMultiStrategyCoordinator - интерфейс координатора
 */
export interface IMultiStrategyCoordinator {
  /**
   * Запустить координатор
   *
   * @param totalBalance - Общий баланс для распределения
   *
   * @remarks
   * Алгоритм v4.2:
   * 1. Первичный поиск рынков (tryAddStrategiesFromDiscovery)
   * 2. Подписка на StrategyTick (event-driven!)
   * 3. Каждый tick → проверка счётчиков → периодические действия
   *
   * КРИТИЧНО v4.2: NO setInterval, только реакция на StrategyTick!
   */
  start(totalBalance: Money): Promise<void>;

  /**
   * Остановить координатор
   *
   * @remarks
   * Алгоритм:
   * 1. Отписаться от StrategyTick
   * 2. Остановить все стратегии
   * 3. Очистить instances
   */
  stop(): Promise<void>;

  /**
   * Получить статус координатора
   *
   * @returns Агрегированный статус всех стратегий
   */
  getStatus(): MultiStrategyStatus;

  /**
   * Notify about orderbook update for event-driven fill detection
   *
   * @param tokenId - Token ID that was updated (optional)
   *
   * @remarks
   * v5.5: Event-driven fill detection!
   * Вызывается при получении orderbook update из WebSocket.
   */
  notifyOrderbookUpdate(tokenId?: string): void;

  /**
   * v6.4: Синхронизировать позиции стратегии с реальными данными биржи
   *
   * @param strategyId - Strategy ID
   * @param realPositions - Реальные positions с биржи (из getPositions API)
   *
   * @remarks
   * **КРИТИЧНО**: НЕ гадаем что произошло - синхронизируемся с реальностью!
   *
   * Вызывается когда обнаружен дисбаланс:
   * - OrderRejected с "insufficient balance"
   * - Periodic reconciliation обнаружил mismatch
   */
  syncPositions(strategyId: string, realPositions: Array<{ tokenId: string; balance: number }>): void;
}

/**
 * MultiStrategyCoordinator - event-driven координатор
 *
 * @remarks
 * КРИТИЧНО v4.2:
 * - Event-driven (NO setInterval, реагирует на StrategyTick)
 * - Pluggable RemovalPolicy (НЕ hardcoded logic)
 * - НЕ принимает решений (только исполняет policy)
 *
 * Концептуально 3 роли (в одном классе для v1):
 * 1. StrategySupervisor - lifecycle
 * 2. MarketAllocator - discovery + balance
 * 3. PolicyExecutor - исполняет policy
 *
 * @example
 * ```typescript
 * const coordinator = new MultiStrategyCoordinator(
 *   marketDiscovery,
 *   strategyFactory,
 *   new ExpirationRemovalPolicy(),
 *   config,
 *   eventBus,
 *   executionAdapter,
 *   logger
 * );
 *
 * await coordinator.start(Money.fromUSDC(10000));
 * ```
 */
export class MultiStrategyCoordinator implements IMultiStrategyCoordinator {
  private strategies = new Map<string, StrategyInstance>();
  private totalBalance: Money;

  // ✅ v4.2: Счётчики тиков вместо setInterval
  private tickCounter = 0;
  private readonly SCAN_EVERY_N_TICKS: number;
  private readonly POLICY_CHECK_EVERY_N_TICKS: number;
  private unsubscribeFns: Array<() => void> = [];

  /**
   * @param marketDiscovery - Сервис поиска рынков (TODO: интерфейс)
   * @param strategyFactory - Фабрика стратегий
   * @param metricsProjector - Metrics projector для отслеживания метрик
   * @param removalPolicy - PLUGGABLE policy "когда удалять"
   * @param config - Конфигурация координатора
   * @param eventBus - Event bus для подписки на StrategyTick
   * @param executionAdapter - Execution adapter
   * @param orderbookProjector - Orderbook projector для dynamic pricing (v5 БЛОКЕР 2)
   * @param wsSubscriber - WebSocket subscriber для подписки на новые рынки (v5.2)
   * @param reconciliationService - Order reconciliation service для gatekeeper (v6.3)
   * @param logger - Logger
   */
  constructor(
    private readonly marketDiscovery: any, // TODO: MarketDiscoveryService type
    private readonly strategyFactory: IStrategyFactory,
    private readonly metricsProjector: IStrategyMetricsProjector,
    private readonly portfolioProjector: any, // ✅ v7.7.17: GLOBAL source of truth (IPortfolioProjector)
    private readonly removalPolicy: IRemovalPolicy, // ✅ PLUGGABLE policy (v4.1)
    private readonly config: MultiStrategyConfig,
    private readonly eventBus: IEventBus,
    private readonly executionAdapter: IExecutionAdapter,
    private readonly orderbookProjector: IOrderbookProjector, // ✅ v5 (БЛОКЕР 2): Dynamic pricing
    private readonly wsSubscriber: IWebSocketSubscriber, // ✅ v5.2: Для подписки на новые рынки
    private readonly reconciliationService: { hasPendingOrders(strategyId: string): boolean }, // ✅ v6.3: GATEKEEPER!
    private readonly logger: ILogger
  ) {
    // ✅ v4.2: Вычисляем N тиков из конфига
    // Например: scanIntervalMs=10000, tickIntervalMs=1000 → SCAN_EVERY_N_TICKS = 10
    this.SCAN_EVERY_N_TICKS = Math.ceil(
      config.scanIntervalMs / config.tickIntervalMs
    );
    this.POLICY_CHECK_EVERY_N_TICKS = Math.ceil(
      config.removalCheckIntervalMs / config.tickIntervalMs
    );

    // Initialize totalBalance (will be set in start())
    this.totalBalance = Money.fromUSDC(0); // Temporary, will be set in start()
  }

  /**
   * Запустить координатор (event-driven)
   *
   * @param totalBalance - Общий баланс
   *
   * @remarks
   * v4.2 алгоритм:
   * 1. Первичный поиск рынков
   * 2. Подписка на StrategyTick (event-driven!)
   * 3. NO setInterval (только реакция на события)
   */
  async start(totalBalance: Money): Promise<void> {
    this.totalBalance = totalBalance;
    this.logger.info('[MultiStrategyCoordinator] Starting', {
      balance: totalBalance.amount,
      maxConcurrent: this.config.maxConcurrentStrategies,
    });

    // Первичный поиск рынков
    await this.tryAddStrategiesFromDiscovery();

    // ✅ v4.2: Подписаться на StrategyTick (event-driven!)
    this.unsubscribeFns.push(
      this.eventBus.subscribe('StrategyTick', (envelope) => {
        this.onStrategyTick(envelope.payload as StrategyTick);
      })
    );

    // Подписаться на OrderRejected для логирования (НЕ останавливаем стратегию автоматически!)
    this.unsubscribeFns.push(
      this.eventBus.subscribe('OrderRejected', (envelope) => {
        const event = envelope.payload as any;
        this.logger.error('[MultiStrategyCoordinator] Order rejected - strategy will handle retry', {
          strategyId: event.strategyId,
          orderId: event.orderId,
          reason: event.reason,
        });

        // TODO: Анализировать причину:
        // - "Insufficient USDC" → уменьшить размер
        // - "Size below minimum" → увеличить размер или изменить цену
        // - "Duplicated" → пропустить retry
        // Пока что логируем, стратегия перейдет в STOPPED и остановится
      })
    );

    this.logger.info('[MultiStrategyCoordinator] Started', {
      strategies: this.strategies.size,
    });
  }

  /**
   * Остановить координатор
   *
   * @remarks
   * Алгоритм:
   * 1. Отписаться от StrategyTick
   * 2. Остановить все стратегии
   */
  async stop(): Promise<void> {
    this.logger.info('[MultiStrategyCoordinator] Stopping all strategies');

    // ✅ v4.2: Отписаться от всех событий
    for (const unsubscribe of this.unsubscribeFns) {
      unsubscribe();
    }
    this.unsubscribeFns = [];

    // Остановить все стратегии
    for (const [strategyId, _instance] of this.strategies) {
      await this.removeStrategy(strategyId, 'MANUAL');
    }

    this.logger.info('[MultiStrategyCoordinator] Stopped');
  }

  /**
   * Обработка StrategyTick (event-driven coordinator)
   *
   * @param tick - StrategyTick event
   *
   * @remarks
   * ✅ v4.2: Coordinator управляется событиями, НЕ временем!
   * Каждый tick → проверка счётчиков → периодические действия.
   *
   * Алгоритм:
   * 1. Увеличить tickCounter
   * 2. Если tickCounter % SCAN_EVERY_N_TICKS === 0 → scan
   * 3. Если tickCounter % POLICY_CHECK_EVERY_N_TICKS === 0 → check policy
   */
  private onStrategyTick(_tick: StrategyTick): void {
    this.tickCounter++;

    // Scan каждые N тиков
    if (this.tickCounter % this.SCAN_EVERY_N_TICKS === 0) {
      this.tryAddStrategiesFromDiscovery().catch((err) => {
        this.logger.error('[MultiStrategyCoordinator] Scan error', err);
      });
    }

    // Policy check каждые M тиков
    if (this.tickCounter % this.POLICY_CHECK_EVERY_N_TICKS === 0) {
      this.checkRemovalPolicy();
    }
  }

  /**
   * Попытка добавить стратегии из discovery
   *
   * @remarks
   * Алгоритм:
   * 1. Проверить сколько слотов осталось
   * 2. Найти рынки через MarketDiscoveryService
   * 3. Фильтровать уже активные рынки
   * 4. Распределить баланс
   * 5. Создать стратегии
   */
  private async tryAddStrategiesFromDiscovery(): Promise<void> {
    const remainingSlots = this.calculateRemainingSlots();
    if (remainingSlots <= 0) {
      this.logger.debug('[MultiStrategyCoordinator] No remaining slots');
      return;
    }

    // 1. Найти рынки через MarketDiscoveryService
    const result = await this.marketDiscovery.findBestMarket();
    if (result.candidates.length === 0) {
      this.logger.debug('[MultiStrategyCoordinator] No market candidates found');
      return;
    }

    // 2. Фильтр активных рынков (не торгуем на одном рынке дважды)
    const activeMarketIds = new Set(
      Array.from(this.strategies.values()).map(s => s.marketId)
    );
    const newCandidates = result.candidates
      .filter((c: MarketCandidate) => !activeMarketIds.has(c.conditionId))
      .slice(0, remainingSlots);

    if (newCandidates.length === 0) {
      this.logger.debug('[MultiStrategyCoordinator] No new candidates after filtering');
      return;
    }

    this.logger.info('[MultiStrategyCoordinator] Found new market candidates', {
      totalCandidates: result.candidates.length,
      newCandidates: newCandidates.length,
      remainingSlots,
    });

    // 3. Распределить баланс
    const allocations = this.allocateBalance(
      newCandidates.map((c: MarketCandidate) => c.conditionId)
    );

    // 4. Создать стратегии
    for (const candidate of newCandidates) {
      const balance = allocations.get(candidate.conditionId);
      if (!balance) {
        this.logger.warn('[MultiStrategyCoordinator] No balance allocated for market', {
          marketId: candidate.conditionId,
        });
        continue;
      }

      await this.addStrategyForMarket(candidate, balance);
    }
  }

  /**
   * Добавить стратегию для рынка
   *
   * @param candidate - MarketCandidate
   * @param balance - Выделенный баланс
   *
   * @remarks
   * Алгоритм (Фаза 3.1):
   * 1. Создать стратегию через factory
   * 2. Создать clock (LiveClock для LIVE mode)
   * 3. Создать context (StrategyContextImpl)
   * 4. Создать executor (StrategyExecutor)
   * 5. Создать portfolio projector
   * 6. Создать runner (StrategyRunner)
   * 7. Зарегистрировать instance
   * 8. Зарегистрировать в metrics projector
   * 9. Запустить runner
   */
  private async addStrategyForMarket(
    candidate: MarketCandidate,
    balance: Money
  ): Promise<void> {
    this.logger.info('[MultiStrategyCoordinator] Adding strategy for market', {
      marketId: candidate.conditionId,
      question: candidate.question,
      balance: balance.amount,
    });

    // Declare variables outside try block for cleanup in catch
    let strategyId: string | undefined;

    try {
      // 1. Создать стратегию через factory (✅ v6.0: async для получения constraints)
      const { strategy } = await this.strategyFactory.createStrategy(
        candidate,
        this.config.strategyFactoryConfig
      );

      strategyId = strategy.id;

      // 1.5. ✅ v5.2: Подписаться на WebSocket orderbook для нового рынка!
      // КРИТИЧНО: Polymarket требует ПЕРЕПОДКЛЮЧЕНИЯ для изменения подписок!
      // Без этого getBestBid/getBestAsk вернут null и ордера не будут размещены!
      const newTokenIds = candidate.outcomes.map((o) => o.tokenId);

      // Собрать все токены от активных стратегий + новые
      const allTokenIds = this.collectAllActiveTokenIds();
      for (const tokenId of newTokenIds) {
        if (!allTokenIds.includes(tokenId)) {
          allTokenIds.push(tokenId);
        }
      }

      this.logger.info('[MultiStrategyCoordinator] Subscribing to orderbook for new market', {
        strategyId,
        newTokenCount: newTokenIds.length,
        totalTokenCount: allTokenIds.length,
        newTokenIds: newTokenIds.map((id) => id.substring(0, 16) + '...'),
      });

      try {
        // ✅ v5.2: Переподключить WebSocket и подписаться на ВСЕ токены!
        this.logger.info('[MultiStrategyCoordinator] Reconnecting WebSocket for new subscriptions...');
        await this.wsSubscriber.reconnectForNewSubscription();

        this.logger.info('[MultiStrategyCoordinator] Subscribing to all tokens after reconnect', {
          tokenCount: allTokenIds.length,
        });
        await this.wsSubscriber.subscribeToTokens(allTokenIds);

        this.logger.info('[MultiStrategyCoordinator] WebSocket subscribed to all orderbooks');

        // Ждём 2 секунды чтобы получить orderbook данные
        await new Promise((resolve) => setTimeout(resolve, 2000));
        this.logger.info('[MultiStrategyCoordinator] Orderbook data ready for new market');
      } catch (wsError) {
        this.logger.error('[MultiStrategyCoordinator] Failed to subscribe to orderbook', wsError);
        // Продолжаем - может orderbook уже подписан
      }

      // 2. Создать clock (LiveClock для LIVE mode)
      const clock = new LiveClock();

      // ✅ v7.7.17: Зарегистрировать стратегию в ГЛОБАЛЬНОМ PortfolioProjector!
      // PortfolioProjector - source of truth для fills + orders + inventory
      const tokenId = candidate.outcomes[0]?.tokenId || 'unknown';
      this.portfolioProjector.registerStrategy(strategy.id, tokenId);
      this.logger.info('[MultiStrategyCoordinator] Strategy registered in PortfolioProjector', {
        strategyId: strategy.id.substring(0, 40) + '...',
        tokenId: tokenId.substring(0, 12) + '...',
      });

      // 3. Создать context (StrategyContextImpl)
      // ✅ v5 (БЛОКЕР 2): Передаём orderbookProjector для dynamic pricing
      // ✅ v5.2: environment из конфига (для PAPER mode = виртуальные fills)
      // ✅ v5.2: eventBus и executionContext для PAPER mode симуляции
      // ✅ v5.4: strategyId для корректной маршрутизации событий
      // ✅ v6.3: reconciliationService для gatekeeper проверки pending orders
      // ✅ v7.7.17: GLOBAL portfolioProjector - source of truth!
      // ⚠️ v7.6: Using GLOBAL executionAdapter (Domain IExecutionAdapter)
      //     TODO: Create strategy-specific adapter once interface mismatch is resolved
      //     Current blocker: Domain IExecutionAdapter vs Infrastructure IExecutionAdapter
      const executionContext = { environment: this.config.environment, accountId: 'main' };
      const context = new StrategyContextImpl(
        this.executionAdapter, // ⚠️ Global adapter (Domain IExecutionAdapter - has placeOrder, subscribeToOrderUpdates)
        this.config.environment, // ✅ Из конфига, не hardcoded!
        clock,
        this.orderbookProjector, // ✅ v5 (БЛОКЕР 2): Dynamic pricing
        this.eventBus, // ✅ v5.2: Для PAPER mode симуляции
        executionContext, // ✅ v5.2: Для envelope creation
        strategy.id, // ✅ v5.4: Для корректной маршрутизации событий
        undefined, // tradeAccumulator (optional)
        this.reconciliationService, // ✅ v6.3: Gatekeeper - единственный источник истины!
        this.portfolioProjector, // ✅ v7.7.17: GLOBAL portfolioProjector - source of truth!
        this.metricsProjector // ✅ v7.7.16: Strategy self-sufficiency! Получает orders/fills из MetricsProjector!
      );

      // 3.5 ✅ v5.3: Подписаться на трейды для trade-based fill detection
      // ✅ v7.7.17: КРИТИЧНО - подписываемся на trades в LIVE mode тоже!
      // Trades - первичный источник данных, Position API только для verification!
      if (this.wsSubscriber?.subscribeToTrades) {
        const tokenId = candidate.outcomes[0]?.tokenId;
        if (tokenId) {
          // ✅ v5.4 FIX: subscribeToTrades теперь возвращает нормализованные данные
          this.wsSubscriber.subscribeToTrades(tokenId, (trade) => {
            context.addTrade(tokenId, trade);
          });
          this.logger.info('[MultiStrategyCoordinator] Subscribed to trades for fill detection', {
            tokenId: tokenId.substring(0, 16) + '...',
            environment: this.config.environment,
          });
        }
      }

      // 4. Создать executor
      const executor = new StrategyExecutor(this.logger);

      // TODO: Создать PnL calculator (нужен для UI)
      // const pnlCalculator = new PnLCalculator();

      // 6. Создать runner
      // ✅ v4.2 CRITICAL FIX: Передаём projectors в runner!
      const runner = new StrategyRunner(
        strategy,
        context,
        executor,
        this.eventBus,
        executionContext, // ✅ v5.2: Переиспользуем созданный выше
        this.config.tickIntervalMs,
        this.logger,
        this.metricsProjector, // ✅ Metrics будут обновляться!
        this.portfolioProjector // ✅ v7.7.17: GLOBAL portfolioProjector!
      );

      // 7. Зарегистрировать instance
      const instance: StrategyInstance = {
        strategyId: strategy.id,
        runner,
        strategy,
        context,
        portfolioProjector: this.portfolioProjector, // ✅ v7.7.17: GLOBAL portfolioProjector
        marketId: candidate.conditionId,
        marketQuestion: candidate.question,
        allocatedBalance: balance,
        status: 'ACTIVE',
        startedAt: clock.now(), // ✅ FIXED: Детерминированное время из clock!
        // v5.2: Для проверки истечения рынка
        // NOTE: MarketCandidate из market-discovery имеет endDate, не expirationDate
        expirationDate: (candidate as any).endDate || candidate.expirationDate,
        tokenIds: newTokenIds, // ✅ v5.2: Для WebSocket переподключения
      };

      this.strategies.set(strategy.id, instance);

      // 8. Зарегистрировать в metrics projector (с tokenId и outcomeName для отображения)
      // ✅ tokenId уже объявлен выше (строка 660) - используем его!
      const outcomeName = candidate.outcomes[0]?.outcome; // ✅ v5.5: Имя outcome (e.g., "Up", "Down")
      this.metricsProjector.registerStrategy(
        strategy.id,
        candidate.question,
        this.portfolioProjector, // ✅ v7.7.17: GLOBAL portfolioProjector
        tokenId, // ✅ tokenId для получения orderbook данных
        outcomeName // ✅ v5.5: outcomeName для отображения в fills
      );

      // 9. Запустить runner
      runner.start();

      this.logger.info('[MultiStrategyCoordinator] Strategy started', {
        strategyId: strategy.id,
        expirationDate: instance.expirationDate?.toISOString() || 'NOT SET',
        hasExpirationDate: !!instance.expirationDate,
      });
    } catch (error) {
      this.logger.error('[MultiStrategyCoordinator] Failed to start strategy', {
        marketId: candidate.conditionId,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
        error,
      });

      // ✅ Cleanup: Если стратегия уже добавлена, удалить её
      if (strategyId && this.strategies.has(strategyId)) {
        this.strategies.delete(strategyId);
        this.metricsProjector.unregisterStrategy(strategyId);
      }
    }
  }

  /**
   * Удалить стратегию
   *
   * @param strategyId - ID стратегии
   * @param reason - Причина удаления
   *
   * @remarks
   * Алгоритм:
   * 1. Остановить runner
   * 2. Получить финальный PnL через PortfolioProjector
   * 3. Освободить баланс (allocated + realized PnL возвращается в totalBalance)
   * 4. Удалить instance из metrics projector
   * 5. Удалить instance
   */
  private async removeStrategy(
    strategyId: string,
    reason: 'EXPIRED' | 'ERROR' | 'MANUAL' | string
  ): Promise<void> {
    const instance = this.strategies.get(strategyId);
    if (!instance) return;

    this.logger.info('[MultiStrategyCoordinator] Removing strategy', {
      strategyId,
      reason,
    });

    // 0. v5.2: Отменить активный ордер (если есть)
    const currentOrderId = instance.strategy.getCurrentOrderId?.();
    if (currentOrderId) {
      this.logger.info('[MultiStrategyCoordinator] Cancelling active order', {
        strategyId,
        orderId: currentOrderId,
      });
      instance.context.cancelOrder(currentOrderId);
    }

    // 1. Остановить runner
    instance.runner.stop();
    instance.status = 'STOPPED';

    // 2. Получить финальный realized PnL через PortfolioProjector
    let totalRealizedPnL = 0;
    const positions = instance.portfolioProjector.getPositions();
    for (const pos of positions.values()) {
      totalRealizedPnL += pos.realizedPnL;
    }

    // 3. Освободить баланс (allocated + realized PnL)
    const allocatedUSDC = instance.allocatedBalance.amount;
    const returnedUSDC = allocatedUSDC + totalRealizedPnL;

    // Обновить total balance (баланс + PnL возвращается)
    const newTotalUSDC = this.totalBalance.amount + totalRealizedPnL;
    this.totalBalance = Money.fromUSDC(newTotalUSDC);

    // 4. Удалить из metrics projector
    this.metricsProjector.unregisterStrategy(strategyId);

    // 5. Удалить instance
    this.strategies.delete(strategyId);

    this.logger.info('[MultiStrategyCoordinator] Strategy removed', {
      strategyId,
      realizedPnL: totalRealizedPnL,
      returnedBalance: returnedUSDC,
    });
  }

  /**
   * Рассчитать оставшиеся слоты для стратегий
   *
   * @returns Количество слотов
   */
  private calculateRemainingSlots(): number {
    const active = Array.from(this.strategies.values()).filter(
      (s) => s.status === 'ACTIVE'
    ).length;

    return Math.max(0, this.config.maxConcurrentStrategies - active);
  }

  /**
   * Собрать все tokenIds от активных стратегий
   *
   * @returns Массив всех tokenIds
   *
   * @remarks
   * v5.2: Нужно для WebSocket переподключения.
   * При добавлении новой стратегии нужно переподписаться на ВСЕ токены.
   */
  private collectAllActiveTokenIds(): string[] {
    const allTokenIds: string[] = [];

    for (const instance of this.strategies.values()) {
      if (instance.status === 'ACTIVE' && instance.tokenIds) {
        for (const tokenId of instance.tokenIds) {
          if (!allTokenIds.includes(tokenId)) {
            allTokenIds.push(tokenId);
          }
        }
      }
    }

    return allTokenIds;
  }

  /**
   * Распределить баланс по рынкам
   *
   * @param marketIds - Список ID рынков
   * @returns Map<marketId, Money> - Распределение баланса
   *
   * @remarks
   * Простая стратегия: равномерное распределение свободного баланса.
   * В будущем: адаптивное распределение на основе volatility, volume, etc.
   *
   * Алгоритм:
   * 1. Получить свободный баланс
   * 2. Разделить поровну на количество рынков
   * 3. Проверить минимальный капитал (minCapitalPerMarket)
   * 4. Вернуть только те рынки, которые проходят минимум
   */
  private allocateBalance(marketIds: string[]): Map<string, Money> {
    const freeBalance = this.getFreeBalance();
    const perMarketUSDC = freeBalance.amount / marketIds.length;

    const allocations = new Map<string, Money>();

    for (const marketId of marketIds) {
      if (perMarketUSDC >= this.config.minCapitalPerMarket) {
        allocations.set(marketId, Money.fromUSDC(perMarketUSDC));
      }
    }

    return allocations;
  }

  /**
   * Проверка removal policy для всех стратегий
   *
   * @remarks
   * ✅ ПРАВИЛЬНО: Исполняет ВНЕШНЮЮ pluggable policy
   * ❌ НЕПРАВИЛЬНО: Hardcoded logic "когда удалять"
   *
   * Coordinator НЕ принимает решений, он исполняет policy!
   *
   * v5.2: После удаления стратегии сразу ищем новый рынок
   */
  private checkRemovalPolicy(): void {
    let strategiesRemoved = 0;

    for (const [strategyId, instance] of this.strategies) {
      // ✅ Policy решает, НЕ Coordinator!
      const removalReason = this.removalPolicy.shouldRemove(instance);

      if (removalReason) {
        this.logger.info('[MultiStrategyCoordinator] Removal policy triggered', {
          strategyId,
          reason: removalReason,
        });

        this.removeStrategy(strategyId, removalReason);
        strategiesRemoved++;
      }
    }

    // ✅ v5.2: Если удалили стратегии - сразу ищем новые рынки
    if (strategiesRemoved > 0) {
      this.logger.info('[MultiStrategyCoordinator] Strategies removed, searching for new markets', {
        removedCount: strategiesRemoved,
        remainingSlots: this.calculateRemainingSlots(),
        totalStrategies: this.strategies.size,
      });

      // Запускаем поиск новых рынков синхронно чтобы сразу переключиться
      this.tryAddStrategiesFromDiscovery()
        .then(() => {
          this.logger.info('[MultiStrategyCoordinator] New market search completed', {
            activeStrategies: this.strategies.size,
          });
        })
        .catch((err) => {
          this.logger.error('[MultiStrategyCoordinator] Failed to add new strategies after removal', err);
        });
    }
  }

  /**
   * Получить статус координатора
   *
   * @returns Агрегированный статус
   */
  getStatus(): MultiStrategyStatus {
    const instances = Array.from(this.strategies.values());

    // Вычислить totalRealizedPnL через PortfolioProjector
    let totalRealizedPnL = 0;
    for (const instance of instances) {
      const positions = instance.portfolioProjector.getPositions();
      for (const pos of positions.values()) {
        totalRealizedPnL += pos.realizedPnL;
      }
    }

    return {
      totalStrategies: instances.length,
      activeStrategies: instances.filter((s) => s.status === 'ACTIVE').length,
      stoppedStrategies: instances.filter((s) => s.status === 'STOPPED').length,
      errorStrategies: instances.filter((s) => s.status === 'ERROR').length,
      totalRealizedPnL,
      totalAllocatedBalance: instances.reduce(
        (sum, s) => sum + s.allocatedBalance.amount,
        0
      ),
      freeBalance: this.getFreeBalance().amount,
    };
  }

  /**
   * Получить свободный баланс
   *
   * @returns Свободный баланс (total - allocated)
   *
   * @remarks
   * Вычисляет: total balance - allocated balance по всем стратегиям
   */
  private getFreeBalance(): Money {
    const instances = Array.from(this.strategies.values());
    const totalAllocated = instances.reduce(
      (sum, s) => sum + s.allocatedBalance.amount,
      0
    );

    const freeUSDC = this.totalBalance.amount - totalAllocated;

    return Money.fromUSDC(Math.max(0, freeUSDC));
  }

  /**
   * Получить все активные token IDs для подписки на WebSocket
   *
   * @returns Array of token IDs для всех активных стратегий
   *
   * @remarks
   * Используется для подписки WebSocket на orderbook данные.
   * Возвращает tokenId из каждого DumbStrategyConfig.
   */
  getActiveTokenIds(): string[] {
    const tokenIds: string[] = [];

    for (const instance of this.strategies.values()) {
      if (instance.status === 'ACTIVE') {
        // Получаем tokenId из strategy config
        const strategy = instance.strategy as any;
        if (strategy.config && strategy.config.tokenId) {
          tokenIds.push(strategy.config.tokenId);
        }
      }
    }

    return tokenIds;
  }

  /**
   * Notify all active strategies about orderbook update
   *
   * @param tokenId - Token ID that was updated (optional, for filtering)
   *
   * @remarks
   * v5.5: Event-driven orderbook fill detection!
   *
   * Вызывается при получении orderbook update из WebSocket.
   * Для каждой активной стратегии вызывает checkOrderbookFill()
   * на её context, чтобы проверить можно ли заполнить ордер.
   *
   * Логика fill detection:
   * - BUY order @ X: если best ASK <= X → fill
   * - SELL order @ X: если best BID >= X → fill
   *
   * @example
   * ```typescript
   * // В main.ts при получении orderbook update:
   * wsManager.on('orderbook', (data: any) => {
   *   orderbookProjector.project(data);
   *   coordinator.notifyOrderbookUpdate(data.asset_id);
   * });
   * ```
   */
  notifyOrderbookUpdate(tokenId?: string): void {
    // В LIVE mode не проверяем виртуальные fills
    if (this.config.environment === 'LIVE') {
      return;
    }

    for (const instance of this.strategies.values()) {
      if (instance.status !== 'ACTIVE') continue;

      // Если передан tokenId, фильтруем по нему
      if (tokenId && instance.tokenIds && !instance.tokenIds.includes(tokenId)) {
        continue;
      }

      // ✅ v5.5: Вызываем checkOrderbookFill() на context
      const ctx = instance.context as StrategyContextImpl;
      if (ctx.checkOrderbookFill) {
        ctx.checkOrderbookFill();
      }
    }
  }

  /**
   * v6.4: Синхронизировать позиции стратегии с реальными данными биржи
   *
   * @param strategyId - Strategy ID
   * @param realPositions - Реальные positions с биржи (из getPositions API)
   *
   * @remarks
   * **КРИТИЧНО**: НЕ гадаем что произошло - синхронизируемся с реальностью!
   *
   * Алгоритм:
   * 1. Находим StrategyInstance по strategyId
   * 2. Для каждой позиции вызываем portfolioProjector.syncPosition()
   * 3. Логируем результаты синхронизации
   *
   * @example
   * ```typescript
   * // OrderRejected: "insufficient balance"
   * const realPositions = await getPositions();
   * coordinator.syncPositions(strategyId, realPositions);
   * // → PortfolioProjector corrected
   * ```
   */
  syncPositions(strategyId: string, realPositions: Array<{ tokenId: string; balance: number }>): void {
    const instance = this.strategies.get(strategyId);

    if (!instance) {
      this.logger.warn('[MultiStrategyCoordinator] Cannot sync positions - strategy not found', {
        strategyId,
      });
      return;
    }

    this.logger.info('[MultiStrategyCoordinator] Syncing positions with exchange', {
      strategyId,
      positionsCount: realPositions.length,
    });

    // Синхронизируем каждую позицию
    for (const pos of realPositions) {
      instance.portfolioProjector.syncPosition(pos.tokenId, pos.balance);
    }

    // Также проверяем что позиции которых НЕТ в realPositions = 0
    const currentPositions = instance.portfolioProjector.getPositions();
    const realTokenIds = new Set(realPositions.map((p) => p.tokenId));

    for (const [tokenId, currentPos] of currentPositions.entries()) {
      if (!realTokenIds.has(tokenId) && currentPos.quantity > 0) {
        // Позиция есть внутри, но НЕТ на бирже → синхронизируем к 0
        this.logger.warn('[MultiStrategyCoordinator] Position exists internally but not on exchange - syncing to 0', {
          strategyId,
          tokenId: tokenId.substring(0, 16) + '...',
          internalQuantity: currentPos.quantity,
        });

        instance.portfolioProjector.syncPosition(tokenId, 0);
      }
    }

    this.logger.info('[MultiStrategyCoordinator] Positions synced', {
      strategyId,
    });
  }
}
