/**
 * Headless UI implementation for trading bot (console logs only)
 *
 * @remarks
 * Minimal UI implementation that outputs logs to console.
 * Suitable for:
 * - Server/headless environments
 * - CI/CD pipelines
 * - Logging to files with redirects
 * - Debugging without terminal UI
 *
 * @module infrastructure/ui/HeadlessUI
 */

import type {
  ITradingUI,
  LogCategory,
  LogLevel,
  OrderDisplayData,
  FillDisplayData,
  StatusDisplayData,
  UIConfig,
} from './types.js';

/**
 * Headless UI implementation (console logs only)
 *
 * @remarks
 * Implements ITradingUI with simple console.log output.
 * No terminal UI, no blessed, no colors.
 * All messages are timestamped and categorized.
 *
 * @example
 * ```typescript
 * const ui = new HeadlessUI({ asciiOnly: true });
 * await ui.initialize();
 *
 * ui.log('Bot started', 'system', 'INFO');
 * ui.updateStatus({
 *   marketQuestion: 'Will BTC hit 100k?',
 *   mode: 'QUOTE',
 *   netPosition: 0,
 *   totalPnL: 0,
 *   // ... other fields
 * });
 *
 * // Output:
 * // [2024-12-27T12:34:56.789Z] [INFO] [system] Bot started
 * // [2024-12-27T12:34:57.000Z] [INFO] [status] Mode: QUOTE | Net: 0.0 | PnL: $0.00
 * ```
 */
export class HeadlessUI implements ITradingUI {
  private lastStatusUpdate = 0;
  private readonly STATUS_UPDATE_INTERVAL_MS: number;

  /**
   * Create a new HeadlessUI instance
   *
   * @param config - UI configuration
   *
   * @example
   * ```typescript
   * const ui = new HeadlessUI({
   *   asciiOnly: true,
   *   updateInterval: 5000 // Log status every 5 seconds
   * });
   * ```
   */
  constructor(config: UIConfig) {
    this.STATUS_UPDATE_INTERVAL_MS = config.updateInterval || 5000;
  }

  /**
   * Initialize the headless UI
   *
   * @remarks
   * No-op for headless mode. Always succeeds.
   *
   * @example
   * ```typescript
   * await ui.initialize();
   * ```
   */
  async initialize(): Promise<void> {
    this.log('HeadlessUI initialized', 'system', 'INFO');
  }

  /**
   * Log a message to console
   *
   * @param message - Message text
   * @param category - Log category
   * @param level - Severity level
   *
   * @remarks
   * Outputs to console.log with format:
   * `[timestamp] [LEVEL] [category] message`
   *
   * @example
   * ```typescript
   * ui.log('Order placed: BUY YES @ 0.65', 'oms', 'INFO');
   * // Output: [2024-12-27T12:34:56.789Z] [INFO] [oms] Order placed: BUY YES @ 0.65
   * ```
   */
  log(message: string, category: LogCategory, level: LogLevel): void {
    const timestamp = new Date().toISOString();
    const stripped = this.stripColors(message);
    console.log(`[${timestamp}] [${level}] [${category}] ${stripped}`);
  }

  /**
   * Update status display
   *
   * @param data - Current status data
   *
   * @remarks
   * Logs status summary to console (throttled by updateInterval).
   * Format: `Mode: X | Net: Y | PnL: $Z`
   *
   * @example
   * ```typescript
   * ui.updateStatus({
   *   mode: 'QUOTE',
   *   netPosition: 5.2,
   *   totalPnL: 12.50,
   *   // ... other fields
   * });
   * // Output: [2024-12-27T12:34:56.789Z] [INFO] [status] Mode: QUOTE | Net: +5.2 | PnL: +$12.50
   * ```
   */
  updateStatus(data: StatusDisplayData): void {
    const now = Date.now();
    if (now - this.lastStatusUpdate < this.STATUS_UPDATE_INTERVAL_MS) {
      return; // Throttle status updates
    }
    this.lastStatusUpdate = now;

    const netSign = data.netPosition > 0 ? '+' : '';
    const pnlSign = data.totalPnL > 0 ? '+' : '';

    const summary =
      `Mode: ${data.mode} | ` +
      `Net: ${netSign}${data.netPosition.toFixed(1)} | ` +
      `PnL: ${pnlSign}$${data.totalPnL.toFixed(2)} | ` +
      `Edge: ${data.edgeStage}`;

    this.log(summary, 'system', 'INFO');
  }

  /**
   * Update orders display
   *
   * @param orders - Current open orders
   *
   * @remarks
   * Logs order count to console.
   *
   * @example
   * ```typescript
   * ui.updateOrders(orders);
   * // Output: [2024-12-27T12:34:56.789Z] [INFO] [oms] Open orders: 2
   * ```
   */
  updateOrders(orders: OrderDisplayData[]): void {
    this.log(`Open orders: ${orders.length}`, 'system', 'INFO');
  }

  /**
   * Update fills display
   *
   * @param fills - Recent fills/executions
   *
   * @remarks
   * Logs each fill to console.
   *
   * @example
   * ```typescript
   * ui.updateFills([
   *   { id: 'fill1', orderId: 'abc', tokenId: 'YES', side: 'BUY', price: 0.65, size: 10, timestamp: '12:34:56' }
   * ]);
   * // Output: [2024-12-27T12:34:56.789Z] [INFO] [trade] FILL: BUY YES @ 0.6500 x 10.0
   * ```
   */
  updateFills(fills: FillDisplayData[]): void {
    for (const fill of fills) {
      const msg = `FILL: ${fill.side} ${fill.tokenId} @ ${fill.price.toFixed(4)} x ${fill.size.toFixed(1)}`;
      this.log(msg, 'trade', 'INFO');
    }
  }

  /**
   * Render/refresh the UI
   *
   * @remarks
   * No-op for headless mode.
   *
   * @example
   * ```typescript
   * ui.render(); // Does nothing
   * ```
   */
  render(): void {
    // No-op for headless
  }

  /**
   * Destroy/cleanup the UI
   *
   * @remarks
   * No-op for headless mode.
   *
   * @example
   * ```typescript
   * await ui.destroy();
   * ```
   */
  async destroy(): Promise<void> {
    this.log('HeadlessUI destroyed', 'system', 'INFO');
  }

  /**
   * Strip blessed color tags from message
   *
   * @param message - Message with color tags
   * @returns Plain text message
   *
   * @remarks
   * Removes blessed-style tags like `{red-fg}text{/red-fg}`.
   */
  private stripColors(message: string): string {
    return message.replace(/\{[^}]+\}/g, '');
  }
}
