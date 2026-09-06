/**
 * Production-рантайм сбора сырых рыночных данных после Collector-cutover.
 *
 * @remarks
 * ### Контур
 *
 * ```text
 * PM control-plane ─┐ (discovery → universe → planner → controller → source)
 * CEX control-plane ┤ (controller → CexSource generations)
 *                   ├──► ОДИН ExternalMessageBus ──┬──► Collector (recorder + gate)
 *                   │                              └──► любой другой consumer
 *                   │                                   (semantic adapter)
 * source-ы          ┘
 * ```
 *
 * Рантайм НЕ владеет источниками и не открывает подписки сам: он выражает
 * спрос коллектора (`collector:raw`) через control-plane каждый тик. Collector
 * (recorder + `PolymarketCollectionGate`) — обычный подписчик шины, а не gate
 * перед семантикой. Semantic-конверсий, Domain-концептов и стратегий здесь
 * нет: рантайм живёт строго ДО semantic boundary.
 *
 * ### Полный жизненный цикл рынка
 *
 * ```text
 * claim collector:raw ДО открытия  (control-plane)
 *   → первое наблюдение → ACTIVE   (gate + recorder)
 *   → expiresAt → FINALIZING       (lifecycle: таймер сессии, НЕ тик)
 *   → settlement grace → seal      (lifecycle)
 *   → release collector:raw        (lifecycle)
 *   → Gamma enrichment → header    (finalizer)
 *   → .jsonl.gz → сессия снята     (finalizer)
 * ```
 *
 * Границу датасета держит ТАЙМЕР сессии, а не каденция control-цикла: тик
 * ходит раз в секунды-десятки секунд, и ждать его значило бы дописывать в
 * датасет CLOB истёкшего рынка всё это время.
 *
 * ### Порядок старта (recorder-first)
 *
 * ```text
 * startup cleanup → recorder.start() → control-loop (runOnce + reconcile)
 * ```
 *
 * Recorder подписывается на шину ДО первого control-тика: иначе первое
 * наблюдение приобретённого рынка ушло бы в шину без записи.
 *
 * ### Порядок остановки
 *
 * ```text
 * control-loop
 *   → lifecycle.runOnce            (истёкшие сессии входят в FINALIZING)
 *   → lifecycle.awaitAllSettlementCaptures  (датасеты заморожены)
 *   → finalizer.drain → finalizer.close     (официальные резолюции/fallback)
 *   → lifecycle.close              (ACTIVE → SHUTDOWN, claim-ы сняты)
 *   → cexController.close → pmController.close → PM source.close
 *   → client.closeSubscriptions → bus.drain → recorder.close → bus.close
 * ```
 *
 * Порядок продиктован данными, а не удобством: сначала доводятся до конца
 * УЖЕ начатые записи (иначе истёкший рынок остался бы без архива, а его
 * незавершённый `.jsonl` забрал бы startup cleanup), и только потом снимаются
 * физические подписки. Затем закрывается общий PM source и его shared
 * realtime, и лишь после этого очередь шины дренируется В recorder. Каждый
 * шаг best-effort.
 */
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import { Timestamp } from '@polymarket/timestamp';
import type { Result } from '@polymarket/result';
import type { MessageBusDrainError, MessageBusStats } from '@polymarket/message-bus';
import type { createPublicClient } from '@polymarket/client';
import type { CexWindowRecorder, DataRecorder } from '@polymarket/data-collection';
import type { CexWindowRecorderStats } from '@polymarket/data-collection';
import type { PolymarketSource } from '@polymarket/polymarket-v2';
import type { ExternalMessageRecorder } from '@polymarket/external-message-recorder';
import type {
  ExternalMessageRecorderCexStats,
  ExternalMessageRecorderStats,
} from '@polymarket/external-message-recorder';
import type {
  PolymarketControlRuntime,
  PolymarketSubscriptionDemand,
} from '@polymarket/polymarket-control-runtime';
import type {
  PolymarketSubscriptionController,
  PolymarketSubscriptionControllerStats,
} from '@polymarket/polymarket-subscription-control';
import type {
  CexSubscriptionController,
  CexSubscriptionControllerStats,
  CexSubscriptionDemand,
} from '@polymarket/cex-subscription-control';
import type {
  CollectionLifecycleListener,
  PolymarketCollectionGate,
  PolymarketCollectionGateStats,
  PolymarketCollectionLifecycle,
  PolymarketCollectionLifecycleStats,
} from '@polymarket/collector';
import type { MarketFinalizer, MarketFinalizerStats } from '@polymarket/market-finalizer';
import type { SelectedPolymarketMarket } from '@polymarket/polymarket-v2';
import type { ControlRuntimeConfig } from './DataCollectorConfig.js';

