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

// Core (публичный API)
export { Money, SupportedCurrency, MoneyInvariantViolation } from './core/index.js';

// Facade (главный публичный API)
export { MoneyService } from './facade/index.js';

// Adapters (публичный API)
export { MoneySerializer, MoneyFormatter, type MoneyJSON } from './adapters/index.js';

// Errors (публичный API)
export { MoneyErrorReason } from './errors/index.js';
