/**
 * Тестовые fakes компонентов контура сбора.
 *
 * @remarks
 * Все fakes — узкие структурные реализации портов `DataCollector`: они
 * фиксируют вызовы и позволяют программировать отказы, не поднимая ни сети,
 * ни CCXT, ни диска. Поведение самих компонентов проверяется тестами их
 * собственных пакетов — здесь проверяется РАНТАЙМ: порядок запуска, откат,
 * лестница остановки, проекция lifecycle и операционный статус.
 */
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import { asMarketId } from '@polymarket/ids';
import type { CollectionSessionSnapshot } from '@polymarket/collection-coordinator';
import type { PolymarketDiscoveredMarket } from '@polymarket/polymarket-v2';
import type { Timestamp } from '@polymarket/timestamp';
import type { MessageBusDrainError, MessageBusStats } from '@polymarket/message-bus';
import type { Result } from '@polymarket/result';
import { Err, Ok } from '@polymarket/result';
import type {
  CollectorBus,
  CollectorCexSource,
  CollectorCexSourceEntry,
  CollectorCexStorage,
  CollectorCoordinator,
  CollectorDiscovery,
  CollectorFinalizer,
  CollectorPolymarketClient,
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

  /**
   * Индекс первого вызова; отсутствие вызова — ошибка теста.
   *
   * @remarks
   * Обычный `indexOf` вернул бы -1, и сравнение порядка (`a < b`) прошло бы
   * ВАКУУМНО для шага, которого вообще не было. Порядковые проверки обязаны
   * падать именно в этом случае.
   */
  public orderOf(name: string): number {
    const index = this.calls.indexOf(name);
    if (index === -1) {
      throw new Error(`Expected call '${name}' was never made. Calls: ${this.calls.join(' → ')}`);
    }
    return index;
  }

  /** Индекс первого вызова (или -1) — для проверок «вызова не было». */
  public indexOf(name: string): number {
    return this.calls.indexOf(name);
  }

  /** Сколько раз вызывалось. */
  public countOf(name: string): number {
    return this.calls.filter((call) => call === name).length;
  }
}

/** Управляемые часы: время двигает тест. */
export class FakeClock implements IClock {
  constructor(private _ms: number = 1_700_000_000_000) {}

  public now(): Date {
    return new Date(this._ms);
  }

  /** Двигает время вперёд. */
  public advance(ms: number): void {
    this._ms += ms;
  }
}

/** Захваченная строка лога. */
export interface LoggedLine {
  readonly level: string;
  readonly message: string;
  readonly context: Record<string, unknown> | undefined;
}

/** Логгер, складывающий строки в массив. */
export class CapturingLogger implements ILogger {
  public readonly lines: LoggedLine[] = [];

  private _log(level: string, message: string, context?: Record<string, unknown>): void {
    this.lines.push({ level, message, context });
  }

  public trace(message: string, context?: Record<string, unknown>): void {
    this._log('trace', message, context);
  }
  public debug(message: string, context?: Record<string, unknown>): void {
    this._log('debug', message, context);
  }
  public info(message: string, context?: Record<string, unknown>): void {
    this._log('info', message, context);
  }
  public warn(message: string, context?: Record<string, unknown>): void {
    this._log('warn', message, context);
  }
  public error(message: string, context?: Record<string, unknown>): void {
    this._log('error', message, context);
  }
  public fatal(message: string, context?: Record<string, unknown>): void {
    this._log('fatal', message, context);
  }
  public child(): ILogger {
    return this;
  }

  /** Строки указанного уровня. */
  public byLevel(level: string): LoggedLine[] {
    return this.lines.filter((line) => line.level === level);
  }
}

/** Fake общего bus: считает drain/close, умеет отклонять их. */
export class FakeBus implements CollectorBus {
  public drainRejection: MessageBusDrainError | undefined;
  public closeRejection: MessageBusDrainError | undefined;
  public stats: MessageBusStats = {
    queueSize: 0,
    subscribedTypes: 2,
    dispatching: false,
    closed: false,
    publishedTotal: 0,
    dispatchedTotal: 0,
    handlerErrorsTotal: 0,
    rejectedPublicationsTotal: 0,
  };

