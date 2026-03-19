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
   */
  readonly openOrders: readonly Order[];

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
  /**
   * Текущее время в ms (epoch).
   *
   * @remarks
   * Из IClock — для детерминизма в бэктесте.
   * Стратегия использует для расчёта timeToExpiry и других time-based решений.
   */
  readonly nowMs: number;
}
