/**
 * MarketCollectionCoordinator — control-plane оркестрация collection sessions.
 *
 * @remarks
 * ### Место в архитектуре (N-003)
 *
 * ```text
 * CONTROL PLANE                            DATA PLANE
 *
 * Gamma (официальный SDK)
 *   ↓
 * Market Discovery V2
 *   ↓ selected market                PolymarketSource
 * MarketCollectionCoordinator ───────────↓ subscribe
 *   ├── 1. registerMarket ──► ExternalMessageRecorder ◄── ExternalMessageBus
 *   ├── 2. subscribeMarket ──► PolymarketSource ────────────────┘
 *   └── 3. RTDS feeds (shared, ref-counted)
 * ```
 *
 * Координатор НЕ декодирует WS payload, НЕ пишет файлы, НЕ делает semantic
 * conversion и НЕ торгует. Source и Recorder друг о друге не знают —
 * координатор единственный, кто видит обоих.
 *
 * ### Транзакция открытия (recorder FIRST)
 *
 * 1. синхронная резервация ключа рынка как OPENING (без await до неё —
 *    защита от concurrent duplicate open);
 * 2. `prepareSelected` — точные данные выбранного рынка (fetchEvent);
 * 3. повторная eligibility-проверка (expiry, lead time);
 * 4. `recorder.registerMarket` — routing существует ДО первого WS-события;
 * 5. `source.subscribeMarket` — только после recorder;
 * 6. приобретение RTDS-фидов (shared/ref-counted);
 * 7. commit сессии как ACTIVE.
 *
 * Любой отказ после шага 4 откатывает всё открытое: подписки закрываются,
 * RTDS-refs освобождаются, recording снимается `finalizeMarket(SHUTDOWN)`
 * (storage удаляет incomplete-файл), резервация освобождается — рынок
 * можно ретраить. Zombie-состояний «registered but not subscribed» /
 * «subscribed but not recorded» не остаётся.
 *
 * ### Shared RTDS (source-подписки ≠ recorder-routing)
 *
 * Координатор ref-count-ит НИЖЕЛЕЖАЩИЕ source-подписки: один
 * `(topic, symbol)` фид открывается в SDK один раз на все рынки и
 * закрывается при освобождении последнего ref. Fan-out записи одного фида
 * в несколько файлов — существующая ответственность Recorder-а
 * (`rtdsFeeds` в регистрации); второй routing-механизм здесь не строится.
 *
 * ### Чего координатор сознательно НЕ делает (scope N-003)
 *
 * - НЕ следит за истечением рынков и НЕ финализирует EXPIRED
 *   (enrichment/finalization — N-004; session state несёт identity/expiresAt,
 *   чтобы N-004 добавился без redesign);
 * - НЕ закрывает общий ExternalMessageBus и НЕ вызывает `source.close()` —
 *   lifecycle разделяемых компонентов принадлежит composition root;
 * - НЕ создаёт candidate cache — им владеет Discovery.
 */
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import type { MarketId } from '@polymarket/ids';
import { TimestampService } from '@polymarket/timestamp';
import type {
  PolymarketDiscoveredMarket,
  PolymarketMarketDiscovery,
  PolymarketOpenSubscription,
  PolymarketRtdsFeed,
  PolymarketSource,
  SelectedPolymarketMarket,
} from '@polymarket/polymarket-v2';
import type { ExternalMessageRecorder } from '@polymarket/external-message-recorder';
import { buildCollectionHeader } from './collectionHeader.js';

/**
 * Порт Discovery V2, используемый координатором.
 *
 * @remarks
 * Структурное подмножество `PolymarketMarketDiscovery`: candidate cache
 * (refresh/findCandidates) + подготовка выбранного рынка. Узкий Pick
 * позволяет тестам подставлять fake без наследования класса.
 */
export type CollectionDiscovery = Pick<
  PolymarketMarketDiscovery,
  'findCandidates' | 'refresh' | 'prepareSelected'
>;

/**
 * Порт realtime-source, используемый координатором.
 *
 * @remarks
 * Открытие подписок + сигнал терминального отказа. `hasFailed` — health
 * signal: терминальный отказ Source (отклонение bus / падение SDK-итератора)
 * закрывает ВСЕ его handles, и сессии координатора перестают получать
 * данные — координатор обязан это заметить и снести своё состояние
 * (см. {@link MarketCollectionCoordinator.fillSlots}). `close()` всего
 * Source принадлежит composition root (PART 27) — координатор закрывает
 * ТОЛЬКО handles своих сессий.
 */
