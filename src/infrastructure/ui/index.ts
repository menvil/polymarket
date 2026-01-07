/**
 * UI module exports
 *
 * @remarks
 * Provides all UI implementations and types for trading bot interface.
 *
 * @module infrastructure/ui
 */

// Types
export type {
  ITradingUI,
  LogLevel,
  LogCategory,
  LogEntry,
  OrderDisplayData,
  FillDisplayData,
  StatusDisplayData,
  UIConfig,
} from './types';

// Implementations
export { BlessedTradingUI } from './BlessedTradingUI.js';
export { HeadlessUI } from './HeadlessUI.js';

// Components (for custom UI implementations)
export { buildStatusLines } from './components/StatusPanel.js';
export { buildLogLines, deduplicateLogs } from './components/LogPanel.js';
export { buildOrderLines, buildFillLines, buildOrdersAndFillsLines } from './components/OrderPanel.js';
export { buildPositionLines, buildPositionSummary } from './components/PositionPanel.js';
