import type { IClock } from '@polymarket/time';
import type { MessageId, RunId } from '@polymarket/ids';
import { unsafeMessageId } from '@polymarket/ids';
import { TimestampService } from '@polymarket/value-objects';
import type { MessageMetadata } from './MessageMetadata.js';
import type { IHighResolutionClock } from './IHighResolutionClock.js';
import { generateRunId } from './generateRunId.js';

/**
 * Зависимости и настройки {@link MessageMetadataGenerator}.
 */
export interface MessageMetadataGeneratorOptions {
  /**
   * Канонический источник wall-clock времени (live/paper/replay).
   * Определяет `createdAt`, `createdAtUnixSeconds`, `millisecondOfSecond`.
   */
  readonly clock: IClock;
  /**
   * High-resolution источник sub-millisecond компонент
   * (`microsecondOfMillisecond`, `nanosecondOfMicrosecond`).
   *
   * Если не задан — режим «нет sub-ms precision»: обе компоненты честно
   * равны 0 (наносекунды не выдумываются; порядок гарантирует `sequence`).
   * Live composition root инъецирует `SystemHighResolutionClock`,
   * тесты/replay — `FixedHighResolutionClock`.
   */
  readonly highResolutionClock?: IHighResolutionClock;
  /**
   * Identity runtime. Если не задан — генерируется ОДИН раз конструктором
   * через canonical `generateRunId()` (Node crypto). Инъекция нужна
   * детерминированным тестам/фикстурам.
   */
  readonly runId?: RunId;
}

/**
 * Единый canonical-механизм создания {@link MessageMetadata} — identity,
 * ordering, creation time и causal chain каждого системного сообщения.
 *
 * @remarks
 * НЕ Singleton: ОДИН instance создаётся в composition root конкретного
 * runtime (`new MessageMetadataGenerator(...)`) и передаётся тем components,
 * которым необходимо создавать messages. Другой процесс/worker — другой
 * instance с другим `runId`.
 *
 * ### Полностью synchronous
 *
 * `nextRoot()`/`nextChild()` не делают await/I/O/distributed locks — только
 * синхронные чтения инъецированных clock-портов и `sequence++`. В одном Node
 * runtime синхронные JS-секции не выполняются одновременно, поэтому
 * increment безопасен при любом числе async producers (mutex не нужен):
 * каждый вызов получает уникальный, строго возрастающий `sequence`.
 *
 * ### Ordering
 *
 * `sequence` начинается с 1 и строго растёт в порядке фактических вызовов
 * генератора. Инвариант локален runtime-у: `(runId, sequence)` — глобального
 * sequence между процессами НЕТ. Sequence остаётся safe integer — при
 * теоретическом переполнении генератор fail-fast бросает `RangeError`.
 *
 * ### Время
 *
 * На каждый вызов — ровно ОДНО чтение `clock.now()`: `createdAt`,
 * `createdAtUnixSeconds` и `millisecondOfSecond` — разложение одного и того
 * же момента (поля не могут описывать разные моменты). Sub-ms компоненты —
 * остаток high-resolution источника внутри миллисекунды; без источника — 0.
 * Существующая deterministic-модель `IClock` (paper/replay) не нарушается.
 *
 * ### MessageId
 *
 * `<runId>-<unixSeconds>-<ms>-<us>-<ns>-<sequence>`, например
 * `k8f3pz7q-1786668087-123-456-789-000018423`. Даже при полностью
 * совпавшем времени (один tick) уникальность обеспечивает sequence-суффикс.
 *
 * @example
 * ```typescript
 * // Composition root (один раз на процесс):
 * const generator = new MessageMetadataGenerator({
 *   clock: new LiveClock(),
 *   highResolutionClock: new SystemHighResolutionClock(),
 * });
 *
 * // Root-сообщение — начало новой causal chain:
 * const root = generator.nextRoot();
 * // root.correlationId === root.messageId, root.causationId === undefined
 *
 * // Child-сообщение — реакция на parent:
 * const child = generator.nextChild(parentEvent.metadata);
 * // child.correlationId === parentEvent.metadata.correlationId
 * // child.causationId === parentEvent.metadata.messageId
 * ```
 */
export class MessageMetadataGenerator {
  private readonly _clock: IClock;
  private readonly _highResolutionClock: IHighResolutionClock | undefined;
  private readonly _runId: RunId;
  /** Последний выданный sequence (0 — ещё не выдавали; первый будет 1). */
  private _sequence = 0;

  /**
   * Создаёт генератор metadata для ОДНОГО runtime.
   *
   * @param options - Инъецируемые clock-порты и (опционально) runId
   */
  constructor(options: MessageMetadataGeneratorOptions) {
    this._clock = options.clock;
    this._highResolutionClock = options.highResolutionClock;
    this._runId = options.runId ?? generateRunId();
  }

  /** Identity runtime, которым помечаются все создаваемые metadata. */
  public get runId(): RunId {
    return this._runId;
  }

