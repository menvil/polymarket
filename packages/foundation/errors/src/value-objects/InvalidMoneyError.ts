/**
 * InvalidMoneyError - ошибка валидации денежной суммы
 *
 * @remarks
 * Выбрасывается когда денежная сумма имеет некорректное значение:
 * - Отрицательная сумма (когда требуется неотрицательная)
 * - NaN (не число)
 * - Infinity или -Infinity
 * - Некорректная валюта (пустая строка, null, undefined)
 *
 * Используется в value object Money для валидации amount и currency.
 * Уровень серьезности: low (проблемы валидации данных не критичны).
 *
 * @example
 * ```typescript
 * import { InvalidMoneyError } from '@polymarket/errors';
 *
 * // Статическое сообщение
 * throw new InvalidMoneyError('Amount cannot be negative');
 *
 * // С кодом и контекстом (рекомендуется)
 * throw new InvalidMoneyError('Invalid money amount', {
 *   code: InvalidMoneyError.code,
 *   context: { amount: -100, currency: 'USDC' }
 * });
 *
 * // Динамическое сообщение из контекста
 * throw new InvalidMoneyError(
 *   (ctx) => `Invalid money amount ${ctx.amount} ${ctx.currency}: must be non-negative`,
 *   {
 *     code: InvalidMoneyError.code,
 *     context: { amount: -100, currency: 'USDC' }
 *   }
 * );
 * // "Invalid money amount -100 USDC: must be non-negative"
 *
 * // С обработкой NaN
 * throw new InvalidMoneyError(
 *   (ctx) => {
 *     if (Number.isNaN(ctx.amount)) return `Amount must be a valid number`;
 *     if (!Number.isFinite(ctx.amount)) return `Amount must be finite`;
 *     return `Invalid amount ${ctx.amount}`;
 *   },
 *   {
 *     code: InvalidMoneyError.code,
 *     context: { amount: NaN, currency: 'USDC' }
 *   }
 * );
 * // "Amount must be a valid number"
 * ```
 */

import { TradingError, ErrorSeverity } from '../base';

/**
 * InvalidMoneyError - ошибка валидации денежной суммы
 *
 * @remarks
 * Уровень серьезности: low (незначительная)
 * Рекомендуемый код ошибки: INVALID_MONEY
 */
export class InvalidMoneyError extends TradingError {
  public readonly severity: ErrorSeverity = 'low';

  /**
   * Рекомендуемый код ошибки
   */
  public static readonly code = 'INVALID_MONEY';
}