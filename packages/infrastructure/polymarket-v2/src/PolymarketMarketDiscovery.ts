/**
 * Market Discovery V2 — обнаружение рынков Polymarket через официальный SDK.
 *
 * @remarks
 * ### Место в архитектуре (N-003, control plane)
 *
 * ```text
 * @polymarket/client (listMarkets / fetchEvent)   ← transport/query owner
 *         ↓ normalized Market
 * PolymarketMarketDiscovery (этот класс)
 *         ↓ кандидаты (наша selection policy: MarketFilter + MarketScorer)
 * CollectionCoordinator → prepareSelected() → SelectedPolymarketMarket
 * ```
 *
 * Discovery — control/query path: он НЕ публикует ничего в ExternalMessageBus
 * (bus остаётся data plane realtime-наблюдений источников).
 *
 * ### Разделение ответственности
 *
 * - **SDK владеет транспортом**: пагинация `listMarkets`, HTTP, decode,
 *   нормализация Gamma-ответа. Никакого custom Gamma HTTP-клиента в V2 нет.
 * - **Мы владеем selection policy**: pre-filter торгуемости, окно endDate,
 *   `MarketFilter` (keywords/ликвидность/спред), `MarketScorer`
 *   (ranking) — существующие компоненты reuse-ятся без изменений.
 *
 * ### Стратегия пагинации (parity с legacy `getActiveMarkets`)
 *
 * Server-side сужение + ранняя остановка, НЕ full-world scan:
 *
 * 1. `closed=false`, `order=endDate`, `ascending=true` — ближайшие к
 *    истечению рынки идут первыми;
 * 2. `endDateMin = now - zombieGraceMs` — отрезает на сервере zombie-рынки
 *    2025 года, которые Gamma продолжает отдавать как active;
 * 3. клиентский cutoff `endDate <= now + endDateWindowMs`: страницы
 *    отсортированы по endDate, поэтому первый рынок за cutoff означает, что
 *    ВСЕ следующие страницы тоже за ним — пагинация останавливается.
 *    (`endDateMax` серверу сознательно не передаётся: legacy-аудит показал
 *    HTTP 500 у Gamma на `end_date_max` во всех форматах.)
 * 4. страховочный предел `maxPages`.
 *
 * ### Gamma gaps N-001 и `fetchEvent`
 *
 * Normalized `Market` SDK НЕ содержит `eventStartTime`/`eventMetadata`
 * сырого Gamma-ответа. Поэтому кандидаты (стадия list) живут без времени
 * начала события, а ТОЧНОЕ время начала берётся из
 * `fetchEvent(selected).schedule.startTime` ТОЛЬКО для выбранного рынка
 * ({@link PolymarketMarketDiscovery.prepareSelected}) — никакого N+1
 * `fetchEvent` по всем кандидатам.
 */
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренняя Decimal-арифметика/парсинг границы после VO-типизированного публичного API, см. docs/architecture/boundary-contract.md, Решение 1
import Decimal from 'decimal.js';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import type { createPublicClient } from '@polymarket/client';
import type { Event, Market } from '@polymarket/bindings/gamma';
import type { DiscoveredMarket, IMarketFilterConfig, IMarketDiscoveryService } from '@polymarket/ports';
import type { MarketFilter, MarketScorer } from '@polymarket/market-discovery';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import { asInstrumentId, asMarketId } from '@polymarket/ids';
import { Money, MoneyService, OutcomePrice, Quantity, RatioService } from '@polymarket/value-objects';
import type { Ratio } from '@polymarket/value-objects';
import { TimestampService } from '@polymarket/timestamp';
import type { Timestamp } from '@polymarket/timestamp';
import { derivePolymarketCryptoMeta } from './PolymarketRtdsFeeds.js';
import type { PolymarketCryptoMeta, PolymarketRtdsFeed } from './PolymarketRtdsFeeds.js';

/**
 * Query-возможности официального SDK-клиента, которые использует Discovery.
 *
 * @remarks
 * Тип выведен из официального `PublicClient` (`Pick<..., 'listMarkets' |
 * 'fetchEvent'>`) — тот же приём, что `PolymarketSubscribeClient` у Source:
 * SDK не экспортирует request/response-типы этих методов с public root,
 * а `ReturnType<typeof createPublicClient>` — публичный API. Реальный
 * `createPublicClient()` присваивается сюда напрямую; узкий Pick нужен,
 * чтобы тестовый fake не реализовывал все actions клиента.
 */
