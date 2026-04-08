/**
 * Калькулятор PnL по resolved рынкам Polymarket.
 *
 * @remarks
 * Принимает сырые сделки и метаданные рынков, возвращает:
 * - MarketPnl[] — результат по каждому рынку
 * - DailyPnl[]  — агрегат по дням (группировка по дате первого fill)
 * - PnlReport   — итоговый отчёт с суммарной статистикой
 *
 * ### Формула PnL на рынок:
 * ```
 * entry_cost    = Σ (BUY.size × BUY.price)
 * sell_proceeds = Σ (SELL.size × SELL.price)    // досрочный выход
 * net_shares    = Σ BUY.size − Σ SELL.size
 * redeem_value  = net_shares × resolvedPrice     // 0.0 или 1.0
 * fees          = Σ (notional × fee_rate_bps / 10000)
 * net_pnl       = sell_proceeds + redeem_value − entry_cost − fees
 * ```
 *
 * @example
 * ```typescript
 * const calc = new PnlCalculator(logger);
 * const report = calc.compute(trades, marketMetas, { fromDate: '2026-03-01', toDate: '2026-03-31' });
 * console.log(`Net PnL: $${report.netPnl.toFixed(2)}`);
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { RawTrade, MarketMeta, FillRecord, MarketPnl, DailyPnl, PnlReport } from '../types.js';

/**
 * Параметры для compute().
 */
export interface ComputeParams {
  fromDate: string;
  toDate: string;
}

/**
 * Калькулятор PnL.
 */
export class PnlCalculator {
  constructor(private readonly logger: ILogger) {}

  /**
   * Рассчитывает PnL по всем resolved рынкам за период.
   *
   * @param trades - Все сделки пользователя за период
   * @param marketMetas - Метаданные рынков (conditionId → MarketMeta | null)
   * @param params - Даты периода для отчёта
   * @returns Полный отчёт PnL
   *
   * @remarks
   * Рынки без метаданных или с resolved=false пропускаются.
   * Для рынков с несколькими asset_id (мы торговали разные токены одного рынка)
   * создаются отдельные MarketPnl-записи для каждого токена.
   */
  compute(
    trades: RawTrade[],
    marketMetas: Map<string, MarketMeta | null>,
    params: ComputeParams
  ): PnlReport {
    // Группируем сделки по conditionId + asset_id
    // (один рынок может иметь несколько токенов; мы могли торговать разные)
    const byMarketToken = new Map<string, RawTrade[]>();

    for (const trade of trades) {
      const key = `${trade.market}::${trade.asset_id}`;
      const list = byMarketToken.get(key) ?? [];
      list.push(trade);
      byMarketToken.set(key, list);
    }

    const marketResults: MarketPnl[] = [];

    for (const [key, marketTrades] of byMarketToken) {
      const [conditionId, assetId] = key.split('::') as [string, string];
      const meta = marketMetas.get(conditionId);

      if (!meta || !meta.resolved) {
        this.logger.debug(`Skipping market ${conditionId}: not resolved`);
        continue;
      }

      const tokenIndex = meta.clobTokenIds.indexOf(assetId);
      if (tokenIndex === -1) {
        this.logger.warn(`asset_id ${assetId} not found in clobTokenIds for ${conditionId}`);
        continue;
      }

      const resolvedPrice = meta.outcomePrices[tokenIndex] ?? 0;
      const outcomeName   = meta.outcomes[tokenIndex] ?? 'UNKNOWN';

      const fills = this.buildFills(marketTrades);
      const result = this.computeMarketPnl({
        conditionId,
        question: meta.question,
        outcomeName,
        resolvedPrice,
        fills,
      });

      marketResults.push(result);
    }

    // Сортируем по дате входа
    marketResults.sort((a, b) => a.entryDate.localeCompare(b.entryDate));

    this.logger.info(`Computed PnL for ${marketResults.length} resolved markets`);

    const dailyBreakdown = this.buildDailyBreakdown(marketResults);
    return this.buildReport(marketResults, dailyBreakdown, params);
  }

  /**
   * Строит массив FillRecord из сырых сделок, отсортированных по времени.
   *
   * @param trades - Сырые сделки одного рынка/токена
   * @returns Отсортированные FillRecord
   */
  private buildFills(trades: RawTrade[]): FillRecord[] {
    return trades
      .slice()
      .sort((a, b) => Number(a.match_time ?? 0) - Number(b.match_time ?? 0))
      .map(t => {
        const size  = parseFloat(t.size);
        const price = parseFloat(t.price);
        const notional = size * price;

        // Комиссия = notional × fee_rate_bps / 10_000
        const feeRateBps = parseFloat(t.fee_rate_bps ?? '0');
        const fee = notional * feeRateBps / 10_000;

        const matchTs = Number(t.match_time ?? 0) * 1000;
        const d       = new Date(matchTs);
        const matchDate = d.toISOString().slice(0, 10);
        const matchTime = d.toISOString().slice(11, 19);

        return {
          id: t.id,
          side: t.side,
          size,
          price,
          notional,
          fee,
          matchTs,
          matchDate,
          matchTime,
        };
      });
  }

