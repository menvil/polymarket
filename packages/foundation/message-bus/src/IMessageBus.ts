/**
 * Generic-порт in-process message bus.
 *
 * @remarks
 * Контракт доставки типизированных сообщений: очередь FIFO, параллельный fan-out
 * подписчиков одного сообщения, Result-based operational-ошибки, lifecycle
 * (`drain`/`close`) и диагностика (`getStats`). Реализация: {@link MessageBus}.
 *
 * Порт generic по `TMessage extends TypedMessage` — от сообщения требуется только
 * строковый discriminator `type`; структура остальных полей (flat или envelope)
 * прозрачна для bus.
 */
import type { Result } from '@polymarket/result';
import type { TypedMessage } from './TypedMessage.js';
import type { MessageHandler } from './MessageHandler.js';
import type { MessageBusStats } from './MessageBusStats.js';
import type { MessageBusDrainError, MessageBusPublishError } from './errors.js';

/**
 * Порт message bus.
 *
 * @typeParam TMessage - Discriminated union сообщений данного контура
 */
export interface IMessageBus<TMessage extends TypedMessage> {
  /**
   * Публикует одно сообщение.
   *
   * @param message - Сообщение для доставки
   * @returns `Ok(void)` при успехе; `Err(MessageBusClosedError)` после `close()`;
   *   `Err(MessageBusOverflowError)` при переполнении очереди; терминальные ошибки
   *   drain (`MessageBusCriticalHandlerError`/`MessageBusDrainLimitError`) — если
   *   вызов стал владельцем drain
   *
   * @remarks
   * Если drain уже активен (в том числе при reentrant-вызове из обработчика),
   * `Ok` подтверждает УСПЕШНУЮ ПОСТАНОВКУ В ОЧЕРЕДЬ, а не завершение обработки
   * сообщения — оно будет доставлено текущим drain позже.
   */
  publish(message: TMessage): Promise<Result<void, MessageBusPublishError>>;

  /**
   * Публикует список сообщений с сохранением порядка.
   *
   * @param messages - Сообщения (порядок массива = порядок доставки)
   * @returns См. {@link IMessageBus.publish}; пустой массив → `Ok(void)`
   *
   * @remarks
   * Enqueue batch атомарен: не влезающий в лимит batch отклоняется целиком
   * (all or nothing), существующая очередь не затрагивается.
   */
  publishAll(messages: readonly TMessage[]): Promise<Result<void, MessageBusPublishError>>;

  /**
   * Подписывается на сообщения конкретного типа.
   *
   * @param type - Discriminator сообщения
   * @param handler - Обработчик (sync или async) — получает суженный член union
   * @param options - Опции подписки
   * @param options.critical - `true`: падение обработчика останавливает drain и
   *   возвращается caller'у как `Err(MessageBusCriticalHandlerError)`; по умолчанию
   *   `false`: падение сообщается observer'у и не влияет на доставку
   * @returns Функция отписки (идемпотентна)
   */
  subscribe<K extends TMessage['type']>(
    type: K,
    handler: MessageHandler<Extract<TMessage, { type: K }>>,
    options?: { critical?: boolean },
  ): () => void;

  /**
   * Дообрабатывает ожидающую очередь (lifecycle API).
   *
   * @returns `Ok(void)` если очередь пуста/обработана; `Err` — терминальный исход drain
   *
   * @remarks
   * Если drain уже активен — дожидается СУЩЕСТВУЮЩЕГО drain (второй не запускается)
   * и возвращает его Result. Нельзя await-ить из обработчика этого же bus:
   * обработчик — часть drain, такой вызов создаст self-deadlock.
   */
  drain(): Promise<Result<void, MessageBusDrainError>>;

  /**
   * Закрывает bus для новых публикаций и дообрабатывает существующую очередь.
   *
   * @returns Result финального drain (см. {@link IMessageBus.drain})
   *
   * @remarks
   * Идемпотентен. После close: `publish`/`publishAll` → `Err(MessageBusClosedError)`;
   * `drain()` и изменение подписок остаются доступными (восстановление после
   * critical-сбоя). Нельзя await-ить из обработчика этого же bus.
   */
  close(): Promise<Result<void, MessageBusDrainError>>;

  /**
   * Возвращает диагностический снимок состояния.
   *
   * @returns Текущие counters и флаги (см. {@link MessageBusStats})
   */
  getStats(): MessageBusStats;
}
