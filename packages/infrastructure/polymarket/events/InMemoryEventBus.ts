/**
 * In-memory event bus.
 *
 * @remarks
 * Stub — используется PolymarketWsAdapter до рефакторинга Phase 0.5.
 * После Phase 0.5 этот класс будет удалён.
 */
import type { ILogger } from '@polymarket/logger';

/** Подписчик на события */
type Subscriber = (event: unknown) => void;

/**
 * Минимальная in-memory реализация event bus.
 */
export class InMemoryEventBus {
  private readonly _subscribers = new Map<string, Set<Subscriber>>();

  constructor(private readonly _logger: ILogger) {}

  publish(envelope: unknown): void {
    const evt = envelope as { event?: { eventType?: string } };
    const eventType = evt?.event?.eventType;
    if (!eventType) return;
    const subs = this._subscribers.get(eventType);
    if (!subs) return;
    for (const sub of subs) {
      try {
        sub(envelope);
      } catch (err) {
        this._logger.error('[InMemoryEventBus] Subscriber error', { err: err instanceof Error ? err : new Error(String(err)) });
      }
    }
  }

  subscribe(eventType: string, subscriber: Subscriber): () => void {
    if (!this._subscribers.has(eventType)) {
      this._subscribers.set(eventType, new Set());
    }
    this._subscribers.get(eventType)!.add(subscriber);
    return () => this._subscribers.get(eventType)?.delete(subscriber);
  }
}
