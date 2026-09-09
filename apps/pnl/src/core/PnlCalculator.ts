/**
 * Сборка отчёта PnL из позиций и ленты сделок.
 *
 * @remarks
 * ### Откуда берётся PnL
 * `netPnl` рынка — это `realizedPnl` позиции, как его посчитала площадка.
 * Мы его НЕ пересчитываем. Прежняя версия воспроизводила формулу
 * «выручка от выхода + redemption − стоимость входа» вместе с моделью
 * комиссий по `feeRateBps`; публичный контур ставку не отдаёт, а
 * подставлять предполагаемую — значит разойтись с реальностью незаметно
 * для читателя отчёта.
 *
 * Остальные величины — производные и служат объяснением числа, а не его
 * источником:
 *
 * ```text
 * entryCost    = avgPrice × totalBought        // из позиции
 * sellProceeds = Σ SELL.usdcSize               // из ленты сделок
 * netShares    = Σ BUY.size − Σ SELL.size      // из ленты сделок
 * redeemValue  = netShares × curPrice          // 0.0 или 1.0 после резолюции
 * netPnl       = realizedPnl                   // ← авторитет площадки
 * roi          = netPnl / entryCost
 * ```
 *
 * `fees` и `feeSharesPaid` равны `null`: комиссия уже внутри `realizedPnl`,
 * а отдельной строкой публичный API её не показывает.
 *
 * ### Сутки отчёта
 * Рынок относится к дню своего **закрытия** (`closedAtMs`), а не первого
 * входа: PnL реализуется в момент выхода или резолюции.
 *
 * @example
 * ```typescript
 * const calculator = new PnlCalculator(logger);
 * const report = calculator.compute({ positions, fills, fromDate, toDate });
 * console.log(report.netPnl);
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type {
  DailyPnl,
  FillRecord,
  MarketPnl,
  NormalizedFill,
  PnlReport,
  PositionPnl,
} from '../types.js';

/** Входные данные расчёта. */
export interface ComputeParams {
  /** Позиции с реализованным PnL */
  positions: PositionPnl[];
  /** Наши сделки за период */
  fills: NormalizedFill[];
  /** Начало периода (ISO-дата) */
  fromDate: string;
  /** Конец периода (ISO-дата) */
  toDate: string;
}

/** Цена, выше которой исход считается выигравшим. */
const WINNING_PRICE = 0.99;

/**
 * Считает отчёт PnL.
 */
export class PnlCalculator {
  /**
   * @param _logger - Логгер
   */
  constructor(private readonly _logger: ILogger) {}

  /**
   * Собирает полный отчёт.
   *
   * @param params - Позиции, сделки и границы периода
   * @returns Отчёт с разбивкой по дням и по рынкам
   *
   * @example
   * ```typescript
   * const report = calculator.compute({ positions, fills, fromDate: '2026-03-01', toDate: '2026-03-31' });
   * ```
   */
  compute(params: ComputeParams): PnlReport {
    const fillsByMarket = new Map<string, NormalizedFill[]>();
    for (const f of params.fills) {
      const list = fillsByMarket.get(f.market);
      if (list === undefined) fillsByMarket.set(f.market, [f]);
      else list.push(f);
    }

    const markets = params.positions.map((position) =>
      this._buildMarketPnl(position, fillsByMarket.get(position.conditionId) ?? [])
    );

    const withoutFills = markets.filter((m) => m.fills.length === 0).length;
    if (withoutFills > 0) {
      // Не ошибка: вход мог случиться до начала запрошенного периода.
      this._logger.debug(`${withoutFills} markets have no fills inside the period`);
    }

    const dailyBreakdown = this._buildDailyBreakdown(markets);
    return this._buildReport(markets, dailyBreakdown, params);
  }

  /**
   * Строит PnL одного рынка.
   *
   * @param position - Позиция с реализованным PnL от площадки
   * @param fills - Наши сделки по этому рынку (могут отсутствовать)
   * @returns Запись рынка для отчёта
   */
  private _buildMarketPnl(position: PositionPnl, fills: NormalizedFill[]): MarketPnl {
    const records = fills
      .slice()
      .sort((a, b) => a.matchedAtMs - b.matchedAtMs)
      .map((f) => this._toFillRecord(f, position.outcome));

    const buyShares = records.reduce((s, r) => (r.side === 'BUY' ? s + r.size : s), 0);
    const sellShares = records.reduce((s, r) => (r.side === 'SELL' ? s + r.size : s), 0);
    const sellProceeds = records.reduce((s, r) => (r.side === 'SELL' ? s + r.notional : s), 0);

    const entryCost = position.avgPrice * position.totalBought;
    const netShares = buyShares - sellShares;
    const redeemValue = Math.max(0, netShares) * position.curPrice;
    const netPnl = position.realizedPnl;

    return {
      conditionId: position.conditionId,
      question: position.title,
      outcomeName: position.outcome,
      resolvedPrice: position.curPrice,
      won: position.curPrice >= WINNING_PRICE,
      profitable: netPnl > 0,
      fills: records,
      entryCost,
      sellProceeds,
      netShares,
      redeemValue,
      fees: null,
      feeSharesPaid: null,
      netPnl,
      roi: entryCost > 0 ? netPnl / entryCost : 0,
      entryDate: this._isoDate(records[0]?.matchTs ?? position.closedAtMs ?? 0),
    };
  }

