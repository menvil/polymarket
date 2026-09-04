/**
 * Сборка initial market header (LINE 1) для регистрации recording-сессии.
 *
 * @remarks
 * N-002 зафиксировал формат файла: LINE 1 — market header (meta), LINE 2+ —
 * source-native события. Заголовок собирается ЗДЕСЬ (control plane) из
 * SDK-normalized данных выбранного рынка и уходит в storage как
 * `MarketMeta.rawMarket` (ключ `m` первой строки).
 *
 * ### Состав header (N-003 PART 8)
 *
 * - identity: conditionId / gammaMarketId / slug;
 * - question и исходы с token ids;
 * - identity события (id/slug/title), если есть;
 * - timing: точное время начала события (если известно), истечение,
 *   момент начала записи (recordingStartsAt = открытие сессии, PART 9);
 * - RTDS-маппинг рынка (vendor topic + symbol);
 * - initial Gamma state: полный normalized SDK Market и Event.
 *
 * Это V2-формат заголовка: legacy raw Gamma JSON байт-в-байт сознательно
 * НЕ воспроизводится (PART 8), но полезные source-метаданные сохраняются
 * целиком через typed SDK-модели.
 *
 * ### Бюджет размера — ПОЛНЫЙ meta-конверт storage
 *
 * Storage резервирует под первую строку фиксированный блок 16 KiB
 * (`META_RESERVED_BYTES` DataRecorder) и проверяет размер ВСЕЙ meta-строки
 * (`{t, formatVersion, ts, marketId, question, tokenIds, m}`), а не только
 * payload `m` — превышение роняет активацию регистрации. Поэтому бюджет
 * здесь считается по probe-конверту той же формы, что собирает storage.
 * Деградация по бюджету: сначала выбрасывается `gammaEvent`, затем
 * `gammaMarket`; если даже ядро (identity/timing/RTDS) не помещается —
 * header собрать НЕЛЬЗЯ, возвращается `undefined`, и открытие сессии
 * обязано явно отказать ДО каких-либо подписок. Вложенные
 * `gammaEvent.markets` выбрасываются безусловно — они дублируют
 * `gammaMarket`.
 */
import type { Timestamp } from '@polymarket/timestamp';
import type {
  PolymarketGammaEvent,
  PolymarketGammaMarket,
  SelectedPolymarketMarket,
} from '@polymarket/polymarket-v2';
import { CHAINLINK_TWAP_TOPIC } from '@polymarket/polymarket-v2';
import type {
  CollectionHeaderFinalization,
  CollectionSettlementDescriptor,
} from '@polymarket/collector';

/**
 * Зеркало `META_RESERVED_BYTES` DataRecorder — фиксированный блок LINE 1.
 *
 * @remarks
 * Константа не экспортируется storage-пакетом, а прямая зависимость
 * координатора от `@polymarket/data-collection` запрещена границей PART 44
 * (файлы пишет recorder). Значение — часть recording-контракта формата V2
 * (см. `docs/data-collection.md`); дублируется здесь осознанно.
 */
const STORAGE_META_RESERVED_BYTES = 16 * 1024;

/**
 * Защитный запас поверх точного probe-замера: формат строки storage может
 * незначительно отличаться (перестановка/добавление служебного поля).
 */
const META_ENVELOPE_SAFETY_MARGIN_BYTES = 256;

/**
 * Canonical DTO финализации — РЕЭКСПОРТ из `@polymarket/collector`.
 *
 * @remarks
 * Формат finalization-раздела header-а принадлежит canonical пакету
 * collection-контура: его пишет `MarketFinalizer` и читают все потребители
 * архивов. Legacy-координатор эти типы только реэкспортирует, чтобы уже
 * существующие импорты продолжали работать до его удаления, — второй набор
 * одинаковых DTO завёл бы два расходящихся определения одного артефакта.
 */
export type {
  CollectionFallbackEvidence,
  CollectionFallbackTrigger,
  CollectionFinalOutcome,
  CollectionHeaderFinalization,
  CollectionPriceProvenance,
  CollectionResolutionProvenance,
  CollectionSettlementDescriptor,
} from '@polymarket/collector';

/**
 * Вход единого билдера header-а: initial-регистрация и enrichment/final
 * обновления строятся ОДНОЙ логикой (один формат, один бюджет, одна
 * политика усечения — N-004 PART 23).
 */
export interface CollectionHeaderInput {
  /** Подготовленный выбранный рынок (Discovery V2). */
  readonly selected: SelectedPolymarketMarket;
  /** Момент начала записи (= открытие сессии). */
  readonly recordingStartsAt: Timestamp;
  /** Свежий Gamma Market (fallback — initial из `selected`). */
  readonly gammaMarket?: PolymarketGammaMarket;
  /** Свежий Gamma Event (fallback — initial из `selected`). */
  readonly gammaEvent?: PolymarketGammaEvent;
  /** Finalization-сводка (отсутствует у initial header-а). */
  readonly finalization?: CollectionHeaderFinalization;
}

/**
 * Собирает V2 market header для `registerMarket()`/`updateMarketMeta()`.
 *
 * @param input - Вход билдера (см. {@link CollectionHeaderInput})
 * @returns Header-объект для `MarketMeta.rawMarket` (ключ `m` первой строки)
 *   либо `undefined`, если даже усечённое ядро не помещается в meta-блок
 *   storage — вызывающий обязан отказать (initial) либо явно обработать
 *   ошибку финализации (final)
 *
 * @remarks
 * Деградация по бюджету наблюдаема по полю `truncated`: `undefined` —
 * полный header; `['gammaEvent']` или `['gammaEvent', 'gammaMarket']` —
 * что было выброшено. `finalization` — часть CORE и никогда не усечётся
 * раньше vendor-снапшотов. Бюджет проверяется по probe полного meta-конверта
 * storage (включая `question`/`tokenIds` внешней строки), а не только `m`.
 *
 * @example
 * ```typescript
 * const header = buildCollectionHeader({ selected, recordingStartsAt: startsAt });
 * if (header === undefined) {
 *   // рынок нельзя зарегистрировать — отказ ДО подписок
 * }
 * ```
 */
