/**
 * Минимальный интерфейс event bus для инфраструктурного слоя.
 *
 * @remarks
 * Используется PolymarketExecutionAdapter и PolymarketRestAdapterFactory.
 * Application-layer IEventBus будет определён в @polymarket/event-bus (Phase 2).
 */

/**
 * Минимальный event bus — только publish.
 *
 * @remarks
 * `publishOrThrow` — деprecation-мост реального `@polymarket/event-bus`'s `IEventBus`
 * (Этап 6 плана миграции: `publish()` там теперь `Result`-based, `publishOrThrow()` —
 * throw-based обёртка для ещё не переведённых вызывающих, в т.ч. этого пакета). Метод
 * добавлен здесь только чтобы этот узкий локальный интерфейс продолжал структурно
 * покрывать реальный `EventBus`, который сюда передают — не подразумевает, что
 * `PolymarketExecutionAdapter` сам стал Result-aware.
 */
export interface IEventBus {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publish(envelope: any): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publishOrThrow(envelope: any): void;
}