  constructor(private readonly _log: CallLog) {}

  public async drain(): Promise<Result<void, MessageBusDrainError>> {
    this._log.record('bus.drain');
    return this.drainRejection !== undefined ? Err(this.drainRejection) : Ok(undefined);
  }

  public async close(): Promise<Result<void, MessageBusDrainError>> {
    this._log.record('bus.close');
    return this.closeRejection !== undefined ? Err(this.closeRejection) : Ok(undefined);
  }

  public getStats(): MessageBusStats {
    return this.stats;
  }
}

/** Fake recording-подписчика bus. */
export class FakeRecorder implements CollectorRecorder {
  public startError: Error | undefined;
  public closeRejection: Error | undefined;

  constructor(private readonly _log: CallLog) {}

  public start(): void {
    this._log.record('recorder.start');
    if (this.startError !== undefined) throw this.startError;
  }

  public async close(): Promise<void> {
    this._log.record('recorder.close');
    if (this.closeRejection !== undefined) throw this.closeRejection;
  }

  public getStats(): ReturnType<CollectorRecorder['getStats']> {
    return {
      marketMessagesRouted: 0,
      rtdsMessagesRouted: 0,
      recordsWritten: 7,
      recordsSkippedInactive: 0,
      serializationFailures: 0,
      registrationFailures: 0,
      unroutedMarketMessages: 0,
      unroutedRtdsMessages: 0,
      handlerErrors: 0,
    };
  }

  public getCexStats(): ReturnType<CollectorRecorder['getCexStats']> {
    return {
      cexMessagesRouted: 0,
      cexRecordsAccepted: 3,
      cexRecordsDroppedInactive: 0,
      cexWriteFailures: 0,
      cexHandlerErrors: 0,
    };
  }
}

/** Fake storage-политики Polymarket. */
export class FakePolymarketStorage implements CollectorPolymarketStorage {
  public cleanupRejection: Error | undefined;
  /** Пока задан — `cleanup()` не завершается (запуск наблюдаемо «в полёте»). */
  public cleanupGate: Promise<void> | undefined;

  constructor(private readonly _log: CallLog) {}

  public async cleanup(): Promise<void> {
    this._log.record('polymarketStorage.cleanup');
    if (this.cleanupGate !== undefined) {
      await this.cleanupGate;
    }
    if (this.cleanupRejection !== undefined) throw this.cleanupRejection;
  }
}

/** Fake storage-политики CEX-окон. */
export class FakeCexStorage implements CollectorCexStorage {
  public cleanupRejection: Error | undefined;

  constructor(private readonly _log: CallLog) {}

  public async cleanup(): Promise<void> {
    this._log.record('cexStorage.cleanup');
    if (this.cleanupRejection !== undefined) throw this.cleanupRejection;
  }

  public getStats(): ReturnType<CollectorCexStorage['getStats']> {
    return {
      partitionsCompleted: 4,
      rotationFailures: 0,
      streamCloseFailures: 0,
      compressionFailures: 0,
    };
  }
}

/** Fake Polymarket-source. */
export class FakePolymarketSource implements CollectorPolymarketSource {
  public hasFailed = false;
  public isClosed = false;
  public closeRejection: Error | undefined;

  constructor(private readonly _log: CallLog) {}

  public async close(): Promise<void> {
    this._log.record('polymarketSource.close');
    this.isClosed = true;
    if (this.closeRejection !== undefined) throw this.closeRejection;
  }
}

/** Fake SDK-клиента: считает client-level cleanup, умеет его провалить. */
export class FakePolymarketClient implements CollectorPolymarketClient {
  public closeRejection: Error | undefined;

  constructor(private readonly _log: CallLog) {}

  public async closeSubscriptions(): Promise<void> {
    this._log.record('polymarketClient.closeSubscriptions');
    if (this.closeRejection !== undefined) throw this.closeRejection;
  }
}

/** Fake одного CEX-source. */
export class FakeCexSource implements CollectorCexSource {
  public hasFailed = false;
  public isRunning = false;
  public startError: Error | undefined;
  public closeRejection: Error | undefined;

  constructor(
    private readonly _log: CallLog,
    public readonly exchangeId: string,
  ) {}

