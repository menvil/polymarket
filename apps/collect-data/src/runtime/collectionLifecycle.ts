/**
 * Read-only проекция collection lifecycle рынков.
 *
 * @remarks
 * ### Почему проекция, а не события компонентов
 *
 * Collection-состоянием владеют `MarketCollectionCoordinator` (какие сессии
 * открыты) и `MarketFinalizer` (какие сессии архивируются) — оба сознательно
 * остаются collection-specific и НЕ превращаются в глобальный менеджер
 * рынков. Поэтому наблюдаемость строится СНАРУЖИ: рантайм и так владеет
 * тиком цикла, поэтому он же диффит публичные снимки компонентов и
 * превращает переходы в события:
 *
 * ```text
 * discovery.findCandidates()      ──► DISCOVERED
 * coordinator.listSessions()  ─┬─► COLLECTION_STARTED  (сессия стала ACTIVE)
 *                              ├─► FINALIZING          (expiry: ACTIVE → FINALIZING)
 *                              ├─► FINALIZED           (сессия ушла из FINALIZING)
 *                              └─► DROPPED             (сессия исчезла без финализации)
 * ```
 *
 * Это НЕ domain-события и НЕ trading lifecycle: здесь только
 * operational-состояние сбора (MR-A PART 15 — контуры lifecycle не
 * смешиваются).
 *
 * ### Ограничение гранулярности
 *
 * Проекция видит состояние в моменты тиков. Переход, целиком уместившийся
 * МЕЖДУ двумя тиками, наблюдается как его итог: `OPENING` внутри одного
 * `fillSlots()` не порождает отдельного события — рынок появляется сразу как
 * `COLLECTION_STARTED`. Для рынков, живущих минуты, при тике в секундах это
 * не теряет ни одного значимого перехода.
 */
import type { MarketId } from '@polymarket/ids';

/** Вид события collection lifecycle. */
export type CollectionLifecycleKind =
  | 'DISCOVERED'
  | 'COLLECTION_STARTED'
  | 'FINALIZING'
  | 'FINALIZED'
  | 'DROPPED';

/** Причина, по которой сессия исчезла, не пройдя финализацию. */
export type CollectionDropReason = 'shutdown' | 'source-failure';

/** Итог завершённой финализации, когда он однозначно выводим. */
export type CollectionFinalizedOutcome = 'archived' | 'failed';

/**
 * Одно наблюдаемое событие collection lifecycle.
 */
export interface CollectionLifecycleEvent {
  /** Вид перехода. */
  readonly kind: CollectionLifecycleKind;
  /** Canonical id рынка (== Polymarket conditionId). */
  readonly marketId: MarketId;
  /** Момент наблюдения перехода (ms). */
  readonly atMs: number;
  /** Вопрос рынка, если известен на момент события. */
  readonly question?: string;
  /** Истечение рынка (ms), если известно. */
  readonly expiresAtMs?: number;
  /**
   * Итог финализации (только `kind === 'FINALIZED'`).
   *
   * @remarks
   * Выводится из дельты счётчиков финализатора и однозначен, пока за тик
   * финализацию покидает один рынок; при одновременном завершении
   * нескольких сессий поле не заполняется — авторитетные суммарные
   * значения всегда доступны в `MarketFinalizerStats`.
   */
  readonly outcome?: CollectionFinalizedOutcome;
  /** Причина отбрасывания (только `kind === 'DROPPED'`). */
  readonly reason?: CollectionDropReason;
}

/** Подписчик на события lifecycle (read-only наблюдение). */
export type CollectionLifecycleListener = (event: CollectionLifecycleEvent) => void;

/** Накопительные счётчики наблюдённых переходов. */
export interface CollectionLifecycleCounts {
  readonly discovered: number;
  readonly collectionStarted: number;
  readonly finalizing: number;
  readonly finalized: number;
  readonly archived: number;
  readonly dropped: number;
}

/** Минимальный снимок сессии, нужный проекции. */
export interface LifecycleSessionSnapshot {
  readonly marketId: MarketId;
  readonly state: 'OPENING' | 'ACTIVE' | 'FINALIZING';
  readonly question?: string;
  readonly expiresAt?: { toNumber(): number };
}

