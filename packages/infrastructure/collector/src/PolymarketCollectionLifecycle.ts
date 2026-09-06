/**
 * Жизненный цикл начатых recording-сессий Polymarket-рынков.
 *
 * @remarks
 * ### Место в контуре
 *
 * ```text
 * Discovery → MarketUniverse → Planner → PolymarketSubscriptionController
 *                                             │ claim collector:raw
 *                                             ▼
 *                              PolymarketSource → ОДИН ExternalMessageBus
 *                                                      ├── ExternalMessageRecorder
 *                                                      └── SemanticAdapter (sibling)
 *                                                            ▲
 *   PolymarketCollectionLifecycle ── listMarketSessions() ────┘ read-only
 *          │ beginMarketFinalization / sealMarket / finalizeMarket
 *          └ release('collector:raw', marketId) ──► SubscriptionController
 * ```
 *
 * Класс отвечает ТОЛЬКО за жизненный цикл уже начатой записи рынка. Он не
 * делает discovery, не оценивает policy приобретения, не вызывает
 * `subscribeMarket`, не создаёт RTDS-подписок, не ведёт ref-count физических
 * фидов, не владеет source и не создаёт третьей шины. Физический ресурс
 * существует только через `PolymarketSubscriptionController`.
 *
 * ### Полный цикл одного рынка
 *
 * ```text
 * recorder создал сессию первым наблюдением
 *        ↓ syncSessions()          attach + immutable selected из controller
 * ACTIVE ───────────────────────── таймер ровно на expiresAt
 *        ↓ beginFinalization()
 * FINALIZING                       CLOB и обычные RTDS больше не пишутся
 *        ↓ settlementGraceMs        только settlement TWAP точной identity
 * seal                             датасет заморожен (payload immutable)
 *        ↓
 * release('collector:raw')         физический claim снимается ПОСЛЕ seal
 *        ↓
 * MarketFinalizer                  Gamma → header → .jsonl.gz
 *        ↓ completeFinalization()
 * сессии больше нет
 * ```
 *
 * ### Почему таймер, а не опрос control-тиком
 *
 * Control-цикл ходит раз в единицы-десятки секунд. Ждать его означало бы
 * дописывать в датасет CLOB-события истёкшего рынка ещё десятки секунд —
 * граница датасета определялась бы каденцией discovery, а не расписанием
 * рынка. Поэтому на каждую принятую сессию ставится таймер РОВНО на
 * `expiresAt`, а {@link PolymarketCollectionLifecycle.runOnce} остаётся
 * страховкой (пропущенный/просроченный таймер, рестарт цикла).
 *
 * ### Почему claim снимается ПОСЛЕ seal, а не на истечении
 *
 * Последний claim закрывает разом CLOB, spot-фиды И settlement-поток. Снять
 * его на `expiresAt` значило бы потерять граничное наблюдение TWAP, которое
 * RTDS доставляет на 1.1–2.2 с позже (характеризация 2026-08-26) — то самое,
 * по которому рынок и рассчитывается. Поэтому физический CLOB живёт ещё
 * несколько секунд, но в датасет уже НЕ пишется: границу держит recorder
 * ({@link PolymarketCollectionLifecycle.beginFinalization}), а не транспорт.
 * Осознанный размен: несколько секунд лишнего трафика вместо «полуclaim-ов»
 * и частичного владения ресурсом в контроллере.
 */
import type { ILogger } from '@polymarket/logger';
import type { MarketId } from '@polymarket/ids';
import type { MarketMeta } from '@polymarket/ports';
import type { IClock } from '@polymarket/time';
import { TimestampService } from '@polymarket/timestamp';
import type { Timestamp } from '@polymarket/timestamp';
import { isTwapRtdsFeed, rtdsFeedKey } from '@polymarket/external-message-recorder';
import type {
  PolymarketRecordingSessionSnapshot,
  PolymarketRtdsFeedKey,
  PolymarketTwapRtdsFeed,
} from '@polymarket/external-message-recorder';
import { COLLECTOR_RAW_OWNER_KEY } from './collectorOwner.js';
import type {
  CollectionLifecycleEvent,
  CollectionLifecycleKind,
  CollectionLifecycleListener,
  CollectionMarketPreparation,
  CollectionSessionSnapshot,
  CollectionSessionState,
  FinalizingCollectionSession,
} from './collectionSession.js';

/**
 * Порт recorder-а, используемый lifecycle.
 *
 * @remarks
 * Структурное подмножество `ExternalMessageRecorder`: наблюдение за
 * созданными сессиями и четыре операции границы датасета. Ни `start`, ни
 * `close`, ни `registerMarket` сюда не входят — стартом и остановкой
 * recorder-а владеет composition root, а регистрацией — gate.
 */
export interface CollectionLifecycleRecorder {
  listMarketSessions(): readonly PolymarketRecordingSessionSnapshot[];
  beginMarketFinalization(
    marketId: MarketId,
    settlementFeeds: readonly PolymarketRtdsFeedKey[],
  ): boolean;
  sealMarket(marketId: MarketId): Promise<boolean>;
  finalizeMarket(marketId: MarketId, reason: 'EXPIRED' | 'SHUTDOWN'): Promise<void>;
}