export type CollectionSource = Pick<
  PolymarketSource,
  'subscribeMarket' | 'subscribeCryptoPrices' | 'hasFailed'
>;

/**
 * Порт recorder-а, используемый координатором.
 *
 * @remarks
 * Регистрация recording-сессии + её снятие. `close()` recorder-а принадлежит
 * composition root (порядок shutdown контура — N-002).
 */
export type CollectionRecorder = Pick<ExternalMessageRecorder, 'registerMarket' | 'finalizeMarket'>;

/**
 * Зависимости {@link MarketCollectionCoordinator}.
 */
export interface MarketCollectionCoordinatorDependencies {
  /** Discovery V2 (кандидаты + подготовка выбранного рынка). */
  readonly discovery: CollectionDiscovery;
  /** Realtime source (подписки market/RTDS). */
  readonly source: CollectionSource;
  /** Recording-подписчик общего bus (регистрация/снятие сессий). */
  readonly recorder: CollectionRecorder;
  /** Источник времени (DI — детерминизм в тестах). */
  readonly clock: IClock;
  /** Логгер (будет обёрнут в child с component-контекстом). */
  readonly logger: ILogger;
}

/**
 * Конфигурация координатора.
 */
export interface MarketCollectionCoordinatorConfig {
  /** Максимум одновременных сессий; учитывает ACTIVE + OPENING (PART 21). */
  readonly maxMarkets: number;
  /**
   * Минимальное время до начала события, раньше которого рынок открывается.
   * Начавшиеся или начинающиеся раньше рынки пропускаются НАВСЕГДА
   * (время до старта монотонно убывает).
   * @defaultValue 120_000 (2 минуты — parity с legacy MIN_TIME_TO_START_MS)
   */
  readonly minTimeToStartMs?: number;
  /**
   * Fallback-длительность рынка для оценки времени начала, когда точное
   * `eventStartsAt` недоступно (нет события/fetchEvent упал/нет startTime):
   * `estimatedStart = expiresAt - fallback`.
   * @defaultValue 900_000 (15 минут — parity с legacy fallback durationMs)
   */
  readonly fallbackMarketDurationMs?: number;
}

/** Дефолты конфигурации (см. {@link MarketCollectionCoordinatorConfig}). */
const DEFAULT_MIN_TIME_TO_START_MS = 2 * 60_000;
const DEFAULT_FALLBACK_MARKET_DURATION_MS = 15 * 60_000;

/**
 * Исход попытки открытия collection session.
 *
 * - `'opened'` — сессия ACTIVE, запись идёт;
 * - `'skipped'` — рынок неэлигиблен (дубликат/istёк/lead time/capacity) —
 *   это не ошибка;
 * - `'failed'` — открытие упало и полностью откачено; retry возможен.
 */
export type CollectionOpenOutcome = 'opened' | 'skipped' | 'failed';

/**
 * Публичный снимок одной сессии (диагностика/смоук).
 */
export interface CollectionSessionSnapshot {
  readonly marketId: string;
  readonly state: 'OPENING' | 'ACTIVE';
  readonly question?: string;
  readonly expiresAtMs?: number;
  readonly openedAtMs?: number;
}

/**
 * Снимок runtime-состояния координатора (диагностика/тесты/смоук).
 */
export interface CollectionCoordinatorStats {
  readonly activeSessions: number;
  readonly openingSessions: number;
  /** `topic:symbol` → количество рынков, держащих ref на фид. */
  readonly rtdsFeedRefCounts: Readonly<Record<string, number>>;
}

/**
 * Runtime-состояние одной сессии (минимальное, PART 15).
 */
interface CollectionSession {
  state: 'OPENING' | 'ACTIVE';
  readonly marketId: MarketId;
  readonly sourceMarketId: string;
  /** Заполняется на commit ACTIVE. */
  selected?: SelectedPolymarketMarket;
  marketSubscription?: PolymarketOpenSubscription;
  /** Ключи приобретённых RTDS-фидов (для release). */
  rtdsFeedKeys: readonly string[];
  openedAtMs?: number;
  /** Завершение open-транзакции (для close()/closeSession()). */
  readonly settled: Promise<void>;
  /** Резолвер settled (вызывается транзакцией на любом исходе). */
  readonly settle: () => void;
}

