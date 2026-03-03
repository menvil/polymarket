/**
 * Предикаты для Order
 *
 * @remarks
 * Функции-предикаты для проверки состояния заявки.
 * Все функции чистые (pure) и возвращают boolean.
 *
 * ### Категории:
 * - Status predicates: isFilled, isOpen, isPending, etc.
 * - Fill predicates: isPartiallyFilled, isFullyFilled
 * - Terminal predicates: isTerminal, isActive
 *
 * @example
 * ```typescript
 * import { isFilled, isOpen, isPartiallyFilled } from './predicates';
 *
 * if (isFilled(order.status)) {
 *   console.log('Order completed');
 * }
 *
 * if (isPartiallyFilled(order.status, order.fill, order.size)) {
 *   const remaining = order.fill.getRemainingSize(order.size);
 *   console.log(`${remaining.value} shares remaining`);
 * }
 * ```
 */

import type { OrderStatus } from '../value-objects/OrderStatus.js';
import { isTerminal as isTerminalStatus, isActive as isActiveStatus } from '../value-objects/OrderStatus.js';
import type { OrderFill } from '../value-objects/OrderFill.js';
import type { Quantity } from '@polymarket/value-objects';

/**
 * Проверяет, полностью ли заполнена заявка
 *
 * @param status - Статус заявки
 * @returns True если статус FILLED
 *
 * @remarks
 * Заполненная заявка завершила исполнение.
 * Весь запрошенный объем был исполнен.
 *
 * @example
 * ```typescript
 * if (isFilled('FILLED')) {
 *   console.log('Order completed');
 * }
 * ```
 */
export function isFilled(status: OrderStatus): boolean {
  return status === 'FILLED';
}

/**
 * Проверяет, открыта ли заявка
 *
 * @param status - Статус заявки
 * @returns True если статус OPEN
 *
 * @remarks
 * Открытая заявка активно находится в orderbook
 * и ожидает исполнения.
 *
 * @example
 * ```typescript
 * if (isOpen('OPEN')) {
 *   console.log('Order is active in the book');
 * }
 * ```
 */
export function isOpen(status: OrderStatus): boolean {
  return status === 'OPEN';
}

/**
 * Проверяет, находится ли заявка в ожидании
 *
 * @param status - Статус заявки
 * @returns True если статус PENDING
 *
 * @remarks
 * Заявка в ожидании была отправлена, но еще не принята биржей.
 *
 * @example
 * ```typescript
 * if (isPending('PENDING')) {
 *   console.log('Order awaiting exchange acceptance');
 * }
 * ```
 */
export function isPending(status: OrderStatus): boolean {
  return status === 'PENDING';
}

/**
 * Проверяет, отменена ли заявка
 *
 * @param status - Статус заявки
 * @returns True если статус CANCELED
 *
 * @example
 * ```typescript
 * if (isCanceled('CANCELED')) {
 *   console.log('Order was cancelled');
 * }
 * ```
 */
export function isCanceled(status: OrderStatus): boolean {
  return status === 'CANCELED';
}

/**
 * Проверяет, отклонена ли заявка
 *
 * @param status - Статус заявки
 * @returns True если статус REJECTED
 *
 * @example
 * ```typescript
 * if (isRejected('REJECTED')) {
 *   console.log('Order was rejected by exchange');
 * }
 * ```
 */
export function isRejected(status: OrderStatus): boolean {
  return status === 'REJECTED';
}

/**
 * Проверяет, истекла ли заявка
 *
 * @param status - Статус заявки
 * @returns True если статус EXPIRED
 *
 * @example
 * ```typescript
 * if (isExpired('EXPIRED')) {
 *   console.log('Order expired');
 * }
 * ```
 */
export function isExpired(status: OrderStatus): boolean {
  return status === 'EXPIRED';
}

/**
 * Проверяет, частично ли заполнена заявка
 *
 * @param status - Статус заявки
 * @param fill - OrderFill объект
 * @param size - Размер заявки
 * @returns True если 0 < filledSize < size
 *
 * @remarks
 * Частично заполненная заявка имеет некоторое исполнение, но не завершена.
 * Проверяет как статус (PARTIALLY_FILLED), так и фактический fill.
 *
 * @example
 * ```typescript
 * if (isPartiallyFilled('PARTIALLY_FILLED', fill, size)) {
 *   const remaining = fill.getRemainingSize(size);
 *   console.log(`${remaining.value} shares remaining`);
 * }
 * ```
 */
export function isPartiallyFilled(
  status: OrderStatus,
  fill: OrderFill,
  size: Quantity
): boolean {
  return status === 'PARTIALLY_FILLED' && fill.isPartial(size);
}

/**
 * Проверяет, является ли статус терминальным (заявка завершена)
 *
 * @param status - Статус заявки
 * @returns True если статус терминальный
 *
 * @remarks
 * Терминальные статусы: FILLED, CANCELED, REJECTED, EXPIRED
 * Терминальная заявка больше не может изменить состояние.
 *
 * Делегирует в OrderStatus.isTerminal().
 *
 * @example
 * ```typescript
 * if (isTerminal('FILLED')) {
 *   console.log('Order is in terminal state');
 * }
 * ```
 */
export function isTerminal(status: OrderStatus): boolean {
  return isTerminalStatus(status);
}

/**
 * Проверяет, является ли заявка активной (может измениться)
 *
 * @param status - Статус заявки
 * @returns True если статус активный
 *
 * @remarks
 * Активные статусы: PENDING, OPEN, PARTIALLY_FILLED
 * Активная заявка может изменить состояние.
 *
 * Делегирует в OrderStatus.isActive().
 *
 * @example
 * ```typescript
 * if (isActive('OPEN')) {
 *   console.log('Order is active');
 * }
 * ```
 */
export function isActive(status: OrderStatus): boolean {
  return isActiveStatus(status);
}

/**
 * Проверяет, можно ли модифицировать заявку
 *
 * @param status - Статус заявки
 * @returns True если заявку можно модифицировать
 *
 * @remarks
 * Модификация возможна только для OPEN заявок.
 * PARTIALLY_FILLED заявки обычно не модифицируются (только отмена).
 *
 * @example
 * ```typescript
 * if (canModify('OPEN')) {
 *   // Показать кнопку Modify в UI
 * }
 * ```
 */
export function canModify(status: OrderStatus): boolean {
  return status === 'OPEN';
}

/**
 * Проверяет, неудачна ли заявка (rejected or canceled or expired)
 *
 * @param status - Статус заявки
 * @returns True если заявка неудачна
 *
 * @remarks
 * Неудачные заявки: REJECTED, CANCELED, EXPIRED
 * Эти заявки не были полностью исполнены.
 *
 * @example
 * ```typescript
 * if (isFailed('REJECTED')) {
 *   console.log('Order failed');
 * }
 * ```
 */
export function isFailed(status: OrderStatus): boolean {
  return status === 'REJECTED' || status === 'CANCELED' || status === 'EXPIRED';
}

/**
 * Проверяет, успешна ли заявка (filled)
 *
 * @param status - Статус заявки
 * @returns True если заявка успешно исполнена
 *
 * @remarks
 * Успешная заявка полностью исполнена (FILLED).
 *
 * @example
 * ```typescript
 * if (isSuccessful('FILLED')) {
 *   console.log('Order successfully completed');
 * }
 * ```
 */
export function isSuccessful(status: OrderStatus): boolean {
  return status === 'FILLED';
}
