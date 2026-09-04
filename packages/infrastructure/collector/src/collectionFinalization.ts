/**
 * Canonical DTO финализации рынка и обогащение market header-а её итогом.
 *
 * @remarks
 * ### Почему типы живут ЗДЕСЬ
 *
 * До cutover они принадлежали legacy `@polymarket/collection-coordinator`
 * вместе с его сборщиком header-а версии 1. Координатор перестал быть
 * canonical runtime, а сами DTO — нет: это ФОРМАТ артефакта, который читают
 * и writer (finalizer), и все читатели архивов. Поэтому они переезжают в
 * canonical пакет collection-контура, а legacy-координатор их отсюда
 * реэкспортирует — второго набора одинаковых DTO в репозитории быть не
 * должно.
 *
 * ### Обогащение, а не пересборка header-а
 *
 * ```text
 * LINE 1 при допуске рынка (gate)          LINE 1 после финализации
 * ────────────────────────────────         ────────────────────────────────
 * { headerVersion: 2,                      { headerVersion: 2,
 *   source, conditionId, question,           source, conditionId, question,
 *   outcomes, family,                        outcomes, family,
 *   timing: { startsAt, expiresAt },         timing: { …, recordingStartsAt },
 *   crypto }                                 crypto,
 *                                            finalization: { … } }
 * ```
 *
 * Финализация ДОБАВЛЯЕТ раздел к тому же canonical header-у, а не заменяет
 * его vendor-формой legacy. Возврат к `headerVersion: 1` означал бы два
 * несовместимых shape под разными версиями в одном датасете: читатель,
 * диспетчеризующий по `headerVersion`, увидел бы у одного и того же рынка
 * V2-строку при регистрации и V1-строку после архивации.
 */
import type { InstrumentId } from '@polymarket/ids';
import type { MarketMeta } from '@polymarket/ports';

/**
 * Зеркало `META_RESERVED_BYTES` DataRecorder — фиксированный блок LINE 1.
 *
 * @remarks
 * Константа не экспортируется storage-пакетом, а прямая зависимость
 * collection-слоя от `@polymarket/data-collection` не нужна (файлы пишет
 * recorder). Значение — часть recording-контракта формата V2
 * (см. `docs/data-collection.md`); дублируется здесь осознанно.
 */
const STORAGE_META_RESERVED_BYTES = 16 * 1024;

/**
 * Защитный запас поверх точного probe-замера: формат строки storage может
 * незначительно отличаться (перестановка/добавление служебного поля).
 */
const META_ENVELOPE_SAFETY_MARGIN_BYTES = 256;

/**
 * Финальный исход одного инструмента рынка (нейтральная форма, без vendor
 * yes/no): метка, canonical identity и точная цена vendor-представлением.
 */
export interface CollectionFinalOutcome {
  /** Метка исхода как её отдал SDK (`Up`/`Down`/`Yes`/...). */
  readonly label: string;
  /** Canonical identity инструмента исхода. */
  readonly instrumentId: InstrumentId;
  /** Итоговая цена исхода (DecimalString vendor-а as-is; отсутствует, если Gamma не дал). */
  readonly price?: string;
}

/**
 * Как получен итог рынка (MR-B PART 40).
 *
 * @remarks
 * Отвечает на вопрос «КАК мы это узнали?», отдельно от вопроса «когда
 * закончилось ожидание». `'official'` — итог пришёл от Gamma/UMA;
 * `'fallback-chainlink-twap'` — выведен из записанного официального
 * settlement-потока по правилу самого рынка.
 */
export type CollectionResolutionProvenance = 'official' | 'fallback-chainlink-twap';

/**
 * Что заставило перейти к fallback-деривации (MR-B PART 6).
 *
 * @remarks
 * Таймаут — ТРИГГЕР, а не результат: он лишь объясняет, почему перестали
 * ждать официальную резолюцию. Сам результат при этом полноценный.
 */
export type CollectionFallbackTrigger = 'official-timeout' | 'shutdown';

