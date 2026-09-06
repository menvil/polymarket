/**
 * MarketFinalizer — post-expiry оркестрация V2-записей (N-004).
 *
 * @remarks
 * ### Место в архитектуре
 *
 * ```text
 * CONTROL PLANE
 *
 * MarketFinalizer.runOnce()          ← cadence принадлежит composition root
 *   ├── detects due ACTIVE sessions      (lifecycle.listSessions)
 *   ├── beginFinalization                (lifecycle: cutoff → grace → seal)
 *   ├── fetchMarket / fetchEvent         (официальный SDK, query plane)
 *   ├── updateMarketMeta                 (recorder: canonical V2 header LINE 1)
 *   ├── finalizeMarket(EXPIRED)          (recorder: flush → gzip)
 *   └── completeFinalization             (lifecycle: снять FINALIZING)
 * ```
 *
 * ### Граница immutable-датасета
 *
 * ```text
 * expiresAt → cutoff → settlement grace → SEAL → release claim
 *                                           │
 *                                           └── ТОЛЬКО ПОСЛЕ ЭТОГО: Gamma polling
 * ```
 *
 * Ни один Gamma-запрос не влияет на поток сырых наблюдений: к моменту первой
 * попытки enrichment датасет уже заморожен (`awaitSettlementCapture`), а
 * физический claim коллектора снят.
 *
 * Finalizer НЕ владеет candidate cache, session lifecycle, storage, общим bus
 * и физическими подписками; Gamma polling — control/query plane: никаких
 * synthetic ExternalMessages (PART 33), таймеров внутри core-класса нет
 * (PART 13).
 *
 * ### Resolution policy (MR-B)
 *
 * ```text
 * рынок истёк → FINALIZING → Gamma polling каждые 30 с
 *      │
 *      ├── пришло ВСЁ: победитель + priceToBeat + finalPrice
 *      │                              ──────► OFFICIAL COMPLETE  → .jsonl.gz
 *      │
 *      ├── пришло частично ──────────────────► ждём дальше (бюджет 60 мин)
 *      │
 *      ├── бюджет исчерпан ЛИБО shutdown
 *      │     ├── есть официальный победитель ─► OFFICIAL COMPLETE  → .jsonl.gz
 *      │     │      (недостающие числа — из записанного ряда, помечены derived)
 *      │     └── иначе deterministic TWAP ────► FALLBACK COMPLETE  → .jsonl.gz
 *      │
 *      └── итог вывести нельзя ──────────────► DISCARD (файл удаляется)
 * ```
 *
 * Инвариант архива: `.jsonl.gz` поддержанного крипто-рынка ВСЕГДА несёт
 * известного победителя (`instrumentId` + `outcomeIndex` + `label`) и
 * происхождение этого знания. Архива вида `{status: timeout, winning: null}`
 * больше не существует — незавершаемый датасет удаляется, а не выдаётся за
 * пригодный к replay.
 *
 * ### Completion condition (PART 27/32/44)
 *
 * - crypto-рынок: COMPLETE при ПОЛНОМ комплекте официальных данных —
 *   победитель (resolved settlement-цены UMA либо формула рынка на
 *   официальных числах) И `priceToBeat` И `finalPrice`. Частичный комплект
 *   рынок не закрывает: решение user — дожидаться максимума информации,
 *   раз бюджет всё равно есть. Ожидание дёшево: датасет заморожен, слот
 *   свободен, стоимость — один Gamma-poll раз в `enrichmentRetryMs`;
 * - non-crypto: best-effort свежий Gamma-снапшот и НЕМЕДЛЕННЫЙ EXPIRED
 *   (без многочасовых resolution-watcher-ов);
 * - по исчерпании бюджета рынок закрывается тем, что есть: недостающие
 *   `priceToBeat`/`finalPrice` восполняются из записанного settlement-ряда
 *   и помечаются `provenance.priceToBeat`/`finalPrice = 'derived'`.
 *   Официальное число НИКОГДА не подменяется выведенным.
 *
 * ### Scope fallback-деривации (PART 30/89/90)
 *
 * Fallback применяется ТОЛЬКО к рынкам с распознанным settlement-дескриптором
 * (`resolution.source` → Chainlink TWAP с точным окном). Рынки Binance-
 * источника и не-крипто сохраняют прежнее поведение, включая приблизительную
 * ступень `recorded-rtds` и статус `'timeout'`: их правило расчёта не
 * охарактеризовано, и придумывать его этот MR не берётся.
 *
 * ### Retry-семантика (PART 28/29)
 *
 * Один `runOnce()` = максимум ОДНА логическая Gamma-попытка на pending
 * рынок; повторные попытки не раньше `enrichmentRetryMs` (30 с parity).
 * Отказ Gamma сохраняет FINALIZING/lastKnown/файл — следующий runOnce
 * продолжает. Бесконечных ретраев нет — таймаут ограничивает ожидание.
 */
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import type { createPublicClient } from '@polymarket/client';
import type {
  PolymarketCryptoFinalization,
  PolymarketGammaEvent,
  PolymarketGammaMarket,
} from '@polymarket/polymarket-v2';
import {
  CHAINLINK_TWAP_TOPIC,
  deriveWinnerFromCryptoPrices,
  deriveWinningOutcome,
  extractCryptoFinalization,
  isTwapRtdsFeed,
  mapFinalOutcomes,
} from '@polymarket/polymarket-v2';
import type {
  PolymarketFinalOutcome,
  PolymarketTwapRtdsFeed,
  SelectedPolymarketMarket,
} from '@polymarket/polymarket-v2';
import type {
  CollectionFallbackTrigger,
  CollectionHeaderFinalization,
  CollectionSettlementDescriptor,
  FinalizingCollectionSession,
  PolymarketCollectionLifecycle,
} from '@polymarket/collector';
import { buildFinalizedMarketHeader } from '@polymarket/collector';
import type { ExternalMessageRecorder } from '@polymarket/external-message-recorder';
import { deriveWinnerFromRecordedChainlink } from './recordedChainlinkWinner.js';
import { deriveWinnerFromRecordedTwap } from './recordedTwapSettlement.js';
import type { RecordedTwapDerivation } from './recordedTwapSettlement.js';

/**
 * Query-возможности официального SDK, используемые finalizer-ом (PART 15).
 *
 * @remarks
 * Тот же приём, что у Source/Discovery: тип выведен из официального
 * `PublicClient` — никакого custom Gamma HTTP.
 */
export type FinalizationGammaClient = Pick<
  ReturnType<typeof createPublicClient>,
  'fetchMarket' | 'fetchEvent'
>;

/**
 * Immutable-снимок финализируемой сессии в терминах контура сбора.
 *
 * @remarks
 * Vendor-подготовка рынка здесь конкретная (`SelectedPolymarketMarket`):
 * финализатору нужны Gamma-идентификаторы, правило расчёта и initial-снапшот.
 * Пакет коллектора обобщён по этому типу именно затем, чтобы конкретизация
 * жила ЗДЕСЬ — там, где vendor-модель уже законна.
 */
export type FinalizingMarketSession = FinalizingCollectionSession<SelectedPolymarketMarket>;

/**
 * Порт lifecycle collection-сессий, используемый finalizer-ом (PART 37).
 *
 * @remarks
 * Только session-lifecycle операции; private state lifecycle недоступен —
 * due-сессии определяются по read-only снимкам `listSessions()`.
 *
 * Canonical зависимость — `PolymarketCollectionLifecycle`
 * (`@polymarket/collector`), а НЕ legacy `MarketCollectionCoordinator`:
 * тот сам владел подписками и vendor-подготовкой, и финализатор через него
 * тянул бы за собой всю снятую с вооружения архитектуру.
 */
export type FinalizationLifecycle = Pick<
  PolymarketCollectionLifecycle<SelectedPolymarketMarket>,
  | 'listSessions'
  | 'beginFinalization'
  | 'getFinalizingSession'
  | 'awaitSettlementCapture'
  | 'completeFinalization'
>;