  public start(): void {
    this._log.record(`cexSource.start(${this.exchangeId})`);
    if (this.startError !== undefined) throw this.startError;
    this.isRunning = true;
  }

  public async close(): Promise<void> {
    this._log.record(`cexSource.close(${this.exchangeId})`);
    this.isRunning = false;
    if (this.closeRejection !== undefined) throw this.closeRejection;
  }

  public getStats(): ReturnType<CollectorCexSource['getStats']> {
    return { orderbookSnapshotFailures: 0, tradeSnapshotFailures: 0 };
  }
}

/**
 * Минимальный Timestamp для снимков.
 *
 * @remarks
 * Рантайм вызывает у него только `toNumber()`; конструировать настоящий VO
 * ради этого не нужно, но тип обязан быть настоящим — иначе расширение
 * контракта снимка прошло бы мимо тестов.
 */
export function timestampOf(ms: number): Timestamp {
  return { toNumber: () => ms } as Timestamp;
}

/**
 * Кандидат discovery в объёме, который читает рантайм.
 *
 * @remarks
 * Проекция реального `PolymarketDiscoveredMarket` по РЕАЛЬНЫМ полям: если
 * рантайм начнёт читать что-то ещё или контракт изменится, тест перестанет
 * компилироваться — в отличие от `never[]`, который скрывал бы расхождение.
 */
export type FakeCandidate = Pick<
  PolymarketDiscoveredMarket,
  'marketId' | 'question' | 'expiresAt'
>;

/** Создаёт кандидата с заданным id. */
export function candidate(id: string, expiresAtMs = 2_000_000): FakeCandidate {
  return {
    marketId: asMarketId(id)!,
    question: `Question ${id}`,
    expiresAt: timestampOf(expiresAtMs),
  };
}

/** Fake Discovery: тест задаёт содержимое кэша кандидатов. */
export class FakeDiscovery implements CollectorDiscovery {
  public candidates: FakeCandidate[] = [];
  public findRejection: Error | undefined;

  public async findCandidates(): Promise<readonly FakeCandidate[]> {
    if (this.findRejection !== undefined) throw this.findRejection;
    return this.candidates;
  }
}

/**
 * Снимок сессии в объёме, который читает рантайм.
 *
 * @remarks
 * Проекция реального `CollectionSessionSnapshot`; `state` сделан изменяемым,
 * чтобы тест мог двигать сессию по lifecycle.
 */
export type FakeSession = Pick<
  CollectionSessionSnapshot,
  'marketId' | 'question' | 'expiresAt'
> & {
  state: CollectionSessionSnapshot['state'];
};

/** Fake координатора: сессии и счётчики задаёт тест. */
export class FakeCoordinator implements CollectorCoordinator {
  public sessions: FakeSession[] = [];
  public refreshCalls = 0;
  public fillCalls = 0;
  public closeRejection: Error | undefined;
  /** Пока задан — `fillSlots()` не завершается (тик наблюдаемо «в полёте»). */
  private _gate: Promise<void> | undefined;
  private _openGate: (() => void) | undefined;

  constructor(private readonly _log: CallLog) {}

  /**
   * Подвешивает следующий `fillSlots()` до вызова {@link FakeCoordinator.release}.
   *
   * @remarks
   * Позволяет проверить, что остановка ДОЖИДАЕТСЯ тика, а не просто
   * оказывается позже него по случайному стечению планировщика.
   */
  public block(): void {
    this._gate = new Promise<void>((resolve) => {
      this._openGate = resolve;
    });
  }

  /**
   * Снимает блокировку для БУДУЩИХ вызовов, не отпуская уже подвешенный.
   *
   * @remarks
   * Нужно для проверки ПЕРЕКРЫВАЮЩИХСЯ тиков: первый остаётся в полёте, а
   * второй проходит насквозь и завершается раньше него.
   */
  public unblockFuture(): void {
    this._gate = undefined;
  }

  /** Отпускает подвешенный `fillSlots()`. */
  public release(): void {
    this._openGate?.();
    this._gate = undefined;
    this._openGate = undefined;
  }

  public async refreshCandidates(): Promise<void> {
    this.refreshCalls++;
    this._log.record('coordinator.refreshCandidates');
  }

