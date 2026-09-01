/**
 * MarketTradingPolicy — производная фаза рынка «здесь и сейчас»
 *
 * @remarks
 * Отвечает на вопрос «в какой фазе находится рынок в момент `now`?».
 *
 * ### Разделение ответственности
 * - `Market` (entity) — структура рынка и **подтверждённое внешнее состояние**
 *   (`ACTIVE`/`CLOSED`/`RESOLVED`), переходы между состояниями;
 * - `MarketTradingPolicy` — чистая функция от `(state, startsAt, expiresAt, now)`
 *   к производной фазе. Ничего не хранит и ничего не решает за Market.
 *
 * ### Почему фаза не хранится в Market
 * `PRE_OPEN`/`OPEN`/`ENDED` — это временные производные состояния: они меняются
 * от одного лишь хода часов, без какого-либо наблюдения извне. Если хранить их
 * в entity, придётся пересоздавать Market по таймеру, и любая копия мгновенно
 * устаревает. Поэтому в `MarketState` их нет, а фаза вычисляется по требованию.
 *
 * ### Ключевое различие ENDED и CLOSED
 * `ENDED` — расписание рынка истекло, но площадка всё ещё публикует его как
 * ACTIVE. Стратегия в этой фазе уже не торгует, однако считать рынок закрытым
 * нельзя: подтверждения не было. `CLOSED` — площадка закрытие подтвердила.
 *
 * ### Как фазы используются runtime-слоем
 * ```text
 * PRE_OPEN → можно подписываться на маркет-данные, торгов ещё нет
 * OPEN     → рынок идёт, стратегия торгует
 * ENDED    → стратегия не торгует; vendor может всё ещё считать рынок ACTIVE
 * CLOSED   → подтверждённое закрытие: отменить ордера, ждать исход
 * RESOLVED → исход объявлен: settlement
 * ```
 *
 * @example
 * ```typescript
 * switch (MarketTradingPolicy.getPhase(market, now)) {
 *   case 'PRE_OPEN': return subscriptions.ensure(market);
 *   case 'OPEN':     return orderService.accept(order);
 *   case 'ENDED':    return strategyRunner.stopEntering(market);
 *   case 'CLOSED':   return resolver.awaitOutcome(market);
 *   case 'RESOLVED': return settlement.process(market);
 * }
 * ```
 */

import type { Timestamp } from '@polymarket/timestamp';
import { Market } from './Market.js';

/**
 * MarketPhase — производная фаза рынка в конкретный момент времени
 *
 * @remarks
 * Объединяет подтверждённое внешнее состояние (`MarketState`) и расписание
 * рынка в одно значение. Discriminated union из строковых литералов позволяет
 * exhaustive switch: при добавлении фазы компилятор покажет все непокрытые места.
 *
 * | MarketPhase | Market.state | Расписание           |
 * |-------------|--------------|----------------------|
 * | PRE_OPEN    | ACTIVE       | now < startsAt       |
 * | OPEN        | ACTIVE       | startsAt ≤ now < expiresAt |
 * | ENDED       | ACTIVE       | now ≥ expiresAt      |
 * | CLOSED      | CLOSED       | не влияет            |
 * | RESOLVED    | RESOLVED     | не влияет            |
 */
export type MarketPhase = 'PRE_OPEN' | 'OPEN' | 'ENDED' | 'CLOSED' | 'RESOLVED';

/**
 * MarketTradingPolicy — статический класс вычисления фазы рынка
 *
 * @remarks
 * Намеренно реализован как static-only класс: все методы — чистые функции
 * без side effects, мутаций и обращений к часам.
 */
export class MarketTradingPolicy {
  /**
   * Приватный конструктор — класс не предназначен для инстанциации
   *
   * @throws {Error} Всегда, при любой попытке создать экземпляр
   */
  private constructor() {
    throw new Error('MarketTradingPolicy is a static utility class and cannot be instantiated');
  }

  /**
   * Вычисляет фазу рынка в заданный момент времени
   *
   * @param market - Market entity
   * @param now - Момент наблюдения (из инжектированного `IClock`, не из wall-clock)
   * @returns {@link MarketPhase} — единственная точка входа для торговых решений
   *
   * @remarks
   * Алгоритм:
   * 1. Подтверждённые терминальные состояния сильнее расписания: RESOLVED → `RESOLVED`,
   *    CLOSED → `CLOSED`, независимо от `now`;
   * 2. Для ACTIVE фаза определяется расписанием:
   *    `now < startsAt` → `PRE_OPEN`; `startsAt ≤ now < expiresAt` → `OPEN`;
   *    `now ≥ expiresAt` → `ENDED`.
   *
   * Границы включающие слева: ровно в `startsAt` рынок уже `OPEN`, ровно
   * в `expiresAt` — уже `ENDED`.
   *
   * @example
   * ```typescript
   * // Рынок 12:00–12:05 в состоянии ACTIVE
   * MarketTradingPolicy.getPhase(market, at('11:59')); // → 'PRE_OPEN'
   * MarketTradingPolicy.getPhase(market, at('12:02')); // → 'OPEN'
   * MarketTradingPolicy.getPhase(market, at('12:05')); // → 'ENDED'
   * ```
   */
  public static getPhase(market: Market, now: Timestamp): MarketPhase {
    if (market.isResolved()) return 'RESOLVED';
    if (market.isClosed()) return 'CLOSED';
    if (!market.isStartedAt(now)) return 'PRE_OPEN';
    return market.isExpiredAt(now) ? 'ENDED' : 'OPEN';
  }
}
