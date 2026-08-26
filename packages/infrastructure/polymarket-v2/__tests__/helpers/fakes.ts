/**
 * Тестовые fakes границы SDK: управляемый subscription handle, fake client
 * и capturing logger.
 *
 * @remarks
 * Fake-и структурные и УЗКИЕ — реализуют ровно контракт
 * `PolymarketSubscribeClient`/`PolymarketSubscriptionHandle` (зеркало SDK),
 * без vendor-абстракций поверх SDK.
 */
import type { ILogger } from '@polymarket/logger';
import type {
  CryptoPricesBinanceEvent,
  CryptoPricesChainlinkEvent,
  CryptoPricesChainlinkTwapEvent,
  StandardMarketEvent,
} from '@polymarket/bindings/subscriptions';
import type {
  PolymarketSubscribeClient,
  PolymarketSubscriptionHandle,
} from '../../src/index.js';

/** Ожидающий потребитель итератора. */
interface Waiter<TEvent> {
  readonly resolve: (result: IteratorResult<TEvent>) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Управляемый fake SDK subscription handle.
 *
 * @remarks
 * Полный аналог контракта SDK: `AsyncIterable` (события появляются через
 * {@link FakeSubscriptionHandle.emit}) + идемпотентный `close()`
 * (терминирует итератор `done: true`). {@link FakeSubscriptionHandle.fail}
 * имитирует падение транспорта — итератор бросает исключение.
 *
 * @example
 * ```typescript
 * const handle = new FakeSubscriptionHandle<StandardMarketEvent>();
 * handle.emit(createBookEvent());  // pump получит событие
 * await handle.close();            // итератор завершится штатно
 * ```
 */
export class FakeSubscriptionHandle<TEvent> implements PolymarketSubscriptionHandle<TEvent> {
  private readonly _queue: TEvent[] = [];
  private readonly _waiters: Array<Waiter<TEvent>> = [];
  private _ended = false;
  private _failure: { error: unknown } | undefined;
  /** Счётчик вызовов close() — для ассертов lifecycle. */
  public closeCalls = 0;

