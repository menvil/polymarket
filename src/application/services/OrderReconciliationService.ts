/**
 * Order Reconciliation Service
 *
 * @remarks
 * Periodically checks real order status from API and reconciles
 * with our internal tracked state.
 *
 * Key responsibilities:
 * - Poll getOpenOrders() periodically
 * - Compare with tracked orders
 * - Publish OrderFilled events for completed orders
 * - Untrack orders that are no longer open
 *
 * This is the **fallback mechanism** for order status tracking.
 * Primary mechanism is event-driven (TradeMatched + CheckOrderStatus).
 *
 * @example
 * ```typescript
 * const service = new OrderReconciliationService(
 *   restAdapter,
 *   eventBus,
 *   logger,
 *   { intervalMs: 10000 }
 * );
 *
 * service.start();
 * // Every 10 seconds:
 * // 1. Fetch open orders from API
 * // 2. Compare with tracked orders
 * // 3. Publish OrderFilled for filled orders
 * // 4. Clean up tracking state
 * ```
 */

import type { ILogger } from '../../domain/ports/ILogger.js';
import type { IEventBus } from '../../shared/events/IEventBus.js';
// ✅ v7.1: ВОССТАНОВЛЕНО - нужно для OrderFilled events при instant fills
import { createProductionEnvelope } from '../../shared/events/EventEnvelope.js';
// ✅ v7.7.9: NEW - для получения filled orders через status=MATCHED (более надежно чем /data/trades!)
import type { PolymarketOrderRestClient } from '../../infrastructure/polymarket/rest/clients/PolymarketOrderRestClient.js';
// ✅ v7.7.15: OrderFilled УДАЛЁН - стратегия работает только по StrategyTick!
// import type { OrderFilled } from '../../domain/events/ExecutionEvent.js';

/**
 * Reconciliation configuration
 */
export interface ReconciliationConfig {
  /** Polling interval in ms (default: 10000ms = 10 seconds) */
  intervalMs?: number;

  /** Enable/disable reconciliation (default: true) */
  enabled?: boolean;
}

/**
 * REST Adapter interface (for getOpenOrders and getOrderById)
 *
 * @remarks
 * v7.7.6: Added getOrderById() for checking order status in SCENARIO C
 */
export interface IRestAdapter {
  getOpenOrders(tokenId?: string): Promise<any[]>;

  /**
   * Get order by ID
   *
   * @param orderId - Order ID to fetch
   * @returns Order with status: 'pending' | 'live' | 'filled' | 'cancelled'
   * @throws {ApiError} If order not found or API error
   *
   * @remarks
   * v7.7.6: Used in SCENARIO C to distinguish filled vs cancelled orders
   */
  getOrderById(orderId: string): Promise<{
    orderID: string;
    status: 'pending' | 'live' | 'filled' | 'cancelled';
    filledSize?: string;
    size?: string;
  }>;
}

/**
 * Balance Provider interface (for checking positions)
 */
export interface IBalanceProvider {
  getOutcomeBalance(tokenId: string): Promise<number>;
}

/**
 * Fill entry (for partial fills history)
 *
 * @remarks
 * v7.5: Added tradeId для дедупликации fills
 */
interface FillEntry {
  /** Trade ID (для дедупликации - prevents duplicate OrderFilled events) */
  tradeId: string;
  /** Partial fill size */
  size: number;
  /** Actual fill price (может быть лучше чем limit order price!) */
  price: number;
  /** Fill timestamp */
  timestamp: Date;
}

/**
 * Tracked order (with partial fills tracking)
 *
 * @remarks
 * v6.4: Partial fills support!
 * - Order может заполняться частями (1.6 + 3.4 = 5.0)
 * - fillHistory хранит все частичные заполнения с реальными ценами
 * - filledSize = сумма всех partial fills
 * - remainingSize = size - filledSize
 *
 * v7.2: Исчезнувшие ордера (disappeared order tracking)
 * - disappearedAt = timestamp когда впервые не нашли ордер в openOrders
 * - disappearedCount = сколько циклов reconciliation не видим ордер
 * - Если ордер исчез БЕЗ изменения позиции → ждем 30 сек перед принятием решения
 * - Если ордер исчез + позиция изменилась → сразу publishOrderFilled (instant fill)
 */
interface TrackedOrder {
  /** Order ID from exchange */
  orderId: string;
  /** Token ID (market) */
  tokenId: string;
  /** Strategy ID (owner) */
  strategyId: string;
  /** Order side */
  side: 'buy' | 'sell';
  /** Requested limit price */
  price: number;
  /** Total requested size */
  size: number;

  // ✅ v7.2: Position tracking (вместо balance)
  /** Initial position when order placed (shares count, for fill detection) */
  initialPosition: number;

  // ✅ v7.3: Average price tracking (для вычисления реальной цены fill)
  /** Initial average entry price when order placed (для расчета реальной fillPrice) */
  initialAveragePrice?: number;

  // ✅ v6.4: Partial fills tracking
  /** Accumulated filled size (sum of all partial fills) */
  filledSize: number;
  /** History of all partial fills (with real execution prices) */
  fillHistory: FillEntry[];

  // ✅ v7.2: Disappeared order tracking (для 30-sec timeout)
  /** Timestamp когда впервые не нашли ордер (undefined если ордер на бирже) */
  disappearedAt?: number;
  /** Количество циклов reconciliation без ордера (0 если ордер на бирже) */
  disappearedCount?: number;
}

/**
 * Order Reconciliation Service
 *
 * @remarks
 * Ensures our tracked state matches reality by periodically
 * fetching open orders from API.
 */
export class OrderReconciliationService {
  private readonly trackedOrders: Map<string, TrackedOrder> = new Map();
  /**
   * ✅ v7.7: Recently active tokenIds (даже после untracking)
   *
   * @remarks
   * Проблема: Instant fills → order untracked → processTradesFromAPI() не знает какие tokenIds запрашивать
   * Решение: Храним tokenIds с timestamp последней активности (60 секунд)
   *
   * Format: Map<tokenId, lastActivityTimestamp>
   */
  private readonly recentTokenIds: Map<string, number> = new Map();

  /**
   * ✅ v7.7.10: Processed fill IDs (для дедупликации OrderFilled events)
   *
   * @remarks
   * Храним trade IDs которые уже обработали, чтобы не публиковать дубликаты OrderFilled events.
   * Используется в processFillsAndPublishEvents().
   */
  private readonly processedFillIds: Set<string> = new Set();

  /**
   * ✅ v7.7.18: КРИТИЧНО - Глобальное хранилище fills по strategyId
   *
   * @remarks
   * Fills - это ПОСТОЯННЫЕ ФАКТЫ, они НЕ зависят от trackedOrders!
   * Order - ВРЕМЕННАЯ сущность, fills - ИСТОРИЧЕСКИЕ данные!
   *
   * Проблема старой архитектуры:
   * - Fills хранились в trackedOrder.fillHistory (привязаны к order)
   * - Когда order untracked → fills терялись!
   *
   * Новая архитектура:
   * - Fills хранятся ПО СТРАТЕГИИ, НЕ по order
   * - processFillsAndPublishEvents() записывает fills СЮДА
   * - rebuildSnapshotsForAllStrategies() читает fills ОТСЮДА
   *
   * Format: Map<strategyId, FillRecordDisplayData[]>
   */
  private readonly strategyFills: Map<string, any[]> = new Map();

  /**
   * ✅ v7.7.14: OrderId → StrategyId mapping (живет дольше чем trackedOrders!)
   *
   * @remarks
   * КРИТИЧЕСКАЯ проблема: fills могут прийти ПОСЛЕ того как ордер untracked!
   *
   * Timeline:
   * 1. Order placed → trackOrderSync(strategyId) → trackedOrders[orderId] = {...}
   * 2. Order disappears → untrackOrder() → trackedOrders.delete(orderId)
   * 3. Fill detected → processFilsAndPublishEvents() → strategyId = trackedOrders.get(orderId).strategyId → UNDEFINED!
   * 4. OrderFilled published with strategyId=undefined → filtered out by StrategyRunner!
   *
   * Решение: Отдельный Map для orderId → strategyId, который живет дольше (5 минут).
   * Format: Map<orderId, {strategyId: string, timestamp: number}>
   */
  private readonly orderIdToStrategyId: Map<string, {strategyId: string, timestamp: number}> = new Map();
  // TTL for orderIdToStrategyId mapping (kept for future cleanup implementation)
  // private readonly ORDER_STRATEGY_MAPPING_TTL_MS = 5 * 60 * 1000; // 5 minutes

  private readonly intervalMs: number;
  private readonly enabled: boolean;
  private intervalId?: NodeJS.Timeout;

  // ✅ v7.7.15: StrategyMetricsProjector для записи fills (UI display)
  private metricsProjector?: any; // IStrategyMetricsProjector (избегаем circular dependency)
  private portfolioProjector?: any; // IPortfolioProjector (избегаем circular dependency) - ✅ v7.7.17: Source of truth!

  constructor(
    private readonly restAdapter: IRestAdapter,
    private readonly eventBus: IEventBus, // ✅ v7.1: ВОССТАНОВЛЕНО - нужно для OrderFilled events!
    private readonly logger: ILogger,
    config: ReconciliationConfig = {},
    private readonly balanceProvider?: IBalanceProvider,
    private readonly positionsProvider?: any, // ✅ v7.3: Для получения averagePrice
    private readonly orderClient?: PolymarketOrderRestClient // ✅ v7.7.9: Для получения filled orders (status=MATCHED)
  ) {
    this.intervalMs = config.intervalMs ?? 10000;
    this.enabled = config.enabled ?? true;
  }

