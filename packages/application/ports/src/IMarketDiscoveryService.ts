/**
 * Порт обнаружения рынков + canonical contract его результата.
 *
 * @remarks
 * ### Граница
 *
 * ```text
 * Infrastructure (vendor client/bindings)
 *         ↓ vendor normalization
 *   canonical Market  (@polymarket/market)
 *         ↓
 *   MarketDiscoverySnapshot   ← этот файл
 *         ↓
 *   MarketUniverse (@polymarket/market-discovery)
 *         ↓
 *   Application
 * ```
 *
 * За границей порта НЕТ ни одного vendor-объекта: ни SDK/bindings-моделей,
 * ни Gamma DTO, ни `Record<string, unknown>` payload'ов. Единственное
 * представление рынка — доменная сущность `Market`.
 *
 * ### Почему метрики живут РЯДОМ с Market, а не внутри него
 *
 * `Market` — identity, структура и расписание рынка: то, что не меняется
 * от наблюдения к наблюдению. `liquidity`/`spread` — наоборот, быстро
 * меняющиеся наблюдения площадки. Класть их внутрь entity означало бы
 * «рынок изменился», когда изменился всего лишь стакан. Поэтому наблюдения
 * едут отдельным полем записи snapshot'а
 * ({@link MarketDiscoveryMetrics}) — их использует Policy следующего этапа
 * (`MarketFilter`/`MarketScorer`), а `Market` остаётся чистым.
 *
 * ### Почему discovery НИЧЕГО не ранжирует
 *
 * Discovery отвечает на технический вопрос «какие рынки этого venue наш
 * контур вообще способен вести прямо сейчас?». Вопрос «какие из них нам
 * интересны» (ключевые слова, минимальная ликвидность, предпочтения по
 * активу/длительности, top-N) принадлежит owner policy НАД портом.
 */
import type { Market } from '@polymarket/market';
import type { MarketId, VenueId } from '@polymarket/ids';
import type { Timestamp } from '@polymarket/timestamp';
import type { Money, Ratio } from '@polymarket/value-objects';

/**
 * Быстро меняющиеся наблюдения площадки по обнаруженному рынку.
 *
 * @remarks
 * Сознательно ВНЕ `Market` (см. TSDoc модуля). Набор полей минимален: сюда
 * попадает только то, что реально нужно owner policy для отбора рынков.
 *
 * @example
 * ```typescript
 * if (entry.metrics.liquidity.value().greaterThanOrEqualTo(1000)) {
 *   // рынок достаточно ликвиден для нашей политики
 * }
 * ```
 */
export interface MarketDiscoveryMetrics {
  /**
   * Ликвидность рынка (USDC notional).
   *
   * @remarks
   * Отсутствующее значение площадки трактуется как `Money.of(0, 'USDC')` —
   * существующая семантика V2 («ликвидность не объявлена» = «нулевая для
   * целей отбора»). Выводить ликвидность из других полей запрещено.
   */
  readonly liquidity: Money;
  /**
   * Текущий спред (bid-ask) как доля от 1 (`0.02` = 2%).
   *
   * @remarks
   * `undefined`, если площадка спред не отдала — подставлять ноль нельзя:
   * «спред неизвестен» и «спред нулевой» — противоположные утверждения.
   */
  readonly spread?: Ratio;
}

/**
 * Одна запись universe: canonical рынок + наблюдения по нему.
 *
 * @example
 * ```typescript
 * for (const entry of snapshot.entries) {
 *   console.log(entry.market.question, entry.metrics.liquidity.toString());
 * }
 * ```
 */
export interface MarketDiscoveryEntry {
  /** Canonical доменная сущность рынка — единственное его представление. */
  readonly market: Market;
  /** Наблюдения площадки на момент `snapshot.observedAt`. */
  readonly metrics: MarketDiscoveryMetrics;
}

/**
 * Детерминированная диагностика одного обхода discovery.
 *
 * @remarks
 * Счётчики нужны, чтобы после live-запуска ответить «почему в universe
 * ровно столько рынков» без чтения логов построчно. Инвариант, который
 * проверяется тестами:
 *
 * ```text
 * tradeableMarkets
 *   === supportedCryptoUpDown
 *     + unsupportedMarkets
 *     + invalidMarkets
 *     + duplicateMarkets
 * ```
 *
 * `marketsScanned - tradeableMarkets` — записи, отсечённые окном
 * `endDate` и техническим gate торгуемости.
 */