  /**
   * Вычисляет MarketPnl для одного рынка/токена.
   *
   * @param args - Параметры рынка и заполненные fills
   * @returns MarketPnl
   */
  private computeMarketPnl(args: {
    conditionId: string;
    question: string;
    outcomeName: string;
    resolvedPrice: number;
    fills: FillRecord[];
  }): MarketPnl {
    const { conditionId, question, outcomeName, resolvedPrice, fills } = args;

    const buyFills  = fills.filter(f => f.side === 'BUY');
    const sellFills = fills.filter(f => f.side === 'SELL');

    const entryCost    = buyFills.reduce((s, f) => s + f.notional, 0);
    const sellProceeds = sellFills.reduce((s, f) => s + f.notional, 0);
    const fees         = fills.reduce((s, f) => s + f.fee, 0);

    const buyShares  = buyFills.reduce((s, f) => s + f.size, 0);
    const sellShares = sellFills.reduce((s, f) => s + f.size, 0);
    const netShares  = buyShares - sellShares;

    const redeemValue = Math.max(0, netShares) * resolvedPrice;
    const netPnl      = sellProceeds + redeemValue - entryCost - fees;
    const roi         = entryCost > 0 ? (netPnl / entryCost) * 100 : 0;
    const entryDate   = fills[0]?.matchDate ?? '';

    return {
      conditionId,
      question,
      outcomeName,
      resolvedPrice,
      won: resolvedPrice >= 0.99,
      fills,
      entryCost,
      sellProceeds,
      netShares,
      redeemValue,
      fees,
      netPnl,
      roi,
      entryDate,
    };
  }

  /**
   * Группирует рынки по дате входа и строит DailyPnl[].
   *
   * @param markets - Отсортированные MarketPnl[]
   * @returns Массив DailyPnl, отсортированный по дате
   */
  private buildDailyBreakdown(markets: MarketPnl[]): DailyPnl[] {
    const byDate = new Map<string, MarketPnl[]>();

    for (const m of markets) {
      const list = byDate.get(m.entryDate) ?? [];
      list.push(m);
      byDate.set(m.entryDate, list);
    }

    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, dayMarkets]) => {
        const wins      = dayMarkets.filter(m => m.won).length;
        const losses    = dayMarkets.filter(m => !m.won).length;
        const entryCost = dayMarkets.reduce((s, m) => s + m.entryCost, 0);
        const totalReturn = dayMarkets.reduce((s, m) => s + m.redeemValue + m.sellProceeds, 0);
        const fees      = dayMarkets.reduce((s, m) => s + m.fees, 0);
        const netPnl    = dayMarkets.reduce((s, m) => s + m.netPnl, 0);
        const roi       = entryCost > 0 ? (netPnl / entryCost) * 100 : 0;

        return { date, markets: dayMarkets, wins, losses, entryCost, totalReturn, fees, netPnl, roi };
      });
  }

  /**
   * Строит итоговый PnlReport из рынков и дневной разбивки.
   *
   * @param markets - Все MarketPnl[]
   * @param dailyBreakdown - DailyPnl[]
   * @param params - Даты периода
   * @returns PnlReport
   */
  private buildReport(markets: MarketPnl[], dailyBreakdown: DailyPnl[], params: ComputeParams): PnlReport {
    const wins       = markets.filter(m => m.won).length;
    const losses     = markets.filter(m => !m.won).length;
    const entryCost  = markets.reduce((s, m) => s + m.entryCost, 0);
    const totalReturn = markets.reduce((s, m) => s + m.redeemValue + m.sellProceeds, 0);
    const fees       = markets.reduce((s, m) => s + m.fees, 0);
    const netPnl     = markets.reduce((s, m) => s + m.netPnl, 0);
    const roi        = entryCost > 0 ? (netPnl / entryCost) * 100 : 0;

    const bestDay  = dailyBreakdown.reduce<DailyPnl | null>(
      (best, d) => (best === null || d.netPnl > best.netPnl) ? d : best,
      null
    );
    const worstDay = dailyBreakdown.reduce<DailyPnl | null>(
      (worst, d) => (worst === null || d.netPnl < worst.netPnl) ? d : worst,
      null
    );

    return {
      fromDate: params.fromDate,
      toDate: params.toDate,
      totalMarkets: markets.length,
      wins,
      losses,
      entryCost,
      totalReturn,
      fees,
      netPnl,
      roi,
      bestDay,
      worstDay,
      dailyBreakdown,
      markets,
    };
  }
}
