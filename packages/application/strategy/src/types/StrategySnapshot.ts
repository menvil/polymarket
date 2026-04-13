/**
 * Readonly snapshot состояния — передаётся стратегии в tick().
 *
 * @remarks
 * ### Принцип сборки:
 * StrategyScheduler собирает snapshot **синхронно** из in-memory stores.
 * Все данные доступны за O(1) — без async, без сетевых вызовов.
 *
 * ### Иммутабельность:
 * Все поля readonly. Portfolio и Market — иммутабельные domain entities
 * (мутации возвращают новый экземпляр). Стратегия не может изменить state.
 *
 * ### Что стратегия может узнать из snapshot:
 * - Рыночные данные: topOfBook, bookHistory, tradeTape
 * - Рынок: market.expiresAt, market.question, market.state
 * - Ордера: openOrders этой стратегии на этом инструменте
 * - Баланс: portfolio.balance.available(), portfolio.balance.reserved()
 * - Позиция: portfolio.getPosition(instrumentId)
 * - Доступные токены: portfolio.availableTokenQuantity(instrumentId)
 *
 * @example
 * ```typescript
 * // В tick():
 * const { topOfBook, portfolio, market, openOrders, nowMs } = snapshot;
 * if (!topOfBook || !portfolio) return [];
 *
 * const position = portfolio.getPosition(snapshot.instrumentId);
 * const availableUSDC = portfolio.balance.available();
 * const timeToExpiry = market.expiresAt.toNumber() - nowMs;
 * ```
 */
import type { InstrumentId, AssetId } from '@polymarket/ids';
import type { TopOfBook } from '@polymarket/event-bus';
import type { OrderBookHistory } from '@polymarket/order-book';
import type { TradeTape } from '@polymarket/trade-tape';
import type { Order } from '@polymarket/order';
import type { Portfolio } from '@polymarket/portfolio';
import type { Market } from '@polymarket/market';
import type { InstrumentConstraints } from './InstrumentConstraints.js';

export type CryptoPriceSource =
  | 'polymarket_chainlink'
  | 'polymarket_binance'
  | 'cex_binance'
  | 'cex_coinbase'
  | 'cex_okx'
  | 'cex_cryptocom'
  | 'cex_kraken';

export type CexVenue = 'binance' | 'coinbase' | 'okx' | 'cryptocom' | 'kraken';

export interface CryptoPricePoint {
  readonly asset: string;
  readonly source: CryptoPriceSource;
  readonly price: number;
  readonly exchangeTsMs: number;
  readonly receivedTsMs: number;
}

export interface CexBookTick {
  readonly asset: string;
  readonly venue: CexVenue;
  readonly symbol: string;
  readonly exchangeTsMs: number;
  readonly receivedTsMs: number;
  readonly bids: readonly (readonly [number, number])[];
  readonly asks: readonly (readonly [number, number])[];
}

export interface CexTradeTick {
  readonly asset: string;
  readonly venue: CexVenue;
  readonly symbol: string;
  readonly exchangeTsMs: number;
  readonly receivedTsMs: number;
  readonly price: number;
  readonly size: number;
  readonly side?: 'buy' | 'sell';
}

export interface CexVenueState {
  readonly asset: string;
  readonly venue: CexVenue;
  readonly symbol: string;
  readonly bid: number;
  readonly ask: number;
  readonly mid: number;
  readonly microprice: number;
  readonly spreadBps: number;
  readonly imbalanceTop: number;
  readonly lastBookTsMs: number;
  readonly lastReceivedTsMs: number;
  readonly recentTradePressure: number;
}

export interface CryptoPriceHistoryView {
  readonly asset: string;
  getLatest(source: CryptoPriceSource): CryptoPricePoint | undefined;
  getRecent(source: CryptoPriceSource, lookbackMs: number): readonly CryptoPricePoint[];
  getMerged(sources: readonly CryptoPriceSource[], lookbackMs: number): readonly CryptoPricePoint[];
}

export interface CryptoVenueStateView {
  readonly asset: string;
  get(venue: CexVenue): CexVenueState | undefined;
  getAll(): readonly CexVenueState[];
}

export interface CryptoVenueHistoryView {
  readonly asset: string;
  getRecentBooks(venue: CexVenue, lookbackMs: number): readonly CexBookTick[];
  getRecentTrades(venue: CexVenue, lookbackMs: number): readonly CexTradeTick[];
}

export type CryptoSignalDirection = 'up' | 'down' | 'flat';

export interface CryptoSignalResult {
  readonly id: string;
  readonly asset: string;
  readonly tsMs: number;
  readonly value: number;
  readonly unit: 'bps' | 'price' | 'score';
  readonly direction: CryptoSignalDirection;
  readonly strength: number;
  readonly confidence: number;
  readonly stale: boolean;
  readonly components: Readonly<Record<string, number | string | boolean>>;
}

