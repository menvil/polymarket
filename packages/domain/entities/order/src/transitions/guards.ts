/**
 * Guards для Order FSM (Finite State Machine)
 *
 * @remarks
 * Guards - это функции-предикаты которые проверяют возможность
 * выполнения перехода состояния ПЕРЕД его применением.
 *
 * Используются для:
 * - Валидации переходов в FSM
 * - UI (показать/скрыть кнопки действий)
 * - Предварительная проверка перед вызовом методов
 *
 * ### Naming convention:
 * - `canX` - может ли заявка выполнить действие X
 * - Все guards возвращают boolean
 * - Все guards pure functions (без side effects)
 *
 * @example
 * ```typescript
 * import { canAccept, canCancel, canAcceptTrade } from './guards';
 *
 * if (canAccept(order.status)) {
 *   const result = order.accept();
 * }
 *
 * if (canCancel(order.status)) {
 *   // Показать кнопку Cancel в UI
 * }
 * ```
 */

import type { OrderStatus } from '../value-objects/OrderStatus';
import type { Quantity } from '@polymarket/value-objects';

/**
 * Проверяет, может ли заявка быть принята (accepted)
 *
 * @param status - Текущий статус заявки
 * @returns True если заявка может быть принята
 *
 * @remarks
 * Переход: PENDING → OPEN
 *
 * Заявка может быть принята только если она в статусе PENDING.
 * После accept() заявка становится видимой в orderbook.
 *
 * @example
 * ```typescript
 * console.log(canAccept('PENDING'));  // true
 * console.log(canAccept('OPEN'));     // false
 * console.log(canAccept('FILLED'));   // false
 * ```
 */
export function canAccept(status: OrderStatus): boolean {
  return status === 'PENDING';
}

/**
 * Проверяет, может ли заявка быть отклонена (rejected)
 *
 * @param status - Текущий статус заявки
 * @returns True если заявка может быть отклонена
 *
 * @remarks
 * Переход: PENDING → REJECTED
 *
 * Заявка может быть отклонена только если она в статусе PENDING.
 * После reject() заявка не попадает в orderbook.
 *
 * @example
 * ```typescript
 * console.log(canReject('PENDING'));  // true
 * console.log(canReject('OPEN'));     // false
 * ```
 */
export function canReject(status: OrderStatus): boolean {
  return status === 'PENDING';
}

/**
 * Проверяет, может ли заявка быть отменена (cancelled)
 *
 * @param status - Текущий статус заявки
 * @returns True если заявка может быть отменена
 *
 * @remarks
 * Переход: OPEN или PARTIALLY_FILLED → CANCELED
 *
 * Заявка может быть отменена только если она:
 * - OPEN - размещена в orderbook
 * - PARTIALLY_FILLED - частично исполнена
 *
 * PENDING заявки не могут быть отменены напрямую - они должны быть
 * либо приняты (→ OPEN) либо отклонены (→ REJECTED) биржей.
 *
 * Терминальные статусы не могут быть отменены.
 *
 * @example
 * ```typescript
 * console.log(canCancel('OPEN'));              // true
 * console.log(canCancel('PARTIALLY_FILLED'));  // true
 * console.log(canCancel('PENDING'));           // false
 * console.log(canCancel('FILLED'));            // false
 * ```
 */
export function canCancel(status: OrderStatus): boolean {
  return status === 'OPEN' || status === 'PARTIALLY_FILLED';
}

/**
 * Проверяет, может ли заявка истечь (expire)
 *
 * @param status - Текущий статус заявки
 * @returns True если заявка может истечь
 *
 * @remarks
 * Переход: OPEN или PARTIALLY_FILLED → EXPIRED
 *
 * Заявка может истечь если она активна в orderbook:
 * - OPEN - размещена в orderbook
 * - PARTIALLY_FILLED - частично исполнена
 *
 * @example
 * ```typescript
 * console.log(canExpire('OPEN'));              // true
 * console.log(canExpire('PARTIALLY_FILLED'));  // true
 * console.log(canExpire('PENDING'));           // false
 * console.log(canExpire('FILLED'));            // false
 * ```
 */
export function canExpire(status: OrderStatus): boolean {
  return status === 'OPEN' || status === 'PARTIALLY_FILLED';
}

