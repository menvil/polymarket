/**
 * Blessed-based terminal UI implementation for trading bot
 *
 * @remarks
 * Full-featured terminal UI using neo-blessed library.
 * Features:
 * - Two-column layout (status left, logs right)
 * - Auto-scrolling logs
 * - Color-coded messages
 * - ASCII/emoji mode support
 * - Suppressed xterm-256color warnings
 *
 * @module infrastructure/ui/BlessedTradingUI
 */

import blessed from 'neo-blessed';
import type {
  ITradingUI,
  LogEntry,
  LogCategory,
  LogLevel,
  OrderDisplayData,
  FillDisplayData,
  StatusDisplayData,
  UIConfig,
} from './types.js';
import { buildStatusLines } from './components/StatusPanel.js';
import { buildLogLines, deduplicateLogs } from './components/LogPanel.js';
import { buildOrdersAndFillsLines } from './components/OrderPanel.js';

/**
 * Blessed terminal UI implementation
 *
 * @remarks
 * Implements ITradingUI using neo-blessed for rich terminal display.
 * Manages four panels:
 * - Status panel (top left): Market info, positions, PnL
 * - Logs panel (top right): Activity logs
 * - Orders panel (bottom left): Open orders and fills
 * - Main loop panel (bottom right): Main loop status
 *
 * @throws {Error} If blessed initialization fails
 *
 * @example
 * ```typescript
 * const ui = new BlessedTradingUI({ asciiOnly: true, maxLogEntries: 200 });
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
 * ui.render();
 *
 * // Cleanup on exit
 * await ui.destroy();
 * ```
 */
export class BlessedTradingUI implements ITradingUI {
  private config: UIConfig;
  private screen: blessed.Widgets.Screen | null = null;
  private statusBox: blessed.Widgets.BoxElement | null = null;
  private logsBox: blessed.Widgets.BoxElement | null = null;
  private ordersBox: blessed.Widgets.BoxElement | null = null;
  private mainLoopBox: blessed.Widgets.BoxElement | null = null;

  // State buffers
  private logs: LogEntry[] = [];
  private mainLoopLogs: LogEntry[] = [];
  private orders: OrderDisplayData[] = [];
  private fills: FillDisplayData[] = [];
  private status: StatusDisplayData | null = null;

  // Configuration
  private readonly MAX_LOGS: number;
  private readonly MAX_MAIN_LOOP_LOGS = 50;
  private readonly MAX_FILLS = 20;

  /**
   * Create a new BlessedTradingUI instance
   *
   * @param config - UI configuration
   *
   * @example
   * ```typescript
   * const ui = new BlessedTradingUI({
   *   asciiOnly: true,
   *   maxLogEntries: 200
   * });
   * ```
   */
  constructor(config: UIConfig) {
    this.config = config;
    this.MAX_LOGS = config.maxLogEntries || 200;

    // Suppress blessed terminal warnings (xterm-256color)
    this.suppressBlessedWarnings();
  }

