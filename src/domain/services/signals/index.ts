/**
 * Signals module barrel export
 *
 * @remarks
 * Экспорт сервисов и типов для анализа торговых сигналов:
 * - **TradeSideDetector**: Определение стороны сделки (BUY/SELL/UNKNOWN)
 * - **TradeFlowAnalyzer**: Анализ торгового потока с Fragility и Decay
 *
 * @example
 * ```typescript
 * import {
 *   TradeFlowAnalyzer,
 *   TradeSideDetector,
 *   TradeFlowMetrics,
 *   MarketState,
 * } from '@domain/services/signals';
 *
 * const detector = new TradeSideDetector();
 * const analyzer = new TradeFlowAnalyzer(config, logger);
 *
 * // Detect trade side
 * const side = detector.detect(price, size, { bid, ask });
 *
 * // Record trade
 * analyzer.recordTrade({ side, price, size, timestamp: Date.now() });
 *
 * // Get market state
 * const metrics = analyzer.getMarketState();
 * console.log(`State: ${metrics.state}, Fragility: ${metrics.fragilityScore}`);
 * ```
 */

// Types
export type {
  MarketContext,
  TradeSide,
  BestPrices,
  TradeContext,
  TradeEvent,
  OrderBookLevel,
  OrderBookSnapshot,
  MarketState,
  TradeFlowMetrics,
  TradeFlowConfig,
  OrderbookHealthMetrics,
  OrderbookHealthConfig,
} from './types.js';

export {
  formatTimeToExpiry,
  getMarketLogInfo,
  DEFAULT_TRADE_FLOW_CONFIG,
  DEFAULT_ORDERBOOK_HEALTH_CONFIG,
} from './types.js';

// TradeSideDetector
export { TradeSideDetector, DEFAULT_TRADE_SIDE_DETECTOR_CONFIG } from './TradeSideDetector.js';
export type { TradeSideDetectorConfig } from './TradeSideDetector.js';

// TradeFlowAnalyzer
export { TradeFlowAnalyzer } from './TradeFlowAnalyzer.js';

// OrderbookHealthMonitor
export { OrderbookHealthMonitor } from './OrderbookHealthMonitor.js';
