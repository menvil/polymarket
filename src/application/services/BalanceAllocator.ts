/**
 * Balance Allocator for Multi-Market Trading
 *
 * @remarks
 * Manages dynamic capital distribution across multiple markets.
 * Implements two-level balance management:
 * 1. Total balance → Trading balance (via ratio)
 * 2. Trading balance → Per-market allocation
 *
 * Key features:
 * - Dynamic balance updates on profit/loss
 * - Smart allocation of free balance to new markets
 * - Automatic redistribution after market expiry
 * - Comprehensive metrics tracking
 *
 * Algorithm for new market allocation:
 * 1. Calculate free balance = tradingBalance - occupiedBalance
 * 2. Determine how many slots are available
 * 3. Distribute ALL free balance among new markets (above minimum)
 * 4. Ensure each market gets >= minCapitalPerMarket
 *
 * @example
 * ```typescript
 * const allocator = new BalanceAllocator(
 *   Money.fromUSDC(1000),
 *   { tradingBalanceRatio: 0.8, minCapitalPerMarket: 10, maxConcurrentMarkets: 10 },
 *   logger
 * );
 *
 * // Initial allocation
 * const result = allocator.allocateToNewMarkets(['market1', 'market2'], 2);
 *
 * // After market completes with profit
 * allocator.releaseWithPnL('market1', Money.fromUSDC(20)); // +$20 profit
 *
 * // Allocate to replacement market
 * const newAlloc = allocator.allocateToNewMarkets(['market3'], 1);
 * ```
 */
import { Money } from '../../domain/value-objects/Money.js';
import { ILogger } from '../../domain/ports/ILogger.js';

/**
 * Configuration for balance allocation
 */
export interface BalanceAllocatorConfig {
  /**
   * Fraction of total balance available for trading
   * Value: (0.0, 1.0]
   */
  tradingBalanceRatio: number;

  /**
   * Minimum capital required per market (USDC)
   * Must be > 0
   */
  minCapitalPerMarket: number;

  /**
   * Maximum concurrent markets (0 = unlimited)
   */
  maxConcurrentMarkets: number;
}

/**
 * Result of balance allocation
 */
export interface AllocationResult {
  /**
   * Map of marketId → allocated balance
   */
  allocations: Map<string, Money>;

  /**
   * Balance allocated to each market (may vary per market)
   */
  perMarketBalance: Money;

  /**
   * Number of markets that received allocation
   */
  marketCount: number;

  /**
   * Whether allocation was limited by minCapitalPerMarket
   */
  wasLimitedByMinCapital: boolean;

  /**
   * Original requested market count before any reductions
   */
  requestedMarketCount: number;

  /**
   * Total amount allocated in this operation
   */
  totalAllocated: Money;
}

/**
 * Extended statistics about current allocations
 */
export interface AllocationStats {
  /**
   * Total balance (before ratio)
   */
  totalBalance: Money;

  /**
   * Trading balance (after ratio)
   */
  tradingBalance: Money;

  /**
   * Currently allocated/occupied balance
   */
  allocatedBalance: Money;

  /**
   * Free (unallocated) trading balance
   */
  freeBalance: Money;

  /**
   * Number of active market allocations
   */
  marketCount: number;

  /**
   * Per-market balance (if any markets allocated) - average
   */
  perMarketBalance: Money | null;

  /**
   * Utilization ratio: allocatedBalance / tradingBalance (0-1)
   */
  utilization: number;

  /**
   * Utilization as percentage (0-100)
   */
  utilizationPercent: number;

  /**
   * Average capital per market
   */
  avgCapitalPerMarket: number;

  /**
   * Accumulated remainder/change (tradingBalance - allocatedBalance)
   */
  remainder: Money;

  /**
   * Maximum markets that can be added with current free balance
   */
  availableSlots: number;
}

/**
 * Manages balance allocation across multiple markets
 *
 * @remarks
 * Provides dynamic distribution of trading capital among markets
 * with automatic adjustment on profit/loss and market completion.
 *
 * Key responsibilities:
 * - Calculate trading balance from total balance (dynamic)
 * - Distribute capital among markets (can vary per market)
 * - Handle profit/loss updates
 * - Track detailed metrics
 * - Manage market addition and removal
 */
