/**
 * Polymarket V2 Discovery — технически поддержанный universe canonical рынков.
 *
 * @remarks
 * ### Место в архитектуре
 *
 * ```text
 * @polymarket/client + @polymarket/bindings   ← transport/query owner
 *                 ↓ normalized vendor Market
 *        PolymarketMarketDiscovery (этот класс)
 *                 ↓ vendor normalization
 *          Domain Market (@polymarket/market)
 *                 ↓
 *          MarketDiscoverySnapshot            ← граница порта
 *                 ↓
 *            MarketUniverse
 *                 ↓
 *              Application
 * ```
 *
 * Discovery — control/query path: он НЕ публикует ничего в
 * `ExternalMessageBus` (bus остаётся data plane realtime-наблюдений).
 *
 * ### Что Discovery решает и чего он НЕ решает
 *
 * Он отвечает на ТЕХНИЧЕСКИЙ вопрос:
 *
 * > какие ближайшие рынки площадки наш контур вообще способен вести?
 *
 * Он НЕ выбирает «интересные» рынки. Ключевые слова, минимальная
 * ликвидность/спред, предпочтения по активу и длительности, top-N — это
 * owner policy, и она живёт НАД портом, над `MarketUniverse`. Отсюда
 * удалены `MarketFilter`, `MarketScorer`, `IMarketFilterConfig` и
 * `maxMarketsToReturn`: инфраструктура, знающая про «BTC интереснее ETH»,
 * — это policy, протёкшая в драйвер площадки.
 *
 * ### Конвейер одного обхода
 *
 * ```text
 * listMarkets (bounded pagination, server-side narrowing + ранняя остановка)
 *   ↓ окно endDate + zombie grace
 * technical tradeability gate (active && !closed && enableOrderBook)
 *   ↓
 * classifyPolymarketMarket → поддержано ли семейство CRYPTO_UP_DOWN
 *   ↓ ТОЛЬКО поддержанное подмножество
 * fetchEvent (кэш + dedup) → ТОЧНОЕ event.schedule.startTime
 *   ↓
 * canonical Market + MarketDiscoveryMetrics
 *   ↓ дедупликация venueId+marketId, технический порядок
 * MarketDiscoverySnapshot
 * ```
 *
 * ### Почему enrichment перенесён с «выбранного» рынка на весь
 * поддержанный universe
 *
 * Canonical `Market` требует `startsAt`, а каталог рынков его не несёт —
 * точное время начала живёт только в `event.schedule.startTime`. Раньше
 * `fetchEvent` выполнялся после owner selection (для 1 рынка). Owner
 * selection теперь выше границы, поэтому enrichment переехал на уровень
 * ПОДДЕРЖАННОГО ТЕХНИЧЕСКОГО universe — но остаётся ПОСЛЕ дешёвой
 * классификации: футбол, погода, политика и произвольные crypto `Yes/No`
 * событий не запрашивают вовсе. Если в окне 500 рынков, а Up/Down — 30,
 * запросов будет ≤30, а не 500 (и меньше — за счёт кэша событий).
 *
 * ### Никаких выдуманных canonical-данных
 *
 * Ни одного fallback вида `startsAt = expiresAt - 1h`, `question = marketId`,
 * подставного label/instrumentId или «по умолчанию BTC». Если обязательное
 * поле нельзя получить честно — рынок непригоден и в universe не попадает,
 * а обход остальных продолжается (счётчик `invalidMarkets`).
 */
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренняя Decimal-арифметика/парсинг границы после VO-типизированного публичного API, см. docs/architecture/boundary-contract.md, Решение 1
import Decimal from 'decimal.js';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import type { createPublicClient } from '@polymarket/client';
import type { Event, Market as VendorMarket } from '@polymarket/bindings/gamma';
import type {
  IMarketDiscoveryService,
  MarketDiscoveryDiagnostics,
  MarketDiscoveryEntry,
  MarketDiscoveryMetrics,
  MarketDiscoveryRefreshOptions,
  MarketDiscoverySnapshot,
} from '@polymarket/ports';
import { marketUniverseKey } from '@polymarket/ports';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import { KnownVenues } from '@polymarket/ids';
import { Market, MarketState } from '@polymarket/market';
import { Money, MoneyService, RatioService } from '@polymarket/value-objects';
import type { Ratio } from '@polymarket/value-objects';
import { TimestampService } from '@polymarket/timestamp';
import type { Timestamp } from '@polymarket/timestamp';
import {
  classifyPolymarketMarket,
  parseCryptoUpDownSeriesDuration,
} from './PolymarketCryptoUpDownClassifier.js';
import type { PolymarketCryptoUpDownClassification } from './PolymarketCryptoUpDownClassifier.js';
import type { PolymarketCryptoMeta, PolymarketRtdsFeed } from './PolymarketRtdsFeeds.js';

/**
 * Query-возможности Polymarket V2 client, которые использует Discovery.
 *
 * @remarks
 * Тип выведен из `PublicClient` (`Pick<..., 'listMarkets' | 'fetchEvent'>`) —
 * тот же приём, что `PolymarketSubscribeClient` у Source: пакет не
 * экспортирует request/response-типы этих методов с public root, а
 * `ReturnType<typeof createPublicClient>` — публичный API. Реальный
 * `createPublicClient()` присваивается сюда напрямую; узкий Pick нужен,
 * чтобы тестовый fake не реализовывал все actions клиента.
 */
export type PolymarketDiscoveryClient = Pick<
  ReturnType<typeof createPublicClient>,
  'listMarkets' | 'fetchEvent'
>;

/**
 * Один исход рынка в терминах подготовки подписок (Infrastructure-only).
 *
 * @remarks
 * Canonical-представление ПОСЛЕ vendor boundary: identity инструмента —
 * `InstrumentId` (для Polymarket это CLOB token id), а `label` — реальная
 * vendor-метка исхода без семантических предположений.
 */
export interface SelectedPolymarketOutcome {
  /** Человекочитаемая метка исхода как её отдала площадка (`Up`/`Down`/...). */
  readonly label: string;
  /** Canonical identity инструмента исхода (Polymarket CLOB token id). */
  readonly instrumentId: InstrumentId;
}