/**
 * Shared RTDS-фид: одна source-подписка на все рынки с ref-count.
 */
interface RtdsFeedEntry {
  readonly feed: PolymarketRtdsFeed;
  /** marketKey-и, держащие ref. */
  readonly refs: Set<string>;
  /** Открытие подписки (общее для всех ожидающих acquire). */
  readonly pending: Promise<PolymarketOpenSubscription>;
}

/**
 * Точный ключ RTDS-фида (vendor topic + символ).
 */
function rtdsFeedKey(feed: PolymarketRtdsFeed): string {
  return `${feed.topic}:${feed.symbol}`;
}

/**
 * Координатор collection sessions: selected market → failure-safe открытая
 * сессия (recording + подписки) с идемпотентностью и graceful shutdown.
 *
 * @example
 * ```typescript
 * const coordinator = new MarketCollectionCoordinator(
 *   { discovery, source, recorder, clock, logger },
 *   { maxMarkets: 5 },
 * );
 * await coordinator.refreshCandidates();
 * await coordinator.fillSlots();
 * // ... сбор данных ...
 * await coordinator.close(); // до bus.drain()/recorder.close()/bus.close()
 * ```
 */
export class MarketCollectionCoordinator {
  private readonly _discovery: CollectionDiscovery;
  private readonly _source: CollectionSource;
  private readonly _recorder: CollectionRecorder;
  private readonly _clock: IClock;
  private readonly _logger: ILogger;
  private readonly _maxMarkets: number;
  private readonly _minTimeToStartMs: number;
  private readonly _fallbackMarketDurationMs: number;

  /** Сессии по sourceMarketId; OPENING и ACTIVE занимают slot (PART 21). */
  private readonly _sessions = new Map<string, CollectionSession>();
  /** Shared RTDS-фиды по `topic:symbol`. */
  private readonly _rtdsFeeds = new Map<string, RtdsFeedEntry>();
  /**
   * Рынки, НАВСЕГДА отклонённые lead-time правилом: время до старта монотонно
   * убывает, поэтому повторная проверка (и повторный fetchEvent) не нужна.
   * Чистится лениво в fillSlots по текущему candidate cache — истёкшие рынки
   * выходят из discovery-окна и освобождают память.
   */
  private readonly _leadTimeRejected = new Set<string>();

  private _closed = false;
  private _closePromise: Promise<void> | null = null;

  /**
   * Создаёт координатор поверх инъецированных discovery/source/recorder.
   *
   * @param deps - Зависимости (см. {@link MarketCollectionCoordinatorDependencies})
   * @param config - Конфигурация (см. {@link MarketCollectionCoordinatorConfig})
   */
  constructor(
    deps: MarketCollectionCoordinatorDependencies,
    config: MarketCollectionCoordinatorConfig,
  ) {
    this._discovery = deps.discovery;
    this._source = deps.source;
    this._recorder = deps.recorder;
    this._clock = deps.clock;
    this._logger = deps.logger.child({ component: 'MarketCollectionCoordinator' });
    this._maxMarkets = config.maxMarkets;
    this._minTimeToStartMs = config.minTimeToStartMs ?? DEFAULT_MIN_TIME_TO_START_MS;
    this._fallbackMarketDurationMs =
      config.fallbackMarketDurationMs ?? DEFAULT_FALLBACK_MARKET_DURATION_MS;
  }

  /** true после {@link MarketCollectionCoordinator.close}. */
  public get isClosed(): boolean {
    return this._closed;
  }