  /**
   * Создаёт metadata ROOT-сообщения — начала новой causal chain.
   *
   * @returns Metadata с `correlationId === messageId` и без `causationId`
   * @throws {RangeError} При переполнении sequence (за пределами safe integer)
   * @throws {Error} Если инъецированный clock вернул невалидное время
   *
   * @remarks
   * Root — сообщение, не порождённое другим сообщением системы (например,
   * первичная реакция на внешнее наблюдение). Синхронный метод: увеличивает
   * sequence, генерирует новый messageId, замыкает correlation на себя.
   *
   * @example
   * ```typescript
   * const event = {
   *   type: 'FILL_RECEIVED',
   *   payload: { fill, receivedAt },
   *   metadata: generator.nextRoot(),
   * } satisfies FillReceivedEvent;
   * ```
   */
  public nextRoot(): MessageMetadata {
    const core = this._nextCore();
    return {
      ...core,
      correlationId: core.messageId,
    };
  }

  /**
   * Создаёт metadata CHILD-сообщения, непосредственно порождённого parent-ом.
   *
   * @param parent - Metadata сообщения, породившего текущее
   * @returns Metadata с унаследованным `correlationId` root-цепочки и
   *   `causationId === parent.messageId`
   * @throws {RangeError} При переполнении sequence (за пределами safe integer)
   * @throws {Error} Если инъецированный clock вернул невалидное время
   *
   * @remarks
   * Causal-правила: `correlationId` наследуется от всей цепочки (корень),
   * `causationId` — непосредственная стрелка назад на parent. Не делай
   * каждое новое сообщение root без причины — реакция на message обязана
   * быть child.
   *
   * @example
   * ```typescript
   * const reaction = {
   *   type: 'ORDER_FILLED',
   *   payload: { orderId, fill, averagePrice },
   *   metadata: generator.nextChild(fillReceived.metadata),
   * } satisfies OrderFilledEvent;
   * ```
   */
  public nextChild(parent: MessageMetadata): MessageMetadata {
    const core = this._nextCore();
    return {
      ...core,
      correlationId: parent.correlationId,
      causationId: parent.messageId,
    };
  }

  /**
   * Синхронно формирует общую часть metadata: sequence, время, messageId.
   *
   * @returns Все поля metadata, кроме causal-полей
   * @throws {RangeError} При переполнении sequence
   * @throws {Error} Если clock вернул невалидное время
   *
   * @remarks
   * Алгоритм:
   * 1. `sequence + 1` с fail-fast проверкой safe integer.
   * 2. Ровно одно чтение `clock.now()` → createdAt + unixSeconds + ms
   *    (consistency полей by construction).
   * 3. Остаток high-resolution источника внутри миллисекунды → us/ns
   *    (без источника — нули).
   * 4. Сборка human-readable messageId (валиден by construction).
   */
  private _nextCore(): Omit<MessageMetadata, 'correlationId' | 'causationId'> {
    const sequence = this._sequence + 1;
    if (!Number.isSafeInteger(sequence)) {
      throw new RangeError(
        `MessageMetadataGenerator sequence overflow: ${this._sequence} + 1 exceeds Number.MAX_SAFE_INTEGER`,
      );
    }
    this._sequence = sequence;

    const now = this._clock.now();
    const createdAtResult = TimestampService.fromDate(now);
    if (!createdAtResult.ok) {
      throw new Error(
        `MessageMetadataGenerator received an invalid time from the injected clock: ${createdAtResult.error.message}`,
      );
    }
    const epochMs = now.getTime();
    const createdAtUnixSeconds = Math.floor(epochMs / 1000);
    const millisecondOfSecond = epochMs - createdAtUnixSeconds * 1000;

    let microsecondOfMillisecond = 0;
    let nanosecondOfMicrosecond = 0;
    if (this._highResolutionClock !== undefined) {
      const subMillisecondNs = this._highResolutionClock.nowNanoseconds() % 1_000_000n;
      microsecondOfMillisecond = Number(subMillisecondNs / 1_000n);
      nanosecondOfMicrosecond = Number(subMillisecondNs % 1_000n);
    }

    return {
      messageId: this._composeMessageId(
        createdAtUnixSeconds,
        millisecondOfSecond,
        microsecondOfMillisecond,
        nanosecondOfMicrosecond,
        sequence,
      ),
      runId: this._runId,
      sequence,
      createdAt: createdAtResult.value,
      createdAtUnixSeconds,
      millisecondOfSecond,
      microsecondOfMillisecond,
      nanosecondOfMicrosecond,
    };
  }

  /**
   * Собирает human-readable MessageId канонического формата.
   *
   * @param unixSeconds - Целые Unix-секунды
   * @param ms - Миллисекунда внутри секунды (0..999)
   * @param us - Микросекунда внутри миллисекунды (0..999)
   * @param ns - Наносекунда внутри микросекунды (0..999)
   * @param sequence - Порядковый номер сообщения
   * @returns MessageId вида `<runId>-<sec>-<ms>-<us>-<ns>-<seq>`
   *
   * @remarks
   * Время-компоненты дополняются до 3 цифр, sequence — до 9 (для visual
   * alignment; при больших значениях строка просто длиннее). Строка валидна
   * by construction, поэтому `unsafeMessageId` оправдан.
   */
  private _composeMessageId(
    unixSeconds: number,
    ms: number,
    us: number,
    ns: number,
    sequence: number,
  ): MessageId {
    const pad3 = (value: number): string => String(value).padStart(3, '0');
    const raw = `${this._runId}-${unixSeconds}-${pad3(ms)}-${pad3(us)}-${pad3(ns)}-${String(sequence).padStart(9, '0')}`;
    return unsafeMessageId(raw);
  }
}