/**
 * Vendor-данные обнаруженного рынка для ФИЗИЧЕСКОЙ подготовки подписок.
 *
 * @remarks
 * Это Infrastructure-only запись: она НЕ пересекает границу порта и не
 * входит в {@link MarketDiscoverySnapshot}. За границей живёт только
 * canonical `Market`; здесь остаётся то, что нужно самой инфраструктуре —
 * RTDS-фиды, settlement-правило и typed vendor-модели для header архива.
 *
 * Инструменты рынка живут ТОЛЬКО в `outcomes[]` (single source of truth):
 * список ids выводится `outcomes.map((o) => o.instrumentId)`.
 */
export interface SelectedPolymarketMarket {
  /**
   * Canonical id рынка. Для Polymarket это ЕСТЬ conditionId — routing
   * identity vendor-событий (контракт `String(marketId) === payload.market`).
   */
  readonly marketId: MarketId;
  /** Vendor Gamma numeric id рынка (для re-fetch финализатором). */
  readonly gammaMarketId: string;
  /** Slug рынка (если площадка его опубликовала). */
  readonly slug?: string;
  /** Вопрос рынка. */
  readonly question: string;
  /** Исходы рынка в РЕАЛЬНОМ vendor-порядке. */
  readonly outcomes: readonly [SelectedPolymarketOutcome, SelectedPolymarketOutcome];
  /** Время истечения рынка. */
  readonly expiresAt: Timestamp;
  /**
   * ТОЧНОЕ время начала события из `event.schedule.startTime`.
   *
   * @remarks
   * Обязательно: рынок без подтверждённого времени начала не становится
   * canonical `Market` и, следовательно, не имеет vendor-записи здесь.
   * Прежнего fallback'а «expiresAt - номинальная длительность» больше нет.
   */
  readonly eventStartsAt: Timestamp;
  /** Identity события площадки. */
  readonly event: {
    readonly id: string;
    readonly slug?: string;
    readonly title?: string;
  };
  /** Крипто-метаданные (актив, источник, settlement-правило). */
  readonly crypto: PolymarketCryptoMeta;
  /** RTDS-фиды рынка. */
  readonly rtdsFeeds: readonly PolymarketRtdsFeed[];
  /** Typed normalized vendor Market — initial Gamma state для header. */
  readonly gammaMarket: VendorMarket;
  /** Typed normalized vendor Event — для header/финализации. */
  readonly gammaEvent: Event;
}

/**
 * Конфигурация Polymarket V2 Discovery.
 */
export interface PolymarketMarketDiscoveryConfig {
  /**
   * Размер страницы `listMarkets`.
   *
   * @remarks
   * Поднимать выше 100 бессмысленно: Gamma МОЛЧА обрезает страницу сотней
   * записей — не ошибкой, а укороченным ответом, поэтому опечатка вида
   * `pageSize: 1000` выглядела бы работающей и просто давала бы вдесятеро
   * больше round-trip'ов, чем ожидает читатель. Замер live 2026-09-01
   * (`listMarkets(...).firstPage()`, одни и те же прочие параметры):
   *
   * ```text
   * pageSize=100  → items=100  hasMore=true
   * pageSize=250  → items=100  hasMore=true
   * pageSize=500  → items=100  hasMore=true
   * pageSize=1000 → items=100  hasMore=true
   * ```
   *
   * Число страниц обхода задаётся не этим полем, а окном
   * {@link PolymarketMarketDiscoveryConfig.endDateWindowMs}.
   * @defaultValue 100 (потолок страницы Gamma)
   */
  readonly pageSize?: number;
  /**
   * Страховочный предел страниц одного обхода.
   * @defaultValue 100
   */
  readonly maxPages?: number;
  /**
   * Клиентское окно `endDate` вперёд от «сейчас»: рынки, истекающие позже,
   * не рассматриваются, пагинация останавливается на первом из них.
   *
   * @remarks
   * Главный рычаг стоимости обхода, и дефолт здесь СОЗНАТЕЛЬНО меньше
   * прежних двух суток. Раньше окно определяло только длину списка
   * кандидатов, а точечный запрос события выполнялся для ОДНОГО выбранного
   * рынка. Теперь точное расписание нужно каждому рынку universe, поэтому
   * окно определяет и число запросов события. Замер live 2026-09-01
   * (`scripts/discovery-smoke.ts`, холодный обход):
   *
   * ```text
   * окно   записей   рынков   fetchEvent   холодный обход
   *  48 ч   10 000†     1926         2040           ~47 с
   *   6 ч    6 100       588          624           ~14 с
   *   1 ч    1 700       102          108            ~3 с
   * † упор в maxPages: реальных записей в окне больше
   * ```
   *
   * Цифры — ОДИН замер, а не воспроизводимый бенчмарк: число записей
   * зависит от того, сколько серий площадка сейчас опубликовала (то же
   * часовое окно в тот же день давало и 500 записей), а время — от сети.
   * Устойчиво здесь одно, и ради него таблица и приведена: стоимость растёт
   * вместе с окном, потому что событие нужно КАЖДОМУ рынку universe.
   *
   * Шесть часов покрывают 5m/15m/1h/4h серии с запасом на lead time и
   * остаются на порядок дешевле прежнего окна; дальше горизонта Policy
   * всё равно не принимает решений. Холодная стоимость платится один раз —
   * дальше расписания отдаёт кэш событий (тёплый обход в том же замере:
   * 0 запросов, 624 попадания). Кому нужен более широкий горизонт —
   * увеличивает окно осознанно.
   * @defaultValue 21_600_000 (6 часов)
   */
  readonly endDateWindowMs?: number;
  /**
   * Grace-окно назад для только что истёкших рынков (clock skew) —
   * уходит серверу как `endDateMin`.
   * @defaultValue 120_000 (2 минуты)
   */
  readonly zombieGraceMs?: number;
  /**
   * TTL снимка universe: пока он не истёк, `refresh()` без `force`
   * в сеть не ходит.
   * @defaultValue 60_000
   */
  readonly cacheTtlMs?: number;
  /**
   * Минимальная пауза после НЕУДАЧНОГО обхода: пока она не истекла,
   * `refresh()` без `force` возвращает `false`, не запуская новую
   * пагинацию (защита от молотьбы по недоступному Gamma).
   * @defaultValue 15_000
   */
  readonly refreshFailureBackoffMs?: number;
  /**
   * TTL кэша событий.
   *
   * @remarks
   * Заметно длиннее TTL каталога и это осознанно: расписание события
   * (`schedule.startTime`) на практике неизменно после публикации, а
   * каталог рынков меняется каждую минуту. Один TTL на оба означал бы
   * повторный запрос одного и того же неизменного расписания на каждом
   * обходе.
   * @defaultValue 1_800_000 (30 минут)
   */
  readonly eventCacheTtlMs?: number;
  /**
   * Верхняя граница числа записей в кэше событий.
   * @defaultValue 1000
   */
  readonly eventCacheMaxEntries?: number;
  /**
   * Сколько запросов события выполняется параллельно.
   * @defaultValue 6
   */
  readonly eventFetchConcurrency?: number;
}

