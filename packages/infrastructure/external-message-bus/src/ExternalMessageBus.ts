/**
 * ExternalMessageBus — Infrastructure-фасад над generic `MessageBus<TMessage>`.
 *
 * @remarks
 * ### Архитектура после M-004
 *
 * ```text
 *                      MessageBus<T>            ← ОДИН delivery engine
 *                     /             \
 *        Application EventBus     ExternalMessageBus (этот класс)
 *                 │                        │
 *          EventBusEvent             ExternalMessage
 *                 │                        │
 *        semantic internal           source-native
 *             events                 observations
 * ```
 *
 * Оба контура используют ОДИН движок доставки (`@polymarket/message-bus`);
 * различается только semantic meaning того, что по ним ходит.
 *
 * ### Композиция, не наследование
 *
 * `ExternalMessageBus` **HAS** `MessageBus`, а не **IS** `MessageBus`:
 * наследование сделало бы внутренние детали движка (protected-состояние,
 * порядок drain, устройство очереди) частью контракта внешнего контура и
 * позволило бы фасаду частично переопределить delivery-семантику. Композиция
 * оставляет ровно один владелец механики доставки.
 *
 * Собственной очереди, fan-out, reentrancy-логики, critical-обработки, drain,
 * close, stats и overflow-защиты у этого класса НЕТ — всё делегируется
 * `MessageBus`.
 */
import type { Result } from '@polymarket/result';
import { MessageBus } from '@polymarket/message-bus';
import type {
  MessageBusDrainError,
  MessageBusOptions,
  MessageBusPublishError,
  MessageBusStats,
  MessageHandler,
} from '@polymarket/message-bus';
import type { AnyExternalMessage } from '@polymarket/external-messages';
import type { IExternalMessageBus } from './IExternalMessageBus.js';

/**
 * Bus доставки внешних сообщений — тонкий фасад над `MessageBus<TMessage>`.
 *
 * @typeParam TMessage - Discriminated union КОНКРЕТНЫХ внешних сообщений
 *   контура. Параметризация обязана быть конкретной: `AnyExternalMessage`
 *   уничтожает narrowing подписок и типизацию payload
 *
 * @remarks
 * Чего этот bus сознательно НЕ делает:
 *
 * - **не интерпретирует payload** — source-native наблюдение доходит до
 *   handler-а как есть; преобразование в наши concepts — работа semantic
 *   adapter-а ПОСЛЕ bus;
 * - **не генерирует и не меняет metadata** — identity/ordering/causality
 *   создаёт producer (transport) через `MessageMetadataGenerator.nextRoot()`
 *   ДО публикации;
 * - **не валидирует** — decode/validation живут перед границей
 *   `ExternalMessage`;
 * - **не клонирует и не сериализует сообщение** — handler получает тот же
 *   объект (identity сохраняется, гарантия движка);
 * - **не транслирует ошибки** — наружу идут canonical
 *   `MessageBusPublishError`/`MessageBusDrainError`. Второй набор
 *   идентичных error-классов внешнему контуру не нужен: у него нет
 *   собственного публичного error-контракта, который требовалось бы защищать
 *   от Foundation-терминологии (в отличие от Application EventBus, чей M-000
 *   контракт старше движка).
 *
 * @example
 * ```typescript
 * type VenueExternalMessage =
 *   | ExternalMessage<'VENUE_BOOK', { readonly instrument: string; readonly bids: readonly number[] }>
 *   | ExternalMessage<'VENUE_TRADE', { readonly price: number }>;
 *
 * const bus = new ExternalMessageBus<VenueExternalMessage>();
 *
 * // Semantic adapter подписывается на source-native наблюдение:
 * bus.subscribe('VENUE_BOOK', (message) => {
 *   // message сужен до VENUE_BOOK — payload типизирован
 *   adapter.onBook(message.payload.bids, message.metadata);
 * });
 *
 * // Transport публикует внешнее наблюдение — root causal chain:
 * await bus.publish({
 *   type: 'VENUE_BOOK',
 *   payload: decodeVenueBook(rawFrame),
 *   metadata: metadataGenerator.nextRoot(),
 * });
 * ```
 */