/** Происхождение одного settlement-числа (MR-B PART 41). */
export type CollectionPriceProvenance = 'official' | 'derived';

/**
 * Основания fallback-деривации (MR-B PART 43).
 *
 * @remarks
 * Достаточно, чтобы ВОСПРОИЗВЕСТИ решение по архиву: какой фид, какое
 * окно, какие два наблюдения (значение + vendor-timestamp) и какие
 * границы рынка сравнивались.
 */
export interface CollectionFallbackEvidence {
  /** Символ settlement-потока (`btc/usd`). */
  readonly symbol: string;
  /** Окно усреднения TWAP (секунды). */
  readonly windowSeconds: number;
  /** Значение-эталон открытия окна. */
  readonly priceToBeatValue: string;
  /** Vendor-timestamp наблюдения открытия. */
  readonly priceToBeatTimestampMs: number;
  /** Значение-эталон закрытия окна. */
  readonly finalPriceValue: string;
  /** Vendor-timestamp наблюдения закрытия. */
  readonly finalPriceTimestampMs: number;
  /** Официальное открытие окна рынка (epoch ms). */
  readonly marketStartMs: number;
  /** Официальное закрытие окна рынка (epoch ms). */
  readonly marketEndMs: number;
  /** Сколько наблюдений фида нашлось в датасете. */
  readonly observations: number;
}

/**
 * Нормализованный settlement-дескриптор рынка в header-е (MR-B PART 42).
 *
 * @remarks
 * Дублирует то, что в принципе выводимо из vendor-данных, но в РАБОЧЕЙ
 * форме: потребителю архива не нужно ни парсить URL, ни знать про формат
 * стримов Chainlink, чтобы понять правило расчёта.
 */
export interface CollectionSettlementDescriptor {
  /** Вид правила расчёта. */
  readonly kind: 'chainlink-twap';
  /** Vendor topic settlement-потока. */
  readonly topic: string;
  /** Символ потока (`btc/usd`). */
  readonly symbol: string;
  /** Окно усреднения (секунды). */
  readonly windowSeconds: number;
  /** Исходный `resolution.source` рынка. */
  readonly resolutionSource: string;
}

/**
 * Finalization-раздел canonical market header-а.
 *
 * @remarks
 * Это КРИТИЧЕСКИЕ данные архива: по ним читатель узнаёт итог рынка и то,
 * откуда этот итог взялся. Раздел целиком принадлежит CORE header-а и
 * усекается последним (см. {@link buildFinalizedMarketHeader}).
 */
