/**
 * Position panel component for displaying positions and PnL
 *
 * @remarks
 * Renders current positions (YES, NO, net), PnL breakdown, and portfolio metrics.
 * Used as part of status display or as standalone panel.
 *
 * @module infrastructure/ui/components/PositionPanel
 */

import type { StatusDisplayData, UIConfig } from '../types';

/**
 * Builds formatted position lines for display
 *
 * @param data - Status data with position info
 * @param config - UI configuration
 * @returns Array of formatted lines
 *
 * @remarks
 * Displays:
 * - Current positions (YES, NO, net)
 * - PnL breakdown (unrealized, realized, total)
 * - Cash balances (available, reserved)
 * - Portfolio value (if applicable)
 *
 * @example
 * ```typescript
 * const lines = buildPositionLines({
 *   yesPosition: 10.5,
 *   noPosition: 5.2,
 *   netPosition: 5.3,
 *   unrealizedPnL: 12.50,
 *   realizedPnL: -3.25,
 *   totalPnL: 9.25,
 *   cash: 9500,
 *   reservedCash: 150,
 *   // ... other fields
 * }, { asciiOnly: true });
 * ```
 */
export function buildPositionLines(
  data: StatusDisplayData,
  _config: UIConfig
): string[] {
  const lines: string[] = [];

  // Positions section
  lines.push('{bold}POSITIONS{/bold}');
  lines.push('');
  lines.push(...formatPositions(data));
  lines.push('');

  // PnL section
  lines.push('{bold}PnL{/bold}');
  lines.push('');
  lines.push(...formatPnL(data));
  lines.push('');

  // Cash section
  lines.push('{bold}CASH{/bold}');
  lines.push('');
  lines.push(...formatCash(data));

  return lines;
}

/**
 * Format positions with color coding
 *
 * @param data - Status data
 * @returns Array of formatted lines
 */
function formatPositions(data: StatusDisplayData): string[] {
  const netColor = data.netPosition > 0 ? 'green-fg' : data.netPosition < 0 ? 'red-fg' : 'white-fg';
  const netSign = data.netPosition > 0 ? '+' : '';

  return [
    `YES:  ${formatNumber(data.yesPosition, 1)} shares`,
    `NO:   ${formatNumber(data.noPosition, 1)} shares`,
    `{${netColor}}Net:  ${netSign}${formatNumber(data.netPosition, 1)} shares{/${netColor}}`,
  ];
}

/**
 * Format PnL with color coding
 *
 * @param data - Status data
 * @returns Array of formatted lines
 */
function formatPnL(data: StatusDisplayData): string[] {
  const totalColor = data.totalPnL >= 0 ? 'green-fg' : 'red-fg';
  const unrealizedColor = data.unrealizedPnL >= 0 ? 'green-fg' : 'red-fg';
  const realizedColor = data.realizedPnL >= 0 ? 'green-fg' : 'red-fg';

  const totalSign = data.totalPnL > 0 ? '+' : '';
  const unrealizedSign = data.unrealizedPnL > 0 ? '+' : '';
  const realizedSign = data.realizedPnL > 0 ? '+' : '';

  return [
    `{${unrealizedColor}}Unrealized: ${unrealizedSign}$${formatNumber(data.unrealizedPnL, 2)}{/${unrealizedColor}}`,
    `{${realizedColor}}Realized:   ${realizedSign}$${formatNumber(data.realizedPnL, 2)}{/${realizedColor}}`,
    `{${totalColor}}{bold}Total:      ${totalSign}$${formatNumber(data.totalPnL, 2)}{/bold}{/${totalColor}}`,
  ];
}

/**
 * Format cash balances
 *
 * @param data - Status data
 * @returns Array of formatted lines
 */
function formatCash(data: StatusDisplayData): string[] {
  const available = data.cash - data.reservedCash;
  const availableColor = available > 0 ? 'green-fg' : 'red-fg';

  return [
    `Total:     $${formatNumber(data.cash, 2)}`,
    `Reserved:  $${formatNumber(data.reservedCash, 2)}`,
    `{${availableColor}}Available: $${formatNumber(available, 2)}{/${availableColor}}`,
  ];
}

/**
 * Build compact position summary (single line)
 *
 * @param data - Status data
 * @param config - UI configuration
 * @returns Formatted string
 *
 * @remarks
 * Generates a compact one-line position summary for status bars.
 *
 * @example
 * ```typescript
 * const summary = buildPositionSummary({
 *   yesPosition: 10.5,
 *   noPosition: 5.2,
 *   netPosition: 5.3,
 *   totalPnL: 9.25,
 *   // ... other fields
 * }, { asciiOnly: true });
 * // => "Pos: +5.3 (YES: 10.5, NO: 5.2) | PnL: +$9.25"
 * ```
 */
export function buildPositionSummary(
  data: StatusDisplayData,
  _config: UIConfig
): string {
  const netSign = data.netPosition > 0 ? '+' : '';
  const pnlSign = data.totalPnL > 0 ? '+' : '';
  const netColor = data.netPosition > 0 ? 'green-fg' : data.netPosition < 0 ? 'red-fg' : 'white-fg';
  const pnlColor = data.totalPnL >= 0 ? 'green-fg' : 'red-fg';

  return (
    `{${netColor}}Pos: ${netSign}${formatNumber(data.netPosition, 1)}{/${netColor}} ` +
    `(YES: ${formatNumber(data.yesPosition, 1)}, NO: ${formatNumber(data.noPosition, 1)}) | ` +
    `{${pnlColor}}PnL: ${pnlSign}$${formatNumber(data.totalPnL, 2)}{/${pnlColor}}`
  );
}

/**
 * Format number with fixed decimals
 *
 * @param value - Number to format
 * @param decimals - Decimal places
 * @returns Formatted string
 */
function formatNumber(value: number, decimals: number): string {
  return Math.abs(value).toFixed(decimals);
}
