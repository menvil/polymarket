/**
 * Multi-Market Trader - координатор торговли на нескольких маркетах
 *
 * @remarks
 * Управляет одновременной торговлей на нескольких маркетах Polymarket.
 * Обеспечивает:
 * - Подписку на несколько маркетов одновременно
 * - Изолированное состояние для каждого маркета
 * - Автоматическое распределение капитала
 * - Мониторинг истечения маркетов
 * - Автоматическую ротацию маркетов
 *
 * Архитектура:
 * ```
 * MultiMarketTrader
 *   ├── BalanceAllocator (распределение капитала)
 *   ├── MarketDiscoveryService (поиск маркетов)
 *   └── MarketContext[] (изолированные контексты)
 *         ├── MarketContext #1
 *         │     └── MainTradingOrchestrator
 *         ├── MarketContext #2
 *         │     └── MainTradingOrchestrator
 *         └── MarketContext #N
 *               └── MainTradingOrchestrator
 * ```
 *
 * @example
 * ```typescript
 * const trader = new MultiMarketTrader(
 *   marketDiscovery,
 *   orchestratorFactory,
 *   config,
 *   logger
 * );
 *
 * await trader.start(Money.fromUSDC(1000));
 *
 * // Later...
 * await trader.stop();
 * ```
 */

import { Market } from '../../domain/entities/Market.js';
import { Money } from '../../domain/value-objects/Money.js';
import { ILogger } from '../../domain/ports/ILogger.js';
import { IMarketDiscoveryService, MarketCandidate } from '../../domain/services/market-discovery/types.js';
import { BalanceAllocator } from './BalanceAllocator.js';
import { DataCollectorService } from './DataCollectorService.js';
import {
  MarketContext,
  MultiMarketConfig,
  MultiMarketStatus,
  MarketStatusInfo,
  OrchestratorFactory,
  AddMarketResult,
  RemoveMarketResult,
  MultiMarketEvent,
  MultiMarketEventHandler,
} from './types/multi-market.js';

/**
 * Multi-Market Trader
 *
 * @remarks
 * Координирует торговлю на нескольких маркетах одновременно.
 * Каждый маркет имеет изолированный контекст с собственным orchestrator.
 *
 * Основные функции:
 * - start(): Запуск торговли с автоматическим discovery
 * - stop(): Остановка всех маркетов
 * - addMarket(): Добавление маркета вручную
 * - removeMarket(): Удаление маркета
 * - getStatus(): Получение статуса всех маркетов
 */
export class MultiMarketTrader {
  private readonly activeMarkets: Map<string, MarketContext> = new Map();
  private readonly marketDiscovery: IMarketDiscoveryService;
  private readonly orchestratorFactory: OrchestratorFactory;
  private readonly config: MultiMarketConfig;
  private readonly logger: ILogger;
  private readonly dataCollector: DataCollectorService | null;
  private readonly eventHandlers: MultiMarketEventHandler[] = [];
  private readonly recentErrors: string[] = [];
  private readonly maxRecentErrors = 10;

  private balanceAllocator: BalanceAllocator | null = null;
  private isRunning = false;
  private scanTimer: NodeJS.Timeout | null = null;
  private expiryCheckTimer: NodeJS.Timeout | null = null;
  private lastScanAt: Date | null = null;
  private nextScanAt: Date | null = null;

