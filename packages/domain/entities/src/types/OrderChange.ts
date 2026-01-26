/**
 * Типы изменений состояния Order для FSM transitions
 *
 * @remarks
 * Используется в паттерне Command для управления жизненным циклом Order.
 * Каждый тип представляет атомарное изменение состояния заявки.
 *
 * Архитектура:
 * - Public методы (accept, reject, cancel, expire, applyTrade) создают OrderChange
 * - Private метод _transition() применяет OrderChange к текущему состоянию
 * - Это позволяет централизовать валидацию и логику переходов
 *
 * @example
 * ```typescript
 * // Внутри Order.accept():
 * const change: OrderChange = { type: 'ACCEPTED' };
 * return this._transition(change);
 * ```
 */

import type { Trade } from '../Trade.js';

/**
 * Заявка принята биржей
 *
 * @remarks
 * Переход: NEW → OPEN
 * Означает что заявка прошла валидацию и размещена в orderbook.
 */
export interface OrderAccepted {
  readonly type: 'ACCEPTED';
}

/**
 * Заявка отклонена биржей
 *
 * @remarks
 * Переход: NEW → REJECTED
 * Причины: недостаточный баланс, invalid price, market closed и т.д.
 *
 * @param reason - Причина отклонения (обязательна для аудита)
 */
export interface OrderRejected {
  readonly type: 'REJECTED';
  readonly reason: string;
}

/**
 * Заявка отменена пользователем
 *
 * @remarks
 * Переход: OPEN → CANCELED
 * Причина опциональна (по умолчанию "User cancelled").
 *
 * @param reason - Причина отмены (опционально)
 */
export interface OrderCancelled {
  readonly type: 'CANCELLED';
  readonly reason?: string;
}

/**
 * Заявка истекла по времени
 *
 * @remarks
 * Переход: OPEN → EXPIRED
 * Происходит когда expiresAt < Date.now() или market закрывается.
 */
export interface OrderExpired {
  readonly type: 'EXPIRED';
}

/**
 * К заявке применена сделка (trade)
 *
 * @remarks
 * Переходы:
 * - OPEN → PARTIALLY_FILLED (если остаток > 0)
 * - OPEN или PARTIALLY_FILLED → FILLED (если остаток = 0)
 *
 * Это единственный способ fill заявки - fill всегда происходит
 * из-за trade, а не сам по себе.
 *
 * Валидация в _applyTrade():
 * 1. trade.marketId === this.marketId
 * 2. trade.tokenId === this.tokenId
 * 3. trade.side === this.side
 * 4. trade.orderId === this.id (или undefined для FIFO)
 * 5. trade.size <= remainingSize
 * 6. Нет дубликатов trade.id
 *
 * @param trade - Trade объект который заполняет эту заявку
 */
export interface TradeApplied {
  readonly type: 'TRADE_APPLIED';
  readonly trade: Trade;
}

/**
 * Union тип всех возможных изменений состояния Order
 *
 * @remarks
 * Используется как параметр для _transition() метода.
 * TypeScript discriminated union позволяет type-safe pattern matching.
 *
 * @example
 * ```typescript
 * private _transition(change: OrderChange): Result<Order, OrderValidationError> {
 *   switch (change.type) {
 *     case 'ACCEPTED': return this._handleAccepted();
 *     case 'REJECTED': return this._handleRejected(change.reason);
 *     case 'CANCELLED': return this._handleCancelled(change.reason);
 *     case 'EXPIRED': return this._handleExpired();
 *     case 'TRADE_APPLIED': return this._applyTrade(change.trade);
 *   }
 * }
 * ```
 */
export type OrderChange =
  | OrderAccepted
  | OrderRejected
  | OrderCancelled
  | OrderExpired
  | TradeApplied;