export interface CryptoSignalRequest {
  readonly venues?: readonly CexVenue[];
  readonly sources?: readonly CryptoPriceSource[];
  readonly weights?: Readonly<Record<string, number>>;
  readonly basisByVenue?: Readonly<Record<string, number>>;
  readonly minVenueCount?: number;
  readonly maxSpreadBps?: number;
  readonly confidenceByScore?: Readonly<Record<string, number>>;
  readonly lookbackMs?: number;
  readonly staleMs?: number;
  readonly thresholdBps?: number;
}

export interface CryptoSignalRegistryView {
  list(): readonly string[];
  evaluate(signalId: string, request?: CryptoSignalRequest): CryptoSignalResult | undefined;
}

export interface StrategySnapshot {
  /** ID инструмента (outcome token) */
  readonly instrumentId: InstrumentId;

  // ── Market ───────────────────────────────────────────────
  /**
   * Рынок целиком: экспирация, вопрос, outcomes, state.
   *
   * @remarks
   * Иммутабельный domain entity.
   * Стратегия сама считает timeToExpiry: `market.expiresAt.toNumber() - nowMs`.
   */
  readonly market: Market;

  // ── Market Data ──────────────────────────────────────────
  /**
   * Лучшие bid/ask/spread.
   *
   * @remarks
   * undefined если ещё нет данных по этому инструменту.
   */
  readonly topOfBook: TopOfBook | undefined;

  /**
   * Rolling history снапшотов стакана.
   *
   * @remarks
   * undefined если BookDepth ещё не приходил.
   * Стратегия может получить последний снапшот: `bookHistory.getLatest()`.
   */
  readonly bookHistory: OrderBookHistory | undefined;

  /**
   * Rolling лента публичных трейдов.
   *
   * @remarks
   * undefined если трейдов ещё не было.
   * Стратегия может получить срез: `tradeTape.getRecent(60_000)`.
   */
  readonly tradeTape: TradeTape | undefined;

  // ── Orders ───────────────────────────────────────────────
  /**
   * Открытые ордера ЭТОЙ стратегии на ЭТОМ инструменте.
   *
   * @remarks
   * Sync read из OrderStateStore. Пустой массив если нет ордеров.
   * НЕ включает ордера в статусе MATCHED на бирже — они в `matchedOrders`.
   */
  readonly openOrders: readonly Order[];

  /**
   * Ордера ЭТОЙ стратегии, помеченные как MATCHED на бирже (in-flight fills).
   *
   * @remarks
   * MATCHED = fill(ы) в пути (MATCHED → MINED → CONFIRMED), отменить нельзя.
   * Стратегия должна учитывать эти ордера при принятии решений:
   * - Не размещать новый BUY пока есть MATCHED BUY (иначе двойная покупка)
   * - Не пытаться отменить (отмена невозможна, fill уже on-chain)
   *
   * После CONFIRMED → fill обработан → ордер FILLED → исчезает из обоих массивов.
   */
  readonly matchedOrders: readonly Order[];

  /**
   * true если на инструменте есть in-flight fills (MATCHED/MINED, не CONFIRMED).
   *
   * @remarks
   * Instrument-level флаг: работает даже если ордер уже cancelled/deleted из repo.
   * Решает race condition: cancel → place → fill(старый) → двойная покупка.
   *
   * Отличие от `matchedOrders.length > 0`:
   * - matchedOrders ищет в repo (cancelled ордера нет) → пропускает
   * - hasInFlightFills трекает по instrumentId независимо от ордера → ловит
   */
  readonly hasInFlightFills: boolean;

  // ── Constraints ─────────────────────────────────────────
  /**
   * Ограничения инструмента: minOrderSize, minOrderValue, tickSize.
   *
   * @remarks
   * Из каталога инструментов (IMarketCatalog).
   * undefined если инструмент неизвестен каталогу.
   *
   * Стратегия использует для адаптации размеров ордеров:
   * - Если остаток после SELL < minOrderSize → продавать всё
   * - Если orderValue < minOrderValue → увеличить size или пропустить
   *
   * BaseStrategy предоставляет helpers: adjustSellSize(), adjustBuySize().
   */
  readonly constraints: InstrumentConstraints | undefined;

  // ── Portfolio ────────────────────────────────────────────
  /**
   * Portfolio целиком: balance (USDC available/reserved),
   * positions, tokenReservations.
   *
   * @remarks
   * undefined если Portfolio ещё не создан для данного аккаунта.
   * Иммутабельный domain entity — стратегия не может мутировать.
   *
   * Стратегия читает:
   * - `portfolio.balance.available()` → свободные USDC
   * - `portfolio.getPosition(instrumentId)` → позиция (qty, avgPrice)
   * - `portfolio.availableTokenQuantity(instrumentId)` → токены для продажи
   */
  readonly portfolio: Portfolio | undefined;