  /**
   * Обновляет candidate cache через Discovery (DISCOVERY: «что доступно?»).
   *
   * @remarks
   * Отказ Gamma наблюдаем (лог) и не уничтожает ни активные сессии, ни
   * прежний кэш (policy Discovery). Слотами НЕ управляет — это
   * {@link MarketCollectionCoordinator.fillSlots}.
   */
  public async refreshCandidates(): Promise<void> {
    if (this._closed) {
      return;
    }
    try {
      await this._discovery.refresh();
    } catch (error) {
      this._logger.error('Candidate refresh failed, keeping previous cache', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Заполняет свободные слоты лучшими eligible-кандидатами из кэша
   * (COORDINATOR: «что открыть сейчас?»).
   *
   * @returns Количество открытых сессий
   *
   * @remarks
   * Слот = ACTIVE + OPENING (PART 21). Отказ открытия одного рынка не
   * прерывает проход — следующий кандидат пробуется дальше (PART 29).
   *
   * Также выполняет health-reconciliation source: терминальный отказ
   * Source уже закрыл все его handles, поэтому «ACTIVE»-сессии мертвы —
   * они сносятся (recording снимается SHUTDOWN-ом, RTDS-refs и capacity
   * освобождаются), новые открытия на отказавшем source невозможны.
   * Composition root после этого заменяет source и координатор
   * (зависимости иммутабельны) — состояние уже чистое.
   */
  public async fillSlots(): Promise<number> {
    if (this._closed) {
      return 0;
    }
    if (await this._reconcileSourceFailure()) {
      return 0;
    }

    let candidates: readonly PolymarketDiscoveredMarket[];
    try {
      candidates = await this._discovery.findCandidates();
    } catch (error) {
      this._logger.error('Failed to read candidates from discovery cache', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }

    this._pruneLeadTimeRejected(candidates);

    let opened = 0;
    for (const candidate of candidates) {
      if (this._closed || this._sessions.size >= this._maxMarkets) {
        break;
      }
      const outcome = await this.openMarket(candidate);
      if (outcome === 'opened') {
        opened++;
      }
    }

    if (opened > 0) {
      this._logger.info('Collection slots filled from candidate cache', {
        opened,
        total: this._sessions.size,
        maxMarkets: this._maxMarkets,
      });
    }
    return opened;
  }

  /**
   * Health-reconciliation source: терминальный отказ → teardown всех сессий.
   *
   * @returns `true`, если source в терминальном отказе (открытия невозможны)
   *
   * @remarks
   * Терминальный отказ Source (`hasFailed`) означает, что ВСЕ его handles
   * уже закрыты самим Source — «ACTIVE»-сессии координатора мертвы: данные
   * не поступают, recorder-routing и capacity заняты впустую. Reconciliation
   * сносит их штатным `closeSession(..., 'SHUTDOWN')`: повторный `close()`
   * уже закрытых handles идемпотентен (контракт Source), recording
   * снимается, incomplete-файлы удаляет storage, RTDS-refs и слоты
   * освобождаются. После этого composition root может заменить отказавший
   * shared source (и координатор поверх него) — runtime-состояние чистое.
   */
  private async _reconcileSourceFailure(): Promise<boolean> {
    if (!this._source.hasFailed) {
      return false;
    }
    if (this._sessions.size === 0) {
      return true;
    }
    this._logger.error('Source entered terminal failure, tearing down all collection sessions', {
      sessions: this._sessions.size,
    });
    // In-flight OPENING-транзакции докатываются сами (их подписки на
    // отказавшем source упадут → собственный rollback), затем teardown
    await Promise.allSettled([...this._sessions.values()].map((session) => session.settled));
    for (const session of [...this._sessions.values()]) {
      await this.closeSession(session.marketId, 'SHUTDOWN');
    }
    return true;
  }

  /**
   * Открывает collection session для кандидата (транзакция с rollback).
   *
   * @param candidate - Кандидат Discovery V2
   * @returns Исход попытки (см. {@link CollectionOpenOutcome})
   *
   * @remarks
   * Идемпотентность/конкурентность: резервация OPENING выполняется
   * СИНХРОННО до первого await — двойное открытие одного рынка невозможно
   * даже при одновременных вызовах (PART 14). Capacity проверяется в той же
   * синхронной секции и учитывает OPENING (PART 21).
   */
  public async openMarket(candidate: PolymarketDiscoveredMarket): Promise<CollectionOpenOutcome> {
    const key = String(candidate.marketId);

    // ── Синхронная секция: никаких await до резервации ──────────────────────
    if (this._closed) {
      return 'skipped';
    }
    if (this._source.hasFailed) {
      this._logger.debug('Skipping open: source is in terminal failure', { marketId: key });
      return 'skipped'; // reconciliation выполняет fillSlots
    }
    if (this._sessions.has(key)) {
      return 'skipped'; // уже ACTIVE или OPENING
    }
    if (this._leadTimeRejected.has(key)) {
      return 'skipped';
    }
    if (candidate.expiresAt.toNumber() <= this._clock.now().getTime()) {
      this._logger.debug('Skipping already-expired market', {
        marketId: key,
        question: candidate.question,
      });
      return 'skipped';
    }
    if (this._sessions.size >= this._maxMarkets) {
      return 'skipped'; // capacity: ACTIVE + OPENING
    }

    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const session: CollectionSession = {
      state: 'OPENING',
      marketId: candidate.marketId,
      sourceMarketId: key,
      rtdsFeedKeys: [],
      settled,
      settle,
    };
    this._sessions.set(key, session); // резервация OPENING

    try {
      return await this._runOpenTransaction(session, candidate);
    } catch (error) {
      // Неожиданное исключение транзакции (за пределами её собственных
      // catch-веток) НЕ должно оставить вечную OPENING-резервацию:
      // best-effort снятие recording (finalize незарегистрированного рынка —
      // безопасный no-op) + освобождение ключа, рынок можно ретраить.
      await this._rollbackRecording(candidate.marketId, key);
      if (this._sessions.get(key) === session) {
        this._sessions.delete(key);
      }
      this._logger.error('Open transaction failed unexpectedly, reservation released', {
        marketId: key,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'failed';
    } finally {
      session.settle();
    }
  }

  /**
   * Тело транзакции открытия (шаги 2-7 + rollback).
   *
   * @param session - Зарезервированная OPENING-сессия
   * @param candidate - Кандидат Discovery V2
   * @returns Исход попытки
   */
  private async _runOpenTransaction(
    session: CollectionSession,
    candidate: PolymarketDiscoveredMarket,
  ): Promise<CollectionOpenOutcome> {
    const key = session.sourceMarketId;

    // ── 2. Точные данные выбранного рынка ────────────────────────────────────
    let selected: SelectedPolymarketMarket;
    try {
      selected = await this._discovery.prepareSelected(candidate);
    } catch (error) {
      this._sessions.delete(key);
      this._logger.error('Failed to prepare selected market, releasing reservation', {
        marketId: key,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'failed';
    }
    if (this._closed) {
      this._sessions.delete(key);
      return 'skipped';
    }

    // ── 3. Eligibility re-check по точным данным (PART 22/23) ────────────────
    const nowMs = this._clock.now().getTime();
    if (selected.expiresAt.toNumber() <= nowMs) {
      this._sessions.delete(key);
      this._logger.debug('Selected market already expired, skipping', { marketId: key });
      return 'skipped';
    }
    // Lead time: точное eventStartsAt, иначе legacy-fallback
    // estimatedStart = expiresAt - fallbackDuration (документировано)
    const estimatedStartMs =
      selected.eventStartsAt?.toNumber() ??
      selected.expiresAt.toNumber() - this._fallbackMarketDurationMs;
    const timeToStartMs = estimatedStartMs - nowMs;
    if (timeToStartMs < this._minTimeToStartMs) {
      this._sessions.delete(key);
      this._leadTimeRejected.add(key);
      this._logger.debug('Skipping market (already started or starts too soon)', {
        marketId: key,
        question: selected.question,
        estimatedStart: new Date(estimatedStartMs).toISOString(),
        timeToStartMin: (timeToStartMs / 60_000).toFixed(1),
        exactEventStart: selected.eventStartsAt !== undefined,
      });
      return 'skipped';
    }
    if (selected.tokenIds.length === 0) {
      this._sessions.delete(key);
      this._logger.warn('Selected market has no tokenIds, skipping as unsupported', {
        marketId: key,
      });
      return 'skipped';
    }

    // ── 4. Recorder FIRST: routing существует до первого WS-события ─────────
    // startsAt = момент открытия сессии: запись начинается СЕЙЧАС (PART 9 —
    // parity с legacy; НЕ время начала vendor-события).
    const startsAtResult = TimestampService.create(nowMs);
    if (!startsAtResult.ok) {
      this._sessions.delete(key);
      this._logger.error('Cannot create recording startsAt timestamp', {
        marketId: key,
        error: startsAtResult.error.message,
      });
      return 'failed';
    }
    const startsAt = startsAtResult.value;
    // Header обязан влезть в фиксированный meta-блок storage; отказ сборки —
    // явный отказ открытия ДО каких-либо подписок (retry возможен).
    const header = buildCollectionHeader(selected, startsAt);
    if (header === undefined) {
      this._sessions.delete(key);
      this._logger.error('Cannot build market header within storage meta budget, open aborted', {
        marketId: key,
        question: selected.question,
      });
      return 'failed';
    }
    const installed = this._recorder.registerMarket({
      marketMeta: {
        marketId: selected.marketId,
        question: selected.question,
        tokenIds: selected.tokenIds,
        startsAt,
        expiresAt: selected.expiresAt,
        rawMarket: header,
      },
      rtdsFeeds: selected.rtdsFeeds,
    });
    if (!installed) {
      this._sessions.delete(key);
      this._logger.error('Recorder rejected market registration, releasing reservation', {
        marketId: key,
        question: selected.question,
      });
      return 'failed';
    }

    // ── 5. Market subscription: ТОЛЬКО после recorder ────────────────────────
    let marketSubscription: PolymarketOpenSubscription;
    try {
      marketSubscription = await this._source.subscribeMarket(selected.tokenIds);
    } catch (error) {
      await this._rollbackRecording(selected.marketId, key);
      this._sessions.delete(key);
      this._logger.error('Market subscription failed, recording rolled back', {
        marketId: key,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'failed';
    }
    if (this._closed) {
      await this._closeMarketSubscription(marketSubscription, key);
      await this._rollbackRecording(selected.marketId, key);
      this._sessions.delete(key);
      return 'skipped';
    }

    // ── 6. RTDS-фиды (shared/ref-counted) ────────────────────────────────────
    let rtdsFeedKeys: readonly string[];
    try {
      rtdsFeedKeys = await this._acquireRtdsFeeds(key, selected.rtdsFeeds);
    } catch (error) {
      await this._closeMarketSubscription(marketSubscription, key);
      await this._rollbackRecording(selected.marketId, key);
      this._sessions.delete(key);
      this._logger.error('RTDS subscription failed, session rolled back', {
        marketId: key,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'failed';
    }
    if (this._closed) {
      await this._releaseRtdsFeeds(key, rtdsFeedKeys);
      await this._closeMarketSubscription(marketSubscription, key);
      await this._rollbackRecording(selected.marketId, key);
      this._sessions.delete(key);
      return 'skipped';
    }

    // ── 7. Commit ACTIVE ─────────────────────────────────────────────────────
    session.state = 'ACTIVE';
    session.selected = selected;
    session.marketSubscription = marketSubscription;
    session.rtdsFeedKeys = rtdsFeedKeys;
    session.openedAtMs = nowMs;

    this._logger.info('Collection session opened', {
      marketId: key,
      question: selected.question,
      tokenIds: selected.tokenIds.length,
      rtdsFeeds: selected.rtdsFeeds.map(rtdsFeedKey),
      expiresAt: new Date(selected.expiresAt.toNumber()).toISOString(),
      isCrypto: selected.crypto !== undefined,
    });
    return 'opened';
  }

  /**
   * Явное закрытие одной сессии (control-plane request: rollback внешнего
   * уровня, app shutdown, будущий N-004 finalizer).
   *
   * @param marketId - ID рынка сессии
   * @param reason - Причина для recorder-а: N-003 контур использует ТОЛЬКО
   *   `'SHUTDOWN'` (incomplete dataset, файл удаляется storage);
   *   `'EXPIRED'` зарезервирован за будущим finalizer N-004
   * @returns Promise завершения teardown
   *
   * @remarks
   * Идемпотентен: отсутствие сессии — no-op (debug). Для OPENING-сессии
   * дожидается завершения её транзакции и закрывает результат, если тот
   * стал ACTIVE. Порядок teardown: market subscription → RTDS refs →
   * recording (routing снимается recorder-ом внутри finalizeMarket).
   */
  public async closeSession(marketId: MarketId, reason: 'EXPIRED' | 'SHUTDOWN'): Promise<void> {
    const key = String(marketId);
    const reserved = this._sessions.get(key);
    if (reserved === undefined) {
      this._logger.debug('closeSession: no session for market', { marketId: key });
      return;
    }
    // OPENING: дождаться исхода транзакции (она видит _closed/её могли откатить)
    await reserved.settled;

    // Identity-guard: за время ожидания settled транзакция могла откатиться,
    // а retry — установить НОВУЮ сессию под тем же ключом. Сравниваем ОБЪЕКТ,
    // а не только ключ (тот же паттерн, что у recorder-а при отказе
    // отложенной активации) — чужая сессия не сносится.
    const session = this._sessions.get(key);
    if (session !== reserved || session.state !== 'ACTIVE') {
      return; // транзакция откатилась либо под ключом уже другая сессия
    }
    this._sessions.delete(key); // синхронно: второй closeSession станет no-op

    if (session.marketSubscription !== undefined) {
      await this._closeMarketSubscription(session.marketSubscription, key);
    }
    await this._releaseRtdsFeeds(key, session.rtdsFeedKeys);
    try {
      await this._recorder.finalizeMarket(session.marketId, reason);
    } catch (error) {
      this._logger.warn('Recorder finalization failed during session close', {
        marketId: key,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this._logger.info('Collection session closed', {
      marketId: key,
      reason,
      question: session.selected?.question,
    });
  }

  /**
   * Graceful shutdown координатора: детерминированный teardown всех сессий.
   *
   * @returns Promise завершения shutdown
   *
   * @remarks
   * Порядок (PART 26): запрет новых открытий → завершение in-flight
   * OPENING-транзакций (они откатываются сами по флагу закрытия либо
   * доходят до ACTIVE) → для каждой сессии: close market subscription →
   * release RTDS refs → `finalizeMarket(SHUTDOWN)` → очистка состояния.
   *
   * Идемпотентен (повторные вызовы ждут первый). Общий bus, Source и
   * Recorder НЕ закрываются — их lifecycle принадлежит composition root:
   * после `coordinator.close()` он выполняет `source.close()` →
   * `bus.drain()` → `recorder.close()` → `bus.close()`.
   */
  public async close(): Promise<void> {
    if (this._closePromise !== null) {
      return this._closePromise;
    }
    this._closed = true; // новые открытия запрещены с этого тика
    this._closePromise = (async () => {
      // In-flight OPENING-транзакции: дождаться исхода каждой
      await Promise.allSettled([...this._sessions.values()].map((session) => session.settled));

      for (const session of [...this._sessions.values()]) {
        await this.closeSession(session.marketId, 'SHUTDOWN');
      }

      // Инвариант: после teardown всех сессий shared-фиды освобождены
      if (this._rtdsFeeds.size > 0) {
        this._logger.warn('RTDS feeds leaked past session teardown, force-closing', {
          feeds: [...this._rtdsFeeds.keys()],
        });
        for (const [key, entry] of [...this._rtdsFeeds]) {
          this._rtdsFeeds.delete(key);
          await this._closeFeedSubscription(entry);
        }
      }

      this._logger.info('MarketCollectionCoordinator closed');
    })();
    return this._closePromise;
  }

  /**
   * Возвращает снимок runtime-состояния (диагностика/тесты/смоук).
   *
   * @returns Текущие значения {@link CollectionCoordinatorStats}
   */
  public getStats(): CollectionCoordinatorStats {
    const rtdsFeedRefCounts: Record<string, number> = {};
    for (const [key, entry] of this._rtdsFeeds) {
      rtdsFeedRefCounts[key] = entry.refs.size;
    }
    let active = 0;
    let opening = 0;
    for (const session of this._sessions.values()) {
      if (session.state === 'ACTIVE') {
        active++;
      } else {
        opening++;
      }
    }
    return { activeSessions: active, openingSessions: opening, rtdsFeedRefCounts };
  }

  /**
   * Возвращает снимки всех сессий (диагностика/смоук).
   *
   * @returns Список {@link CollectionSessionSnapshot}
   */
  public listSessions(): CollectionSessionSnapshot[] {
    return [...this._sessions.values()].map((session) => ({
      marketId: session.sourceMarketId,
      state: session.state,
      ...(session.selected !== undefined
        ? {
            question: session.selected.question,
            expiresAtMs: session.selected.expiresAt.toNumber(),
          }
        : {}),
      ...(session.openedAtMs !== undefined ? { openedAtMs: session.openedAtMs } : {}),
    }));
  }

  /**
   * Приобретает RTDS-фиды рынка: существующий фид — +ref, новый — одна
   * source-подписка на всех (PART 18).
   *
   * @param marketKey - Ключ рынка-владельца refs
   * @param feeds - Требуемые фиды выбранного рынка
   * @returns Ключи приобретённых фидов (для release)
   * @throws Ошибка подписки SDK — приобретённые refs уже освобождены
   *
   * @remarks
   * Конкурентная инициализация одного нового фида двумя рынками не создаёт
   * дублирующую SDK-подписку: entry с общим `pending` регистрируется
   * синхронно, оба acquire ждут один promise. Отказ подписки освобождает
   * refs всех ожидающих — последний удаляет entry, retry создаст новую.
   */
  private async _acquireRtdsFeeds(
    marketKey: string,
    feeds: readonly PolymarketRtdsFeed[],
  ): Promise<readonly string[]> {
    const acquired: string[] = [];
    for (const feed of feeds) {
      const key = rtdsFeedKey(feed);
      let entry = this._rtdsFeeds.get(key);
      if (entry === undefined) {
        entry = {
          feed,
          refs: new Set(),
          pending: this._source.subscribeCryptoPrices(feed.topic, [feed.symbol]),
        };
        this._rtdsFeeds.set(key, entry);
        this._logger.info('RTDS feed subscription opening', { feed: key });
      }
      entry.refs.add(marketKey);
      acquired.push(key);
      try {
        await entry.pending;
      } catch (error) {
        await this._releaseRtdsFeeds(marketKey, acquired);
        throw error;
      }
    }
    return acquired;
  }

  /**
   * Освобождает refs рынка на фиды; последний ref закрывает source-подписку.
   *
   * @param marketKey - Ключ рынка-владельца refs
   * @param feedKeys - Ключи фидов для освобождения
   */
  private async _releaseRtdsFeeds(marketKey: string, feedKeys: readonly string[]): Promise<void> {
    for (const key of feedKeys) {
      const entry = this._rtdsFeeds.get(key);
      if (entry === undefined || !entry.refs.has(marketKey)) {
        continue; // фид уже освобождён/заменён новой подпиской
      }
      entry.refs.delete(marketKey);
      if (entry.refs.size > 0) {
        continue; // фид нужен другим рынкам — подписка живёт (PART 39)
      }
      this._rtdsFeeds.delete(key);
      await this._closeFeedSubscription(entry);
      this._logger.info('RTDS feed subscription closed (no more refs)', { feed: key });
    }
  }

  /**
   * Закрывает source-подписку фида (ошибки открытия — уже обработанный отказ).
   *
   * @param entry - Запись фида
   */
  private async _closeFeedSubscription(entry: RtdsFeedEntry): Promise<void> {
    try {
      const subscription = await entry.pending;
      await subscription.close();
    } catch {
      // Подписка так и не открылась — закрывать нечего; отказ уже
      // залогирован путём acquire, транспортные ошибки close гасит Source.
    }
  }

  /**
   * Закрывает market-подписку сессии, не пробрасывая ошибки teardown.
   *
   * @param subscription - Открытая подписка Source
   * @param marketKey - Ключ рынка (для логов)
   */
  private async _closeMarketSubscription(
    subscription: PolymarketOpenSubscription,
    marketKey: string,
  ): Promise<void> {
    try {
      await subscription.close();
    } catch (error) {
      this._logger.warn('Failed to close market subscription', {
        marketId: marketKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Снимает recording-регистрацию при rollback открытия.
   *
   * @param marketId - ID рынка
   * @param marketKey - Ключ рынка (для логов)
   *
   * @remarks
   * `finalizeMarket(SHUTDOWN)` снимает routing и удаляет incomplete-файл
   * (существующая семантика Recorder/storage) — рынок можно ретраить.
   */
  private async _rollbackRecording(marketId: MarketId, marketKey: string): Promise<void> {
    try {
      await this._recorder.finalizeMarket(marketId, 'SHUTDOWN');
    } catch (error) {
      this._logger.warn('Failed to roll back recording registration', {
        marketId: marketKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Ленивая чистка lead-time памяти: ключи вне текущего candidate cache
   * (истёкшие рынки покидают discovery-окно) освобождаются.
   *
   * @param candidates - Текущий candidate cache
   */
  private _pruneLeadTimeRejected(candidates: readonly PolymarketDiscoveredMarket[]): void {
    if (this._leadTimeRejected.size === 0) {
      return;
    }
    const current = new Set(candidates.map((candidate) => String(candidate.marketId)));
    for (const key of [...this._leadTimeRejected]) {
      if (!current.has(key)) {
        this._leadTimeRejected.delete(key);
      }
    }
  }
}