export type PolymarketDiscoveryClient = Pick<
  ReturnType<typeof createPublicClient>,
  'listMarkets' | 'fetchEvent'
>;

/**
 * Кандидат Discovery V2: существующий port-контракт `DiscoveredMarket`
 * плюс typed normalized Market официального SDK.
 *
 * @remarks
 * `DiscoveredMarket`-часть питает существующие `MarketFilter`/`MarketScorer`
 * (reuse без изменений). `sdkMarket` — typed источник данных для
 * `prepareSelected` (header, RTDS, event reference); legacy-поле `rawMarket`
 * сознательно НЕ заполняется — SDK Market не является legacy Gamma DTO,
 * и таскать его под нетипизированным `Record<string, unknown>` запрещено
 * (N-003 PART 5).
 *
 * `eventStartMs` у кандидатов V2 всегда `undefined`: normalized SDK Market
 * не несёт `eventStartTime` (gap N-001). Точное время начала события
 * добавляется на стадии {@link PolymarketMarketDiscovery.prepareSelected}.
 */
export interface PolymarketDiscoveredMarket extends DiscoveredMarket {
  /** Normalized Market официального SDK — typed initial Gamma state. */
  readonly sdkMarket: Market;
}

/**
 * Один исход рынка в терминах выбранного market (для подписок/header).
 *
 * @remarks
 * Canonical-представление ПОСЛЕ vendor boundary: identity инструмента —
 * `InstrumentId` (для Polymarket это CLOB token id — см. `@polymarket/ids`),
 * а не plain string; `label` — реальная vendor-метка исхода (`Up`/`Down`,
 * `Yes`/`No`, ...) без семантических предположений о её значении.
 */
export interface SelectedPolymarketOutcome {
  /** Человекочитаемая метка исхода как её отдал SDK (`Up`/`Down`/`Yes`/...). */
  readonly label: string;
  /** Canonical identity инструмента исхода (Polymarket CLOB token id). */
  readonly instrumentId: InstrumentId;
}

/**
 * Итог подготовки ВЫБРАННОГО рынка к открытию collection session.
 *
 * @remarks
 * Единственный маленький результат discovery, от которого зависит
 * Coordinator (PART 5): identity + outcomes + timing + RTDS-фиды + typed
 * Gamma-состояние для header. Никаких «десятков случайных SDK-полей» —
 * полный SDK Market/Event доступен через `gammaMarket`/`gammaEvent`
 * только как opaque-источник header-метаданных.
 *
 * Инструменты рынка живут ТОЛЬКО в `outcomes[]` (single source of truth):
 * список ids при необходимости выводится
 * `outcomes.map((outcome) => outcome.instrumentId)` — отдельной коллекции
 * ids нет, противоречивое состояние непредставимо.
 */
export interface SelectedPolymarketMarket {
  /**
   * Canonical id рынка. Для Polymarket это ЕСТЬ conditionId — routing
   * identity SDK-событий (контракт `String(marketId) === payload.market`,
   * зафиксирован recorder-ом N-002); отдельного primitive-дубликата нет.
   */
  readonly marketId: MarketId;
  /** Vendor Gamma numeric id рынка (для re-fetch в N-004). */
  readonly gammaMarketId: string;
  /** Slug рынка (если есть). */
  readonly slug?: string;
  /** Вопрос рынка. */
  readonly question: string;
  /** Исходы рынка в vendor-порядке (binary: первый/второй исход SDK). */
  readonly outcomes: readonly SelectedPolymarketOutcome[];
  /** Время истечения рынка. */
  readonly expiresAt: Timestamp;
  /**
   * ТОЧНОЕ время начала события из `fetchEvent().schedule.startTime`.
   * `undefined`, если у рынка нет event-ссылки, fetch не удался или
   * событие не несёт startTime — тогда вызывающий применяет fallback
   * (см. lead-time policy координатора).
   */
  readonly eventStartsAt?: Timestamp;
  /** Identity события Gamma (если есть). */
  readonly event?: {
    readonly id: string;
    readonly slug?: string;
    readonly title?: string;
  };
  /** Крипто-метаданные (RTDS-фиды) или `undefined` для не-крипто рынков. */
  readonly crypto?: PolymarketCryptoMeta;
  /** RTDS-фиды выбранного рынка (пустой массив для не-крипто). */
  readonly rtdsFeeds: readonly PolymarketRtdsFeed[];
  /** Typed normalized Market SDK — initial Gamma state для header. */
  readonly gammaMarket: Market;
  /** Typed normalized Event SDK (если получен) — для header/N-004. */
  readonly gammaEvent?: Event;
}

