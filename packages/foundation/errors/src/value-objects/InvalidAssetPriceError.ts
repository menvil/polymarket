/**
 * InvalidAssetPriceError - ошибка валидации референсной цены актива.
 *
 * @remarks
 * Выбрасывается когда референсная цена (BTC/USD, ETH/USD, ...) имеет
 * некорректное значение:
 * - NaN (не число)
 * - Infinity или -Infinity
 * - Некорректный формат при парсинге десятичной строки
 * - Неположительное значение (цена актива обязана быть > 0)
 *
 * Отличается от {@link InvalidPriceError} доменом значения: `Price` —
 * цена outcome-токена рынка предсказаний в диапазоне `[0.0001, 0.9999]`,
 * `AssetPrice` — цена внешнего актива без верхней границы
 * (`79341.36626633028`). Смешение этих ошибок скрыло бы ровно то различие,
 * ради которого заведён отдельный VO.
 *
 * Уровень серьёзности: low (проблемы валидации данных не критичны).
 *
 * @example
 * ```typescript
 * import { InvalidAssetPriceError } from '@polymarket/errors';
 *
 * // Статическое сообщение
 * throw new InvalidAssetPriceError('Reference price must be positive');
 *
 * // С типизированной причиной ошибки
 * throw new InvalidAssetPriceError('Reference price must be positive', {
 *   context: {
 *     reason: 'NOT_POSITIVE',
 *     op: 'create',
 *   },
 * });
 * ```
 */

import { TradingError, ErrorSeverity } from '../base/index.js';

/**
 * InvalidAssetPriceError - ошибка валидации референсной цены актива.
 *
 * @remarks
 * Уровень серьезности: low (незначительная)
 * Рекомендуемый код ошибки: INVALID_REFERENCE_PRICE
 */
export class InvalidAssetPriceError extends TradingError {
  public readonly severity: ErrorSeverity = 'low';

  /**
   * Рекомендуемый код ошибки
   */
  public static readonly code = 'INVALID_REFERENCE_PRICE';
}
