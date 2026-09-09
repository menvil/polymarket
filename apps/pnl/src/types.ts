/**
 * Типы отчёта PnL.
 *
 * @remarks
 * Wire-формат здесь не описывается: его держит официальный SDK
 * (`@polymarket/client` + `@polymarket/bindings`), который валидирует ответы
 * zod-схемами. Наши типы начинаются там, где заканчивается SDK.
 *
 * ### Почему Value Objects, а не сырые числа
 * Раньше здесь стояли `number` с обоснованием «read-only аналитика, нет
 * инвариантов». Практика это опровергла — за одну сессию сырые числа дали
 * три ошибки размерности:
 *
 * | ошибка | что ловит тип |
 * | --- | --- |
 * | ставка в bps подставлена как доля | `Ratio` |
 * | ROI-доля напечатана как проценты (в 100 раз меньше) | `Ratio` |
 * | комиссия в токенах смешана с USDC | `Money` |
 * | Unix-секунды против миллисекунд | `Timestamp` |
 *
 * Ни одна не была ошибкой невнимательности — все четыре возникли на стыке,
 * где величина меняет представление. Тип на этом стыке делает их
 * невозможными, а не менее вероятными.
 *
 * ### Где VO, а где нет
 * VO стоят в **типах** — там, где величину передают между слоями и можно
 * перепутать размерность. Внутри вычислений используются примитивы
 * (`.toNumber()`), результат заворачивается обратно: арифметика VO идёт
 * через `*Service` с `Result`, и разворачивать его в каждом шаге `reduce`
 * значит платить церемонией без выгоды. Это тот же принцип границы, что и в
 * `docs/architecture/boundary-contract.md`.
 *
 * Без VO намеренно остаются:
 * - **счётчики** (`wins`, `losses`, `totalMarkets`, `outcomeIndex`) —
 *   безразмерные, инварианта нет;
 * - **`netShares`** — может быть отрицательным, а `Quantity` запрещает
 *   отрицательные значения; `SignedQuantity` не в публичном API пакета;
 * - **цена резолюции** — это `Ratio`, а не `OutcomePrice`: последний
 *   допускает только диапазон (0, 1), тогда как после резолюции цена равна
 *   ровно 1 или 0.
 */
import type { Money, OutcomePrice, Quantity, Ratio } from '@polymarket/value-objects';
import type { Timestamp } from '@polymarket/timestamp';

/**
 * Один наш fill.
 *
 * @remarks
 * Публичный путь строит его из `listActivity()`, аутентифицированный —
 * из `listAccountTrades()`. Разница в двух полях: `feeUsdc` есть только у
 * первого (лента отдаёт фактически перемещённый USDC), `liquidityRole` —
 * только у второго.
 */
export interface NormalizedFill {
  /** Хеш транзакции — единственный стабильный идентификатор в ленте */
  transactionHash: string;
  /** Condition ID рынка */
  market: string;
  /** ID нашего токена */
  asset_id: string;
  /** Наша сторона */
  side: 'BUY' | 'SELL';
  /** Размер в токенах */
  size: Quantity;
  /** Цена исполнения */
  price: OutcomePrice;
  /** Фактически перемещённый USDC */
  usdcSize: Money;
  /** Момент сделки */
  matchedAt: Timestamp;
  /** Название нашего outcome (UP/DOWN/YES/NO) */
  outcome?: string;
  /** Индекс исхода в рынке */
  outcomeIndex?: number;
  /** Заголовок рынка */
  title?: string;
  /**
   * Роль по ликвидности.
   *
   * @remarks
   * Заполняется только на аутентифицированном пути: публичная лента
   * мейкера от тейкера не отличает.
   */
  liquidityRole?: 'MAKER' | 'TAKER';
  /**
   * Фактически удержанная комиссия.
   *
   * @remarks
   * Не расчёт, а **измерение**: публичная лента отдаёт `amount` — реально
   * перемещённый USDC, уже за вычетом комиссии. Разница между
   * `size × price` и `amount` и есть удержанное. Совпадает с
   * документированной формулой до пятого знака, но измерение не сломается,
   * если Polymarket поменяет тариф.
   *
   * Отсутствует на аутентифицированном пути: `listAccountTrades` поля
   * `amount` не отдаёт.
   */
  feeUsdc?: Money;
}

/**
 * Позиция по рынку с PnL, посчитанным самой площадкой.
 *
 * @remarks
 * Сводит `listClosedPositions()` и `listPositions()` к одной форме.
 * `realizedPnl` — авторитетный источник: ровно то число, которое показывает
 * сайт, и оно уже включает комиссии.
 */
