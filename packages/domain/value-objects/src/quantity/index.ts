// Core (только TYPE, без runtime-экспорта класса)
// КРИТИЧНО: экспортируем только тип, чтобы нельзя было вызвать Quantity.of() напрямую
// и обойти QuantityService (Result-first архитектура)
export type { Quantity } from './core/index.js';

// Facade (единственная точка входа для операций)
export { QuantityService } from './facade/index.js';

// Adapters (сериализация и форматирование)
export {
  QuantitySerializer,
  QuantityLossySerializer,
  QuantityFormatter
} from './adapters/index.js';

// Rules, Policy, и QuantityInvariantViolation НЕ экспортируются —
// это internal implementation details. Всё должно идти через QuantityService.