/**
 * Порт control-plane подписок, используемый lifecycle.
 *
 * @typeParam TPrepared - Тип vendor-подготовки рынка контура
 *
 * @remarks
 * Ровно два действия: узнать, что рынок реально удерживается коллектором
 * (и с какой подготовкой), и снять claim. Ни `acquire`, ни `close`
 * контроллера: приобретением владеет control-runtime, остановкой —
 * composition root.
 */
export interface CollectionLifecycleSubscriptions<
  TPrepared extends CollectionMarketPreparation = CollectionMarketPreparation,
> {
  getHeldMarket(
    ownerKey: string,
    marketId: MarketId,
  ): { readonly selected: TPrepared } | undefined;
  release(ownerKey: string, marketId: MarketId): Promise<unknown>;
}

/** Зависимости {@link PolymarketCollectionLifecycle}. */
export interface PolymarketCollectionLifecycleDependencies<
  TPrepared extends CollectionMarketPreparation = CollectionMarketPreparation,
> {
  /** Recording-подписчик общего bus — владелец факта «сессия существует». */
  readonly recorder: CollectionLifecycleRecorder;
  /** Read-only проекция claim-ов + снятие claim-а коллектора. */
  readonly subscriptions: CollectionLifecycleSubscriptions<TPrepared>;
  /** Часы контура (DI — детерминизм тестов). */
  readonly clock: IClock;
  /** Логгер (будет обёрнут в child с component-контекстом). */
  readonly logger: ILogger;
  /**
   * Ключ владельца, чьи claim-ы обслуживает lifecycle.
   * @defaultValue {@link COLLECTOR_RAW_OWNER_KEY}
   */
  readonly ownerKey?: string;
}

/** Конфигурация {@link PolymarketCollectionLifecycle}. */
export interface PolymarketCollectionLifecycleConfig {
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
   * (p50 ≈ 1.5 с). Grace — измеренный максимум с запасом ×2.
   *
   * Затрагивает ТОЛЬКО рынки с распознанным settlement-фидом: рынок без
   * него замораживается сразу, без искусственной задержки.
   */
  readonly settlementGraceMs?: number;
}

/** Дефолт boundary grace (см. конфигурацию). */
const DEFAULT_SETTLEMENT_GRACE_MS = 5_000;

/** Шаг ожидания внутри grace: даёт `close()` прервать его без полного сна. */
const SETTLEMENT_SLICE_MS = 250;

/** Диагностика lifecycle (уходит в `DataCollector.status()`). */
export interface PolymarketCollectionLifecycleStats {
  /** Сессии, пишущие датасет прямо сейчас. */
  readonly activeSessions: number;
  /** Сессии после истечения рынка (grace/seal/резолюция). */
  readonly finalizingSessions: number;
  /** Сколько сессий принято под наблюдение за жизнь процесса. */
  readonly attachedTotal: number;
  /** Сколько датасетов заморожено (seal выполнен). */
  readonly sealedTotal: number;
  /** Сколько claim-ов коллектора снято после заморозки. */
  readonly claimsReleased: number;
  /** Сколько сессий завершено финализатором (архив/discard). */
  readonly completedTotal: number;
  /** Сессии, закрытые как SHUTDOWN (незавершённый датасет). */
  readonly shutdownSessions: number;
  /** Отказы шага границы (seal/release/finalize) — датасет наблюдаемо неполон. */
  readonly finalizationFailures: number;
  /**
   * Recording-сессии, для которых claim коллектора не найден.
   *
   * @remarks
   * Ненулевое значение означает рассинхрон recording-контура и control-plane:
   * запись идёт, а claim-а нет. Такую сессию нельзя корректно финализировать
   * (нет vendor-подготовки для резолюции), поэтому она наблюдаема отдельно.
   */
  readonly sessionsWithoutClaim: number;
  /**
   * Датасеты, снесённые как сироты откаченного приобретения.
   *
   * @remarks
   * Ненулевое значение — норма при отказах RTDS-подписок: приобретение
   * откатилось уже ПОСЛЕ первого записанного наблюдения. Рост этого счётчика
   * вместе с `failed`-исходами приобретения означает нестабильный транспорт,
   * а не дефект записи.
   */
  readonly orphanSessionsDiscarded: number;
}

