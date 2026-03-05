/**
 * ExecutionMetadata — инфраструктурные метаданные исполнения ордера
 *
 * @remarks
 * Содержит данные, которые относятся к инфраструктурному/контекстному уровню,
 * а НЕ к доменной экономике исполнения.
 *
 * ### Почему вынесено из Fill:
 * Fill — это чистая доменная запись экономического факта исполнения:
 * orderId, цена, объём, сторона, комиссия.
 *
 * ExecutionMetadata содержит данные, нужные для:
 * - Сшивки Fill с рыночным принтом (Trade entity): `venueTradeId`
 * - Аналитики комиссий и routing: `liquidity`
 *
 * Эти данные опциональны и не влияют на расчёт позиций/PnL.
 *
 * ### Хранение:
 * FillMapper.toSnapshot() принимает опциональный ExecutionMetadata
 * и сериализует его в FillSnapshot (поля liquidity, venueTradeId).
 * FillMapper.fromSnapshot() восстанавливает ExecutionMetadata вместе с Fill.
 *
 * @example
 * ```typescript
 * const result = FillMapper.fromPolymarketOrderExecutionEvent(rawEvent);
 * if (result.ok) {
 *   const { fill, metadata } = result.value;
 *   console.log(fill.getCashFlow()); // экономика
 *   if (metadata.liquidity === 'MAKER') {
 *     applyMakerRebate(fill);         // инфраструктурная логика
 *   }
 * }
 * ```
 */

import type { VenueTradeId } from '@polymarket/ids';
import type { Liquidity } from './value-objects/Liquidity.js';

/**
 * Инфраструктурные метаданные события исполнения ордера
 *
 * @remarks
 * Оба поля опциональны: venue может не предоставлять эти данные.
 */
export interface ExecutionMetadata {
  /** ID трейда на venue — опциональная сшивка с Trade entity через ExecutionLinker */
  readonly venueTradeId?: VenueTradeId;
  /** Тип ликвидности исполнения (MAKER/TAKER) — для аналитики комиссий */
  readonly liquidity?: Liquidity;
}
