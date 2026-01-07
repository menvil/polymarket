/**
 * Order panel component for displaying open orders and fills
 *
 * @remarks
 * Renders active orders and recent fills/trades with formatting.
 * Shows order status, fill progress, and execution details.
 *
 * @module infrastructure/ui/components/OrderPanel
 */

import type { OrderDisplayData, FillDisplayData, UIConfig } from '../types';

/**
 * Builds formatted order lines for display
 *
 * @param orders - Array of orders to display
 * @param config - UI configuration
 * @returns Array of formatted lines
 *
 * @remarks
 * Displays orders in table format with columns:
 * - Token (YES/NO)
 * - Side (BUY/SELL)
 * - Price
 * - Size (filled/total)
 * - Status
 *
 * @example
 * ```typescript
 * const orders = [
 *   { id: 'abc123', tokenId: 'YES', side: 'BUY', price: 0.65, size: 10, filledSize: 0, status: 'LIVE', createdAt: '12:34:56' }
 * ];
 * const lines = buildOrderLines(orders, { asciiOnly: true });
 * ```
 */
export function buildOrderLines(
  orders: OrderDisplayData[],
  config: UIConfig
): string[] {
  const lines: string[] = [];

  if (orders.length === 0) {
    lines.push('{gray-fg}No open orders{/gray-fg}');
    return lines;
  }

  // Header
  lines.push('{bold}Token Side  Price    Size      Status{/bold}');
  lines.push('─'.repeat(50));

  // Orders
  for (const order of orders) {
    lines.push(formatOrderLine(order, config));
  }

  return lines;
}

/**
 * Format a single order line
 *
 * @param order - Order data
 * @param config - UI configuration
 * @returns Formatted line
 */
function formatOrderLine(order: OrderDisplayData, _config: UIConfig): string {
  const token = order.tokenId === 'YES' ? 'YES' : 'NO ';
  const sideColor = order.side === 'BUY' ? 'green-fg' : 'red-fg';
  const side = order.side === 'BUY' ? 'BUY ' : 'SELL';
  const price = order.price.toFixed(4);
  const size = `${order.filledSize.toFixed(1)}/${order.size.toFixed(1)}`;
  const statusColor = getStatusColor(order.status);
  const status = order.status;

  return `{${sideColor}}${token} ${side}{/${sideColor}} ${price} ${padRight(size, 9)} {${statusColor}}${status}{/${statusColor}}`;
}

/**
 * Builds formatted fill lines for display
 *
 * @param fills - Array of fills to display
 * @param config - UI configuration
 * @param maxEntries - Maximum fills to show (newest)
 * @returns Array of formatted lines
 *
 * @remarks
 * Displays fills in table format with columns:
 * - Time
 * - Token (YES/NO)
 * - Side (BUY/SELL)
 * - Price
 * - Size
 *
 * @example
 * ```typescript
 * const fills = [
 *   { id: 'fill123', orderId: 'abc123', tokenId: 'YES', side: 'BUY', price: 0.65, size: 10, timestamp: '12:34:56' }
 * ];
 * const lines = buildFillLines(fills, { asciiOnly: true }, 20);
 * ```
 */
export function buildFillLines(
  fills: FillDisplayData[],
  config: UIConfig,
  maxEntries = 20
): string[] {
  const lines: string[] = [];

  // Take last N fills
  const recentFills = fills.slice(-maxEntries);

  if (recentFills.length === 0) {
    lines.push('{gray-fg}No fills yet{/gray-fg}');
    return lines;
  }

  // Header
  lines.push('{bold}Time      Token Side  Price    Size{/bold}');
  lines.push('─'.repeat(50));

  // Fills (reverse order - newest first)
  for (let i = recentFills.length - 1; i >= 0; i--) {
    lines.push(formatFillLine(recentFills[i], config));
  }

  return lines;
}

/**
 * Format a single fill line
 *
 * @param fill - Fill data
 * @param config - UI configuration
 * @returns Formatted line
 */
function formatFillLine(fill: FillDisplayData, _config: UIConfig): string {
  const time = fill.timestamp;
  const token = fill.tokenId === 'YES' ? 'YES' : 'NO ';
  const sideColor = fill.side === 'BUY' ? 'green-fg' : 'red-fg';
  const side = fill.side === 'BUY' ? 'BUY ' : 'SELL';
  const price = fill.price.toFixed(4);
  const size = fill.size.toFixed(1);

  return `${time} {${sideColor}}${token} ${side}{/${sideColor}} ${price} ${size}`;
}

/**
 * Get status color
 *
 * @param status - Order status
 * @returns Blessed color tag
 */
function getStatusColor(status: string): string {
  switch (status) {
    case 'LIVE':
      return 'green-fg';
    case 'FILLED':
      return 'cyan-fg';
    case 'CANCELED':
      return 'gray-fg';
    case 'REJECTED':
      return 'red-fg';
    case 'PENDING':
      return 'yellow-fg';
    default:
      return 'white-fg';
  }
}

/**
 * Pad string to right with spaces
 *
 * @param str - Input string
 * @param len - Target length
 * @returns Padded string
 */
function padRight(str: string, len: number): string {
  if (str.length >= len) return str;
  return str + ' '.repeat(len - str.length);
}

/**
 * Build combined orders and fills display
 *
 * @param orders - Orders to display
 * @param fills - Fills to display
 * @param config - UI configuration
 * @returns Array of formatted lines
 *
 * @remarks
 * Combines orders and fills into a single panel with sections.
 *
 * @example
 * ```typescript
 * const lines = buildOrdersAndFillsLines(orders, fills, { asciiOnly: true });
 * console.log(lines.join('\n'));
 * ```
 */
export function buildOrdersAndFillsLines(
  orders: OrderDisplayData[],
  fills: FillDisplayData[],
  config: UIConfig
): string[] {
  const lines: string[] = [];

  // Orders section
  lines.push('{cyan-fg}{bold}OPEN ORDERS{/bold}{/cyan-fg}');
  lines.push('');
  lines.push(...buildOrderLines(orders, config));
  lines.push('');

  // Fills section
  lines.push('{magenta-fg}{bold}RECENT FILLS{/bold}{/magenta-fg}');
  lines.push('');
  lines.push(...buildFillLines(fills, config, 10));

  return lines;
}
