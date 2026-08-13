/**
 * Политики доставки MessageBus — plain immutable configuration.
 *
 * @remarks
 * Политика — обычный замороженный объект, а не иерархия Strategy-классов.
 * Literal-union'ы стратегий сейчас содержат по одному поддерживаемому значению —
 * ровно те семантики, которые реализует текущий движок. Расширение (например,
 * другие overflow-стратегии) добавит literals без изменения API MessageBus.
 *
 * ### Ошибки конфигурации vs runtime-ошибки
 * Невалидная политика — это programmer/configuration error: конструктор MessageBus
 * синхронно бросает `RangeError` при construction. Ожидаемые runtime-проблемы
 * доставки, напротив, всегда возвращаются как `Result.Err` из публичного API.
 */

/**
 * Конфигурация поведения MessageBus.
 *
 * @remarks
 * Все поля readonly; используй {@link DEFAULT_MESSAGE_BUS_POLICY} или
 * {@link createMessageBusPolicy} для получения валидной политики.
 */
export interface MessageBusPolicy {
  /** Лимиты очереди. */
  readonly queuePolicy: {
    /** Максимальный размер ожидающей очереди (in-flight сообщение не считается). */
    readonly maxQueueSize: number;
    /** Максимум сообщений за один drain-цикл (защита от бесконечной петли публикаций). */
    readonly maxMessagesPerDrain: number;
  };

  /** Поведение при переполнении очереди. */
  readonly overflowPolicy: {
    /** `reject-new` — новая публикация отклоняется typed-ошибкой, очередь не затрагивается. */
    readonly strategy: 'reject-new';
  };

  /** Поведение fan-out обработчиков одного сообщения. */
  readonly handlerPolicy: {
    /** `parallel` — обработчики запускаются параллельно, bus ждёт завершения всех. */
    readonly fanOut: 'parallel';
  };

  /** Поведение при ошибках обработчиков и защите drain. */
  readonly errorPolicy: {
    /** `continue` — ошибка non-critical обработчика не останавливает siblings и drain. */
    readonly nonCriticalHandler: 'continue';
    /** `stop-drain-preserve-queue` — critical-ошибка останавливает drain, очередь сохраняется. */
    readonly criticalHandler: 'stop-drain-preserve-queue';
    /** `clear-queue` — при превышении drain-лимита оставшаяся очередь очищается. */
    readonly drainLimit: 'clear-queue';
  };
}

/**
 * Политика по умолчанию.
 *
 * @remarks
 * Консервативные limits для in-process доставки general-purpose:
 * очередь до 100 000 ожидающих сообщений, до 10 000 сообщений за drain-цикл.
 * Потребители с иными требованиями передают собственную политику явно через
 * {@link createMessageBusPolicy}.
 */
export const DEFAULT_MESSAGE_BUS_POLICY: MessageBusPolicy = Object.freeze({
  queuePolicy: Object.freeze({
    maxQueueSize: 100_000,
    maxMessagesPerDrain: 10_000,
  }),
  overflowPolicy: Object.freeze({ strategy: 'reject-new' as const }),
  handlerPolicy: Object.freeze({ fanOut: 'parallel' as const }),
  errorPolicy: Object.freeze({
    nonCriticalHandler: 'continue' as const,
    criticalHandler: 'stop-drain-preserve-queue' as const,
    drainLimit: 'clear-queue' as const,
  }),
});

/**
 * Переопределяемая часть политики.
 *
 * @remarks
 * Сейчас переопределяются только числовые лимиты очереди — остальные группы имеют
 * по одному поддерживаемому значению, и их «переопределение» не имело бы смысла.
 * При расширении literal-union'ов сюда добавятся соответствующие поля.
 */
export interface MessageBusPolicyOverrides {
  /** Частичное переопределение лимитов очереди. */
  readonly queuePolicy?: Partial<MessageBusPolicy['queuePolicy']>;
}

/**
 * Собирает политику из default-значений и переопределений.
 *
 * @param overrides - Частичные переопределения (см. {@link MessageBusPolicyOverrides})
 * @returns Полная замороженная политика
 *
 * @example
 * ```typescript
 * const policy = createMessageBusPolicy({ queuePolicy: { maxQueueSize: 500 } });
 * const bus = new MessageBus<MyMessage>({ policy });
 * ```
 */
export function createMessageBusPolicy(overrides: MessageBusPolicyOverrides = {}): MessageBusPolicy {
  return Object.freeze({
    ...DEFAULT_MESSAGE_BUS_POLICY,
    queuePolicy: Object.freeze({
      ...DEFAULT_MESSAGE_BUS_POLICY.queuePolicy,
      ...overrides.queuePolicy,
    }),
  });
}

/**
 * Валидирует политику при construction MessageBus.
 *
 * @param policy - Политика для проверки
 * @throws {RangeError} Если `maxQueueSize`/`maxMessagesPerDrain` не являются
 *   положительными safe integers — это configuration error, а не runtime-исход,
 *   поэтому здесь синхронный throw, а не `Result`
 */
export function validateMessageBusPolicy(policy: MessageBusPolicy): void {
  assertPositiveSafeInteger(policy.queuePolicy.maxQueueSize, 'queuePolicy.maxQueueSize');
  assertPositiveSafeInteger(policy.queuePolicy.maxMessagesPerDrain, 'queuePolicy.maxMessagesPerDrain');
}

/**
 * Проверяет, что значение — положительный safe integer.
 *
 * @param value - Проверяемое значение
 * @param field - Имя поля для сообщения об ошибке
 * @throws {RangeError} При нарушении ограничения
 */
function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(
      `MessageBus policy '${field}' must be a positive safe integer, got: ${String(value)}`,
    );
  }
}
