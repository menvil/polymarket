/**
 * @polymarket/use-cases — Application layer use cases
 *
 * @remarks
 * Use cases оркестрируют domain objects для торговых операций:
 *
 * - **PlaceOrderUseCase** — размещение ордера с пре-трейд риск-проверкой
 * - **ProcessFillUseCase** — обработка исполнения ордера (идемпотентно)
 * - **CancelOrderUseCase** — отмена ордера с откатом резервации
 * - **ReconcileTradesUseCase** — сверка исполнений с биржей
 * - **ReconcileUnknownSubmissionsUseCase** — привязка/разрешение ambiguous
 *   submissions без venueOrderId (recovery reservation)
 * - **InitializePortfolioUseCase** — инициализация Portfolio из баланса venue
 * - **SubmissionJournalStrategyCommitmentReader** — authoritative reader
 *   незавершённых submission/reservation/fill commitments стратегии
 *   (`IStrategyCommitmentReader` для `StrategyScheduler` final cleanup)
 *
 * Вспомогательные сервисы:
 * - **PortfolioService** — операции над Portfolio aggregate
 * - **LedgerService** — запись Fill в Ledger
 * - **ExecutionLinker** — best-effort сшивка Fill с рыночным Trade (Этап 7,
 *   логирование match/no-match, персистентность не построена)
 *
 * @packageDocumentation
 */

// Use Cases
export { PlaceOrderUseCase } from './PlaceOrderUseCase.js';
/** Реэкспорт входа/зависимостей/ошибки PlaceOrderUseCase (см. PlaceOrderUseCase.ts). */
export type { PlaceOrderInput, PlaceOrderDeps, PlaceOrderError } from './PlaceOrderUseCase.js';
export {
  PlaceOrderFailureError,
  getPlaceFailureCode,
  getPlaceFailureBalance,
} from './PlaceOrderFailure.js';
/** Реэкспорт кода/метаданных failure-ошибки (см. PlaceOrderFailure.ts). */
export type { PlaceFailureCode, PlaceFailureBalanceMetadata } from './PlaceOrderFailure.js';
/** Реэкспорт исхода отмены ордера (см. CancelOrderUseCase.ts). */
export type { CancelOrderOutcome } from './CancelOrderUseCase.js';

export { ProcessFillUseCase } from './ProcessFillUseCase.js';
/** Реэкспорт зависимостей ProcessFillUseCase (см. ProcessFillUseCase.ts). */
export type { ProcessFillDeps } from './ProcessFillUseCase.js';

export { CancelOrderUseCase } from './CancelOrderUseCase.js';
/** Реэкспорт входа/зависимостей CancelOrderUseCase (см. CancelOrderUseCase.ts). */
export type { CancelOrderInput, CancelOrderDeps } from './CancelOrderUseCase.js';

export { ReconcileTradesUseCase } from './ReconcileTradesUseCase.js';
/** Реэкспорт зависимостей/входа ReconcileTradesUseCase (см. ReconcileTradesUseCase.ts). */
export type { ReconcileTradesDeps, ReconcileTradesInput } from './ReconcileTradesUseCase.js';

export { ReconcileUnknownSubmissionsUseCase } from './ReconcileUnknownSubmissionsUseCase.js';
/** Реэкспорт типов ReconcileUnknownSubmissionsUseCase (см. ReconcileUnknownSubmissionsUseCase.ts). */
export type {
  ReconcileUnknownSubmissionsDeps,
  ReconcileUnknownSubmissionsInput,
  ReconcileUnknownSubmissionsSummary,
  UnknownSubmissionCandidate,
  UnknownSubmissionDiscoveryOutcome,
  UnknownSubmissionFinding,
} from './ReconcileUnknownSubmissionsUseCase.js';

export { ResolveUnknownSubmissionUseCase } from './ResolveUnknownSubmissionUseCase.js';
/** Реэкспорт типов ResolveUnknownSubmissionUseCase (см. ResolveUnknownSubmissionUseCase.ts). */
export type {
  ResolveUnknownSubmissionDeps,
  ResolveUnknownSubmissionInput,
  ResolveUnknownSubmissionOutcome,
  UnknownSubmissionResolution,
} from './ResolveUnknownSubmissionUseCase.js';

export { CancelBoundVenueOrderUseCase } from './CancelBoundVenueOrderUseCase.js';
/** Реэкспорт типов CancelBoundVenueOrderUseCase (см. CancelBoundVenueOrderUseCase.ts). */
export type {
  CancelBoundVenueOrderDeps,
  CancelBoundVenueOrderInput,
  CancelBoundVenueOrderOutcome,
} from './CancelBoundVenueOrderUseCase.js';

export { SettleTerminalOrdersUseCase } from './SettleTerminalOrdersUseCase.js';
/** Реэкспорт типов SettleTerminalOrdersUseCase (см. SettleTerminalOrdersUseCase.ts). */
export type {
  SettleTerminalOrdersDeps,
  SettleTerminalOrdersInput,
  SettleTerminalOrdersSummary,
} from './SettleTerminalOrdersUseCase.js';
export { venueTradeToFill } from './services/venueTradeToFill.js';
export { isProcessableVenueTradeStatus, isFailedVenueTradeStatus } from './services/venueTradeStatusPolicy.js';
/** Реэкспорт профиля venue-trade статуса (см. services/venueTradeStatusPolicy.ts). */
export type { VenueTradeStatusProfile } from './services/venueTradeStatusPolicy.js';

export { InitializePortfolioUseCase } from './InitializePortfolioUseCase.js';
/** Реэкспорт зависимостей InitializePortfolioUseCase (см. InitializePortfolioUseCase.ts). */
export type { InitializePortfolioDeps } from './InitializePortfolioUseCase.js';

export { UpdateOrderStatusUseCase } from './UpdateOrderStatusUseCase.js';
/** Реэкспорт входа/зависимостей UpdateOrderStatusUseCase (см. UpdateOrderStatusUseCase.ts). */
export type { UpdateOrderStatusInput, UpdateOrderStatusDeps } from './UpdateOrderStatusUseCase.js';

export { SubmissionJournalStrategyCommitmentReader } from './SubmissionJournalStrategyCommitmentReader.js';
/** Реэкспорт зависимостей SubmissionJournalStrategyCommitmentReader (см. одноимённый файл). */
export type { SubmissionJournalStrategyCommitmentReaderDeps } from './SubmissionJournalStrategyCommitmentReader.js';

// Services
export { PortfolioService } from './services/PortfolioService.js';
/** Реэкспорт ошибки сохранения Portfolio (см. services/PortfolioService.ts). */
export type { PortfolioSaveError } from './services/PortfolioService.js';
export { LedgerService } from './services/LedgerService.js';
export { ExecutionLinker } from './services/ExecutionLinker.js';
/** Реэкспорт зависимостей ExecutionLinker (см. services/ExecutionLinker.ts). */
export type { ExecutionLinkerDeps } from './services/ExecutionLinker.js';
