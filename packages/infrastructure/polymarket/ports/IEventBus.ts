/**
 * Минимальный интерфейс event bus для инфраструктурного слоя.
 *
 * @remarks
 * Используется PolymarketExecutionAdapter и PolymarketRestAdapterFactory.
 * Application-layer IEventBus будет определён в @polymarket/event-bus (Phase 2).
 */
import type { Result } from '@polymarket/result';
import type { QueueOverflowError, CriticalHandlerError } from '@polymarket/errors/event-bus';

/**
 * Минимальный event bus — только publish.
 *
 * @remarks
 * `publishOrThrow` снят в Этапе 10d плана миграции вместе с реальным
 * `@polymarket/event-bus`'s deprecation-мостом (Этап 6) — этот узкий локальный интерфейс
 * структурно покрывал реальный `EventBus`, поэтому синхронно теряет и свой `publishOrThrow`,
 * и меняет `publish()`'s возвращаемый тип на `Promise<Result<...>>`.
 *
 * `envelope` остаётся `unknown` намеренно, НЕ сужается до `ApplicationEvent` — расследование
 * Этапа 10d обнаружило, что `PolymarketExecutionAdapter`'s реальные вызовы `publish()`
 * передают `EventEnvelope<ExecutionEvent>` (`{ event, context, timestamp }` из
 * `../events/EventEnvelope.ts`), а не голый `ApplicationEvent` — совершенно другая форма,
 * без верхнеуровневого поля `type`. Раз реальный `EventBus.publish()` матчит подписчиков по
 * `event.type`, эти события сегодня, по всей видимости, не долетают ни до одного
 * подписчика (`event.type` резолвится в `undefined`). Это существующий, независимый от
 * снятия throw-моста пробел — не вводится и не чинится в Этапе 10d, оставлен как есть.
 */
export interface IEventBus {
  publish(envelope: unknown): Promise<Result<void, QueueOverflowError | CriticalHandlerError>>;
}
