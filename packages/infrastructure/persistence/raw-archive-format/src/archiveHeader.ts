/**
 * Meta-строки (header-ы) raw-архивов: объявление формата и routing identity.
 *
 * @remarks
 * ### Почему header обязателен
 *
 * Reader НЕ должен угадывать формат по имени файла или по форме первой
 * data-строки. Формат объявляется явно, в LINE 1 файла:
 *
 * ```text
 * {"t":"meta","formatVersion":2, ...routing identity... }
 * {"type":"CEX_ORDERBOOK","ingress":{...},"payload":{...}}
 * {"type":"CEX_ORDERBOOK","ingress":{...},"payload":{...}}
 * ```
 *
 * Legacy-архивы старого коллектора header-а либо не имеют вовсе
 * (CEX-партиции), либо имеют meta-строку БЕЗ `formatVersion` (Polymarket).
 * Оба случая читаются как legacy — см. {@link detectRawArchiveFormat}.
 *
 * Legacy — это именно ОТСУТСТВИЕ версии. Объявленная, но неизвестная версия
 * (архив будущего коллектора) legacy НЕ является и читаться не должна.
 */
import { RAW_ARCHIVE_FORMAT_VERSION } from './RecordedExternalObservation.js';
import type { RawArchiveTimingQuality } from './RecordedExternalObservation.js';

/** Дискриминатор зарезервированной meta-строки архива. */
export const ARCHIVE_META_DISCRIMINATOR = 'meta';

/** Значение `source` в header-е CEX-партиции. */
export const CEX_ARCHIVE_SOURCE = 'CEX';

/** Тип потока CEX-партиции (стакан и сделки — разные физические файлы). */
export type CexArchiveStream = 'orderbook' | 'trades';

/**
 * Header CEX-партиции (LINE 1 файла партиции).
 *
 * @remarks
 * Несёт ПОЛНУЮ routing identity партиции: у payload-строк CCXT нет ни
 * биржи, ни типа рынка, а имя файла — не контракт. Canonical identity
 * транспорта — тройка `exchangeId + marketType + stream`; `symbol`
 * добавляет адрес инструмента внутри неё.
 */
export interface CexPartitionHeaderV2 {
  /** Дискриминатор зарезервированной meta-строки. */
  readonly t: typeof ARCHIVE_META_DISCRIMINATOR;
  /** Версия replayable raw-формата строк 2+. */
  readonly formatVersion: typeof RAW_ARCHIVE_FORMAT_VERSION;
  /** Источник архива (отличает CEX-партицию от market-файла Polymarket). */
  readonly source: typeof CEX_ARCHIVE_SOURCE;
  /** Идентификатор биржи в ccxt (`exchange.id`). */
  readonly exchangeId: string;
  /** Тип рынка CCXT-инстанса (`spot`/`future`/`swap`). */
  readonly marketType: string;
  /** Unified-символ инструмента (сырой, без санитизации имени файла). */
  readonly symbol: string;
  /** Поток партиции. */
  readonly stream: CexArchiveStream;
  /** Начало временнóго окна партиции (Unix ms, выровнено). */
  readonly windowStartMs: number;
  /** Конец временнóго окна партиции (Unix ms, эксклюзивно). */
  readonly windowEndMs: number;
  /** Начало окна в ISO-8601 UTC (человекочитаемый дубль `windowStartMs`). */
  readonly windowStartUTC: string;
  /** Конец окна в ISO-8601 UTC (человекочитаемый дубль `windowEndMs`). */
  readonly windowEndUTC: string;
}

/**
 * Собирает header CEX-партиции.
 *
 * @param identity - Routing identity партиции и границы её окна
 * @returns Готовый header-объект для LINE 1 файла партиции
 *
 * @example
 * ```typescript
 * const header = buildCexPartitionHeader({
 *   exchangeId: 'binance',
 *   marketType: 'swap',
 *   symbol: 'BTC/USDT:USDT',
 *   stream: 'orderbook',
 *   windowStartMs: 1786668000000,
 *   windowEndMs: 1786668300000,
 * });
 * ```
 */