/** Дефолты конфигурации (см. поля {@link PolymarketMarketDiscoveryConfig}). */
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_END_DATE_WINDOW_MS = 6 * 60 * 60_000;
const DEFAULT_ZOMBIE_GRACE_MS = 2 * 60_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_REFRESH_FAILURE_BACKOFF_MS = 15_000;
const DEFAULT_EVENT_CACHE_TTL_MS = 30 * 60_000;
const DEFAULT_EVENT_CACHE_MAX_ENTRIES = 1000;
const DEFAULT_EVENT_FETCH_CONCURRENCY = 6;

/**
 * Зависимости {@link PolymarketMarketDiscovery}.
 */
export interface PolymarketMarketDiscoveryDependencies {
  /** Polymarket V2 public client (обычно `createPublicClient()`). */
  readonly client: PolymarketDiscoveryClient;
  /** Источник времени (DI — детерминизм в тестах). */
  readonly clock: IClock;
  /** Логгер (будет обёрнут в child с component-контекстом). */
  readonly logger: ILogger;
}

/** Запись кэша событий. */
interface CachedEvent {
  readonly event: Event;
  readonly fetchedAt: number;
}

/**
 * Мутабельные счётчики одного обхода.
 *
 * @remarks
 * Выведены из `MarketDiscoveryDiagnostics` снятием `readonly`, а не
 * продублированы списком полей: иначе новый счётчик в контракте молча
 * остался бы неподсчитанным здесь.
 */
type DeepMutable<T> = {
  -readonly [K in keyof T]: T[K] extends number ? T[K] : DeepMutable<T[K]>;
};
type RefreshCounters = DeepMutable<MarketDiscoveryDiagnostics>;

/** Построенная запись снимка вместе со своей Infrastructure-only vendor-записью. */
interface BuiltEntry {
  readonly entry: MarketDiscoveryEntry;
  readonly vendor: SelectedPolymarketMarket;
}

/** Поддержанный кандидат вместе со своей vendor-записью. */
interface SupportedCandidate {
  readonly vendorMarket: VendorMarket;
  readonly classification: PolymarketCryptoUpDownClassification;
  /** Vendor id события — обязателен: без события нет точного начала. */
  readonly eventId: string;
}

/**
 * Пустой снимок до первого успешного обхода.
 *
 * @param observedAt - Момент, на который universe пуст
 * @returns Замороженный снимок без записей
 */
function emptySnapshot(observedAt: Timestamp): MarketDiscoverySnapshot {
  return Object.freeze({
    observedAt,
    entries: Object.freeze([] as readonly MarketDiscoveryEntry[]),
    diagnostics: Object.freeze({
      pagesFetched: 0,
      marketsScanned: 0,
      tradeableMarkets: 0,
      unsupportedMarkets: 0,
      supportedCryptoUpDown: 0,
      invalidMarkets: Object.freeze({
        total: 0,
        classification: 0,
        eventUnavailable: 0,
        schedule: 0,
        seriesDuration: 0,
        canonicalMapping: 0,
      }),
      duplicateMarkets: 0,
      eventFetches: 0,
      eventFetchFailures: 0,
      eventCacheHits: 0,
    }),
  });
}

/**
 * Учитывает непригодный рынок по КОНКРЕТНОЙ причине.
 *
 * @param counters - Счётчики обхода (мутируются)
 * @param reason - Причина, по которой рынок не попал в universe
 *
 * @remarks
 * Единственная точка, где растёт `invalidMarkets`: total и причина всегда
 * увеличиваются вместе, поэтому разойтись они не могут — а инвариант
 * «сумма причин === total» проверяется тестом, а не дисциплиной автора.
 */
function countInvalid(
  counters: RefreshCounters,
  reason: Exclude<keyof RefreshCounters['invalidMarkets'], 'total'>,
): void {
  counters.invalidMarkets.total++;
  counters.invalidMarkets[reason]++;
}

/**
 * Технический порядок записей снимка.
 *
 * @param a - Первая запись
 * @param b - Вторая запись
 * @returns Отрицательное/ноль/положительное — как для `Array.prototype.sort`
 *
 * @remarks
 * `startsAt` ASC → `expiresAt` ASC → `id` ASC. Это СТАБИЛЬНОСТЬ вывода
 * (снимок, тесты, логи), а не ранжирование: ликвидность и любые «признаки
 * интересности» здесь сознательно не участвуют — иначе `MarketScorer`
 * вернулся бы в инфраструктуру под другим именем.
 */
function compareEntries(a: MarketDiscoveryEntry, b: MarketDiscoveryEntry): number {
  if (a.market.startsAt.isBefore(b.market.startsAt)) return -1;
  if (a.market.startsAt.isAfter(b.market.startsAt)) return 1;
  if (a.market.expiresAt.isBefore(b.market.expiresAt)) return -1;
  if (a.market.expiresAt.isAfter(b.market.expiresAt)) return 1;
  if (a.market.id < b.market.id) return -1;
  if (a.market.id > b.market.id) return 1;
  return 0;
}

