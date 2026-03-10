/**
 * @polymarket/use-cases — Application layer use cases
 *
 * @remarks
 * Три use case оркестрируют domain objects для основных торговых операций:
 *
 * - **PlaceOrderUseCase** — размещение ордера с пре-трейд риск-проверкой
 * - **ProcessFillUseCase** — обработка исполнения ордера (идемпотентно)
 * - **CancelOrderUseCase** — отмена ордера с откатом резервации
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

// Services
export { OrderService } from './services/OrderService.js';
export { PortfolioService } from './services/PortfolioService.js';
export type { PortfolioSaveError } from './services/PortfolioService.js';
export { LedgerService } from './services/LedgerService.js';
export { SimplePosition } from './services/SimplePosition.js';
export type { SimplePositionParams } from './services/SimplePosition.js';
