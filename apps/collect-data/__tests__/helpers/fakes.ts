/**
 * Тестовые fakes компонентов контура сбора (после Collector-cutover).
 *
 * @remarks
 * Узкие структурные реализации портов `DataCollector`: фиксируют порядок
 * вызовов и позволяют программировать отказы, не поднимая ни сети, ни CCXT,
 * ни диска. Поведение самих компонентов проверяется тестами их пакетов —
 * здесь проверяется РАНТАЙМ: порядок запуска, откат, лестница остановки,
 * control-тик и операционный статус.
 */
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import type { MessageBusDrainError, MessageBusStats } from '@polymarket/message-bus';
import type { Result } from '@polymarket/result';
import { Err, Ok } from '@polymarket/result';
import { TimestampService } from '@polymarket/timestamp';
import type { Timestamp } from '@polymarket/timestamp';
import type {
  ExternalMessageRecorderCexStats,
  ExternalMessageRecorderStats,
} from '@polymarket/external-message-recorder';
import type { CexWindowRecorderStats } from '@polymarket/data-collection';
import type { PolymarketSubscriptionControllerStats } from '@polymarket/polymarket-subscription-control';
import type {
  CexSubscriptionControllerStats,
  CexSubscriptionDemand,
  CexSubscriptionReconcileResult,
} from '@polymarket/cex-subscription-control';
import type {
  PolymarketControlRuntimeResult,
  PolymarketSubscriptionDemand,
} from '@polymarket/polymarket-control-runtime';
import type {
  PolymarketCollectionGateStats,
  PolymarketCollectionLifecycleStats,
} from '@polymarket/collector';
import type { MarketFinalizerStats } from '@polymarket/market-finalizer';
import type {
  CollectorBus,
  CollectorCexController,
  CollectorCexStorage,
  CollectorFinalizer,
  CollectorGate,
  CollectorLifecycle,
  CollectorPolymarketClient,
  CollectorPolymarketController,
  CollectorPolymarketControlRuntime,
  CollectorPolymarketSource,
  CollectorPolymarketStorage,
  CollectorRecorder,
  DataCollectorComponents,
} from '../../src/runtime/DataCollector.js';

/** Общий журнал вызовов: доказывает ПОРЯДОК запуска и остановки. */
export class CallLog {
  public readonly calls: string[] = [];

  public record(name: string): void {
    this.calls.push(name);
  }

  /** Очищает журнал (изоляция ПОРЯДКА внутри одного тика от старта). */
  public clear(): void {
    this.calls.length = 0;
  }

  /** Индекс первого вызова; отсутствие вызова — ошибка теста (не -1). */
  public orderOf(name: string): number {
    const index = this.calls.indexOf(name);
    if (index === -1) {
      throw new Error(`Expected call "${name}" was never recorded. Calls: [${this.calls.join(', ')}]`);
    }
    return index;
  }
}

/** Управляемые часы: `now` фиксирован и настраивается. */
export class FakeClock implements IClock {
  public constructor(private _nowMs = Date.parse('2026-09-01T18:00:00.000Z')) {}

  public now(): Date {
    return new Date(this._nowMs);
  }

  public setNow(ms: number): void {
    this._nowMs = ms;
  }
}

/** Захваченная строка лога. */
export interface LoggedLine {
  readonly level: string;
  readonly message: string;
  readonly context?: Record<string, unknown>;
}

/** ILogger, копящий записи в память. */
export class CapturingLogger implements ILogger {
  public readonly lines: LoggedLine[] = [];

  public trace(message: string, context?: Record<string, unknown>): void {
    this.lines.push({ level: 'trace', message, context });
  }
  public debug(message: string, context?: Record<string, unknown>): void {
    this.lines.push({ level: 'debug', message, context });
  }
  public info(message: string, context?: Record<string, unknown>): void {
    this.lines.push({ level: 'info', message, context });
  }
  public warn(message: string, context?: Record<string, unknown>): void {
    this.lines.push({ level: 'warn', message, context });
  }
  public error(message: string, context?: Record<string, unknown>): void {
    this.lines.push({ level: 'error', message, context });
  }
  public fatal(message: string, context?: Record<string, unknown>): void {
    this.lines.push({ level: 'fatal', message, context });
  }
  public child(_bindings: Record<string, unknown>): ILogger {
    return this;
  }
}

const OK_VOID: Result<void, MessageBusDrainError> = Ok(undefined);

const EMPTY_BUS_STATS: MessageBusStats = {
  queueSize: 0,
  subscribedTypes: 0,
  dispatching: false,
  closed: false,
  publishedTotal: 0,
  dispatchedTotal: 0,
  handlerErrorsTotal: 0,
  rejectedPublicationsTotal: 0,
};