/**
 * Порт recorder-а, используемый finalizer-ом.
 *
 * @remarks
 * `readSealedPayloadLines` — read-путь ступени `recorded-rtds`
 * winner-ladder: приблизительная деривация из записанного chainlink-ряда,
 * когда официальных данных нет вообще.
 */
export type FinalizationRecorder = Pick<
  ExternalMessageRecorder,
  'updateMarketMeta' | 'finalizeMarket' | 'readSealedPayloadLines'
>;

/**
 * Итог одной попытки финализации рынка.
 *
 * - `'official'` — победитель получен из официальных данных Gamma/UMA;
 * - `'fallback'` — победитель выведен из записанного settlement-потока;
 * - `'discarded'` — итог вывести нельзя, датасет УДАЛЁН (архива нет);
 * - `'best-effort'` — рынок ВНЕ поддержанного TWAP-scope (не-крипто либо
 *   Binance-источник) заархивирован best-known данными; победитель при этом
 *   может отсутствовать, и «официальной финализацией» это не считается;
 * - `'deferred'` — решения на этом проходе нет, рынок остаётся pending и
 *   будет повторён; ничего не удалено и не заархивировано;
 * - `'archive-failed'` — итог известен, но записать архив не удалось
 *   (header/gzip). Датасет НЕ удаляется: незавершённый `.jsonl` заберёт
 *   cleanup storage, а `.gz` сознательно не создаётся;
 * - `'discard-failed'` — итог вывести нельзя И удалить датасет не удалось.
 *   Файл, скорее всего, остался на диске: сессия НЕ снимается и в счётчик
 *   удалённых НЕ попадает.
 *
 * Различие между тремя последними — не косметика: `'discarded'` означает
 * «данные стёрты», и путать с ним отказ записи значило бы приписывать
 * системе удаление, которого не было.
 */
export type FinalizationOutcome =
  | 'official'
  | 'fallback'
  | 'discarded'
  | 'best-effort'
  | 'deferred'
  | 'archive-failed'
  | 'discard-failed';

/**
 * Зависимости {@link MarketFinalizer}.
 */
export interface MarketFinalizerDependencies {
  /** Lifecycle collection sessions (expiry-переходы/завершение). */
  readonly lifecycle: FinalizationLifecycle;
  /** Recording-подписчик (header update + EXPIRED архив). */
  readonly recorder: FinalizationRecorder;
  /** Официальный SDK public client (query plane). */
  readonly gamma: FinalizationGammaClient;
  /** Источник времени (DI — детерминированные expiry/timeout тесты, PART 14). */
  readonly clock: IClock;
  /** Логгер (будет обёрнут в child с component-контекстом). */
  readonly logger: ILogger;
}

/**
 * Конфигурация {@link MarketFinalizer}.
 */
export interface MarketFinalizerConfig {
  /**
   * Минимальная пауза между enrichment-попытками одного рынка.
   * @defaultValue 30_000 (parity с legacy ENRICHMENT_INTERVAL_MS)
   */
  readonly enrichmentRetryMs?: number;
  /**
   * Максимальное ожидание ПОЛНОГО комплекта официальных данных; по
   * исчерпании рынок закрывается тем, что есть (см. resolution policy
   * класса: official → deterministic TWAP fallback → discard).
   *
   * @defaultValue 3_600_000 (60 минут)
   *
   * @remarks
   * Это потолок ожидания, а не типичное время: рынок архивируется сразу,
   * как только пришли победитель И `priceToBeat` И `finalPrice`.
   *
   * Бюджет выбран по замеру (2026-08-26, 4 рынка `*-updown-15m`, секунды
   * после истечения): `priceToBeat` — 21…143, `uma=resolved` — 311…600,
   * `finalPrice` — 1054…1296. Ждать приходится самый медленный сигнал,
   * то есть до ~21.6 минуты; 60 минут покрывают это с запасом ×2.8.
   *
   * Ожидание дёшево: FINALIZING не занимает слот, датасет заморожен —
   * стоимость равна одному Gamma-poll-у раз в `enrichmentRetryMs`.
   *
   * Исчерпание бюджета — ТРИГГЕР, а не итог: для рынка с распознанным
   * settlement-дескриптором оно запускает deterministic-деривацию из
   * записанного TWAP-ряда, а недостающие официальные числа восполняются
   * из него же с пометкой `derived`. Статус `'timeout'` остаётся только
   * у рынков вне поддержанного scope (Binance-источник, не-крипто).
   */
  readonly enrichmentMaxWaitMs?: number;

  /**
   * Пауза между проходами {@link MarketFinalizer.drain} (ms).
   *
   * @defaultValue значение `enrichmentRetryMs`
   *
   * @remarks
   * Отдельная ручка нужна тестам (детерминизм с инъецированными часами);
   * в production совпадает с cadence enrichment-попыток — чаще опрашивать
   * нет смысла, попытки всё равно due раз в `enrichmentRetryMs`.
   */
  readonly drainPollMs?: number;
}

/** Дефолты конфигурации (см. {@link MarketFinalizerConfig}). */
const DEFAULT_ENRICHMENT_RETRY_MS = 30_000;
const DEFAULT_ENRICHMENT_MAX_WAIT_MS = 60 * 60_000;

/**
 * Снимок runtime-состояния finalizer-а (диагностика/тесты/смоук).
 */
export interface MarketFinalizerStats {
  /** Рынки в post-expiry enrichment-е (ещё не заархивированы). */
  readonly pendingFinalizations: number;
  /** Успешно заархивированные EXPIRED-датасеты. */
  readonly archivedTotal: number;
  /** Терминальные отказы архива (gzip упал; retry сознательно нет — PART 35). */
  readonly archiveFailures: number;
  /** Архивы с победителем из ОФИЦИАЛЬНЫХ данных Gamma/UMA. */
  readonly officialFinalizations: number;
  /** Архивы с победителем, выведенным из записанного settlement-потока. */
  readonly fallbackFinalizations: number;
  /** Из них: fallback запущен исчерпанием 60-минутного бюджета. */
  readonly fallbackByTimeout: number;
  /** Из них: fallback запущен остановкой процесса. */
  readonly fallbackByShutdown: number;
  /** Датасеты, удалённые как неразрешимые (архив НЕ создан). */
  readonly discardedUnresolvable: number;
}

/** Победитель в форме, пригодной для header-а (identity + происхождение). */
type ArchiveWinning = NonNullable<CollectionHeaderFinalization['winning']>;

/**
 * Решение об итоге рынка — то, что отличает один архив от другого.
 *
 * @remarks
 * Общие поля finalization-раздела (`startedAtMs`/`finalizedAtMs`/
 * `attempts`/`resolution`/`outcomes`) заполняются единообразно при записи
 * header-а и в решение не входят: их значение не зависит от того, каким
 * путём получен итог.
 */
interface ArchiveDecision {
  readonly status: CollectionHeaderFinalization['status'];
  readonly winning?: ArchiveWinning;
  readonly provenance?: CollectionHeaderFinalization['provenance'];
  readonly crypto?: CollectionHeaderFinalization['crypto'];
}

/**
 * Pending-финализация одного рынка (внутреннее состояние).
 */
interface PendingFinalization {
  readonly session: FinalizingMarketSession;
  /** Момент перехода в FINALIZING (ms). */
  readonly startedAtMs: number;
  attempts: number;
  lastAttemptMs: number | null;
  /** Best-known свежие Gamma-снапшоты (последний успешный refresh). */
  freshMarket?: PolymarketGammaMarket;
  freshEvent?: PolymarketGammaEvent;
  /** Best-known официальные крипто-значения (merge по мере появления). */
  crypto: PolymarketCryptoFinalization;
  /** Терминальный отказ архива: дальнейшие попытки не выполняются. */
  archiveFailed: boolean;
}

/**
 * Нормализует правило расчёта рынка для finalization-раздела header-а.
 *
 * @param selected - Vendor-подготовка рынка
 * @returns Дескриптор settlement либо `undefined`, если правило не распознано
 *
 * @remarks
 * Дескриптор попадает в CORE header-а, чтобы читателю архива не приходилось
 * ни парсить `resolution.source` URL, ни знать формат стримов Chainlink,
 * чтобы понять, чем рынок резолвился. Canonical header допуска этих
 * vendor-подробностей не несёт — он строится из доменного `Market`.
 */