/** Минимальный снимок кандидата, нужный проекции. */
export interface LifecycleCandidateSnapshot {
  readonly marketId: MarketId;
  readonly question: string;
  readonly expiresAt: { toNumber(): number };
}

/** Счётчики финализатора, по которым выводится итог финализации. */
export interface LifecycleFinalizerCounters {
  readonly archivedTotal: number;
  readonly archiveFailures: number;
}

/**
 * Предыдущее наблюдение одной сессии.
 *
 * @remarks
 * Хранит и `marketId`: ключом карты служит `String(marketId)`, а событие об
 * ИСЧЕЗНУВШЕЙ сессии выдаётся тогда, когда её снимка уже нет — восстановить
 * typed-идентификатор из строки было бы невозможно без обратного каста.
 */
interface ObservedSession {
  readonly marketId: MarketId;
  readonly state: 'OPENING' | 'ACTIVE' | 'FINALIZING';
}

/** Время жизни записи о замеченном кандидате (сутки). */
const DISCOVERED_TTL_MS = 24 * 60 * 60_000;

/**
 * Диффер публичных снимков коллекции в поток lifecycle-событий.
 *
 * @remarks
 * Экземпляр хранит только предыдущее наблюдение (состояния сессий, дельты
 * счётчиков финализатора и TTL-ограниченный набор уже замеченных
 * кандидатов) — собственного «истинного» состояния рынка у него нет.
 *
 * @example
 * ```typescript
 * const projection = new CollectionLifecycleProjection();
 * for (const event of projection.observeCandidates(candidates, Date.now())) {
 *   logger.info('Market discovered', { marketId: String(event.marketId) });
 * }
 * ```
 */
export class CollectionLifecycleProjection {
  /** Сессии на предыдущем наблюдении (`String(marketId)` → состояние + identity). */
  private readonly _sessionStates = new Map<string, ObservedSession>();
  /** Уже объявленные DISCOVERED рынки (`String(marketId)` → момент, ms). */
  private readonly _discovered = new Map<string, number>();
  private _lastArchivedTotal = 0;
  private _lastArchiveFailures = 0;
  private _counts = {
    discovered: 0,
    collectionStarted: 0,
    finalizing: 0,
    finalized: 0,
    archived: 0,
    dropped: 0,
  };

  /** Накопленные счётчики наблюдённых переходов. */
  public getCounts(): CollectionLifecycleCounts {
    return { ...this._counts };
  }

  /**
   * Наблюдает свежий candidate cache и выдаёт события впервые увиденных рынков.
   *
   * @param candidates - Текущее содержимое кэша Discovery
   * @param nowMs - Момент наблюдения (ms)
   * @returns События `DISCOVERED` для новых рынков
   *
   * @remarks
   * Набор уже объявленных рынков ограничен по TTL (сутки): рынок такого
   * возраста давно вне окна discovery, поэтому повторного объявления не
   * происходит, а память не растёт неограниченно.
   */
  public observeCandidates(
    candidates: readonly LifecycleCandidateSnapshot[],
    nowMs: number,
  ): readonly CollectionLifecycleEvent[] {
    this._pruneDiscovered(nowMs);
    const events: CollectionLifecycleEvent[] = [];
    for (const candidate of candidates) {
      const key = String(candidate.marketId);
      if (this._discovered.has(key)) {
        continue;
      }
      this._discovered.set(key, nowMs);
      this._counts.discovered++;
      events.push({
        kind: 'DISCOVERED',
        marketId: candidate.marketId,
        atMs: nowMs,
        question: candidate.question,
        expiresAtMs: candidate.expiresAt.toNumber(),
      });
    }
    return events;
  }

