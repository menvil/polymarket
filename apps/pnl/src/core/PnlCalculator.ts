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
 * fee_usdc_eq   = Σ round5(size × feeRate × price × (1 - price))
 * buy_fee_shares = fee_usdc_eq / price          // BUY taker only
 * sell_proceeds = Σ (SELL.notional - SELL.fee)  // SELL taker fee stays in USDC
 * net_shares    = Σ BUY.effectiveSize − Σ SELL.size
 * net_pnl       = sell_proceeds + redeem_value − entry_cost
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
import { calculatePolymarketTakerFeeNumber } from '@polymarket/fill/polymarket-fee';
import type { NormalizedFill, MarketMeta, FillRecord, MarketPnl, DailyPnl, PnlReport } from '../types.js';

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
   * @param fills - Нормализованные fills пользователя за период
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
    fills: NormalizedFill[],
    marketMetas: Map<string, MarketMeta | null>,
    params: ComputeParams
  ): PnlReport {
    // Группируем fills по conditionId + asset_id
    // (один рынок может иметь несколько токенов; мы могли торговать разные)
    const byMarketToken = new Map<string, NormalizedFill[]>();

    for (const fill of fills) {
      const key = `${fill.market}::${fill.asset_id}`;
      const list = byMarketToken.get(key) ?? [];
      list.push(fill);
      byMarketToken.set(key, list);
    }

    const marketResults: MarketPnl[] = [];

    for (const [key, marketFills] of byMarketToken) {
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

      const fills = this.buildFills(marketFills, outcomeName, meta.takerFeeRate);
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
   * Строит массив FillRecord из нормализованных fills, отсортированных по времени.
   *
   * @param fills - Нормализованные fills одного рынка/токена
   * @param outcomeName - Название outcome (UP/DOWN/YES/NO) для этого токена
   * @returns Отсортированные FillRecord
   */
  private buildFills(
    fills: NormalizedFill[],
    outcomeName: string,
    takerFeeRate: number
  ): FillRecord[] {
    return fills
      .slice()
      .sort((a, b) => Number(a.match_time ?? 0) - Number(b.match_time ?? 0))
      .map(f => {
        const size  = parseFloat(f.size);
        const price = parseFloat(f.price);
        const notional = size * price;
        const fee = this.calculateFillFee({
          size,
          price,
          liquidityRole: f.liquidityRole,
          takerFeeRate,
        });
        const feeShares = this.calculateFeeShares({
          side: f.side,
          price,
          fee,
        });
        const effectiveSize = f.side === 'BUY' ? size - feeShares : size;
        const cashFlow = f.side === 'SELL' ? notional - fee : notional;

        const matchTs = Number(f.match_time ?? 0) * 1000;
        const d       = new Date(matchTs);
        const matchDate = d.toISOString().slice(0, 10);
        const matchTime = d.toISOString().slice(11, 19);

        return {
          id: f.id,
          side: f.side,
          liquidityRole: f.liquidityRole,
          outcomeName,
          size,
          price,
          notional,
          fee,
          feeShares,
          effectiveSize,
          cashFlow,
          matchTs,
          matchDate,
          matchTime,
        };
      });
  }

  /**
   * Polymarket fee model lives in @polymarket/fill.
   */
  private calculateFillFee(args: {
    size: number;
    price: number;
    liquidityRole: 'MAKER' | 'TAKER';
    takerFeeRate: number;
  }): number {
    if (args.liquidityRole !== 'TAKER') {
      return 0;
    }

    if (args.takerFeeRate <= 0 || args.size <= 0 || args.price <= 0 || args.price >= 1) {
      return 0;
    }

    return calculatePolymarketTakerFeeNumber(args.size, args.price, args.takerFeeRate);
  }

  /**
   * BUY taker fees are collected in shares, so we convert the USDC-equivalent
   * fee into shares at the execution price. SELL fees stay in USDC.
   */
  private calculateFeeShares(args: {
    side: 'BUY' | 'SELL';
    price: number;
    fee: number;
  }): number {
    if (args.side !== 'BUY' || args.fee <= 0 || args.price <= 0) {
      return 0;
    }

    return args.fee / args.price;
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
    const sellProceeds = sellFills.reduce((s, f) => s + f.cashFlow, 0);
    const fees         = fills.reduce((s, f) => s + f.fee, 0);
    const feeSharesPaid = buyFills.reduce((s, f) => s + f.feeShares, 0);

    const buyShares  = buyFills.reduce((s, f) => s + f.effectiveSize, 0);
    const sellShares = sellFills.reduce((s, f) => s + f.size, 0);
    const netShares  = buyShares - sellShares;

    const redeemValue = Math.max(0, netShares) * resolvedPrice;
    const netPnl      = sellProceeds + redeemValue - entryCost;
    const roi         = entryCost > 0 ? (netPnl / entryCost) * 100 : 0;
    const entryDate   = fills[0]?.matchDate ?? '';

    return {
      conditionId,
      question,
      outcomeName,
      resolvedPrice,
      won: resolvedPrice >= 0.99,
      profitable: netPnl >= 0,
      fills,
      entryCost,
      sellProceeds,
      netShares,
      redeemValue,
      fees,
      feeSharesPaid,
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
        const wins      = dayMarkets.filter(m => m.profitable).length;
        const losses    = dayMarkets.filter(m => !m.profitable).length;
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
    const wins       = markets.filter(m => m.profitable).length;
    const losses     = markets.filter(m => !m.profitable).length;
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
