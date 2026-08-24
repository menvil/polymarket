/**
 * Тестовые fakes границ координатора: discovery/source/recorder + общий
 * журнал вызовов для ассертов точного порядка открытия (PART 35).
 *
 * @remarks
 * Fake-и структурные и УЗКИЕ — реализуют ровно порты координатора
 * (`CollectionDiscovery`/`CollectionSource`/`CollectionRecorder`).
 * SDK-модели (`gammaMarket`) строятся литералами с одним `as`-приведением:
 * `@polymarket/bindings` — чистый ESM, недоступный runtime-у CJS-jest
 * (type-импорты стираются и безопасны).
 */
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal нужен для VO-полей candidate-фикстур (та же граница, что у Discovery V2)
import Decimal from 'decimal.js';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import { asCryptoAssetId, asInstrumentId, asMarketId } from '@polymarket/ids';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import { TimestampService } from '@polymarket/timestamp';
import type { Timestamp } from '@polymarket/timestamp';
import { Money, Price, Quantity } from '@polymarket/value-objects';
import type {
  PolymarketDiscoveredMarket,
  PolymarketGammaEvent,
  PolymarketGammaMarket,
  PolymarketOpenSubscription,
  PolymarketRtdsFeed,
  SelectedPolymarketMarket,
} from '@polymarket/polymarket-v2';
import type { PolymarketRecordingRegistration } from '@polymarket/external-message-recorder';
import type {
  CollectionDiscovery,
  CollectionRecorder,
  CollectionSource,
} from '../../src/index.js';

/** Фиксированное «сейчас» тестов координатора (2026-08-19T12:00:00Z). */
export const NOW_MS = Date.parse('2026-08-19T12:00:00.000Z');

/** Реалистичные идентификаторы BTC-рынка. */
export const CID_A = `0x${'a'.repeat(64)}`;
export const CID_B = `0x${'b'.repeat(64)}`;
export const TOKEN_UP = '111';
export const TOKEN_DOWN = '222';

/** RTDS-фиды BTC (оба vendor topic). */
export const BTC_FEEDS: readonly PolymarketRtdsFeed[] = [
  { topic: 'prices.crypto.chainlink', symbol: 'btc/usd' },
  { topic: 'prices.crypto.binance', symbol: 'btcusdt' },
];

/** Управляемые часы. */
export class FixedClock implements IClock {
  constructor(private _nowMs: number = NOW_MS) {}

  public now(): Date {
    return new Date(this._nowMs);
  }

  public advance(deltaMs: number): void {
    this._nowMs += deltaMs;
  }
}

/** Запись лога для ассертов. */
export interface CapturedLogEntry {
  readonly level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  readonly message: string;
  readonly context?: Record<string, unknown> | undefined;
}

/** Логгер, накапливающий записи в память (child возвращает тот же sink). */
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

  public byLevel(level: CapturedLogEntry['level']): CapturedLogEntry[] {
    return this.entries.filter((entry) => entry.level === level);
  }
}

