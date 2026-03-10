/**
 * Money Value Object Module
 *
 * @remarks
 * Экспортирует Money value object и MoneyService для безопасной работы с денежными суммами.
 *
 * ## Архитектура
 * - Core (Money) - бросает исключения при нарушении инвариантов
 * - Facade (MoneyService) - возвращает Result для безопасной обработки
 *
 * ## Публичный API
 */
export { Money, SupportedCurrency, MoneyInvariantViolation } from './core/index.js';
export { MoneyService } from './facade/index.js';
export { MoneySerializer, MoneyFormatter, type MoneyJSON } from './adapters/index.js';
export { MoneyErrorReason } from './errors/index.js';
export { ValidateDivisorForMoneyDivision, ValidateFactorForMoneyMultiplication, ValidateDeltaForIncreaseBy } from './rules/index.js';
//# sourceMappingURL=index.d.ts.map