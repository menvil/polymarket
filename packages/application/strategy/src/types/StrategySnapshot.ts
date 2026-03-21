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
import type { InstrumentId } from '@polymarket/ids';
import type { TopOfBook } from '@polymarket/event-bus';
import type { OrderBookHistory } from '@polymarket/order-book';
import type { TradeTape } from '@polymarket/trade-tape';
import type { Order } from '@polymarket/order';
import type { Portfolio } from '@polymarket/portfolio';
import type { Market } from '@polymarket/market';
import type { InstrumentConstraints } from './InstrumentConstraints.js';

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

  // ── Timing ───────────────────────────────────────────────
  /**
   * Текущее время в ms (epoch).
   *
   * @remarks
   * Из IClock — для детерминизма в бэктесте.
   * Стратегия использует для расчёта timeToExpiry и других time-based решений.
   */
  readonly nowMs: number;
}