/**
 * Конфигурация Discovery V2.
 */
export interface PolymarketMarketDiscoveryConfig {
  /** Существующая конфигурация selection policy (`MarketFilter`). */
  readonly filter: IMarketFilterConfig;
  /**
   * Размер страницы `listMarkets`.
   * @defaultValue 100 — Gamma молча ограничивает страницу 100 записями
   */
  readonly pageSize?: number;
  /**
   * Страховочный предел страниц одного refresh.
   * @defaultValue 100 (parity c legacy `maxPages`)
   */
  readonly maxPages?: number;
  /**
   * Клиентское окно endDate вперёд от «сейчас»: рынки, истекающие позже,
   * не рассматриваются, пагинация останавливается на первом из них.
   * @defaultValue 172_800_000 (2 суток, parity с legacy cutoff)
   */
  readonly endDateWindowMs?: number;
  /**
   * Grace-окно назад для только что истёкших рынков (clock skew) —
   * уходит серверу как `endDateMin`.
   * @defaultValue 120_000 (2 минуты, parity)
   */
  readonly zombieGraceMs?: number;
  /**
   * TTL кэша кандидатов для `findCandidates()`.
   * @defaultValue 60_000 (parity с legacy adapter)
   */
  readonly cacheTtlMs?: number;
  /**
   * Минимальная пауза авто-refresh после НЕУДАЧНОГО обновления: пока она не
   * истекла, `findCandidates()` возвращает прежний кэш, не запуская новую
   * пагинацию (защита от молотьбы по недоступному Gamma). Явный `refresh()`
   * backoff не учитывает — cadence явных обновлений принадлежит вызывающему.
   * @defaultValue 15_000
   */
  readonly refreshFailureBackoffMs?: number;
}

/** Дефолты конфигурации (см. поля {@link PolymarketMarketDiscoveryConfig}). */
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_END_DATE_WINDOW_MS = 2 * 24 * 60 * 60_000;
const DEFAULT_ZOMBIE_GRACE_MS = 2 * 60_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_REFRESH_FAILURE_BACKOFF_MS = 15_000;

/**
 * Кэш кандидатов держит 3× запас относительно maxMarketsToReturn:
 * когда активные рынки истекают, координатор немедленно берёт следующих
 * лучших кандидатов без ожидания TTL-рефреша (parity с legacy adapter).
 */
const CACHE_MULTIPLIER = 3;

/**
 * Зависимости {@link PolymarketMarketDiscovery}.
 */
export interface PolymarketMarketDiscoveryDependencies {
  /** Официальный SDK public client (обычно `createPublicClient()`). */
  readonly client: PolymarketDiscoveryClient;
  /** Существующий stateless-фильтр кандидатов (reuse). */
  readonly filter: MarketFilter;
  /** Существующий stateless-скорер кандидатов (reuse). */
  readonly scorer: MarketScorer;
  /** Источник времени (DI — детерминизм в тестах). */
  readonly clock: IClock;
  /** Логгер (будет обёрнут в child с component-контекстом). */
  readonly logger: ILogger;
}