/**
 * Polymarket V2 Discovery: vendor-каталог → canonical universe.
 *
 * @remarks
 * ### Policy отказов
 *
 * - отказ первой страницы каталога — лог + прежний снимок остаётся
 *   доступным, `refresh()` возвращает `false`;
 * - отказ ГЛУБОКОЙ страницы при уже собранных данных — используется
 *   частичный список: страницы отсортированы по ближайшему истечению,
 *   самое ценное уже собрано;
 * - отказ `fetchEvent` — непригодны ТОЛЬКО рынки этого события, обход
 *   остальных продолжается.
 *
 * @example
 * ```typescript
 * const discovery = new PolymarketMarketDiscovery(
 *   { client: createPublicClient(), clock, logger },
 *   { endDateWindowMs: 6 * 60 * 60_000 },
 * );
 *
 * await discovery.refresh({ force: true });
 * universe.replace(discovery.getSnapshot());
 * ```
 */
export class PolymarketMarketDiscovery implements IMarketDiscoveryService {
  private readonly _client: PolymarketDiscoveryClient;
  private readonly _clock: IClock;
  private readonly _logger: ILogger;
  private readonly _config: Required<PolymarketMarketDiscoveryConfig>;

  /** Последний успешный снимок universe. */
  private _snapshot: MarketDiscoverySnapshot;
  /**
   * Vendor-записи последнего снимка (`String(marketId)` → запись).
   *
   * @remarks
   * Infrastructure-only: питает {@link PolymarketMarketDiscovery.prepareMarket}
   * и НЕ экспортируется через порт. Замещается атомарно вместе со снимком,
   * поэтому расхождение «рынок в universe, а vendor-данных нет» невозможно.
   */
  private _vendorRecords: ReadonlyMap<string, SelectedPolymarketMarket> = new Map();
  /** Момент последнего успешного обхода (ms). */
  private _lastFetchMs = 0;
  /** Был ли хотя бы один успешный обход. */
  private _hasSnapshot = false;
  /** In-flight обход: конкурентные вызовы разделяют одну пагинацию. */
  private _refreshInFlight: Promise<boolean> | null = null;
  /** Момент последнего НЕУДАЧНОГО обхода (ms) — пауза перед следующим. */
  private _lastFailedRefreshMs: number | null = null;
  /** Кэш событий по vendor event id. */
  private readonly _eventCache = new Map<string, CachedEvent>();
  /** In-flight запросы событий (дедупликация одинаковых `fetchEvent`). */
  private readonly _eventInFlight = new Map<string, Promise<Event>>();

  /**
   * Создаёт Discovery поверх инъецированного V2-клиента.
   *
   * @param deps - Зависимости (см. {@link PolymarketMarketDiscoveryDependencies})
   * @param config - Конфигурация пагинации и кэшей
   */
  constructor(
    deps: PolymarketMarketDiscoveryDependencies,
    config: PolymarketMarketDiscoveryConfig = {},
  ) {
    this._client = deps.client;
    this._clock = deps.clock;
    this._logger = deps.logger.child({ component: 'PolymarketMarketDiscovery' });
    this._config = {
      pageSize: config.pageSize ?? DEFAULT_PAGE_SIZE,
      maxPages: config.maxPages ?? DEFAULT_MAX_PAGES,
      endDateWindowMs: config.endDateWindowMs ?? DEFAULT_END_DATE_WINDOW_MS,
      zombieGraceMs: config.zombieGraceMs ?? DEFAULT_ZOMBIE_GRACE_MS,
      cacheTtlMs: config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
      refreshFailureBackoffMs:
        config.refreshFailureBackoffMs ?? DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
      eventCacheTtlMs: config.eventCacheTtlMs ?? DEFAULT_EVENT_CACHE_TTL_MS,
      eventCacheMaxEntries: config.eventCacheMaxEntries ?? DEFAULT_EVENT_CACHE_MAX_ENTRIES,
      eventFetchConcurrency: config.eventFetchConcurrency ?? DEFAULT_EVENT_FETCH_CONCURRENCY,
    };
    this._snapshot = emptySnapshot(TimestampService.now(this._clock));
  }

  /**
   * Обновляет снимок universe.
   *
   * @param options - `force: true` игнорирует TTL и паузу после неудачи
   * @returns `true` — актуальный снимок доступен; `false` — обход не
   *   выполнен либо не удался, доступен ПРЕДЫДУЩИЙ снимок
   * @throws Ничего не бросает
   *
   * @remarks
   * Конкурентные вызовы дедуплицируются: пока обход in-flight, повторный
   * `refresh()` ждёт ту же пагинацию, а не открывает вторую.
   *
   * @example
   * ```typescript
   * // Поддержание свежести (TTL + пауза после неудачи соблюдаются)
   * await discovery.refresh();
   * // Обновление по требованию (cadence принадлежит вызывающему)
   * await discovery.refresh({ force: true });
   * ```
   */
  public async refresh(options?: MarketDiscoveryRefreshOptions): Promise<boolean> {
    const force = options?.force === true;
    const nowMs = this._clock.now().getTime();

    if (!force) {
      if (this._hasSnapshot && nowMs - this._lastFetchMs <= this._config.cacheTtlMs) {
        this._logger.debug('Universe snapshot is still fresh, skipping refresh', {
          ageMs: nowMs - this._lastFetchMs,
          cacheTtlMs: this._config.cacheTtlMs,
        });
        return true;
      }
      if (
        this._lastFailedRefreshMs !== null &&
        nowMs - this._lastFailedRefreshMs < this._config.refreshFailureBackoffMs
      ) {
        this._logger.debug('Refresh suppressed by failure backoff, previous snapshot retained', {
          lastFailedRefreshMs: this._lastFailedRefreshMs,
          refreshFailureBackoffMs: this._config.refreshFailureBackoffMs,
        });
        return false;
      }
    }

    if (this._refreshInFlight !== null) {
      return this._refreshInFlight;
    }
    this._refreshInFlight = this._doRefresh().finally(() => {
      this._refreshInFlight = null;
    });
    return this._refreshInFlight;
  }

  /**
   * Возвращает последний успешный снимок universe.
   *
   * @returns Замороженный снимок; до первого успешного обхода — пустой
   *
   * @example
   * ```typescript
   * const { entries, diagnostics } = discovery.getSnapshot();
   * ```
   */
  public getSnapshot(): MarketDiscoverySnapshot {
    return this._snapshot;
  }