export class BalanceAllocator {
  private totalBalance: Money;
  private tradingBalance: Money;
  private readonly config: BalanceAllocatorConfig;
  private readonly logger: ILogger;
  private readonly allocations: Map<string, Money> = new Map();

  /**
   * Creates a new BalanceAllocator
   *
   * @param totalBalance - Total available balance
   * @param config - Allocation configuration
   * @param logger - Logger instance
   * @throws {Error} If tradingBalanceRatio is not in (0, 1]
   * @throws {Error} If minCapitalPerMarket is <= 0
   */
  constructor(
    totalBalance: Money,
    config: BalanceAllocatorConfig,
    logger: ILogger
  ) {
    // Validate config
    if (config.tradingBalanceRatio <= 0 || config.tradingBalanceRatio > 1) {
      throw new Error(
        `tradingBalanceRatio must be in (0, 1], got: ${config.tradingBalanceRatio}`
      );
    }

    if (config.minCapitalPerMarket <= 0) {
      throw new Error(
        `minCapitalPerMarket must be > 0, got: ${config.minCapitalPerMarket}`
      );
    }

    this.totalBalance = totalBalance;
    this.config = config;
    this.logger = logger;

    // Calculate trading balance
    this.tradingBalance = totalBalance.multiply(config.tradingBalanceRatio);

    this.logger.info('BalanceAllocator initialized', {
      totalBalance: totalBalance.amount,
      tradingBalanceRatio: config.tradingBalanceRatio,
      tradingBalance: this.tradingBalance.amount,
      minCapitalPerMarket: config.minCapitalPerMarket,
      maxConcurrentMarkets: config.maxConcurrentMarkets,
    });
  }

  /**
   * Allocates balance to new markets from free balance
   *
   * @param marketIds - Array of new market IDs to allocate to
   * @param remainingSlots - Number of slots available for new markets
   * @returns Allocation result with per-market balances
   *
   * @remarks
   * Algorithm:
   * 1. Calculate free balance (tradingBalance - currently allocated)
   * 2. Limit markets by remainingSlots
   * 3. Calculate per-market balance = freeBalance / newMarketCount
   * 4. If perMarketBalance < minCapitalPerMarket:
   *    - Reduce market count
   *    - Use minCapitalPerMarket per market
   * 5. Distribute ALL free balance (not just minimum) across selected markets
   *
   * @example
   * ```typescript
   * // After one market expires, allocate to new market with all free balance
   * const result = allocator.allocateToNewMarkets(['new-market'], 1);
   * // result.perMarketBalance may be > minCapitalPerMarket
   * ```
   */
  allocateToNewMarkets(marketIds: string[], remainingSlots: number): AllocationResult {
    const requestedMarketCount = marketIds.length;

    // Handle empty input
    if (requestedMarketCount === 0 || remainingSlots <= 0) {
      this.logger.debug('No markets to allocate or no slots available', {
        requestedMarkets: requestedMarketCount,
        remainingSlots,
      });
      return {
        allocations: new Map(),
        perMarketBalance: Money.zero(),
        marketCount: 0,
        wasLimitedByMinCapital: false,
        requestedMarketCount,
        totalAllocated: Money.zero(),
      };
    }

    // Calculate free balance
    const stats = this.getStats();
    const freeBalance = stats.freeBalance;

    if (freeBalance.amount < this.config.minCapitalPerMarket) {
      this.logger.warn('Insufficient free balance for any market', {
        freeBalance: freeBalance.amount,
        minCapitalPerMarket: this.config.minCapitalPerMarket,
      });
      return {
        allocations: new Map(),
        perMarketBalance: Money.zero(),
        marketCount: 0,
        wasLimitedByMinCapital: true,
        requestedMarketCount,
        totalAllocated: Money.zero(),
      };
    }

    // Step 1: Determine how many markets we can add
    let targetMarkets = Math.min(requestedMarketCount, remainingSlots);

    // Step 2: Calculate per-market balance using ALL free balance
    let perMarketBalance = freeBalance.divide(targetMarkets);
    let wasLimitedByMinCapital = false;

    // Step 3: Check minimum capital requirement
    if (perMarketBalance.amount < this.config.minCapitalPerMarket) {
      // Reduce market count to fit minimum capital
      const maxAffordableMarkets = Math.floor(
        freeBalance.amount / this.config.minCapitalPerMarket
      );

      if (maxAffordableMarkets === 0) {
        this.logger.warn('Free balance insufficient for minimum capital', {
          freeBalance: freeBalance.amount,
          minCapitalPerMarket: this.config.minCapitalPerMarket,
        });
        return {
          allocations: new Map(),
          perMarketBalance: Money.zero(),
          marketCount: 0,
          wasLimitedByMinCapital: true,
          requestedMarketCount,
          totalAllocated: Money.zero(),
        };
      }

      this.logger.info('Reducing market count due to capital constraints', {
        requestedMarkets: targetMarkets,
        affordableMarkets: maxAffordableMarkets,
        freeBalance: freeBalance.amount,
        minCapitalPerMarket: this.config.minCapitalPerMarket,
      });

      targetMarkets = Math.min(targetMarkets, maxAffordableMarkets);
      // Recalculate with new market count - use ALL free balance
      perMarketBalance = freeBalance.divide(targetMarkets);
      wasLimitedByMinCapital = true;
    }

    // Step 4: Create allocations
    const selectedMarkets = marketIds.slice(0, targetMarkets);
    const allocations = new Map<string, Money>();
    let totalAllocated = 0;

    for (const marketId of selectedMarkets) {
      allocations.set(marketId, perMarketBalance);
      this.allocations.set(marketId, perMarketBalance);
      totalAllocated += perMarketBalance.amount;
    }

    this.logger.info('Balance allocated to new markets', {
      requestedMarkets: requestedMarketCount,
      allocatedMarkets: targetMarkets,
      perMarketBalance: perMarketBalance.amount,
      totalAllocated,
      freeBalanceBefore: freeBalance.amount,
      freeBalanceAfter: freeBalance.amount - totalAllocated,
      wasLimitedByMinCapital,
    });

    return {
      allocations,
      perMarketBalance,
      marketCount: targetMarkets,
      wasLimitedByMinCapital,
      requestedMarketCount,
      totalAllocated: Money.fromUSDC(totalAllocated),
    };
  }