/**
 * Market Discovery V2: официальный SDK Gamma → наша selection policy →
 * кандидаты и подготовленный выбранный рынок.
 *
 * @remarks
 * ### Refresh vs findCandidates vs prepareSelected
 *
 * - {@link PolymarketMarketDiscovery.refresh} — принудительное обновление
 *   кэша кандидатов (paginated listMarkets → pre-filter → map → filter →
 *   score → cache). Ошибка Gamma НЕ очищает прежний кэш.
 * - {@link PolymarketMarketDiscovery.findCandidates} — чтение кэша с
 *   авто-refresh по TTL (контракт `IMarketDiscoveryService`).
 * - {@link PolymarketMarketDiscovery.prepareSelected} — дообогащение ОДНОГО
 *   выбранного кандидата через `fetchEvent` (точное время начала события,
 *   identity события, header-данные). Вызывается координатором только для
 *   рынков, реально претендующих на открытие.
 *
 * ### Policy отказов
 *
 * - отказ Gamma в refresh — лог + прежний кэш (наблюдаемо, не фатально);
 * - отказ страницы при частично собранных данных — используем частичный
 *   список (страницы отсортированы по ближайшему истечению — самое ценное
 *   уже собрано; parity с legacy);
 * - отказ `fetchEvent` в prepareSelected — деградация: выбранный рынок
 *   возвращается БЕЗ `eventStartsAt`/`gammaEvent` (warn); решение об
 *   открытии принимает координатор своим fallback-правилом.
 *
 * @example
 * ```typescript
 * const discovery = new PolymarketMarketDiscovery(
 *   { client: createPublicClient(), filter: new MarketFilter(), scorer: new MarketScorer(clock), clock, logger },
 *   { filter: { minTimeToExpiryHours: 0, minSpread: 0, minLiquidity: 0, maxMarketsToReturn: 10 } },
 * );
 * await discovery.refresh();
 * const candidates = await discovery.findCandidates();
 * const selected = await discovery.prepareSelected(candidates[0]!);
 * ```
 */
export class PolymarketMarketDiscovery implements IMarketDiscoveryService {
  private readonly _client: PolymarketDiscoveryClient;
  private readonly _filter: MarketFilter;
  private readonly _scorer: MarketScorer;
  private readonly _clock: IClock;
  private readonly _logger: ILogger;
  private readonly _config: Required<PolymarketMarketDiscoveryConfig>;

  /** Кэш кандидатов после последнего успешного refresh. */
  private _cachedCandidates: readonly PolymarketDiscoveredMarket[] = [];
  /** Момент последнего успешного refresh (ms). */
  private _lastFetchMs = 0;
  /** In-flight refresh: конкурентные вызовы разделяют одну пагинацию. */
  private _refreshInFlight: Promise<void> | null = null;
  /** Момент последнего НЕУДАЧНОГО refresh (ms) — backoff авто-обновления. */
  private _lastFailedRefreshMs: number | null = null;

  /**
   * Создаёт Discovery поверх инъецированного официального SDK-клиента.
   *
   * @param deps - Зависимости (см. {@link PolymarketMarketDiscoveryDependencies})
   * @param config - Конфигурация selection policy и пагинации
   */
  constructor(deps: PolymarketMarketDiscoveryDependencies, config: PolymarketMarketDiscoveryConfig) {
    this._client = deps.client;
    this._filter = deps.filter;
    this._scorer = deps.scorer;
    this._clock = deps.clock;
    this._logger = deps.logger.child({ component: 'PolymarketMarketDiscovery' });
    this._config = {
      filter: config.filter,
      pageSize: config.pageSize ?? DEFAULT_PAGE_SIZE,
      maxPages: config.maxPages ?? DEFAULT_MAX_PAGES,
      endDateWindowMs: config.endDateWindowMs ?? DEFAULT_END_DATE_WINDOW_MS,
      zombieGraceMs: config.zombieGraceMs ?? DEFAULT_ZOMBIE_GRACE_MS,
      cacheTtlMs: config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
      refreshFailureBackoffMs: config.refreshFailureBackoffMs ?? DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
    };
  }

  /**
   * Возвращает кандидатов из кэша, при устаревшем TTL — авто-refresh.
   *
   * @returns Readonly-массив кандидатов, отсортированных по приоритету
   *
   * @remarks
   * После НЕУДАЧНОГО обновления авто-refresh выдерживает паузу
   * `refreshFailureBackoffMs` (прежний кэш возвращается без новой пагинации) —
   * недоступный Gamma не молотится на каждом чтении.
   *
   * @example
   * ```typescript
   * const candidates = await discovery.findCandidates();
   * ```
   */
  public async findCandidates(): Promise<readonly PolymarketDiscoveredMarket[]> {
    const nowMs = this._clock.now().getTime();
    if (nowMs - this._lastFetchMs > this._config.cacheTtlMs) {
      if (
        this._lastFailedRefreshMs !== null &&
        nowMs - this._lastFailedRefreshMs < this._config.refreshFailureBackoffMs
      ) {
        this._logger.debug('Auto-refresh suppressed by failure backoff, serving previous cache', {
          lastFailedRefreshMs: this._lastFailedRefreshMs,
          refreshFailureBackoffMs: this._config.refreshFailureBackoffMs,
        });
        return this._cachedCandidates;
      }
      this._logger.debug('Candidate cache is stale, refreshing', {
        lastFetchMs: this._lastFetchMs,
        cacheTtlMs: this._config.cacheTtlMs,
      });
      await this.refresh();
    }
    return this._cachedCandidates;
  }

