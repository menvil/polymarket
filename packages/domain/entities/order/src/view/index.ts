/**
 * View layer для Order
 *
 * @remarks
 * Сериализация и десериализация Order.
 */

export { OrderViewModel } from './OrderViewModel.js';
/** Реэкспорт интерфейса summary-представления Order (см. `OrderViewModel.ts`). */
export type { OrderSummary } from './OrderViewModel.js';
export { OrderDeserializer } from './OrderDeserializer.js';