  public async fillSlots(): Promise<number> {
    this.fillCalls++;
    this._log.record('coordinator.fillSlots.start');
    if (this._gate !== undefined) {
      await this._gate;
    }
    this._log.record('coordinator.fillSlots');
    return 0;
  }

  public listSessions(): FakeSession[] {
    return this.sessions;
  }

  public getStats(): ReturnType<CollectorCoordinator['getStats']> {
    return {
      activeSessions: this.sessions.filter((session) => session.state === 'ACTIVE').length,
      openingSessions: this.sessions.filter((session) => session.state === 'OPENING').length,
      finalizingSessions: this.sessions.filter((session) => session.state === 'FINALIZING').length,
      rtdsFeeds: [],
    };
  }

  public async close(): Promise<void> {
    this._log.record('coordinator.close');
    this.sessions = [];
    if (this.closeRejection !== undefined) throw this.closeRejection;
  }
}

/** Fake финализатора: счётчики двигает тест. */
export class FakeFinalizer implements CollectorFinalizer {
  public pendingFinalizations = 0;
  public archivedTotal = 0;
  public archiveFailures = 0;
  public runOnceCalls = 0;
  public drainCalls = 0;
  public closeRejection: Error | undefined;

  constructor(private readonly _log: CallLog) {}

  public async runOnce(): Promise<void> {
    this.runOnceCalls++;
    this._log.record('finalizer.runOnce');
  }

  public async drain(): Promise<void> {
    this.drainCalls++;
    this._log.record('finalizer.drain');
  }

  public getStats(): ReturnType<CollectorFinalizer['getStats']> {
    return {
      pendingFinalizations: this.pendingFinalizations,
      archivedTotal: this.archivedTotal,
      archiveFailures: this.archiveFailures,
    };
  }

  public async close(): Promise<void> {
    this._log.record('finalizer.close');
    if (this.closeRejection !== undefined) throw this.closeRejection;
  }
}

/** Полный набор fake-компонентов одного теста. */
export interface FakeContour {
  readonly log: CallLog;
  readonly logger: CapturingLogger;
  readonly clock: FakeClock;
  readonly bus: FakeBus;
  readonly recorder: FakeRecorder;
  readonly polymarketStorage: FakePolymarketStorage;
  readonly cexStorage: FakeCexStorage;
  readonly polymarketSource: FakePolymarketSource;
  readonly polymarketClient: FakePolymarketClient;
  readonly cexSources: FakeCexSource[];
  readonly discovery: FakeDiscovery;
  readonly coordinator: FakeCoordinator;
  readonly finalizer: FakeFinalizer;
  readonly components: DataCollectorComponents;
}

/**
 * Собирает полный fake-контур.
 *
 * @param exchangeIds - Биржи, для которых создаются fake CEX-source-ы
 * @returns Все fakes + собранные `DataCollectorComponents`
 */
export function makeFakeContour(exchangeIds: readonly string[] = ['binance', 'okx']): FakeContour {
  const log = new CallLog();
  const logger = new CapturingLogger();
  const clock = new FakeClock();
  const bus = new FakeBus(log);
  const recorder = new FakeRecorder(log);
  const polymarketStorage = new FakePolymarketStorage(log);
  const cexStorage = new FakeCexStorage(log);
  const polymarketSource = new FakePolymarketSource(log);
  const polymarketClient = new FakePolymarketClient(log);
  const cexSources = exchangeIds.map((exchangeId) => new FakeCexSource(log, exchangeId));
  const discovery = new FakeDiscovery();
  const coordinator = new FakeCoordinator(log);
  const finalizer = new FakeFinalizer(log);

  const entries: CollectorCexSourceEntry[] = cexSources.map((source) => ({
    exchangeId: source.exchangeId,
    source,
  }));

  return {
    log,
    logger,
    clock,
    bus,
    recorder,
    polymarketStorage,
    cexStorage,
    polymarketSource,
    polymarketClient,
    cexSources,
    discovery,
    coordinator,
    finalizer,
    components: {
      bus,
      recorder,
      polymarketStorage,
      cexStorage,
      polymarketSource,
      polymarketClient,
      cexSources: entries,
      discovery,
      coordinator,
      finalizer,
    },
  };
}
