/**
 * Подделки и фикстуры тестов контроллера подписок.
 *
 * @remarks
 * Canonical-часть (`Market`, `MarketDiscoveryEntry`) собирается НАСТОЯЩИМИ
 * доменными фабриками: строгая граница старта и подтверждённое состояние —
 * инварианты самих доменных типов, и на моках они проверялись бы против
 * выдуманной структуры.
 *
 * Vendor-часть (`SelectedPolymarketMarket`) собирается фикстурой с точечным
 * `as unknown as` для typed Gamma-моделей: контроллер их не читает вовсе —
 * он берёт из подготовки только `outcomes`, расписание и список RTDS-фидов,
 * — а полная нормализованная Gamma-модель в фикстуре была бы сотней строк
 * шума, не участвующего ни в одном проверяемом правиле.
 *
 * Подделка источника управляема: любую подписку можно задержать (`hold`) и
 * заставить отказать. Без этого нельзя проверить ни конкурентное открытие
 * одного рынка, ни пересечение старта во время await, ни откат.
 */
import { Market, MarketState, asMarketDuration } from '@polymarket/market';
import {
  KnownVenues,
  unsafeCryptoAssetId,
  unsafeInstrumentId,
  unsafeMarketId,
} from '@polymarket/ids';
import type { MarketId, VenueId } from '@polymarket/ids';
import { TimestampService } from '@polymarket/timestamp';
import type { Timestamp } from '@polymarket/timestamp';
import { MoneyService } from '@polymarket/value-objects';
import type { MarketDiscoveryEntry } from '@polymarket/ports';
import type { IClock } from '@polymarket/time';
import type { ILogger } from '@polymarket/logger';
import { CHAINLINK_TWAP_TOPIC } from '@polymarket/polymarket-v2';
import type {
  PolymarketGammaEvent,
  PolymarketGammaMarket,
  PolymarketOpenSubscription,
  PolymarketRtdsFeed,
  SelectedPolymarketMarket,
} from '@polymarket/polymarket-v2';
import type {
  SubscriptionDiscovery,
  SubscriptionSource,
} from '../../src/index.js';

/** Опорные моменты сценариев (UTC). */
export const AT_1757_MS = Date.parse('2026-09-01T17:57:00.000Z');
export const AT_1759_59_500_MS = Date.parse('2026-09-01T17:59:59.500Z');
export const AT_1800_MS = Date.parse('2026-09-01T18:00:00.000Z');
export const AT_1800_100_MS = Date.parse('2026-09-01T18:00:00.100Z');
export const AT_1801_MS = Date.parse('2026-09-01T18:01:00.000Z');
export const AT_1805_MS = Date.parse('2026-09-01T18:05:00.000Z');

/** Пять минут в миллисекундах. */
export const FIVE_MIN_MS = 5 * 60_000;

/** Spot-фид Binance по BTC. */
export const BTC_BINANCE_FEED: PolymarketRtdsFeed = {
  topic: 'prices.crypto.binance',
  symbol: 'btcusdt',
};
/** Spot-фид Chainlink по BTC. */
export const BTC_CHAINLINK_FEED: PolymarketRtdsFeed = {
  topic: 'prices.crypto.chainlink',
  symbol: 'btc/usd',
};
/** Settlement-фид TWAP 30 секунд. */
export const BTC_TWAP_30_FEED: PolymarketRtdsFeed = {
  topic: CHAINLINK_TWAP_TOPIC,
  symbol: 'btc/usd',
  windowSeconds: 30,
};
/** Settlement-фид TWAP 60 секунд. */
export const BTC_TWAP_60_FEED: PolymarketRtdsFeed = {
  topic: CHAINLINK_TWAP_TOPIC,
  symbol: 'btc/usd',
  windowSeconds: 60,
};

/**
 * Собирает `Timestamp` из миллисекунд.
 *
 * @param ms - Момент epoch
 * @returns Canonical `Timestamp`
 * @throws {Error} Если фикстура задаёт невалидный момент
 *
 * @example
 * ```typescript
 * const startsAt = ts(AT_1800_MS);
 * ```
 */