export interface MarketDiscoveryDiagnostics {
  /** Сколько страниц каталога реально прочитано. */
  readonly pagesFetched: number;
  /** Сколько vendor-записей просмотрено пагинацией (до окна и gate). */
  readonly marketsScanned: number;
  /** Сколько записей прошли окно `endDate` и технический gate торгуемости. */
  readonly tradeableMarkets: number;
  /** Сколько торгуемых записей относятся к неподдержанному семейству. */
  readonly unsupportedMarkets: number;
  /** Сколько canonical рынков попало в snapshot. */
  readonly supportedCryptoUpDown: number;
  /** Сколько записей отброшено как непригодные (нет обязательных данных). */
  readonly invalidMarkets: number;
  /** Сколько записей отброшено дедупликацией `venueId + marketId`. */
  readonly duplicateMarkets: number;
  /** Сколько точечных запросов события реально выполнено. */
  readonly eventFetches: number;
  /** Сколько запросов события обслужил кэш. */
  readonly eventCacheHits: number;
}

/**
 * Снимок технически поддержанного universe площадки.
 *
 * @remarks
 * Порядок `entries` детерминирован и ТЕХНИЧЕСКИЙ (`startsAt` ASC,
 * `expiresAt` ASC, `id` ASC) — это стабильность вывода, а не ранжирование
 * по интересности. Дубликатов по `venueId + marketId` в снимке нет.
 *
 * @example
 * ```typescript
 * await discovery.refresh();
 * universe.replace(discovery.getSnapshot());
 * ```
 */
export interface MarketDiscoverySnapshot {
  /** Момент завершения обхода, породившего снимок. */
  readonly observedAt: Timestamp;
  /** Canonical рынки universe в техническом порядке. */
  readonly entries: readonly MarketDiscoveryEntry[];
  /** Диагностика обхода (см. {@link MarketDiscoveryDiagnostics}). */
  readonly diagnostics: MarketDiscoveryDiagnostics;
}

/**
 * Параметры одного вызова {@link IMarketDiscoveryService.refresh}.
 */
export interface MarketDiscoveryRefreshOptions {
  /**
   * Игнорировать TTL снимка и паузу после неудачи.
   *
   * @remarks
   * По умолчанию `refresh()` — это «поддерживай universe свежим»: он не
   * ходит в сеть, пока текущий снимок не устарел, и выдерживает паузу
   * после неудачного обхода. `force: true` означает «обнови сейчас,
   * cadence мой» — так вызывают ручные/стартовые обновления.
   */
  readonly force?: boolean;
}

/**
 * Порт: обнаружение технически поддержанного universe рынков площадки.
 *
 * @remarks
 * Разделение `refresh()` / `getSnapshot()` сохраняет last-good семантику:
 * временная недоступность площадки НЕ обязана лишать Application последнего
 * успешного universe.
 *
 * @example
 * ```typescript
 * const refreshed = await discovery.refresh();
 * if (!refreshed) {
 *   logger.warn('Discovery refresh failed, serving previous universe');
 * }
 * universe.replace(discovery.getSnapshot());
 * ```
 */
export interface IMarketDiscoveryService {
  /**
   * Обновляет снимок universe.
   *
   * @param options - Управление TTL/паузой (см. {@link MarketDiscoveryRefreshOptions})
   * @returns `true` — актуальный снимок доступен (обновлён либо ещё свеж по
   *   TTL); `false` — обход не выполнен, доступен ПРЕДЫДУЩИЙ снимок
   * @throws Ничего не бросает: отказ площадки наблюдаем через `false` и логи
   */
  refresh(options?: MarketDiscoveryRefreshOptions): Promise<boolean>;

  /**
   * Возвращает последний успешный снимок universe.
   *
   * @returns Снимок; до первого успешного обхода — пустой снимок
   */
  getSnapshot(): MarketDiscoverySnapshot;
}

/**
 * Ключ идентичности рынка в universe.
 *
 * @param venueId - Площадка рынка
 * @param marketId - Идентификатор рынка в пространстве имён площадки
 * @returns Строковый ключ, однозначно адресующий рынок
 *
 * @remarks
 * Идентичность рынка — ПАРА `venueId + marketId`: один и тот же
 * `marketId` на разных площадках означает разные рынки. Разделитель `\n`
 * не встречается ни в одном canonical id, поэтому склейка однозначна.
 * Функция живёт рядом с контрактом, чтобы discovery-дедупликация и
 * lookup universe использовали ОДНО правило, а не два похожих.
 *
 * @example
 * ```typescript
 * marketUniverseKey(KnownVenues.POLYMARKET, marketId); // 'POLYMARKET\n0xbd31…'
 * ```
 */
export function marketUniverseKey(venueId: VenueId, marketId: MarketId): string {
  return `${venueId}\n${marketId}`;
}
