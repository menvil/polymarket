/**
 * @polymarket/ports — Application-layer порты.
 *
 * @remarks
 * Dependency Inversion — use-cases, handlers и strategy зависят от этих интерфейсов,
 * а не от конкретных инфраструктурных реализаций.
 *
 * ### Содержимое пакета:
 * - `IOrderRepository` — хранилище Order агрегатов с CAS-защитой (optimistic concurrency)
 * - `DeleteOrderResult` / `OrderStateConflictError` — результат/ошибка условного удаления Order
 * - `IPortfolioStore` — хранилище Portfolio с CAS-защитой
 * - `VersionConflictError` — ошибка конфликта версий (CAS, Portfolio и Order)
 * - `IProcessedFillRepository` — idempotency guard для Fill
 * - `IReconciliationIssueRepository` / `ReconciliationIssue` — queryable хранилище
 *   operational/recovery issues, требующих ручной реконсиляции
 * - `IExchangeClient` / `SubmitOrderParams` / `ExchangeError` — торговый клиент
 * - `OpenOrderSnapshot` / `VenueTradeSnapshot` / `FeeSnapshot` — DTO от биржи
 * - `IMarketCatalog` / `InstrumentInfo` — каталог инструментов (read/write)
 * - `IMarketDataRecorder` / `MarketMeta` — запись сырых WS-событий на диск
 * - `IMarketDiscoveryService` / `DiscoveredMarket` — обнаружение торговых рынков
 * - `IMarketFilterConfig` — конфигурация фильтрации рынков
 * - `ICurrentBalanceProvider` — получение текущего USDC-баланса от venue
 * - `IFillReverter` — откат применённого fill из Portfolio (для FILL_FAILED handler)
 * - `IFillProcessor` — обработка fill (для FillOrchestrator, реализует ProcessFillUseCase)
 * - `IKeyedMutex` — сериализация конкурентных мутаций Order/Portfolio по ключам
 *
 * @example
 * ```typescript
 * import type {
 *   IOrderRepository,
 *   IPortfolioStore,
 *   IExchangeClient,
 *   IMarketCatalog,
 *   IMarketDataRecorder,
 * } from '@polymarket/ports';
 * ```
 */

export type { IOrderRepository, DeleteOrderResult } from './IOrderRepository.js';
export { OrderStateConflictError } from './IOrderRepository.js';
export type { IPortfolioStore } from './IPortfolioStore.js';
export { VersionConflictError } from './VersionConflictError.js';
export type {
  IProcessedFillRepository,
  ProcessedFillStatus,
  BeginFillProcessingResult,
} from './IProcessedFillRepository.js';
export type {
  IReconciliationIssueRepository,
  ReconciliationIssue,
  ReconciliationIssueType,
  ReconciliationIssueStatus,
} from './IReconciliationIssueRepository.js';
export { ExchangeError } from './IExchangeClient.js';
export type {
  IExchangeClient,
  SubmitOrderParams,
  SubmitOrderResult,
  CancelOrderResult,
  OpenOrderSnapshot,
  VenueTradeSnapshot,
  VenueTradeStatus,
  FeeSnapshot,
} from './IExchangeClient.js';
export type { IMarketCatalog, InstrumentInfo } from './IMarketCatalog.js';
export type { IMarketDataRecorder, MarketMeta } from './IMarketDataRecorder.js';
export type {
  IDecisionJournal,
  SessionMeta,
  DecisionEntry,
  OrderEntry,
  FillEntry,
  ResolutionEntry,
  SignalEntry,
  CancelEntry,
} from './IDecisionJournal.js';
export type { IMarketDiscoveryService, DiscoveredMarket } from './IMarketDiscoveryService.js';
export type { IMarketFilterConfig } from './IMarketFilterConfig.js';
export type { IOrderStateStore, InFlightFill } from './IOrderStateStore.js';
export { pendingMatchFillId } from './IOrderStateStore.js';
export type { ICurrentBalanceProvider } from './ICurrentBalanceProvider.js';
export type { IFillReverter } from './IFillReverter.js';
export type { IFillProcessor } from './IFillProcessor.js';
export type { IKeyedMutex } from './IKeyedMutex.js';
