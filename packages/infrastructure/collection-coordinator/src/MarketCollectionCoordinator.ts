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
import type { Timestamp } from '@polymarket/timestamp';
import type {
  CryptoPricesChainlinkTwapWindowSeconds,
  CryptoPricesTopic,
  PolymarketDiscoveredMarket,
  PolymarketMarketDiscovery,
  PolymarketOpenSubscription,
  PolymarketRtdsFeed,
  PolymarketSource,
  PolymarketTwapRtdsFeed,
  SelectedPolymarketMarket,
} from '@polymarket/polymarket-v2';
import { isTwapRtdsFeed, rtdsFeedKey } from '@polymarket/polymarket-v2';
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
  'subscribeMarket' | 'subscribeCryptoPrices' | 'subscribeChainlinkTwap' | 'hasFailed'
>;

/**
 * Порт recorder-а, используемый координатором.
 *
 * @remarks
 * Регистрация recording-сессии + её снятие. `close()` recorder-а принадлежит
 * composition root (порядок shutdown контура — N-002).
 */
export type CollectionRecorder = Pick<
  ExternalMessageRecorder,
  'registerMarket' | 'narrowRtdsFeeds' | 'sealMarket' | 'finalizeMarket'
>;

/**
 * Порт наблюдателя settlement-потока, используемый координатором.
 *
 * @remarks
 * Единственный вопрос, который координатор ему задаёт: «пересечена ли
 * граница рынка в vendor-времени фида?». По нему решается, можно ли уже
 * замораживать датасет, или граничное наблюдение ещё в пути
 * (измеренная задержка доставки — 1.1–2.2 с, см. boundary grace).
 */
export interface CollectionSettlementObserver {
  /**
   * Пришло ли наблюдение фида с vendor-timestamp не раньше границы.
   *
   * @param feed - Settlement-фид рынка
   * @param atMs - Граница рынка (epoch ms)
   * @returns `true`, если граничное наблюдение уже получено
   */
  hasObservationAtOrAfter(feed: PolymarketTwapRtdsFeed, atMs: number): boolean;
}

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
  /**
   * Наблюдатель settlement-потока (ранний выход из boundary grace).
   *
   * @remarks
   * Опционален: без него граница выдерживается полным `settlementGraceMs`,
   * с ним — ровно до фактического прихода граничного наблюдения. Рынки без
   * settlement-фида не затрагиваются в обоих случаях.
   */
  readonly settlementObserver?: CollectionSettlementObserver;
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
  /**
   * Boundary grace settlement-потока: сколько ждать граничное наблюдение
   * TWAP ПОСЛЕ истечения рынка, прежде чем заморозить датасет.
   *
   * @defaultValue 5_000
   *
   * @remarks
   * Число измерено, а не выбрано: live-характеризация RTDS 2026-08-26
   * (`prices.crypto.chainlink.twap`, 1 Гц, btc/usd + eth/usd, n≈90) дала
   * задержку доставки `recv − payload.timestamp` в диапазоне 1116–2155 мс
   * (p50 ≈ 1.5 с). Grace — это измеренный максимум с запасом ×2, а не
   * догадка. Ожидание завершается ДОСРОЧНО, как только граничное
   * наблюдение получено (см. {@link CollectionSettlementObserver}).
   *
   * Затрагивает ТОЛЬКО settlement-фид: CLOB-подписка и spot-фиды рынка
   * закрываются ровно в момент истечения (PART 25 — trading lifecycle не
   * продлевается), routing записи на это время сужается до одного фида.
   */
  readonly settlementGraceMs?: number;
}

/** Дефолты конфигурации (см. {@link MarketCollectionCoordinatorConfig}). */
const DEFAULT_MIN_TIME_TO_START_MS = 2 * 60_000;
const DEFAULT_FALLBACK_MARKET_DURATION_MS = 15 * 60_000;
const DEFAULT_SETTLEMENT_GRACE_MS = 5_000;

/** Шаг опроса наблюдателя внутри boundary grace. */
const SETTLEMENT_POLL_MS = 250;

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
  /** Canonical id рынка сессии (== Polymarket conditionId). */
  readonly marketId: MarketId;
  readonly state: 'OPENING' | 'ACTIVE' | 'FINALIZING';
  readonly question?: string;
  /** Истечение рынка (canonical Timestamp, из выбранного рынка). */
  readonly expiresAt?: Timestamp;
  /** Момент открытия сессии (== recording startsAt, PART 9). */
  readonly openedAt?: Timestamp;
}