/** Внутреннее состояние одной сессии. */
interface LifecycleSession<TPrepared extends CollectionMarketPreparation> {
  readonly marketId: MarketId;
  readonly marketMeta: MarketMeta;
  readonly selected: TPrepared;
  readonly recordingStartedAt: Timestamp;
  readonly expiresAt: Timestamp;
  state: CollectionSessionState;
  /**
   * Момент перехода в FINALIZING (epoch ms); `undefined` пока ACTIVE.
   *
   * @remarks
   * Принадлежит ТОМУ, КТО совершил переход, а не тому, кто его заметил:
   * переход делает точный таймер сессии, а подхватывает финализатор на
   * следующем проходе — и `finalization.startedAtMs` в header-е обязан
   * остаться моментом ГРАНИЦЫ, а не моментом подхвата.
   */
  finalizingSinceMs?: number;
  /**
   * Claim коллектора по этому рынку уже снят.
   *
   * @remarks
   * Снятие claim-а — операция, наблюдаемая счётчиком, и запрашивают её ДВА
   * независимых пути: задача границы (`grace → seal → release`) и `close()`,
   * который обязан освободить всё оставшееся. Между ними сессия жива —
   * `completeFinalization` её ещё не снял, — поэтому без явной отметки
   * `close()` вызывал бы release повторно. Контроллер такой вызов переживает
   * (`not-held`), но `claimsReleased` начинал бы врать: диагностика
   * показывала бы больше снятых claim-ов, чем было рынков.
   */
  claimReleased: boolean;
  /** Таймер истечения (снимается при переходе/закрытии). */
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Lifecycle collection-сессий поверх recorder-а и control-plane подписок.
 *
 * @typeParam TPrepared - Тип vendor-подготовки рынка контура
 *
 * @example
 * ```typescript
 * const lifecycle = new PolymarketCollectionLifecycle({
 *   recorder, subscriptions: polymarketController, clock, logger,
 * });
 * lifecycle.syncSessions();            // принять новые записи под наблюдение
 * await lifecycle.runOnce();           // страховка: просроченные сессии
 * await lifecycle.close();             // SHUTDOWN незавершённых датасетов
 * ```
 */
export class PolymarketCollectionLifecycle<
  TPrepared extends CollectionMarketPreparation = CollectionMarketPreparation,
> {
  private readonly _recorder: CollectionLifecycleRecorder;
  private readonly _subscriptions: CollectionLifecycleSubscriptions<TPrepared>;
  private readonly _clock: IClock;
  private readonly _logger: ILogger;
  private readonly _ownerKey: string;
  private readonly _settlementGraceMs: number;

  /** Сессии по `String(marketId)`. */
  private readonly _sessions = new Map<string, LifecycleSession<TPrepared>>();
  /**
   * Идущие задачи границы (grace → seal → release) по `String(marketId)`.
   *
   * @remarks
   * Живут ОТДЕЛЬНО от сессий: сессию удаляет `completeFinalization`, и
   * привязка к ней превратила бы «граница ещё выдерживается» в молчаливое
   * «ждать нечего» ровно тогда, когда ожидание и требуется.
   */
  private readonly _settlementCaptures = new Map<string, Promise<void>>();
  private readonly _listeners = new Set<CollectionLifecycleListener>();

  private _closed = false;
  private _closePromise: Promise<void> | null = null;
  private _attachedTotal = 0;
  private _sealedTotal = 0;
  private _claimsReleased = 0;
  private _completedTotal = 0;
  private _shutdownSessions = 0;
  private _finalizationFailures = 0;
  private _sessionsWithoutClaim = 0;
  private _orphanSessionsDiscarded = 0;

  /**
   * Создаёт lifecycle поверх инъецированных recorder/control-plane.
   *
   * @param deps - Зависимости (см. {@link PolymarketCollectionLifecycleDependencies})
   * @param config - Конфигурация (см. {@link PolymarketCollectionLifecycleConfig})
   */
  public constructor(
    deps: PolymarketCollectionLifecycleDependencies<TPrepared>,
    config: PolymarketCollectionLifecycleConfig = {},
  ) {
    this._recorder = deps.recorder;
    this._subscriptions = deps.subscriptions;
    this._clock = deps.clock;
    this._logger = deps.logger.child({ component: 'PolymarketCollectionLifecycle' });
    this._ownerKey = deps.ownerKey ?? COLLECTOR_RAW_OWNER_KEY;
    this._settlementGraceMs = config.settlementGraceMs ?? DEFAULT_SETTLEMENT_GRACE_MS;
  }

  /** `true` после {@link PolymarketCollectionLifecycle.close}. */
  public get isClosed(): boolean {
    return this._closed;
  }

  /**
   * Подписывает наблюдателя на переходы lifecycle.
   *
   * @param listener - Слушатель переходов
   * @returns Функция отписки
   *
   * @remarks
   * Наблюдаемость операционного состояния сбора: события эмитит тот, кто
   * переход и совершает, поэтому переход, уместившийся между двумя тиками
   * control-цикла, не теряется. Исключение слушателя гасится и логируется —
   * диагностика не имеет права сорвать границу датасета.
   *
   * @example
   * ```typescript
   * const off = lifecycle.onLifecycleEvent((event) => log.push(event.kind));
   * ```
   */
  public onLifecycleEvent(listener: CollectionLifecycleListener): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  /**
   * Принимает под наблюдение новые recording-сессии recorder-а.
   *
   * @returns Сколько сессий принято этим вызовом
   *
   * @remarks
   * Recorder — владелец факта «запись рынка началась» (сессию создаёт первое
   * наблюдение). Lifecycle узнаёт о ней read-only снимком и однократно
   * забирает immutable vendor-подготовку из control-plane, после чего от
   * `MarketUniverse` не зависит вовсе.
   *
   * Сессия без строк (`firstObservedAtMs` отсутствует) не принимается: её
   * датасет ещё не начался. Сессия без claim-а коллектора не принимается
   * тоже — писать её lifecycle не мешает, но и финализировать без
   * vendor-подготовки не может; факт наблюдаем в
   * `sessionsWithoutClaim` и повторяется на следующем проходе.
   *
   * Идемпотентен: уже принятые сессии пропускаются.
   */
  public syncSessions(): number {
    if (this._closed) {
      return 0;
    }
    let attached = 0;
    for (const snapshot of this._recorder.listMarketSessions()) {
      const key = String(snapshot.marketId);
      if (this._sessions.has(key) || snapshot.state === 'SEALED') {
        continue;
      }
      if (snapshot.firstObservedAtMs === undefined) {
        continue; // строк ещё нет — датасет не начался
      }
      const held = this._subscriptions.getHeldMarket(this._ownerKey, snapshot.marketId);
      if (held === undefined) {
        this._sessionsWithoutClaim++;
        this._logger.warn('Recording session has no collector claim; finalization impossible', {
          marketId: key,
          ownerKey: this._ownerKey,
        });
        continue;
      }
      const recordingStartedAt = TimestampService.create(snapshot.firstObservedAtMs);
      if (!recordingStartedAt.ok) {
        this._sessionsWithoutClaim++;
        this._logger.error('Recording session reported an invalid first observation moment', {
          marketId: key,
          firstObservedAtMs: snapshot.firstObservedAtMs,
        });
        continue;
      }
      const session: LifecycleSession<TPrepared> = {
        marketId: snapshot.marketId,
        marketMeta: snapshot.marketMeta,
        selected: held.selected,
        recordingStartedAt: recordingStartedAt.value,
        expiresAt: snapshot.marketMeta.expiresAt,
        state: snapshot.state === 'FINALIZING' ? 'FINALIZING' : 'ACTIVE',
        claimReleased: false,
        expiryTimer: null,
      };
      this._sessions.set(key, session);
      this._attachedTotal++;
      attached++;
      this._armExpiryTimer(session);
      this._logger.info('Collection session attached', {
        marketId: key,
        question: session.marketMeta.question,
        expiresAt: new Date(session.expiresAt.toNumber()).toISOString(),
        rtdsFeeds: session.selected.rtdsFeeds.map((feed) => rtdsFeedKey(feed)),
      });
      this._emit('STARTED', session);
    }
    return attached;
  }

  /**
   * Один проход lifecycle: снос сирот, sync новых сессий, страховка по
   * просроченным.
   *
   * @returns Promise завершения прохода
   *
   * @remarks
   * ### Предусловие вызова
   *
   * Вызывается ПОСЛЕ того, как control-проход этого тика завершился
   * (`PolymarketControlRuntime.runOnce()` дождан). Это существенно для шага
   * сноса сирот: пока транзакция приобретения идёт, claim рынка уже
   * существует (он создаётся синхронно при резервации), поэтому «строки есть,
   * claim-а нет» однозначно означает УЖЕ ОТКАЧЕННОЕ приобретение, а не
   * приобретение в процессе.
   *
   * ### Порядок шагов
   *
   * ```text
   * 1. снос сирот failed acquisition   (датасет без claim-а — удалить)
   * 2. приём новых recording-сессий    (attach + immutable selected)
   * 3. страховка по просроченным       (ACTIVE due → FINALIZING)
   * ```
   *
   * Штатную границу держит таймер сессии; шаг 3 — safety net на случай
   * пропущенного таймера (перегруженный event loop, восстановление после
   * ошибки) и точка входа для shutdown, где нужно перевести истёкшие сессии
   * до дренажа финализатора. Отказ по одному рынку не прерывает проход.
   */
  public async runOnce(): Promise<void> {
    if (this._closed) {
      return;
    }
    await this._discardOrphanedSessions();
    this.syncSessions();
    const nowMs = this._clock.now().getTime();
    for (const session of [...this._sessions.values()]) {
      if (session.state !== 'ACTIVE' || session.expiresAt.toNumber() > nowMs) {
        continue;
      }
      try {
        await this.beginFinalization(session.marketId);
      } catch (error) {
        this._finalizationFailures++;
        this._logger.error('Expiry transition failed, continuing pass', {
          marketId: String(session.marketId),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Сносит recording-сессии, оставшиеся от ОТКАЧЕННОГО приобретения.
   *
   * @returns Promise завершения сноса
   *
   * @remarks
   * ### Откуда берётся сирота
   *
   * Снимок удерживаемого рынка доступен уже на стадии `OPENING` — иначе
   * терялся бы первый (опорный) book-снапшот, который приходит сразу после
   * `subscribeMarket()`. Плата за это — окно, в котором запись уже началась,
   * а транзакция приобретения ещё может откатиться:
   *
   * ```text
   * OPENING: subscribeMarket() ok → initial book → допуск → сессия + строка
   *          RTDS subscribe FAILED → rollback → claim рынка исчез
   *          recording-сессия ОСТАЛАСЬ с одной строкой
   * ```
   *
   * Оставить её нельзя: на следующем тике приобретение повторится, но
   * recording-сессия уже существует, и новый initial book попадёт в ТОТ ЖЕ
   * файл БЕЗ повторного допуска. Один датасет склеил бы отказавшее поколение
   * подписки, дыру и поколение-повтор — для replay это ложь о непрерывности
   * наблюдений.
   *
   * ### Почему «нет claim-а» — надёжный признак
   *
   * Claim создаётся СИНХРОННО при резервации рынка, до первого `await`
   * транзакции, и исчезает только при откате либо явном `release`. Значит,
   * пока приобретение идёт, claim есть; «строки есть, claim-а нет» — это уже
   * завершившийся откат, а не гонка с идущим приобретением. Предусловие
   * «control-проход тика дождан» (см. {@link PolymarketCollectionLifecycle.runOnce})
   * закрывает и остаток.
   *
   * ### Что НЕ сносится
   *
   * - сессии, уже принятые lifecycle (у них свой путь границы);
   * - `FINALIZING`/`SEALED` (claim там снят ШТАТНО — после заморозки
   *   датасета, и архивом владеет финализатор);
   * - сессии без единой записанной строки (сносить нечего: файла нет).
   *
   * Снос — `finalizeMarket(SHUTDOWN)`: storage удаляет незавершённый `.jsonl`,
   * recorder снимает сессию и routing. Следующее приобретение начинает
   * ЧИСТУЮ новую сессию. Отказ по одному рынку наблюдаем и не прерывает
   * проход.
   */
  private async _discardOrphanedSessions(): Promise<void> {
    for (const snapshot of this._recorder.listMarketSessions()) {
      const key = String(snapshot.marketId);
      if (snapshot.state !== 'ACTIVE' || this._sessions.has(key)) {
        continue;
      }
      if (snapshot.firstObservedAtMs === undefined) {
        continue; // строк нет — датасета тоже нет
      }
      if (this._subscriptions.getHeldMarket(this._ownerKey, snapshot.marketId) !== undefined) {
        continue; // claim на месте — сессию примет syncSessions
      }
      try {
        await this._recorder.finalizeMarket(snapshot.marketId, 'SHUTDOWN');
        this._orphanSessionsDiscarded++;
        this._logger.warn('Orphaned recording session discarded: acquisition was rolled back', {
          marketId: key,
          ownerKey: this._ownerKey,
        });
        this._emitEvent('DROPPED', {
          marketId: snapshot.marketId,
          question: snapshot.marketMeta.question,
          expiresAtMs: snapshot.marketMeta.expiresAt.toNumber(),
        });
      } catch (error) {
        this._finalizationFailures++;
        this._logger.error('Failed to discard orphaned recording session', {
          marketId: key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Expiry-переход: ACTIVE → FINALIZING (идемпотентен, ровно один раз).
   *
   * @param marketId - ID рынка
   * @returns Immutable-снимок для финализатора либо `undefined`, если сессии
   *   нет либо она уже FINALIZING
   *
   * @remarks
   * Синхронная секция (НИ ОДНОГО `await`) делает границу датасета точной:
   *
   * 1. стадия сессии становится `FINALIZING`, таймер снимается;
   * 2. `recorder.beginMarketFinalization` — CLOB и обычные RTDS перестают
   *    писаться немедленно, остаётся только settlement-поток точной
   *    identity (`topic` + `symbol` + окно; без эвристик символа);
   * 3. регистрируется задача границы (grace → seal → release), чтобы
   *    `close()`, пришедший следующим тиком, обязан был её дождаться.
   *
   * Шаги grace/seal/release выполняются АСИНХРОННО: метод возвращает снимок
   * сразу, не задерживая проход финализатора. Всякий, кому нужен замороженный
   * датасет, дожидается
   * {@link PolymarketCollectionLifecycle.awaitSettlementCapture}.
   *
   * `finalizeMarket(EXPIRED)` здесь НЕ вызывается — архивом владеет
   * финализатор после enrichment/timeout.
   *
   * @example
   * ```typescript
   * const finalizing = await lifecycle.beginFinalization(marketId);
   * if (finalizing) pending.set(String(marketId), finalizing);
   * ```
   */
  public async beginFinalization(
    marketId: MarketId,
  ): Promise<FinalizingCollectionSession<TPrepared> | undefined> {
    const key = String(marketId);
    const session = this._sessions.get(key);
    if (session === undefined || session.state !== 'ACTIVE') {
      this._logger.debug('beginFinalization: no ACTIVE session for market', {
        marketId: key,
        state: session?.state,
      });
      return undefined;
    }

    // ── Синхронная секция: НИ ОДНОГО await до конца ─────────────────────
    session.state = 'FINALIZING';
    session.finalizingSinceMs = this._clock.now().getTime();
    this._clearExpiryTimer(session);
    const settlementFeeds = session.selected.rtdsFeeds.filter(isTwapRtdsFeed);
    const narrowed = this._beginRecorderFinalization(session, settlementFeeds);

    const capture = this._runSettlementCutoff(session, settlementFeeds, narrowed).finally(() => {
      if (this._settlementCaptures.get(key) === capture) {
        this._settlementCaptures.delete(key);
      }
    });
    this._settlementCaptures.set(key, capture);

    this._logger.info('Collection session entered finalization', {
      marketId: key,
      question: session.marketMeta.question,
      expiresAt: new Date(session.expiresAt.toNumber()).toISOString(),
      settlementFeeds: settlementFeeds.map((feed) => rtdsFeedKey(feed)),
    });
    this._emit('FINALIZING', session);
    return this._toFinalizingSnapshot(session);
  }

  /**
   * Возвращает immutable-снимок УЖЕ FINALIZING сессии.
   *
   * @param marketId - ID рынка
   * @returns Тот же контракт, что отдаёт
   *   {@link PolymarketCollectionLifecycle.beginFinalization}, либо
   *   `undefined` — сессии нет либо она ещё ACTIVE
   *
   * @remarks
   * ### Зачем нужен отдельно от `beginFinalization`
   *
   * Переход `ACTIVE → FINALIZING` совершает ТОТ, кто первым дошёл до
   * границы: точный таймер сессии, страховочный `runOnce()` lifecycle либо
   * сам финализатор. `beginFinalization` устроен «ровно один раз» и второму
   * вызывающему честно отвечает `undefined` — а значит, финализатор,
   * опоздавший к переходу, остался бы вообще без снимка:
   *
   * ```text
   * 18:05:00.000  таймер сессии → FINALIZING → grace → seal → release
   * 18:05:05.000  finalizer.runOnce() видит FINALIZING и... пропускает
   *               → Gamma polling не начинается, архива нет, сессия вечна
   * ```
   *
   * Этот метод закрывает разрыв: КТО БЫ ни инициировал переход, финализатор
   * получает тот же immutable контракт и регистрирует рынок ровно один раз
   * (дедупликация — по его собственному `_pending`).
   *
   * Метод НИЧЕГО не меняет: он не двигает стадию, не трогает таймеры и не
   * запускает задачу границы. Повторные вызовы возвращают один и тот же
   * снимок, пока сессию не снимет `completeFinalization`.
   *
   * @example
   * ```typescript
   * const session =
   *   snapshot.state === 'FINALIZING'
   *     ? lifecycle.getFinalizingSession(snapshot.marketId)
   *     : await lifecycle.beginFinalization(snapshot.marketId);
   * ```
   */
  public getFinalizingSession(
    marketId: MarketId,
  ): FinalizingCollectionSession<TPrepared> | undefined {
    const session = this._sessions.get(String(marketId));
    if (session === undefined || session.state !== 'FINALIZING') {
      return undefined;
    }
    return this._toFinalizingSnapshot(session);
  }

  /**
   * Собирает immutable-снимок FINALIZING-сессии.
   *
   * @param session - Сессия в состоянии FINALIZING
   * @returns Контракт для финализатора
   *
   * @remarks
   * Единственное место сборки снимка: два независимых литерала однажды
   * разошлись бы полями, и путь «таймер → подхват» отдавал бы финализатору
   * не то же самое, что путь «финализатор сам перевёл».
   */
  private _toFinalizingSnapshot(
    session: LifecycleSession<TPrepared>,
  ): FinalizingCollectionSession<TPrepared> {
    return Object.freeze({
      marketId: session.marketId,
      recordingStartedAt: session.recordingStartedAt,
      selected: session.selected,
      marketMeta: session.marketMeta,
      finalizingSinceMs: session.finalizingSinceMs ?? this._clock.now().getTime(),
    });
  }

  /**
   * Дожидается заморозки датасета рынка (grace → seal → release).
   *
   * @param marketId - ID рынка
   * @returns Promise, разрешающийся когда датасет гарантированно заморожен
   *
   * @remarks
   * No-op для рынков без идущей задачи границы — вызывать можно сколько
   * угодно раз. ОБЯЗАТЕЛЬНАЯ преамбула любого чтения записанных строк и
   * любого архивирования: без неё архив мог бы поймать датасет в момент
   * дописывания граничного наблюдения.
   *
   * @example
   * ```typescript
   * await lifecycle.awaitSettlementCapture(marketId); // датасет заморожен
   * const lines = await recorder.readSealedPayloadLines(marketId, filter);
   * ```
   */
  public async awaitSettlementCapture(marketId: MarketId): Promise<void> {
    const capture = this._settlementCaptures.get(String(marketId));
    if (capture !== undefined) {
      await capture;
    }
  }

  /**
   * Снимает FINALIZING-сессию после завершения работы финализатора.
   *
   * @param marketId - ID рынка
   * @returns `true` — сессия была FINALIZING и удалена; `false` — no-op
   *
   * @remarks
   * Identity-guard по стадии: ACTIVE-сессия (например, перерегистрированный
   * рынок) не затрагивается. Вызывается финализатором и после успешного
   * архива, и после discard — вечного FINALIZING остаться не должно.
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
    this._completedTotal++;
    this._logger.info('Collection session finalization completed', { marketId: key });
    this._emit('COMPLETED', session);
    return true;
  }

  /**
   * Возвращает read-only снимки всех сессий.
   *
   * @returns Снимки, отсортированные по id рынка (детерминированный порядок)
   */
  public listSessions(): readonly CollectionSessionSnapshot<TPrepared>[] {
    return [...this._sessions.values()]
      .map((session) =>
        Object.freeze({
          marketId: session.marketId,
          state: session.state,
          question: session.marketMeta.question,
          recordingStartedAt: session.recordingStartedAt,
          expiresAt: session.expiresAt,
          selected: session.selected,
        }),
      )
      .sort((left, right) => {
        const a = String(left.marketId);
        const b = String(right.marketId);
        if (a < b) return -1;
        return a > b ? 1 : 0;
      });
  }

  /**
   * Возвращает снимок диагностики lifecycle.
   *
   * @returns Текущие значения {@link PolymarketCollectionLifecycleStats}
   */
  public getStats(): PolymarketCollectionLifecycleStats {
    let active = 0;
    let finalizing = 0;
    for (const session of this._sessions.values()) {
      if (session.state === 'ACTIVE') active++;
      else finalizing++;
    }
    return Object.freeze({
      activeSessions: active,
      finalizingSessions: finalizing,
      attachedTotal: this._attachedTotal,
      sealedTotal: this._sealedTotal,
      claimsReleased: this._claimsReleased,
      completedTotal: this._completedTotal,
      shutdownSessions: this._shutdownSessions,
      finalizationFailures: this._finalizationFailures,
      sessionsWithoutClaim: this._sessionsWithoutClaim,
      orphanSessionsDiscarded: this._orphanSessionsDiscarded,
    });
  }

  /**
   * Дожидается всех идущих задач границы (grace → seal → release).
   *
   * @returns Promise завершения всех задач
   *
   * @remarks
   * Отдельно от `close()`: штатный shutdown обязан дождаться заморозки
   * датасетов ДО того, как финализатор начнёт их архивировать, и это
   * ожидание не должно закрывать lifecycle.
   */
  public async awaitAllSettlementCaptures(): Promise<void> {
    while (this._settlementCaptures.size > 0) {
      await Promise.allSettled([...this._settlementCaptures.values()]);
    }
  }

  /**
   * Закрывает lifecycle: снимает таймеры и завершает оставшиеся сессии.
   *
   * @returns Promise завершения остановки
   *
   * @remarks
   * Порядок (идемпотентен, повторные вызовы ждут первый):
   *
   * 1. новые sync/переходы запрещаются, таймеры снимаются, идущие задачи
   *    границы дожидаются (иначе cleanup storage удалил бы датасет прямо во
   *    время его заморозки);
   * 2. ACTIVE-сессии (рынок НЕ истёк) закрываются как `SHUTDOWN`:
   *    незавершённый датасет удаляет storage — выдавать обрывок за пригодный
   *    к replay архив нельзя;
   * 3. claim-ы коллектора снимаются для ВСЕХ оставшихся сессий — включая те,
   *    чья финализация отказала: zombie-подписка после остановки процесса
   *    недопустима. Сессия, у которой claim уже снят задачей границы,
   *    повторного release не получает (отметка в сессии), а вот сессия,
   *    принятая уже в состоянии `FINALIZING` и потому не имевшая своей
   *    задачи границы, освобождается именно здесь.
   *
   * FINALIZING-сессии здесь не архивируются: их судьбой владеет
   * `MarketFinalizer`, который в штатном shutdown уже отработал (drain →
   * close) ДО этого вызова.
   */
  public async close(): Promise<void> {
    if (this._closePromise !== null) {
      return this._closePromise;
    }
    this._closed = true;
    for (const session of this._sessions.values()) {
      this._clearExpiryTimer(session);
    }
    this._closePromise = (async () => {
      await Promise.allSettled([...this._settlementCaptures.values()]);
      for (const session of [...this._sessions.values()]) {
        const key = String(session.marketId);
        if (session.state === 'ACTIVE') {
          this._shutdownSessions++;
          try {
            await this._recorder.finalizeMarket(session.marketId, 'SHUTDOWN');
          } catch (error) {
            this._finalizationFailures++;
            this._logger.error('Shutdown finalization failed for active session', {
              marketId: key,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          this._emit('DROPPED', session);
        }
        await this._releaseClaim(session);
        this._sessions.delete(key);
      }
      this._logger.info('Collection lifecycle closed', { stats: this.getStats() });
    })();
    return this._closePromise;
  }

  // ───────────────────────────── Внутреннее ─────────────────────────────

  /**
   * Ставит таймер границы РОВНО на `expiresAt` сессии.
   *
   * @param session - Принятая сессия
   *
   * @remarks
   * Уже истёкший рынок получает нулевую задержку, а не пропуск: переход
   * обязан состояться, даже если сессия принята с опозданием. Таймер
   * `unref`-ится — он не удерживает процесс живым.
   */
  private _armExpiryTimer(session: LifecycleSession<TPrepared>): void {
    if (session.state !== 'ACTIVE') {
      return;
    }
    const delayMs = Math.max(0, session.expiresAt.toNumber() - this._clock.now().getTime());
    const timer = setTimeout(() => {
      session.expiryTimer = null;
      void this.beginFinalization(session.marketId).catch((error: unknown) => {
        this._finalizationFailures++;
        this._logger.error('Scheduled expiry transition failed', {
          marketId: String(session.marketId),
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, delayMs);
    timer.unref?.();
    session.expiryTimer = timer;
  }

  /** Снимает таймер границы сессии (идемпотентно). */
  private _clearExpiryTimer(session: LifecycleSession<TPrepared>): void {
    if (session.expiryTimer !== null) {
      clearTimeout(session.expiryTimer);
      session.expiryTimer = null;
    }
  }

  /**
   * Переводит recording-сессию в FINALIZING (СИНХРОННО, с изоляцией отказа).
   *
   * @param session - Сессия рынка
   * @param settlementFeeds - Точная identity settlement-потока рынка
   * @returns Применил ли recorder переход
   */
  private _beginRecorderFinalization(
    session: LifecycleSession<TPrepared>,
    settlementFeeds: readonly PolymarketTwapRtdsFeed[],
  ): boolean {
    try {
      return this._recorder.beginMarketFinalization(session.marketId, settlementFeeds);
    } catch (error) {
      this._finalizationFailures++;
      this._logger.error('Recorder refused the finalization transition', {
        marketId: String(session.marketId),
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Полная граница истёкшего рынка: grace → seal → release claim.
   *
   * @param session - Сессия в состоянии FINALIZING
   * @param settlementFeeds - Settlement-фиды рынка (пусто — grace не нужен)
   * @param narrowed - Применил ли recorder сужение (иначе ждать бессмысленно)
   *
   * @remarks
   * Никогда не reject-ится: promise может простоять неотслеженным до часа
   * (пока финализатор ждёт официальную резолюцию), и превращать отказ seal в
   * unhandled rejection процесса недопустимо.
   *
   * Claim снимается ПОСЛЕ попытки seal и ПРИ ЛЮБОМ её исходе: отказ файловой
   * операции не имеет права оставить живую физическую подписку без хозяина.
   */
  private async _runSettlementCutoff(
    session: LifecycleSession<TPrepared>,
    settlementFeeds: readonly PolymarketTwapRtdsFeed[],
    narrowed: boolean,
  ): Promise<void> {
    const key = String(session.marketId);
    try {
      if (narrowed && settlementFeeds.length > 0 && this._settlementGraceMs > 0) {
        await this._awaitSettlementGrace();
      }
      const sealed = await this._recorder.sealMarket(session.marketId);
      if (sealed) {
        this._sealedTotal++;
      } else {
        this._finalizationFailures++;
        this._logger.warn('Recorder seal reported no writer during expiry transition', {
          marketId: key,
        });
      }
      this._emit('SEALED', session);
    } catch (error) {
      this._finalizationFailures++;
      this._logger.error('Settlement cutoff failed; dataset may remain unsealed', {
        marketId: key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Claim снимается ПОСЛЕ заморозки, но безусловно: и при отказе seal
    await this._releaseClaim(session);
  }

  /**
   * Выдерживает boundary grace, оставаясь прерываемым закрытием.
   *
   * @returns Promise окончания ожидания
   *
   * @remarks
   * Бюджет отсчитывается КОЛИЧЕСТВОМ интервалов, а не разницей показаний
   * `IClock`: часы инъецируемые, а спит цикл на реальном таймере — при
   * остановленных (тестовых) часах сравнение «прошло ли столько-то по часам»
   * никогда не стало бы истинным, и grace превратился бы в бесконечный сон.
   * Дробление на слайсы нужно, чтобы `close()` не ждал полный бюджет.
   */
  private async _awaitSettlementGrace(): Promise<void> {
    const sliceMs = Math.min(SETTLEMENT_SLICE_MS, this._settlementGraceMs);
    const slices = Math.max(1, Math.ceil(this._settlementGraceMs / sliceMs));
    for (let slice = 0; slice < slices; slice++) {
      if (this._closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, sliceMs);
        timer.unref?.();
      });
    }
  }

  /**
   * Снимает claim коллектора с рынка (ровно один раз на сессию).
   *
   * @param session - Сессия рынка
   *
   * @remarks
   * Идемпотентность обеспечивается отметкой в самой сессии, а не ответом
   * контроллера: тот на повторный вызов честно отвечает `not-held`, но
   * счётчик `claimsReleased` к этому моменту уже вырос бы второй раз.
   *
   * Отметка ставится ДО `await`: `close()`, пришедший следующим тиком,
   * обязан увидеть, что release уже начат, и не продублировать его.
   *
   * Отказ снятия наблюдаем, но отметку НЕ снимает: повторять release,
   * отказавший по причине состояния контроллера (остановлен, разбирает
   * ресурс), значило бы множить одинаковые ошибки в логе, не меняя исхода.
   * Утечка видна по `finalizationFailures` и по статистике контроллера.
   */
  private async _releaseClaim(session: LifecycleSession<TPrepared>): Promise<void> {
    if (session.claimReleased) {
      return;
    }
    session.claimReleased = true;
    const key = String(session.marketId);
    try {
      const result = await this._subscriptions.release(this._ownerKey, session.marketId);
      this._claimsReleased++;
      this._logger.info('Collector claim released after dataset boundary', {
        marketId: key,
        result: typeof result === 'string' ? result : undefined,
      });
    } catch (error) {
      this._finalizationFailures++;
      this._logger.error('Failed to release collector claim; subscription may leak', {
        marketId: key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Рассылает событие lifecycle по данным ПРИНЯТОЙ сессии.
   *
   * @param kind - Вид перехода
   * @param session - Сессия, с которой произошёл переход
   */
  private _emit(kind: CollectionLifecycleKind, session: LifecycleSession<TPrepared>): void {
    this._emitEvent(kind, {
      marketId: session.marketId,
      question: session.marketMeta.question,
      expiresAtMs: session.expiresAt.toNumber(),
    });
  }

  /**
   * Рассылает событие lifecycle, гася исключения слушателей.
   *
   * @param kind - Вид перехода
   * @param about - Идентификация рынка перехода
   *
   * @remarks
   * Принимает данные рынка, а не принятую сессию: снос сироты происходит с
   * recording-сессией, которую lifecycle принять как раз НЕ смог, и требовать
   * для события `LifecycleSession` значило бы сделать самый интересный
   * переход единственным ненаблюдаемым.
   */
  private _emitEvent(
    kind: CollectionLifecycleKind,
    about: { readonly marketId: MarketId; readonly question: string; readonly expiresAtMs: number },
  ): void {
    if (this._listeners.size === 0) {
      return;
    }
    const event: CollectionLifecycleEvent = {
      kind,
      marketId: about.marketId,
      atMs: this._clock.now().getTime(),
      question: about.question,
      expiresAtMs: about.expiresAtMs,
    };
    for (const listener of this._listeners) {
      try {
        listener(event);
      } catch (error) {
        this._logger.warn('Collection lifecycle listener threw', {
          kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