  /**
   * Releases allocation and updates total balance with PnL
   *
   * @param marketId - Market ID to release
   * @param pnl - Profit/Loss from the market (positive = profit, negative = loss)
   * @returns Released amount (original allocation)
   *
   * @remarks
   * This method:
   * 1. Removes the allocation for the market
   * 2. Updates totalBalance with the PnL
   * 3. Recalculates tradingBalance
   *
   * @example
   * ```typescript
   * // Market completed with $20 profit
   * allocator.releaseWithPnL('market1', Money.fromUSDC(20));
   *
   * // Market completed with $15 loss
   * allocator.releaseWithPnL('market2', Money.fromUSDC(-15));
   * ```
   */
  releaseWithPnL(marketId: string, pnl: Money): Money {
    const allocation = this.allocations.get(marketId);
    if (!allocation) {
      this.logger.warn('Attempted to release non-existent allocation', {
        marketId,
      });
      return Money.zero();
    }

    // Remove allocation
    this.allocations.delete(marketId);

    // Update total balance with PnL
    const oldTotalBalance = this.totalBalance;
    this.totalBalance = this.totalBalance.add(pnl);
    this.tradingBalance = this.totalBalance.multiply(this.config.tradingBalanceRatio);

    this.logger.info('Allocation released with PnL', {
      marketId,
      originalAllocation: allocation.amount,
      pnl: pnl.amount,
      oldTotalBalance: oldTotalBalance.amount,
      newTotalBalance: this.totalBalance.amount,
      newTradingBalance: this.tradingBalance.amount,
      remainingAllocations: this.allocations.size,
    });

    return allocation;
  }

  /**
   * Releases allocation without PnL update (for backwards compatibility)
   *
   * @param marketId - Market ID to release
   * @returns Released amount
   */
  release(marketId: string): Money {
    return this.releaseWithPnL(marketId, Money.zero());
  }

