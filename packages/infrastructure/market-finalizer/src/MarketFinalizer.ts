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
 *   ├── detects due ACTIVE sessions      (coordinator.listSessions)
 *   ├── beginFinalization                (coordinator: seal + teardown realtime)
 *   ├── fetchMarket / fetchEvent         (официальный SDK, query plane)
 *   ├── updateMarketMeta                 (recorder: полный V2 header LINE 1)
 *   ├── finalizeMarket(EXPIRED)          (recorder: flush → gzip)
 *   └── completeFinalization             (coordinator: снять FINALIZING)
 * ```
 *
 * Finalizer НЕ владеет candidate cache, session lifecycle, storage и общим
 * bus; Gamma polling — control/query plane: никаких synthetic
 * ExternalMessages (PART 33), таймеров внутри core-класса нет (PART 13).
 *
 * ### Resolution policy (MR-B)
 *
 * ```text
 * рынок истёк → FINALIZING → Gamma polling
 *      │
 *      ├── официальный итог достаточен ──────► OFFICIAL COMPLETE  → .jsonl.gz
 *      │
 *      ├── бюджет 60 мин исчерпан ЛИБО shutdown
 *      │        └── deterministic TWAP fallback возможен ─► FALLBACK COMPLETE → .jsonl.gz
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
 * - crypto-рынок: COMPLETE, как только официальные данные ДАЮТ ПОБЕДИТЕЛЯ —
 *   через resolved settlement-цены UMA либо через формулу рынка на
 *   официальных `priceToBeat`/`finalPrice`. Ждать «оба числа» нельзя:
 *   live-замер 2026-08-26 показал рынок, где `uma=resolved` и цены `1/0`
 *   пришли на 4.5-й минуте, а `finalPrice` не публиковался ещё долго —
 *   прежнее условие держало бы такой рынок все 60 минут и архивировало его
 *   как `timeout` при уже известном официальном итоге;
 * - non-crypto: best-effort свежий Gamma-снапшот и НЕМЕДЛЕННЫЙ EXPIRED
 *   (без многочасовых resolution-watcher-ов);
 * - недостающие `priceToBeat`/`finalPrice` при этом НЕ теряются: они
 *   восполняются из записанного settlement-ряда и помечаются
 *   `provenance.priceToBeat`/`finalPrice = 'derived'`.
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
  deriveWinnerFromCryptoPrices,
  deriveWinningOutcome,
  extractCryptoFinalization,
  isTwapRtdsFeed,
  mapFinalOutcomes,
} from '@polymarket/polymarket-v2';
import type { PolymarketFinalOutcome, PolymarketTwapRtdsFeed } from '@polymarket/polymarket-v2';
import type {
  CollectionFallbackTrigger,
  CollectionHeaderFinalization,
  FinalizingMarketSession,
  MarketCollectionCoordinator,
} from '@polymarket/collection-coordinator';
import { buildCollectionHeader } from '@polymarket/collection-coordinator';
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
 * Порт координатора, используемый finalizer-ом (PART 37).
 *
 * @remarks
 * Только session-lifecycle операции; private maps координатора недоступны —
 * due-сессии определяются по read-only снимкам `listSessions()`.
 */
export type FinalizationCoordinator = Pick<
  MarketCollectionCoordinator,
  'listSessions' | 'beginFinalization' | 'awaitSettlementCapture' | 'completeFinalization'
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
 * - `'discarded'` — итог вывести нельзя, датасет удалён (архива нет);
 * - `'legacy-timeout'` — рынок вне поддержанного TWAP-scope заархивирован
 *   best-known данными (прежнее поведение сохранено).
 */
export type FinalizationOutcome = 'official' | 'fallback' | 'discarded' | 'legacy-timeout';

/**
 * Зависимости {@link MarketFinalizer}.
 */
