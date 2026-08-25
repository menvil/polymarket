/**
 * Тестовые fakes vendor-границы CCXT Pro и порта публикации.
 *
 * @remarks
 * Fake-и структурные и узкие: реализуют ровно контракт
 * `CcxtProExchangeInstance`/`CexExternalMessagePublisher`, без
 * vendor-абстракций поверх CCXT. Управляемые feed-ы позволяют тестам
 * детерминированно отдавать наблюдения, подвешивать watch (stale) и
 * имитировать падение транспорта.
 */
import type { ILogger } from '@polymarket/logger';
import type { MessageBusPublishError } from '@polymarket/message-bus';
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import type {
  CcxtProExchangeFactoryParams,
  CcxtProExchangeInstance,
  CcxtRawOrderBook,
  CcxtRawTrade,
  CexExternalMessage,
} from '../../src/index.js';

/** Ожидающий потребитель управляемого feed-а. */
interface FeedWaiter<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Управляемый FIFO-feed одного vendor-метода: тест пушит значения/ошибки,
 * watcher получает их в порядке вызовов.
 */
export class FakeFeed<T> {
  private readonly _queue: Array<{ value?: T; error?: unknown }> = [];
  private readonly _waiters: FeedWaiter<T>[] = [];
  /** Количество вызовов next() (обращений watcher-а). */
  public calls = 0;

  /** Отдаёт значение потребителю (или буферизует до следующего вызова). */
  public push(value: T): void {
    const waiter = this._waiters.shift();
    if (waiter) {
      waiter.resolve(value);
      return;
    }
    this._queue.push({ value });
  }

  /** Следующий вызов (или ожидающий) завершится ошибкой. */
  public fail(error: unknown): void {
    const waiter = this._waiters.shift();
    if (waiter) {
      waiter.reject(error);
      return;
    }
    this._queue.push({ error });
  }

  /** Отклоняет ВСЕ ожидающие вызовы (закрытие инстанса). */
  public rejectPending(error: unknown): void {
    while (this._waiters.length > 0) {
      this._waiters.shift()!.reject(error);
    }
  }

  /** Есть ли прямо сейчас ожидающий потребитель. */
  public get hasWaiter(): boolean {
    return this._waiters.length > 0;
  }

  /** Вызов vendor-метода: очередное значение или ожидание push/fail. */
  public next(): Promise<T> {
    this.calls++;
    const queued = this._queue.shift();
    if (queued) {
      return queued.error !== undefined
        ? Promise.reject(queued.error)
        : Promise.resolve(queued.value as T);
    }
    return new Promise<T>((resolve, reject) => {
      this._waiters.push({ resolve, reject });
    });
  }
}

/** Возможности fake-инстанса (наполняют `has`-map). */
export interface FakeExchangeCapabilities {
  readonly watchOrderBookForSymbols?: boolean;
  readonly watchOrderBook?: boolean;
  readonly fetchOrderBook?: boolean;
  readonly watchTradesForSymbols?: boolean;
  readonly watchTrades?: boolean;
}

/** Зафиксированный вызов vendor-метода. */
export interface RecordedVendorCall {
  readonly method: string;
  readonly symbols: readonly string[];
  readonly limit?: number | undefined;
}

/**
 * Управляемый fake CCXT Pro инстанса.
 *
 * @remarks
 * Каждый watch/fetch-метод существует только если включён в capabilities
 * (и отражён в `has`) — mode-selection source проверяется по-настоящему.
 * `close()` отклоняет все pending watch-промисы (как реальный ccxt.pro при
 * закрытии соединений) и считает вызовы.
 */
export class FakeExchangeInstance implements CcxtProExchangeInstance {
  public readonly has: Record<string, boolean>;
  public readonly obMultiplexFeed = new FakeFeed<CcxtRawOrderBook>();
  public readonly obFetchFeed = new FakeFeed<CcxtRawOrderBook>();
  public readonly tradesMultiplexFeed = new FakeFeed<readonly CcxtRawTrade[]>();
  /** Per-symbol feeds `watchOrderBook` (петли символов конкурентны). */
  private readonly _obSymbolFeeds = new Map<string, FakeFeed<CcxtRawOrderBook>>();
  /** Per-symbol feeds `watchTrades`. */
  private readonly _tradesSymbolFeeds = new Map<string, FakeFeed<readonly CcxtRawTrade[]>>();
  /** Хронология vendor-вызовов для ассертов mode-selection/routing. */
  public readonly vendorCalls: RecordedVendorCall[] = [];
  public closeCalls = 0;

  /** Feed per-symbol стакана (создаётся по требованию). */
  public obFeed(symbol: string): FakeFeed<CcxtRawOrderBook> {
    let feed = this._obSymbolFeeds.get(symbol);
    if (!feed) {
      feed = new FakeFeed<CcxtRawOrderBook>();
      this._obSymbolFeeds.set(symbol, feed);
    }
    return feed;
  }

  /** Feed per-symbol сделок (создаётся по требованию). */
  public tradesFeed(symbol: string): FakeFeed<readonly CcxtRawTrade[]> {
    let feed = this._tradesSymbolFeeds.get(symbol);
    if (!feed) {
      feed = new FakeFeed<readonly CcxtRawTrade[]>();
      this._tradesSymbolFeeds.set(symbol, feed);
    }
    return feed;
  }

