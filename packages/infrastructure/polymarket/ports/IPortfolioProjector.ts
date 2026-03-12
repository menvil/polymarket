/**
 * Порт проектора портфеля.
 *
 * @remarks
 * Используется BalancePolicy для мгновенных проверок баланса без обращения к API.
 * Event-sourced — всегда актуален без задержки.
 *
 * Возвращает `totalQty` (полная позиция) и `reservedQty` (зарезервировано под открытые SELL ордера),
 * чтобы BalancePolicy могла вычислить `available = totalQty - reservedQty` без float-погрешностей.
 */

import type Decimal from 'decimal.js';

/**
 * Позиция из проектора с раздельными total/reserved количествами.
 */
export interface ProjectedPosition {
  /** Полный объём позиции (из Portfolio.positions) */
  readonly totalQty: Decimal;
  /** Объём, зарезервированный под открытые SELL ордера (из Portfolio.tokenReservations) */
  readonly reservedQty: Decimal;
}

/**
 * Интерфейс для мгновенного получения позиций из проектора.
 */
export interface IPortfolioProjector {
  /**
   * Возвращает позицию по tokenId или undefined если позиции нет.
   *
   * @param tokenId - Строковый идентификатор outcome-токена
   * @returns ProjectedPosition с totalQty и reservedQty, или undefined
   *
   * @remarks
   * Использует Decimal для точной арифметики (избегает float-погрешностей при вычитании).
   * Доступный объём для SELL: `totalQty.minus(reservedQty)`.
   */
  getPosition(tokenId: string): ProjectedPosition | undefined;
}
