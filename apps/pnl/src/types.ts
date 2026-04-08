/**
 * Типы для PnL-аналитики Polymarket.
 *
 * @remarks
 * Намеренно используем сырые числа (number) вместо domain Value Objects —
 * это read-only аналитический скрипт, а не торговый движок.
 */

// ── Сырые данные API ──────────────────────────────────────────────────────────

/**
 * Сделка из /data/trades (сырой формат Polymarket CLOB API).
 */
export interface RawTrade {
  /** Идентификатор сделки */
  id: string;
  /** ID ордера тейкера */
  taker_order_id?: string;
  /** Condition ID маркета (0x...) */
  market: string;
  /** ID токена актива */
  asset_id: string;
  /** Направление нашей сделки */
  side: 'BUY' | 'SELL';
  /** Размер позиции (строка) */
  size: string;
  /** Цена исполнения (строка) */
  price: string;
  /** Ставка комиссии в basis points (строка) */
  fee_rate_bps?: string;
  /** Timestamp исполнения в секундах Unix (строка) */
  match_time?: string;
  /** Название outcome (YES/NO/UP/DOWN) из API */
  outcome?: string;
  /** Хэш транзакции */
  transaction_hash?: string;
  /** Роль в сделке: TAKER или MAKER */
  trader_side?: string;
  /** Ордера мейкеров (когда мы — тейкер) */
  maker_orders?: Array<{
    order_id: string;
    matched_amount: string;
    fee_rate_bps: string;
    asset_id?: string;
    outcome?: string;
    side?: 'BUY' | 'SELL';
  }>;
}

/**
 * Пагинированный ответ /data/trades.
 */
export interface TradesPageResponse {
  limit: number;
  next_cursor: string;
  count: number;
  data: RawTrade[];
}

// ── Метаданные рынка ──────────────────────────────────────────────────────────

/**
 * Метаданные рынка из Gamma API, обогащённые для расчёта PnL.
 */
export interface MarketMeta {
  /** Condition ID (0x...) */
  conditionId: string;
  /** Текст вопроса маркета */
  question: string;
  /** Названия исходов, например ["Yes","No"] или ["UP","DOWN"] */
  outcomes: string[];
  /** ID CLOB-токенов, индекс совпадает с outcomes[] */
  clobTokenIds: string[];
  /**
   * Цены исходов после резолюции.
   * Для solved рынка: [1, 0] или [0, 1].
   * Пустой массив, если рынок ещё не resolved.
   */
  outcomePrices: number[];
  /** true — рынок закрыт и settled */
  resolved: boolean;
}

// ── Аналитические типы ────────────────────────────────────────────────────────

/**
 * Одна исполненная сделка, обогащённая вычисленными полями.
 */
export interface FillRecord {
  /** Идентификатор сделки */
  id: string;
  /** BUY — открытие, SELL — досрочный выход */
  side: 'BUY' | 'SELL';
  /** Количество акций */
  size: number;
  /** Цена исполнения */
  price: number;
  /** Номинал = size × price */
  notional: number;
  /** Комиссия в USDC */
  fee: number;
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
  /** true — наш токен выиграл */
  won: boolean;
  /** Все исполнения по этому рынку (sorted by time) */
  fills: FillRecord[];
  /** Σ notional по BUY-fills */
  entryCost: number;
  /** Σ notional по SELL-fills (досрочные выходы) */
  sellProceeds: number;
  /** Количество акций ушедших в settlement = Σ BUY.size − Σ SELL.size */
  netShares: number;
  /** Стоимость settlement = netShares × resolvedPrice */
  redeemValue: number;
  /** Σ всех комиссий */
  fees: number;
  /** Итоговый PnL = sellProceeds + redeemValue − entryCost − fees */
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
  fees: number;
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
  fees: number;
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