  /**
   * Наблюдает текущие сессии и выдаёт события их переходов.
   *
   * @param sessions - Снимок сессий координатора
   * @param finalizer - Счётчики финализатора на тот же момент
   * @param nowMs - Момент наблюдения (ms)
   * @param options - Контекст наблюдения (идёт ли остановка рантайма)
   * @returns События переходов, наблюдённые с прошлого вызова
   *
   * @remarks
   * `OPENING` не порождает события: это внутренняя фаза открытия сессии,
   * завершающаяся в пределах одного `fillSlots()`; наблюдаемым результатом
   * является `ACTIVE` (`COLLECTION_STARTED`) либо полное отсутствие сессии
   * (открытие откатилось — событие не выдаётся, поскольку сбор не начинался).
   */
  public observeSessions(
    sessions: readonly LifecycleSessionSnapshot[],
    finalizer: LifecycleFinalizerCounters,
    nowMs: number,
    options: { readonly shuttingDown: boolean },
  ): readonly CollectionLifecycleEvent[] {
    const events: CollectionLifecycleEvent[] = [];
    const seen = new Set<string>();

    for (const session of sessions) {
      const key = String(session.marketId);
      seen.add(key);
      const previous = this._sessionStates.get(key);
      this._sessionStates.set(key, { marketId: session.marketId, state: session.state });
      if (previous?.state === session.state) {
        continue;
      }
      if (session.state === 'ACTIVE') {
        this._counts.collectionStarted++;
        events.push({
          kind: 'COLLECTION_STARTED',
          marketId: session.marketId,
          atMs: nowMs,
          ...(session.question !== undefined ? { question: session.question } : {}),
          ...(session.expiresAt !== undefined
            ? { expiresAtMs: session.expiresAt.toNumber() }
            : {}),
        });
      } else if (session.state === 'FINALIZING') {
        this._counts.finalizing++;
        events.push({
          kind: 'FINALIZING',
          marketId: session.marketId,
          atMs: nowMs,
          ...(session.question !== undefined ? { question: session.question } : {}),
          ...(session.expiresAt !== undefined
            ? { expiresAtMs: session.expiresAt.toNumber() }
            : {}),
        });
      }
    }

    // Исчезнувшие сессии: из FINALIZING — завершённая финализация, иначе —
    // отброшенная сессия (реконсиляция отказа source / остановка рантайма).
    const departed: Array<{ readonly key: string; readonly session: ObservedSession }> = [];
    for (const [key, session] of this._sessionStates) {
      if (!seen.has(key)) {
        departed.push({ key, session });
      }
    }
    const archivedDelta = finalizer.archivedTotal - this._lastArchivedTotal;
    const failuresDelta = finalizer.archiveFailures - this._lastArchiveFailures;
    this._lastArchivedTotal = finalizer.archivedTotal;
    this._lastArchiveFailures = finalizer.archiveFailures;
    const finalizedDeparted = departed.filter((entry) => entry.session.state === 'FINALIZING');

    for (const entry of departed) {
      this._sessionStates.delete(entry.key);
      const marketId = entry.session.marketId;
      if (entry.session.state === 'FINALIZING') {
        this._counts.finalized++;
        // Итог однозначен, только когда финализацию покинул ровно один рынок.
        const outcome: CollectionFinalizedOutcome | undefined =
          finalizedDeparted.length !== 1
            ? undefined
            : failuresDelta > 0
              ? 'failed'
              : archivedDelta > 0
                ? 'archived'
                : undefined;
        if (outcome === 'archived') {
          this._counts.archived++;
        }
        events.push({
          kind: 'FINALIZED',
          marketId,
          atMs: nowMs,
          ...(outcome !== undefined ? { outcome } : {}),
        });
      } else {
        this._counts.dropped++;
        events.push({
          kind: 'DROPPED',
          marketId,
          atMs: nowMs,
          reason: options.shuttingDown ? 'shutdown' : 'source-failure',
        });
      }
    }

    return events;
  }

  /** Удаляет записи о кандидатах старше TTL. */
  private _pruneDiscovered(nowMs: number): void {
    for (const [key, seenAtMs] of this._discovered) {
      if (nowMs - seenAtMs >= DISCOVERED_TTL_MS) {
        this._discovered.delete(key);
      }
    }
  }
}
