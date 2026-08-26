/**
 * Production-рантайм сбора сырых рыночных данных.
 *
 * @remarks
 * ### Контур
 *
 * ```text
 * PolymarketSource ─┐
 * (market + RTDS)   │
 *                   ├──► ОДИН ExternalMessageBus ──┬──► ExternalMessageRecorder ──► JSONL
 * CexSource[] ──────┘                              │      (PM-политика + CEX-политика)
 * (orderbook+trades)                               └──► любой другой consumer
 *                                                       (checkpoint-наблюдатель,
 *                                                        будущий Semantic Adapter)
 * ```
 *
 * Composition/lifecycle/расписание/операционное состояние — ответственность
 * этого класса. Semantic-конверсии, Domain-концептов, стратегий, риска,
 * исполнения и позиций здесь нет и быть не может: `DataCollector` живёт
 * строго ДО semantic boundary.
 *
 * ### Владение bus
 *
 * Bus передаётся снаружи (создаётся composition factory) и НЕ замурован
 * внутри: любой consumer подписывается на него ДО `start()` и получает те же
 * сообщения, что и recorder. Обратной зависимости нет — consumer знает про
 * bus, а не про `DataCollector`.
 *
 * ### Порядок старта (recorder-first)
 *
 * ```text
 * startup cleanup → recorder.start() → CEX sources → runtime loop
 * ```
 *
 * Ingress не начинается, пока recorder не подписан: иначе первые сообщения
 * ушли бы в bus без записи. Отказ на любом шаге откатывает уже поднятые
 * ресурсы и отклоняет `start()`.
 *
 * ### Порядок остановки
 *
 * ```text
 * runtime loop → finalizer → coordinator → PM source → CEX sources
 *              → bus.drain() → recorder.close() → bus.close()
 * ```
 *
 * Сначала прекращается ingress, затем очередь bus дренируется В recorder, и
 * только потом закрывается сам recorder — иначе последние сообщения были бы
 * потеряны. Каждый шаг best-effort: отказ одного не отменяет остальные.
 */
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import type { Result } from '@polymarket/result';
import type { MessageBusDrainError, MessageBusStats } from '@polymarket/message-bus';
import type { createPublicClient } from '@polymarket/client';
import type { CexSource, CexSourceStats } from '@polymarket/cex-v2';
import type { CexWindowRecorder, DataRecorder } from '@polymarket/data-collection';
import type { CexWindowRecorderStats } from '@polymarket/data-collection';
import type {
  PolymarketDiscoveredMarket,
  PolymarketSource,
  PolymarketTwapObservations,
  PolymarketTwapObservationsStats,
} from '@polymarket/polymarket-v2';
import type { ExternalMessageRecorder } from '@polymarket/external-message-recorder';
import type {
  ExternalMessageRecorderCexStats,
  ExternalMessageRecorderStats,
} from '@polymarket/external-message-recorder';
import type {
  CollectionCoordinatorStats,
  MarketCollectionCoordinator,
} from '@polymarket/collection-coordinator';
import type { MarketFinalizer, MarketFinalizerStats } from '@polymarket/market-finalizer';
import type { CollectionRuntimeConfig } from './DataCollectorConfig.js';
import type {
  CollectionLifecycleCounts,
  CollectionLifecycleEvent,
  CollectionLifecycleListener,
} from './collectionLifecycle.js';
import { CollectionLifecycleProjection } from './collectionLifecycle.js';

// ───────────────────────────── Порты компонентов ─────────────────────────────

/**
 * Порт общего bus, используемый рантаймом.
 *
 * @remarks
 * Рантайм НЕ публикует в bus (это делают sources) и НЕ подписывается на него
 * (это делают recorder и внешние consumer-ы) — только дренирует и закрывает
 * его при остановке контура. Узкий порт делает это ограничение
 * проверяемым типами: подписаться через него нельзя.
 */
