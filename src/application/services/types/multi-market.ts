/**
 * Multi-Market Trading Types
 *
 * @remarks
 * Типы для координации торговли на нескольких маркетах одновременно.
 * Обеспечивают изолированное состояние для каждого маркета.
 *
 * Ключевые концепции:
 * - MarketContext: изолированное состояние одного маркета
 * - MultiMarketConfig: конфигурация для multi-market trading
 * - MultiMarketStatus: агрегированный статус всех маркетов
 */

import { Market } from '../../../domain/entities/Market.js';
import { Money } from '../../../domain/value-objects/Money.js';
import { MainTradingOrchestrator } from '../../orchestrators/MainTradingOrchestrator.js';
import { TradingMode } from '../../../domain/services/risk/RiskAssessmentService.js';

/**
 * Status of an individual market in multi-market trading
 *
 * @remarks
 * - PENDING: Market added but not yet started
 * - ACTIVE: Market is actively trading
 * - PAUSED: Market temporarily paused (e.g., during rebalance)
 * - EXPIRED: Market has expired, waiting for cleanup
 * - ERROR: Market encountered an error
 */
export type MarketStatus = 'PENDING' | 'ACTIVE' | 'PAUSED' | 'EXPIRED' | 'ERROR';

/**
 * Isolated context for a single market
 *
 * @remarks
 * Contains all state required for trading on a single market.
 * Each market has its own:
 * - Orchestrator (handles trading logic)
 * - Session (tracks positions, PnL)
 * - Allocated balance
 * - Status and timestamps
 *
 * @example
 * ```typescript
 * const context: MarketContext = {
 *   marketId: 'btc-up-down-dec29',
 *   market: btcMarket,
 *   orchestrator: new MainTradingOrchestrator({...}),
 *   allocatedBalance: Money.fromUSDC(100),
 *   status: 'ACTIVE',
 *   startedAt: new Date(),
 *   lastUpdate: new Date(),
 *   errorMessage: undefined
 * };
 * ```
 */
export interface MarketContext {
  /**
   * Unique identifier (condition ID from Polymarket)
   */
  marketId: string;

  /**
   * Market entity with all metadata
   */
  market: Market;

  /**
   * Trading orchestrator for this market
   */
  orchestrator: MainTradingOrchestrator;

  /**
   * Capital allocated to this market
   */
  allocatedBalance: Money;

  /**
   * Current status of this market
   */
  status: MarketStatus;

  /**
   * When trading started on this market
   */
  startedAt: Date;

  /**
   * Last update timestamp
   */
  lastUpdate: Date;

  /**
   * Error message if status is ERROR
   */
  errorMessage?: string;
}

/**
 * Configuration for multi-market trading
 *
 * @remarks
 * Controls how multiple markets are selected and capitalized.
 *
 * @example
 * ```typescript
 * const config: MultiMarketConfig = {
 *   maxConcurrentMarkets: 5,
 *   tradingBalanceRatio: 0.8,
 *   minCapitalPerMarket: 10,
 *   scanPauseMs: 30000,
 *   expiryCheckIntervalMs: 1000
 * };
 * ```
 */
export interface MultiMarketConfig {
  /**
   * Maximum number of markets to trade simultaneously
   * 0 = unlimited (all markets passing filters)
   */
  maxConcurrentMarkets: number;

  /**
   * Fraction of total balance for trading (0.0, 1.0]
   */
  tradingBalanceRatio: number;

  /**
   * Minimum capital required per market (USDC)
   */
  minCapitalPerMarket: number;

  /**
   * Pause between market discovery scans (ms)
   */
  scanPauseMs: number;

  /**
   * Interval for checking market expiry (ms)
   */
  expiryCheckIntervalMs: number;
}

/**
 * Status of an individual market (for reporting)
 *
 * @remarks
 * Lightweight status object for UI/logging.
 */
export interface MarketStatusInfo {
  /**
   * Market ID
   */
  marketId: string;

  /**
   * Human-readable market question
   */
  question: string;

  /**
   * Current status
   */
  status: MarketStatus;

  /**
   * Trading mode of the orchestrator
   */
  tradingMode: TradingMode;

