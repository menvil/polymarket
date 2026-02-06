/**
 * @polymarket/ids - Foundation ID types
 *
 * @remarks
 * Фундаментальные типы идентификаторов для Polymarket domain.
 *
 * Структура:
 * - core: Domain IDs (ConditionRef, OutcomeKey, AccountId, VenueId, AssetId)
 * - market-data: Market Data IDs (MarketDataSourceId, InstrumentId)
 * - execution: Execution IDs (ExecutionVenueId, OrderId, FillId)
 *
 * @packageDocumentation
 */

// Core domain IDs
export * from './core/index.js';

// Market data IDs
export * from './market-data/index.js';

// Execution IDs
export * from './execution/index.js';