/**
 * Снимок одного shared RTDS-фида (диагностика/тесты/смоук).
 */
export interface CollectionRtdsFeedStat {
  /** Vendor topic фида (typed union SDK, включая settlement TWAP). */
  readonly topic: CryptoPricesTopic | PolymarketTwapRtdsFeed['topic'];
  /** Точный символ фида в нативном формате источника. */
  readonly symbol: string;
  /**
   * Окно усреднения settlement-потока (только для TWAP-фидов).
   *
   * @remarks
   * Присутствие поля — то, чем `btc/usd` TWAP 30 отличается от `btc/usd`
   * TWAP 60 в диагностике: это ДВА разных фида с двумя ref-count-ами.
   */
  readonly windowSeconds?: CryptoPricesChainlinkTwapWindowSeconds;
  /** Количество рынков, держащих ref на фид. */
  readonly refCount: number;
}

/**
 * Снимок runtime-состояния координатора (диагностика/тесты/смоук).
 */
export interface CollectionCoordinatorStats {
  readonly activeSessions: number;
  readonly openingSessions: number;
  /** Сессии post-expiry enrichment-а (слот capacity не занимают). */
  readonly finalizingSessions: number;
  /** Shared RTDS-фиды с ref-count (typed, без строковых `topic:symbol` ключей). */
  readonly rtdsFeeds: readonly CollectionRtdsFeedStat[];
}

/**
 * Immutable-снимок сессии, перешедшей в FINALIZING (N-004 PART 10).
 *
 * @remarks
 * Единственный контракт между Coordinator-ом и Finalizer-ом: finalizer НЕ
 * зависит от mutable private-состояния координатора. `selected` — уже
 * immutable результат Discovery V2 (identity, outcomes, event, crypto,
 * initial Gamma state) — его достаточно для fetchMarket/fetchEvent,
 * пересборки header-а и логирования; 30 отдельных копий полей не создаётся.
 */
export interface FinalizingMarketSession {
  /** Canonical id рынка (== Polymarket conditionId). */
  readonly marketId: MarketId;
  /** Момент начала записи (== открытие сессии, PART 9). */
  readonly recordingStartedAt: Timestamp;
  /** Полный immutable выбор рынка (identity/outcomes/timing/crypto/Gamma). */
  readonly selected: SelectedPolymarketMarket;
}

/**
 * Runtime-состояние одной сессии (минимальное, PART 15).
 */