/** Порт общего bus: фиксирует drain/close, отказы программируются. */
export class FakeBus implements CollectorBus {
  public drainFailure: MessageBusDrainError | undefined;
  public closeFailure: MessageBusDrainError | undefined;

  public constructor(private readonly _log: CallLog) {}

  public async drain(): Promise<Result<void, MessageBusDrainError>> {
    this._log.record('bus.drain');
    return this.drainFailure !== undefined ? Err(this.drainFailure) : OK_VOID;
  }
  public async close(): Promise<Result<void, MessageBusDrainError>> {
    this._log.record('bus.close');
    return this.closeFailure !== undefined ? Err(this.closeFailure) : OK_VOID;
  }
  public getStats(): MessageBusStats {
    return EMPTY_BUS_STATS;
  }
}

const EMPTY_RECORDER_STATS: ExternalMessageRecorderStats = {
  marketMessagesRouted: 0,
  rtdsMessagesRouted: 0,
  recordsWritten: 0,
  recordsSkippedInactive: 0,
  serializationFailures: 0,
  registrationFailures: 0,
  unroutedMarketMessages: 0,
  marketSessionsAdmitted: 0,
  marketMessagesIgnoredByPolicy: 0,
  marketMessagesDroppedAfterExpiry: 0,
  marketMessagesDroppedAfterSeal: 0,
  unroutedRtdsMessages: 0,
  handlerErrors: 0,
};

const EMPTY_RECORDER_CEX_STATS: ExternalMessageRecorderCexStats = {
  cexMessagesRouted: 0,
  cexRecordsAccepted: 0,
  cexRecordsDroppedInactive: 0,
  cexRecordsDroppedLate: 0,
  cexWriteFailures: 0,
  cexHandlerErrors: 0,
};

/** Порт recording-подписчика: start/close, отказ старта программируется. */
export class FakeRecorder implements CollectorRecorder {
  public startFailure: Error | undefined;
  public startCalls = 0;
  public closeCalls = 0;

  public constructor(private readonly _log: CallLog) {}

  public start(): void {
    this._log.record('recorder.start');
    this.startCalls++;
    if (this.startFailure !== undefined) {
      throw this.startFailure;
    }
  }
  public async close(): Promise<void> {
    this._log.record('recorder.close');
    this.closeCalls++;
  }
  public getStats(): ExternalMessageRecorderStats {
    return EMPTY_RECORDER_STATS;
  }
  public getCexStats(): ExternalMessageRecorderCexStats {
    return EMPTY_RECORDER_CEX_STATS;
  }
}

/** Порт storage-политики Polymarket: cleanup, отказ программируется. */
export class FakePolymarketStorage implements CollectorPolymarketStorage {
  public cleanupFailure: Error | undefined;
  public cleanupCalls = 0;

  public constructor(private readonly _log: CallLog) {}

  public async cleanup(): Promise<void> {
    this._log.record('polymarketStorage.cleanup');
    this.cleanupCalls++;
    if (this.cleanupFailure !== undefined) {
      throw this.cleanupFailure;
    }
  }
}

const EMPTY_CEX_WINDOW_STATS: CexWindowRecorderStats = {
  partitionsCompleted: 0,
  rotationFailures: 0,
  streamCloseFailures: 0,
  compressionFailures: 0,
  lateObservations: 0,
};

/** Порт storage-политики CEX-окон: cleanup + статистика. */
export class FakeCexStorage implements CollectorCexStorage {
  public cleanupCalls = 0;

  public constructor(private readonly _log: CallLog) {}

  public async cleanup(): Promise<void> {
    this._log.record('cexStorage.cleanup');
    this.cleanupCalls++;
  }
  public getStats(): CexWindowRecorderStats {
    return EMPTY_CEX_WINDOW_STATS;
  }
}

/** Порт общего PM-source: close + health-сигналы. */
export class FakePolymarketSource implements CollectorPolymarketSource {
  public hasFailed = false;
  public isClosed = false;
  public closeCalls = 0;

  public constructor(private readonly _log: CallLog) {}

  public async close(): Promise<void> {
    this._log.record('polymarketSource.close');
    this.isClosed = true;
    this.closeCalls++;
  }
}

/** Порт SDK-клиента: закрытие shared realtime. */
export class FakePolymarketClient implements CollectorPolymarketClient {
  public closeCalls = 0;

  public constructor(private readonly _log: CallLog) {}

  public async closeSubscriptions(): Promise<void> {
    this._log.record('polymarketClient.closeSubscriptions');
    this.closeCalls++;
  }
}

/** Порт control-runtime: фиксирует спрос каждого прохода. */
export class FakePolymarketControlRuntime implements CollectorPolymarketControlRuntime {
  public readonly demandsSeen: readonly PolymarketSubscriptionDemand[][] = [];
  public runFailure: Error | undefined;
  /** Момент, объявленный последним проходом (уходит в CEX-сверку). */
  public ranAt: Timestamp | undefined;
  /** Момент, который проход объявит своим `ranAt`. */
  private readonly _nowMs = Date.parse('2026-09-01T18:00:05.000Z');

