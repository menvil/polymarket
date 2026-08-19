/**
 * @polymarket/data-collection — запись сырых WS-событий на диск.
 *
 * @remarks
 * Инфраструктурная реализация `IMarketDataRecorder` из `@polymarket/ports`.
 *
 * ### Использование:
 * ```typescript
 * import { DataRecorder, NDJSONFormatter, GzipCompressor, DEFAULT_RECORDER_CONFIG } from '@polymarket/data-collection';
 * ```
 */

export { DataRecorder } from './DataRecorder.js';
export type { RecordOutcome, DelayedActivationFailureCallback } from './DataRecorder.js';
export { ArchivedMarketMetaRewriter } from './ArchivedMarketMetaRewriter.js';
export { DecisionJournalRecorder } from './DecisionJournalRecorder.js';
export type { DecisionJournalConfig } from './DecisionJournalRecorder.js';
export { NDJSONFormatter } from './formatters/NDJSONFormatter.js';
export { GzipCompressor } from './compression/GzipCompressor.js';
export type { IFormatter } from './formatters/IFormatter.js';
export type { DataRecorderConfig } from './config/DataRecorderConfig.js';
export { DEFAULT_RECORDER_CONFIG } from './config/DataRecorderConfig.js';
