/**
 * Ports barrel export
 *
 * @remarks
 * Exports all domain ports (interfaces for external dependencies).
 * Implementations are provided by infrastructure layer.
 *
 * Ports follow Hexagonal Architecture pattern:
 * - Domain defines contracts (interfaces)
 * - Infrastructure provides implementations (adapters)
 * - Application layer injects dependencies
 */

export type { IExchangeAdapter } from './IExchangeAdapter.js';
export type { IOrderRepository } from './IOrderRepository.js';
export type { IMarketDataFeed } from './IMarketDataFeed.js';
export type { ILogger } from './ILogger.js';
export type { IConfigProvider } from './IConfigProvider.js';
export type {
  IDataRecorder,
  RawWsEvent,
  RecordedMarketInfo,
  RecorderStats,
} from './IDataRecorder.js';
