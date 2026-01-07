/**
 * Status panel component for displaying market and bot state
 *
 * @remarks
 * Renders current market info, mode, positions, PnL, and orderbook state.
 * Used by BlessedTradingUI and other UI implementations.
 *
 * @module infrastructure/ui/components/StatusPanel
 */

import type { StatusDisplayData, UIConfig } from '../types';

/**
 * Formats status data into display lines
 *
 * @param data - Current status data
 * @param config - UI configuration (asciiOnly, etc.)
 * @returns Array of formatted lines for display
 *
 * @remarks
 * Generates a formatted status panel with:
 * - Market question and expiry time
 * - Current mode and edge status
 * - Positions (YES, NO, net)
 * - PnL breakdown (unrealized, realized, total)
 * - Cash balances
 * - Orderbook state (mid prices, spreads, best bid/ask)
 *
 * @example
 * ```typescript
 * const lines = buildStatusLines({
 *   marketQuestion: 'Will BTC hit 100k?',
 *   timeToExpiry: '2h 15m',
 *   mode: 'QUOTE',
 *   edgeAlive: true,
 *   netPosition: 5.2,
 *   totalPnL: 12.50,
 *   // ... other fields
 * }, { asciiOnly: true });
 * console.log(lines.join('\n'));
 * ```
 */
export function buildStatusLines(
  data: StatusDisplayData,
  config: UIConfig
): string[] {
  const lines: string[] = [];
  const icon = (name: string) => getIcon(name, config.asciiOnly);

  // Market info
  lines.push(formatMarketSection(data, icon));
  lines.push('');

  // Mode and edge status
  lines.push(formatModeSection(data, icon));
  lines.push('');

  // Positions
  lines.push(formatPositionSection(data, icon));
  lines.push('');

  // PnL
  lines.push(formatPnLSection(data, icon));
  lines.push('');

  // Cash
  lines.push(formatCashSection(data, icon));
  lines.push('');

  // Orderbook state
  lines.push(formatOrderbookSection(data, icon));

  return lines;
}

/**
 * Format market information section
 *
 * @param data - Status data
 * @param icon - Icon getter function
 * @returns Formatted string
 */
function formatMarketSection(
  data: StatusDisplayData,
  _icon: (name: string) => string
): string {
  return [
    `{cyan-fg}{bold}${truncate(data.marketQuestion, 68)}{/bold}{/cyan-fg}`,
    `End: ${data.marketEndDate}`,
    `Time: ${data.timeToExpiry}`,
  ].join('\n');
}

/**
 * Format mode and edge status section
 *
 * @param data - Status data
 * @param icon - Icon getter function
 * @returns Formatted string
 */
function formatModeSection(
  data: StatusDisplayData,
  icon: (name: string) => string
): string {
  const modeColor = getModeColor(data.mode);
  const edgeIcon = data.edgeAlive ? icon('ok') : icon('err');
  const edgeColor = getEdgeColor(data.edgeStage);

  return [
    `{${modeColor}}Mode: ${data.mode}{/${modeColor}}`,
    `{${edgeColor}}Edge: ${edgeIcon} ${data.edgeStage}{/${edgeColor}}`,
  ].join('\n');
}

/**
 * Format position section
 *
 * @param data - Status data
 * @param icon - Icon getter function
 * @returns Formatted string
 */
function formatPositionSection(
  data: StatusDisplayData,
  _icon: (name: string) => string
): string {
  const netColor = data.netPosition > 0 ? 'green-fg' : data.netPosition < 0 ? 'red-fg' : 'white-fg';

  return [
    `{bold}Positions:{/bold}`,
    `  YES: ${fmt(data.yesPosition, 1)}`,
    `  NO:  ${fmt(data.noPosition, 1)}`,
    `  {${netColor}}Net: ${fmt(data.netPosition, 1, true)}{/${netColor}}`,
  ].join('\n');
}

/**
 * Format PnL section
 *
 * @param data - Status data
 * @param icon - Icon getter function
 * @returns Formatted string
 */
function formatPnLSection(
  data: StatusDisplayData,
  _icon: (name: string) => string
): string {
  const totalColor = data.totalPnL >= 0 ? 'green-fg' : 'red-fg';

  return [
    `{bold}PnL:{/bold}`,
    `  Unrealized: $${fmt(data.unrealizedPnL, 2, true)}`,
    `  Realized:   $${fmt(data.realizedPnL, 2, true)}`,
    `  {${totalColor}}Total: $${fmt(data.totalPnL, 2, true)}{/${totalColor}}`,
  ].join('\n');
}

