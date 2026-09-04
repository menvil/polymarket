/**
 * Canonical wire-контракт replayable raw-архива V2.
 *
 * @remarks
 * ### Зачем конверт вокруг payload
 *
 * До V2 recorder клал на диск ТОЛЬКО `message.payload`. Source-native payload
 * при этом сохранялся идеально, но вместе с внешним конвертом терялось всё,
 * что описывает НАБЛЮДЕНИЕ: `runId`, `sequence` и high-resolution момент
 * ingress. Из-за этого после записи было невозможно восстановить точный
 * порядок наблюдений МЕЖДУ файлами (Polymarket-рынок и разные CEX-партиции
 * физически лежат в разных файлах, а vendor-timestamp-ы у них из разных
 * часов и разной точности).
 *
 * V2 добавляет archive envelope ВОКРУГ payload:
 *
 * ```text
 * ExternalMessage { type, payload, metadata }
 *        ↓ recorder
 * RecordedExternalObservationV2 { type, ingress, payload }
 *        ↓ JSONL
 * archive
 * ```
 *
 * ### Инвариант неизменности payload
 *
 * ```text
 * record.payload === source-native message.payload
 * ```
 *
 * Никакой semantic normalization до записи: конверт добавляется СНАРУЖИ,
 * сам payload уходит на диск той же ссылкой, без clone/rename/flatten.
 * Replay обязан отдать semantic adapter-у ровно то, что тот видел бы live.
 *
 * ### Ключ исторического порядка
 *
 * ```text
 * (runId, sequence)
 * ```
 *
 * `sequence` БЕЗ `runId` не является глобальной identity: после рестарта
 * процесса начинается новый run и нумерация стартует заново. Сравнивать
 * `sequence` двух наблюдений допустимо ТОЛЬКО когда `runId` совпадает —
 * см. {@link compareIngress}.
 *
 * ### Почему время не «пересчитывается»
 *
 * Все `ingress`-поля копируются ИЗ metadata того сообщения, которое реально
 * пришло recorder-у. Никакого `Date.now()` в момент записи: между
 * наблюдением и storage-write лежат bus, буферы и планировщик, а wall-clock
 * момента записи — это время НАШЕЙ обработки, а не время наблюдения.
 */

/**
 * Версия replayable raw-формата, объявляемая в meta-строке архива.
 *
 * @remarks
 * `2` означает: строки 2+ (для CEX-партиции — строки после header-а)
 * содержат {@link RecordedExternalObservationV2}, а не bare payload.
 * Legacy-архивы старого коллектора версии не объявляют вовсе.
 */
export const RAW_ARCHIVE_FORMAT_VERSION = 2;

/**
 * Точность/происхождение временнóй информации прочитанного наблюдения.
 *
 * - `'EXACT_INGRESS'` — архив V2: `runId`/`sequence`/high-resolution момент
 *   ingress записаны ровно так, как их видел live runtime;
 * - `'LEGACY_APPROXIMATE'` — legacy-архив: собственного времени наблюдения
 *   в строке нет, доступен только порядок строк внутри файла и vendor-поля
 *   самого payload (разные источники, разные часы, неизвестная задержка).
 *
 * @remarks
 * Разделение существует, чтобы никто не выдал приблизительный legacy-тайминг
 * за точный. Reconstruction legacy-тайминга (latency-модель, кросс-файловая
 * реконструкция) сознательно НЕ реализуется — она была бы догадкой.
 */
export type RawArchiveTimingQuality = 'EXACT_INGRESS' | 'LEGACY_APPROXIMATE';

/**
 * Ingress-метка наблюдения: runtime identity, порядок и момент наблюдения.
 *
 * @remarks
 * Разложение ОДНОГО абсолютного момента (`seconds.ms.us.ns`), скопированное
 * из canonical `MessageMetadata` сообщения. Поля НЕ являются metadata нового
 * replay-runtime: при replay сообщение получит СВОЮ metadata, а эти значения
 * нужны simulator/replay scheduler-у, чтобы воспроизвести историческую
 * временную линию.
 */