  /**
   * Принудительно обновляет кэш кандидатов через официальный SDK.
   *
   * @remarks
   * Шаги: paginated `listMarkets` (server-side narrowing + early stop) →
   * pre-filter торгуемости → mapping в кандидатов → `MarketFilter` →
   * `MarketScorer` → кэш (3× запас). Ошибка Gamma без частичных данных
   * оставляет прежний кэш нетронутым.
   *
   * Конкурентные вызовы дедуплицируются: пока обновление in-flight,
   * повторный `refresh()`/авто-refresh ждёт ту же пагинацию, а не открывает
   * вторую. Backoff после неудачи на явный `refresh()` НЕ распространяется —
   * cadence явных обновлений принадлежит вызывающему.
   */
  public async refresh(): Promise<void> {
    if (this._refreshInFlight !== null) {
      return this._refreshInFlight;
    }
    this._refreshInFlight = this._doRefresh().finally(() => {
      this._refreshInFlight = null;
    });
    return this._refreshInFlight;
  }

  /**
   * Тело одного обновления кэша (см. {@link PolymarketMarketDiscovery.refresh}).
   */
  private async _doRefresh(): Promise<void> {
    this._logger.info('Refreshing market discovery candidates via official SDK');
    const nowMs = this._clock.now().getTime();

    let rawMarkets: Market[];
    try {
      rawMarkets = await this._listMarketsWindow(nowMs);
    } catch (error) {
      this._lastFailedRefreshMs = this._clock.now().getTime();
      this._logger.error('Gamma listMarkets failed, keeping stale candidate cache', {
        error: error instanceof Error ? error.message : String(error),
        staleCacheSize: this._cachedCandidates.length,
      });
      return;
    }

    // Pre-filter торгуемости (parity: active && !closed && enableOrderBook).
    // SDK-поля nullable — торгуемость требует строгих true/false-значений.
    const tradeable = rawMarkets.filter(
      (market) =>
        market.state.active === true &&
        market.state.closed !== true &&
        market.state.enableOrderBook === true,
    );

    const mapped: PolymarketDiscoveredMarket[] = [];
    let parseErrors = 0;
    for (const market of tradeable) {
      const candidate = this._mapToCandidate(market);
      if (candidate !== null) {
        mapped.push(candidate);
      } else {
        parseErrors++;
      }
    }
    if (parseErrors > 0) {
      this._logger.warn('Some SDK markets could not be mapped and were skipped', {
        parseErrors,
        successfullyMapped: mapped.length,
      });
    }

    // Наша selection policy: существующие MarketFilter/MarketScorer (reuse).
    // Sort-порядок скорера детерминирован, поэтому кандидаты PolymarketDiscoveredMarket
    // сохраняют свой подтип (map/sort не пересобирают объекты, кроме score).
    const filtered = this._filter.filterCandidates(mapped, this._config.filter, nowMs);
    const scored = this._scorer.scoreAndSort(filtered) as PolymarketDiscoveredMarket[];

    const cacheSize = this._config.filter.maxMarketsToReturn * CACHE_MULTIPLIER;
    this._cachedCandidates = scored.slice(0, cacheSize);
    this._lastFetchMs = this._clock.now().getTime();
    this._lastFailedRefreshMs = null;

    this._logger.info('Market discovery refresh complete', {
      raw: rawMarkets.length,
      tradeable: tradeable.length,
      mapped: mapped.length,
      filtered: filtered.length,
      cached: this._cachedCandidates.length,
      maxMarketsToReturn: this._config.filter.maxMarketsToReturn,
    });
  }