  /**
   * Приводит fill к строке отчёта.
   *
   * @param fill - Сделка из ленты активности
   * @param fallbackOutcome - Имя исхода из позиции, если лента его не дала
   * @returns Строка fills в отчёте
   */
  private _toFillRecord(fill: NormalizedFill, fallbackOutcome: string): FillRecord {
    const notional = fill.usdcSize;
    return {
      id: fill.transactionHash,
      side: fill.side,
      // Публичная лента не различает мейкера и тейкера. Прежний
      // аутентифицированный путь различал; здесь честнее сказать TAKER
      // только там, где это известно, а не додумывать — поэтому роль
      // приводится к TAKER как к нейтральному значению по умолчанию.
      liquidityRole: 'TAKER',
      outcomeName: fill.outcome ?? fallbackOutcome,
      size: fill.size,
      price: fill.price,
      notional,
      fee: null,
      feeShares: null,
      effectiveSize: fill.size,
      cashFlow: fill.side === 'BUY' ? -notional : notional,
      matchTs: fill.matchedAtMs,
      matchDate: this._isoDate(fill.matchedAtMs),
      matchTime: new Date(fill.matchedAtMs).toISOString().slice(11, 19),
    };
  }

  /**
   * Группирует рынки по дню закрытия.
   *
   * @param markets - Все рынки отчёта
   * @returns Дневные срезы, отсортированные по дате
   */
  private _buildDailyBreakdown(markets: MarketPnl[]): DailyPnl[] {
    const byDate = new Map<string, MarketPnl[]>();
    for (const m of markets) {
      const list = byDate.get(m.entryDate);
      if (list === undefined) byDate.set(m.entryDate, [m]);
      else list.push(m);
    }

    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, dayMarkets]) => {
        const entryCost = dayMarkets.reduce((s, m) => s + m.entryCost, 0);
        const netPnl = dayMarkets.reduce((s, m) => s + m.netPnl, 0);
        return {
          date,
          markets: dayMarkets,
          wins: dayMarkets.filter((m) => m.profitable).length,
          losses: dayMarkets.filter((m) => !m.profitable).length,
          entryCost,
          totalReturn: entryCost + netPnl,
          fees: null,
          netPnl,
          roi: entryCost > 0 ? netPnl / entryCost : 0,
        };
      });
  }

  /**
   * Сводит дневные срезы в итоговый отчёт.
   *
   * @param markets - Все рынки
   * @param dailyBreakdown - Дневные срезы
   * @param params - Границы периода
   * @returns Готовый отчёт
   */
  private _buildReport(
    markets: MarketPnl[],
    dailyBreakdown: DailyPnl[],
    params: ComputeParams
  ): PnlReport {
    const entryCost = markets.reduce((s, m) => s + m.entryCost, 0);
    const netPnl = markets.reduce((s, m) => s + m.netPnl, 0);

    return {
      fromDate: params.fromDate,
      toDate: params.toDate,
      totalMarkets: markets.length,
      wins: markets.filter((m) => m.profitable).length,
      losses: markets.filter((m) => !m.profitable).length,
      entryCost,
      totalReturn: entryCost + netPnl,
      fees: null,
      netPnl,
      roi: entryCost > 0 ? netPnl / entryCost : 0,
      bestDay: dailyBreakdown.reduce<DailyPnl | null>(
        (best, d) => (best === null || d.netPnl > best.netPnl ? d : best),
        null
      ),
      worstDay: dailyBreakdown.reduce<DailyPnl | null>(
        (worst, d) => (worst === null || d.netPnl < worst.netPnl ? d : worst),
        null
      ),
      dailyBreakdown,
      markets,
    };
  }

  /**
   * Форматирует epoch-миллисекунды как ISO-дату.
   *
   * @param ms - Момент времени в миллисекундах
   * @returns Дата вида `YYYY-MM-DD`
   */
  private _isoDate(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
  }
}
