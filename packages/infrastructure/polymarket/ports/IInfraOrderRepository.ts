/**
 * Инфраструктурный порт репозитория ордеров.
 *
 * @remarks
 * Минимальный интерфейс для чтения ордеров внутри инфраструктурного слоя.
 * НЕ пересекается с application IOrderRepository (из @polymarket/ports Phase 1).
 */

/**
 * Интерфейс для поиска ордеров по ID.
 */
export interface IInfraOrderRepository {
  findById(orderId: string): Promise<unknown | undefined>;
}
