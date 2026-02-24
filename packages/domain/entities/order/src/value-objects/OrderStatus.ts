/**
 * Статус заявки Order
 *
 * @remarks
 * Представляет состояние заявки в её жизненном цикле.
 * Использует discriminated union для type-safe связи статуса с причинами.
 *
 * ### Жизненный цикл:
 * ```
 * PENDING → OPEN → PARTIALLY_FILLED → FILLED
 *     ↓       ↓            ↓
 * REJECTED  CANCELED    EXPIRED
 * ```
 *
 * ### Терминальные статусы (конечные):
 * - FILLED - заявка полностью исполнена (успех)
 * - CANCELED - отменена (с типизированной причиной)
 * - REJECTED - отклонена venue (с типизированной причиной)
 * - EXPIRED - истекла (с опциональной типизированной причиной)
 *
 * ### Активные статусы (могут измениться):
 * - PENDING - ожидает принятия venue
 * - OPEN - размещена в orderbook
 * - PARTIALLY_FILLED - частично исполнена
 *
 * ### Type Safety:
 * Discriminated union гарантирует что:
 * - CANCELED всегда имеет CancelReason
 * - REJECTED всегда имеет RejectReason
 * - EXPIRED может иметь ExpireReason (optional)
 * - FILLED/OPEN/PENDING/PARTIALLY_FILLED НЕ имеют reason
 *
 * @example
 * ```typescript
 * import { OrderStatus, CancelReason, isCanceled } from './value-objects';
 *
 * // Type-safe constructors
 * const status1 = OrderStatus.open();
 * const status2 = OrderStatus.canceled(CancelReason.USER_REQUESTED);
 *
 * // Type guards с pattern matching
 * if (isCanceled(status2)) {
 *   console.log(status2.reason); // CancelReason (type-safe)
 * }
 *
 * // ❌ Compile error - невозможно создать невалидное состояние
 * const invalid = OrderStatus.open();
 * invalid.reason; // ERROR: Property 'reason' does not exist
 * ```
 */

import { CancelReason } from './CancelReason.js';
import { RejectReason } from './RejectReason.js';
import { ExpireReason } from './ExpireReason.js';

/**
 * OrderStatus - discriminated union для type-safe статусов
 *
 * @remarks
 * Каждый вариант статуса имеет поле `type` (discriminator) и опциональное поле `reason`.
 * TypeScript автоматически narrowing types при проверке `status.type`.
 */
export type OrderStatus =
  | { readonly type: 'PENDING' }
  | { readonly type: 'OPEN' }
  | { readonly type: 'PARTIALLY_FILLED' }
  | { readonly type: 'FILLED' }
  | { readonly type: 'CANCELED'; readonly reason: CancelReason }
  | { readonly type: 'REJECTED'; readonly reason: RejectReason }
  | { readonly type: 'EXPIRED'; readonly reason?: ExpireReason };

/**
 * Тип статуса (строковые литералы для backward compatibility)
 */
export type OrderStatusType = OrderStatus['type'];

/**
 * Helper constructors для создания OrderStatus
 *
 * @remarks
 * Предоставляет удобные фабрики для создания статусов.
 * Все конструкторы type-safe и гарантируют корректность.
 *
 * @example
 * ```typescript
 * const pending = OrderStatus.pending();
 * const open = OrderStatus.open();
 * const canceled = OrderStatus.canceled(CancelReason.USER_REQUESTED);
 * const rejected = OrderStatus.rejected(RejectReason.INVALID_PRICE);
 * const expired = OrderStatus.expired(); // без причины
 * const expired2 = OrderStatus.expired(ExpireReason.TIME_IN_FORCE); // с причиной
 * ```
 */
export const OrderStatus = {
  /**
   * Создать PENDING статус
   */
  pending: (): OrderStatus => ({ type: 'PENDING' }),

  /**
   * Создать OPEN статус
   */
  open: (): OrderStatus => ({ type: 'OPEN' }),

  /**
   * Создать PARTIALLY_FILLED статус
   */
  partiallyFilled: (): OrderStatus => ({ type: 'PARTIALLY_FILLED' }),

  /**
   * Создать FILLED статус
   */
  filled: (): OrderStatus => ({ type: 'FILLED' }),

  /**
   * Создать CANCELED статус с причиной
   *
   * @param reason - Типизированная причина отмены
   */
  canceled: (reason: CancelReason): OrderStatus => ({ type: 'CANCELED', reason }),

  /**
   * Создать REJECTED статус с причиной
   *
   * @param reason - Типизированная причина отклонения
   */
  rejected: (reason: RejectReason): OrderStatus => ({ type: 'REJECTED', reason }),

  /**
   * Создать EXPIRED статус с опциональной причиной
   *
   * @param reason - Опциональная типизированная причина истечения
   */
  expired: (reason?: ExpireReason): OrderStatus => ({ type: 'EXPIRED', reason }),
};

