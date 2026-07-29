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
 *
 * @packageDocumentation
 */

// Use Cases
export { PlaceOrderUseCase } from './PlaceOrderUseCase.js';
export type { PlaceOrderInput, PlaceOrderDeps, PlaceOrderError } from './PlaceOrderUseCase.js';
export {
  PlaceOrderFailureError,
  getPlaceFailureCode,
  getPlaceFailureBalance,
} from './PlaceOrderFailure.js';
export type { PlaceFailureCode, PlaceFailureBalanceMetadata } from './PlaceOrderFailure.js';
export type { CancelOrderOutcome } from './CancelOrderUseCase.js';

export { ProcessFillUseCase } from './ProcessFillUseCase.js';
export type { ProcessFillDeps } from './ProcessFillUseCase.js';

export { CancelOrderUseCase } from './CancelOrderUseCase.js';
export type { CancelOrderInput, CancelOrderDeps } from './CancelOrderUseCase.js';

export { ReconcileTradesUseCase } from './ReconcileTradesUseCase.js';
export type { ReconcileTradesDeps, ReconcileTradesInput } from './ReconcileTradesUseCase.js';

export { ReconcileUnknownSubmissionsUseCase } from './ReconcileUnknownSubmissionsUseCase.js';
export type {
  ReconcileUnknownSubmissionsDeps,
  ReconcileUnknownSubmissionsInput,
  ReconcileUnknownSubmissionsSummary,
  UnknownSubmissionCandidate,
  UnknownSubmissionDiscoveryOutcome,
  UnknownSubmissionFinding,
} from './ReconcileUnknownSubmissionsUseCase.js';

export { ResolveUnknownSubmissionUseCase } from './ResolveUnknownSubmissionUseCase.js';
export type {
  ResolveUnknownSubmissionDeps,
  ResolveUnknownSubmissionInput,
  ResolveUnknownSubmissionOutcome,
  UnknownSubmissionResolution,
} from './ResolveUnknownSubmissionUseCase.js';

export { CancelBoundVenueOrderUseCase } from './CancelBoundVenueOrderUseCase.js';
export type {
  CancelBoundVenueOrderDeps,
  CancelBoundVenueOrderInput,
  CancelBoundVenueOrderOutcome,
} from './CancelBoundVenueOrderUseCase.js';

export { SettleTerminalOrdersUseCase } from './SettleTerminalOrdersUseCase.js';
export type {
  SettleTerminalOrdersDeps,
  SettleTerminalOrdersInput,
  SettleTerminalOrdersSummary,
} from './SettleTerminalOrdersUseCase.js';
export { venueTradeToFill } from './services/venueTradeToFill.js';
export { isProcessableVenueTradeStatus, isFailedVenueTradeStatus } from './services/venueTradeStatusPolicy.js';
export type { VenueTradeStatusProfile } from './services/venueTradeStatusPolicy.js';

export { InitializePortfolioUseCase } from './InitializePortfolioUseCase.js';
export type { InitializePortfolioDeps } from './InitializePortfolioUseCase.js';

export { UpdateOrderStatusUseCase } from './UpdateOrderStatusUseCase.js';
export type { UpdateOrderStatusInput, UpdateOrderStatusDeps } from './UpdateOrderStatusUseCase.js';

export { SubmissionJournalStrategyCommitmentReader } from './SubmissionJournalStrategyCommitmentReader.js';
export type { SubmissionJournalStrategyCommitmentReaderDeps } from './SubmissionJournalStrategyCommitmentReader.js';

// Services
export { PortfolioService } from './services/PortfolioService.js';
export type { PortfolioSaveError } from './services/PortfolioService.js';
export { LedgerService } from './services/LedgerService.js';