  /**
   * Vendor-данные обнаруженного рынка для физической подготовки подписок.
   *
   * @param marketId - Canonical id рынка из `snapshot.entries[].market.id`
   * @returns Vendor-запись или `undefined`, если рынка нет в текущем снимке
   *
   * @remarks
   * Infrastructure-only вход (наследник прежнего `prepareSelected`): сеть
   * НЕ трогает — событие уже получено на стадии обхода. Метод не входит в
   * порт `IMarketDiscoveryService`: Application vendor-объектов не видит.
   *
   * @example
   * ```typescript
   * const vendor = discovery.prepareMarket(entry.market.id);
   * if (vendor !== undefined) {
   *   await source.subscribeMarket(vendor.outcomes.map((o) => o.instrumentId));
   * }
   * ```
   */
  public prepareMarket(marketId: MarketId): SelectedPolymarketMarket | undefined {
    return this._vendorRecords.get(String(marketId));
  }

  /**
   * Тело одного обхода (см. {@link PolymarketMarketDiscovery.refresh}).
   *
   * @returns `true`, если снимок заменён новым
   */
  private async _doRefresh(): Promise<boolean> {
    this._logger.info('Refreshing Polymarket V2 market universe');
    const nowMs = this._clock.now().getTime();
    const counters: RefreshCounters = {
      pagesFetched: 0,
      marketsScanned: 0,
      tradeableMarkets: 0,
      unsupportedMarkets: 0,
      supportedCryptoUpDown: 0,
      invalidMarkets: {
        total: 0,
        classification: 0,
        eventUnavailable: 0,
        schedule: 0,
        seriesDuration: 0,
        canonicalMapping: 0,
      },
      duplicateMarkets: 0,
      eventFetches: 0,
      eventFetchFailures: 0,
      eventCacheHits: 0,
    };

    let vendorMarkets: VendorMarket[];
    try {
      vendorMarkets = await this._listMarketsWindow(nowMs, counters);
    } catch (error) {
      this._lastFailedRefreshMs = this._clock.now().getTime();
      this._logger.error('Gamma listMarkets failed, keeping previous universe snapshot', {
        error: error instanceof Error ? error.message : String(error),
        previousEntries: this._snapshot.entries.length,
      });
      return false;
    }

    const supported = this._classifyTradeable(vendorMarkets, counters);
    const events = await this._resolveEvents(supported, counters);
    const entries = this._buildEntries(supported, events, counters);

    entries.sort((a, b) => compareEntries(a.entry, b.entry));

    const observedAtResult = TimestampService.create(this._clock.now().getTime());
    if (!observedAtResult.ok) {
      // Недостижимо при исправных часах; молча подменять момент наблюдения
      // нельзя — снимок с выдуманным временем хуже отсутствия снимка.
      this._lastFailedRefreshMs = this._clock.now().getTime();
      this._logger.error('Cannot create observedAt timestamp, snapshot discarded', {
        error: observedAtResult.error.message,
      });
      return false;
    }

    this._snapshot = Object.freeze({
      observedAt: observedAtResult.value,
      entries: Object.freeze(entries.map((entry) => entry.entry)),
      diagnostics: Object.freeze({
        ...counters,
        // Вложенный объект замораживается отдельно: поверхностный freeze
        // оставил бы разбор причин мутабельным (та же ошибка, что уже
        // чинилась у metrics записи).
        invalidMarkets: Object.freeze({ ...counters.invalidMarkets }),
      }),
    });
    this._vendorRecords = new Map(entries.map((entry) => [String(entry.entry.market.id), entry.vendor]));
    this._lastFetchMs = this._clock.now().getTime();
    this._lastFailedRefreshMs = null;
    this._hasSnapshot = true;

    this._logger.info('Polymarket V2 market universe refreshed', { ...counters });
    return true;
  }