  /**
   * Updates total balance (e.g., after fetching from exchange)
   *
   * @param newTotalBalance - New total balance
   *
   * @remarks
   * Use this when you fetch actual balance from the exchange
   * to sync the allocator with real balance.
   */
  updateTotalBalance(newTotalBalance: Money): void {
    const oldTotalBalance = this.totalBalance;
    this.totalBalance = newTotalBalance;
    this.tradingBalance = newTotalBalance.multiply(this.config.tradingBalanceRatio);

    this.logger.info('Total balance updated', {
      oldTotalBalance: oldTotalBalance.amount,
      newTotalBalance: newTotalBalance.amount,
      oldTradingBalance: oldTotalBalance.multiply(this.config.tradingBalanceRatio).amount,
      newTradingBalance: this.tradingBalance.amount,
    });
  }

  /**
   * Gets allocation for a specific market
   *
   * @param marketId - Market ID to query
   * @returns Allocated money or null if not allocated
   */
  getAllocation(marketId: string): Money | null {
    return this.allocations.get(marketId) ?? null;
  }

  /**
   * Checks if a new market can be added
   *
   * @returns True if there's capacity for another market
   */
  canAddMarket(): boolean {
    // Check max concurrent markets limit
    if (
      this.config.maxConcurrentMarkets > 0 &&
      this.allocations.size >= this.config.maxConcurrentMarkets
    ) {
      return false;
    }

    // Check if we have enough free balance
    const stats = this.getStats();
    return stats.freeBalance.amount >= this.config.minCapitalPerMarket;
  }

  /**
   * Adds allocation for a single market with all available free balance
   *
   * @param marketId - Market ID to add
   * @returns Allocated amount or null if cannot allocate
   *
   * @remarks
   * Allocates ALL free balance to the new market (not just minimum).
   * This ensures maximum capital utilization.
   */
  addMarket(marketId: string): Money | null {
    if (this.allocations.has(marketId)) {
      this.logger.warn('Market already has allocation', { marketId });
      return this.allocations.get(marketId) ?? null;
    }

    if (!this.canAddMarket()) {
      this.logger.warn('Cannot add market - capacity or capital limit reached', {
        marketId,
        currentMarkets: this.allocations.size,
        maxMarkets: this.config.maxConcurrentMarkets,
        freeBalance: this.getStats().freeBalance.amount,
        minRequired: this.config.minCapitalPerMarket,
      });
      return null;
    }

    // Allocate ALL free balance to this market
    const stats = this.getStats();
    const allocation = stats.freeBalance;
    this.allocations.set(marketId, allocation);

    this.logger.info('Market added with full free balance allocation', {
      marketId,
      allocation: allocation.amount,
      totalMarkets: this.allocations.size,
    });

    return allocation;
  }

  /**
   * Rebalances allocations across all active markets
   *
   * @returns New allocation result
   *
   * @remarks
   * Redistributes tradingBalance equally across all current markets.
   * Use after significant balance changes or periodically.
   */
  rebalance(): AllocationResult {
    const marketIds = Array.from(this.allocations.keys());
    const previousCount = marketIds.length;

    if (previousCount === 0) {
      this.logger.debug('No markets to rebalance');
      return {
        allocations: new Map(),
        perMarketBalance: Money.zero(),
        marketCount: 0,
        wasLimitedByMinCapital: false,
        requestedMarketCount: 0,
        totalAllocated: Money.zero(),
      };
    }

    // Calculate new per-market balance
    const perMarketBalance = this.tradingBalance.divide(previousCount);

    // Check if we can maintain all markets with minimum capital
    if (perMarketBalance.amount < this.config.minCapitalPerMarket) {
      this.logger.warn('Rebalance: insufficient capital for all markets', {
        currentMarkets: previousCount,
        tradingBalance: this.tradingBalance.amount,
        perMarketBalance: perMarketBalance.amount,
        minRequired: this.config.minCapitalPerMarket,
      });
      // Don't change allocations if rebalance would drop below minimum
      // This is a warning condition - system should reduce markets
      return {
        allocations: this.allocations,
        perMarketBalance: perMarketBalance,
        marketCount: previousCount,
        wasLimitedByMinCapital: true,
        requestedMarketCount: previousCount,
        totalAllocated: this.tradingBalance,
      };
    }

    // Update all allocations to equal amount
    for (const marketId of marketIds) {
      this.allocations.set(marketId, perMarketBalance);
    }

    this.logger.info('Rebalanced allocations', {
      marketCount: previousCount,
      newPerMarketBalance: perMarketBalance.amount,
      totalAllocated: perMarketBalance.amount * previousCount,
    });

    return {
      allocations: new Map(this.allocations),
      perMarketBalance,
      marketCount: previousCount,
      wasLimitedByMinCapital: false,
      requestedMarketCount: previousCount,
      totalAllocated: Money.fromUSDC(perMarketBalance.amount * previousCount),
    };
  }