function describeSettlement(
  selected: SelectedPolymarketMarket,
): CollectionSettlementDescriptor | undefined {
  const settlement = selected.crypto?.settlement;
  if (settlement === undefined) {
    return undefined;
  }
  return {
    kind: settlement.kind,
    topic: CHAINLINK_TWAP_TOPIC,
    symbol: settlement.symbol,
    windowSeconds: settlement.windowSeconds,
    resolutionSource: settlement.resolutionSource,
  };
}

/**
 * Post-expiry finalizer V2-записей: due ACTIVE → FINALIZING → Gamma
 * enrichment → финальный header → EXPIRED gzip → снятие сессии.
 *
 * @example
 * ```typescript
 * const finalizer = new MarketFinalizer(
 *   { lifecycle, recorder, gamma: createPublicClient(), clock, logger },
 *   {},
 * );
 * // composition root cadence:
 * setInterval(() => void finalizer.runOnce(), 5_000);
 * // штатный shutdown (ДО coordinator.close()): дождаться официальных
 * // резолюций уже начатых финализаций, затем закрыть
 * await finalizer.drain();
 * await finalizer.close();
 * ```
 */
export class MarketFinalizer {
  private readonly _lifecycle: FinalizationLifecycle;
  private readonly _recorder: FinalizationRecorder;
  private readonly _gamma: FinalizationGammaClient;
  private readonly _clock: IClock;
  private readonly _logger: ILogger;
  private readonly _retryMs: number;
  private readonly _maxWaitMs: number;
  private readonly _drainPollMs: number;

  /** Pending-финализации по `String(marketId)`. */
  private readonly _pending = new Map<string, PendingFinalization>();
  /** In-flight runOnce: конкурентные вызовы разделяют один проход (PART 38). */
  private _runInFlight: Promise<void> | null = null;
  /** In-flight drain: конкурентные вызовы разделяют одно ожидание. */
  private _drainInFlight: Promise<void> | null = null;
  /** Пробуждения спящих drain-пауз (close() прерывает ожидание немедленно). */
  private readonly _drainWakeups = new Set<() => void>();
  private _closed = false;
  private _closePromise: Promise<void> | null = null;
  private _archivedTotal = 0;
  private _archiveFailures = 0;
  private _officialFinalizations = 0;
  private _fallbackFinalizations = 0;
  private _fallbackByTimeout = 0;
  private _fallbackByShutdown = 0;
  private _discardedUnresolvable = 0;

  /**
   * Создаёт finalizer поверх инъецированных coordinator/recorder/gamma.
   *
   * @param deps - Зависимости (см. {@link MarketFinalizerDependencies})
   * @param config - Конфигурация retry/timeout (см. {@link MarketFinalizerConfig})
   */
  constructor(deps: MarketFinalizerDependencies, config: MarketFinalizerConfig = {}) {
    this._lifecycle = deps.lifecycle;
    this._recorder = deps.recorder;
    this._gamma = deps.gamma;
    this._clock = deps.clock;
    this._logger = deps.logger.child({ component: 'MarketFinalizer' });
    this._retryMs = config.enrichmentRetryMs ?? DEFAULT_ENRICHMENT_RETRY_MS;
    this._maxWaitMs = config.enrichmentMaxWaitMs ?? DEFAULT_ENRICHMENT_MAX_WAIT_MS;
    this._drainPollMs = config.drainPollMs ?? this._retryMs;
  }

  /** true после {@link MarketFinalizer.close}. */
  public get isClosed(): boolean {
    return this._closed;
  }

  /**
   * Возвращает снимок runtime-состояния.
   *
   * @returns Текущие значения {@link MarketFinalizerStats}
   */
  public getStats(): MarketFinalizerStats {
    return {
      pendingFinalizations: this._pending.size,
      archivedTotal: this._archivedTotal,
      archiveFailures: this._archiveFailures,
      officialFinalizations: this._officialFinalizations,
      fallbackFinalizations: this._fallbackFinalizations,
      fallbackByTimeout: this._fallbackByTimeout,
      fallbackByShutdown: this._fallbackByShutdown,
      discardedUnresolvable: this._discardedUnresolvable,
    };
  }

  /**
   * Один проход finalizer-а: expiry-переходы + enrichment-попытки (PART 13).
   *
   * @returns Promise завершения прохода
   *
   * @remarks
   * 1. по `listSessions()` начинает финализацию всех due ACTIVE-сессий
   *    (`expiresAt <= now`);
   * 2. для каждого pending рынка выполняет максимум одну Gamma-попытку
   *    (cadence `enrichmentRetryMs`), обновляет header best-known данными
   *    (PART 30) и архивирует при complete/timeout.
   *
   * Конкурентные вызовы дедуплицируются: второй `runOnce` ждёт тот же
   * in-flight проход (двойных begin/fetch/update/gzip не бывает — PART 38/59).
   * Периодический cadence принадлежит composition root.
   */
  public async runOnce(): Promise<void> {
    if (this._closed) {
      return;
    }
    if (this._runInFlight !== null) {
      return this._runInFlight;
    }
    this._runInFlight = this._runPass().finally(() => {
      this._runInFlight = null;
    });
    return this._runInFlight;
  }

  /**
   * Graceful wind-down: дожидается завершения УЖЕ НАЧАТЫХ финализаций.
   *
   * @returns Promise, разрешающийся когда pending-финализаций не осталось
   *   (каждая заархивирована `complete` либо `timeout` по СВОЕМУ полному
   *   бюджету `enrichmentMaxWaitMs`) или после {@link MarketFinalizer.close}
   *
   * @remarks
   * Решение user 2026-08-25 (находка CHECKPOINT #1): остановка процесса не
   * должна срезать 60-минутное окно ожидания официальной резолюции —
   * `finalizer.close()` архивировал best-known через секунды после expiry,
   * тогда как Gamma резолвил рынок через ~20 секунд после выхода.
   *
   * Семантика:
   * 1. крутит {@link MarketFinalizer.runOnce} с паузой `drainPollMs`
   *    (по умолчанию — cadence enrichment-попыток): опрос официальной
   *    резолюции продолжается тем же 30-секундным ритмом;
   * 2. НЕ мешает expiry-переходам: ACTIVE-рынок, истёкший во время drain,
   *    входит в FINALIZING и тоже дожидается (данные не теряются);
   *    рынки, НЕ истёкшие к концу drain, остаются ACTIVE — их закроет
   *    `lifecycle.close()` политикой SHUTDOWN;
   * 3. возвращается, когда drainable pending нет (archiveFailed-остатки
   *    не ждутся — их архив терминально отказал, PART 35);
   * 4. {@link MarketFinalizer.close} прерывает ожидание немедленно —
   *    аварийный best-known путь сохранён.
   *
   * Верхняя граница длительности: последний вход в FINALIZING +
   * `enrichmentMaxWaitMs`. Конкурентные вызовы разделяют одно ожидание.
   *
   * @example
   * ```typescript
   * // штатный shutdown composition root:
   * await finalizer.drain();  // дождаться официальных резолюций
   * await finalizer.close();
   * await lifecycle.close();
   * ```
   */
  public async drain(): Promise<void> {
    if (this._closed) {
      return;
    }
    if (this._drainInFlight !== null) {
      return this._drainInFlight;
    }
    this._drainInFlight = (async () => {
      this._logger.info('Draining pending finalizations', {
        pending: this._pending.size,
      });
      for (;;) {
        if (this._closed) {
          break;
        }
        await this.runOnce();
        const drainable = [...this._pending.values()].some((entry) => !entry.archiveFailed);
        if (!drainable || this._closed) {
          break;
        }
        await this._interruptibleDelay(this._drainPollMs);
      }
      this._logger.info('Finalization drain finished', {
        pending: this._pending.size,
        interrupted: this._closed,
      });
    })().finally(() => {
      this._drainInFlight = null;
    });
    return this._drainInFlight;
  }