  /**
   * Создаёт новый MultiMarketTrader
   *
   * @param marketDiscovery - Сервис поиска маркетов
   * @param orchestratorFactory - Фабрика для создания orchestrator'ов
   * @param config - Конфигурация multi-market trading
   * @param logger - Логгер
   * @param dataCollector - Опциональный сервис сбора данных
   *
   * @example
   * ```typescript
   * const trader = new MultiMarketTrader(
   *   marketDiscovery,
   *   () => new MainTradingOrchestrator({...}),
   *   {
   *     maxConcurrentMarkets: 5,
   *     tradingBalanceRatio: 0.8,
   *     minCapitalPerMarket: 10,
   *     scanPauseMs: 30000,
   *     expiryCheckIntervalMs: 1000
   *   },
   *   logger,
   *   dataCollector  // optional
   * );
   * ```
   */
  constructor(
    marketDiscovery: IMarketDiscoveryService,
    orchestratorFactory: OrchestratorFactory,
    config: MultiMarketConfig,
    logger: ILogger,
    dataCollector?: DataCollectorService | null
  ) {
    this.marketDiscovery = marketDiscovery;
    this.orchestratorFactory = orchestratorFactory;
    this.config = config;
    this.logger = logger;
    this.dataCollector = dataCollector ?? null;

    this.logger.info('MultiMarketTrader initialized', {
      maxConcurrentMarkets: config.maxConcurrentMarkets,
      tradingBalanceRatio: config.tradingBalanceRatio,
      minCapitalPerMarket: config.minCapitalPerMarket,
      scanPauseMs: config.scanPauseMs,
      expiryCheckIntervalMs: config.expiryCheckIntervalMs,
      dataCollectionEnabled: this.dataCollector?.isEnabled() ?? false,
    });
  }

