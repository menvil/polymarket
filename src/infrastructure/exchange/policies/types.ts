/**
 * Types для Execution Policies
 *
 * @remarks
 * Определяет типы для:
 * - Market constraints (minOrderSize, sizeTick, maxOrderSize)
 * - Normalization результаты
 * - Balance check результаты
 *
 * @module infrastructure/exchange/policies/types
 */

/**
 * Market constraints для рынка
 *
 * @remarks
 * Constraints определяют ограничения на размер ордеров.
 * Используются для:
 * - Валидации размера ордера
 * - Округления размера по sizeTick
 * - Проверки min/max limits
 */
export interface MarketConstraints {
  /** Минимальный размер ордера (USDC) */
  minOrderSize: number;
  /** Шаг округления размера (например, 0.01) */
  sizeTick: number;
  /** Максимальный размер ордера (USDC, optional) */
  maxOrderSize?: number;
  /** Timestamp когда constraints были получены */
  timestamp: number;
}

/**
 * Дефолтные constraints
 *
 * @remarks
 * Используются как fail-safe когда:
 * - API не вернул constraints
 * - Cache пуст
 * - Ошибка при получении constraints
 */
export const DEFAULT_CONSTRAINTS: Readonly<MarketConstraints> = {
  minOrderSize: 10, // 10 USDC minimum
  sizeTick: 0.01, // 0.01 USDC tick
  maxOrderSize: undefined, // No max limit
  timestamp: 0,
};

/**
 * Результат normalization размера
 *
 * @remarks
 * Содержит нормализованный размер и причину изменения.
 */
export interface NormalizedSize {
  /** Нормализованный размер */
  normalizedSize: number;
  /** Оригинальный размер */
  originalSize: number;
  /** Причина изменения (если был изменён) */
  reason?: string;
  /** Был ли размер изменён */
  wasNormalized: boolean;
}

/**
 * Результат проверки баланса
 *
 * @remarks
 * Содержит результат валидации баланса для ордера.
 */
export interface BalanceCheckResult {
  /** Прошла ли проверка */
  isValid: boolean;
  /** Требуемый баланс */
  required: number;
  /** Доступный баланс */
  available: number;
  /** Причина ошибки (если isValid = false) */
  reason?: string;
}