/**
 * Format cash section
 *
 * @param data - Status data
 * @param icon - Icon getter function
 * @returns Formatted string
 */
function formatCashSection(
  data: StatusDisplayData,
  _icon: (name: string) => string
): string {
  return [
    `{bold}Cash:{/bold}`,
    `  Available: $${fmt(data.cash, 2)}`,
    `  Reserved:  $${fmt(data.reservedCash, 2)}`,
  ].join('\n');
}

/**
 * Format orderbook section
 *
 * @param data - Status data
 * @param icon - Icon getter function
 * @returns Formatted string
 */
function formatOrderbookSection(
  data: StatusDisplayData,
  _icon: (name: string) => string
): string {
  return [
    `{bold}Orderbook:{/bold}`,
    `  YES: ${fmtPrice(data.yesMid)} (spread: ${fmtPrice(data.yesSpread)})`,
    `    Bid: ${fmtPriceOrNull(data.yesBestBid)} | Ask: ${fmtPriceOrNull(data.yesBestAsk)}`,
    `  NO:  ${fmtPrice(data.noMid)} (spread: ${fmtPrice(data.noSpread)})`,
    `    Bid: ${fmtPriceOrNull(data.noBestBid)} | Ask: ${fmtPriceOrNull(data.noNoBestAsk)}`,
  ].join('\n');
}

/**
 * Get icon for name (ASCII or emoji)
 *
 * @param name - Icon name
 * @param asciiOnly - Use ASCII symbols
 * @returns Icon string
 */
function getIcon(name: string, asciiOnly: boolean): string {
  const ICON_MAP: Record<string, { emoji: string; ascii: string }> = {
    ok: { emoji: '✅', ascii: '[OK]' },
    warn: { emoji: '⚠️', ascii: '[WARN]' },
    err: { emoji: '❌', ascii: '[ERR]' },
    alert: { emoji: '🚨', ascii: '[ALERT]' },
    info: { emoji: 'ℹ️', ascii: '[INFO]' },
  };

  const iconData = ICON_MAP[name];
  if (!iconData) return name;
  return asciiOnly ? iconData.ascii : iconData.emoji;
}

/**
 * Get color for mode
 *
 * @param mode - Current mode
 * @returns Blessed color tag
 */
function getModeColor(mode: string): string {
  switch (mode) {
    case 'QUOTE':
      return 'green-fg';
    case 'SKEW':
      return 'yellow-fg';
    case 'UNWIND':
      return 'magenta-fg';
    case 'PANIC':
      return 'red-fg';
    case 'PAUSED':
      return 'gray-fg';
    default:
      return 'white-fg';
  }
}

/**
 * Get color for edge stage
 *
 * @param stage - Edge stage
 * @returns Blessed color tag
 */
function getEdgeColor(stage: string): string {
  switch (stage) {
    case 'ALIVE':
      return 'green-fg';
    case 'WARNING':
      return 'yellow-fg';
    case 'DEAD':
      return 'red-fg';
    default:
      return 'white-fg';
  }
}

/**
 * Format number with specified decimals and optional sign
 *
 * @param value - Number to format
 * @param decimals - Decimal places
 * @param showSign - Show + for positive numbers
 * @returns Formatted string
 *
 * @example
 * ```typescript
 * fmt(12.345, 2) // "12.35"
 * fmt(12.345, 2, true) // "+12.35"
 * fmt(-12.345, 2, true) // "-12.35"
 * ```
 */
function fmt(value: number, decimals: number, showSign = false): string {
  const formatted = value.toFixed(decimals);
  if (showSign && value > 0) {
    return `+${formatted}`;
  }
  return formatted;
}

/**
 * Format price with 4 decimals
 *
 * @param value - Price value
 * @returns Formatted string
 */
function fmtPrice(value: number): string {
  return value.toFixed(4);
}

/**
 * Format price or show '-' for null
 *
 * @param value - Price value or null
 * @returns Formatted string
 */
function fmtPriceOrNull(value: number | null): string {
  return value !== null ? fmtPrice(value) : '-';
}

/**
 * Truncate string to max length
 *
 * @param str - Input string
 * @param maxLen - Maximum length
 * @returns Truncated string
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + '...';
}
