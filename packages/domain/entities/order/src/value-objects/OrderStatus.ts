/**
 * Статус заявки Order
 *
 * @remarks
 * Представляет состояние заявки в её жизненном цикле.
 * Используется как простой строковый union type.
 *
 * ### Жизненный цикл:
 * ```
 * PENDING → OPEN → PARTIALLY_FILLED → FILLED
 *     ↓       ↓            ↓
 * REJECTED  CANCELED    EXPIRED
 * ```
 *
 * ### Терминальные статусы:
 * - FILLED, CANCELED, REJECTED, EXPIRED — заявка завершена
 *
 * ### Активные статусы:
 * - PENDING, OPEN, PARTIALLY_FILLED — заявка может измениться
 *
 * @example
 * ```typescript
 * import type { OrderStatus } from './value-objects/OrderStatus';
 *
 * const status: OrderStatus = 'PENDING';
 *
 * if (isPending(status)) {
 *   console.log('Order is pending');
 * }
 * ```
 */

/**
 * OrderStatus — строковый union type для статусов заявки
 */
export type OrderStatus =
  | 'PENDING'
  | 'OPEN'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELED'
  | 'REJECTED'
  | 'EXPIRED';

/**
 * Тип статуса — псевдоним для OrderStatus
 */
export type OrderStatusType = OrderStatus;

/**
 * Список всех возможных статусов
 */
export const ORDER_STATUS_TYPES: readonly OrderStatus[] = [
  'PENDING',
  'OPEN',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
] as const;

/**
 * Терминальные статусы (заявка завершена)
 */
export const TERMINAL_STATUS_TYPES: readonly OrderStatus[] = [
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
] as const;

/**
 * Активные статусы (заявка может измениться)
 */
export const ACTIVE_STATUS_TYPES: readonly OrderStatus[] = [
  'PENDING',
  'OPEN',
  'PARTIALLY_FILLED',
] as const;

// ==================== Type Guards ====================

/** Проверяет PENDING статус */
export function isPending(status: OrderStatus): boolean {
  return status === 'PENDING';
}

/** Проверяет OPEN статус */
export function isOpen(status: OrderStatus): boolean {
  return status === 'OPEN';
}

/** Проверяет PARTIALLY_FILLED статус */
export function isPartiallyFilled(status: OrderStatus): boolean {
  return status === 'PARTIALLY_FILLED';
}

/** Проверяет FILLED статус */
export function isFilled(status: OrderStatus): boolean {
  return status === 'FILLED';
}

/** Проверяет CANCELED статус */
export function isCanceled(status: OrderStatus): boolean {
  return status === 'CANCELED';
}

/** Проверяет REJECTED статус */
export function isRejected(status: OrderStatus): boolean {
  return status === 'REJECTED';
}

/** Проверяет EXPIRED статус */
export function isExpired(status: OrderStatus): boolean {
  return status === 'EXPIRED';
}

/**
 * Проверяет, является ли статус терминальным
 *
 * @param status - Статус для проверки
 * @returns True если статус терминальный
 */
export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_STATUS_TYPES.includes(status);
}

/**
 * Проверяет, является ли статус активным
 *
 * @param status - Статус для проверки
 * @returns True если статус активный
 */
export function isActive(status: OrderStatus): boolean {
  return ACTIVE_STATUS_TYPES.includes(status);
}

/**
 * Проверяет, может ли заявка быть отменена
 *
 * @param status - Текущий статус заявки
 * @returns True если заявку можно отменить
 */
export function canCancel(status: OrderStatus): boolean {
  return status === 'OPEN' || status === 'PARTIALLY_FILLED';
}

/**
 * Проверяет, может ли статус перейти в другой статус
 *
 * @param from - Текущий статус
 * @param to - Целевой тип статуса
 * @returns True если переход допустим
 */
export function canTransition(from: OrderStatus, to: OrderStatusType): boolean {
  if (isTerminal(from)) {
    return false;
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

  return transitions[from].includes(to);
}

/**
 * Возвращает список возможных следующих статусов
 *
 * @param status - Текущий статус
 * @returns Массив возможных типов статусов для перехода
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

  return transitions[status];
}

/**
 * Проверяет валидность типа статуса (runtime валидация)
 *
 * @param value - Значение для проверки
 * @returns True если value является валидным OrderStatus
 */
export function isValidStatusType(value: unknown): value is OrderStatus {
  return typeof value === 'string' && ORDER_STATUS_TYPES.includes(value as OrderStatus);
}

/**
 * Возвращает строковое представление статуса
 *
 * @param status - Статус ордера
 * @returns Строка статуса
 */
export function statusToString(status: OrderStatus): string {
  return status;
}

// ==================== Constructors (для обратной совместимости) ====================

/**
 * Фабрики для создания OrderStatus значений
 *
 * @remarks
 * Предоставляет удобные конструкторы для создания статусов.
 *
 * @example
 * ```typescript
 * const status = OrderStatusConstructors.pending(); // 'PENDING'
 * const canceled = OrderStatusConstructors.canceled(); // 'CANCELED'
 * ```
 */
export const OrderStatusConstructors = {
  pending: (): OrderStatus => 'PENDING',
  open: (): OrderStatus => 'OPEN',
  partiallyFilled: (): OrderStatus => 'PARTIALLY_FILLED',
  filled: (): OrderStatus => 'FILLED',
  canceled: (_reason?: unknown): OrderStatus => 'CANCELED',
  rejected: (_reason?: unknown): OrderStatus => 'REJECTED',
  expired: (_reason?: unknown): OrderStatus => 'EXPIRED',
};
