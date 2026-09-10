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
 * - Учёта комиссий
 * - Входной записи для Ledger layer
 *
 * @packageDocumentation
 */

export { Fill } from './Fill.js';
export type { FillParams } from './Fill.js';
/** Lightweight-контракт одного исполнения — общий для order/order-events (см. FillData.ts). */
export type { FillData } from './FillData.js';
export type { FillSnapshot } from './FillSnapshot.js';
export type { AssetDelta } from './AssetDelta.js';
export type { ExecutionMetadata, TradeStatus } from './ExecutionMetadata.js';
export {
  TERMINAL_TRADE_STATUSES,
  isTerminalTradeStatus,
  classifyTradeStatusObservation,
} from './tradeStatus.js';
export type { TradeStatusObservation } from './tradeStatus.js';
/**
 * Сравнение неизменяемых фактов исполнения (см. factIdentity.ts).
 *
 * @remarks
 * «Что делает два `Fill` одним фактом» — знание об исполнении. Сверка с
 * площадкой, приватное состояние и восстановление после разрыва задают один и
 * тот же вопрос; ответ должен быть один.
 */
export { findFillFactDifference, sameFillFact } from './factIdentity.js';
export type { FillFactDifference, FillFactField } from './factIdentity.js';
export { FillMapper } from './mappers/FillMapper.js';
export type { Liquidity } from './value-objects/Liquidity.js';
export { ALL_LIQUIDITY, isValidLiquidity } from './value-objects/Liquidity.js';
export {
  POLYMARKET_CRYPTO_TAKER_FEE_RATE,
  POLYMARKET_MIN_FEE_USDC,
  calculatePolymarketTakerFee,
  calculatePolymarketTakerFeeNumber,
  calculatePolymarketTakerFeeWithRate,
} from './polymarket-fee.js';
