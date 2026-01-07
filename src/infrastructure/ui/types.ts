/**
 * UI type definitions for trading bot interface
 *
 * @remarks
 * Defines the contract for all UI implementations (blessed, headless, etc.)
 * Separates presentation logic from business logic.
 *
 * @module infrastructure/ui/types
 */

/**
 * Log message severity level
 */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/**
 * Log message category for filtering and routing
 */
export type LogCategory =
  | 'system'
  | 'oms'
  | 'trade'
  | 'flow'
  | 'quote'
  | 'arb'
  | 'unwind'
  | 'error'
  | 'risk'
  | 'mode'
  | 'edge'
  | 'panic'
  | 'debug'
  | 'mainloop';

/**
 * Single log entry with timestamp, message, category, and level
 */
export interface LogEntry {
  /** ISO timestamp or formatted time string */
  timestamp: string;
  /** Log message text */
  message: string;
  /** Category for filtering/routing */
  category: LogCategory;
  /** Severity level */
  level: LogLevel;
}

/**
 * Order information for display
 */
export interface OrderDisplayData {
  /** Order ID */
  id: string;
  /** Token ID (YES/NO) */
  tokenId: string;
  /** Side (BUY/SELL) */
  side: 'BUY' | 'SELL';
  /** Price */
  price: number;
  /** Original size */
  size: number;
  /** Filled size */
  filledSize: number;
  /** Status (LIVE, FILLED, CANCELED, etc.) */
  status: string;
  /** Creation timestamp */
  createdAt: string;
}

/**
 * Fill/trade execution information for display
 */
export interface FillDisplayData {
  /** Trade ID */
  id: string;
  /** Order ID that was filled */
  orderId: string;
  /** Token ID (YES/NO) */
  tokenId: string;
  /** Side (BUY/SELL) */
  side: 'BUY' | 'SELL';
  /** Execution price */
  price: number;
  /** Filled size */
  size: number;
  /** Execution timestamp */
  timestamp: string;
}

/**
 * Current status/state data for display
 */
export interface StatusDisplayData {
  /** Current market question */
  marketQuestion: string;
  /** Market end date */
  marketEndDate: string;
  /** Time until expiry (formatted string) */
  timeToExpiry: string;
  /** Current mode (QUOTE, SKEW, UNWIND, PANIC, etc.) */
  mode: string;
  /** Edge alive status */
  edgeAlive: boolean;
  /** Edge stage (ALIVE, WARNING, DEAD, etc.) */
  edgeStage: string;
  /** Current YES position */
  yesPosition: number;
  /** Current NO position */
  noPosition: number;
  /** Net position (YES - NO) */
  netPosition: number;
  /** Unrealized PnL */
  unrealizedPnL: number;
  /** Realized PnL */
  realizedPnL: number;
  /** Total PnL */
  totalPnL: number;
  /** Current cash balance */
  cash: number;
  /** Reserved cash (in open orders) */
  reservedCash: number;
  /** YES mid price */
  yesMid: number;
  /** NO mid price */
  noMid: number;
  /** YES spread */
  yesSpread: number;
  /** NO spread */
  noSpread: number;
  /** YES best bid */
  yesBestBid: number | null;
  /** YES best ask */
  yesBestAsk: number | null;
  /** NO best bid */
  noBestBid: number | null;
  /** NO best ask */
  noNoBestAsk: number | null;
}

/**
 * UI configuration options
 */
export interface UIConfig {
  /** Use ASCII symbols instead of emoji */
  asciiOnly: boolean;
  /** Update interval in milliseconds */
  updateInterval?: number;
  /** Maximum log entries to keep in memory */
  maxLogEntries?: number;
}

/**
 * Abstract interface for trading UI implementations
 *
 * @remarks
 * All UI implementations (blessed, headless, web, etc.) must implement this interface.
 * This ensures consistent behavior across different display modes.
 *
 * @example
 * ```typescript
 * const ui = new BlessedTradingUI({ asciiOnly: true });
 * await ui.initialize();
 * ui.log('Bot started', 'system', 'INFO');
 * ui.updateStatus({
 *   marketQuestion: 'Will BTC hit 100k?',
 *   mode: 'QUOTE',
 *   netPosition: 0,
 *   totalPnL: 0,
 *   // ... other fields
 * });
 * ui.render();
 * ```
 */
export interface ITradingUI {
  /**
   * Initialize the UI (setup screen, components, etc.)
   *
   * @throws {Error} If UI initialization fails
   *
   * @example
   * ```typescript
   * await ui.initialize();
   * ```
   */
  initialize(): Promise<void>;

  /**
   * Log a message to the UI
   *
   * @param message - Message text
   * @param category - Log category for filtering
   * @param level - Severity level
   *
   * @remarks
   * Messages are queued and displayed according to the UI implementation.
   * Duplicate consecutive messages may be filtered.
   *
   * @example
   * ```typescript
   * ui.log('Order placed: BUY YES @ 0.65', 'oms', 'INFO');
   * ui.log('Low liquidity detected', 'risk', 'WARN');
   * ```
   */
  log(message: string, category: LogCategory, level: LogLevel): void;

  /**
   * Update status/state display
   *
   * @param data - Current status data
   *
   * @remarks
   * Updates the status panel with current market state, positions, PnL, etc.
   * Called periodically by the main loop.
   *
   * @example
   * ```typescript
   * ui.updateStatus({
   *   marketQuestion: 'Will BTC hit 100k?',
   *   mode: 'QUOTE',
   *   edgeAlive: true,
   *   netPosition: 5.2,
   *   totalPnL: 12.50,
   *   yesMid: 0.65,
   *   noMid: 0.36,
   *   // ... other fields
   * });
   * ```
   */
  updateStatus(data: StatusDisplayData): void;

  /**
   * Update orders display
   *
   * @param orders - Current open orders
   *
   * @remarks
   * Replaces the orders panel with the provided order list.
   * Called after order state changes (place, cancel, fill).
   *
   * @example
   * ```typescript
   * ui.updateOrders([
   *   { id: 'abc123', tokenId: 'YES', side: 'BUY', price: 0.65, size: 10, filledSize: 0, status: 'LIVE', createdAt: '12:34:56' }
   * ]);
   * ```
   */
  updateOrders(orders: OrderDisplayData[]): void;

  /**
   * Update fills/trades display
   *
   * @param fills - Recent fills/executions
   *
   * @remarks
   * Appends new fills to the fills panel.
   * Old fills may be pruned to maintain max entries.
   *
   * @example
   * ```typescript
   * ui.updateFills([
   *   { id: 'fill123', orderId: 'abc123', tokenId: 'YES', side: 'BUY', price: 0.65, size: 10, timestamp: '12:34:56' }
   * ]);
   * ```
   */
  updateFills(fills: FillDisplayData[]): void;

  /**
   * Render/refresh the UI display
   *
   * @remarks
   * Forces a UI refresh. Called after state updates to ensure display is current.
   * May be throttled internally to avoid excessive redraws.
   *
   * @example
   * ```typescript
   * ui.updateStatus(statusData);
   * ui.render(); // Force immediate redraw
   * ```
   */
  render(): void;

  /**
   * Shutdown/cleanup the UI
   *
   * @remarks
   * Closes the UI, releases resources, restores terminal state.
   * Should be called before process exit.
   *
   * @example
   * ```typescript
   * process.on('SIGINT', async () => {
   *   await ui.destroy();
   *   process.exit(0);
   * });
   * ```
   */
  destroy(): Promise<void>;
}