export interface RecordedIngress {
  /** Identity runtime (одного запуска процесса), наблюдавшего сообщение. */
  readonly runId: string;
  /** Порядковый номер наблюдения внутри `runId` (строго возрастает с 1). */
  readonly sequence: number;

  /** Целые Unix-секунды момента наблюдения. */
  readonly createdAtUnixSeconds: number;
  /** Миллисекунда внутри секунды: 0..999. */
  readonly millisecondOfSecond: number;
  /** Микросекунда внутри миллисекунды: 0..999 (0 без sub-ms precision). */
  readonly microsecondOfMillisecond: number;
  /** Наносекунда внутри микросекунды: 0..999 (0 без sub-ms precision). */
  readonly nanosecondOfMicrosecond: number;
}

/**
 * Одна data-строка replayable raw-архива V2.
 *
 * @typeParam TType - Литерал внешнего discriminator-а (`POLYMARKET_MARKET`,
 *   `CEX_ORDERBOOK`, ...); при чтении с диска сужение недоступно — `string`
 *
 * @example
 * ```typescript
 * const observation: RecordedExternalObservationV2 = {
 *   type: 'CEX_ORDERBOOK',
 *   ingress: {
 *     runId: 'k8f3pz7q',
 *     sequence: 101,
 *     createdAtUnixSeconds: 1786668087,
 *     millisecondOfSecond: 123,
 *     microsecondOfMillisecond: 456,
 *     nanosecondOfMicrosecond: 789,
 *   },
 *   payload: { exchangeId: 'binance', symbol: 'BTC/USDT:USDT', orderBook: { ... } },
 * };
 * ```
 */
export interface RecordedExternalObservationV2<TType extends string = string> {
  /** Внешний discriminator сообщения (`ExternalMessage['type']`). */
  readonly type: TType;
  /** Ingress-метка наблюдения (порядок + момент). */
  readonly ingress: RecordedIngress;
  /** НЕИЗМЕНЁННЫЙ source-native payload сообщения. */
  readonly payload: unknown;
}

/**
 * Минимальная структурная форма metadata, из которой строится ingress.
 *
 * @remarks
 * Canonical `MessageMetadata` (`@polymarket/messages`) удовлетворяет этому
 * типу структурно — пакет формата специально НЕ импортирует его, чтобы
 * оставаться leaf-контрактом персистентности без зависимостей. Здесь
 * перечислены РОВНО те поля, которые попадают в архив; `messageId`,
 * `correlationId`, `causationId` и `createdAt` осознанно не пишутся: они
 * принадлежат live execution, а не исторической временной линии.
 */
export interface ObservationIngressMetadata {
  readonly runId: string;
  readonly sequence: number;
  readonly createdAtUnixSeconds: number;
  readonly millisecondOfSecond: number;
  readonly microsecondOfMillisecond: number;
  readonly nanosecondOfMicrosecond: number;
}

/**
 * Структурная форма сообщения, из которого строится V2-наблюдение.
 *
 * @typeParam TType - Литерал discriminator-а внешнего сообщения
 */
export interface ObservedExternalMessage<TType extends string = string> {
  readonly type: TType;
  readonly payload: unknown;
  readonly metadata: ObservationIngressMetadata;
}

/**
 * Строит V2-наблюдение из пришедшего `ExternalMessage`.
 *
 * @param message - Сообщение, которое реально пришло recorder-у
 * @returns Archive envelope вокруг НЕИЗМЕНЁННОГО `message.payload`
 *
 * @remarks
 * Все ingress-поля копируются напрямую из `message.metadata` — время не
 * читается заново и не пересчитывается. `payload` кладётся ТОЙ ЖЕ ссылкой:
 * инвариант `record.payload === message.payload` проверяется тестом.
 *
 * @example
 * ```typescript
 * bus.subscribe('CEX_TRADE', (message) => {
 *   storage.write(routing, toRecordedObservation(message));
 * });
 * ```
 */
