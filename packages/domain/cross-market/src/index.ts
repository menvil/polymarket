/**
 * @polymarket/cross-market — кросс-маркетный арбитраж
 *
 * @remarks
 * Пакет для обнаружения и эксплуатации расхождений вероятностей
 * между рынками разной длительности на Polymarket.
 *
 * ### Экспортируемые модули:
 * - `DivergenceDetector` — обнаружение арбитражных расхождений
 * - `DepthAnalyzer` — анализ глубины ордербука (VWAP по уровням 1-5)
 * - `FeeCalculator` — калькулятор комиссий Polymarket
 * - `MarketPairMatcher` — матчинг рынков по (asset, endDate, recurrence)
 * - Типы: `MarketPair`, `ArbitrageSignal`, `SimpleBook`, etc.
 *
 * ### Пример использования:
 * ```typescript
 * import {
 *   DivergenceDetector,
 *   MarketPairMatcher,
 *   FEE_MODEL_CURRENT,
 * } from '@polymarket/cross-market';
 *
 * const detector = new DivergenceDetector({ feeModel: FEE_MODEL_CURRENT });
 * const matcher = new MarketPairMatcher();
 * const pairs = matcher.findPairs(marketInfos);
 *
 * for (const pair of pairs) {
 *   const signal = detector.detect(easyBook, hardBook, pair, Date.now());
 *   if (signal) console.log(`Arbitrage: ${signal.optimalDepth.totalPnl}`);
 * }
 * ```
 *
 * @packageDocumentation
 */

export { DivergenceDetector } from './DivergenceDetector.js';
export { DepthAnalyzer } from './DepthAnalyzer.js';
export type { DepthAnalysisOptions } from './DepthAnalyzer.js';
export { FeeCalculator } from './FeeCalculator.js';
export { MarketPairMatcher } from './MarketPairMatcher.js';
export type { RawSnapshotMeta } from './MarketPairMatcher.js';

// Типы
export type {
  Recurrence,
  MarketInfo,
  MarketPair,
  NumericLevel,
  SimpleBook,
  DepthLevel,
  ArbitrageSignal,
  FeeModel,
  DetectorConfig,
} from './types.js';

// Константы
export {
  RECURRENCE_RANK,
  OVERLAP_DURATION_MS,
  FEE_MODEL_CURRENT,
  FEE_MODEL_MARCH30,
  DEFAULT_DETECTOR_CONFIG,
} from './types.js';