export interface PositionPnl {
  /** Condition ID рынка */
  conditionId: string;
  /** Заголовок рынка */
  title: string;
  /** Название нашего исхода */
  outcome: string;
  /** Индекс исхода */
  outcomeIndex: number;
  /** Средняя цена входа */
  avgPrice: OutcomePrice;
  /** Сколько токенов куплено суммарно */
  totalBought: Quantity;
  /**
   * Текущая (или расчётная) цена исхода.
   *
   * @remarks
   * `Ratio`, а не `OutcomePrice`: после резолюции цена равна ровно 1 или 0,
   * а `OutcomePrice` допускает только открытый диапазон (0, 1).
   */
  curPrice: Ratio;
  /** Реализованный PnL — как его считает площадка */
  realizedPnl: Money;
  /** Позиция закрыта (из `listClosedPositions`) */
  closed: boolean;
  /** Момент закрытия; для открытых позиций отсутствует */
  closedAt?: Timestamp;
  /** Дата окончания рынка (ISO) */
  endDate?: string;
}

/** Строка таблицы сделок в подробном отчёте. */
export interface FillRecord {
  /** Идентификатор сделки */
  id: string;
  /** Наша сторона */
  side: 'BUY' | 'SELL';
  /** Роль по ликвидности */
  liquidityRole: 'MAKER' | 'TAKER';
  /** Название исхода */
  outcomeName: string;
  /** Размер в токенах */
  size: Quantity;
  /** Цена исполнения */
  price: OutcomePrice;
  /** Оборот в USDC */
  notional: Money;
  /** Комиссия; `null` — величина недоступна (не путать с нулём) */
  fee: Money | null;
  /** Движение денег: отрицательное на покупке, положительное на продаже */
  cashFlow: Money;
  /** Момент сделки */
  matchedAt: Timestamp;
  /** Дата сделки `YYYY-MM-DD` */
  matchDate: string;
  /** Время сделки `HH:MM:SS` */
  matchTime: string;
}

/** PnL по одному рынку. */
export interface MarketPnl {
  /** Condition ID */
  conditionId: string;
  /** Вопрос рынка */
  question: string;
  /** Название нашего исхода */
  outcomeName: string;
  /** Цена после резолюции: 1 или 0 */
  resolvedPrice: Ratio;
  /** Наш исход выиграл */
  won: boolean;
  /** Позиция принесла прибыль */
  profitable: boolean;
  /** Наши сделки по рынку */
  fills: FillRecord[];
  /** Стоимость входа */
  entryCost: Money;
  /** Выручка от досрочного выхода */
  sellProceeds: Money;
  /**
   * Остаток токенов на резолюции.
   *
   * @remarks
   * Остаётся `number`: величина знаковая, а `Quantity` запрещает
   * отрицательные значения.
   */
  netShares: number;
  /** Выплата по резолюции */
  redeemValue: Money;
  /** Комиссия; `null` — недоступна */
  fees: Money | null;
  /** Итоговый PnL — `realizedPnl` площадки */
  netPnl: Money;
  /** Доходность как ДОЛЯ (0.127 = +12.7%) */
  roi: Ratio;
  /** Дата отнесения рынка к дню отчёта */
  entryDate: string;
}

/** Срез отчёта за один день. */
export interface DailyPnl {
  /** Дата `YYYY-MM-DD` */
  date: string;
  /** Рынки этого дня */
  markets: MarketPnl[];
  /** Прибыльных рынков */
  wins: number;
  /** Убыточных рынков */
  losses: number;
  /** Суммарная стоимость входа */
  entryCost: Money;
  /** Стоимость входа плюс PnL */
  totalReturn: Money;
  /** Комиссия; `null` — недоступна */
  fees: Money | null;
  /** Итоговый PnL дня */
  netPnl: Money;
  /** Доходность дня как доля */
  roi: Ratio;
}

/** Полный отчёт за период. */
export interface PnlReport {
  /** Начало периода (ISO-дата) */
  fromDate: string;
  /** Конец периода (ISO-дата) */
  toDate: string;
  /** Всего рынков */
  totalMarkets: number;
  /** Прибыльных */
  wins: number;
  /** Убыточных */
  losses: number;
  /** Суммарная стоимость входа */
  entryCost: Money;
  /** Стоимость входа плюс PnL */
  totalReturn: Money;
  /** Комиссия; `null` — недоступна */
  fees: Money | null;
  /** Итоговый PnL */
  netPnl: Money;
  /** Доходность как доля */
  roi: Ratio;
  /** Лучший день */
  bestDay: DailyPnl | null;
  /** Худший день */
  worstDay: DailyPnl | null;
  /** Разбивка по дням */
  dailyBreakdown: DailyPnl[];
  /** Все рынки */
  markets: MarketPnl[];
}
