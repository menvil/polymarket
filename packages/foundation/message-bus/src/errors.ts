/**
 * Typed operational-ошибки MessageBus.
 *
 * @remarks
 * Ожидаемые runtime-исходы доставки НЕ выбрасываются из публичного API — они
 * возвращаются как `Result.Err` из `publish()`/`publishAll()`/`drain()`/`close()`.
 * Каждая ошибка конструируется в точке возникновения (capacity-check, fan-out,
 * drain-guard), поэтому происхождение известно сразу — никакой поздней классификации
 * по `instanceof` не выполняется. В частности, если обработчик сам бросит
 * `MessageBusOverflowError`, наружу уйдёт `MessageBusCriticalHandlerError` с этим
 * значением в `originalError` — ошибка чужого кода не маскируется под операционное
 * состояние bus.
 *
 * Ошибки терминологически принадлежат generic message-bus, а не какому-либо
 * прикладному слою: пакет не переиспользует прикладные error-классы.
 *
 * Вид ошибки определяется через `instanceof` либо literal-поле `code`
 * (compile-time discriminated union) — не через парсинг `message`-строки.
 */

/**
 * Очередь MessageBus переполнена — публикация отклонена.
 *
 * @remarks
 * Возвращается из `publish()`/`publishAll()` когда ожидающая очередь не вмещает
 * новые сообщения (`queueSize + attemptedCount > maxQueueSize`). Отклонённые
 * сообщения НЕ ставятся в очередь (batch — атомарно, all or nothing), уже стоящие
 * в очереди сообщения не затрагиваются. Лимит считает только ожидающие сообщения —
 * текущее in-flight сообщение не входит.
 */
export class MessageBusOverflowError extends Error {
  /** Literal-дискриминант вида ошибки (доступен и без экземпляра). */
  public static readonly code = 'MESSAGE_BUS_OVERFLOW';
  /** Literal-дискриминант вида ошибки. */
  public readonly code = 'MESSAGE_BUS_OVERFLOW' as const;
  /** Максимальный размер ожидающей очереди, действовавший при отклонении. */
  public readonly maxQueueSize: number;
  /** Сколько сообщений пыталась поставить отклонённая операция (1 для publish). */
  public readonly attemptedCount: number;
  /** Тип сообщения — присутствует для одиночного `publish()`. */
  public readonly messageType?: string;

  /**
   * @param args - Контекст переполнения
   * @param args.maxQueueSize - Действующий лимит очереди
   * @param args.attemptedCount - Размер отклонённой публикации
   * @param args.messageType - Тип сообщения (для одиночного publish)
   */
  constructor(args: { maxQueueSize: number; attemptedCount: number; messageType?: string }) {
    const typeSuffix = args.messageType !== undefined ? ` of type '${args.messageType}'` : '';
    super(
      `Message bus queue overflow (max ${args.maxQueueSize}): ` +
        `cannot enqueue ${args.attemptedCount} message(s)${typeSuffix}`,
    );
    this.name = 'MessageBusOverflowError';
    this.maxQueueSize = args.maxQueueSize;
    this.attemptedCount = args.attemptedCount;
    this.messageType = args.messageType;
  }
}

/**
 * Critical-подписчик упал при обработке сообщения.
 *
 * @remarks
 * Возвращается когда обработчик, подписанный с `{ critical: true }`, бросил
 * (sync) или зареджектился (async). Конструируется сразу после fan-out конкретного
 * сообщения — в точке, где известны и `message.type`, и исходная ошибка. Каноничной
 * становится первая critical-ошибка в детерминированном порядке snapshot подписки;
 * последующие critical-ошибки передаются observer'у.
 *
 * `originalError` — сырое брошенное значение (обработчик может бросить что угодно,
 * не обязательно `Error`), включая случаи, когда обработчик бросил одну из ошибок
 * самого MessageBus.
 */
