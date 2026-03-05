/**
 * DomainError - базовый класс для доменных ошибок
 *
 * @remarks
 * Представляет ожидаемые нарушения бизнес-правил и инвариантов домена.
 *
 * Иерархия:
 * ```
 * Error
 *   └── TradingError        — все ошибки торговой системы
 *         └── DomainError   — доменные ошибки (ожидаемые)
 *               └── OrderError, PositionError, ...
 * ```
 *
 * Отличие от TradingError:
 * - Семантически маркирует ошибки слоя домена (не инфраструктуры)
 * - Позволяет единый перехват: `if (error instanceof DomainError)`
 * - Severity остаётся 'medium' (доменные ошибки — ожидаемые, не критичные)
 *
 * @example
 * ```typescript
 * // Создание доменной ошибки конкретного aggregate
 * export class OrderError extends DomainError {}
 * export class PositionError extends DomainError {}
 *
 * // Перехват всех доменных ошибок в application layer
 * try {
 *   const result = order.accept();
 * } catch (e) {
 *   if (e instanceof DomainError) {
 *     // Известная доменная ошибка — обработать gracefully
 *     return { ok: false, error: e.message };
 *   }
 *   throw e; // Неизвестная ошибка — пробросить
 * }
 * ```
 */
import { TradingError } from './TradingError.js';

export class DomainError extends TradingError {}
