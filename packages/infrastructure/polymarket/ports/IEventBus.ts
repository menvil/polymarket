/**
 * Минимальный интерфейс event bus для инфраструктурного слоя.
 *
 * @remarks
 * Используется PolymarketExecutionAdapter и PolymarketRestAdapterFactory.
 * Application-layer IEventBus будет определён в @polymarket/event-bus (Phase 2).
 */

/**
 * Минимальный event bus — только publish.
 */
export interface IEventBus {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publish(envelope: any): void;
}