// ==================== Type Guards ====================

/**
 * Type guard для PENDING статуса
 */
export function isPending(status: OrderStatus): status is { type: 'PENDING' } {
  return status.type === 'PENDING';
}

/**
 * Type guard для OPEN статуса
 */
export function isOpen(status: OrderStatus): status is { type: 'OPEN' } {
  return status.type === 'OPEN';
}

/**
 * Type guard для PARTIALLY_FILLED статуса
 */
export function isPartiallyFilled(status: OrderStatus): status is { type: 'PARTIALLY_FILLED' } {
  return status.type === 'PARTIALLY_FILLED';
}

/**
 * Type guard для FILLED статуса
 */
export function isFilled(status: OrderStatus): status is { type: 'FILLED' } {
  return status.type === 'FILLED';
}

/**
 * Type guard для CANCELED статуса
 *
 * @remarks
 * После проверки TypeScript знает что status имеет поле reason: CancelReason
 */
export function isCanceled(status: OrderStatus): status is { type: 'CANCELED'; reason: CancelReason } {
  return status.type === 'CANCELED';
}

/**
 * Type guard для REJECTED статуса
 *
 * @remarks
 * После проверки TypeScript знает что status имеет поле reason: RejectReason
 */
export function isRejected(status: OrderStatus): status is { type: 'REJECTED'; reason: RejectReason } {
  return status.type === 'REJECTED';
}

/**
 * Type guard для EXPIRED статуса
 *
 * @remarks
 * После проверки TypeScript знает что status имеет поле reason?: ExpireReason
 */
export function isExpired(status: OrderStatus): status is { type: 'EXPIRED'; reason?: ExpireReason } {
  return status.type === 'EXPIRED';
}

// ==================== Status Categories ====================

/**
 * Список всех возможных типов статусов (строковые литералы)
 */
export const ORDER_STATUS_TYPES: readonly OrderStatusType[] = [
  'PENDING',
  'OPEN',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
] as const;

/**
 * Терминальные типы статусов (заявка завершена, не может измениться)
 */
export const TERMINAL_STATUS_TYPES: readonly OrderStatusType[] = [
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
] as const;

/**
 * Активные типы статусов (заявка может измениться)
 */
export const ACTIVE_STATUS_TYPES: readonly OrderStatusType[] = [
  'PENDING',
  'OPEN',
  'PARTIALLY_FILLED',
] as const;

/**
 * Проверяет, является ли статус терминальным
 *
 * @param status - Статус для проверки
 * @returns True если статус терминальный (заявка завершена)
 *
 * @remarks
 * Терминальные статусы означают что заявка больше не может измениться.
 * Используется для:
 * - Валидации переходов в FSM
 * - Фильтрации активных заявок
 * - UI (скрыть кнопки Cancel/Modify)
 *
 * @example
 * ```typescript
 * const filled = OrderStatus.filled();
 * console.log(isTerminal(filled));    // true
 *
 * const open = OrderStatus.open();
 * console.log(isTerminal(open));      // false
 * ```
 */
export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_STATUS_TYPES.includes(status.type);
}

/**
 * Проверяет, является ли статус активным
 *
 * @param status - Статус для проверки
 * @returns True если статус активный (заявка может измениться)
 *
 * @remarks
 * Активные заявки могут изменить состояние:
 * - PENDING → OPEN/REJECTED
 * - OPEN → PARTIALLY_FILLED/FILLED/CANCELED/EXPIRED
 * - PARTIALLY_FILLED → FILLED/CANCELED/EXPIRED
 *
 * @example
 * ```typescript
 * const open = OrderStatus.open();
 * console.log(isActive(open));        // true
 *
 * const filled = OrderStatus.filled();
 * console.log(isActive(filled));      // false
 * ```
 */
export function isActive(status: OrderStatus): boolean {
  return ACTIVE_STATUS_TYPES.includes(status.type);
}

/**
 * Проверяет, может ли заявка быть отменена
 *
 * @param status - Текущий статус заявки
 * @returns True если заявку можно отменить
 *
 * @remarks
 * Заявку можно отменить только если она:
 * - OPEN - размещена в orderbook
 * - PARTIALLY_FILLED - частично исполнена
 *
 * PENDING заявки не могут быть отменены напрямую - они должны быть
 * либо приняты (→ OPEN) либо отклонены (→ REJECTED) venue.
 *
 * Терминальные статусы не могут быть отменены.
 *
 * @example
 * ```typescript
 * const open = OrderStatus.open();
 * console.log(canCancel(open));              // true
 *
 * const partial = OrderStatus.partiallyFilled();
 * console.log(canCancel(partial));           // true
 *
 * const pending = OrderStatus.pending();
 * console.log(canCancel(pending));           // false
 * ```
 */