export interface CollectorBus {
  /** Дренирует очередь доставки в уже подписанных consumer-ов. */
  drain(): Promise<Result<void, MessageBusDrainError>>;
  /** Закрывает контур доставки (после дренажа). */
  close(): Promise<Result<void, MessageBusDrainError>>;
  /** Снимок очереди и ошибок обработчиков. */
  getStats(): MessageBusStats;
}

/** Порт recording-подписчика bus. */
export type CollectorRecorder = Pick<
  ExternalMessageRecorder,
  'start' | 'close' | 'getStats' | 'getCexStats'
>;

/** Порт storage-политики Polymarket (startup cleanup). */
export type CollectorPolymarketStorage = Pick<DataRecorder, 'cleanup'>;

/** Порт storage-политики CEX-окон (startup cleanup + статистика партиций). */
export type CollectorCexStorage = Pick<CexWindowRecorder, 'cleanup' | 'getStats'>;

/** Порт Polymarket-source (закрытие + health-сигнал). */
export type CollectorPolymarketSource = Pick<PolymarketSource, 'close' | 'hasFailed' | 'isClosed'>;

/**
 * Порт официального SDK-клиента в части ЕГО собственных ресурсов.
 *
 * @remarks
 * Клиент разделяется между source, discovery и finalizer, но принадлежит не им,
 * а контуру: shared realtime-соединения открывает и держит сам клиент, и
 * закрыть их может только он. Без этого порта закрытие source снимало бы
 * только его подписки, а транспорт под ними оставался бы жив — процесс не
 * завершался бы сам после остановки.
 */
export type CollectorPolymarketClient = Pick<
  ReturnType<typeof createPublicClient>,
  'closeSubscriptions'
>;

/** Порт одного CEX-source. */
export type CollectorCexSource = Pick<
  CexSource,
  'start' | 'close' | 'getStats' | 'hasFailed' | 'isRunning'
>;

/**
 * CEX-source вместе со своей биржей.
 *
 * @remarks
 * `CexSource` не публикует собственную конфигурацию, а операционный статус
 * обязан называть биржу, а не индекс в массиве — поэтому идентификатор
 * переносится рядом с source-ом на этапе сборки контура.
 */
export interface CollectorCexSourceEntry {
  /** Идентификатор биржи в терминах CCXT (`binance`, `okx`, ...). */
  readonly exchangeId: string;
  /** Сам source. */
  readonly source: CollectorCexSource;
}

/**
 * Кандидат Discovery в объёме, который читает рантайм.
 *
 * @remarks
 * Рантайм не участвует в отборе рынков (это работа координатора) и берёт из
 * кандидата только identity/вопрос/истечение — ровно то, что уходит в событие
 * `DISCOVERED`. Порт объявляет именно этот минимум: требовать полный
 * `PolymarketDiscoveredMarket` значило бы заставлять любую альтернативную
 * реализацию (и тесты) выдумывать восемь полей, которые никто не читает.
 */
export type CollectorCandidate = Pick<
  PolymarketDiscoveredMarket,
  'marketId' | 'question' | 'expiresAt'
>;

/**
 * Порт Discovery (чтение кэша кандидатов для проекции lifecycle).
 *
 * @remarks
 * Реальный `PolymarketMarketDiscovery` удовлетворяет порту без адаптеров:
 * его `findCandidates()` возвращает более широкий тип, что для возвращаемого
 * значения допустимо.
 */
export interface CollectorDiscovery {
  /** Текущее содержимое кэша кандидатов. */
  findCandidates(): Promise<readonly CollectorCandidate[]>;
}

/** Порт координатора collection-сессий. */
export type CollectorCoordinator = Pick<
  MarketCollectionCoordinator,
  'refreshCandidates' | 'fillSlots' | 'listSessions' | 'getStats' | 'close'
>;

/** Порт финализатора post-expiry датасетов. */
export type CollectorFinalizer = Pick<MarketFinalizer, 'runOnce' | 'drain' | 'getStats' | 'close'>;

/**
 * Порт наблюдателя settlement-потока TWAP.
 *
 * @remarks
 * Рантайм не спрашивает у него наблюдений — он владеет только его
 * lifecycle: наблюдатель обязан быть подписан ДО начала ingress (как и
 * recorder) и отписан после дренажа bus.
 */