export class ExternalMessageBus<TMessage extends AnyExternalMessage>
  implements IExternalMessageBus<TMessage>
{
  private readonly _bus: MessageBus<TMessage>;

  /**
   * Создаёт bus внешнего контура.
   *
   * @param options - Canonical опции движка доставки: `policy` (лимиты очереди
   *   и drain-цикла, режимы fan-out/ошибок) и `observer` (диагностика).
   *   По умолчанию — политика движка по умолчанию
   * @throws {RangeError} Если policy содержит невалидные лимиты —
   *   configuration error (валидацию выполняет конструктор `MessageBus`)
   *
   * @remarks
   * Опции переиспользуются as-is (`MessageBusOptions`, `MessageBusPolicy`,
   * `MessageBusObserver`) — своих alias-типов внешний контур не заводит.
   * Именно поэтому будущие live ingress/Recorder смогут настроить лимиты
   * очереди, не меняя delivery engine.
   *
   * @example
   * ```typescript
   * const bus = new ExternalMessageBus<VenueExternalMessage>({
   *   policy: createMessageBusPolicy({ queuePolicy: { maxQueueSize: 250_000 } }),
   *   observer: { onQueueOverflow: (ctx) => metrics.dropped(ctx.attemptedCount) },
   * });
   * ```
   */
  constructor(options: MessageBusOptions = {}) {
    this._bus = new MessageBus<TMessage>(options);
  }

  /**
   * Публикует одно внешнее сообщение.
   *
   * @param message - ПОЛНОЕ внешнее сообщение `{ type, payload, metadata }`
   *   (metadata создаёт producer до вызова)
   * @returns См. {@link IExternalMessageBus} — прямой Result движка:
   *   `Ok(void)`; `Err(MessageBusClosedError)` после `close()`;
   *   `Err(MessageBusOverflowError)` при переполнении очереди; терминальные
   *   ошибки drain, если вызов стал его владельцем
   *
   * @remarks
   * Прямая делегация: bus не дополняет и не переписывает сообщение.
   */
  public async publish(message: TMessage): Promise<Result<void, MessageBusPublishError>> {
    return this._bus.publish(message);
  }

  /**
   * Публикует список внешних сообщений с сохранением порядка.
   *
   * @param messages - Сообщения (порядок массива = порядок доставки)
   * @returns См. {@link ExternalMessageBus.publish}; пустой массив → `Ok(void)`
   *
   * @remarks
   * Атомарность batch enqueue (all or nothing при overflow) и FIFO-порядок —
   * гарантии движка. Актуально для burst-ов транспорта и будущего Reader-а,
   * восстанавливающего записанную последовательность наблюдений.
   */
  public async publishAll(messages: readonly TMessage[]): Promise<Result<void, MessageBusPublishError>> {
    return this._bus.publishAll(messages);
  }

  /**
   * Подписывается на внешние сообщения конкретного типа.
   *
   * @param type - Discriminator внешнего сообщения
   * @param handler - Обработчик (sync или async) — получает суженный член union
   * @param options - Опции подписки
   * @param options.critical - `true`: падение обработчика останавливает drain и
   *   возвращается caller'у как `Err(MessageBusCriticalHandlerError)`;
   *   по умолчанию `false`
   * @returns Функция отписки (идемпотентна)
   *
   * @remarks
   * Прямой passthrough в subscription-механизм движка: compile-time narrowing,
   * snapshot-семантика изменений подписок во время dispatch и идемпотентность
   * отписки — его гарантии. Второго subscription-хранилища здесь нет.
   *
   * Типичные подписчики внешнего контура — semantic adapter (преобразует
   * наблюдение в наши concepts) и будущий Recorder (пишет наблюдение as-is).
   */
  public subscribe<K extends TMessage['type']>(
    type: K,
    handler: MessageHandler<Extract<TMessage, { type: K }>>,
    options?: { critical?: boolean },
  ): () => void {
    return this._bus.subscribe(type, handler, options);
  }

  /**
   * Дообрабатывает ожидающую очередь (lifecycle API).
   *
   * @returns `Ok(void)` если очередь пуста/обработана; `Err` — терминальный
   *   исход drain
   *
   * @remarks
   * Публичен намеренно: Infrastructure-контур — законный владелец lifecycle.
   * Нужен transport reconnect-у (дообработать наблюдения перед пересозданием
   * соединения) и будущему Reader-у (проиграть файл и дождаться обработки).
   *
   * Нельзя await-ить из обработчика этого же bus — обработчик сам часть
   * drain (self-deadlock).
   */
  public async drain(): Promise<Result<void, MessageBusDrainError>> {
    return this._bus.drain();
  }

  /**
   * Закрывает bus для новых публикаций и дообрабатывает существующую очередь.
   *
   * @returns Result финального drain (см. {@link ExternalMessageBus.drain})
   *
   * @remarks
   * Идемпотентен. После close `publish`/`publishAll` возвращают
   * `Err(MessageBusClosedError)`. Основной сценарий — graceful shutdown:
   * transport остановлен, оставшиеся наблюдения обязаны быть доставлены
   * adapter-ам/Recorder-у до завершения процесса.
   */
  public async close(): Promise<Result<void, MessageBusDrainError>> {
    return this._bus.close();
  }

  /**
   * Возвращает диагностический снимок состояния движка.
   *
   * @returns Полный canonical {@link MessageBusStats}: queueSize,
   *   subscribedTypes, dispatching, closed, publishedTotal, dispatchedTotal,
   *   handlerErrorsTotal, rejectedPublicationsTotal
   *
   * @remarks
   * Прямой passthrough: operational delivery-metrics принадлежат движку —
   * фасад их не пересчитывает и не проецирует. `MessageBusStats` — общий
   * diagnostics-контракт всех semantic-фасадов над `MessageBus<T>`.
   */
  public getStats(): MessageBusStats {
    return this._bus.getStats();
  }
}