export function canCancel(status: OrderStatus): boolean {
  return status.type === 'OPEN' || status.type === 'PARTIALLY_FILLED';
}

/**
 * Проверяет, может ли статус перейти в другой статус
 *
 * @param from - Текущий статус
 * @param to - Целевой тип статуса
 * @returns True если переход допустим
 *
 * @remarks
 * Таблица допустимых переходов:
 *
 * | From              | To                          |
 * |-------------------|-----------------------------|
 * | PENDING           | OPEN, REJECTED              |
 * | OPEN              | PARTIALLY_FILLED, FILLED, CANCELED, EXPIRED |
 * | PARTIALLY_FILLED  | FILLED, CANCELED, EXPIRED   |
 * | FILLED            | (none - terminal)           |
 * | CANCELED          | (none - terminal)           |
 * | REJECTED          | (none - terminal)           |
 * | EXPIRED           | (none - terminal)           |
 *
 * Используется в FSM для валидации переходов.
 *
 * @example
 * ```typescript
 * const pending = OrderStatus.pending();
 * console.log(canTransition(pending, 'OPEN'));        // true
 *
 * const filled = OrderStatus.filled();
 * console.log(canTransition(filled, 'CANCELED'));     // false
 * ```
 */
export function canTransition(from: OrderStatus, to: OrderStatusType): boolean {
  // Терминальные статусы не могут переходить в другие
  if (isTerminal(from)) {
    return false;
  }

  // Таблица допустимых переходов
  const transitions: Record<OrderStatusType, OrderStatusType[]> = {
    PENDING: ['OPEN', 'REJECTED'],
    OPEN: ['PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'EXPIRED'],
    PARTIALLY_FILLED: ['FILLED', 'CANCELED', 'EXPIRED'],
    FILLED: [],
    CANCELED: [],
    REJECTED: [],
    EXPIRED: [],
  };

  return transitions[from.type].includes(to);
}

/**
 * Возвращает список возможных следующих типов статусов
 *
 * @param status - Текущий статус
 * @returns Массив возможных типов статусов для перехода
 *
 * @remarks
 * Используется для:
 * - UI (показать доступные действия)
 * - Валидации в FSM
 * - Документации и диаграмм
 *
 * @example
 * ```typescript
 * const pending = OrderStatus.pending();
 * console.log(getNextStatusTypes(pending));
 * // ['OPEN', 'REJECTED']
 *
 * const open = OrderStatus.open();
 * console.log(getNextStatusTypes(open));
 * // ['PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'EXPIRED']
 *
 * const filled = OrderStatus.filled();
 * console.log(getNextStatusTypes(filled));
 * // []
 * ```
 */
export function getNextStatusTypes(status: OrderStatus): OrderStatusType[] {
  if (isTerminal(status)) {
    return [];
  }

  const transitions: Record<OrderStatusType, OrderStatusType[]> = {
    PENDING: ['OPEN', 'REJECTED'],
    OPEN: ['PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'EXPIRED'],
    PARTIALLY_FILLED: ['FILLED', 'CANCELED', 'EXPIRED'],
    FILLED: [],
    CANCELED: [],
    REJECTED: [],
    EXPIRED: [],
  };

  return transitions[status.type];
}

/**
 * Проверяет валидность типа статуса (runtime валидация)
 *
 * @param value - Значение для проверки
 * @returns True если value является валидным OrderStatusType
 *
 * @remarks
 * Используется для:
 * - Валидации JSON данных (fromJSON)
 * - Runtime проверок при десериализации
 * - Type guards
 *
 * @example
 * ```typescript
 * console.log(isValidStatusType('OPEN'));       // true
 * console.log(isValidStatusType('INVALID'));    // false
 * console.log(isValidStatusType(null));         // false
 * ```
 */
export function isValidStatusType(value: unknown): value is OrderStatusType {
  return typeof value === 'string' && ORDER_STATUS_TYPES.includes(value as OrderStatusType);
}

/**
 * Получить строковое представление статуса для display
 *
 * @param status - Статус ордера
 * @returns Человекочитаемая строка
 *
 * @remarks
 * Включает тип статуса и причину (если есть).
 *
 * @example
 * ```typescript
 * const open = OrderStatus.open();
 * console.log(statusToString(open)); // "OPEN"
 *
 * const canceled = OrderStatus.canceled(CancelReason.USER_REQUESTED);
 * console.log(statusToString(canceled)); // "CANCELED (USER_REQUESTED)"
 * ```
 */
export function statusToString(status: OrderStatus): string {
  if (isCanceled(status)) {
    return `CANCELED (${status.reason})`;
  }
  if (isRejected(status)) {
    return `REJECTED (${status.reason})`;
  }
  if (isExpired(status)) {
    return status.reason ? `EXPIRED (${status.reason})` : 'EXPIRED';
  }
  return status.type;
}
