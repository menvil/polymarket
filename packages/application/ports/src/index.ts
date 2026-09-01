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
 * - `IMarketDiscoveryService` / `MarketDiscoverySnapshot` / `MarketDiscoveryEntry` —
 *   обнаружение технически поддержанного universe рынков (canonical `Market`)
 * - `DiscoveredMarket` — LEGACY-кандидат discovery (вход V1-адаптера)
 * - `ICurrentBalanceProvider` — получение текущего USDC-баланса от venue
 * - `IFillReverter` — откат применённого fill из Portfolio (для FILL_FAILED handler)
 * - `IFillProcessor` — обработка fill (для FillOrchestrator, реализует ProcessFillUseCase)
 * - `IKeyedMutex` — сериализация конкурентных мутаций Order/Portfolio по ключам
 * - `IStrategyCommitmentReader` / `StrategyCommitment` — authoritative reader
 *   незавершённых submission/reservation/fill commitments стратегии (final
 *   cleanup post-check в `StrategyScheduler`)
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
/** Реэкспорт порта CAS-хранилища Portfolio (см. `IPortfolioStore.ts`). */
export type { IPortfolioStore } from './IPortfolioStore.js';
export { VersionConflictError } from './VersionConflictError.js';
/** Реэкспорт порта idempotency-guard для Fill (см. `IProcessedFillRepository.ts`). */
export type {
  IProcessedFillRepository,
  ProcessedFillStatus,
  BeginFillProcessingResult,
  FillProcessingLease,
} from './IProcessedFillRepository.js';
/** Реэкспорт порта submission-журнала ордеров (см. `IOrderSubmissionRepository.ts`). */
export type {
  IOrderSubmissionRepository,
  OrderSubmissionRecord,
  OrderSubmissionStatus,
  BeginOrderSubmissionResult,
} from './IOrderSubmissionRepository.js';
/** Реэкспорт типов учёта резервации капитала (см. `reservationJournal.ts`). */
export type {
  ReservationKind,
  ReservationStatus,
  ReservationSnapshot,
  ReservationDelta,
  ReservationTransitionCode,
  OrderSide,
} from './reservationJournal.js';
export {
  ReservationTransitionError,
  emptyReservation,
  heldReservation,
  hasHeldReservation,
  canConsumeHeldReservation,
  applyReservationDelta,
} from './reservationJournal.js';
/** Реэкспорт queryable-хранилища issues, требующих ручной реконсиляции (см. `IReconciliationIssueRepository.ts`). */
export type {
  IReconciliationIssueRepository,
  ReconciliationIssue,
  ReconciliationIssueType,
  ReconciliationIssueStatus,
} from './IReconciliationIssueRepository.js';
/** Реэкспорт порта упорядоченной доставки событий (см. `IOrderedEventOutbox.ts`). */
export type {
  IOrderedEventOutbox,
  OrderedEventBatch,
} from './IOrderedEventOutbox.js';
export { OutboxEnqueueError } from './IOrderedEventOutbox.js';
export { ExchangeError } from './IExchangeClient.js';
/** Реэкспорт торгового клиента и связанных типов (см. `IExchangeClient.ts`). */
export type {
  IExchangeClient,
  SubmitOrderParams,
  SubmitOrderResult,
  SubmitAmbiguity,
  SubmitRejectionCode,
  SubmitRejectionBalanceMetadata,
  CancelOrderResult,
  OpenOrderSnapshot,
  VenueTradeSnapshot,
  VenueTradeStatus,
  FeeSnapshot,
} from './IExchangeClient.js';
/** Реэкспорт каталога инструментов (см. `IMarketCatalog.ts`). */
export type { IMarketCatalog, InstrumentInfo } from './IMarketCatalog.js';
/** Реэкспорт порта записи сырых WS-событий на диск (см. `IMarketDataRecorder.ts`). */
export type { IMarketDataRecorder, MarketMeta } from './IMarketDataRecorder.js';
/**
 * Реэкспорт журнала решений стратегии (см. `IDecisionJournal.ts`).
 *
 * @remarks
 * Типы записей журнала намеренно НЕ переведены на VO/branded ID в Этапе 5 плана
 * миграции — реальные потребители (12 файлов `apps/bot/src/strategies/*`) и
 * реализация (`DecisionJournalRecorder` в `packages/infrastructure/persistence/
 * data-collection`) относятся к Этапам 9-10, не к `application/ports`. См.
 * `docs/ports.md`, раздел "Что отложено и почему".
 */
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
/** Реэкспорт порта обнаружения рынков и его canonical-контракта. */
export type {
  IMarketDiscoveryService,
  MarketDiscoveryRefreshOptions,
  MarketDiscoverySnapshot,
  MarketDiscoveryEntry,
  MarketDiscoveryMetrics,
  MarketDiscoveryDiagnostics,
  MarketDiscoveryInvalidBreakdown,
} from './IMarketDiscoveryService.js';
export { marketUniverseKey } from './IMarketDiscoveryService.js';
/** Реэкспорт LEGACY-кандидата discovery (вход Filter/Scorer до Policy-MR). */
export type { DiscoveredMarket } from './DiscoveredMarket.js';
/** Реэкспорт порта синхронного чтения ордеров (см. `IOrderStateStore.ts`). */
export type {
  IOrderStateStore,
  InFlightFill,
  InFlightFillStatus,
  MarkInFlightFillInput,
  FillProcessingStatus,
  FillProcessingBlock,
  MarkFillProcessingInput,
  ManualReconciliationBlock,
  TerminalSettlementPending,
} from './IOrderStateStore.js';
export { pendingMatchFillId } from './IOrderStateStore.js';
/** Реэкспорт порта получения баланса venue (см. `ICurrentBalanceProvider.ts`). */
export type { ICurrentBalanceProvider } from './ICurrentBalanceProvider.js';
/** Реэкспорт порта отката fill (см. `IFillReverter.ts`). */
export type { IFillReverter } from './IFillReverter.js';
/** Реэкспорт порта обработки fill (см. `IFillProcessor.ts`). */
export type { IFillProcessor } from './IFillProcessor.js';
/** Реэкспорт порта сериализации конкурентных мутаций (см. `IKeyedMutex.ts`). */
export type { IKeyedMutex } from './IKeyedMutex.js';
/** Реэкспорт порта чтения commitments стратегии (см. `IStrategyCommitmentReader.ts`). */
export type {
  IStrategyCommitmentReader,
  StrategyCommitment,
  StrategyCommitmentKind,
} from './IStrategyCommitmentReader.js';
