/**
 * Canonical decoder replayable raw-архива на persistence/replay-границе.
 *
 * @remarks
 * ### Что decoder обязан отдать
 *
 * ```text
 * archive line
 *      ↓
 * DecodedObservation { type, payload, ingress, timingQuality }
 *      ↓
 * Replay Source → ТОТ ЖЕ ExternalMessageBus → ТЕ ЖЕ Semantic Adapters
 * ```
 *
 * - `payload` — НЕИЗМЕНЁННЫЙ source-native payload (то же, что видел бы
 *   semantic adapter в live);
 * - `type` — внешний discriminator, чтобы replay опубликовал наблюдение на
 *   ту же typed-подписку;
 * - `ingress` — ИСТОРИЧЕСКИЙ порядок/момент наблюдения.
 *
 * ### Historical ≠ replay-runtime metadata
 *
 * Decoder НИКОГДА не возвращает `MessageMetadata` и не собирает
 * `ExternalMessage`. При replay сообщение получит СВОЮ runtime metadata
 * (новый `runId`, новый `sequence`, новый момент создания), а исторический
 * `ingress` — вход для simulator/replay scheduler-а, воспроизводящего
 * временную линию. Смешать одно с другим значило бы выдать записанное
 * прошлое за наблюдение нового процесса.
 *
 * DecisionScheduler и virtual-time backtester здесь НЕ реализуются —
 * decoder только отдаёт факты архива.
 */
import type {
  RecordedExternalObservationV2,
  RecordedIngress,
} from './RecordedExternalObservation.js';
import { RAW_ARCHIVE_FORMAT_VERSION } from './RecordedExternalObservation.js';
import { detectRawArchiveFormat } from './archiveHeader.js';
import type { RawArchiveFormat } from './archiveHeader.js';

/**
 * Прочитанное наблюдение архива.
 *
 * @remarks
 * Discriminated union по `timingQuality`: у legacy-строки НЕТ ни `type`, ни
 * `ingress` — типы не позволяют случайно прочитать несуществующий точный
 * тайминг legacy-архива.
 */
export type DecodedObservation =
  | {
      readonly timingQuality: 'EXACT_INGRESS';
      /** Внешний discriminator сообщения. */
      readonly type: string;
      /** Исторический порядок/момент наблюдения. */
      readonly ingress: RecordedIngress;
      /** НЕИЗМЕНЁННЫЙ source-native payload. */
      readonly payload: unknown;
    }
  | {
      readonly timingQuality: 'LEGACY_APPROXIMATE';
      /** У legacy-строки внешнего discriminator-а нет. */
      readonly type: undefined;
      /** У legacy-строки ingress-метки нет — реконструкция не выдумывается. */
      readonly ingress: undefined;
      /** Строка legacy-архива как есть (payload старого формата). */
      readonly payload: unknown;
    };

/**
 * Проверяет структурную полноту ingress-метки.
 *
 * @param value - Кандидат на ingress
 * @returns `true`, если все обязательные поля присутствуют и корректны
 *
 * @remarks
 * Требуются ВСЕ поля: неполный ingress означал бы неизвестно чем испорченный
 * порядок, а `EXACT_INGRESS` — обещание точности, которое нельзя давать
 * наполовину.
 */
function isRecordedIngress(value: unknown): value is RecordedIngress {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['runId'] === 'string' &&
    candidate['runId'].length > 0 &&
    Number.isInteger(candidate['sequence']) &&
    Number.isInteger(candidate['createdAtUnixSeconds']) &&
    Number.isInteger(candidate['millisecondOfSecond']) &&
    Number.isInteger(candidate['microsecondOfMillisecond']) &&
    Number.isInteger(candidate['nanosecondOfMicrosecond'])
  );
}

/**
 * Проверяет, что разобранное значение — V2-наблюдение.
 *
 * @param value - Разобранная строка архива
 * @returns `true`, если это {@link RecordedExternalObservationV2}
 */
export function isRecordedObservationV2(
  value: unknown,
): value is RecordedExternalObservationV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['type'] === 'string' &&
    candidate['type'].length > 0 &&
    'payload' in candidate &&
    isRecordedIngress(candidate['ingress'])
  );
}

/**
 * Декодирует одну data-строку архива в соответствии с ОБЪЯВЛЕННЫМ форматом.
 *
 * @param line - Data-строка архива (не meta-строка)
 * @param format - Формат, определённый `detectRawArchiveFormat` по LINE 1
 * @returns Прочитанное наблюдение либо `undefined` для нечитаемой строки
 *   (пустая, невалидный JSON, либо строка V2-архива без валидного конверта)
 *
 * @remarks
 * Формат берётся ИЗ HEADER-а, а не угадывается по форме строки: в архиве,
 * объявившем `formatVersion: 2`, строка без валидного конверта — это
 * повреждение, а не «наверное, legacy». Так испорченная строка становится
 * видимой (`undefined`), а не молча превращается в legacy-наблюдение с
 * приблизительным таймингом.
 *
 * @example
 * ```typescript
 * const format = detectRawArchiveFormat(lines[0]);
 * for (const line of lines.slice(format.headerConsumedFirstLine ? 1 : 0)) {
 *   const observation = decodeRawArchiveLine(line, format);
 *   if (observation?.timingQuality === 'EXACT_INGRESS') {
 *     scheduler.enqueue(observation.ingress, observation.type, observation.payload);
 *   }
 * }
 * ```
 */
