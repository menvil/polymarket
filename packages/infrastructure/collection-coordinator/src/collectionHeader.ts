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
import type { SelectedPolymarketMarket } from '@polymarket/polymarket-v2';

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
 * Собирает V2 market header для `registerMarket()`.
 *
 * @param selected - Подготовленный выбранный рынок (Discovery V2)
 * @param recordingStartsAt - Момент начала записи (= открытие сессии)
 * @returns Header-объект для `MarketMeta.rawMarket` (ключ `m` первой строки)
 *   либо `undefined`, если даже усечённое ядро не помещается в meta-блок
 *   storage — вызывающий обязан отказать в открытии сессии
 *
 * @remarks
 * Деградация по бюджету наблюдаема по полю `truncated`: `undefined` —
 * полный header; `['gammaEvent']` или `['gammaEvent', 'gammaMarket']` —
 * что было выброшено. Бюджет проверяется по probe полного meta-конверта
 * storage (включая `question`/`tokenIds` внешней строки), а не только `m`.
 *
 * @example
 * ```typescript
 * const header = buildCollectionHeader(selected, startsAt);
 * if (header === undefined) {
 *   // рынок нельзя зарегистрировать — отказ ДО подписок
 * }
 * ```
 */
export function buildCollectionHeader(
  selected: SelectedPolymarketMarket,
  recordingStartsAt: Timestamp,
): Record<string, unknown> | undefined {
  // gammaEvent.markets дублируют gammaMarket — не пишем их в header никогда
  const gammaEventWithoutMarkets =
    selected.gammaEvent !== undefined ? { ...selected.gammaEvent, markets: [] } : undefined;

  const core: Record<string, unknown> = {
    headerVersion: 1,
    source: 'polymarket-v2',
    conditionId: selected.sourceMarketId,
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
      ? { crypto: { source: selected.crypto.source, binanceSymbol: selected.crypto.binanceSymbol } }
      : {}),
    rtdsFeeds: selected.rtdsFeeds,
  };

  const full: Record<string, unknown> = {
    ...core,
    gammaMarket: selected.gammaMarket,
    ...(gammaEventWithoutMarkets !== undefined ? { gammaEvent: gammaEventWithoutMarkets } : {}),
  };
  if (fitsMetaBlock(full, selected, recordingStartsAt)) {
    return full;
  }

  const withoutEvent: Record<string, unknown> = {
    ...core,
    gammaMarket: selected.gammaMarket,
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
    marketId: selected.sourceMarketId,
    question: selected.question,
    tokenIds: [...selected.tokenIds],
    m: header,
  };
  const envelopeBytes = Buffer.byteLength(JSON.stringify(envelopeProbe), 'utf8');
  return envelopeBytes <= STORAGE_META_RESERVED_BYTES - 1 - META_ENVELOPE_SAFETY_MARGIN_BYTES;
}