  /**
   * Собирает vendor-рынки внутри окна `endDate` через paginated каталог.
   *
   * @param nowMs - Текущее время (ms)
   * @param counters - Счётчики обхода (мутируются)
   * @returns Рынки с `endDate` в окне `[now - zombieGraceMs, now + endDateWindowMs]`
   * @throws Ошибка первой страницы (частичные данные обрабатываются мягко)
   *
   * @remarks
   * Server-side сужение + ранняя остановка, НЕ full-world scan:
   *
   * 1. `closed=false`, `order=endDate`, `ascending=true` — ближайшие к
   *    истечению рынки идут первыми;
   * 2. `endDateMin = now - zombieGraceMs` — отрезает на сервере zombie-рынки,
   *    которые Gamma продолжает отдавать активными;
   * 3. клиентский cutoff `endDate <= now + endDateWindowMs`: страницы
   *    отсортированы по `endDate`, поэтому первый рынок за cutoff означает,
   *    что ВСЕ следующие страницы тоже за ним — пагинация останавливается.
   *    (`endDateMax` серверу сознательно не передаётся: аудит показал HTTP
   *    500 у Gamma на `end_date_max` во всех форматах.)
   * 4. страховочный предел `maxPages`.
   */
  private async _listMarketsWindow(
    nowMs: number,
    counters: RefreshCounters,
  ): Promise<VendorMarket[]> {
    const endDateMinIso = new Date(nowMs - this._config.zombieGraceMs).toISOString();
    const cutoffMs = nowMs + this._config.endDateWindowMs;
    const collected: VendorMarket[] = [];

    const paginator = this._client.listMarkets({
      closed: false,
      order: 'endDate',
      ascending: true,
      endDateMin: endDateMinIso,
      pageSize: this._config.pageSize,
    });

    try {
      for await (const page of paginator) {
        counters.pagesFetched++;
        const batch = page.items;
        if (batch.length === 0) {
          break;
        }
        counters.marketsScanned += batch.length;

        // Окно по endDate: рынки без него не проходят (ни отфильтровать по
        // истечению, ни финализировать такой рынок мы не сможем).
        const withinWindow = batch.filter((market) => {
          const endDate = market.state.endDate;
          if (endDate === null || endDate === undefined) {
            return false;
          }
          const endMs = Date.parse(endDate);
          return (
            !Number.isNaN(endMs) &&
            endMs >= nowMs - this._config.zombieGraceMs &&
            endMs <= cutoffMs
          );
        });
        collected.push(...withinWindow);

        // Ранняя остановка: последний рынок страницы за cutoff → дальше только позже.
        const lastEndDate = batch[batch.length - 1]!.state.endDate;
        const lastEndMs =
          lastEndDate !== null && lastEndDate !== undefined ? Date.parse(lastEndDate) : Number.NaN;
        if (!Number.isNaN(lastEndMs) && lastEndMs > cutoffMs) {
          this._logger.debug('Reached endDate cutoff, stopping pagination early', {
            pagesFetched: counters.pagesFetched,
            batchSize: batch.length,
            withinWindow: withinWindow.length,
            cutoffIso: new Date(cutoffMs).toISOString(),
          });
          break;
        }

        if (counters.pagesFetched >= this._config.maxPages) {
          this._logger.warn('Pagination stopped at maxPages safety limit', {
            maxPages: this._config.maxPages,
            collected: collected.length,
          });
          break;
        }
      }
    } catch (error) {
      // Gamma периодически отдаёт 500 на глубокой пагинации: частичный список
      // ценен (ближайшие к истечению рынки уже собраны). Без данных — отказ.
      if (collected.length === 0) {
        throw error;
      }
      this._logger.warn('Pagination page failed, using partial market list', {
        pagesFetched: counters.pagesFetched,
        collected: collected.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this._logger.debug('Fetched markets window from Gamma', {
      pagesFetched: counters.pagesFetched,
      scanned: counters.marketsScanned,
      withinWindow: collected.length,
    });
    return collected;
  }

  /**
   * Применяет технический gate торгуемости и классификатор семейства.
   *
   * @param vendorMarkets - Рынки внутри окна `endDate`
   * @param counters - Счётчики обхода (мутируются)
   * @returns Поддержанные кандидаты, готовые к enrichment расписания
   *
   * @remarks
   * Gate торгуемости — НЕ owner policy, а capability инфраструктуры:
   * «имеет ли смысл вообще передавать этот vendor-рынок дальше в realtime
   * contour». Значения nullable, поэтому проверки строгие: торгуемость
   * требует явных `true`/`false`, а не «не false».
   *
   * Рынок нашего семейства БЕЗ ссылки на событие непригоден: точное время
   * начала живёт только в событии, а выдумывать его запрещено.
   */
  private _classifyTradeable(
    vendorMarkets: readonly VendorMarket[],
    counters: RefreshCounters,
  ): SupportedCandidate[] {
    const supported: SupportedCandidate[] = [];
    for (const vendorMarket of vendorMarkets) {
      const tradeable =
        vendorMarket.state.active === true &&
        vendorMarket.state.closed !== true &&
        vendorMarket.state.enableOrderBook === true;
      if (!tradeable) {
        continue;
      }
      counters.tradeableMarkets++;

      const classification = classifyPolymarketMarket(vendorMarket);
      if (classification.kind === 'UNSUPPORTED') {
        counters.unsupportedMarkets++;
        continue;
      }
      if (classification.kind === 'INVALID') {
        countInvalid(counters, 'classification');
        this._logger.debug('Supported-family market is unusable, excluded from universe', {
          gammaMarketId: String(vendorMarket.id),
          reason: classification.reason,
        });
        continue;
      }

      const eventRef = vendorMarket.events[0];
      if (eventRef === undefined) {
        countInvalid(counters, 'eventUnavailable');
        this._logger.debug('Crypto Up/Down market has no event reference, exact start unavailable', {
          marketId: String(classification.marketId),
        });
        continue;
      }
      supported.push({ vendorMarket, classification, eventId: String(eventRef.id) });
    }
    return supported;
  }

  /**
   * Получает события поддержанных кандидатов (кэш + дедупликация).
   *
   * @param supported - Поддержанные кандидаты обхода
   * @param counters - Счётчики обхода (мутируются)
   * @returns Карта `eventId → Event` только для успешно полученных событий
   *
   * @remarks
   * Запрашиваются ТОЛЬКО уникальные id, ТОЛЬКО для поддержанного семейства
   * и небольшими параллельными группами: N+1 по всему окну (сотни рынков)
   * заменён на ≤ (число уникальных событий поддержанного подмножества)
   * минус попадания в кэш. Отказ одного события не роняет обход — рынки
   * этого события просто станут непригодными.
   */
  private async _resolveEvents(
    supported: readonly SupportedCandidate[],
    counters: RefreshCounters,
  ): Promise<Map<string, Event>> {
    const uniqueIds = [...new Set(supported.map((candidate) => candidate.eventId))];
    const resolved = new Map<string, Event>();
    const concurrency = Math.max(1, this._config.eventFetchConcurrency);

    for (let offset = 0; offset < uniqueIds.length; offset += concurrency) {
      const chunk = uniqueIds.slice(offset, offset + concurrency);
      const settled = await Promise.allSettled(
        chunk.map(async (eventId) => ({ eventId, event: await this._fetchEventOnce(eventId, counters) })),
      );
      for (const [index, result] of settled.entries()) {
        if (result.status === 'fulfilled') {
          resolved.set(result.value.eventId, result.value.event);
        } else {
          counters.eventFetchFailures++;
          this._logger.warn('fetchEvent failed, markets of this event are excluded', {
            eventId: chunk[index],
            error:
              result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      }
    }
    return resolved;
  }

  /**
   * Отдаёт событие из кэша либо запрашивает его ровно один раз.
   *
   * @param eventId - Vendor id события
   * @param counters - Счётчики обхода (мутируются)
   * @returns Typed normalized Event
   * @throws Ошибку клиента, если запрос не удался
   *
   * @remarks
   * Три уровня защиты от лишних запросов: TTL-кэш → in-flight promise
   * (одновременные обращения к одному событию разделяют один запрос) →
   * сам запрос. Кэш ограничен по размеру: при переполнении вытесняются
   * самые старые записи (порядок вставки `Map`).
   */
  private async _fetchEventOnce(eventId: string, counters: RefreshCounters): Promise<Event> {
    const nowMs = this._clock.now().getTime();
    const cached = this._eventCache.get(eventId);
    if (cached !== undefined) {
      if (nowMs - cached.fetchedAt <= this._config.eventCacheTtlMs) {
        counters.eventCacheHits++;
        return cached.event;
      }
      this._eventCache.delete(eventId);
    }

    const inFlight = this._eventInFlight.get(eventId);
    if (inFlight !== undefined) {
      counters.eventCacheHits++;
      return inFlight;
    }

    counters.eventFetches++;
    const pending = this._client
      .fetchEvent({ id: eventId })
      .then((event) => {
        this._eventCache.set(eventId, { event, fetchedAt: this._clock.now().getTime() });
        this._pruneEventCache();
        return event;
      })
      .finally(() => {
        this._eventInFlight.delete(eventId);
      });
    this._eventInFlight.set(eventId, pending);
    return pending;
  }

  /** Вытесняет самые старые записи кэша событий сверх лимита. */
  private _pruneEventCache(): void {
    while (this._eventCache.size > this._config.eventCacheMaxEntries) {
      const oldest = this._eventCache.keys().next();
      if (oldest.done === true) {
        return;
      }
      this._eventCache.delete(oldest.value);
    }
  }

  /**
   * Строит canonical записи universe из поддержанных кандидатов.
   *
   * @param supported - Поддержанные кандидаты обхода
   * @param events - Полученные события (`eventId → Event`)
   * @param counters - Счётчики обхода (мутируются)
   * @returns Записи снимка вместе с их vendor-данными
   *
   * @remarks
   * Дедупликация по `venueId + marketId`: побеждает ПЕРВАЯ ПРИГОДНАЯ
   * запись в порядке каталога (детерминированно — каталог отсортирован
   * площадкой). Именно «пригодная», а не «первая встреченная»: если у
   * первой копии, скажем, не удалось получить событие, второй копии того
   * же рынка ещё даётся шанс — иначе дефект одной записи выбрасывал бы из
   * universe рынок, который площадка отдала корректно рядом.
   *
   * Расхождение vendor-данных у дубликата логируется предупреждением, но
   * обход не роняет: один дефектный дубликат не стоит всего universe.
   */
  private _buildEntries(
    supported: readonly SupportedCandidate[],
    events: ReadonlyMap<string, Event>,
    counters: RefreshCounters,
  ): BuiltEntry[] {
    const built: BuiltEntry[] = [];
    const seen = new Map<string, SupportedCandidate>();

    for (const candidate of supported) {
      const key = marketUniverseKey(KnownVenues.POLYMARKET, candidate.classification.marketId);
      const previous = seen.get(key);
      if (previous !== undefined) {
        counters.duplicateMarkets++;
        if (String(previous.vendorMarket.id) !== String(candidate.vendorMarket.id)) {
          this._logger.warn('Conflicting duplicate market records, keeping the first one', {
            marketId: String(candidate.classification.marketId),
            keptGammaMarketId: String(previous.vendorMarket.id),
            droppedGammaMarketId: String(candidate.vendorMarket.id),
          });
        }
        continue;
      }

      const event = events.get(candidate.eventId);
      if (event === undefined) {
        countInvalid(counters, 'eventUnavailable');
        continue; // отказ fetchEvent уже залогирован в _resolveEvents
      }

      const entry = this._toEntry(candidate, event, counters);
      if (entry === undefined) {
        continue; // причина уже учтена внутри _toEntry
      }
      seen.set(key, candidate);
      counters.supportedCryptoUpDown++;
      built.push(entry);
    }
    return built;
  }

  /**
   * Собирает canonical `Market` + метрики + vendor-запись одного рынка.
   *
   * @param candidate - Поддержанный кандидат
   * @param event - Событие рынка с точным расписанием
   * @returns Запись снимка либо `undefined`, если рынок непригоден
   *
   * @remarks
   * Единственный источник `startsAt` — `event.schedule.startTime`. Любая
   * его недоступность (нет поля, не парсится, не раньше `expiresAt`)
   * делает рынок непригодным: подставного расписания здесь нет и быть не
   * может — от него зависят и торговые решения, и разметка архива.
   *
   * `crypto.duration` — НОМИНАЛ серии, прочитанный из vendor-слага
   * (`event.series[0].slug`), а не измеренный интервал расписания.
   *
   * ### Почему номинал, а не `expiresAt - startsAt`
   *
   * Домен определяет `MarketDuration` как номинал серии и прямо
   * предупреждает, что он может не совпасть с фактическим окном;
   * фактическое даёт `Market.duration()` рядом. Класть измеренный интервал
   * в поле номинала означало бы, что `crypto.duration === FIVE_MINUTES` у
   * Policy проверяет не принадлежность к 5-минутной серии, а длину
   * конкретного окна — и совпадало бы это ровно до первого рынка, чьё окно
   * площадка сдвинула. Номинал объявлен площадкой явно, поэтому он
   * читается, а не выводится.
   *
   * Рынок, чью серию мы не смогли прочитать, непригоден (счётчик
   * `invalidMarkets.seriesDuration`): подставить сюда фактический интервал
   * значило бы вернуть ровно тот дефект, ради устранения которого номинал
   * и переносится на vendor-данные.
   */
  private _toEntry(
    candidate: SupportedCandidate,
    event: Event,
    counters: RefreshCounters,
  ): BuiltEntry | undefined {
    const { classification, vendorMarket } = candidate;
    const marketIdLog = String(classification.marketId);

    const startTimeIso = event.schedule.startTime;
    if (startTimeIso === null || startTimeIso === undefined) {
      countInvalid(counters, 'schedule');
      this._logger.debug('Event has no exact startTime, market excluded from universe', {
        marketId: marketIdLog,
        eventId: candidate.eventId,
      });
      return undefined;
    }
    const startMs = Date.parse(startTimeIso);
    if (Number.isNaN(startMs)) {
      countInvalid(counters, 'schedule');
      this._logger.debug('Event startTime is not a valid timestamp, market excluded', {
        marketId: marketIdLog,
        startTime: startTimeIso,
      });
      return undefined;
    }
    const startsAtResult = TimestampService.create(startMs);
    if (!startsAtResult.ok) {
      countInvalid(counters, 'schedule');
      this._logger.debug('Cannot create Timestamp from event startTime, market excluded', {
        marketId: marketIdLog,
        error: startsAtResult.error.message,
      });
      return undefined;
    }
    const startsAt = startsAtResult.value;
    if (!startsAt.isBefore(classification.expiresAt)) {
      countInvalid(counters, 'schedule');
      this._logger.debug('Event start is not before market expiry, market excluded', {
        marketId: marketIdLog,
        startsAt: startsAt.toISO(),
        expiresAt: classification.expiresAt.toISO(),
      });
      return undefined;
    }

    // НОМИНАЛ серии, а не измеренный интервал: `MarketDuration` по контракту
    // домена — классификация серии, и `Market.duration()` рядом уже даёт
    // фактическое окно. Номинал объявлен площадкой явно, поэтому он читается,
    // а не выводится (см. `parseCryptoUpDownSeriesDuration`).
    const duration = parseCryptoUpDownSeriesDuration(event.series[0]?.slug);
    if (duration === undefined) {
      countInvalid(counters, 'seriesDuration');
      this._logger.debug('Series nominal duration is not declared, market excluded', {
        marketId: marketIdLog,
        eventId: candidate.eventId,
        seriesSlug: event.series[0]?.slug ?? null,
      });
      return undefined;
    }

    const created = Market.create({
      id: classification.marketId,
      venueId: KnownVenues.POLYMARKET,
      ...(classification.slug !== undefined ? { slug: classification.slug } : {}),
      question: classification.question,
      startsAt,
      expiresAt: classification.expiresAt,
      state: MarketState.active(),
      outcomes: classification.outcomes,
      family: 'CRYPTO_UP_DOWN',
      crypto: { asset: classification.crypto.asset, duration },
    });
    if (!created.ok) {
      countInvalid(counters, 'canonicalMapping');
      this._logger.warn('Canonical Market rejected the mapped vendor record', {
        marketId: marketIdLog,
        error: created.error.message,
        field: created.error.context?.['field'],
      });
      return undefined;
    }

    // Заморозка на обоих уровнях: снимок отдаётся наружу как есть
    // (`getSnapshot()`), и потребитель, читающий порт напрямую — без
    // `MarketUniverse` — не должен уметь изменить внутреннее состояние
    // Discovery через `entry.metrics.liquidity = ...`.
    return {
      entry: Object.freeze({
        market: created.value,
        metrics: this._toMetrics(vendorMarket, marketIdLog),
      }),
      vendor: this._toVendorRecord(candidate, event, startsAt),
    };
  }

  /**
   * Извлекает быстро меняющиеся наблюдения площадки по рынку.
   *
   * @param vendorMarket - Vendor-запись рынка
   * @param marketIdLog - Id рынка для логов
   * @returns Метрики записи universe
   *
   * @remarks
   * Деградация здесь НЕ отбрасывает рынок: метрики — вход owner policy,
   * а не часть identity. Отсутствующая ликвидность трактуется как ноль
   * (существующая семантика V2), отсутствующий спред — как `undefined`:
   * «неизвестен» и «нулевой» — разные утверждения, и подменять первое
   * вторым значило бы пропускать рынок сквозь фильтр спреда.
   */
  private _toMetrics(vendorMarket: VendorMarket, marketIdLog: string): MarketDiscoveryMetrics {
    const liquidityRaw = vendorMarket.metrics.liquidity ?? vendorMarket.metrics.liquidityNum ?? '0';
    const liquidityResult = MoneyService.create(liquidityRaw, 'USDC');
    if (!liquidityResult.ok) {
      this._logger.debug('Cannot parse liquidity as Money, defaulting to 0', {
        marketId: marketIdLog,
        liquidity: String(liquidityRaw),
        error: liquidityResult.error.message,
      });
    }
    const liquidity = liquidityResult.ok
      ? liquidityResult.value
      : Money.of(new Decimal(0), 'USDC');

    let spread: Ratio | undefined;
    if (vendorMarket.prices.spread !== null && vendorMarket.prices.spread !== undefined) {
      const spreadResult = RatioService.fromDecimal(vendorMarket.prices.spread);
      if (spreadResult.ok) {
        spread = spreadResult.value;
      } else {
        this._logger.debug('Cannot parse spread as Ratio, treating as unavailable', {
          marketId: marketIdLog,
          spread: String(vendorMarket.prices.spread),
          error: spreadResult.error.message,
        });
      }
    }

    return Object.freeze({ liquidity, ...(spread !== undefined ? { spread } : {}) });
  }

  /**
   * Собирает Infrastructure-only vendor-запись рынка.
   *
   * @param candidate - Поддержанный кандидат
   * @param event - Событие рынка
   * @param eventStartsAt - Подтверждённое точное время начала
   * @returns Запись для {@link PolymarketMarketDiscovery.prepareMarket}
   */
  private _toVendorRecord(
    candidate: SupportedCandidate,
    event: Event,
    eventStartsAt: Timestamp,
  ): SelectedPolymarketMarket {
    const { classification, vendorMarket } = candidate;
    const eventRef = vendorMarket.events[0];
    const slug = event.slug ?? eventRef?.slug;
    const title = event.title ?? eventRef?.title;

    return {
      marketId: classification.marketId,
      gammaMarketId: String(vendorMarket.id),
      ...(vendorMarket.slug !== null && vendorMarket.slug !== undefined
        ? { slug: vendorMarket.slug }
        : {}),
      question: classification.question,
      outcomes: [
        {
          label: classification.outcomes[0].label,
          instrumentId: classification.outcomes[0].instrumentId,
        },
        {
          label: classification.outcomes[1].label,
          instrumentId: classification.outcomes[1].instrumentId,
        },
      ],
      expiresAt: classification.expiresAt,
      eventStartsAt,
      event: {
        id: String(event.id),
        ...(slug !== null && slug !== undefined ? { slug } : {}),
        ...(title !== null && title !== undefined ? { title } : {}),
      },
      crypto: classification.crypto,
      rtdsFeeds: classification.crypto.feeds,
      gammaMarket: vendorMarket,
      gammaEvent: event,
    };
  }
}