export type CollectorTwapObservations = Pick<
  PolymarketTwapObservations,
  'start' | 'close' | 'getStats'
>;

/**
 * Уже собранные компоненты контура, чьим lifecycle владеет рантайм.
 *
 * @remarks
 * Разделение «сборка ↔ владение» намеренное: production-composition делает
 * {@link createDataCollector}, а тесты подставляют fake-компоненты и
 * проверяют поведение рантайма без сети, дисков и CCXT.
 */
export interface DataCollectorComponents {
  readonly bus: CollectorBus;
  readonly recorder: CollectorRecorder;
  readonly polymarketStorage: CollectorPolymarketStorage;
  readonly cexStorage: CollectorCexStorage;
  readonly polymarketSource: CollectorPolymarketSource;
  /** SDK-клиент, разделяемый source/discovery/finalizer (его realtime — за контуром). */
  readonly polymarketClient: CollectorPolymarketClient;
  readonly cexSources: readonly CollectorCexSourceEntry[];
  readonly discovery: CollectorDiscovery;
  readonly coordinator: CollectorCoordinator;
  readonly finalizer: CollectorFinalizer;
  readonly twapObservations: CollectorTwapObservations;
}

/** Зависимости {@link DataCollector}. */
export interface DataCollectorDependencies {
  /** Компоненты контура (см. {@link DataCollectorComponents}). */
  readonly components: DataCollectorComponents;
  /** Параметры collection-цикла. */
  readonly collection: CollectionRuntimeConfig;
  /** Источник времени (DI — детерминизм в тестах). */
  readonly clock: IClock;
  /** Логгер (будет обёрнут в child с component-контекстом). */
  readonly logger: ILogger;
}

// ──────────────────────────── Операционный статус ────────────────────────────

/** Состояние рантайма. */
export type DataCollectorState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';

/** Здоровье одного CEX-source. */
export interface CexSourceHealth {
  readonly exchangeId: string;
  readonly isRunning: boolean;
  readonly hasFailed: boolean;
  readonly stats: CexSourceStats;
}

/**
 * Read-only снимок операционного состояния рантайма.
 *
 * @remarks
 * Все поля — уже существующие `getStats()` компонентов; собственных метрик
 * рантайм не заводит (MR-A PART 20 — переиспользовать, а не дублировать).
 */
export interface DataCollectorStatus {
  readonly state: DataCollectorState;
  /** Момент успешного `start()` (ms) либо `null`. */
  readonly startedAtMs: number | null;
  /** Время работы с момента старта (ms) либо `null`. */
  readonly uptimeMs: number | null;
  /** Сессии/слоты/RTDS-фиды координатора. */
  readonly collection: CollectionCoordinatorStats;
  /** Pending/архивированные/отказавшие финализации. */
  readonly finalization: MarketFinalizerStats;
  /** Маршрутизация и запись Polymarket-сообщений. */
  readonly recorder: ExternalMessageRecorderStats;
  /** Маршрутизация и запись CEX-сообщений. */
  readonly recorderCex: ExternalMessageRecorderCexStats;
  /** Завершённые/сбойные партиции CEX-окон. */
  readonly cexWindows: CexWindowRecorderStats;
  /** Принятые наблюдения официального settlement-потока TWAP. */
  readonly twap: PolymarketTwapObservationsStats;
  /** Очередь и ошибки обработчиков общего bus. */
  readonly bus: MessageBusStats;
  /** Здоровье ingress-source-ов. */
  readonly sources: {
    readonly polymarket: { readonly hasFailed: boolean; readonly isClosed: boolean };
    readonly cex: readonly CexSourceHealth[];
  };
  /** Накопленные счётчики наблюдённых lifecycle-переходов. */
  readonly lifecycle: CollectionLifecycleCounts;
}

/** Один шаг остановки контура. */
interface ShutdownStep {
  readonly name: string;
  readonly run: () => Promise<void>;
}