export function buildCexPartitionHeader(identity: {
  readonly exchangeId: string;
  readonly marketType: string;
  readonly symbol: string;
  readonly stream: CexArchiveStream;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
}): CexPartitionHeaderV2 {
  return {
    t: ARCHIVE_META_DISCRIMINATOR,
    formatVersion: RAW_ARCHIVE_FORMAT_VERSION,
    source: CEX_ARCHIVE_SOURCE,
    exchangeId: identity.exchangeId,
    marketType: identity.marketType,
    symbol: identity.symbol,
    stream: identity.stream,
    windowStartMs: identity.windowStartMs,
    windowEndMs: identity.windowEndMs,
    windowStartUTC: new Date(identity.windowStartMs).toISOString(),
    windowEndUTC: new Date(identity.windowEndMs).toISOString(),
  };
}

/**
 * Читаемость архива, объявленная его header-ом.
 *
 * - `'V2'` — объявлен поддерживаемый {@link RAW_ARCHIVE_FORMAT_VERSION};
 * - `'LEGACY'` — версия НЕ объявлена вовсе (архив старого коллектора);
 * - `'UNSUPPORTED'` — версия объявлена, но этот decoder её не знает.
 *
 * @remarks
 * Legacy — это ОТСУТСТВИЕ версии, а не «любая версия, кроме нашей». Архив
 * будущего коллектора (`formatVersion: 3`) нельзя интерпретировать как
 * старый формат: его строки имеют неизвестную нам структуру, и выдача их за
 * legacy-наблюдения молча подменила бы данные. Такой архив читатель обязан
 * отвергнуть (fail closed), а не разбирать наугад.
 */
export type RawArchiveFormatKind = 'V2' | 'LEGACY' | 'UNSUPPORTED';

/**
 * Объявленный формат архива, определённый по его первой строке.
 */
export interface RawArchiveFormat {
  /** Читаемость архива по объявленной версии. */
  readonly kind: RawArchiveFormatKind;
  /**
   * Объявленная версия формата data-строк либо `undefined` — версия не
   * объявлена (legacy-архив).
   */
  readonly formatVersion: number | undefined;
  /**
   * Заняла ли meta-строка первую строку файла.
   *
   * @remarks
   * `false` означает, что первая строка — уже DATA (legacy CEX-партиции
   * пишутся без header-а): читатель обязан обработать её как наблюдение,
   * а не пропустить.
   */
  readonly headerConsumedFirstLine: boolean;
  /** Разобранная meta-строка (если она была) — как есть, без интерпретации. */
  readonly header: Readonly<Record<string, unknown>> | undefined;
  /**
   * Точность тайминга, которую даёт этот формат.
   *
   * @remarks
   * `undefined` при `kind: 'UNSUPPORTED'`: у архива, который мы не умеем
   * читать, нет и качества тайминга — обещать `LEGACY_APPROXIMATE` значило бы
   * утверждать, что его строки прочитаны хотя бы приблизительно.
   */
  readonly timingQuality: RawArchiveTimingQuality | undefined;
}

/** Максимальный epoch-ms, представимый в `Date` (ECMA-262 time-value range). */
const MAX_EPOCH_MS = 8.64e15;

/**
 * Представимо ли значение как epoch-ms внутри диапазона `Date`.
 *
 * @param value - Кандидат на метку времени
 * @returns `true` — целое число, которое `new Date(value).toISOString()`
 *   переведёт в ISO без RangeError
 */
function isRepresentableEpochMs(value: unknown): value is number {
  return Number.isSafeInteger(value) && Math.abs(value as number) <= MAX_EPOCH_MS;
}

/**
 * Является ли разобранная строка зарезервированной meta-строкой архива.
 *
 * @param value - Разобранное значение строки
 * @returns `true`, если это meta-строка (`t === 'meta'`)
 */
function isMetaRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)['t'] === ARCHIVE_META_DISCRIMINATOR
  );
}