/**
 * Проверяет, может ли заявка принять trade (быть исполненной)
 *
 * @param status - Текущий статус заявки
 * @returns True если заявка может принять trade
 *
 * @remarks
 * Переходы:
 * - OPEN → PARTIALLY_FILLED (если остаток > 0)
 * - OPEN или PARTIALLY_FILLED → FILLED (если остаток = 0)
 *
 * Заявка может быть исполнена только если она активна в orderbook:
 * - OPEN - размещена в orderbook
 * - PARTIALLY_FILLED - частично исполнена
 *
 * @example
 * ```typescript
 * console.log(canApplyTrade('OPEN'));              // true
 * console.log(canApplyTrade('PARTIALLY_FILLED'));  // true
 * console.log(canApplyTrade('PENDING'));           // false
 * console.log(canApplyTrade('FILLED'));            // false
 * ```
 */
export function canApplyTrade(status: OrderStatus): boolean {
  return status === 'OPEN' || status === 'PARTIALLY_FILLED';
}

/**
 * Параметры для детальной проверки trade
 */
export interface TradeValidationParams {
  /** Текущий статус заявки */
  orderStatus: OrderStatus;
  /** Market ID заявки */
  orderMarketId: string;
  /** Token ID заявки */
  orderTokenId: string;
  /** Сторона заявки (BUY/SELL) */
  orderSide: string;
  /** ID заявки */
  orderId: string;
  /** Оставшийся размер для заполнения */
  remainingSize: Quantity;
  /** IDs уже примененных trades */
  existingTradeIds: readonly string[];
  /** Market ID trade */
  tradeMarketId: string;
  /** Token ID trade */
  tradeTokenId: string;
  /** Сторона trade */
  tradeSide: string;
  /** Order ID в trade (может быть undefined) */
  tradeOrderId: string | undefined;
  /** Размер trade */
  tradeSize: Quantity;
  /** ID trade */
  tradeId: string;
}

/**
 * Детальная проверка возможности применения конкретного trade
 *
 * @param params - Параметры для валидации
 * @returns True если trade может быть применен
 *
 * @remarks
 * Проверяет все условия для применения trade:
 * 1. Статус OPEN или PARTIALLY_FILLED
 * 2. trade.marketId === order.marketId
 * 3. trade.tokenId === order.tokenId
 * 4. trade.side === order.side
 * 5. trade.orderId === order.id (или undefined)
 * 6. trade.size <= remainingSize
 * 7. Нет дубликата trade.id
 *
 * Используется для предварительной фильтрации trades
 * перед вызовом applyTrade().
 *
 * @example
 * ```typescript
 * const canAccept = canAcceptTradeDetailed({
 *   orderStatus: 'OPEN',
 *   orderMarketId: 'market-1',
 *   orderTokenId: 'token-yes',
 *   orderSide: 'BUY',
 *   orderId: 'order-123',
 *   remainingSize: Quantity(70),
 *   existingTradeIds: ['trade-1'],
 *   tradeMarketId: 'market-1',
 *   tradeTokenId: 'token-yes',
 *   tradeSide: 'BUY',
 *   tradeOrderId: 'order-123',
 *   tradeSize: Quantity(30),
 *   tradeId: 'trade-2'
 * });
 * console.log(canAccept); // true
 * ```
 */
export function canAcceptTradeDetailed(params: TradeValidationParams): boolean {
  // 1. Статус должен быть OPEN или PARTIALLY_FILLED
  if (!canApplyTrade(params.orderStatus)) {
    return false;
  }

  // 2. marketId должен совпадать
  if (params.tradeMarketId !== params.orderMarketId) {
    return false;
  }

  // 3. tokenId должен совпадать
  if (params.tradeTokenId !== params.orderTokenId) {
    return false;
  }

  // 4. side должна совпадать
  if (params.tradeSide !== params.orderSide) {
    return false;
  }

  // 5. orderId должен совпадать (или быть undefined для FIFO)
  if (params.tradeOrderId !== undefined && params.tradeOrderId !== params.orderId) {
    return false;
  }

  // 6. size не должен превышать remainingSize
  if (params.tradeSize.isGreaterThan(params.remainingSize)) {
    return false;
  }

  // 7. Нет дубликата trade.id
  if (params.existingTradeIds.includes(params.tradeId)) {
    return false;
  }

  return true;
}

/**
 * Проверяет, требует ли переход указания причины (reason)
 *
 * @param targetStatus - Целевой статус перехода
 * @returns True если требуется reason
 *
 * @remarks
 * Некоторые переходы требуют обязательного указания причины:
 * - REJECTED - почему биржа отклонила
 * - CANCELED - почему пользователь отменил (опционально)
 * - EXPIRED - автоматически "Expired"
 *
 * @example
 * ```typescript
 * console.log(requiresReason('REJECTED'));  // true
 * console.log(requiresReason('CANCELED'));  // false (опционально)
 * console.log(requiresReason('OPEN'));      // false
 * ```
 */
export function requiresReason(targetStatus: OrderStatus): boolean {
  return targetStatus === 'REJECTED';
}