  // ── Timing ───────────────────────────────────────────────
  // ── Crypto Price ────────────────────────────────────────────
  /**
   * Цена крипто-актива для крипто-рынков (Bitcoin Up or Down и т.п.).
   *
   * @remarks
   * undefined для не-крипто рынков.
   *
   * Стратегия может определить текущий прогноз исхода:
   * - `cryptoPrice.currentPrice >= cryptoPrice.targetPrice` → рынок в зоне UP
   * - `cryptoPrice.resolved && cryptoPrice.resolutionPrice >= cryptoPrice.targetPrice` → UP resolved
   */
  readonly cryptoPrice?: {
    /** Базовый актив (e.g. 'btc', 'eth') */
    readonly asset: string;
    /** Chainlink oracle цена (используется для resolution) */
    readonly chainlink: { readonly price: number; readonly timestampMs: number } | undefined;
    /** Binance spot цена */
    readonly binance: { readonly price: number; readonly timestampMs: number } | undefined;
    /** Strike/open цена (из Binance klines на eventStartTime) */
    readonly targetPrice: number | undefined;
    /** Финальная цена на endDate */
    readonly resolutionPrice: number | undefined;
    readonly resolved: boolean;
    /** Chainlink цена (приоритет) или Binance — для обратной совместимости */
    readonly currentPrice: number;
    /** @deprecated Используй asset */
    readonly symbol: string;
  } | undefined;

  /**
   * Rolling history крипто-цен по asset/source.
   *
   * @remarks
   * Живёт по asset (`btc`), а не по 5-минутному Polymarket рынку. Поэтому
   * стратегия может использовать 20-30 минут истории после market rotation.
   */
  readonly cryptoPriceHistory?: CryptoPriceHistoryView;

  /**
   * Последнее materialized состояние CEX venue по текущему crypto asset.
   */
  readonly cryptoVenueState?: CryptoVenueStateView;

  /**
   * Rolling история CEX orderbooks/trades по текущему crypto asset.
   */
  readonly cryptoVenueHistory?: CryptoVenueHistoryView;

  /**
   * Shared registry of reusable crypto signal calculators.
   *
   * @remarks
   * This does not force one global signal. Each strategy can choose calculator,
   * venues, weights, lookback and thresholds, or ignore it and use raw history.
   */
  readonly cryptoSignals?: CryptoSignalRegistryView;

  // ── Timing ───────────────────────────────────────────────
  /**
   * Текущее время в ms (epoch).
   *
   * @remarks
   * Из IClock — для детерминизма в бэктесте.
   * Стратегия использует для расчёта timeToExpiry и других time-based решений.
   */
  readonly nowMs: number;

  /**
   * Время начала торговли на рынке (epoch ms).
   *
   * @remarks
   * Из Gamma API поле `eventStartTime` для крипто-рынков.
   * undefined если неизвестно.
   *
   * Стратегия использует для вычисления длительности рынка:
   * `durationMs = market.expirationMs - eventStartMs`
   *
   * @example
   * ```typescript
   * const durationMs = snapshot.eventStartMs
   *   ? snapshot.market.expirationMs - snapshot.eventStartMs
   *   : undefined;
   * ```
   */
  readonly eventStartMs?: number;

  // ── Complementary Token ───────────────────────────────────
  /**
   * ID комплементарного токена (другой outcome того же рынка).
   *
   * @remarks
   * Для binary рынков (UP/DOWN): если основной токен = UP, то complementary = DOWN.
   * undefined если не зарегистрирован.
   */
  readonly complementaryInstrumentId?: InstrumentId;

  /**
   * Торговый актив комплементарного токена.
   *
   * @remarks
   * Нужен стратегии для auto-selection: если решает купить комплементарный токен,
   * указывает `targetAsset` в PlaceIntent для корректной маршрутизации в ExecutionEngine.
   * undefined если комплементарный токен не зарегистрирован.
   */
  readonly complementaryAsset?: AssetId;

  /**
   * Лучшие bid/ask комплементарного токена.
   *
   * @remarks
   * Нужен стратегиям, которые реально размещают ордера на complementaryInstrumentId.
   * Без этого стратегия видит только primary top-of-book и может вычислить
   * marketable цену для комплементарного токена по синтетике `100 - x`.
   */
  readonly complementaryTopOfBook?: TopOfBook;

  /**
   * Открытые ордера стратегии на комплементарном токене.
   *
   * @remarks
   * Нужен стратегиям с auto-selection между primary и complementary outcome.
   * Без этого стратегия не видит собственный comp-ордер и не может корректно
   * делать cancel/reprice после переключения стороны.
   */
  readonly complementaryOpenOrders?: readonly Order[];

  /**
   * MATCHED-ордера стратегии на комплементарном токене.
   */
  readonly complementaryMatchedOrders?: readonly Order[];

  /**
   * true если на комплементарном инструменте есть in-flight fills.
   */
  readonly hasComplementaryInFlightFills?: boolean;

  /**
   * Rolling лента публичных трейдов комплементарного токена.
   *
   * @remarks
   * undefined если комплементарный токен не зарегистрирован или трейдов ещё не было.
   * Используется AdaptiveEntryStrategy для сравнения momentum обоих токенов:
   * покупаем тот, у которого EWMA растёт сильнее.
   *
   * @example
   * ```typescript
   * const myTape = snapshot.tradeTape;
   * const otherTape = snapshot.complementaryTradeTape;
   * if (myTape && otherTape) {
   *   // Сравниваем EWMA обоих токенов
   * }
   * ```
   */
  readonly complementaryTradeTape?: TradeTape;
}