  /**
   * Suppress blessed xterm-256color warnings
   *
   * @remarks
   * Filters out cosmetic terminal capability errors from stderr.
   * These warnings are harmless but clutter output.
   */
  private suppressBlessedWarnings(): void {
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: any, encoding?: any, callback?: any) => {
      const str = chunk.toString();
      // Filter out blessed terminal warnings
      if (
        str.includes('Error on xterm-256color') ||
        str.includes('Setulc') ||
        str.includes('\\u001b[58::')
      ) {
        return true;
      }
      return originalStderrWrite(chunk, encoding, callback);
    };
  }

  /**
   * Initialize the blessed UI
   *
   * @throws {Error} If screen creation fails
   *
   * @remarks
   * Creates blessed screen and sets up four panels:
   * - Status (left, 60% height)
   * - Logs (right, 60% height)
   * - Orders (left bottom, 40% height)
   * - Main loop (right bottom, 40% height)
   *
   * @example
   * ```typescript
   * await ui.initialize();
   * ```
   */
  async initialize(): Promise<void> {
    // Create screen
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Polymarket MM Bot V3',
      fullUnicode: true,
      dockBorders: true,
      ignoreLocked: ['C-c'],
      warnings: false,
      terminal: process.env.TERM || 'xterm-256color',
      forceUnicode: false,
    });

    // Status box (left panel, 60% height)
    this.statusBox = blessed.box({
      top: 0,
      left: 0,
      width: 72, // Fixed width for stable layout
      height: '60%',
      label: ' STATUS ',
      border: { type: 'line' },
      style: { border: { fg: 'cyan' } },
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: '█', style: { fg: 'cyan' } },
    });

    // Logs box (right top panel, 60% height)
    this.logsBox = blessed.box({
      top: 0,
      left: 72,
      width: 'shrink',
      height: '60%',
      label: ' ACTIVITY ',
      border: { type: 'line' },
      style: { border: { fg: 'green' } },
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: '█', style: { fg: 'green' } },
    });

    // Orders box (left bottom, 40% height)
    this.ordersBox = blessed.box({
      top: '60%',
      left: 0,
      width: 72,
      height: '40%',
      label: ' ORDERS & FILLS ',
      border: { type: 'line' },
      style: { border: { fg: 'magenta' } },
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: '█', style: { fg: 'magenta' } },
    });

    // Main loop box (right bottom, 40% height)
    this.mainLoopBox = blessed.box({
      top: '60%',
      left: 72,
      width: 'shrink',
      height: '40%',
      label: ' MAIN LOOP ',
      border: { type: 'line' },
      style: { border: { fg: 'yellow' } },
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: '█', style: { fg: 'yellow' } },
    });

    // Append to screen
    this.screen.append(this.statusBox);
    this.screen.append(this.logsBox);
    this.screen.append(this.ordersBox);
    this.screen.append(this.mainLoopBox);

    // Keyboard handlers
    this.screen.key(['escape', 'q', 'C-c'], () => {
      process.emit('SIGINT' as any);
    });

    // Initial render
    this.screen.render();
  }

  /**
   * Log a message
   *
   * @param message - Message text
   * @param category - Log category
   * @param level - Severity level
   *
   * @remarks
   * Adds message to appropriate log buffer (mainloop or general).
   * Deduplicates consecutive identical messages.
   * Triggers render if screen is initialized.
   *
   * @example
   * ```typescript
   * ui.log('Order placed: BUY YES @ 0.65', 'oms', 'INFO');
   * ui.log('Low liquidity detected', 'risk', 'WARN');
   * ```
   */
  log(message: string, category: LogCategory, level: LogLevel): void {
    const timestamp = new Date().toISOString().split('T')[1].substring(0, 12);
    const entry: LogEntry = { timestamp, message, category, level };

    if (category === 'mainloop') {
      // Main loop logs
      this.mainLoopLogs.push(entry);
      if (this.mainLoopLogs.length > this.MAX_MAIN_LOOP_LOGS) {
        this.mainLoopLogs.shift();
      }
      // Deduplicate
      this.mainLoopLogs = deduplicateLogs(this.mainLoopLogs);
    } else {
      // General logs
      this.logs.push(entry);
      if (this.logs.length > this.MAX_LOGS) {
        this.logs.shift();
      }
      // Deduplicate
      this.logs = deduplicateLogs(this.logs);
    }

    // Render if screen ready
    if (this.screen) {
      this.render();
    }
  }

  /**
   * Update status display
   *
   * @param data - Current status data
   *
   * @remarks
   * Stores status data and triggers render.
   *
   * @example
   * ```typescript
   * ui.updateStatus({
   *   marketQuestion: 'Will BTC hit 100k?',
   *   mode: 'QUOTE',
   *   edgeAlive: true,
   *   netPosition: 5.2,
   *   totalPnL: 12.50,
   *   // ... other fields
   * });
   * ```
   */
  updateStatus(data: StatusDisplayData): void {
    this.status = data;
    if (this.screen) {
      this.render();
    }
  }

  /**
   * Update orders display
   *
   * @param orders - Current open orders
   *
   * @remarks
   * Replaces orders buffer and triggers render.
   *
   * @example
   * ```typescript
   * ui.updateOrders([
   *   { id: 'abc', tokenId: 'YES', side: 'BUY', price: 0.65, size: 10, filledSize: 0, status: 'LIVE', createdAt: '12:34:56' }
   * ]);
   * ```
   */
  updateOrders(orders: OrderDisplayData[]): void {
    this.orders = orders;
    if (this.screen) {
      this.render();
    }
  }

  /**
   * Update fills display
   *
   * @param fills - Recent fills/executions
   *
   * @remarks
   * Appends fills to buffer (up to MAX_FILLS) and triggers render.
   *
   * @example
   * ```typescript
   * ui.updateFills([
   *   { id: 'fill1', orderId: 'abc', tokenId: 'YES', side: 'BUY', price: 0.65, size: 10, timestamp: '12:34:56' }
   * ]);
   * ```
   */
  updateFills(fills: FillDisplayData[]): void {
    this.fills.push(...fills);
    if (this.fills.length > this.MAX_FILLS) {
      this.fills = this.fills.slice(-this.MAX_FILLS);
    }
    if (this.screen) {
      this.render();
    }
  }

  /**
   * Render/refresh the UI
   *
   * @remarks
   * Updates all panels with current state and renders screen.
   * Called automatically by update methods, but can be called manually.
   *
   * @example
   * ```typescript
   * ui.updateStatus(statusData);
   * ui.render(); // Force immediate redraw
   * ```
   */
  render(): void {
    if (!this.screen) return;

    // Build status panel
    if (this.status && this.statusBox) {
      const statusLines = buildStatusLines(this.status, this.config);
      this.statusBox.setContent(statusLines.join('\n'));
      this.statusBox.setScrollPerc(100);
    }

    // Build logs panel
    if (this.logsBox) {
      const logLines = buildLogLines(this.logs, this.config, this.MAX_LOGS);
      this.logsBox.setContent(logLines.join('\n'));
      this.logsBox.setScrollPerc(100);
    }

    // Build orders panel
    if (this.ordersBox) {
      const orderLines = buildOrdersAndFillsLines(this.orders, this.fills, this.config);
      this.ordersBox.setContent(orderLines.join('\n'));
      this.ordersBox.setScrollPerc(100);
    }

    // Build main loop panel
    if (this.mainLoopBox) {
      const mainLoopLines = buildLogLines(this.mainLoopLogs, this.config, this.MAX_MAIN_LOOP_LOGS);
      this.mainLoopBox.setContent(mainLoopLines.join('\n'));
      this.mainLoopBox.setScrollPerc(100);
    }

    // Render screen
    this.screen.render();
  }

  /**
   * Destroy/cleanup the UI
   *
   * @remarks
   * Closes screen, releases resources, restores terminal.
   *
   * @example
   * ```typescript
   * await ui.destroy();
   * ```
   */
  async destroy(): Promise<void> {
    if (this.screen) {
      this.screen.destroy();
      this.screen = null;
    }
  }
}