export class MessageBusCriticalHandlerError extends Error {
  /** Literal-дискриминант вида ошибки (доступен и без экземпляра). */
  public static readonly code = 'MESSAGE_BUS_CRITICAL_HANDLER';
  /** Literal-дискриминант вида ошибки. */
  public readonly code = 'MESSAGE_BUS_CRITICAL_HANDLER' as const;
  /** Тип сообщения, на котором упал critical-обработчик. */
  public readonly messageType: string;
  /** Исходное брошенное значение обработчика (raw `unknown`). */
  public readonly originalError: unknown;

  /**
   * @param args - Контекст ошибки
   * @param args.messageType - Тип сообщения
   * @param args.originalError - Сырое брошенное значение обработчика
   */
  constructor(args: { messageType: string; originalError: unknown }) {
    super(`Message bus critical handler failed for message type '${args.messageType}'`);
    this.name = 'MessageBusCriticalHandlerError';
    this.messageType = args.messageType;
    this.originalError = args.originalError;
  }
}

/**
 * Превышен лимит сообщений за один drain-цикл — вероятная бесконечная петля.
 *
 * @remarks
 * Защита от `handler(A) → publish(A) → ...`: если за один drain обработано
 * `maxMessagesPerDrain` сообщений и очередь всё ещё не пуста, drain останавливается,
 * оставшаяся очередь ОЧИЩАЕТСЯ (это артефакт петли, а не легитимный backlog),
 * caller получает эту ошибку. Bus остаётся работоспособным.
 */
export class MessageBusDrainLimitError extends Error {
  /** Literal-дискриминант вида ошибки (доступен и без экземпляра). */
  public static readonly code = 'MESSAGE_BUS_DRAIN_LIMIT';
  /** Literal-дискриминант вида ошибки. */
  public readonly code = 'MESSAGE_BUS_DRAIN_LIMIT' as const;
  /** Действовавший лимит сообщений за один drain-цикл. */
  public readonly maxMessagesPerDrain: number;

  /**
   * @param args - Контекст срабатывания защиты
   * @param args.maxMessagesPerDrain - Действовавший лимит
   */
  constructor(args: { maxMessagesPerDrain: number }) {
    super(
      `Message bus drain limit exceeded (${args.maxMessagesPerDrain} messages per drain): ` +
        `possible infinite message loop, remaining queue cleared`,
    );
    this.name = 'MessageBusDrainLimitError';
    this.maxMessagesPerDrain = args.maxMessagesPerDrain;
  }
}

/**
 * Bus закрыт — новые публикации не принимаются.
 *
 * @remarks
 * Возвращается из `publish()`/`publishAll()` после вызова `close()`. Однозначно
 * означает: bus больше не принимает новые публикации. Уже стоящая очередь при этом
 * дообрабатывается (`close()` сам выполняет drain), а `drain()` и изменение
 * подписок остаются доступными для восстановления после сбоя.
 */
export class MessageBusClosedError extends Error {
  /** Literal-дискриминант вида ошибки (доступен и без экземпляра). */
  public static readonly code = 'MESSAGE_BUS_CLOSED';
  /** Literal-дискриминант вида ошибки. */
  public readonly code = 'MESSAGE_BUS_CLOSED' as const;

  constructor() {
    super('Message bus is closed and no longer accepts new publications');
    this.name = 'MessageBusClosedError';
  }
}

/**
 * Терминальные исходы drain-цикла.
 *
 * @remarks
 * Возвращаются caller'у, владеющему drain (`publish()`/`publishAll()` на idle-bus,
 * `drain()`, `close()`).
 */
export type MessageBusDrainError = MessageBusCriticalHandlerError | MessageBusDrainLimitError;

/**
 * Полный union ошибок публикации.
 *
 * @remarks
 * `publish()`/`publishAll()` возвращают `Result<void, MessageBusPublishError>`:
 * отклонение на входе (`MessageBusClosedError`, `MessageBusOverflowError`) либо
 * терминальный исход drain, если caller стал его владельцем
 * ({@link MessageBusDrainError}).
 */
export type MessageBusPublishError =
  | MessageBusOverflowError
  | MessageBusClosedError
  | MessageBusDrainError;