export function ts(ms: number): Timestamp {
  const result = TimestampService.create(ms);
  if (!result.ok) throw new Error(`bad timestamp fixture: ${result.error.message}`);
  return result.value;
}

/** Управляемые часы: момент двигается тестом. */
export class MutableClock implements IClock {
  public constructor(private _ms: number) {}

  /**
   * Текущий момент часов.
   *
   * @returns Дата текущего момента
   */
  public now(): Date {
    return new Date(this._ms);
  }

  /**
   * Переводит часы на заданный момент.
   *
   * @param ms - Новый момент epoch
   *
   * @example
   * ```typescript
   * clock.set(AT_1801_MS); // рынок стартовал
   * ```
   */
  public set(ms: number): void {
    this._ms = ms;
  }
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

/** Управляемый deferred для hold-сценариев. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Подписка-подделка со счётчиком закрытий. */
export class FakeOpenSubscription implements PolymarketOpenSubscription {
  public closeCalls = 0;

  public constructor(public readonly label: string) {}

  public readonly close = async (): Promise<void> => {
    this.closeCalls += 1;
    return Promise.resolve();
  };
}

/** Параметры фикстуры canonical записи universe. */
export interface EntryOptions {
  /** Id рынка (влияет и на инструменты исходов). */
  readonly id?: string;
  /** Базовый криптоактив. */
  readonly asset?: string;
  /** Начало торгов. */
  readonly startsAtMs?: number;
  /** Фактическое окно рынка. */
  readonly windowMs?: number;
  /** Площадка рынка. */
  readonly venueId?: VenueId;
  /** Подтверждённое состояние. */
  readonly state?: 'ACTIVE' | 'CLOSED' | 'RESOLVED';
}

/**
 * Собирает canonical запись universe.
 *
 * @param options - Отклонения от базовой фикстуры
 * @returns `MarketDiscoveryEntry` с настоящим `Market`
 * @throws {Error} Если параметры нарушают инварианты `Market`
 *
 * @example
 * ```typescript
 * const entry = makeEntry({ id: 'market-x', startsAtMs: AT_1800_MS });
 * ```
 */
export function makeEntry(options: EntryOptions = {}): MarketDiscoveryEntry {
  const {
    id = 'market-x',
    asset = 'btc',
    startsAtMs = AT_1800_MS,
    windowMs = FIVE_MIN_MS,
    venueId = KnownVenues.POLYMARKET,
    state = 'ACTIVE',
  } = options;

  const duration = asMarketDuration(FIVE_MIN_MS);
  if (duration === undefined) throw new Error('bad duration fixture');

  const created = Market.create({
    id: unsafeMarketId(id),
    venueId,
    question: `${asset.toUpperCase()} Up or Down — ${id}`,
    startsAt: ts(startsAtMs),
    expiresAt: ts(startsAtMs + windowMs),
    state: MarketState.active(),
    outcomes: [
      { index: 0, label: 'Up', instrumentId: unsafeInstrumentId(`${id}-up`) },
      { index: 1, label: 'Down', instrumentId: unsafeInstrumentId(`${id}-down`) },
    ],
    family: 'CRYPTO_UP_DOWN',
    crypto: { asset: unsafeCryptoAssetId(asset), duration },
  });
  if (!created.ok) throw new Error(`bad market fixture: ${created.error.message}`);

  const liquidity = MoneyService.create(1000, 'USDC');
  if (!liquidity.ok) throw new Error('bad money fixture');

  return { market: applyState(created.value, state), metrics: { liquidity: liquidity.value } };
}

/**
 * Переводит рынок в требуемое состояние ШТАТНЫМИ переходами.
 *
 * @param market - Рынок в состоянии ACTIVE
 * @param state - Требуемое состояние
 * @returns Рынок в этом состоянии
 * @throws {Error} Если домен отверг переход
 */
function applyState(market: Market, state: 'ACTIVE' | 'CLOSED' | 'RESOLVED'): Market {
  if (state === 'ACTIVE') return market;
  const closed = market.markClosed();
  if (!closed.ok) throw new Error(`bad state fixture: ${closed.error.message}`);
  if (state === 'CLOSED') return closed.value;
  const resolved = closed.value.markResolved(0);
  if (!resolved.ok) throw new Error(`bad state fixture: ${resolved.error.message}`);
  return resolved.value;
}

/** Параметры фикстуры vendor-подготовки. */
export interface SelectedOptions {
  /** Id рынка подготовки (по умолчанию — id записи). */
  readonly marketId?: string;
  /** Начало события (по умолчанию — начало торгов записи). */
  readonly eventStartsAtMs?: number;
  /** Истечение (по умолчанию — истечение записи). */
  readonly expiresAtMs?: number;
  /** RTDS-фиды рынка. */
  readonly rtdsFeeds?: readonly PolymarketRtdsFeed[];
}

/**
 * Собирает vendor-подготовку рынка, согласованную с canonical записью.
 *
 * @param entry - Canonical запись
 * @param options - Точечные расхождения (для проверки устаревшей подготовки)
 * @returns `SelectedPolymarketMarket`
 *
 * @example
 * ```typescript
 * // подготовка от ДРУГОЙ версии записи:
 * makeSelected(entry, { eventStartsAtMs: AT_1805_MS });
 * ```
 */
export function makeSelected(
  entry: MarketDiscoveryEntry,
  options: SelectedOptions = {},
): SelectedPolymarketMarket {
  const {
    marketId = String(entry.market.id),
    eventStartsAtMs = entry.market.startsAt.toNumber(),
    expiresAtMs = entry.market.expiresAt.toNumber(),
    rtdsFeeds = [BTC_BINANCE_FEED, BTC_CHAINLINK_FEED],
  } = options;

  const gammaMarket = {
    id: '516789',
    conditionId: marketId,
    question: entry.market.question,
  } as unknown as PolymarketGammaMarket;
  const gammaEvent = {
    id: '99001',
    slug: 'fixture-event',
    title: 'Fixture Event',
  } as unknown as PolymarketGammaEvent;

  return {
    marketId: unsafeMarketId(marketId),
    gammaMarketId: '516789',
    slug: 'fixture-slug',
    question: entry.market.question,
    outcomes: [
      { label: 'Up', instrumentId: entry.market.outcomes[0].instrumentId },
      { label: 'Down', instrumentId: entry.market.outcomes[1].instrumentId },
    ],
    expiresAt: ts(expiresAtMs),
    eventStartsAt: ts(eventStartsAtMs),
    event: { id: '99001', slug: 'fixture-event', title: 'Fixture Event' },
    crypto: {
      source: 'chainlink',
      asset: unsafeCryptoAssetId(String(entry.market.crypto?.asset ?? 'btc')),
      binanceSymbol: 'BTCUSDT',
      feeds: rtdsFeeds,
    },
    rtdsFeeds,
    gammaMarket,
    gammaEvent,
  };
}

/** Подделка подготовки рынков: карта `marketId → SelectedPolymarketMarket`. */
export class FakeDiscovery implements SubscriptionDiscovery {
  /** Подготовки по `String(marketId)`; отсутствие = подготовка недоступна. */
  public readonly prepared = new Map<string, SelectedPolymarketMarket>();
  /** Сколько раз спрашивали подготовку. */
  public prepareCalls = 0;