/** Обязательный typed Timestamp из ms (fixtures). */
export function ts(ms: number): Timestamp {
  const result = TimestampService.create(ms);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

/** Обязательный typed MarketId (fixtures). */
export function mid(conditionId: string): MarketId {
  const marketId = asMarketId(conditionId);
  if (marketId === undefined) {
    throw new Error(`invalid MarketId fixture: ${conditionId}`);
  }
  return marketId;
}

/** Обязательный typed InstrumentId (fixtures). */
export function iid(raw: string): InstrumentId {
  const instrumentId = asInstrumentId(raw);
  if (instrumentId === undefined) {
    throw new Error(`invalid InstrumentId fixture: ${raw}`);
  }
  return instrumentId;
}

/** Параметры фикстуры выбранного рынка. */
export interface SelectedFixtureOptions {
  readonly conditionId?: string;
  readonly question?: string;
  readonly tokenIds?: readonly string[];
  readonly expiresAtMs?: number;
  /** ms точного начала события; `null` — события/startTime нет. */
  readonly eventStartsAtMs?: number | null;
  readonly rtdsFeeds?: readonly PolymarketRtdsFeed[];
  /** Байты паддинга gammaMarket (тесты бюджета header). */
  readonly gammaMarketPadding?: number;
  /** Включить gammaEvent; число — байты его паддинга (тесты бюджета header). */
  readonly gammaEventPadding?: number;
}

/**
 * Строит `SelectedPolymarketMarket` (результат prepareSelected).
 *
 * @param options - Переопределения (дефолт: BTC-рынок, событие через 10 мин,
 *   истечение через 70 мин, оба RTDS-фида)
 */
export function createSelected(options: SelectedFixtureOptions = {}): SelectedPolymarketMarket {
  const {
    conditionId = CID_A,
    question = 'Bitcoin Up or Down - fixture',
    tokenIds = [TOKEN_UP, TOKEN_DOWN],
    expiresAtMs = NOW_MS + 70 * 60_000,
    eventStartsAtMs = NOW_MS + 10 * 60_000,
    rtdsFeeds = BTC_FEEDS,
    gammaMarketPadding,
    gammaEventPadding,
  } = options;

  const gammaMarket = {
    id: '516789',
    conditionId,
    question,
    state: { active: true, closed: false },
    ...(gammaMarketPadding !== undefined ? { padding: 'x'.repeat(gammaMarketPadding) } : {}),
  } as unknown as PolymarketGammaMarket;

  const gammaEvent =
    gammaEventPadding !== undefined
      ? ({
          id: '99001',
          slug: 'fixture-event',
          title: 'Fixture Event',
          markets: [gammaMarket], // header обязан их выбросить
          padding: 'y'.repeat(gammaEventPadding),
        } as unknown as PolymarketGammaEvent)
      : undefined;

  return {
    marketId: mid(conditionId),
    gammaMarketId: '516789',
    slug: 'fixture-slug',
    question,
    outcomes: tokenIds.map((tokenId, index) => ({
      label: index === 0 ? 'Up' : 'Down',
      instrumentId: iid(tokenId),
    })),
    expiresAt: ts(expiresAtMs),
    ...(eventStartsAtMs !== null ? { eventStartsAt: ts(eventStartsAtMs) } : {}),
    event: { id: '99001', slug: 'fixture-event', title: 'Fixture Event' },
    ...(rtdsFeeds.length > 0
      ? {
          crypto: {
            source: 'chainlink' as const,
            asset: asCryptoAssetId('btc')!,
            binanceSymbol: 'BTCUSDT',
            feeds: rtdsFeeds,
          },
        }
      : {}),
    rtdsFeeds,
    gammaMarket,
    ...(gammaEvent !== undefined ? { gammaEvent } : {}),
  };
}

/**
 * Строит кандидата Discovery V2 (вход openMarket/fillSlots).
 *
 * @param options - Переопределения тех же логических полей
 */
export function createCandidate(options: SelectedFixtureOptions = {}): PolymarketDiscoveredMarket {
  const {
    conditionId = CID_A,
    question = 'Bitcoin Up or Down - fixture',
    tokenIds = [TOKEN_UP, TOKEN_DOWN],
    expiresAtMs = NOW_MS + 70 * 60_000,
  } = options;
  const instrumentId = asInstrumentId(tokenIds[0] ?? TOKEN_UP);
  if (instrumentId === undefined) {
    throw new Error('invalid InstrumentId fixture');
  }
  return {
    marketId: mid(conditionId),
    instrumentId,
    question,
    expiresAt: ts(expiresAtMs),
    tickSize: Price.of(new Decimal('0.01')),
    minOrderSize: Quantity.of(new Decimal('5')),
    minOrderValue: Money.of(new Decimal('1'), 'USDC'),
    active: true,
    liquidity: Money.of(new Decimal('15000'), 'USDC'),
    score: new Decimal(0),
    allTokenIds: tokenIds,
    sdkMarket: {
      id: '516789',
      conditionId,
      question,
    } as unknown as PolymarketGammaMarket,
  };
}

/**
 * Fake Discovery: candidate cache + prepareSelected по карте.
 */
export class FakeDiscovery implements CollectionDiscovery {
  /** Кандидаты findCandidates. */
  public candidates: readonly PolymarketDiscoveredMarket[] = [];
  /** Результаты prepareSelected по sourceMarketId. */
  public readonly selectedByMarket = new Map<string, SelectedPolymarketMarket>();
  /** Если задано — prepareSelected бросает эту ошибку. */
  public prepareError: unknown;
  /** Hook, вызываемый в начале prepareSelected (например, сдвиг часов). */
  public onPrepareSelected: (() => void) | undefined;
  /** Счётчики вызовов. */
  public refreshCalls = 0;
  public findCalls = 0;
  public readonly prepareCalls: string[] = [];

  constructor(private readonly _log?: CallLog) {}

  public async refresh(): Promise<void> {
    this.refreshCalls++;
  }

  public async findCandidates(): Promise<readonly PolymarketDiscoveredMarket[]> {
    this.findCalls++;
    return this.candidates;
  }

  public async prepareSelected(
    candidate: PolymarketDiscoveredMarket,
  ): Promise<SelectedPolymarketMarket> {
    const key = String(candidate.marketId);
    this.prepareCalls.push(key);
    this._log?.push(`discovery.prepareSelected:${key}`);
    this.onPrepareSelected?.();
    if (this.prepareError !== undefined) {
      throw this.prepareError;
    }
    const selected = this.selectedByMarket.get(key);
    if (selected === undefined) {
      throw new Error(`FakeDiscovery has no selected fixture for ${key}`);
    }
    return selected;
  }

  /** Регистрирует пару candidate/selected одним вызовом. */
  public addMarket(options: SelectedFixtureOptions = {}): PolymarketDiscoveredMarket {
    const candidate = createCandidate(options);
    this.selectedByMarket.set(String(candidate.marketId), createSelected(options));
    this.candidates = [...this.candidates, candidate];
    return candidate;
  }
}

/** Общий журнал вызовов для ассертов порядка. */
export class CallLog {
  public readonly entries: string[] = [];

  public push(entry: string): void {
    this.entries.push(entry);
  }

  /** Индекс первой записи с данным префиксом (-1 — не найдено). */
  public indexOf(prefix: string): number {
    return this.entries.findIndex((entry) => entry.startsWith(prefix));
  }
}

/** Открытая fake-подписка source с журналом close. */
export class FakeOpenSubscription implements PolymarketOpenSubscription {
  public closeCalls = 0;

  constructor(
    private readonly _label: string,
    private readonly _log?: CallLog,
  ) {}

  public readonly close = async (): Promise<void> => {
    this.closeCalls++;
    this._log?.push(`close:${this._label}`);
  };
}

/**
 * Fake Source: journaled подписки с управляемыми задержками/отказами.
 */
export class FakeCollectionSource implements CollectionSource {
  /** Открытые market-подписки в порядке вызовов. */
  public readonly marketSubscriptions: FakeOpenSubscription[] = [];
  /** Открытые RTDS-подписки по `topic:symbol`. */
  public readonly rtdsSubscriptions = new Map<string, FakeOpenSubscription>();
  /** Вызовы subscribeMarket (tokenIds). */
  public readonly subscribeMarketCalls: Array<readonly string[]> = [];
  /** Вызовы subscribeCryptoPrices (`topic:symbol`). */
  public readonly subscribeCryptoCalls: string[] = [];
  /** Если задано — subscribeMarket бросает. */
  public subscribeMarketError: unknown;
  /** Если задано — subscribeCryptoPrices для этого `topic:symbol` бросает. */
  public readonly cryptoErrors = new Map<string, unknown>();
  /** Если задан — subscribeMarket ждёт этот promise перед разрешением. */
  public subscribeMarketHold: Promise<void> | undefined;
  /** Если задан — subscribeCryptoPrices ждёт этот promise. */
  public subscribeCryptoHold: Promise<void> | undefined;
  /** Hook, вызываемый ВНУТРИ subscribeMarket до разрешения (PART 36). */
  public onSubscribeMarket: ((tokenIds: readonly string[]) => void | Promise<void>) | undefined;
  /** Сигнал терминального отказа source (контракт `PolymarketSource.hasFailed`). */
  public hasFailed = false;

  constructor(private readonly _log?: CallLog) {}

  public readonly subscribeMarket = async (
    tokenIds: readonly string[],
  ): Promise<PolymarketOpenSubscription> => {
    this.subscribeMarketCalls.push(tokenIds);
    this._log?.push(`source.subscribeMarket:${tokenIds.join(',')}`);
    if (this.onSubscribeMarket !== undefined) {
      await this.onSubscribeMarket(tokenIds);
    }
    if (this.subscribeMarketHold !== undefined) {
      await this.subscribeMarketHold;
    }
    if (this.subscribeMarketError !== undefined) {
      throw this.subscribeMarketError;
    }
    const subscription = new FakeOpenSubscription(`market:${tokenIds[0] ?? ''}`, this._log);
    this.marketSubscriptions.push(subscription);
    return subscription;
  };

  public readonly subscribeCryptoPrices = async (
    topic: 'prices.crypto.binance' | 'prices.crypto.chainlink',
    symbols: readonly string[],
  ): Promise<PolymarketOpenSubscription> => {
    // Координатор подписывает фиды по одному символу — допущение ключа явное
    if (symbols.length !== 1) {
      throw new Error(`FakeCollectionSource expects exactly one symbol, got: ${symbols.join(',')}`);
    }
    const key = `${topic}:${symbols.join(',')}`;
    this.subscribeCryptoCalls.push(key);
    this._log?.push(`source.subscribeCryptoPrices:${key}`);
    if (this.subscribeCryptoHold !== undefined) {
      await this.subscribeCryptoHold;
    }
    const error = this.cryptoErrors.get(key);
    if (error !== undefined) {
      throw error;
    }
    const subscription = new FakeOpenSubscription(`rtds:${key}`, this._log);
    this.rtdsSubscriptions.set(key, subscription);
    return subscription;
  };
}

/**
 * Fake Recorder: журналирует регистрации/финализации.
 */
export class FakeCollectionRecorder implements CollectionRecorder {
  /** Все регистрации в порядке вызовов. */
  public readonly registrations: PolymarketRecordingRegistration[] = [];
  /** Финализации `key:reason`. */
  public readonly finalizations: string[] = [];
  /** Заморозки датасетов в порядке вызовов. */
  public readonly seals: string[] = [];
  /** Возвращаемое значение registerMarket. */
  public registerResult = true;
  /** Возвращаемое значение sealMarket. */
  public sealResult = true;
  /** Если задано — finalizeMarket бросает. */
  public finalizeError: unknown;

  constructor(private readonly _log?: CallLog) {}

  public readonly registerMarket = (registration: PolymarketRecordingRegistration): boolean => {
    this.registrations.push(registration);
    this._log?.push(`recorder.registerMarket:${String(registration.marketMeta.marketId)}`);
    return this.registerResult;
  };

  public readonly sealMarket = async (marketId: MarketId): Promise<boolean> => {
    this.seals.push(String(marketId));
    this._log?.push(`recorder.sealMarket:${String(marketId)}`);
    return this.sealResult;
  };

  public readonly finalizeMarket = async (
    marketId: MarketId,
    reason: 'EXPIRED' | 'SHUTDOWN',
  ): Promise<void> => {
    this.finalizations.push(`${String(marketId)}:${reason}`);
    this._log?.push(`recorder.finalizeMarket:${String(marketId)}:${reason}`);
    if (this.finalizeError !== undefined) {
      throw this.finalizeError;
    }
  };
}

/** Управляемый deferred для hold-сценариев. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Дожидается осушения microtask/immediate очередей. */
export async function flushAsync(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/**
 * Дожидается выполнения условия (граница async-транзакции вместо счёта тиков).
 *
 * @param predicate - Проверяемое условие
 * @param timeoutMs - Предел ожидания
 * @throws {Error} Если условие не наступило за timeoutMs
 */
export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}