export function toRecordedObservation<TType extends string>(
  message: ObservedExternalMessage<TType>,
): RecordedExternalObservationV2<TType> {
  const metadata = message.metadata;
  return {
    type: message.type,
    ingress: {
      runId: metadata.runId,
      sequence: metadata.sequence,
      createdAtUnixSeconds: metadata.createdAtUnixSeconds,
      millisecondOfSecond: metadata.millisecondOfSecond,
      microsecondOfMillisecond: metadata.microsecondOfMillisecond,
      nanosecondOfMicrosecond: metadata.nanosecondOfMicrosecond,
    },
    payload: message.payload,
  };
}

/**
 * Момент наблюдения в Unix-миллисекундах (millisecond precision).
 *
 * @param ingress - Ingress-метка наблюдения
 * @returns Epoch-миллисекунды той же позиции времени
 *
 * @remarks
 * Не «новое время», а лишь composition двух записанных целых полей той же
 * позиции — ровно то значение, которое имел бы `metadata.createdAt`.
 * Используется там, где нужна ms-шкала (например, выбор временнóго окна
 * CEX-партиции), а sub-ms компоненты не влияют на результат.
 *
 * @example
 * ```typescript
 * ingressEpochMilliseconds({ createdAtUnixSeconds: 1786668087, millisecondOfSecond: 123, ... });
 * // → 1786668087123
 * ```
 */
export function ingressEpochMilliseconds(ingress: RecordedIngress): number {
  return ingress.createdAtUnixSeconds * 1000 + ingress.millisecondOfSecond;
}

/**
 * Момент наблюдения в Unix-наносекундах (полная записанная точность).
 *
 * @param ingress - Ingress-метка наблюдения
 * @returns Epoch-наносекунды как `bigint` (number потерял бы точность)
 *
 * @remarks
 * `number` не представляет epoch-наносекунды точно (> 2^53), поэтому
 * возвращается `bigint`. Нужен replay scheduler-у для упорядочивания
 * наблюдений РАЗНЫХ runId, где `(runId, sequence)` неприменим.
 */
export function ingressEpochNanoseconds(ingress: RecordedIngress): bigint {
  return (
    BigInt(ingress.createdAtUnixSeconds) * 1_000_000_000n +
    BigInt(ingress.millisecondOfSecond) * 1_000_000n +
    BigInt(ingress.microsecondOfMillisecond) * 1_000n +
    BigInt(ingress.nanosecondOfMicrosecond)
  );
}

/**
 * Принадлежат ли два наблюдения одному runtime-запуску.
 *
 * @param left - Первое наблюдение
 * @param right - Второе наблюдение
 * @returns `true`, если `runId` совпадают
 */
export function isSameRun(left: RecordedIngress, right: RecordedIngress): boolean {
  return left.runId === right.runId;
}

/**
 * Сравнивает два наблюдения по каноническому ключу порядка `(runId, sequence)`.
 *
 * @param left - Первое наблюдение
 * @param right - Второе наблюдение
 * @returns Отрицательное/ноль/положительное как у компаратора — если оба
 *   наблюдения принадлежат ОДНОМУ `runId`; `undefined` — если `runId`
 *   разные (их `sequence` лежат в РАЗНЫХ пространствах и несравнимы)
 *
 * @remarks
 * `undefined` — не «ошибка», а точное утверждение: после рестарта процесса
 * нумерация начинается заново, поэтому `run-A#100` и `run-B#1` нельзя
 * упорядочить по `sequence`. Тому, кому нужен общий порядок разных
 * run-ов, доступен {@link ingressEpochNanoseconds} — но это уже wall-clock
 * сравнение, а не строгий ordering-инвариант шины.
 *
 * @example
 * ```typescript
 * compareIngress(pmAt100, cexAt101); // → отрицательное (один run)
 * compareIngress(runAAt100, runBAt1); // → undefined (разные run-ы)
 * ```
 */
export function compareIngress(
  left: RecordedIngress,
  right: RecordedIngress,
): number | undefined {
  if (!isSameRun(left, right)) {
    return undefined;
  }
  return left.sequence - right.sequence;
}