  /**
   * Регистрирует подготовку рынка.
   *
   * @param entry - Canonical запись
   * @param options - Точечные расхождения подготовки
   * @returns Зарегистрированная подготовка
   */
  public register(
    entry: MarketDiscoveryEntry,
    options: SelectedOptions = {},
  ): SelectedPolymarketMarket {
    const selected = makeSelected(entry, options);
    this.prepared.set(String(entry.market.id), selected);
    return selected;
  }

  public readonly prepareMarket = (marketId: MarketId): SelectedPolymarketMarket | undefined => {
    this.prepareCalls += 1;
    return this.prepared.get(String(marketId));
  };
}

/** Подделка источника подписок V2: счётчики вызовов, задержки, отказы. */
export class FakeSource implements SubscriptionSource {
  /** Аргументы вызовов подписки рынка. */
  public readonly subscribeMarketCalls: Array<readonly string[]> = [];
  /** Аргументы вызовов spot-подписок. */
  public readonly cryptoCalls: Array<{ topic: string; symbols: readonly string[] }> = [];
  /** Аргументы вызовов settlement-подписок TWAP. */
  public readonly twapCalls: Array<{ windowSeconds: number; symbols: readonly string[] }> = [];
  /** Все выданные подписки (для проверки закрытий). */
  public readonly issued: FakeOpenSubscription[] = [];