  /**
   * Gets current allocation statistics with extended metrics
   *
   * @returns Comprehensive statistics about allocations
   */
  getStats(): AllocationStats {
    let allocatedAmount = 0;
    for (const allocation of this.allocations.values()) {
      allocatedAmount += allocation.amount;
    }

    const allocatedBalance = Money.fromUSDC(allocatedAmount);
    const freeBalance = Money.fromUSDC(
      Math.max(0, this.tradingBalance.amount - allocatedAmount)
    );

    const marketCount = this.allocations.size;

    // Calculate per-market balance (average)
    let perMarketBalance: Money | null = null;
    let avgCapitalPerMarket = 0;
    if (marketCount > 0) {
      avgCapitalPerMarket = allocatedAmount / marketCount;
      perMarketBalance = Money.fromUSDC(avgCapitalPerMarket);
    }

    // Calculate utilization
    const utilization = this.tradingBalance.amount > 0
      ? allocatedAmount / this.tradingBalance.amount
      : 0;
    const utilizationPercent = utilization * 100;

    // Remainder (accumulated "change")
    const remainder = freeBalance;

    // Available slots calculation
    let availableSlots = 0;
    if (this.config.maxConcurrentMarkets === 0) {
      // Unlimited - calculate based on free balance
      availableSlots = Math.floor(freeBalance.amount / this.config.minCapitalPerMarket);
    } else {
      const slotsRemaining = this.config.maxConcurrentMarkets - marketCount;
      const affordableMarkets = Math.floor(freeBalance.amount / this.config.minCapitalPerMarket);
      availableSlots = Math.min(slotsRemaining, affordableMarkets);
    }

    return {
      totalBalance: this.totalBalance,
      tradingBalance: this.tradingBalance,
      allocatedBalance,
      freeBalance,
      marketCount,
      perMarketBalance,
      utilization,
      utilizationPercent,
      avgCapitalPerMarket,
      remainder,
      availableSlots,
    };
  }

  /**
   * Gets all current allocations
   *
   * @returns Map of marketId → allocated balance
   */
  getAllocations(): Map<string, Money> {
    return new Map(this.allocations);
  }

  /**
   * Gets trading balance (after ratio applied)
   *
   * @returns Trading balance
   */
  getTradingBalance(): Money {
    return this.tradingBalance;
  }

  /**
   * Gets total balance (before ratio)
   *
   * @returns Total balance
   */
  getTotalBalance(): Money {
    return this.totalBalance;
  }

  /**
   * Gets configuration
   *
   * @returns Allocator configuration
   */
  getConfig(): BalanceAllocatorConfig {
    return { ...this.config };
  }

  /**
   * Logs current state for debugging
   */
  logState(): void {
    const stats = this.getStats();
    this.logger.info('BalanceAllocator State', {
      totalBalance: stats.totalBalance.amount,
      tradingBalance: stats.tradingBalance.amount,
      allocatedBalance: stats.allocatedBalance.amount,
      freeBalance: stats.freeBalance.amount,
      marketCount: stats.marketCount,
      utilization: `${stats.utilizationPercent.toFixed(1)}%`,
      avgCapitalPerMarket: stats.avgCapitalPerMarket.toFixed(2),
      remainder: stats.remainder.amount,
      availableSlots: stats.availableSlots,
      allocations: Object.fromEntries(
        Array.from(this.allocations.entries()).map(([k, v]) => [k.substring(0, 10) + '...', v.amount])
      ),
    });
  }
}
