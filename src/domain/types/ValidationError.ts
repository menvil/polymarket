/**
 * ValidationError - ошибки локальной валидации (ДО HTTP запроса)
 *
 * @remarks
 * Эти ошибки определяются Policy Pipeline БЕЗ обращения к бирже.
 * Они означают "я ошибся" (некорректный intent от стратегии).
 *
 * Критерий принадлежности ValidationError:
 * ✅ Может быть определена БЕЗ HTTP запроса
 * ✅ Локальные проверки (баланс, constraints, limits)
 * ✅ Быстрый fail (не отправляем HTTP)
 *
 * Источники ValidationError:
 * - MarketConstraintsPolicy (size/price constraints)
 * - BalancePolicy (insufficient funds)
 * - PositionLimitPolicy (risk limits)
 * - PriceValidator (price bounds 0.01-0.99)
 *
 * Decision Layer реакция на ValidationError:
 * - REJECTED означает "проблема со стратегией"
 * - Стратегия должна исправить intent или пропустить trade
 * - НЕ retry (проблема в intent, не во внешнем мире)
 *
 * @example
 * ```typescript
 * // Insufficient balance
 * const error: ValidationError = {
 *   type: 'INSUFFICIENT_BALANCE',
 *   code: ValidationErrorCode.INSUFFICIENT_BALANCE,
 *   required: 100,
 *   available: 50,
 *   asset: 'USDC',
 * };
 *
 * // Decision Layer обработка
 * if (error.type === 'INSUFFICIENT_BALANCE') {
 *   strategy.waitForDeposit();
 * }
 * ```
 */

/**
 * ValidationErrorCode - enum для машинной обработки
 *
 * @remarks
 * Используется для:
 * - Switch statements (exhaustive checking)
 * - Metrics/monitoring (группировка ошибок)
 * - Structured logging
 *
 * НЕ полагайтесь только на type (string), используйте code (enum).
 */
export enum ValidationErrorCode {
  /** Недостаточно средств для размещения ордера */
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',

  /** Размер ордера вне допустимого диапазона [min, max] */
  INVALID_SIZE = 'INVALID_SIZE',

  /** Цена вне допустимого диапазона [0.01, 0.99] */
  INVALID_PRICE = 'INVALID_PRICE',

  /** Превышен лимит позиции (risk management) */
  POSITION_LIMIT_EXCEEDED = 'POSITION_LIMIT_EXCEEDED',

  /** Нарушены market constraints (sizeTick, priceTick, etc.) */
  MARKET_CONSTRAINTS_VIOLATION = 'MARKET_CONSTRAINTS_VIOLATION',
}

/**
 * ValidationError - discriminated union всех validation ошибок
 *
 * @remarks
 * Каждый вариант содержит:
 * - type: строковый литерал (для discriminated union)
 * - code: enum (для машинной обработки)
 * - Дополнительные поля с контекстом ошибки
 */
export type ValidationError =
  | InsufficientBalanceError
  | InvalidSizeError
  | InvalidPriceError
  | PositionLimitExceededError
  | MarketConstraintsViolationError;

/**
 * InsufficientBalanceError - недостаточно средств
 *
 * @remarks
 * Возникает когда:
 * - BUY order: required USDC > available USDC
 * - SELL order: required tokens > available tokens
 *
 * Реакция стратегии:
 * - Подождать пополнения баланса
 * - Уменьшить размер ордера
 * - Пропустить trade
 */
export interface InsufficientBalanceError {
  /** Тип ошибки (для discriminated union) */
  type: 'INSUFFICIENT_BALANCE';

  /** Код ошибки (для machine processing) */
  code: ValidationErrorCode.INSUFFICIENT_BALANCE;

  /** Сколько нужно */
  required: number;

  /** Сколько доступно */
  available: number;

  /** Актив (USDC для BUY, TOKEN для SELL) */
  asset: 'USDC' | 'TOKEN';
}

/**
 * InvalidSizeError - размер ордера вне допустимого диапазона
 *
 * @remarks
 * Возникает когда:
 * - size < minOrderSize
 * - size > maxOrderSize
 * - size не кратен sizeTick (после нормализации)
 *
 * Реакция стратегии:
 * - Изменить размер на минимальный/максимальный
 * - Пропустить trade (если constraints слишком жёсткие)
 */
export interface InvalidSizeError {
  type: 'INVALID_SIZE';
  code: ValidationErrorCode.INVALID_SIZE;

  /** Минимальный допустимый размер */
  min: number;

  /** Максимальный допустимый размер */
  max: number;

  /** Размер который пытались отправить */
  provided: number;

  /** Token ID для контекста */
  tokenId: string;
}

/**
 * InvalidPriceError - цена вне допустимого диапазона
 *
 * @remarks
 * Возникает когда:
 * - price < 0.01
 * - price > 0.99
 * - price не кратен priceTick
 *
 * Реакция стратегии:
 * - Скорректировать цену
 * - Пропустить trade (если цена критична)
 */
export interface InvalidPriceError {
  type: 'INVALID_PRICE';
  code: ValidationErrorCode.INVALID_PRICE;

  /** Минимальная допустимая цена (обычно 0.01) */
  min: number;

  /** Максимальная допустимая цена (обычно 0.99) */
  max: number;

  /** Цена которую пытались отправить */
  provided: number;
}

/**
 * PositionLimitExceededError - превышен лимит позиции
 *
 * @remarks
 * Возникает когда:
 * - currentPosition + orderSize > positionLimit
 *
 * Это risk management constraint.
 *
 * Реакция стратегии:
 * - Пропустить trade
 * - Закрыть часть существующей позиции
 * - Переключиться на другой рынок
 */
export interface PositionLimitExceededError {
  type: 'POSITION_LIMIT_EXCEEDED';
  code: ValidationErrorCode.POSITION_LIMIT_EXCEEDED;

  /** Текущая позиция */
  current: number;

  /** Лимит позиции */
  limit: number;

  /** Token ID для контекста */
  tokenId: string;
}

/**
 * MarketConstraintsViolationError - нарушены market constraints
 *
 * @remarks
 * Возникает когда:
 * - Не удалось получить constraints для рынка
 * - Constraints недоступны (рынок закрыт, неактивен)
 * - Другие нарушения constraints
 *
 * Реакция стратегии:
 * - Пропустить trade
 * - Переключиться на другой рынок
 * - Подождать и повторить позже
 */
export interface MarketConstraintsViolationError {
  type: 'MARKET_CONSTRAINTS_VIOLATION';
  code: ValidationErrorCode.MARKET_CONSTRAINTS_VIOLATION;

  /** Описание нарушения */
  reason: string;

  /** Token ID для контекста */
  tokenId: string;
}