  /**
   * Allocated balance
   */
  allocatedBalance: number;

  /**
   * Time until expiry (ms)
   */
  timeToExpiry: number;

  /**
   * Number of active orders
   */
  activeOrders: number;

  /**
   * Duration of trading (ms)
   */
  tradingDuration: number;

  /**
   * Error message if any
   */
  error?: string;
}

/**
 * Aggregated status of multi-market trading
 *
 * @remarks
 * Overview of all active markets and system health.
 * Includes balance utilization metrics for monitoring.
 *
 * @example
 * ```typescript
 * const status = trader.getStatus();
 * console.log(`Trading on ${status.activeMarketCount} markets`);
 * console.log(`Utilization: ${status.utilizationPercent}%`);
 * console.log(`Available slots: ${status.availableSlots}`);
 * ```
 */
export interface MultiMarketStatus {
  /**
   * Whether the multi-market trader is running
   */
  isRunning: boolean;

  /**
   * Total balance (before ratio)
   */
  totalBalance: number;

  /**
   * Trading balance (after ratio)
   */
  tradingBalance: number;

  /**
   * Currently allocated balance
   */
  allocatedBalance: number;

  /**
   * Free balance (not allocated)
   */
  freeBalance: number;

  /**
   * Number of active markets
   */
  activeMarketCount: number;

  /**
   * Maximum concurrent markets limit
   */
  maxConcurrentMarkets: number;

  /**
   * Whether capacity limit is reached
   */
  atCapacity: boolean;

  /**
   * Utilization ratio: allocatedBalance / tradingBalance (0-1)
   */
  utilization: number;

  /**
   * Utilization as percentage (0-100)
   */
  utilizationPercent: number;

  /**
   * Average capital per market (USDC)
   */
  avgCapitalPerMarket: number;

  /**
   * Available slots for new markets (considering both limits and capital)
   */
  availableSlots: number;

  /**
   * Status of each active market
   */
  markets: MarketStatusInfo[];

  /**
   * Last scan timestamp
   */
  lastScanAt: Date | null;

  /**
   * Next scan scheduled at
   */
  nextScanAt: Date | null;

  /**
   * Errors encountered (last N)
   */
  recentErrors: string[];
}

/**
 * Event emitted when a market is added
 */
export interface MarketAddedEvent {
  type: 'MARKET_ADDED';
  marketId: string;
  question: string;
  allocatedBalance: number;
  timestamp: Date;
}

/**
 * Event emitted when a market is removed
 */
export interface MarketRemovedEvent {
  type: 'MARKET_REMOVED';
  marketId: string;
  question: string;
  reason: 'EXPIRED' | 'ERROR' | 'MANUAL' | 'REBALANCE';
  releasedBalance: number;
  timestamp: Date;
}

/**
 * Event emitted when markets are rebalanced
 */
export interface MarketsRebalancedEvent {
  type: 'MARKETS_REBALANCED';
  previousCount: number;
  newCount: number;
  previousPerMarketBalance: number;
  newPerMarketBalance: number;
  timestamp: Date;
}

/**
 * Union type for all multi-market events
 */
export type MultiMarketEvent =
  | MarketAddedEvent
  | MarketRemovedEvent
  | MarketsRebalancedEvent;

/**
 * Callback for multi-market events
 */
export type MultiMarketEventHandler = (event: MultiMarketEvent) => void;

/**
 * Factory function type for creating orchestrators
 *
 * @remarks
 * Used by MultiMarketTrader to create isolated orchestrators for each market.
 */
export type OrchestratorFactory = () => MainTradingOrchestrator;

/**
 * Result of adding a market
 */
export interface AddMarketResult {
  /**
   * Whether the market was added successfully
   */
  success: boolean;

  /**
   * Market ID if added
   */
  marketId?: string;

  /**
   * Allocated balance if added
   */
  allocatedBalance?: Money;

  /**
   * Error message if failed
   */
  error?: string;
}

/**
 * Result of removing a market
 */
export interface RemoveMarketResult {
  /**
   * Whether the market was removed successfully
   */
  success: boolean;

  /**
   * Released balance if removed
   */
  releasedBalance?: Money;

  /**
   * Error message if failed
   */
  error?: string;
}