interface CollectionSession {
  state: 'OPENING' | 'ACTIVE' | 'FINALIZING';
  /** Canonical id рынка (== conditionId); ключ maps — `String(marketId)`. */
  readonly marketId: MarketId;
  /** Заполняется на commit ACTIVE. */
  selected?: SelectedPolymarketMarket;
  marketSubscription?: PolymarketOpenSubscription;
  /** Ключи приобретённых RTDS-фидов (для release). */
  rtdsFeedKeys: readonly string[];
  /** Момент открытия сессии (== recording startsAt). */
  openedAt?: Timestamp;
  /** Завершение open-транзакции (для close()/closeSession()). */
  readonly settled: Promise<void>;
  /** Резолвер settled (вызывается транзакцией на любом исходе). */
  readonly settle: () => void;
  /**
   * Идущий boundary grace settlement-фида (см.
   * {@link MarketCollectionCoordinator.beginFinalization}).
   *
   * @remarks
   * Пока promise не разрешён, датасет ЕЩЁ НЕ заморожен: settlement-фид
   * дописывает граничные наблюдения. Всякий, кому нужен замороженный
   * датасет (архив, чтение записанных строк, shutdown), обязан сперва его
   * дождаться — для этого существует
   * {@link MarketCollectionCoordinator.awaitSettlementCapture}.
   */
  settlementCapture?: Promise<void>;
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
 * Читаемая метка фида для логов/диагностики.
 *
 * @param feed - Фид рынка
 * @returns Компактное описание, различающее окно settlement-потока
 *
 * @remarks
 * Идентичность фида даёт `rtdsFeedKey` из `@polymarket/polymarket-v2` —
 * ЕДИНОЕ правило на весь контур. Эта функция существует только ради
 * человекочитаемых логов и не участвует в сопоставлении.
 */
function rtdsFeedLabel(feed: PolymarketRtdsFeed): string {
  return isTwapRtdsFeed(feed)
    ? `${feed.topic}:${feed.symbol}@${String(feed.windowSeconds)}s`
    : `${feed.topic}:${feed.symbol}`;
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
  private readonly _settlementObserver: CollectionSettlementObserver | undefined;
  private readonly _clock: IClock;
  private readonly _logger: ILogger;
  private readonly _maxMarkets: number;
  private readonly _minTimeToStartMs: number;
  private readonly _fallbackMarketDurationMs: number;
  private readonly _settlementGraceMs: number;

  /** Сессии по `String(marketId)`; OPENING и ACTIVE занимают slot (PART 21). */
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
    this._settlementObserver = deps.settlementObserver;
    this._clock = deps.clock;
    this._logger = deps.logger.child({ component: 'MarketCollectionCoordinator' });
    this._maxMarkets = config.maxMarkets;
    this._minTimeToStartMs = config.minTimeToStartMs ?? DEFAULT_MIN_TIME_TO_START_MS;
    this._fallbackMarketDurationMs =
      config.fallbackMarketDurationMs ?? DEFAULT_FALLBACK_MARKET_DURATION_MS;
    this._settlementGraceMs = config.settlementGraceMs ?? DEFAULT_SETTLEMENT_GRACE_MS;
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
      if (this._closed || this._occupiedSlots() >= this._maxMarkets) {
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
    if (this._occupiedSlots() >= this._maxMarkets) {
      return 'skipped'; // capacity: ACTIVE + OPENING (FINALIZING слот не занимает)
    }

    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const session: CollectionSession = {
      state: 'OPENING',
      marketId: candidate.marketId,
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
    const key = String(session.marketId);

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
    // Инструменты рынка — единственный source of truth: outcomes[]
    const instrumentIds = selected.outcomes.map((outcome) => outcome.instrumentId);
    if (instrumentIds.length === 0) {
      this._sessions.delete(key);
      this._logger.warn('Selected market has no outcome instruments, skipping as unsupported', {
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
    const header = buildCollectionHeader({ selected, recordingStartsAt: startsAt });
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
        // Legacy boundary (единственное место конверсии): MarketMeta storage
        // принимает plain strings; branded InstrumentId — их подтип в runtime
        tokenIds: instrumentIds,
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
      // Vendor boundary — Source: branded InstrumentId проходит в SDK как есть
      marketSubscription = await this._source.subscribeMarket(instrumentIds);
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
    session.openedAt = startsAt; // тот же момент, что recording startsAt (PART 9)

    this._logger.info('Collection session opened', {
      marketId: key,
      question: selected.question,
      instruments: instrumentIds.length,
      rtdsFeeds: selected.rtdsFeeds.map(rtdsFeedLabel),
      expiresAt: new Date(selected.expiresAt.toNumber()).toISOString(),
      isCrypto: selected.crypto !== undefined,
    });
    return 'opened';
  }

  /**
   * Слоты, занятые под capacity: OPENING + ACTIVE (N-004 PART 3).
   *
   * @returns Количество сессий, занимающих active-слот
   *
   * @remarks
   * FINALIZING слот НЕ занимает (post-expiry enrichment не мешает открытию
   * новых рынков — parity с legacy, освобождавшим слот сразу при expiry),
   * но остаётся в `_sessions` — повторное открытие того же рынка блокирует
   * существующий guard `sessions.has(key)`.
   */
  private _occupiedSlots(): number {
    let occupied = 0;
    for (const session of this._sessions.values()) {
      if (session.state !== 'FINALIZING') {
        occupied++;
      }
    }
    return occupied;
  }

  /**
   * Expiry-переход: ACTIVE сессия → FINALIZING (N-004 PART 8/9).
   *
   * @param marketId - ID рынка ACTIVE-сессии
   * @returns Immutable-снимок для finalizer-а либо `undefined`, если сессии
   *   нет или она не ACTIVE (уже FINALIZING/OPENING/удалена) — переход
   *   выполняется максимум один раз на сессию
   *
   * @remarks
   * Порядок создаёт чёткий cutoff realtime-данных:
   *
   * 1. identity-safe пометка FINALIZING ДО первого await (двойной переход
   *    и конкурентный duplicate невозможны); слот capacity освобождён;
   * 2. закрытие market-подписки Source — trading lifecycle кончается ровно
   *    на истечении (PART 25) и НЕ продлевается;
   * 3. освобождение refs всех фидов, КРОМЕ settlement-потока рынка;
   * 4. сужение routing записи до одного settlement-фида
   *    (`recorder.narrowRtdsFeeds`) — с этого момента в датасет попадают
   *    только граничные наблюдения TWAP, а не «хвост» чужих spot-фидов;
   * 5. boundary grace: ожидание граничного наблюдения (или таймаут);
   * 6. `recorder.sealMarket` — routing снят, payload-датасет заморожен
   *    (буфер flushed, append-stream закрыт), header остаётся writable;
   * 7. освобождение ref settlement-фида.
   *
   * ### Почему шаги 4-5 существуют (гонка, найденная замером)
   *
   * RTDS доставляет наблюдение с vendor-timestamp `T` через 1.1–2.2 с
   * реального времени (характеризация 2026-08-26). Если заморозить датасет
   * ровно на `expiresAt`, ГРАНИЧНОЕ наблюдение — то самое, по которому
   * рынок и рассчитывается, — придёт уже после seal и будет потеряно. Тогда
   * deterministic fallback пришлось бы строить на предпоследнем значении,
   * то есть на другом числе, чем у оракула.
   *
   * Шаги 5-7 выполняются АСИНХРОННО: метод возвращает снимок сразу, не
   * задерживая проход finalizer-а. Всякий, кому нужен замороженный датасет,
   * дожидается {@link MarketCollectionCoordinator.awaitSettlementCapture}.
   *
   * `finalizeMarket(EXPIRED)` здесь НЕ вызывается — архивом владеет
   * finalizer после enrichment/timeout. Ошибки teardown-шагов логируются и
   * не отменяют переход: cutoff должен состояться в любом случае.
   */
  public async beginFinalization(marketId: MarketId): Promise<FinalizingMarketSession | undefined> {
    const key = String(marketId);
    const session = this._sessions.get(key);
    if (session === undefined || session.state !== 'ACTIVE') {
      this._logger.debug('beginFinalization: no ACTIVE session for market', {
        marketId: key,
        state: session?.state,
      });
      return undefined;
    }
    // Синхронный переход: с этого тика сессия не занимает слот и не может
    // быть закрыта как SHUTDOWN существующим closeSession (guard state)
    session.state = 'FINALIZING';
    const selected = session.selected!;
    const recordingStartedAt = session.openedAt!;

    // Trading lifecycle кончается на истечении — CLOB-подписка закрывается
    // ПЕРВОЙ и не продлевается никаким grace
    if (session.marketSubscription !== undefined) {
      await this._closeMarketSubscription(session.marketSubscription, key);
      session.marketSubscription = undefined;
    }

    const settlementFeed = selected.rtdsFeeds.find(isTwapRtdsFeed);
    const settlementKey = settlementFeed !== undefined ? rtdsFeedKey(settlementFeed) : undefined;
    const spotKeys = session.rtdsFeedKeys.filter((feedKey) => feedKey !== settlementKey);
    await this._releaseRtdsFeeds(key, spotKeys);
    session.rtdsFeedKeys = settlementKey !== undefined ? [settlementKey] : [];

    if (settlementFeed === undefined || this._settlementGraceMs <= 0) {
      await this._sealAndReleaseSettlement(session, key);
    } else {
      // Routing сужается СИНХРОННО с переходом: «хвост» spot-фидов, живых
      // ради других рынков, в датасет этого рынка больше не попадает
      const narrowed = await this._narrowToSettlementFeed(session.marketId, settlementFeed, key);
      session.settlementCapture = this._captureSettlementBoundary(
        session,
        key,
        settlementFeed,
        selected.expiresAt.toNumber(),
        narrowed,
      );
    }

    this._logger.info('Collection session entered finalization', {
      marketId: key,
      question: selected.question,
      expiresAt: new Date(selected.expiresAt.toNumber()).toISOString(),
      settlementFeed: settlementFeed !== undefined ? rtdsFeedLabel(settlementFeed) : undefined,
    });
    return { marketId: session.marketId, recordingStartedAt, selected };
  }

  /**
   * Дожидается заморозки датасета рынка после boundary grace.
   *
   * @param marketId - ID рынка в состоянии FINALIZING
   * @returns Promise, разрешающийся когда датасет гарантированно заморожен
   *
   * @remarks
   * No-op для рынков без settlement-фида и для уже завершённого grace —
   * вызывать можно сколько угодно раз. Это ОБЯЗАТЕЛЬНАЯ преамбула любого
   * чтения записанных строк и любого архивирования: без неё архив мог бы
   * поймать датасет в момент дописывания граничного наблюдения.
   *
   * @example
   * ```typescript
   * await coordinator.awaitSettlementCapture(marketId); // датасет заморожен
   * const lines = await recorder.readSealedPayloadLines(marketId, filter);
   * ```
   */
  public async awaitSettlementCapture(marketId: MarketId): Promise<void> {
    const capture = this._sessions.get(String(marketId))?.settlementCapture;
    if (capture !== undefined) {
      await capture;
    }
  }

  /**
   * Сужает routing записи рынка до одного settlement-фида.
   *
   * @param marketId - ID рынка
   * @param feed - Settlement-фид, который продолжает писаться
   * @param marketKey - Ключ рынка (для логов)
   * @returns `true`, если сужение фактически применено recorder-ом
   */
  private async _narrowToSettlementFeed(
    marketId: MarketId,
    feed: PolymarketTwapRtdsFeed,
    marketKey: string,
  ): Promise<boolean> {
    try {
      return this._recorder.narrowRtdsFeeds(marketId, [feed]);
    } catch (error) {
      this._logger.warn('Failed to narrow recording feeds to settlement stream', {
        marketId: marketKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Boundary grace: ждёт граничное наблюдение settlement-фида, затем
   * замораживает датасет и освобождает ref фида.
   *
   * @param session - Сессия в состоянии FINALIZING
   * @param marketKey - Ключ рынка
   * @param feed - Settlement-фид рынка
   * @param expiresAtMs - Граница рынка (epoch ms)
   * @param narrowed - Удалось ли сузить routing (иначе ждать бессмысленно)
   *
   * @remarks
   * Ожидание заканчивается по ПЕРВОМУ из событий: наблюдатель подтвердил
   * наблюдение с `vendorTs >= expiresAtMs`; исчерпан бюджет
   * `settlementGraceMs`; координатор закрывается. Без наблюдателя
   * выдерживается полный grace. Никогда не reject-ится: seal обязан
   * состояться при любом исходе.
   *
   * Бюджет отсчитывается КОЛИЧЕСТВОМ интервалов ожидания, а не разницей
   * показаний `IClock`. Это не стилистика: часы здесь инъецируемые, а спит
   * цикл на реальном таймере — при остановленных (тестовых) либо просто
   * отставших часах сравнение «прошло ли столько-то по часам» никогда не
   * стало бы истинным, и grace превратился бы в бесконечный опрос.
   * Отсчёт по интервалам ограничен сверху при ЛЮБОМ поведении часов.
   */
  private async _captureSettlementBoundary(
    session: CollectionSession,
    marketKey: string,
    feed: PolymarketTwapRtdsFeed,
    expiresAtMs: number,
    narrowed: boolean,
  ): Promise<void> {
    const observer = this._settlementObserver;
    let waitedMs = 0;
    if (narrowed) {
      const sliceMs =
        observer === undefined
          ? this._settlementGraceMs
          : Math.min(SETTLEMENT_POLL_MS, this._settlementGraceMs);
      const slices = Math.max(1, Math.ceil(this._settlementGraceMs / sliceMs));
      for (let slice = 0; slice < slices; slice++) {
        if (this._closed || observer?.hasObservationAtOrAfter(feed, expiresAtMs) === true) {
          break;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, sliceMs);
          timer.unref?.();
        });
        waitedMs += sliceMs;
      }
    }

    this._logger.info('Settlement boundary grace finished', {
      marketId: marketKey,
      feed: rtdsFeedLabel(feed),
      waitedMs,
      boundaryObserved: observer?.hasObservationAtOrAfter(feed, expiresAtMs),
    });
    await this._sealAndReleaseSettlement(session, marketKey);
  }

  /**
   * Замораживает датасет и освобождает оставшиеся refs фидов сессии.
   *
   * @param session - Сессия в состоянии FINALIZING
   * @param marketKey - Ключ рынка (для логов)
   */
  private async _sealAndReleaseSettlement(
    session: CollectionSession,
    marketKey: string,
  ): Promise<void> {
    const sealed = await this._recorder.sealMarket(session.marketId);
    if (!sealed) {
      this._logger.warn('Recorder seal reported no writer during expiry transition', {
        marketId: marketKey,
      });
    }
    await this._releaseRtdsFeeds(marketKey, session.rtdsFeedKeys);
    session.rtdsFeedKeys = [];
  }

  /**
   * Завершает FINALIZING-сессию после успешного EXPIRED-архива (PART 34/36).
   *
   * @param marketId - ID рынка
   * @returns `true` — сессия была FINALIZING и удалена; `false` — no-op
   *   (identity-guard: ACTIVE/OPENING replacement или отсутствие сессии
   *   не затрагиваются)
   */
  public completeFinalization(marketId: MarketId): boolean {
    const key = String(marketId);
    const session = this._sessions.get(key);
    if (session === undefined || session.state !== 'FINALIZING') {
      this._logger.debug('completeFinalization: no FINALIZING session for market', {
        marketId: key,
        state: session?.state,
      });
      return false;
    }
    this._sessions.delete(key);
    this._logger.info('Collection session finalization completed', { marketId: key });
    return true;
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

      // FINALIZING-сессии архивирует MarketFinalizer.close() ДО закрытия
      // координатора (порядок shutdown N-004). Оставшиеся здесь — признак
      // нарушенного порядка: realtime у них уже снят, файл заберёт
      // cleanup-policy storage при recorder.close(); ждать нечего.
      // Идущий boundary grace всё же дожидается: он владеет seal-ом, и
      // бросить его означало бы закрыть координатор поверх незамороженного
      // датасета (флаг _closed уже прервал его ожидание).
      for (const session of [...this._sessions.values()]) {
        if (session.state === 'FINALIZING') {
          await session.settlementCapture?.catch(() => undefined);
          this._sessions.delete(String(session.marketId));
          this._logger.warn(
            'Finalizing session dropped at coordinator close (finalizer should archive first)',
            { marketId: String(session.marketId) },
          );
        }
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
    const rtdsFeeds: CollectionRtdsFeedStat[] = [...this._rtdsFeeds.values()].map((entry) => ({
      topic: entry.feed.topic,
      symbol: entry.feed.symbol,
      ...(isTwapRtdsFeed(entry.feed) ? { windowSeconds: entry.feed.windowSeconds } : {}),
      refCount: entry.refs.size,
    }));
    let active = 0;
    let opening = 0;
    let finalizing = 0;
    for (const session of this._sessions.values()) {
      if (session.state === 'ACTIVE') {
        active++;
      } else if (session.state === 'OPENING') {
        opening++;
      } else {
        finalizing++;
      }
    }
    return {
      activeSessions: active,
      openingSessions: opening,
      finalizingSessions: finalizing,
      rtdsFeeds,
    };
  }

  /**
   * Возвращает снимки всех сессий (диагностика/смоук).
   *
   * @returns Список {@link CollectionSessionSnapshot}
   */
  public listSessions(): CollectionSessionSnapshot[] {
    return [...this._sessions.values()].map((session) => ({
      marketId: session.marketId,
      state: session.state,
      ...(session.selected !== undefined
        ? {
            question: session.selected.question,
            expiresAt: session.selected.expiresAt,
          }
        : {}),
      ...(session.openedAt !== undefined ? { openedAt: session.openedAt } : {}),
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
          // Vendor boundary: у settlement-потока СВОЙ spec подписки SDK
          // (обязательное окно усреднения), поэтому и метод Source отдельный
          pending: isTwapRtdsFeed(feed)
            ? this._source.subscribeChainlinkTwap(feed.windowSeconds, [feed.symbol])
            : this._source.subscribeCryptoPrices(feed.topic, [feed.symbol]),
        };
        this._rtdsFeeds.set(key, entry);
        this._logger.info('RTDS feed subscription opening', { feed: rtdsFeedLabel(feed) });
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
      this._logger.info('RTDS feed subscription closed (no more refs)', {
        feed: rtdsFeedLabel(entry.feed),
      });
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