  public constructor(private readonly _log: CallLog) {}

  public async runOnce(
    demands: readonly PolymarketSubscriptionDemand[],
  ): Promise<PolymarketControlRuntimeResult> {
    this._log.record('pmControlRuntime.runOnce');
    (this.demandsSeen as PolymarketSubscriptionDemand[][]).push([...demands]);
    if (this.runFailure !== undefined) {
      throw this.runFailure;
    }
    // Отчёт прохода в тестах не проверяется целиком, но `ranAt` — часть
    // контракта: именно он становится моментом решения тика для CEX-сверки.
    const created = TimestampService.create(this._nowMs);
    if (!created.ok) throw new Error('bad ranAt fixture');
    this.ranAt = created.value;
    return { ranAt: this.ranAt } as unknown as PolymarketControlRuntimeResult;
  }
}

const EMPTY_PM_CONTROLLER_STATS: PolymarketSubscriptionControllerStats = {
  openingMarkets: 0,
  activeMarkets: 0,
  claims: 0,
  rtdsFeeds: [],
  sourceFailed: false,
  closed: false,
};

/** Порт PM-контроллера: close + статистика. */
export class FakePolymarketController implements CollectorPolymarketController {
  public closeCalls = 0;

  public constructor(private readonly _log: CallLog) {}

  public async close(): Promise<void> {
    this._log.record('polymarketController.close');
    this.closeCalls++;
  }
  public getStats(): PolymarketSubscriptionControllerStats {
    return EMPTY_PM_CONTROLLER_STATS;
  }
}

const EMPTY_CEX_CONTROLLER_STATS: CexSubscriptionControllerStats = {
  owners: 0,
  logicalClaims: 0,
  desiredPools: 0,
  physicalPools: 0,
  orderbookPools: 0,
  tradePools: 0,
  runningPools: 0,
  failedPools: 0,
  closed: false,
};

/** Порт CEX-контроллера: reconcile + close, фиксирует спрос каждого прохода. */
export class FakeCexController implements CollectorCexController {
  public readonly demandsSeen: readonly CexSubscriptionDemand[][] = [];
  /** Моменты, с которыми пришла сверка (проверяем, ЧЕЙ это момент тика). */
  public readonly momentsSeen: readonly Timestamp[] = [];
  public reconcileFailure: Error | undefined;
  public closeCalls = 0;

  public constructor(private readonly _log: CallLog) {}

  public async reconcile(
    demands: readonly CexSubscriptionDemand[],
    _now: Timestamp,
  ): Promise<CexSubscriptionReconcileResult> {
    this._log.record('cexController.reconcile');
    (this.demandsSeen as CexSubscriptionDemand[][]).push([...demands]);
    (this.momentsSeen as Timestamp[]).push(_now);
    if (this.reconcileFailure !== undefined) {
      throw this.reconcileFailure;
    }
    return undefined as unknown as CexSubscriptionReconcileResult;
  }
  public async close(): Promise<void> {
    this._log.record('cexController.close');
    this.closeCalls++;
  }
  public getStats(): CexSubscriptionControllerStats {
    return EMPTY_CEX_CONTROLLER_STATS;
  }
}

const EMPTY_GATE_STATS: PolymarketCollectionGateStats = {
  admitted: 0,
  ignoredUnknownMarket: 0,
  ignoredByPolicy: 0,
  ignoredNotHeldByCollector: 0,
  invalidMarketId: 0,
};

/** Порт политики допуска (только диагностика). */
export class FakeGate implements CollectorGate {
  public getStats(): PolymarketCollectionGateStats {
    return EMPTY_GATE_STATS;
  }
}

const EMPTY_LIFECYCLE_STATS: PolymarketCollectionLifecycleStats = {
  activeSessions: 0,
  finalizingSessions: 0,
  attachedTotal: 0,
  sealedTotal: 0,
  claimsReleased: 0,
  completedTotal: 0,
  shutdownSessions: 0,
  finalizationFailures: 0,
  sessionsWithoutClaim: 0,
  orphanSessionsDiscarded: 0,
};

/** Порт lifecycle записей: журналирует проходы и остановку. */
export class FakeLifecycle implements CollectorLifecycle {
  public runOnceCalls = 0;
  public closeCalls = 0;
  /** Если задано — `runOnce` бросает (изоляция отказа тика). */
  public runOnceFailure: Error | undefined;

  public constructor(private readonly _log: CallLog) {}