export interface CollectionHeaderFinalization {
  /**
   * `'pending'` — enrichment ещё идёт (промежуточный header);
   * `'complete'` — итог известен, датасет пригоден к replay;
   * `'timeout'` — архив best-known данных по истечении бюджета ожидания.
   *
   * @remarks
   * Для рынков с распознанным settlement-дескриптором `'timeout'` больше
   * НЕ появляется в завершённом архиве (MR-B PART 6): исчерпание бюджета
   * — это триггер fallback-деривации, а не итог. Либо результат известен и
   * статус `'complete'`, либо архив не создаётся вовсе. Значение сохранено
   * в union ради рынков вне поддержанного scope (Binance-источник,
   * не-крипто) и ради читаемости уже существующих архивов.
   */
  readonly status: 'pending' | 'complete' | 'timeout';
  /** Момент перехода в FINALIZING (epoch ms — конвенция timing-раздела). */
  readonly startedAtMs: number;
  /** Момент финального решения (present для complete/timeout). */
  readonly finalizedAtMs?: number;
  /** Количество enrichment-попыток. */
  readonly attempts: number;
  /** Правило расчёта рынка, если оно распознано. */
  readonly settlement?: CollectionSettlementDescriptor;
  /** Сводка свежего resolution-состояния Gamma (строки vendor as-is). */
  readonly resolution?: {
    readonly closed?: boolean;
    readonly closedTime?: string;
    readonly umaResolutionStatus?: string;
  };
  /** Итоговые исходы с ценами (нейтральная форма). */
  readonly outcomes?: readonly CollectionFinalOutcome[];
  /**
   * Победивший исход с происхождением (winner-ladder, решение user 2026-08-25).
   *
   * @remarks
   * `source` — как получен победитель (по убыванию приоритета):
   * - `'resolution'` — официальные resolved settlement-цены UMA (1/0);
   * - `'official-prices'` — формула рынка на официальных
   *   `priceToBeat`/`finalPrice` (`finalPrice >= priceToBeat → Up`);
   * - `'recorded-twap'` — deterministic-деривация из ЗАПИСАННОГО
   *   официального settlement-потока TWAP по границам рынка;
   * - `'recorded-rtds'` — приблизительная деривация из записанного
   *   chainlink-СПОТА (legacy-ступень для рынков ВНЕ поддержанного
   *   TWAP-scope; для TWAP-рынков не применяется).
   *
   * `exact` — точный результат (официальная резолюция/формула либо
   * `'recorded-twap'` по точным границам) или приблизительный
   * (`'recorded-rtds'`). `outcomeIndex` — позиция исхода в canonical
   * `outcomes[]` того же header-а; `instrumentId` — машинная identity
   * (CLOB tokenId). Порядок исходов НЕ предполагается: индекс всегда
   * находится сопоставлением, а не константой.
   */
  readonly winning?: {
    readonly label: string;
    readonly instrumentId: InstrumentId;
    /** Позиция победителя в `outcomes[]` (никогда не «Up = 0» по умолчанию). */
    readonly outcomeIndex: number;
    readonly source: 'resolution' | 'official-prices' | 'recorded-twap' | 'recorded-rtds';
    readonly exact: boolean;
    readonly basis?: { readonly startValue: string; readonly endValue: string };
  };
  /**
   * Происхождение итога и чисел, на которых он построен (PART 40/41/43).
   *
   * @remarks
   * Присутствует у любого завершённого архива. Разделяет два независимых
   * вопроса: КАК получен победитель (`resolution`) и откуда взялось каждое
   * из settlement-чисел (`priceToBeat`/`finalPrice`) — derived-значение
   * никогда не выдаётся за официальное.
   */
  readonly provenance?: {
    /** Как получен победитель. */
    readonly resolution: CollectionResolutionProvenance;
    /** Что заставило прекратить ожидание официальной резолюции. */
    readonly fallbackTrigger?: CollectionFallbackTrigger;
    /** Происхождение `crypto.priceToBeat`. */
    readonly priceToBeat?: CollectionPriceProvenance;
    /** Происхождение `crypto.finalPrice`. */
    readonly finalPrice?: CollectionPriceProvenance;
    /** Основания fallback-деривации (только при fallback). */
    readonly evidence?: CollectionFallbackEvidence;
  };
  /**
   * Крипто-значения рынка (точное строковое представление).
   *
   * @remarks
   * Официальные значения Gamma, а при их отсутствии — выведенные из
   * записанного settlement-потока. Что именно лежит в каждом поле,
   * говорит `provenance.priceToBeat` / `provenance.finalPrice`.
   */
  readonly crypto?: { readonly priceToBeat?: string; readonly finalPrice?: string };
}

/** Вход {@link buildFinalizedMarketHeader}. */
export interface FinalizedMarketHeaderInput {
  /**
   * Canonical V2 header, записанный при допуске рынка (LINE 1 датасета).
   *
   * @remarks
   * Ровно тот объект, который построил `PolymarketCollectionGate`. Он —
   * БАЗА: identity/timing/outcomes/крипто-номинал не пересчитываются и не
   * подменяются vendor-формой.
   */
  readonly baseHeader: Record<string, unknown>;
  /** Регистрация рынка — внешние поля meta-строки storage (бюджет). */
  readonly marketMeta: MarketMeta;
  /** Момент начала записи (первое наблюдение) — уходит в `timing`. */
  readonly recordingStartsAtMs: number;
  /** Итог финализации. */
  readonly finalization: CollectionHeaderFinalization;
}