/**
 * Рантайм сбора: владеет composition, lifecycle источников и коллекции,
 * расписанием и операционным состоянием.
 *
 * @example
 * ```typescript
 * const collector = createDataCollector({ config, logger, clock });
 * collector.onMarketLifecycle((event) => metrics.record(event));
 * await collector.start();
 * // ...
 * await collector.close();
 * ```
 */
export class DataCollector {
  private readonly _components: DataCollectorComponents;
  private readonly _collection: CollectionRuntimeConfig;
  private readonly _clock: IClock;
  private readonly _logger: ILogger;
  private readonly _lifecycle = new CollectionLifecycleProjection();
  private readonly _listeners = new Set<CollectionLifecycleListener>();

  private _state: DataCollectorState = 'idle';
  private _startedAtMs: number | null = null;
  private _tickTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * ВСЕ идущие сейчас тики — остановка дожидается каждого.
   *
   * @remarks
   * Именно множество, а не «текущий тик»: планировщик запускает следующий проход
   * только после завершения предыдущего, но `tick()` публичен, и прямой вызов
   * может перекрыться с проходом цикла. При хранении одной ссылки второй тик
   * затирал бы первый, и остановка закрывала бы координатор с финализатором
   * прямо под работающим тиком.
   */
  private readonly _activeTicks = new Set<Promise<void>>();
  private _lastRefreshMs = 0;
  private _closePromise: Promise<void> | null = null;
  /** Незавершённый запуск (остановка ждёт его, чтобы не гасить контур на подъёме). */
  private _startPromise: Promise<void> | null = null;

  /**
   * Создаёт рантайм поверх уже собранных компонентов контура.
   *
   * @param deps - Зависимости (см. {@link DataCollectorDependencies})
   */
  constructor(deps: DataCollectorDependencies) {
    this._components = deps.components;
    this._collection = deps.collection;
    this._clock = deps.clock;
    this._logger = deps.logger.child({ component: 'DataCollector' });
  }

  /** Текущее состояние рантайма. */
  public get state(): DataCollectorState {
    return this._state;
  }

  /**
   * Подписывает read-only наблюдателя collection lifecycle.
   *
   * @param listener - Обработчик события (исключения поглощаются и логируются)
   * @returns Функция отписки
   *
   * @remarks
   * Наблюдатель не влияет на сбор: он вызывается синхронно после того, как
   * переход уже произошёл, а его отказ не прерывает тик рантайма.
   *
   * @example
   * ```typescript
   * const off = collector.onMarketLifecycle((event) => {
   *   if (event.kind === 'FINALIZED') archived.push(String(event.marketId));
   * });
   * ```
   */
  public onMarketLifecycle(listener: CollectionLifecycleListener): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  /**
   * Поднимает контур: startup cleanup → recorder → ingress → runtime loop.
   *
   * @returns Promise завершения запуска
   * @throws {Error} При повторном старте, старте после остановки либо отказе
   *   любого шага запуска (уже поднятые ресурсы к этому моменту закрыты)
   *
   * @remarks
   * Recorder подписывается на bus ДО старта источников — иначе первые
   * сообщения пришли бы в bus без записи. Частичный отказ откатывается
   * полностью: контур либо работает целиком, либо не оставляет за собой
   * ни открытых потоков, ни таймеров.
   */
  public async start(): Promise<void> {
    if (this._state !== 'idle') {
      throw new Error(`DataCollector.start() rejected: already ${this._state}`);
    }
    this._state = 'starting';
    // Запуск асинхронен, а остановка может прийти в любой момент — например,
    // сигнал во время startup cleanup. Чтобы обе операции не работали с одними
    // компонентами одновременно, close() дожидается ЭТОГО promise (см. close()).
    this._startPromise = this._start();
    return this._startPromise;
  }