  /** Отдаёт событие потребителю итератора (или буферизует до чтения). */
  public emit(event: TEvent): void {
    const waiter = this._waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value: event, done: false });
      return;
    }
    this._queue.push(event);
  }

  /** Имитирует падение транспорта: следующее чтение итератора бросит error. */
  public fail(error: unknown): void {
    this._failure = { error };
    const waiter = this._waiters.shift();
    if (waiter !== undefined) {
      waiter.reject(error);
    }
  }

  /** Идемпотентное закрытие: итератор завершается `done: true`. */
  public async close(): Promise<void> {
    this.closeCalls += 1;
    this._ended = true;
    while (this._waiters.length > 0) {
      this._waiters.shift()?.resolve({ value: undefined, done: true });
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<TEvent> {
    return {
      next: async (): Promise<IteratorResult<TEvent>> => {
        const queued = this._queue.shift();
        if (queued !== undefined) {
          return { value: queued, done: false };
        }
        if (this._failure !== undefined) {
          throw this._failure.error;
        }
        if (this._ended) {
          return { value: undefined, done: true };
        }
        return new Promise<IteratorResult<TEvent>>((resolve, reject) => {
          this._waiters.push({ resolve, reject });
        });
      },
      return: async (): Promise<IteratorResult<TEvent>> => {
        this._ended = true;
        return { value: undefined, done: true };
      },
    };
  }
}

/** Записанный spec subscribe-вызова (plain-форма для ассертов). */
export interface RecordedSubscriptionSpec {
  readonly topic: string;
  readonly tokenIds?: readonly string[];
  readonly symbols?: readonly string[];
  /** Окно усреднения settlement-потока (только spec TWAP-подписки). */
  readonly windowSeconds?: 30 | 60;
}

/**
 * Fake официального SDK-клиента: отдаёт управляемые handles по topic spec-а.
 *
 * @remarks
 * Реализует `PolymarketSubscribeClient` (= `Pick<PublicClient, 'subscribe'>`).
 * Метод `subscribe` SDK — `const`-generic с типами, которые SDK НЕ
 * экспортирует с public root, поэтому честную сигнатуру fake выразить
 * невозможно: реализация написана по plain-форме спеков и приводится ОДНИМ
 * документированным `as unknown as` к типу порта. Это упомянутая в PART 26
 * unavoidable upstream typing issue: она ограничена тестовой инфраструктурой,
 * production-код кастов не содержит.
 */
export class FakePolymarketClient implements PolymarketSubscribeClient {
  /** Открытые market-handles в порядке подписок. */
  public readonly marketHandles: Array<FakeSubscriptionHandle<StandardMarketEvent>> = [];
  /** Открытые spot-RTDS handles в порядке подписок. */
  public readonly cryptoHandles: Array<
    FakeSubscriptionHandle<CryptoPricesBinanceEvent | CryptoPricesChainlinkEvent>
  > = [];
  /** Открытые settlement-handles Chainlink TWAP в порядке подписок. */
  public readonly twapHandles: Array<FakeSubscriptionHandle<CryptoPricesChainlinkTwapEvent>> = [];
  /** Все subscribe-вызовы (spec-массивы) для ассертов. */
  public readonly subscribeCalls: Array<readonly RecordedSubscriptionSpec[]> = [];
  /** Если задано — subscribe бросает эту ошибку (имитация SDK SubscribeError). */
  public subscribeError: unknown;
  /** Если задан — subscribe разрешается только после этого promise (имитация медленного SDK). */
  public subscribeHold: Promise<void> | undefined;

  public subscribe = (async (
    subscriptions: readonly RecordedSubscriptionSpec[],
  ): Promise<unknown> => {
    this.subscribeCalls.push(subscriptions);
    if (this.subscribeHold !== undefined) {
      await this.subscribeHold;
    }
    if (this.subscribeError !== undefined) {
      throw this.subscribeError;
    }
    const spec = subscriptions[0];
    if (spec === undefined) {
      throw new Error('FakePolymarketClient received an empty subscription list');
    }
    if (spec.topic === 'market') {
      const handle = new FakeSubscriptionHandle<StandardMarketEvent>();
      this.marketHandles.push(handle);
      return handle;
    }
    if (spec.topic === 'prices.crypto.chainlink.twap') {
      const handle = new FakeSubscriptionHandle<CryptoPricesChainlinkTwapEvent>();
      this.twapHandles.push(handle);
      return handle;
    }
    const handle = new FakeSubscriptionHandle<
      CryptoPricesBinanceEvent | CryptoPricesChainlinkEvent
    >();
    this.cryptoHandles.push(handle);
    return handle;
  }) as unknown as PolymarketSubscribeClient['subscribe'];
}

/** Запись лога для ассертов. */
export interface CapturedLogEntry {
  readonly level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  readonly message: string;
  readonly context?: Record<string, unknown> | undefined;
}

/**
 * Логгер, накапливающий записи в память (child возвращает тот же sink).
 */
export class CapturingLogger implements ILogger {
  public readonly entries: CapturedLogEntry[] = [];

  public trace(message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level: 'trace', message, context });
  }

  public debug(message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level: 'debug', message, context });
  }

  public info(message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level: 'info', message, context });
  }

  public warn(message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level: 'warn', message, context });
  }

  public error(message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level: 'error', message, context });
  }

  public fatal(message: string, context?: Record<string, unknown>): void {
    this.entries.push({ level: 'fatal', message, context });
  }

  public child(_bindings: Record<string, unknown>): ILogger {
    return this;
  }

  /** Записи заданного уровня. */
  public byLevel(level: CapturedLogEntry['level']): CapturedLogEntry[] {
    return this.entries.filter((entry) => entry.level === level);
  }
}

/**
 * Дожидается осушения microtask/immediate очередей (доставка через bus).
 */
export async function flushAsync(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}