  /**
   * Запускает multi-market trading
   *
   * @param totalBalance - Общий баланс для торговли
   *
   * @remarks
   * Алгоритм:
   * 1. Инициализировать BalanceAllocator
   * 2. Выполнить market discovery
   * 3. Распределить баланс между маркетами
   * 4. Создать MarketContext для каждого маркета
   * 5. Запустить orchestrator'ы
   * 6. Запустить expiry monitoring
   * 7. Запустить периодическое сканирование
   *
   * @throws {Error} Если нет доступных маркетов
   *
   * @example
   * ```typescript
   * await trader.start(Money.fromUSDC(1000));
   * console.log('Trading started on multiple markets');
   * ```
   */
  async start(totalBalance: Money): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('MultiMarketTrader already running');
      return;
    }

    this.logger.info('Starting MultiMarketTrader', {
      totalBalance: totalBalance.amount,
    });

    // 1. Initialize DataCollector (if enabled)
    if (this.dataCollector?.isEnabled()) {
      await this.dataCollector.initialize();
    }

    // 2. Initialize BalanceAllocator
    this.balanceAllocator = new BalanceAllocator(
      totalBalance,
      {
        tradingBalanceRatio: this.config.tradingBalanceRatio,
        minCapitalPerMarket: this.config.minCapitalPerMarket,
        maxConcurrentMarkets: this.config.maxConcurrentMarkets,
      },
      this.logger
    );

    // 3. Mark as running FIRST (so periodic scan works)
    this.isRunning = true;

    // 4. Start expiry monitoring
    this.startExpiryMonitoring();

    // 5. Start periodic scanning (will find markets)
    this.startPeriodicScan();

    // 6. Try initial market discovery
    this.logger.info('Scanning for markets...');
    await this.tryAddMarketsFromDiscovery();

    // 7. Log status
    if (this.activeMarkets.size === 0) {
      this.logger.warn('No suitable markets found - waiting for markets to appear');
      this.logger.info('Will continue scanning every ' + this.config.scanPauseMs + 'ms');
    } else {
      this.logger.info('MultiMarketTrader started', {
        activeMarkets: this.activeMarkets.size,
      });
    }
  }

  /**
   * Пытается найти и добавить маркеты из discovery
   *
   * @remarks
   * Не выбрасывает ошибку если маркеты не найдены.
   * Используется при старте и периодическом сканировании.
   *
   * Алгоритм:
   * 1. Проверить, есть ли свободные слоты (maxConcurrentMarkets - activeMarkets.size)
   * 2. Если слотов нет - пропустить
   * 3. Найти маркеты через discovery
   * 4. Отфильтровать уже активные
   * 5. Ограничить количество кандидатов до оставшихся слотов
   * 6. Распределить баланс и добавить маркеты
   */
  private async tryAddMarketsFromDiscovery(): Promise<void> {
    if (!this.balanceAllocator) {
      return;
    }

    // Check remaining slots (0 = unlimited)
    const maxMarkets = this.config.maxConcurrentMarkets;
    const currentCount = this.activeMarkets.size;
    const remainingSlots = maxMarkets === 0 ? Infinity : maxMarkets - currentCount;

    if (remainingSlots <= 0) {
      this.logger.debug('At max capacity, skipping market discovery', {
        maxConcurrentMarkets: maxMarkets,
        activeMarkets: currentCount,
      });
      return;
    }

    try {
      const discoveryResult = await this.marketDiscovery.findBestMarket();

      if (discoveryResult.candidates.length === 0) {
        this.logger.debug('No markets found in discovery', {
          totalFetched: discoveryResult.totalFetched,
          totalFiltered: discoveryResult.totalFiltered,
        });
        return;
      }

      this.logger.info('Markets discovered', {
        totalFetched: discoveryResult.totalFetched,
        totalFiltered: discoveryResult.totalFiltered,
        candidates: discoveryResult.candidates.length,
        remainingSlots: remainingSlots === Infinity ? 'unlimited' : remainingSlots,
      });

      // Filter out already active markets
      const activeIds = new Set(this.activeMarkets.keys());
      let newCandidates = discoveryResult.candidates.filter(
        (c) => !activeIds.has(c.conditionId)
      );

      if (newCandidates.length === 0) {
        this.logger.debug('All discovered markets already active');
        return;
      }

      // Limit candidates to remaining slots
      if (remainingSlots !== Infinity && newCandidates.length > remainingSlots) {
        this.logger.info('Limiting candidates to remaining slots', {
          availableCandidates: newCandidates.length,
          remainingSlots,
        });
        newCandidates = newCandidates.slice(0, remainingSlots);
      }

      // Allocate balance to new markets using allocateToNewMarkets
      // This distributes ALL free balance to new markets (above minimum)
      const marketIds = newCandidates.map((c) => c.conditionId);
      const slotsAvailable = remainingSlots === Infinity ? marketIds.length : remainingSlots;
      const allocationResult = this.balanceAllocator.allocateToNewMarkets(marketIds, slotsAvailable);

      if (allocationResult.marketCount === 0) {
        this.logger.warn('Insufficient balance for any market');
        return;
      }

      this.logger.info('Balance allocated', {
        requestedMarkets: allocationResult.requestedMarketCount,
        allocatedMarkets: allocationResult.marketCount,
        perMarketBalance: allocationResult.perMarketBalance.amount,
        wasLimitedByMinCapital: allocationResult.wasLimitedByMinCapital,
      });

      // Add markets
      const allocatedMarketIds = Array.from(allocationResult.allocations.keys());

      for (const marketId of allocatedMarketIds) {
        const candidate = newCandidates.find((c) => c.conditionId === marketId);
        if (!candidate) continue;

        const allocation = allocationResult.allocations.get(marketId);
        if (!allocation) continue;

        await this.addMarketFromCandidate(candidate, allocation);
      }
    } catch (error) {
      this.logger.error('Error in market discovery', error);
      this.addError(`Discovery error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Останавливает multi-market trading
   *
   * @remarks
   * Алгоритм:
   * 1. Остановить таймеры (expiry check, scan)
   * 2. Остановить все orchestrator'ы
   * 3. Очистить active markets
   *
   * @example
   * ```typescript
   * await trader.stop();
   * console.log('Trading stopped');
   * ```
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      this.logger.warn('MultiMarketTrader not running');
      return;
    }

    this.logger.info('Stopping MultiMarketTrader...');

    // 1. Stop timers
    this.stopExpiryMonitoring();
    this.stopPeriodicScan();

    // 2. Stop all orchestrators
    const stopPromises: Promise<void>[] = [];
    for (const [marketId, context] of this.activeMarkets) {
      this.logger.info(`Stopping market: ${marketId}`);
      stopPromises.push(
        context.orchestrator.stop().catch((error) => {
          this.logger.error(`Failed to stop market ${marketId}`, error);
        })
      );
    }

    await Promise.allSettled(stopPromises);

    // 3. Close DataCollector (flushes all buffers and closes files)
    if (this.dataCollector?.isEnabled()) {
      await this.dataCollector.close();
    }

    // 4. Clear active markets
    this.activeMarkets.clear();
    this.isRunning = false;

    this.logger.info('MultiMarketTrader stopped');
  }

  /**
   * Добавляет маркет из MarketCandidate
   *
   * @param candidate - Кандидат маркета
   * @param allocatedBalance - Выделенный баланс
   * @returns Результат добавления
   */
  private async addMarketFromCandidate(
    candidate: MarketCandidate,
    allocatedBalance: Money
  ): Promise<AddMarketResult> {
    const marketId = candidate.conditionId;

    // Check if already exists
    if (this.activeMarkets.has(marketId)) {
      return {
        success: false,
        error: 'Market already active',
      };
    }

    try {
      // Create Market entity
      const market = Market.create({
        id: marketId,
        question: candidate.question,
        marketUrl: candidate.marketUrl,
        outcomes: candidate.outcomes,
        expirationDate: candidate.endDate,
        status: 'ACTIVE',
      });

      // Create orchestrator
      const orchestrator = this.orchestratorFactory();

      // Initialize orchestrator
      await orchestrator.initialize(market, allocatedBalance);

      // Start orchestrator
      await orchestrator.start();

      // Create context
      const context: MarketContext = {
        marketId,
        market,
        orchestrator,
        allocatedBalance,
        status: 'ACTIVE',
        startedAt: new Date(),
        lastUpdate: new Date(),
      };

      this.activeMarkets.set(marketId, context);

      // Register in DataCollector (if enabled)
      if (this.dataCollector?.isEnabled()) {
        this.dataCollector.registerMarket(candidate);
      }

      // Emit event
      this.emitEvent({
        type: 'MARKET_ADDED',
        marketId,
        question: market.question,
        allocatedBalance: allocatedBalance.amount,
        timestamp: new Date(),
      });

      this.logger.info('Market added', {
        marketId,
        question: market.question,
        allocatedBalance: allocatedBalance.amount,
        activeMarkets: this.activeMarkets.size,
      });

      return {
        success: true,
        marketId,
        allocatedBalance,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.addError(`Failed to add market ${marketId}: ${errorMessage}`);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Добавляет маркет вручную
   *
   * @param market - Market entity
   * @returns Результат добавления
   *
   * @remarks
   * Используется для добавления маркета вручную, минуя discovery.
   * Баланс выделяется через BalanceAllocator.
   */
  async addMarket(market: Market): Promise<AddMarketResult> {
    if (!this.isRunning || !this.balanceAllocator) {
      return {
        success: false,
        error: 'MultiMarketTrader not running',
      };
    }

    // Try to allocate balance
    const allocation = this.balanceAllocator.addMarket(market.id);
    if (!allocation) {
      return {
        success: false,
        error: 'Cannot allocate balance (capacity or capital limit)',
      };
    }

    // Create candidate-like object
    const candidate: MarketCandidate = {
      conditionId: market.id,
      question: market.question,
      marketUrl: market.marketUrl ?? '',
      endDate: market.expirationDate,
      timeToExpiry: market.expirationDate.getTime() - Date.now(),
      outcomes: [
        { tokenId: market.outcomes[0].tokenId, name: market.outcomes[0].name },
        { tokenId: market.outcomes[1].tokenId, name: market.outcomes[1].name },
      ],
      dailyVolume: 0,
      liquidity: 0,
      spread: 0,
      score: 0,
      rawData: {} as any,
    };

    return this.addMarketFromCandidate(candidate, allocation);
  }

  /**
   * Удаляет маркет с учётом PnL
   *
   * @param marketId - ID маркета
   * @param reason - Причина удаления
   * @param pnl - Profit/Loss от маркета (optional, default: 0)
   * @returns Результат удаления
   *
   * @remarks
   * При удалении маркета:
   * 1. Останавливает orchestrator
   * 2. Получает PnL (если передан или получаем от orchestrator)
   * 3. Освобождает allocation с учётом PnL
   * 4. Обновляет total balance (allocation + pnl возвращается в пул)
   */
  async removeMarket(
    marketId: string,
    reason: 'EXPIRED' | 'ERROR' | 'MANUAL' | 'REBALANCE' = 'MANUAL',
    pnl?: Money
  ): Promise<RemoveMarketResult> {
    const context = this.activeMarkets.get(marketId);
    if (!context) {
      return {
        success: false,
        error: 'Market not found',
      };
    }

    try {
      // Get PnL from orchestrator if not provided
      // NOTE: For now we use zero PnL - in future we can add getPnL() to orchestrator
      const marketPnL = pnl ?? Money.zero();

      // Stop orchestrator
      await context.orchestrator.stop();

      // Finalize in DataCollector (if enabled)
      // expired = true means market data is valid for analysis
      if (this.dataCollector?.isEnabled()) {
        await this.dataCollector.finalizeMarket(marketId, reason === 'EXPIRED');
      }

      // Release balance with PnL tracking
      // This updates totalBalance: totalBalance += pnl
      const releasedBalance = this.balanceAllocator?.releaseWithPnL(marketId, marketPnL) ?? Money.zero();

      // Remove from active markets
      this.activeMarkets.delete(marketId);

      // Log balance state after release
      const stats = this.balanceAllocator?.getStats();

      // Emit event
      this.emitEvent({
        type: 'MARKET_REMOVED',
        marketId,
        question: context.market.question,
        reason,
        releasedBalance: releasedBalance.amount,
        timestamp: new Date(),
      });

      this.logger.info('Market removed', {
        marketId,
        question: context.market.question,
        reason,
        releasedBalance: releasedBalance.amount,
        pnl: marketPnL.amount,
        activeMarkets: this.activeMarkets.size,
        // Balance state after release
        newTotalBalance: stats?.totalBalance.amount ?? 0,
        newTradingBalance: stats?.tradingBalance.amount ?? 0,
        newFreeBalance: stats?.freeBalance.amount ?? 0,
        utilizationPercent: stats?.utilizationPercent.toFixed(1) ?? '0',
      });

      return {
        success: true,
        releasedBalance,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.addError(`Failed to remove market ${marketId}: ${errorMessage}`);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Запускает мониторинг истечения маркетов
   */
  private startExpiryMonitoring(): void {
    this.expiryCheckTimer = setInterval(() => {
      this.checkMarketExpiry();
    }, this.config.expiryCheckIntervalMs);

    this.logger.debug('Expiry monitoring started', {
      intervalMs: this.config.expiryCheckIntervalMs,
    });
  }

  /**
   * Останавливает мониторинг истечения
   */
  private stopExpiryMonitoring(): void {
    if (this.expiryCheckTimer) {
      clearInterval(this.expiryCheckTimer);
      this.expiryCheckTimer = null;
    }
  }

  /**
   * Проверяет истечение маркетов
   */
  private checkMarketExpiry(): void {
    const now = Date.now();
    const expiredMarkets: string[] = [];

    for (const [marketId, context] of this.activeMarkets) {
      const expiryTime = context.market.expirationDate.getTime();
      if (now >= expiryTime) {
        expiredMarkets.push(marketId);
        context.status = 'EXPIRED';
      }
    }

    // Remove expired markets
    for (const marketId of expiredMarkets) {
      this.logger.warn('Market expired', { marketId });
      this.removeMarket(marketId, 'EXPIRED').catch((error) => {
        this.logger.error(`Failed to remove expired market ${marketId}`, error);
      });
    }
  }

  /**
   * Запускает периодическое сканирование маркетов
   */
  private startPeriodicScan(): void {
    this.schedulNextScan();

    this.logger.debug('Periodic scan started', {
      pauseMs: this.config.scanPauseMs,
    });
  }

  /**
   * Останавливает периодическое сканирование
   */
  private stopPeriodicScan(): void {
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    this.nextScanAt = null;
  }

  /**
   * Планирует следующее сканирование
   */
  private schedulNextScan(): void {
    this.nextScanAt = new Date(Date.now() + this.config.scanPauseMs);

    this.scanTimer = setTimeout(() => {
      this.performScan().catch((error) => {
        this.logger.error('Scan failed', error);
        this.addError(`Scan failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.config.scanPauseMs);
  }

  /**
   * Выполняет сканирование маркетов
   *
   * @remarks
   * Ищет новые маркеты для заполнения свободных слотов.
   */
  private async performScan(): Promise<void> {
    if (!this.isRunning || !this.balanceAllocator) {
      return;
    }

    this.lastScanAt = new Date();
    this.logger.debug('Performing market scan...');

    try {
      // Refresh market data
      await this.marketDiscovery.refresh();

      // Try to add markets
      await this.tryAddMarketsFromDiscovery();
    } catch (error) {
      this.logger.error('Scan error', error);
      this.addError(`Scan error: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Schedule next scan
    this.schedulNextScan();
  }

  /**
   * Возвращает статус всех маркетов
   *
   * @returns Агрегированный статус с метриками использования баланса
   *
   * @remarks
   * Включает расширенные метрики:
   * - utilization: доля занятого баланса (0-1)
   * - utilizationPercent: то же в процентах (0-100)
   * - avgCapitalPerMarket: средний капитал на маркет
   * - availableSlots: сколько ещё маркетов можно добавить
   */
  getStatus(): MultiMarketStatus {
    const stats = this.balanceAllocator?.getStats() ?? {
      totalBalance: Money.zero(),
      tradingBalance: Money.zero(),
      allocatedBalance: Money.zero(),
      freeBalance: Money.zero(),
      marketCount: 0,
      perMarketBalance: null,
      utilization: 0,
      utilizationPercent: 0,
      avgCapitalPerMarket: 0,
      remainder: Money.zero(),
      availableSlots: 0,
    };

    const markets: MarketStatusInfo[] = [];
    const now = Date.now();

    for (const [marketId, context] of this.activeMarkets) {
      const orchestratorStatus = context.orchestrator.getStatus();
      const timeToExpiry = context.market.expirationDate.getTime() - now;
      const tradingDuration = now - context.startedAt.getTime();

      markets.push({
        marketId,
        question: context.market.question,
        status: context.status,
        tradingMode: orchestratorStatus.tradingMode,
        allocatedBalance: context.allocatedBalance.amount,
        timeToExpiry,
        activeOrders: orchestratorStatus.activeOrders,
        tradingDuration,
        error: context.errorMessage,
      });
    }

    const atCapacity =
      this.config.maxConcurrentMarkets > 0 &&
      this.activeMarkets.size >= this.config.maxConcurrentMarkets;

    return {
      isRunning: this.isRunning,
      totalBalance: stats.totalBalance.amount,
      tradingBalance: stats.tradingBalance.amount,
      allocatedBalance: stats.allocatedBalance.amount,
      freeBalance: stats.freeBalance.amount,
      activeMarketCount: this.activeMarkets.size,
      maxConcurrentMarkets: this.config.maxConcurrentMarkets,
      atCapacity,
      utilization: stats.utilization,
      utilizationPercent: stats.utilizationPercent,
      avgCapitalPerMarket: stats.avgCapitalPerMarket,
      availableSlots: stats.availableSlots,
      markets,
      lastScanAt: this.lastScanAt,
      nextScanAt: this.nextScanAt,
      recentErrors: [...this.recentErrors],
    };
  }

  /**
   * Регистрирует обработчик событий
   *
   * @param handler - Функция-обработчик
   */
  onEvent(handler: MultiMarketEventHandler): void {
    this.eventHandlers.push(handler);
  }

  /**
   * Отправляет событие всем обработчикам
   */
  private emitEvent(event: MultiMarketEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        this.logger.error('Event handler error', error);
      }
    }
  }

  /**
   * Добавляет ошибку в список
   */
  private addError(message: string): void {
    this.recentErrors.push(`[${new Date().toISOString()}] ${message}`);
    if (this.recentErrors.length > this.maxRecentErrors) {
      this.recentErrors.shift();
    }
  }

  /**
   * Возвращает количество активных маркетов
   */
  get activeMarketCount(): number {
    return this.activeMarkets.size;
  }

  /**
   * Проверяет, работает ли trader
   */
  get running(): boolean {
    return this.isRunning;
  }

  /**
   * Возвращает DataCollector для подписки на raw events
   *
   * @remarks
   * Используется в main.ts для подключения wsManager.on('raw', ...)
   * к dataCollector.handleRawEvent(...)
   *
   * @returns DataCollectorService или null если не включён
   */
  getDataCollector(): DataCollectorService | null {
    return this.dataCollector;
  }
}