// ───────────────────────────── Порты компонентов ─────────────────────────────

/** Порт общего bus (рантайм только дренирует и закрывает его). */
export interface CollectorBus {
  drain(): Promise<Result<void, MessageBusDrainError>>;
  close(): Promise<Result<void, MessageBusDrainError>>;
  getStats(): MessageBusStats;
}

/** Порт recording-подписчика bus. */
export type CollectorRecorder = Pick<
  ExternalMessageRecorder,
  'start' | 'close' | 'getStats' | 'getCexStats'
>;

/** Порт lifecycle collection-сессий (синхронизация, границы, остановка). */
export type CollectorLifecycle = Pick<
  PolymarketCollectionLifecycle<SelectedPolymarketMarket>,
  | 'runOnce'
  | 'syncSessions'
  | 'awaitAllSettlementCaptures'
  | 'onLifecycleEvent'
  | 'getStats'
  | 'close'
>;

/** Порт post-expiry финализатора (проход, дренаж, остановка, диагностика). */
export type CollectorFinalizer = Pick<
  MarketFinalizer,
  'runOnce' | 'drain' | 'close' | 'getStats'
>;

/** Порт storage-политики Polymarket (startup cleanup). */
export type CollectorPolymarketStorage = Pick<DataRecorder, 'cleanup'>;

/** Порт storage-политики CEX-окон (startup cleanup + статистика партиций). */
export type CollectorCexStorage = Pick<CexWindowRecorder, 'cleanup' | 'getStats'>;

/** Порт общего PM-source (закрытие + health-сигнал). */
export type CollectorPolymarketSource = Pick<PolymarketSource, 'close' | 'hasFailed' | 'isClosed'>;

/** Порт официального SDK-клиента в части ЕГО собственных ресурсов. */
export type CollectorPolymarketClient = Pick<
  ReturnType<typeof createPublicClient>,
  'closeSubscriptions'
>;

/** Порт control-runtime Polymarket (один детерминированный проход). */
export type CollectorPolymarketControlRuntime = Pick<PolymarketControlRuntime, 'runOnce'>;

/** Порт PM-контроллера подписок (закрытие + диагностика). */
export type CollectorPolymarketController = Pick<
  PolymarketSubscriptionController,
  'close' | 'getStats'
>;

/** Порт CEX-контроллера подписок (сверка спроса + закрытие + диагностика). */
export type CollectorCexController = Pick<
  CexSubscriptionController,
  'reconcile' | 'close' | 'getStats'
>;

/** Порт политики допуска (только диагностика — сессиями владеет recorder). */
export type CollectorGate = Pick<PolymarketCollectionGate, 'getStats'>;

/**
 * Уже собранные компоненты контура, чьим lifecycle владеет рантайм.
 */
export interface DataCollectorComponents {
  readonly bus: CollectorBus;
  readonly recorder: CollectorRecorder;
  readonly gate: CollectorGate;
  /** Жизненный цикл начатых записей (граница датасета + снятие claim-ов). */
  readonly lifecycle: CollectorLifecycle;
  /** Post-expiry финализация (Gamma → header → архив). */
  readonly finalizer: CollectorFinalizer;
  readonly polymarketStorage: CollectorPolymarketStorage;
  readonly cexStorage: CollectorCexStorage;
  /** Общий PM source (принадлежит контуру, разделён с контроллером/discovery). */
  readonly polymarketSource: CollectorPolymarketSource;
  /** SDK-клиент (его shared realtime закрывает контур). */
  readonly polymarketClient: CollectorPolymarketClient;
  readonly polymarketControlRuntime: CollectorPolymarketControlRuntime;
  readonly polymarketController: CollectorPolymarketController;
  readonly cexController: CollectorCexController;
  /** Спрос коллектора на приобретение Polymarket-рынков (`collector:raw`). */
  readonly polymarketDemands: readonly PolymarketSubscriptionDemand[];
  /** Спрос коллектора на CEX-потоки (по одному owner на биржу). */
  readonly cexDemands: readonly CexSubscriptionDemand[];
}

