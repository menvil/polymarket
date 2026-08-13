/**
 * Нормализатор накопленных данных исполнения WS.
 *
 * @remarks
 * Stub — placeholder до реализации UserEventsFeedService в Phase 8.
 */

/** Минимальный репозиторий для WsExecutionNormalizer */
interface IMinimalOrderRepository {
  findById(orderId: string): Promise<unknown | undefined>;
}

/**
 * Stub для WsExecutionNormalizer.
 */
export class WsExecutionNormalizer {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_orderRepository: IMinimalOrderRepository) {}
}
