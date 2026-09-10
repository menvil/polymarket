/**
 * Сборка тестового рантайма приватного состояния.
 *
 * @remarks
 * Шина НАСТОЯЩАЯ: проверяется весь путь `IEventBus → projector → state`,
 * включая critical-подписки. Подмена шины заглушкой доказала бы работу
 * заглушки.
 */
import { EventBus, type EventBusEvent, type IEventBus } from '@polymarket/event-bus';
import { AccountStateProjector, type AccountHotStateView } from '../../src/index.js';
import { EventFactory, silentLogger } from './fixtures.js';

/** Готовый к работе приватный рантайм. */
export interface AccountRuntime {
  /** Настоящая шина canonical-событий */
  readonly bus: IEventBus;
  /** Read-only проекция приватного состояния */
  readonly view: AccountHotStateView;
  /** Запущенный проектор */
  readonly projector: AccountStateProjector;
  /** Генератор событий с управляемым временем */
  readonly events: EventFactory;
}

/**
 * Собирает шину, состояние и запущенный проектор.
 *
 * @returns Рантайм, готовый принимать события
 *
 * @example
 * ```typescript
 * const { bus, view, events } = buildRuntime();
 * await bus.publish(events.initialized({ accountId, portfolio: portfolio() }));
 * ```
 */
export function buildRuntime(): AccountRuntime {
  const bus = new EventBus(silentLogger);
  const projector = AccountStateProjector.create(bus);
  projector.start();
  return { bus, view: projector.state(), projector, events: new EventFactory() };
}

/**
 * Публикует событие и требует успеха.
 *
 * @param bus - Шина
 * @param event - Canonical событие
 * @throws {Error} Если публикация вернула `Err`
 *
 * @remarks
 * Подписки проектора critical, поэтому отвергнутая мутация приходит сюда как
 * `Err`, а не теряется в шине.
 */
export async function publishOk(bus: IEventBus, event: EventBusEvent): Promise<void> {
  const published = await bus.publish(event);
  if (!published.ok) throw new Error(`expected Ok, got ${String(published.error)}`);
}

/**
 * Публикует событие и требует отказа.
 *
 * @param bus - Шина
 * @param event - Canonical событие
 * @returns Исходная ошибка, брошенная проектором
 * @throws {Error} Если публикация неожиданно прошла успешно
 *
 * @remarks
 * Возвращается ИСХОДНАЯ ошибка инварианта, а не обёртка шины: тест проверяет
 * контракт состояния, а не механику доставки. `EventBus` кладёт её в
 * `CriticalHandlerError.context.originalError`.
 */
export async function publishErr(bus: IEventBus, event: EventBusEvent): Promise<unknown> {
  const published = await bus.publish(event);
  if (published.ok) throw new Error(`expected Err for ${event.type}, got Ok`);
  const wrapper = published.error as { context?: { originalError?: unknown } };
  return wrapper.context?.originalError ?? published.error;
}
