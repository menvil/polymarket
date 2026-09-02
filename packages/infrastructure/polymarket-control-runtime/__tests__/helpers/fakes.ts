/**
 * Подделки и фикстуры тестов прямой оркестрации control-plane.
 *
 * @remarks
 * ### Что подделывается, а что берётся настоящим
 *
 * ```text
 * НАСТОЯЩИЕ:  MarketUniverse, PolymarketPolicy, Planner, Controller, Market
 * ПОДДЕЛЬНЫЕ: vendor-граница (каталог + транспорт подписок) и часы
 * ```
 *
 * Проверяемые правила — про приобретение и удержание рынков, и на моках
 * планировщика или контроллера они проверялись бы против выдуманного
 * поведения. Подделана ровно та граница, за которой сеть: обход каталога,
 * подготовка рынка и открытие подписок.
 *
 * ### Одна подделка discovery на два контракта
 *
 * `FakeDiscovery` реализует и `ControlRuntimeDiscovery` (`refresh`/
 * `getSnapshot`), и `SubscriptionDiscovery` (`prepareMarket`) — так же, как
 * это делает РЕАЛЬНЫЙ `PolymarketMarketDiscovery`. Две отдельные подделки
 * позволили бы собрать невозможный мир, где universe знает рынок, а
 * vendor-подготовки для него нет вопреки атомарной замене снимка.
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
import { parsePolymarketPolicyConfig } from '@polymarket/policy';
import type { PolymarketPolicy } from '@polymarket/policy';
import type { MarketDiscoveryEntry, MarketDiscoverySnapshot } from '@polymarket/ports';
import type { IClock } from '@polymarket/time';
import type { ILogger } from '@polymarket/logger';
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
} from '@polymarket/polymarket-subscription-control';
import type { ControlRuntimeDiscovery } from '../../src/index.js';

/** Опорные моменты сценариев (UTC). */
export const AT_1750_MS = Date.parse('2026-09-01T17:50:00.000Z');
export const AT_1757_MS = Date.parse('2026-09-01T17:57:00.000Z');
export const AT_1758_MS = Date.parse('2026-09-01T17:58:00.000Z');
export const AT_1800_MS = Date.parse('2026-09-01T18:00:00.000Z');
export const AT_1800_01_MS = Date.parse('2026-09-01T18:00:01.000Z');
export const AT_1805_MS = Date.parse('2026-09-01T18:05:00.000Z');
export const AT_1810_MS = Date.parse('2026-09-01T18:10:00.000Z');

/** Пять минут в миллисекундах. */
export const FIVE_MIN_MS = 5 * 60_000;