  public readonly watchOrderBookForSymbols?: (
    symbols: string[],
    limit?: number,
  ) => Promise<CcxtRawOrderBook>;

  public readonly watchOrderBook?: (symbol: string, limit?: number) => Promise<CcxtRawOrderBook>;
  public readonly fetchOrderBook?: (symbol: string, limit?: number) => Promise<CcxtRawOrderBook>;
  public readonly watchTradesForSymbols?: (symbols: string[]) => Promise<readonly CcxtRawTrade[]>;
  public readonly watchTrades?: (symbol: string) => Promise<readonly CcxtRawTrade[]>;

  constructor(capabilities: FakeExchangeCapabilities) {
    this.has = {
      watchOrderBookForSymbols: capabilities.watchOrderBookForSymbols ?? false,
      watchOrderBook: capabilities.watchOrderBook ?? false,
      fetchOrderBook: capabilities.fetchOrderBook ?? false,
      watchTradesForSymbols: capabilities.watchTradesForSymbols ?? false,
      watchTrades: capabilities.watchTrades ?? false,
    };
    if (capabilities.watchOrderBookForSymbols) {
      this.watchOrderBookForSymbols = (symbols, limit) => {
        this.vendorCalls.push({ method: 'watchOrderBookForSymbols', symbols: [...symbols], limit });
        return this.obMultiplexFeed.next();
      };
    }
    if (capabilities.watchOrderBook) {
      this.watchOrderBook = (symbol, limit) => {
        this.vendorCalls.push({ method: 'watchOrderBook', symbols: [symbol], limit });
        return this.obFeed(symbol).next();
      };
    }
    if (capabilities.fetchOrderBook) {
      this.fetchOrderBook = (symbol, limit) => {
        this.vendorCalls.push({ method: 'fetchOrderBook', symbols: [symbol], limit });
        return this.obFetchFeed.next();
      };
    }
    if (capabilities.watchTradesForSymbols) {
      this.watchTradesForSymbols = (symbols) => {
        this.vendorCalls.push({ method: 'watchTradesForSymbols', symbols: [...symbols] });
        return this.tradesMultiplexFeed.next();
      };
    }
    if (capabilities.watchTrades) {
      this.watchTrades = (symbol) => {
        this.vendorCalls.push({ method: 'watchTrades', symbols: [symbol] });
        return this.tradesFeed(symbol).next();
      };
    }
  }

  /** Закрытие инстанса: pending watch-промисы отклоняются, как в ccxt.pro. */
  public close = (): Promise<void> => {
    this.closeCalls++;
    const closedError = new Error('Exchange instance closed');
    this.obMultiplexFeed.rejectPending(closedError);
    this.obFetchFeed.rejectPending(closedError);
    this.tradesMultiplexFeed.rejectPending(closedError);
    for (const feed of this._obSymbolFeeds.values()) {
      feed.rejectPending(closedError);
    }
    for (const feed of this._tradesSymbolFeeds.values()) {
      feed.rejectPending(closedError);
    }
    return Promise.resolve();
  };
}

/**
 * Фабрика fake-инстансов: создаёт новый инстанс на каждую сессию
 * (как production-фабрика) и хранит их для ассертов рестартов.
 */
export class FakeExchangeFactory {
  public readonly instances: FakeExchangeInstance[] = [];
  public readonly factoryParams: CcxtProExchangeFactoryParams[] = [];

  constructor(private readonly _capabilities: FakeExchangeCapabilities) {}

  public readonly create = (params: CcxtProExchangeFactoryParams): CcxtProExchangeInstance => {
    this.factoryParams.push(params);
    const instance = new FakeExchangeInstance(this._capabilities);
    this.instances.push(instance);
    return instance;
  };

  /** Последний созданный инстанс (текущая сессия). */
  public get latest(): FakeExchangeInstance {
    const instance = this.instances[this.instances.length - 1];
    if (!instance) throw new Error('No exchange instance created yet');
    return instance;
  }
}

/**
 * Capturing-порт публикации: фиксирует сообщения, исходы программируются.
 */
export class CapturingPublisher {
  /** Опубликованные сообщения в порядке publish-вызовов. */
  public readonly messages: CexExternalMessage[] = [];
  private readonly _errorQueue: MessageBusPublishError[] = [];
  /** Если задан — publish возвращает pending до resolve этого промиса. */
  public publishGate: Promise<void> | null = null;

  /** Следующий publish вернёт Err с этой ошибкой. */
  public failNext(error: MessageBusPublishError): void {
    this._errorQueue.push(error);
  }

  public publish = async (
    message: CexExternalMessage,
  ): Promise<Result<void, MessageBusPublishError>> => {
    this.messages.push(message);
    if (this.publishGate) {
      await this.publishGate;
    }
    const error = this._errorQueue.shift();
    return error ? Err(error) : Ok(undefined);
  };

  /** Сообщения заданного типа. */
  public ofType<TType extends CexExternalMessage['type']>(
    type: TType,
  ): Array<Extract<CexExternalMessage, { type: TType }>> {
    return this.messages.filter(
      (message): message is Extract<CexExternalMessage, { type: TType }> => message.type === type,
    );
  }
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

/** Пауза на ms. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Дожидается выполнения условия (poll каждые 5ms).
 *
 * @param predicate - Условие
 * @param timeoutMs - Максимальное ожидание
 * @throws {Error} Если условие не выполнилось за timeoutMs
 */
export async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error('Timed out waiting for condition');
}
