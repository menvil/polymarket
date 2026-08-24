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
 * ### Completion condition (PART 27/32)
 *
 * - crypto-рынок: COMPLETE когда официальные `priceToBeat` И `finalPrice`
 *   присутствуют в `Event.metadata`;
 * - non-crypto: best-effort свежий Gamma-снапшот и НЕМЕДЛЕННЫЙ EXPIRED
 *   (без многочасовых resolution-watcher-ов);
 * - таймаут `enrichmentMaxWaitMs` (15 мин parity) архивирует best-known
 *   данные с явным `finalization.status = 'timeout'`.
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
  deriveWinningOutcome,
  extractCryptoFinalization,
  mapFinalOutcomes,
} from '@polymarket/polymarket-v2';
import type {
  CollectionHeaderFinalization,
  FinalizingMarketSession,
  MarketCollectionCoordinator,
} from '@polymarket/collection-coordinator';
import { buildCollectionHeader } from '@polymarket/collection-coordinator';
import type { ExternalMessageRecorder } from '@polymarket/external-message-recorder';

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
  'listSessions' | 'beginFinalization' | 'completeFinalization'
>;

/**
 * Порт recorder-а, используемый finalizer-ом.
 */
export type FinalizationRecorder = Pick<
  ExternalMessageRecorder,
  'updateMarketMeta' | 'finalizeMarket'
>;

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
   * @defaultValue 900_000 (15 минут, parity с legacy ENRICHMENT_MAX_WAIT_MS)
   */
  readonly enrichmentMaxWaitMs?: number;
}

/** Дефолты конфигурации (см. {@link MarketFinalizerConfig}). */
const DEFAULT_ENRICHMENT_RETRY_MS = 30_000;
const DEFAULT_ENRICHMENT_MAX_WAIT_MS = 15 * 60_000;

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
 * // shutdown (ДО coordinator.close()):
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

  /** Pending-финализации по `String(marketId)`. */
  private readonly _pending = new Map<string, PendingFinalization>();
  /** In-flight runOnce: конкурентные вызовы разделяют один проход (PART 38). */
  private _runInFlight: Promise<void> | null = null;
  private _closed = false;
  private _closePromise: Promise<void> | null = null;
  private _archivedTotal = 0;
  private _archiveFailures = 0;

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
   * Deterministic shutdown (PART 40).
   *
   * @returns Promise завершения shutdown
   *
   * @remarks
   * 1. новые runOnce запрещаются; in-flight проход дожидается;
   * 2. все УЖЕ FINALIZING рынки (реально expired, датасет sealed)
   *    архивируются как EXPIRED с best-known metadata БЕЗ новых
   *    Gamma-запросов (сеть не задерживает shutdown): статус —
   *    `'complete'`, если completion condition уже выполнен, иначе
   *    `'timeout'`;
   * 3. ACTIVE/OPENING рынки НЕ трогаются — их закроет
   *    `coordinator.close()` как SHUTDOWN (incomplete-файлы удалятся).
   *
   * Общий bus finalizer-ом не закрывается. Идемпотентен.
   */
  public async close(): Promise<void> {
    if (this._closePromise !== null) {
      return this._closePromise;
    }
    this._closed = true;
    this._closePromise = (async () => {
      if (this._runInFlight !== null) {
        await this._runInFlight.catch(() => undefined);
      }
      const nowMs = this._clock.now().getTime();
      for (const entry of [...this._pending.values()]) {
        if (entry.archiveFailed) {
          continue;
        }
        const status = this._isComplete(entry) ? 'complete' : 'timeout';
        await this._archiveEntry(entry, status, nowMs);
      }
      if (this._pending.size > 0) {
        this._logger.warn('Finalizer closed with unarchived markets (archive failures)', {
          markets: [...this._pending.keys()],
        });
      }
      this._logger.info('MarketFinalizer closed');
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
      const session = await this._coordinator.beginFinalization(snapshot.marketId);
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
      await this._attemptEnrichment(entry, nowMs, timedOut);
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

    const complete = this._isComplete(entry);
    if (!complete && !timedOut && isCrypto) {
      // Частично успешные данные обновляют header (PART 30), архив не выполняется
      const headerOk = await this._writeHeader(entry, 'pending', nowMs);
      this._logger.info('Finalization enrichment attempt kept market pending', {
        marketId: key,
        attempt: entry.attempts,
        priceToBeat: entry.crypto.priceToBeat !== undefined,
        finalPrice: entry.crypto.finalPrice !== undefined,
        headerUpdated: headerOk,
      });
      return;
    }

    await this._archiveEntry(entry, complete ? 'complete' : 'timeout', nowMs);
  }

  /**
   * Условие завершения enrichment-а (PART 27/32).
   */
  private _isComplete(entry: PendingFinalization): boolean {
    if (entry.session.selected.crypto === undefined) {
      return true; // non-crypto: немедленный EXPIRED после best-effort снапшота
    }
    return entry.crypto.priceToBeat !== undefined && entry.crypto.finalPrice !== undefined;
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
    status: 'complete' | 'timeout',
    nowMs: number,
  ): Promise<void> {
    const key = String(entry.session.marketId);
    const headerOk = await this._writeHeader(entry, status, nowMs);
    if (!headerOk && status === 'complete' && !this._closed) {
      this._logger.error('Final header update failed, archive deferred to next run', {
        marketId: key,
        attempt: entry.attempts,
      });
      return;
    }
    if (!headerOk) {
      this._logger.error('Final header update failed, archiving with best-known previous header', {
        marketId: key,
        status,
      });
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
      return;
    }

    this._coordinator.completeFinalization(entry.session.marketId);
    this._pending.delete(key);
    this._archivedTotal++;
    this._logger.info('Market finalized and archived', {
      marketId: key,
      status,
      attempts: entry.attempts,
      priceToBeat: entry.crypto.priceToBeat,
      finalPrice: entry.crypto.finalPrice,
    });
  }

  /**
   * Пересобирает ПОЛНЫЙ V2 header (PART 22/23) и пишет его в LINE 1.
   *
   * @param entry - Pending-финализация
   * @param status - Статус finalization-раздела
   * @param nowMs - Момент записи
   * @returns `true`, если header фактически записан storage-ом
   */
  private async _writeHeader(
    entry: PendingFinalization,
    status: CollectionHeaderFinalization['status'],
    nowMs: number,
  ): Promise<boolean> {
    const key = String(entry.session.marketId);
    const selected = entry.session.selected;
    const gammaMarket = entry.freshMarket ?? selected.gammaMarket;
    const outcomes = mapFinalOutcomes(gammaMarket);
    const umaResolutionStatus = gammaMarket.resolution.umaResolutionStatus ?? undefined;
    const winning = deriveWinningOutcome(outcomes, umaResolutionStatus);
    const isCrypto = selected.crypto !== undefined;

    const finalization: CollectionHeaderFinalization = {
      status,
      startedAtMs: entry.startedAtMs,
      ...(status !== 'pending' ? { finalizedAtMs: nowMs } : {}),
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
      ...(winning !== undefined
        ? { winning: { label: winning.label, instrumentId: winning.instrumentId } }
        : {}),
      ...(isCrypto
        ? {
            crypto: {
              ...(entry.crypto.priceToBeat !== undefined
                ? { priceToBeat: entry.crypto.priceToBeat }
                : {}),
              ...(entry.crypto.finalPrice !== undefined
                ? { finalPrice: entry.crypto.finalPrice }
                : {}),
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
