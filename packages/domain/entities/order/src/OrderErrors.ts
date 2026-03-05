/**
 * Доменные ошибки Order
 *
 * @remarks
 * OrderError — единственный тип ошибки агрегата Order.
 * Все команды (accept, reject, cancel, expire, applyFill) и фабрики
 * (create, rehydrate) возвращают Result<Order, OrderError> вместо броска.
 *
 * Иерархия:
 * ```
 * Error → TradingError → DomainError → OrderError
 * ```
 *
 * DomainError позволяет application-слою перехватывать все доменные ошибки
 * единым проверкой: `if (error instanceof DomainError)`.
 */

import { DomainError } from '@polymarket/errors';

/**
 * Ошибка агрегата Order
 *
 * @remarks
 * Используется для всех нарушений инвариантов и невалидных переходов состояний:
 * - Невалидный статус-переход (например, accept() на не-PENDING)
 * - Превышение remainingSize при fill
 * - Дубликат fill ID
 * - Некорректное состояние при rehydrate()
 *
 * @example
 * ```typescript
 * const result = order.accept();
 * if (!result.ok) {
 *   console.error(result.error.message);
 *   console.error(result.error.context); // { orderId: '...' }
 * }
 * ```
 */
export class OrderError extends DomainError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, { context });
  }
}