export interface MarketFinalizerDependencies {
  /** Координатор collection sessions (expiry-переходы/завершение). */
  readonly coordinator: FinalizationCoordinator;
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
   * Максимальное ожидание полного enrichment-а; по истечении — архив
   * best-known данных со статусом `'timeout'`.
   *
   * @defaultValue 3_600_000 (60 минут)
   *
   * @remarks
   * Это СТРАХОВОЧНЫЙ потолок, а не типичное время: рынок архивируется
   * сразу при выполнении completion-условия (soak 2026-08-24: медиана
   * 7.9 мин, максимум 18.1 мин у 15m-серий; 13/13 complete). Legacy ждал
   * 15 минут и терял хвост (3/13 рынков замера были медленнее 15 мин).
   * Ожидание дёшево: FINALIZING не занимает слот, датасет заморожен —
   * стоимость равна одному Gamma-poll-у раз в `enrichmentRetryMs`.
   *
   * Ветка timeout — зарезервированная точка расширения TWAP-fallback
   * (будущий канал: по исчерпании бюджета официальной резолюции итог
   * деривируется из записанного TWAP → `DERIVED COMPLETE`); до его
   * появления статус остаётся `'timeout'`.
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
 * Post-expiry finalizer V2-записей: due ACTIVE → FINALIZING → Gamma
 * enrichment → финальный header → EXPIRED gzip → снятие сессии.
 *
 * @example
 * ```typescript
 * const finalizer = new MarketFinalizer(
 *   { coordinator, recorder, gamma: createPublicClient(), clock, logger },
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
  private readonly _coordinator: FinalizationCoordinator;
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
    this._coordinator = deps.coordinator;
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
   *    `coordinator.close()` политикой SHUTDOWN;
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
   * await coordinator.close();
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
   * 3. ACTIVE/OPENING рынки НЕ трогаются — их закроет
   *    `coordinator.close()` как SHUTDOWN (incomplete-файлы удалятся).
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
        await this._archiveEntry(entry, nowMs, 'shutdown');
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

    // ── 1. Expiry-переходы due ACTIVE-сессий ────────────────────────────────
    for (const snapshot of this._coordinator.listSessions()) {
      if (snapshot.state !== 'ACTIVE' || snapshot.expiresAt === undefined) {
        continue;
      }
      if (snapshot.expiresAt.toNumber() > nowMs) {
        continue;
      }
      const key = String(snapshot.marketId);
      if (this._pending.has(key)) {
        continue;
      }
      // Per-session изоляция: отказ перехода одного рынка (например, throw
      // seal-пути) не роняет runOnce и не лишает остальные сессии enrichment-а
      let session: FinalizingMarketSession | undefined;
      try {
        session = await this._coordinator.beginFinalization(snapshot.marketId);
      } catch (error) {
        this._logger.error('beginFinalization failed for expired market, continuing pass', {
          marketId: key,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (session === undefined) {
        continue; // сессию успели закрыть/перевести — переход at most once
      }
      this._pending.set(key, {
        session,
        startedAtMs: nowMs,
        attempts: 0,
        lastAttemptMs: null,
        crypto: {},
        archiveFailed: false,
      });
      this._logger.info('Market expired, finalization started', {
        marketId: key,
        question: session.selected.question,
        isCrypto: session.selected.crypto !== undefined,
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
   */
  private async _attemptEnrichment(
    entry: PendingFinalization,
    nowMs: number,
    timedOut: boolean,
  ): Promise<void> {
    const key = String(entry.session.marketId);
    const selected = entry.session.selected;
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
   * Условие — именно «победитель известен», а НЕ «оба крипто-числа
   * получены» (PART 44): Gamma публикует `finalPrice` не всегда и не
   * раньше резолюции, и ожидание его появления держало бы рынок весь
   * бюджет при уже известном официальном итоге (наблюдение live
   * 2026-08-26). Недостающие числа восполняются derived-значениями с
   * явной пометкой происхождения.
   */
  private _isReadyToArchive(entry: PendingFinalization): boolean {
    if (entry.session.selected.crypto === undefined) {
      return true; // non-crypto: немедленный EXPIRED после best-effort снапшота
    }
    const { outcomes, umaResolutionStatus } = this._gammaContext(entry);
    return this._deriveOfficialWinning(entry, outcomes, umaResolutionStatus) !== undefined;
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
    // settlement-фидом координатор ещё несколько секунд дописывает граничное
    // наблюдение (boundary grace). No-op, если grace уже завершён.
    await this._coordinator.awaitSettlementCapture(entry.session.marketId);

    const resolution = await this._resolveArchive(entry, fallbackTrigger);
    if (resolution === undefined) {
      await this._discardEntry(entry, fallbackTrigger);
      return 'discarded';
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
        return 'discarded';
      }
      entry.archiveFailed = true;
      this._archiveFailures++;
      this._logger.error('Final header update failed on terminal path, no archive created', {
        marketId: key,
        trigger: fallbackTrigger,
      });
      return 'discarded';
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
      return 'discarded';
    }

    this._coordinator.completeFinalization(entry.session.marketId);
    this._pending.delete(key);
    this._archivedTotal++;
    const outcome: FinalizationOutcome =
      resolution.status === 'timeout'
        ? 'legacy-timeout'
        : resolution.provenance?.resolution === 'fallback-chainlink-twap'
          ? 'fallback'
          : 'official';
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
      return this._officialResolution(entry, official);
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
  private _officialResolution(
    entry: PendingFinalization,
    winning: ArchiveWinning,
  ): ArchiveDecision {
    return {
      status: 'complete',
      winning,
      provenance: {
        resolution: 'official',
        ...(entry.crypto.priceToBeat !== undefined ? { priceToBeat: 'official' as const } : {}),
        ...(entry.crypto.finalPrice !== undefined ? { finalPrice: 'official' as const } : {}),
      },
      ...(entry.session.selected.crypto !== undefined ? { crypto: entry.crypto } : {}),
    };
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
    const officialPriceToBeat = entry.crypto.priceToBeat !== undefined;
    return {
      status: 'complete',
      winning,
      provenance: {
        resolution: 'fallback-chainlink-twap',
        fallbackTrigger: trigger,
        priceToBeat: officialPriceToBeat ? 'official' : 'derived',
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
    const selected = entry.session.selected;
    const startMs = selected.eventStartsAt?.toNumber();
    if (startMs === undefined) {
      this._logger.warn('TWAP fallback unavailable: market has no official start time', {
        marketId: key,
      });
      return undefined;
    }
    const symbolNeedle = `"symbol":"${feed.symbol}"`;
    const lines = await this._recorder.readSealedPayloadLines(
      entry.session.marketId,
      (line) => line.includes(`"${feed.topic}"`) && line.includes(symbolNeedle),
    );
    if (lines === undefined || lines.length === 0) {
      this._logger.warn('TWAP fallback unavailable: no recorded settlement observations', {
        marketId: key,
        feed: `${feed.symbol}@${String(feed.windowSeconds)}s`,
      });
      return undefined;
    }
    const derivation = deriveWinnerFromRecordedTwap(
      lines,
      feed,
      startMs,
      selected.expiresAt.toNumber(),
      entry.crypto.priceToBeat,
    );
    if (derivation === undefined) {
      this._logger.warn('TWAP fallback unavailable: market boundaries not covered by series', {
        marketId: key,
        feed: `${feed.symbol}@${String(feed.windowSeconds)}s`,
        candidateLines: lines.length,
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
  ): Promise<void> {
    if (trigger === undefined) {
      return; // не терминальный путь: рынок остаётся pending до таймаута
    }
    const key = String(entry.session.marketId);
    try {
      await this._recorder.finalizeMarket(entry.session.marketId, 'SHUTDOWN');
    } catch (error) {
      this._logger.error('Failed to discard unresolvable dataset', {
        marketId: key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this._coordinator.completeFinalization(entry.session.marketId);
    this._pending.delete(key);
    this._discardedUnresolvable++;
    this._logger.warn('Market outcome unresolvable, incomplete dataset discarded', {
      marketId: key,
      question: entry.session.selected.question,
      trigger,
      attempts: entry.attempts,
    });
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
   * Пересобирает ПОЛНЫЙ V2 header (PART 22/23) и пишет его в LINE 1.
   *
   * @param entry - Pending-финализация
   * @param decision - Принятое решение об итоге (статус/победитель/
   *   происхождение/числа); для промежуточных обновлений — `{status: 'pending'}`
   * @param nowMs - Момент записи
   * @returns `true`, если header фактически записан storage-ом
   *
   * @remarks
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

    const finalization: CollectionHeaderFinalization = {
      status: decision.status,
      startedAtMs: entry.startedAtMs,
      ...(isPending ? {} : { finalizedAtMs: nowMs }),
      attempts: entry.attempts,
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

    const header = buildCollectionHeader({
      selected,
      recordingStartsAt: entry.session.recordingStartedAt,
      ...(entry.freshMarket !== undefined ? { gammaMarket: entry.freshMarket } : {}),
      ...(entry.freshEvent !== undefined ? { gammaEvent: entry.freshEvent } : {}),
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