/** Зависимости {@link DataCollector}. */
export interface DataCollectorDependencies {
  readonly components: DataCollectorComponents;
  readonly control: ControlRuntimeConfig;
  readonly clock: IClock;
  readonly logger: ILogger;
}

// ──────────────────────────── Операционный статус ────────────────────────────

/** Состояние рантайма. */
export type DataCollectorState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';

/** Read-only снимок операционного состояния рантайма. */
export interface DataCollectorStatus {
  readonly state: DataCollectorState;
  readonly startedAtMs: number | null;
  readonly uptimeMs: number | null;
  /** Claim-ы/подписки PM-контроллера. */
  readonly polymarket: PolymarketSubscriptionControllerStats;
  /** Claim-ы/пулы CEX-контроллера. */
  readonly cex: CexSubscriptionControllerStats;
  /** Допуски рынков к записи (universe + policy + claim). */
  readonly gate: PolymarketCollectionGateStats;
  /** Жизненный цикл записей: активные/финализируемые сессии и границы. */
  readonly collection: PolymarketCollectionLifecycleStats;
  /** Post-expiry финализация: pending/official/fallback/discard. */
  readonly finalization: MarketFinalizerStats;
  /** Маршрутизация и запись Polymarket-сообщений. */
  readonly recorder: ExternalMessageRecorderStats;
  /** Маршрутизация и запись CEX-сообщений. */
  readonly recorderCex: ExternalMessageRecorderCexStats;
  /** Завершённые/сбойные партиции CEX-окон. */
  readonly cexWindows: CexWindowRecorderStats;
  /** Очередь и ошибки обработчиков общего bus. */
  readonly bus: MessageBusStats;
  /** Здоровье общего PM-source. */
  readonly polymarketSource: { readonly hasFailed: boolean; readonly isClosed: boolean };
}

/** Один шаг остановки контура. */
interface ShutdownStep {
  readonly name: string;
  readonly run: () => Promise<void>;
}

/**
 * Рантайм сбора: владеет composition, расписанием control-цикла и остановкой.
 *
 * @example
 * ```typescript
 * const { collector } = createDataCollector({ config, logger, clock });
 * await collector.start();
 * // ...
 * await collector.close();
 * ```
 */
export class DataCollector {
  private readonly _components: DataCollectorComponents;
  private readonly _control: ControlRuntimeConfig;
  private readonly _clock: IClock;
  private readonly _logger: ILogger;

  private _state: DataCollectorState = 'idle';
  private _startedAtMs: number | null = null;
  private _tickTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly _activeTicks = new Set<Promise<void>>();
  private _closePromise: Promise<void> | null = null;
  private _startPromise: Promise<void> | null = null;

  /**
   * Создаёт рантайм поверх уже собранных компонентов контура.
   *
   * @param deps - Зависимости (см. {@link DataCollectorDependencies})
   */
  constructor(deps: DataCollectorDependencies) {
    this._components = deps.components;
    this._control = deps.control;
    this._clock = deps.clock;
    this._logger = deps.logger.child({ component: 'DataCollector' });
  }

  /** Текущее состояние рантайма. */
  public get state(): DataCollectorState {
    return this._state;
  }

  /**
   * Поднимает контур: startup cleanup → recorder → control-loop.
   *
   * @returns Promise завершения запуска
   * @throws {Error} При повторном старте, старте после остановки либо отказе
   *   шага запуска (уже поднятые ресурсы к этому моменту закрыты)
   */
  public async start(): Promise<void> {
    if (this._state !== 'idle') {
      throw new Error(`DataCollector.start() rejected: already ${this._state}`);
    }
    this._state = 'starting';
    this._startPromise = this._start();
    return this._startPromise;
  }