  /**
   * ✅ v7.7.15: Set metrics projector for recording fills
   *
   * @param metricsProjector - StrategyMetricsProjector instance
   *
   * @remarks
   * Called from main.ts after metricsProjector is created.
   * Used to record fills for UI display (HeadlessUI/BlessedUI).
   */
  setMetricsProjector(metricsProjector: any): void {
    this.metricsProjector = metricsProjector;
    this.logger.debug('[OrderReconciliationService] Metrics projector set');
  }

  /**
   * ✅ v7.7.17: Set portfolio projector - ЕДИНАЯ source of truth!
   *
   * @param portfolioProjector - PortfolioProjector instance
   *
   * @remarks
   * Called from main.ts after portfolioProjector is created.
   * PortfolioProjector - единое хранилище fills + orders + inventory.
   * MetricsProjector получает snapshot из PortfolioProjector для UI.
   */
  setPortfolioProjector(portfolioProjector: any): void {
    this.portfolioProjector = portfolioProjector;
    this.logger.debug('[OrderReconciliationService] Portfolio projector set (source of truth)');
  }

  /**
   * v6.3: Track order SYNCHRONOUSLY (immediate, no async!)
   *
   * @param order - Order to track
   *
   * @remarks
   * **КРИТИЧНО**: Этот метод СИНХРОННЫЙ!
   * Добавляет order в trackedOrders Map МГНОВЕННО.
   *
   * Используется в EventBus subscriber для OrderAccepted:
   * - Гарантирует что hasPendingOrders() вернет true СРАЗУ
   * - Предотвращает race condition с Strategy.hasPendingOrders()
   *
   * v6.4: Инициализирует filledSize = 0 и fillHistory = [] для partial fills tracking.
   * v7.2: Инициализирует disappearedAt и disappearedCount для disappeared tracking.
   *
   * После вызова этого метода, вызовите fetchInitialPosition() для заполнения initialPosition.
   */
  trackOrderSync(order: Omit<TrackedOrder, 'filledSize' | 'fillHistory' | 'disappearedAt' | 'disappearedCount'>): void {
    // ✅ v7.7.17: Если initialPosition undefined, используем inventory из PortfolioProjector
    let initialPosition = order.initialPosition;
    if (initialPosition === undefined && this.portfolioProjector) {
      const snapshot = this.portfolioProjector.getSnapshot(order.strategyId);
      initialPosition = snapshot?.inventory ?? 0;
      this.logger.debug('[OrderReconciliationService] Using PortfolioProjector inventory as initialPosition', {
        orderId: order.orderId.substring(0, 8) + '...',
        strategyId: order.strategyId,
        inventory: initialPosition,
      });
    }

    // ✅ v7.2: Инициализируем все tracking поля
    const trackedOrder: TrackedOrder = {
      ...order,
      initialPosition: initialPosition ?? 0, // Fallback to 0 if still undefined
      filledSize: 0, // Ещё не заполнен
      fillHistory: [], // Нет fills пока
      disappearedAt: undefined, // Ордер на бирже
      disappearedCount: 0, // Не исчезал
    };

    this.trackedOrders.set(order.orderId, trackedOrder);

    // ✅ v7.7.14: КРИТИЧНО! Сохраняем orderId → strategyId mapping (живет дольше!)
    // Это гарантирует что fills обнаруженные после untracking будут иметь правильный strategyId
    this.orderIdToStrategyId.set(order.orderId, {
      strategyId: order.strategyId,
      timestamp: Date.now(),
    });

    // ✅ v7.7: Добавляем tokenId в recentTokenIds (для processTradesFromAPI после untracking)
    this.recentTokenIds.set(order.tokenId, Date.now());

    this.logger.debug('[OrderReconciliationService] Tracking order (SYNC)', {
      orderId: order.orderId,
      strategyId: order.strategyId,
      tokenId: order.tokenId,
      side: order.side,
      size: order.size,
      initialPosition: order.initialPosition,
      filledSize: 0,
    });

    // ✅ v7.7.17: АТОМАРНЫЙ подход - rebuildSnapshot() в reconciliation loop обновит все!
    // НЕ вызываем syncOrdersToPortfolioProjector() - это создает race condition!
  }

  // ✅ v7.7.17: REMOVED syncOrdersToPortfolioProjector() - use atomic batch processing via rebuildSnapshotsForAllStrategies()

