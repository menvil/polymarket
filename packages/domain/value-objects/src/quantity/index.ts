export { Quantity, QuantityInvariantViolation } from './core/index.js';

// Facade (единственная точка входа для операций)
export { QuantityService } from './facade/index.js';

// Adapters (сериализация и форматирование)
export {
  QuantitySerializer,
  QuantityLossySerializer,
  QuantityFormatter
} from './adapters/index.js';

// Rules и QuantityInvariantViolation НЕ экспортируются —
// это internal implementation details. Всё должно идти через QuantityService.
