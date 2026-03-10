/**
 * @polymarket/use-cases — Application layer use cases
 *
 * @remarks
 * Use cases оркестрируют domain objects для торговых операций:
 *
 * - **PlaceOrderUseCase** — размещение ордера с пре-трейд риск-проверкой
 * - **ProcessFillUseCase** — обработка исполнения ордера (идемпотентно)
 * - **CancelOrderUseCase** — отмена ордера с откатом резервации
 * - **ReconcileOrdersUseCase** — сверка открытых ордеров с биржей
 * - **ReconcileTradesUseCase** — сверка исполнений с биржей
 *
 * Вспомогательные сервисы:
 * - **OrderService** — операции над Order aggregate
 * - **PortfolioService** — операции над Portfolio aggregate
 * - **LedgerService** — запись Fill в Ledger
 *
 * @packageDocumentation
 */

// Use Cases
export { PlaceOrderUseCase } from './PlaceOrderUseCase.js';
export type { PlaceOrderInput, PlaceOrderDeps, PlaceOrderError } from './PlaceOrderUseCase.js';

export { ProcessFillUseCase } from './ProcessFillUseCase.js';
export type { ProcessFillDeps } from './ProcessFillUseCase.js';

export { CancelOrderUseCase } from './CancelOrderUseCase.js';
export type { CancelOrderInput, CancelOrderDeps } from './CancelOrderUseCase.js';

export { ReconcileOrdersUseCase } from './ReconcileOrdersUseCase.js';
export type {
  ReconcileOrdersDeps,
  ReconcileOrdersInput,
  ReconciliationReport,
} from './ReconcileOrdersUseCase.js';

export { ReconcileTradesUseCase } from './ReconcileTradesUseCase.js';
export type { ReconcileTradesDeps, ReconcileTradesInput } from './ReconcileTradesUseCase.js';

// Services
export { OrderService } from './services/OrderService.js';
export { PortfolioService } from './services/PortfolioService.js';
export type { PortfolioSaveError } from './services/PortfolioService.js';
export { LedgerService } from './services/LedgerService.js';
export { SimplePosition } from './services/SimplePosition.js';
export type { SimplePositionParams } from './services/SimplePosition.js';