  /**
   * v7.2: Fetch initial position for order (async, optional)
   *
   * @param orderId - Order ID
   * @param tokenId - Token ID
   *
   * @remarks
   * v7.2: Получает initial position (shares count) для fill detection!
   * v7.3: Получает также initial averagePrice для расчета реальной fillPrice!
   *
   * Вызывается ПОСЛЕ trackOrderSync().
   * Получает initial position в фоне (не блокирует).
   *
   * Используется для детекции fills:
   * - BUY: position увеличилась → filled
   * - SELL: position уменьшилась → filled
   *
   * Если position НЕ изменилась после 30 сек, order rejected/cancelled (не filled).
   */
  async fetchInitialPosition(orderId: string, tokenId: string): Promise<void> {
    const trackedOrder = this.trackedOrders.get(orderId);
    if (!trackedOrder || !this.balanceProvider) {
      return;
    }

    try {
      // Get initial position (shares count)
      const initialPosition = await this.balanceProvider.getOutcomeBalance(tokenId);

      // ✅ v7.7.5 CRITICAL FIX: DO NOT overwrite initialPosition if already set!
      // Balance API has lag and returns stale data. If initialPosition was set
      // during trackOrder() from PortfolioProjector, it's more accurate.
      // Only set initialPosition if it's still undefined (shouldn't happen).
      if (trackedOrder.initialPosition === undefined) {
        this.logger.warn('[OrderReconciliationService] initialPosition was undefined, setting from Balance API', {
          orderId,
          tokenId,
          initialPositionFromAPI: initialPosition,
        });
        trackedOrder.initialPosition = initialPosition;
      } else if (Math.abs(trackedOrder.initialPosition - initialPosition) > 0.01) {
        // ✅ v7.7.5: Log discrepancy between PortfolioProjector and Balance API
        this.logger.warn('[OrderReconciliationService] ⚠️ Balance API mismatch! Using PortfolioProjector value', {
          orderId,
          tokenId,
          portfolioProjector: trackedOrder.initialPosition.toFixed(2),
          balanceAPI: initialPosition.toFixed(2),
          diff: (initialPosition - trackedOrder.initialPosition).toFixed(2),
          reason: 'Balance API has lag - PortfolioProjector is more accurate',
        });
        // DO NOT overwrite! Keep PortfolioProjector value
      }

      // ✅ v7.3: Get initial average price для расчета реальной fillPrice
      // Нужно получить averagePrice из positions
      // Если position = 0, averagePrice неопределен (будет null/undefined)
      if (this.positionsProvider && initialPosition > 0) {
        try {
          const positions = await this.positionsProvider.getPositions(tokenId);
          const position = positions.find((p: any) => p.tokenId === tokenId);
          if (position) {
            trackedOrder.initialAveragePrice = position.averagePrice;
            this.logger.debug('[OrderReconciliationService] Captured initial average price for order', {
              orderId,
              tokenId,
              side: trackedOrder.side,
              initialPosition,
              initialAveragePrice: position.averagePrice.toFixed(4),
            });
          }
        } catch (error) {
          // Non-critical: can still detect fills without averagePrice
          this.logger.debug('[OrderReconciliationService] Could not get initial average price', {
            orderId,
            tokenId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        this.logger.debug('[OrderReconciliationService] Captured initial position for order', {
          orderId,
          tokenId,
          side: trackedOrder.side,
          initialPosition,
        });
      }
    } catch (error) {
      this.logger.warn('[OrderReconciliationService] Failed to get initial position', {
        orderId,
        tokenId,
        side: trackedOrder.side,
        error: error instanceof Error ? error.message : String(error),
      });
      // Continue tracking without initial position
    }
  }

  /**
   * @deprecated Use fetchInitialPosition instead
   */
  async fetchInitialBalance(orderId: string, tokenId: string): Promise<void> {
    return this.fetchInitialPosition(orderId, tokenId);
  }

  /**
   * Track order for reconciliation (DEPRECATED - use trackOrderSync + fetchInitialPosition)
   *
   * @param order - Order to track
   *
   * @remarks
   * @deprecated Use trackOrderSync() + fetchInitialPosition() instead for synchronous tracking.
   *
   * Called when order is placed (OrderAccepted).
   * v7.2: Captures initial position для ВСЕХ orders (BUY и SELL).
   */
  async trackOrder(order: Omit<TrackedOrder, 'filledSize' | 'fillHistory' | 'disappearedAt' | 'disappearedCount'>): Promise<void> {
    // ✅ v7.2: Delegate to sync method
    this.trackOrderSync(order);

    // ✅ v7.2: Fetch position in background для ВСЕХ orders
    await this.fetchInitialPosition(order.orderId, order.tokenId);
  }

  /**
   * v6.4: Accumulate partial fill for order
   *
   * @param orderId - Order ID
   * @param filledDelta - Size of this partial fill
   * @param fillPrice - Actual fill price (may be better than limit!)
   * @param timestamp - Fill timestamp
   * @returns Fill info: { fullyFilled, filledSize, remainingSize, averageFillPrice }
   *
   * @remarks
   * **КРИТИЧНО**: Accumulates partial fills!
   *
   * Алгоритм:
   * 1. Получаем TrackedOrder из Map
   * 2. Добавляем fill в fillHistory
   * 3. Увеличиваем filledSize += filledDelta
   * 4. Проверяем fullyFilled = filledSize >= size * 0.999 (tolerance for fees)
   * 5. Если fullyFilled → untrack order
   *
   * @example
   * ```typescript
   * // OrderFilled { orderId: '123', filledDelta: 1.6, price: 0.25 }
   * const result1 = service.accumulateFill('123', 1.6, 0.25, new Date());
   * // → { fullyFilled: false, filledSize: 1.6, remainingSize: 3.4 }
   *
   * // OrderFilled { orderId: '123', filledDelta: 3.4, price: 0.249 } (better price!)
   * const result2 = service.accumulateFill('123', 3.4, 0.249, new Date());
   * // → { fullyFilled: true, filledSize: 5.0, remainingSize: 0, averageFillPrice: 0.2494 }
   * ```
   */
  accumulateFill(
    orderId: string,
    filledDelta: number,
    fillPrice: number,
    timestamp: Date
  ): {
    fullyFilled: boolean;
    filledSize: number;
    remainingSize: number;
    averageFillPrice: number;
  } | null {
    const trackedOrder = this.trackedOrders.get(orderId);
    if (!trackedOrder) {
      this.logger.warn('[OrderReconciliationService] Cannot accumulate fill - order not tracked', {
        orderId,
        filledDelta,
        fillPrice,
      });
      return null;
    }

    // ✅ Добавляем fill в историю
    trackedOrder.fillHistory.push({
      tradeId: `${orderId}-${timestamp.getTime()}`, // ✅ v7.5: Generated tradeId for old code compatibility
      size: filledDelta,
      price: fillPrice,
      timestamp,
    });

    // ✅ Накапливаем filledSize
    trackedOrder.filledSize += filledDelta;

    // ✅ Вычисляем remainingSize
    const remainingSize = Math.max(0, trackedOrder.size - trackedOrder.filledSize);

    // ✅ Вычисляем средневзвешенную цену fills
    const totalValue = trackedOrder.fillHistory.reduce(
      (sum, fill) => sum + fill.size * fill.price,
      0
    );
    const totalSize = trackedOrder.filledSize;
    const averageFillPrice = totalSize > 0 ? totalValue / totalSize : trackedOrder.price;

    // ✅ Проверяем fullyFilled (tolerance 0.1% для fees)
    const fullyFilled = trackedOrder.filledSize >= trackedOrder.size * 0.999;

    this.logger.info('[OrderReconciliationService] Accumulated partial fill', {
      orderId: orderId.substring(0, 8) + '...',
      strategyId: trackedOrder.strategyId,
      side: trackedOrder.side,
      filledDelta,
      fillPrice,
      totalFilledSize: trackedOrder.filledSize.toFixed(2),
      requestedSize: trackedOrder.size,
      remainingSize: remainingSize.toFixed(2),
      fillCount: trackedOrder.fillHistory.length,
      averageFillPrice: averageFillPrice.toFixed(4),
      fullyFilled,
    });

    // ✅ Если полностью заполнен → untrack (удаляем из Map)
    if (fullyFilled) {
      this.logger.info('[OrderReconciliationService] Order fully filled - untracking', {
        orderId: orderId.substring(0, 8) + '...',
        totalFills: trackedOrder.fillHistory.length,
        totalFilledSize: trackedOrder.filledSize.toFixed(2),
        averageFillPrice: averageFillPrice.toFixed(4),
      });
      this.trackedOrders.delete(orderId);
    }

    return {
      fullyFilled,
      filledSize: trackedOrder.filledSize,
      remainingSize,
      averageFillPrice,
    };
  }

  /**
   * Stop tracking order
   *
   * @param orderId - Order ID to untrack
   *
   * @remarks
   * Called when order is confirmed filled/cancelled.
   * ✅ v7.7.17: Немедленно синхронизирует ордера в PortfolioProjector.
   */
  untrackOrder(orderId: string): void {
    this.trackedOrders.delete(orderId);
    this.logger.debug('[OrderReconciliationService] Stopped tracking order', { orderId });

    // ✅ v7.7.17: АТОМАРНЫЙ подход - rebuildSnapshot() в reconciliation loop обновит все!
    // НЕ вызываем syncOrdersToPortfolioProjector() - это создает race condition!
  }

  /**
   * v6.4: Установить callback для синхронизации positions
   *
   * @param callback - Callback для синхронизации positions после reconciliation
   *
   * @remarks
   * **КРИТИЧНО**: Reconciliation не только проверяет orders, но и синхронизирует positions!
   *
   * Вызывается после каждого reconciliation loop с реальными positions с биржи.
   * Coordinator использует это для синхронизации PortfolioProjector.
   *
   * @example
   * ```typescript
   * orderReconciliationService.setPositionSyncCallback(async (positions) => {
   *   for (const [strategyId, pos] of positions.entries()) {
   *     coordinator.syncPositions(strategyId, pos);
   *   }
   * });
   * ```
   */
  setPositionSyncCallback(
    callback: (positions: Map<string, Array<{ tokenId: string; balance: number }>>) => Promise<void>
  ): void {
    this.positionSyncCallback = callback;
  }

  private positionSyncCallback?: (
    positions: Map<string, Array<{ tokenId: string; balance: number }>>
  ) => Promise<void>;

  /**
   * ✅ v7.7.18: АТОМАРНО пересчитать snapshots всех стратегий (batch processing)
   *
   * @param openOrdersFromExchange - РЕАЛЬНЫЕ orders с биржи (из getOpenOrders())
   *
   * @remarks
   * Вызывается после reconciliation цикла.
   * Собирает ВСЕ fills и orders, пересчитывает и атомарно обновляет snapshots.
   *
   * КРИТИЧНО v7.7.18: Используем РЕАЛЬНЫЕ orders с биржи, а НЕ trackedOrders!
   * trackedOrders - ВНУТРЕННЕЕ состояние, может не совпадать с биржей!
   * openOrdersFromExchange - ИСТИНА из API!
   */
  async rebuildSnapshotsForAllStrategies(openOrdersFromExchange: any[]): Promise<void> {
    if (!this.portfolioProjector) {
      return;
    }

    // Получить все активные стратегии
    const activeStrategies = this.metricsProjector?.getAllMetrics() || [];
    if (activeStrategies.length === 0) {
      return;
    }

    // Для каждой стратегии пересчитать snapshot
    for (const strategy of activeStrategies) {
      const strategyId = strategy.strategyId;
      const tokenId = strategy.tokenId;

      if (!tokenId) {
        continue;
      }

      try {
        // ✅ v7.7.18: Читаем fills из ГЛОБАЛЬНОГО хранилища strategyFills!
        // Fills - это ПОСТОЯННЫЕ ФАКТЫ, они НЕ зависят от trackedOrders!
        const strategyFillsArray = this.strategyFills.get(strategyId) || [];

        // ✅ v7.7.18: КРИТИЧНО - Берём orders С БИРЖИ, а НЕ из trackedOrders!
        // Фильтруем openOrdersFromExchange по tokenId этой стратегии
        const strategyOrders = openOrdersFromExchange
          .filter(o => o.tokenId === tokenId)
          .map(o => ({
            id: o.orderId,
            side: o.side?.toUpperCase() as 'BUY' | 'SELL',
            price: o.price || 0,
            size: o.size || 0,
            filledSize: o.filledSize || 0,
            status: 'LIVE' as const,
            createdAt: new Date().toISOString(),
          }));

        this.logger.debug('[OrderReconciliationService] Rebuilding snapshot from EXCHANGE data', {
          strategyId: strategyId.substring(0, 40) + '...',
          tokenId: tokenId.substring(0, 12) + '...',
          globalFillsCount: strategyFillsArray.length,
          ordersFromExchange: strategyOrders.length,
        });

        // 3. АТОМАРНО пересчитать и заменить snapshot
        this.portfolioProjector.rebuildSnapshot(strategyId, strategyFillsArray, strategyOrders);

        this.logger.info('[OrderReconciliationService] Snapshot rebuilt atomically from global storage', {
          strategyId: strategyId.substring(0, 40) + '...',
          fills: strategyFillsArray.length,
          orders: strategyOrders.length,
        });
      } catch (error) {
        this.logger.error('[OrderReconciliationService] Failed to rebuild snapshot', {
          strategyId: strategyId.substring(0, 40) + '...',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Start reconciliation loop
   */
  start(): void {
    if (!this.enabled) {
      this.logger.info('[OrderReconciliationService] Reconciliation disabled');
      return;
    }

    // Run immediately on start
    this.reconcile().catch((error) => {
      this.logger.error('[OrderReconciliationService] Initial reconciliation failed', { error });
    });

    this.intervalId = setInterval(() => {
      this.reconcile().catch((error) => {
        this.logger.error('[OrderReconciliationService] Reconciliation failed', { error });
      });
    }, this.intervalMs);

    this.logger.info('[OrderReconciliationService] Started reconciliation loop', {
      intervalMs: this.intervalMs,
      enabled: this.enabled,
      hasBalanceProvider: !!this.balanceProvider,
    });
  }

  /**
   * Stop reconciliation loop
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    this.logger.info('[OrderReconciliationService] Stopped reconciliation loop');
  }

  /**
   * Reconcile tracked orders with API reality
   *
  /**
   * v7.5: Process fills from trades API (NEW!)
   *
   * @remarks
   * **КРИТИЧНО v7.5**: Получаем ВСЕ fills из /data/trades API!
   *
   * Это ЕДИНСТВЕННЫЙ надежный источник правды:
   * - Balance API может лагать
   * - /open-orders не показывает partial fills
   * - /data/trades показывает КАЖДЫЙ fill с реальной ценой
   *
   * Алгоритм:
   * 1. Получить ALL recent fills (last 60 seconds)
   * 2. Сгруппировать по order_id
   * 3. Для каждого tracked order:
   *    - Найти fills для этого order_id
   *    - Обработать КАЖДЫЙ fill (partial + full)
   *    - Дедуплицировать по tradeId
   *    - Публиковать OrderFilled для КАЖДОГО нового fill
   *    - Обновлять filledSize и fillHistory
   * 4. Untrack orders когда fully filled
   */

  /**
   * ✅ v7.7.17: Получить filled orders для reconciliation (без обработки)
   *
   * @returns Array of fill objects from API
   *
   * @remarks
   * Просто запрашивает fills из /data/trades API.
   * Обработка fills происходит в processFillsAndPublishEvents().
   */
  private async getFilledOrdersForReconciliation(): Promise<any[]> {
    if (!this.orderClient) {
      return [];
    }

    try {
      // ✅ Получаем ВСЕ fills за раз (без фильтра по tokenId)
      const makerAddress = this.orderClient.getMakerAddress();
      const fills = await this.orderClient.getFilledOrders(
        undefined, // No tokenId filter - get ALL tokens
        makerAddress,
        100,
        {
          onlyFirstPage: false, // Get ALL pages
          includeAllTrades: true, // Get ALL trades (MAKER + TAKER)
        }
      );

      this.logger.debug('[OrderReconciliationService] Fetched fills from API', {
        count: fills.length,
        makerAddress: makerAddress ? makerAddress.substring(0, 10) + '...' : 'none',
      });

      return fills;
    } catch (error) {
      this.logger.warn('[OrderReconciliationService] Failed to get filled orders', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }



  /**
   * Reconcile tracked orders with exchange state
   *
   * @remarks
   * Main reconciliation algorithm (v7):
   *
   * 1. Get all open orders from exchange API
   *
   * 2. Для каждого tracked order:
   *    СЛУЧАЙ A: Ордер на бирже → проверить partial fills
   *    СЛУЧАЙ B: Ордер исчез + позиция изменилась → INSTANT FILL (не ждем!)
   *    СЛУЧАЙ C: Ордер исчез + позиция НЕ изменилась → ЖДЕМ 30 СЕК!
   *
   * 3. Синхронизировать positions через callback
   *
   * 4. Проверить unexpected positions (кто-то торговал вручную)
   */
  private async reconcile(): Promise<void> {
    this.logger.debug('[OrderReconciliationService] ═══════════ RECONCILIATION CYCLE START ═══════════', {
      trackedCount: this.trackedOrders.size,
    });

    try {
      // ✅ v7.7.17: КРИТИЧНО - Запрашиваем ВСЁ параллельно (fills, orders, positions)!
      // Это даёт консистентный snapshot в один момент времени
      const [fills, openOrders, positions] = await Promise.all([
        // Fills: /data/trades (мои executed orders)
        this.orderClient ? this.getFilledOrdersForReconciliation() : Promise.resolve([]),
        // Open orders: текущие активные ордера
        this.restAdapter.getOpenOrders(),
        // Positions: текущие позиции на бирже
        (this.restAdapter as any).getPositions?.() || Promise.resolve([]),
      ]);

      // ✅ Обработать fills сразу после получения
      if (fills.length > 0) {
        await this.processFillsAndPublishEvents(fills);
      }

      const openOrdersMap = new Map(openOrders.map((o: any) => [o.orderId, o]));

      // Логируем ЧТО ПОЛУЧИЛИ С БИРЖИ
      this.logger.info('[OrderReconciliationService] Fetched exchange state', {
        openOrdersCount: openOrders.length,
        openOrders: openOrders.map((o: any) => ({
          orderId: o.orderId.substring(0, 8) + '...',
          side: o.side,
          price: o.price?.toFixed(4),
          size: o.size?.toFixed(2),
        })),
        positionsCount: positions.length,
        positions: positions.map((p: any) => ({
          tokenId: p.tokenId.substring(0, 12) + '...',
          balance: p.balance?.toFixed(2),
        })),
        trackedOrdersCount: this.trackedOrders.size,
        trackedOrders: Array.from(this.trackedOrders.values()).map((t) => ({
          orderId: t.orderId.substring(0, 8) + '...',
          strategyId: t.strategyId,
          side: t.side,
          size: t.size.toFixed(2),
          initialPosition: t.initialPosition.toFixed(2),
          filledSize: t.filledSize.toFixed(2),
        })),
      });

      // ✅ ШАГ 2: Обработать каждый tracked order
      for (const [orderId, trackedOrder] of this.trackedOrders.entries()) {
        const openOrder = openOrdersMap.get(orderId);
        const position = positions.find((p: any) => p.tokenId === trackedOrder.tokenId);
        // ✅ CRITICAL FIX: position.size, NOT position.balance!
        // PositionResponse type has 'size' field, not 'balance'
        const realPosition = position?.size || 0;
        const positionDelta = realPosition - trackedOrder.initialPosition;

        if (openOrder) {
          // СЛУЧАЙ A: Ордер на бирже
          this.handleOpenOrder(trackedOrder, openOrder, positionDelta);
        } else {
          // СЛУЧАЙ B или C: Ордер исчез
          await this.handleDisappearedOrder(trackedOrder, positionDelta, position);
        }
      }

      // ✅ ШАГ 3: Синхронизировать positions с биржей
      await this.syncPositionsWithExchange();

      // ✅ ШАГ 4: Проверить unexpected positions
      await this.checkUnexpectedPositions(positions);

      // ✅ v7.7.15: ШАГ 5 - Обновить orders в metricsProjector для UI display
      if (this.metricsProjector) {
        this.updateOrdersInMetrics(openOrders);
      }

      // ✅ v7.7.18: ШАГ 6 - АТОМАРНО пересчитать snapshots всех стратегий (batch processing)
      // Передаём РЕАЛЬНЫЕ orders с биржи (openOrders), а НЕ из trackedOrders!
      await this.rebuildSnapshotsForAllStrategies(openOrders);

      this.logger.debug('[OrderReconciliationService] ═══════════ RECONCILIATION CYCLE COMPLETE ═══════════', {
        trackedCountAfter: this.trackedOrders.size,
        openOrdersOnExchange: openOrders.length,
        positionsOnExchange: positions.length,
      });
    } catch (error) {
      this.logger.error('[OrderReconciliationService] ⚠️ RECONCILIATION FAILED', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }

  /**
   * v7.2: СЛУЧАЙ A - Ордер на бирже (проверка partial fills)
   *
   * @param tracked - Tracked order
   * @param openOrder - Open order from exchange
   * @param positionDelta - Change in position since order placement
   *
   * @remarks
   * Ордер ещё на бирже - проверяем partial fills по изменению позиции.
   *
   * Если positionDelta > 0 → есть partial fill!
   * Публикуем OrderPartiallyFilled если это новый fill.
   *
   * Сбрасываем disappearedAt (ордер вернулся на биржу).
   */
  private handleOpenOrder(tracked: TrackedOrder, openOrder: any, positionDelta: number): void {
    // Сбрасываем disappeared tracking (ордер на бирже)
    if (tracked.disappearedAt) {
      this.logger.debug('[OrderReconciliationService] Order reappeared on exchange', {
        orderId: tracked.orderId.substring(0, 8) + '...',
        disappearedFor: Date.now() - tracked.disappearedAt,
      });
      tracked.disappearedAt = undefined;
      tracked.disappearedCount = 0;
    }

    // Проверяем partial fills по изменению позиции
    const absDelta = Math.abs(positionDelta);
    if (absDelta > 0.01) {
      // Позиция изменилась - есть fill!
      const newFillSize = absDelta;
      const fillDelta = newFillSize - tracked.filledSize;

      if (fillDelta > 0.01) {
        // Новый partial fill!
        const avgPrice = openOrder.avgFillPrice || tracked.price;

        this.logger.info('[OrderReconciliationService] SCENARIO A: Order on exchange + position changed → PARTIAL FILL', {
          orderId: tracked.orderId.substring(0, 8) + '...',
          strategyId: tracked.strategyId,
          side: tracked.side,
          fillDelta: fillDelta.toFixed(2),
          totalFilled: newFillSize.toFixed(2),
          remainingSize: (tracked.size - newFillSize).toFixed(2),
          orderSize: tracked.size.toFixed(2),
          positionDelta: absDelta.toFixed(2),
          avgPrice: avgPrice.toFixed(4),
          decision: 'PUBLISH_ORDER_PARTIALLY_FILLED',
        });

        // Накапливаем fill
        this.accumulateFill(tracked.orderId, fillDelta, avgPrice, new Date());

        // ✅ v7.7.15: OrderPartiallyFilled УДАЛЁН - стратегия работает только по StrategyTick!
        // Публикация событий отключена, только синхронизация позиций!
        // const event = { ... };
        // this.eventBus.publish(envelope);
      } else {
        // Position changed, но fillDelta = 0 (уже обработали)
        this.logger.debug('[OrderReconciliationService] SCENARIO A: Order on exchange + position changed (already tracked)', {
          orderId: tracked.orderId.substring(0, 8) + '...',
          side: tracked.side,
          positionDelta: absDelta.toFixed(2),
          alreadyFilled: tracked.filledSize.toFixed(2),
          decision: 'NO_ACTION',
        });
      }
    } else {
      // Position NOT changed - order waiting
      this.logger.debug('[OrderReconciliationService] SCENARIO A: Order on exchange + NO position change (waiting)', {
        orderId: tracked.orderId.substring(0, 8) + '...',
        side: tracked.side,
        orderSize: tracked.size.toFixed(2),
        filledSize: tracked.filledSize.toFixed(2),
        decision: 'NO_ACTION',
      });
    }
  }

  /**
   * v7.2: СЛУЧАЙ B/C - Ордер исчез (instant fill или 30-sec timeout)
   *
   * @param tracked - Tracked order
   * @param positionDelta - Change in position since order placement
   * @param position - Current position data (including averagePrice)
   *
   * @remarks
   * Ордер исчез с биржи - нужно понять почему.
   *
   * СЛУЧАЙ B: positionDelta > 0 → INSTANT FILL (не ждем!)
   *   - Публикуем OrderFilled сразу
   *   - Untrack order
   *   - v7.3: Вычисляем реальную fillPrice из averagePrice
   *
   * СЛУЧАЙ C: positionDelta == 0 → НЕПОНЯТНО (ждем 30 сек!)
   *   - Помечаем disappearedAt (первый раз)
   *   - Увеличиваем disappearedCount
   *   - Если прошло 30 сек И 7+ проверок → публикуем OrderCancelled
   *   - Если позиция изменилась до 30 сек → публикуем OrderFilled
   */
  private async handleDisappearedOrder(tracked: TrackedOrder, positionDelta: number, position?: any): Promise<void> {
    const absDelta = Math.abs(positionDelta);

    // СЛУЧАЙ B: Позиция изменилась → INSTANT FILL!
    if (absDelta > 0.01) {
      // ✅ v7.7.4 CRITICAL FIX: Use absDelta (actual fill size), NOT tracked.size!
      // tracked.size = full order size (e.g., 5.00)
      // absDelta = actual fill size (e.g., 3.76 for partial fill)
      // Previous logic was WRONG and caused partial fills to be treated as full fills!
      const fillSize = absDelta;

      // ✅ v7.3: Вычисляем РЕАЛЬНУЮ цену fill из изменения averagePrice
      let fillPrice = tracked.price; // Fallback: use order price

      if (position && position.averagePrice !== undefined) {
        const newAvgPrice = position.averagePrice;
        // ✅ CRITICAL FIX: position.size, NOT position.balance!
        const newSize = position.size || 0;
        const oldSize = tracked.initialPosition;
        const oldAvgPrice = tracked.initialAveragePrice;

        // Если initial position = 0 (first buy), то fillPrice = newAvgPrice
        if (oldSize === 0) {
          fillPrice = newAvgPrice;
          this.logger.debug('[OrderReconciliationService] Calculated fill price (first buy)', {
            orderId: tracked.orderId.substring(0, 8) + '...',
            fillPrice: fillPrice.toFixed(4),
            newAvgPrice: newAvgPrice.toFixed(4),
          });
        } else if (oldAvgPrice !== undefined) {
          // Вычисляем fillPrice из изменения averagePrice
          // Formula: fillPrice = (newAvgPrice * newSize - oldAvgPrice * oldSize) / fillSize
          const totalCostAfter = newAvgPrice * newSize;
          const totalCostBefore = oldAvgPrice * oldSize;
          const fillCost = totalCostAfter - totalCostBefore;
          fillPrice = fillCost / fillSize;

          this.logger.debug('[OrderReconciliationService] Calculated fill price from averagePrice change', {
            orderId: tracked.orderId.substring(0, 8) + '...',
            oldAvgPrice: oldAvgPrice.toFixed(4),
            newAvgPrice: newAvgPrice.toFixed(4),
            oldSize: oldSize.toFixed(2),
            newSize: newSize.toFixed(2),
            fillSize: fillSize.toFixed(2),
            fillPrice: fillPrice.toFixed(4),
            orderPrice: tracked.price.toFixed(4),
            priceDiff: (fillPrice - tracked.price).toFixed(4),
          });
        }
      }

      // ✅ v7.7: Use order price as fallback if fillPrice unknown
      // ⚠️ КРИТИЧНО: ВСЕГДА записываем fill если position изменился (fill уже случился!)
      if (isNaN(fillPrice) || fillPrice <= 0) {
        this.logger.warn('[OrderReconciliationService] fillPrice unknown, using order price as fallback', {
          orderId: tracked.orderId.substring(0, 8) + '...',
          fillPrice,
          orderPrice: tracked.price,
          reason: 'API не вернул цену, используем order price',
        });
        // Fallback to order price (ВСЕГДА используем orderPrice если цена неизвестна)
        fillPrice = tracked.price || 0.01; // Минимальная цена если даже orderPrice неизвестна
      }

      // ✅ v7.7.17: КРИТИЧНО - записываем fill в fillHistory через accumulateFill()!
      // Это обновит filledSize и fillHistory одновременно
      const fillResult = this.accumulateFill(tracked.orderId, fillSize, fillPrice, new Date());

      if (!fillResult) {
        this.logger.error('[OrderReconciliationService] Failed to accumulate fill', {
          orderId: tracked.orderId.substring(0, 8) + '...',
          fillSize,
          fillPrice,
        });
        return;
      }

      const isFullyFilled = fillResult.fullyFilled;

      this.logger.info(`[OrderReconciliationService] SCENARIO B: Order disappeared + position changed → ${isFullyFilled ? 'FULL' : 'PARTIAL'} FILL`, {
        orderId: tracked.orderId.substring(0, 8) + '...',
        strategyId: tracked.strategyId,
        side: tracked.side,
        orderSize: tracked.size.toFixed(2),
        fillSizeDelta: fillSize.toFixed(2),
        totalFilled: fillResult.filledSize.toFixed(2),
        isFullyFilled,
        orderPrice: tracked.price.toFixed(4),
        fillPrice: fillPrice.toFixed(4),
        averageFillPrice: fillResult.averageFillPrice.toFixed(4),
        priceDiff: (fillPrice - tracked.price).toFixed(4),
        initialPosition: tracked.initialPosition.toFixed(2),
        decision: isFullyFilled ? 'UNTRACK_ORDER' : 'KEEP_TRACKING',
      });

      // ✅ v7.7.15: OrderFilled events УДАЛЕНЫ - inventory syncs через setPositionSyncCallback()!
      // Не используем portfolioProjector напрямую - синхронизация происходит каждые 4 секунды
      // через callback в main.ts (multiStrategyCoordinator.syncPositions)
      //
      // if (this.portfolioProjector) {
      //   const newQuantity = tracked.side === 'buy'
      //     ? (this.portfolioProjector.getPosition(tracked.tokenId)?.quantity ?? 0) + fillSize
      //     : (this.portfolioProjector.getPosition(tracked.tokenId)?.quantity ?? 0) - fillSize;
      //
      //   this.portfolioProjector.syncPosition(tracked.tokenId, newQuantity);
      //
      //   this.logger.info('[OrderReconciliationService] ✅ PortfolioProjector synced directly', {
      //     tokenId: tracked.tokenId.substring(0, 12) + '...',
      //     fillSide: tracked.side,
      //     fillSize: fillSize.toFixed(2),
      //     newQuantity: newQuantity.toFixed(2),
      //   });
      // }

      // ✅ v7.7.17: accumulateFill() уже untrack-нул ордер если fullyFilled!
      // Но для безопасности логируем решение
      if (!isFullyFilled) {
        this.logger.info('[OrderReconciliationService] Keeping order tracked (partial fill, waiting for more fills)', {
          orderId: tracked.orderId.substring(0, 8) + '...',
          filledSoFar: fillResult.filledSize.toFixed(2),
          remaining: fillResult.remainingSize.toFixed(2),
        });
      }
      return;
    }

    // СЛУЧАЙ C: Позиция НЕ изменилась → ЖДЕМ 30 СЕК!

    // Помечаем как "впервые исчез"
    if (!tracked.disappearedAt) {
      tracked.disappearedAt = Date.now();
      tracked.disappearedCount = 1;
      this.logger.info('[OrderReconciliationService] SCENARIO C: Order disappeared + NO position change → WAITING 30 SEC', {
        orderId: tracked.orderId.substring(0, 8) + '...',
        strategyId: tracked.strategyId,
        side: tracked.side,
        orderSize: tracked.size.toFixed(2),
        positionDelta: absDelta.toFixed(2),
        initialPosition: tracked.initialPosition.toFixed(2),
        decision: 'WAIT_30_SECONDS',
        note: 'Will wait for position change or timeout',
      });
      return;
    }

    // Увеличиваем счетчик
    tracked.disappearedCount = (tracked.disappearedCount || 0) + 1;

    const timeSinceDisappeared = Date.now() - tracked.disappearedAt;
    const checkCount = tracked.disappearedCount;

    this.logger.debug('[OrderReconciliationService] SCENARIO C: Still waiting (order disappeared, no position change)', {
      orderId: tracked.orderId.substring(0, 8) + '...',
      strategyId: tracked.strategyId,
      side: tracked.side,
      timeSince: Math.round(timeSinceDisappeared / 1000) + 's',
      checkCount,
      requiredTime: '60s',
      requiredChecks: 15,
    });

    // ✅ v7.7.6: Увеличен timeout с 30 до 60 секунд (Position API лагает до 60+ сек!)
    // Минимум 15 проверок = 15*4sec = 60sec
    if (timeSinceDisappeared < 60000 || checkCount < 15) {
      return; // Ещё ждем
    }

    // ✅ v7.7.18: КРИТИЧНО - НЕ используем getOrderById()!
    // Проверяем есть ли fills для этого order в глобальном хранилище strategyFills
    const strategyFills = this.strategyFills.get(tracked.strategyId) || [];
    const fillsForThisOrder = strategyFills.filter(f => f.orderId === tracked.orderId);

    if (fillsForThisOrder.length > 0) {
      // Order был filled - fills УЖЕ записаны через processFillsAndPublishEvents()
      this.logger.info('[OrderReconciliationService] SCENARIO C: Order FILLED (fills detected from API)', {
        orderId: tracked.orderId.substring(0, 8) + '...',
        strategyId: tracked.strategyId,
        fillsCount: fillsForThisOrder.length,
        totalFillSize: fillsForThisOrder.reduce((sum, f) => sum + f.size, 0).toFixed(2),
        decision: 'UNTRACK (fills already recorded)',
      });

      // Fills УЖЕ записаны в strategyFills через processFillsAndPublishEvents()
      // Просто untrack order
      this.untrackOrder(tracked.orderId);
      return;
    }

    // ✅ v7.7.18: Нет fills → order был CANCELLED
    this.logger.info('[OrderReconciliationService] SCENARIO C: Order CANCELLED (no fills, disappeared from exchange)', {
      orderId: tracked.orderId.substring(0, 8) + '...',
      strategyId: tracked.strategyId,
      side: tracked.side,
      orderSize: tracked.size.toFixed(2),
      timeSince: Math.round(timeSinceDisappeared / 1000) + 's',
      checkCount,
      decision: 'PUBLISH_ORDER_CANCELLED',
    });

    const cancelEvent = {
      type: 'OrderCancelled' as const,
      orderId: tracked.orderId,
      strategyId: tracked.strategyId,
      reason: 'Order disappeared from exchange with no fills',
      timestamp: new Date(),
    };

    const cancelEnvelope = createProductionEnvelope(cancelEvent, {
      environment: 'LIVE',
      accountId: 'default',
      strategyId: tracked.strategyId,
    });

    this.eventBus.publish(cancelEnvelope);
    this.untrackOrder(tracked.orderId);

    // ✅ v7.7.18: Удалён весь блок с getOrderById() - больше не нужен!
  }

  /**
   * v7.2: Проверить unexpected positions (кто-то торговал вручную)
   *
   * @param positions - Real positions from exchange
   *
   * @remarks
   * Проверяем есть ли positions которые мы не ожидали.
   *
   * Expected position = initialPosition из tracked orders для этого tokenId.
   * Если real position != expected → кто-то торговал вручную!
   *
   * Синхронизируем стратегию с реальностью через positionSyncCallback.
   */
  private async checkUnexpectedPositions(positions: any[]): Promise<void> {
    for (const position of positions) {
      const tokenId = position.tokenId;
      // ✅ CRITICAL FIX: position.size, NOT position.balance!
      const realPosition = position.size;

      // Находим все tracked orders для этого tokenId
      const trackedForToken = Array.from(this.trackedOrders.values()).filter(
        (o) => o.tokenId === tokenId
      );

      if (trackedForToken.length === 0 && realPosition > 0.01) {
        // Есть position, но нет tracked orders!
        this.logger.warn('[OrderReconciliationService] Unexpected position detected (no tracked orders)', {
          tokenId,
          realPosition: realPosition.toFixed(2),
          note: 'Someone may have traded manually or position left from previous session',
        });
        // Position sync через callback обработает это
      }
    }
  }

  /**
   * v6.4: Синхронизировать positions с биржей
   *
   * @remarks
   * **КРИТИЧНО**: Вызывается после каждого reconciliation loop!
   *
   * Алгоритм:
   * 1. Получаем реальные positions с биржи (getPositions API)
   * 2. Группируем по strategyId (из tracked orders)
   * 3. Вызываем positionSyncCallback для каждой стратегии
   *
   * Это гарантирует что PortfolioProjector всегда синхронизирован с биржей,
   * даже если OrderFilled events потеряны!
   */
  private async syncPositionsWithExchange(): Promise<void> {
    if (!this.positionSyncCallback) {
      return; // No callback registered
    }

    try {
      // Получаем реальные positions с биржи
      const realPositions = await (this.restAdapter as any).getPositions?.();

      if (!realPositions || realPositions.length === 0) {
        this.logger.debug('[OrderReconciliationService] No positions on exchange');
        return;
      }

      this.logger.debug('[OrderReconciliationService] Fetched positions for sync', {
        positionsCount: realPositions.length,
      });

      // Группируем positions по strategyId
      // ✅ v7.7.7: Use conditionId to find strategy, NOT tracked orders!
      // Strategy ID format: "dumb-{conditionId}"
      const positionsByStrategy = new Map<string, Array<{ tokenId: string; balance: number }>>();

      for (const pos of realPositions) {
        const tokenId = pos.tokenId;
        // ✅ CRITICAL FIX: position.size, NOT position.balance!
        const balance = pos.size;
        const conditionId = pos.conditionId;

        if (!conditionId) {
          this.logger.warn('[OrderReconciliationService] Position missing conditionId', { tokenId });
          continue;
        }

        // ✅ v7.7.7: Derive strategyId from conditionId (format: dumb-{conditionId})
        const strategyId = `dumb-${conditionId}`;

        if (!positionsByStrategy.has(strategyId)) {
          positionsByStrategy.set(strategyId, []);
        }
        positionsByStrategy.get(strategyId)!.push({ tokenId, balance });
      }

      // Вызываем callback
      await this.positionSyncCallback(positionsByStrategy);

      this.logger.debug('[OrderReconciliationService] Positions synced', {
        strategiesCount: positionsByStrategy.size,
      });
    } catch (error) {
      this.logger.error('[OrderReconciliationService] Failed to sync positions', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ✅ v7: УДАЛЕНО - reconcilePositions() и checkUnexpectedPositions()
  // Причина: Новая логика работает через syncPositionsWithExchange()
  // НЕ публикуем OrderFilled events - просто синхронизируем positions!

  /**
   * Get current tracked orders (for debugging)
   */
  getTrackedOrders(): TrackedOrder[] {
    return Array.from(this.trackedOrders.values());
  }

  /**
   * ✅ v7.7.7: Get trade history for market (temporary debug solution)
   *
   * @param conditionId - Market condition ID
   *
   * @remarks
   * Gets ALL fills for a market without time filter.
   * Used to debug and show fill history in logs.
   *
   * @example
   * ```typescript
   * await service.logTradeHistoryForMarket('0xbd31dc8a...');
   * // Logs all fills for this market
   * ```
   */
  /**
   * v7.7.9: Get filled orders for market (for debugging)
   *
   * @param conditionId - Market condition ID (not used directly, but tokenId derived)
   * @param tokenId - Token ID to filter by
   *
   * @remarks
   * Uses /data/orders?status=MATCHED to get filled orders.
   * More reliable than /data/trades.
   *
   * @example
   * ```typescript
   * await service.logTradeHistoryForMarket('0xabc...', '12345...');
   * // Logs: "📊 TRADE HISTORY: 5 fills"
   * ```
   */
  async logTradeHistoryForMarket(conditionId: string, tokenId?: string): Promise<void> {
    if (!this.orderClient) {
      this.logger.warn('[OrderReconciliationService] No orderClient - cannot get trade history');
      return;
    }

    try {
      this.logger.info('[OrderReconciliationService] 📜 v7.7.9: Fetching ALL filled orders for market...', {
        conditionId: conditionId.substring(0, 16) + '...',
        tokenId: tokenId ? tokenId.substring(0, 16) + '...' : 'all',
      });

      // Get ALL filled orders via /data/trades for this token
      const makerAddress = this.orderClient.getMakerAddress();
      const allFilledOrders = await this.orderClient.getFilledOrders(tokenId, makerAddress, 100);

      this.logger.info('[OrderReconciliationService] 📊 v7.7.10: FILLS HISTORY from /data/trades', {
        market: conditionId.substring(0, 16) + '...',
        tokenId: tokenId ? tokenId.substring(0, 16) + '...' : 'all',
        makerAddress: makerAddress ? makerAddress.substring(0, 10) + '...' : 'none',
        totalFills: allFilledOrders.length,
        fills: allFilledOrders.map((trade: any) => ({
          id: trade.id?.substring(0, 12) + '...',
          order_id: trade.order_id?.substring(0, 8) + '...',
          side: trade.side,
          price: trade.price,
          size: trade.size,
          timestamp: new Date(trade.timestamp).toLocaleTimeString('ru-RU'),
        })),
      });
    } catch (error) {
      this.logger.error('[OrderReconciliationService] Failed to get filled orders history', {
        conditionId: conditionId.substring(0, 16) + '...',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * v6.4: Get tracked order info (with partial fills)
   *
   * @param orderId - Order ID
   * @returns Order info или null if not tracked
   *
   * @remarks
   * Возвращает детальную информацию о tracked order:
   * - Filled size, remaining size
   * - Average fill price (weighted)
   * - Fill history (все частичные заполнения)
   *
   * @example
   * ```typescript
   * const info = service.getTrackedOrderInfo('123');
   * if (info) {
   *   console.log(`Filled ${info.filledSize}/${info.size}, avg price ${info.averageFillPrice}`);
   *   console.log(`Fills: ${info.fillHistory.length}`);
   * }
   * ```
   */
  getTrackedOrderInfo(orderId: string): {
    orderId: string;
    strategyId: string;
    side: 'buy' | 'sell';
    size: number;
    filledSize: number;
    remainingSize: number;
    averageFillPrice: number;
    fillHistory: FillEntry[];
  } | null {
    const order = this.trackedOrders.get(orderId);
    if (!order) {
      return null;
    }

    const remainingSize = Math.max(0, order.size - order.filledSize);

    // Вычисляем средневзвешенную цену
    const totalValue = order.fillHistory.reduce(
      (sum, fill) => sum + fill.size * fill.price,
      0
    );
    const averageFillPrice = order.filledSize > 0 ? totalValue / order.filledSize : order.price;

    return {
      orderId: order.orderId,
      strategyId: order.strategyId,
      side: order.side,
      size: order.size,
      filledSize: order.filledSize,
      remainingSize,
      averageFillPrice,
      fillHistory: [...order.fillHistory], // Clone array
    };
  }

  /**
   * v6.3: GATEKEEPER - Check if strategy has pending orders
   *
   * @param strategyId - Strategy ID to check
   * @returns true if strategy has any tracked orders (pending on exchange)
   *
   * @remarks
   * **КРИТИЧНО**: Это единственный источник истины для проверки "можно ли генерировать новый intent".
   *
   * Источник истины = trackedOrders (orders accepted by exchange, not yet filled/cancelled)
   *
   * Strategy MUST call this before generating new intent:
   * - If returns true → BLOCK intent generation (already have pending order)
   * - If returns false → OK to generate intent (no pending orders)
   *
   * This prevents:
   * - Multiple orders accumulating
   * - Race conditions with OrderAccepted events
   * - Desync between strategy state and exchange state
   *
   * @example
   * ```typescript
   * // Before generating intent:
   * if (reconciliationService.hasPendingOrders('dumb-1')) {
   *   return []; // BLOCK - already have pending order
   * }
   *
   * // OK to generate intent
   * return [{ type: 'PlaceOrder', ... }];
   * ```
   */
  hasPendingOrders(strategyId: string): boolean {
    // ✅ v7.7.18: КРИТИЧНО - Используем РЕАЛЬНЫЕ orders с биржи!
    // trackedOrders - ВНУТРЕННЕЕ состояние (может быть устаревшим)
    // PortfolioProjector.getSnapshot().orders - РЕАЛЬНОСТЬ (данные с биржи)
    if (this.portfolioProjector) {
      const snapshot = this.portfolioProjector.getSnapshot(strategyId);
      if (snapshot) {
        return snapshot.orders.length > 0; // РЕАЛЬНЫЕ ордера на бирже!
      }
    }

    // Fallback для backtest/replay mode (нет portfolioProjector)
    for (const order of this.trackedOrders.values()) {
      if (order.strategyId === strategyId) {
        return true; // Found pending order for this strategy
      }
    }
    return false; // No pending orders for this strategy
  }

  /**
   * v6.3: Get count of pending orders for strategy
   *
   * @param strategyId - Strategy ID to check
   * @returns Number of pending orders for this strategy
   *
   * @remarks
   * Used for logging and telemetry.
   * Prefer `hasPendingOrders()` for boolean checks.
   */
  getPendingOrdersCount(strategyId: string): number {
    let count = 0;
    for (const order of this.trackedOrders.values()) {
      if (order.strategyId === strategyId) {
        count++;
      }
    }
    return count;
  }

  /**
   * v6.3: Get pending orders for strategy
   *
   * @param strategyId - Strategy ID to check
   * @returns Array of pending orders for this strategy
   *
   * @remarks
   * Returns detailed info about all tracked orders for this strategy.
   * Used for debugging and telemetry.
   */
  getPendingOrders(strategyId: string): TrackedOrder[] {
    const pending: TrackedOrder[] = [];
    for (const order of this.trackedOrders.values()) {
      if (order.strategyId === strategyId) {
        pending.push(order);
      }
    }
    return pending;
  }

  /**
   * v6.3: Assert strategy is idle (no pending orders)
   *
   * @param strategyId - Strategy ID to check
   * @throws {Error} If strategy has pending orders
   *
   * @remarks
   * Hard assertion - use for invariant checks.
   * Prefer `hasPendingOrders()` for soft checks.
   *
   * @example
   * ```typescript
   * // Before critical operation:
   * reconciliationService.assertIdle('dumb-1');
   * // Throws if strategy has pending orders
   * ```
   */
  assertIdle(strategyId: string): void {
    const pending = this.getPendingOrders(strategyId);
    if (pending.length > 0) {
      throw new Error(
        `Strategy ${strategyId} has ${pending.length} pending orders: ${pending
          .map((o) => `${o.orderId.substring(0, 8)}... (${o.side})`)
          .join(', ')}`
      );
    }
  }

  /**
   * ✅ v7.7.10: Process fills from /data/trades and publish OrderFilled events
   *
   * @param trades - Array of trades from /data/trades API
   *
   * @remarks
   * Алгоритм:
   * 1. Filter out already processed fills (by trade.id)
   * 2. For each new fill:
   *    - Create OrderFilled event with REAL execution price from trade
   *    - Publish event to EventBus
   *    - Mark fill as processed (deduplicate)
   *
   * This ensures that DumbStrategy receives OrderFilled events with correct prices,
   * so lastFillPrice will be updated correctly!
   *
   * @example
   * ```typescript
   * const trades = await orderClient.getFilledOrders(tokenId, makerAddress);
   * await this.processFillsAndPublishEvents(trades);
   * // OrderFilled events published with real execution prices
   * ```
   */
  private async processFillsAndPublishEvents(fills: any[]): Promise<void> {
    if (fills.length === 0) {
      return;
    }

    // ✅ v7.7.16: КРИТИЧНО - Получаем список АКТИВНЫХ стратегий и их tokenIds!
    // Нам нужно обрабатывать ТОЛЬКО fills для ТЕКУЩИХ рынков, не старые fills!
    const activeTokenIds = new Set<string>();
    if (this.metricsProjector) {
      const allStrategies = this.metricsProjector.getAllMetrics();
      for (const strategy of allStrategies) {
        if (strategy.tokenId) {
          activeTokenIds.add(strategy.tokenId);
        }
      }
    }

    // ✅ v7.7.16: КРИТИЧНО - Если нет активных стратегий → НЕ обрабатывать fills!
    // Это первый reconciliation цикл, стратегии еще не зарегистрированы
    if (activeTokenIds.size === 0) {
      this.logger.debug('[OrderReconciliationService] No active strategies yet - skipping fills processing', {
        fillsCount: fills.length,
      });
      return;
    }

    this.logger.info('[OrderReconciliationService] Processing fills for active strategies', {
      fillsCount: fills.length,
      activeStrategiesCount: activeTokenIds.size,
      activeTokenIds: Array.from(activeTokenIds).map(id => id.substring(0, 12) + '...'),
    });

    let publishedCount = 0;
    let skippedCount = 0;
    let skippedOldMarketsCount = 0;

    for (const fill of fills) {
      // ✅ v7.7.12: Extract data from maker_orders[] if we were MAKER
      // CRITICAL: /data/trades returns TAKER perspective!
      // - fill.side = TAKER side
      // - fill.price = TAKER price
      // - fill.asset_id = TAKER token
      // Our data is in fill.maker_orders[] array!

      const tradeId = fill.id;
      let orderId: string;
      let side: 'BUY' | 'SELL';
      let price: number;
      let size: number;
      let tokenId: string;
      let timestamp: Date;

      // Check if we were MAKER or TAKER
      let outcome: string | undefined;
      let marketId: string | undefined;
      let traderSide: 'MAKER' | 'TAKER' | undefined;

      if (fill.trader_side === 'MAKER' && fill.maker_orders && fill.maker_orders.length > 0) {
        // ✅ We were MAKER - extract from maker_orders[]
        // Find our maker_order (should match our maker_address)
        const ourMakerOrder = fill.maker_orders[0]; // Usually only one maker order per trade

        orderId = ourMakerOrder.order_id;
        side = ourMakerOrder.side?.toUpperCase() as 'BUY' | 'SELL';
        price = parseFloat(ourMakerOrder.price || 0);
        size = parseFloat(ourMakerOrder.matched_amount || 0);
        tokenId = ourMakerOrder.asset_id;
        outcome = ourMakerOrder.outcome; // ✅ UP or DOWN
        marketId = fill.market; // ✅ Market/condition ID
        traderSide = 'MAKER';
        timestamp = fill.match_time ? new Date(parseInt(fill.match_time) * 1000) : new Date();
      } else {
        // ✅ We were TAKER or fallback to old format
        // CRITICAL v7.7.16: For TAKER fills, extract our order_id from maker_orders[]!
        // When we were TAKER, API doesn't provide order_id directly.
        // Our order is in maker_orders[] array (the maker we matched against).

        if (fill.trader_side === 'TAKER' && fill.maker_orders && fill.maker_orders.length > 0) {
          // ✅ TAKER fill - extract from maker_orders[]
          // Find our maker_order (should be the one we matched against)
          const ourMakerOrder = fill.maker_orders[0]; // Usually only one maker order per trade

          orderId = ourMakerOrder.order_id; // ✅ REAL order_id from maker!
          side = fill.side?.toUpperCase() as 'BUY' | 'SELL'; // Use fill.side (taker perspective)
          price = parseFloat(fill.price || 0);
          size = parseFloat(fill.size || 0);
          tokenId = fill.asset_id || ourMakerOrder.asset_id;
          outcome = ourMakerOrder.outcome;
          marketId = fill.market;
          traderSide = 'TAKER';
          timestamp = fill.match_time ? new Date(parseInt(fill.match_time) * 1000) : new Date();
        } else {
          // ✅ OLD FORMAT: /data/orders?status=MATCHED (aggregated orders)
          orderId = fill.order_id || fill.id;
          side = fill.side?.toUpperCase() as 'BUY' | 'SELL';
          price = parseFloat(fill.price || fill.avg_price || fill.avgPrice || 0);
          size = parseFloat(fill.size || fill.size_matched || 0);
          tokenId = fill.asset_id || fill.tokenId;
          outcome = fill.outcome;
          marketId = fill.market;
          traderSide = fill.trader_side === 'TAKER' ? 'TAKER' : undefined;
          timestamp = fill.timestamp ? new Date(fill.timestamp) :
                     fill.created_at ? new Date(fill.created_at) :
                     fill.match_time ? new Date(parseInt(fill.match_time) * 1000) : new Date();
        }
      }

      // ✅ v7.7.16: КРИТИЧНО - Пропускаем fills для НЕАКТИВНЫХ рынков!
      // Обрабатываем ТОЛЬКО fills для текущих стратегий (активные рынки)
      if (activeTokenIds.size > 0 && tokenId && !activeTokenIds.has(tokenId)) {
        skippedOldMarketsCount++;
        continue; // Старый fill из прошлой сессии - SKIP!
      }

      // Skip if already processed (deduplicate)
      if (this.processedFillIds.has(tradeId)) {
        skippedCount++;
        continue;
      }

      // Skip if missing required fields
      if (!tradeId || !orderId || !side || isNaN(price) || isNaN(size)) {
        this.logger.warn('[OrderReconciliationService] Skip fill with missing fields', {
          tradeId: tradeId?.substring(0, 12) + '...',
          orderId: orderId?.substring(0, 8) + '...',
          side,
          price,
          size,
        });
        skippedCount++;
        continue;
      }

      // ✅ v7.7.14: Find strategyId from tracked orders OR persistent mapping!
      let strategyId: string | undefined;
      let isCurrentlyTracked = false; // Order СЕЙЧАС в trackedOrders Map
      const trackedOrder = this.trackedOrders.get(orderId);
      if (trackedOrder) {
        strategyId = trackedOrder.strategyId;
        isCurrentlyTracked = true;
      } else {
        // ✅ КРИТИЧНО: Order may be untracked, check persistent mapping!
        const mapping = this.orderIdToStrategyId.get(orderId);
        if (mapping) {
          strategyId = mapping.strategyId;
          isCurrentlyTracked = false; // Was tracked, but NOW untracked (fully filled)
          this.logger.warn('[OrderReconciliationService] Fill for untracked order (using persistent mapping)', {
            orderId: orderId.substring(0, 8) + '...',
            strategyId: strategyId.substring(0, 20) + '...',
            side,
            size,
            price,
            note: 'Order was untracked (fully filled?) but we have persistent mapping - CANNOT record fill!',
          });
        } else if (marketId) {
          // ✅ v7.7.16: FALLBACK - Derive strategyId from marketId/conditionId for old fills!
          // Strategy ID format: dumb-{conditionId}
          // ⚠️ v7.7.17: This is ONLY for MetricsProjector (UI legacy)!
          // DO NOT use for PortfolioProjector (would mix old fills with new strategy)
          strategyId = `dumb-${marketId}`;
          isCurrentlyTracked = false; // Old fill from previous session
          this.logger.warn('[OrderReconciliationService] Fill for unknown order (derived strategyId from marketId)', {
            orderId: orderId.substring(0, 8) + '...',
            marketId: marketId.substring(0, 12) + '...',
            strategyId: strategyId.substring(0, 20) + '...',
            side,
            size,
            price,
            note: 'Old fill from previous session OR order never tracked',
          });
        } else {
          this.logger.error('[OrderReconciliationService] Fill for completely unknown order (NO marketId, NO mapping)', {
            orderId: orderId.substring(0, 8) + '...',
            side,
            size,
            price,
            note: 'Cannot determine strategyId - CRITICAL DATA LOSS!',
          });
        }
      }

      // ✅ v7.7.15: OrderFilled УДАЛЁН - стратегия работает только по StrategyTick!
      // Публикация событий отключена, только синхронизация позиций!
      // const orderFilledEvent: OrderFilled = { ... };
      // this.eventBus.publish(envelope);

      // ✅ v7.7.18: КРИТИЧНО - Записываем fill В ГЛОБАЛЬНОЕ ХРАНИЛИЩЕ strategyFills!
      // Fills - это ФАКТЫ, они существуют НЕЗАВИСИМО от trackedOrders!
      // НЕ важно tracked order или нет - fill ПРОИЗОШЁЛ на бирже!
      if (strategyId) {
        // Получить или создать массив fills для этой стратегии
        let fills = this.strategyFills.get(strategyId);
        if (!fills) {
          fills = [];
          this.strategyFills.set(strategyId, fills);
        }

        // Добавить fill в глобальное хранилище
        fills.push({
          orderId,
          side: side.toLowerCase() as 'buy' | 'sell',
          price,
          size,
          timestamp,
          fillReason: 'REAL' as const,
          outcomeName: outcome,
          tokenId,
          marketId,
        });

        this.logger.info('[OrderReconciliationService] Fill recorded from API to global storage', {
          orderId: orderId.substring(0, 8) + '...',
          strategyId: strategyId.substring(0, 20) + '...',
          side,
          price: price.toFixed(4),
          size: size.toFixed(2),
          totalFillsForStrategy: fills.length,
          traderSide,
          source: isCurrentlyTracked ? 'TRACKED_ORDER' : 'PERSISTENT_MAPPING_OR_DERIVED',
        });

        // ✅ ОПЦИОНАЛЬНО: Если order tracked, также записываем в fillHistory (для обратной совместимости)
        if (isCurrentlyTracked) {
          const fillResult = this.accumulateFill(orderId, size, price, timestamp);
          if (!fillResult) {
            this.logger.warn('[OrderReconciliationService] accumulateFill() failed but fill recorded in global storage', {
              orderId: orderId.substring(0, 8) + '...',
            });
          }
        }
      } else {
        this.logger.error('[OrderReconciliationService] Cannot record fill - no strategyId', {
          orderId: orderId.substring(0, 8) + '...',
          side,
          price,
          size,
        });
      }

      // Mark as processed
      this.processedFillIds.add(tradeId);

      publishedCount++;

      this.logger.debug('[OrderReconciliationService] 📤 Published OrderFilled event', {
        tradeId: tradeId.substring(0, 12) + '...',
        orderId: orderId.substring(0, 8) + '...',
        side,
        price,
        size,
        outcome, // ✅ UP or DOWN
        tokenId: tokenId?.substring(0, 12) + '...',
        marketId: marketId?.substring(0, 12) + '...',
        traderSide, // ✅ MAKER or TAKER
        strategyId: strategyId || 'unknown',
      });
    }

    if (publishedCount > 0 || skippedCount > 0 || skippedOldMarketsCount > 0) {
      this.logger.info('[OrderReconciliationService] ✅ v7.7.16: Fills processed', {
        total: fills.length,
        published: publishedCount,
        skipped: skippedCount,
        skippedOldMarkets: skippedOldMarketsCount,
        processedFillsTotal: this.processedFillIds.size,
      });
    }
  }

  /**
   * ✅ v7.7.15: Update orders in metricsProjector for UI display
   *
   * @param openOrders - Open orders from exchange
   *
   * @remarks
   * Maps exchange orders to StrategyMetricDisplayData.orders for each strategy.
   * Called from reconcile() after fetching open orders.
   */
  private updateOrdersInMetrics(openOrders: any[]): void {
    // Update orders display in UI

    // ✅ КРИТИЧНО: Группируем ордера по tokenId (НЕ по trackedOrders!)
    // Показываем ВСЕ ордера с биржи, а не только tracked!
    const ordersByTokenId = new Map<string, any[]>();

    for (const order of openOrders) {
      const tokenId = order.tokenId || order.asset_id || order.market;
      if (!tokenId) {
        continue;
      }

      if (!ordersByTokenId.has(tokenId)) {
        ordersByTokenId.set(tokenId, []);
      }
      ordersByTokenId.get(tokenId)!.push(order);
    }

    // ✅ Получаем все стратегии из metricsProjector
    const allStrategies = this.metricsProjector.getAllMetrics();

    // ✅ Для каждой стратегии находим ордера по её tokenId
    for (const strategy of allStrategies) {
      const tokenId = strategy.tokenId;
      if (!tokenId) {
        continue;
      }

      // Находим ВСЕ ордера для этого tokenId
      const ordersForToken = ordersByTokenId.get(tokenId) || [];

      // ✅ v7.7.15: FALLBACK - Добавить tracked orders если API еще не вернул их!
      // API может иметь лаг - tracked orders могут быть размещены, но еще не видны в getOpenOrders()
      const trackedOrdersForToken: any[] = [];
      for (const tracked of this.trackedOrders.values()) {
        if (tracked.tokenId === tokenId) {
          // Проверим что ордер еще не в ordersForToken (избежать дубликатов)
          const alreadyInList = ordersForToken.some((o: any) => o.orderId === tracked.orderId);
          if (!alreadyInList) {
            trackedOrdersForToken.push({
              orderId: tracked.orderId,
              side: tracked.side.toUpperCase(),
              price: tracked.price,
              size: tracked.size,
              filledSize: 0,
              createdAt: new Date().toISOString(),
            });
          }
        }
      }

      // Объединяем ордера из API + tracked orders
      const allOrdersForToken = [...ordersForToken, ...trackedOrdersForToken];

      const displayOrders = allOrdersForToken.map((o) => ({
        id: o.orderId,
        tokenId: tokenId,
        side: o.side?.toUpperCase() as 'BUY' | 'SELL',
        price: o.price || 0,
        size: o.size || 0,
        filledSize: o.filledSize || 0,
        status: 'LIVE', // Open order status
        createdAt: o.createdAt || new Date().toISOString(),
      }));

      // ✅ v7.7.17: Синхронизируем ордера в PortfolioProjector (source of truth)
      if (this.portfolioProjector) {
        this.portfolioProjector.syncOrders(strategy.strategyId, displayOrders);
      }

      // ✅ LEGACY: Также обновляем MetricsProjector для совместимости (будет удалено позже)
      if (this.metricsProjector) {
        this.metricsProjector.setOrders(strategy.strategyId, displayOrders);
      }
    }
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.stop();
    this.trackedOrders.clear();
    this.processedFillIds.clear(); // ✅ v7.7.10: Clear processed fills
    this.orderIdToStrategyId.clear(); // ✅ v7.7.14: Clear persistent mappings
    this.logger.info('[OrderReconciliationService] Destroyed');
  }
}