  public async runOnce(): Promise<void> {
    this.runOnceCalls++;
    this._log.record('lifecycle.runOnce');
    if (this.runOnceFailure !== undefined) {
      throw this.runOnceFailure;
    }
  }

  public syncSessions(): number {
    this._log.record('lifecycle.syncSessions');
    return 0;
  }

  public async awaitAllSettlementCaptures(): Promise<void> {
    this._log.record('lifecycle.awaitAllSettlementCaptures');
  }

  public onLifecycleEvent(): () => void {
    return () => undefined;
  }

  public getStats(): PolymarketCollectionLifecycleStats {
    return EMPTY_LIFECYCLE_STATS;
  }

  public async close(): Promise<void> {
    this.closeCalls++;
    this._log.record('lifecycle.close');
  }
}

const EMPTY_FINALIZER_STATS: MarketFinalizerStats = {
  pendingFinalizations: 0,
  archivedTotal: 0,
  archiveFailures: 0,
  officialFinalizations: 0,
  fallbackFinalizations: 0,
  fallbackByTimeout: 0,
  fallbackByShutdown: 0,
  discardedUnresolvable: 0,
};

/** Порт post-expiry финализатора: журналирует проход, дренаж и остановку. */
export class FakeFinalizer implements CollectorFinalizer {
  public runOnceCalls = 0;
  public drainCalls = 0;
  public closeCalls = 0;

  public constructor(private readonly _log: CallLog) {}

  public async runOnce(): Promise<void> {
    this.runOnceCalls++;
    this._log.record('finalizer.runOnce');
  }

  public async drain(): Promise<void> {
    this.drainCalls++;
    this._log.record('finalizer.drain');
  }

  public async close(): Promise<void> {
    this.closeCalls++;
    this._log.record('finalizer.close');
  }

  public getStats(): MarketFinalizerStats {
    return EMPTY_FINALIZER_STATS;
  }
}

/** Собранный набор fakes + общий журнал вызовов. */
export interface FakeContour {
  readonly log: CallLog;
  readonly bus: FakeBus;
  readonly recorder: FakeRecorder;
  readonly gate: FakeGate;
  readonly lifecycle: FakeLifecycle;
  readonly finalizer: FakeFinalizer;
  readonly polymarketStorage: FakePolymarketStorage;
  readonly cexStorage: FakeCexStorage;
  readonly polymarketSource: FakePolymarketSource;
  readonly polymarketClient: FakePolymarketClient;
  readonly polymarketControlRuntime: FakePolymarketControlRuntime;
  readonly polymarketController: FakePolymarketController;
  readonly cexController: FakeCexController;
  readonly components: DataCollectorComponents;
}

/** Спрос коллектора для fake-контура (значения не важны — фиксируется порядок). */
const PM_DEMAND: PolymarketSubscriptionDemand = {
  ownerKey: 'collector:raw',
  policy: { kind: 'POLYMARKET', family: 'CRYPTO_UP_DOWN' },
  acquireLimit: 20,
};
const CEX_DEMAND: CexSubscriptionDemand = {
  ownerKey: 'collector:raw:binance',
  policy: {
    kind: 'CEX',
    exchangeIds: ['binance'],
    marketTypes: ['spot'],
    symbols: ['BTC/USDT'],
    orderbook: true,
    trades: true,
  },
};

/** Собирает полный fake-контур; `cex: false` — CEX-спрос пуст. */
export function makeFakeContour(options: { readonly cex?: boolean } = {}): FakeContour {
  const log = new CallLog();
  const bus = new FakeBus(log);
  const recorder = new FakeRecorder(log);
  const gate = new FakeGate();
  const lifecycle = new FakeLifecycle(log);
  const finalizer = new FakeFinalizer(log);
  const polymarketStorage = new FakePolymarketStorage(log);
  const cexStorage = new FakeCexStorage(log);
  const polymarketSource = new FakePolymarketSource(log);
  const polymarketClient = new FakePolymarketClient(log);
  const polymarketControlRuntime = new FakePolymarketControlRuntime(log);
  const polymarketController = new FakePolymarketController(log);
  const cexController = new FakeCexController(log);
  const cexEnabled = options.cex !== false;
  const components: DataCollectorComponents = {
    bus,
    recorder,
    gate,
    lifecycle,
    finalizer,
    polymarketStorage,
    cexStorage,
    polymarketSource,
    polymarketClient,
    polymarketControlRuntime,
    polymarketController,
    cexController,
    polymarketDemands: [PM_DEMAND],
    cexDemands: cexEnabled ? [CEX_DEMAND] : [],
  };
  return {
    log,
    bus,
    recorder,
    gate,
    lifecycle,
    finalizer,
    polymarketStorage,
    cexStorage,
    polymarketSource,
    polymarketClient,
    polymarketControlRuntime,
    polymarketController,
    cexController,
    components,
  };
}