  /** Тело запуска (сериализовано с остановкой через `_startPromise`). */
  private async _start(): Promise<void> {
    const rollback: ShutdownStep[] = [];
    try {
      // 1. Startup cleanup незавершённых артефактов прошлого запуска.
      await this._components.polymarketStorage.cleanup();
      await this._components.cexStorage.cleanup();

      // 2. Recorder-first: подписка на bus (и старт CEX-окон) раньше ingress.
      this._components.recorder.start();
      rollback.push({
        name: 'recorder.close',
        run: async () => this._components.recorder.close(),
      });
      rollback.push({
        name: 'finalizer.close',
        run: async () => this._components.finalizer.close(),
      });
      rollback.push({
        name: 'lifecycle.close',
        run: async () => this._components.lifecycle.close(),
      });

      this._startedAtMs = this._nowMs();
      this._state = 'running';
      // 3. Control-loop запускается ПОСЛЕДНИМ: первый тик открывает подписки.
      this._scheduleTick(0);
      this._logger.info('Data collector started', {
        acquireLimit: this._control.acquireLimit,
        controlTickMs: this._control.tickMs,
        polymarketDemands: this._components.polymarketDemands.length,
        cexDemands: this._components.cexDemands.length,
      });
    } catch (error) {
      this._logger.error('Data collector startup failed, rolling back', {
        error: error instanceof Error ? error.message : String(error),
      });
      for (const step of rollback.reverse()) {
        await this._runStep(step);
      }
      await this._runStep({
        name: 'bus.close',
        run: async () => {
          await this._components.bus.close();
        },
      });
      this._state = 'stopped';
      throw error;
    }
  }

  /**
   * Останавливает контур в порядке, обратном запуску (идемпотентен).
   *
   * @returns Promise завершения остановки
   */
  public async close(): Promise<void> {
    if (this._closePromise !== null) {
      return this._closePromise;
    }
    if (this._state === 'idle' || this._state === 'stopped') {
      this._state = 'stopped';
      return;
    }
    this._closePromise = this._closeAfterStart();
    return this._closePromise;
  }

  /** Дожидается незавершённого запуска и только затем гасит контур. */
  private async _closeAfterStart(): Promise<void> {
    if (this._startPromise !== null) {
      await this._startPromise.catch(() => undefined);
    }
    if (this._state === 'stopped') {
      return;
    }
    this._state = 'stopping';
    return this._close();
  }

  /**
   * Возвращает read-only снимок операционного состояния.
   *
   * @returns Текущее состояние рантайма и его компонентов
   */
  public status(): DataCollectorStatus {
    const nowMs = this._nowMs();
    return {
      state: this._state,
      startedAtMs: this._startedAtMs,
      uptimeMs: this._startedAtMs === null ? null : nowMs - this._startedAtMs,
      polymarket: this._components.polymarketController.getStats(),
      cex: this._components.cexController.getStats(),
      gate: this._components.gate.getStats(),
      collection: this._components.lifecycle.getStats(),
      finalization: this._components.finalizer.getStats(),
      recorder: this._components.recorder.getStats(),
      recorderCex: this._components.recorder.getCexStats(),
      cexWindows: this._components.cexStorage.getStats(),
      bus: this._components.bus.getStats(),
      polymarketSource: {
        hasFailed: this._components.polymarketSource.hasFailed,
        isClosed: this._components.polymarketSource.isClosed,
      },
    };
  }

  /**
   * Выполняет один control-тик (публично — для детерминированных тестов).
   *
   * @returns Promise завершения тика
   *
   * @remarks
   * Один тик = один проход спроса и один проход lifecycle:
   *
   * ```text
   * pmControlRuntime.runOnce   приобрести первые кандидаты плана
   * cexController.reconcile    сверить желаемое CEX-состояние
   * lifecycle.runOnce          принять новые записи + safety net истечения
   * finalizer.runOnce          Gamma enrichment замороженных датасетов
   * ```
   *
   * Единый момент решения тика — `ranAt` из отчёта `runOnce` (часы там
   * читаются после обхода каталога), он же уходит в CEX-сверку. Если
   * PM-проход отказал, `ranAt` нет, и CEX-решение принимается по свежим часам.
   *
   * Граница датасета от этого тика НЕ зависит: истечение держит собственный
   * таймер сессии, а `lifecycle.runOnce` здесь — страховка и точка приёма
   * новых recording-сессий. Отказ любого шага не отменяет остальные.
   */
  public async tick(): Promise<void> {
    const running = this._tick();
    this._activeTicks.add(running);
    try {
      await running;
    } finally {
      this._activeTicks.delete(running);
    }
  }