/**
 * Обогащает canonical V2 header итогом финализации рынка.
 *
 * @param input - База, регистрация и раздел финализации
 * @returns Header для `updateMarketMeta()` либо `undefined`, если даже
 *   усечённый вариант не помещается в meta-блок storage — вызывающий обязан
 *   явно обработать это как отказ финализации, а не молча записать обрезок
 *
 * @remarks
 * Алгоритм:
 * 1. базовый header копируется как есть; `timing` дополняется
 *    `recordingStartsAt` (момент первой записанной строки);
 * 2. добавляется раздел `finalization`;
 * 3. если полная строка не помещается в зарезервированный блок LINE 1 —
 *    из `finalization` выбрасывается самая объёмная НЕкритическая часть
 *    (`outcomes`), а факт усечения фиксируется полем `truncated`;
 * 4. если не помещается и ядро — header собрать нельзя.
 *
 * Победитель, происхождение и settlement-числа не усекаются НИКОГДА: архив,
 * потерявший итог рынка, хуже отсутствия архива.
 *
 * Бюджет считается по probe-конверту ТОЙ ЖЕ формы, что собирает storage
 * (`{t, formatVersion, ts, marketId, question, tokenIds, m}`), а не по
 * одному лишь `m`: проверка «влезает ли payload» пропустила бы строку,
 * которую storage отвергает целиком.
 *
 * @example
 * ```typescript
 * const header = buildFinalizedMarketHeader({
 *   baseHeader, marketMeta, recordingStartsAtMs, finalization,
 * });
 * if (header !== undefined) await recorder.updateMarketMeta(marketId, header);
 * ```
 */
export function buildFinalizedMarketHeader(
  input: FinalizedMarketHeaderInput,
): Record<string, unknown> | undefined {
  const { baseHeader, marketMeta, recordingStartsAtMs, finalization } = input;

  const baseTiming =
    typeof baseHeader['timing'] === 'object' && baseHeader['timing'] !== null
      ? (baseHeader['timing'] as Record<string, unknown>)
      : {};
  const enriched: Record<string, unknown> = {
    ...baseHeader,
    timing: { ...baseTiming, recordingStartsAt: recordingStartsAtMs },
    finalization,
  };
  if (fitsMetaBlock(enriched, marketMeta)) {
    return enriched;
  }

  const { outcomes: _dropped, ...finalizationCore } = finalization;
  const truncated: Record<string, unknown> = {
    ...enriched,
    finalization: finalizationCore,
    truncated: ['finalization.outcomes'],
  };
  if (fitsMetaBlock(truncated, marketMeta)) {
    return truncated;
  }
  return undefined;
}

/**
 * Проверяет, поместится ли ПОЛНАЯ meta-строка storage с данным header-ом
 * в зарезервированный блок первой строки.
 *
 * @param header - Кандидат header-объекта (значение ключа `m`)
 * @param marketMeta - Регистрация рынка (внешние поля meta-строки)
 * @returns `true`, если probe-конверт в пределах бюджета
 *
 * @remarks
 * `ts` в probe — репрезентативный epoch-ms той же разрядности, что пишет
 * storage; на длину JSON он влияет одинаково при любом реальном значении.
 */
function fitsMetaBlock(header: Record<string, unknown>, marketMeta: MarketMeta): boolean {
  const envelopeProbe = {
    t: 'meta',
    formatVersion: 2,
    ts: marketMeta.expiresAt.toNumber(),
    marketId: String(marketMeta.marketId),
    question: marketMeta.question,
    tokenIds: [...marketMeta.tokenIds],
    m: header,
  };
  const envelopeBytes = Buffer.byteLength(JSON.stringify(envelopeProbe), 'utf8');
  return envelopeBytes <= STORAGE_META_RESERVED_BYTES - 1 - META_ENVELOPE_SAFETY_MARGIN_BYTES;
}
