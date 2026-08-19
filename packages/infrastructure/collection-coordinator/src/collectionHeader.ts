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
 * ### Бюджет размера
 *
 * Storage резервирует под первую строку фиксированный блок 16 KiB
 * (`META_RESERVED_BYTES` DataRecorder) — превышение роняет регистрацию.
 * Заголовок собирается с деградацией по бюджету: сначала выбрасывается
 * `gammaEvent`, затем `gammaMarket` (identity/timing/RTDS-ядро остаётся
 * всегда). Вложенные `gammaEvent.markets` выбрасываются безусловно — они
 * дублируют `gammaMarket`.
 */
import type { Timestamp } from '@polymarket/timestamp';
import type { SelectedPolymarketMarket } from '@polymarket/polymarket-v2';

/**
 * Бюджет payload-части header (ключ `m`) в байтах.
 *
 * @remarks
 * Меньше 16 KiB блока storage: внешняя meta-строка добавляет собственные
 * поля (`t`/`formatVersion`/`ts`/`marketId`/`question`/`tokenIds`) — на них
 * оставлен запас 2 KiB.
 */
const HEADER_BUDGET_BYTES = 14 * 1024;

/**
 * Собирает V2 market header для `registerMarket()`.
 *
 * @param selected - Подготовленный выбранный рынок (Discovery V2)
 * @param recordingStartsAt - Момент начала записи (= открытие сессии)
 * @returns Header-объект для `MarketMeta.rawMarket` (ключ `m` первой строки)
 *
 * @remarks
 * Деградация по бюджету размера наблюдаема по полю `truncated`:
 * `undefined` — полный header; `['gammaEvent']` или
 * `['gammaEvent', 'gammaMarket']` — что было выброшено.
 *
 * @example
 * ```typescript
 * const header = buildCollectionHeader(selected, startsAt);
 * recorder.registerMarket({
 *   marketMeta: { marketId, question, tokenIds, startsAt, expiresAt, rawMarket: header },
 *   rtdsFeeds: selected.rtdsFeeds,
 * });
 * ```
 */
export function buildCollectionHeader(
  selected: SelectedPolymarketMarket,
  recordingStartsAt: Timestamp,
): Record<string, unknown> {
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
  if (fitsBudget(full)) {
    return full;
  }

  const withoutEvent: Record<string, unknown> = {
    ...core,
    gammaMarket: selected.gammaMarket,
    truncated: ['gammaEvent'],
  };
  if (fitsBudget(withoutEvent)) {
    return withoutEvent;
  }

  return { ...core, truncated: ['gammaEvent', 'gammaMarket'] };
}

/**
 * Проверяет, помещается ли header в бюджет первой строки storage.
 *
 * @param header - Кандидат header-объекта
 * @returns `true`, если сериализованный размер в пределах бюджета
 */
function fitsBudget(header: Record<string, unknown>): boolean {
  return Buffer.byteLength(JSON.stringify(header), 'utf8') <= HEADER_BUDGET_BYTES;
}
