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
  constructor(private readonly _orderRepository: IMinimalOrderRepository) {}
}