export function buildCollectionHeader(
  input: CollectionHeaderInput,
): Record<string, unknown> | undefined {
  const { selected, recordingStartsAt, finalization } = input;
  const gammaMarket = input.gammaMarket ?? selected.gammaMarket;
  const sourceEvent = input.gammaEvent ?? selected.gammaEvent;
  // gammaEvent.markets дублируют gammaMarket — не пишем их в header никогда
  const gammaEventWithoutMarkets =
    sourceEvent !== undefined ? { ...sourceEvent, markets: [] } : undefined;

  const core: Record<string, unknown> = {
    headerVersion: 1,
    // Идентичность ИСТОЧНИКА (venue), а не имя пакета: версию формата несут
    // formatVersion (внешняя meta) + headerVersion — временное «-v2» пакета
    // в persistent-артефакты не записывается
    source: 'polymarket',
    // Canonical MarketId ЕСТЬ conditionId (routing identity) — в артефакте
    // поле сохраняет vendor-контекстное имя
    conditionId: String(selected.marketId),
    gammaMarketId: selected.gammaMarketId,
    ...(selected.slug !== undefined ? { slug: selected.slug } : {}),
    question: selected.question,
    outcomes: selected.outcomes,
    ...(selected.event !== undefined ? { event: selected.event } : {}),
    timing: {
      ...(selected.eventStartsAt !== undefined
        ? { eventStartsAt: selected.eventStartsAt.toNumber() }
        : {}),
      expiresAt: selected.expiresAt.toNumber(),
      recordingStartsAt: recordingStartsAt.toNumber(),
    },
    ...(selected.crypto !== undefined
      ? {
          crypto: {
            source: selected.crypto.source,
            asset: selected.crypto.asset,
            binanceSymbol: selected.crypto.binanceSymbol,
            // Правило расчёта — часть CORE и живёт в header-е С МОМЕНТА
            // регистрации: читателю архива не нужно ни парсить URL, ни
            // знать формат стримов Chainlink, чтобы понять, чем рынок
            // резолвится (MR-B PART 42)
            ...(selected.crypto.settlement !== undefined
              ? {
                  settlement: {
                    kind: selected.crypto.settlement.kind,
                    topic: CHAINLINK_TWAP_TOPIC,
                    symbol: selected.crypto.settlement.symbol,
                    windowSeconds: selected.crypto.settlement.windowSeconds,
                    resolutionSource: selected.crypto.settlement.resolutionSource,
                  } satisfies CollectionSettlementDescriptor,
                }
              : {}),
          },
        }
      : {}),
    rtdsFeeds: selected.rtdsFeeds,
    // Критические данные финализации — в CORE (переживают усечение
    // vendor-снапшотов, PART 24)
    ...(finalization !== undefined ? { finalization } : {}),
  };

  const full: Record<string, unknown> = {
    ...core,
    gammaMarket,
    ...(gammaEventWithoutMarkets !== undefined ? { gammaEvent: gammaEventWithoutMarkets } : {}),
  };
  if (fitsMetaBlock(full, selected, recordingStartsAt)) {
    return full;
  }

  const withoutEvent: Record<string, unknown> = {
    ...core,
    gammaMarket,
    truncated: ['gammaEvent'],
  };
  if (fitsMetaBlock(withoutEvent, selected, recordingStartsAt)) {
    return withoutEvent;
  }

  const coreOnly: Record<string, unknown> = { ...core, truncated: ['gammaEvent', 'gammaMarket'] };
  if (fitsMetaBlock(coreOnly, selected, recordingStartsAt)) {
    return coreOnly;
  }

  // Даже ядро не помещается (например, аномально длинный question,
  // дублируемый внешней meta-строкой) — безопасного header не существует
  return undefined;
}

/**
 * Проверяет, поместится ли ПОЛНАЯ meta-строка storage с данным header-ом
 * в зарезервированный блок первой строки.
 *
 * @param header - Кандидат header-объекта (значение ключа `m`)
 * @param selected - Выбранный рынок (внешние поля meta-строки)
 * @param recordingStartsAt - Репрезентативный `ts` probe-конверта (та же
 *   разрядность epoch-ms, что у `Date.now()` при активации storage)
 * @returns `true`, если probe-конверт в пределах бюджета
 *
 * @remarks
 * Probe повторяет форму metaRecord DataRecorder:
 * `{t, formatVersion, ts, marketId, question, tokenIds, m}`. Лимит storage —
 * `META_RESERVED_BYTES - 1` байт на JSON без завершающего перевода строки;
 * сверх точного замера удерживается небольшой защитный запас.
 */
function fitsMetaBlock(
  header: Record<string, unknown>,
  selected: SelectedPolymarketMarket,
  recordingStartsAt: Timestamp,
): boolean {
  const envelopeProbe = {
    t: 'meta',
    formatVersion: 2,
    ts: recordingStartsAt.toNumber(),
    marketId: String(selected.marketId),
    question: selected.question,
    // Имя поля probe повторяет legacy storage-формат meta-строки
    tokenIds: selected.outcomes.map((outcome) => outcome.instrumentId),
    m: header,
  };
  const envelopeBytes = Buffer.byteLength(JSON.stringify(envelopeProbe), 'utf8');
  return envelopeBytes <= STORAGE_META_RESERVED_BYTES - 1 - META_ENVELOPE_SAFETY_MARGIN_BYTES;
}