  /** Тело запуска (сериализовано с остановкой через `_startPromise`). */
  private async _start(): Promise<void> {
    /** Обратные шаги уже поднятых ресурсов (LIFO при откате). */
    const rollback: ShutdownStep[] = [];
    try {
      // 1. Startup cleanup: незавершённые артефакты прошлого запуска не
      //    подлежат восстановлению и должны исчезнуть ДО новых записей.
      await this._components.polymarketStorage.cleanup();
      await this._components.cexStorage.cleanup();

      // 2. Recorder-first: подписка на bus раньше любого ingress.
      this._components.recorder.start();
      rollback.push({
        name: 'recorder.close',
        run: async () => this._components.recorder.close(),
      });

      // 2a. Наблюдатель settlement-потока — тоже ДО ingress: без него первые
      //     наблюдения TWAP прошли бы мимо, и boundary grace рынка,
      //     истёкшего сразу после старта, выродился бы в полное ожидание.
      this._components.twapObservations.start();
      rollback.push({
        name: 'twapObservations.close',
        run: async () => {
          this._components.twapObservations.close();
        },
      });

      // 3. Ingress: CEX-потоки (Polymarket-подписки открывает координатор
      //    по мере выбора рынков).
      for (const entry of this._components.cexSources) {
        entry.source.start();
        rollback.push({
          name: `cexSource.close(${entry.exchangeId})`,
          run: async () => entry.source.close(),
        });
      }

      this._startedAtMs = this._nowMs();
      this._state = 'running';
      // Цикл запускается ПОСЛЕДНИМ и только после перехода в running: тик,
      // стартовавший раньше, работал бы с ещё не поднятым контуром.
      this._scheduleTick(0);
      this._logger.info('Data collector started', {
        cexSources: this._components.cexSources.length,
        maxMarkets: this._collection.maxMarkets,
        discoveryRefreshMs: this._collection.discoveryRefreshMs,
        runtimeTickMs: this._collection.runtimeTickMs,
      });
    } catch (error) {
      this._logger.error('Data collector startup failed, rolling back', {
        error: error instanceof Error ? error.message : String(error),
      });
      for (const step of rollback.reverse()) {
        await this._runStep(step);
      }
      // Bus закрывается вместе с откатом: контур не поднялся, и оставлять
      // его открытым означало бы удерживать процесс живым без сбора.
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
   * Дожидается официальной резолюции уже начатых финализаций.
   *
   * @returns Promise завершения дренажа
   *
   * @remarks
   * Опциональный graceful wind-down ПЕРЕД {@link DataCollector.close}: без
   * него остановка обрывает окно ожидания официальной резолюции, и рынки
   * архивируются как `timeout`. Штатный shutdown по сигналу его НЕ вызывает
   * — ожидание измеряется десятками минут и не укладывается в
   * `kill_timeout` супервизора; вызов уместен для контролируемых прогонов.
   */
  public async drain(): Promise<void> {
    if (this._state !== 'running') {
      return;
    }
    this._logger.info('Draining pending finalizations', {
      finalizer: this._components.finalizer.getStats(),
    });
    await this._components.finalizer.drain();
    this._logger.info('Finalization drain finished', {
      finalizer: this._components.finalizer.getStats(),
    });
  }

  /**
   * Останавливает контур в порядке, обратном запуску.
   *
   * @returns Promise завершения остановки (идемпотентен)
   *
   * @remarks
   * Идемпотентен: повторный вызов возвращает тот же Promise, а вызов до
   * запуска — no-op. Ни один шаг не прерывает остальные: отказ логируется, и
   * закрытие продолжается — иначе одна сбойная подсистема оставила бы
   * открытыми потоки, таймеры и файловые дескрипторы остальных.
   * `process.exit()` здесь не используется: он замаскировал бы дефекты
   * lifecycle вместо их устранения.
   */
  public async close(): Promise<void> {
    if (this._closePromise !== null) {
      return this._closePromise;
    }
    // Ни разу не запускавшийся и уже остановленный рантайм закрывать нечем.
    // Второй случай — не теоретический: неудавшийся start() уже откатил всё,
    // что успел поднять, и повторная лестница закрыла бы ресурсы дважды.
    if (this._state === 'idle' || this._state === 'stopped') {
      this._state = 'stopped';
      return;
    }
    this._closePromise = this._closeAfterStart();
    return this._closePromise;
  }

  /**
   * Дожидается незавершённого запуска и только затем гасит контур.
   *
   * @remarks
   * Без этого ожидания сигнал, пришедший во время `start()`, запустил бы
   * лестницу остановки ПАРАЛЛЕЛЬНО подъёму: запуск продолжил бы поднимать
   * source-ы уже после того, как остановка их «закрыла», и процесс остался бы
   * с работающим ingress без recorder-а.
   */
  private async _closeAfterStart(): Promise<void> {
    if (this._startPromise !== null) {
      // Отказ запуска уже обработан внутри start(): он откатил поднятое и
      // перевёл рантайм в stopped — здесь важен только факт завершения.
      await this._startPromise.catch(() => undefined);
    }
    if (this._state === 'stopped') {
      return; // запуск не удался и полностью откатился
    }
    this._state = 'stopping';
    return this._close();
  }

  /**
   * Возвращает read-only снимок операционного состояния.
   *
   * @returns Текущее состояние рантайма и его компонентов
   *
   * @example
   * ```typescript
   * const status = collector.status();
   * logger.info('Collector status', { active: status.collection.activeSessions });
   * ```
   */
  public status(): DataCollectorStatus {
    const nowMs = this._nowMs();
    return {
      state: this._state,
      startedAtMs: this._startedAtMs,
      uptimeMs: this._startedAtMs === null ? null : nowMs - this._startedAtMs,
      collection: this._components.coordinator.getStats(),
      finalization: this._components.finalizer.getStats(),
      recorder: this._components.recorder.getStats(),
      recorderCex: this._components.recorder.getCexStats(),
      cexWindows: this._components.cexStorage.getStats(),
      twap: this._components.twapObservations.getStats(),
      bus: this._components.bus.getStats(),
      sources: {
        polymarket: {
          hasFailed: this._components.polymarketSource.hasFailed,
          isClosed: this._components.polymarketSource.isClosed,
        },
        cex: this._components.cexSources.map((entry) => ({
          exchangeId: entry.exchangeId,
          isRunning: entry.source.isRunning,
          hasFailed: entry.source.hasFailed,
          stats: entry.source.getStats(),
        })),
      },
      lifecycle: this._lifecycle.getCounts(),
    };
  }

  /**
   * Выполняет один тик runtime-цикла (публично — для детерминированных тестов).
   *
   * @returns Promise завершения тика
   *
   * @remarks
   * Тик оркестрирует владельцев состояния и НЕ содержит собственного:
   * ни карт подписок, ни blacklist-ов, ни очереди обогащения — всем этим
   * владеют Discovery, Coordinator и Finalizer.
   */
  public async tick(): Promise<void> {
    // Тик регистрирует себя САМ, а не планировщик: остановка обязана дожидаться
    // любого идущего тика — и запущенного циклом, и вызванного напрямую.
    const running = this._tick();
    this._activeTicks.add(running);
    try {
      await running;
    } finally {
      this._activeTicks.delete(running);
    }
  }

  /** Тело одного тика. */
  private async _tick(): Promise<void> {
    const nowMs = this._nowMs();
    if (nowMs - this._lastRefreshMs >= this._collection.discoveryRefreshMs) {
      this._lastRefreshMs = nowMs;
      await this._components.coordinator.refreshCandidates();
      await this._projectCandidates();
    }
    await this._components.coordinator.fillSlots();
    await this._components.finalizer.runOnce();
    this._projectSessions();
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
    // Тики могли остаться в полёте: их шаги трогают те же координатор и
    // финализатор, что и лестница закрытия. Цикл — на случай, если тик успел
    // стартовать, пока мы дожидались предыдущих; новых проходов планировщик уже
    // не создаёт (состояние больше не `running`), поэтому ожидание конечно.
    while (this._activeTicks.size > 0) {
      await Promise.allSettled([...this._activeTicks]);
    }

    const cexSources = this._components.cexSources;
    const steps: ShutdownStep[] = [
      { name: 'finalizer.close', run: async () => this._components.finalizer.close() },
      { name: 'coordinator.close', run: async () => this._components.coordinator.close() },
      { name: 'polymarketSource.close', run: async () => this._components.polymarketSource.close() },
      // Подписки source сняты — теперь можно закрыть shared realtime-транспорт,
      // которым владеет сам клиент. Раньше нельзя: он общий для source,
      // discovery и finalizer, а координатор к этому моменту уже закрыт.
      {
        name: 'polymarketClient.closeSubscriptions',
        run: async () => this._components.polymarketClient.closeSubscriptions(),
      },
      {
        name: 'cexSources.close',
        run: async () => {
          const results = await Promise.allSettled(
            cexSources.map(async (entry) => entry.source.close()),
          );
          const failed = results.filter((result) => result.status === 'rejected');
          if (failed.length > 0) {
            throw new Error(`${String(failed.length)} CEX source(s) failed to close`);
          }
        },
      },
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
        name: 'twapObservations.close',
        run: async () => {
          this._components.twapObservations.close();
        },
      },
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

    // Финальная проекция: сессии, снятые закрытием координатора, наблюдаемы
    // как DROPPED — наблюдатель видит полный lifecycle, а не обрыв.
    this._projectSessions();
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
      // Регистрацию in-flight делает сам tick(); здесь остаётся только
      // проглотить отказ и запланировать следующий проход.
      void this.tick()
        .catch((error: unknown) => {
          this._logger.error('Runtime tick failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this._scheduleTick(this._collection.runtimeTickMs);
        });
    }, delayMs);
    this._tickTimer.unref?.();
  }

  /** Проецирует свежий candidate cache в события DISCOVERED. */
  private async _projectCandidates(): Promise<void> {
    if (this._listeners.size === 0) {
      return; // никто не наблюдает — не читаем кэш
    }
    try {
      const candidates = await this._components.discovery.findCandidates();
      this._emit(this._lifecycle.observeCandidates(candidates, this._nowMs()));
    } catch (error) {
      this._logger.debug('Lifecycle candidate projection skipped', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Проецирует текущие сессии координатора в события переходов. */
  private _projectSessions(): void {
    const events = this._lifecycle.observeSessions(
      this._components.coordinator.listSessions(),
      this._components.finalizer.getStats(),
      this._nowMs(),
      // Отбрасывание считается следствием остановки только когда она идёт:
      // на `idle` рантайме (детерминированный `tick()` в тестах) причина —
      // реконсиляция состояния, а не shutdown.
      { shuttingDown: this._state === 'stopping' || this._state === 'stopped' },
    );
    this._emit(events);
  }

  /** Рассылает события наблюдателям и пишет их в operational-лог. */
  private _emit(events: readonly CollectionLifecycleEvent[]): void {
    for (const event of events) {
      this._logMarketLifecycle(event);
      for (const listener of this._listeners) {
        try {
          listener(event);
        } catch (error) {
          this._logger.warn('Lifecycle listener threw, ignoring', {
            kind: event.kind,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  /** Пишет lifecycle-переход в operational-лог. */
  private _logMarketLifecycle(event: CollectionLifecycleEvent): void {
    const context: Record<string, unknown> = { marketId: String(event.marketId) };
    if (event.question !== undefined) context['question'] = event.question;
    if (event.expiresAtMs !== undefined) {
      context['expiresAt'] = new Date(event.expiresAtMs).toISOString();
    }
    if (event.outcome !== undefined) context['outcome'] = event.outcome;
    if (event.reason !== undefined) context['reason'] = event.reason;

    switch (event.kind) {
      case 'DISCOVERED':
        this._logger.debug('Market discovered', context);
        break;
      case 'COLLECTION_STARTED':
        this._logger.info('Market collection started', context);
        break;
      case 'FINALIZING':
        this._logger.info('Market expired, finalizing', context);
        break;
      case 'FINALIZED':
        this._logger.info('Market finalization finished', context);
        break;
      case 'DROPPED':
        this._logger.warn('Market collection dropped', context);
        break;
    }
  }

}
