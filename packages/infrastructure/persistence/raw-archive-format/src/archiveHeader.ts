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
 * Объявленный формат архива, определённый по его первой строке.
 */
export interface RawArchiveFormat {
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
  /** Точность тайминга, которую даёт этот формат. */
  readonly timingQuality: RawArchiveTimingQuality;
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
 * первая строка — meta с formatVersion 2 → V2, EXACT_INGRESS
 * первая строка — meta без formatVersion  → legacy (старый коллектор)
 * первая строка — НЕ meta                 → legacy без header (data с LINE 1)
 * ```
 *
 * Никакого распознавания по имени файла и никакого вывода формата из формы
 * data-строки: это ровно те догадки, ради устранения которых header и
 * добавлен.
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
  if (firstLine === undefined || firstLine.length === 0) {
    return {
      formatVersion: undefined,
      headerConsumedFirstLine: false,
      header: undefined,
      timingQuality: 'LEGACY_APPROXIMATE',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return {
      formatVersion: undefined,
      headerConsumedFirstLine: false,
      header: undefined,
      timingQuality: 'LEGACY_APPROXIMATE',
    };
  }

  if (!isMetaRecord(parsed)) {
    // Legacy CEX-партиция: header-а нет вовсе, LINE 1 — уже наблюдение
    return {
      formatVersion: undefined,
      headerConsumedFirstLine: false,
      header: undefined,
      timingQuality: 'LEGACY_APPROXIMATE',
    };
  }

  const declared = parsed['formatVersion'];
  const formatVersion = typeof declared === 'number' ? declared : undefined;
  return {
    formatVersion,
    headerConsumedFirstLine: true,
    header: parsed,
    timingQuality:
      formatVersion === RAW_ARCHIVE_FORMAT_VERSION ? 'EXACT_INGRESS' : 'LEGACY_APPROXIMATE',
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
  if (header === undefined || format.formatVersion !== RAW_ARCHIVE_FORMAT_VERSION) {
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
    typeof windowStartMs !== 'number' ||
    typeof windowEndMs !== 'number'
  ) {
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
