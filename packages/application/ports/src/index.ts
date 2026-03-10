/**
 * @polymarket/ports — Application-layer порты.
 *
 * @remarks
 * Dependency Inversion — use-cases, handlers и strategy зависят от этих интерфейсов,
 * а не от конкретных инфраструктурных реализаций.
 *
 * ### Содержимое пакета:
 * - `IOrderRepository` — хранилище Order агрегатов
 * - `IPortfolioStore` — хранилище Portfolio с CAS-защитой
 * - `VersionConflictError` — ошибка конфликта версий (CAS)
 * - `IProcessedFillRepository` — idempotency guard для Fill
 * - `IExchangeClient` / `SubmitOrderParams` / `ExchangeError` — торговый клиент
 * - `OpenOrderSnapshot` / `VenueTradeSnapshot` / `FeeSnapshot` — DTO от биржи
 * - `IMarketCatalog` / `InstrumentInfo` — каталог инструментов (read/write)
 * - `IBalanceAllocator` / `AllocationResult` / `AllocationStats` — распределитель баланса
 * - `IMarketDataRecorder` / `MarketMeta` — запись сырых WS-событий на диск
 * - `IMarketDiscoveryService` / `DiscoveredMarket` — обнаружение торговых рынков
 * - `IMarketFilterConfig` — конфигурация фильтрации рынков
 *
 * @example
 * ```typescript
 * import type {
 *   IOrderRepository,
 *   IPortfolioStore,
 *   IExchangeClient,
 *   IMarketCatalog,
 *   IBalanceAllocator,
 *   IMarketDataRecorder,
 * } from '@polymarket/ports';
 * ```
 */

export type { IOrderRepository } from './IOrderRepository.js';
export type { IPortfolioStore } from './IPortfolioStore.js';
export { VersionConflictError } from './VersionConflictError.js';
export type { IProcessedFillRepository } from './IProcessedFillRepository.js';
export { ExchangeError } from './IExchangeClient.js';
export type {
  IExchangeClient,
  SubmitOrderParams,
  OpenOrderSnapshot,
  VenueTradeSnapshot,
  FeeSnapshot,
} from './IExchangeClient.js';
export type { IMarketCatalog, InstrumentInfo } from './IMarketCatalog.js';
export type { IBalanceAllocator, AllocationResult, AllocationStats } from './IBalanceAllocator.js';
export type { IMarketDataRecorder, MarketMeta } from './IMarketDataRecorder.js';
export type { IMarketDiscoveryService, DiscoveredMarket } from './IMarketDiscoveryService.js';
export type { IMarketFilterConfig } from './IMarketFilterConfig.js';
