/**
 * Типы отчёта PnL.
 *
 * @remarks
 * Wire-формат больше не описывается здесь: его держит официальный SDK
 * (`@polymarket/client` + `@polymarket/bindings`), который валидирует ответы
 * zod-схемами и отдаёт camelCase. Наши типы начинаются там, где заканчивается
 * SDK — с нормализованного fill и агрегатов отчёта.
 *
 * Числа намеренно сырые (`number`), а не domain Value Objects: это read-only
 * аналитика, а не торговый движок. Ни один инвариант здесь не защищается —
 * величины только считаются и печатаются.
 */

/**
 * Один наш fill, приведённый из публичной ленты активности.
 *
 * @remarks
 * Источник — `listActivity()` с `type === 'TRADE'`. Публичная лента НЕ несёт
 * ставки комиссии (`feeRateBps`): комиссия уже учтена площадкой внутри
 * `realizedPnl` позиции. Поэтому пофилловой комиссии здесь нет — вместо
 * выдуманного нуля её просто не существует в этой модели.
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
  size: number;
  /** Цена исполнения */
  price: number;
  /** Фактически перемещённый USDC */
  usdcSize: number;
  /** Момент сделки, epoch-миллисекунды */
  matchedAtMs: number;
  /** Название нашего outcome (UP/DOWN/YES/NO) */
  outcome?: string;
  /** Индекс исхода в рынке */
  outcomeIndex?: number;
  /** Заголовок рынка (лента отдаёт его вместе со сделкой) */
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
   * Ставка комиссии в базисных пунктах.
   *
   * @remarks
   * Только аутентифицированный путь. Без неё комиссию не посчитать —
   * и она честно отсутствует, а не подменяется нулём.
   */
  feeRateBps?: number;
}

/**
 * Позиция по рынку с PnL, посчитанным самой площадкой.
 *
 * @remarks
 * Сводит `listClosedPositions()` и `listPositions()` к одной форме.
 * `realizedPnl` — авторитетный источник: это ровно то число, которое
 * показывает сайт, и оно уже включает комиссии. Наша собственная формула
 * по сырым сделкам больше не нужна и не воспроизводится: публичный контур
 * не отдаёт ставок комиссии, а угадывать их — верный способ разойтись с
 * реальностью на величину, которую никто не заметит.
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
  avgPrice: number;
  /** Сколько токенов куплено суммарно */
  totalBought: number;
  /** Текущая (или расчётная) цена исхода: 1.0/0.0 после резолюции */
  curPrice: number;
  /** Реализованный PnL в USDC — как его считает площадка */
  realizedPnl: number;
  /** Позиция закрыта (из `listClosedPositions`) */
  closed: boolean;
  /** Момент закрытия, epoch-миллисекунды; для открытых позиций отсутствует */
  closedAtMs?: number;
  /** Дата окончания рынка (ISO) */
  endDate?: string;
}

export interface FillRecord {
  /** Идентификатор сделки */
  id: string;
  /** BUY — открытие, SELL — досрочный выход */
  side: 'BUY' | 'SELL';
  /** Роль ликвидности для этого fill */
  liquidityRole: 'MAKER' | 'TAKER';
  /** Название нашего outcome (UP/DOWN/YES/NO) */
  outcomeName: string;
  /** Количество акций */
  size: number;
  /** Цена исполнения */
  price: number;
  /** Номинал = size × price */
  notional: number;
  /** Комиссия в USDC-equivalent */
  fee: number | null;
  /** Комиссия, удержанная в shares на BUY taker fills */
  feeShares: number | null;
  /** Эффективное изменение количества shares после удержания комиссии */
  effectiveSize: number;
  /** Эффективный cashflow в USDC после комиссии */
  cashFlow: number;
  /** Timestamp в миллисекундах */
  matchTs: number;
  /** Дата в формате YYYY-MM-DD */
  matchDate: string;
  /** Время в формате HH:MM:SS */
  matchTime: string;
}

/**
 * Результат PnL по одному рынку.
 *
 * @remarks
 * Учитываются только resolved рынки (closed=true у Gamma API).
 */
export interface MarketPnl {
  /** Condition ID */
  conditionId: string;
  /** Текст вопроса */
  question: string;
  /** Название нашего токена, например "YES" или "UP" */
  outcomeName: string;
  /** Цена резолюции: 1.0 (победа) или 0.0 (поражение) */
  resolvedPrice: number;
  /** true — наш токен выиграл на резолюции */
  won: boolean;
  /** true — торговый результат по этому рынку неотрицательный */
  profitable: boolean;
  /** Все исполнения по этому рынку (sorted by time) */
  fills: FillRecord[];
  /** Σ notional по BUY-fills */
  entryCost: number;
  /** Σ cashflow по SELL-fills (после sell-side fee) */
  sellProceeds: number;
  /** Количество акций ушедших в settlement = Σ BUY.effectiveSize − Σ SELL.size */
  netShares: number;
  /** Стоимость settlement = netShares × resolvedPrice */
  redeemValue: number;
  /** Σ всех комиссий в USDC-equivalent (информационно) */
  fees: number | null;
  /** Σ buy-side fees, удержанных в shares */
  feeSharesPaid: number | null;
  /** Итоговый PnL = sellProceeds + redeemValue − entryCost */
  netPnl: number;
  /** ROI в процентах = netPnl / entryCost × 100 */
  roi: number;
  /** Дата первого fill (YYYY-MM-DD) */
  entryDate: string;
}

/**
 * Агрегированные данные за один торговый день.
 */
export interface DailyPnl {
  /** Дата YYYY-MM-DD */
  date: string;
  /** Рынки торгованные в этот день */
  markets: MarketPnl[];
  /** Выигрышные рынки */
  wins: number;
  /** Проигрышные рынки */
  losses: number;
  /** Суммарный entry cost */
  entryCost: number;
  /** Суммарный redeem + досрочные продажи */
  totalReturn: number;
  /** Суммарные комиссии */
  fees: number | null;
  /** Итоговый PnL за день */
  netPnl: number;
  /** ROI за день */
  roi: number;
}

/**
 * Полный отчёт PnL за период.
 */
export interface PnlReport {
  /** Начало периода YYYY-MM-DD */
  fromDate: string;
  /** Конец периода YYYY-MM-DD */
  toDate: string;
  /** Всего resolved рынков */
  totalMarkets: number;
  /** Выигрышных */
  wins: number;
  /** Проигрышных */
  losses: number;
  /** Суммарный entry cost */
  entryCost: number;
  /** Суммарный return (redeem + early sells) */
  totalReturn: number;
  /** Суммарные комиссии */
  fees: number | null;
  /** Итоговый PnL */
  netPnl: number;
  /** ROI */
  roi: number;
  /** Лучший день */
  bestDay: DailyPnl | null;
  /** Худший день */
  worstDay: DailyPnl | null;
  /** Разбивка по дням */
  dailyBreakdown: DailyPnl[];
  /** Список всех рынков */
  markets: MarketPnl[];
}