/**
 * Определяет формат архива по его ПЕРВОЙ строке.
 *
 * @param firstLine - Первая строка файла (`undefined`/пустая — пустой архив)
 * @returns Объявленный формат: версия, был ли header, точность тайминга
 *
 * @remarks
 * Единственная санкционированная точка определения формата. Правило:
 *
 * ```text
 * первая строка — meta с formatVersion 2  → V2, EXACT_INGRESS
 * первая строка — meta без formatVersion  → LEGACY (старый коллектор)
 * первая строка — НЕ meta                 → LEGACY без header (data с LINE 1)
 * первая строка — meta с иной версией     → UNSUPPORTED (читать нельзя)
 * ```
 *
 * Никакого распознавания по имени файла и никакого вывода формата из формы
 * data-строки: это ровно те догадки, ради устранения которых header и
 * добавлен. Неизвестная объявленная версия — не legacy: её строки имеют
 * неизвестную нам структуру, и разбирать их наугад значило бы подменить
 * данные.
 *
 * @example
 * ```typescript
 * const format = detectRawArchiveFormat(firstLine);
 * if (!format.headerConsumedFirstLine) {
 *   handle(decodeRawArchiveLine(firstLine, format));
 * }
 * ```
 */
export function detectRawArchiveFormat(firstLine: string | undefined): RawArchiveFormat {
  /** Архив без meta-строки: LINE 1 (если есть) — уже данные legacy-формата. */
  const headerless: RawArchiveFormat = {
    kind: 'LEGACY',
    formatVersion: undefined,
    headerConsumedFirstLine: false,
    header: undefined,
    timingQuality: 'LEGACY_APPROXIMATE',
  };

  if (firstLine === undefined || firstLine.length === 0) {
    return headerless;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return headerless;
  }

  if (!isMetaRecord(parsed)) {
    // Legacy CEX-партиция: header-а нет вовсе, LINE 1 — уже наблюдение
    return headerless;
  }

  const declared = parsed['formatVersion'];
  if (declared === undefined) {
    // Legacy market-файл старого коллектора: meta есть, версии нет
    return {
      kind: 'LEGACY',
      formatVersion: undefined,
      headerConsumedFirstLine: true,
      header: parsed,
      timingQuality: 'LEGACY_APPROXIMATE',
    };
  }

  if (declared === RAW_ARCHIVE_FORMAT_VERSION) {
    return {
      kind: 'V2',
      formatVersion: RAW_ARCHIVE_FORMAT_VERSION,
      headerConsumedFirstLine: true,
      header: parsed,
      timingQuality: 'EXACT_INGRESS',
    };
  }

  // Версия объявлена, но неизвестна (либо объявлена не числом — испорченный
  // header): строки имеют неизвестную нам структуру. Читать их как legacy —
  // значит молча подменить данные.
  return {
    kind: 'UNSUPPORTED',
    formatVersion: typeof declared === 'number' ? declared : undefined,
    headerConsumedFirstLine: true,
    header: parsed,
    timingQuality: undefined,
  };
}

/**
 * Читает header CEX-партиции из объявленного формата.
 *
 * @param format - Формат, определённый {@link detectRawArchiveFormat}
 * @returns Типизированный header партиции либо `undefined`, если это не
 *   V2-header CEX-партиции
 *
 * @remarks
 * Возвращает `undefined` и для market-файла Polymarket (там нет `source`),
 * и для legacy-партиции без header-а — вызывающий обязан различать
 * «CEX-партиция V2» и «что-то другое» по результату, а не по имени файла.
 */
export function readCexPartitionHeader(
  format: RawArchiveFormat,
): CexPartitionHeaderV2 | undefined {
  const header = format.header;
  if (header === undefined || format.kind !== 'V2') {
    return undefined;
  }
  if (header['source'] !== CEX_ARCHIVE_SOURCE) {
    return undefined;
  }
  const { exchangeId, marketType, symbol, stream, windowStartMs, windowEndMs } = header;
  if (
    typeof exchangeId !== 'string' ||
    typeof marketType !== 'string' ||
    typeof symbol !== 'string' ||
    (stream !== 'orderbook' && stream !== 'trades') ||
    !isRepresentableEpochMs(windowStartMs) ||
    !isRepresentableEpochMs(windowEndMs) ||
    windowEndMs <= windowStartMs
  ) {
    // Испорченный header — не исключение, а «это не V2-header CEX-партиции».
    // Проверка границ обязана быть ЗДЕСЬ: buildCexPartitionHeader строит
    // ISO-дубли через `new Date(...).toISOString()`, который на NaN и на
    // выходящих за диапазон Date значениях бросает RangeError — читатель
    // архива получил бы исключение вместо `undefined`.
    return undefined;
  }
  return buildCexPartitionHeader({
    exchangeId,
    marketType,
    symbol,
    stream,
    windowStartMs,
    windowEndMs,
  });
}