  /** Тело одного control-тика. */
  private async _tick(): Promise<void> {
    // Момент тика берётся из ОТЧЁТА PM-прохода: `runOnce` читает часы сам —
    // уже ПОСЛЕ обхода каталога — и возвращает этот момент как `ranAt`. Именно
    // он и есть единый момент решения тика, который дальше получает CEX.
    //
    // Читать часы здесь, ДО `runOnce`, было бы худшим из вариантов: обход
    // каталога занимает сетевой round-trip, и CEX получал бы момент заведомо
    // старше того, на который планировался Polymarket. Тик не описывал бы ни
    // одного момента — ни общего, ни текущего.
    let ranAt: Timestamp | undefined;
    try {
      const result = await this._components.polymarketControlRuntime.runOnce(
        this._components.polymarketDemands,
      );
      ranAt = result.ranAt;
    } catch (error) {
      this._logger.error('Polymarket control tick failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (this._components.cexDemands.length > 0) {
      try {
        // PM-проход отказал — единого момента тика нет, читаем часы сами:
        // CEX-решение не должно зависеть от доступности Gamma.
        const now = ranAt ?? Timestamp.now(this._clock);
        await this._components.cexController.reconcile(this._components.cexDemands, now);
      } catch (error) {
        this._logger.error('CEX reconcile tick failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      await this._components.lifecycle.runOnce();
    } catch (error) {
      this._logger.error('Collection lifecycle tick failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await this._components.finalizer.runOnce();
    } catch (error) {
      this._logger.error('Finalization tick failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Подписывает наблюдателя на переходы collection lifecycle.
   *
   * @param listener - Слушатель переходов (`STARTED`/`FINALIZING`/`SEALED`/
   *   `COMPLETED`/`DROPPED`)
   * @returns Функция отписки
   *
   * @remarks
   * Passthrough в lifecycle: события эмитит тот, кто переход и совершает,
   * поэтому переход, уместившийся между двумя control-тиками, не теряется.
   * Нужен verification-прогонам (заморозка сэмплов ровно на границе рынка).
   *
   * @example
   * ```typescript
   * collector.onMarketLifecycle((event) => log.push(`${event.kind}:${String(event.marketId)}`));
   * ```
   */
  public onMarketLifecycle(listener: CollectionLifecycleListener): () => void {
    return this._components.lifecycle.onLifecycleEvent(listener);
  }

  /**
   * Graceful wind-down финализаций БЕЗ остановки контура.
   *
   * @returns Promise завершения дренажа
   *
   * @remarks
   * Доводит до конца уже начатые финализации: опрос Gamma продолжается
   * штатным cadence, пока не станет известен официальный итог (или не
   * исчерпается бюджет). Вызывается ПЕРЕД {@link DataCollector.close},
   * когда остановку можно себе позволить подождать; сам `close()` дренаж не
   * навязывает — он прерывает ожидание аварийным best-known путём.
   *
   * Перед дренажем истёкшие сессии переводятся в FINALIZING и их датасеты
   * замораживаются: иначе финализатор дренировал бы неполный набор.
   */
  public async drain(): Promise<void> {
    await this._runStep({
      name: 'lifecycle.runOnce',
      run: async () => this._components.lifecycle.runOnce(),
    });
    await this._runStep({
      name: 'lifecycle.awaitAllSettlementCaptures',
      run: async () => this._components.lifecycle.awaitAllSettlementCaptures(),
    });
    await this._runStep({ name: 'finalizer.drain', run: async () => this._components.finalizer.drain() });
  }

  // ───────────────────────────── Внутреннее ─────────────────────────────

  /** Текущее время в миллисекундах (`IClock` отдаёт `Date`). */
  private _nowMs(): number {
    return this._clock.now().getTime();
  }

  /** Полная лестница остановки контура. */
  private async _close(): Promise<void> {
    this._logger.info('Data collector stopping', { status: this.status() });

    if (this._tickTimer !== null) {
      clearTimeout(this._tickTimer);
      this._tickTimer = null;
    }
    while (this._activeTicks.size > 0) {
      await Promise.allSettled([...this._activeTicks]);
    }

    const steps: ShutdownStep[] = [
      // 1. Доводим до конца УЖЕ начатые записи. Истёкшие сессии входят в
      // FINALIZING, их датасеты замораживаются, claim-ы снимаются — только
      // после этого имеет смысл дренировать финализатор.
      { name: 'lifecycle.runOnce', run: async () => this._components.lifecycle.runOnce() },
      {
        name: 'lifecycle.awaitAllSettlementCaptures',
        run: async () => this._components.lifecycle.awaitAllSettlementCaptures(),
      },
      { name: 'finalizer.drain', run: async () => this._components.finalizer.drain() },
      // 2. Финализатор закрывается: официальный итог → архив, иначе
      // deterministic fallback, иначе discard (собственная policy пакета).
      { name: 'finalizer.close', run: async () => this._components.finalizer.close() },
      // 3. Оставшиеся ACTIVE-сессии (рынок ещё не истёк) закрываются как
      // SHUTDOWN — незавершённый датасет удаляет storage; их claim-ы снимаются.
      { name: 'lifecycle.close', run: async () => this._components.lifecycle.close() },
      // 4. Снимаем спрос-владение: CEX-контроллер закрывает СВОИ источники,
      // PM-контроллер снимает claim-ы и RTDS-ссылки (source он НЕ закрывает).
      { name: 'cexController.close', run: async () => this._components.cexController.close() },
      { name: 'polymarketController.close', run: async () => this._components.polymarketController.close() },
      // 5. Затем общий PM source (принадлежит контуру) и его shared realtime.
      { name: 'polymarketSource.close', run: async () => this._components.polymarketSource.close() },
      {
        name: 'polymarketClient.closeSubscriptions',
        run: async () => this._components.polymarketClient.closeSubscriptions(),
      },
      // 6. Дренаж очереди В recorder, затем закрытие recorder и самой шины.
      {
        name: 'bus.drain',
        run: async () => {
          const drained = await this._components.bus.drain();
          if (!drained.ok) {
            throw new Error(`bus.drain rejected: ${drained.error.message}`);
          }
        },
      },
      { name: 'recorder.close', run: async () => this._components.recorder.close() },
      {
        name: 'bus.close',
        run: async () => {
          const closed = await this._components.bus.close();
          if (!closed.ok) {
            throw new Error(`bus.close rejected: ${closed.error.message}`);
          }
        },
      },
    ];

    for (const step of steps) {
      await this._runStep(step);
    }

    this._state = 'stopped';
    this._logger.info('Data collector stopped');
  }

  /** Выполняет шаг остановки, поглощая и логируя его отказ. */
  private async _runStep(step: ShutdownStep): Promise<void> {
    try {
      await step.run();
    } catch (error) {
      this._logger.error('Shutdown step failed, continuing', {
        step: step.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Планирует следующий тик (пауза ОТСЧИТЫВАЕТСЯ ПОСЛЕ завершения текущего). */
  private _scheduleTick(delayMs: number): void {
    if (this._state !== 'running') {
      return;
    }
    this._tickTimer = setTimeout(() => {
      this._tickTimer = null;
      if (this._state !== 'running') {
        return;
      }
      void this.tick()
        .catch((error: unknown) => {
          this._logger.error('Control tick failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this._scheduleTick(this._control.tickMs);
        });
    }, delayMs);
    // Таймер тика СОЗНАТЕЛЬНО не `unref`-ится: это сердцебиение рантайма, и
    // пока контур работает, оно обязано удерживать процесс живым.
    //
    // Все остальные таймеры контура (flush storage, окна CEX, expiry сессий,
    // печать статуса) `unref`-нуты — правильно, они не должны мешать
    // завершению. Но если `unref`-нуть И этот, живых хэндлов у процесса не
    // остаётся вовсе: первый тик планируется ДО того, как открыта хоть одна
    // подписка, и Node выходит с кодом 13 («unsettled top-level await»),
    // не успев его выполнить. Под `tsx` это было незаметно — его загрузчик
    // держал event loop за нас, — и проявилось только при запуске из `dist`.
    //
    // Остановке таймер не мешает: `_close()` снимает его явно.
  }
}
