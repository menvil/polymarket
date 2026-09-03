/**
 * Подделки и фикстуры тестов CEX-контроллера подписок.
 *
 * @remarks
 * Policy собирается НАСТОЯЩИМ типом `@polymarket/policy`, а моменты —
 * настоящим `TimestampService`: полуоткрытая семантика окна и
 * доменная арифметика времени — инварианты самих этих типов, и на моках
 * они проверялись бы против выдуманной структуры.
 *
 * Подделка источника управляема: `close()` можно задержать (`holdClose`),
 * `start()` — заставить бросить, а сам источник — перевести в
 * терминальный отказ. Без этого нельзя проверить ни запрет перекрытия
 * поколений, ни замену отказавшего источника, ни `close()` во время
 * идущего прохода.
 */
import { TimestampService } from '@polymarket/timestamp';
import type { Timestamp } from '@polymarket/timestamp';
import type { ILogger } from '@polymarket/logger';
import type { CexPolicy } from '@polymarket/policy';
import type { CexSourceConfig, CexSourceStats } from '@polymarket/cex-v2';
import type {
  CexSubscriptionSource,
  CexSubscriptionSourceFactory,
} from '../../src/index.js';

/** Опорные моменты сценариев окна policy (UTC). */
export const AT_1757_MS = Date.parse('2026-09-01T17:57:00.000Z');
export const AT_1759_59_999_MS = Date.parse('2026-09-01T17:59:59.999Z');
export const AT_1800_MS = Date.parse('2026-09-01T18:00:00.000Z');
export const AT_1805_MS = Date.parse('2026-09-01T18:05:00.000Z');

/**
 * Строит canonical `Timestamp` фикстуры.
 *
 * @param ms - Момент epoch в миллисекундах
 * @returns Canonical `Timestamp`
 * @throws {Error} Если фикстура задаёт невалидный момент
 *
 * @example
 * ```typescript
 * const now = ts(AT_1800_MS);
 * ```
 */
export function ts(ms: number): Timestamp {
  const result = TimestampService.create(ms);
  if (!result.ok) throw new Error(`bad timestamp fixture: ${result.error.message}`);
  return result.value;
}

/**
 * Строит CEX-policy фикстуры.
 *
 * @param overrides - Поля, отличающиеся от базовой policy
 * @returns Policy для спроса
 *
 * @remarks
 * База — `binance / swap / BTC/USDT / только сделки`: самый частый
 * сценарий тестов разделения ресурса. Всё остальное задаётся точечно.
 *
 * @example
 * ```typescript
 * const btcOrderbook = policy({ orderbook: true, trades: false, orderbookDepth: 50 });
 * ```
 */
export function policy(overrides: Partial<CexPolicy> = {}): CexPolicy {
  return {
    kind: 'CEX',
    exchangeIds: ['binance'],
    marketTypes: ['swap'],
    symbols: ['BTC/USDT'],
    orderbook: false,
    trades: true,
    ...overrides,
  };
}

/** Управляемый deferred для hold-сценариев. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Логгер, складывающий записи (проверяем факт, а не текст). */
export class CapturingLogger implements ILogger {
  public readonly entries: Array<{ level: string; message: string }> = [];

  public trace(message: string): void {
    this.entries.push({ level: 'trace', message });
  }
  public debug(message: string): void {
    this.entries.push({ level: 'debug', message });
  }
  public info(message: string): void {
    this.entries.push({ level: 'info', message });
  }
  public warn(message: string): void {
    this.entries.push({ level: 'warn', message });
  }
  public error(message: string): void {
    this.entries.push({ level: 'error', message });
  }
  public fatal(message: string): void {
    this.entries.push({ level: 'fatal', message });
  }
  public child(): ILogger {
    return this;
  }
}

/**
 * Подделка физического источника.
 *
 * @remarks
 * Реализует РОВНО structural-подмножество `CexSource`, которым пользуется
 * контроллер. Счётчики (`startCalls`/`closeCalls`) существуют затем, что
 * главные инварианты пакета формулируются в них: «источник переиспользован»
 * — это `closeCalls === 0`, а «перекрытия поколений нет» — это `startCalls
 * === 0` у нового источника, пока не завершился `close()` старого.
 */
export class FakeCexSource implements CexSubscriptionSource {
  public startCalls = 0;
  public closeCalls = 0;
  /** Ошибка, которую бросит `start()` (если задана). */
  public startError: Error | null = null;
  /** Ошибка, которую бросит `close()` (если задана). */
  public closeError: Error | null = null;

  private _closed = false;
  private _failed = false;
  private _running = false;
  private _closeGate: Promise<void> | null = null;

  public constructor(public readonly config: CexSourceConfig) {}

  public get isClosed(): boolean {
    return this._closed;
  }
  public get hasFailed(): boolean {
    return this._failed;
  }
  public get isRunning(): boolean {
    return this._running;
  }

  public start(): void {
    this.startCalls += 1;
    if (this.startError !== null) throw this.startError;
    this._running = true;
  }

  public async close(): Promise<void> {
    this.closeCalls += 1;
    if (this._closeGate !== null) await this._closeGate;
    if (this.closeError !== null) throw this.closeError;
    this._running = false;
    this._closed = true;
  }

  public getStats(): CexSourceStats {
    return { orderbookSnapshotFailures: 0, tradeSnapshotFailures: 0 };
  }

  /**
   * Задерживает `close()` до вызова возвращённой функции.
   *
   * @returns Функция, отпускающая зависший `close()`
   *
   * @example
   * ```typescript
   * const release = source.holdClose();
   * const pending = controller.reconcile(next, now); // висит на close()
   * release();
   * await pending;
   * ```
   */
  public holdClose(): () => void {
    const gate = deferred();
    this._closeGate = gate.promise;
    return gate.resolve;
  }

  /** Переводит источник в терминальный отказ (как отказ шины у настоящего). */
  public failTerminally(): void {
    this._failed = true;
    this._running = false;
  }

  /** Переводит источник в закрытое состояние без участия контроллера. */
  public markClosed(): void {
    this._closed = true;
    this._running = false;
  }
}

/** Наблюдаемая фабрика источников. */
export interface SourceFactoryProbe {
  /** Фабрика для зависимостей контроллера. */
  readonly factory: CexSubscriptionSourceFactory;
  /** Все созданные источники в порядке создания. */
  readonly sources: FakeCexSource[];
  /** Конфигурации, с которыми фабрику звали. */
  readonly configs: CexSourceConfig[];
  /** Ошибка, которую бросит САМА фабрика (если задана). */
  factoryError: Error | null;
  /** Хук настройки только что созданного источника (до `start()`). */
  onCreate: ((source: FakeCexSource, index: number) => void) | null;
}

/**
 * Создаёт наблюдаемую фабрику источников.
 *
 * @returns Фабрика вместе с журналом созданий
 *
 * @example
 * ```typescript
 * const probe = sourceFactoryProbe();
 * const controller = new CexSubscriptionController({ sourceFactory: probe.factory, logger });
 * probe.sources.length; // сколько физических поколений создано
 * ```
 */
export function sourceFactoryProbe(): SourceFactoryProbe {
  const probe: SourceFactoryProbe = {
    factory: (config: CexSourceConfig) => {
      if (probe.factoryError !== null) throw probe.factoryError;
      const source = new FakeCexSource(config);
      probe.configs.push(config);
      probe.sources.push(source);
      probe.onCreate?.(source, probe.sources.length - 1);
      return source;
    },
    sources: [],
    configs: [],
    factoryError: null,
    onCreate: null,
  };
  return probe;
}