  /** Если задано — подписка рынка ждёт этот promise. */
  public subscribeMarketHold: Promise<void> | undefined;
  /** Если задано — подписка рынка отказывает. */
  public subscribeMarketError: unknown;
  /** Если задано — RTDS-подписка ждёт этот promise. */
  public rtdsHold: Promise<void> | undefined;
  /** Символы RTDS, на которых подписка отказывает. */
  public readonly rtdsErrorSymbols = new Set<string>();

  /** Терминальный отказ источника. */
  public hasFailed = false;
  /** Источник закрыт. */
  public isClosed = false;

  public readonly subscribeMarket = async (
    tokenIds: readonly string[],
  ): Promise<PolymarketOpenSubscription> => {
    this.subscribeMarketCalls.push(tokenIds);
    if (this.subscribeMarketHold !== undefined) {
      await this.subscribeMarketHold;
    }
    if (this.subscribeMarketError !== undefined) {
      throw this.subscribeMarketError;
    }
    return this._issue(`market:${tokenIds.join(',')}`);
  };

  public readonly subscribeCryptoPrices = async (
    topic: 'prices.crypto.binance' | 'prices.crypto.chainlink',
    symbols: readonly string[],
  ): Promise<PolymarketOpenSubscription> => {
    this.cryptoCalls.push({ topic, symbols });
    return this._openFeed(`${topic}:${symbols.join(',')}`, symbols);
  };

  public readonly subscribeChainlinkTwap = async (
    windowSeconds: 30 | 60,
    symbols: readonly string[],
  ): Promise<PolymarketOpenSubscription> => {
    this.twapCalls.push({ windowSeconds, symbols });
    return this._openFeed(
      `${CHAINLINK_TWAP_TOPIC}:${symbols.join(',')}@${String(windowSeconds)}`,
      symbols,
    );
  };

  /** Сколько физических RTDS-подписок открыто всего. */
  public get rtdsCallCount(): number {
    return this.cryptoCalls.length + this.twapCalls.length;
  }

  /**
   * Открывает подделку RTDS-подписки с учётом задержек и отказов.
   *
   * @param label - Метка подписки
   * @param symbols - Символы фида
   * @returns Открытая подделка подписки
   * @throws {Error} Если символ помечен как отказывающий
   */
  private async _openFeed(
    label: string,
    symbols: readonly string[],
  ): Promise<PolymarketOpenSubscription> {
    if (this.rtdsHold !== undefined) {
      await this.rtdsHold;
    }
    if (symbols.some((symbol) => this.rtdsErrorSymbols.has(symbol))) {
      throw new Error(`RTDS subscribe failed: ${label}`);
    }
    return this._issue(label);
  }

  /**
   * Выдаёт новую подделку подписки.
   *
   * @param label - Метка подписки
   * @returns Подделка подписки
   */
  private _issue(label: string): FakeOpenSubscription {
    const subscription = new FakeOpenSubscription(label);
    this.issued.push(subscription);
    return subscription;
  }
}
