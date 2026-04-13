import type { CexRecordSink } from './CexTypes.js';

export interface CexExchangeConfig {
  readonly exchangeId?: string;
  readonly type: 'spot' | 'futures' | 'swap';
  readonly symbols: readonly string[];
  readonly orderbook: boolean;
  readonly trades: boolean;
  readonly obDepth?: number;
  readonly restartIntervalMs?: number;
  readonly obMethod?: 'watch' | 'fetch';
}

export interface CexCollectorConfig {
  readonly exchanges: Readonly<Record<string, CexExchangeConfig>>;
  readonly outputDir?: string;
  readonly compression?: 'none' | 'gzip';
  readonly windowMinutes?: number;
  readonly bufferSize?: number;
  readonly flushIntervalMs?: number;
  readonly sinks?: readonly CexRecordSink[];
}