  /**
   * Готовит ВЫБРАННЫЙ рынок к открытию collection session.
   *
   * @param candidate - Кандидат из {@link PolymarketMarketDiscovery.findCandidates}
   * @returns Полный результат выбора: identity, outcomes (instruments),
   *   timing, RTDS, typed Gamma-состояние для header
   *
   * @remarks
   * Единственное место, где выполняется `fetchEvent` — ТОЛЬКО для рынка,
   * реально претендующего на открытие (Gamma gap N-001: normalized Market
   * не несёт `eventStartTime`; точное время начала события живёт в
   * `Event.schedule.startTime`). Отказ `fetchEvent` деградирует до
   * `eventStartsAt: undefined` (warn) — не роняет подготовку.
   */
  public async prepareSelected(
    candidate: PolymarketDiscoveredMarket,
  ): Promise<SelectedPolymarketMarket> {
    const market = candidate.sdkMarket;
    const eventRef = market.events[0];

    let gammaEvent: Event | undefined;
    if (eventRef !== undefined) {
      try {
        gammaEvent = await this._client.fetchEvent({ id: String(eventRef.id) });
      } catch (error) {
        this._logger.warn('fetchEvent for selected market failed, proceeding without event data', {
          marketId: String(candidate.marketId),
          eventId: String(eventRef.id),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    let eventStartsAt: Timestamp | undefined;
    const startTimeIso = gammaEvent?.schedule.startTime;
    if (startTimeIso !== null && startTimeIso !== undefined) {
      const startMs = Date.parse(startTimeIso);
      if (!Number.isNaN(startMs)) {
        const startResult = TimestampService.create(startMs);
        if (startResult.ok) {
          eventStartsAt = startResult.value;
        }
      }
    }

    const crypto = derivePolymarketCryptoMeta(market);
    // Vendor mapping boundary (binary-модель N-003): официальный SDK именует
    // первый/второй исход binary-рынка `yes`/`no` даже когда реальные labels —
    // `Up`/`Down`; эти vendor-имена свойств НЕ покидают данный маппинг —
    // дальше живут только нейтральные outcomes[] с canonical InstrumentId.
    const sdkOutcomes = [market.outcomes.yes, market.outcomes.no];
    const outcomes: SelectedPolymarketOutcome[] = [];
    for (const sdkOutcome of sdkOutcomes) {
      if (sdkOutcome.tokenId === null) {
        continue; // исход без CLOB-токена не подписываем (как legacy)
      }
      const instrumentId = asInstrumentId(String(sdkOutcome.tokenId));
      if (instrumentId === undefined) {
        this._logger.warn('Outcome token is not a valid InstrumentId, outcome skipped', {
          marketId: String(candidate.marketId),
          label: sdkOutcome.label,
        });
        continue;
      }
      outcomes.push({ label: sdkOutcome.label, instrumentId });
    }

    const eventIdentity =
      gammaEvent !== undefined
        ? {
            id: String(gammaEvent.id),
            ...(gammaEvent.slug !== null && gammaEvent.slug !== undefined
              ? { slug: gammaEvent.slug }
              : {}),
            ...(gammaEvent.title !== null && gammaEvent.title !== undefined
              ? { title: gammaEvent.title }
              : {}),
          }
        : eventRef !== undefined
          ? {
              id: String(eventRef.id),
              ...(eventRef.slug !== null ? { slug: eventRef.slug } : {}),
              ...(eventRef.title !== null ? { title: eventRef.title } : {}),
            }
          : undefined;

    return {
      marketId: candidate.marketId,
      gammaMarketId: String(market.id),
      ...(market.slug !== null && market.slug !== undefined ? { slug: market.slug } : {}),
      question: candidate.question,
      outcomes,
      expiresAt: candidate.expiresAt,
      ...(eventStartsAt !== undefined ? { eventStartsAt } : {}),
      ...(eventIdentity !== undefined ? { event: eventIdentity } : {}),
      ...(crypto !== undefined ? { crypto } : {}),
      rtdsFeeds: crypto?.feeds ?? [],
      gammaMarket: market,
      ...(gammaEvent !== undefined ? { gammaEvent } : {}),
    };
  }

  /**
   * Собирает normalized Markets внутри окна endDate через paginated SDK API.
   *
   * @param nowMs - Текущее время (ms)
   * @returns Markets с `endDate` в окне `[now - zombieGraceMs, now + endDateWindowMs]`
   * @throws Ошибка SDK первой страницы (частичные данные обрабатываются мягко)
   *
   * @remarks
   * Ранняя остановка: результаты отсортированы по `endDate` ascending —
   * первый рынок за cutoff завершает пагинацию. Отказ страницы при уже
   * собранных данных логируется, частичный список используется (parity).
   */
  private async _listMarketsWindow(nowMs: number): Promise<Market[]> {
    const endDateMinIso = new Date(nowMs - this._config.zombieGraceMs).toISOString();
    const cutoffMs = nowMs + this._config.endDateWindowMs;
    const collected: Market[] = [];
    let pageCount = 0;

    const paginator = this._client.listMarkets({
      closed: false,
      order: 'endDate',
      ascending: true,
      endDateMin: endDateMinIso,
      pageSize: this._config.pageSize,
    });

    try {
      for await (const page of paginator) {
        pageCount++;
        const batch = page.items;
        if (batch.length === 0) {
          break;
        }

        // Окно по endDate: рынки без endDate не проходят (не сможем ни
        // фильтровать по истечению, ни финализировать).
        const withinWindow = batch.filter((market) => {
          const endDate = market.state.endDate;
          if (endDate === null || endDate === undefined) {
            return false;
          }
          const endMs = Date.parse(endDate);
          return !Number.isNaN(endMs) && endMs >= nowMs - this._config.zombieGraceMs && endMs <= cutoffMs;
        });
        collected.push(...withinWindow);

        // Ранняя остановка: последний рынок страницы за cutoff → дальше только позже.
        const lastEndDate = batch[batch.length - 1]!.state.endDate;
        const lastEndMs = lastEndDate !== null && lastEndDate !== undefined ? Date.parse(lastEndDate) : Number.NaN;
        if (!Number.isNaN(lastEndMs) && lastEndMs > cutoffMs) {
          this._logger.debug('Reached endDate cutoff, stopping pagination early', {
            pageCount,
            batchSize: batch.length,
            withinWindow: withinWindow.length,
            cutoffIso: new Date(cutoffMs).toISOString(),
          });
          break;
        }

        if (pageCount >= this._config.maxPages) {
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
        pageCount,
        collected: collected.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this._logger.debug('Fetched markets window from Gamma', {
      pages: pageCount,
      collected: collected.length,
    });
    return collected;
  }

  /**
   * Маппирует normalized SDK Market в кандидата Discovery V2.
   *
   * @param market - Normalized Market официального SDK
   * @returns Кандидат или `null`, если обязательные поля непригодны
   *
   * @remarks
   * Два режима отказа (parity с legacy `_mapToDiscoveredMarket`):
   * - **обязательные поля** (`conditionId`, токен первого исхода, `question`,
   *   `state.endDate`) — рынок отбрасывается (`null`, warn);
   * - **второстепенные** (`liquidity`, `spread`, `tickSize`, `minOrderSize`)
   *   — деградация до дефолта/`undefined`, рынок сохраняется.
   *
   * Соответствие полей: `conditionId` → `marketId`; токен ПЕРВОГО исхода →
   * `instrumentId` (parity с legacy `clobTokenIds[0]`); токены обоих
   * исходов → `allTokenIds` (существующий port-контракт `DiscoveredMarket`,
   * plain strings — legacy boundary); `state.endDate` → `expiresAt`;
   * `trading.minimumTickSize` → `tickSize` (дефолт 0.01);
   * `trading.minimumOrderSize` → `minOrderSize` (дефолт 1);
   * `metrics.liquidity ?? liquidityNum` → `liquidity` (деградация 0);
   * `prices.spread` → `spread` (деградация `undefined`).
   */
  private _mapToCandidate(market: Market): PolymarketDiscoveredMarket | null {
    const conditionId = market.conditionId;
    if (conditionId === null) {
      this._logger.warn('Market has no conditionId, skipping', {
        gammaMarketId: String(market.id),
        question: market.question ?? undefined,
      });
      return null;
    }
    const marketId = asMarketId(String(conditionId));
    if (marketId === undefined) {
      this._logger.warn('Cannot parse conditionId as MarketId, skipping market', {
        conditionId: String(conditionId),
      });
      return null;
    }

    // Vendor mapping boundary: SDK именует первый/второй исход binary-рынка
    // `yes`/`no` (реальные labels могут быть `Up`/`Down`) — эти имена
    // свойств не покидают данный маппинг.
    const [firstSdkOutcome, secondSdkOutcome] = [market.outcomes.yes, market.outcomes.no];
    const firstOutcomeTokenId = firstSdkOutcome.tokenId;
    if (firstOutcomeTokenId === null) {
      this._logger.warn('Market has no first-outcome token, skipping', {
        conditionId: String(conditionId),
      });
      return null;
    }
    const instrumentId = asInstrumentId(String(firstOutcomeTokenId));
    if (instrumentId === undefined) {
      this._logger.warn('Cannot parse first-outcome token as InstrumentId, skipping market', {
        conditionId: String(conditionId),
        tokenId: String(firstOutcomeTokenId),
      });
      return null;
    }
    const secondOutcomeTokenId = secondSdkOutcome.tokenId;
    const allTokenIds =
      secondOutcomeTokenId !== null
        ? [String(firstOutcomeTokenId), String(secondOutcomeTokenId)]
        : [String(firstOutcomeTokenId)];

    const question = market.question;
    if (question === null || question === undefined || question === '') {
      this._logger.warn('Market has no question, skipping', {
        conditionId: String(conditionId),
      });
      return null;
    }

    const endDate = market.state.endDate;
    if (endDate === null || endDate === undefined) {
      this._logger.debug('Market has no endDate, skipping', {
        conditionId: String(conditionId),
      });
      return null;
    }
    const endDateMs = Date.parse(endDate);
    if (Number.isNaN(endDateMs)) {
      this._logger.debug('Cannot parse endDate, skipping market', {
        conditionId: String(conditionId),
        endDate,
      });
      return null;
    }
    const expiresAtResult = TimestampService.create(endDateMs);
    if (!expiresAtResult.ok) {
      this._logger.warn('Cannot create Timestamp from endDate, skipping market', {
        conditionId: String(conditionId),
        endDate,
        error: expiresAtResult.error.message,
      });
      return null;
    }

    // Второстепенные поля: деградация до дефолтов, не отбрасываем рынок.
    let tickSize: OutcomePrice;
    try {
      tickSize = OutcomePrice.of(new Decimal(market.trading.minimumTickSize ?? 0.01));
    } catch {
      this._logger.warn('Cannot create OutcomePrice from minimumTickSize, using default 0.01', {
        conditionId: String(conditionId),
        minimumTickSize: market.trading.minimumTickSize,
      });
      tickSize = OutcomePrice.of(new Decimal('0.01'));
    }

    let minOrderSize: Quantity;
    try {
      minOrderSize = Quantity.of(new Decimal(market.trading.minimumOrderSize ?? 1));
    } catch {
      this._logger.warn('Cannot create Quantity from minimumOrderSize, using default 1', {
        conditionId: String(conditionId),
        minimumOrderSize: market.trading.minimumOrderSize,
      });
      minOrderSize = Quantity.of(new Decimal('1'));
    }

    const liquidityRaw = market.metrics.liquidity ?? market.metrics.liquidityNum ?? '0';
    const liquidityResult = MoneyService.create(liquidityRaw, 'USDC');
    if (!liquidityResult.ok) {
      this._logger.debug('Cannot parse liquidity as Money, defaulting to 0', {
        conditionId: String(conditionId),
        liquidity: String(liquidityRaw),
        error: liquidityResult.error.message,
      });
    }
    const liquidity = liquidityResult.ok ? liquidityResult.value : Money.of(new Decimal(0), 'USDC');

    let spread: Ratio | undefined;
    if (market.prices.spread !== null && market.prices.spread !== undefined) {
      const spreadResult = RatioService.fromDecimal(market.prices.spread);
      if (spreadResult.ok) {
        spread = spreadResult.value;
      } else {
        this._logger.debug('Cannot parse spread as Ratio, treating as unavailable', {
          conditionId: String(conditionId),
          spread: String(market.prices.spread),
          error: spreadResult.error.message,
        });
      }
    }

    return {
      marketId,
      instrumentId,
      question,
      expiresAt: expiresAtResult.value,
      tickSize,
      minOrderSize,
      minOrderValue: Money.of(new Decimal('1'), 'USDC'), // Polymarket требует >= $1 для BUY-ордеров
      active: true,
      ...(spread !== undefined ? { spread } : {}),
      liquidity,
      score: new Decimal(0), // Будет установлен MarketScorer в scoreAndSort()
      allTokenIds,
      // eventStartMs НЕ задаём: normalized SDK Market не несёт eventStartTime
      // (gap N-001); точное время начала — prepareSelected() → fetchEvent.
      // startsAt НЕ задаём — момент начала записи выбирает координатор.
      sdkMarket: market,
    };
  }
}
