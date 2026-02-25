/**
 * @polymarket/fill - Fill entity (order execution)
 *
 * @remarks
 * Экспортирует Fill entity и связанные типы.
 *
 * Fill представляет исполнение нашего ордера на торговой площадке.
 *
 * Используется для:
 * - Расчёта позиций (position tracking)
 * - Расчёта PnL
 * - Учёта комиссий (maker/taker)
 * - Аллокации по стратегиям
 *
 * @packageDocumentation
 */

export { Fill } from './Fill.js';
export type { FillParams } from './Fill.js';
export type { FillSnapshot } from './FillSnapshot.js';
export { FillMapper } from './mappers/FillMapper.js';
export type { Liquidity } from './value-objects/Liquidity.js';
export { ALL_LIQUIDITY, isValidLiquidity } from './value-objects/Liquidity.js';
