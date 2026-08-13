/**
 * Инфраструктурные порты пакета @polymarket/exchange.
 *
 * @remarks
 * INTERNAL — используются только внутри инфраструктурного слоя.
 * Application-layer порты будут в @polymarket/ports (Phase 1).
 */

export type { IExecutionAdapter, PlaceOrderParams, OrderResponse as OrderResponseExec, FillResponse } from './IExecutionAdapter.js';
export type { IPortfolioAdapter, PositionResponse, CanPlaceOrderParams, CanPlaceOrderResult } from './IPortfolioAdapter.js';
export type { IBalanceProvider } from './IBalanceProvider.js';
export type { IPositionsProvider, PositionResponse as PositionResp, PositionState } from './IPositionsProvider.js';
export type { IOrdersProvider, OrderResponse as OrderResponseOrders } from './IOrdersProvider.js';
export type { IPortfolioProjector, ProjectedPosition } from './IPortfolioProjector.js';
export type { IInfraOrderRepository } from './IInfraOrderRepository.js';
export type { IEventBus } from './IEventBus.js';
export type { IMarketDataFeed } from './IMarketDataFeed.js';
