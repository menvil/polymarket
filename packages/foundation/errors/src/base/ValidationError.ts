/**
 * ValidationError - ошибка валидации данных
 *
 * @remarks
 * Выбрасывается когда данные не проходят валидацию (некорректный ввод, неверный формат и т.д.).
 * Уровень серьезности: low (незначительная проблема, пользователь может исправить).
 *
 * Примеры использования см. в документации {@link TradingError}
 */

import { TradingError } from './TradingError.js';
import { ErrorSeverity } from './ITradingError.js';

/**
 * ValidationError - ошибка валидации
 *
 * @remarks
 * Уровень серьезности: low (незначительная)
 */
export class ValidationError extends TradingError {
  public readonly severity: ErrorSeverity = 'low';
}