/** Spot-фид Binance по BTC. */
export const BTC_BINANCE_FEED: PolymarketRtdsFeed = {
  topic: 'prices.crypto.binance',
  symbol: 'btcusdt',
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
  /** Сколько раз рантайм прочитал часы (проверка «один `now` на тик»). */
  public reads = 0;

  public constructor(private _ms: number) {}

  /**
   * Текущий момент часов.
   *
   * @returns Дата текущего момента
   */
  public now(): Date {
    this.reads += 1;
    return new Date(this._ms);
  }

  /**
   * Переводит часы на заданный момент.
   *
   * @param ms - Новый момент epoch
   *
   * @example
   * ```typescript
   * clock.set(AT_1800_01_MS); // рынок X стартовал
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

/** Параметры фикстуры canonical записи universe. */
export interface EntryOptions {
  /** Id рынка (влияет и на инструменты исходов). */
  readonly id?: string;
  /** Базовый криптоактив. */
  readonly asset?: string;
  /** Начало торгов. */
  readonly startsAtMs?: number;
  /** НОМИНАЛ серии (`crypto.duration`). */
  readonly nominalMs?: number;
  /** ФАКТИЧЕСКОЕ окно рынка (по умолчанию совпадает с номиналом). */
  readonly windowMs?: number;
  /** Площадка рынка. */
  readonly venueId?: VenueId;
  /** Ликвидность наблюдения (USDC). */
  readonly liquidity?: number;
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
 * const x = makeEntry({ id: 'btc-1800', startsAtMs: AT_1800_MS });
 * ```
 */
export function makeEntry(options: EntryOptions = {}): MarketDiscoveryEntry {
  const {
    id = 'market-x',
    asset = 'btc',
    startsAtMs = AT_1800_MS,
    nominalMs = FIVE_MIN_MS,
    windowMs = nominalMs,
    venueId = KnownVenues.POLYMARKET,
    liquidity = 1000,
  } = options;

  const duration = asMarketDuration(nominalMs);
  if (duration === undefined) throw new Error(`bad duration fixture: ${String(nominalMs)}`);

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

  const money = MoneyService.create(liquidity, 'USDC');
  if (!money.ok) throw new Error('bad money fixture');

  return { market: created.value, metrics: { liquidity: money.value } };
}

/**
 * Собирает vendor-подготовку, согласованную с canonical записью.
 *
 * @param entry - Canonical запись
 * @returns `SelectedPolymarketMarket` для этой записи
 *
 * @remarks
 * Typed Gamma-модели подставляются точечным `as unknown as`: ни контроллер,
 * ни рантайм их не читают вовсе, а полная нормализованная модель была бы
 * сотней строк шума, не участвующего ни в одном проверяемом правиле.
 */
export function makeSelected(entry: MarketDiscoveryEntry): SelectedPolymarketMarket {
  const marketId = String(entry.market.id);
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
    slug: `${marketId}-slug`,
    question: entry.market.question,
    outcomes: [
      { label: 'Up', instrumentId: entry.market.outcomes[0].instrumentId },
      { label: 'Down', instrumentId: entry.market.outcomes[1].instrumentId },
    ],
    expiresAt: entry.market.expiresAt,
    eventStartsAt: entry.market.startsAt,
    event: { id: '99001', slug: 'fixture-event', title: 'Fixture Event' },
    crypto: {
      source: 'chainlink',
      asset: unsafeCryptoAssetId(String(entry.market.crypto?.asset ?? 'btc')),
      binanceSymbol: 'BTCUSDT',
      feeds: [BTC_BINANCE_FEED],
    },
    rtdsFeeds: [BTC_BINANCE_FEED],
    gammaMarket,
    gammaEvent,
  };
}

/**
 * Собирает снимок обхода каталога из готовых записей.
 *
 * @param entries - Записи снимка
 * @param observedAtMs - Момент обхода
 * @returns Замороженный снимок (как его отдаёт реальный discovery)
 */
export function makeSnapshot(
  entries: readonly MarketDiscoveryEntry[],
  observedAtMs: number,
): MarketDiscoverySnapshot {
  return Object.freeze({
    observedAt: ts(observedAtMs),
    entries: Object.freeze([...entries]),
    diagnostics: Object.freeze({
      pagesFetched: 1,
      marketsScanned: entries.length,
      tradeableMarkets: entries.length,
      unsupportedMarkets: 0,
      supportedCryptoUpDown: entries.length,
      invalidMarkets: Object.freeze({
        total: 0,
        classification: 0,
        eventUnavailable: 0,
        schedule: 0,
        seriesDuration: 0,
        canonicalMapping: 0,
      }),
      duplicateMarkets: 0,
      eventFetches: 0,
      eventFetchFailures: 0,
      eventCacheHits: 0,
    }),
  });
}

/**
 * Подделка vendor-границы каталога: обход, снимок и подготовка рынков.
 *
 * @remarks
 * Повторяет last-good семантику реального discovery: неудачный `refresh()`
 * возвращает `false` и НЕ трогает ни снимок, ни vendor-записи — доступным
 * остаётся предыдущий обход.
 *
 * @example
 * ```typescript
 * const discovery = new FakeDiscovery();
 * discovery.stage([x, y], AT_1757_MS);   // что отдаст следующий успешный обход
 * discovery.refreshOutcome = false;      // ... а он не удастся
 * ```
 */
export class FakeDiscovery implements ControlRuntimeDiscovery, SubscriptionDiscovery {
  /** Сколько раз рантайм обходил каталог. */
  public refreshCalls = 0;
  /** Исход следующего обхода. */
  public refreshOutcome = true;

  /** Последний УСПЕШНЫЙ снимок (last-good). */
  private _snapshot: MarketDiscoverySnapshot = makeSnapshot([], 0);
  /** Снимок, который опубликует следующий успешный обход. */
  private _staged: MarketDiscoverySnapshot | null = null;
  /** Vendor-записи last-good снимка. */
  private _prepared = new Map<string, SelectedPolymarketMarket>();
  /** Vendor-записи подготовленного снимка. */
  private _stagedPrepared = new Map<string, SelectedPolymarketMarket>();

  /**
   * Готовит содержимое следующего успешного обхода.
   *
   * @param entries - Записи будущего снимка
   * @param observedAtMs - Момент обхода
   */
  public stage(entries: readonly MarketDiscoveryEntry[], observedAtMs: number): void {
    this._staged = makeSnapshot(entries, observedAtMs);
    this._stagedPrepared = new Map(
      entries.map((entry) => [String(entry.market.id), makeSelected(entry)]),
    );
  }

  /**
   * Убирает vendor-подготовку рынка, оставляя его в universe.
   *
   * @param marketId - Id рынка, подготовка которого «пропала»
   *
   * @remarks
   * Моделирует рассинхронизацию, ради которой у контроллера существует
   * отказ `not-prepared`: canonical запись у вызывающего есть, а
   * vendor-данных для неё в текущем снимке больше нет.
   */
  public dropPreparation(marketId: string): void {
    this._prepared.delete(marketId);
    this._stagedPrepared.delete(marketId);
  }

  public readonly refresh = async (): Promise<boolean> => {
    this.refreshCalls += 1;
    if (!this.refreshOutcome) {
      return false;
    }
    if (this._staged !== null) {
      this._snapshot = this._staged;
      this._prepared = this._stagedPrepared;
    }
    return true;
  };

  public readonly getSnapshot = (): MarketDiscoverySnapshot => this._snapshot;

  public readonly prepareMarket = (marketId: MarketId): SelectedPolymarketMarket | undefined =>
    this._prepared.get(String(marketId));
}

/** Подписка-подделка со счётчиком закрытий. */
export class FakeOpenSubscription implements PolymarketOpenSubscription {
  public closeCalls = 0;

  public constructor(public readonly label: string) {}

  public readonly close = async (): Promise<void> => {
    this.closeCalls += 1;
  };
}

/** Подделка транспорта подписок V2: счётчики вызовов и управляемые отказы. */
export class FakeSource implements SubscriptionSource {
  /** Аргументы вызовов подписки рынка. */
  public readonly subscribeMarketCalls: Array<readonly string[]> = [];
  /** Все выданные подписки (для проверки закрытий). */
  public readonly issued: FakeOpenSubscription[] = [];
  /** Если задано — подписка рынка отказывает. */
  public subscribeMarketError: unknown;
  /** Терминальный отказ источника. */
  public hasFailed = false;
  /** Источник закрыт. */
  public isClosed = false;

  public readonly subscribeMarket = async (
    tokenIds: readonly string[],
  ): Promise<PolymarketOpenSubscription> => {
    this.subscribeMarketCalls.push(tokenIds);
    if (this.subscribeMarketError !== undefined) {
      throw this.subscribeMarketError;
    }
    return this._issue(`market:${tokenIds.join(',')}`);
  };

  public readonly subscribeCryptoPrices = async (
    topic: 'prices.crypto.binance' | 'prices.crypto.chainlink',
    symbols: readonly string[],
  ): Promise<PolymarketOpenSubscription> => this._issue(`${topic}:${symbols.join(',')}`);

  public readonly subscribeChainlinkTwap = async (
    windowSeconds: 30 | 60,
    symbols: readonly string[],
  ): Promise<PolymarketOpenSubscription> =>
    this._issue(`twap${String(windowSeconds)}:${symbols.join(',')}`);

  /**
   * Выдаёт новую подделку подписки.
   *
   * @param label - Метка подписки (для читаемости отладки)
   * @returns Подписка-подделка
   */
  private _issue(label: string): FakeOpenSubscription {
    const subscription = new FakeOpenSubscription(label);
    this.issued.push(subscription);
    return subscription;
  }
}

/**
 * Собирает policy площадки из plain-конфигурации.
 *
 * @param asset - Тикер базового актива (`btc`, `xrp`, ...)
 * @param duration - Номинал серии (`5m`, `15m`, ...)
 * @returns Canonical `PolymarketPolicy`
 * @throws {PolicyValidationError} Если конфигурация невалидна
 *
 * @remarks
 * Через `parsePolymarketPolicyConfig`, а не ручной сборкой canonical-типов:
 * тесты идут той же дверью, что и живая конфигурация, и «policy собрана
 * иначе, чем в проде» перестаёт быть возможной причиной расхождения.
 *
 * @example
 * ```typescript
 * const btc5m = policyOf('btc', '5m');
 * ```
 */
export function policyOf(asset: string, duration: string): PolymarketPolicy {
  return parsePolymarketPolicyConfig({
    kind: 'POLYMARKET',
    family: 'CRYPTO_UP_DOWN',
    assets: [asset],
    durations: [duration],
  });
}