export function decodeRawArchiveLine(
  line: string,
  format: RawArchiveFormat,
): DecodedObservation | undefined {
  if (line.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (format.formatVersion === RAW_ARCHIVE_FORMAT_VERSION) {
    if (!isRecordedObservationV2(parsed)) {
      return undefined; // объявлен V2, но конверта нет — повреждённая строка
    }
    return {
      timingQuality: 'EXACT_INGRESS',
      type: parsed.type,
      ingress: parsed.ingress,
      payload: parsed.payload,
    };
  }

  return {
    timingQuality: 'LEGACY_APPROXIMATE',
    type: undefined,
    ingress: undefined,
    payload: parsed,
  };
}

/**
 * Декодирует строку, отделённую от своего header-а.
 *
 * @param line - Data-строка архива
 * @returns Прочитанное наблюдение либо `undefined` для невалидного JSON
 *
 * @remarks
 * Узкая точка входа для вызывающих, которые получают строки УЖЕ БЕЗ первой
 * meta-строки и потому не могут прочитать объявленный формат (например,
 * `DataRecorder.readSealedPayloadLines`). Формат здесь определяется
 * структурно: валидный V2-конверт → `EXACT_INGRESS`, иначе → legacy.
 *
 * Это осознанное послабление ТОЛЬКО для такого случая. File-level reader
 * обязан идти через `detectRawArchiveFormat` + {@link decodeRawArchiveLine}:
 * угадывание формата по data-строке — ровно то, что header отменяет.
 */
export function decodeDetachedArchiveLine(line: string): DecodedObservation | undefined {
  if (line.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (isRecordedObservationV2(parsed)) {
    return {
      timingQuality: 'EXACT_INGRESS',
      type: parsed.type,
      ingress: parsed.ingress,
      payload: parsed.payload,
    };
  }
  return {
    timingQuality: 'LEGACY_APPROXIMATE',
    type: undefined,
    ingress: undefined,
    payload: parsed,
  };
}

/**
 * Результат чтения архива целиком (in-memory путь).
 */
export interface DecodedRawArchive {
  /** Объявленный формат архива (из LINE 1). */
  readonly format: RawArchiveFormat;
  /**
   * Наблюдения в ФАЙЛОВОМ порядке строк.
   *
   * @remarks
   * Порядок строк файла сохраняется строго и никогда не пересортировывается
   * по vendor-timestamp: для legacy-архива порядок строк — единственная
   * достоверная информация о последовательности наблюдений.
   */
  readonly observations: readonly DecodedObservation[];
  /** Число строк, которые не удалось декодировать (наблюдаемость потерь). */
  readonly malformedLines: number;
}

/**
 * Читает архив целиком: определяет формат по LINE 1 и декодирует остальное.
 *
 * @param lines - Строки файла В ФАЙЛОВОМ ПОРЯДКЕ (пустые допускаются)
 * @returns Формат, наблюдения в порядке строк и счётчик нечитаемых строк
 *
 * @remarks
 * Legacy-архивы читаются тем же вызовом и получают
 * `timingQuality: 'LEGACY_APPROXIMATE'`; их строки НЕ переписываются, НЕ
 * мигрируются и НЕ сортируются. Фиктивный `sequence` для legacy не
 * выдумывается — его отсутствие и есть честный ответ.
 *
 * @example
 * ```typescript
 * const archive = decodeRawArchive(lines);
 * archive.format.timingQuality; // 'EXACT_INGRESS' | 'LEGACY_APPROXIMATE'
 * ```
 */
export function decodeRawArchive(lines: readonly string[]): DecodedRawArchive {
  // Формат объявляет ПЕРВАЯ НЕПУСТАЯ строка: ведущие пустые строки не
  // являются данными и не могут отменить наличие header-а
  const firstIndex = lines.findIndex((line) => line.length > 0);
  const format = detectRawArchiveFormat(firstIndex === -1 ? undefined : lines[firstIndex]);

  const observations: DecodedObservation[] = [];
  let malformedLines = 0;

  const startIndex =
    firstIndex === -1 ? lines.length : firstIndex + (format.headerConsumedFirstLine ? 1 : 0);
  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.length === 0) {
      continue;
    }
    const observation = decodeRawArchiveLine(line, format);
    if (observation === undefined) {
      malformedLines++;
      continue;
    }
    observations.push(observation);
  }

  return { format, observations, malformedLines };
}