  /**
   * Пауза drain-цикла, прерываемая {@link MarketFinalizer.close}.
   *
   * @param ms - Длительность паузы
   * @returns Promise, разрешающийся по таймеру ЛИБО по пробуждению close()
   */
  private _interruptibleDelay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this._drainWakeups.delete(wake);
        resolve();
      };
      const timer = setTimeout(() => {
        this._drainWakeups.delete(wake);
        resolve();
      }, ms);
      this._drainWakeups.add(wake);
    });
  }

  /**
   * Deterministic shutdown (PART 40).
   *
   * @returns Promise завершения shutdown
   *
   * @remarks
   * 1. новые runOnce запрещаются; спящий drain пробуждается и завершается,
   *    in-flight проход дожидается;
   * 2. каждый УЖЕ FINALIZING рынок (реально expired, датасет sealed)
   *    завершается БЕЗ новых Gamma-запросов (сеть не задерживает shutdown)
   *    по той же лестнице, что и при таймауте:
   *
   *    ```text
   *    официальный результат уже есть   → архив (provenance official)
   *    иначе deterministic TWAP fallback → архив (provenance fallback,
   *                                        trigger shutdown)
   *    иначе                             → датасет УДАЛЯЕТСЯ
   *    ```
   *
   *    Остановка процесса ускоряет fallback (PART 5): ждать оставшиеся
   *    минуты официальной резолюции незачем, когда итог уже выводится из
   *    записанного settlement-потока детерминированно;
   * 3. ACTIVE рынки НЕ трогаются — их закроет `lifecycle.close()` как
   *    SHUTDOWN (incomplete-файлы удалятся).
   *
   * Архива с неизвестным победителем этот путь больше не производит:
   * незавершаемый датасет удаляется, а не выдаётся за пригодный к replay.
   * Штатный wind-down сначала вызывает {@link MarketFinalizer.drain} — тогда
   * до `close()` pending уже пуст. Общий bus finalizer-ом не закрывается.
   * Идемпотентен.
   */
  public async close(): Promise<void> {
    if (this._closePromise !== null) {
      return this._closePromise;
    }
    this._closed = true;
    for (const wake of [...this._drainWakeups]) {
      wake();
    }
    this._closePromise = (async () => {
      if (this._drainInFlight !== null) {
        await this._drainInFlight.catch(() => undefined);
      }
      if (this._runInFlight !== null) {
        await this._runInFlight.catch(() => undefined);
      }
      const nowMs = this._clock.now().getTime();
      for (const entry of [...this._pending.values()]) {
        if (entry.archiveFailed) {
          continue;
        }
        // Per-market изоляция (как в _runPass): отказ одного рынка не имеет
        // права лишить архива ВСЕ остальные pending-рынки — их файлы иначе
        // ушли бы в cleanup вместе с записью
        try {
          await this._archiveEntry(entry, nowMs, 'shutdown');
        } catch (error) {
          this._logger.error('Shutdown archive failed for market, continuing with the rest', {
            marketId: String(entry.session.marketId),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (this._pending.size > 0) {
        this._logger.warn('Finalizer closed with unarchived markets (archive failures)', {
          markets: [...this._pending.keys()],
        });
      }
      this._logger.info('MarketFinalizer closed', { stats: this.getStats() });
    })();
    return this._closePromise;
  }

  /**
   * Тело одного прохода (см. {@link MarketFinalizer.runOnce}).
   */
  private async _runPass(): Promise<void> {
    const nowMs = this._clock.now().getTime();

    // ── 1. Подхват FINALIZING-сессий (кто бы ни совершил переход) ────────────
    //
    // Границу датасета держит ТОЧНЫЙ таймер сессии в lifecycle, а не этот
    // проход. Значит, к моменту прохода рынок обычно УЖЕ FINALIZING, и
    // `beginFinalization` честно отвечает `undefined` (переход ровно один
    // раз). Искать только ACTIVE значило бы никогда не подхватить такой
    // рынок: seal и release состоялись бы, а Gamma polling — нет, и сессия
    // висела бы FINALIZING вечно.
    //
    // Поэтому источников снимка два, а регистрация — одна:
    //
    //   ACTIVE && due  → beginFinalization()      (переход делаем сами)
    //   FINALIZING     → getFinalizingSession()   (переход сделал кто-то)
    //
    // Дедупликация — по `_pending`: рынок регистрируется ровно один раз,
    // независимо от того, кто и когда его перевёл.
    for (const snapshot of this._lifecycle.listSessions()) {
      const key = String(snapshot.marketId);
      if (this._pending.has(key)) {
        continue;
      }
      // Per-session изоляция: отказ перехода одного рынка (например, throw
      // seal-пути) не роняет runOnce и не лишает остальные сессии enrichment-а
      let session: FinalizingMarketSession | undefined;
      if (snapshot.state === 'FINALIZING') {
        session = this._lifecycle.getFinalizingSession(snapshot.marketId);
      } else if (snapshot.expiresAt.toNumber() <= nowMs) {
        try {
          session = await this._lifecycle.beginFinalization(snapshot.marketId);
        } catch (error) {
          this._logger.error('beginFinalization failed for expired market, continuing pass', {
            marketId: key,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
      } else {
        continue; // рынок ещё торгуется
      }
      if (session === undefined) {
        continue; // сессию успели снять/заменить между снимком и вызовом
      }
      this._pending.set(key, {
        session,
        // Момент ГРАНИЦЫ, а не момент подхвата: иначе `startedAtMs` архива
        // и отсчёт бюджета ожидания сдвигались бы на задержку control-тика.
        startedAtMs: session.finalizingSinceMs,
        attempts: 0,
        lastAttemptMs: null,
        crypto: {},
        archiveFailed: false,
      });
      this._logger.info('Market expired, finalization started', {
        marketId: key,
        question: session.selected.question,
        isCrypto: session.selected.crypto !== undefined,
        transitionedBy: snapshot.state === 'FINALIZING' ? 'lifecycle' : 'finalizer',
      });
    }

    // ── 2. Enrichment-попытки pending рынков (cadence/timeout) ──────────────
    for (const entry of [...this._pending.values()]) {
      if (entry.archiveFailed) {
        continue;
      }
      const timedOut = nowMs - entry.startedAtMs >= this._maxWaitMs;
      const due =
        entry.lastAttemptMs === null || timedOut || nowMs - entry.lastAttemptMs >= this._retryMs;
      if (!due) {
        continue;
      }
      try {
        await this._attemptEnrichment(entry, nowMs, timedOut);
      } catch (error) {
        // Ожидаемые отказы обработаны внутри; сюда попадает только
        // неожиданное исключение — рынок остаётся pending, проход продолжается
        this._logger.error('Enrichment attempt failed unexpectedly, continuing pass', {
          marketId: String(entry.session.marketId),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Одна enrichment-попытка pending рынка (максимум один Gamma refresh).
   *
   * @param entry - Pending-финализация
   * @param nowMs - Момент прохода
   * @param timedOut - Бюджет ожидания исчерпан (архивировать best-known)
   *
   * @remarks
   * ### Датасет заморожен ДО первого Gamma-запроса
   *
   * ```text
   * expiresAt → FINALIZING → settlement grace → seal → release claim
   *                                                      │
   *                                                      └── и только теперь
   *                                                          Gamma polling
   * ```
   *
   * Ожидание границы стоит ЗДЕСЬ, а не только перед архивом: иначе первая
   * попытка уходила бы в сеть, пока settlement grace ещё дописывает граничное
   * наблюдение TWAP, а промежуточный `pending`-header переписывал бы LINE 1
   * ещё не замороженного датасета. Инвариант «ни один Gamma-запрос не влияет
   * на поток сырых наблюдений» держится только при таком порядке.
   *
   * Вызов идемпотентен и после завершения границы стоит ноль (`no-op`), так
   * что цену платит ровно первая попытка каждого рынка.
   *
   * Момент попытки (`nowMs`) СОЗНАТЕЛЬНО остаётся моментом прохода: он задаёт
   * retry cadence и отсчёт бюджета, которые принадлежат проходу, а не
   * длительности ожидания границы.
   */
  private async _attemptEnrichment(
    entry: PendingFinalization,
    nowMs: number,
    timedOut: boolean,
  ): Promise<void> {
    const key = String(entry.session.marketId);
    const selected = entry.session.selected;
    // Граница датасета ПЕРЕД сетью: seal и release claim уже состоялись
    await this._lifecycle.awaitSettlementCapture(entry.session.marketId);
    entry.attempts++;
    entry.lastAttemptMs = nowMs;

    let gammaOk = true;
    try {
      entry.freshMarket = await this._gamma.fetchMarket({ id: selected.gammaMarketId });
      if (selected.event !== undefined) {
        entry.freshEvent = await this._gamma.fetchEvent({ id: selected.event.id });
      }
    } catch (error) {
      gammaOk = false;
      this._logger.warn('Gamma refresh failed for finalizing market (will retry)', {
        marketId: key,
        attempt: entry.attempts,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (gammaOk) {
      // Merge best-known: однажды полученные официальные значения не теряются
      const extracted = extractCryptoFinalization(entry.freshEvent?.metadata);
      entry.crypto = {
        ...entry.crypto,
        ...(extracted.priceToBeat !== undefined ? { priceToBeat: extracted.priceToBeat } : {}),
        ...(extracted.finalPrice !== undefined ? { finalPrice: extracted.finalPrice } : {}),
      };
    }

    const isCrypto = selected.crypto !== undefined;
    if (!gammaOk && isCrypto && !timedOut) {
      return; // FINALIZING сохраняется; следующий runOnce повторит (PART 29)
    }

    if (this._isReadyToArchive(entry)) {
      await this._archiveEntry(entry, nowMs); // OFFICIAL COMPLETE — немедленно
      return;
    }
    if (!timedOut && isCrypto) {
      // Частично успешные данные обновляют header (PART 30), архив не выполняется
      const headerOk = await this._writeHeader(entry, { status: 'pending' }, nowMs);
      this._logger.info('Finalization enrichment attempt kept market pending', {
        marketId: key,
        attempt: entry.attempts,
        priceToBeat: entry.crypto.priceToBeat !== undefined,
        finalPrice: entry.crypto.finalPrice !== undefined,
        headerUpdated: headerOk,
      });
      return;
    }

    // Бюджет исчерпан: таймаут — ТРИГГЕР, а не результат (PART 6/46)
    await this._archiveEntry(entry, nowMs, 'official-timeout');
  }

  /**
   * Можно ли архивировать рынок ПРЯМО СЕЙЧАС, не дожидаясь таймаута.
   *
   * @param entry - Pending-финализация
   * @returns `true`, если официальных данных уже достаточно
   *
   * @remarks
   * Досрочный архив — только при ПОЛНОМ комплекте официальных данных:
   * победитель И `priceToBeat` И `finalPrice` (решение user). Частичный
   * комплект не закрывает рынок: бюджет всё равно есть, датасет заморожен,
   * слот свободен, и стоимость ожидания — один Gamma-poll раз в
   * `enrichmentRetryMs`. Взамен архив получает максимум ОФИЦИАЛЬНЫХ чисел
   * вместо выведенных.
   *
   * Ожидание ограничено сверху `enrichmentMaxWaitMs`: по его исчерпании
   * рынок закрывается тем, что есть (недостающие числа восполняются из
   * записанного settlement-ряда и помечаются `derived`).
   */
  private _isReadyToArchive(entry: PendingFinalization): boolean {
    if (entry.session.selected.crypto === undefined) {
      return true; // non-crypto: немедленный EXPIRED после best-effort снапшота
    }
    const { outcomes, umaResolutionStatus } = this._gammaContext(entry);
    if (this._deriveOfficialWinning(entry, outcomes, umaResolutionStatus) === undefined) {
      return false;
    }
    return entry.crypto.priceToBeat !== undefined && entry.crypto.finalPrice !== undefined;
  }

  /**
   * Settlement-фид рынка, если его правило расчёта распознано.
   *
   * @param entry - Pending-финализация
   * @returns Фид TWAP с окном либо `undefined` — рынок вне поддержанного
   *   scope deterministic-деривации (PART 30)
   */
  private _settlementFeed(entry: PendingFinalization): PolymarketTwapRtdsFeed | undefined {
    const selected = entry.session.selected;
    if (selected.crypto?.settlement === undefined) {
      return undefined;
    }
    return selected.rtdsFeeds.find(isTwapRtdsFeed);
  }

  /**
   * Финальный путь: header со статусом → EXPIRED архив → снятие сессии.
   *
   * @param entry - Pending-финализация
   * @param status - Итоговый статус (`'complete'` | `'timeout'`)
   * @param nowMs - Момент решения
   *
   * @remarks
   * Порядок (PART 34): header ПЕРЕД gzip. Отказ header-а при `'complete'`
   * без таймаута НЕ маскируется — архив откладывается до следующего
   * runOnce (наблюдаемо, PART 26/58); при `'timeout'`/shutdown архивируем
   * best-known предыдущий header с error-логом. Отказ
   * `finalizeMarket(EXPIRED)` терминален для entry: без success-лога,
   * без повторных gzip-попыток (PART 35/57), сессия остаётся FINALIZING.
   */
  private async _archiveEntry(
    entry: PendingFinalization,
    nowMs: number,
    fallbackTrigger?: CollectionFallbackTrigger,
  ): Promise<FinalizationOutcome> {
    const key = String(entry.session.marketId);
    // Датасет обязан быть заморожен ДО чтения/архива: на истёкшем рынке с
    // settlement-фидом lifecycle ещё несколько секунд дописывает граничное
    // наблюдение (boundary grace). Обычно no-op — enrichment-путь дожидается
    // границы раньше; здесь ожидание нужно shutdown-пути `close()`, который
    // архивирует pending-рынки НЕ через `_attemptEnrichment`.
    await this._lifecycle.awaitSettlementCapture(entry.session.marketId);

    const resolution = await this._resolveArchive(entry, fallbackTrigger);
    if (resolution === undefined) {
      // Исход сообщает САМ discard: удаление могло не состояться, и тогда
      // объявлять датасет удалённым нельзя
      return await this._discardEntry(entry, fallbackTrigger);
    }

    const headerOk = await this._writeHeader(entry, resolution, nowMs);
    if (!headerOk) {
      // Архив, чей header не соответствует принятому решению, хуже
      // отсутствия архива (PART 51): при успешном итоге откладываем до
      // следующего прохода, на терминальном пути (таймаут/shutdown) —
      // отказываемся архивировать вовсе.
      if (fallbackTrigger === undefined && !this._closed) {
        this._logger.error('Final header update failed, archive deferred to next run', {
          marketId: key,
          attempt: entry.attempts,
        });
        return 'deferred';
      }
      entry.archiveFailed = true;
      this._archiveFailures++;
      this._logger.error('Final header update failed on terminal path, no archive created', {
        marketId: key,
        trigger: fallbackTrigger,
      });
      return 'archive-failed';
    }

    try {
      await this._recorder.finalizeMarket(entry.session.marketId, 'EXPIRED');
    } catch (error) {
      entry.archiveFailed = true;
      this._archiveFailures++;
      this._logger.error('EXPIRED archive failed; finalization halted for market', {
        marketId: key,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'archive-failed';
    }

    this._lifecycle.completeFinalization(entry.session.marketId);
    this._pending.delete(key);
    this._archivedTotal++;
    // Классификация идёт по PROVENANCE, а не по статусу: архив без
    // происхождения (не-крипто best-effort, legacy timeout) не является
    // «официальной финализацией» и не должен раздувать её счётчик — именно
    // им измеряется инвариант «архив ⇒ известен итог»
    const provenance = resolution.provenance?.resolution;
    const outcome: FinalizationOutcome =
      provenance === 'fallback-chainlink-twap'
        ? 'fallback'
        : provenance === 'official'
          ? 'official'
          : 'best-effort';
    if (outcome === 'official') {
      this._officialFinalizations++;
    } else if (outcome === 'fallback') {
      this._fallbackFinalizations++;
      if (resolution.provenance?.fallbackTrigger === 'shutdown') {
        this._fallbackByShutdown++;
      } else {
        this._fallbackByTimeout++;
      }
    }
    this._logger.info('Market finalized and archived', {
      marketId: key,
      status: resolution.status,
      outcome,
      attempts: entry.attempts,
      priceToBeat: resolution.crypto?.priceToBeat,
      finalPrice: resolution.crypto?.finalPrice,
      winner: resolution.winning?.label,
      winnerSource: resolution.winning?.source,
      provenance: resolution.provenance?.resolution,
      trigger: resolution.provenance?.fallbackTrigger,
    });
    return outcome;
  }

  /**
   * Принимает решение об итоге рынка: official → fallback → нет решения.
   *
   * @param entry - Pending-финализация
   * @param fallbackTrigger - Что заставило прекратить ожидание официального
   *   результата (`undefined` — терминальный путь ещё не наступил)
   * @returns Готовый finalization-раздел header-а либо `undefined`, если
   *   итог вывести НЕЛЬЗЯ (датасет подлежит удалению)
   *
   * @remarks
   * Порядок приоритета жёсткий (PART 7): официальная резолюция → формула на
   * официальных ценах → deterministic-деривация из записанного
   * settlement-потока. Fallback НИКОГДА не перезаписывает уже полученный
   * официальный результат — он даже не вычисляется, если официальный есть.
   *
   * Для рынков ВНЕ поддержанного TWAP-scope (Binance-источник, не-крипто)
   * сохраняется прежнее поведение: приблизительная ступень `recorded-rtds`
   * и статус `'timeout'` (PART 90).
   */
  private async _resolveArchive(
    entry: PendingFinalization,
    fallbackTrigger: CollectionFallbackTrigger | undefined,
  ): Promise<ArchiveDecision | undefined> {
    const { outcomes, umaResolutionStatus } = this._gammaContext(entry);
    const official = this._deriveOfficialWinning(entry, outcomes, umaResolutionStatus);
    if (official !== undefined) {
      return await this._officialResolution(entry, official);
    }
    if (entry.session.selected.crypto === undefined) {
      // Не-крипто рынок: прежнее поведение (PART 32) — немедленный архив
      // best-effort снапшота. Победитель здесь не обязателен: инвариант
      // «архив ⇒ известен итог» введён MR-B для крипто-рынков, чьё правило
      // расчёта охарактеризовано, а не для произвольных рынков Polymarket.
      return { status: 'complete' };
    }
    if (fallbackTrigger === undefined) {
      return undefined; // ещё не терминальный путь — архивировать нечего
    }

    const settlementFeed = this._settlementFeed(entry);
    if (settlementFeed !== undefined) {
      const derived = await this._deriveTwapWinning(entry, outcomes, settlementFeed);
      return derived === undefined
        ? undefined // deterministic-деривация невозможна → discard (PART 4)
        : this._fallbackResolution(entry, derived.winning, derived.derivation, fallbackTrigger);
    }

    // Правило расчёта — TWAP, но локально не поддержано. Источник расчёта
    // ИЗВЕСТЕН и это НЕ спот, поэтому приблизительные ступени по споту
    // запрещены (PART 8): вывести победителя по чужому потоку хуже, чем не
    // вывести вовсе. Единственный исход — discard.
    const unsupported = entry.session.selected.crypto?.unsupportedSettlementSource;
    if (unsupported !== undefined) {
      this._logger.warn('Settlement rule is TWAP but unsupported locally; dataset discarded', {
        marketId: String(entry.session.marketId),
        resolutionSource: unsupported,
        trigger: fallbackTrigger,
      });
      return undefined;
    }

    // Вне поддержанного scope: прежнее best-known поведение (PART 90)
    const approximate = await this._deriveRecordedWinning(entry, outcomes);
    return this._legacyTimeoutResolution(entry, approximate);
  }

  /**
   * Готовит gamma-контекст header-а: best-known Market → исходы + UMA-статус.
   *
   * @param entry - Pending-финализация
   * @returns Исходы в нейтральной форме и `umaResolutionStatus`
   */
  private _gammaContext(entry: PendingFinalization): {
    readonly outcomes: readonly PolymarketFinalOutcome[];
    readonly umaResolutionStatus: string | undefined;
  } {
    const gammaMarket = entry.freshMarket ?? entry.session.selected.gammaMarket;
    return {
      outcomes: mapFinalOutcomes(gammaMarket),
      umaResolutionStatus: gammaMarket.resolution.umaResolutionStatus ?? undefined,
    };
  }

  /**
   * Официальные ступени winner-ladder (синхронные).
   *
   * @param entry - Pending-финализация
   * @param outcomes - Исходы best-known Market
   * @param umaResolutionStatus - UMA-статус best-known Market
   * @returns `winning` со source `'resolution'` либо `'official-prices'`;
   *   `undefined` — официальных данных для победителя нет
   *
   * @remarks
   * 1. `'resolution'` — resolved settlement-цены (1/0), «как раньше»;
   * 2. `'official-prices'` — формула рынка на официальных
   *    `priceToBeat`/`finalPrice` (Up/Down-серии; `>= → Up`).
   * Оба источника точные (`exact: true`).
   */
  private _deriveOfficialWinning(
    entry: PendingFinalization,
    outcomes: readonly PolymarketFinalOutcome[],
    umaResolutionStatus: string | undefined,
  ): ArchiveWinning | undefined {
    const resolved = deriveWinningOutcome(outcomes, umaResolutionStatus);
    if (resolved !== undefined) {
      return this._toWinning(outcomes, resolved, 'resolution', true);
    }
    const priced = deriveWinnerFromCryptoPrices(outcomes, entry.crypto);
    if (priced !== undefined) {
      return this._toWinning(outcomes, priced, 'official-prices', true);
    }
    return undefined;
  }

  /**
   * Собирает machine-usable identity победителя из canonical `outcomes[]`.
   *
   * @param outcomes - Исходы рынка в canonical порядке header-а
   * @param winner - Выигравший исход
   * @param source - Ступень winner-ladder, давшая результат
   * @param exact - Точный результат или приблизительный
   * @returns `winning` с `outcomeIndex`/`instrumentId`/`label` либо
   *   `undefined`, если исход не сопоставляется однозначно
   *
   * @remarks
   * `outcomeIndex` ищется СОПОСТАВЛЕНИЕМ по `instrumentId` (PART 36/39):
   * порядок исходов не предполагается ни при каких обстоятельствах —
   * «Up всегда первый» неверно уже сегодня для части серий, а константа
   * `tokenIds[0]` молча присудила бы победу не тому инструменту.
   * Несопоставимый победитель — это отсутствие результата, а не индекс 0.
   */
  private _toWinning(
    outcomes: readonly PolymarketFinalOutcome[],
    winner: PolymarketFinalOutcome,
    source: NonNullable<CollectionHeaderFinalization['winning']>['source'],
    exact: boolean,
  ): ArchiveWinning | undefined {
    const outcomeIndex = outcomes.findIndex(
      (candidate) => candidate.instrumentId === winner.instrumentId,
    );
    if (outcomeIndex < 0) {
      return undefined;
    }
    return {
      label: winner.label,
      instrumentId: winner.instrumentId,
      outcomeIndex,
      source,
      exact,
    };
  }

  /**
   * Итог OFFICIAL COMPLETE: официальный победитель + доступные числа.
   *
   * @param entry - Pending-финализация
   * @param winning - Официальный победитель
   * @returns Решение для header-а
   *
   * @remarks
   * Если Gamma ещё не опубликовал `priceToBeat`/`finalPrice`, они
   * восполняются из записанного settlement-ряда и помечаются
   * `provenance = 'derived'` (PART 41). Победитель при этом остаётся
   * официальным — derived-числа его НЕ пересматривают.
   */
  private async _officialResolution(
    entry: PendingFinalization,
    winning: ArchiveWinning,
  ): Promise<ArchiveDecision> {
    if (entry.session.selected.crypto === undefined) {
      return { status: 'complete', winning, provenance: { resolution: 'official' } };
    }
    const officialPriceToBeat = entry.crypto.priceToBeat;
    const officialFinalPrice = entry.crypto.finalPrice;
    // Читаем ряд ТОЛЬКО когда чего-то не хватает: на полном комплекте
    // (обычный путь досрочного архива) лишнего чтения датасета не будет
    const derivation =
      officialPriceToBeat === undefined || officialFinalPrice === undefined
        ? await this._readTwapDerivation(entry)
        : undefined;
    const priceToBeat = officialPriceToBeat ?? derivation?.priceToBeat.value;
    const finalPrice = officialFinalPrice ?? derivation?.finalPrice.value;

    return {
      status: 'complete',
      winning,
      provenance: {
        resolution: 'official',
        ...(priceToBeat !== undefined
          ? { priceToBeat: officialPriceToBeat !== undefined ? ('official' as const) : ('derived' as const) }
          : {}),
        ...(finalPrice !== undefined
          ? { finalPrice: officialFinalPrice !== undefined ? ('official' as const) : ('derived' as const) }
          : {}),
      },
      crypto: {
        ...(priceToBeat !== undefined ? { priceToBeat } : {}),
        ...(finalPrice !== undefined ? { finalPrice } : {}),
      },
    };
  }

  /**
   * Читает граничные наблюдения settlement-ряда рынка (без решения об итоге).
   *
   * @param entry - Pending-финализация
   * @returns Деривация с обоими граничными наблюдениями либо `undefined`
   *
   * @remarks
   * Общий read-путь двух сценариев: восполнение недостающих ОФИЦИАЛЬНЫХ
   * чисел в официальном архиве и полноценная fallback-деривация. Оба
   * читают ОДИН И ТОТ ЖЕ замороженный датасет — второго источника
   * наблюдений не существует.
   */
  private async _readTwapDerivation(
    entry: PendingFinalization,
  ): Promise<RecordedTwapDerivation | undefined> {
    const feed = this._settlementFeed(entry);
    const startMs = entry.session.selected.eventStartsAt?.toNumber();
    if (feed === undefined || startMs === undefined) {
      return undefined;
    }
    const symbolNeedle = `"symbol":"${feed.symbol}"`;
    const lines = await this._recorder.readSealedPayloadLines(
      entry.session.marketId,
      (line) => line.includes(`"${feed.topic}"`) && line.includes(symbolNeedle),
    );
    if (lines === undefined || lines.length === 0) {
      return undefined;
    }
    return deriveWinnerFromRecordedTwap(
      lines,
      feed,
      startMs,
      entry.session.selected.expiresAt.toNumber(),
      entry.crypto.priceToBeat,
    );
  }

  /**
   * Итог FALLBACK COMPLETE: победитель выведен из записанного TWAP-ряда.
   *
   * @param entry - Pending-финализация
   * @param winning - Выведенный победитель
   * @param derivation - Основания деривации (границы, значения, timestamps)
   * @param trigger - Что заставило перейти к fallback
   * @returns Решение для header-а
   */
  private _fallbackResolution(
    entry: PendingFinalization,
    winning: ArchiveWinning,
    derivation: RecordedTwapDerivation,
    trigger: CollectionFallbackTrigger,
  ): ArchiveDecision {
    const settlement = entry.session.selected.crypto!.settlement!;
    return {
      status: 'complete',
      winning,
      provenance: {
        resolution: 'fallback-chainlink-twap',
        fallbackTrigger: trigger,
        // Происхождение берётся из ФАКТА использования, а не из наличия
        // официального значения: непригодное Gamma-значение резолвер молча
        // отбрасывает, и назвать результат официальным было бы ложью
        priceToBeat: derivation.priceToBeatSource === 'official' ? 'official' : 'derived',
        // finalPrice выведен всегда: официального у нас на этом пути нет
        // (иначе сработала бы ступень official-prices)
        finalPrice: 'derived',
        evidence: {
          symbol: settlement.symbol,
          windowSeconds: settlement.windowSeconds,
          priceToBeatValue: derivation.priceToBeat.value,
          priceToBeatTimestampMs: derivation.priceToBeat.timestampMs,
          finalPriceValue: derivation.finalPrice.value,
          finalPriceTimestampMs: derivation.finalPrice.timestampMs,
          marketStartMs: entry.session.selected.eventStartsAt!.toNumber(),
          marketEndMs: entry.session.selected.expiresAt.toNumber(),
          observations: derivation.observations,
        },
      },
      crypto: {
        priceToBeat: derivation.priceToBeat.value,
        finalPrice: derivation.finalPrice.value,
      },
    };
  }

  /**
   * Итог вне поддержанного TWAP-scope: прежний best-known `'timeout'`.
   *
   * @param entry - Pending-финализация
   * @param approximate - Приблизительный победитель `recorded-rtds`, если есть
   * @returns Решение для header-а
   *
   * @remarks
   * Сохраняет verified-поведение рынков Binance-источника и не-крипто
   * (PART 89/90): их правило расчёта не охарактеризовано, поэтому ни
   * deterministic-деривации, ни удаления датасета для них не вводится.
   */
  private _legacyTimeoutResolution(
    entry: PendingFinalization,
    approximate: ArchiveWinning | undefined,
  ): ArchiveDecision {
    return {
      status: 'timeout',
      ...(approximate !== undefined ? { winning: approximate } : {}),
      ...(entry.session.selected.crypto !== undefined ? { crypto: entry.crypto } : {}),
    };
  }

  /**
   * Deterministic-деривация победителя из записанного settlement-ряда.
   *
   * @param entry - Pending-финализация
   * @param outcomes - Исходы best-known Market
   * @param feed - Settlement-фид рынка (символ + окно из дескриптора)
   * @returns Победитель с основаниями либо `undefined`, если деривация
   *   невозможна (нет времени старта, датасет не читается, границы не
   *   покрыты рядом, исход не сопоставляется)
   *
   * @remarks
   * Читается ТОТ ЖЕ датасет, который уйдёт в архив — расчёт и артефакт
   * опираются на одно наблюдение (PART 26). Строковый префильтр дешёвый,
   * точная сверка `topic`/`symbol`/`windowSeconds` идёт по распарсенной
   * строке внутри резолвера.
   */
  private async _deriveTwapWinning(
    entry: PendingFinalization,
    outcomes: readonly PolymarketFinalOutcome[],
    feed: PolymarketTwapRtdsFeed,
  ): Promise<{ winning: ArchiveWinning; derivation: RecordedTwapDerivation } | undefined> {
    const key = String(entry.session.marketId);
    const derivation = await this._readTwapDerivation(entry);
    if (derivation === undefined) {
      this._logger.warn('TWAP fallback unavailable: market boundaries not covered by series', {
        marketId: key,
        feed: `${feed.symbol}@${String(feed.windowSeconds)}s`,
      });
      return undefined;
    }
    const outcome = outcomes.find((candidate) => candidate.label === derivation.label);
    if (outcome === undefined) {
      this._logger.warn('TWAP fallback unavailable: derived label matches no market outcome', {
        marketId: key,
        label: derivation.label,
        outcomes: outcomes.map((candidate) => candidate.label),
      });
      return undefined;
    }
    const winning = this._toWinning(outcomes, outcome, 'recorded-twap', true);
    if (winning === undefined) {
      return undefined;
    }
    this._logger.info('Winner derived from recorded Chainlink TWAP settlement series', {
      marketId: key,
      label: derivation.label,
      priceToBeat: derivation.priceToBeat.value,
      finalPrice: derivation.finalPrice.value,
      observations: derivation.observations,
    });
    return { winning, derivation };
  }

  /**
   * Удаляет неразрешимый датасет: архив НЕ создаётся (PART 4/46/48).
   *
   * @param entry - Pending-финализация без выводимого итога
   * @param trigger - Терминальный путь, на котором принято решение
   *
   * @remarks
   * `finalizeMarket('SHUTDOWN')` — существующая семантика «незавершённый
   * датасет»: буфер отбрасывается, stream разрушается, `.jsonl` удаляется,
   * `.gz` не создаётся. Вызывать `finalizeMarket('EXPIRED')` здесь было бы
   * прямым нарушением инварианта архива — он объявил бы датасет пригодным к
   * replay, не зная его итога. Сессия снимается в любом случае: вечного
   * FINALIZING остаться не должно.
   */
  private async _discardEntry(
    entry: PendingFinalization,
    trigger: CollectionFallbackTrigger | undefined,
  ): Promise<FinalizationOutcome> {
    if (trigger === undefined) {
      return 'deferred'; // не терминальный путь: рынок остаётся pending до таймаута
    }
    const key = String(entry.session.marketId);
    try {
      await this._recorder.finalizeMarket(entry.session.marketId, 'SHUTDOWN');
    } catch (error) {
      // Удаление НЕ состоялось — файл, скорее всего, остался на диске.
      // Объявлять его удалённым (снимать сессию, растить счётчик, писать
      // «discarded») значило бы приписать системе действие, которого не
      // было. Тот же терминальный контур, что у отказа архива: повторов
      // нет, остаток наблюдаем через pendingFinalizations.
      entry.archiveFailed = true;
      this._logger.error('Failed to discard unresolvable dataset; file may remain on disk', {
        marketId: key,
        trigger,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'discard-failed';
    }
    this._lifecycle.completeFinalization(entry.session.marketId);
    this._pending.delete(key);
    this._discardedUnresolvable++;
    this._logger.warn('Market outcome unresolvable, incomplete dataset discarded', {
      marketId: key,
      question: entry.session.selected.question,
      trigger,
      attempts: entry.attempts,
    });
    return 'discarded';
  }

  /**
   * Ступень `'recorded-rtds'`: приблизительный победитель из записанного ряда.
   *
   * @param entry - Pending-финализация (timeout-архив без официальных данных)
   * @param outcomes - Исходы best-known Market (для instrumentId победителя)
   * @returns `winning` с `exact: false` и основаниями либо `undefined`
   *
   * @remarks
   * Best-effort: любые недостающие входы (не crypto-рынок, нет chainlink-фида,
   * нет тайминга окна, датасет не читается, ряд пуст, метки не Up/Down)
   * приводят к отсутствию победителя, а не к ошибке архива.
   */
  private async _deriveRecordedWinning(
    entry: PendingFinalization,
    outcomes: readonly PolymarketFinalOutcome[],
  ): Promise<ArchiveWinning | undefined> {
    const selected = entry.session.selected;
    if (selected.crypto === undefined) {
      return undefined;
    }
    const chainlinkFeed = selected.rtdsFeeds.find(
      (feed) => feed.topic === 'prices.crypto.chainlink',
    );
    const startMs = selected.eventStartsAt?.toNumber();
    if (chainlinkFeed === undefined || startMs === undefined) {
      return undefined;
    }
    const expiryMs = selected.expiresAt.toNumber();
    const symbolNeedle = `"symbol":"${chainlinkFeed.symbol}"`;
    const lines = await this._recorder.readSealedPayloadLines(
      entry.session.marketId,
      (line) => line.includes('"prices.crypto.chainlink"') && line.includes(symbolNeedle),
    );
    if (lines === undefined || lines.length === 0) {
      return undefined;
    }
    const derived = deriveWinnerFromRecordedChainlink(lines, startMs, expiryMs);
    if (derived === undefined) {
      return undefined;
    }
    const outcome = outcomes.find((candidate) => candidate.label === derived.label);
    if (outcome === undefined) {
      return undefined;
    }
    this._logger.info('Winner derived from recorded RTDS series (approximate)', {
      marketId: String(entry.session.marketId),
      label: derived.label,
      startValue: derived.startValue,
      endValue: derived.endValue,
      observations: derived.observations,
    });
    const winning = this._toWinning(outcomes, outcome, 'recorded-rtds', false);
    if (winning === undefined) {
      return undefined;
    }
    return {
      ...winning,
      basis: { startValue: derived.startValue, endValue: derived.endValue },
    };
  }

  /**
   * ОБОГАЩАЕТ canonical V2 header датасета итогом и пишет его в LINE 1.
   *
   * @param entry - Pending-финализация
   * @param decision - Принятое решение об итоге (статус/победитель/
   *   происхождение/числа); для промежуточных обновлений — `{status: 'pending'}`
   * @param nowMs - Момент записи
   * @returns `true`, если header фактически записан storage-ом
   *
   * @remarks
   * Базой служит ТОТ ЖЕ header, который записал допуск рынка
   * (`headerVersion: 2`, canonical identity/timing/outcomes/крипто-номинал).
   * Финализатор добавляет к нему `finalization` и момент начала записи —
   * и НЕ подменяет его legacy vendor-формой: два несовместимых shape под
   * разными версиями в одном датасете сделали бы дискриминатор бесполезным.
   *
   * Общие поля раздела заполняются здесь единообразно, различающие —
   * приходят решением. Промежуточный `pending`-header дополнительно
   * показывает уже известного ОФИЦИАЛЬНОГО победителя (если он появился до
   * архива), но никогда — derived-результат: тот принадлежит терминальному
   * пути и обязан идти вместе со своим provenance.
   */
  private async _writeHeader(
    entry: PendingFinalization,
    decision: ArchiveDecision,
    nowMs: number,
  ): Promise<boolean> {
    const key = String(entry.session.marketId);
    const selected = entry.session.selected;
    const gammaMarket = entry.freshMarket ?? selected.gammaMarket;
    const { outcomes, umaResolutionStatus } = this._gammaContext(entry);
    const isPending = decision.status === 'pending';
    const winning =
      decision.winning ??
      (isPending ? this._deriveOfficialWinning(entry, outcomes, umaResolutionStatus) : undefined);
    const crypto =
      decision.crypto ?? (selected.crypto !== undefined ? entry.crypto : undefined);
    const settlement = describeSettlement(selected);

    const finalization: CollectionHeaderFinalization = {
      status: decision.status,
      startedAtMs: entry.startedAtMs,
      ...(isPending ? {} : { finalizedAtMs: nowMs }),
      attempts: entry.attempts,
      ...(settlement !== undefined ? { settlement } : {}),
      resolution: {
        ...(gammaMarket.state.closed !== null && gammaMarket.state.closed !== undefined
          ? { closed: gammaMarket.state.closed }
          : {}),
        ...(gammaMarket.state.closedTime !== null && gammaMarket.state.closedTime !== undefined
          ? { closedTime: String(gammaMarket.state.closedTime) }
          : {}),
        ...(umaResolutionStatus !== undefined ? { umaResolutionStatus } : {}),
      },
      outcomes,
      ...(winning !== undefined ? { winning } : {}),
      ...(decision.provenance !== undefined ? { provenance: decision.provenance } : {}),
      ...(crypto !== undefined
        ? {
            crypto: {
              ...(crypto.priceToBeat !== undefined ? { priceToBeat: crypto.priceToBeat } : {}),
              ...(crypto.finalPrice !== undefined ? { finalPrice: crypto.finalPrice } : {}),
            },
          }
        : {}),
    };

    const baseHeader = entry.session.marketMeta.rawMarket;
    if (baseHeader === undefined) {
      // Датасет без canonical header-а обогащать нечем: допуск рынка обязан
      // был его записать, и его отсутствие — дефект, а не деградация формата.
      this._logger.error('Recording session has no canonical header to enrich', {
        marketId: key,
      });
      return false;
    }
    const header = buildFinalizedMarketHeader({
      baseHeader,
      marketMeta: entry.session.marketMeta,
      recordingStartsAtMs: entry.session.recordingStartedAt.toNumber(),
      finalization,
    });
    if (header === undefined) {
      this._logger.error('Final header does not fit storage meta budget', { marketId: key });
      return false;
    }
    try {
      return await this._recorder.updateMarketMeta(entry.session.marketId, header);
    } catch (error) {
      this._logger.error('Header update failed with I/O error', {
        marketId: key,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}
