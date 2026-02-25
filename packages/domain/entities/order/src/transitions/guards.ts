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
 * import { canAccept, canCancel, canApplyFill } from './guards';
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
 * Проверяет, может ли заявка принять fill исполнения
 *
 * @param status - Текущий статус заявки
 * @returns True если заявка может принять fill
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
 * console.log(canApplyFill('OPEN'));              // true
 * console.log(canApplyFill('PARTIALLY_FILLED'));  // true
 * console.log(canApplyFill('PENDING'));           // false
 * console.log(canApplyFill('FILLED'));            // false
 * ```
 */
export function canApplyFill(status: OrderStatus): boolean {
  return status === 'OPEN' || status === 'PARTIALLY_FILLED';
}

/**
 * Параметры для детальной проверки fill
 */
export interface FillValidationParams {
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
  /** IDs уже примененных fills */
  existingFillIds: readonly string[];
  /** Market ID fill */
  fillMarketId: string;
  /** Token ID fill */
  fillTokenId: string;
  /** Сторона fill */
  fillSide: string;
  /** Order ID в fill — ОБЯЗАТЕЛЕН (Fill.orderId всегда присутствует) */
  fillOrderId: string;
  /** Размер fill */
  fillSize: Quantity;
  /** ID fill */
  fillId: string;
}

/**
 * Детальная проверка возможности применения конкретного fill
 *
 * @param params - Параметры для валидации
 * @returns True если fill может быть применен
 *
 * @remarks
 * Проверяет все условия для применения fill:
 * 1. Статус OPEN или PARTIALLY_FILLED
 * 2. fill.marketId === order.marketId
 * 3. fill.tokenId === order.tokenId
 * 4. fill.side === order.side
 * 5. fill.orderId === order.id (orderId в Fill всегда обязателен)
 * 6. fill.size <= remainingSize
 * 7. Нет дубликата fill.id
 *
 * Используется для предварительной фильтрации fills
 * перед вызовом applyFill().
 *
 * @example
 * ```typescript
 * const canAccept = canAcceptFillDetailed({
 *   orderStatus: 'OPEN',
 *   orderMarketId: 'market-1',
 *   orderTokenId: 'token-yes',
 *   orderSide: 'BUY',
 *   orderId: 'order-123',
 *   remainingSize: Quantity(70),
 *   existingFillIds: ['fill-1'],
 *   fillMarketId: 'market-1',
 *   fillTokenId: 'token-yes',
 *   fillSide: 'BUY',
 *   fillOrderId: 'order-123',
 *   fillSize: Quantity(30),
 *   fillId: 'fill-2'
 * });
 * console.log(canAccept); // true
 * ```
 */
export function canAcceptFillDetailed(params: FillValidationParams): boolean {
  // 1. Статус должен быть OPEN или PARTIALLY_FILLED
  if (!canApplyFill(params.orderStatus)) {
    return false;
  }

  // 2. marketId должен совпадать
  if (params.fillMarketId !== params.orderMarketId) {
    return false;
  }

  // 3. tokenId должен совпадать
  if (params.fillTokenId !== params.orderTokenId) {
    return false;
  }

  // 4. side должна совпадать
  if (params.fillSide !== params.orderSide) {
    return false;
  }

  // 5. orderId должен совпадать (Fill.orderId всегда обязателен)
  if (params.fillOrderId !== params.orderId) {
    return false;
  }

  // 6. size не должен превышать remainingSize
  if (params.fillSize.isGreaterThan(params.remainingSize)) {
    return false;
  }

  // 7. Нет дубликата fill.id
  if (params.existingFillIds.includes(params.fillId)) {
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
