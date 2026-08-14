import type { MessageId, RunId } from '@polymarket/ids';
import type { Timestamp } from '@polymarket/timestamp';

/**
 * Canonical системная metadata сообщения — обязательная часть каждого
 * public message системы.
 *
 * @remarks
 * После M-003 каждое системное сообщение имеет форму
 * `{ type, payload, metadata }`, где `metadata` — ОБЯЗАТЕЛЬНОЕ поле этого
 * типа. Metadata содержит только универсальные message-system concerns:
 *
 * - **identity** — `messageId`;
 * - **runtime identity** — `runId`;
 * - **ordering** — `sequence` (строго возрастает внутри одного `runId`);
 * - **creation time** — `createdAt` + high-resolution компоненты;
 * - **causal chain** — `correlationId`/`causationId`.
 *
 * Semantic-данные (marketId, strategyId, source, exchange и т.п.) живут в
 * `payload` конкретного сообщения — НЕ здесь.
 *
 * ### Ordering-инвариант
 *
 * `sequence` начинается с 1 и строго растёт внутри одного `runId`. Sequence
 * НЕ глобален между процессами/worker-ами: правильный инвариант — пара
 * `(runId, sequence)` однозначно задаёт порядок внутри конкретного runtime.
 *
 * ### Time-модель
 *
 * ВСЕ time-поля — разложение ОДНОГО абсолютного момента (один источник на
 * сообщение): с high-resolution источником — одного значения epoch-наносекунд
 * (`IHighResolutionClock.nowEpochNanoseconds()`), без него — одного чтения
 * `IClock.now()` (millisecond precision). `createdAt` — канонический
 * `Timestamp` той же позиции; `createdAtUnixSeconds`/`millisecondOfSecond` —
 * её целые секунды и миллисекунда;
 * `microsecondOfMillisecond`/`nanosecondOfMicrosecond` — sub-ms precision той
 * же позиции; в режимах без sub-ms precision равны 0 (никаких выдуманных
 * наносекунд). Вместе: `seconds.ms.us.ns`, например `1786668087.123.456.789`.
 *
 * ### Causality-правила
 *
 * Root-сообщение (начинает новую causal chain):
 * `correlationId === messageId`, `causationId` отсутствует.
 *
 * Child-сообщение (порождено сообщением parent):
 * `correlationId === parent.correlationId` (корень всей цепочки),
 * `causationId === parent.messageId` (непосредственная стрелка назад).
 *
 * @example
 * ```typescript
 * const metadata = generator.nextRoot();
 * // {
 * //   messageId: 'k8f3pz7q-1786668087-123-456-789-000000001',
 * //   runId: 'k8f3pz7q',
 * //   sequence: 1,
 * //   createdAt: Timestamp(1786668087123),
 * //   createdAtUnixSeconds: 1786668087,
 * //   millisecondOfSecond: 123,
 * //   microsecondOfMillisecond: 456,
 * //   nanosecondOfMicrosecond: 789,
 * //   correlationId: 'k8f3pz7q-1786668087-123-456-789-000000001',
 * //   causationId: undefined,
 * // }
 * ```
 */
export interface MessageMetadata {
  /** Уникальная identity этого сообщения. */
  readonly messageId: MessageId;
  /** Identity runtime (одного запуска процесса), создавшего сообщение. */
  readonly runId: RunId;

  /** Строго возрастающий порядковый номер сообщения внутри одного runId (с 1). */
  readonly sequence: number;

  /** Канонический Timestamp момента создания (millisecond precision той же позиции). */
  readonly createdAt: Timestamp;

  /** Целые Unix-секунды момента создания (совпадает с createdAt). */
  readonly createdAtUnixSeconds: number;
  /** Миллисекунда внутри секунды: 0..999 (совпадает с createdAt). */
  readonly millisecondOfSecond: number;
  /** Микросекунда внутри миллисекунды: 0..999 (0 без sub-ms precision). */
  readonly microsecondOfMillisecond: number;
  /** Наносекунда внутри микросекунды: 0..999 (0 без sub-ms precision). */
  readonly nanosecondOfMicrosecond: number;

  /** ID корневого сообщения всей causal chain (у root равен messageId). */
  readonly correlationId: MessageId;
  /** ID непосредственного parent-сообщения; отсутствует у root. */
  readonly causationId?: MessageId;
}
