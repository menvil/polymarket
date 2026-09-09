/**
 * Жизненный цикл рынка в НАШЕМ торговом рантайме.
 *
 * @remarks
 * Это НЕ `Market.state`. Их два, и объединять их нельзя:
 *
 * ```text
 * Market.state                  что площадка подтверждает про внешний рынок
 *   ACTIVE → CLOSED → RESOLVED  мы это наблюдаем, но не управляем
 *
 * TradingMarketLifecycle        что наш рантайм сейчас делает с рынком
 *   ADMITTED → ACTIVE → TRADING_CLOSED → RESOLVED → FINALIZED
 * ```
 *
 * Комбинация «`market.state = ACTIVE`, наш статус = `TRADING_CLOSED`» законна:
 * мы уже перестали торговать по `expiresAt`, а площадка ещё несколько секунд
 * показывает рынок активным. Требовать согласованности значило бы ставить
 * наши торговые решения в зависимость от частоты обновлений площадки.
 *
 * ### Почему в статусах нет `DISCOVERED`
 *
 * Обнаружение принадлежит `MarketUniverse`: там лежат все технически
 * существующие рынки (их бывают десятки тысяч). Торговое состояние хранит
 * только те, которые рантайм явно принял. Статус `DISCOVERED` внутри
 * торгового состояния означал бы, что мы завели состояние рынка, которым не
 * торгуем, — то есть второй реестр вселенной.
 *
 * ### Почему нет `AWAITING_RESOLUTION`
 *
 * `TRADING_CLOSED` уже означает «торговля остановлена, резолюции ещё нет».
 * Второй статус с тем же смыслом появится тогда, когда найдётся решение,
 * которое их различает.
 */
import type { Timestamp } from '@polymarket/timestamp';

/**
 * Статус рынка в торговом рантайме.
 *
 * @remarks
 * Порядок переходов строгий и без ветвлений назад:
 *
 * ```text
 * ADMITTED ──→ ACTIVE ──→ TRADING_CLOSED ──→ RESOLVED ──→ FINALIZED
 *                  └──────────────────────────┘
 *                    ACTIVE → RESOLVED разрешён
 * ```
 *
 * `ACTIVE → RESOLVED` нужен потому, что внешний источник может отдать
 * резолюцию сразу, а промежуточное закрытие мы могли не увидеть или не
 * успеть опубликовать. `ADMITTED → RESOLVED` намеренно НЕ поддерживается:
 * рынок, по которому торговля не начиналась, не может быть разрешён нашим
 * рантаймом, и такой переход означал бы mid-market catch-up.
 */
export type TradingMarketLifecycleStatus =
  | 'ADMITTED'
  | 'ACTIVE'
  | 'TRADING_CLOSED'
  | 'RESOLVED'
  | 'FINALIZED';

/**
 * Времена жизненного цикла — только чтение.
 *
 * @remarks
 * Все времена берутся из `event.metadata.createdAt` соответствующего
 * lifecycle-события. Ни `Date.now()`, ни `clock.now()` здесь не участвуют:
 * иначе replay той же последовательности событий давал бы другие времена, и
 * состояние перестало бы быть воспроизводимым.
 *
 * Инварианты, которые состояние поддерживает:
 *
 * ```text
 * admittedAt < startsAt <= activatedAt <= tradingClosedAt <= resolvedAt <= finalizedAt
 * ```
 *
 * Опциональные времена существуют ровно тогда, когда пройдена
 * соответствующая фаза — кроме `tradingClosedAt` при переходе
 * `ACTIVE → RESOLVED`: там оно ставится равным `resolvedAt`, потому что
 * разрешённый рынок не может остаться торгово активным.
 */
export interface TradingMarketLifecycleView {
  /** Текущий статус в торговом рантайме */
  readonly status: TradingMarketLifecycleStatus;
  /** Когда рантайм принял рынок (`TRADING_MARKET_ADMITTED`) */
  readonly admittedAt: Timestamp;
  /** Когда началась торговля (`TRADING_MARKET_ACTIVATED`) */
  readonly activatedAt?: Timestamp;
  /** Когда МЫ прекратили торговать (`TRADING_MARKET_CLOSED` либо резолюция) */
  readonly tradingClosedAt?: Timestamp;
  /** Когда мы узнали исход (`TRADING_MARKET_RESOLVED`) */
  readonly resolvedAt?: Timestamp;
  /** Когда работа по рынку завершена (`TRADING_MARKET_FINALIZED`) */
  readonly finalizedAt?: Timestamp;
}

/**
 * Фазы, в которых рынок принимает market-data.
 *
 * @remarks
 * `ADMITTED` входит НАМЕРЕННО: мы подписываемся до открытия рынка, чтобы к
 * `startsAt` уже иметь warm history стакана и сделок. Стратегия, которой
 * нужен разогретый ряд, иначе начинала бы с пустого.
 *
 * После `TRADING_CLOSED` наблюдения площадки больше не принимаются: тяжёлые
 * ряды к этому моменту освобождены, и поздний стакан либо воссоздал бы их
 * после остановки торгов, либо дописался бы в историю, которой уже никто не
 * пользуется.
 */
const MARKET_DATA_PHASES: readonly TradingMarketLifecycleStatus[] = ['ADMITTED', 'ACTIVE'];

/**
 * Принимает ли рынок в этой фазе новые наблюдения площадки.
 *
 * @param status - Текущий статус рынка в торговом рантайме
 * @returns `true` для `ADMITTED` и `ACTIVE`, иначе `false`
 *
 * @example
 * ```typescript
 * acceptsMarketData('ADMITTED');       // → true — греем историю до startsAt
 * acceptsMarketData('TRADING_CLOSED'); // → false — поздние наблюдения игнорируются
 * ```
 */
export function acceptsMarketData(status: TradingMarketLifecycleStatus): boolean {
  return MARKET_DATA_PHASES.includes(status);
}
